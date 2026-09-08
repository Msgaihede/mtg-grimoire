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
 *
 * `actions` is the far end of the band — the collection's and the wishlist's Import/Export pair.
 * They ride here rather than above the filter row because the filter row's own right-hand corner
 * belongs to the layout toggle, which is where the search page puts it and where a reader now
 * looks for it on all four card views.
 */
export function FigureRow({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  // The rule and the padding move to a wrapper the moment there is something beside the figures,
  // so the line runs the full width of the band rather than stopping where the numbers do.
  //
  // **A wrapper and not a third child of the `<dl>`.** HTML's content model for a description list
  // is *either* `dt`/`dd` groups *or* `div`s — never both — so an action tucked in beside the
  // figures would be invalid markup, and the `<dl>` would be claiming the buttons are part of the
  // description list. `items-end` rather than `items-baseline` on the outer row: a button has no
  // meaningful baseline to share with a 24px numeral, and aligning it to one lifts it off the rule.
  if (!actions) {
    return (
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border pb-3">
        {children}
      </dl>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-border pb-3">
      <dl className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-6 gap-y-2">{children}</dl>
      {/* `ml-auto` as well as the `flex-1` above, so the actions stay against the right edge on
          the line they wrap onto — a wrapped flex item is at the start of its own line, and the
          `flex-1` that pushed it right is on a box that is no longer beside it.

          ⚠️ **Not `shrink-0`, and the reason is a defect this row shipped with for one day**
          (2026-09-08). The `<dl>` beside it is `flex-1` with a `0%` basis, so it *grows* into
          whatever is left and never shrinks — which means a `shrink-0` here made the actions'
          **max-content** a hard floor on the whole row. The collection's block grew from one
          `ImportExportPair` (158.86px) to that plus a sharing group (421.67px), and at the phone's
          390px frame — a 335px row — the row's `scrollWidth` went to 421 against a `clientWidth`
          of 335 with `documentElement.scrollWidth` still 390: `Import` cut mid-word, `Export`
          entirely off screen and **not reachable by scrolling**, because the overflow was in a
          box the page does not scroll. Shrinkable, a block whose own content can wrap falls onto
          two lines instead and nothing leaves the window. The floor that replaces `shrink-0` is
          the automatic one every flex item has — its min-content — so an `actions` node that
          *cannot* wrap is unchanged by this, and the wishlist's lone pair (158.86px, never
          shrunk at any width this app is drawn at) is one such node. */}
      <div className="ml-auto">{actions}</div>
    </div>
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
