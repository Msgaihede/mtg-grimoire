import { useId, useMemo, useState, type JSX } from "react";
import { PackageOpen, RotateCcw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { ReducedPrice } from "@/components/ReducedPrice";
import { FILTER_LABEL } from "@/components/FilterChips";
import { BUTTON } from "@/features/settings/controls";
import { plural } from "@/lib/counts";
import type { BoosterSet } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { useBoosterPrices } from "../booster/prices";
import { randomSeed } from "../booster/rng";
import {
  figuresOf,
  openedPrices,
  openedValue,
  openOne,
  reducedOpening,
  theoreticalValue,
  type CardSort,
  type Opened,
} from "./opening";
import type { PricingPlan } from "./currency";
import { MarketplaceCombobox } from "./MarketplaceCombobox";
import { usePackMarketplaces } from "./marketplaces";
import { OpenedWall } from "./OpenedWall";
import { PackFigures, type Tally } from "./PackFigures";
import { openables, openableValue, type Openable } from "./products";
import { PACKS_SET_IN, ReducedInputs } from "./ReducedInputs";
import { usePackReducedStore } from "./reducedPick";

/**
 * **The session's tally, for the window's life** (`lib/viewMemory.ts`): a reader who opens ten
 * packs of one set and goes on to another wants the running total to carry on, and a restart to
 * start it again. Prices are a currency's; a switch of marketplace starts it over rather than
 * adding dollars to euros. It keeps each priced card's price, not a reduced sum, so the reduced
 * price beside it is always the page's figures as they stand.
 */
const tallyMemory = viewMemory<Tally>("draft.packs.tally");

/** The primary press: accent-filled, the Playtesting lobby's Start. */
export const PRIMARY = cn(
  BUTTON,
  "h-9 border-accent bg-accent px-4 font-semibold text-accent-fg hover:bg-accent/90",
);
/** A secondary press. */
export const SECONDARY = cn(BUTTON, "h-9 border-border bg-surface hover:border-accent/60");

const CURRENCY_NAME: Record<Currency, string> = { usd: "dollars", eur: "euros" };

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line under the picker when the pick names two currencies: what the figures are in and the
 * rate they were converted at, that the rate is on its way, or which marketplaces were left out
 * for want of one. Nothing for a pick of one currency — nothing was converted.
 */
export function conversionNote(picked: readonly Marketplace[], plan: PricingPlan): string | null {
  if (plan.rate !== null) {
    const { usdPerEur, date } = plan.rate;
    return (
      `Lowest of ${listed(picked.map((m) => m.label))}, in ${CURRENCY_NAME[plan.currency]} — ` +
      `converted at €1 = $${usdPerEur.toFixed(4)}, the ECB's rate of ${date}.`
    );
  }
  if (plan.waiting) return "Fetching the exchange rate…";
  if (plan.leftOut.length > 0) {
    const names = listed(plan.leftOut.map((m) => m.label));
    return `${names} left out: the exchange rate could not be fetched, and prices in two currencies can't be compared without it.`;
  }
  return null;
}

/** "pack" for a booster, "box" for a sealed product — the words the figures speak in. */
function nouns(openable: Openable): { noun: string; unit: string } {
  return openable.kind === "booster"
    ? { noun: "pack", unit: "packs" }
    : { noun: "box", unit: "boxes" };
}

/**
 * One set picked: choose a product, open it, and read what it was worth against what it is worth
 * on average. The wall is on the left and the figures beside it; on a narrow page (the
 * `@container`'s width, not the window's) the figures go under the wall.
 */
export function ProductStage({ set }: { set: BoosterSet }): JSX.Element {
  const pickId = useId();
  const options = useMemo(() => openables(set), [set]);
  const [chosen, setChosen] = useState(() => (options[0] ? openableValue(options[0]) : ""));
  const [opened, setOpened] = useState<Opened | null>(null);
  const [sort, setSort] = useState<CardSort>("price");
  const [tally, setTally] = useState<Tally | undefined>(() => tallyMemory.recall());
  const priceAt = usePackMarketplaces();
  const reduction = usePackReducedStore((s) => s.settings);
  const keepReduction = usePackReducedStore((s) => s.keep);
  const {
    priceOf,
    ready: pricesReady,
    currency,
  } = useBoosterPrices(set, priceAt.plan.sources, priceAt.plan.currency);
  // A mixed pick waits for its rate, so the figures never jump from one marketplace's to two.
  const ready = pricesReady && !priceAt.plan.waiting;
  const note = conversionNote(priceAt.marketplaces, priceAt.plan);
  const facts = useMemo(() => new Map(set.cards.map((c) => [c.cardId, c])), [set]);

  const choice = options.find((o) => openableValue(o) === chosen) ?? options[0];
  const shown = opened?.openable ?? choice;
  const figures = useMemo(
    () => (ready && shown !== undefined ? figuresOf(set, shown, priceOf) : null),
    [ready, set, shown, priceOf],
  );
  const shownTally: Tally =
    tally !== undefined && tally.currency === currency
      ? tally
      : { opened: 0, value: 0, ev: 0, currency, prices: [], unpriced: 0 };

  const open = () => {
    if (choice === undefined) return;
    const next = openOne(set, choice, randomSeed());
    setOpened(next);
    const prices = openedPrices(next, priceOf);
    const priced = prices.filter((p): p is number => p !== null);
    const kept: Tally = {
      currency,
      opened: shownTally.opened + 1,
      value: shownTally.value + openedValue(next, priceOf),
      ev: shownTally.ev + theoreticalValue(set, choice, priceOf),
      prices: [...shownTally.prices, ...priced],
      unpriced: shownTally.unpriced + (prices.length - priced.length),
    };
    tallyMemory.keep(kept);
    setTally(kept);
  };

  if (options.length === 0) {
    return <p className="m-0 text-sm text-dim">{set.name} has no boosters to open.</p>;
  }

  const value = opened === null ? 0 : openedValue(opened, priceOf);
  const words = nouns(shown ?? choice);
  const prices = opened === null || !ready ? [] : openedPrices(opened, priceOf);
  const reduced = opened === null || !ready ? null : reducedOpening(value, prices, reduction);
  const reducedTally =
    shownTally.opened === 0 ? null : reducedOpening(shownTally.value, shownTally.prices, reduction);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <label id={`${pickId}-label`} htmlFor={pickId} className="sr-only">
          Product
        </label>
        <Dropdown
          id={pickId}
          labelledBy={`${pickId}-label`}
          value={chosen}
          onChange={setChosen}
          options={options.map((o) => ({
            value: openableValue(o),
            label: o.name,
            hint: o.kind === "booster" ? "Booster" : "Sealed",
          }))}
          className="min-w-64 max-w-[28rem]"
        />
        {/* The caption beside the trigger, the printings bar's `Sort`: a bare "TCGplayer" in a row
            of buttons would not say it is where the prices come from. */}
        <label htmlFor={`${pickId}-market`} className={FILTER_LABEL}>
          Prices from
        </label>
        <MarketplaceCombobox
          id={`${pickId}-market`}
          choices={priceAt.choices}
          picked={priceAt.marketplaces}
          onToggle={priceAt.toggle}
        />
        <button type="button" onClick={open} className={PRIMARY}>
          <PackageOpen className="size-4" aria-hidden="true" />
          {opened === null ? "Open" : "Open another"}
        </button>
        {opened !== null && (
          <button type="button" onClick={() => setOpened(null)} className={SECONDARY}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Back
          </button>
        )}
        {opened === null && figures !== null && (
          <p className="m-0 text-sm text-dim">
            Expected value{" "}
            <span className="font-mono tabular-nums text-text">
              {formatPrice(figures.ev, currency)}
            </span>
          </p>
        )}
      </div>
      {note !== null && (
        <p role="status" className="-mt-3 text-xs text-dim">
          {note}
        </p>
      )}
      {/* The page's own reduced price, apart from Settings' (`reducedPick.ts`). Under the row
          rather than in it: the row is already the product, its prices and the press. */}
      <ReducedInputs settings={reduction} currency={currency} onChange={keepReduction} />

      {opened !== null && (
        <div className="@container/packs">
          <div className="flex flex-col gap-6 @min-[900px]/packs:flex-row">
            <section aria-label="What you opened" className="flex min-w-0 flex-1 flex-col gap-3">
              <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h3 className="m-0 text-base font-semibold">
                  Total value{" "}
                  <span className="font-mono tabular-nums text-accent">
                    {ready ? formatPrice(value, currency) : "…"}
                  </span>
                  {reduced !== null && (
                    <>
                      {" "}
                      <ReducedPrice
                        value={reduced}
                        currency={currency}
                        unpriced={prices.filter((p) => p === null).length}
                        setIn={PACKS_SET_IN}
                        className="font-mono font-normal text-dim"
                      />
                    </>
                  )}
                </h3>
                <p className="m-0 font-mono text-sm tabular-nums text-dim">
                  {opened.openable.name} · {plural(opened.cards.length, "card")}
                  {opened.openable.kind === "sealed" && ` · ${plural(opened.boosters, "booster")}`}
                </p>
              </header>
              {opened.skipped > 0 && (
                <p className="m-0 text-sm text-dim">
                  {plural(opened.skipped, "item")} in it could not be opened — boosters of another
                  set, or products MTGJSON does not describe — and{" "}
                  {opened.skipped === 1 ? "is" : "are"} left out of every figure.
                </p>
              )}
              <OpenedWall
                cards={opened.cards}
                facts={facts}
                priceOf={priceOf}
                currency={currency}
                sort={sort}
                onSort={setSort}
              />
            </section>
            <div className="w-full shrink-0 @min-[900px]/packs:w-[22rem]">
              <PackFigures
                figures={figures}
                value={value}
                noun={words.noun}
                unit={words.unit}
                currency={currency}
                tally={shownTally}
                reducedTally={reducedTally}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
