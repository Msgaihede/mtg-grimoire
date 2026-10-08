import { useId, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, Plus, TriangleAlert } from "lucide-react";
import { BracketAdvisory, useBracketReading } from "@/features/decks/DeckBracket";
import { deckStats } from "@/features/decks/DeckStats";
import {
  isHandAdded,
  NOT_MADE_BY_DECK,
  tokenCardName,
  type DeckTokenView,
} from "@/features/decks/deckTokens";
import { noteTitle } from "@/features/decks/deckNotes";
import { DeleteNoteDialog } from "@/features/decks/DeleteNoteDialog";
import { NoteBody } from "@/features/decks/noteBody";
import { NoteEditorDialog, type NoteDraft } from "@/features/decks/NoteEditorDialog";
import { ManaCurveChart } from "@/features/decks/stats/ManaCurveChart";
import { TodoBody } from "@/features/decks/todoBody";
import { DeleteTodoListDialog, TodoListDialog } from "@/features/decks/TodoListDialog";
import { listTitle, parseTodoBody, toggleTodo } from "@/features/decks/todoMarkdown";
import type { DeckCore } from "@/features/decks/useDeckCore";
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
  ipcError,
  type DeckCard,
  type DeckNote,
  type DeckRow,
  type DeckTodoList,
  type DeckVariant,
  type FormatSpec,
} from "@/lib/ipc";
import { PRESS_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { Receipt } from "../deck/receipt";

/**
 * The side rail, **last** — the owner's order for 360px, and inside it the desktop's own order
 * down the page: the check and the bracket (the editor's two chips on the ledger), then the bands
 * under the desk — tokens, the curve, deck notes, deck to-do lists. Every one of them is the
 * desktop's own reading drawn inline as a section, because a phone has no ledger to hang a
 * popover from and no width for bands side by side.
 *
 * **What it writes is the desktop's, through the desktop's own dialogs** (step 3.5a): the bracket
 * through the advisory's own picker, a deck note through `NoteEditorDialog` — the one editor, Save
 * and all, so its history is the desktop's — and a deck to-do list through `TodoListDialog` and its
 * autosave, with a box ticked in place by the card's own compare-and-set. The tokens and the curve
 * are read-only here: the band's writes are the editor's, and the curve's split is a way of
 * looking.
 */
export function DeckRail({
  deckId,
  deck,
  row,
  cards,
  variant,
  spec,
  notes,
  receipt,
  onOpenCard,
}: {
  deckId: number;
  deck: DeckCore;
  row: DeckRow;
  cards: readonly DeckCard[];
  variant: DeckVariant;
  spec: FormatSpec | null;
  notes: DeckNotes;
  receipt: Receipt;
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
      {spec?.commanderRule != null && (
        <BracketSection
          cards={cards}
          bracket={row.bracket}
          onBracket={(bracket) =>
            receipt.track(deck.update.mutateAsync({ bracket }), () =>
              bracket === AUTO_BRACKET
                ? "The bracket is read from the cards again."
                : `Set the bracket to ${bracket}.`,
            )
          }
        />
      )}
      <TokensSection deckId={deckId} variant={variant} onOpenCard={onOpenCard} />
      <CurveSection cards={cards} row={row} />
      <NotesSection notes={notes} receipt={receipt} onOpenCard={onOpenCard} />
      <TodosSection deckId={deckId} />
    </div>
  );
}

/** One section of the rail: a heading that says what it is, a dim line that says what it holds,
 *  and its body. A real heading, so a screen reader can walk the rail by them. */
function Section({
  title,
  summary,
  action,
  children,
}: {
  title: string;
  summary?: ReactNode;
  /** The section's one act, at the far end of its heading row — `New note`, `New list`. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-b border-border px-4 py-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
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
        {action}
      </div>
      {children}
    </section>
  );
}

/** A section's act — `New note` — at the touch floor, in the accent the app's "make one" wears. */
function SectionAct({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-haspopup="dialog"
      className={cn(
        "-my-2 -mr-2 flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-accent",
        PRESS_SOFT,
        FOCUS,
      )}
    >
      <Plus aria-hidden className="size-4" />
      {label}
    </button>
  );
}

/** `Edit` / `Delete` on a note or a list — a pair of 44px presses at the item's foot. */
function ItemActs({
  name,
  onEdit,
  onDelete,
}: {
  /** What the item is called, so the two presses are told apart from every other item's. */
  name: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const act = cn(
    "flex h-11 items-center rounded-md px-3 text-xs text-dim active:bg-bg",
    PRESS_SOFT,
    FOCUS,
  );
  return (
    <div className="-mx-3 -mb-2.5 mt-1 flex justify-end border-t border-border px-1">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Edit ${name}`}
        onClick={onEdit}
        className={act}
      >
        Edit
      </button>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
        className={cn(act, "text-destructive")}
      >
        Delete
      </button>
    </div>
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

/** The bracket reading — the editor's advisory, inline, **with its own picker**: the reader's
 *  answer is a deck write (`deck.update`, a history row and an undo step, as on the desktop). The
 *  four combo states are the advisory's, unchanged. */
function BracketSection({
  cards,
  bracket,
  onBracket,
}: {
  cards: readonly DeckCard[];
  bracket: number;
  onBracket: (bracket: number) => void;
}) {
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
      {/* The picker's rungs at a finger's size: the desktop draws them for a pointer, and the floor
          is set from here rather than by a phone branch in the advisory — the filters sheet's
          `TOUCH_FLOOR` arrangement. */}
      <div className="select-text text-xs [&_[role=radio]]:min-h-11 [&_[role=radio]]:min-w-11">
        <BracketAdvisory
          estimate={estimate}
          bracket={bracket}
          warning={warning}
          comboState={comboState}
          onBracket={onBracket}
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
 * **deck note**, not a sticky note and not an entry note.
 *
 * **Written through the desktop's own dialogs**: `New note` and `Edit` open `NoteEditorDialog` —
 * the one door to the editor, lazy, Save and all — and the host's half of the save is the band's
 * (`DeckNotesPanel`), argument for argument: a create sends an empty title and the body, an edit
 * sends the note's own title back unchanged with the new body. So a note saved here is the same
 * write, the same history row and the same undo step as one saved on the desktop. `Delete` asks
 * first, in the band's own words (`DeleteNoteDialog`).
 *
 * **Attaching cards is not here yet** — `NoteCardsDialog` is a desktop picker; a note written here
 * names no card until the desktop attaches one, and the cards a note already names are drawn and
 * open the card sheet.
 */
function NotesSection({
  notes,
  receipt,
  onOpenCard,
}: {
  notes: DeckNotes;
  receipt: Receipt;
  onOpenCard: (cardId: string) => void;
}) {
  /** Which dialog is up: the editor on a draft, the delete question on a note, or neither. */
  const [panel, setPanel] = useState<
    { kind: "edit"; draft: NoteDraft } | { kind: "delete"; note: DeckNote } | null
  >(null);
  // The note as the deck now holds it, so a dialog never edits a body a refetch has replaced.
  const live = (id: number) => notes.notes.find((note) => note.id === id) ?? null;
  const editing = panel?.kind === "edit" ? panel.draft : null;
  const deleting = panel?.kind === "delete" ? live(panel.note.id) : null;
  const close = () => setPanel(null);

  const body = notes.query.isLoadingError ? (
    <p role="alert" className="text-xs text-destructive">
      This deck&rsquo;s notes could not be read.
    </p>
  ) : notes.notes.length === 0 ? (
    notes.query.isSuccess ? (
      <p className="text-xs text-dim">No notes yet.</p>
    ) : null
  ) : (
    <ul className="space-y-2">
      {notes.notes.map((note) => (
        <NoteItem
          key={note.id}
          note={note}
          onOpenCard={onOpenCard}
          onEdit={() => setPanel({ kind: "edit", draft: { kind: "edit", note } })}
          onDelete={() => setPanel({ kind: "delete", note })}
        />
      ))}
    </ul>
  );

  return (
    <Section
      title="Notes"
      summary={notes.notes.length > 0 ? plural(notes.notes.length, "note") : undefined}
      action={
        <SectionAct
          label="New note"
          onPress={() => setPanel({ kind: "edit", draft: { kind: "new" } })}
        />
      }
    >
      {body}
      <NoteEditorDialog
        open={editing !== null}
        draft={editing ?? { kind: "new" }}
        pending={notes.pending}
        onSave={(text) => {
          if (editing?.kind === "edit") {
            const note = live(editing.note.id) ?? editing.note;
            // ⚠️ The note's own title goes back unchanged — `deck_note_update` takes both columns,
            // and this dialog edits the body only. The band's rule, for the band's reason.
            receipt.track(
              notes.update.mutateAsync({ id: note.id, patch: { title: note.title, body: text } }),
              () => "Saved the note.",
            );
          } else {
            receipt.track(
              notes.create.mutateAsync({ title: "", body: text, oracleIds: [] }),
              () => "Saved a new note.",
            );
          }
          close();
        }}
        onClose={close}
      />
      <DeleteNoteDialog
        open={deleting !== null}
        title={deleting === null ? null : noteTitle(deleting)}
        cardCount={deleting?.cards.length ?? 0}
        pending={notes.pending}
        onDelete={() => {
          if (deleting !== null) {
            receipt.track(notes.remove.mutateAsync(deleting.id), () => "Deleted the note.");
          }
          close();
        }}
        onClose={close}
      />
    </Section>
  );
}

function NoteItem({
  note,
  onOpenCard,
  onEdit,
  onDelete,
}: {
  note: DeckNote;
  onOpenCard: (cardId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-lg border border-border bg-surface px-3 pt-2.5 pb-2.5">
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
      <ItemActs name={noteTitle(note)} onEdit={onEdit} onDelete={onDelete} />
    </li>
  );
}

/**
 * The deck's to-do lists. ⚠️ **Not notes**: they share a title-and-body shape and the notes'
 * inline dialect, and nothing else — no cards, no Save, no history and no undo step.
 *
 * **The desktop band's writes, through its own pieces**: a box ticks in place with the card's
 * compare-and-set (`toggleTodo` sent with the body the card drew as `expected`, so a list that moved
 * since is refused rather than having another line flipped), with a finger's press area round each
 * box (`TodoBody`'s `touch`); `New list` and `Edit` open `TodoListDialog`, whose autosave is the
 * desktop's; `Delete` asks first (`DeleteTodoListDialog`), because nothing can bring a list back.
 */
function TodosSection({ deckId }: { deckId: number }) {
  const todos = useDeckTodoLists(deckId);
  const { lists, failure } = todos;
  /** The dialog: `null` shut, `{ id: null }` a list not made yet, an id an existing one. */
  const [editing, setEditing] = useState<{ id: number | null; key: number } | null>(null);
  const [confirming, setConfirming] = useState<DeckTodoList | null>(null);
  const ticking = todos.tick.isPending ? (todos.tick.variables?.id ?? null) : null;
  // The newest write's refusal outranks the read's — the band's `failure` rule — and says the
  // command's own words; a refused read says what could not be read.
  const refusal = todos.tick.isError
    ? ipcError(todos.tick.error)
    : todos.remove.isError
      ? ipcError(todos.remove.error)
      : failure !== null
        ? "This deck\u2019s to-do lists could not be read."
        : null;
  // A key per opening, so every press of `New list` is a fresh dialog with no id of its own yet.
  const open = (id: number | null) => setEditing((now) => ({ id, key: (now?.key ?? 0) + 1 }));

  return (
    <Section
      title="To-do lists"
      summary={lists !== undefined && lists.length > 0 ? plural(lists.length, "list") : undefined}
      action={<SectionAct label="New list" onPress={() => open(null)} />}
    >
      {refusal !== null && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {refusal}
        </p>
      )}
      {lists !== undefined &&
        (lists.length === 0 ? (
          <p className="text-xs text-dim">No to-do lists yet.</p>
        ) : (
          <ul className="space-y-2">
            {lists.map((list) => (
              <TodoListItem
                key={list.id}
                list={list}
                ticking={ticking === list.id}
                onTick={(line) => {
                  const next = toggleTodo(list.body, line);
                  if (next === null || ticking !== null) return;
                  todos.tick.mutate({ id: list.id, body: next, expected: list.body });
                }}
                onEdit={() => open(list.id)}
                onDelete={() => setConfirming(list)}
              />
            ))}
          </ul>
        ))}
      <TodoListDialog
        key={editing?.key ?? 0}
        deckId={deckId}
        open={editing !== null}
        listId={editing?.id ?? null}
        onClose={() => setEditing(null)}
        onDelete={(id) => todos.remove.mutate(id)}
      />
      <DeleteTodoListDialog
        open={confirming !== null}
        title={confirming === null ? "" : listTitle(confirming.title)}
        pending={todos.remove.isPending}
        onDelete={() => {
          if (confirming !== null) todos.remove.mutate(confirming.id);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </Section>
  );
}

function TodoListItem({
  list,
  ticking,
  onTick,
  onEdit,
  onDelete,
}: {
  list: DeckTodoList;
  ticking: boolean;
  onTick: (line: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const blocks = useMemo(() => parseTodoBody(list.body), [list.body]);
  return (
    <li className="rounded-lg border border-border bg-surface px-3 pt-2.5 pb-2.5">
      <p className="mb-1 text-[0.8125rem] font-medium">{listTitle(list.title)}</p>
      <TodoBody blocks={blocks} body={list.body} ticking={ticking} onTick={onTick} touch />
      <ItemActs name={listTitle(list.title)} onEdit={onEdit} onDelete={onDelete} />
    </li>
  );
}
