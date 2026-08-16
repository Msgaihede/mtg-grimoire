/**
 * The chrome the Settings page's panels are drawn in — `controls.ts` beside it holds the class
 * recipes they are built from.
 *
 * The card box is the smaller half of what is here: three byte-identical class strings, where a
 * fourth that drifted would be a panel that *looked* wrong, which is the kind of mistake a
 * screenshot catches. The heading pairing is the half that earns the module. A
 * `<section aria-labelledby>` has a name only while some `id` in the document matches it, a
 * mismatch loses that name **silently**, and neither TypeScript nor Tailwind can see either end
 * of the pairing. Both panel tests reach their panel *by* that name —
 * `getByRole("region", { name: "Errors" })` — so a typo would not read as a broken heading but
 * as a query finding nothing on a panel that renders perfectly.
 *
 * Preventive rather than corrective, and worth saying plainly: none of the three panels had
 * drifted when this was written.
 */
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * One panel: a named region, its heading, and the box the panel's content sits in.
 *
 * `id` is the **stem** rather than the whole attribute — the heading is `${id}-heading` and the
 * section points at exactly that, which is the pairing this component exists to make
 * unbreakable. A written string and not `useId()`, because a generated `:r7:` moves with the
 * render order of the page and these ids are readable in the shipped window.
 *
 * Cinzel at 18px is the display face's one job in the content, and the direction's floor for it.
 * `SettingsPage`'s "Not here yet" is deliberately **not** one of these: a heading over an absence
 * is `text-dim` with no box, and drawing it a panel's frame would promise a panel behind it.
 */
export function SettingsSection({
  id,
  title,
  children,
}: {
  /** The stem of the heading's id: `updates` gives `<h2 id="updates-heading">`. */
  id: string;
  /** The heading — and, through the pairing, the region's accessible name. */
  title: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="font-heading text-lg leading-none">
        {title}
      </h2>

      <div className="space-y-4 rounded-lg border border-border bg-surface p-4">{children}</div>
    </section>
  );
}

/** How loudly a panel says its one line of bad news. */
type Tone = "problem" | "plain";

/** Written out whole, because Tailwind scans source text and an assembled name emits no rule. */
const TONE: Record<Tone, string> = {
  problem: "text-destructive",
  plain: "text-text",
};

/**
 * A panel's status line, grown into place.
 *
 * All three panels wrote this out. It is {@link statusLine} — the sentence's height opening from
 * nothing, so it *grows* instead of shoving the panel's footing down by its full height the
 * instant it arrives — on an element of its own, since it carries no padding and no border, and
 * with `overflow-hidden`, which that preset needs because the sentence is laid out at full size
 * whatever the box around it is doing. A panel is a `space-y-4` stack, so the 16px above still
 * arrives at once; the sentence is what opens.
 *
 * **`tone` is the one thing the three did not agree on, and the disagreement is deliberate.**
 * `UpdatePanel` and `MarketplacePanel` draw a refusal in the app's destructive red, because
 * something the reader asked for did not happen. `ErrorLogPanel` draws its own in plain text:
 * that panel's whole argument is that a failed image fetch is not an alarm, and a page that lists
 * faults quietly has no business turning red about the listing itself.
 *
 * Nothing is rendered while `children` is empty, so a caller passes its `error` straight in —
 * which is why the prop is the sentence itself rather than a `ReactNode`. All three panels hold a
 * refused write as `string | null`, and a truthiness test is only honest over a type where
 * "empty" and "falsy" are the same thing: `0` and an empty fragment are both nodes that render
 * nothing here while reading as something to say.
 */
export function PanelAlert({ tone, children }: { tone: Tone; children: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {children ? (
        <motion.p
          {...statusLine}
          role="alert"
          className={cn("overflow-hidden text-sm", TONE[tone])}
        >
          {children}
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}
