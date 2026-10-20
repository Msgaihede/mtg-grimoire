import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notify } from "@/lib/notifications";
import { HIDDEN_TAGS_KEY } from "@/features/settings/useHiddenTags";
import { ipc, ipcError, type ArtTagStatus, type TagHit, type TagNamespace } from "@/lib/ipc";
import { ORACLE_TAGS_STATUS_KEY } from "@/lib/useOracleTagProgress";
import { TAG_NAMESPACE_LABEL } from "./namespaces";
import { TagSearchBox } from "./TagSearchBox";
import { TagTree } from "./TagTree";
import type { TagFilter } from "./useTagSelection";
import { useTagSearch } from "./useTagSearch";

/**
 * Everything the art taxonomy is cached under — `ORACLE_TAGS_KEY`'s twin, spelled here because
 * no hook in `lib/` owns the art side yet.
 *
 * A **prefix**: an ingest that lands has replaced the taxonomy under every rail level and every
 * type-ahead answer already drawn, and no key moved. {@link useArtTagStatus} invalidates this
 * subtree when a refresh finishes, so the status read below regroups for free.
 */
const ART_TAGS_KEY = ["artTags"];

/** The art taxonomy's freshness — one small table, no network, safe before the first ingest. */
const ART_TAGS_STATUS_KEY = [...ART_TAGS_KEY, "status"];

/** How often to re-read a status that says a refresh is running — `useOracleTagProgress`'s
 *  number, for its reason: a local read of one row, and only while the flag is up. */
const TAG_REFRESH_POLL_MS = 1500;

/**
 * The art taxonomy's state, and **the thing that makes a cold first run heal itself**.
 *
 * `useOracleTagProgress` mirrored one dataset over: the two taxonomies are two files on two
 * schedules and emit on two channels. **Both halves are load-bearing** — the event carries "it
 * has finished", and the poll covers the ordinary case in which nobody heard it, because the host
 * starts `tags::art::refresh_if_due` at launch and an event emitted before a listener registered
 * is dropped. The poll is a function of the answer, so the first `refreshing: false` turns it off.
 *
 * **Call this once.** {@link TaxonomyGaps} is the one caller, and it mounts only while the
 * picker is open — which is the point of issue #937: a reader who never opens the tag sidebar
 * asks nothing about tags.
 *
 * The invalidation reaches past the status to the two lists a reader is looking at — the rail's
 * levels under `["tag-children", …]` and the type-ahead's answers under `["tag-search", …]` —
 * because healing the sentence while leaving the rail empty for 30 s would be half a fix.
 */
function useArtTagStatus(): ArtTagStatus | null {
  const queryClient = useQueryClient();
  const status =
    useQuery({
      queryKey: ART_TAGS_STATUS_KEY,
      queryFn: () => ipc.artTagsStatus(),
      refetchInterval: (query) =>
        query.state.data?.refreshing === true ? TAG_REFRESH_POLL_MS : false,
    }).data ?? null;

  useEffect(
    () =>
      ipc.onArtTagProgress((event) => {
        // Both terminal phases: a failed refresh still leaves `refreshing` true on the status
        // this window last read, and only a refetch takes it down.
        if (event.phase !== "done" && event.phase !== "error") return;
        void queryClient.invalidateQueries({ queryKey: ART_TAGS_KEY });
        void queryClient.invalidateQueries({ queryKey: ["tag-children"] });
        void queryClient.invalidateQueries({ queryKey: ["tag-search"] });
        // The typed `atag:` chips (issue #1183). Only the resolve branch: `["tags", "oracle", …]`
        // is the other taxonomy, which this refresh did not touch.
        void queryClient.invalidateQueries({ queryKey: ["tags", "resolve"] });
      }),
    [queryClient],
  );

  return status;
}

/**
 * Browse the corpus by what a card **is of** rather than by what it is called — the tag search
 * box, what has not downloaded yet, and the rail of tags.
 *
 * **The body of a surface, not a surface**: the search page draws it in its collapsible sidebar
 * and the light app's phone face in a sheet. Both mount it only while it is open, and that is
 * the whole of "load tag data only when the tag search is opened" (issue #937): every tag query
 * the app makes for this search is made from in here. The selection it writes to is the page's
 * ({@link TagFilter}), so the chips keep narrowing the wall after this unmounts.
 *
 * Its root is a `display: contents` fragment's worth of siblings, so the caller's column decides
 * the gaps and `TagTree` scrolls inside whatever height that column is given (`min-h-0 flex-1`).
 */
export function TagPicker({ tags }: { tags: TagFilter }) {
  const { selection, text, setText, picked, toggleTag, setNamespace } = tags;
  const queryClient = useQueryClient();

  const { hits, isPending } = useTagSearch(text, selection.namespace);
  // `null` and `[]` are different states to the rail and both are real: `[]` is "that motif
  // matches no tag", and `null` is "nothing has been asked", which is when the tree is drawn.
  const railHits = text.trim().length > 0 ? hits : null;

  /**
   * Hide a tag everywhere, and put the three lists that draw it out of date.
   *
   * **It catches and then rethrows, and both halves are load-bearing.** The catch says the refusal
   * (the rail has no idea why a write it did not make was refused); the rethrow keeps the rail
   * honest, since it awaits this before writing "hidden tags come back from Settings". `TagTree`'s
   * own wrapper catches, so nothing escapes unhandled.
   *
   * **Both answers are toasts** (`@/lib/notifications`): the press is a context-menu row, so the
   * menu has closed by the time the backend answers, and the hide changes user data — the tag
   * leaves every list until Settings brings it back. The refusal used to be a `CardMenuRefusal`
   * line over the rail, a hand-rolled toast that stood until the next hide.
   *
   * `HIDDEN_TAGS_KEY` is the invalidation that is easy to forget, because Settings' list is not
   * on this surface — and the rail's answer to a hide is to point the reader at it.
   */
  const hideTag = useCallback(
    async (hit: TagHit) => {
      try {
        await ipc.tagMute(hit.namespace, hit.id, hit.slug);
      } catch (e) {
        notify.error(`Couldn't hide “${hit.label}”`, { body: ipcError(e) });
        throw e;
      }
      notify.success(`Hid “${hit.label}”`, { body: "Unhide tags in Settings" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tag-children"] }),
        queryClient.invalidateQueries({ queryKey: ["tag-search"] }),
        queryClient.invalidateQueries({ queryKey: HIDDEN_TAGS_KEY }),
      ]);
    },
    [queryClient],
  );

  return (
    <>
      <TagSearchBox
        value={text}
        onChange={setText}
        namespace={selection.namespace}
        onNamespaceChange={setNamespace}
      />

      <TaxonomyGaps />

      <TagTree
        namespace={selection.namespace}
        hits={railHits}
        pending={isPending}
        onToggle={toggleTag}
        onMute={hideTag}
        picked={picked}
      />
    </>
  );
}

/**
 * What this machine has never downloaded, said plainly — **not a failure, and must not read as
 * one**. A taxonomy with no rows is every install's first launch, and what a machine that cannot
 * reach Scryfall stays in; the picker still works for whichever file *did* arrive, which is why
 * each is named on its own line.
 *
 * `ingestedAt` is the test and `stale` is not: the latter is true of a taxonomy merely due a
 * refresh, which is a rail with every tag in it. Both halves take themselves down when the file
 * arrives — the oracle status is `AppShell`'s (the phone face's `cardData` mounts the same hook),
 * the art status is {@link useArtTagStatus}'s.
 */
function TaxonomyGaps() {
  const art = useArtTagStatus();
  const oracle = useQuery({
    queryKey: ORACLE_TAGS_STATUS_KEY,
    queryFn: () => ipc.oracleTagsStatus(),
  }).data;

  const missing: TagNamespace[] = [];
  // Unanswered says nothing rather than claiming a taxonomy is absent, which would flash this
  // notice onto a picker that has every tag.
  if (art && art.ingestedAt === null) missing.push("art");
  if (oracle && oracle.ingestedAt === null) missing.push("oracle");
  if (missing.length === 0) return null;

  return (
    <div
      role="status"
      className="shrink-0 rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-dim"
    >
      {/* One string per line, so `getByText` can find the sentence a reader reads. */}
      {missing.map((namespace) => (
        <p key={namespace}>{`${TAG_NAMESPACE_LABEL[namespace]} tags are still downloading.`}</p>
      ))}
    </div>
  );
}
