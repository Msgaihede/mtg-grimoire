import { TradeList } from "../trade/TradeList";
import { TradeView } from "../trade/TradeView";

/**
 * Trade on the phone face: the list of trades, or the one the URL names.
 *
 * **Two pages behind one tab, told apart by the place** (`routes.ts`'s `tradeId`), the way Decks
 * is a gallery and a deck: `/trade` is every trade the reader keeps and `/trade/5` is one of them,
 * so Back leaves a trade for the list, a reload reopens the trade being built, and Android's back
 * gesture does what the header's own way back does.
 *
 * **The desktop page's parts in the phone's idioms.** Everything that decides is
 * `packages/ui/features/trade`'s — the arithmetic (`trade.ts`), the two reads and every write
 * (`useTrades.ts`), the add field's candidates and the balance bar — and what is drawn here is
 * what a 360px window and a thumb need of it: a list of rows, the trade as two columns with the
 * balance above the tab bar, and a sheet for each thing the desktop does in place.
 */
export function TradePage({ tradeId }: { tradeId: number | null }) {
  if (tradeId === null) return <TradeList />;
  // Keyed by the trade: a second one — a duplicate, the next row in the list — is a fresh page,
  // not the first one's open sheet and scroll position.
  return <TradeView key={tradeId} tradeId={tradeId} />;
}
