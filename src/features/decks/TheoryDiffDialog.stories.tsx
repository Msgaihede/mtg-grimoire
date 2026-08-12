import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { TheoryDiffDialog } from "./TheoryDiffDialog";

/**
 * What the plan wants and the deck has not got — **driven end to end by `.storybook/fake/`.**
 *
 * `deck_theory_diff` and `deck_theory_missing_to_wishlist` are the fake's now, so every row
 * below is *computed* from two lists of a seeded deck rather than written out: the quantity is
 * a subtraction the fake did, the price is the nonfoil `usd` key of that printing's own blob,
 * and the spare count comes off the collection minus what the one built deck has claimed. A
 * fixture that stated those numbers would agree with itself and with nothing else.
 *
 * **Deck 4, `Rhystic Testbed`, is the deck with a plan.** Its theory list wants four things the
 * deck has not got — and pointedly does *not* want the second Sol Ring the deck is carrying,
 * because a card live has more of is a cut the reader already made and this list runs one
 * direction only. Deck 3's plan is a copy of the deck, which is the other answer.
 */
/** How long a `waitFor` will wait for one animation frame. See `Shopping`'s play for why that
 *  is measured in seconds rather than milliseconds. */
const FRAME_WAIT = 5_000;

const meta = {
  title: "Decks/TheoryDiffDialog",
  component: TheoryDiffDialog,
  args: { open: true, deckId: 4, onDismiss: fn(), onClose: fn() },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
  },
} satisfies Meta<typeof TheoryDiffDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shopping list: four cards, five copies, and one line saying that the other direction is
 * deliberately absent.
 *
 * The figure strip is the caption — copies rather than rows, the cost of *these* printings, and
 * a plain count of the spare copies already in the box. That last one is never subtracted from
 * what the plan needs: `quantity` has already had the live list taken out of it and `ownedSpare`
 * has not, so netting the two would count the live list twice.
 *
 * **Black Lotus is on this list while a copy of it sits in the deck**, and that is the fixture's
 * sharpest point rather than an error: the copy is filed in the switched-off "Cut list", and an
 * inactive category is excluded from *both* sides of the comparison. A card parked in a pile the
 * reader turned off is neither wanted nor owned for this purpose.
 */
export const Shopping: Story = {
  play: async ({ canvas }) => {
    // **`waitFor`, and every `toBeVisible` on this page needs the same first step.** The dialog
    // fades and scales in, so its first painted frame is at `opacity: 0` — and `toBeVisible`
    // walks the ancestors, so *nothing* inside it is visible until that lands. Under the
    // suite's `MotionGlobalConfig.skipAnimations` that is one frame away rather than 260ms, but
    // it is still a frame, and `findBy*` resolves on the render before it. One wait per play:
    // once the surface has arrived, everything under it is visible in the same tick.
    //
    // The timeout is generous on purpose. What is being waited for is a `requestAnimationFrame`
    // — jsdom has no compositor, so `motion` drives its own loop off one — and the whole suite
    // is 91 files of jsdom in parallel. The default second is a wait on the *scheduler*, and it
    // flaked once at that length while passing the same play in isolation every time.
    await waitFor(async () => expect(await canvas.findByText("Smuggler's Copter")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    // Five copies over four cards, and the footer offers the four — one wish per oracle card,
    // which is what the backend answers with.
    const copies = (await canvas.findByText("Copies to find")).closest("div")!;
    await expect(within(copies).getByText("5")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send all 4 to wishlist" })).toBeEnabled();

    // The card whose live copy is in the switched-off pile, wanted all the same.
    await expect(canvas.getByText("Black Lotus")).toBeVisible();
    // The sentence this dialog exists to say.
    await expect(canvas.getByText(/are cuts you have already made/)).toBeVisible();
    await expect(
      canvas.getByText("TCGplayer prices as of the last card-data sync."),
    ).toBeVisible();
  },
};

/**
 * One row's press: an **any-printing** wish of that row's own quantity, written through the real
 * `card_detail` → `wishlist_add` pair into the fake's store.
 *
 * The same shape the footer's button writes, and that is the point of the round trip: the
 * wishlist grain is `(oracle_id, card_id, preferred_finish)`, so a wish pinned to this printing
 * would be a *different row* from the one "Send all" makes — and a reader who used the row
 * buttons would end up with a wishlist nobody else could reproduce.
 */
export const WishlistOneRow: Story = {
  play: async ({ canvas }) => {
    const copter = (await canvas.findByText("Smuggler's Copter")).closest("li")!;
    const button = within(copter).getByRole("button", {
      name: /Wishlist 2 more Smuggler's Copter/,
    });

    await userEvent.click(button);

    // The verb keeps its name through the flow, and the press cannot be repeated into a second
    // announcement of one write.
    await waitFor(async () => {
      await expect(button).toHaveTextContent("Wishlisted");
    });
    await expect(button).toBeDisabled();
    // Every other row is untouched: this is a per-row action, not a bulk one wearing a row's
    // clothes.
    const jace = (await canvas.findByText("Jace, the Mind Sculptor")).closest("li")!;
    await expect(within(jace).getByRole("button", { name: /Wishlist/ })).toHaveTextContent(
      "Wishlist",
    );
  },
};

/** The footer's one press, and the sentence it answers with. One wish per card, folding rather
 *  than duplicating, so a second press would raise lines rather than make new ones. */
export const SendAll: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText("Smuggler's Copter");

    await userEvent.click(canvas.getByRole("button", { name: "Send all 4 to wishlist" }));

    await expect(await canvas.findByText("Sent. 4 wishes updated.")).toBeVisible();
  },
};

/**
 * The two lists agree — which is an answer, and an answer is a sentence.
 *
 * Deck 3's plan is a copy of deck 3, which is not a contrived fixture: it is the state switching
 * the theory list *on* produces, because an empty plan beside a full deck reads as data loss and
 * the backend seeds one rather than leaving it blank. A blank panel here would read as a dialog
 * that failed to load. The bulk button disables itself rather than offering to send nothing.
 */
export const Agreed: Story = {
  args: { deckId: 3 },
  play: async ({ canvas }) => {
    // The dialog's arrival, waited out once — see `Shopping`.
    await waitFor(
      async () => expect(await canvas.findByText(/The two lists agree/)).toBeVisible(),
      {
        timeout: FRAME_WAIT,
      },
    );
    await expect(canvas.getByRole("button", { name: "Send all 0 to wishlist" })).toBeDisabled();
  },
};

/**
 * A card the last sync could not price.
 *
 * `lea` Black Lotus is the corpus's one such printing — quoted in euros and in nothing else, so
 * its `prices` blob carries no `usd` key at all — which makes it a real row rather than a
 * hand-nulled one. The line shows an em dash rather than `$0.00`, a price nobody quoted, and the
 * cost figure says how many copies it could not count instead of rounding them to free.
 */
export const Unpriced: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText("Black Lotus");

    const cost = canvas.getByText("Cost to build (USD)").closest("div")!;
    // The dialog's arrival, waited out once — see `Shopping`.
    await waitFor(() => expect(within(cost).getByText("1 unpriced")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
  },
};

/**
 * A refused read, in the backend's own words, where the rows would have been.
 *
 * `deckMeta` is the fault for the reads a deck screen makes *beside* the deck — its categories,
 * its tags, the folder tree, its history and this. The deck itself read fine, which is why there
 * is a dialog open over it at all. No retry button: the query re-runs the next time the dialog
 * opens, and every deck write invalidates its key.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvas }) => {
    // The dialog's arrival, waited out once — see `Shopping`.
    await waitFor(
      async () =>
        expect(
          await canvas.findByText("the theory list could not be read: database is locked"),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    // The footer still says what the list is and is not. A refusal is not a reason to stop
    // explaining the surface.
    await expect(canvas.getByText(/are cuts you have already made/)).toBeVisible();
  },
};
