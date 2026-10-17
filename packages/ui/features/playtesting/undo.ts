import { useEffect } from "react";
import { isTextField } from "@/components/menu/useContextMenu";
import { matchesShortcut, shortcut } from "@/lib/shortcuts";
import { appendLog, type LogLine } from "./table/log";

/*
 * Undo and redo on the game board (issue #1022), the page's half — against the goldfish or the AI,
 * from whichever page opened it.
 *
 * **The game's half is the engine's**: `crates/grimoire-play/src/history.rs` keeps the whole game
 * before each of the reader's actions, and `{ type: "undo" }` / `{ type: "redo" }` go back and
 * forward along it, answering with the board as it was and no facts. What the engine does not
 * keep is the log, which is the page's (Rust supplies facts; the page writes the sentences) — so
 * the page keeps the log beside it the same way: **whole logs, not lines**. A count of the lines
 * an action added would have to agree with what a replay logs beat by beat, and a skipped or
 * reduced-motion replay logs its beats merged; a snapshot of the log as it stood cannot disagree.
 */

/** How many actions back a board goes. Mirrors `UNDO_LIMIT` in `grimoire-play`'s `history.rs`,
 *  so the log is kept for exactly the actions the engine can take back. */
export const UNDO_LIMIT = 100;

/**
 * The log and its history, one state so that every change to it is one pure step: the log as it
 * stood before each remembered action (oldest first), and as it stood before each undo (the next
 * to redo last).
 */
export interface LogBook {
  log: LogLine[];
  done: readonly LogLine[][];
  undone: readonly LogLine[][];
}

/** A new deal's book: `log`, and no history. */
export function freshBook(log: LogLine[] = []): LogBook {
  return { log, done: [], undone: [] };
}

/** `lines` (newest first) written at the head of the log. Not an action of its own. */
export function writeLog(book: LogBook, lines: readonly LogLine[]): LogBook {
  return { ...book, log: appendLog(book.log, lines) };
}

/** An action the engine remembered is about to be logged: the log as it stands is the one undo
 *  goes back to, and the redo trail ends — the engine's own rules, so the two walk in step. */
export function rememberLog(book: LogBook): LogBook {
  return { log: book.log, done: [...book.done, book.log].slice(-UNDO_LIMIT), undone: [] };
}

/** The log as it stood before the last remembered action; as it is with nothing to go back to. */
export function undoLog(book: LogBook): LogBook {
  if (book.done.length === 0) return book;
  return {
    log: book.done[book.done.length - 1],
    done: book.done.slice(0, -1),
    undone: [...book.undone, book.log],
  };
}

/** The log as it stood before the last undo; as it is with nothing to come forward to. */
export function redoLog(book: LogBook): LogBook {
  if (book.undone.length === 0) return book;
  return {
    log: book.undone[book.undone.length - 1],
    done: [...book.done, book.log],
    undone: book.undone.slice(0, -1),
  };
}

/** The chords, resolved at import so a renamed id throws before a press (`useDeckKeyboard`'s
 *  reason). One board, catalogued under the two scopes it is drawn in. */
const KEYS = {
  goldfish: { undo: shortcut("goldfish", "undo"), redo: shortcut("goldfish", "redo") },
  playtesting: { undo: shortcut("playtesting", "undo"), redo: shortcut("playtesting", "redo") },
} as const;

/** What a board offers to go back and forward to — the view's flags. */
export interface Undoable {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * `Ctrl+Z` takes the last action back, `Ctrl+Y` or `Ctrl+Shift+Z` takes it again — the
 * catalogue's chords for the board's scope, on `window` for the board's life.
 *
 * **It yields to a text field** (the life steppers), which keeps the browser's own undo there,
 * **to a dialog or a menu** over the board, as the board's other keys do, and **to a held key**:
 * each press is one step, so a repeat cannot queue undos past what the view said was there.
 * `enabled` is the board's own lock (the AI thinking). A press with nothing to go to is eaten and
 * does nothing, rather than reaching the browser.
 */
export function useUndoKeys(
  scope: keyof typeof KEYS,
  view: Undoable | null,
  act: (action: { type: "undo" } | { type: "redo" }) => void,
  enabled = true,
): void {
  useEffect(() => {
    const { undo, redo } = KEYS[scope];
    const onKey = (e: KeyboardEvent) => {
      const type = matchesShortcut(undo, e) ? "undo" : matchesShortcut(redo, e) ? "redo" : null;
      if (type === null) return;
      if (isTextField(e.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]') !== null) return;
      e.preventDefault();
      if (e.repeat || !enabled || view === null) return;
      if (type === "undo" ? view.canUndo : view.canRedo) act({ type });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope, view, act, enabled]);
}
