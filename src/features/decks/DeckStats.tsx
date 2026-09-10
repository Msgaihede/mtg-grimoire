import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { useWishDestinationName, WishDestination } from "@/features/wishlist/WishDestination";
import { count } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { ipcError, type CategoryKind, type DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import {
  countPips,
  emptyPips,
  hasVariableCost,
  MANA_KEYS,
  producedKeys,
  type ManaKey,
  type PipCounts,
} from "@/lib/mana";
import { PRESS, statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { cardManaValue, CURVE_BUCKETS, curveBucket, isLand } from "./deckBuckets";
import { CardDistribution } from "./stats/CardDistribution";
import { CurveByColor } from "./stats/CurveByColor";
import { DeckFigures } from "./stats/DeckFigures";
import { ManaCurveChart } from "./stats/ManaCurveChart";
import { ManaPips } from "./stats/ManaPips";
import { StatsCard } from "./stats/StatsCard";
import { SIZE_KINDS } from "./validation/engine";

/**
 * The band's name, in one place because four things say it: the region's `aria-label`, the
 * disclosure's visible text, `DeckEditor`'s own reference to it, and every test and story that
 * addresses either.
 *
 * `DeckTokensPanel` states its own heading the same way and for the same reason.
 */
export const STATS_HEADING = "Deck stats";

/** The one card in the band that holds controls rather than figures. Named here beside the band
 *  so a test can address it without spelling the word a second time. */
export const COLLECTION_HEADING = "Collection";

/**
 * One category's copies.
 *
 * Named by the row rather than by a fixed word, which is the whole of schema v8 in this file: a
 * category is a pile the reader made, named and ordered, so `Removal` and `Sideboard` arrive
 * here the same way and nothing below knows which is which.
 */
export interface CategoryCount {
  /** `deck_categories.id` — what addresses a pile, since two of them may share a name. */
  id: number;
  /** The reader's own word for it, printed verbatim but for the casing the note applies. */
  name: string;
  /** Copies, never rows. */
  quantity: number;
}

/**
 * A category while it is still being counted, when it also knows its rules role.
 *
 * Narrowed to {@link CategoryCount} on the way out, and that is deliberate rather than
 * incidental: `kind` and `active` decide which of the two lists an entry lands in, and handing
 * them on would invite a caller to make that decision a second time and disagree.
 */
type Tallied = CategoryCount & { kind: CategoryKind; active: boolean };

/**
 * Everything the strip says about a deck, computed once from the rows the editor already
 * holds.
 *
 * **Copies throughout, never rows.** Four Bolts are four cards in every number here, which is
 * the only reading under which a curve, a price and a deck size can be talked about together.
 *
 * **A switched-off category counts toward nothing** — not size, not price, not the curve —
 * which is the same line `validateDeck` opens with and the same read `attribute_owned` makes, so
 * "counts toward nothing" and "is handed no copies" cannot come apart. That is one of the two
 * guards 2026-09-09 left alone: a switched-off pile reads `0` owned on **both** lists, where a
 * theory row now reads a truthful count (issue #435). It is `categoryActive` that says so and
 * never a kind: a Maybeboard the reader switched *on* is
 * counted like any other pile, and a pile of their own they switched off is not. Everything
 * else counts: a sideboard is cards you own, sleeve and pay for.
 */
export interface DeckStatsSummary {
  /** Copies in every **active** category. What the deck *costs* and what it is short of are
   *  counted over all of them: a sideboard is cards you own, sleeve and pay for. */
  copies: number;
  /**
   * Copies in the active categories whose *kind* the format's size rule counts —
   * `engine.SIZE_KINDS`, imported rather than restated.
   *
   * Kinds and not categories, because a deck may own any number of `main` piles: what a card is
   * *for* is the kind, what it is *called* is the reader's.
   *
   * This is the headline figure, and it is a different number from {@link copies} on purpose:
   * the validation chip beside it says "Modern decks need at least 60 cards; you have 59", and
   * a "Cards 74" next to that sentence is two numbers for one question. Sharing the query was
   * never enough — the two have to share the *definition*.
   */
  sized: number;
  /**
   * Copies per category, in the order the rows arrive — which is the read's own order
   * (category `sortOrder`, then the row's name, then its id).
   *
   * One entry per category that holds a card; a category holding none simply has no entry,
   * where an empty zone used to read `0`. **Counted over every row, switched-off categories
   * included** — the one number here that is, and the same bargain the zone version made for
   * the scratchpad: listed, and counted toward nothing else.
   */
  byCategory: readonly CategoryCount[];
  /**
   * The entries of {@link byCategory} the headline figure does **not** count: the active piles
   * whose kind is outside `SIZE_KINDS`, in the same order.
   *
   * A subset rather than a second derivation, because the note under "Cards" has to account for
   * exactly {@link copies} − {@link sized}, and a caller applying the size rule a second time is
   * a caller that can disagree with the figure it is writing under. A switched-off pile is in
   * neither number and is therefore not in here.
   */
  elsewhere: readonly CategoryCount[];
  /**
   * Copies in the piles the reader has switched **off** — counted toward nothing else here, and
   * the second note under the Cards figure.
   *
   * **Not a subset of {@link byCategory}'s numbers and not derivable from them**: that field
   * carries every pile including the switched-off ones, so subtracting is a caller applying the
   * switch a second time. It is drawn precisely because the figure above it does not count it —
   * `+3 inactive` is the sentence that stops a reader wondering where three cards went.
   */
  inactive: number;
  lands: number;
  nonlands: number;
  /** Nonland copies with no mana value anywhere — an orphaned row has neither a `cmc` nor a
   *  printed cost, and filing it under 0 would put a number this app invented at the head of
   *  the curve, where a reader counts their cheapest spells. */
  unknownManaValue: number;
  /** Nine buckets over nonlands: index 0–7 exactly, index 8 is "8 or more". */
  curve: number[];
  /**
   * Nonland copies whose printed cost names `{X}`, kept out of {@link curve} and drawn as a
   * tenth, trailing bar — or `null` when the deck is not splitting them out, which is where
   * they sit in whichever numeric bucket their mana value names.
   *
   * `null` rather than `0` because the two say different things: `0` is "the reader asked for
   * the X bar and this deck has no X spells", which is a fact worth drawing an empty bar for,
   * and `null` is "there is no X bar". The same distinction {@link averageManaValue} draws
   * between an average of nothing and an average of zero.
   *
   * **One home, never two**, so the bars still sum: `sum(curve) + (variableCost ?? 0) +
   * unknownManaValue` is {@link nonlands} in both modes. Membership is
   * `hasVariableCost(card.manaCost)` — the same predicate `grouping.ts` files the `Mana value
   * X` heading by — so the curve and the groups beside it cannot disagree about which cards
   * are X.
   *
   * **It changes no other number here, and {@link averageManaValue} least of all.** See that
   * field's own note: an X spell costs what it costs with X at zero (CR 202.3b) whichever pile
   * it is drawn in.
   */
  variableCost: number | null;
  /**
   * **Pips**, counted the way a card prints them: `{1}{B}{B}` is two black pips on one card, and
   * four copies of it are eight. All six keys, colourless included.
   *
   * **This is a different number from the one this field used to hold, and the change is
   * deliberate** (the redesign of 2026-09-10). It counted *copies of cards of that colour*, read
   * off `colors` — which answered "what is this deck made of" while being called pips. What the
   * Mana pips tile needs is the demand a manabase has to meet, and a card asking for `{B}{B}`
   * makes twice the demand of one asking for `{B}`.
   *
   * Counted through `addPips`, so `{W/U}` is one pip of each half and `{2/W}` one white pip —
   * that vocabulary is `src/lib/mana.ts`' over the one tokeniser this app parses every cost with,
   * and a second spelling of it here is exactly how two counters come to disagree about a
   * Phyrexian hybrid.
   */
  pips: PipCounts;
  /**
   * Copies whose printed cost asks for at least one pip of that colour — the `· N cards` half of
   * a pip readout.
   *
   * **The cost and not `colors`**, though the two nearly always agree. Where they part is a card
   * whose colour comes from something other than its cost: a colour indicator, a back face, a
   * land type. Those are coloured cards that make no demand on a manabase, and this tile is
   * entirely about demand.
   */
  pipCards: PipCounts;
  /**
   * Copies that can **produce** each colour — Scryfall's `produced_mana`, per
   * {@link DeckCard.producedMana}.
   *
   * **A card is counted once in every colour it can make**, so a Command Tower is in all five and
   * the sum across the six keys is larger than the number of mana sources in the deck. That is
   * the honest denominator for "what share of my mana can pay for black": a dual land really is
   * available to both halves of the cost.
   *
   * **Copies and not mana.** Scryfall says *which* colours a card produces and never *how much*,
   * so a Sol Ring counts once for colourless exactly as an Ancient Tomb does. The reading is
   * therefore "sources that can make this colour", and the tile words it that way rather than
   * printing a mana count the data cannot support.
   */
  sources: PipCounts;
  /**
   * Whether the produced-mana question was answered at all — `false` when **every** counted row
   * came back `null`, which is a database that has not re-ingested since the corpus grew the
   * column.
   *
   * **Not `sources` being all zeroes**, which is a real and different answer: a deck of sixty
   * spells and no lands produces nothing, and it should be told so rather than told the app does
   * not know. The two states read identically in the arithmetic and must not read identically on
   * screen, which is the whole reason this is a field rather than a derivation.
   *
   * `true` the moment one row answers, because one answer means the column is populated and the
   * remaining nulls are orphans — rows whose printing has left the corpus, which have no answer
   * to give and never will.
   */
  sourcesKnown: boolean;
  /**
   * Nine curve buckets per colour, over nonlands — the same bucketing {@link curve} uses.
   *
   * **A card is in every colour it is**, so a gold spell is drawn in two curves and the six
   * curves sum to more than {@link nonlands}. Each is read on its own — "what does my red half
   * cost" — and normalising them against each other would answer a question nobody asked.
   *
   * The `C` curve is a card with **no** colours at all, which is the one key that is a partition
   * rather than a membership: a colourless card is in exactly one of the six.
   *
   * **`separateXGroup` deliberately does not reach here.** These are six small charts read for
   * their shape, and a tenth bar on each that six decks in a hundred would use is a column of
   * white space on the other ninety-four.
   */
  curveByColor: Record<ManaKey, number[]>;
  /** Nonland copies in each colour's curve — the `N spells` caption over it, and the sum of that
   *  colour's nine buckets. */
  spellsByColor: Record<ManaKey, number>;
  /**
   * Over nonlands with a mana value, weighted by copies. `null` for a deck of nothing but
   * lands — an average of no numbers is not 0.
   *
   * **The same number whether or not {@link variableCost} is split out**, and that is the one
   * place where "X gets a pile of its own" must not propagate. An `{X}` spell's mana value is
   * what it costs with X at zero (CR 202.3b) — `{X}{B}{B}{B}` is 3 — and the toggle is a
   * *display* choice about which bar a card is drawn in, not a claim that the card has stopped
   * costing three. So an X card keeps contributing its `cmc` here in both modes; only which
   * bar it lands in moves.
   */
  averageManaValue: number | null;
  /**
   * Summed from each row's own {@link DeckCard.unitPrice}, never `cards.price_usd` — which is
   * a display fallback chain and must not be added up. `null` when nothing is priced.
   *
   * Which marketplace's money this is was decided when the deck was read; this figure is
   * simply the sum of what arrived.
   */
  price: number | null;
  /**
   * {@link price}, split the way {@link owned} and {@link missing} split the copies: what the
   * copies in hand are worth, and what the ones still to find would cost.
   *
   * Both are `null` exactly when {@link price} is, and never `0` in its place — a deck the
   * marketplace quotes nothing for has no money to divide, and `$0.00 owned` under an em dash
   * reads as *you own none of it* rather than as *nothing here is priced*.
   *
   * **They sum to {@link price} over the priced rows exactly**, which is what lets the Figures
   * card write them as two lines under the total without a third saying what is missing from the
   * arithmetic. The unpriced copies are outside all three and are {@link unpriced}'s to declare.
   */
  ownedPrice: number | null;
  missingPrice: number | null;
  /** Copies the sum could not price, so a total that omits them does not lie by rounding
   *  down. **The holes are not the same at every marketplace** — a deck of etched printings is
   *  fully priced on TCGplayer and entirely unpriced on Cardmarket — so this number travels
   *  with the figure beside it and is never carried across a switch. */
  unpriced: number;
  /**
   * Copies of this list the reader owns, and the ones they do not — summed straight off
   * {@link DeckCard.ownedQuantity}, so **which copies count is the variant's question and not
   * this module's**. On the Actual list it is what the deck physically holds; on the Theory list,
   * since 2026-09-09 ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)), it is
   * every copy the reader owns that this deck could use — the deck's own box included. A plan of
   * 100 with 62 of its cards already sleeved up reads `62` and `38` where it read `0` and `100`.
   *
   * **This band draws that number on both lists and offers the writes on neither but one.** The
   * count became truthful; nothing about what a plan can be *made* to do moved with it, which is
   * why `onPull` and `onAddMissing` are still `null` on Theory.
   */
  owned: number;
  missing: number;
}


/**
 * Every number the strip draws, from the rows the editor already has.
 *
 * Pure, exported and tested on its own: a chart is only as trustworthy as the arithmetic
 * behind it, and arithmetic that can only be checked by reading pixels is arithmetic nobody
 * checks.
 *
 * **It took a `Currency` and no longer needs one.** Two of the numbers below are about money —
 * {@link DeckStatsSummary.price} and {@link DeckStatsSummary.unpriced} — and both are now read
 * off a single `unitPrice` per row, priced by the backend at the marketplace the deck was read
 * at. Nothing here chooses between two figures, so nothing here has to be told which to pick.
 *
 * @param separateXGroup the deck's own `separateXGroup`, which moves an `{X}` spell out of its
 * numeric bucket and into {@link DeckStatsSummary.variableCost}. It is the **only** argument
 * that changes a number here, and it changes exactly one — see that field, and
 * {@link DeckStatsSummary.averageManaValue} for the number it deliberately does not touch.
 */
export function deckStats(cards: readonly DeckCard[], separateXGroup = false): DeckStatsSummary {
  // One flag rather than the old `zone !== "maybe"`, and it is the same line `validateDeck`
  // opens with: a pile switched off counts toward nothing whatever it is called and whatever
  // kind it is.
  const counted = cards.filter((c) => c.categoryActive);

  // The Card distribution's bars are `deckBuckets.distribution` over these same rows, computed
  // by the chart because the reader's `by` control chooses the cut. `isLand` is where the type
  // line and the deck list's own filing disagree, and its doc says which job each answer serves.
  const lands = counted.filter((c) => isLand(c.typeLine));
  const nonlands = counted.filter((c) => !isLand(c.typeLine));

  const copiesOf = (rows: readonly DeckCard[]) => rows.reduce((n, c) => n + c.quantity, 0);

  // Copies per category, over **every** row — a switched-off pile is counted here and in
  // nothing else, which is what the zone version did for the scratchpad. A `Map` because the
  // categories are not a fixed list any more, and because its insertion order is the read's:
  // a pile appears where its first row does, which is category `sortOrder`.
  const tally = new Map<number, Tallied>();
  for (const card of cards) {
    const at = tally.get(card.categoryId);
    if (at) {
      at.quantity += card.quantity;
      continue;
    }
    tally.set(card.categoryId, {
      id: card.categoryId,
      name: card.categoryName,
      kind: card.categoryKind,
      active: card.categoryActive,
      quantity: card.quantity,
    });
  }
  const categories = [...tally.values()];
  /** The three fields a caller gets: a pile's identity and its copies, never its rules role. */
  const counts = ({ id, name, quantity }: Tallied): CategoryCount => ({ id, name, quantity });
  /** Whether the headline figure counts this pile — the one reading of the size rule. */
  const sizes = (category: Tallied) => category.active && SIZE_KINDS.includes(category.kind);

  const curve = Array<number>(CURVE_BUCKETS).fill(0);
  /**
   * Nine buckets per colour, and the `C` arm is the one that is a partition rather than a
   * membership — see {@link DeckStatsSummary.curveByColor}. Built up front so the one pass over
   * the nonlands fills the deck's curve and the six colour curves together: they are the same
   * cards bucketed the same way, and a second pass is a second chance to bucket them differently.
   */
  const curveByColor = emptyCurves();
  const spellsByColor = emptyPips();
  let manaValued = 0;
  let manaValueTotal = 0;
  let unknownManaValue = 0;
  let variableCost = 0;
  for (const card of nonlands) {
    const mv = cardManaValue(card);
    if (mv === null) {
      unknownManaValue += card.quantity;
      continue;
    }
    // Letters, never JSON: `colors` is `"WU"`, and `JSON.parse` throws on it. A gold spell is in
    // every colour it is; a colourless one is in `C` and nowhere else, which is why this is a
    // membership test for five keys and an emptiness test for the sixth.
    const colors = card.colors ?? "";
    for (const key of MANA_KEYS) {
      const inIt = key === "C" ? colors.length === 0 : colors.includes(key);
      if (!inIt) continue;
      // **The numeric bucket, whatever `separateXGroup` says** — these six charts draw nine bars
      // and never ten, so an X spell is drawn at what it costs with X at zero rather than
      // dropped. See {@link DeckStatsSummary.curveByColor} for why the flag stops here.
      curveByColor[key][curveBucket(mv)] += card.quantity;
      spellsByColor[key] += card.quantity;
    }
    // **Before the bucketing and never instead of it**: an X spell costs what it costs with X
    // at zero (CR 202.3b), and the toggle above moves which bar it is drawn in rather than what
    // it costs. `{X}{B}{B}{B}` feeds 3 into the average whichever pile it is standing in, which
    // is why these two lines sit outside the branch below.
    manaValued += card.quantity;
    manaValueTotal += mv * card.quantity;

    // One home, never two, so the bars still sum to the nonland count. An unknown mana value
    // cannot reach here: `manaValue` answers `null` only when the row has neither a `cmc` nor a
    // printed cost, and a cost that is not there cannot name `{X}`.
    if (separateXGroup && hasVariableCost(card.manaCost)) {
      variableCost += card.quantity;
      continue;
    }
    curve[Math.min(CURVE_BUCKETS - 1, Math.max(0, Math.floor(mv)))] += card.quantity;
  }

  // What the deck **asks for**, and what it can **make**. The two are set against each other by
  // the Mana pips tile and by nothing else here; each is counted in its own vocabulary, and the
  // reason they are not one loop is that one reads a cost and the other reads a column.
  const pips = emptyPips();
  const pipCards = emptyPips();
  const sources = emptyPips();
  let sourcesKnown = false;
  for (const card of counted) {
    // `addPips` over the one tokeniser this app parses every cost with — so `{W/U}` is one pip
    // of each half and `{2/W}` one white pip, and no second spelling of that vocabulary can
    // come to disagree with `deckPips.ts` about a Phyrexian hybrid.
    const own = countPips(card.manaCost);
    for (const key of MANA_KEYS) {
      if (own[key] === 0) continue;
      pips[key] += own[key] * card.quantity;
      // The `· N cards` half: copies **asking** for this colour, however many pips each asks
      // for. A card is counted once here and twice above if it prints `{B}{B}`.
      pipCards[key] += card.quantity;
    }

    // `null` is *this row predates the column*; `""` is *this card makes no mana*. One row
    // answering at all is enough to know the column is populated — what is left null after that
    // is an orphan, which has no answer to give.
    if (card.producedMana !== null) sourcesKnown = true;
    for (const key of producedKeys(card.producedMana)) sources[key] += card.quantity;
  }

  let price = 0;
  let priced = 0;
  let unpriced = 0;
  let owned = 0;
  let missing = 0;
  let ownedPrice = 0;
  let missingPrice = 0;
  for (const card of counted) {
    // The row badge's own arithmetic, added up: a claim is clamped to what the row wants, and
    // a deck cannot be more than fully covered.
    const have = Math.min(card.ownedQuantity, card.quantity);
    const short = card.quantity - have;
    owned += have;
    missing += short;
    // A copy the selected marketplace has never quoted is counted as unpriced, never charged
    // at another marketplace's rate — there is no other number on the row to charge it at.
    if (card.unitPrice === null) unpriced += card.quantity;
    else {
      price += card.unitPrice * card.quantity;
      priced += card.quantity;
      // The same money split the way the shortfall is: what the copies in hand are worth, and
      // what the ones still to find would cost. They sum to `price` over the priced rows
      // exactly, which is what lets the Figures card write them under the total.
      ownedPrice += card.unitPrice * have;
      missingPrice += card.unitPrice * short;
    }
  }

  return {
    copies: copiesOf(counted),
    sized: categories.filter(sizes).reduce((n, category) => n + category.quantity, 0),
    byCategory: categories.map(counts),
    elsewhere: categories.filter((category) => category.active && !sizes(category)).map(counts),
    inactive: cards
      .filter((card) => !card.categoryActive)
      .reduce((n, card) => n + card.quantity, 0),
    lands: copiesOf(lands),
    nonlands: copiesOf(nonlands),
    unknownManaValue,
    curve,
    variableCost: separateXGroup ? variableCost : null,
    pips,
    pipCards,
    sources,
    sourcesKnown,
    curveByColor,
    spellsByColor,
    averageManaValue: manaValued === 0 ? null : manaValueTotal / manaValued,
    price: priced === 0 ? null : price,
    // `null` with the total, and for the total's reason: a deck nothing is priced at is a deck
    // with no money to split, and `$0.00 owned` under an em dash is a figure the reader would
    // read as *you own none of it* rather than as *this marketplace quotes none of it*.
    ownedPrice: priced === 0 ? null : ownedPrice,
    missingPrice: priced === 0 ? null : missingPrice,
    unpriced,
    owned,
    missing,
  };
}

/** Six empty nine-bucket curves — one array per key, never one array shared six ways. */
function emptyCurves(): Record<ManaKey, number[]> {
  return {
    W: Array<number>(CURVE_BUCKETS).fill(0),
    U: Array<number>(CURVE_BUCKETS).fill(0),
    B: Array<number>(CURVE_BUCKETS).fill(0),
    R: Array<number>(CURVE_BUCKETS).fill(0),
    G: Array<number>(CURVE_BUCKETS).fill(0),
    C: Array<number>(CURVE_BUCKETS).fill(0),
  };
}

/**
 * What this strip needs of `useDeck().missingToWishlist` — the mutation, narrowed to the six
 * things a button and a sentence read.
 *
 * Narrowed rather than passed whole so the strip can be rendered in a test without a query
 * client, and so the one write it makes is visible in its own signature.
 *
 * **The narrowing survived the destination and is the reason it could** (issue #437). `mutate`
 * takes the folder the wishes are filed into — `null` for the wishlist root — and that is the
 * whole of what this type grew. What it deliberately did **not** grow is a way to *read* the
 * wishlist: the rule this narrowing exists for is that the strip must not gain a second query
 * that could disagree with the first, and the shortfall is the only question it asks. The
 * destination control beside the button reads the folder **list**, which is a different
 * question about a different table and can no more contradict `N of M missing` than the
 * marketplace can. `useWishDestinationName` is the same list read for one name.
 */
export interface MissingWrite {
  /** The destination — a `wishlist_folders.id`, or `null` for the root. Required rather than
   *  optional, so a caller that has not thought about where the wishes go says so out loud. */
  mutate: (variables: number | null) => void;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  /** How many wishes the last successful press wrote. */
  data: number | undefined;
}

/**
 * What the deck adds up to, live.
 *
 * Every number comes from the same `DeckCard[]` the columns are drawn from — one query, so a
 * curve and a legality panel can never disagree — and it is recomputed on every edit, because
 * the arithmetic is a single pass over a few hundred rows and a stats block that lags the
 * stepper beside it is worse than one that costs a microsecond.
 *
 * Nothing here animates, nothing here is a chart library, and every chart carries its numbers as
 * text — the drawing is `aria-hidden` and the words beside it are the whole accessible story.
 * Colour is used only where it carries Magic meaning, which for the charts means a colour's own
 * `MANA_FILL`: a deck's colours *are* the game's vocabulary, and every other bar is the accent.
 *
 * ## The redesign of 2026-09-10 — what it is now, and what it stopped being
 *
 * The band was a pips row and four charts laid across the page under the deck
 * ([issue #389](https://github.com/Msgaihede/mtg-grimoire/issues/389)). It is **seven bordered
 * readouts in two wrapping columns, behind a disclosure**:
 *
 * | Readout | Answers |
 * | --- | --- |
 * | Mana pips | what the deck's costs **ask for**, set against what its lands and rocks can **make** |
 * | Card distribution | copies per bucket, cut four ways by one control |
 * | Opening hand odds | the hypergeometric chance of meeting a bucket in an opening hand |
 * | Mana curve | the nine buckets and the average |
 * | Curve by color | the same nine, six times, one per colour |
 * | Figures | Cards, Price, Owned, Matches theory |
 * | Collection | the three presses that act on a shortfall |
 *
 * **The two pies are gone.** `Colors` and `Lands` answered *what is this deck made of* with two
 * circles whose legends were the only readable part; the six colour curves answer the same
 * question with the mana **value** attached, and the distribution's `by Types` bars carry the
 * land count in a bar a reader can compare against the others. Nothing was lost that a bar did
 * not say better, and `Slice`, `wedge` and `Pie` went with them.
 *
 * **A disclosure, which reverses "there is no control that hides them"** (2026-08-14 → now).
 * That rule was written when the band was four charts on one line; seven readouts is two screens,
 * and a finished deck is one a reader scrolls past every time they open it. `decks.stats_open`
 * is `DEFAULT 1`, so this takes nothing away from any deck that exists — see the `open` prop.
 *
 * **Bars are not buttons.** The design this is built from makes every bar a control that narrows
 * the deck list beneath it. That is a cross-component feature reaching into all four of the
 * editor's views, and it is deliberately not in this pass — so there is no filter chip in the
 * header and nothing in here is pressable but the disclosure and the Collection card's presses.
 *
 * **The five figures that headed this band are still the header's ledger line** (2026-08-24) and
 * the Figures card does not take them back. `DeckLedger` draws Cards, lands, average mana value,
 * price and owned from a `deckStats` call of its own over the same rows — the numbers a reader
 * edits *against*, which belong above the deck rather than below two screens of it. What Figures
 * adds is the **split**: what the price is owed against, what is still missing, and how far the
 * list has got toward the plan, which is on no other surface in the app.
 *
 * The three shortfall presses arrived with the pull (2026-09-03), the add (2026-09-08) and the
 * wishlist before both — they are `onPull` and `onAddMissing` below, and the argument for them
 * living here rather than in the header is made on {@link Missing}.
 *
 * **The wishlist press gained a destination and the count of presses did not move** (issue #437,
 * 2026-09-09). `Send missing to wishlist` filed at the wishlist root and offered no choice; it
 * now carries a picker beside it for the root, any existing folder, or a new one made on the
 * spot. **It is emphatically not a fourth press** — the argument for that, and for the cluster
 * it is drawn in, is on {@link Missing}; what belongs here is the state it needs, which is one
 * `folderId` and one extra term on the latch below, both for the same reason: `add_wish` folds
 * on a grain whose fourth term is the folder, so the destination is half of what a press *was*.
 *
 * **A deck that owns nothing is short of nothing, and `tracksCollection` is where that is said**
 * (2026-09-08, issue #401). A *Virtual* deck is one the reader tracks without owning the
 * cardboard — MTGO, Arena, proxies — so every row's `ownedQuantity` is `0` and the whole shortfall
 * half of this band would read `99 of 99 missing` over three buttons offering to move, record and
 * shop for cards there is nothing to be short of. Absent rather than greyed, which is this
 * feature's standing answer (`DeckSettingsDialog.tsx`, `DeckEditor.tsx`) — and **the `All N owned.`
 * fallback goes with them**, because it is the same sentence read from the other end and the
 * worst of the two to show a reader who owns none of it. It takes the Figures card's `Owned`
 * entry with it now for the same reason. The charts and the pips are untouched: a curve is a fact
 * about the list, not about a binder.
 */
export function DeckStats({
  cards,
  send,
  onPull,
  onAddMissing,
  tracksCollection,
  marketplace,
  theory,
  open,
  onToggle,
  separateXGroup = false,
}: {
  cards: readonly DeckCard[];
  /**
   * The marketplace the deck was **read** at — what the Price figure's money is in.
   *
   * **It came back, and the reason it left is the reason it is here again.** The prop was dropped
   * on 2026-08-24 when the four figures moved to `DeckLedger`, because nothing left in the band
   * quoted money. The Figures card quotes three sums, so the band needs the currency once more —
   * and it is a **prop rather than `useMarketplace()`** for the same reason `DeckLedger` takes
   * one: this component is rendered in stories with a hand-rolled `send` precisely so it needs no
   * `QueryClientProvider`, and a query hook here would take that back.
   *
   * The rows arrived priced by the backend at this marketplace, so nothing here chooses between
   * two figures — it is the **currency** that is wanted, never a second lookup of a price.
   */
  marketplace: Marketplace;
  /**
   * How far the live list has got toward the deck's plan, or `null` where there is no plan —
   * `theoryProgress` in `theoryMatch.ts`, answered by the host off the `theorySlots` query it is
   * already making for the per-card marks.
   *
   * **Answered by the host and not asked for here**, which is this band's standing rule: a second
   * read of the plan would be a second answer to *what does this deck need* that could disagree
   * with the marks on the cards. `DeckEditor` holds the one query and both readers derive from it.
   *
   * `null` is a deck with no plan, and the Figures card draws no entry at all for it — `0 of 0`
   * reads as failure where the honest statement is absence.
   */
  theory: { have: number; want: number } | null;
  /**
   * `decks.stats_open` — whether the band is expanded.
   *
   * **Open is what every existing deck is**, which is the one way this differs from
   * `DeckTokensPanel`'s identical prop: the column defaults to `1` because this band has been on
   * screen for every deck since 2026-08-14 with no control that hides it, so a collapsed default
   * would be a feature silently removed on upgrade rather than a default. See
   * `DeckRow.statsOpen`.
   *
   * **The arithmetic runs whether or not the charts are drawn**, and that is deliberate rather
   * than an oversight: it is a single pass over a few hundred rows the editor already holds, and
   * gating it on `open` would buy nothing measurable while making the first frame after a press
   * the one that does the work.
   */
  open: boolean;
  onToggle: (next: boolean) => void;
  /**
   * The wishlist write, narrowed — see {@link MissingWrite}.
   *
   * **Taken whatever kind of deck this is, and read only when `tracksCollection` is true.** The
   * type is unchanged on purpose: the host holds one mutation for the editor and a prop that
   * disappeared with the kind would make every call site answer a second question about a write
   * it is already holding. What a virtual deck gets is the button never drawn, so the mutation is
   * never pressed.
   */
  send: MissingWrite;
  /**
   * Opens the pull dialog. `null` where there is nothing to open — the theory list, where a plan
   * holds no cardboard for a pull to move copies *into*.
   *
   * **The reason is the write and no longer the number** (2026-09-09,
   * [issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). This said *whose rows
   * hold no cards at all*, which was a statement about `ownedQuantity` reading `0`; a theory row
   * reads a truthful count now, so the band above this button says `38 of 100 missing` on the
   * plan rather than `100 of 100`. The absence stands anyway, because `deck_pull_plan` takes no
   * variant and reads the live list: a plan is a list of cards to acquire, not a box to move
   * copies into.
   *
   * **A callback and not a write**, which is the difference between this prop and `send` beside
   * it. The wishlist is one press and one command, so the strip can make it and word the answer;
   * a pull is a plan the reader reads and picks from, and every part of that is the dialog's.
   * What this strip owns is the *place the press belongs* — beside the number it is about.
   *
   * **Nullable rather than optional**, so a host that has not thought about it cannot silently
   * get the absent case: `DeckEditor` draws the strip over both lists and has to answer for each.
   */
  onPull: (() => void) | null;
  /**
   * Opens the add-missing dialog — the press for copies the reader has **just bought**, which is
   * the one answer to a shortfall that *creates* cardboard rather than moving it or listing it.
   *
   * `null` where there is nothing to open, and it is `onPull`'s absence for `onPull`'s reason,
   * said in the same words: a plan holds no cardboard, so there is nowhere on that list to
   * record copies *to*. Not because the plan is short of nothing — since 2026-09-09 it says
   * exactly what it is short of (issue #435), and `deck_missing_plan` still walks the live list.
   * **Absent, never greyed** — a control that spends a whole tab refusing teaches the reader to
   * stop looking at the line it is in.
   *
   * **A callback and not a write**, like the pull beside it: the reader reads a preview and picks
   * from it, and every part of that is the dialog's. What this strip owns is the *place the press
   * belongs* — beside the number it is about.
   *
   * **Nullable rather than optional**, for the reason above it: `DeckEditor` draws the strip over
   * both lists and has to answer for each.
   */
  onAddMissing: (() => void) | null;
  /**
   * Does this deck read the collection at all? `deckKind.ts`'s `tracksCollection(deck)`, answered
   * by the host.
   *
   * `false` is a **Virtual** deck (issue #401) and takes the whole shortfall block with it — the
   * `N of M missing` line, all three presses, and the `All N owned.` fallback. See the argument on
   * the component above; what it is *not* is a second reading of `onPull`/`onAddMissing` being
   * `null`, which is the **theory list** and a fact about which of a deck's two lists is on screen
   * rather than about the deck. The two absences stack: a virtual deck keeps one live list and
   * still draws none of this.
   *
   * **The boolean and not the deck**, and **not the helper either**: this component is handed
   * facts and draws them, exactly as it is handed `separateXGroup` rather than reading
   * `deck.separateXGroup`. `DeckEditor` answers it once and hands the same value to the four
   * surfaces that owe a reader an owned readout, so they cannot come to disagree about whether
   * this deck has a binder behind it.
   *
   * **Required rather than optional**, which is `onPull`'s own rule one prop over: a host that has
   * not thought about it must not silently get the collection-reading case, because that is the
   * arm that draws a shortfall over a deck the reader was never claiming to own.
   */
  tracksCollection: boolean;
  /**
   * The deck's own `separateXGroup`, and it has to be **the same value the grouping beside this
   * strip was built with**.
   *
   * That is the whole justification for the prop existing rather than this surface deciding for
   * itself. A curve that counts `{X}{B}{B}{B}` as mana value 3 while the column next to it is
   * headed "Mana value X" is two surfaces answering one question about one deck two ways — the
   * failure this folder's rules keep naming, and the reason `grouping.ts` is the only thing that
   * says what a group is. `DeckEditor` reads the flag off the loaded deck once and hands the
   * same value to both, so the bar and the heading move together or not at all.
   *
   * Defaulted rather than required, because the editor renders before `deck_get` answers and a
   * curve is not the thing to hold up on a boolean.
   */
  separateXGroup?: boolean;
}) {
  const stats = useMemo(() => deckStats(cards, separateXGroup), [cards, separateXGroup]);
  const bodyId = useId();
  const sendRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  /**
   * Where the next press files its wishes — a `wishlist_folders.id`, or `null` for the root
   * (issue #437).
   *
   * **`null` on mount, every time, and deliberately not remembered.** It is the same rule the
   * deck gallery's filter keeps and the opposite of its sort: an order is how a reader likes to
   * read a screen, where this is a thing they are doing right now. A strip that opened already
   * pointing at `Ordered`, with no memory of having been asked, would send a shortfall somewhere
   * the reader did not look — and the root is where every press went before this existed, so the
   * default is also today's behaviour exactly.
   *
   * **Here rather than in {@link Missing}** for the same reason `sentFor` is here: the two are
   * one fact between them (what the last press was about) and the latch below has to be able to
   * see this one change. State inside the component that draws the control would put half of
   * that pair out of reach of the other half.
   */
  const [folderId, setFolderId] = useState<number | null>(null);
  /**
   * The shortfall the last press was made against, or `null` once that press has stopped being
   * news.
   *
   * `missing_to_wishlist` counts what the deck is short of and hands each card to `add_wish`,
   * whose fold **raises** an existing wish's quantity — so a second press on the same shortfall
   * wishes for the same copies twice (three short becomes six wished) and answers the same
   * cheerful number both times. The button is therefore spent until the deck says something
   * new: `stats.missing` is exactly the number the press was about, so a changed one is a
   * changed question. Not the mutation's own `isSuccess`, which stays true forever.
   *
   * **Released for good, and that is the whole reason this is state rather than a comparison.**
   * Re-deriving "spent" from `sentFor === stats.missing` on every render meant the flag could
   * come *back*: step a 3-copy shortfall to 4 and back to 3, and the last answer reappeared in
   * the live region — "Added 3 wishes" for a write that did not just happen, over three cards
   * that may not be the ones it was about — with the button claiming they were already wished
   * for. Cleared during render, which is React's own answer to state that has to follow a prop
   * (`Cover`'s art, the add target's category).
   *
   * **What this deliberately does not close:** press at 3, add a copy, press again at 4, and the
   * original three are folded on top of themselves — 7 wished for a 4-copy shortfall. Knowing
   * better needs knowing what is *already* wished, which is a wishlist read this strip does not
   * make: {@link MissingWrite} is narrowed to the one command on purpose, and a second query
   * here would be a second answer to "what does this deck need" that could disagree with the
   * first. The floor is "one press per shortfall", and it is a floor rather than a fix.
   *
   * **It records the destination beside the shortfall since issue #437, and that pair is the
   * whole of the rule.** The fold this latch exists to prevent is `add_wish`'s, and `add_wish`
   * folds on the wishlist's own grain — whose fourth term is `coalesce(folder_id, 0)`. So the
   * same shortfall sent to the root and then to `Ordered` is not a fold at all: it is a
   * genuinely new line, in a place the reader has just chosen, and a button still greyed with
   * *This shortfall is already on your wishlist.* would be refusing a press that has not
   * happened. Released when **either** term changes, for the one reason both are here: a
   * changed question is a changed question whichever half of it moved.
   *
   * **A pair rather than two `useState`s**, so the release cannot reach one and miss the other
   * — and cleared during render like the number alone always was, which is React's own answer
   * for state that has to follow a prop and is what keeps the released answer from coming back.
   */
  const [sentFor, setSentFor] = useState<{ missing: number; folderId: number | null } | null>(
    null,
  );
  if (sentFor !== null && (sentFor.missing !== stats.missing || sentFor.folderId !== folderId)) {
    setSentFor(null);
  }
  const spent = sentFor !== null && !send.isError;

  // The disabled-on-press hazard, in the shape it takes outside a dismissible layer: a browser
  // blurs a control that disables itself, with no `relatedTarget` at all, so the caret lands on
  // `<body>` and the reader's next Tab restarts from the top of the app. The button is still
  // here when the write settles, so it takes the caret back — and only from `<body>`, because a
  // reader who has moved on in the meantime owns where they are.
  //
  // **Left unconditional on a virtual deck rather than gated**, because it already is: the ref is
  // attached by a button {@link Missing} never draws there, so `sendRef.current` is `null` and the
  // hand-back is a no-op. Adding `tracksCollection` to the guard would be a second statement of a
  // fact the ref already carries — and the effect cannot be *skipped*, since a hook called from a
  // branch is a hook called conditionally.
  const pending = send.isPending;
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      sendRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  // Only while the answer is still about the shortfall on screen: a sentence that outlives its
  // own question is a sentence the reader reads as being about the deck they have now.
  const added = spent && send.isSuccess ? (send.data ?? 0) : null;
  const failure = send.isError ? ipcError(send.error) : null;

  return (
    <section
      aria-label={STATS_HEADING}
      className="flex shrink-0 flex-col gap-3 border-t border-border pt-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(!open)}
          className={cn("flex items-center gap-1.5 rounded-md text-sm", PRESS, FOCUS)}
        >
          {/* One glyph rotated, never two swapped: a different element in the same slot
              teleports rather than turning. `SortableHeader`'s rule, and `DeckTokensPanel`
              draws its own disclosure character for character the same way. */}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {STATS_HEADING}
        </button>
      </div>

      {/* **Always in the tree, empty while shut**, so `aria-controls` always resolves — the
          tokens band's own arrangement, and the reason a reader's screen reader is never told
          about a region that is not there. */}
      <div id={bodyId}>
        {open &&
          (stats.copies === 0 ? (
            <p className="text-sm text-dim">
              Nothing to measure yet — add a card and the charts fill in.
            </p>
          ) : (
            // **Two columns that wrap rather than a container query**, which is a deliberate
            // refusal: `container-type: inline-size` makes its box the containing block for
            // every `fixed` descendant, and the Collection card below holds controls that open
            // anchored layers. A wrap costs nothing and cannot reparent a scrim.
            //
            // The columns wrap rather than truncate for the reason the old band's clusters did:
            // at 1024px with the card pane docked beside the editor this is a few hundred pixels
            // wide, and a chart whose numbers are cut off is a chart that has stopped being one.
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-[22rem] flex-1 flex-col gap-3">
                <ManaPips stats={stats} />
                <CardDistribution cards={cards} separateXGroup={separateXGroup} />
              </div>
              <div className="flex min-w-[22rem] flex-1 flex-col gap-3">
                <ManaCurveChart stats={stats} />
                <CurveByColor stats={stats} />
                <DeckFigures
                  stats={stats}
                  marketplace={marketplace}
                  tracksCollection={tracksCollection}
                  theory={theory}
                />
                {/* **The whole shortfall half, or none of it** — the three presses, the
                    destination picker and the two answer lines are one component precisely so
                    that a deck with no binder behind it can be given none of them in one place.
                    A virtual deck's rows are live rows with `ownedQuantity: 0`, so every one of
                    those sentences would be true of the arithmetic and false about the reader.

                    **And nothing to be short of is nothing to draw**: every control in here is
                    already gated on `missing > 0`, so without this test the card would be a
                    heading over an empty box on every finished deck. What a reader gets instead
                    is the Figures card's `every copy` note directly above — the same fact, said
                    once, by the readout whose job is facts. */}
                {tracksCollection && stats.missing > 0 && (
                  <StatsCard title={COLLECTION_HEADING}>
                    <Missing
                      stats={stats}
                      pending={send.isPending}
                      spent={spent}
                      folderId={folderId}
                      onFolderChange={setFolderId}
                      onSend={() => {
                        setSentFor({ missing: stats.missing, folderId });
                        send.mutate(folderId);
                      }}
                      onPull={onPull}
                      onAddMissing={onAddMissing}
                      sendRef={sendRef}
                      added={added}
                      failure={failure}
                    />
                  </StatsCard>
                )}
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

/**
 * What the deck is short of, and the three presses that do something about it.
 *
 * The buttons are absent when there is nothing missing — a control that spends its life offering
 * to do nothing teaches the reader to stop looking at the line it is in — and the sentence
 * that replaces it is still a fact worth having: a deck you own every card of is the answer to
 * the question this line asks.
 *
 * **Three presses because the shortfall has three answers, and the row's order is the
 * recommendation.** What you have *already* got is sitting in a binder and can be moved; what you
 * have *just* got is cardboard the database has never heard of and is recorded; what you have
 * *not* got goes on a shopping list. Own it → just bought it → have not bought it, and every
 * reordering of that puts a later state in front of an earlier one — "buy these" ahead of "you
 * already own these", or a shopping list ahead of "record what you bought".
 *
 * That symmetry is the whole argument for these controls being here rather than in the editor's
 * header — that row already gives up its longest word at `SETTINGS_ICON_PX` and measured 825px
 * against the ~729 the ribbon can spare with five buttons on it, and a control belongs beside the
 * number it acts on rather than beside the other things a reader presses once a session.
 *
 * **The third one costs this row nothing to hold**, which is why width was never the question:
 * the line is `flex-wrap`, so it wraps rather than overflowing, and that is the same property
 * that let the pull in rather than sending it to the header.
 *
 * **Nothing here knows about a virtual deck, and that is deliberate**: `tracksCollection` is read
 * once at {@link DeckStats}, which draws this component or does not. A fourth arm inside these
 * hundred lines would be a fourth way for the count, the buttons and the two answer lines to come
 * apart from each other — and the whole point is that they arrive and leave together.
 *
 * **The `All N owned.` fallback is gone, and it was deleted rather than moved** (2026-09-10). It
 * was the other arm of the count's ternary: nothing missing, so a dim line saying so where the
 * three presses would be. The band draws this component inside its `Collection` card and gates
 * that card on `missing > 0`, because every control in here is already gated on it — without the
 * gate the card would be a heading over one sentence on every finished deck. That sentence is the
 * Figures card's `every copy` note directly above, which is the same fact said by the readout
 * whose job is facts. So the arm became unreachable and unreachable code that looks like a feature
 * is worse than none.
 *
 * **The destination is a fourth control and emphatically not a fourth peer** (issue #437). The
 * three above are three *answers* to the shortfall and their class lists are identical character
 * for character so the row cannot drift into looking like a primary and two secondaries; a
 * picker that said where the shopping list is filed would be a fourth box in that line reading
 * as a fourth answer, and it would sit between two of them or after all three whatever order it
 * took. So it is drawn **inside** the wishlist press's own cluster —
 * `[Send missing to wishlist] [♥ Wishlist ▾]`, one flex item at a tighter gap than the row's own
 * — which leaves the three peers three peers, keeps the narrated order (own it → just acquired →
 * not yet owned) untouched, and puts the modifier beside the press it modifies rather than
 * beside the presses it does not.
 *
 * **Not a joined pair**, which is the shape this app already has for `Import|Export` and
 * `Theory|Actual`: those two are *alternatives* sharing one edge, and one of them is always the
 * answer. This is a press and a setting for it, so each keeps its own border and 4px of air says
 * they belong together where the row's 12px says the peers do not.
 *
 * **It rides with the send button and therefore with the whole `missing > 0` arm.** A deck short
 * of nothing draws no press for a destination to modify, so a picker left standing would be a
 * control about a press that is not there. On the **theory** list it stays, because the wishlist
 * button stays: wanting a card you do not own is exactly what a plan is for, and a plan's
 * shopping list is as filable as any other.
 */
function Missing({
  stats,
  pending,
  spent,
  folderId,
  onFolderChange,
  onSend,
  onPull,
  onAddMissing,
  sendRef,
  added,
  failure,
}: {
  stats: DeckStatsSummary;
  pending: boolean;
  /** This shortfall has already been sent **to this destination**. Pressing again would wish for
   *  the same copies a second time — `add_wish` folds quantities rather than replacing them, and
   *  it folds at a grain that carries the folder, which is why the latch carries it too. */
  spent: boolean;
  /** Where a press files its wishes — a `wishlist_folders.id`, or `null` for the root. Held by
   *  {@link DeckStats} beside the latch it releases; see the state's own doc there. */
  folderId: number | null;
  onFolderChange: (folderId: number | null) => void;
  onSend: () => void;
  /** Opens the pull dialog, or `null` where there is nothing to open — see the prop on
   *  {@link DeckStats}, which is where the theory list's absence is argued. */
  onPull: (() => void) | null;
  /** Opens the add-missing dialog, or `null` for the same absence its neighbour has — see the
   *  prop on {@link DeckStats}. */
  onAddMissing: (() => void) | null;
  sendRef: RefObject<HTMLButtonElement | null>;
  added: number | null;
  failure: string | null;
}) {
  const tip = useTooltip();
  /**
   * The folder's own name, for the sentence the live region says.
   *
   * **Read live off the current `folderId` rather than frozen at the press, and the latch is what
   * makes that safe.** `added` is non-null only while `spent` is, and `spent` is released the
   * moment the destination changes — so for every render in which there is a sentence to say,
   * this `folderId` *is* the one that was sent. Freezing a copy would be a second record of the
   * same fact, free to disagree with the control on screen.
   *
   * `null` covers three states on purpose and all three want the same sentence: the wishlist
   * root, a folder list still loading, and an id that names no folder any more. The first is
   * what the reader chose; the other two are this strip not knowing a name, and inventing *to a
   * folder* for either would be a clause that says nothing and could be wrong.
   *
   * **The one read this component makes that is not the shortfall, and it is the folder list
   * rather than the wishlist.** See {@link MissingWrite} — a second answer to *what does this
   * deck need* is what the narrowing refuses, and a list of drawers is not one.
   */
  const destination = useWishDestinationName(folderId);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {stats.missing > 0 ? (
        <>
          {/* One text node, in the data face: this is a count with two words attached, and
              splitting it across styled spans would make it a sentence no matcher — screen
              reader, test or reader skimming — reads as one. */}
          <p className="font-mono tabular-nums text-destructive">
            {count(stats.missing)} of {count(stats.copies)} missing
          </p>
          {/* **First of the three, because it is the cheapest answer.** A hole a reader can fill
              out of their own binder is one they should be offered before they are offered a
              shopping list for it — the order of the row is the recommendation, and reversing it
              would put "buy these" in front of "you already own these".

              **Drawn only inside the `missing > 0` arm, like both its neighbours**: a deck short
              of nothing has no hole for a pull to fill, and `deck_pull_plan` would answer zero
              rows by construction. So the three controls appear and disappear together, and the
              line never draws one of them alone.

              `null` is the second, separate absence — a list with no cards in it at all — and it
              is argued at {@link DeckStats}' own prop.

              **`aria-haspopup` without `aria-expanded`, deliberately.** This strip is handed a
              callback and is never told what came of it, and the state is not one a reader can
              observe from here anyway: the layer it opens is a full-window overlay, so while it
              is up this button is behind a scrim and off the tab order. Saying "expanded" about
              a control nobody can reach would be a second prop for a claim with no observer. */}
          {onPull !== null && (
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={onPull}
              // **Not disabled while the wishlist write is in flight**, which is the one thing a
              // reader of these three lines has to get right: they are independent writes about
              // the same number, and the half-second `send` spends disabling itself is no reason
              // this control cannot be pressed. It has no pending state of its own either — the
              // press opens a dialog, and the write it leads to is made in there.
              //
              // The class list is its neighbours', character for character, including the two
              // state variants nothing here can currently reach. They are copied rather than
              // trimmed so that the row cannot drift into looking like a primary and two
              // secondaries: these are peers, and the day one of them grows a "no" it will grey
              // exactly as the third already does.
              className={cn(
                "rounded-md border border-border px-2 py-1 text-dim",
                "transition-colors duration-150 hover:text-text disabled:opacity-50",
                "aria-disabled:opacity-50 aria-disabled:hover:text-dim",
                "motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Pull from collection
            </button>
          )}
          {/* **The middle of the three, and the position is the argument.** The row reads own it
              → just acquired → not yet owned, so this press sits between the binder a hole can be
              filled out of and the shopping list it would otherwise go on. Moved after its right
              neighbour it would put "buy these" in front of "record what you bought", which is
              two states of one purchase in the wrong order.

              **Drawn only inside the `missing > 0` arm, like both its neighbours**, and `null` is
              the same second absence the pull's prop argues at {@link DeckStats} — the theory
              list, which holds no cardboard for this press to record copies into. The shortfall
              beside it is real on that tab since 2026-09-09 (issue #435); what is absent is the
              place to put the answer, not the question.

              **`aria-haspopup` without `aria-expanded`, for the pull's reason**: the layer it
              opens is a full-window overlay, so while it is up this button is behind a scrim and
              off the tab order, and saying "expanded" about a control nobody can reach would be a
              claim with no observer.

              **Two things it deliberately lacks, and they are the whole of what makes it not its
              right-hand neighbour.** It has **no `spent` state**: `missing_to_wishlist` folds
              quantities rather than replacing them, so a second wishlist press wishes for the
              same copies twice and the button has to be spent until the deck says something new —
              where this press re-plans inside its own transaction against a shortfall the first
              one just closed, and a second press finds nothing left to offer. And it takes **no
              `disabled` from the wishlist write being in flight**: these are three independent
              writes about one number, and the half-second `send` spends disabling itself is no
              reason this control cannot be pressed. It has no pending state of its own either —
              the press opens a dialog, and the write it leads to is made in there.

              The class list is its two neighbours', character for character, including the two
              state variants nothing here can currently reach. Copied rather than trimmed so the
              three cannot drift into looking like a primary and two secondaries: they are peers,
              and the day one of them grows a "no" it will grey exactly as the third already
              does. */}
          {onAddMissing !== null && (
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={onAddMissing}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-dim",
                "transition-colors duration-150 hover:text-text disabled:opacity-50",
                "aria-disabled:opacity-50 aria-disabled:hover:text-dim",
                "motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Add missing to collection
            </button>
          )}
          {/* **No `<span>` wrapper — bound on the button itself.** A wrapper earns its keep only
              for a control that is genuinely `disabled` for as long as the hint would need to be
              read, because a real `disabled` attribute fires no pointer events and drops the tab
              stop. **This button is not that**: `spent` — the state the hint's words are
              about — is `aria-disabled`, deliberately never the attribute (see the comment on it
              below), so it stays exactly as focusable and exactly as hoverable as an ordinary
              button while the hint is true. A wrapper here bought nothing for that state and
              cost the keyboard path: `useTooltip.ts`'s `focus()` tests `:focus-visible` on the
              element `tip()` was spread onto, and a bare `<span>` is never focused, so Tab onto
              this button used to open nothing at all. The one case a wrapper genuinely helps —
              the ~500ms `disabled={pending}` window right after the press, when `spent` and
              `pending` are briefly both true — is not a real loss to leave uncovered: the pointer
              was already resting on the button before that click fired (nothing opens on a
              content change alone, only on a fresh `pointerenter`), and a keyboard reader loses
              nothing a `disabled` button was ever going to offer it either. */}
          {/* **The wishlist press and its destination, as one cluster** (issue #437) — `gap-1`
              inside against the row's own `gap-x-3`, which is the whole of what says these two
              belong to each other and the three buttons do not. It is a flex item of the row
              like each peer is, so it wraps as one thing: a picker that wrapped away from the
              button it modifies, onto a line with the pull, would read as a fourth answer to the
              shortfall — which is exactly what drawing it as a fourth peer would have done, one
              breakpoint later.

              **The order inside is press-then-setting**, so the row still reads left to right as
              the three answers in the order they should be tried, with this one's modifier
              trailing it. Put the picker first and the eye meets a folder name before it has met
              the press that would file anything there. */}
          <div className="flex items-center gap-1">
            <button
              ref={sendRef}
              type="button"
              // Two kinds of "no", and they are spelled differently on purpose. `disabled` is the
              // half-second the write is in flight. **Spent is `aria-disabled`**, because it
              // outlasts the press by as long as the deck and the destination stay the same: a
              // real `disabled` there is a control the browser refuses to focus, so the caret
              // this button lost when it disabled itself could never come back to it, and a
              // keyboard reader would find the control simply gone from the tab order with no
              // way to ask why. The rail in the docked search panel says no the same way, for
              // the same reason.
              disabled={pending}
              aria-disabled={spent || undefined}
              onClick={() => {
                if (!spent) onSend();
              }}
              {...tip(spent ? "This shortfall is already on your wishlist." : null)}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-dim",
                "transition-colors duration-150 hover:text-text disabled:opacity-50",
                "aria-disabled:opacity-50 aria-disabled:hover:text-dim",
                "motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Send missing to wishlist
            </button>
            {/* **Always drawn, even for a reader with no folders at all**, which is the
                component's own guarantee and is what makes the first folder reachable: its
                `New folder…` row is the only way into a cabinet that is empty.

                **`disabled` for the half-second the write is in flight, where the other two
                presses in this row deliberately are not.** They are independent writes about one
                number, so greying them on this one would be a control refusing for something the
                reader did not press. This is not independent of it: it *is* the argument the
                write in flight is carrying, and moving it mid-flight releases the latch — so the
                answer to a press that really happened would never be said. Half a second of no,
                against a sentence silently lost.

                The name is a whole sentence and names **this deck's** shortfall rather than the
                wishlist in general, because the Compare dialog draws its own destination over
                this strip while the strip is still in the DOM behind the scrim — and a name
                collision is a property of what is on screen together. `Sort decks` over the
                editor's `Sort`, one control over. */}
            <WishDestination
              folderId={folderId}
              onChange={onFolderChange}
              label="Which wishlist folder this deck's shortfall goes to"
              size="sm"
              disabled={pending}
            />
          </div>
        </>
      ) : null}

      {/* Mounted for the life of the strip and swapped into: a live region that appears
          together with its own text announces nothing, because there was no change for a
          screen reader to notice (the decks gallery's lesson).

          **A wish is a card, and the shortfall beside it is copies** — one wish for three
          missing Bolts — so the sentence says which it is counting rather than leaving two
          numbers on one line to be read as the same unit.

          Zero is **not** "they were already wished for": `missing_to_wishlist` counts the
          shortfall from a freshly reallocated deck, before it writes anything, and skips a row
          with no `oracle_id`. So zero means the recount found nothing short (the strip's own
          number was one edit stale) or that everything short is an orphaned printing, which
          cannot be wished for at all — and saying "already on your wishlist" would be telling
          the reader the one thing that is certainly not what happened.

          **It says where, and only where there is a where to say** (issue #437). At the root the
          sentence is what it has always been — a reader who never opened the picker gets exactly
          today's words, and `to Wishlist` would be this app naming a place a reader has not been
          asked to think about. At a folder it names it, in one clause after the count, because
          the whole of what the destination changed about the press is where those wishes landed
          and a reader who filed them somewhere has to be told it worked *there*.

          **The zero arm names no folder, deliberately.** Nothing was written, so there is no
          place anything went — a folder named on that line would say a drawer received something
          when the sentence's whole job is to say the opposite. That the picker was pointing
          somewhere is not a fact about a write that did not happen.

          **The refusal line below names none either**, for the near half of the same reason: a
          refused write filed nothing anywhere, and the one refusal a destination can cause
          (`That folder is not there any more.`) is quoted verbatim and says so better than a
          prefix could. */}
      <p role="status" className="text-dim">
        {added === null
          ? ""
          : added === 0
            ? "Nothing to add — a recount covered the shortfall, or what is short has left the card database."
            : `Added ${count(added)} ${added === 1 ? "wish" : "wishes"}${destination === null ? "" : ` to ${destination}`} — one per card, for every copy you are short.`}
      </p>

      {/* Beside the button that was pressed, not in the editor's banner: that one speaks for
          the three writes the deck's own controls make, and a refusal reported somewhere else
          is a refusal the reader has to go looking for.

          The line is its own animated element — it carries no padding and no border, so
          `height: 0` really is 0 — and `overflow-hidden` is still owed, because the sentence
          is laid out at full size whatever the box around it is doing. */}
      <AnimatePresence initial={false}>
        {failure && (
          <motion.p {...statusLine} role="alert" className="overflow-hidden text-destructive">
            Could not add to the wishlist — {failure}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
