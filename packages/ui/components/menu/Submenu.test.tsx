import { useEffect, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SUBMENU_HOVER_MS } from "./ContextMenu";
import { ContextMenuProvider } from "./ContextMenuProvider";
import { useContextMenu } from "./useContextMenu";
import { BELOW_CAPTION } from "@/components/TitleBar";
import {
  MENU_EDGE_GUTTER,
  MENU_MIN_HEIGHT,
  MENU_MIN_WIDTH,
  MENU_TOP_INSET,
  menuMaxHeight,
  panelAtDepth,
  placeMenu,
} from "./panel";
import type { MenuItem } from "./types";

/**
 * Where a submenu is drawn, which is the one thing about this cascade that is arithmetic.
 *
 * **jsdom has no layout engine**, so every box measures a hard `0` and
 * `document.documentElement.clientWidth` is `0` too. Every number a test here reasons about has
 * therefore to be *stated* — and stated as itself, never as `window.innerWidth`, which is the
 * expression this repo has already once pinned as an expected answer. See `packages/ui/CLAUDE.md`.
 */
function statedViewport(width: number, height: number) {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
}

/** The box the submenu's own panel occupies — the thing the placement is supposed to measure. */
const submenuBox = { width: MENU_MIN_WIDTH, height: MENU_MIN_HEIGHT };
const statedSubmenuBox = (width: number, height: number) => {
  submenuBox.width = width;
  submenuBox.height = height;
};

const SUBMENU_PANEL = panelAtDepth(1);
const offsets = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
};

/** `0` everywhere but the submenu's panel, which is what jsdom answers anyway. */
function stateOffsets() {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.matches(SUBMENU_PANEL) ? submenuBox.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.matches(SUBMENU_PANEL) ? submenuBox.height : 0;
    },
  });
}

function restoreOffsets() {
  for (const [name, descriptor] of [
    ["offsetWidth", offsets.width],
    ["offsetHeight", offsets.height],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as Partial<HTMLElement>)[name];
  }
}

/**
 * A `ResizeObserver` a test can fire, since neither jsdom nor `packages/ui/test-setup.ts` has one.
 *
 * The setup file's is a no-op stub — it exists so that `CardGrid`'s measuring effect does not
 * throw — and a no-op cannot say "the box changed". This one records what was observed and lets
 * {@link resized} deliver the notification a browser delivers after a layout in which the box did
 * change, which is the one event jsdom can never produce on its own.
 */
const observers = new Set<TestResizeObserver>();

class TestResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  notify(target: Element) {
    if (this.targets.has(target)) this.callback([], this as unknown as ResizeObserver);
  }
}

/** The box changed. Entries are not passed on purpose: the placement re-measures the live DOM. */
function resized(target: Element) {
  for (const observer of observers) observer.notify(target);
}

function Host({ items }: { items: MenuItem[] }) {
  const { menu } = useContextMenu();
  return <button onContextMenu={menu(() => items)}>target</button>;
}

function openMenu(items: MenuItem[]) {
  render(
    <ContextMenuProvider>
      <Host items={items} />
    </ContextMenuProvider>,
  );
  act(() => {
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

type Box = { left: number; top: number; right: number; bottom: number };

const rectOf = (box: Box): DOMRect => ({
  ...box,
  x: box.left,
  y: box.top,
  width: box.right - box.left,
  height: box.bottom - box.top,
  toJSON: () => ({}),
});

/**
 * Put the row that opens the submenu at a stated place on screen, then expand it by keyboard.
 *
 * The rect has to be in place before the expansion: the placement is a layout effect, so it is
 * measured in the very commit that mounts the panel. The root panel — the submenu's containing
 * block — is stated too, hugging the row sideways (the 5px are `p-1` and the border) and running
 * from the window's top, so the panel's `top` in its parent's px is its `top` in the window's.
 */
function expandRow(name: RegExp, box: Box) {
  const row = screen.getByRole("menuitem", { name });
  const root = screen.getByRole("menu");
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rectOf(box));
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(
    rectOf({ left: box.left - 5, top: 0, right: box.right + 5, bottom: box.bottom + 5 }),
  );
  fireEvent.keyDown(root, { key: "ArrowDown" });
  fireEvent.keyDown(row, { key: "ArrowRight" });
  const panel = document.querySelector<HTMLElement>(SUBMENU_PANEL);
  if (!panel) throw new Error("the row did not open a panel");
  return panel;
}

beforeEach(() => {
  statedViewport(1280, 800);
  statedSubmenuBox(MENU_MIN_WIDTH, MENU_MIN_HEIGHT);
  stateOffsets();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  restoreOffsets();
  observers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Submenu placement", () => {
  /**
   * The horizontal flip, decided against the panel's **own** width rather than against the floor.
   *
   * `MENU_MIN_WIDTH` is what the arithmetic falls back to when nothing has been measured yet — its
   * own doc calls it the size "the placement arithmetic never trusts a measurement smaller than".
   * Using it *as* the measurement is a different claim, and a false one: `PANEL_CLASS` sets
   * `min-w-56` with no `max-w`, and every row label is `truncate`, so a panel's min-content equals
   * its max-content. A panel holding "Atraxa Superfriends (upgraded)" really is wider than 224 and
   * cannot shrink to it.
   *
   * The parent panel here has 232px of room to its right. A 224px panel fits it exactly —
   * `1048 + 224 + 8` is 1280, which is not *greater* than 1280 — so the floor says "no flip" while
   * the panel that is actually drawn runs 38px past the window edge, taking the per-deck chevrons
   * with it. Nothing bounds a panel's width, so nothing would bring them back.
   */
  it("flips a submenu left against its own measured width, not the 224px floor", () => {
    statedSubmenuBox(270, MENU_MIN_HEIGHT);
    openMenu([
      {
        kind: "submenu",
        id: "add-to",
        label: "Add to",
        items: [{ kind: "action", id: "deck", label: "Atraxa Superfriends", onSelect: vi.fn() }],
      },
    ]);

    const panel = expandRow(/Add to/, { left: 819, top: 60, right: 1043, bottom: 92 });

    // Whole literals, because Tailwind scans source text for class names — and the corner it is
    // pinned by is the corner it grows from, which is the app's anchored-popup rule.
    expect(panel).toHaveClass("right-full", "origin-top-right");
    expect(panel.style.top).toBe("60px");
  });

  /**
   * The vertical flip, re-decided when the panel that was measured stops being the panel drawn.
   *
   * `MenuLazy` exists precisely for bodies that fetch — "Add to ▸ Deck" draws a loading note while
   * `useDecks()`/`useDeckFolders()` are pending and then swaps in the whole folder tree — so the
   * one measurement taken at the commit that opened the panel is a measurement of the *note*.
   * `Submenu` does not re-render when the query resolves (React re-renders the body, which is its
   * child), and `[open]` would not re-run the effect if it did, so nothing ever asked again.
   *
   * Here that is a panel spanning 560–860 in an 800px window: growing up was the right answer
   * from the moment the decks arrived, and the 60px hanging past the edge holds real rows.
   */
  it("re-places a submenu when its lazy body has finished loading", () => {
    const loader: { load?: () => void } = {};
    function Content() {
      const [loaded, setLoaded] = useState(false);
      useEffect(() => {
        loader.load = () => setLoaded(true);
      }, []);
      return loaded ? (
        <div role="menuitem" tabIndex={-1}>
          Atraxa Superfriends
        </div>
      ) : (
        <p>Loading decks…</p>
      );
    }
    openMenu([{ kind: "lazy", id: "add-deck", label: "Deck", Content }]);

    // The root panel has flipped up off a right-click low on the wall, so the row sits at 560.
    // One loading note is 42px, and 560 + 42 + 8 fits — which is the whole of what was measured.
    const panel = expandRow(/Deck/, { left: 40, top: 560, right: 264, bottom: 592 });
    expect(panel).toHaveClass("left-full", "origin-top-left");
    expect(panel.style.top).toBe("560px");

    // The decks arrive and the panel grows to 300. jsdom computes no layout, so the growth is
    // stated and the notification delivered by hand — the browser's own next step after a box
    // changes size, and the one thing jsdom will never do on its own.
    act(() => {
      loader.load?.();
      statedSubmenuBox(MENU_MIN_WIDTH, 300);
      resized(panel);
    });
    expect(screen.getByRole("menuitem", { name: "Atraxa Superfriends" })).toBeInTheDocument();

    // Level with the row's bottom, growing up: 592 − 300.
    expect(panel).toHaveClass("left-full", "origin-bottom-left");
    expect(panel.style.top).toBe("292px");
  });

  const tallMenu = (): MenuItem[] => [
    {
      kind: "submenu",
      id: "add-to",
      label: "Add to",
      items: [{ kind: "action", id: "deck", label: "Atraxa Superfriends", onSelect: vi.fn() }],
    },
  ];

  /**
   * Issue #1572, as its own arithmetic: a row at `top: 398` with a 458px panel in an 800px window.
   *
   * Neither side fits — down would end at 856, up would start at −28 — and the old flip went up
   * because "down does not fit" was the whole of its question. Up has 388px of room under the
   * caption and down 394 above the gutter, so the panel grows down, and is clamped to end at the
   * bottom gutter: 800 − 8 − 458. Every row is on screen and none is under the title bar.
   */
  it("clamps a panel that fits on neither side into the window, growing towards the more room", () => {
    statedSubmenuBox(MENU_MIN_WIDTH, 458);
    openMenu(tallMenu());

    const panel = expandRow(/Add to/, { left: 40, top: 398, right: 264, bottom: 430 });

    expect(panel).toHaveClass("origin-top-left");
    expect(panel.style.top).toBe("334px");
  });

  /** The same panel off a row low in the window, where up is the side with the room. */
  it("grows a too-tall panel upward when that side has more room, stopping under the caption", () => {
    statedSubmenuBox(MENU_MIN_WIDTH, 600);
    openMenu(tallMenu());

    const panel = expandRow(/Add to/, { left: 40, top: 560, right: 264, bottom: 592 });

    // 592 − 600 would be −8: clamped to the caption plus the gutter, and no higher.
    expect(panel).toHaveClass("origin-bottom-left");
    expect(panel.style.top).toBe(`${MENU_TOP_INSET + MENU_EDGE_GUTTER}px`);
  });

  /**
   * A panel taller than the whole window is drawn at the window's height and scrolls: the cap is
   * on the panel, and its rows sit in a scroller that is a *static* box, so a submenu of its own
   * (whose containing block is the panel) is not clipped by it.
   */
  it("caps a panel at the window's height and puts its rows in a scroller", () => {
    statedSubmenuBox(MENU_MIN_WIDTH, 2000);
    openMenu(tallMenu());

    const panel = expandRow(/Add to/, { left: 40, top: 300, right: 264, bottom: 332 });

    expect(panel.style.maxHeight).toBe(`${800 - MENU_TOP_INSET - 2 * MENU_EDGE_GUTTER}px`);
    expect(panel.style.top).toBe(`${MENU_TOP_INSET + MENU_EDGE_GUTTER}px`);
    const scroller = panel.firstElementChild as HTMLElement;
    expect(scroller).toHaveClass("overflow-y-auto", "min-h-0");
    expect(scroller).not.toHaveClass("relative", "absolute");
    // The row box a nested submenu would hang from is static too — positioned, it would be the
    // nested panel's containing block, inside this scroller, and clipped by it.
    const rowBox = screen.getByRole("menuitem", { name: /Add to/ }).parentElement;
    expect(rowBox).not.toHaveClass("relative");
  });
});

describe("Submenu clicks", () => {
  /**
   * Issue #1572's second half. The pointer rests on "Add to", the panel opens after 120ms, and the
   * click the reader was already making used to toggle it shut — it only came back once the
   * pointer crossed to another element.
   */
  it("keeps a hover-opened submenu open when its row is clicked, and moves the caret in", () => {
    vi.useFakeTimers();
    try {
      openMenu([
        {
          kind: "submenu",
          id: "add-to",
          label: "Add to",
          items: [{ kind: "action", id: "collection", label: "Collection", onSelect: vi.fn() }],
        },
      ]);
      const row = screen.getByRole("menuitem", { name: /Add to/ });
      fireEvent.pointerOver(row);
      act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));
      expect(screen.getByRole("menuitem", { name: "Collection" })).toBeInTheDocument();

      fireEvent.click(row);

      expect(row).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("menuitem", { name: "Collection" })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Scrolling inside the menu", () => {
  /**
   * A panel scrolls now, and the root's close-on-scroll listener is on `window` in the capture
   * phase — so it hears the panel's own scroll too. Closing the menu on it would make a long
   * list unscrollable; what the scroll does move is the row a deeper panel hung off, so the
   * deeper panels close, the caret comes back to that row, and the panel that scrolled stays.
   */
  it("closes only the panels deeper than the one that scrolled, and keeps the caret", () => {
    openMenu([
      {
        kind: "submenu",
        id: "add-to",
        label: "Add to",
        items: [{ kind: "action", id: "collection", label: "Collection", onSelect: vi.fn() }],
      },
    ]);
    const root = screen.getByRole("menu");
    const row = screen.getByRole("menuitem", { name: /Add to/ });
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(screen.getByRole("menuitem", { name: "Collection" })).toHaveFocus();

    // The root panel's scroller scrolls.
    fireEvent.scroll(root.firstElementChild as HTMLElement);

    expect(screen.getByRole("menu")).toBe(root);
    expect(screen.queryByRole("menuitem", { name: "Collection" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });
});

describe("placeMenu", () => {
  /**
   * The root panel's half of the class: its clamp kept 8px off the window's top edge, not off the
   * caption, so a menu flipped up off a right-click near the top of a view drew its first rows
   * behind the title bar — which is layered over every menu.
   */
  it("keeps a flipped-up menu under the caption", () => {
    // 600 + 650 runs off the bottom, so it flips — to a top of −50 before the clamp.
    const placed = placeMenu({ x: 100, y: 600 }, MENU_MIN_WIDTH, 650);
    expect(placed.top).toBe(MENU_TOP_INSET + MENU_EDGE_GUTTER);
    expect(placed.origin).toBe("origin-bottom-left");
  });

  it("caps the height it places at the room under the caption", () => {
    expect(menuMaxHeight()).toBe(800 - MENU_TOP_INSET - 2 * MENU_EDGE_GUTTER);
    const placed = placeMenu({ x: 100, y: 400 }, MENU_MIN_WIDTH, 5000);
    expect(placed.top).toBe(MENU_TOP_INSET + MENU_EDGE_GUTTER);
  });

  /** The inset is `TitleBar`'s height written as a number; this holds the two together. */
  it("reserves exactly the title bar's height", () => {
    expect(BELOW_CAPTION).toBe(`top-[${MENU_TOP_INSET}px]`);
  });
});
