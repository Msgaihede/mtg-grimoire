import { Plus } from "lucide-react";
import { useDeckCore } from "@/features/decks/useDeckCore";
import { useDecks } from "@/features/decks/useDecks";
import { count } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { PRESS_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { shownList } from "../deck/list";
import { ReceiptBar, useReceipt } from "../deck/receipt";
import type { ActionContext } from "./Actions";

/**
 * **Add to <deck>** — one copy of the printing on screen, into the list the deck page beneath is
 * showing. Offered only when the sheet is open over a deck (`place.deckId`), which is the one place
 * a phone reader is unambiguously adding *to* something.
 *
 * The write is `useDeck`'s `addCard` with `deckDefault` — the desktop card modal's own add from
 * outside the editor (issue #693): the pile Deck settings names for new cards, else the pile the
 * card's Oracle tags file it under. **One copy per press**, every Add's rule. The list is the page's
 * (`shownList`, the one rule both read), so a reader looking at the plan adds to the plan.
 *
 * Under the press, the write's receipt — the history's own sentence, how many the list now holds,
 * and `Undo`, which is the deck's own undo.
 */
export function AddToDeck({ card, place, deckPicked }: ActionContext) {
  const deckId = place.deckId as number;
  const { decks } = useDecks();
  const row = decks.find((d) => d.id === deckId) ?? null;
  const list = shownList(row, deckPicked) ?? "live";
  const deck = useDeckCore(deckId, list);
  const receipt = useReceipt(deckId);
  const name = row?.name ?? deck.deck?.name ?? "deck";
  const theory = row?.theoryEnabled === true;
  const held = deck.cards.reduce((sum, c) => (c.cardId === card.id ? sum + c.quantity : sum), 0);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() =>
          receipt.track(
            deck.addCard.mutateAsync({
              cardId: card.id,
              deckDefault: true,
              typeLine: card.typeLine,
              quantity: 1,
            }),
            () => `Added 1 \u00d7 ${card.name}.`,
          )
        }
        className={cn(
          "flex min-h-12 w-full items-center gap-2 px-4 text-left text-sm font-medium text-accent",
          PRESS_SOFT,
          FOCUS,
        )}
      >
        <Plus aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {`Add to ${name}${theory ? ` · ${list === "theory" ? "Theory" : "Actual"}` : ""}`}
        </span>
        {held > 0 && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-dim">
            {`${count(held)} in list`}
          </span>
        )}
      </button>
      <ReceiptBar receipt={receipt} />
    </div>
  );
}
