import type { SVGProps } from "react";
import { Copy, Folder } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";

/**
 * The two things a wish says about itself that are neither its card nor its price — where it is
 * filed, and whether the same card is on the list somewhere else. Design spec §4.
 *
 * **One module because both views draw both, beside the printing caption, and must not drift.**
 * The wall's caption strip and the table's Printing cell are the same statement drawn at two
 * sizes, and the app has been bitten before by one fact rendered twice: two glyphs, two shades,
 * two sentences, none of it decided. Here it is decided once.
 *
 * **They scale on a card and hold still in a row, with no prop and no branch.** Everything drawn
 * on a card reads `var(--mark-scale, 1)` (`lib/cardZoom.ts`) — `CardGrid`'s tile publishes the
 * variable, a table row publishes nothing, and the `, 1` fallback is exactly what a row is owed
 * for knowing nothing about zoom. That is the rule in `src/CLAUDE.md`, and it is what lets one
 * component serve both surfaces.
 *
 * Both bind through `useTooltip()` rather than a `title`, and both pass `describes: false`: each
 * already carries its whole sentence in the accessibility tree — one as an `aria-label`, the
 * other as visible text with an `sr-only` preposition — so a wired `aria-describedby` would have
 * a screen reader say it twice.
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
  const sentence = `Also on your wishlist as ${count} other ${count === 1 ? "wish" : "wishes"}`;
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

/**
 * Which folder a wish is filed in — drawn **only while the list is flattened**, and reading
 * `Wishlist` for a wish at the root.
 *
 * Flatten's whole promise is "every wish, wherever it is filed", so without this the switch would
 * hand the reader one undifferentiated list and take the filing away in the act of showing it
 * all. Inside a folder the caption would be the folder's own name on every row, said once in the
 * breadcrumb above, which is why the caller gates it rather than this drawing something on every
 * screen.
 *
 * The name is **visible text** and not an `aria-label`: it is a word the reader chose, so it
 * belongs on screen, and the `sr-only` preposition in front of it is what keeps a bare "Expensive"
 * in a caption from reading as part of the printing beside it.
 *
 * `null` draws nothing, which is what the page answers for a folder it cannot name — one deleted
 * in another window between the wish read and the folder read. Handled here rather than at the
 * two call sites so that the "no honest text, no chip" rule cannot be remembered in one view and
 * forgotten in the other.
 */
export function WishFolderCaption({ name }: { name: string | null }) {
  const tip = useTooltip();
  if (name === null) return null;
  return (
    <span
      {...tip(`Filed in ${name}`, { describes: false })}
      className="inline-flex min-w-0 shrink items-center gap-[calc(0.25rem*var(--mark-scale,1))] text-dim"
    >
      <Folder
        aria-hidden="true"
        className="size-[calc(0.75rem*var(--mark-scale,1))] shrink-0"
      />
      <span className="sr-only">Filed in </span>
      <span className="truncate">{name}</span>
    </span>
  );
}
