import { useEffect, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuProvider } from "./ContextMenuProvider";
import { useContextMenu } from "./useContextMenu";
import { MENU_MIN_HEIGHT, MENU_MIN_WIDTH, panelAtDepth } from "./panel";
import type { MenuItem } from "./types";

/**
 * Where a submenu is drawn, which is the one thing about this cascade that is arithmetic.
 *
 * **jsdom has no layout engine**, so every box measures a hard `0` and
 * `document.documentElement.clientWidth` is `0` too. Every number a test here reasons about has
 * therefore to be *stated* — and stated as itself, never as `window.innerWidth`, which is the
 * expression this repo has already once pinned as an expected answer. See `src/CLAUDE.md`.
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
 * A `ResizeObserver` a test can fire, since neither jsdom nor `src/test-setup.ts` has one.
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

/**
 * Put the row that opens the submenu at a stated place on screen, then expand it by keyboard.
 *
 * The rect has to be in place before the expansion: the placement is a layout effect, so it is
 * measured in the very commit that mounts the panel.
 */
function expandRow(name: RegExp, box: { left: number; top: number; right: number; bottom: number }) {
  const row = screen.getByRole("menuitem", { name });
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
    toJSON: () => ({}),
  });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
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
   * The row here has 232px of room to its right. A 224px panel fits it exactly — `1048 + 224 + 8`
   * is 1280, which is not *greater* than 1280 — so the floor says "no flip" while the panel that
   * is actually drawn runs 38px past the window edge, taking the per-deck chevrons with it.
   * Nothing clips it and nothing scrolls: the ancestor is `fixed` and the module has no `max-h`,
   * no `overflow`, and no `max-w`.
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

    const panel = expandRow(/Add to/, { left: 824, top: 40, right: 1048, bottom: 72 });

    // Whole literals, because Tailwind scans source text for class names — and the corner it is
    // pinned by is the corner it grows from, which is the app's anchored-popup rule.
    expect(panel).toHaveClass("right-full", "top-0", "origin-top-right");
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
   * Here that is a panel spanning 560–860 in an 800px window: `bottom-0` was the right answer from
   * the moment the decks arrived, and the 60px hanging past the edge holds real rows. There is no
   * `max-h`, no `overflow-y` and no scroller anywhere in the module, and the ancestor is `fixed`,
   * so those rows are unreachable by pointer and by caret alike.
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
    expect(panel).toHaveClass("left-full", "top-0", "origin-top-left");

    // The decks arrive and the panel grows to 300. jsdom computes no layout, so the growth is
    // stated and the notification delivered by hand — the browser's own next step after a box
    // changes size, and the one thing jsdom will never do on its own.
    act(() => {
      loader.load?.();
      statedSubmenuBox(MENU_MIN_WIDTH, 300);
      resized(panel);
    });
    expect(screen.getByRole("menuitem", { name: "Atraxa Superfriends" })).toBeInTheDocument();

    expect(panel).toHaveClass("left-full", "bottom-0", "origin-bottom-left");
  });
});
