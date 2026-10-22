import { useEffect, useRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { folderDraggable, type FolderDrag } from "@/lib/folderDrag";
import type { WishlistFolder } from "@/lib/ipc";
import { boxed, startPointerDrag } from "@/test-drag";
import { WishlistBreadcrumb } from "./WishlistBreadcrumb";
import { wishDraggable, type WishDrag, type WishDrop } from "./wishDrag";

/**
 * The breadcrumb — where the reader is standing, and the way back out of it, for a wish **and**
 * since the shelves for a folder too.
 *
 * **Carried out of `WishFolderCard.test.tsx`**, where it lived beside the card it was one contract
 * with — a folder card took a wish *down* and a segment took it *back out*. The card went with the
 * folder band (2026-09-26) and a heading took its half; the breadcrumb's half is unchanged, and
 * its seven cases are carried verbatim but for the eighth, *"says so and takes nothing while
 * flattened"*, which went with Flatten. One case is new: a segment takes a **folder** now, filed
 * last in that level (the `ParentFolderCard` "Up one level" tile's job, spec §6), and its marks are
 * the same pair the wish's are.
 *
 * **It is the page bar's trail since 2026-10-21**: the folder the reader is in is the bar's title
 * (`WishlistPage.test.tsx` holds that), so the trail draws only the levels above it, and nothing at
 * the root. The cases that pinned the current folder as an inert `aria-current` segment now pin its
 * absence.
 *
 * **Both drags are driven over the library's real code path, and both are pointer gestures.**
 * `packages/ui/test-drag.ts` supplies the two things jsdom cannot: it lays nothing out, so **every source,
 * and every target a pointer has to reach, states its own box** or the coordinate the library
 * hit-tests by finds nothing at all; and it forces the collision pass the library would drive off
 * its own drag preview. Both failures are silent — the registration is correct, the droppable
 * accepts the payload, and the operation's target is `null` on every frame — which is why the boxes
 * below are setup rather than decoration.
 */

const WISH: WishDrag = { wishId: 7, name: "Lightning Bolt", folderId: null };
/** The same wish as the **drop** a segment answers about — `readWishDrop`'s union, `kind: "wish"`. */
const WISH_DROP: WishDrop = { kind: "wish", wish: WISH };

function folder(over: Partial<WishlistFolder> & { id: number; name: string }): WishlistFolder {
  return {
    rules: [],
    parentId: null,
    sortOrder: over.id,
    managedDeckId: null,
    managedTokens: false,
    syncUid: null,
    managedDeckUid: null,
    ...over,
  };
}

const EXPENSIVE = folder({ id: 3, name: "Expensive" });
const SOMEDAY = folder({ id: 9, name: "Someday", parentId: 3 });

/** A folder in the air — a sibling drawer being carried up out of `Someday`. */
const LOOSE_FOLDER: FolderDrag = {
  folderId: 12,
  name: "Foils",
  parentId: 9,
  scope: "wishlist",
};

const SOURCE_BOX = new DOMRect(0, 0, 240, 120);

const onOpen = vi.fn();
const onDropWish = vi.fn();
const onDropFolder = vi.fn();

beforeEach(() => {
  onOpen.mockReset();
  onDropWish.mockReset();
  onDropFolder.mockReset();
});

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
 *  whose payload is the wish mark alone. Boxed well clear of the trail: dnd-kit reads the press
 *  off the source's own rect, and a source with no box is pressed at the origin. */
function Source({ wish = WISH }: { wish?: WishDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return wishDraggable({ element, wish: () => wish, card: () => null });
  }, [wish]);
  return <div ref={ref}>the wish</div>;
}

/** A heading in the air, picked up the way `useShelfDragSource` picks one up. */
function FolderSource({ drag = LOOSE_FOLDER }: { drag?: FolderDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return folderDraggable({ element, folder: () => drag });
  }, [drag]);
  return <div ref={ref}>the folder</div>;
}

function mount({
  trail = [EXPENSIVE, SOMEDAY],
  canDrop = () => true,
  canDropFolder,
  withSource = false,
  withFolder = false,
}: {
  trail?: readonly WishlistFolder[];
  canDrop?: (drop: WishDrop, folderId: number | null) => boolean;
  canDropFolder?: (drag: FolderDrag, folderId: number | null) => boolean;
  withSource?: boolean;
  withFolder?: boolean;
} = {}) {
  render(
    <>
      {withSource && <Source />}
      {withFolder && <FolderSource />}
      <WishlistBreadcrumb
        trail={trail}
        onOpen={onOpen}
        canDrop={canDrop}
        onDropWish={onDropWish}
        canDropFolder={canDropFolder}
        onDropFolder={canDropFolder === undefined ? undefined : onDropFolder}
      />
    </>,
  );
}

/**
 * Give the trail's segments boxes, stacked clear of one another and of the thing in the air.
 *
 * jsdom lays nothing out and dnd-kit hit-tests by **coordinate**, so a segment with no box can
 * never be collided with. 100px apart, so a pointer over one segment is unambiguously not over its
 * neighbour, and all of them well below {@link SOURCE_BOX} so the press that starts the drag lands
 * on none of them.
 */
const stack = (...segments: HTMLElement[]) =>
  segments.forEach((segment, index) => boxed(segment, 200 + index * 100));

describe("WishlistBreadcrumb", () => {
  it("draws the levels above the folder you are in, root-most first, and not that folder", () => {
    mount();
    const bar = screen.getByRole("navigation", { name: "Wishlist folders" });
    expect(
      within(bar)
        .getAllByRole("button")
        .map((segment) => segment.textContent),
    ).toEqual(["Wishlist", "Expensive"]);
    // The folder the reader is standing in is the page bar's title, not a place to go — and not
    // an inert word in the trail either, so nothing here is `current`.
    expect(screen.queryByText("Someday")).not.toBeInTheDocument();
    expect(bar.querySelector("[aria-current]")).toBeNull();
  });

  it("draws no trail when the reader is already at the root", () => {
    mount({ trail: [] });
    // Nothing above the root: no landmark, no lone inert `Wishlist` beside the bar's own title.
    expect(screen.queryByRole("navigation", { name: "Wishlist folders" })).not.toBeInTheDocument();
    expect(screen.queryByText("Wishlist")).not.toBeInTheDocument();
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
    expect(onDropWish).toHaveBeenCalledWith(WISH_DROP, null);
  });

  it("takes a wish dropped on an ancestor and moves it up", async () => {
    mount({ withSource: true });
    const ancestor = screen.getByRole("button", { name: "Expensive" });
    stack(screen.getByRole("button", { name: "Wishlist" }), ancestor);

    const held = await startPointerDrag(screen.getByText("the wish"));
    await held.over(ancestor);
    await held.drop();
    expect(onDropWish).toHaveBeenCalledWith(WISH_DROP, 3);
  });

  it("offers no drop on the folder the reader is already standing in", async () => {
    // It is not a segment, so no target is registered for it at all. Every target asks the page
    // about its own level at `dragstart` (the ring), so the levels asked about are exactly the
    // segments drawn — the two above, and never the one the reader is in.
    const asked = new Set<number | null>();
    mount({
      withSource: true,
      canDrop: (_drop, folderId) => {
        asked.add(folderId);
        return true;
      },
    });
    stack(
      screen.getByRole("button", { name: "Wishlist" }),
      screen.getByRole("button", { name: "Expensive" }),
    );

    const held = await startPointerDrag(screen.getByText("the wish"));
    expect([...asked]).toEqual(expect.arrayContaining([null, 3]));
    expect(asked.has(SOMEDAY.id)).toBe(false);
    await held.cancel();
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

  /**
   * **A segment takes a folder too, since the shelves** — filed last in that level, which is what
   * the `ParentFolderCard` "Up one level" tile did before it went with the folder band (spec §6,
   * §7). Its marks are the wish's own pair, merged: `DROP_RING` on every segment that would take
   * it the moment it is picked up, asked per segment (`Expensive` is the folder's own grandparent
   * level here and the page refuses it); `DROP_OVER` on the one under the pointer; and the drop
   * writes through `onDropFolder` with the segment's level — never through `onDropWish`, because
   * `readWishDrop` refuses a folder payload and the two targets stay apart.
   */
  it("takes a folder dropped on a segment, with the wish's own marks, asked per segment", async () => {
    mount({ withFolder: true, canDropFolder: (_drag, folderId) => folderId === null });
    const root = screen.getByRole("button", { name: "Wishlist" });
    const ancestor = screen.getByRole("button", { name: "Expensive" });
    stack(root, ancestor);

    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(held.started).toBe(true);
    expect(marked(root, DROP_RING)).toBe(true);
    expect(marked(ancestor, DROP_RING)).toBe(false);

    await held.over(root);
    expect(marked(root, DROP_OVER)).toBe(true);
    await held.drop();

    expect(onDropFolder).toHaveBeenCalledWith(LOOSE_FOLDER, null);
    expect(onDropWish).not.toHaveBeenCalled();
  });

  /**
   * **A segment takes a drop only while the pointer is inside it** (`pointerOnly`) — the stray drop
   * the shelf headings were fenced against, one row up. dnd-kit's default detector falls back to the
   * carried card's *rectangle* when the pointer is in no target, so a card released over the first
   * row of tiles inside an opened folder, overlapping the path row above it, was filed into a
   * segment the reader never pointed at.
   *
   * Staged as `useShelfDrag.test.tsx`'s pair is: jsdom measures the carried thing once, off its
   * source's own box, so a source at 230–270 reaches 10px into the root segment at 200–240, and the
   * pointer is then walked off to where no segment is. The ring still rises — the segment would take
   * it — and the release files nothing.
   */
  it.each([
    ["a wish", "the wish"],
    ["a folder", "the folder"],
  ] as const)(
    "files %s only while the pointer is inside a segment, however near what is carried",
    async (_what, source) => {
      mount({
        withSource: source === "the wish",
        withFolder: source === "the folder",
        canDropFolder: () => true,
      });
      const root = screen.getByRole("button", { name: "Wishlist" });
      boxed(root, 200);
      boxed(screen.getByRole("button", { name: "Expensive" }), 600);
      const carried = boxed(screen.getByText(source), 230);

      const held = await startPointerDrag(carried);
      expect(marked(root, DROP_RING)).toBe(true);
      await held.moveTo(100, 400);
      await held.drop();

      expect(onDropWish).not.toHaveBeenCalled();
      expect(onDropFolder).not.toHaveBeenCalled();
    },
  );
});
