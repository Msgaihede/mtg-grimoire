import { useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { ManaText } from "@/components/ManaText";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { FINISH_LABEL, FINISHES } from "@/lib/finish";
import { ipc } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";

/**
 * One card, over whatever the reader was looking at.
 *
 * **It is a place** — `?card=<id>` — so opening it pushes a history entry and Back closes it,
 * which is the gesture a phone reader reaches for. `Dialog` is the desktop's own shell; below
 * 640px it is full-bleed by its own rule, which is this face's whole width.
 *
 * Reading only, for the skeleton: the picture, the words, and what each finish costs.
 */
export function CardSheet({ cardId, onClose }: { cardId: string | null; onClose: () => void }) {
  const { marketplace, currency } = useMarketplace();
  const detail = useQuery({
    // The desktop card modal's own entry: the two faces share one query client, and the card open
    // on one side of the 1024px floor is the card open on the other — so the face a resize draws
    // paints it from the cache rather than asking again.
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: () => ipc.cardDetail(cardId as string, marketplace.id),
    enabled: cardId !== null,
    // A refusal here is a card that is not there. Asking twice says so twice as late.
    retry: false,
  });
  const card = detail.data ?? null;

  return (
    <Dialog
      open={cardId !== null}
      title={card?.name ?? "Card"}
      closeLabel="Close card"
      size="w-[28rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 select-text overflow-y-auto p-4">
        {detail.isPending && cardId !== null && (
          <p className="text-sm text-dim">Reading the card…</p>
        )}
        {(detail.isError || (detail.isSuccess && card === null)) && (
          <p role="alert" className="text-sm text-destructive">
            That card could not be read.
          </p>
        )}
        {card !== null && (
          <div className="flex flex-col gap-3">
            <div className="mx-auto w-full max-w-64">
              <CardArt cardId={card.id} name={card.name} variant="display" loading="eager" />
            </div>
            <p className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">{card.typeLine}</span>
              <ManaText source={card.manaCost} />
            </p>
            {card.oracleText !== null && (
              <p className="whitespace-pre-line text-sm">{card.oracleText}</p>
            )}
            <p className="font-mono text-xs uppercase text-dim">
              {card.setCode} · {card.collectorNumber}
              {card.setName !== null && <span className="normal-case"> — {card.setName}</span>}
            </p>
            <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
              {FINISHES.map((finish) => (
                <div key={finish}>
                  <dt className="text-xs text-dim">{FINISH_LABEL[finish]}</dt>
                  <dd className="font-mono text-sm">
                    {formatPrice(card.finishPrices[finish], currency)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </Dialog>
  );
}
