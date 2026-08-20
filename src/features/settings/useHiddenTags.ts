import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type MutedTag, type TagNamespace } from "@/lib/ipc";
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

/** What {@link HiddenTagsPanel} draws. */
export interface HiddenTags {
  /** `null` until the read lands. Distinct from `[]`, which is "nothing is hidden" — a real
   *  answer this panel has a sentence for. */
  tags: readonly MutedTag[] | null;
  /** Give one back. Keyed on `(namespace, tagId)`, which is what `muted_tags` is keyed on. */
  show: (tag: MutedTag) => void;
  /** The `tagId` currently being given back, or `null`. One at a time is all a list of buttons
   *  can start, and naming *which* is what lets the pressed row alone go quiet. */
  pending: string | null;
  /** A refused unmute, as a sentence. */
  error: string | null;
}

/**
 * The hidden-tag list and the one write that empties it.
 *
 * Hooked up in `SettingsPage` rather than in the panel, which is that page's rule for every
 * other panel and holds here for the plainest version of the reason: nothing else in the window
 * reads `tags_muted`, so there is no second caller to race, and the panel stays a function of
 * its props.
 *
 * **`tag_unmute` does not refuse a tag that was never muted**, so a stale row pressed twice is
 * not an error — the row is gone either way, and a Settings list that raced a second window is
 * not worth shouting about. The refusal this reports is a database that would not answer.
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
    pending: unmute.isPending ? unmute.variables.tagId : null,
    error: writeFailure([unmute]),
  };
}
