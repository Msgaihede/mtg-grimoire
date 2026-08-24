import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckCard } from "@/lib/ipc";
import { deckCard, printing } from "../../../.storybook/fake/fixtures";
import { DeckBracket } from "./DeckBracket";

/**
 * A Commander deck of real printings, padded out with one Alpha Island row.
 *
 * The estimate reads oracle text and the `game_changer` column, so what matters here is that
 * every card is one the corpus really holds — a hand-written row would make the number a claim
 * about a fixture rather than about the reading.
 */
function commanderDeck(...extra: DeckCard[]): DeckCard[] {
  return [
    deckCard(printing("eld", "303"), { categoryKind: "commander" }),
    ...extra,
    deckCard(printing("lea", "288"), { quantity: 99 - extra.length }),
  ];
}

const meta = {
  title: "Decks/DeckBracket",
  component: DeckBracket,
  tags: ["autodocs"],
  args: {
    open: true,
    buttonRef: { current: null },
    onOpen: fn(),
    onDismiss: fn(),
    onClose: fn(),
  },
  // Room for the panel, which is anchored `absolute right-0 top-9 w-72` under the readout rather
  // than portalled — the shipped CSP is `style-src 'self'` and every overlay primitive in reach
  // injects a runtime `<style>` the moment it opens.
  decorators: [
    (Story) => (
      <div className="flex h-[22rem] w-[24rem] justify-end p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The Commander bracket, as a readout on the header's ledger and an advisory behind " +
          "it.\n\n" +
          "**It rode inside the format check's panel until 2026-08-24** and had no control of " +
          "its own, so a reader who wanted to know what bracket their deck read as had to open " +
          "a list of *findings* and scroll past them. The two are different questions — the " +
          "check says what is broken, this says how strong the deck is, and a bracket cannot " +
          "make a deck illegal.\n\n" +
          "**Advisory in the copy as well as in the code.** Wizards' scale is explicitly " +
          "“advisory only, not hard validation”, so the number is prefixed `~`, the panel leads " +
          "with the word estimate, and the disclosure names every card the number was read " +
          "from — which is the only thing that makes a guess like this worth showing at all.\n\n" +
          "Every deck below is built from real printings in `.storybook/fake/cards` and read by " +
          "the real `validation/bracket.ts`. Not one number here is written by hand.",
      },
    },
  },
} satisfies Meta<typeof DeckBracket>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three Game Changers put this deck at bracket 3, and the number comes from a **column**
 * (`cards.game_changer`, maintained by the Commander Format Panel and delivered by a sync) rather
 * than a list this app keeps.
 *
 * Those three are the whole of the corpus's Game Changers: Ancient Tomb, Rhystic Study and
 * Consecrated Sphinx. Measured 2026-08-09 by running `estimateBracket` over all 52 printings at
 * once — **no** card in the corpus reads as mass land denial, and the only one that takes an extra
 * turn is Emrakul, the Aeons Torn, which is `commander: banned`. So those two lines of the
 * disclosure are absent here rather than empty: `estimate` filters an empty list out, and three
 * headings above one number would be two lines of nothing.
 */
export const ThreeGameChangers: Story = {
  args: {
    cards: commanderDeck(
      deckCard(printing("tmp", "315")),
      deckCard(printing("pcy", "45")),
      deckCard(printing("mp2", "8")),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The readout says the number; the `~` is drawn and is not spoken, so the name says the word
    // the glyph stands for instead.
    const readout = canvas.getByRole("button", { name: "Bracket 3, an estimate" });
    await expect(readout).toHaveTextContent("Bracket ~3");

    const panel = canvas.getByRole("dialog", { name: "Bracket estimate" });
    // The headline is one text run rather than styled spans, so it is a sentence something can
    // read back: a fact split across elements is one nothing — screen reader, test, or reader
    // skimming — puts together.
    await expect(panel).toHaveTextContent("Bracket ~3 · 3 game changers");
    await expect(panel).toHaveTextContent(/never a rule this deck can fail/);

    // The disclosure is closed until asked, and **what it says is the reason the number is worth
    // showing at all**: a reader who disagrees with a heuristic can see which card caused it.
    const why = within(panel).getByRole("button", { name: "What this read" });
    await expect(why).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(why);
    await expect(why).toHaveAttribute("aria-expanded", "true");
    await expect(
      within(panel).getByText("Ancient Tomb, Rhystic Study, Consecrated Sphinx"),
    ).toBeInTheDocument();
    // Mass land denial and extra turns have no line at all, rather than a line reading none.
    await expect(within(panel).queryByText("Mass land denial")).toBeNull();
    await expect(within(panel).queryByText("Extra turns")).toBeNull();
  },
};

/**
 * The bottom of the scale, and the state most decks are in.
 *
 * The one card fact that decides the number is a column a sync fills, so a deck the estimate can
 * see nothing in reads as bracket 1 rather than as nothing at all — and there is no disclosure,
 * because an empty "What this read" is a control promising an answer it has not got.
 */
export const NothingToSee: Story = {
  args: { cards: commanderDeck() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Bracket estimate" });

    await expect(panel).toHaveTextContent("Bracket ~1 · 0 game changers");
    await expect(within(panel).queryByRole("button", { name: "What this read" })).toBeNull();
  },
};

/**
 * The readout as it sits on the ledger: an accent edge and nothing open behind it.
 *
 * **Accent, and it is not a state.** The bracket is the one figure on that line that is a
 * *reading* rather than a count, and the edge is what says the number came from somewhere the
 * reader can go and look. The check beside it colours a glyph instead, because red and green there
 * mean broken and clean and there is no such pair here — a bracket 5 deck is not a worse deck.
 */
export const Shut: Story = {
  args: {
    cards: commanderDeck(deckCard(printing("pcy", "45"))),
    open: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const readout = canvas.getByRole("button", { name: /^Bracket \d, an estimate$/ });

    await expect(readout).toHaveAttribute("aria-expanded", "false");
    await expect(readout.className).toContain("border-accent");
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};
