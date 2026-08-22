import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { QuantityStepper } from "@/components/QuantityStepper";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { FOCUS } from "@/lib/focus";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder, WishRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { printingOf, wishLabel } from "./wish";

/**
 * Everything a wish can be edited into — how many copies, which printing, and which folder.
 *
 * **It is the table's controls, in the room a tile has.** The wishlist's list view edits a
 * wish in place because a shopping list is where the number of copies is *maintained*: making
 * the reader open an editor to change a 3 to a 4 is the difference between a tool and a form.
 * The wall is now the view that opens by default, so the same writes have to be reachable
 * from it — and a 170px caption at 100% zoom has room for one 24px trigger and nothing else, so
 * they move into a panel behind it rather than being dropped.
 *
 * **This panel is the _only_ control an any-printing wish has, and that is why the printing and
 * the folder are edited in here rather than in the card menu.** `WishlistPage` withholds the
 * context menu from every wish whose `cardId` is `null` — deliberately, because such a wish is
 * for the *card* and there is no printing for a menu to name — and on a shopping list that is
 * routinely half the rows. A control that lived in the menu would be a control those rows do
 * not have, which is the one thing this panel exists to prevent.
 *
 * The panel is {@link AnchoredPopup}, the same shell the search wall's quick-add hangs off, at
 * `align="start"` for that shell's reason: a panel opening leftwards off the first column would
 * be clipped by the scroller, and left overflow cannot be scrolled back into view.
 *
 * **Give it a `key` of the wish's id at the call site.** The wall keys its tiles by *slot*, so
 * removing a wish re-binds this slot to the next one — and a panel left open across that would
 * be pointed at a card the reader never opened it on. A changed key remounts the control, which
 * closes it.
 */
export function EditWishButton({
  row,
  folders,
  nodes,
  onSetQuantity,
  onRemove,
  onSetFolder,
  onChangePrinting,
  onAnyPrinting,
  className,
}: {
  row: WishRow;
  /**
   * The flat folder rows, for one job: naming the folder this wish is filed in. The tree beside
   * it is what the destination list draws — two shapes of one read, both already in the page's
   * hand, rather than a flatten per render of every tile on the wall.
   */
  folders: readonly WishlistFolder[];
  nodes: readonly FolderNode<WishlistFolder>[];
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  onSetFolder: (row: WishRow, folderId: number | null) => void;
  /** Opens the All printings modal. The page owns it, because the modal is a `LAYER.overlay`
   *  surface and this popup is a `LAYER.popup` one inside a tile. */
  onChangePrinting: (row: WishRow) => void;
  onAnyPrinting: (row: WishRow) => void;
  className?: string;
}) {
  return (
    <AnchoredPopup
      // The wish, not the control: a wall of forty is forty different wishes, and "Edit" is the
      // same word on all of them. `wishLabel` is what makes two wishes for one card tell
      // themselves apart — they differ only by printing and finish.
      label={`Edit ${wishLabel(row)} on your wishlist`}
      panelLabel={`Edit ${row.name}`}
      icon={<Pencil className="size-[calc(0.875rem*var(--control-scale,1))]" aria-hidden="true" />}
      align="start"
      className={className}
      // Wider than the `w-56` this was while it held one stepper and one button: three sections
      // now, and the middle one draws two controls side by side.
      panelClassName="w-72 space-y-3"
    >
      {/* A component rather than the markup inlined here, and the reason is which pane is
          showing. `AnchoredPopup` mounts and unmounts its children with the panel, so state
          held *inside* them resets between two openings — state held out here in the button
          would not, and reopening the panel would drop the reader back into the destination
          list they left up last time. */}
      <EditWishPanel
        row={row}
        folders={folders}
        nodes={nodes}
        onSetQuantity={onSetQuantity}
        onRemove={onRemove}
        onSetFolder={onSetFolder}
        onChangePrinting={onChangePrinting}
        onAnyPrinting={onAnyPrinting}
      />
    </AnchoredPopup>
  );
}

/**
 * One control in the panel's stack — the shape the Remove button has had since it was the only
 * one, now that three more sit above it.
 *
 * Width and hover colour stay with the caller: the pair in the Printing section shares a row and
 * the other two are full width, and a destructive press must not light up the same colour as a
 * neutral one.
 *
 * **No glyph on the three new ones.** The Printing pair sits at about 129px each inside a 288px
 * panel, and an icon there costs the room the *second* word needs — and both labels are two
 * words that differ in the second. Remove keeps its `Trash2`, because a destructive control is
 * worth a mark the eye finds before it reads.
 */
const PANEL_BUTTON = cn(
  "flex h-7 items-center justify-center gap-1.5 rounded-md border border-border px-2",
  "text-xs text-dim transition-colors duration-150",
  FOCUS,
  "motion-reduce:transition-none",
);

/** The neutral hover — a lit border rather than a filled box, because the panel it sits on is
 *  already `bg-surface` and a surface-coloured hover on a surface is no hover at all. */
const NEUTRAL_HOVER = "hover:border-accent/60 hover:text-text";

/**
 * The panel's contents, and the one decision they make on their own: which of two panes is up.
 *
 * **`Move to folder…` swaps this body for the destination list _in place_ — it does not open a
 * second layer.** An `AnchoredPopup` inside an `AnchoredPopup` is two Escape rungs and two focus
 * boundaries for one decision, and the app's Escape ladder is ordered by *registration* rather
 * than by what is on top — so the nested layer would take the press the reader meant for the
 * panel and getting out of one edit would cost two. One pane at a time, one rung, one press.
 *
 * Two consequences of that follow, and both are written at their own sites below: `MoveToFolder`
 * is asked for its `inline` shape rather than the popup one, and its `onClose` — "focus left the
 * layer" — has nothing to close here, because the layer focus left is the panel and
 * `AnchoredPopup` already closes that itself.
 */
function EditWishPanel({
  row,
  folders,
  nodes,
  onSetQuantity,
  onRemove,
  onSetFolder,
  onChangePrinting,
  onAnyPrinting,
}: {
  row: WishRow;
  folders: readonly WishlistFolder[];
  nodes: readonly FolderNode<WishlistFolder>[];
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  onSetFolder: (row: WishRow, folderId: number | null) => void;
  onChangePrinting: (row: WishRow) => void;
  onAnyPrinting: (row: WishRow) => void;
}) {
  const [pane, setPane] = useState<"main" | "move">("main");
  const moveRef = useRef<HTMLButtonElement>(null);
  /** True once the destination list has been up, so the effect below cannot fire on the first
   *  render — where the panel itself has only just taken the caret. */
  const wasMove = useRef(false);
  const reasonId = useId();

  // A pane that closes hands the caret back to what opened it, which is the same contract every
  // dismissible layer in this app keeps. It is an effect and not part of the handler because the
  // trigger does not exist until the main pane has been committed back to the DOM.
  useEffect(() => {
    if (pane === "move") {
      wasMove.current = true;
      return;
    }
    if (!wasMove.current) return;
    wasMove.current = false;
    moveRef.current?.focus();
  }, [pane]);

  if (pane === "move") {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setPane("main")}
          className={cn(PANEL_BUTTON, "w-full justify-start", NEUTRAL_HOVER)}
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back
        </button>
        <MoveToFolder
          label={`Move ${wishLabel(row)} to a folder`}
          nodes={nodes}
          currentId={row.folderId}
          // **`inline`, which is the whole of what makes this a swap rather than a second
          // layer.** The popup shape — anchored, its own width, its own box, its own z-index —
          // is what the deck gallery needs and what would make this read as the nested layer
          // the panel deliberately is not. Asked for by name rather than un-styled from out
          // here: an override would make this file depend on that component's internal DOM,
          // and the day its root gains a wrapper the layer comes back with nothing going red.
          inline
          // The top level of *this* tree. `MoveToFolder` defaults to the deck gallery's word,
          // which is the surface it was written for; a reader filing a card they are buying
          // must not be told they are moving it into the deck gallery.
          rootLabel="Wishlist"
          // Nothing is forbidden: a wish has no descendants to be filed inside, which is the
          // whole of what `forbidden` is for.
          pending={false}
          onPick={(folderId) => {
            onSetFolder(row, folderId);
            setPane("main");
          }}
          // **Deliberately nothing.** `onClose` means "focus left this layer on its own", and
          // the only layer here is the panel — which `AnchoredPopup` closes itself when focus
          // leaves its root. Wired to `setPane("main")` instead, it would fire on the caret
          // merely reaching the Back button beside it, and unmount that button under the press
          // that was about to be made on it.
          onClose={() => {}}
        />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1">
        {/* The stepper labels itself for a screen reader (`label` below) and shows only a
            number, so the word has to be written beside it for everyone else. */}
        <span className="block text-xs text-dim">Copies wanted</span>
        <QuantityStepper
          value={row.quantity}
          onChange={(next) => onSetQuantity(row, next)}
          // `min={1}`, which is where a wish differs from a collection entry: there,
          // `set_quantity(0)` keeps the row with its condition and its purchase story; here it
          // *deletes* it, because a wish for none of something is not a wish. A stepper that
          // deleted the row when held down would be a one-way door with no undo, so removal is
          // the separate press below.
          min={1}
          size="sm"
          label={`Copies wanted of ${wishLabel(row)}`}
        />
      </div>

      <div className="space-y-1.5">
        <SectionLine label="Printing" value={printingOf(row)} />
        <div className="flex gap-1.5">
          <button
            type="button"
            // **`aria-disabled`, never the attribute** — a `disabled` button leaves the tab
            // order, and it would take the sentence saying why it is out of reach with it.
            aria-disabled={row.oracleId === null || undefined}
            aria-describedby={row.oracleId === null ? reasonId : undefined}
            onClick={() => {
              if (row.oracleId !== null) onChangePrinting(row);
            }}
            aria-label={`Change printing of ${wishLabel(row)}`}
            className={cn(
              PANEL_BUTTON,
              "min-w-0 flex-1",
              NEUTRAL_HOVER,
              "aria-disabled:opacity-40 aria-disabled:hover:border-border aria-disabled:hover:text-dim",
            )}
          >
            Change printing…
          </button>
          {/* **Absent rather than greyed on a wish that is already for any printing**, which is
              the opposite answer to the one beside it and the difference is worth the
              inconsistency: this offers the state the wish is already in, so there is nothing
              for a reason to say. `printingsItem` greys its refusals because the row is on every
              other card in the list and removing it from one would read as a bug — the same test
              run here says the button belongs on a pinned wish and belongs nowhere else. */}
          {row.cardId !== null && (
            <button
              type="button"
              onClick={() => onAnyPrinting(row)}
              aria-label={`Any printing of ${row.name}, instead of this one`}
              className={cn(PANEL_BUTTON, "min-w-0 flex-1", NEUTRAL_HOVER)}
            >
              Any printing
            </button>
          )}
        </div>
        {row.oracleId === null && (
          // `printingsItem`'s refusal in this panel's words: there is no oracle card left to ask
          // for a list of printings of. Said once under the pair rather than as a hint on the
          // control, because a reason a reader has to hover for is a reason half of them never
          // read — `MoveToFolder`'s `forbiddenReason` makes the same call about its own list.
          <p id={reasonId} className="text-[0.7rem] leading-relaxed text-dim">
            No other printings to list — this one has left the card database.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        {/* A `folderId` naming a folder this list does not carry — one another surface deleted
            between the two reads — reads as the root. That is `buildFolderTree`'s own rule for a
            child whose parent is missing, and it is where `ON DELETE SET NULL` is about to put
            the wish anyway. */}
        <SectionLine
          label="Folder"
          value={folders.find((folder) => folder.id === row.folderId)?.name ?? "Wishlist"}
        />
        <button
          ref={moveRef}
          type="button"
          onClick={() => setPane("move")}
          aria-label={`Move to folder: ${wishLabel(row)}`}
          className={cn(PANEL_BUTTON, "w-full", NEUTRAL_HOVER)}
        >
          Move to folder…
        </button>
      </div>

      <button
        type="button"
        onClick={() => onRemove(row)}
        // The name says which wish, for the reason the trigger's does — and it begins with the
        // visible words, so the button is still addressable by voice (WCAG 2.5.3).
        aria-label={`Remove ${wishLabel(row)} from your wishlist`}
        className={cn(PANEL_BUTTON, "w-full hover:border-destructive/60 hover:text-destructive")}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        Remove from wishlist
      </button>
    </>
  );
}

/**
 * A section's name and what it currently says.
 *
 * The name left, the fact right: three stacked sections read as a form only if the answers line
 * up in a column the eye can run down. The fact truncates rather than wrapping, because a
 * two-line value would move the buttons under it and the panel's height would then depend on how
 * long the reader named a folder.
 */
function SectionLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-none text-xs text-dim">{label}</span>
      <span className="min-w-0 truncate text-xs text-text">{value}</span>
    </div>
  );
}
