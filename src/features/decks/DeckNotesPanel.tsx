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
 * **The card menu's `Add note…` ends in that same dialog since 2026-09-20**, which is what keeps
 * this heading the band's *one* act rather than one of two. That request used to write its note on
 * the press — titled with the card, naming it in the same transaction — so a note could be born by
 * a route this band drew no control for and a reader who changed their mind had an empty one to
 * find and delete. It seeds the editor with the card instead, and **Save** is the create.
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
import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
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

/**
 * What the card picker is handed while it is shut — one identity, so a band with no dialog open
 * does not rebuild that dialog's memos on every render of the deck editor around it.
 *
 * It exists because the picker is **mounted whether or not it is open**; see the dialogs at the
 * foot of {@link NotesBand} for why.
 */
const NO_NAMED: readonly DeckNoteCard[] = [];

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
   * **"Acted on" is *taken*, not *finished*, and for `add` that is the editor opening rather than
   * a note existing.** Since 2026-09-20 the request reaches no write at all — the create is the
   * dialog's Save, which may come minutes later or not at all — so there is nothing on this path
   * left to wait for. The old shape made the same call for a harder reason, and it is worth
   * keeping: the create *was* here, it is a round trip, and waiting for it would have left a
   * refused write's request standing for the rest of the session, with the second press a reader
   * made after nothing happened refused as a duplicate of a request the band had already consumed.
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
   * **`open` resolves to a focus here and `add` resolves to nothing at all**, which is the
   * asymmetry {@link NoteFocus} is a second type for, now reaching only the one arm: an `open`
   * names a note that exists, and an `add` names a card and no id — there is no row to point at
   * until a Save nobody has made yet answers with one. What an `add` becomes instead is
   * {@link pendingCard}, which is a card and not a focus.
   */
  if (request !== null && request !== taken) {
    setTaken(request);
    if (request.kind === "open") setFocus({ noteId: request.noteId, edit: false });
  }

  /**
   * The card an `Add note…` named, for {@link NotesBand} to open its editor on — or `null`.
   *
   * **A derivation and not a third piece of state**, which is what writing {@link taken} during
   * render buys: the newest request is in hand on the render it arrives, so a `useState` beside it
   * could only restate it a render later, and only through the one shape
   * `react-hooks/set-state-in-effect` refuses.
   *
   * The **identity** is what travels: `taken` holds the host's own request object, so two presses
   * on one card are two `card` objects — which is what lets the band tell *asked again* from
   * *rendered again* with no counter and no id, exactly as the adjustment above does.
   */
  const pendingCard = taken?.kind === "add" ? taken.card : null;

  /**
   * Everything taking a request *does* — the disclosure and the hand-back, and **no write**.
   *
   * ⚠️ **The ref is the whole of the idempotency and it is not decoration.** This effect names
   * `open` among its dependencies and its own first act is to change `open`, so it re-runs at
   * least once for every request it honours; and `main.tsx` wraps the app in `React.StrictMode`,
   * which runs a mount effect **twice** in development. A `useRef` survives that double invocation
   * where a local flag would not: same fiber, same ref object.
   *
   * **What a guard written any other way costs is smaller than it was and is still a defect.** It
   * used to be a second note, made silently, on a press the reader made once — the create ran from
   * here. What is left is a second `onToggle(true)` against a band that is already opening, which
   * is a `decks.notes_open` write and a row in the deck's history for nothing, and a second
   * `onRequestHandled` for one press.
   *
   * **No `setState` of this component's own in the body** — see the adjustment above. Both calls
   * made from here are prop callbacks, which is the callback shape that rule exists to leave
   * alone; the panel the `add` arm opens is {@link NotesBand}'s own state, raised by
   * {@link pendingCard} during that component's render rather than reached into from this effect.
   *
   * **`onRequestHandled` is called here** — see {@link DeckNotesPanelProps.onRequestHandled}.
   */
  const acted = useRef<DeckNoteRequest | null>(null);
  useEffect(() => {
    if (taken === null || acted.current === taken) return;
    acted.current = taken;

    // Both kinds open the band and neither closes it. An `open` is a note the reader came to
    // read, which they cannot do behind a shut disclosure; an `add` writes its note in a dialog
    // over the page and opens the band anyway, so that what they are about to Save has somewhere
    // visible to land rather than disappearing into a section they never opened. `onToggle` rather
    // than a local flag, because the answer is `decks.notes_open` — so the band is open again next
    // time, which is what they just said they wanted.
    if (!open) onToggle(true);

    onRequestHandled?.();
  }, [taken, open, onToggle, onRequestHandled]);

  return (
    <NotesBand
      open={open}
      onToggle={onToggle}
      focus={focus}
      pendingCard={pendingCard}
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
   * The note the band has been sent to, or `null` — {@link DeckNotesPanel}'s answer to an `open`
   * request from the card menu, where {@link NotesBandProps.pendingCard} is its answer to an
   * `add`.
   *
   * **Optional and defaulting to `null`, so the workbench and every existing caller are
   * unchanged.** A band nobody has sent anywhere behaves exactly as it did.
   *
   * It stays set after it has been honoured, which is what keeps this from being an instruction:
   * the band acts on the object's *identity*, so a reader who closes the editor this opened does
   * not have it reopened under them on the next render.
   */
  focus?: NoteFocus | null;
  /**
   * A card the card menu asked for a note about, or `null` — the other half of that answer, and
   * the only thing that raises {@link NotePanel}'s `newFromCard`.
   *
   * **Two props rather than one shape with both fields optional**, which is
   * {@link DeckNoteRequest}'s own argument one layer up: a `focus` names a note that exists and
   * the band *points* at it, this names a card and no note at all and the band *opens an editor*
   * on one it is about to write, and a single shape carrying both would let a caller ask for a
   * note about nothing.
   *
   * Acted on by **identity**, exactly as {@link NotesBandProps.focus} is: two presses on one card
   * are two objects, so an editor the reader dismissed is not reopened under them on the next
   * render, and a second press does reopen it.
   */
  pendingCard?: Pick<DeckNoteCard, "oracleId" | "name"> | null;
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
 * **`newFromCard` has a producer since 2026-09-20, and it is the only one it will ever have** —
 * {@link NotesBandProps.pendingCard}, raised during render on the identity of the card the card
 * menu named. It was spelled here in advance of exactly that change: the request used to write its
 * note on the press, titled with the card and naming it in the same transaction, so a dialog the
 * reader dismissed would have left an empty untitled note in the band every time. What the move
 * costs is that the note reaches that card's own `Notes ▸` submenu one round trip later, on the
 * invalidate after Save.
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
  pendingCard = null,
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
   * Bringing the card into view is {@link NoteCard}'s half and happens for both. **`Add note…`
   * makes its half of that split through {@link NotesBandProps.pendingCard} since 2026-09-20**,
   * and the adjustment below it is this one's twin.
   *
   * **During render and not in an effect**, for {@link DeckNotesPanel}'s reason —
   * `react-hooks/set-state-in-effect`, and React's own *adjusting state when a prop changes*.
   * Comparing the focus **object** is what lets a reader shut an editor this opened without it
   * being reopened under them on the next render: closing writes `panel`, and `sentTo` is
   * untouched until a genuinely new focus arrives.
   *
   * ⚠️ **An `edit` focus is taken only once the note it names is in `notes`, and since 2026-09-20
   * nothing in the app raises one.** Its single producer was the request effect's create, whose
   * `onSuccess` answered with an id before the invalidation it had fired refetched — so on the
   * render the focus first appeared the row did not exist yet, and recording `sentTo` there would
   * have consumed the focus and opened nothing at all, for ever. That create is the dialog's Save
   * now and hands back no focus, so this arm is reachable only through a caller that writes
   * `focus.edit` itself. The wait stays because {@link NoteFocus} still spells the field: it costs
   * one comparison, and a caller that does raise one is owed the guarantee.
   */
  if (focus !== sentTo) {
    const wanted =
      focus !== null && focus.edit ? (notes.find((n) => n.id === focus.noteId) ?? null) : null;
    if (focus === null || !focus.edit || wanted !== null) {
      setSentTo(focus);
      if (wanted !== null) setPanel({ kind: "edit", note: wanted });
    }
  }

  /** The card this band has already opened an editor for — see the adjustment below. */
  const [seeded, setSeeded] = useState<typeof pendingCard>(null);

  /**
   * A card the card menu named, opened as a note that does not exist yet.
   *
   * **During render and on the object's identity**, for {@link NotesBandProps.focus}'s reason and
   * by its mechanism — `react-hooks/set-state-in-effect` refuses a `setState` in an effect body
   * outright, and what is left is React's own *adjusting state when a prop changes*. Comparing the
   * object is what lets a reader dismiss an editor this opened without it being reopened under
   * them on the next render: closing writes `panel`, and `seeded` is untouched until a genuinely
   * new card arrives.
   *
   * **There is no wait here where the adjustment above has one**, and that is the same asymmetry
   * stated a third time: an `edit` focus cannot be honoured until the note it names is in `notes`,
   * while this panel carries the *card* and needs no row at all — the row is what Save makes.
   */
  if (pendingCard !== seeded) {
    setSeeded(pendingCard);
    if (pendingCard !== null) setPanel({ kind: "newFromCard", card: pendingCard });
  }

  /**
   * The header's `New note` — **the one element in this band worth a ref, and the reason is that
   * it is the only control here that outlives the note a dialog was about.**
   *
   * Every other opener is a button on a {@link NoteCard}: a Cards, an Edit or a Delete, each of
   * which goes when its card does. A delete takes its own opener away by construction, and a
   * panel raised during render (the card menu's two rows) never had one on this band at all — so
   * both need somewhere real to send the caret, and this button is on screen whether the band is
   * open, shut or empty.
   */
  const newNoteRef = useRef<HTMLButtonElement>(null);

  /**
   * The control the open dialog was opened from, or `null` for one that has none.
   *
   * ⚠️ **`Dialog` does not hand the caret back, and the contract says so on the prop.** It focuses
   * its own panel as it mounts (`Dialog.tsx`'s mount effect) and restores nothing on the way out;
   * its only other focus path is the `stackedOver` settle, which none of these three dialogs
   * passes. `DialogProps.onDismiss`' own doc spells the division — *"hand focus back to whatever
   * opened the dialog, then close"* — so the hand-back is the **host's**, and this band is the
   * host. Without it a reader who shuts Cards, Edit or Delete lands on `<body>` and their next Tab
   * restarts from the top of the app.
   *
   * **An element read off `document.activeElement` at the press**, which is `DeckEditor`'s
   * `openPull` rather than its `openCheck`: those hold a ref to a control they draw themselves,
   * and every opener here is a button inside `NoteCard`. Threading a ref down would be one prop
   * per card to name an element the browser has already focused by the time this runs — the
   * argument `openPull`'s own doc makes, in that file, against exactly this. A press focuses what
   * it presses, so reading it is exact.
   *
   * **Not an `HTMLElement | null` the band trusts blindly**: see {@link closePanel} for the
   * `isConnected` test and for the one panel that deliberately clears this before it closes.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * Open one of them, remembering where the caret came from.
   *
   * ⚠️ **The read happens before the write and that ordering is the whole of it.** `Dialog`'s
   * mount effect takes the caret on the commit this `setPanel` schedules, so a capture made any
   * later reads the dialog's own panel and hands the caret back to a node that is unmounting.
   *
   * The two panels raised during **render** — an `edit` focus and a `newFromCard` — deliberately
   * do not come through here: there is no press to read a caret from, `document.activeElement` is
   * whatever the card menu left behind (for a `focus`, the card's own landing pad, which
   * {@link NoteCard}'s effect has already taken), and a ref written during render is a write React
   * is entitled to run twice. They leave `openerRef` as {@link closePanel} left it — `null` — and
   * take that function's fallback, which is the honest answer: the band is where the note they
   * asked for went.
   */
  const openPanel = useCallback((next: NonNullable<NotePanel>) => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  }, []);

  /**
   * Shut whichever is open, and give the caret back — **focus first, then close**, which is
   * `DeckEditor`'s `dismiss` character for character and for its reason: at this instant the
   * opener is still mounted, and one line further on it may not be.
   *
   * ⚠️ **`isConnected` is reachable, and the example to hold is the band being _collapsed_ under
   * an open dialog.** Every opener but `New note` is a button on a {@link NoteCard}, and the cards
   * live inside the collapsible region while the dialogs are drawn outside it — so `open` going
   * false with a dialog up unmounts the opener and leaves the dialog standing. `.focus()` on a
   * detached node is a silent no-op that leaves the caret exactly where this exists to stop it
   * landing, on `<body>`, so the fallback is {@link newNoteRef}, which is in the header and
   * survives both the collapse and an empty band.
   *
   * **The obvious example is the wrong one and is worth naming as wrong**: a note deleted from
   * another window does *not* reach this test, because it closes its dialog by making `live` null
   * — `open` flips false and nothing calls this function at all. That route hands the caret back
   * nowhere and is the one gap left in this band's contract; see the dialogs at the foot of this
   * component for why it is not closed here.
   *
   * **The confirmed delete clears `openerRef` itself rather than relying on that test**, because
   * at the moment of the press its opener is still connected: the write is a round trip, and the
   * card does not unmount until the invalidation it fires has refetched. So the naive
   * implementation focuses a button that is about to be removed, the caret reaches `<body>` a beat
   * later, and every assertion made synchronously passes. See the dialog's own `onDelete`.
   *
   * It runs for the scrim as well as for Escape and the ✕, which is a departure from
   * `useDismissOnEscape`'s rule that an outside click hands nothing back — and it is deliberate
   * twice over. `NoteCardsDialog` and `NoteEditorDialog` take one `onClose` and are not this
   * file's to widen; and the rule's premise is that a reader who clicked elsewhere is already
   * somewhere else, which is false under a modal scrim, where there is nothing else to be on and
   * the caret is on a panel about to unmount.
   */
  const closePanel = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener !== null && opener.isConnected) opener.focus();
    else newNoteRef.current?.focus();
    setPanel(null);
  }, []);

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
          ref={newNoteRef}
          type="button"
          // **The press opens the band, and the press rather than the create is the moment.**
          // This control is drawn while the band is shut, so without it a reader shuts the area,
          // presses New note, Saves, and is answered by the header's count going from `2 notes` to
          // `3 notes` — their note written into a region they cannot see. That is the argument the
          // card menu's `add` already makes one component up, in those words, and the two paths
          // have to agree because they end in the same dialog.
          //
          // **The press and not the Save**, for two reasons. A band that opened itself *after* the
          // dialog closed would be a change the reader cannot connect to anything they did; and a
          // create that is refused, or a dialog they dismiss, would leave them with no list to
          // check either way. What it costs is `decks.notes_open` written on a note they then
          // cancelled — the same trade the card menu's row makes, and one press undoes it.
          onClick={() => {
            if (!open) onToggle(true);
            openPanel({ kind: "newNote" });
          }}
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
                    // Through {@link openPanel} and never a bare `setPanel`: these three are the
                    // presses the caret has to be given back to, and the capture has to happen
                    // before the state write. A fourth action added here owes the same call.
                    onEdit={() => openPanel({ kind: "edit", note })}
                    onCards={() => openPanel({ kind: "cards", note })}
                    onDelete={() => openPanel({ kind: "confirm", note })}
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
          nothing answers for.

          ⚠️ **That is also the one close this band does not hand the caret back from, and it
          is parked rather than impossible — this comment claimed the second until 2026-09-21.**
          `live` going null flips `open` false and `Dialog` unmounts its panel; no press was made,
          so `closePanel` never runs and the caret reaches `<body>`.

          **The shape that works is a render-phase adjustment beside a sentinel ref, and this file
          already uses the first half twice** — the `focus` arm and the `newFromCard` arm above.
          Clearing `panel` during render is React's own *adjusting state when a prop changes* and
          is legal; `react-hooks/set-state-in-effect` never enters the picture, because the effect
          left over does no `setState` at all. The objection this comment used to raise against
          that — that writing the panel away clears the very state the restore would have to read
          — is answerable with one boolean: {@link closePanel} already writes `openerRef` back to
          `null`, so a ref it *also* clears tells the two routes apart, and the effect then fires
          only on the route `closePanel` did not take and is a ref read plus a `.focus()`.

          **What keeps it parked is the reach, not the shape.** It needs two windows open on one
          deck, a note deleted in one of them while the other has a dialog up on it, and a reader
          driving that second window by keyboard — deep enough in the tail that the price, a
          third render-phase adjustment and a ref whose only reader is a case this suite cannot
          currently reproduce, buys more risk than it removes. It belongs with the test that would
          fence it.

          **All three are mounted whether or not they are open, with `open` as the only gate** —
          `DeckEditor.tsx`'s own two confirmations, verbatim. A `{cond && <Dialog open …/>}` takes
          the element out of the tree on the render that closes it, so `AnimatePresence` has
          nothing left to play the exit on and the panel snaps away; two of these did, while
          `NoteEditorDialog` tweened, which is one band drawing one gesture two ways.

          **The `live === null` fallbacks below are a totality requirement and never a rendered
          state**, which is the opposite of what this comment said for a day. A prop is evaluated
          on every render of this band whether or not the dialog it belongs to is open, so
          `noteTitle(live)` and `live.cards` have to be total over a `null` — that is the whole of
          what those branches buy. **None of them is ever drawn.** `Dialog` is
          `<AnimatePresence>{open && <Panel …/>}</AnimatePresence>`, and framer-motion renders the
          **stored** element for an exiting key rather than a fresh one (`AnimatePresence`'s
          `nextChildren.splice(i, 0, child)`, taken from its `renderedChildren` state), so the
          panel leaves with the props it had while it was present; and `open` is false exactly
          when `live` is null, so there is no render in which a fallback and an open panel
          coexist. Pick words that would read sensibly if one ever were — that is the standard a
          value nobody can see is held to — and do not weigh it as a cost. Nothing is rendered
          *inside* a shut dialog either way, since `Dialog` mounts its children only while open,
          so the null guards in the callbacks below are unreachable rather than defensive. */}
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
          // A Save is a way out like any other, so the caret goes back the same way. The opener
          // survives every arm of this write — an edit leaves its card standing and a create adds
          // one — so there is nothing here to clear, which is exactly what the delete is not.
          closePanel();
        }}
        onClose={closePanel}
      />

      <NoteCardsDialog
        open={panel?.kind === "cards" && live !== null}
        // `noteTitle` here rather than in the dialog, so the heading the picker draws and the
        // name the card it was opened from carries are one computation. The bare `Cards` is what
        // a prop evaluated on every render has to answer when there is no note — never a heading
        // anybody sees; the mount pattern above says why.
        title={live === null ? "Cards" : noteTitle(live)}
        named={live?.cards ?? NO_NAMED}
        attachable={attachable}
        // Statement bodies rather than `live !== null && …`, which would hand a `void` callback a
        // boolean: the delete below spells the same guard the same way, and one file answering
        // one question two ways is what a reader has to stop and check.
        onAttach={(oracleId) => {
          if (live !== null) onAttach(live.id, oracleId);
        }}
        onDetach={(oracleId) => {
          if (live !== null) onDetach(live.id, oracleId);
        }}
        onClose={closePanel}
      />

      <DeleteNoteDialog
        open={panel?.kind === "confirm" && live !== null}
        title={live === null ? null : noteTitle(live)}
        cardCount={live?.cards.length ?? 0}
        pending={pending}
        onDelete={() => {
          if (live === null) return;
          // ⚠️ **The opener is dropped before the close, and this line is the whole fix.** The
          // caret is on this note's own `Delete` button, which is still in the document right now
          // — the write is a round trip and the card does not unmount until the invalidation it
          // fires has refetched. So handing the caret back to it succeeds, and then the card is
          // removed and the caret falls to `<body>`: the failure this hand-back exists to prevent,
          // reached by the implementation that looks like the fix. Cleared, {@link closePanel}
          // takes its fallback and the caret goes to `New note`, which is the one control that
          // survives an empty band.
          //
          // **Only the confirmed press.** `Keep it`, Escape and the ✕ all leave the note where it
          // is, so their opener outlives the dialog and is exactly where the reader should be put
          // back — they go through `onClose` below, untouched.
          openerRef.current = null;
          onDelete(live.id);
          closePanel();
        }}
        onClose={closePanel}
      />
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
 * `useConfirmFocus`: a dialog takes the caret into its own panel as it opens, so there is no
 * landing pad here to focus and no `role="group"` to put one on. **Giving the caret back is not
 * retired with them and is the host's** — `DialogProps.onDismiss`' own doc says so — which is what
 * {@link NotesBand}'s `closePanel` does for all three of these, and what this component
 * deliberately knows nothing about.
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
  /** The note's name, or `null` while the dialog is shut — see the mount pattern at the call
   *  site, and the heading below for what `null` draws. */
  title: string | null;
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
      //
      // **`null` is the shut state**, and the branch is what makes the prop total: the host
      // evaluates it on every render, open or not. It is never drawn — see the mount pattern at
      // the call site — so the bare verb is what a value nobody sees should read as rather than a
      // heading anybody meets. `string | null` rather than a `""` fallback for the same reason
      // one rung down: an empty string is a *name*, and the one thing this template must never be
      // able to spell is `Delete “”?`.
      title={title === null ? "Delete note" : `Delete “${title}”?`}
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
