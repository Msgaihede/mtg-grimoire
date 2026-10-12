import { FINISH_LABEL, type Finish } from "@/lib/finish";
import type { Trade, TradeLine, TradeSide, TradeStatus, TradeSummary } from "@/lib/ipc";
import {
  DEFAULT_MARKETPLACE,
  MARKETPLACE_LIST,
  resolveMarketplace,
  type Currency,
  type Marketplace,
  type MarketplaceId,
} from "@/lib/marketplace";
import { exchangeLine, fromDecks, isSettled, linesOf, outcomeSentence } from "./trade";

/**
 * The Trade page's sentences that are not arithmetic.
 *
 * `trade.ts` is the money and the words that follow from it — who owes whom, what a finish will
 * move. This is the rest: when a trade was opened, whose prices it carries, what a closed one says
 * about itself. Kept apart from the components so the trades list and the open trade's header
 * cannot word one fact two ways, and so each sentence has a test rather than a screenshot.
 */

/**
 * `Sep`, never `Sept`.
 *
 * The app's other day formats are en-GB, whose CLDR data abbreviates September with four letters
 * (`features/home/priceHistory/priceAnalytics.ts` records it). Here the month is one cell of a
 * 248px column beside a card count, and the design draws three letters for all twelve — so the
 * month alone is en-US's and the order is still day first.
 */
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });

/**
 * A moment as the day it fell on: `2 Oct`, or `2 Oct 2026` with the year.
 *
 * **Local time, unlike the price history's days.** Those are UTC midnights and are formatted as
 * such; `createdAt` and `closedAt` are instants — the second a button was pressed — and the day a
 * reader remembers opening a trade on is the one their own clock showed.
 */
export function tradeDay(unixSeconds: number, withYear = false): string {
  const at = new Date(unixSeconds * 1000);
  const day = `${at.getDate()} ${MONTH.format(at)}`;
  return withYear ? `${day} ${at.getFullYear()}` : day;
}

/** The marketplace a trade's prices are from — its own, never the app's current one. */
export function tradeMarketplace(trade: Pick<Trade, "marketplace">): Marketplace {
  return resolveMarketplace(trade.marketplace);
}

/** The money every figure of a trade is in. */
export function tradeCurrency(trade: Pick<Trade, "marketplace">): Currency {
  return tradeMarketplace(trade).currency;
}

/** `Opened`, `Finished` or `Archived`, and the moment that word is about. */
function stamp(trade: Pick<Trade, "status" | "createdAt" | "closedAt">): [string, number] {
  if (trade.status === "open") return ["Opened", trade.createdAt];
  // A closed trade always carries the stamp; the fallback is for a row a future build writes
  // without one, which should still say a day rather than `NaN`.
  const at = trade.closedAt ?? trade.createdAt;
  return [trade.status === "finished" ? "Finished" : "Archived", at];
}

/**
 * A trade's line in the trades list: `Opened 2 Oct · 6 for 5 cards`.
 *
 * An archived trade says `not finished` where the others say how many cards changed hands,
 * because that is the one thing the list has to tell apart in its Archived group: both kinds sit
 * there, and only one of them moved anything.
 */
export function listLine(trade: TradeSummary): string {
  const [word, at] = stamp(trade);
  if (trade.status === "archived") return `${word} ${tradeDay(at)} · not finished`;
  const copies = (side: TradeSide) =>
    linesOf(trade.lines, side).reduce((sum, line) => sum + line.quantity, 0);
  return `${word} ${tradeDay(at)} · ${exchangeLine(copies("mine"), copies("theirs"))}`;
}

/**
 * The dim line under a trade's name.
 *
 * Open: `Opened 2 Oct 2026 · TCGplayer prices, USD · Saved as you go` — the last clause is there
 * because the page has no Save, and a reader who has just typed eight cards looks for one.
 * Closed: `Finished 6 Sep 2026 · Prices kept from that day, in USD`, which is the fact that makes
 * an old trade's figures differ from today's.
 */
export function headerLine(
  trade: Pick<Trade, "status" | "createdAt" | "closedAt" | "marketplace">,
): string {
  const [word, at] = stamp(trade);
  const marketplace = tradeMarketplace(trade);
  const money = marketplace.currency.toUpperCase();
  const when = `${word} ${tradeDay(at, true)}`;
  return trade.status === "open"
    ? `${when} · ${marketplace.label} prices, ${money} · Saved as you go`
    : `${when} · Prices kept from that day, in ${money}`;
}

/**
 * What a closed trade says above its two sides.
 *
 * A finished one says what the finish did, in `outcomeSentence`'s words. An archived one says the
 * opposite as plainly: it was put away, and putting it away moved nothing — which is a sentence
 * about the *archiving*, so it stays true of a trade that was finished once, reopened, and then
 * archived.
 */
export function closedBanner(trade: Pick<Trade, "status" | "outcome">): string {
  if (isSettled(trade.status)) {
    const did =
      outcomeSentence(trade.outcome) ??
      "Finishing it changed nothing in your collection or your wishlist.";
    return `Finished and archived, so nothing here can be edited. ${did}`;
  }
  return (
    "Archived without finishing, so nothing here can be edited. " +
    "Archiving it changed nothing in your collection or your wishlist."
  );
}

/** A side's heading. Past tense only once the cards have actually changed hands. */
export function sideHeading(side: TradeSide, status: TradeStatus): string {
  if (isSettled(status)) return side === "mine" ? "You gave" : "They gave";
  return side === "mine" ? "You give" : "They give";
}

/** `your side` / `their side`, for the names of controls. */
export function sideWords(side: TradeSide): string {
  return side === "mine" ? "your side" : "their side";
}

/** `your cards` / `their cards`. */
export function sideCards(side: TradeSide): string {
  return side === "mine" ? "your cards" : "their cards";
}

/** `80% of market` — a side's percentage, as its button and a closed trade's heading say it. */
export function rateLabel(rate: number): string {
  return `${rate}% of market`;
}

/**
 * A side's percentage control, named: `Price for their cards: 80%`.
 *
 * Whose price and what it is, in one name — the control's visible text is the value alone (`80%`
 * on the phone's chip, `80% of market` on the desktop's button), which is the same words on both
 * sides, and a name without the value would replace the one fact the control states.
 */
export function rateName(side: TradeSide, rate: number): string {
  return `Price for ${sideCards(side)}: ${rate}%`;
}

/**
 * `2 without a price`, or `null` where every line has one.
 *
 * **Said wherever a total or a balance is.** A line with no price is counted and left out of the
 * figures (`trade.ts`), and a figure that leaves a card out in silence is a number that lies by
 * rounding down — on the balance panel, in the summary a finish is confirmed against, and on a
 * trade's row in the list, where `Even trade` over two unpriced cards is not an even trade.
 * One wording, so no surface can say it a second way.
 */
export function unpricedNote(unpriced: number): string | null {
  return unpriced > 0 ? `${unpriced} without a price` : null;
}

/** The same note for a whole trade, both sides together — the trades list's. */
export function tradeUnpricedNote(money: {
  mine: { unpriced: number };
  theirs: { unpriced: number };
}): string | null {
  return unpricedNote(money.mine.unpriced + money.theirs.unpriced);
}

/** `$87.09 at 100%` — a rated side's full figure, beside the adjusted one. `money` is formatted. */
export function fullPriceNote(money: string): string {
  return `${money} at 100%`;
}

/**
 * The heading of the add field's second section: the reader's copies that sit in a deck.
 *
 * **Its own section, in the destructive colour, on both faces.** A copy outside a deck costs the
 * reader the card they chose to give; a copy inside one also costs a deck a card, which nobody at
 * the table said. So the two are never one list, and the words — this heading, the sentence under
 * it, the deck's name on every row — carry it as well as the colour does.
 */
export const DECK_COPIES_HEADING = "In your decks";

/**
 * The sentence under {@link DECK_COPIES_HEADING}.
 *
 * **It says when, because a press here does not pick a copy.** A line is a printing and a finish;
 * the finish step takes the copies outside every deck first and a deck's only after. So a card
 * held both ways is not pulled from its deck by being added from this section — it is once the
 * line asks for more than the others can give, and the line's own mark says so when it does.
 */
export const DECK_COPIES_WARNING =
  "A finished trade takes these out of their decks, once your copies outside any deck have run out.";

/** A deck row's count, with the deck it is in: `1 in Serah`. */
export function deckHolding(copies: number, deckName: string): string {
  return `${copies} in ${deckName}`;
}

/** What a line on the reader's side says about where its copies will come from. */
export interface GivenMark {
  /**
   * `deck` is drawn in the destructive colour and `collection` in gold — and they are never the
   * same mark in two colours: the words differ too.
   */
  place: "collection" | "deck";
  words: string;
}

/**
 * The mark on a line the reader gives: *from your collection*, or — where finishing would reach
 * into a deck — how many copies and which deck, `1 from your deck Serah`.
 *
 * **Derived from the line's facts, never recorded.** `fromDecks` is what is left of the line once
 * the copies outside every deck have run out, so the mark turns as the quantity is stepped past
 * `owned` and turns back when it is stepped down again. A line that came from a search or a scan
 * wears it too: the finish step asks where a card was added from of no line.
 *
 * **The decks named are the ones those copies can come from, and no more.** `deckNames` is in the
 * order a finish empties them and every deck on it holds at least one copy, so `n` copies come out
 * of the first `n` decks at most — one copy is exactly the first deck, and naming a second would
 * warn about a deck this line leaves alone.
 *
 * **A line drawn from the collection says how many copies the collection has** while the trade is
 * open (issue #935): `from your collection · 3 owned`, outside the reader's decks and in them, of
 * that printing and finish. It is the figure a press on `+` stops at — past it the copies go onto
 * a line of their own without this mark — and on a closed trade the facts are live, so the count
 * would describe today's collection rather than the trade, and is left off.
 *
 * **A line beside another of the same printing and finish is read with its own share**: callers
 * pass the line through `holdingOf` with the trade's lines, so the copies asked for past the
 * collection's line do not claim the copies that line already holds.
 *
 * **Only the reader's side, and only while the trade is open.** `owned` and `ownedInDecks` arrive
 * on their lines too — a card they give that the reader also holds in a deck — and nothing is ever
 * taken for those. On a closed trade the facts are still live, so they describe what *another*
 * finish would take, not what this one took: the line keeps the gold mark of where it came from,
 * and the banner above it says what the finish did.
 */
export function givenMark(
  line: Pick<TradeLine, "side" | "source" | "quantity" | "owned" | "ownedInDecks" | "deckNames">,
  open: boolean,
): GivenMark | null {
  if (line.side !== "mine") return null;
  const copies = open ? fromDecks(line) : 0;
  if (copies > 0) {
    const decks = line.deckNames.slice(0, copies);
    const where =
      decks.length === 0
        ? "a deck"
        : `your ${decks.length === 1 ? "deck" : "decks"} ${decks.join(", ")}`;
    // The whole line, and the count would only repeat the quantity beside it.
    return { place: "deck", words: `${copies === line.quantity ? "" : `${copies} `}from ${where}` };
  }
  if (line.source !== "collection") return null;
  const held = Math.max(0, line.owned) + Math.max(0, line.ownedInDecks);
  return {
    place: "collection",
    words: open ? `from your collection · ${held} owned` : "from your collection",
  };
}

/** One marketplace a new trade could be priced in — and, where it cannot be, why not. */
export interface TradeMarketplaceOffer {
  marketplace: Marketplace;
  /** Why this one cannot be picked right now, in a sentence; `null` where it can. */
  reason: string | null;
}

/**
 * What New trade offers under *Prices from*: the four priced marketplaces, two of them always.
 *
 * **TCGplayer's and Cardmarket's prices arrive with the card data**, so a trade in either is
 * priced on any installation. **Card Kingdom's and Mana Pool's are downloads, and the app fetches
 * and refreshes only the one it is set to**: a Card Kingdom trade opened while the app quotes
 * TCGplayer has every line unpriced — which reads `Even trade` — or is priced from whatever was
 * downloaded the last time Card Kingdom was selected, months ago. So a feed marketplace is offered
 * only while it is the app's own, and otherwise stays in the list, out of reach, saying how to
 * reach it. `current` is `useMarketplace()`'s `marketplace`: what this window is quoting.
 */
export function tradeMarketplaceOffers(current: Pick<Marketplace, "id">): TradeMarketplaceOffer[] {
  return MARKETPLACE_LIST.filter((marketplace) => marketplace.priced).map((marketplace) => ({
    marketplace,
    reason:
      marketplace.feed && marketplace.id !== current.id
        ? `Switch the app to ${marketplace.label} in Settings to trade in its prices.`
        : null,
  }));
}

/**
 * The marketplace New trade opens on: the app's own — the one whose prices the reader has been
 * looking at, and by {@link tradeMarketplaceOffers}' rule always one that is offered — or the
 * default where theirs is one this app cannot price, which no trade could be opened in.
 */
export function newTradeMarketplace(current: Pick<Marketplace, "id" | "priced">): MarketplaceId {
  return current.priced ? current.id : DEFAULT_MARKETPLACE;
}

/** A printing as a picker's row names it: `MH2 · 138`. */
export function printingLabel(setCode: string, collectorNumber: string): string {
  return `${setCode.toUpperCase()} · ${collectorNumber}`;
}

/** A printing and a finish on one line, for a row that has no controls: `MH2 138 · Nonfoil`. */
export function printingLine(setCode: string, collectorNumber: string, finish: Finish): string {
  return `${setCode.toUpperCase()} ${collectorNumber} · ${FINISH_LABEL[finish]}`;
}

/**
 * The name the next trade will most likely get if none is typed: `Trade 6`.
 *
 * **A guess, and worded as one wherever it is drawn.** The backend names a trade after its own id
 * and this side cannot know the next one — a deleted trade's number may or may not be handed out
 * again — so this is a placeholder in a text box and never a promise in a sentence.
 */
export function nextTradeName(trades: readonly Pick<TradeSummary, "id">[]): string {
  const newest = trades.reduce((max, trade) => Math.max(max, trade.id), 0);
  return `Trade ${newest + 1}`;
}

/**
 * Which trade the page opens on: the newest one still open, else the newest of any kind.
 *
 * The list arrives newest first, so "newest" is "first". An open trade wins over a newer closed
 * one because the page is where a trade is *built* — a reader who archived one yesterday and has
 * another on the table has come back for the one on the table.
 */
export function defaultTradeId(
  trades: readonly Pick<TradeSummary, "id" | "status">[],
): number | null {
  return (trades.find((trade) => trade.status === "open") ?? trades[0])?.id ?? null;
}
