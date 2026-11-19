import { forwardRef, type CSSProperties, type ReactNode } from "react";
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
export const PopupPanel = forwardRef<
  HTMLDivElement,
  {
    className?: string;
    /**
     * Inline position, for a panel placed from measured numbers rather than from a Tailwind offset.
     *
     * Allowed by the shipped CSP — it carries `style-src-attr 'unsafe-inline'` beside its
     * `style-src 'self'`, which is why a measured panel is possible here at all and an injected
     * `<style>` element is not. `ContextMenu` places itself the same way.
     */
    style?: CSSProperties;
    children: ReactNode;
  }
>(
  /**
   * `ref` is the panel's own DOM node, for `usePopupPlacement` to measure — `offsetWidth`/
   * `offsetHeight` are the panel's real layout size, and this is the only box in the shell with a
   * border and padding to measure. `motion.div` forwards it to the underlying element itself.
   *
   * **`forwardRef`, and not React 19's ref-as-a-prop, on purpose.** The app runs React 19, where
   * the two are the same thing; the design system's bundle (`.design-sync/`) runs these same
   * modules on the page's React **18.3.1**, which never hands a function component its `ref`. As a
   * plain prop the ref stayed `null` there, `usePopupPlacement` returned before measuring, and
   * every `Dropdown` opened a panel that kept `invisible` at 0,0 for good. Do not "modernise" this
   * back — `.design-sync/NOTES.md` has the account.
   */
  function PopupPanel({ className, style, children }, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        ref={ref}
        {...popup}
        style={style}
        // Not in the accessibility tree on the way out either: a second, stale copy of the panel's
        // list is worse than none, and the caret left with the flag.
        aria-hidden={present ? undefined : true}
        className={cn(className, !present && "pointer-events-none")}
      >
        {children}
      </motion.div>
    );
  },
);
