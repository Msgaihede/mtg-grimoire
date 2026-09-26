import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
    // (90 cards + 10 bands + the header), its tab stop, its header row and its rows.
    const table = screen.getByRole("table", { name: "Test rows" });
    expect(table).toHaveAttribute("aria-rowcount", "101");
    expect(table).toHaveAttribute("tabindex", "0");
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
