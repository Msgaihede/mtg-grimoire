import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { ReducedBreakdown } from "@/components/ReducedPrice";
import { collectionTotalKey } from "@/features/home/keys";
import { DEFAULT_COLLECTION_VALUE, reducedValue, reducesValue } from "@/lib/collectionValue";
import { FOCUS } from "@/lib/focus";
import { ipc, type CollectionValue } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { useCollectionValue } from "@/lib/useCollectionValue";
import { useMarketplace } from "@/lib/useMarketplace";
import { useReductionDrafts } from "@/lib/useReductionDrafts";
import { cn } from "@/lib/utils";
import { PANEL_BUTTON, TOUCH_FIELD, TOUCH_FLOOR } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** The panel's id stem — `SettingsSection`'s heading is `collection-value-heading`. */
const ID = "collection-value";

/** The crate's bounds, in the page's own words for each box. */
const REFUSED = {
  sellPercent: "Sell percentage has to be above 0 and at most 100.",
  minimumValue: "Minimum card value has to be a price of zero or more.",
  bulkPrice: "Bulk price has to be a price of zero or more.",
};

const BOX = cn(
  "w-24 rounded-md border border-border bg-bg px-2 py-1 text-right font-mono text-sm text-text",
  TOUCH_FIELD,
  TOUCH_FLOOR,
  FOCUS,
);

/** One setting: its name and what it does on the left, its box on the right. */
function Row({
  id,
  title,
  detail,
  prefix,
  suffix,
  value,
  placeholder,
  disabled = false,
  onDraft,
  onCommit,
}: {
  id: string;
  title: string;
  detail: string;
  prefix?: string;
  suffix?: string;
  /** The box's draft — what is stored until the reader types (`useReductionDrafts`). */
  value: string;
  placeholder: string;
  /** Greyed, its figure kept: a setting with nothing to act on yet. `detail` says why. */
  disabled?: boolean;
  onDraft: (text: string) => void;
  onCommit: () => void;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-2",
        disabled && "opacity-50",
      )}
    >
      <label htmlFor={id} className="min-w-0 flex-1 basis-60">
        <span className="block text-sm">{title}</span>
        <span className="block text-xs leading-snug text-dim">{detail}</span>
      </label>
      <div className="flex shrink-0 items-center gap-2 font-mono text-sm text-dim">
        {prefix !== undefined && <span>{prefix}</span>}
        <input
          id={id}
          // One node for the box's whole life (issue #1589): a stored figure re-seeds the draft, so
          // Enter keeps the caret here. Greyed with `aria-disabled` and read-only, never
          // `disabled`, so it stays in the tab order — a Tab out of Minimum lands on it even as
          // that commit is what wakes it.
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          aria-disabled={disabled || undefined}
          readOnly={disabled}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={() => {
            if (!disabled) onCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) onCommit();
          }}
          className={cn(BOX, disabled && "cursor-not-allowed")}
        />
        <span className="w-3">{suffix}</span>
      </div>
    </div>
  );
}

/**
 * What the reader expects to get for their cards: a sell percentage, a minimum card value and a
 * bulk price, which together make the one reduced price drawn beside the collection's value, its
 * folders and the home widgets (issues #1449, #1450, #1477).
 *
 * **A box is a draft until it loses focus or Enter is pressed**, `ScanSoundsPanel`'s rule: a
 * minimum is a new read of the collection, and a reader typing `0.50` is not asking for `0`, `0.` and
 * `0.5` on the way. Then the box is checked and stored, or its sentence is shown and nothing is
 * written. An empty box is that setting's default, which is how one is turned off. Each box's
 * refusal is its own and stays while its draft does (`useReductionDrafts`, issue #1589).
 *
 * **The figures below the boxes are the tooltip's**: `ReducedBreakdown`, over the same total the
 * home page reads, so a reader sees what a setting does to their own collection before they leave
 * the page.
 *
 * **Bulk price is greyed with no minimum**: it prices the cards under the minimum, so with none
 * there is nothing for it to price. Its figure is kept while greyed. It is Open Packs' bulk price's
 * twin and never the same figure (`features/draft/packs/reducedPick.ts`).
 *
 * **The minimum and the bulk price are in the marketplace's own currency** and nothing converts
 * them, so their boxes wear that currency's sign. It reaches the backend itself,
 * `ScanSoundsPanel`'s rule: `useCollectionValue` is the one entry every surface reads, so a hook
 * here is one more reader of it.
 */
export function CollectionValuePanel(): JSX.Element {
  const { settings, minimum, setSettings } = useCollectionValue();
  const { marketplace } = useMarketplace();
  const { drafts, setDraft, commit, refusal, reset } = useReductionDrafts(
    settings,
    setSettings,
    REFUSED,
  );
  const currency = marketplace.currency;
  const sign = formatPrice(0, currency).replace(/[\d.,\s]/g, "");
  const noMinimum = settings.minimumValue === 0;

  const total = useQuery({
    queryKey: collectionTotalKey(marketplace.id, minimum),
    queryFn: () =>
      ipc.collectionSummary({
        limit: 0,
        offset: 0,
        marketplace: marketplace.id,
        minimumValue: minimum,
      }),
  });

  const summary = total.data;
  const reduced =
    !summary || summary.totalCards === 0
      ? null
      : reducedValue(summary.value, summary.belowMinimum, settings);
  const active = reducesValue(settings);

  return (
    <SettingsSection id="collection-value" title="Collection value">
      <p className="text-sm text-dim">
        Cards rarely sell at full market price. Set what you expect to get, and a reduced price
        appears in brackets beside your collection&rsquo;s value, your folders and your Home
        widgets.
      </p>

      <Row
        id={`${ID}-sell`}
        title="Sell percentage"
        detail="The share of market price you expect to get. Sellers often get 70–85%."
        suffix="%"
        value={drafts.sellPercent}
        placeholder="100"
        onDraft={(text) => setDraft("sellPercent", text)}
        onCommit={() => commit("sellPercent")}
      />
      <Row
        id={`${ID}-minimum`}
        title="Minimum card value"
        detail="Cards priced below this aren't counted at their price, because they aren't worth selling one by one."
        prefix={sign}
        value={drafts.minimumValue}
        placeholder="0.00"
        onDraft={(text) => setDraft("minimumValue", text)}
        onCommit={() => commit("minimumValue")}
      />
      <Row
        id={`${ID}-bulk`}
        title="Bulk price"
        detail={
          noMinimum
            ? "What each card under the minimum is worth instead. Set a minimum card value first."
            : "What each card under the minimum is worth instead, such as a store's bulk rate. Empty counts them as nothing."
        }
        prefix={sign}
        value={drafts.bulkPrice}
        placeholder="0.00"
        disabled={noMinimum}
        onDraft={(text) => setDraft("bulkPrice", text)}
        onCommit={() => commit("bulkPrice")}
      />

      <PanelAlert tone="problem">{refusal}</PanelAlert>

      <div aria-hidden="true" className="h-px bg-border" />

      {!active ? (
        <p className="text-sm text-dim">No reduced price is set, so only full values are shown.</p>
      ) : (
        <div className="space-y-2.5">
          {reduced !== null && (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="text-sm">Your collection with these settings</span>
                <span className="font-mono text-[15px] whitespace-nowrap tabular-nums">
                  <span className="text-accent">{formatPrice(reduced.full, currency)}</span>{" "}
                  <span className="text-dim">(</span>
                  {formatPrice(reduced.reduced, currency)}
                  <span className="text-dim">)</span>
                </span>
              </div>
              <div className="rounded-md border border-border bg-bg px-3 py-2.5 text-xs">
                <ReducedBreakdown value={reduced} currency={currency} />
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="min-w-0 flex-1 basis-60 text-xs leading-snug text-dim">
              The minimum is checked first, on each card&rsquo;s market price, and the bulk price is
              added after the sell percentage. Prices are {marketplace.label}&rsquo;s.
            </p>
            <button
              type="button"
              onClick={() => {
                reset();
                setSettings(DEFAULT_COLLECTION_VALUE);
              }}
              className={cn(PANEL_BUTTON, "border-border text-text")}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
