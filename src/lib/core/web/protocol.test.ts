import { describe, expect, it } from "vitest";
import { answerOf, argsText, callMessage, openedOf, readable } from "./protocol";

describe("a call, as the message the Worker is sent", () => {
  it("carries named arguments untouched and hands nothing over", () => {
    expect(callMessage(7, "search_cards", { req: { text: "bolt" } })).toEqual({
      message: { kind: "call", id: 7, command: "search_cards", args: { req: { text: "bolt" } } },
      transfer: [],
    });
  });

  it("sends no args key for a command called with none", () => {
    const { message } = callMessage(1, "list_sets");
    // Absent, not `undefined`: the Worker spells an absent key `"null"` to the engine, and a
    // structured clone would carry an explicit `undefined` across as one.
    expect(message).toEqual({ kind: "call", id: 1, command: "list_sets" });
    expect("args" in message).toBe(false);
  });

  it("transfers a byte payload, with its headers as the arguments", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const { message, transfer } = callMessage(3, "scanner_frame", bytes, {
      headers: { "x-scanner-options": "{}" },
    });
    // `table.ts`'s convention for the same call: the headers are the args, the bytes the body.
    expect(message).toEqual({
      kind: "call",
      id: 3,
      command: "scanner_frame",
      args: { "x-scanner-options": "{}" },
      body: bytes,
    });
    // The buffer itself, not a copy of it: that is what makes the crossing a hand-over.
    expect(transfer).toEqual([bytes.buffer]);
    expect(transfer[0]).toBe(bytes.buffer);
  });

  it("copies a view that is only part of its buffer, and leaves the rest of that memory alone", () => {
    const frames = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const middle = frames.subarray(2, 5);
    const { message, transfer } = callMessage(5, "scanner_frame", middle);
    // Handing over `frames.buffer` would empty `frames` and every other view of it.
    expect(transfer[0]).not.toBe(frames.buffer);
    expect(message).toMatchObject({ body: new Uint8Array([1, 2, 3]) });
    expect(transfer[0]).toBe((message as { body: Uint8Array }).body.buffer);
  });

  it("gives a byte payload with no headers an empty argument object", () => {
    const { message } = callMessage(4, "scanner_frame", new Uint8Array(1));
    expect(message).toMatchObject({ args: {} });
  });
});

describe("the engine's JSON, in both directions", () => {
  it("spells a call with no arguments as null", () => {
    expect(argsText(undefined)).toBe("null");
    expect(argsText({ id: 4 })).toBe('{"id":4}');
  });

  it("reads an ok and an err as the message for that id", () => {
    expect(answerOf(5, '{"ok":{"rows":[1,2]}}')).toEqual({
      kind: "ok",
      id: 5,
      result: { rows: [1, 2] },
    });
    // A command that answers nothing answers `null`, and that is still an answer.
    expect(answerOf(5, '{"ok":null}')).toEqual({ kind: "ok", id: 5, result: null });
    expect(answerOf(6, '{"err":"No such deck."}')).toEqual({
      kind: "err",
      id: 6,
      message: "No such deck.",
    });
  });

  it("settles a call whose answer nobody can read, rather than leaving it waiting", () => {
    for (const text of ["", "not json", "[]", "null", '{"value":1}']) {
      expect(answerOf(9, text), text).toMatchObject({ kind: "err", id: 9 });
    }
  });

  it("reads each of the open's three answers", () => {
    const ready = { kind: "ready", journal: "delete", corpusJournal: "delete", schemaVersion: 59 };
    expect(openedOf(JSON.stringify(ready))).toEqual(ready);
    expect(openedOf('{"kind":"already-open"}')).toEqual({ kind: "already-open" });
    expect(openedOf('{"kind":"failed","message":"no pool"}')).toEqual({
      kind: "failed",
      message: "no pool",
    });
  });

  it("reads an open it cannot read as a failure, never as ready", () => {
    for (const text of ["", "{}", '{"kind":"opened"}', "ready"]) {
      expect(openedOf(text).kind, text).toBe("failed");
    }
  });

  it("says what an error was in one line", () => {
    expect(readable(new WebAssembly.RuntimeError("unreachable"))).toBe("RuntimeError: unreachable");
    expect(readable("a bare string")).toBe("a bare string");
  });
});
