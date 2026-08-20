import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS_INSET } from "@/lib/focus";
import { TRANSITION } from "@/lib/motion";
import { ariaSortOf, sortRankOf, sortTermOf, type SortSpec } from "@/lib/sort";
import { cn } from "@/lib/utils";

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
  const tip = useTooltip();
  const term = sortTermOf(spec, sortKey);
  const rank = sortRankOf(spec, sortKey);
  // Only when there is more than one, because "1 of 1" is a number that says nothing and
  // this row is 36px tall.
  const showRank = rank !== null && spec.length > 1;
  // One arrow, turned over — not two components swapped. `ArrowDown` in place of `ArrowUp` is
  // a different element in the same slot, so React unmounts one and mounts the other and the
  // indicator *teleports*: the whole of what a second press means is that the order reversed,
  // and nothing on screen said so. Half a turn is the same fact, drawn.
  const turned = term?.dir === "desc";

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
        // the button fills the cell, so a tooltip on the cell is one nothing can reach. The
        // Price column has a sentence of its own to say (how old the prices are), and a
        // header that swapped it for the sort hint would lose the one fact spec §5 says a
        // price may never be shown without. Two lines — the panel's `whitespace-pre-line` is
        // what keeps the `\n` a break rather than a space.
        {...tip(title ? `${title}\n${SORT_HINT(label)}` : SORT_HINT(label))}
        className={cn(
          "flex w-full min-w-0 items-center gap-1",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          // Inset: the header fills a sticky band the scroller clips at both ends.
          FOCUS_INSET,
          // A sorted column is the one the list is answering to, so it stops being dim.
          term && "text-text",
          // The arrow follows the label, so a right-aligned column has to pack to its end
          // or the pair drifts away from the numbers underneath it.
          className?.includes("text-right") ? "justify-end" : "text-left",
        )}
      >
        <span className="truncate">{label}</span>
        {/* `initial={false}`, so a table that opens already sorted draws its arrow rather than
            animating one in on first paint. The rotation is on `animate` and is matched on
            `initial`: an arrow arriving into a descending column should appear already turned,
            not spin as it fades in.

            Both of these are `aria-hidden` and neither is a live region, so this is purely
            visual — `aria-sort` on the header and "sort priority N" in the button's name carry
            the same two facts in words, and neither moved. */}
        <AnimatePresence initial={false}>
          {term && (
            <motion.span
              key="arrow"
              aria-hidden="true"
              initial={{ opacity: 0, scale: 0.6, rotate: turned ? 180 : 0 }}
              animate={{ opacity: 1, scale: 1, rotate: turned ? 180 : 0 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={TRANSITION.fast}
              className="flex shrink-0"
            >
              <ArrowUp className="size-3" />
            </motion.span>
          )}
        </AnimatePresence>
        {/* `aria-hidden`: the same fact is in the button's name, where a screen reader will
            reach it in words rather than as a bare digit after the column title. It appears and
            disappears as `spec.length` crosses 1, which is a press away from any two-key sort,
            so it is given the same fade the arrow has rather than blinking in beside it. */}
        <AnimatePresence initial={false}>
          {showRank && (
            <motion.span
              key="rank"
              aria-hidden="true"
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={TRANSITION.fast}
              className="shrink-0 rounded-sm bg-bg px-1 text-[0.65rem] leading-tight text-dim"
            >
              {rank}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </span>
  );
}
