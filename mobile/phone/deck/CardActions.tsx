import { useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  CopyPlus,
  Layers,
  Crown,
  FolderInput,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
} from "lucide-react";
import { cardPrintingsKey } from "@/features/card/cardKeys";
import { ALREADY_HERE, finishChoices, REGULAR, zoneClaims } from "@/features/decks/deckCardRules";
import type { DeckCore } from "@/features/decks/useDeckCore";
import { useDeckMeta } from "@/features/decks/useDeckMeta";
import { FINISH_LABEL } from "@/lib/finish";
import {
  ipc,
  ipcError,
  type DeckCard,
  type DeckCategory,
  type DeckFinish,
  type DeckLabel,
  type DeckVariant,
  type FormatSpec,
} from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { PRINTING_ROW, PrintingFace, printingCode } from "../card/Printings";
import type { Receipt } from "./receipt";
import { ReceiptBar } from "./receipt";
import { ActionSheet, SheetBack, SheetChoice, SheetRow, SheetStepper as Stepper } from "./sheet";

/**
 * Where a deck row is — `DECK_CARD_GRAIN` less the deck and the list, which the page already is.
 * Every write here addresses the row by this, as `useDeck`'s mutations do, and three of them move
 * it: the sheet follows the row to its new address rather than losing it.
 */
export interface RowSlot {
  cardId: string;
  categoryId: number;
  finish: DeckFinish;
}

export const slotOf = (card: DeckCard): RowSlot => ({
  cardId: card.cardId,
  categoryId: card.categoryId,
  finish: card.finish,
});

const atSlot = (slot: RowSlot) => (card: DeckCard) =>
  card.cardId === slot.cardId && card.categoryId === slot.categoryId && card.finish === slot.finish;

/** What the sheet is open on: the row's address, and the row as it was last seen there. */
export interface Acting {
  slot: RowSlot;
  /** Drawn while the deck's re-read has not yet answered with the row at its new address. */
  seen: DeckCard;
}

type Page = "main" | "pile" | "label" | "printing" | "finish";

/** A finish, in this sheet's words — `Regular` for the plain copy, the deck editor's own. */
const finishWord = (finish: DeckFinish): string =>
  finish === null ? REGULAR : FINISH_LABEL[finish];

/**
 * What a deck row offers **without leaving the page** — the desktop's card menu for one row, as a
 * sheet at the foot of the window: the copies, the pile, the claims a card can make in the deck,
 * the label, the printing and the finish, the other list, and the removal.
 *
 * **Every write is `useDeckCore`'s**, the store-free body of the desktop editor's own `useDeck` —
 * the same commands with the same optimistic patches and the same invalidations — so the desktop
 * face, and the desktop app over the same database, read the change the moment it lands. The rules
 * a row is refused by are `deckCardRules.ts`', which the desktop menu reads too; what is the
 * phone's own is that a refusal is said in words under its row.
 *
 * **A write that moves the row moves the sheet with it.** A pile, a printing and a finish are three
 * parts of the row's address, so the host's {@link Acting} is re-pointed when each answers, and the
 * sheet goes on drawing the row it was opened on rather than one that no longer exists. Stepping
 * to zero has no address to follow, so it closes the sheet — the page's receipt says what went and
 * offers it back.
 */
export function CardActions({
  acting,
  deck,
  cards,
  categories,
  labels,
  spec,
  variant,
  theoryEnabled,
  receipt,
  onMoved,
  onClose,
}: {
  acting: Acting | null;
  deck: DeckCore;
  cards: readonly DeckCard[];
  categories: readonly DeckCategory[];
  labels: readonly DeckLabel[];
  spec: FormatSpec | null;
  variant: DeckVariant;
  theoryEnabled: boolean;
  receipt: Receipt;
  onMoved: (next: Acting) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page>("main");
  const card = acting === null ? null : (cards.find(atSlot(acting.slot)) ?? acting.seen);
  const close = () => {
    setPage("main");
    onClose();
  };
  const finish = card?.finish ?? null;

  return (
    <ActionSheet
      open={acting !== null}
      title={card?.name ?? "Card"}
      subtitle={
        card === null
          ? undefined
          : `${card.quantity} in ${card.categoryName}${finish !== null ? ` · ${finishWord(finish)}` : ""}`
      }
      closeLabel="Close card actions"
      onClose={close}
      footer={<ReceiptBar receipt={receipt} />}
    >
      {card !== null &&
        (page === "main" ? (
          <MainPage
            card={card}
            deck={deck}
            cards={cards}
            categories={categories}
            spec={spec}
            variant={variant}
            theoryEnabled={theoryEnabled}
            receipt={receipt}
            onMoved={onMoved}
            onOpen={setPage}
            onGone={close}
          />
        ) : page === "pile" ? (
          <PilePage
            card={card}
            categories={categories}
            onBack={() => setPage("main")}
            onPick={(to) => {
              receipt.track(
                deck.moveCard
                  .mutateAsync({
                    cardId: card.cardId,
                    from: card.categoryId,
                    to,
                    finish: card.finish,
                  })
                  .then(() =>
                    moved(onMoved, card, { categoryId: to, categoryName: nameOf(categories, to) }),
                  ),
                () => `Moved ${card.name} to ${nameOf(categories, to)}.`,
              );
              setPage("main");
            }}
          />
        ) : page === "label" ? (
          <LabelPage
            card={card}
            deckId={deck.deck?.id ?? null}
            variant={variant}
            worn={labels}
            onBack={() => setPage("main")}
            onPick={(labelId, labelName) => {
              receipt.track(deck.setLabel.mutateAsync({ ...slotOf(card), labelId }), () =>
                labelName === null
                  ? `Took the label off ${card.name}.`
                  : `Labelled ${card.name} ${labelName}.`,
              );
              setPage("main");
            }}
          />
        ) : page === "printing" ? (
          <PrintingPage
            card={card}
            onBack={() => setPage("main")}
            onPick={(toCardId, printingWords) => {
              receipt.track(
                deck.swapPrinting
                  .mutateAsync({
                    fromCardId: card.cardId,
                    toCardId,
                    categoryId: card.categoryId,
                    finish: card.finish,
                  })
                  .then(() => moved(onMoved, card, { cardId: toCardId })),
                () => `${card.name} now plays ${printingWords}.`,
              );
              setPage("main");
            }}
          />
        ) : (
          <FinishPage
            card={card}
            onBack={() => setPage("main")}
            onPick={(to) => {
              receipt.track(
                deck.setCardFinish
                  .mutateAsync({ ...slotOf(card), to })
                  .then(() => moved(onMoved, card, { finish: to })),
                () => `${card.name} is now ${finishWord(to).toLowerCase()}.`,
              );
              setPage("main");
            }}
          />
        ))}
    </ActionSheet>
  );
}

/** Re-point the sheet at the row's new address, carrying what the write is known to have changed
 *  onto the row last seen so the sheet does not blank while the re-read is out. */
function moved(onMoved: (next: Acting) => void, card: DeckCard, patch: Partial<DeckCard>) {
  const seen = { ...card, ...patch };
  onMoved({ slot: slotOf(seen), seen });
}

const nameOf = (categories: readonly DeckCategory[], id: number): string =>
  categories.find((c) => c.id === id)?.name ?? "";

function MainPage({
  card,
  deck,
  cards,
  categories,
  spec,
  variant,
  theoryEnabled,
  receipt,
  onMoved,
  onOpen,
  onGone,
}: {
  card: DeckCard;
  deck: DeckCore;
  cards: readonly DeckCard[];
  categories: readonly DeckCategory[];
  spec: FormatSpec | null;
  variant: DeckVariant;
  theoryEnabled: boolean;
  receipt: Receipt;
  onMoved: (next: Acting) => void;
  onOpen: (page: Page) => void;
  onGone: () => void;
}) {
  /**
   * The stepper's write — `useDeck`'s `setQuantity`, handed the row it is cutting from as the
   * desktop's `setQuantityAt` hands it, so a cut on an Actual list files the copies into
   * `Recently removed` in the same transaction and every other list takes the absolute write. The
   * routing is the mutation's, not this sheet's.
   */
  const setQuantity = (quantity: number) => {
    receipt.track(
      deck.setQuantity.mutateAsync({
        ...slotOf(card),
        quantity,
        held: { deckCardId: card.id, quantity: card.quantity },
      }),
      // A step up or down is said by the sheet's own count; a removal closes the sheet, so the
      // page says it — and, for a cut that moved copies, where they went, since that write files
      // no undo step (it is a collection write) and the line is the only record of it on screen.
      (result) =>
        quantity > 0
          ? null
          : `Removed ${card.quantity} \u00d7 ${card.name} from ${card.categoryName}.${
              result.outcome !== null && result.outcome.quantity > 0
                ? " The copies are in Recently removed."
                : ""
            }`,
    );
    if (quantity === 0) onGone();
  };
  const choices = finishChoices(card.finishes);
  const claims = zoneClaims(card, categories, cards, spec);
  const other = variant === "theory" ? "actual" : "theory";

  return (
    <>
      <Stepper quantity={card.quantity} name={card.name} onSet={setQuantity} />
      <ul>
        <SheetRow
          label="Pile"
          value={card.categoryName}
          Icon={FolderInput}
          opens
          onPress={() => onOpen("pile")}
        />
        {claims.map((claim) => (
          <SheetRow
            key={claim.zone}
            label={claim.label}
            Icon={claim.zone === "commander" ? Crown : UserRound}
            reason={claim.refusal}
            onPress={() =>
              receipt.track(
                deck.moveCard
                  .mutateAsync({
                    cardId: card.cardId,
                    from: card.categoryId,
                    to: claim.categoryId,
                    finish: card.finish,
                  })
                  .then(() =>
                    moved(onMoved, card, {
                      categoryId: claim.categoryId,
                      categoryName: nameOf(categories, claim.categoryId),
                    }),
                  ),
                () => `${card.name} is now the ${claim.zone}.`,
              )
            }
          />
        ))}
        <SheetRow
          label="Label"
          value={card.labelName ?? "None"}
          Icon={Tag}
          opens
          onPress={() => onOpen("label")}
        />
        <SheetRow
          label="Printing"
          Icon={Layers}
          value={`${card.setCode.toUpperCase()} · ${card.collectorNumber}`}
          opens
          // A printing that has left the card database has no siblings to offer, and the swap
          // refuses it in Rust; said rather than offered.
          reason={card.oracleId === null ? "this printing has left the card database" : null}
          onPress={() => onOpen("printing")}
        />
        <SheetRow
          label="Finish"
          value={finishWord(card.finish)}
          Icon={Sparkles}
          opens
          reason={choices.length <= 1 ? "this printing is sold in one finish" : null}
          onPress={() => onOpen("finish")}
        />
        {/* The deck's other list, one copy per press — the desktop menu's `Add to actual` /
            `Add to theory`, drawn only where the deck keeps a plan, and refused for a printing the
            card database no longer has, which the command refuses too. */}
        {theoryEnabled && (
          <SheetRow
            label={`Add to ${other}`}
            Icon={CopyPlus}
            reason={card.oracleId === null ? "this printing has left the card database" : null}
            onPress={() =>
              receipt.track(
                deck.addToOtherList.mutateAsync(slotOf(card)),
                () => `Added 1 \u00d7 ${card.name} to the ${other} list.`,
              )
            }
          />
        )}
        <SheetRow
          label={`Remove from ${card.categoryName}`}
          Icon={Trash2}
          destructive
          onPress={() => setQuantity(0)}
        />
      </ul>
    </>
  );
}

/**
 * **Every pile of this list, in the reader's own order** — the desktop menu's `Category ▸`, and for
 * its reason: filing is the same gesture as a drag onto a pile's heading, so it is refused nowhere
 * but the pile the card is already in. A switched-off pile is offered and says what that costs.
 * The command zones are *claims*, fenced by the rules on the sheet's first page.
 */
function PilePage({
  card,
  categories,
  onBack,
  onPick,
}: {
  card: DeckCard;
  categories: readonly DeckCategory[];
  onBack: () => void;
  onPick: (categoryId: number) => void;
}) {
  return (
    <>
      <SheetBack label="Pile" onBack={onBack} />
      <ul aria-label="Piles">
        {categories.map((category) => (
          <SheetChoice
            key={category.id}
            label={category.name}
            current={category.id === card.categoryId}
            note={
              category.id === card.categoryId
                ? ALREADY_HERE
                : category.isActive
                  ? undefined
                  : "switched off — counts toward nothing"
            }
            onPick={() => onPick(category.id)}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * `None`, then the labels this list is already wearing (most-used first, the backend's order), then
 * every other label the reader owns — the desktop's `Label card ▸` and its `More labels…` on one
 * page, because a phone sheet has the height a menu does not. **A deck card wears at most one.**
 */
function LabelPage({
  card,
  deckId,
  variant,
  worn,
  onBack,
  onPick,
}: {
  card: DeckCard;
  deckId: number | null;
  variant: DeckVariant;
  worn: readonly DeckLabel[];
  onBack: () => void;
  onPick: (labelId: number | null, name: string | null) => void;
}) {
  // Mounted only on this page: the app-wide list is a read nobody pays for until they ask.
  const { allLabels } = useDeckMeta(deckId, variant);
  const wornIds = new Set(worn.map((label) => label.id));
  const rest = allLabels.filter((label) => !wornIds.has(label.id));
  return (
    <>
      <SheetBack label="Label" onBack={onBack} />
      <ul aria-label="Labels">
        <SheetChoice
          label="None"
          current={card.labelId === null}
          onPick={() => onPick(null, null)}
        />
        {[...worn, ...rest].map((label) => (
          <SheetChoice
            key={label.id}
            label={label.name}
            current={card.labelId === label.id}
            onPick={() => onPick(label.id, label.name)}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * Every printing of the card, as the card sheet lists them — the same read under the same key, and
 * the same row drawn as a button that **swaps** the deck's printing. A swap onto a printing the
 * pile already holds folds the two rows into one, as on the desktop.
 */
function PrintingPage({
  card,
  onBack,
  onPick,
}: {
  card: DeckCard;
  onBack: () => void;
  onPick: (cardId: string, words: string) => void;
}) {
  const { marketplace, currency } = useMarketplace();
  const oracleId = card.oracleId;
  const printings = useQuery({
    queryKey: cardPrintingsKey(oracleId, marketplace.id),
    queryFn: oracleId !== null ? () => ipc.cardPrintings(oracleId, marketplace.id) : skipToken,
  });
  const items = printings.data?.items ?? [];
  return (
    <>
      <SheetBack label="Printing" onBack={onBack} />
      {printings.isPending ? (
        <p className="px-4 py-3 text-sm text-dim">Loading printings…</p>
      ) : printings.isError ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {`Couldn't load the printings — ${ipcError(printings.error)}`}
        </p>
      ) : (
        <ul aria-label="Printings" className="px-2">
          {items.map((printing) => {
            const current = printing.id === card.cardId;
            return (
              <SheetChoice
                key={printing.id}
                label={`${current ? "" : "Play "}${printing.setName ?? printing.setCode.toUpperCase()}, ${printingCode(printing)}`}
                current={current}
                onPick={() =>
                  onPick(
                    printing.id,
                    `${printing.setCode.toUpperCase()} ${printing.collectorNumber}`,
                  )
                }
              >
                <span className={cn(PRINTING_ROW, "min-w-0 flex-1 px-0")}>
                  <PrintingFace printing={printing} currency={currency} />
                </span>
              </SheetChoice>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** The finishes this printing is sold in, in Scryfall's own order — the order is the information. */
function FinishPage({
  card,
  onBack,
  onPick,
}: {
  card: DeckCard;
  onBack: () => void;
  onPick: (finish: DeckFinish) => void;
}) {
  return (
    <>
      <SheetBack label="Finish" onBack={onBack} />
      <ul aria-label="Finishes">
        {finishChoices(card.finishes).map((finish) => (
          <SheetChoice
            key={finish ?? "regular"}
            label={finishWord(finish)}
            current={finish === card.finish}
            onPick={() => onPick(finish)}
          />
        ))}
      </ul>
    </>
  );
}
