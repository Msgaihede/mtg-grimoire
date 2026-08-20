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
 *
 * **One caller is not about a card at all**, and it belongs here anyway: the Tags page's rail
 * draws this for a refused `tag_mute`. The name is its first caller's; the *mechanism* in the
 * paragraph above is exactly that case — the menu closes before the answer arrives, so the
 * surface has to carry the sentence — and one more hand-copy of this markup is what the
 * consolidation below was fought to avoid.
 *
 * **The deck editor drew its own copy of this until 2026-08-16** — the same `AnimatePresence`,
 * the same `motion.div {...statusLine}`, the same `role="alert"` and a byte-identical `<p>` class
 * string, differing only in a `shrink-0` on the wrapper. There was no stated opt-out at that
 * site: the comment there explained what the banner was *for* and never why it was not this
 * component. `className` is what closed the one real difference, and the rule above holds
 * unbroken for every surface now.
 *
 * **A count of the surfaces is deliberately not written down here.** This paragraph said "all
 * five" while there were eight, having gone stale twice — a count is a fact about a *tree*, and
 * a prose-only edit routes to neither CI job, so nothing goes red when one rots.
 * `grep -rn CardMenuRefusal src/` is the census. What is worth stating is the *rule*: every
 * surface that offers a card menu draws this component rather than its own copy of it.
 */
import { AnimatePresence, motion } from "motion/react";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function CardMenuRefusal({
  error,
  className,
}: {
  error: string | null;
  /**
   * What the *host's* layout needs of this box, merged after `overflow-hidden`.
   *
   * Most surfaces need nothing and pass nothing; the ones that do are flex columns and pass
   * `shrink-0`. Deliberately **not** hoisted into the string below: whether a banner may be
   * squeezed is a fact about the box it is drawn in, and hoisting it would be a layout
   * hypothesis about every other page that nobody has measured — this repo's standard being a
   * figure off the shipped window rather than an inference from a class string.
   */
  className?: string;
}) {
  return (
    // It grows into place rather than shoving the list down by its whole height. The animated
    // element is the wrapper and carries no padding or border of its own, because `statusLine`
    // takes `height` to 0 and — under `box-sizing: border-box` — a box with either can never be
    // shorter than the two of them, so it would bottom out short and jump the rest. (What it does
    // carry is `overflow-hidden`, which that preset needs, and whatever the host passed.)
    // `role="alert"` stays on the element that holds the sentence.
    <AnimatePresence initial={false}>
      {error && (
        <motion.div {...statusLine} className={cn("overflow-hidden", className)}>
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
