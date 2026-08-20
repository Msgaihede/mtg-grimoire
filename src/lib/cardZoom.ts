/**
 * The ladder the card tiles are sized on, and the three sums every surface that draws them
 * needs.
 *
 * ## Why a ladder and not a multiplier
 *
 * The gesture behind this is ctrl+wheel, and **a wheel delta is not a magnitude anything may
 * trust**. A mouse notch arrives as a `deltaY` of 100 through Chromium's line mode and as 120
 * from a driver reporting raw ticks; a precision trackpad's pinch — which reaches the page as
 * a *stream* of ctrl-flagged wheel events, not as a gesture of its own — arrives in the single
 * digits, dozens of times a second. Scaling by the delta would make one flick of the wrist mean
 * four different things across the hardware a single reader owns, and would take the pinch from
 * one end of the range to the other before they let go. A ladder makes the unit the **gesture**:
 * one wheel event is one stop, whatever the hardware called it.
 *
 * It also keeps the number exact, which a multiplier cannot. `zoom * 1.1` applied eight times
 * and undone eight times is not 1 — it is 0.9999999999999998, which formats as "100%" while
 * sizing every tile a hair off and never lands back on a value the ladder could leave.
 * {@link stepZoom} returns an element of {@link ZOOM_STEPS} *by identity*, so the state can only
 * ever hold one of ten exact numbers and `zoom === 1` is a question worth asking.
 *
 * ## Where the state lives
 *
 * Not here. This module is arithmetic — the values are `useAppStore`'s `cardZoom`, which holds
 * **one number per card section** ({@link ZOOM_SECTIONS}) rather than one for the app. A reader
 * zooming the deck editor's docked search column was resizing the deck laid out beside it, and
 * those are two different questions asked in the same second; the ladder below is the same ladder
 * either way, it is just walked once per section.
 *
 * All of them are deliberately session-only: no persistence, no SQLite, no IPC. Zoom is a posture
 * a reader takes for a minute of comparing art, not a preference they set once; restoring it on
 * launch would mean a reader who peered at one card in the last session is greeted by 200% tiles
 * in the next one, with nothing on screen explaining why.
 */

/**
 * Ten stops from half size to double, shaped like a browser's own zoom menu: coarse at the ends,
 * fine either side of 100%.
 *
 * The fine middle is the part that is load-bearing. A grid of 170px tiles gains or loses a whole
 * column somewhere around every 10% here, so the stops near 1 are where a reader is actually
 * steering — "one more card per row" is the thing they are asking for, and a ladder that jumped
 * 1 → 1.5 would overshoot it every time. The ends are wide because nobody adjusts *at* 50%; they
 * go there and stop.
 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** Tiles at the size every surface drew them before this existed. Also where a session starts. */
export const DEFAULT_ZOOM = 1;

/** The bottom of {@link ZOOM_STEPS} — read from the ladder so the two cannot drift. */
export const MIN_ZOOM: number = ZOOM_STEPS[0];

/** The top of {@link ZOOM_STEPS}. */
export const MAX_ZOOM: number = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * The card sections that zoom independently of one another.
 *
 * Five surfaces draw walls of cards, and they share the screen rather than taking turns on it:
 * the deck editor puts its docked card search column beside the deck itself, and the printings
 * modal opens over whichever wall is already up. One shared number made a gesture over the
 * search column resize the deck too — "how big are the cards I am browsing" and "how big is my
 * deck laid out" answered together, when the reader only asked one of them.
 *
 * `deck` is one key for **both** deck views. Stacks and Grid are two drawings of the same pile,
 * so switching between them must not resize the cards the reader just settled on.
 *
 * `printings` is the all-printings modal's wall, and it is the strongest case on the list rather
 * than the weakest: the modal opens **over** a wall the reader has already sized, so a shared
 * number would have a ctrl+wheel inside it resize the page underneath — a change made to
 * something they cannot see, waiting for them when the modal closes. It is the one section that
 * is not a place a reader navigates to, and it is still a section for that reason: the modal
 * throws away its filter and its scroll on every close, and the size the cards are drawn at is
 * the one thing about it a reader would resent re-setting.
 */
export const ZOOM_SECTIONS = [
  "search",
  "tags",
  "collection",
  "wishlist",
  "deckSearch",
  "deck",
  "printings",
] as const;

export type ZoomSection = (typeof ZOOM_SECTIONS)[number];

/**
 * Every section at {@link DEFAULT_ZOOM} — the shape `cardZoom` starts a session as.
 *
 * Spelled out as a literal rather than reduced over {@link ZOOM_SECTIONS}, because
 * `Record<ZoomSection, number>` then makes a new section a **compile error** until somebody has
 * said what it starts at. A `reduce` would quietly hand it whatever the reduce's default was, and
 * a section nobody chose a starting size for is exactly the thing worth stopping a build over.
 */
export const DEFAULT_SECTION_ZOOMS: Readonly<Record<ZoomSection, number>> = {
  search: DEFAULT_ZOOM,
  // The Tags page's wall. Its own key rather than the search's for the reason every split on
  // this list has: the two walls are never on screen together, but they are read for different
  // reasons — one to find a card by name, one to look at what a motif's illustrations *are* —
  // and a reader who sized the art up to read a picture was not resizing a search by name.
  tags: DEFAULT_ZOOM,
  collection: DEFAULT_ZOOM,
  // The shopping list's wall. Its own key rather than the collection's for the reason every
  // split on this list has: the two are read one after the other — what is wanted, then what
  // is owned — and a size settled on one is not an answer about the other.
  wishlist: DEFAULT_ZOOM,
  deckSearch: DEFAULT_ZOOM,
  deck: DEFAULT_ZOOM,
  // The modal's wall. Its own key rather than the search's, for {@link ZOOM_SECTIONS}' own
  // reason: the modal opens *over* a wall the reader has already sized, and a ctrl+wheel inside
  // it must not resize the page underneath.
  printings: DEFAULT_ZOOM,
};

/**
 * The stop nearest `zoom`, so an off-ladder value has somewhere to step *from*.
 *
 * Nothing writes an off-ladder value today, and the snap is still the honest reading of the
 * question: a caller asking for the next stop up from 1.05 means 1.1, not "1.05 is not on the
 * ladder". A tie goes to the lower stop (`<`, not `<=`), which makes a value exactly between two
 * stops step *up* to the higher and *down* to the lower — the direction the reader asked for
 * either way.
 */
function nearestIndex(zoom: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - zoom) < Math.abs(ZOOM_STEPS[best] - zoom)) best = i;
  }
  return best;
}

/**
 * One stop in `direction` — `1` bigger, `-1` smaller — clamped at both ends of the ladder.
 *
 * **At a limit it returns the value it was given**, rather than refusing or wrapping. That is the
 * whole of the clamp, and it is why the store increments its pulse separately: a reader holding
 * the wheel at 200% goes on producing gestures that this function answers with 200% forever, and
 * the badge that tells them so must not read "no change" as "no gesture".
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const from = nearestIndex(current);
  const next = from + direction;
  if (next < 0 || next >= ZOOM_STEPS.length) return ZOOM_STEPS[from];
  return ZOOM_STEPS[next];
}

/**
 * The zoom as a reader reads it: `"125%"`.
 *
 * Rounded to a whole percent because the ladder is not made of round numbers in binary — 0.67
 * times 100 is 67.00000000000001, and 0.9 times 100 is 90.00000000000001. Printed raw, two of
 * the ten stops would show a badge fourteen digits wide. There is no locale in this: a percentage
 * on a HUD is a magnitude, and `formatPrice`'s argument about currency does not reach it.
 */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * A base pixel measurement at this zoom, as a whole number of pixels.
 *
 * Rounded rather than left fractional because these numbers become grid track widths and image
 * box heights, and a fractional one is a seam: the browser snaps each tile's *painted* edge on
 * its own, so a column of 212.5px tiles alternates 212 and 213 down the page and the 5:7 art
 * boxes stop lining up across a row. One rounding here, at the one place the multiplication
 * happens, keeps every consumer of the same `base` in agreement.
 *
 * Half rounds up, which is JavaScript's rule and not a choice made here — `scaled(170, 1.25)`
 * is 213.
 */
export function scaled(base: number, zoom: number): number {
  return Math.round(base * zoom);
}

/**
 * The custom property every mark laid on a card reads to size itself: the reader's zoom, as a
 * bare number, inherited down from the card's own root element.
 *
 * ## Why a CSS variable and not a prop
 *
 * The marks are shared components and **most of their call sites must not scale**. `RarityGem` is
 * drawn on a wall tile, in a deck tile's foot, in the stack's data line — and in the search table,
 * the collection table, the wishlist table and the card pane twice. `OwnedBadge`, `FinishMark`,
 * `TagDot` and `QuantityStepper` are each split the same way. A prop would have to be threaded to
 * every one of them and *defaulted* at the ones that stay still, which makes "does this scale?" a
 * question answered fifteen times, silently, by whoever added the newest call site.
 *
 * An inherited custom property answers it once, in the other direction: a mark reads
 * `var(--mark-scale, 1)`, and the fallback is what every surface that is not a card gets **without
 * knowing this variable exists**. Three elements set it — `CardGrid`'s tile, `GridView`'s tile and
 * `CardStack`'s card — and nothing else in the app has to be touched for a table to keep drawing
 * a 12px gem.
 *
 * It is also the reason this is not a `transform: scale()` on the overlay layer, which would have
 * been one line per corner: the caption strip under a wall tile is **in flow**, and a transform
 * changes no layout at all — the text would grow straight out of the strip the virtualiser sized
 * its rows from. Real geometry is the standing rule here (`src/CLAUDE.md`) and it is the only one
 * that works for both halves of a tile.
 *
 * ## It scales in both directions, unlike the budgets that hold it
 *
 * There is no floor. That is a deliberate reversal of `atLeast` — the `max(base, scaled(base))`
 * rule that governed `CardGrid`'s caption, `GridView`'s foot, `stackAdvance` and
 * `stackDataHeight` — and the reversal is what those floors were *for*: each one existed because
 * the chrome inside it could not shrink, so the budget had to refuse to. Now that the chrome
 * shrinks with the card, a floored budget is a 28px strip around 6px of type. The floors that
 * remain are the ones measuring space **between** cards rather than chrome **on** them — the two
 * walls' gutters — where nothing is being contained and the old argument still holds.
 */
export const MARK_SCALE_VAR = "--mark-scale";

/**
 * The same idea for the controls drawn on a card — the wall tile's quick-add, the deck tile's
 * stepper, the stack card's stepper column — kept a **separate** number because they are drawn a
 * little smaller than their panel-sized twins.
 *
 * One variable could not say this. The stepper's `xs` size is drawn in a deck tile's foot *and* in
 * the table and text views' rows, and the quick-add trigger is drawn in a wall tile's caption *and*
 * in the search table *and* in the card pane's printings rows — so baking {@link CONTROL_SHRINK}
 * into the control's own base would shrink four surfaces nobody asked about. Carried as a second
 * variable it reaches exactly the three roots that set it, and everywhere else the `, 1` fallback
 * leaves the control the size it has always been.
 */
export const CONTROL_SCALE_VAR = "--control-scale";

/**
 * How much smaller a control is when it is drawn **on a card** rather than in a panel or a row.
 *
 * A control on a card is competing with somebody's artwork for the same two square centimetres,
 * and it is revealed on hover rather than resident — so it does not have to hold the presence a
 * table's stepper does. 85% is the largest reduction that leaves the wall tile's quick-add above
 * 20px at 1×, which is the smallest square this app asks anyone to hit.
 */
export const CONTROL_SHRINK = 0.85;

/**
 * The two variables above, as the `style` object a card's root element carries.
 *
 * Written as one function rather than spelled at three call sites because the pair has to move
 * together: a mark and the control beside it in the same caption reading two different zooms is
 * the kind of drift that looks like a rendering fault. The cast is `CSSProperties`' doing — React
 * types custom properties as unknown keys, and there is no narrower way to say "these two".
 */
export function cardScaleVars(zoom: number): Record<string, string> {
  return {
    [MARK_SCALE_VAR]: String(zoom),
    [CONTROL_SCALE_VAR]: String(zoom * CONTROL_SHRINK),
  };
}
