import { useMemo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { dragData } from "@/features/decks/dnd";
import { CardGrid, PHONE_TILE_WIDTH, type GridCard } from "@/features/search/CardGrid";
import { isFinish, type Finish } from "@/lib/finish";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder, WishRow } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useNarrowWindow } from "@/lib/useNarrowWindow";
import { cn } from "@/lib/utils";
import { EditWishButton } from "./EditWish";
import { printingOf, wishLabel } from "./wish";
import { wishDragData } from "./wishDrag";
import { ElsewhereMark, WishFolderCaption } from "./wishMarks";

/** One tile of the wall: a wish, and the printing there is a picture of. */
interface WishTile extends GridCard {
  wish: WishRow;
}

/**
 * The wish a tile is for, and the printing it is drawn as — which are two different things, and
 * the whole of what this mapping has to keep apart.
 *
 * `id` is `artCardId`: what there is a picture of, what a press opens, and what the pane rings.
 * It is **not** `cardId`, which is what the wish is *for* and is null on a wish for any printing
 * — so an unpinned wish is drawn as the newest printing of its oracle card and captioned "Any
 * printing", never as the cardboard the picture happens to show. `""` is a genuine orphan, and
 * `GridCard.id` is where that value is defined: no art, no click.
 *
 * The set and number are carried anyway, from the *wish*, so the tile keeps a truthful pair for
 * anything that reads the shape — {@link tileCaption} is what actually draws them.
 */
function toTile(wish: WishRow): WishTile {
  return {
    id: wish.artCardId ?? "",
    // Never null: a wish carries its own name, because it outlives the printing it was made
    // from and may never have had one. It is the `alt`, and the whole of what an orphan's
    // no-art frame has to show.
    name: wish.name,
    setCode: wish.setCode ?? "",
    collectorNumber: wish.collectorNumber ?? "",
    rarity: wish.rarity,
    // The picture of the printing this wish is *drawn as* — the same join `artCardId` above
    // came from, so the art and the id under it are one answer. Ignored on the desktop.
    imageUris: wish.imageUris,
    wish,
  };
}

/**
 * The caption: which printing the wish is for, in the words its table uses — plus the duplicate
 * mark spec §4 puts beside it.
 *
 * `printingOf` rather than the wall's own `SET · number`, and that is the reason `CardGrid` has
 * a caption slot at all — an unpinned wish is drawn as a printing it is not for, and a caption
 * reading "DSK · 123" under that picture would say the reader had asked for that piece of
 * cardboard.
 *
 * **{@link wallPrinting}, not `printingOf` itself, because this line sits beside a glyph and the
 * table's does not.** See that function: the finish is the other half of what makes two wishes for
 * one card two wishes, and it is still said here — by the chin's own mark where there is one.
 *
 * **One mark shares this line now, and the folder caption that used to sit beside it has moved
 * over the art** (2026-09-08). The paragraph this replaces argued that both marks had to be here
 * because every corner of a tile already had an owner, and it listed them: bottom-left the
 * owned/wanted fraction, top-left the review flag and the cost, top-right `FoilOverlay`'s chip.
 * That inventory is what changed. The fraction is gone with every other comparison this list
 * made against the collection, the flag and the cost have moved to the tile's bottom-right, and
 * bottom-left now holds the folder above a plain count of copies wanted — where the folder is a
 * word the reader chose and reads better on the picture than squeezed between a set code and a
 * price at 10px.
 *
 * What has **not** changed is the budget the old paragraph turned on: `CardGrid` positions its
 * virtual rows from `CAPTION_HEIGHT`, so a second line here is still a wall whose rows overlap by
 * the difference. The printing truncates and the duplicate mark stays `shrink-0` beside it.
 *
 * A closure over the page's answer, so it is not module scope like the drag beside it — which
 * costs nothing, because `caption` is read on **render** rather than registered (see `CardGrid`,
 * where only `dragRecord`/`tileRef` and the three card-fact slots ask to be held still).
 */
const caption = (tile: WishTile) => (
  <span className="flex min-w-0 items-center gap-[calc(0.375rem*var(--mark-scale,1))]">
    <span className="min-w-0 truncate">{wallPrinting(tile.wish)}</span>
    <ElsewhereMark count={tile.wish.elsewhere} />
  </span>
);

/**
 * The finish this wish is **for**, where the app has an enum's word for it.
 *
 * Where the search derives this from the printing's own finish list, a wish simply says it: a
 * wish for the foil is a different wish and is not filled by the nonfoil. `isFinish` guards it
 * because `wishlist_entries.preferred_finish` is TEXT with a CHECK rather than an enum this side
 * knows. No preference answers `null`, which is right — "no preference" is not nonfoil.
 */
const preferredFinishOf = (wish: WishRow): Finish | null => {
  const preferred = wish.preferredFinish;
  return preferred !== null && isFinish(preferred) ? preferred : null;
};

/**
 * The same fact as the sheen and corner chip `CardArt` draws over the picture.
 *
 * Module scope, like the drag beside it: the wall re-registers a tile when a callback's identity
 * changes.
 */
const tileFinish = (tile: WishTile): Finish | null => preferredFinishOf(tile.wish);

/**
 * The printing this wish is for **as the wall says it** — which is the table's sentence minus
 * whatever the chin's own glyph is already saying.
 *
 * The wall and the table draw the same fact into two different surroundings, and the right answer
 * differs for that reason alone. The table has no art, no chin and no glyph, so the word is the
 * only statement of the finish there and `printingOf` stays exactly as it is for it. The wall's
 * caption is now the chin's printing line, one gutter away from `FinishMark` — so `LEA · 161 ·
 * Foil ✦` said "Foil" twice, once in a word and once in a glyph whose accessible name is that
 * same word, on the surface with the least room in the app to say anything twice.
 *
 * **The word is dropped exactly where the glyph replaces it, and nowhere else** — which is why
 * this asks {@link preferredFinishOf} rather than testing `preferredFinish` for truthiness:
 *
 * * **`nonfoil` keeps its word.** `FinishMark` returns `null` for it — nonfoil is the finish a
 *   price is assumed to be — so a blanket drop would leave a wish *for the nonfoil* looking
 *   identical to a wish with no preference. Those are two different wishes and the whole of
 *   `WISH_PREFERRED_FINISH`'s note in `wishlist.rs` is that they must not be collapsed.
 * * **A value `isFinish` does not know keeps its word** for the same reason: `tileFinish` hands
 *   `CardGrid` a `null` for it, so no glyph is drawn and the caption is again the only statement.
 *
 * It is built by handing `printingOf` a row with the finish taken off rather than by rebuilding
 * the `SET · number` half here, so there is still exactly one definition of *which printing* —
 * and **"Any printing" therefore survives untouched**, which is the one thing this caption exists
 * to protect: a wish for the card is drawn as a printing it is not for, and no wall may caption
 * that picture with the cardboard's own name.
 */
function wallPrinting(wish: WishRow): string {
  const spoken = preferredFinishOf(wish);
  return spoken !== null && spoken !== "nonfoil"
    ? printingOf({ ...wish, preferredFinish: null })
    : printingOf(wish);
}

/**
 * What a tile carries when it is dragged — spec §1's third drag source, and since spec §9 a
 * gesture that means **two things at once**.
 *
 * **Every wish is draggable now, and the card half is still withheld from the unpinned ones.**
 * That withholding is the paragraph this one replaces and its reason has not changed: a wish with
 * no `card_id` is for the *card*, so there is no printing to carry, and a `{kind:"card"}` payload
 * built from one would arrive at a deck column holding an empty id — which addresses every row
 * and no row (`dnd.ts`). What changed is the conclusion drawn from it. "Set this one aside" is a
 * wish operation with nothing to do with owning a printing, so such a wish carries
 * {@link wishDragData}'s mark **alone**: `readDragData` answers `null` for it and the deck's drop
 * targets light nothing up, which is exactly what they do today when the tile cannot be picked up
 * at all — while a folder card reads its own key and takes it.
 *
 * A **pinned** wish carries both marks in one flat record, which is what `CardGrid`'s
 * `dragRecord` exists to pass and why it is not `dragPayload`: the two keys are two readers'
 * business, neither unwraps anything, and neither can see the other's.
 *
 * The type line files the card when it is let go somewhere with no column to point at — the
 * sidebar's Decks entry — and is the one thing `WishRow` carries that neither layout draws.
 */
const tileDrag = (tile: WishTile): Record<string, unknown> => {
  const wish = wishDragData({
    wishId: tile.wish.id,
    name: tile.wish.name,
    folderId: tile.wish.folderId,
  });
  return tile.wish.cardId === null
    ? wish
    : {
        ...dragData({
          kind: "card",
          cardId: tile.wish.cardId,
          name: tile.wish.name,
          typeLine: tile.wish.typeLine,
        }),
        ...wish,
      };
};

/**
 * The pill every mark in the tile's bottom-left corner is drawn in.
 *
 * That corner holds **two** marks now — the folder above the copies wanted — so it is the one
 * corner on any wall in this app where `CardGrid`'s single chip is the wrong shape: sized to
 * `Commander` it would leave `×4` alone on a row of empty backing half the tile wide. So the wall
 * passes `badgeChrome="bare"` and each mark brings its own.
 *
 * The numbers are `CardGrid`'s corner chip, copied deliberately rather than shared, because what
 * is being kept identical is what a mark *looks* like on a photograph across six walls: the app's
 * own table felt at 85%, the quietest thing that can sit on a card without becoming a sticker,
 * and every size scaled on `--mark-scale` so the chip is the same place on the picture at every
 * stop of the zoom ladder.
 */
const CORNER_PILL = [
  "rounded-[calc(0.25rem*var(--mark-scale,1))] bg-bg/85",
  "px-[calc(0.375rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
].join(" ");

/**
 * How many copies the reader wants — and nothing else, which is the whole of what this mark is.
 *
 * **It replaced `WishProgress` on 2026-09-08 and the deletion is the point.** That mark drew
 * `owned/wanted` and receded to `text-dim` when the collection covered the wish, on the argument
 * that a fulfilled wish is the wall's version of the dimmed row its table drew. There is no such
 * thing as a fulfilled wish any more: a wishlist is the reader's own list, kept by hand, and they
 * take a card off it when they acquire one — so a tile that quietly reported how far along the
 * binder had got was answering a question this list does not ask. What is left is the number the
 * stepper in the right margin writes, said once, in the corner the reader already reads it in.
 *
 * `OwnedBadge`'s recipe for the parts that still apply: the mono face and `--mark-scale`, so this
 * corner and the collection wall's are the same object at every zoom even though they count
 * different things; an `aria-hidden` `×N` beside an `sr-only` sentence, because `×4` is an
 * abbreviation and a screen reader is owed the words; and `describes: false` on the tooltip, since
 * that sentence is already in the accessibility tree and a wired `aria-describedby` would have it
 * read twice.
 */
function WishWanted({ wish }: { wish: WishRow }) {
  const tip = useTooltip();
  const sentence = `${wish.quantity} ${wish.quantity === 1 ? "copy" : "copies"} wanted`;
  return (
    <span
      {...tip(sentence, { describes: false })}
      className={cn(
        CORNER_PILL,
        "inline-flex shrink-0 items-center font-mono tabular-nums text-text",
        "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
      )}
    >
      <span aria-hidden="true">×{wish.quantity}</span>
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

/**
 * The wishlist as a wall of art: one tile per wish, with what it will cost still to finish.
 *
 * The thin twin of the collection's wall, over rows that are wishes rather than entries — and
 * one tile is one **wish**, never one card. A foil wish and a nonfoil wish for the same printing
 * are two wishes with two prices, and the collection's wall merges its rows precisely because
 * there the opposite is true: a foil and a played nonfoil are two entries to maintain and one
 * piece of art to look at.
 *
 * Virtualised, zoomable and walkable by the same component the search and the collection draw,
 * which is the point of it being that component: a reader who has learned one of this app's
 * walls has learned all of them.
 */
export function WishlistGrid({
  rows,
  listKey,
  folders,
  nodes,
  folderNameOf,
  flattened,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
  onSetFolder,
  onChangePrinting,
  onAnyPrinting,
  rowMenu,
  rowMenuKey,
  marketplace,
}: {
  rows: WishRow[];
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  /** The flat folder rows and the tree built from them, both straight through to
   *  {@link EditWishButton} — see its own doc for why it wants two shapes of one read. */
  folders: readonly WishlistFolder[];
  nodes: readonly FolderNode<WishlistFolder>[];
  /**
   * What to call the folder a wish is filed in — `Wishlist` for the root, and `null` for a folder
   * this page cannot name.
   *
   * The page's job rather than this component's, because the page is the one holding both the
   * wishes and the folder list; joining them per tile here would be a lookup table rebuilt on
   * every render of every wall. `null` draws **nothing** rather than a blank chip: a folder
   * another window deleted between the two reads is a caption with no honest text.
   */
  folderNameOf: (folderId: number | null) => string | null;
  /** Whether the list is showing every wish regardless of filing — spec §4's Flatten. The
   *  folder caption is drawn only here, because inside a folder it would be the same word under
   *  every tile and the breadcrumb above already says it. */
  flattened: boolean;
  onNeedNextPage: () => void;
  /**
   * How many copies this wish is for — reached from **two** controls on one tile since issue
   * #284: the stepper in the action strip, and the panel behind the pencil beside it. One prop
   * for both, so a tile cannot grow two answers to one question; and `0` is a number either of
   * them can send, which the backend reads as a removal — see the stepper's `min` at its site.
   */
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  /** The three writes the panel behind a tile's pencil reaches, passed straight through. They
   *  are the *only* controls an any-printing wish has — `EditWish.tsx` carries the reason. */
  onSetFolder: (row: WishRow, folderId: number | null) => void;
  onChangePrinting: (row: WishRow) => void;
  onAnyPrinting: (row: WishRow) => void;
  /**
   * What a tile offers on a right-click, or `undefined` for a wish that offers none. Per wish
   * rather than for the wall, and the same handler the table's rows are given: an any-printing
   * wish names no cardboard to ask a question about, so the menu is not offered — the answer must
   * not differ between two drawings of one list.
   */
  rowMenu?: (row: WishRow) => ((e: ReactMouseEvent) => void) | undefined;
  /** The same menu from the keyboard, on exactly the wishes its pointer twin is. */
  rowMenuKey?: (row: WishRow) => ((e: ReactKeyboardEvent) => void) | undefined;
  /** Which marketplace the cost mark quotes. Passed rather than read here so the wall and the
   *  header above it cannot disagree about what they are pricing in. */
  marketplace: Marketplace;
}) {
  // Opening a card is a store write and nothing else — `App` owns the pane, so the wall never
  // has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  // What the wall below is sized by — see its `baseTileWidth`. A consumer of the app's one
  // viewport branch rather than a second one; the hook argues for itself at its own site.
  const narrowWindow = useNarrowWindow();
  const tip = useTooltip();

  const tiles = useMemo(() => rows.map(toTile), [rows]);
  const asOf = pricesAsOf(marketplace);
  const currency = marketplace.currency;
  return (
    <CardGrid
      rows={tiles}
      label="Your wishlist"
      listKey={listKey}
      // **This wall grows and `main` scrolls it — the page is one long page.** The search page said
      // it first (`SearchPage`, 2026-09-03) and this is the same sentence one tab over: bounded, the
      // wall was whatever height the desk row had left over, so a wishlist of forty wishes was drawn
      // in a letterbox with a scrollbar of its own an inch from the page's, and nothing on screen
      // said which one a wheel was about to turn. The two surfaces that must keep a scroller of
      // their own are untouched — `CardGrid`'s `grow` carries why the deck editor's 206px docked
      // panel and `AllPrintingsDialog` are not this.
      //
      // **Passed here rather than at the page's call site**, because this component *is* the
      // wishlist's wall and has exactly one caller: there is no second site for the prop to
      // disagree with. `CollectionPage` renders `CardGrid` directly and passes it there, which is
      // the same rule read from the other end.
      grow
      // **A phone gets a narrower card, so the list is two columns rather than one.** The same
      // width the search and collection walls take and for the same arithmetic: 324px of wall at
      // 390, where 170 floors to one column. `PHONE_TILE_WIDTH` carries the derivation, the 160
      // that looks like a fix and is not, and the decision that the chin does not scale with it.
      baseTileWidth={narrowWindow ? PHONE_TILE_WIDTH : undefined}
      // This wall's own zoom, kept apart from the collection's and the search's: the three lists
      // are read one after the other, and a size settled on one is not an answer about another.
      zoomSection="wishlist"
      // Ctrl and Shift build a set of tiles (issue #214). A *pinned* wish drags as a card like
      // any other tile and carries the set with it; an any-printing wish carries only the wish
      // mark, so it contributes no card payload to a group — `CardGrid`'s `dragRest` reads that
      // back through `readDragData` rather than inventing one.
      selectionScope="wishlist"
      selectedId={selectedCardId}
      onSelect={selectCard}
      // The same arrow-key walk the other two page-walls take, on the same terms: `selectedId`
      // and `onSelect` are both the store field the card pane reads, so a press moves the pane
      // rather than only an outline.
      arrowNav
      onNeedNextPage={onNeedNextPage}
      caption={caption}
      finish={tileFinish}
      // **What one copy costs**, at the printing and the finish this wish is *for* — the same
      // statement the chin makes on every other wall in the app, which is the whole reason it is
      // one component: a reader who has learnt what the bar under a card says in their collection
      // has learnt what it says here.
      //
      // The wish's own `unitPrice`, which is quoted at the finish it names and falls down the
      // printing's `nonfoil → foil → etched` chain where it names none — so a foil-only printing
      // is priced rather than left blank, and "no preference" is not read as nonfoil.
      //
      // **On an any-printing wish this is the same printing the tile is a picture of**, which is
      // what makes the figure honest under a caption that refuses to name one: `WishRow`'s
      // `unit_price` and its `art_card_id` come off one join, at the *cheapest* printing of the
      // oracle card — the one a reader acting on the wish would actually buy.
      //
      // **Not the cost still to buy**, which stays in the corner above: that is `unit × copies
      // missing`, it is what the page header's own "Still to buy" sums and what the table's Cost
      // column shows, and folding it in here would leave a wish quoted at four times another's
      // price for being three copies further from finished.
      //
      // Spec §5: a price is never shown without saying how old it is. `pricesAsOf` is under this
      // wall already, said once — which is why this is a bare figure rather than a tooltip on
      // every one of forty tiles. The corner keeps its own, because arithmetic over a wish is not
      // a figure the sentence under the wall is about.
      money={(tile) => formatPrice(tile.wish.unitPrice, currency)}
      // **Two marks, stacked, each in a pill of its own** — which is why this wall is the one
      // caller that asks `CardGrid` for a bare corner.
      //
      // The folder rides on top and is drawn **only while the list is flattened**. Flatten's whole
      // promise is "every wish, wherever it is filed", so without it the switch would hand the
      // reader one undifferentiated list and take the filing away in the act of showing it all;
      // inside a folder the caption would be the same word under every tile and the breadcrumb
      // above already says it. It moved here from the chin's caption on 2026-09-08, where it sat
      // between a truncating set code and a price at 10px — a word the reader chose themselves,
      // in the smallest and busiest type on the card.
      //
      // Under it, how many copies they want. `WishFolderCaption` is `wishMarks`' shared component
      // and is drawn exactly as the table draws it, backing apart: it answers `null` for a folder
      // this page cannot name, which is why the pill is guarded here rather than wrapped around
      // whatever it returns — a bare chip with nothing in it is the one thing this corner cannot
      // collapse, `badgeChrome="bare"` having handed `empty:hidden` a wrapper that is never empty.
      //
      // The width cap is what keeps a long folder name out of the bottom-right corner opposite,
      // and it scales for the reason every other size on a card does — at 2× the two marks are
      // twice as wide and so is the gutter they have to leave each other.
      badgeChrome="bare"
      badge={(tile) => {
        const folder = flattened ? folderNameOf(tile.wish.folderId) : null;
        return (
          <span
            className={cn(
              "flex flex-col items-start gap-[calc(0.25rem*var(--mark-scale,1))]",
              "max-w-[calc(100%-2.75rem*var(--mark-scale,1))]",
            )}
          >
            {folder !== null && (
              <span className={cn(CORNER_PILL, "flex min-w-0 max-w-full")}>
                <WishFolderCaption name={folder} />
              </span>
            )}
            <WishWanted wish={tile.wish} />
          </span>
        );
      }}
      // The bottom-right corner carries two facts in one chip: what the reconciler found, and
      // what this wish costs.
      //
      // **It was the top-left until 2026-09-08**, below the printed title bar so a red sentence
      // would not land on the card's own name — the one thing a reader identifies a tile by on a
      // wall of forty. What moved it is that the corner it now occupies came free: the pencil left
      // the hover strip for the column up the right-hand edge, and a price reads better opposite
      // the count it is a multiple of than diagonally across the picture from it.
      //
      // **The flag is drawn because a wall may not say less than its table.** `needs_review` is a
      // sentence, and the rule it is written under is "listed, counted, and asking to be looked
      // at" — a layout that drew the wish and dropped the question would be the one place in the
      // app where a flagged row looks fine. The table has a band across the row for it; a 170px
      // card has this, with the reconciler's whole sentence as the tooltip on the short label.
      //
      // The *label* never truncates — "Needs review" is fixed and short — so `whenClipped` is
      // wrong here: it would never open. But the *sentence* is the same 130–190 characters as the
      // collection table's band, whose second half is what to do about it ("check the printing and
      // re-add it… or remove this entry") — so it is `interactive` for the same reason the band
      // is: the reader has to be able to select and copy the instruction, and that must not depend
      // on which surface is showing it. `describes` stays at its default (`true`): nothing else on
      // this tile carries the sentence as text, so `aria-describedby` is a genuine gain over the
      // old `title` rather than a double-up.
      //
      // **The cost is `unit × copies wanted`, and it is always drawn.** It was `unit × copies
      // still missing` and was not drawn at all on a wish the collection covered; both halves went
      // with the owned count. So there is no `null` arm here and `empty:hidden` never fires on
      // this corner — which is worth saying, because the guard it replaced was load-bearing: a
      // wrapper with two falsy children is still an element as far as that rule can tell, so the
      // old code had to return `null` by hand rather than let two conditions collapse it.
      //
      // An unpriced wish is an em dash rather than another marketplace's rate wearing this one's
      // currency sign. Spec §5: a price is never shown without saying how old it is, and a corner
      // mark has no room for the sentence — so it rides as the tooltip, describing the
      // already-visible figure.
      bottomRight={(tile) => {
        const review = tile.wish.needsReview;
        return (
          <span className="flex flex-col items-end leading-[calc(1rem*var(--mark-scale,1))]">
            {review && (
              <span
                {...tip(review, { interactive: true })}
                className="font-medium text-[calc(0.7rem*var(--mark-scale,1))] whitespace-nowrap text-destructive"
              >
                Needs review
              </span>
            )}
            <span
              {...tip(`${wishLabel(tile.wish)} — ${asOf}`)}
              className="font-mono text-[calc(0.75rem*var(--mark-scale,1))] tabular-nums text-text"
            >
              {formatPrice(
                tile.wish.unitPrice === null ? null : tile.wish.unitPrice * tile.wish.quantity,
                currency,
              )}
            </span>
          </span>
        );
      }}
      // **The tile's two controls, in one column up its right-hand edge** — the stepper, and
      // the pencil under it (issue #284 put the stepper on the tile, issue #348 moved it here,
      // and the pencil joined it on 2026-09-08).
      //
      // The stepper sat in the strip beside the pencil until issue #348, as a 20px row. The
      // report was that the wall's control matched neither the *style* nor the *location* of the
      // deck builder's, and it did not: the deck stack draws a 36px column up the card's
      // right-hand side and this drew a bar tucked into the bottom corner. It is the same control
      // on the same kind of object, so it is one recipe — {@link CardGrid}'s `column` slot is the
      // position and `size="card"` the size, both of them the deck stack's.
      //
      // **The pencil followed it, and the `action` strip is gone from this wall entirely.** It
      // stayed behind as a 20.4px `AnchoredPopup` trigger in the bottom-right of the picture,
      // which left the tile with two controls at two sizes in two places for the same card — and
      // the corner it was occupying is where the cost belongs, opposite the count it multiplies.
      // It is drawn at `EditWishButton`'s `size="card"`, which is this stepper's own box, glyph
      // and over-art tone read off `QuantityStepper` rather than retyped, so the column is three
      // 36px boxes and a fourth under them at every stop of the zoom ladder. The gutter is the
      // stepper's own inter-button gutter for the same reason: two controls in one column, one
      // rhythm.
      //
      // **`static` on the pencil is load-bearing and its reason has moved.** It used to be what
      // made the panel hang off the strip rather than off a 20px button; the strip is gone, so
      // what it now hangs off is this column's wrapper — which `CardGrid` widened to the tile's
      // full width for exactly this, because a 288px panel anchored `left-0` to a ~31px box at
      // `right-4px` opens ~253px off the right edge of the scroller. Nothing in here may set
      // `position` for the same reason.
      //
      // It carries no `REVEAL_ON_HOVER` of its own: the wrapper already reveals the whole column,
      // and a second opacity animation over the first is two transitions on one box.
      //
      // **It fits, and the arithmetic is exact rather than approximate.** At `size="card"` the
      // column is three 36px boxes and two 4px gutters, 116px at 100% zoom, and everything drawn
      // on a card is reduced by `CONTROL_SHRINK` (85%) — so it rests at **30.6px wide by
      // ~98.6px tall**. Against a 170px tile whose art box is 238px (5:7), that is **18% of the
      // width and 41% of the height**, starting 24px down; on the deck's own 210×293 card the
      // same column is 15% and 34%. Both hold at **every** stop of the zoom ladder rather than
      // at rest alone: the tile's width, the art's height and the column are each linear in the
      // same zoom, so those are constants and not readings taken at 1×. At `PHONE_TILE_WIDTH`'s
      // 141 it is 22% of the width — the first figure to check if this column is ever made
      // bigger.
      column={(tile) => (
        // `data-no-drag` needs a host. A wish tile is a drag source ({@link tileDrag}), the
        // sensor asks `closest(NOT_A_DRAG)` at the press (`dnd.ts`), and `NOT_A_DRAG` excludes
        // the stepper's `<input>` by tag but not its two `<button>`s — so unmarked, a press on
        // `−` plus five pixels of travel is a drag of the whole wish instead of a decrement.
        // `QuantityStepper` takes no `className` and no loose props, so the mark cannot go on
        // the control; `closest` means one on the wrapper covers both buttons.
        // `DeckCardControls` is the same wrapper around the same stepper for the same sentence
        // (`features/decks/cardControl.tsx`).
        //
        // **Nothing here sets `position`, and nothing here may** — see the pencil above: the
        // strip is what the 256px panel is anchored to, and a positioned box anywhere in that
        // chain becomes the containing block instead.
        <span
          data-no-drag=""
          className="flex flex-col items-center gap-[calc(0.25rem*var(--control-scale,1))]"
        >
          <QuantityStepper
            // The deck stack's column, verbatim — the 36px box, standing on end, over art.
            // `xs` and `card` are the two sizes drawn on a card face and both follow the
            // reader's zoom; this is the larger, and the arithmetic for it against a 170px tile
            // is on the slot above.
            size="card"
            orientation="vertical"
            // Drawn over an illustration, inside a frame that clips its own corners — the deck
            // tile's two answers, for the deck tile's two reasons: a 1px outline with nothing
            // behind it disappears over art of any brightness, and an outset focus ring on a
            // clipped box loses the half that lands outside.
            tone="art"
            focus="inset"
            value={tile.wish.quantity}
            // **Zero is the floor and zero removes the wish** — a real press, and the wall's
            // and the table's answer alike since issue #284.
            //
            // `wishlist.rs`'s `set_wish_quantity` has always returned `remove_wish` at zero,
            // because `wishlist_entries.quantity` carries `CHECK (quantity > 0)`: a wish for
            // none of something is not a wish, which is where this list differs from the
            // collection's, where a zeroed row keeps its condition and its purchase story. The
            // floor of `1` this had until then was a UI-only guard on the argument that a
            // stepper which deleted the row when held down is a one-way door. What overruled it
            // is that the collection's wall reaches zero and deletes there, so the same gesture
            // on two walls of one app meant two different things — and the guard was buying a
            // reader who had over-counted a copy an extra press rather than an undo, which is
            // not what the argument promised.
            //
            // **Removal keeps its named route**: `Remove from wishlist` in the pencil's panel is
            // the explicit press, it says the word, and it is the one a keyboard finds by
            // reading rather than by holding a button down.
            min={0}
            // The wish, not the card: two wishes for one card differ only by printing and
            // finish, so `wishLabel` is what stops a wall of forty being forty controls a screen
            // reader or a voice driver cannot tell apart. The same name the table's stepper and
            // the panel's carry, because it names the same wish.
            label={`Copies wanted of ${wishLabel(tile.wish)}`}
            onChange={(next) => onSetQuantity(tile.wish, next)}
          />
          <EditWishButton
            // Keyed by the wish, because the wall keys its tiles by *slot*: removing a wish
            // re-binds this slot to the next one, and an open panel carried across that would be
            // pointed at a card the reader never opened it on.
            key={tile.wish.id}
            row={tile.wish}
            folders={folders}
            nodes={nodes}
            onSetQuantity={onSetQuantity}
            onRemove={onRemove}
            onSetFolder={onSetFolder}
            onChangePrinting={onChangePrinting}
            onAnyPrinting={onAnyPrinting}
            size="card"
            className="static"
          />
        </span>
      )}
      cardMenu={rowMenu && ((tile) => rowMenu(tile.wish))}
      cardMenuKey={rowMenuKey && ((tile) => rowMenuKey(tile.wish))}
      // `dragRecord` rather than `dragPayload`, because a wish tile's drag is two marks in one
      // record and that slot carries one — see {@link tileDrag} and `CardGrid`'s own note.
      dragRecord={tileDrag}
    />
  );
}
