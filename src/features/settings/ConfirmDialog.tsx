import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import { DeckDialog } from "@/features/decks/DeckDialog";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";

/**
 * The word a reader has to type out before an irreversible clear will run.
 *
 * **Exported so the tests and the panels agree on one string.** It is compared after a `trim`
 * and **case-sensitively**: this is a deliberateness gate rather than a spelling test, and a
 * gate that accepted `confirm` would be one a reader passes without looking at it. The trim is
 * there because a double-click on the label above it selects the word with its trailing space.
 */
export const CONFIRM_WORD = "Confirm";

export interface ConfirmDialogProps {
  open: boolean;
  /** The heading, and — through {@link DeckDialog} — the dialog's accessible name. */
  title: string;
  /** What pressing the button will do, in the reader's terms. The whole of the warning. */
  children: ReactNode;
  /** The destructive button's own words: `Clear collection`, never `OK`. */
  confirmLabel: string;
  /**
   * Whether the reader must type {@link CONFIRM_WORD} first.
   *
   * **The one prop that separates the two kinds of question on this page**, and it is a prop
   * rather than two components because everything else about them is identical — the same
   * shell, the same two controls, the same refusal line. `false` is the local cache: nothing it
   * deletes is the reader's only copy of anything, so a typed word there would be ceremony that
   * teaches readers to type the word without reading the sentence, which is exactly what would
   * make it useless on the three that need it.
   */
  typeToConfirm: boolean;
  /** The clear is in flight: both controls go inert and the button says so. */
  pending: boolean;
  /** Run it. The dialog closes itself first — see the handler. */
  onConfirm: () => void;
  /** Escape and the ✕: hand focus back to the button that opened this. */
  onDismiss: () => void;
  /** A press on the scrim. The reader is already somewhere else. */
  onClose: () => void;
}

/**
 * The question asked before anything on the Settings page is thrown away.
 *
 * ## Why it is built on `DeckDialog`
 *
 * That shell is the app's, not the deck builder's — `features/card`'s `AllPrintingsDialog`
 * already reaches across for it — and what it carries is a list of lessons a settings-local
 * copy would have to learn again: the scrim's `grid-rows-[minmax(0,1fr)]` without which a
 * panel's `max-h-full` clamps nothing, `onMouseDown` rather than `onClick` on the scrim so a
 * drag that ends outside does not dismiss, `aria-modal` paired with `trapTab` so the claim is
 * true for both input methods, and "closed is nothing mounted". That last one is doing real
 * work here: **the typed word is `useState` in this body, so it is thrown away and re-asked on
 * every open**, with no effect to reset it and no way for a half-typed confirmation to survive
 * a cancel.
 *
 * ## The one thing it overrides
 *
 * `DeckDialog` deliberately focuses the *panel* rather than a field, because its dialogs are
 * "panels of settled values rather than questions, and dropping the caret into the first text
 * box would make the reader's first keystroke an edit". This one is the other thing: it is a
 * single question, the field is the answer, and there is nothing to edit. The shell's own effect
 * checks `panel.contains(document.activeElement)` and stands down when the body has already
 * placed the caret — which is the carve-out `QuickZones` takes, for the same reason.
 *
 * ## The confirmation is this side's, and only this side's
 *
 * The backend takes no `confirm` argument. A fence passed as a parameter is a fence a caller can
 * forget, and there is exactly one caller. What makes this safe is that the command is
 * unreachable except through this dialog.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  typeToConfirm,
  pending,
  onConfirm,
  onDismiss,
  onClose,
}: ConfirmDialogProps): JSX.Element {
  return (
    <DeckDialog
      open={open}
      title={title}
      closeLabel={`Close ${title.toLowerCase()}`}
      width="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body
        confirmLabel={confirmLabel}
        typeToConfirm={typeToConfirm}
        pending={pending}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      >
        {children}
      </Body>
    </DeckDialog>
  );
}

/**
 * The question itself, mounted only while the dialog is open.
 *
 * A separate component for the shell's stated rule — a closed `DeckDialog` renders no children
 * — which is what makes the draft below a *session* rather than something an effect clears.
 */
function Body({
  children,
  confirmLabel,
  typeToConfirm,
  pending,
  onConfirm,
  onDismiss,
}: Pick<
  ConfirmDialogProps,
  "children" | "confirmLabel" | "typeToConfirm" | "pending" | "onConfirm" | "onDismiss"
>) {
  const id = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const armed = !typeToConfirm || typed.trim() === CONFIRM_WORD;

  // The field is the question, so the caret starts in it — see the component's note. Guarded on
  // the field existing rather than on the prop, so the plain confirm leaves the shell's own
  // focus to the panel exactly as every other dialog in the app does.
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  /**
   * **Dismiss first, then run it.** The clear is a command with no per-row progress and nothing
   * to show while it works; leaving the dialog up would put a spinner over a question that has
   * already been answered, and the panel underneath is where the outcome sentence lands. Going
   * through `onDismiss` rather than `onClose` is what hands the caret back to the button the
   * reader pressed, so the next Tab continues from where they were.
   */
  const confirm = () => {
    if (!armed || pending) return;
    onDismiss();
    onConfirm();
  };

  return (
    <div className="space-y-4 p-4 pt-0 text-sm">
      <p className="leading-relaxed text-dim">{children}</p>

      {typeToConfirm && (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-field`} className="block text-dim">
            Type <span className="font-medium text-text">{CONFIRM_WORD}</span> to continue
          </label>
          <input
            id={`${id}-field`}
            ref={fieldRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            // Enter is the same press as the button, and only while the word matches — a form
            // submit here would run the clear on the keystroke that finishes typing the word,
            // which is the one moment a reader is looking at the field rather than the sentence.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirm();
              }
            }}
            disabled={pending}
            // Every one of these is off because the browser's help is actively wrong here: an
            // autofilled or autocorrected word would pass a gate whose entire purpose is that
            // the reader typed it.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn(
              "w-full rounded-md border border-border bg-bg px-2 py-1.5",
              "disabled:cursor-not-allowed disabled:opacity-50",
              FOCUS,
            )}
          />
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDismiss} disabled={pending} className={BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          // `disabled`, not `aria-disabled`, and it is `controls.ts`' documented carve-out
          // reversed the same way its two callers reverse it: an unarmed button has genuinely
          // nothing to do, and a control that still depressed under the finger would be a third
          // answer disagreeing with both the greying and the refusal.
          disabled={!armed || pending}
          className={cn(
            BUTTON,
            "border-destructive text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:hover:bg-transparent disabled:hover:text-destructive",
            "motion-reduce:transition-none",
          )}
        >
          {pending ? "Working…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}
