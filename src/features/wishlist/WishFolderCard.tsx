/**
 * A wishlist folder as it is drawn above the wishes, in both views — the tile a reader clicks
 * into, and one of the two places a wish can be dropped. Design spec §4 and §9.
 *
 * **Ported from `src/features/decks/FolderCard.tsx`, and it keeps that card's one visual claim.**
 * The border is **dashed**, which on this screen is not decoration but a rule with a meaning
 * already established: *dashed means provisional*. A deck folder wears it because a folder is a
 * container rather than a thing you can play. A wishlist folder wears it for the same reason
 * stated in this page's own terms — it is a container rather than a thing you can **buy**. The
 * wishes inside it are the things with prices; the drawer they are in is not one of them. Nothing
 * else on the wishlist is dashed, so the dash keeps meaning exactly that.
 *
 * **The one place this deliberately departs from the component it is ported from: no strip of
 * member art.** `FolderCard` draws three member covers, because a deck gallery is browsed by
 * recognising a deck, and a deck's face is its art. A shopping list is not browsed that way — it
 * is read for its **money**. Three crops of cards a reader has not bought yet answer a question
 * nobody asked of a wishlist folder, while `6 wishes · $312.00`, the whole face this draws
 * instead, answers the only one they have: how much is in this drawer and what will it cost. That
 * also makes the tile cheap in a way the deck card is not — it needs no image query, no
 * `useImageRetry`, and no illustrator credit line, because Scryfall's image policy attaches to
 * pictures and there are none here.
 *
 * The unpriced note is written in the same `· 2 unpriced` shape `WishlistPage`'s own header
 * builds, so a folder's qualification of its subtotal and the page's qualification of the whole
 * list's read as one sentence rather than as two conventions.
 *
 * **Drawn as an `<li>`, so a caller draws a wall of these inside a `<ul>`** — `FolderCard`'s
 * shape, and a row of folders genuinely is a list. The ring lives on that `<li>`, which means the
 * scroller around the wall has to carry `DROP_MARK_ROOM`; that is the wall's business rather than
 * the card's, and `dropMarks.ts` explains why padding one level in is not the same fix.
 */
import { useRef, type KeyboardEventHandler, type MouseEventHandler } from "react";
import { Folder, MoreHorizontal } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { FolderNode } from "@/lib/folderTree";
import { FOCUS } from "@/lib/focus";
import type { WishlistFolder } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { useWishDropTarget, type WishDrag } from "./wishDrag";

/**
 * What a folder card is drawn from: the wishes in it, the copies still to find, what those cost
 * and how many of them the marketplace could not price.
 *
 * **Not `WishlistFolderSummary` itself, and the difference is load-bearing.** That row is
 * *direct* — this folder's own wishes, never its sub-folders' — which is right for the row and
 * wrong for the card: a folder holding two sub-folders of six wishes each and none of its own
 * would draw `0 wishes` over a drawer holding twelve. The caller adds the children in, the same
 * arithmetic `buildFolderTree` already does for `FolderNode.count`, and hands the total here.
 */
interface WishFolderSummary {
  wishes: number;
  missing: number;
  cost: number;
  unpriced: number;
}

/**
 * The folder's face, in two spellings of one sentence.
 *
 * `shown` is what the card prints, joined with the app's `·`. `spoken` is the same facts joined
 * with commas for the button's `aria-label`, because an `aria-label` replaces everything inside
 * the control and a middot read aloud is punctuation nobody asked for. Built together rather than
 * written twice, so the two can never disagree about what the card says.
 *
 * **A folder with nothing left to buy shows its wish count and no money at all.** `$0.00` on a
 * folder the reader has finished buying is noise — `formatPrice`'s own rule is that it is a price
 * nobody quoted — and the unpriced note goes with it, since that note exists to qualify a
 * subtotal and there is no subtotal to qualify.
 */
function face(summary: WishFolderSummary, currency: Currency): { shown: string; spoken: string } {
  const wishes = plural(summary.wishes, "wish", "wishes");
  if (summary.missing === 0) return { shown: wishes, spoken: wishes };
  const parts = [
    // `null` rather than `0` where nothing in the folder could be priced: every missing copy is
    // unpriced, and an em dash beside `3 unpriced` says that where `$0.00` would claim the
    // marketplace quoted nothing for three cards.
    formatPrice(summary.cost > 0 ? summary.cost : null, currency),
    ...(summary.unpriced > 0 ? [`${summary.unpriced} unpriced`] : []),
  ];
  return {
    shown: [wishes, ...parts].join(" · "),
    spoken: [wishes, ...parts].join(", "),
  };
}

export function WishFolderCard({
  node,
  summary,
  currency,
  onOpen,
  rowMenu,
  canDrop,
  onDropWish,
}: {
  node: FolderNode<WishlistFolder>;
  summary: WishFolderSummary;
  currency: Currency;
  onOpen: () => void;
  /** The page's own menu — Rename / Move to folder… / Delete — reached from three gestures here
   *  and built once per page rather than once per card. */
  rowMenu: {
    onContextMenu: MouseEventHandler<HTMLButtonElement>;
    onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  };
  /** Whether *this* folder would take the wish currently in the air — spec §9: the folder a wish
   *  is already filed in refuses it, and draws no ring rather than a ring that does nothing. */
  canDrop: (drag: WishDrag) => boolean;
  onDropWish: (drag: WishDrag) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const tip = useTooltip();
  const { armed, over } = useWishDropTarget({ ref, canDrop, onDrop: onDropWish });
  const { shown, spoken } = face(summary, currency);

  /**
   * The manage trigger's press, routed to the same menu a right-click opens — with the one
   * correction the primitive cannot make for itself.
   *
   * `menu()` opens the panel at `e.clientX/clientY`, which is the pointer's position and **zero**
   * for a keyboard: Enter or Space on a focused button fires a click carrying no coordinates and
   * `detail === 0`, so a keyboard press here would open the menu in the top-left corner of the
   * window. That is precisely the failure `menuKey()` exists to prevent — "a keypress has no
   * coordinates and `0, 0` would put every one of these in the top-left corner" — arriving
   * through the one door it does not watch, because this is the app's **first menu opened by a
   * plain click** rather than by a right-click.
   *
   * So a keyboard press is handed to `menuKey()`'s route instead of `menu()`'s, by dispatching
   * the key that route already watches at this very button: React's `keydown` listener is
   * delegated at the root container, so a bubbling native event reaches this element's own
   * `onKeyDown` and the panel anchors at the trigger's bottom-left, where the reader is looking.
   * A `keyup`-style guess at the coordinates would be the alternative, and it would duplicate
   * arithmetic the primitive already does correctly.
   *
   * If a second click-opened menu ever appears, this belongs in `useContextMenu` rather than
   * here — one `menuClick()` beside `menu()` and `menuKey()`.
   */
  const openMenu: MouseEventHandler<HTMLButtonElement> = (e) => {
    if (e.detail !== 0) {
      rowMenu.onContextMenu(e);
      return;
    }
    e.currentTarget.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
    );
  };

  return (
    <li ref={ref} className={cn("relative rounded-xl", armed && DROP_RING)}>
      <button
        type="button"
        // Starts with the visible label and then says, in words, what the second line says in
        // figures — WCAG 2.5.3, and `FolderCard`'s arrangement: the name is the prefix, and the
        // count is a sentence rather than a bare number a screen reader cannot attach to
        // anything.
        aria-label={`${node.folder.name} folder, ${spoken}`}
        onClick={onOpen}
        // **The menu's two doors are on this button**, never on the `<li>` around it — the panel
        // hands the caret back to the element a menu was opened on, and this is the focusable one.
        // `FolderTree`'s rule, and the same reason it gives.
        onContextMenu={rowMenu.onContextMenu}
        onKeyDown={rowMenu.onKeyDown}
        className={cn(
          // `pr-9` leaves the manage trigger its corner: the trigger is a *sibling* rather than a
          // child, because a button inside a button is not markup a browser will build.
          "block w-full rounded-xl border border-dashed border-border p-2.5 pr-9 text-left",
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          over && cn("border-accent", DROP_OVER),
          FOCUS,
        )}
      >
        <span className="flex items-center gap-2">
          <Folder className="size-3.5 flex-none text-dim" aria-hidden="true" />
          <span
            className="min-w-0 flex-1 truncate text-sm"
            {...tip(node.folder.name, { whenClipped: true })}
          >
            {node.folder.name}
          </span>
        </span>
        <span className="mt-1 block truncate text-xs tabular-nums text-dim">{shown}</span>
      </button>

      {/* The visible way into the same menu the right-click opens — the affordance a reader who
          does not know a card can be right-clicked has. Named for the folder, because a wall of
          these is otherwise a row of controls all called "Manage": a screen reader reads them
          out of context, one after another, with nothing to tell them apart. */}
      <button
        type="button"
        aria-label={`Manage ${node.folder.name}`}
        onClick={openMenu}
        onKeyDown={rowMenu.onKeyDown}
        className={cn(
          "absolute right-1 top-1 grid size-7 place-items-center rounded-md text-dim",
          "transition-colors duration-150 hover:bg-surface hover:text-text",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}
