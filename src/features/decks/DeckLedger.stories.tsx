import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import type { DeckCard } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckCard, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { DeckLedger } from "./DeckLedger";

/**
 * Every copy of these rows claimed from the collection — what the allocator answers for a deck
 * whose owner has all of it. Without it every story would read "N missing", which is one state of
 * the Owned figure out of two.
 */
function allOwned(cards: DeckCard[]): DeckCard[] {
  return cards.map((card) => ({ ...card, ownedQuantity: card.quantity }));
}

/** A 60-card Modern deck of real printings, with lands. */
function modern(...extra: DeckCard[]): DeckCard[] {
  return allOwned([
    deckCard(printing("mh2", "138"), { quantity: 4 }),
    deckCard(printing("fut", "153"), { quantity: 4 }),
    deckCard(printing("mh2", "259"), { quantity: 4 }),
    deckCard(printing("gtc", "215"), { quantity: 4 }),
    deckCard(printing("dom", "168"), { quantity: 4 }),
    deckCard(printing("lea", "288"), { quantity: 40 }),
    ...extra,
  ]);
}

const meta = {
  title: "Decks/DeckLedger",
  component: DeckLedger,
  tags: ["autodocs"],
  args: {
    // The default, and what every dollar figure in this file is a claim about. The ledger takes
    // the marketplace rather than reading it, so the Price figure and its as-of sentence are
    // decided in one place and cannot disagree with the deck list beside them.
    marketplace: MARKETPLACES.tcgplayer,
    formatName: "Modern",
    gameChangers: 0,
    // The chip's own gate, and deliberately not the count above it — a deck whose only game
    // changer sits in a switched-off pile draws the chip and no number. Off here, so the stories
    // that want it say so.
    hasGameChangers: false,
    gameChangersOnly: false,
    onGameChangersOnlyToggle: fn(),
    tight: false,
    // The ordinary deck, and what every story on this page but {@link OnAVirtualDeck} draws.
    // `false` takes the `Owned` term and the hairline in front of it away; it is written once, in
    // the story it is about.
    tracksCollection: true,
    check: null,
    bracket: null,
  },
  // The editor column at the app's own 1280x800 window, less the sidebar, the shell's padding and
  // the page scrollbar: 1017px is the width every measurement in `DeckEditor.tsx` is taken
  // against, and the width this line was designed to hold three terms and three chips at.
  decorators: [
    (Story) => (
      <div className="w-[63.5rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the deck adds up to, on one line of the header.\n\n" +
          "**These five figures were the foot of the page and are the head of it now** " +
          "(2026-08-24). They were `DeckStats`' `FigureRow`, drawn under four charts at the " +
          "bottom of a scroller a hundred-card deck is two screens tall — so the numbers a " +
          "reader edits *against* were the ones they had to scroll away from the deck to read. " +
          "The charts stay where they are; the arithmetic comes up here, and it exists in " +
          "exactly one place either way, because both surfaces call `deckStats` over the same " +
          "`DeckCard[]`.\n\n" +
          "**A line of terms, not a row of cards.** Every figure is `label value` on one " +
          "baseline with a hairline between neighbours, which is a quarter of the height a " +
          "stacked `Figure` takes and the reason all five fit on a line the action row can " +
          "spare.\n\n" +
          "**Three controls at the right end, and the middle one is a readout that is also a " +
          "press** — the format check and the bracket estimate each open a layer this component " +
          "owns nothing about, and the stories below stand plain buttons in for them. Between " +
          "them sits the game-changer chip: the count, wearing the crown the cards it counts " +
          "wear, and pressing it narrows the deck to exactly those cards.\n\n" +
          "**The count and the filter are one control again** (2026-09-10). From 2026-09-08 the " +
          "press armed a *spotlight* — hover or latch, and every card that is not a game " +
          "changer faded to a quarter — which answered *which ones* by making everything else " +
          "dimmer, and a hundred stacked quarter-opacity cards is a blur rather than an answer. " +
          "So on 2026-09-09 the question moved to a `Game Changers` chip in the toolbar's " +
          "label-filter row and the count here went back to a bare span. That fixed the blur " +
          "and cost something else: the number and the way to act on it sat two lines apart, in " +
          "a row of the reader's own arbitrary label strings. Now the number *is* the button — " +
          "same place, same words, and the narrowing the chip did, which leaves every card that " +
          "survives drawn exactly as it was.",
      },
    },
  },
} satisfies Meta<typeof DeckLedger>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two controls the editor supplies, in the shape this line puts them in. */
const check = (
  <button
    type="button"
    className="inline-flex h-7 items-center rounded-md border border-border px-2 font-mono text-[0.6875rem] text-dim"
  >
    2 issues
  </button>
);
const bracket = (
  <button
    type="button"
    className="inline-flex h-7 items-center rounded-md border border-accent px-2 font-mono text-[0.6875rem] text-accent"
  >
    Bracket ~4
  </button>
);

/**
 * The whole line at the app's own window width: the ruleset, five figures, and the two controls
 * pinned to the right with the game-changer count between them.
 *
 * The headline `Cards` figure is `engine.SIZE_KINDS` — the `main`, `commander` **and `maybe`**
 * kinds, in categories that are switched on — imported from the validation engine rather than
 * restated, because the check beside it would say "Modern decks need at least 60 cards; you have
 * 59" and a figure counting something else next to that sentence would be two numbers for one
 * question.
 */
export const Everything: Story = {
  args: {
    cards: modern(deckCard(printing("apc", "128"), { categoryKind: "side", quantity: 4 })),
    gameChangers: 2,
    hasGameChangers: true,
    check,
    bracket,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const term = (label: string) =>
      canvas.getByText(label, { selector: "dt" }).closest("div") as HTMLElement;

    // 60 counted by the size rule, and the +4 is the sideboard it does not count.
    await expect(term("Cards")).toHaveTextContent("60+4");
    // 44, not the 40 Islands: `mh2 259` is Urza's Saga, and the figure counts a land by its type
    // line rather than by the pile it is filed in.
    await expect(term("Lands")).toHaveTextContent("44");
    await expect(term("Format")).toHaveTextContent("Modern");
    // The sideboard is counted by the price, the shortfall and every chart — it is only the size
    // rule that leaves it out.
    await expect(term("Owned")).toHaveTextContent("64");
    // The count is the chip's own caption, and the chip is a toggle standing at rest.
    await expect(canvas.getByRole("button", { name: "2 game changers" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

/**
 * The chip pressed — the deck on screen behind this line is narrowed to its game changers.
 *
 * `aria-pressed` is what says so; the gold edge and the gold words are the sighted half of that
 * same sentence, and they are `pie-gold` rather than the accent because that is the colour the
 * crowns and banners on the cards themselves are drawn in. The accent on this very line already
 * means something else — `DeckBracket`'s edge says *a reading you can go and look at*.
 *
 * The crown does not move between the two states: here it is the chip's identity rather than its
 * state, so a press changes the colour and never the width.
 */
export const GameChangersFilterOn: Story = {
  args: {
    cards: modern(deckCard(printing("apc", "128"), { categoryKind: "side", quantity: 4 })),
    gameChangers: 2,
    hasGameChangers: true,
    gameChangersOnly: true,
    check,
    bracket,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: "2 game changers" });

    await expect(chip).toHaveAttribute("aria-pressed", "true");
    // The name is the chip's own contents and does not change with the press — the words a test
    // and a screen reader address it by are the same at rest and pressed.
    await userEvent.click(chip);
    await expect(args.onGameChangersOnlyToggle).toHaveBeenCalled();
  },
};

/**
 * A deck whose only game changer is parked in a switched-off pile: the chip, and no number.
 *
 * The gate is `hasGameChangers` — what is on the desk — and the count is copies over the piles
 * that count, which is the number the format will judge. A card in a Maybeboard is exactly a card
 * a reader wants to press this chip about, and `0 game changers` beside it would point at cards to
 * go and find where there are none to find. So the caption falls back to the chip's bare words and
 * the control keeps only the half that is still true.
 */
export const GameChangersParked: Story = {
  args: {
    cards: modern(),
    gameChangers: 0,
    hasGameChangers: true,
    check,
    bracket,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Game Changers" })).toBeInTheDocument();
    await expect(canvas.queryByText(/0 game changers/)).toBeNull();
  },
};

/**
 * The sentence a 36px line has nowhere to write: spec §5's as-of line, and the copies this
 * marketplace does not quote.
 *
 * The unpriced note is the one for *this* currency — `eur_etched` does not exist, so an etched
 * deck reads fully priced on TCGplayer and entirely unpriced on Cardmarket — and it travels with
 * the figure rather than across a switch.
 */
export const PriceAsOf: Story = {
  args: {
    cards: modern(orphanDeckCard({ quantity: 3 })),
    check,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const price = canvas.getByText("Price", { selector: "dt" }).closest("div") as HTMLElement;

    await userEvent.hover(price);
    const tip = await canvas.findByRole("tooltip", undefined, {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    await expect(tip).toHaveTextContent(/prices as of/i);
    await expect(tip).toHaveTextContent("3 unpriced");
  },
};

/**
 * A deck the collection cannot cover, which is the one red thing on this line.
 *
 * It is a **fact**, not a refusal: the press that acts on it is `Send missing to wishlist`, under
 * the deck with the charts. Nothing here refuses anything.
 */
export const Shortfall: Story = {
  args: {
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("lea", "288"), { quantity: 56, ownedQuantity: 56 }),
    ],
    check,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("3 missing")).toBeInTheDocument();
  },
};

/**
 * The narrowest editor column the header reasons about — a 1024px window with the rail out, which
 * leaves 761px.
 *
 * Three things shorten and nothing is removed that a reader could not otherwise get at: the
 * ruleset goes (the check button's own accessible name still carries it at every width), the
 * shortfall becomes a sign with the words kept for a screen reader, and the game-changer count is
 * abbreviated with the same `sr-only` twin. The two figures either side of them do not move.
 */
export const Tight: Story = {
  args: {
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("lea", "288"), { quantity: 56, ownedQuantity: 56 }),
    ],
    gameChangers: 6,
    hasGameChangers: true,
    tight: true,
    check,
    bracket,
  },
  decorators: [
    (Story) => (
      <div className="w-[47.5rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.queryByText("Format", { selector: "dt" })).toBeNull();
    // Drawn as a sign, announced as the words.
    await expect(canvas.getByText("−3")).toHaveAttribute("aria-hidden", "true");
    await expect(canvas.getByText("3 missing")).toHaveClass("sr-only");
    await expect(canvas.getByText("6 GC")).toHaveAttribute("aria-hidden", "true");
    // The twin is the whole of what names the chip at this width, and it is load-bearing rather
    // than a courtesy: the name is computed from the chip's own contents, so an `aria-label` here
    // would replace them and announce the abbreviation to nobody. The chip is a press again since
    // 2026-09-10 and still carries no label, which is what keeps these two strings the name.
    await expect(canvas.getByText("6 game changers")).toHaveClass("sr-only");
    await expect(canvas.getByRole("button", { name: "6 game changers" })).toBeInTheDocument();
  },
};

/**
 * A deck with nothing in it.
 *
 * The average is an em dash rather than `0.00`, because the average of no numbers is not zero, and
 * the price is an em dash for the same reason: `$0.00` is a price nobody quoted. Nothing here is
 * hidden for being zero — a line whose terms come and go is one a reader has to read again every
 * time.
 */
export const EmptyDeck: Story = {
  args: { cards: [], check },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const term = (label: string) =>
      canvas.getByText(label, { selector: "dt" }).closest("div") as HTMLElement;

    await expect(term("Cards")).toHaveTextContent("0");
    await expect(within(term("Avg. mana")).getByText("—")).toBeInTheDocument();
    await expect(within(term("Price")).getByText("—")).toBeInTheDocument();
    await expect(canvas.queryByText(/missing/)).toBeNull();
  },
};

/**
 * A **Virtual** deck — one the reader tracks without owning the cards (issue #401) — where the
 * line is five terms rather than six.
 *
 * `Owned` is the one figure here that is about a *binder* rather than about the deck, so it is the
 * one that goes; the hairline in front of it goes with it, because every term on this line is
 * preceded by its own and a divider with nothing after it is punctuation punctuating nothing.
 *
 * **Absent rather than dimmed to an em dash**, which is right here twice over: a dash on this line
 * already means *no number to give* — see {@link EmptyDeck}'s average — and re-using it for *no
 * question to ask* would put two meanings on one glyph.
 *
 * The rows are {@link Shortfall}'s, so this deck would read `Owned 1 · 3 missing` if the term were
 * left in. Everything else is a fact about the list and stays, controls included.
 */
export const OnAVirtualDeck: Story = {
  args: {
    tracksCollection: false,
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("lea", "288"), { quantity: 56, ownedQuantity: 56 }),
    ],
    gameChangers: 2,
    hasGameChangers: true,
    check,
    bracket,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.queryByText("Owned", { selector: "dt" })).toBeNull();
    await expect(canvas.queryByText(/missing/)).toBeNull();
    // Four hairlines rather than five, so the line does not end in a divider. `aria-hidden` is
    // what tells a rule from a term — both are `div` children of the `<dl>`.
    await expect(canvasElement.querySelectorAll("dl > div[aria-hidden]")).toHaveLength(4);
    // …and nothing else moved: the other five terms and all three controls are where they were.
    for (const label of ["Format", "Cards", "Lands", "Avg. mana", "Price"]) {
      await expect(canvas.getByText(label, { selector: "dt" })).toBeInTheDocument();
    }
    await expect(canvas.getByRole("button", { name: "2 game changers" })).toBeInTheDocument();
  },
};
