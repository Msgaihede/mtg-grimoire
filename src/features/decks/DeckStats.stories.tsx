import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { DeckCard } from "@/lib/ipc";
import { deckCard, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { DeckStats } from "./DeckStats";

/**
 * Every copy of these rows claimed from the collection — what the allocator answers for a deck
 * whose owner has all of it.
 *
 * Applied to lists of real printings only, and never to a row in a switched-off category or to an
 * orphan: the allocator claims nothing for an inactive category, so a Maybeboard row reads
 * `ownedQuantity: 0` by design and not for want of copies. Without this every story would read
 * "N of N missing", which is one state of the shortfall line out of two.
 */
function allOwned(cards: DeckCard[]): DeckCard[] {
  return cards.map((card) => ({ ...card, ownedQuantity: card.quantity }));
}

/**
 * `n` copies of a row whose printing has left `cards`: no type line, no mana cost, no price, no
 * art.
 *
 * It is what makes three of this strip's holes visible at once — a card with no mana value is
 * counted out of the curve rather than filed under 0, a card with no type line lands in the deck
 * list's `Other` bucket, and a card with no price is counted as unpriced rather than as free.
 */
const orphan = (quantity: number): DeckCard => orphanDeckCard({ quantity });

const meta = {
  title: "Decks/DeckStats",
  component: DeckStats,
  tags: ["autodocs"],
  args: {
    // The narrowed `useDeck().missingToWishlist`, idle. Narrowed rather than passed whole so the
    // strip can be rendered without a query client, and so the one write it makes is visible in
    // its own signature.
    send: {
      mutate: fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      data: undefined,
    },
  },
  // The strip wraps rather than truncates — at 1024px with the card pane docked beside the editor
  // this row is a few hundred pixels wide — so a story is rendered at the editor's own width
  // rather than the canvas's, which would let the four charts sit on one line at any window size.
  decorators: [
    (Story) => (
      <div className="w-[52rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the deck adds up to, live. Every number comes from the same `DeckCard[]` the " +
          "category columns are drawn from — one query, so a curve and a legality panel can never " +
          "disagree — and `deckStats` is recomputed on every edit, because the arithmetic is a " +
          "single pass over a few hundred rows and a stats block that lags the stepper beside " +
          "it is worse than one that costs a microsecond.\n\n" +
          "**Copies throughout, never rows.** Four Bolts are four cards in every figure here, " +
          "which is the only reading under which a curve, a price and a deck size can be talked " +
          "about together.\n\n" +
          "**The one argument that changes a number here is `separateXGroup`**, and it changes " +
          "exactly one: an `{X}` spell leaves its numeric bucket for a tenth, trailing X bar. It " +
          "is the deck's own column (schema v13) and the same value `buildGroups` was handed, " +
          "because a curve counting `{X}{B}{B}{B}` as 3 beside a column headed “Mana value X” " +
          "would be two surfaces answering one question two ways. The average mana value is " +
          "deliberately **not** among the numbers it moves — see {@link ManaCurveSplitX}.\n\n" +
          "Four charts and a pips row. Nothing animates, nothing is a chart library, and every " +
          "chart carries its numbers as text — the drawing is `aria-hidden` and the words " +
          "beside it are the whole accessible story. The arithmetic itself is `deckStats`, " +
          "exported and covered by `DeckStats.test.tsx`; these stories are the shapes it takes " +
          "on screen, and every deck below is built from real printings in " +
          "`.storybook/fake/cards`.",
      },
    },
  },
} satisfies Meta<typeof DeckStats>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A deck with something in every bucket of the curve, and two cards that have no bucket at all.
 *
 * Nine buckets — 0 through 7 exactly, 8 open-ended — which is the bucketing the mana-value filter
 * chips and the deck list's own grouping already use. Measured over the rows below: `[1, 12, 8,
 * 7, 4, 1, 1, 1, 2]`, 39 nonlands, 20 lands, average 2.86.
 *
 * **Lands are excluded, and it is the type line that decides rather than the bucket the deck list
 * files a card under.** All 20 here are Alpha Islands; a land costs nothing to play, so twenty of
 * them at the head of the curve is the flood the chart exists to see past.
 *
 * The two orphaned rows are the point of the last line under the chart. A row whose printing has
 * left the database has neither a `cmc` nor a printed cost, and filing it under 0 would put a
 * number this app invented at the head of the curve — where a reader counts their cheapest
 * spells. So it is counted out and *said* to be counted out.
 */
export const ManaCurve: Story = {
  args: {
    cards: [
      ...allOwned([
        deckCard(printing("lea", "232")),
        deckCard(printing("mh2", "138"), { quantity: 4 }),
        deckCard(printing("isd", "51"), { quantity: 4 }),
        deckCard(printing("lea", "161"), { quantity: 4 }),
        deckCard(printing("fut", "153"), { quantity: 4 }),
        deckCard(printing("mh2", "267"), { quantity: 4 }),
        deckCard(printing("nph", "57"), { quantity: 3 }),
        deckCard(printing("gtc", "215"), { quantity: 2 }),
        deckCard(printing("eld", "115"), { quantity: 2 }),
        deckCard(printing("apc", "128"), { quantity: 2 }),
        deckCard(printing("wwk", "31"), { quantity: 2 }),
        deckCard(printing("eld", "303")),
        deckCard(printing("mp2", "8")),
        deckCard(printing("emn", "15")),
        deckCard(printing("avr", "6")),
        deckCard(printing("roe", "4")),
        deckCard(printing("lea", "288"), { quantity: 20 }),
      ]),
      orphan(2),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The bars are `aria-hidden` and the numbers above them are too: the one place the pair is
    // spoken is an `sr-only` sentence per bucket, so a screen reader hears "12 cards at mana
    // value 1" rather than the two loose numbers the eye reads as a column. None of this is in a
    // screenshot.
    await expect(canvas.getByText("12 cards at mana value 1")).toBeInTheDocument();
    // The last bucket is open-ended, and it says so in words rather than with the `8+` the eye
    // gets. Emrakul at 15 and Avacyn at 8 are the two cards in it.
    await expect(canvas.getByText("2 cards at mana value 8 or more")).toBeInTheDocument();
    // Singular, which nothing else in this repository would notice: `1 cards` is the kind of
    // wrong only a screen reader ever meets.
    await expect(canvas.getByText("1 card at mana value 5")).toBeInTheDocument();
    await expect(canvas.getByText("2 with no mana value, not counted")).toBeInTheDocument();
  },
};

/**
 * The deck both `{X}` stories are measured over, so the pair is a controlled comparison: the
 * same twelve nonlands, drawn twice, with nothing between them but the toggle.
 *
 * **Agadeem's Awakening is the corpus's one `{X}` printing** — `{X}{B}{B}{B}`, mana value 3,
 * `Sorcery // Land`, and it is the front face that decides, so it is a spell rather than a land.
 * Four copies of it, four Ragavan at 1 and four Counterspell at 2 make a curve where the whole
 * effect of the toggle is visible in three bars.
 *
 * Measured over these rows: nonlands 12, `[0, 4, 4, 4, 0, 0, 0, 0, 0]` with the toggle off and
 * `[0, 4, 4, 0, …]` plus an X bar of 4 with it on, average **2.00** either way.
 */
const xCurveDeck = (): DeckCard[] =>
  allOwned([
    deckCard(printing("znr", "90"), { quantity: 4 }),
    deckCard(printing("mh2", "138"), { quantity: 4 }),
    deckCard(printing("mh2", "267"), { quantity: 4 }),
    deckCard(printing("lea", "288"), { quantity: 20 }),
  ]);

/**
 * The default reading, and the one every curve in this app had before schema v13: an `{X}` spell
 * is counted at the mana value it has with X at zero.
 *
 * That is the rules' own answer — CR 202.3b, X is zero everywhere but on the stack — so
 * Agadeem's Awakening's four copies sit in the mana value 3 bar beside anything else that costs
 * three. It is right, and it is also why a storm list can read as a curve full of cheap spells
 * that cost whatever you have: {@link ManaCurveSplitX} is the same twelve cards with the toggle
 * on.
 *
 * Nine bars, and the tenth is not drawn at all rather than drawn empty — `variableCost` is
 * `null` here rather than `0`, which is the difference between "no X bar" and "an X bar with
 * nothing in it".
 */
export const ManaCurveWithX: Story = {
  args: { cards: xCurveDeck() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // All four X spells in the numeric bucket their mana value names.
    await expect(canvas.getByText("4 cards at mana value 3")).toBeInTheDocument();
    await expect(canvas.queryByText(/with X in their cost/)).toBeNull();
    // The average this pair of stories is about is the header's ledger since 2026-08-24 — it is
    // 2.00 in both arms, and `Decks/DeckLedger` is where that is asserted. What this strip is
    // still the place for is which *bar* the four copies are drawn in, above.
    await expect(canvas.queryByText("Avg. mana value")).toBeNull();
  },
};

/**
 * The same twelve cards with the deck's `separateXGroup` on: the `{X}` spells leave their
 * numeric bucket for a tenth, trailing **X** bar.
 *
 * **The same value the deck list's grouping was built with.** `DeckEditor` reads the flag off
 * the loaded deck once and hands it to `buildGroups` and to this strip together, because a curve
 * counting `{X}{B}{B}{B}` as 3 beside a column headed "Mana value X" would be two surfaces
 * answering one question about one deck two ways.
 *
 * **One home, never two.** The mana value 3 bar reads 0 here, so the bars still sum to the
 * nonland count and the chart is still addable — a card in both places would look exactly like a
 * deck with four more spells in it.
 *
 * **And the average does not move.** An X spell costs what it costs with X at zero whichever bar
 * it is drawn in, so this toggle is a display choice about piles rather than a claim about the
 * cardboard — the one number "X gets its own pile" must not propagate to. That figure left this
 * strip for the header's ledger on 2026-08-24, and the ledger cannot move it at all: it calls
 * `deckStats` without the flag, because a line that draws no curve has no use for it.
 *
 * The cells are 20px in both arms. They were 18 in this one for an afternoon, while the stats
 * block was a 280px aside that drew its own scrollbar and a tenth bar had to be bought out of
 * the deck column's width; the block is a full-width band below the deck now and neither is
 * true. See `Curve` for the arithmetic and for why the retired compromise is still written down.
 */
export const ManaCurveSplitX: Story = {
  args: { cards: xCurveDeck(), separateXGroup: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The chart is `aria-hidden` but for one `sr-only` sentence per bar, so this sentence is the
    // whole of what a screen reader is told — and it says "X" rather than `{X}`, because braces
    // are not something a screen reader says. None of it is in a screenshot.
    await expect(canvas.getByText("4 cards with X in their cost")).toBeInTheDocument();
    // The bucket they left, drawn at zero rather than dropped: a gap in a curve is a fact.
    await expect(canvas.getByText("0 cards at mana value 3")).toBeInTheDocument();
    // Unmoved, and no longer drawn here: see the note above and `Decks/DeckLedger`.
    await expect(canvas.queryByText("Avg. mana value")).toBeNull();
  },
};

/**
 * Every colour bucket a deck can have, in one deck: five monocoloured, one gold, one colourless.
 *
 * **Two different questions, drawn twice.** The pips row is *castability* — a copy counts once
 * per colour on the card, so Tymna the Weaver feeds both W and B and the five numbers overlap on
 * purpose. The Colors pie is *composition* — every nonland in exactly one bucket, so the wedges
 * sum to the nonland count and can therefore be a pie at all.
 *
 * Measured over the rows below: pips `W 6 · U 7 · B 3 · R 8 · G 4` over 42 copies, against a pie
 * of White 3, Blue 4, Black 2, Red 4, Green 3, Multicolor 6, Colorless 2 over 24 nonlands.
 *
 * The Lands pie reads the **basic land types printed on the front face**, which is why Ancient
 * Tomb and Urza's Saga land under "Other lands" (2 each) rather than being left out: a land with
 * no basic type is still a land, and a pie whose wedges did not sum to the Lands figure would be
 * a chart contradicting the number above it. The corpus has no dual with two basic types, so the
 * "Multi-type" wedge is absent here rather than empty — `deckStats` drops a bucket nothing is in,
 * because a legend row reading 0 is a line that says nothing.
 */
export const ColourBreakdown: Story = {
  args: {
    cards: allOwned([
      deckCard(printing("ema", "32"), { quantity: 3 }),
      deckCard(printing("mh2", "267"), { quantity: 4 }),
      deckCard(printing("nph", "57"), { quantity: 2 }),
      deckCard(printing("lea", "161"), { quantity: 4 }),
      deckCard(printing("dom", "168"), { quantity: 3 }),
      deckCard(printing("gtc", "148"), { quantity: 2 }),
      deckCard(printing("apc", "128"), { quantity: 2 }),
      deckCard(printing("fca", "18")),
      deckCard(printing("fca", "58")),
      deckCard(printing("c21", "263"), { quantity: 2 }),
      deckCard(printing("lea", "288"), { quantity: 8 }),
      deckCard(printing("unf", "239"), { quantity: 6 }),
      deckCard(printing("tmp", "315"), { quantity: 2 }),
      deckCard(printing("mh2", "259"), { quantity: 2 }),
    ]),
  },
};

/**
 * The type bars, and **the one place they deliberately disagree with the Lands figure**.
 *
 * The bars are the deck list's own headings, read from the deck list's own `groupCards`, so a bar
 * here and a heading over the rows in a category column are the same number by construction. That
 * helper files a card under the **first** type printed on it, which is right for a heading: an
 * Artifact Creature is a creature to everyone who has ever built a deck.
 *
 * Urza's Saga is where the two readings come apart. Its type line is `Enchantment Land — Urza's
 * Saga`, so the bars file its 2 copies under Enchantment (3 there, with Rhystic Study) while the
 * Lands figure counts them (20, against a Land bar of 18). Every chart but the type bars asks the
 * type line instead, because a deckbuilder counts Urza's Saga among their lands and because it
 * costs nothing to play — the curve would file it under 0, which is exactly the flood the curve
 * excludes lands to avoid.
 *
 * Seven of the eight type buckets are here. **Battle is absent because the corpus has no battle**
 * — 52 printings, none of them a Siege — and an empty bucket is dropped rather than drawn. The
 * `Other` bar is the orphaned row: a card with no type line has no printed type to file under,
 * and `Other` sorts last because it is a remainder rather than a kind.
 */
export const TypeBreakdown: Story = {
  args: {
    cards: [
      ...allOwned([
        deckCard(printing("fut", "153"), { quantity: 4 }),
        deckCard(printing("mh2", "138"), { quantity: 3 }),
        deckCard(printing("isd", "51"), { quantity: 4 }),
        deckCard(printing("dom", "168"), { quantity: 2 }),
        deckCard(printing("wwk", "31"), { quantity: 2 }),
        deckCard(printing("lea", "161"), { quantity: 4 }),
        deckCard(printing("mh2", "267"), { quantity: 3 }),
        deckCard(printing("ema", "32"), { quantity: 2 }),
        deckCard(printing("znr", "90"), { quantity: 2 }),
        deckCard(printing("c21", "263")),
        deckCard(printing("kld", "235"), { quantity: 2 }),
        deckCard(printing("pcy", "45")),
        deckCard(printing("mh2", "259"), { quantity: 2 }),
        deckCard(printing("lea", "288"), { quantity: 18 }),
      ]),
      orphan(1),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 20 lands by type line against an 18-card Land bar. The gap is Urza's Saga's two copies,
    // and it is a fact about the deck rather than a rounding error — the tracks and the fills
    // are `aria-hidden`, so the numbers in the legends are all a reader has. The 20 is the land
    // pie's own total, read off its two wedges; the *figure* that used to be checked here is the
    // header's ledger now (`Decks/DeckLedger`), and this strip no longer draws it.
    const pie = canvas.getByRole("list", { name: "Lands" });
    await expect(within(pie).getByText("Island").closest("li")).toHaveTextContent("18");
    await expect(within(pie).getByText("Other lands").closest("li")).toHaveTextContent("2");
    const bars = canvas.getByRole("list", { name: "Card types" });
    await expect(within(bars).getByText("Land").closest("li")).toHaveTextContent("18");
    await expect(within(bars).getByText("Enchantment").closest("li")).toHaveTextContent("3");
    // No battle in the corpus, so no Battle bar — an empty bucket is dropped rather than drawn
    // at zero. The claim is about a bar that is *not* there, which nothing else can settle.
    await expect(within(bars).queryByText("Battle")).toBeNull();
  },
};

/**
 * What the deck costs, and the copies the sum could not price.
 *
 * Summed from each row's own finish-correct `usd` and never from `cards.price_usd`, which is a
 * display fallback chain: on a foil-only printing it quotes the foil, and adding those up would
 * price a deck at rates nobody was quoted. `$1,541.78` over 29 copies here.
 *
 * **The unpriced note is what keeps the total honest.** Three copies have no `usd` key at all —
 * Alpha Black Lotus and Alpha Ancestral Recall are priced in euros and in nothing else, and the
 * Masterpiece Consecrated Sphinx in nothing at all — so a total that quietly omitted them would
 * be a number rounded down by however much those cards are worth. The as-of sentence rides as the
 * figure's `title`, because a 36px row has nowhere to write it.
 *
 * The shortfall line is the other half: 8 of 29 copies are not covered by the collection, so the
 * one button this strip has appears. It is absent when nothing is missing — a control that spends
 * its life offering to do nothing teaches the reader to stop looking at the line it is in — and
 * every other story on this page shows the sentence that replaces it.
 */
export const Price: Story = {
  args: {
    cards: [
      deckCard(printing("lea", "232")),
      deckCard(printing("lea", "47")),
      deckCard(printing("mp2", "8")),
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 4 }),
      deckCard(printing("fut", "153"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("mh2", "259"), { quantity: 4, ownedQuantity: 4 }),
      deckCard(printing("tmp", "315"), { quantity: 2 }),
      deckCard(printing("lea", "288"), { quantity: 12, ownedQuantity: 12 }),
    ],
  },
};

/**
 * A deck with nothing in it.
 *
 * Four figures and a pips row, and **no charts at all** — a pie of nothing is a blank circle and
 * a curve of nine zeroes is a flat line pretending to be data. The average is an em dash rather
 * than `0.00`, because the average of no numbers is not zero, and the price is an em dash for the
 * same reason: `$0.00` is a price nobody quoted.
 *
 * The pips row *is* drawn, at all five colours, dimmed. It is a shape a reader learns to read at
 * a glance, and a row that changes width with the deck is one they have to read again every time.
 */
export const EmptyDeck: Story = {
  args: { cards: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The whole chart cluster is gone rather than drawn empty. Four claims about things that are
    // not there, which is exactly what a screenshot cannot show.
    await expect(canvas.queryByRole("list", { name: "Mana curve" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Colors" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Lands" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Card types" })).toBeNull();
    // The pips row stays, all five of them, so the strip keeps its shape.
    await expect(canvas.getByRole("group", { name: "Color pips" })).toBeInTheDocument();
    // Neither half of the shortfall line: no button offering to wish for nothing, and no "All 0
    // owned." either, which would be a cheerful sentence about an empty deck.
    await expect(canvas.queryByRole("button", { name: "Send missing to wishlist" })).toBeNull();
    await expect(canvas.queryByText(/owned\./)).toBeNull();
  },
};

/**
 * A commander deck with a companion, where the headline figure counts **neither the way the
 * others do**.
 *
 * "Cards" is `engine.SIZE_KINDS` — the `main`, `commander` **and `maybe`** kinds, in categories
 * that are switched on (an *active* Maybeboard counts toward size exactly like the main deck; the
 * seeded one is switched off, which is why it usually does not) — imported from the validation
 * engine rather than restated, because the chip beside
 * this strip would say "Commander decks are exactly 100 cards including the commander; you have
 * 39" and a figure counting something else next to that sentence would be two numbers for one
 * question. It reads 39 while the deck is 40 copies: the companion is the difference, and the note
 * under the figure says where it went.
 *
 * Everything else counts the companion, and the sideboard when there is one: the price, the
 * shortfall and all four charts are over every **active** category, because a sideboard is cards
 * you own, sleeve and pay for. A companion is named as a companion in that note rather than folded
 * into the sideboard — in the singleton commander formats there is no sideboard for it to be part
 * of, which is the same `sideboardMax` cell the engine reads.
 */
export const CommanderDeck: Story = {
  args: {
    cards: allOwned([
      deckCard(printing("eld", "303"), { categoryKind: "commander" }),
      deckCard(printing("iko", "226"), { categoryKind: "companion" }),
      deckCard(printing("mh2", "267")),
      deckCard(printing("ema", "32")),
      deckCard(printing("dom", "168")),
      deckCard(printing("fut", "153")),
      deckCard(printing("isd", "51")),
      deckCard(printing("lea", "161")),
      deckCard(printing("gtc", "148")),
      deckCard(printing("gtc", "215")),
      deckCard(printing("nph", "57")),
      deckCard(printing("kld", "235")),
      deckCard(printing("mh2", "259")),
      deckCard(printing("tmp", "315")),
      deckCard(printing("pcy", "45")),
      deckCard(printing("lea", "288"), { quantity: 25 }),
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The headline figure that counts 39 of these 40 copies is the header's ledger
    // (`Decks/DeckLedger`), which is where that assertion went. What this strip says about the
    // same deck is the half the size rule does *not* govern: the companion is counted
    // everywhere else, so it is 40 copies owned, not 39.
    await expect(canvas.getByText("All 40 owned.")).toBeInTheDocument();
  },
};

/**
 * A 60-card deck with a 15-card sideboard and an 8-card Maybeboard, and **the Maybeboard changes
 * no number on this strip**.
 *
 * A category that is switched off counts toward nothing at all — not size, not price, not the
 * curve, not the colours, not the shortfall — which is the same line `validateDeck` opens with and
 * the reason the allocator never claims a copy for it. **It is the switch that does that and never
 * the word `maybe`**: the Maybeboard is simply the one category a deck is born with switched off,
 * and a `main` pile of the reader's own that they switched off leaves every number here by exactly
 * the same route. `deckStats` still *reports* the pile in `byCategory`, and nothing here draws it:
 * the headline note lists the piles that are counted somewhere, and this one is counted nowhere.
 *
 * The eight cards in it are chosen so their absence is measurable rather than assumed: 4 Emrakul
 * (mana value 15) and 4 Avacyn (8) would put 8 copies in the curve's open-ended last bucket, and
 * that bucket reads 0. The sideboard, by contrast, is fully counted — 75 copies, 60 of them
 * sized — because a sideboard is cards you own, sleeve and pay for.
 */
export const WithMaybePile: Story = {
  args: {
    cards: [
      ...allOwned([
        deckCard(printing("mh2", "138"), { quantity: 4 }),
        deckCard(printing("isd", "51"), { quantity: 4 }),
        deckCard(printing("fut", "153"), { quantity: 4 }),
        deckCard(printing("lea", "161"), { quantity: 4 }),
        deckCard(printing("mh2", "267"), { quantity: 4 }),
        deckCard(printing("nph", "57"), { quantity: 4 }),
        deckCard(printing("mh2", "259"), { quantity: 4 }),
        deckCard(printing("lea", "288"), { quantity: 32 }),
        deckCard(printing("gtc", "215"), { categoryKind: "side", quantity: 4 }),
        deckCard(printing("dom", "168"), { categoryKind: "side", quantity: 4 }),
        deckCard(printing("apc", "128"), { categoryKind: "side", quantity: 4 }),
        deckCard(printing("gtc", "148"), { categoryKind: "side", quantity: 3 }),
      ]),
      deckCard(printing("roe", "4"), { categoryKind: "maybe", quantity: 4 }),
      deckCard(printing("avr", "6"), { categoryKind: "maybe", quantity: 4 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The 60-against-68 the Maybeboard does not move is the ledger's figure and is asserted
    // there. The load-bearing absence, and the reason those two cards were chosen: 4 Emrakul at 15 and 4
    // Avacyn at 8 are the only cards on this page that could reach the open-ended bucket, and it
    // reads zero. A curve missing eight cards looks exactly like a curve that never had them.
    await expect(canvas.getByText("0 cards at mana value 8 or more")).toBeInTheDocument();
    // Counted over the sideboard as well as the main deck — 75 copies, and the eight in the
    // switched-off pile are not among them.
    await expect(canvas.getByText("All 75 owned.")).toBeInTheDocument();
  },
};
