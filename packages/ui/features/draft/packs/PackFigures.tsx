import { useId, useState, type JSX, type ReactNode } from "react";
import type { Currency } from "@/lib/marketplace";
import { formatPrice, parsePurchasePrice, unreadablePriceNote } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { chanceToBeat, histogram, percentileOf } from "../booster/value";
import type { Figures } from "./opening";
import { ValueHistogram } from "./ValueHistogram";

/** Bars in the distribution: enough for its shape, few enough that each is a bar and not a hair. */
const BINS = 24;

/** `1st`, `2nd`, `3rd`, `11th`, `73rd`. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** A share as a whole percent, never claiming certainty it does not have: `<1%`, `>99%`. */
export function percentText(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 1) return "<1%";
  if (pct < 100 && pct > 99) return ">99%";
  return `${Math.round(pct)}%`;
}

/** The session's opening, as the page keeps it. */
export interface Tally {
  opened: number;
  value: number;
  ev: number;
  currency: Currency;
}

/**
 * The product's figures beside what was opened (spec §7; botbox.dev's *Expected Value & Pack
 * Statistics*): expected value in theory and over ten thousand simulated packs, the spread, the
 * median, the pack's percentile, the chance to beat what the reader paid, the distribution with the
 * pack marked on it, and the session's tally.
 *
 * `figures` is `null` until the prices have answered — every figure here is a sum of prices, and a
 * sum over em dashes would be a confident zero.
 */
export function PackFigures({
  figures,
  value,
  unit,
  noun,
  currency,
  tally,
}: {
  figures: Figures | null;
  /** What was opened is worth this. */
  value: number;
  /** What one simulated value is, plural — "packs", "boxes". */
  unit: string;
  /** What the reader opened, for the sentences — "pack", "box". */
  noun: string;
  currency: Currency;
  tally: Tally;
}): JSX.Element {
  const paidId = useId();
  const [paidText, setPaidText] = useState("");
  const paid = parsePurchasePrice(paidText) ?? null;
  const note = unreadablePriceNote(paidText);
  const money = (v: number) => formatPrice(v, currency);

  if (figures === null) {
    return (
      <aside aria-label="Figures" className={ASIDE}>
        <h3 className={LABEL}>Expected value</h3>
        <p className="m-0 text-sm text-dim">Reading prices…</p>
      </aside>
    );
  }

  const percentile = Math.min(99, Math.max(1, Math.round(percentileOf(figures.simulated, value))));
  const beat = paid === null ? null : chanceToBeat(figures.simulated, paid);
  const bins = histogram(figures.simulated, BINS);

  return (
    <aside aria-label="Figures" className={ASIDE}>
      <section className="flex flex-col gap-2">
        <h3 className={LABEL}>Expected value</h3>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
          <Row term="Theoretical">{money(figures.ev)}</Row>
          <Row term={`Simulated (${figures.simulated.length.toLocaleString("en-US")} ${unit})`}>
            {money(figures.simulatedMean)}
          </Row>
          <Row term="Standard deviation">{money(figures.sd)}</Row>
          <Row term="Median">{money(figures.median)}</Row>
        </dl>
        <p className="m-0 text-sm">
          Your {noun} is in the <span className="font-semibold">{ordinal(percentile)}</span>{" "}
          percentile.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor={paidId} className={LABEL}>
          What you paid
        </label>
        <input
          id={paidId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={paidText}
          onChange={(e) => setPaidText(e.target.value)}
          placeholder={money(figures.ev)}
          aria-describedby={`${paidId}-answer`}
          className={cn(
            "h-9 w-full rounded-md border border-border bg-bg px-3 font-mono text-sm tabular-nums",
            "placeholder:text-dim focus:border-accent focus:outline-none",
          )}
        />
        <p id={`${paidId}-answer`} aria-live="polite" className="m-0 min-h-5 text-sm">
          {note !== null ? (
            <span className="text-destructive">{note}</span>
          ) : beat !== null && paid !== null ? (
            <>
              <span className="font-semibold">{percentText(beat)}</span> chance a {noun} is worth
              more than {money(paid)}.
            </>
          ) : (
            <span className="text-dim">Type a price to see the chance to beat it.</span>
          )}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={LABEL}>Simulated value</h3>
        <ValueHistogram
          bins={bins}
          marked={value}
          markedLabel={`Yours ${money(value)}`}
          paid={paid}
          currency={currency}
          unit={unit}
          summary={
            `${figures.simulated.length.toLocaleString("en-US")} simulated ${unit}, ` +
            `from ${money(figures.simulated[0] ?? 0)} to ` +
            `${money(figures.simulated[figures.simulated.length - 1] ?? 0)}, median ` +
            `${money(figures.median)}; yours, ${money(value)}, is in the ` +
            `${ordinal(percentile)} percentile.`
          }
        />
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className={LABEL}>This session</h3>
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
          <Row term="Opened">{tally.opened.toLocaleString("en-US")}</Row>
          <Row term="Total value">{formatPrice(tally.value, tally.currency)}</Row>
          <Row term="Total expected">{formatPrice(tally.ev, tally.currency)}</Row>
        </dl>
      </section>
    </aside>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-dim">{term}</dt>
      <dd className="m-0 text-right font-mono tabular-nums">{children}</dd>
    </>
  );
}

const LABEL = "m-0 text-[0.6875rem] font-normal tracking-[0.08em] text-dim uppercase";

const ASIDE = "flex min-w-0 flex-col gap-6";
