import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/**
 * A small square control on a card or a row, and the panel it opens beside itself.
 *
 * Two controls in this app are this shape — the search wall's quick-add and the wishlist's
 * edit — and everything in here is what they had built twice: the anchoring, the two ways the
 * panel closes, and the four attributes that keep a fading panel from lying to a screen reader.
 * The *contents* are the caller's and have nothing in common, which is why this owns the shell
 * and nothing else.
 *
 * ## What the shell is actually for
 *
 * **Anchored, not portalled.** The shipped CSP is `style-src 'self'` and every overlay primitive
 * in reach injects a runtime `<style>` the moment it opens — fine under `tauri dev`, blank in a
 * packaged build. Same decision as `SetCombobox`. Not `aria-modal` either: the list behind it
 * stays live, and a dialog that claims the page is inert while it demonstrably is not is worse
 * than no dialog at all.
 *
 * **It closes two ways and they must not race.** Escape goes through the app's one dismissal
 * ladder and hands the caret back to the trigger — an element that disappears with focus on it
 * drops the caret to `<body>`, and the next Tab restarts from the top of the app. Focus leaving
 * the root closes it too, which covers clicking outside without a window listener that could
 * fight the handshake; the boundary is the whole control rather than the panel, because on
 * `relatedTarget` being the trigger — a second press, or Escape's hand-back — closing there
 * would race the toggle and leave the panel open forever.
 *
 * **The caret moves into the panel while the panel is still growing, and that is the one thing
 * in here that is a *scrolling* decision rather than a focus one.** See {@link Panel}'s
 * `scroll-mb-4`, which is `DROP_MARK_ROOM`'s twin: room for something drawn outside the box the
 * scroll was computed for.
 *
 * **The panel outlives `open` by the length of its fade**, which is what the last two guards are
 * about: `aria-hidden` and `pointer-events-none` from the render that starts the exit, so what
 * is on its way out is a picture rather than a second copy of the caller's form in the
 * accessibility tree. The Escape rung is registered on the flag rather than on the element for
 * the same reason — a rung that came down with the element would still be eating Escape while
 * the reader is somewhere else.
 */
export function AnchoredPopup({
  label,
  panelLabel,
  icon,
  align = "end",
  className,
  panelClassName,
  children,
}: {
  /**
   * The trigger's accessible name — a whole sentence naming the card, not the verb.
   *
   * Forty of these on a wall are forty different cards, and "Add" is the same word on all of
   * them; a screen reader hears a list of identical buttons unless the name says which card and
   * which list. The visible glyph carries no text at all, so this is the only name there is.
   */
  label: string;
  /** The panel's own accessible name, announced when the caret moves into it. */
  panelLabel: string;
  /** What the trigger draws — one lucide icon, already sized by the caller. */
  icon: ReactNode;
  /**
   * Which edge of the panel is pinned to the trigger. `"end"` where the trigger sits at the
   * right of a wide row, so the panel opens back across it; `"start"` in a card wall, where the
   * anchor is a 170px caption and a panel opening leftwards off the first column would be
   * clipped by the scroller — left overflow, unlike right, cannot be scrolled back into view.
   */
  align?: "start" | "end";
  /** On the root, so a caller can hand it the wall's reveal-on-hover recipe. */
  className?: string;
  /** On the panel — its width, and the layout of whatever the caller puts in it. */
  panelClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const dismiss = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // The innermost open layer: capture phase, and the press is consumed so the card detail pane
  // underneath does not close on the same one. See `useDismissOnEscape` — and note that two
  // "inner" peers are *not* ordered by it, so this and the set picker must never be open at
  // once. Each closes when focus leaves its own root, and opening either moves focus into it,
  // which closes the other on the way.
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  return (
    <span
      ref={rootRef}
      // **A press in here is a press, never a drag of what this sits on.** The surfaces this
      // appears on are drag sources, and Chromium starts a drag from the nearest draggable
      // *ancestor* of whatever was pressed — so without the mark a press on the trigger that
      // travelled five pixels would carry the card off and never open the panel at all. Marked
      // here rather than at each call site because it is this control's own fact, which is what
      // `dnd.ts`'s rule asks for: anything that owns its own press marks itself.
      data-no-drag=""
      // `open` last, so an open panel outlives the hover that revealed its trigger.
      className={cn("relative inline-flex", className, open && "opacity-100")}
      // **The `open &&` is doing a second job.** An exiting panel is still inside this root, so
      // focus leaving it during the fade fires this handler again — and the flag is already
      // false by then, which is what makes that press a no-op rather than a second close racing
      // whatever the reader has moved on to.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        // **24px and 14px are this trigger's size at 100% zoom, on a card.** Several surfaces
        // draw it and only the walls zoom, where it sits beside a rarity gem and a set code that
        // grow with the card — a button that held still was the one thing in that strip out of
        // step with the rest. `--control-scale` is the tile's own factor (`lib/cardZoom.ts`),
        // already reduced by `CONTROL_SHRINK` for being drawn on a card; a table row and the
        // card pane set no such variable and take the `, 1` fallback, so both are exactly the
        // 24px they have always been.
        className={cn(
          "grid size-[calc(1.5rem*var(--control-scale,1))] shrink-0 place-items-center",
          "rounded-md border border-border text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        {icon}
      </button>
      <AnimatePresence>
        {open && (
          <Panel panelLabel={panelLabel} align={align} panelClassName={panelClassName}>
            {children}
          </Panel>
        )}
      </AnimatePresence>
    </span>
  );
}

/**
 * The panel itself — its own component so the caller's contents mount and unmount with it, which
 * is what resets whatever state they hold between two openings.
 */
function Panel({
  panelLabel,
  align,
  panelClassName,
  children,
}: {
  panelLabel: string;
  align: "start" | "end";
  panelClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** False from the render that starts the fade out. */
  const present = useIsPresent();

  // The caret moves into the layer, as it does for the card pane and the set picker: the panel's
  // own controls are then the next thing Tab reaches, focus leaving it is what closes it, and
  // Escape has something to hand back.
  //
  // **This focus is also a scroll**, which is the half that bit — see the `scroll-mb-4` below.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <motion.div
      {...popup}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={panelLabel}
      // On the way out it is a picture and nothing else: not pressable, and not a second copy of
      // the caller's form in the accessibility tree. The caret has already gone back to the
      // trigger (Escape) or moved on somewhere else (a click), so nothing focused is being
      // hidden here.
      aria-hidden={present ? undefined : true}
      className={cn(
        "absolute top-7 rounded-lg border border-border bg-surface p-3 text-left shadow-lg",
        // **Room for the 4% this panel has not grown yet.**
        //
        // Focusing an element scrolls it into view, and the effect above runs on the render that
        // mounts it — while `popup` still has it at `initial: { scale: 0.96 }` and
        // `origin-top-*`, so the box the browser scrolls for is 4% shorter than the box that ends
        // up on screen, and every pixel of that difference is at the **bottom**. The scroller then
        // clips exactly that much, permanently, because nothing scrolls again once the tween ends.
        //
        // Measured in the shipped window (2026-08-22, both 1280x800 and 1920x1080): the wishlist's
        // edit panel rendered **bottomless** — its bottom 8.5px gone, taking the 12px of padding,
        // the 1px border and the 10px radius with it — and 8.5px is 4% of the 212px this panel
        // ends up at. Identical at both window sizes, because a fixed-width panel's height does
        // not depend on the window. Scrolling to the very bottom by hand revealed it (1058.5
        // against a 1060 clip), which is what says the scroller had the room all along and the
        // scroll simply stopped short.
        //
        // **This is `DROP_MARK_ROOM`'s twin** (`src/lib/dropMarks.ts`, and the rule in
        // `src/CLAUDE.md`): that constant is padding on a scroller for a mark drawn outside a
        // target's border box *at rest*, and this is a scroll margin for the same kind of overhang
        // *at the moment something scrolls to it*. `CardGrid`'s tile carries `scroll-m-1.5` for
        // its focus ring for exactly this reason. It goes here rather than on a caller, because
        // both halves of the cause are the shell's: the shell picked the preset that scales, and
        // the shell is what moves the caret.
        //
        // 16px rather than the measured 8.5: the overhang is 4% of the panel's *own* height, so a
        // number matched to today's 212px panel would be short the day one grows. This covers a
        // panel up to 400px, and it costs a panel that needs none of it nothing at all — a scroll
        // margin only ever asks the browser to scroll further, and the browser clamps at the end
        // of the scroller.
        //
        // **jsdom implements neither scrolling nor layout, so nothing in the suite can go red for
        // this**; the numbers above come from a live pass and the next one is what re-checks it.
        "scroll-mb-4",
        // Only ever effective against this panel's *siblings*: on a table row or a grid row the
        // anchor is inside a transformed element, which caps everything in it at that row's own
        // layer. See `LAYER`.
        LAYER.popup,
        align === "start" ? "left-0" : "right-0",
        // The corner the panel is pinned by is the corner it grows from — `popup` leaves the
        // origin to its consumer precisely because only the consumer knows which edge it hung
        // itself off. Both spellings written out whole: Tailwind scans source text, so a class
        // built by interpolation emits no rule at all.
        align === "start" ? "origin-top-left" : "origin-top-right",
        !present && "pointer-events-none",
        FOCUS,
        panelClassName,
      )}
    >
      {children}
    </motion.div>
  );
}
