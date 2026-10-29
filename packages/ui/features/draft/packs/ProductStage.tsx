import { useId, useMemo, useState, type JSX } from "react";
import { PackageOpen, RotateCcw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { BUTTON } from "@/features/settings/controls";
import { plural } from "@/lib/counts";
import type { BoosterSet } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { useBoosterPrices } from "../booster/prices";
import { randomSeed } from "../booster/rng";
import {
  figuresOf,
  openedValue,
  openOne,
  theoreticalValue,
  type CardSort,
  type Opened,
} from "./opening";
import { OpenedWall } from "./OpenedWall";
import { PackFigures, type Tally } from "./PackFigures";
import { openables, openableValue, type Openable } from "./products";

/**
 * **The session's tally, for the window's life** (`lib/viewMemory.ts`): a reader who opens ten
 * packs of one set and goes on to another wants the running total to carry on, and a restart to
 * start it again. Prices are a currency's; a switch of marketplace starts it over rather than
 * adding dollars to euros.
 */
const tallyMemory = viewMemory<Tally>("draft.packs.tally");

/** The primary press: accent-filled, the Playtesting lobby's Start. */
export const PRIMARY = cn(
  BUTTON,
  "h-9 border-accent bg-accent px-4 font-semibold text-accent-fg hover:bg-accent/90",
);
/** A secondary press. */
export const SECONDARY = cn(BUTTON, "h-9 border-border bg-surface hover:border-accent/60");

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
  const { priceOf, ready, currency } = useBoosterPrices(set);
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
      : { opened: 0, value: 0, ev: 0, currency };

  const open = () => {
    if (choice === undefined) return;
    const next = openOne(set, choice, randomSeed());
    setOpened(next);
    const kept: Tally = {
      currency,
      opened: shownTally.opened + 1,
      value: shownTally.value + openedValue(next, priceOf),
      ev: shownTally.ev + theoreticalValue(set, choice, priceOf),
    };
    tallyMemory.keep(kept);
    setTally(kept);
  };

  if (options.length === 0) {
    return <p className="m-0 text-sm text-dim">{set.name} has no boosters to open.</p>;
  }

  const value = opened === null ? 0 : openedValue(opened, priceOf);
  const words = nouns(shown ?? choice);

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
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
