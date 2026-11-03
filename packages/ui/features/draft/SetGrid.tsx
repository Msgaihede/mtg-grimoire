import { useId, useState, type JSX } from "react";
import { FILTER_FIELD, FILTER_FOCUS } from "@/components/FilterChips";
import { FOCUS } from "@/lib/focus";
import type { BoosterSetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { PRESS } from "@/lib/motion";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/** Whether `set` answers the typed text: its name or its code, case aside. */
export function setMatches(set: BoosterSetSummary, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  return set.name.toLowerCase().includes(needle) || set.code.toLowerCase().includes(needle);
}

/** The sets of one release year, as {@link byYear} cuts them; `year` is `null` for undated sets. */
export interface SetYear {
  year: string | null;
  sets: BoosterSetSummary[];
}

/**
 * `sets` cut into runs of one release year, **in the order given** (issue #1456): a new run starts
 * wherever the year changes, so the newest-first list `useBoosterSets` hands over becomes one run
 * per year, and a list in any other order is never reordered — only cut. Pure, for its suite.
 */
export function byYear(sets: readonly BoosterSetSummary[]): SetYear[] {
  const runs: SetYear[] = [];
  for (const set of sets) {
    const year = set.releaseDate?.slice(0, 4) ?? null;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.year === year) last.sets.push(set);
    else runs.push({ year, sets: [set] });
  }
  return runs;
}

/**
 * A wall of set tiles to pick one from — the Packs page's first step and the draft's pack order
 * (spec §7): a filter box, then every set as a dark tile whose keyrune symbol fills most of it,
 * centred above its name (issue #1497), in the order given (`useBoosterSets` gives newest first), under a divider per release year
 * (issue #1456) — the year in the accent heading face between two rules, as the home page's
 * activity days are headed.
 *
 * **Each year is a list of its own**, named by its year, inside the wall's one list (`label`): a
 * screen reader hears "2025, list, 12 items" on entering a year. The year is a label, not a
 * heading, because the wall sits under an `<h2>` on Open Packs and an `<h3>` in the pack order.
 *
 * **A tile is a button**, so the wall is walked with Tab and pressed with Enter or Space; `picked`
 * rings one and says so (`aria-pressed`). The filter is the grid's own unless the caller holds it
 * (`filter` with `onFilterChange`) — the draft's pack order keeps one box across its rounds.
 */
export function SetGrid({
  sets,
  onPick,
  filter,
  onFilterChange,
  picked = null,
  suggested,
  label = "Sets",
  className,
}: {
  sets: readonly BoosterSetSummary[];
  onPick: (set: BoosterSetSummary) => void;
  /** The filter text, held by the caller; absent, the grid holds its own. */
  filter?: string;
  onFilterChange?: (text: string) => void;
  /** The code of the set to ring as chosen. */
  picked?: string | null;
  /** Codes of the sets to mark *Suggested* — the ones the draft is made for. */
  suggested?: readonly string[];
  /** The wall's accessible name. */
  label?: string;
  className?: string;
}): JSX.Element {
  const fieldId = useId();
  const [own, setOwn] = useState("");
  const text = filter ?? own;
  const setText = (next: string) => {
    if (filter === undefined) setOwn(next);
    onFilterChange?.(next);
  };
  const shown = sets.filter((s) => setMatches(s, text));

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <label htmlFor={fieldId} className="sr-only">
        Filter sets by name or code
      </label>
      <input
        id={fieldId}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => clearFieldOnEscape(e, text, () => setText(""))}
        placeholder="Filter sets…"
        className={cn(
          FILTER_FIELD,
          FILTER_FOCUS,
          "w-full max-w-[22rem] border-border bg-surface px-3",
          "placeholder:text-dim focus:border-accent",
        )}
      />
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-dim">
          {sets.length === 0 ? "No sets to open yet." : `No set matches “${text.trim()}”.`}
        </p>
      ) : (
        <ul aria-label={label} className="m-0 flex list-none flex-col gap-5 p-0">
          {byYear(shown).map((run, i) => (
            // A year can come back in a list not sorted by date (`byYear` never reorders).
            <li key={`${run.year ?? "undated"}-${i}`}>
              <YearRun run={run} picked={picked} suggested={suggested} onPick={onPick} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One year's divider — its label between two rules — and its sets' tiles under it. */
function YearRun({
  run,
  picked,
  suggested,
  onPick,
}: {
  run: SetYear;
  picked: string | null;
  suggested: readonly string[] | undefined;
  onPick: (set: BoosterSetSummary) => void;
}): JSX.Element {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-px w-3.5 bg-border" />
        <span
          id={labelId}
          className="shrink-0 font-heading text-sm leading-none tabular-nums text-accent"
        >
          {run.year ?? "Undated"}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      <ul
        aria-labelledby={labelId}
        className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2 p-0"
      >
        {run.sets.map((set) => (
          <li key={set.code} className="flex">
            <SetTile
              set={set}
              picked={set.code === picked}
              suggested={suggested?.includes(set.code.toLowerCase()) === true}
              onPick={() => onPick(set)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One set: its symbol, filling most of the tile (issue #1497 — the symbol is how a reader knows a
 *  set), its name under it, its code in dim mono in the top-right corner — and *Suggested* in the
 *  top-left when it is one of the sets the draft is made for. The year is the divider's, not the
 *  tile's (issue #1456). The symbol sits in a box of its own height, so symbols of every shape
 *  line up across a row, and the name keeps room for two lines, so a row's tiles are one height. */
function SetTile({
  set,
  picked,
  suggested,
  onPick,
}: {
  set: BoosterSetSummary;
  picked: boolean;
  suggested: boolean;
  onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      className={cn(
        "relative flex w-full flex-col items-center gap-2 rounded-lg border px-2 pb-3 pt-6 text-center",
        "transition-colors motion-reduce:transition-none",
        PRESS,
        FOCUS,
        picked
          ? "border-accent bg-accent/10 text-text"
          : "border-border bg-surface text-text hover:border-accent/60 hover:bg-surface/70",
      )}
    >
      {suggested && (
        <span className="absolute left-1.5 top-1.5 rounded-full border border-accent/50 bg-accent/10 px-1.5 text-[0.625rem] leading-4 text-accent">
          Suggested
        </span>
      )}
      {/* The size is the box's, not the glyph's: keyrune's unlayered `.ss` rule says
          `font-size: inherit`, which beats any Tailwind size class on the `<i>` itself. */}
      <span
        aria-hidden="true"
        className={cn(
          "flex h-24 w-full items-center justify-center text-[5rem] leading-none",
          picked && "text-accent",
        )}
      >
        <i className={setGlyphClass(set.code)} />
      </span>
      <span className="line-clamp-2 min-h-[2lh] text-sm leading-tight">{set.name}</span>
      <span className="absolute right-2 top-1.5 font-mono text-[0.6875rem] uppercase leading-4 tracking-wider text-dim">
        {set.code}
      </span>
    </button>
  );
}
