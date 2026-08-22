import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { TheoryDiffDialog } from "./TheoryDiffDialog";

/**
 * What the plan wants and the deck has not got — **driven end to end by `.storybook/fake/`.**
 *
 * `deck_theory_diff` and `deck_theory_missing_to_wishlist` are the fake's now, so every row
 * below is *computed* from two lists of a seeded deck rather than written out: the quantity is
 * a subtraction the fake did, the price is that printing's own blob read in the finish it is
 * sold in,
 * and the spare count comes off the collection minus what the one built deck has claimed. A
 * fixture that stated those numbers would agree with itself and with nothing else.
 *
 * **Deck 4, `Rhystic Testbed`, is the deck with a plan.** Its theory list wants five things the
 * deck has not got — and pointedly does *not* want a second Sol Ring, because a card live has
 * more of is a cut the reader already made and this list runs one direction only. Deck 3's plan
 * is a copy of the deck, which is the other answer.
 *
 * **One of those five is a substitution rather than a hole**, and it is the row the filter was
 * built for: the plan names the `sld 913` Sol Ring while the deck sleeves two `c21 263` copies,
 * so the reader would still have to go and buy the art they planned — and the deck runs
 * meanwhile. That is `heldAsOtherPrinting`, and it is why `Missing` and `Different printing`
 * are two readings of one list rather than two halves of it.
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
 * The shopping list: five cards, six copies, every one of them ticked, and one line saying that
 * the other direction is deliberately absent.
 *
 * The figure strip is the caption of **what is on screen** — copies rather than rows, the cost of
 * *these* printings, and a plain count of the spare copies already in the box. That last one is
 * never subtracted from what the plan needs: `quantity` has already had the live list taken out
 * of it and `ownedSpare` has not, so netting the two would count the live list twice.
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

    // Six copies over five lines, and the footer offers all five because every row arrives
    // ticked. A line is an **exact card** — a printing in a finish; the wishes it writes are
    // pinned to that printing, which is what makes a plan for one art answerable at all.
    const copies = (await canvas.findByText("Copies to find")).closest("div")!;
    await expect(within(copies).getByText("6")).toBeVisible();
    await expect(within(copies).getByText("5 cards")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Send 5 selected to wishlist" }),
    ).toBeEnabled();
    await expect(canvas.getByText(/5 of 5 selected/)).toBeVisible();

    // The card whose live copy is in the switched-off pile, wanted all the same.
    await expect(canvas.getByText("Black Lotus")).toBeVisible();
    // The substitution, saying in words what the deck is already playing — beside a count that
    // is still the full quantity, because the count is what a press writes.
    await expect(canvas.getByText("Already played as another printing")).toBeVisible();
    // The two sentences this dialog exists to say.
    await expect(canvas.getByText(/are cuts you have already made/)).toBeVisible();
    await expect(canvas.getByText(/A card can be in both views/)).toBeVisible();
    await expect(
      canvas.getByText("TCGplayer prices as of the last card-data sync."),
    ).toBeVisible();
  },
};

/**
 * **Two readings of one list, and a row that is in neither half exclusively.**
 *
 * `Missing` is what the reader would have to find; `Different printing` is what the deck is
 * already playing as something else. Deck 4 stages exactly one of the second kind, so the counts
 * here are 5 / 4 / 1 — and the strip follows the rung, because a caption a reader cannot check
 * against the list under it is a caption they have to take on trust.
 */
export const Filtered: Story = {
  play: async ({ canvas }) => {
    // The dialog's arrival, waited out once — see `Shopping`.
    await waitFor(async () => expect(await canvas.findByText("Smuggler's Copter")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await expect(canvas.getByRole("radio", { name: "All, 5 cards" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Different printing, 1 card" }));

    // One row, at its full quantity, with the substitution said in words.
    const lines = canvas.getAllByRole("listitem");
    await expect(lines).toHaveLength(1);
    await expect(within(lines[0]).getByText("Sol Ring")).toBeVisible();
    await expect(
      within(lines[0]).getByText("Already played as another printing"),
    ).toBeVisible();

    const copies = canvas.getByText("Copies to find").closest("div")!;
    await expect(within(copies).getByText("1")).toBeVisible();
    await expect(within(copies).getByText("1 card")).toBeVisible();

    // And the other reading: everything the deck has not got in any printing, which is the
    // Sol Ring row's complement here.
    await userEvent.click(canvas.getByRole("radio", { name: "Missing, 4 cards" }));
    await expect(canvas.getAllByRole("listitem")).toHaveLength(4);
    await expect(canvas.queryByText("Sol Ring")).not.toBeInTheDocument();
    await expect(canvas.getByText("Black Lotus")).toBeVisible();
  },
};

/**
 * One row's press: the **same command** the footer presses, with that row's one key.
 *
 * It used to be `card_detail` for an oracle id and then a hand-written `wishlist_add`, with a
 * doc comment asking the next reader to keep the two writes in step. They are one write now, so
 * there is nothing to keep in step: the wish is pinned to the printing the plan names, carrying
 * its finish, and the orphan row the loop skips is skipped in the backend rather than refused
 * here.
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

/** The footer's one press over everything ticked, and the sentence it answers with. One wish per
 *  card, folding rather than duplicating, so a second press would raise lines rather than make
 *  new ones. */
export const SendAll: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText("Smuggler's Copter");

    await userEvent.click(canvas.getByRole("button", { name: "Send 5 selected to wishlist" }));

    // The dialog's arrival, waited out once — see `Shopping`. The press above is not a substitute
    // for it: `userEvent`'s own waits are timers, and the frame this needs is a `rAF`.
    await waitFor(
      async () => await expect(await canvas.findByText("Sent. 5 wishes updated.")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
  },
};

/**
 * **The gesture this surface is really for: taking a card out.** Every row arrives ticked, so
 * unticking is what a reader does to a shopping list they are not buying all of — and the button
 * counts what the press will carry rather than what the list holds.
 *
 * The Copter is two copies and the only two-copy row, which is what makes the count on the
 * button worth reading: five rows minus one is four *wishes*, not four copies.
 */
export const SendSome: Story = {
  play: async ({ canvas }) => {
    // The dialog's arrival, waited out once — see `Shopping`.
    await waitFor(async () => expect(await canvas.findByText("Smuggler's Copter")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Select 2 more Smuggler's Copter" }),
    );

    await expect(canvas.getByText(/4 of 5 selected/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Send 4 selected to wishlist" }));

    await waitFor(
      async () => await expect(await canvas.findByText("Sent. 4 wishes updated.")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
  },
};

/**
 * The two lists agree — which is an answer, and an answer is a sentence.
 *
 * Deck 3's plan is a copy of deck 3, which is not a contrived fixture: it is the state
 * `deckTheoryCopyFromLive` produces, and the only command that produces it — switching the
 * theory list *on* **moves** the deck into the plan and leaves the live list empty, so a full
 * list beside an identical full list is what asking for the copy by name gets you. A blank panel
 * here would read as a dialog that failed to load. The bulk button disables itself rather than
 * offering to send nothing, and the filter is not drawn at all: three rungs reading zero and a
 * checkbox that can never move are furniture rather than controls.
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
    await expect(
      canvas.getByRole("button", { name: "Send 0 selected to wishlist" }),
    ).toBeDisabled();
    await expect(canvas.queryByRole("radiogroup")).not.toBeInTheDocument();
  },
};

/**
 * Two cards the last sync could not price, and they are unpriced for two different reasons.
 *
 * `lea` Black Lotus is quoted in euros and in nothing else, so its `prices` blob carries no
 * `usd` key at all; the `sld` Sol Ring the plan names is a **foil-only** printing with every
 * price key null. Both are real rows rather than hand-nulled ones. Each line shows an em dash
 * rather than `$0.00`, a price nobody quoted, and the cost figure says how many copies it could
 * not count instead of rounding them to free.
 */
export const Unpriced: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText("Black Lotus");

    const cost = canvas.getByText("Cost to build (USD)").closest("div")!;
    // The dialog's arrival, waited out once — see `Shopping`.
    await waitFor(() => expect(within(cost).getByText("2 unpriced")).toBeVisible(), {
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
