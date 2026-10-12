import { CardSearchPanel } from "@/features/search/CardSearchPanel";
import { useSearchOpen } from "@/features/search/useSearchOpen";
import { useSearchWidth } from "@/features/search/useSearchWidth";
import { TagPicker } from "./TagPicker";
import type { TagFilter } from "./useTagSelection";

export interface TagSearchPanelProps {
  /** The page's tag filter — the picker writes to it, and the page's wall reads it. */
  tags: TagFilter;
  /** `CardSearchPanel`'s three measurements, from the page's `useDeskWidth`. */
  roomy?: boolean;
  overWidth?: number;
  maxWidth?: number;
}

/**
 * **Tag search, as a collapsible sidebar on the card search page** (issue #937) — the Tagger
 * page's rail, docked on the right as the deck editor docks its card search.
 *
 * Chrome from `CardSearchPanel`, body from {@link TagPicker}, and the two answers the reader gives
 * it remembered across restarts: whether it is open (`useSearchOpen("tags")`, a fourth entry in
 * the `search_open` map) and how wide they dragged it (`useSearchWidth("tags")`). Unlike the three
 * card-search columns the width *is* stored: the rail's width is an answer about tag names, not
 * about the list beside it, so it is the same answer on every visit.
 *
 * **The body mounts on the reader's press and not before** — `CardSearchPanel` mounts its children
 * on `open` alone — so a reader who never opens tag search never asks for a taxonomy. The chips
 * are not in here: they are a filter on the wall, so the page draws them and they keep narrowing
 * it while this is a rail.
 */
export function TagSearchPanel({ tags, roomy, overWidth, maxWidth }: TagSearchPanelProps) {
  const { open, setOpen } = useSearchOpen("tags");
  const { width, setWidth } = useSearchWidth("tags");
  return (
    <CardSearchPanel
      surface="tags"
      title="Tags"
      sectionLabel="Search by tag"
      toggleLabel="tag search"
      open={open}
      setOpen={setOpen}
      roomy={roomy}
      overWidth={overWidth}
      maxWidth={maxWidth}
      width={width}
      onWidthChange={setWidth}
    >
      <TagPicker tags={tags} />
    </CardSearchPanel>
  );
}
