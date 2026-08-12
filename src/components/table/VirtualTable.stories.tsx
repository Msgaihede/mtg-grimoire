import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { MARKETPLACES } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";

/** The default marketplace’s as-of sentence — this file is about the table, not about which
 *  shop the number came from, so it names one and holds it still. */
const PRICES_AS_OF = pricesAsOf(MARKETPLACES.tcgplayer);
const usdPrice = (value: number | null) => formatPrice(value, "usd");
import { CARDS, type FakeCard } from "../../../.storybook/fake/cards";
import { RarityGem } from "../RarityGem";

/**
 * What these stories put in the table.
 *
 * A shape of their own, not one of `ipc.ts`'s DTOs: this component is generic over `Row` and
 * knows nothing about cards, so a story built on `CollectionRow` would be a story about the
 * collection. The three real callers are `CollectionTable.tsx:296`, `SearchPage.tsx:354` and
 * `WishlistPage.tsx:684` — grepped 2026-08-09, three of three — and each brings its own
 * columns. `Collection/Table` next door is where the row-level behaviours (`extraHeight`,
 * `onActivate`, `renderRow`) are drawn over real data.
 */
interface Row {
  id: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string | null;
  priceUsd: number | null;
}

const row = (c: FakeCard): Row => ({
  id: c.id,
  name: c.name,
  setCode: c.setCode,
  collectorNumber: c.collectorNumber,
  rarity: c.rarity,
  priceUsd: c.priceUsd,
});

/** All 43 fixture printings (`.storybook/fake/cards.ts`), in the order that file lists them. */
const ALL: Row[] = CARDS.map(row);

/**
 * `search::SEARCH_SORTS`' rarity `CASE`, copied from `.storybook/fake/db.ts:414-430` so
 * {@link SortedByTwoColumns} can put its rows in the order a backend answering that spec would.
 *
 * It is a **rank**, not an alphabet: `mythic` sorts between `common` and `rare`, and `special`
 * and `bonus` are real values with no place in the printed hierarchy at all.
 */
const RARITY_RANK: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  mythic: 3,
  special: 4,
  bonus: 5,
};
const rarityRank = (r: string | null) => (r === null ? 6 : (RARITY_RANK[r] ?? 6));

/**
 * The four columns, in the shape the app's own tables use: one flexible name column and three
 * whose contents have a known width.
 *
 * Only `name` flexes because a price column that squeezes is a column nobody can scan — the
 * same conclusion `CollectionTable`'s six columns reached, and the reason `truncate` is on
 * every header label rather than on the ones that looked long.
 */
const COLUMNS: TableColumn<Row>[] = [
  {
    key: "name",
    width: "minmax(0,1fr)",
    header: "Name",
    sortable: true,
    cellClassName: "truncate",
    cell: (r) => r.name,
  },
  {
    key: "set",
    width: "7rem",
    header: "Set",
    sortable: true,
    cellClassName: "flex items-center gap-1.5 truncate font-mono text-xs text-dim",
    cell: (r) => (
      <>
        <RarityGem rarity={r.rarity} />
        <span className="truncate">
          {r.setCode.toUpperCase()} · {r.collectorNumber}
        </span>
      </>
    ),
  },
  {
    key: "rarity",
    width: "5rem",
    header: "Rarity",
    sortable: true,
    cellClassName: "truncate text-xs text-dim",
    cell: (r) => r.rarity ?? "—",
  },
  {
    key: "price",
    width: "5.5rem",
    header: "Price",
    sortable: true,
    // Descending first, because "most expensive first" is what pressing a money column means.
    // Documented at the column and decided at the page's hook — see `TableColumn.firstDir`.
    firstDir: "desc",
    // Spec §5: a price is never shown without saying how old it is, and a 36px header row has
    // nowhere to write it. The accessible name *begins* with the visible word (WCAG 2.5.3), so
    // the column stays addressable by what is written on it.
    headerTitle: PRICES_AS_OF,
    headerLabel: `Price. ${PRICES_AS_OF}`,
    headerClassName: "text-right",
    cellClassName: "text-right font-mono tabular-nums",
    cell: (r) => usdPrice(r.priceUsd),
  },
  {
    key: "actions",
    width: "2rem",
    // Nothing to draw, and a name a screen reader still needs: an unnamed column is announced
    // as "column 5" on every row.
    header: "Actions",
    srOnlyHeader: true,
    cell: () => null,
  },
];

const meta = {
  title: "Table/VirtualTable",
  component: VirtualTable<Row>,
  tags: ["autodocs"],
  args: {
    rows: ALL.slice(0, 5),
    columns: COLUMNS,
    label: "Stand-in rows",
    total: 5,
    listKey: "stories",
    sort: [],
    onSort: fn(),
    onNeedNextPage: fn(),
  },
  // A height, because the component is `min-h-0 flex-1` — it expects a flex parent that has
  // already decided how tall the list is, and in a story canvas with no such parent the
  // scroller would grow to whatever it holds and virtualise nothing.
  decorators: [
    (Story) => (
      <div className="flex h-[28rem] w-[46rem] flex-col">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The app's one virtualised table: a scroller, a sticky sortable header, and " +
          "absolutely positioned rows. One component because there were three, and they " +
          "differed in their **columns** rather than in their behaviour — same scroll reset, " +
          "same paging effect, same row geometry, same guards on every interactive cell.\n\n" +
          "The sort is a **prop**: `sort` comes in, one `(key, additive)` press goes out, and " +
          "the rows arrive already ordered. Nothing here sorts anything — so a story showing " +
          "a sorted table has to hand it rows in the order a backend answering that spec " +
          "would, which is what the two sorted stories below do.\n\n" +
          "The column template is an inline style rather than a Tailwind arbitrary value on " +
          "purpose: Tailwind scans source text for whole class names, so a template joined at " +
          "runtime would emit no rule at all.",
      },
    },
  },
} satisfies Meta<typeof VirtualTable<Row>>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Five rows in a scroller that fits them, so nothing is virtualised away and the geometry is
 * plain: a sticky header, then rows on a 44px pitch.
 *
 * **Rows are visible to a `play` here, and that is not free.** jsdom lays nothing out, so
 * `@tanstack/react-virtual` would measure this scroller at 0px and render no rows at all;
 * `src/stories.test.tsx`'s `beforeAll` stubs `offsetHeight`/`offsetWidth`/`scrollTo` for every
 * play in the repository, which is the same three lines `VirtualTable.test.tsx:14-18` uses. What
 * it does *not* buy is this app's viewport — 600 × 900 is a number that file chose — so a `play`
 * asserts the **presence of a named row near the top**, never how many rows are in the DOM.
 *
 * `aria-rowindex` counts the header as 1, so the first data row is 2. That is the whole reason
 * the attribute is written out rather than left to the DOM: a virtualised list's rows are
 * absolutely positioned and only a window of them exists, so nothing else can tell assistive
 * tech where in the list it is standing.
 */
export const FewRows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The top row, found by the one cell that identifies a printing rather than by position:
    // four of the five rows here are called "Lightning Bolt".
    const cell = canvas.getByText("LEA · 161");
    const row = cell.closest('[role="row"]');
    await expect(row).toHaveAttribute("aria-rowindex", "2");
    // The Price cell, through `usdPrice` rather than a literal, so this cannot drift the day
    // the formatter's locale data does.
    await expect(within(row as HTMLElement).getByText(usdPrice(620))).toBeInTheDocument();
    // Five cells including the one that draws nothing: the Actions column is `srOnlyHeader`,
    // not absent, and every row still carries its `role="cell"` wrapper — otherwise a screen
    // reader walking the row by column would find four cells under five headers.
    await expect(within(row as HTMLElement).getAllByRole("cell")).toHaveLength(5);
  },
};

/**
 * All 43 fixture printings — 43 × 44px of rows plus a 36px header is 1 928px of list against a
 * 28rem (448px) scroller, so a little over four screenfuls, which is what makes the virtualiser
 * do something. Scroll it: the DOM holds the visible window plus this component's `overscan` of
 * ten, never 43.
 *
 * 43 is the whole corpus (`.storybook/fake/cards.ts` — 43 real printings), not a round number
 * chosen to look like a lot. The app's real lists are thousands of rows, and that is the point
 * of the component; it is not something a fixture can honestly stage.
 */
export const ManyRows: Story = {
  args: { rows: ALL, total: ALL.length },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The first row is in the DOM at any viewport, which is what makes this a claim about the
    // list rather than about the stub's 600px.
    await expect(canvas.getByText("LEA · 161")).toBeInTheDocument();
    // Virtualisation itself, as an **inequality** rather than a count: however tall the window
    // is, a virtualised list holds fewer elements than it has rows. A count here would be a
    // green assertion that silently re-measures the day anyone touches the stub's numbers, the
    // row pitch or `overscan`.
    await expect(canvas.getAllByRole("row").length).toBeLessThan(ALL.length + 1);
    // And the count assistive tech is given is the *whole* list regardless — 43 rows plus the
    // header — which is the one number that must not follow the window.
    await expect(canvas.getByRole("table")).toHaveAttribute(
      "aria-rowcount",
      String(ALL.length + 1),
    );
  },
};

/**
 * No rows, and **the table still exists** — header, `aria-rowcount`, the lot.
 *
 * This component draws no empty state of its own, deliberately: what an empty list *means* is
 * the page's to say (no results, no collection yet, every filter excluded), and each of the
 * three callers says something different above it. So an empty table is an empty table.
 */
export const Empty: Story = {
  args: { rows: [], total: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 0 rows plus the header. The count is of rows *matching*, not rows in the DOM — which is
    // the whole reason the attribute is computed rather than counted.
    await expect(canvas.getByRole("table")).toHaveAttribute("aria-rowcount", "1");
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(5);
    // The rowgroup is drawn either way: it is what holds the scrollbar open to the list's
    // height, and an empty list has a height of zero rather than no box.
    await expect(canvas.getByRole("rowgroup")).toBeEmptyDOMElement();
  },
};

/**
 * One key, ascending — the ordinary case, and the one that needs no rank.
 *
 * The rows are handed over in name order because that is what a backend answering
 * `[{ key: "name", dir: "asc" }]` would return. `cmp` in `.storybook/fake/db.ts:252` sorts by
 * UTF-16 code units, which is SQLite's default `BINARY` collation, so `localeCompare` is
 * deliberately not used here either: it sorts `"a"` before `"B"` and would reorder the list
 * against what the app would actually show.
 */
export const SortedByName: Story = {
  args: {
    rows: [...ALL].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    total: ALL.length,
    sort: [{ key: "name", dir: "asc" }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    // A sortable column the sort does not mention says "none", which is a different statement
    // from the one the Actions column makes by carrying no `aria-sort` at all: that column
    // cannot be sorted, and has no sort state to report.
    await expect(canvas.getByRole("columnheader", { name: /^Set/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    await expect(canvas.getByRole("columnheader", { name: "Actions" })).not.toHaveAttribute(
      "aria-sort",
    );
    // One key, so no priority is announced — "1 of 1" is a number that says nothing.
    await expect(canvas.getByRole("button", { name: "Name" })).toBeInTheDocument();
    // And the rows really are in that order. `A-Vivi Ornitier` sorts above
    // `Agadeem's Awakening // …` under `BINARY`, because `-` (0x2D) is below `g` (0x67) — the
    // pair that would come out the other way round under `localeCompare`, which is why neither
    // this file nor the fake backend uses it.
    await expect(canvas.getByText("A-Vivi Ornitier").closest('[role="row"]')).toHaveAttribute(
      "aria-rowindex",
      "2",
    );
  },
};

/**
 * Two keys: rarity ascending, then price descending inside each rarity.
 *
 * This is the question a list of printings is usually read for and the reason the spec is a
 * *list* rather than a key — "the dearest card at each rarity" is two terms, and one key
 * answers half of it and leaves the rest to whatever order the database happened to produce.
 *
 * The rows are ordered here the way `.storybook/fake/db.ts`'s `orderBy` would: the rarity
 * `CASE` rank first, then price with **`NULLS LAST` in both directions** — reversing a
 * `… DESC NULLS LAST` would move the holes to the top, and a reader reversing a sort expects
 * the rows reversed, not the holes moved. Six of the 43 fixture printings have a null
 * `priceUsd` (measured 2026-08-09 over `.storybook/fake/cards.ts`), so the holes are visible at
 * the foot of their rarity groups rather than being a rule with no example.
 */
export const SortedByTwoColumns: Story = {
  args: {
    rows: [...ALL].sort(
      (a, b) =>
        rarityRank(a.rarity) - rarityRank(b.rarity) ||
        (a.priceUsd === null
          ? b.priceUsd === null
            ? 0
            : 1
          : b.priceUsd === null
            ? -1
            : b.priceUsd - a.priceUsd),
    ),
    total: ALL.length,
    sort: [
      { key: "rarity", dir: "asc" },
      { key: "price", dir: "desc" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `aria-sort` on **every** sorted column rather than only the first: the alternative is
    // telling assistive tech that a two-key sort has one key.
    await expect(canvas.getByRole("columnheader", { name: /^Rarity/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect(canvas.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(
      canvas.getByRole("button", { name: "Rarity, sort priority 1" }),
    ).toBeInTheDocument();
    // The Price header's own sentence and its rank are two different names on two different
    // elements: the header keeps `Price. <as-of>` and the button says where it sits.
    await expect(
      canvas.getByRole("button", { name: "Price, sort priority 2" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute(
      "aria-label",
      `Price. ${PRICES_AS_OF}`,
    );
    // The first row is the dearest **common**, not the dearest card: `rarity` decides and
    // `price` only breaks its ties, which is the whole difference between a two-key sort and
    // two separate ones. Alpha Lightning Bolt at $620.00 is a common; the $4 999.95 Ancestral
    // Recall below it is a rare and sorts into that group instead.
    const top = canvas.getByText("LEA · 161").closest('[role="row"]');
    await expect(top).toHaveAttribute("aria-rowindex", "2");
    await expect(within(top as HTMLElement).getByText(usdPrice(620))).toBeInTheDocument();
  },
};

/**
 * A count the page could not give — the search's case, where matching rows are capped rather
 * than counted.
 *
 * ARIA spells "unknown" `-1`, and that is what goes out. A number would be a smaller lie than
 * saying the database holds 20 cards, but it would still be one, and there is a spelling for
 * this. The collection has no such case: `CollectionPage` counts its rows in full.
 */
export const CountUnknown: Story = {
  args: { total: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("table")).toHaveAttribute("aria-rowcount", "-1");
  },
};
