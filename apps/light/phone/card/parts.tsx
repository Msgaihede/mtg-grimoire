import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { PRESS_SOFT } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The pieces every section of the card sheet is built from — the heading over a block, the press
 * that unfolds the rest of a long one, and the sentence a block says when it is not a list.
 *
 * **One column, sections stacked under hairlines**, which is the desktop modal's middle column
 * read as a phone page: there, `Printings` sits under a rule that separates "this card" from
 * "every card like it", and the sheet keeps that rule between every block so the scroll reads as
 * stacked sections rather than as boxes.
 */

/**
 * One block of the sheet: a heading, an optional figure beside it, and what it heads.
 *
 * **`h3`, under the sheet's own `h2`** — `Dialog` draws the card's name as the panel's heading, so
 * a reader moving heading to heading hears the card and then each thing about it.
 *
 * The figure is **one text node**, its number and its noun together, for the accessible-name
 * rule `packages/ui/CLAUDE.md` carries: a `gap` between two elements is not a word separator, and a count
 * split from its unit reads as `12combos`.
 */
export function SheetSection({
  title,
  figure,
  children,
}: {
  title: string;
  figure?: string | null;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    // `relative` for the sheet's scroller's sake: rarity gems and language badges carry an
    // `sr-only` span, which is `position: absolute`, and a section is the nearest box that can
    // bound one before it reaches the scroller and grows a bar for a caption nobody can see.
    <section
      aria-labelledby={headingId}
      className="relative flex flex-col gap-2.5 border-t border-border pt-4"
    >
      <div className="flex items-baseline gap-2">
        <h3 id={headingId} className="min-w-0 flex-1 text-xs uppercase tracking-wide text-dim">
          {title}
        </h3>
        {figure != null && (
          <span className="shrink-0 font-mono text-[0.7rem] tabular-nums text-dim">{figure}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * The press that shows the rest of a long block, or folds it again.
 *
 * **A button, not a link**: it changes what this sheet draws and nothing about where the reader
 * is, so it is no place to copy or open in a tab. `aria-expanded` says which way it is facing and
 * `aria-controls` names the list it unfolds, so the press is about something a screen reader can
 * find.
 *
 * **44px tall and the column's full width** — the touch floor, met by the box rather than by
 * padding around a line of type, because a finger aims at the whole row. `PRESS_SOFT` rather than
 * `PRESS` for the rail entries' reason: a full-width row dipping 3% reads as the sheet moving.
 */
export function ShowMore({
  expanded,
  controls,
  onToggle,
  more,
  fewer = "Show fewer",
}: {
  expanded: boolean;
  /** The id of the list this unfolds. */
  controls: string;
  onToggle: () => void;
  /** What the press says while folded — `Show all 12 printings`. */
  more: string;
  fewer?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "flex h-11 w-full items-center justify-center gap-1.5 rounded-md border border-border",
        "text-sm text-dim hover:text-text",
        PRESS_SOFT,
        FOCUS,
      )}
    >
      {expanded ? fewer : more}
      <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0", expanded && "rotate-180")} />
    </button>
  );
}

/**
 * One dim sentence — every state of a block that is not its list.
 *
 * **One text node, and that is load-bearing rather than tidy.** Testing Library reads an
 * element's *own* text children, so a sentence broken by a `<span>` becomes unfindable by anything
 * that queries it as a sentence — which is how a reader reads it. The desktop's three overlays say
 * so at their own sites; this is the sheet's.
 */
export function Note({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "alert" }) {
  return tone === "alert" ? (
    <p role="alert" className="text-sm leading-relaxed text-destructive">
      {children}
    </p>
  ) : (
    <p className="text-sm leading-relaxed text-dim">{children}</p>
  );
}

/**
 * Where a block's data came from, under it — the app's rule that data with an age says its age.
 *
 * Under the block rather than in a footer: each feed on this sheet runs its own clock (the card
 * data, a price feed, Tagger's files, Spellbook's), so one caption for the sheet would have to
 * name four and would be read as naming one.
 */
export function Source({ children }: { children: ReactNode }) {
  return <p className="text-[0.7rem] leading-relaxed text-dim">{children}</p>;
}
