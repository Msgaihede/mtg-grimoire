import type { Ref } from "react";
import { Tags } from "lucide-react";
import { Dialog } from "@grimoire/ui/components/Dialog";
import { FILTER_CONTROL, FILTER_FOCUS, filterChipState } from "@grimoire/ui/components/FilterChips";
import { TagPicker } from "@grimoire/ui/features/tags/TagPicker";
import type { TagFilter } from "@grimoire/ui/features/tags/useTagSelection";
import { cn } from "@grimoire/ui/lib/utils";
import { BADGE } from "./FiltersSheet";

/**
 * The phone's door to tag search — `FiltersButton`'s shape, beside it on the search line.
 *
 * Gold while a tag is picked, for the Filters button's reason: the sheet is shut, so this and the
 * chips row under the box are the places a tag the reader cannot see is said to be there.
 */
export function TagsButton({
  ref,
  tags,
  expanded,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  tags: TagFilter;
  expanded: boolean;
  onClick: () => void;
}) {
  const picked = tags.selection.chips.length;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={picked > 0 ? `Tags — ${picked} picked` : "Tags"}
      className={cn(
        FILTER_CONTROL,
        FILTER_FOCUS,
        "inline-flex h-11 shrink-0 items-center gap-2 px-3",
        filterChipState(picked > 0),
      )}
    >
      <Tags className="size-4 shrink-0" aria-hidden="true" />
      {picked > 0 && (
        <span aria-hidden="true" className={BADGE}>
          {picked}
        </span>
      )}
    </button>
  );
}

/**
 * **Tag search on the phone face** (issue #937) — the desktop search page's sidebar, as a sheet.
 *
 * A sidebar beside the wall has no width to stand in below 1024px, so the phone draws the same
 * body — `TagPicker`: the tag box, what has not downloaded, the rail — in a `Dialog`, which on
 * this face is a Back step and drags down to close. `Dialog` mounts nothing while shut, so the
 * taxonomies are read only once the reader opens it, the desktop sidebar's rule. The picked tags
 * are the page's (`useTagSelection`, shared with the desktop face), so closing the sheet keeps
 * them narrowing the wall.
 */
export function TagsSheet({
  open,
  tags,
  onDismiss,
  onClose,
}: {
  open: boolean;
  tags: TagFilter;
  onDismiss: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="Tags"
      closeLabel="Close tags"
      size="h-full w-[38rem] pt-[env(safe-area-inset-top)] sm:h-auto sm:pt-0"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      {/* The picker's column: `TagTree` takes the rest of the height and scrolls inside it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
        <TagPicker tags={tags} />
      </div>
    </Dialog>
  );
}
