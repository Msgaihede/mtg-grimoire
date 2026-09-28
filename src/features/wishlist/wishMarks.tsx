import type { SVGProps } from "react";
import { Copy } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";

/**
 * What a wish says about itself that is neither its card nor its price — whether the same card is
 * on the list somewhere else. Design spec §4.
 *
 * **One module because both views draw it, beside the printing caption, and must not drift.**
 * The wall's caption strip and the table's Printing cell are the same statement drawn at two
 * sizes, and the app has been bitten before by one fact rendered twice: two glyphs, two shades,
 * two sentences, none of it decided. Here it is decided once. (It held a second mark until the
 * final review — `WishFolderCaption`, which said where a wish was filed while the list was
 * flattened. Flatten is deleted, the shelves' headings say where every wish is filed, and the
 * caption went with it.)
 *
 * **It scales on a card and holds still in a row, with no prop and no branch.** Everything drawn
 * on a card reads `var(--mark-scale, 1)` (`lib/cardZoom.ts`) — `CardGrid`'s tile publishes the
 * variable, a table row publishes nothing, and the `, 1` fallback is exactly what a row is owed
 * for knowing nothing about zoom. That is the rule in `src/CLAUDE.md`, and it is what lets one
 * component serve both surfaces.
 *
 * It binds through `useTooltip()` rather than a `title`, and passes `describes: false`: it already
 * carries its whole sentence in the accessibility tree as an `aria-label`, so a wired
 * `aria-describedby` would have a screen reader say it twice.
 */

/**
 * The same card is on the wishlist somewhere else — spec §4's duplicate catch.
 *
 * **It counts the same _oracle card_, never the same printing**, which is the whole point of it:
 * `folder_id` is part of the storage grain since v23, so a card filed in `Ordered` and added
 * again at the root is a **second row** rather than a bump to the first — and two wishes for two
 * different printings of one card are still two chances to order it twice over. `WishRow`'s
 * `elsewhere` is the correlated count and answers `0` on almost every row, which is why this is
 * cheap: most readers have no duplicates and see nothing at all.
 *
 * **It counts _wishes_, and it used to say "places".** The storage grain is
 * `(oracle_id, card_id, preferred_finish, folder_id)`, so two of the counted rows can perfectly
 * well sit in the same drawer — a foil Bolt and a nonfoil Bolt both loose at the root each read
 * "1 other place" while both were in the one place there is. A number is only honest where the
 * noun beside it names what was counted, and what this counted all along is other **wishes**. The
 * app's own word, too: the header says `Wishes` and a folder card says `3 wishes`, so the count
 * a reader is being warned about is spelled here the way it is spelled everywhere else they will
 * go looking for it.
 *
 * A `role="img"` with its whole sentence as the name, `GameChangerMark`'s arrangement — the glyph
 * says nothing on its own, and this sits beside a caption rather than inside a button, so naming
 * itself costs no other control its name.
 */
export function ElsewhereMark({ count }: { count: number }) {
  const tip = useTooltip();
  // Not a guard the caller has to remember: nearly every row is `0`, and a mark that drew an
  // empty box on all of them would put a gap in every caption in the list.
  if (count <= 0) return null;
  const sentence = `Also on your wishlist ${count} more ${count === 1 ? "time" : "times"}`;
  return (
    <Copy
      role="img"
      aria-label={sentence}
      // `TooltipBinding`'s handlers are typed against `HTMLElement` because every other anchor in
      // the app is one; a lucide glyph is an `<svg>`, whose events carry an `SVGSVGElement`
      // `currentTarget` — which has every DOM method the provider calls on it. The cast says only
      // that. `GameChangerMark` carries the same one for the same reason.
      {...(tip(sentence, { describes: false }) as SVGProps<SVGSVGElement>)}
      className="inline-block size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 text-dim"
    />
  );
}
