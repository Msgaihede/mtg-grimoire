import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { EditCopy, type EditCopyTarget } from "./EditCopy";

/**
 * The seed's most-detailed row, addressed by its real id so the Save button really writes.
 *
 * `.storybook/fake/seeds.ts`' second starter entry: an Alpha Lightning Bolt at Heavily Played,
 * bought from Card Kingdom for $450 in 2021, filed in `Binder`. It is the fixture with the whole
 * acquisition story on it, which makes it the one row in the seed that can show **both** of this
 * dialog's fields holding something.
 */
const RECORDED: EditCopyTarget = {
  entryId: 2,
  cardName: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  finish: "nonfoil",
  condition: "HP",
  purchasePrice: 450,
  purchaseCurrency: "USD",
  folderName: "Binder",
};

const meta = {
  title: "Collection/Edit copy",
  component: EditCopy,
  tags: ["autodocs"],
  args: {
    target: RECORDED,
    currency: "usd",
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: {
    // **Its own frame per docs story**, `Decks/Settings dialog`'s parameter and for its reason:
    // the scrim is `fixed inset-0`, so rendered inline every story on this page would cover the
    // whole page rather than its own block and the last one mounted would be the only one
    // readable. `inline: false` gives each an iframe to be fixed against.
    docs: {
      story: { inline: false, height: "460px" },
      description: {
        component:
          "Correcting one copy the reader already owns — its **grade** and what they **paid**. " +
          "It is `ipc.collectionUpdate`'s first caller in the app: the command and " +
          "`collection::update_entry` behind it have existed since the v1 rung with only " +
          "`ipc.test.ts` exercising them, so until now a copy recorded wrong was a copy the " +
          "reader had to delete and add again — losing its tags, notes and acquisition story to " +
          "fix a two-letter grade.\n\n" +
          "**Two fields and no more.** Quantity is the table's own stepper, filing is `Move to`, " +
          "and the acquisition columns have no surface asking for them yet — a form with eight " +
          "boxes in it is a data-entry screen rather than a correction.\n\n" +
          "**A price can be corrected and never removed, and the dialog says so.** `EntryPatch` " +
          "is `coalesce(?n, column)` for every column it can write, so an absent field " +
          "means *leave it* and there is no value that means *make it null* — a bound NULL reads " +
          "as unchanged. So the box is seeded with the recorded price, emptying it writes " +
          "nothing, and the line under the field says that where a reader can see it. The " +
          "rejected alternative was a field that opens blank: it makes “empty means leave it” " +
          "true by construction and does so by hiding the very number the reader opened this " +
          "dialog to check.\n\n" +
          "**Save is greyed until something has changed, and greyed again over a price the box " +
          "cannot read.** The second is the important half — saving over `12,50,-` and quietly " +
          "dropping it is the silent no-op this dialog exists to refuse.\n\n" +
          "Driven by `.storybook/fake/`: the target is the seed's own second entry, so pressing " +
          "Save really writes through `collection_update` and really folds when the edit lands " +
          "on a grain the seed already holds.\n\n" +
          "**No `play` functions here on purpose** — `Collection/Pick copies`' note, for its " +
          "reason: story plays are not runnable while this feature is being built in parallel, " +
          "and every claim above is asserted in `EditCopy.test.tsx` instead. Add plays when the " +
          "wiring lands, not before.",
      },
    },
  },
} satisfies Meta<typeof EditCopy>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A played copy with the whole acquisition story on it — both fields holding something, which is
 * the state the sentence under the price box is written for.
 *
 * The picker opens on **Heavily played** rather than on the head of the scale, because it is
 * seeded from the row: a dialog that opened on the default would be editing a copy it had not
 * read. The currency beside the box is the **row's own** and never the marketplace's — a reader
 * who switches to Cardmarket has not repaid anything in euros.
 *
 * The line under the field is the un-clearable rule stated to the reader rather than only in the
 * code. It is drawn here because there is a price for it to be about; {@link NothingRecordedYet}
 * is the row where it is not.
 */
export const Default: Story = {};

/**
 * A copy nobody has graded and nobody has priced — **the shape every new row has since this PR.**
 *
 * `MENU_CONDITION` is `NONE` now, so a menu quick-add records silence rather than Near Mint, and
 * the picker opens on **Not set**. Both fields are therefore empty in the honest sense: the reader
 * has said nothing, and the app has not said anything on their behalf.
 *
 * **No clearing note**, because there is nothing to clear. A pre-emptive warning about a state
 * that cannot arise is noise, so the sentence is drawn only where a price is recorded.
 *
 * Typing a price here is the one case that also writes a **currency**: the row carries none, so
 * the marketplace's is the only evidence of which money the reader is thinking in — and it is the
 * same answer the add popup writes for a brand-new copy.
 */
export const NothingRecordedYet: Story = {
  args: {
    target: {
      ...RECORDED,
      entryId: 1,
      cardName: "Lightning Bolt",
      setCode: "2x2",
      collectorNumber: "117",
      condition: "NONE",
      purchasePrice: null,
      purchaseCurrency: null,
      folderName: null,
    },
  },
};

/**
 * The same copy under a euro marketplace, with a price recorded in dollars.
 *
 * **The two do not meet, and that is the rule rather than an oversight**: `purchase_price` is what
 * was paid, so it never converts and never moves with the marketplace setting. The field is
 * labelled and formatted in the row's own money; the setting reaches this dialog for exactly one
 * purpose, which is to name the currency of a **first** price on a row that has none.
 */
export const PaidInAnotherCurrency: Story = {
  args: { currency: "eur" },
};

/**
 * A grade the column holds and this build has never heard of.
 *
 * Under `collection_entries`' own CHECK no such row exists — the fence is around the *type*, which
 * is `string`, and rows written by an older build or by an import are what it is for. The picker
 * draws the stored word rather than the head of the list, which is the trap a controlled select
 * sets by default: with no placeholder it would show the **first** option — since this PR, "Not
 * set" — claiming the copy is ungraded when it is stored as something else, and a Save that then
 * writes nothing because the value has not changed.
 */
export const AGradeThisBuildCannotName: Story = {
  args: { target: { ...RECORDED, condition: "PRISTINE" } },
};

/**
 * A card whose name is longer than the panel is wide, filed in a drawer with a long name of its
 * own — Magic has both, and these are the real ones.
 *
 * The identity line wraps rather than truncating, which is `PickCopies`' call for its own heading
 * and right for the same reason: this dialog is a question about **one** copy among several that
 * may look alike, and a line cut off before the drawer's name is a question nobody can answer
 * safely. The fields underneath keep their geometry — the price box and its currency stay one row.
 */
export const LongCardName: Story = {
  args: {
    target: {
      ...RECORDED,
      cardName: "Asmoranomardicadaistinaculdacar",
      setCode: "mh2",
      collectorNumber: "89",
      finish: "etched",
      folderName: "Cards I keep meaning to sleeve up",
    },
  },
};

/** Closed — `target === null` is what that means here, so the host holds one piece of state
 *  rather than a flag beside a payload the flag can disagree with. Nothing is drawn, which is the
 *  claim: a dialog nobody opened costs the page no scrim, no trap and no Escape rung. */
export const Closed: Story = {
  args: { target: null },
};
