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
import type { Finish } from "@/lib/finish";
import type {
  CollectionImportItem,
  ScannerDecision,
  ScannerTrayChoice,
  ScannerTrayRow,
} from "@/lib/ipc";

/** What a new row starts as that the decision itself cannot say. */
export interface RowDefaults {
  finish: Finish;
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
 * while that row is in the finish a new row would start in.** The collection's grain includes the
 * finish, so a foil row the reader set by hand and a nonfoil copy scanned after it are two rows in
 * the binder — counting the second onto the first would file a plain card as a foil one. A
 * card that leaves the frame and comes back is a second copy of the card just scanned — that is
 * the whole of the re-presentation gesture — while the same printing ten cards ago is a reader
 * sorting a pile out of order, and folding it into a row they have scrolled past would move a
 * number nobody is looking at. A row still waiting for a pick is never bumped: it has not decided
 * what it *is*, so "the same printing again" is not a question it can answer.
 *
 * **A bump refreshes `addedAt`**, because it *is* an add — the row is the newest thing that
 * happened in the tray, and a surface keying a flash on that stamp replays it for the second copy.
 *
 * **A decision that `replaces_previous` is a second opinion, not a second copy, and it replaces
 * the newest row instead of adding one** — but only when that row is the same oracle card, both
 * ids known. "Fast said Forest, switch to Exact to pin the printing" is one card on the mat, and
 * adding would file it twice. The row keeps its key, quantity and finish — the reader's own
 * answers, and the flash's identity — and takes everything that says *which printing* from the
 * decision, its choices included. The session's flag alone is not enough: a row the reader removed
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
    d.oracle_id !== null &&
    newest.oracleId !== null &&
    newest.oracleId === d.oracle_id
  ) {
    const fresh = rowFromDecision(d, defaults, now, newest.key);
    return {
      rows: [{ ...fresh, quantity: newest.quantity, finish: newest.finish }, ...rows.slice(1)],
      bumped: false,
      replaced: true,
    };
  }
  if (
    newest !== undefined &&
    d.outcome === "resolved" &&
    newest.choices.length === 0 &&
    newest.cardId === d.printing &&
    newest.finish === defaults.finish
  ) {
    return {
      rows: [{ ...newest, quantity: newest.quantity + 1, addedAt: now }, ...rows.slice(1)],
      bumped: true,
      replaced: false,
    };
  }
  return { rows: [rowFromDecision(d, defaults, now, key), ...rows], bumped: false, replaced: false };
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

export function setFinish(
  rows: readonly ScannerTrayRow[],
  key: string,
  finish: Finish,
): ScannerTrayRow[] {
  return update(rows, key, (row) => ({ ...row, finish }));
}

/** A printing adopted whole — every identifying field at once, so a row cannot end up half one
 *  printing and half another — and the question it was waiting on closed. */
function adopt(row: ScannerTrayRow, p: ScannerTrayChoice): ScannerTrayRow {
  return {
    ...row,
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

/** Copies, not rows: a bumped row of three is three cards going into the collection. */
export function totalCopies(rows: readonly ScannerTrayRow[]): number {
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}

/**
 * The tray as `collection_import_commit`'s lines.
 *
 * **One condition for the whole commit**, the Defaults popover's, because a tray row records none:
 * condition is a judgement a reader makes about a pile they are holding, not something a camera
 * reads off a card. **It throws while any row is unresolved** rather than dropping those rows —
 * a commit that quietly left three cards behind is one the reader would believe had taken them,
 * and the panel greys its button on exactly this condition so a press never reaches here.
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
  return rows.map((row) => ({
    cardId: row.cardId,
    quantity: row.quantity,
    finish: row.finish,
    condition,
  }));
}
