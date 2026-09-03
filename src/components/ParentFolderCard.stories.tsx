import { useRef, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Folder, FolderPlus } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { ParentFolderCard, UP_ONE_LEVEL, upCardName } from "./ParentFolderCard";

/**
 * The wall all three pages draw, at the wishlist's and the collection's real track —
 * `minmax(180px,1fr)` with a `gap-2`, which is what decides the tile's width and therefore
 * whether a long folder name has room. The `max-w-2xl` is the story canvas standing in for a page
 * column; at that width the track fits three cards, which is the arrangement the footprint match
 * is worth looking at in.
 */
function Wall({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl bg-bg p-4">
      <ul
        aria-label="Folders"
        className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
      >
        {children}
      </ul>
    </div>
  );
}

/**
 * A folder card's **footprint**, as a static stand-in — the class list copied from
 * `WishFolderCard`/`CollectionFolderCard` verbatim, minus everything that would drag a tooltip
 * provider, a drop target and an `ipc` round trip into a story about a tile.
 *
 * `NewFolderCard.stories.tsx` draws the same stand-in for the same reason, and here it carries
 * the comparison this component's whole shape rests on: the up tile is a folder card's height and
 * width, dashed like one, and differs in the two things that say what it is — the glyph, and a
 * second line reading {@link UP_ONE_LEVEL} where a folder card's says what is inside.
 */
function FolderTile({ name, face }: { name: string; face: string }) {
  return (
    <li className="relative rounded-xl">
      <button
        type="button"
        className={cn(
          "block w-full rounded-xl border border-dashed border-border p-2.5 pr-9 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2">
          <Folder className="size-3.5 flex-none text-dim" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        </span>
        <span className="mt-1 block truncate text-xs tabular-nums text-dim">{face}</span>
      </button>
    </li>
  );
}

/** `NewFolderCard`'s footprint, solid where everything else here is dashed — the tile the up
 *  tile is drawn in front of, so the wall's one vocabulary rule is visible in the same frame. */
function NewFolderTile() {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl",
          "min-h-[calc(3.75rem+2px)]",
          "border border-border p-2.5 text-center text-sm",
          "transition-colors duration-150 hover:border-accent hover:bg-surface",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <FolderPlus className="size-4 flex-none text-dim" aria-hidden="true" />
        New folder
      </button>
    </li>
  );
}

/**
 * The component takes the `<li>`'s ref because the ref belongs to whichever wrapper calls the drop
 * hooks — there are three, one per cabinet. A story calls none of them, so it makes a ref and
 * hands it over; `armed` and `over` are then the two marks, driven as args rather than by a drag.
 */
function Tile(props: Omit<Parameters<typeof ParentFolderCard>[0], "cardRef">) {
  const ref = useRef<HTMLLIElement>(null);
  return <ParentFolderCard cardRef={ref} {...props} />;
}

const meta = {
  title: "Primitives/ParentFolderCard",
  component: Tile,
  tags: ["autodocs"],
  args: { label: "Wishlist", armed: false, over: false, onOpen: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The tile that goes back **up** — the level above, drawn as a folder card among the " +
          "folder cards so that a card, or a folder, can be dropped on it (issue #283).\n\n" +
          "**The gesture it exists for was one-way before it.** A folder card only ever takes a " +
          "card *deeper*; the only target that took one back out was a breadcrumb segment, which " +
          "is one word of `text-sm` in a bar above the wall — a target a fifth the height of the " +
          "drawers beside it, that the pointer has already left.\n\n" +
          "**It is dashed, and that is the same claim every folder here makes.** A dashed edge " +
          "means *provisional: a container rather than a thing you own*, and this tile **is** a " +
          "container — the folder one level up, drawn from outside. `New folder` beside it stays " +
          "solid, so the wall still says the two things it has always said: dashed is a drawer, " +
          "solid is a button.\n\n" +
          "Its footprint is a folder card's by construction rather than by a copied number: a " +
          "`text-sm` line holding a `size-3.5` glyph and a name, `mt-1`, then a `text-xs` second " +
          "line. Where a folder card's second line is `6 wishes · $312.00`, this one says " +
          "“Up one level” — so the **name** is the destination, which is what a reader needs to " +
          "read before letting go.\n\n" +
          "It renders an `<li>`, so a caller drops it straight into the wall's existing " +
          "`<ul aria-label=\"Folders\">`, and both of its drop targets register on that one " +
          "element — the tile has a single landing, so there is no geometry to keep on a second " +
          "box.",
      },
    },
  },
} satisfies Meta<typeof Tile>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **The tile where it actually lives: first in the wall, at the real `minmax(180px,1fr)` track.**
 * This is the story to look at — the height and width match against two folder cards is the whole
 * footprint argument, and the dash it shares with them against `New folder`'s solid edge is the
 * whole vocabulary argument. Neither is visible on a canvas holding one tile.
 *
 * The play asserts the *classes* rather than the heights: this file's plays also run under jsdom
 * (`src/stories.test.tsx`), which has no layout engine, so every `offsetHeight` there is `0` and a
 * height comparison would pass by being `0 === 0`. The pixels are the browser's job and the
 * measurements are in the component's own doc.
 */
export const FirstInTheWall: Story = {
  render: (args) => (
    <Wall>
      <Tile {...args} />
      <NewFolderTile />
      <FolderTile name="Ordered" face="6 wishes · $312.00" />
      <FolderTile name="Someday" face="2 wishes" />
    </Wall>
  ),
  play: async ({ canvas, args }) => {
    const wall = canvas.getByRole("list", { name: "Folders" });
    const tiles = [...wall.children];
    await expect(tiles).toHaveLength(4);

    const up = tiles[0]?.querySelector("button");
    const make = tiles[1]?.querySelector("button");
    const folder = tiles[2]?.querySelector("button");
    await expect(up).toHaveTextContent(UP_ONE_LEVEL);
    await expect(up).toHaveTextContent("Wishlist");

    // The claim, all three ways round: the up tile wears the wall's container dash, the folder
    // beside it wears it too, and the button that makes one does not.
    await expect(up?.classList.contains("border-dashed")).toBe(true);
    await expect(folder?.classList.contains("border-dashed")).toBe(true);
    await expect(make?.classList.contains("border-dashed")).toBe(false);

    await userEvent.click(up as HTMLElement);
    await expect(args.onOpen).toHaveBeenCalledTimes(1);
  },
};

/**
 * **Deeper in, the tile is the parent folder by name** — the same word the breadcrumb above it
 * uses for that level, so the trail and the wall cannot name one destination two ways.
 *
 * The accessible name is built from both visible strings rather than replacing them (WCAG 2.5.3):
 * a tile announced as only “Ordered” would be indistinguishable from the card for that same folder
 * one level up.
 */
export const InsideASubFolder: Story = {
  args: { label: "Ordered" },
  render: (args) => (
    <Wall>
      <Tile {...args} />
      <NewFolderTile />
      <FolderTile name="Backordered" face="2 wishes · $20.00" />
    </Wall>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: upCardName("Ordered") })).toBeInTheDocument();
  },
};

/**
 * **The two drag marks, which are one vocabulary with the folder cards beside it.** `armed` is the
 * tile's own dash gone faintly gold the moment something leaves the list — that is what tells a
 * reader mid-drag where they may let go — and `over` takes that same edge to full strength beside
 * a wash, on the one under the pointer.
 *
 * **Both are drawn on the face, and that is the whole point of this story** (2026-09-03). The
 * eligible mark used to be a ring on the `<li>` around the button: a ring is a box shadow painted
 * *outside* the border box, so it stood 2px proud of the dash it was meant to agree with and a
 * reader saw two concentric outlines for one landing. A surface that already owns an edge changes
 * *that* edge instead, which makes alignment something there is no way to get wrong.
 *
 * Both marks are drawn here at once because that is the real state of the tile a reader is about
 * to drop on. One wash for both payloads: a card over this tile and a folder over it are the same
 * claim, which is what a single landing means.
 */
export const HoldingSomethingOverIt: Story = {
  args: { armed: true, over: true },
  render: (args) => (
    <Wall>
      <Tile {...args} />
      <NewFolderTile />
      <FolderTile name="Someday" face="2 wishes" />
    </Wall>
  ),
  play: async ({ canvas }) => {
    const face = canvas.getByRole("button", { name: upCardName("Wishlist") });

    // Both marks are on the face — the element carrying the dash — and nothing is drawn on the
    // `<li>` around it. Asked of the class list rather than of the class string, because a
    // substring test would pass on any class that merely contains these.
    await expect(face.classList.contains("bg-accent/15")).toBe(true);
    await expect(face.closest("li")?.classList.contains("ring-1")).toBe(false);

    // And `over` outranks `armed` on the one edge they share: `tailwind-merge` resolves a border
    // colour by argument order, so the faint `border-accent/45` is gone rather than merely
    // overpainted. This is the assertion that would go red if the two lines were ever swapped.
    await expect(face.classList.contains("border-accent")).toBe(true);
    await expect(face.classList.contains("border-accent/45")).toBe(false);
  },
};

/**
 * **A long folder name truncates rather than wrapping the tile out of the row**, and the full name
 * is a tooltip bound only while it is clipped. There is no `⋯` here — the level above is renamed,
 * moved and deleted from the wall one level up — so the name has the tile's whole width, which is
 * the width it needs most on the one tile a reader cannot scroll past.
 */
export const ALongName: Story = {
  args: { label: "Cards I mean to buy when the reprint lands" },
  render: (args) => (
    <Wall>
      <Tile {...args} />
      <FolderTile name="Someday" face="2 wishes" />
    </Wall>
  ),
  play: async ({ canvas }) => {
    const label = canvas.getByText("Cards I mean to buy when the reprint lands");
    await expect(label.classList.contains("truncate")).toBe(true);
  },
};
