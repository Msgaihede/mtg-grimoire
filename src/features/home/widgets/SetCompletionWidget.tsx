/**
 * How close each set the reader collects is to complete — a row per set, with how many of its
 * cards they hold and a track under the name.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip and the tray; this draws the rows,
 * cut to the box it was handed.
 *
 * ## Rust counts, this file orders
 *
 * `set_completion` answers one row per set holding at least one owned card: the distinct collector
 * numbers held inside the set's printed size, and that size. **Which set comes first is a display
 * decision and lives here** ({@link sortSets}), `src/CLAUDE.md`'s rule about option lists applied
 * to a list of rows: the three orders the registry offers are three readings of one answer, and a
 * command per order would be three places the same count is written.
 *
 * ## A set with no printed size is not 0 % complete
 *
 * `size` is Scryfall's `printed_size`, and it is `null` for a set Scryfall publishes none for — every
 * set before collector numbers carried a denominator, and a corpus that has not synced since the
 * column arrived. Such a set has **no percentage to draw**: its caption says how many cards are held
 * (`12 cards`), its figure is an em dash, it draws no track, and a hint on the row says why. Sorted
 * by completeness it goes **last**, below every set that has an answer — a reader asking *which set
 * am I closest to finishing* is not asking about a set nobody can measure.
 *
 * ## A percentage never rounds up to done
 *
 * `302 of 303` is not `100%`. The figure is floored, so it reads 100 only for a set that really is
 * complete, and a set with a single card of a large one reads `<1%` rather than a flat `0%` beside
 * a caption saying the reader has one.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { plural } from "@/lib/counts";
import { ipc, ipcError, type SetCompletion } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";

import { setCompletionKey } from "../keys";
import { WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOn } from "../widgetSettings";

/** The three orders the registry's `sort` pick offers. */
export type SetOrder = "complete" | "cards" | "name";

/**
 * A row's height, by what it carries — the design's four figures (36 bare, 42 with a track, 51 with
 * a caption, 57 with both) as a sum, and what `rowsFit` cuts by.
 *
 * **Asked of the row actually drawn, not of the card's density.** The design keyed it on `bare`
 * alone, and a two-cell tile is bare *and* moves its figure under the name as a caption — so it was
 * counted at 42 and drawn at 57, and the shipped window showed a third row cut through its middle
 * (2026-09-15, catalogue preview).
 */
function rowPx(caption: boolean, track: boolean): number {
  return 36 + (caption ? 15 : 0) + (track ? 6 : 0);
}

const PENDING = "Counting your sets…";
export const EMPTY = "No sets yet — the sets your cards come from will appear here.";
/** Not "Scryfall publishes none": a corpus that has not synced since the column arrived reads
 *  `null` for every set, so the hint says what is true in both cases. */
export const NO_SIZE_HINT =
  "There is no printed set size to measure against, so this counts every card of the set you own.";

/**
 * The sets in the order the reader picked.
 *
 * Alphabetical first — through `sortOptions`, the app's one collator — and the pick's own key over
 * that, so every tie is settled by name rather than by whatever order the command answered in.
 * `sortOptions` copies, so the cached array is never sorted in place.
 */
export function sortSets(sets: readonly SetCompletion[], order: SetOrder): SetCompletion[] {
  switch (order) {
    case "name":
      return sortOptions(sets, (set) => set.name);
    case "cards":
      return sortOptions(
        sets,
        (set) => set.name,
        (set) => [-set.owned],
      );
    case "complete":
      return sortOptions(
        sets,
        (set) => set.name,
        (set) => (set.size === null ? [1, 0] : [0, -share(set)]),
      );
  }
}

/** How much of a measurable set is held, `0..=1`. */
function share(set: SetCompletion): number {
  return set.size === null || set.size <= 0 ? 0 : Math.min(1, set.owned / set.size);
}

/** The figure: a floored percentage, `<1%` for a set barely started, an em dash with no size. */
export function percentLabel(set: SetCompletion): string {
  if (set.size === null || set.size <= 0) return "—";
  const percent = Math.floor(share(set) * 100);
  return percent === 0 && set.owned > 0 ? "<1%" : `${percent}%`;
}

/** The caption: `248 of 303`, or `12 cards` for a set with no printed size. */
export function countLabel(set: SetCompletion): string {
  return set.size === null ? plural(set.owned, "card") : `${set.owned} of ${set.size}`;
}

function orderOf(value: string | number | undefined): SetOrder {
  return value === "cards" || value === "name" ? value : "complete";
}

export function SetCompletionWidget({ widget, fit }: WidgetBodyProps): ReactElement {
  const order = orderOf(pickOf(widget, "sort"));
  const bars = toggleOn(widget, "bars");
  const query = useQuery({ queryKey: setCompletionKey, queryFn: () => ipc.setCompletion() });

  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not count your sets — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.data.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;

  // No caption on a compact card or a two-cell tile: the row keeps its name and its figure.
  const bare = fit.compact || fit.tier === 0;
  // A tile's figure is its caption; a wider bare row has none.
  const captioned = fit.tier === 0 || !bare;
  const shown = sortSets(query.data, order).slice(0, fit.rowsFit(rowPx(captioned, bars)));

  return (
    <WidgetRowList fit={fit} label="Sets">
      {shown.map((set) => {
        const measurable = set.size !== null && set.size > 0;
        // Floored like the figure, so a track never reaches the end of its rail beside a `99%`.
        const track = bars && measurable ? Math.floor(share(set) * 100) / 100 : undefined;
        const hint = measurable ? undefined : NO_SIZE_HINT;
        // At two cells there is no width for a name and a figure side by side, so the figure moves
        // under the name — `WidgetRow`'s own note. A set with no percentage keeps its count
        // there instead, since an em dash alone under a name says nothing.
        return fit.tier === 0 ? (
          <WidgetRow
            key={set.setCode}
            name={set.name}
            caption={measurable ? percentLabel(set) : countLabel(set)}
            captionStrong
            track={track}
            hint={hint}
          />
        ) : (
          <WidgetRow
            key={set.setCode}
            name={set.name}
            caption={bare ? undefined : countLabel(set)}
            value={percentLabel(set)}
            track={track}
            hint={hint}
          />
        );
      })}
    </WidgetRowList>
  );
}
