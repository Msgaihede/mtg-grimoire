import { useId, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { BracketAdvisory, useBracketReading } from "@/features/decks/DeckBracket";
import { deckStats } from "@/features/decks/DeckStats";
import {
  isHandAdded,
  NOT_MADE_BY_DECK,
  tokenCardName,
  type DeckTokenView,
} from "@/features/decks/deckTokens";
import { noteTitle } from "@/features/decks/deckNotes";
import { NoteBody } from "@/features/decks/noteBody";
import { ManaCurveChart } from "@/features/decks/stats/ManaCurveChart";
import { TodoBody } from "@/features/decks/todoBody";
import { listTitle, parseTodoBody } from "@/features/decks/todoMarkdown";
import type { DeckNotes } from "@/features/decks/useDeckNotes";
import { useDeckTodoLists } from "@/features/decks/useDeckTodos";
import { useDeckTokens } from "@/features/decks/useDeckTokens";
import { bracketWarning } from "@/features/decks/validation/bracket";
import { validateDeck } from "@/features/decks/validation/engine";
import { ValidationFindings } from "@/features/decks/ValidationPanel";
import { plural } from "@/lib/counts";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import {
  AUTO_BRACKET,
  type DeckCard,
  type DeckNote,
  type DeckRow,
  type DeckTodoList,
  type DeckVariant,
  type FormatSpec,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * The side rail, **last** — the owner's order for 360px, and inside it the desktop's own order
 * down the page: the check and the bracket (the editor's two chips on the ledger), then the bands
 * under the desk — tokens, the curve, deck notes, deck to-do lists. Every one of them is the
 * desktop's own reading drawn inline as a section, because a phone has no ledger to hang a
 * popover from and no width for bands side by side.
 *
 * **Read-only.** No picker, no stepper, no tick, no edit: step 3.5 adds the writes. Where the
 * desktop draws a control that writes, this draws the answer in words.
 */
export function DeckRail({
  deckId,
  row,
  cards,
  variant,
  spec,
  notes,
  onOpenCard,
}: {
  deckId: number;
  row: DeckRow;
  cards: readonly DeckCard[];
  variant: DeckVariant;
  spec: FormatSpec | null;
  notes: DeckNotes;
  onOpenCard: (cardId: string) => void;
}) {
  return (
    <div aria-label="Deck details" role="group" className="mt-2">
      {/* Nothing at all while the seeded rules are not in hand, the editor's rule: a format the
          seed no longer carries has no rules to judge against, and "No issues" because nothing
          was checked is the one sentence the check must never write. */}
      {spec !== null && <CheckSection cards={cards} spec={spec} onOpenCard={onOpenCard} />}
      {/* Only where the format has a command zone, the editor's fence: a bracket is the Commander
          conversation, and the reading is a pass over every card plus a combo read a Standard
          deck must not pay for. Its own component so the hook mounts only then. */}
      {spec?.commanderRule != null && <BracketSection cards={cards} bracket={row.bracket} />}
      <TokensSection deckId={deckId} variant={variant} onOpenCard={onOpenCard} />
      <CurveSection cards={cards} row={row} />
      <NotesSection notes={notes} onOpenCard={onOpenCard} />
      <TodosSection deckId={deckId} />
    </div>
  );
}

/** One section of the rail: a heading that says what it is, a dim line that says what it holds,
 *  and its body. A real heading, so a screen reader can walk the rail by them. */
function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-b border-border px-4 py-3">
      <div className="mb-2 flex min-w-0 items-baseline gap-2">
        <h3 id={id} className="text-[0.8125rem] font-medium">
          {title}
        </h3>
        {summary !== undefined && (
          <>
            {" "}
            <span className="min-w-0 truncate text-[0.6875rem] text-dim">{summary}</span>
          </>
        )}
      </div>
      {children}
    </section>
  );
}

/** The format check — `validateDeck`, which counts the deck (not every card drawn), and the
 *  findings the editor's chip opens, drawn in place. A card's name in a finding opens it. */
function CheckSection({
  cards,
  spec,
  onOpenCard,
}: {
  cards: readonly DeckCard[];
  spec: FormatSpec;
  onOpenCard: (cardId: string) => void;
}) {
  const issues = useMemo(() => validateDeck([...cards], spec), [cards, spec]);
  return (
    <Section
      title="Check"
      summary={
        <span className="inline-flex items-center gap-1">
          {issues.length === 0 ? (
            <CircleCheck aria-hidden className="size-3 shrink-0 text-ok" />
          ) : (
            <TriangleAlert aria-hidden className="size-3 shrink-0 text-destructive" />
          )}
          {issues.length === 0 ? "No issues" : plural(issues.length, "issue")} · {spec.displayName}
        </span>
      }
    >
      <div className="select-text text-xs">
        <ValidationFindings issues={issues} cards={cards} spec={spec} onSelectCard={onOpenCard} />
      </div>
    </Section>
  );
}

/** The bracket reading — the editor's advisory, inline, with the deck's own answer said in words
 *  where the editor draws its picker. The four combo states are the advisory's, unchanged. */
function BracketSection({ cards, bracket }: { cards: readonly DeckCard[]; bracket: number }) {
  const { estimate, comboState } = useBracketReading(cards);
  const set = bracket !== AUTO_BRACKET;
  const warning = set ? bracketWarning(bracket, estimate) : null;
  return (
    <Section
      title="Bracket"
      // The button's own words: `~` is a reading, a bare number is the reader's answer, and a
      // mismatch shows both.
      summary={`${set ? bracket : `~${estimate.floor}`}${warning !== null ? ` · reads ~${estimate.floor}` : ""}`}
    >
      <div className="select-text text-xs">
        <BracketAdvisory
          estimate={estimate}
          bracket={bracket}
          warning={warning}
          comboState={comboState}
        />
      </div>
    </Section>
  );
}

/**
 * The tokens and emblems this list makes or keeps — the editor's band as rows, drawn only where
 * there is one, as the band's wall is. A row opens the entry's printing in the card sheet.
 */
function TokensSection({
  deckId,
  variant,
  onOpenCard,
}: {
  deckId: number;
  variant: DeckVariant;
  onOpenCard: (cardId: string) => void;
}) {
  const { tokens, query } = useDeckTokens(deckId, variant);
  if (query.isLoadingError) {
    return (
      <Section title="Tokens">
        <p role="alert" className="text-xs text-destructive">
          This deck&rsquo;s tokens could not be read.
        </p>
      </Section>
    );
  }
  if (tokens.length === 0) return null;
  return (
    <Section title="Tokens" summary={plural(tokens.length, "entry", "entries")}>
      <ul className="-mx-4">
        {tokens.map((view) => (
          <TokenRow key={view.entryKey} view={view} onOpen={onOpenCard} />
        ))}
      </ul>
    </Section>
  );
}

function TokenRow({ view, onOpen }: { view: DeckTokenView; onOpen: (cardId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        aria-label={tokenCardName(view)}
        onClick={() => onOpen(view.printingId)}
        className={cn("flex min-h-11 w-full items-center gap-2 px-4 py-1 text-left", FOCUS_INSET)}
      >
        <span aria-hidden className="w-6 shrink-0 font-mono text-xs tabular-nums text-dim">
          {view.quantity}
        </span>
        <span aria-hidden className="min-w-0 flex-1">
          <span className="block truncate text-sm">{view.name}</span>
          {(view.subtitle !== null || isHandAdded(view)) && (
            <span className="block truncate text-[0.6875rem] text-dim">
              {isHandAdded(view) ? NOT_MADE_BY_DECK.toLowerCase() : view.subtitle}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * The mana curve — the stats band's first chart, over the same `deckStats`. The creature split is
 * a way of looking at it, so it starts where the deck left it and is the reader's to flip here
 * without being written back (the band writes it; this page writes nothing).
 */
function CurveSection({ cards, row }: { cards: readonly DeckCard[]; row: DeckRow }) {
  const stats = useMemo(() => deckStats(cards, row.separateXGroup), [cards, row.separateXGroup]);
  const [split, setSplit] = useState(row.curveCreatures);
  if (stats.nonlands === 0) return null;
  // No section heading of its own: the chart draws its title and its average itself, and a
  // heading over it would say "Mana curve" twice.
  return (
    <div className="border-b border-border px-4 py-3">
      <ManaCurveChart stats={stats} split={split} onSplitChange={setSplit} />
    </div>
  );
}

/**
 * The deck's notes — what the reader wrote about this deck, each with the cards it names. ⚠️ A
 * **deck note**, not a sticky note and not an entry note. Read-only: the title, the body in the
 * notes' own dialect and renderer, and each named card a press that opens it.
 */
function NotesSection({
  notes,
  onOpenCard,
}: {
  notes: DeckNotes;
  onOpenCard: (cardId: string) => void;
}) {
  if (notes.query.isLoadingError) {
    return (
      <Section title="Notes">
        <p role="alert" className="text-xs text-destructive">
          This deck&rsquo;s notes could not be read.
        </p>
      </Section>
    );
  }
  if (notes.notes.length === 0) return null;
  return (
    <Section title="Notes" summary={plural(notes.notes.length, "note")}>
      <ul className="space-y-2">
        {notes.notes.map((note) => (
          <NoteItem key={note.id} note={note} onOpenCard={onOpenCard} />
        ))}
      </ul>
    </Section>
  );
}

function NoteItem({ note, onOpenCard }: { note: DeckNote; onOpenCard: (cardId: string) => void }) {
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <p className="mb-1 text-[0.8125rem] font-medium">{noteTitle(note)}</p>
      <div className="select-text">
        <NoteBody body={note.body} empty="No content yet." />
      </div>
      {note.cards.length > 0 && (
        <ul
          aria-label={`Cards named in ${noteTitle(note)}`}
          className="mt-2 flex flex-wrap gap-1.5"
        >
          {note.cards.map((card) => (
            <li key={card.oracleId}>
              {card.cardId === null ? (
                // A card the corpus no longer has a printing of has nothing for a sheet to show.
                <span className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs text-dim">
                  {card.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenCard(card.cardId as string)}
                  className={cn(
                    "inline-flex h-8 items-center rounded-md border border-border px-2 text-xs",
                    FOCUS,
                  )}
                >
                  {card.name}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The deck's to-do lists. ⚠️ **Not notes**: they share a title-and-body shape and the notes'
 * inline dialect, and nothing else — no cards, no history. Read-only: each box is a picture of
 * its state with the state said in words.
 */
function TodosSection({ deckId }: { deckId: number }) {
  const { lists, failure } = useDeckTodoLists(deckId);
  if (failure !== null) {
    return (
      <Section title="To-do lists">
        <p role="alert" className="text-xs text-destructive">
          This deck&rsquo;s to-do lists could not be read.
        </p>
      </Section>
    );
  }
  if (lists === undefined || lists.length === 0) return null;
  return (
    <Section title="To-do lists" summary={plural(lists.length, "list")}>
      <ul className="space-y-2">
        {lists.map((list) => (
          <TodoListItem key={list.id} list={list} />
        ))}
      </ul>
    </Section>
  );
}

function TodoListItem({ list }: { list: DeckTodoList }) {
  const blocks = useMemo(() => parseTodoBody(list.body), [list.body]);
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <p className="mb-1 text-[0.8125rem] font-medium">{listTitle(list.title)}</p>
      <TodoBody blocks={blocks} body={list.body} />
    </li>
  );
}
