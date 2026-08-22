# Deck driven collection — design

**Date:** 2026-08-22
**Issue:** [#168 — Link Live deck cards to the collection](https://github.com/Msgaihede/mtg-grimoire/issues/168)
**Status:** approved, ready to plan

## What this is for

Not everybody wants to keep a collection by hand. A reader who builds decks has already told
this app what cards they own — twice, if they then re-enter the same cards on the Collection
page. Issue #168 asks for the second entry to go away: **switch a setting on and your decks
_are_ your collection.**

The rule, in one line: **the collection is the sum of every `deck_cards` row whose `variant`
is `live`.** Theory is what a deck is being built _toward_, so it is excluded; a deck with no
theory list keeps all its rows as `live` and is therefore counted in full, with no special
case. Inactive categories count too — a switched-off Maybeboard is about how the _deck_ is
read, not about whether the cards are in the reader's hands.

Nothing is deleted. The setting changes where the collection is _read from_; the reader's
hand-built `collection_entries` stay on disk untouched and come back the moment the switch
goes off.

## What already exists

- **`collection_entries`** (schema v4, `src-tauri/src/schema.rs:914`) — 24 columns, the grain
  `schema::COLLECTION_GRAIN` (`schema.rs:249`), and `collection.rs`'s seven commands over it.
- **`deck_cards`** (schema v8, `finish` at v19 — `schema.rs:1395`, `:2034`) — grain
  `deck_id, variant, category_id, card_id, coalesce(finish, '')`
  (`schema::DECK_CARD_GRAIN`, `schema.rs:325`). `variant` is `live | theory`
  (`schema::DECK_VARIANTS`, `schema.rs:391`); `quantity` is the only quantity column and
  `CHECK (quantity > 0)`.
- **`app_meta`** (schema v6, `schema.rs:1211`) — the application's key/value table, read and
  written through `update::get_app_meta` / `set_app_meta` (`update.rs:291`, `:302`). Five
  settings live there already; `nav.rs` is the boolean one.
- **`deck_allocations`** (schema v5, `schema.rs:1107`) — the reservation ledger that runs the
  causality the other way: the collection is the truth, and `allocate_deck` (`deck.rs:3381`)
  greedily claims `collection_entries` rows for `live`, active deck cards.

## Architecture

### 1. The setting — one bit in `app_meta`

A new `src-tauri/src/deck_driven.rs`, copied from `nav.rs` because that module is already
exactly this shape:

- `K_DECK_DRIVEN: &str = "deck_driven_collection"`, stored as `"1"` / `"0"` through two named
  constants. **`false` writes `"0"`; it does not delete the row** — `nav.rs`'s
  `expanding_again_clears_a_stored_collapse` is the test a naive implementation fails.
- `pub fn stored(conn: &Connection) -> bool` — infallible. A missing row, a junk row and a row
  a newer build wrote something else into all read `false`. That is what makes "reading the
  setting can never fail" cheap enough to do inside every query builder.
- `pub fn store(conn: &Connection, on: bool)` — no refusals. A `bool` off the IPC boundary has
  no junk state; `serde` has already rejected everything that is not `true` or `false`.
- Commands `deck_driven_collection` (returns a bare `bool`) and `set_deck_driven_collection`,
  both `#[tauri::command(async)]`, the write through `spawn_blocking` + `sync::with_write`.

No migration. No capabilities entry — Tauri v2's ACL gates `core:` and `plugin:` commands, and
an app's own `#[tauri::command]` is always callable. Two lines in `lib.rs`'s `invoke_handler`,
beside `nav::nav_collapsed`.

**The write must also invalidate the owned facet index.** Flipping the switch changes which
cards are owned without touching either table, so `set_deck_driven_collection` runs
`index::lifecycle::invalidate_owned(state)` on success exactly as `collection::with_write_owned`
does (`collection.rs:679`). Without it the search Owned chip keeps yesterday's answer with
nothing on screen to notice.

### 2. One source swap — `collection_source.rs`

The whole of the data change is a single function:

```rust
/// The `FROM` fragment every "what does the reader own" query builds on, aliased as the
/// caller spells it. Off, this is the table. On, it is a subquery over the live deck lists
/// that emits the same column names, so the caller's WHERE, ORDER BY and price joins are
/// untouched.
pub fn source(conn: &Connection, alias: &str) -> String
```

Off it returns `"collection_entries {alias}"`. On it returns:

```sql
(SELECT min(dc.id)                      AS id,
        dc.card_id                      AS card_id,
        dc.set_code                     AS set_code,
        dc.collector_number             AS collector_number,
        dc.lang                         AS lang,
        coalesce(dc.finish, 'nonfoil')  AS finish,
        NULL                            AS condition,
        NULL                            AS condition_original,
        sum(dc.quantity)                AS quantity,
        0                               AS tradelist_quantity,
        count(DISTINCT dc.deck_id)      AS deck_count,
        NULL AS purchase_price,  NULL AS purchase_currency,
        NULL AS acquired_at,     NULL AS acquisition_source,
        NULL AS serial_number,
        0 AS altered, 0 AS signed, 0 AS proxy, 0 AS misprint,
        NULL AS grading,  '[]' AS tags,  NULL AS notes,
        max(dc.needs_review)            AS needs_review,
        min(dc.created_at)              AS created_at,
        max(dc.updated_at)              AS updated_at
   FROM deck_cards dc
  WHERE dc.variant = 'live'
  GROUP BY dc.card_id, coalesce(dc.finish, 'nonfoil'), dc.lang) {alias}
```

Seven things about it, each of which is a decision rather than an accident:

- **`WHERE dc.variant = 'live'` is the entire rule.** There is no category predicate and no
  join to `deck_categories`: an inactive pile is a statement about how the deck is read, not
  about what the reader has in their hands. And a deck with `theory_enabled = 0` stores every
  row as `live`, so "a deck with no theory version is counted in full" needs no clause of its
  own. There is no join to `decks` either — **archived decks count**, because archiving is
  filing rather than disassembling.
- **The grain matches `COLLECTION_GRAIN`'s live terms and no others.** `card_id`, `finish` and
  `lang` are the three a deck card can supply. `condition`, `altered`, `signed`, `proxy`,
  `misprint`, `serial_number` and `grading` are also in that grain and have no source here, so
  they are constants — and constants that cannot collapse two real rows into one, because they
  are constant across every derived row.
- **`coalesce(dc.finish, 'nonfoil')` is the one translation.** `deck_cards.finish` is
  `NULL | 'foil' | 'etched'` and `'nonfoil'` is never stored (`deck::normalise_finish`,
  `deck.rs:170`); `collection_entries.finish` is `NOT NULL` and spells it out. It appears twice
  — once in the SELECT and once in the `GROUP BY` — for `COLLECTION_GRAIN`'s own reason: SQLite
  treats NULLs as distinct, so grouping on the bare column would fork every regular copy.
- **`condition` is `NULL`, not `'NM'`.** The DDL default would be a fact the reader never
  stated, and the collection export scope would write it into their file. `CollectionRow.
  condition` becomes `Option<String>` (`string | null` in TypeScript) and every renderer
  handles the absent case.
- **`needs_review` survives.** `deck_cards` carries that column and `reconcile::sweep_orphans`
  already writes it over all three user tables (`reconcile.rs:637`), so a vanished printing
  still flags a deck-driven collection and the page's banner still has something to offer.
  `max()` over the group is "any contributing row has a sentence".
- **`min(dc.id) AS id`** is unique per group — the groups partition disjoint sets of rows — and
  is stable enough for a React key and for the row identity the table's virtualiser wants. It
  is **not** a `collection_entries.id`, which is exactly why §4 exists.
- **`count(DISTINCT dc.deck_id) AS deck_count`** rides along free in the same aggregate and is
  what §5's provenance column draws. It is `NULL` in the table branch.

**`deck_count` is not part of the shared shape.** `source` returns a `FROM` fragment, and
`collection_entries` has no such column to alias — wrapping the table in a subquery just to
add `NULL AS deck_count` would put an aggregate-free view in front of the index for no gain.
Only `collection_list` wants the figure, and it already builds its own SELECT list, so it
picks the fragment: `e.deck_count` on, `NULL AS deck_count` off. The other six readers never
select it.

### 2a. Two shapes of the same rule

`source` above is the **grouped row source**, and only the two commands that list whole rows
need it — `collection_list` and `collection_summary`. The other readers ask a narrower
question, and handing them the aggregate would be a performance mistake rather than a tidy
one: `search.rs:922` sits inside a correlated subquery over a 116 000-row table, and a
correlated read of a `GROUP BY` recomputes the whole deck sum once per candidate row.

So `collection_source.rs` owns the rule once —

```rust
/// The whole of "what the reader owns", as a predicate. Every shape below is built from it.
pub const LIVE: &str = "dc.variant = 'live'";
```

— and presents it in two shapes:

- **The grouped source** (`source`), above.
- **Direct-read fragments** for the five correlated readers, which in the derived branch go
  straight at `deck_cards` with no `GROUP BY`: `EXISTS (SELECT 1 FROM deck_cards dc WHERE
  dc.card_id = c.id AND dc.variant = 'live')` for the Owned chip, and the matching
  `sum(dc.quantity)` forms for the badge, the wishlist, the import ranking and the theory
  spare. `idx_deck_cards_card` (`schema.rs:1450`) covers them, and it is the same index the
  table branch's `idx_collection_card` is.

One rule, one file, two shapes — and a test that the two shapes agree on the same database,
because two spellings of one rule is exactly how this drifts.

### 3. The seven readers

Every SQL site that asks "what does the reader own" takes the swap, each in whichever of §2a's
two shapes fits the question it asks:

| Site | What it feeds | Shape |
| --- | --- | --- |
| `collection.rs:895` (`FROM`) | the Collection page's list and summary | grouped |
| `search.rs:716`, `:718` | the Owned / Missing chip | direct `EXISTS` |
| `search.rs:922`, `:938` | the owned badge on every search tile | direct `sum`, by oracle id when collapsed and by printing when not |
| `index/mod.rs:291` (`rebuild_owned`) | the `owned` / `missing` facet counts | direct `DISTINCT` |
| `wishlist.rs:153` (`OWNED_SQL`) | wishlist fulfilment and the Fulfilled filter | direct `sum`, printing **and** finish |
| `import.rs:296` (`MATCH_COLUMNS`) | **which printing an import resolves to** | direct `sum` by printing |
| `deck_theory.rs:209` (`OWNED_SPARE_SQL`) | the theory shopping list's "Already owned" | direct `sum`, minus built decks (§6) |

`collection.rs:895` is a `const` and becomes a function of the connection; the rest are `const`
strings or inline fragments built the same way. Note the two that carry a finish: the wishlist
narrows by printing *and* finish (never condition), and the theory spare groups on it — both
need `coalesce(dc.finish, 'nonfoil')` on the derived side, exactly as §5's tooltip command
does.

**`images.rs:1401` (`prewarm_keys`) needs no change** — its UNION already reads `deck_cards`
alongside `collection_entries`, so a deck-driven collection's images were already being warmed.

**`invalidate_owned` must fire on deck writes too.** Today it runs only after a collection
write: `collection::with_write_owned` (`collection.rs:679`) is `sync::with_write` plus the
invalidation, and every deck command uses bare `sync::with_write` instead (`deck.rs:3611`
onward, `deck_meta.rs:1808` onward). While the switch is on, the owned dimension moves
whenever a live deck row moves, so the search Owned facet would otherwise keep answering from
before the edit with nothing on screen to notice.

The fix is a wrapper, not 21 scattered calls: `with_write_owned` moves out of `collection.rs`
into `collection_source.rs` as a neutral helper whose invalidation is **conditional** — it
always invalidates after a collection write, and after a deck write only when
`deck_driven::stored` is true. The deck write commands that change `deck_cards.quantity`,
`.variant` or `.card_id` are then routed through it. That set is enumerated in
`docs/reference/decks-storage.md` and the plan lists it explicitly; the three easy to miss are
the theory move in `update_deck` (`deck.rs:1051`), `deck_undo`'s `Op::Variant`
(`deck_undo.rs:731`), and `reconcile::merge_deck_cards` (`reconcile.rs:337`) — the last of
which is not a command at all and takes an explicit call at the end of the reconciler's sweep.

A test asserts the routing rather than trusting it: for each of those commands, a write with
the switch on must move the owned facet count.

### 4. Writes refuse in Rust, not only in the UI

**This is a safety requirement.** The derived `id` is a `deck_cards.id`. `collection_remove(id)`
and `collection_set_quantity(id, n)` address `collection_entries` by primary key, and the
reader's hidden hand-built rows are still on disk — so a stray call carrying a derived id
would delete or rewrite an unrelated row the reader cannot see. A UI that merely greys the
button is not a fence.

So, while `deck_driven::stored(&conn)` is true, these five refuse with one named constant
(`collection::DECK_DRIVEN`, worded for a person: _"Your collection is driven by your decks.
Turn the setting off in Settings to edit it by hand."_):

`collection_add`, `collection_set_quantity`, `collection_update`, `collection_remove`,
`collection_import_commit`.

`reset::collection_clear` **stays allowed**. It is the Danger Zone, and throwing away the
hidden hand-built rows is a legitimate thing to want; `DangerZonePanel`'s sentence gains a
clause saying the collection it clears is currently hidden behind the setting.

The matching UI affordances are disabled with that reason rather than hidden — this app
already greys a menu row and puts the reason in its accessible name, and a vanished control
reads as a bug while hiding the setting that caused it:

- `AddToCollection.tsx` — the popup's Collection arm (its Wishlist arm is unaffected).
- `useCardMenuDeps.ts:71` — the card context menu's Collection submenu.
- `CollectionPage.tsx:251`, `:273` — the table's quantity stepper and row delete.
- `transfer/import/destinations/CollectionPreview.tsx:62` — the "collection" import
  destination, refused at the destination picker so the reader learns before building a plan.

### 5. The Collection page in this mode

- **A line at the top of the page** saying the collection is driven by the reader's decks,
  with a link to the setting. It is how somebody who forgot the switch finds it again.
- **The Condition chip group is hidden** and the third column's header shortens from
  `Finish · condition` to `Finish`, the cell showing the finish alone. A Condition filter over
  rows with no condition can only match everything or nothing, and an em dash on every row of
  a collection is noise rather than information.
- **The Actions column carries the provenance.** It loses its only control (row delete) in
  this mode, and the question a reader has about a derived row is _which decks is this in_. It
  draws `deck_count` as `"3 decks"`, with a tooltip listing deck names and copies fetched
  lazily on hover by a new command:

  ```rust
  #[tauri::command(async)]
  collection_row_decks(card_id: String, finish: String, lang: String)
      -> Vec<RowDeck>   // { deck_id, deck_name, quantity }
  ```

  Lazy per row rather than joined into the page, because a 100-row page would otherwise carry
  several hundred deck names nobody looks at. **The `finish` argument is the collection's
  spelling and has to be translated back**: the row says `nonfoil` and the table stores NULL,
  so the predicate is `coalesce(dc.finish, 'nonfoil') = ?2` — the same expression the derived
  source groups on, for the same reason. Ordered by deck name, and `live` only, so the tooltip
  and the number above it can never disagree.
- **The empty state** says the collection is deck-driven and there are no decks yet, rather
  than the manual mode's "nothing added".
- **The summary's tradelist figure is hidden** — it can only read 0. The other six aggregates
  are all meaningful: `value` and `unpriced` are the same sums over the same price join,
  `needs_review` still counts, and `unique_cards` / `entries` differ from each other in this
  mode exactly as they do in the other (a foil and a regular copy are two entries of one card).

### 6. The allocator, and the four other "owned" numbers

`deck_allocations.collection_entry_id` is a hard FK into `collection_entries(id)`
(`schema.rs:1109`). Derived rows have no such ids, and the ledger would be circular anyway —
every deck would claim copies it itself contributed. So while the switch is on:

- **`allocate_deck` (`deck.rs:3381`) writes nothing** and returns early. Existing rows are left
  alone rather than deleted: switching back off must find the ledger as it was.
- **`attribute_owned` (`deck.rs:3326`) reports `owned_quantity = quantity`** for every `live`
  row, so no live deck card ever draws the short mark. That is not a fudge — under this
  setting it is true by construction.
- **`missing_to_wishlist` (`deck.rs:3502`)** therefore finds nothing missing on a live list and
  writes no wishes. The theory route (`deck_theory_missing_to_wishlist`) is unaffected and is
  the one that still means something.
- **`deck_theory`'s "Already owned"** reads derived copies minus copies sitting in **built**
  live decks. `is_built` keeps its job: a card in an unbuilt deck's live list is still
  available to a plan, and a card in a sleeved-up deck is not.

The remaining owned numbers need no special handling beyond §3's source swap: the search
badge, the search facet, wishlist fulfilment and import match ranking all read the derived
sum and stay consistent with the Collection page by construction.

### 7. The frontend seam

- `src/lib/useDeckDrivenCollection.ts`, from `useNavCollapsed.ts` — a query with
  `staleTime: Infinity`, an optimistic `setQueryData`, and (unlike the nav rail's) a surfaced
  refusal: this switch changes what the reader's data looks like, so a silent failure is worse
  than a rail's.
- The flag joins `useCollection.ts`'s `filterKey` (`useCollection.ts:212`, `:244`) exactly as
  `marketplace.id` does, so a flip refetches both the list and the summary rather than serving
  the other mode's cache.
- A flip invalidates `["collection"]`, `["cards","search"]`, `["decks"]` and `["wishlist"]` —
  the same four keys `AddToCollection.tsx:161` already fires, because the same four surfaces
  move.

### 8. The Storybook fake

`.storybook/fake/db.ts` gains a plain `deckDrivenCollection: boolean` on `FakeDb` (following
`navCollapsed`, which is the only non-nullable one of the five, for the same reason: the
backend cannot produce a third state), a `false` default in `makeDb`, a read handler, and a
write handler that calls `refuseIfBusy` — `db.test.ts` sweeps every write handler asserting a
running sync can refuse it.

The fake's `collection_list`, `collection_summary`, `cards_search` owned fields,
`wishlist_list` owned fields and `deck_get` owned fields must all honour the flag, or
Storybook draws a wall the app would never draw.

## Error handling

- **Reading the setting cannot fail.** `stored` swallows everything into `false`, so a
  corrupt row degrades to the manual collection rather than to an error page. That is the
  right floor: the reader's hand-built rows are still there.
- **The five refused writes** answer one named constant, surfaced the way `GONE` and `ZERO_ADD`
  already are. They are refusals, not errors: nothing is retried and nothing is logged.
- **A reader with no decks** gets an empty collection and a sentence saying why, not an error.
- **A deck row whose printing has left Scryfall** carries `needs_review` through the `max()`
  and lands in the page's existing flagged-rows banner. The `LEFT JOIN cards` in
  `collection.rs:895` already tolerates the orphan, and `paper_only` is already forced off
  there (`collection.rs:926`) for exactly this case.
- **The switch flipping while a query is in flight** is a stale answer, not a wrong one: the
  flag is in the query key, so the in-flight response lands in the other mode's cache slot and
  the current one refetches.

## Testing

**Rust** — the derived source is where the risk is, so most tests are there:

- The sum: a card in two decks reads as two copies; a card in one deck twice (two categories)
  reads as one row with the sum.
- `variant`: theory rows are excluded; a deck with `theory_enabled = 0` is counted in full;
  a deck whose live list was moved into theory contributes zero.
- Categories: an inactive category's cards **are** counted — the one place this feature
  deliberately departs from `allocate_deck`'s rule.
- Archived decks are counted.
- Finish: a NULL deck finish reads `nonfoil`; a foil row and a regular row of the same
  printing are two rows and do not fold.
- `lang` is part of the grain.
- The five writes refuse while on and succeed while off, and **the hidden rows are byte-for-byte
  unchanged after a flip on and back off** — the guarantee the whole "preserve" decision rests on.
- Each of the seven readers agrees with the Collection page: same card, same number, in both
  modes.
- `allocate_deck` writes nothing while on and leaves existing rows; `attribute_owned` reports
  full coverage on live rows; the theory spare still subtracts built decks.
- `deck_driven` module: the `"0"` write, the junk-row fallback, the round trip.

**TypeScript** — the panel toggles and surfaces a refusal; the Collection page hides the
Condition chips, shortens the header, draws the deck count, and disables the stepper, the
delete, the add popup and the import destination each with its reason in the accessible name.

**Storybook** — a seed with the switch on, so the deck-driven wall and its disabled controls
are a story rather than only a test.

**The real window** — a CDP pass per `docs/reference/live-ui-verification.md`: flip the switch
with decks present, confirm the Collection page changes without a restart, confirm the search
Owned chip and the deck editor's short marks agree, flip it back and confirm the hand-built
rows return.

## Out of scope

- **A holding area for cards removed from live decks** — the follow-up comment on issue #168.
  It needs its own answers (is it a deck? does it count toward the collection? how does a card
  get in and out?) and would double this change. It gets its own issue, and the PR comment
  says so. A reader can already make a deck called "Binder", keep its cards live, and have
  exactly that behaviour today.
- **Condition, purchase price or acquisition data on a deck card.** Twelve of
  `collection_entries`' columns have no source in `deck_cards`. Giving deck cards a condition
  is a different feature with its own question about what happens to the four other places a
  deck row is written.
- **Per-deck ownership.** Copies are pooled: three decks each running a Sol Ring means three
  Sol Rings. There is no "these are the same physical card" concept and this change does not
  invent one.
- **Making the allocator work against derived rows.** §6 skips it; a version that allocates
  deck cards to each other is a different design.

## Documentation to update in the same change

| Doc | What it gains |
| --- | --- |
| `docs/reference/decks-storage.md` | the allocator's early return and `attribute_owned`'s full-coverage branch, beside the existing variant-fence note |
| `docs/reference/data-and-sync.md` | `app_meta`'s sixth key |
| `docs/reference/deck-driven-collection.md` (new) | the source swap in full — the subquery, the seven readers, the five refusals, and what a derived row cannot carry |
| `src-tauri/CLAUDE.md` | the rule: any new "what does the reader own" query builds its FROM through `collection_source::source`, never from the table name |
| `CLAUDE.md` (root) | one row in the reference-docs table |
| `.storybook/CLAUDE.md` | the new fake field, if the fake's settings list is enumerated there |
