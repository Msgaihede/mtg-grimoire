import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import type { DeckCard } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { cn } from "@/lib/utils";
import { deckCard, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { deckCardDimmed, deckSpotlightProps, GC_SPOTLIGHT_ATTR } from "./cardControl";
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
    // **The latch, and never the `latched || hovered` the deck is drawn under.** The editor
    // composes those two and hands this chip only the half `aria-pressed` describes, so every
    // story here starts released and the two callbacks are spies: this component reports the
    // gestures and decides nothing. {@link Spotlight} is the one story that composes them, and
    // it does it in a wrapper rather than in this arg.
    spotlight: false,
    onSpotlightToggle: fn(),
    onSpotlightHover: fn(),
    tight: false,
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
          "**The three controls at the right end are not figures** — the format check, the " +
          "game-changer count and the bracket estimate. The outer two are slotted in whole, " +
          "because each opens a layer this component owns nothing about; the stories below " +
          "stand plain buttons in for them.\n\n" +
          "**The middle one is drawn here, and since 2026-09-08 it is a press as well as a " +
          "readout.** Hovering the game-changer count — or Tabbing onto it — fades every card " +
          "in the deck that is *not* a game changer to a quarter, and a click latches that so " +
          "the reader can take their hand off the mouse and go and look. It is drawn here " +
          "rather than slotted because there is no layer, no anchor and no findings behind it: " +
          "what it needs is two gestures reported and one boolean handed back.\n\n" +
          "**Three appearances, and only one of them is a state.** Off is `border-border` and " +
          "dim text; *touched* paints the words gold and leaves the edge alone, drawn by the " +
          "chip's own `hover:` variant because a pointer resting on a control is not a state " +
          "the control is in; *latched* takes the edge too and adds the crown the cards it " +
          "lights up wear. So `spotlight` is the **latch** — what `aria-pressed` describes — " +
          "and the effective state the deck is drawn under is the editor's `latched || " +
          "hovered`. {@link Spotlight} is the only story that composes the two.",
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
 * The whole line at the app's own window width: the ruleset, five figures, and the three controls
 * pinned to the right.
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
    await expect(canvas.getByText("2 game changers")).toBeInTheDocument();
    // A readout that is also a control, so the name carries the action the drawn words cannot:
    // "2 game changers" on its own tells nobody there is anything to press. {@link Spotlight} is
    // where pressing it does something.
    await expect(
      canvas.getByRole("button", { name: "2 game changers — press to spotlight them in the deck" }),
    ).toHaveAttribute("aria-pressed", "false");
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
 * Three cards standing in for the deck the editor draws under this line.
 *
 * Names rather than tiles, because what this story is about is the **fade** and not the card:
 * `deckCardDimmed` puts `deck-gc-dimmed` on everything that is not a game changer, exactly as all
 * four views do, and the one rule in `src/index.css` takes them to a quarter while an ancestor
 * carries the spotlight attribute. Two dimmed against one lit is the smallest arrangement in
 * which "which of these" has an answer.
 */
const SPOTLIT: { name: string; gameChanger: boolean }[] = [
  { name: "Llanowar Elves", gameChanger: false },
  { name: "Rhystic Study", gameChanger: true },
  { name: "Counterspell", gameChanger: false },
];

/**
 * The chip's two gestures composed the way `DeckEditor` composes them — **the only place in this
 * file where anything is stateful**, because the chip itself decides nothing.
 *
 * `latched || hovered`, gated on the deck still having a game changer in it, and `spotlight` gets
 * the latch alone. Derived at render rather than stored in a third `useState`: a synced flag would
 * be the derived-state pattern this repo's lint refuses, and it would make hovering while latched
 * a write that could turn the latch off when the pointer left.
 */
function SpotlightDemo(args: ComponentProps<typeof DeckLedger>) {
  const [latched, setLatched] = useState(false);
  const [hovered, setHovered] = useState(false);
  const on = (latched || hovered) && args.gameChangers > 0;

  return (
    <div>
      <DeckLedger
        {...args}
        spotlight={latched}
        onSpotlightToggle={() => setLatched((was) => !was)}
        onSpotlightHover={setHovered}
      />
      <div {...deckSpotlightProps(on)} className="mt-3 flex gap-2">
        {SPOTLIT.map((card) => (
          <div
            key={card.name}
            className={cn(
              "rounded-md border border-border bg-surface px-3 py-6 text-xs text-text",
              deckCardDimmed(card.gameChanger),
            )}
          >
            {card.name}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * **The game-changer count is a press**, and this is the only story where pressing it does
 * anything: the three cards under the line are the deck it lights up.
 *
 * Hover the chip, or Tab onto it, and everything that is not a game changer fades to a quarter —
 * the reveal is on focus as well as on hover, because a chip only a pointer could arm would put
 * the whole affordance out of a keyboard reader's reach. Click and the same state **latches**, so
 * it survives the pointer leaving and the reader can go and look; a second press lets go.
 *
 * **Hovering while latched changes nothing, on screen or in the state**, which is the whole
 * reason the chip is handed the latch rather than the composite: the gold is already there, and
 * `aria-pressed` has been saying so since the press.
 */
export const Spotlight: Story = {
  args: {
    cards: modern(deckCard(printing("pcy", "45"))),
    gameChangers: 1,
    check,
    bracket,
  },
  render: (args) => <SpotlightDemo {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: /game changer/ });
    // The deck's box wears the attribute or it does not — present-or-absent, so the query needs
    // no value. jsdom applies no stylesheet under `stories.test.tsx`, so this is the whole of
    // what a play can say about the fade; the quarter itself is the live pass's.
    const armed = () => canvasElement.querySelector(`[${GC_SPOTLIGHT_ATTR}]`);

    await expect(armed()).toBeNull();

    await userEvent.hover(chip);
    await expect(armed()).not.toBeNull();
    // Touched is not pressed: the pointer arriving must not claim a press nobody made.
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.unhover(chip);
    // The latch outliving the pointer is the whole reason it exists.
    await expect(armed()).not.toBeNull();

    await userEvent.click(chip);
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.unhover(chip);
    await expect(armed()).toBeNull();
  },
};

/**
 * The latched appearance on its own, for the docs page — the one of the chip's three states that
 * is a *state*.
 *
 * The edge takes the gold as well as the words, which is what tells a latch from a hover: a hover
 * says "this is live right now" and the border says "this is still on after you let go". The
 * crown is the mark the cards it is lighting up wear, so the reader's eye leaves a crown and
 * lands on crowns.
 */
export const Latched: Story = {
  args: {
    cards: modern(deckCard(printing("pcy", "45"))),
    gameChangers: 6,
    spotlight: true,
    check,
    bracket,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const chip = canvas.getByRole("button", {
      name: "6 game changers — press to stop spotlighting them in the deck",
    });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    // The crown, `aria-hidden` — a bare glyph rather than `GameChangerMark`, which would bind a
    // second name and a second tooltip inside a button that already has both.
    await expect(chip.querySelector("svg")).not.toBeNull();
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
    await expect(canvas.getByText("6 game changers")).toHaveClass("sr-only");
    // `tight` deletes the word from the **drawing** and never from the name — an `aria-label`
    // replaces an element's contents for naming, so the `sr-only` twin beside `6 GC` is
    // announced to nobody and the whole sentence has to be in the label at both widths.
    await expect(
      canvas.getByRole("button", { name: "6 game changers — press to spotlight them in the deck" }),
    ).toBeInTheDocument();
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
