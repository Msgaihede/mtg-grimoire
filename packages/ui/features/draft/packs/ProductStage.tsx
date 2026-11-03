import { useEffect, useId, useMemo, useState, type JSX } from "react";
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
import { openableMatches, openables, openableValue, type Openable } from "./products";
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
 * on average. The product row and the wall are on the left; the price controls and the figures
 * are in the column beside them; on a narrow page (the `@container`'s width, not the window's)
 * that column goes under the wall.
 */
export function ProductStage({ set }: { set: BoosterSet }): JSX.Element {
  const pickId = useId();
  const options = useMemo(() => openables(set), [set]);
  const byValue = useMemo(() => new Map(options.map((o) => [openableValue(o), o])), [options]);
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

  // The tally is kept from here rather than in each press, so the open a pick waited on (below)
  // is plain state set during a render.
  useEffect(() => {
    if (tally !== undefined) tallyMemory.keep(tally);
  }, [tally]);

  /** Open `openable` once: the wall's new pack, and the session's tally one press longer. */
  const openNow = (openable: Openable) => {
    const next = openOne(set, openable, randomSeed());
    const prices = openedPrices(next, priceOf);
    const priced = prices.filter((p): p is number => p !== null);
    setOpened(next);
    setTally({
      currency,
      opened: shownTally.opened + 1,
      value: shownTally.value + openedValue(next, priceOf),
      ev: shownTally.ev + theoreticalValue(set, openable, priceOf),
      prices: [...shownTally.prices, ...priced],
      unpriced: shownTally.unpriced + (prices.length - priced.length),
    });
  };

  // **A pick opens one** (issue #1496): nobody picks a product and does not want to open it, so
  // picking one is the first press. Before the prices answer, the open waits for them — the
  // tally adds a pack's value at the press, and a pack opened before then would count $0 for
  // ever. Taken during render, React's *adjusting state when a prop changes*, for
  // `react-hooks/set-state-in-effect`'s reason. Open itself never waits: a read that failed
  // never answers, and the press stays the reader's.
  const [pending, setPending] = useState<Openable | null>(null);
  if (pending !== null && ready) {
    setPending(null);
    openNow(pending);
  }

  const open = () => {
    if (choice === undefined) return;
    setPending(null);
    openNow(choice);
  };

  /**
   * The product row's pick. A pick of the product already on the wall is no press: the reader
   * closed the list on what they had, and Open another is beside it.
   */
  const pick = (value: string) => {
    const product = byValue.get(value);
    const again = value === chosen && opened !== null;
    setChosen(value);
    if (product === undefined || again) return;
    if (ready) {
      setPending(null);
      openNow(product);
    } else {
      setPending(product);
    }
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
    // Two columns from the top (issue #1465): the product row and what was opened on the left, and
    // on the right everything that decides a price — the marketplaces, Sell at and Minimum — above
    // the figures those prices make. On a narrow page (the `@container`'s width, not the window's)
    // the right column goes under the left.
    <div className="@container/packs">
      <div className="flex flex-col gap-6 @min-[900px]/packs:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <label id={`${pickId}-label`} htmlFor={pickId} className="sr-only">
              Product
            </label>
            {/* Searchable (issue #1464): a set can sell a dozen boosters and boxes, and typing
                "collector box" is quicker than reading them. The shell owns the query; the match
                is the products' own (`openableMatches`) — every word, against name, kind and
                category. */}
            <Dropdown
              id={pickId}
              labelledBy={`${pickId}-label`}
              value={chosen}
              onChange={pick}
              options={options.map((o) => ({
                value: openableValue(o),
                label: o.name,
                hint: o.kind === "booster" ? "Booster" : "Sealed",
              }))}
              searchable
              searchLabel="Search products"
              searchPlaceholder="Search packs and boxes"
              emptyLine="No product matches."
              matches={(option, query) => {
                const product = byValue.get(option.value);
                return product !== undefined && openableMatches(product, query);
              }}
              className="min-w-64 max-w-[28rem]"
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
          </div>

          {opened !== null && (
            <section aria-label="What you opened" className="flex min-w-0 flex-col gap-3">
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
          )}
        </div>

        <div className="flex w-full shrink-0 flex-col gap-6 @min-[900px]/packs:w-[22rem]">
          <section aria-label="Prices" className="flex flex-col gap-3">
            {/* The caption over the box, the printings bar's `Sort`: a bare "TCGplayer" chip would
                not say it is where the prices come from. */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${pickId}-market`} className={FILTER_LABEL}>
                Prices from
              </label>
              <MarketplaceCombobox
                id={`${pickId}-market`}
                choices={priceAt.choices}
                picked={priceAt.marketplaces}
                onToggle={priceAt.toggle}
                className="w-full"
              />
              {note !== null && (
                <p role="status" className="m-0 text-xs text-dim">
                  {note}
                </p>
              )}
            </div>
            {/* The page's own reduced price, apart from Settings' (`reducedPick.ts`). */}
            <ReducedInputs settings={reduction} currency={currency} onChange={keepReduction} />
          </section>

          {opened !== null ? (
            <PackFigures
              figures={figures}
              value={value}
              noun={words.noun}
              unit={words.unit}
              currency={currency}
              tally={shownTally}
              reducedTally={reducedTally}
            />
          ) : (
            figures !== null && (
              // One line, the label a bare text node of it: the line reads "Expected value $3.73"
              // whole, as it did in the product row.
              <p className="m-0 flex items-baseline justify-between gap-4 text-sm text-dim">
                Expected value{" "}
                <span className="font-mono tabular-nums text-text">
                  {formatPrice(figures.ev, currency)}
                </span>
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}
