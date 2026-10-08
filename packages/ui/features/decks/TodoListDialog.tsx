/**
 * Where one deck to-do list is written — a title field and the checklist editor, autosaved
 * (issue #688).
 *
 * ⚠️ **Still not a note**, and `NoteEditorDialog` is the neighbour this must not be mistaken for.
 * A note is saved by a press on Save; a to-do list has **no Save** and is written as it is typed.
 * What the two share is the editor and the `Dialog` shell.
 *
 * ## The autosave is #672's, moved here from the band intact
 *
 * Until issue #688 a deck had one list and the band *was* its editor, so the band owned the
 * machinery below. The band draws cards now and this dialog is the only place a list is typed
 * into, so every piece moved with the editor and none was redesigned on the way:
 *
 * - **600 ms after the last change**, `StickyNoteDialog`'s number — and a flush the moment the
 *   caret leaves the dialog's body, on every way out of the dialog, and on unmount. The flushes are
 *   what make the delay safe: the last phrase before a reader closes is exactly the one a timer
 *   alone would lose.
 * - **One save at a time, in the order they were made**, under a TanStack `scope` — here **one per
 *   dialog instance** (`useId`), because a new list has no id to key a scope by until its first
 *   save answers, and an update queued behind that create has to wait for the id it answers.
 * - **Adopt only when idle**: a body changed elsewhere (a card ticked in the band, another window,
 *   a sync apply) replaces the editor only when the caret is not in it, nothing typed is unsaved
 *   and no save is out — and replaces it as a **remount**, never as text pushed into an editor the
 *   reader may be about to type in.
 * - **A refused save keeps the draft on screen and owed**, so the next change, blur, close or
 *   unmount tries again.
 *
 * **The title rides the same save as the body** — one draft of two fields, one timer, one write.
 *
 * ## A new list has no id until its first save
 *
 * New to-do list opens this dialog on nothing. The first real change is the **create**; every
 * later save is an update of the id it answered, which `useTodoListSave` reads off `idRef` at the
 * moment each save *runs* rather than when it was queued. **Closed untouched (`isBlankList`) it
 * creates nothing** — and a title typed alone is not untouched: it creates a list with an empty
 * body.
 *
 * ## The editor is reached through `React.lazy` and nothing else
 *
 * `DeckNotesPanel.test.tsx` sweeps `packages/ui/` for a static import of `NoteEditor`, a type-only one
 * included, so the checklist mode's props are named at the call site and nowhere else here.
 *
 * ⚠️ **Every state decision is made during render or in an event, never with a `setState` in an
 * effect body** — `react-hooks/set-state-in-effect` refuses the shape and only `npm run verify`
 * goes red on it. The adoption is React's own *adjusting state when a prop changes*.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
} from "react";
import { Dialog } from "@/components/Dialog";
import { ipcError, type DeckTodoList } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, META_FIELD, META_SUBMIT } from "./metaRows";
import { isBlankList, listTitle, parseTodoBody, sameTodos } from "./todoMarkdown";
import { useDeckTodoLists, useTodoListSave } from "./useDeckTodos";

/**
 * The rich-text editor, **reached by a dynamic import and by nothing else** — a static import
 * anywhere on this path puts 141.5 kB gzip back in the main chunk, and nothing goes red but the
 * sweep in `DeckNotesPanel.test.tsx`.
 */
const NoteEditor = lazy(() => import("./NoteEditor"));

/** How long the dialog waits after the last change before writing — `StickyNoteDialog`'s number
 *  and its argument. Not a `motion.ts` tier; nothing animates. */
export const SAVE_DELAY_MS = 600;

/** What the writing surface is called — distinct from the dialog's heading and from the band's
 *  region, so a keyboard reader hears three things as three things. */
export const TODO_EDITOR_LABEL = "To-do list";

/** The title field's name and placeholder. */
export const TITLE_LABEL = "Title";

/** One list's two fields, as the dialog agrees them with the store. */
interface Fields {
  title: string;
  body: string;
}

/** A new list's agreed state: nothing, which is also what a blank create would write. */
const BLANK: Fields = { title: "", body: "" };

/**
 * The body as it should be stored: `""` when it holds no block, and otherwise exactly as written.
 *
 * An emptied list is still one empty to-do in the editor, and storing that line would keep the
 * list in the widget with nothing under it. Anything with a block in it is stored byte for byte —
 * the reader's own spacing is theirs. (`todosText`' rule, which the reader module no longer
 * carries: whoever writes a body stores `""` for an empty one.)
 */
function storedBody(body: string): string {
  return parseTodoBody(body).length === 0 ? "" : body;
}

/**
 * Whether two drafts say the same thing: the title byte for byte, the body through `sameTodos` —
 * a string comparison that lets an empty to-do the reader has not typed in differ and nothing
 * that changes a word or a mark.
 */
function sameFields(a: Fields, b: Fields): boolean {
  return a.title === b.title && sameTodos(a.body, b.body);
}

/**
 * `idRef` with a setter that also tells React — **the one way this dialog learns the id a create
 * answered.**
 *
 * `useTodoListSave`'s `mutationFn` writes the id into `idRef.current` as the create answers. A
 * plain `useRef` would carry it to every later save, but the render could not read it
 * (`react-hooks/refs` refuses a ref read during render) and TanStack delivers a per-call callback
 * only for the newest mutation — which, if the reader typed on while the create was out, is the
 * queued update and not the create. So the box is a plain object whose setter mirrors the write
 * into state: the saves read `current`, the render reads the state, and the two cannot disagree.
 */
function idBox(initial: number | null, publish: (id: number | null) => void) {
  let value = initial;
  return {
    get current(): number | null {
      return value;
    },
    set current(next: number | null) {
      value = next;
      publish(next);
    },
  };
}

export interface TodoListDialogProps {
  deckId: number;
  open: boolean;
  /**
   * The list this dialog was opened on, or `null` for New to-do list. **Read once, at mount** —
   * the host keys this component per opening, so a reopen is a fresh draft, and closing it keeps
   * the id it had for the length of the exit tween.
   */
  listId: number | null;
  /** Close, after the dialog has written whatever it owed. */
  onClose: () => void;
  /** The confirmed Delete list — the host deletes, since the band owns the delete. */
  onDelete: (id: number) => void;
}

export function TodoListDialog({
  deckId,
  open,
  listId: initialId,
  onClose,
  onDelete,
}: TodoListDialogProps): JSX.Element {
  const { lists } = useDeckTodoLists(deckId);
  // Per instance: the band keys this component per opening, so every opening is its own scope and
  // its saves queue only behind each other — never behind another list's.
  const instance = useId();
  const save = useTodoListSave(deckId, `todo-list-dialog-${instance}`);
  const saving = save.isPending;

  const [listId, setListId] = useState<number | null>(initialId);
  const [idRef] = useState(() => idBox(initialId, setListId));

  const row: DeckTodoList | undefined =
    listId === null ? undefined : lists?.find((list) => list.id === listId);
  /** What the store holds for this list, `undefined` for a list not created yet or not read. */
  const stored: Fields | undefined =
    row === undefined ? undefined : { title: row.title, body: row.body };

  /**
   * The fields the dialog is known to agree with the store about — `undefined` until an existing
   * list's first read lands, which also gates the editor: an editor over a body nobody read is an
   * empty list whose first keystroke would autosave over the real one. A new list starts agreed on
   * {@link BLANK}, because there is nothing to read.
   */
  const [synced, setSynced] = useState<Fields | undefined>(initialId === null ? BLANK : undefined);
  /** What the two fields hold now. */
  const [draft, setDraft] = useState<Fields>(BLANK);
  /** The editor's `key`: a body taken from elsewhere is a remount seeded with it. */
  const [version, setVersion] = useState(0);
  /** The caret is somewhere in the dialog's body — the title, the editor, its toolbar. */
  const [focused, setFocused] = useState(false);
  /** A change the reader made has not been handed to the write yet. */
  const [pending, setPending] = useState(false);
  /** The Delete list question is up, over this dialog. */
  const [confirming, setConfirming] = useState(false);

  const seeded = synced !== undefined;

  // A caret cannot be in a body that is not mounted — a dialog closed from anywhere fires no blur
  // React will hear, and without this the next body to arrive would wait for one for ever.
  if (focused && !open) setFocused(false);
  if (confirming && !open) setConfirming(false);

  /**
   * **The adoption.** A stored list the dialog does not agree with, arriving while nobody is in
   * the body, nothing typed is unsaved and no save is out — so the editor is remounted over it.
   * `saving` is the one easy to leave out: for the length of a round trip `synced` names the text
   * just sent while the cache still holds the text before it.
   *
   * **Exact equality, and spelled inline.** Exact, because "says the same thing" is not enough
   * here: an unsent empty to-do stays on screen only by never reading as a list from elsewhere.
   * Inline, because handing `synced` to a helper made the React Compiler treat it as possibly
   * mutated, and every callback below that calls a setter then failed
   * `react-hooks/preserve-manual-memoization` — measured, 2026-09-29.
   */
  const differs =
    stored !== undefined && (stored.title !== synced?.title || stored.body !== synced?.body);
  if (stored !== undefined && differs && !focused && !pending && !saving) {
    setSynced(stored);
    setDraft(stored);
    setVersion((v) => v + 1);
  }

  /** The draft as the reader last left it, for the timer and the flushes. */
  const draftRef = useRef(draft);
  /** {@link pending}'s twin for the writers. Always set together. */
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The newest render's answers, for a writer that is built once. */
  const latest = useRef({ stored, synced, saving, mutate: save.mutate });
  useEffect(() => {
    latest.current = { stored, synced, saving, mutate: save.mutate };
    // ⚠️ **The draft ref follows the committed draft, and an adoption is why.** A change writes
    // the ref itself before its render, but the adoption sets `draft` during render, where a ref
    // may not be written — and a change merges one field into the ref, so a ref left on the draft
    // before an adoption would send the other field back as it was. Within one commit the two
    // are always equal already, so this is a no-op everywhere but after an adoption.
    draftRef.current = draft;
  });

  /**
   * A refused write: the draft stays on screen and is still owed. {@link synced} goes back to what
   * the store holds — or to {@link BLANK} for a list the refused create never made — because
   * nothing was agreed after all, and left on the refused text the next flush would find nothing
   * to send.
   */
  const owed = useCallback(() => {
    pendingRef.current = true;
    setPending(true);
    setSynced(latest.current.stored ?? BLANK);
  }, []);

  /**
   * The one writer. Answers the fields the dialog now agrees with the store about, or `null` when
   * nothing was pending. Refs throughout and a stable identity, so the unmount effect can use it as
   * a cleanup; **no `setState` in here**.
   */
  const write = useCallback((): Fields | null => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!pendingRef.current) return null;
    pendingRef.current = false;
    const next: Fields = {
      title: draftRef.current.title,
      body: storedBody(draftRef.current.body),
    };
    const { stored: now, synced: agreed, saving: inFlight, mutate } = latest.current;
    // Nothing made yet, nothing on the way, and nothing to make — the untouched New to-do list.
    if (idRef.current === null && !inFlight && isBlankList(next.title, next.body)) return BLANK;
    if (!inFlight && now !== undefined && sameFields(next, now)) return now;
    if (agreed !== undefined && sameFields(next, agreed)) return agreed;
    mutate({ id: idRef.current, title: next.title, body: next.body, idRef }, { onError: owed });
    return next;
  }, [owed, idRef]);

  /** {@link write}, from an event or a timer — where the state that says so may be set too. */
  const flush = useCallback(() => {
    const next = write();
    if (next === null) return;
    setSynced(next);
    setPending(false);
  }, [write]);

  /** A field changed: remember it, and start the delay again. */
  const change = useCallback(
    (fields: Partial<Fields>) => {
      const next = { ...draftRef.current, ...fields };
      draftRef.current = next;
      pendingRef.current = true;
      setDraft(next);
      setPending(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );
  const changeBody = useCallback((body: string) => change({ body }), [change]);

  // ⚠️ **The flush on unmount** — the deck closed, the app navigated — with the delay still
  // holding the reader's last phrase. `write` is stable, so this runs once, at the end.
  useEffect(() => () => void write(), [write]);

  /** The caret left the body — write now. Movement inside it (title ↔ editor ↔ toolbar) is not
   *  leaving it, which is what `relatedTarget` is checked for. */
  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    setFocused(false);
    flush();
  };

  /** Every way out — Done, Escape, the ✕, the scrim — writes what is owed first. */
  const close = () => {
    setFocused(false);
    flush();
    onClose();
  };

  /** Throw the draft away: the list is going, and a save of it would be refused or, worse, land. */
  const discard = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
    setPending(false);
  };

  /**
   * Delete list. A list with an id asks first; a list never made has nothing to delete, so the
   * press throws the draft away and closes. **Refused while a save is out** — a delete racing a
   * create would leave the created list standing.
   */
  const askDelete = () => {
    if (saving) return;
    if (listId === null) {
      discard();
      onClose();
      return;
    }
    setConfirming(true);
  };

  const confirmDelete = () => {
    if (listId === null) return;
    discard();
    setConfirming(false);
    onDelete(listId);
    onClose();
  };

  const failure = save.isError ? ipcError(save.error) : null;
  const heading = initialId === null ? "New to-do list" : "Edit to-do list";

  return (
    <>
      <Dialog
        open={open}
        title={heading}
        closeLabel="Close"
        size="w-[40rem]"
        stackedOver={confirming}
        onDismiss={close}
        onClose={close}
      >
        <div
          className="flex min-h-60 flex-col gap-3 px-5 py-4"
          onFocus={() => setFocused(true)}
          onBlur={leave}
        >
          {seeded ? (
            <>
              <input
                type="text"
                value={draft.title}
                onChange={(event) => change({ title: event.target.value })}
                aria-label={TITLE_LABEL}
                placeholder={TITLE_LABEL}
                className={cn(META_FIELD, "h-9 flex-none text-sm")}
              />
              {/* A sentence rather than a spinner: the chunk comes off local disk, so this is one
                  frame of type. */}
              <Suspense fallback={<p className="text-xs text-dim">Opening the editor…</p>}>
                <NoteEditor
                  key={version}
                  mode="checklist"
                  value={draft.body}
                  onChange={changeBody}
                  ariaLabel={TODO_EDITOR_LABEL}
                />
              </Suspense>
            </>
          ) : (
            <p className="text-xs text-dim">Loading the list…</p>
          )}
          {failure !== null && (
            <p role="alert" className="text-xs text-destructive">
              {failure}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            aria-disabled={saving || undefined}
            onClick={askDelete}
            className={cn(CONFIRM_DESTRUCTIVE, "aria-disabled:opacity-50")}
          >
            Delete list
          </button>
          <button type="button" onClick={close} className={cn("ml-auto", META_SUBMIT)}>
            Done
          </button>
        </footer>
      </Dialog>

      <DeleteTodoListDialog
        open={open && confirming}
        title={listTitle(draft.title)}
        stacked
        onDelete={confirmDelete}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Delete a to-do list, and say what goes with it — the band's card and this dialog's footer ask
 * the one question, so it is one component.
 *
 * The destructive act first and the way out beside it, `DeleteNoteDialog`'s arrangement. The
 * question is the heading, so the panel is named by it.
 */
export function DeleteTodoListDialog({
  open,
  title,
  stacked = false,
  pending = false,
  onDelete,
  onClose,
}: {
  open: boolean;
  /** The list's drawn name — `listTitle`'s, so an untitled list is asked about by that name. */
  title: string;
  /** Opened over {@link TodoListDialog} rather than over the band — the higher scrim rung. */
  stacked?: boolean;
  pending?: boolean;
  onDelete: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title={`Delete “${title}”?`}
      closeLabel="Close"
      size="w-[26rem]"
      layer={stacked ? "stacked" : "overlay"}
      onDismiss={onClose}
      onClose={onClose}
    >
      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-dim">Its to-dos go with it.</p>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" disabled={pending} onClick={onDelete} className={CONFIRM_DESTRUCTIVE}>
          Delete list
        </button>
        <button type="button" onClick={onClose} className={CONFIRM_CANCEL}>
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}
