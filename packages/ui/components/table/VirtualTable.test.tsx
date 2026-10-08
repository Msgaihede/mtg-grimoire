import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ComponentProps } from "react";
import { compile } from "tailwindcss";
import twEntry from "tailwindcss/index.css?raw";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import appCss from "@/index.css?raw";
import { FOCUS_INSET } from "@/lib/focus";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { LAYER } from "@/lib/layers";
import type { SortSpec } from "@/lib/sort";
import {
  TABLE_BAND_HEIGHT,
  TABLE_HEADER_HEIGHT,
  VirtualTable,
  type RowRenderProps,
  type TableColumn,
} from "./VirtualTable";

/**
 * jsdom lays nothing out: every element measures 0, so the virtualiser computes an empty
 * window and renders no rows at all. `@tanstack/react-virtual` sizes its scroll container
 * with `offsetHeight`, so one number is the whole of what it is missing. It scrolls through
 * `Element.scrollTo`, which jsdom does not implement either. The same stub the three views'
 * own tests use, for the same reason.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

interface Row {
  id: string;
  name: string;
  price: number;
  /** Set only on a heading band's row — see the band blocks at the foot of this file. */
  shelf?: string;
}

const ROWS: Row[] = [
  { id: "a", name: "Black Lotus", price: 9 },
  { id: "b", name: "Shivan Dragon", price: 1 },
];

const COLUMNS: TableColumn<Row>[] = [
  { key: "name", width: "minmax(0,1fr)", header: "Name", sortable: true, cell: (r) => r.name },
  {
    key: "price",
    width: "6rem",
    header: "Price",
    sortable: true,
    firstDir: "desc",
    headerClassName: "text-right",
    cell: (r) => String(r.price),
  },
  { key: "actions", width: "2rem", header: "Actions", srOnlyHeader: true, cell: () => null },
];

function setup(sort: SortSpec = [], onSort = vi.fn()) {
  render(
    <VirtualTable
      rows={ROWS}
      columns={COLUMNS}
      label="Test rows"
      total={2}
      listKey="k"
      onNeedNextPage={() => {}}
      sort={sort}
      onSort={onSort}
    />,
  );
  return onSort;
}

describe("VirtualTable's header", () => {
  it("names every column, including the one with nothing to show", () => {
    setup();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it("makes a sortable column a button and leaves the rest alone", () => {
    setup();
    expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Actions/ })).not.toBeInTheDocument();
  });

  /**
   * `aria-sort` on *every* sorted column rather than only the first: the alternative is
   * telling assistive tech that a two-key sort has one key.
   */
  it("states the direction of every sorted column", () => {
    setup([
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);
    expect(screen.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    // Not "none" — a column that cannot be sorted has no sort state to report at all.
    expect(screen.getByRole("columnheader", { name: "Actions" })).not.toHaveAttribute("aria-sort");
  });

  /**
   * WCAG 2.5.3: an accessible name that overrides the visible one has to *begin* with it,
   * or the column stops being addressable by the word written on it.
   */
  it("says where a column sits in a multi-key sort, after its own name", () => {
    setup([
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);
    expect(screen.getByRole("button", { name: "Name, sort priority 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Price, sort priority 2" })).toBeInTheDocument();
  });

  it("says nothing about priority when one column is the whole sort", () => {
    setup([{ key: "name", dir: "asc" }]);
    expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
  });

  it("reports a plain press as replacing the sort and a shifted one as adding to it", async () => {
    const user = userEvent.setup();
    const onSort = setup();

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenLastCalledWith("name", false);

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "Price" }));
    await user.keyboard("{/Shift}");
    expect(onSort).toHaveBeenLastCalledWith("price", true);
  });
});

describe("VirtualTable's rows", () => {
  it("tells assistive tech how many rows there are, header included", () => {
    setup();
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "3");
  });

  /** A capped count is unknown, and ARIA spells unknown `-1`. 5 000 would be a smaller lie. */
  it("says the count is unknown when it is capped", () => {
    render(
      <VirtualTable
        rows={ROWS}
        columns={COLUMNS}
        label="Test rows"
        total={null}
        listKey="k"
        onNeedNextPage={() => {}}
        sort={[]}
        onSort={() => {}}
      />,
    );
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "-1");
  });

  /**
   * A row is `position: absolute` *and* transformed, so it is a stacking context and an open
   * popup inside it cannot lift itself over the next row — the row has to come forward. As
   * far as the rows and no further: the header above is a layer up, and a row lifted to its
   * level would scroll over it.
   *
   * **The rung is unconditional and the two premises behind it are not** — under `grow` a row is
   * a bare `relative` with no transform, so it is a stacking context for one of those two reasons
   * rather than both, and the lift is still what has to happen. Anything reasoning about a row
   * being transformed (a `fixed` descendant's containing block, a capped nested `z-index`) is
   * reasoning about the default mode only. See the `grow` block below.
   */
  it("lifts a row holding an open popup, and no higher than the header", () => {
    setup();
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveClass("has-[[aria-expanded=true]]:z-10");
    expect(rows[0]).toHaveClass("z-20");
  });

  /**
   * A caller-rendered row is the row — no wrapper between the `rowgroup` and its `row`s,
   * because a screen reader walks that relationship to count them.
   */
  it("lets a caller wrap the row without adding an element between it and the rowgroup", () => {
    render(
      <VirtualTable
        rows={ROWS}
        columns={COLUMNS}
        label="Test rows"
        total={2}
        listKey="k"
        onNeedNextPage={() => {}}
        sort={[]}
        onSort={() => {}}
        renderRow={(props) => <div data-testid="wrapped" {...props} />}
      />,
    );
    const group = screen.getByRole("rowgroup");
    expect(screen.getAllByTestId("wrapped")).toHaveLength(2);
    for (const child of group.children) expect(child).toHaveAttribute("role", "row");
  });
});

/**
 * **`grow` is the opt-in that stops this being a scroller, and the deck's Table view is its one
 * caller** (2026-09-08).
 *
 * The three walls that draw this table — the search, the collection, the wishlist — are lists of
 * up to 117k rows and virtualise for their lives; nothing about them may move, which is why the
 * prop defaults to `false` and every case above drives that default. A *deck* is a few hundred
 * rows at most, and drawing it in a scrollport put a second scrollbar an inch from the page's own,
 * with nothing on screen saying which of the two a wheel was about to move. So the deck's table
 * renders every row in normal flow and lets `AppShell`'s `main` scroll, exactly as the editor's
 * other three views already did.
 *
 * **jsdom lays nothing out**, so none of this can see the scrollbar itself. What it can see is the
 * three structural facts that produce it — the count of rows in the tree, the absence of a
 * scrollport on the root, and a row positioned in flow rather than at an offset — and each of
 * those is the whole of the mechanism.
 */
describe("VirtualTable told to grow", () => {
  /** Long enough that the virtualiser's window is a genuine subset: at the 600px `offsetHeight`
   *  stubbed above, 44px rows and an overscan of 10, the default mode mounts a couple of dozen. */
  const MANY: Row[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    name: `Card ${i}`,
    price: i,
  }));

  const draw = (grow: boolean) =>
    render(
      <VirtualTable
        rows={MANY}
        columns={COLUMNS}
        label="Test rows"
        total={MANY.length}
        listKey="k"
        onNeedNextPage={() => {}}
        sort={[]}
        onSort={() => {}}
        grow={grow}
      />,
    );

  /** The header is a `role="row"` too, so a body count is one less than the query's. */
  const bodyRows = () => screen.getAllByRole("row").length - 1;

  it("mounts every row, where the default mounts a window onto them", () => {
    const { unmount } = draw(false);
    const windowed = bodyRows();
    expect(windowed).toBeGreaterThan(0);
    expect(windowed).toBeLessThan(MANY.length);
    unmount();

    draw(true);
    expect(bodyRows()).toBe(MANY.length);
  });

  /**
   * The root stops being a scroll container, and `min-h-0` matters more than the `overflow`: it is
   * the line that tells the flex column this box may be squeezed below its content, which is what
   * turns a full-height table back into a letterbox with a scrollbar in it.
   */
  it("takes the scrollport off its root and leaves the frame", () => {
    draw(true);
    const table = screen.getByRole("table");
    expect(table.className).not.toContain("overflow");
    expect(table.className).not.toContain("min-h-0");
    expect(table.className).not.toContain("flex-1");
    // The frame is not a scrollport and stays: the table still reads as one object.
    expect(table.className).toContain("border");
    // Nothing holds a scrollbar open to a height the rows are not in.
    expect(screen.getByRole("rowgroup").style.height).toBe("");
  });

  /**
   * A row is laid out by the document rather than by the virtualiser — no `transform`, and a
   * `minHeight` rather than a `height`, so a band that grows past its declared `extraHeight` makes
   * the row taller instead of being painted over the row below.
   *
   * **`relative` is not cosmetic**: `TableView` lays its drop indicator and its landed mark over a
   * row with `inset-0`, and in the default mode the virtualiser's own `absolute` is what those
   * overlays resolve against.
   */
  it("lays a row out in flow, positioned and floored rather than fixed and offset", () => {
    draw(true);
    const row = screen.getAllByRole("row")[1];
    expect(row.className).toContain("relative");
    expect(row.className).not.toContain("absolute");
    expect(row.style.transform).toBe("");
    expect(row.style.height).toBe("");
    expect(row.style.minHeight).toBe("44px");
  });

  /** The count assistive tech is told is the list's, not the DOM's — unchanged by the mode, and
   *  worth pinning here because `grow` is the one mode where the two happen to agree. */
  it("still counts the whole list, header included", () => {
    draw(true);
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "101");
  });

  /**
   * **Under `grow` the header pins at `--sticky-top`**, so a page with something of its own laid
   * over its scroller's top edge — the deck editor's floating header bar (issue #577) — can hold
   * the column names below it, and every other page reads the `0px` fallback. jsdom loads no
   * stylesheet and resolves no `var()`, so the class is the fence; `classList.contains`, because
   * it matches whole classes where a substring of `className` would not.
   */
  it("pins its header at the page's --sticky-top rather than at the scroller's edge", () => {
    draw(true);
    const header = screen.getAllByRole("row")[0];
    expect(header.classList.contains("sticky")).toBe(true);
    expect(header.classList.contains("top-[var(--sticky-top,0px)]")).toBe(true);
    expect(header.classList.contains("top-0")).toBe(false);
  });

  /**
   * A table that is its own scroller pins its header to its own top edge, which nothing outside
   * it covers. A custom property inherits down the DOM, so the variable set on an ancestor would
   * float that header down its own list instead — which is why only `grow` reads it.
   */
  it("keeps the header at its own edge while the table is its own scroller", () => {
    draw(false);
    const header = screen.getAllByRole("row")[0];
    expect(header.classList.contains("top-0")).toBe(true);
    expect(header.classList.contains("top-[var(--sticky-top,0px)]")).toBe(false);
  });
});

type Props = ComponentProps<typeof VirtualTable<Row>>;

/**
 * A heading band's row, as these tests spell one: a `Row` that names a shelf. The real callers
 * (the collection's and the wishlist's shelves) use a `kind` union; one optional field is the
 * smallest shape that lets {@link COLUMNS} be reused unchanged.
 */
const shelf = (name: string): Row => ({ id: `shelf:${name}`, name: "", price: 0, shelf: name });
const card = (i: number): Row => ({ id: String(i), name: `Card ${i}`, price: i });

/** Module-stable, as a caller's `useCallback` would be. */
const bandOf = (r: Row) => (r.shelf ? <span>{r.shelf} heading</span> : null);

/** Everything but the list, so a test names only what it is about. */
const BASE = {
  columns: COLUMNS,
  label: "Test rows",
  listKey: "k",
  onNeedNextPage: () => {},
  sort: [] as SortSpec,
  onSort: () => {},
};

/** The row element holding a piece of text — a band's heading or a card's name. */
const rowOf = (text: string) => screen.getByText(text).closest('[role="row"]') as HTMLElement;

/**
 * **Heading bands are the table's second opt-in, and the shelves are their callers** (spec
 * §3.10, §5.8): a folder's heading drawn as one row across every column, above that folder's
 * cards. The deck editor's `TableView` draws the same shape through `renderRow`; this is the
 * table doing it itself, so that a heading can never pick up a row's click, keys, selection
 * colour or drag source by accident.
 *
 * jsdom lays nothing out, but every figure here is an inline style the virtualiser computed from
 * the heights it was told — which is the whole of what "the estimate uses `bandHeight`" means.
 */
describe("VirtualTable with heading bands", () => {
  /** Two shelves, five cards: `Binder` over cards 1–2, `Trade` over cards 3–5. */
  const SHELVED: Row[] = [
    shelf("Binder"),
    card(1),
    card(2),
    shelf("Trade"),
    card(3),
    card(4),
    card(5),
  ];

  const draw = (props: Partial<Props> = {}) =>
    render(<VirtualTable {...BASE} rows={SHELVED} total={5} band={bandOf} {...props} />);

  it("draws a band as one row holding one cell across every column", () => {
    draw();
    const band = rowOf("Binder heading");
    expect(band).toHaveAttribute("data-band");
    expect(band).toHaveAttribute("aria-rowindex", "2");
    const cells = within(band).getAllByRole("cell");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute("aria-colspan", String(COLUMNS.length));
    // One track across rather than the table's three, or the cell is squeezed into the first.
    expect(band.style.gridTemplateColumns).toBe("minmax(0,1fr)");

    // The rows around it are the table's own, and their indices count the band.
    const first = rowOf("Card 1");
    expect(first).not.toHaveAttribute("data-band");
    expect(first).toHaveAttribute("aria-rowindex", "3");
    expect(within(first).getAllByRole("cell")).toHaveLength(COLUMNS.length);
    expect(rowOf("Trade heading")).toHaveAttribute("aria-rowindex", "5");
  });

  /** `aria-rowindex` runs down `rows` counting the bands, so the count has to as well. */
  it("counts every band into aria-rowcount, beside the header and the data rows", () => {
    draw();
    // 5 data rows + 2 bands + the header.
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "8");
  });

  /** Unknown plus anything is unknown. Passes before the change too: a fence, not a driver. */
  it("still says unknown when the count is capped, however many bands there are", () => {
    draw({ total: null });
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "-1");
  });

  it("never hands a band to onActivate, isSelected, rowClassName, renderRow or a cell", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const isSelected = vi.fn((row: Row) => row.id === "none");
    const rowClassName = vi.fn((row: Row) => (row.id === "none" ? "text-dim" : undefined));
    const cell = vi.fn((row: Row) => row.name);
    const renderRow = vi.fn((props: RowRenderProps, row: Row) => (
      <div data-id={row.id} {...props} />
    ));
    draw({
      columns: [{ key: "name", width: "minmax(0,1fr)", header: "Name", cell }],
      onActivate,
      isSelected,
      rowClassName,
      renderRow,
    });

    const bandsAmong = (rows: Row[]) => rows.filter((r) => r.shelf !== undefined);
    // Each was asked — so the empty lists below are not a table that asked nothing at all.
    expect(isSelected).toHaveBeenCalled();
    expect(bandsAmong(isSelected.mock.calls.map(([r]) => r))).toEqual([]);
    expect(rowClassName).toHaveBeenCalled();
    expect(bandsAmong(rowClassName.mock.calls.map(([r]) => r))).toEqual([]);
    expect(cell).toHaveBeenCalled();
    expect(bandsAmong(cell.mock.calls.map(([r]) => r))).toEqual([]);
    expect(renderRow).toHaveBeenCalled();
    expect(bandsAmong(renderRow.mock.calls.map(([, r]) => r))).toEqual([]);

    // The band is the table's drawing, not `renderRow`'s, and it takes none of a row's gestures.
    const band = rowOf("Binder heading");
    expect(band).not.toHaveAttribute("data-id");
    expect(band).not.toHaveAttribute("tabindex");
    await user.click(band);
    fireEvent.keyDown(band, { key: "Enter" });
    fireEvent.keyDown(band, { key: " " });
    expect(onActivate).not.toHaveBeenCalled();

    // A card beside it still opens: the guard is on the band, not on the table.
    fireEvent.keyDown(rowOf("Card 1"), { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toBe(SHELVED[1]);
  });

  /**
   * The no-band mode's own fence, beside the untouched tests above: a `band` that answers `null`
   * for every row — with a `bandHeight` that would move things if it were read — draws exactly
   * the DOM the table draws without the prop. Passes before the change too.
   */
  it("draws exactly what it drew without the prop when every row answers null", () => {
    const without = render(<VirtualTable {...BASE} rows={SHELVED} total={SHELVED.length} />);
    const plain = without.container.innerHTML;
    const table = screen.getByRole("table");
    // No band and no sticky overlay: the header row and the body are the only two children.
    expect(table.children).toHaveLength(2);
    expect(table.querySelector("[data-band]")).toBeNull();
    without.unmount();

    const nulls = render(
      <VirtualTable
        {...BASE}
        rows={SHELVED}
        total={SHELVED.length}
        band={() => null}
        bandHeight={56}
      />,
    );
    expect(nulls.container.innerHTML).toBe(plain);
  });

  it("sizes a band at 40px unless told, and starts the next row where it ends", () => {
    const { unmount } = draw();
    expect(TABLE_BAND_HEIGHT).toBe(40);
    expect(rowOf("Binder heading").style.height).toBe("40px");
    // The first card starts where the band ends, not a row's 44px down.
    expect(rowOf("Card 1").style.transform).toBe("translateY(40px)");
    expect(rowOf("Card 1").style.height).toBe("44px");
    unmount();

    draw({ bandHeight: 56 });
    expect(rowOf("Binder heading").style.height).toBe("56px");
    expect(rowOf("Card 1").style.transform).toBe("translateY(56px)");
    // Band, two cards, then the second band: 56 + 44 + 44.
    expect(rowOf("Trade heading").style.transform).toBe("translateY(144px)");
  });

  /**
   * How a band that needs more room than a heading says so, with one `bandHeight` for all of
   * them: the empty shelf's dashed box is the case the shelves have.
   */
  it("adds a band's extraHeight to its height and keeps it one track tall", () => {
    draw({ extraHeight: (r) => (r.shelf === "Binder" ? 30 : 0) });
    const band = rowOf("Binder heading");
    expect(band.style.height).toBe("70px");
    // A data row with extra is split into a 44px track and the extra; a band is one cell that
    // takes the whole height, so it is not split.
    expect(band.style.gridTemplateRows).toBe("");
    expect(rowOf("Card 1").style.transform).toBe("translateY(70px)");
  });

  /**
   * The virtualiser caches sizes and re-reads them only when `count` changes, so a row that
   * becomes a band at the same index has to be announced — the `heightKey` half of this change.
   */
  it("re-measures when a row becomes a band at the same index", () => {
    const { rerender } = render(
      <VirtualTable {...BASE} rows={[shelf("A"), card(1), card(2)]} total={2} band={bandOf} />,
    );
    // 40 + 44.
    expect(rowOf("Card 2").style.transform).toBe("translateY(84px)");

    rerender(
      <VirtualTable {...BASE} rows={[shelf("A"), shelf("B"), card(2)]} total={1} band={bandOf} />,
    );
    expect(rowOf("B heading").style.height).toBe("40px");
    // 40 + 40, not 40 + 44 from the cache.
    expect(rowOf("Card 2").style.transform).toBe("translateY(80px)");
  });

  it("lays a band out in flow under grow, floored at its height", () => {
    draw({ grow: true });
    const band = rowOf("Binder heading");
    expect(band.className).toContain("relative");
    expect(band.className).not.toContain("absolute");
    expect(band.style.transform).toBe("");
    expect(band.style.height).toBe("");
    expect(band.style.minHeight).toBe("40px");
  });
});

/**
 * **The sticky band names the shelf the reader is scrolled into**, pinned under the column
 * header (spec §3.10, §5.3). CSS `sticky` cannot pin a row here — rows are absolute and
 * translated — so it is an overlay, and what the table owes the caller is one number: the index
 * of the row under the header's bottom edge.
 *
 * **Tested through the real virtualiser rather than a pure helper.** jsdom keeps a `scrollTop`
 * it is given and `fireEvent.scroll` reaches both the virtualiser's listener and this table's,
 * so the index comes out of the same measurements the rows are placed by — band 40, nine cards
 * at 44, band 40, from an origin of 36 (the header, `scrollMargin`).
 */
describe("VirtualTable's sticky band", () => {
  /** A hundred rows, a band every tenth: `S0` over cards 1–9, `S1` over 11–19, and so on. */
  const LONG: Row[] = Array.from({ length: 100 }, (_, i) =>
    i % 10 === 0 ? shelf(`S${i / 10}`) : card(i),
  );

  const drawLong = (props: Partial<Props> = {}) =>
    render(<VirtualTable {...BASE} rows={LONG} total={90} band={bandOf} {...props} />);

  const bar = () => vi.fn((index: number) => <span>Bar {index}</span>);

  it("pins an overlay under the column header, and asks about the row at the top", () => {
    const stickyBand = bar();
    drawLong({ stickyBand });
    expect(stickyBand).toHaveBeenLastCalledWith(0);
    expect(screen.getByText("Bar 0")).toBeInTheDocument();

    const table = screen.getByRole("table");
    const scroller = table.parentElement as HTMLElement;
    const overlay = scroller.querySelector("[data-sticky-band]") as HTMLElement;
    // The scroller's first child, ahead of the table rather than inside it: in flow, so `sticky`
    // works where the rows cannot, and zero tall, so it moves no row.
    expect(scroller.children).toHaveLength(2);
    expect(scroller.children[0]).toBe(overlay);
    expect(scroller.children[1]).toBe(table);
    expect(overlay).toHaveClass("sticky", "h-0", LAYER.header);
    expect(overlay.style.top).toBe(`${TABLE_HEADER_HEIGHT}px`);
    // The table inside keeps its two children, and the scrollport and the frame are the
    // scroller's now. The table carries neither.
    expect(table.children[0]).toBe(screen.getAllByRole("row")[0]);
    expect(table.children[1]).toBe(screen.getByRole("rowgroup"));
    expect(scroller).toHaveClass("min-h-0", "flex-1", "overflow-auto", "border");
    // The table carries neither, and no focus mark either: it is not the stop, the scroller is
    // (see "VirtualTable's own focus mark").
    expect(table).not.toHaveAttribute("class");
    // Rows still count from the header's bottom edge, because the anchor is zero tall.
    expect(rowOf("S0 heading").style.transform).toBe("translateY(0px)");
  });

  /**
   * **The bar may not be owned by the table** (review of f50a19ec). The pages put a path, a Top
   * button and a drop target in it, and a `role="table"` may own rows and row groups only. A
   * generic `div` between them passes ownership through (axe `aria-required-children`,
   * WCAG 1.3.1), so the only fix is for no table to be an ancestor of the bar at all.
   */
  it("keeps the bar's controls out of the table, and the table whole", () => {
    drawLong({ stickyBand: () => <button type="button">Top</button> });
    const button = screen.getByRole("button", { name: "Top" });
    expect(button.closest('[role="table"]')).toBeNull();

    // The table itself still carries everything that made it a table: its name, its count
    // (90 cards + 10 bands + the header), its header row and its rows. The tab stop is not one
    // of them. It belongs to what scrolls, and that is the scroller around the table here (see
    // "puts the tab stop on the element that scrolls…").
    const table = screen.getByRole("table", { name: "Test rows" });
    expect(table).toHaveAttribute("aria-rowcount", "101");
    expect(table).not.toHaveAttribute("tabindex");
    expect(table.parentElement).toHaveAttribute("tabindex", "0");
    expect(within(table).queryByRole("button", { name: "Top" })).toBeNull();
    const [header] = within(table).getAllByRole("row");
    expect(header).toHaveAttribute("aria-rowindex", "1");
    expect(within(header).getAllByRole("columnheader")).toHaveLength(COLUMNS.length);
    const body = within(table).getByRole("rowgroup");
    expect(body.contains(rowOf("Card 1"))).toBe(true);
    expect(body.contains(rowOf("S0 heading"))).toBe(true);
    expect(rowOf("Card 1")).toHaveAttribute("aria-rowindex", "3");
  });

  /**
   * The header and the bar take the top 76px of the scrollport, and a row is 44px, so a
   * focused row can be wholly underneath them. Focusing it would then scroll nothing, because
   * the browser counts it as in view (WCAG 2.4.11). Scroll padding moves that line to the bar's
   * lower edge. It is set only while the bar can be drawn, and never anywhere else.
   *
   * jsdom scrolls nothing into view, so what this pins is the declaration. What it buys needs a
   * browser, and the live pass owns that.
   */
  it("pads the scroll by the header and the bar while the bar is live, and only then", () => {
    const { unmount } = drawLong({ stickyBand: bar() });
    const scroller = () => screen.getByRole("table").parentElement as HTMLElement;
    expect(scroller().style.scrollPaddingTop).toBe(
      `${TABLE_HEADER_HEIGHT + TABLE_BAND_HEIGHT}px`,
    );
    unmount();

    // It follows `bandHeight`, because that is the bar's height.
    const told = drawLong({ stickyBand: bar(), bandHeight: 56 });
    expect(scroller().style.scrollPaddingTop).toBe(`${TABLE_HEADER_HEIGHT + 56}px`);
    told.unmount();

    // Without `stickyBand` the table is the scroller, as it always was, and carries no style.
    const plain = drawLong();
    expect(screen.getByRole("table")).not.toHaveAttribute("style");
    plain.unmount();

    // Under `grow` nothing is drawn, so nothing is padded, and the table is the root again.
    const grown = drawLong({ stickyBand: bar(), grow: true });
    expect(grown.container.firstElementChild).toBe(screen.getByRole("table"));
    expect(screen.getByRole("table")).not.toHaveAttribute("style");
    grown.unmount();

    // Over no rows the bar is not drawn, so there is nothing to pad for.
    render(<VirtualTable {...BASE} rows={[]} total={0} band={bandOf} stickyBand={bar()} />);
    expect(scroller()).not.toHaveAttribute("style");
  });

  /**
   * The row under the header's edge, not the row at the scroller's top: those differ by the
   * header's 36px, and the second is a row the header is already hiding. Both assertions fail if
   * the `+ TABLE_HEADER_HEIGHT` goes — they would read 9 and 10.
   */
  it("follows the scroll to the row under the header's edge", () => {
    const stickyBand = bar();
    drawLong({ stickyBand });
    // The scroller, which with a live bar is the table's parent rather than the table.
    const scroller = screen.getByRole("table").parentElement as HTMLElement;

    // S1's heading starts at 36 + 40 + 9 × 44 = 472, which is the header's edge at 436.
    scroller.scrollTop = 436;
    fireEvent.scroll(scroller);
    expect(stickyBand).toHaveBeenLastCalledWith(10);

    // 64px further, the edge (536) is inside card 11 (512–556): the heading has scrolled away.
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    expect(stickyBand).toHaveBeenLastCalledWith(11);
    expect(screen.getByText("Bar 11")).toBeInTheDocument();
  });

  /**
   * A fence on the `grow` path, which must not move. The whole document is searched rather than
   * the table, since the anchor is never inside the table now.
   */
  it("draws no overlay under grow, where no offset of the table names a row", () => {
    const stickyBand = bar();
    const { container } = drawLong({ stickyBand, grow: true });
    expect(stickyBand).not.toHaveBeenCalled();
    expect(container.querySelector("[data-sticky-band]")).toBeNull();
  });

  /** So the index handed out is always a row of `rows`. */
  it("asks nothing of an empty table", () => {
    const stickyBand = bar();
    const { container } = render(
      <VirtualTable {...BASE} rows={[]} total={0} band={bandOf} stickyBand={stickyBand} />,
    );
    expect(stickyBand).not.toHaveBeenCalled();
    expect(container.querySelector("[data-sticky-band]")).toBeNull();
  });
});

/**
 * The shipped `@custom-variant` lines and `@theme inline` block, lifted out of `packages/ui/index.css`
 * rather than copied here. That way a green result is a statement about the stylesheet that
 * ships, which is `keyboardModality.test.ts`'s rule and the reason it is written this way there.
 */
const APP_VARIANTS = appCss
  .split("\n")
  .filter((l) => l.startsWith("@custom-variant"))
  .join("\n");
const APP_THEME = /@theme inline \{[\s\S]*?\n\}/.exec(appCss)?.[0] ?? "";

interface CompiledRule {
  selector: string;
  declarations: [string, string][];
}

/**
 * Every rule the real Tailwind emits for the classes this element **actually carries**, read
 * off `classList` and not off a constant. A class `cn`'s merge dropped, or a variant Tailwind
 * could not parse, therefore shows up here as a missing rule. A variant Tailwind cannot parse
 * emits nothing, silently.
 */
async function compiledRulesOf(el: Element): Promise<CompiledRule[]> {
  const compiler = await compile(`@import "tailwindcss";\n${APP_THEME}\n${APP_VARIANTS}\n`, {
    base: "/",
    loadStylesheet: (id: string) => {
      if (id !== "tailwindcss") throw new Error(`unexpected stylesheet import: ${id}`);
      return Promise.resolve({
        path: "/tailwindcss/index.css",
        base: "/tailwindcss",
        content: twEntry,
      });
    },
    loadModule: () => Promise.reject(new Error("no JS modules expected")),
  });
  const css = compiler.build(Array.from(el.classList));
  const utilities = css.slice(css.indexOf("@layer utilities"), css.indexOf("@property"));
  return Array.from(utilities.matchAll(/([^{}\n][^{}]*?)\s*\{([^{}]*)\}/g), ([, sel, body]) => ({
    selector: sel.trim(),
    declarations: body
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const at = d.indexOf(":");
        return [d.slice(0, at).trim(), d.slice(at + 1).trim()] as [string, string];
      }),
  }));
}

/**
 * The `outline-*` declarations this element's own compiled rules apply to it **right now**:
 * the selectors are matched against the live DOM, focus and `data-kbd` included. jsdom paints
 * nothing, so this is as near to "what is drawn" as the suite gets. It is the cascade as the
 * shipped rules would run it, one element at a time.
 *
 * **`:focus-visible` is read as `:focus` here, and on purpose.** jsdom's `:focus-visible` is a
 * heuristic over the last event it saw, and that state outlives a test, so an earlier test's
 * click decides it. A `:focus-visible` assertion made here would be about test order.
 * The app does not trust the browser's heuristic either: `data-kbd` is its gate, and
 * every case below drives that attribute explicitly. Only the unescaped pseudo-class is
 * rewritten; `\:focus-visible` inside an escaped class name is part of the name.
 */
function outlineNow(el: Element, rules: CompiledRule[]): Record<string, string> {
  const drawn: Record<string, string> = {};
  for (const { selector, declarations } of rules) {
    if (!el.matches(selector.replace(/(?<!\\):focus-visible/g, ":focus"))) continue;
    for (const [property, value] of declarations) {
      if (property.startsWith("outline")) drawn[property] = value;
    }
  }
  return drawn;
}

/** What the frame draws when the table has the keyboard's focus: 2px of gold over the border. */
const FRAME_RING = {
  "outline-style": "var(--tw-outline-style)",
  "outline-width": "2px",
  "outline-offset": "calc(1px * -1)",
  "outline-color": "var(--accent)",
};

/**
 * **The table's own focus mark is drawn on its frame**: the bordered box a reader sees as the
 * table (live pass 2026-09-26, §11).
 *
 * The `role="table"` element is a tab stop, and until then it drew only the browser's
 * `outline: auto`, around whatever box held the stop. With a sticky band live, that is the list-tall
 * table inside the scroller. Its top edge sat under the sticky header, its bottom was thousands
 * of pixels down, and the ring read as two faint vertical lines. That is no focus indicator
 * (WCAG 2.4.7).
 *
 * jsdom paints nothing, so these cases compile the classes each element really carries with the
 * real Tailwind and ask which rules match the live DOM. Every case also checks the two ways the
 * mark must stay quiet: a keystroke that moved no focus (no `data-kbd`), and a focus that
 * belongs to a row or a control rather than to the table.
 */
describe("VirtualTable's own focus mark", () => {
  const kbd = (on: boolean) =>
    on
      ? document.documentElement.setAttribute(KEYBOARD_MODALITY_ATTR, "")
      : document.documentElement.removeAttribute(KEYBOARD_MODALITY_ATTR);
  afterEach(() => kbd(false));

  const focus = (el: HTMLElement) => act(() => el.focus());

  it("rings the table's own frame while it is its own scroller, and only for the keyboard", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={ROWS} total={2} onActivate={() => {}} />);
    const table = screen.getByRole("table");
    const rules = await compiledRulesOf(table);

    // Reached the way a reader reaches it: the first Tab lands on the table, the scroller.
    await user.tab();
    kbd(true);
    expect(document.activeElement).toBe(table);
    expect(outlineNow(table, rules)).toEqual(FRAME_RING);

    // A keystroke that moved no focus arms nothing, the same gate as every focus mark here.
    kbd(false);
    expect(outlineNow(table, rules)).toEqual({});

    // A row taking focus is the row's to show, and the frame stays as it was.
    kbd(true);
    const row = rowOf("Black Lotus");
    focus(row);
    expect(outlineNow(table, rules)).toEqual({});
  });

  /** `grow` has no scroller, but the table is still its own frame, so the mark is still its own. */
  it("rings the table's own frame under grow too", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={ROWS} total={2} grow />);
    const table = screen.getByRole("table");
    const rules = await compiledRulesOf(table);
    await user.tab();
    kbd(true);
    expect(document.activeElement).toBe(table);
    expect(outlineNow(table, rules)).toEqual(FRAME_RING);
  });

  it("rings the scroller, never the list-tall table, while a sticky band is live", async () => {
    const user = userEvent.setup();
    render(
      <VirtualTable
        {...BASE}
        rows={[shelf("Binder"), card(1), card(2)]}
        total={2}
        band={bandOf}
        onActivate={() => {}}
        stickyBand={() => <button type="button">Top</button>}
      />,
    );
    const table = screen.getByRole("table");
    const scroller = table.parentElement as HTMLElement;
    const scrollerRules = await compiledRulesOf(scroller);

    // The scroller is the stop, so the first Tab lands on it, ahead of the bar's button.
    await user.tab();
    kbd(true);
    expect(document.activeElement).toBe(scroller);
    // The frame the reader sees takes the ring, exactly as the unbanded table's own frame does:
    // the same classes, on the element that holds the focus.
    expect(outlineNow(scroller, scrollerRules)).toEqual(FRAME_RING);
    // The table draws nothing, and nothing can reach it: its edges are the list's, under the
    // header and far below, and it is not a stop.
    expect(table).not.toHaveAttribute("class");
    expect(table).not.toHaveAttribute("tabindex");

    // Not for a keystroke that moved no focus.
    kbd(false);
    expect(outlineNow(scroller, scrollerRules)).toEqual({});

    // Not for a descendant's focus: a row, or the bar's own button, is not the table.
    kbd(true);
    focus(rowOf("Card 1"));
    expect(outlineNow(scroller, scrollerRules)).toEqual({});
    focus(screen.getByRole("button", { name: "Top" }));
    expect(outlineNow(scroller, scrollerRules)).toEqual({});
  });

  /**
   * The brief's other half: this change is the table's and not a row's. A focused row keeps
   * its inset outline, whether or not a band is live.
   */
  it("leaves a focused row's own mark as it was", () => {
    render(
      <VirtualTable
        {...BASE}
        rows={[shelf("Binder"), card(1)]}
        total={1}
        band={bandOf}
        onActivate={() => {}}
        stickyBand={() => null}
      />,
    );
    expect(rowOf("Card 1")).toHaveClass(...FOCUS_INSET.split(" "));
  });

  /**
   * **The element that holds the table's tab stop is the element that scrolls, in both shapes**
   * (live pass 2026-09-26, §11's finding outside the checklist).
   *
   * With a sticky band live, the stop used to be the `role="table"` element *inside* the scroller.
   * Focusing an element scrolls every scroller around it to reveal it, so a Tab onto that
   * list-tall box moved the list from 855 to 191, and a keyboard reader lost their place. Without
   * a band the table is its own scroller, and focusing a scroller never scrolls it; band mode now
   * has the same shape.
   *
   * jsdom scrolls nothing on focus, so the jump itself cannot go red here. What goes red is its
   * cause: which element a real Tab lands on, and whether the table is still a stop at all.
   */
  it("puts the tab stop on the element that scrolls, so a Tab onto the table scrolls nothing", async () => {
    const user = userEvent.setup();

    // The shape band mode is being brought to: the table scrolls, and the table is the stop.
    const plain = render(<VirtualTable {...BASE} rows={ROWS} total={2} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("table"));
    expect(screen.getByRole("table")).toHaveClass("overflow-auto");
    plain.unmount();

    render(
      <VirtualTable
        {...BASE}
        rows={[shelf("Binder"), card(1), card(2)]}
        total={2}
        band={bandOf}
        onActivate={() => {}}
        stickyBand={() => <button type="button">Top</button>}
      />,
    );
    const table = screen.getByRole("table");
    const scroller = table.parentElement as HTMLElement;
    expect(scroller).toHaveClass("overflow-auto");

    // The first Tab lands on the scroller itself, ahead of everything inside it: the bar's
    // button, the sort buttons, the rows.
    await user.tab();
    expect(document.activeElement).toBe(scroller);
    // A stop has to say what it is, so the scroller is a group carrying the table's name. That
    // is the grid wall's shape too: its scroller is a `group` named by the same label.
    expect(scroller).toHaveAttribute("role", "group");
    expect(scroller).toHaveAccessibleName("Test rows");

    // And the table is no longer a stop at all. Walking every stop in turn never lands on it.
    expect(table).not.toHaveAttribute("tabindex");
    const stops: (Element | null)[] = [];
    for (let i = 0; i < 12; i++) {
      await user.tab();
      stops.push(document.activeElement);
    }
    expect(stops).not.toContain(table);
    expect(stops).toContain(screen.getByRole("button", { name: "Top" }));
  });
});

/**
 * **`revealIndex` scrolls a row the virtualiser may not have mounted into view**. The pages need
 * it for a heading that has no element to focus yet: one moved by Move up or down, or Add
 * folder's draft. The line it scrolls to is the one a focused row is held to: clear of the
 * sticky header, and of the sticky band while one is live.
 *
 * Every figure comes from the table's own row arithmetic, and none from the DOM: header 36, band
 * 40, row 44. `LONG` has a band at every tenth index, so row `i` starts at
 * `36 + 40·b + 44·(i − b)`, where `b` counts the bands above it. The viewport is the stubbed
 * 600px.
 */
describe("VirtualTable's revealIndex", () => {
  const LONG: Row[] = Array.from({ length: 100 }, (_, i) =>
    i % 10 === 0 ? shelf(`S${i / 10}`) : card(i),
  );
  const bandsAbove = (i: number) => (i === 0 ? 0 : Math.floor((i - 1) / 10) + 1);
  const startOf = (i: number) => 36 + 40 * bandsAbove(i) + 44 * (i - bandsAbove(i));
  const barLive = () => <span>Bar</span>;

  /**
   * What jsdom withholds from a real scroll. The virtualiser clamps every target to
   * `scrollHeight − clientHeight`, which jsdom reports as 0. And jsdom's `scrollTo` moves
   * nothing. So this gives the scroller a height, and a `scrollTo` that sets `scrollTop` the way
   * a browser's does. The browser's `scroll` event arrives a moment later, so a test fires it
   * itself (`settle`) rather than having it land inside the effect that scrolled.
   */
  const scrollable = (scroller: HTMLElement) => {
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 20_000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      if (options.top !== undefined) scroller.scrollTop = options.top;
    });
    Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo });
    return scrollTo;
  };
  const scrollTo = (scroller: HTMLElement, top: number) => {
    scroller.scrollTop = top;
    fireEvent.scroll(scroller);
  };
  const settle = (scroller: HTMLElement) => fireEvent.scroll(scroller);

  /** The row's top and bottom inside the scrollport, from the virtualiser's own transform. */
  const placeOf = (text: string, scroller: HTMLElement) => {
    const row = rowOf(text);
    const y = Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(row.style.transform)?.[1]);
    const top = y + TABLE_HEADER_HEIGHT - scroller.scrollTop;
    return { top, bottom: top + parseFloat(row.style.height) };
  };

  const drawBanded = (revealIndex: number | null, extra: Partial<Props> = {}) =>
    render(
      <VirtualTable
        {...BASE}
        rows={LONG}
        total={90}
        band={bandOf}
        stickyBand={barLive}
        revealIndex={revealIndex}
        {...extra}
      />,
    );

  it("scrolls a row below the window up until its bottom edge is in view", () => {
    const { rerender } = drawBanded(null);
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);

    rerender(
      <VirtualTable
        {...BASE}
        rows={LONG}
        total={90}
        band={bandOf}
        stickyBand={barLive}
        revealIndex={55}
      />,
    );
    // Row 55 ends at 2476; the window is 600 tall, so the least scroll that shows it is 1876.
    expect(startOf(55) + 44).toBe(2476);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({ top: 1876, behavior: "auto" });
    settle(scroller);
    const { top, bottom } = placeOf("Card 55", scroller);
    expect(top).toBeGreaterThanOrEqual(TABLE_HEADER_HEIGHT + TABLE_BAND_HEIGHT);
    expect(bottom).toBeLessThanOrEqual(600);
  });

  /**
   * The case a browser's own `scrollIntoView` would get wrong, and the reason the reveal runs
   * through the virtualiser: a row under the header and the bar counts as already on screen to
   * the browser.
   */
  it("brings a row hidden under the header and the bar down to just below the bar", () => {
    const { rerender } = drawBanded(null);
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);
    scrollTo(scroller, 2000);

    // Row 45 starts at 1996, above the bar's lower edge at 2000 + 76.
    expect(startOf(45)).toBe(1996);
    rerender(
      <VirtualTable
        {...BASE}
        rows={LONG}
        total={90}
        band={bandOf}
        stickyBand={barLive}
        revealIndex={45}
      />,
    );
    expect(spy).toHaveBeenLastCalledWith({ top: 1996 - 76, behavior: "auto" });
    settle(scroller);
    expect(placeOf("Card 45", scroller).top).toBe(TABLE_HEADER_HEIGHT + TABLE_BAND_HEIGHT);
  });

  /** Without a band there is only the header to clear: the same row lands 40px higher. */
  it("clears only the header when no sticky band is live", () => {
    const { rerender } = render(
      <VirtualTable {...BASE} rows={LONG} total={90} band={bandOf} revealIndex={null} />,
    );
    const scroller = screen.getByRole("table");
    const spy = scrollable(scroller);
    scrollTo(scroller, 2000);

    rerender(<VirtualTable {...BASE} rows={LONG} total={90} band={bandOf} revealIndex={45} />);
    expect(spy).toHaveBeenLastCalledWith({ top: 1996 - 36, behavior: "auto" });
    settle(scroller);
    expect(placeOf("Card 45", scroller).top).toBe(TABLE_HEADER_HEIGHT);
  });

  it("does nothing when the row is already fully in view", () => {
    const { rerender } = drawBanded(null);
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);

    // Row 5 spans 252–296, well inside 76–600 at the top of the list.
    rerender(
      <VirtualTable
        {...BASE}
        rows={LONG}
        total={90}
        band={bandOf}
        stickyBand={barLive}
        revealIndex={5}
      />,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A reveal is a request, answered once. A re-render carrying the same index must not drag
   * the reader back after they have scrolled away. The re-render that tests this is a new page
   * of rows arriving: the pages page constantly, and the length is what the table re-reads.
   * Asking again takes a change: `null`, then the index.
   */
  it("answers a value once, and again only after it changes", () => {
    const { rerender } = drawBanded(null);
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);
    const PAGED: Row[] = [...LONG, ...Array.from({ length: 20 }, (_, i) => card(100 + i))];
    const draw = (revealIndex: number | null, rows = LONG, label = "Test rows") =>
      rerender(
        <VirtualTable
          {...BASE}
          label={label}
          rows={rows}
          total={110}
          band={bandOf}
          stickyBand={barLive}
          revealIndex={revealIndex}
        />,
      );

    draw(55);
    expect(spy).toHaveBeenCalledTimes(1);
    settle(scroller);

    // The reader scrolls back to the top, and the page re-renders: for its own reasons, and
    // because the next page of rows arrived.
    scrollTo(scroller, 0);
    draw(55, LONG, "Test rows, renamed");
    draw(55, PAGED);
    expect(spy).toHaveBeenCalledTimes(1);

    draw(null);
    draw(55);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ top: 1876, behavior: "auto" });
  });

  /** The pages move the caret themselves, after the row has mounted. The table never does. */
  it("moves no focus", () => {
    const view = (revealIndex: number | null) => (
      <>
        <button type="button">Elsewhere</button>
        <VirtualTable
          {...BASE}
          rows={LONG}
          total={90}
          band={bandOf}
          stickyBand={barLive}
          revealIndex={revealIndex}
        />
      </>
    );
    const { rerender } = render(view(null));
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());

    rerender(view(55));
    settle(scroller);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(elsewhere);
  });

  /**
   * Move up and Move down reorder the list without changing its length. The virtualiser
   * recomputes positions only when the length does, so in the commit that moved the heading its
   * positions are the old ones until the table's `measure()` invalidates them. This case is
   * built so the two answers part. With bands every tenth row, row 12 ends at 600, flush with
   * the window, so nothing is needed. With the same hundred rows and no bands, it ends at 608
   * and needs 8px. Judged on the stale positions, the moved row stays cut off.
   */
  it("judges a row at its new place after a reorder that keeps the row count", () => {
    const FLAT: Row[] = Array.from({ length: 100 }, (_, i) => card(i));
    expect(startOf(12) + 44).toBe(600);
    const { rerender } = drawBanded(null);
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);

    rerender(
      <VirtualTable
        {...BASE}
        rows={FLAT}
        total={100}
        band={bandOf}
        stickyBand={barLive}
        revealIndex={12}
      />,
    );
    expect(spy).toHaveBeenLastCalledWith({ top: 36 + 13 * 44 - 600, behavior: "auto" });
  });

  /** A page may name a row before its page of rows has arrived; the reveal waits for it. */
  it("waits for an index past the loaded rows, and reveals it when they arrive", () => {
    const MORE: Row[] = Array.from({ length: 160 }, (_, i) =>
      i % 10 === 0 ? shelf(`S${i / 10}`) : card(i),
    );
    const draw = (rows: Row[]) => (
      <VirtualTable
        {...BASE}
        rows={rows}
        total={144}
        band={bandOf}
        stickyBand={barLive}
        revealIndex={151}
      />
    );
    const { rerender } = render(draw(LONG));
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    const spy = scrollable(scroller);
    rerender(draw(LONG));
    expect(spy).not.toHaveBeenCalled();

    rerender(draw(MORE));
    // Row 151 starts at 36 + 40·16 + 44·135 and is 44 tall; its bottom edge meets the window's.
    expect(spy).toHaveBeenLastCalledWith({ top: startOf(151) + 44 - 600, behavior: "auto" });
  });

  /** Under `grow` the page scrolls, and no offset of this table names a row. */
  it("does nothing under grow", () => {
    const { rerender } = render(
      <VirtualTable {...BASE} rows={LONG} total={90} band={bandOf} grow revealIndex={null} />,
    );
    const spy = scrollable(screen.getByRole("table"));
    rerender(
      <VirtualTable {...BASE} rows={LONG} total={90} band={bandOf} grow revealIndex={55} />,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * **`keepRow` keeps one row drawn wherever the window goes** (final review, S-I3). A shelf heading
 * dragged in the table is a drag source inside a virtualised row. Carried more than the overscan
 * (ten rows) past the window's edge, it unmounted, and the drag went with it: the drag ended, or
 * its floating copy vanished. The grid keeps its carried heading's row the same way
 * (`CardGrid`'s `rangeExtractor`).
 *
 * Positions come from the table's own arithmetic (header 36, band 40, row 44, a band at every
 * tenth row). jsdom keeps a `scrollTop` it is given, and `fireEvent.scroll` moves the window, as
 * in the sticky band's tests.
 */
describe("VirtualTable's kept row", () => {
  const LONG: Row[] = Array.from({ length: 100 }, (_, i) =>
    i % 10 === 0 ? shelf(`S${i / 10}`) : card(i),
  );
  const startOf = (i: number) => {
    const bands = i === 0 ? 0 : Math.floor((i - 1) / 10) + 1;
    return 36 + 40 * bands + 44 * (i - bands);
  };
  const scrollTo = (scroller: HTMLElement, top: number) => {
    scroller.scrollTop = top;
    fireEvent.scroll(scroller);
  };
  const draw = (keepRow: number | null | undefined, extra: Partial<Props> = {}) =>
    render(
      <VirtualTable
        {...BASE}
        rows={LONG}
        total={90}
        band={bandOf}
        stickyBand={() => null}
        keepRow={keepRow}
        {...extra}
      />,
    );
  const scrollerOf = () => screen.getByRole("table").parentElement as HTMLElement;

  /** The premise, and a fence: without a kept row the window lets a far heading go. */
  it("lets a far row go with the window when nothing is kept", () => {
    draw(null);
    expect(screen.getByText("S1 heading")).toBeInTheDocument();
    scrollTo(scrollerOf(), 3000);
    expect(screen.queryByText("S1 heading")).toBeNull();
  });

  it("keeps a row above the window drawn, as the same element, at its own place", () => {
    draw(10);
    const kept = rowOf("S1 heading");
    scrollTo(scrollerOf(), 3000);

    // The window has moved: row 68 starts at 3000. A row between it and the kept one is gone.
    expect(startOf(68)).toBe(3000);
    expect(screen.queryByText("Card 25")).toBeNull();
    expect(screen.getByText("Card 71")).toBeInTheDocument();
    // The kept heading is still there, and it is the element it was: whatever the caller drew
    // inside it (a drag source) was never unmounted.
    expect(rowOf("S1 heading")).toBe(kept);
    expect(kept.style.transform).toBe(`translateY(${startOf(10) - TABLE_HEADER_HEIGHT}px)`);
    // Keyed as every row is, by its index, and placed by the same rules: nothing else changes.
    expect(kept).toHaveAttribute("aria-rowindex", "12");

    scrollTo(scrollerOf(), 0);
    expect(rowOf("S1 heading")).toBe(kept);
  });

  it("keeps a row below the window drawn too", () => {
    draw(95);
    expect(screen.queryByText("Card 60")).toBeNull();
    expect(rowOf("Card 95").style.transform).toBe(
      `translateY(${startOf(95) - TABLE_HEADER_HEIGHT}px)`,
    );
  });

  /**
   * The paging rule reads the last row of the virtualiser's own window. A kept row parked far
   * below that window is not the reader reaching the end of the list. Read as one, a drag held
   * over a heading near the end would load the next page in the middle of the drag.
   */
  it("does not page because a kept row sits near the end of what is loaded", () => {
    const onNeedNextPage = vi.fn();
    draw(95, { onNeedNextPage });
    expect(onNeedNextPage).not.toHaveBeenCalled();
  });

  /** Absent, or `null`, the table is exactly what it was. */
  it("draws exactly what it drew without the prop when nothing is kept", () => {
    const without = render(
      <VirtualTable {...BASE} rows={LONG} total={90} band={bandOf} stickyBand={() => null} />,
    );
    const plain = without.container.innerHTML;
    without.unmount();
    const nulls = draw(null);
    expect(nulls.container.innerHTML).toBe(plain);
  });
});

/**
 * **Top hands the caret on** (final review, S-I1, the table's half). The sticky bar is the page's
 * drawing, and the page draws nothing over a heading, so pressing its Top lands the list on the
 * first heading and takes the bar away with the caret in it. The caret fell to `<body>`, and the
 * next Tab started from the top of the app. It goes to the heading that took the bar's place
 * instead, onto that row's first control, once the scroll has landed.
 */
describe("VirtualTable's sticky band hands the caret on", () => {
  const LONG: Row[] = Array.from({ length: 100 }, (_, i) =>
    i % 10 === 0 ? shelf(`S${i / 10}`) : card(i),
  );
  /** A heading with a control in it, as the pages' headings have (chevron, title). */
  const openBand = (r: Row) => (r.shelf ? <button type="button">Open {r.shelf}</button> : null);

  /**
   * The page's bar: nothing over a heading, and a Top that sets `scrollTop` the way the pages'
   * `scrollToTop` does. The browser's `scroll` event arrives after, so the test fires it.
   */
  const drawWithTop = (band: Props["band"] = openBand) => {
    const bar = (i: number) =>
      LONG[i]?.shelf ? null : (
        <button
          type="button"
          onClick={() => {
            (screen.getByRole("table").parentElement as HTMLElement).scrollTop = 0;
          }}
        >
          Top
        </button>
      );
    render(<VirtualTable {...BASE} rows={LONG} total={90} band={band} stickyBand={bar} />);
    return screen.getByRole("table").parentElement as HTMLElement;
  };

  it("puts the caret on the first heading's first control when Top takes the bar away", async () => {
    const user = userEvent.setup();
    const scroller = drawWithTop();
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);

    const top = screen.getByRole("button", { name: "Top" });
    await user.click(top);
    expect(document.activeElement).toBe(top);

    // The scroll lands at the top; row 0 is S0's heading, so the bar goes with the caret in it.
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Top" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open S0" }));
  });

  /** From far down the window has to move first; the heading is drawn by the time the bar goes. */
  it("does the same from far down the list", async () => {
    const user = userEvent.setup();
    const scroller = drawWithTop();
    scroller.scrollTop = 3000;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Open S0" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Top" }));
    fireEvent.scroll(scroller);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open S0" }));
  });

  /** A heading with nothing to press still keeps the caret in the table: its own stop. */
  it("falls back to the table's own stop when that heading has no control", async () => {
    const user = userEvent.setup();
    const scroller = drawWithTop(bandOf);
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    await user.click(screen.getByRole("button", { name: "Top" }));
    fireEvent.scroll(scroller);
    expect(document.activeElement).toBe(scroller);
  });

  /**
   * The hand-on is a fallback, never a second opinion. If something else claimed the caret in
   * the commit that took the bar away, that claim stands. Here a heading's own layout effect
   * points the caret at a control outside the table as it mounts; the pages' caret machinery is
   * the real case.
   */
  it("leaves a caret that something else claimed in the same commit", async () => {
    const user = userEvent.setup();
    function Claims() {
      useLayoutEffect(() => {
        document.getElementById("claimed")?.focus();
      }, []);
      return null;
    }
    const claimingBand = (r: Row) =>
      r.shelf === "S0" ? (
        <span>
          <Claims />
          <button type="button">Open S0</button>
        </span>
      ) : r.shelf ? (
        <button type="button">Open {r.shelf}</button>
      ) : null;
    render(
      <>
        <button type="button" id="claimed">
          Claimed
        </button>
        <VirtualTable
          {...BASE}
          rows={LONG}
          total={90}
          band={claimingBand}
          stickyBand={(i) =>
            LONG[i]?.shelf ? null : (
              <button
                type="button"
                onClick={() => {
                  (screen.getByRole("table").parentElement as HTMLElement).scrollTop = 0;
                }}
              >
                Top
              </button>
            )
          }
        />
      </>,
    );
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    // Far enough down that S0's heading unmounts, so it mounts again when Top lands.
    scroller.scrollTop = 3000;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Open S0" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Top" }));
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Open S0" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Claimed" }));
  });

  /** Only a caret the bar took with it is handed on; a caret somewhere else is left alone. */
  it("leaves a caret that was never in the bar where it is", () => {
    const view = (
      <>
        <button type="button">Elsewhere</button>
        <VirtualTable
          {...BASE}
          rows={LONG}
          total={90}
          band={openBand}
          stickyBand={(i) => (LONG[i]?.shelf ? null : <button type="button">Top</button>)}
        />
      </>
    );
    render(view);
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("button", { name: "Top" })).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});

/**
 * **The rows are one roving tab stop** (issue #558). Every activatable row was `tabIndex={0}`, so
 * a keyboard reader tabbed through the whole loaded result set to get past the table. Now one data
 * row is the stop, the rest are `-1`, and the arrows, Home, End and Page Up/Down move between
 * them — heading bands skipped, and a control inside a row keeping its own keys.
 */
describe("VirtualTable's roving tab stop", () => {
  const MANY: Row[] = Array.from({ length: 100 }, (_, i) => card(i));
  const stops = () => screen.getAllByRole("row").filter((r) => r.getAttribute("tabindex") === "0");

  it("makes exactly one row a stop, and none without onActivate", () => {
    const { unmount } = render(
      <VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />,
    );
    const body = screen.getAllByRole("row").slice(1);
    expect(body.length).toBeGreaterThan(1);
    expect(stops()).toEqual([rowOf("Card 0")]);
    for (const row of body.slice(1)) expect(row).toHaveAttribute("tabindex", "-1");
    unmount();

    render(<VirtualTable {...BASE} rows={MANY} total={100} />);
    for (const row of screen.getAllByRole("row")) expect(row).not.toHaveAttribute("tabindex");
  });

  /** Tab from `<body>`: the table's own scroll stop, the two sort buttons, the rows' one stop,
   *  then out. */
  it("costs the rows one Tab press in all", async () => {
    const user = userEvent.setup();
    render(
      <>
        <VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />
        <button type="button">After</button>
      </>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("table"));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Price" }));
    await user.tab();
    expect(document.activeElement).toBe(rowOf("Card 0"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("moves the caret and the stop with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />);
    act(() => rowOf("Card 0").focus());

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(rowOf("Card 2"));
    expect(stops()).toEqual([rowOf("Card 2")]);
    expect(rowOf("Card 0")).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rowOf("Card 1"));
    expect(stops()).toEqual([rowOf("Card 1")]);
  });

  /** A click is a focus too, so the stop follows the pointer as well as the keys. */
  it("moves the stop to a row the reader clicks", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />);
    await user.click(rowOf("Card 4"));
    expect(stops()).toEqual([rowOf("Card 4")]);
  });

  it("goes to the first and last rows on Home and End", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={MANY} total={100} grow onActivate={() => {}} />);
    act(() => rowOf("Card 5").focus());

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(rowOf("Card 99"));
    expect(stops()).toEqual([rowOf("Card 99")]);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(rowOf("Card 0"));
    expect(stops()).toEqual([rowOf("Card 0")]);
  });

  it("skips heading bands, and never makes one the stop", async () => {
    const user = userEvent.setup();
    const SHELVED = [shelf("Binder"), card(1), card(2), shelf("Trade"), card(3)];
    render(<VirtualTable {...BASE} rows={SHELVED} total={3} band={bandOf} onActivate={() => {}} />);
    // Row 0 is a band, so the first data row is the stop.
    expect(stops()).toEqual([rowOf("Card 1")]);
    act(() => rowOf("Card 2").focus());

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rowOf("Card 3"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rowOf("Card 2"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(rowOf("Card 1"));
    // Nothing above the first card but its heading: the caret stays put.
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rowOf("Card 1"));
    expect(rowOf("Binder heading")).not.toHaveAttribute("tabindex");
  });

  /**
   * The deck's table draws its piles through `renderRow` — a row with one cell spanning every
   * column — so the table cannot know them from `band`. They are skipped the same way, and a
   * stop that lands on one moves to the first data row.
   */
  it("treats a caller's own heading row the same way", async () => {
    const user = userEvent.setup();
    const PILED = [shelf("Creatures"), card(1), shelf("Lands"), card(2)];
    render(
      <VirtualTable
        {...BASE}
        rows={PILED}
        total={4}
        grow
        onActivate={() => {}}
        renderRow={(props, row) =>
          row.shelf ? (
            <div {...props} tabIndex={-1} onKeyDown={undefined}>
              <span role="cell" aria-colspan={COLUMNS.length}>
                {row.shelf} pile
              </span>
            </div>
          ) : (
            <div {...props} />
          )
        }
      />,
    );
    expect(stops()).toEqual([rowOf("Card 1")]);
    act(() => rowOf("Card 1").focus());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rowOf("Card 2"));
  });

  it("leaves a key pressed inside a row's control to that control", async () => {
    const user = userEvent.setup();
    const columns: TableColumn<Row>[] = [
      ...COLUMNS.slice(0, 1),
      {
        key: "edit",
        width: "4rem",
        header: "Edit",
        interactive: true,
        cell: (r) => <button type="button">Edit {r.name}</button>,
      },
    ];
    render(
      <VirtualTable {...BASE} columns={columns} rows={MANY} total={100} onActivate={() => {}} />,
    );
    const edit = screen.getByRole("button", { name: "Edit Card 3" });
    act(() => edit.focus());
    await user.keyboard("{ArrowDown}{End}");
    expect(document.activeElement).toBe(edit);
    // Focus inside the row still moves the stop to that row, so Shift+Tab lands beside it.
    expect(stops()).toEqual([rowOf("Card 3")]);
  });

  it("leaves a chorded arrow alone", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />);
    act(() => rowOf("Card 0").focus());
    await user.keyboard("{Control>}{ArrowDown}{/Control}{Shift>}{ArrowDown}{/Shift}");
    expect(document.activeElement).toBe(rowOf("Card 0"));
  });

  /**
   * **The virtualisation trap.** The stop's row can scroll out of the drawn window and unmount;
   * with nothing else at `0` the rows would have no way in. The first data row in view stands in.
   */
  it("hands the stop to a row in view when its own row scrolls away", () => {
    render(<VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />);
    act(() => rowOf("Card 0").focus());
    const scroller = screen.getByRole("table");
    scroller.scrollTop = 44 * 50;
    fireEvent.scroll(scroller);
    expect(screen.queryByText("Card 0")).toBeNull();
    const [only] = stops();
    expect(stops()).toHaveLength(1);
    // In view, not merely drawn: the overscan above the scrollport is skipped, and so is Card 49,
    // which is drawn at the scroller's top edge but wholly behind the 36px sticky header.
    expect(only).toBe(rowOf("Card 50"));
  });

  /** A long move scrolls first, and the row takes the caret once the virtualiser draws it. */
  it("scrolls to an undrawn row on End and focuses it once drawn", async () => {
    const user = userEvent.setup();
    render(<VirtualTable {...BASE} rows={MANY} total={100} onActivate={() => {}} />);
    const scroller = screen.getByRole("table");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 44 * 100 + 36 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: (options: ScrollToOptions) => {
        if (options.top !== undefined) scroller.scrollTop = options.top;
      },
    });
    act(() => rowOf("Card 0").focus());
    expect(screen.queryByText("Card 99")).toBeNull();

    await user.keyboard("{End}");
    // The browser's `scroll` event arrives after the scroll; fire it as the page would get it.
    fireEvent.scroll(scroller);
    expect(document.activeElement).toBe(rowOf("Card 99"));
    expect(stops()).toEqual([rowOf("Card 99")]);
  });
});
