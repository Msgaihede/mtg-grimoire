import { Pencil, Trash2 } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { QuantityStepper } from "@/components/QuantityStepper";
import { FOCUS } from "@/lib/focus";
import type { WishRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { wishLabel } from "./wish";

/**
 * The one control a wish's tile carries — how many copies are wanted, and getting rid of it.
 *
 * **It is the table's two controls, in the room a tile has.** The wishlist's list view edits a
 * wish in place because a shopping list is where the number of copies is *maintained*: making
 * the reader open an editor to change a 3 to a 4 is the difference between a tool and a form.
 * The wall is now the view that opens by default, so the same two writes have to be reachable
 * from it — and a 170px caption at 100% zoom has room for one 24px trigger and nothing else, so
 * they move into a panel behind it rather than being dropped.
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
  onSetQuantity,
  onRemove,
  className,
}: {
  row: WishRow;
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
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
      panelClassName="w-56 space-y-3"
    >
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

      <button
        type="button"
        onClick={() => onRemove(row)}
        // The name says which wish, for the reason the trigger's does — and it begins with the
        // visible words, so the button is still addressable by voice (WCAG 2.5.3).
        aria-label={`Remove ${wishLabel(row)} from your wishlist`}
        className={cn(
          "flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border",
          "text-xs text-dim transition-colors duration-150",
          "hover:border-destructive/60 hover:text-destructive",
          FOCUS,
          "motion-reduce:transition-none",
        )}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        Remove from wishlist
      </button>
    </AnchoredPopup>
  );
}
