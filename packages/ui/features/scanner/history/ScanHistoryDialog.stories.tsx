import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { ScanBatch } from "@/lib/ipc";
import { EMPTY_HISTORY, PUT_BACK_LABEL } from "./historyWords";
import { ScanHistoryDialog } from "./ScanHistoryDialog";

/**
 * The dialog open, with the button that opened it — so a close hands the caret back to something,
 * and a reader in the workbench can open it again. The page holds the same two things.
 */
function Opened({ onPutBack }: { onPutBack: (batch: ScanBatch) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2.5 py-1.5 text-sm"
      >
        History
      </button>
      <ScanHistoryDialog
        open={open}
        onPutBack={(batch) => {
          onPutBack(batch);
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const meta = {
  title: "Scanner/Scan history",
  component: ScanHistoryDialog,
  tags: ["autodocs"],
  render: (args) => <Opened onPutBack={args.onPutBack} />,
  args: { open: true, onPutBack: fn(), onDismiss: () => {}, onClose: () => {} },
  parameters: {
    // `packages/fake/`'s `scanHistory` world: `starter` with two piles filed (one at the root,
    // one into `Binder`) and one archived under a name the reader typed.
    fake: { seed: "scanHistory" },
    docs: { story: { inline: false, height: "720px" } },
  },
} satisfies Meta<typeof ScanHistoryDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three piles, newest first, the newest picked: an archived friend's binder above two filed
 * scans, each chip saying where its cards went — `Archived`, `Added to “Binder”`, `Added to
 * collection`.
 */
export const History: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan history" });
    const scans = within(dialog).getByRole("navigation", { name: "Scans" });
    const entries = await within(scans).findAllByRole("button");
    await expect(entries).toHaveLength(3);
    await expect(entries[0]).toHaveAttribute("aria-current", "true");
    await expect(entries[0]).toHaveTextContent("Bob's binder");
    await expect(entries[0]).toHaveTextContent("Archived");
    await expect(entries[1]).toHaveTextContent("Added to “Binder”");
    await expect(entries[2]).toHaveTextContent("Added to collection");
    const cards = await within(dialog).findByRole("list", { name: "Cards in Bob's binder" });
    await expect(within(cards).getAllByRole("listitem")).toHaveLength(3);
  },
};

/** Another pick: the filed pile at the root, its two printings and their finishes. */
export const PickAnother: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan history" });
    await userEvent.click(await within(dialog).findByRole("button", { name: /^Scan 1/ }));
    const cards = await within(dialog).findByRole("list", { name: "Cards in Scan 1" });
    await expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
  },
};

/** A rename, in place: Enter writes it, and the list says the new name at once. */
export const Rename: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan history" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Rename scan" }));
    const field = within(dialog).getByRole("textbox", { name: "Scan name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Friday pile{Enter}");
    await waitFor(() =>
      expect(within(dialog).getByRole("heading", { name: "Friday pile" })).toBeInTheDocument(),
    );
  },
};

/**
 * *Put back in tray* (issue #1374): the picked batch handed to the page whole, which lands its
 * lines in the tray and closes the history — the way back from a pile filed by mistake.
 */
export const PutBack: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan history" });
    await within(dialog).findByRole("list", { name: "Cards in Bob's binder" });
    await userEvent.click(within(dialog).getByRole("button", { name: PUT_BACK_LABEL }));
    await waitFor(() => expect(args.onPutBack).toHaveBeenCalledTimes(1));
    await expect(args.onPutBack).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.objectContaining({ name: "Bob's binder" }) }),
    );
  },
};

/** Delete asks first, and says the collection is not touched. */
export const DeleteQuestion: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan history" });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Delete…" }));
    const question = await canvas.findByRole("dialog", { name: "Delete this scan?" });
    await expect(question).toHaveTextContent("Your collection is not affected.");
  },
};

/** Nothing put away yet: the sentence saying which presses fill this list. */
export const Empty: Story = {
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Scan history" });
    await expect(await within(dialog).findByText(EMPTY_HISTORY)).toBeInTheDocument();
  },
};
