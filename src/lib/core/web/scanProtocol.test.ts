import { describe, expect, it } from "vitest";
import scannerRs from "../../../../crates/grimoire-core/src/scanner.rs?raw";
import {
  DETAIL_HEADER,
  frameMessage,
  isUnsupported,
  loadFactsOf,
  loadMessage,
  OPTIONS_HEADER,
  scanAnswerOf,
  type ScanOutgoing,
} from "./scanProtocol";

const sent = (outgoing: ScanOutgoing | string): ScanOutgoing => {
  if (typeof outgoing === "string") throw new Error(`refused: ${outgoing}`);
  return outgoing;
};

describe("a load, as the message the scanner's Worker is sent", () => {
  it("hands over every file's buffer and copies none", () => {
    const bundle = new Uint8Array([1, 2, 3]);
    const labels = new Uint8Array([4, 5]);
    const detection = new Uint8Array([6]);
    const recognition = new Uint8Array([7, 8]);
    const { message, transfer } = loadMessage(3, '{"sets":["LTR"]}', {
      bundle,
      labels,
      detection,
      recognition,
    });
    expect(message).toEqual({
      kind: "load",
      id: 3,
      filters: '{"sets":["LTR"]}',
      bundle,
      labels,
      detection,
      recognition,
    });
    expect(transfer).toEqual([bundle.buffer, labels.buffer, detection.buffer, recognition.buffer]);
  });

  it("hands over nothing for a file that is not there, or that is no bytes", () => {
    const { message, transfer } = loadMessage(1, null, {
      bundle: null,
      labels: new Uint8Array(0),
      detection: null,
      recognition: null,
    });
    expect(message).toMatchObject({ kind: "load", filters: null, bundle: null });
    expect(transfer).toEqual([]);
  });
});

describe("a frame, as the message the scanner's Worker is sent", () => {
  it("names the two headers as the engine names them", () => {
    expect(scannerRs).toContain(`pub const OPTIONS_HEADER: &str = "${OPTIONS_HEADER}";`);
    expect(scannerRs).toContain(`pub const DETAIL_HEADER: &str = "${DETAIL_HEADER}";`);
  });

  it("is the whole body when there is no detail, transferred", () => {
    const body = new Uint8Array([0xff, 0xd8, 1, 2]);
    const { message, transfer } = sent(
      frameMessage(7, body, { [OPTIONS_HEADER]: '{"mode":"exact"}' }),
    );
    expect(message).toEqual({
      kind: "frame",
      id: 7,
      jpeg: body,
      detail: null,
      options: '{"mode":"exact"}',
    });
    expect(transfer).toEqual([body.buffer]);
  });

  it("splits the body at the detail header without copying a byte", () => {
    const body = new Uint8Array([1, 2, 3, 9, 9]);
    const { message, transfer } = sent(frameMessage(1, body, { [DETAIL_HEADER]: "3" }));
    if (message.kind !== "frame") throw new Error("not a frame");
    expect([...message.jpeg]).toEqual([1, 2, 3]);
    expect([...(message.detail ?? [])]).toEqual([9, 9]);
    // Two views of the one buffer, and the buffer handed over once.
    expect(message.jpeg.buffer).toBe(body.buffer);
    expect(message.detail?.buffer).toBe(body.buffer);
    expect(transfer).toEqual([body.buffer]);
    // No options header is the defaults, which the module reads empty text as.
    expect(message.options).toBe("");
  });

  it("copies a body that is only part of its buffer, and leaves the rest of that memory alone", () => {
    const memory = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const body = memory.subarray(1, 5);
    const { message, transfer } = sent(frameMessage(1, body, { [DETAIL_HEADER]: "2" }));
    if (message.kind !== "frame") throw new Error("not a frame");
    expect([...message.jpeg]).toEqual([1, 2]);
    expect([...(message.detail ?? [])]).toEqual([3, 4]);
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).not.toBe(memory.buffer);
  });

  it("refuses a detail length the body cannot be split at, in the engine's own sentences", () => {
    const body = new Uint8Array(4);
    const refusals = [
      frameMessage(1, body, { [DETAIL_HEADER]: "abc" }),
      frameMessage(1, body, { [DETAIL_HEADER]: "0" }),
      frameMessage(1, body, { [DETAIL_HEADER]: "4" }),
      frameMessage(1, body, { [DETAIL_HEADER]: "-1" }),
    ];
    expect(refusals).toEqual([
      `the frame's detail length is not a number: "abc"`,
      "the frame's detail length is zero, so there is no frame before it",
      "the frame's detail length is 4 bytes but the body is 4 — there is no detail image behind the frame",
      `the frame's detail length is not a number: "-1"`,
    ]);
    // As Rust's `usize` parse reads a number: a `+` in front is one, a space or a sign is not.
    const plus = sent(frameMessage(1, new Uint8Array([1, 2, 3]), { [DETAIL_HEADER]: "+2" }));
    expect(plus.message).toMatchObject({ kind: "frame", jpeg: new Uint8Array([1, 2]) });
    for (const not of [" 2", "2 ", "2.0", "0x2", ""]) {
      expect(frameMessage(1, new Uint8Array(4), { [DETAIL_HEADER]: not }), not).toMatch(/is not a number/);
    }
    // Held to the Rust they repeat (`scanner::split_detail`).
    expect(scannerRs).toContain("the frame's detail length is not a number: {text:?}");
    expect(scannerRs).toContain("the frame's detail length is zero, so there is no frame before it");
    expect(scannerRs.replace(/\\\s+/g, "")).toContain(
      "the frame's detail length is {n} bytes but the body is {} — there is no detail image behind the frame",
    );
  });
});

describe("the module's strings", () => {
  it("reads an ok and an err as the message for that id", () => {
    expect(scanAnswerOf(4, '{"ok":{"ok":true}}')).toEqual({ kind: "ok", id: 4, result: { ok: true } });
    expect(scanAnswerOf(4, '{"ok":null}')).toEqual({ kind: "ok", id: 4, result: null });
    expect(scanAnswerOf(5, '{"err":"no labels to filter by"}')).toEqual({
      kind: "err",
      id: 5,
      message: "no labels to filter by",
    });
  });

  it("settles a call whose answer nobody can read", () => {
    for (const text of ["", "not json", "[]", "7", '{"neither":1}']) {
      const answer = scanAnswerOf(9, text);
      expect(answer.kind).toBe("err");
      expect(answer).toMatchObject({ id: 9 });
    }
  });

  it("reads a load's facts, and nothing that is not them", () => {
    const facts = {
      bundle: { loaded: true, entries: 118313, error: null },
      labels: 118475,
      models: { loaded: false, error: "one model without the other: the readers need both" },
      unapplied_filters: null,
    };
    expect(loadFactsOf(facts)).toEqual(facts);
    expect(loadFactsOf({ ...facts, unapplied_filters: "no labels" })?.unapplied_filters).toBe(
      "no labels",
    );
    for (const not of [null, 7, {}, { bundle: {}, labels: 1, models: {} }, { ...facts, labels: "1" }]) {
      expect(loadFactsOf(not)).toBeNull();
    }
  });

  it("knows a module this browser will not compile from one that did not arrive", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    expect(isUnsupported(named("CompileError"))).toBe(true);
    expect(isUnsupported(named("LinkError"))).toBe(true);
    expect(isUnsupported(new TypeError("Failed to fetch"))).toBe(false);
    expect(isUnsupported("CompileError")).toBe(false);
  });
});
