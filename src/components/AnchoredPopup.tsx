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
 * in here that is a *scrolling* decision rather than a focus one.** See {@link Panel} — the
 * caret goes in at once and the scroll waits for the tween to finish, because a scroll computed
 * against a box that is still 4% short cannot be corrected by asking for more of it.
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

  // The innermost open layer: capture phase, and the press is consumed so the layer underneath
  // does not close on the same one — the card detail modal, when this popup is opened from its
  // action row. See `useDismissOnEscape` — and note that two
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
  // **`preventScroll`, and the scroll is done separately once the panel has finished growing.**
  // Focusing an element scrolls it into view, and this effect runs on the render that mounts it —
  // while `popup` still has it at `initial: { scale: 0.96 }` with a top origin, so the browser
  // computes that scroll against a box 4% shorter than the one that ends up on screen, and every
  // pixel of the difference is at the **bottom**. Nothing scrolls again once the tween ends, so
  // the scroller clips exactly that much, permanently.
  //
  // The caret still moves on the very first render, which is what the keyboard hand-off needs:
  // a reader who presses Enter and then Tab immediately must find the panel's own controls next,
  // and a focus deferred to the end of a 180ms tween would send that Tab into the list behind.
  // `CardGrid`'s walk splits the same press the same way and for the same kind of reason.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * The scroll the focus above did not do — run once the entry tween has put the panel at
   * `scale: 1`, which is the first moment the box being scrolled to is the box on screen.
   *
   * **This replaced a `scroll-mb-4` on the panel, and the replacement is not a refinement of it:
   * no scroll margin can work here.** A margin only ever asks the browser to scroll *further*,
   * and the browser clamps at the scroller's maximum — which the scaled panel is itself what
   * caps. Measured in the shipped window on 2026-08-22: applying `scale(0.96)` with a top origin
   * to the open panel drops the scroller's `scrollTop` maximum from **257 to 246**, and 246 is
   * exactly where the focus scroll landed; raising the margin from 16px to **400px** moved that
   * landing not at all — byte-identical, 246, and the same 10.5px of panel lost. The panel is not
   * too tall for the scrollport either (431px to spare at 1920×1080, 37px at 1280×800): the
   * scroll simply stopped 11px short of a maximum that was wrong while it ran.
   *
   * **`onAnimationComplete` and not a timer**, because the number to wait for is the tween's and
   * belongs to the preset rather than to this file. It fires for the *exit* as well, hence the
   * `present` guard — a panel on its way out has already handed the caret back, and scrolling to
   * it would drag the list under whatever the reader moved on to.
   *
   * **Reduced motion is covered by the callback rather than around it.** Nothing in `popup`
   * branches on the preference; the one `MotionConfig` in `App.tsx` does, and it reduces the
   * transform keys by applying them instantly while `opacity` still tweens — so the panel is at
   * full scale sooner and this still runs when the animation as a whole finishes. The callback is
   * what fires on **every** path, including the one where there was nothing to animate, which is
   * why the scroll hangs off it rather than off a `useReducedMotion()` branch that would have to
   * predict which of the two paths it is on.
   *
   * The optional call is jsdom's — it implements neither scrolling nor layout — and it is also
   * why **nothing in the suite can go red for the geometry**. The suite can pin that the scroll
   * happens after the tween and not during it; only a live pass can say where the panel lands.
   */
  const settle = useCallback(() => {
    if (!present) return;
    panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [present]);

  return (
    <motion.div
      {...popup}
      onAnimationComplete={settle}
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
        // **No scroll margin here, and its absence is a finding rather than an omission.** A
        // `scroll-mb-4` stood on this panel from 2026-08-22 until later the same day, on the
        // reading that the clipped 4% was an overhang to leave room for — `DROP_MARK_ROOM`'s
        // twin. The diagnosis was right to the pixel and the cure was inert: a scroll margin asks
        // the browser to scroll *further*, and what was wrong was the **maximum** it clamps to,
        // which the scaled panel sets. Overriding the margin to 400px changed the landing
        // `scrollTop` by nothing at all. The scroll is deferred instead — see {@link settle}.
        //
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
        // No focus outline: a landing pad, not a control — `tabIndex={-1}` only so the caret has
        // somewhere to go while the popup is open, and neither Tab nor an arrow reaches the
        // panel itself. Its trigger and its own contents keep theirs. `src/lib/focus.ts` has
        // the rule and all ten sites.
        panelClassName,
      )}
    >
      {children}
    </motion.div>
  );
}
