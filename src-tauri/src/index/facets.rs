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
    /// Keyed by `legalities` key. Plain counts.
    pub formats: BTreeMap<String, i64>,
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
    Owned,
}

/// The two dimensions whose bitset costs a walk to build, built once for the whole request.
///
/// [`base`] is called six times and neither of these depends on which dimension is being
/// skipped, so building them per call would walk the corpus five more times than the answer
/// needs — and the set walk carries a `set_codes` lookup per picked code on top.
struct Prepared {
    sets: Option<BitSet>,
    mana: Option<BitSet>,
}

/// The result set under every filter except `skip`'s.
///
/// **Two filters the request can carry are missing here, both deliberately, and both erring
/// in the direction that costs a press rather than hiding a card.**
///
/// * `rarity` has no dimension in [`CardIndex`] to narrow by, so a rarity-filtered request
///   is faceted as though it were unfiltered — every count reads high. Closing it means a
///   sixth bitset dimension in the index, which is a change to the build and not to this
///   file. Nothing in the app sends it with facets today: the search view's filter bar has
///   no rarity control.
/// * `collapse` is not a filter at all. The search folds printings into cards for display
///   and these counts are printings either way — spec §2 says so, and the tooltip says
///   "printings" for exactly this reason.
fn base(
    ix: &CardIndex,
    req: &SearchRequest,
    text: Option<&BitSet>,
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
    if let Some(t) = text {
        b = b.and(t);
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

/// The mana chips as one bitset, or `None` when no chip is pressed.
///
/// Chips are ORed with each other, and a value past the last chip is that chip: the SQL
/// spells `>= 8` open-ended, so the index's bucket 8 already holds everything above it.
/// Bucket [`CardIndex::MANA_UNKNOWN`] is unreachable from here on purpose — no chip asks for
/// "no mana value at all", and `NULL IN (…)` is NULL.
fn union_mana(ix: &CardIndex, values: &[u8]) -> Option<BitSet> {
    if values.is_empty() {
        return None;
    }
    let mut u = BitSet::new(ix.capacity);
    for v in values {
        let bucket = usize::from(*v).min(usize::from(crate::filters::MANA_VALUE_OPEN_ENDED));
        ix.mana[bucket].for_each(|d| u.set(d));
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
/// `text` is the FTS result as a bitset — not a facet, and in **every** base including its
/// own, because a facet describes the search the reader is looking at.
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
pub fn compute(ix: &CardIndex, req: &SearchRequest, text: Option<&BitSet>) -> FacetResponse {
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
        mana: req.mana_values.as_deref().and_then(|v| union_mana(ix, v)),
    };
    let base = |skip| base(ix, req, text, &prep, skip);

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

    let formats_base = base(Skip::Formats);
    for (k, key) in crate::legalities::LEGALITY_KEYS.iter().enumerate() {
        out.formats.insert(
            (*key).to_owned(),
            i64::from(formats_base.and_count(&ix.formats[k])),
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

    // **The one thing that still needs the database**: FTS has no precomputed bitset, so a
    // text search is resolved to rowids and turned into one. 25 ms at 100 129 matches, which
    // is the floor for any design (measured 2026-08-11).
    //
    // `nonblank` then `fts_query`, exactly as `search::run_search` does it — including the
    // arm that reads as a bug and is not: **all-punctuation input leaves nothing to match on,
    // and the answer is no text clause at all**, which is what an empty search box does
    // anyway. An empty bitset there would turn a search for `"!!!"` into zero results instead
    // of everything, and grey every option over a page that is full.
    let text = match crate::filters::nonblank(&req.text).and_then(crate::filters::fts_query) {
        None => None,
        Some(query) => {
            let conn = lock_db_read(state);
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

    Ok(compute(&ix, req, text.as_ref()))
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
        f.formats.insert("modern".into(), 3);
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
                "formats": {"modern": 3},
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
            formats: (0..crate::legalities::LEGALITY_KEYS.len())
                .map(|_| BitSet::new(cap))
                .collect(),
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
            for k in 0..ix.formats.len() {
                if !(d as usize + k).is_multiple_of(3) {
                    ix.formats[k].set(d);
                }
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
