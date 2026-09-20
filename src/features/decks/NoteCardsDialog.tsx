/**
 * Which cards a note is about — `PullFromCollectionDialog`'s grammar, over the deck's own cards.
 *
 * **A fourth spelling of "pick some cards in a dialog" is a fourth thing to keep in step**, so the
 * row below is that dialog's row: a `size-4 accent-accent` checkbox named for its card, the 44×32
 * art frame, a `min-w-0 flex-1` column with the name over a `text-[0.7rem]` line, and the count
 * right-aligned in mono beside its `sr-only` twin.
 *
 * **Three things diverge, each argued at its own site rather than here.** The checkbox takes
 * `FOCUS_INSET` where the pull dialog takes `FOCUS`, and the list's scroller is `relative` where
 * that one is not — an outline standing 2px proud of a control in a clipped box is painted in the
 * clipped region, and an `sr-only` span with no positioned ancestor stretches the document. Both
 * are `src/CLAUDE.md` rules with a shipped failure behind them, and the pull dialog is on the wrong
 * side of both. The third is the art frame's `border border-border`: a frame here can legitimately
 * be empty, and an unbordered empty box is a gap in the row rather than a picture that is missing.
 *
 * **No Save, because ticking is the write.** Each tick calls `note_card_attach` or
 * `note_card_detach` the moment it lands, which is what the row actions did before this dialog
 * existed — so a `Cancel` here would be a lie about what the last ten presses did. The footer
 * carries one `Done`.
 *
 * **The picker offers the deck's cards and nothing wider**, which is the spec's line: a note is
 * about a card *in this deck*. A card that later leaves the deck keeps its note — deliberately,
 * because a note about a card you cut is the note most worth keeping — so this list narrows what
 * can be *added* and never what is already named. A named card the deck no longer holds is drawn
 * at the head of the list, ticked, saying so under its name — **and keeping its picture**, which
 * is the opposite of the natural guess. `attachments_by_note` resolves each named card's printing
 * over the *whole corpus* (`src-tauri/src/deck_notes.rs`: `ORDER BY (dc.card_id IS NULL), c.id` —
 * a printing this deck holds first, any printing otherwise), so cutting a card takes its deck row
 * and not its art. The frame is empty only for the orphan whose oracle id the corpus knows no
 * printing of at all.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { CardImage } from "@/components/CardImage";
import { Dialog } from "@/components/Dialog";
import { FILTER_FIELD } from "@/components/FilterChips";
import { plural } from "@/lib/counts";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { cardArtSrc, cardImageUrl } from "@/lib/images";
import type { DeckNoteCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { OTHER } from "./deckBuckets";
import { ALL_CHIP, NAMED_CHIP, typeChipCounts, type NoteCardChoice } from "./deckNotes";
import { META_SUBMIT } from "./metaRows";

/** What the dialog is for, under the note's own name. Pulled out because the tests and the
 *  stories address the subtitle by it, and a dialog that reworded itself under them would go red
 *  for a reason that is not about the picker. */
const SUBTITLE = "Which cards this note is about";

/** The deck has nothing to offer — which is not the same sentence as *your search missed*, and
 *  drawing one where the other belongs is how an empty picker reads as broken. */
const NOTHING_TO_NAME = "This deck has no cards to name yet.";

/** The filter hid everything. It names both controls that could have done it, because the reader
 *  may have set one of them several presses ago. */
const NOTHING_MATCHES = "No card in this deck matches — try a different word, or a different chip.";

/** The standing sentence, and the whole reason a stray row exists at all. */
const KEEPS_ITS_CARDS =
  "A note keeps the cards it names even after they leave the deck — cutting a card never takes " +
  "the note with it.";

/** What a row says in place of its printing when the deck no longer holds the card — see
 *  {@link Row}, where the argument for it lives. */
const CUT_FROM_DECK = "No longer in this deck";

export interface NoteCardsDialogProps {
  open: boolean;
  /** The note's name — `noteTitle(note)`, computed by the host so the dialog and the card agree. */
  title: string;
  /** Every card this note names, as the read answered. */
  named: readonly DeckNoteCard[];
  /** Every card the deck holds, as the picker offers them. */
  attachable: readonly NoteCardChoice[];
  onAttach: (oracleId: string) => void;
  onDetach: (oracleId: string) => void;
  onClose: () => void;
}

/**
 * The shell. Everything with state in it is {@link Picker}, one component in, for `Dialog`'s own
 * reason: `children` render only while `open`, so a body mounted there starts clean on every open
 * and the search needle, the chip and the caret cannot survive a close the reader meant as a
 * reset. A `useState` out here would be per *host* instead, and the focus effect would fire on a
 * dialog nobody has opened.
 */
export function NoteCardsDialog({
  open,
  title,
  named,
  attachable,
  onAttach,
  onDetach,
  onClose,
}: NoteCardsDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      // The note's own name is the heading, because that is the thing being edited and it is what
      // the row the reader pressed was called. What the dialog *does* is the same sentence on
      // every note, so it rides under the heading as the subtitle rather than beside it — a note
      // titled from its own first line has no length anybody controls, and a long one would
      // otherwise truncate the heading.
      title={title}
      subtitle={SUBTITLE}
      closeLabel="Close the card picker"
      // `w-[47.5rem]` and not the pull dialog's `w-[52rem]`: the row here carries no source
      // dropdown, so the widest thing in it is a card name over a set code.
      size="w-[47.5rem]"
      // **One callback for both rungs, because the host is given one.** `Dialog` tells Escape and
      // the ✕ (which hand focus back to whatever opened the dialog) from a press on the scrim
      // (which does not) — and where the caret lands is the opener's half of the contract.
      onDismiss={onClose}
      onClose={onClose}
    >
      <Picker
        title={title}
        named={named}
        attachable={attachable}
        onAttach={onAttach}
        onDetach={onDetach}
        onClose={onClose}
      />
    </Dialog>
  );
}

/** The body: the two controls, the list, and the way out. */
function Picker({
  title,
  named,
  attachable,
  onAttach,
  onDetach,
  onClose,
}: Omit<NoteCardsDialogProps, "open">): JSX.Element {
  const findId = useId();
  const [find, setFind] = useState("");
  const [chip, setChip] = useState<string>(ALL_CHIP);
  const findRef = useRef<HTMLInputElement>(null);

  // **The caret starts in the search field**, which is the one place a `Dialog` body may overrule
  // the shell: that effect focuses the panel only when the body has not already put the caret
  // somewhere, and `QuickZones`' New category is the precedent its own comment names. The rule it
  // bends — *no field is focused, because dropping the caret into a text box makes the reader's
  // first keystroke an edit* — is about panels of settled values. This one is a question, the
  // field narrows rather than writes, and over a hundred-card deck typing is what a reader came
  // here to do. `focus()` on an `<input>` needs no `tabIndex`, so the one call is the whole of it.
  useEffect(() => {
    findRef.current?.focus();
  }, []);

  const needle = find.trim().toLowerCase();
  const namedIds = useMemo(() => new Set(named.map((c) => c.oracleId)), [named]);

  /**
   * The named cards the deck no longer holds, drawn at the head so an unticking press is always
   * reachable. `attachable` cannot contain them by construction — it is built from the deck.
   *
   * **Four of {@link NoteCardChoice}'s eight fields are synthesised** rather than read, because a
   * `DeckNoteCard` carries no printing: `setCode` and `collectorNumber` are empty, `copies` is
   * `0`, and `typeBucket` is {@link OTHER}. None of the four is a fact about the card, so nothing
   * may draw them — see {@link Row}, which is handed `stray` and decides on that rather than on
   * the sentinels, so the guard tests the reason and not the symptom.
   *
   * **`typeBucket` is the one to count**, and it is why this sentence is worth getting right: the
   * other three read as absences, where a bucket reads as something the card said about itself.
   * {@link Row}'s own doc makes it the headline of the whole decision.
   */
  const strays: NoteCardChoice[] = useMemo(
    () =>
      named
        .filter((c) => !attachable.some((a) => a.oracleId === c.oracleId))
        .map((c) => ({
          oracleId: c.oracleId,
          name: c.name,
          cardId: c.cardId ?? "",
          imageUris: c.imageUris,
          setCode: "",
          collectorNumber: "",
          typeBucket: OTHER,
          copies: 0,
        })),
    [named, attachable],
  );

  /** Which oracle ids the deck has stopped holding — one `Set` rather than a scan per row, and
   *  the single answer to *is this row a stray* for the whole render. */
  const strayIds = useMemo(() => new Set(strays.map((c) => c.oracleId)), [strays]);

  /** Every row this picker can draw, before the two controls narrow it. */
  const offered = useMemo(() => [...strays, ...attachable], [strays, attachable]);

  /**
   * The rungs, counted over {@link offered} and deliberately not over `attachable` alone.
   *
   * A chip's count is a promise about how many rows pressing it draws, so `All` has to count the
   * strays the list puts above the deck. A stray's bucket is {@link OTHER}, which is honest for a
   * card whose type nothing here knows — the `DeckNoteCard` it is built from carries no type line —
   * rather than the strays inventing a rung of their own.
   *
   * It is deliberately **not** the orphan printing's bucket, which is what this comment said until
   * a reviewer read `attachableCards`: that function **drops** every row with a null `oracleId`,
   * and a null `oracleId` is exactly what an orphan is. `Other` reaches this list through a token
   * or a scheme, and through these strays.
   */
  const chips = useMemo(() => typeChipCounts(offered, named.length), [offered, named.length]);

  /**
   * The rung actually in force, which is not always the one the reader pressed.
   *
   * **A type rung is drawn only where the deck has cards of that type, and the rows behind one can
   * go while it is pressed.** Untick the last stray with `Other` pressed and that chip is gone on
   * the next render: the radiogroup is left with no `aria-checked="true"` rung at all, over a list
   * saying *No card in this deck matches* — a filter nothing on screen can turn off, which is the
   * shape of thing a reader reports as the dialog having broken. `Named` at zero is the milder
   * version of it, since that rung is drawn at zero and merely empties the list.
   *
   * **Read here rather than written back**, which is `DeckEditor`'s rule for a `defaultCategoryId`
   * naming a pile the deck no longer has: there is nothing to repair — the reader's press was
   * legal when they made it — so the fallback is a *read*, and `All` is where the list already is.
   */
  const activeChip = chips.some((c) => c.key === chip) ? chip : ALL_CHIP;

  const rows = offered.filter(
    (row) =>
      (needle === "" || row.name.toLowerCase().includes(needle)) &&
      (activeChip === ALL_CHIP ||
        (activeChip === NAMED_CHIP
          ? namedIds.has(row.oracleId)
          : row.typeBucket.toLowerCase() === activeChip)),
  );

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3.5">
        <div>
          {/* Named for the note, because a picker opened over `Mana base` and one opened over
              `Sideboard plan` are two boxes a reader may meet in one session — and the `useId`
              stem is the other half of the same rule, since `Dialog` mounts and unmounts this one
              and two live boxes sharing an `id` is a `getByLabelText` that cannot tell them
              apart. */}
          <label htmlFor={findId} className="sr-only">
            Find a card to name in {title}
          </label>
          <input
            ref={findRef}
            id={findId}
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Find a card in this deck…"
            className={cn(
              FILTER_FIELD,
              FOCUS,
              // Full width: this is the band's own row rather than one control in a wrapping
              // filter bar, so there is nothing beside it to leave room for.
              "w-full min-w-0 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
            )}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* A real radio group rather than a row of buttons: one rung of N is chosen, exactly one
              is true at a time, and `aria-checked` is the only thing that says so to a reader who
              cannot see which one is gold. `TheoryDiffDialog`'s row, verbatim. */}
          <div role="radiogroup" aria-label="Which cards to show" className="flex flex-wrap gap-2">
            {chips.map((rung) => (
              <button
                key={rung.key}
                type="button"
                role="radio"
                aria-checked={activeChip === rung.key}
                // **Named outright, because the visible name does not survive being computed.**
                // The label and the count are two elements separated by a `gap`, which is CSS and
                // not a text node — so the accessible name concatenates to `Land1`, which a screen
                // reader reads as one word ending in a digit. Measured in the shipped window on
                // 2026-08-22 and recorded at `TheoryDiffDialog.tsx`'s own chip, whose template
                // this is. Spelling it here also lets the count be a *sentence* — "1 card" rather
                // than a bare number a reader has to guess the unit of.
                aria-label={`${rung.label}, ${rung.count} ${rung.count === 1 ? "card" : "cards"}`}
                onClick={() => setChip(rung.key)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs",
                  "transition-colors duration-150 motion-reduce:transition-none",
                  activeChip === rung.key
                    ? "border-accent text-accent"
                    : "border-border text-dim hover:border-accent hover:text-accent",
                  FOCUS,
                )}
              >
                {rung.label}
                {/* Drawn plainly rather than hidden behind an `sr-only` twin — the `aria-label`
                    above already owns what is announced, so this is free to be the count as the
                    eye wants it: monospaced and tabular, so rungs of different widths keep their
                    digits in a column. */}
                <span className="font-mono tabular-nums">{rung.count}</span>
              </button>
            ))}
          </div>

          {/* How many the note names — the one number on this screen the chips cannot be read
              for: `Named` counts the same cards, but a reader who has narrowed to `Land` is
              looking at a chip that says something else. Spelled out rather than run through
              `plural`, because "named" does not pluralise. */}
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-dim">
            {named.length} named
          </span>
        </div>
      </div>

      {/* **`relative`, because a scroll container has to be the containing block for its own
          absolutely positioned content.** Tailwind's `.sr-only` is `position: absolute`, and the
          rows below carry one per copies count — without this they would take the *initial*
          containing block, be laid out at their static position inside the scrolled content, be
          clipped by nothing, and stretch the document. That shipped once in this editor and cost
          a session; jsdom lays nothing out, so it can never go red in the suite. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {rows.length === 0 ? (
          // Two sentences, never one. *The deck holds nothing* and *your filter hid everything*
          // look identical on screen and mean opposite things, and only the second is one a
          // reader can act on. The test is {@link offered} rather than `attachable`, so a note
          // naming a cut card still gets the search's answer when the search is what emptied it.
          <div className="mx-auto max-w-md px-2 py-6 text-center">
            <p className="text-sm text-dim">
              {offered.length === 0 ? NOTHING_TO_NAME : NOTHING_MATCHES}
            </p>
          </div>
        ) : (
          // A list rather than a `<table>`: every cell here is a control or a caption on one, the
          // columns do not sort, and `components/table/VirtualTable.tsx` is what a table is in
          // this app. The pull dialog and the difference list are the same shape for the same
          // reason.
          <ul>
            {rows.map((row) => (
              <Row
                key={row.oracleId}
                row={row}
                title={title}
                ticked={namedIds.has(row.oracleId)}
                stray={strayIds.has(row.oracleId)}
                onToggle={(on) => (on ? onAttach(row.oracleId) : onDetach(row.oracleId))}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-3.5">
        <p className="min-w-[14rem] flex-1 text-[0.7rem] leading-snug text-dim">
          {KEEPS_ITS_CARDS}
        </p>

        {/* One button, and it is not a Save. Every tick above has already been written, so the
            only thing left to do here is stop looking — which is what `Done` says and what a
            `Cancel` beside it would contradict. {@link META_SUBMIT} rather than the pull dialog's
            private `CONFIRM`: it is the same accent-bordered `h-8` button, it is already this
            band's, and exporting a constant out of a dialog this one otherwise shares nothing
            with would turn an implementation detail into a recipe. */}
        <button type="button" onClick={onClose} className={META_SUBMIT}>
          Done
        </button>
      </footer>
    </>
  );
}

/**
 * One card the note may name: whether it names it, what the card is, and how many the deck holds.
 *
 * **A stray is the same row with three of its facts withheld.** The synthesised choice carries
 * `setCode: ""`, `collectorNumber: ""` and `copies: 0`, and none of those is a fact about the
 * card: drawn, they are a bare ` · `, a `0×` and an `sr-only` twin saying the deck holds none of
 * it.
 *
 * **The third is the one most easily missed, because guarding the other two leaves it standing.**
 * `typeBucket` is {@link OTHER}, which a `DeckNoteCard` never said — it carries no type line at
 * all — so a row guarded only on `setCode !== ""` and `copies > 0` reads `Goblin PiledriverOther`:
 * a bucket nobody assigned, printed as though it were the card's own. So the whole line is
 * replaced for a stray by the one thing that is true of it, {@link CUT_FROM_DECK}.
 *
 * **The frame beside it is usually a real picture, and that is worth stating because the opposite
 * is the natural guess.** `attachments_by_note` (`src-tauri/src/deck_notes.rs`) resolves a printing
 * over the *whole corpus* — `ORDER BY (dc.card_id IS NULL), c.id`, so a printing the deck holds
 * first and any printing otherwise — so a card cut from the deck keeps its `cardId` **and** its
 * `imageUris`. A deck row leaving does not take the art with it. `cardId` is absent, and the frame
 * therefore empty, only for the orphan whose oracle id the corpus knows no printing of at all.
 *
 * The guard is `stray` and never `row.setCode !== ""`: the sentinels are the symptom and being cut
 * from the deck is the reason, and a row that guarded on the symptom would silently start drawing
 * a printing again the day a `DeckNoteCard` grew one.
 */
function Row({
  row,
  title,
  ticked,
  stray,
  onToggle,
}: {
  row: NoteCardChoice;
  title: string;
  ticked: boolean;
  /** The deck no longer holds this card — see this component's doc for what that withholds. */
  stray: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  // **`=== ""` and not the brief's `=== null`**, which could not compile: `NoteCardChoice.cardId`
  // is a `string`, so {@link Picker}'s `strays` spells a missing printing `?? ""`. The branch is
  // reached only by the orphan the corpus knows no printing of — see this component's doc for why
  // a card merely *cut from the deck* still has one.
  const art =
    row.cardId === "" ? null : cardArtSrc(cardImageUrl(row.cardId, 0, "art"), row.imageUris?.art);

  return (
    <li
      className={cn(
        "rounded-md px-2 py-2",
        "transition-colors duration-150 hover:bg-surface",
        "motion-reduce:transition-none",
        ticked && "bg-surface",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={ticked}
          onChange={(e) => onToggle(e.target.checked)}
          // Named for the card, never "Select": a column of twelve checkboxes with one name is
          // twelve controls a screen reader cannot tell apart. The name does **not** move with the
          // tick — it says what the row is, not what the row is currently doing, so a reader
          // pressing it does not hear the control rename itself under their finger. The note is in
          // it because a reader may meet this dialog over several notes in one session, and `Name
          // Mountain` alone says nothing about which note is being written.
          aria-label={`Name ${row.name} in ${title}`}
          // `FOCUS_INSET` rather than `FOCUS`, because everything here is inside a box that clips:
          // an outline standing 2px *off* a control in a scroller is painted in the clipped region
          // on the rows at either end of it and is never seen at all, which is a WCAG 2.4.7
          // failure and invisible to anyone testing with a mouse. jsdom lays nothing out, so this
          // cannot go red in the suite either.
          className={cn("mt-1 size-4 shrink-0 accent-accent", FOCUS_INSET)}
        />

        {/* The `art` crop (626×457) as decoration beside the name — `aria-hidden`, empty alt and
            `draggable={false}`, which is the pull dialog's arrangement for the pull dialog's
            reasons. Through `CardImage`, never a bare `<img>`: this is a *slot*, and a browser
            paints an `<img>`'s last decoded frame until the new src decodes, so the picture would
            lag the name by the length of the fetch. A stray keeps its picture, so this frame is
            full on the ordinary one and empty only for an orphan — and the empty box is *drawn*
            rather than omitted, so the column of names stays a column either way. */}
        <span
          aria-hidden="true"
          className="mt-0.5 h-8 w-11 shrink-0 overflow-hidden rounded border border-border bg-surface"
        >
          {art !== null && (
            <CardImage
              src={art}
              alt=""
              draggable={false}
              // Lazy, for the pull list's reason and not a wall's: this is a plain scroller, so a
              // hundred-card deck really is a hundred mounted rows.
              loading="lazy"
              className="size-full object-cover"
            />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="min-w-0 truncate text-sm">{row.name}</span>
          {stray ? (
            <span className="text-[0.7rem] text-dim">{CUT_FROM_DECK}</span>
          ) : (
            // The printing, in the same spelling as every other card row in the app, and the
            // bucket the chips narrow by — so a reader who pressed `Land` can see on each row why
            // it is here. Two facts on one wrapping line, the printing first, because at a narrow
            // panel that is the half that must not be pushed off the end.
            <span className="flex flex-wrap items-baseline gap-x-2 text-[0.7rem] text-dim">
              <span className="font-mono tabular-nums">
                {row.setCode.toUpperCase()} · {row.collectorNumber}
              </span>
              <span>{row.typeBucket}</span>
            </span>
          )}
        </span>

        {/* How many the deck holds. It names nothing and is never written — a note names a card,
            not a quantity of one — so it is here to tell two rows of one name apart and for
            nothing else. `aria-hidden` with an `sr-only` twin, because `4×` is a loose number to
            anyone who cannot see the column it is under, and a `<span>` cannot carry an
            `aria-label`: the generic role is name-prohibited, so the twin is the only way to say
            it. `CountTag`'s arrangement. Absent on a stray, which holds none. */}
        {!stray && (
          <span className="w-11 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-dim">
            <span aria-hidden="true">{row.copies}×</span>
            <span className="sr-only">{plural(row.copies, "copy", "copies")} in this deck</span>
          </span>
        )}
      </div>
    </li>
  );
}
