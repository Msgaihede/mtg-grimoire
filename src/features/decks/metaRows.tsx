/**
 * The row grammar the deck's two meta dialogs share — a pile is a row, a label is a row, and
 * both are rows of the same family.
 *
 * `CategoriesDialog` and `TagsDialog` ask about different things: one is what a column of the
 * deck is called and whether it counts, the other is what a card is marked with. But a reader
 * meets them as the same list: a strip with the thing's name in it, two small words at the right
 * end that open something in place, a field that renames it, and one line at the foot when a
 * write is refused. That sameness is the point rather than a coincidence — the two dialogs are
 * one press apart in the same toolbar, and a Rename that is a link in one and a button in the
 * other reads as two features by two people.
 *
 * **One module rather than two copies, and the reason is the split that made this file.** These
 * three lived in `CategoriesPanel.tsx` beside both halves, where a change to `RenameField`'s
 * caret handling was visibly a change to categories *and* tags. Split into two dialogs, a copy
 * each would be two definitions of one rule with nothing keeping them in step — and this one in
 * particular has a bug behind it: `RenameField`'s `focus()` before its `select()` (see the
 * component) was found from outside, in `FolderTree`, which had written the identical line and
 * got it wrong. `sectionFailure` has the same history the other way round — it was the drawer
 * that picked the *first* refusal while every other surface picked the newest.
 *
 * **The class recipes are here for the same reason and are not `formFields.ts`'s.** That module
 * draws a deck *form*: a full-width field under a caption, at 14px. These are the controls of a
 * 32px row — `h-8`, 13px, sharing a line with a colour picker and a submit — and the two
 * recipes agreed on nothing but the corner radius. Two small vocabularies, each with one
 * subject, rather than one that has to carry a variant flag.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { FOCUS } from "@/lib/focus";
import { ipcError } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { writeFailure, type Write } from "@/lib/writes";

/** A name being typed into a meta row — the add fields in both dialogs and the rename field
 *  below, which is every text box either of them has. `placeholder:` is inert where there is no
 *  placeholder, so one recipe covers all three. */
export const META_FIELD = cn(
  "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-[0.8125rem]",
  "placeholder:text-dim focus:border-accent focus:outline-none",
);

/** The affirmative button at the end of such a row — Add, Add tag, Save. Gold outline filling on
 *  hover, and greyed while there is nothing to send. */
export const META_SUBMIT = cn(
  "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
  "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
  "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
  "motion-reduce:transition-none",
  FOCUS,
);

/** The two words a row offers, in one shape, so a category row and a tag row read as one
 *  family. */
export function RowAction({
  children,
  onClick,
  disabled,
  destructive,
  ref,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** So the row can put the caret back on the control that opened a confirmation — which it
   *  cannot do until the render that re-enables it. See `CategoryRow`'s effect. */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "shrink-0 rounded-sm text-[0.6875rem] text-dim",
        "transition-colors duration-150 disabled:opacity-50 motion-reduce:transition-none",
        destructive ? "hover:text-destructive" : "hover:text-text",
        FOCUS,
      )}
    >
      {children}
    </button>
  );
}

/** Rename in place: one field, its own Save, and Escape's job left to the dialog around it — a
 *  second Escape rung inside an `"inner"` layer is the case `useDismissOnEscape` explicitly does
 *  not order. Cancel is a control, and it is the one that hands the caret back. */
export function RenameField({
  label,
  initial,
  pending,
  extra,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  pending: boolean;
  extra?: ReactNode;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  // The caret starts in the field the reader opened, with the current name selected: the
  // commonest rename replaces the word rather than editing inside it.
  //
  // **Both calls, in this order, and `focus()` is not the redundant one.** Per spec
  // `HTMLInputElement.select()` sets a selection and does *not* move focus; Chromium focuses
  // anyway, which is exactly what makes the bug invisible where a person would meet it. Without
  // the `focus()` the caret stays on the Rename trigger — which the row has just **disabled**,
  // so it is parked on a dead control — and the reader's first keystroke goes to the page. Found
  // from outside by the agent building the decks page, which had the identical line;
  // `puts the caret in the rename field` is the test that holds it, in both dialogs' suites.
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const trimmed = value.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        onSave(trimmed);
      }}
      className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2"
    >
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={label}
        className={META_FIELD}
      />
      {extra}
      <button type="submit" disabled={pending || trimmed === ""} className={META_SUBMIT}>
        Save
      </button>
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
    </form>
  );
}

/**
 * The refusal a dialog is still owed a sentence about.
 *
 * One line per dialog rather than one per control: every refusal here is either a busy database
 * or a category, tag or deck another surface has deleted, and both are facts about the list
 * rather than about the button that happened to hit them.
 *
 * **The newest write, never the first one still holding an error** — {@link writeFailure}, the
 * rule the editor, the gallery and the settings dialog all follow. The drawer these two dialogs
 * were split out of used to pick the first non-null error in an argument list, which is the
 * opposite: a refused reorder would sit on screen while the reader went on to rename a pile
 * successfully.
 *
 * The read comes last and only when no write refused. A failed `deck_category_list` is a
 * different kind of news and outranks nothing: if a write has just been refused, that is what
 * the reader pressed.
 */
export function sectionFailure(
  writes: readonly [Write, ...Write[]],
  read: { isError: boolean; error: unknown },
): string | null {
  return writeFailure(writes) ?? (read.isError ? ipcError(read.error) : null);
}
