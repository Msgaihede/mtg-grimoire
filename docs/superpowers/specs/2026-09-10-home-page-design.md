# A customizable home page

Design for [issue #448](https://github.com/Msgaihede/mtg-grimoire/issues/448) — *"Add a customizable
homepage with widgets for shortcuts, collection and wishlist price breakdowns, and recent actions."*

Every figure below was read on 2026-09-10 out of the live debug databases at
`src-tauri/target/debug/data/` (`user.db`, 1.99 MB; `corpus.db`, 936 MB) in Node, or off the tree at
`3544c7bb`, unless it says otherwise.

---

## 1. What is already true

The app has **ten destinations and no router**. `ViewId` (`src/lib/store.ts:26`) is a closed union,
`NAV` (`src/components/nav.ts`) is the one list the rail, the bottom tab bar, the `Ctrl+1…9` chords
and the ribbon's `<h1>` are all drawn from, and `App.tsx`'s `ActiveView` is a flat chain of `if`s
over `useAppStore(s => s.activeView)`. A new page is a member, a row, an arm, and nothing else.

**`activeView` is `"search"`, hard-coded, and not persisted at all** (`store.ts:992`). There is no
`app_meta` row for it and no persist middleware. Every launch lands on Search.

**`app_meta` is the application's key/value table since schema v6** (`src-tauri/src/app_meta.rs`),
and it already holds fourteen rows on this machine — including `update_release_history` at
**201 550 bytes of JSON**. A layout document in it is not a new kind of thing.

**Every stored preference in this app is this device's.** `markcolors.rs` states it: `app_meta` is
not in `schema::SYNCED_TABLES`, and the two per-deck switches beside it are the exception rather
than the rule.

### What can already answer a widget

| Figure | Command | Notes |
| --- | --- | --- |
| Collection cards, unique, value, unpriced | `collection_summary` (`collection.rs:2065`) | Filter-scoped — `CollectionQuery` accepts `rarities`, `colors`, `sets`, `folderId` |
| Collection value per folder | `collection_folder_summary` (`collection_folders.rs:1246`) | Direct per folder, **root excluded**, `value` is `null` and not `0` when nothing is priced |
| Wishlist cost per folder | `wishlist_folder_summary` (`wishlist_folders.rs`) | Same two rules |
| Decks, with `cardCount` and cover art | `deck_list` (`deck.rs:3110`) | Already `ORDER BY archived ASC, updated_at DESC` |
| One deck's history, by day | `deck_audit_list` (`deck_audit.rs:328`) | **Per-deck only**; `auditText.ts` writes the sentences, `auditDays` groups by local calendar day |
| A price, at the reader's marketplace | `sorting::price_expr` (`sorting.rs:187`) | The crate's one price fragment. `cards.price_usd`/`price_eur` are a display fallback chain and **must never be summed** |

### The five gaps

1. **There is no `wishlist_summary`.** Zero hits across `src-tauri`. `WishlistPage.tsx:765` sums
   `unitPrice × quantity` in the browser over the rows on screen, and its own comment says why:
   "a wishlist fits in one page." `wishlist_list` caps at `MAX_LIMIT = 500` (`wishlist.rs:263`), so
   that sum is a page's total and not a list's.
2. **There is no global activity feed.** `deck_audit` is the only history table in `schema.rs`.
   `sync_ops` is a push outbox pruned after every push — four rows on this machine — and
   `error_log` records failures, not actions. `Recently removed` is a real `collection_folders` row
   of kind `removed`, not a log: **"recently" there is a name, not an ordering.**
3. **`deck_list` carries no value.** Getting one today means `deck_get` per deck and summing client
   side (`deckStats()` in `DeckStats.tsx`).
4. **There is no value-by-facet query anywhere in the app.** `facet_cards` counts *cards* over the
   search corpus and never money.
5. **Nine is the chord ceiling.** `CHORD_NAV` (`AppShell.tsx:104`) is `NAV` minus `shared`, and
   `shortcuts.ts:98` already records that the tenth destination arrived on 2026-09-08 and one entry
   had to go without.

---

## 2. The view

`ViewId` gains `"home"`. `NAV` gains `{ id: "home", label: "Home", Icon: House }` **as its first
entry**, and `App.tsx` gains one arm before the rest.

The page root is the convention every other view follows: a
`<section className="flex h-full flex-col gap-3">` whose first child is
`<h2 className="sr-only">Home</h2>`, with the visible title coming from `NAV` through the ribbon.

### The chord run renumbers, and Settings loses its chord

`CHORD_NAV` is built exactly as it is today, so inserting Home at the head shifts every digit:

| chord | today | after |
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

**Two destinations now go without a chord, for two different reasons**, and `shortcuts.ts`'s doc
comment has to say both rather than going on claiming there is one. `shared` goes without because
its row is *conditional* — a digit bound to a row that appears and disappears would mean two things
to two readers. Settings goes without because the run is nine long and the rail is eleven: it is the
last unconditional entry, and the alternative was moving Home out of reading order. This is a
deliberate, breaking change to a binding readers have in their fingers, and it belongs in the
release note as one.

`docs/reference/keyboard-shortcuts.md` carries the table above.

---

## 3. The landing view

The store's default becomes `"home"`, and which view the app opens on becomes a preference.

**`src-tauri/src/startview.rs`**, one `app_meta` key, built on `nav.rs`'s two rules:

* **Reading can never fail.** A missing row, a row holding a word this build has never heard of, a
  row that cannot be read at all — every one reads as **`"home"`**. `start_view` is therefore
  infallible by signature, which is `nav::nav_collapsed`'s contract and not a shortcut.
* **Writing validates only what Rust can validate.** A blank string is refused. **The vocabulary
  stays in TypeScript**, which is `listview.rs`'s split: that module owns the two words a wall may
  be drawn in and knows nothing about which walls exist, and this one owns "a non-empty word" and
  knows nothing about which views exist. TypeScript checks the stored word against `ViewId` on read
  and falls back to `"home"` — so a downgrade to a build without some view does not strand a reader
  on a page that no longer exists.

A **Start on** row lands in the Appearance settings panel, listing every unconditional `ViewId`.

`useStartView` (`src/lib/useStartView.ts`) follows `useNavCollapsed.ts`'s four house rules —
`staleTime`/`gcTime` `Infinity`, optimistic `setQueryData` **before** `mutate`, no rollback, and a
failed read is the default rather than an error — and hydrates through a guarded store action, the
same guard `hydrateCardZoom` carries: **a read that lands after the reader has already pressed
something is dropped.**

> **To measure in the shipped window, not in a test.** A reader who chose Search may see one frame
> of Home before the hydrate lands — the flash `usePrefetchSearchOpen` exists to prevent elsewhere,
> measured at 700 ms there. Drive the real window over CDP and sample per frame
> (`raf-sample-a-layout-flash`). If it is visible, `ActiveView` returns `null` until the first read
> settles, and that cost is recorded rather than assumed.

---

## 4. The layout document

One `app_meta` row, `home_layout`, per device.

```ts
interface HomeWidget {
  id: string;            // stable, minted when the widget is added
  kind: string;          // the vocabulary is TypeScript's — see below
  span: 1 | 2;           // columns
  config: unknown;       // per-kind, opaque to Rust
}
interface HomeLayout { version: 1; widgets: HomeWidget[] }
```

**`src-tauri/src/home.rs` validates the shape and never the vocabulary.** That is `markcolors.rs`'s
split at its widest: `kind` is a free string and `config` is an opaque `serde_json::Value`, so
**a widget kind this build has never heard of survives a round trip** — a rule `markcolors` states
as "a write preserves entries this build does not understand", and which here is what stops an
older build silently emptying the row of a newer one's widgets. What Rust does refuse: a document
that is not an object, a `widgets` that is not an array, an entry missing a non-empty `id` or
`kind`, a `span` outside `1..=2`, and a document over 64 KiB. What it does with anything unreadable
on the *read* side is hand back the default layout.

No migration: `app_meta` has existed since v6, and this is a key in it.

### The six widget kinds

| `kind` | draws | `config` |
| --- | --- | --- |
| `summary` | Collection / Decks / Wishlist — copies and value each | — |
| `decks` | pinned deck shortcuts: cover art, format, count, value | `{ deckIds: number[] }`, empty ⇒ the most recently updated |
| `folders` | pinned collection and wishlist folder shortcuts, count and value | `{ collectionFolderIds, wishlistFolderIds }` |
| `collectionValue` | total, unpriced note, bars by one dimension | `{ dimension: "rarity" \| "color" \| "set" \| "finish" }` |
| `wishlistValue` | the same over the wishlist | `{ dimension }` |
| `activity` | recent actions grouped by local calendar day | `{ limit: number }` |

A kind may appear more than once — the `id` is what identifies a widget, so two `decks` widgets
pinning two sets of decks is a layout the reader can build rather than a case to refuse.

The default layout, for a reader who has never customized anything: `summary` (span 2), `decks`,
`activity`, `collectionValue`, `wishlistValue`, `folders`.

---

## 5. The drawing

**The widgets import `StatsCard`, `BarChart`, `Track` and `percent` from
`src/features/decks/stats/StatsCard.tsx`** rather than growing a second set. A cross-feature import
is idiomatic here — `CollectionPage.tsx` already imports `dragData`, `MoveToFolder` and
`CONFIRM_DESTRUCTIVE` from `features/decks` — and it is the cheaper half of a trade: the honest
home for these primitives is `src/components/`, and moving the file while other branches are
editing the deck stats band would be a delete-plus-add conflict against live work. **The move is a
follow-up, recorded here so it is a decision and not an oversight.**

Every rule that file states applies unchanged: the whole drawing is `aria-hidden` and each bar
carries an `sr-only` sentence (*"the picture is decoration over numbers that are already text"*),
nothing in it is a control, `max` is the caller's and never `Math.max(...counts)`, a nonzero bar
keeps a `minHeight`, and `fill` is a CSS colour string because `bg-mana-${key}` emits no rule.

Money goes through `formatPrice(value, currency)` and `pricesAsOf(marketplace)`; a `null` price
draws an em dash and never another marketplace's number.

### The grid is flex-wrap, deliberately not a container query

`flex flex-wrap items-start gap-3`, each widget `min-w-[22rem] flex-1`, a `span: 2` widget
`basis-full`. This is the deck stats band's own layout and it is chosen for the band's own stated
reason: **`container-type: inline-size` applies layout containment, which makes the box the
containing block for every `fixed` descendant** — and these widgets open anchored popovers and
context menus. A container here would reparent them, which is the bug `layers.ts` was written
about. One consequence, stated rather than hidden: *where a widget appears* is an order and a
width, not a free-form position.

### Customize

A **Customize** toggle in the page's own header row — not the ribbon, which is for global actions.
In edit mode each widget card grows a drag grip, a width toggle, a remove, and a settings popover;
the header grows an **Add widget** menu and **Reset**.

Dragging is `@dnd-kit` through a new `src/features/home/homeDrag.ts` in `folderDrag.ts`'s shape —
`axis: "horizontal"`, a `before`/`after` edge that follows the pointer off `dragmove`, and an edge
mark of its own. The grip carries **arrow keys that write the move**, as `categoryDrag.ts`'s does,
because `dndManager` ships no `KeyboardSensor`.

---

## 6. New commands

Six commands and one table. Each goes **in the module its data lives in, with the gate on the
wrapper** — the rule `search.rs` is the pattern for — and each is routed on the web target as well,
because every one of them is a synchronous, connection-only query, which is exactly what
`web::route` answers.

| Command | Module | Answers |
| --- | --- | --- |
| `home_layout` / `set_home_layout` | `home.rs` (new) | the layout document |
| `start_view` / `set_start_view` | `startview.rs` (new) | the landing view |
| `wishlist_summary` | `wishlist.rs` | `{ wishes, copies, cost, unpriced }` |
| `collection_breakdown` | `collection.rs` | `[{ key, name, cards, value }]` |
| `wishlist_breakdown` | `wishlist.rs` | the same shape |
| `deck_values` | `deck.rs` | `[{ deckId, value, unpriced }]` — every deck, one query |
| `activity_recent` | `activity.rs` (new) | the union feed |

**`wishlist_summary` is `wishlist_folders.rs:673`'s SQL with two things removed** — the `GROUP BY`
and the `WHERE w.folder_id IS NOT NULL` that keeps root-level wishes out of a folder tile. It has
to be that expression and not a second one, for the reason that file already states: *a folder's
subtotal and the page header's total have to be one piece of arithmetic; two implementations of one
figure disagree the first time either changes.*

**Both breakdowns group over `sorting::price_expr`**, the same fragment `collection_summary` uses,
so a breakdown can never disagree with the total printed above it. The four dimensions are
`cards.rarity`, `cards.colors` (colour identity buckets through `lib/mana.ts`'s vocabulary),
`cards.set_code` (with `set_name` returned beside it, because only the corpus knows it) and
`collection_entries.finish`. A row the marketplace cannot price contributes to `cards` and not to
`value`, and the widget prints the unpriced count beside the total rather than folding it in.

**`deck_values` filters to the same cards `cardCount` counts** — `variant = 'live'`,
`deck_categories.is_active = 1`, `cat.kind IN ('main','commander','maybe')` (`deck.rs:1026`) — so a
deck's count and its value describe the same pile. A deck with nothing priced answers `null`, not
`0`, which is `CollectionFolderSummary::value`'s rule and for its reason: a tile has no room for
the header's "n unpriced" note, so a deck of cards the feed has never heard of would otherwise read
as a deck worth nothing.

---

## 7. The activity log

Schema **v43** — head is `USER_SCHEMA_VERSION = 42` (`schema.rs:372`), and the rung number is to be
re-checked against `main` immediately before merging, because a parallel branch taking v43 first is
a collision the compiler cannot see.

```sql
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('collection','wishlist')),
  kind TEXT NOT NULL CHECK (kind IN ('add','remove','quantity','move','edit','folder','import','clear')),
  card_id TEXT,                 -- soft, like every card id in a user table
  card_name TEXT,               -- denormalised: the row outlives the printing
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_activity_recent ON activity (at DESC, id DESC);
```

**`deck_audit`'s design, copied deliberately and for its stated reason.** Rust records *what
happened* — a kind, a card, a JSON payload of facts and a signed copy delta — and TypeScript writes
the sentence, because a sentence is domain logic and a log meant to survive being useful cannot
have the wording baked into its rows. Rewording a line must not be a migration, and a second
language must stay possible. `src/features/home/activityText.ts` is the only reader of `payload`,
nothing in it throws, and every field is read defensively so a sentence degrades to its shortest
honest form rather than taking the page down.

`activity_recent(limit)` UNIONs `activity` with `deck_audit` and orders by `at DESC, id DESC`,
clamped `1..=500` as `deck_audit_list` is. Day grouping is **`auditDays`, reused and not
re-derived** — days are *local* calendar days, and slicing them off an ISO string files a change
made at 23:30 under tomorrow, which is a thing this repo has already got wrong once.

### Three rules, because each is a way to get this wrong

* **A change that already writes a `deck_audit` row writes no `activity` row.** One event, one
  line. This is what keeps `collection_alloc`'s five deck-boundary writes from appearing twice.
* **A bulk operation records one row carrying its count in the payload.** An import of 5 000 cards
  must not write 5 000 lines — that is a feed nobody can read and a table that grows by a
  megabyte a session. `import`, `wishlist_import_commit`, `deck_missing_to_collection` and
  `reset::clear_collection`/`clear_wishlist` each record exactly one.
* **It is pruned**, at launch, in `maintenance.rs`: rows beyond the newest 5 000 go. `deck_audit`
  has never needed a pruner because a deck a person has actually built is hundreds of rows; a
  collection log is not bounded that way.

### It is not synced, and that is an asymmetry rather than an oversight

`activity` is **not** in `SYNCED_TABLES`. `deck_audit` is — so in a paired group the deck lines in
the feed arrive from every device and the collection lines are this one's. Teaching the sync
capture layer a new table means a `sync_uid`, a capture trigger, and a place in §7.3's five rules,
and an append-only log is the shape those rules have the least to say about. Recorded here as a
known consequence and a follow-up, not hidden.

### The write-site census is part of the work

Missing a write site shows up as **a silent gap in the feed, not a red build**. So the plan carries
an explicit census step rather than a hope: grep every statement in the crate that writes
`collection_entries` or `wishlist_entries`, list it against the sites that record, and account for
every one — either it records, or it is a `deck_audit` site by the first rule above, or it is a
consequence of another write (`fold_entry`, `reconcile::sweep_orphans`) and says so in a comment.

Known sites, from a first pass: `collection.rs` (`add_entry`, `add_entry_filed`, `set_quantity`,
`update_entry`, `delete_entry`), `collection_folders.rs` (`refile_entry`, `collection_set_folder`,
`delete_folder`, folder create/rename), `wishlist.rs` (`wishlist_add`, `wishlist_set_quantity`,
`wishlist_remove`, `wishlist_set_printing`, `wishlist_import_commit`), `wishlist_folders.rs`,
`import.rs`, `reset.rs`, `scanner.rs`'s add path.

---

## 8. Coverage

**Rust.** `home.rs` — round trip, an unknown `kind` preserved across a write, junk read as the
default, the 64 KiB cap refused, a bad `span` refused. `startview.rs` — a blank refused, an
unreadable row reading as `home`. `activity.rs` — a record, the prune boundary, the union's
ordering across both tables, a bulk row carrying its count. `wishlist_summary` — that it equals the
sum of the folder summaries **plus the root**, which is the bug the command exists to fix. Both
breakdowns — that each dimension's rows sum to the same total the summary prints, and that an
unpriced row lands in `cards` and not in `value`. `deck_values` — that a deck's value counts the
same cards its `cardCount` does, and that a deck with nothing priced answers `null`.

**TypeScript.** `layout.ts`'s pure functions (parse-never-throws, move, add, remove, span, config,
unknown kinds surviving a parse); `activityText.ts`'s sentences and its degradation on a payload it
does not understand; `useHomeLayout` and `useStartView`; one test per widget; `HomePage.test.tsx`
for edit mode, with the drag driven through `src/test-drag.ts` — every drag in a `try/finally` with
`held.cancel()`, every assertion about its result through `waitFor`, and a `getBoundingClientRect`
supplied on everything the hit-test touches, because dnd-kit hit-tests by coordinate and jsdom
measures every rect as zero. `nav.test.ts` and the chord catalogue's test both change.

**Storybook.** A `Home/*` namespace: one story per widget plus the page and its edit mode, across
the `empty`, `starter` and `large` seeds, with `busy` and `gone`. The fake needs `home_layout`,
`start_view`, `activity_recent`, `wishlist_summary`, both breakdowns and `deck_values` — added to
`.storybook/fake/db.ts` as derived DTOs over the rows it already stores, never as canned answers.

**The shipped window.** Every UI task in this repo's Plans 2–3 found something the suite could not,
and this one has three candidates named in advance: the start-view flash (§3), whether a widget's
popover survives the flex-wrap grid, and whether the edit-mode grid reflows sanely at phone width
where the rail is a bottom tab bar. Driven over CDP per `docs/reference/live-ui-verification.md`.

---

## 9. What this does not do

* **No free-form placement.** A widget has an order and a width. §5 says why the alternative would
  reparent every popover on the page.
* **No cross-device activity for the collection.** §7.
* **No deck-folder shortcuts.** There is no `deck_folder_summary` command and deck folders carry no
  counts; the `decks` widget pins decks, which is what the issue asks for.
* **`StatsCard` does not move to `src/components/`.** §5.
