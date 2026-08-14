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
