/**
 * **The third answer to a shortfall, and the only one that makes cardboard exist.**
 *
 * A deck lists four Lightning Bolts, holds one, and reads *3 missing*. `Pull from collection`
 * answers that with copies the reader already owns and has filed somewhere else — it **moves**
 * them. `Send missing to wishlist` answers it with copies they have not got — it writes a list.
 * This is the press for the ones they bought this morning: the cardboard is on the desk and the
 * database has never heard of it, so the write **creates** `collection_entries` rows and files
 * them into the deck's own folder.
 *
 * The per-card form of the same act has existed since 2026-09-03 as a deck card's
 * `Collection ▸ Quick add N copies`, which writes outright with no dialog because one row needs
 * no preview. **This is the deck-wide form and it has exactly one entrance** — the stats band's
 * button — which is why, unlike `PullFromCollectionDialog`, there is no `cardName` prop and no
 * scoped subtitle: there is one scope and it never narrows.
 *
 * ## What the reader is actually deciding
 *
 * Two things, and both are departures from a default that is already right for the ordinary
 * press. Every row arrives **ticked at its full shortfall**, so a reader who bought everything
 * their deck was short of presses the footer once. What the body is *for* is the reader who
 * bought two of the four — a stepper per row — and the reader who does not want one line recorded
 * at all — a checkbox per row. `addMissingPlan.ts` holds only those departures and derives
 * everything on screen from them; nothing here keeps a copy of the plan.
 *
 * **The pull's departure is a source and this one's is a count**, which is the whole difference
 * between the two dialogs and the reason this one draws no `Dropdown` and no per-row candidate
 * list. There is nothing to choose between: the copies do not exist yet.
 *
 * ## The wishlist half is a fact beside each row, never a question
 *
 * The backend takes a wish down **only when exactly one line matches** — a deck-wide press over
 * thirty rows cannot ask thirty questions, and the design settled on no nested picker. So each
 * row states which of the three shapes it is *before* the press (`clears N copies off a wish in
 * …`, `N wishlist lines match — left alone`, or nothing at all), and what did not happen is read
 * rather than discovered afterwards. The one control is the footer's checkbox, for the whole
 * batch; a reader who wants one row's wish kept unticks that row.
 *
 * **An unticked row still says what its line would do, and the row is dimmed whole instead.**
 * {@link PlannedMissingRow.wish} is derived independently of {@link PlannedMissingRow.on}, so
 * blanking the sentence would be the dialog inventing a fourth wish shape that means "the row is
 * off" — which the dim already says, about the whole row, in one place.
 *
 * ## The four states of the body, and why none may be folded together
 *
 * `loading`, `readError`, an **empty** plan, and rows to review. The third is the one that looks
 * like a failure and is an ordinary answer: `deck_missing_plan` drops a printing that has left
 * the corpus, because `collection::add_entry_filed` reads the set, the collector number and the
 * language off that `cards` row and cannot file a copy without it. That is the only way this
 * panel is empty while the button that opened it was drawn — the button lives inside the band's
 * `missing > 0` arm — and a blank panel reads as broken.
 *
 * ## What this component is not
 *
 * It holds **no query and no mutation**. `rows`, `loading`, `readError` and the write all arrive
 * as props — {@link AddMissingWrite} is narrowed the way `PullWrite` is — so the dialog renders
 * in a test with no query client, and the one write it makes is visible in its own signature.
 * `DeckSettingsForm`'s fence, applied to a surface that does have a button.
 *
 * The chrome is `components/Dialog.tsx`'s: the scrim, the centring, `aria-modal`, `trapTab`, the
 * ✕ and the `"inner"` Escape rung are written once there, and a new modal in this surface is
 * built **on** that file rather than beside it.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CardImage } from "@/components/CardImage";
import { Dialog } from "@/components/Dialog";
import { FinishMark } from "@/components/FinishMark";
import { QuantityStepper } from "@/components/QuantityStepper";
import { plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { cardArtSrc, cardImageUrl } from "@/lib/images";
import {
  ipcError,
  type DeckMissingOutcome,
  type DeckMissingPick,
  type DeckMissingRow,
} from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  NO_MISSING_CHOICE,
  planAddMissing,
  setCopies,
  toggleRow,
  type MissingChoice,
  type PlannedMissingRow,
} from "./addMissingPlan";

/**
 * Stable identity for "the read has not answered", so {@link planAddMissing} is not re-run over a
 * fresh empty array on every render of a dialog that is still waiting. `PullFromCollectionDialog`
 * keeps the same constant for the same reason.
 */
const NO_ROWS: readonly DeckMissingRow[] = [];

/**
 * The wishlist's own word for the root, which is what a `null` `folderName` is.
 *
 * `DeckQuickAddWish.folderName`'s doc says the sentence belongs on the page that shows it rather
 * than in the backend, and `QuickUnwishDialog` keeps its own copy of this same string for the
 * same column. The top level is a real place the reader knows from the breadcrumb, not the
 * absence of one, so a line reading "No folder" would be describing the drawer that page calls
 * Wishlist. Two spellings of one word is worth noticing — folding them together is a change to a
 * file this one does not own.
 */
const WISHLIST_ROOT_LABEL = "Wishlist";

/** What the body says while the read is in flight. */
const READING = "Reading what this deck is short of…";

/**
 * What an empty plan means, in the reader's terms.
 *
 * **Neither sentence apologises**, because nothing has gone wrong. `deck_missing_plan` leaves out
 * a printing with no `cards` row — the write's own precondition, since the set, the collector
 * number and the language are read off it — so a plan the reader arrives at from a band saying
 * *12 missing* can legitimately hold nothing. The *why* is the load-bearing half: without it this
 * panel reads as a query that failed rather than as a narrowing the reader would agree with if
 * they knew about it.
 */
const NOTHING_TO_RECORD = {
  headline:
    "Nothing here can be recorded — everything this deck is short of has left the card database.",
  why:
    "A printing the card database has dropped cannot be filed at all: its set, its collector " +
    "number and its language are read off that row. A line the press could only refuse is left " +
    "out of this list rather than drawn as an apology.",
} as const;

/**
 * The standing sentence at the foot of the panel — the two things about this press that cannot be
 * read off the list above it.
 *
 * **It writes no `deck_cards` row**, which is the whole difference from the Collection tab's add:
 * that command puts a card *into* the deck and folds the quantity into the list, so pointing it
 * at a 4-copy line the reader is 3 short of would make the line 7. This one only records that the
 * cardboard exists and files it where the deck can claim it, which is why the shortfall closes
 * without the list changing.
 *
 * **And it files no undo step**, for `deck_to_collection`'s reason exactly: the copies go in
 * through `add_entry_filed`'s grain fold, so they may have been folded into a row the group
 * already held and there is nothing left to restore. Saying so here is what makes the absence
 * visible rather than discovered, and the way back is named — an error message that only refuses
 * is half a sentence.
 */
const ADD_NOTE =
  "The copies are filed into this deck's own folder. The list itself does not change, and " +
  "there is no undo — take a copy back out from the Collection tab.";

/** The footer's one control over the wishlist half, for the whole batch. */
const CLEAR_WISHES_LABEL = "Also take these off my wishlist";

/**
 * What this dialog needs of `useDeck().addMissingToCollection` — narrowed the way `PullWrite` and
 * `DeckStats`' `MissingWrite` are, so the dialog can be rendered in a test with no query client
 * and so the one write it makes is visible in its own signature.
 *
 * **One object argument rather than two positional ones**, which is the shape a TanStack `mutate`
 * takes anyway: the write has two halves decided in two different places on screen — the picks by
 * the list, the flag by the footer's checkbox — and a caller that got them the wrong way round
 * would be sending a boolean where an array belongs.
 */
export interface AddMissingWrite {
  mutate: (input: { picks: DeckMissingPick[]; clearWishes: boolean }) => void;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  data: DeckMissingOutcome | undefined;
}

/**
 * One printing as this dialog says it aloud — `deckCardName`'s grammar, which is a
 * comma-separated list of clauses running from what the card *is* to what is true of it.
 *
 * **The count is deliberately not a clause, where `PullFromCollectionDialog`'s `saidAs` has
 * one.** There the number is the plan's and never moves; here it is a stepper the reader is
 * holding, so a name carrying it would rename the control under their finger on every press —
 * the same rule the pull's checkbox keeps by not moving its name with the tick, read one control
 * along.
 *
 * **The printing is a clause instead, and it has to be.** A deck can be short of two printings of
 * one card — the eight-Forests case the theory mark is written around — which is two rows here
 * carrying one printed name, and two controls with one name is two controls a screen reader
 * cannot tell apart. The finish is in it for the same reason one axis over: a deck playing the
 * foil and the regular copy of one printing is two rows of this list.
 */
function saidAs(row: DeckMissingRow): string {
  const parts = [
    row.name,
    ...(row.finish === null ? [] : [FINISH_LABEL[row.finish].toLowerCase()]),
    `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
  ];
  return parts.join(", ");
}

/**
 * What one row's wishlist half would do, as the sentence drawn beside it.
 *
 * The three shapes come straight off {@link PlannedMissingRow.wish} and **none of the numbers is
 * recomputed here** — `clears` is already capped by what the wish holds and `matches` is already
 * counted, so a component deriving either from `row.wishes.length` would be a second place one of
 * them is decided.
 *
 * `null` folder names are worded **here** rather than in the backend, which is
 * `DeckQuickAddWish.folderName`'s own rule: the root is a place with a name the reader already
 * knows, and which name it is depends on the cabinet being drawn.
 */
function wishLine(planned: PlannedMissingRow): string | null {
  const { wish } = planned;
  if (wish === null) return null;
  if (wish.kind === "ambiguous") {
    return `${wish.matches} wishlist lines match — left alone`;
  }
  return (
    `Clears ${plural(wish.clears, "copy", "copies")} off a wish in ` +
    `${wish.folderName ?? WISHLIST_ROOT_LABEL}`
  );
}

/** The way out, and the affirmative, in the app's two button shapes. Written once because the
 *  footer draws both on one line and a pair that drifted would read as two decisions. */
const CANCEL = cn(
  "h-8 shrink-0 rounded-md border border-border px-3 text-xs text-dim",
  "transition-colors duration-150 hover:text-text",
  "motion-reduce:transition-none",
  FOCUS,
);

const CONFIRM = cn(
  "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
  "transition-colors duration-150 hover:bg-accent hover:text-bg",
  "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
  "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-accent",
  "motion-reduce:transition-none",
  FOCUS,
);

export interface AddMissingToCollectionDialogProps {
  open: boolean;
  /** The deck whose folder the copies are filed into — the dialog names it. */
  deckName: string;
  /**
   * The plan, or `null` while the read has not answered.
   *
   * **Never filtered here and never re-sorted.** There is one entrance, so unlike the pull there
   * is no per-card narrowing to keep at the caller — but the rule survives for the same reason it
   * exists there: the order is the deck's own read order, which `deck::live_shortfall` decided,
   * and a component that sorted what it was handed would be a second opinion about a list two
   * dialogs share.
   */
  rows: readonly DeckMissingRow[] | null;
  loading: boolean;
  /** Why the plan could not be read, already through `ipcError`. */
  readError: string | null;
  add: AddMissingWrite;
  onClose: () => void;
}

/**
 * Ask which of the copies a deck is short of the reader has actually bought, and record them.
 *
 * Every prop but `open` is about the read or the write; the dialog owns only the reader's
 * amendments to the plan and the wishlist checkbox, and both live in the body, which
 * {@link Dialog} mounts and unmounts with the flag — so each open starts clean and no effect has
 * to reset anything.
 */
export function AddMissingToCollectionDialog({
  open,
  deckName,
  rows,
  loading,
  readError,
  add,
  onClose,
}: AddMissingToCollectionDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Add missing to collection"
      // The deck is named here rather than in the heading, which is `PullFromCollectionDialog`'s
      // arrangement for its reason: the heading is what the press does and is the same on every
      // deck, where the destination is the fact that changes — and a long deck name in a heading
      // truncates the heading. The second sentence is the one thing a reader could otherwise get
      // wrong about a control sitting beside `Pull from collection`: the two are not opposites,
      // and this one takes nothing out of the collection at all.
      subtitle={
        `Records copies you have just acquired into ${deckName}'s folder. ` +
        "Nothing is moved out of your collection."
      }
      closeLabel="Close the add list"
      // Narrower than the pull's `w-[52rem]`, and it is the difference list's width rather than a
      // third number: a row here carries no source sentence — no folder name, condition and up to
      // four traits — so the widest thing beside a card's name is a wish line naming one folder.
      size="w-[47.5rem]"
      // **One callback for both rungs, because the host is given one.** `Dialog` tells Escape and
      // the ✕ (which hand focus back to whatever opened the dialog) from a press on the scrim
      // (which does not, since the reader is already somewhere else) — and where the caret lands
      // is the *opener's* half of the contract, decided in the view that owns the trigger.
      onDismiss={onClose}
      onClose={onClose}
    >
      <AddMissingBody
        deckName={deckName}
        rows={rows}
        loading={loading}
        readError={readError}
        add={add}
        onClose={onClose}
      />
    </Dialog>
  );
}

/**
 * The plan itself — the reader's amendments to it, the list, and the press.
 *
 * Mounted only while the dialog is open, which is {@link Dialog}'s guarantee and what makes both
 * pieces of state below a session rather than something an effect has to clear.
 */
function AddMissingBody({
  deckName,
  rows,
  loading,
  readError,
  add,
  onClose,
}: {
  deckName: string;
  rows: readonly DeckMissingRow[] | null;
  loading: boolean;
  readError: string | null;
  add: AddMissingWrite;
  onClose: () => void;
}) {
  /**
   * **The reader's amendments, which is the honest way round.**
   *
   * Every row arrives ticked at its whole shortfall, so the state is a record of the two things a
   * reader can say that the plan does not already say: *not this row* and *not that many*. It is
   * keyed by `pullKey` rather than by index, so a refetch under an open dialog — the query sits
   * under `["decks"]`, which every deck write in the app invalidates — lands a new row already
   * ticked, exactly as it would have been had the refetch been a second earlier.
   */
  const [choice, setChoice] = useState<MissingChoice>(NO_MISSING_CHOICE);

  /**
   * Whether the press also takes copies off the wishlist — **on by default**, because a reader
   * who has just bought a card they had wished for wants both halves, and the write's own answer
   * for an ambiguous or absent match is to leave the wish standing anyway.
   *
   * One control for the whole batch: the per-row answer is already drawn beside each row, and a
   * checkbox per row would be a second way to say what unticking the row already says.
   */
  const [clearWishes, setClearWishes] = useState(true);

  /** What the press would write, and every number on screen. One derivation, so the footer's
   *  total and a row's own stepper can never come to disagree about one tick. */
  const plan = useMemo(
    () => planAddMissing(rows ?? NO_ROWS, choice, clearWishes),
    [rows, choice, clearWishes],
  );

  const addRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  const pending = add.isPending;

  // The disabled-on-press hazard, in `PullFromCollectionDialog`'s shape: a browser blurs a control
  // that disables itself, with no `relatedTarget` at all, so the caret lands on `<body>` and the
  // reader's next Tab restarts from the top of the *panel*, which is the ✕. The button is still
  // here when the write settles, so it takes the caret back — and only from `<body>`, because a
  // reader who has moved on in the meantime owns where they are.
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      addRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  /**
   * What the last press recorded, or `""` while there is nothing to say.
   *
   * **There is no zero arm, which is the one place this departs from the pull's answer.** That
   * write can succeed having moved nothing, because a source another window emptied is a hole
   * somebody else filled first; this one refuses an empty batch outright with `NOTHING_PICKED`
   * and checks every pick at one copy or more *before* anything is written, so a success always
   * carries at least one copy and "Recorded 0 copies" is a sentence the backend cannot produce.
   *
   * It is not cleared as the reader works: the write is all-or-nothing and reports what actually
   * happened, so the sentence stays true for as long as the dialog is open — and it is very often
   * the only thing on screen explaining why the list under it has just gone empty.
   */
  const done =
    !add.isSuccess || add.data === undefined
      ? ""
      : `Recorded ${plural(add.data.copies, "copy", "copies")} of ` +
        `${plural(add.data.cards, "card")} into ${deckName}.` +
        (add.data.wishCopies > 0
          ? ` ${plural(add.data.wishCopies, "copy", "copies")} off your wishlist.`
          : "");

  const failure = add.isError ? ipcError(add.error) : null;

  /** Nothing ticked, or nothing to tick. `aria-disabled` and not the attribute, because this
   *  greys and un-greys as the reader works and a real `disabled` button leaves the tab order —
   *  so a reader who unticked their last row would find the caret thrown out of the footer by
   *  their own press. `pending` is the other kind of no and *is* the attribute: it is the
   *  half-second the write is in flight. */
  const nothingPicked = plan.picks.length === 0;

  return (
    // The shell's header sits above these two, and the panel around them is the `flex flex-col`
    // that makes the scroller work — see {@link Dialog}.
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {loading ? (
          <p className="px-2 py-6 text-center text-xs text-dim">{READING}</p>
        ) : readError !== null ? (
          // The read's own refusal, in the backend's words, where the rows would have been. No
          // retry button: the host re-reads the next time this opens, and every deck write in the
          // app already invalidates the key it sits under.
          <p className="px-2 py-6 text-center text-xs text-dim">{readError}</p>
        ) : plan.rows.length === 0 ? (
          // **Not styled as a failure, and this is the state most likely to be mistaken for one.**
          // A reader arrives here from a band that says how much the deck is missing, so the panel
          // has to say why those two numbers are allowed to disagree.
          <div className="mx-auto max-w-md px-2 py-6 text-center">
            <p className="text-sm">{NOTHING_TO_RECORD.headline}</p>
            <p className="mt-2 text-xs leading-relaxed text-dim">{NOTHING_TO_RECORD.why}</p>
          </div>
        ) : (
          // A list rather than a `<table>`: every cell here is a control or a caption on one, the
          // columns do not sort, and `components/table/VirtualTable.tsx` is what a table is in
          // this app.
          <ul>
            {plan.rows.map((planned) => (
              <Row
                key={planned.key}
                planned={planned}
                onToggle={(on) => setChoice((was) => toggleRow(was, planned.key, on))}
                onCopies={(copies) => setChoice((was) => setCopies(was, planned.key, copies))}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-3.5">
        <p className="min-w-[14rem] flex-1 text-[0.7rem] leading-snug text-dim">{ADD_NOTE}</p>

        {/* Mounted for the life of the body and swapped into: a live region that appears together
            with its own text announces nothing, because there was no change for a screen reader to
            notice. It is the one thing about this footer that cannot be moved inside a
            conditional. */}
        <p
          role="status"
          aria-live="polite"
          className="min-w-0 shrink text-right text-[0.7rem] text-dim"
        >
          {done}
        </p>

        {/* Beside the button that was pressed, not in the editor's banner behind the scrim — a
            refusal reported somewhere the reader cannot see is a refusal they have to go looking
            for. Its own animated element, carrying no padding and no border so `height: 0` really
            is 0; `overflow-hidden` is still owed, because the sentence is laid out at full size
            whatever the box around it is doing. */}
        <AnimatePresence initial={false}>
          {failure !== null && (
            <motion.p
              {...statusLine}
              role="alert"
              className="min-w-0 shrink overflow-hidden text-right text-[0.7rem] text-destructive"
            >
              Could not record — {failure}
            </motion.p>
          )}
        </AnimatePresence>

        {/* **The whole-batch answer to the wishlist half.** A real `<label>` wrapping its own
            input, so the accessible name is the label's single text node — two spans with a `gap`
            between them compute to a name with the words run together, which is how a control
            here would come to be called something nobody wrote. */}
        <label className="flex shrink-0 items-center gap-1.5 text-[0.7rem] text-dim">
          <input
            type="checkbox"
            checked={clearWishes}
            onChange={(e) => setClearWishes(e.target.checked)}
            className={cn("size-3.5 shrink-0 accent-accent", FOCUS)}
          />
          {CLEAR_WISHES_LABEL}
        </label>

        {/* The scope of the press, in the units it is counted in. Copies is what is recorded and
            cards is how many lines of the deck it settles, and a reader checking one against the
            list above needs both — the button below can only carry one of them. The wishlist
            clause is drawn only when there is one, so unticking the checkbox above takes it away
            rather than printing a zero. */}
        <p className="shrink-0 font-mono text-xs tabular-nums text-dim">
          {plural(plan.copies, "copy", "copies")} across {plural(plan.cards, "card")}
          {plan.wishesCleared > 0 &&
            ` · ${plural(plan.wishesCleared, "copy", "copies")} off your wishlist`}
        </p>

        <button type="button" onClick={onClose} className={CANCEL}>
          Cancel
        </button>

        <button
          ref={addRef}
          type="button"
          disabled={pending}
          aria-disabled={nothingPicked || undefined}
          // The guard the paint would otherwise be lying about: an `aria-disabled` control still
          // delivers its press.
          onClick={() => {
            if (nothingPicked) return;
            // **Copied out of the readonly plan, which costs nothing and is what the wire type
            // asks for.** `DeckMissingPick` is a mutable struct because it is what `invoke`
            // serialises; `AddMissingPlan.picks` is `readonly` because it is also what the rows on
            // screen were counted from. `planAddMissing` already builds a fresh object per pick
            // for exactly this reason, so the spread copies the array and shares nothing a caller
            // downstream could reach back into.
            add.mutate({ picks: [...plan.picks], clearWishes });
          }}
          className={CONFIRM}
        >
          {/* The verb keeps its name through the flow, and the number is the one in the readout
              beside it. `Add 0 copies to collection` at nothing ticked rather than a bare `Add`:
              the count is what explains the greying, which is the difference between a control
              that is out of reach and one that looks broken. */}
          {pending ? "Recording…" : `Add ${plural(plan.copies, "copy", "copies")} to collection`}
        </button>
      </footer>
    </>
  );
}

/**
 * One printing the deck is short of: whether it is going, how many copies of it, and what that
 * would do to the reader's shopping list.
 *
 * **Four lines rather than one**, which is the pull's row reached by the same arithmetic off this
 * panel's own classes rather than by a live measurement: `w-[47.5rem]` is 760px, the scroller's
 * and the row's padding take 40 of it, and the checkbox, the art, the stepper column and the four
 * gaps take a little over 200 more — so a wish sentence naming a folder is on its own longer than
 * what is left beside a card's name. Under the name it costs a line of height and nothing else.
 */
function Row({
  planned,
  onToggle,
  onCopies,
}: {
  planned: PlannedMissingRow;
  onToggle: (on: boolean) => void;
  onCopies: (copies: number) => void;
}) {
  const { row, on, copies } = planned;

  // The desktop/web branch, in the one place it is ever written: the protocol URL on Tauri, the
  // row's own `cards.scryfall.io` URL in a browser — which has no `mtgimg://` to ask, because
  // wasm cannot register a URL scheme with one — and `null` when the row carries neither. A
  // `null` draws no `<img>` at all, leaving the `bg-surface` frame below, which is what this line
  // shows while the bytes are on their way and for a printing that has no art.
  const art = cardArtSrc(cardImageUrl(row.cardId, 0, "art"), row.imageUris?.art);

  const wish = wishLine(planned);

  return (
    <li
      className={cn(
        "rounded-md px-2 py-2",
        "transition-colors duration-150 hover:bg-surface",
        "motion-reduce:transition-none",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
          // Named for the printing, never "Select": a column of twelve checkboxes with one name is
          // twelve controls a screen reader cannot tell apart. The name does **not** move with the
          // tick or with the stepper — it says what the row *is*, not what the row is currently
          // doing, so a reader pressing either control does not hear the other rename itself.
          aria-label={`Add ${saidAs(row)}`}
          className={cn("mt-1 size-4 shrink-0 accent-accent", FOCUS)}
        />

        {/* **The row is dimmed whole rather than emptied**, which is why the wrapper starts after
            the checkbox: the tick is the control that undoes this state and must not be greyed by
            it. Everything inside goes on saying exactly what it said — including the wish line,
            which is a fact about the row's own wishlist entry and stays true whether or not the
            press acts on it. */}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-start gap-3",
            "transition-opacity duration-150 motion-reduce:transition-none",
            !on && "opacity-60",
          )}
        >
          {/* The `art` crop (626×457) as decoration beside the name — `aria-hidden`, empty alt and
              `draggable={false}`, which is the deck row's arrangement for the deck row's reasons.
              Through `CardImage`, never a bare `<img>`: this is a *slot*, and a browser paints an
              `<img>`'s last decoded frame until the new src decodes, so the picture would lag the
              name by the length of the fetch. */}
          <span
            aria-hidden="true"
            className="mt-0.5 h-8 w-11 shrink-0 overflow-hidden rounded bg-surface"
          >
            {art !== null && (
              <CardImage
                src={art}
                alt=""
                draggable={false}
                // Lazy, for the difference list's reason and not a wall's: this is a plain
                // scroller, so a sixty-row plan really is sixty mounted rows.
                loading="lazy"
                className="size-full object-cover"
              />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-sm">{row.name}</span>
              {/* **The line's whole reason for being distinguishable, where a name alone would
                  make two rows read as a duplicate.** `FinishMark` draws nothing for the regular
                  copy, which is right: the plain card is the unmarked case everywhere else in the
                  app. The glyph carries its own `role="img"` and label, so a screen reader hears
                  "Foil" beside the name rather than reading a shape. */}
              <FinishMark finish={row.finish ?? "nonfoil"} />
            </span>

            {/* The printing, in the same spelling as every other card row in the app, and the
                piles the shortfall is spread over. **The piles are for the reader and never for
                the write**: the backend folds a shortfall to the printing, because what somebody
                is short of is cardboard and custody is a fact about the deck rather than about a
                column. Two facts on one wrapping line, because at a narrow panel the printing is
                the half that must not be pushed off the end. */}
            <span className="flex flex-wrap items-baseline gap-x-2 text-[0.7rem] text-dim">
              <span className="font-mono tabular-nums">
                {row.setCode.toUpperCase()} · {row.collectorNumber}
              </span>
              <span className="min-w-0 truncate">Short in {row.categories.join(", ")}</span>
            </span>

            {/* **A statement, not a question, and not a warning.** `text-dim` and no live-region
                role: a wish this press will not touch is the ordinary answer, and a destructive
                colour would report the reader's own shopping list as a fault. Drawn only where
                there is something to say — a row on no wishlist says nothing at all rather than
                saying so. */}
            {wish !== null && <span className="text-[0.7rem] text-dim">{wish}</span>}
          </span>

          {/* **How many copies, which is the one thing the backend cannot know.** The stepper is
              floored at one and capped at the row's own shortfall, so the number on screen is
              always inside what the write will accept — and it stays live on an unticked row,
              because a reader who unticks a line and ticks it back has not changed their mind
              about how many they bought.

              The ceiling is drawn beside it and `aria-hidden`: the field reports its own `min` and
              `max`, so a bare "of 3" would be two loose words to anyone who cannot see the stepper
              they sit under. */}
          <span className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5">
            <QuantityStepper
              value={copies}
              onChange={onCopies}
              min={1}
              max={row.short}
              size="sm"
              label={`Copies of ${saidAs(row)}`}
            />
            <span aria-hidden="true" className="font-mono text-[0.65rem] tabular-nums text-dim">
              of {row.short}
            </span>
          </span>
        </div>
      </div>
    </li>
  );
}
