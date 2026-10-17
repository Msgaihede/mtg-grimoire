//! The card predicates, in one place, so every list that filters cards filters them the
//! same way.
//!
//! Lifted out of [`crate::search`] when the collection needed the same six filters over a
//! *joined* query. Everything here is alias-parameterised (`c` in the search, `c` in the
//! collection's LEFT JOIN) and pushes its parameters in the order it pushes its SQL, which
//! is the invariant the whole builder rests on: `?` binds by position, so a fragment and
//! its parameter must never be separated.
//!
//! Only **this module's own constants** are ever interpolated into the SQL — a colour letter
//! from [`COLORS`] or [`PRODUCED_LETTERS`], a `?`-placeholder list whose *length* is all it
//! carries, the literal `0` an unrecognised value collapses to ([`NO_MATCH`]), the fixed
//! `AND … <> 'weak'` fragment a `strong` [`CardFilters::art_weight_floor`] switches on, a
//! `print_facts` key out of [`fact`]'s closed callers, and the fixed punctuation of a
//! double-faced name (`' // '`) or a mana symbol (`'{'`). No user text reaches the parser:
//! even the format key is looked up in [`crate::legalities`] and bound as the integer bit it
//! names, a tag slug is bound even though it never leaves this app's own tag search, and every
//! word an [`IS_VALUES`] arm compares against — a layout, a promo type, a land's rules-text
//! pattern — is bound as a parameter although it comes out of a `const`. A closed vocabulary
//! decides *which* fragment is emitted; it never writes one.

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

/// The border chips, in the order the filter row draws them — the ids
/// `packages/ui/features/card/printingFilters.ts` already used before they became a filter.
///
/// **A vocabulary over two columns, not a column's own values.** `cards.border_color` holds six
/// words (measured 2026-09-27 on the dev corpus's 109 254 paper printings: black 93 029,
/// borderless 8 947, white 5 149, gold 1 373, silver 666, yellow 90) and only one of them is a
/// chip; `fullart` is `cards.full_art` (2 264); and `regular` is a printing that is neither
/// (98 878). So black, white, gold, silver and yellow are all `regular` — the colour of a
/// border is not what this row asks about, whether there is one is.
///
/// [`picked_borders`] validates against this list and [`crate::index::CardIndex::borders`] is
/// indexed by it, so the SQL and the bitsets run out of vocabulary together.
pub const BORDER_KEYS: [&str; 3] = ["regular", "borderless", "fullart"];

/// The printed-finish chips — **[`crate::schema::FINISHES`] itself, under the name the filter
/// row reads it by**, and never a respelling of it: that constant is the one finish vocabulary
/// (`nonfoil`/`foil`/`etched`), and a fourth finish is a migration step that must reach this
/// list without anybody remembering it is here.
///
/// Matched against `cards.finishes`, a JSON array stored as text. Measured 2026-09-27 on the
/// dev corpus's 109 254 paper printings: `["nonfoil","foil"]` 51 628, `["nonfoil"]` 44 019,
/// `["foil"]` 12 389, `["etched"]` 892, the rest small — so the chips overlap exactly as the
/// border chips do, and a nonfoil-and-foil printing answers both.
pub const FINISH_KEYS: [&str; 3] = crate::schema::FINISHES;

/// The universe filter's two values, in the order the filter row draws them.
///
/// **One column and one word.** `beyond` is a printing whose `cards.promo_types` holds
/// [`UNIVERSES_BEYOND`] — Scryfall's own mark, what its `is:universesbeyond` reads — and
/// `within` is every printing that does not (the owner's definition, 2026-10-17). Scryfall
/// has no "Universes Within" word of its own, so the second half is the complement and not a
/// list anybody keeps.
///
/// **A printing's fact, not a card's.** A Sol Ring printed in a Lord of the Rings Commander
/// deck is `beyond` and its Commander Legends printing is `within`, so a collapsed search
/// answers both values with Sol Ring — represented by a printing that matches — exactly as
/// Scryfall's `unique=cards` does. A copy in a binder is one printing, which is the question a
/// collection asks.
pub const UNIVERSE_KEYS: [&str; 2] = ["beyond", "within"];

/// The `promo_types` member Scryfall marks a Universes Beyond printing with. **Bound, never
/// interpolated**, like [`BORDERLESS`].
pub const UNIVERSES_BEYOND: &str = "universesbeyond";

/// The value `cards.border_color` holds for a printing with no border — the one word of its
/// six that is a chip. **Bound, never interpolated**, so the module note's list of what reaches
/// the SQL text stays four items long.
const BORDERLESS: &str = "borderless";

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
/// **[`Self::Name`], [`Self::TypeLine`] and [`Self::OracleText`] ride in the same list as the
/// other fields and are emitted by [`fts_match`], never by [`push_card_filters`] — at the top
/// level.** `LIKE` over either text column measured **80x to 250x** slower than the FTS5
/// column filter they take instead, on the real corpus (spec §5.2), and a box that fires on a
/// debounce cannot pay that. So the match in [`predicate_clause`] names every variant and has
/// no `_` arm: **a field handled by neither side is a filter that silently does nothing**,
/// which is the one failure this split can produce and the reason there is a census test over
/// both sides.
///
/// Two exceptions to "the three ride the MATCH", and both are about where the term *stands*
/// rather than what it says (issue #909):
///
/// * **Inside a group** ([`Self::AnyOf`] / [`Self::AllOf`]) an FTS field cannot join the one
///   top-level `MATCH`: `t:goblin or t:elf` is a disjunction of two index lookups, and the
///   statement's single `MATCH` is a conjunction with everything beside it. So a grouped FTS
///   term is its own `{alias}.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`
///   — the same lookup the collection already makes for its free text, one term at a time.
/// * **`!name` is SQL, not FTS.** An exact name is equality on `cards.name` (or on either face
///   of an `A // B`), which FTS's prefix tokens cannot spell — `name : ("lightning"* +
///   "bolt"*)` also answers *Lightning Bolt Elemental*.
///
/// Closed, so the boundary is type-checked rather than stringly typed; the camelCase serde
/// names are the contract `packages/ui/lib/ipc.ts` mirrors and `ipc.test.ts` fences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PredicateField {
    /// The card's name and nothing else — Scryfall's `-bolt`, `-"lightning bolt"` (issue #571)
    /// and `name:bolt`; with [`PredicateOp::Eq`] it is Scryfall's `!"lightning bolt"`, an exact
    /// name answered in SQL rather than through the index (issue #909). A *positive* bare word
    /// stays [`CardFilters::text`] and matches every FTS column. The two directions differ on
    /// purpose — see [`fts_match`].
    Name,
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
    /// Scryfall's `or`: at least one of [`QueryPredicate::terms`] holds. The op is ignored and
    /// the value is `""`. See [`group_clause`] for what a blank child means here.
    AnyOf,
    /// A parenthesised conjunction — sent only where it cannot be flattened into the top level:
    /// negated (`-(t:goblin t:creature)`) or nested inside an [`Self::AnyOf`].
    AllOf,
    /// A bare word **inside a group**: FTS over every column, exactly as the free text is at
    /// the top level. The grammar never sends one at the top level, where free text keeps its
    /// own path; one that arrives there is answered by the same subquery.
    Text,
    /// An oracle tag *named* (`otag:ramp`) inside a group, resolved in SQL by its normalised
    /// name — the top level resolves tags through `tag_resolve` and the chip row instead.
    OracleTag,
    /// [`Self::OracleTag`]'s art twin, over the illustration.
    ArtTag,
    /// `ft:` — the flavour text, over `print_facts` (corpus schema 8).
    Flavor,
    /// `wm:` — the watermark's name, over `print_facts`.
    Watermark,
    /// `m:` — the printed mana cost as a multiset of symbols.
    ManaCost,
    /// `devotion:` — how many of one colour's (or one hybrid pair's) symbols the cost holds.
    Devotion,
    /// `produces:` — the colours of mana the card can add, as a letter set over WUBRGC.
    Produces,
    /// `loy:` — starting loyalty, over `print_facts`.
    Loyalty,
    /// `pt:` — power plus toughness.
    PowTou,
    /// `cn:` — the collector number, numeric when the value is a number.
    CollectorNumber,
    /// `st:` — the set's type (`expansion`, `masters`, `funny`, …), through `sets`.
    SetType,
    /// `b:` — a block, by its code, its name, or any set in it.
    Block,
    /// `in:` — some printing of this card answers it (a game, a rarity, a language, a set).
    InPrinting,
    /// `game:` — `paper`, `arena` or `mtgo`.
    Game,
    /// `lang:` — the printing's language, by code or by name.
    Language,
    /// `year:` — the printing's release year.
    Year,
    /// `date:` — the printing's release date, or a set's.
    Date,
    /// `usd:` — the printing's dollar price.
    Usd,
    /// `eur:` — the printing's euro price.
    Eur,
    /// `tix:` — the printing's MTGO ticket price.
    Tix,
    /// `border:` — `cards.border_color`'s own word, which the border *chips* deliberately are
    /// not ([`BORDER_KEYS`]).
    Border,
    /// `frame:` — a frame year (`print_facts`) or a frame effect (`cards.frame_effects`).
    Frame,
    /// `stamp:` — the security stamp, over `print_facts`.
    Stamp,
    /// `banned:` — banned in a format, from the `legalities` JSON (the mask folds banned and
    /// not-legal together, so it cannot answer this).
    Banned,
    /// `restricted:` — [`Self::Banned`]'s twin.
    Restricted,
    /// `prints:` — how many printings this card has.
    Prints,
    /// `paperprints:` — how many paper printings this card has.
    PaperPrints,
    /// `sets:` — how many sets this card was printed in.
    Sets,
    /// `papersets:` — how many sets this card was printed in on paper.
    PaperSets,
    /// `new:` — this printing is the first with its art, artist, flavour, frame, language or
    /// rarity, or the card's first printing at all.
    NewFeature,
    /// `is:` and `not:` — a closed vocabulary, [`IS_VALUES`].
    Is,
    /// `has:` — `watermark`, `indicator`, `flavor` or `stamp` is present.
    Has,
}

/// One [`QueryPredicate`]'s comparison.
///
/// **[`Self::Colon`] is Scryfall's `:` and means a different thing per field**, which is the
/// trap worth stating first: `c:rg` is `c>=rg` and answers 676 cards, while `id:rg` is
/// `id<=rg` and answers 13 399 (both measured on Scryfall, 2026-09-22). So it stays a variant
/// of its own and is resolved per field by [`default_op`] rather than folded into `Eq`
/// anywhere. The grammar in `packages/ui/features/search/queryLanguage.ts` resolves it at the edge for
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
/// **Parsed in TypeScript and never here.** `packages/ui/features/search/queryLanguage.ts` reads the
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
    /// The children of an [`PredicateField::AnyOf`] or [`PredicateField::AllOf`] — empty, and
    /// absent on the wire, for every other field.
    ///
    /// **Recursive, and bounded by the deserialiser rather than here**: `serde_json` refuses a
    /// payload nested past its own recursion limit (128) before this crate sees it, so a
    /// hand-built request cannot walk [`group_clause`] off the stack. The grammar unwraps a
    /// single-child group and drops an empty one, so what a reader types is far shallower.
    #[serde(default)]
    pub terms: Vec<QueryPredicate>,
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
    /// The border chips — [`BORDER_KEYS`] entries. OR within, AND without, exactly like
    /// [`Self::types`].
    ///
    /// **Three chips over two columns, and they overlap.** `borderless` reads
    /// `cards.border_color`, `fullart` reads `cards.full_art`, and `regular` is the printing that
    /// is **neither** — so a borderless full-art printing (835 of the 2 264 full-art paper
    /// printings, measured 2026-09-27 on the dev corpus of 109 254) answers both of the first two
    /// chips and not the third. That is the types' "does this card have this" reading rather than
    /// a partition, and it is why the counts do not sum to a total.
    pub borders: Option<Vec<String>>,
    /// The finish chips over the **printing** — [`FINISH_KEYS`] entries, "is this printing
    /// published in this finish", which is Scryfall's `is:foil`. OR within, AND without.
    ///
    /// **Not the collection's `finishes`**, which is the finish one *copy* is in and lives on
    /// [`crate::collection::CollectionQuery`] beside this struct's flattened fields. The two
    /// would collide on that flattened payload under one name, which is the whole reason this
    /// one is `printedFinishes` on the wire; the two AND with each other if both are sent, and
    /// they are different questions — a nonfoil copy of a printing that also exists in foil
    /// answers `printedFinishes: ["foil"]` and fails `finishes: ["foil"]`.
    pub printed_finishes: Option<Vec<String>>,
    /// Universes Beyond or Universes Within — one of [`UNIVERSE_KEYS`], or absent for both.
    ///
    /// **Single-valued, because the two values partition the corpus**: both at once is no
    /// filter, so the wire carries the one the reader narrowed to and nothing when they did
    /// not. A word outside the list is no filter either — it fails open, like
    /// [`Self::art_weight_floor`], rather than emptying the result over a typo in a hand-built
    /// payload. See [`UNIVERSE_KEYS`] for why it is a printing's fact.
    pub universe: Option<String>,
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
    ///
    /// **A printing that has not been released yet counts as playable** (issue #940): Scryfall
    /// marks a previewed card legal nowhere until its release day, so the mask alone hid every
    /// spoiler. See [`unreleased_sql`].
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
    /// **Three fields add no SQL here at the top level** (and `name` only when it is not an
    /// exact name) and are picked up by [`fts_match`] instead; [`PredicateField`] says which,
    /// why, and why a group is the exception.
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
    let toks = fts_tokens(text);
    (!toks.is_empty()).then(|| toks.join(" "))
}

/// [`fts_query`]'s tokens as one **ordered phrase** — `"lightning"* + "bolt"*` — or `None`
/// when nothing indexable is left.
///
/// FTS5's `+` joins phrases into one whose tokens must stand adjacent and in order, and each
/// keeps its own `*`. That is Scryfall's reading of a quoted name, measured live 2026-09-27:
/// `t:instant -"lightning bolt"` drops 2 of 3,909 instants while `-"bolt lightning"` drops
/// none. The unordered [`fts_query`] would drop Lightning Bolt for both. Measured on the dev
/// corpus the same day, `name : ("guide"* + "goblin"*)` finds nothing where the unordered form
/// finds Goblin Guide. Only [`PredicateField::Name`] reads this; `t:` and `o:` keep the
/// unordered form they shipped with. A single word is the same string either way.
///
/// **One edge it cannot see**: a double-faced card's `name` is `Front // Back`, and `//` is not
/// a token, so `"bolt" + "lightning"*` finds `Lightning Bolt // Lightning Bolt` across the
/// seam. Scryfall's substring would not. Harmless in the direction it errs — it removes a card
/// that *does* carry both words.
pub fn fts_phrase(text: &str) -> Option<String> {
    let toks = fts_tokens(text);
    (!toks.is_empty()).then(|| toks.join(" + "))
}

/// The quoted, prefix-matched tokens both builders above join — the splitting rule and the
/// reason for it are [`fts_query`]'s.
fn fts_tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect()
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
///
/// **[`PredicateField::Name`] is `name` alone, as an ordered phrase ([`fts_phrase`]), while the
/// free text beside it has no column filter at all** — so `bolt` matches a name, a type line or
/// rules text and `-bolt` removes only the names. That asymmetry is Scryfall's: `-bolt` is
/// `-name:bolt` there (`t:instant` 3,909, both negations 3,891, measured 2026-09-27). Reading
/// every column would make `-goblin` remove 2,224 printings on the dev corpus rather than the
/// 969 actually called Goblin, taking every Goblin creature and every card that makes one with
/// them.
///
/// **Three kinds of term are skipped here and answered by [`push_card_filters`] instead**
/// (issue #909): a group ([`PredicateField::AnyOf`] / [`PredicateField::AllOf`]), whose FTS
/// children cannot join a `MATCH` that is a conjunction with everything beside it; an exact
/// name (`name` with [`PredicateOp::Eq`]), which is equality and not a token prefix; and
/// [`PredicateField::Text`], which the grammar sends only inside a group. The facet index
/// calls this same function and so skips them too — its counts read wider under a group,
/// which is the documented direction for every predicate the index has no dimension for.
pub fn fts_match(text: Option<&str>, preds: &[QueryPredicate]) -> (Option<String>, Vec<String>) {
    let mut positive: Vec<String> = Vec::new();
    let mut negative: Vec<String> = Vec::new();

    if let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) {
        if let Some(query) = fts_query(text) {
            positive.push(query);
        }
    }

    for pred in preds {
        if !rides_the_match(pred) {
            // SQL, and `push_card_filters` is where it is emitted.
            continue;
        }
        let Some(term) = fts_column_term(pred) else {
            continue;
        };
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

/// Whether a **top-level** term joins [`fts_match`]'s `MATCH` rather than becoming SQL: the
/// three FTS fields, less an exact name.
///
/// The one place that split is written, so [`fts_match`] and [`predicate_clause`] cannot
/// disagree about it — a term both sides claimed would be applied twice (harmless), and a term
/// neither claimed would be a filter that silently does nothing (the failure the census test
/// exists for).
fn rides_the_match(pred: &QueryPredicate) -> bool {
    match pred.field {
        PredicateField::Name => pred.op != PredicateOp::Eq,
        PredicateField::TypeLine | PredicateField::OracleText => true,
        _ => false,
    }
}

/// One FTS term's column-filtered `MATCH` fragment — `type_line : ("goblin"*)` — or `None`
/// when the value tokenises to nothing or the field is not an FTS field.
///
/// The column is `name` (an ordered phrase, [`fts_phrase`]), `type_line` or `search_text`;
/// [`fts_match`]'s doc carries why each. The parentheses are what make
/// `type_line : ("a"* "b"*)` two terms *in that column* rather than one term in it and one
/// anywhere. Shared by the top-level `MATCH` and by a grouped term's own subquery
/// ([`fts_subquery`]), so the two spell a term identically.
fn fts_column_term(pred: &QueryPredicate) -> Option<String> {
    let (column, query) = match pred.field {
        PredicateField::Name => ("name", fts_phrase(&pred.value)),
        PredicateField::TypeLine => ("type_line", fts_query(&pred.value)),
        PredicateField::OracleText => ("search_text", fts_query(&pred.value)),
        _ => return None,
    };
    query.map(|query| format!("{column} : ({query})"))
}

/// One `MATCH` string as a clause of its own over `{alias}.rowid` — how an FTS term is
/// answered where it cannot join the statement's one `MATCH` (inside a group, or a top-level
/// [`PredicateField::Text`]).
///
/// A subquery over the rowid rather than a join, for the collection's reason
/// (`collection::scope`): over a LEFT JOIN an orphan's rowid is NULL, a joined FTS5 constraint
/// *drops* a NULL rowid rather than failing it, and `NULL IN (…)` is the answer an orphan is
/// owed. `None` when there is nothing to match — the blank-child rule [`group_clause`] reads.
fn fts_subquery(alias: &str, query: Option<String>) -> Option<Clause> {
    query.map(|query| {
        (
            format!("{alias}.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)"),
            vec![Box::new(query) as Box<dyn rusqlite::ToSql>],
        )
    })
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

/// "This printing is not out yet": its `released_at` is after SQLite's UTC `date('now')`.
///
/// The one spelling of the test, shared by [`CardFilters::playable_only`] and the facet index's
/// `playable` bitset ([`crate::index::CardIndex::build`]) so the counts and the wall agree. UTC
/// and the engine's clock rather than a bound parameter, the same "today" the home page's
/// Coming soon window ([`crate::upcoming_sets`]) measures from. A NULL date is never in the
/// future, so an undated printing is decided by its mask alone.
pub fn unreleased_sql(alias: &str) -> String {
    format!("{alias}.released_at > date('now')")
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

    // OR within, AND without, as one parenthesised group — the mana arm's shape, because the
    // three chips read two columns and so cannot be one `IN (…)`. A list naming nothing this
    // build knows adds no SQL, which is [`picked_types`]' rule.
    //
    // **`regular` is "neither", spelled out.** A NULL `border_color` is read as a border rather
    // than as its absence — `coalesce(…, '')` — because the column is nullable in the schema and
    // a printing Scryfall published no border for has not been published *borderless*: the one
    // chip that asks for the missing border must see the word. `full_art` is `NOT NULL DEFAULT
    // 0`, so on a card row it is never the NULL here.
    //
    // `{alias}.…` with no `rows` fallback, like the type and rarity arms: a frame is a claim only
    // a card row can make, so an orphaned collection entry fails every chip — `NULL = ?` and
    // `NULL = 1` are NULL, and `regular`'s `AND NULL = 0` is NULL even though its `coalesce`
    // half is true.
    if let Some(borders) = f.borders.as_deref() {
        let picked = picked_borders(borders);
        if !picked.is_empty() {
            let mut alternatives: Vec<String> = Vec::new();
            for border in &picked {
                match border.as_str() {
                    "borderless" => {
                        alternatives.push(format!("{alias}.border_color = ?"));
                        p.params.push(Box::new(BORDERLESS));
                    }
                    "fullart" => alternatives.push(format!("{alias}.full_art = 1")),
                    "regular" => {
                        alternatives.push(format!(
                            "(coalesce({alias}.border_color, '') <> ? AND {alias}.full_art = 0)"
                        ));
                        p.params.push(Box::new(BORDERLESS));
                    }
                    // `picked_borders` validated against `BORDER_KEYS`, whose three words are
                    // the three arms above — this arm is a fence against that list growing
                    // without this match learning the new word, and it adds nothing rather
                    // than matching nothing.
                    _ => {}
                }
            }
            if !alternatives.is_empty() {
                p.wheres.push(format!("({})", alternatives.join(" OR ")));
            }
        }
    }

    // The printing's **published** finishes, OR within and AND without. `cards.finishes` is a
    // JSON array stored as text (`["nonfoil","foil"]`), and the needle carries its quotes, so
    // `"foil"` cannot match inside `"nonfoil"` — the delimiter is the whole of what separates
    // them, which is `kw:`'s wrapped `|flying|` argument one column over. `instr` rather than
    // `json_each`, because a table-valued function per row is a correlated subquery and this
    // column's shape is written by this app's own ingest, one word per finish.
    //
    // Bound rather than interpolated, although every needle comes out of [`FINISH_KEYS`].
    //
    // `{alias}.finishes` with no `rows` fallback: the finishes a printing is *published* in are
    // a claim only a card row can make — the collection entry's own `finish` is the copy's, and
    // a different question. An orphan fails every chip: `instr(NULL, ?)` is NULL.
    if let Some(finishes) = f.printed_finishes.as_deref() {
        let picked = picked_finishes(finishes);
        if !picked.is_empty() {
            let alternatives = vec![format!("instr({alias}.finishes, ?) > 0"); picked.len()];
            p.wheres.push(format!("({})", alternatives.join(" OR ")));
            for finish in picked {
                p.params.push(Box::new(format!("\"{finish}\"")));
            }
        }
    }

    // Universes Beyond is Scryfall's word in `promo_types` (quoted, like the finishes' needle,
    // so no other member can contain it), and Within is its complement. `promo_types` is NULL
    // on most printings, so Within reads it through `coalesce` — and then needs `{alias}.id`
    // to keep an orphaned collection entry failing it, as it fails Beyond (`instr(NULL, ?)` is
    // NULL): the universe is a claim only a card row can make.
    if let Some(universe) = picked_universe(&f.universe) {
        let sql = match universe {
            "beyond" => format!("instr({alias}.promo_types, ?) > 0"),
            _ => format!(
                "({alias}.id IS NOT NULL AND coalesce(instr({alias}.promo_types, ?), 0) = 0)"
            ),
        };
        p.push(sql, Box::new(format!("\"{UNIVERSES_BEYOND}\"")));
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
    //
    // **An unreleased printing passes too** (issue #940). Scryfall marks a previewed card legal
    // nowhere until its set's release day, so the mask alone hid every spoiler from the
    // search view's default row. `released_at` is in the same covering index, so the `OR`
    // costs the scan nothing; a NULL date is not in the future and adds nothing. See
    // [`unreleased_sql`] for why "today" is SQLite's.
    if f.playable_only.unwrap_or(false) {
        p.wheres.push(format!(
            "({alias}.legal_mask != 0 OR {})",
            unreleased_sql(alias)
        ));
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
    // every card at once and empties the result silently. All four production callers pass
    // `"c"` (`search.rs`, `collection.rs`, `wishlist.rs`, `deck_query.rs`), so a fifth one is
    // the only way in and nothing else in the suite would go red for it.
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
    // **The top-level FTS terms come out of here as nothing at all**, because the FTS builder
    // owns them; [`predicate_clause`] returns `None` for those and [`PredicateField`] says
    // why. Every other `None` it can answer is a blank value, which is [`nonblank`]'s rule
    // one shape along: a term with nothing after its operator is no filter, never a filter
    // matching nothing.
    //
    // `wheres` and `params` are pushed together per predicate rather than through
    // [`Predicates::push`], because several arms bind more than one parameter (the keyword
    // bridge binds two, an ordered rarity binds up to four, a group binds all of its
    // children's) and `?` binds by position.
    debug_assert!(
        !INNER_ALIASES.contains(&alias),
        "a caller alias equal to a predicate subquery's alias uncorrelates it"
    );
    for pred in f.predicates.iter().flatten() {
        if let Some((sql, params)) = predicate_clause(pred, alias, &set_code, false) {
            p.wheres.push(sql);
            p.params.extend(params);
        }
    }
}

/// A clause that is syntactically a predicate and matches no row, for the values that name
/// nothing this build knows — an unrecognised format, a rarity outside the ordered four, a
/// mana value that is not a number, an `is:` word outside [`IS_VALUES`].
///
/// Spelled `0` rather than "push no clause at all", which is the choice the format arm of
/// [`push_card_filters`] made first and for the same reason: leaving it out turns an unknown
/// term into *no filter* and quietly returns the whole corpus, which is a search that answers
/// more than it was asked and says nothing about it.
const NO_MATCH: &str = "0";

/// One predicate's SQL and the parameters it binds, in the order its `?`s stand.
///
/// A pair rather than a [`Predicates`], because a clause is built to be *nested* — inside a
/// group, inside `NOT (…)`, beside another clause in an `AND` — and only the outermost one is
/// pushed. Every combinator below ([`join`], [`not`]) concatenates the parameters in the same
/// order it concatenates the text, which is the module's one invariant carried down a level.
type Clause = (String, Vec<Box<dyn rusqlite::ToSql>>);

/// The aliases this module's predicate subqueries give an inner table: `pr` (another printing
/// of the same card, for the counts and `new:`), `pi` (a printing `in:` asks about), `ss` and
/// `sb` (`sets`), `otg`/`atg` (the tag tables a grouped tag name resolves through), and the
/// two closure aliases the chip arms already used.
///
/// **A caller alias equal to one of them uncorrelates its subquery**, for the reason the tag
/// arms' `debug_assert` gives: SQLite resolves a qualified name against the innermost `FROM`
/// first, so `pr.oracle_id = pr.oracle_id` is no longer a correlation and a print count would
/// count the whole corpus. [`push_card_filters`] asserts against this list.
const INNER_ALIASES: [&str; 8] = ["pr", "pi", "ss", "sb", "otg", "atg", "ati", "otc"];

/// The rarities `cards.rarity` can be compared *in order*, weakest first.
///
/// Measured on Scryfall 2026-09-22: `r>=rare` answers 13 951 and `r:rare` answers 11 856, so
/// rarity is an enum with an order and `:` on it is **equality**, not "at least". Scryfall's
/// `special` and `bonus` are deliberately absent: they have no place in this ladder, so an
/// ordered operator naming one answers [`NO_MATCH`] while `r:special` still works as equality.
const RARITY_ORDER: [&str; 4] = ["common", "uncommon", "rare", "mythic"];

/// Every rarity word `cards.rarity` holds — the ladder plus the two off it. `in:` reads a value
/// against this list before it decides the value is a set code.
pub(crate) const ALL_RARITIES: [&str; 6] =
    ["common", "uncommon", "rare", "mythic", "special", "bonus"];

/// The games Scryfall's `games` array names. `in:` reads a value against this list first.
const GAMES: [&str; 5] = ["paper", "arena", "mtgo", "astral", "sega"];

/// The frame *years* `frame:` reads from `print_facts`; any other `frame:` word is a frame
/// effect (`legendary`, `showcase`, `extendedart`, …) and reads `cards.frame_effects`.
const FRAME_YEARS: [&str; 5] = ["1993", "1997", "2003", "2015", "future"];

/// Scryfall's language codes and the names `lang:` also accepts for each, folded the way
/// [`language_code`] folds a value (lower case, separators dropped).
const LANGUAGES: [(&str, &[&str]); 18] = [
    ("en", &["english"]),
    ("es", &["spanish"]),
    ("fr", &["french"]),
    ("de", &["german"]),
    ("it", &["italian"]),
    ("pt", &["portuguese"]),
    ("ja", &["japanese"]),
    ("ko", &["korean"]),
    ("ru", &["russian"]),
    ("zhs", &["simplifiedchinese", "chinese"]),
    ("zht", &["traditionalchinese"]),
    ("he", &["hebrew"]),
    ("la", &["latin"]),
    ("grc", &["ancientgreek", "greek"]),
    ("ar", &["arabic"]),
    ("sa", &["sanskrit"]),
    ("ph", &["phyrexian"]),
    ("qya", &["quenya"]),
];

/// The letters `cards.produced_mana` can hold — [`COLORS`] and `C`, which Scryfall emits for
/// colourless mana and which is a real answer to `produces:` where it is no colour at all.
/// Interpolated into SQL, so it must stay a hard-coded list.
const PRODUCED_LETTERS: [&str; 6] = ["W", "U", "B", "R", "G", "C"];

/// The colour *names* a `c:`/`id:` value may be, and the WUBRG letters each names (issue
/// #909). The empty string is colourless.
///
/// **Checked before the letters, and that is not a nicety** — see [`color_value`]: `grixis`
/// scanned letter by letter is G and R, `bant` is B, and `green` is G *and* R. The guilds, the
/// Strixhaven colleges, the shards, the wedges and the four-colour Nephilim names (short and
/// long) are Scryfall's own list; `packages/ui/features/search/queryLanguage.ts` validates
/// against the same names and resolves none of them, so this table is the one place a name
/// becomes letters.
const COLOR_NAMES: [(&str, &str); 45] = [
    ("white", "W"),
    ("blue", "U"),
    ("black", "B"),
    ("red", "R"),
    ("green", "G"),
    ("c", ""),
    ("colorless", ""),
    ("colourless", ""),
    ("azorius", "WU"),
    ("dimir", "UB"),
    ("rakdos", "BR"),
    ("gruul", "RG"),
    ("selesnya", "GW"),
    ("orzhov", "WB"),
    ("izzet", "UR"),
    ("golgari", "BG"),
    ("boros", "RW"),
    ("simic", "GU"),
    ("silverquill", "WB"),
    ("prismari", "UR"),
    ("witherbloom", "BG"),
    ("lorehold", "RW"),
    ("quandrix", "GU"),
    ("bant", "GWU"),
    ("esper", "WUB"),
    ("grixis", "UBR"),
    ("jund", "BRG"),
    ("naya", "RGW"),
    ("abzan", "WBG"),
    ("jeskai", "URW"),
    ("sultai", "BGU"),
    ("mardu", "RWB"),
    ("temur", "GUR"),
    ("glint", "UBRG"),
    ("glinteye", "UBRG"),
    ("dune", "WBRG"),
    ("dunebrood", "WBRG"),
    ("ink", "WURG"),
    ("inktreader", "WURG"),
    ("witch", "WUBG"),
    ("witchmaw", "WUBG"),
    ("yore", "WUBR"),
    ("yoretiller", "WUBR"),
    ("wubrg", "WUBRG"),
    ("fivecolor", "WUBRG"),
];

/// What `:` means on a given field.
///
/// The one-line version of [`PredicateOp`]'s note: `c:rg` is `c>=rg` and `id:rg` is `id<=rg`,
/// so a single rule for `:` would get one of the two wrong by a factor of twenty. The fields
/// whose default really is `:` (contains) return it unchanged and are matched by their own
/// arms; the letter-set and multiset fields default to "at least"; everything that names one
/// value — a set type, an `is:` word, a number — defaults to equality.
///
/// **Every variant, and no `_` arm**, for [`predicate_clause`]'s reason.
fn default_op(field: PredicateField) -> PredicateOp {
    match field {
        PredicateField::Name
        | PredicateField::TypeLine
        | PredicateField::OracleText
        | PredicateField::Keyword
        | PredicateField::Artist
        | PredicateField::AnyOf
        | PredicateField::AllOf
        | PredicateField::Text
        | PredicateField::OracleTag
        | PredicateField::ArtTag
        | PredicateField::Flavor => PredicateOp::Colon,
        PredicateField::Colors
        | PredicateField::ManaCost
        | PredicateField::Devotion
        | PredicateField::Produces => PredicateOp::Gte,
        PredicateField::ColorIdentity => PredicateOp::Lte,
        PredicateField::Cmc
        | PredicateField::Power
        | PredicateField::Toughness
        | PredicateField::Rarity
        | PredicateField::SetCode
        | PredicateField::Format
        | PredicateField::Watermark
        | PredicateField::Loyalty
        | PredicateField::PowTou
        | PredicateField::CollectorNumber
        | PredicateField::SetType
        | PredicateField::Block
        | PredicateField::InPrinting
        | PredicateField::Game
        | PredicateField::Language
        | PredicateField::Year
        | PredicateField::Date
        | PredicateField::Usd
        | PredicateField::Eur
        | PredicateField::Tix
        | PredicateField::Border
        | PredicateField::Frame
        | PredicateField::Stamp
        | PredicateField::Banned
        | PredicateField::Restricted
        | PredicateField::Prints
        | PredicateField::PaperPrints
        | PredicateField::Sets
        | PredicateField::PaperSets
        | PredicateField::NewFeature
        | PredicateField::Is
        | PredicateField::Has => PredicateOp::Eq,
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

// -------------------------------------------------------------------------------------
// Clause combinators. Each keeps text and parameters in one order.
// -------------------------------------------------------------------------------------

/// A clause with nothing to bind.
fn plain(sql: String) -> Clause {
    (sql, Vec::new())
}

/// [`NO_MATCH`] as a clause.
fn no_match() -> Clause {
    plain(NO_MATCH.to_owned())
}

/// A clause with one parameter.
fn bound<T: rusqlite::ToSql + 'static>(sql: String, value: T) -> Clause {
    (sql, vec![Box::new(value)])
}

/// Clauses joined by `sep` inside one pair of parentheses, their parameters concatenated in
/// the same order — so an `OR` inside cannot reach across the `AND` the result stands in.
fn join(parts: Vec<Clause>, sep: &str) -> Clause {
    let mut sql: Vec<String> = Vec::with_capacity(parts.len());
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for (s, p) in parts {
        sql.push(s);
        params.extend(p);
    }
    (format!("({})", sql.join(sep)), params)
}

fn all_of(parts: Vec<Clause>) -> Clause {
    join(parts, " AND ")
}

fn any_of(parts: Vec<Clause>) -> Clause {
    join(parts, " OR ")
}

fn not((sql, params): Clause) -> Clause {
    (format!("NOT ({sql})"), params)
}

/// `!=` on a field whose every other operator means equality: the equality, negated.
/// Wrapped rather than inverted per arm, for the leading `-`'s reason — an arm that inverted
/// itself would have to get every NULL right twice.
fn negate_if(ne: bool, clause: Clause) -> Clause {
    if ne {
        not(clause)
    } else {
        clause
    }
}

/// `expr LIKE p1 OR expr LIKE p2 …`, every pattern bound.
///
/// **The patterns are this module's constants, and their `%` and `_` are wildcards on
/// purpose** — `{_}` in a land's pattern is "any one mana symbol's letter" — so there is no
/// `ESCAPE` clause here, unlike every `LIKE` built from a reader's text ([`escape_like`]).
fn like_any(expr: &str, patterns: &[&'static str]) -> Clause {
    any_of(
        patterns
            .iter()
            .map(|p| bound(format!("{expr} LIKE ?"), *p))
            .collect(),
    )
}

// -------------------------------------------------------------------------------------
// Colours, letters and symbols
// -------------------------------------------------------------------------------------

/// What a `c:`/`id:` value names.
enum ColorValue {
    /// A set of WUBRG letters, in [`COLORS`] order; empty is colourless.
    Letters(Vec<&'static str>),
    /// `m` / `multicolor`: two colours or more.
    Multicolor,
    /// A bare number — how *many* colours (`c=2`, `id>=3`).
    Count(f64),
}

/// The letters a colour *name* in [`COLOR_NAMES`] stands for, or `None` for a value that is
/// not one. `value` is already trimmed and lower-cased.
fn color_name_letters(value: &str) -> Option<&'static str> {
    COLOR_NAMES
        .iter()
        .find(|(name, _)| *name == value)
        .map(|(_, letters)| *letters)
}

/// Read a colour value: a count, `m`, a name, or letters — in that order.
///
/// **The whole-word colour names are checked before the letters, and that is not a nicety**:
/// `green` scanned letter by letter is `G` *and* `R`, which is a two-colour question the
/// reader did not ask, and `grixis` would be the same mistake with a different answer. An
/// empty answer is colourless — `c`, `colorless`, `colourless`, and anything else with no
/// WUBRG letter in it at all.
///
/// **Case-folded here because nothing folds it earlier.** The grammar canonicalises a rarity
/// before it sends one and canonicalises nothing else, so `c:RG` and `c:rg` both arrive
/// exactly as typed — a comparison that assumed either case would answer zero rows silently,
/// which reads as "no cards" rather than as a bug.
fn color_value(value: &str) -> ColorValue {
    let value = value.trim().to_ascii_lowercase();
    if matches!(value.as_str(), "m" | "multi" | "multicolor" | "multicolour") {
        return ColorValue::Multicolor;
    }
    if let Ok(n) = value.parse::<f64>() {
        return ColorValue::Count(n);
    }
    let letters = match color_name_letters(&value) {
        Some(named) => COLORS
            .iter()
            .filter(|c| named.contains(**c))
            .copied()
            .collect(),
        None => {
            let upper = value.to_ascii_uppercase();
            COLORS
                .iter()
                .filter(|c| upper.contains(**c))
                .copied()
                .collect()
        }
    };
    ColorValue::Letters(letters)
}

/// How many WUBRG letters `column` holds, as an integer expression — five `instr` booleans
/// summed, so a stray character or a repeated letter cannot inflate it.
fn color_count(column: &str) -> String {
    let terms: Vec<String> = COLORS
        .iter()
        .map(|ch| format!("(instr(coalesce({column},''), '{ch}') > 0)"))
        .collect();
    format!("({})", terms.join(" + "))
}

/// A letter-set comparison over `column` — `cards.colors`, `cards.color_identity` or
/// `cards.produced_mana`, against `alphabet` ([`COLORS`] or [`PRODUCED_LETTERS`]).
///
/// **`gte` is "has at least these letters" and `lte` is "has no letter outside them"**, which
/// are Scryfall's `c:` and `id:` respectively. The subset arm is [`push_card_filters`]'
/// existing exclusion idiom reused rather than re-derived, down to its `coalesce(…,'')` — so it
/// inherits that arm's behaviour on a NULL column, where a row with no letters is inside every
/// set and outside every "has at least" test.
///
/// The letters are interpolated, never bound, and that is safe for [`COLORS`]' reason: they
/// come out of a `const` and nothing a reader types can reach the SQL text. `named` must not
/// be empty — the colourless question is [`color_clause`]'s, asked before this.
fn letters_clause(
    column: &str,
    op: PredicateOp,
    named: &[&'static str],
    alphabet: &[&'static str],
) -> Clause {
    let at_least = {
        let terms: Vec<String> = named
            .iter()
            .map(|ch| format!("instr(coalesce({column},''), '{ch}') > 0"))
            .collect();
        format!("({})", terms.join(" AND "))
    };
    let within = {
        let terms: Vec<String> = alphabet
            .iter()
            .filter(|ch| !named.contains(ch))
            .map(|ch| format!("instr(coalesce({column},''), '{ch}') = 0"))
            .collect();
        if terms.is_empty() {
            // Every letter named: every combination is inside it.
            "1".to_owned()
        } else {
            format!("({})", terms.join(" AND "))
        }
    };
    let exactly = format!("({at_least} AND {within})");

    plain(match op {
        PredicateOp::Colon => at_least,
        PredicateOp::Eq => exactly,
        PredicateOp::Ne => format!("NOT {exactly}"),
        PredicateOp::Gte => at_least,
        PredicateOp::Gt => format!("({at_least} AND NOT {exactly})"),
        PredicateOp::Lte => within,
        PredicateOp::Lt => format!("({within} AND NOT {exactly})"),
    })
}

/// A colour comparison over `column` — `cards.colors` or `cards.color_identity` — for any of
/// the four things a value can be ([`color_value`]).
///
/// * **Colourless is its own question and every operator collapses onto it**, because the
///   empty set is the bottom of this lattice: `c:c`, `c=c` and `c<=c` all mean "is
///   colourless", and reading `c:c` as `c>=(nothing)` would answer the whole corpus — which is
///   the one wrong answer a reader would not recognise as one.
/// * **`m` is a count, not a set**: two colours or more, under every operator that asks "at
///   least" or "is", and fewer than two under the ones that ask the opposite. A set of letters
///   cannot spell it — there is no fixed pair that every multicoloured card holds.
/// * **A number is how many colours** (`c=2`, `id>=3`) — [`color_count`] compared with the
///   operator as written, so `c:2` reads through the field's own default (`>=` for `c:`).
fn color_clause(column: &str, op: PredicateOp, value: &str) -> Clause {
    match color_value(value) {
        ColorValue::Multicolor => {
            let n = color_count(column);
            plain(match op {
                PredicateOp::Colon | PredicateOp::Eq | PredicateOp::Gte | PredicateOp::Gt => {
                    format!("{n} >= 2")
                }
                PredicateOp::Ne | PredicateOp::Lt | PredicateOp::Lte => format!("{n} < 2"),
            })
        }
        ColorValue::Count(n) => bound(format!("{} {} ?", color_count(column), comparison(op)), n),
        ColorValue::Letters(named) if named.is_empty() => {
            let colorless = format!("({column} = '' OR {column} IS NULL)");
            match op {
                PredicateOp::Colon | PredicateOp::Eq | PredicateOp::Gte | PredicateOp::Lte => {
                    plain(colorless)
                }
                PredicateOp::Ne | PredicateOp::Gt => plain(format!("NOT {colorless}")),
                PredicateOp::Lt => no_match(),
            }
        }
        ColorValue::Letters(named) => letters_clause(column, op, &named, &COLORS),
    }
}

/// `produces:` — [`letters_clause`] over `cards.produced_mana` and [`PRODUCED_LETTERS`].
///
/// A colour name reads as its letters, and colourless (`c`, `colorless`) as **`C`** — the
/// letter Scryfall writes for a land that adds `{C}`, which is a real answer here where it is
/// no colour at all on `c:`. A value naming no letter of the six is [`NO_MATCH`]: "produces
/// nothing in particular" is not a question the field can be asked.
///
/// `produced_mana` is `""` for a card that adds no mana and NULL only on a row that predates
/// corpus schema 3 ([`crate::card_row::CardRow::produced_mana`]); the `coalesce` in
/// [`letters_clause`] reads both as "adds nothing".
fn produces_clause(column: &str, op: PredicateOp, value: &str) -> Clause {
    let value = value.trim().to_ascii_lowercase();
    let named: Vec<&'static str> = match color_name_letters(&value) {
        Some("") => vec!["C"],
        Some(letters) => COLORS
            .iter()
            .filter(|c| letters.contains(**c))
            .copied()
            .collect(),
        None => {
            let upper = value.to_ascii_uppercase();
            PRODUCED_LETTERS
                .iter()
                .filter(|c| upper.contains(**c))
                .copied()
                .collect()
        }
    };
    if named.is_empty() {
        return no_match();
    }
    letters_clause(column, op, &named, &PRODUCED_LETTERS)
}

/// A typed mana cost as Scryfall's symbols, upper-cased and braced: `2WW` and `{2}{w}{w}` are
/// both `["{2}", "{W}", "{W}"]`, `{r/g}` is `["{R/G}"]`.
///
/// A run of digits outside braces is **one** generic symbol (`10` is `{10}`, never `{1}{0}`),
/// each letter outside braces is one symbol, and everything else outside braces — spaces, a
/// stray `/` — is dropped. The symbols are **bound**, never interpolated, so nothing in them
/// can reach the SQL text whatever a reader puts between the braces.
fn mana_symbols(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut inner = String::new();
            for d in chars.by_ref() {
                if d == '}' {
                    break;
                }
                if !d.is_whitespace() && d != '{' {
                    inner.push(d);
                }
            }
            if !inner.is_empty() {
                out.push(format!("{{{}}}", inner.to_uppercase()));
            }
        } else if c.is_ascii_digit() {
            let mut n = String::from(c);
            while let Some(d) = chars.peek().copied().filter(char::is_ascii_digit) {
                n.push(d);
                chars.next();
            }
            out.push(format!("{{{n}}}"));
        } else if c.is_alphabetic() {
            out.push(format!("{{{}}}", c.to_uppercase()));
        }
    }
    out
}

/// `m:` — the printed cost as a **multiset of symbols**, compared by counting.
///
/// Each distinct symbol's occurrences in `cards.mana_cost` are counted by the `replace`
/// idiom, `(length(cost) - length(replace(cost, sym, ''))) / length(sym)`; the braces are
/// what keep `{W}` from counting inside `{W/U}`, so the count is exact without a parser in SQL.
/// The card's own symbol total is its count of `{`. Then:
///
/// * `:` and `>=` — **at least these symbols**: every count reaches the query's.
/// * `=` — **exactly these**: every count equals the query's and the totals agree.
/// * `!=` — not exactly; `>` — at least, and not exactly.
/// * `<=` — **every symbol of the card is within the query**: no count exceeds the query's,
///   and the counts over the query's symbols add up to the card's whole total (so the card
///   holds no symbol the query does not name). `<` is that and not exactly.
///
/// **Generic mana is a symbol here, not a quantity** — `m<={3}{R}` does not answer `{1}{R}`,
/// where Scryfall's would. And hybrid symbols compare as written, so `{u/w}` (upper-cased to
/// `{U/W}`) finds nothing where the card prints `{W/U}`. Both are accepted costs of counting
/// rather than parsing. `cards.mana_cost` is the front face's (`card_row`'s `pick`), and a NULL
/// cost — an orphan — fails every operator.
fn mana_cost_clause(column: &str, op: PredicateOp, value: &str) -> Clause {
    let mut counted: Vec<(String, i64)> = Vec::new();
    for symbol in mana_symbols(value) {
        match counted.iter_mut().find(|(s, _)| *s == symbol) {
            Some(entry) => entry.1 += 1,
            None => counted.push((symbol, 1)),
        }
    }
    if counted.is_empty() {
        return no_match();
    }
    let total: i64 = counted.iter().map(|(_, k)| k).sum();
    let symbols_in = format!("(length({column}) - length(replace({column}, '{{', '')))");
    let occurrences = |symbol: &str| -> Clause {
        (
            format!("((length({column}) - length(replace({column}, ?, ''))) / ?)"),
            vec![
                Box::new(symbol.to_owned()),
                Box::new(symbol.chars().count() as i64),
            ],
        )
    };
    let each = |cmp: &str| -> Vec<Clause> {
        counted
            .iter()
            .map(|(symbol, k)| {
                let (sql, mut params) = occurrences(symbol);
                params.push(Box::new(*k));
                (format!("{sql} {cmp} ?"), params)
            })
            .collect()
    };
    let at_least = || all_of(each(">="));
    let exactly = || {
        let mut parts = each("=");
        parts.push(bound(format!("{symbols_in} = ?"), total));
        all_of(parts)
    };
    let within = || {
        let mut parts = each("<=");
        let (sum, params) = join(
            counted
                .iter()
                .map(|(symbol, _)| occurrences(symbol))
                .collect(),
            " + ",
        );
        parts.push((format!("{sum} = {symbols_in}"), params));
        all_of(parts)
    };
    match op {
        PredicateOp::Colon | PredicateOp::Gte => at_least(),
        PredicateOp::Eq => exactly(),
        PredicateOp::Ne => not(exactly()),
        PredicateOp::Gt => all_of(vec![at_least(), not(exactly())]),
        PredicateOp::Lte => within(),
        PredicateOp::Lt => all_of(vec![within(), not(exactly())]),
    }
}

/// `devotion:` — how many of the cost's symbols carry one colour, or either colour of one
/// hybrid pair, compared with how many symbols the value spells (`devotion:{g}{g}{g}` and
/// `devotion:ggg` are both "at least three").
///
/// One colour counts its letter in `cards.mana_cost`: every symbol holds a colour's letter at
/// most once, so `{G}`, `{G/U}`, `{2/G}` and `{G/P}` each count one — which is the rule for
/// devotion. A **pair** (`{u/b}`) counts symbols holding *either* letter, so a `{U/B}` (or a
/// `{U/B/P}`) that holds both is subtracted once to be counted once. The letters come out of
/// [`COLORS`] and are interpolated; the threshold is bound. A value whose first symbol names no
/// colour, or three of them, is [`NO_MATCH`].
fn devotion_clause(column: &str, op: PredicateOp, value: &str) -> Clause {
    let symbols = mana_symbols(value);
    let Some(first) = symbols.first() else {
        return no_match();
    };
    let letters: Vec<&'static str> = COLORS
        .iter()
        .filter(|c| first.contains(**c))
        .copied()
        .collect();
    let count = |l: &str| format!("(length({column}) - length(replace({column}, '{l}', '')))");
    let pair = |x: &str, y: &str| {
        format!("((length({column}) - length(replace({column}, '{x}/{y}', ''))) / 3)")
    };
    let expr = match letters.as_slice() {
        [one] => count(one),
        [a, b] => format!(
            "({} + {} - {} - {})",
            count(a),
            count(b),
            pair(a, b),
            pair(b, a)
        ),
        _ => return no_match(),
    };
    bound(format!("{expr} {} ?", comparison(op)), symbols.len() as i64)
}

// -------------------------------------------------------------------------------------
// Numbers
// -------------------------------------------------------------------------------------

/// The column a canonicalised `@name` value names, for a comparison between two of the card's
/// own numbers (`pow>tou` arrives as `{field: power, op: gt, value: "@toughness"}`).
///
/// The grammar sends the four canonical names; the short spellings are accepted too, because
/// a hand-built payload that writes `@tou` means exactly that. Anything else is `None`, and
/// the caller answers [`NO_MATCH`].
fn stat_column(alias: &str, name: &str) -> Option<String> {
    Some(match name.to_ascii_lowercase().as_str() {
        "power" | "pow" => format!("{alias}.power"),
        "toughness" | "tou" | "tough" => format!("{alias}.toughness"),
        "cmc" | "mv" | "manavalue" => format!("{alias}.cmc"),
        "loyalty" | "loy" => loyalty_expr(alias),
        _ => return None,
    })
}

/// Starting loyalty, out of `print_facts` — a string like power, because it can be `X`.
fn loyalty_expr(alias: &str) -> String {
    format!("json_extract({alias}.print_facts, '$.loyalty')")
}

/// A numeric comparison over a column that may not hold a number.
///
/// `star` is on for `power`, `toughness` and loyalty, which are **TEXT** because a power can
/// be `*`, `1+`, `X` or `∞`. Two rules, both of them measured on Scryfall 2026-09-22:
///
/// * **`pow:*` is a string equality**, answering 1 059 — a literal star is the only way to ask
///   the question at all, and no cast can express it.
/// * **`pow>=*` is `pow>=0`**, both answering 19 128 — so under an *ordered* operator the star
///   participates rather than being excluded, which is exactly what `CAST('*' AS REAL)` = 0.0
///   already does. The comparison is therefore a cast on both sides of the operator and the
///   star is simply the number zero.
///
/// `cross` is the alias when the field may be compared with another of the card's numbers
/// (`pow>tou`, `cmc<@power`): a value beginning `@` names that column ([`stat_column`]) and
/// both sides are cast — so a star still reads as zero, and a NULL on either side fails. The
/// prices pass `None`; `usd>@power` is not a question.
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
    cross: Option<&str>,
) -> Clause {
    if let Some(name) = value.strip_prefix('@') {
        let Some(other) = cross.and_then(|alias| stat_column(alias, name)) else {
            return no_match();
        };
        return plain(format!(
            "CAST({column} AS REAL) {} CAST({other} AS REAL)",
            comparison(op)
        ));
    }
    if star && value == "*" {
        match op {
            PredicateOp::Colon | PredicateOp::Eq => {
                return bound(format!("{column} = ?"), "*".to_owned())
            }
            PredicateOp::Ne => return bound(format!("{column} <> ?"), "*".to_owned()),
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
        return no_match();
    };
    bound(
        format!("CAST({column} AS REAL) {} ?", comparison(op)),
        number,
    )
}

/// `cmc:even` / `cmc:odd` — a whole mana value with that remainder. A fractional one (the
/// un-sets' `½`) is neither. `!=` is the negation; an ordered operator on a parity is
/// [`NO_MATCH`], there being no order to ask about.
fn parity_clause(alias: &str, op: PredicateOp, remainder: i64) -> Clause {
    let is = plain(format!(
        "({alias}.cmc = CAST({alias}.cmc AS INTEGER) AND CAST({alias}.cmc AS INTEGER) % 2 = {remainder})"
    ));
    match op {
        PredicateOp::Colon | PredicateOp::Eq => is,
        PredicateOp::Ne => not(is),
        _ => no_match(),
    }
}

/// `cn:` — numeric when the value is a number (`cn>=100`, through a cast that reads `123a` as
/// 123), and otherwise **exact string equality, case-folded** (`cn:12a`, `cn:★1`), because a
/// collector number that is not a number is a name for one printing rather than a position.
/// An ordered operator on a non-number is [`NO_MATCH`].
fn collector_number_clause(alias: &str, op: PredicateOp, value: &str) -> Clause {
    let column = format!("{alias}.collector_number");
    if value.parse::<f64>().is_ok() {
        return numeric_clause(&column, op, value, false, None);
    }
    match op {
        PredicateOp::Colon | PredicateOp::Eq => {
            bound(format!("lower({column}) = lower(?)"), value.to_owned())
        }
        PredicateOp::Ne => bound(format!("lower({column}) <> lower(?)"), value.to_owned()),
        _ => no_match(),
    }
}

/// A `YYYY`, `YYYY-MM` or `YYYY-MM-DD` value, or `None` for anything else (which `date:` then
/// reads as a set code).
fn date_prefix(value: &str) -> Option<&str> {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() > 3 {
        return None;
    }
    let shaped = parts
        .iter()
        .zip([4usize, 2, 2])
        .all(|(part, width)| part.len() == width && part.bytes().all(|b| b.is_ascii_digit()));
    shaped.then_some(value)
}

/// `date:` — the printing's `released_at` against a date or against a set's release.
///
/// **A partial date compares the same-length prefix**, `substr(released_at, 1, n) <op> ?`, and
/// that is what makes every operator mean what it says: `date>2020` excludes all of 2020 (a
/// bare string comparison would let `2020-01-01` through, being longer than `2020`), and
/// `date=2020-05` is the whole of May. The length is bound beside the value.
///
/// Anything that is not a date is a **set code** (`date>=neo`), compared with that set's own
/// `released_at`; an unknown code is a NULL subquery, which fails every row rather than
/// matching all of them.
fn date_clause(alias: &str, op: PredicateOp, value: &str) -> Clause {
    let cmp = comparison(op);
    match date_prefix(value) {
        Some(date) => (
            format!("substr({alias}.released_at, 1, ?) {cmp} ?"),
            vec![Box::new(date.len() as i64), Box::new(date.to_owned())],
        ),
        None => bound(
            format!(
                "{alias}.released_at {cmp} (SELECT ss.released_at FROM sets ss WHERE ss.code = ?)"
            ),
            value.to_ascii_lowercase(),
        ),
    }
}

/// `prints:`, `paperprints:`, `sets:` and `papersets:` — a correlated count over the other
/// printings of this card (`idx_cards_oracle` seeks it), compared with a number.
///
/// **An orphan is NULL, not zero**: `CASE WHEN oracle_id IS NULL THEN NULL` keeps a collection
/// row whose printing has left the corpus out of `prints=0` *and* out of `-prints=0`, which is
/// the orphan rule every card-row claim here follows — a bare count would have answered 0 for
/// it and let it through the negation. A value that is not a number is [`NO_MATCH`].
fn print_count_clause(
    alias: &str,
    op: PredicateOp,
    value: &str,
    distinct_sets: bool,
    paper: bool,
) -> Clause {
    let Ok(n) = value.parse::<f64>() else {
        return no_match();
    };
    let what = if distinct_sets {
        "count(DISTINCT pr.set_code)"
    } else {
        "count(*)"
    };
    let paper = if paper { " AND pr.is_paper = 1" } else { "" };
    bound(
        format!(
            "(CASE WHEN {alias}.oracle_id IS NULL THEN NULL ELSE \
             (SELECT {what} FROM cards pr WHERE pr.oracle_id = {alias}.oracle_id{paper}) END) {} ?",
            comparison(op)
        ),
        n,
    )
}

// -------------------------------------------------------------------------------------
// Print facts, names, tags, sets, printings
// -------------------------------------------------------------------------------------

/// One `print_facts` string key as an expression: the value, `''` when the printing has none,
/// and **NULL when the row has no `print_facts` at all** — an orphan, or a row that predates
/// corpus schema 8.
///
/// The three states are what make a negation honest. `-wm:orzhov` must keep the printings with
/// no watermark (`NOT ('' = 'orzhov')` is true), which a bare `json_extract` would lose
/// (`NOT (NULL = …)` is NULL); and it must still drop an orphan and a pre-rung row, which a bare
/// `coalesce` would let through. `key` is one of this module's string literals — every caller
/// passes a constant, which is the module note's rule.
fn fact(alias: &str, key: &'static str) -> String {
    format!(
        "(CASE WHEN {alias}.print_facts IS NULL THEN NULL \
         ELSE coalesce(json_extract({alias}.print_facts, '$.{key}'), '') END)"
    )
}

/// One `print_facts` boolean as a clause — true, false when the key is false or absent, NULL
/// when the row has none ([`fact`]'s three states, for its reason).
fn fact_flag(alias: &str, key: &'static str) -> Clause {
    plain(format!(
        "(CASE WHEN {alias}.print_facts IS NULL THEN NULL \
         ELSE coalesce(json_extract({alias}.print_facts, '$.{key}'), 0) END) = 1"
    ))
}

/// An **exact name** — Scryfall's `!"lightning bolt"` — over `column`: the whole name
/// case-folded, or either face of an `A // B` name, so `!"fire"` finds *Fire // Ice* and
/// `!"delver of secrets"` finds the transforming card whose name carries both faces.
///
/// **SQL, not FTS**: the index's prefix tokens cannot spell equality, and the phrase
/// `name : ("lightning"* + "bolt"*)` also answers *Lightning Bolt Elemental*. `lower` folds
/// ASCII only, which is the fold every other case-insensitive arm here uses. The value is bound
/// three times, once per comparison. A name with more than one ` // ` (*Who // What // When //
/// Where // Why*) is matched whole or by its first face; its later faces are not split apart.
///
/// `pub(crate)` because the wishlist answers a top-level exact name from its own
/// `wishlist_entries.name`, through this same expression, so an orphaned wish still answers it.
pub(crate) fn exact_name_clause(column: &str, value: &str) -> Clause {
    let front = format!("lower(substr({column}, 1, instr({column}, ' // ') - 1))");
    let back = format!("lower(substr({column}, instr({column}, ' // ') + 4))");
    (
        format!(
            "(lower({column}) = lower(?) OR (instr({column}, ' // ') > 0 \
             AND ({front} = lower(?) OR {back} = lower(?))))"
        ),
        vec![
            Box::new(value.to_owned()),
            Box::new(value.to_owned()),
            Box::new(value.to_owned()),
        ],
    )
}

/// An oracle or art tag **named inside a group** (`otag:ramp or otag:removal`), resolved in
/// SQL by its normalised name.
///
/// The top level resolves a tag through `tags::query::run_tag_resolve` and hands this module
/// a slug ([`picked_tags`]), so the chip row can name an unknown tag; a group has no chip per
/// child to name it on, so the name is matched here against `slug_norm` with the same
/// [`crate::slug::normalize`] that command uses — Scryfall's rule, exact after folding. Against
/// the **closure** tables, for the chip arms' reason. An unknown name matches nothing, so
/// inside an `or` the other branches still answer, and a name that normalises to nothing is no
/// clause at all (the blank-child rule) — never `slug_norm = ''`, for `run_tag_resolve`'s
/// reason. The art weight floor is a chip-row setting and is not applied here.
///
/// **`IS NOT NULL AND … IN (…)`, so a printing with no illustration is *false*, not NULL** —
/// which is what lets `-atag:dragon` keep the 4 977 printings that have no `illustration_id`,
/// as the chip exclude's `NOT EXISTS` keeps them (`NOT (NULL IN …)` would drop them, the trap
/// that arm's comment names). The `IN` stays a conjunct of its own, so the planner can still
/// drive from the closure when the term stands alone.
fn tag_clause(alias: &str, value: &str, art: bool) -> Option<Clause> {
    let needle = crate::slug::normalize(value);
    if needle.is_empty() {
        return None;
    }
    let sql = if art {
        format!(
            "({alias}.illustration_id IS NOT NULL AND {alias}.illustration_id IN \
             (SELECT ati.illustration_id FROM art_tag_illustrations ati \
             WHERE ati.slug IN (SELECT atg.slug FROM art_tags atg WHERE atg.slug_norm = ?)))"
        )
    } else {
        format!(
            "({alias}.oracle_id IS NOT NULL AND {alias}.oracle_id IN \
             (SELECT otc.oracle_id FROM oracle_tag_cards otc \
             WHERE otc.slug IN (SELECT otg.slug FROM oracle_tags otg WHERE otg.slug_norm = ?)))"
        )
    };
    Some(bound(sql, needle))
}

/// A language code for a `lang:`/`in:` value — the code itself or one of its names, folded
/// to lower case with separators dropped (`Simplified Chinese` is `zhs`).
fn language_code(value: &str) -> Option<&'static str> {
    let key: String = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    LANGUAGES
        .iter()
        .find(|(code, names)| *code == key || names.contains(&key.as_str()))
        .map(|(code, _)| *code)
}

/// `b:` — a block by its code (`b:rtr`), its name (`b:"return to ravnica"`), or **any set in
/// it** (`b:gtc` is every set sharing Gatecrash's `block_code`). Three comparisons over
/// `sets.block_code` / `sets.block` (corpus schema 8), the value bound three times; a set with
/// no block has a NULL `block_code` and is in no block, `NULL IN (…)` being NULL.
fn block_clause(set_code: &str, value: &str) -> Clause {
    let v = value.to_ascii_lowercase();
    (
        format!(
            "{set_code} IN (SELECT ss.code FROM sets ss WHERE lower(ss.block_code) = ? \
             OR lower(ss.block) = ? \
             OR ss.block_code IN (SELECT sb.block_code FROM sets sb WHERE sb.code = ?))"
        ),
        vec![Box::new(v.clone()), Box::new(v.clone()), Box::new(v)],
    )
}

/// `in:` — **some printing of this card** answers the value: a game ([`GAMES`]), a rarity
/// ([`ALL_RARITIES`]), a language (code or name, [`language_code`]), and otherwise a set code
/// — read in that order, so `in:rare` is a rarity and not a set called `rare`. One uncorrelated
/// `oracle_id IN (…)`, read once per statement.
fn in_printing_clause(alias: &str, value: &str) -> Clause {
    let v = value.to_ascii_lowercase();
    let (condition, param): (&str, Box<dyn rusqlite::ToSql>) = if GAMES.contains(&v.as_str()) {
        ("instr(pi.games, ?) > 0", Box::new(format!("\"{v}\"")))
    } else if ALL_RARITIES.contains(&v.as_str()) {
        ("pi.rarity = ?", Box::new(v))
    } else if let Some(code) = language_code(&v) {
        ("pi.lang = ?", Box::new(code))
    } else {
        ("pi.set_code = ?", Box::new(v))
    };
    (
        format!("{alias}.oracle_id IN (SELECT pi.oracle_id FROM cards pi WHERE {condition})"),
        vec![param],
    )
}

/// `frame:` — a frame year out of `print_facts`, or a frame effect out of
/// `cards.frame_effects` (a JSON array, matched by its quoted word as the finish chips are).
fn frame_clause(alias: &str, value: &str) -> Clause {
    let v = value.to_ascii_lowercase();
    if FRAME_YEARS.contains(&v.as_str()) {
        bound(format!("{} = ?", fact(alias, "frame")), v)
    } else {
        bound(
            format!("instr({alias}.frame_effects, ?) > 0"),
            format!("\"{v}\""),
        )
    }
}

/// `banned:` / `restricted:` — the card's status in one format, read from the `legalities`
/// JSON rather than the mask, because the mask folds `banned` and `not_legal` into one zero
/// bit and cannot tell them apart.
///
/// The format key is validated by [`crate::legalities::bit`] first, exactly as `f:` is, so an
/// unknown format is [`NO_MATCH`] and the JSON path bound beside the status is always one of
/// [`crate::legalities::LEGALITY_KEYS`]. This scans — `json_extract` cannot be indexed — and is
/// acceptable for `a:`'s reason: it is ANDed into a statement something else has narrowed.
fn legality_clause(alias: &str, value: &str, status: &'static str) -> Clause {
    let key = value.to_ascii_lowercase();
    if crate::legalities::bit(&key).is_none() {
        return no_match();
    }
    (
        format!("json_extract({alias}.legalities, ?) = ?"),
        vec![Box::new(format!("$.{key}")), Box::new(status)],
    )
}

/// `new:` — this printing is the first of its card with that value: no **earlier**
/// (`released_at <`) printing of the same oracle card shares it.
///
/// `card` asks for the card's first printing at all; `art` compares the illustration across
/// every printing that carries it; `artist`, `flavor`, `frame`, `language` and `rarity`
/// compare that column among the card's own printings. One correlated `NOT EXISTS` over
/// `cards pr`, seeked by `idx_cards_oracle` (`idx_cards_illustration` for `art`).
///
/// Three outcomes, not two: an orphan or a printing with no release date is **NULL** (fails
/// the term and its negation, the orphan rule); a printing with no value of its own (no
/// flavour text, no illustration) is **false** — a card without flavour has no *new* flavour —
/// so `-new:flavor` keeps it; otherwise the `NOT EXISTS`. Same-day printings are each new. A
/// value outside the seven is [`NO_MATCH`].
fn new_feature_clause(alias: &str, value: &str) -> Clause {
    let a = alias;
    let same_card = format!("pr.oracle_id = {a}.oracle_id");
    let (own, same) = match value.to_ascii_lowercase().as_str() {
        "card" => (format!("{a}.oracle_id"), same_card),
        "art" => (
            format!("{a}.illustration_id"),
            format!("pr.illustration_id = {a}.illustration_id"),
        ),
        "artist" => (
            format!("{a}.artist"),
            format!("{same_card} AND pr.artist = {a}.artist"),
        ),
        "flavor" | "flavour" => (
            format!("json_extract({a}.print_facts, '$.flavor_text')"),
            format!(
                "{same_card} AND json_extract(pr.print_facts, '$.flavor_text') \
                 = json_extract({a}.print_facts, '$.flavor_text')"
            ),
        ),
        "frame" => (
            format!("json_extract({a}.print_facts, '$.frame')"),
            format!(
                "{same_card} AND json_extract(pr.print_facts, '$.frame') \
                 = json_extract({a}.print_facts, '$.frame')"
            ),
        ),
        "language" => (
            format!("{a}.lang"),
            format!("{same_card} AND pr.lang = {a}.lang"),
        ),
        "rarity" => (
            format!("{a}.rarity"),
            format!("{same_card} AND pr.rarity = {a}.rarity"),
        ),
        _ => return no_match(),
    };
    plain(format!(
        "(CASE WHEN {a}.oracle_id IS NULL OR {a}.released_at IS NULL THEN NULL \
         WHEN {own} IS NULL THEN 0 \
         ELSE NOT EXISTS (SELECT 1 FROM cards pr WHERE {same} AND pr.released_at < {a}.released_at) END)"
    ))
}

/// `has:` — a `print_facts` key is present and not empty: `watermark`, `indicator` (the colour
/// indicator), `flavor`, `stamp`. Anything else is [`NO_MATCH`].
fn has_clause(alias: &str, value: &str) -> Clause {
    let key = match value.to_ascii_lowercase().as_str() {
        "watermark" => "watermark",
        "indicator" => "color_indicator",
        "flavor" | "flavour" => "flavor_text",
        "stamp" => "security_stamp",
        _ => return no_match(),
    };
    plain(format!("{} <> ''", fact(alias, key)))
}

// -------------------------------------------------------------------------------------
// `is:`
// -------------------------------------------------------------------------------------

/// **The `is:` vocabulary, and the one source of it** (issue #909). `not:x` is `is:x` negated.
///
/// `packages/ui/features/search/queryLanguage.ts` holds the same list so it can tell a word it
/// should send from one that is free text, and a TypeScript test reads *this* constant out of
/// this file to hold the two together, `ipc.test.ts`-style — so keep it a flat literal list of
/// strings, and add a word here and in [`is_clause`] in one change (the test
/// `every_is_value_has_its_own_sql` fails on a word with no arm).
///
/// Five families, in this order: layouts and faces; card kinds; printing facts; Scryfall's
/// promo types (each matched by its own word in `cards.promo_types`); and the land nicknames,
/// which are **rules-text heuristics** — a pattern or two over `search_text` beside the land
/// type, each documented at its arm — not a list of card names, so a new cycle that reuses the
/// template is found without a release.
pub const IS_VALUES: &[&str] = &[
    // Layout / faces
    "split",
    "flip",
    "transform",
    "meld",
    "leveler",
    "adventure",
    "mdfc",
    "dfc",
    "saga",
    "class",
    "case",
    "prototype",
    "battle",
    "token",
    "emblem",
    "artseries",
    "reversible",
    // Card kinds
    "spell",
    "permanent",
    "historic",
    "party",
    "outlaw",
    "vanilla",
    "frenchvanilla",
    "bear",
    "modal",
    "hybrid",
    "phyrexian",
    "commander",
    "brawler",
    "companion",
    "funny",
    "masterpiece",
    // Printing
    "promo",
    "digital",
    "reprint",
    "reserved",
    "foil",
    "nonfoil",
    "etched",
    "glossy",
    "full",
    "fullart",
    "hires",
    "textless",
    "oversized",
    "spotlight",
    "booster",
    "variation",
    "gamechanger",
    "showcase",
    "extendedart",
    "borderless",
    "colorshifted",
    "inverted",
    "nyxtouched",
    // Promo types
    "datestamped",
    "prerelease",
    "buyabox",
    "bundle",
    "boosterfun",
    "planeswalkerdeck",
    "promopack",
    "release",
    "gameday",
    "intropack",
    "judgegift",
    "league",
    "convention",
    "fnm",
    "openhouse",
    "setpromo",
    "stamped",
    "serialized",
    "surgefoil",
    "galaxyfoil",
    "textured",
    "halofoil",
    "confettifoil",
    "doublerainbow",
    "neonink",
    "oilslick",
    "rainbowfoil",
    "stepandcompleat",
    "embossed",
    "gilded",
    "ripplefoil",
    "raisedfoil",
    "poster",
    "universesbeyond",
    "ub",
    // Land nicknames
    "dual",
    "fetchland",
    "shockland",
    "checkland",
    "fastland",
    "slowland",
    "painland",
    "gainland",
    "scryland",
    "surveilland",
    "bounceland",
    "karoo",
    "filterland",
    "canopyland",
    "bikeland",
    "cycleland",
    "triland",
    "triome",
    "shadowland",
    "storageland",
    "tangoland",
    "battleland",
    "creatureland",
    "manland",
    "pathway",
];

/// `{alias}.layout IN (…)`, every layout bound.
fn layout_in(alias: &str, layouts: &[&'static str]) -> Clause {
    let holes = vec!["?"; layouts.len()].join(",");
    (
        format!("{alias}.layout IN ({holes})"),
        layouts
            .iter()
            .map(|l| Box::new(*l) as Box<dyn rusqlite::ToSql>)
            .collect(),
    )
}

/// The card has `key` ([`crate::cardtypes::TYPE_KEYS`]) on any face — one bit of
/// `cards.type_mask`, the type chips' own test.
fn has_type(alias: &str, key: &str) -> Clause {
    bound(
        format!("({alias}.type_mask & ?) != 0"),
        i64::from(crate::cardtypes::mask_of(&[key.to_owned()])),
    )
}

/// The **front face's** type line, padded with spaces so `LIKE '% Creature %'` is a whole-word
/// test: everything before the first ` // `, or the whole line when there is none.
///
/// The front, not [`has_type`]'s every face, wherever a card's *kind* turns on how it is cast:
/// an adventurer (`Creature — Knight // Sorcery — Adventure`) is a permanent and an MDFC
/// (`Sorcery // Land`) is a spell, and the mask, holding both faces, would say both are both.
fn front_face(alias: &str) -> String {
    format!(
        "(' ' || substr({alias}.type_line, 1, instr({alias}.type_line || ' // ', ' // ') - 1) || ' ')"
    )
}

/// A `"word"` inside a JSON-array column — `finishes`, `frame_effects`, `promo_types` — by its
/// quoted form, so `"foil"` cannot match inside `"nonfoil"` (the finish chips' argument).
fn json_word(alias: &str, column: &'static str, word: &'static str) -> Clause {
    bound(
        format!("instr({alias}.{column}, ?) > 0"),
        format!("\"{word}\""),
    )
}

/// A land whose rules text matches **every** pattern — the shape of each land nickname.
/// `search_text` rather than `oracle_text`, because the latter is NULL on a double-faced card.
fn land_text(alias: &str, patterns: &[&'static str]) -> Clause {
    let mut parts = vec![has_type(alias, "Land")];
    parts.extend(
        patterns
            .iter()
            .map(|p| bound(format!("{alias}.search_text LIKE ?"), *p)),
    );
    all_of(parts)
}

/// The SQL for one `is:` word — [`NO_MATCH`] for a word outside [`IS_VALUES`].
///
/// One arm per word (or per family of synonyms). Every word compared against is **bound**, and
/// the only text interpolated is this module's column names and the [`front_face`] / `fact`
/// expressions. The rules-text patterns are ASCII-case-insensitive (`LIKE`), read Scryfall's
/// current Oracle wording (`enters tapped`, not `enters the battlefield tapped`, since the 2024
/// update), and are deliberately loose in one direction: a nickname that also catches the odd
/// non-cycle land is a near miss a reader can see and refine, where a pattern too tight to
/// catch the cycle is a wall that silently lacks it.
fn is_clause(alias: &str, set_code: &str, value: &str) -> Clause {
    let lower = value.to_ascii_lowercase();
    let Some(word) = IS_VALUES.iter().copied().find(|w| *w == lower) else {
        return no_match();
    };
    let a = alias;
    let type_line = format!("{a}.type_line");
    let search_text = format!("{a}.search_text");
    let front = front_face(a);
    match word {
        // ---- Layout / faces: Scryfall's `layout` word, or the type that defines the kind.
        "split" => layout_in(a, &["split"]),
        "flip" => layout_in(a, &["flip"]),
        "transform" => layout_in(a, &["transform"]),
        "meld" => layout_in(a, &["meld"]),
        "leveler" => layout_in(a, &["leveler"]),
        "adventure" => layout_in(a, &["adventure"]),
        "mdfc" => layout_in(a, &["modal_dfc"]),
        // Every layout whose card has a second face printed on its back.
        "dfc" => layout_in(a, &["transform", "modal_dfc", "meld", "double_faced_token"]),
        // The type rather than the layout: Scryfall moved Sagas to a layout of their own only
        // in 2023, and older bulk lines still read `normal`.
        "saga" => like_any(&type_line, &["%Saga%"]),
        "class" => layout_in(a, &["class"]),
        "case" => layout_in(a, &["case"]),
        "prototype" => layout_in(a, &["prototype"]),
        "battle" => has_type(a, "Battle"),
        "token" => layout_in(a, &["token", "double_faced_token"]),
        "emblem" => layout_in(a, &["emblem"]),
        "artseries" => layout_in(a, &["art_series"]),
        "reversible" => layout_in(a, &["reversible_card"]),

        // ---- Card kinds.
        // Cast from the hand: a spell type on the front face, and the front face is no land.
        "spell" => all_of(vec![
            like_any(
                &front,
                &[
                    "% Artifact %",
                    "% Battle %",
                    "% Creature %",
                    "% Enchantment %",
                    "% Instant %",
                    "% Planeswalker %",
                    "% Sorcery %",
                ],
            ),
            not(like_any(&front, &["% Land %"])),
        ]),
        "permanent" => like_any(
            &front,
            &[
                "% Artifact %",
                "% Battle %",
                "% Creature %",
                "% Enchantment %",
                "% Land %",
                "% Planeswalker %",
            ],
        ),
        // Dominaria's rule: legendary, an artifact, or a Saga.
        "historic" => any_of(vec![
            like_any(&type_line, &["%Legendary%", "%Saga%"]),
            has_type(a, "Artifact"),
        ]),
        "party" => all_of(vec![
            has_type(a, "Creature"),
            like_any(
                &type_line,
                &["%Cleric%", "%Rogue%", "%Warrior%", "%Wizard%"],
            ),
        ]),
        "outlaw" => all_of(vec![
            has_type(a, "Creature"),
            like_any(
                &type_line,
                &[
                    "%Assassin%",
                    "%Mercenary%",
                    "%Pirate%",
                    "%Rogue%",
                    "%Warlock%",
                ],
            ),
        ]),
        // A single-faced creature with no rules text at all.
        "vanilla" => all_of(vec![
            layout_in(a, &["normal"]),
            has_type(a, "Creature"),
            plain(format!("coalesce({a}.oracle_text, '') = ''")),
        ]),
        // Only keyword abilities: it has keywords, and no sentence ends outside reminder text —
        // a period is allowed only as the last character inside the parentheses (`.)`), which
        // is where every keyword's reminder puts it. NULL `keywords` (pre-schema-5) fails.
        "frenchvanilla" => all_of(vec![
            layout_in(a, &["normal"]),
            has_type(a, "Creature"),
            plain(format!(
                "{a}.keywords <> '' AND coalesce({a}.oracle_text, '') <> '' \
                 AND instr(replace({a}.oracle_text, '.)', ')'), '.') = 0"
            )),
        ]),
        "bear" => all_of(vec![
            has_type(a, "Creature"),
            plain(format!(
                "{a}.cmc = 2 AND {a}.power = '2' AND {a}.toughness = '2'"
            )),
        ]),
        // "Choose one —" and its siblings, the em dash included so "choose one of them" in
        // ordinary rules text is not modal.
        "modal" => like_any(
            &search_text,
            &[
                "%choose one —%",
                "%choose one or more —%",
                "%choose one or both —%",
                "%choose two —%",
                "%choose three —%",
                "%choose four —%",
                "%choose any number —%",
            ],
        ),
        // A hybrid symbol in the cost: a slash before a colour (`{W/U}`, `{2/W}`), or a
        // Phyrexian hybrid (`{G/U/P}`). A plain Phyrexian `{W/P}` ends `/P}` and is not hybrid.
        "hybrid" => like_any(
            &format!("{a}.mana_cost"),
            &["%/W}%", "%/U}%", "%/B}%", "%/R}%", "%/G}%", "%/_/P}%"],
        ),
        "phyrexian" => any_of(vec![
            like_any(&format!("{a}.mana_cost"), &["%/P}%"]),
            like_any(&search_text, &["%/P}%"]),
        ]),
        "commander" => any_of(vec![
            all_of(vec![
                like_any(&front, &["% Legendary %"]),
                like_any(&front, &["% Creature %"]),
            ]),
            like_any(&search_text, &["%can be your commander%"]),
        ]),
        "brawler" => any_of(vec![
            all_of(vec![
                like_any(&front, &["% Legendary %"]),
                like_any(&front, &["% Creature %", "% Planeswalker %"]),
            ]),
            like_any(&search_text, &["%can be your commander%"]),
        ]),
        "companion" => like_any(&search_text, &["%Companion —%"]),
        // The un-sets by type, and the acorn-stamped cards wherever they were printed.
        "funny" => any_of(vec![
            bound(
                format!("{set_code} IN (SELECT ss.code FROM sets ss WHERE ss.set_type = ?)"),
                "funny",
            ),
            bound(format!("{} = ?", fact(a, "security_stamp")), "acorn"),
        ]),
        "masterpiece" => bound(
            format!("{set_code} IN (SELECT ss.code FROM sets ss WHERE ss.set_type = ?)"),
            "masterpiece",
        ),

        // ---- Printing facts.
        "promo" => plain(format!("{a}.promo = 1")),
        "digital" => plain(format!("{a}.digital = 1")),
        "reprint" => fact_flag(a, "reprint"),
        "reserved" => fact_flag(a, "reserved"),
        "foil" => json_word(a, "finishes", "foil"),
        "nonfoil" => json_word(a, "finishes", "nonfoil"),
        "etched" => json_word(a, "finishes", "etched"),
        "glossy" => any_of(vec![
            json_word(a, "finishes", "glossy"),
            json_word(a, "promo_types", "glossy"),
        ]),
        "full" | "fullart" => plain(format!("{a}.full_art = 1")),
        "hires" => bound(format!("{a}.image_status = ?"), "highres_scan"),
        "textless" => fact_flag(a, "textless"),
        "oversized" => fact_flag(a, "oversized"),
        "spotlight" => fact_flag(a, "story_spotlight"),
        "booster" => fact_flag(a, "booster"),
        "variation" => fact_flag(a, "variation"),
        "gamechanger" => plain(format!("{a}.game_changer = 1")),
        "showcase" => json_word(a, "frame_effects", "showcase"),
        "extendedart" => json_word(a, "frame_effects", "extendedart"),
        "borderless" => bound(format!("{a}.border_color = ?"), BORDERLESS),
        "colorshifted" => json_word(a, "frame_effects", "colorshifted"),
        "inverted" => json_word(a, "frame_effects", "inverted"),
        "nyxtouched" => json_word(a, "frame_effects", "nyxtouched"),

        // ---- Promo types: the word is Scryfall's own `promo_types` entry.
        "datestamped" | "prerelease" | "buyabox" | "bundle" | "boosterfun" | "planeswalkerdeck"
        | "promopack" | "release" | "gameday" | "intropack" | "judgegift" | "league"
        | "convention" | "fnm" | "openhouse" | "setpromo" | "stamped" | "serialized"
        | "surgefoil" | "galaxyfoil" | "textured" | "halofoil" | "confettifoil"
        | "doublerainbow" | "neonink" | "oilslick" | "rainbowfoil" | "stepandcompleat"
        | "embossed" | "gilded" | "ripplefoil" | "raisedfoil" | "poster" => {
            json_word(a, "promo_types", word)
        }
        // Scryfall's own short form answers the same word — the universe chip's Beyond.
        "universesbeyond" | "ub" => json_word(a, "promo_types", UNIVERSES_BEYOND),

        // ---- Land nicknames: rules-text templates, each on a land.
        // The ten originals: two basic types and nothing but the reminder of what they tap for.
        "dual" => all_of(vec![
            like_any(&type_line, &["Land — % %"]),
            like_any(&format!("{a}.oracle_text"), &["({T}: Add {_} or {_}.)"]),
        ]),
        // Pay 1 life, sacrifice, search — the Onslaught/Zendikar cycles, Mirage's, and Vista.
        "fetchland" => land_text(a, &["%Pay 1 life, Sacrifice%Search your library for a%"]),
        "shockland" => land_text(a, &["%you may pay 2 life. If you don't%tapped%"]),
        // "… enters tapped unless you control a Plains or an Island."
        "checkland" => land_text(a, &["%tapped unless you control a %or a%"]),
        "fastland" => land_text(a, &["%tapped unless you control two or fewer other lands%"]),
        "slowland" => land_text(a, &["%tapped unless you control two or more other lands%"]),
        // Colourless for free, coloured for 1 damage.
        "painland" => land_text(a, &["%{T}: Add {C}%", "%deals 1 damage to you%"]),
        "gainland" => land_text(a, &["%tapped%you gain 1 life%"]),
        "scryland" => land_text(a, &["%tapped%scry 1%"]),
        "surveilland" => land_text(a, &["%tapped%surveil 1%"]),
        "bounceland" | "karoo" => {
            land_text(a, &["%return a land you control to its owner's hand%"])
        }
        // Shadowmoor's: `{W/U}, {T}: Add {W}{W}, {W}{U}, or {U}{U}.`
        "filterland" => land_text(a, &["%{T}: Add {_}{_}, {_}{_}, or {_}{_}%"]),
        // Horizon lands: pay 1 life for colour, sacrifice to draw.
        "canopyland" => land_text(a, &["%Pay 1 life: Add%", "%Sacrifice%Draw a card%"]),
        // Amonkhet's two-colour cycling lands.
        "bikeland" | "cycleland" => land_text(a, &["%{T}: Add {_} or {_}%", "%Cycling {2}%"]),
        // Shards' three-colour taplands — typeless, which is what tells them from a triome.
        "triland" => all_of(vec![
            bound(format!("{a}.type_line = ?"), "Land"),
            land_text(a, &["%{T}: Add {_}, {_}, or {_}%"]),
        ]),
        "triome" => all_of(vec![
            like_any(&type_line, &["Land — % % %"]),
            land_text(a, &["%Cycling {3}%"]),
        ]),
        "shadowland" => land_text(a, &["%you may reveal a % or % card from your hand%"]),
        "storageland" => land_text(a, &["%storage counter%"]),
        "tangoland" | "battleland" => {
            land_text(a, &["%tapped unless you control two or more basic lands%"])
        }
        "creatureland" | "manland" => land_text(a, &["%becomes a %/% %creature%"]),
        "pathway" => bound(format!("{a}.type_line = ?"), "Land // Land"),

        // A word in `IS_VALUES` with no arm above. Unreachable while the two agree, and
        // `every_is_value_has_its_own_sql` is what fails when they do not.
        _ => no_match(),
    }
}

// -------------------------------------------------------------------------------------
// Groups, and the one function every term goes through
// -------------------------------------------------------------------------------------

/// An `or` ([`PredicateField::AnyOf`], `any`) or a parenthesised `and`
/// ([`PredicateField::AllOf`]) as **one** parenthesised clause, its children's parameters in
/// their order — or `None` when it is no filter at all.
///
/// Every child is answered by [`predicate_clause`] with `nested` on, so an FTS child becomes
/// its own `rowid IN (…)` subquery rather than a term of the top-level `MATCH` — an `OR`
/// cannot live inside a conjunction it is not part of — and a group inside a group recurses.
///
/// **A blank child is "no filter", which is *true*, and the two connectives read that
/// differently.** An `and` drops it: `(t:goblin otag:)` is `t:goblin`. An `or` containing one
/// is true outright — `t:goblin or otag:` is "goblins, or anything" — so the whole group is no
/// clause, rather than an `OR` of the other children that would narrow more than was asked. A
/// group with no usable child is no clause either way, which is [`nonblank`]'s rule one level
/// up. A child that is *unknown* (an `is:` word this build lacks, an unknown tag name) is not
/// blank: it is [`NO_MATCH`] or a subquery that matches nothing, so inside an `or` the other
/// branches still answer.
fn group_clause(pred: &QueryPredicate, alias: &str, set_code: &str, any: bool) -> Option<Clause> {
    let mut parts: Vec<Clause> = Vec::with_capacity(pred.terms.len());
    for term in &pred.terms {
        match predicate_clause(term, alias, set_code, true) {
            Some(clause) => parts.push(clause),
            None if any => return None,
            None => {}
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(if any { any_of(parts) } else { all_of(parts) })
}

/// The SQL one [`QueryPredicate`] becomes, and the parameters it binds — or `None` when it
/// becomes no SQL at all.
///
/// There are exactly **two** ways to get `None` and they are different facts:
///
/// * A top-level FTS term ([`rides_the_match`]) is the FTS builder's, and [`fts_match`] emits
///   it. This is the `None` that is a hand-off rather than a gap. With `nested` on — inside a
///   group — the same term is answered here instead, by [`fts_subquery`].
/// * A **blank** value is no filter, which is [`nonblank`]'s rule and every other arm of
///   [`push_card_filters`] follows it: a term the reader has not finished typing must not
///   empty the wall under them. A value that *means* "no filter" is blank too (`lang:any`, a
///   tag name that normalises to nothing, a group with no usable child — [`group_clause`]).
///
/// `set_code` is the caller's already-built expression rather than `{alias}.set_code`, so
/// `s:lea` reads through to a collection entry's own copy exactly as the chip picker does —
/// see [`push_card_filters`]' doc comment for the asymmetry that makes that the one filter
/// with two places to read from. Every set-shaped question (`st:`, `b:`, `date:<set>`,
/// `is:funny`) reads through the same expression.
fn predicate_clause(
    pred: &QueryPredicate,
    alias: &str,
    set_code: &str,
    nested: bool,
) -> Option<Clause> {
    let group = matches!(pred.field, PredicateField::AnyOf | PredicateField::AllOf);
    let value = pred.value.trim();
    if value.is_empty() && !group {
        return None;
    }
    let op = if matches!(pred.op, PredicateOp::Colon) {
        default_op(pred.field)
    } else {
        pred.op
    };
    let ne = op == PredicateOp::Ne;
    let a = alias;

    // **Every field, and no `_` arm.** A new field added to the enum must fail this match to
    // compile rather than fall through into a filter that quietly does nothing.
    let (sql, params): Clause = match pred.field {
        PredicateField::AnyOf => group_clause(pred, alias, set_code, true)?,
        PredicateField::AllOf => group_clause(pred, alias, set_code, false)?,

        // `!name` — equality, not the index. See [`exact_name_clause`].
        PredicateField::Name if pred.op == PredicateOp::Eq => {
            exact_name_clause(&format!("{a}.name"), value)
        }
        // The FTS builder's three at the top level — see [`PredicateField`] and
        // [`fts_match`]; inside a group, a subquery of their own.
        PredicateField::Name | PredicateField::TypeLine | PredicateField::OracleText => {
            if !nested {
                return None;
            }
            fts_subquery(a, fts_column_term(pred))?
        }
        // Free text inside a group: every column, as the top-level free text reads them.
        PredicateField::Text => fts_subquery(a, fts_query(value))?,
        PredicateField::OracleTag => tag_clause(a, value, false)?,
        PredicateField::ArtTag => tag_clause(a, value, true)?,

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
                "(({a}.keywords IS NOT NULL AND instr({a}.keywords, ?) > 0) \
                 OR ({a}.keywords IS NULL AND instr(lower({a}.search_text), lower(?)) > 0))"
            ),
            vec![
                Box::new(format!("|{}|", value.to_ascii_lowercase())),
                Box::new(value.to_owned()),
            ],
        ),

        // **The one predicate here that scans.** There is no artist FTS column, and `instr`
        // is not sargable, so no index can seek it — acceptable where `t:`/`o:` were not,
        // because it is ANDed into a statement the FTS join, the format mask or the collapse
        // index has usually already narrowed. A bare `a:` on an otherwise empty box is the
        // worst case, and `idx_cards_artist` (in `schema::CARDS_INDEXES`) is what keeps it
        // cheap: the scan reads that narrow index instead of the row heap, ~16 ms against
        // 466–510 ms without it on the 117,738-printing corpus.
        //
        // `instr(NULL, …)` is NULL, so an orphan fails this exactly as it fails the format and
        // rarity arms.
        PredicateField::Artist => match op {
            PredicateOp::Eq => bound(format!("lower({a}.artist) = lower(?)"), value.to_owned()),
            _ => bound(
                format!("instr(lower({a}.artist), lower(?)) > 0"),
                value.to_owned(),
            ),
        },

        // **`c:` is new and `id:` is not**, and getting the two the wrong way round would make
        // `c:rg` answer 13 399 where Scryfall answers 676. The app's existing `colors` filter
        // is colour *identity* with subset semantics, which is Scryfall's `id:`; card colours
        // have never been filtered on before.
        PredicateField::Colors => color_clause(&format!("{a}.colors"), op, value),
        PredicateField::ColorIdentity => color_clause(&format!("{a}.color_identity"), op, value),

        PredicateField::Cmc => match value.to_ascii_lowercase().as_str() {
            "even" => parity_clause(a, op, 0),
            "odd" => parity_clause(a, op, 1),
            _ => numeric_clause(&format!("{a}.cmc"), op, value, false, Some(a)),
        },
        PredicateField::Power => numeric_clause(&format!("{a}.power"), op, value, true, Some(a)),
        PredicateField::Toughness => {
            numeric_clause(&format!("{a}.toughness"), op, value, true, Some(a))
        }
        PredicateField::Loyalty => numeric_clause(&loyalty_expr(a), op, value, true, Some(a)),
        // Power plus toughness: a NULL either side (a non-creature) fails, a star is zero.
        PredicateField::PowTou => numeric_clause(
            &format!("(CAST({a}.power AS REAL) + CAST({a}.toughness AS REAL))"),
            op,
            value,
            false,
            Some(a),
        ),

        // Ordered — see [`RARITY_ORDER`]. **This is the one field the grammar canonicalises
        // before it sends one**: `r:c` arrives as `common` and `r:Rare` as `rare`, so there is
        // no single-letter expansion here and there must not be one — it would be code no
        // caller can reach. The lower-casing stays for [`picked_rarities`]' reason, against a
        // hand-built payload: `cards.rarity` holds Scryfall's own lower-case word and SQLite's
        // `=` on text is case-sensitive, so a `Rare` bound as sent matches nothing and reads
        // as an empty corpus rather than as a mistake. `special` and `bonus` compare by
        // equality and have no place in the order.
        PredicateField::Rarity => {
            let value = value.to_ascii_lowercase();
            match op {
                PredicateOp::Colon | PredicateOp::Eq => bound(format!("{a}.rarity = ?"), value),
                PredicateOp::Ne => bound(format!("{a}.rarity <> ?"), value),
                _ => {
                    let Some(i) = RARITY_ORDER.iter().position(|r| *r == value) else {
                        return Some(no_match());
                    };
                    let picked: &[&str] = match op {
                        PredicateOp::Gte => &RARITY_ORDER[i..],
                        PredicateOp::Gt => &RARITY_ORDER[i + 1..],
                        PredicateOp::Lte => &RARITY_ORDER[..=i],
                        _ => &RARITY_ORDER[..i],
                    };
                    if picked.is_empty() {
                        return Some(no_match());
                    }
                    let holes = vec!["?"; picked.len()].join(",");
                    (
                        format!("{a}.rarity IN ({holes})"),
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
        // [`color_value`] names: the grammar sends `s:NEO` exactly as the reader typed it,
        // `cards.set_code` holds Scryfall's lower-case code, and SQLite's `=` on text is
        // case-sensitive — so the unfolded comparison is an empty wall with no error.
        PredicateField::SetCode => bound(format!("{set_code} = ?"), value.to_ascii_lowercase()),

        // [`crate::legalities::bit`], exactly as the `format` field's own arm does it — and an
        // unrecognised key is [`NO_MATCH`] there too.
        PredicateField::Format => match crate::legalities::bit(&value.to_ascii_lowercase()) {
            Some(bit) => bound(format!("({a}.legal_mask & ?) != 0"), bit as i64),
            None => no_match(),
        },

        // `ft:` contains, `ft=` is the whole text; a printing with none is `''`, so `-ft:x`
        // keeps it. Case-folded like `a:`.
        PredicateField::Flavor => {
            let flavor = fact(a, "flavor_text");
            match op {
                PredicateOp::Eq => bound(format!("lower({flavor}) = lower(?)"), value.to_owned()),
                PredicateOp::Ne => not(bound(
                    format!("lower({flavor}) = lower(?)"),
                    value.to_owned(),
                )),
                _ => bound(
                    format!("instr(lower({flavor}), lower(?)) > 0"),
                    value.to_owned(),
                ),
            }
        }
        PredicateField::Watermark => negate_if(
            ne,
            bound(
                format!("lower({}) = lower(?)", fact(a, "watermark")),
                value.to_owned(),
            ),
        ),
        PredicateField::Stamp => negate_if(
            ne,
            bound(
                format!("lower({}) = lower(?)", fact(a, "security_stamp")),
                value.to_owned(),
            ),
        ),
        PredicateField::ManaCost => mana_cost_clause(&format!("{a}.mana_cost"), op, value),
        PredicateField::Devotion => devotion_clause(&format!("{a}.mana_cost"), op, value),
        PredicateField::Produces => produces_clause(&format!("{a}.produced_mana"), op, value),
        PredicateField::CollectorNumber => collector_number_clause(a, op, value),

        // Through `sets`, by the caller's set-code expression.
        PredicateField::SetType => negate_if(
            ne,
            bound(
                format!("{set_code} IN (SELECT ss.code FROM sets ss WHERE ss.set_type = ?)"),
                value.to_ascii_lowercase(),
            ),
        ),
        PredicateField::Block => negate_if(ne, block_clause(set_code, value)),
        PredicateField::InPrinting => negate_if(ne, in_printing_clause(a, value)),

        // `games` is a JSON array stored as text; the quoted word is the delimiter, the finish
        // chips' argument.
        PredicateField::Game => negate_if(
            ne,
            bound(
                format!("instr({a}.games, ?) > 0"),
                format!("\"{}\"", value.to_ascii_lowercase()),
            ),
        ),
        // `lang:any` asks for every language, which is no filter — the blank rule.
        PredicateField::Language => {
            if value.eq_ignore_ascii_case("any") {
                return None;
            }
            let code = language_code(value)
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_ascii_lowercase());
            negate_if(ne, bound(format!("{a}.lang = ?"), code))
        }
        PredicateField::Year => match value.parse::<i64>() {
            Ok(year) => bound(
                format!(
                    "CAST(substr({a}.released_at, 1, 4) AS INTEGER) {} ?",
                    comparison(op)
                ),
                year,
            ),
            Err(_) => no_match(),
        },
        PredicateField::Date => date_clause(a, op, value),

        // A NULL price — no market for that printing — fails every comparison, as a land's
        // power does.
        PredicateField::Usd => numeric_clause(&format!("{a}.price_usd"), op, value, false, None),
        PredicateField::Eur => numeric_clause(&format!("{a}.price_eur"), op, value, false, None),
        PredicateField::Tix => numeric_clause(
            &format!("json_extract({a}.prices, '$.tix')"),
            op,
            value,
            false,
            None,
        ),

        // The column's own word — `black`, `white`, `borderless`, `silver`, `gold`, `yellow`.
        PredicateField::Border => negate_if(
            ne,
            bound(
                format!("lower({a}.border_color) = lower(?)"),
                value.to_owned(),
            ),
        ),
        PredicateField::Frame => negate_if(ne, frame_clause(a, value)),
        PredicateField::Banned => negate_if(ne, legality_clause(a, value, "banned")),
        PredicateField::Restricted => negate_if(ne, legality_clause(a, value, "restricted")),

        PredicateField::Prints => print_count_clause(a, op, value, false, false),
        PredicateField::PaperPrints => print_count_clause(a, op, value, false, true),
        PredicateField::Sets => print_count_clause(a, op, value, true, false),
        PredicateField::PaperSets => print_count_clause(a, op, value, true, true),

        PredicateField::NewFeature => negate_if(ne, new_feature_clause(a, value)),
        PredicateField::Is => negate_if(ne, is_clause(a, set_code, value)),
        PredicateField::Has => negate_if(ne, has_clause(a, value)),
    };

    // A leading `-` in the box. Wrapped rather than inverted per arm, because an arm that
    // inverted itself would have to get every NULL right twice.
    Some(if pred.negated {
        not((sql, params))
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

/// The border chips a request really filters on: trimmed, lower-cased, anything outside
/// [`BORDER_KEYS`] dropped, sorted and deduplicated.
///
/// **An empty answer means "no border filter", never "match nothing"** — [`picked_types`]'
/// rule, and for its reason: the list is validated, so `["shiny"]` leaves nothing and both the
/// SQL and [`crate::index::facets`] read that as no filter at all. A shared function for
/// [`picked_rarities`]' reason — the facet index narrows by exactly this list, and a facet
/// counted over a chip the search dropped reports an option live that the search cannot reach.
///
/// Lower-cased where [`picked_types`] matches exactly, because these ids are lower-case words
/// the way [`picked_rarities`]' are, and a padded or capitalised id from a hand-built payload
/// costs nothing to read as the reader meant it.
pub fn picked_borders(borders: &[String]) -> Vec<String> {
    picked_from(borders, &BORDER_KEYS)
}

/// The printed-finish chips a request really filters on — [`picked_borders`]' rules against
/// [`FINISH_KEYS`], shared with [`crate::index::facets`] for the same reason.
pub fn picked_finishes(finishes: &[String]) -> Vec<String> {
    picked_from(finishes, &FINISH_KEYS)
}

/// The universe a request really filters on: trimmed and lower-cased, and `None` for anything
/// outside [`UNIVERSE_KEYS`] — which is no filter, never "match nothing".
pub fn picked_universe(universe: &Option<String>) -> Option<&'static str> {
    let v = nonblank(universe)?.to_ascii_lowercase();
    UNIVERSE_KEYS.iter().copied().find(|k| *k == v)
}

/// Trim, lower-case, keep what `vocabulary` names, sort, deduplicate — the one body both
/// [`picked_borders`] and [`picked_finishes`] are.
fn picked_from(values: &[String], vocabulary: &[&str]) -> Vec<String> {
    let mut picked: Vec<String> = values
        .iter()
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| vocabulary.contains(&v.as_str()))
        .collect();
    picked.sort();
    picked.dedup();
    picked
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
        // An unreleased printing is legal nowhere until its release day, and still a card a
        // reader is looking for (issue #940) — so the clause admits it beside the mask.
        assert!(
            on.contains("(c.legal_mask != 0 OR c.released_at > date('now'))"),
            "{on}"
        );
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
            terms: Vec::new(),
        }
    }

    /// An `or` / parenthesised `and` over `terms` — op `colon` and value `""`, as the grammar
    /// sends one.
    fn group(field: PredicateField, terms: Vec<QueryPredicate>) -> QueryPredicate {
        QueryPredicate {
            terms,
            ..pred(field, PredicateOp::Colon, "")
        }
    }

    fn negated(field: PredicateField, op: PredicateOp, value: &str) -> QueryPredicate {
        QueryPredicate {
            negated: true,
            ..pred(field, op, value)
        }
    }

    /// Every field, so a census can walk them without naming them twice — and the `match` in
    /// [`sample`] has no `_` arm, so a field added to the enum and not here fails to compile
    /// there rather than slipping past every census below.
    const EVERY_FIELD: [PredicateField; 48] = [
        PredicateField::Name,
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
        PredicateField::AnyOf,
        PredicateField::AllOf,
        PredicateField::Text,
        PredicateField::OracleTag,
        PredicateField::ArtTag,
        PredicateField::Flavor,
        PredicateField::Watermark,
        PredicateField::ManaCost,
        PredicateField::Devotion,
        PredicateField::Produces,
        PredicateField::Loyalty,
        PredicateField::PowTou,
        PredicateField::CollectorNumber,
        PredicateField::SetType,
        PredicateField::Block,
        PredicateField::InPrinting,
        PredicateField::Game,
        PredicateField::Language,
        PredicateField::Year,
        PredicateField::Date,
        PredicateField::Usd,
        PredicateField::Eur,
        PredicateField::Tix,
        PredicateField::Border,
        PredicateField::Frame,
        PredicateField::Stamp,
        PredicateField::Banned,
        PredicateField::Restricted,
        PredicateField::Prints,
        PredicateField::PaperPrints,
        PredicateField::Sets,
        PredicateField::PaperSets,
        PredicateField::NewFeature,
        PredicateField::Is,
        PredicateField::Has,
    ];

    /// A term each field really answers, with `op` — a value the field reads (a number for a
    /// count, a word from its vocabulary), and for a group two children, so the census asks
    /// every field a question it has an answer to.
    fn sample(field: PredicateField, op: PredicateOp) -> QueryPredicate {
        let value = match field {
            PredicateField::AnyOf | PredicateField::AllOf => {
                return QueryPredicate {
                    op,
                    ..group(
                        field,
                        vec![
                            pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin"),
                            pred(PredicateField::Cmc, PredicateOp::Gte, "3"),
                        ],
                    )
                }
            }
            PredicateField::Name
            | PredicateField::TypeLine
            | PredicateField::OracleText
            | PredicateField::Keyword
            | PredicateField::Artist
            | PredicateField::Text
            | PredicateField::Flavor => "goblin",
            PredicateField::OracleTag | PredicateField::ArtTag => "spot removal",
            PredicateField::Colors | PredicateField::ColorIdentity => "rg",
            PredicateField::Produces => "wc",
            PredicateField::ManaCost => "{2}{R}{R}",
            PredicateField::Devotion => "{G}{G}",
            PredicateField::Cmc
            | PredicateField::Power
            | PredicateField::Toughness
            | PredicateField::Loyalty
            | PredicateField::PowTou
            | PredicateField::CollectorNumber
            | PredicateField::Prints
            | PredicateField::PaperPrints
            | PredicateField::Sets
            | PredicateField::PaperSets => "3",
            PredicateField::Usd | PredicateField::Eur | PredicateField::Tix => "1.5",
            PredicateField::Rarity => "rare",
            PredicateField::SetCode | PredicateField::Block | PredicateField::InPrinting => "zen",
            PredicateField::Format | PredicateField::Banned | PredicateField::Restricted => {
                "modern"
            }
            PredicateField::Watermark => "boros",
            PredicateField::SetType => "expansion",
            PredicateField::Game => "paper",
            PredicateField::Language => "japanese",
            PredicateField::Year => "2020",
            PredicateField::Date => "2020-05",
            PredicateField::Border => "black",
            PredicateField::Frame => "2015",
            PredicateField::Stamp => "oval",
            PredicateField::NewFeature => "art",
            PredicateField::Is => "foil",
            PredicateField::Has => "watermark",
        };
        pred(field, op, value)
    }

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
        let mut terms: Vec<QueryPredicate> = EVERY_FIELD
            .iter()
            .map(|field| sample(*field, PredicateOp::Colon))
            .collect();
        // `name` is the one field with a foot on each side: `!name` is SQL.
        terms.push(pred(PredicateField::Name, PredicateOp::Eq, "goblin guide"));
        for term in terms {
            let field = term.field;
            let sql = predicate_wheres(vec![term.clone()]);
            let (positive, negatives) = fts_match(None, std::slice::from_ref(&term));
            let rides_fts = positive.is_some() || !negatives.is_empty();
            assert_ne!(
                !sql.is_empty(),
                rides_fts,
                "{field:?} is emitted by both sides or by neither: sql={sql:?} fts={positive:?}"
            );
            assert!(
                !sql.iter().any(|w| w == NO_MATCH),
                "{field:?}'s sample is a value it can read, not a NO_MATCH: {sql:?}"
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
    /// the strings `packages/ui/lib/ipc.ts` declares and `queryLanguage.ts` produces, so this is the
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
                {"field":"format","op":"eq","value":"modern"},
                {"field":"name","op":"colon","value":"lightning bolt","negated":true},
                {"field":"anyOf","op":"colon","value":"","terms":[
                    {"field":"typeLine","op":"colon","value":"goblin"},
                    {"field":"allOf","op":"colon","value":"","terms":[
                        {"field":"text","op":"colon","value":"bolt"},
                        {"field":"oracleTag","op":"colon","value":"removal"}
                    ]}
                ]},
                {"field":"allOf","op":"colon","value":"","negated":true,"terms":[
                    {"field":"artTag","op":"colon","value":"dragon"}
                ]},
                {"field":"text","op":"colon","value":"bolt"},
                {"field":"oracleTag","op":"colon","value":"ramp"},
                {"field":"artTag","op":"colon","value":"dog"},
                {"field":"flavor","op":"colon","value":"sparkmage"},
                {"field":"watermark","op":"eq","value":"boros"},
                {"field":"manaCost","op":"gte","value":"{R}"},
                {"field":"devotion","op":"gte","value":"{G}{G}"},
                {"field":"produces","op":"gte","value":"wu"},
                {"field":"loyalty","op":"gte","value":"4"},
                {"field":"powTou","op":"gt","value":"5"},
                {"field":"collectorNumber","op":"eq","value":"161"},
                {"field":"setType","op":"eq","value":"masters"},
                {"field":"block","op":"eq","value":"zen"},
                {"field":"inPrinting","op":"eq","value":"lea"},
                {"field":"game","op":"eq","value":"arena"},
                {"field":"language","op":"eq","value":"ja"},
                {"field":"year","op":"lt","value":"2000"},
                {"field":"date","op":"gte","value":"2020-01-01"},
                {"field":"usd","op":"lt","value":"1"},
                {"field":"eur","op":"lt","value":"1"},
                {"field":"tix","op":"lt","value":"1"},
                {"field":"border","op":"eq","value":"white"},
                {"field":"frame","op":"eq","value":"future"},
                {"field":"stamp","op":"eq","value":"acorn"},
                {"field":"banned","op":"eq","value":"modern"},
                {"field":"restricted","op":"eq","value":"vintage"},
                {"field":"prints","op":"eq","value":"1"},
                {"field":"paperPrints","op":"gte","value":"2"},
                {"field":"sets","op":"eq","value":"1"},
                {"field":"paperSets","op":"gte","value":"2"},
                {"field":"newFeature","op":"eq","value":"art"},
                {"field":"is","op":"eq","value":"foil","negated":true},
                {"field":"has","op":"eq","value":"watermark"}
            ]"#,
        )
        .expect("every name here is what the TypeScript mirror sends");

        // One payload per field: the 13 originals, then the two groups, then the 33 others.
        assert_eq!(parsed.len(), EVERY_FIELD.len(), "one payload per field");
        let fields: Vec<PredicateField> = parsed.iter().map(|p| p.field).collect();
        for field in EVERY_FIELD {
            assert!(
                fields.contains(&field),
                "{field:?} has no wire payload here"
            );
        }
        // `terms` is `#[serde(default)]` and recursive: absent on a plain term, a list on a
        // group, and a group inside a group parses all the way down.
        assert!(parsed[0].terms.is_empty());
        assert_eq!(parsed[13].field, PredicateField::AnyOf);
        assert_eq!(parsed[13].terms.len(), 2);
        assert_eq!(
            parsed[13].terms[1].terms[1].field,
            PredicateField::OracleTag
        );
        assert!(parsed[14].negated);
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
            .filter(|f| {
                !matches!(
                    f,
                    PredicateField::Name | PredicateField::TypeLine | PredicateField::OracleText
                )
            })
            .map(|f| pred(*f, PredicateOp::Colon, "goblin"))
            .collect();
        assert_eq!(fts_match(None, &preds), (None, Vec::new()));
    }

    /// **`-"lightning bolt"` is an ordered phrase on `name` alone, and the free text beside it
    /// keeps reading every column** — issue #571, and the asymmetry is Scryfall's: `-bolt` is
    /// `-name:bolt` there (both 3,891 of 3,909 instants, measured live 2026-09-27).
    ///
    /// The `+` is the whole of the ordering: `"lightning"* "bolt"*` would also remove a card
    /// called *Bolt of Lightning*, while Scryfall's `-"bolt lightning"` removes nothing that
    /// `-"lightning bolt"` does. `search::tests::a_negated_name_excludes_by_name_alone` hands
    /// this string to a real index, which is what a shape assertion like this one cannot do.
    #[test]
    fn a_name_term_is_an_ordered_phrase_on_the_name_column_alone() {
        let (m, neg) = fts_match(
            Some("goblin"),
            &[negated(
                PredicateField::Name,
                PredicateOp::Colon,
                "Lightning Bolt",
            )],
        );
        assert_eq!(
            m.as_deref(),
            Some("\"goblin\"*"),
            "the free text has no column"
        );
        assert_eq!(neg, vec!["name : (\"Lightning\"* + \"Bolt\"*)"]);
        // One word is the same string either builder would make.
        assert_eq!(fts_phrase("bolt"), fts_query("bolt"));
        // And the apostrophe splits rather than welds, as it does for the free text.
        assert_eq!(
            fts_phrase("God-Pharaoh's Gift").as_deref(),
            Some("\"God\"* + \"Pharaoh\"* + \"s\"* + \"Gift\"*")
        );
        assert_eq!(fts_phrase("-!!"), None, "nothing indexable is no phrase");
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

    /// One printing per shape the border and finish chips have to tell apart, with the columns
    /// the ingest writes spelled as it writes them: `border_color` is Scryfall's word (or NULL,
    /// which the schema allows), `full_art` is `0`/`1`, and `finishes` is the JSON array as text.
    ///
    /// The borderless full-art row is the overlap every chip test turns on, the white-bordered
    /// one is `regular` in a colour that is not black, the NULL one is what a missing border
    /// word reads as, and the nonfoil-only one is what `"foil"` must not find inside
    /// `"nonfoil"`.
    fn corpus_with_frames() -> rusqlite::Connection {
        let conn = crate::schema::memory_pair();
        // (id, border_color, full_art, finishes)
        let rows: [(&str, Option<&str>, i64, &str); 7] = [
            ("black", Some("black"), 0, r#"["nonfoil","foil"]"#),
            ("white", Some("white"), 0, r#"["nonfoil"]"#),
            ("unknown", None, 0, r#"["nonfoil"]"#),
            ("borderless", Some("borderless"), 0, r#"["foil"]"#),
            ("fullart", Some("black"), 1, r#"["nonfoil","foil"]"#),
            ("both", Some("borderless"), 1, r#"["foil","etched"]"#),
            ("etched", Some("black"), 0, r#"["etched"]"#),
        ];
        for (id, border, full_art, finishes) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw,
                                    border_color,full_art,finishes)
                 VALUES (?1,?1,'tst',?1,'en','normal',1,'{}',?2,?3,?4)",
                rusqlite::params![id, border, full_art, finishes],
            )
            .unwrap();
        }
        conn
    }

    fn of_borders(borders: &[&str]) -> CardFilters {
        CardFilters {
            borders: Some(owned(borders)),
            ..Default::default()
        }
    }

    fn of_finishes(finishes: &[&str]) -> CardFilters {
        CardFilters {
            printed_finishes: Some(owned(finishes)),
            ..Default::default()
        }
    }

    /// The border chips are **OR within and AND without**, one parenthesised group over two
    /// columns — and an empty or unknown list is *no filter*, never a filter matching nothing,
    /// which is the rarity chips' rule and the one every list filter here has been bitten by.
    #[test]
    fn the_border_chips_or_within_and_an_empty_list_is_no_filter() {
        let sql = |f: CardFilters| {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            p.where_sql()
        };
        for f in [
            CardFilters::default(),
            of_borders(&[]),
            of_borders(&["", "  "]),
            of_borders(&["shiny"]),
        ] {
            let s = sql(f);
            assert!(
                !s.contains("border_color") && !s.contains("full_art"),
                "no border filter: {s}"
            );
        }

        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &of_borders(&["fullart", "borderless", "regular"]),
            "c",
            None,
        );
        let border: Vec<&String> = p
            .wheres
            .iter()
            .filter(|w| w.contains("border_color") || w.contains("full_art"))
            .collect();
        assert_eq!(
            border,
            vec![
                "(c.border_color = ? OR c.full_art = 1 OR \
                 (coalesce(c.border_color, '') <> ? AND c.full_art = 0))"
            ],
            "one group, ORed, in `picked_borders`' sorted order"
        );
        assert_eq!(p.params.len(), 2, "`borderless` is bound, twice");
    }

    /// `regular` is the printing that is **neither** borderless nor full art — whatever colour
    /// its border is, and whether or not Scryfall named one — and a borderless full-art
    /// printing answers **both** of the other chips, which is what makes these a filter rather
    /// than a partition.
    #[test]
    fn regular_is_neither_and_a_borderless_full_art_printing_answers_both_chips() {
        let conn = corpus_with_frames();
        assert_eq!(
            search_ids(&conn, of_borders(&["regular"])),
            owned(&["black", "etched", "unknown", "white"]),
            "black and white alike, and a NULL border is a border rather than its absence"
        );
        assert_eq!(
            search_ids(&conn, of_borders(&["borderless"])),
            owned(&["borderless", "both"])
        );
        assert_eq!(
            search_ids(&conn, of_borders(&["fullart"])),
            owned(&["both", "fullart"]),
            "the same row answers both chips"
        );
        assert_eq!(
            search_ids(&conn, of_borders(&["borderless", "fullart"])),
            owned(&["borderless", "both", "fullart"]),
            "a union, and `both` is one row rather than two"
        );
        assert_eq!(
            search_ids(&conn, of_borders(&[" Regular ", "REGULAR"])),
            search_ids(&conn, of_borders(&["regular"])),
            "trimmed and lower-cased, like the rarities"
        );
    }

    /// `"foil"` is quoted in the needle, so it cannot match inside `"nonfoil"` — without the
    /// quotes the nonfoil-only rows would answer the foil chip, and 44 019 paper printings would
    /// claim a foil nobody printed.
    #[test]
    fn the_finish_chips_match_the_quoted_word_and_foil_does_not_match_nonfoil() {
        let conn = corpus_with_frames();
        assert_eq!(
            search_ids(&conn, of_finishes(&["foil"])),
            owned(&["black", "borderless", "both", "fullart"]),
            "never `white` or `unknown`, whose only finish is nonfoil"
        );
        assert_eq!(
            search_ids(&conn, of_finishes(&["nonfoil"])),
            owned(&["black", "fullart", "unknown", "white"])
        );
        assert_eq!(
            search_ids(&conn, of_finishes(&["etched", "nonfoil"])),
            owned(&["black", "both", "etched", "fullart", "unknown", "white"]),
            "OR within"
        );
        assert_eq!(
            search_ids(
                &conn,
                CardFilters {
                    printed_finishes: Some(owned(&["etched"])),
                    borders: Some(owned(&["borderless"])),
                    ..Default::default()
                }
            ),
            owned(&["both"]),
            "and AND without"
        );

        let mut p = Predicates::default();
        push_card_filters(&mut p, &of_finishes(&["foil", "etched"]), "c", None);
        let finish: Vec<&String> = p.wheres.iter().filter(|w| w.contains("finishes")).collect();
        assert_eq!(
            finish,
            vec!["(instr(c.finishes, ?) > 0 OR instr(c.finishes, ?) > 0)"]
        );
        let all = search_ids(&conn, no_filters());
        for f in [of_finishes(&[]), of_finishes(&["shiny", " "])] {
            assert_eq!(search_ids(&conn, f), all, "no finish filter at all");
        }
    }

    /// An orphaned collection entry — a NULL card alias over the LEFT JOIN — fails **every**
    /// border and finish chip, `regular` included, whose `coalesce` half is true for a NULL
    /// border and whose `full_art = 0` half is what stops it: a frame and a finish list are
    /// claims only a card row can make, the rule the type and rarity arms state.
    #[test]
    fn an_orphan_fails_every_border_and_finish_chip() {
        let conn = crate::schema::memory_pair();
        let orphans = |f: CardFilters| -> i64 {
            // `paper_only` off, as the collection sends it — left on, `c.is_paper = 1` would
            // fail the orphan by itself and every assertion below would pass over nothing.
            let f = CardFilters {
                paper_only: Some(false),
                ..f
            };
            let mut p = Predicates::default();
            // `Some("e")`, as the collection sends it: nothing here falls back to the entry.
            push_card_filters(&mut p, &f, "c", Some("e"));
            // One orphaned row: every `c.` column is NULL, as the LEFT JOIN hands it over.
            let sql = format!(
                "SELECT count(*) FROM (SELECT NULL AS id, 'tst' AS set_code) e \
                 LEFT JOIN cards c ON c.id = e.id WHERE {}",
                p.where_sql()
            );
            conn.query_row(
                &sql,
                rusqlite::params_from_iter(p.params.iter().map(|b| b.as_ref())),
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(orphans(no_filters()), 1, "the orphan is there to be failed");
        for f in [
            of_borders(&["regular"]),
            of_borders(&["borderless"]),
            of_borders(&["fullart"]),
            of_finishes(&["nonfoil"]),
            of_finishes(&["foil", "etched"]),
            of_universe("beyond"),
            of_universe("within"),
        ] {
            let asked = format!("{:?} {:?} {:?}", f.borders, f.printed_finishes, f.universe);
            assert_eq!(orphans(f), 0, "{asked}");
        }
    }

    fn of_universe(universe: &str) -> CardFilters {
        CardFilters {
            universe: Some(universe.to_owned()),
            ..Default::default()
        }
    }

    /// One printing per shape the universe filter has to tell apart: Scryfall's word alone,
    /// beside other members, absent from a non-empty list, and the NULL most printings carry.
    fn corpus_with_universes() -> rusqlite::Connection {
        let conn = crate::schema::memory_pair();
        let rows: [(&str, Option<&str>); 4] = [
            ("ltr", Some(r#"["universesbeyond"]"#)),
            (
                "fin",
                Some(r#"["ffiv","sourcematerial","universesbeyond","boosterfun"]"#),
            ),
            ("promo", Some(r#"["boosterfun","surgefoil"]"#)),
            ("plain", None),
        ];
        for (id, promo_types) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw,
                                    promo_types)
                 VALUES (?1,?1,'tst',?1,'en','normal',1,'{}',?2)",
                rusqlite::params![id, promo_types],
            )
            .unwrap();
        }
        conn
    }

    /// **Beyond is Scryfall's `promo_types` word and Within is everything else** — the NULL
    /// four fifths of the corpus carry included — so the two partition the printings. Blank or
    /// unknown is no filter; case and padding are read as the reader meant them.
    #[test]
    fn the_universe_filter_partitions_printings_by_scryfalls_word() {
        let conn = corpus_with_universes();
        let all = search_ids(&conn, no_filters());
        assert_eq!(all, vec!["fin", "ltr", "plain", "promo"]);

        assert_eq!(search_ids(&conn, of_universe("beyond")), vec!["fin", "ltr"]);
        assert_eq!(
            search_ids(&conn, of_universe(" Within ")),
            vec!["plain", "promo"]
        );
        for unknown in ["", "  ", "both", "universesbeyond"] {
            assert_eq!(search_ids(&conn, of_universe(unknown)), all, "{unknown:?}");
        }

        // The `is:` word answers what the chip's Beyond does, under both spellings.
        for word in ["universesbeyond", "ub"] {
            let (sql, params) = is_clause("c", "c.set_code", word);
            let ids: Vec<String> = conn
                .prepare(&format!(
                    "SELECT c.id FROM cards c WHERE {sql} ORDER BY c.id"
                ))
                .unwrap()
                .query_map(
                    rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
                    |r| r.get(0),
                )
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert_eq!(ids, vec!["fin", "ltr"], "is:{word}");
        }
    }

    /// The wire name is `universe`, one word, and its two values are the filter row's.
    #[test]
    fn the_universe_wire_name_and_values() {
        let f: CardFilters = serde_json::from_str(r#"{"universe":"beyond"}"#).unwrap();
        assert_eq!(picked_universe(&f.universe), Some("beyond"));
        assert_eq!(picked_universe(&Some("WITHIN".into())), Some("within"));
        assert_eq!(picked_universe(&None), None);
        assert_eq!(UNIVERSE_KEYS, ["beyond", "within"]);
    }

    /// Both normalisers trim, lower-case, validate, sort and deduplicate — and they are what
    /// [`crate::index::facets`] narrows by, for [`picked_rarities`]' reason.
    #[test]
    fn picked_borders_and_finishes_validate_lower_case_sort_and_deduplicate() {
        assert_eq!(
            picked_borders(&owned(&[" FullArt ", "regular", "shiny", "", "regular"])),
            vec!["fullart", "regular"]
        );
        assert!(
            picked_borders(&owned(&["black"])).is_empty(),
            "a colour is not a chip"
        );
        assert_eq!(
            picked_finishes(&owned(&["Foil", "nonfoil", "glossy", "foil"])),
            vec!["foil", "nonfoil"]
        );
        assert!(picked_finishes(&[]).is_empty());
    }

    /// The wire names are `borders` and `printedFinishes`, and the second one is **not**
    /// `finishes` — [`crate::collection::CollectionQuery`] flattens this struct beside a
    /// `finishes` of its own, and the collision test lives there.
    #[test]
    fn the_border_and_finish_wire_names_are_camel_case() {
        let f: CardFilters =
            serde_json::from_str(r#"{"borders":["fullart"],"printedFinishes":["etched"]}"#)
                .unwrap();
        assert_eq!(f.borders, Some(vec!["fullart".to_owned()]));
        assert_eq!(f.printed_finishes, Some(vec!["etched".to_owned()]));
    }

    // ---------------------------------------------------------------------------------
    // The full syntax (issue #909): groups, exact names, and the long tail
    // ---------------------------------------------------------------------------------

    /// One printing for [`corpus_for_the_full_syntax`]: every column the new fields read, with
    /// a default for each, so a row names only what it is about.
    struct Printing {
        id: &'static str,
        oracle_id: Option<&'static str>,
        name: &'static str,
        lang: &'static str,
        released_at: &'static str,
        set_code: &'static str,
        collector_number: &'static str,
        rarity: &'static str,
        layout: &'static str,
        mana_cost: Option<&'static str>,
        cmc: f64,
        type_line: &'static str,
        oracle_text: Option<&'static str>,
        /// What `cards_fts` indexes beside the name and type line — the oracle text unless a
        /// double-faced row says otherwise, as `card_row` builds it.
        search_text: Option<&'static str>,
        colors: &'static str,
        color_identity: &'static str,
        legalities: &'static str,
        games: &'static str,
        finishes: &'static str,
        prices: &'static str,
        price_usd: Option<f64>,
        illustration_id: Option<&'static str>,
        frame_effects: Option<&'static str>,
        border_color: &'static str,
        promo_types: Option<&'static str>,
        artist: &'static str,
        power: Option<&'static str>,
        toughness: Option<&'static str>,
        produced_mana: &'static str,
        keywords: &'static str,
        /// `None` is a row that predates corpus schema 8.
        print_facts: Option<&'static str>,
    }

    impl Default for Printing {
        fn default() -> Self {
            Printing {
                id: "",
                oracle_id: None,
                name: "",
                lang: "en",
                released_at: "2000-01-01",
                set_code: "tst",
                collector_number: "1",
                rarity: "common",
                layout: "normal",
                mana_cost: None,
                cmc: 0.0,
                type_line: "",
                oracle_text: None,
                search_text: None,
                colors: "",
                color_identity: "",
                legalities: "{}",
                games: r#"["paper"]"#,
                finishes: r#"["nonfoil"]"#,
                prices: "{}",
                price_usd: None,
                illustration_id: None,
                frame_effects: None,
                border_color: "black",
                promo_types: None,
                artist: "Nobody",
                power: None,
                toughness: None,
                produced_mana: "",
                keywords: "",
                print_facts: Some("{}"),
            }
        }
    }

    /// Sixteen printings of fourteen cards, the sets they sit in, and two tag taxonomies — each
    /// row there to make one family of the new syntax answer something a wrong arm would not.
    ///
    /// * **Three Lightning Bolts** (`lea` 1993, `m10` 2009, `2xm` 2020): one oracle card with
    ///   two illustrations, two rarities, two languages and one flavour text between them — so
    ///   `prints:`, `new:`, `in:`, `!name` and the printing facts each have a card whose
    ///   printings disagree.
    /// * **`Fire // Ice` and `Delver of Secrets // Insectile Aberration`**: an exact name must
    ///   find either face.
    /// * **`Tundra` and `Flooded Strand`**: the two land templates `is:dual` and `is:fetchland`
    ///   must tell apart.
    /// * **`Old Card` has no `print_facts`** — a row that predates corpus schema 8 — and is the
    ///   row every negated print fact must still drop.
    #[rustfmt::skip]
    fn corpus_for_the_full_syntax() -> rusqlite::Connection {
        let conn = crate::schema::memory_pair();
        let rows = [
            Printing { id: "bolt", oracle_id: Some("o-bolt"), name: "Lightning Bolt", released_at: "1993-08-05",
                set_code: "lea", collector_number: "161", mana_cost: Some("{R}"), cmc: 1.0, type_line: "Instant",
                oracle_text: Some("Lightning Bolt deals 3 damage to any target."), colors: "R", color_identity: "R",
                legalities: r#"{"modern":"legal","vintage":"legal"}"#, games: r#"["paper","mtgo"]"#,
                prices: r#"{"usd":"1.50","tix":"0.02"}"#, price_usd: Some(1.5), illustration_id: Some("i-bolt"),
                artist: "Christopher Rush", print_facts: Some(r#"{"frame":"1993","reprint":false,"reserved":false}"#),
                ..Printing::default() },
            Printing { id: "bolt-m10", oracle_id: Some("o-bolt"), name: "Lightning Bolt", released_at: "2009-07-17",
                set_code: "m10", collector_number: "146", mana_cost: Some("{R}"), cmc: 1.0, type_line: "Instant",
                oracle_text: Some("Lightning Bolt deals 3 damage to any target."), colors: "R", color_identity: "R",
                legalities: r#"{"modern":"legal","vintage":"legal"}"#, finishes: r#"["nonfoil","foil"]"#,
                price_usd: Some(2.0), illustration_id: Some("i-bolt"), artist: "Christopher Moeller",
                print_facts: Some(r#"{"frame":"2003","reprint":true,"flavor_text":"The sparkmage shrieked."}"#),
                ..Printing::default() },
            Printing { id: "bolt-2xm", oracle_id: Some("o-bolt"), name: "Lightning Bolt", lang: "ja",
                released_at: "2020-08-07", set_code: "2xm", collector_number: "117", rarity: "uncommon",
                mana_cost: Some("{R}"), cmc: 1.0, type_line: "Instant",
                oracle_text: Some("Lightning Bolt deals 3 damage to any target."), colors: "R", color_identity: "R",
                legalities: r#"{"modern":"legal","vintage":"legal"}"#, games: r#"["paper","arena","mtgo"]"#,
                finishes: r#"["foil"]"#, illustration_id: Some("i-bolt-2xm"), frame_effects: Some(r#"["extendedart"]"#),
                border_color: "borderless", promo_types: Some(r#"["boosterfun"]"#),
                print_facts: Some(r#"{"frame":"2015","reprint":true}"#), ..Printing::default() },
            Printing { id: "goblin", name: "Goblin Guide", released_at: "2009-10-02", set_code: "zen",
                collector_number: "126", rarity: "rare", mana_cost: Some("{R}"), cmc: 1.0,
                type_line: "Creature — Goblin Scout",
                oracle_text: Some("Haste\nWhenever Goblin Guide attacks, defending player reveals the top card of their library."),
                colors: "R", color_identity: "R", price_usd: Some(3.0), power: Some("2"), toughness: Some("2"),
                keywords: "|haste|", print_facts: Some(r#"{"frame":"2003","watermark":"boros"}"#),
                ..Printing::default() },
            Printing { id: "fireice", name: "Fire // Ice", released_at: "2001-06-04", set_code: "apc",
                layout: "split", rarity: "uncommon", mana_cost: Some("{1}{R}"), cmc: 4.0, type_line: "Instant // Instant",
                search_text: Some("Fire Instant Fire deals 2 damage divided as you choose. Ice Instant Tap target permanent. Draw a card."),
                colors: "UR", color_identity: "UR", ..Printing::default() },
            Printing { id: "delver", name: "Delver of Secrets // Insectile Aberration", released_at: "2011-09-30",
                set_code: "isd", layout: "transform", mana_cost: Some("{U}"), cmc: 1.0,
                type_line: "Creature — Human Wizard // Creature — Human Insect",
                search_text: Some("Delver of Secrets Creature — Human Wizard At the beginning of your upkeep, look at the top card of your library. Insectile Aberration Creature — Human Insect Flying"),
                colors: "U", color_identity: "U", power: Some("1"), toughness: Some("1"), keywords: "|transform|",
                ..Printing::default() },
            Printing { id: "tundra", name: "Tundra", released_at: "1993-08-05", set_code: "lea",
                collector_number: "283", rarity: "rare", type_line: "Land — Plains Island",
                oracle_text: Some("({T}: Add {W} or {U}.)"), color_identity: "WU", produced_mana: "WU",
                print_facts: Some(r#"{"frame":"1993","reserved":true}"#), ..Printing::default() },
            Printing { id: "strand", name: "Flooded Strand", released_at: "2002-10-07", set_code: "ons",
                rarity: "rare", type_line: "Land",
                oracle_text: Some("{T}, Pay 1 life, Sacrifice Flooded Strand: Search your library for a Plains or Island card, put it onto the battlefield, then shuffle."),
                ..Printing::default() },
            Printing { id: "niv", name: "Niv-Mizzet Reborn", released_at: "2019-05-03", set_code: "war",
                rarity: "mythic", mana_cost: Some("{W}{U}{B}{R}{G}"), cmc: 5.0,
                type_line: "Legendary Creature — Dragon Avatar",
                oracle_text: Some("Flying\nWhen Niv-Mizzet Reborn enters, reveal the top ten cards of your library."),
                colors: "WUBRG", color_identity: "WUBRG", illustration_id: Some("i-niv"), power: Some("6"),
                toughness: Some("6"), keywords: "|flying|", ..Printing::default() },
            Printing { id: "bears", name: "Grizzly Bears", released_at: "1993-08-05", set_code: "lea",
                mana_cost: Some("{1}{G}"), cmc: 2.0, type_line: "Creature — Bear", oracle_text: Some(""),
                colors: "G", color_identity: "G", power: Some("2"), toughness: Some("2"), ..Printing::default() },
            Printing { id: "serra", name: "Serra Angel", released_at: "1993-08-05", set_code: "lea",
                rarity: "uncommon", mana_cost: Some("{3}{W}{W}"), cmc: 5.0, type_line: "Creature — Angel",
                oracle_text: Some("Flying, vigilance"), colors: "W", color_identity: "W", power: Some("4"),
                toughness: Some("4"), keywords: "|flying|vigilance|", ..Printing::default() },
            Printing { id: "finks", name: "Kitchen Finks", released_at: "2008-05-02", set_code: "shm",
                rarity: "uncommon", mana_cost: Some("{1}{G/W}{G/W}"), cmc: 3.0, type_line: "Creature — Ouphe",
                oracle_text: Some("When Kitchen Finks enters, you gain 2 life.\nPersist (When this creature dies, return it.)"),
                colors: "GW", color_identity: "GW", power: Some("3"), toughness: Some("2"), keywords: "|persist|",
                ..Printing::default() },
            Printing { id: "ugin", name: "Ugin, the Spirit Dragon", released_at: "2014-11-07", set_code: "frf",
                rarity: "mythic", mana_cost: Some("{8}"), cmc: 8.0, type_line: "Legendary Planeswalker — Ugin",
                oracle_text: Some("+2: Ugin deals 3 damage to any target."), print_facts: Some(r#"{"loyalty":"7"}"#),
                ..Printing::default() },
            Printing { id: "unhinged", name: "Infinity Elemental", released_at: "2004-11-19", set_code: "unh",
                rarity: "rare", mana_cost: Some("{4}{R}{R}{R}"), cmc: 7.0, type_line: "Creature — Elemental",
                oracle_text: Some("When Infinity Elemental dies, you lose the game."), colors: "R", color_identity: "R", power: Some("∞"), toughness: Some("5"), ..Printing::default() },
            Printing { id: "old", name: "Old Card", mana_cost: Some("{3}"), cmc: 3.0, type_line: "Artifact",
                legalities: r#"{"modern":"banned","vintage":"restricted"}"#, print_facts: None,
                ..Printing::default() },
        ];
        for r in rows {
            let legal_mask = crate::legalities::legal_mask(&serde_json::from_str(r.legalities).unwrap());
            let search_text = r.search_text.or(r.oracle_text).unwrap_or("");
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, lang, released_at, set_code, collector_number, rarity,
                    layout, mana_cost, cmc, type_line, oracle_text, colors, color_identity, legalities, games,
                    finishes, prices, price_usd, illustration_id, frame_effects, border_color, promo_types,
                    is_paper, search_text, raw, artist, power, toughness, legal_mask, produced_mana, type_mask,
                    keywords, print_facts)
                 VALUES (?1, coalesce(?2, ?1), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                    ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, 1, ?25, '{}', ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33)",
                rusqlite::params![
                    r.id, r.oracle_id, r.name, r.lang, r.released_at, r.set_code, r.collector_number, r.rarity,
                    r.layout, r.mana_cost, r.cmc, r.type_line, r.oracle_text, r.colors, r.color_identity,
                    r.legalities, r.games, r.finishes, r.prices, r.price_usd, r.illustration_id, r.frame_effects,
                    r.border_color, r.promo_types, search_text, r.artist, r.power, r.toughness,
                    legal_mask as i64, r.produced_mana, i64::from(crate::cardtypes::type_mask(r.type_line)),
                    r.keywords, r.print_facts,
                ],
            ).unwrap();
        }
        // code, type, released, block_code, block — `wwk` shares Zendikar's block and holds no
        // card here, which is what makes `b:wwk` a question about the block and not the set.
        let sets = [
            ("lea", "core",      "1993-08-05", None,        None),
            ("m10", "core",      "2009-07-17", None,        None),
            ("2xm", "masters",   "2020-08-07", None,        None),
            ("zen", "expansion", "2009-10-02", Some("zen"), Some("Zendikar")),
            ("wwk", "expansion", "2010-02-05", Some("zen"), Some("Zendikar")),
            ("apc", "expansion", "2001-06-04", Some("inv"), Some("Invasion")),
            ("isd", "expansion", "2011-09-30", Some("isd"), Some("Innistrad")),
            ("ons", "expansion", "2002-10-07", Some("ons"), Some("Onslaught")),
            ("war", "expansion", "2019-05-03", None,        None),
            ("shm", "expansion", "2008-05-02", Some("shm"), Some("Shadowmoor")),
            ("frf", "expansion", "2014-11-07", Some("ktk"), Some("Khans of Tarkir")),
            ("unh", "funny",     "2004-11-19", None,        None),
            ("tst", "expansion", "2000-01-01", None,        None),
        ];
        for (code, set_type, released, block_code, block) in sets {
            conn.execute(
                "INSERT INTO sets (code, name, set_type, released_at, block_code, block) VALUES (?1, ?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![code, set_type, released, block_code, block],
            ).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, label, id, slug_norm) VALUES
                 ('removal', 'Removal', 'r', 'removal'), ('spot-removal', 'Spot Removal', 's', 'spotremoval');
             INSERT INTO oracle_tag_cards (oracle_id, slug) VALUES
                 ('o-bolt', 'removal'), ('o-bolt', 'spot-removal'), ('fireice', 'removal');
             INSERT INTO art_tags (slug, id, label, slug_norm) VALUES ('dragon', 'd', 'Dragon', 'dragon');
             INSERT INTO art_tag_illustrations (illustration_id, slug, weight) VALUES ('i-niv', 'dragon', 'strong');
             INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
        ).unwrap();
        conn
    }

    /// The ids a predicate list leaves standing through **both** halves — [`fts_match`] the way
    /// the collection applies it (a `rowid IN` per side) and [`push_card_filters`] — in id order.
    fn full_ids(conn: &rusqlite::Connection, preds: Vec<QueryPredicate>) -> Vec<String> {
        let mut p = Predicates::default();
        let (matched, negatives) = fts_match(None, &preds);
        if let Some(query) = matched {
            p.push(
                "c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".to_owned(),
                Box::new(query),
            );
        }
        for negative in negatives {
            p.push(
                "c.rowid NOT IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".to_owned(),
                Box::new(negative),
            );
        }
        push_card_filters(
            &mut p,
            &CardFilters {
                predicates: Some(preds),
                ..Default::default()
            },
            "c",
            None,
        );
        let sql = format!(
            "SELECT c.id FROM cards c WHERE {} ORDER BY c.id",
            p.where_sql()
        );
        let mut stmt = conn.prepare(&sql).unwrap_or_else(|e| panic!("{e}: {sql}"));
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(p.params.iter().map(|b| b.as_ref())),
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_else(|e| panic!("{e}: {sql}"))
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        rows
    }

    /// `ids` sorted the way [`full_ids`] orders its answer, so an expectation can be written in
    /// whatever order reads best.
    fn sorted(ids: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = ids.iter().map(|s| (*s).to_owned()).collect();
        v.sort();
        v
    }

    /// One predicate's ids.
    fn one(conn: &rusqlite::Connection, term: QueryPredicate) -> Vec<String> {
        full_ids(conn, vec![term])
    }

    /// Every id [`corpus_for_the_full_syntax`] seeds.
    const ALL: [&str; 15] = [
        "bears", "bolt", "bolt-2xm", "bolt-m10", "delver", "fireice", "finks", "goblin", "niv",
        "old", "serra", "strand", "tundra", "ugin", "unhinged",
    ];

    /// Every id but these.
    fn all_but(excluded: &[&str]) -> Vec<String> {
        sorted(
            &ALL.iter()
                .copied()
                .filter(|id| !excluded.contains(id))
                .collect::<Vec<_>>(),
        )
    }

    /// **`t:goblin or t:land` is two index lookups ORed, which the one top-level `MATCH` cannot
    /// spell** — it is a conjunction with everything beside it. So each grouped FTS term is its
    /// own `rowid IN (…)`, and the group is one parenthesised clause the top level ANDs.
    #[test]
    fn an_or_of_two_index_terms_answers_either() {
        let conn = corpus_for_the_full_syntax();
        let either = group(
            PredicateField::AnyOf,
            vec![
                pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin"),
                pred(PredicateField::TypeLine, PredicateOp::Colon, "land"),
            ],
        );
        // Nothing reaches the MATCH: the group is SQL, top level or not.
        assert_eq!(
            fts_match(None, std::slice::from_ref(&either)),
            (None, Vec::new())
        );
        let sql = one_clause(either.clone());
        assert_eq!(sql.matches("cards_fts MATCH ?").count(), 2, "{sql}");
        assert!(sql.starts_with('(') && sql.contains(" OR "), "{sql}");
        assert_eq!(one(&conn, either), sorted(&["goblin", "tundra", "strand"]));

        // And a name term inside a group is the ordered phrase on `name`, through its own
        // subquery — `-bolt`'s spelling, one level down.
        assert_eq!(
            one(
                &conn,
                group(
                    PredicateField::AnyOf,
                    vec![
                        pred(PredicateField::Name, PredicateOp::Colon, "lightning bolt"),
                        pred(PredicateField::OracleText, PredicateOp::Colon, "vigilance"),
                    ],
                )
            ),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "serra"])
        );
    }

    /// An index term ORed with a SQL term — the shape no earlier build could express at all.
    #[test]
    fn an_or_of_an_index_term_and_a_sql_term() {
        let conn = corpus_for_the_full_syntax();
        assert_eq!(
            one(
                &conn,
                group(
                    PredicateField::AnyOf,
                    vec![
                        pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin"),
                        pred(PredicateField::Cmc, PredicateOp::Gte, "7"),
                    ],
                )
            ),
            sorted(&["goblin", "ugin", "unhinged"])
        );
    }

    /// `-(t:creature cmc<=1)` — a negated conjunction, which the grammar sends as an `allOf`
    /// because flattening it would distribute the `-` wrongly (`-t:creature -cmc<=1`).
    #[test]
    fn a_negated_group_removes_exactly_what_the_group_matches() {
        let conn = corpus_for_the_full_syntax();
        let both = group(
            PredicateField::AllOf,
            vec![
                pred(PredicateField::TypeLine, PredicateOp::Colon, "creature"),
                pred(PredicateField::Cmc, PredicateOp::Lte, "1"),
            ],
        );
        assert_eq!(one(&conn, both.clone()), sorted(&["goblin", "delver"]));
        assert_eq!(
            one(
                &conn,
                QueryPredicate {
                    negated: true,
                    ..both
                }
            ),
            all_but(&["goblin", "delver"])
        );
    }

    /// An `or` beside a plain term (`c:r (t:goblin or t:instant)`), and an `and` inside an `or`
    /// (`(t:creature c:g) or t:land`) — the two nestings the grammar produces.
    #[test]
    fn groups_nest_inside_conjunctions_and_conjunctions_inside_groups() {
        let conn = corpus_for_the_full_syntax();
        assert_eq!(
            full_ids(
                &conn,
                vec![
                    pred(PredicateField::Colors, PredicateOp::Colon, "r"),
                    group(
                        PredicateField::AnyOf,
                        vec![
                            pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin"),
                            pred(PredicateField::TypeLine, PredicateOp::Colon, "instant"),
                        ],
                    ),
                ]
            ),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "goblin", "fireice"])
        );
        assert_eq!(
            one(
                &conn,
                group(
                    PredicateField::AnyOf,
                    vec![
                        group(
                            PredicateField::AllOf,
                            vec![
                                pred(PredicateField::TypeLine, PredicateOp::Colon, "creature"),
                                pred(PredicateField::Colors, PredicateOp::Colon, "g"),
                            ],
                        ),
                        pred(PredicateField::TypeLine, PredicateOp::Colon, "land"),
                    ],
                )
            ),
            sorted(&["bears", "finks", "niv", "tundra", "strand"])
        );
    }

    /// Bare words and tag names inside a group: `insectile or otag:"spot removal"`. The tag is
    /// resolved here by its normalised name — the same fold `tag_resolve` uses — and an unknown
    /// tag matches nothing, so the other branch of an `or` still answers. A top-level `text` or
    /// tag term, which the grammar never sends, is answered by the same SQL.
    #[test]
    fn a_group_holds_free_text_and_tags() {
        let conn = corpus_for_the_full_syntax();
        let mixed = group(
            PredicateField::AnyOf,
            vec![
                pred(PredicateField::Text, PredicateOp::Colon, "insectile"),
                pred(
                    PredicateField::OracleTag,
                    PredicateOp::Colon,
                    "Spot Removal",
                ),
            ],
        );
        assert_eq!(
            one(&conn, mixed),
            sorted(&["delver", "bolt", "bolt-m10", "bolt-2xm"])
        );
        assert_eq!(
            one(
                &conn,
                group(
                    PredicateField::AnyOf,
                    vec![
                        pred(PredicateField::ArtTag, PredicateOp::Colon, "dragon"),
                        pred(PredicateField::OracleTag, PredicateOp::Colon, "no-such-tag"),
                    ],
                )
            ),
            vec!["niv"]
        );
        // Top level, as a hand-built payload would send them.
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Text, PredicateOp::Colon, "insectile")
            ),
            vec!["delver"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::OracleTag, PredicateOp::Colon, "removal")
            ),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "fireice"])
        );
        assert_eq!(
            one(
                &conn,
                negated(PredicateField::ArtTag, PredicateOp::Colon, "dragon")
            ),
            all_but(&["niv"])
        );
    }

    /// **A blank child is "no filter" — true — and the two connectives read that differently.**
    /// An `and` drops it; an `or` containing one is true outright, so the whole group is no
    /// clause rather than an `OR` of the rest that would narrow more than was asked. A group
    /// with nothing usable in it is no clause either way.
    #[test]
    fn a_blank_child_is_true_so_an_or_holding_one_is_no_clause() {
        let blank = pred(PredicateField::OracleTag, PredicateOp::Colon, "---");
        let goblin = pred(PredicateField::TypeLine, PredicateOp::Colon, "goblin");
        assert!(
            predicate_wheres(vec![group(
                PredicateField::AnyOf,
                vec![goblin.clone(), blank.clone()]
            )])
            .is_empty(),
            "goblins, or anything, is anything"
        );
        let and = one_clause(group(
            PredicateField::AllOf,
            vec![goblin.clone(), blank.clone()],
        ));
        assert_eq!(
            and.matches("MATCH").count(),
            1,
            "the blank child is dropped: {and}"
        );
        for field in [PredicateField::AnyOf, PredicateField::AllOf] {
            assert!(predicate_wheres(vec![group(field, vec![])]).is_empty());
            assert!(predicate_wheres(vec![group(field, vec![blank.clone()])]).is_empty());
            assert!(
                predicate_wheres(vec![group(
                    field,
                    vec![pred(PredicateField::TypeLine, PredicateOp::Colon, "!!!")]
                )])
                .is_empty(),
                "a term that tokenises to nothing is blank too"
            );
        }
        // And `lang:any` is blank by meaning rather than by spelling.
        assert!(
            predicate_wheres(vec![pred(PredicateField::Language, PredicateOp::Eq, "any")])
                .is_empty()
        );
    }

    /// **`!name` is SQL, never FTS**: equality on the whole name, case-folded, or on either face
    /// of an `A // B`. The prefix phrase would also have answered *Lightning Bolt Elemental*.
    #[test]
    fn an_exact_name_is_equality_on_the_name_or_either_face() {
        let conn = corpus_for_the_full_syntax();
        let exact = |v: &str| pred(PredicateField::Name, PredicateOp::Eq, v);
        assert_eq!(
            fts_match(None, &[exact("lightning bolt")]),
            (None, Vec::new()),
            "an exact name never reaches the MATCH"
        );
        assert_eq!(
            one(&conn, exact("LIGHTNING BOLT")),
            sorted(&["bolt", "bolt-m10", "bolt-2xm"])
        );
        assert!(
            one(&conn, exact("lightning")).is_empty(),
            "a prefix is not the name"
        );
        assert_eq!(one(&conn, exact("fire")), vec!["fireice"], "the front face");
        assert_eq!(one(&conn, exact("Ice")), vec!["fireice"], "the back face");
        assert_eq!(
            one(&conn, exact("fire // ice")),
            vec!["fireice"],
            "the whole name"
        );
        assert_eq!(one(&conn, exact("insectile aberration")), vec!["delver"]);
        assert!(one(&conn, exact("fire // ice // fire")).is_empty());
        assert_eq!(
            one(
                &conn,
                QueryPredicate {
                    negated: true,
                    ..exact("lightning bolt")
                }
            ),
            all_but(&["bolt", "bolt-m10", "bolt-2xm"])
        );
        // Inside a group, too.
        assert_eq!(
            one(
                &conn,
                group(PredicateField::AnyOf, vec![exact("tundra"), exact("ice")])
            ),
            sorted(&["tundra", "fireice"])
        );
    }

    /// `is:` across its five families — a layout, a card kind, a printing fact, a promo type and
    /// a land nickname — against rows built so each family's wrong arm would answer a
    /// different list. `not:reprint` is `is:reprint` negated, and the row with no `print_facts`
    /// fails it both ways.
    #[test]
    fn is_answers_every_family() {
        let conn = corpus_for_the_full_syntax();
        let is = |v: &str| one(&conn, pred(PredicateField::Is, PredicateOp::Colon, v));
        // Layouts and faces.
        assert_eq!(is("split"), vec!["fireice"]);
        assert_eq!(is("transform"), vec!["delver"]);
        assert_eq!(is("dfc"), vec!["delver"]);
        // Card kinds.
        assert_eq!(is("vanilla"), vec!["bears"]);
        assert_eq!(is("frenchvanilla"), vec!["serra"]);
        assert_eq!(is("bear"), vec!["bears"]);
        assert_eq!(is("hybrid"), vec!["finks"]);
        assert_eq!(is("commander"), vec!["niv"]);
        assert_eq!(is("brawler"), sorted(&["niv", "ugin"]));
        assert_eq!(is("historic"), sorted(&["niv", "ugin", "old"]));
        assert_eq!(is("funny"), vec!["unhinged"]);
        assert_eq!(
            is("permanent"),
            all_but(&["bolt", "bolt-m10", "bolt-2xm", "fireice"])
        );
        assert_eq!(is("spell"), all_but(&["tundra", "strand"]));
        // Printing facts.
        assert_eq!(is("foil"), sorted(&["bolt-m10", "bolt-2xm"]));
        assert_eq!(is("reserved"), vec!["tundra"]);
        assert_eq!(is("reprint"), sorted(&["bolt-m10", "bolt-2xm"]));
        assert_eq!(
            one(
                &conn,
                negated(PredicateField::Is, PredicateOp::Colon, "reprint")
            ),
            all_but(&["bolt-m10", "bolt-2xm", "old"]),
            "`not:reprint`, and the row that predates schema 8 answers neither"
        );
        assert_eq!(is("extendedart"), vec!["bolt-2xm"]);
        assert_eq!(is("borderless"), vec!["bolt-2xm"]);
        // A promo type.
        assert_eq!(is("boosterfun"), vec!["bolt-2xm"]);
        // Land nicknames: two templates, each finding its own land and not the other.
        assert_eq!(is("dual"), vec!["tundra"]);
        assert_eq!(is("fetchland"), vec!["strand"]);
        // Case is the reader's; a word outside the vocabulary matches nothing.
        assert_eq!(is("SPLIT"), vec!["fireice"]);
        assert_eq!(
            one_clause(pred(PredicateField::Is, PredicateOp::Colon, "shiny")),
            NO_MATCH
        );
    }

    /// **Every word in [`IS_VALUES`] has its own SQL**, and every one of them prepares and runs
    /// against a real corpus. A word added to the list without an arm falls to `is_clause`'s
    /// last arm, which is [`NO_MATCH`], and this is what goes red for it. The list itself is
    /// pinned in order, because a TypeScript test reads it out of this file.
    #[test]
    fn every_is_value_has_its_own_sql() {
        let conn = corpus_for_the_full_syntax();
        assert_eq!(IS_VALUES.len(), 116);
        let mut seen: Vec<&str> = Vec::new();
        for value in IS_VALUES {
            assert!(!seen.contains(value), "{value} is listed twice");
            seen.push(value);
            let sql = one_clause(pred(PredicateField::Is, PredicateOp::Colon, value));
            assert_ne!(sql, NO_MATCH, "is:{value} has no arm");
            one(&conn, pred(PredicateField::Is, PredicateOp::Colon, value));
            one(
                &conn,
                negated(PredicateField::Is, PredicateOp::Colon, value),
            );
        }
        assert_eq!(&IS_VALUES[..3], &["split", "flip", "transform"]);
        assert_eq!(IS_VALUES[IS_VALUES.len() - 1], "pathway");
    }

    /// **Every field prepares under every operator** — top level, negated, and nested in a
    /// group beside another term — against a corpus with every column the arms read. A syntax
    /// error is a *prepare* failure rather than a wrong answer, so only running the statement
    /// can catch one; the census above only proves that *something* was emitted.
    #[test]
    fn every_field_prepares_under_every_operator() {
        let conn = corpus_for_the_full_syntax();
        let ops = [
            PredicateOp::Colon,
            PredicateOp::Eq,
            PredicateOp::Ne,
            PredicateOp::Gt,
            PredicateOp::Gte,
            PredicateOp::Lt,
            PredicateOp::Lte,
        ];
        for field in EVERY_FIELD {
            for op in ops {
                let term = sample(field, op);
                full_ids(&conn, vec![term.clone()]);
                full_ids(
                    &conn,
                    vec![QueryPredicate {
                        negated: true,
                        ..term.clone()
                    }],
                );
                full_ids(
                    &conn,
                    vec![group(
                        PredicateField::AnyOf,
                        vec![
                            term.clone(),
                            pred(PredicateField::Cmc, PredicateOp::Eq, "1"),
                        ],
                    )],
                );
                full_ids(
                    &conn,
                    vec![QueryPredicate {
                        negated: true,
                        ..group(PredicateField::AllOf, vec![term, sample(field, op)])
                    }],
                );
            }
        }
        // And the cross-column, the parity and the off-vocabulary values on top of the samples.
        for (field, value) in [
            (PredicateField::Power, "@toughness"),
            (PredicateField::Cmc, "@power"),
            (PredicateField::Loyalty, "@cmc"),
            (PredicateField::PowTou, "@loyalty"),
            (PredicateField::Cmc, "even"),
            (PredicateField::Colors, "m"),
            (PredicateField::ColorIdentity, "2"),
            (PredicateField::CollectorNumber, "12a"),
            (PredicateField::Date, "neo"),
            (PredicateField::Frame, "showcase"),
        ] {
            for op in ops {
                full_ids(&conn, vec![pred(field, op, value)]);
            }
        }
    }

    /// Colour names, `m` and counts: `c=izzet` is exactly blue-red, `c:green` is G alone (never
    /// G and R), `c:m` is two colours or more, and a bare number is how many.
    #[test]
    fn colour_names_multicolour_and_counts() {
        let conn = corpus_for_the_full_syntax();
        let c = |op: PredicateOp, v: &str| one(&conn, pred(PredicateField::Colors, op, v));
        assert_eq!(c(PredicateOp::Eq, "izzet"), vec!["fireice"]);
        assert_eq!(c(PredicateOp::Eq, "Selesnya"), vec!["finks"]);
        assert_eq!(
            c(PredicateOp::Colon, "green"),
            sorted(&["bears", "finks", "niv"])
        );
        assert_eq!(c(PredicateOp::Colon, "fivecolor"), vec!["niv"]);
        assert_eq!(
            c(PredicateOp::Colon, "grixis"),
            vec!["niv"],
            "UBR, not G and R"
        );
        assert_eq!(
            c(PredicateOp::Colon, "m"),
            sorted(&["fireice", "finks", "niv"])
        );
        assert_eq!(c(PredicateOp::Eq, "2"), sorted(&["fireice", "finks"]));
        assert_eq!(c(PredicateOp::Gte, "3"), vec!["niv"]);
        assert_eq!(
            c(PredicateOp::Eq, "0"),
            sorted(&["tundra", "strand", "ugin", "old"])
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::ColorIdentity, PredicateOp::Eq, "azorius")
            ),
            vec!["tundra"]
        );
        assert_eq!(
            one(
                &conn,
                negated(PredicateField::Colors, PredicateOp::Colon, "multicolor")
            ),
            all_but(&["fireice", "finks", "niv"])
        );
    }

    /// `pow>tou`, `pt>=8`, `loy>=7`, `cmc:odd`/`cmc:even` — the numbers that are not one column
    /// compared with one value.
    #[test]
    fn numbers_compare_with_each_other_and_with_parity() {
        let conn = corpus_for_the_full_syntax();
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Power, PredicateOp::Gt, "@toughness")
            ),
            vec!["finks"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Toughness, PredicateOp::Gt, "@power")
            ),
            vec!["unhinged"],
            "∞ casts to zero, as `*` does"
        );
        assert_eq!(
            one(&conn, pred(PredicateField::PowTou, PredicateOp::Gte, "8")),
            sorted(&["niv", "serra"])
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Loyalty, PredicateOp::Gte, "7")),
            vec!["ugin"]
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Cmc, PredicateOp::Colon, "odd")),
            sorted(&[
                "bolt", "bolt-m10", "bolt-2xm", "delver", "finks", "goblin", "niv", "old", "serra",
                "unhinged"
            ])
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Cmc, PredicateOp::Colon, "even")),
            sorted(&["bears", "fireice", "strand", "tundra", "ugin"])
        );
        assert_eq!(
            one_clause(pred(PredicateField::Cmc, PredicateOp::Gt, "odd")),
            NO_MATCH,
            "a parity has no order"
        );
        assert_eq!(
            one_clause(pred(PredicateField::Usd, PredicateOp::Gt, "@power")),
            NO_MATCH,
            "a price is not compared with a stat"
        );
    }

    /// `m:`, `devotion:` and `produces:` — a multiset, a count and a letter set over three
    /// columns the old fields never read.
    #[test]
    fn mana_cost_devotion_and_produces() {
        let conn = corpus_for_the_full_syntax();
        let m = |op: PredicateOp, v: &str| one(&conn, pred(PredicateField::ManaCost, op, v));
        assert_eq!(
            m(PredicateOp::Colon, "{R}"),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "goblin", "fireice", "niv", "unhinged"])
        );
        assert_eq!(
            m(PredicateOp::Eq, "r"),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "goblin"])
        );
        assert_eq!(m(PredicateOp::Colon, "rr"), vec!["unhinged"]);
        assert_eq!(
            m(PredicateOp::Lte, "{1}{R}"),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "goblin", "fireice"])
        );
        assert_eq!(
            m(PredicateOp::Gt, "{R}"),
            sorted(&["fireice", "niv", "unhinged"])
        );
        assert_eq!(m(PredicateOp::Eq, "{1}{g/w}{G/W}"), vec!["finks"]);
        assert_eq!(
            m(PredicateOp::Colon, "10"),
            Vec::<String>::new(),
            "one {{10}}, not {{1}}{{0}}"
        );

        let devotion = |v: &str| one(&conn, pred(PredicateField::Devotion, PredicateOp::Colon, v));
        assert_eq!(devotion("{G}{G}"), vec!["finks"]);
        assert_eq!(devotion("{g/w}{g/w}"), sorted(&["finks", "serra", "niv"]));

        let produces = |op: PredicateOp, v: &str| one(&conn, pred(PredicateField::Produces, op, v));
        assert_eq!(produces(PredicateOp::Colon, "w"), vec!["tundra"]);
        assert_eq!(produces(PredicateOp::Eq, "wu"), vec!["tundra"]);
        assert!(produces(PredicateOp::Eq, "w").is_empty());
        assert!(produces(PredicateOp::Colon, "c").is_empty());
    }

    /// The print facts, and **the three states they read in**: a value, `''` for a printing
    /// with none (so `-wm:boros` keeps it), and NULL for a row with no `print_facts` at all —
    /// which fails the term *and* its negation, the orphan rule.
    #[test]
    fn print_facts_answer_and_a_row_before_schema_8_answers_neither_way() {
        let conn = corpus_for_the_full_syntax();
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Flavor, PredicateOp::Colon, "SPARKMAGE")
            ),
            vec!["bolt-m10"]
        );
        assert_eq!(
            one(
                &conn,
                negated(PredicateField::Flavor, PredicateOp::Colon, "sparkmage")
            ),
            all_but(&["bolt-m10", "old"])
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Watermark, PredicateOp::Eq, "Boros")
            ),
            vec!["goblin"]
        );
        assert_eq!(
            one(
                &conn,
                negated(PredicateField::Watermark, PredicateOp::Eq, "boros")
            ),
            all_but(&["goblin", "old"])
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Has, PredicateOp::Colon, "watermark")
            ),
            vec!["goblin"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Has, PredicateOp::Colon, "flavor")
            ),
            vec!["bolt-m10"]
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Frame, PredicateOp::Eq, "1993")),
            sorted(&["bolt", "tundra"])
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Frame, PredicateOp::Eq, "ExtendedArt")
            ),
            vec!["bolt-2xm"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Border, PredicateOp::Eq, "borderless")
            ),
            vec!["bolt-2xm"]
        );
    }

    /// `banned:` and `restricted:` read the legalities JSON (the mask cannot tell banned from
    /// not legal); an unknown format is [`NO_MATCH`], exactly as `f:` answers one.
    #[test]
    fn banned_and_restricted_read_the_legalities() {
        let conn = corpus_for_the_full_syntax();
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Banned, PredicateOp::Colon, "Modern")
            ),
            vec!["old"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Restricted, PredicateOp::Colon, "vintage")
            ),
            vec!["old"]
        );
        assert!(one(
            &conn,
            pred(PredicateField::Banned, PredicateOp::Colon, "vintage")
        )
        .is_empty());
        assert_eq!(
            one_clause(pred(PredicateField::Banned, PredicateOp::Colon, "nonesuch")),
            NO_MATCH
        );
    }

    /// `prints:` and `sets:` count the card's other printings; `new:` asks whether this one is
    /// the first with its art, flavour, language, rarity — or at all.
    #[test]
    fn print_counts_and_firsts() {
        let conn = corpus_for_the_full_syntax();
        let bolts = ["bolt", "bolt-m10", "bolt-2xm"];
        assert_eq!(
            one(&conn, pred(PredicateField::Prints, PredicateOp::Eq, "3")),
            sorted(&bolts)
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Sets, PredicateOp::Gte, "2")),
            sorted(&bolts)
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::PaperPrints, PredicateOp::Eq, "1")
            ),
            all_but(&bolts)
        );
        let new = |v: &str| {
            one(
                &conn,
                pred(PredicateField::NewFeature, PredicateOp::Colon, v),
            )
        };
        assert_eq!(new("art"), sorted(&["bolt", "bolt-2xm", "niv"]));
        assert_eq!(new("card"), all_but(&["bolt-m10", "bolt-2xm"]));
        assert_eq!(new("language"), all_but(&["bolt-m10"]));
        assert_eq!(new("rarity"), all_but(&["bolt-m10"]));
        assert_eq!(new("flavor"), vec!["bolt-m10"]);
        assert_eq!(
            one_clause(pred(PredicateField::NewFeature, PredicateOp::Colon, "hat")),
            NO_MATCH
        );
    }

    /// `date:` against a date compares the same-length prefix (so `date>2009` excludes the whole
    /// of 2009), and against anything else compares a set's release; `year:` is the first four
    /// characters.
    #[test]
    fn date_reads_a_date_or_a_set_code() {
        let conn = corpus_for_the_full_syntax();
        let date = |op: PredicateOp, v: &str| one(&conn, pred(PredicateField::Date, op, v));
        assert_eq!(date(PredicateOp::Gte, "2020"), vec!["bolt-2xm"]);
        assert_eq!(
            date(PredicateOp::Eq, "2009"),
            sorted(&["bolt-m10", "goblin"])
        );
        assert_eq!(date(PredicateOp::Eq, "2009-10"), vec!["goblin"]);
        assert_eq!(
            date(PredicateOp::Gt, "2009"),
            sorted(&["bolt-2xm", "delver", "niv", "ugin"])
        );
        assert_eq!(
            date(PredicateOp::Lt, "ZEN"),
            sorted(&[
                "bears", "bolt", "bolt-m10", "fireice", "finks", "old", "serra", "strand",
                "tundra", "unhinged"
            ])
        );
        assert!(
            date(PredicateOp::Lt, "nosuchset").is_empty(),
            "an unknown set fails every row"
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Year, PredicateOp::Eq, "2009")),
            sorted(&["bolt-m10", "goblin"])
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Year, PredicateOp::Lt, "1995")),
            sorted(&["bears", "bolt", "serra", "tundra"])
        );
    }

    /// `b:` by a block's code, its name, or any set in it — `wwk` holds no card here and still
    /// finds Zendikar's — and `st:` by the set's type.
    #[test]
    fn block_and_set_type_read_the_sets_table() {
        let conn = corpus_for_the_full_syntax();
        let block = |v: &str| one(&conn, pred(PredicateField::Block, PredicateOp::Colon, v));
        assert_eq!(block("zen"), vec!["goblin"]);
        assert_eq!(block("WWK"), vec!["goblin"], "any set in the block");
        assert_eq!(block("Zendikar"), vec!["goblin"]);
        assert_eq!(block("innistrad"), vec!["delver"]);
        assert!(block("lea").is_empty(), "a set with no block is in none");
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::SetType, PredicateOp::Colon, "masters")
            ),
            vec!["bolt-2xm"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::SetType, PredicateOp::Colon, "core")
            ),
            sorted(&["bears", "bolt", "bolt-m10", "serra", "tundra"])
        );
    }

    /// `in:`, `game:`, `lang:`, `cn:` and the prices — the printing-level facts.
    #[test]
    fn printings_games_languages_numbers_and_prices() {
        let conn = corpus_for_the_full_syntax();
        let bolts = sorted(&["bolt", "bolt-m10", "bolt-2xm"]);
        let inp = |v: &str| {
            one(
                &conn,
                pred(PredicateField::InPrinting, PredicateOp::Colon, v),
            )
        };
        assert_eq!(
            inp("2xm"),
            bolts,
            "a set: every printing of a card printed there"
        );
        assert_eq!(inp("japanese"), bolts, "a language, by name");
        assert_eq!(inp("arena"), bolts, "a game");
        assert_eq!(
            inp("uncommon"),
            sorted(&["bolt", "bolt-m10", "bolt-2xm", "fireice", "finks", "serra"])
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Game, PredicateOp::Colon, "arena")
            ),
            vec!["bolt-2xm"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::Language, PredicateOp::Colon, "Japanese")
            ),
            vec!["bolt-2xm"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::CollectorNumber, PredicateOp::Colon, "161")
            ),
            vec!["bolt"]
        );
        assert_eq!(
            one(
                &conn,
                pred(PredicateField::CollectorNumber, PredicateOp::Gte, "200")
            ),
            vec!["tundra"]
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Usd, PredicateOp::Lt, "2")),
            vec!["bolt"]
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Usd, PredicateOp::Gte, "2")),
            sorted(&["bolt-m10", "goblin"])
        );
        assert_eq!(
            one(&conn, pred(PredicateField::Tix, PredicateOp::Gt, "0")),
            vec!["bolt"]
        );
    }

    /// The subquery aliases are a closed list a caller must not collide with — the tag arms'
    /// `debug_assert`, extended to every inner alias this module uses.
    #[test]
    #[should_panic(expected = "uncorrelates")]
    #[cfg(debug_assertions)]
    fn a_caller_alias_equal_to_an_inner_alias_is_refused() {
        let mut p = Predicates::default();
        push_card_filters(&mut p, &CardFilters::default(), "pr", None);
    }
}
