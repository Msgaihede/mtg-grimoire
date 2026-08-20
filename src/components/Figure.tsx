import type { ReactNode } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";

/**
 * The header a list of cards is captioned with: a few figures, in the data face, with no
 * colour and no chrome.
 *
 * Extracted unchanged from the collection's summary when the wishlist needed the same
 * grammar. The direction spends its boldness on card art, so a row of tinted stat cards
 * above a wall of Magic art would be two things shouting — and two views inventing their own
 * `<dl>` is how one app ends up with two ideas of what a total looks like.
 */
export function FigureRow({ children }: { children: ReactNode }) {
  return (
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border pb-3">
      {children}
    </dl>
  );
}

/**
 * One figure and what it counts.
 *
 * `note` is the qualification a number needs to stay honest — how many copies the value
 * could not price, how much of a list a sum was taken over. `title` is where spec §5's
 * as-of sentence rides on a money figure, because the row has no space to write it out —
 * a description of the label/value pair beside it, so it binds with the tooltip's default
 * (`aria-describedby` while open) rather than `describes: false`.
 */
export function Figure({
  label,
  value,
  note,
  title,
}: {
  label: string;
  /** Already formatted. An em dash rather than a zero while the first answer is in flight:
   *  a list that briefly claims to be worth nothing is worse than one that has not said. */
  value: string;
  note?: string;
  title?: string;
}) {
  const tip = useTooltip();
  return (
    <div className="min-w-0" {...tip(title)}>
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="font-mono text-lg tabular-nums">
        {value}
        {note && <span className="ml-2 text-xs text-dim">{note}</span>}
      </dd>
    </div>
  );
}
