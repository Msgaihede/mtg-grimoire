/**
 * The tag field for one **stack** — one `collection_entries` row or one `wishlist_entries` row
 * (issue #1398) — and the connected editor every surface that tags a stack draws.
 *
 * **An entry tag is not a deck tag**, and the field says so by its words rather than by its
 * shape. It is `DeckTagsField`'s field exactly — the chips, the keyboard, the reorder, the
 * suggestions that open on focus — handed this file's {@link ENTRY_COPY}, and it offers
 * suggestions from `entry_tags_in_use` (the collection and the wishlist together) and never from
 * the decks. `docs/agent/DOMAIN_VOCABULARY.md` keeps the words apart.
 *
 * **A stack's tags are every copy's.** Ten copies in one row wear the same tags, because there is
 * one row to write them on; a reader who wants to tag one copy splits it into a stack of its own
 * first. The hint under the box is where that is said.
 */
import { useState, type JSX } from "react";
import { TagsField, type TagsFieldCopy, type TagsFieldProps } from "@/features/decks/DeckTagsField";
import { useEntryTagsInUse, useSetEntryTags, type EntryTagsRef } from "./useEntryTags";

/** A stack's words, beside `DeckTagsField`'s deck ones. */
const ENTRY_COPY: TagsFieldCopy = {
  chipsLabel: "Tags on this stack",
  suggestionsLabel: "Tags on your other cards",
  unit: ["stack", "stacks"],
  hint: (count) =>
    count < 2
      ? "Every copy in this stack shares its tags. Press Enter to add one."
      : "Every copy in this stack shares these tags. Drag a tag to move it.",
};

/** {@link TagsField} in a stack's words — the presentational half, for stories and tests. */
export function EntryTagsField(props: Omit<TagsFieldProps, "copy">): JSX.Element {
  return <TagsField {...props} copy={ENTRY_COPY} />;
}

export interface EntryTagsEditorProps {
  /** The stack the edits write to. */
  target: EntryTagsRef;
  /** What the stack wears now, as the host's list read it. */
  tags: readonly string[];
  id: string;
  autoFocus?: boolean;
  /** Draw the tags and take no edit — see {@link TagsFieldProps.disabled}. */
  disabled?: boolean;
  disabledHint?: string;
}

/**
 * The field, wired: the suggestions read, and a write per settled edit.
 *
 * **The chips draw the list the reader just made rather than the list the host last read.** A
 * write goes out on every chip added or removed and the host's row comes back a beat later, so a
 * second chip added inside that beat would otherwise be built on the stale list and quietly drop
 * the first. The local list is put back to the host's whenever the host's changes — a write
 * landing (Rust may tidy a spelling), or another window tagging the same stack — **but never while
 * a write is still out**: a re-read the first write asked for can land while the second is in
 * flight, and adopting it would put the stale list back under the reader's caret. It is the
 * "adjust state when a prop changes" pattern rather than an effect, so it never draws a frame of
 * the old list.
 */
export function EntryTagsEditor({
  target,
  tags,
  id,
  autoFocus,
  disabled = false,
  disabledHint,
}: EntryTagsEditorProps): JSX.Element {
  const inUse = useEntryTagsInUse(!disabled);
  const { setTags, error, pending } = useSetEntryTags();

  const seenKey = `${target.kind}:${target.id}:${JSON.stringify(tags)}`;
  const [seen, setSeen] = useState(seenKey);
  const [local, setLocal] = useState<readonly string[]>(tags);
  if (seen !== seenKey && !pending) {
    setSeen(seenKey);
    setLocal(tags);
  }

  return (
    <div>
      <EntryTagsField
        tags={local}
        inUse={inUse}
        id={id}
        autoFocus={autoFocus}
        disabled={disabled}
        disabledHint={disabledHint}
        onChange={(next) => {
          setLocal(next);
          setTags(target, next);
        }}
      />
      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Couldn't save the tags — {error}
        </p>
      )}
    </div>
  );
}
