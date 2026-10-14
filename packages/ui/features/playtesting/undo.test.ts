import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LogLine } from "./goldfish/log";
import {
  UNDO_LIMIT,
  freshBook,
  redoLog,
  rememberLog,
  undoLog,
  useUndoKeys,
  writeLog,
  type LogBook,
} from "./undo";

const line = (text: string): LogLine => ({ turn: 1, text });
const texts = (book: LogBook) => book.log.map((l) => l.text);
/** An action the engine remembered, and the lines it logged — however many beats they came in. */
const act = (book: LogBook, ...beats: string[][]) =>
  beats.reduce((b, beat) => writeLog(b, beat.map(line)), rememberLog(book));

describe("the log book", () => {
  it("goes back to the log before an action and forward to the log after it", () => {
    let book = freshBook([line("Shuffled")]);
    book = act(book, ["Drew Forest"]);
    // A replay's beats, logged one by one: undo takes back all of them.
    book = act(book, ["Played Forest"], ["The opponent drew a card", "Turn 2 begins"]);
    const after = texts(book);
    book = undoLog(book);
    expect(texts(book)).toEqual(["Drew Forest", "Shuffled"]);
    book = undoLog(book);
    expect(texts(book)).toEqual(["Shuffled"]);
    book = redoLog(redoLog(book));
    expect(texts(book)).toEqual(after);
  });

  it("ends the redo trail on a new action, as the engine does", () => {
    let book = act(freshBook(), ["a"]);
    book = act(undoLog(book), ["b"]);
    expect(book.undone).toEqual([]);
    expect(redoLog(book)).toBe(book);
  });

  it("is left as it is with nothing to go back or forward to", () => {
    const book = freshBook([line("Shuffled")]);
    expect(undoLog(book)).toBe(book);
    expect(redoLog(book)).toBe(book);
  });

  it("remembers no more actions than the engine does", () => {
    let book = freshBook();
    for (let i = 0; i < UNDO_LIMIT + 3; i++) book = act(book, [`${i}`]);
    expect(book.done).toHaveLength(UNDO_LIMIT);
    expect(book.done[0][0].text).toBe("2");
  });
});

describe("useUndoKeys", () => {
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { cancelable: true, ...init });
    window.dispatchEvent(e);
    return e;
  };

  it("sends undo on Ctrl+Z and redo on Ctrl+Y or Ctrl+Shift+Z", () => {
    const act = vi.fn();
    renderHook(() => useUndoKeys("goldfish", { canUndo: true, canRedo: true }, act));
    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    press({ key: "y", ctrlKey: true });
    press({ key: "Z", ctrlKey: true, shiftKey: true });
    expect(act.mock.calls).toEqual([[{ type: "undo" }], [{ type: "redo" }], [{ type: "redo" }]]);
  });

  it("sends nothing the view does not offer, and nothing while locked or held", () => {
    const act = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useUndoKeys("playtesting", { canUndo: false, canRedo: true }, act, enabled),
      { initialProps: { enabled: true } },
    );
    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    press({ key: "y", ctrlKey: true, repeat: true });
    rerender({ enabled: false });
    press({ key: "y", ctrlKey: true });
    expect(act).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+Z to a text field", () => {
    const act = vi.fn();
    renderHook(() => useUndoKeys("goldfish", { canUndo: true, canRedo: false }, act));
    const field = document.createElement("input");
    document.body.append(field);
    const e = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(act).not.toHaveBeenCalled();
    field.remove();
  });
});
