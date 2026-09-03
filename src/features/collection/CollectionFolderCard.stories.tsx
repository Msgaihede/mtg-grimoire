import { useEffect, useRef, type ComponentProps } from "react";
import { dndManager } from "@/lib/dndManager";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { MenuItem } from "@/components/menu/types";
import { DROP_MARK_ROOM, DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { folderDraggable, type FolderDrag } from "@/lib/folderDrag";
import type { FolderNode } from "@/lib/folderTree";
import type { CollectionFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { CollectionFolderCard, type CollectionFolderTotals } from "./CollectionFolderCard";
import {
  collectionDraggable,
  collectionTileDraggable,
  type CollectionDrag,
  type CollectionDrop,
  type CollectionTileDrag,
} from "./collectionDrag";

/**
 * How long a `waitFor` will wait for a state a drag has to travel to reach.
 *
 * The library schedules its `onDragStart` on `requestAnimationFrame` and every ring here is a
 * `useState` behind that, so one frame is necessary and never sufficient — seconds rather than
 * milliseconds because these plays run under a hundred-odd parallel jsdom files.
 * **Not exported**: CSF indexes every named export of a story file as a story.
 */
const DRAG_WAIT = 5_000;

function folder(
  over: Partial<CollectionFolder> & { id: number; name: string },
): CollectionFolder {
  return { parentId: null, kind: "user", deckId: null, sortOrder: over.id, ...over };
}

/** The drawer every story below draws, and the one a copy is dropped into. */
const BINDER = folder({ id: 3, name: "Trade binder" });

/**
 * The rename arm at rest — every card on the wall but the one being renamed.
 *
 * `active` is the **page's** flag rather than the card's, because one field is open at a time
 * across the whole cabinet: pressing `New folder` has to close a rename already in progress, and a
 * card holding its own flag could not know that had happened. **Not exported**: CSF indexes every
 * named export of a story file as a story.
 */
const RESTING = { active: false, pending: false, onSubmit: fn(), onCancel: fn() };

function node(
  f: CollectionFolder,
  over: Partial<FolderNode<CollectionFolder>> = {},
): FolderNode<CollectionFolder> {
  return { folder: f, depth: 0, count: 0, children: [], ...over };
}

/**
 * The card as the page draws it: inside the `<ul>` the wall is, inside the scroller that wall
 * lives in, with the page's own menu wired to all three of its handles.
 *
 * **The `<ul>` is not decoration.** `CollectionFolderCard` renders an `<li>` — `FolderCard`'s
 * shape, and a row of drawers genuinely is a list — so a story that dropped one straight onto the
 * canvas would put a list item outside a list and document markup the page does not build.
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
  siblings = [],
  ...card
}: Omit<ComponentProps<typeof CollectionFolderCard>, "rowMenu"> & {
  act: (what: string) => void;
  /**
   * Drawers drawn **after** the subject, at rest, for the one story whose whole subject is a card
   * against the cards beside it.
   *
   * Real `CollectionFolderCard`s rather than stand-in markup, because the claim is that a renaming
   * card and a resting one differ in exactly one property — the edge's colour — and a hand-written
   * tile beside it would be a resemblance this file maintains rather than one the component
   * guarantees. Empty for every other story: a wall of one is what makes a drop unambiguous.
   */
  siblings?: readonly { folder: CollectionFolder; summary: CollectionFolderTotals }[];
}) {
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
        <CollectionFolderCard
          {...card}
          rowMenu={{
            onContextMenu: menu(build),
            onKeyDown: menuKey(build),
            onClick: menuClick(build),
          }}
        />
        {siblings.map(({ folder: beside, summary }) => (
          <CollectionFolderCard
            key={beside.id}
            {...card}
            node={node(beside)}
            summary={summary}
            rename={RESTING}
            rowMenu={{
              onContextMenu: menu(build),
              onKeyDown: menuKey(build),
              onClick: menuClick(build),
            }}
          />
        ))}
      </ul>
    </div>
  );
}

const meta = {
  title: "Collection/Folder card",
  component: Wall,
  tags: ["autodocs"],
  args: {
    node: node(BINDER),
    summary: { cards: 12, value: 340.25 },
    currency: "usd",
    onOpen: fn(),
    // `Rename…` is answered on the card since 2026-09-03, so every card on every wall carries this
    // arm — at rest here, and open in exactly one story below.
    rename: RESTING,
    onDropCard: fn(),
    // The page's own answer, verbatim, for both shapes a collection drop can be: a folder takes
    // any copy that is not already filed in it. A *tile* is takeable when **at least one** of the
    // copies behind it is somewhere else — a printing with copies in three folders is a real thing
    // to file, and refusing it because one copy is already here would leave the other two
    // unreachable by the gesture. Stated once here rather than per story, because it is the rule
    // rather than a property of one tile; only the two drag stories below ever put anything in the
    // air to ask it.
    canDrop: (drop: CollectionDrop): boolean =>
      drop.kind === "entry"
        ? drop.entry.folderId !== BINDER.id
        : drop.tile.copies.some((copy) => copy.folderId !== BINDER.id),
    // The page's rule for the *other* drag, cut down to the one drawer this wall draws: a folder
    // takes a sibling at any of the three landings, and refuses the folder that **is** it — which
    // is `reorderedLevel`'s first line said in the workbench's terms. Everything else the page
    // checks (the `kind` fence, the cycle, the order that would not change) needs a cabinet, and
    // a cabinet is `CollectionPage`'s story rather than this one's.
    canDropFolder: (drag: FolderDrag): boolean => drag.folderId !== BINDER.id,
    onDropFolder: fn(),
    act: fn(),
  },
  decorators: [
    // The band the page gives its drawers — wide enough for the `auto-fill` track to be a row
    // rather than a column.
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
          "A drawer in the collection's filing cabinet, drawn above the cards in both views. " +
          "**Dashed**, which across this app is a rule rather than a decoration: dashed means " +
          "provisional, and a folder is a container rather than a card you *own*. The copies " +
          "inside it are the things with a condition and a price; the drawer they are in is not " +
          "one of them, and nothing else on the collection page is dashed.\n\n" +
          "**No strip of member art**, which `WishFolderCard` decided first and this keeps for a " +
          "reason of its own: a binder is read for what is in it and what it is worth, and the " +
          "wall of card faces below is already the picture. It also makes the tile cheap — no " +
          "image query, no `useImageRetry` and no illustrator credit, because Scryfall's image " +
          "policy attaches to pictures and there are none here.\n\n" +
          "**The number it prints is the recursive total, never `collection_folder_summary`'s " +
          "row.** That row is *direct* — this folder's own copies and not its sub-folders' — so " +
          "a drawer holding two full sub-folders and nothing of its own would draw `0 cards` " +
          "over twelve. The page adds the children in with `buildFolderTree`'s own arithmetic " +
          "and hands the total here, which is why the summary answering **no row at all** for " +
          "an empty folder costs the card nothing (see Empty).\n\n" +
          "**`cards` is copies, not rows** — `sum(quantity)`, the page header's own arithmetic, " +
          "so a tile and the header can never count one folder two ways.",
      },
    },
  },
} satisfies Meta<typeof Wall>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Twelve copies and what they are worth — the face a folder card exists to show.
 *
 * The press is on the `<button>` filling the tile rather than on the `<li>` around it, and its
 * `aria-label` says in words what the second line says in figures: a screen reader gets
 * `Trade binder folder, 12 cards, $340.25`, with the app's `·` swapped for commas because a
 * middot read aloud is punctuation nobody asked for. The two spellings are built together in one
 * function, so they cannot come to disagree about what the card says.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Trade binder folder/ });
    await expect(tile).toHaveTextContent("12 cards · $340.25");
    await expect(tile).toHaveAccessibleName("Trade binder folder, 12 cards, $340.25");

    await userEvent.click(tile);
    await expect(args.onOpen).toHaveBeenCalledTimes(1);
  },
};

/**
 * A folder with nothing in it, which is the state the summary has no row for at all.
 *
 * `collection_folder_summary` answers one row per folder that holds at least one copy
 * **directly**, so a folder the reader made a minute ago is simply absent from it. The page falls
 * back to a zeroed total and the card has to draw that without complaint: an empty drawer is not
 * an error, it is where the next card goes.
 *
 * **It shows its count and no money at all.** `$0.00` on an empty drawer is a price nobody quoted,
 * which is `formatPrice`'s own rule, and an em dash beside `0 cards` would invite the reader to
 * wonder which of the nothing could not be priced.
 */
export const Empty: Story = {
  args: {
    node: node(folder({ id: 8, name: "Sealed" })),
    summary: { cards: 0, value: null },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Sealed folder/ });
    await expect(tile).toHaveTextContent("0 cards");
    // No money and no em dash: two ways of saying nothing where the card says nothing at all.
    await expect(tile).not.toHaveTextContent("·");
  },
};

/**
 * The moment before the figures land — **which is not the same picture as {@link Empty}**.
 *
 * The page draws its cabinet as soon as the folder *list* answers, and that list is one flat
 * `SELECT`; the numbers on this face come from `collection_folder_summary`, a `GROUP BY` carrying
 * a marketplace price expression, and it answers later. Across that window a missing row and an
 * unanswered read are one `Map.get` miss apart and mean opposite things — so a drawer holding 240
 * copies would draw `0 cards` and then jump. That is a wrong number rather than a spinner, and the
 * reader who glanced at the wall in that moment was told the drawer was empty.
 *
 * `null` is the page's way of saying "not counted yet" and the card draws the em dash every other
 * unanswered figure in this app draws (`Figure`'s own `query.isPending ? "—"`), with the spoken
 * half in words because a dash read aloud is punctuation. It is also what a **marketplace switch**
 * looks like: that read is keyed on the marketplace, so the first frame in the new currency has no
 * subtotals of its own and must not borrow the old one's.
 */
export const Counting: Story = {
  args: { summary: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Trade binder folder/ });
    await expect(tile).toHaveTextContent("—");
    await expect(tile).not.toHaveTextContent("0 cards");
    await expect(tile).toHaveAccessibleName("Trade binder folder, still counting");
  },
};

/**
 * A drawer full of cards this marketplace has never listed.
 *
 * The backend answers `null` rather than `0.0` for exactly this — a tile is a small number beside
 * a name with no room for the header's "n unpriced" note, so `$0.00` would read as a folder worth
 * nothing rather than as a folder nobody has quoted. An em dash is this app's answer for a price
 * it does not have, and the spoken half says "not priced" because a dash read aloud is
 * punctuation.
 *
 * A `null` price is the answer and never a reason to reach for another marketplace's: no two feeds
 * have the same holes, so the figure here is this marketplace's or it is nothing.
 */
export const Unpriced: Story = {
  args: { summary: { cards: 12, value: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Trade binder folder/ });
    await expect(tile).toHaveTextContent("12 cards · —");
    await expect(tile).toHaveAccessibleName("Trade binder folder, 12 cards, not priced");
  },
};

/**
 * A binder holding four figures, which is where a collection parts company with a wishlist.
 *
 * `plural` writes its number plainly on purpose and its own doc says a caller that reaches four
 * figures wants `count()` and its own thought about it. A binder is that caller: `1204 cards` in a
 * column of money written `$12,000.00` is the same app printing two conventions for a number.
 */
export const Thousands: Story = {
  args: { summary: { cards: 1204, value: 12_000 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /^Trade binder folder/ })).toHaveTextContent(
      "1,204 cards · $12,000.00",
    );
  },
};

/**
 * **The card _being_ the field, in the wall, beside the drawers it has to leave alone.**
 *
 * `Rename…` is answered here rather than in a strip above the wall, and this is the frame that
 * says why: the name is typed **on the line the folder's name occupies**, inside the same
 * footprint and the same dashed edge, so the two drawers beside it do not move and the track does
 * not re-flow. The ✓ and the ✕ take the corner this card gives its `⋯`, which is the one place on
 * a card a reader has already been taught to look for its controls.
 *
 * **The edge is the whole visual claim, and it needs both cards in one frame to be seen.** A
 * renaming card stays **dashed** — the thing being renamed is still a container, and this app's
 * dash means exactly that — and moves only its *colour* to `border-accent`, which is what says
 * *this tile is live*. Beside it, `Sealed` and `Standard staples` wear the same dash in
 * `border-border`. A solid edge here would be `NewFolderCard`'s vocabulary: that tile is a
 * control among containers, and this one is a container being named.
 *
 * **The figures line survives underneath**, which is the whole reason a rename is not the create
 * tile with a different label: a reader renaming *Trade binder* can still see it is the drawer
 * holding twelve cards worth $340.25, and a box that dropped the count would make them stop and
 * check they had the right one.
 *
 * On the canvas the field takes the caret as it mounts with the name selected — `FolderNameField`
 * does that, and its own page shows both shapes. Two drop targets are still registered while it is
 * open: a copy dropped on a folder whose name is being edited files perfectly well, and the mark
 * that stops the *card* being dragged from inside the field is one `data-no-drag` on its `<form>`.
 * Both are driven in `CollectionFolderCard.test.tsx`, where a drag can be made to happen.
 */
export const Renaming: Story = {
  args: {
    rename: { active: true, pending: false, onSubmit: fn(), onCancel: fn() },
    siblings: [
      { folder: folder({ id: 8, name: "Sealed" }), summary: { cards: 0, value: null } },
      { folder: folder({ id: 9, name: "Standard staples" }), summary: { cards: 18, value: 92.4 } },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wall = canvas.getByRole("list", { name: "Folders" });
    await expect([...wall.children]).toHaveLength(3);

    // The card's two buttons are *gone*, not covered — a field drawn under a name that stayed put
    // is exactly the reflow this arrangement promises not to do, and a `⋯` offering `Rename…` over
    // a name being edited is a menu about a folder in a state the page cannot answer for.
    await expect(canvas.queryByRole("button", { name: /^Trade binder folder/ })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Manage Trade binder" })).toBeNull();

    const input = canvas.getByRole("textbox", { name: "Rename Trade binder" });
    await expect(input).toHaveValue("Trade binder");
    const form = input.closest("form")!;
    await expect(form).toHaveTextContent("12 cards · $340.25");

    // The claim, both ways round. `classList.contains` per class, never `className.includes`: the
    // resting face carries `hover:border-accent`, and a substring test would report the accent on
    // a card nobody is renaming.
    const box = form.firstElementChild!;
    const resting = canvas.getByRole("button", { name: /^Sealed folder/ });
    await expect(box.classList.contains("border-dashed")).toBe(true);
    await expect(box.classList.contains("border-accent")).toBe(true);
    await expect(resting.classList.contains("border-dashed")).toBe(true);
    await expect(resting.classList.contains("border-accent")).toBe(false);
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
 * Whether an element wears one of `dropMarks.ts`'s marks.
 *
 * `classList.contains` per class, never `className.includes`: several of the classes around these
 * are `hover:` variants, and a substring test against the whole attribute passes before any state
 * has changed — a vacuous assertion that reads exactly like a real one.
 * **Not exported**: CSF indexes every named export of a story file as a story.
 */
const marked = (element: Element, mark: string) =>
  mark.split(" ").every((one) => element.classList.contains(one));

/** A copy at the root, which is where most of a collection sits and what a drawer is for. */
const LOOSE_COPY: CollectionDrag = { entryId: 7, name: "Sol Ring", folderId: null };

/**
 * The same printing as the **wall** offers it: one card and every copy the tile summed behind it.
 *
 * Three copies in two places, because that is the shape the collection's grid view actually has
 * and the shape no `CollectionDrag` can state — a tile merges every entry for a printing across
 * finishes, conditions, languages *and folders*, so it has no single `entryId` and needs a payload
 * of its own.
 */
const LOOSE_TILE: CollectionTileDrag = {
  cardId: "sol-ring",
  name: "Sol Ring",
  copies: [
    { entryId: 7, folderId: null },
    { entryId: 8, folderId: null },
    { entryId: 9, folderId: 3 },
  ],
};

/** A printing whose every copy is already in this drawer — the tile the folder refuses, and the
 *  only way to see the `some` in the page's rule doing anything. */
const FILED_TILE: CollectionTileDrag = {
  cardId: "arcane-signet",
  name: "Arcane Signet",
  copies: [
    { entryId: 11, folderId: 3 },
    { entryId: 12, folderId: 3 },
  ],
};

/**
 * Something to pick up: `collectionDraggable` rather than the library's `draggable`, so the
 * payload travels exactly as a collection row's does — **both keys at once**. A collection row is
 * a card a deck can take *and* an entry a folder can take, and the whole reason this module has a
 * key of its own is that both readers have to say yes to the same payload.
 */
function Source({ entry }: { entry: CollectionDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return collectionDraggable({
      element,
      entry: () => entry,
      card: () => ({ kind: "card", cardId: "sol-ring", name: entry.name, typeLine: "Artifact" }),
    });
  }, [entry]);
  return (
    <div
      ref={ref}
      className="inline-block w-max cursor-grab rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      {entry.name}
    </div>
  );
}

/**
 * The wall's source beside the table's: `collectionTileDraggable`, which composes the same card
 * payload with the **tile** key rather than the entry one.
 *
 * A second component rather than a prop on {@link Source}, because what the story below is about is
 * that **one target** takes both payloads without being told which is coming — a card that had to
 * be configured for a shape would be documenting the opposite.
 */
function TileSource({ tile }: { tile: CollectionTileDrag }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return collectionTileDraggable({
      element,
      tile: () => tile,
      card: () => ({ kind: "card", cardId: tile.cardId, name: tile.name, typeLine: "Artifact" }),
    });
  }, [tile]);
  return (
    <div
      ref={ref}
      className="inline-block w-max cursor-grab rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      {tile.name}
    </div>
  );
}

/**
 * The two rings, and the folder that draws neither.
 *
 * **`DROP_RING` is raised on every folder that would take the copy, not only the one under the
 * pointer**, from the moment it leaves the row — that is what tells a reader where a drag can end
 * before they have aimed anywhere. `DROP_OVER` is the second, narrower fact only the target the
 * pointer is actually over can answer, and it comes with `border-accent` so the dashed edge itself
 * says which drawer is about to take it.
 *
 * **The folder a copy is already filed in refuses it and draws no ring at all** — the same rule as
 * a deck card dropped back into its own column: a ring that led to a write which moved nothing and
 * bumped `updated_at` would be worse than no ring. `CollectionDrag.folderId` is the whole of what
 * lets a target answer that before the drop, which is why the payload carries it.
 *
 * The drag runs over the library's own code path. What it cannot reach is what `test-drag.ts`
 * records and what {@link Wall}'s scroller is about: the platform's drag preview, the pointer
 * hit-testing that decides which card a `dragover` lands on, and the clip that `DROP_MARK_ROOM`
 * buys room against — all three measure rectangles, and jsdom has no layout engine. Those stay the
 * live pass's to prove.
 */
export const DropTarget: Story = {
  render: (args) => (
    <div className="flex w-[32rem] flex-col gap-4">
      <Wall {...args} />
      <Source entry={LOOSE_COPY} />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Trade binder folder/ });
    // The ring lives on the `<li>`, which is where the page's scroller has to leave room for it.
    const item = tile.closest("li")!;

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
    await expect(args.onDropCard).not.toHaveBeenCalled();
  },
};

/**
 * The same drawer, taking the **wall's** payload instead of the table's.
 *
 * A collection tile merges every entry for one printing — across finishes, conditions, languages
 * and folders — so it has no single `entryId`, and that is precisely why the grid view registered
 * no drag at all until this shape existed. `collectionTileDragData` puts the printing and *every*
 * copy behind it under a third key, and `readCollectionDrop` is the one reader both this card and
 * the breadcrumb ask; the card itself never learns which shape it is holding.
 *
 * **`Sol Ring` has copies in two places and `Arcane Signet` is entirely in this drawer**, which is
 * what makes the page's rule visible rather than merely stated: a folder takes a tile when **at
 * least one** copy behind it is somewhere else, and the tile whose every copy is already filed here
 * draws no ring at all — the same refusal a row already gets, one grain finer. Refusing the first
 * of those instead would leave the two loose copies unreachable by the gesture, which is the whole
 * failure the `some` prevents.
 */
export const TileDropTarget: Story = {
  render: (args) => (
    <div className="flex w-[32rem] flex-col gap-4">
      <Wall {...args} />
      <div className="flex flex-wrap gap-2">
        <TileSource tile={LOOSE_TILE} />
        <TileSource tile={FILED_TILE} />
      </div>
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: /^Trade binder folder/ });
    const item = tile.closest("li")!;

    const loose = await pickUp(canvas.getByText("Sol Ring"));
    try {
      await waitFor(() => expect(marked(item, DROP_RING)).toBe(true), { timeout: DRAG_WAIT });
      await loose.over(item);
      await waitFor(() => expect(marked(tile, DROP_OVER)).toBe(true), { timeout: DRAG_WAIT });
      await loose.drop(item);
    } finally {
      // Inert after a drop — there is no drag left to end — and the fence for every path out of
      // the block above: the library keeps one global "a drag is active" flag, and a story that
      // walked away holding a tile leaves the next one unable to pick anything up.
      await loose.cancel();
    }
    // The whole payload arrives, every copy of it, discriminated as a tile — which is what the
    // page needs to write three moves rather than one.
    await expect(args.onDropCard).toHaveBeenCalledTimes(1);
    await expect(args.onDropCard).toHaveBeenCalledWith({ kind: "tile", tile: LOOSE_TILE });

    // …and the printing this drawer already holds every copy of raises nothing, and is refused on
    // the drop as well rather than merely going unadvertised. A ring leading to a write that moved
    // no row and bumped `updated_at` would be worse than no ring.
    const filed = await pickUp(canvas.getByText("Arcane Signet"));
    try {
      await waitFor(() => expect(marked(item, DROP_RING)).toBe(false), { timeout: DRAG_WAIT });
      await filed.over(item);
      await filed.drop(item);
    } finally {
      await filed.cancel();
    }
    await expect(args.onDropCard).toHaveBeenCalledTimes(1);
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

/** The drawer the story below carries, and the card itself as something to pick up. */
const OTHER_FOLDER: FolderDrag = {
  folderId: 8,
  name: "Sealed",
  parentId: null,
  scope: "collection",
};

/**
 * **A folder card is a drag source and a drop target for _folders_ as well as for copies**, and
 * this is the story to drag in rather than to read: the three landings only exist under a pointer.
 *
 * Drop `Sealed` on the **middle** of the binder and it goes *inside* it — the same gold wash a copy
 * gets, because only one thing is ever in the air and both mean "what you are holding lands in
 * here". Drop it near either **end** and a 2px line appears on that side: it lands *beside* the
 * binder, and the line is honest because a folder has a `sortOrder` a cabinet can keep. The outer
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
 * that addresses them by name. The copy's is the `<li>`; the folder's is an inner wrapper that
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
