/**
 * One label, made and put on the card the reader right-clicked — the whole of what "Tag card ▸
 * New tag…" opens.
 *
 * ## Why it is a dialog and not the field it replaced
 *
 * The submenu used to end in a text box: type a name, press Add, and the label was made in
 * {@link DEFAULT_TAG_COLOR} because a context menu has no room for a colour picker and a reader
 * deciding a card is a cut candidate should not have to open a dialog to say so. That was the
 * right trade while a colour was one of six tokens — the reader could recolour it in the Tags
 * dialog afterwards and the six were all there was. It stopped being right when the colour became
 * the reader's own (see `tagColors.ts`): a field that silently picks gold, from a menu whose whole
 * subject is what this card is, means every label born here has to be visited again to be told
 * apart from every other label born here.
 *
 * So the fast path is the **radio rows above it** — the deck's existing labels, one press each,
 * exactly as before and now without a field under them — and making a *new* one is the deliberate
 * act it always was, with the two things a new label needs in the one place.
 *
 * ## What it does not own
 *
 * **The write.** `onCreate` is the editor's, and that is the same rule the field it replaced
 * followed, for the same reason stated in full on `DeckCardMenuDeps.newTag`: a `mutate`-scoped
 * callback belongs to its *observer*, and TanStack drops it when the observer unmounts — so a
 * create started here and chained here would lose its attach to an Escape landing during the round
 * trip, leaving the label made and silently never worn. This dialog closes on the press, as the
 * menu did; the editor's observer is what survives to finish the chain.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/Dialog";
import { META_FIELD, META_SUBMIT } from "./metaRows";
import { TagColorPanel } from "./TagColorPicker";
import { DEFAULT_TAG_COLOR } from "./tagColors";

export interface NewTagDialogProps {
  open: boolean;
  /** The card the label will be put on, for the header's line. `null` while the dialog is
   *  closed, which is the only time the shell draws nothing at all. */
  cardName: string | null;
  /** The editor's `deck_tag_create` in flight, which is the one thing this body cannot know for
   *  itself — the mutation is mounted a floor up so it can outlive this dialog. */
  pending: boolean;
  /** Make the label and put it on the card, as one act the editor owns. */
  onCreate: (name: string, color: string) => void;
  /** Escape, and the ✕: hand focus back to whatever opened the dialog, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus. */
  onClose: () => void;
}

/**
 * `26rem` against the Tags dialog's 36: there is one field and one picker here and no list at
 * all, and the picker's own row — a wheel, six digits and six swatches — is what sets the floor.
 */
export function NewTagDialog({
  open,
  cardName,
  pending,
  onCreate,
  onDismiss,
  onClose,
}: NewTagDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="New tag"
      subtitle={cardName === null ? undefined : `Made in this deck and put on “${cardName}”.`}
      closeLabel="Close new tag"
      width="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <NewTagBody pending={pending} onCreate={onCreate} onCancel={onDismiss} />
    </Dialog>
  );
}

/**
 * Separate for {@link Dialog}'s reason — a closed dialog mounts no body — and here that also
 * makes the state free: the name and the colour are this component's, so every open starts on an
 * empty field and the default colour without anything having to reset them.
 */
function NewTagBody({
  pending,
  onCreate,
  onCancel,
}: {
  pending: boolean;
  onCreate: (name: string, color: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_TAG_COLOR.hex);
  const ref = useRef<HTMLInputElement>(null);

  // **The caret starts in the field**, which is the exception `Dialog`'s own focus effect
  // documents and defers to: this is a single empty box asking one question rather than a panel
  // of settled values, so the reader's first keystroke being the name is right rather than an
  // accidental edit. Child effects run before a parent's, so this one wins by ordering.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const trimmed = name.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        onCreate(trimmed, color);
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-6 pt-4"
    >
      <div>
        <label htmlFor="new-tag-dialog-name" className="sr-only">
          New tag name
        </label>
        <input
          ref={ref}
          id="new-tag-dialog-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag name…"
          className={cn(META_FIELD, "w-full flex-none")}
        />
      </div>

      {/* Open, where the Tags dialog keeps the same panel behind a press. That dialog's add row
          is one line among many and a picker unfolding under it is a panel a reader asked for;
          this window has one field in it and exists because the reader wanted to choose a
          colour, so hiding the colour behind a second press would be the whole point deferred. */}
      <TagColorPanel value={color} onChange={setColor} />

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "h-8 shrink-0 rounded-md border border-border px-3 text-xs text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
        <button type="submit" disabled={pending || trimmed === ""} className={META_SUBMIT}>
          Add tag
        </button>
      </div>
    </form>
  );
}
