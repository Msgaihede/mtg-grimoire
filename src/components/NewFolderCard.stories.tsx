import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Folder } from "lucide-react";
import { expect, fn, userEvent } from "storybook/test";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { NewFolderCard } from "./NewFolderCard";

/**
 * The wall both pages draw, at its real track — `minmax(180px,1fr)` with a `gap-2`, which is what
 * decides the tile's width and therefore whether its label has room. The `max-w-2xl` is the story
 * canvas standing in for a page column; at that width the track fits three cards, which is the
 * arrangement the height match is worth looking at in.
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
 * provider, a drop target and an `ipc` round trip into a story about a button.
 *
 * It is here because the one thing this component claims cannot be seen on a canvas holding only
 * the component: that the tile is **the same height and width as the cards it stands among**, and
 * **the one thing it is not** is dashed. Both are comparisons, so both need something to compare
 * to. The real cards have stories of their own on their own pages.
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

const meta = {
  title: "Primitives/NewFolderCard",
  component: NewFolderCard,
  tags: ["autodocs"],
  args: { onClick: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The tile that makes a folder, drawn **first in the wall of folder cards** rather than " +
          "in a row of controls beside the breadcrumb. The wishlist and the collection both draw " +
          "one.\n\n" +
          "**It is solid-bordered, and that is the whole visual claim.** A dashed edge means " +
          "*provisional — a container rather than a thing you own* everywhere in this app: a deck " +
          "folder is not a deck you can play, a wishlist folder is not a card you can buy, a " +
          "binder is not a copy you own. A button is none of those things, and dressing it in the " +
          "dash to make the wall look uniform would spend the one word the wall has for " +
          "“container” on a control. So the tile matches the folder card's *footprint* — same " +
          "track, same height, same radius, the same `hover:border-accent` so the wall answers a " +
          "pointer uniformly — and departs on the one property that carries meaning.\n\n" +
          "The content is centred where a folder card's is left-aligned, because there is no name " +
          "and no figure here and a label hugging the top-left of an otherwise empty tile reads " +
          "as a folder whose second line failed to load. `FolderPlus` is the glyph the deck " +
          "tree already presses to make a folder.\n\n" +
          "It renders an `<li>`, so a caller drops it straight into the wall's existing " +
          "`<ul aria-label=\"Folders\">`. `onClick` is handed **the button element itself**, " +
          "because both callers anchor a naming panel's focus return on the trigger.",
      },
    },
  },
} satisfies Meta<typeof NewFolderCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **A cabinet with no folders in it yet — the state every reader meets first.** With nothing
 * beside it to stretch to, the tile stands on its own intrinsic floor, which is a folder card's
 * measured **62px**. That is the case `h-full` alone cannot answer, and the reason the floor is
 * written down at all.
 */
export const AloneInAnEmptyCabinet: Story = {
  render: (args) => (
    <Wall>
      <NewFolderCard {...args} />
    </Wall>
  ),
  play: async ({ canvas, args }) => {
    const button = canvas.getByRole("button", { name: "New folder" });
    await userEvent.click(button);

    // The contract both pages depend on: the **element**, so a naming panel can hand the caret
    // back to the tile that opened it.
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await expect(args.onClick).toHaveBeenCalledWith(button);
  },
};

/**
 * **The tile where it actually lives: first in the wall, at the real `minmax(180px,1fr)` track.**
 * This is the story to look at — the height and width match is the whole footprint argument, and
 * the solid edge against two dashed ones is the whole vocabulary argument. Neither is visible on
 * a canvas holding one tile.
 *
 * The play asserts the *classes* rather than the heights: this file's plays also run under jsdom
 * (`src/stories.test.tsx`), which has no layout engine, so every `offsetHeight` there is `0` and
 * a height comparison would pass by being `0 === 0`. The pixels are the browser's job and the
 * measurements are in the component's own doc.
 */
export const FirstInTheWall: Story = {
  render: (args) => (
    <Wall>
      <NewFolderCard {...args} />
      <FolderTile name="Trade binder" face="240 cards · $1,304.00" />
      <FolderTile name="Standard staples" face="18 cards · $92.40" />
    </Wall>
  ),
  play: async ({ canvas }) => {
    const wall = canvas.getByRole("list", { name: "Folders" });
    const tiles = [...wall.children];
    await expect(tiles).toHaveLength(3);

    const make = tiles[0]?.querySelector("button");
    const folder = tiles[1]?.querySelector("button");
    await expect(make).toHaveTextContent("New folder");

    // The claim, both ways round — a folder card beside it that had *stopped* being dashed would
    // make the first assertion true for the wrong reason.
    await expect(make?.classList.contains("border-dashed")).toBe(false);
    await expect(folder?.classList.contains("border-dashed")).toBe(true);
    // And the resemblance that is deliberate: same radius, same hover.
    await expect(make?.classList.contains("rounded-xl")).toBe(true);
    await expect(make?.classList.contains("hover:border-accent")).toBe(true);
  },
};

/**
 * A caller names the level in that level's own word. The label is the **visible** text and the
 * accessible name at once (WCAG 2.5.3) — there is no `aria-label` here that could disagree with
 * what is printed.
 */
export const ALabelOfItsOwn: Story = {
  args: { label: "New binder" },
  render: (args) => (
    <Wall>
      <NewFolderCard {...args} />
      <FolderTile name="Trade binder" face="240 cards · $1,304.00" />
    </Wall>
  ),
  play: async ({ canvas, args }) => {
    const button = canvas.getByRole("button", { name: "New binder" });
    await expect(canvas.queryByRole("button", { name: "New folder" })).toBeNull();

    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledWith(button);
  },
};
