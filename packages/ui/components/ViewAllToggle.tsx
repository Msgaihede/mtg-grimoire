import type { ReactElement, Ref } from "react";
import { LayoutGrid } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * **`View all` — every item of a filed page on one wall, with the folders left out.**
 *
 * The deck gallery drew it first (issue #750) and the collection and the wishlist take the same
 * control (issue #907), so it is one component: three pages whose switch for the same idea looked
 * three ways would be three ideas to a reader.
 *
 * A toggle, `aria-pressed`, never a link: pressing it again goes back to the folder the reader was
 * standing in. The glyph and the accent edge carry the pressed state the way the filter row's chips
 * do, so "on" reads as the same mark it reads as one row down. The visible word is short and
 * `name` says the rest — the words begin the name, as WCAG 2.5.3 asks (`View all decks`,
 * `View all cards`, `View all wishes`).
 *
 * **The gallery's heading-row button, verbatim** — a bordered surface the height of `New deck` —
 * because the issue asked for the collection's and the wishlist's to match it. `PRESS` for the dip,
 * and it never greys, so it carries no out-of-reach clause.
 */
export function ViewAllToggle({
  pressed,
  onToggle,
  name,
  ref,
}: {
  pressed: boolean;
  onToggle: () => void;
  /** The accessible name — `View all` plus the noun it is all of. */
  name: string;
  /** Where a page hands the caret when Escape leaves the flat wall from inside it. */
  ref?: Ref<HTMLButtonElement>;
}): ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={pressed}
      aria-label={name}
      onClick={onToggle}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm text-dim hover:text-text",
        PRESS,
        FOCUS,
        pressed && "border-accent text-accent hover:text-accent",
      )}
    >
      <LayoutGrid className="size-3.5" aria-hidden="true" />
      View all
    </button>
  );
}
