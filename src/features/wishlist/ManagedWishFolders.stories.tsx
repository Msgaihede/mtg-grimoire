import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { WishlistFolder } from "@/lib/ipc";
import { ManagedFolderNote, ManagedWishFolders } from "./ManagedWishFolders";

/**
 * The decks' managed wishlist folders (user schema v47, issue #512), as the wishlist page draws
 * them after the reader's own wall — `PinnedFolders`' shape one cabinet over: a heading, `Layers`
 * on every door, a solid border where a reader's drawer is dashed, and nothing that writes.
 */
function managed(id: number, name: string, deckId: number): WishlistFolder {
  return { id, parentId: null, name, sortOrder: 0, managedDeckId: deckId };
}

const FOLDERS = [managed(9, "Rhystic Testbed", 4), managed(10, "Kenrith Two-Drops", 2)];

const meta = {
  title: "Wishlist/Managed folders",
  component: ManagedWishFolders,
  tags: ["autodocs"],
  args: {
    folders: FOLDERS,
    // One drawer still counting and one answered, so both faces are on screen at once.
    totals: (folder) =>
      folder.id === 9 ? { wishes: 5, copies: 6, cost: 41.5, unpriced: 2 } : null,
    currency: "usd",
    openFolderId: null,
    onOpen: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ManagedWishFolders>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two decks' lists, one still counting — an em dash rather than a `0 wishes` that then jumps. */
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Managed by decks" })).toBeInTheDocument();
    const door = canvas.getByRole("button", {
      name: /^Rhystic Testbed managed wishlist, 5 wishes/,
    });
    await expect(door.querySelector("svg.lucide-layers")).not.toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Kenrith Two-Drops managed wishlist, still counting" }),
    ).toBeInTheDocument();
    await userEvent.click(door);
    await expect(args.onOpen).toHaveBeenCalledWith(9);
  },
};

/** The entry the reader is standing inside says so, with the accent edge. */
export const StandingInside: Story = {
  args: { openFolderId: 9 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: /^Rhystic Testbed managed wishlist/ }),
    ).toHaveAttribute("aria-current", "true");
  },
};

/** No managed folders — no heading over nothing. */
export const None: Story = {
  args: { folders: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("heading")).toBeNull();
  },
};

/**
 * The line a reader reads inside one: whose list this is, that it keeps itself, and the way to the
 * deck. Rendered through `render` because it is a second export of the component's file.
 */
export const NoteInside: Story = {
  render: () => <ManagedFolderNote deckName="Rhystic Testbed" onOpenDeck={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Follows the deck “Rhystic Testbed”/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Open deck" })).toBeInTheDocument();
  },
};
