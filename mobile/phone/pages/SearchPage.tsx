import { useMemo, useRef, useState } from "react";
import { activeChips } from "@/features/search/filterOptions";
import { countOf } from "@/features/search/resultCount";
import { StatedFiltersLine } from "@/features/search/StatedFiltersLine";
import { TagQueryRow } from "@/features/search/TagQueryRow";
import { useCardSearch } from "@/features/search/useCardSearch";
import { CardWall, type WallItem } from "../CardWall";
import { searchItem } from "../items";
import { FiltersButton, FiltersSheet } from "../search/FiltersSheet";
import { DimNote, NextPageRefused, ReadError, useMore } from "./parts";

/**
 * Card search: one line, what it is narrowed by, and the wall.
 *
 * **The search is the desktop's** — `useCardSearch`, the hook behind `SearchPage` and the docked
 * columns — so the box reads the same query language (`otag:`, `cmc>=3`, `-t:goblin`), the same
 * request reaches the same command, and every filter is the same state. What is the phone's own
 * is the arrangement, which is the spec's §3.2 word for word: **"One sticky line: the search box
 * and a single `Filters` button. Everything else is in a sheet."** The vertical is what a phone
 * is short of, and a line with a sheet behind it is what gave the wall the most of it when the
 * options were measured on a phone in August.
 *
 * **Under the line, only once something is on**: the stated filters — the desktop's own
 * `StatedFiltersLine`, one scrolling row of chips each clearing its kind — beside the count, and
 * under them the query's own terms (`TagQueryRow`), which is where a typed tag that resolved to
 * nothing says so. An unfiltered search draws neither, so the wall starts under the box.
 *
 * "Sticky" by construction rather than by `position: sticky`: the wall scrolls inside itself, and
 * nothing above it is in the scroller.
 */
export function SearchPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const search = useCardSearch();
  const { query, marketplace } = search;
  const items = useMemo(
    () => search.rows.map((row) => searchItem(row, marketplace.currency)),
    [search.rows, marketplace.currency],
  );
  const more = useMore(query, query.hasNextPage);
  const [sheetOpen, setSheetOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const filtered = search.activeCount;
  // Not `filtered`: the box's text is in that count and is no chip — it is on screen in the box.
  const chips = activeChips(search, marketplace.currency).length;
  // The count is worth a line once the reader has narrowed anything — a chip or a word. Over the
  // unfiltered wall it is the size of the database, which nobody asked.
  const stating = chips > 0 || search.text.trim() !== "";
  // Nothing until the first page has answered — `0` then would be a claim about no search at all —
  // and nothing over an empty answer, where the wall's own sentence says it in words.
  const count =
    query.data === undefined || search.total === 0 ? null : (
      <span className="shrink-0 font-mono text-xs text-dim tabular-nums">
        {countOf(search.total, search.totalIsCapped)}
      </span>
    );

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            type="search"
            aria-label="Search cards"
            placeholder="Search cards"
            value={search.text}
            onChange={(e) => search.setText(e.target.value)}
            // 16px: below it, iOS and some Android browsers zoom the page on focus.
            className="h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-base text-text select-text"
          />
          <FiltersButton
            ref={opener}
            active={filtered}
            expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          />
        </div>

        {stating &&
          (chips > 0 ? (
            // The count leads the chips in place of `Filtering by`: it is what they add up to,
            // and the caption would cost a quarter of a phone's line.
            <StatedFiltersLine search={search} caption={count} />
          ) : (
            count
          ))}

        {/* The desktop bar's own placement: under the stated filters, because these are the
            box's own terms and a reader looking for why a name did not resolve looks under the
            box they typed it into. Draws nothing until there is something to say. */}
        <TagQueryRow search={search} />
      </div>

      {query.isLoadingError ? (
        <ReadError>The search could not be read.</ReadError>
      ) : !query.isPending && items.length === 0 ? (
        <DimNote>No cards match.</DimNote>
      ) : (
        <CardWall
          label="Search results"
          items={items}
          onOpen={onOpen}
          onNearEnd={more}
          resetKey={search.searchKey}
          footer={<NextPageRefused query={query} />}
        />
      )}

      <FiltersSheet
        open={sheetOpen}
        search={search}
        // Nothing until the first page has answered — a count then would be about no search.
        total={query.data === undefined ? undefined : search.total}
        capped={search.totalIsCapped}
        onDismiss={() => {
          opener.current?.focus();
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}
