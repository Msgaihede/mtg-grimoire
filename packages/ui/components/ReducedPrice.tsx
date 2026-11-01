import type { ReactElement } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { ReducedValue } from "@/lib/collectionValue";
import { count } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";

/** The dotted underline is what says the figure has more to tell. Nothing else in a dim line would:
 *  the app's other hints sit on controls a reader already presses. */
const FIGURE = cn(
  "underline decoration-dim decoration-dotted underline-offset-[3px]",
  "hover:text-text hover:decoration-text focus-visible:text-text",
);

/** One line of the breakdown. */
function Line({ label, amount }: { label: string; amount: string }): ReactElement {
  return (
    <div className="flex justify-between gap-4 py-0.5">
      <span className="text-dim">{label}</span>
      <span className="font-mono whitespace-nowrap tabular-nums">{amount}</span>
    </div>
  );
}

/**
 * How a reduced price was reached, line by line — the tooltip's content, and the panel's in
 * Settings. Drawn from {@link ReducedValue}, whose lines are rounded so they add up on screen.
 */
export function ReducedBreakdown({
  value,
  currency,
}: {
  value: ReducedValue;
  currency: Currency;
}): ReactElement {
  const { below, sale } = value;
  return (
    <>
      <Line label="Full value" amount={formatPrice(value.full, currency)} />
      {below !== null && (
        <Line
          label={`Under ${formatPrice(below.minimum, currency)} · ${count(below.cards)} ${below.cards === 1 ? "card" : "cards"}`}
          amount={`−${formatPrice(below.value, currency)}`}
        />
      )}
      {sale !== null && (
        <Line
          label={`Sell at ${sale.percent}%`}
          amount={`−${formatPrice(sale.lost, currency)}`}
        />
      )}
      <div className="mt-1 flex justify-between gap-4 border-t border-border pt-1.5 font-medium">
        <span>Reduced price</span>
        <span className="font-mono whitespace-nowrap tabular-nums">
          {formatPrice(value.reduced, currency)}
        </span>
      </div>
    </>
  );
}

/** The tooltip: the breakdown, what it left out, and where it is set. */
function Hint({
  value,
  currency,
  unpriced,
}: {
  value: ReducedValue;
  currency: Currency;
  unpriced: number;
}): ReactElement {
  return (
    <div className="w-64 py-1 leading-[1.45]">
      <ReducedBreakdown value={value} currency={currency} />
      <p className="m-0 mt-1.5 text-dim">
        {unpriced > 0 && (
          <span className="block">
            {count(unpriced)} unpriced {unpriced === 1 ? "card isn't" : "cards aren't"} counted.
          </span>
        )}
        <span className="block">Set in Settings › Collection value.</span>
      </p>
    </div>
  );
}

/**
 * A reduced price beside the value it reduces: `($4,331.79)`, the figure underlined in dots and the
 * breakdown on hover.
 *
 * **Its own press-free `<button>`, so the keyboard reaches the tooltip**: a hint on a bare `<span>`
 * opens for a pointer alone. `plain` is the exception, for a figure already inside a control, where
 * a button in a button is invalid HTML; that control's own name then has to say the price.
 *
 * It sets no size or colour of its own but the dotted figure's, so it takes both from where it sits.
 */
export function ReducedPrice({
  value,
  currency,
  unpriced = 0,
  plain = false,
  className,
}: {
  value: ReducedValue;
  currency: Currency;
  /** Copies the value could not price, said under the breakdown. */
  unpriced?: number;
  plain?: boolean;
  className?: string;
}): ReactElement {
  const tip = useTooltip();
  const money = formatPrice(value.reduced, currency);
  const hint = tip(<Hint value={value} currency={currency} unpriced={unpriced} />);
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      (
      {plain ? (
        <span className={FIGURE} {...hint}>
          {money}
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Reduced price ${money}`}
          className={cn(FIGURE, "cursor-default rounded-sm", FOCUS)}
          {...hint}
        >
          {money}
        </button>
      )}
      )
    </span>
  );
}
