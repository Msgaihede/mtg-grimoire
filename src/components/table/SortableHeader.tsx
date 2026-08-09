import { ArrowDown, ArrowUp } from "lucide-react";
import { ariaSortOf, sortRankOf, sortTermOf, type SortSpec } from "@/lib/sort";
import { cn } from "@/lib/utils";

const FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * How the second gesture is taught, since nothing on screen can show it.
 *
 * A tooltip rather than a line under the table: the reader who needs it is the one already
 * pointing at a header, and a permanent caption for a modifier most readers never use would
 * cost 20px of every list to say it.
 */
const SORT_HINT = (label: string) => `Sort by ${label} — Shift-click to add to the sort`;

/**
 * One column's header, when the column can be sorted on.
 *
 * The `role="columnheader"` element carries `aria-sort` and the `<button>` inside it carries
 * the press, which is the split ARIA asks for: a header is not a control, and a control is
 * not a header.
 *
 * `aria-sort` is set on **every** sorted column rather than only the first. The alternative
 * is telling assistive tech that a two-key sort has one key.
 */
export function SortableHeader({
  label,
  ariaLabel,
  title,
  sortKey,
  spec,
  onSort,
  className,
}: {
  label: string;
  /** Overrides the accessible name. Must *begin* with `label` — WCAG 2.5.3. */
  ariaLabel?: string;
  /** What the column has to say for itself. The sort hint is appended, never replaced. */
  title?: string;
  sortKey: string;
  spec: SortSpec;
  onSort: (key: string, additive: boolean) => void;
  className?: string;
}) {
  const term = sortTermOf(spec, sortKey);
  const rank = sortRankOf(spec, sortKey);
  const Arrow = term?.dir === "desc" ? ArrowDown : ArrowUp;
  // Only when there is more than one, because "1 of 1" is a number that says nothing and
  // this row is 36px tall.
  const showRank = rank !== null && spec.length > 1;

  // Label first, always: an accessible name that does not begin with the visible word takes
  // the column out of reach of anyone driving the app by voice.
  //
  // The button says where it sits in the sort; the *header* says what the column is. They
  // are announced in different situations — the header when a screen reader walks the table
  // by column, the button when the caret lands on it — and neither is served by carrying
  // the other's sentence as well.
  const name = showRank ? `${label}, sort priority ${rank}` : label;

  return (
    <span
      role="columnheader"
      aria-sort={ariaSortOf(term)}
      // On the header rather than on the button: name-from-content does not reach into a
      // descendant's `aria-label`, so a column whose whole description lives on the button
      // is a column announced by its bare title. Measured — the Price column read as
      // "Price", losing the sentence spec §5 says a price may never be shown without.
      aria-label={ariaLabel}
      className={cn("min-w-0", className)}
    >
      <button
        type="button"
        // One handler for the mouse and the keyboard both: Chromium reports `shiftKey` on
        // the click it synthesises from Shift+Enter, so the additive press needs no second
        // path and no second thing for a reader to learn.
        onClick={(e) => onSort(sortKey, e.shiftKey)}
        // Left off when it would only repeat what is written on the button — an accessible
        // name identical to the visible text is a name the browser already computes.
        aria-label={name === label ? undefined : name}
        // Appended rather than replaced, and on the button rather than on the header cell:
        // the button fills the cell, so a `title` on the cell is a tooltip nothing can
        // reach. The Price column has a sentence of its own to say (how old the prices
        // are), and a header that swapped it for the sort hint would lose the one fact
        // spec §5 says a price may never be shown without.
        title={title ? `${title}\n${SORT_HINT(label)}` : SORT_HINT(label)}
        className={cn(
          "flex w-full min-w-0 items-center gap-1",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
          // A sorted column is the one the list is answering to, so it stops being dim.
          term && "text-text",
          // The arrow follows the label, so a right-aligned column has to pack to its end
          // or the pair drifts away from the numbers underneath it.
          className?.includes("text-right") ? "justify-end" : "text-left",
        )}
      >
        <span className="truncate">{label}</span>
        {term && <Arrow className="size-3 shrink-0" aria-hidden="true" />}
        {/* `aria-hidden`: the same fact is in the button's name, where a screen reader will
            reach it in words rather than as a bare digit after the column title. */}
        {showRank && (
          <span
            aria-hidden="true"
            className="shrink-0 rounded-sm bg-bg px-1 text-[0.65rem] leading-tight text-dim"
          >
            {rank}
          </span>
        )}
      </button>
    </span>
  );
}
