import { useEffect, useRef, type ComponentProps } from "react";
import { dndManager } from "@/lib/dndManager";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { MenuItem } from "@/components/menu/types";
import { DROP_MARK_ROOM, DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { folderDraggable, type FolderDrag } from "@/lib/folderDrag";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { WishFolderCard } from "./WishFolderCard";
import { wishDraggable, type WishDrag } from "./wishDrag";

/**
 * How long a `waitFor` will wait for a state a drag has to travel to reach.
 *
 * The library schedules its `onDragStart` on `requestAnimationFrame` and every ring here is a
 * `useState` behind that, so one frame is necessary and never sufficient — seconds rather than
 * milliseconds because these plays run under a hundred-odd parallel jsdom files.
 * `ContextMenu.stories.tsx` measured the same thing first and carries the long form.
 * **Not exported**: CSF indexes every named export of a story file as a story.
 */
const DRAG_WAIT = 5_000;

function folder(over: Partial<WishlistFolder> & { id: number; name: string }): WishlistFolder {
  return { parentId: null, sortOrder: over.id, ...over };
}

/** The drawer every story below draws, and the one a wish is dropped into. */
const EXPENSIVE = folder({ id: 3, name: "Expensive" });

function node(
  f: WishlistFolder,
  over: Partial<FolderNode<WishlistFolder>> = {},
): FolderNode<WishlistFolder> {
  return { folder: f, depth: 0, count: 0, children: [], ...over };
}

/**
 * The card as the page draws it: inside the `<ul>` the wall is, inside the scroller that wall
 * lives in, with the page's own menu wired to all three of its handles.
 *
 * **The `<ul>` is not decoration.** `WishFolderCard` renders an `<li>` — `FolderCard`'s shape,
 * and a row of drawers genuinely is a list — so a story that dropped one straight onto the canvas
 * would put a list item outside a list and document markup the page does not build.
 *
 * **`DROP_MARK_ROOM` is on the scroller for the reason it exists**, even though nothing in jsdom
 * can go red for it: `overflow` clips at the padding box and a `DROP_RING` is a box shadow painted
 * *outside* the border box, so a card flush against the content edge loses the outer 2px of its
 * ring for the whole length of a drag. The wall in the workbench has to be the wall on the page,
 * or {@link DropTarget} would draw a ring the app clips.
 *
 * The menu is the real `useContextMenu`, off the provider `.storybook/preview.tsx` mounts for
 * every story — so the `⋯`, a right-click and Shift+F10 all open the page's three rows here, and
 * `menuClick` is exercised rather than described. Its presses report through {@link Wall.act}
 * instead of reaching a mutation this workbench does not hold.
 */
function Wall({
  act,
  ...card
}: Omit<ComponentProps<typeof WishFolderCard>, "rowMenu"> & { act: (what: string) => void }) {
  const { menu, menuKey, menuClick } = useContextMenu();
  const build = (): MenuItem[] => [
    { kind: "action", id: "rename", label: "Rename…", onSelect: () => act("rename") },
    { kind: "action", id: "move", label: "Move to folder…", onSelect: () => act("move") },
    { kind: "separator", id: "before-delete" },
    { kind: "action", id: "delete", label: "Delete…", onSelect: () => act("delete") },
  ];
  return (
    <div className={cn("relative max-h-44 overflow-y-auto", DROP_MARK_ROOM)}>
      <ul
        aria-label="Folders"
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
      >
        <WishFolderCard
          {...card}
          rowMenu={{
            onContextMenu: menu(build),
            onKeyDown: menuKey(build),
            onClick: menuClick(build),
          }}
        />
      </ul>
    </div>
  );
}

const meta = {
  title: "Wishlist/Folder card",
  component: Wall,
  tags: ["autodocs"],
  args: {
    node: node(EXPENSIVE),
    summary: { wishes: 6, missing: 6, cost: 312, unpriced: 0 },
    currency: "usd",
    onOpen: fn(),
    onDropWish: fn(),
    // The page's own answer, verbatim — spec §9: a folder takes any wish that is not already
    // filed in it. Stated once here rather than per story, because it is the rule rather than a
    // property of one tile; only {@link DropTarget} ever puts a wish in the air to ask it.
    canDrop: (drag: WishDrag): boolean => drag.folderId !== EXPENSIVE.id,
    // The page's rule for the *other* drag, cut down to the one drawer this wall draws: a folder
    // takes a sibling at any of the three landings, and refuses the folder that **is** it — which
    // is `reorderedLevel`'s first line said in the workbench's terms. The rest of what the page
    // checks (the cycle, the order that would not change) needs a cabinet, and a cabinet is
    // `WishlistPage`'s story rather than this one's.
    canDropFolder: (drag: FolderDrag): boolean => drag.folderId !== EXPENSIVE.id,
    onDropFolder: fn(),
    act: fn(),
  },
  decorators: [
    // The band the page gives its drawers — wide enough for the `auto-fill` track to be a row
    // rather than a column, which is the arrangement the truncation rules below are about.
    (Story) => (
      <div className="w-[32rem]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A drawer in the wishlist's filing cabinet, drawn above the wishes in both views. " +
          "**Dashed**, which on this screen is a rule rather than a decoration: dashed means " +
          "provisional, and a folder is a container rather than a thing you can *buy*. The " +
          "wishes inside it are the things with prices; the drawer they are in is not one of " +
          "them, and nothing else on the wishlist is dashed.\n\n" +
          "**No strip of member art, which is the one place it departs from the deck gallery's " +
          "`FolderCard` it was ported from.** A deck gallery is browsed by recognising a deck " +
          "and a deck's face is its art. A shopping list is not read that way — it is read for " +
          "its money — so the whole face here is `6 wishes · $312.00`, the only question anyone " +
          "asks of a wishlist drawer. That also makes the tile cheap in a way the deck card is " +
          "not: no image query, no `useImageRetry`, and no illustrator credit, because " +
          "Scryfall's image policy attaches to pictures and there are none here.\n\n" +
          "**The number it prints is the recursive total, never `wishlist_folder_summary`'s " +
          "row.** That row is *direct* — this folder's own wishes and not its sub-folders' — so " +
          "a drawer holding two full sub-folders and nothing of its own would draw `0 wishes` " +
          "over twelve. The page adds the children in with `buildFolderTree`'s own arithmetic " +
          "and hands the total here, which is why the summary answering **no row at all** for " +
          "an empty folder costs the card nothing ({@link Empty}).",
      },
    },
  },
} satisfies Meta<typeof Wall>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Six wishes and what they cost — the face a folder card exists to show.
 *
 * The press is on the `<button>` filling the tile rather than on the `<li>` around it, and its
 * `aria-label` says in words what the second line says in figures: a screen reader gets
 * `Expensive folder, 6 wishes, $312.00`, with the app's `·` swapped for commas because a middot
 * read aloud is punctuation nobody asked for. The two spellings are built together in one
 * function, so they cannot come to disagree about what the card says.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Expensive folder/ });
    await expect(tile).toHaveTextContent("6 wishes · $312.00");
    await expect(tile).toHaveAccessibleName("Expensive folder, 6 wishes, $312.00");

    await userEvent.click(tile);
    await expect(args.onOpen).toHaveBeenCalledTimes(1);
  },
};

/**
 * A folder with nothing in it, which is the state the summary has no row for at all.
 *
 * `wishlist_folder_summary` answers one row per folder that holds at least one wish **directly**
 * — the crate's `GROUP BY` over `WHERE folder_id IS NOT NULL` — so a folder the reader made a
 * minute ago is simply absent from it. The page falls back to a zeroed total and the card has to
 * draw that without complaint: an empty drawer is not an error, it is where the next wish goes.
 *
 * **It shows its count and no money at all.** `$0.00` on a folder with nothing left to buy is a
 * price nobody quoted, which is `formatPrice`'s own rule, and the unpriced note goes with it —
 * that note exists to qualify a subtotal and there is no subtotal here to qualify.
 */
export const Empty: Story = {
  args: {
    node: node(folder({ id: 8, name: "Someday" })),
    summary: { wishes: 0, missing: 0, cost: 0, unpriced: 0 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Someday folder/ });
    await expect(tile).toHaveTextContent("0 wishes");
    // No money, no em dash and no `· 0 unpriced`: three ways of saying nothing where the card
    // says nothing at all.
    await expect(tile).not.toHaveTextContent("·");
  },
};

/**
 * The moment before the figures land — **which is not the same picture as {@link Empty}**.
 *
 * The page draws its cabinet as soon as the folder *list* answers, and that list is one flat
 * `SELECT`; the numbers on this face come from `wishlist_folder_summary`, a `GROUP BY` carrying
 * the owned-copies subquery and a marketplace price expression, and it answers later. Across that
 * window a missing row and an unanswered read are one `Map.get` miss apart and mean opposite
 * things — so a drawer holding six wishes worth $312 drew `0 wishes` and then jumped. That is a
 * wrong number rather than a spinner, and the reader who glanced at the wall in that moment was
 * told the drawer was empty.
 *
 * `null` is the page's way of saying "not counted yet" and the card draws the em dash every other
 * unanswered figure in this app draws (`Figure`'s own `query.isPending ? "—"`), with the spoken
 * half in words because a dash read aloud is punctuation. It is also what a **marketplace switch**
 * looks like: that read is keyed on the marketplace, so the first frame in the new currency has
 * no subtotals of its own and must not borrow the old one's.
 */
export const Counting: Story = {
  args: { summary: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Expensive folder/ });
    await expect(tile).toHaveTextContent("—");
    await expect(tile).not.toHaveTextContent("0 wishes");
    await expect(tile).toHaveAccessibleName("Expensive folder, still counting");
  },
};

/**
 * Copies this marketplace could not price, counted beside the subtotal they are missing from.
 *
 * The note is written in the same `· 2 unpriced` shape the page header builds, so a folder's
 * qualification of its subtotal and the page's qualification of the whole list read as one
 * sentence rather than as two conventions. It counts a wish only where that wish has copies
 * **still to buy** — a row the binder already covers costs nothing whether the feed can quote it
 * or not, and counting it would put a "could not price" note on a folder with nothing left to buy.
 *
 * A `null` price is the answer and never a reason to reach for another marketplace's: no two
 * feeds have the same holes, so the two figures here are both this marketplace's or neither is.
 */
export const Unpriced: Story = {
  args: { summary: { wishes: 4, missing: 5, cost: 88, unpriced: 2 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /^Expensive folder/ })).toHaveTextContent(
      "4 wishes · $88.00 · 2 unpriced",
    );
  },
};

/* ---------------------------------------------------------------- a real drag ------- */

/**
 * A pointer drag, driven from a story.
 *
 * **`src/test-drag.ts` is the same thing and cannot be imported here.** That module registers an
 * `afterEach` from `vitest` at import time and pulls in `@testing-library/react`, so importing it
 * would put a test runner into the Storybook browser bundle and throw outside Vitest. So this is a
 * copy, and it is deliberately the smallest one that drives `@dnd-kit/dom`: a press, two moves
 * past the 5px activation distance, and a release.
 *
 * **Two things it has to do that a browser does for free**, and both are jsdom's doing rather than
 * the library's. jsdom lays nothing out, so an element with no box is given one — only when it has
 * none, so in a real Storybook window every rectangle is the window's own. And dnd-kit recomputes
 * collisions from a reactive effect its `Feedback` plugin drives through WAAPI, which jsdom does
 * not have, so the droppables' shapes and the collision pass are forced by hand after every move.
 *
 * **Every drag started here must be finished, and a `finally` is what finishes it.** The manager
 * has one drag operation and `handlePointerDown` returns early unless it is idle, so a story that
 * walked away holding a card leaves the next one unable to pick anything up. That is not
 * hypothetical: it is the second half of the flake this file used to have, where one broken
 * assertion mid-drag reported as two failures. {@link pickUp}'s `cancel` is Escape at the body and
 * is inert when nothing is in flight, so a story that ends in a real `drop` pays a no-op for the
 * same guarantee.
 */
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

/** Somewhere for the next unmeasured element to be. Stacked, so no two ever overlap. */
let unmeasured = 0;

/** Where an element is — and, under jsdom, where it is going to pretend to be. */
function centreOf(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  if (box.width > 0 || box.height > 0)
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const top = (unmeasured += 120);
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + 60,
      width: 200,
      height: 60,
      toJSON: () => ({}),
    }) as DOMRect;
  return { x: 100, y: top + 30 };
}

function firePointer(type: string, at: { x: number; y: number }, target: EventTarget): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.x,
      clientY: at.y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    }),
  );
}

/** The collision pass jsdom cannot schedule, plus the measurement it cannot take — **twice**,
 *  because the operation's target follows the collisions one hop behind: the observer's reaction
 *  disables it, calls `setDropTarget`, and re-enables on a promise. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    await frame();
    for (const droppable of dndManager.registry.droppables) droppable.refreshShape();
    dndManager.collisionObserver.forceUpdate();
    await frame();
  }
}

/** Move the pointer. **Twice per step**, because the operation's own position lags one
 *  `pointermove` behind: the sensor records the coordinates and hands the move to its scheduler. */
async function pointerTo(at: { x: number; y: number }): Promise<void> {
  for (let i = 0; i < 2; i++) {
    firePointer("pointermove", at, document);
    await frame();
  }
  await settle();
}

async function pickUp(source: Element) {
  const start = centreOf(source);
  let at = start;
  firePointer("pointerdown", start, source);
  await pointerTo({ x: start.x, y: start.y + 8 });
  await pointerTo({ x: start.x, y: start.y + 16 });
  return {
    over: async (target: Element) => {
      at = centreOf(target);
      await pointerTo(at);
    },
    drop: async (target: Element) => {
      at = centreOf(target);
      await pointerTo(at);
      firePointer("pointerup", at, document);
      await frame();
    },
    /** How a real drag ends when the reader presses Escape or lets go over nothing. */
    cancel: async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await frame();
    },
  };
}

/**
 * An **any-printing** wish, which is the one a card drag cannot pick up.
 *
 * `WishlistGrid` registers no card drag at all on a wish with no `card_id` — there is no printing
 * to carry, and `dnd.ts` refuses an empty id because it "addresses every row and no row". Filing
 * one is exactly as much a thing a reader wants to do, so its payload carries the `wishSource`
 * mark **alone**, and a folder is the only target in the app that answers it.
 */
const LOOSE_WISH: WishDrag = { wishId: 7, name: "Sol Ring", folderId: null };

/** Something to pick up: `wishDraggable` rather than the library's `draggable`, so the payload
 *  travels exactly as a wish tile's does. `card: () => null` is what leaves `dnd.ts`'s mark off. */
function Source({ wish }: { wish: WishDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return wishDraggable({ element, wish: () => wish, card: () => null });
  }, [wish]);
  return (
    <div
      ref={ref}
      className="inline-block w-max cursor-grab rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      {wish.name}
    </div>
  );
}

/**
 * The two rings, and the folder that draws neither.
 *
 * **`DROP_RING` is raised on every folder that would take the wish, not only the one under the
 * pointer**, from the moment it leaves the tile — that is what tells a reader where a drag can
 * end before they have aimed anywhere. `DROP_OVER` is the second, narrower fact only the target
 * the pointer is actually over can answer, and it comes with `border-accent` so the dashed edge
 * itself says which drawer is about to take it.
 *
 * **The folder a wish is already filed in refuses it and draws no ring at all** — spec §9, and
 * the same rule as a deck card dropped back into its own column: a ring that led to a write which
 * moved nothing and bumped `updated_at` would be worse than no ring. `WishDrag.folderId` is the
 * whole of what lets a target answer that before the drop, which is why the payload carries it.
 *
 * The drag runs over the library's own code path. What it cannot reach is what `test-drag.ts`
 * records and what {@link Wall}'s scroller is about: the platform's drag preview, the pointer
 * hit-testing that decides which card a `dragover` lands on, and the clip that `DROP_MARK_ROOM`
 * buys room against — all three measure rectangles, and jsdom has no layout engine. Those stay
 * the live pass's to prove.
 */
export const DropTarget: Story = {
  render: (args) => (
    <div className="flex w-[32rem] flex-col gap-4">
      <Wall {...args} />
      <Source wish={LOOSE_WISH} />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Expensive folder/ });
    // The ring lives on the `<li>`, which is where the page's scroller has to leave room for it.
    const item = tile.closest("li")!;
    const marked = (element: Element, mark: string) =>
      // `classList.contains` per class, never `className.includes`: several classes around these
      // are `hover:` variants, and a substring test against the whole attribute passes before any
      // state has changed — a vacuous assertion that reads exactly like a real one.
      mark.split(" ").every((one) => element.classList.contains(one));

    await expect(marked(item, DROP_RING)).toBe(false);

    const held = await pickUp(canvas.getByText("Sol Ring"));
    try {
      await waitFor(() => expect(marked(item, DROP_RING)).toBe(true), { timeout: DRAG_WAIT });
      await expect(marked(tile, DROP_OVER)).toBe(false);

      await held.over(item);
      await waitFor(() => expect(marked(tile, DROP_OVER)).toBe(true), { timeout: DRAG_WAIT });
      await expect(tile).toHaveClass("border-accent");
    } finally {
      await held.cancel();
    }
    // Cancelled, not dropped — the platform ends both the same way, so the ring stands down
    // without the hook ever hearing a keypress, and nothing was filed.
    await waitFor(() => expect(marked(item, DROP_RING)).toBe(false), { timeout: DRAG_WAIT });
    await expect(args.onDropWish).not.toHaveBeenCalled();
  },
};

/* ------------------------------------------------------ the other drag ------- */

/** A sibling drawer, in the air — `folderDraggable` rather than a whole second card, so this wall
 *  keeps one drop target and the story stays about what happens to the card under the pointer. */
function FolderSource({ drag }: { drag: FolderDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return folderDraggable({ element, folder: () => drag });
  }, [drag]);
  return (
    <div
      ref={ref}
      className="inline-block w-max cursor-grab rounded-md border border-dashed border-border bg-surface px-3 py-2 text-sm"
    >
      {drag.name}
    </div>
  );
}

/** The drawer the story below carries. */
const OTHER_FOLDER: FolderDrag = {
  folderId: 8,
  name: "Someday",
  parentId: null,
  scope: "wishlist",
};

/**
 * **A folder card is a drag source and a drop target for _folders_ as well as for wishes**, and
 * this is the story to drag in rather than to read: the three landings only exist under a pointer.
 *
 * Drop `Someday` on the **middle** of the drawer and it goes *inside* it — the same gold wash a
 * wish gets, because only one thing is ever in the air and both mean "what you are holding lands in
 * here". Drop it near either **end** and a 2px line appears on that side: it lands *beside* the
 * drawer, and the line is honest because a folder has a `sortOrder` a cabinet can keep. The outer
 * quarter of each end is the reorder zone and the middle half is the nest — a quarter is the only
 * split at which a reorder and a nest are the same size of target, and `EDGE_ZONE` proves it.
 *
 * Two things are deliberately **not** marked. `inside` draws no line: it is a folder taking the
 * drag rather than a position between two of them, and the app already has a mark for that. And a
 * landing the page refuses draws nothing at all — no line, no wash — because a mark leading to a
 * write that never happens is worse than no mark.
 *
 * The `⋯` is `data-no-drag`, so a press there opens the menu instead of picking the drawer up. That
 * guard is not decoration: Chromium starts a drag from the nearest draggable *ancestor* of whatever
 * was pressed.
 *
 * **The card carries two drop targets on two boxes, and that stopped being a fact about the
 * library.** `@atlaskit/pragmatic-drag-and-drop` kept one element drop target per element and a
 * second registration silently replaced the first, so two payloads needed two boxes;
 * `@dnd-kit/dom` keys its registry by entity id and resolves the pair through `accepts()`, asked
 * before anything is measured. The two boxes stay for the geometry and for every test and story
 * that addresses them by name. The wish's is the `<li>`; the folder's is an inner wrapper that
 * covers every pixel of the card.
 */
export const FolderTarget: Story = {
  render: (args) => (
    <div className="flex w-[32rem] flex-col gap-4">
      <Wall {...args} />
      <FolderSource drag={OTHER_FOLDER} />
    </div>
  ),
};
