import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, type Transition } from "motion/react";
import { CardImage } from "@/components/CardImage";
import { FoilOverlay } from "@/components/CardArt";
import { FinishMark } from "@/components/FinishMark";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { DEFAULT_ZOOM, scaled } from "@/lib/cardZoom";
import { soleFinish } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import type { Currency } from "@/lib/marketplace";
import { stackCard } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { GameChangerBanner, QuantityTag, RuleBreakMark } from "./CardMarks";
import {
  DECK_CARD_VARIANT,
  deckCardBodyProps,
  deckCardName,
  deckCardMenuProps,
  deckCardProps,
  deckCardSelectedProps,
  DeckCardControls,
  FOCUS,
  FOCUS_INSET,
  LandedMark,
  revealedWhenOpen,
  SELECTED_CARD,
  useDeckCardDrag,
  type DeckCardActions,
} from "./cardControl";
import { ruleBreak } from "./violations";
import type { ValidationIssue } from "./validation/types";

/**
 * The stack's geometry, and it is arithmetic rather than taste — the numbers below have to
 * agree or the trick does not work.
 *
 * **A card is the card**: one whole `grid` image, edge to edge, with the app's own marks
 * overlaid on it. So its height is not a number somebody chose, it is the aspect ratio of a
 * Magic card applied to the width it is drawn at, plus the data line standing under it:
 *
 * ```
 * STACK_CARD_WIDTH                              = 210
 *   × 680/488                                   = 292.6 →  STACK_IMAGE_HEIGHT (293)
 *   + the card's own border (1 + 1)             = 295
 *   + the data line, less the 4px it rides up   = 319   →  STACK_CARD_HEIGHT
 * ```
 *
 * That width was itself read *off* the column once — a fixed 14rem, less the section's `p-1.5`
 * either side and the card's border, which is 224 − 12 − 2 — and the arrow now points the other
 * way: the card is the given, and `StackView`'s `stackColumnWidth` is what wraps it. The sum is
 * the same 224 at 1× and it is the only one that can survive a zoom, since a column scaled on
 * its own would leave the padding growing with the cards. Neither number was ever measured.
 *
 * **The data line is part of the card and no longer part of the picture.** It used to be an
 * overlay across the bottom of the art, which cost the reader the card's printed text box and
 * bought a line of facts they could have had for 24px of column. It is now the card's *foot*:
 * a 28px bar below the face, pulled 4px up so its top corners sit under the face's bottom ones
 * and the two read as one object rather than as a card with a caption. That is the whole of
 * why {@link STACK_CARD_HEIGHT} grew by 24 and every number after it moved.
 *
 * Collapsed, every card carries a **−285px** bottom margin, so each one advances the stack by
 * 319 − 285 = **34px**. That 34 is unchanged from when this frame was three app-drawn bands and
 * the advance was its 30px title bar: it is the card's **printed** title bar plus a sliver
 * of art, which is what a real fanned stack shows — and it is a legibility floor rather than a
 * proportion, because the quantity tag overlaid on that strip has to fit in it.
 *
 * The list is then given a **fixed height** of `34n + 293`: the collapsed stack (`34n + 285`)
 * plus **8px**, which is one open card's bottom margin. Fixed is the point. An open card's
 * margin goes from −285 to +8 and pushes every card after it down by 293px — out of the
 * list's box, over whatever is below, and *not* into the list's height. So the group's header
 * does not move, the next group in the column does not move, and the reader can run down a
 * fifteen-card stack without the page walking away from the pointer.
 *
 * ## The arithmetic that decides the interaction, not just the look
 *
 * With card *N* open, card *k*'s top is `k·34` for `k ≤ N`, and `N·34 + 327 + (k−N−1)·34` for
 * `k > N`. Open card *N+1* instead and **every one of those tops is unchanged except card
 * N+1's**, which moves from `N·34 + 327` up to `N·34 + 34`. Cards N+2 and beyond do not move
 * at all.
 *
 * So a step down the stack moves exactly one card, 293px — which is why the whole reflow is
 * one `margin-bottom` tween, and it is also the whole of the defect this component was
 * rebuilt to fix. After the first step the *next* card's strip is only ~34px below the
 * pointer, so one continuous downward sweep crosses four or five strips in ~60ms and, under
 * a bare CSS `:hover`, armed every one of them. The reader landed several cards below the one
 * they aimed at. See {@link useFlipThrough} for what replaced it.
 *
 * ## Every constant below is the value at 1×, and the functions are the geometry
 *
 * The reader can zoom the card surfaces (ctrl+wheel — `lib/cardZoom.ts`), so none of these sums
 * is a fixed pixel count any more. Each constant is the **base**: the number a card measured
 * before the zoom existed, and the number its function still answers at {@link DEFAULT_ZOOM}.
 * {@link stackCardWidth}, {@link stackImageHeight}, {@link stackCardHeight},
 * {@link stackAdvance}, {@link stackCollapsedMargin} and {@link stackHeight} are that same
 * ladder read at a zoom, in that order, each derived from the one above it exactly as the block
 * above derives them — so there is still one place a number is decided and one place it can be
 * got wrong.
 *
 * **The geometry is rescaled, never transformed.** A `transform: scale()` on the list would be
 * one line and wrong three times over: it resamples a 488px card image into blur, it draws every
 * caption at 1× and then stretches it, and — the one that would actually break something — it
 * leaves every sum above describing a box the card is no longer in. This editor drags cards onto
 * real boxes and hit-tests them with real coordinates.
 */
export const STACK_CARD_WIDTH = 210;
/**
 * A Magic card's proportions, taken from the `grid` variant's own 488×680 — the image these
 * cards draw, so the frame cannot disagree with its contents about what shape a card is.
 */
const CARD_ASPECT = 680 / 488;
/**
 * The card's own hairline border, one edge.
 *
 * **It does not zoom, and that is why it is a named number rather than part of the sums.** The
 * border is a Tailwind `border` class — 1px at every zoom, as a hairline should be — so a card
 * is its image plus two of these whatever size the image is, and `+ 2` in the block above is
 * this twice rather than a rounding fudge.
 */
export const STACK_CARD_BORDER = 1;
/** The image's own height at {@link STACK_CARD_WIDTH}, which is the card face and nothing else. */
export const STACK_IMAGE_HEIGHT = Math.round(STACK_CARD_WIDTH * CARD_ASPECT);
/**
 * The data line's own height — the card's foot, standing under the face rather than over it.
 *
 * **A floor under the zoom rather than a proportion of it**, for {@link stackAdvance}'s reason and
 * not for a new one: the bar holds the printing's facts in type that is already at the app's
 * legibility floor, and type does not get smaller because a card did. See {@link stackDataHeight}.
 */
export const STACK_DATA_HEIGHT = 28;
/**
 * How far the data line rides **up** over the face's bottom corners.
 *
 * It is what joins the two boxes into one card: the face clips its own 7px corners, and a bar
 * butted flush under them would show two hairlines of background through the gap. Four pixels
 * is the radius less its own border, so the bar's square top corners are covered by the face
 * exactly where the face is still solid.
 *
 * **It does not zoom**, because the radius it is derived from does not: the corner is a Tailwind
 * `rounded-*` class, 7px at every zoom, so the overlap that hides the seam is the same 4px at
 * every zoom too.
 */
export const STACK_DATA_RISE = 4;
export const STACK_CARD_HEIGHT =
  STACK_IMAGE_HEIGHT + 2 * STACK_CARD_BORDER + (STACK_DATA_HEIGHT - STACK_DATA_RISE);
/** How far one card advances the stack — its printed title bar and a sliver of art. A floor for
 *  the overlaid quantity chip, not a fraction of the card. See {@link stackAdvance}. */
export const STACK_ADVANCE = 34;
/** The collapsed bottom margin, in px. Negative: each card is pulled up over its neighbour. */
export const STACK_COLLAPSED_MARGIN = STACK_ADVANCE - STACK_CARD_HEIGHT;
/**
 * The bottom margin an open card takes, and therefore the slack the list is given.
 *
 * **The one length here that does not zoom.** It is not a part of the card, it is the gap that
 * says *this card is out of the stack* — and a gap says that at 8px whether the card is 148px
 * tall or 587px. Scaled down it would be 4px, which reads as two cards that failed to separate;
 * scaled up it would push the open card's successor further than it has to travel.
 */
export const STACK_LIFTED_MARGIN = 8;

/** The card's width at this zoom — the one measurement everything else here is derived from,
 *  and the one the column above has to agree with (`StackView`'s `stackColumnWidth`). */
export function stackCardWidth(zoom: number): number {
  return scaled(STACK_CARD_WIDTH, zoom);
}

/**
 * The card face's height at this zoom: a Magic card's proportions applied to the width that is
 * actually drawn.
 *
 * Off {@link stackCardWidth}'s **rounded** answer rather than off `210 × zoom`, because the
 * rounded width is the box the browser paints — deriving the height from the unrounded one would
 * put the frame a fraction out of shape at exactly the zooms where the rounding bit.
 */
export function stackImageHeight(zoom: number): number {
  return Math.round(stackCardWidth(zoom) * CARD_ASPECT);
}

/**
 * The data line's height at this zoom — **grown with the card, never shrunk below its base**.
 *
 * The same rule as {@link stackAdvance} and for the same reason, which is why they are the only
 * two `max`es in the file: the bar's contents are type and a mana line, not a picture, and both
 * are already at the size the app stops shrinking text at. A plain multiply would give a 14px bar
 * at 0.5× holding 11px type — the bar would be shorter than the words inside it, and the words
 * would spill over the card below.
 */
export function stackDataHeight(zoom: number): number {
  return Math.max(STACK_DATA_HEIGHT, scaled(STACK_DATA_HEIGHT, zoom));
}

/**
 * The whole card at this zoom: its face, the hairline border it does not zoom, and the foot
 * standing under it less the 4px that foot rides up into the face.
 *
 * The rise is subtracted unscaled on purpose — see {@link STACK_DATA_RISE}. So the card is the one
 * sum here with three different behaviours in it (a scaled face, a floored foot, two fixed
 * hairlines), which is exactly what it was before the zoom existed; the zoom only made the
 * differences visible.
 */
export function stackCardHeight(zoom: number): number {
  return stackImageHeight(zoom) + 2 * STACK_CARD_BORDER + (stackDataHeight(zoom) - STACK_DATA_RISE);
}

/**
 * How far one card advances the stack at this zoom — **it grows with the card and never shrinks
 * below {@link STACK_ADVANCE}**.
 *
 * The one number in this file that is not a proportion, and therefore the one place a plain
 * multiply is wrong. 34 is a *legibility floor*: the quantity chip is drawn over the reveal
 * strip and has to fit inside it, and the chip does not get smaller when the card does — it is
 * 11px type at every zoom, because 5px type is not type. Scaled linearly, a 0.5× stack would
 * reveal 17px, the chip on each card would cover the printed name of the card above it, and a
 * collapsed stack would stop being readable at exactly the zoom a reader picked in order to see
 * more of it at once.
 *
 * So `max(floor, scaled)`, and **please do not simplify it back to `scaled(STACK_ADVANCE, zoom)`
 * on the grounds that the `max` looks redundant** — it is doing all of the work below 1×.
 *
 * It stays far under the card at both ends — 34 of a 148px card at 0.5×, 68 of 587px at 2× — so
 * {@link stackCollapsedMargin} is negative at every stop and every card is still painted over
 * the one before it. An advance that reached the card's height would stack the pile the wrong
 * way round with no error anywhere.
 */
export function stackAdvance(zoom: number): number {
  return Math.max(STACK_ADVANCE, scaled(STACK_ADVANCE, zoom));
}

/** The collapsed bottom margin at this zoom, which is what pulls each card up over its
 *  neighbour and leaves exactly {@link stackAdvance} of it showing. */
export function stackCollapsedMargin(zoom: number): number {
  return stackAdvance(zoom) - stackCardHeight(zoom);
}

/**
 * How long the pointer must stay on a card before it opens.
 *
 * Short enough that a reader who meant to stop never notices it, long enough that a sweep
 * down the stack commits to nothing on the way past — a pointer crossing four strips in 60ms
 * arms four cards and settles on none of them, which is exactly what should happen.
 */
export const STACK_OPEN_DWELL_MS = 80;

/**
 * How long an open card stays open after the pointer leaves the stack.
 *
 * **Its real job is the gap between two cards**, not the exit: arming any card cancels a
 * pending close, so the stack never shows an all-closed frame while the reader is moving
 * from one card to the next. That it also forgives a pointer that slips off the edge is the
 * smaller half of it.
 *
 * It used to equal the reflow's own duration, and that was always a coincidence rather than a
 * derivation — the reflow is `slow` (260ms) since 2026-08-14 and this is still 180ms, because
 * it is an *intent* delay and belongs to the gesture, where `lib/motion.ts`'s scale belongs to
 * what the pixels do. Nothing broke when they stopped agreeing, which is the evidence that they
 * were never one number.
 */
export const STACK_CLOSE_DELAY_MS = 180;

/**
 * How the open card says so, for anything that has to find it **after the fact**.
 *
 * The lift used to be CSS `:hover`, which nothing outside a real browser can observe and
 * which `userEvent.hover` does not engage — so no test and no story could say which card was
 * up. It is state now, and this is the one honest question to ask about it: from a test, and
 * from `scripts/cdp.mjs --probe` in the shipped window, where the alternative is reading a
 * margin mid-tween. `DECK_CARD_ATTR` and `DECK_GROUP_ATTR` are the same idea one floor down.
 */
export const STACK_OPEN_ATTR = "data-stack-open";

/**
 * How tall the list is for `count` cards — **a function of the count and the zoom, and nothing
 * else**.
 *
 * That the open card is not among those two is the property
 * `opening_a_card_does_not_change_the_group_height` pins, and it holds by construction rather
 * than by there being no state to depend on: the height is computed from `cards.length` and
 * reads {@link useFlipThrough}'s answer nowhere. An empty stack is 0 rather than 293 — a group
 * with nothing in it draws its header and no box.
 *
 * The zoom defaults, so every caller that has no opinion — a story, a test pinning the base
 * arithmetic — still asks the question it always asked. `StackView` has an opinion, and passes
 * the same one to the column it draws this in.
 */
export function stackHeight(count: number, zoom: number = DEFAULT_ZOOM): number {
  if (count === 0) return 0;
  return stackAdvance(zoom) * (count - 1) + stackCardHeight(zoom) + STACK_LIFTED_MARGIN;
}

/**
 * The one strip of a collapsed card the reader can see — its printed title bar — as the box the
 * app's own marks are laid over.
 *
 * ## The marks go left, and they used to go right
 *
 * The reversal is the point of keeping this a named constant. The old rule was "never the
 * left, because a printed name is left-aligned and a collapsed stack is read down this strip",
 * and it was right about a **grey chip**: a rectangle of app furniture over the first four
 * characters of a card's name buys nothing and costs the one thing the strip is for.
 *
 * What changed is what is in the corner. {@link QuantityTag} is not a chip — it is the card's
 * tag, in the tag's colour, with the copy count printed on it, cut to a banner rather than a
 * box. Down a fifteen-card stack that column of colour *is* the structure of the pile, and a
 * reader scans it before they read a single name. Putting it where the eye starts is what makes
 * the scan work; putting it on the right made it a footnote to fifteen names.
 *
 * The cost is real and is paid knowingly: roughly 34px of printed name, which is three or four
 * characters. Two things make it survivable — the name is on the **card pane, the table, the
 * text columns and the button's own accessible name**, none of which this covers; and the
 * no-picture frame under the art insets its own name band by exactly this width
 * ({@link FRAME_NAME_INSET}), so the one case where the app is drawing the name itself never
 * hides a character of it.
 */
const CARD_MARKS_STRIP = "absolute top-0 left-0 right-[5px] flex h-[27px] items-start";

/**
 * How far the no-picture frame's name band is inset from the left, so {@link QuantityTag} never
 * covers a character of a name the **app itself** drew.
 *
 * A printed card's name is Wizards' to place and this component covers 34px of it knowingly
 * ({@link CARD_MARKS_STRIP}). A name this file writes is not, and there is no reason to repeat
 * the compromise where there was no constraint forcing it.
 */
const FRAME_NAME_INSET = 34;

/**
 * The no-picture frame's two bars, tinted a step off the surface they sit on.
 *
 * The hairline colour at 35 % rather than a token of its own: the bars have to be *found*
 * against the card body without being read as content, which is a hairline's whole job at a
 * larger area. `color-mix` rather than an alpha, so the bar is opaque — the card behind it is
 * the same colour, but the marks strip's scrim is not.
 */
const FRAME_BAR = "color-mix(in oklab, var(--color-border) 35%, var(--color-surface))";

/**
 * **`identityTint` used to live here and is gone**, with its five-line copy of `DeckStats`'
 * `PIP_COLOR` table. It faded a card's colour identity into the app-drawn title bar, and it was
 * the one place this component spent colour — on Magic meaning, which is the direction's rule for
 * when colour is allowed at all.
 *
 * Drawing the whole card retires it rather than replacing it: a printed frame *is* that colour, in
 * the vocabulary a player already reads, so a collapsed stack still shows the shape of a deck's
 * colours — off the cards themselves instead of off a tint derived from them. Recorded here
 * because a reader looking for the tint should find out where it went, not just that it is
 * missing.
 */

/** A `setTimeout` handle, as this project's DOM-only lib types one. */
type Timer = ReturnType<typeof setTimeout>;

/** What {@link useFlipThrough} answers with. */
interface FlipThrough {
  /** Which card is open, or `null` for a stack at rest. */
  openIndex: number | null;
  /** The pointer arrived on card `index`. Opens it once it has stayed {@link STACK_OPEN_DWELL_MS}. */
  arm: (index: number) => void;
  /** The caret arrived on card `index`. Opens it now — a caret is a deliberate act. */
  openNow: (index: number) => void;
  /** The pointer left the stack, or the caret did. Closes after {@link STACK_CLOSE_DELAY_MS}. */
  release: () => void;
}

/**
 * Which card is open, and the two timers that decide it — the whole of the flip-through.
 *
 * **This is hover *intent*, and its absence was the defect.** The trigger is `pointerenter` on
 * the card, which needs no new hit target: a closed card is overlapped by 285px by its
 * successor, which is later in the document and therefore paints over it, so the only hittable
 * part of a closed card already *is* its 34px strip. What was missing was the pair of delays.
 *
 * * **Opening waits.** A sweep down the stack crosses a strip every ~15ms and arms each one in
 *   turn; each arming cancels the one before, so the sweep commits to nothing and only the card
 *   the pointer settles on opens.
 * * **Closing waits, and arming another card cancels it.** That second half is the one worth
 *   stating: without it the frame between leaving card N and committing to card N+1 is a stack
 *   with nothing open, and a reader running down a column would watch it collapse and re-open
 *   under their hand.
 *
 * Re-entering the card that is already open resolves to `setOpenIndex(sameIndex)`, which React
 * bails out of — so the arm needs no special case for it and does not have to read the state it
 * sets. Nothing here is a dependency of anything, which is what keeps the two callbacks stable
 * across every open and close.
 *
 * **{@link release} cancels a pending open as well as scheduling the close**, including when it
 * comes from the caret leaving. The one case that costs is a pointer dwelling on one card while
 * focus leaves the stack from another — the dwell is dropped and the next pointer move re-arms
 * it. That is a cheaper wrong answer than a card that opens 80ms *after* the reader left.
 */
function useFlipThrough(): FlipThrough {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // At most one pending timer of each kind. A ref rather than state: a timer handle is not
  // something to draw, and writing one must never schedule a render of its own.
  const pending = useRef<{ open: Timer | null; close: Timer | null }>({ open: null, close: null });

  const cancel = useCallback((kind: "open" | "close") => {
    const timer = pending.current[kind];
    if (timer !== null) {
      clearTimeout(timer);
      pending.current[kind] = null;
    }
  }, []);

  // Read out of the ref here rather than in the cleanup, which is what the hooks lint asks
  // for and is honest besides: `pending` is created by this hook and never replaced, so the
  // object the cleanup closes over is the object the handlers wrote into.
  useEffect(() => {
    const timers = pending.current;
    return () => {
      if (timers.open !== null) clearTimeout(timers.open);
      if (timers.close !== null) clearTimeout(timers.close);
    };
  }, []);

  const arm = useCallback(
    (index: number) => {
      cancel("close");
      cancel("open");
      pending.current.open = setTimeout(() => {
        pending.current.open = null;
        setOpenIndex(index);
      }, STACK_OPEN_DWELL_MS);
    },
    [cancel],
  );

  const openNow = useCallback(
    (index: number) => {
      cancel("close");
      cancel("open");
      setOpenIndex(index);
    },
    [cancel],
  );

  const release = useCallback(() => {
    cancel("open");
    cancel("close");
    pending.current.close = setTimeout(() => {
      pending.current.close = null;
      setOpenIndex(null);
    }, STACK_CLOSE_DELAY_MS);
  }, [cancel]);

  return { openIndex, arm, openNow, release };
}

/**
 * Reduced motion's answer for the one thing the app-wide switch does not cover.
 *
 * `MotionConfig reducedMotion="user"` makes transforms and `width`/`height`/`top`/`left`
 * instant — `motion`'s `positionalKeys`, read out of the installed package — and
 * `margin-bottom` is **not** in that set. So the app's single switch would leave this
 * component's 293px reflow running at full travel for a reader who asked their OS for less,
 * which is precisely the hazard WCAG 2.3.3 names. `App.tsx` says `useReducedMotion()` is fine
 * inside one component that wants to swap a slide for something still; this is that component.
 *
 * The layout still changes. Only the travel is removed — which is exactly what the
 * `motion-reduce` opt-out on the CSS version did.
 */
const STILL: Transition = { duration: 0 };

export interface CardStackProps {
  cards: readonly DeckCard[];
  /**
   * What the list is called — the group's own heading. The header is drawn by the view above
   * (every view draws one), so the stack states it for anything that reads structure rather
   * than pixels.
   */
  label: string;
  /**
   * How a card's data line writes its unit price — the selected marketplace's currency,
   * passed in rather than read here so a stack and the heading above it cannot quote two
   * different marketplaces for the same pile. *Which* price it is was decided by the read.
   */
  currency: Currency;
  /**
   * Every finding, by `cardId` — `violationsByCard`'s answer, handed in whole rather than
   * per card so one map serves a whole view.
   */
  violations?: Map<string, ValidationIssue[]>;
  /**
   * Open this card. The whole row is passed rather than an id, because the pane needs the
   * slot: the same printing sits in two categories often enough that "which one was pressed"
   * is not derivable from the card.
   */
  onSelect?: (card: DeckCard) => void;
  /**
   * What the reader may do to a card here, or nothing — see {@link DeckCardActions}.
   *
   * **It cannot change the stack's height, and that is checked rather than intended**: the
   * controls are drawn over the card, absolutely positioned, so they take no space at all.
   * {@link stackHeight} is still a function of the count alone.
   */
  actions?: DeckCardActions;
  /**
   * How large the reader has asked cards to be drawn — `useAppStore`'s `cardZoom.deck`, which is
   * the deck desk's own number and not the docked search column's beside it.
   *
   * **Passed in rather than read here, for the reason `currency` is.** The card's width is not
   * this component's to know: it is whatever the column gives it, and `StackView` is what sizes
   * that column. Both numbers come off the same zoom, so a card whose image box was computed at
   * one zoom inside a column sized at another is not a bug that can happen — the stack cannot
   * disagree with the box it is in any more than it can quote a different marketplace from the
   * heading above it. Defaulted, so a story or a test that has no opinion draws the base
   * geometry.
   */
  zoom?: number;
  /**
   * The printing the card pane is open on, or `null` — which is both "no card is open" and "the
   * open one came from somewhere that is not this deck".
   *
   * It does two things here, and the second is the interesting one. The card wears
   * {@link SELECTED_CARD}, as a tile on the search wall does; and **it is the stack's resting
   * state** — see {@link CardStack} for what that replaced and why the pile still only ever
   * holds one card open.
   *
   * By `cardId` rather than by the row's own id, which is `TableView`'s rule and the store's: a
   * pane is open on a *printing*. A deck holds one row per `(category, card)`, so at most one
   * card of any one pile can match, and a printing filed in two piles is picked in both — which
   * is the honest answer to "which card is the pane about".
   */
  selectedCardId?: string | null;
  /**
   * Which cards have just been added, as `deck_cards.id` → the nonce that add was given.
   *
   * The whole map rather than a flag per card, for `violations`' reason: one object serves a
   * whole view, and the stack does not have to be told twice. The **value** is what makes a
   * second add of a card that is still glowing replay the mark — it is passed straight through
   * as React's `key`, so a changed nonce is a new element and a CSS animation that runs once per
   * element runs again. `DeckEditor`'s `useRecentAdds` is the one writer.
   */
  landed?: ReadonlyMap<number, number>;
  className?: string;
}

/** Nothing has landed — a stable identity, so a stack given no map does not re-render for one. */
const NONE_LANDED: ReadonlyMap<number, number> = new Map();

/**
 * One group's cards as a stack: overlapping card faces, each showing only its title bar, and
 * the one the reader has settled on standing clear of the rest.
 *
 * This is the signature interaction of the deck builder, and the reason it is a stack rather
 * than a list of rows: a deck is a physical object, and the thing a builder does with one is
 * fan it. Reading a column of eighty rows tells you their names; running a pointer down a
 * stack shows you the cards.
 *
 * **The lift is state, and it used to be CSS.** `hover:` and `focus-within:` open instantly, on
 * every strip the pointer crosses, which is what made a sweep land four cards below the one it
 * was aimed at — the geometry note at the top of this file has the numbers. {@link useFlipThrough}
 * is the replacement and the one place the rules live. Two things that were consequences of the
 * CSS version survive it deliberately: the list's height still cannot depend on which card is
 * open, because {@link stackHeight} reads the count and nothing else; and the caret still does
 * what the pointer does, by the same two callbacks rather than by a second code path.
 *
 * ## The pile's resting state is the picked card, not nothing
 *
 * {@link useFlipThrough} answers which card the *pointer* has settled on, and `null` when it has
 * gone. That null used to close the pile, so a reader who clicked a card to read it in the pane
 * beside them watched it drop back into the stack the moment they moved to the pane — the card
 * they were looking at was the one thing on screen that stopped being visible.
 *
 * So the resolved answer is `openIndex ?? selectedIndex`: the hover wins while there is one, and
 * what it falls back to is the picked card rather than a closed pile. Two properties are worth
 * stating because they are what keeps this a small change rather than a new interaction.
 * **Still exactly one card open** — the geometry at the top of this file is arithmetic about one
 * open card, and two would push the tail of the pile twice as far over whatever is below it.
 * And **still no dependency of {@link stackHeight}** on any of it: the height is the count and
 * the zoom, so a picked card costs the layout nothing it did not already cost on hover.
 */
export function CardStack({
  cards,
  label,
  currency,
  violations,
  onSelect,
  actions,
  zoom = DEFAULT_ZOOM,
  selectedCardId = null,
  landed = NONE_LANDED,
  className,
}: CardStackProps) {
  const { openIndex, arm, openNow, release } = useFlipThrough();
  const reduced = useReducedMotion();
  if (cards.length === 0) return null;

  // `-1` for a pile that does not hold the picked card, which is every pile but one — folded to
  // `null` here so the `??` below reads as the sentence it is rather than as an index test.
  const picked = selectedCardId === null ? -1 : cards.findIndex((c) => c.cardId === selectedCardId);
  const open = openIndex ?? (picked === -1 ? null : picked);

  return (
    // `overflow-visible` and the fixed height are the two halves of one idea, and neither
    // works alone: the height is what stops the group resizing, and the overflow is what lets
    // the open card and the cards after it leave the box instead of being clipped.
    //
    // `relative` plus the lift, so the whole stack comes forward over the groups below it in
    // the column while it is being read — the cards that slide out of the box are painted
    // over by anything later in the document otherwise.
    //
    // The close is scheduled here rather than per card, and that is the point of putting it on
    // the list: a card that overflows the box is still a descendant, so crossing from one card
    // to the next is never a leave, and only leaving the stack itself schedules anything.
    <ul
      aria-label={label}
      onPointerLeave={release}
      style={{ height: stackHeight(cards.length, zoom) }}
      className={cn("relative block overflow-visible", open !== null && LAYER.raised, className)}
    >
      {cards.map((card, index) => (
        <StackedCard
          key={card.id}
          card={card}
          currency={currency}
          index={index}
          open={index === open}
          selected={index === picked}
          landedKey={landed.get(card.id)}
          zoom={zoom}
          onArm={arm}
          onOpenNow={openNow}
          onRelease={release}
          transition={reduced ? STILL : stackCard}
          ruleBreakText={ruleBreak(violations?.get(card.cardId))}
          onSelect={onSelect}
          actions={actions}
        />
      ))}
    </ul>
  );
}

/**
 * One card in the stack: **the whole card**, with the app's marks over it.
 *
 * It used to be a card frame rebuilt out of the app's own parts — a 30px title bar, a 256px
 * window on the `art` crop, a 24px data line — which meant the reader could see the
 * illustration and nothing else: no printed frame, no type line, no rules text, no P/T. A deck
 * list whose point is *what is in this deck* was showing the one part of a card that does not
 * say.
 *
 * So the picture is now the `grid` variant and it is the card: name, cost, art, type, text and
 * P/T, in the printed layout every player already reads.
 *
 * ## What the app says, and where it says it
 *
 * Two places, and the split is the whole shape of this component. **Over** the picture go the
 * facts about the *deck* — how many copies, which tag, whether a rule is broken — because they
 * are answers to "what is this card doing in this pile" and belong on the pile's own reveal
 * strip ({@link CARD_MARKS_STRIP}). **Under** it goes the data line, which is facts about the
 * *printing* — the rarity, the set, the finish, the price, the shortage — because those are
 * answers about the object, and covering the card's printed text box to state them was a bad
 * trade this component used to make.
 *
 * Not `CardArt`, which is the 5:7 box with its own no-art fallback and retry: the height here is
 * a constant the stack's arithmetic depends on, and the fallback has to fill exactly it. It
 * borrows `FoilOverlay`'s sheen, which is the same trade the card detail pane's main art makes
 * and for the same reason — what the surfaces must agree on is the marking — and says the
 * *word* on the data line rather than in a chip, which is `FoilOverlay`'s own rule for a
 * surface with room for it.
 *
 * **This is also what closes the artist-credit gap on this surface.** Scryfall's image policy
 * requires the illustrator to be named wherever the bare art crop is shown; a printed card
 * carries its own credit, so drawing the whole card satisfies the rule with nothing added.
 */
function StackedCard({
  card,
  currency,
  index,
  open,
  selected,
  landedKey,
  zoom,
  onArm,
  onOpenNow,
  onRelease,
  transition,
  ruleBreakText,
  onSelect,
  actions,
}: {
  card: DeckCard;
  /** How the data line writes the row's one unit price. */
  currency: Currency;
  /** Its place in the stack, which is the whole of its identity to {@link useFlipThrough}. */
  index: number;
  open: boolean;
  /** This is the card the pane is open on. **Not the same question as `open`** — the pile rests
   *  on the picked card, so the two are usually true together, and they part the moment the
   *  pointer settles on a neighbour. */
  selected: boolean;
  /** The nonce this card's last add was given, or `undefined` for a card that did not just
   *  arrive — passed through as the mark's `key`, so a second add replays it. */
  landedKey: number | undefined;
  /** The stack's zoom, handed down whole rather than resolved into pixels above: the two
   *  numbers this card needs are derived here, from the same functions the list's own height
   *  was, so there is no second arithmetic to keep in step. */
  zoom: number;
  onArm: (index: number) => void;
  onOpenNow: (index: number) => void;
  onRelease: () => void;
  /** The reflow's tween, decided once by the stack so every card animates on the same clock. */
  transition: Transition;
  /** The sentence the `RULE BREAK` mark carries, or `null` when there is nothing wrong. */
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined);
  // The whole card (`grid`, 488×680), not the `art` crop. Fed `null` for an orphan, whose
  // printing has left the card database — nothing tries to draw a picture of a card that is not
  // there, and the hook's null story is "no state machine at all".
  const face = useImageRetry(
    card.needsReview === null ? cardImageUrl(card.cardId, 0, DECK_CARD_VARIANT) : null,
  );
  const finish = soleFinish(card.finishes);
  // The allocator claims no copy for an inactive category, so every row in one reads 0 owned
  // by construction — a shortage mark there would report one the reader does not have. The
  // switch, never the kind: a Maybeboard switched *on* is short of copies like any other pile.
  const short = card.categoryActive && card.ownedQuantity < card.quantity;
  // There is a URL and it has not failed. Not "the bytes have arrived" — nothing here can know
  // that, and nothing needs to: the frame underneath is what shows while they are on their way.
  const drawing = face.src !== null && !face.failed;

  return (
    // Collapsed, pulled up over its neighbour; open, standing 8px clear of it. The margin is
    // the whole animation — nothing scales, nothing translates — because a margin is what
    // pushes the cards *after* it down, which is the interaction this is named for. `motion`
    // writes it as an inline style, which the shipped CSP allows (`style-src-attr`); both
    // margins change per step and they share one clock, which is what makes a step read as one
    // card sliding rather than as two cards swapping.
    //
    // `initial={false}`, so a stack that has just mounted draws itself collapsed rather than
    // animating into it — a category scrolling into view is not a gesture.
    <motion.li
      ref={dragRef}
      // Arming, not opening. The dwell is the fix; see `useFlipThrough`. The close lives on
      // the list above, because leaving *this* card for the next one is not leaving the stack.
      onPointerEnter={() => onArm(index)}
      // On the item rather than on the button, which is `focus-within`'s reach and is
      // load-bearing: the controls drawn over the card are siblings of the button, so a caret
      // stepping from the card into its own stepper would otherwise close the card under it.
      onFocus={() => onOpenNow(index)}
      onBlur={onRelease}
      // The whole card, face and foot together: a right-click on the price or the set code is a
      // right-click on the card. The keydown half is here rather than on the button because the
      // controls drawn over the card are siblings of that button — Shift+F10 with the caret on
      // the stepper is still a question about this card.
      {...deckCardMenuProps(card, actions)}
      {...(open ? { [STACK_OPEN_ATTR]: "" } : {})}
      // The card's whole body, so a click on its data line — which is outside the button on
      // purpose — is a click on the card and not on the desk. See `CARD_BODY_ATTR`.
      {...deckCardBodyProps()}
      {...deckCardSelectedProps(selected)}
      initial={false}
      animate={{ marginBottom: open ? STACK_LIFTED_MARGIN : stackCollapsedMargin(zoom) }}
      transition={transition}
      className={cn(
        // **No z-index here, deliberately, and an open card is no exception.** These are
        // `relative` siblings with a negative bottom margin, so painting order is document
        // order: every card is drawn over the one before it, and that *is* the stacked look —
        // the reveal strip a reader runs down is the top 34px of a card its successor has not
        // covered. Raising the open card inverts that for the whole tail of the stack, and it
        // does it at the worst moment: `LAYER.raised` lands on the first frame while the cards
        // after it are still 293px from where they are going, so the card appears to jump in
        // front of the stack and then have the stack catch up around it.
        //
        // Doing nothing is the fix. The cards after it move out of the way and uncover it, and
        // once they have settled nothing is over it anyway — an open card's bottom is
        // `N·34 + 319` and its successor's top is `N·34 + 327`, 8px clear. The list keeps its
        // own `LAYER.raised` (see `CardStack`): that one lifts the *group* over the groups
        // below it in the column, which is a different question and still needs answering,
        // because the cards it pushes down leave the box on purpose.
        //
        // **No `overflow-hidden` either, and that moved rather than went away.** The card's
        // face clips its own corners now, and the data line under it clips its own — because
        // the data line has to be able to hang 24px *below* the face and a clip here would cut
        // it off at the picture's edge.
        "relative block rounded-lg border",
        // Deeper than Tailwind's own `shadow-lg`/`shadow-2xl`, whose alphas are 0.1 and 0.25 —
        // written for a card on white. These sit on the app's felt at 0.16 lightness, where a
        // 10 % shadow is not a shadow, and a stack whose cards do not separate is a texture.
        open
          ? "shadow-[0_25px_50px_-12px_rgb(0_0_0/0.55)]"
          : "shadow-[0_10px_15px_-3px_rgb(0_0_0/0.45),0_4px_6px_-4px_rgb(0_0_0/0.45)]",
        // The caret lands here when the menu this card opened is closed — see
        // `deckCardMenuProps`, which is what makes the element focusable at all. An outline
        // rather than nothing, because a hand-back the reader cannot see is half a hand-back;
        // `focus-visible`, so a menu dismissed by clicking away draws none. It is outset where
        // the button inside is inset, and that is right here: the button is the card *face* and
        // this is the whole card, so the ring traces the object rather than the picture — and
        // focusing this opens the card (`onFocus` above), which lifts it clear of its neighbour.
        FOCUS,
        // A card that breaks a rule is outlined in the destructive colour — the loudest of the
        // three signals it can carry, and the only one that changes the card's own edge.
        //
        // **The data line below repeats this expression and has to**: it draws the same edge for
        // the length of its own box, over the top of this one. See the comment on it.
        ruleBreakText ? "border-destructive" : "border-border",
        // Outside all of that, and therefore never confusable with the card's own edge: a ring
        // is painted beyond the border box, so a picked card that also breaks a rule wears a
        // gold ring around a red card rather than one edge arguing with itself.
        selected && SELECTED_CARD,
      )}
    >
      <button
        type="button"
        // Every mark below is `aria-hidden`, so this string is the whole of what a keyboard
        // reader gets — including the red shortage figure, which nothing else would say.
        aria-label={deckCardName(card, ruleBreakText)}
        // How the card pane hands the caret back after a printing swap replaces this card.
        {...deckCardProps(card)}
        onClick={onSelect ? () => onSelect(card) : undefined}
        // Inset, because the button *is* the card face: its edge sits 1px inside the card's own
        // border with the data line butted against its bottom, so an outline standing 2px off
        // it is drawn over both and reads as a thicker card rather than as focus.
        className={cn("block w-full cursor-pointer text-left", FOCUS_INSET)}
      >
        {/* The card. An explicit height rather than an `aspect-[488/680]`, because the stack's
            arithmetic depends on this number being exactly {@link stackImageHeight} — and it is
            set here, from that same function, so the frame and the file's own sums cannot drift.

            `object-cover` against a 210:293 box where the card is 210:292.6, which crops **0.4px**
            off it. Worth taking over `object-contain`: a fraction of a pixel of the card's border
            is invisible, and a letterbox bar between the printed frame and an overlay strip would
            not be. The rounding is at most half a pixel at any zoom, for the same reason.

            An inline style rather than a height utility, and not merely by preference: Tailwind
            scans source text for whole class names, so a computed one emits no rule at all and
            the card would silently have no height. */}
        <span
          style={{ height: stackImageHeight(zoom) }}
          className="relative block overflow-hidden rounded-[7px] bg-surface"
        >
          {/* **The frame under the picture, drawn whether or not there is one.**

              It used to be the picture's `else` — a name and a reason, centred in an empty box —
              and that made the commonest state of this component the ugliest: a hundred-card
              category is a hundred lazy `<img>`s, and until each one's bytes land its card is a
              grey rectangle. The card is *known* before its picture is; what was missing was
              anywhere to put what is known.

              So it is a printed card's own three bands, in the app's hand: name and cost in the
              title bar, the reason in the middle where the art goes, the type line at the foot.
              A stack scrolling into view now reads as cards resolving rather than as boxes
              filling, and the three no-picture states inherit the frame instead of each being a
              consolation. The reason band is empty when there is a picture on the way — the
              frame is a backdrop then, and a backdrop should say nothing. */}
          <span className="absolute inset-0 flex flex-col bg-surface">
            <span
              style={{ background: FRAME_BAR, paddingLeft: FRAME_NAME_INSET }}
              className="flex h-[27px] items-center gap-1.5 border-b border-border pr-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-medium">
                {card.name}
              </span>
              <ManaText source={card.manaCost} className="shrink-0 text-[0.625rem] leading-none" />
            </span>
            <span className="flex flex-1 items-center justify-center px-2 text-center text-[0.625rem] text-dim">
              {drawing
                ? ""
                : face.retrying
                  ? "Retrying…"
                  : card.needsReview !== null
                    ? "No card"
                    : "No image"}
            </span>
            <span
              style={{ background: FRAME_BAR }}
              className="flex h-5 items-center truncate border-t border-border px-1.5 text-[0.5625rem]"
            >
              {card.typeLine}
            </span>
          </span>

          {drawing && (
            <CardImage
              src={face.src as string}
              // Decoration: the button already says the card's name, and an `alt` repeating it
              // would have a screen reader read every card twice.
              alt=""
              draggable={false}
              // Lazy, because a deck's groups are plain scrollers rather than virtualised
              // walls — a hundred-card category really is a hundred mounted cards, and the
              // browser's gate is the only thing bounding what they ask for.
              loading="lazy"
              decoding="async"
              onError={face.onError}
              // `relative` and not `absolute`: it has to paint over the frame above it, and a
              // positioned sibling later in the document does that with no z-index at all.
              className="relative block size-full object-cover"
            />
          )}

          {/* The sheen without the chip — the finish is said in words on the data line below,
              where there is room for the word and no corner to compete for. */}
          <FoilOverlay finish={finish} mark={false} />

          {/* The reveal strip: what the app knows that the printed card cannot. Over the card's
              own title bar and **left-aligned**, which is a reversal — {@link CARD_MARKS_STRIP}
              has the whole of why. The scrim is what keeps a mark legible over art of any
              brightness. */}
          <span className={cn(CARD_MARKS_STRIP, "bg-gradient-to-b from-bg/70 to-transparent")}>
            <QuantityTag quantity={card.quantity} name={card.tagName} color={card.tagColor} />
            {/* Gold, spelled out, tucked under the tag's tail. The `RULE BREAK` mark is red,
                boxed and in the opposite corner — see `CardMarks.tsx` for why the pair is drawn
                once and what keeps the two from being confusable. */}
            {card.gameChanger === true && <GameChangerBanner />}
          </span>

          {ruleBreakText !== null && (
            <RuleBreakMark text={ruleBreakText} className="absolute top-1 right-[5px]" />
          )}

          {/* **Inside the face, which is what makes it findable in a fanned pile.** The face is
              the one box here that a collapsed card still shows 34px of, so a mark laid over it
              is a lit band and a bright hairline exactly where the reader is scanning. Laid
              over the marks strip rather than under it — the strip's tag is 11px type on its own
              scrim, and a wash tints it without touching the contrast between the glyphs and the
              chip they are printed on, while a mark the tag could cover would be missing on
              precisely the cards that have one. That trade got louder on 2026-08-15, when the
              wash went gold at 40 % over this strip with a glow behind it, and it is the one
              place to look first if the quantity tag ever stops reading during an add. See
              {@link LandedMark}.

              `rounded-[7px]` is the face's own corner, spelled again because the mark cannot
              inherit it — {@link LandedMark} has why. */}
          {landedKey !== undefined && <LandedMark key={landedKey} className="rounded-[7px]" />}
        </span>
      </button>

      {/* **The card's foot, and a sibling of the button rather than a band inside the picture.**

          Facts about the *printing* rather than about the deck, in the data face and one step
          dimmer: rarity, which printing this is, its finish, what one copy costs, and how far
          short of it the collection falls. It sat over the bottom of the art until now, which
          cost the card its printed text box — the one part of a card that says what it does —
          to say five things that fit perfectly well underneath it.

          The negative margins are what make it the same object as the face: `-mt-1` rides it
          {@link STACK_DATA_RISE}px up so the face's clipped corners cover its square ones, and
          `-mx-px` puts its own border exactly on top of the card's, so the two are one line
          rather than two.

          **That one line is therefore drawn by two elements, and both have to carry the card's
          colour.** This bar is `relative` and later in the document than the face, so its own
          border paints *over* the card's along every pixel of its height — a rule break outlined
          the card in destructive and then this bar put 28px of `border-border` back through the
          left and right edges of it, which is the one thing the outline exists to prevent: the
          card stopped reading as a single object exactly where the foot joins the face. So the
          colour is `ruleBreakText`'s, the same expression the card's own edge uses, and the two
          must move together. **`border-x` and no bottom edge** for the other half of the same
          idea: the bar's bottom border sat 1px *above* the card's rather than on top of it, so a
          red card would have had a 2px foot and a 1px everything-else. The card's own border is
          the bottom edge, at every zoom, in whichever colour it is.

          It is **outside** the button on purpose. The button is the card face, which is what
          `FOCUS_INSET` traces and what the reader thinks they are pressing; and everything here
          is a fact rather than a mark, so unlike the overlays above it this text is genuinely
          announced instead of being swallowed by the button's `aria-label`. The price and the
          printing had no reader at all while they were inside it. */}
      <span
        style={{ height: stackDataHeight(zoom), marginTop: -STACK_DATA_RISE }}
        className={cn(
          "relative -mx-px box-border flex items-center gap-1.5 rounded-b-[7px] border-x",
          "bg-surface pr-1.5 font-mono text-[0.625rem] text-dim",
          ruleBreakText !== null ? "border-destructive" : "border-border",
        )}
      >
        <RarityGem rarity={card.rarity} className="ml-1.5" />
        {/* The code is what fits; the set's name is one hover away, because `PF26` is not a
            word anybody knows. `setName` comes from `cards` and is `null` for an orphan — then
            the code stands on its own rather than being annotated with a guess. */}
        <span
          title={card.setName === null ? undefined : `${card.setName} · #${card.collectorNumber}`}
          className="min-w-0 flex-1 truncate"
        >
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
        {/* `Sparkles` for foil, `Gem` for etched — never one glyph with a modifier, because
            etched is a third thing and not a kind of foil. A printing sold in both finishes is
            `null` here and draws nothing: the mark states what the object *is*, and 61 % of the
            corpus has a foil version. */}
        {finish !== null && <FinishMark finish={finish} />}
        <span className="shrink-0 tabular-nums text-text">
          {formatPrice(card.unitPrice, currency)}
        </span>
        {/* Drawn only where it says something: a fully covered card prints nothing at all,
            because sixty ticks are sixty things to read past on the way to the three that
            matter. `aria-hidden` even out here, because the button beside it already says the
            shortage in words and a screen reader should not hear "1 slash 2" as well. */}
        {short && (
          <span
            aria-hidden="true"
            title={`You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`}
            className="shrink-0 tabular-nums text-destructive"
          >
            {card.ownedQuantity}/{card.quantity}
          </span>
        )}
      </span>

      {/* **Over the card, never in it.** An absolutely positioned column takes no height, so a
          card is still {@link STACK_CARD_HEIGHT} and `stackHeight` is still a function of the
          count alone — the no-reflow property survives the controls by construction rather than
          by care.

          In the right margin, below the marks strip, standing on the art: `top-9` clears the
          27px title bar the tag and the banner are in, and the column runs down from there
          rather than across the foot, where it would cover the data line it now sits beside.

          **The offset is the same 36px it has always been and the column under it is twice as
          tall as of 2026-08-15** — three 48px boxes and two 4px gaps, 152px, so it ends 188px
          down a 293px face at 1×. That sum is unscaled chrome on a scaled card, which is fine
          going up and runs out at the bottom of the ladder: 188 needs a face 188 tall, so the
          column clears at every stop but **0.5×**. Measured in Storybook over CDP (2026-08-15,
          `decks-editor--commander-deck`, real Chromium layout): at 1× the column clears the
          face's foot by **105px**, at 0.67× by **8px** — the last stop that fits — and at 0.5×
          it overruns it by **42px**, which puts the `−` button **17px below the whole card**,
          over the reveal strip of the card beneath. Judged worth it, because the column is drawn
          on the **open** card alone and a reader at 50 % is reading a pile rather than pressing
          on it; it is the first number to check if this column is ever made bigger again, and
          the fix if it ever matters is to scale the box with the zoom and floor it at the 24px
          this used to be.

          Revealed by **this card being open** rather than by the pointer being on it, which is
          the one thing `group-hover:` could never get right here — see `revealedWhenOpen`.

          A **sibling** of the button rather than a child, because a button may not contain a
          button: the whole card is the control that opens it, and these are three more. */}
      <DeckCardControls
        card={card}
        actions={actions}
        layout="card-column"
        className={cn("absolute top-9 right-1.5", revealedWhenOpen(open))}
      />
    </motion.li>
  );
}
