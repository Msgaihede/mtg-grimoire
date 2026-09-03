import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { usePopupPlacement } from "@/components/Dropdown/usePopupPlacement";
import { NAV } from "@/components/nav";
import { PopupPanel } from "@/components/PopupListbox";
import {
  SHORTCUTS,
  activeScopes,
  chordParts,
  type Shortcut,
  type ShortcutScope,
} from "@/lib/shortcuts";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/**
 * The button's accessible name and the words the reader is looking for, in one place.
 *
 * `TitleBar` draws the button and this file draws what it opens, so the name would otherwise be
 * written twice in two files with nothing holding them together — and it is the *only* thing
 * naming that button, since a caption button is a glyph with no visible label.
 */
export const KEY_MAP_LABEL = "Keyboard shortcuts";

/**
 * One cap.
 *
 * Mono, because a cap is the legend printed on a key rather than prose — the same face
 * `DeckBracket`'s figures take, at the app's smallest caption size. The **thicker bottom
 * border** is the whole of the flourish: it is a keycap's own shadow drawn in the one border
 * colour this app has, and it costs no token, no shadow and no second decision. Everything
 * else in the panel stays quiet so that the caps are what the eye lands on, which is the only
 * thing anybody opens this panel to find.
 *
 * `h-5 min-w-5` so that `Z` and `1` are squares of the same size and a column of them lines up;
 * `Ctrl` and `Shift` grow past it on their own.
 */
const CAP =
  "inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 " +
  "border-border bg-bg px-1 font-mono text-[0.6875rem] leading-none text-text";

/**
 * A section's caption.
 *
 * The app's own recipe for a small label over a group — `FilterChips`' `FILTER_LABEL` and
 * `PrintingsFilterBar`'s `CAPTION` are the same four utilities. Spelled a third time rather
 * than imported, for `PrintingsFilterBar`'s reason: the alternative is the *window chrome*
 * importing the filter row's module to borrow a font size, which is a dependency nobody would
 * defend if it were proposed the other way round.
 */
const SECTION = "text-[0.6875rem] uppercase tracking-[0.08em] text-dim";

/** What a scope is called on screen. */
function headingFor(scope: ShortcutScope): string {
  if (scope === "global") return "Everywhere";
  // Not a view, and never will be — it is the surface `App.tsx` swaps in place of `DecksPage`.
  if (scope === "deckEditor") return "Deck editor";
  // The rail's own word for the view, so the section a reader is standing in is named with the
  // label they pressed to get there. `NAV` covers every `ViewId`, so the fallback is unreachable
  // and is here only because `find` cannot say so in the type.
  return NAV.find((entry) => entry.id === scope)?.label ?? scope;
}

/**
 * A shortcut's caps: one `<kbd>` per {@link chordParts} entry, and a word between spellings.
 *
 * **Three shapes rather than one, and the third is why the rule is not simply "join with `or`".**
 * One chord draws itself. *Two* are two spellings of one intent — `Ctrl+Y` and `Ctrl+Shift+Z`
 * both redo — so the word between them is `or`. A run *longer* than two is not a list of
 * alternatives a reader picks from; it is a **range** (`switchView` carries six, one per `NAV`
 * entry, and the index is the binding), and drawing all six with `or` five times over would fill
 * the widest row in the panel with an arithmetic sequence. So the ends are drawn and the word is
 * `to`.
 *
 * Both ends are drawn **whole** — `Ctrl` `1` to `Ctrl` `6`, not `Ctrl` `1` to `6` — because
 * collapsing the second chord's modifiers assumes the run shares them, which is true of the one
 * range that exists today and is not a fact this component can check.
 *
 * A word rather than a glyph in both cases: an en dash between two caps is read out as nothing
 * at all by a screen reader, and `1 6` is a different shortcut from `1 to 6`.
 */
function Caps({ shortcut }: { shortcut: Shortcut }) {
  const { chords } = shortcut;
  const range = chords.length > 2;
  const drawn = range ? [chords[0], chords[chords.length - 1]] : chords;
  return (
    <dd className="flex flex-wrap items-center justify-end gap-1">
      {drawn.map((chord, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="px-0.5 text-[0.6875rem] text-dim">{range ? "to" : "or"}</span>}
          {chordParts(chord).map((part) => (
            <kbd key={`${String(i)}-${part}`} className={CAP}>
              {part}
            </kbd>
          ))}
        </Fragment>
      ))}
    </dd>
  );
}

/**
 * The keyboard map: the caption button's panel, and the only surface that says what the app's
 * chords are.
 *
 * **It takes the button as its child rather than a ref to it**, which is what makes the whole
 * thing one box. That box is three things at once and each of them needs it: the rect
 * {@link usePopupPlacement} measures, the subtree an outside click is judged against, and — this
 * is the half that is easy to lose — the element the panel is rendered *inside*, so that the
 * panel follows its own trigger in DOM order. That last one is what makes this a **disclosure**
 * rather than a dialog: a button carrying `aria-expanded` with the revealed content immediately
 * after it needs no `role`, no name of its own and no focus trap, and a reader walking forward
 * from the button arrives in the panel. The alternative — a `ref` threaded down from `TitleBar`
 * — would have meant a second prop on `CaptionButton`, whose whole shape is that it has almost
 * none.
 *
 * **Anchored and `fixed` from measured numbers, never portalled.** The shipped CSP is
 * `style-src 'self'` with `style-src-attr 'unsafe-inline'` beside it: a measured inline `style`
 * is legal and an injected `<style>` element is blank in a packaged build. `align: "end"` so the
 * panel's right edge tracks the button's — it opens 46px from the window's right edge, and any
 * other alignment runs it off the screen.
 *
 * **No `LAYER` rung, and none is missing.** `TitleBar`'s root carries `LAYER.caption`, and
 * a z-index other than `auto` on a flex item creates a stacking context whatever its position —
 * so everything drawn in this subtree, a `fixed` descendant included, is painted at the caption's
 * place in the app-wide order. The frame therefore carries no z-index of its own either: inside
 * that context it is the one positioned element among non-positioned flex items, which already
 * puts it on top. jsdom paints nothing, so this is the one claim here the suite cannot check.
 */
export function KeyMap({ children }: { children: ReactNode }) {
  const open = useAppStore((s) => s.keyMapOpen);
  const setOpen = useAppStore((s) => s.setKeyMapOpen);
  const activeView = useAppStore((s) => s.activeView);
  const openDeckId = useAppStore((s) => s.openDeckId);

  const anchorRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { placement } = usePopupPlacement({
    triggerRef: anchorRef,
    frameRef,
    panelRef,
    open,
    align: "end",
    onClose: () => setOpen(false),
  });

  // The `"outer"` rung: this panel is opened *over* the app, but anything opened over **it** —
  // a dialog, a context menu — is on the capture rung and takes the press first. Enabled on the
  // **flag** rather than mounted with the element, so a panel on its way out through its fade is
  // not still eating Escape.
  useDismissOnEscape({
    layer: "outer",
    enabled: open,
    onDismiss: () => {
      // The caret goes back to the trigger, which is this app's rule for a layer Escape
      // dismissed — and here it is load-bearing rather than tidy: `F1` opens this panel with the
      // caret wherever the reader was, so without the hand-back Escape would leave focus in a
      // wall behind a panel that has just gone. `:scope >` because the trigger is this box's own
      // child and the panel below it is not; `focus()` before the close, while it is still
      // mounted.
      anchorRef.current?.querySelector<HTMLElement>(":scope > button")?.focus();
      setOpen(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      // Closed without moving focus — `Dropdown`'s rule, and this app's: the reader who pressed
      // somewhere else is already somewhere else. The box is the guard rather than the panel,
      // so a press on the trigger falls through to the button's own toggle instead of being
      // closed here and re-opened by the click.
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open, setOpen]);

  return (
    <div ref={anchorRef} className="flex h-full">
      {children}

      <AnimatePresence>
        {open && (
          // The key belongs on `AnimatePresence`'s own direct child — `Dropdown`'s note, and the
          // same shape. The frame is the zero-size `fixed` box `usePopupPlacement` measures, so
          // that whatever containing block this landed in is subtracted rather than guessed at.
          <div key="panel" ref={frameRef} className="fixed left-0 top-0 size-0">
            <PopupPanel
              ref={panelRef}
              style={{ left: placement?.left ?? 0, top: placement?.top ?? 0 }}
              className={cn(
                "absolute w-96 rounded-lg border border-border bg-surface p-3 text-text shadow-lg",
                // Pinned by the corner it grows from. All four written out whole: Tailwind scans
                // source text, so a class built by interpolation emits no rule at all.
                placement?.flipY
                  ? placement.flipX
                    ? "origin-bottom-right"
                    : "origin-bottom-left"
                  : placement?.flipX
                    ? "origin-top-right"
                    : "origin-top-left",
                // Invisible for the one frame before the panel's own size exists.
                placement === null && "invisible",
              )}
            >
              {activeScopes({ activeView, openDeckId }).map((scope) => {
                const rows = SHORTCUTS[scope];
                // **A scope with nothing in it draws nothing — not a heading over a gap.** Five
                // of the six views are in that state today, and that is the honest answer rather
                // than a page whose section is "coming soon": what a reader on the search page
                // can press is exactly what `Everywhere` lists.
                if (rows.length === 0) return null;
                return (
                  <Fragment key={scope}>
                    <h2 className={cn(SECTION, "mt-3 mb-1.5 first:mt-0")}>{headingFor(scope)}</h2>
                    {/* Two columns rather than a row of `justify-between`: the caps then line up
                        down one edge across the whole section, which is what turns a list into
                        something scannable. A label wraps inside its own column; nothing
                        truncates, because the label is the thing being looked for. */}
                    <dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1.5">
                      {rows.map((row) => (
                        <Fragment key={row.id}>
                          <dt className="text-sm">{row.label}</dt>
                          <Caps shortcut={row} />
                        </Fragment>
                      ))}
                    </dl>
                  </Fragment>
                );
              })}
            </PopupPanel>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
