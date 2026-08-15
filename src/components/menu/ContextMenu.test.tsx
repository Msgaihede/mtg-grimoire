import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MenuRows, SUBMENU_HOVER_MS } from "./ContextMenu";
import { ContextMenuProvider } from "./ContextMenuProvider";
import { useContextMenu } from "./useContextMenu";
import type { MenuItem } from "./types";

/**
 * jsdom has no layout engine, so `documentElement.clientWidth` is a hard 0 on every element.
 * A test therefore has to state a viewport itself -- and must not state it as
 * `window.innerWidth`, which is the buggy expression this repo has already pinned once as an
 * expected answer. See src/CLAUDE.md.
 */
function statedViewport(width: number, height: number) {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
}

function Host({ items }: { items: MenuItem[] }) {
  const { menu } = useContextMenu();
  return <button onContextMenu={menu(() => items)}>target</button>;
}

function open(items: MenuItem[]) {
  render(
    <ContextMenuProvider>
      <Host items={items} />
    </ContextMenuProvider>,
  );
}

/**
 * The right-click the tests above open with, as one line — and inside `act`.
 *
 * A raw `dispatchEvent` is not flushed synchronously: React queues the update and the assertion
 * on the next line runs against the render before it, which is why every test above has to
 * `await findByRole`. Wrapping the dispatch lets the panel be asserted on immediately, and that
 * is not a convenience — the hover test below runs on fake timers, where `findBy*`'s own polling
 * has nothing real left to poll with.
 */
function rightClick(el: Element, at?: { clientX: number; clientY: number }) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...at });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => statedViewport(1280, 800));
afterEach(() => vi.useRealTimers());

describe("ContextMenu", () => {
  it("opens on right-click and suppresses the native menu", async () => {
    const onSelect = vi.fn();
    open([{ kind: "action", id: "copy", label: "Copy card name", onSelect }]);

    const target = screen.getByRole("button", { name: "target" });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy card name" })).toBeInTheDocument();
  });

  it("runs the item and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    open([{ kind: "action", id: "copy", label: "Copy card name", onSelect }]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    await user.click(await screen.findByRole("menuitem", { name: "Copy card name" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("draws a disabled item with its reason, and does not run it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    open([
      {
        kind: "action",
        id: "cmd",
        label: "Set as commander",
        disabled: true,
        reason: "not a legendary creature",
        onSelect,
      },
    ]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    const row = await screen.findByRole("menuitem", { name: /Set as commander/ });
    // aria-disabled and never the `disabled` attribute -- the greyed item exists to be read,
    // so it has to stay in the tab order.
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toHaveAttribute("disabled");
    expect(within(row).getByText("not a legendary creature")).toBeInTheDocument();

    await user.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves the caret with the arrows, skipping separators", async () => {
    const user = userEvent.setup();
    open([
      { kind: "action", id: "a", label: "First", onSelect: vi.fn() },
      { kind: "separator", id: "s" },
      { kind: "action", id: "b", label: "Second", onSelect: vi.fn() },
    ]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    // Assert with the keyboard rather than by checking focus after a click: `user.click`
    // focuses what it is handed, so a focus assertion after one proves nothing.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  });

  it("opens a submenu with ArrowRight and leaves it with ArrowLeft", async () => {
    const user = userEvent.setup();
    open([
      {
        kind: "submenu",
        id: "open-on",
        label: "Open on",
        items: [{ kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() }],
      },
    ]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    await user.keyboard("{ArrowDown}");
    const parent = screen.getByRole("menuitem", { name: /Open on/ });
    expect(parent).toHaveAttribute("aria-haspopup", "menu");
    expect(parent).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowRight}");
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(parent).toHaveFocus();
  });

  it("closes one level per Escape", async () => {
    const user = userEvent.setup();
    open([
      {
        kind: "submenu",
        id: "open-on",
        label: "Open on",
        items: [{ kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() }],
      },
    ]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Scryfall" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("hands focus back to the element that was right-clicked", async () => {
    const user = userEvent.setup();
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    const target = screen.getByRole("button", { name: "target" });
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");
    expect(target).toHaveFocus();
  });

  it("mounts a lazy submenu's content only once it is expanded", async () => {
    const user = userEvent.setup();
    const mounted = vi.fn();
    function Content() {
      mounted();
      return (
        <div role="menuitem" tabIndex={-1}>
          loaded
        </div>
      );
    }
    open([{ kind: "lazy", id: "deck", label: "Deck", Content }]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    // The whole point of the `lazy` kind: opening the menu must not reach the backend.
    expect(mounted).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("flips left when it would overflow the stated viewport width", async () => {
    statedViewport(1280, 800);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    const target = screen.getByRole("button", { name: "target" });
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 1270,
        clientY: 40,
      }),
    );

    const panel = await screen.findByRole("menu");
    // Pinned by, and growing from, the corner nearest the pointer -- the app's anchored-popup
    // rule. Written out whole, because Tailwind scans source text for class names.
    expect(panel).toHaveClass("origin-top-right");
    expect(Number.parseFloat(panel.style.left)).toBeLessThan(1270);
  });

  it("flips up when it would overflow the stated viewport height", async () => {
    statedViewport(1280, 800);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    screen.getByRole("button", { name: "target" }).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 790,
      }),
    );

    const panel = await screen.findByRole("menu");
    expect(panel).toHaveClass("origin-bottom-left");
  });

  /**
   * The assertion the two flip tests above cannot make, and the reason it needs its own case.
   *
   * Both of those state a viewport of 1280x800 and open near an edge — and jsdom's own
   * `window.innerWidth` is **1024**, which is narrower still, so a panel that overflows the stated
   * viewport overflows the buggy one too and both expressions flip. They are true statements about
   * the flip and say nothing at all about which width was read. That is precisely how the zoom
   * badge's 15px error survived a green suite: the test stated `window.innerWidth` as its
   * viewport and pinned the defect as the expected answer.
   *
   * So: a point that fits comfortably inside the **stated** viewport and overflows jsdom's
   * `innerWidth`. 900 + 224 + 8 is 1132 — under 1280 and over 1024. Reading the wrong width flips
   * a menu that had 356px of room, and this is the only test in the file that would go red for it.
   */
  it("measures the room to the right against the stated viewport, not innerWidth", async () => {
    expect(window.innerWidth).toBeLessThan(1280);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    rightClick(screen.getByRole("button", { name: "target" }), { clientX: 900, clientY: 40 });

    const panel = await screen.findByRole("menu");
    expect(panel).toHaveClass("origin-top-left");
    expect(Number.parseFloat(panel.style.left)).toBe(900);
  });

  /**
   * The same trap on the other axis, which the first version of this file left open.
   *
   * `clientY: 790` in the flip-up test above is 840 once the panel and the gutter are counted —
   * over the stated 800 *and* over jsdom's `innerHeight` of 768 — so it flips either way and says
   * nothing at all about which height was read. This one is `740`: 790 fits inside the stated
   * viewport and overflows jsdom's, so reading the wrong one flips a menu that had room.
   * `clientX: 40` keeps the other axis out of it — 272 is under both widths.
   */
  it("measures the room below against the stated viewport, not innerHeight", async () => {
    expect(window.innerHeight).toBeLessThan(800);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    rightClick(screen.getByRole("button", { name: "target" }), { clientX: 40, clientY: 740 });

    const panel = await screen.findByRole("menu");
    expect(panel).toHaveClass("origin-top-left");
    expect(Number.parseFloat(panel.style.top)).toBe(740);
  });

  it("a second right-click replaces rather than stacking", async () => {
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    const target = screen.getByRole("button", { name: "target" });
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(await screen.findAllByRole("menu")).toHaveLength(1);
  });

  it("leaves the native menu alone inside a text field", () => {
    render(
      <ContextMenuProvider>
        <input aria-label="search" />
      </ContextMenuProvider>,
    );
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByLabelText("search").dispatchEvent(event);

    // Cut/copy/paste/undo and spellcheck suggestions, none of which we can rebuild.
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("suppresses the native menu on plain background with no menu of our own", () => {
    render(
      <ContextMenuProvider>
        <div data-testid="ground" style={{ width: 100, height: 100 }} />
      </ContextMenuProvider>,
    );
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("ground").dispatchEvent(event);

    // A WebView2 menu offering "Reload" and "View source" does not belong in a desktop app.
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * The text-field carve-out at the end the document suppressor cannot reach.
   *
   * A surface's `menu()` handler sits on a **row**, and rows contain fields — `QuantityStepper` is
   * an `<input>` inside the collection and deck tables' rows, and `FolderTree` puts one inside a
   * deck node, both of which are surfaces a later task wires. A right-click in one of those
   * bubbles to the row's handler, which `preventDefault()`s and `stopPropagation()`s, so the
   * provider's own test never runs and never gets the chance to save it. The field would lose
   * cut, copy, paste, undo and its spellcheck suggestions and get a card menu in their place.
   */
  it("leaves the native menu alone in a field inside a surface that has a menu", () => {
    const onSelect = vi.fn();
    function RowHost() {
      const { menu } = useContextMenu();
      return (
        <div onContextMenu={menu(() => [{ kind: "action", id: "a", label: "First", onSelect }])}>
          <input aria-label="quantity" />
          <span data-testid="rest-of-row">Lightning Bolt</span>
        </div>
      );
    }
    render(
      <ContextMenuProvider>
        <RowHost />
      </ContextMenuProvider>,
    );

    const inField = rightClick(screen.getByLabelText("quantity"));
    expect(inField.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // ...and the rest of the same row still gets the app's menu, so the carve-out is a carve-out
    // and not a surface that quietly opted out.
    const inRow = rightClick(screen.getByTestId("rest-of-row"));
    expect(inRow.defaultPrevented).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  /**
   * Hover, both halves. Plain React state and a `setTimeout`, so fake timers test it exactly.
   *
   * The closing half is the one that was unreachable: while only submenu rows carried the row
   * attribute, a pointer sweeping from "Open on" down to "Copy card name" resolved to no row at
   * all and returned, leaving the submenu hanging beside the panel until Escape or an outside
   * press.
   */
  it("opens a submenu under a resting pointer and closes it when the pointer moves on", () => {
    vi.useFakeTimers();
    open([
      {
        kind: "submenu",
        id: "open-on",
        label: "Open on",
        items: [{ kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() }],
      },
      { kind: "action", id: "copy", label: "Copy card name", onSelect: vi.fn() },
    ]);
    rightClick(screen.getByRole("button", { name: "target" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // `fireEvent.pointerOver` rather than `user.hover`: user-event's own waits deadlock against
    // vitest's fake clock, and `pointerover` is the event the panel actually listens for anyway —
    // React synthesises enter/leave from over/out and does not listen for `pointerenter` at all.
    // `QuickAdd` carries the same note about the same pair.
    fireEvent.pointerOver(screen.getByRole("menuitem", { name: /Open on/ }));
    // A pointer passing over a row is not a pointer pointing at it.
    expect(screen.queryByRole("menuitem", { name: "Scryfall" })).not.toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toBeInTheDocument();

    fireEvent.pointerOver(screen.getByRole("menuitem", { name: "Copy card name" }));
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));
    expect(screen.queryByRole("menuitem", { name: "Scryfall" })).not.toBeInTheDocument();
  });

  /**
   * The hover-collapse, from the one starting position the test above cannot reach.
   *
   * That test opens the submenu **by hover**, so the caret never leaves the root panel and the
   * collapse unmounts nothing the caret is in. This one opens it **by keyboard**, which is the
   * ordinary way in — the menu opens at the pointer, so the pointer is already resting on the
   * first row while the reader arrows down into a submenu — and then nudges the mouse.
   *
   * Every other close in the cascade hands the caret back before it unmounts anything: ArrowLeft
   * focuses the parent row, a submenu's Escape focuses its own row, a click on a parent row is
   * focused by the click itself. The hover timer was the one route that wrote `openPath` directly,
   * and an element holding `document.activeElement` unmounting drops the caret on `<body>` — which
   * is outside the React root, so the panel's `onKeyDown` never fires again. The arrows, Home and
   * End go dead, and so does **Tab**, which then falls through to the browser and walks focus into
   * the page behind a panel that is still up: exactly what the Tab branch exists to prevent.
   */
  it("hands the caret back when a hover collapses the panel it is in", () => {
    vi.useFakeTimers();
    open([
      {
        kind: "submenu",
        id: "open-on",
        label: "Open on",
        items: [{ kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() }],
      },
      { kind: "action", id: "copy", label: "Copy card name", onSelect: vi.fn() },
    ]);
    rightClick(screen.getByRole("button", { name: "target" }));
    const panel = screen.getByRole("menu");

    // By keyboard, so `focusInto` puts the caret on a row *inside* the submenu's panel.
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Open on/ }), { key: "ArrowRight" });
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toHaveFocus();

    // The pointer, which never moved off the row the menu opened under, is nudged onto a row that
    // opens nothing — so the sweep collapses the submenu the caret is in.
    fireEvent.pointerOver(screen.getByRole("menuitem", { name: "Copy card name" }));
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));
    expect(screen.queryByRole("menuitem", { name: "Scryfall" })).not.toBeInTheDocument();

    // Back on the row the closed panel hung off, the way ArrowLeft would have left it -- and in
    // particular not on `<body>`.
    expect(document.body).not.toHaveFocus();
    expect(screen.getByRole("menuitem", { name: /Open on/ })).toHaveFocus();

    // ...and the panel still owns its keys, which is the half that makes this more than untidy.
    // Fired at wherever the caret actually is: from `<body>` the press never reaches the React
    // root at all, so nothing moves.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Copy card name" })).toHaveFocus();
  });

  /**
   * The armed hover timer, and the one thing that can happen to a panel while it is running.
   *
   * A pointer leaving the panel fires no `pointerover` the panel can hear, so the timer stays
   * armed with the path it was going to open — and the reset on a new `openId` clears `openPath`
   * and `size` but is not, on its own, a reason for a timer belonging to the menu that just went
   * away to stop existing. One panel is reused across every open, so the stale callback lands on
   * the *new* menu.
   *
   * **Card menu ids are identical on every card**, which is what makes that a real failure rather
   * than a harmless one: the path still names a row of the menu now on screen, so card B's menu
   * spontaneously expands and mounts a `lazy` body the reader never asked for — firing the very
   * queries that kind exists to keep off a right-click.
   */
  it("disarms a pending hover when the panel is handed a new menu", () => {
    vi.useFakeTimers();
    const mounted = vi.fn();
    function Content() {
      mounted();
      return (
        <div role="menuitem" tabIndex={-1}>
          Burn
        </div>
      );
    }
    open([{ kind: "lazy", id: "deck", label: "Deck", Content }]);
    const target = screen.getByRole("button", { name: "target" });
    rightClick(target);

    // Armed, and not yet fired: a pointer resting on the row of card A's menu.
    fireEvent.pointerOver(screen.getByRole("menuitem", { name: /Deck/ }));
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS - 20));
    expect(mounted).not.toHaveBeenCalled();

    // The reader moves off the panel -- which the panel hears nothing about -- and right-clicks
    // the next card inside the window the timer is still running in.
    rightClick(target);
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));

    expect(mounted).not.toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: /Deck/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  /**
   * The same armed timer, against the other thing that can happen while it runs: the reader
   * **opening the very submenu it was going to open**, by a route the timer knows nothing about.
   *
   * `handBack` reads `openPath` out of the closure of the render that armed the timer, and a
   * `setTimeout` callback is a macrotask — so a click or an ArrowRight inside the 120ms window
   * leaves the callback reasoning about a cascade that no longer exists. The pointer settles on
   * "Open on" (armed: `next` is `["open-on"]`, closure `openPath` is `[]`), the reader clicks it
   * inside the window, `focusInto` puts the caret on the first row of the panel that opened — and
   * then the timer fires against the stale `[]`, computes that everything below depth 0 is doomed,
   * and hands the caret back to the row it came from. `setOpenPath(["open-on"])` writes what is
   * already there, so **the submenu stays open with the caret outside it**: ArrowDown then walks
   * the root panel, and Enter collapses the panel the reader had just asked for.
   *
   * Nothing defuses it. `clearHover` is called from `onPointerOver`, the `[openId]` effect and the
   * unmount — and a click made without moving the mouse fires no `pointerover`, because the panel
   * opens *beside* the row rather than under the pointer. The hand-back is what made this bite: it
   * used to be a `setOpenPath` with an equal path, i.e. a wasted render.
   */
  it("does not let a pending hover yank the caret out of a submenu the reader just opened", () => {
    vi.useFakeTimers();
    open([
      {
        kind: "submenu",
        id: "open-on",
        label: "Open on",
        items: [
          { kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() },
          { kind: "action", id: "ck", label: "Card Kingdom", onSelect: vi.fn() },
        ],
      },
      { kind: "action", id: "copy", label: "Copy card name", onSelect: vi.fn() },
    ]);
    rightClick(screen.getByRole("button", { name: "target" }));

    const row = screen.getByRole("menuitem", { name: /Open on/ });
    fireEvent.pointerOver(row);
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS - 20));
    expect(screen.queryByRole("menuitem", { name: "Scryfall" })).not.toBeInTheDocument();

    // The click, with the pointer left where it already was.
    fireEvent.click(row);
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toHaveFocus();

    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));

    // The submenu is open either way -- the stale write is equal to the live path -- so the caret
    // is the whole of what this pins.
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toHaveFocus();

    // ...and the keys therefore belong to the panel the reader opened, rather than to the one
    // behind it: the caret walks to the submenu's second row, not to the root panel's.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Card Kingdom" })).toHaveFocus();
  });

  it("takes Home and End to the ends of the list", async () => {
    const user = userEvent.setup();
    open([
      { kind: "action", id: "a", label: "First", onSelect: vi.fn() },
      { kind: "action", id: "b", label: "Second", onSelect: vi.fn() },
      { kind: "action", id: "c", label: "Third", onSelect: vi.fn() },
    ]);
    rightClick(screen.getByRole("button", { name: "target" }));
    await screen.findByRole("menu");

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Third" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  });

  /**
   * The keyboard's own way in. Both presses Windows spells "open the context menu" with, and the
   * anchor, which cannot come from a pointer that was never there — `0, 0` would open every one of
   * these in the corner of the window rather than under the thing they are about.
   *
   * jsdom has no layout, so the trigger's box is stated the way the viewport is.
   */
  describe("menuKey", () => {
    function KeyHost({ items }: { items: MenuItem[] }) {
      const { menuKey } = useContextMenu();
      return <button onKeyDown={menuKey(() => items)}>target</button>;
    }

    function openByKey() {
      render(
        <ContextMenuProvider>
          <KeyHost items={[{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]} />
        </ContextMenuProvider>,
      );
      const trigger = screen.getByRole("button", { name: "target" });
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        left: 120,
        top: 200,
        right: 300,
        bottom: 232,
        width: 180,
        height: 32,
        x: 120,
        y: 200,
        toJSON: () => ({}),
      });
      return trigger;
    }

    it("opens on Shift+F10, at the trigger's bottom-left", async () => {
      const user = userEvent.setup();
      const trigger = openByKey();
      trigger.focus();

      await user.keyboard("{Shift>}{F10}{/Shift}");

      const panel = await screen.findByRole("menu");
      expect(Number.parseFloat(panel.style.left)).toBe(120);
      expect(Number.parseFloat(panel.style.top)).toBe(232);
    });

    // `fireEvent` rather than `userEvent` for this one: the ContextMenu key is not in
    // user-event's keyboard map, and `{ContextMenu}` throws "Unknown key" rather than pressing it.
    it("opens on the ContextMenu key", async () => {
      const trigger = openByKey();
      fireEvent.keyDown(trigger, { key: "ContextMenu" });

      expect(await screen.findByRole("menu")).toBeInTheDocument();
    });

    it("leaves F10 alone without Shift", () => {
      const trigger = openByKey();
      fireEvent.keyDown(trigger, { key: "F10" });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  /**
   * **The contract a lazy body builds against**, and the reason `MenuRows` is exported at all.
   *
   * "Add to → Deck" is a folder→deck→variant tree that cannot be built until the row is expanded,
   * so it is a `MenuLazy` — and a lazy body that had to hand-roll its own rows would be a second
   * implementation of the caret, the focus styling and the expand/collapse keys, drifting from
   * this one from the first commit. So a `Content` renders `<MenuRows items={…} />` and gets the
   * real thing, nested `MenuSubmenu`s included.
   *
   * The whole of "the real thing" is asserted here, because every part of it is a way this could
   * silently half-work: the caret walks the foreign rows, a nested submenu carries its ARIA and
   * expands and collapses on the arrows, one Escape closes one level all the way back out — and
   * the body still does not mount until its row is expanded, which is the rule the `lazy` kind
   * exists for and the one thing that must not be traded for any of the rest.
   */
  it("gives a lazy body's own MenuRows the whole cascade", async () => {
    const user = userEvent.setup();
    const mounted = vi.fn();
    const pick = vi.fn();
    function Content() {
      mounted();
      return (
        <MenuRows
          items={[
            { kind: "action", id: "recent", label: "Recent deck", onSelect: vi.fn() },
            {
              kind: "submenu",
              id: "burn",
              label: "Burn",
              items: [{ kind: "action", id: "main", label: "Main deck", onSelect: pick }],
            },
          ]}
        />
      );
    }
    open([{ kind: "lazy", id: "deck", label: "Deck", Content }]);
    rightClick(screen.getByRole("button", { name: "target" }));
    await screen.findByRole("menu");

    // Still lazy. Wrapping the body in a cascade provider must not mount it.
    expect(mounted).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(mounted).toHaveBeenCalledTimes(1);
    // The caret went into the lazy panel and landed on a row this module never built.
    expect(screen.getByRole("menuitem", { name: "Recent deck" })).toHaveFocus();

    // ...and walks the foreign rows like any others.
    await user.keyboard("{ArrowDown}");
    const nested = screen.getByRole("menuitem", { name: /Burn/ });
    expect(nested).toHaveFocus();
    expect(nested).toHaveAttribute("aria-haspopup", "menu");
    expect(nested).toHaveAttribute("aria-expanded", "false");

    // A submenu nested two levels down, inside a foreign body, on the same two keys.
    await user.keyboard("{ArrowRight}");
    expect(nested).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Main deck" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(nested).toHaveAttribute("aria-expanded", "false");
    expect(nested).toHaveFocus();

    // One Escape per level, three levels deep: the nested panel, the lazy panel, the menu.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Main deck" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Main deck" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Recent deck" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Recent deck" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * A text field inside a panel — "Tag card ▸ New tag…" — and the keys it has to be given back.
   *
   * The panel owns `ArrowUp`/`ArrowDown`/`Home`/`End`/`ArrowLeft`/`ArrowRight` and `preventDefault`s
   * every one of them, which is right for a list of rows and wrong for a caret in a field: typing
   * works and *editing* does not. Nothing surfaced it until a body rendered the first input.
   */
  function tagField() {
    function Content() {
      return (
        <>
          <input aria-label="New tag" defaultValue="" />
          <MenuRows
            items={[{ kind: "action", id: "burn", label: "Existing tag", onSelect: vi.fn() }]}
          />
        </>
      );
    }
    open([{ kind: "lazy", id: "tag", label: "Tag card", Content }]);
    rightClick(screen.getByRole("button", { name: "target" }));
    return Content;
  }

  /**
   * A lazy body that finishes *without* a row — "Tag card ▸ New tag… ▸ Add" — hands the caret
   * back exactly as a row does.
   *
   * The two halves of that one panel used to disagree. Its tag rows are drawn by `MenuRows`, so
   * they go through `ctx.run` and put the caret back on the card; the `Add` button beside them
   * called `onDone`, which was a bare `onClose`, and dropped it on `<body>`. A reader pressing
   * `Add` has acted as deliberately as one picking an existing tag two rows above it, so
   * `ctx.close` is `run` with nothing to run.
   *
   * This sits at the primitive rather than in `deckCardMenu.test.tsx` because that is where the
   * fix is — and because the builder's own test renders the body standalone with a `vi.fn()`
   * `onDone`, where there is no panel and no opener for a lost caret to be lost *from*. That is
   * the shape of test this defect hid behind for the whole branch.
   */
  it("hands the caret back when a lazy body finishes without a row", async () => {
    const user = userEvent.setup();
    function Content({ onDone }: { onDone: () => void }) {
      return (
        <>
          <input aria-label="New tag" defaultValue="" />
          <button type="button" onClick={onDone}>
            Add
          </button>
        </>
      );
    }
    open([{ kind: "lazy", id: "tag", label: "Tag card", Content }]);
    const target = screen.getByRole("button", { name: "target" });
    rightClick(target);
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");

    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(target).toHaveFocus();
  });

  it("gives the caret keys to a text field inside a panel", async () => {
    const user = userEvent.setup();
    tagField();
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");

    const field = screen.getByLabelText<HTMLInputElement>("New tag");
    await user.click(field);
    await user.keyboard("burn");
    expect(field).toHaveValue("burn");
    expect(field.selectionStart).toBe(4);

    // Each of these moves the *caret*. With the panel consuming them, focus jumps to a row
    // instead and the next character the reader types goes somewhere else entirely.
    await user.keyboard("{Home}");
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);

    await user.keyboard("{End}");
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(4);

    await user.keyboard("{ArrowLeft}");
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(3);

    await user.keyboard("{ArrowRight}");
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(4);
  });

  /**
   * The pair with no caret meaning in a single-line input, and the one real decision here.
   *
   * They could have stayed the menu's — but the failure mode of keeping them is the worst one
   * available: focus leaves the field mid-word and the following characters land on a row. The
   * failure mode of yielding is "I press Escape to get back to the menu", which is recoverable and
   * which Escape already does. So a field is a **mode**: while the caret is in one, every key this
   * handler owns belongs to the field. Half-yielding would be a rule nobody can learn.
   */
  /**
   * The keyboard's only route to a field, and the reason it is a caret **stop** rather than the
   * caret's destination.
   *
   * A field a lazy body draws is not a `menuitem`, so it was never on the caret walk; it was
   * reachable only as a panel's one tab stop, which Tab closing the menu took away. A reader who
   * opened the menu with `menuKey` — the entry point that exists for exactly that reader — could
   * see "New tag…" and never put a caret in it.
   *
   * Landing *on* the field instead would have swapped the problem for its mirror: every caret key
   * yields once the caret is inside one, so the rows above it become the unreachable half. The
   * real consumer's panel draws its existing tags first and the new-tag field last, which is what
   * this fixture models — so ArrowRight lands on the tags and ArrowDown walks down into the field.
   */
  it("walks the caret from a panel's rows into the field it also holds", async () => {
    const user = userEvent.setup();
    function Content() {
      return (
        <>
          <MenuRows
            items={[{ kind: "action", id: "burn", label: "Existing tag", onSelect: vi.fn() }]}
          />
          <input aria-label="New tag" defaultValue="" />
        </>
      );
    }
    open([{ kind: "lazy", id: "tag", label: "Tag card", Content }]);
    rightClick(screen.getByRole("button", { name: "target" }));
    await screen.findByRole("menu");

    await user.keyboard("{ArrowDown}{ArrowRight}");
    // The rows first, in document order -- not the field, which would strand them.
    expect(screen.getByRole("menuitem", { name: "Existing tag" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByLabelText("New tag")).toHaveFocus();

    // And it is a caret from here on: typing goes in rather than firing the row above.
    await user.keyboard("burn");
    expect(screen.getByLabelText("New tag")).toHaveValue("burn");
  });

  /**
   * The narrowing: a checkbox is not a text field, and a checkbox list is the most natural drawing
   * of the very body this work exists for. The arrows do nothing to one, so a menu that yielded
   * them would strand the caret with only Escape and Tab as ways out.
   */
  it("keeps the caret keys for a checkbox in a lazy body", async () => {
    const user = userEvent.setup();
    function Content() {
      return (
        <>
          <MenuRows items={[{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]} />
          <input type="checkbox" aria-label="Foil only" />
        </>
      );
    }
    open([{ kind: "lazy", id: "filter", label: "Filter", Content }]);
    rightClick(screen.getByRole("button", { name: "target" }));
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await user.click(screen.getByLabelText("Foil only"));

    // The menu still owns the arrows here, so the caret gets back to the rows.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  });

  it("does not move the menu's caret out of a field on ArrowDown", async () => {
    const user = userEvent.setup();
    tagField();
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");

    const field = screen.getByLabelText<HTMLInputElement>("New tag");
    await user.click(field);
    await user.keyboard("{ArrowDown}");
    expect(field).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(field).toHaveFocus();
  });

  /**
   * Escape is untouched by any of this and must stay so: it is `useDismissOnEscape` on `window`,
   * not the panel's `onKeyDown`, so yielding the caret keys cannot have taken it away. It is also
   * the reader's way back out of the field — which is half the argument for yielding the rest.
   */
  it("still closes the panel a field is in, on Escape", async () => {
    const user = userEvent.setup();
    tagField();
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    await user.click(screen.getByLabelText("New tag"));

    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("New tag")).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  /**
   * The pointer half of the same problem, and the one that costs the reader their words.
   *
   * Hover-to-open is the panel assuming its contents are rows: a sweep onto a row that opens
   * nothing collapses whatever was open — which, once a panel holds a field, is a half-typed tag
   * name deleted by a nudge of the mouse while the reader is looking at the keyboard. A field is a
   * mode for the pointer exactly as it is for the arrows.
   */
  it("does not let a pointer sweep collapse a panel the reader is typing in", async () => {
    const user = userEvent.setup();
    function Content() {
      return <input aria-label="New tag" defaultValue="" />;
    }
    open([
      { kind: "lazy", id: "tag", label: "Tag card", Content },
      { kind: "action", id: "copy", label: "Copy card name", onSelect: vi.fn() },
    ]);
    rightClick(screen.getByRole("button", { name: "target" }));
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    const field = screen.getByLabelText("New tag");
    await user.click(field);
    await user.keyboard("burn");
    expect(field).toHaveValue("burn");

    // Fake timers only from here: user-event's own waits deadlock against them, so the typing
    // above has to happen on the real clock.
    vi.useFakeTimers();
    fireEvent.pointerOver(screen.getByRole("menuitem", { name: "Copy card name" }));
    act(() => void vi.advanceTimersByTime(SUBMENU_HOVER_MS));

    expect(screen.getByLabelText("New tag")).toHaveValue("burn");
  });

  /**
   * Tab closes the menu, and — unlike Escape — does not hand the caret back to the opener.
   *
   * That pairing is the thing to get right, because the two run the same two lines and are meant
   * to end somewhere different. Escape's rung `preventDefault`s, so the caret *stays* on the
   * opener; Tab lets the press through, so the opener is a waypoint the browser carries on past.
   * A reader who pressed Tab asked to move on, not to be put back where they started. The Escape
   * test above asserts `toHaveFocus` on this same element; this one asserts the negative, and the
   * two together are the contrast.
   *
   * **Where the caret finally lands is unpinnable here by construction, not merely awkward.**
   * user-event's `Tab` behaviour calls `getTabDestination(target, …)` *after* dispatch and against
   * the live DOM — so the destination is fresh; what is frozen is the **anchor**, which is the
   * keydown target, the row the caret was on. The close detaches that row, `getTabDestination`
   * fails to find its anchor in the document, steps to index 0, and returns `prunedElements[0]`,
   * which is hard-coded `document.body`. The consequence is stronger than "jsdom is awkward":
   * because the anchor is the keydown target and can never be anything else, **`opener?.focus()`
   * cannot influence the destination under any DOM arrangement a test could build.** No
   * rearrangement of this test would pin it; only the shipped window can, where the browser's own
   * default action runs against the live DOM with the opener focused and the menu gone.
   *
   * The control below is the modest claim it looks like and no more: with nothing in the way the
   * same `user.tab()` reaches the next button, so tabbing works at all. It does **not** isolate the
   * unmount as the cause of the `body` landing — nothing here can.
   *
   * What this test *does* pin, beyond the contrast, is the deliberate absence of `preventDefault`:
   * user-event skips the behaviour entirely on a default-prevented event, so adding one would
   * leave focus on `target` and the assertion below would fail.
   */
  it("closes on Tab and does not hand the caret back the way Escape does", async () => {
    const user = userEvent.setup();
    render(
      <ContextMenuProvider>
        <Host items={[{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]} />
        <button>after</button>
      </ContextMenuProvider>,
    );
    const target = screen.getByRole("button", { name: "target" });
    rightClick(target);
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}");

    await user.tab();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(target).not.toHaveFocus();

    // The control described above.
    target.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  /**
   * Tab is the one key a field does *not* get, and the half-typed name goes with the panel.
   *
   * That is the house rule rather than a shrug — `FolderTree`'s rename field says in as many words
   * that clicking or tabbing away discards a half-typed name, as every other popup in this app
   * discards its half-made decision. Committing instead is not something the menu *can* do: a
   * lazy body is somebody else's component and `MenuLazy` hands it nothing but `onDone`, so a
   * commit handshake is a change to the contract rather than a bug fix.
   */
  it("closes on Tab out of a field, discarding what was typed", async () => {
    const user = userEvent.setup();
    tagField();
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    const field = screen.getByLabelText("New tag");
    await user.click(field);
    await user.keyboard("burn");
    expect(field).toHaveValue("burn");

    await user.tab();

    expect(screen.queryByLabelText("New tag")).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("runs a foreign row's action and closes the whole menu", async () => {
    const user = userEvent.setup();
    const pick = vi.fn();
    function Content() {
      return (
        <MenuRows items={[{ kind: "action", id: "main", label: "Main deck", onSelect: pick }]} />
      );
    }
    open([{ kind: "lazy", id: "deck", label: "Deck", Content }]);
    rightClick(screen.getByRole("button", { name: "target" }));
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");

    await user.click(screen.getByRole("menuitem", { name: "Main deck" }));

    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /**
   * The one ordering claim the provider rests on, pinned rather than assumed.
   *
   * React attaches **one** listener per event type to the root container it was created against,
   * and that container is inside `document.body` — so a surface's own `onContextMenu` is
   * dispatched while the native event is still climbing, and the provider's document-level
   * suppressor is the last thing to see it. That is what lets `menu()` `stopPropagation()` after
   * opening: an opened menu is a handled right-click, and the suppressor never runs for it.
   *
   * The `menu()` handler therefore calls `preventDefault()` **itself** rather than leaning on the
   * suppressor downstream of it — which is what makes the first test above true whichever way
   * this ordering goes. This test exists so that a React release that moved its listener to
   * `document` would be a failure with a name, rather than a native menu appearing over a custom
   * one in the shipped exe.
   */
  it("gives a surface's own handler the right-click before the document ever sees it", () => {
    const order: string[] = [];
    function OrderHost() {
      return <button onContextMenu={() => order.push("surface")}>ordered</button>;
    }
    render(
      <ContextMenuProvider>
        <OrderHost />
      </ContextMenuProvider>,
    );
    const onDocument = () => order.push("document");
    document.addEventListener("contextmenu", onDocument);
    try {
      screen
        .getByRole("button", { name: "ordered" })
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener("contextmenu", onDocument);
    }

    expect(order).toEqual(["surface", "document"]);
  });
});
