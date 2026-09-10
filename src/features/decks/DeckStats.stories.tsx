import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckCard } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckCard, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { DeckStats, STATS_HEADING } from "./DeckStats";

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

/**
 * The same rows, read out of a database that has **not re-ingested since the corpus grew
 * `produced_mana`** — every one of them `null` rather than `""`.
 *
 * The two are not the same state and this is the only way to reach the first from a fixture:
 * `producedManaOf` answers `""` for every printing the fake corpus holds, because a card the
 * corpus holds has been synced by definition. `null` is *this row predates the column*, and
 * `deckStats` keeps the distinction because the arithmetic cannot — six zeroes is also what a
 * deck of sixty spells and no lands honestly produces.
 */
function unsynced(cards: DeckCard[]): DeckCard[] {
  return cards.map((card) => ({ ...card, producedMana: null }));
}

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
    // The second answer to the shortfall line: what the deck is short of *and the reader owns*,
    // which is a dialog rather than a command — so the strip is handed the press and never the
    // write. `fn()` at the meta level so every story on this page draws all three buttons; the
    // absent case is one list rather than one deck, and it is {@link OnTheTheoryList}'s.
    //
    // **The cast is what lets that story exist.** `StoryObj<typeof meta>` takes each argument's
    // type from the value written here, so a bare `fn()` would type this arg as a mock and make
    // `null` — the prop's other half, and the one with a rule behind it — unwritable.
    onPull: fn() as (() => void) | null,
    // The third, and the middle of the row: copies the reader has **just bought**, recorded into
    // the deck's own folder. The one answer to a shortfall that *creates* cardboard rather than
    // moving it or listing it — so it is a press and a preview like the pull, never a command
    // this strip makes. Same `fn()` and same cast, for the same two reasons, and its `null` is
    // {@link OnTheTheoryList}'s too: a plan holds no cardboard, so both of these go together
    // there.
    onAddMissing: fn() as (() => void) | null,
    // The ordinary deck — one with a binder behind it — which is what every story on this page but
    // {@link OnAVirtualDeck} is a shape of. The `false` arm takes the whole shortfall half of the
    // band away, so it is written once, in the story that is about it.
    tracksCollection: true,
    // Which marketplace's money the Figures card's three sums are in. The band quoted none
    // between 2026-08-24 and 2026-09-10 and took no prop; it quotes three now, so it needs the
    // **currency** once — the rows arrived priced, and nothing here looks a price up a second
    // time. `DeckLedger.stories.tsx` supplies it the same way and for the same reason.
    marketplace: MARKETPLACES.tcgplayer,
    // No plan, which is what a deck is born with — the `Matches theory` figure is absent
    // entirely rather than reading `0 of 0`. {@link OnTheoryProgress} is the other arm.
    //
    // **The cast is what lets that story exist**, exactly as `onPull`'s does two lines up:
    // `StoryObj<typeof meta>` takes each argument's type from the value written here, so a bare
    // `null` would make the object half of this union unwritable.
    theory: null as { have: number; want: number } | null,
    // **Open is what every existing deck is.** `decks.stats_open` is `DEFAULT 1`, because this
    // band has been on screen for every deck since 2026-08-14 with no control that hides it — so
    // a collapsed default would be a feature silently removed on upgrade rather than a default.
    // {@link Collapsed} is the other arm.
    open: true,
    // **Uncast, unlike the two callbacks above it**, and the difference is that no story
    // overrides this one: a cast would type it as a plain function and take `toHaveBeenCalled`
    // away from {@link Collapsed}'s play, which is the whole of what that story checks.
    onToggle: fn(),
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
          "**Seven bordered readouts in two wrapping columns, behind a disclosure** since the " +
          "redesign of 2026-09-10 — Mana pips, Card distribution with the opening-hand odds " +
          "under it, Mana curve, Curve by color, Figures, and a Collection card drawn only " +
          "where there is a shortfall to act on. **The two pies are gone**: `Colors` and " +
          "`Lands` answered *what is this deck made of* with two circles whose legends were " +
          "the only readable part, and the six colour curves answer the same question with the " +
          "mana **value** attached while the distribution's `by Types` bars carry the land " +
          "count in a bar a reader can compare against the others.\n\n" +
          "Nothing animates, nothing is a chart library, and every chart carries its numbers " +
          "as text — the drawing is `aria-hidden` and the words beside it are the whole " +
          "accessible story. The arithmetic itself is `deckStats`, exported and covered by " +
          "`DeckStats.test.tsx`; these stories are the shapes it takes on screen, and every " +
          "deck below is built from real printings in `.storybook/fake/cards`.",
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
    // **Scoped to the card, because six more charts say these same sentences.** Every panel of
    // `Curve by color` buckets the same nine mana values, so `0 cards at mana value 8 or more` is
    // seven elements on this page and an unscoped query throws *found multiple* — which is how a
    // reader converting an assertion from the pre-redesign band meets this first.
    const curve = within(canvas.getByRole("region", { name: "Mana curve" }));
    // The bars are `aria-hidden` and the numbers above them are too: the one place the pair is
    // spoken is an `sr-only` sentence per bucket, so a screen reader hears "12 cards at mana
    // value 1" rather than the two loose numbers the eye reads as a column. None of this is in a
    // screenshot.
    await expect(curve.getByText("12 cards at mana value 1")).toBeInTheDocument();
    // The last bucket is open-ended, and it says so in words rather than with the `8+` the eye
    // gets. Emrakul at 15 and Avacyn at 8 are the two cards in it.
    await expect(curve.getByText("2 cards at mana value 8 or more")).toBeInTheDocument();
    // Singular, which nothing else in this repository would notice: `1 cards` is the kind of
    // wrong only a screen reader ever meets.
    await expect(curve.getByText("1 card at mana value 5")).toBeInTheDocument();
    // The line without which the bars silently fail to sum to the deck. It says "2 cards"
    // rather than "2": `plural` writes the noun, so a reader counting the columns against their
    // deck size is told what the two are.
    await expect(curve.getByText("2 cards with no mana value, not counted")).toBeInTheDocument();
    // The average belongs to this curve and to nothing else on the band, so it is drawn on the
    // card's own heading line rather than among the Figures. The *number* is pinned in the two
    // `{X}` stories below, whose twelve rows can be added up by hand.
    await expect(curve.getByText("average")).toBeInTheDocument();
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
    // Scoped to the card: the six colour curves bucket the same nine mana values and say the
    // same sentences. See {@link ManaCurve}'s own note.
    const curve = within(canvas.getByRole("region", { name: "Mana curve" }));
    // All four X spells in the numeric bucket their mana value names.
    await expect(curve.getByText("4 cards at mana value 3")).toBeInTheDocument();
    await expect(canvas.queryByText(/with X in their cost/)).toBeNull();
    // `(3 × 4 + 1 × 4 + 2 × 4) / 12`. The header's ledger prints the same figure the same way
    // (`Decks/DeckLedger`), and the band draws it again because it is a caption on *this* curve
    // — a reader who had to look elsewhere on the page would read it against whichever chart it
    // happened to be nearest. {@link ManaCurveSplitX} is the same twelve cards and the same
    // number, which is the whole claim.
    await expect(curve.getByText("2.00")).toBeInTheDocument();
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
    // Scoped to the card, for {@link ManaCurve}'s reason — and here it is load-bearing twice
    // over: the black colour curve holds those same four copies at mana value 3, because
    // `separateXGroup` deliberately does not reach the six.
    const curve = within(canvas.getByRole("region", { name: "Mana curve" }));
    // The chart is `aria-hidden` but for one `sr-only` sentence per bar, so this sentence is the
    // whole of what a screen reader is told — and it says "X" rather than `{X}`, because braces
    // are not something a screen reader says. None of it is in a screenshot.
    await expect(curve.getByText("4 cards with X in their cost")).toBeInTheDocument();
    // The bucket they left, drawn at zero rather than dropped: a gap in a curve is a fact.
    await expect(curve.getByText("0 cards at mana value 3")).toBeInTheDocument();
    // **The number the toggle must not move**, asserted against {@link ManaCurveWithX}'s own
    // 2.00 over the same twelve cards. An X spell costs what it costs with X at zero
    // (CR 202.3b) whichever bar it is drawn in.
    await expect(curve.getByText("2.00")).toBeInTheDocument();
    // **And the six colour curves are untouched**, which is the one place `separateXGroup`
    // deliberately stops: they draw nine bars and never ten, so the four copies stand in the
    // black curve's mana-value-3 bucket in both arms of this pair.
    await expect(canvas.getByText("Black — 4 spells")).toBeInTheDocument();
  },
};

/**
 * Every colour a deck can be, in one deck: five monocoloured, three gold, one colourless — and
 * **what replaced the `Colors` pie on 2026-09-10**.
 *
 * That pie answered *what is this deck made of* with a circle whose legend was the only readable
 * part. Two readouts answer it now, and between them they say more than the circle could.
 *
 * **Mana pips is demand against supply.** The Cost half counts the pips a cost *prints* — so
 * Counterspell's `{U}{U}` on four copies is **8** blue pips, not 4, and Dismember's two Phyrexian
 * halves are two black ones — and the Sources half counts copies that can **produce** each
 * colour, once in every colour they make. Measured over the rows below: pips
 * `W 6 · U 11 · B 5 · R 8 · G 4` against sources `U 8 · G 9 · C 6`, where the green nine is six
 * Forests **and the three Llanowar Elves**, which is the case a manabase count taken off the type
 * line would miss.
 *
 * **Curve by color is composition with the mana value attached**, which is the half a pie could
 * never carry. Six panels, each read against its own tallest bucket, and **a card is in every
 * colour it is** — so Boros Charm stands in the white curve and the red one, Fire // Ice in blue
 * and red, and the six captions (`W 6 · U 7 · B 3 · R 8 · G 4 · C 2`) sum to more than the 24
 * nonlands they are drawn over. The `C` panel is the one key that partitions rather than
 * overlaps: it is the cards with no colours at all, which here is the two Sol Rings.
 *
 * The lands are a bar in the Card distribution's `by Types` cut rather than a pie of their own —
 * see {@link CardDistribution}.
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // **Pips and copies are two numbers**, and Counterspell is why: four copies asking twice
    // each. A caption reading `4 pips` would be this field's *old* meaning — copies of cards of
    // that colour — under its new name.
    const pips = canvas.getByRole("region", { name: "Mana pips" });
    await expect(within(pips).getByText("Blue").closest("li")).toHaveTextContent(
      "11 pips · 7 cards",
    );
    // Supply, counted once per colour a card makes — and off `produced_mana` rather than off a
    // type line, which is what puts the three Llanowar Elves in with the six Forests.
    await expect(within(pips).getByText("Green").closest("li")).toHaveTextContent("9 sources");
    // A colour the deck neither asks for nor makes is drawn and dimmed rather than dropped: the
    // grid is a shape the reader learns the positions of.
    await expect(within(pips).getByText("Colorless").closest("li")).toHaveTextContent("no pips");

    // Composition, with the mana value attached. The captions overlap on purpose — Boros Charm
    // is in two of them — so these six sum to more than the 24 nonlands.
    const curves = canvas.getByRole("region", { name: "Curve by color" });
    for (const said of [
      "White — 6 spells",
      "Blue — 7 spells",
      "Black — 3 spells",
      "Red — 8 spells",
      "Green — 4 spells",
      // The partition: the two Sol Rings, and nothing else in the deck is in this panel.
      "Colorless — 2 spells",
    ]) {
      await expect(within(curves).getByText(said)).toBeInTheDocument();
    }

    // And the pie that used to answer this is gone rather than moved.
    await expect(canvas.queryByRole("region", { name: "Colors" })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Colors" })).toBeNull();
  },
};

/**
 * **The Card distribution, and what replaced the `Lands` pie** — one cut of the deck drawn as
 * bars, with the opening-hand odds for the same cut under them and one select driving both.
 *
 * The `by Types` cut is the type bars this story used to be about, and **the one place they
 * deliberately disagree with every other chart on the band**. `typeCounts` files a card under the
 * **first** type printed on it, which is right for a bar: the question a bar answers is what a
 * card *does*, and an Artifact Creature is a creature to everyone who has ever built a deck.
 *
 * Urza's Saga is where the two readings come apart. Its type line is `Enchantment Land — Urza's
 * Saga`, so the bars file its 2 copies under Enchantment (3 there, with Rhystic Study) while
 * `isLand` counts them among the lands (20, against a Land bar of 18) for every other readout.
 * A deckbuilder counts Urza's Saga among their lands and it costs nothing to play, so the curve
 * would file it under 0 — exactly the flood the curve excludes lands to avoid.
 *
 * **The land count is a bar the reader can compare against the others**, which is what the pie
 * could not do: 18 Islands beside 13 creatures and 9 instants says something a circle of its own
 * never did, and `Other lands` is not a bucket anybody was asking about.
 *
 * Seven of the eight type buckets are here. **Battle is absent because the corpus has no battle**
 * — 52 printings, none of them a Siege — and an empty bucket is dropped rather than drawn. The
 * `Other` bar is the orphaned row: a card with no type line has no printed type to file under,
 * and `Other` sorts last because it is a remainder rather than a kind.
 *
 * **The select moves the bars *and* the table, which is a deliberate departure from the design
 * this was built from** — there it wired only the table, and a control in a card's header that
 * changes half of its own card is a control that reads as broken.
 */
export const CardDistribution: Story = {
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
    const card = canvas.getByRole("region", { name: "Card distribution" });

    // The bars are `aria-hidden` and so are the counts printed on them: the one place the pair
    // is spoken is an `sr-only` sentence per bar, and none of it is in a screenshot. The Land
    // bar reads 18 against the 20 copies `isLand` counts — Urza's Saga's two are in Enchantment
    // — which is the disagreement this story exists for.
    await expect(within(card).getByText("18 cards of type Land")).toBeInTheDocument();
    await expect(within(card).getByText("3 cards of type Enchantment")).toBeInTheDocument();
    await expect(within(card).getByText("13 cards of type Creature")).toBeInTheDocument();
    // Singular, which nothing else on this page would notice.
    await expect(within(card).getByText("1 card of type Other")).toBeInTheDocument();
    // No battle in the corpus, so no Battle bar — an empty bucket is dropped rather than drawn
    // at zero. The claim is about a bar that is *not* there, which nothing else can settle.
    await expect(within(card).queryByText(/of type Battle/)).toBeNull();
    // The table under the bars is cut the same way, and its first column is named for the cut.
    await expect(within(card).getByRole("columnheader", { name: "Type" })).toBeInTheDocument();

    // …and one control moves both halves.
    await userEvent.click(canvas.getByRole("button", { name: "Card distribution by" }));
    await userEvent.click(canvas.getByRole("option", { name: "Card name" }));
    await expect(within(card).getByText("18 cards named Island")).toBeInTheDocument();
    await expect(within(card).queryByText("18 cards of type Land")).toBeNull();
    await expect(within(card).getByRole("columnheader", { name: "Card" })).toBeInTheDocument();

    // And the pie that used to count the lands is gone rather than moved.
    await expect(canvas.queryByRole("list", { name: "Lands" })).toBeNull();
    await expect(canvas.queryByRole("region", { name: "Lands" })).toBeNull();
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
 * The shortfall line is the other half: 8 of 29 copies are not covered by the collection, so all
 * three of this strip's buttons appear — the shortfall's three answers, in the order they should
 * be tried. Own it (`Pull from collection`), just bought it (`Add missing to collection`), have
 * not bought it (`Send missing to wishlist`). They are absent together when nothing is missing — a
 * control that spends its life offering to do nothing teaches the reader to stop looking at the
 * line it is in — and every other story on this page shows the sentence that replaces them.
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
 * **Where the shopping list is filed** (issue #437) — the picker that rides beside
 * `Send missing to wishlist`.
 *
 * The press used to file at the wishlist root and offer no choice. It now carries a destination:
 * the root (still the default), any folder the reader has, or a new one made on the spot from the
 * picker's own `New folder…` row — which is what keeps a reader with an empty cabinet from having
 * to go and build one somewhere else first.
 *
 * **It is not a fourth press, and that is the whole of the drawing decision.** The three buttons
 * on this line are three *answers* to the shortfall — own it → just acquired → not yet owned —
 * and their class lists are identical character for character so the row cannot drift into
 * reading as a primary and two secondaries. A picker standing among them would read as a fourth
 * answer wherever it sat. So it is drawn **inside the wishlist press's own cluster**, at a
 * tighter gap than the row's, which leaves the three peers three peers, keeps their narrated
 * order intact, and puts the modifier beside the press it modifies rather than beside the two it
 * does not.
 *
 * The folders below are the `starter` seed's — `Ordered`, `Ordered / Backordered` and `Someday` —
 * so the rows are a real tree with a real nesting in it rather than one flat name.
 *
 * **What this page cannot show is the sentence that follows a press.** The live region names the
 * folder (`Added 2 wishes to Ordered — one per card, …`) and says nothing extra at the root, and
 * both are gated on the *latch* — which is armed by a press and released the moment the shortfall
 * or the destination changes. A story's `send` is an idle `fn()` that never settles, so there is
 * no state here for that sentence to be in; it is `DeckStats.test.tsx`'s claim, along with the
 * latch releasing on a changed destination.
 */
export const WishlistDestination: Story = {
  args: {
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("fut", "153"), { quantity: 4, ownedQuantity: 4 }),
      deckCard(printing("lea", "288"), { quantity: 12, ownedQuantity: 12 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const send = canvas.getByRole("button", { name: "Send missing to wishlist" });
    const destination = canvas.getByRole("button", {
      name: "Which wishlist folder this deck's shortfall goes to",
    });

    // **Containment, not document order** — an implementation that drew the picker fourth in the
    // row would still satisfy "it comes after the send button", and that is exactly the
    // arrangement this design refuses. The two peers are asserted *outside* the same box, which
    // is the half that makes this a claim about the cluster rather than about the DOM having a
    // `<div>` in it.
    const cluster = send.parentElement!;
    await expect(cluster).toContainElement(destination);
    for (const name of ["Pull from collection", "Add missing to collection"]) {
      await expect(cluster).not.toContainElement(canvas.getByRole("button", { name }));
    }

    // The rows: the root first, then the reader's own drawers by full path. `New folder…` is the
    // one that has to be there whatever the cabinet holds, and it is asserted by pattern because
    // its ellipsis is the component's own character rather than three dots.
    await userEvent.click(destination);
    await expect(canvas.getByRole("option", { name: "Wishlist" })).toBeInTheDocument();
    await expect(canvas.getByRole("option", { name: /Backordered/ })).toBeInTheDocument();
    await expect(canvas.getByRole("option", { name: /New folder/ })).toBeInTheDocument();

    // And picking one moves the press's destination: the trigger names the drawer, so what the
    // next press would do is readable without opening anything.
    await userEvent.click(canvas.getByRole("option", { name: /Backordered/ }));
    await expect(destination).toHaveTextContent(/Backordered/);
  },
};

/**
 * The same shortfall on the **theory** list, where two of the three answers to it do not exist.
 *
 * `onPull` and `onAddMissing` are both `null`, so neither `Pull from collection` nor
 * `Add missing to collection` is drawn. It is one fact about the *list* rather than two about two
 * features: since schema v25 a deck holds a card because a collection row sits in its group, and
 * a plan holds no cardboard — so there is nothing on that tab to pull copies *into* and nowhere
 * there to record copies *to*. `deck_pull_plan` does not take a variant for that reason, and
 * `deck_missing_plan` reads the live list for the same one.
 *
 * **The number beside them is real on that tab, and since 2026-09-09 it is _truthful_**
 * ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). A theory row's
 * `ownedQuantity` used to be zeroed, so a plan read `N of N missing` whatever the reader owned;
 * it counts every copy the deck could use now, so the band states a real shortfall while the two
 * writes stay absent. **Counting changed and writing did not**, which is exactly what this story
 * draws: a question with two of its three answers missing, rather than a question nobody can
 * ask.
 *
 * The wishlist button stays, because wanting a card you do not own is exactly what a plan is
 * for. Absent rather than greyed, by the same rule that takes all three away when nothing is
 * missing: a control that spends a whole tab refusing teaches the reader to stop looking at the
 * line it is in.
 */
export const OnTheTheoryList: Story = {
  args: {
    onPull: null,
    onAddMissing: null,
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("fut", "153"), { quantity: 4, ownedQuantity: 4 }),
      deckCard(printing("lea", "288"), { quantity: 12, ownedQuantity: 12 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The shortfall is real and its own button is there, so the two absences below are these
    // props and not an empty deck.
    await expect(canvas.getByText("3 of 20 missing")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Send missing to wishlist" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Pull from collection" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Add missing to collection" })).toBeNull();
    // The destination stays with the press it modifies (issue #437). A plan's shopping list is as
    // filable as any other, so nothing about a folder is a fact about which list is on screen.
    await expect(
      canvas.getByRole("button", { name: "Which wishlist folder this deck's shortfall goes to" }),
    ).toBeInTheDocument();
  },
};

/**
 * A **Virtual** deck — one the reader tracks without owning the cards, on MTGO, on Arena or in
 * proxies (issue #401) — where the whole shortfall half of this band is absent.
 *
 * It is a different absence from {@link OnTheTheoryList} above, and the two are worth reading
 * together. That one is about a *list*: a plan holds no cardboard, so two of the three answers to
 * a shortfall have nowhere to act, while the shortfall itself is stated truthfully (issue #435)
 * and the wishlist press stays because wanting a card you do not own is what a plan is for. This
 * one is about the *deck*: there is no collection behind it at all, so there is no shortfall to
 * state — the whole **Collection** card goes, and the Figures card's own `Owned` entry with it.
 * Every row reads `ownedQuantity: 0`, so a virtual deck would otherwise print `20 of 20 missing`
 * over three buttons offering to move, record and shop for cardboard the reader never claimed to
 * have.
 *
 * **The `All N owned.` fallback this story used to name is deleted rather than hidden**
 * (2026-09-10). It was the other arm of the shortfall's ternary, and the band gates the whole
 * Collection card on `missing > 0` now — so the arm became unreachable for every deck rather than
 * for a virtual one, and unreachable code that looks like a feature is worse than none.
 *
 * The rows below are the same shortfall {@link OnTheTheoryList} draws, and both callbacks are live
 * — so nothing on screen is missing for the *theory* list's reason, which is what makes this a
 * story about this prop.
 *
 * What stays is everything that is a fact about the list rather than about a binder: the pips and
 * every chart.
 */
export const OnAVirtualDeck: Story = {
  args: {
    tracksCollection: false,
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 0 }),
      deckCard(printing("fut", "153"), { quantity: 4, ownedQuantity: 0 }),
      deckCard(printing("lea", "288"), { quantity: 12, ownedQuantity: 0 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `20 of 20 missing` is what these rows would say, so this is the discriminating half.
    await expect(canvas.queryByText("20 of 20 missing")).toBeNull();
    await expect(canvas.queryByRole("region", { name: "Collection" })).toBeNull();
    for (const name of [
      "Pull from collection",
      "Add missing to collection",
      "Send missing to wishlist",
      // The destination goes with the press it modifies (issue #437): a deck with no binder
      // behind it is short of nothing, so there is no shopping list to file anywhere.
      "Which wishlist folder this deck's shortfall goes to",
    ]) {
      await expect(canvas.queryByRole("button", { name })).toBeNull();
    }
    // The Figures card keeps three of its four entries and loses `Owned`, which is the same
    // argument one card down: a count of the copies a reader owns, over a deck they have said
    // they own none of, is arithmetic about a binder that is not there.
    const figures = canvas.getByRole("region", { name: "Figures" });
    await expect(within(figures).queryByText("Owned")).toBeNull();
    await expect(within(figures).getByText("Cards")).toBeInTheDocument();
    await expect(within(figures).getByText("Price")).toBeInTheDocument();
    // …and the half that says this is not simply an empty band.
    await expect(canvas.getByRole("region", { name: "Mana pips" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Mana curve" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Curve by color" })).toBeInTheDocument();
  },
};

/**
 * A deck with nothing in it: **no readouts at all, and one sentence instead**.
 *
 * Every one of the seven would be honest about an empty deck and useless — nine empty tracks, six
 * empty tracks six times, an odds table of noughts, four figures reading nothing — so the band
 * says what it has rather than drawing shapes that read as a rendering fault.
 *
 * That reverses the arrangement before 2026-09-10, where the pips row was drawn dimmed over an
 * empty deck on the argument that it is a shape a reader learns the width of. Seven bordered
 * cards is not a shape anybody is holding their place in, and a census of six colours a deck has
 * none of is the same chart of zeroes every other readout here is spared.
 *
 * **The disclosure stays**, which is the half worth knowing: it is what a reader presses to put
 * an empty band away, so a control that disappeared with its own contents would leave a header
 * nothing can close.
 */
export const EmptyDeck: Story = {
  args: { cards: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Nothing to measure yet/)).toBeInTheDocument();
    // Claims about things that are not there, which is exactly what a screenshot cannot show.
    for (const title of [
      "Mana pips",
      "Card distribution",
      "Mana curve",
      "Curve by color",
      "Figures",
    ]) {
      await expect(canvas.queryByRole("region", { name: title })).toBeNull();
    }
    // The band itself, and its disclosure, are both still here.
    await expect(canvas.getByRole("region", { name: STATS_HEADING })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: STATS_HEADING })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // No half of the shortfall line: no button offering to wish for nothing. Neither of the
    // other two either, and both are handed a live callback at the meta level — so these
    // absences are the shortfall gate rather than the props.
    for (const name of [
      "Send missing to wishlist",
      "Pull from collection",
      "Add missing to collection",
    ]) {
      await expect(canvas.queryByRole("button", { name })).toBeNull();
    }
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
    const figures = canvas.getByRole("region", { name: "Figures" });

    // **The two figures that count this deck two ways, side by side.** `Cards` is the size rule's
    // 39 with a note saying where the fortieth copy went — and the pile *names itself* rather
    // than being called a sideboard, because in the singleton commander formats there is no
    // sideboard for a companion to be part of.
    const cards = within(figures).getByText("Cards").closest("div");
    await expect(cards).toHaveTextContent("39");
    await expect(cards).toHaveTextContent("+1 companion");
    // …and `Owned` counts every active pile, so it is 40 and not 39.
    const owned = within(figures).getByText("Owned").closest("div");
    await expect(owned).toHaveTextContent("40");
    // The note that replaced the deleted `All N owned.` sentence — said once, by the readout
    // whose job is facts, rather than by a card that also holds three buttons.
    await expect(owned).toHaveTextContent("every copy");
    // And nothing to act on, so no Collection card at all.
    await expect(canvas.queryByRole("region", { name: "Collection" })).toBeNull();
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
    await expect(
      within(canvas.getByRole("region", { name: "Mana curve" })).getByText(
        "0 cards at mana value 8 or more",
      ),
    ).toBeInTheDocument();
    // Counted over the sideboard as well as the main deck — 75 copies, and the eight in the
    // switched-off pile are not among them.
    const figures = canvas.getByRole("region", { name: "Figures" });
    const owned = within(figures).getByText("Owned").closest("div");
    await expect(owned).toHaveTextContent("75");
    await expect(owned).toHaveTextContent("every copy");
    // **The two notes under `Cards` are two different absences and neither is derivable from the
    // other**: `+15 sideboard` is the pile that is switched *on* and outside the format's size
    // rule, `+8 inactive` the pile switched off, which counts toward nothing anywhere. A reader
    // adding the columns on their desk and coming up short is owed both.
    const cards = within(figures).getByText("Cards").closest("div");
    await expect(cards).toHaveTextContent("60");
    await expect(cards).toHaveTextContent("+15 sideboard");
    await expect(cards).toHaveTextContent("+8 inactive");
  },
};

/**
 * **The band put away**, which is `decks.stats_open` at `0` and the one control this band grew on
 * 2026-09-10.
 *
 * It reverses a rule that stood from 2026-08-14 — *there is no control that hides them* — and the
 * argument that rule was made under is what expired: it was written when the band was four charts
 * on one line, and seven readouts is two screens of a page a reader scrolls past every time they
 * open a finished deck.
 *
 * **The state is the deck's and never this component's.** The press asks for the other one
 * through `onToggle`; `DeckEditor` writes it through the ordinary `deck_update` and hands the
 * column back. A band that toggled itself would be a second answer to a question the deck row
 * already holds, and the two would disagree for the length of the write.
 *
 * **The body stays in the tree, empty**, so the disclosure's `aria-controls` always resolves —
 * `DeckTokensPanel`'s own arrangement, and the reason a screen reader is never told about a region
 * that is not there. That half is `DeckStats.test.tsx`'s: a story can show that nothing is drawn,
 * and only a test can show that the id still names something.
 */
export const Collapsed: Story = {
  args: {
    open: false,
    cards: allOwned([
      deckCard(printing("mh2", "138"), { quantity: 4 }),
      deckCard(printing("mh2", "267"), { quantity: 4 }),
      deckCard(printing("lea", "288"), { quantity: 20 }),
    ]),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getByRole("button", { name: STATS_HEADING });

    // The chevron beside the word is `aria-hidden`, so the name is the word alone — which is
    // what a two-element control has to be checked for: a `gap` between two runs computes to
    // `Missing2` one card over in this same band.
    await expect(disclosure).toHaveAccessibleName(STATS_HEADING);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    for (const title of ["Mana pips", "Card distribution", "Mana curve", "Curve by color"]) {
      await expect(canvas.queryByRole("region", { name: title })).toBeNull();
    }

    // The press asks for the negation. It does **not** open the band: nothing here owns the
    // flag, and a story that watched it open would be watching a component that had kept a
    // second copy of the deck's own state.
    await userEvent.click(disclosure);
    await expect(args.onToggle).toHaveBeenCalledWith(true);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  },
};

/**
 * **The state every existing install is in for up to a day**: a database that has not
 * re-ingested since the corpus grew `produced_mana`, so the Sources half of the Mana pips card
 * has no answer to give.
 *
 * It is drawn as a sentence rather than as a row of zeroes, and that is the whole point of the
 * story. Six zeroes is a *real and different* answer — a deck of sixty spells and no lands
 * produces nothing — and the two are indistinguishable in the arithmetic, so
 * `DeckStatsSummary.sourcesKnown` is a field rather than a derivation. The failure it exists to
 * prevent is a chart that is **confidently wrong** rather than one that is honestly absent: a
 * reader whose database is a day behind would otherwise be told that none of their decks makes
 * any mana.
 *
 * The Cost half is unaffected, which is the half that makes this legible: the deck's demand is
 * answered for every colour, and only the supply is unknown.
 *
 * `unsynced` is what reaches the state at all — no printing in the fake corpus can, because
 * every one of them has been synced by construction.
 */
export const SourcesUnknown: Story = {
  args: {
    cards: unsynced(
      allOwned([
        deckCard(printing("mh2", "267"), { quantity: 4 }),
        deckCard(printing("lea", "161"), { quantity: 4 }),
        deckCard(printing("apc", "128"), { quantity: 2 }),
        deckCard(printing("lea", "288"), { quantity: 12 }),
      ]),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pips = canvas.getByRole("region", { name: "Mana pips" });

    await expect(
      within(pips).getByText("Mana sources arrive with the next card sync"),
    ).toBeInTheDocument();
    // No `Sources:` band at all — an empty track beside a filled Cost one *is* the row of zeroes
    // this state exists to refuse.
    await expect(within(pips).queryByText(/^Sources:/)).toBeNull();
    // The tile says so too, rather than `no sources`, which is the answered version of the same
    // six zeroes.
    const blue = within(pips).getByText("Blue").closest("li");
    await expect(blue).toHaveTextContent("awaiting card sync");
    await expect(blue).not.toHaveTextContent("no sources");
    // …and the demand half is answered, which is what says this is not a band that failed to
    // draw. Counterspell asks twice on each of four copies.
    await expect(within(pips).getByText(/^Cost:/)).toBeInTheDocument();
    await expect(blue).toHaveTextContent("10 pips · 6 cards");
  },
};

/**
 * **How far the live list has got toward the deck's plan** — the fourth figure, and the one fact
 * on this band that is on no other surface in the app.
 *
 * `theory` is an *answer* and never a question this band asks: `DeckEditor` derives it with
 * `theoryProgress` off the `theorySlots` query it is already making for the per-card marks, so a
 * second read of the plan cannot come to disagree with the ticks on the cards.
 *
 * **`null` is absence and `0 of 0` is emptiness, and they are drawn differently.** A deck with no
 * plan draws no entry at all — every other story on this page — because `0 of 0` under a heading
 * reads as failure where the honest statement is that there is no question. A plan that exists
 * and is empty *does* draw the figure, and no percentage under it: a percentage of an empty plan
 * does not exist, and the em dash this app prints elsewhere means *a number exists and is
 * unknown*.
 *
 * The rows are a plan two thirds acquired, so the note reads `62%`.
 */
export const OnTheoryProgress: Story = {
  args: {
    theory: { have: 62, want: 100 },
    cards: [
      deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 1 }),
      deckCard(printing("fut", "153"), { quantity: 4, ownedQuantity: 4 }),
      deckCard(printing("lea", "288"), { quantity: 12, ownedQuantity: 12 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const figures = canvas.getByRole("region", { name: "Figures" });

    const theory = within(figures).getByText("Matches theory").closest("div");
    await expect(theory).toHaveTextContent("62 of 100");
    await expect(theory).toHaveTextContent("62%");
    // The figure is the plan's and the shortfall beside it is the binder's — two different
    // questions about one deck, which is why they are two entries rather than one.
    await expect(within(figures).getByText("Owned").closest("div")).toHaveTextContent("3 missing");
  },
};
