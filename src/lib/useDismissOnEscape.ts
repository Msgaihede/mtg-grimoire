import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

/**
 * Which rung of the dismissible stack a layer sits on.
 *
 * `"inner"` is anything opened *over* something else that Escape could also close — a
 * popup, a listbox, a menu, and every {@link import("@/components/Dialog").Dialog} in the app.
 * `"outer"` is what it was opened over: `KeyMap`'s shortcuts panel today, and whatever else ends
 * up drawn beside a view rather than over it. It was the docked card detail pane until
 * 2026-09-03, when that surface became a `Dialog` and moved to the rung above.
 *
 * `"navigation"` is the floor — not a layer drawn over anything, but the view itself, and the
 * press it takes is the one nothing else wanted. It is what makes Escape mean "back" all the way
 * down rather than only as far as the last popup: a deck closes to the gallery, a folder closes
 * to its parent. A rung below `"outer"` on purpose — a panel open beside a folder is still
 * the nearer thing to close, so it gets the press and the folder gets the next one.
 */
export type DismissLayer = "inner" | "outer" | "navigation";

/**
 * How near the reader a rung is. Higher acts first; the press falls to the next one down.
 *
 * Only the two bubble-phase rungs need this — `"inner"` is ordered by the phase itself and by
 * {@link captureStack}, and its entry here exists so the map is total rather than because
 * anything reads it.
 */
const RANK: Record<DismissLayer, number> = { inner: 2, outer: 1, navigation: 0 };

/**
 * The capture-phase layers currently listening, innermost last.
 *
 * **The depth this hook's doc has always owed.** Two `window` capture listeners for one event
 * run in *registration* order, which was survivable while at most one `"inner"` layer was ever
 * open and stopped being survivable when a context menu became a thing that opens *over* an
 * already-open dialog.
 *
 * What that did instead of ordering them is worth stating exactly, because this hook's doc got
 * it wrong until now and the wrong version is the reassuring one. It did **not** close both:
 * the capture rung checks `defaultPrevented` as well, so the *first-registered* peer consumed
 * the press and the newer one — the thing the reader had just opened, the thing on top — was
 * starved. Measured on the pre-fix hook, 2026-08-14, dispatching at `window` and at an element:
 * `{ first: 1, second: 0 }` either way. So a menu over a dialog would have closed the *dialog*,
 * out from under the menu still on screen.
 *
 * A token per registration rather than the callback itself: two layers may legitimately share
 * one `onDismiss` identity (a memoised close handed to a pair of popups), and a stack keyed on
 * the function would then pop the wrong one.
 *
 * **Mount order is the only thing that moves a layer on this stack**, which is what the stack
 * has to mean for the top of it to be the innermost open thing. That is why `onDismiss` is
 * latched in a ref below rather than depended on — see the hook's own doc.
 *
 * Module-level and therefore shared across a test file's renders — `captureStack.length = 0` is
 * not needed in a teardown, because every entry is removed by its own effect cleanup.
 */
const captureStack: symbol[] = [];

/**
 * The bubble-phase layers currently listening, in mount order, each carrying its rung's
 * {@link RANK}.
 *
 * **The same fix as {@link captureStack}, arriving on the other side of the event for the same
 * reason.** While `"outer"` had exactly one occupant in the whole app — the docked card detail
 * pane, at the time this was written —
 * registration order was a question nobody could get wrong. `"navigation"` makes that false: a
 * view is mounted long *before* a panel that opens beside it, so in registration order the
 * view's listener runs first, and a reader with a card open would press Escape and have the
 * folder walk out from under the pane still on screen. That is the pane's own bug from
 * 2026-08-14 read backwards, and the cure is the same shape.
 *
 * Rank rather than depth, because these two rungs are not nested: an `"outer"` layer is not drawn
 * *inside* the view, it is drawn beside or over it, and there is no mount order that makes "the
 * nearer thing"
 * true. So the rungs are ordered by what they are rather than by when they arrived, and mount
 * order breaks ties among peers — which is what a second `"outer"` would need the day one exists.
 *
 * Module-level for {@link captureStack}'s reason, and emptied the same way: by each entry's own
 * effect cleanup, never by a teardown.
 */
const bubbleStack: { token: symbol; rank: number }[] = [];

/**
 * Which bubble-phase layer owns the press: the highest rung, and among equals the one mounted
 * last.
 *
 * `>=` rather than `>` is the whole of that second clause — a later peer of equal rank replaces
 * the one before it, so two `"outer"` layers behave like the capture stack does.
 */
function bubbleOwner(): symbol | undefined {
  let top: { token: symbol; rank: number } | undefined;
  for (const entry of bubbleStack) {
    if (top === undefined || entry.rank >= top.rank) top = entry;
  }
  return top?.token;
}

/**
 * Escape closes one layer per press — and the protocol is a handshake, not a z-index.
 *
 * Both layers listen on `window`, so neither can see the other and neither can be ordered
 * by CSS. What separates them is the **phase**:
 *
 * * an `"inner"` layer listens in the **capture** phase and `preventDefault()`s the press;
 * * an `"outer"` layer listens in the **bubble** phase and returns early on
 *   `e.defaultPrevented`.
 *
 * Capture is the load-bearing half. Two `window` listeners for one event run in
 * *registration* order, and the outer layer is always the one mounted first — it has
 * been open since before the popup inside it existed. In the bubble phase it would
 * therefore act first and read `defaultPrevented` as false, closing the layer *and* the
 * popup on one press, with two focus hand-backs racing for the caret. Capture puts the
 * innermost open thing first no matter who mounted when, because every capture listener on
 * `window` runs before the event has descended to its target, let alone bubbled back.
 *
 * `defaultPrevented` is checked by both rungs rather than only by the outer one: the rule
 * this encodes is "never act on a press something else has already consumed", and it is
 * true of a second popup as much as of the layer underneath it.
 *
 * **Two `"inner"` peers are ordered now, by a stack rather than by registration order.**
 * Every capture-phase layer pushes a token on mount and pops it on unmount, and only the
 * token on top acts. A lone `"inner"` layer is a stack of one and behaves exactly as it did.
 * This is what lets a context menu open over a dialog opened over the card modal and give one
 * press to each: menu, dialog, card.
 *
 * **The bubble rung is ordered now too, and by rank rather than by mount order.** It did not need
 * to be while `"outer"` had one occupant in the entire app; `"navigation"` gave it a second, and
 * a view is always mounted *before* a panel that opens beside it — so in registration order the
 * floor would act first and walk the reader out of a folder while their card sat open. See
 * {@link bubbleStack}. Across the two phases nothing changed: `defaultPrevented` is still the
 * whole of it, because every capture listener runs before any bubble one.
 *
 * **A field can take the press before any of this**, and two in the app do — a deck name with an
 * edit to revert (`DeckNameField`) and a filter box with text in it ({@link clearFieldOnEscape}).
 * They are React handlers on the input, which is target phase and therefore after capture and
 * before `window`'s bubble, and they `preventDefault()` only when they have something to spend
 * the press on. That is not a fourth rung so much as the reason the floor is safe to add: without
 * it, Escape in a search box would clear the box **and** close the deck behind it.
 *
 * A layer that Escape dismissed hands focus back to whatever opened it — do that from
 * `onDismiss`, *before* React flushes the close, while the element is still mounted. An
 * outside-click deliberately does not, so that belongs to the caller and not here: the
 * reader who clicked elsewhere is already somewhere else.
 *
 * **`onDismiss` is latched in a ref rather than depended on, and that is a correctness fence
 * rather than a saved re-registration.** While it was an effect dependency, a layer that
 * re-rendered with a fresh callback popped its token and pushed a new one — landing on **top**
 * of whatever had been opened over it, so the next press closed the wrong window. Nothing could
 * see that: not lint, not the suite, and not the call site, because stability is transitive
 * through props and a layer that memoises correctly is still unstable if its own `onDismiss`
 * prop is. An inline arrow is therefore safe here, which is what Task 5's per-submenu layers
 * need. `enabled` and `layer` stay dependencies on purpose — `enabled: false → true` is a layer
 * *opening*, and re-pushing it to the top is exactly right.
 *
 * Pinned by `App.test.tsx`'s Escape-stack test and by this hook's own phase test. Every
 * new dismissible layer uses this, or it will close something it did not open.
 */
export function useDismissOnEscape({
  layer,
  onDismiss,
  enabled = true,
}: {
  layer: DismissLayer;
  onDismiss: () => void;
  /** Usually the layer's own "am I open" flag. An outer layer is open for as long as it exists. */
  enabled?: boolean;
}): void {
  // Latched every render, in a *layout* effect: the ref is current before the browser can paint,
  // let alone deliver a key, so the listener never calls a callback a render behind.
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!enabled) return;
    const capture = layer === "inner";
    // Identity for this registration, minted per mount so two layers sharing one `onDismiss`
    // are still two entries.
    const token = Symbol("dismissLayer");
    if (capture) captureStack.push(token);
    else bubbleStack.push({ token, rank: RANK[layer] });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only the innermost layer of each phase acts. `defaultPrevented` above is what keeps the
      // two phases in order — every capture listener has already run by the time a bubble one
      // hears the press — and a stack per phase is what orders the peers *within* one.
      if (capture ? captureStack[captureStack.length - 1] !== token : bubbleOwner() !== token) {
        return;
      }
      e.preventDefault();
      onDismissRef.current();
    };

    // The third argument is the whole contract — passed to both calls, because a listener
    // removed with the wrong phase is not removed at all.
    window.addEventListener("keydown", onKey, capture);
    return () => {
      window.removeEventListener("keydown", onKey, capture);
      const at = capture
        ? captureStack.lastIndexOf(token)
        : bubbleStack.findIndex((entry) => entry.token === token);
      if (at !== -1) (capture ? captureStack : bubbleStack).splice(at, 1);
    };
  }, [enabled, layer]);
}

/**
 * Stop the keys a *row* activates on, and nothing else — the other half of the protocol
 * above, for the controls that live inside a clickable row.
 *
 * Every row list in the app — the collection table, the search table, the wishlist — opens
 * the card on click and on Enter or Space. A control inside a row — a stepper, a quick-add
 * button, a remove button — must not open the card as well when it is used, so its cell
 * stops the press. Stopping the *whole* `keydown` does that and takes every other key with
 * it: React attaches one listener at the root, so a synthetic press that never reaches the
 * root never reaches `window` either, and [`useDismissOnEscape`] listens on `window`. The
 * card pane's Escape therefore stopped working for as long as the caret sat in one of those
 * controls — **measured live in the running app on 2026-08-06** — and it was invisible to
 * every suite here, because a test that fires Escape at the row rather than at the control
 * inside it never travels the path that is broken. All three lists had it; the count is not
 * in this sentence on purpose, because the next list will have it too unless it uses this.
 *
 * So: exactly the two keys the row acts on. Anything else is somebody else's press.
 */
export function stopRowActivationKeys(e: ReactKeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
}

/**
 * A filter box empties on Escape — and owns that press only while it has something to empty.
 *
 * **This is what makes the `"navigation"` rung safe to have, not a courtesy on top of it.** Every
 * filter box in the app is an `<input type="search">`, and Chromium clears one on Escape all by
 * itself — *without* setting `defaultPrevented`. So the moment Escape also means "close the deck",
 * one press in a box with text in it does both: the box empties and the deck the reader was
 * filtering closes behind it. Nothing in the suite can see that, because jsdom does not implement
 * the native clear; it is a fact about the shipped window only.
 *
 * The guard is `value !== ""` and it is the whole design. An empty box has nothing to undo, so
 * the press is not its — it falls through to whatever is open behind, exactly as it did before
 * this existed. A box with text owns one press and the next one is the view's again. That is
 * `DeckNameField`'s rule (`Escape` reverts a draft, and only while there *is* a draft) stated
 * once for the boxes that share it, rather than copied into each of them.
 *
 * Not for a field inside a dialog or a popup: an `"inner"` layer listens in the **capture**
 * phase, so it has already consumed the press before the field's own handler runs, and a call
 * here would be a line that can never execute. `PrintingsFilterBar` and `DeckCoverPicker` are
 * both that case and both deliberately do without.
 */
export function clearFieldOnEscape(e: ReactKeyboardEvent, value: string, clear: () => void): void {
  if (e.key !== "Escape" || value === "") return;
  e.preventDefault();
  clear();
}
