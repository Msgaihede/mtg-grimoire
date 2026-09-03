import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useAppStore } from "@/lib/store";
import { printing } from "../../../.storybook/fake/fixtures";
import { CardTextDialog } from "./CardTextDialog";

/**
 * A fixture printing's id — every story on this page is addressed by one, because the store's
 * `selectedCardId` is the only thing this dialog takes.
 *
 * The lookup throws at module load rather than handing a story an id `cards` has no row for,
 * which would open the popup onto the "no longer in the card database" sentence and read as a
 * broken component.
 */
function printingId(setCode: string, collectorNumber: string): string {
  return printing(setCode, collectorNumber).id;
}

/** Lightning Bolt's Alpha printing: `layout: "normal"`, so `card_faces` is **empty** and the
 *  panel is drawn from the printing's own type line and oracle text. */
const BOLT_LEA = printingId("lea", "161");

/** Delver of Secrets, Innistrad — the corpus's `transform` fixture, whose back face carries an
 *  empty mana cost that must not draw a cost pill. */
const DELVER_ISD = printingId("isd", "51");

/**
 * The popup, opened the way the card modal's rail opens one: two store writes and nothing else
 * moves.
 *
 * **The order is load-bearing rather than incidental.** `setSelectedCardId` *clears*
 * `cardOverlay` — an overlay outliving the card under it would quietly re-answer about whichever
 * card the store moved on to — so the card has to be selected first and the overlay opened
 * second. Reversed, every story on this page would render a closed dialog.
 *
 * `useState`'s lazy initializer rather than an effect, which is `CardDetailModal.stories.tsx`'s
 * answer and for its reason: an effect runs after the first paint, so the dialog would render one
 * frame closed.
 */
function CardText({ cardId }: { cardId: string }) {
  useState(() => {
    const store = useAppStore.getState();
    store.setSelectedCardId(cardId);
    store.openCardOverlay("cardText");
  });

  return (
    <>
      {/* Not scenery: this popup is always drawn **over another dialog**, which is the whole of
          why it takes `Dialog`'s `"stacked"` rung rather than the default one. A frame with
          nothing underneath would show a modal that could just as well have been the card modal
          itself. */}
      <div className="space-y-1 p-4">
        <p className="text-sm text-dim">
          The card detail modal the rail was pressed in. It is still here underneath, and the
          popup is painted a rung above it.
        </p>
      </div>
      <CardTextDialog />
    </>
  );
}

const meta = {
  title: "Card/Card text",
  component: CardText,
  tags: ["autodocs"],
  args: { cardId: BOLT_LEA },
  // Keyed, so changing the card in Controls mounts a fresh host and the initializer runs again —
  // rather than writing to a store the mounted dialog is already subscribed to.
  render: (args) => <CardText key={args.cardId} {...args} />,
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame, and it is owed for two separate reasons.**
       *
       * The scrim is `fixed inset-0`: rendered inline, every story would cover the whole docs
       * page rather than its own block, and the last one mounted would be the only one anybody
       * could read. And both stories write `useAppStore` during render — the one global
       * `.storybook/` cannot make per-story — so inline, the last story to render would own
       * `selectedCardId` for all of them and each heading would sit over the same card.
       *
       * The height is the frame's, not a minimum: `inline: false` makes `height` the iframe's
       * actual height, so it is this file's own decorator box plus room for the chrome around it.
       */
      story: { inline: false, height: "620px" },
      description: {
        component:
          "What the card **says** — type line, rules text per face, and the rarity — one click " +
          "away from the modal that draws its picture.\n\n" +
          "**It exists because an image is not text.** The card detail modal's mockup drops " +
          "every word of this on the theory that the art carries it; art is unreachable by a " +
          "screen reader, unselectable, un-searchable, and absent altogether on a printing " +
          "whose picture has never cached. So the docked pane's `Facts` block survives here, " +
          "minus the prices — those are a fact about *this printing* and sit beside the picture " +
          "in the modal's left column, while a type line and a rules paragraph are facts about " +
          "the **card** and read the same for every printing of it.\n\n" +
          "**Both faces at once, which is the one place this differs from the block it was " +
          "lifted from.** The pane draws the side its flip control has selected, because the " +
          "picture beside it is of one side and the two have to agree. This popup has no " +
          "picture: a reader who opened *Card text* is asking what the card does, and half of a " +
          "transforming card is not an answer.\n\n" +
          "Self-mounting, like the two overlays beside it: no props, one store field " +
          "(`cardOverlay`) with one writer, drawn as an `App`-level sibling of the card modal " +
          "rather than inside its panel — a container-query context is the containing block for " +
          "its `fixed` descendants, so a scrim rendered in there would stretch to the panel " +
          "instead of the window.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div
        // **`position: fixed` resolves against the nearest *transformed* ancestor**, not the
        // viewport — so this one line turns a window-covering modal into a story-sized one, and
        // is what lets the surface behind it stay visible in the same frame.
        style={{ transform: "translateZ(0)" }}
        className="relative h-[34rem] overflow-hidden rounded-lg border border-border bg-bg"
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CardText>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A single-faced card: **`card_faces` is empty and the panel is synthesised from the printing.**
 *
 * This is the branch that carries most of the game — Scryfall sends no `card_faces` for a
 * `normal` layout, nor for a `meld` one — so a reading that trusted the array would draw an
 * empty box for nearly every card rather than an error anybody could see. The face carries no
 * name, so the card is named once, by the header's subtitle.
 */
export const Normal: Story = { args: { cardId: BOLT_LEA } };

/**
 * A `transform` card, with **both sides printed at once**.
 *
 * The pane one surface over shows one face and a Flip button; this popup shows both, and the
 * back face is the assertion: its mana cost is the empty string Scryfall sends for a transformed
 * side, which `ManaText` draws as nothing rather than as an empty cost pill.
 */
export const DoubleFaced: Story = { args: { cardId: DELVER_ISD } };
