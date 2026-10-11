/**
 * Trades: the two sides of one, their lines, and the finish that carries one into the collection
 * and the wishlist.
 *
 * **One domain of `../ipc.ts`.** Nothing outside `packages/ui/lib/ipc*` imports this file: every
 * page, hook, story and test goes through `@/lib/ipc`, which re-exports these types and spreads
 * `tradeCommands` into `ipc`. That is what keeps `vi.mock("@/lib/ipc", …)` the one seam a suite
 * replaces. ESLint refuses the import, and `ipc.test.ts` reads this file with its siblings, so the
 * struct-parity and argument-name fences cover it.
 *
 * Every shape here mirrors `crates/grimoire-core/src/trade.rs`.
 */
import type { FinishPrices } from "./cards";
import { invoke } from "./invoke";
import type { Finish } from "../finish";
import type { MarketplaceId } from "../marketplace";

/** Which side of a trade a line is on: the reader's own, or whoever they are trading with. */
export type TradeSide = "mine" | "theirs";

/** `open` is the only status a trade can be edited in. `finished` ran the collection and
 *  wishlist steps; `archived` was put away without them. Both keep the prices they closed with. */
export type TradeStatus = "open" | "finished" | "archived";

/** Where a line came from. `collection` is the one the page marks, because it is the one the
 *  finish step can take back out of the collection. */
export type TradeSource = "collection" | "search" | "scan";

/** A new trade. Both fields are optional: a name left out becomes `Trade N`, and a marketplace
 *  left out is the reader's current one. */
export interface TradeCreate {
  name?: string;
  marketplace?: MarketplaceId;
}

/** One card going onto a side. A printing and finish the side already holds raises that line. */
export interface TradeLineInput {
  cardId: string;
  finish: Finish;
  quantity: number;
  source: TradeSource;
}

/** What changes about a line. A field left out is left alone; `side` moves the line across. */
export interface TradeLineChange {
  cardId?: string;
  finish?: Finish;
  quantity?: number;
  side?: TradeSide;
}

/** The four questions Finish trade asks. `folderId` is where received cards are filed, and
 *  `null` is the collection's root. */
export interface TradeFinishOptions {
  removeGiven: boolean;
  addReceived: boolean;
  folderId: number | null;
  unwishReceived: boolean;
  wishGiven: boolean;
}

/** One line of a trade, with the facts the page draws conclusions from. */
export interface TradeLine {
  id: number;
  side: TradeSide;
  cardId: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  layout: string | null;
  /** The printing's finishes as `cards.finishes` stores them: a JSON array, as text. */
  finishes: string | null;
  /** The printing's language, type line and `legalities` blob, as `cards` stores them; `null`
   *  when the printing has left the database. Only a side's export reads them (issue #903). */
  lang: string | null;
  typeLine: string | null;
  legalities: string | null;
  finish: Finish;
  quantity: number;
  source: TradeSource;
  /** At 100%, in the trade's marketplace. Live while the trade is open; the figure it closed
   *  with once it is not. `null` is "no price", never zero. */
  unitPrice: number | null;
  /** Today's price of this printing in each finish, for the finish control's hints. */
  finishPrices: FinishPrices;
  /**
   * Copies of this printing and finish the collection holds **outside any deck**: unfiled, or in
   * a binder of the reader's own that is not locked. The finish step takes these first.
   */
  owned: number;
  /**
   * Copies of this printing and finish filed in a **deck's group**. A finish takes them only once
   * {@link owned} has run out, and taking one leaves that deck a card short — which is why every
   * surface that shows one draws it in the destructive colour and names the deck.
   */
  ownedInDecks: number;
  /** The decks those copies sit in, in the order a finish would take from them. */
  deckNames: string[];
  /** Copies of this card on the wishlist, in any printing. */
  wished: number;
}

/** What a finish did, in copies. Kept on the trade so the archive can say it. */
export interface TradeOutcome {
  /** Every copy a finish took out of the collection, the ones from decks included. */
  removedFromCollection: number;
  /** How many of those came out of a deck's group. */
  removedFromDecks: number;
  addedToCollection: number;
  removedFromWishlist: number;
  addedToWishlist: number;
}

/** A whole trade. */
export interface Trade {
  id: number;
  name: string;
  marketplace: MarketplaceId;
  /** Percent of market price for the reader's side, 50 to 150 in steps of 5. */
  rateMine: number;
  rateTheirs: number;
  status: TradeStatus;
  /** True once a finish has run, even if the trade was reopened since: the dialog then opens
   *  with every option off, because a second pass would do them twice. */
  finishedBefore: boolean;
  outcome: TradeOutcome | null;
  /** Unix seconds. */
  createdAt: number;
  closedAt: number | null;
  lines: TradeLine[];
}

/** The little of a line the trades list needs to state a balance. */
export interface TradeSummaryLine {
  side: TradeSide;
  quantity: number;
  unitPrice: number | null;
}

/** One trade in the list. */
export interface TradeSummary {
  id: number;
  name: string;
  marketplace: MarketplaceId;
  rateMine: number;
  rateTheirs: number;
  status: TradeStatus;
  createdAt: number;
  closedAt: number | null;
  lines: TradeSummaryLine[];
}

/** The trade commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const tradeCommands = {
  /** Every trade, newest first, each with just enough of its lines to state a balance. */
  tradeList: () => invoke<TradeSummary[]>("trade_list"),
  /** One trade with its lines, or `null` when it is gone. */
  tradeGet: (id: number) => invoke<Trade | null>("trade_get", { id }),
  /** Answers the new trade's id. */
  tradeCreate: (trade: TradeCreate) => invoke<number>("trade_create", { trade }),
  tradeRename: (id: number, name: string) => invoke<void>("trade_rename", { id, name }),
  tradeSetRate: (id: number, side: TradeSide, rate: number) =>
    invoke<void>("trade_set_rate", { id, side, rate }),
  tradeAddLines: (id: number, side: TradeSide, lines: TradeLineInput[]) =>
    invoke<void>("trade_add_lines", { id, side, lines }),
  tradeUpdateLine: (lineId: number, change: TradeLineChange) =>
    invoke<void>("trade_update_line", { lineId, change }),
  tradeRemoveLine: (lineId: number) => invoke<void>("trade_remove_line", { lineId }),
  /** Runs the chosen collection and wishlist steps, freezes the prices and files the trade as
   *  finished, in one transaction. */
  tradeFinish: (id: number, options: TradeFinishOptions) =>
    invoke<TradeOutcome>("trade_finish", { id, options }),
  /** Freezes the prices and puts the trade away. The collection and wishlist are not touched. */
  tradeArchive: (id: number) => invoke<void>("trade_archive", { id }),
  /** Back to open, on live prices. Nothing a finish did is undone. */
  tradeReopen: (id: number) => invoke<void>("trade_reopen", { id }),
  /** A new open trade with the same lines, percentages and marketplace. Answers its id. */
  tradeDuplicate: (id: number) => invoke<number>("trade_duplicate", { id }),
  tradeDelete: (id: number) => invoke<void>("trade_delete", { id }),
};
