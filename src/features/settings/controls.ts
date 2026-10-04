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
 *
 * **The finger's floor is here, once, for every panel on the page** (2026-10-04). The light app's
 * phone face draws these same panels, and driven at 360 and 412px under a touch pointer every
 * button on the Sync panel measured 34px tall — the roster's Rename and Remove 28 — against the
 * 44 a finger needs and the 52 of the row that opens the panel. A floor and not a height: under a
 * mouse the query does not match and every box is what it was (measured: the desktop face's
 * panels at 1280 and 1024px, box for box), and a call site that names a smaller height of its
 * own — the roster's two presses, {@link SWITCH} — is still lifted, because a minimum outranks
 * a height. The label stays centred by the row's own alignment.
 */
export const BUTTON =
  "inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm " +
  "coarse:min-h-[var(--target-min)] " +
  `${PRESS} ` +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";

/**
 * What a text box on this page adds for a finger: type at 16px.
 *
 * **Below 16px a phone's browser zooms the page when the box takes the caret** — iOS always, some
 * Android browsers too — and never zooms back, so one press on a 12px code box leaves the reader
 * panning a page that fitted a moment ago. It is the light app's phone face's own rule for every
 * box it draws (`mobile/phone/CabinetFilters.tsx`), said here for the desktop's panels that face
 * also draws. Under a mouse the query does not match and the box keeps the size its call site
 * gave it. The height is the call site's to add: a one-line box takes the finger's floor, a code
 * box takes room for its lines.
 */
export const TOUCH_FIELD = "coarse:text-base";

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
