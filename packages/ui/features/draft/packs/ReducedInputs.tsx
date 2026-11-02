import { useId, useState, type JSX } from "react";
import { FILTER_LABEL } from "@/components/FilterChips";
import { parseMinimumValue, parseSellPercent } from "@/lib/collectionValue";
import type { CollectionValue } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";

/** The reduced price's tooltip line on this page: its figures are these boxes, not Settings'. */
export const PACKS_SET_IN = "Set by Sell at and Minimum on this page.";

const SELL_REFUSED = "Sell at has to be above 0 and at most 100%.";
const MINIMUM_REFUSED = "Minimum has to be a price of zero or more.";

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
  onCommit: (text: string) => void;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
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
        onBlur={(e) => onCommit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(e.currentTarget.value);
        }}
        className={cn(BOX, width)}
      />
      {suffix !== undefined && <span className="font-mono text-sm text-dim">{suffix}</span>}
    </span>
  );
}

/**
 * Open Packs' sell percentage and minimum card value — the page's own (`reducedPick.ts`), which
 * make the reduced price drawn beside an opening's total and the session's.
 *
 * **A box is a draft until it loses focus or Enter is pressed**, `CollectionValuePanel`'s rule and
 * its parsers, so a reader typing `0.50` is not priced at `0` and `0.5` on the way. An empty box is
 * that figure's default — 100%, no minimum — which is how one is turned off. A refusal is said
 * beside the boxes and nothing is kept.
 */
export function ReducedInputs({
  settings,
  currency,
  onChange,
}: {
  settings: CollectionValue;
  currency: Currency;
  onChange: (settings: CollectionValue) => void;
}): JSX.Element {
  const id = useId();
  const [refusal, setRefusal] = useState<string | null>(null);

  const commit = (field: keyof CollectionValue, value: number | null, sentence: string) => {
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
        prefix={formatPrice(0, currency).replace(/[\d.,\s]/g, "")}
        initial={settings.minimumValue === 0 ? "" : settings.minimumValue.toFixed(2)}
        placeholder="0.00"
        width="w-20"
        describedBy={`${id}-refusal`}
        onCommit={(text) => commit("minimumValue", parseMinimumValue(text), MINIMUM_REFUSED)}
      />
      <p id={`${id}-refusal`} aria-live="polite" className="m-0 text-sm text-destructive">
        {refusal}
      </p>
    </div>
  );
}
