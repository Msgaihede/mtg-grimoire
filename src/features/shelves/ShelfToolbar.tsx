import type { ReactElement } from "react";
import { ChevronsDownUp, ChevronsUpDown, FolderPlus } from "lucide-react";
import { SHELF_TEXT_BUTTON } from "./shelfButtons";

/**
 * The path row's right-hand end — spec §3.5: **Add folder** (at the level the reader stands on),
 * **Expand all** and **Collapse all** (every shelf below the level, app-owned ones included).
 *
 * Words beside the glyphs, unlike a heading's icon buttons: there is one of these per page rather
 * than one per shelf, so it can afford to say what it does. `flex-wrap` because a row of fixed-width
 * controls is sized by the narrowest surface that draws it (src/CLAUDE.md).
 */
export function ShelfToolbar({
  onAddFolder,
  onExpandAll,
  onCollapseAll,
}: {
  onAddFolder?: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}): ReactElement {
  return (
    <div role="group" aria-label="Shelves" className="flex flex-wrap items-center justify-end gap-1">
      {onAddFolder && (
        <button type="button" onClick={onAddFolder} className={SHELF_TEXT_BUTTON}>
          <FolderPlus className="size-3.5" aria-hidden="true" />
          Add folder
        </button>
      )}
      <button type="button" onClick={onExpandAll} className={SHELF_TEXT_BUTTON}>
        <ChevronsUpDown className="size-3.5" aria-hidden="true" />
        Expand all
      </button>
      <button type="button" onClick={onCollapseAll} className={SHELF_TEXT_BUTTON}>
        <ChevronsDownUp className="size-3.5" aria-hidden="true" />
        Collapse all
      </button>
    </div>
  );
}
