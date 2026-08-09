# Sortable table headers, and a layering rule that keeps popups on top

**Date:** 2026-08-09
**Status:** approved, not yet implemented
**Branch:** `worktree-table-refac`

Two things, one refactor. A dropdown on the search view is painted over by the results
table's sticky header; and the three tables in the app — search, collection, wishlist —
have headers that say what a column is but cannot be used to order by it. Both are
answered by the same piece of work, because the fix for the first is a rule about layering
that the second would otherwise break again, and because making three copies of a table
sortable is the moment to stop having three copies.

---

## 1. The bug

`SetCombobox`'s popup (`src/features/search/SetCombobox.tsx:219`, `absolute z-20`) is drawn
*under* the search table's sticky header (`src/features/search/SearchPage.tsx:413`,
`sticky top-0 z-20`). The header paints a grey band straight across the open set picker,
about 36px down from where the popup starts.

Neither element is nested inside the other, and **nothing between them creates a stacking
context** — the section, the filter row, the combobox's `relative` root (positioned, but
`z-index: auto`), the results column and the scroller are all transparent to stacking. So
both land in the root stacking context at the same z-index, and equal z-indexes are
resolved by document order. Every table header comes after the filter bar. The header wins.

It is not specific to the set picker or to the search view: the collection and wishlist
tables carry byte-identical header classes, and seven anchored popups across the app sit at
`z-20`. Whichever of them next opens over a table is the next report of this bug.

### The fix

One module, `src/lib/layers.ts`, holding the app's whole z-index vocabulary as Tailwind
class strings, and every hard-coded `z-*` in `src/` moving onto it:

| layer    | class  | who                                                                      |
| -------- | ------ | ------------------------------------------------------------------------ |
| `row`    | `z-10` | a virtualised row lifted so its own open popup clears the rows below it   |
| `header` | `z-20` | the three tables' sticky headers                                          |
| `popup`  | `z-30` | anything anchored to a control and floating over the page                 |
| `gate`   | `z-50` | `SyncProgress`'s full-window takeover                                     |

`src/lib/layers.test.ts` pins `row < header < popup < gate` by parsing the numbers out, the
way `src/lib/tokens.test.ts` pins the dim-text token. A scale whose order is only an
intention is a scale that drifts.

`DeckEditor.tsx:884`'s remove tray is `z-30` today and is the one element that has to be
classified rather than translated: it is a drag-time overlay over a zone column, never open
at the same time as a popup. It takes `popup` unless the implementation finds it competing
with one, in which case it earns its own name.

### The note the module must carry

**A z-index only competes inside its own stacking context.** The quick-add popup opened
inside a table row is capped by that row's `z-10` whatever it asks for, because the row is
`position: absolute` *and* `transform`ed and is therefore a stacking context of its own.
That is why the row lift exists at all, and why `row` must stay **below** `header`: a row
scrolling past the header has to go under it. Without this written down, the next person to
meet a clipped popup will bump a number, watch nothing happen, and bump it further.

---

## 2. `VirtualTable`

`SearchPage`'s table view, `CollectionTable` and `WishlistPage`'s `WishlistTable` are three
copies of one component. They share the scroller (`role="table"`, `aria-rowcount`,
`tabIndex={0}`, the same border and overflow classes), the sticky header row, the
`role="rowgroup"` spacer holding the scrollbar open, `@tanstack/react-virtual` with the same
`overscan` and `scrollMargin`, the `scrollToOffset(0)`-on-new-`listKey` effect, the
`needsNextPage` paging effect, absolutely-positioned rows offset by `translateY(start -
HEADER_HEIGHT)`, `ROW_FOCUS`, and the Enter/Space-opens-the-card handler. Two of the three
also share the flagged-row band and its `gridTemplateRows` pinning.

`src/components/table/VirtualTable.tsx` becomes the one copy. It owns all of the above plus
the `role="cell"` wrapper — including the `data-no-drag` + `stopPropagation` +
`stopRowActivationKeys` trio that every interactive cell in all three tables repeats
verbatim, and that a new cell can currently forget.

Columns are data:

```ts
interface TableColumn<Row> {
  /** Stable id. Also the sort key sent to the backend when `sortable`. */
  key: string;
  /** Grid track — `"minmax(0,2fr)"`, `"8rem"`. The template is joined from these. */
  width: string;
  /** The visible label. */
  header: string;
  /** Not drawn, still named: an unnamed column is announced as "column 6" every row. */
  srOnlyHeader?: boolean;
  /** Rides as the column's tooltip and inside its accessible name. */
  headerTitle?: string;
  /** Overrides the accessible name. Must *begin* with `header` — WCAG 2.5.3. */
  headerLabel?: string;
  headerClassName?: string;
  sortable?: boolean;
  /** Which direction one click asks for first. See §3. */
  firstDir?: SortDir;
  cell: (row: Row) => ReactNode;
  cellClassName?: string;
  /** Applies `data-no-drag`, the click stop and `stopRowActivationKeys`. */
  interactive?: boolean;
}
```

The two things that genuinely differ stay callbacks:

- **`renderRow`** — the collection and wishlist wrap their row in a drag source
  (`DraggableRow`, which must hold its identity still or a mid-drag re-render unregisters
  the source); the search table does not. The default renders a plain `div`.
- **`extraHeight(row)`** — the reconciler's flagged band, which grows a row by 20px and
  pins `gridTemplateRows` so the band can be positioned over the second track. Returns 0
  for the search table, which has no flagged rows.

The band itself stays inside the name column's `cell()`, where it is now: a `<p>` among a
row's cells is not a cell, and what is not a cell is not announced.

**What does not move in:** the queries, the filter bars, the mutations, and the two tables'
`DraggableRow` wrappers. `VirtualTable` knows about rows, columns and a sort; it does not
know what a card is.

---

## 3. Sorting

### The model

`src/lib/sort.ts`:

```ts
export type SortDir = "asc" | "desc";
export interface SortTerm { readonly key: string; readonly dir: SortDir }
export type SortSpec = readonly SortTerm[];

export function applySort(
  spec: SortSpec,
  key: string,
  opts: { additive: boolean; firstDir: SortDir },
): SortSpec;
```

One pure reducer, which is where the whole interaction lives and therefore where the tests
go.

- **Click** on a column already sorting alone cycles it: `firstDir` → the opposite → gone.
- **Click** on anything else replaces the entire spec with that one term at `firstDir`.
- **Shift-click** does the same cycle to that one column and leaves the other terms in
  place, appending at the end when the column is not in the spec yet. This is how a
  multi-key sort is built, and it is the convention every table the reader has met uses.
- An empty spec is a real state: it means the view's own default — relevance-or-name for
  the search, name for the collection and the wishlist. There is no unsorted list.

No cap on the number of terms. The sortable columns are the cap, and they number five.

`firstDir` is per column and it is not decoration: ascending on Name, Set and Type, and
**descending** on every money and count column, because "highest first" is what a reader
means by clicking a price.

### The header

The `role="columnheader"` element carries `aria-sort`; inside it, a `<button>` carrying the
label, a direction arrow, and — only once the spec holds more than one term — a small
ordinal badge. `aria-sort` is set on *every* sorted column rather than only the first: the
alternative is telling assistive tech that a two-key sort has one key.

The accessible name stays label-first, which is the rule the existing Price header already
follows and cites: `"Price. Prices as of 2026-08-04, sort priority 2"` begins with the word
written on the column, so it stays addressable by voice (WCAG 2.5.3).

Keyboard: the button gets Enter and Space for free, and **Shift+Enter is the additive
press** — Chromium reports `shiftKey` on the click it synthesises, so one handler covers
mouse and keyboard both.

Changing the sort changes the query key, which changes `listKey`, which the existing
scroll-reset effect already reacts to. A re-sorted list starts at the top for free.

### The filter bar's sort select

The collection and the wishlist keep theirs, driving the same state. Picking an option
**replaces** the spec with that single term; the select reads back the spec's first term
when it is one of its own options and `"Custom…"` when it is not. Nothing is lost and there
is one source of truth.

It has to stay, because two orders both views offer have no column to click:

- **"Recently added"** — neither table has a date column, and neither can afford one. The
  collection's own comment records dropping a column at 1280px with the card pane open,
  which left the name column at ~124px.
- **Unit price** — see the next paragraph.

The search view gains no select. It has no order that is not a column.

### A header sorts by what it shows

The collection's Value column shows unit price × quantity; the wishlist's Cost column shows
unit price × copies still missing. Both headers sort by **that** number, not by the unit
price the current `price` key uses — a column that reorders by something other than the
figure printed in it is a column that lies.

The unit-price order survives as a select option with no column, which is the same shape as
"Recently added" and needs no new machinery.

### The wishlist's Printing column is not sortable

An any-printing wish names no set. `useWishlist.ts` already refuses a set order for exactly
this reason — "a list where half the rows sort under the same blank is not an order" — and
that reasoning is not weakened by the header being clickable rather than a select option.

### The backend

`src-tauri/src/sorting.rs`, new:

```rust
pub struct SortTerm { pub key: String, pub dir: String }   // deserialized from the UI

pub struct SortColumn {
    pub key: &'static str,
    pub asc: &'static str,
    pub desc: &'static str,
}

/// Unknown keys dropped, duplicates keeping the first, `tiebreak` always appended.
pub fn order_by(
    terms: Option<&[SortTerm]>,
    allowed: &[SortColumn],
    fallback: &str,
    tiebreak: &str,
) -> String;
```

Each table declares its own whitelist of literals. **No user text ever reaches the SQL
parser** — a key is matched against the whitelist or dropped, which is the property
`search.rs`'s existing injection test asserts and which the new module inherits.

`sort: Option<String>` becomes `sort: Option<Vec<SortTerm>>` on all three commands. There is
no compatibility to keep: the frontend is the only caller, and it has never sent the field
at all for the search.

The tiebreak is not optional. Every order ends in the table's unique key (`c.id` for the
search, `e.id` for the collection, `w.id` for the wishlist) because the pagers use `OFFSET`,
and two rows that tie on every stated key can otherwise swap places between the request for
page 1 and the request for page 2 — showing the reader one of them twice and the other
never.

Two orders need an expression rather than a column:

- **Rarity** ranks `common < uncommon < rare < mythic < special < bonus`, everything else
  last, as a `CASE`. Alphabetical rarity is not an order anybody wants.
- **Set** reuses the collection's existing natural-collector-number trick —
  `set_code, CAST(collector_number AS INTEGER), collector_number` — because ~9% of collector
  numbers are not numeric and a plain string sort puts `100` before `2`.

Nullable columns (`type_line`, `price_usd`, `released_at`) state their null rule explicitly
in both directions rather than inheriting SQLite's default.

---

## 4. The measurement that gates a fourth change

`cards` is indexed on `name`, `oracle_id` and `(set_code, collector_number)` and nothing
else, so ordering the **unfiltered 116k-row browse** by price, rarity or type is a full
sort. That much is expected and acceptable — it is opt-in, and any filter at all narrows it.

The part that may not be acceptable is what SQLite sorts. It computes the SELECT list before
the sorter unless an index supplies the order, and the search page query's SELECT list
carries two correlated subqueries — `owned_quantity`'s `sum` and `wishlisted`'s `EXISTS`.
Under an unindexed sort those run once per *matching* row rather than once per row the page
returns: 116 000 times instead of 50.

**Measure it first**, against the real database, the way every other figure in `CLAUDE.md`
was measured. If a sorted unfiltered browse is materially slower than the ~10ms one it
replaces, the fix is to order and limit a lean inner query to 50 ids and fetch the columns
for those — not to add indexes. A multi-term sort cannot use an index for anything past its
leading column, and every index on `cards` is dropped and rebuilt on every sync
(`schema::swap_staging` replays `CARDS_INDEXES`), so an index is a permanent cost on the
92–99s sync for a partial answer.

The collection and the wishlist are thousands of rows, not 116 000. They are not at risk and
are not measured for this.

---

## 5. Tests

**TypeScript**

- `src/lib/sort.test.ts` — the reducer. The cycle in both modes, `firstDir` respected, a
  plain click replacing a multi-term spec, shift-click appending and then removing, and the
  empty spec meaning "default".
- `src/lib/layers.test.ts` — the ordering.
- `src/components/table/VirtualTable.test.tsx` — `aria-sort` on the right columns, a click
  calling `onSort` with `additive: false` and a shift-click with `true`, non-sortable
  columns rendering no button, `aria-rowcount` including the header row, the row-lift class
  surviving the extraction.
- The three views' existing tests, updated where the extraction moved a query.

**Rust**

- `sorting::order_by` — an unknown key dropped, a duplicate key keeping the first, the
  tiebreak always appended, an empty spec falling back, and the injection attempt
  (`key: "c.name; DROP TABLE cards"`) producing the fallback rather than the string.
- Per-table: a two-term sort pages deterministically across a page boundary, in the shape of
  the existing tie-break paging tests at `search.rs:797`.

**Live, over CDP** — the pass that the suite structurally cannot do:

1. The set picker open over the results table. This is the reported bug, and a screenshot is
   the only thing that can show it is gone.
2. Click a header; shift-click a second. Arrows, ordinal badges, and rows in the new order.
3. The keyboard path, **counting activations** rather than checking that one happened —
   `CLAUDE.md` records a stepper that moved by two under a single reported press. Shift+Enter
   needs `Input.dispatchKeyEvent` to carry the modifier, so `scripts/cdp.mjs` may need a
   small extension; if it does, that extension is part of this work.
4. The console recorder attached across the whole pass, reading `Log.entryAdded` **and**
   `Runtime.consoleAPICalled`.

---

## 6. Out of scope

- Persisting a sort across launches. It is view state, like the filters beside it, and
  neither of the two existing sort selects persists today.
- Any new column on any table. The Value/Cost decision above is a change to what an existing
  header means, not a new one.
- The deck editor's zone columns. They are plain scrollers with no header row and no sort.
- Adding indexes to `cards`. Considered, deferred with a reason, in §4.
