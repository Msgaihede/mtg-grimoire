import { describe, expect, it } from "vitest";
import scannerRs from "../../../../../crates/grimoire-core/src/scanner.rs?raw";
import {
  frameMessage,
  isUnsupported,
  loadFactsOf,
  loadMessage,
  neuralEvidenceMessage,
  neuralMessage,
  scanAnswerOf,
} from "./scanProtocol";

describe("a load, as the message the scanner's Worker is sent", () => {
  it("hands over the labels' buffer and copies it not", () => {
    const labels = new Uint8Array([4, 5]);
    const { message, transfer } = loadMessage(3, '{"sets":["LTR"]}', labels);
    expect(message).toEqual({ kind: "load", id: 3, filters: '{"sets":["LTR"]}', labels });
    expect(transfer).toEqual([labels.buffer]);
  });

  it("hands over nothing for labels that are not there, or that are no bytes", () => {
    for (const labels of [null, new Uint8Array(0)]) {
      const { message, transfer } = loadMessage(1, null, labels);
      expect(message).toMatchObject({ kind: "load", filters: null });
      expect(transfer).toEqual([]);
    }
  });
});

describe("the Neural files, as the message the scanner's Worker is sent", () => {
  it("hands over all four buffers, in `load_neural`'s order, and copies none", () => {
    const detector = new Uint8Array([1, 2]);
    const embedder = new Uint8Array([3]);
    const gallery = new Uint8Array([4, 5, 6]);
    const meta = new Uint8Array([7]);
    const { message, transfer } = neuralMessage(9, { detector, embedder, gallery, meta });
    expect(message).toEqual({ kind: "neural", id: 9, detector, embedder, gallery, meta });
    expect(transfer).toEqual([detector.buffer, embedder.buffer, gallery.buffer, meta.buffer]);
  });
});

describe("the Neural evidence files, as the message the scanner's Worker is sent", () => {
  it("hands over all four buffers, in `load_neural_evidence`'s order, and copies none", () => {
    const symbolNet = new Uint8Array([1, 2]);
    const bandNet = new Uint8Array([3]);
    const symbols = new Uint8Array([4, 5, 6]);
    const bands = new Uint8Array([7]);
    const { message, transfer } = neuralEvidenceMessage(10, { symbolNet, bandNet, symbols, bands });
    expect(message).toEqual({
      kind: "neural-evidence",
      id: 10,
      symbolNet,
      bandNet,
      symbols,
      bands,
    });
    expect(transfer).toEqual([symbolNet.buffer, bandNet.buffer, symbols.buffer, bands.buffer]);
  });
});

describe("a frame, as the message the scanner's Worker is sent", () => {
  /**
   * **A frame is its JPEG and nothing beside it** — the engine reads no header for one any more,
   * so none is named there either (2026-10-24: the options and the detail frame went with the old
   * scanner).
   */
  it("reads no header, as the engine reads none", () => {
    expect(scannerRs).not.toContain('"x-scanner-options"');
    expect(scannerRs).not.toContain('"x-scanner-detail"');
  });

  it("is the whole body, transferred", () => {
    const body = new Uint8Array([0xff, 0xd8, 1, 2]);
    const { message, transfer } = frameMessage(7, body);
    expect(message).toEqual({ kind: "frame", id: 7, jpeg: body });
    expect(transfer).toEqual([body.buffer]);
  });

  it("copies a body that is only part of its buffer, and leaves the rest of that memory alone", () => {
    const memory = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const body = memory.subarray(1, 5);
    const { message, transfer } = frameMessage(1, body);
    if (message.kind !== "frame") throw new Error("not a frame");
    expect([...message.jpeg]).toEqual([1, 2, 3, 4]);
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).not.toBe(memory.buffer);
    expect([...memory]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("the module's strings", () => {
  it("reads an ok and an err as the message for that id", () => {
    expect(scanAnswerOf(4, '{"ok":{"ok":true}}')).toEqual({
      kind: "ok",
      id: 4,
      result: { ok: true },
    });
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
    const facts = { labels: 118475, unapplied_filters: null };
    expect(loadFactsOf(facts)).toEqual(facts);
    expect(loadFactsOf({ ...facts, unapplied_filters: "no labels" })?.unapplied_filters).toBe(
      "no labels",
    );
    for (const not of [null, 7, {}, { unapplied_filters: null }, { ...facts, labels: "1" }]) {
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
