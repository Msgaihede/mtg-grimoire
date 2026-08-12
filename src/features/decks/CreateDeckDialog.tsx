import { useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { ipcError, type DeckRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { dialog, scrim, statusLine } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import { DEFAULT_FORMAT, FormatSelect } from "./FormatSelect";
import type { Decks } from "./useDecks";

export interface CreateDeckDialogProps {
  /**
   * `useDecks().create`, owned by the gallery and handed down.
   *
   * A prop rather than a hook of this component's own, and the reason is the refusal: the
   * gallery calls `create.reset()` on the way in, so a refusal from the last attempt is not
   * news about this one — and this dialog is **the only place a refused create can be read**,
   * because `writeFailure` covers the writes a *tile* makes and not this one. Two mutations
   * would be two answers, and the one on screen would be the one that never fired.
   */
  create: Decks["create"];
  /**
   * **A mount, not a class**, exactly as `TheoryDiffDialog`'s is: everything with state — the
   * half-typed name, the picked format, the caret — lives one component down, so closing
   * unmounts all of it and reopening starts a genuinely new question rather than one somebody
   * has to remember to clear.
   */
  open: boolean;
  /** The deck the write answered with. The gallery opens it — nobody makes a deck in order to
   *  look at a tile of it. */
  onCreated: (deck: DeckRow) => void;
  /**
   * Escape, the header's ✕ and the trigger pressed again: close, and hand the caret back to
   * whatever opened this.
   *
   * Stable, please — {@link useDismissOnEscape} takes it as a dependency, so a function rebuilt
   * on every render of the opener re-registers the window listener just as often.
   */
  onDismiss: () => void;
  /**
   * A press on the scrim: close without moving focus.
   *
   * **Two callbacks, and it used to be one.** The single one handed the caret back on every way
   * out, which reads reasonable and is the opposite of the rule every other layer in this app
   * follows: Escape is the reader saying *put me back*, and a click outside is the reader
   * already being somewhere else. `TheoryDiffDialog` and `DeckSettingsDialog` are the precedent
   * and this now agrees with them.
   */
  onClose: () => void;
}

/**
 * Two questions and no more: what the deck is called, and what it is for.
 *
 * **A real modal, and it used to be an anchored popup.** The form was a 288px panel pinned to
 * the "New deck" button, dismissed by focus leaving it — which is the right shape for a
 * quick-add and the wrong one for the app's one creating act. Three things fall out of the
 * change and each was a defect in the old form: a modal is not dismissed by a blur, so a
 * refusal cannot be swallowed by the button disabling itself mid-write; the caret is trapped,
 * so Tab cannot walk out into a gallery the reader is not looking at; and the surface is
 * `fixed` rather than `absolute`, so it cannot hang off the right of the window.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects
 * a runtime `<style>`). A `fixed` element is positioned against the viewport *unless* an
 * ancestor carries a `transform`, `filter` or `contain`, any of which makes that ancestor the
 * containing block instead — the gallery's heading row carries none, which is what lets this
 * stay inside `NewDeck` beside the button it belongs to.
 *
 * **The Escape rung is registered up here, on the flag.** With an exit animation the panel
 * outlives `open` by the length of its fade, so a rung that came up with the *element* would
 * still be consuming Escape while the next layer was opening — and two `"inner"` peers are not
 * ordered by that protocol at all. For the same reason `DecksPage`'s own rung excludes this
 * panel: one layer, one rung.
 */
export function CreateDeckDialog({
  create,
  open,
  onCreated,
  onDismiss,
  onClose,
}: CreateDeckDialogProps): React.JSX.Element {
  // `useCallback`, because `onDismiss` is a dependency of the hook's effect and an unstable one
  // re-registers the window listener on every render of the gallery.
  const dismiss = useCallback(() => onDismiss(), [onDismiss]);
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  return (
    <AnimatePresence>
      {open && (
        <Panel
          key="create-deck"
          create={create}
          onCreated={onCreated}
          onDismiss={onDismiss}
          onClose={onClose}
        />
      )}
    </AnimatePresence>
  );
}

/** The dialog itself, mounted only while it is open — see {@link CreateDeckDialog}. */
function Panel({ create, onCreated, onDismiss, onClose }: Omit<CreateDeckDialogProps, "open">) {
  const [name, setName] = useState("");
  const [formatKey, setFormatKey] = useState(DEFAULT_FORMAT);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();
  /** False from the render that starts the fade out. */
  const present = useIsPresent();

  // The caret starts in the field the reader has to fill — the one difference from
  // `TheoryDiffDialog`, which focuses its panel because a stray Enter there would send nine
  // cards to the wishlist. Here a stray Enter submits a form that refuses a blank name.
  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, []);

  const failure = create.isError ? ipcError(create.error) : null;
  const trimmed = name.trim();

  return (
    // Scrim and panel in one presence: the ground darkens first and the panel scales up over
    // it, and the dialog is unmounted only once the later of the two tweens has finished.
    //
    // `LAYER.overlay` is the rung every full-window surface in this app shares. The number is
    // deliberately not written out here, in prose or anywhere else: Tailwind's scanner reads a
    // comment as eagerly as it reads code, so naming the class in a sentence emits a rule for
    // it — and `layers.test.ts`' sweep counts that as a second place the scale is written.
    <motion.div
      {...scrim}
      className={cn(
        "fixed inset-0 flex items-center justify-center bg-bg/70 p-4",
        !present && "pointer-events-none",
        LAYER.overlay,
      )}
      // On the way out it is a picture: nothing to press, and nothing in the accessibility
      // tree. Focus left with the flag.
      aria-hidden={present ? undefined : true}
      // A press on the scrim and nowhere else. `onMouseDown` rather than `onClick`, because a
      // click fires on the nearest common ancestor of press and release — so a drag that starts
      // on the name field and ends past the panel's edge is a "click" on the scrim, and the
      // dialog would vanish under a reader who was selecting the word they had just typed.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        {...dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        // Labelled **by the heading**, not by an `aria-label` beside it: the words are on
        // screen, so there is nothing for a second copy to drift from.
        aria-labelledby={`${id}-title`}
        // The caret stays inside, which is what makes the `aria-modal` above true rather than
        // merely claimed — see {@link trapTab}. Registered on the panel, which is where that
        // helper reads it from.
        onKeyDown={trapTab}
        className={cn(
          "flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border",
          "bg-bg shadow-2xl",
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 font-heading text-xl leading-none">
            New deck
          </h2>
          <button
            type="button"
            // The ✕ is the reader saying "put me back", exactly as Escape is — so it hands the
            // caret over rather than dropping it where the dialog used to be.
            onClick={onDismiss}
            aria-label="Close"
            className={cn(
              "-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            // A name of nothing but spaces is not a name. The button is disabled on the same
            // test; this is the half that catches an Enter in the field.
            if (!trimmed) return;
            create.mutate({ name: trimmed, formatKey }, { onSuccess: onCreated });
          }}
          className="space-y-3 px-5 py-4"
        >
          <div>
            <label htmlFor={`${id}-name`} className="mb-1 block text-xs text-dim">
              Name
            </label>
            <input
              id={`${id}-name`}
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(
                "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
                "focus:border-accent focus:outline-none",
              )}
            />
          </div>
          <div>
            <FormatSelect id={`${id}-format`} value={formatKey} onChange={setFormatKey} />
          </div>

          {/* No wrapper here, for a reason worth stating: this line carries no padding and no
              border, so `height: 0` on the element itself really is 0 and it can be the
              animated one. `overflow-hidden` is still owed — the sentence is laid out at its
              full size whatever the box is, and without it the text is drawn over the button
              below for the first frame. The form is a `space-y-3` stack, so the 12px the line
              brings with it still arrives at once; it is the two lines of the sentence that
              grow. */}
          <AnimatePresence initial={false}>
            {failure && (
              <motion.p
                {...statusLine}
                role="alert"
                className="overflow-hidden text-xs text-destructive"
              >
                Could not create the deck — {failure}
              </motion.p>
            )}
          </AnimatePresence>

          <button
            type="submit"
            disabled={!trimmed || create.isPending}
            className={cn(
              "h-9 w-full rounded-md border border-accent text-sm text-accent",
              "transition-colors duration-[var(--duration-fast)] ease-standard",
              "hover:bg-accent hover:text-accent-foreground",
              "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            {/* The verb keeps its name through the flow, so the control that says "Create
                deck" is the one whose press opens the deck it created. */}
            Create deck
          </button>
        </form>
      </motion.div>
    </motion.div>
  );
}
