import { useEffect, useRef } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { FinishMark } from "@/components/FinishMark";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { cardHoldingsKey, cardPrintingsKey } from "@/features/card/cardKeys";
import { facesOf } from "@/features/card/faces";
import { FINISH_LABEL, parseFinishes } from "@/lib/finish";
import { ipc, ipcError, type CardDetail, type Printing } from "@/lib/ipc";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { finishTreatments } from "@/lib/treatment";
import { useMarketplace } from "@/lib/useMarketplace";
import { CombosSection } from "./card/Combos";
import { LegalitySection } from "./card/Legality";
import { OracleTagsSection } from "./card/OracleTags";
import { Note, Source } from "./card/parts";
import { PrintingsSection } from "./card/Printings";
import type { Place } from "../routes";
import { back, usePlace } from "./router";

/**
 * One card, over whatever the reader was looking at — the phone's card surface, and what every
 * page of this face opens.
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
 * **Stepping to another printing is a replace**, so it is still one place: the printings list
 * renames the entry rather than pushing, and the back gesture closes the sheet from whichever
 * printing the reader ended on rather than walking back through each one.
 *
 * ## What it says, top to bottom, in one scrolling column
 *
 * The desktop card modal's contents, in the order a reader on a phone reaches for them: the
 * picture and the words; what each finish costs, and whose prices they are; what the reader holds;
 * every printing; where the card is legal; its Oracle tags; and the combos that name it. Every
 * read is the desktop's own under the desktop's own key, so a card one face has open paints from
 * the cache on the other when a resize crosses 1024px.
 *
 * **What it does not do yet** is anything that leaves the app or writes: the `Open on …` rows go
 * through the opener, a host seam this face has not got, and nothing on this face writes.
 */
export function CardSheet({ cardId }: { cardId: string | null }) {
  const place = usePlace();
  const close = () => back({ ...place, cardId: null });
  const { marketplace } = useMarketplace();

  /**
   * The printings of the card on screen, by id — read by `placeholderData` below, which runs
   * outside render and so cannot read the printings query directly.
   */
  const siblings = useRef<ReadonlySet<string>>(new Set());

  const detail = useQuery({
    // The desktop card modal's own entry: the two faces share one query client, and the card open
    // on one side of the 1024px floor is the card open on the other — so the face a resize draws
    // paints it from the cache rather than asking again.
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
    // A refusal here is a card that is not there. Asking twice says so twice as late.
    retry: false,
    /**
     * **The card on screen stays on screen while another printing of it is read** — and only
     * then. A step down the printings list swaps the key, and without this the whole sheet would
     * blank to "Reading the card…" and its scroll would collapse under the reader's thumb for the
     * length of one read. A card opened from a wall is never a printing of the one before it
     * (closing the sheet clears the id, and the set with it), so a different card never stands
     * in for the one asked about.
     */
    placeholderData: (previous) =>
      previous !== undefined && cardId !== null && siblings.current.has(cardId)
        ? previous
        : undefined,
  });
  const card = detail.data ?? null;
  const oracleId = card?.oracleId ?? null;

  /**
   * Every printing of the card on screen — the modal's own key and page size (no `limit`), so this
   * shares that cache entry. Read here rather than in the list, because {@link siblings} is what
   * lets a step down the list keep the sheet painted, and it has to be known before the step.
   */
  const printings = useQuery({
    queryKey: cardPrintingsKey(oracleId, marketplace.id),
    queryFn: oracleId !== null ? () => ipc.cardPrintings(oracleId, marketplace.id) : skipToken,
  });
  const items = printings.data?.items;
  useEffect(() => {
    siblings.current = new Set((items ?? []).map((p) => p.id));
  }, [items]);

  /**
   * **Back to the top when the card changes**, so the picture of the printing just pressed is
   * what the reader sees — the press was at the foot of a list, and a swap that left them there
   * would change a picture they cannot see. A scroll is not state, so this writes no render.
   */
  const scroller = useRef<HTMLDivElement>(null);
  const shownId = card?.id ?? null;
  useEffect(() => {
    if (scroller.current !== null) scroller.current.scrollTop = 0;
  }, [shownId]);

  return (
    <Dialog
      open={cardId !== null}
      title={card?.name ?? "Card"}
      closeLabel="Close card"
      size="w-[28rem]"
      onDismiss={close}
      onClose={close}
    >
      {/* `relative` because this is the box carrying the overflow, and rarity gems and language
          badges carry `sr-only` spans — an absolutely positioned caption with no positioned
          ancestor is laid out outside the scroller and grows a bar for text nobody can see. */}
      <div ref={scroller} className="relative min-h-0 flex-1 select-text overflow-y-auto p-4">
        {detail.isPending && cardId !== null && <Note>Reading the card…</Note>}
        {/* `isLoadingError`, not `isError`: a refetch that fails keeps the card it had, and that
            card is still what the reader is looking at. `null` is the other way to have nothing —
            an id the card database has no row for. */}
        {(detail.isLoadingError || detail.data === null) && (
          <Note tone="alert">That card could not be read.</Note>
        )}
        {card !== null && (
          <CardBody
            card={card}
            place={place}
            printings={{
              items: items ?? [],
              total: printings.data?.total ?? 0,
              // `card.oracleId !== null` is load-bearing: a skipped query reports `isPending`
              // for ever, so without it the list would say "Loading printings…" on exactly the
              // cards that have none.
              loading: printings.isPending && card.oracleId !== null,
              error: printings.isError ? ipcError(printings.error) : null,
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * Everything the sheet says about one card, once it has been read.
 *
 * Its own component so the reads that hang off the card — holdings, tags, combos — are only
 * ever mounted with a card in hand, which is what lets each key on the card's oracle id without
 * an arm for a card that has not arrived.
 */
function CardBody({
  card,
  place,
  printings,
}: {
  card: CardDetail;
  place: Place;
  printings: { items: readonly Printing[]; total: number; loading: boolean; error: string | null };
}) {
  const { marketplace, currency } = useMarketplace();
  const faces = facesOf(card);
  const finishes = parseFinishes(card.finishes);

  const holdings = useQuery({
    queryKey: cardHoldingsKey(card.oracleId),
    queryFn: card.oracleId !== null ? () => ipc.cardHoldings(card.oracleId as string) : skipToken,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="mx-auto w-full max-w-64">
        <CardArt cardId={card.id} name={card.name} variant="display" loading="eager" />
      </div>

      <div className="flex flex-col gap-3">
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
              <p className="whitespace-pre-line text-sm leading-relaxed">
                {/* `inline`, not the component's `inline-flex`: rules text wraps, and a flex run
                    of it is one unbreakable line. Through `ManaText` so `{T}` is the symbol and
                    not three characters. */}
                <ManaText source={face.oracleText} className="inline" />
              </p>
            )}
          </div>
        ))}
        <p className="flex items-center gap-1.5 font-mono text-xs uppercase text-dim">
          <RarityGem rarity={card.rarity} className="shrink-0" />
          <span className="min-w-0">
            {card.setCode} · {card.collectorNumber}
            {card.setName !== null && <span className="normal-case"> — {card.setName}</span>}
          </span>
        </p>
      </div>

      {/* **One cell per finish this printing is sold in**, which is `CardModalArt`'s rule: a
          printing that has no etched copy draws no etched price, rather than a dash that reads as
          "not priced yet". A printing whose finishes are unknown draws no cells at all — and then
          no as-of line either, since a caption dating prices that are not on screen would be a
          caption about nothing. */}
      {finishes.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <dl
            className="grid gap-2 text-center"
            style={{ gridTemplateColumns: `repeat(${finishes.length}, minmax(0, 1fr))` }}
          >
            {finishes.map((finish) => (
              <div key={finish}>
                <dt className="flex items-center justify-center gap-1 text-xs text-dim">
                  <FinishMark
                    finish={finish}
                    treatments={finishTreatments(card.promoTypes, finish)}
                  />
                  {FINISH_LABEL[finish]}
                </dt>
                <dd className="font-mono text-base tabular-nums">
                  {formatPrice(card.finishPrices[finish], currency)}
                </dd>
              </div>
            ))}
          </dl>
          {/* A price is never shown without saying how old it is — and whose it is. */}
          <Source>{pricesAsOf(marketplace)}</Source>
        </div>
      )}

      {/* **In your grimoire**, at the oracle grain — a reader who owns the Alpha Bolt and opens
          the 2X2 one owns *Lightning Bolt*. The accent is the app's "this is yours", as on the
          desktop modal's own block; nothing else on the sheet takes it. Drawn only once the read
          has answered, so a figure is never a zero that was really "not asked yet". */}
      {holdings.data !== undefined && (
        <div className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <h3 className="text-xs uppercase tracking-wide text-accent">In your grimoire</h3>
          <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <Figure label="Owned" value={holdings.data.owned} />
            <Figure label="Wished" value={holdings.data.wished} />
            <Figure label="In decks" value={holdings.data.decks} />
          </dl>
        </div>
      )}

      <PrintingsSection cardId={card.id} place={place} currency={currency} {...printings} />
      <LegalitySection legalities={card.legalities} />
      <OracleTagsSection oracleId={card.oracleId} />
      <CombosSection oracleId={card.oracleId} />

      {/* Required wherever art is shown — Scryfall's usage rule rather than a courtesy. */}
      <Source>
        {card.artist !== null ? `Illustrated by ${card.artist}. ` : ""}
        Card images © Wizards of the Coast · Data © Scryfall
      </Source>
    </div>
  );
}

/** One figure — the word, then the number. */
function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
