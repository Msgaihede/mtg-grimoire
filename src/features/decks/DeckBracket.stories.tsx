import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AUTO_BRACKET, type DeckCard } from "@/lib/ipc";
import { deckCard, printing } from "../../../.storybook/fake/fixtures";
import { DeckBracket } from "./DeckBracket";

/**
 * A Commander deck of real printings, padded out with one Alpha Island row.
 *
 * The estimate reads oracle text and the `game_changer` column, so what matters here is that
 * every card is one the corpus really holds — a hand-written row would make the number a claim
 * about a fixture rather than about the reading. Since 2026-08-27 it matters twice over: the
 * combo half is answered by the fake's own `combo_cards` table, matched on **oracle id**, so a
 * printing that is not in `.storybook/fake/cards.ts` reaches no combo at all.
 */
function commanderDeck(...extra: DeckCard[]): DeckCard[] {
  return [
    deckCard(printing("eld", "303"), { categoryKind: "commander" }),
    ...extra,
    deckCard(printing("lea", "288"), { quantity: 99 - extra.length }),
  ];
}

/**
 * The `bracketMismatch` seed's deck, less its filler — the ten cards the advisory turns on.
 *
 * Copied by *printing* from `.storybook/fake/seeds.ts` rather than read out of the seeded deck,
 * because this component takes `cards` and never a deck id. What the seed is still doing for
 * these stories is supplying the **combo tables**, which is the half no prop can carry.
 */
function comboDeck(): DeckCard[] {
  return commanderDeck(
    deckCard(printing("fca", "58")), // Thrasios, Triton Hero
    deckCard(printing("mp2", "8")), // Consecrated Sphinx — also a Game Changer
    deckCard(printing("c21", "263")), // Sol Ring — the *possible* combo's second card
    deckCard(printing("wwk", "31")), // Jace, the Mind Sculptor
    deckCard(printing("emn", "15")), // Bruna, the Fading Light
    deckCard(printing("emn", "28")), // Gisela, the Broken Blade
    deckCard(printing("kld", "235")), // Smuggler's Copter
    deckCard(printing("mh2", "138")), // Ragavan, Nimble Pilferer
    deckCard(printing("pcy", "45")), // Rhystic Study
    deckCard(printing("tmp", "315")), // Ancient Tomb
  );
}

const meta = {
  title: "Decks/DeckBracket",
  component: DeckBracket,
  tags: ["autodocs"],
  args: {
    open: true,
    // Auto unless a story says otherwise, which is where every deck starts: `decks.bracket` is
    // `NOT NULL DEFAULT 0` and `0` is the sentinel.
    bracket: AUTO_BRACKET,
    buttonRef: { current: null },
    onBracket: fn(),
    onOpen: fn(),
    onDismiss: fn(),
    onClose: fn(),
  },
  // Room for the panel, which is anchored `absolute right-0 top-9 w-72` under the readout rather
  // than portalled — the shipped CSP is `style-src 'self'` and every overlay primitive in reach
  // injects a runtime `<style>` the moment it opens. Taller than it was: the panel grew a picker,
  // a combo list and a mismatch sentence.
  decorators: [
    (Story) => (
      <div className="flex h-[34rem] w-[24rem] justify-end p-2">
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
          "“advisory only, not hard validation”, so the estimate is prefixed `~`, the panel " +
          "leads with the word estimate, and the disclosure names every card the number was " +
          "read from — which is the only thing that makes a guess like this worth showing at " +
          "all.\n\n" +
          "**Since 2026-08-27 the reader can answer back, and the estimate is a *floor*.** " +
          "`Bracket ~3` is what the cards read as; `Bracket 3` is what the reader told the deck " +
          "it is. The floor is the bottom of a range — which is what every bracket restriction " +
          "already was (“not allowed below bracket N”) — and it is what makes a **mismatch** " +
          "statable at all: a deck set below its own floor gets both numbers and a sentence. " +
          "The floor is never 5, because brackets 4 and 5 have identical deck restrictions and " +
          "what separates them is an intent no card list can show.\n\n" +
          "Every deck below is built from real printings in `.storybook/fake/cards` and read by " +
          "the real `validation/bracket.ts` over the fake's real `combo_cards` table. Not one " +
          "number here is written by hand.",
      },
    },
  },
} satisfies Meta<typeof DeckBracket>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three Game Changers put this deck's floor at 3, and the number comes from a **column**
 * (`cards.game_changer`, maintained by the Commander Format Panel and delivered by a sync) rather
 * than a list this app keeps.
 *
 * Those three are the whole of the corpus's Game Changers: Ancient Tomb, Rhystic Study and
 * Consecrated Sphinx. Measured 2026-08-09 by running `estimateBracket` over all 52 printings at
 * once — **no** card in the corpus reads as mass land denial, and the only one that takes an extra
 * turn is Emrakul, the Aeons Torn, which is `commander: banned`. So those two lines of the
 * disclosure are absent here rather than empty: `estimate` filters an empty list out, and three
 * headings above one number would be two lines of nothing.
 *
 * **And no combo**, which is a claim this panel is only allowed to make because the fake's combo
 * table has been ingested: Consecrated Sphinx is in two of the fixture's combos and neither of its
 * partners is in this deck.
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
    // The one sentence a panel may only write once a list has actually answered.
    await expect(
      await within(panel).findByText("No two-card combo in the list matches this deck."),
    ).toBeInTheDocument();

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
 * see nothing in reads as a floor of 1 rather than as nothing at all — and there is no disclosure,
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
 * The same deck with the reader's own answer on it: `Bracket 4`, **no tilde**.
 *
 * A reading and an answer are different things, and the tilde is the whole of the visible
 * difference — so the name carries what the glyph cannot, `set for this deck` against
 * `an estimate`. Four is above the floor of 3 these three Game Changers imply, and a bracket
 * *above* the floor is an ordinary thing: a bracket is what the table agreed on, and playing
 * under it is not a mistake. Nothing is warned about.
 *
 * The picker below is what wrote it — `Auto` and 1–5, each radio its own tab stop, with the
 * bracket's name in its accessible name and spelled out in the caption under the row.
 */
export const SetByTheReader: Story = {
  args: {
    bracket: 4,
    cards: commanderDeck(
      deckCard(printing("tmp", "315")),
      deckCard(printing("pcy", "45")),
      deckCard(printing("mp2", "8")),
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const readout = canvas.getByRole("button", { name: "Bracket 4, set for this deck" });
    await expect(readout).toHaveTextContent("Bracket 4");
    // No tilde, and no second number: there is nothing here the two answers disagree about.
    await expect(readout).not.toHaveTextContent("~");

    const panel = canvas.getByRole("dialog", { name: "Bracket estimate" });
    // The headline is still the *reading*, whatever the reader set — the picker below is the
    // answer, and the two are different claims that belong in different places.
    await expect(panel).toHaveTextContent("Bracket ~3 · 3 game changers");

    const group = within(panel).getByRole("radiogroup", { name: "Bracket for this deck" });
    await expect(within(group).getByRole("radio", { name: "4 Optimized" })).toBeChecked();
    // A digit is not a name, so the scale is spelled out where a reader who does not know it by
    // number can read it: in each radio's own name, and in the caption under the row.
    await expect(panel).toHaveTextContent(/Optimized — nothing restricted/);

    // Back to Auto is a real value in the patch — `AUTO_BRACKET`, `0` — and not the absence of
    // one, which is the whole reason the column is a sentinel rather than nullable.
    await userEvent.click(within(group).getByRole("radio", { name: "Auto" }));
    await expect(args.onBracket).toHaveBeenCalledWith(AUTO_BRACKET);
  },
};

/**
 * **The state the whole feature exists for**: a deck its owner filed under bracket 2, holding a
 * combo Commander Spellbook classifies as Ruthless.
 *
 * The readout shows **both numbers** — what the reader said, and what the cards read as — because
 * a fill on its own would say that something is up and leave them to open the panel to learn
 * which of the five numbers it is up about. The treatment is deliberately neither of the check
 * chip's two colours: nothing here is *broken* (no rule is being failed) and nothing here is
 * *clean* either, so it is the same accent the control already wears, stated louder.
 *
 * What the panel adds is the half the button cannot carry — *what* makes the two disagree. The
 * floor is 4 because of one combo, Thrasios + Consecrated Sphinx; the two Game Changers beside it
 * would have said 3 on their own, and the `P`, `C` and `E` rows below say 3, 2 and nothing.
 * The highest wins.
 *
 * **And the possible combo raises nothing**, which is the rule hardest to believe from a
 * screenshot: Thrasios + Sol Ring is tagged `R` like the one that set the floor, every card it
 * names is in this deck, and it still counts for nothing — because it also needs a *template*
 * ("a way to sacrifice a creature") that is a description rather than a card id and cannot be
 * checked against a decklist at all.
 */
export const BelowTheFloor: Story = {
  args: { bracket: 2, cards: comboDeck() },
  parameters: { fake: { seed: "bracketMismatch" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **`find`, not `get`, and the wait is the assertion.** The combo read is a query against the
    // fake, so the first painted frame is the honest three-signal reading — two game changers,
    // floor 3 — and the fourth signal arrives when `combos_for_cards` answers. A synchronous
    // `getByRole` here asserts about that first frame and fails naming bracket 3, which reads
    // exactly like the combo never matching at all. What this waits for is the floor *moving*.
    const readout = await canvas.findByRole("button", {
      name: "Bracket 2, set for this deck — the cards read as bracket 4 or higher",
    });
    await expect(readout).toHaveTextContent("Bracket 2 · ~4");
    // The same accent edge the control wears everywhere else, filled rather than recoloured.
    await expect(readout.classList.contains("bg-accent/15")).toBe(true);
    await expect(readout.classList.contains("border-accent")).toBe(true);

    const panel = canvas.getByRole("dialog", { name: "Bracket estimate" });
    // The mismatch leads, above the reading it is about — and it never says illegal, invalid or
    // must, because the reader is the one who knows whether their playgroup cares.
    await expect(
      await within(panel).findByText(/Set to bracket 2, but this deck reads as bracket 4/),
    ).toBeInTheDocument();

    // The combo that set the floor, in Spellbook's own words for its own letter.
    await expect(
      within(panel).getByText("Thrasios, Triton Hero + Consecrated Sphinx"),
    ).toBeInTheDocument();
    // **Twice**, and that is the point of the pair: the letter that set the floor and the letter
    // on the combo that raises nothing are the same letter, so what separates the two rows is
    // which list they are in and the sentence above it — never their tag.
    await expect(
      within(panel).getAllByText("Ruthless — for competitive decks at brackets 4+"),
    ).toHaveLength(2);
    // …and the two lower ones, which is what makes "highest wins" visible rather than asserted.
    await expect(
      within(panel).getByText("Powerful — for strong decks in bracket 3+"),
    ).toBeInTheDocument();
    await expect(
      within(panel).getByText("Core — for unoptimized decks in bracket 2+"),
    ).toBeInTheDocument();

    // The possible one, on its own line, said in words rather than left to a heading.
    await expect(within(panel).getByText(/Possible, and not counted/)).toBeInTheDocument();
    await expect(
      within(panel).getByText("Thrasios, Triton Hero + Sol Ring"),
    ).toBeInTheDocument();
  },
};

/**
 * **The database has never fetched the combo file, which is every install's opening state and not
 * a failure.**
 *
 * `combos_for_cards` answers `[]` here — and `[]` is also what a deck with no combos in it
 * answers, so silence would have the panel implying this deck has none when the truth is that
 * nothing has been looked at. That is the one sentence this panel must never write, so the
 * never-ingested case is checked *first*, says so, and points at Settings.
 *
 * The estimate behind it is unharmed: the floor still reads the three signals it has, which is
 * what makes the fourth feed optional by construction. This is the same deck as
 * {@link BelowTheFloor} and it reads as 3 rather than 4 — the Ruthless combo is the whole of the
 * difference.
 */
export const CombosNeverFetched: Story = {
  args: { cards: comboDeck() },
  parameters: { fake: { seed: "combosMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Bracket estimate" });

    await expect(
      await within(panel).findByText(/No combo list has been downloaded/),
    ).toBeInTheDocument();
    await expect(panel).toHaveTextContent(/Fetch it from Settings, under Combos/);
    // Never this, on a database that has looked at nothing.
    await expect(
      within(panel).queryByText("No two-card combo in the list matches this deck."),
    ).toBeNull();

    // Three signals rather than four, and the floor is the two Game Changers' own.
    await expect(canvas.getByRole("button", { name: "Bracket 3, an estimate" })).toHaveTextContent(
      "Bracket ~3",
    );
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
