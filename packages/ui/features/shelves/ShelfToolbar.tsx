import type { ReactElement } from "react";
import { ChevronsDownUp, ChevronsUpDown, FolderPlus } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";
import { SHELF_TEXT_BUTTON } from "./shelfButtons";

/**
 * Why folding is refused while a filter is on — the one sentence both pages pass as `foldPaused`
 * to this toolbar and to every `ShelfHeading`, so the three refused controls cannot word it two
 * ways. Spec §3.4: a filtered wall shows every shelf with a match open, so a fold pressed then would
 * be written for a wall the reader is not looking at.
 */
export const FOLD_PAUSED_REASON = "Collapsing is paused while filtering";

/**
 * What a paused fold control looks like: dimmed, a not-allowed cursor, no hover wash and no press
 * dip — the controls stay where they are and in the tab order, and look like what they are, out of
 * reach for now. Shared with `ShelfHeading`'s chevron so the three read as one state. Written to go
 * **after** the button's own recipe, so `cn`'s merge replaces the hover and the dip rather than
 * stacking beside them.
 */
export const FOLD_PAUSED_LOOK =
  "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-dim active:scale-100";

/**
 * The path row's right-hand end — spec §3.5: **Add folder** (at the level the reader stands on),
 * **Expand all** and **Collapse all** (every shelf below the level, app-owned ones included).
 *
 * Words beside the glyphs, unlike a heading's icon buttons: there is one of these per page rather
 * than one per shelf, so it can afford to say what it does. `flex-wrap` because a row of fixed-width
 * controls is sized by the narrowest surface that draws it (packages/ui/CLAUDE.md).
 *
 * **`foldPaused` refuses Expand all and Collapse all in the open while a filter is on** (spec
 * §3.4): `aria-disabled` — never `disabled`, which would take them out of the tab order and put
 * the reason on a hover a keyboard reader cannot perform — the reason as their description, and a
 * press that calls nothing. Add folder is not about folding and is untouched. Absent (or empty) is
 * the toolbar exactly as it always was.
 */
export function ShelfToolbar({
  onAddFolder,
  onExpandAll,
  onCollapseAll,
  foldPaused,
}: {
  onAddFolder?: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Why folding is refused right now — {@link FOLD_PAUSED_REASON} while a filter is on. */
  foldPaused?: string;
}): ReactElement {
  const tip = useTooltip();
  const paused = Boolean(foldPaused);
  /** The refusal as a pair of spreads: the mark and the description, the tooltip as its visual
   *  half. `aria-description` rather than the tooltip's own `aria-describedby`, because that one
   *  is wired only while the panel is open — the reason has to be there at rest. */
  const refused = paused
    ? {
        "aria-disabled": true as const,
        "aria-description": foldPaused,
        ...tip(foldPaused, { describes: false }),
      }
    : {};
  return (
    <div role="group" aria-label="Shelves" className="flex flex-wrap items-center justify-end gap-1">
      {onAddFolder && (
        <button type="button" onClick={onAddFolder} className={SHELF_TEXT_BUTTON}>
          <FolderPlus className="size-3.5" aria-hidden="true" />
          Add folder
        </button>
      )}
      <button
        type="button"
        onClick={paused ? undefined : onExpandAll}
        className={cn(SHELF_TEXT_BUTTON, paused && FOLD_PAUSED_LOOK)}
        {...refused}
      >
        <ChevronsUpDown className="size-3.5" aria-hidden="true" />
        Expand all
      </button>
      <button
        type="button"
        onClick={paused ? undefined : onCollapseAll}
        className={cn(SHELF_TEXT_BUTTON, paused && FOLD_PAUSED_LOOK)}
        {...refused}
      >
        <ChevronsDownUp className="size-3.5" aria-hidden="true" />
        Collapse all
      </button>
    </div>
  );
}
