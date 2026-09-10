/**
 * How a pile of deck rows is cut into named buckets — the vocabulary the stats band's Card
 * distribution bars and its Opening hand odds table both read.
 *
 * **One module, because the two surfaces are one control.** The `by` select sits in the Card
 * distribution header and drives the bars *and* the odds table under them; a reader who sets it
 * to `Categories` is asking one question and must not get two answers. The design this was built
 * from wired the select to the table alone and left the bars on card type — which reads as a
 * control that does nothing to the chart it is drawn inside, and is the one place this
 * implementation deliberately departs from it.
 *
 * **The two surfaces still count different rows, and that is not a contradiction.** The bars are
 * over every **active** pile, because a sideboard is cards you own and sleeve; the odds are over
 * the **sized** piles alone, because a card in the sideboard is not in the deck you are drawing
 * your opening seven from. {@link activeCards} and {@link sizedCards} are those two readings,
 * named once here so a chart and a table cannot come to disagree about which is which.
 *
 * The type-line vocabulary also lives here — `TYPE_BUCKETS`, `front`, `isLand` and `typeCounts`
 * were `DeckStats.tsx`'s until the distribution needed them too, and a second spelling of "is
 * this a land" is exactly how two charts come to disagree about Urza's Saga.
 */
import type { DeckCard } from "@/lib/ipc";
import { hasVariableCost } from "@/lib/mana";
import { X_GROUP_KEY, X_GROUP_NAME } from "./grouping";
import { manaValueOf, SIZE_KINDS } from "./validation/engine";

/**
 * The eight card types, in the order they are printed on the type line, and the word each bucket
 * is named by.
 *
 * Order is the whole of the rule for a card with two types: an Artifact Creature is a creature to
 * everyone who has ever built a deck, and `Creature` comes first here. `Land` is last of the
 * eight for the same reason it is last in a decklist — it is where the counting ends.
 *
 * **Deliberately not `autoCategory.ts`'s list, though the eight words are the same.** That one
 * checks `Land` *first*, because it decides where a card is filed and Dryad Arbor
 * (`Land Creature — Forest Dryad`) belongs in the lands. These are bars over a distribution, where
 * the question is what a card *does*: an artifact land heads up the Artifact bar and Urza's Saga
 * the Enchantment bar, which is the reading {@link isLand} below then contradicts on purpose for
 * every other chart. That disagreement is named in `isLand`'s doc and pinned from **both** ends —
 * `heads the Enchantment, Artifact and Creature bars with lands` for this order, and
 * `keeps a land that is not filed under Land a land to the curve` for the other. Folding the two
 * together breaks whichever job loses, and one test could only ever see one of them.
 */
export const TYPE_BUCKETS = [
  "Creature",
  "Planeswalker",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Battle",
  "Land",
] as const;

/** Where a token, a scheme, or a row whose printing has left the card database goes. */
export const OTHER = "Other";

/**
 * The nine **numeric** curve buckets — 0 through 7 exactly, and 8 open-ended, which is the
 * bucketing the mana-value filter chips and `grouping.ts`'s mana-value grouping already use.
 *
 * The X bar that can ride behind them is not one of these — see `DeckStatsSummary.variableCost`.
 */
export const CURVE_BUCKETS = 9;

/** One named pile of copies: what it is, what it is called, and how many cards are in it. */
export interface Bucket {
  /** Stable across renders and unique within one distribution — a React key, and what a caller
   *  addresses a bucket by. Never shown. */
  key: string;
  /** The word under the bar and in the table's first column. */
  label: string;
  /** **Copies, never rows.** Four Bolts are four cards. */
  count: number;
}

/** The front face's type line. A modal double-faced card's back is routinely a land while its
 *  front is a spell, and a deck is cast from the front. */
export function front(typeLine: string | null): string {
  return (typeLine ?? "").split("//")[0];
}

/**
 * Whether this row is a land — and it is the **type line** that decides, not the bucket the deck
 * list files it under.
 *
 * The two readings genuinely differ, and the difference is Urza's Saga (a Legendary Enchantment
 * Land), Tree of Tales (an Artifact Land) and Dryad Arbor (a Land Creature): the type bars file a
 * card under the *first* type printed on it, so all three head up the Enchantment, Artifact and
 * Creature bars — which is right for the bars, because those are the headings the reader already
 * sees over the rows.
 *
 * It is wrong everywhere else. A deckbuilder counts Urza's Saga among their lands, so a "Lands 12"
 * over a twenty-land Affinity deck is simply a false number; and all three cost nothing to put
 * onto the battlefield, so the curve would file them under 0 — which is the flood the curve
 * excludes lands to avoid in the first place. So the land/nonland split (the Lands figure, the
 * curve, the average, the per-colour curves) asks the type line, the type bars keep the deck
 * list's own answer, and the one place they disagree is named here.
 */
export function isLand(typeLine: string | null): boolean {
  return front(typeLine).includes("Land");
}

/**
 * A row's own mana value: the synced column when there is one, the printed cost when there is
 * not, and `null` for a row that has neither.
 *
 * The same fallback `engine.ts` measures Tiny Leaders' ceiling with, through the same exported
 * arithmetic — two implementations of `{2/W}` would eventually disagree about a card.
 */
export function cardManaValue(card: DeckCard): number | null {
  if (card.cmc !== null) return card.cmc;
  return card.manaCost === null ? null : manaValueOf(card.manaCost);
}

/** Which of the nine numeric buckets a mana value falls in — 8 is open-ended. */
export function curveBucket(manaValue: number): number {
  return Math.min(CURVE_BUCKETS - 1, Math.max(0, Math.floor(manaValue)));
}

/** The word under bucket `i` of a curve: `0`…`7`, then `8+`. */
export function curveLabel(bucket: number): string {
  return bucket === CURVE_BUCKETS - 1 ? `${bucket}+` : `${bucket}`;
}

/**
 * Which of a card's types names its bucket — the **front** face's first printed type, in
 * {@link TYPE_BUCKETS}' order, and {@link OTHER} for a card that matches none.
 *
 * `type_line` carries both sides of a double-faced card separated by `//`, and the back of a modal
 * DFC is routinely a land while its front is a spell. A deck's curve is cast from the front.
 */
export function typeBucket(typeLine: string | null): string {
  const line = front(typeLine);
  return TYPE_BUCKETS.find((bucket) => line.includes(bucket)) ?? OTHER;
}

/**
 * Copies in every **active** pile — the rows every chart in the stats band is drawn over.
 *
 * One flag rather than a kind test, and it is the same line `validateDeck` opens with: a pile
 * switched off counts toward nothing whatever it is called and whatever kind it is. A Maybeboard
 * the reader switched *on* is counted like any other pile, and a pile of their own they switched
 * off is not.
 */
export function activeCards(cards: readonly DeckCard[]): DeckCard[] {
  return cards.filter((card) => card.categoryActive);
}

/**
 * Copies in the active piles whose **kind** the format's size rule counts — `engine.SIZE_KINDS`,
 * imported rather than restated.
 *
 * **This is the deck you draw an opening hand from**, and it is a smaller number than
 * {@link activeCards} on purpose: a sideboard is cards you own, sleeve and pay for, and it is not
 * in the library when you take your seven. Kinds and not categories, because a deck may own any
 * number of `main` piles — what a card is *for* is the kind, what it is *called* is the reader's.
 *
 * Summed, this is `DeckStatsSummary.sized`, and a test pins the two together: the odds table's
 * denominator and the Cards figure over it must be one number or the table is answering about a
 * deck the reader is not being shown.
 */
export function sizedCards(cards: readonly DeckCard[]): DeckCard[] {
  return cards.filter((card) => card.categoryActive && SIZE_KINDS.includes(card.categoryKind));
}

/**
 * How the reader has asked the cards to be cut.
 *
 * **Stored as a key, drawn as a word**, so a label can be reworded without invalidating a
 * reader's state and so a switch over the union is exhaustive.
 */
export type DistributionBy = "types" | "categories" | "manaValue" | "cardName";

/**
 * The four cuts, in the order the control offers them.
 *
 * **Not through `sortOptions`, and the exemption is the first of the two this app grants: the
 * order _is_ the information.** These are a ladder of grain — every card is one of eight types,
 * most decks keep a handful of categories, a curve is nine buckets, and a name is one card — so
 * reading down the list is reading from the coarsest answer to the finest. The alphabet would
 * open on `Card name`, which is the one cut that is unreadable as bars and the last a reader
 * reaches for, and would put `Types` last.
 *
 * `src/CLAUDE.md` asks that an exempt list say at its own site which of the two kinds it is
 * rather than trusting a census written elsewhere. This is that sentence.
 */
export const DISTRIBUTION_MODES: readonly { value: DistributionBy; label: string }[] = [
  { value: "types", label: "Types" },
  { value: "categories", label: "Categories" },
  { value: "manaValue", label: "Mana value" },
  { value: "cardName", label: "Card name" },
];

/** The heading over the first column of the odds table, for each cut. Singular, because it names
 *  what one row *is* rather than what the list holds. */
export const DISTRIBUTION_HEADING: Record<DistributionBy, string> = {
  types: "Type",
  categories: "Category",
  manaValue: "Mana value",
  cardName: "Card",
};

/** Where a row with neither a `cmc` nor a printed cost lands in the mana-value cut. Filing it
 *  under 0 would put a number this app invented at the head of the reader's cheapest spells. */
const NO_MANA_VALUE = "No mana value";

/**
 * The rows, cut by `by`, in **that cut's own natural order** — copies per bucket.
 *
 * Natural order and not by size, because each cut has an order that means something: types run as
 * they are printed, mana values ascend, categories arrive in the reader's own `sortOrder`. Only
 * `cardName` has no inherent order, and it falls back to most-copies-first. The odds table sorts
 * for itself — a ranked list answers *what am I most likely to draw*, which is a different
 * question from *what is this deck made of*.
 *
 * **Empty buckets are never invented.** A deck with no planeswalkers has no planeswalker bar,
 * which is the same rule the pies used to keep — a chart of zeroes is a chart that has stopped
 * saying anything.
 *
 * @param separateXGroup the deck's own flag, and it must be **the same value the grouping beside
 * the chart was built with**. A distribution that counts `{X}{B}{B}{B}` as mana value 3 while the
 * column next to it is headed "Mana value X" is two surfaces answering one question two ways;
 * `X_GROUP_KEY` and `X_GROUP_NAME` are imported from `grouping.ts` rather than respelled so the
 * bar and the heading cannot drift apart.
 */
export function distribution(
  cards: readonly DeckCard[],
  by: DistributionBy,
  separateXGroup = false,
): Bucket[] {
  if (by === "types") return typeCounts(cards);
  if (by === "categories") return categoryCounts(cards);
  if (by === "cardName") return nameCounts(cards);
  return manaValueCounts(cards, separateXGroup);
}

/**
 * The type buckets: one per bucket something is in, in {@link TYPE_BUCKETS}' order.
 *
 * Exported for its test and for {@link distribution}: it is the band's arithmetic, and a chart is
 * only as trustworthy as arithmetic somebody has checked.
 */
export function typeCounts(cards: readonly DeckCard[]): Bucket[] {
  const order = new Map<string, number>();
  const counts = new Map<string, Bucket>();

  for (const card of cards) {
    const label = typeBucket(card.typeLine);
    const at = TYPE_BUCKETS.indexOf(label as (typeof TYPE_BUCKETS)[number]);
    const key = label.toLowerCase();

    const seen = counts.get(key);
    if (seen) seen.count += card.quantity;
    else {
      order.set(key, at < 0 ? TYPE_BUCKETS.length : at);
      counts.set(key, { key, label, count: card.quantity });
    }
  }

  return [...counts.values()].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/**
 * Copies per category, in the read's own order.
 *
 * **Keyed by id and never by name**, because a deck may hold two piles called the same thing —
 * `deck_categories` has no unique index on the word — and folding them together would be one bar
 * silently standing for two piles the reader keeps apart on purpose. The label is still the name,
 * so two bars may read alike; that is the reader's own naming and not this module's to correct.
 *
 * A `Map`'s insertion order is the read's, which is category `sortOrder` then the row's name then
 * its id — so a pile appears where its first row does.
 */
function categoryCounts(cards: readonly DeckCard[]): Bucket[] {
  const counts = new Map<number, Bucket>();
  for (const card of cards) {
    const seen = counts.get(card.categoryId);
    if (seen) seen.count += card.quantity;
    else
      counts.set(card.categoryId, {
        key: `cat-${card.categoryId}`,
        label: card.categoryName,
        count: card.quantity,
      });
  }
  return [...counts.values()];
}

/**
 * Copies per mana value — 0…7, `8+`, optionally an `X` bucket, and `No mana value` for a row that
 * has neither a synced `cmc` nor a printed cost.
 *
 * **Lands are counted, and that is the one place this cut deliberately disagrees with the mana
 * curve above it.** The curve is a chart about *spells*: it excludes lands because a twenty-land
 * deck otherwise reads as twenty cards costing nothing, which is the flood the curve exists to
 * show you avoiding. This is a chart about *cards*, and a Swamp is a card of mana value zero. A
 * reader asking "how many of my cards cost nothing" while holding a manabase is asking about the
 * manabase.
 */
function manaValueCounts(cards: readonly DeckCard[], separateXGroup: boolean): Bucket[] {
  const numeric = Array<number>(CURVE_BUCKETS).fill(0);
  let variable = 0;
  let unknown = 0;
  for (const card of cards) {
    const mv = cardManaValue(card);
    if (mv === null) {
      unknown += card.quantity;
      continue;
    }
    // One home, never two, so the buckets still sum to the pile. An unknown mana value cannot
    // reach here: `cardManaValue` answers `null` only when the row has neither a `cmc` nor a
    // printed cost, and a cost that is not there cannot name `{X}`.
    if (separateXGroup && hasVariableCost(card.manaCost)) {
      variable += card.quantity;
      continue;
    }
    numeric[curveBucket(mv)] += card.quantity;
  }

  const out: Bucket[] = numeric
    .map((count, bucket) => ({ key: `mv-${bucket}`, label: curveLabel(bucket), count }))
    .filter((bucket) => bucket.count > 0);
  // Last, and behind the open-ended bucket: X is not a number, so it cannot sit on the axis
  // anywhere the eye would read as a quantity.
  if (separateXGroup && variable > 0) {
    out.push({ key: X_GROUP_KEY, label: X_GROUP_NAME.replace("Mana value ", ""), count: variable });
  }
  if (unknown > 0) out.push({ key: "mv-unknown", label: NO_MANA_VALUE, count: unknown });
  return out;
}

/**
 * Copies per card **name**, summed across printings and finishes — the cut a reader asks the odds
 * table for when they want the chance of meeting one particular card.
 *
 * Names are folded case-insensitively but drawn as the row spells them, which is `theoryNameKey`'s
 * own rule one module over: the name is denormalised onto `deck_cards` at write time, so two rows
 * of one card that arrived from two imports can differ in casing and are still one card.
 *
 * Most copies first, then alphabetical — the only cut of the four with no order of its own.
 */
function nameCounts(cards: readonly DeckCard[]): Bucket[] {
  const counts = new Map<string, Bucket>();
  for (const card of cards) {
    const key = card.name.trim().toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.count += card.quantity;
    else counts.set(key, { key: `name-${key}`, label: card.name, count: card.quantity });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The bars, capped — the widest `limit` buckets kept in their own order, everything else summed
 * into one trailing `Other`.
 *
 * **A bar chart is read against its neighbours, and past a dozen columns there are no neighbours
 * to read against** — sixty one-pixel columns under sixty unreadable labels is not a chart, it is
 * a texture. That case is reachable the moment the `by` select offers `Card name`, which on a
 * 60-card deck is 25 to 40 distinct names.
 *
 * **The kept buckets keep the cut's own order, not their rank.** Types stay in printed order and
 * mana values stay ascending; what the count decides is only *which* survive, never where they
 * sit. A chart that reordered itself as the reader edited would be unreadable for a different
 * reason.
 *
 * **The odds table is deliberately not folded.** A table scrolls and a row of it is legible at any
 * length, so the reader who set the cut to `Card name` to find one card's odds still finds it —
 * the cap is a fact about bars, not about the cut.
 *
 * Nothing is folded when the fold would not shorten the list: `limit + 1` buckets become
 * `limit` plus an `Other` standing for exactly one bucket, which is a bar that has been renamed
 * rather than summarised, so the guard is `> limit + 1`.
 */
export function foldBuckets(buckets: readonly Bucket[], limit: number): Bucket[] {
  if (limit <= 0 || buckets.length <= limit + 1) return [...buckets];
  const ranked = [...buckets].sort((a, b) => b.count - a.count);
  const kept = new Set(ranked.slice(0, limit).map((bucket) => bucket.key));
  const out = buckets.filter((bucket) => kept.has(bucket.key));
  const rest = buckets
    .filter((bucket) => !kept.has(bucket.key))
    .reduce((n, bucket) => n + bucket.count, 0);
  if (rest > 0) out.push({ key: "fold-other", label: OTHER, count: rest });
  return out;
}

/** How many bars the Card distribution draws before it folds the rest into `Other`. Twelve is
 *  what stays legible across the editor's narrowest useful width with a label under each. */
export const DISTRIBUTION_BAR_LIMIT = 12;
