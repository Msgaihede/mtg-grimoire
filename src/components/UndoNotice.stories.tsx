import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { expect, within } from "storybook/test";
import { offerUndo, useBulkUndo, type UndoScope } from "@/lib/bulkUndo";
import { UndoNotice } from "./UndoNotice";

/**
 * The notice with an offer already standing, written **during render** — `CardZoomIndicator`'s
 * lever and its reason: an effect runs after the first paint, so the story would draw the empty
 * region first and grow the notice in on the way to the state it is about.
 *
 * **Only its own scope is written, and it is taken down on unmount.** The ticket store is module
 * state the workbench does not reset between stories, so a collection offer left standing here
 * would be drawn over the next Collection page story as if a write had been made there. A docs
 * page draws both stories below at once, which is why each writes a different scope rather than
 * one resetting what the other set.
 */
function Offered({ scope, id, label }: { scope: UndoScope; id: number; label: string }) {
  useState(() => offerUndo(scope, id, label));
  useEffect(() => () => useBulkUndo.getState().drop(scope, id), [scope, id]);
  return (
    <div className="flex w-[34rem] max-w-full flex-col gap-2">
      <UndoNotice scope={scope} className="empty:-mt-2" />
    </div>
  );
}

const meta = {
  title: "Primitives/UndoNotice",
  component: Offered,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="bg-bg p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The one bulk write per list that can still be taken back — an import, a bulk " +
          "**Remove from collection**, a bulk **Move to** — offered on the page that draws the " +
          "list (issue #555).\n\n" +
          "**The region is always mounted and the offer is swapped into it**, because a live " +
          "region that appears with its sentence already inside announces nothing. **Undo** " +
          "sends the ticket to `bulk_undo`, greys with `aria-disabled` while it is on its way, " +
          "and takes the offer down on either answer; a refusal is said in the page's alert " +
          "voice, because either refusal retires the ticket. The ✕ takes the offer down " +
          "without writing anything.\n\n" +
          "**One offer per list, the newest winning** — `@/lib/bulkUndo` carries why a stack " +
          "would be a button whose press is almost always refused.",
      },
    },
  },
} satisfies Meta<typeof Offered>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A bulk remove on the collection — the sentence counts entries, as the menu row that made it
 *  did. */
export const AfterABulkRemove: Story = {
  args: { scope: "collection", id: 901, label: "Removed 3 cards from your collection." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole("status", { name: "Undo" });
    await expect(region).toHaveTextContent("Removed 3 cards from your collection.");
    await expect(canvas.getByRole("button", { name: "Undo" })).not.toHaveAttribute(
      "aria-disabled",
    );
    await expect(canvas.getByRole("button", { name: "Dismiss the undo offer" })).toBeVisible();
  },
};

/** An import on the wishlist, at a width where a long folder name has to wrap the actions under
 *  the sentence rather than out of the box. */
export const AfterAnImportNarrow: Story = {
  args: {
    scope: "wishlist",
    id: 902,
    label: "Imported 40 cards into Cards to pick up at the next prerelease weekend.",
  },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
};
