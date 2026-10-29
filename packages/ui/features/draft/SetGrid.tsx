import { useId, useState, type JSX } from "react";
import { FILTER_FIELD, FILTER_FOCUS } from "@/components/FilterChips";
import { FOCUS } from "@/lib/focus";
import type { SetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { PRESS } from "@/lib/motion";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/** Whether `set` answers the typed text: its name or its code, case aside. */
export function setMatches(set: SetSummary, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  return set.name.toLowerCase().includes(needle) || set.code.toLowerCase().includes(needle);
}

/**
 * A wall of set tiles to pick one from — the Packs page's first step and the draft's pack order
 * (spec §7): a filter box, then every set as a dark tile with its keyrune symbol centred above its
 * name, in the order given (`useBoosterSets` gives newest first).
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
  label = "Sets",
  className,
}: {
  sets: readonly SetSummary[];
  onPick: (set: SetSummary) => void;
  /** The filter text, held by the caller; absent, the grid holds its own. */
  filter?: string;
  onFilterChange?: (text: string) => void;
  /** The code of the set to ring as chosen. */
  picked?: string | null;
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
        <ul
          aria-label={label}
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2 p-0"
        >
          {shown.map((set) => (
            <li key={set.code} className="flex">
              <SetTile set={set} picked={set.code === picked} onPick={() => onPick(set)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One set: its symbol, its name, its code and year in dim mono. */
function SetTile({
  set,
  picked,
  onPick,
}: {
  set: SetSummary;
  picked: boolean;
  onPick: () => void;
}): JSX.Element {
  const year = set.releasedAt?.slice(0, 4);
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      className={cn(
        "flex w-full flex-col items-center gap-2 rounded-lg border px-2 pb-3 pt-4 text-center",
        "transition-colors motion-reduce:transition-none",
        PRESS,
        FOCUS,
        picked
          ? "border-accent bg-accent/10 text-text"
          : "border-border bg-surface text-text hover:border-accent/60 hover:bg-surface/70",
      )}
    >
      <i
        aria-hidden="true"
        className={cn(setGlyphClass(set.code), "text-[2rem] leading-none", picked && "text-accent")}
      />
      <span className="line-clamp-2 text-sm leading-tight">{set.name}</span>
      <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-dim">
        {set.code}
        {year !== undefined && ` · ${year}`}
      </span>
    </button>
  );
}
