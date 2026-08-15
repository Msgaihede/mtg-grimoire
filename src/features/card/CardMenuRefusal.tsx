/**
 * The sentence a refused card-menu add leaves behind, wherever a page draws one.
 *
 * **One component rather than a copy per page**, for the reason {@link useCardMenuDeps} is one
 * hook: every page that offers a card menu reports the same two writes, and the same markup
 * pasted once per page is a place per page for a colour, a role or the growth to drift. Grep the
 * import for which pages draw it — that list is a fact about the tree rather than about this
 * comment. It is deliberately *not* folded into the hook — a hook that rendered its own banner
 * would decide where on the page it sits, and that is the one part of this each view genuinely
 * owns.
 *
 * It exists at all because the menu cannot report its own refusals: `ctx.run` closes the panel
 * before a row's handler runs, so by the time an answer arrives there is no menu left to put a
 * sentence in. The write lives on the surface, and so does what it has to say.
 *
 * Its neighbour on each of these pages is that page's *own* refused-write banner — a stepper
 * press, a removal. Two banners rather than one because they describe two different things: one
 * is the list's controls, and this is a card the reader filed somewhere from a menu that has
 * already closed.
 */
import { AnimatePresence, motion } from "motion/react";
import { statusLine } from "@/lib/motion";

export function CardMenuRefusal({ error }: { error: string | null }) {
  return (
    // It grows into place rather than shoving the list down by its whole height. The animated
    // element is the wrapper and carries only `overflow-hidden`, because `statusLine` takes
    // `height` to 0 and — under `box-sizing: border-box` — a box with its own padding and border
    // can never be shorter than the two of them, so it would bottom out short and jump the rest.
    // `role="alert"` stays on the element that holds the sentence.
    <AnimatePresence initial={false}>
      {error && (
        <motion.div {...statusLine} className="overflow-hidden">
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
