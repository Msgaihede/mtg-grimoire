/**
 * Put a label on the card the reader right-clicked: pick one of the labels this list is not
 * already using, or make one that does not exist yet.
 *
 * ## What it replaced, and why the shape changed twice
 *
 * It was `NewTagDialog` — the name it had while a label was called a tag — which was itself a
 * replacement for a text field inside the context menu. The field made a label in
 * {@link DEFAULT_LABEL_COLOR} because a menu has no room for a colour picker; that stopped being
 * right when a label's colour became the reader's own, since every label born from a menu would
 * be gold and have to be visited again to be told apart. So the fast path became the radio rows
 * above it — the deck's own labels, one press each — and making a *new* one became a deliberate
 * act in a dialog.
 *
 * Schema v21 changed what "the deck's own labels" means. A label belongs to no deck now, and the
 * rows above are **the labels this list is wearing** — which is the fast path the issue asks for
 * and is genuinely faster than it was, because a deck's list no longer fills up with labels it
 * has used once. The cost is that every *other* label the reader has ever made is off the menu,
 * and this dialog is where they went. So it is a picker with a create in it rather than a
 * create alone, and the one field at the top does both jobs.
 *
 * ## One field, two jobs
 *
 * Typing narrows the list **and** is the name a new label would get. That is not a trick: they
 * are the same question. A reader who types "cut" and sees "Cut candidate" wanted the label they
 * already have; a reader who types "cut" and sees nothing wanted a new one, and the button
 * under the list says so in their own words — `Create “cut”`. The two cannot both be right at
 * once, which is what the duplicate guard is for: a name an existing label already holds refuses
 * the create and points at the row, because pressing Add and waiting for the backend to say
 * "that exists" would be the app knowing the answer and declining to give it.
 *
 * The comparison is `labelNames.ts`' and not `===`: `removal` is `Removal`, and a `Café` typed
 * with a combining accent is a `Café` typed without one.
 *
 * ## What it does not own
 *
 * **The writes.** `onPick` and `onCreate` are the editor's, which is the rule the field this
 * replaced already followed, for the reason written out in full on `DeckCardMenuDeps.addLabel`:
 * a `mutate`-scoped callback belongs to its *observer*, and TanStack drops it when the observer
 * unmounts — so a create started here and chained here would lose its attach to an Escape
 * landing during the round trip, leaving the label made and silently never worn. This dialog
 * closes on the press, as the menu did; the editor's observer is what survives to finish it.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/Dialog";
import { type GlobalLabel } from "@/lib/ipc";
import { META_FIELD, META_SUBMIT } from "./metaRows";
import { LabelColorPanel, LabelSwatch } from "./LabelColorPicker";
import { DEFAULT_LABEL_COLOR } from "./labelColors";
import { findLabelByName, labelNameKey } from "./labelNames";

export interface AddLabelDialogProps {
  open: boolean;
  /** The card the label will be put on, for the header's line. `null` while the dialog is
   *  closed, which is the only time the shell draws nothing at all. */
  cardName: string | null;
  /** Every label **not already in this list**, most-used first — the app-wide list minus the
   *  rows the context menu already offered. The editor narrows it, because the editor is what
   *  knows both halves. */
  choices: readonly GlobalLabel[];
  /** The editor's `deck_label_create` in flight, which is the one thing this body cannot know
   *  for itself — the mutation is mounted a floor up so it can outlive this dialog. */
  pending: boolean;
  /** Put an existing label on the card. One press, and the dialog closes. */
  onPick: (labelId: number) => void;
  /** Make the label and put it on the card, as one act the editor owns. */
  onCreate: (name: string, color: string) => void;
  /** Escape, and the ✕: hand focus back to whatever opened the dialog, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus. */
  onClose: () => void;
}

/**
 * `26rem`, the width the create-only dialog had: the list below the field is one line per label
 * and the picker's own row — a wheel, six digits and six swatches — still sets the floor.
 */
export function AddLabelDialog({
  open,
  cardName,
  choices,
  pending,
  onPick,
  onCreate,
  onDismiss,
  onClose,
}: AddLabelDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Add label"
      subtitle={cardName === null ? undefined : `Put a label on “${cardName}”.`}
      closeLabel="Close add label"
      size="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <AddLabelBody choices={choices} pending={pending} onPick={onPick} onCreate={onCreate} />
    </Dialog>
  );
}

/** How many rows of the list are drawn before it scrolls. Ten is roughly the point at which
 *  reading stops being faster than typing, and the field above is what a longer list is for. */
const LIST_MAX = "max-h-56";

/**
 * Separate for {@link Dialog}'s reason — a closed dialog mounts no body — and here that also
 * makes the state free: the query and the colour are this component's, so every open starts on
 * an empty field and the default colour without anything having to reset them.
 */
function AddLabelBody({
  choices,
  pending,
  onPick,
  onCreate,
}: {
  choices: readonly GlobalLabel[];
  pending: boolean;
  onPick: (labelId: number) => void;
  onCreate: (name: string, color: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [color, setColor] = useState(DEFAULT_LABEL_COLOR.hex);
  const ref = useRef<HTMLInputElement>(null);

  // **The caret starts in the field**, which is the exception `Dialog`'s own focus effect
  // documents and defers to: this is one box asking one question, so the reader's first
  // keystroke being the name is right rather than an accidental edit. Child effects run before
  // a parent's, so this one wins by ordering.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const trimmed = query.trim();

  // Narrowed on the **key**, so `caf` finds `Café` however either was typed, and `REM` finds
  // `Removal`. A substring rather than a prefix: a reader who remembers "candidate" and not
  // "Cut" is the reader a filter is for. The list keeps the backend's most-used-first order,
  // which is the whole reason it is not re-sorted here.
  const shown = useMemo(() => {
    const key = labelNameKey(trimmed);
    if (key === "") return choices;
    return choices.filter((t) => labelNameKey(t.name).includes(key));
  }, [choices, trimmed]);

  // A name one of the **choices** holds is a row on screen to point at. One held by a label that
  // is *not* a choice — because this list is already wearing it — is not on screen at all, and
  // the sentence has to say something different or it points at nothing.
  const clash = findLabelByName(choices, trimmed);
  const canCreate = trimmed !== "" && clash === undefined;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canCreate) return;
        onCreate(trimmed, color);
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-6 pt-4"
    >
      <div>
        <label htmlFor="add-label-dialog-name" className="sr-only">
          Find or name a label
        </label>
        <input
          ref={ref}
          id="add-label-dialog-name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find or name a label…"
          className={cn(META_FIELD, "w-full flex-none")}
        />
      </div>

      {shown.length > 0 && (
        <ul className={cn("flex flex-col gap-1 overflow-y-auto", LIST_MAX)}>
          {shown.map((label) => (
            <li key={label.id}>
              <button
                type="button"
                onClick={() => onPick(label.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5",
                  "text-left text-[0.8125rem] transition-colors duration-150",
                  "hover:border-accent hover:text-accent motion-reduce:transition-none",
                  FOCUS,
                )}
              >
                <LabelSwatch color={label.color} />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                {/* What makes this list worth reading top-down: the reach the order is by.
                    A label nothing wears says nothing rather than "0 cards", which would be a
                    number about a label that has simply never been used yet. */}
                {label.cardCount > 0 && (
                  <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
                    {label.cardCount}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {shown.length === 0 && (
        <p className="text-[0.6875rem] text-dim">
          {choices.length === 0
            ? "Every label you have is already in this list. Name a new one above."
            : `No other label matches “${trimmed}”. Name it below to make it.`}
        </p>
      )}

      {/* The picker is open rather than behind a press, for the reason the create-only dialog
          gave: a reader who is here to make a label wants to choose its colour, and hiding the
          colour behind a second press would be the point deferred. It is below the list, not
          above it, because picking an existing label is the commoner act and a colour is a
          question only the create asks. */}
      <LabelColorPanel value={color} onChange={setColor} />

      {clash !== undefined && (
        <p className="text-[0.6875rem] text-dim" role="status">
          “{clash.name}” already exists — pick it from the list above.
        </p>
      )}

      <div className="flex justify-end">
        <button type="submit" disabled={pending || !canCreate} className={META_SUBMIT}>
          {trimmed === "" ? "Create label" : `Create “${trimmed}”`}
        </button>
      </div>
    </form>
  );
}
