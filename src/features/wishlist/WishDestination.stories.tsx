import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useWishDestinationName, WishDestination } from "./WishDestination";

/**
 * The control as a call site holds it, **with the sentence it makes underneath**.
 *
 * `folderId` belongs to the caller — it is `TheoryDiffDialog`'s and `DeckStats`' own state — so a
 * press has to travel out through `onChange` and back in as a prop before anything on screen
 * moves, which is the contract worth showing rather than describing.
 *
 * The line below it is {@link useWishDestinationName}'s whole job, written exactly as a call site
 * writes it. It is here because the hook is the half of this module that has no picture: `null` at
 * the root and the folder's *name* — never its path — otherwise, so `Sent. 4 wishes updated in
 * Backordered.` reads as a sentence and not as a file path.
 */
function Destination({ start, label }: { start: number | null; label: string }) {
  const [folderId, setFolderId] = useState<number | null>(start);
  const name = useWishDestinationName(folderId);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-dim">Send to</span>
        <WishDestination folderId={folderId} onChange={setFolderId} label={label} />
      </div>
      <p className="text-xs text-dim">
        {name === null ? "Sent. 4 wishes updated." : `Sent. 4 wishes updated in ${name}.`}
      </p>
    </div>
  );
}

const meta = {
  title: "Wishlist/Destination",
  component: Destination,
  tags: ["autodocs"],
  args: { start: null, label: "Wishlist folder to send to" },
  // `folderId` is this harness's own `useState`, so an arg change has to remount to be seen.
  render: (args) => <Destination key={String(args.start)} {...args} />,
  decorators: [
    // A dialog footer's row, and room under it for the panel to open into — this control's first
    // two call sites are footers, which is the one place in a window where a popup usually has
    // nowhere below to go.
    (Story) => (
      <div className="w-[420px] p-6">
        <Story />
      </div>
    ),
  ],
  parameters: {
    // **A frame per docs story, for `Dialog.stories.tsx`'s reason.** The new-folder panel is drawn
    // inside a zero-size `fixed` box so that `usePopupPlacement` can subtract whatever containing
    // block it landed in; rendered inline, that box is positioned against the *docs page* rather
    // than against the story's own block, and a page scroll — which is how a reader moves through
    // a docs page — closes the panel out from under them. An iframe is the viewport the fixed
    // positioning is then relative to.
    docs: { story: { inline: false, height: "420px" } },
  },
} satisfies Meta<typeof Destination>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded cabinet: `Ordered` with `Backordered` inside it, and `Someday` beside them.
 *
 * **Every folder is a row of its own, by full path.** A `DropdownOption` is a flat row carrying
 * one `label`, so a nested drawer drawn by bare name would be indistinguishable from a sibling
 * that happened to share it — the path is what tells them apart, and it is why the second row here
 * reads `Ordered / Backordered` rather than an indented `Backordered`.
 */
export const Nested: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Wishlist folder to send to" }));

    // The root wears `Heart` and the word `cardMenu.tsx` already uses for this same offer: the
    // root is the list itself rather than a drawer in it.
    await canvas.findByRole("option", { name: "Wishlist" });
    await canvas.findByRole("option", { name: "Ordered / Backordered" });

    await userEvent.click(canvas.getByRole("option", { name: "Ordered / Backordered" }));
    // And the sentence names the drawer, not the path.
    await waitFor(() =>
      expect(canvas.getByText("Sent. 4 wishes updated in Backordered.")).toBeInTheDocument(),
    );
  },
};

/**
 * A reader who has never made a folder — **and the list is still drawn.**
 *
 * That is a deliberate departure from `cardMenu.tsx`'s rule for the same offer, where with no
 * folders it collapses to a single action. The difference is where the reader is standing: a card
 * menu is opened on a page with its own route to making a folder, while here making one *without
 * leaving the dialog* is the whole feature — so a control that hid itself until a folder existed
 * could never be used to make the first one.
 */
export const NoFolders: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Wishlist folder to send to" }));

    await waitFor(() => expect(canvas.getAllByRole("option")).toHaveLength(2));
    await canvas.findByRole("option", { name: "Wishlist" });
    await canvas.findByRole("option", { name: "New folder…" });
  },
};

/**
 * `New folder…`, open.
 *
 * The trailing ellipsis is this app's mark for a row that opens a surface rather than making a
 * write, and what it opens is a name and a parent — because a cabinet with levels in it makes
 * "make a folder" an incomplete instruction. The parent picker is `MoveToFolder` in its `inline`
 * shape, which is `EditWish`'s composition: one layer, one Escape rung, one decision.
 */
export const NewFolder: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Wishlist folder to send to" }));
    await userEvent.click(await canvas.findByRole("option", { name: "New folder…" }));

    // The caret goes to the name, because typing one is the first thing there is to do —
    // asserted before anything is typed, since typing would focus the field itself.
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Name" })).toHaveFocus());
    await canvas.findByRole("group", { name: "Where the new folder goes" });
    await userEvent.keyboard("Draft night");
  },
};

/**
 * The write refused, and reported in words.
 *
 * `busy` is a **write** lock — the folder list still reads, so the cabinet behind the panel is
 * intact and only the press fails. What matters here is what does *not* happen: the panel stays up
 * holding the name the reader typed, and the destination above it is left exactly as it was. A
 * press that failed must not look like a press that worked.
 */
export const CreateRefused: Story = {
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Wishlist folder to send to" }));
    await userEvent.click(await canvas.findByRole("option", { name: "New folder…" }));

    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Name" })).toHaveFocus());
    await userEvent.keyboard("Draft night");
    await userEvent.click(canvas.getByRole("button", { name: "Create folder" }));

    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent("Could not make the folder"),
    );
    expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue("Draft night");
    expect(canvas.getByRole("button", { name: "Wishlist folder to send to" })).toHaveTextContent(
      "Wishlist",
    );
  },
};
