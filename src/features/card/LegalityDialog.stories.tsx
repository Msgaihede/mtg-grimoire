import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { registerCommands } from "../../../.storybook/fake/core";
import { printing } from "../../../.storybook/fake/fixtures";
import { activeScope } from "../../../.storybook/fake/scope";
import type { CardDetail } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { LegalityDialog } from "./LegalityDialog";

/**
 * **Ancestral Recall, `lea 47`** — a printing whose blob carries all four statuses at once:
 * `restricted` in Vintage and Old School, `banned` in the eternal and singleton formats, `legal`
 * in Tiny Leaders: Reborn, and `not_legal` everywhere else. `.storybook/fake/cards.ts` says so at
 * its own row and is the thing to re-read if this page ever stops showing four badges — the
 * corpus is generated from a sync and no count of it is written down here.
 *
 * A card, not a fixture: no story here seeds `cards`, so what the grid draws is what the shipped
 * `card_detail` would answer for a real Alpha Ancestral. The lookup throws at module load rather
 * than handing this page an id the corpus has no row for.
 */
const ANCESTRAL_RECALL = printing("lea", "47").id;

/**
 * The dialog, opened the way the app opens it — through the store's two writers, in the order
 * the store requires.
 *
 * `setSelectedCardId` **clears** `cardOverlay` (an overlay outliving the card under it would be
 * a legality grid for a card nobody has open), so the card goes first and the overlay second.
 * Both are written in a lazy `useState` initializer rather than an effect, which is
 * `CardDetailModal.stories.tsx`'s answer and for its reason: an effect runs after the first
 * paint, so the story would draw one frame of a closed dialog before it opened.
 */
function Host({ cardId, blankLegalities }: { cardId: string; blankLegalities: boolean }) {
  useState(() => {
    // A card the corpus holds no legality blob for at all — a state the fixture set cannot
    // produce, because every generated row carries Scryfall's 23 keys.
    //
    // **The override wraps this world's own handler rather than inventing a `CardDetail`.**
    // Hand-building one would be a second copy of a DTO `src/lib/ipc.ts` already mirrors by
    // hand, which is exactly what the fake sitting *under* `ipc.ts` exists to keep honest — and
    // it would go on rendering after a field was added to the struct and never filled here.
    // `activeScope()` is read inside this initializer rather than at import, so it is the scope
    // the decorator activated for *this* story.
    if (blankLegalities) {
      const answer = activeScope().commands.card_detail as (args: {
        id: string;
        marketplace?: string;
      }) => CardDetail | null;
      registerCommands({
        card_detail: (args: { id: string; marketplace?: string }) => {
          const card = answer(args);
          return card === null ? null : { ...card, legalities: null };
        },
      });
    }
    const store = useAppStore.getState();
    store.setSelectedCardId(cardId);
    store.openCardOverlay("legality");
  });

  return <LegalityDialog />;
}

const meta = {
  title: "Card/Legality",
  component: Host,
  tags: ["autodocs"],
  args: { cardId: ANCESTRAL_RECALL, blankLegalities: false },
  // Keyed, so changing the card in Controls mounts a fresh host and the initializer above runs
  // again rather than writing to a store the mounted dialog is already subscribed to.
  render: (args) => <Host key={`${args.cardId}:${args.blankLegalities}`} {...args} />,
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore`. Every story here writes `selectedCardId` and `cardOverlay` during
       * render, and the store is a module singleton `.storybook/` cannot make per-story — inline,
       * a docs page mounts every story at once and the last to render owns the store for all of
       * them.
       */
      story: { inline: false, height: "620px" },
      description: {
        component:
          "Where a card may be played — **every** format, including the ones it may not.\n\n" +
          "This is the one legality surface in the app that does not go through " +
          "`legalityChips`. That helper drops every `not_legal` key before anything is drawn — a " +
          "card kept 11.3 of 23 on average, measured over the dev corpus on 2026-08-20 — and " +
          "the docked card pane compensated with a " +
          "caption reading *Formats not listed are not legal*. Absence is not an answer to the " +
          "question this popup exists for, so it reads `cards.legalities` directly and draws " +
          "the missing rows in a recessed badge.\n\n" +
          "**Never colour alone.** Each badge carries the word, because a reader who cannot " +
          "tell the green from the red still needs the answer. `restricted` keeps full-strength " +
          "text against `not_legal`'s dim: it is not a milder ban, it is a card you may play " +
          "*one* of.\n\n" +
          "Format **order** is `FORMAT_ORDER`, Scryfall's own emission order; a key it has " +
          "never heard of ranks last and is still drawn, because Scryfall adds formats without " +
          "asking and a format a reader plays, silently missing, reads as data that failed to " +
          "load. Format **names** are this module's own — `FORMAT_LABEL` names the nine that " +
          "are not their key with a capital letter, and the rule handles the rest. Not " +
          "`format_specs`, and the reason is visible on this very page: the fake serves that " +
          "table from `validation/fixtures.ts`, which carries 12 of the 25 seeded rows, so a " +
          "grid drawing 23 formats through it would show eleven **slugs** here.\n\n" +
          "**No footer.** The mockup's *Commander Game Changer* and *Canadian Highlander: 3 " +
          "points* lines are both out of scope (spec §3.1): `CardDetail` carries no " +
          "`gameChanger`, and Canadian Highlander points exist in no data source this app has.",
      },
    },
  },
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * All four statuses on one card.
 *
 * Ancestral Recall is staged because it reaches every one of them: a page built on an ordinary
 * card would show `legal` and `not_legal` and leave the two treatments that actually need
 * checking — the destructive red and the full-strength `restricted` — undrawn.
 */
export const Legality: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The four words, not the four colours — which is the claim the surface is built on and the
    // only one a screenshot could not check.
    await expect(await canvas.findByText("Vintage")).toBeInTheDocument();
    const vintage = canvas.getByText("Vintage").closest("li") as HTMLElement;
    await expect(within(vintage).getByText("Restricted")).toBeInTheDocument();
    const commander = canvas.getByText("Commander").closest("li") as HTMLElement;
    await expect(within(commander).getByText("Banned")).toBeInTheDocument();
    const tlr = canvas.getByText("Tiny Leaders: Reborn").closest("li") as HTMLElement;
    await expect(within(tlr).getByText("Legal")).toBeInTheDocument();
    // The row `legalityChips` would have dropped.
    const standard = canvas.getByText("Standard").closest("li") as HTMLElement;
    await expect(within(standard).getByText("Not legal")).toBeInTheDocument();
  },
};

/**
 * A card the corpus holds no legality blob for.
 *
 * **Not the same as "legal nowhere"**, which is 23 `not_legal` rows and draws in full. This is a
 * token, an art card or a row whose JSON did not parse — and the sentence is the only thing that
 * tells it from a grid that failed to render.
 */
export const NoLegalityData: Story = {
  args: { blankLegalities: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/lists no formats/i)).toBeInTheDocument();
  },
};
