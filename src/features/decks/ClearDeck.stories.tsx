import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ClearDeck } from "./ClearDeck";

/**
 * The question that empties a whole list, drawn at the foot of Deck settings.
 *
 * **It takes no deck and reaches no command** — four numbers and two callbacks, so every state
 * below is an argument rather than a seeded world. That is the same fence `DeckSettingsForm` is
 * held to and for the same reason: the write belongs to the host, so `pending` is a prop and a
 * refusal is a sentence the host draws above this one.
 *
 * The two numbers are the whole of what a story here is about. `cardCount` is the list being
 * emptied and `otherCount` is the list being left alone, and every story states them as
 * **different numbers** so that a frame with them the wrong way round is visibly wrong rather
 * than merely wrong.
 */
const meta = {
  title: "Decks/ClearDeck",
  component: ClearDeck,
  tags: ["autodocs"],
  args: {
    variant: "live",
    cardCount: 40,
    otherCount: 100,
    pending: false,
    onCancel: fn(),
    onCleared: fn(),
  },
  // The settings dialog's own panel — `w-[55rem]`, 880px — with the body's padding around it, so
  // the sentence is read at the width it ships at rather than at a width nothing draws. The rule
  // above it is `CONFIRM_BOX`'s own `border-t`, which is what makes this read as a question asked
  // *under* the form rather than as another of its rows.
  decorators: [
    (Story) => (
      <div className="w-[55rem] max-w-full rounded-xl border border-border bg-bg p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Empty a whole list in one press — the confirmation behind Deck settings' " +
          "**Clear this list…**.\n\n" +
          "**It is `ClearCategory` one scope out.** That question empties *one pile of one " +
          "list*; this one empties *every pile of one list*. Neither ever reaches the other " +
          "list, which is why both sentences say so in words and why this one names the list " +
          '**in the question itself** — "Clear the deck?" over a deck with a plan and a live ' +
          "list is the ambiguity the whole confirmation exists to close.\n\n" +
          "**The piles stay.** What the reader keeps is the arrangement they built — every " +
          "category, its name, its order and its switch — and what goes is the cardboard filed " +
          "into it. That is the difference between this and deleting the deck, and it is the " +
          "destructive sentence's second clause rather than a footnote.\n\n" +
          "**Where the copies go depends on the list, and the two arms are one ternary.** " +
          "Since schema v25 a Live row is backed by a collection row in the deck's group, so " +
          "emptying the live list files every copy the reader owns into `Recently removed`. A " +
          "theory list is a plan and holds no copies, so it promises nothing instead of " +
          "promising a folder nothing will arrive in.",
      },
    },
  },
} satisfies Meta<typeof ClearDeck>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary case: a Commander deck whose plan is finished and whose live list is forty cards
 * into being assembled. The reader is emptying what they have sleeved up; the hundred-card plan
 * beside it is what the reassurance is about.
 */
export const LiveListWithAPlan: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Clear the live list?")).toBeVisible();
    await expect(canvas.getByText(/leave the deck and the piles stay/)).toHaveTextContent(
      "Any copies you own go back to Recently removed.",
    );
    await expect(canvas.getByText("The 100 cards in the other list are untouched.")).toBeVisible();

    // The way out writes nothing, and is the button a reader reaches for by pressing the one that
    // is not the destructive one.
    await userEvent.click(canvas.getByRole("button", { name: "Keep them" }));
    await expect(args.onCancel).toHaveBeenCalled();
    await expect(args.onCleared).not.toHaveBeenCalled();
  },
};

/**
 * A deck with theory switched off, which is every deck until the reader turns it on. There is no
 * other list, so there is no sentence about one — `> 0` rather than a line reading "The 0 cards
 * in the other list are untouched", which would be a promise about a list the deck has not got.
 */
export const OnlyOneList: Story = {
  args: { cardCount: 60, otherCount: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Remove 60 cards" })).toBeVisible();
    await expect(canvas.queryByText(/in the other list are untouched/)).toBeNull();
  },
};

/**
 * The same press on the plan instead. A theory list holds no copies, so the second sentence says
 * that rather than naming a folder — `Recently removed` appears nowhere in this frame, which is
 * the half a ternary stuck on its live arm would get wrong while still reading like a sentence
 * somebody wrote.
 */
export const TheoryList: Story = {
  args: { variant: "theory", cardCount: 100, otherCount: 40 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Clear the theory list?")).toBeVisible();
    await expect(canvas.getByText(/leave the deck and the piles stay/)).toHaveTextContent(
      "A theory list holds no copies, so nothing else moves.",
    );
    await expect(canvas.queryByText(/Recently removed/)).toBeNull();
    await expect(canvas.getByText("The 40 cards in the other list are untouched.")).toBeVisible();
  },
};

/**
 * One card each side — the frame that proves the app never prints "1 cards". `plural` is passed
 * its singular rather than deriving one, so both halves of this sentence are pinned here and in
 * the suite.
 *
 * **It is also where the verbs have to agree, and this is the count at which they can fail.**
 * `plural` alone gets a caller half a sentence: it prints `1 card` correctly and the sentence
 * around it still read "The 1 card in it **leave** the deck". Both halves go through
 * {@link verb} now — `leaves`/`leave` and `is`/`are` — and `ClearCategory` was fixed in the same
 * commit, because two confirmations one press apart have to read as one voice and a verb fixed
 * on one of them is the two of them drifting. A count of one is the only frame that can catch
 * it, which is what this story is for.
 */
export const OneCardEachSide: Story = {
  args: { cardCount: 1, otherCount: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Remove 1 card" })).toBeVisible();
    // The whole sentence, not a prefix of it: `toHaveTextContent` matches a substring, so
    // "The 1 card in it leave" passes against the broken text *and* the fixed one.
    await expect(canvas.getByText(/leaves the deck/)).toHaveTextContent(
      "The 1 card in it leaves the deck and the piles stay.",
    );
  },
};

/**
 * The write in flight. The destructive button greys and **the way out does not** — `CONFIRM_CANCEL`
 * carries no `disabled:` clause at all, because declining is not a thing a busy database can
 * refuse, so a reader is never trapped in front of a question with both answers switched off.
 */
export const WriteInFlight: Story = {
  args: { pending: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Remove 40 cards" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Keep them" })).toBeEnabled();
  },
};
