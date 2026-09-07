# Token management for decks

Design for [issue #388](https://github.com/Msgaihede/mtg-grimoire/issues/388) — *"Automatically
resolve the tokens required by a deck. Allow users to select the art and quantities they want to
include in the deck."*

Every figure below was measured on 2026-09-07 against the live debug corpus at
`src-tauri/target/debug/data/corpus.db` (117 621 rows), in Node, unless it says otherwise.

---

## 1. What is already true

**Nothing has to be downloaded, and no new Scryfall call is made.** The corpus already holds every
card the feature needs:

| layout | rows | `oracle_id` missing | `is_paper` | has an image |
| --- | --- | --- | --- | --- |
| `token` | 2 988 | 0 | all | all |
| `emblem` | 137 | 0 | all | all |
| `double_faced_token` | 120 | 0 | all | all (face images only) |

3 245 rows over 1 078 distinct token/emblem `oracle_id`s. `raw` holds the untouched Scryfall bulk
line as a gzip BLOB, and 21 888 rows (18.6 %) carry an `all_parts` array. Of the 2 523 distinct
token printings referenced by some card's `all_parts`, **2 520 resolve to a local `cards` row —
99.9 %.**

**Tokens are hidden from the search wall and from nothing else.** `filters.rs:118` gates on
`legal_mask != 0` and only the search view sends `playable_only: true`. `card_detail`,
`card_printings`, `card_holdings` and every deck read already see tokens today, and
`DeckCoverPicker.tsx:148` already passes `playableOnly: false` deliberately to reach token art.

**`card_printings` already works on tokens.** Its predicate is `oracle_id = ?1 AND is_paper = 1`
(`card.rs:96`), and every token row satisfies both. The art picker therefore needs **no new Rust
command**.

**Double-faced tokens are not a special case.** All 120 lack a top-level `image_uris`, but every
one has `face_image_uris`, and `image_uri::for_face` resolves face-first with top-level as the
fallback. `cardImageUrl(tokenId, 0, "display")` draws them today.

---

## 2. The filter rule

This is the part that is not obvious, and getting it wrong is the most likely way to ship
something that looks right and is not.

A full-corpus scan of every `all_parts` entry found exactly four `component` values and no others:

| component | entries |
| --- | --- |
| `combo_piece` | 148 216 |
| `token` | 16 377 |
| `meld_part` | 164 |
| `meld_result` | 81 |

**Filtering on `component == "token"` is wrong in both directions.**

- **It misses emblems.** `Elspeth, Sun's Champion` names her emblem as
  `component: "combo_piece"`, `type_line: "Emblem — Elspeth"`. Verified against the stored blob.
- **`combo_piece` is mostly noise.** It includes the card itself — `Krenko, Mob Boss` names a
  *different printing of Krenko* as a `combo_piece` — and it includes things like the Eldritch
  Moon checklist card.

The rule that survives real data is a union, evaluated against the **resolved target row**, not
against the entry alone:

> Keep an `all_parts` entry when its `component` is `"token"`, **or** when the `cards` row it
> resolves to has `layout = 'emblem'`. Then drop any entry whose `name` equals the producing
> card's own name.

Two notes on why each half is written the way it is:

- **`component == "token"` rather than a layout test**, because the layouts those entries resolve
  to are not all token-ish: `token` 16 216, `double_faced_token` 79, **`flip` 75**,
  `reversible_card` 3. A layout allow-list would silently drop 78 real token relationships.
- **Self is excluded by `name`, never by `id`** — the same rule `meld_parts` documents at
  `card.rs:635` for the same measured reason: an `all_parts` self-entry routinely carries a
  *different printing's* id, so an id comparison does not exclude it.

An entry that resolves to no local row is dropped rather than shown as a hole. That is 3 or 4
printings in the whole corpus, and a token nobody can draw or pick art for is not a row worth
rendering.

### A token's name does not identify it

Grouping is by `oracle_id` and must never be by name. **104 token/emblem names are shared by more
than one `oracle_id`:**

| name | distinct `oracle_id`s |
| --- | --- |
| Elemental | 31 |
| Spirit | 22 |
| Bird, Soldier | 13 each |
| Insect | 12 |
| Golem | 11 |

And one card can make two of them: **`Wurmcoil Engine` makes two tokens both called `Wurm 3/3`**,
under different oracle ids, separated only by Deathtouch and Lifelink. A deck holding it gets two
rows that are correct, adjacent and — without more — indistinguishable.

That is a real bug and not a hypothetical one. It shipped once on the collection wall, where a 2X2
and an LEA Lightning Bolt both announced *"Copies of Lightning Bolt"*; neither suite caught it
because both names were correct and merely not unique.

**What separates them is power/toughness *and* colors *and* oracle text, and no two of the three
suffice.** Sampled across the 8 distinct `Soldier` tokens and the 8 distinct `Elemental` tokens,
those three fields together told 8 of 8 apart in both cases — but the corpus holds a colorless
`1/1` Soldier with no text beside a white `1/1` Soldier with no text, which p/t and text together
cannot separate, and it holds a `*/*` Elemental, so `power` and `toughness` are strings and must
never be parsed to numbers. So `DeckTokenRow` carries `power`, `toughness`, `colors` and
`oracleText`, the panel draws a subtitle built from all three, and the quantity stepper folds that
subtitle into its accessible name.

### The default printing's tie-break is the common path

Different maker cards name different printings of the same token: across 40 Treasure makers, **12
distinct Treasure printings** were referenced. A deck with two Treasure makers pointing at two
printings gives both a reference count of 1, so the tie-break — `released_at DESC, set_code ASC,
collector_number ASC, id ASC`, the tail `list_printings` already orders by — is what actually
chooses the art, rather than being the rare fallback it looks like.

---

## 3. Cost, and why the list is derived rather than stored

The list is **recomputed on every deck open**. Nothing about a resolved token is written down
unless the reader has deviated from it.

The concern this has to answer is decompression: `raw` is gzip, so resolving means inflating and
parsing ~2 KB per distinct card in the deck. Measured over a 100-card pool (the top 100 cards by
`edhrec_rank`, which is a denser-than-typical deck):

```
all_parts entries scanned : 71
kept (token/emblem)       : 10
distinct tokens needed    : 9
timings (3 runs, Node)    : 4.9 ms, 4.9 ms, 5.3 ms
```

**~5 ms in Node, for the whole deck.** Rust will beat that. The list is cheap enough that
recomputing it is strictly better than storing it, because a stored list needs a reconciliation
pass on every deck edit *and* goes stale when a Scryfall sync changes a card's `all_parts` — with
nothing to notice.

The one thing that must **not** be built is a corpus-wide token index. Token references sit on
15 161 printings and no column predicts them, so a cold full scan costs 6.5 s and would need a new
ingest-filled column. We never ask that question: only the cards in the open deck are ever
touched.

**Which deck cards count.** Cards in **active categories only** — `deck_categories.is_active = 1`.
`is_active = 0` means "counts toward nothing" (`schema.rs:1588`), and that is the whole of what the
old `maybe` zone meant, so the Maybeboard contributes no tokens. The Sideboard and Companion are
active and do contribute, which is right: you sleeve those.

---

## 4. Storage — the `deck_tokens` table

The table stores **only deviations**. A token you never touched has no row.

```sql
CREATE TABLE deck_tokens (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    -- The token's identity across every printing of it. Every token, emblem and
    -- double-faced-token row in the corpus has one (0 missing of 3 245), so this is safe as a
    -- grain in a way `card_id` would not be.
    oracle_id TEXT NOT NULL,
    -- The printing the reader picked. NULL means whichever one the resolver names.
    -- (No double quotes in these comments: see the note under the registration list.)
    card_id TEXT,
    -- NULL means the default, which is 1. Stored absent rather than as a 1, so that changing
    -- the default later moves every untouched token.
    quantity INTEGER,
    state TEXT NOT NULL DEFAULT 'auto'
        CHECK (state IN ('auto', 'hidden', 'manual')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sync_uid TEXT
);
CREATE UNIQUE INDEX idx_deck_tokens_grain ON deck_tokens (deck_id, oracle_id);
CREATE UNIQUE INDEX idx_deck_tokens_uid ON deck_tokens (sync_uid);
```

`pub const DECK_TOKEN_GRAIN: &str = "deck_id, oracle_id";` beside the other grain constants, and
every `ON CONFLICT` interpolates it — a conflict target that does not match the index verbatim is a
runtime error at the first write, not a compile error.

**The three states.**

- `auto` — the row exists only to carry a `card_id` and/or a `quantity` for a token the deck
  derives anyway.
- `hidden` — the reader dismissed it. Still derived, deliberately not drawn.
- `manual` — draw it whether or not anything derives it. A token the reader added by hand, and
  also what a derived token becomes if the reader wants it kept after removing the card that made
  it.

**The empty row is not representable.** A row with `state = 'auto'`, `card_id IS NULL` and
`quantity IS NULL` carries no information, so the write path deletes it instead of storing it.
That keeps "no override" a single state rather than two that must be kept in agreement.

**Deliberately not grained on `variant`.** The derived list *is* per-variant, because deck cards
are. The override is not: choosing the Treasure art for this deck and then finding it reverted in
the theory build would be a surprise with nothing to recommend it.

### The deck's own column

`decks.tokens_open INTEGER NOT NULL DEFAULT 0` — whether the area is expanded, per deck, alongside
`last_variant`, `last_group_by`, `last_sort_by` and `separate_x_group`. Those three all appear in
the `decks` capture `Spec` (`capture.rs:299`), so `tokens_open` joins them and travels the same way.

### What a new synced table owes

**Ten registrations** — this said nine until the rung was actually built, and the tenth is number 10
below. A rung that misses one of them is a fresh install quietly disagreeing with every upgraded
one:

1. An `if v < N` block at the **bottom** of `migrate_user`, ending with its own **literal**
   version number.
2. A matching line in `USER_SCHEMA_SQL` (`schema.rs:3320`) — the literal a fresh or converted file
   is built from, which climbs nothing. `the_user_schema_is_byte_identical_to_what_the_ladder_builds`
   compares the two byte for byte.
3. An `UNDO_V<N>` constant for the rewind fixtures.
4. `schema::TABLES` with `Side::User` — `every_table_is_on_exactly_one_side`.
5. An arm in `mirror::watch::surface_of` — `every_table_in_the_schema_has_been_decided_about`.
   `deck_tokens` maps to `DECKS_ONLY`, like `deck_cards`.
6. The `sync_uid` column and its unique index (above), in the rung *and* in `USER_SCHEMA_SQL`.
7. `schema::SYNCED_TABLES` — which becomes `[&str; 13]`, and the count in its type must move with
   it. So must `capture::TABLES`' `[Spec; 13]` and `apply::META`'s `[Meta; 13]`.
8. A `capture::Spec`: `keys: ["id"]`, `fields: ["oracle_id", "card_id", "quantity", "state"]`,
   **`counters: &[]`**, one `Parent { key: "deck", col: "deck_id", table: "decks",
   absent: Absent::Null, soft: false }`, `append_only: false`.
9. An `apply::Meta` with an `order` that puts it **after `decks`** (`decks` is 1), a `Grain`
   restating `DECK_TOKEN_GRAIN` as a predicate, and **`counters: &[]`**.
10. **Three lines in `sync_engine/apply/tests.rs`.** `every_unique_index_on_a_synced_table_has_been_decided_about`
    reads every UNIQUE index off a live `SYNCED_TABLES` and compares it against a written-down
    list, so it goes red on any new synced table that has a grain. This one is easy to miss
    because it is in a `tests.rs` rather than beside the other nine, and because nothing points
    at it from the registration sites.

Two further sweeps that are not registrations but fail the same way: `schema.rs`'s
`every_plain_grain_constant_names_the_index_the_head_schema_carries` wants
`("idx_deck_tokens_grain", DECK_TOKEN_GRAIN)` — the grain carries no `coalesce`, so
`PRAGMA index_info` can check it, and until the first `ON CONFLICT` interpolates the constant
this sweep is the only thing fencing it at all. And **the rung's DDL is a plain `"…"` Rust
string, so its SQL comments cannot contain a double quote** — the two comments this document
first wrote with quotes around *whichever one the resolver names* and *the default* are a
compile error as written, and since the rung and `USER_SCHEMA_SQL` must be byte-identical, both
copies lose them.

**`quantity` is a field, not a counter, and that is deliberate on two grounds.** Mechanically, a
counter carries `NEW - OLD` and this column is nullable, so there is no arithmetic to carry;
`deck_cards.quantity` can be a counter precisely because it is `NOT NULL`. Semantically, last write
wins is the behaviour that is actually wanted: `deck_cards.quantity` sums because two devices each
sleeving a copy means two copies, but "how many Treasures I want to bring" is a *setting*, and two
devices each setting it to 4 must mean 4 rather than 8.

That also disposes of the floor question. There is no `Floor` because there is no counter, and a
quantity of zero is simply stored — it is a token the reader zeroed, which is information, and the
row still carries the art choice that would otherwise be thrown away as a side effect of stepping a
number to nothing.

**Take the version number when you land, not when you start.** `USER_SCHEMA_VERSION` is 34 today,
so this is 35 — but v12 was numbered three times on three branches in one day, and git cannot see
that collision because two `ALTER TABLE`s in two files conflict in neither.

---

## 5. The boundary — Rust supplies facts, TS draws conclusions

### Rust

One read command:

```rust
deck_tokens(deck_id: i64, variant: String) -> Vec<DeckTokenRow>
```

One row per distinct token `oracle_id`, each carrying:

| field | what it is |
| --- | --- |
| `oracleId` | the grain |
| `name`, `typeLine`, `layout` | from the resolved `cards` row |
| `defaultCardId` | the printing the resolver names — deterministic (see below) |
| `sources` | the deck cards that produce it: `{ cardId, name }` — the *why* |
| `derived` | `false` for a `manual` row nothing in the deck produces |
| `cardId`, `quantity`, `state` | the stored override row, joined on; `null` when there is none |

`defaultCardId` must be **deterministic**, or the same deck draws different art on two opens.
Rule: among the referenced printings of that `oracle_id`, the one that the most deck cards point
at; ties broken by `released_at DESC, set_code ASC, collector_number ASC, id ASC` — the same tail
`list_printings` already orders by (`card.rs:386`).

Every failure is an empty result, never an `Err`, exactly as `meld_parts` argues at `card.rs:626`:
an unknown id, a `raw` that will not inflate or parse, a missing or non-array `all_parts`. A deck
must not fail to open over an area most decks use lightly.

Three writes, each through `sync::with_write`:

```rust
deck_token_set(deck_id, oracle_id, card_id: Option<String>, quantity: Option<i64>, state: Option<String>)
deck_token_clear(deck_id, oracle_id)          // back to derived defaults; deletes the row
deck_token_add(deck_id, card_id)              // resolves oracle_id from the printing, state = 'manual'
```

`deck_token_set` deletes rather than writes when the result would be the empty row (§4).

### TypeScript

The whole domain layer, and where the tests live:

- **Effective quantity** = `stored ?? 1`. Every token starts at 1 and the reader steps it. No
  heuristic: parsing *"create two 1/1 white Soldier tokens"* out of oracle text is defeated by
  `create X`, *for each*, copy-tokens and repeatable makers like Krenko, and a guess you have to
  correct is worse than a floor you raise.
- **Effective printing** = `override.cardId ?? row.defaultCardId`.
- **Visibility** — `hidden` rows are drawn only behind a "show dismissed" affordance; `manual`
  rows are drawn whether derived or not.
- **Order** — emblems last, otherwise by name. An emblem is a one-off; a Treasure pile is what you
  reach for.

### No new Rust for the art picker

`ipc.cardPrintings(oracleId, marketplace, limit)` already answers it. Treasure returns 97 printings
across 70 distinct arts, so the picker is a real dialog over a grid, not a dropdown.

**It needs no `playableOnly: false`, and an earlier draft of this document was wrong to say so.**
That flag is `searchCards`', which is what `DeckCoverPicker.tsx:148` passes it to; `card_printings`'
predicate is `oracle_id = ?1 AND is_paper = 1` (`card.rs:96`) with no `legal_mask` term at all, so
tokens are never filtered out of it in the first place. The mistake was worth making explicit
because the symptom of "fixing" it later would be a compile error, not a wrong result.

---

## 6. The UI

A new sibling in the editor's flex column, **after the Deck stats band** at `DeckEditor.tsx:4453`:

```tsx
<section aria-label="Tokens & emblems" className="shrink-0 border-t border-border pt-3">
```

Four constraints, each of which the file already documents and one of which has already cost a
session:

- **A `<section>`, never an `<aside>`.** A second complementary landmark broke five `App.test.tsx`
  pane assertions (`DeckEditor.tsx:4417`).
- **`shrink-0` is mandatory.** The root `<section>` is the editor's only scroller, and
  `DeckEditor.tsx:4423` is explicit that `shrink-0` on the bands below the desk "is the whole of
  why this editor scrolls now".
- **Below the stats band, not between `PriceStrip` and it.** The strip's drag-remove tray sits at
  `-top-3`, reaching into this column's `gap-3`; splitting the pair would leave a reader dragging a
  card the height of four charts to reach the one drop that takes it out
  (`DeckEditor.tsx:4413`).
- **Collapsed by default**, driven by `decks.tokens_open`. A reader who never sleeves tokens pays
  one header row for the feature.

Contents when open: a wall of tiles at the `GridView` scale (`TILE_WIDTH = 150`), each drawing
`CardArt`, the token's name, a `QuantityStepper` at `size="xs"`, and a press that opens the art
picker. The header carries the count. A token's `sources` are reachable per tile, so "why is this
here" is answerable without leaving the page.

**Naming.** The area is **"Tokens & emblems"**. `autoCategory.ts:130` already uses the bare word
*Tokens* for an auto-category of cards that **make** tokens, driven by the
`repeatable-token-generator` oracle tag. Those are opposite meanings of one word, and this repo does
not let words trade places. The auto-category is not renamed — renaming it would silently regroup
existing decks — so the two strings are kept distinct instead.

### Empty and unavailable states

- **A deck whose cards make nothing** — the header says so and the area stays collapsed. Not an
  error.
- **A deck with no cards** — the same.
- Neither state depends on the Tagger datasets, price feeds or the relay. This feature reads the
  corpus and nothing else, so it has no "never fetched" floor to fall back to.

---

## 7. Testing

**Rust**, over hand-built fixture rows (never against synced `cards` data — a hand-written row in
`cards` or `sync_meta` makes every later measurement a fiction, so fixtures are inserted and
deleted):

- a plain token (`component: "token"`) resolves;
- **an emblem arriving as `component: "combo_piece"` resolves** — the case a naive filter misses;
- a `combo_piece` self-reference under a *different printing id* is excluded, which is the case an
  id-based self-test fails;
- an `all_parts` id absent from `cards` is dropped, not rendered as a hole;
- a card in an inactive category (the Maybeboard) contributes nothing;
- two deck cards naming the same token collapse to one row, and `sources` carries both;
- `defaultCardId` is stable across repeated calls on the same deck;
- every failure shape returns an empty vec: bad gzip, unparseable JSON, missing `all_parts`,
  `all_parts` that is not an array;
- the grain refuses a duplicate `(deck_id, oracle_id)`;
- the migration rung, and the rewind fixture for it.

**TypeScript** — the merge is the logic that can break: `stored ?? 1`, override precedence over
`defaultCardId`, `hidden` suppression, `manual` rows with `derived: false`, ordering with emblems
last.

**Storybook** — read and write handlers in `.storybook/fake/db.ts`, rows in `FakeDb` and a seed, so
the area has stories at both states (a deck with tokens, a deck with none). The fake stores rows
and derives DTOs; it must not store DTOs.

**`ipc.test.ts`** pins the argument names of the four new commands, which is the only fence the
Rust↔`ipc.ts` boundary has.

---

## 8. Out of scope

Named here so the plan does not quietly grow them:

- **Export.** Tokens do not reach the seven formats. `KIND_SECTION` is a `Record<CategoryKind,
  string>` that is total over the union, so adding a section is a compile error until every arm is
  answered, plus `SECTION_ORDER`, `sectionOf`, `ACTIVE_ONLY` and 14 golden files per surface. That
  is a feature of its own.
- **The collection and wishlist join.** No owned/missing figure on a token, no "send to wishlist".
- **Proxy or print sheets.**
- **Meld results and combo pieces.** `meld_parts` already serves meld in the card pane; combo
  pieces are 148 216 entries of mostly self-references and checklist cards.
- **A corpus-wide token index** (§3).

## 9. A stale comment found on the way

`search.rs:1252` claims memorabilia and token-only sets "have no rows in `cards` at all, because
`default_cards` holds nothing for them". Measured false: `set_type = 'token'` joins **2 950** card
rows and `memorabilia` **5 847**. Not this feature's to fix, and recorded here so the next reader
does not trust it.
