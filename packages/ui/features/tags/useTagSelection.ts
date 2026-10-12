import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArtWeightFloor, TagHit, TagNamespace } from "@/lib/ipc";
import { viewMemory } from "@/lib/viewMemory";
import {
  chipKey,
  EMPTY_SELECTION,
  removeChip,
  termsFor,
  toggleChip,
  toggleChipMode,
  type TagSelection,
} from "./tagFilters";

/**
 * Keep the weight floor honest after a chip changes — **every** write to the selection goes
 * through this.
 *
 * The floor narrows the art side's *include* half and nothing else, so the moment the last art
 * include leaves — removed, flipped to an exclude, or a rail row toggled back off — there is
 * nothing for it to act on. `TagChips` greys it there, and a chip that is pressed *and* greyed at
 * once is a filter that is on and unreachable. `termsFor` already drops such a floor from the
 * request, so leaving it set would also be a control claiming to narrow a wall it is not
 * narrowing. Applied to every write rather than to one call site, because more than one path
 * reaches the empty state and each new one would otherwise be somebody's to remember.
 */
export function settleFloor(next: TagSelection): TagSelection {
  if (next.floor === "any") return next;
  if (next.chips.some((c) => c.namespace === "art" && c.mode === "include")) return next;
  return { ...next, floor: "any" };
}

/**
 * Where the card search leaves its picked tags and the tag box when the reader switches views,
 * and finds them again on the way back (issue #908). Window-lifetime memory — see
 * `@/lib/viewMemory`. **One name for both faces of the light app**, `useCardSearch`'s
 * `rememberAs: "search"` reason: the desktop face's sidebar and the phone's sheet are two
 * drawings of one search, so a reader who crosses 1024px keeps their tags.
 */
const TAG_MEMORY = viewMemory<{ selection: TagSelection; text: string }>("searchTags");

/**
 * The card search's tag filter — what the reader has picked, and what is in the tag box.
 *
 * **Owned by the search page rather than by the tag picker**, and that is what lets the picker be
 * a collapsible sidebar (issue #937): the chips are a filter on the wall and keep narrowing it
 * while the sidebar is shut, so they cannot live in a body that mounts only while it is open. The
 * box's characters live here for the same reason — a reader who shuts the sidebar and opens it
 * again finds the rail they were picking from.
 *
 * Nothing here reads a tag: the queries are the picker's, and the picker mounts only when the
 * reader opens it. {@link TagFilter.tagTerms} is what the page hands `useCardSearch`.
 */
export function useTagSelection() {
  const [remembered] = useState(() => TAG_MEMORY.recall());
  const [selection, setSelection] = useState<TagSelection>(
    remembered?.selection ?? EMPTY_SELECTION,
  );
  const [text, setText] = useState(remembered?.text ?? "");
  useEffect(() => TAG_MEMORY.keep({ selection, text }), [selection, text]);

  const update = useCallback((step: (s: TagSelection) => TagSelection) => {
    setSelection((prev) => settleFloor(step(prev)));
  }, []);

  /** Which rows the rail should mark as already picked — chip keys, so the two taxonomies'
   *  shared slugs stay two tags. */
  const picked = useMemo(
    () => new Set(selection.chips.map((c) => chipKey(c.namespace, c.slug))),
    [selection.chips],
  );

  /** The chips as request fields. `termsFor` is the one place the payload is derived;
   *  `useCardSearch` keys on the string this serialises to. */
  const tagTerms = useMemo(() => termsFor(selection), [selection]);

  /** A press on a rail row: on if the tag is off, off if it is on (issue #181). */
  const toggleTag = useCallback((hit: TagHit) => update((s) => toggleChip(s, hit)), [update]);
  const removeTag = useCallback(
    (slug: string, namespace: TagNamespace) => update((s) => removeChip(s, slug, namespace)),
    [update],
  );
  const toggleTagMode = useCallback(
    (slug: string, namespace: TagNamespace) => update((s) => toggleChipMode(s, slug, namespace)),
    [update],
  );
  const setFloor = useCallback(
    (floor: ArtWeightFloor) => update((s) => ({ ...s, floor })),
    [update],
  );
  const setNamespace = useCallback(
    (namespace: TagNamespace | "both") => update((s) => ({ ...s, namespace })),
    [update],
  );
  /** Every chip off, the floor and the taxonomy chooser kept — the chips row's own reset. */
  const clearTags = useCallback(() => update((s) => ({ ...s, chips: [] })), [update]);

  return {
    selection,
    text,
    setText,
    picked,
    tagTerms,
    toggleTag,
    removeTag,
    toggleTagMode,
    setFloor,
    setNamespace,
    clearTags,
  };
}

export type TagFilter = ReturnType<typeof useTagSelection>;
