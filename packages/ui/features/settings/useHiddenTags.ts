import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError, type MutedTag, type TagNamespace } from "@/lib/ipc";
import { writeFailure } from "@/lib/writes";

/** Everything the reader has hidden — `tags::muted::list`, already ordered by taxonomy then by
 *  the stored slug, because this list exists to be searched by eye. */
export const HIDDEN_TAGS_KEY = ["tags-muted"];

/**
 * The two lists a hidden tag is missing from while it is hidden, and which must be re-read the
 * moment it is given back.
 *
 * The rail draws `tag_children` and the type-ahead draws `tag_search`, and **a muted tag is
 * absent from both, from a parent's `childCount` and from anyone's `parents`** — so a Settings
 * press that only refreshed this panel would give the tag back to a page still holding a rail
 * that does not have it. `TagsPage`'s own hide names exactly these two roots for the same reason
 * in the other direction.
 */
const RAIL_ROOTS = [["tag-children"], ["tag-search"]];

/**
 * A muted tag's identity, in one string — `muted_tags`' own primary key.
 *
 * `tagFilters`' `chipKey` is the same idea for a `TagHit` and is deliberately not reused: that one
 * keys on `(namespace, slug)`, which is right for a chip (a slug is what a filter sends) and wrong
 * here (a mute survives a rename precisely because it is keyed on the uuid).
 */
export const mutedKey = (tag: Pick<MutedTag, "namespace" | "tagId">): string =>
  `${tag.namespace}:${tag.tagId}`;

/** What {@link HiddenTagsPanel} draws. */
export interface HiddenTags {
  /** `null` until the read lands. Distinct from `[]`, which is "nothing is hidden" — a real
   *  answer this panel has a sentence for — and distinct from {@link error} with a `null` list,
   *  which is "the read failed". Three states, because a panel that collapsed the first and the
   *  third would print its explanatory sentence over an empty space for good. */
  tags: readonly MutedTag[] | null;
  /** Give one back. Keyed on `(namespace, tagId)`, which is what `muted_tags` is keyed on. */
  show: (tag: MutedTag) => void;
  /** The tag currently being given back as a {@link mutedKey}, or `null`. One at a time is all a
   *  list of buttons can start, and naming *which* is what lets the pressed row alone go quiet.
   *
   *  **A `(namespace, tagId)` key and not a bare `tagId`**, which is the rule everywhere else a
   *  tag is identified in this app: the two taxonomies are separate id spaces, so a uuid they
   *  happened to share would put `aria-busy` on both rows. Cosmetic today — the whole list is
   *  disabled while a write is in flight, so neither row is pressable either way — and spelled
   *  correctly anyway, because this is the one place on the page that would otherwise key a tag
   *  on half its identity. */
  pending: string | null;
  /** A refused unmute **or** a failed read, as a sentence.
   *
   *  One field for both because the panel draws one line, and because they cannot both be the
   *  newest news: a read that failed leaves no rows to press, and a press only happens once the
   *  read has landed. The write wins a tie, which is the app's rule everywhere else
   *  (`@/lib/writes`) — the reader just did something and that is what they are waiting on. */
  error: string | null;
}

/**
 * The hidden-tag list and the one write that empties it.
 *
 * Hooked up in `SettingsPage` rather than in the panel, which is that page's rule for every
 * other panel and holds here for the plainest version of the reason: nothing else in the window
 * *reads* `tags_muted`, so there is no second reader to race, and the panel stays a function of
 * its props.
 *
 * **There is a second writer, though, and it is on another page.** `TagsPage`'s `hideTag` adds
 * rows to this table, so it invalidates {@link HIDDEN_TAGS_KEY} after its write for the mirror
 * of the reason this hook invalidates the rail's two keys after its own. Without that pair, each
 * side leaves the other holding a cached list for the app's 30 s `staleTime` — and the direction
 * that bites is the hide, because the rail's answer to one is a sentence pointing at this panel.
 *
 * **`tag_unmute` does not refuse a tag that was never muted**, so a stale row pressed twice is
 * not an error — the row is gone either way, and a Settings list that raced a second window is
 * not worth shouting about. The refusals this reports are a database that would not answer,
 * either to the write or to the read.
 */
export function useHiddenTags(): HiddenTags {
  const client = useQueryClient();

  const list = useQuery({ queryKey: HIDDEN_TAGS_KEY, queryFn: () => ipc.tagsMuted() });

  const unmute = useMutation({
    mutationFn: ({ namespace, tagId }: { namespace: TagNamespace; tagId: string }) =>
      ipc.tagUnmute(namespace, tagId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: HIDDEN_TAGS_KEY });
      for (const queryKey of RAIL_ROOTS) void client.invalidateQueries({ queryKey });
    },
  });

  return {
    tags: list.data ?? null,
    show: (tag) => unmute.mutate({ namespace: tag.namespace, tagId: tag.tagId }),
    pending: unmute.isPending ? mutedKey(unmute.variables) : null,
    // The write's refusal first, then the read's. A read that failed answered no rows, so there
    // is nothing to press and no write to be newer than it; once one *has* been pressed the read
    // must have landed. So this is a precedence rather than a race, and it is the same
    // most-recent-news rule `writeFailure` applies within a set of writes.
    error: writeFailure([unmute]) ?? (list.isError ? ipcError(list.error) : null),
  };
}
