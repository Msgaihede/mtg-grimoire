import { type JSX } from "react";
import { Copy, X } from "lucide-react";
import { SetGrid } from "@/features/draft/SetGrid";
import { useBoosterSets } from "@/features/draft/sets";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { BoosterSetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { suggestedFirst } from "./deal";
import { LABEL, QUIET_BUTTON } from "./parts";

/**
 * The boosters a draft opens, in the order it opens them — a chip per pack, each with its ✕ —
 * as the setup's side column draws them. Repeats are the ordinary case (three of one set is a
 * set's own draft), so a set may be picked again and again.
 */
export function PackOrder({
  chosen,
  max,
  onChange,
}: {
  chosen: readonly BoosterSetSummary[];
  max: number;
  onChange: (next: BoosterSetSummary[]) => void;
}): JSX.Element {
  const last = chosen[chosen.length - 1];
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={LABEL}>Pack order</h3>
        <span className="text-xs text-dim">
          {plural(chosen.length, "pack")} chosen — {chosen.length >= max ? "all" : "up to"} {max}
        </span>
      </div>
      {chosen.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-dim">
          Pick a set for each pack from the wall.
        </p>
      ) : (
        <ol aria-label="Pack order" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {chosen.map((set, i) => (
            <li
              // A pack is its place in the order; two packs of one set are two rows.
              key={i}
              className="flex h-10 items-center gap-2.5 rounded-lg border border-border bg-surface pl-3 pr-1"
            >
              <span className="font-mono text-xs text-dim">P{i + 1}</span>
              <i
                className={cn(setGlyphClass(set.code), "text-lg leading-none")}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm">{set.name}</span>
              <span className="font-mono text-[0.6875rem] uppercase text-dim">{set.code}</span>
              <button
                type="button"
                aria-label={`Remove pack ${i + 1} (${set.name})`}
                onClick={() => onChange(chosen.filter((_, at) => at !== i))}
                className={cn(
                  "grid size-8 place-items-center rounded-md text-dim hover:text-text",
                  PRESS,
                  FOCUS,
                )}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {last !== undefined && chosen.length < max && (
        <button
          type="button"
          onClick={() =>
            onChange([...chosen, ...Array.from({ length: max - chosen.length }, () => last)])
          }
          className={cn(QUIET_BUTTON, "self-start")}
        >
          <Copy className="size-4" aria-hidden="true" />
          {last.name} for the rest
        </button>
      )}
    </div>
  );
}

/**
 * The wall a pack is picked from: every booster set, newest first, filterable. A press adds the
 * set as the next pack; once every pack is chosen the wall says so instead of adding.
 *
 * `suggested` names sets the draft is made for (a Commander draft's Commander Legends sets): those
 * MTGJSON lists go first and are marked, and every other set follows as it would.
 */
export function AddPackWall({
  chosen,
  max,
  onChange,
  suggested,
}: {
  chosen: readonly BoosterSetSummary[];
  max: number;
  onChange: (next: BoosterSetSummary[]) => void;
  suggested?: readonly string[];
}): JSX.Element {
  const { sets: all, loading, error, retry } = useBoosterSets();
  const sets = suggested === undefined ? all : suggestedFirst(all, suggested);
  const full = chosen.length >= max;
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h3 className={LABEL}>Add a pack</h3>
        {full && (
          <span className="text-xs text-dim">Every pack is chosen — remove one to change it.</span>
        )}
      </div>
      {loading ? (
        <p role="status" className="m-0 text-sm text-dim">
          Fetching the sets from MTGJSON…
        </p>
      ) : error !== null ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
          <button type="button" onClick={retry} className={QUIET_BUTTON}>
            Retry
          </button>
        </div>
      ) : (
        <SetGrid
          sets={sets}
          suggested={suggested}
          label="Sets"
          onPick={(set) => {
            if (!full) onChange([...chosen, set]);
          }}
        />
      )}
    </div>
  );
}
