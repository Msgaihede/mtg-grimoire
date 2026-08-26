import { useEffect, useRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { FolderNode } from "@/lib/folderTree";
import type { CollectionFolder } from "@/lib/ipc";
import { startDrag } from "@/test-drag";
import { CollectionBreadcrumb } from "./CollectionBreadcrumb";
import { CollectionFolderCard, type CollectionFolderTotals } from "./CollectionFolderCard";
import { collectionDraggable, type CollectionDrag } from "./collectionDrag";

/**
 * The two things the collection page draws around its cards: the dashed folder tile a reader
 * clicks into, and the breadcrumb they climb back out on.
 *
 * **One file for two components, because they are one contract.** "Where a copy can be dropped"
 * is a single sentence about both — a folder card takes a row *down* and a breadcrumb segment
 * takes it *back out*, and "without the breadcrumb a drag can only ever push cards deeper" is a
 * claim no test of either component alone can make. `WishFolderCard.test.tsx`'s arrangement, for
 * its reason.
 *
 * **The drags are driven over the library's real code path** — `src/test-drag.ts` says why jsdom
 * can carry `dragstart`/`dragenter`/`drop` at all, and lists what it cannot. What is out of reach
 * here and stays the live pass's to prove: that a ring drawn *outside* a card's border box
 * survives the wall's own `overflow` (that is `DROP_MARK_ROOM`, and jsdom has no layout engine and
 * therefore no clip), and the pointer hit-testing that decides which card a `dragover` lands on.
 */

const ENTRY: CollectionDrag = { entryId: 7, name: "Lightning Bolt", folderId: null };

function folder(
  over: Partial<CollectionFolder> & { id: number; name: string },
): CollectionFolder {
  return { parentId: null, kind: "user", deckId: null, sortOrder: over.id, ...over };
}

const BINDER = folder({ id: 3, name: "Trade binder" });
const FOILS = folder({ id: 9, name: "Foils", parentId: 3 });

function node(
  f: CollectionFolder,
  over: Partial<FolderNode<CollectionFolder>> = {},
): FolderNode<CollectionFolder> {
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

/**
 * Something to pick up.
 *
 * `collectionDraggable` rather than the library's `draggable` directly, so the payload travels
 * exactly as a collection row's does — **both keys at once**, which is the case that would break
 * if the two marks were ever collapsed into one.
 */
function Source({ entry = ENTRY }: { entry?: CollectionDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return collectionDraggable({
      element,
      entry: () => entry,
      card: () => ({ kind: "card", cardId: "c1", name: entry.name, typeLine: "Instant" }),
    });
  }, [entry]);
  return <div ref={ref}>the copy</div>;
}

const onOpen = vi.fn();
const onDropCard = vi.fn();
const onContextMenu = vi.fn();
const onKeyDown = vi.fn();
const onClickMenu = vi.fn();

beforeEach(() => {
  onOpen.mockReset();
  onDropCard.mockReset();
  onContextMenu.mockReset();
  onKeyDown.mockReset();
  onClickMenu.mockReset();
});

describe("CollectionFolderCard", () => {
  function mount({
    summary = { cards: 12, value: 340.25 } as CollectionFolderTotals | null,
    currency = "usd" as const,
    canDrop = () => true,
    withSource = false,
  }: {
    summary?: CollectionFolderTotals | null;
    currency?: "usd" | "eur";
    canDrop?: (drag: CollectionDrag) => boolean;
    withSource?: boolean;
  } = {}) {
    render(
      <>
        {withSource && <Source />}
        {/* Inside a `<ul>`, because the card is an `<li>` — `FolderCard`'s shape, and a row of
            folders genuinely is a list. */}
        <ul>
          <CollectionFolderCard
            node={node(BINDER)}
            summary={summary}
            currency={currency}
            onOpen={onOpen}
            rowMenu={{ onContextMenu, onKeyDown, onClick: onClickMenu }}
            canDrop={canDrop}
            onDropCard={onDropCard}
          />
        </ul>
      </>,
    );
  }

  /** The card's own box — the element the ring is drawn on, and the one registered as a target. */
  function card(): HTMLElement {
    return screen.getByRole("button", { name: /^Trade binder folder/ }).closest("li")!;
  }

  it("names the folder and says what is in it", () => {
    mount();
    expect(screen.getByText("Trade binder")).toBeInTheDocument();
    expect(screen.getByText("12 cards · $340.25")).toBeInTheDocument();
  });

  it("prices in the currency it is handed", () => {
    mount({ currency: "eur" });
    expect(screen.getByText("12 cards · €340.25")).toBeInTheDocument();
  });

  it("says `1 card`, never `1 cards`", () => {
    mount({ summary: { cards: 1, value: 4 } });
    expect(screen.getByText("1 card · $4.00")).toBeInTheDocument();
  });

  /** A binder is thousands of copies where a wishlist is tens, which is why this writes its number
   *  through `count` rather than through `plural`'s plain one. */
  it("writes a four-figure count with its thousands separator", () => {
    mount({ summary: { cards: 1204, value: 12000 } });
    expect(screen.getByText("1,204 cards · $12,000.00")).toBeInTheDocument();
  });

  /**
   * **An em dash, never `$0.00`** — the backend answers `null` for a folder the marketplace priced
   * nothing in, and `$0.00` there would claim a quote nobody gave. The spoken half says it in
   * words, because a dash read aloud is punctuation.
   */
  it("draws an em dash rather than $0.00 when nothing in the folder is priced", () => {
    mount({ summary: { cards: 12, value: null } });
    expect(screen.getByText("12 cards · —")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trade binder folder, 12 cards, not priced" }),
    ).toBeInTheDocument();
  });

  /** An empty drawer is the ordinary state of a folder the reader just made, and money for nothing
   *  is noise: no price at all, not `$0.00` and not a dash. */
  it("shows the count alone on a folder holding nothing", () => {
    mount({ summary: { cards: 0, value: null } });
    expect(screen.getByText("0 cards")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trade binder folder, 0 cards" }),
    ).toBeInTheDocument();
  });

  /**
   * **`null` is "not counted yet", and it is a different answer from an empty drawer.** The wall is
   * gated on the folder *list* — one flat `SELECT` — while the figures come from a `GROUP BY` with
   * a price expression behind it, so `0 cards` across that window is a wrong number that then
   * jumps rather than a spinner.
   */
  it("says nothing is counted yet rather than `0 cards`, while the summary is still reading", () => {
    mount({ summary: null });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/cards/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trade binder folder, still counting" }),
    ).toBeInTheDocument();
  });

  /** A wall of these is otherwise a row of controls all called "Manage": a screen reader reads
   *  them out of context, one after another, with nothing to tell them apart. */
  it("carries a manage trigger named for its own folder", () => {
    mount();
    const trigger = screen.getByRole("button", { name: "Manage Trade binder" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    // Deliberately absent: the open state is `ContextMenuProvider`'s fact, and a static
    // `aria-expanded="false"` would be an assertion that is wrong for as long as the menu is up.
    expect(trigger).not.toHaveAttribute("aria-expanded");
  });

  it("opens the folder when pressed", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /^Trade binder folder/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  /** Three doors into one menu, and the trigger's plain click is the third: it is either a pointer
   *  press or an Enter key, and only `menuClick` knows to ask. */
  it("hands all three menu gestures to the page", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Manage Trade binder" }));
    expect(onClickMenu).toHaveBeenCalledTimes(1);

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /^Trade binder folder/ }),
    });
    expect(onContextMenu).toHaveBeenCalledTimes(1);

    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(onKeyDown).toHaveBeenCalled();
  });

  it("raises a ring for a copy it can take, and a wash under the pointer", async () => {
    mount({ withSource: true });
    const held = await startDrag(screen.getByText("the copy"));
    expect(held.started).toBe(true);
    expect(marked(card(), DROP_RING)).toBe(true);
    expect(marked(card().querySelector("button"), DROP_OVER)).toBe(false);

    await held.over(card());
    expect(marked(card().querySelector("button"), DROP_OVER)).toBe(true);

    await held.cancel();
  });

  /** The folder a copy is already filed in draws no ring at all, rather than a ring leading to a
   *  write that moves nothing and bumps `updated_at`. */
  it("draws no ring at all for a copy it refuses", async () => {
    mount({ withSource: true, canDrop: () => false });
    const held = await startDrag(screen.getByText("the copy"));
    expect(marked(card(), DROP_RING)).toBe(false);

    // And refusing means refusing the drop too, not merely declining to advertise it.
    await held.over(card());
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  it("files the copy it is dropped", async () => {
    mount({ withSource: true });
    const held = await startDrag(screen.getByText("the copy"));
    await held.over(card());
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY);
  });
});

describe("CollectionBreadcrumb", () => {
  function mount({
    trail = [BINDER, FOILS] as readonly CollectionFolder[],
    canDrop = () => true,
    withSource = false,
    flattened = false,
  }: {
    trail?: readonly CollectionFolder[];
    canDrop?: (drag: CollectionDrag, folderId: number | null) => boolean;
    withSource?: boolean;
    flattened?: boolean;
  } = {}) {
    render(
      <>
        {withSource && <Source />}
        <CollectionBreadcrumb
          trail={trail}
          flattened={flattened}
          onOpen={onOpen}
          canDrop={canDrop}
          onDropCard={onDropCard}
        />
      </>,
    );
  }

  it("draws the trail root-most first, with the folder you are in current and inert", () => {
    mount();
    expect(screen.getByRole("button", { name: "Collection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trade binder" })).toBeInTheDocument();
    // The folder the reader is standing in is not a place to go.
    expect(screen.queryByRole("button", { name: "Foils" })).not.toBeInTheDocument();
    expect(screen.getByText("Foils")).toHaveAttribute("aria-current", "page");
  });

  it("makes the root itself current when the reader is already there", () => {
    mount({ trail: [] });
    expect(screen.queryByRole("button", { name: "Collection" })).not.toBeInTheDocument();
    expect(screen.getByText("Collection")).toHaveAttribute("aria-current", "page");
  });

  /**
   * **Flattened, the trail becomes a sentence about what is on screen.** With every folder drawn
   * at once there is no level to walk to, so a segment would be a door into the place the reader
   * is already standing — and, filed deeper, a drop target for a move that means nothing.
   *
   * The landmark and its name survive the switch on purpose: `CollectionPage` keeps this bar
   * while it puts the wall and the pinned strip away, so this is the only thing on screen saying
   * why three bands just vanished, and anything looking for `Collection folders` has to find it
   * in either state.
   */
  it("says what is on screen instead of a trail, once the filing is ignored", () => {
    mount({ flattened: true });
    const bar = screen.getByRole("navigation", { name: "Collection folders" });
    // `\s*` around the middot: a CSS gap between inline boxes is not a space to the accname
    // algorithm, and jsdom cannot referee that either way.
    expect(bar).toHaveTextContent(/Collection\s*·\s*all folders/);
    expect(within(bar).queryByRole("button")).toBeNull();
    // Not merely unlinked — the folder the reader was in is not named at all, because the list
    // is no longer showing it rather than everything else.
    expect(screen.queryByText("Trade binder")).not.toBeInTheDocument();
    expect(screen.queryByText("Foils")).not.toBeInTheDocument();
  });

  it("climbs to the root and to an ancestor", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Collection" }));
    expect(onOpen).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Trade binder" }));
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  /** The whole reason the segments are drop targets: without this a drag can only ever push copies
   *  deeper, and nothing on the page brings one back. */
  it("takes a copy dropped on the root and un-files it", async () => {
    mount({ withSource: true });
    const root = screen.getByRole("button", { name: "Collection" });
    const held = await startDrag(screen.getByText("the copy"));
    expect(marked(root, DROP_RING)).toBe(true);

    await held.over(root);
    expect(marked(root, DROP_OVER)).toBe(true);
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY, null);
  });

  it("takes a copy dropped on an ancestor and moves it up", async () => {
    mount({ withSource: true });
    const held = await startDrag(screen.getByText("the copy"));
    await held.over(screen.getByRole("button", { name: "Trade binder" }));
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY, 3);
  });

  it("offers no drop on the folder the reader is already standing in", async () => {
    mount({ withSource: true });
    const held = await startDrag(screen.getByText("the copy"));
    expect(marked(screen.getByText("Foils"), DROP_RING)).toBe(false);

    await held.over(screen.getByText("Foils"));
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  it("asks the page about each segment separately", async () => {
    // Only the root says yes, so only the root lights up — one `canDrop` per segment rather than
    // one answer for the whole bar.
    mount({ withSource: true, canDrop: (_drag, folderId) => folderId === null });
    const held = await startDrag(screen.getByText("the copy"));
    expect(marked(screen.getByRole("button", { name: "Collection" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Trade binder" }), DROP_RING)).toBe(false);

    await held.cancel();
  });
});
