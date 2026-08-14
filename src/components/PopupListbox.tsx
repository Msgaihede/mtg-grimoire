import { type ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import { popup } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The listbox's own box, so that the fade-out has somewhere to be inert from.
 *
 * A component and not a `motion.div` written inline, and the reason is the whole of why this
 * exists: `AnimatePresence` keeps the **element it was last handed** while that element leaves,
 * so an exiting panel goes on rendering the props of the render in which it was still open —
 * including its `className`. A flag read upstairs can therefore never reach it. `useIsPresent`
 * is read *inside* the presence, which is the only place the answer changes, and children
 * spread through untouched so nothing had to be threaded down to get it.
 *
 * What it buys is a state this control has never been in before. Its three dismissals are
 * Escape, a `window` mousedown listener and an `onBlur`, and **all three come down with the
 * flag** — so for the length of the fade the panel is painted, hit-testable, and watched by
 * nothing at all. A press on it would land on a listbox that can no longer close itself.
 *
 * Shared, so that the guard is one thing rather than two that can drift: `SetCombobox`'s set
 * list and `QuickAdd`'s suggestions are both drawn in one of these.
 */
export function PopupPanel({ className, children }: { className?: string; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      {...popup}
      // Not in the accessibility tree on the way out either: a second, stale copy of the panel's
      // list is worse than none, and the caret left with the flag.
      aria-hidden={present ? undefined : true}
      className={cn(className, !present && "pointer-events-none")}
    >
      {children}
    </motion.div>
  );
}
