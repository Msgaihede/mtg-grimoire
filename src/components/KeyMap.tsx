import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { usePopupPlacement } from "@/components/Dropdown/usePopupPlacement";
import { NAV } from "@/components/nav";
import { PopupPanel } from "@/components/PopupListbox";
import { QuerySyntaxHelp } from "@/components/QuerySyntaxHelp";
import { FOCUS_INSET } from "@/lib/focus";
import { isDesktop } from "@/lib/platform";
import {
  SHORTCUTS,
  activeScopes,
  chordParts,
  shownOn,
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

/** Which half of the panel is on screen. */
type KeyMapTab = "shortcuts" | "syntax";

/**
 * The two halves, in the order they are drawn and walked.
 *
 * Written out rather than derived, for the reason `DeckSearchPanel`'s strip gives: a
 * `text-transform` changes what is *drawn* and not what a control is **called**, so a label a
 * reader has to ask for by voice must be spelled in the case they would say it in (WCAG 2.5.3).
 * `Shortcuts` first because that is what `F1` is for — the syntax tab is the thing a reader
 * comes to the panel for second.
 */
const TABS = [
  { id: "shortcuts", label: "Shortcuts" },
  { id: "syntax", label: "Search syntax" },
] as const satisfies readonly { id: KeyMapTab; label: string }[];

/** A tab's id and its panel's, paired so the `aria-controls` hop cannot be spelled two ways. */
const tabDomId = (tab: KeyMapTab) => `keymap-tab-${tab}`;
const panelDomId = (tab: KeyMapTab) => `keymap-panel-${tab}`;

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
 * **Two shapes, and the catalogue says which — this does not work it out.** Chords are ordinarily
 * spellings of one intent, so the word between them is `or`: `Ctrl+Y` and `Ctrl+Shift+Z` both
 * redo, and a reader presses whichever their hands know. An entry that declares
 * {@link Shortcut.range} is a contiguous run instead, so only its ends are drawn and the word is
 * `to` — `switchView` carries nine, one per `NAV` entry, and drawing all nine with `or` eight
 * times over would fill the widest row in the panel with an arithmetic sequence.
 *
 * **The flag, never `chords.length`.** Counting was right for exactly as long as `switchView` was
 * the only multi-chord entry with more than two: a count cannot tell nine steps of a sequence
 * from three genuine alternatives, so the first shortcut written with three spellings would have
 * drawn "`A` **to** `C`" — a promise about a chord nothing binds, in the one panel whose whole job
 * is to be true.
 *
 * Both ends are drawn **whole** — `Ctrl` `1` to `Ctrl` `9`, not `Ctrl` `1` to `9` — because
 * collapsing the second chord's modifiers assumes the run shares them, which is true of the one
 * range that exists today and is not a fact this component can check.
 *
 * A word rather than a glyph in both cases: an en dash between two caps is read out as nothing
 * at all by a screen reader, and `1 8` is a different shortcut from `1 to 8`.
 *
 * **The whitespace between the caps is text, not the `gap`, and that is what the row is read out
 * with.** Adjacent inline elements with nothing between them concatenate when their text is
 * flattened — this repo has already paid for that once, with a label and its count in two spans
 * computing to `Missing2` — so caps separated only by `gap-1` say `Ctrl1toCtrl9` to a screen
 * reader while looking correct to everyone else. A text node fixes it at no visual cost: a
 * sequence of child text runs that is *only* white space is not rendered by a flex container and
 * becomes no flex item (CSS Flexbox §4), so the drawn row is unchanged to the pixel. An
 * `aria-label` on the `<dd>` would have been the other way, and is worse twice over — `<dd>` maps
 * to `definition`, a role browsers do not agree takes an author's name, and the label would be a
 * second spelling of the caps built by joining the same parts, free to drift from the ones drawn.
 * **jsdom has no layout engine**, so the suite can pin the reading and only a browser can confirm
 * the row did not move.
 *
 * **Exported for its own test.** The catalogue holds no multi-chord entry that is *not* a range —
 * that is the case the flag exists for and the case a count got wrong — so pinning the `or` shape
 * over three chords means constructing one, and the alternative is a fake row in the catalogue
 * that the panel would then draw for real readers.
 */
export function Caps({ shortcut }: { shortcut: Shortcut }) {
  const { chords, range = false } = shortcut;
  const drawn = range ? [chords[0], chords[chords.length - 1]] : chords;
  return (
    <dd className="flex flex-wrap items-center justify-end gap-1">
      {drawn.map((chord, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              {" "}
              <span className="px-0.5 text-[0.6875rem] text-dim">{range ? "to" : "or"}</span>
            </>
          )}
          {chordParts(chord).map((part) => (
            <Fragment key={`${String(i)}-${part}`}>
              {" "}
              <kbd className={CAP}>{part}</kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </dd>
  );
}

/**
 * The panel's contents: the tab bar and whichever half it selects.
 *
 * **A component of its own because that is what makes the reset structural.** The tab has to go
 * back to `Shortcuts` when the panel closes — a reader who opened `F1` for a chord should find
 * chords, whatever the last person to open it was looking up — and the cheapest way to say that
 * is to put the state in something that *stops existing* when the panel does. `AnimatePresence`
 * unmounts this with the frame, so the reset is the element going away rather than an effect
 * watching a flag. An effect would also have been a lint failure rather than a style
 * preference: `react-hooks`' `set-state-in-effect` refuses a `setState` in an effect body, and
 * it is refused for exactly the reason that matters here — the state does not need to be
 * synchronised with `open`, because it does not need to outlive it.
 *
 * The one seam is a close and a re-open **inside the fade**, where `AnimatePresence` reverses
 * the element it still holds and the tab survives with it. That is a gesture round trip of
 * about 120ms and the reader is looking at the tab they just left, so it is left alone rather
 * than papered over with a key that would swap the panel's contents mid-fade.
 *
 * It also takes the two store reads, which `KeyMap` itself no longer needs: only the shortcuts
 * half asks where the reader is standing.
 */
function KeyMapTabs() {
  const activeView = useAppStore((s) => s.activeView);
  const openDeckId = useAppStore((s) => s.openDeckId);
  const [tab, setTab] = useState<KeyMapTab>("shortcuts");
  const barRef = useRef<HTMLDivElement>(null);

  /**
   * The arrows walk the pair, and the selection follows the caret.
   *
   * **`role="tab"` is a contract rather than a name, and this is the half of it that is easy to
   * leave out** — `DeckSearchPanel`'s strip settles for `aria-pressed` precisely to avoid owing
   * this. Taking the role means owing it: one tab stop for the pair (the roving `tabIndex`
   * below), `ArrowLeft`/`ArrowRight` between them, `Home`/`End` to the ends, and the panel
   * changing with the caret. A `tab` role with no keyboard behaviour announces a contract the
   * control does not keep, which is worse than no role at all.
   *
   * Automatic activation — the panel follows the arrow rather than waiting for `Enter` — is the
   * APG default for tabs whose panels cost nothing to draw, and both of these are already in
   * the reader's hands.
   *
   * **Exact modifiers**: a bare `ArrowRight` is the chord, so `Ctrl+ArrowRight` falls through to
   * whatever else the app does with it rather than being swallowed here. `shortcuts.ts`'
   * `matchesChord` rule, applied to a control that does not read the catalogue.
   */
  function onTabKeys(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const at = TABS.findIndex((entry) => entry.id === tab);
    const to =
      e.key === "ArrowRight"
        ? (at + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (at - 1 + TABS.length) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : -1;
    if (to === -1) return;
    // `Home` and `End` scroll a page by default, and the arrows scroll a scrollable panel.
    e.preventDefault();
    const next = TABS[to].id;
    setTab(next);
    // The caret moves with the selection, which is what "roving" means: the tab losing it is
    // about to become `tabIndex={-1}`, and a caret left on an untabbable element is a `Tab`
    // that restarts from the top of the app. Both buttons are already mounted, so this lands.
    barRef.current?.querySelector<HTMLElement>(`#${tabDomId(next)}`)?.focus();
  }

  return (
    <>
      {/* Full-bleed across the panel's own `p-3`, so the hairline is one line across the panel
          with a lit segment in it rather than a rule floating inside a margin — `TabStrip`'s
          shape in the deck editor, which is this app's one vocabulary for a tab bar. The panel
          is `rounded-lg` and clips nothing, and the bar has no fill of its own, so pulling it
          to the edges costs the corners nothing. */}
      <div
        ref={barRef}
        role="tablist"
        // Named for what the pair picks between. The button that opened this is called
        // `Keyboard shortcuts`, so a reader stepping in hears what else is in here.
        aria-label="Reference"
        className="-mx-3 -mt-3 mb-3 flex border-b border-border"
      >
        {TABS.map(({ id, label }) => {
          const on = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={tabDomId(id)}
              aria-selected={on}
              // **Only the selected tab names a panel, because only its panel is drawn.** The
              // inactive half is not rendered at all — a `hidden` twin would still be in the
              // tree for `getByText` and for anything else reading the document rather than the
              // accessibility tree — so an `aria-controls` on both would leave one of them
              // pointing at an id that is not there.
              aria-controls={on ? panelDomId(id) : undefined}
              tabIndex={on ? 0 : -1}
              onClick={() => {
                setTab(id);
              }}
              onKeyDown={onTabKeys}
              className={cn(
                // 28px: this is chrome on a 384px panel whose own rows are `text-sm`, not a
                // toolbar press. `min-w-0 flex-1` makes each tab half the bar, so the lit rule
                // is half the hairline and the target is where the pointer already is.
                "h-7 min-w-0 flex-1 text-xs",
                // Drawn transparent when the tab is off rather than left off, or the word would
                // move up two pixels every time the reader switched. `-mb-px` pulls it over the
                // row's own hairline so the two are one line.
                "-mb-px border-b-2",
                "transition-colors duration-150 motion-reduce:transition-none",
                on
                  ? "border-accent font-medium text-accent"
                  : "border-transparent text-dim hover:text-text",
                // Inset, and that reverses `TabStrip`'s choice for a reason of geometry rather
                // than taste: these two are flush with the panel's own edges, so an outline
                // standing 2px *off* the outer tab would be drawn outside the panel's border.
                FOCUS_INSET,
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === "shortcuts" ? (
        <div role="tabpanel" id={panelDomId("shortcuts")} aria-labelledby={tabDomId("shortcuts")}>
          {activeScopes({ activeView, openDeckId }).map((scope) => {
            // Filtered with the same answer `AppShell` binds against, so a row for something
            // this build cannot do — a second window, on a phone or in a tab — is neither
            // listed nor bound, rather than listed and dead. **Nothing reaches this branch
            // off the desktop today**: this panel's one mount is `TitleBar`, which is itself
            // desktop-only. The filter is what keeps the rows honest the day the panel is
            // drawn anywhere else, and it belongs here rather than at that mount because
            // this is the component that reads the catalogue.
            const rows = SHORTCUTS[scope].filter((row) => shownOn(row, isDesktop()));
            // **A scope with nothing in it draws nothing — not a heading over a gap.** All
            // nine views are in that state today — `deckEditor` is a scope of its own and
            // *replaces* `decks` rather than filling it — and that is the honest answer
            // rather than a page whose section is "coming soon": what a reader on the
            // search page can press is exactly what `Everywhere` lists.
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
        </div>
      ) : (
        // **The cap goes on the tab panel and never on the frame**, which is what
        // `usePopupPlacement` measures: a `max-h` up there would bound the box the placement
        // is computed from and the panel would be positioned against a height it does not
        // have. Here it also keeps the tab bar still while the list moves, which is the
        // better reading of the two anyway.
        //
        // `tabIndex={0}` because this panel scrolls and holds nothing focusable, which is the
        // exact pair APG names — without it a reader on the keyboard cannot reach the bottom
        // of the list (WCAG 2.1.1). The shortcuts half deliberately does **not** take one: it
        // does not scroll, and a focusable ancestor there would swallow the press on a `<kbd>`
        // that `KeyMap`'s Escape rescue is written for.
        <div
          role="tabpanel"
          id={panelDomId("syntax")}
          aria-labelledby={tabDomId("syntax")}
          tabIndex={0}
          // `scrollbar-slim` because this is the case that class was written for — a scroll
          // area **inside** a panel, where 15px of opaque platform gutter down the side of a
          // 358px list reads as a second window. It is worth 5px of the row as well: the table
          // below is laid out against what is left after the bar.
          className={cn("scrollbar-slim max-h-[60vh] overflow-y-auto", FOCUS_INSET)}
        >
          <QuerySyntaxHelp />
        </div>
      )}
    </>
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
      // dismissed — **and the question the condition asks is whether the caret has anywhere to
      // go, not where the panel is.** Two states want the hand-back and they are not the same
      // state: the caret is in this box, so the thing holding it is about to be closed; or the
      // caret is *nowhere*, which is what a browser leaves behind when whatever held it stopped
      // being focusable — here, a press on the panel's own text, none of which is. Both would
      // otherwise end on `<body>`, and a caret on `<body>` is the next Tab restarting from the
      // top of the app.
      //
      // **What the condition is for is the third state**, which is the one an unconditional
      // `focus()` got wrong: `F1` opens this panel and moves *nothing*, so a reader typing in
      // the deck editor's quick-add box is still in that field, with the caret in no danger at
      // all — and taking them to the caption row is a layer handing back a caret it never took.
      // `useFolderFieldReturn`'s rule, met from the other side: it restores on exactly this
      // "null or `<body>`" reading, because the element it would hand back to has been replaced.
      //
      // `:scope >` because the trigger is this box's own child and the panel below it is not;
      // `focus()` before the close, while it is still mounted.
      const box = anchorRef.current;
      const caret = document.activeElement;
      const nowhere = caret === null || caret === document.body;
      if (nowhere || box?.contains(caret) === true) {
        box?.querySelector<HTMLElement>(":scope > button")?.focus();
      }
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
              <KeyMapTabs />
            </PopupPanel>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
