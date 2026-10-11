import { Heart } from "lucide-react";
import { useWishlistAdd } from "@grimoire/ui/features/card/useCardAdds";
import { useWishEntryWrites } from "@grimoire/ui/features/wishlist/useWishEntryWrites";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { PRESS_SOFT } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { ReceiptBar } from "../deck/receipt";
import { useListReceipt } from "../lists/receipt";
import type { ActionContext } from "./Actions";
import { ADD_PRESS } from "./CollectionAdd";

/**
 * **Add to wishlist** — one wish, at the root, for **this printing** (the desktop card modal's add)
 * or for **any printing** of the card (the quick-add popup's other answer, keyed on the oracle card
 * and its name — absent for a printing that has lost its oracle card). Both through the menu's own
 * write (`useWishlistAdd`), with no preferred finish: the modal's add names none for a card it was
 * not opened on as a finish, and a wish for no particular finish is the wider wish.
 *
 * The receipt offers **`Undo`** as the collection add does — the desktop's stepper one wish back —
 * and says so in its name.
 */
export function WishlistAdd({ card }: ActionContext) {
  const add = useWishlistAdd();
  const { setQuantity } = useWishEntryWrites();
  const receipt = useListReceipt();
  const oracleId = card.oracleId;

  const wish = (any: boolean) =>
    receipt.track(
      add.mutateAsync(
        any && oracleId !== null
          ? { oracleId, name: card.name, quantity: 1, folderId: null }
          : { cardId: card.id, quantity: 1, folderId: null },
      ),
      () => `Added ${card.name}${any ? " (any printing)" : ""} to your wishlist.`,
      (change) => ({
        name: `take back the wish for ${card.name}`,
        run: () =>
          setQuantity.mutateAsync({ row: { id: change.id }, quantity: change.quantity - 1 }),
      }),
    );

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex">
        <button type="button" onClick={() => wish(false)} className={cn(ADD_PRESS, "flex-1")}>
          <Heart aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Add to wishlist</span>
        </button>
        {oracleId !== null && (
          <button
            type="button"
            aria-label="Add to wishlist, any printing"
            onClick={() => wish(true)}
            className={cn(
              "flex min-h-12 shrink-0 items-center border-l border-border px-4 text-sm text-accent",
              PRESS_SOFT,
              FOCUS,
            )}
          >
            Any printing
          </button>
        )}
      </div>
      <ReceiptBar receipt={receipt} />
    </div>
  );
}
