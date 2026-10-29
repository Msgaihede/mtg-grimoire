import { Fragment, type JSX } from "react";
import { ArrowLeft, ArrowRight, Bot, Check } from "lucide-react";
import type { DraftView } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { cn } from "@/lib/utils";

/**
 * The round strip: one stop per booster, `P1 FRA ··· P2 HOB ··· P3 HOB`, the round on screen in
 * accent and the rounds behind it ticked off; then the pick within the round against the
 * booster's size, and which way the pack goes.
 */
export function RoundStrip({ view }: { view: DraftView }): JSX.Element {
  const rounds = Array.from({ length: view.packCount }, (_, i) => view.packSets[i] ?? "");
  const Arrow = view.passLeft ? ArrowLeft : ArrowRight;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <ol aria-label="Rounds" className="m-0 flex list-none items-center gap-2 p-0">
        {rounds.map((code, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <li aria-hidden="true" className="font-mono text-xs tracking-[0.3em] text-dim">
                ···
              </li>
            )}
            <li
              aria-current={i === view.packNumber ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs",
                i === view.packNumber
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : i < view.packNumber
                    ? "border-border text-text"
                    : "border-border text-dim",
              )}
            >
              <span>P{i + 1}</span>
              {code !== "" && (
                <>
                  <i className={cn(setGlyphClass(code), "text-sm")} aria-hidden="true" />
                  <span>{code.toUpperCase()}</span>
                </>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
      {view.status === "drafting" && (
        <>
          <span className="font-mono text-sm tabular-nums text-dim">
            {view.pickNumber + 1}/{view.packSize}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-dim">
            <Arrow className="size-3.5" aria-hidden="true" />
            {view.passLeft ? "Passing left" : "Passing right"}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The table, seat by seat from the reader's: each seat's name, a bot marked as one, whether it
 * has picked this step, and how many cards it holds. A person who dropped is drawn dim.
 */
export function SeatsStrip({ view }: { view: DraftView }): JSX.Element {
  return (
    <ol aria-label="Table" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
      {view.seats.map((seat, i) => {
        const you = i === view.seat;
        const state = seat.picked ? "picked" : "picking";
        return (
          <li
            key={i}
            aria-label={`${you ? "You" : seat.name}${seat.bot ? " (bot)" : ""}: ${state}, ${seat.poolCount} cards`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs",
              you ? "border-accent/60 text-accent" : "border-border text-text",
              !seat.bot && !seat.connected && "opacity-50",
            )}
          >
            {seat.bot && <Bot className="size-3.5 text-dim" aria-hidden="true" />}
            <span className="max-w-28 truncate">{you ? "You" : seat.name}</span>
            <span className="font-mono tabular-nums text-dim">{seat.poolCount}</span>
            {seat.picked ? (
              <Check className="size-3.5 text-ok" aria-hidden="true" />
            ) : (
              <span aria-hidden="true" className="size-1.5 rounded-full bg-dim/50" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
