import { useRef, useState } from "react";
import {
  linesOf,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
  rateOf,
  sideMoney,
  snapRate,
} from "@grimoire/ui/features/trade/trade";
import { sideCards, sideWords } from "@grimoire/ui/features/trade/tradeWords";
import type { Trade, TradeSide } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet } from "../deck/sheet";
import { GOLD_BUTTON, Refusal } from "./parts";
import { capital, money, otherSide } from "./text";

/**
 * A side's percentage of market price: one slider, 50 to 150 in fives.
 *
 * **One slider, and nothing to type.** The desktop's popover is the same control; what a phone
 * adds is the room to show what the number *does* — the side at 100% and the side at the
 * percentage under the thumb, both moving as it is dragged.
 *
 * **The figures follow the thumb; the trade is written once, when the reader lets go.** A drag
 * across the track is twenty values, and twenty writes would be twenty refetches of the trade
 * fighting the slider for what it shows. So the value under the thumb is the sheet's own
 * (`draft`), the totals are worked out from it by `trade.ts` — the same arithmetic the page uses,
 * so letting go changes nothing on screen — and the write happens on the release, on a key coming
 * up, and on every way out of the sheet. **Never twice for one value**: `sent` remembers the last
 * one written, since the page's own copy of the rate is patched a tick after the write is made.
 */
export function RateSheet({
  side,
  trade,
  currency,
  refusal,
  onRate,
  onClose,
  onDismiss,
}: {
  /** The side whose percentage is open — `null` is closed. */
  side: TradeSide | null;
  trade: Trade;
  currency: Currency;
  refusal: string | null;
  onRate: (side: TradeSide, rate: number) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const sent = useRef<number | null>(null);
  // Closed, nothing below is drawn — `Dialog` mounts no body — so the side it falls back to is
  // only ever a value to compute with.
  const shown = side ?? "theirs";

  const stored = rateOf(trade, shown);
  const rate = draft ?? stored;
  const lines = linesOf(trade.lines, shown);
  const full = sideMoney(lines, 100);
  const rated = sideMoney(lines, rate);

  const commit = () => {
    if (side === null || draft === null) return;
    if (draft === (sent.current ?? stored)) return;
    sent.current = draft;
    onRate(side, draft);
  };
  const leave = (how: () => void) => {
    commit();
    setDraft(null);
    sent.current = null;
    how();
  };

  return (
    <ActionSheet
      open={side !== null}
      title={`Price ${sideCards(shown)} at`}
      subtitle="A percentage of the market price"
      closeLabel="Close percentage"
      onClose={() => leave(onClose)}
      onDismiss={() => leave(onDismiss)}
      footer={
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 pt-3 pb-4">
          <Refusal>{refusal}</Refusal>
          <button
            type="button"
            onClick={() => leave(onDismiss)}
            className={cn(GOLD_BUTTON, "w-full")}
          >
            Done
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-4 pt-[1.125rem] pb-4">
        <p className="flex items-baseline gap-2">
          <output className="font-mono text-4xl leading-none font-semibold text-accent tabular-nums">
            {`${rate}%`}
          </output>
          <span className="text-sm text-dim">of market price</span>
        </p>

        <div className="flex flex-col">
          <input
            type="range"
            aria-label="Percent of market price"
            aria-valuetext={`${rate}%`}
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={rate}
            onChange={(event) => setDraft(snapRate(Number(event.target.value)))}
            // Let go: a finger off the track, a key coming back up, the caret moving on.
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="h-11 w-full accent-accent"
          />
          <div
            aria-hidden="true"
            className="-mt-1.5 flex justify-between font-mono text-[0.6875rem] text-dim tabular-nums"
          >
            <span>{`${RATE_MIN}%`}</span>
            <span>100%</span>
            <span>{`${RATE_MAX}%`}</span>
          </div>
        </div>

        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-1.5 border-t border-border pt-3.5 text-sm">
          <dt className="text-dim">{`${capital(sideWords(shown))} at 100%`}</dt>
          <dd className="font-mono text-dim tabular-nums">{money(full.total, currency)}</dd>
          <dt>{`${capital(sideWords(shown))} at ${rate}%`}</dt>
          <dd className="font-mono font-semibold tabular-nums">{money(rated.total, currency)}</dd>
        </dl>

        <p className="text-[0.8125rem] leading-snug text-dim">
          {`Applies to every card on ${sideWords(shown)}. ${capital(sideWords(otherSide(shown)))} has its own percentage.`}
        </p>
      </div>
    </ActionSheet>
  );
}
