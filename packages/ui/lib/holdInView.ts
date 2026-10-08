/**
 * How long a landing is held, at most. The re-check's slowest cold landing settled in ~1.6s with
 * its three Sync reads delayed by 1.5s on purpose; unforced it settled within a few frames. Three
 * seconds covers a read that waits on the write lock without leaving a panel pinned while a reader
 * sits and reads it — and any gesture of theirs ends it sooner.
 */
export const HOLD_IN_VIEW_MS = 3000;

/** A reader taking the page back. `pointerdown` covers a click and a press on the scrollbar,
 *  `keydown` a keyboard scroll, `wheel` and `touchstart` the rest. */
const READER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Keep an element at the top of its scroller while the layout around it settles — and let go the
 * moment the reader does anything, or after a short window, whichever comes first.
 *
 * **Why one scroll is not enough.** A page that lands a reader on one of its panels scrolls that
 * panel into view on the commit that draws it, and on a first visit that is too early: the panels
 * above it are still waiting on their reads, the page is too short to scroll at all, and when they
 * land they push the panel down again. Measured in the shipped window (2026-09-26, debug build,
 * 1920×1080): Settings landed on Needs review with nothing to scroll, the Sync panel above it grew
 * 437 → 754 → 824px as its reads answered, and the Needs review heading ended at y=976 with its
 * first row at 1175 — below the fold, exactly where the landing was meant to fix. With the Sync
 * reads already cached the same landing was right (heading at y=504), which is why only a cold visit
 * shows it. Browser scroll anchoring cannot help: it holds a position the page has already
 * scrolled to, and from `scrollTop` 0 there is none.
 *
 * **So the element is aligned again every time something it watches changes size** — a
 * `ResizeObserver` on the element and on the boxes the caller names (the page root, which grows as
 * anything above the element does). `scrollIntoView({ block: "start" })` is idempotent, so a
 * resize that moved nothing costs nothing.
 *
 * **It never fights the reader.** The first wheel, touch, press or key anywhere in the window ends
 * the hold for good, listened for on the capture phase so no handler on the way can stop it
 * reaching here: a reader who has started scrolling, clicking or typing has taken the page back,
 * and a panel that yanked itself to the top under their hand would be the worse bug. The
 * `pointerdown` that pressed the scrollbar is one of those. It does not listen for `scroll`,
 * because its own `scrollIntoView` fires those. And it lets go by itself after
 * {@link HOLD_IN_VIEW_MS}, so a panel that never settles is not held for the rest of the visit.
 *
 * `scrollIntoView` is called optionally: jsdom implements no layout and does not define it
 * (`SettingsPage`'s `pickGroup` has the same `?.()` and the same reason). Where `ResizeObserver` is
 * missing the hold is the one alignment and the window.
 *
 * @returns the release, idempotent — for a caller that unmounts or lands somewhere else.
 */
export function holdInView(
  target: Element,
  watch: readonly Element[] = [],
  ms: number = HOLD_IN_VIEW_MS,
): () => void {
  const view = target.ownerDocument.defaultView ?? window;
  const align = () => target.scrollIntoView?.({ block: "start" });
  let released = false;
  let observer: ResizeObserver | undefined;

  const release = () => {
    if (released) return;
    released = true;
    observer?.disconnect();
    // Declared below, and set before anything here can call this: the listeners and the observer
    // cannot fire between being attached and the timer being started.
    clearTimeout(timer);
    for (const type of READER_EVENTS) view.removeEventListener(type, release, true);
  };

  align();
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (!released) align();
    });
    for (const el of [target, ...watch]) observer.observe(el);
  }
  for (const type of READER_EVENTS) {
    view.addEventListener(type, release, { capture: true, passive: true });
  }
  const timer = setTimeout(release, ms);
  return release;
}
