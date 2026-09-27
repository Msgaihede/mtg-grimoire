/**
 * A collection folder's figures as words — what the home page's Folders widget prints under each
 * folder it lists.
 *
 * **This file drew the collection's folder cards until folder shelves** (2026-09-26), when the
 * page's drill-down band became headings on one wall and the card went with it. The face outlived
 * the card because the widget reads the same two facts about the same drawers, and a second
 * spelling of "12 cards · $340.00" is a second chance for two surfaces to disagree about one
 * folder. The shelf headings state the same figures through `collectionShelfModel.ts`'s
 * `shelfStat`, which adds the filtered `N of M` form a card never needed.
 */
import { count } from "@/lib/counts";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";

/**
 * What a folder's face is drawn from: the copies filed in it and what they are worth.
 *
 * **Not `CollectionFolderSummary` itself, and the difference is load-bearing.** That row is
 * *direct* — this folder's own cards, never its sub-folders' — which is right for the row and
 * wrong for the face: a folder holding two sub-folders of six cards each and none of its own would
 * draw `0 cards` over a drawer holding twelve. The caller adds the children in, the same
 * arithmetic `buildFolderTree` already does for `FolderNode.count`, and hands the total here.
 *
 * `cards` is **copies**, not rows — `sum(quantity)`, which is the page header's own `totalCards`
 * arithmetic, so a tile and the header can never count one folder two ways.
 *
 * `value` is `number | null` and the `null` is the backend's own, kept rather than flattened: a
 * marketplace that prices nothing in the drawer answers `None`, and `$0.00` there would claim a
 * quote nobody gave.
 */
export interface CollectionFolderTotals {
  cards: number;
  value: number | null;
}

/**
 * The folder's face, in two spellings of one sentence.
 *
 * `shown` is what the card prints, joined with the app's `·`. `spoken` is the same facts joined
 * with commas for the button's `aria-label`, because an `aria-label` replaces everything inside
 * the control and a middot read aloud is punctuation nobody asked for. Built together rather than
 * written twice, so the two can never disagree about what the card says.
 *
 * **`null` is "not counted yet", and it is a different thing from a folder holding nothing.** The
 * cabinet is drawn as soon as the folder *list* answers, and that list is one flat `SELECT` while
 * the summary behind these figures is a `GROUP BY` carrying a marketplace price expression — so
 * there is a real window in which a drawer holding 240 copies worth $1,300 is on screen with
 * nothing yet known about it. Drawing `0 cards` across that window is not a spinner, it is a
 * **wrong number that then jumps**, and a reader who glanced at the wall in that moment was told
 * the drawer was empty. An em dash is what every other unanswered figure in this app draws
 * (`Figure`'s own `query.isPending ? "—"`), and the spoken half says it in words because a dash
 * read aloud is punctuation.
 *
 * **An empty drawer shows its count and no money at all.** `$0.00` under a folder with nothing in
 * it is noise — `formatPrice`'s own rule is that it is a price nobody quoted — and an em dash
 * beside `0 cards` would invite the reader to wonder which of the nothing could not be priced.
 *
 * **A count that can reach four figures is written through `count`, not `plural`.** A binder
 * genuinely holds thousands of copies where a wishlist holds tens, and `plural` writes its number
 * plainly on purpose — its own doc says a caller that reaches four figures wants
 * `${count(n)} ${…}` and its own thought about it. This is that caller.
 *
 * **Exported for the home page's Folders widget**, which lists the reader's folders and the app's
 * own beside them — one spelling of the sentence for every surface that says it.
 *
 * **The lock is a *word* here and not only a glyph, and that is why it joins this pair rather than
 * being drawn beside it** (issue #365). The card says a drawer is set aside twice — the leading
 * `Folder` glyph becomes a `Lock`, and this line leads with `Locked` — because a glyph is not an
 * accessible name and a mark with nothing said in words is one a screen reader never hears. Built
 * here, with the count and the money, so the screen text and the `aria-label` cannot drift: the
 * `·` is the app's separator on screen and the comma is what a sentence reads aloud with, which is
 * the same rule the em dash and "not priced" already follow one field down.
 *
 * **It leads rather than trails, and it is drawn across every branch including "still counting".**
 * The lock is known from the folder *list*, which is what the wall is gated on; the figures come
 * from a `GROUP BY` that answers later. So `Locked · —` is the honest face of a drawer that is set
 * aside and not yet counted, and a lock that waited for the summary would flicker on for no reason
 * a reader could see.
 *
 * `locked` is the **effective** lock — the folder's own flag or any ancestor's, which is
 * `lockedFolderIds`' answer and never `CollectionFolder.locked`. It defaults to `false` for
 * the app's own two kinds, which cannot be locked at all: the write refuses anything that is not
 * `kind = 'user'` in words.
 */
export function folderFace(
  summary: CollectionFolderTotals | null,
  currency: Currency,
  locked = false,
): { shown: string; spoken: string } {
  // One wrapper around all three returns rather than a fourth branch, so a face that grows a
  // fifth shape cannot be the one that forgets to say the drawer is set aside.
  const face = (shown: string, spoken: string) =>
    locked ? { shown: `Locked · ${shown}`, spoken: `locked, ${spoken}` } : { shown, spoken };
  if (summary === null) return face("—", "still counting");
  const cards = `${count(summary.cards)} ${summary.cards === 1 ? "card" : "cards"}`;
  if (summary.cards === 0) return face(cards, cards);
  // The two spellings differ on exactly one field, and only where the marketplace priced nothing
  // in the drawer: the em dash is the right mark on screen and the wrong word in a sentence —
  // the same rule the "still counting" branch above applies one field earlier.
  const money =
    summary.value === null
      ? { shown: "—", spoken: "not priced" }
      : { shown: formatPrice(summary.value, currency), spoken: formatPrice(summary.value, currency) };
  return face(`${cards} · ${money.shown}`, `${cards}, ${money.spoken}`);
}
