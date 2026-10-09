import { useRef, useState, type ReactNode } from "react";
import type { FilterSurface } from "@grimoire/ui/features/search/FilterBar";
import type { TrayCell } from "@grimoire/ui/features/search/filterOptions";
import { StatedFiltersLine } from "@grimoire/ui/features/search/StatedFiltersLine";
import { FiltersButton, FiltersSheet } from "./search/FiltersSheet";

/**
 * A cabinet's line — the collection's or the wishlist's: its own box, the one `Filters` button,
 * the filters that are on stated under them, and the sheet behind the button.
 *
 * **Search's arrangement over another list's hook** (`pages/SearchPage.tsx`, the spec's §3.2 —
 * "one sticky line: the search box and a single `Filters` button"). The hook is the desktop page's
 * own, so the box reads the same query language and every chip is the same state; the sheet draws
 * the cells the desktop's bar draws for that list (`tray`), with that list's sort rows.
 *
 * `below` is what the page stacks under the line inside the same band — the path row, standing in
 * a folder — so the line and the way out of the folder stay put while the wall scrolls.
 */
export function CabinetFilters<SortKey extends string>({
  surface,
  label,
  tray,
  sortRows,
  total,
  below,
}: {
  surface: FilterSurface<SortKey>;
  /** The box's name and placeholder — `Search your collection`, never the card search's. */
  label: string;
  tray: readonly TrayCell[];
  sortRows: readonly { value: SortKey | ""; label: string; disabled?: boolean }[];
  /** How many cards the list now holds, for the sheet's footer; `undefined` until known. */
  total: number | undefined;
  below?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 pt-2 pb-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          aria-label={label}
          placeholder={label}
          value={surface.text}
          onChange={(e) => surface.setText(e.target.value)}
          // 16px: below it, iOS and some Android browsers zoom the page on focus.
          className="h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-base text-text select-text"
        />
        <FiltersButton
          ref={opener}
          search={surface}
          expanded={open}
          onClick={() => setOpen(true)}
        />
      </div>
      {/* Draws nothing until a chip is on. */}
      <StatedFiltersLine search={surface} />
      {below}
      <FiltersSheet
        open={open}
        search={surface}
        tray={tray}
        sortRows={sortRows}
        total={total}
        onDismiss={() => {
          opener.current?.focus();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
