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
 *   refusing. Here the empty band is exactly where the reader has something to do: the way to
 *   write a first note is *inside* it, so a heading that could not be opened would be the one
 *   state this screen must not have.
 *
 * ## Add first, which is `LabelsDialog`'s ordering and its reason
 *
 * The field that makes a note is the first thing in the body, above the list. **A reader with no
 * notes is who this screen is hardest for**, and putting the add row under a list they do not
 * have yet is how the labels dialog used to read.
 *
 * ## Reading loads no editor, and that is a bundle rule rather than a preference
 *
 * The list draws {@link parseNoteBody}'s blocks — a small closed reader over the dialect
 * `noteMarkdown.ts` pins, modelled on `src/lib/releaseNotes.ts`, with no library and no HTML
 * string anywhere near it (the shipped CSP is `script-src 'self'` and nothing in `src/` uses
 * `dangerouslySetInnerHTML`). **Editing** mounts Tiptap, and Tiptap is **141.5 kB gzip** against
 * the app's own 481.45 kB — measured with `esbuild --bundle --minify`, React external, `gzip -9`,
 * 2026-09-10. So `NoteEditor` is reached through `React.lazy` and **nothing on this path may
 * import it any other way**: one eager import puts that chunk back in the main bundle and
 * *nothing anywhere goes red*. Mounting a ProseMirror instance per note merely to render one
 * would be the same mistake drawn larger.
 *
 * ## Two components, and the split is where the database stops
 *
 * {@link DeckNotesPanel} is the wiring — the query, the five writes, and the deck's own cards for
 * the picker. {@link NotesBand} is everything drawn, over plain props. That is `DeckStats`'
 * arrangement and it is what lets the workbench stand this band up in the six states that matter
 * — including a refused read, which no seed can produce and no fault reaches.
 */
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { ChevronRight, X } from "lucide-react";
import { plural } from "@/lib/counts";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import type { DeckCard, DeckNote, DeckNoteCard } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { noteTitle } from "./deckNotes";
import {
  CONFIRM_CANCEL,
  CONFIRM_DESTRUCTIVE,
  META_FIELD,
  META_SUBMIT,
  RowAction,
  useConfirmFocus,
} from "./metaRows";
import { parseNoteBody, type Block, type Inline } from "./noteMarkdown";
import { useDeckNotes } from "./useDeckNotes";

/**
 * The rich-text editor, and **the only reference to it on this path**.
 *
 * `React.lazy` over a dynamic import, so the Tiptap chunk is fetched the first time a reader
 * presses Edit and never on a page that only reads. See this file's header for the measurement
 * and for why a static import here would be invisible to every build in the repository.
 */
const NoteEditor = lazy(() => import("./NoteEditor"));

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

/** Both sub-headings inside a row. Uppercase and tracked, which is the one place in this band a
 *  word is not a sentence — `LabelsDialog`'s `SECTION`, respelled here rather than exported from
 *  a dialog this band has nothing else in common with. */
const SECTION = "mb-1.5 text-[0.6875rem] uppercase tracking-[0.04em] text-dim";

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
}

/**
 * One card a note can name: the identity Scryfall gives it across every printing, and the word to
 * print.
 *
 * The same pair `DeckNoteCard` already is, reused rather than respelled — the picker offers the
 * deck's cards in exactly the shape an attached one comes back in, so a row can be drawn from
 * either side with one component.
 */
export type NoteCardChoice = DeckNoteCard;

/**
 * The deck's own cards, as the picker offers them: one entry per **oracle id**, by name.
 *
 * **Deduped, because a note names a card and not a printing.** One note naming Lightning Bolt
 * names it once, however many copies, printings or finishes the deck holds — and a picker
 * offering the same card four times would be four presses that all did the same thing.
 *
 * **A row with no oracle id is dropped rather than offered.** That is an orphan printing — a card
 * the corpus has since stopped carrying — and there is no id to attach; offering it would be a
 * press that could only be refused.
 */
export function attachableCards(cards: readonly DeckCard[]): NoteCardChoice[] {
  const byOracle = new Map<string, string>();
  for (const card of cards) {
    if (card.oracleId === null) continue;
    if (!byOracle.has(card.oracleId)) byOracle.set(card.oracleId, card.name);
  }
  return [...byOracle.entries()]
    .map(([oracleId, name]) => ({ oracleId, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

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
}: DeckNotesPanelProps): JSX.Element {
  const notes = useDeckNotes(deckId);
  const attachable = useMemo(() => attachableCards(cards), [cards]);

  return (
    <NotesBand
      open={open}
      onToggle={onToggle}
      notes={notes.notes}
      attachable={attachable}
      answered={notes.query.isSuccess}
      failure={notes.failure}
      pending={notes.pending}
      onCreate={(title) => notes.create.mutate({ title, body: "", oracleIds: [] })}
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
  onCreate: (title: string) => void;
  onSave: (id: number, patch: { title: string; body: string }) => void;
  onDelete: (id: number) => void;
  onAttach: (noteId: number, oracleId: string) => void;
  onDetach: (noteId: number, oracleId: string) => void;
}

/**
 * Everything the band draws, over plain props — the half of this file with no database behind it.
 *
 * **Three pieces of "which row is open", not one per row**, which is `LabelsDialog`'s
 * arrangement: editing, confirming and picking cards are each single-tenant, so opening one on a
 * row below closes the one above. A band with three rows unfolded is a band with no list left in
 * it — and, here, three ProseMirror instances for a reader who wanted one.
 */
export function NotesBand({
  open,
  onToggle,
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
  const addId = useId();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [picking, setPicking] = useState<number | null>(null);

  /** Open one panel on one row, and shut the other two wherever they were. */
  const only = (which: "edit" | "confirm" | "cards", id: number | null) => {
    setEditing(which === "edit" ? id : null);
    setConfirming(which === "confirm" ? id : null);
    setPicking(which === "cards" ? id : null);
  };

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
          area is shut so a closed band costs no editor, no picker and no state. */}
      <div id={bodyId}>
        {open && (
          <div className="mt-3 flex flex-col gap-3">
            {/* Making one comes first, and the band opens on it. A reader with no notes is who
                this screen is hardest for, and an add row under a list they do not have yet is
                exactly how the labels dialog used to read. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = draft.trim();
                if (trimmed === "") return;
                onCreate(trimmed);
                setDraft("");
              }}
              className="flex items-center gap-2"
            >
              <label htmlFor={addId} className="sr-only">
                New note title
              </label>
              <input
                id={addId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="New note title…"
                className={META_FIELD}
              />
              {/* **A title is required here and optional everywhere else**, which is not a
                  contradiction: a blank title is legal in the table and reads as the body's first
                  line, and this row has no body to read one from. Written blank it would make a
                  note with nothing in it at all. Edit is where a reader may then clear it. */}
              <button
                type="submit"
                disabled={pending || draft.trim() === ""}
                className={META_SUBMIT}
              >
                Add note
              </button>
            </form>

            {/* Four states and only three sentences, which is the point: a **refused** read has
                no rows and is not pending either, so captioning it *no notes* or *reading…*
                would both be the app asserting something it does not know. The alert above has
                already said what happened, so this says nothing at all. */}
            {notes.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {notes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    attachable={attachable}
                    pending={pending}
                    editing={editing === note.id}
                    confirming={confirming === note.id}
                    picking={picking === note.id}
                    onOpen={(which) => only(which, note.id)}
                    onDone={() => only("edit", null)}
                    onSave={(patch) => {
                      onSave(note.id, patch);
                      only("edit", null);
                    }}
                    onDelete={() => {
                      onDelete(note.id);
                      only("edit", null);
                    }}
                    onAttach={(oracleId) => onAttach(note.id, oracleId)}
                    onDetach={(oracleId) => onDetach(note.id, oracleId)}
                  />
                ))}
              </ul>
            ) : answered ? (
              <p className="text-xs text-dim">
                No notes on this deck yet — name one above, then write it out.
              </p>
            ) : failure === null ? (
              <p className="text-xs text-dim">Reading this deck&rsquo;s notes…</p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One note's title folded into a verb, for a control's accessible name.
 *
 * **Spelled as a text node beside an `sr-only` span, never assembled from two elements.** Name
 * computation trims each element's contribution before appending it, so `<span>Edit</span>` next
 * to `<span>Mana base</span>` computes to `EditMana base` — the `Missing2` failure. A bare text
 * child followed by `{" "}` survives as a sibling text node and reads correctly.
 *
 * **A note's title is not unique and is not meant to be** (§2: two devices each typing a note
 * about the mana base must stay two notes), so two rows really can carry one name. What keeps
 * that usable is that only one row's panel is ever open at a time — every control that *acts*
 * names the row it is on, and the list itself is what a reader reads.
 */
function actionLabel(verb: string, rest: string): JSX.Element {
  return (
    <>
      {verb}
      {/* The space is a sibling of both, which is the whole of why this reads as two words. */}{" "}
      <span className="sr-only">{rest}</span>
    </>
  );
}

/** One note: what it is called, what it says, which cards it names, and the three things a
 *  reader can do to it. */
function NoteRow({
  note,
  attachable,
  pending,
  editing,
  confirming,
  picking,
  onOpen,
  onDone,
  onSave,
  onDelete,
  onAttach,
  onDetach,
}: {
  note: DeckNote;
  attachable: readonly NoteCardChoice[];
  pending: boolean;
  editing: boolean;
  confirming: boolean;
  picking: boolean;
  onOpen: (which: "edit" | "confirm" | "cards") => void;
  onDone: () => void;
  onSave: (patch: { title: string; body: string }) => void;
  onDelete: () => void;
  onAttach: (oracleId: string) => void;
  onDetach: (oracleId: string) => void;
}) {
  const title = noteTitle(note);
  const { deleteRef, owedFocusRef } = useDestructiveFocus(confirming);

  return (
    <li className="rounded-md border border-border px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-text">{title}</span>
        {/* The card-count chip, drawn only where the note names any — a `0 cards` on every note
            with none would be the band's commonest row saying the same nothing over and over. */}
        {note.cards.length > 0 && (
          <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
            {plural(note.cards.length, "card")}
          </span>
        )}
        <RowAction onClick={() => onOpen("cards")} disabled={picking}>
          {actionLabel("Cards", `on ${title}`)}
        </RowAction>
        <RowAction onClick={() => onOpen("edit")} disabled={editing}>
          {actionLabel("Edit", title)}
        </RowAction>
        <RowAction
          ref={deleteRef}
          onClick={() => onOpen("confirm")}
          disabled={confirming}
          destructive
        >
          {actionLabel("Delete", title)}
        </RowAction>
      </div>

      {/* The body, read-only, and the whole reason this list loads no editor. A note being edited
          draws the editor in its place rather than beside it — two renderings of one body on one
          row is the drift `noteMarkdown.test.ts`' round trip exists to prevent, drawn on screen. */}
      {editing ? (
        <NoteEditForm
          note={note}
          title={title}
          pending={pending}
          onSave={onSave}
          onCancel={onDone}
        />
      ) : (
        <div className="mt-1.5">
          <NoteBody body={note.body} />
        </div>
      )}

      {picking && (
        <NoteCards
          title={title}
          named={note.cards}
          attachable={attachable}
          onAttach={onAttach}
          onDetach={onDetach}
          onDone={onDone}
        />
      )}

      {confirming && (
        <DeleteNote
          title={title}
          cardCount={note.cards.length}
          pending={pending}
          onDelete={onDelete}
          onCancel={() => {
            owedFocusRef.current = true;
            onDone();
          }}
        />
      )}
    </li>
  );
}

/** `LabelsDialog`'s hand-back, on the sibling control and for the identical reason: cancelling a
 *  confirmation must put the caret back on the button that opened it, not at the top of the band
 *  — and it cannot until the render that re-enables that button. */
function useDestructiveFocus(confirming: boolean) {
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocusRef = useRef(false);
  useEffect(() => {
    if (confirming || !owedFocusRef.current) return;
    owedFocusRef.current = false;
    deleteRef.current?.focus();
  }, [confirming]);
  return { deleteRef, owedFocusRef };
}

/**
 * Delete a note, and say what goes with it.
 *
 * **The cards are the clause worth spelling.** `deck_note_cards` cascades with the note, so the
 * attachments go — and a reader who has just spent a press attaching four cards has every reason
 * to think the press might reach further than the note. It does not: the cards themselves are in
 * the deck and stay there, which is the half a confirmation can say before the press rather than
 * after it.
 */
function DeleteNote({
  title,
  cardCount,
  pending,
  onDelete,
  onCancel,
}: {
  title: string;
  cardCount: number;
  pending: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) {
  // The caret comes into the question rather than onto a button in it: the reader has not decided
  // yet, and a stray Enter must not decide for them.
  const confirm = useConfirmFocus(`Delete ${title}`);

  return (
    <div {...confirm}>
      <p className="text-xs">Delete “{title}”?</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {cardCount === 0
          ? "The note goes for good."
          : `The note goes for good, and stops naming its ${plural(cardCount, "card")}. The cards themselves stay in the deck.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onDelete}
          className={CONFIRM_DESTRUCTIVE}
        >
          Delete note
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </div>
    </div>
  );
}

/**
 * Which cards this note names, and the picker over the deck's own.
 *
 * **The picker offers the deck's cards and nothing wider**, which is the spec's line: a note is
 * about a card *in this deck*. A card that later leaves the deck keeps its note — deliberately,
 * because a note about a card you cut is the note most worth keeping — so this list narrows what
 * can be *added* and never what is already here.
 *
 * **Attaching is its own panel rather than part of Edit**, and the reason is the chunk: reaching
 * `Attach` through the editor would make a reader load 141.5 kB of ProseMirror in order to name a
 * card. It is a row action beside Edit for that reason alone.
 */
function NoteCards({
  title,
  named,
  attachable,
  onAttach,
  onDetach,
  onDone,
}: {
  title: string;
  named: readonly NoteCardChoice[];
  attachable: readonly NoteCardChoice[];
  onAttach: (oracleId: string) => void;
  onDetach: (oracleId: string) => void;
  onDone: () => void;
}) {
  const findId = useId();
  const [find, setFind] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  // The caret starts in the field the reader opened. `focus()` on a node with no `tabIndex` is a
  // silent no-op and this one is an `<input>`, so the single call is the whole of it — but the
  // call itself is not optional: without it the caret stays on the `Cards` trigger this row has
  // just disabled, parked on a dead control, and the first keystroke goes to the page.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const already = useMemo(() => new Set(named.map((c) => c.oracleId)), [named]);
  const needle = find.trim().toLowerCase();
  const choices = attachable.filter(
    (c) => !already.has(c.oracleId) && (needle === "" || c.name.toLowerCase().includes(needle)),
  );

  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className={SECTION}>Cards this note names</p>
      {named.length === 0 ? (
        <p className="text-[0.6875rem] text-dim">None yet — pick one below.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {named.map((card) => (
            <li
              key={card.oracleId}
              className="flex items-center gap-1 rounded-md border border-border py-0.5 pl-2 pr-1 text-[0.6875rem] text-text"
            >
              {card.name}
              <button
                type="button"
                onClick={() => onDetach(card.oracleId)}
                aria-label={`Detach ${card.name} from ${title}`}
                className={cn("grid size-4 shrink-0 place-items-center rounded text-dim", FOCUS)}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-2">
        <label htmlFor={findId} className="sr-only">
          Find a card to name in {title}
        </label>
        <input
          ref={ref}
          id={findId}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a card in this deck…"
          className={META_FIELD}
        />
        <RowAction onClick={onDone}>Done</RowAction>
      </div>

      {/* **`relative`, because a scroll container has to be the containing block for its own
          absolutely positioned content** — and `FOCUS_INSET` on the rows, because an outline
          standing 2px off a row that fills a clipped box is painted entirely in the clipped
          region and is never seen at all. Both are app rules with a shipped failure behind them;
          jsdom lays nothing out, so neither can go red in the suite. */}
      {choices.length === 0 ? (
        <p className="mt-1.5 text-[0.6875rem] text-dim">
          {attachable.length === 0
            ? "This deck has no cards to name yet."
            : "No card in this deck matches — and one this note already names is not offered twice."}
        </p>
      ) : (
        <ul className="relative mt-1.5 max-h-40 overflow-y-auto">
          {choices.map((card) => (
            <li key={card.oracleId}>
              <button
                type="button"
                onClick={() => onAttach(card.oracleId)}
                aria-label={`Name ${card.name} in ${title}`}
                className={cn(
                  "w-full truncate rounded-sm px-1.5 py-1 text-left text-[0.6875rem] text-dim",
                  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                  FOCUS_INSET,
                )}
              >
                {card.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The editor, in place, behind a `Suspense`.
 *
 * **The title and the body are one write**, which is `deck_note_update`'s shape and the labels
 * dialog's lesson one dialog over: two controls sending each other's field back unchanged is how
 * a rename quietly undoes a recolour. Both drafts are held here and sent together.
 *
 * The fallback is a sentence rather than a spinner: the chunk arrives off local disk, so what a
 * reader sees is one frame of type rather than something spinning.
 */
function NoteEditForm({
  note,
  title,
  pending,
  onSave,
  onCancel,
}: {
  note: DeckNote;
  title: string;
  pending: boolean;
  onSave: (patch: { title: string; body: string }) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [draftTitle, setDraftTitle] = useState(note.title);
  const [draftBody, setDraftBody] = useState(note.body);

  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="flex items-center gap-2">
        <label htmlFor={titleId} className="sr-only">
          Title of {title}
        </label>
        <input
          id={titleId}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          // Blank is legal here where it is not on the add row: a note with a body reads its
          // first line as its title, computed at render and never stored.
          placeholder="Untitled — the first line stands in"
          className={META_FIELD}
        />
      </div>

      <div className="mt-2">
        <Suspense fallback={<p className="text-[0.6875rem] text-dim">Opening the editor…</p>}>
          <NoteEditor
            value={draftBody}
            onChange={setDraftBody}
            ariaLabel={`Body of ${title}`}
          />
        </Suspense>
      </div>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => onSave({ title: draftTitle.trim(), body: draftBody })}
          className={META_SUBMIT}
        >
          Save
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A note's body, drawn.
 *
 * `parseNoteBody` is a reader for one pinned dialect and not a markdown parser: a construct it
 * has no rule for falls through to a paragraph and renders as written, so the worst case is the
 * reader's own typing and the ordinary case is a note. `ReleaseNotes.tsx` is the same shape one
 * feature over, and this is deliberately not a general component shared with it — that one draws
 * a changelog at the settings panel's type scale and this one draws prose inside a deck row.
 */
function NoteBody({ body }: { body: string }): JSX.Element {
  const blocks = useMemo(() => parseNoteBody(body), [body]);

  if (blocks.length === 0) {
    // A note really can be a title and nothing else — that is what the add row makes — and an
    // empty box under a heading reads as something that failed to load.
    return <p className="text-[0.6875rem] text-dim">Nothing written yet — press Edit.</p>;
  }

  return (
    // **`whitespace-pre-line`, and it is load-bearing rather than typography.** The `Inline` union
    // has no break member, so `parseNoteBody` represents a hard break as a `"\n"` *inside a text
    // run* — under the default `normal` every one of them would collapse to a space, and a note
    // laid out in short lines would come back as one paragraph with nothing going red. It is set
    // once here because `white-space` inherits, so a run nested in a list item or a quote is
    // covered by the same declaration.
    <div className="space-y-1.5 whitespace-pre-line text-xs leading-relaxed text-dim">
      {blocks.map((block, i) => (
        <NoteBlock key={i} block={block} />
      ))}
    </div>
  );
}

function NoteBlock({ block }: { block: Block }): JSX.Element {
  if (block.kind === "heading") {
    // One drawn weight for all three depths. A note is a paragraph or two inside a deck row, and
    // three sizes inside a 12px block would be a type scale nobody chose — `ReleaseNotes`' call,
    // for the same reason.
    return (
      <p className="pt-1 text-[0.6875rem] font-medium uppercase tracking-wide text-text first:pt-0">
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  if (block.kind === "list") {
    // A real list marker and not a drawn glyph in a span: the marker stays out of the element's
    // `textContent` and out of the accessibility tree, where a hand-drawn one has to be
    // `aria-hidden` and still turns up in every assertion about the row's words.
    const items = block.items.map((item, i) => (
      <li key={i}>
        <Inlines inlines={item} />
      </li>
    ));
    // **`start` is drawn, and it is only ever present on a list that does not begin at 1.**
    // Tiptap keeps a reader's start number and serialises it, so a list begun at `3.` would be
    // drawn as `1.` the moment they stopped editing — the two renderers disagreeing about one
    // body, which is the failure the dialect's round trip exists to prevent.
    return block.ordered ? (
      <ol start={block.start} className="list-decimal space-y-1 pl-4 marker:text-dim/60">
        {items}
      </ol>
    ) : (
      <ul className="list-disc space-y-1 pl-4 marker:text-dim/60">{items}</ul>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote className="border-l-2 border-border pl-2 italic">
        <Inlines inlines={block.inlines} />
      </blockquote>
    );
  }
  return (
    <p>
      <Inlines inlines={block.inlines} />
    </p>
  );
}

function Inlines({ inlines }: { inlines: readonly Inline[] }): JSX.Element {
  return (
    <>
      {inlines.map((run, i) => {
        if (run.kind === "strong") {
          return (
            <strong key={i} className="font-medium text-text">
              {run.text}
            </strong>
          );
        }
        if (run.kind === "em") {
          return (
            <em key={i} className="italic">
              {run.text}
            </em>
          );
        }
        if (run.kind === "strike") {
          return (
            <s key={i} className="line-through">
              {run.text}
            </s>
          );
        }
        if (run.kind === "code") {
          return (
            <code key={i} className="rounded bg-surface px-1 py-0.5 font-mono text-[0.95em]">
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") {
          // A button and not an `<a href>`: this window has nowhere to navigate to, and an anchor
          // a middle-click could follow would replace the app with a web page. `openExternal` is
          // the one call in this app that leaves it — `ReleaseNotes` makes the identical call for
          // the identical reason.
          return (
            <button
              key={i}
              type="button"
              onClick={() => void openExternal(run.href)}
              className={cn("rounded-sm text-accent underline-offset-2 hover:underline", FOCUS)}
            >
              {run.text}
            </button>
          );
        }
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}
