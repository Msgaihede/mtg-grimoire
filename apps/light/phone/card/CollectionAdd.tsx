import { useState } from "react";
import { Plus } from "lucide-react";
import { useCollectionAdd } from "@grimoire/ui/features/card/useCardAdds";
import { useCollectionEntryWrites } from "@grimoire/ui/features/collection/useCollectionEntryWrites";
import { FINISH_LABEL, parseFinishes, type Finish } from "@grimoire/ui/lib/finish";
import { FOCUS, FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { PRESS_SOFT } from "@grimoire/ui/lib/motion";
import { radioKeys } from "@grimoire/ui/lib/radioGroup";
import { cn } from "@grimoire/ui/lib/utils";
import { ReceiptBar } from "../deck/receipt";
import { useListReceipt } from "../lists/receipt";
import type { ActionContext } from "./Actions";

/** The press line every add on the card sheet is drawn as — `AddToDeck`'s. */
export const ADD_PRESS = cn(
  "flex min-h-12 w-full items-center gap-2 px-4 text-left text-sm font-medium text-accent",
  PRESS_SOFT,
  FOCUS,
);

/**
 * **Add to collection** — one copy of the printing on screen, into **the root**: the desktop card
 * modal's own add and its own destination, through the menu's own write (`useCollectionAdd` —
 * `MENU_CONDITION`, so no grade is claimed for the reader).
 *
 * **The finish is the one thing asked, and only where the printing leaves a choice.** The modal
 * records `soleFinish ?? nonfoil` without asking, and the menu records the printing's first finish
 * (issue #504: a reader who right-clicked the card they meant should not be asked again); a phone
 * sheet has the room the quick-add popup has, so a printing sold more than one way draws the
 * popup's finish chips under the press, opening on that same first finish — so a press without a
 * look is the desktop's add exactly.
 *
 * Under it, the receipt: what was added and **`Undo`, which is the desktop's stepper one copy back**
 * (`set_quantity` to the count before the add — a row the add made is deleted). The desktop offers
 * no undo for an add; this is the nearest write it does make, and the line names what it takes back.
 */
export function CollectionAdd({ card }: ActionContext) {
  const offered = parseFinishes(card.finishes);
  const finishes: Finish[] = offered.length > 0 ? offered : ["nonfoil"];
  return (
    <CollectionAddBox
      // A different printing is a fresh choice, opening on that printing's own first finish.
      key={card.id}
      cardId={card.id}
      name={card.name}
      finishes={finishes}
    />
  );
}

function CollectionAddBox({
  cardId,
  name,
  finishes,
}: {
  cardId: string;
  name: string;
  finishes: readonly Finish[];
}) {
  const [finish, setFinish] = useState<Finish>(finishes[0]);
  const add = useCollectionAdd();
  const { setQuantity } = useCollectionEntryWrites();
  const receipt = useListReceipt();
  const several = finishes.length > 1;
  const said = several ? ` (${FINISH_LABEL[finish].toLowerCase()})` : "";

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() =>
          receipt.track(
            add.mutateAsync({ cardId, finish, folderId: null }),
            () => `Added 1 × ${name}${said} to your collection.`,
            (change) => ({
              name: `take back the copy of ${name}`,
              run: () =>
                setQuantity.mutateAsync({ row: { id: change.id }, quantity: change.quantity - 1 }),
            }),
          )
        }
        className={ADD_PRESS}
      >
        <Plus aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Add to collection</span>
      </button>
      {several && (
        <div
          role="radiogroup"
          aria-label="Finish to add"
          className="flex gap-2 border-t border-border px-4 py-2"
        >
          {finishes.map((one, index) => (
            <button
              key={one}
              type="button"
              role="radio"
              aria-checked={one === finish}
              {...radioKeys(finishes, finish, setFinish, index)}
              onClick={() => setFinish(one)}
              className={cn(
                "h-11 min-w-0 flex-1 rounded-md border px-2 text-sm",
                one === finish
                  ? "border-accent text-accent"
                  : "border-border text-dim active:bg-surface",
                FOCUS_INSET,
              )}
            >
              {FINISH_LABEL[one]}
            </button>
          ))}
        </div>
      )}
      <ReceiptBar receipt={receipt} />
    </div>
  );
}
