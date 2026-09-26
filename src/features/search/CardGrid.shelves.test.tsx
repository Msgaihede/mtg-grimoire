import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import { LAYER } from "@/lib/layers";
import {
  SHELF_HEADING_HEIGHT,
  SHELF_INDENT_PX,
  SHELF_RAIL_OFFSET_PX,
  layoutShelves,
  rowHeight,
  type ShelfLayout,
} from "@/lib/shelfLayout";
import { MAX_SHELF_INDENT, type Shelf } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";
import { CardGrid, stickyShelfAt, type GridCard, type GridSections } from "./CardGrid";
import { nextShelfTileIndex } from "./gridNav";

/**
 * **The shelves half of `CardGrid`** — spec 2026-09-26 §5.2–§5.5. `CardGrid.test.tsx` is the flat
 * wall's contract and is untouched by this file; the first block below is the one thing it could
 * not say, which is that a wall given no `sections` draws none of the new machinery at all.
 *
 * jsdom lays nothing out: `src/test-setup.ts` stubs `ResizeObserver` to a no-op, so the wall
 * measures itself at 0px and `columnsFor` floors at **one** column. The two-column block at the
 * bottom stubs `clientWidth` to 400 — the one number `CardGrid` reads its width from — which is
 * what makes a short last row and an arrow across it askable here at all.
 *
 * **Every expectation about layout is derived from `layoutShelves` itself** rather than written
 * out by hand, so this file tests what the wall does *with* a layout and `shelfLayout.test.ts`
 * owns what the layout is.
 */

/**
 * jsdom lays nothing out, so the virtualiser measures a scroll container of zero height and
 * renders an empty window. `@tanstack/react-virtual` sizes it with `offsetHeight` and scrolls it
 * with `Element.scrollTo`, which jsdom does not implement either. `CardGrid.test.tsx`'s shims,
 * verbatim.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  // The tile size and the picked set are module-level store state that outlives a render.
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS }, cardSelection: null });
});

const NO_ROWS: GridCard[] = [];

/** A tile the wall can draw, found afterwards by its name (the art button's accessible name). */
const tile = (id: string, name: string, extra: Partial<GridCard> = {}): GridCard => ({
  id,
  name,
  setCode: "lea",
  collectorNumber: id,
  rarity: "common",
  ...extra,
});

/** A shelf as `buildShelves` would hand it over — a reader's folder at the root unless told. */
function shelf(id: number, name: string, over: Partial<Shelf> = {}): Shelf {
  const depth = over.depth ?? 0;
  return {
    id,
    kind: "folder",
    group: "own",
    name,
    pathIds: [id],
    path: [name],
    depth,
    indent: Math.min(depth, MAX_SHELF_INDENT),
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
    ...over,
  };
}

const BINDER = shelf(1, "Binder");
const STAPLES = shelf(2, "Staples", {
  depth: 1,
  pathIds: [1, 2],
  path: ["Binder", "Staples"],
  lead: ["Binder"],
  leadIds: [1],
});
const FETCHLANDS = shelf(3, "Fetchlands", {
  depth: 2,
  pathIds: [1, 2, 3],
  path: ["Binder", "Staples", "Fetchlands"],
  lead: ["Binder", "Staples"],
  leadIds: [1, 2],
});
const TRADE = shelf(4, "Trade binder");

interface Entry {
  shelf: Shelf;
  tiles: GridCard[];
  /** The shelf's count from `*_shelf_counts`; defaults to what has loaded. */
  count?: number;
}

/** The `sections` a page would build — plain markup in every slot, so a test can find it. */
function shelves(
  entries: Entry[],
  over: Partial<GridSections<GridCard>> = {},
): GridSections<GridCard> {
  const byShelf = new Map(entries.map((e) => [e.shelf.id, e.tiles]));
  return {
    sections: entries.map((e) => ({ shelf: e.shelf, tileCount: e.count ?? e.tiles.length })),
    tilesOf: (id) => byShelf.get(id) ?? [],
    renderHeading: (s) => <h3>{s.name}</h3>,
    renderEmpty: (s) => <p>{`${s.name} is empty`}</p>,
    renderLabel: (group) => <p>{group === "decks" ? "Decks" : "Managed by decks"}</p>,
    renderSticky: () => null,
    ...over,
  };
}

type WallProps = Partial<Parameters<typeof CardGrid<GridCard>>[0]>;

function wall(sections: GridSections<GridCard> | undefined, props: WallProps = {}) {
  const onSelect = vi.fn();
  const onNeedNextPage = vi.fn();
  const view = render(
    <CardGrid
      rows={NO_ROWS}
      sections={sections}
      onSelect={onSelect}
      onNeedNextPage={onNeedNextPage}
      listKey="k"
      label="Your collection"
      zoomSection="collection"
      {...props}
    />,
  );
  return { ...view, onSelect, onNeedNextPage };
}

const art = (name: string) => screen.getByRole("button", { name });
const heading = (name: string) => screen.getByRole("heading", { name });
const rowsDrawn = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-shelf-row]"),
];
const kindsDrawn = (container: HTMLElement) => rowsDrawn(container).map((r) => r.dataset.shelfRow);
const rowOf = (el: Element) => el.closest<HTMLElement>("[data-shelf-row]")!;
const railsOf = (row: HTMLElement) => [
  ...row.querySelectorAll<HTMLElement>(":scope > [data-shelf-rail]"),
];
/** Where the virtualiser put a row — its `translateY`, in px. */
const offsetOf = (row: HTMLElement) =>
  Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);
/** The names of every tile wearing the gold ring, on the tile's root (see `CardGrid.test.tsx`). */
const ringed = () =>
  [...document.querySelectorAll("[data-grid-index].ring-accent")].map((t) =>
    t.querySelector("img")?.getAttribute("alt"),
  );

describe("CardGrid without sections", () => {
  /**
   * **The five walls that never pass `sections` are the wall they were**, and this is the half of
   * that `CardGrid.test.tsx` cannot say: none of the new machinery is in the tree. The wall's only
   * child is still the sizer — no sticky anchor in front of it — and the tiles number 0…n−1.
   */
  it("draws no shelf rows, rails, frames or sticky bar", () => {
    const { container } = wall(undefined, {
      rows: [tile("aaa", "Card A"), tile("bbb", "Card B")],
    });

    expect(
      container.querySelector(
        "[data-shelf-row], [data-shelf-rail], [data-pending-slot], [data-shelf-sticky]",
      ),
    ).toBeNull();
    expect(screen.getByRole("group", { name: "Your collection" }).children).toHaveLength(1);
    expect(
      [...container.querySelectorAll("[data-grid-index]")].map((t) =>
        t.getAttribute("data-grid-index"),
      ),
    ).toEqual(["0", "1"]);
  });

  /**
   * **One printing filed in two folders is two tiles and one open card** (spec §5.6): the
   * collection keys a tile per folder and hands the card-and-finish as `ringKey`, so opening it
   * rings both — and not the nonfoil beside them.
   */
  it("rings every tile that shares the open card's ring key, and only those", () => {
    wall(undefined, {
      rows: [
        tile("bolt", "Bolt in the binder", { key: "bolt:foil@1", ringKey: "bolt:foil" }),
        tile("bolt", "Bolt in the deck box", { key: "bolt:foil@2", ringKey: "bolt:foil" }),
        tile("bolt", "Bolt, nonfoil", { key: "bolt:nonfoil@1", ringKey: "bolt:nonfoil" }),
      ],
      selectedId: "bolt:foil",
    });

    expect(ringed()).toEqual(["Bolt in the binder", "Bolt in the deck box"]);
  });

  /**
   * **A flat wall keys a tile by its slot, exactly as it did before shelves** — so a re-render
   * that keeps a card in its slot keeps its element, and with it whatever state the tile's own
   * controls hold (an open quick-add). A card that *moves* slot is drawn by a different element.
   *
   * Fix round 1 (2026-09-26) is why this is pinned. Under CPU load `CollectionSearchPanel`'s
   * `InAFolder` play clicked a quick-add on an **intermediate** result list (the 300ms debounce
   * fired mid-typing, putting Ancient Tomb in slot 3) and the settled search then drew it alone in
   * slot 0, so the element holding the open popup was unmounted. That is this rule meeting a race
   * in the play, measured identically with HEAD's `CardGrid` — not a change in the flat wall. This
   * test is what says the flat wall's identity is still HEAD's: stable across a refetch, per slot.
   * (jsdom draws one column, so a slot is a row here.)
   */
  it("keeps a tile's element per slot, so only a card that changes slot is redrawn", () => {
    const a = tile("aaa", "Card A");
    const b = tile("bbb", "Card B");
    const flat = (rows: GridCard[]) => (
      <CardGrid
        rows={rows}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        label="Your collection"
        zoomSection="collection"
      />
    );
    const { rerender } = render(flat([a, b]));
    const tileOf = (name: string) => art(name).closest("[data-grid-index]")!;
    const bBefore = tileOf("Card B");

    // A refetch: fresh objects and a fresh array, the same cards in the same slots.
    rerender(flat([{ ...a }, { ...b }]));
    expect(tileOf("Card B")).toBe(bBefore);

    // The settled search: Card B alone, now in slot 0 — a different slot, so a different element.
    rerender(flat([{ ...b }]));
    expect(tileOf("Card B")).not.toBe(bBefore);
    expect(tileOf("Card B").getAttribute("data-grid-index")).toBe("0");
    expect(bBefore.isConnected).toBe(false);
  });

  /** The ring widened; the picked set did not. A press picks *this* tile on *this* shelf. */
  it("keeps the picked set on the tile key, not on the ring key", async () => {
    wall(undefined, {
      rows: [
        tile("bolt", "Bolt in the binder", { key: "bolt:foil@1", ringKey: "bolt:foil" }),
        tile("bolt", "Bolt in the deck box", { key: "bolt:foil@2", ringKey: "bolt:foil" }),
      ],
      selectionScope: "collection",
    });

    await userEvent.click(art("Bolt in the deck box"));

    expect(useAppStore.getState().cardSelection?.keys).toEqual(["bolt:foil@2"]);
  });
});

describe("CardGrid shelves", () => {
  /** The layout's rows, with the starts the virtualiser would give them at a 100px tile pitch. */
  function itemsOf(layout: ShelfLayout) {
    let start = 0;
    return layout.rows.map((row, index) => {
      const item = { index, start };
      start += rowHeight(row, 100);
      return item;
    });
  }

  it("draws a heading for each shelf in shelf order, with that shelf's tiles under it", () => {
    const s = shelves([
      { shelf: BINDER, tiles: [tile("a", "Card A"), tile("b", "Card B")] },
      { shelf: STAPLES, tiles: [tile("c", "Card C")] },
    ]);
    const { container } = wall(s);

    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Binder",
      "Staples",
    ]);
    // Row for row what the layout says — five rows, every one inside the 600px window.
    expect(kindsDrawn(container)).toEqual(layoutShelves(s.sections, 1).rows.map((r) => r.kind));
    const order = rowsDrawn(container);
    const at = (el: Element) => order.indexOf(rowOf(el));
    expect(at(heading("Binder"))).toBeLessThan(at(art("Card A")));
    expect(at(art("Card B"))).toBeLessThan(at(heading("Staples")));
    expect(at(heading("Staples"))).toBeLessThan(at(art("Card C")));
    // The walk's number, in shelf order across the shelves.
    expect(
      ["Card A", "Card B", "Card C"].map((n) =>
        art(n).closest("[data-grid-index]")?.getAttribute("data-grid-index"),
      ),
    ).toEqual(["0", "1", "2"]);
  });

  it("draws headings, empty boxes and labels through the caller's own slots", () => {
    const spare = shelf(5, "Spare");
    const atraxa = shelf(40, "Atraxa", { kind: "deck", group: "decks" });
    const s = shelves([
      { shelf: BINDER, tiles: [tile("a", "Card A")] },
      { shelf: spare, tiles: [] },
      { shelf: atraxa, tiles: [tile("x", "Card X")] },
    ]);
    const { container } = wall(s);

    const kinds = layoutShelves(s.sections, 1).rows.map((r) => r.kind);
    expect(kindsDrawn(container)).toEqual(kinds);
    // A folder with no cards and no subfolders is an empty box, and the decks are under a label.
    expect(kinds).toContain("empty");
    expect(kinds).toContain("label");
    expect(screen.getByText("Spare is empty")).toBeInTheDocument();
    expect(screen.getByText("Decks")).toBeInTheDocument();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Binder",
      "Spare",
      "Atraxa",
    ]);
  });

  /**
   * A shelf whose count is ahead of its pages — the ordinary state of a wall mid-scroll, and the
   * whole wall before the first page lands. The frame holds the slot so nothing reflows when the
   * card arrives, and it is not a tile: nothing to press, nothing to walk onto, nothing announced.
   */
  it("draws an empty frame, with nothing to press, for a tile whose page has not landed", () => {
    const { container } = wall(
      shelves([{ shelf: BINDER, tiles: [tile("a", "Card A")], count: 3 }]),
    );

    const frames = [...container.querySelectorAll<HTMLElement>("[data-pending-slot]")];
    expect(frames.map((f) => f.dataset.pendingSlot)).toEqual(["1", "2"]);
    for (const frame of frames) {
      expect(frame).toHaveAttribute("aria-hidden", "true");
      expect(frame.querySelector("button")).toBeNull();
      expect(frame.closest("[data-grid-index]")).toBeNull();
    }
    expect(container.querySelectorAll("[data-grid-index]")).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  /**
   * Spec §3.3: 32px a level and one 1px rail per level, under the parent's chevron — and a rail
   * drawn per *row* has to reach the next row's top, or a nested shelf reads as a dotted line.
   */
  it("indents a nested shelf and draws one continuous rail per level", () => {
    const { container } = wall(
      shelves([
        { shelf: BINDER, tiles: [tile("a", "Card A")] },
        { shelf: STAPLES, tiles: [tile("b", "Card B")] },
        { shelf: FETCHLANDS, tiles: [tile("c", "Card C")] },
      ]),
    );

    const lead = (row: HTMLElement) => parseFloat(row.style.paddingLeft || "0");
    for (const row of [heading("Binder"), art("Card A")].map(rowOf)) {
      expect(railsOf(row)).toHaveLength(0);
      expect(lead(row)).toBe(0);
    }
    // jsdom measures the wall at 0px, so the gutter is 0 and a row's left edge is its indent alone.
    for (const row of [heading("Staples"), art("Card B")].map(rowOf)) {
      expect(railsOf(row).map((r) => parseFloat(r.style.left))).toEqual([SHELF_RAIL_OFFSET_PX]);
      expect(lead(row)).toBe(SHELF_INDENT_PX);
    }
    for (const row of [heading("Fetchlands"), art("Card C")].map(rowOf)) {
      expect(railsOf(row).map((r) => parseFloat(r.style.left))).toEqual([
        SHELF_RAIL_OFFSET_PX,
        SHELF_INDENT_PX + SHELF_RAIL_OFFSET_PX,
      ]);
      expect(lead(row)).toBe(2 * SHELF_INDENT_PX);
    }
    const drawn = rowsDrawn(container);
    drawn.slice(0, -1).forEach((row, i) => {
      for (const rail of railsOf(row)) {
        expect(offsetOf(row) + parseFloat(rail.style.height)).toBe(offsetOf(drawn[i + 1]));
      }
    });
  });

  /** Spec §5.2: ctrl+wheel resizes the tiles; a heading is chrome and keeps its own height. */
  it("zooms the tiles and leaves every heading its own height", () => {
    wall(
      shelves([
        { shelf: BINDER, tiles: [tile("a", "Card A")] },
        { shelf: STAPLES, tiles: [tile("b", "Card B")] },
      ]),
    );
    const tileHeightBefore = parseFloat(rowOf(art("Card A")).style.height);
    expect(parseFloat(rowOf(heading("Staples")).style.height)).toBe(SHELF_HEADING_HEIGHT);

    act(() => {
      useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, collection: 2 } });
    });

    expect(parseFloat(rowOf(art("Card A")).style.height)).toBeGreaterThan(tileHeightBefore);
    const staples = rowOf(heading("Staples"));
    expect(parseFloat(staples.style.height)).toBe(SHELF_HEADING_HEIGHT);
    expect(offsetOf(rowOf(art("Card B"))) - offsetOf(staples)).toBe(SHELF_HEADING_HEIGHT);
  });

  /**
   * The paging rule over a layout: the next page is wanted once the slot after the last loaded
   * tile is on screen. A shelf's count makes that slot's row known before its page exists.
   */
  it("asks for the next page once the first unloaded slot is drawn", () => {
    const { container, onNeedNextPage } = wall(
      shelves([
        { shelf: BINDER, tiles: [tile("a", "Card A"), tile("b", "Card B")] },
        { shelf: TRADE, tiles: [tile("c", "Card C")], count: 3 },
      ]),
    );

    expect(container.querySelector('[data-pending-slot="3"]')).not.toBeNull();
    expect(onNeedNextPage).toHaveBeenCalled();
  });

  it("does not ask while the unloaded boundary is still below the window", () => {
    const eight = Array.from({ length: 8 }, (_, i) => tile(`a${i}`, `Card A${i}`));
    const { container, onNeedNextPage } = wall(
      shelves([
        { shelf: BINDER, tiles: eight },
        { shelf: TRADE, tiles: [], count: 2 },
      ]),
    );

    // The window holds the heading and the first five tiles; the boundary is ten rows down.
    expect(container.querySelector("[data-pending-slot]")).toBeNull();
    expect(onNeedNextPage).not.toHaveBeenCalled();
  });

  /**
   * A collapsed shelf is its heading alone, and `layoutShelves` gives it no slots — so the tiles a
   * page still holds for it (the previous query's rows, kept on screen while a fold refetches) must
   * not be drawn. Read naively they land in the *next* shelf's first slots, under its heading.
   */
  it("draws nothing of a collapsed shelf, even with tiles still loaded for it", () => {
    const { container } = wall(
      shelves([
        { shelf: { ...BINDER, collapsed: true }, tiles: [tile("a", "Card A")] },
        { shelf: TRADE, tiles: [], count: 1 },
      ]),
    );

    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Binder",
      "Trade binder",
    ]);
    expect(screen.queryByRole("button", { name: "Card A" })).toBeNull();
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-pending-slot]")].map(
        (f) => f.dataset.pendingSlot,
      ),
    ).toEqual(["0"]);
  });

  it("rings a printing on every shelf it is filed on", () => {
    wall(
      shelves([
        {
          shelf: BINDER,
          tiles: [tile("bolt", "Bolt in the binder", { key: "bolt:foil@1", ringKey: "bolt:foil" })],
        },
        {
          shelf: TRADE,
          tiles: [
            tile("bolt", "Bolt in the trade binder", { key: "bolt:foil@4", ringKey: "bolt:foil" }),
            tile("bolt", "Bolt, nonfoil", { key: "bolt:nonfoil@4", ringKey: "bolt:nonfoil" }),
          ],
        },
      ]),
      { selectedId: "bolt:foil" },
    );

    expect(ringed()).toEqual(["Bolt in the binder", "Bolt in the trade binder"]);
  });

  /**
   * The sticky bar's wiring at rest (spec §5.3): the anchor is the wall's first child, `sticky` on
   * `LAYER.header`; at the top of the wall there is no shelf to name, because the first heading is
   * on screen whole; and the `scrollToTop` it is handed scrolls **this** scroller to 0.
   */
  it("hands the sticky bar no shelf at rest, and a way back to the top", () => {
    const renderSticky = vi.fn<GridSections<GridCard>["renderSticky"]>(() => null);
    const { container } = wall(
      shelves(
        [
          { shelf: BINDER, tiles: [tile("a", "Card A"), tile("b", "Card B")] },
          { shelf: STAPLES, tiles: [tile("c", "Card C")] },
        ],
        { renderSticky },
      ),
    );
    const group = screen.getByRole("group", { name: "Your collection" });
    const anchor = container.querySelector<HTMLElement>("[data-shelf-sticky]")!;

    expect(group.firstElementChild).toBe(anchor);
    expect(anchor.classList.contains("sticky")).toBe(true);
    expect(anchor.classList.contains("top-0")).toBe(true);
    expect(anchor.classList.contains(LAYER.header)).toBe(true);

    const [named, toTop] = renderSticky.mock.lastCall!;
    expect(named).toBeNull();

    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();
    act(() => toTop());
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(scrollTo.mock.contexts).toContain(group);
  });

  /**
   * **`top-0` is not the top in Chromium**: a sticky box pins at its scroller's *padding* edge —
   * measured 2026-09-26 in headless Edge, 12px down in a `p-3` scroller and 20px down in `main`'s
   * `p-5` — so the anchor takes the scroller's padding back off as a negative `top`, which pinned
   * both flush at 0. jsdom has no stylesheet, so the padding is put inline and the wall is told its
   * scroller resized, which is the moment it re-reads; every other observer is left alone.
   */
  it("pins the sticky bar flush by taking the scroller's padding off its top", () => {
    const observed = new Map<Element, ResizeObserverCallback[]>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
        observe(el: Element) {
          observed.set(el, [...(observed.get(el) ?? []), this.cb]);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      const { container } = wall(shelves([{ shelf: BINDER, tiles: [tile("a", "Card A")] }]));
      const group = screen.getByRole("group", { name: "Your collection" });
      const anchor = container.querySelector<HTMLElement>("[data-shelf-sticky]")!;
      // No padding to correct for, so the plain `top-0` stands.
      expect(anchor.style.top).toBe("");

      group.style.paddingTop = "20px";
      act(() => observed.get(group)?.forEach((cb) => cb([], {} as ResizeObserver)));

      expect(anchor.style.top).toBe("-20px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * The same wiring, driven by a real `scroll` event: jsdom stores `scrollTop` and the virtualiser
   * reads it on `scroll`, so the only thing faked is that nothing actually moved on a screen. The
   * offsets are read off the rows the wall drew rather than typed, so a change to the tile's pitch
   * cannot turn this into a test of the wrong row. The `+ 12` is the wall's own `p-3`.
   *
   * The virtualiser's trailing is-scrolling reset is a 150ms timer that fires after this test has
   * unmounted, where it updates nothing.
   */
  it("tells the sticky bar which shelf the reader has scrolled into", () => {
    const renderSticky = vi.fn<GridSections<GridCard>["renderSticky"]>(() => null);
    wall(
      shelves(
        [
          { shelf: BINDER, tiles: [tile("a", "Card A"), tile("b", "Card B")] },
          { shelf: STAPLES, tiles: [tile("c", "Card C")] },
        ],
        { renderSticky },
      ),
    );
    const group = screen.getByRole("group", { name: "Your collection" });
    const insideB = offsetOf(rowOf(art("Card B"))) + 12 + 10;
    const insideC = offsetOf(rowOf(art("Card C"))) + 12 + 10;

    group.scrollTop = insideB;
    fireEvent.scroll(group);
    expect(renderSticky.mock.lastCall?.[0]?.name).toBe("Binder");

    group.scrollTop = insideC;
    fireEvent.scroll(group);
    expect(renderSticky.mock.lastCall?.[0]?.name).toBe("Staples");
  });

  /**
   * **The pure piece of the sticky bar** — `stickyShelfAt`, over a real layout and the starts the
   * virtualiser would give it. jsdom has no layout, so this is where "which shelf is the reader
   * inside" is asked row by row; the test above only proves the wall is wired to it.
   */
  it("names the shelf whose rows are under the bar's edge, and nothing while a heading shows whole", () => {
    const layout = layoutShelves(
      [
        { shelf: BINDER, tileCount: 2 },
        { shelf: STAPLES, tileCount: 1 },
      ],
      1,
    );
    const items = itemsOf(layout);
    const headingStart = (id: number) =>
      items[layout.rows.findIndex((r) => r.kind === "heading" && r.shelf.id === id)].start;
    const staples = headingStart(STAPLES.id);
    const last = items[items.length - 1].start;

    expect(stickyShelfAt(layout, items, -12)).toBeNull();
    expect(stickyShelfAt(layout, items, 0)).toBeNull();
    expect(stickyShelfAt(layout, items, 10)?.id).toBe(BINDER.id);
    expect(stickyShelfAt(layout, items, staples - 1)?.id).toBe(BINDER.id);
    expect(stickyShelfAt(layout, items, staples)).toBeNull();
    expect(stickyShelfAt(layout, items, staples + 1)?.id).toBe(STAPLES.id);
    expect(stickyShelfAt(layout, items, last + 1)?.id).toBe(STAPLES.id);
  });

  /** An opened folder's own cards sit under the path row with no heading (spec §3.1) — and so
   *  under no bar either, until the first subfolder's heading has scrolled past. */
  it("names nothing above the first heading", () => {
    const opened = shelf(1, "Binder", { headless: true });
    const sub = shelf(2, "Staples");
    const layout = layoutShelves(
      [
        { shelf: opened, tileCount: 2 },
        { shelf: sub, tileCount: 1 },
      ],
      1,
    );
    const items = itemsOf(layout);
    const subStart =
      items[layout.rows.findIndex((r) => r.kind === "heading" && r.shelf.id === sub.id)].start;

    expect(stickyShelfAt(layout, items, 50)).toBeNull();
    expect(stickyShelfAt(layout, items, subStart + 1)?.id).toBe(sub.id);
  });

  /** The same wall re-rendered with a different `sections` — what a page does when it sets
   *  `revealShelfId`. */
  const revealWall = (sections: GridSections<GridCard>) => (
    <CardGrid
      rows={NO_ROWS}
      sections={sections}
      onSelect={vi.fn()}
      onNeedNextPage={vi.fn()}
      listKey="k"
      label="Your collection"
      zoomSection="collection"
    />
  );
  const eightThenTrade = () =>
    shelves([
      { shelf: BINDER, tiles: Array.from({ length: 8 }, (_, i) => tile(`a${i}`, `Card A${i}`)) },
      { shelf: TRADE, tiles: [tile("t", "Card T")] },
    ]);

  /**
   * **The one piece of scroll geometry the virtualiser reads that the shims above do not give it.**
   * `@tanstack/virtual-core` clamps every scroll it makes to `scrollHeight − clientHeight`
   * (`getMaxScrollOffset`), and jsdom reports both as `0` — so without this a scroll to anything
   * below the fold is clamped to the top before `scrollTo` is called, and the reveal below would
   * assert about a `0` that no browser produces. A browser's own numbers, on this wall only: the
   * sizer plus the wall's `p-3` either side, over the 600px window `offsetHeight` already claims.
   */
  const giveScrollExtent = () => {
    const group = screen.getByRole("group", { name: "Your collection" });
    const sizer = group.lastElementChild as HTMLElement;
    Object.defineProperty(group, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(group, "scrollHeight", {
      configurable: true,
      value: parseFloat(sizer.style.height) + 24,
    });
  };

  /**
   * **Add folder opens a placeholder heading, and its name field must not be below the fold.** The
   * page names the new shelf in `revealShelfId`; the wall scrolls that heading's row into view
   * through the virtualiser — "nearest", so it lands flush with the bottom edge — and does it once
   * per id, so a later re-render (a page landing) cannot drag the reader back to it.
   *
   * The heading is ten rows down and not drawn. Where it *is* is computed from the layout at the
   * pitch the wall really draws (two tile rows' offsets apart), so the assertion is "the scroll
   * that was asked for puts that row inside the 600px window", not a typed number.
   */
  it("scrolls a revealed shelf's heading into view, once", () => {
    const s = eightThenTrade();
    const { rerender } = render(revealWall(s));
    giveScrollExtent();
    const pitch = offsetOf(rowOf(art("Card A1"))) - offsetOf(rowOf(art("Card A0")));
    const layout = layoutShelves(s.sections, 1);
    const at = layout.rows.findIndex((r) => r.kind === "heading" && r.shelf.id === TRADE.id);
    const start = layout.rows.slice(0, at).reduce((sum, r) => sum + rowHeight(r, pitch), 0);
    expect(screen.queryByRole("heading", { name: "Trade binder" })).toBeNull();

    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();
    rerender(revealWall({ ...s, revealShelfId: TRADE.id }));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    const top = (scrollTo.mock.lastCall?.[0] as ScrollToOptions | undefined)?.top;
    expect(top).toBeGreaterThan(0);
    expect(top!).toBeLessThanOrEqual(start);
    expect(top! + 600).toBeGreaterThanOrEqual(start + SHELF_HEADING_HEIGHT);

    // The same id again, after a page lands — which is a fresh `tilesOf`, so a new layout and the
    // effect runs again — scrolls nothing. (A fresh wrapper object alone would not re-run it at
    // all, and would pass whether or not the reveal remembers what it did.)
    scrollTo.mockClear();
    rerender(revealWall({ ...s, tilesOf: (id) => s.tilesOf(id), revealShelfId: TRADE.id }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  /** An id the layout does not hold — a folder deleted in another window, a shelf filtered out —
   *  is not an error and not a scroll. `null` is the resting state and does nothing either. */
  it("does nothing for a shelf that is not in the layout", () => {
    const s = eightThenTrade();
    const { rerender } = render(revealWall(s));
    giveScrollExtent();
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    rerender(revealWall({ ...s, revealShelfId: 999 }));
    rerender(revealWall({ ...s, revealShelfId: null }));

    expect(scrollTo).not.toHaveBeenCalled();
  });
});

/**
 * **Two columns**, by stubbing the one width `CardGrid` measures (`clientWidth` on its rows box):
 * `columnsFor(400, 170)` is 2. Everything here is about a short last row, which a one-column wall
 * cannot have.
 */
describe("CardGrid shelves across two columns", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 400 });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  const TWO = () =>
    shelves([
      {
        shelf: BINDER,
        tiles: [tile("a1", "Card A1"), tile("a2", "Card A2"), tile("a3", "Card A3")],
      },
      { shelf: TRADE, tiles: [tile("b1", "Card B1"), tile("b2", "Card B2")] },
    ]);

  /**
   * One column count for every shelf, so it has to be one the most-indented shelf can still draw:
   * it is taken over the wall less the deepest indent. At 400px two columns fit a shelf at the
   * root, and `Fetchlands` two levels down leaves 336px — one column — so the root shelf draws one
   * across as well rather than two that the nested one could not.
   */
  it("takes the column count over what the deepest shelf leaves", () => {
    const { container } = wall(
      shelves([
        { shelf: BINDER, tiles: [tile("a1", "Card A1"), tile("a2", "Card A2")] },
        { shelf: FETCHLANDS, tiles: [tile("c1", "Card C1")] },
      ]),
    );

    expect(rowOf(art("Card A1"))).not.toBe(rowOf(art("Card A2")));
    expect(
      rowsDrawn(container)
        .filter((r) => r.dataset.shelfRow === "tiles")
        .map((r) => r.querySelectorAll("[data-grid-index]").length),
    ).toEqual([1, 1, 1]);
  });

  it("breaks a shelf's last row short rather than starting the next shelf in it", () => {
    const { container } = wall(TWO());

    const tileRows = rowsDrawn(container).filter((r) => r.dataset.shelfRow === "tiles");
    expect(tileRows.map((r) => r.querySelectorAll("[data-grid-index]").length)).toEqual([2, 1, 2]);
    expect(rowOf(art("Card A1"))).toBe(rowOf(art("Card A2")));
    expect(rowOf(art("Card A3"))).not.toBe(rowOf(art("Card B1")));
  });

  /**
   * Right from the end of a short row goes to the next shelf's first card (spec §5.4: Left/Right
   * walk the depth-first order), and Up from there goes wherever `nextShelfTileIndex` says — the
   * wall's job is to follow the table and take the caret along, which is what is asserted.
   */
  it("walks across a short row into the next shelf with the arrow keys", async () => {
    const { container, onSelect } = wall(TWO(), { arrowNav: true });

    art("Card A3").focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onSelect).toHaveBeenLastCalledWith("b1", expect.objectContaining({ id: "b1" }));
    expect(document.activeElement).toBe(art("Card B1"));

    const up = nextShelfTileIndex(layoutShelves(TWO().sections, 2), 3, "ArrowUp");
    expect(up).not.toBeNull();
    await userEvent.keyboard("{ArrowUp}");

    expect(document.activeElement).toBe(container.querySelector(`[data-grid-index="${up}"] button`));
  });

  /** One `setup()` session, or the Shift is released before the click lands (`src/CLAUDE.md`). */
  it("takes a Shift range across shelves in the order the wall draws them", async () => {
    wall(TWO(), { selectionScope: "collection" });
    const user = userEvent.setup();

    await user.click(art("Card A1"));
    await user.keyboard("{Shift>}");
    await user.click(art("Card B2"));
    await user.keyboard("{/Shift}");

    expect(useAppStore.getState().cardSelection?.keys).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect(document.querySelectorAll("[data-grid-index].ring-accent")).toHaveLength(5);
  });
});
