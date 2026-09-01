import { useMemo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
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
import { missingOf, printingOf, wishLabel } from "./wish";
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
 * The caption: which printing the wish is for, in the words its table uses — plus the two marks
 * spec §4 puts beside it.
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
 * **The two marks share this line rather than taking a corner or a second row**, and both halves
 * of that are forced. Every corner of a tile already has an owner — bottom-left the progress
 * fraction, top-left the review flag and the cost, top-right `FoilOverlay`'s chip — and the strip
 * is a **budget**: `CardGrid` positions its virtual rows from `CAPTION_HEIGHT`, so a second line
 * here is a wall whose rows overlap by the difference. So the printing truncates and the marks
 * are `shrink-0` beside it, which is the honest trade at 170px: a folder the reader named and a
 * duplicate warning are worth more than the last few characters of a set code.
 *
 * A closure over the page's two answers, so it is not module scope like the drag beside it —
 * which costs nothing, because `caption` is read on **render** rather than registered
 * (see `CardGrid`, where only `dragRecord`/`tileRef` and the three card-fact slots ask to be held
 * still).
 */
const captionFor =
  (folderNameOf: (folderId: number | null) => string | null, flattened: boolean) =>
  (tile: WishTile) => (
    <span className="flex min-w-0 items-center gap-[calc(0.375rem*var(--mark-scale,1))]">
      <span className="min-w-0 truncate">{wallPrinting(tile.wish)}</span>
      <ElsewhereMark count={tile.wish.elsewhere} />
      {flattened && <WishFolderCaption name={folderNameOf(tile.wish.folderId)} />}
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
 * How much of this wish the collection already covers, over the art.
 *
 * `2/4` rather than the table's "2 of 4 owned": a corner mark on a 170px card is two glyphs of
 * shorthand, and the sentence is in the accessible name where the table's column header would
 * have been. The mono face and `--mark-scale` are `OwnedBadge`'s, so the two walls' bottom-left
 * corners are the same object at every zoom even though they count different things.
 *
 * **A fulfilled wish recedes here**, which is the wall's version of the dimmed row its table
 * draws: nothing is left to buy, so the figure goes quiet and the cost mark opposite it stops
 * being drawn at all. Nothing is hidden — a covered wish is still on the list until the reader
 * crosses it off.
 */
function WishProgress({ wish }: { wish: WishRow }) {
  const tip = useTooltip();
  const done = missingOf(wish) === 0;
  const sentence = done
    ? `Fulfilled, ${wish.ownedQuantity} of ${wish.quantity} owned`
    : `${wish.ownedQuantity} of ${wish.quantity} owned`;
  return (
    <span
      // Redundant, not a description: the `sr-only` span below already carries this sentence
      // as text in the accessible tree, so a screen reader that reaches this element has it
      // already — `describes: false` keeps the panel a pointer/sighted-only hint and stops it
      // wiring `aria-describedby` onto text that would then be read twice.
      {...tip(sentence, { describes: false })}
      className={[
        "inline-flex shrink-0 items-center font-mono tabular-nums",
        "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
        done ? "text-dim" : "text-text",
      ].join(" ")}
    >
      <span aria-hidden="true">
        {wish.ownedQuantity}/{wish.quantity}
      </span>
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
  // Built fresh on every render, deliberately: `caption` is one of the slots `CardGrid` *reads*
  // rather than registers, so nothing is torn down when its identity changes — and memoising it
  // against a `folderNameOf` the page will hand over as an inline arrow would promise a stability
  // that does not exist.
  const caption = captionFor(folderNameOf, flattened);

  return (
    <CardGrid
      rows={tiles}
      label="Your wishlist"
      listKey={listKey}
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
      badge={(tile) => <WishProgress wish={tile.wish} />}
      // **Below the printed title bar, not on it.** The search wall leaves its corner at 4px *on
      // purpose* — there the mark is a printings count and the nameplate is the quietest place on
      // the card to put one. Here the mark is a red sentence and a price, and the same 4px lands
      // on the card's own **name**, which is the one thing a reader identifies a tile by on a wall
      // of forty. The two walls want two answers and both are right, which is what the prop is
      // for; `CardGrid` carries the measurement behind the offset.
      topLeftPlacement="clear"
      // The top-left corner carries two facts, in one chip because a tile has four corners and
      // this is the only one free: what the reconciler found, and what the wish still costs.
      //
      // **The flag is here because a wall may not say less than its table.** `needs_review` is a
      // sentence, and the rule it is written under is "listed, counted, and asking to be looked
      // at" — a layout that drew the wish and dropped the question would be the one place in the
      // app where a flagged row looks fine. The table has a band across the row for it; a 170px
      // card has this, with the reconciler's whole sentence as the tooltip on the short label
      // below.
      //
      // The *label* below never truncates — "Needs review" is fixed and short — so `whenClipped`
      // is wrong here: it would never open. But the *sentence* is the same 130–190 characters as
      // the collection table's band, whose second half is what to do about it ("check the
      // printing and re-add it… or remove this entry") — so it is `interactive` for the same
      // reason the band is: the reader has to be able to select and copy the instruction, and
      // that must not depend on which surface is showing it. `describes` stays at its default
      // (`true`): unlike `WishProgress` above, nothing else on this tile carries the sentence as
      // text, so `aria-describedby` is a genuine gain over the old `title` rather than a double-up.
      //
      // The cost is over the copies still *missing* — the same arithmetic the header's "Still to
      // buy" is summed from and the same the table's Cost column shows, so one definition means
      // a tile and the figure above it cannot disagree on screen. An unpriced wish is an em dash
      // rather than another marketplace's rate wearing this one's currency sign, and a fulfilled
      // wish draws no figure at all: there is nothing left to buy. Neither fact draws an empty
      // chip — `CardGrid` collapses the corner when the mark comes back with nothing in it.
      topLeft={(tile) => {
        const missing = missingOf(tile.wish);
        const review = tile.wish.needsReview;
        // `null` rather than an empty box: `CardGrid`'s `empty:hidden` collapses a corner whose
        // mark rendered *nothing*, and a wrapper with two falsy children is still an element as
        // far as that rule can tell — so a fulfilled, unflagged wish would wear a bare chip.
        if (review === null && missing === 0) return null;
        return (
          <span className="flex flex-col items-start leading-[calc(1rem*var(--mark-scale,1))]">
            {review && (
              <span
                {...tip(review, { interactive: true })}
                className="font-medium text-[calc(0.7rem*var(--mark-scale,1))] text-destructive"
              >
                Needs review
              </span>
            )}
            {missing > 0 && (
              // Spec §5: a price is never shown without saying how old it is, and a corner mark
              // has no room for the sentence — so it rides as the tooltip, describing the
              // already-visible figure.
              <span
                {...tip(`${wishLabel(tile.wish)} — ${asOf}`)}
                className="font-mono text-[calc(0.75rem*var(--mark-scale,1))] tabular-nums text-text"
              >
                {formatPrice(
                  tile.wish.unitPrice === null ? null : tile.wish.unitPrice * missing,
                  currency,
                )}
              </span>
            )}
          </span>
        );
      }}
      // **How many copies, changed on the tile — and the pencil beside it** (issue #284).
      //
      // The wall drew the pencil alone until now, so changing a 3 into a 4 cost a press to open
      // a panel, a press on `+` and a press to close it, while the table did it in one. That is
      // the one difference between two drawings of one list this file's own rule forbids: a
      // reader who has learned the table has learned the wall, and "the quantity is maintained
      // here" is the first thing a shopping list teaches. The panel keeps every write it had —
      // it is still the only route to the printing and the folder, and the only route of any
      // kind on an any-printing wish — and loses nothing by the number moving out in front of it.
      //
      // **It fits, and the arithmetic is exact rather than approximate.** At `size="xs"` the
      // stepper is two 20px buttons either side of a 32px field with its own 4px gutter between
      // each, 80px at 100% zoom, and everything drawn on a card is reduced by `CONTROL_SHRINK`
      // (85%) — so it rests at **~68px**. `AnchoredPopup`'s trigger is 24px under the same
      // shrink, **~20.4px**. With the gutter that is **~92px** against the **162px** a 170px
      // tile leaves once the strip's own 8px of padding is off, and ~92 against **133px** at
      // `PHONE_TILE_WIDTH`'s 141 — 57% and 69% of the room. Both hold at **every** stop of the
      // zoom ladder rather than only at rest: the tile's width, the strip's `--mark-scale`
      // padding and the row's `--control-scale` controls are each linear in the same zoom, so
      // the two percentages are constants and not readings taken at 1×.
      action={(tile) => (
        // **One element around the pair, and the two things it carries are what make it one.**
        //
        // `data-no-drag` needs a host. A wish tile is a drag source ({@link tileDrag}), the
        // sensor asks `closest(NOT_A_DRAG)` at the press (`dnd.ts`), and `NOT_A_DRAG` excludes
        // the stepper's `<input>` by tag but not its two `<button>`s — so unmarked, a press on
        // `−` plus five pixels of travel is a drag of the whole wish instead of a decrement.
        // `QuantityStepper` takes no `className` and no loose props, so the mark cannot go on
        // the control; `closest` means one on the wrapper covers both buttons. `AnchoredPopup`
        // marks itself for the same reason, which is `dnd.ts`'s rule read the other way round —
        // anything that owns its own press says so. `DeckCardControls` is the same wrapper
        // around the same stepper for the same sentence (`features/decks/cardControl.tsx`).
        //
        // And the gutter needs a box: `CardGrid`'s strip is a `flex justify-end` with no `gap`
        // of its own, so two children handed to it directly would touch.
        //
        // **What is _not_ a reason: pointer events.** A React fragment renders no node, so its
        // children would be the strip's own direct children and the strip's
        // `[&>*]:pointer-events-auto` would reach both of them exactly as it reaches this
        // wrapper. Worth writing down because the strip's `pointer-events-none` is there for a
        // real and nearby failure — it is what stops the bottom ~28px of every card swallowing
        // the press that opens it — and it is easy to reach for as the argument here, where it
        // is not one.
        //
        // **Static, and that is load-bearing.** The strip is the positioned box the 256px panel
        // hangs off, which is why the pencil is passed `static` below; a wrapper with a position
        // of its own would silently become that containing block instead, and a panel anchored
        // to a 92px box at the right end of a 170px tile opens off the left of the scroller —
        // where left overflow, unlike right, cannot be scrolled back into view. Nothing here
        // sets `position`, and nothing here may.
        <span
          data-no-drag=""
          // The same 4px gutter the stepper uses between its own three controls, on the same
          // variable — so the row reads as one control rather than as two things that happen to
          // be adjacent, at every stop of the ladder. `--mark-scale` would have been the strip's
          // padding's variable and is the wrong one: this is a gap between *controls*, and a
          // control on a card is drawn at `CONTROL_SHRINK`.
          className="flex items-center gap-[calc(0.25rem*var(--control-scale,1))]"
        >
          <QuantityStepper
            // The 20px box, and the one that follows the reader's zoom — `xs` and `card` are the
            // two sizes drawn on a card face. `card` is the deck stack's column standing in a
            // 210px card's margin; this strip has 170px of tile and a pencil to sit beside.
            size="xs"
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
            // floor of `1` this had until now was a UI-only guard on the argument that a
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
            // The search wall's recipe verbatim: invisible until the tile is hovered or holds
            // the caret — a wall of art is not a wall of pencils — and always in the tab order,
            // because "visible on hover" is not a state a keyboard has. `static` is what makes
            // the panel hang off `CardGrid`'s strip instead of off this 20px control, and the
            // wrapper above stays out of that chain for the same reason.
            className={cn(REVEAL_ON_HOVER, "static")}
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
