import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { shelfCarry } from "@/features/shelves/shelfCarry";
import { stickyShelfAt } from "@/features/shelves/shelfRows";
import { useFoldAnchor } from "@/features/shelves/useFoldAnchor";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import { LAYER } from "@/lib/layers";
import {
  SHELF_EMPTY_HEIGHT,
  SHELF_HEADING_HEIGHT,
  SHELF_INDENT_PX,
  SHELF_RAIL_OFFSET_PX,
  SHELF_STICKY_HEIGHT,
  layoutShelves,
  rowHeight,
  rowStartOf,
  type LayoutRow,
  type ShelfLayout,
} from "@/lib/shelfLayout";
import { MAX_SHELF_INDENT, type Shelf } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";
import { CardGrid, type GridCard, type GridSections } from "./CardGrid";
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
   * **Top takes the bar away, so it has to hand the caret on** — final review S-I1. At the top of
   * the wall the bar names nothing and is not drawn, so a Top pressed from the keyboard dropped the
   * caret on `<body>` the moment its own scroll landed. It goes to the wall's first control instead:
   * the first drawn row's, once the scroll has drawn it.
   */
  it("puts the caret on the wall's first control when Top's scroll takes the bar away", async () => {
    const s = shelves(
      [
        { shelf: BINDER, tiles: [tile("a", "Card A"), tile("b", "Card B")] },
        { shelf: STAPLES, tiles: [tile("c", "Card C")] },
      ],
      {
        renderHeading: (sh) => <button type="button">{`Open ${sh.name}`}</button>,
        renderSticky: (sh, toTop) =>
          sh && (
            <button type="button" onClick={toTop}>
              Top
            </button>
          ),
      },
    );
    wall(s);
    const group = screen.getByRole("group", { name: "Your collection" });
    group.scrollTop = offsetOf(rowOf(art("Card B"))) + 12 + 10;
    fireEvent.scroll(group);
    const top = screen.getByRole("button", { name: "Top" });
    const user = userEvent.setup();

    await user.click(top);
    expect(document.activeElement).toBe(top); // the scroll has not landed: the bar is still here

    group.scrollTop = 0;
    fireEvent.scroll(group);

    expect(screen.queryByRole("button", { name: "Top" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Binder" }));
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

  /** Where a row starts at the pitch the wall draws, in the virtualiser's coordinates. */
  const startOf = (s: GridSections<GridCard>, pitch: number, pick: (r: LayoutRow) => boolean) => {
    const layout = layoutShelves(s.sections, 1);
    return rowStartOf(layout, layout.rows.findIndex(pick), pitch);
  };
  const eightOf = (p: string) =>
    Array.from({ length: 8 }, (_, i) => tile(`${p}${i}`, `Card ${p}${i}`));

  /**
   * **A row brought into view from above lands below the sticky bar** — final review S-M2, and the
   * re-check's check H (headings revealed half under the bar). On a sectioned wall the
   * virtualiser's scroll padding at the start is the bar's height, so a reveal or an arrow walk
   * that aligns a row to the top puts it under the bar's bottom edge rather than behind it.
   */
  it("reveals a heading above the window below the sticky bar", () => {
    const middle = shelf(6, "Middle");
    const s = shelves([
      { shelf: BINDER, tiles: eightOf("a") },
      { shelf: middle, tiles: eightOf("m") },
      { shelf: TRADE, tiles: eightOf("t") },
    ]);
    const { rerender } = render(revealWall(s));
    giveScrollExtent();
    const pitch = offsetOf(rowOf(art("Card a1"))) - offsetOf(rowOf(art("Card a0")));
    const group = screen.getByRole("group", { name: "Your collection" });
    group.scrollTop = 99999;
    fireEvent.scroll(group);
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    rerender(revealWall({ ...s, revealShelfId: middle.id }));

    const heading = startOf(s, pitch, (r) => r.kind === "heading" && r.shelf.id === middle.id);
    expect((scrollTo.mock.lastCall?.[0] as ScrollToOptions).top).toBe(
      heading - SHELF_STICKY_HEIGHT,
    );
  });

  /**
   * **A revealed heading brings its empty box with it** — final review S-M5. Add folder reveals the
   * new folder's heading, and a new folder is empty: the dashed box the reader is about to drop on
   * sat below the fold under a heading that had only just come into view.
   */
  it("reveals an empty shelf's box along with its heading", () => {
    const spare = shelf(5, "Spare");
    const s = shelves([
      { shelf: BINDER, tiles: eightOf("a") },
      { shelf: spare, tiles: [] },
    ]);
    const { rerender } = render(revealWall(s));
    giveScrollExtent();
    const pitch = offsetOf(rowOf(art("Card a1"))) - offsetOf(rowOf(art("Card a0")));
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    rerender(revealWall({ ...s, revealShelfId: spare.id }));

    const box = startOf(s, pitch, (r) => r.kind === "empty" && r.shelf.id === spare.id);
    const top = (scrollTo.mock.lastCall?.[0] as ScrollToOptions).top!;
    // The box's whole height inside the 600px window, and the heading above it too.
    expect(top + 600).toBeGreaterThanOrEqual(box + SHELF_EMPTY_HEIGHT);
    expect(top).toBeLessThanOrEqual(box - SHELF_HEADING_HEIGHT);
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

/**
 * **The caret survives a re-layout** — live-pass FAIL 6 (2026-09-26): one Ctrl+wheel step that
 * changed the column count re-keyed the rows, the focused tile's element unmounted, and
 * `document.activeElement` became `<body>`. The caret belongs to a *tile*, so it is put back on the
 * same tile — by its tile key — wherever the new layout draws it.
 *
 * `clientWidth` 400 is two 170px columns; zoom 0.5 draws 85px tiles, which is four.
 */
describe("CardGrid keeps the caret on its tile through a re-layout", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 400 });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  const zoomOut = () =>
    act(() => {
      useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, collection: 0.5 } });
    });
  const tileCount = (row: Element) => row.querySelectorAll("[data-grid-index]").length;

  const TWO = () =>
    shelves([
      {
        shelf: BINDER,
        tiles: [tile("a1", "Card A1"), tile("a2", "Card A2"), tile("a3", "Card A3")],
      },
      { shelf: TRADE, tiles: [tile("b1", "Card B1"), tile("b2", "Card B2")] },
    ]);

  /** The live pass's own case: the focused tile's row is re-keyed and unmounts. */
  it("puts the caret back on the same tile when a column change remounts it", () => {
    wall(TWO());
    const before = art("Card A3");
    expect(tileCount(rowOf(before))).toBe(1); // A3 alone on Binder's short row, at two columns
    before.focus();

    zoomOut();

    // Four columns: Binder is one row now, so A3's old row — and A3's old element — is gone.
    expect(tileCount(rowOf(art("Card A3")))).toBe(3);
    expect(before.isConnected).toBe(false);
    expect(document.activeElement).toBe(art("Card A3"));
  });

  /**
   * **The flat wall's form of the same fault**: its rows and slots are keyed by position, so the
   * focused element is *reused* for another card — the caret stays on a button, on the wrong card.
   */
  it("moves the caret back to its own card when a flat wall reuses the element for another", () => {
    const six = ["A", "B", "C", "D", "E", "F"].map((n) => tile(n.toLowerCase(), `Card ${n}`));
    wall(undefined, { rows: six });
    const focused = art("Card C");
    focused.focus();

    zoomOut();

    // Slot "1-0" held C at two columns and holds E at four: the same element, another card.
    expect(focused.isConnected).toBe(true);
    expect(focused).toHaveAccessibleName("Card E");
    expect(document.activeElement).toBe(art("Card C"));
  });

  /** A caret the reader has taken elsewhere is theirs — a re-layout does not pull it back. */
  it("leaves a caret alone once it has left the wall", () => {
    const { container } = wall(TWO());
    art("Card A3").focus();
    const outside = document.createElement("button");
    container.appendChild(outside);
    outside.focus();

    zoomOut();

    expect(document.activeElement).toBe(outside);
  });

  /**
   * **A tile the reader scrolled away from is not a caret to keep** (fix round 1, Important 1).
   * Scrolling a focused tile out of the virtualiser's window unmounts it and the caret falls to
   * `<body>` with no focus event to say so. A later column change must not scroll the page back to
   * that tile and focus it — minutes later, mid-zoom — on any wall.
   */
  it("forgets a tile scrolled out of the window, so a later column change does not pull the page back", () => {
    const forty = Array.from({ length: 40 }, (_, i) => tile(`t${i}`, `Card ${i}`));
    wall(undefined, { rows: forty });
    const group = screen.getByRole("group", { name: "Your collection" });
    const first = art("Card 0");
    first.focus();

    // Twenty rows at two across: scrolled far down, row 0 leaves the window and unmounts.
    group.scrollTop = 4000;
    fireEvent.scroll(group);
    expect(first.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);

    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();
    zoomOut();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  /** The wall's scroll geometry as a browser states it: a 600px window and a scroll height of the
   *  sizer plus the wall's `p-3` either side — so a scroll the virtualiser asks for is not clamped
   *  to 0 by jsdom's zeros. And the scroll it asked for, landed, as a browser would land it. */
  function scrollGeometry() {
    const group = screen.getByRole("group", { name: "Your collection" });
    const sizer = group.lastElementChild as HTMLElement;
    Object.defineProperty(group, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(group, "scrollHeight", {
      configurable: true,
      get: () => parseFloat(sizer.style.height) + 24,
    });
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    const scrolledTo = () => (scrollTo.mock.lastCall?.[0] as ScrollToOptions | undefined)?.top;
    const land = () => {
      group.scrollTop = scrolledTo() ?? group.scrollTop;
      fireEvent.scroll(group);
    };
    return { group, scrollTo, scrolledTo, land };
  }

  /**
   * **A focused tile deep in a wall keeps the caret across a zoom** — final review S-I2, and the
   * re-check's check C (collection tile 63, wishlist tile 60: the page scrolled to the tile and the
   * caret was on `<body>`). The tile's new row is not drawn at the old offset, so the wall scrolls
   * to it — and the zoom's own `measure()` commit arrives before the scroll's event draws the row.
   * The caret must follow the scroll however many commits come first, and land on the tile.
   *
   * Eighty tiles on one shelf: tile 40 is row 20 of 40 at two across, row 10 of 20 at four.
   */
  it("keeps the caret on a deep tile whose new row is only drawn once the zoom's scroll lands", () => {
    const eighty = Array.from({ length: 80 }, (_, i) => tile(`d${i}`, `Card ${i}`));
    wall(shelves([{ shelf: BINDER, tiles: eighty }]));
    const { group, scrollTo, land } = scrollGeometry();
    group.scrollTop = SHELF_HEADING_HEIGHT + 20 * 274 - 100;
    fireEvent.scroll(group);
    art("Card 40").focus();

    scrollTo.mockClear();
    zoomOut(); // the zoom's commit, then the `measure()` commit its `tileHeight` effect makes
    expect(screen.queryByRole("button", { name: "Card 40" })).toBeNull(); // not drawn yet
    expect(scrollTo).toHaveBeenCalled(); // the wall went after it

    land(); // the scroll's event: the row is drawn
    expect(document.activeElement).toBe(art("Card 40"));
  });

  /**
   * **And a focused tile whose row stays drawn is kept in view** — re-check new finding 6 (tile 40
   * kept the caret through 4 → 5 across and ended at −491…−175, off-screen). Zooming in from four
   * across to two: tile 6 moves from row 1 to row 3, which the virtualiser's overscan still draws
   * below a 600px window at the top of the wall.
   */
  it("brings a focused tile back into view when a column change leaves its row off-screen", () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, collection: 0.5 } });
    const eighty = Array.from({ length: 80 }, (_, i) => tile(`f${i}`, `Card ${i}`));
    wall(undefined, { rows: eighty });
    const { scrollTo, scrolledTo } = scrollGeometry();
    art("Card 6").focus();

    scrollTo.mockClear();
    act(() => {
      useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS } });
    });

    // Row 3 at two across: [3 × 274, 4 × 274) in the virtualiser's coordinates — below the window.
    expect(document.activeElement).toBe(art("Card 6"));
    const top = scrolledTo();
    expect(top).toBeDefined();
    expect(top!).toBeLessThanOrEqual(3 * 274);
    expect(top! + 600).toBeGreaterThanOrEqual(4 * 274);
  });

  /** Keyed on the tile, not the slot: the art keeps the caret on the art, the tile on the tile. */
  it("puts a caret that was on the tile itself back on the tile, not on its art", () => {
    wall(TWO());
    const tileBefore = art("Card A3").closest<HTMLElement>("[data-grid-index]")!;
    tileBefore.focus();

    zoomOut();

    expect(tileBefore.isConnected).toBe(false);
    expect(document.activeElement).toBe(art("Card A3").closest("[data-grid-index]"));
  });
});

/**
 * **The fold anchor** — spec §3.9 ("the page stays anchored on the dragged heading as it folds and
 * unfolds") and live-pass FAIL 4 (2026-09-26). Driven the way the app drives it: a page that calls
 * `useFoldAnchor(folding)` and hands the wall its shelves folded while `folding`, with real
 * `pointerdown`/`pointermove`/`pointerup`/`keydown` on `window`.
 *
 * jsdom lays nothing out, so the scroll geometry is the browser's, stated: a 600px window at the
 * top of the viewport, a scroll height of the sizer plus the wall's `p-3` either side (so the room
 * the anchor adds counts), and each pressed row's box where the case says it is. **Every expected
 * offset is computed from `rowStartOf` at the pitch the wall really draws**, so these assert where
 * the wall scrolls *to*, and `shelfLayout.test.ts` owns the arithmetic.
 */
describe("CardGrid keeps a carried heading under the pointer through a fold", () => {
  /** Thirty shelves of three cards: folded, 30 × 48 = 1440px, taller than the window. */
  const MANY: Entry[] = Array.from({ length: 30 }, (_, i) => ({
    shelf: shelf(100 + i, `Shelf ${i}`),
    tiles: ["a", "b", "c"].map((n) => tile(`c${i}${n}`, `Card ${i}${n}`)),
  }));
  const folded = (entries: Entry[]): Entry[] =>
    entries.map((e) => ({ shelf: { ...e.shelf, collapsed: true }, tiles: [], count: 0 }));
  const noop = () => undefined;

  /**
   * A page as the app draws one: `useFoldAnchor(folding)`, and the wall handed its shelves folded
   * while `folding`. `foldedAs` is the folded wall when it is not simply `entries` folded — the
   * pages' `foldedForDrag` opens every collapsed shelf first, so the folded wall can draw a child
   * the real page hides.
   */
  function Page({
    folding,
    entries,
    foldedAs,
    grow = false,
  }: {
    folding: boolean;
    entries: Entry[];
    foldedAs?: Entry[];
    grow?: boolean;
  }) {
    useFoldAnchor(folding);
    const sections = useMemo(
      () => shelves(folding ? (foldedAs ?? folded(entries)) : entries),
      [folding, entries, foldedAs],
    );
    return (
      <CardGrid
        rows={NO_ROWS}
        sections={sections}
        onSelect={noop}
        onNeedNextPage={noop}
        listKey="k"
        label="Your collection"
        zoomSection="collection"
        grow={grow}
      />
    );
  }
  /** One animation frame — the carry is let go on the frame after the drag ends. */
  const nextFrame = () =>
    act(async () => {
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    });

  beforeEach(() => {
    shelfCarry.reset();
  });

  /** The page, with the browser's scroll geometry stated on the wall (see the block's doc). */
  function mount(entries: Entry[] = MANY) {
    const view = render(<Page folding={false} entries={entries} />);
    const group = screen.getByRole("group", { name: "Your collection" });
    const sizer = group.lastElementChild as HTMLElement;
    Object.defineProperty(group, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(group, "scrollHeight", {
      configurable: true,
      get: () => parseFloat(sizer.style.height) + 24,
    });
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    const scrolledTo = () => (scrollTo.mock.lastCall?.[0] as ScrollToOptions | undefined)?.top;
    /** What the browser does with the last scroll asked for — `scrollTo` is a stub here. */
    const scrollLands = () => {
      group.scrollTop = scrolledTo() ?? group.scrollTop;
      fireEvent.scroll(group);
    };
    /** Bring a shelf's heading into the drawn window, as a reader scrolling there would. */
    const scrollToShelf = (entriesNow: Entry[], index: number) => {
      const layout = layoutShelves(shelves(entriesNow).sections, 1);
      const row = layout.rows.findIndex(
        (r) => r.kind === "heading" && r.shelf.id === entriesNow[index].shelf.id,
      );
      group.scrollTop = Math.max(0, rowStartOf(layout, row, pitch()) - 200);
      fireEvent.scroll(group);
    };
    const pitch = () => {
      const rows = [...group.querySelectorAll<HTMLElement>('[data-shelf-row="tiles"]')];
      return offsetOf(rows[1]) - offsetOf(rows[0]);
    };
    const rowOfShelf = (name: string) => rowOf(heading(name));
    /** Press a heading at `clientY`, its row's top at `rowTop` on screen. */
    const pressHeading = (name: string, rowTop: number, clientY: number) => {
      const row = rowOfShelf(name);
      row.getBoundingClientRect = () => new DOMRect(0, rowTop, 400, SHELF_HEADING_HEIGHT);
      fireEvent.pointerDown(heading(name), { clientX: 100, clientY });
      return row;
    };
    const fold = (next: Entry[] = entries) => view.rerender(<Page folding entries={next} />);
    const unfold = (next: Entry[] = entries) =>
      view.rerender(<Page folding={false} entries={next} />);
    /** Where a shelf's heading row starts in `entriesNow`'s layout (folded or not), at the wall's
     *  real pitch, plus the wall's `p-3` — its top in the scroll content. */
    const contentTop = (entriesNow: Entry[], shelfId: number, tilePitch: number) => {
      const layout = layoutShelves(shelves(entriesNow).sections, 1);
      const row = layout.rows.findIndex((r) => r.kind === "heading" && r.shelf.id === shelfId);
      return 12 + rowStartOf(layout, row, tilePitch);
    };
    return {
      view,
      group,
      sizer,
      scrollTo,
      scrolledTo,
      scrollLands,
      scrollToShelf,
      pitch,
      rowOfShelf,
      pressHeading,
      fold,
      unfold,
      contentTop,
    };
  }

  /**
   * **The live pass's collection case**: the heading dragged from deep in the wall, where the
   * fold's own render still used the unfolded offset. Its row was unmounted for that frame — and
   * dnd-kit's feedback element with it — and the page landed at the folded wall's clamp.
   */
  it("keeps the carried heading's row mounted, and scrolls the folded wall to put it at the pointer", () => {
    const { group, scrolledTo, scrollToShelf, pitch, pressHeading, fold, rowOfShelf, contentTop } =
      mount();
    scrollToShelf(MANY, 15);
    const tilePitch = pitch();
    const carried = pressHeading("Shelf 15", 300, 320); // grabbed 20px into its row
    fireEvent.pointerMove(window, { clientX: 100, clientY: 330 });
    const staleOffset = group.scrollTop;

    fold();

    // The same element, though the fold's window (at the stale offset, far past the folded
    // wall's end) would not have held it.
    expect(staleOffset).toBeGreaterThan(30 * SHELF_HEADING_HEIGHT);
    expect(rowOfShelf("Shelf 15")).toBe(carried);
    expect(carried.isConnected).toBe(true);
    // Its top at the pointer less the grab: 330 − 20 = 310, reachable, so no room.
    expect(scrolledTo()).toBe(contentTop(folded(MANY), 115, tilePitch) - 310);
    expect(parseFloat(group.lastElementChild!.getAttribute("style")!.match(/height: ([\d.]+)px/)![1]))
      .toBe(30 * SHELF_HEADING_HEIGHT);
  });

  /** The live pass's other shape: the heading near the folded wall's top and the pointer low —
   *  402px the page could not reach. The anchor holds by adding room above, and the unfold on
   *  Escape takes the room away and puts the heading back at the pointer. */
  it("adds room when the folded wall is too short, and on Escape returns to the pointer without it", () => {
    const { group, scrolledTo, scrollToShelf, pitch, pressHeading, fold, unfold, rowOfShelf, contentTop } =
      mount();
    scrollToShelf(MANY, 1);
    const tilePitch = pitch();
    const carried = pressHeading("Shelf 1", 500, 520);

    fold();

    // Folded, Shelf 1 starts 48px down (60 with the wall's `p-3`); the pointer wants its top at
    // 500, so 440px of room above it and the page at 0.
    const room = 500 - contentTop(folded(MANY), 101, tilePitch);
    expect(room).toBe(440);
    expect(offsetOf(rowOfShelf("Shelf 1"))).toBe(room + SHELF_HEADING_HEIGHT);
    expect(scrolledTo()).toBe(0);
    expect(rowOfShelf("Shelf 1")).toBe(carried);

    fireEvent.keyDown(window, { key: "Escape" });
    unfold();

    // The room is gone and the heading's top is back at the pointer (still 500) on the real page.
    const start = contentTop(MANY, 101, tilePitch) - 12;
    expect(offsetOf(rowOfShelf("Shelf 1"))).toBe(start);
    expect(scrolledTo()).toBe(12 + start - 500);
    expect(rowOfShelf("Shelf 1")).toBe(carried);
    void group;
  });

  /**
   * **A drop**: the unfold keeps the heading the pointer was over where it was — so the page does
   * not flash some other stretch of the wall — and when the move lands (a refetch later), the moved
   * heading goes to the pointer.
   */
  it("holds the drop target on the unfold, then puts the moved heading at the pointer", () => {
    const {
      scrolledTo,
      scrollLands,
      scrollToShelf,
      pitch,
      pressHeading,
      fold,
      unfold,
      view,
      rowOfShelf,
      contentTop,
    } = mount();
    scrollToShelf(MANY, 15);
    const tilePitch = pitch();
    pressHeading("Shelf 15", 300, 320);
    fold();
    scrollLands();

    // Let go over Shelf 20's heading, whose row is at 450 on screen.
    const target = rowOfShelf("Shelf 20");
    target.getBoundingClientRect = () => new DOMRect(0, 450, 400, SHELF_HEADING_HEIGHT);
    const elementsFromPoint = vi.fn(() => [target]);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: elementsFromPoint,
    });
    try {
      fireEvent.pointerUp(window, { clientX: 100, clientY: 460 });
      unfold();
      expect(elementsFromPoint).toHaveBeenCalledWith(100, 460);
      expect(scrolledTo()).toBe(contentTop(MANY, 120, tilePitch) - 450);

      // The move lands: Shelf 15 now sits after Shelf 20.
      const moved = [...MANY.slice(0, 15), ...MANY.slice(16, 21), MANY[15], ...MANY.slice(21)];
      view.rerender(<Page folding={false} entries={moved} />);

      // Its top at the release point less the grab: 460 − 20.
      expect(scrolledTo()).toBe(contentTop(moved, 115, tilePitch) - 440);
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
    }
  });

  /** The reader's wheel ends the settling: a move that lands afterwards scrolls nothing. */
  it("leaves the page alone once the reader has scrolled after the drop", () => {
    const { scrollTo, scrollToShelf, pressHeading, fold, unfold, view } = mount();
    scrollToShelf(MANY, 15);
    pressHeading("Shelf 15", 300, 320);
    fold();
    fireEvent.pointerUp(window, { clientX: 100, clientY: 460 });
    unfold();

    fireEvent.wheel(window, { deltaY: 100 });
    scrollTo.mockClear();
    const moved = [...MANY.slice(0, 15), ...MANY.slice(16, 21), MANY[15], ...MANY.slice(21)];
    view.rerender(<Page folding={false} entries={moved} />);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  /** A press that never became a drag carries nothing: a later fold (another drag, begun
   *  elsewhere) moves nothing on its account. */
  it("forgets a press that was not a drag", () => {
    const { scrollTo, scrollToShelf, pressHeading, fold } = mount();
    scrollToShelf(MANY, 15);
    pressHeading("Shelf 15", 300, 320);
    fireEvent.pointerUp(window, { clientX: 100, clientY: 320 });
    expect(shelfCarry.carried()).toBeNull();

    scrollTo.mockClear();
    fold();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  /**
   * **A drop on a shelf only the folded wall drew** (fix round 1, Important 2). The fold opens every
   * collapsed shelf before folding it, so the child of a collapsed parent is a heading on the
   * folded wall and nowhere on the real page. Dropped onto, it must still leave the page anchored —
   * on its nearest drawn ancestor, where the child was — and the room the fold added must go.
   */
  it("anchors on the nearest drawn ancestor of a shelf only the fold drew, and takes the room away", () => {
    const PARENT: Entry = {
      shelf: { ...MANY[20].shelf, collapsed: true },
      tiles: [],
      count: 0,
    };
    const CHILD = shelf(500, "Child of 20", {
      depth: 1,
      pathIds: [MANY[20].shelf.id, 500],
      path: ["Shelf 20", "Child of 20"],
      lead: ["Shelf 20"],
      leadIds: [MANY[20].shelf.id],
    });
    const page = [...MANY.slice(0, 20), PARENT, ...MANY.slice(21)];
    const foldedPage = folded([...MANY.slice(0, 21), { shelf: CHILD, tiles: [] }, ...MANY.slice(21)]);
    const { view, group, scrolledTo, scrollToShelf, pitch, pressHeading, rowOfShelf, contentTop } =
      mount(page);
    scrollToShelf(page, 1);
    const tilePitch = pitch();
    pressHeading("Shelf 1", 500, 520);

    view.rerender(<Page folding entries={page} foldedAs={foldedPage} />);
    // Shelf 1 near the folded wall's top and the pointer low: 440px of room above it.
    expect(offsetOf(rowOfShelf("Shelf 1"))).toBe(440 + SHELF_HEADING_HEIGHT);

    // The reader carries it down to the child, which only this folded wall draws.
    const childTop = contentTop(foldedPage, 500, tilePitch) + 440;
    group.scrollTop = childTop - 300;
    fireEvent.scroll(group);
    const child = rowOfShelf("Child of 20");
    child.getBoundingClientRect = () => new DOMRect(0, 300, 400, SHELF_HEADING_HEIGHT);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [child]),
    });
    try {
      fireEvent.pointerUp(window, { clientX: 100, clientY: 310 });
      view.rerender(<Page folding={false} entries={page} />);

      // No room: Shelf 1 is back at its own start on the real page.
      expect(offsetOf(rowOfShelf("Shelf 1"))).toBe(contentTop(page, 101, tilePitch) - 12);
      // And the page is anchored — Shelf 20, the child's parent, where the child was let go.
      expect(scrolledTo()).toBe(contentTop(page, MANY[20].shelf.id, tilePitch) - 300);
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
    }
  });

  /**
   * **The carry ends with the drag** (fix round 1, Minor 4). A carried heading's row is drawn
   * outside the virtualiser's window for as long as there is a carry; one that outlived its drag
   * stayed mounted wherever the reader scrolled — in the tab order, and the last drawn row the
   * paging rule reads. After Escape it goes on the next frame; after a drop, when the settling ends.
   */
  it("lets the carried heading go once the drag is over", async () => {
    const { group, scrollToShelf, pressHeading, fold, unfold } = mount();
    scrollToShelf(MANY, 15);
    pressHeading("Shelf 15", 300, 320);
    fold();
    fireEvent.keyDown(window, { key: "Escape" });
    unfold();
    await nextFrame();

    expect(shelfCarry.carried()).toBeNull();
    group.scrollTop = 0;
    fireEvent.scroll(group);
    expect(screen.queryByRole("heading", { name: "Shelf 15" })).toBeNull();

    // A drop: the carry lasts through the settling, and ends when the reader takes the page.
    scrollToShelf(MANY, 15);
    pressHeading("Shelf 15", 300, 320);
    fold();
    fireEvent.pointerUp(window, { clientX: 100, clientY: 320 });
    unfold();
    await nextFrame();
    expect(shelfCarry.carried()).toBe(MANY[15].shelf.id);

    fireEvent.wheel(window, { deltaY: 40 });
    await nextFrame();
    expect(shelfCarry.carried()).toBeNull();
  });

  /**
   * **Under `grow`, the scroller is `main`** — both shipped pages grow — so a row's top in the
   * scroll content is the measured `scrollMargin` (everything above the wall) plus its start, and
   * the scroll is `main`'s. jsdom lays nothing out: `main` is found through its inline
   * `overflow-y`, and the wall's rows box is stated 150px below `main`'s top.
   */
  it("anchors in main's coordinates when the wall grows and the page scrolls it", () => {
    const boxes = vi
      .spyOn(HTMLDivElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, 150 - main.scrollTop, 400, 0));
    const main = document.createElement("main");
    main.style.overflowY = "auto";
    document.body.appendChild(main);
    try {
      const view = render(<Page folding={false} entries={MANY} grow />, { container: main });
      const sizer = screen.getByRole("group", { name: "Your collection" }).lastElementChild!;
      Object.defineProperty(main, "clientHeight", { configurable: true, value: 600 });
      Object.defineProperty(main, "scrollHeight", {
        configurable: true,
        get: () => parseFloat((sizer as HTMLElement).style.height) + 150,
      });
      const layout = layoutShelves(shelves(MANY).sections, 1);
      const tileRows = [...main.querySelectorAll<HTMLElement>('[data-shelf-row="tiles"]')];
      const tilePitch = offsetOf(tileRows[1]) - offsetOf(tileRows[0]);
      const at = layout.rows.findIndex((r) => r.kind === "heading" && r.shelf.id === 115);
      main.scrollTop = 150 + rowStartOf(layout, at, tilePitch) - 200;
      fireEvent.scroll(main);

      const row = rowOf(heading("Shelf 15"));
      row.getBoundingClientRect = () => new DOMRect(0, 300, 400, SHELF_HEADING_HEIGHT);
      fireEvent.pointerDown(heading("Shelf 15"), { clientX: 100, clientY: 320 });
      fireEvent.pointerMove(window, { clientX: 100, clientY: 330 });
      const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
      scrollTo.mockClear();

      view.rerender(<Page folding entries={MANY} grow />);

      // 150px of page above the wall, Shelf 15 at 15 × 48 down the folded wall, its top wanted at
      // 330 − 20 = 310 — on `main`, not on the wall.
      expect(scrollTo.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({ top: 150 + 15 * SHELF_HEADING_HEIGHT - 310 }),
      );
      expect(scrollTo.mock.contexts[scrollTo.mock.contexts.length - 1]).toBe(main);
      view.unmount();
    } finally {
      boxes.mockRestore();
      main.remove();
    }
  });

  /**
   * **A wall in a row a taller sibling stretches** — the wishlist's live finding A (final re-check,
   * 2026-09-27). Both pages put the wall in a flex row beside the docked search column, and the dock
   * is as tall as the scrollport, so a folded wall shorter than it sits in a row the dock decides:
   * 766px of folded wishlist in a 988px row. Room added to the wall's end grows the *wall* and not
   * the page until the wall outgrows that row, so the page's end — and the scroll's clamp — never
   * moved: a heading pressed high near the folded wall's end was held 78–126px under the pointer
   * for the whole drag.
   *
   * `main` here is that page: 150px above the wall, 24px under it, and the row at least 988px tall
   * whatever the wall is — the stretch jsdom cannot lay out, stated as the browser measures it.
   */
  const ROW = 988;
  function stretchedPage(entries: Entry[]) {
    const main = document.createElement("main");
    const boxes = vi
      .spyOn(HTMLDivElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, 150 - main.scrollTop, 400, 0));
    main.style.overflowY = "auto";
    document.body.appendChild(main);
    const view = render(<Page folding={false} entries={entries} grow />, { container: main });
    const sizer = screen.getByRole("group", { name: "Your collection" }).lastElementChild!;
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(main, "scrollHeight", {
      configurable: true,
      get: () => 150 + Math.max(parseFloat((sizer as HTMLElement).style.height), ROW) + 24,
    });
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    const scrolledTo = () => (scrollTo.mock.lastCall?.[0] as ScrollToOptions | undefined)?.top;
    const most = () => main.scrollHeight - main.clientHeight;
    const pitch = () => {
      const rows = [...main.querySelectorAll<HTMLElement>('[data-shelf-row="tiles"]')];
      return rows.length < 2 ? 0 : offsetOf(rows[1]) - offsetOf(rows[0]);
    };
    /** Put a shelf's heading `onScreen` px below `main`'s top, and press it `grab` px into its row. */
    const pressAt = (name: string, entriesNow: Entry[], onScreen: number, grab: number) => {
      const layout = layoutShelves(shelves(entriesNow).sections, 1);
      const at = layout.rows.findIndex((r) => r.kind === "heading" && r.shelf.name === name);
      main.scrollTop = 150 + rowStartOf(layout, at, pitch()) - onScreen;
      fireEvent.scroll(main);
      const row = rowOf(heading(name));
      row.getBoundingClientRect = () => new DOMRect(0, onScreen, 400, SHELF_HEADING_HEIGHT);
      fireEvent.pointerDown(heading(name), { clientX: 100, clientY: onScreen + grab });
    };
    const done = () => {
      view.unmount();
      boxes.mockRestore();
      main.remove();
    };
    return { view, main, scrollTo, scrolledTo, most, pressAt, done };
  }

  /** Twelve shelves: folded, 12 × 48 = 576px — shorter than the 988px row. */
  const TWELVE = MANY.slice(0, 12);

  it("adds room that lengthens the page when the folded wall sits in a taller row", () => {
    const { view, scrollTo, scrolledTo, most, pressAt, done } = stretchedPage(TWELVE);
    try {
      // Shelf 10's heading pressed 20px into its row, the row's top 40px down the scrollport.
      pressAt("Shelf 10", TWELVE, 40, 20);
      scrollTo.mockClear();

      view.rerender(<Page folding entries={TWELVE} grow />);

      // Folded, its top is 150 + 10 × 48 = 630 down the page and wanted at 40: an offset of 590,
      // past the 562 the stretched row allows — so the room has to reach past the row's end.
      const wanted = 150 + 10 * SHELF_HEADING_HEIGHT - 40;
      expect(wanted).toBeGreaterThan(150 + ROW + 24 - 600);
      expect(scrolledTo()).toBe(wanted);
      expect(most()).toBeGreaterThanOrEqual(wanted);
    } finally {
      done();
    }
  });

  /**
   * **And the room's share of the page is not its size**, which the unfold has to know too. On
   * Escape the anchor asks for the heading at the pointer on the real page, which here is as short
   * as the folded one; it plans against the page it can see, room included, and scrolls once the
   * room has gone — so the browser's own end is the clamp, not a figure that subtracted room the
   * row had swallowed.
   */
  it("on Escape from a short page, goes as far toward the pointer as the page allows", () => {
    const SHUT = folded(TWELVE);
    const { view, scrollTo, scrolledTo, most, pressAt, done } = stretchedPage(SHUT);
    try {
      pressAt("Shelf 10", SHUT, 68, 20);
      fireEvent.pointerMove(window, { clientX: 100, clientY: 20 }); // dragged up to the top
      view.rerender(<Page folding entries={SHUT} grow />);
      // The fold reached the pointer: 630 − 0.
      expect(scrolledTo()).toBe(150 + 10 * SHELF_HEADING_HEIGHT);

      scrollTo.mockClear();
      fireEvent.keyDown(window, { key: "Escape" });
      view.rerender(<Page folding={false} entries={SHUT} grow />);

      // No room on the real page, whose end is the 988px row: as close as it gets.
      expect(most()).toBe(150 + ROW + 24 - 600);
      expect(scrolledTo()).toBe(most());
    } finally {
      done();
    }
  });
});
