/**
 * Writing a note — the one surface in this app that saves a reader's prose without being asked.
 *
 * **It is `components/Dialog` and not a second definition of a modal**, which is `src/CLAUDE.md`'s
 * standing rule and is also exactly what the design asks for here: the spec calls this "a `fixed`
 * overlay mounted inside the widget body", and that shell *is* one — a `fixed inset-0` scrim with
 * a centred panel, drawn wherever it is mounted in the tree. Taking it whole brings the scrim, the
 * ✕, `aria-modal`, `trapTab`, the `"inner"` Escape rung and the clamp that keeps a footer on
 * screen, none of which this file would get right on its own.
 *
 * ⚠️ **That `fixed` is legal only because the home page has no containment.** `fit.ts` and
 * `HomePage.tsx` both say so: there is no `container-type` anywhere on that page, deliberately,
 * because `@container` makes a box the containing block for every `fixed` descendant. A future
 * container query there breaks this dialog and the widget cards' two anchored popovers together.
 *
 * **There is no `open` prop and there is no Cancel.** The host mounts this when a note is being
 * written and unmounts it when it is not, which is the same contract `Dialog` states one floor
 * up — closed is nothing mounted — expressed by the caller rather than by a flag. What it costs is
 * the exit tween, which `AnimatePresence` cannot play for a subtree its parent has already
 * removed; what it buys is that **the unmount is the flush**, and the flush is the whole point.
 *
 * ## The autosave, which is the only genuinely new interaction in this feature
 *
 * `DeckNotesPanel` is an explicit Save with no debounce and no unsaved-change guard. That is
 * tolerable in a band a reader deliberately opened to edit and it is not tolerable here: this
 * dialog closes on a scrim press, on Escape and on the ✕, and none of the three asks first. So a
 * draft is written on a debounce, the writing is reported in words, and **the pending draft is
 * flushed from a mount-only effect's cleanup** — without that last part the last keystrokes before
 * a close are precisely the ones lost, which is the failure the design exists to avoid.
 *
 * Three refs carry it ({@link StickyNoteBody}), and they are refs rather than state for one
 * reason: the cleanup that flushes must not name the draft as a dependency, or it would run on
 * every keystroke and the flush would stop being a flush.
 *
 * ## What it deliberately does not do
 *
 * **It does not trim the name on the way in.** `stickyTitle` trims and falls through to the body's
 * first line, so a title of spaces already *draws* correctly wherever a note is named, and
 * trimming here would be a debounced write racing the reader's own caret — the field is controlled
 * by the draft, a trailing space is deleted mid-word 600 ms after it is typed, and the next
 * keystroke fights it. `DeckNotesPanel` trims on an explicit Save because it discards the draft in
 * the same press; an autosave is a different animal. What is stored is what was typed; what is
 * drawn is what `stickyTitle` makes of it.
 *
 * **It does not write a colour the reader did not pick.** `sticky_notes.color` carries no CHECK on
 * purpose, so a newer build's sixth colour must survive a round trip through this one — and
 * `noteColor` reads any such word as `slate`. Seeding the draft from `noteColor(note.color)` and
 * saving it back would therefore silently repaint a `teal` note `slate` the moment the reader
 * opened it and typed a letter. So the pick is `null` until a swatch is actually pressed.
 *
 * **It does not push the stored body back into the editor.** The draft is seeded once, at mount,
 * and nothing re-seeds it — so a save landing (or another window's edit arriving through
 * `crossWindow`) cannot take words out from under a reader who is still typing them.
 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { Dialog } from "@/components/Dialog";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "@/features/decks/metaRows";
import { FOCUS } from "@/lib/focus";
import { ipcError, type StickyNote, type StickyNotePatch } from "@/lib/ipc";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";

import { NOTE_COLORS, noteColor, stickyTitle, type NoteColor } from "./stickyNotes";

/**
 * The rich-text editor, and **the only reference to it on this path**.
 *
 * `React.lazy` over a dynamic import, so Tiptap's 141.5 kB is fetched the first time a reader
 * opens a note and never for a home page that merely draws them. `DeckNotesPanel.test.tsx` sweeps
 * all of `src/` for a static `import … from "…/NoteEditor"` and that sweep does not skip a
 * `.stories.tsx`, so neither this file nor its stories may name the module any other way — and
 * that includes importing `NOTE_EXTENSIONS` from it, which pulls the same chunk.
 */
const NoteEditor = lazy(() => import("@/features/decks/NoteEditor"));

/**
 * How long the dialog waits after the last keystroke before writing.
 *
 * **Not a `motion.ts` tier, and the distinction is the one `index.css`'s `card-landed` already
 * draws**: that module is a scale for things the *pixels* do, capped at 260 ms and swept by
 * `motion.test.ts`. This is a wait before a database write — it is not animating anything, and
 * putting it on that scale would make the app's slowest transition also its save delay.
 *
 * 600 ms is long enough that ordinary typing produces one write per phrase rather than one per
 * letter, and short enough that a reader who stops to think has already been saved by the time
 * they reach for the ✕. Nothing rests on the exact number: the flush on unmount is what makes the
 * dialog lose nothing at any delay, and this only decides how often the indicator says so.
 */
const SAVE_DELAY_MS = 600;

/** The five papers, each as the two custom properties `index.css` defines for it.
 *
 *  ⚠️ **Written out rather than assembled from the colour word**, and inline rather than as a
 *  Tailwind class. A `bg-note-${color}` emits no rule at all — Tailwind scans source text — and a
 *  `var(--color-note-${color})` would work but would put the five names nowhere a grep can find
 *  them. The `-strip` is the saturated edge across a note's top; the fill is the paper. */
const NOTE_PAPER: Record<NoteColor, { fill: string; strip: string }> = {
  amber: { fill: "var(--color-note-amber)", strip: "var(--color-note-amber-strip)" },
  jade: { fill: "var(--color-note-jade)", strip: "var(--color-note-jade-strip)" },
  azure: { fill: "var(--color-note-azure)", strip: "var(--color-note-azure-strip)" },
  rose: { fill: "var(--color-note-rose)", strip: "var(--color-note-rose-strip)" },
  slate: { fill: "var(--color-note-slate)", strip: "var(--color-note-slate-strip)" },
};

/** What each swatch is called out loud. The group names the question, so a swatch names only its
 *  own answer — "Amber", not "Colour this note amber". */
const COLOR_LABEL: Record<NoteColor, string> = {
  amber: "Amber",
  jade: "Jade",
  azure: "Azure",
  rose: "Rose",
  slate: "Slate",
};

/**
 * The name field.
 *
 * Its own recipe rather than `metaRows`' `META_FIELD`, which is explicitly the grammar of a **32px
 * deck meta row** at 13px and shares nothing with this but a corner radius. This is the one field
 * in a dialog, at the dialog's own type scale.
 */
const NAME_FIELD = cn(
  "h-9 w-full min-w-0 rounded-md border border-border bg-bg px-2.5 text-sm",
  "placeholder:text-dim focus:border-accent focus:outline-none",
);

export interface StickyNoteDialogProps {
  /** The note being written. Seeds the drafts **once**, at mount; see this file's header for why
   *  nothing re-seeds them. */
  note: StickyNote;
  /**
   * Write the draft.
   *
   * Called on a debounce and once more at unmount, always with a **partial** patch naming only the
   * fields that differ from {@link note} — so a field the reader never touched is never sent, and
   * `coalesce` at the far end leaves it alone.
   *
   * ⚠️ **Worth keeping stable.** It is latched in a ref here, so an unstable one costs a render
   * rather than a lost draft — but a host that rebuilds it every render is a host whose own
   * `useCallback` around the note's id has gone missing, and that is worth knowing.
   */
  onSave: (patch: StickyNotePatch) => void;
  /** Destroy the note. Asked for twice — the dialog puts the question before the press. */
  onDelete: () => void;
  /** Escape, the ✕ and a scrim press, which are the three ways out and are deliberately one
   *  callback: the host unmounts this, and **the unmount is what writes the pending draft**. The
   *  caret is the host's to hand back, because by then the opener is the only thing left. */
  onClose: () => void;
  /**
   * A write is on the wire — `useStickyNotes`' `isSaving`, passed down.
   *
   * Optional, because the dialog can already say *Saving…* from its own pending draft; what this
   * adds is the half of the round trip the dialog cannot see. Without it the indicator reads
   * *Saved just now* while the command is still in flight.
   */
  saving?: boolean;
  /**
   * The last write was refused — `useStickyNotes`' `writeError`, passed down raw.
   *
   * ⚠️ **The one state worth passing down, and the reason the two optional props exist.** All four
   * writes can answer `collection::BUSY` under a running sync, and a dialog that closes on a scrim
   * press is exactly where a refusal must not be silent. Given it, the footer says so and the next
   * keystroke retries; without it a refused save looks identical to a saved one.
   */
  writeError?: unknown;
}

/**
 * The editor, over the window.
 *
 * `Dialog`'s two callbacks are one here: this dialog has no state of its own worth returning a
 * caret to, and the host that unmounts it owns the opener either way.
 */
export function StickyNoteDialog({
  note,
  onSave,
  onDelete,
  onClose,
  saving = false,
  writeError,
}: StickyNoteDialogProps): ReactElement {
  return (
    <Dialog
      open
      title="Note"
      closeLabel="Close the note"
      // No `max-h` here: `cn`'s tailwind-merge would delete the shell's own `max-h-full` and the
      // panel would outgrow the window with its footer on it. `src/CLAUDE.md` carries that one.
      size="w-[34rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <StickyNoteBody
        note={note}
        onSave={onSave}
        onDelete={onDelete}
        saving={saving}
        writeError={writeError}
      />
    </Dialog>
  );
}

/**
 * Everything inside the panel — the drafts, the debounce and the flush.
 *
 * Separate from the shell for `Dialog`'s own reason, restated: a body is what mounts and unmounts,
 * so every piece of state below starts clean on each open and the cleanup that flushes runs at
 * exactly the moment the reader left.
 */
function StickyNoteBody({
  note,
  onSave,
  onDelete,
  saving,
  writeError,
}: {
  note: StickyNote;
  onSave: (patch: StickyNotePatch) => void;
  onDelete: () => void;
  saving: boolean;
  writeError: unknown;
}): ReactElement {
  const nameId = useId();

  const [draftTitle, setDraftTitle] = useState(note.title);
  const [draftBody, setDraftBody] = useState(note.body);
  /** `null` until a swatch is pressed — see the header: a colour this build cannot name must
   *  survive being looked at. */
  const [pickedColor, setPickedColor] = useState<NoteColor | null>(null);
  /**
   * The last patch this dialog handed over, and when — `null` until it has handed over one.
   *
   * **State rather than a ref, and the key is in it rather than only the moment**, because the
   * footer has to be able to tell *written and not yet read back* from *not written yet*. Deriving
   * that from the row instead — the draft differs from `note`, so something is outstanding — reads
   * correctly right up until a host hands this dialog a `note` it does not re-read, and then the
   * line says *Saving…* for ever over a note that saved perfectly.
   */
  const [sent, setSent] = useState<{ key: string; atMs: number } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const shownColor = pickedColor ?? noteColor(note.color);

  /**
   * What would be written right now, or `null` if the draft and the row already agree.
   *
   * **Partial, and each field is compared against the row rather than against a snapshot taken at
   * mount.** So a save landing makes this `null` on the next render with nothing having to reset
   * anything, and a field the reader never touched is never named in a patch at all.
   *
   * The colour arm compares the picked `NoteColor` against the **stored string**, not against
   * `noteColor(note.color)`: on a note whose colour this build does not know, pressing `Slate`
   * really is a change and must be written.
   */
  const patch = useMemo<StickyNotePatch | null>(() => {
    const next: StickyNotePatch = {};
    if (draftTitle !== note.title) next.title = draftTitle;
    if (draftBody !== note.body) next.body = draftBody;
    if (pickedColor !== null && pickedColor !== note.color) next.color = pickedColor;
    return Object.keys(next).length === 0 ? null : next;
  }, [draftTitle, draftBody, pickedColor, note.title, note.body, note.color]);

  /** The patch as one comparable string — what {@link sent} is matched against, and what the
   *  writer below dedupes on. `null` when the draft and the row already agree. */
  const patchKey = useMemo(() => (patch === null ? null : JSON.stringify(patch)), [patch]);

  /** Whether anything the reader has typed has still not been handed over. */
  const outstanding = patchKey !== null && patchKey !== sent?.key;

  /** The draft the timer below will write, kept out of the dependency arrays so the flush can
   *  read it without re-running. */
  const pendingRef = useRef<StickyNotePatch | null>(null);
  /**
   * The last patch actually handed over, as JSON.
   *
   * It exists because the debounce and the flush are two writers of one draft: without it, a
   * dialog closed a few hundred milliseconds after a save had already landed — inside the round
   * trip, before the row could come back — would write the identical patch a second time.
   */
  const sentRef = useRef("");
  /** Latched for `NoteEditor`'s reason one file over: {@link write} is built once, so it would
   *  otherwise call the first render's `onSave` for the life of the dialog. */
  const onSaveRef = useRef(onSave);
  /** Latched so {@link write} can ask whether the last attempt was refused without taking it as a
   *  dependency, which would rebuild the writer and re-arm the flush. */
  const writeErrorRef = useRef(writeError);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    writeErrorRef.current = writeError;
  }, [writeError]);

  /**
   * The one writer. Answers the key it wrote, or `null` if it wrote nothing.
   *
   * Refs throughout and `[]` deps, which is what lets the mount-only effect below use it as a
   * cleanup: a `write` that changed identity would make that effect run per keystroke, and the
   * flush would fire on every letter instead of once, at the end.
   *
   * ⚠️ **A refusal makes a patch worth sending again, so the dedupe is forced past.** Without
   * that, a write that answered `BUSY` is recorded as sent: a reader who typed a word and deleted
   * it again would land back on a patch this dialog believes the database already has, and the
   * flush at close would skip it too.
   */
  const write = useCallback((): string | null => {
    const pending = pendingRef.current;
    if (pending === null) return null;
    const key = JSON.stringify(pending);
    if (key === sentRef.current && writeErrorRef.current === undefined) return null;
    sentRef.current = key;
    onSaveRef.current(pending);
    return key;
  }, []);

  // The debounce. The ref is assigned on every render of a new draft — including the render that
  // makes it `null` — so the flush below can never read a draft that has been superseded.
  //
  // `setSent` is in the timer's callback and not in this effect's body: a `setState` during an
  // effect is the cascading-renders failure this repo has paid for twice, and it passes both
  // `tsc` and vitest before dying at lint.
  useEffect(() => {
    pendingRef.current = patch;
    if (patch === null) return;
    const timer = setTimeout(() => {
      const key = write();
      if (key !== null) setSent({ key, atMs: Date.now() });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [patch, write]);

  // ⚠️ **The flush, and the reason the four refs above are refs.** The dialog closes on a scrim
  // press, on Escape and on the ✕, and every one of those unmounts this body with the debounce's
  // timer still holding the reader's last phrase. Mount-only deps, so this cleanup runs exactly
  // once — at the unmount — and `write`'s own dedupe makes a draft already saved cost nothing.
  //
  // No `setSent` here: there is nobody left to read the indicator, and a `setState` on the way out
  // is a render React has no reason to make.
  useEffect(() => () => void write(), [write]);

  const editorLabel = `Body of ${stickyTitle(note)}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5 pt-4">
      {/* The paper's own edge, across the top of everything the reader is about to write on — the
          same 3px strip a tile wears, so the dialog and the board name one note the same way.
          `aria-hidden`: the swatch row below says the colour in words. */}
      <span
        aria-hidden="true"
        className="block h-[3px] shrink-0 rounded-full"
        style={{ background: NOTE_PAPER[shownColor].strip }}
      />

      <div className="shrink-0">
        <label htmlFor={nameId} className="mb-1 block text-xs text-dim">
          Name
        </label>
        <input
          id={nameId}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          // Blank is a legal name: a note with a body reads its first line instead, computed at
          // render and never stored. The sentence is `DeckNotesPanel`'s, because it is the same
          // rule — `stickyTitle` delegates to the same function.
          placeholder="Untitled — the first line stands in"
          className={NAME_FIELD}
        />
      </div>

      <div role="group" aria-label="Note colour" className="flex shrink-0 items-center gap-2">
        {NOTE_COLORS.map((color) => {
          const picked = color === shownColor;
          return (
            <button
              key={color}
              type="button"
              aria-label={COLOR_LABEL[color]}
              aria-pressed={picked}
              onClick={() => setPickedColor(color)}
              // The paper, with its strip across the top: a swatch that is a small note rather
              // than a dot, so the choice is made against what it will look like. The ring is a
              // `box-shadow` rather than a second border, which would move the strip by a pixel
              // as the reader walked the row.
              style={{
                background: NOTE_PAPER[color].fill,
                boxShadow: picked ? "0 0 0 2px var(--color-accent)" : undefined,
              }}
              className={cn(
                "relative size-7 shrink-0 overflow-hidden rounded-md border border-border",
                FOCUS,
              )}
            >
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 block h-1"
                style={{ background: NOTE_PAPER[color].strip }}
              />
            </button>
          );
        })}
      </div>

      {/* A sentence rather than a spinner: the chunk arrives off local disk, so what a reader
          sees is one frame of type rather than something spinning. `DeckNotesPanel`'s shape. */}
      <Suspense fallback={<p className="text-[0.6875rem] text-dim">Opening the editor…</p>}>
        <NoteEditor value={draftBody} onChange={setDraftBody} ariaLabel={editorLabel} />
      </Suspense>

      <div className="flex shrink-0 items-center justify-between gap-3 pt-1">
        <SaveIndicator
          note={note}
          pending={outstanding}
          saving={saving}
          savedAtMs={sent?.atMs ?? null}
          writeError={writeError}
        />
        {!confirmingDelete && (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className={cn(
              "shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard",
              "hover:border-destructive hover:text-destructive motion-reduce:transition-none",
              FOCUS,
            )}
          >
            Delete note
          </button>
        )}
      </div>

      {confirmingDelete && (
        <DeleteNote
          title={stickyTitle(note)}
          onDelete={onDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

/** What the footer's left-hand line says, and how loudly. */
interface SaveLine {
  tone: "dim" | "destructive";
  text: string;
}

/**
 * Whether the reader's words are in the database, in one sentence.
 *
 * Four states, ordered by what a reader needs to know first. A refusal outranks everything — it is
 * the only one that means *go back and try again*. A draft not yet written and a command not yet
 * answered are one sentence, because the difference between them is the dialog's business and not
 * the reader's. *Saved just now* is this dialog's own record of handing a patch over; before it has
 * handed one over, the row's own `updatedAt` answers instead, so an untouched note says when it was
 * last written rather than nothing at all.
 *
 * **A plain function with `nowMs` as a default parameter, which is `BackupPanel`'s shape and not a
 * style choice**: `react-hooks/purity` refuses a `Date.now()` in a component body outright, and it
 * is right to — "2 hours ago" is a fact about the render. Nothing here repaints when a minute
 * passes, deliberately; every keystroke re-renders this anyway, and a dialog on a timer would be
 * motion without information.
 */
function saveLine(
  updatedAt: number,
  state: { pending: boolean; saving: boolean; savedAtMs: number | null; writeError: unknown },
  nowMs: number = Date.now(),
): SaveLine {
  if (state.writeError !== undefined) {
    return { tone: "destructive", text: `Not saved — ${ipcError(state.writeError)}` };
  }
  if (state.pending || state.saving) return { tone: "dim", text: "Saving…" };
  if (state.savedAtMs !== null) {
    return { tone: "dim", text: `Saved ${ago(Math.floor(state.savedAtMs / 1000), nowMs)}` };
  }
  return { tone: "dim", text: `Edited ${ago(updatedAt, nowMs)}` };
}

function SaveIndicator({
  note,
  pending,
  saving,
  savedAtMs,
  writeError,
}: {
  note: StickyNote;
  pending: boolean;
  saving: boolean;
  savedAtMs: number | null;
  writeError: unknown;
}): ReactElement {
  const line = saveLine(note.updatedAt, { pending, saving, savedAtMs, writeError });
  return (
    <p
      className={cn(
        "m-0 min-w-0 truncate text-xs",
        line.tone === "destructive" ? "text-destructive" : "text-dim",
      )}
    >
      {line.text}
    </p>
  );
}

/**
 * Delete a note, and say what goes with it.
 *
 * **The question is asked before the press and not after it**, which is this repo's shape for a
 * destructive control (`metaRows`' `CONFIRM_*` recipes, whose third consumer is already outside
 * the dialogs they were written for). It matters more here than in a deck band: `sticky_notes`
 * records no audit row and no undo step — the spec refuses both, because a note hangs off no deck
 * and neither table has a shape for it — so this press is the only thing standing between a
 * reader and prose with no way back.
 *
 * The caret comes into the **question** rather than onto a button in it: the reader has not
 * decided yet, and a stray Enter must not decide for them. That pairing is `useConfirmFocus`'s and
 * cannot be taken by halves.
 */
function DeleteNote({
  title,
  onDelete,
  onCancel,
}: {
  title: string;
  onDelete: () => void;
  onCancel: () => void;
}): ReactElement {
  const confirm = useConfirmFocus(`Delete ${title}`);

  return (
    <div {...confirm}>
      <p className="text-xs">Delete “{title}”?</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        The note goes for good, on this device and on every device it has synced to.
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onDelete} className={CONFIRM_DESTRUCTIVE}>
          Delete note
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </div>
    </div>
  );
}
