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
