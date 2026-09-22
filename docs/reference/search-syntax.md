# Scryfall query syntax in the card search boxes

`t:goblin`, `o:"draw a card"`, `c>=rg`, `cmc>=3`, `-kw:flying`, `otag:"spot removal"` — typed
into any box in this app that searches cards, and meaning what they mean on Scryfall.

Two measurement dates run through this document and neither is a guess.

- Every **Scryfall** behaviour quoted was taken live against `api.scryfall.com/cards/search` —
  the tag figures on **2026-08-20**, recorded in full in
  [the art-tags research](../superpowers/research/2026-08-20-scryfall-art-tags.md), and
  everything else on **2026-09-22** for
  [the query-syntax design](../superpowers/specs/2026-09-22-scryfall-query-syntax-design.md)
  (issue [#485](https://github.com/Msgaihede/mtg-grimoire/issues/485)).
- Every **corpus** figure was taken on 2026-09-22 against the real **117,738-card** `corpus.db`
  through **`node:sqlite`** — SQLite's own C, not a cargo profile, so a debug/release split does
  not apply to it. The one live-window pass at the bottom names its own build.

## The keywords

Fourteen of them. `:` is each keyword's **default operator**, and the defaults are not the same
— that is the trap worth stating before the table rather than after it.

| keywords | field | default op | ops | how it is matched |
| --- | --- | --- | --- | --- |
| `t` `type` | type line | `:` | `: =` | FTS prefix, `type_line` column |
| `o` `oracle` | oracle text | `:` | `: =` | FTS prefix, `search_text` column |
| `kw` `keyword` | keyword ability | `:` | `: =` | exact, delimited — corpus schema 5 |
| `a` `artist` | artist | `:` | `: =` | `instr` on an unindexed column |
| `c` `color` `colour` | card colours | `>=` | `: = != > >= < <=` | letter set |
| `id` `identity` `ci` | colour identity | `<=` | `: = != > >= < <=` | letter set |
| `cmc` `mv` `manavalue` | mana value | `=` | `: = != > >= < <=` | numeric |
| `pow` `power` | power | `=` | `: = != > >= < <=` | numeric, cast |
| `tou` `tough` `toughness` | toughness | `=` | `: = != > >= < <=` | numeric, cast |
| `r` `rarity` | rarity | `=` | `: = != > >= < <=` | ordered enum |
| `s` `set` `e` `edition` | set code | `=` | `: =` | exact |
| `f` `format` `legal` | format legality | `=` | `: =` | legality mask |
| `otag` `oracletag` `function` | oracle **tag** | `:` | `:` | `tag_resolve`, unchanged |
| `atag` `arttag` `art` | art **tag** | `:` | `:` | `tag_resolve`, unchanged |

A leading `-` negates any term, and terms **AND** together — this app's rule and Scryfall's
alike (`t:goblin t:creature` = **557** there, measured). There is still **no `or` and no
parentheses**; the refusal and its reason are both unchanged and are two sections down.

The keyword is matched with separators dropped and case folded (`queryLanguage.ts`'s
`keywordKey`), which is why each tag row lists three keys where five spellings work:
`art_tag:` and `art-tag:` both fold onto `arttag:`, `oracle_tag:` and `oracle-tag:` onto
`oracletag:`, and `MANAVALUE:`, `mana_value:` and `mana-value:` are one keyword with `manavalue:`
for free.

**Twelve of the fourteen are predicates and two are tags**, and the split is not cosmetic: a
predicate is a claim about a column, a tag is a name that has to be resolved against a taxonomy
first, and only the second kind can be *unknown*. Everything below about failure turns on that.

### The default operator is not one rule

Measured on Scryfall, 2026-09-22: `c:rg` = `c>=rg` = **676** cards, while `id:rg` = `id<=rg` =
**13,399**. Scryfall's `c:` asks *has at least these colours* and its `id:` asks *fits inside
this identity*. One rule for `:` would get one of the two wrong by a factor of twenty.

The same split is why `cmc:3` is equality and `t:goblin` is not: the parser resolves `:` to the
keyword's own default from the table above, and only `t`, `o`, `kw`, `a` and the two tag
keywords keep `:` meaning "contains".

### Rarity is ordered

`r>=rare` answers **13,951** and `r:rare` answers **11,856** — so rarity is an enum with an
order, `common < uncommon < rare < mythic`, and `:` on it is equality rather than "at least".
The app's own `rarities` filter is a set of chips ORed together; `r:rare` maps onto it directly,
and `r>=rare` expands to the set of rarities at or above the named one before it does.

## `a:` and `o:` changed meaning on 2026-09-22

They were the two taxonomies until then. **They are Scryfall's now** — `a:` is the artist and
`o:` is the card's rules text.

| spelling | meant, 2026-08-22 → 2026-09-22 | means now |
| --- | --- | --- |
| `o:` | oracle **tag** | oracle **text** |
| `a:` | art **tag** | **artist** |

This reverses [`81251d3b`](https://github.com/Msgaihede/mtg-grimoire/commit/81251d3b)
(2026-08-22), which took the two single letters deliberately and wrote the consequence down:
*"they are `artist:` and `oracle:` on Scryfall, so those two spellings are now spent here."* The
grounds then were that `atag:`/`otag:` are the spellings nobody mistypes and also the ones nobody
reaches for twice a minute. The grounds for spending them back are that the box now speaks
Scryfall's whole language, and a reader carrying Scryfall muscle memory is no longer an edge
case in it. The standing warning at the grammar module's head is deleted rather than reworded,
because it has been discharged.

Both taxonomies keep every unambiguous spelling they had — `otag:`, `oracletag:`, `oracle_tag:`,
`oracle-tag:`, `function:`, `atag:`, `arttag:`, `art_tag:`, `art-tag:` and `art:`. **`art:`
stays a tag keyword because it is one on Scryfall**: measured 2026-08-20, `art:` `atag:`
`arttag:` `art_tag:` all answer **1,145** for `dragon`, and the oracle spellings all answer
**6,428** for `removal`. Only the two single letters moved.

**There is no migration, and the break is silent.** Nothing in this app persists a query string
— not the deck view state, not the store — so no stored data needed converting. What a reader
loses is `o:ramp` meaning the tag: it now returns cards whose rules text contains "ramp". It
fails by answering the wrong thing rather than by erroring, which is the same cost the original
departure accepted, now paid in the other direction.

## The grammar, and what is deliberately not in it

- `keyword<op>value`, where `<op>` is one of `:` `=` `!=` `>=` `<=` `>` `<`, **longest match
  first** so `>=` is never read as `>` followed by a value beginning `=`.
- `"…"` or `'…'` around a value with a space in it. An unterminated quote runs to the end.
- A leading `-` excludes: `-t:goblin`, `-atag:dragon`.
- Everything unrecognised is free text for FTS. `bolt t:creature` searches the index for `bolt`
  alone and filters by the type line beside it.

**No `or`, no parentheses.** The backend cannot express them: predicates are composed by
conjunction and every included tag becomes its own `EXISTS`, so boolean grouping would need new
SQL in `filters.rs` *and* a matching change in `index/facets.rs` — more work than the rest of
this feature combined. A reader who types `or` gets it as a word to search for.

**A keyword with nothing after it is neither a term nor free text.** Every keystroke on the way
to `cmc>=3` passes through `cmc`, `cmc>` and `cmc>=`, and none of those three should narrow
anything: as a term the first would sit there reporting an empty value through the whole of the
next word, as free text it would search the corpus for `cmc`. The scanner answers `"partial"`
and the query is whatever the rest of the box says. A term whose operator is present but whose
value is empty is `"partial"` too.

**An unparseable value is free text, not an error.** `cmc>=banana` is not a number, so the term
goes to FTS as the words the reader typed — the same rule that has always made `itag:dragon`
free text. This keeps the box's one failure mode about tags, where it already was.

So the scanner's per-chunk answer went from three to **four** — `"text"`, `"partial"`, a tag
token or a predicate token — and the token kinds that reach the backend from two to **three**.

## Where each term is answered

### One function, three searches

All three card searches already called one function, with the same alias, before any of this:

| caller | call |
| --- | --- |
| `search_cards` | `push_card_filters(&mut p, …, "c", None)` |
| `collection_list` | `… , "c", Some("e")` |
| `wishlist_list` | `… , "c", Some("w")` |

**The wishlist joins `cards` too**; only its *free text* is the outlier — a `LIKE` over the
denormalised `wishlist_entries.name`, deliberately, so a wish whose printing has left the corpus
still answers a name search. Every structured filter there already reads `c.…`. So a predicate
emitted inside `push_card_filters` reaches all three searches in one edit, and two of them need
no new plumbing at all. That is the whole of "across every card search", and it is the design's
central bet — which is why one test sends the same payload at all three.

**An orphan row fails a predicate, and that is the existing documented rule** rather than a new
one: `push_card_filters`' own doc already said format, colours, rarity and mana value "are
claims only a card row can answer… an orphan simply fails them." `t:`, `o:`, `kw:`, `pow:` and
the rest are card-row claims of exactly that kind, so they inherit the rule instead of arguing
with it.

### `t:` and `o:` ride FTS, and the reason is measured

`type_line` is **already an FTS column** — `cards_fts(name, type_line, search_text)` — so `t:` is
a column-filtered MATCH with no schema change at all, and oracle text is reachable through
`search_text`. The alternative was `LIKE`. Measured through `node:sqlite` against the
117,738-card corpus, 2026-09-22:

| query | rows | time |
| --- | --- | --- |
| `cards_fts MATCH 'type_line : goblin*'` | 1,825 | **8.0 ms** |
| `cards.type_line LIKE '%goblin%'` | 1,825 | **16,656 ms** (cold) |
| `cards.type_line LIKE '%reature%'` | 56,007 | **653 ms** (warm) |
| `cards_fts MATCH 'search_text : draw*'` | 15,359 | **6.7 ms** |
| `cards.oracle_text LIKE '%draw%'` | 14,753 | **1,858 ms** (warm) |

Dividing the rows of that table: **82×** on the warm type-line probe (653 / 8.0), **277×** on
the warm oracle-text one (1,858 / 6.7), and **2,082×** against the cold scan. LIKE is not an
option for a box that fires on a debounce, so `t:` and `o:` are folded into the FTS MATCH string
`filters::fts_query` already built, as FTS5 column filters — and `search_cards` and
`collection_list` share them for free because both already call it.

**What this costs is mid-word fragments.** Scryfall's `t:` and `o:` are true substring matches:
`o:raw` answers **3,802** there, matching "draw", and `t:reature` answers **18,909**. FTS prefix
reaches neither. **For type lines the gap is empty in practice** — type lines are built of whole
words, and the two engines agreed exactly on both probes above, 1,825 against 1,825 and 56,007
against 56,007. For oracle text a reader who types a mid-word fragment gets fewer cards than
Scryfall would give them. That is the accepted cost, written here rather than discovered later.

**`search_text` is wider than oracle text, by about 4%** — 15,359 against 14,753 on the `draw`
probe, which is 1.041. It holds top-level `oracle_text` plus every face's `name`, `type_line`
and `oracle_text`, so `o:goblin` also matches a card whose back face is *named* Goblin. Two
things make it the right column anyway: `cards.oracle_text` is **NULL for every double-faced
card**, so the narrower column is wrong in a worse direction, and the extra matches are face
text a reader searching rules text would mostly want. A clean `oracle_all` FTS column is a
possible later rung and is deliberately not this change.

**Negation needs care, because FTS5's `NOT` is binary.** A query that is *only* `-t:goblin` has
no left operand and is a syntax error as a MATCH string, so a purely negative text term compiles
to `c.rowid NOT IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)` instead. Mixed queries
put the positive terms in the MATCH and every negative one in its own subquery — splitting
unconditionally is uniform and cheaper to reason about than deciding per query.

### `a:` is an `instr`, and that is defensible

There is no artist FTS column and `cards.artist` carries no b-tree index (`CARDS_INDEXES` covers
`oracle_id`, `(set_code, collector_number)`, `name`, the collapse covering index and
`illustration_id`), so `a:` emits `instr(lower(c.artist), lower(?)) > 0`.

This is the one predicate that scans, and it is acceptable where `t:`/`o:` were not, because **it
never runs alone against the whole corpus in the ordinary case**: it is ANDed into a statement
the FTS join, the format mask or the collapse index has usually already narrowed. A bare `a:` in
an otherwise empty box is the worst case.

> **Not yet measured.** The bare-`a:` timing against the real corpus is owed by the live pass and
> belongs in this section. If it lands above ~250 ms the fallback is an index on `cards.artist`,
> which is cheap and additive. Do not quote a number here until one has been taken.

### Everything else is a plain predicate

`c:`, `id:`, `cmc:`, `pow:`, `tou:`, `r:`, `s:` and `f:` become ordinary SQL in
`push_card_filters` over columns that already exist: `colors`, `color_identity`, `cmc`, `power`,
`toughness`, `rarity`, `set_code`, `legal_mask`. `negated` wraps the clause in `NOT (…)`.
`s:` reuses the `set_code` expression built at the top of that function so the collection's
coalesce rule is not bypassed, and `f:` reuses `crate::legalities::bit` exactly as the existing
format filter does.

**`c:` is new and `id:` is not, and getting that backwards is the expensive mistake.** The app's
existing `colors` filter is *colour identity with subset semantics* — precisely Scryfall's
`id:` — so `id:` maps onto machinery that is already there and already faceted. Card **colors**
(`cards.colors`) had never been filtered on and needed a new predicate. Confusing the two would
make `c:rg` answer 13,399 where Scryfall answers 676.

### `power` and `toughness` are TEXT

Both columns are `TEXT`, because a power can be `*`, `1+`, `X` or `∞`. Comparisons need a cast,
and a cast needs a rule for what a non-numeric value compares as. Scryfall's own answer is
measured: `pow>=0` answers **19,128** and `pow>=*` answers the same **19,128**, while `pow:*`
answers **1,059** — so `*` participates in comparisons rather than being excluded from them.

The implementation casts with `CAST(c.power AS REAL)`, which yields `0.0` for `*` and for every
other non-numeric, and so matches the `pow>=0` observation. `pow:*` — a literal star as the
value — is matched as **string equality** before any cast is attempted, which is the only way to
ask that question at all.

> **Not yet measured here.** What `pow:*` returns against this corpus is owed by the live pass.

## `kw:` and corpus schema 5

`kw:` was the one keyword in the table with no column behind it, and it cannot be faked from
oracle text. Measured on Scryfall, 2026-09-22: `kw:flying` = **3,318**, `o:flying` = **4,617**,
and **`kw:flying -o:flying` = 0**. So every keyword does appear in the card's rules text — but
the text over-matches by **39%** ((4,617 − 3,318) / 3,318), on reminder text and on phrases like
"can't be blocked by creatures with flying". `kw:` is genuinely narrower and is worth a column.

Scryfall ships it as an array of capitalised strings — verified live, Serra Angel is
`["Flying", "Vigilance"]` — and matching there is **exact against a known vocabulary**, not
substring: `kw:fly` answers *"All of your terms were ignored"*. So the column stores the
keywords lowercased, delimited and wrapped — `|flying|vigilance|` — and the predicate is a
boundary-anchored `instr` on `|flying|`, never a bare substring, so `kw:fly` cannot match
`flying` here either. A card with no keywords is `NULL`, **never** `"|"`: a bare delimiter would
make every keywordless card match every `kw:`.

**The rung copies corpus schema 3 (`cards.produced_mana`) in every respect**, which is the
precedent for this shape:

- `CORPUS_SCHEMA_VERSION` 4 → **5**, one `ALTER TABLE {schema}.cards ADD COLUMN keywords TEXT`.
- Gated on the **column's absence** through `PRAGMA table_info`, never on `sqlite_master`'s text
  — `cards` is dropped and recreated by `swap_staging` on every sync, so its stored
  `CREATE TABLE` is whatever `create_staging` rebuilt, and a text probe would re-issue the
  `ALTER` and die at `duplicate column name` on exactly the databases that are already correct.
- A corpus with no `cards` table **owes nothing**. `ALTER` on a missing table raises, and a
  launch must survive a repair it cannot carry out.
- Schema-qualified through `on_schema`, or the column lands on `user.db`.
- **No backfill is possible.** `raw` is a gzip BLOB from schema v3 on and `json_extract` over
  one is a hard error, not a NULL. Every existing row reads NULL until the next full ingest,
  which is at most a day away because Scryfall regenerates the bulk file daily.
- No `cards_fts` rebuild and no `CARDS_INDEXES` entry: the rung adds an unindexed column and
  renumbers no rowid.

**That NULL gap needs a bridge, and the measurement above is what licenses it.** Between the rung
and the next full ingest `keywords` is NULL for every row, so a bare `kw:flying` would answer
zero cards and read as *you own no fliers* — a narrowing failing in the one direction a search
must never fail in. Because `kw:flying -o:flying` is empty, oracle text is a **superset** of the
keyword, so the predicate has two arms:

```sql
(c.keywords IS NOT NULL AND <exact delimited match>)
OR (c.keywords IS NULL AND <oracle text contains the keyword>)
```

Precise once ingested, over-inclusive before, never empty. `fill_unknown_produced_mana` is the
same idea one column over.

## Tag resolution: exact, through `slug_norm`

`filters::picked_tags` matches `slug` byte for byte and case-sensitively, and its doc says why —
a slug arrives there from the tag search's own results rather than from a keyboard. Typed syntax
breaks that assumption, and there were two ways to mend it:

1. teach the filter SQL to normalise, or
2. normalise at the edge and go on handing the filter real slugs.

**This is the second**, `tags::query::run_tag_resolve` (command `tag_resolve`). Three things
follow, and they are why it was the cheaper of the two:

- `slug` keeps one meaning throughout the crate.
- `index/facets.rs` goes on narrowing by exactly the list the search does, with no second copy
  of a normalisation to drift from it.
- The caller learns **which** name was unknown — which SQL that quietly matched nothing could
  never tell it, and which is the whole of the unknown-tag UI below.

Matching is on `slug_norm`, the column the ingest wrote with `tags::normalize`. That is
Scryfall's own rule: `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and
`otag:SPOT-REMOVAL` all return exactly **4,907** cards, while `otag:remov` 404s and `otag:*spot*`
answers nothing — `*` is stripped as punctuation rather than expanded, which is the decisive
measurement.

### Why not substring, when the Tags page is substring

`tags::query::run_tag_search` matches a substring and ranks the exact hit first, deliberately:
the Tags page is a type-ahead, and a reader who types `dog` and is told "no such tag" until they
spell `dogs-of-war` is not using a search box.

A **filter** cannot borrow that. A substring resolves one typed name to many tags, which would
have to be ORed — while every tag filter in this app intersects, so `atag:dragon` would silently
also answer `dragonborn`. The box offers the near misses instead, from the command that is built
to find them.

### A muted tag still resolves

`muted_tags` is absent from `run_tag_resolve`'s statement, and it is the one read in
`tags/query.rs` that leaves it out. Muting hides a *tag* — from the search box, the rail and a
parent's `childCount` — and is documented never to hide a *card*; nothing in `crate::filters`
consults that table. A reader who spells a tag out in the query box has named it rather than
browsed onto it, and refusing them the cards would be muting doing the one thing it is
documented never to do.

### A blank needle is `None`, never a query

`otag:` on its own, `otag:"---"`, and every keystroke on the way to a real tag normalise to `""`.
Bound into the statement that is `slug_norm = ''`, which is **not** "no rows": schema v20 added
the column with `DEFAULT ''` and v22's `backfill_oracle_slug_norm` is what repairs it, so a
database between those two rungs has a whole taxonomy sitting at `''` and a half-typed keyword
would resolve onto an arbitrary one of them. See
[issue #180](https://github.com/Msgaihede/mtg-grimoire/issues/180) — that column has been wrong
before, and the guard is why it cannot be wrong in this direction.

### The cap

`MAX_LOOKUPS = 64`. `picked_tags` deliberately has none and argues why: a chip arrives one press
at a time from a rail, so that list cannot grow by accident. This one is built from a string a
reader can **paste**, so the assumption that paragraph rests on does not hold. Asks past the cap
are answered `None` rather than dropped, so the answer still lines up index-for-index with them
and the box reports those names as unknown instead of silently applying nothing.

## How this fails — one arm closed, everything else open

Everywhere in this file's neighbourhood the rule is to fail **open**: an unrecognised weight
floor is no floor, an absent facet count leaves a chip live. `useCardSearch`'s `tagQueryBlocked`
is the exception, **it gates on tags only**, and both of its arms are deliberate:

- **Pending.** A search fired before its names have resolved goes out with **no tag filter at
  all** and caches the whole corpus under the key that afterwards means "filtered" — the wall
  wrong, served instantly from cache, with nothing on screen to notice. The query is
  `enabled: false` until the resolve settles.
- **Unknown.** A name that resolves to nothing empties the wall. Answering it as though the term
  were not there would show the unfiltered corpus in reply to a narrowing the reader asked for,
  which is the one direction a search must never fail in.

`rows` and `total` are emptied **in the hook** rather than at each of the three call sites,
because `placeholderData: keepPreviousData` is doing its job: a wall left to itself goes on
showing the *previous* search's cards, which reads as "these are your results".

**Predicates cannot fail closed, because they cannot be unknown.** A tag name is a string that
may or may not exist in a taxonomy the backend holds; `t:goblin` is a string that either matches
rows or does not. There is no third *this name is not a thing* state to gate on, so a predicate
that matches nothing is simply a search with no results, and the `No cards match these filters`
empty state already says so. A predicate must therefore never reach `tagQueryBlocked` — if one
did, every `t:` keystroke would blank the wall waiting for a resolve that never comes.

**Facets fail open, and that is a decision.** `index/facets.rs` is a second, in-memory
implementation of what `push_card_filters` answers, and the index carries no text, power,
toughness, artist or card-colour dimension. `t:` and `o:` narrow the counts for free because
they ride the FTS-derived bitset `run_facets` already folds. **Every other predicate leaves the
facet counts wider than the result set** — a chip may advertise more cards than pressing it
returns. That is the documented direction in
[search-faceting.md](search-faceting.md) and the right one: a count that is too high is a
cosmetic wrong, a chip that vanished is a filter the reader cannot reach. Growing the index was
considered and refused.

## Where it is typed

**Five surfaces get it free, because they share `useCardSearch` → `search_cards`**: the search
page, the deck editor's *All cards* tab, the collection's docked search column, the wishlist's
docked search column, and the Tags page. One hook, one parse.

**Three hooks had the parse added** — `useCollection`, `useCollectionSearch` and `useWishlist`
each debounced a raw string straight into their query and never called the parser. Their
backends needed nothing, because of the one shared function above. These three have **no tag
support and gain none here** — tags need `tag_resolve` wiring and a chip row — so a tag keyword
typed into one of them is folded back into the free text rather than dropped, which would
silently widen the search.

**Two call sites had it added** — `QuickAdd.tsx` and `DeckCoverPicker.tsx` call `ipc.searchCards`
with raw text, so `t:creature` would otherwise reach FTS as two words.

**Four filters are explicitly out of it** — `printingFilters.ts`, `deckFilter.ts`,
`NoteCardsDialog.tsx` and the shared-collection web viewer all filter an already-fetched array
in the client. They are not corpus searches, they have no backend to teach, and
half-implementing the syntax in four hand-rolled `.includes()` filters would create four
dialects. They keep their plain substring behaviour.

## What the reader sees

`TagQueryRow`, drawn under the filter row and **only when there is something to say** — a
permanent strip would spend the deck panel's scarcest axis on a feature most searches never use.

- **Chips**, through the Tags page's own `TagChips`, so a tag picked two ways looks the same
  both times. Labelled `Tags from the search box` rather than `Picked tags`, because the Tags
  page draws both rows at once and two groups sharing a name are two controls a screen reader
  cannot tell apart.
- **Predicates get chips too**, labelled with the keyword the reader typed, or a reader would
  have no way to see or remove one. They are deduplicated by field, operator and value, where
  tags are deduplicated by tag.
- The ✕ and the include/exclude press **rewrite the box**. The text stays the one source of
  truth for the query; a chip driven from a hidden list beside it would be a second thing to
  disagree with what the reader can see. Both flush the debounce, because a press is already the
  reader's final answer.
- A deduplicated chip's ✕ removes **both** terms, so `atag:dog atag:dog` is one chip and clearing
  it clears the filter — a chip that vanished and left the wall still narrowed would be worse
  than no chip at all.
- **No weight floor control.** The syntax has no keyword for one — Scryfall has none to borrow —
  and a control here the query language cannot express would be a setting the reader could not
  write down.
- **An unknown tag name is named**, with the closest tags from `tag_search` offered beside it.
  Pressing one rewrites that term and keeps the keyword the reader typed, so `otag:remov` becomes
  `otag:removal` rather than `oracletag:removal`. This is the part Scryfall has nothing to teach
  us: it 404s and says no more, and a reader who mistypes and is shown a silent empty wall
  concludes their collection has no removal in it.

**The F1 panel carries the reference**, as a second tab beside Shortcuts rather than as a longer
list below them: the panel is 384px wide and a reader opens it to find a chord, so fourteen
keywords with examples appended under the chord sections would bury the thing it is for. Tab
state is local to the panel and resets on close, for the same reason.

**That table is generated from the parser's own keyword table**, exactly as `SHORTCUTS` is the
single source for both a binding and its panel row. A keyword the panel advertises that nothing
parses is the drift `shortcuts.ts` exists to prevent, and the fix is the same one — one table,
two readers — with a test that every advertised example round-trips through `parseQuery` to
exactly one term.

## Where it lives

| file | what it owns |
| --- | --- |
| `src/features/search/queryLanguage.ts` | The grammar. `parseQuery`, `QUERY_KEYWORDS`, the source spans, and the three rewrites (`removeToken`, `setTokenNegated`, `setTokenValue`) |
| `src-tauri/src/filters.rs` | `QueryPredicate` and the SQL — one arm per field in `push_card_filters`, and `fts_match` for the two that ride the index |
| `src-tauri/src/schema.rs` | Corpus schema 5, `cards.keywords` |
| `src-tauri/src/tags/query.rs` | `run_tag_resolve` / `tag_resolve` — names to slugs, exact, through `slug_norm` |
| `src/features/tags/tagFilters.ts` | `mergeTagTerms` — the caller's chips ANDed with the typed ones |
| `src/features/search/useCardSearch.ts` | The wiring: parse, resolve, merge, gate, and the two chip rewrites |
| `src/features/search/TagQueryRow.tsx` | The chip row and the unknown-tag note |
| `src/components/QuerySyntaxHelp.tsx` | The F1 panel's Search syntax tab, drawn from `QUERY_KEYWORDS` |

The tag merge is a union rather than one side winning: a Tags page reader who has chipped `dog`
and then types `otag:ramp` is asking for a dog that ramps. Each list is deduplicated and sorted,
which changes no answer (`picked_tags` sorts and dedups anyway) and is what keeps chipping `dog`
*and* typing `atag:dog` one **query key** rather than two.

## Driven in the shipped window

### The tagger pass, 2026-08-22

`npm run tauri dev` from the `tag-search` worktree, **debug build**, window 1920×1080, first-run
sync: **116,700 cards**, **4,525 oracle tags** / 230,243 taggings, **11,530 art tags**. Both
surfaces were driven — the search page and the deck editor's docked panel — and they answered
identically, which is the claim "one wiring reaches both" made good.

**Driven twice**, because `main` moved the deck editor underneath that branch mid-way
(issue #183: the card pane became an overlay and the search column opens by default again).
The search-page figures are from the first pass and the deck-panel ones were re-taken on the merge,
so no number here describes a tree that was not shipped.

⚠️ **This pass predates the `a:`/`o:` reversal above and every line of it typed those two letters
as tag keywords.** The counts are still the taxonomy's counts; the *spellings* are not
reproducible as typed. Read `o:` as `otag:` and `a:` as `atag:` throughout the table.

| what was typed (2026-08-22 spelling) | what the window did |
| --- | --- |
| `o:ramp` | one chip (`ORACLE ramp`), wall narrows to **2,149 cards** |
| `bolt a:dragon -o:removal` | two chips, one of them `not removal`; wall answers **1 card / 3 printings** |
| ✕ on the `dragon` chip | box becomes `bolt -o:removal`, wall widens to **6 cards** |
| `o:remov` | wall reads *No cards match these filters*, note reads **No oracle tag called "remov". Did you mean removal · removal-creature · removal-burn** |
| pressing `removal` | box becomes **`o:removal`** — the reader's keyword kept, not normalised to `oracletag:` — note gone, chip in its place |

`tag_resolve` over the real oracle taxonomy: **4 ms for six lookups**, debug build. All three
spellings of `spot removal` (`spot removal`, `spot-removal`, `SPOTREMOVAL`) folded onto
`spot-removal`; `remov` and `""` both answered `null`. That is Scryfall's measured behaviour
reproduced against a local 4,525-tag file.

In the deck editor's panel, on the merged tree: `a:dragon -o:removal` draws both chips and
answers **774 cards**, at `panelScrollWidth` **383** against `clientWidth` **383** and a page
`scrollWidth` of 1920 against a `clientWidth` of 1920 — no overflow in either.

**One thing found and deliberately not fixed there.** Dragged to its floor
(`MIN_PANEL_WIDTH_PX`, 206), that panel overflows its own content box — `scrollWidth` **258**
against `clientWidth` **205**. It is **not this feature's**, and the before/after was taken in
one pass to prove it: clearing the box so the tag row is gone leaves the figure at **258**. The
two culprits are the search `<input>` (`min-w-56`, a hard 224px floor a flex item cannot shrink
below) and the `Color identity` group, `flex gap-1.5` with **no `flex-wrap`** — six 36px chips
plus five 6px gaps = **246**. That is exactly the failure `src/CLAUDE.md` warns about under "a
row of fixed-width controls is sized by the narrowest surface that draws it", live and
pre-existing. The tag chip row itself wraps and fits: **193px wide over two lines, 0px
overhang** at that width, and 290px at the panel's normal 384.

### The query-syntax pass

> **Owed.** Each keyword typed into at least one surface, the collection and wishlist boxes
> included — they are the two nothing else proves — with counts, the bare-`a:` timing and
> `pow:*`'s behaviour recorded in the two slots above. Until it has run, everything in this
> document about the shipped window is the tagger pass and says so.

## Refused, and named so it is a decision

- **`or`, parentheses and nested boolean grouping.** The refusal is unchanged and so is its
  reason.
- **A clean `oracle_all` FTS column.** The 4% over-match above is what would buy it.
- **`is:`, `ft:`, `game:`, `year:`, `border:`, `frame:` and the rest of Scryfall's long tail.**
  Each is a separate predicate with separate data questions; the fourteen in the table are the
  ones with a column behind them or one cheap rung.
- **Growing the in-memory facet index**, so every predicate but `t:` and `o:` could narrow a
  facet count.
- **The four client-side array filters.**
