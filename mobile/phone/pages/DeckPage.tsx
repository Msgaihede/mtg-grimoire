import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Ellipsis, Plus, TriangleAlert, Wrench } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { deckCardName, deckCardShort, deckCardNoted } from "@/features/decks/cardControl";
import { deckStats } from "@/features/decks/DeckStats";
import { tracksCollection } from "@/features/decks/deckKind";
import { notedOracleIds } from "@/features/decks/deckNotes";
import { buildGroups, type CardGroup } from "@/features/decks/grouping";
import { LabelDot } from "@/features/decks/CardMarks";
import { asSortBy } from "@/features/decks/sorting";
import { DeckSettingsDialog } from "@/features/decks/DeckSettingsDialog";
import { useDeckCore, type DeckCore } from "@/features/decks/useDeckCore";
import { useDeckNotes } from "@/features/decks/useDeckNotes";
import { useDecks } from "@/features/decks/useDecks";
import { useFormatSpecs } from "@/features/decks/useFormatSpecs";
import { validateForMarks } from "@/features/decks/validation/engine";
import { ruleBreak, violationsBySlot, violationsFor } from "@/features/decks/violations";
import { GroupHeader } from "@/features/decks/views/GroupHeader";
import { splitRail } from "@/features/decks/views/columns";
import { count } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import type { DeckCard, DeckCategory, DeckLabel, DeckRow, DeckVariant } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { PRESS_SOFT } from "@/lib/motion";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { AddCards } from "../deck/AddCards";
import { CardActions, slotOf, type Acting } from "../deck/CardActions";
import { shownList } from "../deck/list";
import { ReceiptBar, useReceipt } from "../deck/receipt";
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
  picked,
  onPick,
  onOpenCard,
}: {
  deckId: number;
  /** The list the reader switched this deck to — the face's state, see `deck/list.ts`. */
  picked: DeckVariant | null;
  onPick: (list: DeckVariant) => void;
  onOpenCard: (cardId: string) => void;
}) {
  const { marketplace } = useMarketplace();
  const decks = useDecks();
  const listed = decks.decks.find((d) => d.id === deckId);

  /**
   * The list on screen — `shownList`, the one rule this page and the card sheet over it read: the
   * reader's press, else the list the deck remembers, Actual for a deck that keeps no plan. Before
   * the deck has answered it is asked of the gallery's row, which the shared cache usually holds;
   * waiting for it costs nothing on the way in from the gallery and saves reading a list only to
   * throw it away, and a refused list read falls through to Actual.
   */
  const listSettled = !decks.query.isPending;
  const asked: DeckVariant | null =
    shownList(listed ?? null, picked) ?? (listSettled ? "live" : null);

  /**
   * The deck, read **and written** through `useDeckCore` — the desktop editor's own `useDeck`
   * without the app store — under the editor's own key, so a resize across the floor paints the
   * deck from the cache in either direction, and every write either face makes refreshes it.
   */
  const deck = useDeckCore(asked === null ? null : deckId, asked ?? "live");
  const detail = deck.query;
  const row = detail.data?.deck ?? listed ?? null;
  // The guarantee rather than the mechanism, the editor's clamp: a deck that stops keeping a plan
  // must not leave the page reading a list no control here can get back to.
  const variant: DeckVariant = shownList(row, asked) ?? "live";
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
        {row?.theoryEnabled === true && <VariantSwitch variant={variant} onPick={onPick} />}
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
          deck={deck}
          row={detail.data.deck}
          cards={detail.data.cards}
          categories={detail.data.categories}
          labels={detail.data.labels}
          variant={variant}
          marketplace={marketplace}
          onOpenCard={onOpenCard}
        />
      )}
    </>
  );
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

/**
 * One list of the deck: its figures, its piles in order, then the side rail — and, at the foot of
 * the page, what the reader can do to it: `Add cards`, `Deck settings`, and the receipt of the last
 * write with its `Undo`.
 *
 * **The writes live here, in one receipt**, because every surface this page opens — a row's action
 * sheet, the add search, the rail's notes and bracket — writes the same deck, and the reader is
 * owed one line saying what the last of them did. The line at the foot of the page goes quiet while
 * a sheet is up and the sheet draws it instead, so it is said once, where the reader is looking.
 */
function DeckColumn({
  deckId,
  deck,
  row,
  cards,
  categories,
  labels,
  variant,
  marketplace,
  onOpenCard,
}: {
  deckId: number;
  deck: DeckCore;
  row: DeckRow;
  cards: readonly DeckCard[];
  categories: readonly DeckCategory[];
  labels: readonly DeckLabel[];
  variant: DeckVariant;
  marketplace: Marketplace;
  onOpenCard: (cardId: string) => void;
}) {
  const { formatSpecFor } = useFormatSpecs();
  const spec = formatSpecFor(row.formatKey);
  const tracks = tracksCollection(row);
  const notes = useDeckNotes(deckId);
  const noted = useMemo(() => notedOracleIds(notes.notes), [notes.notes]);
  const receipt = useReceipt(deckId);
  /** The row a sheet is open on, followed to wherever a write moves it. */
  const [acting, setActing] = useState<Acting | null>(null);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);

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

  /**
   * The search's opening format — the editor's `searchFormatDefault`, character for character: the
   * deck's format only where the database can answer it, because a key with no legalities behind
   * it comes back as no rows, which reads exactly like a search that matched nothing.
   */
  const searchFormat = useMemo(
    () =>
      spec?.hasLegalityData === true ? { value: row.formatKey, label: spec.displayName } : null,
    [row.formatKey, spec],
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
            onAct={() => setActing({ slot: slotOf(card), seen: card })}
          />
        );
      }}
    />
  );

  const sheetUp = acting !== null || adding;

  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8">
        <Figures
          cards={cards}
          formatName={spec?.displayName ?? row.formatName ?? row.formatKey}
          marketplace={marketplace}
          tracks={tracks}
          separateX={row.separateXGroup}
        />

        {cards.length === 0 ? (
          <DimNote>
            {variant === "theory"
              ? "No cards in the theory list yet."
              : "No cards in this deck yet."}
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
          deck={deck}
          row={row}
          cards={cards}
          variant={variant}
          spec={spec}
          notes={notes}
          receipt={receipt}
          onOpenCard={onOpenCard}
        />
      </div>

      <ReceiptBar receipt={receipt} muted={sheetUp} className="shrink-0" />
      <ActionBar onAdd={() => setAdding(true)} onSettings={() => setSettings(true)} />

      <CardActions
        acting={acting}
        deck={deck}
        cards={cards}
        categories={categories}
        labels={labels}
        spec={spec}
        variant={variant}
        theoryEnabled={row.theoryEnabled}
        receipt={receipt}
        onMoved={setActing}
        onClose={() => setActing(null)}
      />
      <AddCards
        open={adding}
        deck={deck}
        cards={cards}
        listWord={row.theoryEnabled ? (variant === "theory" ? "Theory" : "Actual") : null}
        defaultFormat={searchFormat}
        receipt={receipt}
        onClose={() => setAdding(false)}
      />
      {/* The desktop's own Deck settings, whole — the form, its commands and its refusals — over
          the store-free deck read, so the phone asks every question the desktop does and no
          second form can come to disagree with it. */}
      <DeckSettingsDialog
        deckId={deckId}
        open={settings}
        onDismiss={() => setSettings(false)}
        onClose={() => setSettings(false)}
      />
    </>
  );
}

/**
 * The page's foot: the two things a reader does to a whole deck, where a thumb reaches — **a bar
 * rather than a floating button**, because a button floating over the column's right edge would sit
 * on every row's own `⋯`, which is the control the rows put there for the same thumb.
 */
function ActionBar({ onAdd, onSettings }: { onAdd: () => void; onSettings: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-2">
      <button
        type="button"
        onClick={onAdd}
        aria-haspopup="dialog"
        className={cn(
          "flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-md bg-accent px-4",
          "text-sm font-medium text-accent-fg",
          PRESS_SOFT,
          FOCUS,
        )}
      >
        <Plus aria-hidden className="size-4 shrink-0" />
        Add cards
      </button>
      <button
        type="button"
        onClick={onSettings}
        aria-haspopup="dialog"
        aria-label="Deck settings"
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-dim",
          PRESS_SOFT,
          FOCUS,
        )}
      >
        <Wrench aria-hidden className="size-5" />
      </button>
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
 * colour, the name, the cost and the unit price — and at its end, `⋯`, the row's actions.
 *
 * **Two presses, side by side and never nested.** The row opens the card sheet, as it always has —
 * a button, not a link, because a card opens a sheet over the page it is on (`mobile/CLAUDE.md`).
 * Named by `deckCardName`, the editor's own sentence — copies, finish, label, Game Changer, a note,
 * a shortfall and a rule break — so every mark drawn here is also said.
 *
 * **`⋯` opens the row's action sheet, and it is a visible 44px button rather than a long-press.** A
 * long-press is a gesture nothing on screen announces, that a scroll's slow start can trigger and a
 * screen reader or a keyboard cannot make at all; a button at the row's far end is under the thumb
 * of a hand holding the phone, is found by looking, and is a tab stop like any other. Its name says
 * which row it is about — the card, its finish and its pile — because one card can be two rows.
 */
function CardRow({
  card,
  name,
  ruleBreak,
  short,
  currency,
  onOpen,
  onAct,
}: {
  card: DeckCard;
  name: string;
  ruleBreak: string | null;
  short: boolean;
  currency: Marketplace["currency"];
  onOpen: (cardId: string) => void;
  onAct: () => void;
}) {
  const finish = card.finish === null ? "" : `, ${FINISH_LABEL[card.finish].toLowerCase()}`;
  return (
    <li className="flex items-stretch">
      <button
        type="button"
        aria-label={name}
        onClick={() => onOpen(card.cardId)}
        className={cn(
          "flex min-h-11 min-w-0 flex-1 items-center gap-2 pl-4 text-left",
          FOCUS_INSET,
        )}
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
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Edit ${card.name}${finish} in ${card.categoryName}`}
        onClick={onAct}
        className={cn(
          "flex w-11 shrink-0 items-center justify-center text-dim active:bg-surface",
          FOCUS_INSET,
        )}
      >
        <Ellipsis aria-hidden className="size-4" />
      </button>
    </li>
  );
}
