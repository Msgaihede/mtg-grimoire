/**
 * **The other direction from the wishlist: what this deck is short of that is already on the
 * reader's desk.**
 *
 * A deck lists four Lightning Bolts and physically holds one, so the editor reads *3 missing* —
 * and three more are sitting in a binder two rooms away from the screen that says so. The
 * shortfall and the shelf have always both been in the database; what was missing was the one
 * press that puts them together. `DeckStats`' `Send missing to wishlist` is the same question
 * asked of the copies the reader has **not** got; this is the half that can be answered without
 * spending anything (issue #351).
 *
 * ## Two entrances, one dialog
 *
 * The deck-wide press in the stats band was the only one until 2026-09-03; a deck card's
 * right-click now has `Collection ▸ Pull N from your collection`, which is the same dialog over
 * **one row of the plan** (issue #350). The narrowing is entirely the caller's — it filters the
 * plan to that card's {@link pullKey} and passes a `cardName` for the sentence — so nothing in
 * this file knows the difference beyond one line of prose, and the per-card press reads the same
 * cached `deck_pull_plan` the deck-wide one does.
 *
 * **The per-card entrance opens this dialog only when there is a decision in it**: one candidate
 * pulls outright with no dialog at all, and two or more, or none, land here. That test is
 * `quickCollection.ts`'s `choosePull` and is deliberately not this component's — a dialog that
 * decided whether it should have been opened is a dialog with an opinion about its own caller.
 *
 * ## What the reader is actually deciding
 *
 * Almost never anything. Every row arrives ticked, the backend has already pre-picked a source
 * per row, and the ordinary act is one press on the footer. What the body is *for* is the
 * minority of rows where a choice exists at all — the issue's one explicit request, "if
 * redundant options exist in different folders, prompt the user to choose which option to pull
 * from" — and the minority where the collection cannot cover the line. Both are drawn as facts
 * beside the row rather than as questions that stop the press, because a dialog that interrogates
 * a reader about four rows to move six cards is worse than the two windows it replaced.
 *
 * **So the source picker is drawn only where there is more than one candidate.** A picker holding
 * one option is a control that reads as a choice and is not; the same sentence is printed as
 * plain text instead, in the same words and the same place, so the two shapes of the row are one
 * row with and without a decision in it.
 *
 * The picker is `components/Dropdown/Dropdown.tsx` and not a native `<select>`, which is the only
 * kind of option list left in this app — `Dropdown.tsx`'s own doc says every one of them is being
 * replaced with that shell, and a new `<select>` here would be the single remaining one. It is
 * drawn **inside** a `Dialog`, which needs nothing said about it at either end:
 * `CategoriesDialog`'s delete confirmation is the same arrangement on the same shell, the popup
 * corrects for whatever containing block it lands in (`usePopupPlacement`), and the dropdown's
 * own capture-phase Escape rung mounts after this dialog's and is therefore above it on
 * `useDismissOnEscape`'s stack — so one press closes the open picker and the next closes the
 * dialog.
 *
 * ## The four states of the body, and why none of them may be folded together
 *
 * `loading`, `readError`, an **empty** plan and rows to review. The third is the one that is
 * easy to draw wrongly, because it looks like a failure and is the ordinary answer: a pull moves
 * only the exact printing **and finish** the list names and never a copy another deck is already
 * holding, so a deck that reads *12 missing* can legitimately have nothing to pull. That
 * narrowing is `DeckPullRow.finish`'s own doc — the app attributes owned copies at the *oracle*
 * grain, this fills strictly fewer holes than the app itself counts, and the trade is that
 * nothing is ever moved that is not the piece of cardboard the list asked for. The empty sentence
 * says all of that, because a reader who is not told will read the blank panel as broken.
 *
 * ## What this component is not
 *
 * It holds **no query and no mutation**. `rows`, `loading`, `readError` and the write all arrive
 * as props — {@link PullWrite} is narrowed the way `DeckStats`' `MissingWrite` is — so the dialog
 * renders in a test with no query client, and the one write it makes is visible in its own
 * signature rather than reachable through a hook it happens to import. `DeckSettingsForm`'s fence,
 * applied to a surface that does have a button.
 *
 * The chrome is `components/Dialog.tsx`'s: the scrim, the centring, `aria-modal`, `trapTab`, the
 * ✕ and the `"inner"` Escape rung are written once there, and a new modal in this surface is
 * built **on** that file rather than beside it (`DeckEditor.tsx`'s `Layer` doc says why, in the
 * cost the four hand-copies ran up before 2026-08-16).
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CardImage } from "@/components/CardImage";
import { Dialog } from "@/components/Dialog";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FinishMark } from "@/components/FinishMark";
import { CONDITIONS, CONDITION_LABEL } from "@/lib/conditions";
import { plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { cardArtSrc, cardImageUrl } from "@/lib/images";
import {
  ipcError,
  type DeckPullCandidate,
  type DeckPullOutcome,
  type DeckPullPick,
  type DeckPullRow,
} from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  NO_CHOICE,
  planPull,
  preferSource,
  toggleRow,
  type PlannedRow,
  type PullChoice,
} from "./pullPlan";

/**
 * Stable identity for "the read has not answered", so {@link planPull} is not re-run over a fresh
 * empty array on every render of a dialog that is still waiting. `TheoryDiffDialog`'s `NO_ROWS`,
 * for its reason.
 */
const NO_ROWS: readonly DeckPullRow[] = [];

/**
 * The collection's own word for the root, which is what a `null` `folderName` is.
 *
 * `PickCopies.tsx` states the same rule for the same column and keeps its own copy of this
 * string: the top level is a real place with a name the reader already knows from the
 * breadcrumb, not the absence of one, and a row reading "No folder" would be describing the
 * drawer the breadcrumb calls Collection. Two spellings of one word is a thing worth noticing —
 * that constant is module-private over there, and folding the two together is a change to a file
 * this one does not own.
 */
const ROOT_LABEL = "Collection";

/** The language every printing is in unless it says otherwise, and the one an option never
 *  draws — `PickCopies`' rule: a `JA` beside a condition is a fact worth a word, an `EN` on
 *  ninety-odd per cent of rows is a column of noise. */
const DEFAULT_LANG = "en";

/**
 * The standing sentence at the foot of the panel — the two things about this press that cannot be
 * read off the list above it.
 *
 * **It writes no `deck_cards` row**, which is the whole difference from the Collection tab's add:
 * that command is "put this card in the deck" and folds the quantity into the list, so pointing it
 * at a 4-copy line the reader is 3 short of would make the line 7. This one changes only *where
 * the copies sit*, which is the only half a shortfall is about.
 *
 * **And it files no undo step**, for `deck_to_collection`'s reason exactly — `take_copies` files
 * the copies through the merge, so a source row may have been folded into whatever the group
 * already held and no longer exists to restore. Saying so here is what makes the absence visible
 * rather than discovered; the way back is named, because an error message that only refuses is
 * half a sentence.
 */
const PULL_NOTE =
  "The copies move into this deck. The list itself does not change, and there is no undo — " +
  "put a copy back from the Collection tab.";

/** What the body says while the read is in flight. */
const READING = "Reading your collection…";

/**
 * What an empty plan means, in the reader's terms.
 *
 * **Three sentences and none of them apologises**, because nothing has gone wrong: this is the
 * answer for a deck that is short of nothing, for a deck whose shortfall is all cards that were
 * never owned, and for the deck the reader has just emptied their binder into. The *why* is the
 * load-bearing part — without it, a reader looking at a header that says `12 missing` reads this
 * panel as a broken query rather than as a narrowing they would agree with if they knew about it.
 */
const NOTHING_TO_PULL = {
  headline: "Nothing to pull.",
  why:
    "A pull moves only the exact printing and finish the list names, and never a copy another " +
    "deck is already holding. What this deck is still short of is either a card you have not " +
    "got or one that is filed with another deck.",
} as const;

/**
 * What this dialog needs of `useDeck().pullFromCollection` — narrowed the way `DeckStats`'s
 * {@link MissingWrite} is, so the dialog can be rendered in a test with no query client and so
 * the one write it makes is visible in its own signature.
 */
export interface PullWrite {
  mutate: (picks: DeckPullPick[]) => void;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  data: DeckPullOutcome | undefined;
}

/**
 * A stored grade as the app spells it, or the raw column where it is not one of the five.
 *
 * **A loop rather than a cast**, which is `CollectionPage.tsx`'s narrowing verbatim and for its
 * reason: the database holds text, and a row written by an import or by an older build may carry
 * a word this build has never heard of. `lib/conditions.ts` publishes no type guard, so the
 * narrowing is done at the reading site rather than by widening that module for one caller.
 */
function conditionLabel(raw: string): string {
  for (const condition of CONDITIONS) if (condition === raw) return CONDITION_LABEL[condition];
  return raw;
}

/**
 * One candidate as a line of prose — where the copy sits, and everything that tells it from its
 * siblings.
 *
 * `PickCopies.tsx`'s `copyFace` one surface over, with one difference that matters: this string
 * is an `<option>`'s text, and an `<option>` has no children — so there is no eye/ear split to
 * keep and one string does both jobs. The middot is the app's own separator everywhere a card
 * row states its facts, and a screen reader announcing an option reads it as the pause it looks
 * like.
 *
 * **The folder is always said, and it is the first term.** Two copies of one printing in one
 * condition are told apart by nothing else, and the backend's pre-pick order is a folder order —
 * root, then `Recently removed`, then the reader's own binders — so a list whose rows begin with
 * the place reads in the order it is ranked in.
 *
 * **Everything after the condition is drawn only when it is set**, which is what keeps the
 * ordinary option to two terms. The flags are a fact about the *cardboard* rather than about the
 * printing, and they are exactly the facts a reader chooses on: nobody puts their signed copy in
 * a deck by accident, and nobody wants to find out afterwards that they did.
 *
 * `serialNumber` is here for the same reason and is the last thing standing between two rows that
 * are otherwise word-for-word identical — a select whose options read alike is a select no answer
 * can be given to.
 *
 * The quantity is last because it is the term a reader checks rather than chooses by: it is what
 * says whether one source covers the line on its own, which is the question the count column on
 * the right is already answering from the other end.
 */
function candidateFace(candidate: DeckPullCandidate): string {
  const parts = [
    candidate.folderName ?? ROOT_LABEL,
    conditionLabel(candidate.condition),
    ...(candidate.lang.toLowerCase() === DEFAULT_LANG ? [] : [candidate.lang.toUpperCase()]),
    ...(candidate.grading === null ? [] : [candidate.grading]),
    ...(candidate.altered ? ["Altered"] : []),
    ...(candidate.signed ? ["Signed"] : []),
    ...(candidate.proxy ? ["Proxy"] : []),
    ...(candidate.misprint ? ["Misprint"] : []),
    ...(candidate.serialNumber === null ? [] : [`#${candidate.serialNumber}`]),
    plural(candidate.quantity, "copy", "copies"),
  ];
  return parts.join(" · ");
}

/**
 * A card's name as this dialog says it aloud — `cardControl.tsx`'s `deckCardName` grammar, which
 * is a comma-separated list of clauses running from what the card *is* to what is true of it.
 *
 * The count is a clause because it is what the press writes, and the finish is a clause because
 * **two rows can otherwise carry the same name**: a deck playing the foil and the regular copy of
 * one printing is two rows of this list, and two controls with one name is two controls a screen
 * reader cannot tell apart. Lowercased for `deckCardName`'s reason — the constant is written as a
 * label and this is a sentence.
 */
function saidAs(row: DeckPullRow): string {
  const parts = [
    row.name,
    plural(row.short, "copy", "copies"),
    ...(row.finish === null ? [] : [FINISH_LABEL[row.finish].toLowerCase()]),
  ];
  return parts.join(", ");
}

/**
 * The same printing as a **noun phrase** — `Lightning Bolt`, `foil Lightning Bolt`.
 *
 * {@link saidAs} is a list of facts *about* a control, which is `deckCardName`'s grammar and the
 * right shape for a checkbox's name; this is the one place the printing has to sit **inside** a
 * sentence instead, and a clause list dropped into the middle of one ("which copy of Lightning
 * Bolt, 3 copies, foil to pull") is not English. The two read the same two fields and differ only
 * in word order, which is why this is four lines rather than an argument to the other one.
 *
 * The finish is what makes it unique: a deck playing the foil and the regular copy of one
 * printing is two rows of this list, and two pickers with one name is two controls a screen
 * reader cannot tell apart.
 */
function printingName(row: DeckPullRow): string {
  return row.finish === null ? row.name : `${FINISH_LABEL[row.finish].toLowerCase()} ${row.name}`;
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

/**
 * The subtitle, in the two scopes this dialog is opened at.
 *
 * **A card name narrows the sentence and nothing else about the dialog changes**, which is the
 * whole of what {@link PullFromCollectionDialogProps.cardName} buys: the body draws whatever rows
 * it was handed, so the per-card opener is the deck-wide one with a filter applied at the caller
 * and a sentence that says so. Written as a function rather than inline because it is the one
 * place the two scopes are told apart, and a reader looking for that difference should find it
 * in one place.
 */
function subtitleFor(deckName: string, cardName: string | null | undefined): string {
  return cardName === null || cardName === undefined
    ? `Cards this deck is short of that you already own — into ${deckName}`
    : `Copies of ${cardName} you already own — into ${deckName}`;
}

export interface PullFromCollectionDialogProps {
  open: boolean;
  /** The deck the copies are going into — the dialog names it. */
  deckName: string;
  /**
   * The one card this pull is about, or absent for the deck-wide press.
   *
   * **Only the subtitle reads it.** The rows arrive **already filtered** — see {@link rows} —
   * so this component holds no opinion about a `PullKey` and cannot come to disagree with the
   * caller about which rows belong to which card. What it changes is the sentence under the
   * heading, because a panel headed `Pull from collection` over a single row, saying *cards this
   * deck is short of*, reads as a plan that has lost the rest of itself.
   */
  cardName?: string | null;
  /**
   * The plan, or `null` while the read has not answered.
   *
   * **Filtered by the caller, never here.** The per-card entrance (a deck card's
   * `Collection ▸ Pull …`) hands over the rows whose {@link pullKey} matches that card, and the
   * deck-wide one hands over the whole plan. Keeping the narrowing at the caller is what stops
   * this component growing a notion of a `PullKey` — and it is the same rows either way, out of
   * the same cached `deck_pull_plan`, so the two entrances can never draw a different plan for
   * one deck.
   */
  rows: readonly DeckPullRow[] | null;
  loading: boolean;
  /** Why the plan could not be read, already through `ipcError`. */
  readError: string | null;
  pull: PullWrite;
  onClose: () => void;
}

/**
 * Ask which owned copies to move into the deck, and move them.
 *
 * Every prop but `open` is about the read or the write; the dialog owns only the reader's
 * amendments to the plan, and those live in the body, which {@link Dialog} mounts and unmounts
 * with the flag — so each open starts clean and no effect has to reset anything.
 */
export function PullFromCollectionDialog({
  open,
  deckName,
  cardName,
  rows,
  loading,
  readError,
  pull,
  onClose,
}: PullFromCollectionDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Pull from collection"
      // The deck is named here rather than in the heading: `Pull from collection` is what the
      // press does and stays the same on every deck, where the destination is the fact that
      // changes — which is what {@link DialogProps.subtitle} is for, and why it is under the
      // heading rather than beside it (a long deck name would otherwise truncate the heading).
      // **The scope rides here too** rather than in the heading, for exactly that reason: a
      // per-card pull does the same thing to the same deck, and a heading that changed with the
      // opener would make one press look like two features.
      subtitle={subtitleFor(deckName, cardName)}
      closeLabel="Close the pull list"
      // Wider than the difference list's `w-[47.5rem]`, because a row here carries a sentence the
      // shopping list does not: a source naming a folder, a condition and up to four traits is
      // longer than any price column. Still inside the app's 1024px window floor once the scrim's
      // `sm:p-6` is taken off both sides.
      size="w-[52rem]"
      // **One callback for both rungs, because the host is given one.** `Dialog` tells Escape and
      // the ✕ (which hand focus back to whatever opened the dialog) from a press on the scrim
      // (which does not, since the reader is already somewhere else) — and where the caret lands
      // is the *opener's* half of the contract, decided in the view that owns the trigger. A
      // second prop here would be this component guessing at it.
      onDismiss={onClose}
      onClose={onClose}
    >
      <PullBody
        deckName={deckName}
        rows={rows}
        loading={loading}
        readError={readError}
        pull={pull}
        onClose={onClose}
      />
    </Dialog>
  );
}

/**
 * The plan itself — the reader's amendments to it, the list, and the press.
 *
 * Mounted only while the dialog is open, which is {@link Dialog}'s guarantee and what makes
 * {@link PullChoice} a session rather than something an effect has to clear.
 */
function PullBody({
  deckName,
  rows,
  loading,
  readError,
  pull,
  onClose,
}: {
  deckName: string;
  rows: readonly DeckPullRow[] | null;
  loading: boolean;
  readError: string | null;
  pull: PullWrite;
  onClose: () => void;
}) {
  /**
   * **The reader's amendments, which is the honest way round.**
   *
   * Every row arrives ticked on its backend-ranked source, so the state is a record of the two
   * things a reader can say that the plan does not already say: *not this row* and *not that
   * source*. It is keyed by {@link PullKey} rather than by index, so a refetch under an open
   * dialog — the query sits under `["decks"]`, which every deck write in the app invalidates —
   * lands a new row already ticked, exactly as it would have been had the refetch been a second
   * earlier. `TheoryDiffDialog`'s exclusion set, for its reason.
   */
  const [choice, setChoice] = useState<PullChoice>(NO_CHOICE);

  /** What the press would write, and every number on screen. One derivation, so the footer's
   *  total and a row's own count can never come to disagree about one tick. */
  const plan = useMemo(() => planPull(rows ?? NO_ROWS, choice), [rows, choice]);

  const pullRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  const pending = pull.isPending;

  // The disabled-on-press hazard, in `DeckStats`' shape: a browser blurs a control that disables
  // itself, with no `relatedTarget` at all, so the caret lands on `<body>` and the reader's next
  // Tab restarts from the top of the app — inside a modal, from the top of the *panel*, which is
  // the ✕. The button is still here when the write settles, so it takes the caret back — and only
  // from `<body>`, because a reader who has moved on in the meantime owns where they are.
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      pullRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  /**
   * What the last press moved, or `""` while there is nothing to say.
   *
   * **It is not cleared as the reader works, which is the opposite of `DeckStats`' rule and is
   * right here for the same reason that one is right there.** That button folds quantities, so
   * its sentence stops being true the moment the shortfall changes; this write is all-or-nothing
   * and reports what actually moved, so the sentence stays true for as long as the dialog is
   * open — and it is very often the only thing on screen explaining why the list under it has
   * just gone empty.
   *
   * Zero is drawn as its own sentence rather than as "0 copies": the backend refuses a batch it
   * disagrees with rather than half-applying it, so a success carrying nothing is a hole another
   * window filled first, and "Pulled 0 copies" is a number where a reason belongs.
   */
  const done =
    !pull.isSuccess || pull.data === undefined
      ? ""
      : pull.data.copies === 0
        ? "Nothing moved — the copies had already been filed somewhere else."
        : `Pulled ${plural(pull.data.copies, "copy", "copies")} across ` +
          `${plural(pull.data.cards, "card")} into ${deckName}.`;

  const failure = pull.isError ? ipcError(pull.error) : null;

  /** Nothing ticked, or nothing to tick. `aria-disabled` and not the attribute, because this
   *  greys and un-greys as the reader works and a real `disabled` button leaves the tab order —
   *  so a reader who unticked their last row would find the caret thrown out of the footer by
   *  their own press (`src/CLAUDE.md`, and `PickCopies`' confirm button). `pending` is the other
   *  kind of no and *is* the attribute: it is the half-second the write is in flight. */
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
          // A reader arrives here from a header that says how much the deck is missing, so the
          // panel has to say why those two numbers are allowed to disagree.
          <div className="mx-auto max-w-md px-2 py-6 text-center">
            <p className="text-sm">{NOTHING_TO_PULL.headline}</p>
            <p className="mt-2 text-xs leading-relaxed text-dim">{NOTHING_TO_PULL.why}</p>
          </div>
        ) : (
          // A list rather than a `<table>`: every cell here is a control or a caption on one, the
          // columns do not sort, and `components/table/VirtualTable.tsx` is what a table is in
          // this app. `AllPrintingsDialog`'s printings and the difference list are the same shape
          // for the same reason.
          <ul>
            {plan.rows.map((planned) => (
              <Row
                key={planned.key}
                planned={planned}
                onToggle={(on) => setChoice((was) => toggleRow(was, planned.key, on))}
                onPrefer={(entryId) =>
                  setChoice((was) => preferSource(was, planned.key, entryId))
                }
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-3.5">
        <p className="min-w-[14rem] flex-1 text-[0.7rem] leading-snug text-dim">{PULL_NOTE}</p>

        {/* Mounted for the life of the body and swapped into: a live region that appears
            together with its own text announces nothing, because there was no change for a
            screen reader to notice. `DeckStats`' `Missing` is where this app learned it, and it
            is the one thing about this footer that cannot be moved inside a conditional. */}
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
              Could not pull — {failure}
            </motion.p>
          )}
        </AnimatePresence>

        {/* The scope of the press, in the two units it is counted in. Copies is what moves and
            cards is how many lines of the deck it settles, and a reader checking one against the
            list above needs both — the button below can only carry one of them. */}
        <p className="shrink-0 font-mono text-xs tabular-nums text-dim">
          {plural(plan.copies, "copy", "copies")} across {plural(plan.cards, "card")}
        </p>

        <button type="button" onClick={onClose} className={CANCEL}>
          Cancel
        </button>

        <button
          ref={pullRef}
          type="button"
          disabled={pending}
          aria-disabled={nothingPicked || undefined}
          // The guard the paint would otherwise be lying about: an `aria-disabled` control still
          // delivers its press.
          onClick={() => {
            if (nothingPicked) return;
            // **Copied out of the readonly plan, which costs nothing and is what the wire type
            // asks for.** `DeckPullPick` is a mutable struct because it is what `invoke`
            // serialises; `PullPlan.picks` is `readonly` because it is also what the rows on
            // screen were counted from. `planPull` already builds a fresh object per pick for
            // exactly this reason, so the spread copies the array and shares nothing a caller
            // downstream could reach back into.
            pull.mutate([...plan.picks]);
          }}
          className={CONFIRM}
        >
          {/* The verb keeps its name through the flow, and the number is the one in the readout
              beside it. `Pull 0 copies` at nothing ticked rather than a bare `Pull`: the count is
              what explains the greying, which is the difference between a control that is out of
              reach and one that looks broken. */}
          {pending ? "Pulling…" : `Pull ${plural(plan.copies, "copy", "copies")}`}
        </button>
      </footer>
    </>
  );
}

/**
 * One printing the deck is short of: whether it is going, which copy it is coming out of, and how
 * much of the hole that fills.
 *
 * **Four lines rather than one**, which is `TheoryDiffDialog`'s row growing a note under its name
 * for the same arithmetic: at `w-[52rem]` the row's content box is ~790px, the checkbox, the art,
 * the count column and the gaps take ~180 of it, and a source sentence naming a folder, a
 * condition and a trait is on its own longer than what is left beside a card's name. Under the
 * name it costs a line of height and nothing else.
 */
function Row({
  planned,
  onToggle,
  onPrefer,
}: {
  planned: PlannedRow;
  onToggle: (on: boolean) => void;
  onPrefer: (entryId: number) => void;
}) {
  const { row, on, taking, unfilled, source } = planned;
  /** The stem for this row's label/trigger pair. Per row, because two mounted controls sharing an
   *  `id` is a `<label htmlFor>` that presses the wrong one. */
  const id = useId();

  // The desktop/web branch, in the one place it is ever written: the protocol URL on Tauri, the
  // row's own `cards.scryfall.io` URL in a browser — which has no `mtgimg://` to ask, because
  // wasm cannot register a URL scheme with one — and `null` when the row carries neither. A
  // `null` draws no `<img>` at all, leaving the `bg-surface` frame below, which is what this line
  // shows while the bytes are on their way and for a printing that has no art.
  const art = cardArtSrc(cardImageUrl(row.cardId, 0, "art"), row.imageUris?.art);

  /**
   * The candidate the picker is showing, which is `planPull`'s answer and never this component's.
   *
   * **A picker handed a `value` no option carries does not draw blank in either shell.** A
   * controlled `<select>` lands on `selectedIndex 0` and calmly names the *first* source over a
   * press that would write a different one; `Dropdown` draws `DEFAULT_PLACEHOLDER` — a bare em
   * dash — which is the quieter version of the same lie, a control saying "no source at all" over
   * a plan that has one. `PlannedRow.source` is chosen out of `candidates`, so the match holds by
   * construction; the `??` is what keeps the fact stated in the single-candidate arm honest
   * rather than a lookup that can answer `undefined`.
   */
  const chosen = row.candidates.find((c) => c.entryId === source) ?? row.candidates[0];

  /**
   * The sources, in the order the backend ranked them.
   *
   * **Deliberately not through `sortOptions`** — one of the two exemptions `src/lib/options.ts`
   * names, and this is the one where the order *is* the information. The backend ranks candidates
   * by how little of the reader's filing a pull disturbs: the root first, then `Recently removed`,
   * then the reader's own binders in their own order, oldest row first inside each. The head of
   * that list is therefore also the pre-pick this control opens on, so alphabetising it would put
   * a binder called `Alpha` above the loose pile nobody had made a decision about and leave the
   * opening row looking arbitrary.
   */
  const sourceOptions: readonly DropdownOption[] = row.candidates.map((candidate) => ({
    value: String(candidate.entryId),
    label: candidateFace(candidate),
  }));

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
          // Named for the card, never "Select": a column of twelve checkboxes with one name is
          // twelve controls a screen reader cannot tell apart. The name does **not** move with
          // the tick — it says what the row is, not what the row is currently doing, so a reader
          // pressing it does not hear the control rename itself under their finger.
          aria-label={`Pull ${saidAs(row)}`}
          className={cn("mt-1 size-4 shrink-0 accent-accent", FOCUS)}
        />

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
              decoding="async"
              className="size-full object-cover"
            />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm">{row.name}</span>
            {/* **The line's whole reason for being distinguishable, where a name alone would make
                two rows read as a duplicate.** `FinishMark` draws nothing for the regular copy,
                which is right: the plain card is the unmarked case everywhere else in the app.
                The glyph carries its own `role="img"` and label, so a screen reader hears "Foil"
                beside the name rather than reading a shape. */}
            <FinishMark finish={row.finish ?? "nonfoil"} />
          </span>

          {/* The printing, in the same spelling as every other card row in the app, and the piles
              the shortfall is spread over. **The piles are for the reader and never for the
              write**: the backend folds a shortfall to the printing, because what somebody is
              short of is cardboard and custody is a fact about the deck rather than about a
              column. Two facts on one wrapping line, because at a narrow panel the printing is
              the half that must not be pushed off the end. */}
          <span className="flex flex-wrap items-baseline gap-x-2 text-[0.7rem] text-dim">
            <span className="font-mono tabular-nums">
              {row.setCode.toUpperCase()} · {row.collectorNumber}
            </span>
            <span className="min-w-0 truncate">Short in {row.categories.join(", ")}</span>
          </span>

          {/* **The choice, and only where there is one.** More than one candidate is the issue's
              own case — redundant copies in different folders — and it is the minority; one
              candidate is a fact, stated in the same words and the same place so that the two
              shapes of this row read as one row with and without a decision in it.

              Why the rows are in the backend's order and not the alphabet is at
              {@link sourceOptions}, where the list is built. */}
          {row.candidates.length > 1 ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {/* **A real `<label>` with `htmlFor`, plus `labelledBy`**, which is what every
                  `Dropdown` in a dialog does (`CategoriesDialog`, `DeckSettingsForm`): the `id`
                  pair keeps a press on the word opening the panel, and `labelledBy` states the
                  name outright rather than leaving it to an association a later edit could
                  break.

                  **The visible word is one syllable and the name is per card**, which is the
                  whole reason the label is split. `From` alone would give every picker in the
                  list one name — a column of controls a screen reader cannot tell apart, the
                  failure the checkbox above avoids the same way — and a fully written-out
                  visible label would put a sentence where the row has room for a word. The
                  spoken half continues the visible one inside the same element with no gap
                  between them, so the name computes as one sentence containing the visible text
                  (WCAG 2.5.3) rather than as two words run together. */}
              <label
                id={`${id}-source-label`}
                htmlFor={`${id}-source`}
                className="shrink-0 text-[0.7rem] text-dim"
              >
                From
                <span className="sr-only">, which copy of {printingName(row)} to pull</span>
              </label>
              <span className="min-w-0 flex-1">
                <Dropdown
                  id={`${id}-source`}
                  labelledBy={`${id}-source-label`}
                  value={String(source)}
                  onChange={(entryId) => onPrefer(Number(entryId))}
                  options={sourceOptions}
                  // The row's own density, and the shell has only two geometries. `fill` inside a
                  // `min-w-0 flex-1` box is `CategoriesDialog`'s arrangement: the trigger sizes to
                  // its picked source and the chevron stays against the far edge.
                  size="sm"
                  fill
                />
              </span>
            </span>
          ) : (
            chosen !== undefined && (
              <span className="min-w-0 truncate text-[0.7rem] text-dim">
                From {candidateFace(chosen)}
              </span>
            )
          )}

          {/* **A statement, not a warning.** `text-dim` and no live-region role: the collection
              not covering a line is the ordinary answer for a deck that is genuinely short, and a
              destructive colour here would report the reader's own binder as a fault. Drawn only
              while the row is going — an unticked row is short of everything by the reader's own
              press, and saying so would be the control accusing them of its own state. */}
          {on && unfilled > 0 && (
            <span className="text-[0.7rem] text-dim">
              {plural(unfilled, "copy", "copies")} still missing — nothing else you own loose
              matches this printing.
            </span>
          )}
        </span>

        {/* How much of the hole this row fills. `aria-hidden` with an `sr-only` twin, because
            "2 of 3" is two loose numbers to anyone who cannot see the column they are under —
            and a `<span>` cannot carry an `aria-label` (name-prohibited on a generic role), so
            the twin is the only way to say it. `CountTag`'s arrangement. */}
        <span
          className={cn(
            "w-20 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums",
            on ? "text-text" : "text-dim",
          )}
        >
          <span aria-hidden="true">
            {taking} of {row.short}
          </span>
          <span className="sr-only">
            Pulling {taking} of {plural(row.short, "copy", "copies")}
          </span>
        </span>
      </div>
    </li>
  );
}
