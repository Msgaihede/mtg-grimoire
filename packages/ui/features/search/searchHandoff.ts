import { useEffect, useRef } from "react";
import { ipc, ipcError, type SearchHandoff, type SearchShownReport } from "@/lib/ipc";
import type { TagChip } from "@/features/tags/tagFilters";
import type { CardSearch } from "./useCardSearch";

/**
 * **An agent's search, on the Search page** — the MCP tool `show_search`, arriving through
 * `store.ts`'s `pendingSearchHandoff` (`SearchPage` applies it).
 *
 * The tags the agent named, as the sidebar's chips: every one an **include**, because the tool's
 * tag filter asks for the cards that carry them (`mcp/show.rs`' `handoff` hands over its resolved
 * `oracle_tags`), and each in the taxonomy Rust resolved it in — the namespace is half a chip's
 * identity (`chipKey`). The page puts these in place of whatever chips were standing, so the wall
 * is the agent's question and not that question narrowed by the reader's last one.
 */
export function chipsOf(handoff: SearchHandoff): TagChip[] {
  return handoff.tags.map(({ slug, label, namespace }) => ({
    slug,
    label,
    namespace,
    mode: "include",
  }));
}

/**
 * What the wall shows at one render, read for the tool waiting on an agent's search — the
 * {@link SearchShownReport}'s six fields and the two that say whether they are an answer yet.
 */
export interface HandoffWall {
  total: number;
  totalIsCapped: boolean;
  /** The box's keyword terms as their chips are labelled, then the typed tags'. */
  keywords: string[];
  /** The box's plain words — what free text the search ran. */
  words: string;
  /** The typed tag names that name no tag. */
  unknownTags: string[];
  /** Why the search or its tag lookup failed, in the backend's sentence; `null` when neither did. */
  failure: string | null;
  /** The typed tag names are still being looked up: the wall is empty and not a result. */
  resolving: boolean;
  /** The rows are this search's answer — `query.isSuccess && !query.isPlaceholderData`. Until
   *  then `keepPreviousData` draws the previous search's rows, which answer a different question. */
  settled: boolean;
}

/**
 * The report for the waiting tool, or `null` while the wall has not answered yet.
 *
 * A typed tag that names nothing and a failure are answers at once, rows or not: the search is
 * held (`useCardSearch`'s `tagQueryBlocked`) or failed, and no row is coming to wait for.
 */
export function handoffReport(wall: HandoffWall): SearchShownReport | null {
  if (wall.resolving) return null;
  const final = wall.unknownTags.length > 0 || wall.failure !== null;
  if (!final && !wall.settled) return null;
  return {
    total: wall.total,
    totalIsCapped: wall.totalIsCapped,
    keywords: wall.keywords,
    words: wall.words,
    unknownTags: wall.unknownTags,
    failure: wall.failure,
  };
}

/**
 * Tell the MCP server what the wall shows for the agent's search `id` (`SearchPage`'s
 * `appliedHandoffId`; `null` before any) — once per id, and only once the wall has answered that
 * search ({@link handoffReport}).
 *
 * The id applied names the search on screen: `SearchPage` changes it in the same render as the
 * filters, so the first wall read under a new id is already that search's. A hand-off that changes
 * no filter refetches nothing and is reported at once, because the rows on screen are its answer.
 * The last id sent is a ref rather than state, so the effect sets nothing. A refused send is
 * dropped: the tool's own timeout already tells the agent the page did not answer.
 */
export function useHandoffReport(search: CardSearch, id: number | null): void {
  const { query } = search;
  const report = handoffReport({
    total: search.total,
    totalIsCapped: search.totalIsCapped,
    keywords: [
      ...search.predicateChips.map((c) => c.label),
      ...search.tagChips.map((c) => c.label),
    ],
    words: search.plainWords,
    unknownTags: search.tagNotFound.map((t) => t.value),
    failure: search.tagLookupFailure ?? (query.error ? ipcError(query.error) : null),
    resolving: search.tagsResolving,
    settled: query.isSuccess && !query.isPlaceholderData,
  });
  const sent = useRef<number | null>(null);
  useEffect(() => {
    if (id === null || report === null || sent.current === id) return;
    sent.current = id;
    ipc.mcpSearchShown(id, report).catch(() => {});
  }, [id, report]);
}
