/**
 * The question a drop asks when a tile stands for more than one row: **which copies?**
 *
 * A collection tile merges every entry for one printing across finishes, conditions, languages
 * and folders (`CollectionPage.tsx`'s `tiles` memo), so the picture a reader drags is very often
 * several `collection_entries` rows — a played English copy in the root, a foil in a binder, a
 * Japanese one filed with the rest of that set. Filing "the card" is therefore not a thing the
 * app can do without choosing, and **choosing on the reader's behalf is the one answer that is
 * always wrong for somebody**: the drag says where, and only the reader knows which.
 *
 * **Presentational and nothing else.** It holds which rows are ticked and it holds no mutation,
 * no query and no layer: the host draws it inside whatever surface the drop opened, owns the
 * write, and owns the Escape rung — the app's ladder is a handshake between registered layers
 * (`src/CLAUDE.md`), so a document-level key listener in here would be an unregistered rung
 * closing something it did not open. The shape is `MoveToFolder`'s `inline` mode for the same
 * reason that mode exists: this list has been drawn *into* a surface that is already open, so it
 * takes no box, no width, no shadow and no z-index of its own, and keeps only the padding —
 * which is what insets a row's hover from the edge it is drawn against.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The collection's own word for the root, which is what a `null` folder is.
 *
 * `MoveToFolder.rootLabel`'s rule reached from the reading end: the top level is a real place
 * with a name the reader already knows from the breadcrumb, not the absence of one — and a row
 * that said "No folder" would be describing the same drawer the breadcrumb calls Collection.
 */
const ROOT_LABEL = "Collection";

/** The language every printing is in unless it says otherwise, and the one this never draws. */
const DEFAULT_LANG = "en";

/**
 * One `collection_entries` row, as much of it as a reader needs to tell it from its neighbours.
 *
 * **Every label is the caller's**, finish and condition included: `FINISH_LABEL` and
 * `CONDITION_LABEL` are the app's spellings and a second lookup in here would be a second place
 * for them to be spelled. What this component owns is the *sentence* they are joined into.
 */
export interface CopyChoice {
  entryId: number;
  /** Nonfoil / Foil / Etched — already labelled by the caller. */
  finish: string;
  /** NM, LP, … — already labelled by the caller. */
  condition: string;
  /** "en", "ja" … The caller passes it through; drawn only when it is not English. */
  lang: string;
  quantity: number;
  /** Where it sits now, for the reader to tell two otherwise identical rows apart.
   *  `null` is the root — drawn as {@link ROOT_LABEL}. */
  folderName: string | null;
  /** Why this copy cannot move, or `null` when it can. A copy in a deck's group cannot be filed
   *  by hand: `collection_folders.rs`'s `ENTRY_IN_A_DECK` is the sentence, and it says what to do
   *  instead rather than merely refusing. */
  blocked: string | null;
}

/**
 * A copy's face, in the two spellings of one sentence — `folderFace`'s arrangement in
 * `CollectionFolderCard.tsx`, for its reason.
 *
 * `shown` is what the row prints, joined with the app's `·`. `spoken` is the same facts joined
 * with commas, because it becomes an `aria-label` and a middot read aloud is punctuation nobody
 * asked for. Built together rather than written twice, so the eye and the ear can never be told
 * two different things about one row.
 *
 * **The folder is always said, and it is the whole reason `folderName` is on the row.** Two
 * copies of one printing in one condition and one finish are told apart by nothing else, and a
 * picker whose rows read identically is a picker no answer can be given to.
 *
 * **The language is drawn only when it is not English**, uppercased the way `setCode` is
 * everywhere else here: a `JA` beside the condition is a fact worth a word, and an `EN` on
 * ninety-odd per cent of rows is a column of noise that pushes the folder — the term actually
 * doing the disambiguating — off the end of a narrow panel.
 */
function copyFace(copy: CopyChoice): { shown: string; spoken: string } {
  const parts = [
    copy.finish,
    copy.condition,
    ...(copy.lang.toLowerCase() === DEFAULT_LANG ? [] : [copy.lang.toUpperCase()]),
    copy.folderName ?? ROOT_LABEL,
    plural(copy.quantity, "copy", "copies"),
  ];
  return { shown: parts.join(" · "), spoken: parts.join(", ") };
}

/**
 * The way out, in both branches below.
 *
 * No greyed clause, deliberately: declining is not a thing a busy database can refuse, so this
 * button has no out-of-reach state to draw.
 */
const CANCEL = cn(
  "rounded-md border border-border px-3 py-1 text-xs text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * The affirmative, in the app's own outlined-accent shape (`AddToCollection`'s Add button).
 *
 * **`aria-disabled` and a guard, never the attribute** (`src/CLAUDE.md`): this greys and
 * un-greys as the reader ticks, and a `disabled` button leaves the tab order — so a reader who
 * unticked their last row would find the caret thrown out of the panel by their own press. The
 * hover fill is taken back with it, because a control that lights up under the pointer and then
 * does nothing is worse than one that is plainly out of reach.
 */
const CONFIRM = cn(
  "rounded-md border border-accent px-3 py-1 text-xs text-accent",
  "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
  "motion-reduce:transition-none",
  "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-accent",
  FOCUS,
);

/**
 * Ask which of a printing's copies a drop should carry.
 *
 * Every unblocked copy starts ticked, because the commonest answer by far is "all of them" — a
 * reader who dragged the card meant the card. What the ticks buy is the ability to say *fewer*,
 * which is the answer nothing else on this screen can express.
 */
export function PickCopies({
  cardName,
  destination,
  copies,
  onConfirm,
  onCancel,
}: {
  /** The printing, for the heading — "Move Lightning Bolt to Binder". */
  cardName: string;
  /** Where they are going, already worded by the caller: a folder's name, or "Collection". */
  destination: string;
  copies: readonly CopyChoice[];
  onConfirm: (entryIds: readonly number[]) => void;
  onCancel: () => void;
}): ReactElement {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Which rows a press would carry, seeded **mount-only** in a lazy initializer.
   *
   * No effect, for `CreateDeckDialog`'s reason: an effect re-seeding from a prop cannot tell "the
   * copies arrived" from "the reader has already unticked three of them", so it would land on top
   * of an answer they had given. A host whose `copies` genuinely change identity under an open
   * picker re-keys this component; that is the contract every frozen layer payload in the deck
   * editor already has.
   *
   * **This seed is the _only_ place `blocked` decides anything about the ticks, deliberately.**
   * The obvious hardening is to test it again where the box is drawn and once more before the
   * ids leave — and three fences around one invariant is three places a mutation can be made
   * with nothing going red, which is the shape of a rule nobody can check. The set can only grow
   * through {@link toggle}, `toggle` can only be reached through a checkbox, and that checkbox is
   * natively `disabled` for a blocked row — so the further tests would be dead code standing in
   * the way of the test that proves this line.
   */
  const [picked, setPicked] = useState<ReadonlySet<number>>(
    () => new Set(copies.filter((c) => c.blocked === null).map((c) => c.entryId)),
  );

  // The caret moves into the question as it does for every other surface drawn into an open one
  // (`MoveToFolder`, and `metaRows`' `useConfirmFocus`) — on the panel's own box rather than on a
  // button in it, because the reader has not decided yet and a stray Enter must not decide for
  // them. `focus()` on a node with no `tabIndex` is a silent no-op, which is why the attribute
  // below is not decoration.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /**
   * What a press would send, **in the order the reader is looking at** — walked over `copies`
   * rather than read out of the set, whose order is whatever the ticks happened to be made in.
   * A list of ids is what a host writes and what a test reads, and neither should have to know
   * about insertion order to say what it expected.
   */
  const chosen = useMemo(
    () => copies.filter((c) => picked.has(c.entryId)),
    [copies, picked],
  );

  /**
   * The number on the button, which is **copies and not rows**.
   *
   * One entry can be `2 copies`, so a button reading "Move 1 copy" over a single ticked row that
   * holds two would be a count of the wrong thing said at the moment of the press. It is the same
   * arithmetic the tile itself does — `sum(quantity)` — so the picker and the wall behind it can
   * never count one printing two ways.
   */
  const moving = chosen.reduce((sum, c) => sum + c.quantity, 0);
  const allBlocked = copies.length > 0 && copies.every((c) => c.blocked !== null);

  const toggle = (entryId: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(entryId)) next.add(entryId);
      return next;
    });

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      // `group` rather than a bare `<div>`: `aria-label`/`aria-labelledby` is name-prohibited on a
      // generic container, so without the role the caret would land on an unnamed box — and
      // "a set of related controls" is the honest word for what this is once it is not a layer.
      // Labelled *by* the heading rather than with a copy of its words, so the two cannot drift.
      role="group"
      aria-labelledby={titleId}
      // A press in here is a press on a control, never the start of a drag of whatever this panel
      // was opened over — `MoveToFolder`'s mark, for its reason.
      data-no-drag=""
      // No `FOCUS`: a landing pad, not a control — the `tabIndex` above is there only so the
      // caret has somewhere to go, and neither Tab nor an arrow reaches this box. The controls
      // it groups keep theirs. `src/lib/focus.ts` has the rule.
      className={cn("w-full space-y-3 p-1")}
    >
      <div className="space-y-1">
        <p id={titleId} className="text-sm leading-snug">
          Move <span className="font-medium">{cardName}</span> to{" "}
          <span className="font-medium">{destination}</span>
        </p>
        <p className="text-xs text-dim">
          {allBlocked ? "None of these copies can be moved." : "Pick which copies move."}
        </p>
      </div>

      {allBlocked ? (
        /* No checkboxes at all: every row here would be a control that could never be pressed,
           and a column of ticks nobody can move is furniture that reads as a broken picker. The
           rows stay, because *which* copies are out of reach and *why* is the whole of what this
           branch has to say — and each reason is read plainly here, where there is no accessible
           name carrying it. */
        <ul className="space-y-1.5">
          {copies.map((copy) => {
            const { shown } = copyFace(copy);
            return (
              <li key={copy.entryId} className="space-y-0.5 px-2 text-xs text-dim">
                <p className="break-words">{shown}</p>
                <p className="text-[0.7rem] leading-relaxed">{copy.blocked}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul
          // 6px is `dropMarks.ts`'s `DROP_MARK_ROOM` arithmetic one rung down: `overflow` clips at
          // the padding box and `FOCUS` is an outline standing 4px proud of the border box, so a
          // row flush against this scroller's content edge would lose that side of its focus mark
          // — half a focus indicator, which is a WCAG 2.4.7 failure rather than a cosmetic one.
          // jsdom has no layout engine and therefore no clip, so nothing in the suite sees it.
          className="max-h-56 space-y-0.5 overflow-y-auto p-1.5"
        >
          {copies.map((copy) => {
            const { shown, spoken } = copyFace(copy);
            const blocked = copy.blocked !== null;
            return (
              <li key={copy.entryId}>
                {/* A `<label>` so the whole row is the hit target — a 16px tick is a small thing
                    to aim at — while the name below is written out rather than computed from this
                    content: a flex `gap` is not a text node, so an accessible name assembled from
                    two spans comes out with the words fused together. */}
                <label
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
                    "transition-colors duration-150 motion-reduce:transition-none",
                    blocked ? "text-dim" : "cursor-pointer text-text hover:bg-surface",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(copy.entryId)}
                    // **`disabled` and not `aria-disabled`, which is the reverse of this app's
                    // usual rule and is deliberate.** That rule is about a control greying *as
                    // the reader works* — the button below is one — and what it buys is the tab
                    // stop. This is static for the life of the panel, and what the native
                    // attribute buys instead is that "cannot be ticked" is a property of the
                    // element rather than a guard that can fall out of step with it. The reason
                    // is not lost with the tab stop: it is in this checkbox's own accessible
                    // name, and drawn beside it.
                    disabled={blocked}
                    onChange={() => toggle(copy.entryId)}
                    // Named for the copy, never "Select": a column of these all called the same
                    // word is a column a screen reader cannot tell apart — and the blocked one
                    // carries its reason *inside its name*, because a greyed row whose name is
                    // only its label reads as a row that is simply missing.
                    aria-label={blocked ? `${spoken}. ${copy.blocked}` : spoken}
                    className={cn("mt-0.5 size-4 shrink-0 accent-accent", FOCUS)}
                  />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block break-words">{shown}</span>
                    {blocked && (
                      /* For the eye only — the checkbox's own name already says it, and a
                         sentence read twice running is a sentence a reader stops trusting.
                         `CountTag`'s arrangement: the mark is drawn, the words belong to whatever
                         names the control. */
                      <span
                        aria-hidden="true"
                        className="block text-[0.7rem] leading-relaxed text-dim"
                      >
                        {copy.blocked}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {!allBlocked && (
          <button
            type="button"
            aria-disabled={moving === 0}
            // The guard the paint would otherwise be lying about: an `aria-disabled` control
            // still delivers its press.
            onClick={() => {
              if (moving === 0) return;
              onConfirm(chosen.map((c) => c.entryId));
            }}
            // Starts with the visible word so the button is still addressable by voice
            // (WCAG 2.5.3), and adds the one fact the label has no room for — the destination is
            // in the heading, which a voice user is not reading out.
            aria-label={`Move ${plural(moving, "copy", "copies")} to ${destination}`}
            className={CONFIRM}
          >
            Move {plural(moving, "copy", "copies")}
          </button>
        )}
        <button type="button" onClick={onCancel} className={CANCEL}>
          Cancel
        </button>
      </div>
    </div>
  );
}
