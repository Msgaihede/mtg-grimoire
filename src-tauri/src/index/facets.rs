//! Facet counts over [`super::CardIndex`].
//!
//! **Every dimension is counted over a base carrying every filter EXCEPT its own.** That is
//! Solr's `excludeTags` rule and it is what keeps a multi-select usable: counted over the
//! full base, picking one set would report zero for every other set and grey the whole list
//! at the moment it was first used.
//!
//! Colours are the exception that proves the rule, and the reason spec §2 words it as "would
//! not change the result set" rather than "would return nothing": `colors` is **subset**
//! semantics, so with `U` on, pressing `W` asks for "castable in WU" — a superset. Their
//! number is therefore the size of the result *after* toggling, read against
//! [`FacetResponse::total`].
//!
//! **Everything here has to answer what [`crate::filters::push_card_filters`] answers**, and
//! where the two can disagree it is written down at the disagreement. A count that is too
//! high leaves an option live that does nothing — one press wasted. A count that is too low
//! greys out an option that would have worked, which hides cards that exist and which nobody
//! reports as a bug.

use super::bitset::BitSet;
use super::CardIndex;
use crate::search::SearchRequest;
use crate::sync::{lock_db_read, AppState};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedFacets {
    pub owned: i64,
    pub missing: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetResponse {
    /// Keyed `W`/`U`/`B`/`R`/`G`/`C`. **The size of the result set after toggling that
    /// chip**, not a count of cards carrying that colour.
    pub colors: BTreeMap<String, i64>,
    /// Keyed `"0"`–`"8"`, where `8` is eight-or-more. Plain counts.
    pub mana_values: BTreeMap<String, i64>,
    /// Printings whose printed cost carries an `{X}`. A plain count and a **sibling** of
    /// [`Self::mana_values`] rather than an `"x"` key inside it, because the two are different
    /// shapes: that map is a partition, so its values sum to the result set, and a key that
    /// double-counted every card already in `"3"` would make the sum a lie the moment anything
    /// read it as one.
    ///
    /// Counted over the same `Skip::Mana` base the buckets are, so the X chip greys out on the
    /// same rule and at the same moment they do — and, being in that base's own dimension, its
    /// count ignores whether X is currently pressed.
    pub mana_x: i64,
    /// Keyed by `legalities` key. Plain counts.
    pub formats: BTreeMap<String, i64>,
    /// Keyed by [`CardIndex::RARITY_KEYS`] entry. Plain counts, and **all four are sent on
    /// every ready response**, zeros included — the chip row greys a counted zero and leaves an
    /// absent key live, so a key that went missing would silently stop greying.
    ///
    /// **These do not sum to [`Self::total`]**, and nothing may read them as though they did.
    /// The corpus also holds `special` and `bonus` printings, which no chip offers and no
    /// bitset counts, so the four are a vocabulary rather than a partition — the same reading
    /// [`Self::mana_values`] needs for a fractional cost.
    pub rarities: BTreeMap<String, i64>,
    /// Keyed by set code. Plain counts, and **every code in the corpus is sent, zeros
    /// included** — 1 047 keys on the live corpus, on every **ready** response, whatever the
    /// filters are. A cold one sends this map empty, which is the point of [`Self::ready`].
    ///
    /// **An absent key reads as "unknown", never as a zero**, and that is not a broken
    /// contract on the frontend's side: the set picker's options come from a session-cached
    /// `list_sets()` while its counts come from this index, so a set the corpus has since
    /// lost is a code the picker still knows and this map has never heard of. It has to stay
    /// live — greying is only ever safe on a counted zero.
    pub sets: BTreeMap<String, i64>,
    pub owned: OwnedFacets,
    /// The current result size, which is what a colour count is compared against.
    ///
    /// **Printings, always** — `collapse` is a view mode and not a filter, so this counts
    /// what the search matched rather than the rows it will draw. It is therefore *not*
    /// [`crate::search::SearchResponse::total`] under another roof: that one counts cards
    /// when the search is collapsed, and stops counting at 5 000. Both reach the frontend
    /// under the name `total`, and only this one is what a colour count is read against.
    pub total: i64,
    /// False when the index was cold and nothing was counted. The UI leaves every control
    /// live on `false` — not-greyed means "we do not know", never "this is empty".
    pub ready: bool,
}

/// Which filters a base leaves out.
#[derive(Clone, Copy, PartialEq)]
enum Skip {
    Nothing,
    Colors,
    Mana,
    Sets,
    Formats,
    Rarities,
    Owned,
}

/// The three dimensions whose bitset costs a walk to build, built once for the whole request.
///
/// [`base`] is called seven times and none of these depends on which dimension is being
/// skipped, so building them per call would walk the corpus six more times than the answer
/// needs — and the set walk carries a `set_codes` lookup per picked code on top.
struct Prepared {
    sets: Option<BitSet>,
    mana: Option<BitSet>,
    rarities: Option<BitSet>,
}

/// The result set under every filter except `skip`'s.
///
/// **Three filters the request can carry are missing here, and two of them are deliberate and
/// err in the direction that costs a press rather than hiding a card.** The tag terms used to
/// be a fourth; they are in `narrow` now, resolved through their closures by [`run_facets`]
/// the way the text is resolved through FTS.
///
/// * `rarity` — the **single**-valued field, which is the printings modal's `<select>` and
///   not the filter row's chips — still has no dimension to narrow by, so a request carrying
///   it is faceted as though it were unfiltered and every count reads high. Its multi-valued
///   neighbour `rarities` *is* a dimension now ([`CardIndex::rarity`], [`Skip::Rarities`]);
///   this one would need to fold into that base to join it, and nothing sends it with facets.
/// * `priceMin`/`priceMax` have no dimension either, and cannot cheaply have one: a price is
///   a function of the reader's marketplace — two of the four read a table the corpus scan
///   does not touch and that refreshes on its own schedule — so closing this means a price
///   array per marketplace and a lifecycle hook on the feed refresh, where every other
///   dimension is a column of `cards`. A price-bounded request is therefore faceted over the
///   unbounded corpus and every count reads high, which is the same fail-open direction the
///   two entries around it take.
/// * `oracleId` is the same shape as `rarity`: `CardIndex` has no oracle-id dimension, so a
///   search narrowed to one oracle card is faceted as though it were unfiltered too — every
///   count over-reads by the printings of every *other* card. **Fails open on purpose, not by
///   oversight**: `facets.ts` states the rule verbatim — an absent or over-read count only
///   ever leaves a control *live* that a real count would have greyed, never the reverse — so
///   the failure mode is a facet a reader can press to zero results, not one that hides a card
///   they could otherwise find. Nothing in the app sends `oracleId` with a facet request today
///   either (the context menu that grows this filter calls `search_cards` directly), so this is
///   the same trade as `rarity`, made for the same reason, and would take the same sixth-
///   dimension change to close.
/// * `collapse` is not a filter at all. The search folds printings into cards for display
///   and these counts are printings either way — spec §2 says so, and the tooltip says
///   "printings" for exactly this reason.
fn base(
    ix: &CardIndex,
    req: &SearchRequest,
    narrow: Option<&BitSet>,
    prep: &Prepared,
    skip: Skip,
) -> BitSet {
    // `paperOnly` defaults ON and is not a facet, so it is in every base.
    //
    // **`ix.all`, not a filled bitset.** Setting every bit up to `capacity` would include
    // rowid 0, which SQLite never issues, and every doc in the word-rounded padding above
    // the last real row — so `total` would read high by up to 64 on the one request that
    // asks for digital printings too. `all` is set per row during the build, so it holds
    // exactly the docs that exist.
    let mut b = if req.paper_only.unwrap_or(true) {
        ix.paper.clone()
    } else {
        ix.all.clone()
    };
    // `playableOnly` is not a facet either, so it is in every base too — including the format
    // dimension's, where it is free: every `formats[k]` is a subset of `playable`, so a format
    // count cannot move when a filter that only ever removes non-playable printings is applied.
    // **Its default is the opposite of `paperOnly`'s** (`false`, not `true`), because the
    // search view is the only caller that sends it — see
    // [`crate::filters::CardFilters::playable_only`].
    if req.playable_only.unwrap_or(false) {
        b = b.and(&ix.playable);
    }
    if let Some(n) = narrow {
        b = b.and(n);
    }
    if skip != Skip::Formats {
        if let Some(f) = crate::filters::nonblank(&req.format) {
            if let Some(k) = crate::legalities::LEGALITY_KEYS
                .iter()
                .position(|k| *k == f)
            {
                b = b.and(&ix.formats[k]);
            } else {
                // A format this build does not know narrows to nothing, which is what the
                // SQL path's false `0` predicate does too. **Only this base**: the format
                // dimension's own base skips this arm, so the select still offers real
                // counts and the reader can leave a dead end by picking a format that works.
                return BitSet::new(ix.capacity);
            }
        }
    }
    if skip != Skip::Colors {
        b = apply_colors(ix, &b, crate::filters::nonblank(&req.colors));
    }
    if skip != Skip::Mana {
        if let Some(u) = prep.mana.as_ref() {
            b = b.and(u);
        }
    }
    if skip != Skip::Sets {
        if let Some(u) = prep.sets.as_ref() {
            b = b.and(u);
        }
    }
    if skip != Skip::Rarities {
        if let Some(u) = prep.rarities.as_ref() {
            b = b.and(u);
        }
    }
    if skip != Skip::Owned {
        match req.owned {
            Some(true) => b = b.and(&ix.owned),
            Some(false) => b = and_not(&b, &ix.owned),
            None => {}
        }
    }
    b
}

/// Subset semantics, expressed the way `push_card_filters` expresses it: a card is in when
/// its identity carries no letter outside the picked set. `"C"` means colourless only.
///
/// **The complement of the unpicked letters, never the union of the picked ones.** The two
/// agree on mono-coloured cards and disagree on every multicolour one — a `W` union would
/// return Lightning Helix for a mono-white search, which the search itself does not.
fn apply_colors(ix: &CardIndex, base: &BitSet, picked: Option<&str>) -> BitSet {
    let Some(picked) = picked else {
        return base.clone();
    };
    let picked = picked.to_ascii_uppercase();
    if picked == "C" {
        return base.and(&ix.colors[5]);
    }
    let mut out = base.clone();
    for (i, letter) in CardIndex::COLOR_KEYS.iter().enumerate().take(5) {
        if !picked.contains(*letter) {
            out = and_not(&out, &ix.colors[i]);
        }
    }
    out
}

fn and_not(a: &BitSet, b: &BitSet) -> BitSet {
    let mut out = BitSet::new(a.capacity());
    a.for_each(|d| {
        if !b.contains(d) {
            out.set(d);
        }
    });
    out
}

/// The whole mana dimension as one bitset, or `None` when the request presses nothing in it.
///
/// Chips are ORed with each other, and a value past the last chip is that chip: the SQL
/// spells `>= 8` open-ended, so the index's bucket 8 already holds everything above it.
/// Bucket [`CardIndex::MANA_UNKNOWN`] is unreachable from here on purpose — no chip asks for
/// "no mana value at all", and `NULL IN (…)` is NULL.
///
/// **`manaX` is one more alternative in that same union, because it is one more alternative in
/// the same `OR` group of the SQL.** It is a dimension of the mana filter and not a dimension
/// of its own, so it shares [`Skip::Mana`]: pressing X must not grey out the value chips, and
/// pressing a value chip must not grey out X. ANDing it in instead would count "mana value 2
/// *and* variable" — an intersection the search does not return.
fn union_mana(ix: &CardIndex, values: Option<&[u8]>, mana_x: bool) -> Option<BitSet> {
    let values = values.unwrap_or(&[]);
    if values.is_empty() && !mana_x {
        return None;
    }
    let mut u = BitSet::new(ix.capacity);
    for v in values {
        let bucket = usize::from(*v).min(usize::from(crate::filters::MANA_VALUE_OPEN_ENDED));
        ix.mana[bucket].for_each(|d| u.set(d));
    }
    if mana_x {
        ix.mana_x.for_each(|d| u.set(d));
    }
    Some(u)
}

/// The rarity chips as one bitset, or `None` when the request names none.
///
/// OR within, which is what the chip row means and what `push_card_filters` emits — so this is
/// a union and not an intersection, unlike [`union_sets`]' two lists.
///
/// **Narrowed by exactly [`crate::filters::picked_rarities`]' list**, which is why that
/// normalisation is a shared function: a facet counted over a rarity the search dropped would
/// report options as live that the search cannot reach.
///
/// A word this build does not know contributes nothing, so a request naming only unknown
/// rarities narrows to the empty set — matching the SQL, where `rarity IN ('shiny')` returns
/// no rows. Naming *no* rarity is the different answer, and it is the `None` above.
fn union_rarities(ix: &CardIndex, rarities: Option<&[String]>) -> Option<BitSet> {
    let picked = crate::filters::picked_rarities(rarities?);
    if picked.is_empty() {
        return None;
    }
    let mut u = BitSet::new(ix.capacity);
    for r in picked {
        if let Some(i) = CardIndex::RARITY_KEYS.iter().position(|k| *k == r) {
            ix.rarity[i].for_each(|d| u.set(d));
        }
    }
    Some(u)
}

/// The set dimension as one bitset, or `None` when the request names no set.
///
/// **`setCode` and `sets` are one dimension here, and they intersect rather than union.**
/// The SQL pushes them as two separate `WHERE` terms, so a request carrying both means "in
/// this set AND in one of these" — and a facet that ORed them would count printings the
/// search will not return. They share a `Skip` because they are the same question: the set
/// picker's counts must ignore both, or opening the picker on a request that already names a
/// set would offer nothing but that set.
///
/// **A named code the index has never heard of matches nothing, and that is not the same as
/// naming no code at all.** `set_code = 'zzz'` returns no rows in SQL; dropping the unknown
/// code instead would leave the base unfiltered and report the whole corpus. Reachable: the
/// index is one sync behind a `cards` swap for as long as the rebuild takes.
///
/// **`setCode` is matched as sent and `sets` is lower-cased, because that asymmetry is in the
/// SQL.** [`crate::filters::picked_sets`] normalises the list; the single code is bound
/// verbatim against a `TEXT` column with no `NOCASE` collation, so `"LEA"` matches no row.
/// Mirroring it means an upper-case code greys every option here — which is the honest answer
/// to a search that really does return nothing, and the reason spec §2 keeps `Reset all` as
/// the way out.
fn union_sets(ix: &CardIndex, req: &SearchRequest) -> Option<BitSet> {
    let single = crate::filters::nonblank(&req.set_code).map(|s| vec![s.to_owned()]);
    let many = req
        .sets
        .as_deref()
        .map(crate::filters::picked_sets)
        .filter(|p| !p.is_empty());
    if single.is_none() && many.is_none() {
        return None;
    }

    // One pass per named list over the ordinals, ANDed together — 1 047 bools, against a
    // `set_codes` scan per doc.
    let mut allowed = vec![true; ix.set_codes.len()];
    for codes in [single, many].into_iter().flatten() {
        let mut this = vec![false; ix.set_codes.len()];
        for code in codes {
            if let Some(i) = ix.set_codes.iter().position(|c| *c == code) {
                this[i] = true;
            }
        }
        for (a, t) in allowed.iter_mut().zip(this) {
            *a &= t;
        }
    }

    // `ix.all` and not `0..capacity`: `set_ord` reads 0 for a doc that is not a card, which
    // is a real set's ordinal, so walking the padding would put phantom docs in the union.
    // They are ANDed away by every caller today; a union that never held them cannot be
    // undone by a future caller that forgets.
    let mut u = BitSet::new(ix.capacity);
    ix.all.for_each(|d| {
        if allowed[usize::from(ix.set_ord[d as usize])] {
            u.set(d);
        }
    });
    Some(u)
}

/// Every dimension's counts for one search.
///
/// `narrow` is the filters that have no dimension in [`CardIndex`], resolved against the
/// database and handed in as one bitset — the FTS text and the tag closures, intersected by
/// [`run_facets`]. None of them is a facet, and all of them are in **every** base including
/// their own, because a facet describes the search the reader is looking at.
///
/// **`None` means no clause, never an empty set.** All-punctuation text and a cleared chip row
/// both arrive here as `None`, and a caller that turned either into an empty bitset would grey
/// every option over a page that is full.
///
/// **0.5–2.6 ms, measured 2026-08-11** — best of five per case, release build, over the
/// synthetic 116 694-doc corpus in `facet_timing` (107 337 paper, 1 047 sets): unfiltered
/// browse 1.8 ms, one colour 2.6 ms, colours + mana + owned 1.8 ms, 64 sets 0.5 ms. A
/// filter that narrows makes this *cheaper*, because five of the six bases are smaller.
/// Synthetic and not the live database, which is fair here — nothing in this file reads a
/// row — but it is a machine-shaped number, not a corpus-shaped one.
///
/// That is what says [`and_not`] can walk bit by bit rather than word by word: the colour
/// case runs it up to 24 times over ~107 k docs and still lands two orders of magnitude
/// inside spec §2's 100 ms budget, so [`BitSet`] needs no new operation for this.
pub fn compute(ix: &CardIndex, req: &SearchRequest, narrow: Option<&BitSet>) -> FacetResponse {
    // **An index over an empty corpus is not meaningfully ready**, and it answers exactly as
    // a cold one does — `ready: false`, every map empty, so the UI leaves every control live.
    //
    // This is the *opening sync*, not a filter result. `lib.rs` spawns a build at setup, and
    // on a first launch that build succeeds over zero rows a good ninety seconds before the
    // corpus arrives. Counted honestly, every option is at zero and the greying rule dims the
    // lot — and with no filter on, no `Reset all` is drawn either, so the first screen a new
    // user sees is a filter row that is entirely dead with no visible way out. The rule is not
    // wrong there (with no results, toggling anything changes nothing); the premise is. Zero
    // printings in the corpus means the answer is not known yet, which is what `ready: false`
    // is for.
    if ix.all.count() == 0 {
        return FacetResponse {
            ready: false,
            ..Default::default()
        };
    }

    let prep = Prepared {
        sets: union_sets(ix, req),
        mana: union_mana(ix, req.mana_values.as_deref(), req.mana_x.unwrap_or(false)),
        rarities: union_rarities(ix, req.rarities.as_deref()),
    };
    let base = |skip| base(ix, req, narrow, &prep, skip);

    let full = base(Skip::Nothing);
    let mut out = FacetResponse {
        total: i64::from(full.count()),
        ready: true,
        ..Default::default()
    };

    // Sets: one walk of the base, bumping a counter per ordinal. **Every code the index
    // holds is emitted, whether the base can reach it or not** — the loop below is over
    // `set_codes` and not over the codes that counted, so a set the search has narrowed away
    // arrives as an explicit zero rather than as an absent key. That is what lets the picker
    // grey a row instead of dropping it, and it is why the response is a fixed size.
    let sets_base = base(Skip::Sets);
    let mut counts = vec![0i64; ix.set_codes.len()];
    sets_base.for_each(|d| counts[usize::from(ix.set_ord[d as usize])] += 1);
    for (i, code) in ix.set_codes.iter().enumerate() {
        out.sets.insert(code.clone(), counts[i]);
    }

    let mana_base = base(Skip::Mana);
    for bucket in 0..=usize::from(crate::filters::MANA_VALUE_OPEN_ENDED) {
        out.mana_values.insert(
            bucket.to_string(),
            i64::from(mana_base.and_count(&ix.mana[bucket])),
        );
    }
    // The same base, so the X chip greys on the same rule as the nine beside it. It is *not*
    // a tenth entry in the map above: those partition the result set and this one overlaps
    // them, so a reader summing the map would count every variable-cost card twice.
    out.mana_x = i64::from(mana_base.and_count(&ix.mana_x));

    let formats_base = base(Skip::Formats);
    for (k, key) in crate::legalities::LEGALITY_KEYS.iter().enumerate() {
        out.formats.insert(
            (*key).to_owned(),
            i64::from(formats_base.and_count(&ix.formats[k])),
        );
    }

    // Rarity: one `and_count` per chip over the base that drops the whole rarity question, so
    // picking `rare` does not grey `mythic` — the rule every dimension here follows, that a
    // control never re-sorts or greys under the press that is using it.
    let rarities_base = base(Skip::Rarities);
    for (i, key) in CardIndex::RARITY_KEYS.iter().enumerate() {
        out.rarities.insert(
            (*key).to_owned(),
            i64::from(rarities_base.and_count(&ix.rarity[i])),
        );
    }

    // Colours: the result AFTER toggling each chip, because they broaden.
    let colors_base = base(Skip::Colors);
    let picked = crate::filters::nonblank(&req.colors)
        .unwrap_or("")
        .to_ascii_uppercase();
    for letter in CardIndex::COLOR_KEYS {
        let after = toggle_colors(&picked, letter);
        let with = apply_colors(
            ix,
            &colors_base,
            (!after.is_empty()).then_some(after.as_str()),
        );
        out.colors
            .insert(letter.to_string(), i64::from(with.count()));
    }

    let owned_base = base(Skip::Owned);
    out.owned = OwnedFacets {
        owned: i64::from(owned_base.and_count(&ix.owned)),
        missing: i64::from(and_not(&owned_base, &ix.owned).count()),
    };

    out
}

/// The picked-colour string after one chip is pressed, mirroring `toggleColor` in
/// `useCardSearch.ts`: `C` is exclusive both ways, because the backend reads exactly `"C"`
/// as colourless-only and anything else as subset-of-these-letters.
fn toggle_colors(picked: &str, letter: char) -> String {
    if picked.contains(letter) {
        return picked.chars().filter(|c| *c != letter).collect();
    }
    if letter == 'C' {
        return "C".to_owned();
    }
    let mut out: String = picked.chars().filter(|c| *c != 'C').collect();
    out.push(letter);
    // WUBRG order, so the string a facet was computed for is the string the UI will send.
    CardIndex::COLOR_KEYS
        .iter()
        .take(5)
        .filter(|c| out.contains(**c))
        .collect()
}

/// One of the two pre-flattened tag closures, named by the columns a lookup needs.
///
/// A pair of `&'static str` and not a free-text argument, because **these two names are the
/// only things interpolated into the SQL below** — every value is bound. Two consts and no
/// other constructor is what makes that a property of the type rather than a habit.
#[derive(Clone, Copy)]
struct TagClosure {
    table: &'static str,
    /// The column both `cards` and the closure key the subject by.
    subject: &'static str,
}

/// What the picture shows. Keyed by `illustration_id`, which is **NULLABLE on `cards`** — so a
/// printing without one joins no row here, answers no art tag, and survives every art exclude.
const ART_CLOSURE: TagClosure = TagClosure {
    table: "art_tag_illustrations",
    subject: "illustration_id",
};

/// What the card does. Keyed by `oracle_id`, and **with no `weight` column at all** — a floor
/// copied onto this one is a `no such column` error rather than a wrong answer.
const ORACLE_CLOSURE: TagClosure = TagClosure {
    table: "oracle_tag_cards",
    subject: "oracle_id",
};

/// One closure lookup a request asks for.
struct TagProbe {
    closure: TagClosure,
    slug: String,
    /// Whether the closure's `weight <> 'weak'` rides this lookup. The art **include** arm
    /// only — see [`tag_probes`].
    floor: bool,
    /// Whether the term subtracts from the narrowing rather than intersecting into it.
    exclude: bool,
}

/// Every closure lookup one request asks for, in the order they will be run.
///
/// **The slugs come from [`crate::filters::picked_tags`] and are not re-derived here.** That
/// function is the search's own normaliser — trim, drop blanks, sort, dedupe — and it was
/// extracted from `push_card_filters` for exactly this call site: a facet counted over a slug
/// list the search trimmed differently reports options as live that the search cannot reach.
///
/// Empty means no tag filter, never "match nothing", which is that function's rule and every
/// other filter's.
fn tag_probes(req: &SearchRequest) -> Vec<TagProbe> {
    // `<> 'weak'`, on the **art include arm alone**, mirroring `push_card_filters` clause for
    // clause. Two halves of that are load-bearing and neither is symmetry:
    //
    // * the **exclude** arm ignores it, because "not a dog" means not a dog at all, including
    //   weakly — a floor there would let weak dogs back into a result the reader asked to have
    //   none in;
    // * the **oracle** arm ignores it because its closure has no `weight` column, and because
    //   it would have nothing to say either way: oracle taggings are 99.7 % `median`.
    let floor = crate::filters::nonblank(&req.art_weight_floor)
        == Some(crate::filters::ART_WEIGHT_FLOOR_STRONG);
    let mut probes = Vec::new();
    for (terms, closure, floor) in [
        (&req.art_tags, ART_CLOSURE, floor),
        (&req.oracle_tags, ORACLE_CLOSURE, false),
    ] {
        let Some(terms) = terms else { continue };
        for slug in crate::filters::picked_tags(&terms.include) {
            probes.push(TagProbe {
                closure,
                slug,
                floor,
                exclude: false,
            });
        }
        for slug in crate::filters::picked_tags(&terms.exclude) {
            probes.push(TagProbe {
                closure,
                slug,
                floor: false,
                exclude: true,
            });
        }
    }
    probes
}

/// The statement one probe runs, as a `String` so the plan test can `EXPLAIN` **this** text
/// rather than a copy of it that has since drifted.
///
/// **Only the two `&'static str` names off [`TagClosure`] are interpolated; the slug is
/// bound.** The shape is a join driven from the closure and not the `EXISTS` the search
/// pushes, because the two answer different questions: the search asks "does this card have
/// the tag" once per surviving row, and this asks "which cards have the tag" once. Both land
/// on the same two indexes — `idx_{table}_slug` then `cards`' own key index — and
/// `tests::the_facet_closure_lookup_probes_both_indexes_and_scans_neither` is what keeps it
/// there.
///
/// **Three statements read these closures, all three have a different sensitivity to the slug
/// index, and one figure must never be quoted for another.**
///
/// * `tags::query`'s correlated `count(*)` — the tag search box's reach-per-tag — is the
///   **hang**: 49 ms with the index against **531 seconds** without, because a wide needle is
///   11 531 candidate tags × a 951 499-row scan each. That number is `TAG_INDEXES_SQL`'s and it
///   belongs to the type-ahead; nothing on this page can produce it.
/// * `push_card_filters`' correlated `EXISTS`, pushed once per surviving card, is **unmeasured**
///   without the index. `search.rs`'s own plan test is careful about exactly this — it claims "a
///   walk of 400 k-plus closure rows per card" and attaches no figure — and so is this line.
/// * **This set form is measured on both sides and degrades gracefully**: its plan without the
///   slug index is one `SCAN t` for the whole statement rather than a scan per anything, 57.1 ms
///   against 12.7 ms for `removal`. So the plan test here guards a 4.5× regression. Worth
///   having, and not the first bullet's claim.
///
/// **Measured 2026-08-20 through `node:sqlite`** against a copy of the dev database (116 712
/// printings, `oracle_tag_cards` at 423 080 rows, 0 NULL `oracle_id`), with v20's
/// `idx_oracle_tag_cards_slug` created on the copy because that database is at `user_version`
/// 19 and predates it. Best of five, and a **ceiling** rather than the Rust cost: the harness
/// marshals every rowid into a JS object where [`probe_docs`] sets a bit.
///
/// | slug | printings | best of 5 |
/// | --- | --- | --- |
/// | `triggered-ability` | 47 599 | 25.0 ms |
/// | `activated-ability` | 39 502 | 19.2 ms |
/// | `removal` | 20 763 | 12.7 ms |
/// | `ramp` | 9 522 | 7.3 ms |
///
/// The widest tag in the corpus lands on the same 25 ms the FTS text bitset costs at 100 129
/// matches, which [`run_facets`] already calls the floor for any design. **One statement per
/// picked slug**, so a request naming three tags pays three of these, and nothing here is cached.
///
/// **This paragraph used to say a keystroke could not reach these statements. It was wrong about
/// the page as shipped, and the correction is measured.** The claim was that the Tags page's only
/// text box searches *tags*, so the facet key moves on a chip press and never on a keystroke —
/// true of the rail's type-ahead, and it overlooked that the same page also renders `FilterBar`,
/// whose `#card-search-text` input is unconditional and feeds `debouncedText` straight into
/// `facetReq.text`. So a debounced keystroke **does** re-run one closure probe per picked slug
/// beside the FTS bitset. Driven in the shipped window on 2026-08-20 with the real 952 729-row
/// closure and `plane` (38 144 illustrations) picked: typing into the card box produced exactly
/// one `facet_cards` carrying both `text` and `artTags`, at **47 ms**. Debounced, so it is one
/// call per pause and not one per character.
///
/// Measured over the same taxonomy, through the app, best of three (debug build, so a release
/// build is the faster half of these):
///
/// | request | ms |
/// | --- | --- |
/// | no text, no tag | 30 |
/// | text only | 6 |
/// | `plane` | 63 |
/// | `plane` + text | 46–56 |
/// | `plane` + text + floor | 142–152 |
/// | `plane` + `humanoid` + text | 65–82 |
/// | `dog` (439 illustrations) | 5 |
///
/// Two things worth reading off that table rather than the prose. **Text does not add to a tag**
/// — `plane` + text is no dearer than `plane` alone, because the FTS bitset narrows what
/// [`compute`] then walks. And **the cost is per picked slug and scales with the slug's breadth**,
/// which is why a second wide tag adds ~20 ms and `dog` costs nothing at all.
///
/// **The art weight floor costs the covering index, and that is the one number worth watching.**
/// `weight` is not in `idx_art_tag_illustrations_slug`, so each closure row takes a second seek
/// into the `WITHOUT ROWID` table. Same harness, same day, over a **synthetic** art closure —
/// 588 744 rows over the corpus's *real* `illustration_id` column (111 735 non-NULL, 50 536
/// distinct), because no art taxonomy had been ingested anywhere yet, so the join cardinality is
/// the live one and the tag breadth is not: the widest slug ran **25.6 ms** unfloored against
/// **91.3 ms** floored (78.5 ms on a re-run), the plan dropping from `SEARCH t USING COVERING
/// INDEX` to `SEARCH t USING INDEX`.
///
/// # DO NOT WIDEN THAT INDEX TO `(slug, weight)`
///
/// This note used to end by proposing exactly that — 24.0 ms, 0.7 s build — and deferring it
/// until somebody measured a real taxonomy. **Task 13 ingested one and measured it, and the
/// proposal was wrong.** Against the real 952 729-row closure (2026-08-20, `node:sqlite` against
/// the dev database, native), `(slug, weight)` built and forced with `INDEXED BY` ran the widest
/// floored lookup at **3 180–3 367 ms** — an order of magnitude *worse* than the ~900 ms it was
/// meant to fix — and the planner never chooses it unforced. The reason is structural rather
/// than statistical: these closures are `WITHOUT ROWID`, so `(slug, weight)` expands to
/// `(slug, weight, subject_id)` and the subject id lands *behind* a range test, leaving the plan
/// able to seek only the slug before scanning that slug's whole bucket. `plane` reaches 38 144
/// illustrations, so that bucket is not small — which also retires this note's old closing claim
/// that "no real art tag has been shown to be anywhere near that wide (`dog` reaches 439)".
/// `(slug, subject_id, weight)` *is* the correctly ordered index and is still not worth a rung:
/// forced it is excellent, unforced SQLite prefers the primary key even with the narrow index
/// dropped, so it would need an `ANALYZE` this app does not run.
///
/// The card-filter side needed no index at all in the end. `push_card_filters`' include arm —
/// which this note used to call unmeasured — is no longer a correlated `EXISTS`: it is
/// `subject_id IN (SELECT … WHERE slug = ?)`, which reads the closure once instead of once per
/// card and makes the floor free. `filters.rs` carries that table.
///
/// **What is still unmeasured is this file's own floored probe at real breadth.** Everything
/// above the heading is the synthetic 588 744-row closure; nobody has re-run [`closure_sql`]
/// against the live one. The set form is a third query shape again — it materialises a bitset
/// rather than driving `cards` — so neither the card filter's numbers nor the synthetic ones
/// here can be quoted for it. If it turns out to matter, note that the fix that helped the card
/// filter is available here too and costs no schema change: what made the difference there was
/// reading each slug once, which this statement already does.
fn closure_sql(closure: TagClosure, floor: bool) -> String {
    let TagClosure { table, subject } = closure;
    // The bare `'weak'` literal is coupled to `crate::tags::WEIGHTS[0]` by convention only,
    // exactly as `push_card_filters`' copy is, and for the same reason written there.
    let floor = if floor { " AND t.weight <> 'weak'" } else { "" };
    format!(
        "SELECT c.rowid FROM {table} t
           JOIN cards c ON c.{subject} = t.{subject}
          WHERE t.slug = ?{floor}"
    )
}

/// The docs one probe reaches, as a bitset.
fn probe_docs(
    conn: &rusqlite::Connection,
    capacity: usize,
    probe: &TagProbe,
) -> Result<BitSet, String> {
    let sql = closure_sql(probe.closure, probe.floor);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query([probe.slug.as_str()])
        .map_err(|e| e.to_string())?;
    // **`ix.capacity`, never the row count** — the text bitset's rule, for its reason, and
    // more reachable here: a tag reaches a few hundred illustrations against a corpus of
    // 116 712 printings, so a set sized from the answer would be a handful of words long and
    // `BitSet::and` would truncate every base it narrowed down to that. Counts too low grey
    // out options that would have worked.
    let mut b = BitSet::new(capacity);
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let doc: i64 = row.get(0).map_err(|e| e.to_string())?;
        b.set(doc as u32);
    }
    Ok(b)
}

/// Every tag term as one bitset, or `None` when the request presses nothing in either
/// taxonomy.
///
/// Includes intersect and excludes subtract, which is what `push_card_filters` pushes: one
/// `EXISTS` per include and one `NOT EXISTS` per exclude, all ANDed. The two orders commute,
/// so the probes are run in the order [`tag_probes`] listed them.
///
/// **An exclude with no include subtracts from `ix.all`**, and `all` rather than a filled
/// bitset for `base`'s reason: rowid 0 is never issued and the word-rounded padding above the
/// last row is not a card, so a filled set would hand back up to 64 phantom docs on the one
/// request that also turns `paperOnly` off.
fn tag_narrowing(
    ix: &CardIndex,
    probes: &[TagProbe],
    conn: &rusqlite::Connection,
) -> Result<Option<BitSet>, String> {
    let mut narrowed: Option<BitSet> = None;
    for probe in probes {
        let hit = probe_docs(conn, ix.capacity, probe)?;
        narrowed = Some(if probe.exclude {
            and_not(&narrowed.unwrap_or_else(|| ix.all.clone()), &hit)
        } else {
            match narrowed {
                Some(acc) => acc.and(&hit),
                None => hit,
            }
        });
    }
    Ok(narrowed)
}

/// Facet counts for one search, over the published index. Pure over the state so it is
/// testable without a Tauri app; [`facet_cards`] is the only caller in production.
///
/// **A cold index answers `ready: false`, never an error.** An error surfaces as a failed
/// query and the UI has to guess what it meant; `ready: false` says it plainly, and every
/// control stays live — see [`super::lifecycle`], which owns why that is the only safe guess.
/// It does not build one either: a facet request arrives on every keystroke and a build is
/// ~767 ms.
///
/// There are **two** ways to get that answer and [`compute`] owns the second: no index at
/// all, and an index over an empty corpus, which is a first launch waiting out its opening
/// sync.
pub fn run_facets(state: &AppState, req: &SearchRequest) -> Result<FacetResponse, String> {
    let Some(ix) = super::lifecycle::current(state) else {
        return Ok(FacetResponse {
            ready: false,
            ..Default::default()
        });
    };

    // `nonblank` then `fts_query`, exactly as `search::run_search` does it — including the
    // arm that reads as a bug and is not: **all-punctuation input leaves nothing to match on,
    // and the answer is no text clause at all**, which is what an empty search box does
    // anyway. An empty bitset there would turn a search for `"!!!"` into zero results instead
    // of everything, and grey every option over a page that is full. It stays `None` all the
    // way into [`compute`], and a tag term beside it does not fill the hole.
    let query = crate::filters::nonblank(&req.text).and_then(crate::filters::fts_query);
    let probes = tag_probes(req);

    // Neither narrowing is asked for, so the database is not touched at all — this is the
    // path the unfiltered browse takes, and it is the commonest request there is. Both halves
    // are decided *before* the lock rather than inside it, so nothing here can hold `db_read`
    // for the length of a request that had nothing to ask it.
    if query.is_none() && probes.is_empty() {
        return Ok(compute(&ix, req, None));
    }

    let conn = lock_db_read(state);

    // **The one thing that still needs the database**: neither FTS nor the tag closures has a
    // precomputed bitset, so each is resolved to rowids and turned into one. Text is 25 ms at
    // 100 129 matches, which is the floor for any design (measured 2026-08-11).
    let text = match query {
        None => None,
        Some(query) => {
            let mut stmt = conn
                .prepare("SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([query]).map_err(|e| e.to_string())?;
            // **`ix.capacity`, never a row count.** It is already word-rounded, and it is the
            // figure every bitset in the index was built against — `BitSet::and` takes the
            // shorter operand, so a text set built to any other size would silently truncate
            // every base it narrows and send back counts that are low. Low counts grey out
            // options that would have worked, which hides cards and which nobody reports.
            let mut b = BitSet::new(ix.capacity);
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let doc: i64 = row.get(0).map_err(|e| e.to_string())?;
                b.set(doc as u32);
            }
            Some(b)
        }
    };

    let tags = tag_narrowing(&ix, &probes, &conn)?;
    drop(conn);

    // **[`compute`] takes ONE narrowing set, so two of them are intersected here.** Written
    // out rather than folded through an `Option::map`, because the `None` arms are the whole
    // point: `None` means *no clause*, never *an empty set*, and a fold that started from an
    // empty bitset would empty every search that carried only the other half.
    let narrow = match (text, tags) {
        (Some(text), Some(tags)) => Some(text.and(&tags)),
        (Some(text), None) => Some(text),
        (None, Some(tags)) => Some(tags),
        (None, None) => None,
    };

    Ok(compute(&ix, req, narrow.as_ref()))
}

/// Facet counts for one search.
///
/// A **separate command** from `search_cards` on purpose: facets depend on neither `sort` nor
/// `offset`, so they must not be recomputed per page, and they must never delay page one. The
/// frontend keys them on the filter half of the search key alone.
///
/// `async` + `spawn_blocking` for [`crate::search::search_cards`]' reason: a sync command body
/// runs inline on the IPC thread, and the FTS half of this is blocking SQLite work. It reads
/// through `db_read` like every other read, so a text facet during a sync is not stuck behind
/// the ingest.
#[tauri::command]
pub async fn facet_cards(
    state: tauri::State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> Result<FacetResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_facets(&state, &req))
        .await
        .map_err(|e| format!("facets could not be computed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::fixtures::{doc, own, seeded, state_with_seeded_cards};
    use crate::search::SearchRequest;

    fn req(f: impl FnOnce(&mut SearchRequest)) -> SearchRequest {
        let mut r = SearchRequest {
            limit: 50,
            ..Default::default()
        };
        f(&mut r);
        r
    }

    /// The rule that keeps a multi-select usable: a dimension's counts ignore its OWN
    /// filter. Pick one set and every other set must still report what picking it *would*
    /// give, or the picker greys out the whole list the moment it is used.
    #[test]
    fn a_dimensions_counts_exclude_its_own_filter() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let r = req(|r| r.sets = Some(vec!["lea".into()]));
        let f = compute(&ix, &r, None);
        assert_eq!(f.sets.get("lea").copied(), Some(2));
        assert_eq!(
            f.sets.get("rav").copied(),
            Some(1),
            "still offered, still counted"
        );
    }

    /// The rarity chips are a dimension of their own — **counted over a base that drops the
    /// whole rarity question**, so picking `common` does not grey `uncommon`. The rule every
    /// dimension here follows, stated once more because this is the newest one to get it.
    ///
    /// All four keys arrive whatever the search is, zeros included: a chip greys on a *counted*
    /// zero and stays live on an absent key, so a key that went missing would silently stop
    /// greying.
    #[test]
    fn the_rarity_counts_exclude_their_own_filter_and_never_go_missing() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let none = compute(&ix, &req(|_| {}), None);
        assert_eq!(none.rarities.len(), 4, "all four keys, always");
        assert_eq!(none.rarities.get("common").copied(), Some(1), "Bolt");
        assert_eq!(none.rarities.get("uncommon").copied(), Some(1), "Helix");
        assert_eq!(
            none.rarities.get("rare").copied(),
            Some(0),
            "a counted zero rather than an absent key — this is what greys the chip"
        );
        // **They do not sum to the total.** Sol Ring is `special`, which no chip offers and no
        // bitset counts; three paper printings against two counted rarities.
        assert_eq!(none.total, 3);
        assert_eq!(none.rarities.values().sum::<i64>(), 2);

        let picked = compute(
            &ix,
            &req(|r| r.rarities = Some(vec!["common".into()])),
            None,
        );
        assert_eq!(
            picked.rarities.get("uncommon").copied(),
            Some(1),
            "still offered, still counted — the dimension skips its own filter"
        );
    }

    /// …and every other dimension **does** narrow by it, which is the other half of the same
    /// rule and the half a `Skip` arm in the wrong place would break silently.
    #[test]
    fn other_dimensions_narrow_by_the_rarity_filter() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let f = compute(
            &ix,
            &req(|r| r.rarities = Some(vec!["uncommon".into()])),
            None,
        );
        assert_eq!(f.total, 1, "only Helix is uncommon");
        assert_eq!(
            f.sets.get("lea").copied(),
            Some(0),
            "and Helix is not in lea"
        );
        assert_eq!(f.sets.get("rav").copied(), Some(1));

        // A word this build has never heard of narrows to nothing rather than to everything —
        // matching the SQL, where `rarity IN ('shiny')` returns no rows. Naming *no* rarity is
        // the different answer, and it is the unfiltered case above.
        let unknown = compute(&ix, &req(|r| r.rarities = Some(vec!["shiny".into()])), None);
        assert_eq!(unknown.total, 0);
    }

    /// …while every OTHER dimension does narrow by it.
    #[test]
    fn other_dimensions_do_narrow_by_the_set_filter() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.sets = Some(vec!["rav".into()])), None);
        let modern = "modern".to_string();
        assert_eq!(
            f.formats.get(&modern).copied(),
            Some(1),
            "only Helix is in rav"
        );
    }

    /// Colours broaden, so their number is "what the search becomes if this is pressed",
    /// not "how many are white". With nothing selected that is a narrowing count; with `R`
    /// selected, pressing `W` must report R ∪ RW ∪ colourless.
    #[test]
    fn colour_counts_are_the_result_after_toggling() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let none = compute(&ix, &req(|_| {}), None);
        assert_eq!(none.total, 3, "three paper printings");
        // Subset semantics: mono-R plus the colourless card.
        assert_eq!(none.colors.get("R").copied(), Some(2));

        let r = compute(&ix, &req(|r| r.colors = Some("R".into())), None);
        assert_eq!(r.total, 2, "Bolt and Sol Ring");
        // Adding W admits Helix.
        assert_eq!(r.colors.get("W").copied(), Some(3));
        // Pressing R again removes it — back to everything.
        assert_eq!(r.colors.get("R").copied(), Some(3));
    }

    /// A colour that brings in nothing new reports the count it already had, which is what
    /// the frontend greys on. This is the case "would return nothing" would get wrong.
    #[test]
    fn a_colour_that_adds_nothing_reports_no_change() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        // No blue paper printing exists in the fixture, so adding U to R changes nothing.
        let r = compute(&ix, &req(|r| r.colors = Some("R".into())), None);
        assert_eq!(r.colors.get("U").copied(), Some(r.total));
    }

    #[test]
    fn mana_buckets_are_keyed_by_the_chip_and_eight_is_open_ended() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,is_paper,raw)
             VALUES ('9','Emrakul','roe','1','en','normal',15.0,1,'{}')",
            [],
        )
        .unwrap();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|_| {}), None);
        assert_eq!(f.mana_values.get("1").copied(), Some(2));
        assert_eq!(f.mana_values.get("8").copied(), Some(1), "15 is 8-or-more");
        assert!(!f.mana_values.contains_key("9"), "unknown is not a chip");
    }

    /// `owned` is never greyed, so its two numbers are for the tooltip — but they still have
    /// to be right, and they are counted over the base with `owned` itself removed.
    #[test]
    fn owned_reports_both_sides_of_the_cycle() {
        let conn = seeded();
        own(&conn, "1", 2);
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.owned = Some(true)), None);
        assert_eq!(f.owned.owned, 1);
        assert_eq!(f.owned.missing, 2, "counted as if `owned` were not set");
    }

    /// Text is not a facet, and it narrows every base including its own.
    #[test]
    fn a_text_bitset_narrows_every_dimension() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let mut text = BitSet::new(ix.capacity);
        text.set(doc(&conn, "2"));
        let f = compute(&ix, &req(|_| {}), Some(&text));
        assert_eq!(f.total, 1);
        assert_eq!(f.sets.get("rav").copied(), Some(1));
        assert_eq!(f.sets.get("lea").copied(), Some(0), "offered, and empty");
    }

    /// The exclude-own-dimension rule is wired per dimension, so it is proven per dimension:
    /// the set picker's is above, and this is the mana chips'. Chip 2 has to keep reporting
    /// Helix while chip 1 is pressed, or pressing one chip greys out every other.
    #[test]
    fn the_mana_chips_ignore_the_mana_filter() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.mana_values = Some(vec![1])), None);
        assert_eq!(f.total, 2, "Bolt and Sol Ring cost 1");
        assert_eq!(
            f.mana_values.get("2").copied(),
            Some(1),
            "Helix, still offered"
        );
        assert_eq!(f.mana_values.get("1").copied(), Some(2));
    }

    /// The X chip lives **inside** the mana dimension, and this is the pair of claims that
    /// makes it one chip rather than two filters:
    ///
    /// * it ORs with the value chips — pressing "1" and "X" returns cards that are either, not
    ///   cards that are both, which is the intersection the `AND` shape would have produced and
    ///   which is empty here;
    /// * it shares [`Skip::Mana`], so pressing X leaves every value chip counted as though it
    ///   were not pressed, and pressing a value chip leaves the X count alone.
    ///
    /// The variable-cost row is mana value 3 as well, because Scryfall scores X as 0 — so its
    /// presence in `mana_values["3"]` under an X filter is the overlay working, not a leak.
    #[test]
    fn the_x_chip_ors_with_the_value_chips_and_shares_their_dimension() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,mana_cost,
                is_paper,raw)
             VALUES ('9','Crux of Fate','ktk','1','en','normal',3.0,'{X}{B}{B}{B}',1,'{}')",
            [],
        )
        .unwrap();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let x = compute(&ix, &req(|r| r.mana_x = Some(true)), None);
        assert_eq!(x.total, 1, "the one variable cost in the fixture");
        assert_eq!(x.mana_x, 1, "its own dimension, counted as if X were off");
        assert_eq!(
            x.mana_values.get("1").copied(),
            Some(2),
            "so are the value chips — Bolt and Sol Ring, still offered"
        );

        let both = compute(
            &ix,
            &req(|r| {
                r.mana_values = Some(vec![1]);
                r.mana_x = Some(true);
            }),
            None,
        );
        assert_eq!(
            both.total, 3,
            "either, not both: Bolt, Sol Ring and the X card"
        );

        // Every OTHER dimension does narrow by it, which is what makes it a filter at all.
        let sets = compute(&ix, &req(|r| r.mana_x = Some(true)), None);
        assert_eq!(sets.sets.get("ktk").copied(), Some(1));
        assert_eq!(sets.sets.get("lea").copied(), Some(0), "offered, and empty");

        // And with nothing pressed the count is the whole corpus's, not zero.
        let none = compute(&ix, &req(|_| {}), None);
        assert_eq!(none.total, 4);
        assert_eq!(none.mana_x, 1);
    }

    /// …and the format select's. Sol Ring is legal only in Legacy here, so a Legacy search
    /// narrows to it — while Modern must still report the two cards picking it would give.
    #[test]
    fn the_format_select_ignores_the_format_filter() {
        let conn = seeded();
        let legacy = crate::legalities::bit("legacy").unwrap() as i64;
        conn.execute("UPDATE cards SET legal_mask = ?1 WHERE id = '3'", [legacy])
            .unwrap();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.format = Some("legacy".into())), None);
        assert_eq!(f.total, 1, "only Sol Ring is legal in legacy");
        assert_eq!(f.formats.get("modern").copied(), Some(2), "Bolt and Helix");
        assert_eq!(f.formats.get("legacy").copied(), Some(1));
    }

    /// A format this build has never heard of matches nothing — the SQL pushes a false
    /// predicate for it — so the result is empty. **The format select is counted anyway**,
    /// because its own base skips the arm that empties the others: greying every format at
    /// the one moment the reader needs to pick a different one would strand them there.
    #[test]
    fn an_unknown_format_empties_the_result_but_not_the_format_select() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.format = Some("nonesuch".into())), None);
        assert_eq!(f.total, 0);
        assert_eq!(
            f.sets.get("lea").copied(),
            Some(0),
            "narrowed like everything else"
        );
        assert_eq!(
            f.formats.get("modern").copied(),
            Some(2),
            "the way out stays open"
        );
    }

    /// `C` is exclusive both ways, exactly as `toggleColor` in `useCardSearch.ts` has it: the
    /// backend reads a `colors` of exactly `"C"` as colourless-only, so pressing it drops the
    /// letters and pressing it again clears the filter. A facet computed for a string the UI
    /// would never send describes a search the reader cannot reach.
    #[test]
    fn the_colourless_chip_is_exclusive_both_ways() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let r = compute(&ix, &req(|r| r.colors = Some("R".into())), None);
        assert_eq!(
            r.colors.get("C").copied(),
            Some(1),
            "Sol Ring alone, not R plus it"
        );

        let c = compute(&ix, &req(|r| r.colors = Some("C".into())), None);
        assert_eq!(c.total, 1);
        assert_eq!(
            c.colors.get("C").copied(),
            Some(3),
            "pressing it again clears the filter"
        );
        assert_eq!(
            c.colors.get("R").copied(),
            Some(2),
            "and W/R replaces it rather than joining it"
        );
    }

    /// `setCode` is the same dimension as `sets` and **intersects** with it, because the SQL
    /// pushes the two as separate `WHERE` terms. A facet that ORed them would count printings
    /// the search cannot return.
    #[test]
    fn the_single_set_code_narrows_with_the_set_list_rather_than_beside_it() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let one = compute(&ix, &req(|r| r.set_code = Some("lea".into())), None);
        assert_eq!(one.total, 2, "Bolt and Sol Ring");
        assert_eq!(
            one.formats.get("modern").copied(),
            Some(1),
            "only Bolt is modern"
        );
        assert_eq!(
            one.sets.get("rav").copied(),
            Some(1),
            "its own dimension, still offered"
        );

        let both = compute(
            &ix,
            &req(|r| {
                r.set_code = Some("lea".into());
                r.sets = Some(vec!["rav".into()]);
            }),
            None,
        );
        assert_eq!(both.total, 0, "no printing is in lea AND in rav");

        // Mirrored, not desired: `sets` is lower-cased by `filters::picked_sets` and
        // `setCode` is bound verbatim against a `TEXT` column with no `NOCASE` collation, so
        // the search returns nothing for `LEA` and so must the facet. Greying everything is
        // the honest answer to a search that really is empty.
        let shouted = compute(&ix, &req(|r| r.set_code = Some("LEA".into())), None);
        assert_eq!(shouted.total, 0);
        let listed = compute(&ix, &req(|r| r.sets = Some(vec!["LEA".into()])), None);
        assert_eq!(
            listed.total, 2,
            "the list is normalised, the single code is not"
        );
    }

    /// A named set the index has never heard of matches nothing, and that is **not** the same
    /// as naming no set at all. Dropping the unknown code would leave the base unfiltered and
    /// report the whole corpus under a filter that returns none of it. Reachable: the index
    /// is one sync behind a `cards` swap for as long as the rebuild takes.
    #[test]
    fn a_set_the_index_has_never_seen_counts_nothing_rather_than_everything() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.sets = Some(vec!["zzz".into()])), None);
        assert_eq!(f.total, 0);
        assert_eq!(f.formats.get("modern").copied(), Some(0));
        // A cleared picker sends `[]` or `[""]`, and that is "no filter" — the one case where
        // an empty list must not empty the search.
        let cleared = compute(&ix, &req(|r| r.sets = Some(vec!["".into()])), None);
        assert_eq!(cleared.total, 3);
    }

    /// `playableOnly` is the search view's default and is not a facet, so it narrows every
    /// base — and its own default is the **opposite** of `paperOnly`'s, which is the half a
    /// reader would get wrong.
    ///
    /// The format counts are the assertion that matters: every `formats[k]` is a subset of
    /// `playable`, so applying this filter to their base must move nothing. A count that did
    /// move would mean the two disagree about what a legality is, and the format select would
    /// then grey an option the search returns rows for.
    #[test]
    fn playable_only_narrows_every_base_and_leaves_the_format_counts_alone() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let off = compute(&ix, &req(|_| {}), None);
        assert_eq!(off.total, 3, "the default counts Sol Ring, mask 0 and all");

        let on = compute(&ix, &req(|r| r.playable_only = Some(true)), None);
        assert_eq!(on.total, 2, "Bolt and Helix; Sol Ring's mask is 0");
        assert_eq!(
            on.sets.get("lea").copied(),
            Some(1),
            "lea keeps Bolt and loses Sol Ring"
        );
        assert_eq!(
            on.mana_values.get("1").copied(),
            Some(1),
            "both cost 1, and only one of them is playable"
        );
        assert_eq!(
            on.formats.get("modern").copied(),
            off.formats.get("modern").copied(),
            "a format count cannot move: formats[k] is already inside playable"
        );

        let explicit_off = compute(&ix, &req(|r| r.playable_only = Some(false)), None);
        assert_eq!(explicit_off.total, 3, "false is the same as absent");
    }

    /// The digital printing is behind `paperOnly`, which defaults on and is not a facet.
    #[test]
    fn the_paper_default_applies_to_every_base() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|_| {}), None);
        assert_eq!(
            f.sets.get("alc").copied(),
            Some(0),
            "the digital set counts nothing"
        );
    }

    /// The frontend mirrors these names by hand in `src/lib/ipc.ts`; a rename here that is
    /// not mirrored there is a silently `undefined` field in the UI. Whole-value equality,
    /// so a field added and never mirrored fails as loudly as a rename.
    #[test]
    fn the_facet_json_uses_the_camel_case_names_the_frontend_expects() {
        let mut f = FacetResponse {
            total: 3,
            ready: true,
            ..Default::default()
        };
        f.colors.insert("W".into(), 1);
        f.mana_values.insert("0".into(), 2);
        f.mana_x = 5;
        f.formats.insert("modern".into(), 3);
        f.rarities.insert("rare".into(), 6);
        f.sets.insert("lea".into(), 4);
        f.owned = OwnedFacets {
            owned: 1,
            missing: 2,
        };
        assert_eq!(
            serde_json::to_value(f).unwrap(),
            serde_json::json!({
                "colors": {"W": 1},
                "manaValues": {"0": 2},
                // A sibling of `manaValues`, deliberately — never an `"x"` key inside it.
                "manaX": 5,
                "formats": {"modern": 3},
                "rarities": {"rare": 6},
                "sets": {"lea": 4},
                "owned": {"owned": 1, "missing": 2},
                "total": 3,
                "ready": true
            })
        );
    }

    /// The app's state over the four fixture printings, with the search index rebuilt.
    ///
    /// `cards_fts` is external-content with no triggers, so rows inserted straight into
    /// `cards` — which is what the fixture does — match nothing until this runs. Without it
    /// every text assertion below would pass by counting zero.
    fn state(name: &str) -> std::sync::Arc<crate::sync::AppState> {
        let state = state_with_seeded_cards(name);
        {
            let conn = crate::db::lock_blocking(&state.db);
            conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
                .unwrap();
        }
        state
    }

    /// Cold has to be answerable, not an error: an error surfaces as a failed query and the
    /// UI would have to guess what it meant. `ready: false` says it, and the frontend leaves
    /// every control live on it.
    ///
    /// It must also not *build* one. A facet request arrives on every keystroke, and ~767 ms
    /// of corpus scan is not something a keystroke may buy.
    #[test]
    fn a_cold_index_answers_not_ready_rather_than_failing() {
        let state = state("cold-facets");
        let f = run_facets(&state, &req(|_| {})).expect("cold is an answer, never an error");
        assert!(!f.ready);
        assert_eq!(f.total, 0);
        assert!(
            f.sets.is_empty(),
            "nothing is counted, so nothing is greyed"
        );
        assert!(
            crate::index::lifecycle::current(&state).is_none(),
            "and a facet request does not spend a build"
        );
    }

    /// The other way to be not-ready, and the one a new user meets: the index built fine, it
    /// just built over nothing.
    ///
    /// `lib.rs` spawns a build at setup, so on a first launch there is a published index over
    /// zero rows for the ~93 s the opening sync takes. Counted honestly every option is zero,
    /// the greying rule dims all of them, and — with no filter on — no `Reset all` is drawn
    /// to escape by. The rule holds and the app reads as broken, so the corpus being empty is
    /// treated as "not counted yet" rather than as a result.
    ///
    /// The last assertion is the whole difference from the test above: this is a real index,
    /// published, answering not-ready on its own account.
    #[test]
    fn an_index_over_an_empty_corpus_answers_not_ready() {
        let state = state("empty-corpus-facets");
        {
            let conn = crate::db::lock_blocking(&state.db);
            conn.execute("DELETE FROM cards", []).unwrap();
            conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
                .unwrap();
        }
        crate::index::lifecycle::build_now(&state).unwrap();

        let f = run_facets(&state, &req(|_| {})).unwrap();
        assert!(!f.ready, "an opening sync is not an empty result");
        assert_eq!(f.total, 0);
        assert!(
            f.sets.is_empty() && f.formats.is_empty() && f.mana_values.is_empty(),
            "the same shape a cold answer has: empty maps, never zeroed ones"
        );
        assert!(
            crate::index::lifecycle::current(&state).is_some(),
            "and the index really was built — this is not the cold path"
        );
    }

    /// Text is the one filter with no dimension in the index, so it is resolved against FTS
    /// and handed to `compute` as a bitset. Every count in the response is narrowed by it.
    #[test]
    fn a_text_search_is_resolved_through_fts_and_narrows_every_count() {
        let state = state("text-facets");
        crate::index::lifecycle::build_now(&state).unwrap();

        let f = run_facets(&state, &req(|r| r.text = Some("bolt".into()))).unwrap();
        assert!(f.ready);
        assert_eq!(f.total, 1, "Lightning Bolt alone");
        assert_eq!(f.sets.get("lea").copied(), Some(1));
        assert_eq!(f.sets.get("rav").copied(), Some(0), "offered, and empty");
    }

    /// **All-punctuation input leaves nothing to match on, and the answer is no text clause
    /// at all** — which is what an empty search box does anyway. `fts_query` answers `None`
    /// there, and an implementation that reads that as an empty match set turns a search for
    /// `"!!!"` into zero results instead of everything. `run_search` makes the same choice;
    /// facets that disagreed with it would grey every option over a page that is full.
    #[test]
    fn text_with_nothing_indexable_in_it_counts_everything_rather_than_nothing() {
        let state = state("punctuation-facets");
        crate::index::lifecycle::build_now(&state).unwrap();

        let f = run_facets(&state, &req(|r| r.text = Some("!!!".into()))).unwrap();
        assert_eq!(
            f.total, 3,
            "the three paper printings, as with no text at all"
        );
        assert_eq!(f.sets.get("lea").copied(), Some(2));
    }

    /// [`state`]'s four printings plus a fifth at a **far rowid**, with both tag closures
    /// seeded over them.
    ///
    /// **The far rowid is why this fixture is not four rows.** A tag bitset sized from the
    /// number of rows its closure query returned rather than from `ix.capacity` is one word
    /// long here, and `BitSet::and` takes the *shorter* operand — so every count would
    /// silently drop doc 5 000 and read **low**, which greys options that would have worked
    /// and hides cards nobody thinks to report. Four consecutive rowids all live in word 0
    /// and cannot catch it.
    ///
    /// The taggings mirror the shapes `filters::tests::corpus_with_art_tags` pins, in the
    /// terms this file can assert on:
    ///
    /// * `illus-helix` is a **weak** dog, so the weight floor moves the counts;
    /// * Sol Ring has **no `illustration_id`** — 4 977 of 116 712 live printings are in that
    ///   state (measured 2026-08-20) — so it answers no art tag and survives every art
    ///   exclude. Its absence from an art result is the join, not a missing row;
    /// * the digital printing is a dog too, so `paperOnly` still has work to do under a tag
    ///   filter;
    /// * the oracle closure **crosses** the art one rather than agreeing with it, so a
    ///   request naming both narrows further than either.
    fn tagged_state(name: &str) -> std::sync::Arc<crate::sync::AppState> {
        let state = state(name);
        {
            let conn = crate::db::lock_blocking(&state.db);
            let subjects = [
                ("1", Some("illus-bolt"), "oracle-bolt"),
                ("2", Some("illus-helix"), "oracle-helix"),
                ("3", None, "oracle-ring"),
                ("4", Some("illus-digital"), "oracle-digital"),
            ];
            for (id, illustration, oracle) in subjects {
                conn.execute(
                    "UPDATE cards SET illustration_id = ?2, oracle_id = ?3 WHERE id = ?1",
                    rusqlite::params![id, illustration, oracle],
                )
                .unwrap();
            }
            let modern = crate::legalities::bit("modern").unwrap() as i64;
            conn.execute(
                "INSERT INTO cards (rowid,id,name,set_code,collector_number,lang,layout,cmc,
                    color_identity,is_paper,legal_mask,illustration_id,oracle_id,raw)
                 VALUES (5000,'5','Far Rowid Hound','dom','1','en','normal',3.0,'G',1,?1,
                    'illus-far','oracle-far','{}')",
                [modern],
            )
            .unwrap();
            let art = [
                ("illus-bolt", "dog", "strong"),
                ("illus-helix", "dog", "weak"),
                ("illus-far", "dog", "median"),
                ("illus-digital", "dog", "strong"),
                ("illus-bolt", "snow", "median"),
            ];
            for (illustration, slug, weight) in art {
                conn.execute(
                    "INSERT INTO art_tag_illustrations (illustration_id,slug,weight)
                     VALUES (?1,?2,?3)",
                    rusqlite::params![illustration, slug, weight],
                )
                .unwrap();
            }
            let oracle = [
                ("oracle-bolt", "removal"),
                ("oracle-helix", "removal"),
                ("oracle-ring", "ramp"),
                ("oracle-far", "ramp"),
            ];
            for (oracle_id, slug) in oracle {
                conn.execute(
                    "INSERT INTO oracle_tag_cards (oracle_id,slug) VALUES (?1,?2)",
                    rusqlite::params![oracle_id, slug],
                )
                .unwrap();
            }
            // The fifth printing arrived after [`state`] built the index, and `cards_fts` is
            // external-content with no triggers — without this the text assertions below
            // would pass by counting zero.
            conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
                .unwrap();
        }
        crate::index::lifecycle::build_now(&state).unwrap();
        state
    }

    fn terms(include: &[&str], exclude: &[&str]) -> crate::filters::TagTerms {
        crate::filters::TagTerms {
            include: include.iter().map(|s| (*s).to_owned()).collect(),
            exclude: exclude.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// A facet count taken under a tag term must be over the tag-narrowed corpus. Without
    /// this the picker offers a set with 2 printings on a search that returns 1 — a number
    /// wrong in the direction that looks plausible, which is the direction a reader believes.
    #[test]
    fn facet_counts_narrow_to_the_art_tag_terms() {
        let state = tagged_state("art-tag-facets");

        let open = run_facets(&state, &req(|_| {})).unwrap();
        assert_eq!(open.total, 4, "four paper printings before any tag term");
        assert_eq!(open.sets.get("lea").copied(), Some(2));

        let f = run_facets(&state, &req(|r| r.art_tags = Some(terms(&["dog"], &[])))).unwrap();
        assert!(f.ready);
        assert_eq!(
            f.total, 3,
            "Bolt, Helix and the hound; Sol Ring is untagged"
        );
        assert_eq!(f.sets.get("lea").copied(), Some(1), "Bolt, not Sol Ring");
        assert_eq!(f.sets.get("rav").copied(), Some(1), "Helix");
        assert_eq!(
            f.sets.get("alc").copied(),
            Some(0),
            "the digital dog stays behind paperOnly"
        );
        // The far-rowid printing is the capacity assertion: a bitset sized from the row count
        // is one word long and drops doc 5 000 without a word.
        assert_eq!(
            f.sets.get("dom").copied(),
            Some(1),
            "doc 5 000 survives the AND — the set was sized from ix.capacity"
        );
        assert_eq!(
            f.mana_values.get("1").copied(),
            Some(1),
            "Bolt alone: Sol Ring costs 1 too and is not a dog"
        );
    }

    /// The weight floor rides the art **include** arm and nothing else, exactly as
    /// [`crate::filters::push_card_filters`] pushes it — `ati.weight <> 'weak'`, read off the
    /// closure's folded weight. A facet that ignored it would offer Helix's set on a search
    /// that has dropped Helix.
    #[test]
    fn the_weight_floor_narrows_the_counts_on_the_include_arm_alone() {
        let state = tagged_state("art-floor-facets");

        let floored = run_facets(
            &state,
            &req(|r| {
                r.art_tags = Some(terms(&["dog"], &[]));
                r.art_weight_floor = Some("strong".into());
            }),
        )
        .unwrap();
        assert_eq!(floored.total, 2, "the weak dog is gone");
        assert_eq!(
            floored.sets.get("rav").copied(),
            Some(0),
            "Helix is weak under dog"
        );
        assert_eq!(floored.sets.get("lea").copied(), Some(1), "Bolt is strong");
        assert_eq!(
            floored.sets.get("dom").copied(),
            Some(1),
            "median clears it"
        );

        // **"not a dog" means not a dog at all, including weakly.** A floor on this arm would
        // let the weak dog back into a result the reader asked to have none in — so the
        // exclude answers the same 1 with the floor on as with it off.
        for floor in [None, Some("strong".to_owned())] {
            let f = run_facets(
                &state,
                &req(|r| {
                    r.art_tags = Some(terms(&[], &["dog"]));
                    r.art_weight_floor = floor.clone();
                }),
            )
            .unwrap();
            assert_eq!(f.total, 1, "Sol Ring alone, floor {floor:?}");
            assert_eq!(f.sets.get("lea").copied(), Some(1));
        }
    }

    /// An exclude subtracts from the whole corpus when it is the only term, and a printing
    /// with **no `illustration_id`** survives it — `NULL = NULL` is not true, so it matches no
    /// art tag and is kept by every art exclude. That is the join answering, not a missing
    /// row, and it is the half a bitset built the wrong way round would get backwards.
    #[test]
    fn an_exclude_only_request_subtracts_from_the_whole_corpus() {
        let state = tagged_state("art-exclude-facets");
        let f = run_facets(&state, &req(|r| r.art_tags = Some(terms(&[], &["snow"])))).unwrap();
        assert_eq!(f.total, 3, "everything but Bolt");
        assert_eq!(
            f.sets.get("lea").copied(),
            Some(1),
            "Sol Ring has no illustration and cannot be snow"
        );
        assert_eq!(f.sets.get("dom").copied(), Some(1));
    }

    /// The oracle twin, on `oracle_tag_cards`/`oracle_id` and with **no** weight clause — that
    /// closure has no `weight` column, so a floor copied onto it is a `no such column` error
    /// rather than a wrong answer. The two taxonomies then AND with each other, which is what
    /// makes "a hound that ramps" one request.
    #[test]
    fn oracle_tag_terms_narrow_too_and_intersect_with_the_art_ones() {
        let state = tagged_state("oracle-tag-facets");

        let ramp = run_facets(
            &state,
            &req(|r| r.oracle_tags = Some(terms(&["ramp"], &[]))),
        )
        .unwrap();
        assert_eq!(ramp.total, 2, "Sol Ring and the hound");
        assert_eq!(ramp.sets.get("rav").copied(), Some(0));

        let both = run_facets(
            &state,
            &req(|r| {
                r.art_tags = Some(terms(&["dog"], &[]));
                r.oracle_tags = Some(terms(&["ramp"], &[]));
                // The floor reaches the art half only; the oracle arm must not see it.
                r.art_weight_floor = Some("strong".into());
            }),
        )
        .unwrap();
        assert_eq!(both.total, 1, "only the hound is both");
        assert_eq!(both.sets.get("dom").copied(), Some(1));

        let not_removal = run_facets(
            &state,
            &req(|r| r.oracle_tags = Some(terms(&[], &["removal"]))),
        )
        .unwrap();
        assert_eq!(not_removal.total, 2, "Sol Ring and the hound again");
    }

    /// Text and tags are two narrowings and [`compute`] takes one, so they are **intersected**
    /// before it sees them. Passing either alone would leave the other's counts high.
    #[test]
    fn a_text_search_and_a_tag_term_intersect_rather_than_replace_each_other() {
        let state = tagged_state("text-and-tag-facets");

        let text_only = run_facets(&state, &req(|r| r.text = Some("lightning".into()))).unwrap();
        assert_eq!(text_only.total, 2, "Bolt and Helix");

        let both = run_facets(
            &state,
            &req(|r| {
                r.text = Some("lightning".into());
                r.art_tags = Some(terms(&["snow"], &[]));
            }),
        )
        .unwrap();
        assert_eq!(both.total, 1, "Bolt is the only snowy Lightning");
        assert_eq!(both.sets.get("rav").copied(), Some(0), "offered, and empty");

        let disjoint = run_facets(
            &state,
            &req(|r| {
                r.text = Some("sol".into());
                r.art_tags = Some(terms(&["dog"], &[]));
            }),
        )
        .unwrap();
        assert_eq!(disjoint.total, 0, "Sol Ring is not a dog");
    }

    /// **`text: None` is meaningful and must stay meaningful under a tag term.**
    /// All-punctuation input leaves nothing to match on and `fts_query` answers `None`, which
    /// means *no text clause* rather than an empty match set. A tag narrowing that filled that
    /// slot with an empty bitset — or that let the punctuation empty it — would turn a search
    /// for `"!!!"` into zero results over a page that is full.
    #[test]
    fn punctuation_text_beside_a_tag_term_counts_the_tag_and_not_nothing() {
        let state = tagged_state("punctuation-and-tag-facets");
        let f = run_facets(
            &state,
            &req(|r| {
                r.text = Some("!!!".into());
                r.art_tags = Some(terms(&["dog"], &[]));
            }),
        )
        .unwrap();
        assert_eq!(f.total, 3, "the dogs, as with no text at all");
        assert_eq!(f.sets.get("dom").copied(), Some(1));
    }

    /// Absent means no filter, and a cleared chip row sends `[]` or `[""]`. The normalisation
    /// is [`crate::filters::picked_tags`] and it is **the search's own**, called rather than
    /// re-derived: a facet counted over a slug list the search trimmed differently reports
    /// options as live that the search cannot reach.
    #[test]
    fn blank_tag_terms_narrow_nothing() {
        let state = tagged_state("blank-tag-facets");
        let open = run_facets(&state, &req(|_| {})).unwrap();
        assert_eq!(open.total, 4);

        for f in [
            run_facets(&state, &req(|r| r.art_tags = Some(terms(&[], &[])))).unwrap(),
            run_facets(
                &state,
                &req(|r| r.art_tags = Some(terms(&["", "  "], &[""]))),
            )
            .unwrap(),
            run_facets(&state, &req(|r| r.oracle_tags = Some(terms(&["  "], &[])))).unwrap(),
            run_facets(&state, &req(|r| r.art_weight_floor = Some("strong".into()))).unwrap(),
        ] {
            assert_eq!(f.total, 4);
            assert_eq!(f.sets.get("lea").copied(), Some(2));
        }

        // A slug is trimmed rather than dropped, so a chip that arrived with whitespace still
        // narrows — the other half of what `picked_tags` promises.
        let padded =
            run_facets(&state, &req(|r| r.art_tags = Some(terms(&[" dog "], &[])))).unwrap();
        assert_eq!(padded.total, 3);
    }

    /// A tag the corpus has never heard of narrows to nothing, which is what the search's
    /// `EXISTS` does too. It is **not** the same as naming no tag at all: dropping the unknown
    /// slug would leave the base unfiltered and report the whole corpus under a filter that
    /// returns none of it.
    #[test]
    fn a_tag_the_corpus_has_never_seen_counts_nothing_rather_than_everything() {
        let state = tagged_state("unknown-tag-facets");
        let f = run_facets(
            &state,
            &req(|r| r.art_tags = Some(terms(&["nonesuch"], &[]))),
        )
        .unwrap();
        assert_eq!(f.total, 0);
        assert_eq!(f.sets.get("lea").copied(), Some(0));
        assert!(f.ready, "an empty result is still a counted one");
    }

    /// Each closure lookup is an **indexed probe of the slug** feeding an **indexed probe of
    /// `cards`**, and neither table is ever scanned.
    ///
    /// This is the assertion no test about counts can make. `search.rs`'s twin pins the
    /// correlated `EXISTS` the search pushes; this pins the *set* form the facets use, which is
    /// a different statement over the same two indexes.
    ///
    /// **What going red here means, stated so it is not confused with the neighbouring
    /// claim.** Losing the slug index turns this statement into one `SCAN t` and costs
    /// **57.1 ms against 12.7 ms** for `removal` (measured 2026-08-20, see [`closure_sql`]) —
    /// a 4.5× regression, which is worth a test and is worth reading as one. It is **not** the
    /// 531-second hang: that figure is `tags::query`'s correlated `count(*)` over 11 531
    /// candidate tags, it belongs to the tag search box, and no plan this test can pin will
    /// ever produce it.
    #[test]
    fn the_facet_closure_lookup_probes_both_indexes_and_scans_neither() {
        let state = tagged_state("tag-facet-plan");
        let conn = crate::db::lock_blocking(&state.db);
        for closure in [ART_CLOSURE, ORACLE_CLOSURE] {
            for floor in [false, true] {
                // The floor reads a column the oracle closure has not got; the art arm is the
                // only one that is ever asked for it.
                if floor && closure.table != ART_CLOSURE.table {
                    continue;
                }
                let sql = closure_sql(closure, floor);
                let plan: Vec<String> = conn
                    .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                    .unwrap()
                    .query_map(["dog"], |r| r.get::<_, String>(3))
                    .unwrap()
                    .map(Result::unwrap)
                    .collect();
                let probe = plan
                    .iter()
                    .find(|step| step.starts_with("SEARCH t "))
                    .unwrap_or_else(|| panic!("no indexed probe of the closure: {plan:#?}\n{sql}"));
                assert!(probe.contains("slug=?"), "{probe}");
                assert!(
                    plan.iter().any(|step| step.starts_with("SEARCH c ")
                        && step.contains(&format!("{}=?", closure.subject))),
                    "cards must be probed on {}, never walked: {plan:#?}\n{sql}",
                    closure.subject
                );
                assert!(
                    !plan.iter().any(|step| step.starts_with("SCAN")),
                    "nothing here may be scanned: {plan:#?}\n{sql}"
                );
            }
        }
    }

    /// **The claim this whole file exists to make, stated against the other half.** A count and
    /// the wall it describes are two entirely different implementations of one question —
    /// `push_card_filters`' correlated `EXISTS` per surviving row against a bitset built from
    /// the same closures — and the defect is not that either is wrong on its own, it is that
    /// they disagree: the picker offering a set with 2 printings over a search that returns 1.
    ///
    /// Uncollapsed on purpose. `FacetResponse::total` is **printings, always**, while
    /// `SearchResponse::total` counts *cards* when the search is collapsed and stops at 5 000 —
    /// so the two are the same number only over the shape this drives.
    #[test]
    fn a_facet_total_equals_what_the_search_returns_for_the_same_tag_terms() {
        let state = tagged_state("tag-facet-agrees-with-search");
        let conn = crate::db::lock_blocking(&state.db);
        let cases: [(&str, SearchRequest); 7] = [
            ("no tags at all", req(|_| {})),
            (
                "an art include",
                req(|r| r.art_tags = Some(terms(&["dog"], &[]))),
            ),
            (
                "an art include under the floor",
                req(|r| {
                    r.art_tags = Some(terms(&["dog"], &[]));
                    r.art_weight_floor = Some("strong".into());
                }),
            ),
            (
                "an art exclude with the floor on",
                req(|r| {
                    r.art_tags = Some(terms(&[], &["dog"]));
                    r.art_weight_floor = Some("strong".into());
                }),
            ),
            (
                "an oracle include",
                req(|r| r.oracle_tags = Some(terms(&["ramp"], &[]))),
            ),
            (
                "both taxonomies",
                req(|r| {
                    r.art_tags = Some(terms(&["dog"], &[]));
                    r.oracle_tags = Some(terms(&["ramp"], &[]));
                }),
            ),
            (
                "text beside a tag",
                req(|r| {
                    r.text = Some("lightning".into());
                    r.art_tags = Some(terms(&["dog"], &[]));
                }),
            ),
        ];
        for (name, r) in cases {
            // Two different connections and therefore two different mutexes — `run_search` is
            // driven over the write handle held here and `run_facets` takes `db_read` for
            // itself, so holding this one across the call is a read beside a read rather than
            // a deadlock waiting to be discovered by a loaded CI runner.
            let wall = crate::search::run_search(&conn, &r).unwrap();
            let facets = run_facets(&state, &r).unwrap();
            assert!(
                !wall.total_is_capped,
                "{name}: a capped wall would make this assertion vacuous"
            );
            assert_eq!(
                facets.total, wall.total,
                "{name}: the count and the wall describe one corpus or neither is worth drawing"
            );
        }
    }

    /// Not a unit test — a stopwatch, over a synthetic corpus the size and shape of the live
    /// one. `--ignored`, and `--release`: the debug build is ~20× slower and says nothing
    /// about the 100 ms budget spec §2 sets.
    ///
    /// No database, unlike `index::tests::warmup_timing`: nothing here reads a row, so the
    /// bitsets can be filled directly and the number is about the counting alone.
    #[test]
    #[ignore]
    fn facet_timing() {
        // 116 694 printings, 107 337 of them paper, 1 047 set codes — the live corpus,
        // measured 2026-08-11.
        let n = 116_694u32;
        let cap = BitSet::new(n as usize + 1).capacity();
        let mut ix = CardIndex {
            capacity: cap,
            all: BitSet::new(cap),
            paper: BitSet::new(cap),
            colors: std::array::from_fn(|_| BitSet::new(cap)),
            mana: std::array::from_fn(|_| BitSet::new(cap)),
            mana_x: BitSet::new(cap),
            formats: (0..crate::legalities::LEGALITY_KEYS.len())
                .map(|_| BitSet::new(cap))
                .collect(),
            playable: BitSet::new(cap),
            rarity: std::array::from_fn(|_| BitSet::new(cap)),
            set_ord: vec![0; cap],
            set_codes: (0..1047).map(|i| format!("s{i}")).collect(),
            owned: BitSet::new(cap),
        };
        for d in 1..=n {
            ix.all.set(d);
            // 92% paper, matching 107 337/116 694.
            if d % 25 != 0 && d % 25 != 1 {
                ix.paper.set(d);
            }
            ix.set_ord[d as usize] = (d % 1047) as u16;
            // Roughly a third colourless, the rest spread over one or two letters — the
            // multicolour rows are what make the colour facet's exclusions do work.
            if d % 3 == 0 {
                ix.colors[5].set(d);
            } else {
                ix.colors[(d % 5) as usize].set(d);
                if d % 7 == 0 {
                    ix.colors[((d + 2) % 5) as usize].set(d);
                }
            }
            ix.mana[(d % 9) as usize].set(d);
            // Roughly one printing in eleven prints an `{X}`, spread across every bucket —
            // an overlay, so these docs are in `mana` as well.
            if d % 11 == 0 {
                ix.mana_x.set(d);
            }
            for k in 0..ix.formats.len() {
                if !(d as usize + k).is_multiple_of(3) {
                    ix.formats[k].set(d);
                    // The union of the format sets, which is what a non-zero mask is. Every
                    // doc here lands in it — 23 keys against a modulus of 3 — so the timing
                    // below measures the AND rather than a bitset that is mostly empty.
                    ix.playable.set(d);
                }
            }
            // The four rarities, roughly as the corpus is shaped: commons and uncommons carry
            // most of it, mythics a twentieth. Not a partition — one doc in twenty-five lands at
            // none of the four, standing in for the `special` and `bonus` printings no chip
            // offers, so the counts below cannot be summed into the total.
            if d % 25 != 3 {
                ix.rarity[(d % 4) as usize].set(d);
            }
            if d % 100 == 0 {
                ix.owned.set(d);
            }
        }

        let cases: [(&str, SearchRequest); 4] = [
            ("unfiltered browse", req(|_| {})),
            ("colours (R)", req(|r| r.colors = Some("R".into()))),
            (
                "colours + mana + owned",
                req(|r| {
                    r.colors = Some("RG".into());
                    r.mana_values = Some(vec![1, 2, 8]);
                    r.owned = Some(false);
                }),
            ),
            (
                "64 sets",
                req(|r| r.sets = Some((0..64).map(|i| format!("s{i}")).collect())),
            ),
        ];
        for (name, r) in cases {
            let mut best = std::time::Duration::MAX;
            for _ in 0..5 {
                let t = std::time::Instant::now();
                let f = compute(&ix, &r, None);
                best = best.min(t.elapsed());
                std::hint::black_box(f.total);
            }
            println!("{name}: {best:?}");
        }
    }
}
