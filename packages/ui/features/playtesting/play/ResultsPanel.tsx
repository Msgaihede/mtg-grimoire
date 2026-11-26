import { useState, type JSX } from "react";
import type { PlaytestAction, PlaytestResults } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { canKeepResults, resultsConfirm, resultsTitle, resultWord, toggleResult } from "./results";

/**
 * Coin flips to keep or die rolls to ignore (`prompt.results`): Krark's Thumb's two flips, a
 * die-roll replacement's extra dice. Every result is drawn; a click picks one of the `eligible`
 * ones (for dice, those tied for the lowest), and the confirm button sends exactly `count` of
 * them (`keepResults`).
 */
export function ResultsPanel({
  results,
  disabled,
  onAct,
  className,
}: {
  results: PlaytestResults;
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  className?: string;
}): JSX.Element {
  const [picked, setPicked] = useState<number[]>([]);
  const ready = canKeepResults(results, picked) && !disabled;
  const title = resultsTitle(results);

  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col", className)}>
      <p className="m-0 px-3 pt-1.5 text-[12px] text-dim">{title}</p>
      <ul
        aria-label={results.dice ? "Rolls" : "Flips"}
        className="m-0 flex list-none flex-wrap gap-1.5 p-1.5"
      >
        {results.results.map((value, i) => {
          const eligible = results.eligible.includes(i);
          const on = picked.includes(i);
          const word = resultWord(results, value);
          return (
            <li key={i}>
              <button
                type="button"
                aria-pressed={on}
                aria-disabled={!eligible || disabled}
                aria-label={`${results.dice ? "Roll" : "Flip"} ${i + 1}: ${word}`}
                onClick={() => {
                  if (eligible && !disabled) setPicked((p) => toggleResult(results, p, i));
                }}
                className={cn(
                  "inline-flex h-11 min-w-11 items-center justify-center rounded-lg border px-3 font-mono text-[14px] tabular-nums",
                  "transition-colors motion-reduce:transition-none",
                  FOCUS,
                  on
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-border hover:border-accent",
                  !eligible && "cursor-not-allowed opacity-40",
                )}
              >
                {word}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-none items-center justify-end gap-1.5 px-1.5 pb-1.5">
        <span className="mr-auto pl-1.5 font-mono text-xs text-dim tabular-nums">
          {picked.length} of {results.count}
        </span>
        <button
          type="button"
          aria-disabled={!ready}
          onClick={() => {
            if (ready) onAct({ type: "keepResults", indices: picked });
          }}
          className={cn(
            SMALL_BUTTON,
            "border-accent font-semibold text-accent",
            ready
              ? "hover:bg-accent hover:text-accent-fg"
              : "cursor-default opacity-45 active:scale-100",
          )}
        >
          {resultsConfirm(results)}
        </button>
      </div>
    </section>
  );
}

const SMALL_BUTTON = cn(
  "inline-flex h-7 items-center gap-1 rounded-full border bg-surface px-3 text-[12px]",
  "transition-colors motion-reduce:transition-none disabled:opacity-45",
  PRESS,
  FOCUS,
);
