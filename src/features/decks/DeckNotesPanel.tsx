/**
 * What the reader has written down about this deck, as a band at the foot of the editor.
 *
 * A note belongs to the **deck**. It may name any number of cards and it stays in this list
 * whether it names none or four — that is the issue's central sentence (*"the card should only
 * serve as a reference"*), and it is why the attachments hang off the note rather than the note
 * hanging off a card. Nothing here can make a note invisible by attaching one.
 *
 * ## Four placement constraints, and each one is already paid for elsewhere
 *
 * - **A `<section>`, never an `<aside>`.** A second complementary landmark answered
 *   `getByRole("complementary")` and broke five of `App.test.tsx`'s pane assertions without
 *   touching the pane — the Deck stats band records it. A landmark is a promise about the page,
 *   and this block is not a complementary one.
 * - **`shrink-0` is mandatory.** The editor's root is the only box in it with a height, and
 *   `shrink-0` on the bands below the desk is the whole of why that editor scrolls. Without it
 *   this band is squeezed to nothing on a deck taller than the window, which is every deck a
 *   reader writes notes about.
 * - **Below the price strip, and below the Deck stats band.** The pair that may not be split is
 *   the deck and the strip: the remove tray is drawn on that strip for the length of a drag, at
 *   `-top-3` reaching up into the editor column's own `gap-3`, so anything inserted between them
 *   would put a wall of prose between a card in the air and the one drop that takes it out. This
 *   band is the page's last thing — the tokens wall is a list of cards, the stats band is four
 *   charts read at a glance, and a notebook is what a reader opens deliberately.
 * - **The disclosure is always a control, even at zero notes**, which is where this band parts
 *   company with `DeckTokensPanel`. That one draws its heading as plain type on a deck that makes
 *   nothing, because there is nothing to disclose and a greyed control would spend the whole deck
 *   refusing. Here there is always something under it: on an empty deck the region holds the
 *   sentence that says what the band is for and points at the control that fills it. A heading
 *   that greyed while the `New note` button beside it went on working would be the area saying it
 *   is unavailable at the one moment it is not.
 *
 * ## One act, and it is in the header
 *
 * Making a note is a press on `New note`, beside the count, which opens {@link NoteEditorDialog}.
 * **That replaced an add row** — a title field and a submit sitting above a list a reader with no
 * notes did not have yet — and the reason is that a control in the heading is the same offer
 * without a form standing in for one. It is also drawn while the band is shut, so the offer does
 * not depend on the disclosure.
 *
 * ## Reading loads no editor, and that is a bundle rule rather than a preference
 *
 * A note is drawn by {@link NoteCard}, over `parseNoteBody`'s blocks — a small closed reader
 * over the dialect `noteMarkdown.ts` pins, modelled on `src/lib/releaseNotes.ts`, with no library
 * and no HTML string anywhere near it (the shipped CSP is `script-src 'self'` and nothing in
 * `src/` uses `dangerouslySetInnerHTML`). **Writing** mounts Tiptap, and Tiptap is **141.5 kB
 * gzip** against the app's own 481.45 kB — measured with `esbuild --bundle --minify`, React
 * external, `gzip -9`, 2026-09-10. So `NoteEditor` is reached through `React.lazy` from
 * **`NoteEditorDialog.tsx` and nowhere else**: that file holds the app's only reference of any
 * kind, this one holds none at all, and `DeckNotesPanel.test.tsx` sweeps every source file in
 * `src/` for a static import — because one of those puts the whole chunk back in the main bundle
 * and *nothing anywhere goes red*.
 *
 * ## Two components, and the split is where the database stops
 *
 * {@link DeckNotesPanel} is the wiring — the query, the five writes, and the deck's own cards for
 * the picker. {@link NotesBand} is everything drawn, over plain props. That is `DeckStats`'
 * arrangement and it is what lets the workbench stand this band up in the six states that matter
 * — including a refused read, which no seed can produce and no fault reaches.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { DeckCard, DeckNote, DeckNoteCard } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { attachableCards, noteTitle, type NoteCardChoice } from "./deckNotes";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, META_SUBMIT } from "./metaRows";
import { NOTE_GAP, NoteCard, type NoteFocus } from "./NoteCard";
import { NoteCardsDialog } from "./NoteCardsDialog";
import { NoteEditorDialog } from "./NoteEditorDialog";
import { useDeckNotes } from "./useDeckNotes";

/**
 * The area's name, in one place because three things say it: the region's `aria-label`, the
 * disclosure's visible text, and every test and story that addresses either.
 *
 * Bare `Notes`, and the word is safe here in a way `Tokens` was not one band over: the deck's
 * *label* is the coloured per-card mark and is never called a note, the collection's own
 * free-text column is a different table on a different page, and the release notes live in
 * Settings. Nothing in the deck editor spells this word for anything else.
 */
export const NOTES_HEADING = "Notes";

export interface DeckNotesPanelProps {
  deckId: number;
  /**
   * The deck's own cards, as the editor is already drawing them — what the attach picker offers,
   * deduped here by {@link attachableCards}.
   *
   * **Handed in rather than read again, and that is a measured call rather than tidiness.** This
   * band mounted `useDeck(deckId, variant)` for one control's worth of card names, which is
   * `CategoriesDialog`'s arrangement and looked free: the editor above has the same query in
   * flight under the same key. It is free only while that query is **fresh**. The band is gated
   * on the deck row, so it mounts *after* the first read settles — a second observer arriving on
   * a stale query refetches, and the app's 30 s `staleTime` is the only thing standing between
   * that and a second `deck_get` per deck opened. Four tests in `DeckEditor.test.tsx` went red on
   * exactly that (their client has no `staleTime`), which is the failure stated honestly rather
   * than a fixture's problem.
   *
   * **Which list they came from is the editor's answer**, which is why there is no `variant` here
   * and none on {@link useDeckNotes} either: `deck_notes` carries no variant column, a note
   * written against the plan shows on the actual list too, and the only thing the word ever
   * decided in this band was which cards were on screen to attach.
   */
  cards: readonly DeckCard[];
  /** `decks.notes_open`. Collapsed is what every deck on every disk is — the column is
   *  `DEFAULT 0` because this band is new, so a shut default takes nothing from anybody. */
  open: boolean;
  onToggle: (next: boolean) => void;
  /**
   * **A note act asked for from somewhere else in the editor — the card menu's two rows**
   * (issue #447).
   *
   * The band is the only thing on the page that can honour one: it holds the notes query, the
   * five writes and the one-layer-at-a-time state, and a menu row that reached any of those
   * itself would be a second spelling of all three. So `deckCardMenu.tsx`'s `Add note…` and
   * `Notes ▸` hand their answer up to `DeckEditor`, which parks it here — the shape
   * `quickCategory` already uses for a drop that has to survive until a dialog answers.
   *
   * **`null` is the resting state and the only one that means nothing is owed.** A *handled*
   * request is cleared by the host through {@link DeckNotesPanelProps.onRequestHandled}, so the
   * prop is never a standing instruction the band re-runs.
   */
  request?: DeckNoteRequest | null;
  /**
   * Called once the band has acted on {@link DeckNotesPanelProps.request}, so the host can clear
   * it.
   *
   * **"Acted on" is *taken*, not *finished*, and for `add` those are two different moments.** The
   * create is a round trip; waiting for it would leave a refused write's request standing for the
   * rest of the session, and the second press a reader made after nothing happened would be
   * refused as a duplicate of a request the band had already consumed. The band's own refusal
   * line is what says a create did not land.
   */
  onRequestHandled?: () => void;
}

/**
 * One act the card menu asks the band for.
 *
 * Two members and deliberately not one with a flag: `add` carries a **card** because a note born
 * from a card menu names that card as it is written, and `open` carries a **note id** because
 * the note already exists. Neither field means anything to the other arm, and a single shape
 * carrying both optional would let a caller ask for an add of nothing.
 *
 * `DeckNoteCard` rather than a `DeckCard`, which is what the menu holds: the two fields here are
 * the whole of what a note needs — the identity it attaches by, and the word to print — and a
 * deck row carries a printing, a pile, a finish and a quantity that a note has no use for.
 * **`oracleId` is `string` and not `string | null`**, which is what makes an orphan printing
 * unrepresentable rather than merely refused: see `DeckEditor`'s `addNote` for the row that is
 * absent because of it.
 *
 * **A `Pick` since the printing landed**, and the two fields are still the whole of what a note
 * needs to be born: the identity it attaches by, and the word to print. A representative printing
 * is a fact the *read* resolves, so a request that carried one would be the menu guessing at an
 * answer the database is about to give.
 */
export type DeckNoteRequest =
  | { kind: "add"; card: Pick<DeckNoteCard, "oracleId" | "name"> }
  | { kind: "open"; noteId: number };

/**
 * The band, wired.
 *
 * **The read runs whether or not the list is drawn**, which is `DeckTokensPanel`'s call and its
 * reason: the header says how many notes this deck holds, and that number *is* the reason to open
 * the area. Gating the query on `open` would trade it for a header that could only say "press to
 * find out".
 *
 * **One query and no second one**, which is what {@link DeckNotesPanelProps.cards} is for: the
 * deck's own cards arrive as a prop rather than through a second `useDeck`, because a second
 * observer mounting on a stale query is a second `deck_get`.
 */
export function DeckNotesPanel({
  deckId,
  cards,
  open,
  onToggle,
  request = null,
  onRequestHandled,
}: DeckNotesPanelProps): JSX.Element {
  const notes = useDeckNotes(deckId);
  const attachable = useMemo(() => attachableCards(cards), [cards]);

  /** Which note the band has been sent to, once there is one to point at. It outlives the request
   *  that produced it: it is where the reader was *put*, not an instruction still owed. */
  const [focus, setFocus] = useState<NoteFocus | null>(null);

  /** The newest request this band has taken — see the adjustment below. */
  const [taken, setTaken] = useState<DeckNoteRequest | null>(null);

  /**
   * Take the host's request, **once per request object**.
   *
   * ⚠️ **Written during render rather than in an effect, and that is a rule of this repo rather
   * than a style.** eslint's `react-hooks/set-state-in-effect` refuses a `setState` in an effect
   * body outright — and `tsc` and the whole vitest suite are green on the pattern it refuses, so
   * it only goes red at `npm run verify`. What is left is React's own *adjusting state when a prop
   * changes*: the component sets its **own** state during render, React re-runs it before
   * committing anything, and no child ever sees the stale value.
   *
   * **Identity and not an id, because two requests can be equal and still be two presses.** A
   * reader who right-clicks one card twice means two notes; `DeckEditor` builds a fresh object per
   * press, so comparing the object is what tells *asked again* from *rendered again*.
   *
   * `open` resolves to a focus here because the note already exists. `add`'s cannot, and that
   * asymmetry is the whole reason {@link NoteFocus} is a second type: there is no id until the
   * create answers with one.
   */
  if (request !== null && request !== taken) {
    setTaken(request);
    if (request.kind === "open") setFocus({ noteId: request.noteId, edit: false });
  }

  // `mutate` off the mutation rather than the mutation object, because the object is rebuilt on
  // every render of this component and `mutate` is not — so the effect below names one dependency
  // that actually holds still.
  const createNote = notes.create.mutate;

  /**
   * Everything taking a request *does* — the disclosure, the write, and the hand-back.
   *
   * ⚠️ **The ref is the whole of the idempotency and it is not decoration.** This effect names
   * `open` among its dependencies and its own first act is to change `open`, so it re-runs at
   * least once for every request it honours — and without the guard that second run is a second
   * note, made silently, on a press the reader made once. `main.tsx` wraps the app in
   * `React.StrictMode`, which runs a mount effect **twice** in development, and a `useRef`
   * survives that double invocation where a local flag would not: same fiber, same ref object. So
   * a guard written any other way passes in a release build and doubles every note under
   * `tauri dev`.
   *
   * **No `setState` of this component's own in the body** — see the adjustment above. The two
   * writes made from here are a prop callback and a mutation's `onSuccess`, which is the callback
   * shape that rule exists to leave alone.
   *
   * **`onRequestHandled` is called here rather than in that `onSuccess`** — see
   * {@link DeckNotesPanelProps.onRequestHandled} for why a refused write must not leave a request
   * standing.
   */
  const acted = useRef<DeckNoteRequest | null>(null);
  useEffect(() => {
    if (taken === null || acted.current === taken) return;
    acted.current = taken;

    // Both kinds open the band and neither closes it: a note a reader asked to read or to write
    // is one they cannot do either to behind a shut disclosure. `onToggle` rather than a local
    // flag, because the answer is `decks.notes_open` — so the band is open again next time, which
    // is what they just said they wanted.
    if (!open) onToggle(true);

    if (taken.kind === "add") {
      // **Titled with the card's name, and the card attached in the same write.** This is the one
      // note in the feature that is born with a title, and the reason is that it is also the one
      // born *before* its body: a blank one would read `Untitled note` in the band and in that
      // card's own `Notes ▸` submenu the moment it appears, which is a row with no identity in a
      // list of rows — where every note written through {@link NoteEditorDialog} has a body by
      // the time it exists and `noteTitle` answers its first line. `oracleIds` is what *names*
      // the card, in the same transaction, so the note turns up under this card's submenu on the
      // next read with no attach step to lose.
      //
      // **The scoped `onSuccess` is safe here where it is a defect in the label chain**
      // (`deckCardMenu.tsx`'s `addLabel`): that callback belongs to the *observer*, and the
      // observer there is a dialog the reader can dismiss mid-flight. This observer is the band,
      // which outlives the menu — and were it to unmount there would be no editor left to open.
      createNote(
        { title: taken.card.name, body: "", oracleIds: [taken.card.oracleId] },
        { onSuccess: (note) => setFocus({ noteId: note.id, edit: true }) },
      );
    }

    onRequestHandled?.();
  }, [taken, open, onToggle, createNote, onRequestHandled]);

  return (
    <NotesBand
      open={open}
      onToggle={onToggle}
      focus={focus}
      notes={notes.notes}
      attachable={attachable}
      answered={notes.query.isSuccess}
      failure={notes.failure}
      pending={notes.pending}
      // **`title: ""` on every note this band writes**, which is the redesign's own sentence:
      // there is no title field anywhere in {@link NoteEditorDialog}, and `noteTitle()` answers
      // the body's first line — the thing it already did for a blank title.
      onCreate={(body, oracleIds) => notes.create.mutate({ title: "", body, oracleIds })}
      onSave={(id, patch) => notes.update.mutate({ id, patch })}
      onDelete={(id) => notes.remove.mutate(id)}
      onAttach={(noteId, oracleId) => notes.attach.mutate({ noteId, oracleId })}
      onDetach={(noteId, oracleId) => notes.detach.mutate({ noteId, oracleId })}
    />
  );
}

export interface NotesBandProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  /**
   * The note the band has been sent to, or `null` — {@link DeckNotesPanel}'s answer to a request
   * from the card menu.
   *
   * **Optional and defaulting to `null`, so the workbench and every existing caller are
   * unchanged.** A band nobody has sent anywhere behaves exactly as it did.
   *
   * It stays set after it has been honoured, which is what keeps this from being an instruction:
   * the band acts on the object's *identity*, so a reader who closes the editor this opened does
   * not have it reopened under them on the next render.
   */
  focus?: NoteFocus | null;
  /** Every note on the deck, in `sort_order`. */
  notes: readonly DeckNote[];
  /** What the attach picker offers — see {@link attachableCards}. */
  attachable: readonly NoteCardChoice[];
  /**
   * The read has landed.
   *
   * **`isSuccess` and not `!loading`**: "this deck has no notes" and "nothing has answered yet"
   * are two sentences, and a refused read is neither pending nor holding any rows. Captioning
   * that *no notes* would be the app asserting a fact it does not have.
   */
  answered: boolean;
  /** The band's one refusal line — `sectionFailure`'s: the newest write, or the read when no
   *  write has been refused. */
  failure: string | null;
  /** A write is in flight. */
  pending: boolean;
  /** A new note: the body the reader typed, and the cards it is born naming.
   *  **`title` is not a parameter** — every note this band writes is written with `title: ""`, and
   *  `noteTitle()` answers the first line. See {@link NoteEditorDialog}. */
  onCreate: (body: string, oracleIds: string[]) => void;
  onSave: (id: number, patch: { title: string; body: string }) => void;
  onDelete: (id: number) => void;
  onAttach: (noteId: number, oracleId: string) => void;
  onDetach: (noteId: number, oracleId: string) => void;
}

/**
 * The one layer this band has open, or `null`.
 *
 * **`panels.ts`' shape, one file over**, and for its reason: three booleans that must never be two
 * at once become one value that structurally cannot be. The band used to hold `editing`,
 * `confirming` and `picking` as three `number | null`s kept exclusive by an `only()` helper — a
 * rule enforced by everybody remembering to call it.
 *
 * `newNote` and `newFromCard` carry no id because there is no row yet: the create happens on Save.
 *
 * ⚠️ **`newFromCard` is spelled here and nothing in this file raises it yet.** The card menu's
 * `add` still writes its note straight away, titled with the card and naming it in the same
 * transaction — see {@link DeckNotesPanel}'s request effect for why that one note is born with a
 * title, and why moving that path behind this dialog is a change to the request contract rather
 * than to this union. The arm is drawn because {@link NoteEditorDialog} already answers it and
 * {@link NotesBand} is the only surface that could ever express it; the dialog's own workbench
 * covers the draft, and this band has no story for it.
 */
type NotePanel =
  | { kind: "newNote" }
  | { kind: "newFromCard"; card: Pick<DeckNoteCard, "oracleId" | "name"> }
  | { kind: "edit"; note: DeckNote }
  | { kind: "cards"; note: DeckNote }
  | { kind: "confirm"; note: DeckNote }
  | null;

/**
 * Everything the band draws, over plain props — the half of this file with no database behind it.
 *
 * **One layer at a time, and {@link NotePanel} is what makes that structural.** Every one of the
 * three things a reader can do to a note opens a dialog over the page rather than a panel
 * unfolding under a card, so the grid never has a hole in it and the three card actions are never
 * greyed — there is no state of *this* card a press could honestly be refused for.
 */
export function NotesBand({
  open,
  onToggle,
  focus = null,
  notes,
  attachable,
  answered,
  failure,
  pending,
  onCreate,
  onSave,
  onDelete,
  onAttach,
  onDetach,
}: NotesBandProps): JSX.Element {
  const bodyId = useId();
  const [panel, setPanel] = useState<NotePanel>(null);

  /**
   * The panel's note as the read currently holds it — `null` once it has gone, which shuts the
   * dialog rather than leaving one drawing a row nothing answers for.
   *
   * ⚠️ Another window on the same collection may delete a note this one has open;
   * `docs/reference/multi-window.md` is why that is a live case and not a hypothesis. A panel
   * holds the note **object** rather than its id — which is what lets `noteTitle`, the card list
   * and the body be read without a second lookup — so the freshness has to be re-established at
   * draw time, here, once, for all three dialogs.
   */
  const live = useMemo(() => {
    if (panel === null || !("note" in panel)) return null;
    return notes.find((n) => n.id === panel.note.id) ?? null;
  }, [panel, notes]);

  /** The focus this band has already opened a panel for — see the adjustment below. */
  const [sentTo, setSentTo] = useState<NoteFocus | null>(null);

  /**
   * A note the band was sent to, opened for writing where it was sent there to be written.
   *
   * **Only `edit` touches this state**, which is the whole of the read/write split the two menu
   * rows make: `Add note…` ends in a body the reader is about to type and `Notes ▸` ends in one
   * they came to read — so an `open` reaching in here would put a card they wanted to *look* at
   * behind 141.5 kB of ProseMirror, and shut whatever dialog they already had open on the way.
   * Bringing the card into view is {@link NoteCard}'s half and happens for both.
   *
   * **During render and not in an effect**, for {@link DeckNotesPanel}'s reason —
   * `react-hooks/set-state-in-effect`, and React's own *adjusting state when a prop changes*.
   * Comparing the focus **object** is what lets a reader shut an editor this opened without it
   * being reopened under them on the next render: closing writes `panel`, and `sentTo` is
   * untouched until a genuinely new focus arrives.
   *
   * ⚠️ **An `edit` focus is taken only once the note it names is in `notes`, and the wait is
   * load-bearing.** The id arrives from the create's `onSuccess`, which runs before the
   * invalidation it fired has refetched — so on the render the focus first appears the row does
   * not exist yet. Recording `sentTo` there and finding nothing would consume the focus and open
   * nothing at all, for ever. Nothing is recorded until there is a note to open on, so the
   * adjustment simply runs again on the render the read lands in.
   */
  if (focus !== sentTo) {
    const wanted =
      focus !== null && focus.edit ? (notes.find((n) => n.id === focus.noteId) ?? null) : null;
    if (focus === null || !focus.edit || wanted !== null) {
      setSentTo(focus);
      if (wanted !== null) setPanel({ kind: "edit", note: wanted });
    }
  }

  return (
    // The Deck stats band's grammar, character for character: a rule and the content under it.
    // That is the shape the toolbar above the deck is in too, and a surface, a border and a
    // radius here would say *a panel you opened*, which this is not.
    <section aria-label={NOTES_HEADING} className="shrink-0 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          // `aria-expanded` on the control and `aria-controls` at the region it acts on: the pair
          // is what says *what* the press does rather than only that a press happened. The region
          // below is always in the tree — empty while shut, never absent — so the id this names
          // always resolves, which is the one thing neither attribute complains about when it
          // stops being true.
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(!open)}
          className={cn("flex items-center gap-1.5 rounded-md text-sm text-text", PRESS, FOCUS)}
        >
          {/* One glyph rotated, never two swapped: a different element in the same slot teleports
              rather than turning. Both bands above draw their disclosure this way. */}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {NOTES_HEADING}
        </button>

        {/* The count is its own element, so nothing computes it into the disclosure's name — and
            it is honest as a figure because the heading is set in type immediately beside it and
            says what is being counted. Drawn only once the read has landed: a bare `0 notes`
            under a refused read would be a number the app does not have. */}
        {answered && notes.length > 0 && (
          <span className="text-xs text-dim">{plural(notes.length, "note")}</span>
        )}

        {/* **The band's one act, and it is in the header rather than over the list.** The add row
            it replaces was a field and a submit sitting above a list a reader with no notes did
            not have yet; a control in the heading is the same offer without a form standing in
            for one. Outside the collapsible region, so the offer does not depend on the
            disclosure — and `ml-auto` puts it at the far end of the row rather than hard against
            the count. */}
        <button
          type="button"
          onClick={() => setPanel({ kind: "newNote" })}
          className={cn("ml-auto inline-flex items-center gap-1.5", META_SUBMIT)}
        >
          {/* `inline-flex items-center gap-1.5` on the button is what puts the glyph beside the
              word: `META_SUBMIT` is geometry and colour only and names no `display`, which is the
              trap the toolbar's first chip with a glyph in it fell into. */}
          <Plus aria-hidden="true" className="size-3.5 shrink-0" />
          New note
        </button>
      </div>

      {/* Outside the collapsible region on purpose: a read refused while the band is shut still
          owes the reader a sentence, and the alternative is a band that silently counts nothing.
          One line for the read and the writes alike — `sectionFailure` has already decided which
          of them is still news. */}
      {failure !== null && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {failure}
        </p>
      )}

      {/* Always in the tree so `aria-controls` above always names something, and empty while the
          area is shut so a closed band costs no editor, no picker and no state.
          **`select-text` because a note is the one thing on this page written to be read** — the
          editor refuses text selection at its root (issue #473), and a note a reader cannot copy
          a line out of is a note they have to retype. */}
      <div id={bodyId} className="select-text">
        {open && (
          <div className="mt-3 flex flex-col gap-3">
            {/* Four states and only three sentences, which is the point: a **refused** read has
                no rows and is not pending either, so captioning it *no notes* or *reading…*
                would both be the app asserting something it does not know. The alert above has
                already said what happened, so this says nothing at all. */}
            {notes.length > 0 ? (
              /* **A masonry, not a grid of equal tiles** — `masonry.ts`, and `NoteCard` for the
                 argument. `repeat(auto-fill, minmax(280px, 1fr))` is CSS counting how many cards
                 fit on a line, which is the one number this band refuses to work out for itself:
                 four up at the editor column's 1192px, two from about 860, one below about 580.

                 **`gridAutoRows: 1px` and `rowGap: 0`, and the vertical gutter lives inside each
                 card's span.** A grid gap is drawn at every row boundary an item *crosses*, so a
                 card spanning 200 one-pixel rows would carry 199 gutters inside itself.
                 `NOTE_GAP` is added to each span instead, which puts it exactly once under each
                 card — at the cost of one trailing gutter under the last card of every column.

                 **`items-start` is load-bearing.** It keeps each card its own height, and that
                 same content-sizing is what makes the measurement safe: a card's height cannot
                 depend on the span it was given, so measure → span → measure cannot oscillate. */
              <ul
                className="grid items-start"
                style={{
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gridAutoRows: "1px",
                  columnGap: NOTE_GAP,
                  rowGap: 0,
                }}
              >
                {notes.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    // The focus object itself and never a boolean: two presses on one note are
                    // two objects and one `true`, so a boolean would bring the card into view the
                    // first time and do nothing the second — which is exactly the press a reader
                    // makes when it has scrolled away again.
                    focused={focus !== null && focus.noteId === note.id ? focus : null}
                    onEdit={() => setPanel({ kind: "edit", note })}
                    onCards={() => setPanel({ kind: "cards", note })}
                    onDelete={() => setPanel({ kind: "confirm", note })}
                  />
                ))}
              </ul>
            ) : answered ? (
              <p className="text-xs text-dim">
                No notes on this deck yet — press <span className="text-text">New note</span> to
                write one.
              </p>
            ) : failure === null ? (
              <p className="text-xs text-dim">Reading this deck&rsquo;s notes…</p>
            ) : null}
          </div>
        )}
      </div>

      {/* The three dialogs, inside the `<section>` and outside the collapsible region — a dialog
          is drawn over the page rather than under the heading, and one whose note was opened from
          a card menu must not vanish with a disclosure the reader then shuts.

          **`live` and never `panel.note` wherever a dialog draws the note**, so a note deleted
          from another window takes its dialog with it rather than leaving one addressing a row
          nothing answers for. */}
      <NoteEditorDialog
        open={
          panel?.kind === "newNote" ||
          panel?.kind === "newFromCard" ||
          (panel?.kind === "edit" && live !== null)
        }
        draft={
          panel?.kind === "edit" && live !== null
            ? { kind: "edit", note: live }
            : panel?.kind === "newFromCard"
              ? { kind: "newFromCard", card: panel.card }
              : { kind: "new" }
        }
        pending={pending}
        // ⚠️ **The note's existing title goes back unchanged.** `deck_note_update` takes both
        // columns and has no patch shape a caller can half-fill usefully, and the labels dialog
        // one file over is where this app learned what happens otherwise: two controls each
        // sending the other's field back is how a rename quietly undoes a recolour. This dialog
        // edits the body only, so the title travels with it untouched — and on a note written
        // through it that title is `""`, which is exactly what it should stay.
        onSave={(body) => {
          if (panel?.kind === "edit" && live !== null) onSave(live.id, { title: live.title, body });
          else onCreate(body, panel?.kind === "newFromCard" ? [panel.card.oracleId] : []);
          setPanel(null);
        }}
        onClose={() => setPanel(null)}
      />

      {panel?.kind === "cards" && live !== null && (
        <NoteCardsDialog
          open
          // `noteTitle` here rather than in the dialog, so the heading the picker draws and the
          // name the card it was opened from carries are one computation.
          title={noteTitle(live)}
          named={live.cards}
          attachable={attachable}
          onAttach={(oracleId) => onAttach(live.id, oracleId)}
          onDetach={(oracleId) => onDetach(live.id, oracleId)}
          onClose={() => setPanel(null)}
        />
      )}

      {panel?.kind === "confirm" && live !== null && (
        <DeleteNoteDialog
          open
          title={noteTitle(live)}
          cardCount={live.cards.length}
          pending={pending}
          onDelete={() => {
            onDelete(live.id);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      )}
    </section>
  );
}

/**
 * Delete a note, and say what goes with it.
 *
 * **The cards are the clause worth spelling.** `deck_note_cards` cascades with the note, so the
 * attachments go — and a reader who has just spent a press naming four cards has every reason
 * to think the press might reach further than the note. It does not: the cards themselves are in
 * the deck and stay there, which is the half a confirmation can say before the press rather than
 * after it.
 *
 * **A `Dialog` rather than a box unfolding under the card**, which is what it was: the band is a
 * masonry now, and a question that grew inside one card would reflow every card after it at the
 * moment the reader was reading the question. It is also what retired `useDestructiveFocus` and
 * `useConfirmFocus` — a dialog takes the caret into its own panel as it opens, so there is no
 * hand-back for this component to arrange and no `role="group"` landing pad to focus.
 *
 * The button order is the band's old one: the destructive act first and the way out beside it,
 * which is `ClearCategory`'s arrangement and every other confirmation in this folder's.
 */
function DeleteNoteDialog({
  open,
  title,
  cardCount,
  pending,
  onDelete,
  onClose,
}: {
  open: boolean;
  title: string;
  cardCount: number;
  pending: boolean;
  onDelete: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      // The question *is* the heading, so there is no second paragraph asking it. `Dialog` is
      // `aria-labelledby` this, which is what a test and a screen reader address the panel by.
      title={`Delete “${title}”?`}
      closeLabel="Close the delete question"
      // Narrower than the picker's `w-[47.5rem]` and the editor's `w-[40rem]`: the widest thing in
      // it is one sentence, and a question set across 760px reads as a page rather than a prompt.
      size="w-[26rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-dim">
          {cardCount === 0
            ? "The note goes for good."
            : `The note goes for good, and stops naming its ${plural(cardCount, "card")}. The cards themselves stay in the deck.`}
        </p>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" disabled={pending} onClick={onDelete} className={CONFIRM_DESTRUCTIVE}>
          Delete note
        </button>
        <button type="button" onClick={onClose} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </footer>
    </Dialog>
  );
}
