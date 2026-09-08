import { useEffect, useId, useRef, useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { filterChipState } from "@/components/FilterChips";
import { QuantityStepper } from "@/components/QuantityStepper";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { CONDITIONS, CONDITION_LABEL, MENU_CONDITION, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import type { FolderNode } from "@/lib/folderTree";
import { ipc, ipcError } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { formatPrice, parsePurchasePrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

/** The printing a quick-add is about. Every surface that shows a card can build one. */
export interface AddTarget {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  /** For an "any printing" wish. `null` mirrors the column's nullability; no live row is. */
  oracleId: string | null;
  /** The finishes this printing exists in. Empty means "unknown", and nonfoil is offered. */
  finishes: Finish[];
}

/**
 * How a surface full of cards carries this button: invisible until the row or tile it
 * belongs to is hovered or holds the caret — a wall of art is not a wall of plus signs —
 * and always in the tab order, because "visible on hover" is not a state a keyboard has.
 *
 * The caller's row or tile has to be a `group`. An open popup overrides the opacity from
 * inside the component, so walking the mouse off the row does not take the popup with it.
 */
export const REVEAL_ON_HOVER =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 " +
  "group-focus-within:opacity-100 motion-reduce:transition-none";

/**
 * Small, quiet, and the same three sizes wherever they appear in the popup.
 *
 * It carries {@link PRESS} rather than a copy of it, which is what "same recipe as every
 * other shared button constant in the app, verbatim" now means literally: a chip in here and
 * a chip anywhere else are pressed with the same weight because they are pressed with the
 * same string. These chips never grey, so they add no out-of-reach clause.
 */
const CHIP = cn("rounded-md border px-2 py-1 text-xs", PRESS);

const MODES = ["collection", "wishlist"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = { collection: "Collection", wishlist: "Wishlist" };

/**
 * The "+" that adds a card, and the popup behind it.
 *
 * One component for all three surfaces (printings row, art tile, table row) because the
 * decision being made is the same one every time: which finish, what condition, what it cost,
 * how many — and the direction's rule that a control means the same thing wherever it appears
 * is cheaper to keep than to restore.
 */
export function AddToCollectionButton({
  target,
  className,
  align = "end",
  folderId,
  folderNodes,
  folderName,
  lockMode,
}: {
  target: AddTarget;
  className?: string;
  /**
   * Which edge of the popup is pinned to its anchor. `"end"` everywhere the button sits at
   * the right of a wide row, so the popup opens back across it; `"start"` in the art grid,
   * where the anchor is the tile's caption (the caller makes this control `static`) and a
   * popup opening leftwards off the first column would be clipped by the scroller — left
   * overflow, unlike right, cannot be scrolled back into view.
   */
  align?: "start" | "end";
  /**
   * Where a press files — the folder the reader is standing in, handed down by the page.
   *
   * **Absent and `null` are two different things and both reach the wire as themselves.**
   * `null` is the root, a real destination a page with a cabinet on screen has *chosen*;
   * absent is a surface that has never thought about folders at all (the search page, the Tags
   * wall, the printings modal), and it sends no `folderId` field. That is `purchasePrice`'s
   * rule one field over, and it is what keeps those three call sites byte-identical on the
   * wire while this component grows a cabinet.
   *
   * It is a *default*, not a pin: the reader can send one card somewhere else through
   * {@link folderNodes} without leaving the drawer they are standing in.
   */
  folderId?: number | null;
  /**
   * The tree the override picker offers. Absent draws no picker — a wall with no cabinet
   * behind it would be offering a list of nowhere.
   *
   * It belongs to whichever list {@link lockMode} names, which is why the two are passed
   * together in practice: the collection's drawers are not the wishlist's, and a switch that
   * could still flip the destination list would leave the picker offering the wrong tree.
   */
  folderNodes?: readonly FolderNode[];
  /**
   * The page's own naming of a destination, for the trigger's accessible name and the Folder
   * row. `null` back means a folder this list no longer carries — one another surface deleted
   * between two reads — which reads as the root, exactly as `buildFolderTree` resolves a child
   * whose parent is missing.
   */
  folderName?: (id: number | null) => string | null;
  /**
   * Pins the destination list and hides the switch.
   *
   * A sidebar over the collection adds to the collection: a chip pair offering the wishlist
   * there would be a control that changes which page the results the reader is looking at
   * belong to — and it would offer the collection's folder tree for a wishlist add.
   */
  lockMode?: Mode;
}) {
  // Which list is being filled lives out here, above the panel that changes it, because it is
  // half of what this button's name says — a trigger reading "…to Collection" over an open
  // wishlist form is wrong about what pressing it again would do. It therefore also outlives a
  // close, which is the right answer for a reader working down a printings list adding wishes:
  // the destination is their last choice, not a default reasserted each time.
  const [picked, setPicked] = useState<Mode>("collection");
  const mode = lockMode ?? picked;

  /**
   * The reader's "send this one somewhere else", and it lives beside `mode` for `mode`'s own
   * reason: the trigger's name states the destination, so the thing that changes the
   * destination cannot live inside a panel that unmounts on every close.
   *
   * **It is thrown away the moment the page's default moves, and that is where it parts company
   * with `mode`.** `folderId` is *where the reader is standing* — a live fact about the page,
   * visible in the breadcrumb — so walking into another drawer is a statement about the
   * destination that outranks a choice made about a different one. Adjusted during render
   * rather than in an effect: an effect would draw one frame naming a folder the reader has
   * already left.
   */
  const [override, setOverride] = useState<number | null | undefined>(undefined);
  const [standingIn, setStandingIn] = useState(folderId);
  if (standingIn !== folderId) {
    setStandingIn(folderId);
    setOverride(undefined);
  }
  const folder = override === undefined ? folderId : override;

  // What a press would do, in words. At the root that is the *list's* own name — never "no
  // folder", which would describe the same drawer the breadcrumb calls Collection — and in a
  // drawer it is the drawer. `DeckSearchPanel`'s rule (`Add Ancient Tomb to Land`) applied.
  const listLabel = MODE_LABEL[mode];
  const destination =
    folder === undefined || folder === null ? listLabel : (folderName?.(folder) ?? listLabel);

  return (
    <AnchoredPopup
      // Named for the card and the printing, not for the control: forty of these in a printings
      // list are forty different cards, and "Add" is the same word on all of them. The
      // destination is the panel's current one, not always the collection.
      label={`Add ${target.name} (${target.setCode.toUpperCase()} ${target.collectorNumber}) to ${destination}`}
      panelLabel={`Add ${target.name}`}
      icon={<Plus className="size-[calc(0.875rem*var(--control-scale,1))]" aria-hidden="true" />}
      align={align}
      className={className}
      panelClassName="w-64 space-y-3"
    >
      <AddForm
        target={target}
        mode={mode}
        // Absent is the whole of how the switch is hidden: the chips are drawn where there is
        // something for them to change, and `setPicked` is unreachable from a locked popup
        // rather than merely unclicked.
        onModeChange={lockMode === undefined ? setPicked : undefined}
        folderId={folder}
        folderLabel={destination}
        folderNodes={folderNodes}
        onFolderChange={setOverride}
      />
    </AnchoredPopup>
  );
}

/** A success line, and which add it belongs to. See the `role="status"` region below. */
interface Report {
  text: string;
  seq: number;
}

/**
 * What is inside the panel: which list, which finish, what condition, what it cost, how many.
 *
 * Mounted and unmounted with the panel by {@link AnchoredPopup}, which is what resets every
 * answer below between two openings — `mode` is the exception and lives with the trigger,
 * because the trigger's own accessible name says it.
 *
 * **That mount is also what makes the price hint free.** The `card_detail` read below is issued
 * on the render the panel opens and never before, so a wall of forty of these costs forty
 * nothing until one is pressed — and the card the reader has already looked at is answered out
 * of the cache the modal filled, because the key is the modal's own.
 */
function AddForm({
  target,
  mode,
  onModeChange,
  folderId,
  folderLabel,
  folderNodes,
  onFolderChange,
}: {
  target: AddTarget;
  /** Owned by the trigger, whose accessible name says it. */
  mode: Mode;
  /** Absent where the caller pinned the list: the chip pair is not drawn at all. */
  onModeChange?: (next: Mode) => void;
  /** Owned by the trigger for the same reason `mode` is. `undefined` sends no field. */
  folderId?: number | null;
  /** The destination in words — the trigger's own sentence, so the two cannot disagree. */
  folderLabel: string;
  folderNodes?: readonly FolderNode[];
  onFolderChange: (next: number | null) => void;
}) {
  const id = useId();
  const finishes = target.finishes.length > 0 ? target.finishes : (["nonfoil"] as Finish[]);
  const [finish, setFinish] = useState<Finish>(finishes[0]);
  // {@link MENU_CONDITION}, imported rather than spelled, because it is the same decision the two
  // menu quick-adds make: **none**. The scale's top grade was this popup's opening value until
  // there was a way to record that nobody had looked — recording Near Mint for a reader who never
  // said so is the app claiming the best grade on the scale on their behalf.
  const [condition, setCondition] = useState<Condition>(MENU_CONDITION);
  // A draft rather than a number, and blank rather than the market price: **nothing is stored
  // that the reader did not type.** The current price rides as the box's `placeholder` below —
  // a hint they can read and retype, never a value this popup writes for them.
  const [priceDraft, setPriceDraft] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [anyPrinting, setAnyPrinting] = useState(false);
  const [done, setDone] = useState<Report | null>(null);
  // Which of the two panes is up. `EditWish`'s shape, for `EditWish`'s reason: the destination
  // list **replaces this body in place** rather than opening a second layer, because an
  // `AnchoredPopup` inside an `AnchoredPopup` is two Escape rungs and two focus boundaries for
  // one decision — and the ladder is ordered by *registration*, so the nested one would eat the
  // press the reader meant for the panel. One pane at a time, one rung, one press.
  const [pane, setPane] = useState<"main" | "move">("main");
  const folderRef = useRef<HTMLButtonElement>(null);
  /** True once the destination list has been up, so the effect below cannot fire on the first
   *  render — where the panel itself has only just taken the caret. */
  const wasMove = useRef(false);
  const queryClient = useQueryClient();
  // Whose prices the hint quotes, and whose currency a typed one is recorded in. Never a guess
  // and never a conversion — `purchase_price` is what was paid, in the money it was paid in.
  const { marketplace } = useMarketplace();

  /**
   * The printing, for its price alone.
   *
   * **The card modal's own query key**, imported rather than spelled out, so a card whose pane
   * the reader has already opened is answered from the cache instead of paying a second
   * `card_detail` round trip — see {@link cardDetailKey}, which is where the four spellings of
   * this key became one.
   *
   * `skipToken` rather than `enabled`, the shape its three siblings use, and here it says the
   * true thing about the wishlist: **a wish has no purchase price**, exactly as it has no
   * condition, so there is no query function at all until the reader is filling in the
   * collection's arm. Switching back issues it then, against a key that may well already be warm.
   */
  const detail = useQuery({
    queryKey: cardDetailKey(target.cardId, marketplace.id),
    queryFn:
      mode === "collection" ? () => ipc.cardDetail(target.cardId, marketplace.id) : skipToken,
  });

  /**
   * What this printing costs **at the finish that is currently pressed**, written the way the app
   * writes money everywhere else.
   *
   * The finish is half of the hint: a chip row switched to Foil over a nonfoil figure is a lie
   * about the row being written, since a price is looked up by finish and the two are routinely
   * pounds apart.
   *
   * `undefined` — not `formatPrice`'s em dash and never a `0` — while the read is in flight and
   * for a finish this marketplace does not price. An empty box is the honest state there: the
   * popup is asking what the reader paid, and it has nothing to suggest.
   */
  const quoted = detail.data?.finishPrices[finish] ?? null;
  const priceHint = quoted === null ? undefined : formatPrice(quoted, marketplace.currency);

  const add = useMutation({
    mutationFn: () => {
      const purchasePrice = parsePurchasePrice(priceDraft);
      // **Both fields' rule, one field over.** An absent `folderId` is a surface that has said
      // nothing about where this goes; `null` is a page with a cabinet on screen saying *the
      // root*. Spread rather than passed, so the first of those two is a payload with no such
      // key rather than one carrying an explicit `undefined`.
      const filed = folderId === undefined ? {} : { folderId };
      return mode === "collection"
        ? ipc.collectionAdd({
            cardId: target.cardId,
            finish,
            condition,
            quantity,
            ...filed,
            // **Both fields or neither.** A price with no currency is a number nobody can read
            // back, and an absent field is what leaves `collection_add`'s `coalesce` holding the
            // row's own price — which is the whole of how a blank box records nothing rather
            // than zero.
            ...(purchasePrice !== undefined && {
              purchasePrice,
              // The spelling already in the column. `Marketplace.currency` is lower-case because
              // it is a formatter's key; `purchase_currency` holds `USD` / `EUR` — the form the
              // golden corpus, the Rust fixtures and the sync wire all carry, and the one both
              // export writers put in a Purchase currency cell verbatim.
              purchaseCurrency: marketplace.currency.toUpperCase(),
            }),
          })
        : ipc.wishlistAdd(
            // A wish for "any printing" is keyed on the oracle card and carries its own
            // name, because a shopping list outlives the printing it was made from. The
            // `null` arm is unreachable — the control is disabled without an oracle id —
            // and is written as a pin rather than a cast so it stays that way.
            anyPrinting && target.oracleId !== null
              ? {
                  oracleId: target.oracleId,
                  name: target.name,
                  quantity,
                  preferredFinish: finish,
                  ...filed,
                }
              : { cardId: target.cardId, quantity, preferredFinish: finish, ...filed },
          );
    },
    onSuccess: () => {
      // The button said "Add", so the report says "Added" — one verb through the whole
      // action. Numbered because two identical copies is the commonest second add there
      // is, and the same sentence set twice is a live region that never changed.
      setDone((prev) => ({
        text: `Added ${quantity} × ${target.name} to your ${mode}.`,
        seq: (prev?.seq ?? 0) + 1,
      }));
      // The list this write belongs to, and its summary — **and only that list, in either
      // direction, which is a narrowing this popup carried the opposite of until now.**
      //
      // A collection add used to fire `["wishlist"]` as well, because every *wish* for the card
      // counted what the collection already held (`WishRow.ownedQuantity`, summed from
      // `collection_entries` and finish-aware), so a copy landing here moved a figure on rows
      // nobody had touched. The wishlist asks that question of nothing now: it is the reader's
      // own list, kept by hand, and no figure on a wish is derived from a collection row. So the
      // two destinations are symmetrical — a wishlist add leaves `["collection"]` alone and a
      // collection add leaves `["wishlist"]` alone, each because the other list cannot have moved.
      void queryClient.invalidateQueries({
        queryKey: [mode === "collection" ? "collection" : "wishlist"],
      });
      if (mode === "collection") {
        // And every deck, for the collection add only. **`collection_add` does take a folder**
        // — `EntryInput.folderId` has been on the wire since the cabinet landed, and this popup
        // names one whenever a page hands it one; what was only ever true is that *this call
        // site* passed none. It still cannot land a copy in a deck's group: the picker is
        // handed the `user` folders alone, deck groups and `Recently removed` being folder
        // kinds the cabinet draws but nothing may be filed into by hand, and since schema v25 a
        // live deck owns exactly what its own group holds. So what moves is the same thing it
        // always was — the theory list's spare column: `OWNED_SPARE_SQL` counts the copies that
        // are in no deck group, and a copy added here, root or drawer, is a copy some plan may
        // now read as spare. A *wish* is a copy the user does not have, and changes no deck's
        // arithmetic at all.
        void queryClient.invalidateQueries({ queryKey: ["decks"] });
      }
      // And the search results, which now *draw* what this write changed: `ownedQuantity`
      // and `wishlisted` are the badge on every row and every tile, so a wall the reader
      // added a third copy from would go on saying "×2" until they searched again.
      //
      // This used to carry `refetchType: "none"` for cost, and the cost is not small: an
      // infinite search holds every page the reader scrolled through — up to 100 of them,
      // ~53 ms each against the real database — and query-core refetches them in sequence,
      // so a deep scroll is a multi-second worst case behind an open popup. What bounds it
      // is that only *active* queries refetch: the search currently on screen, and this
      // popup is only ever open over one of them. A badge that is visibly wrong is worse
      // than background work nobody is waiting on.
      //
      // The upgrade is to stop asking rather than to ask more cheaply: patch
      // `ownedQuantity`/`wishlisted` into the cached search pages in place, the way
      // `WishlistPage`'s `patchWish` rewrites a wish, and refetch nothing at all.
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
  });

  /** **Deliberately not alphabetical — one of the exceptions `lib/options.ts` names,
   *  the kind whose order *is* the information.** `CONDITIONS` is a grade scale,
   *  best to worst, and the order every listing these cards were bought from prints
   *  it in. Sorted by label it would open on "Damaged" and read Damaged / Heavily
   *  played / Lightly played / Moderately played / Near mint, which is not a scale
   *  in either direction. Leave `sortOptions` out of here.
   *
   *  **"Not set" leads the list and is not part of the scale.** It is what this popup opens
   *  on, and a default belongs at the top of the list it is the default of; the five grades
   *  under it are in the order they always were. Wherever these are ordered *as grades* it
   *  sorts last instead — a collection sorted by condition puts the ungraded pile at the end
   *  — which is the same fact from the other side rather than a disagreement. */
  const conditionOptions: readonly DropdownOption[] = CONDITIONS.map((c) => ({
    value: c,
    label: CONDITION_LABEL[c],
  }));

  // A pane that closes hands the caret back to what opened it, which is the contract every
  // dismissible surface in this app keeps. An effect rather than part of the handler because
  // the trigger does not exist until the main pane has been committed back to the DOM.
  useEffect(() => {
    if (pane === "move") {
      wasMove.current = true;
      return;
    }
    if (!wasMove.current) return;
    wasMove.current = false;
    folderRef.current?.focus();
  }, [pane]);

  if (pane === "move" && folderNodes) {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setPane("main")}
          className={cn(CHIP, "flex w-full items-center gap-1.5", FOCUS, filterChipState(false))}
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back
        </button>
        <MoveToFolder
          label={`File ${target.name} in a folder`}
          nodes={folderNodes}
          currentId={folderId ?? null}
          // **`inline`, which is the whole of what makes this a swap rather than a second
          // layer** — asked for by name rather than un-styled from out here, so this file does
          // not come to depend on that component's internal DOM. It carries the role with the
          // box: inline the list is a `group`, which keeps the popup the one dialog in the tree.
          inline
          // The top level of *this* tree, in the list's own word. `MoveToFolder` defaults to the
          // deck gallery's, which is the surface it was written for; a reader filing a card they
          // have just bought must not be told they are moving it into the deck gallery.
          rootLabel={MODE_LABEL[mode]}
          // **Nothing is pending, because picking here writes nothing.** This list names where
          // the *next* press files; the write is the Add button's, one pane back. Greying the
          // destinations while an earlier add is still in flight would be this control claiming
          // a relationship to a request it has none to.
          pending={false}
          onPick={(next) => {
            onFolderChange(next);
            setPane("main");
          }}
          // **Deliberately nothing.** `onClose` means "focus left this layer on its own", and
          // the only layer here is the popup — which `AnchoredPopup` closes itself when focus
          // leaves its root. Wired to `setPane("main")` it would fire on the caret merely
          // reaching the Back button beside it, unmounting that button under the press about to
          // be made on it.
          onClose={() => {}}
        />
      </div>
    );
  }

  return (
    <>
      {onModeChange && (
        <div role="group" aria-label="Add to" className="flex gap-1">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                if (m === mode) return;
                onModeChange(m);
                // Both messages name a destination, and this is the control that changes it:
                // left alone, a failed add to the collection would re-read as a failed add to
                // the wishlist, which is a sentence about something that never happened.
                setDone(null);
                add.reset();
              }}
              className={cn(CHIP, "flex-1", FOCUS, filterChipState(mode === m))}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      {/* **The folder sits with the list, because the two are one question.** Which drawer a
          copy goes in is the second half of where it goes, not a fact about the copy — so it
          is drawn above the finish and the grade rather than among them, and the reader reads
          the destination in one place. Drawn at all only where a cabinet was handed down. */}
      {folderNodes && (
        <div className="space-y-1.5">
          <DestinationLine label="Folder" value={folderLabel} />
          <button
            ref={folderRef}
            type="button"
            onClick={() => setPane("move")}
            // Begins with the visible words, so the control is still addressable by voice
            // (WCAG 2.5.3), and names the card because forty of these popups can be one wall.
            aria-label={`Change folder for ${target.name}`}
            className={cn(CHIP, "w-full", FOCUS, filterChipState(false))}
          >
            Change folder…
          </button>
        </div>
      )}

      {/* The backend takes any finish for any card — this row is the guard, and it offers
          what the printing exists in and nothing else. */}
      <div role="group" aria-label="Finish" className="flex flex-wrap gap-1">
        {finishes.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={finish === f}
            onClick={() => setFinish(f)}
            className={cn(CHIP, FOCUS, filterChipState(finish === f))}
          >
            {FINISH_LABEL[f]}
          </button>
        ))}
      </div>

      {mode === "collection" ? (
        <>
          <div className="space-y-1">
            {/* **A control whose face carries the reader's answer needs its name written
                beside it, and both of the ones below are that shape.** A select shows its
                value; a text box shows what was typed into it, or nothing at all. The chip
                rows above are their own labels, which is why these two are the only ones in
                the popup spelled out. */}
            <label
              id={`${id}-condition-label`}
              htmlFor={`${id}-condition`}
              className="block text-xs text-dim"
            >
              Condition
            </label>
            <Dropdown
              id={`${id}-condition`}
              labelledBy={`${id}-condition-label`}
              value={condition}
              onChange={(v) => setCondition(v as Condition)}
              options={conditionOptions}
              fill
            />
          </div>

          <div className="space-y-1">
            {/* **`Purchase price`, the field registry's own name for this column**
                (`transfer/fields.ts`), so the popup, the CSV header and the export dialog's
                checkbox all say one thing. Not `Price`, which in an app that quotes a
                marketplace on every other surface would read as what the card is *worth*.

                **The currency is not in the name, and that is a trade rather than an
                oversight.** It is the marketplace's, never chosen here, and the hint beside the
                box carries its symbol in the ordinary case — so the one reader it leaves without
                a signal is one adding an unpriced printing. Spelling it out (`Purchase price
                (USD)`) is the fix if that ever bites; what it costs today is a second currency
                word on screen for a number that already has one. */}
            <label htmlFor={`${id}-price`} className="block text-xs text-dim">
              Purchase price
            </label>
            <input
              id={`${id}-price`}
              // **`text` with a decimal keypad, never `type="number"`.** A number input brings
              // spinners nobody wants on money, swallows a keystroke it dislikes without saying
              // so, and reads its value through the *browser's* locale rather than the app's —
              // three different behaviours over one field, none of them this popup's. The
              // parsing is {@link parsePurchasePrice}'s and is the same on every machine.
              type="text"
              inputMode="decimal"
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              // The hint, and it is only ever a hint: an empty box records nothing at all.
              placeholder={priceHint}
              // The Dropdown above it at `size="md"`, to the pixel — one row of two controls
              // that are the same height, the same corner and the same border, because they
              // are two answers to one question about one copy.
              className={cn(
                "h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-text",
                "tabular-nums placeholder:text-dim focus:border-accent focus:outline-none",
              )}
            />
          </div>
        </>
      ) : (
        <div role="group" aria-label="Which printing" className="flex gap-1">
          {[
            { any: false, label: "This printing" },
            { any: true, label: "Any printing" },
          ].map(({ any, label }) => (
            <button
              key={label}
              type="button"
              aria-pressed={anyPrinting === any}
              // A wish for "any printing" is keyed on the oracle card, so a card that
              // reaches this popup without an `oracleId` cannot make one.
              //
              // That is a fence around the nullable type, not around a kind of card. The
              // belief that reversible cards have no `oracle_id` is false: Scryfall omits
              // only the *top-level* one, and `card_row` falls back to `card_faces[0]`, so
              // 0 of 116,590 live rows (2026-08-05) are null and all 81 reversible
              // printings can be wished for by oracle. Disabled rather than hidden all the
              // same: a choice that silently disappears is one the reader has no reason to
              // believe exists.
              disabled={any && target.oracleId === null}
              onClick={() => setAnyPrinting(any)}
              className={cn(
                CHIP,
                "flex-1 disabled:opacity-40 disabled:hover:text-dim",
                FOCUS,
                filterChipState(anyPrinting === any),
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <QuantityStepper
            value={quantity}
            onChange={setQuantity}
            min={1}
            size="sm"
            label={`Quantity of ${target.name}`}
          />
          <button
            type="button"
            onClick={() => add.mutate()}
            disabled={add.isPending}
            // The visible word is the verb; the name says where it goes, and starts with
            // the visible word so the button is still addressable by voice (WCAG 2.5.3).
            aria-label={`Add to ${mode}`}
            className={cn(
              "h-7 rounded-md border border-accent px-3 text-xs text-accent",
              "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
              "disabled:opacity-50 motion-reduce:transition-none",
              FOCUS,
            )}
          >
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </div>

        {/* One live region, mounted with the popup and empty until there is something to
            say: a region that appears together with its text is a region a screen reader
            never saw change. Cleared on a failure so the last success is not read back as
            though it were this one.

            The sentence is keyed by the add it reports, so adding the same copy twice
            replaces the node rather than rewriting it with itself — React bails out of a
            re-render on an identical string, and a live region whose text did not change
            announces nothing. */}
        <p role="status" className="text-xs text-dim">
          {!add.isError && done && <span key={done.seq}>{done.text}</span>}
        </p>
        {add.isError && (
          // Stays open behind this, with every answer still in it: recording the same card
          // twice is one interaction, and so is trying again.
          <p role="alert" className="text-xs text-destructive">
            Could not add to your {mode} — {ipcError(add.error)}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * A destination's name and what it currently says — `EditWish`'s `SectionLine`, in the one other
 * panel that had to draw one.
 *
 * **Copied rather than shared, deliberately, and it is eight lines.** That component is private
 * to `EditWish.tsx`, and the alternative is a third module exporting a flex row: a shared
 * primitive earns its keep when there is a *decision* in it, and the only decision here is the
 * one both sites make the same way for the same reason — the name left, the fact right, so two
 * stacked rows read as a form the eye can run down, and the fact truncates rather than wrapping,
 * because a two-line value would move the controls under it and the popup's height would then
 * depend on how long the reader named a folder.
 */
function DestinationLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-none text-xs text-dim">{label}</span>
      <span className="min-w-0 truncate text-xs text-text">{value}</span>
    </div>
  );
}
