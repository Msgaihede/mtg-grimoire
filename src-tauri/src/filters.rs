//! The card predicates, in one place, so every list that filters cards filters them the
//! same way.
//!
//! Lifted out of [`crate::search`] when the collection needed the same six filters over a
//! *joined* query. Everything here is alias-parameterised (`c` in the search, `c` in the
//! collection's LEFT JOIN) and pushes its parameters in the order it pushes its SQL, which
//! is the invariant the whole builder rests on: `?` binds by position, so a fragment and
//! its parameter must never be separated.
//!
//! Only four kinds of thing are ever interpolated into the SQL — a colour letter from
//! [`COLORS`], a `?`-placeholder list whose *length* is all it carries, the literal `0` an
//! unrecognised format collapses to, and the fixed `AND … <> 'weak'` fragment a `strong`
//! [`CardFilters::art_weight_floor`] switches on. No user text reaches the parser: even the
//! format key is looked up in [`crate::legalities`] and bound as the integer bit it names,
//! and a tag slug is bound even though it never leaves this app's own tag search.

use serde::Deserialize;

/// The five colour-identity letters, in WUBRG order. Interpolated into SQL, so it must
/// stay a hard-coded list.
pub const COLORS: [&str; 5] = ["W", "U", "B", "R", "G"];

/// Sets one request will filter on. The picker is a multi-select over ~1 050 sets; past a
/// few dozen the filter has stopped narrowing anything.
pub const MAX_SET_FILTER: usize = 64;

/// The last mana-value chip is open-ended: "8" means 8 *or more*.
pub const MANA_VALUE_OPEN_ENDED: u8 = 8;

/// The `LIKE` pattern that finds a **variable** mana cost — a printed `{X}` anywhere in
/// `cards.mana_cost`.
///
/// A `const` bound as a parameter rather than a fragment built inline, for two reasons and
/// both of them are traps. The braces are the first: every predicate in this module is
/// assembled with `format!`, and `'%{X}%'` written there is a *format placeholder named `X`*
/// that fails the build — `'%{{X}}%'` compiles and is then two escapes nobody can read. The
/// second is that a pattern with one home cannot drift from the [`crate::index`] bitset that
/// has to agree with it.
///
/// **`{X}` only, never `{Y}` or `{Z}`.** Those two exist — a handful of un-cards print them —
/// and they are deliberately not here, because the chip and the deck group this feeds are both
/// *named* X: filing `Apocalypse Chime`'s siblings under a heading that names a symbol they do
/// not have is a wrong label, not a loose one. `validation/engine.ts`'s `symbolValue` scores
/// all three as 0, which is the answer to *what is this worth* and not to *what is this pile
/// called*.
pub const VARIABLE_COST_LIKE: &str = "%{X}%";

/// One taxonomy's tag chips: the tags a row must carry, and the tags it must not.
///
/// **`include` INTERSECTS.** A themed deck asks for dogs AND snow, so each included slug gets a
/// **subquery of its own**, and the subqueries AND together. What is forbidden is folding them
/// into one — `… WHERE slug IN ('dog','snow')` is the *union*, and would answer a superset that
/// looks plausible. Note that the shipped predicate is itself an `IN`
/// (`illustration_id IN (SELECT … WHERE slug = ?)`) and that is not the same thing at all: the
/// `IN` is over *subject ids*, one slug is still bound per statement, and the count of
/// subqueries still equals the count of picked tags. **The invariant is one subquery per slug,
/// not the absence of the keyword.** `exclude` is a `NOT EXISTS` per slug, correlated rather
/// than listed, and the two lists AND with each other and with every other filter.
///
/// Both are `#[serde(default)]`, so a payload naming one list omits the other, and an absent
/// [`CardFilters::art_tags`] adds no SQL at all — see [`picked_tags`] for what a *blank* entry
/// means, which is the same thing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TagTerms {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

/// The [`CardFilters::art_weight_floor`] value that turns the floor **on**. Anything else —
/// absent, `"any"`, a word this build has not heard of — is no floor at all.
pub const ART_WEIGHT_FLOOR_STRONG: &str = "strong";

/// Every filter that is a statement about a *card*, as the UI sends it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CardFilters {
    /// Free text, prefix-matched through FTS5. Handled by the caller, because the join it
    /// needs is the caller's to make — see [`fts_query`].
    pub text: Option<String>,
    pub format: Option<String>,
    pub colors: Option<String>,
    pub set_code: Option<String>,
    /// Narrow to every printing of one oracle card — the card, not the cardboard.
    ///
    /// The exact-card filter the search has never had: `text` is FTS **prefix** matching, so
    /// a name query answers other cards too. Indexed for free by `idx_cards_oracle`, which
    /// `CARDS_INDEXES` has carried since schema v1.
    ///
    /// `cards.oracle_id` is NULLABLE and no live row is null, so this needs no null branch.
    pub oracle_id: Option<String>,
    pub sets: Option<Vec<String>>,
    pub mana_values: Option<Vec<u8>>,
    /// `Some(true)` also matches cards whose printed cost carries an `{X}`; `None` and
    /// `Some(false)` add nothing.
    ///
    /// **An overlay on the mana-value chips, never a replacement for one.** Scryfall counts X
    /// as 0 when it computes `cmc`, so `{X}{B}{B}{B}` is mana value 3 and stays mana value 3 —
    /// this filter joins the *same* OR group the chips do, so a request naming "3" and "X"
    /// returns that card once, from one row and one alternative, rather than twice.
    ///
    /// See [`VARIABLE_COST_LIKE`] for why the test is a `LIKE` over `{X}` alone.
    pub mana_x: Option<bool>,
    pub rarity: Option<String>,
    /// Omitted means true in the search and false in the collection: a search offers cards
    /// to own, a collection lists cards that are owned.
    pub paper_only: Option<bool>,
    /// Narrow to printings that are playable **somewhere** — `legal_mask != 0`.
    ///
    /// **Omitted means false**, unlike [`Self::paper_only`], so no caller that has not heard
    /// of this filter changes behaviour. The search view sends `true` and is the only thing
    /// that does; the collection and the wishlist list what the user owns and wants, and an
    /// art card in a binder is still in the binder.
    ///
    /// The mask is Scryfall's whole `legalities` object folded to one integer, so zero means
    /// "legal or restricted in none of the 23 formats" — art series, tokens, emblems,
    /// memorabilia, and the acorn half of the un-sets. It is a fact about the card rather
    /// than a layout guess, which is why this filter reads the mask and not `layout`.
    pub playable_only: Option<bool>,
    /// Scryfall art tags, matched against the **closure** on `cards.illustration_id` — what
    /// the picture shows, which is what a Tags-page deck is built around.
    pub art_tags: Option<TagTerms>,
    /// Scryfall oracle tags, matched against the **closure** on `cards.oracle_id` — what the
    /// card *does* (`removal`, `ramp`, `recursion`).
    pub oracle_tags: Option<TagTerms>,
    /// How strong an art match has to be: [`ART_WEIGHT_FLOOR_STRONG`] drops the closure rows
    /// Scryfall called `weak`, and anything else — absent, `"any"`, a word this build has not
    /// heard of — keeps them all. An unrecognised value therefore fails **open**, showing
    /// more rather than hiding cards nobody would report missing.
    ///
    /// Read through [`nonblank`], like every other string on this struct, so a padded
    /// ` "strong"` still floors rather than silently meaning "no floor".
    ///
    /// **The art side only, and the include side only.** `oracle_tag_cards` carries no
    /// `weight` column, so the oracle arm could not read a floor if it wanted one; and "not a
    /// dog" means not a dog at all, including weakly, so a floor on an *exclude* would let
    /// weak dogs back into a result the reader asked to have none in.
    pub art_weight_floor: Option<String>,
}

/// SQL fragments and the parameters they bound, in push order.
#[derive(Default)]
pub struct Predicates {
    pub wheres: Vec<String>,
    pub params: Vec<Box<dyn rusqlite::ToSql>>,
}

impl Predicates {
    /// The `WHERE` body. `1=1` rather than an empty string so callers can always write
    /// `WHERE {}` without a branch.
    pub fn where_sql(&self) -> String {
        if self.wheres.is_empty() {
            "1=1".to_owned()
        } else {
            self.wheres.join(" AND ")
        }
    }

    pub fn push(&mut self, sql: String, param: Box<dyn rusqlite::ToSql>) {
        self.wheres.push(sql);
        self.params.push(param);
    }
}

/// The FTS5 `MATCH` string for a user's text, or `None` when nothing indexable is left.
///
/// FTS5 has its own query language: `"`, `*`, `:`, `(`, `AND`/`OR`/`NOT` and `NEAR` are all
/// operators, and a stray one is a syntax *error*, not a zero-result search. Splitting on
/// everything non-alphanumeric leaves tokens that cannot contain an operator by
/// construction; quoting each makes it a literal phrase, and the trailing `*` is the one
/// operator kept, for prefix matching.
///
/// Splitting, not stripping: the index is built by `unicode61`, which breaks on the same
/// boundaries. Deleting punctuation inside a word would weld its halves into a token
/// nothing indexes — `Ajani's` → `ajanis`, `God-Pharaoh` → `godpharaoh`.
pub fn fts_query(text: &str) -> Option<String> {
    let toks: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!toks.is_empty()).then(|| toks.join(" "))
}

/// The `ESCAPE` character for a `LIKE` pattern built from a user's text.
///
/// A backslash, and interpolated into SQL as a literal — which is safe because it is this
/// constant and never anything a caller sends. Every character it protects is escaped by
/// [`escape_like`], itself included.
pub const LIKE_ESCAPE: char = '\\';

/// A user's text as a `LIKE` pattern that means exactly what it says.
///
/// `LIKE`'s wildcards are ordinary characters in a search box: somebody who types `%` means
/// the per-cent sign, and `_` is one keystroke from the `-` in half the card names in Magic
/// (`God-Pharaoh`). Unescaped, either turns a filter into a filter that does not filter —
/// the failure nobody reports, because a list showing too much still looks like a list.
///
/// Lives here rather than beside its one caller because it is the escaping half of a
/// contract whose other half is SQL, and the next `LIKE` this app grows must not invent a
/// second one. Pair it with `ESCAPE '{LIKE_ESCAPE}'` in the pattern's clause; the pattern
/// itself is always bound, never interpolated.
///
/// The escape character goes first: doing it last would escape the backslashes the other
/// two arms had just introduced, and `%` would come back out as a literal `\` followed by a
/// wildcard.
pub fn escape_like(text: &str) -> String {
    text.replace(LIKE_ESCAPE, &format!("{LIKE_ESCAPE}{LIKE_ESCAPE}"))
        .replace('%', &format!("{LIKE_ESCAPE}%"))
        .replace('_', &format!("{LIKE_ESCAPE}_"))
}

/// Push every non-text card predicate onto `p`, qualified with `alias`.
///
/// `rows` names the table that carries the *denormalised* printing beside its soft card
/// reference — `Some("e")` for the collection's `collection_entries`, `None` for the search,
/// which reads `cards` and nothing else. It changes exactly one filter, and the asymmetry is
/// the point:
///
/// * **Set code** is a statement the row itself can answer. The collection copies
///   `set_code` onto the entry at write time precisely so a row stays identifiable after
///   its printing leaves `cards` (spec §6), and the list *shows* that value. A row
///   displayed as `lea` that vanished when the reader filtered to `lea` would be the
///   filter contradicting the column beside it.
/// * **Format, colours, rarity and mana value** are claims only a card row can answer.
///   There is nowhere to read them from for an orphan, and inventing an answer would be a
///   claim about a printing that is gone — so those stay `{alias}.…`, and an orphan simply
///   fails them.
pub fn push_card_filters(p: &mut Predicates, f: &CardFilters, alias: &str, rows: Option<&str>) {
    // The one column with two places to read it from. See the doc comment above.
    let set_code = match rows {
        Some(rows) => format!("coalesce({alias}.set_code, {rows}.set_code)"),
        None => format!("{alias}.set_code"),
    };

    // **The mask, not `json_extract`.** A JSON path cannot be indexed, so the old form
    // knocked the collapsed browse's scan off `idx_cards_collapse` and into a row lookup per
    // card: 591 ms against 40.6 ms through the mask, measured 2026-08-11 with the widened
    // index in place — timed through `node:sqlite` against a page-for-page online backup of
    // the live database, so the build these name is SQLite's own C rather than a cargo
    // profile. [`crate::legalities`] exists for this.
    //
    // `restricted` still counts as playable — that lives in the mask now rather than in this
    // SQL, which is why the predicate no longer says so.
    //
    // A key this build has never heard of matches nothing, which is what the old form did
    // too: `json_extract` of an absent key is NULL and `NULL IN (…)` is NULL. Spelled `0`
    // rather than left out, because leaving it out would turn an unknown format into "no
    // filter at all" and quietly return the whole corpus.
    //
    // An orphan fails this exactly as it failed the old form: the collection's LEFT JOIN
    // gives it a NULL alias, and `NULL & ? != 0` is NULL. The column is `NOT NULL DEFAULT 0`
    // so that a *card* row can never be the NULL here — a mask nobody filled would drop its
    // printing out of every format search silently, reading as nothing rather than as "legal
    // nowhere".
    if let Some(v) = nonblank(&f.format) {
        match crate::legalities::bit(v) {
            Some(b) => p.push(format!("({alias}.legal_mask & ?) != 0"), Box::new(b as i64)),
            None => p.wheres.push("0".to_owned()),
        }
    }

    // Subset semantics, as in a deckbuilder: show what this identity can *cast*, so "RW"
    // returns mono-R, mono-W, RW — and colourless, which fits in any deck. Expressed as
    // exclusions so the number of clauses stays fixed and each one is a plain `instr`.
    if let Some(colors) = nonblank(&f.colors) {
        let colors = colors.to_ascii_uppercase();
        if colors == "C" {
            p.wheres.push(format!(
                "({alias}.color_identity = '' OR {alias}.color_identity IS NULL)"
            ));
        } else {
            for ch in COLORS {
                if !colors.contains(ch) {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') = 0"
                    ));
                }
            }
        }
    }

    if let Some(s) = nonblank(&f.set_code) {
        p.push(format!("{set_code} = ?"), Box::new(s.to_owned()));
    }

    // `{alias}.oracle_id`, not a bare `c.`: this function is alias-parameterized for the
    // collection's joined query too, and the id is a claim only a card row can answer — the
    // same reasoning as the format, colour, rarity and mana-value arms, none of which fall
    // back to `rows` either.
    //
    // `nonblank`, like every other string filter in this function (`set_code` two lines up,
    // `format`, `colors`, `rarity` below): a cleared control sends `Some("")`, and taken
    // literally that binds `oracle_id = ''`, which matches nothing — the search's own
    // `useCardSearch` clears this filter to exactly `""` on `resetAll`, so a blank reaches
    // here for real. Skipping `nonblank` would fail *closed*, an empty wall with no filter
    // chip drawn to explain it — the opposite of every neighbouring arm.
    if let Some(oracle_id) = nonblank(&f.oracle_id) {
        p.push(
            format!("{alias}.oracle_id = ?"),
            Box::new(oracle_id.to_owned()),
        );
    }

    // OR within, AND without. Blank entries are dropped rather than matched: a picker's
    // cleared state sends `[]`, and some send `[""]`.
    if let Some(sets) = f.sets.as_deref() {
        let picked = picked_sets(sets);
        if !picked.is_empty() {
            let holes = vec!["?"; picked.len()].join(",");
            p.wheres.push(format!("{set_code} IN ({holes})"));
            for code in picked {
                p.params.push(Box::new(code));
            }
        }
    }

    // Discrete chips, not a range: 0–7 are exact and 8 is open-ended. `cmc` is REAL and
    // nullable, and the two halves treat a fraction differently — **below 8 it matches no
    // chip** (exact float equality against 0.0–7.0, so 0.5 is nobody's), while **at or above
    // 8 it does**, because the open-ended arm below is `cmc >= 8.0` and 8.5 satisfies it. A
    // card with no cost at all matches nothing either way: `NULL IN (…)` and `NULL >= 8` are
    // both NULL. `index/mod.rs`'s mana buckets mirror exactly this split and cite this
    // function for it.
    //
    // Deduplicated first: a payload that repeats a chip would otherwise generate a
    // placeholder per repeat, which is a longer statement for the same answer (carryover
    // fold: "manaValues dedupe").
    //
    // **The X chip is one more alternative in this same group, and that is the whole design.**
    // It is *additive, never exclusive*: an X card keeps whatever `cmc` chip it already
    // matched (Scryfall scores X as 0, so `{X}{B}{B}{B}` is and stays mana value 3), so a
    // payload naming both "3" and "X" describes one row through two alternatives of one OR —
    // one predicate, one match, no duplicate. Pushed as a separate `AND` term it would have
    // meant "3 *and* variable", which is the intersection nobody asked for.
    let mut alternatives: Vec<String> = Vec::new();
    if let Some(values) = f.mana_values.as_deref() {
        let mut exact: Vec<f64> = Vec::new();
        let mut open_ended = false;
        let mut seen: Vec<u8> = Vec::new();
        for v in values {
            if seen.contains(v) {
                continue;
            }
            seen.push(*v);
            if *v >= MANA_VALUE_OPEN_ENDED {
                open_ended = true;
            } else {
                exact.push(f64::from(*v));
            }
        }
        if !exact.is_empty() {
            let holes = vec!["?"; exact.len()].join(",");
            alternatives.push(format!("{alias}.cmc IN ({holes})"));
            for v in exact {
                p.params.push(Box::new(v));
            }
        }
        if open_ended {
            alternatives.push(format!("{alias}.cmc >= {MANA_VALUE_OPEN_ENDED}.0"));
        }
    }
    // `{alias}.mana_cost` with no `rows` fallback, unlike the set code above: a printed cost is
    // a statement only a card row can make, and an orphaned entry has none — so it fails this
    // exactly as it fails the format, colour and mana-value arms. `NULL LIKE ?` is NULL.
    //
    // Bound, not interpolated, and the pattern is [`VARIABLE_COST_LIKE`]; no `ESCAPE` clause,
    // because that constant is ours and contains neither `%` nor `_`.
    if f.mana_x.unwrap_or(false) {
        alternatives.push(format!("{alias}.mana_cost LIKE ?"));
        p.params.push(Box::new(VARIABLE_COST_LIKE));
    }
    if !alternatives.is_empty() {
        p.wheres.push(format!("({})", alternatives.join(" OR ")));
    }

    if let Some(r) = nonblank(&f.rarity) {
        p.push(format!("{alias}.rarity = ?"), Box::new(r.to_owned()));
    }
    if f.paper_only.unwrap_or(true) {
        p.wheres.push(format!("{alias}.is_paper = 1"));
    }

    // Playable **somewhere**, which is the one question the whole mask answers at once: a
    // format filter tests one bit, this tests whether any is set. No parameter, because there
    // is nothing to bind — the constant is `0`.
    //
    // `legal_mask` is in `idx_cards_collapse` for the format filter's sake, so this rides the
    // same covering scan rather than knocking the collapsed browse into row lookups. It is
    // also why the filter is not `layout NOT IN (…)`: `layout` is in no index, and a layout
    // list would have to be kept in step with Scryfall's by hand while the mask is computed
    // from the card's own legalities on every sync.
    //
    // An orphan fails it, exactly as it fails the format filter: the collection's LEFT JOIN
    // gives it a NULL alias and `NULL != 0` is NULL. The column is `NOT NULL DEFAULT 0` so a
    // *card* row can never be that NULL.
    if f.playable_only.unwrap_or(false) {
        p.wheres.push(format!("{alias}.legal_mask != 0"));
    }

    // Tag terms. **One subquery per included tag, because includes INTERSECT**: a themed deck
    // asks for dogs AND snow, and folding them into one `… WHERE slug IN ('dog','snow')` is the
    // union — a superset that looks plausible and is never reported. The predicate below *is*
    // an `IN`, and that is not the forbidden shape: it lists **subject ids**, binds one slug,
    // and there is still exactly one of them per picked tag. Excludes are one correlated
    // `NOT EXISTS` per tag, and every term ANDs with every other filter here.
    //
    // **Against the CLOSURE tables, never the taggings.** The bulk file stores direct
    // taggings only and a category tag has none of its own: `dog` is directly tagged on 137
    // illustrations and reaches 439, and `removal` has zero direct taggings while answering
    // 6 686 cards — the two figures `crate::tags::query`'s module note measured on 2026-08-20,
    // and it counts over the closure for this same reason. A predicate over `art_taggings`
    // would answer 137 of those 439 dogs and none of the removal, which looks like a data
    // problem rather than a query one.
    //
    // **`{alias}.illustration_id` is NULLABLE and needs no null branch**: `NULL IN (…)` over a
    // list that cannot contain NULL is NULL and never true, so a printing without one matches no
    // art tag — and `NOT EXISTS` keeps it under every exclude. 4 977 of 116 712 live printings
    // are in that state, against 0 with a NULL `oracle_id` (measured 2026-08-20 against the dev
    // database). **That asymmetry is why the two arms are two shapes**: swapping the exclude to
    // `NOT IN` would turn its NULL into "no" and quietly drop those 4 977 printings from a
    // result the reader only asked to have no dogs in.
    //
    // **An include is `IN (SELECT …)` and not a correlated `EXISTS`, and on a narrow motif the
    // difference is two orders of magnitude.** Both are correct; only one is a plan. `EXISTS`
    // correlates on `illustration_id`, so the slug is constant and the *card* varies — SQLite
    // scans the whole `cards` table and probes the closure once per row, and a floored probe
    // loses `idx_art_tag_illustrations_slug` (no `weight` in it) and falls back to random seeks
    // into a 952 729-row `WITHOUT ROWID` primary key. `IN` inverts it: the closure is read
    // **once** for the slug and `cards` is driven through `idx_cards_illustration`.
    //
    // Measured 2026-08-20 against the real art taxonomy (952 729 closure rows), through
    // `node:sqlite` against the dev database rather than through the app, so these are SQLite's
    // own numbers and carry no debug-build multiplier. The statement is the collapsed count
    // `search.rs` really runs, best of three:
    //
    //     slug     floor   EXISTS            IN
    //     dog      any       315 ms          8 ms
    //     dog      strong    882–1 147 ms    8 ms
    //     plane    any       722–782 ms      614 ms
    //     plane    strong  1 177–1 319 ms    752 ms
    //
    // **The gain is a function of how wide the motif is**, which the table says and a headline
    // figure would hide: `dog` reaches 439 illustrations and goes 39x/110x, `plane` reaches
    // 38 144 and goes 1.2x/1.7x, because a wide slug's list is tens of thousands of ids to
    // materialise. The floored column is the point either way: under `EXISTS` the weight floor
    // cost **1.7–3.6x** and looked like it wanted a `(slug, weight)` index (it does not — forced,
    // that index is *ten times worse* than the status quo, because it can only seek the slug and
    // must then scan the whole bucket; `index/facets.rs` carries the refutation in full). Under
    // `IN` the floor is free, and no migration rung is owed.
    //
    // **One trade-off nobody has to accept but everybody should know about.** On a request with
    // *both* a text term and a tag term, the planner now has a second driver to choose from and
    // may drive from the tag list rather than from FTS. That is usually right — a tag list is
    // often the smaller set — but it is a plan this shape did not previously permit. Measured on
    // the same pass, a text-only search moved 12 ms -> 16 ms, i.e. within noise and not a
    // regression; a text-plus-tag request has not been measured at real breadth.
    //
    // **No `rows` fallback**, unlike the set code above: a tag is a claim only a card row can
    // answer, so an orphaned collection or wishlist entry fails it exactly as it fails the
    // format, colour, rarity and mana-value arms.
    //
    // The subquery aliases are `ati`/`otc` rather than the obvious `a`/`o`, and the
    // `debug_assert` below is what makes that structural rather than a convention. SQLite
    // resolves a qualified name against the innermost `FROM` first, so an inner alias equal to
    // `{alias}` shadows the outer table — which the exclude arm is still correlated by, and
    // `a.illustration_id = a.illustration_id` is no longer a correlation at all: the
    // `NOT EXISTS` degenerates to "does no row with this slug exist anywhere", which is false for
    // every card at once and empties the result silently. All three production callers pass
    // `"c"` (`search.rs`, `collection.rs`, `wishlist.rs`), so a fourth one is the only way in and
    // nothing else in the suite would go red for it.
    debug_assert!(
        alias != "ati" && alias != "otc",
        "a caller alias equal to a subquery alias uncorrelates the NOT EXISTS and answers about the whole closure instead of about this card"
    );
    if let Some(t) = &f.art_tags {
        // `<> 'weak'` rather than a list of the weights above it, so a fifth weight Scryfall
        // adds is kept rather than silently hidden. The bare literal is coupled to
        // `crate::tags::WEIGHTS[0]` by convention only — a shared constant for one SQL word is
        // more indirection than the coupling costs, but a rename of `"weak"` there would
        // disable this floor in silence, and
        // `tests::the_weight_floor_drops_only_weak_closure_rows` is what fails loudly.
        //
        // The floor reads `ati.weight`, which is the **closure's** resolved weight — folded by
        // `tags::write_closure` to the strongest tagging the row descends from. A card weak
        // under `dog` but strong under `hound` therefore survives under both slugs, because it
        // is genuinely a strong match for the motif; per-tagging weights would put the same
        // card in one view of one hierarchy and out of the other.
        let floor = if nonblank(&f.art_weight_floor) == Some(ART_WEIGHT_FLOOR_STRONG) {
            " AND ati.weight <> 'weak'"
        } else {
            ""
        };
        for slug in picked_tags(&t.include) {
            p.push(
                format!("{alias}.illustration_id IN (SELECT ati.illustration_id FROM art_tag_illustrations ati WHERE ati.slug = ?{floor})"),
                Box::new(slug),
            );
        }
        // **The exclude arm ignores the floor, deliberately**: "not a dog" means not a dog at
        // all, including weakly. A floor here would let weak dogs back into a result the
        // reader asked to have none in.
        for slug in picked_tags(&t.exclude) {
            p.push(
                format!("NOT EXISTS (SELECT 1 FROM art_tag_illustrations ati WHERE ati.illustration_id = {alias}.illustration_id AND ati.slug = ?)"),
                Box::new(slug),
            );
        }
    }

    // The oracle twin, on `oracle_tag_cards` / `{alias}.oracle_id` and **with no weight
    // clause**: that closure has no `weight` column, so a copied floor is a `no such column`
    // error rather than a wrong answer. It would have nothing to say either way — oracle
    // taggings are 99.7 % `median`, and `strong` occurs once in the whole file.
    if let Some(t) = &f.oracle_tags {
        for slug in picked_tags(&t.include) {
            p.push(
                format!("{alias}.oracle_id IN (SELECT otc.oracle_id FROM oracle_tag_cards otc WHERE otc.slug = ?)"),
                Box::new(slug),
            );
        }
        for slug in picked_tags(&t.exclude) {
            p.push(
                format!("NOT EXISTS (SELECT 1 FROM oracle_tag_cards otc WHERE otc.oracle_id = {alias}.oracle_id AND otc.slug = ?)"),
                Box::new(slug),
            );
        }
    }
}

/// The set codes a request really filters on: trimmed, lower-cased, blanks dropped, sorted,
/// deduplicated and capped at [`MAX_SET_FILTER`].
///
/// **An empty answer means "no set filter", never "match nothing".** A picker's cleared
/// state sends `[]` and some send `[""]`, and either taken literally would be `IN ()` — a
/// syntax error in SQLite and an empty result set anywhere else.
///
/// A function rather than eight lines inside [`push_card_filters`], because
/// [`crate::index::facets`] has to narrow by *exactly* this list: a facet counted over 70
/// picked sets while the search returns the 64 this cap leaves would report options as live
/// that the search cannot reach. Two copies of a normalisation that must agree will not.
pub fn picked_sets(sets: &[String]) -> Vec<String> {
    let mut picked: Vec<String> = sets
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    picked.sort();
    picked.dedup();
    picked.truncate(MAX_SET_FILTER);
    picked
}

/// The tag slugs a request really filters on: trimmed, blanks dropped, sorted and
/// deduplicated.
///
/// **An empty answer means "no tag filter", never "match nothing"** — [`picked_sets`]'s rule,
/// for [`nonblank`]'s reason: a cleared chip row sends `[]` and some send `[""]`, and a blank
/// taken literally would bind `slug = ''`, which matches nothing and fails *closed*. An empty
/// wall with no chip drawn to explain it is the opposite of what every other arm of
/// [`push_card_filters`] does with a cleared control.
///
/// A function rather than four lines inside that loop, because [`crate::index::facets`] has to
/// narrow by *exactly* this list — the argument [`picked_sets`] makes and the trap it was
/// extracted to avoid: two copies of a normalisation that must agree will not, and a facet
/// counted over a slug the search dropped reports options as live that the search cannot
/// reach.
///
/// **Not lower-cased**, unlike [`picked_sets`]. A slug arrives here from the tag search's own
/// results rather than from a reader's keyboard; `tags::query` is where typed text is matched,
/// against `slug_norm` and never against `slug`. Case-folding here would quietly make `slug` a
/// case-insensitive column in one place and an exact one everywhere else.
pub fn picked_tags(slugs: &[String]) -> Vec<String> {
    let mut picked: Vec<String> = slugs
        .iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    picked.sort();
    picked.dedup();
    picked
}

/// A filter the user actually set: trimmed, and `None` when blank.
///
/// A UI whose "Any set"/"Any format" option carries an empty value sends `Some("")`. Taken
/// literally that would mean `set_code = ''` (matches nothing) or a format no build has a
/// bit for, which the arm above spells `0` — an empty list where the user asked for every
/// card. Before the mask it was worse: the json path `'$.'` is a *SQLite error*, failing the
/// whole query rather than one filter.
pub fn nonblank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The filter has to reach the index, and it cannot while it parses JSON per row.
    /// Measured 2026-08-11 with the widened `idx_cards_collapse` in place: 40.6 ms through
    /// the mask against 591 ms through `json_extract` — through `node:sqlite` against a
    /// page-for-page online backup of the live database, so the build named is SQLite's own
    /// and not a cargo profile (see [`super::push_card_filters`]).
    ///
    /// The only test here that reads the SQL rather than an answer, because the shape *is*
    /// the claim: what the filter matches is identical either way, and that is exactly why
    /// a results test cannot tell whether the query can use the index. The three behaviours
    /// that must *survive* the rewrite are pinned where they can be asked of a real query:
    /// `search::tests::format_filter_includes_restricted`,
    /// `search::tests::a_format_the_build_does_not_know_matches_nothing`, and the format arm
    /// of the collection's orphan test.
    #[test]
    fn the_format_filter_tests_the_mask_rather_than_parsing_json() {
        let mut p = Predicates::default();
        let f = CardFilters {
            format: Some("modern".into()),
            ..Default::default()
        };
        push_card_filters(&mut p, &f, "c", None);
        let sql = p.where_sql();
        assert!(sql.contains("legal_mask"), "{sql}");
        assert!(!sql.contains("json_extract"), "{sql}");
    }

    /// `playable_only` is the one filter here whose omission means **off**, and the asymmetry
    /// with `paper_only` two lines above it is exactly what a reader would get wrong. Every
    /// caller but the search view omits it, so a default of `true` would silently drop the
    /// art cards out of a collection someone owns them in — a list showing too little, which
    /// is the failure nobody reports either.
    #[test]
    fn playable_only_is_off_unless_it_is_asked_for() {
        let sql = |f: CardFilters| {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            p.where_sql()
        };

        assert!(
            !sql(CardFilters::default()).contains("legal_mask"),
            "omitted means no clause at all"
        );
        assert!(!sql(CardFilters {
            playable_only: Some(false),
            ..Default::default()
        })
        .contains("legal_mask"));

        let on = sql(CardFilters {
            playable_only: Some(true),
            ..Default::default()
        });
        assert!(on.contains("c.legal_mask != 0"), "{on}");
    }

    /// The X chip is an **alternative inside the mana group**, not a term beside it — which is
    /// the difference between "mana value 2 or variable" and "mana value 2 *and* variable",
    /// and the second of those is empty for most of the corpus.
    ///
    /// Read off the SQL rather than off an answer, for the reason the mask test above is: the
    /// two shapes differ in one character (`OR` against `AND`) and a fixture small enough to
    /// tell them apart is a fixture that proves nothing else. The behaviour they produce is
    /// pinned where it can be asked of a real query —
    /// `search::tests::the_x_chip_matches_a_variable_cost_and_ors_with_the_value_chips`.
    #[test]
    fn the_x_test_joins_the_mana_values_own_or_group() {
        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                mana_values: Some(vec![2]),
                mana_x: Some(true),
                ..Default::default()
            },
            "c",
            None,
        );

        let mana: Vec<&String> = p.wheres.iter().filter(|w| w.contains("mana_")).collect();
        assert_eq!(mana.len(), 1, "one group, not two AND terms: {mana:?}");
        assert_eq!(
            mana[0], "(c.cmc IN (?) OR c.mana_cost LIKE ?)",
            "the chip and the X test are alternatives of each other"
        );
        // Push order is the binding order, and `?` binds by position: the chip's value first
        // because its fragment is first.
        assert_eq!(p.params.len(), 2);

        // No `rows` fallback on the cost, whatever alias the caller passes for its own table —
        // a printed cost is a claim only a card row can make, so an orphan fails it.
        let mut joined = Predicates::default();
        push_card_filters(
            &mut joined,
            &CardFilters {
                mana_x: Some(true),
                ..Default::default()
            },
            "c",
            Some("e"),
        );
        assert!(
            joined.wheres.iter().any(|w| w == "(c.mana_cost LIKE ?)"),
            "{:?}",
            joined.wheres
        );
    }

    /// `manaX` is omitted-means-**off**, like [`CardFilters::playable_only`] and unlike
    /// `paper_only`: every list that has never heard of this chip must keep the rows it had.
    /// And with the chip on alone it is still one group, so it narrows on its own rather than
    /// needing a mana value beside it.
    #[test]
    fn mana_x_adds_nothing_unless_it_is_asked_for() {
        let sql = |f: CardFilters| {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            p.where_sql()
        };

        assert!(!sql(CardFilters::default()).contains("mana_cost"));
        assert!(!sql(CardFilters {
            mana_x: Some(false),
            mana_values: Some(vec![2]),
            ..Default::default()
        })
        .contains("mana_cost"));

        let alone = sql(CardFilters {
            mana_x: Some(true),
            ..Default::default()
        });
        assert!(alone.contains("(c.mana_cost LIKE ?)"), "{alone}");
    }

    /// The pattern is a `const` and it is bound, so the braces never meet `format!` — which is
    /// the build error this constant exists to make unreachable. `{Y}` and `{Z}` are
    /// deliberately outside it: the chip is *named* X, and those un-cards do not have one.
    #[test]
    fn the_variable_cost_pattern_matches_x_and_not_its_two_siblings() {
        assert_eq!(VARIABLE_COST_LIKE, "%{X}%");

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let matches = |cost: &str| {
            conn.query_row(
                "SELECT ?1 LIKE ?2",
                rusqlite::params![cost, VARIABLE_COST_LIKE],
                |r| r.get::<_, bool>(0),
            )
            .unwrap()
        };
        assert!(matches("{X}{B}{B}{B}"));
        assert!(matches("{2}{X}"));
        assert!(!matches("{2}{W}{W}"));
        assert!(!matches("{Y}"), "Apocalypse Chime's siblings are not X");
        assert!(!matches("{Z}"));
    }

    // ---------------------------------------------------------------------------------
    // Tag terms
    // ---------------------------------------------------------------------------------

    fn owned(slugs: &[&str]) -> Vec<String> {
        slugs.iter().map(|s| (*s).to_owned()).collect()
    }

    fn no_filters() -> CardFilters {
        CardFilters::default()
    }

    fn art_include(slugs: &[&str]) -> CardFilters {
        CardFilters {
            art_tags: Some(TagTerms {
                include: owned(slugs),
                exclude: Vec::new(),
            }),
            ..Default::default()
        }
    }

    fn art_exclude(slugs: &[&str]) -> CardFilters {
        CardFilters {
            art_tags: Some(TagTerms {
                include: Vec::new(),
                exclude: owned(slugs),
            }),
            ..Default::default()
        }
    }

    fn oracle_include(slugs: &[&str]) -> CardFilters {
        CardFilters {
            oracle_tags: Some(TagTerms {
                include: owned(slugs),
                exclude: Vec::new(),
            }),
            ..Default::default()
        }
    }

    fn oracle_exclude(slugs: &[&str]) -> CardFilters {
        CardFilters {
            oracle_tags: Some(TagTerms {
                include: Vec::new(),
                exclude: owned(slugs),
            }),
            ..Default::default()
        }
    }

    impl CardFilters {
        fn with_floor(mut self, floor: &str) -> Self {
            self.art_weight_floor = Some(floor.to_owned());
            self
        }

        fn and_oracle_include(mut self, slugs: &[&str]) -> Self {
            self.oracle_tags = Some(TagTerms {
                include: owned(slugs),
                exclude: Vec::new(),
            });
            self
        }
    }

    /// Six printings and both closures over them — small enough to name every row, and built
    /// so each of the three ways this predicate can be wrong returns a *different* list
    /// rather than a plausible one:
    ///
    /// * **`illus-a` has no direct `dog` tagging at all.** Its `dog` closure row descends from
    ///   `hound`. A predicate over `art_taggings` loses `card-a` and keeps the other three
    ///   dogs, which reads as a data problem rather than a query one.
    /// * **`illus-promoted` is directly tagged `dog` weakly and `hound` strongly**, so the
    ///   closure resolves its `dog` weight to `strong`. A floor read off the taggings drops it
    ///   under `dog` while keeping it under `hound` — the same card in and out of two views of
    ///   one hierarchy.
    /// * **`card-null` has no `illustration_id`** — 4 977 of 116 712 live printings, measured
    ///   2026-08-20 against the dev database. It still carries an `oracle_id` (0 of 116 712
    ///   are NULL, same measurement), so it answers oracle tags while answering no art tag,
    ///   and its absence from an art result is the join rather than a missing row.
    ///
    /// `art_taggings` is seeded although nothing in this module reads it: it is what the
    /// wrong table *would* have answered, and without it the closure tests would pass over a
    /// fixture where the two agree.
    #[rustfmt::skip]
    fn corpus_with_art_tags() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let cards = [
            ("card-a",        Some("illus-a"),        "oracle-a"),
            ("card-b",        Some("illus-b"),        "oracle-b"),
            ("card-cat",      Some("illus-cat"),      "oracle-cat"),
            ("card-null",     None,                   "oracle-null"),
            ("card-promoted", Some("illus-promoted"), "oracle-promoted"),
            ("card-weak",     Some("illus-weak"),     "oracle-weak"),
        ];
        for (id, illustration, oracle) in cards {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,illustration_id,oracle_id,search_text,raw)
                 VALUES (?1,?1,'tst','1','en','normal',1,?2,?3,?1,'{}')",
                rusqlite::params![id, illustration, oracle],
            ).unwrap();
        }
        // What the file said, directly. Note there is no ('illus-a','dog') row.
        let taggings = [
            ("illus-a",        "hound", "strong"),
            ("illus-a",        "snow",  "median"),
            ("illus-b",        "dog",   "median"),
            ("illus-cat",      "cat",   "strong"),
            ("illus-promoted", "dog",   "weak"),
            ("illus-promoted", "hound", "strong"),
            ("illus-weak",     "dog",   "weak"),
        ];
        for (illustration, slug, weight) in taggings {
            conn.execute(
                "INSERT INTO art_taggings (illustration_id,slug,weight) VALUES (?1,?2,?3)",
                rusqlite::params![illustration, slug, weight],
            ).unwrap();
        }
        // The closure `hound -> dog` resolved, with each row's weight folded to the strongest
        // tagging it descends from — the shape `tags::write_closure` produces.
        let closure = [
            ("illus-a",        "hound", "strong"),
            ("illus-a",        "dog",   "strong"),
            ("illus-a",        "snow",  "median"),
            ("illus-b",        "dog",   "median"),
            ("illus-cat",      "cat",   "strong"),
            ("illus-promoted", "hound", "strong"),
            ("illus-promoted", "dog",   "strong"),
            ("illus-weak",     "dog",   "weak"),
        ];
        for (illustration, slug, weight) in closure {
            conn.execute(
                "INSERT INTO art_tag_illustrations (illustration_id,slug,weight) VALUES (?1,?2,?3)",
                rusqlite::params![illustration, slug, weight],
            ).unwrap();
        }
        let oracle = [
            ("oracle-a",        "ramp"),
            ("oracle-a",        "acceleration"),
            ("oracle-a",        "removal"),
            ("oracle-b",        "ramp"),
            ("oracle-b",        "acceleration"),
            ("oracle-cat",      "removal"),
            ("oracle-null",     "ramp"),
            ("oracle-null",     "acceleration"),
            ("oracle-promoted", "removal"),
            ("oracle-weak",     "ramp"),
            ("oracle-weak",     "acceleration"),
        ];
        for (oracle_id, slug) in oracle {
            conn.execute(
                "INSERT INTO oracle_tag_cards (oracle_id,slug) VALUES (?1,?2)",
                rusqlite::params![oracle_id, slug],
            ).unwrap();
        }
        conn
    }

    /// The ids [`push_card_filters`] leaves standing, in id order — the search's own query
    /// shape (`cards c`, no `rows` table) with nothing but this module's predicates on it.
    fn search_ids(conn: &rusqlite::Connection, f: CardFilters) -> Vec<String> {
        let mut p = Predicates::default();
        push_card_filters(&mut p, &f, "c", None);
        let sql = format!(
            "SELECT c.id FROM cards c WHERE {} ORDER BY c.id",
            p.where_sql()
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(p.params.iter().map(|b| b.as_ref())),
                |r| r.get::<_, String>(0),
            )
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        rows
    }

    /// A card tagged only with a **child** answers a query for its **parent**. This is the
    /// whole feature: the closure is pre-flattened, so the predicate is a plain lookup — but
    /// a regression here reads as "the tag returns fewer cards than Scryfall", which looks
    /// like a data problem rather than a query one.
    #[test]
    fn an_art_tag_matches_through_the_closure() {
        let conn = corpus_with_art_tags();
        let direct: i64 = conn
            .query_row(
                "SELECT count(*) FROM art_taggings WHERE illustration_id = 'illus-a' AND slug = 'dog'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(direct, 0, "card-a's `dog` may exist only in the closure");

        assert_eq!(
            search_ids(&conn, art_include(&["dog"])),
            owned(&["card-a", "card-b", "card-promoted", "card-weak"]),
            "a predicate over `art_taggings` would drop card-a and keep the rest"
        );
        assert_eq!(
            search_ids(&conn, art_include(&["hound"])),
            owned(&["card-a", "card-promoted"])
        );
    }

    /// An exclude is the same subquery under `NOT EXISTS`, and a printing with no art is not
    /// a dog: `card-null` is *kept*, because the correlated lookup finds nothing for it.
    #[test]
    fn art_tag_excludes_are_not_exists() {
        let conn = corpus_with_art_tags();
        let ids = search_ids(&conn, art_exclude(&["dog"]));
        assert_eq!(ids, owned(&["card-cat", "card-null"]));
        assert!(!ids.contains(&"card-a".to_owned()));
    }

    /// **The exclude arm ignores the weight floor, deliberately.** "Not a dog" means not a dog
    /// at all, including weakly — a floor on this side would let `card-weak` back into a
    /// result the reader asked to have no dogs in.
    #[test]
    fn an_art_exclude_ignores_the_weight_floor() {
        let conn = corpus_with_art_tags();
        assert_eq!(
            search_ids(&conn, art_exclude(&["dog"]).with_floor("strong")),
            owned(&["card-cat", "card-null"]),
            "a weak dog is still a dog when the reader asked for none"
        );
    }

    /// Two includes intersect. A themed deck asks for dogs AND snow, not dogs OR snow —
    /// `slug IN ('dog','snow')` is the union and would answer all four dogs here, a superset
    /// that looks plausible.
    #[test]
    fn two_art_includes_intersect() {
        let conn = corpus_with_art_tags();
        assert_eq!(
            search_ids(&conn, art_include(&["dog", "snow"])),
            owned(&["card-a"])
        );
    }

    /// 4 977 of 116 712 printings have no `illustration_id` (measured 2026-08-20 against the
    /// dev database). `NULL = NULL` is not true in SQL so this needs no branch — but it is
    /// the silent half of the join, so it is tested, and tested against a row that is
    /// reachable by its oracle tags so its absence cannot be a missing fixture row.
    #[test]
    fn a_printing_with_no_illustration_id_matches_no_art_tag() {
        let conn = corpus_with_art_tags();
        assert!(search_ids(&conn, no_filters()).contains(&"card-null".to_owned()));
        assert!(!search_ids(&conn, art_include(&["dog"])).contains(&"card-null".to_owned()));
        assert!(search_ids(&conn, oracle_include(&["ramp"])).contains(&"card-null".to_owned()));
    }

    /// The floor reads the **closure's** resolved weight, not the direct tagging's.
    /// `card-promoted` is weak under a direct `dog` and strong under a direct `hound`, and it
    /// survives the floor under **both** slugs, because it is genuinely a strong match for the
    /// motif. Filtering per direct tagging would put the same card in one view of the
    /// hierarchy and out of the other.
    #[test]
    fn the_weight_floor_drops_only_weak_closure_rows() {
        let conn = corpus_with_art_tags();
        let all_dogs = owned(&["card-a", "card-b", "card-promoted", "card-weak"]);

        assert_eq!(
            search_ids(&conn, art_include(&["dog"]).with_floor("strong")),
            owned(&["card-a", "card-b", "card-promoted"]),
            "only the weak closure row goes; `median` is above the floor"
        );
        assert_eq!(
            search_ids(&conn, art_include(&["hound"]).with_floor("strong")),
            owned(&["card-a", "card-promoted"])
        );
        // Trimmed like every other string filter here: the only one that was not, until the
        // review caught it, was this one — and ` "strong"` would have meant no floor at all.
        assert_eq!(
            search_ids(&conn, art_include(&["dog"]).with_floor("  strong  ")),
            owned(&["card-a", "card-b", "card-promoted"])
        );

        // Anything that is not `strong` is no floor at all, which is the direction that shows
        // more rather than fewer: an unrecognised value must never hide cards silently.
        assert_eq!(
            search_ids(&conn, art_include(&["dog"]).with_floor("any")),
            all_dogs
        );
        assert_eq!(
            search_ids(&conn, art_include(&["dog"]).with_floor("")),
            all_dogs
        );
        assert_eq!(search_ids(&conn, art_include(&["dog"])), all_dogs);
    }

    /// Oracle tags are the same two arms over `oracle_tag_cards`, keyed on `oracle_id`.
    #[test]
    fn oracle_tags_intersect_and_exclude_through_their_own_closure() {
        let conn = corpus_with_art_tags();
        assert_eq!(
            search_ids(&conn, oracle_include(&["ramp"])),
            owned(&["card-a", "card-b", "card-null", "card-weak"])
        );
        assert_eq!(
            search_ids(&conn, oracle_include(&["ramp", "removal"])),
            owned(&["card-a"]),
            "an `IN` would have answered every tagged row"
        );
        assert_eq!(
            search_ids(&conn, oracle_exclude(&["ramp"])),
            owned(&["card-cat", "card-promoted"])
        );
    }

    /// **The floor is the art side's and only the art side's.** `oracle_tag_cards` has no
    /// `weight` column at all, so a weight clause copied onto that arm is not a wrong answer
    /// but a `no such column` error — which is why this asks for rows rather than for SQL.
    /// In a mixed query the two halves still AND: the floor narrows the art term and leaves
    /// the oracle term exactly as it was.
    #[test]
    fn a_mixed_query_floors_the_art_side_and_leaves_the_oracle_side_alone() {
        let conn = corpus_with_art_tags();
        assert_eq!(
            search_ids(&conn, oracle_include(&["ramp"]).with_floor("strong")),
            owned(&["card-a", "card-b", "card-null", "card-weak"]),
            "the floor may not reach `oracle_tag_cards`"
        );
        assert_eq!(
            search_ids(&conn, art_include(&["dog"]).and_oracle_include(&["ramp"])),
            owned(&["card-a", "card-b", "card-weak"])
        );
        assert_eq!(
            search_ids(
                &conn,
                art_include(&["dog"])
                    .and_oracle_include(&["ramp"])
                    .with_floor("strong")
            ),
            owned(&["card-a", "card-b"]),
            "card-weak loses the art term; card-null never had it"
        );
    }

    /// Absent means no filter, everywhere — the rule every other arm of
    /// [`push_card_filters`] follows. An empty include list must never become `IN ()`, and a
    /// cleared control's `""` must add **no predicate at all** rather than binding
    /// `slug = ''`, which matches nothing and fails *closed*: an empty wall with no chip drawn
    /// to explain it.
    #[test]
    fn empty_tag_terms_filter_nothing() {
        let conn = corpus_with_art_tags();
        let all = search_ids(&conn, no_filters());
        assert_eq!(all.len(), 6);

        assert_eq!(search_ids(&conn, art_include(&[])), all);
        assert_eq!(search_ids(&conn, art_include(&["", "  "])), all);
        assert_eq!(search_ids(&conn, art_exclude(&["", "  "])), all);
        assert_eq!(search_ids(&conn, oracle_include(&[])), all);
        assert_eq!(search_ids(&conn, oracle_exclude(&["  "])), all);
        assert_eq!(search_ids(&conn, no_filters().with_floor("strong")), all);

        for f in [
            no_filters(),
            no_filters().with_floor("strong"),
            art_include(&[]),
            art_include(&["  "]),
            oracle_include(&["  "]),
        ] {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            let sql = p.where_sql();
            assert!(!sql.contains("art_tag_illustrations"), "{sql}");
            assert!(!sql.contains("oracle_tag_cards"), "{sql}");
        }
    }

    /// Every slug is **bound**, the correlation follows the caller's alias, and `rows` changes
    /// nothing: a tag is a claim only a card row can answer, so an orphaned collection entry
    /// fails it exactly as it fails the format and rarity arms.
    ///
    /// Both callers pass `"c"` today, so a hard-coded `c.` inside these subqueries would work
    /// everywhere and fail nowhere — this test is the only thing that would notice.
    #[test]
    fn the_tag_subqueries_bind_every_slug_and_follow_the_alias() {
        let shape = |alias: &str, rows: Option<&str>| {
            let mut p = Predicates::default();
            push_card_filters(
                &mut p,
                &CardFilters {
                    art_tags: Some(TagTerms {
                        include: owned(&["dog", " dog ", "dog"]),
                        exclude: owned(&["snow"]),
                    }),
                    oracle_tags: Some(TagTerms {
                        include: owned(&["ramp"]),
                        exclude: owned(&["removal"]),
                    }),
                    ..Default::default()
                },
                alias,
                rows,
            );
            (p.where_sql(), p.params.len())
        };

        let (sql, params) = shape("x", None);
        for slug in ["dog", "snow", "ramp", "removal"] {
            assert!(!sql.contains(slug), "{slug} reached the SQL text: {sql}");
        }
        assert_eq!(
            params, 4,
            "trimmed and deduplicated: one parameter per distinct slug — {sql}"
        );
        assert!(sql.contains("x.illustration_id"), "{sql}");
        assert!(sql.contains("x.oracle_id"), "{sql}");
        assert_eq!(shape("x", Some("e")), (sql, params));
    }
}
