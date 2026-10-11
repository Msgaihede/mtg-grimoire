import type {
  Trade,
  TradeFinishOptions,
  TradeLine,
  TradeOutcome,
  TradeSide,
  TradeStatus,
  TradeSummary,
  TradeSummaryLine,
} from "@/lib/ipc";

/**
 * Every conclusion the Trade page draws from the facts Rust hands it.
 *
 * **Rust supplies a unit price per line; this module does the rest, in integer cents.** A float
 * sum of prices drifts by a cent somewhere past a dozen lines, and a trade is two people looking
 * at one number — so a price becomes cents once, at the door ({@link toCents}), and nothing after
 * that is a float until {@link fromCents} hands a figure to `formatPrice`.
 *
 * **A percentage is applied to the unit, then multiplied.** `round(unit × rate / 100) × quantity`,
 * never `round(total × rate / 100)`: the first is what each card costs at that rate, which is the
 * figure the two people agree on card by card, and the second can differ from the sum of those by
 * a cent per line. The list and the open trade both come through {@link tradeMoney}, so they
 * cannot disagree about it.
 */

/** The percentages a side can be priced at. */
export const RATE_MIN = 50;
export const RATE_MAX = 150;
export const RATE_STEP = 5;
export const RATE_DEFAULT = 100;

/** Whatever a slider or a stored value says, as a percentage a side can actually hold. */
export function snapRate(value: number): number {
  if (!Number.isFinite(value)) return RATE_DEFAULT;
  const stepped = Math.round(value / RATE_STEP) * RATE_STEP;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, stepped));
}

/** A price as the backend quotes it, in cents. `null` stays `null`: no price is not zero. */
export function toCents(price: number | null): number | null {
  return price === null ? null : Math.round(price * 100);
}

/** Cents back into what `formatPrice` takes. */
export function fromCents(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

/** One card's price at a side's percentage. */
export function ratedUnit(unitCents: number | null, rate: number): number | null {
  return unitCents === null ? null : Math.round((unitCents * rate) / 100);
}

/** What one line is worth. Every figure is cents, and `null` where the line has no price. */
export interface LineMoney {
  /** One copy at the side's percentage. */
  unit: number | null;
  /** The line at the side's percentage. */
  total: number | null;
  /** The line at 100% — what is drawn beside `total`, dimmed, when the two differ. */
  fullTotal: number | null;
}

export function lineMoney(
  line: Pick<TradeSummaryLine, "quantity" | "unitPrice">,
  rate: number,
): LineMoney {
  const full = toCents(line.unitPrice);
  const unit = ratedUnit(full, rate);
  return {
    unit,
    total: unit === null ? null : unit * line.quantity,
    fullTotal: full === null ? null : full * line.quantity,
  };
}

/** What one side is worth. */
export interface SideMoney {
  /** At the side's percentage, over the lines that have a price. */
  total: number;
  /** The same lines at 100%. */
  fullTotal: number;
  /** Copies, priced or not. */
  copies: number;
  /** Lines with no price. They are in `copies` and in neither total. */
  unpriced: number;
  rate: number;
  /** The side is not at 100%, so both figures are worth drawing. */
  rated: boolean;
}

export function sideMoney(
  lines: readonly Pick<TradeSummaryLine, "quantity" | "unitPrice">[],
  rate: number,
): SideMoney {
  let total = 0;
  let fullTotal = 0;
  let copies = 0;
  let unpriced = 0;
  for (const line of lines) {
    const money = lineMoney(line, rate);
    copies += line.quantity;
    if (money.total === null || money.fullTotal === null) {
      unpriced += 1;
      continue;
    }
    total += money.total;
    fullTotal += money.fullTotal;
  }
  return { total, fullTotal, copies, unpriced, rate, rated: rate !== RATE_DEFAULT };
}

/**
 * Who owes whom.
 *
 * The side that gives **less** owes the difference: if the reader's cards are worth 64.39 and
 * theirs 87.09, the reader is getting the better of it by 22.70 and owes that.
 */
export type Balance =
  | { kind: "even" }
  | { kind: "youOwe"; cents: number }
  | { kind: "theyOwe"; cents: number };

export function balanceOf(mineTotal: number, theirsTotal: number): Balance {
  const diff = theirsTotal - mineTotal;
  if (diff === 0) return { kind: "even" };
  return diff > 0 ? { kind: "youOwe", cents: diff } : { kind: "theyOwe", cents: -diff };
}

/** Both sides and the balance between them. */
export interface TradeMoney {
  mine: SideMoney;
  theirs: SideMoney;
  balance: Balance;
}

/** The one door: the trades list hands it a summary and the open trade hands it a whole trade. */
export function tradeMoney(
  trade: Pick<TradeSummary, "rateMine" | "rateTheirs"> & {
    lines: readonly Pick<TradeSummaryLine, "side" | "quantity" | "unitPrice">[];
  },
): TradeMoney {
  const mine = sideMoney(linesOf(trade.lines, "mine"), trade.rateMine);
  const theirs = sideMoney(linesOf(trade.lines, "theirs"), trade.rateTheirs);
  return { mine, theirs, balance: balanceOf(mine.total, theirs.total) };
}

export function linesOf<Line extends { side: TradeSide }>(
  lines: readonly Line[],
  side: TradeSide,
): Line[] {
  return lines.filter((line) => line.side === side);
}

export function rateOf(trade: Pick<Trade, "rateMine" | "rateTheirs">, side: TradeSide): number {
  return side === "mine" ? trade.rateMine : trade.rateTheirs;
}

/** A trade can be edited only while it is open. */
export function isOpen(status: TradeStatus): boolean {
  return status === "open";
}

/**
 * The balance as the sentence above the figure: *You owe them*, *They owe you*.
 *
 * `past` is a trade that is no longer open, whose balance is a record rather than a state — with
 * one exception the caller decides: a trade archived **without** finishing still owes, so it
 * passes `past: false`.
 */
export function balanceHeading(balance: Balance, past: boolean): string {
  if (balance.kind === "even") return "Nobody owes anything";
  if (balance.kind === "youOwe") return past ? "You owed them" : "You owe them";
  return past ? "They owed you" : "They owe you";
}

/** The balance on one line, for the trades list: *You owe $22.70*. `money` is already formatted. */
export function balanceLine(balance: Balance, past: boolean, money: string): string {
  if (balance.kind === "even") return "Even trade";
  if (balance.kind === "youOwe") return `${past ? "You owed" : "You owe"} ${money}`;
  return `${past ? "They owed you" : "They owe you"} ${money}`;
}

/** Whether a closed trade's balance is spoken in the past tense: only a finished one's is. */
export function isSettled(status: TradeStatus): boolean {
  return status === "finished";
}

/**
 * The balance bar: the reader's share, the gap, their share — three widths that sum to 100.
 *
 * The bar is split where the two totals meet, with a tick at the middle. The stretch between the
 * split and the tick is the imbalance, and it is drawn on the half of whoever owes: that side's
 * share stops short of the middle, and the gap is what would bring it there.
 */
export interface BalanceShares {
  mine: number;
  gap: number;
  theirs: number;
}

export function balanceShares(mineTotal: number, theirsTotal: number): BalanceShares {
  const sum = mineTotal + theirsTotal;
  const mine = sum > 0 ? (mineTotal / sum) * 100 : 50;
  return { mine: Math.min(mine, 50), gap: Math.abs(50 - mine), theirs: Math.min(100 - mine, 50) };
}

/** `6 cards`, `1 card`. Copies, because that is what changes hands. */
export function cardCount(copies: number): string {
  return `${copies} ${copies === 1 ? "card" : "cards"}`;
}

/** `6 for 5 cards` — the trades list's one-line shape of a trade. */
export function exchangeLine(mineCopies: number, theirsCopies: number): string {
  return `${mineCopies} for ${cardCount(theirsCopies)}`;
}

type Holding = Pick<TradeLine, "quantity" | "owned" | "ownedInDecks">;

/**
 * How many of a given line's copies the finish step can actually take out of the collection.
 *
 * `owned` is what the collection holds outside any deck and `ownedInDecks` what sits in a deck's
 * group; a line asking for more than the two together leaves the rest alone, and the dialog says
 * so before it is pressed.
 */
export function takeable(line: Holding): number {
  return Math.min(line.quantity, Math.max(0, line.owned) + Math.max(0, line.ownedInDecks));
}

/**
 * How many of a line's copies a finish would take **out of a deck**.
 *
 * Copies outside a deck go first, so this is only what is left of the line once those run out.
 * Above zero is the one thing about a trade that costs the reader something they did not put on
 * the table — a deck left a card short — which is why every surface that reads it draws it in the
 * destructive colour and names the deck.
 */
export function fromDecks(line: Holding): number {
  return Math.max(0, takeable(line) - Math.max(0, line.owned));
}

/**
 * What Finish trade opens with.
 *
 * The three that tidy up after a trade are on; putting given cards on the wishlist is a wish the
 * reader has to mean. **A trade that was finished before opens with all of them off**: the first
 * finish already moved those cards, and nothing here can tell which of them it moved.
 */
export function defaultFinishOptions(trade: Pick<Trade, "finishedBefore">): TradeFinishOptions {
  const on = !trade.finishedBefore;
  return {
    removeGiven: on,
    addReceived: on,
    folderId: null,
    unwishReceived: on,
    wishGiven: false,
  };
}

type FinishLine = Pick<
  TradeLine,
  "side" | "quantity" | "owned" | "ownedInDecks" | "deckNames" | "wished" | "name"
>;

/** Under *Take the cards you gave out of your collection*: how many it can actually take. */
export function givenNote(lines: readonly FinishLine[]): string {
  const mine = linesOf(lines, "mine");
  const copies = mine.reduce((sum, line) => sum + line.quantity, 0);
  if (copies === 0) return "There is nothing on your side.";
  const held = mine.reduce((sum, line) => sum + takeable(line), 0);
  if (held === copies) {
    return `${cardCount(copies)}. ${copies === 1 ? "It is" : "All of them are"} in your collection.`;
  }
  if (held === 0) {
    return `${cardCount(copies)}. None of them are in your collection, so nothing is taken.`;
  }
  return `${cardCount(copies)}. ${held} of them ${held === 1 ? "is" : "are"} in your collection; the rest are left alone.`;
}

/**
 * The warning under the same checkbox: how many of the cards given come out of decks, and which.
 * `null` when none do, so the dialog draws no line at all rather than a reassurance.
 */
export function deckNote(lines: readonly FinishLine[]): string | null {
  const mine = linesOf(lines, "mine").filter((line) => fromDecks(line) > 0);
  const copies = mine.reduce((sum, line) => sum + fromDecks(line), 0);
  if (copies === 0) return null;
  // `deckNames` is in the order a finish takes from them, so the first few are the ones it reaches:
  // a single copy of a card held in two decks leaves only the first of them short.
  const decks = [...new Set(mine.flatMap((line) => line.deckNames.slice(0, fromDecks(line))))];
  const from = decks.length === 0 ? "a deck" : decks.join(", ");
  return `${copies} of them ${copies === 1 ? "comes" : "come"} out of ${
    decks.length === 1 ? "a deck" : "your decks"
  }: ${from}. ${decks.length === 1 ? "That deck" : "Those decks"} will be short of ${
    copies === 1 ? "it" : "them"
  }.`;
}

/** Under *Add the cards you received to your collection*. */
export function receivedNote(lines: readonly FinishLine[]): string {
  const copies = linesOf(lines, "theirs").reduce((sum, line) => sum + line.quantity, 0);
  if (copies === 0) return "There is nothing on their side.";
  return `${cardCount(copies)}, in the printing and finish shown in the trade.`;
}

/** Under *Take the cards you received off your wishlist*: which of them are on it. */
export function unwishNote(lines: readonly FinishLine[]): string {
  const names = [
    ...new Set(
      linesOf(lines, "theirs")
        .filter((line) => line.wished > 0)
        .map((line) => line.name),
    ),
  ];
  if (names.length === 0) return "None of them are on your wishlist.";
  return `${names.length} of them ${names.length === 1 ? "is" : "are"} on it: ${names.join(", ")}.`;
}

/** What a finish did, for the archived trade's banner. `null` when it did nothing at all. */
export function outcomeSentence(outcome: TradeOutcome | null): string | null {
  if (outcome === null) return null;
  const parts: string[] = [];
  if (outcome.removedFromCollection > 0) {
    const decks = outcome.removedFromDecks;
    parts.push(
      `took ${cardCount(outcome.removedFromCollection)} out of your collection${
        decks > 0 ? ` (${decks} from ${decks === 1 ? "a deck" : "decks"})` : ""
      }`,
    );
  }
  if (outcome.addedToCollection > 0) {
    parts.push(`added ${cardCount(outcome.addedToCollection)} to your collection`);
  }
  if (outcome.removedFromWishlist > 0) {
    parts.push(`took ${cardCount(outcome.removedFromWishlist)} off your wishlist`);
  }
  if (outcome.addedToWishlist > 0) {
    parts.push(`put ${cardCount(outcome.addedToWishlist)} on your wishlist`);
  }
  if (parts.length === 0) return null;
  const last = parts.pop();
  const list = parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
  return `Finishing it ${list}.`;
}
