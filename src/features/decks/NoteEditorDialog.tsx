/**
 * Where a note is written — **the one editor in this feature, and the only door to Tiptap**.
 *
 * `NoteEditor` arrives through `React.lazy` over a dynamic import, which is the whole of why a
 * band showing twenty notes costs the main chunk nothing: 141.5 kB gzip against the app's own
 * 481.45 kB. That rule got *stronger* with the redesign rather than weaker — the editor used to
 * unfold inside a row and is now behind a press that opens a dialog, so a band that is merely read
 * loads none of it. **Nothing in this app may reach that module with a static import**;
 * `DeckNotesPanel.test.tsx` sweeps every source file for one, and this file holds the app's only
 * reference of any kind.
 *
 * **Three modes, one dialog, and the only differences are three strings.** A create, a create the
 * card menu asked for, and an edit differ in the heading, the button's verb and whether a card
 * comes along; the surface, the footer and the draft state are one thing. Two dialogs would be two
 * places to keep the naming rule.
 *
 * **There is no title field, and that is the redesign's own sentence.** Every note this dialog
 * writes is written with `title: ""`, and `noteTitle()` answers the first line — which is what it
 * already did for a blank title. The rule is taught by the surface's placeholder
 * (`NOTE_PLACEHOLDER`, in `NoteEditor.tsx`), because a rule with nothing saying it is a rule the
 * reader breaks.
 *
 * **Save is refused on an empty body**, which is the add row's old rule arriving at the new door:
 * with no title to stand in, a blank save makes a note called `Untitled note` with nothing in it,
 * and the reader's only recourse is to delete it. `noteToPlainText` and not the markdown string —
 * an empty ProseMirror document is not an empty string.
 */
import { lazy, Suspense, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import type { DeckNote, DeckNoteCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { noteTitle } from "./deckNotes";
import { CONFIRM_CANCEL, META_SUBMIT } from "./metaRows";
import { noteToPlainText } from "./noteMarkdown";

/**
 * **The app's one reference to the editor, and it is deliberately the only one.**
 *
 * A static import anywhere on a path the main chunk reaches puts Tiptap back in it — and the app
 * still builds, still passes and still runs, so the only tell is a bundle a third bigger.
 */
const NoteEditor = lazy(() => import("./NoteEditor"));

/** What the dialog was opened to do. `note` is an edit; `card` is a create the card menu asked
 *  for; `new` is a plain New note. */
export type NoteDraft =
  | { kind: "new" }
  | { kind: "newFromCard"; card: Pick<DeckNoteCard, "oracleId" | "name"> }
  | { kind: "edit"; note: DeckNote };

export interface NoteEditorDialogProps {
  open: boolean;
  draft: NoteDraft;
  /** The write is in flight. **The other kind of no**, and the one that really is the `disabled`
   *  attribute — see {@link SAVE}. */
  pending: boolean;
  /**
   * The body the reader typed, as markdown.
   *
   * The host turns it into `{ title, body, oracleIds }` for a create or `{ id, patch }` for an
   * edit — **this dialog only knows what the reader typed**, and which mutation that is is a fact
   * about the draft it was opened with rather than about the surface.
   */
  onSave: (body: string) => void;
  onClose: () => void;
}

/**
 * The affirmative, in the app's ordinary submit shape plus the paint its **blank** state needs.
 *
 * `META_SUBMIT` greys on the `disabled` attribute, which is the right and only greying for the
 * rows it was written for. This button has two kinds of no and only one of them is that attribute
 * (see {@link Body}), so the same three clauses are spelled again in the `aria-disabled` variant —
 * without them the button would *say* it is out of reach and go on looking pressable. Adding them
 * here rather than to the recipe is `src/CLAUDE.md`'s rule about `PRESS`: what a control does when
 * it is out of reach is the site's fact, not the recipe's, and `META_SUBMIT`'s other callers grey
 * on the attribute alone.
 */
const SAVE = cn(
  META_SUBMIT,
  "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-accent",
);

export function NoteEditorDialog({
  open,
  draft,
  pending,
  onSave,
  onClose,
}: NoteEditorDialogProps): JSX.Element {
  // The note's stored name rather than the draft's first line: the heading says which note is
  // being edited, and a heading that renamed itself under the reader's hands as they typed would
  // be the one thing on screen that stopped identifying what they opened.
  const heading = draft.kind === "edit" ? noteTitle(draft.note) : "New note";

  return (
    <Dialog
      open={open}
      title={heading}
      // Said here rather than in the body, because it is a fact about what the dialog was opened
      // to do and not about what has been typed into it. The attachment itself is the host's
      // write — this line is the promise the press already made.
      subtitle={draft.kind === "newFromCard" ? `This note will name ${draft.card.name}` : undefined}
      closeLabel="Close the note editor"
      size="w-[40rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <Body draft={draft} heading={heading} pending={pending} onSave={onSave} onClose={onClose} />
    </Dialog>
  );
}

/**
 * The draft, the surface and the footer — **separate for {@link Dialog}'s reason**, and here that
 * reason is the whole of how the draft is managed.
 *
 * A closed dialog mounts no children, so every open starts on a fresh `useState` seeded from the
 * draft it was handed and there is nothing to reset. **No effect syncs `body` back to the prop**:
 * one would fire on the render after every keystroke that changed nothing and would fight the
 * reader for their own text, and `react-hooks/set-state-in-effect` refuses the shape outright.
 */
function Body({
  draft,
  heading,
  pending,
  onSave,
  onClose,
}: {
  draft: NoteDraft;
  heading: string;
  pending: boolean;
  onSave: (body: string) => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState(draft.kind === "edit" ? draft.note.body : "");

  // An edit is a note that already exists and the verb says only what the press does to it; a
  // create has to name the thing it is about to make, because `Save` alone on a dialog a reader
  // opened from a card menu says nothing about what is being saved.
  const verb = draft.kind === "edit" ? "Save" : "Save note";

  // **Through `noteToPlainText` and never the markdown string.** An empty ProseMirror document
  // serialises to `""` today and a body of nothing but `#` or `-` would not — what is being asked
  // is whether the reader wrote any words, which is a question about the text and not the markup.
  const blank = noteToPlainText(body).trim() === "";

  return (
    <>
      {/* The floor is the surface's own plus room for the toolbar above it, so the dialog does
          not grow under the reader as the lazy chunk lands — a panel that jumped 200px the
          moment Tiptap arrived would move the footer out from under a press already on its way. */}
      <div className="min-h-60 px-5 py-4">
        {/* A sentence rather than a spinner: the chunk arrives off local disk, so what a reader
            actually sees is one frame of type, and a spinner for one frame is a flash. */}
        <Suspense fallback={<p className="text-[0.6875rem] text-dim">Opening the editor…</p>}>
          <NoteEditor value={body} onChange={setBody} ariaLabel={`Body of ${heading}`} />
        </Suspense>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" onClick={onClose} className={CONFIRM_CANCEL}>
          Cancel
        </button>

        <button
          type="button"
          // **Two kinds of no, and only one of them is the attribute.** `pending` is the
          // half-second a write is in flight and really does take the button out of reach.
          // `blank` greys and un-greys as the reader types, and a real `disabled` control leaves
          // the tab order — so a reader who cleared their last word would find the caret thrown
          // out of the footer by their own press. `PullFromCollectionDialog`'s pull button is
          // this exact pairing.
          disabled={pending}
          aria-disabled={blank || undefined}
          // The guard the paint would otherwise be lying about: an `aria-disabled` control still
          // delivers its press.
          onClick={() => {
            if (blank) return;
            onSave(body);
          }}
          className={SAVE}
        >
          {verb}
        </button>
      </footer>
    </>
  );
}
