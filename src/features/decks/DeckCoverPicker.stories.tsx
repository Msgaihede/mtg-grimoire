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
 * A stand-in for a custom cover's bytes.
 *
 * **Not `deckCoverUrl(1)`, which is what the app passes**, and the difference is the browser:
 * that route is `mtgimg://`, a Tauri custom protocol with no handler outside the app window, so
 * a story using it would draw the retry state and prove nothing about the custom arm. The prop
 * is a URL and takes any URL, which is exactly what makes this component testable at all — see
 * `DeckCoverPicker.test.tsx`, which asserts the app's own route reaches the frame.
 *
 * Module-private on purpose: **every non-default export of a CSF file is indexed as a story**.
 *
 * 626×457, which is `images::encode_cover`'s output shape and therefore the size the real bytes
 * would be. The colours go in a `<style>` block rather than in `fill` attributes for the reason
 * `.storybook/fake/images.ts` gives: an SVG in a data URI is its own document with no access to
 * the page's custom properties, and a `<style>` block is the one context `oklch()` is
 * unambiguously parsed in.
 */
const CUSTOM_COVER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="626" height="457">` +
      `<style>.bg{fill:oklch(0.26 0.03 60)}` +
      `.t{fill:oklch(0.93 0.005 90);font-family:Georgia,serif;font-size:34px;text-anchor:middle}` +
      `</style>` +
      `<rect class="bg" width="626" height="457"/>` +
      `<text class="t" x="313" y="240">A picture of your own</text>` +
      `</svg>`,
  );

/**
 * The deck's picture, the two places one can come from, and the credit an `art` crop owes.
 *
 * **Presentational: it writes nothing.** Two commands set a cover and they are not
 * interchangeable — `deckUpdate({ coverCardId })` for a printing's art crop and
 * `deck_set_cover_image` for a path on disk — but which of them runs belongs to the host, which
 * is what lets the same component serve the settings dialog (where a deck exists) and the create
 * dialog (where one does not yet).
 *
 * **The search half is live against the fake's `search_cards`**, so typing here really asks the
 * backend, uncollapsed and with the unplayable printings left in: four Lightning Bolts come back
 * because four printings are four pictures, which is the whole reason `collapse: false` is sent.
 *
 * **One gap is left, and it is not the fake's to close.** The upload's picker is the operating
 * system's: `open()` from `@tauri-apps/plugin-dialog` reaches Tauri's `invoke`, and outside the
 * app window there is nothing behind it. So the press ends in a refusal line, which is exactly
 * what the component does when a picker cannot be opened — see {@link PickerUnavailable}.
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
    coverKind: "card_art" as const,
    // The backend's own lookup on the way out of a write (`deck.rs`'s `LEFT JOIN cards`), not
    // something a caller composes — a story states it because a story has no backend to ask.
    coverArtist: "Christopher Rush",
    customCoverUrl: null,
    deckCards: DECK_CARDS,
    onPickCard: fn(),
    onPickFile: fn(),
    pendingFileName: null,
    uploading: false,
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

/**
 * The create dialog, after the file picker answered.
 *
 * **The picture cannot be previewed and that is a fact about the route, not a shortcut.** The
 * image protocol serves a custom cover at `/cover/<deckId>` and there is no deck yet; the picker
 * hands back a *path*, which is all `dialog:allow-open` grants, and this app reads no file in the
 * webview. So the frame says which file it is, which is the one true thing there is to say.
 */
export const AFileChosen: Story = {
  args: {
    coverCardId: null,
    coverArtist: null,
    deckCards: [],
    pendingFileName: "dragon-hoard.png",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("dragon-hoard.png")).toBeVisible();
    await expect(canvas.getByText(/once the deck is made/)).toBeVisible();
  },
};

/**
 * A cover the reader uploaded. `coverKind` is the one answer to which of the two pictures a deck
 * is showing — it usually carries both, because setting one leaves the other alone.
 *
 * **No credit line, and that is correct rather than an omission**: a custom cover is the
 * reader's own picture and has no Scryfall artist to credit, which is why `coverArtist` stays
 * `null` for one while the frame quite properly draws it.
 */
export const ACustomCover: Story = {
  args: { coverKind: "custom", customCoverUrl: CUSTOM_COVER, customCoverKey: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.queryByText(/^Art by /)).toBeNull();
    // Still offered: switching back to a card's art costs nothing and loses nothing.
    await expect(
      canvas.getByRole("list", { name: "Pick art from cards in this deck" }),
    ).toBeVisible();
  },
};

/** The re-encode is running. A second press does nothing useful, so the control says so — and
 *  keeps its name, because an action keeps its name through the whole flow. */
export const Uploading: Story = {
  args: { uploading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Upload an image…" })).toBeDisabled();
  },
};

/**
 * The upload, pressed.
 *
 * **The picker is the operating system's, so it is the one control here that cannot work in a
 * browser.** `open()` from `@tauri-apps/plugin-dialog` reaches Tauri's `invoke`, and outside the
 * app window there is nothing behind it — so the press ends in the refusal line beside the
 * button rather than in a file dialog. That is the honest state to story: what a reader sees
 * here is exactly what the component does when the picker cannot be opened.
 *
 * The two answers a *working* picker gives — a chosen path and a cancel — are unit-tested
 * instead, because only the OS can produce either.
 */
export const PickerUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("button", { name: "Upload an image…" }));

    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      /Could not open the file picker/,
    );
    // The button comes back: a picker that would not open is not a control that is now spent.
    await expect(canvas.getByRole("button", { name: "Upload an image…" })).toBeEnabled();
  },
};
