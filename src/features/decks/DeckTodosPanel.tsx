/**
 * The deck's to-do lists, as a band under the notes (issue #672, and #688's titled lists).
 *
 * ⚠️ **A to-do list is not a note** — the root `CLAUDE.md` says why the sentence is worth writing.
 * Since user schema v59 a deck holds several titled lists (`deck_todo_lists`), each drawn here as a
 * card in `NoteCard`'s frame. What a list shares with a note is that frame, the editor and the
 * inline dialect; it has no card attachments, no masonry drag, no Save button and no row in
 * `deck_notes`.
 *
 * ## Four placement constraints, and the two on this component's own root
 *
 * `DeckNotesPanel`'s header states all four in full. **A `<section>`, never an `<aside>`** — a
 * second complementary landmark broke five of `App.test.tsx`'s pane assertions. **`shrink-0`** —
 * the editor's root is the only box with a height, and without it this band is squeezed to
 * nothing on every deck taller than the window. The other two are the host's: **below
 * `PriceStrip`, never between it and the deck**, because the strip's remove tray reaches up into
 * the column's gap for the length of a drag; and **after `DeckNotesPanel`**, the spec's placement.
 *
 * ## Cards that tick in place, and a dialog that is written in
 *
 * A card draws its list read-only, with no editor, and its boxes tick **in place** through the
 * list's compare-and-set: `toggleTodo(body, line)` sent with `expected` = the body the card drew.
 * A list changed since — the dialog open over it in another window — refuses with the #672
 * sentence, the band refetches and says so on its alert line, and nothing is overwritten.
 *
 * `Edit`, or a press on the card outside a control, opens {@link TodoListDialog} on that list;
 * **New to-do list** opens it on nothing, and its first real change is the create. The dialog owns
 * the autosave that lived in this file until #688 — moved there intact, since the dialog is now
 * the only place a list is typed into.
 *
 * ## Two components, and the split is where the database stops
 *
 * {@link DeckTodosPanel} is the wiring — the query, the tick, the delete, and the dialogs.
 * {@link TodosBand} is everything drawn, over plain props, which is `DeckNotesPanel`'s arrangement
 * and for its reason: the workbench can stand the band up in the states that matter, including a
 * refused read that no seed produces.
 */
import { useCallback, useId, useMemo, useRef, useState, type JSX, type Ref } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { ipcError, type DeckTodoList } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { META_SUBMIT } from "./metaRows";
import { countTodos, listTitle, parseTodos, toggleTodo } from "./todoMarkdown";
import { TODO_LIST_GAP, TodoListCard } from "./TodoListCard";
import { DeleteTodoListDialog, TodoListDialog } from "./TodoListDialog";
import { useDeckTodoLists } from "./useDeckTodos";

/**
 * The area's name — the region's `aria-label`, the disclosure's visible text, and what every test
 * and story addresses both by. **Singular, where the widget's is `To-dos`.**
 */
export const TODOS_HEADING = "To-do";

/** The header's one act. */
export const NEW_LIST_LABEL = "New to-do list";

/** The empty band's sentence — it names the control that fills it. */
export const NO_LISTS = "No to-do lists yet. New to-do list starts one.";

export interface DeckTodosPanelProps {
  deckId: number;
  /** `decks.todos_open`. `DEFAULT 0`, `notes_open`'s reason. */
  open: boolean;
  /** Write the disclosure — the host sends it through the ordinary `deck_update`. */
  onToggle: (next: boolean) => void;
}

/**
 * Which list the dialog is about, and whether it is up.
 *
 * `key` is per opening, so every opening is a fresh draft in a fresh `TodoListDialog` — and the
 * record outlives the close (only `open` goes false), so the dialog keeps its list for the length
 * of the exit tween rather than redrawing as a new one while it fades.
 */
interface Editing {
  key: number;
  id: number | null;
  open: boolean;
}

/**
 * The band, wired.
 *
 * **The read runs whether or not the band is open**, `DeckNotesPanel`'s call: the header says how
 * many to-dos are open across every list, and that number is the reason to open it.
 */
export function DeckTodosPanel({ deckId, open, onToggle }: DeckTodosPanelProps): JSX.Element {
  const todos = useDeckTodoLists(deckId);
  const lists = todos.lists;

  const [editing, setEditing] = useState<Editing>({ key: 0, id: null, open: false });
  /** The list whose Delete question is up, from a card. The dialog asks its own. */
  const [confirming, setConfirming] = useState<DeckTodoList | null>(null);

  /** `New to-do list` — the one control that outlives every card, so the caret's fallback. */
  const newListRef = useRef<HTMLButtonElement>(null);
  /** The control a dialog was opened from, handed the caret back on close. `Dialog` restores
   *  nothing itself — `DialogProps.onDismiss`' own doc makes that the host's job. */
  const openerRef = useRef<HTMLElement | null>(null);

  const remember = () => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  /** Focus first, then close — at this instant the opener is still mounted, and a card deleted
   *  under it may not be, so `New to-do list` is the fallback. */
  const giveBack = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener !== null && opener.isConnected) opener.focus();
    else newListRef.current?.focus();
  }, []);

  const openDialog = (id: number | null) => {
    remember();
    setEditing((was) => ({ key: was.key + 1, id, open: true }));
  };

  const closeDialog = useCallback(() => {
    giveBack();
    setEditing((was) => ({ ...was, open: false }));
  }, [giveBack]);

  /** Every to-do at every depth across every list — `null` until the read lands, because a count
   *  under a refused read would be a number the app does not have. */
  const counts = useMemo(() => {
    if (lists === undefined) return null;
    let open = 0;
    let done = 0;
    for (const list of lists) {
      const c = countTodos(parseTodos(list.body));
      open += c.open;
      done += c.done;
    }
    return { open, done };
  }, [lists]);

  /** In `sortOrder`, then id — the order Rust answers in, restated so the drawing never depends on
   *  a cache write having appended in the right place. */
  const ordered = useMemo(
    () =>
      lists === undefined
        ? null
        : [...lists].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [lists],
  );

  /** The list a tick is out on, whose every box is refused until it answers. */
  const ticking = todos.tick.isPending ? (todos.tick.variables?.id ?? null) : null;

  /**
   * One line for the band: the newest write's refusal outranks the read's, `sectionFailure`'s
   * rule. A refused tick — `TODOS_CHANGED` above all — is what the reader was just doing.
   */
  const failure = todos.tick.isError
    ? ipcError(todos.tick.error)
    : todos.remove.isError
      ? ipcError(todos.remove.error)
      : todos.failure;

  return (
    <>
      <TodosBand
        open={open}
        onToggle={onToggle}
        counts={counts}
        failure={failure}
        lists={ordered}
        ticking={ticking}
        newListRef={newListRef}
        onNewList={() => {
          // **The press opens the band**, the notes band's `New note` argument: the list the
          // reader asked for must land somewhere they can see.
          if (!open) onToggle(true);
          openDialog(null);
        }}
        onTick={(list, line) => {
          const next = toggleTodo(list.body, line);
          if (next === null || ticking !== null) return;
          todos.tick.mutate({ id: list.id, body: next, expected: list.body });
        }}
        onEdit={(list) => openDialog(list.id)}
        onDelete={(list) => {
          remember();
          setConfirming(list);
        }}
      />

      <TodoListDialog
        key={editing.key}
        deckId={deckId}
        open={editing.open}
        listId={editing.id}
        onClose={closeDialog}
        onDelete={(id) => {
          // The dialog's opener is this list's own card, which goes with it — dropped before the
          // dialog's close hands the caret back, so it lands on `New to-do list`.
          openerRef.current = null;
          todos.remove.mutate(id);
        }}
      />

      <DeleteTodoListDialog
        open={confirming !== null}
        title={confirming === null ? "" : listTitle(confirming.title)}
        pending={todos.remove.isPending}
        onDelete={() => {
          if (confirming === null) return;
          // The opener is this list's own Delete, which goes with the card — dropped so the caret
          // lands on `New to-do list` rather than on a node about to be removed.
          openerRef.current = null;
          todos.remove.mutate(confirming.id);
          giveBack();
          setConfirming(null);
        }}
        onClose={() => {
          giveBack();
          setConfirming(null);
        }}
      />
    </>
  );
}

export interface TodosBandProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  /** Every to-do at every depth across every list, split by state — or `null` before there is an
   *  answer to count. `{ open: 0, done: 0 }` draws no figure either. */
  counts: { open: number; done: number } | null;
  /** `New to-do list` — open the band if it is shut, and the dialog on a list not made yet. */
  onNewList: () => void;
  /** The band's one refusal line, or `null`. */
  failure: string | null;
  /** The deck's lists in `sortOrder`, or `null` until the read lands (or when it was refused). */
  lists: DeckTodoList[] | null;
  /** The id of the list a tick is out on, or `null`. */
  ticking: number | null;
  onTick: (list: DeckTodoList, line: number) => void;
  onEdit: (list: DeckTodoList) => void;
  onDelete: (list: DeckTodoList) => void;
  /** So the host can hand the caret back to `New to-do list` — the one control that outlives
   *  every card. */
  newListRef?: Ref<HTMLButtonElement>;
}

/**
 * Everything the band draws, over plain props — the half of this file with no database behind it.
 *
 * The header is `DeckNotesPanel`'s, character for character where it can be: the rule and the
 * padding, the disclosure with its rotating chevron, a mono figure beside it, and the one act at
 * the far end of the row in `META_SUBMIT`'s recipe.
 */
export function TodosBand({
  open,
  onToggle,
  counts,
  onNewList,
  failure,
  lists,
  ticking,
  onTick,
  onEdit,
  onDelete,
  newListRef,
}: TodosBandProps): JSX.Element {
  const bodyId = useId();

  return (
    <section aria-label={TODOS_HEADING} className="shrink-0 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(!open)}
          className={cn("flex items-center gap-1.5 rounded-md text-sm text-text", PRESS, FOCUS)}
        >
          {/* One glyph rotated, never two swapped — every band on this page turns its chevron. */}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {TODOS_HEADING}
        </button>

        {/* Summed over every list. Its own element, so nothing computes it into the disclosure's
            name; nothing at all for a deck with no to-do, where `0 open · 0 done` would say the
            band is empty twice. One string, so it reads as one figure. */}
        {counts !== null && counts.open + counts.done > 0 && (
          <span className="font-mono text-xs tabular-nums text-dim">
            {`${counts.open} open · ${counts.done} done`}
          </span>
        )}

        {/* Outside the collapsible region, so it is offered whether the band is open or shut. */}
        <button
          ref={newListRef}
          type="button"
          onClick={onNewList}
          className={cn("ml-auto inline-flex items-center gap-1.5", META_SUBMIT)}
        >
          <Plus aria-hidden="true" className="size-3.5 shrink-0" />
          {NEW_LIST_LABEL}
        </button>
      </div>

      {/* Outside the collapsible region: a refusal while the band is shut still owes the reader a
          sentence. */}
      {failure !== null && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {failure}
        </p>
      )}

      {/* `select-text` because a to-do is written to be read — the editor's root refuses text
          selection (issue #473), and a list a reader cannot copy a line out of is one they
          retype. */}
      <div id={bodyId} className="select-text">
        {open && (
          <div className="mt-3">
            {lists !== null && lists.length > 0 ? (
              /* **A masonry at most two tracks wide.** `max(17.5rem, 50% − half a gutter)` is a
                 track no narrower than a card can read at and no narrower than half the band —
                 so two fit on a wide band and one on a narrow one, and CSS counts them with no
                 measurement of the band. The rows are one pixel and each card spans its own
                 height, `NoteCard`'s arrangement, so a short list does not stand in a tall one's
                 shadow; `items-start` is what keeps that measurement from feeding back. */
              <ul
                aria-label="To-do lists"
                className="grid items-start"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(max(17.5rem, calc(50% - ${TODO_LIST_GAP / 2}px)), 1fr))`,
                  gridAutoRows: "1px",
                  columnGap: TODO_LIST_GAP,
                  rowGap: 0,
                }}
              >
                {lists.map((list) => (
                  <TodoListCard
                    key={list.id}
                    list={list}
                    ticking={ticking === list.id}
                    onTick={(line) => onTick(list, line)}
                    onEdit={() => onEdit(list)}
                    onDelete={() => onDelete(list)}
                  />
                ))}
              </ul>
            ) : lists !== null ? (
              <p className="text-xs text-dim">{NO_LISTS}</p>
            ) : failure === null ? (
              <p className="text-xs text-dim">Loading to-do lists…</p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
