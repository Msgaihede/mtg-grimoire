import { describe, expect, it, vi } from "vitest";
import type { FromScanner } from "./scanProtocol";
import { AFTER_A_TRAP, createScanSession, type ScanGlue } from "./scanSession";

const FACTS = {
  bundle: { loaded: true, entries: 2, error: null },
  labels: 2,
  models: { loaded: true, error: null },
  unapplied_filters: null,
};

function harness() {
  const posted: FromScanner[] = [];
  const glue = {
    load: vi.fn<ScanGlue["load"]>(() => JSON.stringify({ ok: FACTS })),
    frame: vi.fn<ScanGlue["frame"]>(() => '{"ok":{"ok":true,"decision_seq":0}}'),
    reset: vi.fn<ScanGlue["reset"]>(() => '{"ok":null}'),
    set_filters: vi.fn<ScanGlue["set_filters"]>(() => '{"ok":null}'),
    memory_bytes: vi.fn<ScanGlue["memory_bytes"]>(() => 89_000_000),
  };
  const load = vi.fn(() => Promise.resolve(glue as ScanGlue));
  const session = createScanSession(load, (message) => posted.push(message));
  return { session, glue, load, posted };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("the scanner Worker's session", () => {
  it("loads the module once, however many messages arrive before it has", async () => {
    const { session, load, posted } = harness();
    await Promise.all([
      session.handle({ kind: "reset", id: 1 }),
      session.handle({ kind: "reset", id: 2 }),
      session.handle({ kind: "memory", id: 3 }),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([
      { kind: "ok", id: 1, result: null },
      { kind: "ok", id: 2, result: null },
      { kind: "ok", id: 3, result: 89_000_000 },
    ]);
  });

  it("hands the module the owed filters ahead of the load, and answers the load's facts", async () => {
    const { session, glue, posted } = harness();
    const order: string[] = [];
    glue.set_filters.mockImplementation(() => (order.push("filters"), '{"ok":null}'));
    glue.load.mockImplementation(() => (order.push("load"), JSON.stringify({ ok: FACTS })));
    await session.handle({
      kind: "load",
      id: 1,
      filters: '{"sets":["LTR"]}',
      bundle: bytes(1),
      labels: bytes(2),
      detection: null,
      recognition: null,
    });
    expect(order).toEqual(["filters", "load"]);
    expect(glue.set_filters).toHaveBeenCalledWith('{"sets":["LTR"]}');
    expect(glue.load).toHaveBeenCalledWith(bytes(1), bytes(2), null, null);
    expect(posted).toEqual([{ kind: "ok", id: 1, result: FACTS }]);
  });

  it("asks the module nothing about filters when none are owed", async () => {
    const { session, glue } = harness();
    await session.handle({ kind: "load", id: 1, filters: null, bundle: null, labels: null, detection: null, recognition: null });
    expect(glue.set_filters).not.toHaveBeenCalled();
  });

  it("passes a frame and its detail through, and the module's refusal as an err", async () => {
    const { session, glue, posted } = harness();
    await session.handle({ kind: "frame", id: 4, jpeg: bytes(1, 2), detail: bytes(3), options: "{}" });
    expect(glue.frame).toHaveBeenCalledWith(bytes(1, 2), bytes(3), "{}");
    glue.set_filters.mockReturnValue('{"err":"these filters match no printing"}');
    await session.handle({ kind: "filters", id: 5, filters: "{}" });
    expect(posted).toEqual([
      { kind: "ok", id: 4, result: { ok: true, decision_seq: 0 } },
      { kind: "err", id: 5, message: "these filters match no printing" },
    ]);
  });

  it("says a module this browser will not compile is unsupported, and never loads again", async () => {
    const posted: FromScanner[] = [];
    const refused = Object.assign(new Error("Wasm SIMD unsupported"), { name: "CompileError" });
    const load = vi.fn(() => Promise.reject(refused));
    const session = createScanSession(load, (message) => posted.push(message));
    await session.handle({ kind: "reset", id: 1 });
    await session.handle({ kind: "reset", id: 2 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([
      { kind: "unloaded", id: 1, unsupported: true, message: "CompileError: Wasm SIMD unsupported" },
      { kind: "unloaded", id: 2, unsupported: true, message: "CompileError: Wasm SIMD unsupported" },
    ]);
  });

  it("says a module that did not arrive is not unsupported", async () => {
    const posted: FromScanner[] = [];
    const session = createScanSession(
      () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
      (message) => posted.push(message),
    );
    await session.handle({ kind: "memory", id: 1 });
    expect(posted[0]).toMatchObject({ kind: "unloaded", unsupported: false });
  });

  it("answers an export that throws as a trap, and asks the module nothing after it", async () => {
    const { session, glue, posted } = harness();
    glue.frame.mockImplementation(() => {
      throw Object.assign(new Error("unreachable"), { name: "RuntimeError" });
    });
    await session.handle({ kind: "frame", id: 1, jpeg: bytes(1), detail: null, options: "" });
    await session.handle({ kind: "reset", id: 2 });
    await session.handle({ kind: "memory", id: 3 });
    expect(posted).toEqual([
      { kind: "trapped", id: 1, message: "RuntimeError: unreachable" },
      { kind: "trapped", id: 2, message: AFTER_A_TRAP },
      { kind: "trapped", id: 3, message: AFTER_A_TRAP },
    ]);
    expect(glue.reset).not.toHaveBeenCalled();
    expect(glue.memory_bytes).not.toHaveBeenCalled();
  });
});
