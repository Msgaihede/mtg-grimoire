import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { finishPrice } from "@/lib/finish";
import type { TheoryDiffRow } from "@/lib/ipc";
import { registerCommands } from "../../../.storybook/fake/core";
import { printing } from "../../../.storybook/fake/fixtures";
import { TheoryDiffDialog } from "./TheoryDiffDialog";

/**
 * **The fake has no `deck_theory_diff` yet, so this file brings one.**
 *
 * `registerCommands` merges into the *active* scope's table and exists for exactly this — "a story
 * adds a command or overrides one without restating the rest", in `core.ts`'s own words. Two
 * commands are missing (`deck_theory_diff` and `deck_theory_missing_to_wishlist`) and the third
 * pair this dialog touches — `card_detail` and `wishlist_add` — the fake already answers, which is
 * why every row below is built from a **corpus printing**: a row's Wishlist press goes through the
 * real mirror into the real fake store and folds on the real grain.
 *
 * **Keyed by deck id, and that is not decoration.** A docs page mounts every story on it at once,
 * each with a world of its own, and `registerCommands` writes into whichever scope is active when
 * a decorator renders — which is this story's on the first pass and, after a re-render, may not
 * be. A per-story closure would then answer a *sibling* story's query with this story's rows. One
 * handler shared by every story, dispatching on the deck id in the call, cannot: whichever table
 * it lands in, it answers the deck it was asked about. Give a new story a new id.
 *
 * When the fake learns these two commands, this block and the decorator below come out and the
 * `DIFFS` table becomes seed data. Nothing else in the file changes.
 */
const DIFFS = new Map<number, { rows: TheoryDiffRow[]; refusal?: string }>();

function installTheoryCommands() {
  registerCommands({
    deck_theory_diff: ({ deckId }: { deckId: number }): TheoryDiffRow[] => {
      const entry = DIFFS.get(deckId);
      if (!entry) throw new Error(`no such deck: ${deckId}`);
      if (entry.refusal) throw new Error(entry.refusal);
      return entry.rows;
    },
    // Answers how many **wishes** were touched — one per oracle card, which is one per row.
    deck_theory_missing_to_wishlist: ({ deckId }: { deckId: number }): number =>
      DIFFS.get(deckId)?.rows.length ?? 0,
  });
}

/**
 * One diff row off a corpus printing.
 *
 * The printing decides the id, the name, the set, the number and the price — `unitPriceUsd` is the
 * **nonfoil** `usd` key of that printing's own `prices` blob, which is the rule `deck_theory.rs`
 * states and `cards.price_usd` (a display fallback chain) violates. Only `quantity`,
 * `categoryName` and `ownedSpare` are the story's to choose, because only those are facts about a
 * deck rather than about a card.
 */
function diffRow(
  setCode: string,
  collectorNumber: string,
  over: Partial<TheoryDiffRow> = {},
): TheoryDiffRow {
  const card = printing(setCode, collectorNumber);
  return {
    cardId: card.id,
    name: card.name,
    categoryName: "Main deck",
    quantity: 1,
    unitPriceUsd: finishPrice(card.prices, "nonfoil"),
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    ownedSpare: 0,
    ...over,
  };
}

/** A shopping list with a shape worth reading: three piles, a card the box already has a spare of,
 *  and a range of prices wide enough that the cost figure is doing real work. */
const SHOPPING: TheoryDiffRow[] = [
  diffRow("lea", "161", { categoryName: "Removal", quantity: 2 }),
  diffRow("nph", "57", { categoryName: "Removal", quantity: 1, ownedSpare: 3 }),
  diffRow("mh2", "267", { categoryName: "Interaction", quantity: 2 }),
  diffRow("isd", "51", { categoryName: "Creatures", quantity: 4 }),
  diffRow("fut", "153", { categoryName: "Creatures", quantity: 2, ownedSpare: 1 }),
  diffRow("mh2", "138", { categoryName: "Creatures", quantity: 3 }),
  diffRow("mp2", "8", { categoryName: "Creatures", quantity: 1 }),
  diffRow("mh2", "259", { categoryName: "Lands", quantity: 1 }),
];

const meta = {
  title: "Decks/TheoryDiffDialog",
  component: TheoryDiffDialog,
  args: { open: true, onDismiss: fn(), onClose: fn() },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
  },
  decorators: [
    // Render-phase, not an effect: `FakeWorld`'s `useMemo` has just installed and activated this
    // story's scope, and the dialog's query fires on mount — an effect would run after the first
    // fetch had already failed against a table with no handler in it.
    (Story) => {
      installTheoryCommands();
      return <Story />;
    },
  ],
} satisfies Meta<typeof TheoryDiffDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

DIFFS.set(1, { rows: SHOPPING });
/**
 * What the plan is short of: eight cards, sixteen copies, and one line saying that the other
 * direction is deliberately absent.
 *
 * The figure strip is the caption — copies rather than rows, the cost of *these* printings, and a
 * plain count of the spare copies already in the box. That last one is never subtracted from what
 * the plan needs: `quantity` has already had the live list taken out of it and `ownedSpare` has
 * not, so netting the two counts the live list twice.
 */
export const Shopping: Story = {
  args: { deckId: 1 },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Lightning Bolt")).toBeVisible();
    // Sixteen copies over eight cards, and the footer offers the eight — which is what the backend
    // answers with, one wish per oracle card.
    const copies = (await canvas.findByText("Copies to find")).closest("div")!;
    await expect(within(copies).getByText("16")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send all 8 to wishlist" })).toBeEnabled();
    // The sentence this dialog exists to say.
    await expect(canvas.getByText(/are cuts you have already made/)).toBeVisible();
    await expect(canvas.getByText("Prices as of the last card-data sync.")).toBeVisible();
  },
};

DIFFS.set(2, { rows: SHOPPING });
/**
 * One row's press: an **any-printing** wish of that row's own quantity, written through the real
 * `card_detail` → `wishlist_add` pair into the fake's store.
 *
 * The same shape the footer's button writes, and that is the point of the round trip: the wishlist
 * grain is `(oracle_id, card_id, preferred_finish)`, so a wish pinned to this printing would be a
 * *different row* from the one "Send all" makes — and a reader who used the row buttons would end
 * up with a wishlist nobody else could reproduce.
 */
export const WishlistOneRow: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    const bolt = (await canvas.findByText("Lightning Bolt")).closest("li")!;
    const button = within(bolt).getByRole("button", { name: /Wishlist 2 more Lightning Bolt/ });

    await userEvent.click(button);

    // The verb keeps its name through the flow, and the press cannot be repeated into a second
    // announcement of one write.
    await waitFor(async () => {
      await expect(button).toHaveTextContent("Wishlisted");
    });
    await expect(button).toBeDisabled();
    // Every other row is untouched: this is a per-row action, not a bulk one wearing a row's
    // clothes.
    const dismember = (await canvas.findByText("Dismember")).closest("li")!;
    await expect(within(dismember).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
      "Wishlist",
    );
  },
};

DIFFS.set(3, { rows: SHOPPING });
/** The footer's one press, and the sentence it answers with. One wish per card, folding rather
 *  than duplicating, so a second press would raise lines rather than make new ones. */
export const SendAll: Story = {
  args: { deckId: 3 },
  play: async ({ canvas }) => {
    await canvas.findByText("Lightning Bolt");

    await userEvent.click(canvas.getByRole("button", { name: "Send all 8 to wishlist" }));

    await expect(await canvas.findByText("Sent. 8 wishes updated.")).toBeVisible();
  },
};

DIFFS.set(4, { rows: [] });
/**
 * The two lists agree — which is an answer, and an answer is a sentence.
 *
 * A blank panel here would read as a dialog that failed to load. The bulk button disables itself
 * rather than offering to send nothing.
 */
export const Agreed: Story = {
  args: { deckId: 4 },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/The two lists agree/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send all 0 to wishlist" })).toBeDisabled();
  },
};

DIFFS.set(5, {
  rows: [
    diffRow("lea", "161", { categoryName: "Removal", quantity: 2 }),
    // A **deliberate data fault**, and the only field in this file written over a printing's own
    // answer: a printing whose `prices` blob carries no `usd` key. The corpus has none — every one
    // of its 43 rows is priced — and the case is worth a story, because a total that silently
    // omits a card is a number that lies by rounding down.
    diffRow("dom", "168", { categoryName: "Creatures", quantity: 1, unitPriceUsd: null }),
  ],
});
/** A card the last sync could not price. The line shows an em dash rather than `$0.00` — a price
 *  nobody quoted — and the cost figure says how many copies it could not count. */
export const Unpriced: Story = {
  args: { deckId: 5 },
  play: async ({ canvas }) => {
    await canvas.findByText("Llanowar Elves");

    const cost = canvas.getByText("Cost to build").closest("div")!;
    await expect(within(cost).getByText("1 unpriced")).toBeVisible();
  },
};

DIFFS.set(6, { rows: [], refusal: "the database is busy; try again" });
/** A refused read, in the backend's own words, where the rows would have been. No retry button:
 *  the query re-runs the next time the dialog opens, and every deck write invalidates its key. */
export const Refused: Story = {
  args: { deckId: 6 },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("the database is busy; try again")).toBeVisible();
    // The footer still says what the list is and is not. A refusal is not a reason to stop
    // explaining the surface.
    await expect(canvas.getByText(/are cuts you have already made/)).toBeVisible();
  },
};
