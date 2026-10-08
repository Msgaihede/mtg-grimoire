import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER_DROP_LINE_ATTR } from "@/components/FolderDropLine";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import type { Shelf, ShelfKind } from "@/lib/shelves";
import {
  headingLevel,
  PEEK_LIMIT,
  SHELF_HEADING_ATTR,
  ShelfHeading,
  type ShelfHeadingProps,
} from "./ShelfHeading";
import { FOLD_PAUSED_REASON } from "./ShelfToolbar";

/** A shelf as `buildShelves` hands one over — a reader's top-level folder unless told otherwise. */
function shelfOf(over: Partial<Shelf> & { id: number; name: string }): Shelf {
  return {
    kind: "folder",
    group: "own",
    pathIds: [over.id],
    path: [over.name],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
    ...over,
  };
}

const BINDER = shelfOf({ id: 3, name: "Trade binder" });
const STAT = "42 cards · $2,490.00 · 3 unpriced";

/** Five, so the cap is what decides how many are drawn. */
const PEEK = [
  { cardId: "c1", name: "Arid Mesa" },
  { cardId: "c2", name: "Scalding Tarn" },
  { cardId: "c3", name: "Misty Rainforest" },
  { cardId: "c4", name: "Verdant Catacombs" },
  { cardId: "c5", name: "Marsh Flats" },
];

/** Past the three-level indent: the heading names its path from the deepest indented ancestor. */
const DEEP = shelfOf({
  id: 23,
  name: "Showcase",
  depth: 4,
  indent: 3,
  pathIds: [20, 21, 22, 23],
  path: ["Staples", "Fetchlands", "Foils", "Showcase"],
  lead: ["Fetchlands", "Foils"],
  leadIds: [21, 22],
});

const onToggle = vi.fn();
const onOpen = vi.fn();
const onAddFolder = vi.fn();
const onRename = vi.fn();
const onCommit = vi.fn();
const onCancel = vi.fn();
const MENU = { onContextMenu: vi.fn(), onKeyDown: vi.fn(), onClick: vi.fn() };
const RENAMING = { initial: "Trade binder", onCommit, onCancel };

beforeEach(() => {
  vi.clearAllMocks();
});

function mount(props: Partial<ShelfHeadingProps> = {}) {
  const base: ShelfHeadingProps = { shelf: BINDER, stat: STAT, peek: [], onToggle, onOpen, ...props };
  const view = render(<ShelfHeading {...base} />);
  return {
    ...view,
    /** The same heading drawn again with some props changed — a caret return is a fact about a
     *  *transition*, so the tests that need one have to make one. */
    show: (next: Partial<ShelfHeadingProps>) => view.rerender(<ShelfHeading {...base} {...next} />),
  };
}

const row = () => document.querySelector<HTMLElement>(`[${SHELF_HEADING_ATTR}]`)!;

/** `classList.contains` per class — a substring test would pass on a `hover:` variant. */
const marked = (element: Element, mark: string) =>
  mark.split(" ").every((one) => element.classList.contains(one));

const line = () =>
  row().querySelector(`[${FOLDER_DROP_LINE_ATTR}]`)?.getAttribute(FOLDER_DROP_LINE_ATTR) ?? null;

describe("ShelfHeading", () => {
  it("names its chevron for what a press would do, and says whether the shelf is open", async () => {
    const user = userEvent.setup();
    const view = mount();

    const chevron = screen.getByRole("button", { name: "Collapse Trade binder" });
    expect(chevron).toHaveAccessibleName("Collapse Trade binder");
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    await user.click(chevron);
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.show({ shelf: { ...BINDER, collapsed: true } });
    const shut = screen.getByRole("button", { name: "Expand Trade binder" });
    expect(shut).toHaveAccessibleName("Expand Trade binder");
    expect(shut).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * **Collapse is suspended while a filter is on** (spec §3.4): a filtered wall shows every
   * matching shelf open, so a fold pressed then would be written for a wall the reader is not
   * looking at. The chevron is refused in the open — `aria-disabled`, the reason as its
   * description, still a tab stop — and a press by pointer or by key calls nothing. Its name and
   * `aria-expanded` keep saying what the shelf is; the rest of the heading is not about folding
   * and works as ever.
   */
  it("pauses its chevron while a filter is on, and nothing else on the row", async () => {
    const user = userEvent.setup();
    const view = mount({ onAddFolder, foldPaused: FOLD_PAUSED_REASON });

    const chevron = screen.getByRole("button", { name: "Collapse Trade binder" });
    expect(chevron).toHaveAttribute("aria-disabled", "true");
    expect(chevron).not.toHaveAttribute("disabled");
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(chevron).toHaveAccessibleDescription(FOLD_PAUSED_REASON);
    expect(chevron.classList.contains("opacity-60")).toBe(true);
    await user.click(chevron);
    chevron.focus();
    expect(chevron).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onToggle).not.toHaveBeenCalled();

    // A shut shelf is paused the same way — it names the press it would be, and refuses it.
    view.show({ shelf: { ...BINDER, collapsed: true }, onAddFolder, foldPaused: FOLD_PAUSED_REASON });
    const shut = screen.getByRole("button", { name: "Expand Trade binder" });
    expect(shut).toHaveAttribute("aria-disabled", "true");
    await user.click(shut);
    expect(onToggle).not.toHaveBeenCalled();

    // The name folds too, so it is refused the same way — in the same words, still a tab stop —
    // and keeps its own colour rather than greying under every filter.
    const title = screen.getByRole("button", { name: "Trade binder" });
    expect(title).toHaveAttribute("aria-disabled", "true");
    expect(title).not.toHaveAttribute("disabled");
    expect(title).toHaveAccessibleDescription(FOLD_PAUSED_REASON);
    expect(title.classList.contains("opacity-60")).toBe(false);
    await user.click(title);
    expect(onToggle).not.toHaveBeenCalled();
    // …and the chevron is not lit from the name while it is refused.
    expect(shut.className).not.toContain("group-has-");

    // Not folding, so not paused.
    const open = screen.getByRole("button", { name: "Open Trade binder" });
    expect(open).not.toHaveAttribute("aria-disabled");
    await user.click(open);
    expect(onOpen).toHaveBeenCalledWith(3);
    const add = screen.getByRole("button", { name: "Add folder in Trade binder" });
    expect(add).not.toHaveAttribute("aria-disabled");
    await user.click(add);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });

  /** Absent is today's chevron exactly: no mark and no description — on the name either. */
  it("carries no pause on its chevron without the prop", () => {
    mount();
    const chevron = screen.getByRole("button", { name: "Collapse Trade binder" });
    expect(chevron).not.toHaveAttribute("aria-disabled");
    expect(chevron).not.toHaveAccessibleDescription();
    expect(screen.getByRole("button", { name: "Trade binder" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  /**
   * Issue #599: the chevron is 32px around a 20px glyph, and hovering the name lights it — the
   * variant is on the chevron, the named group on the row and the mark on the name, and all three
   * have to be there for the rule to match anything. `classList.contains` rather than a substring:
   * a substring passes on a `hover:` spelling of the same class.
   */
  it("draws a 32px chevron that the name's hover lights", () => {
    mount();
    const chevron = screen.getByRole("button", { name: "Collapse Trade binder" });
    expect(chevron.classList.contains("size-8")).toBe(true);
    expect(chevron.querySelector("svg")!.classList.contains("size-5")).toBe(true);
    for (const lit of [
      "group-has-[[data-shelf-title]:hover]/shelf:bg-surface",
      "group-has-[[data-shelf-title]:hover]/shelf:text-text",
    ]) {
      expect(chevron.classList.contains(lit)).toBe(true);
    }
    expect(row().classList.contains("group/shelf")).toBe(true);
    expect(screen.getByRole("button", { name: "Trade binder" })).toHaveAttribute(
      "data-shelf-title",
    );
  });

  /**
   * Issue #599, reversing spec decision 6: the name folds the shelf as the chevron does, and says
   * whether it is open — so pressing it neither opens the folder nor asks the page to.
   */
  it("folds the shelf from the folder's name, and opens nothing", async () => {
    const user = userEvent.setup();
    const view = mount();

    const title = screen.getByRole("button", { name: "Trade binder" });
    expect(title).toHaveAccessibleName("Trade binder");
    expect(title).not.toHaveAccessibleDescription();
    expect(title).toHaveAttribute("aria-expanded", "true");
    await user.click(title);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    view.show({ shelf: { ...BINDER, collapsed: true } });
    const shut = screen.getByRole("button", { name: "Trade binder" });
    expect(shut).toHaveAttribute("aria-expanded", "false");
    await user.click(shut);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  /** The name is not a link, so it wears no underline — the lead segments beside it do. */
  it("draws the name without the underline its ancestors wear", () => {
    mount({ shelf: DEEP });
    const title = screen.getByRole("button", { name: "Showcase" });
    expect(title.classList.contains("hover:underline")).toBe(false);
    expect(screen.getByRole("button", { name: "Foils" }).classList.contains("hover:underline")).toBe(
      true,
    );
  });

  /** Issue #599: the way in is its own button, at the row's far right, on every kind of folder. */
  it("opens the folder from an Open button at the far right of the row", async () => {
    const user = userEvent.setup();
    const view = mount({ onAddFolder, onRename, menu: MENU });

    const open = screen.getByRole("button", { name: "Open Trade binder" });
    expect(open).toHaveAccessibleName("Open Trade binder");
    const buttons = screen.getAllByRole("button");
    expect(buttons[buttons.length - 1]).toBe(open);
    await user.click(open);
    expect(onOpen).toHaveBeenCalledWith(3);
    expect(onToggle).not.toHaveBeenCalled();

    // A deck group, a managed folder and Recently removed are opened the same way.
    const owned: [ShelfKind, Shelf["group"]][] = [
      ["deck", "decks"],
      ["removed", "decks"],
      ["managed", "managed"],
    ];
    for (const [kind, group] of owned) {
      view.show({ shelf: shelfOf({ id: 40, name: "Modern Goodstuff", kind, group }) });
      await user.click(screen.getByRole("button", { name: "Open Modern Goodstuff" }));
      expect(onOpen).toHaveBeenLastCalledWith(40);
    }
  });

  it("offers no Open button while the folder is being renamed or named", () => {
    const view = mount({ onRename, renaming: RENAMING });
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();

    view.show({
      shelf: shelfOf({ id: -1, name: "" }),
      stat: "",
      renaming: { initial: "", onCommit, onCancel, mode: "create" },
    });
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("opens each ancestor it draws before the name, with that ancestor's own id", async () => {
    const user = userEvent.setup();
    mount({ shelf: DEEP });

    await user.click(screen.getByRole("button", { name: "Fetchlands" }));
    await user.click(screen.getByRole("button", { name: "Foils" }));
    await user.click(screen.getByRole("button", { name: "Open Showcase" }));
    expect(onOpen.mock.calls).toEqual([[21], [22], [23]]);
    // The ancestors are steps on a path, not this shelf, so they fold nothing.
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Foils" })).not.toHaveAttribute("aria-expanded");
  });

  /** The whole phrase, on the element — name computation trims each part, so asserting the parts
   *  separately is exactly what a broken name still passes (packages/ui/CLAUDE.md). */
  it("reads as one heading, lead included", () => {
    mount({ shelf: DEEP });
    expect(screen.getByRole("heading", { level: 6 })).toHaveAccessibleName(
      "Fetchlands Foils Showcase",
    );
  });

  it("sits one heading level deeper per level of nesting, under the page's own h2, capped at h6", () => {
    expect(headingLevel({ group: "own", depth: 0 })).toBe(3);
    expect(headingLevel({ group: "own", depth: 2 })).toBe(5);
    expect(headingLevel({ group: "own", depth: 9 })).toBe(6);
    // Under their `ShelfLabel` h3 — Decks, Managed by decks.
    expect(headingLevel({ group: "decks", depth: 0 })).toBe(4);
    expect(headingLevel({ group: "managed", depth: 0 })).toBe(4);

    mount();
    expect(screen.getByRole("heading", { level: 3 })).toHaveAccessibleName("Trade binder");
  });

  it("draws its figures as the page formatted them", () => {
    mount();
    expect(screen.getByText(STAT)).toBeInTheDocument();
  });

  it("offers Add folder and Rename on the reader's own folder", async () => {
    const user = userEvent.setup();
    mount({ onAddFolder, onRename });

    const add = screen.getByRole("button", { name: "Add folder in Trade binder" });
    const rename = screen.getByRole("button", { name: "Rename Trade binder" });
    expect(add).toHaveAccessibleName("Add folder in Trade binder");
    expect(rename).toHaveAccessibleName("Rename Trade binder");
    await user.click(add);
    await user.click(rename);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("draws neither when the page passes no handler", () => {
    mount();
    expect(screen.queryByRole("button", { name: /^Add folder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
  });

  /** Spec §3.2: app-owned shelves draw no Add folder and no Rename and cannot be dragged — enforced
   *  here too, so a page handing a handler to the wrong kind of shelf cannot put a control on a
   *  deck group that writes into a deck. */
  it("draws neither on a deck group, Recently removed or a managed folder, whatever the page passes", () => {
    const owned: [ShelfKind, Shelf["group"]][] = [
      ["deck", "decks"],
      ["removed", "decks"],
      ["managed", "managed"],
    ];
    for (const [kind, group] of owned) {
      const dragRef = vi.fn();
      const view = mount({
        shelf: shelfOf({ id: 40, name: "Modern Goodstuff", kind, group }),
        onAddFolder,
        onRename,
        dragRef,
      });
      expect(screen.queryByRole("button", { name: /^Add folder/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
      expect(dragRef).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  /** Issue #778: the root gets folding and Add folder, but no stored-folder operations. */
  it("offers folding and Add folder on Not sorted, without folder management or drag", async () => {
    const user = userEvent.setup();
    const dragRef = vi.fn();
    mount({
      shelf: shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" }),
      onAddFolder,
      onRename,
      menu: MENU,
      dragRef,
    });

    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Collapse Not sorted" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("heading", { level: 3 })).toHaveAccessibleName("Not sorted");
    await user.click(screen.getByRole("button", { name: "Add folder in Not sorted" }));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Manage/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.contextMenu(row());
    expect(MENU.onContextMenu).not.toHaveBeenCalled();
    expect(row()).not.toHaveAttribute("tabindex");
    expect(dragRef).not.toHaveBeenCalled();
  });

  it("folds Not sorted from its name by pointer and keyboard", async () => {
    const user = userEvent.setup();
    const unfiled = shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" });
    const view = mount({ shelf: unfiled });

    const title = screen.getByRole("button", { name: "Not sorted" });
    expect(title).toHaveAttribute("aria-expanded", "true");
    await user.click(title);
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.show({ shelf: { ...unfiled, collapsed: true } });
    expect(title).toHaveAttribute("aria-expanded", "false");
    title.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("pauses Not sorted's title under a filter while keeping Add folder available", async () => {
    const user = userEvent.setup();
    mount({
      shelf: shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" }),
      onAddFolder,
      foldPaused: FOLD_PAUSED_REASON,
    });

    const title = screen.getByRole("button", { name: "Not sorted" });
    expect(title).toHaveAttribute("aria-disabled", "true");
    expect(title).not.toHaveAttribute("disabled");
    expect(title).toHaveAccessibleDescription(FOLD_PAUSED_REASON);
    await user.click(title);
    title.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onToggle).not.toHaveBeenCalled();

    const add = screen.getByRole("button", { name: "Add folder in Not sorted" });
    expect(add).not.toHaveAttribute("aria-disabled");
    await user.click(add);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });

  /** `CollectionFolderCard`'s three doors: the `⋯`'s click, the menu key on the focusable name, and
   *  a right-click anywhere on the row — which is why the row can take the caret back. */
  it("hands all three menu gestures to the page", async () => {
    const user = userEvent.setup();
    mount({ menu: MENU });

    const manage = screen.getByRole("button", { name: "Manage Trade binder" });
    expect(manage).toHaveAccessibleName("Manage Trade binder");
    expect(manage).toHaveAttribute("aria-haspopup", "menu");
    expect(manage).not.toHaveAttribute("aria-expanded");
    await user.click(manage);
    expect(MENU.onClick).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("button", { name: "Trade binder" }), {
      key: "F10",
      shiftKey: true,
    });
    expect(MENU.onKeyDown).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByText(STAT));
    expect(MENU.onContextMenu).toHaveBeenCalledTimes(1);
    expect(row()).toHaveAttribute("tabindex", "-1");
  });

  it("draws no ⋯ when the page passes no menu", () => {
    mount();
    expect(screen.queryByRole("button", { name: /^Manage/ })).toBeNull();
    expect(row()).not.toHaveAttribute("tabindex");
  });

  /** The row is a folder drag source; a press on one of its controls must stay a press
   *  (`NOT_A_DRAG`), while the name stays a grab handle — the natural place to pick a heading up. */
  it("marks each of its controls as not a grab handle, and leaves the name one", () => {
    mount({ onAddFolder, onRename, menu: MENU });

    for (const name of [
      "Collapse Trade binder",
      "Add folder in Trade binder",
      "Rename Trade binder",
      "Manage Trade binder",
      "Open Trade binder",
    ]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("data-no-drag");
    }
    expect(screen.getByRole("button", { name: "Trade binder" }).closest("[data-no-drag]")).toBeNull();
  });

  it("peeks at the first four cards while collapsed, and hides the peek from the tree", () => {
    mount({ shelf: { ...BINDER, collapsed: true }, peek: PEEK });

    const strip = row().querySelector("[data-shelf-peek]")!;
    expect(strip).toHaveAttribute("aria-hidden", "true");
    expect(strip.querySelectorAll("img")).toHaveLength(PEEK_LIMIT);
  });

  it("draws no peek while open, whatever the page passes", () => {
    mount({ peek: PEEK });
    expect(row().querySelector("[data-shelf-peek]")).toBeNull();
  });

  it("draws the open folder in gold and the shut one dim", () => {
    const view = mount();
    expect(row().querySelector(".lucide-folder-open")).toHaveClass("text-accent");

    view.show({ shelf: { ...BINDER, collapsed: true } });
    expect(row().querySelector(".lucide-folder-open")).toBeNull();
    expect(row().querySelector(".lucide-folder")).toHaveClass("text-dim");
  });

  it("draws the app's own glyph for the app's own shelves, and Not sorted's stays dim", () => {
    const view = mount({ shelf: shelfOf({ id: 40, name: "Modern Goodstuff", kind: "deck", group: "decks" }) });
    expect(row().querySelector(".lucide-layers")).toHaveClass("text-accent");

    view.show({ shelf: shelfOf({ id: 41, name: "Recently removed", kind: "removed", group: "decks" }) });
    expect(row().querySelector(".lucide-inbox")).not.toBeNull();

    view.show({ shelf: shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" }) });
    expect(row().querySelector(".lucide-cards")).toHaveClass("text-dim");
  });

  it("says a locked folder is locked, in words", () => {
    mount({ shelf: { ...BINDER, locked: true } });
    expect(screen.getByRole("img", { name: "Locked" })).toBeInTheDocument();
  });

  it("wears a Managed pill on a managed folder", () => {
    mount({ shelf: shelfOf({ id: 50, name: "Rhystic Testbed", kind: "managed", group: "managed" }) });
    expect(screen.getByText("Managed")).toBeInTheDocument();
  });

  /* ------------------------------------------------------------ drop marks ------- */

  it("draws no mark at rest", () => {
    mount();
    expect(marked(row(), DROP_EDGE)).toBe(false);
    expect(marked(row(), DROP_OVER)).toBe(false);
    expect(line()).toBeNull();
  });

  /** `DROP_EDGE`, because the row owns an edge all day (a transparent one) — a ring inside it
   *  would be the two-outline bug `dropMarks.ts` records. */
  it("golds its edge while it could take what is in the air", () => {
    mount({ dropMark: "armed" });
    expect(marked(row(), DROP_EDGE)).toBe(true);
    expect(marked(row(), DROP_OVER)).toBe(false);
  });

  it("washes under the pointer, for a card or for a folder going inside", () => {
    const view = mount({ dropMark: "over" });
    expect(marked(row(), DROP_OVER)).toBe(true);
    expect(row()).toHaveClass("border-accent");
    expect(line()).toBeNull();

    view.show({ dropMark: "inside" });
    expect(marked(row(), DROP_OVER)).toBe(true);
    expect(line()).toBeNull();
  });

  it("draws a line at the end a folder would land beside, and keeps its gold edge", () => {
    const view = mount({ dropMark: "before" });
    expect(line()).toBe("before");
    expect(marked(row(), DROP_EDGE)).toBe(true);
    expect(marked(row(), DROP_OVER)).toBe(false);

    view.show({ dropMark: "after" });
    expect(line()).toBe("after");
  });

  /* ------------------------------------------------------------------ refs ------- */

  it("hands the row to the drop target and the drag source, and lets go of it on unmount", () => {
    const dropRef = vi.fn();
    const dragRef = vi.fn();
    const view = mount({ dropRef, dragRef });

    expect(dropRef).toHaveBeenCalledWith(row());
    expect(dragRef).toHaveBeenCalledWith(row());

    view.unmount();
    expect(dropRef).toHaveBeenLastCalledWith(null);
    expect(dragRef).toHaveBeenLastCalledWith(null);
  });

  /** React 19 runs a callback ref's returned cleanup *instead of* calling it with `null`; merging
   *  two refs must keep that promise for each of them. */
  it("runs a ref's own cleanup rather than calling it with null", () => {
    const release = vi.fn();
    const dropRef = vi.fn(() => release);
    const view = mount({ dropRef });

    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
    expect(dropRef).not.toHaveBeenCalledWith(null);
  });

  /* ---------------------------------------------------------------- rename ------- */

  it("becomes the name field, hides its buttons, and keeps its figures", () => {
    mount({ onAddFolder, onRename, menu: MENU, renaming: RENAMING });

    const input = screen.getByRole("textbox", { name: "Rename Trade binder" }) as HTMLInputElement;
    expect(input).toHaveValue("Trade binder");
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Trade binder".length]);

    expect(screen.queryByRole("button", { name: "Add folder in Trade binder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename Trade binder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage Trade binder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse Trade binder" })).toBeInTheDocument();
    expect(screen.getByText(STAT)).toBeInTheDocument();
  });

  it("hands the page the name typed, and the cancel separately", async () => {
    const user = userEvent.setup();
    mount({ onRename, renaming: RENAMING });

    await user.keyboard("Binder{Enter}");
    expect(onCommit).toHaveBeenCalledWith("Binder");
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("holds the tick while the write is in flight", () => {
    mount({ onRename, renaming: { ...RENAMING, pending: true } });
    expect(screen.getByRole("button", { name: "Rename folder" })).toBeDisabled();
  });

  /** The Rename button is what the field replaced, so the page's dismiss would focus a detached
   *  node — `useFolderFieldReturn` is the answer, and this checks it is wired to the right button. */
  it("hands the caret to Rename when the field closes", () => {
    const view = mount({ onRename, renaming: RENAMING });
    expect(screen.getByRole("textbox", { name: "Rename Trade binder" })).toHaveFocus();

    view.show({ renaming: undefined });
    expect(screen.getByRole("button", { name: "Rename Trade binder" })).toHaveFocus();
  });

  it("hands the caret to ⋯ when there is no Rename button", () => {
    const view = mount({ menu: MENU, renaming: RENAMING });

    view.show({ renaming: undefined });
    expect(screen.getByRole("button", { name: "Manage Trade binder" })).toHaveFocus();
  });

  /** Spec §3.8: a new folder appears where it will live, as a heading whose name is the field. */
  it("names a folder that does not exist yet, with no chevron and no figures", async () => {
    const user = userEvent.setup();
    mount({
      shelf: shelfOf({ id: -1, name: "" }),
      stat: "",
      renaming: { initial: "", onCommit, onCancel, mode: "create" },
    });

    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^(Expand|Collapse)/ })).toBeNull();

    await user.keyboard("Signed{Enter}");
    expect(onCommit).toHaveBeenCalledWith("Signed");
  });

  /**
   * Live pass §10: the tile-sized field stood 1px proud of this row top and bottom, and its ✓ / ✕
   * centred 3px above the row's centre line — for Rename, for Add folder in a heading and for Add
   * folder at the root, which is this same heading with `mode: "create"`. The row is `h-10` with a
   * 1px border, a 38px content box; `FolderNameField`'s heading size is a 36px frame with its pair
   * centred on it, and `FolderNameField.test.tsx` holds that half. This holds the pairing: the row
   * is still the 40px it was sized against, and both jobs ask for the heading size.
   */
  it("draws the name field at heading size for Rename and for Add folder", () => {
    for (const renaming of [RENAMING, { initial: "", onCommit, onCancel, mode: "create" as const }]) {
      const view = mount({ renaming });

      expect(row().classList.contains("h-10")).toBe(true);
      expect(row().classList.contains("border")).toBe(true);
      const frame = row().querySelector("form")!.firstElementChild!;
      expect(frame.classList.contains("h-9")).toBe(true);
      expect(row().querySelector("form .absolute.right-1")!.classList.contains("inset-y-0")).toBe(
        true,
      );
      view.unmount();
    }
  });
});
