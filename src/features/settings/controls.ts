/**
 * The class recipes the Settings page's panels are drawn from.
 *
 * One so far. `ErrorLogPanel` and `UpdatePanel` each carried a `BUTTON` constant and the
 * second one said so in writing — *"the same string `ErrorLogPanel` carries, down to the
 * character"* — which is a duplication that had already been noticed and had nowhere to go.
 * This file is where it goes: a folder-level module for the vocabulary two panels share,
 * beside `formFields.ts` in the deck folder for the same reason.
 */
import { PRESS } from "@/lib/motion";

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
