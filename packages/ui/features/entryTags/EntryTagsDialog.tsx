/**
 * **Tags…** — the right-click menu's way to a stack's tags (issue #1398), on the collection's
 * table and on the wishlist.
 *
 * A dialog rather than a submenu because a tag is typed: a menu panel closes on the first press
 * and has no box to type into. Every edit writes as it settles, Deck settings' rule for its tag
 * field, so there is no Save — **Done** and the ✕ only close it, and a half-typed tag is added on
 * the way out by the field's own blur.
 */
import { useId, type ReactElement } from "react";
import { Dialog } from "@/components/Dialog";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { EntryTagsEditor } from "./EntryTagsField";
import type { EntryTagsRef } from "./useEntryTags";

/** The stack the dialog is about, as much of it as the question needs. */
export interface EntryTagsTarget {
  ref: EntryTagsRef;
  /** The card's name, for the line that says which stack. */
  cardName: string;
  /** Where the stack is — the printing, the finish, the folder — or `null` to say nothing. */
  detail: string | null;
  /** What the stack wears now. */
  tags: readonly string[];
}

export function EntryTagsDialog({
  target,
  onDismiss,
  onClose,
}: {
  /** The stack, or `null` — which is what "closed" means here. */
  target: EntryTagsTarget | null;
  /** Escape and the ✕. */
  onDismiss: () => void;
  /** The scrim and Done. */
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={target !== null}
      title="Tags"
      closeLabel="Close the tags"
      size="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      {target !== null && (
        <EntryTagsBody
          // Keyed on the stack: the editor's local list is seeded from the row it mounts with.
          key={`${target.ref.kind}:${target.ref.id}`}
          target={target}
          onDone={onClose}
        />
      )}
    </Dialog>
  );
}

function EntryTagsBody({
  target,
  onDone,
}: {
  target: EntryTagsTarget;
  onDone: () => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="space-y-4 p-1">
      <p className="text-sm leading-snug">
        <span className="font-medium">{target.cardName}</span>
        {target.detail !== null && <span className="text-dim"> {target.detail}</span>}
      </p>
      <EntryTagsEditor target={target.ref} tags={target.tags} id={id} autoFocus />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onDone}
          // `EditCopy`'s outlined-accent affirmative: the edits have already been written, so
          // this is the one press that says the reader is finished.
          className={cn(
            "rounded-md border border-accent px-3 py-1 text-xs text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Done
        </button>
      </div>
    </div>
  );
}
