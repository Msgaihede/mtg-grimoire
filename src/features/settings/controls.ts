/**
 * The class recipes the Settings page's panels are drawn from.
 *
 * Two now. `ErrorLogPanel` and `UpdatePanel` each carried a `BUTTON` constant and the
 * second one said so in writing — *"the same string `ErrorLogPanel` carries, down to the
 * character"* — which is a duplication that had already been noticed and had nowhere to go.
 * This file is where it goes: a folder-level module for the vocabulary two panels share,
 * beside `formFields.ts` in the deck folder for the same reason.
 */
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A panel's button — the app's existing bordered control.
 *
 * The press half is {@link PRESS} and is not spelled here; what is this file's is the box
 * (an inline row with a gap and a border), the focus ring, and the out-of-reach clause.
 *
 * **`disabled:` rather than `aria-disabled:`, which is the app's usual rule reversed and is
 * correct at both call sites.** Retry and Install are buttons with genuinely nothing to do
 * while a job is running, so they use the attribute — and a `disabled` button that still
 * depressed under the finger would be a third answer disagreeing with both the greyed look
 * and the refusal. `disabled:active:scale-100` holds it at full size for exactly that.
 */
export const BUTTON =
  "inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm " +
  `${PRESS} ` +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";

/**
 * The panel switch — a `role="switch"` in {@link BUTTON}'s box.
 *
 * Two families joined: the ARIA is `DeckSettingsForm`'s `TheorySwitch`, which is the app's one
 * real switch, and the box is this file's {@link BUTTON}, which is what a control on this page
 * looks like. Here rather than in the panel because this file exists to hold the vocabulary two
 * panels share, and the second one that wants a switch must not invent a third look.
 *
 * **What is deliberately *not* in it is a tween of its own, and copying `TheorySwitch`'s would
 * have broken the press.** That switch is not built on {@link BUTTON}, so it spells a
 * colours-only tween and a 150ms duration itself; folded in here those two land in the same
 * `tailwind-merge` groups as {@link PRESS}'s tween list and its `--duration-fast`, so they
 * **win** — and the list they replace is the one naming `scale`, which leaves
 * `active:scale-[0.97]` with nothing to travel over. Tailwind v4 writes `scale-*` as the `scale`
 * longhand, which is the trap `src/CLAUDE.md` records: the press would simply snap, invisibly to
 * every test and visibly only in the built CSS. Measured through `twMerge` on 2026-08-22, which
 * is the only way to see it — the conflict is a library's resolution of two strings neither of
 * which is wrong on its own. It buys nothing anyway: `PRESS` already tweens `color` and
 * `border-color`, which is the whole of what a switch's tone change is, at the app's own
 * `--duration-fast` and with the reduced-motion opt-out already inside it.
 */
export const SWITCH = cn(BUTTON, "h-8 shrink-0 px-2.5 text-xs");

/** What a switch's box is coloured by. Accent when on, quiet-until-hovered when off. */
export const switchTone = (on: boolean): string =>
  on ? "border-accent text-accent" : "border-border text-dim hover:border-accent hover:text-accent";
