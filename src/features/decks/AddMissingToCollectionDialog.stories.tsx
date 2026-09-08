import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor } from "storybook/test";
import type { DeckMissingRow, DeckQuickAddWish } from "@/lib/ipc";
import { AddMissingToCollectionDialog } from "./AddMissingToCollectionDialog";

/**
 * How long a `waitFor` will wait for one animation frame.
 *
 * The dialog fades and scales in, so its first painted frame is at `opacity: 0` — and
 * `toBeVisible` walks the ancestors, so *nothing* inside it is visible until that lands. Under
 * the suite's `MotionGlobalConfig.skipAnimations` that is one frame away rather than 260ms, but
 * it is still a frame, and `findBy*` resolves on the render before it. One wait per play: once
 * the surface has arrived, everything under it is visible in the same tick.
 */
const FRAME_WAIT = 5_000;

/** One wishlist line as `deck_quick_add_wishes` answers one. */
function wish(over: Partial<DeckQuickAddWish> = {}): DeckQuickAddWish {
  return { id: 1, quantity: 4, folderId: null, folderName: null, ...over };
}

/**
 * The ordinary row: three copies short, on no shopping list, nothing beside it but what it is.
 *
 * The card ids are the workbench corpus's own, so the art beside each name is the fake's
 * generated crop for that exact printing rather than an "Unknown card" placeholder.
 */
const BOLT: DeckMissingRow = {
  cardId: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
  name: "Lightning Bolt",
  setCode: "2x2",
  collectorNumber: "117",
  finish: null,
  short: 3,
  categories: ["Removal"],
  imageUris: null,
  wishes: [],
};

/** The row with a wishlist line behind it — exactly one, so the press takes copies off it and
 *  says which drawer they come out of before it is pressed. */
const BOROS_CHARM: DeckMissingRow = {
  cardId: "d4ddf9cc-40a7-4b4f-bb51-b08171453c9a",
  name: "Boros Charm",
  setCode: "gtc",
  collectorNumber: "148",
  finish: null,
  short: 2,
  categories: ["Burn", "Sideboard"],
  imageUris: null,
  wishes: [wish({ id: 11, quantity: 4, folderId: 3, folderName: "Buy soon" })],
};

/**
 * The ambiguous row: two wishlist lines match, so the write leaves both standing.
 *
 * Foil as well, so the frame also carries the mark that tells two lines of one printing apart —
 * the finish is half of the address a pick names.
 */
const SWORDS: DeckMissingRow = {
  cardId: "b6bafa7b-62a4-477c-b2f5-6b9d26c6cbf4",
  name: "Swords to Plowshares",
  setCode: "ema",
  collectorNumber: "32",
  finish: "foil",
  short: 2,
  categories: ["Removal"],
  imageUris: null,
  wishes: [
    wish({ id: 21, quantity: 2 }),
    wish({ id: 22, quantity: 1, folderId: 3, folderName: "Buy soon" }),
  ],
};

/**
 * The press for the copies a reader has just bought.
 *
 * **It reaches nothing** — no query, no mutation, no fake world. The plan, the two read states
 * and the write all arrive as props, which is `DeckSettingsForm`'s fence applied to a surface
 * that does have a button: every frame below is an argument rather than a seeded database, and a
 * stray query added to the component later would break these stories rather than pass them.
 *
 * The art is the workbench's own, because the ids are the corpus's own — the frames come through
 * `CardImage` and `@/lib/images`, which `.storybook/main.ts` aliases to the fake.
 */
const meta = {
  title: "Decks/AddMissingToCollectionDialog",
  component: AddMissingToCollectionDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    deckName: "Boros Burn",
    rows: [BOLT, BOROS_CHARM, SWORDS],
    loading: false,
    readError: null,
    add: {
      mutate: fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      data: undefined,
    },
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "**The third answer to a shortfall, and the only one that makes cardboard exist.** " +
          "`Pull from collection` moves copies the reader already owns; `Send missing to " +
          "wishlist` writes a shopping list; this records the ones they bought this morning, " +
          "into the deck's own collection folder.\n\n" +
          "**The reader is almost never deciding anything.** Every row arrives ticked at its " +
          "whole shortfall, so the ordinary act is one press on the footer. What the body is " +
          "*for* is the reader who bought two of the four — the stepper — and the reader who " +
          "does not want one line recorded at all — the tick.\n\n" +
          "**The wishlist half is a fact beside each row, never a question.** The write takes a " +
          "wish down only where exactly one line matches, because a deck-wide press over thirty " +
          "rows cannot ask thirty questions — so each row states which of the three shapes it " +
          "is before the press, and the one control is the footer's checkbox for the whole " +
          "batch.\n\n" +
          "**An empty plan is the ordinary answer, not a failure.** The backend leaves out a " +
          "printing that has left the card database, because that is exactly the row the write " +
          "could only refuse — so the panel says why rather than going blank.",
      },
    },
  },
} satisfies Meta<typeof AddMissingToCollectionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The whole plan: three rows, seven copies, every one of them ticked.
 *
 * The three rows are deliberately the three shapes a wish can take — none, exactly one, and two
 * that are therefore left alone — so one frame shows every sentence this dialog can draw beside a
 * row. The footer counts copies **and** cards, because the button below it can only carry one of
 * the two, and it previews the wishlist half in the same line.
 */
export const Review: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await expect(canvas.getByText(/ across /).textContent).toBe(
      "7 copies across 3 cards · 2 copies off your wishlist",
    );

    // The three wish shapes, in one frame: nothing, a folder named, and two lines left standing.
    await expect(canvas.getByText("Clears 2 copies off a wish in Buy soon")).toBeVisible();
    await expect(canvas.getByText("2 wishlist lines match — left alone")).toBeVisible();

    // One pick per row, addressed by the printing **and** the finish — the row does not exist in
    // `collection_entries` yet, so there is no id to name.
    await userEvent.click(canvas.getByRole("button", { name: "Add 7 copies to collection" }));
    await expect(args.add.mutate).toHaveBeenCalledWith({
      picks: [
        { cardId: BOLT.cardId, finish: null, quantity: 3 },
        { cardId: BOROS_CHARM.cardId, finish: null, quantity: 2 },
        { cardId: SWORDS.cardId, finish: "foil", quantity: 2 },
      ],
      clearWishes: true,
    });
  },
};

/**
 * The reader bought two of the three their deck wants — the one thing the backend cannot know,
 * and the whole reason there is a dialog rather than a press that writes outright.
 *
 * The stepper is floored at one copy and capped at the row's own shortfall, so the number on
 * screen is always inside what the write will accept: below one is a pick `collection::ZERO_ADD`
 * refuses, above it is `MORE_THAN_MISSING`.
 */
export const LoweringACount: Story = {
  args: { rows: [BOLT] },
  play: async ({ canvas, args }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await userEvent.click(
      canvas.getByRole("button", { name: "Decrease Copies of Lightning Bolt, 2X2 117" }),
    );

    await expect(canvas.getByText(/ across /).textContent).toBe("2 copies across 1 card");
    await userEvent.click(canvas.getByRole("button", { name: "Add 2 copies to collection" }));
    await expect(args.add.mutate).toHaveBeenCalledWith({
      picks: [{ cardId: BOLT.cardId, finish: null, quantity: 2 }],
      clearWishes: true,
    });
  },
};

/**
 * **Two wishlist lines match, so neither is touched — and the row says so before the press.**
 *
 * The design settled on no nested picker: a deck-wide press over thirty rows cannot ask thirty
 * questions, so the write acts only on an unambiguous answer and the dialog's job is to make what
 * *did not* happen readable rather than discovered afterwards. The sentence is a statement — no
 * live region, no destructive colour — because a reader's own shopping list is not a fault.
 *
 * Unticking the footer's checkbox takes the sentence away with it, including this one: "2
 * wishlist lines match — left alone" over a press that was never going to touch a wish is a true
 * sentence about the wrong world.
 */
export const AmbiguousWish: Story = {
  args: { rows: [SWORDS] },
  play: async ({ canvas }) => {
    await waitFor(
      async () => expect(await canvas.findByText("Swords to Plowshares")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await expect(canvas.getByText("2 wishlist lines match — left alone")).toBeVisible();
    await expect(canvas.queryByRole("alert")).toBeNull();

    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Also take these off my wishlist" }),
    );
    await expect(canvas.queryByText("2 wishlist lines match — left alone")).toBeNull();
  },
};

/**
 * The reader has unticked a line they have not actually bought.
 *
 * **The row is dimmed whole rather than emptied**, and it goes on saying what its own wishlist
 * line would do — the sentence is a fact about that entry, and blanking it would be a fourth wish
 * shape meaning "the row is off", which the dim already says in one place. The tick stays outside
 * the dimmed box, because it is the control that undoes the state.
 */
export const RowSwitchedOff: Story = {
  args: { rows: [BOLT, BOROS_CHARM] },
  play: async ({ canvas }) => {
    await waitFor(async () => expect(await canvas.findByText("Lightning Bolt")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await userEvent.click(canvas.getByRole("checkbox", { name: "Add Lightning Bolt, 2X2 117" }));

    await expect(canvas.getByText(/ across /).textContent).toBe(
      "2 copies across 1 card · 2 copies off your wishlist",
    );
    await expect(canvas.getByText("Clears 2 copies off a wish in Buy soon")).toBeVisible();
  },
};

/** The read in flight. No skeleton rows: a list that briefly draws cards it has not been given is
 *  a list a reader would start ticking. */
export const Reading: Story = {
  args: { rows: null, loading: true },
  play: async ({ canvas }) => {
    await waitFor(
      async () => expect(await canvas.findByText("Reading what this deck is short of…")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    await expect(canvas.queryByText(/Nothing here can be recorded/)).toBeNull();
  },
};

/**
 * The read refused, in the backend's own words and where the rows would have been.
 *
 * No retry button: the host re-reads the next time this opens, and every deck write in the app
 * already invalidates the key it sits under.
 */
export const ReadRefused: Story = {
  args: { rows: null, readError: "database is locked" },
  play: async ({ canvas }) => {
    await waitFor(async () => expect(await canvas.findByText("database is locked")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
    await expect(canvas.getByRole("button", { name: "Add 0 copies to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * Nothing to record — and the frame that has to work hardest, because it is the one a reader
 * reaches from a band telling them the deck is short of a dozen cards.
 *
 * Drawn as a bare blank panel it reads as a query that failed, so the panel says why the two
 * numbers are allowed to disagree: a printing that has left the card database cannot be filed at
 * all, its set, its collector number and its language being read off that row, so the plan leaves
 * it out rather than drawing a line the press could only refuse.
 */
export const NothingToRecord: Story = {
  args: { rows: [] },
  play: async ({ canvas }) => {
    await waitFor(
      async () =>
        expect(await canvas.findByText(/Nothing here can be recorded/)).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await expect(canvas.getByText(/cannot be filed at all/)).toHaveTextContent(
      "its set, its collector number and its language are read off that row",
    );
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * What the press answered, and what a refusal looks like beside it.
 *
 * The sentence is drawn **inside the panel** rather than in the editor's banner, which is behind
 * this scrim — a refusal reported somewhere the reader cannot see is a refusal they have to go
 * looking for. The success half is swapped into a live region that was mounted empty, because a
 * region that appears together with its own text announces nothing.
 */
export const Recorded: Story = {
  args: {
    rows: [],
    add: {
      mutate: fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      error: null,
      data: { copies: 7, cards: 3, wishCopies: 2 },
    },
  },
  play: async ({ canvas }) => {
    await waitFor(
      async () =>
        expect(
          await canvas.findByText(
            "Recorded 7 copies of 3 cards into Boros Burn. 2 copies off your wishlist.",
          ),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    // The empty list under it is explained rather than left looking like a failed read.
    await expect(canvas.getByText(/Nothing here can be recorded/)).toBeVisible();
  },
};
