/**
 * The review tray, as pure functions over its rows — the scanner's one piece of reader-facing
 * *state* and the one thing about it that can be wrong without a camera in the room.
 *
 * **Newest first, and every writer here keeps it that way rather than a sort somewhere else.** A
 * scanned card lands at index 0; a bump refreshes the row that is already there; nothing else
 * moves a row. So the order a reader sees is the order the reducer produced, and a component that
 * draws the array straight through is drawing the tray.
 *
 * **Rust decides, TypeScript files.** A `ScannerDecision` is the session's fact about one card
 * that left the frame; what that fact *becomes* — a new row, a bump, a row waiting for a pick —
 * is this module's conclusion. It never reaches for IPC, and nothing in it knows about a folder:
 * the destination is the commit's argument, not a property of a row.
 */
import type { Condition } from "@/lib/conditions";
import type {
  CollectionImportItem,
  ScannerDecision,
  ScannerTrayChoice,
  ScannerTrayFinish,
  ScannerTrayLayout,
  ScannerTrayRow,
} from "@/lib/ipc";
import { isFinish } from "@/lib/finish";
import { isKnownFinish, UNKNOWN_FINISH } from "./trayFinish";

/**
 * What a new row starts as that the decision itself cannot say.
 *
 * `finish` is already a conclusion — `trayFinish.ts`'s answer for this decision, `unknown`
 * included — so the reducer never learns that the Defaults popover can say `detect`.
 */
export interface RowDefaults {
  finish: ScannerTrayFinish;
}

/**
 * What a row is called when the session could name no printing.
 *
 * A decision with no `label` is a bundle whose labels did not load — `corpus.db` absent, or a read
 * that failed — so the match still landed and the row still commits; it simply has no words.
 */
const UNKNOWN_NAME = "Unknown card";

/** One of a decision's candidates, in the tray's own spelling. */
function choiceOf(choice: ScannerDecision["choices"][number]): ScannerTrayChoice {
  return {
    cardId: choice.id,
    oracleId: choice.oracle_id,
    name: choice.label?.name ?? UNKNOWN_NAME,
    setCode: choice.label?.set ?? "",
    collectorNumber: choice.label?.number ?? "",
    finishes: choice.finishes,
  };
}

/**
 * One decision as one row.
 *
 * **An ambiguous decision carries every candidate and wears the first one provisionally.** The
 * row needs *some* printing to draw a picture and a name while it waits, and the session ranks its
 * choices best first, so the head of that list is the honest placeholder. The row still counts as
 * unresolved — {@link unresolvedCount} reads `choices`, never the provisional id — so the commit
 * refuses it until a reader picks.
 *
 * An ambiguous decision with no choices at all has nothing to offer and nothing to wait for; it
 * files as the printing the decision named, exactly as a resolved one does.
 */
export function rowFromDecision(
  d: ScannerDecision,
  defaults: RowDefaults,
  now: number,
  key: string,
): ScannerTrayRow {
  const choices = d.outcome === "ambiguous" ? d.choices.map(choiceOf) : [];
  const head = choices[0];
  return {
    key,
    cardId: head?.cardId ?? d.printing,
    oracleId: head ? head.oracleId : d.oracle_id,
    name: head?.name ?? d.label?.name ?? UNKNOWN_NAME,
    setCode: head?.setCode ?? d.label?.set ?? "",
    collectorNumber: head?.collectorNumber ?? d.label?.number ?? "",
    finish: defaults.finish,
    quantity: 1,
    choices,
    addedAt: now,
  };
}

/**
 * Put a decision into the tray.
 *
 * **Only the newest row can be bumped, only by a resolved decision naming its printing, and only
 * while that row is in the finish a new row would start in — never `unknown`.** The collection's grain includes the
 * finish, so a foil row the reader set by hand and a nonfoil copy scanned after it are two rows in
 * the binder — counting the second onto the first would file a plain card as a foil one. A
 * card that leaves the frame and comes back is a second copy of the card just scanned — that is
 * the whole of the re-presentation gesture — while the same printing ten cards ago is a reader
 * sorting a pile out of order, and folding it into a row they have scrolled past would move a
 * number nobody is looking at. A row still waiting for a pick is never bumped: it has not decided
 * what it *is*, so "the same printing again" is not a question it can answer. **A row of unknown
 * finish is never bumped either, for the same reason one field over**: two copies the scanner could
 * not read may be one foil and one not, and a row of two can only ever be set to one finish — so
 * each lands on a row of its own, where the reader can answer it on its own.
 *
 * **A bump refreshes `addedAt`**, because it *is* an add — the row is the newest thing that
 * happened in the tray, and a surface keying a flash on that stamp replays it for the second copy.
 *
 * **A decision that `replaces_previous` is a second opinion, not a second copy, and it replaces
 * the newest row instead of adding one** — but only when that row is the same oracle card, or
 * the same printing when neither has an oracle id. Tokens and art cards can have no oracle id;
 * that must not turn a second opinion about the same printing into another copy (#742).
 * "Fast said Forest, switch to Exact to pin the printing" is one card on the mat, and
 * adding would file it twice. The row keeps its key, quantity and finish — the reader's own
 * answers, and the flash's identity — and takes everything that says *which printing* from the
 * decision, its choices included. **An `unknown` finish is no answer to keep**, so a row still
 * waiting on one takes the second opinion's — Exact's closer read of the same card may be the one
 * that measured the separator. The session's flag alone is not enough: a row the reader removed
 * or scanned past is not the card the session remembers, and replacing it would overwrite a
 * different card. So a newest row of another card is an ordinary add.
 */
export function addDecision(
  rows: readonly ScannerTrayRow[],
  d: ScannerDecision,
  defaults: RowDefaults,
  now: number,
  key: string,
): { rows: ScannerTrayRow[]; bumped: boolean; replaced: boolean } {
  const newest = rows[0];
  if (
    newest !== undefined &&
    d.replaces_previous &&
    ((d.oracle_id !== null && newest.oracleId === d.oracle_id) ||
      (d.oracle_id === null && newest.oracleId === null && newest.cardId === d.printing))
  ) {
    const fresh = rowFromDecision(d, defaults, now, newest.key);
    return {
      rows: [
        {
          ...fresh,
          quantity: newest.quantity,
          finish: isKnownFinish(newest.finish) ? newest.finish : fresh.finish,
        },
        ...rows.slice(1),
      ],
      bumped: false,
      replaced: true,
    };
  }
  if (
    newest !== undefined &&
    d.outcome === "resolved" &&
    newest.choices.length === 0 &&
    newest.cardId === d.printing &&
    isKnownFinish(newest.finish) &&
    newest.finish === defaults.finish
  ) {
    return {
      rows: [{ ...newest, quantity: newest.quantity + 1, addedAt: now }, ...rows.slice(1)],
      bumped: true,
      replaced: false,
    };
  }
  return {
    rows: [rowFromDecision(d, defaults, now, key), ...rows],
    bumped: false,
    replaced: false,
  };
}

/** The one row a write is about, changed by `change`; every other row is the same object. */
function update(
  rows: readonly ScannerTrayRow[],
  key: string,
  change: (row: ScannerTrayRow) => ScannerTrayRow,
): ScannerTrayRow[] {
  return rows.map((row) => (row.key === key ? change(row) : row));
}

/**
 * A row's quantity, **never below one**.
 *
 * Zero is not a quantity a tray row can mean: a card the reader does not want is *removed*, and a
 * row reading `0` would commit an import line the backend has nothing to do with. A non-number is
 * read as the floor for the same reason — a stepper box emptied mid-type must not reach here as
 * `NaN` and survive as one.
 */
export function setQuantity(
  rows: readonly ScannerTrayRow[],
  key: string,
  quantity: number,
): ScannerTrayRow[] {
  const next = Number.isFinite(quantity) ? Math.max(1, Math.floor(quantity)) : 1;
  return update(rows, key, (row) => ({ ...row, quantity: next }));
}

/** A row's finish, `unknown` included: a reader may set a row back to it to hold that card out of
 *  the next Add without removing it. */
export function setFinish(
  rows: readonly ScannerTrayRow[],
  key: string,
  finish: ScannerTrayFinish,
): ScannerTrayRow[] {
  return update(rows, key, (row) => ({ ...row, finish }));
}

/**
 * A printing adopted whole — every identifying field at once, so a row cannot end up half one
 * printing and half another — and the question it was waiting on closed.
 *
 * **An Unknown finish is settled by a printing that exists in one finish.** An ambiguous decision
 * files its row Unknown when its candidates disagree about finishes — measured live on
 * 2026-10-01, Ruthless Invasion's two candidates were PLST NPH-93 (non-foil only) and NPH 93 —
 * and once the reader names the printing that question has an answer. A finish the reader chose is
 * never overwritten, and neither is Unknown by a printing that exists in several.
 */
function adopt(row: ScannerTrayRow, p: ScannerTrayChoice): ScannerTrayRow {
  const only = p.finishes?.length === 1 ? p.finishes[0] : undefined;
  const settled =
    row.finish === UNKNOWN_FINISH && only !== undefined && isFinish(only) ? only : null;
  return {
    ...row,
    finish: settled ?? row.finish,
    cardId: p.cardId,
    oracleId: p.oracleId,
    name: p.name,
    setCode: p.setCode,
    collectorNumber: p.collectorNumber,
    choices: [],
  };
}

/**
 * Settle an ambiguous row on one of its own candidates.
 *
 * A `cardId` the row does not offer changes nothing: a press can only name a choice the row drew,
 * so a miss is a stale press against a row that has already moved on, and the honest answer to it
 * is to leave the row alone rather than invent a printing out of an id with no name.
 */
export function pickChoice(
  rows: readonly ScannerTrayRow[],
  key: string,
  cardId: string,
): ScannerTrayRow[] {
  return update(rows, key, (row) => {
    const choice = row.choices.find((c) => c.cardId === cardId);
    return choice === undefined ? row : adopt(row, choice);
  });
}

/**
 * Any printing, from outside the row's own candidates — the all-printings dialog's answer to
 * *More printings…*. It clears `choices` too: a reader who went and found the printing has
 * answered the question the candidates were asking.
 */
export function setPrinting(
  rows: readonly ScannerTrayRow[],
  key: string,
  p: ScannerTrayChoice,
): ScannerTrayRow[] {
  return update(rows, key, (row) => adopt(row, p));
}

export function removeRow(rows: readonly ScannerTrayRow[], key: string): ScannerTrayRow[] {
  return rows.filter((row) => row.key !== key);
}

/** Rows still waiting for a pick — the one thing that stops a commit. */
export function unresolvedCount(rows: readonly ScannerTrayRow[]): number {
  return rows.filter((row) => row.choices.length > 0).length;
}

/**
 * A row the reader still owes an answer: **a printing to pick, or a finish to name.** The two
 * questions the tray asks, and the only two — a row with neither is one Add files as it stands.
 */
export function needsDecision(row: ScannerTrayRow): boolean {
  return row.choices.length > 0 || !isKnownFinish(row.finish);
}

/**
 * The key of the next row waiting on a decision **after** `afterKey`, in the order the tray draws
 * — newest first — and round to the top again past the last; `null` when no row is waiting.
 *
 * **The cursor is a key, never an index**, because the tray moves under it: a scan lands at index
 * 0 and pushes every row down, so an index remembered across one would skip a row. A cursor whose
 * row has gone — removed, or filed by an Add — starts the walk from the top. The cursor's own row
 * is the walk's last stop rather than its first, so a tray with one question left still answers
 * with that row instead of `null`.
 */
export function nextDecisionKey(
  rows: readonly ScannerTrayRow[],
  afterKey: string | null,
): string | null {
  const from = afterKey === null ? -1 : rows.findIndex((row) => row.key === afterKey);
  for (let step = 1; step <= rows.length; step++) {
    const row = rows[(from + step) % rows.length];
    if (row !== undefined && needsDecision(row)) return row.key;
  }
  return null;
}

/**
 * The stored layout word as a layout. **Anything but `list` is the grid**, the Rust default: the
 * row stores the word verbatim, so a value an older or newer build wrote must still draw a tray.
 */
export function trayLayoutOf(stored: string): ScannerTrayLayout {
  return stored === "list" ? "list" : "grid";
}

/** Copies, not rows: a bumped row of three is three cards going into the collection. */
export function totalCopies(rows: readonly ScannerTrayRow[]): number {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

/** The rows an Add files: every one whose finish is known. */
export function readyRows(rows: readonly ScannerTrayRow[]): ScannerTrayRow[] {
  return rows.filter((row) => isKnownFinish(row.finish));
}

/**
 * Copies still waiting on a finish — **copies, like {@link totalCopies}**, so the Add button's two
 * figures (`Add 8 to collection · 2 need a finish`) sum to the count at the head of the tray rather
 * than mixing copies with rows.
 */
export function needsFinishCount(rows: readonly ScannerTrayRow[]): number {
  return totalCopies(rows.filter((row) => !isKnownFinish(row.finish)));
}

/**
 * The tray as `collection_import_commit`'s lines.
 *
 * **One condition for the whole commit**, the Defaults popover's, because a tray row records none:
 * condition is a judgement a reader makes about a pile they are holding, not something a camera
 * reads off a card. **It throws while any row is unresolved** rather than dropping those rows —
 * a commit that quietly left three cards behind is one the reader would believe had taken them,
 * and the panel greys its button on exactly this condition so a press never reaches here.
 *
 * **It throws on an `unknown` finish too, and that is a fence rather than a rule.** Rows waiting
 * on a finish *are* left behind by an Add — but by {@link commitPlan}, out loud, with the button
 * saying how many; a row of unknown finish reaching this function is a caller that skipped that
 * split, and the collection would refuse the word anyway.
 */
export function importItems(
  rows: readonly ScannerTrayRow[],
  condition: Condition,
): CollectionImportItem[] {
  const waiting = unresolvedCount(rows);
  if (waiting > 0) {
    throw new Error(
      `${waiting} scanned ${waiting === 1 ? "card is" : "cards are"} still waiting for a printing to be picked.`,
    );
  }
  return rows.map((row) => {
    if (!isKnownFinish(row.finish)) {
      throw new Error(`${row.name} has no finish yet. Pick one before adding it.`);
    }
    return { cardId: row.cardId, quantity: row.quantity, finish: row.finish, condition };
  });
}

/** Why an Add cannot go: every card in the tray is still waiting on a finish. */
export const NO_FINISHED_ROWS = "Pick a finish for at least one card first";

/** Why an Add cannot go: there is nothing in the tray. */
export const EMPTY_REASON = "Nothing scanned yet";
/** Why an Add cannot go: a row is still waiting for the reader to say which printing it is. */
export const UNPICKED_REASON = "Pick a printing for every card first";
/** Why a deck cannot be made yet: a deck's rows each need a finish, where an Add leaves those out. */
export const DECK_NEEDS_FINISHES = "Choose a finish for every card first";

/**
 * Why Add is out of reach, in the order a reader can do something about each — **the order
 * {@link commitPlan} refuses in**, so the drawing and the press agree — or `null` when it can go.
 *
 * Words rather than a flag, because both Scanner surfaces say them: the desktop's tray in a
 * tooltip over the greyed button, the phone's under it — a finger has no hover.
 */
export function addRefusal(rows: readonly ScannerTrayRow[]): string | null {
  if (rows.length === 0) return EMPTY_REASON;
  if (unresolvedCount(rows) > 0) return UNPICKED_REASON;
  if (readyRows(rows).length === 0) return NO_FINISHED_ROWS;
  return null;
}

/**
 * Why *Create deck…* is out of reach: everything that stops an Add, and any row still waiting on a
 * finish — a deck files every row or none, so there is no "the rest stay in the tray" for it.
 */
export function deckRefusal(rows: readonly ScannerTrayRow[]): string | null {
  return addRefusal(rows) ?? (needsFinishCount(rows) > 0 ? DECK_NEEDS_FINISHES : null);
}

/**
 * The Add button's words: the copies it files, and — while there are any — the copies it leaves
 * behind for want of a finish. **One string, never a second element**: the name is computed from
 * the button's content and a span beside the count would fuse into `collection· 2` (`src/CLAUDE.md`,
 * the `Missing2` rule).
 */
export function addLabel(ready: number, needsFinish: number): string {
  const add = `Add ${ready} to collection`;
  if (needsFinish === 0) return add;
  return `${add} · ${needsFinish} ${needsFinish === 1 ? "needs" : "need"} a finish`;
}

/** The walk through the tray's open questions — the issue's words, and the press's name. */
export const NEXT_DECISION_LABEL = "Next card needing a decision";

/**
 * **What one press of Add files, and which rows it takes** — the known-finish rows as import
 * lines, and those same rows as `taken`, for the page to subtract from the tray once the commit
 * answers. Rows of unknown finish are in neither and stay in the tray, marked, which is the whole
 * of what `Add 8 to collection · 2 need a finish` promises.
 *
 * **An unresolved printing still stops everything, whatever its finish.** That rule is older than
 * this one and its reason has not moved: the reader is being asked a question, and an Add that went
 * ahead around it would read as having answered it. A tray of nothing but unknown finishes is
 * refused with {@link NO_FINISHED_ROWS} rather than committing an empty import. Both refusals are
 * the ones the panel greys its button on, so the press handler and the drawing agree.
 */
export function commitPlan(
  rows: readonly ScannerTrayRow[],
  condition: Condition,
): { items: CollectionImportItem[]; taken: ScannerTrayRow[] } {
  // The whole tray first, so an unresolved row of unknown finish still stops the press.
  if (unresolvedCount(rows) > 0) importItems(rows, condition);
  const taken = readyRows(rows);
  if (rows.length > 0 && taken.length === 0) throw new Error(NO_FINISHED_ROWS);
  return { items: importItems(taken, condition), taken };
}
