import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SortSpec } from "@/lib/sort";
import { VirtualTable, type TableColumn } from "./VirtualTable";

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
