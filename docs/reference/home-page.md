# The home page

The app's landing view, [issue #448](https://github.com/Msgaihede/mtg-grimoire/issues/448). The
design is
[2026-09-10-home-page-design.md](../superpowers/specs/2026-09-10-home-page-design.md); this page
is the record of what shipped, with the reason at each site. Every figure keeps the date and the
build it was taken on, and every count below names the command that answers it.

The short version: **`ViewId` gains one member, `app_meta` gains two keys, the schema gains one
table, and nothing else about the app changes.** The home page is a document the reader owns and
six widgets that read commands the rest of the app already had, plus one it did not — a global
activity feed. The single load-bearing rule is that the *vocabulary* of widgets lives in
TypeScript and only the *shape* of the document lives in Rust, which is what lets two builds of a
portable app share one database without either quietly emptying the other's page.

---

## 1. The layout document

One `app_meta` row, `home_layout`, per device. `app_meta` has been the application's key/value
table since user schema v6, so **there is no migration** — this is a key in it, and
`src-tauri/src/home.rs` is the module that owns the key.

```ts
interface HomeWidget { id: string; kind: string; span: 1 | 2; config: unknown }
interface HomeLayout { version: 1; widgets: HomeWidget[] }
```

`home.rs` refuses, in this order and **all of it before `app_meta` is touched**: a `version` that
is not `1`; an `id` or a `kind` that is blank after `trim`; a `span` outside `MIN_SPAN..=MAX_SPAN`
(1 to 2); and a serialized document over `MAX_BYTES`, 64 KiB. On the read side there is nothing to
refuse: a missing row, a row that is not JSON, a row holding an array or a bare string, a document
whose `widgets` is a number — every one reads as the default layout, and `stored` is **infallible
by signature** for `nav::nav_collapsed`'s reason.

64 KiB is not a limit the table needs. `app_meta` already carries `update_release_history` at
201 550 bytes (measured 2026-09-10 out of the live debug `user.db`, spec §1). The cap is about
what a *layout* can honestly be: anything over it is a `config` being used as a document store or
a bug minting widgets in a loop, and neither should be discovered as a database that will not fit
in memory.

### The vocabulary is TypeScript's, and the round trip is the feature

`kind` is a free `String` and `config` is an opaque `serde_json::Value`. Nothing in `home.rs`
compares a stored kind against anything — the six spellings in its `DEFAULT_LAYOUT` table are the
*seed a first launch gets* and are used for nothing else. That is `markcolors.rs`'s split at its
widest, and its rule verbatim: **a write preserves entries this build does not understand.**

The promise is that **a widget kind a newer build wrote survives a round trip through an older
one**, and three files each keep a third of it. Break any one and the other two are decoration:

| Where | What it does | What it must not do |
| --- | --- | --- |
| `src-tauri/src/home.rs` | stores and returns `kind` and `config` untouched; validates shape only | grow an enum, an allow-list, or a `kind` check |
| `layout.ts`'s `parseLayout` | keeps an entry whose `kind` this build cannot draw, drops only an entry that is not a widget at all | filter on `isWidgetKind` |
| `HomePage.tsx`'s `renderWidget` `default` arm | draws `UnknownWidget` — a card saying where the widget came from, with its full edit tray | throw, or return `null` |

`widgets.ts` says the same thing from the other side: **`isWidgetKind` is a renderer's question and
never a parser's.** The placeholder keeps its remove, width and grip on purpose — a widget this
build cannot draw is the one a reader is most likely to want to move or take off the page.

What follows from `config` being opaque is the rule for extending a widget: **a new per-widget
setting goes in `config`, never in a fifth field beside it.** `config` survives every build; a new
field on `HomeWidget` is dropped by every build that predates it.

Reading and writing answer the version question the **other way round**, deliberately.
`stored` hands back whatever parses, `version` included, because the widgets in a newer document
are exactly what an older build must not lose. `store` refuses a version it does not write, **in
words**, because rewriting a document by rules that do not apply to it is how a newer build's page
comes back wrong with nothing logged anywhere.

**The document is this device's.** `app_meta` is not in `schema::SYNCED_TABLES`, which is
`markcolors.rs`'s stated rule for every stored preference in this app: a home page is a fact about
the screen in front of the reader, not about the collection.

### The landing view is the second key

`src-tauri/src/startview.rs`, key `start_view`, is `nav.rs`'s module with a word instead of a bit
and the same two rules — reading can never fail, writing validates only what Rust can validate.
Rust stores a non-empty trimmed word and checks nothing else, because the vocabulary of *views* is
TypeScript's for `listview.rs`'s reason. `useStartView` (`src/lib/useStartView.ts`) checks the
stored word against `ViewId` and falls back to `"home"`, so a downgrade to a build without some
view does not strand a reader on a page that no longer exists. A Rust-side allow-list would have
made every new view a Rust change *and* refused the downgraded reader's row on read with nowhere
to say so.

## 2. An empty widget list is a layout, not a missing row

This is the read rule's one edge and the one a `unwrap_or_default` gets wrong. "No widgets" and
"no row" are the same value to a defaulting parse, so a reader who cleared their home page would
be handed the six defaults back on every launch, for ever, with nothing on screen to show they had
ever chosen. **Only an absent row and an unparseable one are the default**;
`{"version":1,"widgets":[]}` is an answer and is kept.

`home::tests::an_empty_widget_list_is_a_layout_and_not_a_missing_row` pins the Rust half and
`layout.test.ts`'s *"keeps an empty widget list rather than restoring the default"* pins the
webview's, because both sides have a fallback and either alone would undo the reader's choice.

## 3. The six widgets

The default layout, in order, is `summary` (span 2), `decks`, `activity`, `collectionValue`,
`wishlistValue`, `folders` (span 2). **A kind may appear more than once** — the `id` identifies a
widget, so two `decks` widgets pinning two sets of decks is a layout to build rather than a case to
refuse, and `newWidgetId` mints an id that does not collide.

| `kind` | draws | `config` |
| --- | --- | --- |
| `summary` | copies and value across the collection, the decks and the wishlist; each figure is a press that opens that view | — |
| `decks` | pinned deck shortcuts — cover art, format, card count, value; empty config falls back to the most recently updated | `{ deckIds }` |
| `folders` | pinned collection and wishlist folder shortcuts with their counts and value; empty config falls back to the top-level drawers the reader made | `{ collectionFolderIds, wishlistFolderIds }` |
| `collectionValue` | the collection's total, its unpriced note, and bars along one dimension | `{ dimension }` |
| `wishlistValue` | the same over the wishlist — a separate component, because the two lists' empty states and notes differ | `{ dimension }` |
| `activity` | recent actions grouped by local calendar day, each day headed by its `+7 / −6` roll-up | `{ limit }` |

`DEFAULT_LAYOUT` exists in `home.rs` and in `widgets.ts`, **one fact in two places**, and the Rust
one is what a first launch actually gets: `home::stored` answers it for a missing row long before
the webview is loaded. The TypeScript copy is what `parseLayout` falls back to and what **Reset**
writes. `widgets.test.ts` pins its half against a literal so the two cannot drift silently.

Two smaller rulings, each written at its site so it is a decision rather than an oversight:

* **`FoldersWidget` offers the app's own folders and labels them.** A `deck`-kind folder is a
  deck's group and `removed` is the single `Recently removed` holding area; every folder *picker*
  in this app offers `user` and only `user`, because a picker chooses somewhere to write and those
  two refuse every write in words. A shortcut is not a destination, so both are worth pinning —
  but the tile says which it is in words as well as with a glyph.
* **Neither value widget uses `BarChart`.** Both draw with `Track` and `percent` from
  `features/decks/stats/StatsCard.tsx`, because `BarChart` prints an integer count on each bar and
  hardcodes its spoken noun to *"n cards"* — and these bars are money. Two agents reached that
  conclusion independently and landed on the same import, which is the outcome shared primitives
  exist to produce.

### The query keys sit under the roots the data already lives under

`src/features/home/keys.ts` is the whole list, and the rule is that a key sits under
`["collection"]`, `["wishlist"]` or `["decks"]` — the roots every write in this app already
invalidates. The dashboard therefore refreshes after an add, a move, a rename or a removal with
**no mutation anywhere learning a new key**, where a `["home", …]` root would have needed every one
of those writes to grow a line and a `staleTime` would have hidden whichever was forgotten.

**The one exception is `activityKey`**, under `["activity"]` — a root nothing invalidates, because
there is no activity mutation: the feed is a record of every *other* table's writes.
`ActivityWidget` bridges it itself, and **both halves are load-bearing**: it subscribes to the
query cache and turns an `invalidate` action under any of the three write roots into an
invalidation of its own key, *and* it holds a marker query under each root so the signal exists at
all — `invalidateQueries` dispatches nothing when it matches no cached query.

## 4. The grid is flex-wrap, and deliberately not a container query

`flex flex-wrap items-start gap-3`, each widget `min-w-[22rem] flex-1` (`WIDGET_CARD_BOX`), a
`span: 2` widget `basis-full` (`WIDGET_CARD_WIDE`). Both are whole class strings and never a width
computed from `span`, because Tailwind scans source *text* and an interpolated class emits no rule
at all.

**`container-type: inline-size` applies layout containment, which makes the box the containing
block for every `fixed` descendant** — and these widgets open anchored popovers, context menus and,
through them, dialogs whose scrim is a bare `fixed inset-0` that corrects for nothing. A container
here would reparent them, which is the bug `layers.ts` was written about. The precedent is
`src/features/decks/DeckStats.tsx:871-874`, which refuses a container over its own two columns in
the same words and for the same reason; this page's refusal is the second, not the first.

**The consequence, stated rather than hidden: *where* a widget appears is an order and a width, not
a free position.** There is no grid to drop a card into and no empty cell to leave. That is the
whole of what the refusal costs, and §9 lists it again as something this feature does not do.

The page also does **no arithmetic about position**. `useWidgetDropTarget` reports which widget was
dragged and which edge of this one it was let go on, and `moveWidget` takes exactly that pair — an
index worked out on the page would be an index into the list *before* the dragged widget was lifted
out of it, and one too high for every forward move. The grip's arrow keys go the same way, turning
a delta into a neighbour's id and an edge, because `dndManager` ships no `KeyboardSensor` and a
reorder that was only a drag is a rearrange half the readers do not have.

## 5. The activity log

Schema **v44** (§9 is why it is not v43), one table and one index, in `main`:

```sql
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('collection','wishlist')),
  kind TEXT NOT NULL CHECK (kind IN ('add','remove','quantity','move','edit','folder','import','clear')),
  card_id TEXT,
  card_name TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_activity_recent ON activity (at DESC, id DESC);
```

**`deck_audit`'s design, copied deliberately.** Rust records *what happened* — a kind, a card, a
JSON payload of facts and a signed copy delta — and TypeScript writes the sentence, because a
sentence is domain logic: it changes with the wording and with the reader's language, and a table
that stored one would be a table full of the phrasing of whichever release wrote each row.
`src/features/home/activityText.ts` is the **only** reader of `payload`; `activity.rs` stores it
verbatim, hands it back byte for byte, and never parses, branches on or knows what a key in one
means. Rewording a line is therefore not a migration, and a second language stays possible.

`activity_recent(limit)` is one `SELECT` over a `UNION ALL` of `activity` and `deck_audit`, ordered
`at DESC, id DESC` and clamped to `1..=500`. Two things about it are written down at the site
because a later reader would otherwise "fix" them:

* **The `id`s collide across the two tables, and that is fine.** Nothing joins on them and the
  frontend keys a feed row on `scope` **plus** `id`, which is unique because the scope says which
  table the row came from. Offsetting, hashing or adding a synthetic key each makes the id stop
  being the row's own id, which is the only thing it is good for.
* **`id DESC` after `at DESC` is not decoration.** `unixepoch()` has one-second resolution and a
  single press can write two rows inside it; without the tiebreaker the order inside a second is
  whatever the planner felt like, which is the one ordering a reader would notice and could not
  explain.

The clamp's **low** end is the load-bearing one: SQLite reads a negative `LIMIT` as no limit at
all, so a `0` arriving from a page that had not finished loading its config would otherwise be a
full read of every change the reader has ever made.

Day grouping is `auditDays`, **reused and not re-derived** — days are *local* calendar days, and
slicing them off an ISO string files a change made at 23:30 under tomorrow, which this repo has
already got wrong once. A `scope === "deck"` entry delegates to `auditLine`, so a deck line reads
identically here and in the deck history dialog.

### The three rules, because each is a way to get this wrong

* **A change that already writes a `deck_audit` row writes no `activity` row.** One event, one
  line — which is what keeps `collection_alloc`'s deck-boundary writes out of the feed twice. The
  table's own `CHECK (scope IN ('collection','wishlist'))` makes it unbreakable: there is no
  `'deck'` scope to write, because a deck line **is** a `deck_audit` row and `recent` reads it from
  there under a scope the query stamps.
* **A bulk operation records one row carrying its count in the payload.** An import of 5 000 cards
  must not write 5 000 lines — that is a feed nobody can read and a table that grows by a megabyte
  a session. `collection::commit_import`, `wishlist::commit_import`, both `missing to wishlist`
  paths and `reset::clear_collection`/`clear_wishlist` each record exactly one. The bulk pair is a
  **quiet door and a recording door** over one write: `wishlist::add_wish_silent` performs the
  change and `wishlist::record_wishes_added` writes the single line for the run, and a run of
  nothing records nothing.
* **It is pruned at launch.** `activity::prune` runs from `maintenance.rs` and keeps the newest
  `KEEP = 5 000` rows. `deck_audit` has never needed a pruner because a deck a person has actually
  built is hundreds of rows; a collection log is not bounded that way. The `NOT IN` in the pruner
  is safe *here* — `activity.id` is `INTEGER PRIMARY KEY`, so it is the rowid and never NULL — and
  the site says so, because `NOT IN` over a set containing NULL is true for nothing and is a real
  footgun elsewhere in this crate.

`record` takes `&Connection` and **never opens a transaction of its own**, so every caller records
inside the transaction of the change it describes; `Transaction` derefs to `Connection`, so
`record(&tx, …)` is the call at every site. An activity row that committed while its change rolled
back is a history that lies in the one direction a reader cannot check — the row it names is not
there to disagree with it. `collection::tests::a_rolled_back_change_leaves_no_activity_row` and
`wishlist::tests::a_rolled_back_wish_leaves_no_activity_row` are the fences.

### The write-site census

**A missed write site is a silent gap in the feed, not a red build**, so the census is a
deliverable rather than a hope. Every statement in the crate that writes `collection_entries`,
`wishlist_entries`, `collection_folders` or `wishlist_folders` is accounted for as exactly one of
three things.

Counted 2026-09-10 on the merged tree at `64d9d709`: **61 production statements across 34
functions in 10 files** (`python` sweep over `src-tauri/src/**.rs`, matching
`(INSERT [OR …] INTO|REPLACE INTO|UPDATE [OR …]|DELETE FROM)\s+<table>` and excluding every
`#[cfg(test)] mod` and every `tests.rs`). **22 record, 6 are already logged, 33 are a
consequence** — with `add_entry_filed` counted under *records* and appearing in the table under
both, because one statement genuinely has two doors and the class is a property of the press, not
of the SQL.

⚠️ **The sweep as the plan wrote it reported 57, and the four it missed are why the pattern above
carries the `OR` arms.** `grep "UPDATE collection_entries"` does not match `UPDATE OR IGNORE
collection_entries`, which is `collection::PATCH_SQL` — the statement behind `update_entry`, a
recording site — and `reconcile::merge`'s two repoints. The feed was not wrong; the *count* was,
and a grep that cannot see a conflict clause is a census that silently under-reports.

| File · statement site | stmts | class | note |
| --- | --- | --- | --- |
| `collection.rs` · `add_entry_filed` | 1 | records **and** already logged | one write, two doors: `add_entry` records `collection/add`; `deck_quick_add::quick_add` reaches past it and writes `deck_audit` instead |
| `collection.rs` · `set_entry` | 1 | a consequence | `commit_import`'s per-line write; the file records one row |
| `collection.rs` · `set_quantity` | 2 | records | `quantity`, or `remove` when the step lands on zero and the row goes |
| `collection.rs` · `PATCH_SQL` (`update_entry`, both paths) | 1 | records | `edit`, through `record_edit`; `delta` is `0` even when the patch names a quantity — an edit form is not a stepper |
| `collection.rs` · `delete_entry` | 1 | a consequence | `remove_entry` without the feed row; the import's zero arm reaches it so a file does not write a line per zeroed row |
| `collection.rs` · `fold_entry` | 2 | a consequence | the grain collapsing two rows into one; all three callers record their own event |
| `collection_folders.rs` · `create_folder` / `rename_folder` / `delete_folder` | 3 | records | one `collection/folder` line each, through `record_folder` |
| `collection_folders.rs` · `set_folder_locked` | 1 | a consequence | a lock changes what the app offers from a drawer, not what drawers exist or what is in them |
| `collection_folders.rs` · `move_folder` | 1 | a consequence | re-parenting a drawer changes no card and no folder's existence |
| `collection_folders.rs` · `reorder_folders` | 1 | a consequence | a line per folder moved would be the whole day's page |
| `collection_folders.rs` · `refile_entry` | 1 | a consequence | the shared move; `set_entry_folder` is the recording door and writes `collection/move` |
| `collection_folders.rs` · `take_copies` | 2 | already logged | both callers are deck-boundary writes that record a `deck_audit` row for the same press |
| `deck.rs` · `create_deck_group` | 1 | a consequence | a deck's group folder follows the deck existing |
| `deck.rs` · `update_deck` | 2 | a consequence | the group wears the deck's name, and going Virtual takes it away |
| `deck_missing.rs` · `take_lone_wish` | 2 | already logged | filling a deck's hole from the wishlist is a deck press |
| `deck_quick_add.rs` · `take_wish` | 2 | already logged | as above |
| `reconcile.rs` · `merge` | 2 | a consequence | Scryfall's migration log applied against the reader's rows — derived from the corpus, and the whole pass runs under `capture::Suppressed` |
| `reconcile.rs` · `fold_wish_into_existing` | 2 | a consequence | the wishlist half of the same pass |
| `reset.rs` · `clear_collection` | 4 | records | **one** `collection/clear` for the wipe, and it does not clear the feed: history outlives the rows |
| `reset.rs` · `clear_wishlist` | 2 | records | one `wishlist/clear`, same rule |
| `schema.rs` · `migrate_single_file` | 6 | a consequence | a migration; nobody pressed anything |
| `schema.rs` · `migrate_user` | 7 | a consequence | as above, including v29's `sync_uid` backfills |
| `wishlist.rs` · `insert_wish` | 1 | records | `add_wish` records `wishlist/add`; `add_wish_silent` and `commit_import` reach the same write and record once for the run |
| `wishlist.rs` · `write_wish_quantity` | 1 | records | through `set_wish_quantity` — `quantity`, or `remove` at zero, because `quantity > 0` is a table CHECK |
| `wishlist.rs` · `delete_wish` | 1 | records | through `remove_wish` |
| `wishlist.rs` · `set_printing_inner` | 3 | records | `set_wish_printing` is the wrapper and where the `edit` line is written |
| `wishlist_folders.rs` · `create_folder` / `rename_folder` / `delete_folder` | 3 | records | one `wishlist/folder` line each |
| `wishlist_folders.rs` · `move_folder` | 1 | a consequence | the collection's rule, mirrored |
| `wishlist_folders.rs` · `reorder_folders` | 1 | a consequence | as above |
| `wishlist_folders.rs` · `refile_wish` | 3 | a consequence | `set_wish_folder` is the recording door and writes `wishlist/move` |

The payload shapes are the contract between each recording site and `activityText.ts`, and nothing
in Rust is a party to them: `add` carries `{ folder, finish }`, `quantity` carries `{ from, to }`,
`move` carries `{ from, to }`, `edit` carries `{ fields }`, `folder` carries
`{ action, name, from }`, `import` carries `{ cards, rows }` and `clear` carries `{ cards }`.
`delta` is signed copies and is `0` wherever the change is not about copies.

### It is not synced, and that is an asymmetry rather than an oversight

`activity` is **not** in `schema::SYNCED_TABLES` and carries no `sync_uid`. `deck_audit` **is** —
so in a paired group the deck lines in the feed arrive from every device and the collection lines
are this one's. Teaching the sync capture layer a new table means a `sync_uid`, a capture trigger
and a place in [sync.md](sync.md) §7.3's five rules, and an append-only log is the shape those
rules have the least to say about. Recorded as a known consequence and a follow-up.

The rung's own DDL carries that sentence as a comment, so the next reader of `schema.rs` meets the
decision at the table rather than in this file.

## 6. The nine commands, on both targets

Each goes **in the module its data lives in, with the gate on the wrapper** — `search.rs` is the
pattern — and **each is routed on the web target as well**, because every one is a synchronous,
connection-only query, which is exactly what `web::route` answers.

| Command | Module | Answers |
| --- | --- | --- |
| `home_layout` / `set_home_layout` | `home.rs` | the layout document |
| `start_view` / `set_start_view` | `startview.rs` | the landing view |
| `wishlist_summary` | `wishlist.rs` | `{ wishes, copies, cost, unpriced }` |
| `collection_breakdown` | `collection.rs` | `[{ key, name, cards, value }]` |
| `wishlist_breakdown` | `wishlist.rs` | the same shape |
| `deck_values` | `deck.rs` | `[{ deckId, value, unpriced }]` — every deck, one query |
| `activity_recent` | `activity.rs` | the union feed |

Registration is three places, and a command missing from one of them answers `unknown command` at
runtime with nothing red: `lib.rs`'s module map, `desktop.rs`'s `generate_handler!` list, and
`web::route`'s `COMMANDS` **plus** a `match` arm.

Four rules the money commands keep, each of which exists because breaking it produces a number
that is wrong and looks right:

* **`wishlist_summary` is `wishlist_folders`' `folder_summary` SQL with the `GROUP BY` and the
  `WHERE w.folder_id IS NOT NULL` removed** — the second is what keeps root-level wishes out of a
  folder tile, and a list total that inherited it would be wrong by exactly the root. One
  expression, not two: a folder's subtotal and the page header's total have to be one piece of
  arithmetic.
* **Both breakdowns group over `sorting::price_expr`**, the same fragment `collection_summary`
  uses, so a breakdown can never disagree with the total printed above it. `cards.price_usd` and
  `price_eur` are a display fallback chain and are never summed.
* **`color_identity` is a string of letters and not a JSON array.** `card_row.rs` writes `["W","U"]`
  as `"WU"` and `filters.rs` reads it with `instr`, so the colour bucket is a `length()`: one
  letter keys on that colour, more than one keys `multi`, empty keys `c`. A `json_array_length`
  there answers NULL on every row, files the whole collection into one bucket — **and the sums
  still add up**, which is exactly why it is written down rather than left to be rediscovered.
* **`deck_values` filters to the same cards `cardCount` counts** (`variant = 'live'`, active
  categories, `kind IN ('main','commander','maybe')`) so a deck's count and its value describe the
  same pile, and a deck with nothing priced answers `null` rather than `0` — a tile has no room for
  the header's "n unpriced" note, so a deck of cards the feed has never heard of would otherwise
  read as a deck worth nothing.

## 7. The chord renumbering

`NAV` gains `{ id: "home", label: "Home", Icon: House }` **as its first entry**, and `CHORD_NAV` is
built exactly as before — `NAV` minus `shared` — so inserting at the head shifts every digit:

| chord | before | after |
| --- | --- | --- |
| `Ctrl+1` | Search | **Home** |
| `Ctrl+2` | Tagger | Search |
| `Ctrl+3` | Decks | Tagger |
| `Ctrl+4` | Collection | Decks |
| `Ctrl+5` | Wishlist | Collection |
| `Ctrl+6` | Scanner | Wishlist |
| `Ctrl+7` | Trade | Scanner |
| `Ctrl+8` | Playtesting | Trade |
| `Ctrl+9` | **Settings** | Playtesting |
| — | Shared | Shared, **Settings** |

**Two destinations now go without a chord, for two different reasons**, and reading them as one
rule is how a later edit puts the wrong one back:

* **`shared` goes without because its row is conditional.** It appears only once a reader has
  opened a link, and a digit bound to a row that appears and disappears would mean two things to
  two readers. That is a reason no amount of room would change — a twelfth digit would not buy this
  entry a chord.
* **`settings` goes without because the run ends before it.** Eleven rows against nine digits, and
  Home belongs at the top: it is the page the app opens on, and a reader reads a column downward,
  so a landing page anywhere but the first row is a page the reader is standing on and cannot find.
  Settings is the row that costs least — it is drawn on every screen at a fixed place, where
  `shared` can be absent altogether. **Give this run a tenth digit and Settings takes it back.**

`Ctrl+9` no longer opens Settings. That is a deliberate, breaking change to a binding readers have
in their fingers, and it belongs in the release note as one. `nav.test.ts` pins the ninth entry and
the absence of `settings` from the run, so a merge cannot quietly put the old numbering back.
[keyboard-shortcuts.md](keyboard-shortcuts.md) carries the record of both renumberings.

## 8. What this does not do

From the design's §9, plus two the build itself turned up:

* **No free-form placement.** A widget has an order and a width. §4 is why the alternative would
  reparent every popover on the page.
* **No cross-device activity for the collection.** §5.
* **No deck-folder shortcuts.** There is no `deck_folder_summary` command and deck folders carry no
  counts; the `decks` widget pins decks, which is what the issue asks for.
* **`StatsCard` has not moved to `src/components/`.** The widgets import `StatsCard`, `Track` and
  `percent` from `src/features/decks/stats/StatsCard.tsx`. A cross-feature import is idiomatic here
  — `CollectionPage.tsx` already imports three things from `features/decks` — and it was the
  cheaper half of a trade: the honest home for these primitives is `src/components/`, and moving
  the file while four other branches were editing the deck stats band would have been a
  delete-plus-add conflict against live work. **Still a follow-up, recorded so it stays a decision.**
* **The deck cover rule is a third copy and stays one.** `hasCover(deck)` is
  `deck.coverCardId !== null && deck.coverArtist !== null`; `DeckTile.tsx` already carries a note
  asking for a shared home, and the `decks` widget makes it three. Two lines and a comment rather
  than a figure, so the cost is style drift and not a number that can disagree with itself.
* ~~**A folder shortcut opens the view, not the folder.**~~ **Built.** This was written while it
  was still true and is kept because the *reason* it was hard is worth having: which drawer a
  reader is standing in is `useCollection`'s and `useWishlist`'s own `useState`, deliberately, so
  that a folder restored at launch cannot open the app somewhere nobody navigated to — which means
  the fix could not be "persist the open folder". It is a **one-shot hand-off** instead:
  `AppState.pendingFolder` (`{ scope, id }`), written by `FoldersWidget`'s one `openFolder`, and
  consumed *and cleared* by whichever page answers it.

  Two things about it are load-bearing. It sits **inside `setActiveView`'s clear block**, so a
  hand-off lives for exactly one view change — outside it, an unread one outlives every navigation
  and fires the next time the reader happens to open that page, opening a drawer they asked for an
  afternoon ago. The price of that is an ordering trap paid at the single call site:
  **`setActiveView` first, `setPendingFolder` second.** The inverse type-checks, reads correctly,
  and leaves the store holding nothing — the reader lands on the right page, at the root, silently.
  `store.test.ts` pins both directions, because only one of them is distinguishable from a bug.

  And the page reads it in a **render-phase adjustment rather than a mount effect** — `setFolderId`
  inside a `useEffect` body is the cascading-renders lint failure this repo has paid for twice,
  which passes `tsc` and vitest and dies only at `verify`. It also means each page reads the field
  as it *renders*, so the widget's two store writes are safe whether React batches them into one
  commit or two.
* **Six refusal sentences are unreachable from Storybook**, and this is a gap in the workbench
  rather than in the feature — each is covered by its widget's own unit test. Measured while
  writing the stories: `.storybook/fake/db.ts`'s `gone` fault is checked in exactly one place
  (`deck_get`), which the home page never calls, so a `gone` world renders byte-for-byte as
  `starter`; and `refuseIfBusy` is wired into every **write** handler and no read, which
  `activity_recent`'s own doc says outright. So every one of the six widgets' *"could not be read"*
  branches has no world that produces it. A `readGone`-style fault landing on `collection_summary`,
  both breakdowns, `wishlist_summary`, `deck_values` and `activity_recent` would make all six
  storyable at a line apiece. **What `busy` does reach is the one refusal this page can show** —
  a refused `set_home_layout`, which `WhileTheDatabaseIsBusy` presses Remove under, asserting the
  widget still leaves the page and nothing is said: the optimistic, deliberately-unrolled-back
  write `useHomeLayout` documents.

## 9. The live pass

Driven over CDP in the shipped window on **2026-09-10**, debug build, against a **copy of the real
debug database** (277 collection entries, 89 wishes, 5 decks) rather than a fresh sync — a fresh one
gives cards and an empty collection, so every widget would have drawn its empty state and the pass
would have proved nothing. Viewport 1920×1080 unless a line says otherwise.

**The v44 migration ran on a real database, which no fixture can prove.** The copied file arrived at
v43 and came back `user_version = 44` with `activity`, `deck_notes` and `deck_note_cards` all
present and the 277 entries and 5 decks intact.

**Two invariants the design rests on, confirmed on screen rather than in a test:**

| | |
| --- | --- |
| The breakdown agrees with the total | Summary read `$3,869.83 / 340 cards`; the collection value widget read `$3,869.83 / 340 cards`. Two commands, one `price_expr`. |
| The feed's union works | `activity` held **0** rows, and the widget still drew *"Changed Valakut Awakening // Valakut Stoneforge from 2 to 1 in Drawpower"* — a `deck_audit` row, worded by the deck history's own sentence builder. |

`Test Deck · Commander · 0 cards · —` drew the em dash for a deck the marketplace priced nothing in,
which is the `null`-is-not-zero rule reaching the screen.

**The popover.** Opened the `Collection value by` picker: panel at `1405,372`, 71×112, wholly inside
the viewport, **and the hit test at its centre returns the panel's own `LI[option]`** — a rect
inside the viewport proves nothing on its own. Rows came back `Color, Finish, Rarity, Set`, which is
`sortOptions` in effect. This is the check the flex-wrap grid exists to pass; a container query here
would have reparented that panel to the widget box.

> ⚠️ **A first attempt at this read the wrong thing, and the failure is worth keeping.** The hit at
> the panel's centre came back as a large `DIV` the panel did not contain, which looks exactly like
> a clipped or reparented popover. Reading the whole stack rather than the top element found a
> `fixed inset-0` element at `z=50` over everything: **`SyncProgress`'s first-run gate**, because
> that first launch had no corpus. Nothing about the popover was wrong. `elementsFromPoint` — the
> plural — is what tells "my thing is broken" from "something else is in front of it".

**Phone width.** At **390 px** (`PHONE_PX`, so the rail is replaced by the bottom tab bar): widgets
stack one per row at `x=20`, span-1 cards 352 px against `main`'s 375 px content box, and
`main.scrollWidth === main.clientWidth === 375` — **no horizontal scroll**, in edit mode as well as
at rest, with all six drag grips drawn and inside the box. The 352 px `min-w-[22rem]` clears 375 px
by 23 px, which is the whole of the margin this layout has at the fold.

> ⚠️ **A first attempt measured at 400 px and read as a bug.** The rail was still drawn and `main`
> was 192 px, so the 352 px cards overflowed it — but `PHONE_PX` is **390**, so 400 is *above* the
> fold and the rail was correct to stay. The lesson is the ordinary one: a layout finding at a width
> nobody ships is not a finding. The app's own `DESKTOP_FLOOR_PX` is 1024, so the band between them
> is not a window a reader can make.

**The launch flash — measured, fixed, and the fix backed out.** Sampled per `requestAnimationFrame`
across a reload with `start_view` set to `search`: the ribbon read **Home at 224 ms** and **Search at
317 ms**. So a reader who moved off the default watches ~**93 ms** of a page they did not choose,
every launch. §4 of `src/lib/useStartView.ts` carries the whole reasoning; the short version is that
gating the view area on that read trades a bounded flicker for an unbounded blank — `lib/query.ts`
sets `retry: 1`, and a view that is waiting looks exactly like a view that is broken. Nine
`App.test.tsx` cases went red the moment the gate landed, each one a read that had not settled in
time, which is the failure arriving as a warning rather than as a bug report. **The swap stays.**

## 10. The schema rung collision, and what it cost

This branch and `deck_notes` ([issue #447](https://github.com/Msgaihede/mtg-grimoire/issues/447))
each wrote a **v43** on 2026-09-10. Main landed first, so `activity` renumbered to **v44** — the
ladder's ordinary rule, taken before the merge rather than after it, because fixture names collide
as well as rung numbers.

Three things happened in that merge and they are not the same shape:

* **`web::route`'s command count went red, and both sides were right.** The notebook branch routed
  eight commands and this one routed nine, each writing its own number against a shared **149** —
  **both correct on their own branch and wrong in the merge.** The merged answer is **166**,
  `awk`'d off the merged array literal rather than added: the arithmetic happens to agree this
  time and would not have if either branch had also *removed* a route. That test's own comment now
  carries the sixth iteration of the same instruction, which is why it is repeated here.
* **Several tests assert *head* rather than their own rung**, so they went red on a renumbering that
  did not change anything they were about. That is the cheap failure — it is loud, and the fix is
  mechanical.
* **`decks.notes` was removed by main**, silently breaking every fixture on this branch that set
  it. Nothing went red until `tsc`, because a fixture that sets a field the type no longer has is a
  type error and not a runtime one — which is the good outcome, and the one that would not have
  happened had the field been typed loosely.

The counts this branch moved, and the command that answers each, so the next reader re-derives
rather than trusts: `USER_SCHEMA_VERSION` is `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs`;
the user-table count is the `Side::User` entries in `schema::TABLES`; the routed-command count is
`COMMANDS.len()` as the build computes it, which is why no document here writes it down twice.
