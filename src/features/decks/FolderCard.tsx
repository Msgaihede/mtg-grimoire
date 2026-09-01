/**
 * A folder as it is drawn on the gallery wall, beside the deck tiles rather than in the tree.
 *
 * Lifted out of `DecksPage.tsx` on 2026-08-16, whole — the card, the strip of member art it is
 * made of, and the one query the page needs to fill that strip. `FolderTree.tsx` draws the same
 * folders as *rows* in the sidebar; this is the other drawing of them, and the two share only
 * the drop target and the tree itself.
 */
import { useRef } from "react";
import { CardImage } from "@/components/CardImage";
import { FolderDropLine } from "@/components/FolderDropLine";
import { ParentFolderCard } from "@/components/ParentFolderCard";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cardScaleVars } from "@/lib/cardZoom";
import { plural } from "@/lib/counts";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { useFolderDropTarget, type FolderDrag, type FolderEdge } from "@/lib/folderDrag";
import { FOCUS } from "@/lib/focus";
import { cardArtSrc, cardImageUrl } from "@/lib/images";
import type { DeckRow } from "@/lib/ipc";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import {
  flattenFolders,
  useDeckDropTarget,
  useFolderDragSource,
  type DeckDrag,
  type FolderNode,
  type FolderRowMenu,
} from "./FolderTree";

/** How many member covers a folder card shows. Three, because the strip is 96px tall and a
 *  fourth crop at that width is a smear rather than a picture. */
const FOLDER_ARTS = 3;

/** Every live deck filed in a folder **or in anything under it** — what a folder card draws
 *  its strip of art from, in `deck_list`'s own order (most recently touched first).
 *
 *  Exported beside the card it feeds rather than left on the page: the two are one answer, and
 *  a caller drawing a `FolderCard` with some other list of members is drawing something else. */
export function decksUnder(
  node: FolderNode,
  live: readonly DeckRow[],
  folderOf: (deck: DeckRow) => number | null,
): DeckRow[] {
  const ids = new Set(flattenFolders([node]).map((n) => n.folder.id));
  return live.filter((deck) => {
    const id = folderOf(deck);
    return id !== null && ids.has(id);
  });
}

/**
 * A folder on the wall: what is in it, drawn from the art of the decks it holds.
 *
 * Dashed, where a deck tile is not — and that dash is the screen's one visual rule: **dashed
 * means provisional**. A folder is a container rather than a thing you can play, and a deck
 * that exists only as a theory list is a plan rather than a deck. Both wear it; nothing else
 * does.
 */
export function FolderCard({
  node,
  members,
  zoom,
  drag,
  canDrop,
  onDropDeck,
  canDropFolder,
  onDropFolder,
  onOpen,
  rowMenu,
}: {
  node: FolderNode;
  members: readonly DeckRow[];
  /**
   * How large the reader draws the wall — `cardZoom.deckGallery`, the same number the deck tiles
   * beside this one are handed and the same number the page sized the grid track with.
   *
   * A folder card scales for a reason a deck tile does not have: its picture is a **strip** of
   * three crops at a fixed height, so without this the tiles around it would grow and the strip
   * would stay a 96px band — the one thing on the wall that ignored the gesture, which is how a
   * zoom starts looking broken.
   */
  zoom: number;
  drag: DeckDrag | null;
  canDrop: (drag: DeckDrag) => boolean;
  onDropDeck: (drag: DeckDrag) => void;
  /**
   * The other drag: a **folder** let go on this card, and where it would land relative to it.
   *
   * Already bound to this card by the page, exactly as {@link canDrop} is — and with no `drag`
   * prop beside it, because `useFolderDropTarget` runs a monitor per target gated by this same
   * question. Every card on the wall answers it for itself, and no two answer the same.
   *
   * **The axis is the whole of what this drawing differs by.** A wall lays folders out left to
   * right, so `before`/`after` are the leading and trailing sides here where they are the top and
   * bottom edges in the sidebar's tree.
   */
  canDropFolder: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDropFolder: (drag: FolderDrag, edge: FolderEdge) => void;
  onOpen: (id: number) => void;
  /**
   * The card's right-click menu and its keyboard twin — rename, move, delete.
   *
   * **This card had none at all until 2026-08-26**, which is the gap rather than a design: the
   * sidebar's tree row has carried the same menu since folders shipped, so every one of those
   * verbs was reachable from one drawing of a folder and from neither of the others. A reader
   * looking at the wall — which is where the folders they just made are — right-clicked and got
   * nothing. `CollectionFolderCard` and `WishFolderCard` both wire theirs; this was the odd one
   * out of three.
   *
   * **On the `<button>` rather than the `<li>`**, `src/CLAUDE.md`'s rule and for its reason: the
   * panel hands the caret back to the element the menu was opened on, and `focus()` on a node
   * with no `tabIndex` is a no-op — so an `<li>` opener drops the reader on `<body>` and the next
   * Tab restarts from the top of the app. It is also the only element a Shift+F10 can land on.
   *
   * **A function called in here, never the handlers themselves**, which is `FolderTree`'s shape
   * for the same prop and is load-bearing rather than a matter of taste: building it at the call
   * site means calling it inside a `.map` **during render**, and `react-hooks/refs` rejects that
   * — a ref read inside a callback handed to a function during render is, to the rule, a ref read
   * during render. It fails only at `npm run verify`, never at `tsc`.
   */
  rowMenu: (folder: FolderNode["folder"]) => FolderRowMenu;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);
  const menu = rowMenu(node.folder);
  const tip = useTooltip();
  const over = useDeckDropTarget({ ref, canDrop, onDrop: onDropDeck });
  useFolderDragSource(folderRef, node.folder);
  const { armed, edge } = useFolderDropTarget({
    ref: folderRef,
    scope: "deck",
    axis: "horizontal",
    canDrop: canDropFolder,
    onDrop: onDropFolder,
  });
  const eligible = drag !== null && canDrop(drag);

  // Scryfall's image policy, applied to a strip exactly as it is to a cover: an `art` crop has
  // no printed frame, so a cover this app cannot name an illustrator for is not drawn.
  //
  // **This excludes a custom cover, and that is deliberate — do not "fix" it.** A deck wearing
  // the reader's own picture therefore contributes its *card* art here (or nothing, if it has
  // none), which is a small inconsistency with its own tile and the cheaper of the two
  // mistakes. The strip is a sample of member card art under **one** credit line; letting an
  // uploaded picture in would make that line cover something it cannot speak for, and the
  // alternative — a credit line that names artists for some tiles in the strip and not others —
  // is worse than the inconsistency. Ruled 2026-08-11 rather than left as an oversight.
  const arts = members
    .flatMap((deck) =>
      deck.coverCardId !== null && deck.coverArtist !== null
        ? [
            {
              id: deck.id,
              cardId: deck.coverCardId,
              artist: deck.coverArtist,
              // The web build's only picture of this cover — see {@link MemberArt}. Carried
              // beside the id rather than looked up again, because it is the *row's* answer
              // about that card and the strip is already holding the row.
              artUrl: deck.imageUris?.art ?? null,
            },
          ]
        : [],
    )
    .slice(0, FOLDER_ARTS);
  const artists = [...new Set(arts.map((art) => art.artist))].join(", ");

  return (
    <li
      ref={ref}
      // The wall's two scale variables, set here for the reason `DeckTile` sets them: everything
      // inside the card inherits them, so the strip, the name, the count and the credit follow
      // one number and nothing has to be threaded down.
      style={cardScaleVars(zoom)}
      className={cn("group relative rounded-xl", eligible && DROP_RING)}
    >
      {/* **Two boxes for two drags, and it is the drag library that insists.**
          `dropTargetForElements` keeps one registration per element — a second one replaces the
          first in its `WeakMap` and warns in dev — so the deck drop on the `<li>` and the folder
          drop cannot share a box. This inner one is the folder's, and it is also where the folder
          is picked up, so a single element is the whole of what the folder gesture reads and
          writes. The two are the same rectangle, which matters because this one is *measured*:
          `folderEdge` divides its box into the three landings.
          The marks are the deck drag's, borrowed rather than reinvented — only one drag is ever in
          the air, and `armed` and an `inside` landing are the same two claims about the other
          payload. The third landing is what a deck has no equivalent of, and it is the line
          below. */}
      <div ref={folderRef} className={cn("relative rounded-xl", armed && DROP_RING)}>
        <button
          type="button"
          // Starts with the visible label, then says the two things the card's marks say — WCAG
          // 2.5.3, and the reason the count is not spliced into the middle of the name.
          aria-label={`${node.folder.name} folder, ${plural(node.count, "deck")}`}
          onClick={() => onOpen(node.folder.id)}
          onContextMenu={menu.onContextMenu}
          onKeyDown={menu.onKeyDown}
          className={cn(
            "block w-full rounded-xl border border-dashed border-border text-left",
            "p-[calc(0.625rem*var(--mark-scale,1))]",
            "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
            (over || edge === "inside") && cn("border-accent", DROP_OVER),
            FOCUS,
          )}
        >
          {/* The strip's height is the one measurement on this card that a deck tile has no
              equivalent of: a tile's cover is a full-width box on a fixed aspect and follows the
              grid track for free, and three crops side by side have no aspect to follow. 6rem is
              the 96px the strip has always been. The 3px seams between them scale with it, so
              three pictures stay three pictures rather than becoming one at 2×. */}
          <span
            className={cn(
              "flex overflow-hidden rounded-md bg-surface",
              "h-[calc(6rem*var(--mark-scale,1))] gap-[calc(3px*var(--mark-scale,1))]",
            )}
          >
            {arts.length === 0 ? (
              <span
                aria-hidden="true"
                className="grid w-full place-items-center text-[calc(0.7rem*var(--mark-scale,1))] text-dim"
              >
                {node.count === 0 ? "Empty" : "No cover art"}
              </span>
            ) : (
              arts.map((art) => <MemberArt key={art.id} cardId={art.cardId} artUrl={art.artUrl} />)
            )}
          </span>
          {/* The same four sizes a deck tile scales, in the same order and off the same variable —
              the two cards sit in one grid track and a name that disagreed about its own size
              would be the first thing a reader saw. */}
          <span
            className={cn(
              "flex items-baseline",
              "mt-[calc(0.5rem*var(--mark-scale,1))] gap-[calc(0.5rem*var(--mark-scale,1))]",
            )}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                "text-[calc(0.875rem*var(--mark-scale,1))] leading-[calc(1.25rem*var(--mark-scale,1))]",
              )}
            >
              {node.folder.name}
            </span>
            <span className="flex-none font-mono text-[calc(0.7rem*var(--mark-scale,1))] tabular-nums text-dim">
              {node.count}
            </span>
          </span>
          <span
            className={cn(
              "mt-[calc(0.125rem*var(--mark-scale,1))] block text-dim",
              "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
            )}
          >
            Folder
          </span>
        </button>

        {/* The price of the crop, per folder card, exactly as it is per tile: an art crop carries
            no printed frame, so every illustrator whose work is on this card is named. */}
        {artists && (
          <p
            className={cn(
              "mt-[calc(0.125rem*var(--mark-scale,1))] truncate text-dim",
              "text-[calc(0.7rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
            )}
            {...tip(artists, { whenClipped: true })}
          >
            Art by {artists}
          </p>
        )}

        {/* Drawn straight off `edge`, which is `null` both when the pointer is elsewhere and when
            it is over a part of this card that would refuse — so no line means no drop, rather than
            a mark leading to a write that never happens. It is `absolute` against the box above,
            which is why that box is `relative`; it spans the credit line too, because what it
            marks is the *slot* the folder would take rather than the picture. */}
        <FolderDropLine edge={edge} axis="horizontal" />
      </div>
    </li>
  );
}

/**
 * The gallery's **up one level** tile — the level above the folder that is open, drawn as a drawer
 * among the drawers so a deck can be dragged back out of a folder without leaving the wall.
 * Issue #283.
 *
 * `ParentFolderCard` is the whole of what it looks like; what is here is the pair of drop targets.
 * Both register on the **same `<li>`**, where a folder card needs two boxes: this tile has one
 * landing, so there is no geometry for `folderEdge` to divide, and `readDeckDrag` and
 * `readFolderDrag` are disjoint, so `accepts()` keeps the two apart.
 *
 * **The ring is raised from the page's `drag`, not from the target** — `useDeckDropTarget` returns
 * only `over` for the reason `deckDrag.ts` gives: every folder-shaped target answers the same
 * yes/no about a deck, so the gallery asks once and hands the answer down. That is why this takes
 * a `drag` where the wishlist's and the collection's tiles do not; the folder half still arms
 * itself, because two folders never answer the same about the folder in the air.
 *
 * **No strip of art, where a folder card carries three crops.** The strip is what a folder is
 * recognised by, and this tile is not a folder to recognise — it is the way out. Drawing the
 * parent's members in it would make the wall's most-recently-touched art appear twice, once as a
 * destination and once as a place.
 */
export function ParentDeckFolderCard({
  label,
  drag,
  onOpen,
  canDrop,
  onDropDeck,
  canDropFolder,
  onDropFolder,
}: {
  /** The parent folder's name, or `All decks` at the root — the sidebar tree's own word for the
   *  same row, so the wall and the tree cannot name one destination two ways. */
  label: string;
  drag: DeckDrag | null;
  onOpen: () => void;
  canDrop: (drag: DeckDrag) => boolean;
  onDropDeck: (drag: DeckDrag) => void;
  /** The other drag: a **folder** moved up out of the level on screen, landing last in the level
   *  above — `folderLanding`'s `inside` answer, asked of the destination rather than of a card. */
  canDropFolder: (drag: FolderDrag) => boolean;
  onDropFolder: (drag: FolderDrag) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const over = useDeckDropTarget({ ref, canDrop, onDrop: onDropDeck });
  const { armed, edge } = useFolderDropTarget({
    ref,
    scope: "deck",
    axis: "horizontal",
    canDrop: (folder) => canDropFolder(folder),
    onDrop: (folder) => onDropFolder(folder),
  });
  const eligible = drag !== null && canDrop(drag);

  return (
    <ParentFolderCard
      cardRef={ref}
      label={label}
      armed={eligible || armed}
      over={over || edge !== null}
      onOpen={onOpen}
    />
  );
}

/** One member cover in a folder card's strip. Its own component because {@link useImageRetry}
 *  is a hook and a strip is a loop.
 *
 *  **Both candidates go to `cardArtSrc`, which is the whole of the desktop/web branch and is
 *  written nowhere else.** `mtgimg://` is a Tauri custom protocol and wasm cannot register a URL
 *  scheme with a browser, so on web the picture is whatever `deck_list` put on that member's own
 *  row — and `null` when it put none. A `null` draws the empty `bg-surface` cell below, which is
 *  the same thing this frame shows while the bytes are on their way: the strip keeps its
 *  geometry either way, and no broken `<img>` is ever left in it. */
function MemberArt({ cardId, artUrl }: { cardId: string; artUrl: string | null }) {
  const image = useImageRetry(cardArtSrc(cardImageUrl(cardId, 0, "art"), artUrl));
  return (
    <span className="min-w-0 flex-1 overflow-hidden bg-surface">
      {image.src && (
        <CardImage
          // Decorative: the folder's name is under it, and the credit is its own line.
          alt=""
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}
