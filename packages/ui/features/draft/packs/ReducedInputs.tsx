import { useId, type JSX } from "react";
import { FILTER_LABEL } from "@/components/FilterChips";
import { bulkOf, minimumOf } from "@/lib/collectionValue";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useReductionDrafts } from "@/lib/useReductionDrafts";
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

const REFUSED = {
  sellPercent: "Sell at has to be above 0 and at most 100%.",
  minimumValue: "Minimum has to be a price of zero or more.",
  bulkPrice: "Bulk has to be a price of zero or more.",
};

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
  value,
  placeholder,
  width,
  describedBy,
  disabled = false,
  title,
  onDraft,
  onCommit,
}: {
  id: string;
  label: string;
  prefix?: string;
  suffix?: string;
  /** The box's draft — what is stored until the reader types (`useReductionDrafts`). */
  value: string;
  placeholder: string;
  width: string;
  describedBy: string;
  disabled?: boolean;
  /** The greyed box's reason, on hover. */
  title?: string;
  onDraft: (text: string) => void;
  onCommit: () => void;
}): JSX.Element {
  return (
    <span className={cn("flex items-center gap-1.5", disabled && "opacity-50")} title={title}>
      <label htmlFor={id} className={FILTER_LABEL}>
        {label}
      </label>
      {prefix !== undefined && <span className="font-mono text-sm text-dim">{prefix}</span>}
      <input
        id={id}
        // One node for the box's whole life (issue #1589): a stored figure re-seeds the draft, so
        // Enter keeps the caret here. Greyed with `aria-disabled` and read-only, never `disabled`,
        // so it stays in the tab order — a Tab out of Minimum lands on Bulk even as that commit is
        // what wakes it.
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        readOnly={disabled}
        onChange={(e) => onDraft(e.target.value)}
        onBlur={() => {
          if (!disabled) onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) onCommit();
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
 * refusal is said beside the boxes and nothing is kept; each box's is its own and stays while its
 * draft does (`useReductionDrafts`, issue #1589).
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
  const { drafts, setDraft, commit, refusal } = useReductionDrafts(settings, onChange, REFUSED);

  const sign = formatPrice(0, currency).replace(/[\d.,\s]/g, "");
  const noMinimum = settings.minimumValue === 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Box
        id={`${id}-sell`}
        label="Sell at"
        suffix="%"
        value={drafts.sellPercent}
        placeholder="100"
        width="w-16"
        describedBy={`${id}-refusal`}
        onDraft={(text) => setDraft("sellPercent", text)}
        onCommit={() => commit("sellPercent")}
      />
      <Box
        id={`${id}-minimum`}
        label="Minimum"
        prefix={sign}
        value={drafts.minimumValue}
        placeholder="0.00"
        width="w-20"
        describedBy={`${id}-refusal`}
        onDraft={(text) => setDraft("minimumValue", text)}
        onCommit={() => commit("minimumValue")}
      />
      <Box
        id={`${id}-bulk`}
        label="Bulk"
        prefix={sign}
        value={drafts.bulkPrice}
        placeholder="0.00"
        width="w-20"
        describedBy={`${id}-refusal`}
        disabled={noMinimum}
        title={noMinimum ? BULK_NEEDS_MINIMUM : undefined}
        onDraft={(text) => setDraft("bulkPrice", text)}
        onCommit={() => commit("bulkPrice")}
      />
      <p id={`${id}-refusal`} aria-live="polite" className="m-0 text-sm text-destructive">
        {refusal}
      </p>
    </div>
  );
}
