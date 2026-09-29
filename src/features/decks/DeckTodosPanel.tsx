/**
 * The deck's to-do list, as a band under the notes (issue #672).
 *
 * ⚠️ **A to-do list is not a note** — the spec's §2 has the table. A deck has exactly one list,
 * stored whole in `decks.todos`, where a deck note is a row of `deck_notes`, many to a deck. This
 * band borrows the notes band's *header* and the notes' *editor* and nothing else: there is no
 * card here, no dialog, no masonry, and no Save. The list is edited in place and saved as it is
 * typed.
 *
 * ## Four placement constraints, and the two on this component's own root
 *
 * `DeckNotesPanel`'s header states all four in full. **A `<section>`, never an `<aside>`** — a
 * second complementary landmark broke five of `App.test.tsx`'s pane assertions. **`shrink-0`** —
 * the editor's root is the only box with a height, and without it this band is squeezed to
 * nothing on every deck taller than the window. The other two are the host's: **below
 * `PriceStrip`, never between it and the deck**, because the strip's remove tray reaches up into
 * the column's gap for the length of a drag; and **after `DeckNotesPanel`**, which is the spec's
 * placement — the list of things to do about a deck sits under what the reader wrote about it.
 *
 * ## The editor is the list, and it is saved as it is typed
 *
 * The open body is `NoteEditor` in **checklist mode** — one task list, every line a to-do, Tab to
 * nest — reached through `React.lazy`, so Tiptap's 141.5 kB gzip is fetched the first time a
 * reader opens this band and never for a deck whose band stays shut. `DeckNotesPanel.test.tsx`
 * sweeps all of `src/` for a static import of that module; this file's `lazy()` is the only
 * spelling it may take, and that includes type imports.
 *
 * **Autosave is `StickyNoteDialog`'s mechanism and its constant**: a 600 ms timer rescheduled on
 * every change, written early when the caret leaves the editor, and written on unmount. The flush
 * is what makes the delay safe — without it the last phrase before a reader closes the deck is
 * exactly the one lost.
 *
 * ## Two components, and the split is where the database stops
 *
 * {@link DeckTodosPanel} is the wiring — the query, the write, the draft and the rule for taking a
 * list changed elsewhere. {@link TodosBand} is everything drawn, over plain props, which is
 * `DeckNotesPanel`'s arrangement and for its reason: the workbench can stand the band up in the
 * states that matter, including a refused read that no seed produces.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from "react";
import { ChevronRight, Plus } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { ipcError } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { META_SUBMIT } from "./metaRows";
import { countTodos, parseTodos, sameTodos, todosText } from "./todoMarkdown";
import { useDeckTodos } from "./useDeckTodos";

/**
 * The rich-text editor, **reached by a dynamic import and by nothing else**.
 *
 * A static `import … from "./NoteEditor"` anywhere on this path puts 141.5 kB back in the main
 * chunk and nothing goes red but the sweep in `DeckNotesPanel.test.tsx` — which counts a type-only
 * import as a hit too, on purpose. So the props checklist mode takes are named at the call site
 * below and nowhere else in this file.
 */
const NoteEditor = lazy(() => import("./NoteEditor"));

/**
 * The area's name — the region's `aria-label`, the disclosure's visible text, and what every test
 * and story addresses both by.
 *
 * **Singular, where the widget's is `To-dos`**: this is *the deck's* to-do list, one to a deck,
 * and the widget is every deck's to-dos gathered — the spec's §7 spells the pair.
 */
export const TODOS_HEADING = "To-do";

/** What the writing surface is called — distinct from {@link TODOS_HEADING}, so a keyboard reader
 *  hears the region and the box inside it as two things. */
const TODO_EDITOR_LABEL = "To-do list";

/**
 * How long the band waits after the last change before writing — `StickyNoteDialog`'s number and
 * its argument: one write per phrase rather than per letter, and the flushes on blur and unmount
 * are what make the list lose nothing at any delay. Not a `motion.ts` tier; nothing animates.
 */
const SAVE_DELAY_MS = 600;

export interface DeckTodosPanelProps {
  deckId: number;
  /** `decks.todos_open`. `DEFAULT 0`, `notes_open`'s reason: the band is new, so a shut default
   *  takes nothing from anybody. */
  open: boolean;
  /** Write the disclosure — the host sends it through the ordinary `deck_update`. */
  onToggle: (next: boolean) => void;
}

/**
 * The band, wired.
 *
 * **The read runs whether or not the band is open**, which is `DeckNotesPanel`'s call: the header
 * says how many to-dos are open, and that number is the reason to open it.
 *
 * ## Taking a list changed elsewhere
 *
 * The query refetches when the widget ticks an item, when another window writes, and after any
 * deck write at all (it sits under `["decks"]`). **The editor takes a new body only when nobody is
 * in it and nothing typed is unsaved** — otherwise the reader's typing wins and the next autosave
 * overwrites what arrived. That is the one-document cost of spec §4 at its sharpest, and the
 * direction is deliberate: a tick lost from the widget is recoverable at a glance, a sentence lost
 * mid-type is not.
 *
 * ⚠️ **Every piece of that is decided during render or in an event, never in an effect**, which is
 * a rule of this repo: `react-hooks/set-state-in-effect` refuses a `setState` in an effect body,
 * and only `npm run verify` goes red on it. `focused` and `pending` are state set by the editor's
 * own events; the adoption is React's *adjusting state when a prop changes*.
 */
export function DeckTodosPanel({ deckId, open, onToggle }: DeckTodosPanelProps): JSX.Element {
  const todos = useDeckTodos(deckId);
  const stored = todos.body;
  const saving = todos.save.isPending;

  /**
   * The stored body the editor is known to agree with — `undefined` until the first read lands,
   * which is also what gates the editor: **a refused first read mounts nothing**, because an
   * editor over a body nobody read is an empty checklist whose first keystroke would autosave it
   * over whatever the deck really holds.
   *
   * It moves three ways and only three. The adoption below sets it to a body that arrived; a flush
   * sets it to the text it sent, so the band's own answer coming back reads as *already agreed*
   * rather than as a body from elsewhere to remount over — or, when it sent nothing, to the body
   * the draft was found to say the same thing as ({@link write}); and a refused write puts it
   * back to what the store still holds ({@link owed}), because nothing was agreed after all.
   */
  const [synced, setSynced] = useState<string | undefined>(undefined);
  /** What the editor holds now — its own markdown, as it last reported it. The header's count is
   *  read off this, so it moves as the reader ticks rather than when the write lands. */
  const [draft, setDraft] = useState("");
  /** The editor's `key`. A body taken from elsewhere is a **remount** seeded with it, never text
   *  pushed into an editor the reader might be about to type in. */
  const [version, setVersion] = useState(0);
  /** The caret is somewhere inside the editor — its surface, its toolbar, its link field. */
  const [focused, setFocused] = useState(false);
  /** A change the reader made has not been handed to the write yet. */
  const [pending, setPending] = useState(false);
  /**
   * `New to-do`'s request to the editor — a counter rather than a flag, so a second press is a
   * second request. **Cleared to `0` by the editor as it takes one**, which is what stops a later
   * remount (a body adopted from elsewhere) from appending a second time: `NoteEditor` treats a
   * mount with a non-zero request as a request.
   */
  const [appendRequest, setAppendRequest] = useState(0);

  const seeded = synced !== undefined;
  const editorShown = open && seeded;

  /**
   * A caret cannot be inside an editor that is not mounted. Closing the band from anywhere but its
   * own disclosure — the widget, a sync apply writing `todos_open` — unmounts the editor under the
   * caret, and a removed node fires no blur React will hear, so without this the next body to
   * arrive would wait for a blur that is never coming.
   */
  if (focused && !editorShown) setFocused(false);

  /**
   * **The adoption.** A stored body the editor does not agree with, arriving while nobody is in
   * the editor, nothing typed is unsaved, and no write is in flight — so the editor is remounted
   * over it.
   *
   * **`saving` is the one that is easy to leave out**, and it matters for the half-second after
   * every autosave: {@link synced} already names the text just sent, while the cache still holds
   * the body before it until the command answers. Without the guard, that stale body would be
   * adopted — the reader's last phrase vanishing — and then the answer adopted back a beat later.
   */
  if (stored !== undefined && stored !== synced && !focused && !pending && !saving) {
    setSynced(stored);
    setDraft(stored);
    setVersion((v) => v + 1);
  }

  /** The draft as the reader last left it, for the timer and the flushes — read at the moment of
   *  writing, never through a closure that captured an older render. */
  const draftRef = useRef(draft);
  /** {@link pending}'s twin for the writers: the state decides the adoption during render, the ref
   *  decides whether a flush has anything to write. Always set together. */
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The newest render's answers, for a writer that is built once. Refreshed after every render
   * rather than per dependency, because the flush on unmount has to see the last one.
   *
   * `mutate` is here rather than captured, so a mutation object that changed identity costs a
   * render and not a write sent through a stale observer. `saving` is here for {@link write}: while
   * a save is out, `stored` is the body before it and says nothing about what the disk will hold.
   */
  const latest = useRef({ stored, synced, saving, mutate: todos.save.mutate });
  useEffect(() => {
    latest.current = { stored, synced, saving, mutate: todos.save.mutate };
  });

  /**
   * A refused write means the draft is still owed. **The draft stays on screen**: the store still
   * holds the old body, and adopting it now would take the reader's words away at the one moment
   * they were not saved. The next change, the next blur or the unmount tries again —
   * `StickyNoteDialog`'s *the next keystroke retries* — and the band's alert says why meanwhile.
   *
   * ⚠️ **{@link synced} goes back to what the store holds, and the retry depends on it.** The
   * flush that sent this text recorded it as agreed; left there, the next flush would find the
   * draft equal to the agreed body and send nothing — a refused save that no later way out ever
   * retries, with the alert the only sign.
   *
   * **It hears only the newest save's refusal** — TanStack calls a per-call callback for the
   * mutation its observer currently follows, and nothing older. That is enough because saves run
   * one at a time in the order they were made (`useDeckTodos`' `scope`): an older save refused
   * while a newer one waits is followed by that newer one, which carries every word the older one
   * did.
   */
  const owed = useCallback(() => {
    pendingRef.current = true;
    setPending(true);
    setSynced(latest.current.stored);
  }, []);

  /**
   * The one writer. Answers the body the editor now agrees with the store about — what it sent,
   * or the body it found it had no need to send — or `null` when nothing was pending.
   *
   * Refs throughout and a stable identity, which is what lets the unmount effect below use it as a
   * cleanup: a writer that changed identity would re-run that effect and write on every render.
   * **No `setState` in here**, so the cleanup that calls it is not a state write on the way out.
   *
   * **Stored through `todosText`**: an emptied checklist is still one empty item in the editor,
   * and stored as it stands it would keep a deck in the widget's list with nothing under it.
   *
   * **Nothing is sent when the draft says the same thing as an answer it could already be** —
   * `sameTodos`, a string comparison that lets an empty to-do the reader has not typed in (New
   * to-do, or Enter after the last line) differ and nothing that changes a word or a mark, so that
   * line is not a write that moves the deck's `updated_at` over nothing. The two answers:
   *
   * * **The stored body, and only while no save is out.** The write would change nothing. While a
   *   save *is* out the store still holds the body before it, so the draft coming back to that body
   *   — a line deleted, a pause, Ctrl+Z — is a change from what the disk is about to hold, and
   *   skipping it lost the revert: the save of the deleted line landed afterwards and an idle band
   *   adopted it, on screen and on disk.
   * * **The body last agreed** — the text last sent, or the body the editor was seeded with. The
   *   first is what a save out will leave on disk; the second is the reader's edits cancelling out,
   *   and sending it then would undo a tick that arrived while they were typing, where not sending
   *   it lets the adoption take that tick.
   *
   * **The body it matched is what it answers**, never the draft, so the band records as agreed a
   * body the store really holds or is about to: recording the draft would read as a body from
   * elsewhere and remount the editor over the empty to-do the reader is standing in.
   */
  const write = useCallback((): string | null => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!pendingRef.current) return null;
    pendingRef.current = false;
    const next = todosText(draftRef.current);
    const { stored: now, synced: agreed, saving: inFlight, mutate } = latest.current;
    if (!inFlight && now !== undefined && sameTodos(next, now)) return now;
    if (agreed !== undefined && sameTodos(next, agreed)) return agreed;
    mutate(next, { onError: owed });
    return next;
  }, [owed]);

  /** {@link write}, from an event or a timer — where the state that says so may be set too. */
  const flush = useCallback(() => {
    const next = write();
    if (next === null) return;
    setSynced(next);
    setPending(false);
  }, [write]);

  /** The editor reported a change: remember it, and start the delay again. */
  const change = useCallback(
    (markdown: string) => {
      draftRef.current = markdown;
      pendingRef.current = true;
      setDraft(markdown);
      setPending(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  // ⚠️ **The flush on unmount** — the deck closed, the app navigated — with the delay still
  // holding the reader's last phrase. `write`'s identity is stable, so this cleanup runs once, at
  // the end; `StrictMode`'s rehearsal of it finds nothing pending and writes nothing.
  useEffect(() => () => void write(), [write]);

  /**
   * The caret left the editor: write now rather than in 600 ms, and let a body waiting behind the
   * caret in. **Movement inside the editor is not leaving it** — the toolbar and the link field are
   * part of it — which is what `relatedTarget` is checked for.
   */
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    setFocused(false);
    flush();
  };

  const appendHandled = useCallback(() => setAppendRequest(0), []);

  /** Read off the draft, so the header moves as the reader ticks. `null` until there is a body —
   *  a count under a refused read would be a number the app does not have. */
  const counts = useMemo(() => (seeded ? countTodos(parseTodos(draft)) : null), [seeded, draft]);

  /** One line for the band: the newest write's refusal outranks the read's, `sectionFailure`'s
   *  rule — if a save has just been refused, that is what the reader was doing. */
  const failure = todos.save.isError ? ipcError(todos.save.error) : todos.failure;

  return (
    <TodosBand
      open={open}
      onToggle={onToggle}
      counts={counts}
      failure={failure}
      onNewTodo={() => {
        // **The press opens the band**, the notes band's `New note` argument: the to-do the
        // reader asked for must land somewhere they can see. The request waits in state until an
        // editor is mounted to take it, so a shut band opens and appends in one press.
        if (!open) onToggle(true);
        setAppendRequest((n) => n + 1);
      }}
      editor={
        seeded ? (
          <div onFocus={() => setFocused(true)} onBlur={leave}>
            {/* A sentence rather than a spinner, `StickyNoteDialog`'s shape: the chunk comes off
                local disk, so this is one frame of type. */}
            <Suspense fallback={<p className="text-xs text-dim">Opening the editor…</p>}>
              <NoteEditor
                key={version}
                mode="checklist"
                value={draft}
                onChange={change}
                ariaLabel={TODO_EDITOR_LABEL}
                appendRequest={appendRequest}
                onAppendHandled={appendHandled}
              />
            </Suspense>
          </div>
        ) : null
      }
    />
  );
}

export interface TodosBandProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  /** Every to-do at every depth, split by state — or `null` before there is a list to count. An
   *  empty list is `{ open: 0, done: 0 }` and draws no figure either. */
  counts: { open: number; done: number } | null;
  /** `New to-do` — open the band if it is shut, and ask the editor for a fresh item. */
  onNewTodo: () => void;
  /** The band's one refusal line, or `null`. */
  failure: string | null;
  /**
   * The open body's editor, or `null` when there is none to draw — the read has not landed, or
   * was refused. **A slot rather than the editor itself**, so this half of the file names no
   * query and no lazy module, and a story can hand it the real editor, a stand-in, or nothing.
   */
  editor: ReactNode;
}

/**
 * Everything the band draws, over plain props — the half of this file with no database behind it.
 *
 * The header is `DeckNotesPanel`'s, character for character where it can be: the rule and the
 * padding, the disclosure with its rotating chevron, a mono figure beside it, and the one act at
 * the far end of the row in `META_SUBMIT`'s recipe. Two bands one above the other that drew one
 * control two ways would be a reader learning the same thing twice.
 */
export function TodosBand({
  open,
  onToggle,
  counts,
  onNewTodo,
  failure,
  editor,
}: TodosBandProps): JSX.Element {
  const bodyId = useId();

  return (
    <section aria-label={TODOS_HEADING} className="shrink-0 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          // The pair that says *what* the press does: the region below is always in the tree —
          // empty while shut, never absent — so the id this names always resolves.
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

        {/* Its own element, so nothing computes it into the disclosure's name. Both halves always,
            so the figure has one shape a reader can learn — and nothing at all for an empty list,
            where `0 open · 0 done` beside the heading would be the band saying it is empty twice.
            One string rather than four text nodes, so it reads as one figure to anything that
            reads text. */}
        {counts !== null && counts.open + counts.done > 0 && (
          <span className="font-mono text-xs tabular-nums text-dim">
            {`${counts.open} open · ${counts.done} done`}
          </span>
        )}

        {/* The band's one act, in the header and outside the collapsible region, so it is offered
            whether the band is open or shut — the notes band's `New note`, beside it. */}
        <button
          type="button"
          onClick={onNewTodo}
          className={cn("ml-auto inline-flex items-center gap-1.5", META_SUBMIT)}
        >
          <Plus aria-hidden="true" className="size-3.5 shrink-0" />
          New to-do
        </button>
      </div>

      {/* Outside the collapsible region: a read refused while the band is shut still owes the
          reader a sentence, and the alternative is a header that silently counts nothing. */}
      {failure !== null && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {failure}
        </p>
      )}

      {/* **`select-text` because a to-do is written to be read** — the editor's root refuses text
          selection (issue #473), and a list a reader cannot copy a line out of is a list they
          retype. `contenteditable` edits its own text whatever an ancestor says; this is for the
          rest of the region. */}
      <div id={bodyId} className="select-text">
        {open && (
          <div className="mt-3">
            {/* Three states and two sentences: an editor, a read still in flight, and a refused
                read — which says nothing here because the alert above already has. */}
            {editor ??
              (failure === null ? <p className="text-xs text-dim">Loading to-dos…</p> : null)}
          </div>
        )}
      </div>
    </section>
  );
}
