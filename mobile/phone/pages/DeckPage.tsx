import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { ipc } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { CardWall, type WallItem } from "../CardWall";
import { deckCardItem } from "../items";
import { linkTo } from "../router";
import { DimNote, ReadError } from "./parts";

/**
 * One deck, read-only: its actual list as a wall.
 *
 * Under `["decks"]` so every deck write the desktop face makes refreshes it. The editor — piles,
 * the plan, quantities — is phase 3's largest piece and none of it is here.
 */
export function DeckPage({
  deckId,
  onOpen,
}: {
  deckId: number;
  onOpen: (item: WallItem) => void;
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
  const name = deck.data?.deck.name;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
        {/* A link, like the tabs: it changes the URL. */}
        <a
          {...linkTo({ view: "decks", deckId: null, cardId: null })}
          aria-label="Back to decks"
          className={cn("flex size-11 items-center justify-center rounded-md text-dim", FOCUS)}
        >
          <ChevronLeft aria-hidden className="size-5" />
        </a>
        {/* Only once there is a name: an empty heading is a stop with nothing to hear at it. */}
        {name ? <h2 className="min-w-0 flex-1 truncate text-base">{name}</h2> : null}
      </div>
      {deck.isLoadingError ? (
        // The read failed, which says nothing about the deck. "Gone" is the sentence below, for a
        // read that succeeded and answered no deck.
        <ReadError>That deck could not be read.</ReadError>
      ) : deck.data === null ? (
        <DimNote>That deck is gone.</DimNote>
      ) : !deck.isPending && items.length === 0 ? (
        <DimNote>No cards in this deck yet.</DimNote>
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
