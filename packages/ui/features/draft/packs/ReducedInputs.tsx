import { useId, useState, type JSX } from "react";
import { FILTER_LABEL } from "@/components/FilterChips";
import {
  bulkOf,
  minimumOf,
  parseBulkPrice,
  parseMinimumValue,
  parseSellPercent,
} from "@/lib/collectionValue";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import type { PackReduction } from "./reducedPick";

/** The reduced price's tooltip line on this page: its figures are these boxes, not Settings'. */
export const PACKS_SET_IN = "Set by Sell at, Minimum and Bulk on this page.";

/**
 * What the page's figures are reduced by, in a sentence for under _Expected value_ — every figure
 * there is at these prices (issue #1502), and nothing else on the column says so. `null` where
 * they reduce nothing.
 */
export function reductionLine(settings: PackReduction, currency: Currency): string | null {
  const minimum = minimumOf(settings);
  const percent = settings.sellPercent < 100 ? `${settings.sellPercent}%` : null;
  if (minimum === undefined && percent === null) return null;
  if (minimum === undefined) return `Every card counted at ${percent} of its price.`;
  const bulk = bulkOf(settings);
  const under =
    `Cards under ${formatPrice(minimum, currency)} ` +
    (bulk === undefined ? "are not counted" : `count ${formatPrice(bulk, currency)} each`);
  return percent === null ? `${under}.` : `${under}; the rest at ${percent}.`;
}

const SELL_REFUSED = "Sell at has to be above 0 and at most 100%.";
const MINIMUM_REFUSED = "Minimum has to be a price of zero or more.";
const BULK_REFUSED = "Bulk has to be a price of zero or more.";

/** Why the Bulk box is greyed: a bulk price is what a card under the minimum is worth. */
const BULK_NEEDS_MINIMUM = "Set a Minimum first: Bulk is what each card under it is worth.";

/** `PackFigures`' What you paid box, narrower and right-aligned like the Settings boxes. */
const BOX = cn(
  "h-9 rounded-md border border-border bg-bg px-2 text-right font-mono text-sm tabular-nums",
  "placeholder:text-dim focus:border-accent focus:outline-none",
);

/** One box with its caption before it and its unit around it. */
function Box({
  id,
  label,
  prefix,
  suffix,
  initial,
  placeholder,
  width,
  describedBy,
  disabled = false,
  title,
  onCommit,
}: {
  id: string;
  label: string;
  prefix?: string;
  suffix?: string;
  /** What the box starts from. It is re-seeded whenever the stored figure moves. */
  initial: string;
  placeholder: string;
  width: string;
  describedBy: string;
  disabled?: boolean;
  /** The greyed box's reason, on hover. */
  title?: string;
  onCommit: (text: string) => void;
}): JSX.Element {
  return (
    <span className={cn("flex items-center gap-1.5", disabled && "opacity-50")} title={title}>
      <label htmlFor={id} className={FILTER_LABEL}>
        {label}
      </label>
      {prefix !== undefined && <span className="font-mono text-sm text-dim">{prefix}</span>}
      <input
        id={id}
        // Re-seeded whenever the stored figure moves — a refusal putting it back — and otherwise
        // the reader's draft.
        key={initial}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        defaultValue={initial}
        placeholder={placeholder}
        aria-describedby={describedBy}
        disabled={disabled}
        onBlur={(e) => onCommit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(e.currentTarget.value);
        }}
        className={cn(BOX, width, disabled && "cursor-not-allowed")}
      />
      {suffix !== undefined && <span className="font-mono text-sm text-dim">{suffix}</span>}
    </span>
  );
}

/**
 * Open Packs' sell percentage, minimum card value and bulk price — the page's own
 * (`reducedPick.ts`), which make the reduced price drawn beside an opening's total and the
 * session's.
 *
 * **A box is a draft until it loses focus or Enter is pressed**, `CollectionValuePanel`'s rule and
 * its parsers, so a reader typing `0.50` is not priced at `0` and `0.5` on the way. An empty box is
 * that figure's default — 100%, no minimum, no bulk price — which is how one is turned off. A
 * refusal is said beside the boxes and nothing is kept.
 *
 * **Bulk is greyed with no minimum** (issue #1477): it prices the cards under the minimum, so with
 * none there is nothing for it to price. Its figure is kept while greyed, and counts again once a
 * minimum is set.
 */
export function ReducedInputs({
  settings,
  currency,
  onChange,
}: {
  settings: PackReduction;
  currency: Currency;
  onChange: (settings: PackReduction) => void;
}): JSX.Element {
  const id = useId();
  const [refusal, setRefusal] = useState<string | null>(null);

  const sign = formatPrice(0, currency).replace(/[\d.,\s]/g, "");
  const noMinimum = settings.minimumValue === 0;

  const commit = (field: keyof PackReduction, value: number | null, sentence: string) => {
    if (value === null) {
      setRefusal(sentence);
      return;
    }
    setRefusal(null);
    if (value !== settings[field]) onChange({ ...settings, [field]: value });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Box
        id={`${id}-sell`}
        label="Sell at"
        suffix="%"
        initial={settings.sellPercent === 100 ? "" : String(settings.sellPercent)}
        placeholder="100"
        width="w-16"
        describedBy={`${id}-refusal`}
        onCommit={(text) => commit("sellPercent", parseSellPercent(text), SELL_REFUSED)}
      />
      <Box
        id={`${id}-minimum`}
        label="Minimum"
        prefix={sign}
        initial={noMinimum ? "" : settings.minimumValue.toFixed(2)}
        placeholder="0.00"
        width="w-20"
        describedBy={`${id}-refusal`}
        onCommit={(text) => commit("minimumValue", parseMinimumValue(text), MINIMUM_REFUSED)}
      />
      <Box
        id={`${id}-bulk`}
        label="Bulk"
        prefix={sign}
        initial={settings.bulkPrice === 0 ? "" : settings.bulkPrice.toFixed(2)}
        placeholder="0.00"
        width="w-20"
        describedBy={`${id}-refusal`}
        disabled={noMinimum}
        title={noMinimum ? BULK_NEEDS_MINIMUM : undefined}
        onCommit={(text) => commit("bulkPrice", parseBulkPrice(text), BULK_REFUSED)}
      />
      <p id={`${id}-refusal`} aria-live="polite" className="m-0 text-sm text-destructive">
        {refusal}
      </p>
    </div>
  );
}
