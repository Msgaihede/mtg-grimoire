import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useAppStore } from "@/lib/store";
import { printing } from "../../../.storybook/fake/fixtures";
import { OracleTagsDialog } from "./OracleTagsDialog";

/**
 * **Lightning Bolt, `lea 161`** — the card the fake's oracle taxonomy has most to say about.
 *
 * `ORACLE_TAGGINGS` gives it five closed slugs (`burn`, `damage`, `removal`,
 * `removal-creature`, `spot-removal`), which is what makes it worth drawing: a card with one tag
 * shows a pill and a card with five shows a *wall* of them wrapping, which is the shape the
 * layout has to survive. Looked up by `(setCode, collectorNumber)` rather than by a pasted id,
 * so a regenerated corpus fails this file at load instead of opening the dialog onto a printing
 * the database no longer has.
 */
const BOLT = printing("lea", "161");

/**
 * The dialog opened the way the app opens one — through the store, never through a prop.
 *
 * `OracleTagsDialog` takes **no props at all**: it reads `cardOverlay` and `selectedCardId`,
 * draws nothing while the overlay is not its own, and is mounted once in `App.tsx` beside the
 * card modal rather than inside it. So a story has to open it the same way the rail's
 * `Oracle tags` row does — two store writes, in this order, because `setSelectedCardId` clears
 * `cardOverlay` on purpose (a card change is a different question and must not leave an overlay
 * standing that would quietly re-answer about the new card).
 *
 * **`useState`'s lazy initializer rather than an effect**, which is `AllPrintingsDialog.stories`'
 * answer and for its reason: an effect runs after the first paint, so the dialog would render one
 * frame closed and the play would race the open.
 */
function OracleTags({ cardId }: { cardId: string }) {
  useState(() => {
    useAppStore.getState().setSelectedCardId(cardId);
    useAppStore.getState().openCardOverlay("oracleTags");
    return null;
  });

  return (
    <>
      <div className="space-y-1 p-4">
        <p className="text-sm text-dim">
          The card modal the reader was on. This dialog opens over it and it is still here
          underneath — which is what the stacked rung is for.
        </p>
      </div>
      <OracleTagsDialog />
    </>
  );
}

const meta = {
  title: "Card/Oracle tags",
  component: OracleTags,
  tags: ["autodocs"],
  args: { cardId: BOLT.id },
  // Keyed on the card, so changing it in Controls mounts a fresh host and the initializer runs
  // again — rather than writing to a store the mounted dialog is already subscribed to.
  render: (args) => <OracleTags key={args.cardId} {...args} />,
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame, for both of the reasons that parameter
       * exists.** The scrim is `fixed inset-0`, so rendered inline every story would cover the
       * whole docs page rather than its own block; and every story here writes `useAppStore`
       * during render — the one global `.storybook/` cannot make per-story — so inline, the last
       * story to render would own `cardOverlay` for all of them.
       */
      story: { inline: false, height: "520px" },
      description: {
        component:
          "What a card *does*, in Scryfall Tagger's own vocabulary — the taxonomy a deck add is " +
          "filed by, drawn as pills over the card detail modal.\n\n" +
          "**The empty state is the component.** `oracle_tags_for_cards` answers an empty slug " +
          "list for an untagged card, for an id the corpus does not have *and* for a database " +
          "with no taxonomy in it — deliberately, because every categorising caller's response " +
          "to all three is to fall back to the type line. That is the right contract for a deck " +
          "add and the wrong one for a panel that has to say a sentence, so this dialog reads " +
          "`oracle_tags_status` beside it and lets the status row decide which of the two claims " +
          "it is entitled to make. An empty box would read as *this card has no tags*, which on " +
          "a first launch is false.\n\n" +
          "**A never-fetched taxonomy is a supported state rather than a failure** — it is what " +
          "every install is on its first launch and what a machine that cannot reach Scryfall " +
          "stays in permanently. {@link NeverFetched} is that world, through the " +
          "`oracleTagsMissing` fault, which empties the *rows* rather than making a handler " +
          "refuse.\n\n" +
          "Driven end to end by `.storybook/fake/`: `card_detail` for the name in the subtitle, " +
          "`oracle_tags_for_cards` for the slugs and `oracle_tags_status` for which sentence an " +
          "empty answer earns.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div
        // **`position: fixed` resolves against the nearest *transformed* ancestor**, not the
        // viewport — so this one line turns a window-covering dialog into a story-sized one, and
        // is what lets the surface behind it stay visible in the same frame.
        style={{ transform: "translateZ(0)" }}
        className="relative h-[30rem] overflow-hidden rounded-lg border border-border bg-bg"
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OracleTags>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A card the taxonomy knows about: five slugs, already closed over their ancestors.
 *
 * `removal-creature` and `spot-removal` are *children* of `removal` and all three are drawn —
 * the closure is what the backend stores and what a caller receives, and hiding the parents here
 * would be this dialog deciding which of a card's facts are interesting.
 */
export const Tagged: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("removal")).toBeInTheDocument();
    await expect(await canvas.findByText("spot-removal")).toBeInTheDocument();
    // The card names the panel, so three overlays opened in a row are still tellable apart.
    await expect(await canvas.findByText("Lightning Bolt")).toBeInTheDocument();
    // The empty state's sentence is about the reader's *database*, and it must not appear over a
    // wall of pills.
    await expect(canvas.queryByText(/has not been downloaded/i)).toBeNull();
  },
};

/**
 * The same card in a database that has never downloaded the taxonomy — every install's first
 * launch, and permanent for a machine that cannot reach Scryfall.
 *
 * `oracleTagsMissing` empties the tag *rows* rather than making a handler refuse, which is the
 * honest staging: nothing here has failed, and `oracle_tags_status` still resolves — every field
 * `null`, `stale: true`. That row is the whole of what tells this state from a card Tagger has
 * simply never tagged, and the two get different sentences.
 */
export const NeverFetched: Story = {
  parameters: { fake: { fault: "oracleTagsMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/has not been downloaded/i)).toBeInTheDocument();
    await expect(canvas.queryByText("removal")).toBeNull();
  },
};
