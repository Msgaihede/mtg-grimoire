import { useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { ManaText } from "@/components/ManaText";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { FINISH_LABEL, FINISHES } from "@/lib/finish";
import { ipc, type CardDetail, type CardFace } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { back, usePlace } from "./router";

/**
 * The faces a card's words are printed on.
 *
 * `card.faces` is **empty** for a one-faced card (Scryfall sends no `card_faces` for a `normal`
 * or a `meld` one), and for a card that has faces the printing's own `oracleText` is `null` and
 * every word is on them — so reading either place alone draws an empty card for part of the game.
 * A one-faced card is synthesised into a single face, with no name: the sheet's heading has
 * already said it.
 *
 * The desktop's `CardTextDialog` keeps the same function for the same reason. It is written again
 * rather than imported because that module reads the desktop's store.
 */
function facesOf(card: CardDetail): CardFace[] {
  if (card.faces.length > 0) return card.faces;
  return [
    {
      name: "",
      typeLine: card.typeLine,
      oracleText: card.oracleText,
      manaCost: card.manaCost,
      artist: card.artist,
    },
  ];
}

/**
 * One card, over whatever the reader was looking at.
 *
 * **It is a place** — `?card=<id>` — so opening it pushes a history entry and Back closes it,
 * which is the gesture a phone reader reaches for. `Dialog` is the desktop's own shell: below
 * 640px it fills the window by its own rule, and from there up to this face's 1023px it is a
 * centred panel at the width named below.
 *
 * **Closing it is that same Back, not a second push** — the ✕, Escape and the scrim all go
 * through `back`. A push here left the card one Back beneath the page it was closed over, so the
 * gesture that should leave the page reopened the card instead. `back` falls to a replace for a
 * reader who arrived on the card's own link and has no entry of the app's beneath them. The sheet
 * closes itself for that reason: only the router knows whether the entry beneath is the app's.
 *
 * Reading only, for the skeleton: the picture, the words, and what each finish costs.
 */
export function CardSheet({ cardId }: { cardId: string | null }) {
  const place = usePlace();
  const close = () => back({ ...place, cardId: null });
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
  const faces = card === null ? [] : facesOf(card);

  return (
    <Dialog
      open={cardId !== null}
      title={card?.name ?? "Card"}
      closeLabel="Close card"
      size="w-[28rem]"
      onDismiss={close}
      onClose={close}
    >
      <div className="min-h-0 flex-1 select-text overflow-y-auto p-4">
        {detail.isPending && cardId !== null && (
          <p className="text-sm text-dim">Reading the card…</p>
        )}
        {/* `isLoadingError`, not `isError`: a refetch that fails keeps the card it had, and that
            card is still what the reader is looking at. `null` is the other way to have nothing —
            an id the card database has no row for. */}
        {(detail.isLoadingError || detail.data === null) && (
          <p role="alert" className="text-sm text-destructive">
            That card could not be read.
          </p>
        )}
        {card !== null && (
          <div className="flex flex-col gap-3">
            <div className="mx-auto w-full max-w-64">
              <CardArt cardId={card.id} name={card.name} variant="display" loading="eager" />
            </div>
            {faces.map((face, i) => (
              <div key={i} className="flex flex-col gap-1">
                <p className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1">
                    {/* Named only where there is more than one face to tell apart. */}
                    {faces.length > 1 && face.name !== "" && (
                      <span className="mr-1.5 font-medium">{face.name}</span>
                    )}
                    <span>{face.typeLine}</span>
                  </span>
                  <ManaText source={face.manaCost} />
                </p>
                {face.oracleText !== null && face.oracleText !== "" && (
                  <p className="whitespace-pre-line text-sm">
                    {/* `inline`, not the component's `inline-flex`: rules text wraps, and a flex
                        run of it is one unbreakable line. Through `ManaText` so `{T}` is the
                        symbol and not three characters. */}
                    <ManaText source={face.oracleText} className="inline" />
                  </p>
                )}
              </div>
            ))}
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
