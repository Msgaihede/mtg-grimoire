import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { ipc } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { CardWall, type WallItem } from "../CardWall";
import { deckCardItem } from "../items";

/**
 * One deck, read-only: its actual list as a wall.
 *
 * Under `["decks"]` so every deck write the desktop face makes refreshes it. The editor — piles,
 * the plan, quantities — is phase 3's largest piece and none of it is here.
 */
export function DeckPage({
  deckId,
  onOpen,
  onBack,
}: {
  deckId: number;
  onOpen: (item: WallItem) => void;
  onBack: () => void;
}) {
  const { marketplace, currency } = useMarketplace();
  const deck = useQuery({
    queryKey: ["decks", "phone", deckId, marketplace.id],
    queryFn: () => ipc.deckGet(deckId, "live", marketplace.id),
  });
  const items = useMemo(
    () => (deck.data?.cards ?? []).map((card) => deckCardItem(card, currency)),
    [deck.data, currency],
  );
  const gone = deck.isError || (deck.isSuccess && deck.data === null);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
        <button
          type="button"
          aria-label="Back to decks"
          onClick={onBack}
          className={cn("flex size-11 items-center justify-center rounded-md text-dim", FOCUS)}
        >
          <ChevronLeft aria-hidden className="size-5" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base">{deck.data?.deck.name ?? ""}</h2>
      </div>
      {gone ? (
        <p className="p-4 text-sm text-dim">That deck is gone.</p>
      ) : !deck.isPending && items.length === 0 ? (
        <p className="p-4 text-sm text-dim">No cards in this deck yet.</p>
      ) : (
        <CardWall
          label="Cards in this deck"
          items={items}
          onOpen={onOpen}
          resetKey={String(deckId)}
        />
      )}
    </>
  );
}
