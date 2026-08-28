import { useEffect, useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER_DROP_LINE_ATTR } from "@/components/FolderDropLine";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import {
  folderDraggable,
  readFolderDrag,
  type FolderDrag,
  type FolderEdge,
} from "@/lib/folderDrag";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder } from "@/lib/ipc";
import { boxed, startPointerDrag } from "@/test-drag";
import { dndManager } from "@/lib/dndManager";
import { WishFolderCard } from "./WishFolderCard";
import { WishlistBreadcrumb } from "./WishlistBreadcrumb";
import { wishDraggable, type WishDrag } from "./wishDrag";

/**
 * The two things the wishlist page draws around its wishes: the dashed folder tile a reader
 * clicks into, and the breadcrumb they climb back out on.
 *
 * **One file for two components, because they are one contract.** Spec §9's "Where a wish can be
 * dropped" is a single sentence about both — a folder card takes a wish *down* and a breadcrumb
 * segment takes it *back out*, and "without the breadcrumb a drag can only ever push wishes
 * deeper" is a claim no test of either component alone can make.
 *
 * **Both drags are driven over the library's real code path, and both are pointer gestures** — a
 * press, a few moves and a release, which is what `@dnd-kit/dom` listens for and what a reader
 * actually does. `src/test-drag.ts` supplies the two things jsdom cannot. It lays nothing out,
 * so **every source, and every target a pointer has to reach, states its own box** or the
 * coordinate the library hit-tests by finds nothing at all; and it never runs the collision pass
 * the library drives off its own drag preview, so the harness forces one. Both failures are
 * silent — the registration is correct, the droppable accepts the payload, and the operation's
 * target is `null` on every frame — which is why the boxes below are setup rather than
 * decoration.
 *
 * What is out of reach here and stays the live pass's to prove: that a ring drawn *outside* a
 * card's border box survives the wall's own `overflow` (that is `DROP_MARK_ROOM`, and jsdom has
 * no layout engine and therefore no clip), and the drag preview a reader watches follow the
 * pointer.
 */

const WISH: WishDrag = { wishId: 7, name: "Lightning Bolt", folderId: null };

function folder(over: Partial<WishlistFolder> & { id: number; name: string }): WishlistFolder {
  return { parentId: null, sortOrder: over.id, ...over };
}

const EXPENSIVE = folder({ id: 3, name: "Expensive" });
const SOMEDAY = folder({ id: 9, name: "Someday", parentId: 3 });

function node(
  f: WishlistFolder,
  over: Partial<FolderNode<WishlistFolder>> = {},
): FolderNode<WishlistFolder> {
  return { folder: f, depth: 0, count: 0, children: [], ...over };
}

/**
 * Whether an element wears one of `dropMarks.ts`'s marks.
 *
 * `classList.contains` per class rather than `className.includes(mark)`: several of the classes
 * around these are `hover:` variants, and a substring test against the whole attribute passes
 * before any state has changed — a vacuous assertion that reads exactly like a real one.
 */
function marked(element: Element | null | undefined, mark: string): boolean {
  expect(element).toBeTruthy();
  return mark.split(" ").every((one) => element!.classList.contains(one));
}

/** Something to pick up. `wishDraggable` rather than the library's `Draggable` directly, so the
 *  payload travels exactly as a wish tile's does — `card: () => null` is the *any-printing* wish,
 *  whose payload is the wish mark alone and which folders are the only targets for. */
function Source({ wish = WISH }: { wish?: WishDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A box of its own, well clear of the card's: dnd-kit reads the press coordinate off the
    // source's own rect and jsdom measures every rect as four zeroes, so a source with no box is
    // pressed at the origin — which is inside whatever else has been given a rect there.
    element.getBoundingClientRect = () => SOURCE_BOX;
    return wishDraggable({ element, wish: () => wish, card: () => null });
  }, [wish]);
  return <div ref={ref}>the wish</div>;
}

/**
 * A sibling drawer, in the air.
 *
 * Its own `folderDraggable` rather than a second `WishFolderCard`, for {@link Source}'s reason one
 * payload over: every test below is about what the card *under the pointer* does, and a second
 * card would put a second drop target in the way of that.
 */
const OTHER_FOLDER: FolderDrag = {
  folderId: 9,
  name: "Someday",
  parentId: null,
  scope: "wishlist",
};

function FolderSource({ drag = OTHER_FOLDER }: { drag?: FolderDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return folderDraggable({ element, folder: () => drag });
  }, [drag]);
  return <div ref={ref}>the folder</div>;
}

/**
 * Two boxes and three landings, because dnd-kit hit-tests by **coordinate** and jsdom measures
 * every rectangle as zero.
 *
 * An edge-dependent test therefore has to state the box itself rather than hope for one — and
 * with a pointer-based library it states the box *once* and then moves the pointer over it, which
 * is the gesture a reader makes. The card is read along the **horizontal** axis, since the wall
 * lays its drawers out as a grid; `EDGE_ZONE` is a quarter, so a tenth in from either end is
 * unambiguously beside it and the middle is unambiguously inside.
 * `CollectionFolderCard.test.tsx`'s arrangement, for its reason.
 *
 * **Two boxes for both drags**: a wish and a sibling drawer are each carried from
 * {@link SOURCE_BOX} onto {@link CARD_BOX}, which is one card's worth of screen and clear of the
 * source along the x axis. A wish has no three landings — a folder either takes it or does not —
 * so it aims at the middle, and the three fractions belong to the folder drag alone.
 */
const SOURCE_BOX = new DOMRect(0, 0, 240, 120);
const CARD_BOX = new DOMRect(400, 0, 240, 120);
const BEFORE = { x: 0.1 };
const INSIDE = { x: 0.5 };
const AFTER = { x: 0.9 };

/** A folder card wired to the real `useContextMenu`, for the one test that is about *which*
 *  handle the trigger is on rather than about the card handing a press somewhere. */
function MenuHost() {
  const { menu, menuKey, menuClick } = useContextMenu();
  const build = () => [
    { kind: "action" as const, id: "rename", label: "Rename", onSelect: () => {} },
  ];
  return (
    <ul>
      <WishFolderCard
        node={node(EXPENSIVE)}
        summary={{ wishes: 1, missing: 0, cost: 0, unpriced: 0 }}
        currency="usd"
        onOpen={onOpen}
        rowMenu={{
          onContextMenu: menu(build),
          onKeyDown: menuKey(build),
          onClick: menuClick(build),
        }}
        canDrop={() => false}
        onDropWish={onDropWish}
        canDropFolder={() => false}
        onDropFolder={onDropFolder}
      />
    </ul>
  );
}

const onOpen = vi.fn();
const onDropWish = vi.fn();
const onDropFolder = vi.fn();
const onContextMenu = vi.fn();
const onKeyDown = vi.fn();
const onClickMenu = vi.fn();

beforeEach(() => {
  onOpen.mockReset();
  onDropWish.mockReset();
  onDropFolder.mockReset();
  onContextMenu.mockReset();
  onKeyDown.mockReset();
  onClickMenu.mockReset();
});

// The stated viewport and the stated trigger box below are `vi.spyOn`s on real getters; nothing
// else in this file spies on anything, so one blanket restore is the whole cleanup.
afterEach(() => vi.restoreAllMocks());

describe("WishFolderCard", () => {
  function mount({
    on = node(EXPENSIVE),
    summary = { wishes: 6, missing: 6, cost: 312, unpriced: 0 },
    currency = "usd" as const,
    canDrop = () => true,
    canDropFolder = () => true,
    withSource = false,
    withFolder = false,
    folderDrag,
  }: {
    /** Which drawer this card draws. Only the payload test below changes it. */
    on?: FolderNode<WishlistFolder>;
    summary?: { wishes: number; missing: number; cost: number; unpriced: number } | null;
    currency?: "usd" | "eur";
    canDrop?: (drag: WishDrag) => boolean;
    canDropFolder?: (drag: FolderDrag, edge: FolderEdge) => boolean;
    withSource?: boolean;
    /** A sibling drawer in the air — the second payload this card reads, under its own key. */
    withFolder?: boolean;
    folderDrag?: FolderDrag;
  } = {}) {
    render(
      <>
        {withSource && <Source />}
        {withFolder && <FolderSource drag={folderDrag} />}
        {/* Inside a `<ul>`, because the card is an `<li>` — `FolderCard`'s shape, and a wall of
            folders is a list. */}
        <ul>
          <WishFolderCard
            node={on}
            summary={summary}
            currency={currency}
            onOpen={onOpen}
            rowMenu={{ onContextMenu, onKeyDown, onClick: onClickMenu }}
            canDrop={canDrop}
            onDropWish={onDropWish}
            canDropFolder={canDropFolder}
            onDropFolder={onDropFolder}
          />
        </ul>
      </>,
    );
  }

  /** The card's own box — the element the ring is drawn on, the one registered as a wish target,
   *  and the one a reader picks the folder up by. */
  function card(name = "Expensive"): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(`^${name} folder`) }).closest("li")!;
  }

  /** The face inside it, which is what wears the wash — and the element a real pointer is over
   *  for all but the `⋯`'s corner, so it is where the folder drags below are aimed. */
  const face = () => card().querySelector("button")!;

  /**
   * The box the **folder** drop target is registered on: an inner wrapper rather than the `<li>`,
   * which is where the wish target sits.
   *
   * **The two boxes are nested and that is now free rather than merely tolerated.** dnd-kit lets a
   * droppable sit inside another and resolves the pair by asking each one's `accept()` before it
   * measures anything, so the wish target refuses a folder payload and the folder target refuses a
   * wish's and the pointer never has to choose. `WishFolderCard` keeps them on two elements for the
   * reason it always did — the folder target is the box `folderEdge` measures the three landings
   * against, and the `<li>` is the one every existing wish target, test and story already addresses.
   */
  const slot = () => card().firstElementChild as HTMLElement;

  /**
   * Which end the drop line is on, or `null` for no line at all.
   *
   * The attribute rather than a class: the side is a Tailwind utility and jsdom applies no
   * stylesheet, so a class assertion would be a check on this repo's source text rather than on
   * the drawing. `FolderDropLine` carries the edge as that attribute's *value* for exactly this.
   */
  const line = () =>
    card().querySelector(`[${FOLDER_DROP_LINE_ATTR}]`)?.getAttribute(FOLDER_DROP_LINE_ATTR) ?? null;

  /**
   * Give the card's **two** drop targets the one box they share — see {@link CARD_BOX}.
   *
   * On screen they are the same rectangle: the folder target is a wrapper that covers every pixel
   * of the `<li>` the wish target is on, so a pointer over the card is over both and nothing about
   * *where* it is separates them. What does is `accept`, asked once per collision pass before
   * either box is measured, so stating one rect for the pair is what a reader's pointer actually
   * meets rather than a convenience. Every folder drag below aims at a fraction along it and every
   * wish drag at its middle.
   */
  const stand = () => {
    card().getBoundingClientRect = () => CARD_BOX;
    slot().getBoundingClientRect = () => CARD_BOX;
  };

  it("names the folder and says what is in it", () => {
    mount();
    expect(screen.getByText("Expensive")).toBeInTheDocument();
    // The one place this deliberately departs from `FolderCard`: no strip of member art, because
    // a wishlist folder's useful face is what it costs.
    expect(screen.getByText("6 wishes · $312.00")).toBeInTheDocument();
  });

  it("prices in the currency it is handed", () => {
    mount({ currency: "eur" });
    expect(screen.getByText("6 wishes · €312.00")).toBeInTheDocument();
  });

  it("says `1 wish`, never `1 wishs`", () => {
    mount({ summary: { wishes: 1, missing: 1, cost: 4, unpriced: 0 } });
    expect(screen.getByText("1 wish · $4.00")).toBeInTheDocument();
  });

  it("shows the count alone on a folder with nothing left to buy", () => {
    mount({ summary: { wishes: 6, missing: 0, cost: 0, unpriced: 0 } });
    expect(screen.getByText("6 wishes")).toBeInTheDocument();
    // A `$0.00` on a folder the reader has finished buying is noise, and `formatPrice`'s own rule
    // is that `$0.00` is a price nobody quoted.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("notes the wishes the marketplace could not price, in the page header's own shape", () => {
    mount({ summary: { wishes: 6, missing: 6, cost: 312, unpriced: 2 } });
    expect(screen.getByText("6 wishes · $312.00 · 2 unpriced")).toBeInTheDocument();
  });

  it("draws an em dash rather than $0.00 when every missing copy is unpriced", () => {
    mount({ summary: { wishes: 3, missing: 3, cost: 0, unpriced: 3 } });
    expect(screen.getByText("3 wishes · — · 3 unpriced")).toBeInTheDocument();
  });

  /**
   * **"Not counted yet" is not "empty", and the card has to draw the difference.** The wall is
   * gated on the folder list — one flat `SELECT` — while these figures come from a `GROUP BY`
   * with an owned-copies subquery and a price expression behind it, so there is a window in
   * which a drawer holding six wishes worth $312 is on screen with nothing known about it.
   * `0 wishes` across that window is a wrong number that then jumps, not a spinner.
   */
  it("says nothing is counted yet rather than `0 wishes`, while the summary is still reading", () => {
    mount({ summary: null });
    const tile = screen.getByRole("button", { name: /^Expensive folder/ });
    expect(tile).toHaveTextContent("—");
    expect(tile).not.toHaveTextContent("0 wishes");
    // In words for a screen reader, because an em dash read aloud is punctuation.
    expect(tile).toHaveAccessibleName("Expensive folder, still counting");
  });

  /** A wall of these is otherwise a row of identically-named controls to a screen reader. */
  it("carries a manage trigger named for its own folder", () => {
    mount();
    expect(screen.getByRole("button", { name: "Manage Expensive" })).toBeInTheDocument();
  });

  /**
   * The app's **first plain-click menu trigger**, so it inherits no precedent — and without this
   * NVDA announces "Manage Expensive, button" and gives a reader no way to know a press opens
   * anything at all. Every other popup trigger in the app declares its kind (`AnchoredPopup`'s
   * `dialog`, `Submenu`'s `menu`).
   *
   * **No `aria-expanded`, deliberately.** The open menu is `ContextMenuProvider`'s single piece
   * of state and this card never hears it close; a static `false` would be an assertion that is
   * wrong for exactly as long as the panel is up, which is worse than saying nothing.
   */
  it("declares that the manage trigger opens a menu", () => {
    mount();
    const trigger = screen.getByRole("button", { name: "Manage Expensive" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).not.toHaveAttribute("aria-expanded");
  });

  it("opens the folder when pressed", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /^Expensive folder/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("reaches the page's menu from the trigger, a right-click and the keyboard", async () => {
    const user = userEvent.setup();
    mount();
    // The trigger's own door is `menuClick`, not `menu` — a press on a button that exists to open
    // a menu is not a right-click, and the two anchor differently.
    await user.click(screen.getByRole("button", { name: "Manage Expensive" }));
    expect(onClickMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu).not.toHaveBeenCalled();
    // The press must not also drill into the folder — the trigger is a sibling of the card's
    // button rather than inside it, which is what keeps the two gestures apart.
    expect(onOpen).not.toHaveBeenCalled();

    const open = screen.getByRole("button", { name: /^Expensive folder/ });
    fireEvent.contextMenu(open);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(open, { key: "F10", shiftKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  /**
   * The one claim spies cannot make, so this test wires the card to the **real** menu primitive.
   *
   * The trigger is a button whose whole job is to open a menu, and Enter on a focused button
   * fires a click with no coordinates — so the naive `onClick={menu(build)}` would have opened
   * every folder's menu in the top-left corner of the window for a reader on the keyboard, with
   * a green suite and nothing on screen naming the culprit. `menuClick` is the handle that asks
   * which press it got, and what is pinned here is that the card is wired to *that* one.
   *
   * jsdom has no layout, so both boxes are stated — `ContextMenu.test.tsx`'s arrangement, and the
   * viewport is stated rather than read from `window.innerWidth`, which is the expression this
   * repo has already pinned once as an expected answer.
   */
  it("opens the folder's menu at the trigger, not at 0,0, from the keyboard", async () => {
    const user = userEvent.setup();
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
    render(
      <ContextMenuProvider>
        <MenuHost />
      </ContextMenuProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Manage Expensive" });
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

    // Tabbed to, not focused programmatically: a caret put there by `.focus()` is one a reader
    // cannot produce, and it is the shape of setup that has hidden a real entry point here before.
    await user.tab();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    const panel = await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(Number.parseFloat(panel.style.left)).toBe(120);
    expect(Number.parseFloat(panel.style.top)).toBe(232);
  });

  it("raises a ring for a wish it can take, and a wash under the pointer", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the wish"));
    // **Asked while the drag is still up.** `started` is a live reading over the manager's one
    // operation rather than a remembered flag, so after a cancel or a drop it is false for every
    // drag there has ever been.
    expect(held.started).toBe(true);
    // The ring is a `dragstart` fact and needs no pointer over this card — that is the whole point
    // of it: every drawer a wish could go in lights up at once, not only the one under the hand.
    expect(marked(card(), DROP_RING)).toBe(true);
    expect(marked(face(), DROP_OVER)).toBe(false);

    await held.over(card());
    expect(marked(face(), DROP_OVER)).toBe(true);

    await held.cancel();
  });

  it("draws no ring at all for a wish it refuses", async () => {
    mount({ withSource: true, canDrop: () => false });
    stand();
    const held = await startPointerDrag(screen.getByText("the wish"));
    expect(marked(card(), DROP_RING)).toBe(false);

    // And refusing means refusing the drop too, not merely declining to advertise it — which is
    // why the pointer really travels onto the card first.
    await held.over(card());
    await held.drop();
    expect(onDropWish).not.toHaveBeenCalled();
  });

  it("files the wish it is dropped", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the wish"));
    await held.over(card());
    await held.drop();
    expect(onDropWish).toHaveBeenCalledWith(WISH);
  });

  /* ------------------------------------------------------ the folder drag ------- */

  /**
   * **The card is a drag *source* as well as a target now, and what it carries is read at
   * `dragstart`.** `parentId` travels because it is what lets the folder's own parent refuse a
   * nest that would move it nowhere — a fact about where the folder sits, not about the drawer it
   * is being carried over, so nothing downstream can work it out.
   */
  it("is a drawer a reader can pick up, carrying where it currently sits", async () => {
    mount({ on: node(SOMEDAY) });
    const carried: (FolderDrag | null)[] = [];
    const stop = dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
      if (operation.source) carried.push(readFolderDrag(operation.source.data, "wishlist"));
    });

    card("Someday").getBoundingClientRect = () => CARD_BOX;
    const held = await startPointerDrag(card("Someday"));
    expect(held.started).toBe(true);
    await held.cancel();
    stop();

    expect(carried).toEqual([{ folderId: 9, name: "Someday", parentId: 3, scope: "wishlist" }]);
  });

  /**
   * **A press on the folder's own `⋯` is a press on the menu.** Chromium starts a drag from the
   * nearest draggable *ancestor* of whatever was pressed, so without `data-no-drag` on the
   * trigger a press there plus five pixels of travel files this drawer somewhere and the click
   * that was meant is never delivered. The press and the drag land on two different elements
   * here, exactly as the platform sends them.
   */
  it("does not start a drag from a press on its manage trigger", async () => {
    mount();
    card().getBoundingClientRect = () => CARD_BOX;
    const refused = await startPointerDrag(card(), {
      pressOn: screen.getByRole("button", { name: "Manage Expensive" }),
    });
    expect(refused.started).toBe(false);
    await refused.cancel();

    // And the folder's face still is a grab handle — the guard is about a control's press, not
    // about the card. dnd-kit's own default would have refused this one too, because it is a
    // button; `NOT_A_DRAG` is what says a control marks itself.
    const again = await startPointerDrag(card(), { pressOn: face() });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /** The middle of a drawer means *into* it, and it wears the same wash a wish over it does —
   *  only one thing is ever in the air, so the two claims are one mark rather than two. */
  it("rings for a folder it can take, and washes over the middle it would nest in", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(card(), DROP_RING)).toBe(true);
    expect(marked(face(), DROP_OVER)).toBe(false);

    await held.over(slot(), INSIDE);
    expect(marked(face(), DROP_OVER)).toBe(true);
    // No line with the wash: `inside` is a folder taking the drag rather than a position between
    // two of them, so one meaning wears one mark.
    expect(line()).toBeNull();

    await held.cancel();
  });

  /**
   * **Which end the line is on *is* the fact under test** — a mark on the wrong side of a card is
   * a promise to file the folder in the wrong place — and it moves within one card rather than
   * answering once on entry, because the whole gesture is that one drawer means three things at
   * three places along it.
   */
  it("draws a line at the end a folder would land beside, and no wash with it", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));

    await held.over(slot(), BEFORE);
    expect(line()).toBe("before");
    expect(marked(face(), DROP_OVER)).toBe(false);

    await held.over(slot(), AFTER);
    expect(line()).toBe("after");

    await held.cancel();
  });

  /**
   * **No mark means no drop.** `useFolderDropTarget` reports `edge: null` over a part of the card
   * the page refuses, deliberately keeping the whole element in the library's hierarchy so the
   * reported edge keeps following the pointer — so the card has to draw nothing there rather than
   * a line leading to a write that never happens. The ring stays up, because this drawer *would*
   * take the folder beside it.
   */
  it("draws nothing at all over a landing the page refuses, and refuses the drop too", async () => {
    mount({ withFolder: true, canDropFolder: (_drag, edge) => edge !== "inside" });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(card(), DROP_RING)).toBe(true);

    await held.over(slot(), INSIDE);
    expect(marked(face(), DROP_OVER)).toBe(false);
    expect(line()).toBeNull();

    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  it("draws no ring at all for a folder the page refuses outright", async () => {
    mount({ withFolder: true, canDropFolder: () => false });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(card(), DROP_RING)).toBe(false);

    await held.over(slot(), INSIDE);
    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  it("hands the page the folder and where it landed", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    await held.over(slot(), AFTER);
    await held.drop();
    expect(onDropFolder).toHaveBeenCalledWith(OTHER_FOLDER, "after");
  });

  /**
   * **The sidebar's deck-folder tree is mounted beside this page all day**, and folder `9` exists
   * in all three `*_folders` tables — so a deck folder carried over a wishlist drawer is a gesture
   * a reader can really make, and a card that took it would file a real row in the wrong cabinet.
   * The refusal is `readFolderDrag`'s, reached by this card passing its own scope.
   */
  it("refuses a folder belonging to another cabinet", async () => {
    mount({
      withFolder: true,
      folderDrag: { folderId: 9, name: "Standard", parentId: null, scope: "deck" },
    });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(card(), DROP_RING)).toBe(false);

    await held.over(slot(), INSIDE);
    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });

  /**
   * **The two drags stay two.** They carry different marks under different keys, so each reader
   * answers `null` for the other's payload — which is what lets one card be a wish's destination
   * and a folder's neighbour at once without either handler learning about the other.
   *
   * **One pixel, two payloads, and that is what makes the claim worth pinning now.** Both drags
   * are `@dnd-kit/dom` gestures over one registry and one coordinate space, and {@link stand}
   * gives the two nested targets the same rectangle — so both drops below land on the identical
   * point and nothing about *where* the pointer is can be doing the separating.
   */
  it("keeps the wish drag and the folder drag apart, in both directions", async () => {
    mount({ withSource: true, withFolder: true });
    stand();

    const wish = await startPointerDrag(screen.getByText("the wish"));
    await wish.over(card());
    await wish.drop();
    expect(onDropWish).toHaveBeenCalledWith(WISH);
    expect(onDropFolder).not.toHaveBeenCalled();

    onDropWish.mockReset();
    // The same point, reached from the other source: `INSIDE` is the middle of {@link CARD_BOX}
    // and so is `card()`'s centre above.
    const drawer = await startPointerDrag(screen.getByText("the folder"));
    await drawer.over(slot(), INSIDE);
    await drawer.drop();
    expect(onDropFolder).toHaveBeenCalledWith(OTHER_FOLDER, "inside");
    expect(onDropWish).not.toHaveBeenCalled();
  });
});

describe("WishlistBreadcrumb", () => {
  function mount({
    trail = [EXPENSIVE, SOMEDAY],
    flattened = false,
    canDrop = () => true,
    withSource = false,
  }: {
    trail?: readonly WishlistFolder[];
    flattened?: boolean;
    canDrop?: (drag: WishDrag, folderId: number | null) => boolean;
    withSource?: boolean;
  } = {}) {
    render(
      <>
        {withSource && <Source />}
        <WishlistBreadcrumb
          trail={trail}
          flattened={flattened}
          onOpen={onOpen}
          canDrop={canDrop}
          onDropWish={onDropWish}
        />
      </>,
    );
  }

  /**
   * Give the trail's segments boxes, stacked clear of one another and of the wish in the air.
   *
   * jsdom lays nothing out and dnd-kit hit-tests by **coordinate**, so a segment with no box can
   * never be collided with — and the failure is silent: the registration is correct, the droppable
   * accepts the payload, and the operation's target is `null` on every frame. 100px apart, so a
   * pointer over one segment is unambiguously not over its neighbour, and all of them well below
   * {@link SOURCE_BOX} so the press that starts the drag lands on none of them.
   */
  const stack = (...segments: HTMLElement[]) =>
    segments.forEach((segment, index) => boxed(segment, 200 + index * 100));

  it("draws the trail root-most first, with the folder you are in current and inert", () => {
    mount();
    expect(screen.getByRole("button", { name: "Wishlist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expensive" })).toBeInTheDocument();
    // The folder the reader is standing in is not a place to go.
    expect(screen.queryByRole("button", { name: "Someday" })).not.toBeInTheDocument();
    expect(screen.getByText("Someday")).toHaveAttribute("aria-current", "page");
  });

  it("makes the root itself current when the reader is already there", () => {
    mount({ trail: [] });
    expect(screen.queryByRole("button", { name: "Wishlist" })).not.toBeInTheDocument();
    expect(screen.getByText("Wishlist")).toHaveAttribute("aria-current", "page");
  });

  it("climbs to the root and to an ancestor", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Wishlist" }));
    expect(onOpen).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Expensive" }));
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  /** The whole reason the segments are drop targets: without this a drag can only ever push
   *  wishes deeper, and nothing on the page brings one back. */
  it("takes a wish dropped on the root and un-files it", async () => {
    mount({ withSource: true });
    const root = screen.getByRole("button", { name: "Wishlist" });
    stack(root, screen.getByRole("button", { name: "Expensive" }));

    const held = await startPointerDrag(screen.getByText("the wish"));
    expect(marked(root, DROP_RING)).toBe(true);

    await held.over(root);
    expect(marked(root, DROP_OVER)).toBe(true);
    await held.drop();
    expect(onDropWish).toHaveBeenCalledWith(WISH, null);
  });

  it("takes a wish dropped on an ancestor and moves it up", async () => {
    mount({ withSource: true });
    const ancestor = screen.getByRole("button", { name: "Expensive" });
    stack(screen.getByRole("button", { name: "Wishlist" }), ancestor);

    const held = await startPointerDrag(screen.getByText("the wish"));
    await held.over(ancestor);
    await held.drop();
    expect(onDropWish).toHaveBeenCalledWith(WISH, 3);
  });

  it("offers no drop on the folder the reader is already standing in", async () => {
    mount({ withSource: true });
    // Boxed like its neighbours, so "nothing happened" is the target refusing rather than a
    // pointer that was never over it.
    const current = screen.getByText("Someday");
    stack(
      screen.getByRole("button", { name: "Wishlist" }),
      screen.getByRole("button", { name: "Expensive" }),
      current,
    );

    const held = await startPointerDrag(screen.getByText("the wish"));
    expect(marked(current, DROP_RING)).toBe(false);

    await held.over(current);
    await held.drop();
    expect(onDropWish).not.toHaveBeenCalled();
  });

  it("asks the page about each segment separately", async () => {
    // Only the root says yes, so only the root lights up — one `canDrop` per segment rather than
    // one answer for the whole bar. No boxes: the ring is raised at `dragstart` on every eligible
    // target at once, which is a fact about the payload rather than about where the pointer is.
    mount({ withSource: true, canDrop: (_drag, folderId) => folderId === null });
    const held = await startPointerDrag(screen.getByText("the wish"));
    expect(marked(screen.getByRole("button", { name: "Wishlist" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Expensive" }), DROP_RING)).toBe(false);

    await held.cancel();
  });

  it("says so and takes nothing while flattened", async () => {
    mount({ withSource: true, flattened: true });
    const bar = screen.getByText("Wishlist · all folders");
    expect(bar).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    stack(bar);
    const held = await startPointerDrag(screen.getByText("the wish"));
    await held.over(bar);
    await held.drop();
    expect(onDropWish).not.toHaveBeenCalled();
  });
});
