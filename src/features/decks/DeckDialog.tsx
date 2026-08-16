import { useEffect, useId, useRef, type JSX, type ReactNode } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { dialog as dialogMotion, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

export interface DeckDialogProps {
  open: boolean;
  /**
   * The `<h2>` in the header. The panel is `aria-labelledby` this, unless {@link ariaLabel}
   * overrides it.
   *
   * **A `ReactNode` rather than a string, and one heading needed it**: `TheoryDiffDialog` draws
   * `Theory <span aria-hidden>→</span><span class="sr-only">to</span> Live`, because an arrow is
   * not a word and what a screen reader makes of "→" ranges from "right arrow" to silence. A
   * heading that has to say one thing to the eye and another to a reader cannot be a string.
   */
  title: ReactNode;
  /**
   * The panel's accessible name, for the one heading that cannot serve as one.
   *
   * **Absent is the rule and this is the exception.** Labelling by the heading is what keeps the
   * name and the words on screen from drifting apart, so every host that can leaves this alone.
   * The one that cannot is {@link title}'s example: a heading spelled half in an `aria-hidden`
   * glyph and half in an `sr-only` twin reads correctly aloud but is not a *name* anything can be
   * addressed by, and `DeckEditor.test.tsx`'s Tab sweep addresses that overlay by exactly this
   * string.
   *
   * When it is given, `aria-labelledby` is **not** also set — two names on one element is one
   * name silently winning, and it would be the wrong one.
   */
  ariaLabel?: string;
  /**
   * A line under the heading, in the header's own band: where the cards are going, what the list
   * is for. Optional, and most dialogs have nothing to put here.
   *
   * **Under the heading rather than beside it**, which is one of the two shapes this replaced.
   * Beside it, a subtitle and a 20px Cinzel heading compete for one line and the *heading* is
   * what truncates; under it, the heading is never squeezed and the subtitle can be as long as
   * the data makes it — `Into Removal · Burn · Live` is assembled from a pile name and a deck
   * name and has no length anybody controls.
   */
  subtitle?: ReactNode;
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
   * **Stability is a courtesy here now, not a requirement**, and the reason it used to be one is
   * worth knowing. This said "{@link useDismissOnEscape} takes it as a dependency, so a function
   * rebuilt on every render of the opener re-registers the window listener just as often" — and
   * once that hook grew its stack, a re-registration did worse than cost a listener: it popped
   * this layer's token and pushed a new one, landing on **top** of whatever had been opened over
   * it, so the next Escape closed the wrong window. The hook latches this in a ref for exactly
   * that reason and depends only on `enabled` and `layer`. An unstable one now costs a re-render
   * of the panel and nothing else.
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
 * **The last three copies were folded in on 2026-08-16** — `CreateDeckDialog`,
 * `ImportDeckDialog` and `TheoryDiffDialog` — and what they brought with them is the argument
 * for this file restated. Between the three of them one editor drew **two scrim darknesses**,
 * the ✕ at **two geometries and two speeds**, and the panel at **three** `max-h` values, none of
 * which anybody decided: they are what four independent copies of one design look like after a
 * year. Every one of those is settled once, below, with the reason at the site.
 *
 * ## What it guarantees to every host
 *
 * * **Closed is nothing mounted.** `children` render only while `open`, so a dialog nobody
 *   opened costs no query, no draft and no caret position — which is what lets `DeckEditor`
 *   mount all of its dialogs unconditionally and pay for none of them. It also means each body
 *   starts clean on every open, so the state belongs *inside* `children` rather than being reset
 *   by an effect out here.
 * * **The Escape rung is registered on the flag, not on the panel's mount.** The panel outlives
 *   `open` by the length of its fade, and a rung that came up with the *element* would go on
 *   acting for that whole window — spending a press on a dialog that is already closing, and
 *   starving whatever sits behind it, since an `"inner"` rung `preventDefault()`s and an
 *   `"outer"` one (the card detail pane) returns early on `defaultPrevented`. `enabled: open`
 *   kills it on the render that starts the exit. This used to name a different failure — "two
 *   `"inner"` peers, which {@link useDismissOnEscape} explicitly does not order" — and that hook
 *   keeps a stack of capture-phase registrations now, where only the token on top acts, so peers
 *   *are* ordered, by mount depth. Registering on the flag is what decides when this dialog joins
 *   and leaves that stack, which makes the flag more load-bearing than it was rather than less.
 * * **{@link DeckDialogProps.onDismiss} is worth keeping stable, and no longer for correctness.**
 *   See the prop.
 * * **The body owns its own scroller.** The header is this file's and everything under it is the
 *   host's, because the bodies differ — one keeps a sticky roll-up inside its scroller — and a
 *   shell that owned the scroll container would have to grow a prop for each of them. (A count of
 *   hosts used to stand here and had already drifted once; it is a number the imports answer.)
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
  ariaLabel,
  subtitle,
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
  // Out here because the panel outlives `open` by the length of its fade, and a rung that came up
  // with the *element* would go on acting for that whole window. The press it would eat is the
  // one belonging to the layer **behind** this dialog — a capture rung `preventDefault()`s, and
  // the card pane's bubble rung returns early on `defaultPrevented` — rather than the next
  // overlay's, which mounts *after* this one and therefore lands above it on the hook's stack.
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
          ariaLabel={ariaLabel}
          subtitle={subtitle}
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
  ariaLabel,
  subtitle,
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
  //
  // **Unless the body has already put it somewhere**, which is a body's decision to make and
  // this must not undo. Child effects run before a parent's, so a body that focused one of its
  // own controls has done so by the time this runs — and without the test it would be
  // immediately overruled, silently and only in the shipped window, since the two effects agree
  // about everything except which element ends up holding the caret. The one body that takes
  // this route is the quick zones' New category (`QuickZones.tsx`), which is a single empty box
  // asking one question rather than a panel of settled values. `contains` rather than a prop:
  // there is nothing for a host to get wrong, and the fallback stands for every other body.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.focus({ preventScroll: true });
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
        // Labelled **by the heading** wherever the heading can carry it: the words are on screen,
        // so there is nothing for a second copy to drift from. `ariaLabel` is the carve-out and
        // takes the element instead of joining it — see the prop.
        aria-labelledby={ariaLabel === undefined ? `${id}-title` : undefined}
        aria-label={ariaLabel}
        // **`aria-modal` here where `SyncProgress` refuses it, and the difference is the
        // scrim.** That component is a full-window takeover with nothing over the app behind
        // it: the ribbon and every view stay reachable by keyboard, so claiming modality there
        // would hide from assistive technology a screen anyone can still Tab into — its own
        // comment says exactly that, and it is right. This one paints a scrim a pointer cannot
        // cross, and `trapTab` below keeps the caret inside to match. The claim is true for
        // both input methods, which is the only condition under which it may be made — and if
        // either half is ever removed, this attribute goes with it.
        onKeyDown={trapTab}
        // **`max-h-full` is the one height rule, settled 2026-08-16.** The three dialogs folded
        // into this shell arrived carrying `max-h-[85%]` and `max-h-[80%]` against this
        // `max-h-full`, which is three answers to one question — and the percentages are the
        // weaker two, because the scrim above already states the inset as padding
        // (`p-4 sm:p-6`). A percentage of the *padded* box is a second, smaller inset stacked on
        // the first, so the gap a reader sees is the padding plus a fraction of the window and
        // grows with the window: at 800px it is 16 + ~115, at 1400px it is 24 + ~206. One rule —
        // the scrim's padding is the inset, and the panel takes what is left — is a constant gap
        // at every size, which is what the four dialogs already on this shell draw.
        className={cn(
          "flex max-h-full max-w-full flex-col rounded-xl border border-border bg-bg shadow-2xl",
          width,
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            {/* Cinzel at 20px — the display face's own rule in this app: view titles and hero
                copy, never below 18px. */}
            <h2 id={`${id}-title`} className="font-heading text-xl leading-none">
              {title}
            </h2>
            {subtitle !== undefined && <p className="mt-1 truncate text-xs text-dim">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={closeLabel}
            // **The one speed, settled 2026-08-16 with the height above.** The three dialogs
            // folded in here spelled this fade with the app's own token and this shell spelled it
            // as a bare 150 — which is not on the scale at all (`src/index.css` has 120 / 180 /
            // 260), so the shell's was the drift rather than theirs. The token is what
            // `src/index.css` exists for: one scale, so a CSS-only fade and a JS one cannot part
            // company. `shrink-0` because the heading block beside it is `flex-1` now and a long
            // subtitle must not squeeze the way out.
            className={cn(
              "shrink-0 rounded-md p-1 text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
              "motion-reduce:transition-none",
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
