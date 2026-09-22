# Scryfall query syntax in every card search

**Status**: design, approved 2026-09-22. Issue
[#485](https://github.com/Msgaihede/mtg-grimoire/issues/485).

`t:goblin`, `o:"draw a card"`, `c>=rg`, `cmc>=3`, `-kw:flying` — typed into any card search box
in the app and meaning what they mean on Scryfall.

Every Scryfall behaviour quoted here was measured live against `api.scryfall.com/cards/search`
on **2026-09-22**, and every corpus figure against the real 117,738-card `corpus.db` through
`node:sqlite` (SQLite's own C, not a cargo profile). Nothing here is a guess about what Scryfall
does or about what this database costs.

## 1. What this changes, and the one thing it breaks

Today the search box speaks exactly one language: the tagger syntax added by `81251d3b`
(2026-08-22), which is `art:`/`atag:`/`arttag:`/**`a:`** for the art taxonomy and
`otag:`/`oracletag:`/`function:`/**`o:`** for the oracle one. Everything else a reader types is
free text for FTS.

That commit took `a:` and `o:` deliberately and said so: *"they are `artist:` and `oracle:` on
Scryfall, so those two spellings are now spent here."* **This design spends them back.** After
this change:

| spelling | meant | now means |
| --- | --- | --- |
| `o:` | oracle **tag** | oracle **text** — Scryfall's `oracle:` |
| `a:` | art **tag** | **artist** — Scryfall's `artist:` |

Both taxonomies keep every unambiguous spelling they already had — `otag:`, `oracletag:`,
`function:`, `oracle_tag:`, `oracle-tag:`, `atag:`, `arttag:`, `art_tag:`, `art-tag:` and
`art:`. **`art:` stays a tag keyword because it is one on Scryfall**: measured, `art:` `atag:`
`arttag:` `art_tag:` all answer 1,145 for `dragon`. Only the two single letters move.

**This is a silent behaviour change and there is no migration to write.** Nothing in this app
persists a query string — not the deck view state, not the store — so no stored data needs
converting. What changes is that a reader who types `o:ramp` out of muscle memory gets cards
whose rules text contains "ramp" instead of cards tagged `ramp`. It fails by returning the wrong
thing rather than by erroring, which is the same cost the original departure accepted, now paid
in the other direction. `docs/reference/tag-search-syntax.md` is rewritten to match, and the
standing warning at `tagQuery.ts`'s module head is deleted because it has been discharged.

## 2. The keyword table

`:` is each keyword's default operator and the defaults are **not** the same, which is the trap
worth stating first. Measured: `c:rg` = `c>=rg` = **676** cards, while `id:rg` = `id<=rg` =
**13,399**. Scryfall's `c:` asks "has at least these colours" and its `id:` asks "fits in this
identity". A single rule for `:` would get one of them wrong.

| keywords | field | default op | ops | matching |
| --- | --- | --- | --- | --- |
| `t` `type` | type line | `:` | `: =` | FTS prefix, `type_line` column |
| `o` `oracle` | oracle text | `:` | `: =` | FTS prefix, `search_text` column |
| `kw` `keyword` | keywords | `:` | `: =` | exact, delimited (§6) |
| `a` `artist` | artist | `:` | `: =` | `instr` on an unindexed column (§5.3) |
| `c` `color` `colour` | colors | `>=` | `: = != > >= < <=` | letter set |
| `id` `identity` `ci` | color identity | `<=` | `: = != > >= < <=` | letter set |
| `cmc` `mv` `manavalue` | cmc | `=` | `: = != > >= < <=` | numeric |
| `pow` `power` | power | `=` | `: = != > >= < <=` | numeric, cast (§6.1) |
| `tou` `tough` `toughness` | toughness | `=` | `: = != > >= < <=` | numeric, cast (§6.1) |
| `r` `rarity` | rarity | `=` | `: = != > >= < <=` | ordered enum |
| `s` `set` `e` `edition` | set code | `=` | `: =` | exact |
| `f` `format` `legal` | format | `=` | `: =` | legality mask |
| `otag` `oracletag` `function` | oracle tag | `:` | `:` | unchanged, `tag_resolve` |
| `atag` `arttag` `art` | art tag | `:` | `:` | unchanged, `tag_resolve` |

A leading `-` negates any term. Terms **AND** together, as they do today and as they do on
Scryfall (`t:goblin t:creature` = 557, measured). There is still **no `or` and no parentheses**
— that refusal is unchanged and its reason is unchanged: the backend composes predicates by
conjunction, and boolean grouping would need new SQL in `filters.rs` *and* a matching change in
`index/facets.rs`.

Keyword identity is `keywordKey`'s existing rule — case folded, separators dropped — so
`MANAVALUE:`, `mana_value:` and `mana-value:` are one keyword, exactly as `oracle_tag:` already
is.

### 2.1 Rarity is ordered

`r>=rare` answers **13,951** and `r:rare` answers **11,856** — so `r` is an enum with an order
(`common < uncommon < rare < mythic`) and `:` on it is equality, not "at least". The app's
existing `rarities` filter is a set of chips ORed together; `r:rare` maps onto it directly and
`r>=rare` expands to the set of rarities at or above the named one before it does.

## 3. Grammar

`src/features/search/tagQuery.ts` becomes `src/features/search/queryLanguage.ts` — the same
module, widened. The scanner is unchanged in shape: whitespace-separated chunks, a quote
swallows spaces, an unterminated quote runs to the end of the string.

What changes is the term pattern. Today it is `-?keyword:value`; it becomes
`-?keyword(op)value` where `op` is one of `: = != >= <= > <`, **longest match first** so that
`>=` is never read as `>` followed by a value beginning `=`.

Three token kinds come out, where today there are two:

- **`tag`** — the two taxonomies. Unchanged, still resolved through `tag_resolve`, still gated
  closed while a resolve is pending (§7).
- **`predicate`** — everything else in the table.
- **`text`** — unrecognised, joined with single spaces and sent as FTS free text.

**A keyword with nothing after it stays `"partial"`** — neither a term nor free text. That
three-way answer already exists and its reason widens rather than changes: every keystroke on
the way to `cmc>=3` passes through `cmc`, `cmc>`, `cmc>=`, and none of those three should narrow
anything. A term whose operator is present but whose value is empty is `"partial"` too.

**An unparseable value is `"text"`, not an error.** `cmc>=banana` is not a number, so the term is
handed to FTS as the words a reader typed rather than refused — the same rule that makes
`itag:dragon` free text today. This keeps the box's one failure mode (§7) about tags, where it
already is.

## 4. The wire

`CardFilters` — the struct all three list queries already flatten — gains **one** field:

```rust
pub predicates: Option<Vec<QueryPredicate>>,
```

where `QueryPredicate { field: PredicateField, op: PredicateOp, value: String, negated: bool }`
and `PredicateField`/`PredicateOp` are closed enums.

**One list, not ten scalar fields.** Ten fields would have to be added to `CardFilters`, mirrored
in `SearchRequest`, `CollectionQuery` and `WishlistQuery`'s TS shapes, and none of them could
express the three things a list gets for free: negation, repetition (`t:creature t:goblin` is two
terms and both must hold) and an operator per term. A closed enum keeps it type-checked across
the boundary rather than making it a stringly-typed mini-language.

This is a cross-boundary contract, so it goes in `src/lib/ipc.ts`'s mirror **and** in the
`ipc.test.ts` fence — the opt-in drift check that is the only thing catching Rust↔TS skew here.

## 5. Where the SQL goes

### 5.1 The structural find

All three card searches already call one function, with the same alias:

| caller | line | call |
| --- | --- | --- |
| `search_cards` | `search.rs:809` | `push_card_filters(&mut p, …, "c", None)` |
| `collection_list` | `collection.rs:1956` | `… , "c", Some("e")` |
| `wishlist_list` | `wishlist.rs:1232` | `… , "c", Some("w")` |

**The wishlist joins `cards` too.** Only its *free text* is the outlier — a `LIKE` over the
denormalised `wishlist_entries.name`, deliberately, so a wish whose printing has left the corpus
still answers a name search. Every structured filter there already reads `c.…`.

So a predicate emitted inside `push_card_filters` reaches all three searches in one edit. That is
the whole of "across all of our card searches", and it needs no new plumbing in two of them.

**An orphan row fails a predicate, and that is the existing documented rule**, not a new one:
`push_card_filters`' own doc says format, colours, rarity and mana value "are claims only a card
row can answer… an orphan simply fails them." `t:`, `o:`, `kw:`, `pow:` and the rest are card-row
claims of exactly that kind, so they inherit the rule rather than arguing with it.

### 5.2 `t:` and `o:` ride FTS, and the reason is measured

`type_line` is **already an FTS column** — `cards_fts(name, type_line, search_text)` — so `t:` is
a column-filtered MATCH with no schema change at all. Oracle text is reachable through
`search_text`.

Measured on the real corpus:

| query | rows | time |
| --- | --- | --- |
| `cards_fts MATCH 'type_line : goblin*'` | 1,825 | **8.0 ms** |
| `cards.type_line LIKE '%goblin%'` | 1,825 | **16,656 ms** (cold) |
| `cards.type_line LIKE '%reature%'` | 56,007 | **653 ms** (warm) |
| `cards_fts MATCH 'search_text : draw*'` | 15,359 | **6.7 ms** |
| `cards.oracle_text LIKE '%draw%'` | 14,753 | **1,858 ms** (warm) |

**80× to 250×.** LIKE is not an option for a box that fires on a debounce. So `t:` and `o:` are
folded into the FTS MATCH string that `filters::fts_query` already builds, as FTS5 column
filters, and they are shared by `search_cards` and `collection_list` for free because both call
`fts_query`.

**What this costs is mid-word fragments.** Scryfall's `t:` and `o:` are true substring matches —
`o:raw` answers 3,802 there, matching "draw", and `t:reature` answers 18,909. FTS prefix cannot
reach either. **For type lines the gap is empty in practice**: type lines are built of whole
words, and the two engines agreed exactly on both probes above (1,825 = 1,825, 56,007 = 56,007).
For oracle text a reader who types a mid-word fragment gets fewer cards than Scryfall would give
them. That is the accepted cost, and it is written here rather than discovered later.

**`search_text` is wider than oracle text, by about 4%.** It holds top-level `oracle_text` plus
every face's `name`, `type_line` and `oracle_text` (`card_row.rs:251-265`), so `o:goblin` also
matches a card whose back face is *named* Goblin — measured, 15,359 against 14,753 for the
oracle-text column alone. Two things make this the right column anyway: `cards.oracle_text` is
**NULL for every double-faced card**, so the narrower column is wrong in a worse direction, and
the extra matches are face text a reader searching rules text would mostly want. A clean
`oracle_all` FTS column is a possible later rung and is deliberately not this change.

**Negation needs care.** FTS5's `NOT` is a binary operator, so a query that is *only* `-t:goblin`
cannot be expressed as a MATCH string — there is no left operand. A purely negative FTS term
compiles to `c.rowid NOT IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)` instead. Mixed
queries put the positive terms in the MATCH and the negative ones in the subquery; this is
uniform and simpler than deciding per query, so it is what the implementation does.

### 5.3 `artist:` is an `instr`, and that is defensible

There is no artist FTS column and `cards.artist` carries no b-tree index (`CARDS_INDEXES` covers
`oracle_id`, `(set_code, collector_number)`, `name`, the collapse covering index and
`illustration_id`). `a:` therefore emits `instr(lower(c.artist), lower(?)) > 0`.

This is the one predicate that scans, and it is acceptable where `t:`/`o:` were not, because **it
never runs alone against the whole corpus in the ordinary case**: it is ANDed into a statement
that the FTS join, the format mask or the collapse index has usually already narrowed. A bare
`a:` on an otherwise empty box is the worst case and is to be **measured during implementation**
against the real corpus; if it lands above ~250 ms, the fallback is an index on `cards.artist` in
the same rung as §6's, which is cheap and additive. Recording the number is part of the work, not
optional.

### 5.4 Everything else is a plain predicate

`c:`, `id:`, `cmc:`, `pow:`, `tou:`, `r:`, `s:`, `f:` all become ordinary SQL in
`push_card_filters` over columns that already exist: `colors`, `color_identity`, `cmc`, `power`,
`toughness`, `rarity`, `set_code`, `legal_mask`.

**`c:` is new and `id:` is not.** The app's existing `colors` filter is *colour identity with
subset semantics* — which is precisely Scryfall's `id:`, so `id:` maps onto machinery that is
already there and already faceted. Card **colors** (`cards.colors`) has never been filtered on
and needs a new predicate. Getting this backwards would make `c:rg` answer 13,399 where Scryfall
answers 676.

## 6. Corpus schema 5: `cards.keywords`

`kw:` is the one keyword in §2's table with no column behind it, and it cannot be faked from
oracle text. Measured: `kw:flying` = 3,318 and `o:flying` = 4,617, while **`kw:flying -o:flying`
= 0**. So every keyword does appear in the card's rules text — but the text over-matches by 39%,
on reminder text and on phrases like "can't be blocked by creatures with flying". `kw:` is
genuinely narrower and is worth a column.

Scryfall ships it as an array of capitalised strings — verified live, Serra Angel is
`['Flying', 'Vigilance']` — and matching is **exact against a known vocabulary**, not substring:
`kw:fly` answers *"All of your terms were ignored"*. So the column stores the keywords lowercased
and delimited, and the predicate is a boundary-anchored `instr`, never a bare substring.

**The rung copies corpus schema 3 exactly** (`produced_mana`), which is the precedent for this
shape in every respect:

- `CORPUS_SCHEMA_VERSION` 4 → **5**, one `ALTER TABLE {schema}.cards ADD COLUMN keywords TEXT`.
- Gated on the **column's absence** via `PRAGMA table_info`, never on `sqlite_master`'s text —
  `cards` is dropped and recreated by `swap_staging` on every sync, so its stored `CREATE TABLE`
  is whatever `create_staging` rebuilt, and a text probe would re-issue the `ALTER` and die at
  `duplicate column name` on exactly the databases that are already correct.
- A `cards` that is not there **owes nothing**; `ALTER` on a missing table raises, and a launch
  must survive a repair it cannot carry out.
- Schema-qualified through `on_schema`, or the column lands on `user.db`.
- **No backfill is possible.** `raw` is a gzip BLOB from schema v3 on and `json_extract` over one
  is a hard error, not a NULL. Every existing row reads NULL until the next full ingest, which is
  at most a day away because Scryfall regenerates the bulk file daily.
- No `cards_fts` rebuild: the rung adds an unindexed column and renumbers no rowid.

**The gap needs a bridge, and the measurement above is what licenses it.** Between the rung and
the next full ingest, `keywords` is NULL for every row, so a bare `kw:flying` would answer zero
cards and read as "you own no fliers" — a narrowing failing in the one direction a search must
never fail in. Because `kw:flying -o:flying` is empty, the oracle text is a **superset** of the
keyword, so the predicate is:

```sql
(c.keywords IS NOT NULL AND <exact delimited match>)
OR (c.keywords IS NULL AND <oracle text contains the keyword>)
```

Precise once ingested, over-inclusive before, never empty. `fill_unknown_produced_mana` is the
same idea one column over.

⚠️ **Renumber before merging.** Another branch taking corpus schema 5 first makes this a collision
CI cannot see; the rung number and any fixture names are checked against `main` at merge time,
not at branch time.

### 6.1 `power` and `toughness` are TEXT

Both columns are `TEXT`, because a power can be `*`, `1+`, `X` or `∞`. Comparisons therefore need
a cast, and a rule for what a non-numeric value compares as. Scryfall's own behaviour is
measured: `pow>=0` answers 19,128 and `pow>=*` answers the same 19,128, while `pow:*` answers
1,059 — so `*` participates in comparisons rather than being excluded from them.

The implementation casts with `CAST(c.power AS REAL)`, which yields `0.0` for `*` and for any
other non-numeric, and matches the `pow>=0` observation. `pow:*` — a literal star as the value —
is matched as a **string equality** before any cast is attempted, which is the only way to ask
the question at all. This is one of the two places (with §5.3's timing) where the implementation
is expected to produce a measurement that lands in the reference doc.

## 7. Failure modes

The box's existing rule is that **tags fail closed** — a pending resolve makes no request at all,
and a name that resolves to nothing empties the wall — while everything in its neighbourhood
fails open. That rule is unchanged and it does not extend to predicates.

**Predicates cannot fail closed, because they cannot be unknown.** A tag name is a string that
may or may not exist in a taxonomy the backend holds; `t:goblin` is a string that either matches
rows or does not. There is no third "this name is not a thing" state to gate on, so a predicate
that matches nothing is simply a search with no results — which is the honest answer, and the
`No cards match these filters` empty state already says it.

**Facets fail open.** `index/facets.rs` is a second, in-memory implementation that has to answer
what `push_card_filters` answers, and the index carries no text, power, toughness, artist or
card-colour dimension. `t:` and `o:` ride the FTS-derived bitset `run_facets` already builds, so
they narrow the counts for free. The rest leave facet counts **wider than the result set** — a
chip may advertise more cards than pressing it returns. That is the documented behaviour in
`search-faceting.md` and the right direction: a count that is too high is a cosmetic wrong, a
chip that vanished is a filter the reader cannot reach. Growing the index is explicitly not part
of this change.

## 8. The surfaces

**Free, because they share `useCardSearch` → `search_cards`** — the search page, the deck
editor's *All cards* tab, the collection's docked column, the wishlist's docked column, and the
Tags page. Five surfaces, one hook, one parse.

**Needs the parse wiring added** — `useCollection`, `useCollectionSearch` and `useWishlist` each
debounce a raw string straight into their query today and never call the parser. Each gains the
same three lines. Their backends need nothing: §5.1.

**Needs wiring at the call site** — `QuickAdd.tsx` and `DeckCoverPicker.tsx` call
`ipc.searchCards` with raw text, so `t:creature` would otherwise go to FTS as two words.

**Explicitly out of scope** — `printingFilters.ts`, `deckFilter.ts`, `NoteCardsDialog.tsx` and the
shared-collection web viewer all filter an already-fetched array in the client. They are not
corpus searches, they have no backend to teach, and half-implementing the syntax in four
hand-rolled `.includes()` filters would create four dialects. They keep their plain substring
behaviour.

## 9. The F1 panel

`KeyMap` becomes two tabs — **Shortcuts** and **Search syntax** — rather than one longer list. The
panel is 384px wide and a reader opens it to find a chord; a fourteen-keyword reference with
examples appended below the chord sections would bury the thing it is for. The syntax rows are
also not chords, so the two-column `<dt>`/`<dd>` caps layout does not fit them.

**The syntax table is generated from the parser's own keyword table**, the way `SHORTCUTS` is the
single source for both the binding and the panel. A keyword the panel advertises that nothing
parses is the exact drift `shortcuts.ts` exists to prevent, and the fix is the same one: one
table, two readers. `TAG_KEYWORDS` — exported for a help text that was never built, and today
consumed by nothing but its own test — is absorbed into it.

Tab state is local to the panel and resets on close: a reader who opened F1 for a chord should
find chords.

## 10. Testing

- **Grammar** (vitest, `queryLanguage.test.ts`) — the operator table, longest-match `>=` over `>`,
  quoted values, negation, `"partial"` at every keystroke of `cmc>=3`, unparseable values falling
  to free text, and the `a:`/`o:` reassignment asserted head-on so the break is a decision the
  suite records rather than a surprise.
- **Predicate SQL** (`cargo test`, `filters.rs`) — one case per field and operator, plus the
  orphan case (a NULL alias fails the predicate) and the pure-negation FTS path.
- **The three-caller claim** — a test that the same `predicates` payload narrows `search_cards`,
  `collection_list` and `wishlist_list`. This is the design's central bet and nothing else checks
  it.
- **The rung** (`cargo test`, `schema.rs`) — the ALTER is owed once, is not owed twice, is not
  owed on a missing `cards`, and lands on the corpus rather than on `user.db`.
- **The `kw:` bridge** — the NULL-keywords arm answers from oracle text and the populated arm
  answers exactly.
- **The F1 panel** (vitest + a story) — every keyword the panel draws round-trips through the
  parser. That assertion is the whole point of one table.
- **Live pass** — `npm run tauri dev`, driven over CDP per `live-ui-verification.md`, against the
  real corpus: each keyword typed into at least one surface, the collection and wishlist boxes
  included, with counts recorded in `docs/reference/`.

## 11. Out of scope, and named so it is a decision

- **`or`, parentheses, and nested boolean grouping.** Unchanged refusal, §2.
- **A clean `oracle_all` FTS column.** §5.2 records the 4% over-match that would buy it.
- **`is:`, `ft:`, `game:`, `year:`, `border:`, `frame:` and the rest of Scryfall's long tail.**
  Each is a separate predicate with separate data questions; the fourteen in §2's table are the
  ones with columns behind them or one cheap rung.
- **Growing the in-memory facet index.** §7.
- **The four client-side array filters.** §8.
