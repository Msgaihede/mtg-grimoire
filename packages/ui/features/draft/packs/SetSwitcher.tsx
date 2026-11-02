import { useState, type JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { BoosterSetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { cn } from "@/lib/utils";
import { setMatches } from "../SetGrid";

/**
 * The set page's own set picker (issue #1466): a searchable single-select in the page bar, so the
 * reader moves to another set without walking back up to the set wall.
 *
 * **MTGJSON's sets, not the corpus's** — `sets` is `useBoosterSets`' list, the wall's own, in the
 * wall's order (newest first; the shell never sorts). That is why this is not the search page's
 * `SetCombobox`: that one is a multi-select over `list_sets`, which offers sets no booster is sold
 * of (the folder's binding rule).
 *
 * The search is **controlled** so it matches the way the wall's filter box does — `setMatches`,
 * a set's name or its code — rather than the shell's label-only substring test, and it starts
 * empty on each opening (`onOpen`), as an uncontrolled box would.
 */
export function SetSwitcher({
  sets,
  value,
  onPick,
  className,
}: {
  sets: readonly BoosterSetSummary[];
  /** The code of the set the page is on. */
  value: string;
  onPick: (set: BoosterSetSummary) => void;
  className?: string;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const shown = sets.filter((s) => setMatches(s, query));
  // A query that leaves the page's own set out of the rows must not blank the closed trigger.
  const current = sets.find((s) => s.code === value)?.name;
  return (
    <Dropdown
      // The trigger's content is the set's name; its name is the field's.
      label="Set"
      value={value}
      placeholder={current}
      onChange={(code) => {
        const set = sets.find((s) => s.code === code);
        if (set !== undefined && set.code !== value) onPick(set);
      }}
      options={shown.map((s) => ({
        value: s.code,
        label: s.name,
        hint: s.code.toUpperCase(),
        icon: (
          <i className={cn(setGlyphClass(s.code), "w-4 shrink-0 text-center")} aria-hidden="true" />
        ),
      }))}
      // The page bar's actions sit at its right edge.
      align="end"
      searchable
      searchPlaceholder="Name or code"
      searchLabel="Search sets"
      query={query}
      onQueryChange={setQuery}
      onOpen={() => setQuery("")}
      emptyLine={sets.length === 0 ? "No sets to open yet." : "No matching sets."}
      className={cn("min-w-56 max-w-[20rem]", className)}
      panelClassName="w-80"
    />
  );
}
