import { useEffect, useId, useRef, type JSX, type ReactNode } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { LAYER } from "@/lib/layers";
import { dialog as dialogMotion, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";

export interface DeckDialogProps {
  open: boolean;
  /** The `<h2>` in the header. The panel is `aria-labelledby` this. */
  title: string;
  /**
   * The close button's accessible name, e.g. "Close deck settings".
   *
   * Explicit rather than derived from {@link title}, because "Close Categories & tags" is not a
   * sentence — and a name assembled from a title is a name nobody wrote and nobody can fix
   * without changing the heading a reader sees.
   */
  closeLabel: string;
  /**
   * The panel's Tailwind width class, written out whole — e.g. `"w-[48rem]"`.
   *
   * Written out because **Tailwind scans source text for whole class names**: a class built by
   * interpolation matches nothing the scanner knows and emits no rule at all, which fails
   * silently and only in a build. So the host spells its own width and this file never touches
   * the string. `max-w-full` below is the shell's, so a width wider than the window still fits.
   */
  width: string;
  /**
   * Escape, and the close control: hand focus back to whatever opened the dialog, then close.
   *
   * Stable, please — {@link useDismissOnEscape} takes it as a dependency, so a function rebuilt
   * on every render of the opener re-registers the window listener just as often.
   */
  onDismiss: () => void;
  /** A press on the scrim: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * The deck builder's modal shell: a scrim, a centred panel, a titled header and a ✕.
 *
 * It exists because "in the style of Deck settings" was a **resemblance** across four surfaces —
 * a settings dialog, a history dialog and the two halves of the old categories drawer — and a
 * resemblance is four independent decisions that happen to agree today. The chrome was lifted
 * whole out of `DeckSettingsDialog`, which is why every class string and every comment below
 * reads as that file's: it is that file's.
 *
 * ## What it guarantees to every host
 *
 * * **Closed is nothing mounted.** `children` render only while `open`, so a dialog nobody
 *   opened costs no query, no draft and no caret position — which is what lets `DeckEditor`
 *   mount all of its dialogs unconditionally and pay for none of them. It also means each body
 *   starts clean on every open, so the state belongs *inside* `children` rather than being reset
 *   by an effect out here.
 * * **The Escape rung is registered on the flag, not on the panel's mount.** The panel outlives
 *   `open` by the length of its fade, and a rung that came up with the *element* would still be
 *   consuming Escape while the next overlay opens — two `"inner"` peers, which
 *   {@link useDismissOnEscape} explicitly does not order.
 * * **{@link DeckDialogProps.onDismiss} must be stable.** See the prop.
 * * **The body owns its own scroller.** The header is this file's and everything under it is the
 *   host's, because the three bodies differ — one keeps a sticky roll-up inside its scroller —
 *   and a shell that owned the scroll container would have to grow a prop for each of them.
 *   A body is expected to be, or to contain, `min-h-0 flex-1 overflow-y-auto` with its own
 *   padding; the panel is the `flex flex-col` that makes that work.
 * * **The presence subtree reaches the body.** `children` render inside the same
 *   `AnimatePresence` child the panel does, so a `useIsPresent()` in a host's body is false from
 *   the render that starts the exit — which is what `useDeckField`'s commit-on-close is driven
 *   by, and it is the one thing here a careless extraction would break silently.
 *
 * Not portalled, like every other overlay in this app: the shipped CSP is `style-src 'self'` and
 * the libraries that portal reliably also want a runtime `<style>`.
 */
export function DeckDialog({
  open,
  title,
  closeLabel,
  width,
  onDismiss,
  onClose,
  children,
}: DeckDialogProps): JSX.Element {
  // The `"inner"` rung, **registered out here on the flag** rather than one floor down on the
  // panel's mount. One press closes this and the card pane behind the view keeps its own — and
  // because an inner layer listens in the **capture** phase, it beats any handler a field
  // inside the dialog could register. That is why no text field in any of these bodies tries to
  // make Escape mean "revert what I typed": the press never reaches it, and a control that
  // works only sometimes is worse than one that never claimed to.
  //
  // Out here because the panel outlives `open` by the length of its fade, and a rung that came
  // up with the *element* would still be consuming Escape while the next overlay opens.
  // `enabled: open` kills it on the render that starts the exit.
  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  // Closed is *nothing mounted*, not a hidden panel: a body reads a deck, a folder tree, an
  // audit log, and a dialog nobody opened has no business asking for any of them. It also means
  // every draft, every disclosure and the caret's position start clean on each open.
  return (
    <AnimatePresence>
      {open && (
        <Panel
          key="panel"
          title={title}
          closeLabel={closeLabel}
          width={width}
          onDismiss={onDismiss}
          onClose={onClose}
        >
          {children}
        </Panel>
      )}
    </AnimatePresence>
  );
}

/** The chrome proper — mounted only while it is open, which is what makes a body's state a
 *  session rather than something an effect has to clear. */
function Panel({
  title,
  closeLabel,
  width,
  onDismiss,
  onClose,
  children,
}: Omit<DeckDialogProps, "open">) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** False from the render that starts the fade out — the panel goes inert on it, and a host's
   *  body sees the same answer, which is what `useDeckField` writes on. */
  const present = useIsPresent();

  // The caret moves into the layer, as it does for every other one in the app: the dialog's own
  // controls are then the next thing Tab reaches, and Escape has something to hand back. **No
  // field is focused** — these are panels of settled values rather than questions, and dropping
  // the caret into the first text box would make the reader's first keystroke an edit.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    // Scrim and panel in one presence: the ground fades first and the panel scales up over it,
    // and the dialog is unmounted only once the later of the two tweens has finished.
    <motion.div
      {...scrim}
      // A **scrim**: every anchored layer in this app leaves the view behind it live, and this
      // one covers the window, which is what makes `aria-modal` below honest rather than a
      // claim — see the panel.
      className={cn(
        "fixed inset-0 grid place-items-center bg-bg/75 p-4 sm:p-6",
        !present && "pointer-events-none",
        // Above every anchored popup and above the editor's drag tray: a dialog opened over the
        // editor must not be painted under a menu the reader left open behind it. Below `gate`,
        // which is `SyncProgress` taking the whole window.
        LAYER.overlay,
      )}
      // On the way out it is a picture: nothing to press, and nothing in the accessibility tree
      // — a second `role="dialog"` beside whichever overlay the reader opened next would be a
      // form they have already dismissed. Focus left with the flag.
      aria-hidden={present ? undefined : true}
      // `onMouseDown`, not `onClick`, and the target check is why: a drag that starts on a
      // textarea's resize handle and ends out here fires a `click` on this element — the two
      // targets' common ancestor — so a click handler would close the dialog on a gesture that
      // never left it. Where the press *lands* is unambiguous.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        {...dialogMotion}
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        // **`aria-modal` here where `SyncProgress` refuses it, and the difference is the
        // scrim.** That component is a full-window takeover with nothing over the app behind
        // it: the ribbon and every view stay reachable by keyboard, so claiming modality there
        // would hide from assistive technology a screen anyone can still Tab into — its own
        // comment says exactly that, and it is right. This one paints a scrim a pointer cannot
        // cross, and `trapTab` below keeps the caret inside to match. The claim is true for
        // both input methods, which is the only condition under which it may be made — and if
        // either half is ever removed, this attribute goes with it.
        onKeyDown={trapTab}
        className={cn(
          "flex max-h-full max-w-full flex-col rounded-xl border border-border bg-bg shadow-2xl",
          width,
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          {/* Cinzel at 20px — the display face's own rule in this app: view titles and hero
              copy, never below 18px. */}
          <h2 id={`${id}-title`} className="font-heading text-xl leading-none">
            {title}
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={closeLabel}
            className={cn(
              "ml-auto rounded-md p-1 text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {/* No scroll container here: see this file's doc. The body is the host's, and it brings
            its own `min-h-0 flex-1 overflow-y-auto` and its own padding. */}
        {children}
      </motion.div>
    </motion.div>
  );
}
