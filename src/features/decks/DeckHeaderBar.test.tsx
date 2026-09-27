import { useEffect, useRef, type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The bar draws the toolbar's own `QuickAdd`, whose one command is `search_cards`. Nothing here
// types a card name, so it only has to answer — an empty page, never the real `invoke`.
const searchCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards },
}));

import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import type { MenuItem } from "@/components/menu/types";
import { installKeyboardModality, KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { boxed, startPointerDrag } from "@/test-drag";
import { DeckHeaderBar, type DeckHeaderBarProps } from "./DeckHeaderBar";
import { cardDraggable, type DragPayload } from "./dnd";

/**
 * The undocked deck bar — what it draws, what each control hands its host, and the three things
 * that decide whether it is drawn at all: the header having scrolled away, a caret or a menu still
 * inside it, and a card in the air.
 *
 * **What none of this can see is the box**: jsdom lays nothing out, so `sticky`, the 50px panel,
 * the zero-height wrapper that costs the deck no layout and the clearance a neighbour is offset
 * by are all the live pass's to prove. What is asserted here is structure and behaviour.
 */

const DISPLAY = "Display: Stacks, grouped by Category, sorted by Name";
const UNDO = "Undo — Removed 2 × Lightning Bolt";

/**
 * The bar, **as the accessibility tree has it** — so a bar on its way out, which `PopupPanel`
 * marks `aria-hidden` for the length of its fade, already reads as gone. That is the half a
 * "still here" assertion needs: an exiting bar is still in the DOM for a frame, and a DOM query
 * would call it present.
 */
const bar = () => screen.queryByRole("group", { name: "Deck toolbar" });

/** The bar in the DOM at all, fading or not — for the assertions that it has really left. */
const barInDom = () => document.querySelector('[role="group"][aria-label="Deck toolbar"]');

/** Every prop, at a deck with a plan, on its Actual list, with one change to take back. */
function props(over: Partial<DeckHeaderBarProps> = {}): DeckHeaderBarProps {
  return {
    undocked: true,
    tight: false,
    onTop: vi.fn(),
    quickAddTarget: null,
    onQuickAdd: vi.fn(),
    lists: { variant: "live", onPick: vi.fn(), onCompare: vi.fn(), comparing: false },
    undo: { label: UNDO, disabled: false, run: vi.fn() },
    redo: { label: "Redo", disabled: true, run: vi.fn() },
    displayName: DISPLAY,
    displayMenu: vi.fn((): MenuItem[] => [
      { kind: "action", id: "grid", label: "Grid", onSelect: vi.fn() },
    ]),
    filter: "",
    onFilter: vi.fn(),
    actionsMenu: vi.fn((): MenuItem[] => [
      { kind: "action", id: "settings", label: "Deck settings", onSelect: vi.fn() },
    ]),
    ...over,
  };
}

/**
 * The bar inside the providers the app mounts it under, with somewhere outside it to take the
 * caret to. `extra` is drawn beside it — a drag source, for the two drag tests.
 *
 * `rerender` takes a patch rather than a whole prop set, so a test that is about one prop moving
 * says only that prop.
 */
function mount(over: Partial<DeckHeaderBarProps> = {}, extra?: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let current = props(over);
  const ui = (p: DeckHeaderBarProps) => (
    <QueryClientProvider client={client}>
      <ContextMenuProvider>
        {extra}
        <DeckHeaderBar {...p} />
        <button type="button">Elsewhere</button>
      </ContextMenuProvider>
    </QueryClientProvider>
  );
  const view = render(ui(current));
  return {
    props: current,
    rerender: (patch: Partial<DeckHeaderBarProps>) => {
      current = { ...current, ...patch };
      view.rerender(ui(current));
    },
  };
}

/** What a caret or a pointer is told each control is, in the order they sit on the bar. */
const nameOf = (el: Element) => el.getAttribute("aria-label") ?? el.textContent ?? "";

/** A printing off the wall, picked up — the drag the bar has to get out of the way of. */
const TILE: DragPayload = {
  kind: "search-card",
  cardId: "c-bolt",
  name: "Lightning Bolt",
  typeLine: "Instant",
};

/** Something to pick up, registered exactly as a card is — `QuickZones.test.tsx`'s source. */
function Source() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    boxed(element, 400);
    return cardDraggable({ element, payload: () => TILE });
  }, []);
  return <div ref={ref}>the card</div>;
}

/** Let React finish whatever the last event scheduled, so a "still here" is not read early. */
const settle = () => act(async () => {});

/**
 * Run a test with the app's keyboard-modality watcher installed, as `main.tsx` installs it.
 *
 * The bar asks it whether a caret on a *button* came by keyboard, and the suite does not install
 * it globally — so a test about that question installs it **before mounting**, which is the
 * app's order too: its `keydown` listener has to run ahead of the menu's Escape rung, both being
 * `window` capture listeners in registration order. The attribute it writes on `<html>` outlives
 * the uninstaller by design, so it is cleared here as well.
 */
async function withKeyboardModality(run: () => Promise<void>) {
  const uninstall = installKeyboardModality(window);
  try {
    await run();
  } finally {
    uninstall();
    document.documentElement.removeAttribute(KEYBOARD_MODALITY_ATTR);
  }
}

beforeEach(() => {
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
});

describe("DeckHeaderBar", () => {
  it("draws nothing while the header is docked", () => {
    mount({ undocked: false });

    expect(barInDom()).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the top" })).toBeNull();
  });

  /**
   * The order is the design's, read left to right: the way back, the quick add, the two lists
   * and their comparison, then — past the slack — history, how the deck is drawn, the filter, and
   * everything else. Every name is its header twin's, which is the point of the bar.
   */
  it("draws the header's controls in one line once the header has scrolled away", () => {
    mount();
    const toolbar = bar();
    expect(toolbar).not.toBeNull();

    const controls = [...toolbar!.querySelectorAll("button, input")];
    expect(controls.map(nameOf)).toEqual([
      "Back to the top",
      "Quick add a card",
      "Theory",
      "Actual",
      "Compare",
      UNDO,
      "Redo",
      DISPLAY,
      "Filter this deck",
      "Deck actions",
    ]);

    const inBar = within(toolbar!);
    expect(inBar.getByRole("combobox")).toHaveAccessibleName("Quick add a card");
    expect(inBar.getByRole("searchbox")).toHaveAccessibleName("Filter this deck");
    expect(inBar.getByRole("group", { name: "Undo and redo" })).toBeInTheDocument();
    // The Actual list is on screen, so that half is pressed and the plan's is not.
    const lists = inBar.getByRole("group", { name: "Deck list" });
    expect(within(lists).getByRole("button", { name: "Actual" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(lists).getByRole("button", { name: "Theory" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("names the quick add for the pile it files into, exactly as the toolbar's does", () => {
    mount({ quickAddTarget: "Sideboard" });

    expect(within(bar()!).getByRole("combobox")).toHaveAccessibleName(
      "Quick add a card to Sideboard",
    );
  });

  /** A deck with one list draws no switch between lists, and nothing to compare them with. */
  it("draws neither the list switch nor Compare for a deck with no plan", () => {
    mount({ lists: null });
    const toolbar = within(bar()!);

    expect(toolbar.queryByRole("group", { name: "Deck list" })).toBeNull();
    expect(toolbar.queryByRole("button", { name: "Compare" })).toBeNull();
    // …and the rest of the bar is untouched by it.
    expect(toolbar.getByRole("button", { name: UNDO })).toBeInTheDocument();
    expect(toolbar.getByRole("searchbox", { name: "Filter this deck" })).toBeInTheDocument();
  });

  it("switches lists, and hands Compare its own button", async () => {
    const user = userEvent.setup();
    const { props: p } = mount();
    const toolbar = within(bar()!);

    await user.click(toolbar.getByRole("button", { name: "Theory" }));
    expect(p.lists!.onPick).toHaveBeenCalledWith("theory");

    const compare = toolbar.getByRole("button", { name: "Compare" });
    expect(compare).toHaveAttribute("aria-haspopup", "dialog");
    expect(compare).toHaveAttribute("aria-expanded", "false");
    await user.click(compare);
    expect(p.lists!.onCompare).toHaveBeenCalledWith(compare);
  });

  it("says the comparison is open while it is", () => {
    mount({ lists: { variant: "theory", onPick: vi.fn(), onCompare: vi.fn(), comparing: true } });

    expect(within(bar()!).getByRole("button", { name: "Compare" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  /**
   * `aria-disabled` and never the attribute — a caret on the button stays on it when the history
   * runs out — so the press itself has to refuse, and this is what checks that it does.
   */
  it("greys a history press with nothing to take back, and pressing it does nothing", async () => {
    const user = userEvent.setup();
    const { props: p } = mount();
    const toolbar = within(bar()!);
    const undo = toolbar.getByRole("button", { name: UNDO });
    const redo = toolbar.getByRole("button", { name: "Redo" });

    expect(redo).toHaveAttribute("aria-disabled", "true");
    expect(redo).not.toHaveAttribute("disabled");
    expect(redo.classList.contains("opacity-40")).toBe(true);
    await user.click(redo);
    expect(p.redo.run).not.toHaveBeenCalled();

    expect(undo).toHaveAttribute("aria-disabled", "false");
    expect(undo.classList.contains("opacity-40")).toBe(false);
    await user.click(undo);
    expect(p.undo.run).toHaveBeenCalledTimes(1);
  });

  it("takes the page back to its top", async () => {
    const user = userEvent.setup();
    const { props: p } = mount();

    await user.click(within(bar()!).getByRole("button", { name: "Back to the top" }));

    expect(p.onTop).toHaveBeenCalledTimes(1);
  });

  /** One piece of state in two fields: the bar reports what was typed and draws what it is given. */
  it("filters the deck through the header's own state", async () => {
    const user = userEvent.setup();
    const { props: p } = mount({ filter: "gob" });
    const field = within(bar()!).getByRole("searchbox", { name: "Filter this deck" });

    expect(field).toHaveValue("gob");
    await user.type(field, "l");
    expect(p.onFilter).toHaveBeenLastCalledWith("gobl");
  });

  /**
   * **The header field's Escape, exactly**: a box with text owns one press and says so, and an
   * empty box owns none — the press falls through to the editor's own floor, which closes the
   * deck. The second half is the one that fails quietly, so it is asserted by what reaches
   * `window`.
   */
  it("spends one Escape emptying a filter with text in it", async () => {
    const user = userEvent.setup();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    try {
      const { props: withText } = mount({ filter: "gob" });
      await user.click(within(bar()!).getByRole("searchbox"));
      await user.keyboard("{Escape}");
      expect(withText.onFilter).toHaveBeenCalledWith("");
      expect(heard).toEqual([true]);
    } finally {
      window.removeEventListener("keydown", listen);
    }
  });

  it("lets Escape in an empty filter reach the window untouched", async () => {
    const user = userEvent.setup();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    try {
      const { props: p } = mount();
      await user.click(within(bar()!).getByRole("searchbox"));
      await user.keyboard("{Escape}");
      expect(p.onFilter).not.toHaveBeenCalled();
      expect(heard).toEqual([false]);
    } finally {
      window.removeEventListener("keydown", listen);
    }
  });

  /**
   * The Display menu is the app's one context menu, opened from a button whose whole job that
   * is. `aria-haspopup` is the button's to say and `aria-expanded` is not — the open state is the
   * menu provider's, and a static `false` would be wrong for as long as the menu is up.
   */
  it("opens the shared menu with the Display rows", async () => {
    const user = userEvent.setup();
    const { props: p } = mount();
    const display = within(bar()!).getByRole("button", { name: DISPLAY });

    expect(display).toHaveAttribute("aria-haspopup", "menu");
    expect(display).not.toHaveAttribute("aria-expanded");
    await user.click(display);

    expect(await screen.findByRole("menuitem", { name: "Grid" })).toBeInTheDocument();
    expect(p.displayMenu).toHaveBeenCalledTimes(1);
  });

  /** The `⋯` hands its builder the button, so a dialog raised from a row can give the caret back. */
  it("opens the deck's actions and hands their builder the button that asked", async () => {
    const user = userEvent.setup();
    const { props: p } = mount();
    const actions = within(bar()!).getByRole("button", { name: "Deck actions" });

    expect(actions).toHaveAttribute("aria-haspopup", "menu");
    expect(actions).not.toHaveAttribute("aria-expanded");
    await user.click(actions);

    expect(await screen.findByRole("menuitem", { name: "Deck settings" })).toBeInTheDocument();
    expect(p.actionsMenu).toHaveBeenCalledWith(actions);
  });

  /** The positive control for the two below: with nothing holding it, docking takes it away. */
  it("goes when the header docks again", async () => {
    const { rerender } = mount();
    expect(bar()).not.toBeNull();

    rerender({ undocked: false });

    await waitFor(() => expect(barInDom()).toBeNull());
  });

  /**
   * **Scrolling up with the caret in the bar must not drop the caret on `<body>`** — so the bar
   * outlives `undocked` for as long as the caret is in it, and goes the moment it leaves.
   */
  it("stays while the caret is inside it after the header docks, and goes when it leaves", async () => {
    const user = userEvent.setup();
    const { rerender } = mount();
    await user.click(within(bar()!).getByRole("searchbox", { name: "Filter this deck" }));

    rerender({ undocked: false });
    await settle();

    expect(bar()).not.toBeNull();
    expect(within(bar()!).getByRole("searchbox", { name: "Filter this deck" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    await waitFor(() => expect(barInDom()).toBeNull());
  });

  /**
   * A menu takes the caret while it is up and gives it back to its opener when it shuts — so a
   * bar held by nothing but that opener has to still be there to take it. Escape hands it back,
   * which is a keyboard arrival, so the caret then holds the bar on its own.
   */
  it("stays while a menu it opened is up, and takes the caret back when it shuts", async () => {
    await withKeyboardModality(async () => {
      const user = userEvent.setup();
      const { rerender } = mount();
      const display = within(bar()!).getByRole("button", { name: DISPLAY });
      await user.click(display);
      await screen.findByRole("menu");

      rerender({ undocked: false });
      await settle();
      expect(bar()).not.toBeNull();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(display).toHaveFocus();
      await settle();
      expect(bar()).not.toBeNull();

      await user.click(screen.getByRole("button", { name: "Elsewhere" }));
      await waitFor(() => expect(barInDom()).toBeNull());
    });
  });

  /**
   * **A clicked button does not hold the bar.** Chromium focuses a button on a mouse press as a
   * side effect, and a bar held by that caret would stay pinned over the docked header — over its
   * actions row — until the reader happened to click somewhere else.
   */
  it("does not stay for a caret a mouse press left on one of its buttons", async () => {
    await withKeyboardModality(async () => {
      const user = userEvent.setup();
      const { rerender } = mount();
      const undo = within(bar()!).getByRole("button", { name: UNDO });
      await user.click(undo);
      expect(undo).toHaveFocus();

      rerender({ undocked: false });

      await waitFor(() => expect(barInDom()).toBeNull());
    });
  });

  /**
   * A caret the keyboard walked onto a button *does* hold it — and `Back to the top` still lets
   * go, because bringing the header back is its whole job and a bar left over the header it just
   * docked would undo the press.
   */
  it("stays for a caret the keyboard brought, and lets go of it on Back to the top", async () => {
    await withKeyboardModality(async () => {
      const user = userEvent.setup();
      const { props: p, rerender } = mount();
      // The first tab stop on the page is the bar's first control.
      await user.tab();
      const top = within(bar()!).getByRole("button", { name: "Back to the top" });
      expect(top).toHaveFocus();

      rerender({ undocked: false });
      await settle();
      expect(bar()).not.toBeNull();

      await user.keyboard("{Enter}");
      expect(p.onTop).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(barInDom()).toBeNull());
    });
  });

  /**
   * The quick zones take the same strip for exactly the length of a drag, and a drop target the
   * pointer is being carried to must not have a toolbar over it.
   */
  it("gives way to a drag and comes back when the card lands", async () => {
    mount({}, <Source />);
    expect(bar()).not.toBeNull();

    const held = await startPointerDrag(screen.getByText("the card"));
    try {
      expect(held.started).toBe(true);
      await waitFor(() => expect(barInDom()).toBeNull());
    } finally {
      await held.cancel();
    }

    await waitFor(() => expect(bar()).not.toBeNull());
  });

  /**
   * **A drag puts the bar down whatever held it.** The bar leaves the DOM with the caret in it and
   * no blur is fired for a removed element, so a flag left standing would bring the bar back over
   * a docked header the moment the card landed.
   */
  it("does not come back after a drag on the strength of a caret the drag took away", async () => {
    const user = userEvent.setup();
    const { rerender } = mount({}, <Source />);
    await user.click(within(bar()!).getByRole("searchbox", { name: "Filter this deck" }));
    rerender({ undocked: false });
    await settle();
    // Held by the caret alone.
    expect(bar()).not.toBeNull();

    const held = await startPointerDrag(screen.getByText("the card"));
    try {
      await waitFor(() => expect(barInDom()).toBeNull());
    } finally {
      await held.cancel();
    }
    await settle();
    expect(barInDom()).toBeNull();

    // The drag really did end: with the header scrolled away again, the bar is back.
    rerender({ undocked: true });
    await waitFor(() => expect(bar()).not.toBeNull());
  });

  /**
   * Narrower fields when the column is tight — the widths the bar's arithmetic is written for.
   * `classList`, never a substring of `className`, which a `hover:` or `focus:` spelling of the
   * same utility would satisfy before anything happened.
   */
  it("narrows both fields when the column is tight", () => {
    mount({ tight: true });
    const toolbar = within(bar()!);

    const quickAdd = toolbar.getByRole("combobox");
    expect(quickAdd.classList.contains("w-44")).toBe(true);
    expect(quickAdd.classList.contains("w-60")).toBe(false);
    expect(quickAdd.classList.contains("w-52")).toBe(false);

    const filterBox = toolbar.getByRole("searchbox").parentElement!;
    expect(filterBox.classList.contains("w-37")).toBe(true);
    expect(filterBox.classList.contains("w-60")).toBe(false);
  });

  it("draws both fields at 240px when the column has room", () => {
    mount();
    const toolbar = within(bar()!);

    expect(toolbar.getByRole("combobox").classList.contains("w-60")).toBe(true);
    expect(toolbar.getByRole("searchbox").parentElement!.classList.contains("w-60")).toBe(true);
  });

  /**
   * The bar's quick add says its status *under* the field — and while it has nothing to say, the
   * one live region is still mounted, visually hidden rather than absent.
   */
  it("mounts its quick add's live region, hidden while it is empty", () => {
    mount();

    const status = within(bar()!).getByRole("status");
    expect(status).toHaveTextContent("");
    expect(status.classList.contains("sr-only")).toBe(true);
  });
});
