import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

beforeEach(() => statedViewport(1280, 800));

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
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(
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
  it("measures the room against the stated viewport and not against innerWidth", async () => {
    expect(window.innerWidth).toBeLessThan(1280);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 900,
          clientY: 40,
        }),
      );

    const panel = await screen.findByRole("menu");
    expect(panel).toHaveClass("origin-top-left");
    expect(Number.parseFloat(panel.style.left)).toBe(900);
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
