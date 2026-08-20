/**
 * Every duration and easing this app animates with, named for what the thing *does*.
 *
 * It exists for the same reason `layers.ts` does. The visual direction's "150ms budget" was
 * real policy and had no home: it lived as **88 hand-copied `duration-150` literals across 30
 * files** and one sentence in a comment in `index.css`. A number copied 88 times is not a
 * budget, it is 88 independent decisions that happen to agree today — nothing tells you which
 * of them is a drawer crossing the window and which is a chevron turning 90°, and nothing
 * stops the 89th from being 300.
 *
 * So: **a consumer imports a preset and never writes a number.** If a surface needs a timing
 * that is not here, the answer is a new preset in this file with a sentence saying what it is
 * for — not a literal at the call site.
 *
 * ## The scale
 *
 * Three tiers, from the spec's §3 table. The app's stated 150ms budget is kept as the
 * *interaction* tier and widened only where a surface travels a real distance:
 *
 * | tier | value | for |
 * |---|---|---|
 * | {@link DURATION.fast} | 120ms | press feedback, chevrons, colour |
 * | {@link DURATION.base} | 180ms | popups, status lines |
 * | {@link DURATION.slow} | 260ms | dialogs, which cross the window, and the deck stack's reflow |
 *
 * `src/index.css` carries the same three as `--duration-*` and the same three curves as
 * `--ease-*`, so a CSS-only transition and a JS one cannot drift. `motion.test.ts` compares
 * the two files and fails if they do.
 *
 * ## Why the presets are prop bags and not `Variants`
 *
 * Every preset here is spread onto the element:
 *
 * ```tsx
 * <AnimatePresence>
 *   {open && <motion.div {...scrim} className="fixed inset-0 bg-black/60" />}
 * </AnimatePresence>
 * ```
 *
 * A variant *label* propagates from a parent to any child that has not defined its own, which
 * is a feature for an orchestrated list and a trap for these six — they are leaves that
 * happen to sit inside other animated things. A spread also type-checks against `motion`'s own
 * prop types at the call site, where the mistake is made. {@link variants} is here for the case
 * that genuinely wants propagation; nothing in the app needs it yet.
 *
 * Enter and exit carry **different** curves and often different durations, which is why each
 * target holds its own `transition` rather than the preset exposing one. A surface arriving
 * decelerates into place ({@link EASE.enter}); a surface leaving accelerates away
 * ({@link EASE.exit}); something moving between two on-screen positions does both
 * ({@link EASE.standard}).
 *
 * ## Reduced motion
 *
 * Nothing here branches on it. The single `MotionConfig` in `src/App.tsx`, set to the reader's
 * preference, is the one switch — and it is load-bearing rather than decorative, because
 * `motion` ships `reducedMotion: "never"`. Read that component's comment before assuming what
 * it does: it is a deliberately *weaker* rule than the app's `motion-reduce:transition-none`,
 * because opacity and colour keep animating under it.
 *
 * (Spelled without its angle bracket, so that `tokens.test.ts`'s sweep — which counts opening
 * tags across `src/` — reads this paragraph as prose rather than as a second provider.)
 *
 * ## Two `motion` APIs this file cannot give you
 *
 * `AnimatePresence`'s out-of-flow exit mode, and the view-transition builder exported from
 * `motion`'s root. Both append a `<style>` **element** at runtime, which the shipped CSP
 * blocks — and both fail *silently*, in the shipped exe only. `src/lib/tokens.test.ts` bans
 * them by name and is the only thing that can; see the comment on that sweep. This paragraph
 * spells neither name for that reason.
 */
import type { TargetAndTransition, Transition, Variants } from "motion/react";

/** A cubic-bézier curve, as both `motion` and CSS spell one. */
export type Bezier = [number, number, number, number];

/**
 * The three tiers, in **milliseconds** — the unit the CSS tokens and the design conversation
 * are both in. `motion` wants seconds; {@link seconds} is the one place that conversion
 * happens.
 */
export const DURATION = {
  /** Press feedback, chevrons, a colour change. Below this a transition reads as a glitch. */
  fast: 120,
  /** The interaction tier, and the app's old 150ms budget rounded to the scale. */
  base: 180,
  /**
   * For a surface that crosses the window — a modal over a scrim, the card pane arriving beside
   * the view — and for the deck stack's 293px reflow, which travels about as far and is *read*
   * rather than dismissed.
   */
  slow: 260,
} as const;

export type DurationTier = keyof typeof DURATION;

/** Milliseconds to the seconds `motion` measures a `Transition` in. */
export const seconds = (ms: number): number => ms / 1000;

/** A curve as CSS writes it, so a token and a preset can be compared character for character. */
export const cssEase = (curve: Bezier): string => `cubic-bezier(${curve.join(", ")})`;

/**
 * Three curves, named for the direction of travel rather than for their shape.
 *
 * Kept identical to `index.css`'s `--ease-standard` / `--ease-enter` / `--ease-exit`, which are
 * a real Tailwind v4 namespace and therefore also spellable as `ease-standard`, `ease-enter`
 * and `ease-exit` utilities. Tailwind's own `ease-in`/`ease-out`/`ease-in-out` are untouched.
 */
export const EASE = {
  /** Both ends eased. For something moving between two positions it never leaves. */
  standard: [0.4, 0, 0.2, 1],
  /** Decelerating. For something arriving: it enters fast and settles. */
  enter: [0, 0, 0.2, 1],
  /** Accelerating. For something leaving: it gives way immediately and is gone. */
  exit: [0.4, 0, 1, 1],
} satisfies Record<string, Bezier>;

/** The three tiers as ready `Transition`s, for a consumer that is not animating enter/exit. */
export const TRANSITION = {
  fast: { duration: seconds(DURATION.fast), ease: EASE.standard },
  base: { duration: seconds(DURATION.base), ease: EASE.standard },
  slow: { duration: seconds(DURATION.slow), ease: EASE.standard },
} satisfies Record<DurationTier, Transition>;

const arriving = (ms: number): Transition => ({ duration: seconds(ms), ease: EASE.enter });
const leaving = (ms: number): Transition => ({ duration: seconds(ms), ease: EASE.exit });

/**
 * A preset in the shape it is used: spread onto a `motion.*` element inside `AnimatePresence`.
 *
 * `animate` and `exit` each carry their own `transition`, so the two directions can differ.
 */
export interface EnterExit {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
}

/**
 * The full-window backdrop behind a dialog — `bg-black/60`, `fixed inset-0`.
 *
 * `base` in **both** directions, which is not the usual asymmetry and is deliberate: the scrim
 * has a partner. Entering it is quicker than the {@link dialog} it stands behind — `base`
 * against `slow` — so the ground darkens and *then* the panel arrives; leaving, the two are the
 * same length so the panel is never seen dismissing itself over unscrimmed content. Pair the
 * two in the same `AnimatePresence`.
 */
export const scrim: EnterExit = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: arriving(DURATION.base) },
  exit: { opacity: 0, transition: leaving(DURATION.base) },
};

/**
 * A centred surface drawn over the view: `Dialog` (and through it the deck editor's
 * categories, tags, history and settings), `CreateDeckDialog`, `TheoryDiffDialog`,
 * `ImportDeckDialog`, and `CardDetailPane`, which is docked but arrives by scaling from its own
 * right edge.
 *
 * **There is no drawer preset, and its absence is a decision** (2026-08-14). `drawerRight` slid a
 * right-docked panel in from `x: "100%"` for the deck editor's two drawers; both are centred
 * modals now, `CardDetailPane` had already refused it in writing — 384px of travel inside
 * `AppShell`'s `overflow-auto` main region is 384px of scrollable overflow — and a preset with no
 * consumer in the module whose whole discipline is "timings live here and nowhere else" is the
 * drift this file exists against. A future right-hand drawer adds one back with a sentence saying
 * what it is for, which is the same rule as any other new preset.
 *
 * The scale is 0.97 and not 0.9 on purpose — a dialog that grows visibly reads as a zoom, and
 * this one is meant to read as arriving. Exits a touch *above* 1 so the gesture reverses rather
 * than retracing.
 */
export const dialog: EnterExit = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: arriving(DURATION.slow) },
  exit: { opacity: 0, scale: 0.98, transition: leaving(DURATION.base) },
};

/**
 * A small popup anchored to the control that opened it: the set picker, `AddToCollection`,
 * `ValidationPanel`.
 *
 * **The transform origin is the consumer's**, and it matters more than anything in here: a
 * popup that grows from the middle of itself reads as unrelated to its trigger. Set it with
 * Tailwind's whole-literal utilities — `origin-top-right` for a popup pinned `right-0` under
 * its trigger, `origin-top-left` for a left-aligned one, `origin-bottom-*` for one that opens
 * upward. Never build the class by interpolation; see `layers.ts` for why.
 *
 * Leaves on `fast` while it arrives on `base`: a dismissal that lingers feels stuck, and the
 * reader has already looked away.
 */
export const popup: EnterExit = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: arriving(DURATION.base) },
  exit: { opacity: 0, scale: 0.98, transition: leaving(DURATION.fast) },
};

/**
 * An inline `role="status"` / `role="alert"` line that **grows into place** instead of shoving
 * everything below it down by its full height the instant it appears.
 *
 * It animates `height` from 0 to `auto`, which `motion` measures for you — and which needs
 * `overflow-hidden` on the element, or the text is fully drawn at zero height for the first
 * frame. That class is the consumer's to add, because it is layout and this is timing.
 *
 * **The gap above the line is the trap.** A margin on a box whose height is animating to 0
 * still occupies its margin, so the layout still jumps — by the margin instead of by the whole
 * 32px, which looks like a bug rather than like a fix. Two ways out, and either is fine: put
 * the spacing on a child *inside* the animated element, or use {@link statusLineGap} and drop
 * the margin class.
 */
export const statusLine: EnterExit = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1, transition: arriving(DURATION.base) },
  exit: { height: 0, opacity: 0, transition: leaving(DURATION.base) },
};

/**
 * {@link statusLine} with its top margin animated too.
 *
 * A function and not a constant because the gap belongs to the surface, not to the vocabulary:
 * pass the pixel value of the margin class you would otherwise have written (`mt-1` is 4,
 * `mt-2` is 8, `mt-3` is 12) and remove that class from the element.
 */
export function statusLineGap(marginTop: number): EnterExit {
  return {
    initial: { height: 0, opacity: 0, marginTop: 0 },
    animate: { height: "auto", opacity: 1, marginTop, transition: arriving(DURATION.base) },
    exit: { height: 0, opacity: 0, marginTop: 0, transition: leaving(DURATION.base) },
  };
}

/**
 * Everything a press recipe is except the dip itself — the property list, the tier, the curve
 * and the reduced-motion opt-out.
 *
 * **Module-private, and it exists so that the property list is written once.** {@link PRESS}
 * and {@link PRESS_SOFT} differ by one utility and nothing else; spelling the other eleven
 * out twice, twelve lines apart, would be the same duplication this pair was extracted to
 * end — one file down from the twelve call sites instead of across them.
 *
 * **The property list is written out one longhand at a time, and `scale` is named
 * explicitly.** Two reasons, and both have shipped as bugs. A colour utility beside a
 * transform one compiles to the same CSS longhand, so tailwind-merge keeps whichever it saw
 * last and silently drops the other — invisible until somebody presses the control. And
 * Tailwind v4's `scale-*` writes the `scale` longhand rather than `transform`, so a list
 * naming only `transform` does not tween the press at all and it snaps.
 *
 * **Verify both in the built CSS, never in source** — and that goes double now the two
 * exports are template literals. A join that breaks a class name in half emits no rule at
 * all, and nothing goes red: source still reads correctly, `dist/` simply has no
 * `active:scale-[0.97]` in it. Every class name here is written out whole for Tailwind's
 * scanner, which reads text and knows nothing about the concatenation.
 */
const PRESS_BASE =
  "transition-[color,background-color,border-color,opacity,transform,scale] " +
  "duration-[var(--duration-fast)] ease-standard " +
  "motion-reduce:transition-none";

/**
 * The press recipe, as **CSS classes** — what a pressable control that is not a `motion`
 * element wears. {@link press} below is the same feedback for one that is.
 *
 * It was hand-copied onto every pressable control in the app, with the paragraph on
 * {@link PRESS_BASE} pasted beside almost all of them, until commit `b0a49aa` — and
 * `UpdatePanel` had said in writing that its copy was "the same string `ErrorLogPanel`
 * carries, down to the character". So: one string, in the module `src/CLAUDE.md` already
 * names as where timings live.
 *
 * **The reduced-motion opt-out came along inside it, which moved that guarantee's guard.**
 * `tokens.test.ts` sweeps source *text* for a tween utility and demands the opt-out within 400
 * characters of it, so a call site that folded its hand-written list into this constant spells
 * no such utility any more and is no longer reached by that sweep. Nothing lost its opt-out —
 * it is pinned once here instead, by `motion.test.ts`'s "compose into whole class names", for
 * every site at once. What stopped being safe on 2026-08-16 is the obvious inference: a file
 * naming no tween is no longer a file that runs none, so absence from that sweep says nothing
 * about a control in it.
 *
 * **What a control does when it is out of reach is deliberately *not* in here.** Some sites
 * add `disabled:active:scale-100` because they genuinely use the attribute, some add
 * `aria-disabled:active:scale-100` because they grey as the reader types, and the rest never
 * grey at all — grep `active:scale-100` for the current split. Those are three different
 * facts about three kinds of control, not drift, and folding them together would put a
 * `disabled:` variant on chips that must never leave the tab order.
 */
export const PRESS = `${PRESS_BASE} active:scale-[0.97]`;

/**
 * {@link PRESS} at 0.99 rather than 0.97, for a control as wide as its panel.
 *
 * `MarketplacePanel`'s marketplace rows are the whole width of the settings column, and a
 * full-width row that dips 3% reads as the page moving rather than as a button going down.
 * A second number with a reason of its own, which is the bar for adding one here — and the
 * number is the *whole* of the difference, which is why both are built from
 * {@link PRESS_BASE}.
 */
export const PRESS_SOFT = `${PRESS_BASE} active:scale-[0.99]`;

/** {@link press}'s shape: the two gesture props plus the one transition they share. */
export interface PressFeedback {
  whileHover: TargetAndTransition;
  whileTap: TargetAndTransition;
  transition: Transition;
}

/**
 * Hover and press feedback for a button or a chip.
 *
 * Small numbers on purpose. 1.02 and 0.96 are felt rather than seen, which is what a control
 * that is pressed a hundred times an hour needs; anything larger turns a table of buttons into
 * a trampoline. Both are transforms, so both go instant under reduced motion and the feedback
 * survives as a step rather than a slide.
 *
 * It does **not** carry a `whileFocus`. A focus ring is not motion, and scaling on focus moves
 * a control out from under a caret the reader just put there.
 */
export const press: PressFeedback = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.96 },
  transition: TRANSITION.fast,
};

/**
 * The deck stack's one moving card.
 *
 * Only ever one: opening card *N+1* instead of card *N* leaves every card's top unchanged
 * except that one, which travels 293px (`CardStack`'s own arithmetic). So this is a single
 * `margin-bottom` tween and the values belong to `CardStack`, which owns the geometry —
 * `STACK_CARD_HEIGHT`, `STACK_ADVANCE` and the collapsed margin are not this file's to know.
 *
 * `standard` and not `enter`: the card is moving between two positions it occupies either way,
 * not arriving from nowhere.
 *
 * **`slow`, and it was `base` until 2026-08-14.** The spec's table filed the stack reflow on the
 * interaction tier with the popups, and 180ms is right for a surface that *appears* — but this
 * one moves 293px, which is drawer distance, and a reader running down a stack watches it happen
 * on every step rather than once. At 180ms the card arrives before the eye has followed it and
 * the flip-through reads as snapping. The tier is unchanged and nothing else moved with it; this
 * preset simply sits one rung further down than it did.
 */
export const stackCard: Transition = TRANSITION.slow;

/**
 * An {@link EnterExit} as `Variants`, for the one case a prop bag cannot do: a parent that
 * drives its children by label.
 *
 * The labels are `hidden` / `visible` / `exit` and not `initial` / `animate` / `exit`, because
 * a variant named after the prop that selects it reads as a tautology at the call site.
 */
export function variants(preset: EnterExit): Variants {
  return { hidden: preset.initial, visible: preset.animate, exit: preset.exit };
}
