import { useEffect, useId, useRef, type JSX, type ReactNode } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { dialog as dialogMotion, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/**
 * A control drawn **outside** the panel, one on each side, vertically centred.
 *
 * The one shape on this shell that is neither chrome nor body: `AllPrintingsDialog`'s step
 * chevrons, which walk the modal along the open deck. They are the shell's problem rather than
 * the host's because of where the room has to come from — see {@link DialogProps.flanks}.
 */
export interface DialogFlanks {
  /** Drawn off the panel's left edge. */
  left: ReactNode;
  /** Drawn off its right edge. */
  right: ReactNode;
}

export interface DialogProps {
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
   * Two controls hung off the panel's sides, or absent — which is what every host but one is.
   *
   * **Absent has to be byte-for-byte today's scrim, and that is the reason this is a prop rather
   * than something a host renders for itself.** Every other dialog in the builder sits on this
   * shell and none of them may move a pixel because one of them grew a chevron.
   *
   * ## Why the shell reserves the room rather than the host hanging a button off the panel
   *
   * The panel is `max-w-full` inside a scrim whose padding is the whole inset (`p-4 sm:p-6`), so
   * a wide panel already *is* the window — `AllPrintingsDialog` asks for `w-full`, and at the
   * app's **1024px floor** even the fixed widths above it (`w-[55rem]` is 880) have nothing left
   * over. A button positioned off that panel's edge is therefore off the
   * window: unreachable by pointer, and scrollable to by nothing, since a horizontal scrollbar is
   * the one thing the 1024px floor forbids. So the scrim becomes a three-column grid —
   * {@link FLANK_COLUMNS} either side, the panel in `minmax(0,1fr)` between them — and the panel
   * **narrows** on a small window instead of the flanks leaving it. The rows are untouched:
   * `grid-rows-[minmax(0,1fr)]` is what makes the panel's `max-h-full` mean anything at all, and
   * that argument is written out on the scrim below.
   *
   * ## Why they are rendered *inside* the panel
   *
   * `trapTab` cycles within `e.currentTarget`, which is the panel — so a flank rendered as a
   * sibling of the panel in the scrim would be reachable by pointer and by nothing else, and would
   * sit outside the `aria-modal` subtree while being the only way to move the modal on. Inside it,
   * each flank is an ordinary tab stop of the dialog it belongs to. They are absolutely positioned
   * out over the reserved columns, which is legal because **this panel does not clip its content**
   * — the guarantee stated at the panel's own site, and this is the first caller to depend on it.
   */
  flanks?: DialogFlanks;
  /**
   * A second keydown handler on the **panel**, composed with `trapTab` rather than replacing it.
   *
   * For a host whose dialog answers keys of its own — today, `AllPrintingsDialog`'s
   * ArrowLeft/ArrowRight walk along the open deck. **On the panel and never on `window`**, which
   * is the whole reason it is a prop here: a window listener would let an open modal arrow-drive
   * the view behind it, and let that view's own arrow handling reach into the modal. The panel
   * holding the caret is the only thing entitled to the press.
   *
   * `trapTab` runs first and unconditionally, so the modality guarantee cannot be spent by a host
   * handler that throws or that stops the event. The two never contend for a key — one reads Tab,
   * the other must not — and a host that wants to yield to something inside the dialog reads
   * `e.defaultPrevented` for itself.
   */
  onPanelKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
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
 * * **{@link DialogProps.onDismiss} is worth keeping stable, and no longer for correctness.**
 *   See the prop.
 * * **The body owns its own scroller.** The header is this file's and everything under it is the
 *   host's, because the bodies differ — one keeps a sticky roll-up inside its scroller — and a
 *   shell that owned the scroll container would have to grow a prop for each of them. (A count of
 *   hosts used to stand here and had already drifted once; it is a number the imports answer.)
 *   A body is expected to be, or to contain, `min-h-0 flex-1 overflow-y-auto` with its own
 *   padding; the panel is the `flex flex-col` that makes that work.
 * * **A host that asks for nothing gets exactly the dialog it got before the last prop landed.**
 *   {@link DialogProps.flanks} and {@link DialogProps.onPanelKeyDown} are both absent for
 *   every host but one, and both are written so that absent leaves the scrim's and the panel's
 *   class strings character for character what they were. That is the price of one shell under
 *   every dialog in the builder: a prop added for one surface may not move the rest of them (how
 *   many that is, is a number the imports answer), and `Dialog.test.tsx` pins the untouched
 *   shape rather than trusting the reading.
 * * **The presence subtree reaches the body.** `children` render inside the same
 *   `AnimatePresence` child the panel does, so a `useIsPresent()` in a host's body is false from
 *   the render that starts the exit — which is what `useDeckField`'s commit-on-close is driven
 *   by, and it is the one thing here a careless extraction would break silently.
 *
 * Not portalled, like every other overlay in this app: the shipped CSP is `style-src 'self'` and
 * the libraries that portal reliably also want a runtime `<style>`.
 */
export function Dialog({
  open,
  title,
  ariaLabel,
  subtitle,
  closeLabel,
  width,
  flanks,
  onPanelKeyDown,
  onDismiss,
  onClose,
  children,
}: DialogProps): JSX.Element {
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
          flanks={flanks}
          onPanelKeyDown={onPanelKeyDown}
          onDismiss={onDismiss}
          onClose={onClose}
        >
          {children}
        </Panel>
      )}
    </AnimatePresence>
  );
}

/**
 * The room a flank is given on each side of the panel, as the scrim's two outer columns.
 *
 * **3.5rem is one 36px control plus the 8px it stands off the panel, plus 12px of slack** — the
 * app's own control height, which is what `AllPrintingsDialog`'s chevrons are drawn at and what
 * every other button in the deck builder measures. The slack is the window edge's: at the 1024px
 * floor the scrim's `sm:p-6` is already 24px, so a chevron never sits against the glass.
 *
 * Written out whole rather than composed, because **Tailwind scans source text for whole class
 * names** and a template built from a length matches nothing the scanner knows — it emits no rule
 * at all, silently, and only in a build. The panel takes `col-start-2` to land between them:
 * `place-items-center` centres a grid item in its area, it does not choose the area, and with the
 * panel as the scrim's only child auto-placement would put it in the first column.
 */
const FLANK_COLUMNS = "grid-cols-[3.5rem_minmax(0,1fr)_3.5rem]";

/** The chrome proper — mounted only while it is open, which is what makes a body's state a
 *  session rather than something an effect has to clear. */
function Panel({
  title,
  ariaLabel,
  subtitle,
  closeLabel,
  width,
  flanks,
  onPanelKeyDown,
  onDismiss,
  onClose,
  children,
}: Omit<DialogProps, "open">) {
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
      //
      // **`grid-rows-[minmax(0,1fr)]` is what makes the panel's `max-h-full` mean anything**
      // (2026-08-18). A percentage `max-height` on a grid item resolves against its *grid area*,
      // and the area here was an **implicit** row — which is `auto`, and an `auto` row sizes to
      // its own content. So the clamp was circular: the row grew with the panel, `100%` of it
      // grew too, and nothing was ever clamped. Measured in a headless browser at a 708px
      // viewport with a 140-line export: the panel drew **2963px**, its body's
      // `overflow-y-auto` never scrolled because it had all the room it asked for, and Copy and
      // Save as… sat at y≈2930 — off the window, unreachable by pointer or wheel. Naming one
      // explicit row bounds the area to the scrim's content box: the same panel draws 660px, the
      // export's preview scrolls its own 2754px, and the buttons are on screen. The `minmax(0,`
      // half is not decoration — a bare `1fr` is `minmax(auto, 1fr)`, whose `auto` floor is the
      // content again, which is the bug spelled a second way.
      //
      // It reached every dialog on this shell rather than the one it was reported against, and
      // **jsdom cannot see any of it**: it has no layout engine, so every box is 0 and this whole
      // class of defect is invisible to the suite. The shell's test pins the class; the numbers
      // above came from a browser.
      className={cn(
        "fixed inset-0 grid grid-rows-[minmax(0,1fr)] place-items-center bg-bg/75 p-4 sm:p-6",
        // **Only when a host asked for flanks**, and the `undefined` test is doing real work: with
        // no flanks this string has to be what it was before the prop existed, because every other
        // dialog in the builder is drawn by this line and a third column would narrow all of them
        // to buy room nobody uses. See {@link DialogProps.flanks} for why the room is bought
        // here rather than off the panel's edge.
        flanks !== undefined && FLANK_COLUMNS,
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
        //
        // **`trapTab` first and unconditionally**, then whatever the host answers keys with. The
        // trap is half of the `aria-modal` claim directly above, so it may not be made
        // conditional on a prop, on an order, or on a host handler behaving — and it costs
        // nothing to compose, because it reads its panel off `e.currentTarget` rather than out of
        // a ref. A fresh closure per render is fine here: React attaches one listener at the root
        // and the panel re-renders about as often as the dialog opens.
        onKeyDown={(e) => {
          trapTab(e);
          onPanelKeyDown?.(e);
        }}
        // **`max-h-full` is the one height rule, settled 2026-08-16.** The three dialogs folded
        // into this shell arrived carrying `max-h-[85%]` and `max-h-[80%]` against this
        // `max-h-full`, which is three answers to one question — and the percentages are the
        // weaker two, because the scrim above already states the inset as padding
        // (`p-4 sm:p-6`). A percentage of the *padded* box is a second, smaller inset stacked on
        // the first, so the gap a reader sees is the padding plus a fraction of the window and
        // grows with the window: at 800px it is 16 + ~115, at 1400px it is 24 + ~206. One rule —
        // the scrim's padding is the inset, and the panel takes what is left — is a constant gap
        // at every size, which is what the four dialogs already on this shell draw.
        //
        // **And for its first two days it clamped nothing at all** — `100%` of an implicit,
        // auto-sized grid row is `100%` of the panel's own content. The scrim's
        // `grid-rows-[minmax(0,1fr)]` is the other half of this rule and the two only work
        // together; whichever of them is edited next, the panel's height is what the edit is
        // about.
        //
        // **This panel does not clip its content, and something on the shell depends on it now**
        // (2026-08-18). Two of the three dialogs folded in on 2026-08-16 arrived carrying a clip
        // of their own and lost nothing by dropping it, because no body here paints a background
        // out to the rounded corners — the first one that does will square them off on every
        // dialog at once rather than on its own. What has changed is that the absence stopped
        // being merely free: {@link DialogProps.flanks} positions its controls *outside* this
        // box, so an `overflow-hidden` added here would not square a corner, it would delete the
        // printings modal's only pointer affordance for walking the deck. Anything that needs a
        // clip needs it on a box inside the panel.
        //
        // `relative` and `col-start-2` are the flanked case's and are absent otherwise, for
        // {@link DialogProps.flanks}' reason — every other dialog's panel keeps exactly the
        // class string it had. `relative` because the flanks are positioned against *this* box
        // rather than against the scrim, so the pair travels with the panel at every width; the
        // scale tween happens to establish a containing block too, and relying on that would tie
        // a layout to whether an animation is at rest.
        className={cn(
          "flex max-h-full max-w-full flex-col rounded-xl border border-border bg-bg shadow-2xl",
          flanks !== undefined && "relative col-start-2",
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

        {/* The flanks, out over the columns the scrim reserved — **inside the panel's DOM and
            outside its box**, which is the arrangement `trapTab` forces and which
            {@link DialogProps.flanks} spells out. `right-full`/`left-full` rather than a
            negative offset, so the pair is placed by the panel's own edges and follows it as it
            narrows; `top-1/2 -translate-y-1/2` centres each against the panel's height, whatever
            the body inside it turned out to be.

            After the header so a Tab lands on the ✕ first — the way out of a dialog is the stop a
            reader expects to meet first, and these two are navigation within it. */}
        {flanks !== undefined && (
          <>
            <div className="absolute right-full top-1/2 mr-2 -translate-y-1/2">{flanks.left}</div>
            <div className="absolute left-full top-1/2 ml-2 -translate-y-1/2">{flanks.right}</div>
          </>
        )}

        {/* No scroll container here: see this file's doc. The body is the host's, and it brings
            its own `min-h-0 flex-1 overflow-y-auto` and its own padding. */}
        {children}
      </motion.div>
    </motion.div>
  );
}
