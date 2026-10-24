import { useState, type JSX } from "react";
import { ToggleChip } from "@/components/FilterChips";
import { fromCents, rateOf, sideMoney } from "@/features/trade/trade";
import { useTradeWrites } from "@/features/trade/useTrades";
import type { ScannerTrayRow, Trade, TradeLineInput, TradeSide } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { isKnownFinish } from "./reader/trayFinish";
import { useTrayPrices } from "./reader/useTrayPrices";
import type { TrayDestination } from "./useTrayDestination";

/**
 * A side of a trade as a scanner's destination — what both trade scanners share.
 *
 * Here rather than under `features/trade/`, because the two hosts are on two faces: the desktop's
 * dialog draws the desktop Scanner view, which reads the app store, and the phone's sheet may not
 * import anything that does (`apps/light/phone/fence.test.ts`). So the parts neither face owns —
 * the words, the lines, the write and the *Scan onto* switch — sit beside the scanner's own shared
 * hooks, where both can reach them.
 */

/** A side as the end of a sentence. Never a person's name: the other party is *they*. */
export const SIDE_NAME: Record<TradeSide, string> = {
  mine: "your side",
  theirs: "their side",
};

/** The two sides in the order the switch draws them, under the words the trade heads them with. */
const SIDES = [
  { side: "mine", label: "You give" },
  { side: "theirs", label: "They give" },
] as const satisfies readonly { side: TradeSide; label: string }[];

/**
 * Tray rows as the lines `trade_add_lines` takes: one per row — its printing, its finish, its
 * count — each marked `scan`. The command folds a line onto one the side already holds.
 *
 * **A row of unknown finish is not a line**, and is dropped here rather than guessed at: a trade
 * line is a printing *in a finish*, and its price is that finish's. The scanner never hands such a
 * row over — `takenRows` leaves it in the tray and the press says how many it left — so this is
 * the type's proof, not a second rule.
 */
export function scanLines(rows: readonly ScannerTrayRow[]): TradeLineInput[] {
  return rows.flatMap((row) =>
    isKnownFinish(row.finish)
      ? [{ cardId: row.cardId, finish: row.finish, quantity: row.quantity, source: "scan" }]
      : [],
  );
}

/**
 * One side of `trade` as a {@link TrayDestination}, for a Scanner surface mounted over the trade.
 *
 * - **The write is `useTradeWrites().addLines`**, so the trade's own page is refreshed by it and a
 *   refusal — a trade that is no longer open — is the backend's sentence, drawn where a refused
 *   Add is drawn.
 * - **The rows are priced where the trade is**, not at the reader's current marketplace: a trade
 *   keeps the one it was opened with.
 * - **`onDone` is called when an Add leaves the tray empty.** Rows left behind — a card still
 *   waiting on a finish, one scanned while the write was out — keep the scanner open, because
 *   they are still to be decided.
 *
 * `side` is read at the press, so switching *Scan onto* with cards in the list sends them to the
 * side the switch is on when Add is pressed.
 *
 * `adding` is true while a write is out, for a host that will not close under one.
 */
export function useTradeDestination({
  trade,
  side,
  onDone,
}: {
  trade: Trade;
  side: TradeSide;
  onDone: () => void;
}): { destination: TrayDestination; adding: boolean } {
  const writes = useTradeWrites();
  const [adding, setAdding] = useState(false);
  const destination: TrayDestination = {
    title: `Scanned for ${SIDE_NAME[side]}`,
    name: SIDE_NAME[side],
    marketplace: trade.marketplace,
    summary: (rows) => <ScannedTotal rows={rows} trade={trade} side={side} />,
    commit: async (rows) => {
      setAdding(true);
      try {
        await writes.addLines(trade.id, side, scanLines(rows));
      } finally {
        setAdding(false);
      }
    },
    onCommitted: (left) => {
      if (left === 0) onDone();
    },
  };
  return { destination, adding };
}

/**
 * *Scan onto*: which side the list is headed for — **You give** or **They give**.
 *
 * Two toggles that are exclusive, in the scanner's own segment grammar (`role="group"`,
 * `aria-pressed` per button — never a radiogroup: these are toggles that happen to be exclusive,
 * and a radio's roving tab stop would put the reader inside a keyboard mode to change one word).
 * A press on the side already chosen says nothing: there is no "neither".
 */
export function ScanOnto({
  side,
  onSide,
}: {
  side: TradeSide;
  onSide: (side: TradeSide) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Scan onto" className="flex flex-wrap items-center gap-2">
      {/* The group's name, drawn: hidden from the tree so it is not read a second time. */}
      <span aria-hidden="true" className="text-[13px] text-dim">
        Scan onto
      </span>
      {SIDES.map((choice) => (
        <ToggleChip
          key={choice.side}
          label={choice.label}
          pressed={side === choice.side}
          onClick={() => {
            if (side !== choice.side) onSide(choice.side);
          }}
        />
      ))}
    </div>
  );
}

/**
 * *Scanned so far*: what the list is worth on the side it is headed for, where a collection's tray
 * draws its folder.
 *
 * **`trade.ts`'s arithmetic and no other** — `sideMoney` at the side's percentage, in cents — so
 * the figure is the one the side's total will rise by. Off 100% the full figure stands beside it
 * as `$23.85 at 100%`, the trade's own idiom, which is also what squares it with the rows: a row
 * quotes one copy at the market's price.
 *
 * It asks `useTrayPrices` under the key the tray itself asked under, so it costs no round trip.
 * A row whose price has not answered yet, or that is still waiting on a printing, is not in the
 * figure at all; one the marketplace does not quote adds nothing and is counted, as on the trade.
 */
function ScannedTotal({
  rows,
  trade,
  side,
}: {
  rows: readonly ScannerTrayRow[];
  trade: Trade;
  side: TradeSide;
}) {
  const { priceOf, currency } = useTrayPrices(rows, trade.marketplace);
  const money = sideMoney(
    rows.flatMap((row) => {
      const unitPrice = priceOf(row);
      return unitPrice === undefined ? [] : [{ quantity: row.quantity, unitPrice }];
    }),
    rateOf(trade, side),
  );
  return (
    <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-[13px] text-dim">
      <span>Scanned so far</span>
      <span className="font-mono text-base font-semibold tabular-nums text-text">
        {formatPrice(fromCents(money.total), currency)}
      </span>
      {money.rated && (
        <span className="font-mono text-xs tabular-nums">
          {formatPrice(fromCents(money.fullTotal), currency)} at 100%
        </span>
      )}
      {money.unpriced > 0 && <span className="text-xs">{money.unpriced} without a price</span>}
    </p>
  );
}
