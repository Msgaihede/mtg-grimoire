import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { deckCard, printing } from "../../../.storybook/fake/fixtures";
import type { DeckCard } from "@/lib/ipc";
import { DeckCoverPicker } from "./DeckCoverPicker";

/** The printing every story here points its cover at — Lightning Bolt's Alpha printing. */
const BOLT = printing("lea", "161");

/**
 * Six printings out of one deck, the commander among them so the ordering rule has something to
 * show: `coverChoices` puts a commander first because a commander deck's cover is almost always
 * its commander, and `categoryKind` is what answers that — never the category's name, which the
 * reader may have renamed to anything.
 */
const DECK_CARDS: DeckCard[] = [
  deckCard(printing("eld", "303"), { categoryKind: "commander" }),
  deckCard(BOLT),
  deckCard(printing("mh2", "138")),
  deckCard(printing("c21", "263")),
  deckCard(printing("ema", "32")),
  deckCard(printing("fut", "153")),
];

/**
 * The deck's picture, where it comes from, and the credit an `art` crop owes.
 *
 * **Presentational: it writes nothing.** One command sets a cover —
 * `deckUpdate({ coverCardId })`, a printing's art crop named by a card id — and *when* it runs
 * belongs to the host, which is what lets the same component serve the settings dialog (where a
 * deck exists) and the create dialog (where one does not yet, and the id goes into the
 * `deck_create` instead).
 *
 * **There was a second source and it is deleted.** A cover could be a picture the reader chose
 * off disk, which meant an `Upload an image…` button here, an `onPickFile` beside `onPickCard`,
 * a frame naming a file the create dialog had no deck id to send yet, and a `custom` preview
 * drawn off `/cover/<deckId>`. Four stories went with them — `AFileChosen`, `ACustomCover`,
 * `Uploading` and `PickerUnavailable` — and so did the workbench gap the last of those existed
 * to story, since the OS file picker is no longer a control this component has. A cover is a
 * card id: a short string that syncs, that is identical on desktop, web and Android, and that
 * needs no encoder, no directory and no URL scheme.
 *
 * **The search half is live against the fake's `search_cards`**, so typing here really asks the
 * backend, uncollapsed and with the unplayable printings left in: four Lightning Bolts come back
 * because four printings are four pictures, which is the whole reason `collapse: false` is sent.
 */
const meta = {
  title: "Decks/Cover picker",
  component: DeckCoverPicker,
  tags: ["autodocs"],
  decorators: [
    // The dialog's left column, `DeckSettingsDialog.tsx`'s `sm:w-[22.5rem]`. The picker is
    // full-width by design — it is a column's contents, not a panel — so a story without a
    // column would stretch the four-up grid across the whole docs page.
    (Story) => (
      <div className="w-[22.5rem]">
        <Story />
      </div>
    ),
  ],
  args: {
    coverCardId: BOLT.id,
    // The backend's own lookup on the way out of a write (`deck.rs`'s `LEFT JOIN cards`), not
    // something a caller composes — a story states it because a story has no backend to ask.
    coverArtist: "Christopher Rush",
    deckCards: DECK_CARDS,
    onPickCard: fn(),
    idPrefix: "cover",
  },
} satisfies Meta<typeof DeckCoverPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A deck that already has a cover, with its own printings to change it for.
 *
 * Two claims: the credit line is drawn — Scryfall's image policy, an `art` crop has no printed
 * frame so the illustrator is credited wherever one is shown — and the commander's tile is
 * first.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Art by Christopher Rush")).toBeVisible();

    const choices = canvas.getByRole("list", { name: "Pick art from cards in this deck" });
    const tiles = within(choices).getAllByRole("button");
    await expect(tiles[0]).toHaveAccessibleName(/Kenrith/);
    // The tile that is already the cover says so, rather than leaving the reader to match the
    // picture above against six thumbnails.
    await expect(within(choices).getByRole("button", { name: "Lightning Bolt" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * A deck being made: no cover, no cards, and no deck id either.
 *
 * **This is the state the search box exists for.** "Pick art from cards in this deck" in front
 * of an empty grid is a control that cannot be used at the one moment a cover is most worth
 * choosing, so the empty grid says what it is empty of and the box above it offers the rest of
 * the database.
 */
export const AtCreate: Story = {
  args: { coverCardId: null, coverArtist: null, deckCards: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("No cover")).toBeInTheDocument();
    await expect(canvas.getByText(/Nothing to pick from yet/)).toBeVisible();
    await expect(canvas.queryByText(/^Art by /)).toBeNull();
  },
};

/**
 * Typing swaps the grid's source: the deck's own printings out, every printing in the database
 * in, under a heading that says which one is showing.
 *
 * **Four Lightning Bolts, and that is the assertion.** `collapse: false` is sent because
 * different printings are different art, and collapsing them would fold the four into one row —
 * hiding exactly the choice this control exists to offer. `playableOnly: false` goes with it:
 * art series and tokens are some of the best crops there are, and a cover is not a card you
 * cast.
 *
 * The box is debounced by `DEBOUNCE_MS` (300 ms) before a keystroke becomes a query, which is
 * why the wait below is generous.
 */
export const SearchingEveryPrinting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(canvas.getByLabelText("Search every card"), "Lightning Bolt");

    const results = await canvas.findByRole(
      "list",
      { name: "Pick art from any card" },
      { timeout: 5000 },
    );
    await waitFor(async () => {
      // More than one, rather than exactly four: the corpus is generated
      // (`scripts/gen-storybook-cards.mjs`) and carries four Bolts today — what the story is
      // about is that printings are not folded together, not how many there happen to be.
      await expect(
        within(results).getAllByRole("button", { name: "Lightning Bolt" }).length,
      ).toBeGreaterThan(1);
    });
    // One grid, two modes: the deck's commander is not in the results list.
    await expect(within(results).queryByRole("button", { name: /Kenrith/ })).toBeNull();
  },
};

/** A word nothing matches, which is a different answer from a search that could not run. */
export const NothingMatched: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(canvas.getByLabelText("Search every card"), "qqzzx");

    await expect(await canvas.findByText(/No card matches/, {}, { timeout: 5000 })).toBeVisible();
  },
};
