import type { SearchHandoff } from "@/lib/ipc";
import type { TagChip } from "@/features/tags/tagFilters";

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
