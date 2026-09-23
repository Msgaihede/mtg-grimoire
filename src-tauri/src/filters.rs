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

/// What one [`QueryPredicate`] is a statement about.
///
/// **[`Self::TypeLine`] and [`Self::OracleText`] ride in the same list as the other ten and
/// are emitted by [`fts_match`], never by [`push_card_filters`].** `LIKE` over either column
/// measured **80x to 250x** slower than the FTS5 column filter they take instead, on the real
/// corpus (spec §5.2), and a box that fires on a debounce cannot pay that. So the match in
/// `push_card_filters` names all twelve variants and has no `_` arm: **a field handled by
/// neither side is a filter that silently does nothing**, which is the one failure this split
/// can produce and the reason there is a test per side.
///
/// Closed, so the boundary is type-checked rather than stringly typed; the camelCase serde
/// names are the contract `src/lib/ipc.ts` mirrors and `ipc.test.ts` fences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PredicateField {
    TypeLine,
    OracleText,
    Keyword,
    Artist,
    Colors,
    ColorIdentity,
    Cmc,
    Power,
    Toughness,
    Rarity,
    SetCode,
    Format,
}

/// One [`QueryPredicate`]'s comparison.
///
/// **[`Self::Colon`] is Scryfall's `:` and means a different thing per field**, which is the
/// trap worth stating first: `c:rg` is `c>=rg` and answers 676 cards, while `id:rg` is
/// `id<=rg` and answers 13 399 (both measured on Scryfall, 2026-09-22). So it stays a variant
/// of its own and is resolved per field by [`default_op`] rather than folded into `Eq`
/// anywhere. The grammar in `src/features/search/queryLanguage.ts` resolves it at the edge for
/// every field but the four whose default really *is* `:`, so a `Colon` arriving on a numeric
/// field is a hand-built payload and is answered as that field's default rather than refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PredicateOp {
    Colon,
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

/// One term of a query box — `t:goblin`, `cmc>=3`, `-a:rebecca`.
///
/// **Parsed in TypeScript and never here.** `src/features/search/queryLanguage.ts` reads the
/// box into free text, tag tokens and a list of these; this crate receives closed enums and
/// emits SQL from them. Rust supplies facts and TypeScript draws conclusions, and a query
/// grammar is a conclusion — it is also the half that has to answer *while the reader is still
/// typing*, which is a question about a text box rather than about a database.
///
/// **One list on [`CardFilters`] rather than ten scalar fields**, because a list carries three
/// things no field can spell: negation, repetition (`t:creature t:goblin` is two terms and
/// both must hold) and an operator per term.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPredicate {
    pub field: PredicateField,
    pub op: PredicateOp,
    pub value: String,
    #[serde(default)]
    pub negated: bool,
}

/// Every filter that is a statement about a *card*, as the UI sends it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CardFilters {
    /// Free text, prefix-matched through FTS5. Handled by the caller, because the join it
    /// needs is the caller's to make — see [`fts_query`].
    pub text: Option<String>,
    pub format: Option<String>,
    pub colors: Option<String>,
    /// Read [`Self::colors`] as an **exact** identity rather than a subset: `"RW"` answers the
    /// RW cards alone, not mono-R, mono-W or the colourless cards that fit in any deck.
    ///
    /// **Degenerate for `"C"`, and deliberately not special-cased.** A `colors` of exactly
    /// `"C"` already means `color_identity = ''`, which is the strict reading of it — and the
    /// UI's `toggleColor` makes `C` exclusive both ways, so `"WC"` is unreachable.
    ///
    /// A `true` here with no [`Self::colors`] adds no SQL: the arm is inside the [`nonblank`]
    /// guard, matching a UI that does not draw the chip until a colour is picked.
    pub colors_strict: Option<bool>,
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
    /// Rarities to include, ORed with each other and ANDed with everything else — the search
    /// view's chip row, where picking `rare` and `mythic` means "either".
    ///
    /// **A field beside [`Self::rarity`] rather than a widening of it**, and the two are not
    /// the same question asked twice. That one is a *single* rarity and is what the printings
    /// modal's `<select>` sends; this is a multi-select, and a control that can pick two has
    /// to be able to pick none — which for a `Vec` is `[]`, a value the single field cannot
    /// spell. They AND with each other if a caller sends both, exactly as any two filters on
    /// this struct do; nothing in the app sends both today.
    pub rarities: Option<Vec<String>>,
    /// The card-type chips — [`crate::cardtypes::TYPE_KEYS`] entries. OR within, AND without,
    /// exactly like [`Self::rarities`].
    ///
    /// **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
    /// (`Land Creature — Forest Dryad`) answers both `Land` and `Creature` — which is what a
    /// filter means and what `autoCategory.ts`'s one-bucket rule deliberately does not.
    pub types: Option<Vec<String>>,
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
    /// The Scryfall-syntax terms a reader typed into the box, already parsed.
    ///
    /// **They AND with each other and with every other field on this struct**, and a repeated
    /// field is two terms rather than one overwriting the other — which is the whole reason
    /// this is a list. See [`QueryPredicate`].
    ///
    /// **Two of the twelve fields add no SQL here at all** and are picked up by [`fts_match`]
    /// instead; [`PredicateField`] says which and why.
    pub predicates: Option<Vec<QueryPredicate>>,
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

/// The FTS side of a parsed query: the positive `MATCH` string, and one `MATCH` string per
/// negated text term for a `rowid NOT IN (…)` subquery.
///
/// **Negatives are never folded into the `MATCH`.** FTS5's `NOT` is a *binary* operator, so
/// `-t:goblin` on its own has no left operand and is a syntax **error** rather than an empty
/// result. Splitting unconditionally — every negative into its own subquery, whether or not
/// there is a positive beside it — is uniform and cheaper to reason about than deciding per
/// query, and it costs one extra subquery on a query that could have carried a `NOT`.
///
/// `text` is `None` for the wishlist, whose free text is a `LIKE` over its own denormalised
/// `name` column so that an orphaned wish still answers a name search. Passing `q.cards.text`
/// there would search the corpus for a name the wish may be the only record of.
///
/// **A term whose value tokenises to nothing adds nothing, on either side.** `fts_query`
/// answers `None` for all-punctuation input, and the alternative — an empty `MATCH` — is a
/// syntax error for a positive and "exclude everything" for a negative.
///
/// The column is `type_line` for [`PredicateField::TypeLine`] and `search_text` for
/// [`PredicateField::OracleText`]. `search_text` is ~4 % wider than `cards.oracle_text`
/// (15 359 against 14 753 for `draw`) because it holds every face's name, type line and text —
/// and it is the right column anyway, because `cards.oracle_text` is NULL for every
/// double-faced card and the narrower column is wrong in a worse direction.
pub fn fts_match(text: Option<&str>, preds: &[QueryPredicate]) -> (Option<String>, Vec<String>) {
    let mut positive: Vec<String> = Vec::new();
    let mut negative: Vec<String> = Vec::new();

    if let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) {
        if let Some(query) = fts_query(text) {
            positive.push(query);
        }
    }

    for pred in preds {
        let column = match pred.field {
            PredicateField::TypeLine => "type_line",
            PredicateField::OracleText => "search_text",
            // Every other field is SQL, and `push_card_filters` is where it is emitted.
            _ => continue,
        };
        let Some(query) = fts_query(&pred.value) else {
            continue;
        };
        // FTS5's column filter, over the prefix-matched phrase list `fts_query` builds. The
        // parentheses are what make `type_line : ("a"* "b"*)` two terms *in that column*
        // rather than one term in it and one anywhere.
        let term = format!("{column} : ({query})");
        if pred.negated {
            negative.push(term);
        } else {
            positive.push(term);
        }
    }

    // **`AND` spelled out, never a space.** FTS5's implicit AND *is* a space between bare
    // phrases — but after a column filter a space is a syntax error, not a conjunction:
    // `type_line : (…) search_text : (…)` raises `fts5: syntax error near "search_text"`, and
    // so does free text followed by a filtered term. Measured against the real
    // 118,609-printing corpus on 2026-09-22; the spelled form answers 314 where both space
    // forms refuse to parse. A single term is unaffected either way, which is exactly why this
    // was invisible until the window ran `t:goblin o:haste`.
    (
        (!positive.is_empty()).then(|| positive.join(" AND ")),
        negative,
    )
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

    // Subset semantics by default, as in a deckbuilder: show what this identity can *cast*, so
    // "RW" returns mono-R, mono-W, RW — and colourless, which fits in any deck. Expressed as
    // exclusions so the number of clauses stays fixed and each one is a plain `instr`.
    //
    // **`colors_strict` adds the other half rather than replacing it**: an inclusion per picked
    // letter alongside the exclusion per unpicked one, so "RW" answers the RW cards alone. Five
    // `instr` clauses either way, which is what keeps the arm inside `idx_cards_collapse`'s
    // trailing `color_identity`.
    if let Some(colors) = nonblank(&f.colors) {
        let colors = colors.to_ascii_uppercase();
        let strict = f.colors_strict.unwrap_or(false);
        if colors == "C" {
            // Already exact, with or without `strict` — see `CardFilters::colors_strict`.
            p.wheres.push(format!(
                "({alias}.color_identity = '' OR {alias}.color_identity IS NULL)"
            ));
        } else {
            for ch in COLORS {
                if !colors.contains(ch) {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') = 0"
                    ));
                } else if strict {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') > 0"
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

    // OR within, AND without — [`picked_sets`]' shape, for [`picked_rarities`]' reason. A
    // cleared chip row sends `[]` and would otherwise bind `IN ()`, which is a syntax error in
    // SQLite; an empty list is therefore no filter at all rather than a filter matching nothing.
    //
    // `{alias}.rarity` with no `rows` fallback, like the format, colour and mana-value arms
    // above it: a rarity is a claim only a card row can make, so an orphaned collection entry
    // fails it — `NULL IN (…)` is NULL.
    if let Some(rarities) = f.rarities.as_deref() {
        let picked = picked_rarities(rarities);
        if !picked.is_empty() {
            let holes = vec!["?"; picked.len()].join(",");
            p.wheres.push(format!("{alias}.rarity IN ({holes})"));
            for r in picked {
                p.params.push(Box::new(r));
            }
        }
    }

    // One clause and one parameter, inside the covering index — the `format` arm's shape, and
    // the whole reason `type_mask` is a column rather than a `LIKE` on `type_line`.
    //
    // A list that names nothing this build knows masks to 0 and adds no SQL, which is
    // [`picked_rarities`]' rule: a cleared picker sends `[]`, and some send `[""]`.
    //
    // `{alias}.type_mask` with no `rows` fallback, like the format, colour, rarity and
    // mana-value arms: a type line is a claim only a card row can make, so an orphaned
    // collection entry fails it — `NULL & ? != 0` is NULL.
    if let Some(types) = f.types.as_deref() {
        let mask = crate::cardtypes::mask_of(&picked_types(types));
        if mask != 0 {
            p.push(
                format!("({alias}.type_mask & ?) != 0"),
                Box::new(i64::from(mask)),
            );
        }
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

    // The typed query terms, ANDed with each other and with everything above — `t:goblin
    // cmc>=3 -a:rebecca` is three of them and all three must hold.
    //
    // **Two of the twelve fields come out of here as nothing at all**, because the FTS builder
    // owns them; [`predicate_clause`] returns `None` for those and [`PredicateField`] says
    // why. Every other `None` it can answer is a blank value, which is [`nonblank`]'s rule
    // one shape along: a term with nothing after its operator is no filter, never a filter
    // matching nothing.
    //
    // `wheres` and `params` are pushed together per predicate rather than through
    // [`Predicates::push`], because several arms bind more than one parameter (the keyword
    // bridge binds two, an ordered rarity binds up to four) and `?` binds by position.
    for pred in f.predicates.iter().flatten() {
        if let Some((sql, params)) = predicate_clause(pred, alias, &set_code) {
            p.wheres.push(sql);
            p.params.extend(params);
        }
    }
}

/// A clause that is syntactically a predicate and matches no row, for the values that name
/// nothing this build knows — an unrecognised format, a rarity outside the ordered four, a
/// mana value that is not a number.
///
/// Spelled `0` rather than "push no clause at all", which is the choice the format arm of
/// [`push_card_filters`] made first and for the same reason: leaving it out turns an unknown
/// term into *no filter* and quietly returns the whole corpus, which is a search that answers
/// more than it was asked and says nothing about it.
const NO_MATCH: &str = "0";

/// The rarities `cards.rarity` can be compared *in order*, weakest first.
///
/// Measured on Scryfall 2026-09-22: `r>=rare` answers 13 951 and `r:rare` answers 11 856, so
/// rarity is an enum with an order and `:` on it is **equality**, not "at least". Scryfall's
/// `special` and `bonus` are deliberately absent: they have no place in this ladder, so an
/// ordered operator naming one answers [`NO_MATCH`] while `r:special` still works as equality.
const RARITY_ORDER: [&str; 4] = ["common", "uncommon", "rare", "mythic"];

/// What `:` means on a given field.
///
/// The one-line version of [`PredicateOp`]'s note: `c:rg` is `c>=rg` and `id:rg` is `id<=rg`,
/// so a single rule for `:` would get one of the two wrong by a factor of twenty. The four
/// fields whose default really is `:` return it unchanged and are matched by their own arms.
fn default_op(field: PredicateField) -> PredicateOp {
    match field {
        PredicateField::TypeLine
        | PredicateField::OracleText
        | PredicateField::Keyword
        | PredicateField::Artist => PredicateOp::Colon,
        PredicateField::Colors => PredicateOp::Gte,
        PredicateField::ColorIdentity => PredicateOp::Lte,
        PredicateField::Cmc
        | PredicateField::Power
        | PredicateField::Toughness
        | PredicateField::Rarity
        | PredicateField::SetCode
        | PredicateField::Format => PredicateOp::Eq,
    }
}

/// The SQL operator for an already-resolved [`PredicateOp`].
///
/// `Colon` cannot reach here — [`predicate_clause`] resolves it through [`default_op`] first,
/// and no field's default is `:` on a path that calls this — but it is spelled rather than
/// left to `unreachable!()`, because a panic in a search box is a crashed window and `=` is
/// what the reader meant.
fn comparison(op: PredicateOp) -> &'static str {
    match op {
        PredicateOp::Colon | PredicateOp::Eq => "=",
        PredicateOp::Ne => "<>",
        PredicateOp::Gt => ">",
        PredicateOp::Gte => ">=",
        PredicateOp::Lt => "<",
        PredicateOp::Lte => "<=",
    }
}

/// The WUBRG letters a colour value names, in [`COLORS`] order and deduplicated.
///
/// **The whole-word colour names are checked before the letters, and that is not a nicety**:
/// `green` scanned letter by letter is `G` *and* `R`, which is a two-colour question the
/// reader did not ask. An empty answer is colourless — `c`, `colorless`, `colourless`, and
/// anything else with no WUBRG letter in it at all.
///
/// **Case-folded here because nothing folds it earlier.** The grammar canonicalises a rarity
/// before it sends one and canonicalises nothing else, so `c:RG` and `c:rg` both arrive
/// exactly as typed — a comparison that assumed either case would answer zero rows silently,
/// which reads as "no cards" rather than as a bug.
fn color_letters(value: &str) -> Vec<&'static str> {
    let value = value.trim().to_ascii_lowercase();
    let word = match value.as_str() {
        "white" => Some("W"),
        "blue" => Some("U"),
        "black" => Some("B"),
        "red" => Some("R"),
        "green" => Some("G"),
        "c" | "colorless" | "colourless" => Some(""),
        _ => None,
    };
    let letters: Vec<&'static str> = match word {
        Some("") => Vec::new(),
        Some(letter) => COLORS.iter().filter(|c| **c == letter).copied().collect(),
        None => {
            let upper = value.to_ascii_uppercase();
            COLORS
                .iter()
                .filter(|c| upper.contains(**c))
                .copied()
                .collect()
        }
    };
    letters
}

/// A letter-set comparison over `column` — `cards.colors` or `cards.color_identity`.
///
/// **`gte` is "has at least these letters" and `lte` is "has no letter outside them"**, which
/// are Scryfall's `c:` and `id:` respectively. The subset arm is
/// [`push_card_filters`]' existing exclusion idiom reused rather than re-derived, down to its
/// `coalesce(…,'')` — so it inherits that arm's behaviour on a NULL column, where a row with
/// no colours is inside every identity and outside every "has at least" test.
///
/// The letters are interpolated, never bound, and that is safe for [`COLORS`]' reason: they
/// come out of a five-element `const` and nothing a reader types can reach the SQL text.
fn color_clause(
    column: &str,
    op: PredicateOp,
    value: &str,
) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let named = color_letters(value);
    let colorless = format!("({column} = '' OR {column} IS NULL)");

    // **Colourless is its own question and every operator collapses onto it**, because the
    // empty set is the bottom of this lattice: `c:c`, `c=c` and `c<=c` all mean "is
    // colourless", and reading `c:c` as `c>=(nothing)` would answer the whole corpus — which
    // is the one wrong answer a reader would not recognise as one.
    if named.is_empty() {
        let sql = match op {
            PredicateOp::Colon | PredicateOp::Eq | PredicateOp::Gte | PredicateOp::Lte => colorless,
            PredicateOp::Ne | PredicateOp::Gt => format!("NOT {colorless}"),
            PredicateOp::Lt => NO_MATCH.to_owned(),
        };
        return (sql, Vec::new());
    }

    let at_least = {
        let terms: Vec<String> = named
            .iter()
            .map(|ch| format!("instr(coalesce({column},''), '{ch}') > 0"))
            .collect();
        format!("({})", terms.join(" AND "))
    };
    let within = {
        let terms: Vec<String> = COLORS
            .iter()
            .filter(|ch| !named.contains(ch))
            .map(|ch| format!("instr(coalesce({column},''), '{ch}') = 0"))
            .collect();
        if terms.is_empty() {
            // All five letters named: every colour combination is inside it.
            "1".to_owned()
        } else {
            format!("({})", terms.join(" AND "))
        }
    };
    let exactly = format!("({at_least} AND {within})");

    let sql = match op {
        PredicateOp::Colon => at_least,
        PredicateOp::Eq => exactly,
        PredicateOp::Ne => format!("NOT {exactly}"),
        PredicateOp::Gte => at_least,
        PredicateOp::Gt => format!("({at_least} AND NOT {exactly})"),
        PredicateOp::Lte => within,
        PredicateOp::Lt => format!("({within} AND NOT {exactly})"),
    };
    (sql, Vec::new())
}

/// A numeric comparison over a column that may not hold a number.
///
/// `star` is on for `power` and `toughness`, which are **TEXT** because a power can be `*`,
/// `1+`, `X` or `∞`. Two rules, both of them measured on Scryfall 2026-09-22:
///
/// * **`pow:*` is a string equality**, answering 1 059 — a literal star is the only way to ask
///   the question at all, and no cast can express it.
/// * **`pow>=*` is `pow>=0`**, both answering 19 128 — so under an *ordered* operator the star
///   participates rather than being excluded, which is exactly what `CAST('*' AS REAL)` = 0.0
///   already does. The comparison is therefore a cast on both sides of the operator and the
///   star is simply the number zero.
///
/// A value that is neither a number nor a star is [`NO_MATCH`]. The grammar never sends one —
/// `cmc>=banana` is handed to FTS as the words a reader typed (spec §3) — so this arm answers
/// a hand-built payload, and it answers it the way the format arm answers an unknown key.
///
/// A NULL column fails every branch without a null test: `CAST(NULL AS REAL)` is NULL and
/// `NULL >= 3.0` is NULL, so a land has no power and an orphan has no mana value.
fn numeric_clause(
    column: &str,
    op: PredicateOp,
    value: &str,
    star: bool,
) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    if star && value == "*" {
        match op {
            PredicateOp::Colon | PredicateOp::Eq => {
                return (format!("{column} = ?"), vec![Box::new("*".to_owned())])
            }
            PredicateOp::Ne => return (format!("{column} <> ?"), vec![Box::new("*".to_owned())]),
            _ => {}
        }
    }
    // `*` under an ordered operator is the 0.0 its cast yields — `pow>=*` = `pow>=0`, measured.
    let number = if star && value == "*" {
        Some(0.0_f64)
    } else {
        value.parse::<f64>().ok()
    };
    let Some(number) = number else {
        return (NO_MATCH.to_owned(), Vec::new());
    };
    (
        format!("CAST({column} AS REAL) {} ?", comparison(op)),
        vec![Box::new(number)],
    )
}

/// The SQL one [`QueryPredicate`] becomes, and the parameters it binds — or `None` when it
/// becomes no SQL at all.
///
/// There are exactly **two** ways to get `None` and they are different facts:
///
/// * [`PredicateField::TypeLine`] and [`PredicateField::OracleText`] are the FTS builder's,
///   and [`fts_match`] emits them. This is the `None` that is a hand-off rather than a gap.
/// * A **blank** value is no filter, which is [`nonblank`]'s rule and every other arm of
///   [`push_card_filters`] follows it: a term the reader has not finished typing must not
///   empty the wall under them.
///
/// `set_code` is the caller's already-built expression rather than `{alias}.set_code`, so
/// `s:lea` reads through to a collection entry's own copy exactly as the chip picker does —
/// see [`push_card_filters`]' doc comment for the asymmetry that makes that the one filter
/// with two places to read from.
fn predicate_clause(
    pred: &QueryPredicate,
    alias: &str,
    set_code: &str,
) -> Option<(String, Vec<Box<dyn rusqlite::ToSql>>)> {
    let value = pred.value.trim();
    if value.is_empty() {
        return None;
    }
    let op = if matches!(pred.op, PredicateOp::Colon) {
        default_op(pred.field)
    } else {
        pred.op
    };

    // **All twelve, and no `_` arm.** A thirteenth field added to the enum must fail this
    // match to compile rather than fall through into a filter that quietly does nothing.
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match pred.field {
        // The FTS builder's two — see [`PredicateField`] and [`fts_match`].
        PredicateField::TypeLine | PredicateField::OracleText => return None,

        // **The two-arm bridge, and the measurement is what licenses it.** `cards.keywords`
        // is corpus schema 5 and reads NULL on every row until the next full ingest, so a
        // bare `kw:flying` over the column alone would answer zero cards and read as "you own
        // no fliers" — a narrowing failing in the one direction a search must never fail in.
        // `kw:flying -o:flying` is **empty** on Scryfall (measured 2026-09-22), so the rules
        // text is a strict superset of the keyword: precise once ingested, over-inclusive
        // before, never empty. `deck::fill_unknown_produced_mana` is the same idea one column
        // over.
        //
        // **The delimiters are the whole of the exactness.** Scryfall matches `kw:` against a
        // known vocabulary and refuses `kw:fly` outright; the column stores `|flying|
        // vigilance|` so a bare `instr` cannot match a prefix. `card_row.rs` owns that format
        // and the two must not drift.
        //
        // ⚠️ **This arm is only sound because NULL means one thing**, and it briefly did not.
        // `card_row.rs` wrote `None` for a card with no keywords until the live pass of
        // 2026-09-22, which made NULL mean "predates the rung" *and* "vanilla card" at once —
        // so the bridge fired on every vanilla card permanently rather than on un-ingested
        // rows temporarily. Measured on a freshly ingested corpus: 68,808 NULLs out of 118,609
        // printings, and `kw:flying` collecting 2,435 printings that only mention flying
        // (*Mystic Skyfish*, *Workshop Elders*). A keywordless card now stores `""`, so NULL
        // is once again exactly "this row predates corpus schema 5". Do not let that field go
        // back to `None`.
        //
        // Parenthesised as a whole because the arms are ORed and this clause is ANDed into the
        // `WHERE` beside every other one — unwrapped, the `OR` would reach across it.
        PredicateField::Keyword => (
            format!(
                "(({alias}.keywords IS NOT NULL AND instr({alias}.keywords, ?) > 0) \
                 OR ({alias}.keywords IS NULL AND instr(lower({alias}.search_text), lower(?)) > 0))"
            ),
            vec![
                Box::new(format!("|{}|", value.to_ascii_lowercase())),
                Box::new(value.to_owned()),
            ],
        ),

        // **The one predicate here that scans.** There is no artist FTS column and
        // `cards.artist` carries no b-tree index, so this is an `instr` — acceptable where
        // `t:`/`o:` were not, because it is ANDed into a statement the FTS join, the format
        // mask or the collapse index has usually already narrowed. A bare `a:` on an otherwise
        // empty box is the worst case; if it ever lands above ~250 ms the fallback is an index
        // on `cards.artist`, which is cheap and additive.
        //
        // `instr(NULL, …)` is NULL, so an orphan fails this exactly as it fails the format and
        // rarity arms.
        PredicateField::Artist => match op {
            PredicateOp::Eq => (
                format!("lower({alias}.artist) = lower(?)"),
                vec![Box::new(value.to_owned())],
            ),
            _ => (
                format!("instr(lower({alias}.artist), lower(?)) > 0"),
                vec![Box::new(value.to_owned())],
            ),
        },

        // **`c:` is new and `id:` is not**, and getting the two the wrong way round would make
        // `c:rg` answer 13 399 where Scryfall answers 676. The app's existing `colors` filter
        // is colour *identity* with subset semantics, which is Scryfall's `id:`; card colours
        // have never been filtered on before.
        PredicateField::Colors => color_clause(&format!("{alias}.colors"), op, value),
        PredicateField::ColorIdentity => {
            color_clause(&format!("{alias}.color_identity"), op, value)
        }

        PredicateField::Cmc => numeric_clause(&format!("{alias}.cmc"), op, value, false),
        PredicateField::Power => numeric_clause(&format!("{alias}.power"), op, value, true),
        PredicateField::Toughness => numeric_clause(&format!("{alias}.toughness"), op, value, true),

        // Ordered — see [`RARITY_ORDER`]. **This is the one field the grammar canonicalises
        // before it sends one**: `r:c` arrives as `common` and `r:Rare` as `rare`, so there is
        // no single-letter expansion here and there must not be one — it would be code no
        // caller can reach. The lower-casing stays for [`picked_rarities`]' reason, against a
        // hand-built payload: `cards.rarity` holds Scryfall's own lower-case word and SQLite's
        // `=` on text is case-sensitive, so a `Rare` bound as sent matches nothing and reads
        // as an empty corpus rather than as a mistake.
        PredicateField::Rarity => {
            let value = value.to_ascii_lowercase();
            match op {
                PredicateOp::Colon | PredicateOp::Eq => {
                    (format!("{alias}.rarity = ?"), vec![Box::new(value)])
                }
                PredicateOp::Ne => (format!("{alias}.rarity <> ?"), vec![Box::new(value)]),
                _ => {
                    let Some(i) = RARITY_ORDER.iter().position(|r| *r == value) else {
                        return Some((NO_MATCH.to_owned(), Vec::new()));
                    };
                    let picked: &[&str] = match op {
                        PredicateOp::Gte => &RARITY_ORDER[i..],
                        PredicateOp::Gt => &RARITY_ORDER[i + 1..],
                        PredicateOp::Lte => &RARITY_ORDER[..=i],
                        _ => &RARITY_ORDER[..i],
                    };
                    if picked.is_empty() {
                        return Some((NO_MATCH.to_owned(), Vec::new()));
                    }
                    let holes = vec!["?"; picked.len()].join(",");
                    (
                        format!("{alias}.rarity IN ({holes})"),
                        picked
                            .iter()
                            .map(|r| Box::new((*r).to_owned()) as Box<dyn rusqlite::ToSql>)
                            .collect(),
                    )
                }
            }
        }

        // The caller's expression, so the collection's coalesce rule is not bypassed.
        //
        // **Lower-cased here because nothing lower-cases it earlier**, which is the same trap
        // [`color_letters`] names: the grammar sends `s:NEO` exactly as the reader typed it,
        // `cards.set_code` holds Scryfall's lower-case code, and SQLite's `=` on text is
        // case-sensitive — so the unfolded comparison is an empty wall with no error.
        PredicateField::SetCode => (
            format!("{set_code} = ?"),
            vec![Box::new(value.to_ascii_lowercase())],
        ),

        // [`crate::legalities::bit`], exactly as the `format` field's own arm does it — and an
        // unrecognised key is [`NO_MATCH`] there too.
        PredicateField::Format => match crate::legalities::bit(&value.to_ascii_lowercase()) {
            Some(bit) => (
                format!("({alias}.legal_mask & ?) != 0"),
                vec![Box::new(bit as i64)],
            ),
            None => (NO_MATCH.to_owned(), Vec::new()),
        },
    };

    // A leading `-` in the box. Wrapped rather than inverted per arm, because an arm that
    // inverted itself would have to get every NULL right twice.
    Some(if pred.negated {
        (format!("NOT ({sql})"), params)
    } else {
        (sql, params)
    })
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
/// The rarities a request really filters on: trimmed, lower-cased, blanks dropped, sorted and
/// deduplicated.
///
/// **An empty answer means "no rarity filter", never "match nothing"** — [`picked_sets`]' rule
/// and its reason, one dimension along. No cap: Scryfall names six rarities and the chip row
/// offers four, so there is no list long enough to be worth truncating and a cap would only be
/// a number to keep in step with nothing.
///
/// Lower-cased because `cards.rarity` is Scryfall's own lower-case word and the comparison is
/// `=`, which in SQLite is case-**sensitive** for text. A `Rare` from a hand-built payload
/// would otherwise match nothing and read as an empty corpus.
///
/// A function rather than five lines inside [`push_card_filters`], because
/// [`crate::index::facets`] narrows by exactly this list — the argument [`picked_sets`] makes,
/// and the trap it was extracted to avoid.
pub fn picked_rarities(rarities: &[String]) -> Vec<String> {
    let mut picked: Vec<String> = rarities
        .iter()
        .map(|r| r.trim().to_ascii_lowercase())
        .filter(|r| !r.is_empty())
        .collect();
    picked.sort();
    picked.dedup();
    picked
}

/// The type chips this build recognises, blanks dropped.
///
/// **A shared function for [`picked_rarities`]' reason**: [`crate::index::facets`] counts over the
/// same list, and a facet counted over a type the search drops would report an option as live
/// that the search cannot reach.
///
/// Matched **exactly**, no case folding: [`crate::cardtypes::TYPE_KEYS`] holds the capitalised
/// words, the UI sends those same words from one constant, and a loose match here would be a
/// second spelling rule the mask does not have.
pub fn picked_types(types: &[String]) -> Vec<String> {
    types
        .iter()
        .filter(|t| crate::cardtypes::TYPE_KEYS.contains(&t.as_str()))
        .cloned()
        .collect()
}

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
///
/// **And no cap, where [`picked_sets`] has [`MAX_SET_FILTER`] — deliberately, and said here
/// because a reader who has just read that one will come looking for this one.** The two lists
/// reach the SQL by different routes: sets become one `IN (…)` whose length *is* the bound
/// parameter count, so a pathological list is a statement SQLite has to be protected from,
/// while tags become **one subquery each** and a pathological list is a slow query rather than
/// an oversized statement. It is also a list nothing can grow by accident: a chip arrives one
/// press at a time from a rail, each is visible and removable, and includes intersect — so the
/// twentieth chip answers fewer cards than the nineteenth and a reader stops long before the
/// cost matters. If a future caller ever builds this list from something other than presses,
/// that is the assumption that has changed and this is the paragraph to revisit.
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

    /// The rarity chips are **OR within and AND without**, which is what a multi-select means
    /// everywhere else on this row — and an empty list is *no filter*, never a filter matching
    /// nothing.
    ///
    /// The empty arm is the one that has bitten every other list filter here: a cleared control
    /// sends `[]` and some send `[""]`, and either taken literally is `IN ()` — a syntax error in
    /// SQLite, and an empty wall with no chip drawn to explain it anywhere else.
    #[test]
    fn the_rarity_chips_or_within_and_an_empty_list_is_no_filter() {
        let sql = |f: CardFilters| {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            p.where_sql()
        };

        assert!(!sql(CardFilters::default()).contains("rarity"));
        assert!(
            !sql(CardFilters {
                rarities: Some(vec![]),
                ..Default::default()
            })
            .contains("rarity"),
            "an empty list is no filter"
        );
        assert!(
            !sql(CardFilters {
                rarities: Some(vec!["".into(), "   ".into()]),
                ..Default::default()
            })
            .contains("rarity"),
            "blanks are dropped rather than bound"
        );

        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                rarities: Some(vec!["mythic".into(), "rare".into()]),
                ..Default::default()
            },
            "c",
            None,
        );
        // Filtered to the arm under test: `paper_only` defaults on, so it is always in here.
        let rarity: Vec<&String> = p.wheres.iter().filter(|w| w.contains("rarity")).collect();
        assert_eq!(rarity, vec!["c.rarity IN (?,?)"], "one group, ORed");
        assert_eq!(p.params.len(), 2);
    }

    /// **The normalisation is [`picked_rarities`] and the facet index narrows by the same
    /// function**, which is the whole reason it is a function: a count taken over a rarity the
    /// search dropped reports an option as live that the search cannot reach.
    ///
    /// Lower-cased because `cards.rarity` holds Scryfall's own lower-case word and SQLite's `=`
    /// on text is case-sensitive — a `Rare` bound as sent would match nothing and read as an
    /// empty corpus rather than as a bug.
    #[test]
    fn picked_rarities_lower_cases_sorts_and_deduplicates() {
        assert_eq!(
            picked_rarities(&[
                " Rare ".into(),
                "MYTHIC".into(),
                "rare".into(),
                "".into(),
                "common".into(),
            ]),
            vec!["common", "mythic", "rare"]
        );
        assert!(picked_rarities(&[]).is_empty());
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
        let conn = crate::schema::memory_pair();
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

    // ---------------------------------------------------------------------------------
    // Typed query predicates
    // ---------------------------------------------------------------------------------

    fn pred(field: PredicateField, op: PredicateOp, value: &str) -> QueryPredicate {
        QueryPredicate {
            field,
            op,
            value: value.to_owned(),
            negated: false,
        }
    }

    fn negated(field: PredicateField, op: PredicateOp, value: &str) -> QueryPredicate {
        QueryPredicate {
            negated: true,
            ..pred(field, op, value)
        }
    }

    /// Every one of the twelve, so a census can walk them without naming them twice.
    const EVERY_FIELD: [PredicateField; 12] = [
        PredicateField::TypeLine,
        PredicateField::OracleText,
        PredicateField::Keyword,
        PredicateField::Artist,
        PredicateField::Colors,
        PredicateField::ColorIdentity,
        PredicateField::Cmc,
        PredicateField::Power,
        PredicateField::Toughness,
        PredicateField::Rarity,
        PredicateField::SetCode,
        PredicateField::Format,
    ];

    /// The clauses one list of predicates pushes, with [`CardFilters::paper_only`]'s standing
    /// term dropped: every assertion below is about the predicates, and that one is always
    /// there because it is omitted-means-**on**.
    fn predicate_wheres(preds: Vec<QueryPredicate>) -> Vec<String> {
        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                predicates: Some(preds),
                ..Default::default()
            },
            "c",
            None,
        );
        p.wheres
            .into_iter()
            .filter(|w| w != "c.is_paper = 1")
            .collect()
    }

    /// The single clause one predicate pushes. Panics on anything but one, which is itself
    /// the assertion in most of the tests below.
    fn one_clause(pred: QueryPredicate) -> String {
        let mut wheres = predicate_wheres(vec![pred]);
        assert_eq!(wheres.len(), 1, "{wheres:?}");
        wheres.pop().unwrap()
    }

    #[test]
    fn a_type_line_predicate_is_left_to_the_fts_builder() {
        let f = CardFilters {
            predicates: Some(vec![pred(
                PredicateField::TypeLine,
                PredicateOp::Colon,
                "goblin",
            )]),
            ..Default::default()
        };
        let mut p = Predicates::default();
        push_card_filters(&mut p, &f, "c", None);
        // Not a WHERE clause — it rides the MATCH. A field handled by neither
        // side is a filter that silently does nothing, which is what this pins.
        let wheres: Vec<&String> = p.wheres.iter().filter(|w| *w != "c.is_paper = 1").collect();
        assert!(
            wheres.is_empty(),
            "type line must not become SQL: {wheres:?}"
        );
    }

    #[test]
    fn a_cmc_predicate_becomes_a_comparison() {
        let f = CardFilters {
            predicates: Some(vec![pred(PredicateField::Cmc, PredicateOp::Gte, "3")]),
            ..Default::default()
        };
        let mut p = Predicates::default();
        push_card_filters(&mut p, &f, "c", None);
        let wheres: Vec<&String> = p.wheres.iter().filter(|w| *w != "c.is_paper = 1").collect();
        assert_eq!(wheres.len(), 1);
        assert!(wheres[0].contains("c.cmc"), "{}", wheres[0]);
        assert!(wheres[0].contains(">="), "{}", wheres[0]);
    }

    /// **The census, and the reason [`predicate_clause`] has no `_` arm.**
    ///
    /// A field that neither this function nor [`fts_match`] emits is a filter that silently
    /// does nothing: the chip draws, the reader believes the list is narrowed, and it is not.
    /// The two sides are asserted against each other here so that adding a thirteenth field
    /// and forgetting one of them is a red test rather than a quiet wrong answer.
    #[test]
    fn every_predicate_field_is_emitted_by_exactly_one_of_the_two_sides() {
        for field in EVERY_FIELD {
            let term = pred(field, PredicateOp::Colon, "goblin");
            let sql = predicate_wheres(vec![term.clone()]);
            let (positive, negatives) = fts_match(None, std::slice::from_ref(&term));
            let rides_fts = positive.is_some() || !negatives.is_empty();
            assert_ne!(
                !sql.is_empty(),
                rides_fts,
                "{field:?} is emitted by both sides or by neither: sql={sql:?} fts={positive:?}"
            );
        }
    }

    /// A term the reader has not finished typing must not empty the wall under them —
    /// [`nonblank`]'s rule, which every other arm of [`push_card_filters`] follows. The
    /// grammar answers `"partial"` rather than sending one of these, so this arm is about a
    /// hand-built payload; the direction is what matters, and it is *no filter* rather than
    /// *a filter matching nothing*.
    #[test]
    fn a_blank_value_is_no_filter_at_all() {
        for field in EVERY_FIELD {
            for value in ["", "   "] {
                assert!(
                    predicate_wheres(vec![pred(field, PredicateOp::Colon, value)]).is_empty(),
                    "{field:?} pushed SQL for a blank value"
                );
            }
        }
        assert!(predicate_wheres(Vec::new()).is_empty());
        let mut p = Predicates::default();
        push_card_filters(&mut p, &CardFilters::default(), "c", None);
        assert_eq!(p.wheres, vec!["c.is_paper = 1"], "absent means no clause");
    }

    /// `:` is not one operator, and a single rule for it would answer 13 399 cards where
    /// Scryfall answers 676. Measured 2026-09-22: `c:rg` = `c>=rg` and `id:rg` = `id<=rg`.
    ///
    /// The grammar resolves `:` at the edge for every field but the four whose default really
    /// is `:`, so this arm answers a hand-built payload — and it answers it as the default
    /// rather than refusing, which is what keeps a hand-written request honest.
    #[test]
    fn a_colon_resolves_to_the_fields_own_default_operator() {
        let at_least = one_clause(pred(PredicateField::Colors, PredicateOp::Gte, "rg"));
        let within = one_clause(pred(PredicateField::ColorIdentity, PredicateOp::Lte, "rg"));
        assert_eq!(
            one_clause(pred(PredicateField::Colors, PredicateOp::Colon, "rg")),
            at_least,
            "c: is c>="
        );
        assert_eq!(
            one_clause(pred(
                PredicateField::ColorIdentity,
                PredicateOp::Colon,
                "rg"
            )),
            within,
            "id: is id<="
        );
        // And the two are genuinely different shapes, or the assertion above is vacuous.
        assert!(at_least.contains("> 0"), "{at_least}");
        assert!(within.contains("= 0"), "{within}");

        // A numeric field's default is `=`, not "at least".
        assert_eq!(
            one_clause(pred(PredicateField::Cmc, PredicateOp::Colon, "3")),
            one_clause(pred(PredicateField::Cmc, PredicateOp::Eq, "3")),
        );
    }

    /// A leading `-` wraps the whole clause rather than inverting it arm by arm — an arm that
    /// inverted itself would have to get every NULL right twice.
    #[test]
    fn a_negated_predicate_wraps_its_clause_in_not() {
        let plain = one_clause(pred(PredicateField::Cmc, PredicateOp::Gte, "3"));
        assert_eq!(
            one_clause(negated(PredicateField::Cmc, PredicateOp::Gte, "3")),
            format!("NOT ({plain})")
        );
    }

    /// Repetition is the whole reason the wire carries a *list*: `t:creature t:goblin` is two
    /// terms and both must hold, where two fields would have had the second overwrite the
    /// first.
    #[test]
    fn repeated_predicates_and_rather_than_collapsing() {
        let wheres = predicate_wheres(vec![
            pred(PredicateField::Cmc, PredicateOp::Gte, "3"),
            pred(PredicateField::Cmc, PredicateOp::Lte, "5"),
        ]);
        assert_eq!(wheres.len(), 2, "{wheres:?}");
    }

    /// **The parameters are pushed in the order the fragments are**, which is the invariant
    /// the whole builder rests on: `?` binds by position, so a keyword's two placeholders and
    /// an ordered rarity's four must arrive with their own clause and not with the one beside
    /// it.
    #[test]
    fn every_predicate_binds_its_parameters_in_push_order() {
        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                predicates: Some(vec![
                    pred(PredicateField::Cmc, PredicateOp::Gte, "3"),
                    pred(PredicateField::Keyword, PredicateOp::Colon, "flying"),
                    pred(PredicateField::Rarity, PredicateOp::Gte, "rare"),
                    pred(PredicateField::SetCode, PredicateOp::Eq, "NEO"),
                ]),
                ..Default::default()
            },
            "c",
            None,
        );
        // 1 for the mana value, 2 for the keyword bridge, 2 for `rare`/`mythic`, 1 for the set.
        assert_eq!(p.params.len(), 6, "{:?}", p.wheres);

        // Prepared against a real table, which is the only thing that can tell a mis-ordered
        // bind from a correct one: `c.rarity IN (?,?)` fed a float is not an error, it is an
        // empty list.
        //
        // A hand-built `cards` rather than [`crate::schema::memory_pair`], because this is the
        // one assertion here that needs **column names only** and the keyword arm reads
        // `keywords` — corpus schema 5's column, whose presence is a fact about the ladder and
        // not about this function.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE cards (id TEXT, cmc REAL, rarity TEXT, set_code TEXT,
                keywords TEXT, search_text TEXT, is_paper INTEGER)",
        )
        .unwrap();
        let sql = format!("SELECT c.id FROM cards c WHERE {}", p.where_sql());
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(
            rusqlite::params_from_iter(p.params.iter().map(|b| b.as_ref())),
            |r| r.get::<_, String>(0),
        )
        .unwrap()
        .collect::<Result<Vec<String>, _>>()
        .unwrap();
    }

    /// **The two-arm bridge, pinned against Task 3's column format rather than against rows.**
    ///
    /// `cards.keywords` is corpus schema 5 and holds the card's keywords lowercased,
    /// delimited and wrapped — `|flying|vigilance|`. The delimiters *are* the exactness:
    /// Scryfall matches `kw:` against a known vocabulary and refuses `kw:fly` outright, so a
    /// bare `instr` would answer `kw:fly` with every flier. This test is what fails if the
    /// two sides ever spell that format differently.
    ///
    /// The NULL arm is the other half and it is not decoration: the column reads NULL on every
    /// row until the next full ingest, and a bare `kw:flying` over the column alone would
    /// answer zero cards and read as "you own no fliers" — a narrowing failing in the one
    /// direction a search must never fail in. `kw:flying -o:flying` is **empty** on Scryfall
    /// (measured 2026-09-22), so the rules text is a strict superset and the fallback is
    /// over-inclusive rather than wrong.
    #[test]
    fn the_keyword_bridge_reads_the_column_when_it_has_one_and_the_rules_text_when_it_does_not() {
        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                predicates: Some(vec![pred(
                    PredicateField::Keyword,
                    PredicateOp::Colon,
                    "Flying",
                )]),
                ..Default::default()
            },
            "c",
            None,
        );
        let sql = p.where_sql();
        assert!(sql.contains("c.keywords IS NOT NULL"), "{sql}");
        assert!(sql.contains("c.keywords IS NULL"), "{sql}");
        assert!(sql.contains("c.search_text"), "{sql}");

        // The bound form, which is the half that can drift from the ingest. Read back through
        // SQLite rather than downcast, because `Box<dyn ToSql>` has nothing to compare to.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let bound: Vec<String> = p
            .params
            .iter()
            .map(|b| {
                conn.query_row("SELECT ?1", rusqlite::params![b.as_ref()], |r| r.get(0))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            bound,
            vec!["|flying|".to_owned(), "Flying".to_owned()],
            "the column arm is delimiter-wrapped and lower-cased; the text arm is lowered in SQL"
        );
    }

    /// Both are **TEXT** columns, because a power can be `*`, `1+`, `X` or `∞`.
    ///
    /// Two measurements from Scryfall, 2026-09-22, and they pull in opposite directions:
    /// `pow:*` answers 1 059, so a literal star has to be a string equality; and `pow>=*`
    /// answers the same 19 128 as `pow>=0`, so under an ordered operator the star is simply
    /// the zero its cast yields. Casting `pow:*` would have answered every 0-power creature.
    #[test]
    fn a_star_power_is_a_string_equality_and_an_ordered_star_is_zero() {
        let exact = one_clause(pred(PredicateField::Power, PredicateOp::Eq, "*"));
        assert_eq!(exact, "c.power = ?");
        assert!(!exact.contains("CAST"), "{exact}");

        let ordered = one_clause(pred(PredicateField::Power, PredicateOp::Gte, "*"));
        assert_eq!(ordered, "CAST(c.power AS REAL) >= ?");
        assert_eq!(
            ordered,
            one_clause(pred(PredicateField::Power, PredicateOp::Gte, "0")),
            "`pow>=*` and `pow>=0` are the same question"
        );

        assert_eq!(
            one_clause(pred(PredicateField::Toughness, PredicateOp::Lt, "2")),
            "CAST(c.toughness AS REAL) < ?"
        );
    }

    /// A value that names nothing this build knows matches **nothing**, spelled `0`, which is
    /// the choice the format arm made first: leaving the clause out turns an unknown term
    /// into no filter and quietly returns the whole corpus.
    ///
    /// The grammar never sends one — `cmc>=banana` is handed to FTS as the words a reader
    /// typed (spec §3) — so every case here is a hand-built payload.
    #[test]
    fn a_value_this_build_cannot_read_matches_nothing_rather_than_everything() {
        for term in [
            pred(PredicateField::Cmc, PredicateOp::Gte, "banana"),
            pred(PredicateField::Power, PredicateOp::Gte, "1+"),
            pred(PredicateField::Format, PredicateOp::Eq, "nonesuch"),
            pred(PredicateField::Rarity, PredicateOp::Gte, "special"),
            pred(PredicateField::Rarity, PredicateOp::Gt, "mythic"),
        ] {
            assert_eq!(one_clause(term.clone()), "0", "{term:?}");
        }
        // And an unordered comparison on an off-ladder rarity still works, because `special`
        // is a real value of the column even though it has no place in the order.
        assert_eq!(
            one_clause(pred(PredicateField::Rarity, PredicateOp::Eq, "special")),
            "c.rarity = ?"
        );
    }

    /// `f:` is [`crate::legalities::bit`], exactly as the `format` field's own arm is — one
    /// bit tested against the mask, never a `json_extract`.
    #[test]
    fn a_format_predicate_tests_the_same_mask_the_format_field_does() {
        let mut field = Predicates::default();
        push_card_filters(
            &mut field,
            &CardFilters {
                format: Some("modern".into()),
                ..Default::default()
            },
            "c",
            None,
        );
        let from_field: Vec<&String> = field
            .wheres
            .iter()
            .filter(|w| w.contains("legal_mask"))
            .collect();
        assert_eq!(
            one_clause(pred(PredicateField::Format, PredicateOp::Eq, "Modern")),
            *from_field[0],
            "the chip and the typed term are the same predicate"
        );
    }

    /// The set code reads through the **caller's** expression, so a collection entry's own
    /// copy answers `s:lea` exactly as the chip picker does — the one filter in
    /// [`push_card_filters`] with two places to read from, and the asymmetry its doc comment
    /// exists for.
    ///
    /// And it is lower-cased here, because nothing lower-cases it earlier: the grammar sends
    /// `s:NEO` as typed and `cards.set_code` holds Scryfall's lower-case code.
    #[test]
    fn a_set_code_predicate_follows_the_rows_fallback_and_folds_its_case() {
        assert_eq!(
            one_clause(pred(PredicateField::SetCode, PredicateOp::Eq, "NEO")),
            "c.set_code = ?"
        );

        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                predicates: Some(vec![pred(PredicateField::SetCode, PredicateOp::Eq, "NEO")]),
                ..Default::default()
            },
            "c",
            Some("e"),
        );
        assert!(
            p.wheres
                .iter()
                .any(|w| w == "coalesce(c.set_code, e.set_code) = ?"),
            "{:?}",
            p.wheres
        );

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let bound: String = conn
            .query_row("SELECT ?1", rusqlite::params![p.params[0].as_ref()], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(bound, "neo");
    }

    /// Six printings whose card *facts* are the question — colours against identity, a star
    /// power, every rarity on the ladder, an artist and a type line.
    ///
    /// [`corpus_with_art_tags`]' sibling, and separate from it on that fixture's own argument:
    /// a row built to make three tag mistakes distinguishable makes none of these.
    #[rustfmt::skip]
    fn corpus_with_card_facts() -> rusqlite::Connection {
        let conn = crate::schema::memory_pair();
        // id            colors  identity  cmc  power  tough  rarity      artist        type line
        let cards = [
            ("mono-r",    "R",    "R",     1.0, "2",   "1",   "common",   "Rebecca G",  "Creature — Goblin"),
            ("rg",        "RG",   "RG",    3.0, "4",   "4",   "uncommon", "Someone Else", "Creature — Beast"),
            ("rg-splash", "R",    "RG",    2.0, "1",   "1",   "rare",     "Rebecca G",  "Instant"),
            ("mono-u",    "U",    "U",     2.0, "1",   "3",   "mythic",   "Nobody",     "Creature — Bird"),
            ("land",      "",     "",      0.0, "",    "",    "common",   "Nobody",     "Land"),
            ("star",      "G",    "G",     4.0, "*",   "*",   "rare",     "Nobody",     "Creature — Fungus"),
        ];
        for (id, colors, identity, cmc, power, toughness, rarity, artist, type_line) in cards {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                    oracle_id,colors,color_identity,cmc,power,toughness,rarity,artist,type_line,
                    search_text,raw)
                 VALUES (?1,?1,'tst','1','en','normal',1,?1,?2,?3,?4,
                    nullif(?5,''),nullif(?6,''),?7,?8,?9,?9,'{}')",
                rusqlite::params![id, colors, identity, cmc, power, toughness, rarity, artist, type_line],
            ).unwrap();
        }
        conn
    }

    /// The ids one predicate list leaves standing, in id order.
    fn ids_for(conn: &rusqlite::Connection, preds: Vec<QueryPredicate>) -> Vec<String> {
        search_ids(
            conn,
            CardFilters {
                predicates: Some(preds),
                ..Default::default()
            },
        )
    }

    /// **`c:` is card colours and `id:` is colour identity, and swapping them would make
    /// `c:rg` answer 13 399 where Scryfall answers 676.** The app's existing `colors` filter
    /// is identity with subset semantics — which is `id:` — so `c:` is the new one here and
    /// `rg-splash` is the row that can tell them apart: red on the card, red-green in the
    /// identity.
    #[test]
    fn card_colours_and_colour_identity_are_two_different_questions() {
        let conn = corpus_with_card_facts();
        // `c:rg` — has at least red and green.
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Gte, "rg")]
            ),
            vec!["rg"]
        );
        // `id:rg` — fits inside a red-green deck. Colourless fits in every identity.
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::ColorIdentity, PredicateOp::Lte, "rg")]
            ),
            vec!["land", "mono-r", "rg", "rg-splash", "star"]
        );
        // Exactly, strictly more than, and not.
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Eq, "r")]
            ),
            vec!["mono-r", "rg-splash"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Gt, "r")]
            ),
            vec!["rg"],
            "strictly more than mono-red"
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Ne, "r")]
            ),
            vec!["land", "mono-u", "rg", "star"]
        );
        // Case is the reader's and is folded here, because nothing folds it earlier.
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Gte, "RG")]
            ),
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Gte, "rg")]
            )
        );
        // A colour *word* is one letter, not the letters in the word: `green` is G, never GR.
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Gte, "green")]
            ),
            vec!["rg", "star"]
        );
    }

    /// **Colourless is the bottom of the lattice and every operator collapses onto it.**
    /// `c:c` read as "has at least nothing" would answer the whole corpus, which is the one
    /// wrong answer a reader would not recognise as one.
    #[test]
    fn a_colourless_value_asks_whether_the_card_is_colourless() {
        let conn = corpus_with_card_facts();
        for op in [
            PredicateOp::Colon,
            PredicateOp::Eq,
            PredicateOp::Gte,
            PredicateOp::Lte,
        ] {
            assert_eq!(
                ids_for(&conn, vec![pred(PredicateField::Colors, op, "c")]),
                vec!["land"],
                "{op:?}"
            );
        }
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Ne, "c")]
            ),
            vec!["mono-r", "mono-u", "rg", "rg-splash", "star"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Colors, PredicateOp::Lt, "c")]
            ),
            Vec::<String>::new(),
            "nothing is less coloured than colourless"
        );
    }

    /// The ordered enum, expanded before it reaches the SQL — `r>=rare` answers 13 951 on
    /// Scryfall where `r:rare` answers 11 856, which is what makes the order real.
    #[test]
    fn rarity_is_ordered_and_the_ordered_operators_expand_to_a_list() {
        let conn = corpus_with_card_facts();
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Rarity, PredicateOp::Gte, "rare")]
            ),
            vec!["mono-u", "rg-splash", "star"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Rarity, PredicateOp::Lt, "rare")]
            ),
            vec!["land", "mono-r", "rg"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Rarity, PredicateOp::Eq, "rare")]
            ),
            vec!["rg-splash", "star"],
            "`:` on a rarity is equality, not `at least`"
        );
    }

    /// The numeric arms over real rows, including the two NULLs a cast has to answer for: a
    /// land has no power, and `CAST(NULL AS REAL) >= 0` is NULL rather than true.
    #[test]
    fn the_numeric_predicates_compare_through_a_cast_and_a_null_fails_them() {
        let conn = corpus_with_card_facts();
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Cmc, PredicateOp::Gte, "3")]
            ),
            vec!["rg", "star"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Power, PredicateOp::Gte, "0")]
            ),
            vec!["mono-r", "mono-u", "rg", "rg-splash", "star"],
            "the star participates, and the land has no power at all"
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Power, PredicateOp::Eq, "*")]
            ),
            vec!["star"],
            "a literal star is the only way to ask this question"
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Toughness, PredicateOp::Gte, "3")]
            ),
            vec!["mono-u", "rg"]
        );
    }

    /// `a:` is a case-insensitive substring, and `a=` is the whole name. One `instr` and no
    /// index behind it — the only predicate here that scans, and the reason it is acceptable
    /// is that it is ANDed into a statement something else has usually already narrowed.
    #[test]
    fn an_artist_predicate_matches_part_of_a_name_and_ignores_case() {
        let conn = corpus_with_card_facts();
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Artist, PredicateOp::Colon, "REBECCA")]
            ),
            vec!["mono-r", "rg-splash"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Artist, PredicateOp::Eq, "rebecca")]
            ),
            Vec::<String>::new(),
            "`a=` is the whole name"
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![pred(PredicateField::Artist, PredicateOp::Eq, "rebecca g")]
            ),
            vec!["mono-r", "rg-splash"]
        );
        assert_eq!(
            ids_for(
                &conn,
                vec![negated(
                    PredicateField::Artist,
                    PredicateOp::Colon,
                    "rebecca"
                )]
            ),
            vec!["land", "mono-u", "rg", "star"]
        );
    }

    /// **The wire spelling, asserted from Rust rather than assumed from the attribute.**
    ///
    /// `#[serde(rename_all = "camelCase")]` on an *enum* renames its variants, and what it
    /// does to a one-word variant (`Cmc` -> `cmc`) against a two-word one (`TypeLine` ->
    /// `typeLine`) is the half a reader would have to know serde's rule to predict. These are
    /// the strings `src/lib/ipc.ts` declares and `queryLanguage.ts` produces, so this is the
    /// Rust end of a cross-boundary contract whose other end is `ipc.test.ts`'s drift fence —
    /// and neither end can check the other, which is why both are written out.
    ///
    /// `negated` is `#[serde(default)]`, so a payload that omits it is a positive term rather
    /// than a rejected request.
    #[test]
    fn the_wire_names_every_field_and_operator_in_camel_case() {
        let parsed: Vec<QueryPredicate> = serde_json::from_str(
            r#"[
                {"field":"typeLine","op":"colon","value":"goblin","negated":true},
                {"field":"oracleText","op":"eq","value":"draw a card"},
                {"field":"colorIdentity","op":"lte","value":"rg"},
                {"field":"setCode","op":"eq","value":"neo"},
                {"field":"cmc","op":"gte","value":"3"},
                {"field":"keyword","op":"ne","value":"flying"},
                {"field":"power","op":"gt","value":"4"},
                {"field":"toughness","op":"lt","value":"2"},
                {"field":"artist","op":"colon","value":"rebecca"},
                {"field":"colors","op":"gte","value":"rg"},
                {"field":"rarity","op":"eq","value":"rare"},
                {"field":"format","op":"eq","value":"modern"}
            ]"#,
        )
        .expect("every name here is what the TypeScript mirror sends");

        assert_eq!(parsed.len(), EVERY_FIELD.len(), "one payload per field");
        assert!(parsed[0].negated);
        assert!(
            !parsed[1].negated,
            "an omitted `negated` is a positive term"
        );
        let ops: Vec<PredicateOp> = parsed.iter().map(|p| p.op).collect();
        assert!(ops.contains(&PredicateOp::Ne) && ops.contains(&PredicateOp::Gte));

        // And a name this build has never heard of is a **refused request**, not a silently
        // dropped filter — which is what a closed enum buys over a stringly-typed value.
        assert!(serde_json::from_str::<QueryPredicate>(
            r#"{"field":"flavourText","op":"colon","value":"x"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<QueryPredicate>(
            r#"{"field":"cmc","op":"approximately","value":"3"}"#
        )
        .is_err());
    }

    // ---------------------------------------------------------------------------------
    // The FTS half
    // ---------------------------------------------------------------------------------

    #[test]
    fn a_positive_type_term_joins_the_match_string() {
        let preds = vec![pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin")];
        let (m, neg) = fts_match(Some("bolt"), &preds);
        let m = m.unwrap();
        assert!(m.contains("type_line :"), "{m}");
        assert!(neg.is_empty());
    }

    #[test]
    fn a_purely_negative_term_produces_no_match_string() {
        // FTS5's NOT is binary — `NOT x` alone is a syntax error, so a query that
        // is only `-t:goblin` has to become a NOT IN subquery instead.
        let preds = vec![negated(
            PredicateField::TypeLine,
            PredicateOp::Colon,
            "goblin",
        )];
        let (m, neg) = fts_match(None, &preds);
        assert!(m.is_none());
        assert_eq!(neg.len(), 1);
        assert!(neg[0].contains("type_line :"), "{}", neg[0]);
    }

    /// The free text, the type line and the oracle text share one `MATCH`, joined by a
    /// spelled-out `AND` — and the negatives are split out whether or not there is a positive
    /// beside them, which is what makes the rule uniform.
    ///
    /// ⚠️ **This test asserted a space here and was green while the window was broken.** A
    /// space is FTS5's implicit AND between bare phrases and a *syntax error* after a column
    /// filter, so every string this test blessed — free text beside `t:`, `t:` beside `o:` —
    /// raised `fts5: syntax error near "search_text"` in the shipped app. The assertion was on
    /// the string's *shape* and nothing ever handed it to FTS5, which is the whole of how it
    /// shipped: see `two_positive_terms_join_with_an_explicit_and`, which runs it against a
    /// real index instead and is the fence that would have caught this.
    #[test]
    fn the_match_string_ands_the_free_text_and_every_positive_term() {
        let preds = vec![
            pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin"),
            pred(
                PredicateField::OracleText,
                PredicateOp::Colon,
                "draw a card",
            ),
            negated(PredicateField::OracleText, PredicateOp::Colon, "sacrifice"),
        ];
        let (m, neg) = fts_match(Some("bolt"), &preds);
        assert_eq!(
            m.unwrap(),
            "\"bolt\"* AND type_line : (\"goblin\"*) AND search_text : (\"draw\"* \"a\"* \"card\"*)"
        );
        assert_eq!(neg, vec!["search_text : (\"sacrifice\"*)"]);
    }

    /// The wishlist passes `None`, because its free text is a `LIKE` over its own
    /// denormalised name column — searching the corpus for a name an orphaned wish may be the
    /// only record of would hide exactly the row that column exists for.
    #[test]
    fn no_text_and_no_text_terms_is_no_match_string() {
        assert_eq!(fts_match(None, &[]), (None, Vec::new()));
        assert_eq!(fts_match(Some("   "), &[]), (None, Vec::new()));
        // Every non-text field is the SQL builder's and contributes nothing here.
        let preds: Vec<QueryPredicate> = EVERY_FIELD
            .iter()
            .filter(|f| !matches!(f, PredicateField::TypeLine | PredicateField::OracleText))
            .map(|f| pred(*f, PredicateOp::Colon, "goblin"))
            .collect();
        assert_eq!(fts_match(None, &preds), (None, Vec::new()));
    }

    /// All-punctuation leaves nothing to match on, and the answer is **no term**, not an
    /// empty one: an empty `MATCH` is a syntax error for a positive and "exclude everything"
    /// for a negative. `fts_query`'s own arm, one level up.
    #[test]
    fn a_term_that_tokenises_to_nothing_adds_nothing_on_either_side() {
        let preds = vec![
            pred(PredicateField::TypeLine, PredicateOp::Colon, "!!!"),
            negated(PredicateField::OracleText, PredicateOp::Colon, "???"),
        ];
        assert_eq!(fts_match(None, &preds), (None, Vec::new()));
    }

    /// The `MATCH` strings this builder produces have to be strings FTS5 will accept — which
    /// a `contains` assertion cannot tell, because a syntax error is a *prepare* failure and
    /// not a wrong answer.
    /// Two positive terms in one MATCH string — the shape the shipped window broke on.
    ///
    /// **FTS5's implicit AND is a space only between bare phrases.** After a column filter a
    /// space is a *syntax error*: `type_line : (…) search_text : (…)` does not parse, and
    /// neither does free text followed by a filtered term. Measured against the real
    /// 118,609-printing corpus on 2026-09-22 — both space forms raise
    /// `fts5: syntax error near "search_text"` while both `AND` forms answer 314 — and the live
    /// window said exactly that under `t:goblin o:haste`.
    ///
    /// **Nothing in the suite had ever put two positives in one string**, which is why this
    /// shipped green: the test below builds one positive and one *negated* term, and a negated
    /// term goes to its own `NOT IN` subquery rather than into the MATCH. So the join was only
    /// ever exercised with a single element, where `join` returns it untouched and any
    /// separator is correct.
    #[test]
    fn two_positive_terms_join_with_an_explicit_and() {
        let conn = corpus_with_card_facts();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        let run = |query: &str| -> rusqlite::Result<i64> {
            conn.prepare(
                "SELECT count(*) FROM cards c JOIN cards_fts ON cards_fts.rowid = c.rowid
                 WHERE cards_fts MATCH ?",
            )?
            .query_row([query], |r| r.get::<_, i64>(0))
        };

        // Two filtered columns: `t:creature o:goblin`.
        let (two, _) = fts_match(
            None,
            &[
                pred(PredicateField::TypeLine, PredicateOp::Colon, "creature"),
                pred(PredicateField::OracleText, PredicateOp::Colon, "goblin"),
            ],
        );
        let two = two.unwrap();
        assert!(two.contains(" AND "), "two terms must be ANDed, got: {two}");
        run(&two).expect("two filtered columns must parse");

        // Free text beside a filtered column: `bolt t:creature` — the commoner shape, and
        // just as broken, so a reader typing a name beside a type saw an error rather than
        // a narrowed wall.
        let (mixed, _) = fts_match(
            Some("bolt"),
            &[pred(
                PredicateField::TypeLine,
                PredicateOp::Colon,
                "creature",
            )],
        );
        let mixed = mixed.unwrap();
        assert!(
            mixed.contains(" AND "),
            "free text must be ANDed, got: {mixed}"
        );
        run(&mixed).expect("free text beside a filtered column must parse");
    }

    #[test]
    fn the_match_strings_prepare_and_run_against_a_real_index() {
        let conn = corpus_with_card_facts();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        let preds = vec![
            pred(PredicateField::TypeLine, PredicateOp::Colon, "creature"),
            negated(PredicateField::TypeLine, PredicateOp::Colon, "goblin"),
        ];
        let (positive, negatives) = fts_match(None, &preds);

        let hits = |query: &str| -> Vec<String> {
            let mut stmt = conn
                .prepare(
                    "SELECT c.id FROM cards c JOIN cards_fts ON cards_fts.rowid = c.rowid
                     WHERE cards_fts MATCH ? ORDER BY c.id",
                )
                .unwrap();
            stmt.query_map([query], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap()
        };
        assert_eq!(
            hits(&positive.unwrap()),
            vec!["mono-r", "mono-u", "rg", "star"]
        );
        assert_eq!(negatives.len(), 1);
        assert_eq!(hits(&negatives[0]), vec!["mono-r"]);

        // And the column filter really is a filter: `goblin` is in the type line here, so a
        // term aimed at the oracle text must not find it.
        let (oracle, _) = fts_match(
            None,
            &[pred(
                PredicateField::OracleText,
                PredicateOp::Colon,
                "goblin",
            )],
        );
        assert_eq!(
            hits(&oracle.unwrap()),
            vec!["mono-r"],
            "search_text holds the type line too"
        );
    }
    // Strict colours and the type filter
    // ---------------------------------------------------------------------------------

    /// Seed `cards` from `(id, color_identity, type_line)` triples — enough columns for the
    /// two arms below and no more.
    ///
    /// **`type_mask` is computed by [`crate::cardtypes::type_mask`] from the row's own type
    /// line, never written here as an integer.** A hand-written mask would make every type
    /// assertion a statement about this fixture rather than about the function the ingest
    /// really calls, and the day the two disagreed this file would still be green.
    ///
    /// `color_identity` is **concatenated letters** (`"WR"`), not a JSON array — the form
    /// `crate::card_row`'s `joined_letters` writes and the form the `instr` arm reads.
    fn seed_cards(conn: &rusqlite::Connection, rows: &[(&str, &str, &str)]) {
        for (id, color_identity, type_line) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                    oracle_id,search_text,raw,color_identity,type_line,type_mask)
                 VALUES (?1,?1,'tst','1','en','normal',1,?1,?1,'{}',?2,?3,?4)",
                rusqlite::params![
                    id,
                    color_identity,
                    type_line,
                    i64::from(crate::cardtypes::type_mask(type_line)),
                ],
            )
            .unwrap();
        }
    }

    /// The five identities the strict/loose difference is visible across: each of the two
    /// picked letters alone, both together, a superset, and the colourless card that fits in
    /// any deck and is the one loose answers most readers do not expect.
    fn corpus_with_colors() -> rusqlite::Connection {
        let conn = crate::schema::memory_pair();
        seed_cards(
            &conn,
            &[
                ("card-colorless", "", "Artifact"),
                ("card-mono-r", "R", "Instant"),
                ("card-mono-w", "W", "Sorcery"),
                ("card-rw", "WR", "Creature — Human Soldier"),
                ("card-wubrg", "WUBRG", "Creature — Elemental"),
            ],
        );
        conn
    }

    /// Strict is exact-set equality on `color_identity`, which is the issue's whole ask:
    /// "cards with fewer than X colors should not match. Cards must include all X colors."
    ///
    /// The axis stays `color_identity` either way — one chip row reading two different columns
    /// depending on a toggle is a control that lies.
    #[test]
    fn strict_colors_answer_the_exact_set_and_nothing_else() {
        let conn = corpus_with_colors();

        assert_eq!(
            search_ids(
                &conn,
                CardFilters {
                    colors: Some("RW".into()),
                    ..Default::default()
                }
            ),
            owned(&["card-colorless", "card-mono-r", "card-mono-w", "card-rw"]),
            "loose is the subset reading, colourless included"
        );
        assert_eq!(
            search_ids(
                &conn,
                CardFilters {
                    colors: Some("RW".into()),
                    colors_strict: Some(true),
                    ..Default::default()
                }
            ),
            owned(&["card-rw"]),
            "strict answers the exact identity and nothing else"
        );
        assert_eq!(
            search_ids(
                &conn,
                CardFilters {
                    colors: Some("W".into()),
                    colors_strict: Some(true),
                    ..Default::default()
                }
            ),
            owned(&["card-mono-w"]),
            "one letter strict drops the colourless card too"
        );

        // Five `instr` clauses and no parameter, strict or loose — the shape that keeps the
        // arm inside `idx_cards_collapse`'s trailing `color_identity`.
        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                colors: Some("RW".into()),
                colors_strict: Some(true),
                ..Default::default()
            },
            "c",
            None,
        );
        let color: Vec<&String> = p
            .wheres
            .iter()
            .filter(|w| w.contains("color_identity"))
            .collect();
        assert_eq!(color.len(), 5, "{color:?}");
        assert!(color.iter().all(|w| w.starts_with("instr(")), "{color:?}");
        assert!(p.params.is_empty(), "the colour arm binds nothing");
    }

    /// `C` is degenerate on purpose and needs no special case: `toggleColor` makes it exclusive
    /// both ways, and the existing arm already means `color_identity = ''`, which *is* the
    /// strict reading of it.
    #[test]
    fn strict_changes_nothing_for_colourless() {
        let conn = corpus_with_colors();
        let loose = search_ids(
            &conn,
            CardFilters {
                colors: Some("C".into()),
                ..Default::default()
            },
        );
        let strict = search_ids(
            &conn,
            CardFilters {
                colors: Some("C".into()),
                colors_strict: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(loose, owned(&["card-colorless"]));
        assert_eq!(strict, loose);
    }

    /// Strict with no colour picked adds no SQL, matching the UI, where the chip is not drawn
    /// until a colour is picked. The arm lives inside the [`nonblank`] guard, so a cleared
    /// control's `""` is the same thing as an absent one.
    #[test]
    fn strict_with_no_colour_picked_is_not_a_filter() {
        let conn = corpus_with_colors();
        let all = search_ids(&conn, no_filters());
        assert_eq!(all.len(), 5);

        for f in [
            CardFilters {
                colors_strict: Some(true),
                ..Default::default()
            },
            CardFilters {
                colors: Some("  ".into()),
                colors_strict: Some(true),
                ..Default::default()
            },
        ] {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            let sql = p.where_sql();
            assert!(!sql.contains("color_identity"), "{sql}");
            assert_eq!(search_ids(&conn, f), all);
        }
    }

    /// Dryad Arbor is the row the whole "every type it has" rule is written for, and the two
    /// plain cards beside it are what tell a working filter from one that answers its own
    /// first word.
    fn corpus_with_types() -> rusqlite::Connection {
        let conn = crate::schema::memory_pair();
        seed_cards(
            &conn,
            &[
                ("card-arbor", "G", "Land Creature — Forest Dryad"),
                ("card-bear", "G", "Creature — Bear"),
                ("card-bolt", "R", "Instant"),
                ("card-forest", "", "Land — Forest"),
                ("card-ritual", "B", "Sorcery"),
            ],
        );
        conn
    }

    fn of_types(types: &[&str]) -> CardFilters {
        CardFilters {
            types: Some(owned(types)),
            ..Default::default()
        }
    }

    /// A filter answers "does this card have this type", so a card with two types is in both —
    /// which is deliberately not `autoCategory.ts`'s one-bucket rule, and a reader who presses
    /// `Creature` and cannot find Dryad Arbor has been told a falsehood.
    #[test]
    fn the_type_filter_matches_every_type_a_card_has() {
        let conn = corpus_with_types();
        assert_eq!(
            search_ids(&conn, of_types(&["Creature"])),
            owned(&["card-arbor", "card-bear"])
        );
        assert_eq!(
            search_ids(&conn, of_types(&["Land"])),
            owned(&["card-arbor", "card-forest"]),
            "the same row answers both chips"
        );
    }

    /// OR within the group, the rarity chips' rule — and one clause with one parameter, which
    /// is the `format` arm's shape and the whole reason `type_mask` is a column rather than a
    /// `LIKE` on `type_line`.
    #[test]
    fn two_types_or_with_each_other() {
        let conn = corpus_with_types();
        assert_eq!(
            search_ids(&conn, of_types(&["Instant", "Sorcery"])),
            owned(&["card-bolt", "card-ritual"])
        );

        let mut p = Predicates::default();
        push_card_filters(&mut p, &of_types(&["Instant", "Sorcery"]), "c", None);
        let types: Vec<&String> = p
            .wheres
            .iter()
            .filter(|w| w.contains("type_mask"))
            .collect();
        assert_eq!(
            types,
            vec!["(c.type_mask & ?) != 0"],
            "one clause, ORed inside the mask"
        );
        assert_eq!(p.params.len(), 1);

        // No `rows` fallback, whatever table the caller joins: a type line is a claim only a
        // card row can make, so an orphaned collection entry fails it.
        let mut joined = Predicates::default();
        push_card_filters(&mut joined, &of_types(&["Instant"]), "c", Some("e"));
        assert!(
            joined.wheres.iter().any(|w| w == "(c.type_mask & ?) != 0"),
            "{:?}",
            joined.wheres
        );
    }

    /// A blank or unrecognised list adds no SQL at all — [`picked_rarities`]/[`picked_sets`]'
    /// rule. A cleared picker sends `[]`, and a word this build has never heard of must read as
    /// "no filter" rather than as an empty wall with no chip drawn to explain it.
    #[test]
    fn an_empty_or_unknown_type_list_is_not_a_filter() {
        let conn = corpus_with_types();
        let all = search_ids(&conn, no_filters());
        assert_eq!(all.len(), 5);

        for f in [
            of_types(&[]),
            of_types(&["Shiny"]),
            of_types(&["", "  "]),
            of_types(&["creature"]),
        ] {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            let sql = p.where_sql();
            assert!(!sql.contains("type_mask"), "{sql}");
            assert_eq!(search_ids(&conn, f), all);
        }

        // Matched exactly: `TYPE_KEYS` holds the capitalised words and the UI sends those same
        // words from one constant, so a lower-cased `creature` above is an unknown word rather
        // than a second spelling rule the mask does not have.
        assert_eq!(
            picked_types(&owned(&["Creature", "Shiny", ""])),
            vec!["Creature"]
        );
        assert!(picked_types(&[]).is_empty());
    }
}
