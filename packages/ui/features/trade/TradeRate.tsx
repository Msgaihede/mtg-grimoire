import { useEffect, useRef, useState, type JSX } from "react";
import { ChevronDown } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { ipcError } from "@/lib/ipc";
import type { Trade, TradeSide } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import {
  RATE_DEFAULT,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
  fromCents,
  linesOf,
  rateOf,
  sideMoney,
  snapRate,
} from "./trade";
import { FIGURE, REFUSAL } from "./tradeControls";
import { rateLabel, rateName, sideCards, tradeCurrency } from "./tradeWords";
import { useTradeWrites } from "./useTrades";

/**
 * A side's percentage of market price: the button that says it, and the popover that sets it.
 *
 * The button is in a side's heading and reads `100% of market`; it turns gold the moment the side
 * is priced at anything else, because that is a fact about every figure under it and the heading
 * is where a reader's eye starts.
 *
 * **Its name is whose price it is and what that price is: `Price for your cards: 80%`.** The
 * visible words alone would be one name on two buttons, a side apart; the side alone — which is
 * what this was — is a name that *replaces* those words, so the one fact the button exists to
 * state was never read out. The phone's chip says the same sentence.
 *
 * `AnchoredPopup` is the shell — the worded trigger, the two ways it closes and the caret's way
 * back are all that component's, and everything this file owns is {@link RatePanel}.
 */
export function TradeRate({ trade, side }: { trade: Trade; side: TradeSide }): JSX.Element {
  const rate = rateOf(trade, side);
  const name = `Price for ${sideCards(side)}`;
  return (
    <AnchoredPopup
      label={rateName(side, rate)}
      panelLabel={name}
      triggerClassName={cn(
        FIGURE,
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[0.8125rem]",
        "leading-none whitespace-nowrap",
        rate === RATE_DEFAULT ? "border-border text-text" : "border-accent text-accent",
      )}
      triggerContent={
        <>
          <span>{rateLabel(rate)}</span>
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </>
      }
      // Under a 32px trigger rather than the shell's own 24px square, and at the design's width.
      panelClassName="top-9 flex w-[19.5rem] flex-col gap-3.5 rounded-[10px] p-4"
    >
      <RatePanel trade={trade} side={side} />
    </AnchoredPopup>
  );
}

/**
 * The popover's body: one slider, and what the side is worth where the slider stands.
 *
 * ## Dragging is local; letting go is the write
 *
 * A slider reports every position it passes through. Writing each one would be twenty commands
 * for one gesture, each patching the cache and each refused or answered on its own — so the
 * position is held here while the thumb moves ({@link draft}) and the percentage is written once,
 * when the reader lets go.
 *
 * **"Lets go" is the element's own `change` event, and React does not hand that out.** React's
 * `onChange` is the DOM's `input` — every step of a drag — which is what feeds the draft. The
 * DOM's `change` fires when a range input *commits*: the pointer released, wherever on the screen
 * that happened, or one key step finished. A `pointerup` handler would miss a release outside the
 * 312px panel, and a `blur` one would hold the write until the popover closed. So the listener is
 * attached by hand, to the one event that means exactly this.
 *
 * ## The two totals are the draft's
 *
 * `At 100%` and `At 80%` are computed from the position under the thumb, not from the stored
 * percentage, so the reader watches the figure they are choosing rather than choosing blind and
 * reading the result off the page behind. The side's own lines follow when the write lands.
 */
function RatePanel({ trade, side }: { trade: Trade; side: TradeSide }) {
  const writes = useTradeWrites();
  const stored = rateOf(trade, side);
  /** Where the thumb is while it differs from what is stored, else `null`. */
  const [draft, setDraft] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const sliderRef = useRef<HTMLInputElement>(null);

  const rate = draft ?? stored;
  const currency = tradeCurrency(trade);
  const money = sideMoney(linesOf(trade.lines, side), rate);
  const price = (cents: number) => formatPrice(fromCents(cents), currency);

  /**
   * The values the commit listener reads, kept in step from an effect.
   *
   * The listener is attached once — re-attaching it on every render would be a listener per
   * dragged pixel — so it cannot close over this render's `stored`. A ref written during render
   * is what `react-hooks/refs` forbids; an effect is the allowed way to say the same thing.
   */
  const latest = useRef({ tradeId: trade.id, side, stored, setRate: writes.setRate });
  useEffect(() => {
    latest.current = { tradeId: trade.id, side, stored, setRate: writes.setRate };
  }, [trade.id, side, stored, writes.setRate]);

  useEffect(() => {
    const slider = sliderRef.current;
    if (slider === null) return;
    const commit = () => {
      const { tradeId, side: whose, stored: held, setRate } = latest.current;
      const next = snapRate(Number(slider.value));
      if (next === held) {
        setDraft(null);
        return;
      }
      setFailure(null);
      setRate(tradeId, whose, next)
        .catch((e: unknown) => {
          setFailure(`Couldn't change the percentage — ${ipcError(e)}`);
        })
        // The draft is let go only if it is still the one this write was for: a reader already
        // dragging again must not have the thumb pulled out from under them by an older answer.
        .finally(() => setDraft((now) => (now === next ? null : now)));
    };
    slider.addEventListener("change", commit);
    return () => slider.removeEventListener("change", commit);
  }, []);

  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className={cn(FIGURE, "text-[1.75rem] leading-none font-semibold text-accent")}>
          {rate}%
        </span>
        <span className="text-[0.8125rem] text-dim">of market price, for {sideCards(side)}</span>
      </div>

      <div>
        <input
          ref={sliderRef}
          type="range"
          aria-label="Percent of market price"
          aria-valuetext={`${rate}%`}
          min={RATE_MIN}
          max={RATE_MAX}
          step={RATE_STEP}
          value={rate}
          onChange={(e) => setDraft(snapRate(Number(e.target.value)))}
          className="block w-full accent-accent"
        />
        <div
          aria-hidden="true"
          className={cn(FIGURE, "mt-1 flex justify-between text-[0.6875rem] text-dim")}
        >
          <span>{RATE_MIN}%</span>
          <span>{RATE_DEFAULT}%</span>
          <span>{RATE_MAX}%</span>
        </div>
      </div>

      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-1 border-t border-border pt-3 text-[0.8125rem]">
        <dt className="text-dim">At 100%</dt>
        <dd className={cn(FIGURE, "text-dim")}>{price(money.fullTotal)}</dd>
        {rate !== RATE_DEFAULT && (
          <>
            <dt>At {rate}%</dt>
            <dd className={cn(FIGURE, "font-semibold")}>{price(money.total)}</dd>
          </>
        )}
      </dl>

      <p className="text-xs leading-snug text-dim">
        Applies to every card on this side. Each row keeps its full price beside the new one.
      </p>

      {failure !== null && (
        <p role="alert" className={REFUSAL}>
          {failure}
        </p>
      )}
    </>
  );
}
