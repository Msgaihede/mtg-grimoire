/**
 * A folder as it is drawn on the gallery wall, beside the deck tiles rather than in the tree.
 *
 * Lifted out of `DecksPage.tsx` on 2026-08-16, whole — the card, the member art it is made of,
 * and the one query the page needs to fill it. `FolderTree.tsx` draws the same folders as *rows*
 * in the sidebar; this is the other drawing of them, and the two share only the drop target and
 * the tree itself.
 *
 * **Two cards live here and they are opposites**: {@link FolderCard}, a drawer drawn in a deck
 * tile's own frame so that a wall of both is one wall, and {@link ParentDeckFolderCard}, the way
 * back up, drawn in the same frame with a dashed accent edge so that the one tile that is not a
 * place cannot be mistaken for one.
 */
import { useRef } from "react";
import { Folder, FolderUp } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { FolderDropLine } from "@/components/FolderDropLine";
import { UP_ONE_LEVEL, upCardName } from "@/components/ParentFolderCard";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cardScaleVars } from "@/lib/cardZoom";
import { plural } from "@/lib/counts";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import { useFolderDropTarget, type FolderDrag, type FolderEdge } from "@/lib/folderDrag";
import { FOCUS } from "@/lib/focus";
import { ART_ASPECT, cardArtSrc, cardImageUrl } from "@/lib/images";
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

/** How many member covers a folder card shows. Three, because they are laid side by side across
 *  one card's width and a fourth crop at that width is a smear rather than a picture.
 *
 *  It said "the strip is 96px tall" until the card became a deck tile's frame on 2026-09-08. The
 *  number did not move with the geometry, because what bounds it was always the **width** each
 *  crop is left with rather than the height they were drawn at. */
const FOLDER_ARTS = 3;

/**
 * The 20px a deck tile spends on the colour band fused to the foot of its cover, spent here as
 * padding under the crops — which is the whole of what makes a folder card and a deck tile the
 * same height in one grid track.
 *
 * **So this number is the band's, and a change to one is a change to the other.** It is written
 * here rather than imported because `DeckTile` spends it on a drawn thing and this card spends it
 * on empty box, so there is no one constant that would be honest in both places; what there is
 * instead is this sentence, and a `1.25rem` that has to be read beside the band's own before
 * either moves. `--mark-scale` because the whole card scales with the wall's zoom, and the two
 * would come apart at every stop but 100% if one of them held still.
 *
 * {@link ParentDeckFolderCard} carries it too: the way out of a drawer stands in the same track
 * as the drawers.
 */
const BAND_PAD = "pb-[calc(1.25rem*var(--mark-scale,1))]";

/**
 * `decks`, or `deck` where there is one — the unit alone, with the figure taken off the front.
 *
 * The caption draws the count in `font-mono tabular-nums`, so that a wall of drawers keeps its
 * figures in one column and a two-digit folder does not shove its own word sideways; that makes
 * the number and its unit two elements, where {@link plural} answers with them joined.
 *
 * **Slicing that answer rather than writing `n === 1 ? "deck" : "decks"` here is the deliberate
 * half.** `src/lib/counts.ts` exists because four surfaces had four spellings of that ternary
 * with three incompatible signatures, and a fifth spelled for the sake of one word is the same
 * mistake made small. The coupling is to that function's documented shape — `${n} ${unit}` — and
 * to nothing else, which is why the slice is measured off the number rather than off a space.
 */
function deckUnit(n: number): string {
  return plural(n, "deck").slice(`${n} `.length);
}

/** Every live deck filed in a folder **or in anything under it** — what a folder card draws
 *  its member art from, in `deck_list`'s own order (most recently touched first).
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
 * **It is drawn in a deck tile's own format, and that is 2026-09-08's change.** What stood until
 * then was a dashed box holding a 96px strip of up to three crops, then the folder's name with a
 * bare figure beside it, then the word `Folder` on a line of its own — an entirely different
 * silhouette from the tile it shares a grid track with, so a wall holding both read as two kinds
 * of object rather than as one wall. The card is one framed box now: the art's proportions plus
 * {@link BAND_PAD}, the crops filling the whole of it, and the name and the count in a caption
 * laid **on** the pictures.
 *
 * **The count moved out of a right-aligned column of its own and into that caption's sentence**,
 * which is the one change here that is not about shape. A bare `4` at the end of a folder's name
 * meant nothing without the word beside it — it was a quantity of nothing in particular, the
 * mistake `src/CLAUDE.md` records the search wall making with `132` — and the sentence now says
 * what the `aria-label` has always said.
 *
 * **So the border is solid, and the dash it gave up was prose rather than decoration.** This
 * comment used to name the dash as the screen's one visual rule — *dashed means provisional* —
 * and it cannot go on saying so here: a folder is not provisional beside a deck, it is the same
 * object with decks inside it, which is exactly what drawing the two the same way claims. The
 * vocabulary survives on this wall where it still says something, which is
 * {@link ParentDeckFolderCard}: the way *out* of a drawer is the dashed tile here now, in accent
 * rather than in the border colour, and it is the only thing on the wall that is not a place.
 *
 * **The wishlist's and the collection's folder cards keep the dash and are untouched**, and the
 * divergence is honest rather than drift: those walls draw a folder as a 62px line of type
 * beside 62px lines of type, where an edge is the only thing separating a container from a
 * control, and this one draws it as a picture the size of a deck's picture with the word
 * `Folder` set in the caption. (`lib/dropMarks.ts` still describes all four folder cards as
 * dashed. It is a page about the marks, its argument is unaffected — {@link DROP_EDGE} recolours
 * whatever edge a card already owns — and it is one wall behind.)
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
   * Every size on the card is a `calc` off `--mark-scale`, which this publishes on the `<li>`:
   * the caption's two lines, the glyph beside them, the seams between the crops and
   * {@link BAND_PAD} at the foot. The pictures themselves need no help — the frame takes its
   * height from the art's aspect ratio, so the crops follow the track's width for free.
   *
   * **That is what the strip could not do**, and it is why this prop was here before the card was
   * a frame: three crops at a fixed 96px had no aspect to follow, so without a number of their
   * own the tiles around them grew and the pictures stayed a 96px band — the one thing on the
   * wall that ignored the gesture, which is how a zoom starts looking broken.
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

  // Scryfall's image policy, applied to these crops exactly as it is to a cover: an `art` crop has
  // no printed frame, so a cover this app cannot name an illustrator for is not drawn. The rule
  // is on `https://scryfall.com/docs/api` under the image guidelines — see `DeckTile`'s
  // {@link Cover}, which quotes it in full and is where this card's credit went.
  //
  // **This excludes a custom cover, and that is deliberate — do not "fix" it.** A deck wearing
  // the reader's own picture therefore contributes its *card* art here (or nothing, if it has
  // none), which is a small inconsistency with its own tile and the cheaper of the two
  // mistakes.
  //
  // **The filter stays exactly as it is, and 2026-09-07 is what makes it load-bearing rather
  // than merely tidy.** Both fields are required, so every crop this strip draws has a name to
  // put on it — which is precisely what lets the credit move onto the pictures. The version of
  // this comment that stood until then argued the strip was a sample under **one** credit line
  // and that the alternative, "a credit line that names artists for some tiles in the strip and
  // not others", was worse than the inconsistency. That was true of a line; it is not true of
  // three tooltips. Each picture now carries its own painter's name, which is the arrangement
  // that objection was really asking for — and it is strictly better than what it replaced,
  // since the old line comma-joined up to three names with no way to tell which crop belonged
  // to whom. Ruled 2026-08-11 and re-ruled 2026-09-07, rather than left as an oversight.
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
              // about that card and this list is already holding the row.
              artUrl: deck.imageUris?.art ?? null,
            },
          ]
        : [],
    )
    .slice(0, FOLDER_ARTS);

  return (
    <li
      ref={ref}
      // The wall's two scale variables, set here for the reason `DeckTile` sets them: everything
      // inside the card inherits them, so the caption, the seams between the crops and the band
      // of padding at the foot follow one number and nothing has to be threaded down.
      style={cardScaleVars(zoom)}
      className="group relative rounded-lg"
    >
      {/* **Two boxes for two drags, and it is the drag library that insists.**
          `dropTargetForElements` keeps one registration per element — a second one replaces the
          first in its `WeakMap` and warns in dev — so the deck drop on the `<li>` and the folder
          drop cannot share a box. This inner one is the folder's, and it is also where the folder
          is picked up, so a single element is the whole of what the folder gesture reads and
          writes. The two are the same rectangle, which matters because this one is *measured*:
          `folderEdge` divides its box into the three landings.
          **Neither box wears a mark any more, and that is 2026-09-03's change.** They are
          wrappers *around* the card rather than the card, and a Tailwind ring is a box shadow
          painted **outside** the border box — so what shipped was a ring on the `<li>` for the
          deck drag, a second one here for the folder drag, and the button's own dashed edge
          inside both: three concentric outlines for one landing, none of them touching. This card
          was the worst case in the app, and it is what the reader's report about affordances
          being bulky, overlapping their neighbours and not lining up with the dotted outline was
          made against. Both marks moved onto the `<button>` below — the element that already
          carries the card's own edge — so the border a folder card draws all day is the thing
          that changes colour, and there is no second outline left to fail to line up with. The
          registrations stayed exactly where they are and had to: they are the boxes the two drags
          are read and measured against, and only the `className` moved.
          **That arrangement is also what decided where the frame's edge goes when this card
          became a deck tile's box on 2026-09-08.** The border could have gone on a face inside
          the button, which is how a deck tile's cover is built — and it would have re-made the
          three concentric outlines this paragraph is the record of, at the one place the app has
          already been reported for. So the frame *is* the button: the border, the radius, the
          clip and both marks are one element's. The edge is solid now where it was dashed, and
          the marks do not care — {@link DROP_EDGE} recolours whatever edge the element owns.
          **`eligible` and `armed` collapse onto that one mark**, which is sound rather than a
          shortcut and is already the arrangement the sibling folder cards use: only one drag is
          ever in the air, so the two are the same claim — *this card could take what you are
          holding* — about different payloads, and no card can be answering both at once. The
          third landing is what a deck has no equivalent of, and it is the line below. */}
      <div ref={folderRef} className="relative rounded-lg">
        <button
          type="button"
          // Starts with the visible label, then says the two things the card's marks say — WCAG
          // 2.5.3, and the reason the count is not spliced into the middle of the name.
          aria-label={`${node.folder.name} folder, ${plural(node.count, "deck")}`}
          onClick={() => onOpen(node.folder.id)}
          onContextMenu={menu.onContextMenu}
          onKeyDown={menu.onKeyDown}
          className={cn(
            // The frame, and it is a deck tile's: the same border, the same radius, the same
            // surface under it. `relative` is load-bearing rather than tidy — the crops and the
            // caption are laid over this box with `absolute`, and an `overflow` clips an
            // absolutely positioned descendant only where the clipping box is in its
            // containing-block chain. Without it they would resolve against the `<div>` above,
            // whose whole job is to be a drop target's rectangle, and the pictures would hang
            // square-cornered over a rounded frame.
            "relative block w-full overflow-hidden rounded-lg border border-border bg-surface",
            "text-left",
            BAND_PAD,
            "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
            // Both drags' *eligible* mark, on the card's own edge rather than around it — and it
            // has to be written **before** the line below, because `tailwind-merge` resolves the
            // border colour by argument order: the card the pointer is actually over would
            // otherwise have its full-strength edge pulled back down to 45% by the wider claim.
            (eligible || armed) && DROP_EDGE,
            (over || edge === "inside") && cn("border-accent", DROP_OVER),
            FOCUS,
          )}
        >
          {/* The shape, and it draws nothing at all. A deck tile's cover is a full-width box on
              `ART_ASPECT` and takes its height from the grid track for free; three crops side by
              side have no aspect of their own to follow, so the card borrows the cover's by
              holding an empty box of exactly it and letting {@link BAND_PAD} add the band's 20px
              underneath. The same constant as the cover uses, imported rather than respelled —
              two spellings of one ratio is how the deck's Grid view came to disagree with the
              wall docked beside it. */}
          <span className="block w-full" style={{ aspectRatio: ART_ASPECT }} />
          {/* The pictures **are** the card, so they are laid over the whole frame — the band's
              20px included, which is what makes the crop reach the bottom edge rather than
              stopping short of a strip of surface nothing is drawn on. They were a fixed 96px
              band above the name until 2026-09-08.
              The 2px seams scale, so three pictures stay three pictures rather than becoming one
              at 2×. */}
          <span className="absolute inset-0 flex gap-[calc(2px*var(--mark-scale,1))]">
            {arts.length === 0 ? (
              <span
                aria-hidden="true"
                className="grid w-full place-items-center text-[calc(0.7rem*var(--mark-scale,1))] text-dim"
              >
                {node.count === 0 ? "Empty" : "No cover art"}
              </span>
            ) : (
              arts.map((art) => (
                <MemberArt
                  key={art.id}
                  cardId={art.cardId}
                  artUrl={art.artUrl}
                  artist={art.artist}
                />
              ))
            )}
          </span>
          {/* The caption, on the art rather than under it — `bg-bg/72` over the pictures, which
              is `color-mix(in oklab, var(--color-bg) 72%, transparent)` written the way this app
              spells an opacity on a token. It is what buys the card its height back: the name and
              the count used to be two lines of layout below the strip, and printing them over the
              crops is how a folder comes to be exactly a deck tile tall.
              The name is at the deck tile's own name size and the row under it at the caption
              size, off the same variable and in the same order — the two cards sit in one grid
              track, and a name that disagreed about its own size would be the first thing a
              reader saw. */}
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 bg-bg/72",
              "px-[calc(0.5rem*var(--mark-scale,1))] py-[calc(0.375rem*var(--mark-scale,1))]",
            )}
          >
            <span
              className={cn(
                "block truncate",
                "text-[calc(0.875rem*var(--mark-scale,1))] leading-[calc(1.25rem*var(--mark-scale,1))]",
              )}
            >
              {node.folder.name}
            </span>
            <span
              className={cn(
                "flex items-center gap-[calc(0.25rem*var(--mark-scale,1))] text-dim",
                "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
              )}
            >
              {/* The one accent thing on the card, and it is the word's own glyph rather than an
                  ornament: a caption that says `Folder` beside a folder is what tells a drawer
                  from the deck tiles it is now shaped exactly like. */}
              <Folder
                aria-hidden="true"
                className="size-[calc(0.75rem*var(--mark-scale,1))] flex-none text-accent"
              />
              <span className="truncate">
                Folder · <span className="font-mono tabular-nums">{node.count}</span>{" "}
                {deckUnit(node.count)}
              </span>
            </span>
          </span>
        </button>

        {/* Drawn straight off `edge`, which is `null` both when the pointer is elsewhere and when
            it is over a part of this card that would refuse — so no line means no drop, rather than
            a mark leading to a write that never happens. It is `absolute` against the box above,
            which is why that box is `relative`; it spans the whole card rather than one of the
            crops in it, because what it marks is the *slot* the folder would take rather than the
            picture. (It used to span a credit line under the card as well — that line was
            deleted on 2026-09-07 and the artists moved onto the crops themselves — and the card
            became a framed box on 2026-09-08, which moved the name and the count onto the art.
            Both changed the box's height and neither changed what this line is for.) */}
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
 * **It draws itself, and until 2026-09-08 it was `components/ParentFolderCard` with two drop
 * targets wrapped round it.** That component is still the wishlist's tile and the collection's,
 * unchanged, and it is still where the *words* come from — {@link UP_ONE_LEVEL} and
 * {@link upCardName} are imported rather than respelled, so a wall that says "Up one level" on
 * one page cannot say "Back" on another and the accessible name is the same string on all three.
 * What could not be shared any longer is the **drawing**: those two walls lay a folder out as a
 * 62px line of type among 62px lines of type, and this one lays it out as a picture the size of a
 * deck's picture, so one tile cannot be both without one of the three walls getting a shape
 * nobody asked for. A change to the phrasing is still one edit; a change to the shape is now two,
 * and that is the honest cost of the two walls having stopped being the same wall.
 *
 * **It is the same box as a folder card and deliberately not the same edge.** Same frame, same
 * radius, same {@link BAND_PAD}, so it stands in the track at exactly a deck tile's height — and
 * a **dashed accent** border where a drawer is now solid, because this is the one tile on the
 * wall that is not a place. That is where the dash a folder card gave up went: it still means
 * *not a thing you own*, and here it is the only thing wearing it.
 *
 * Both drop targets register on the **same `<li>`**, where a folder card needs two boxes: this
 * tile has one landing, so there is no geometry for `folderEdge` to divide, and `readDeckDrag`
 * and `readFolderDrag` are disjoint, so `accepts()` keeps the two apart.
 *
 * **The ring is raised from the page's `drag`, not from the target** — `useDeckDropTarget` returns
 * only `over` for the reason `deckDrag.ts` gives: every folder-shaped target answers the same
 * yes/no about a deck, so the gallery asks once and hands the answer down. That is why this takes
 * a `drag` where the wishlist's and the collection's tiles do not; the folder half still arms
 * itself, because two folders never answer the same about the folder in the air.
 *
 * **No member art, where a folder card is made of it.** The pictures are what a folder is
 * recognised by, and this tile is not a folder to recognise — it is the way out. Drawing the
 * parent's members in it would make the wall's most-recently-touched art appear twice, once as a
 * destination and once as a place. What fills the frame instead is the destination's own name,
 * set in the display face over a `FolderUp` glyph, which is the one thing a reader has to read
 * before letting go.
 *
 * **Every size here reads `--mark-scale`'s fallback**, because the wall hands this tile no
 * `zoom` — `DecksPage` scales the folder cards and the deck tiles and has never scaled this one.
 * The `calc`s are written anyway, so that a `zoom` prop later is one line at the call site rather
 * than five re-spellings here; what keeps the tile the height of its neighbours in the meantime
 * is `h-full` on a stretched grid item, which is the mechanism `components/ParentFolderCard` uses
 * and the reason its own comment gives.
 */
export function ParentDeckFolderCard({
  label,
  zoom,
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
  /**
   * How large the reader draws a deck — the same number every other object in the track is given.
   *
   * **It arrived when this tile stopped being a two-line box and became a framed one** (this
   * change). Before, the card was words in a stretched grid item and `h-full` was the whole of
   * its geometry, so it kept pace with its neighbours without knowing the zoom existed. Now it
   * draws a glyph, a heading-face label and a caption at sizes written as `calc(… *
   * var(--mark-scale, 1))` — and a tile that never sets that variable reads the fallback of 1,
   * so at 2× the wall's decks and folders doubled and the way *out* of the folder stayed at its
   * shipped size, in a box that had grown around it. The prop is what sets the variable, through
   * {@link cardScaleVars}, exactly as {@link FolderCard} and `DeckTile` set it.
   */
  zoom: number;
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
    <li ref={ref} style={cardScaleVars(zoom)} className="relative rounded-lg">
      <button
        type="button"
        // Unchanged, and the one thing on this tile that must not move: the destination is said
        // in the visible label and the accessible name is built around it, which is WCAG 2.5.3
        // met by containment. A name that was only the folder's own would make this tile
        // indistinguishable from the card for that same folder one level up.
        aria-label={upCardName(label)}
        onClick={onOpen}
        className={cn(
          // `h-full` on a stretched grid item, so the tile is as tall as the drawers beside it
          // whatever the reader's zoom has done to them — the aspect box below sets the shape and
          // this sets the height. `justify-center` is what keeps the three lines in the middle of
          // a cell that has grown past them; pinned to the top they read as a card whose picture
          // failed to load, which is `components/ParentFolderCard`'s own finding.
          // Centred rather than `text-left`, which is the one thing about this tile's contents
          // that is not a folder card's: a folder card's caption is a line of type under three
          // pictures and reads from the left like every other caption on the wall, and this box
          // holds nothing but the destination, so anything but the middle of it reads as a
          // picture that failed to arrive beside the words.
          "flex h-full w-full flex-col justify-center overflow-hidden rounded-lg bg-surface",
          // Dashed, and accented rather than the border colour: the drawers on this wall are
          // solid framed boxes now, so the dash is free to mean the one thing left that is not a
          // place. 55% is the canvas's `color-mix(in oklab, var(--color-accent) 55%, transparent)`
          // — present enough to read as the way out, quiet enough not to outshout a wall of art.
          "border border-dashed border-accent/55",
          BAND_PAD,
          "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
          // Both drags' *eligible* mark, and it has to be written **before** the line below for
          // the reason `FolderCard` states above: `tailwind-merge` resolves a border colour by
          // argument order, so the tile the pointer is actually on would otherwise have its
          // full-strength edge pulled back to 45% by the wider claim.
          (eligible || armed) && DROP_EDGE,
          (over || edge !== null) && cn("border-accent", DROP_OVER),
          FOCUS,
        )}
      >
        <span
          className={cn(
            "flex w-full flex-col items-center justify-center",
            "gap-[calc(0.25rem*var(--mark-scale,1))] px-[calc(0.75rem*var(--mark-scale,1))]",
          )}
          // The same ratio a folder card and a deck cover are drawn at, so the way out stands in
          // the track at the shape of the things it stands among rather than at the height of
          // whatever type happens to be in it.
          style={{ aspectRatio: ART_ASPECT }}
        >
          {/* The folder silhouette with the direction drawn inside it, rather than a bare arrow —
              which would read as a control among containers. */}
          <FolderUp
            aria-hidden="true"
            className="size-[calc(1.25rem*var(--mark-scale,1))] flex-none text-accent"
          />
          {/* The destination in the display face, because it is the *name* a reader is aiming at
              and this tile has the room a folder card's caption does not. */}
          <span
            className={cn(
              "max-w-full truncate font-heading",
              "text-[calc(1.125rem*var(--mark-scale,1))]",
            )}
          >
            {label}
          </span>
          {/* And what pressing it does, at the caption size the folder cards' second line is set
              at — the one line that tells this tile from the card for the same folder one level
              up. */}
          <span
            className={cn(
              "max-w-full truncate text-dim",
              "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
            )}
          >
            {UP_ONE_LEVEL}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * One member cover in a folder card. Its own component because {@link useImageRetry} is a hook
 * and a row of crops is a loop.
 *
 * **Only its box changed on 2026-09-08**, and it changed by not being one: the crops fill the
 * whole frame now instead of sitting in a 96px band above the name, so this cell is a `flex-1`
 * column of a box that is the card. Everything below — the two source candidates, the artist's
 * tooltip, the empty cell, the retry — is exactly what it was.
 *
 * **Both candidates go to `cardArtSrc`, which is the whole of the desktop/web branch and is
 * written nowhere else.** `mtgimg://` is a Tauri custom protocol and wasm cannot register a URL
 * scheme with a browser, so on web the picture is whatever `deck_list` put on that member's own
 * row — and `null` when it put none. A `null` draws the empty `bg-surface` cell below, which is
 * the same thing this frame shows while the bytes are on their way: the card keeps its geometry
 * either way — it comes from the aspect box rather than from any picture — and no broken `<img>`
 * is ever left in it.
 *
 * **The illustrator's name is this frame's since 2026-09-07, and it is the reason the card's
 * credit line could go.** Scryfall's image guidelines require an `art` crop's artist to be
 * identifiable in the interface presenting it — `https://scryfall.com/docs/api`, quoted in full
 * over `DeckTile`'s `Cover`, and *not* `docs/api/images`, which carries no artist rule any more —
 * and a tooltip per picture satisfies that better than the line it replaced: `Art by A, B, C`
 * under three crops named three painters and said nothing about which had painted which. Each
 * picture now answers for itself.
 *
 * Its own `useTooltip` rather than a binder threaded down from the card, because a hook is what a
 * hook is: the crops are a loop and each one is a separate anchor, which is the same reason this
 * component exists at all.
 */
function MemberArt({
  cardId,
  artUrl,
  artist,
}: {
  cardId: string;
  artUrl: string | null;
  /** Never `null`: the `arts` builder above requires both `coverCardId` and `coverArtist`, so a
   *  crop with nobody to credit is not on the card to begin with. */
  artist: string;
}) {
  const tip = useTooltip();
  const image = useImageRetry(cardArtSrc(cardImageUrl(cardId, 0, "art"), artUrl));
  return (
    <span {...tip(`Art by ${artist}`)} className="min-w-0 flex-1 overflow-hidden bg-surface">
      {image.src && (
        <CardImage
          // Decorative: the folder's name is under it, and the illustrator is the tooltip on
          // the frame around it — an `alt` here would put a painter's name into the folder
          // card's accessible name three times over.
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
