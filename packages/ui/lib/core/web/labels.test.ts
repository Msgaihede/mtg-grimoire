import { describe, expect, it, vi } from "vitest";
import { createEngine, NOT_OPENED, type Glue } from "./engine";
import { createWebCore, type WorkerPort } from "./index";
import { LABELS_COMMAND, transferOf, type FromWorker, type ToWorker } from "./protocol";

/**
 * **The labels' road from the engine to the scanner** (step 7.5): the engine's fourth export,
 * a message kind of its own on the database Worker's wire, and bytes that are handed over at
 * each hop rather than copied.
 */

const READY = { kind: "ready", journal: "delete", corpusJournal: "delete", schemaVersion: 59 };

function engineWith(labels: () => Promise<Uint8Array>) {
  const posted: FromWorker[] = [];
  const glue: Glue = {
    open: () => Promise.resolve(JSON.stringify(READY)),
    call: vi.fn(() => Promise.resolve('{"ok":null}')),
    listen: () => undefined,
    scanner_labels: vi.fn(labels),
  };
  const engine = createEngine(() => Promise.resolve(glue), (message) => posted.push(message));
  return { engine, glue, posted };
}

describe("the engine Worker's answer to `labels`", () => {
  it("is the export's bytes, and never a command of the table", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { engine, glue, posted } = engineWith(() => Promise.resolve(bytes));
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "labels", id: 7 });
    expect(posted[posted.length - 1]).toEqual({ kind: "labels", id: 7, bytes });
    expect(glue.call).not.toHaveBeenCalled();
  });

  it("answers no bytes as an answer: the corpus is empty", async () => {
    const { engine, posted } = engineWith(() => Promise.resolve(new Uint8Array(0)));
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "labels", id: 1 });
    expect(posted[posted.length - 1]).toEqual({ kind: "labels", id: 1, bytes: new Uint8Array(0) });
  });

  it("is refused as a call is before anybody asked to open", async () => {
    const { engine, posted } = engineWith(() => Promise.resolve(new Uint8Array(1)));
    await engine.handle({ kind: "labels", id: 2 });
    expect(posted).toEqual([{ kind: "err", id: 2, message: NOT_OPENED }]);
  });

  it("passes on the sentence of a read the engine gave up on, which is not an empty corpus", async () => {
    const gaveUp = "the scanner's labels could not be read: the card database changed under each of 12 attempts";
    // wasm-bindgen rejects with the `JsValue` the export returned: a string.
    const { engine, posted } = engineWith(() => Promise.reject(gaveUp));
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "labels", id: 4 });
    expect(posted[posted.length - 1]).toEqual({ kind: "err", id: 4, message: gaveUp });
  });

  it("settles the ask when the export throws", async () => {
    const { engine, posted } = engineWith(() => Promise.reject(new Error("unreachable")));
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "labels", id: 3 });
    expect(posted[posted.length - 1]).toEqual({ kind: "err", id: 3, message: "Error: unreachable" });
  });
});

describe("what rides beside a Worker's answer", () => {
  it("hands the labels' buffer over, and nothing for any other message", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(transferOf({ kind: "labels", id: 1, bytes })).toEqual([bytes.buffer]);
    expect(transferOf({ kind: "ok", id: 1, result: bytes })).toEqual([]);
    expect(transferOf({ kind: "event", event: "sync:progress", payload: {} })).toEqual([]);
  });

  it("copies a view of part of something, and has nothing to hand over for no bytes", () => {
    const memory = new Uint8Array(16);
    expect(transferOf({ kind: "labels", id: 1, bytes: memory.subarray(4, 8) })).toEqual([]);
    expect(transferOf({ kind: "labels", id: 1, bytes: new Uint8Array(0) })).toEqual([]);
  });
});

/** A database Worker the test is the other end of. */
class FakeWorker implements WorkerPort {
  posted: ToWorker[] = [];
  private onMessage: ((event: { data: FromWorker }) => void) | undefined;
  postMessage(message: ToWorker): void {
    this.posted.push(message);
  }
  addEventListener(type: "message", listener: (event: { data: FromWorker }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  addEventListener(type: "message" | "error", listener: unknown): void {
    if (type === "message") this.onMessage = listener as (event: { data: FromWorker }) => void;
  }
  terminate(): void {}
  say(message: FromWorker): void {
    this.onMessage?.({ data: message });
  }
}

describe("the page's ask for the labels", () => {
  it("is a `labels` message and not a call, held until the database is open like any other", async () => {
    const worker = new FakeWorker();
    const core = createWebCore(() => worker, "mtg-grimoire", { now: () => 0 });
    const asked = core.call<Uint8Array>(LABELS_COMMAND);
    await Promise.resolve();
    expect(worker.posted).toEqual([{ kind: "open", directory: "mtg-grimoire" }]);
    worker.say({ kind: "opened", opened: READY as never, existed: true });
    const message = worker.posted[worker.posted.length - 1];
    expect(message).toEqual({ kind: "labels", id: expect.any(Number) });
    if (message?.kind !== "labels") throw new Error("not a labels ask");
    const bytes = new Uint8Array([5, 6]);
    worker.say({ kind: "labels", id: message.id, bytes });
    expect(await asked).toBe(bytes);
  });

  it("is spelled as no command of the engine's table can be", () => {
    expect(LABELS_COMMAND).toMatch(/:/);
  });
});
