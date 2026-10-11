import { useId, useState } from "react";
import { Camera, Plus, Search, TriangleAlert } from "lucide-react";
import { CardImage } from "@grimoire/ui/components/CardImage";
import { ToggleChip } from "@grimoire/ui/components/FilterChips";
import { linesOf, tradeMoney } from "@grimoire/ui/features/trade/trade";
import {
  DECK_COPIES_HEADING,
  DECK_COPIES_WARNING,
  deckHolding,
  printingLine,
  sideWords,
} from "@grimoire/ui/features/trade/tradeWords";
import {
  useTradeCandidates,
  type TradeCandidate,
  type TradeScope,
} from "@grimoire/ui/features/trade/useTradeCandidates";
import { plural } from "@grimoire/ui/lib/counts";
import { FOCUS, FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { ART_ASPECT, cardImageUrl } from "@grimoire/ui/lib/images";
import type { Trade, TradeSide } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { PRESS } from "@grimoire/ui/lib/motion";
import { formatPrice } from "@grimoire/ui/lib/prices";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet } from "../deck/sheet";
import { GOLD_BUTTON, PLAIN_BUTTON, Refusal } from "./parts";
import { capital, money } from "./text";

/**
 * Add cards to one side of a trade.
 *
 * **Your side opens on your collection**, which is where the cards a reader gives away come from:
 * each row is a printing in the finish they hold it in, with how many copies there are — and how
 * many of them this trade already has. `All cards` is one chip over, for a card that is not in the
 * app yet. **Their side has no such chip**: what they hold is not in this collection, so the field
 * searches every card and says so.
 *
 * **The copies a deck is holding are a section of their own, under the others and in the
 * destructive colour**: headed *In your decks*, with a sentence saying what a finish does to them,
 * and each row names its deck (`1 in Serah`) where another says `3 owned`. Trading one leaves that
 * deck a card short, so it is offered and never mixed in — and the heading, the sentence and the
 * deck's name say so in words as well as in colour. Both lists are `useTradeCandidates`', which is
 * where a copy is told from a deck's.
 *
 * **A press adds one copy and the sheet stays up** — a trade is several cards, and the row counts
 * up (`2 in this trade`) under the thumb that pressed it. Adding a printing and finish the side
 * already holds raises that line; that fold is the backend's, and the count here is read back from
 * the trade rather than kept beside it.
 *
 * `Scan` leaves for the scanner, pointed at this side — a request the page answers, since the
 * scanner is a full-screen view of its own and this sheet closes under it.
 *
 * The rows are `useTradeCandidates`', the desktop field's own, so both faces offer one list for
 * one word — priced at the trade's marketplace, never the reader's current one.
 */
export function AddCardsSheet({
  side,
  trade,
  currency,
  refusal,
  onAdd,
  onScan,
  onClose,
  onDismiss,
}: {
  /** The side being added to — `null` is closed. */
  side: TradeSide | null;
  trade: Trade;
  currency: Currency;
  refusal: string | null;
  onAdd: (side: TradeSide, card: TradeCandidate) => void;
  onScan: (side: TradeSide) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<TradeScope | null>(null);
  // Closed, nothing below is drawn; the side it falls back to is only a value to compute with.
  const shown = side ?? "mine";
  const scope: TradeScope = shown === "mine" ? (picked ?? "collection") : "all";
  // A closed sheet asks nothing: an empty word is no query at all.
  const found = useTradeCandidates(scope, side === null ? "" : text, trade.marketplace);
  const whose = sideWords(shown);
  const asked = text.trim();
  const figures = tradeMoney(trade);
  const total = shown === "mine" ? figures.mine.total : figures.theirs.total;

  /** Copies of this printing and finish the side already holds. */
  const inTrade = (card: TradeCandidate): number =>
    linesOf(trade.lines, shown)
      .filter((line) => line.cardId === card.cardId && line.finish === card.finish)
      .reduce((sum, line) => sum + line.quantity, 0);

  // Either way out forgets the word and the scope: the next opening may be for the other side.
  const leave = (how: () => void) => () => {
    setText("");
    setPicked(null);
    how();
  };

  return (
    <ActionSheet
      open={side !== null}
      title="Add cards"
      subtitle={`To ${whose} of the trade`}
      closeLabel="Close add cards"
      onClose={leave(onClose)}
      onDismiss={leave(onDismiss)}
      footer={
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 pt-3 pb-4">
          <Refusal>{refusal}</Refusal>
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[0.8125rem] text-dim">
              {`${capital(whose)}: `}
              <span className="font-mono text-text tabular-nums">{money(total, currency)}</span>
            </p>
            <button type="button" onClick={leave(onDismiss)} className={cn(GOLD_BUTTON, "px-6")}>
              Done
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-2.5 border-b border-border px-4 py-3">
        {/* The chips are the desktop's own, floored for a thumb from outside them — the search
            sheet's arrangement. */}
        <div className="flex items-center gap-2 [&_button]:min-h-11">
          {shown === "mine" && (
            <>
              <ToggleChip
                label="Collection"
                pressed={scope === "collection"}
                onClick={() => setPicked("collection")}
              />
              <ToggleChip
                label="All cards"
                pressed={scope === "all"}
                onClick={() => setPicked("all")}
              />
            </>
          )}
          <button
            type="button"
            aria-label={`Scan cards onto ${whose}`}
            onClick={() => {
              if (side !== null) leave(() => onScan(side))();
            }}
            className={cn(PLAIN_BUTTON, "ml-auto")}
          >
            <Camera aria-hidden className="size-[1.125rem] shrink-0" />
            Scan
          </button>
        </div>

        <label
          className={cn(
            "flex h-11 items-center gap-2 rounded-md border border-border bg-bg px-3 text-dim",
            "focus-within:border-accent",
          )}
        >
          <Search aria-hidden className="size-[1.125rem] shrink-0" />
          <input
            type="search"
            aria-label={scope === "collection" ? "Search your collection" : "Search all cards"}
            placeholder="Card name"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            // 16px: below it a phone zooms the page when the box takes the caret.
            className="h-full min-w-0 flex-1 bg-transparent text-base text-text outline-none select-text"
          />
        </label>
      </div>

      {found.error !== null ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {`Couldn't search — ${found.error}`}
        </p>
      ) : (
        <>
          {found.rows.length > 0 && (
            <ul aria-label={scope === "collection" ? "Cards in your collection" : "Cards"}>
              {found.rows.map((card) => (
                <CandidateRow
                  key={card.key}
                  card={card}
                  currency={currency}
                  inTrade={inTrade(card)}
                  onAdd={() => {
                    if (side !== null) onAdd(side, card);
                  }}
                />
              ))}
            </ul>
          )}
          {found.deckRows.length > 0 && (
            <section aria-labelledby={`${id}-decks`} aria-describedby={`${id}-decks-warning`}>
              <div className="flex flex-col gap-1 border-b border-destructive/40 bg-destructive/10 px-4 py-2.5 text-destructive">
                <h3 id={`${id}-decks`} className="flex items-center gap-1.5 text-sm font-semibold">
                  <TriangleAlert aria-hidden className="size-4 shrink-0" />
                  {DECK_COPIES_HEADING}
                </h3>
                <p id={`${id}-decks-warning`} className="text-[0.8125rem] leading-snug">
                  {DECK_COPIES_WARNING}
                </p>
              </div>
              <ul aria-labelledby={`${id}-decks`}>
                {found.deckRows.map((card) => (
                  <CandidateRow
                    key={card.key}
                    card={card}
                    currency={currency}
                    inTrade={inTrade(card)}
                    onAdd={() => {
                      if (side !== null) onAdd(side, card);
                    }}
                  />
                ))}
              </ul>
            </section>
          )}
          <Aside
            asked={asked}
            scope={scope}
            pending={found.pending}
            matches={found.rows.length}
            inDecks={found.deckRows.length}
            onAll={() => setPicked("all")}
          />
        </>
      )}
    </ActionSheet>
  );
}

/**
 * One card the side could take: its art, its name and price, which copy it is, and the add.
 *
 * **The art crop, not the whole card**, where every other small picture on this page is the whole
 * card: a result is told from the one under it by its picture at a glance and by its code line
 * for certain, and a 56px-wide whole card is a 78px-tall row — five results would fill the sheet.
 *
 * The add is 44px and is the row's only press. It turns gold once the side holds the card, with
 * the count in words beside it: the press is still an add, and the gold says it has landed.
 *
 * **A deck's copy is the same row with its words in the destructive colour** — the name, the code
 * line and the count, which names the deck — and its add is that colour too, landed or not: gold
 * is the colour of an ordinary add here, and this is not one. Its name says the deck as well, so
 * the same printing in two decks is two presses a screen reader can tell apart.
 */
function CandidateRow({
  card,
  currency,
  inTrade,
  onAdd,
}: {
  card: TradeCandidate;
  currency: Currency;
  inTrade: number;
  onAdd: () => void;
}) {
  const code = printingLine(card.setCode, card.collectorNumber, card.finish);
  const inDeck = card.place === "deck";
  const holding =
    card.owned === null
      ? null
      : card.deckName === null
        ? `${card.owned} owned`
        : deckHolding(card.owned, card.deckName);
  const held = [holding, inTrade > 0 ? `${inTrade} in this trade` : null].filter(
    (part) => part !== null,
  );
  return (
    <li
      data-place={card.place ?? undefined}
      className="grid grid-cols-[3.5rem_minmax(0,1fr)_2.75rem] items-center gap-2.5 border-b border-border py-2 pr-2 pl-4"
    >
      <span
        aria-hidden="true"
        className="block overflow-hidden rounded-[3px] bg-bg"
        style={{ aspectRatio: ART_ASPECT }}
      >
        <CardImage
          src={cardImageUrl(card.cardId, 0, "art")}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              inDeck && "text-destructive",
            )}
          >
            {card.name}
          </span>
          <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums">
            {formatPrice(card.unitPrice, currency)}
          </span>
        </span>
        <span
          className={cn(
            "truncate font-mono text-xs tabular-nums",
            inDeck ? "text-destructive" : "text-dim",
          )}
        >
          {code}
        </span>
        {held.length > 0 && (
          <span
            className={cn(
              "text-xs",
              inDeck ? "text-destructive" : inTrade > 0 ? "text-accent" : "text-dim",
            )}
          >
            {held.join(" · ")}
          </span>
        )}
      </span>
      <button
        type="button"
        // The printing rides in the name: two printings of one card are the ordinary result. So
        // does the deck, for a deck's copy: the same printing in two decks is two rows.
        aria-label={
          card.deckName === null
            ? `Add ${card.name}, ${code}`
            : `Add ${card.name}, ${code}, from your deck ${card.deckName}`
        }
        onClick={onAdd}
        className={cn(
          "flex size-11 items-center justify-center rounded-md",
          inDeck ? "text-destructive" : inTrade > 0 ? "text-accent" : "text-dim",
          PRESS,
          FOCUS,
        )}
      >
        <Plus aria-hidden className="size-5" />
      </button>
    </li>
  );
}

/**
 * The line under the results — or in their place.
 *
 * **In the collection it always offers the way out to every card**, because the commonest reason
 * a card is not in the list is that the reader does not own it, and a list that just ended would
 * leave them retyping the word one chip over.
 *
 * **A deck's copies are matches, counted apart.** *Nothing in your collection matches* is said
 * only where neither list has a row: a card whose every copy is sleeved is in the collection, and
 * the sentence must not deny it under a list that shows it.
 */
function Aside({
  asked,
  scope,
  pending,
  matches,
  inDecks,
  onAll,
}: {
  asked: string;
  scope: TradeScope;
  pending: boolean;
  matches: number;
  /** Rows in the *In your decks* section. Always zero outside the collection. */
  inDecks: number;
  onAll: () => void;
}) {
  const line = "px-4 py-3 text-[0.8125rem] text-dim";
  if (asked === "") {
    return (
      <p className={line}>
        {scope === "collection"
          ? "Type a card's name to find it in your collection."
          : "Type a card's name."}
      </p>
    );
  }
  // The rows on screen answer an older word while a read is out; counting them would be a claim
  // about the wrong question.
  if (pending) {
    return (
      <p className={line}>
        Searching…
      </p>
    );
  }
  if (scope === "all") {
    return matches > 0 ? null : (
      <p className={line}>{`No card matches “${asked}”.`}</p>
    );
  }
  return (
    <p className={cn(line, "flex flex-wrap items-center gap-x-1.5")}>
      {matches === 0 && inDecks === 0
        ? "Nothing in your collection matches."
        : matches === 0
          ? `${plural(inDecks, "match", "matches")}, in your decks only.`
          : inDecks === 0
            ? `${plural(matches, "match", "matches")} in your collection.`
            : `${plural(matches, "match", "matches")} in your collection, ${inDecks} in your decks.`}
      <button
        type="button"
        onClick={onAll}
        className={cn("-my-3 min-h-11 text-left text-accent", FOCUS_INSET)}
      >
        {`Search all cards for “${asked}”`}
      </button>
    </p>
  );
}
