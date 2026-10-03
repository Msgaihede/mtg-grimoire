import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, TriangleAlert } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { deckCardName, deckCardShort, deckCardNoted } from "@/features/decks/cardControl";
import { deckDetailQuery } from "@/features/decks/deckQuery";
import { deckStats } from "@/features/decks/DeckStats";
import { tracksCollection } from "@/features/decks/deckKind";
import { notedOracleIds } from "@/features/decks/deckNotes";
import { buildGroups, type CardGroup } from "@/features/decks/grouping";
import { LabelDot } from "@/features/decks/CardMarks";
import { asSortBy } from "@/features/decks/sorting";
import { useDeckNotes } from "@/features/decks/useDeckNotes";
import { useDecks } from "@/features/decks/useDecks";
import { useFormatSpecs } from "@/features/decks/useFormatSpecs";
import { validateForMarks } from "@/features/decks/validation/engine";
import { ruleBreak, violationsBySlot, violationsFor } from "@/features/decks/violations";
import { GroupHeader } from "@/features/decks/views/GroupHeader";
import { splitRail } from "@/features/decks/views/columns";
import { count } from "@/lib/counts";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import type { DeckCard, DeckRow, DeckVariant } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { linkTo } from "../router";
import { DeckRail } from "./DeckRail";
import { DimNote, ReadError } from "./parts";

/**
 * One deck, read-only, as **one column** — the owner's call for 360px (2026-10-03): the commander
 * first, then each of the deck's piles one above another in the deck's own order, then the piles
 * played beside the deck, then the side rail (the check, the bracket, tokens, the curve, notes and
 * to-do lists). Nothing is laid side by side below 1024px.
 *
 * **Read through the desktop editor's own query** (`deckDetailQuery`, `["decks", "detail", id,
 * variant, marketplace]`), so a resize across the floor paints the deck from the cache in either
 * direction, and every deck write either face makes refreshes it. Phase 1 keyed its own query
 * and read only the live list; both are gone.
 *
 * **The piles are the desktop's**: `buildGroups` under `category`, so a switched-off pile, an
 * empty one the reader made and a command zone the format has draw exactly as the editor draws
 * them, and `splitRail` cuts the head, the body and the beside-the-deck tail the column views cut.
 * The grouping is always `category` here whatever the deck remembers — a phone page of piles is
 * what the owner asked for, and the regroupings are the editor's controls, not facts about the
 * deck. The order *inside* a pile is the deck's remembered sort, which is a fact the reader chose.
 */
export function DeckPage({
  deckId,
  onOpenCard,
}: {
  deckId: number;
  onOpenCard: (cardId: string) => void;
}) {
  const { marketplace } = useMarketplace();
  const decks = useDecks();
  const listed = decks.decks.find((d) => d.id === deckId);

  /**
   * The list on screen. **Local state, seeded from the deck's remembered tab** — the desktop's
   * own restore (`DeckEditor`'s `storedVariant`): the list the reader last looked at, Actual for
   * a deck that keeps no plan. Not in the URL: the variant is a way of looking at a deck rather
   * than a place, the desktop face keeps it the same way (in `decks.last_variant`, which this
   * read-only page does not write), and a parameter only one face reads would be dropped by the
   * other at the first crossing.
   */
  const [picked, setPicked] = useState<DeckVariant | null>(null);
  // Which list to ask for before the deck has answered: the gallery's row, which the shared
  // cache usually holds. Waiting for it costs nothing on the way in from the gallery and saves
  // reading a list only to throw it away; a refused list read falls through to Actual.
  const seed = listed === undefined ? null : remembered(listed);
  const listSettled = !decks.query.isPending;
  const asked: DeckVariant | null = picked ?? seed ?? (listSettled ? "live" : null);

  const detail = useQuery({
    ...deckDetailQuery(asked === null ? null : deckId, asked ?? "live", marketplace.id),
  });
  const row = detail.data?.deck ?? listed ?? null;
  // The guarantee rather than the mechanism, the editor's clamp: a deck that stops keeping a plan
  // must not leave the page reading a list no control here can get back to.
  const variant: DeckVariant = row !== null && !row.theoryEnabled ? "live" : (asked ?? "live");
  const name = row?.name;
  const back = {
    view: "decks",
    deckId: null,
    cardId: null,
    folderId: row?.folderId ?? null,
  } as const;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
        {/* A link, like the tabs: it changes the URL. It lands in the folder the deck is filed
            in, which is where a reader who walked here came from. */}
        <a
          {...linkTo(back)}
          aria-label="Back to decks"
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md text-dim",
            FOCUS,
          )}
        >
          <ChevronLeft aria-hidden className="size-5" />
        </a>
        {/* Only once there is a name: an empty heading is a stop with nothing to hear at it. */}
        {name ? (
          <h2 className="min-w-0 flex-1 truncate text-base">{name}</h2>
        ) : (
          <span className="flex-1" />
        )}
        {row?.theoryEnabled === true && <VariantSwitch variant={variant} onPick={setPicked} />}
      </div>

      {detail.isLoadingError ? (
        // The read failed, which says nothing about the deck. "Gone" is the sentence below, for a
        // read that succeeded and answered no deck.
        <ReadError>That deck could not be read.</ReadError>
      ) : detail.data === null ? (
        <DimNote>That deck is gone.</DimNote>
      ) : detail.data === undefined ? null : (
        <DeckColumn
          key={variant}
          deckId={deckId}
          row={detail.data.deck}
          cards={detail.data.cards}
          categories={detail.data.categories}
          variant={variant}
          marketplace={marketplace}
          onOpenCard={onOpenCard}
        />
      )}
    </>
  );
}

/** The list a deck opens on: its remembered tab where it keeps a plan, Actual where it does not. */
function remembered(deck: Pick<DeckRow, "theoryEnabled" | "lastVariant">): DeckVariant {
  return deck.theoryEnabled ? deck.lastVariant : "live";
}

/**
 * Theory and Actual — the editor's two-way switch, in its order and with its words: the plan is
 * the list a deck is built in, so it comes first, and `Actual` is the name for the stored `live`.
 * Buttons rather than links, because the list is not a place (see {@link DeckPage}'s state).
 */
function VariantSwitch({
  variant,
  onPick,
}: {
  variant: DeckVariant;
  onPick: (next: DeckVariant) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Deck list"
      className="flex shrink-0 overflow-hidden rounded-md border border-border"
    >
      {(
        [
          { id: "theory", label: "Theory" },
          { id: "live", label: "Actual" },
        ] as const
      ).map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={variant === id}
          onClick={() => onPick(id)}
          className={cn(
            "h-9 px-3 text-xs",
            variant === id ? "bg-accent font-medium text-accent-fg" : "text-dim",
            FOCUS_INSET,
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** One list of the deck: its figures, its piles in order, then the side rail. */
function DeckColumn({
  deckId,
  row,
  cards,
  categories,
  variant,
  marketplace,
  onOpenCard,
}: {
  deckId: number;
  row: DeckRow;
  cards: readonly DeckCard[];
  categories: Parameters<typeof buildGroups>[1];
  variant: DeckVariant;
  marketplace: Marketplace;
  onOpenCard: (cardId: string) => void;
}) {
  const { formatSpecFor } = useFormatSpecs();
  const spec = formatSpecFor(row.formatKey);
  const tracks = tracksCollection(row);
  const notes = useDeckNotes(deckId);
  const noted = useMemo(() => notedOracleIds(notes.notes), [notes.notes]);

  // `buildGroups`' third and last facts, read the way the editor reads them: an empty command
  // zone draws only where the format has one, and `requiresCommander` is `false` while the specs
  // are loading and for a format that has left the seed.
  const groups = useMemo(
    () =>
      buildGroups(cards, categories, "category", asSortBy(row.lastSortBy), row.separateXGroup, {
        requiresCommander: spec?.requiresCommander ?? false,
      }),
    [cards, categories, row.lastSortBy, row.separateXGroup, spec],
  );
  const { command, flow, rail } = useMemo(() => splitRail(groups), [groups]);

  // The marks a card wears — `validateForMarks`, the editor's pass for every card *drawn*, parked
  // ones included (issue #134), filed by row slot (issue #554).
  const marks = useMemo(
    () => (spec === null ? undefined : violationsBySlot(validateForMarks([...cards], spec), cards)),
    [cards, spec],
  );

  const stack = (group: CardGroup) => (
    <Stack
      key={group.key}
      group={group}
      marketplace={marketplace}
      render={(card) => {
        const broken = ruleBreak(violationsFor(marks, card));
        return (
          <CardRow
            key={card.id}
            card={card}
            ruleBreak={broken}
            name={deckCardName(card, broken, null, tracks, deckCardNoted(card, noted))}
            short={deckCardShort(card, tracks)}
            currency={marketplace.currency}
            onOpen={onOpenCard}
          />
        );
      }}
    />
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
      <Figures
        cards={cards}
        formatName={spec?.displayName ?? row.formatName ?? row.formatKey}
        marketplace={marketplace}
        tracks={tracks}
        separateX={row.separateXGroup}
      />

      {cards.length === 0 ? (
        <DimNote>
          {variant === "theory" ? "No cards in the theory list yet." : "No cards in this deck yet."}
        </DimNote>
      ) : (
        <>
          {command.map(stack)}
          {flow.map(stack)}
          {rail.map(stack)}
        </>
      )}

      <DeckRail
        deckId={deckId}
        row={row}
        cards={cards}
        variant={variant}
        spec={spec}
        notes={notes}
        onOpenCard={onOpenCard}
      />
    </div>
  );
}

/**
 * What the list adds up to — the editor's ledger, from the same `deckStats`: the format, the cards
 * the size rule counts (with what it does not, dim), the lands, the price and, on a deck that reads
 * the binder, what is owned and what is short. A description list that wraps; at 360px it is two
 * lines.
 */
function Figures({
  cards,
  formatName,
  marketplace,
  tracks,
  separateX,
}: {
  cards: readonly DeckCard[];
  formatName: string;
  marketplace: Marketplace;
  tracks: boolean;
  separateX: boolean;
}) {
  const stats = useMemo(() => deckStats(cards, separateX), [cards, separateX]);
  const spare = stats.copies - stats.sized;
  const term = "flex items-baseline gap-1.5";
  const label = "text-[0.6875rem] text-dim";
  const value = "font-mono text-[0.8125rem] tabular-nums";
  return (
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border px-4 py-2">
      <div className={term}>
        <dt className={label}>Format</dt>
        <dd className="text-xs">{formatName}</dd>
      </div>
      <div className={term}>
        <dt className={label}>Cards</dt>
        <dd className={value}>
          {count(stats.sized)}
          {spare > 0 && <span className="text-dim">+{count(spare)}</span>}
        </dd>
      </div>
      <div className={term}>
        <dt className={label}>Lands</dt>
        <dd className={value}>
          {count(stats.lands)}
          {stats.mdfcLands > 0 && <span className="text-dim">+{count(stats.mdfcLands)} MDFC</span>}
        </dd>
      </div>
      <div className={term}>
        <dt className={label}>Price</dt>
        <dd className={value}>{formatPrice(stats.price, marketplace.currency)}</dd>
      </div>
      {tracks && (
        <div className={term}>
          <dt className={label}>Owned</dt>
          <dd className={value}>
            {count(stats.owned)}
            {stats.missing > 0 && (
              <>
                {" "}
                <span className="text-[0.6875rem] text-destructive">
                  {count(stats.missing)} missing
                </span>
              </>
            )}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** One pile: the editor's own heading — name, count, the rule and switched-off markers, the
 *  pile's price — and its cards as rows, or a sentence where it holds none. */
function Stack({
  group,
  marketplace,
  render,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  render: (card: DeckCard) => ReactNode;
}) {
  const id = `pile-${group.key}`;
  return (
    <section aria-labelledby={id} className="border-b border-border pt-2">
      <GroupHeader group={group} marketplace={marketplace} id={id} className="px-4 pb-1" />
      {group.cards.length === 0 ? (
        <p className="px-4 pb-2 text-xs text-dim">No cards</p>
      ) : (
        <ul aria-labelledby={id} className={cn(!group.isActive && "opacity-70")}>
          {group.cards.map(render)}
        </ul>
      )}
    </section>
  );
}

/**
 * One row of a pile, at a density that puts about a dozen on a screen: the copies, the label's
 * colour, the name, the cost and the unit price. Card art for every card would be a screen per
 * five cards at this width; the picture is a press away, in the card sheet.
 *
 * **A button, not a link**: a card opens a sheet over the page it is on (`mobile/CLAUDE.md`).
 * Named by `deckCardName`, the editor's own sentence — copies, finish, label, Game Changer, a
 * note, a shortfall and a rule break — so every mark drawn here is also said.
 */
function CardRow({
  card,
  name,
  ruleBreak,
  short,
  currency,
  onOpen,
}: {
  card: DeckCard;
  name: string;
  ruleBreak: string | null;
  short: boolean;
  currency: Marketplace["currency"];
  onOpen: (cardId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-label={name}
        onClick={() => onOpen(card.cardId)}
        className={cn("flex min-h-11 w-full items-center gap-2 px-4 text-left", FOCUS_INSET)}
      >
        {/* The copies, and a dot beside them where the reader owns fewer than the deck plays —
            a mark rather than a red number, because on a deck built from nothing every row is
            short and a column of red would say less than the ledger's one `missing`. */}
        <span aria-hidden className="flex w-7 shrink-0 items-center gap-1">
          <span className="font-mono text-xs tabular-nums text-dim">{card.quantity}</span>
          {short && <span className="size-1.5 shrink-0 rounded-full bg-destructive" />}
        </span>
        <span aria-hidden className="flex min-w-0 flex-1 items-center gap-1.5">
          {card.labelName !== null && (
            <LabelDot name={card.labelName} color={card.labelColor} className="size-2" />
          )}
          <span className={cn("truncate text-sm", ruleBreak !== null && "text-destructive")}>
            {card.name}
          </span>
          {ruleBreak !== null && <TriangleAlert className="size-3.5 shrink-0 text-destructive" />}
        </span>
        <ManaText source={card.manaCost} className="shrink-0 text-xs" />
        <span
          aria-hidden
          className="w-14 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-dim"
        >
          {formatPrice(card.unitPrice, currency)}
        </span>
      </button>
    </li>
  );
}
