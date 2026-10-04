import { describe, expect, it, vi } from "vitest";
import { createEngine, NOT_OPENED, once, type Glue } from "./engine";
import type { FromWorker } from "./protocol";

const READY = { kind: "ready", journal: "delete", corpusJournal: "delete", schemaVersion: 59 };

/** A promise and the two ends of it, so a test decides when a load or an open finishes. */
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * An engine over a glue the test wrote, and everything it posted. `held` is what the browser's
 * storage is found to hold before the open — the folder is there, unless a test says otherwise.
 */
function harness(
  over: Partial<Glue> = {},
  held: (directory: string) => Promise<boolean | null> = () => Promise.resolve(true),
) {
  const posted: FromWorker[] = [];
  let sink: ((name: string, payload: string) => void) | undefined;
  const glue = {
    open: vi.fn<Glue["open"]>(() => Promise.resolve(JSON.stringify(READY))),
    call: vi.fn<Glue["call"]>(() => Promise.resolve('{"ok":null}')),
    listen: vi.fn<Glue["listen"]>((handler) => {
      sink = handler;
    }),
    ...over,
  };
  const load = vi.fn(() => Promise.resolve(glue as Glue));
  const engine = createEngine(load, (message) => posted.push(message), held);
  return {
    engine,
    glue,
    load,
    posted,
    emit: (name: string, payload: string) => sink?.(name, payload),
  };
}

describe("once", () => {
  it("runs the work once for callers that arrive while the first is still waiting", async () => {
    const started = gate<number>();
    const make = vi.fn(() => started.promise);
    const get = once(make);

    // Both in one turn, before anything has resolved — the case a flag set at the end misses.
    const first = get();
    const second = get();
    started.resolve(7);

    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(make).toHaveBeenCalledTimes(1);
  });
});

describe("the Worker's engine", () => {
  it("loads the module once and opens the database once, however many times it is asked", async () => {
    // What React's StrictMode does to a page that opens from an effect, and what cost round one
    // two first runs in three: two `open`s in one turn, before the module has loaded.
    const loading = gate<Glue>();
    const { engine, glue, load, posted } = harness();
    load.mockImplementation(() => loading.promise);

    const first = engine.handle({ kind: "open", directory: "mtg-grimoire" });
    const second = engine.handle({ kind: "open", directory: "mtg-grimoire" });
    loading.resolve(glue as Glue);
    await Promise.all([first, second]);
    // …and a third, long after: answered from the first, not asked again.
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });

    expect(load).toHaveBeenCalledTimes(1);
    expect(glue.open).toHaveBeenCalledTimes(1);
    expect(glue.open).toHaveBeenCalledWith("mtg-grimoire");
    expect(glue.listen).toHaveBeenCalledTimes(1);
    // Every ask is answered, and with the one answer.
    expect(posted).toEqual([
      { kind: "opened", opened: READY, existed: true },
      { kind: "opened", opened: READY, existed: true },
      { kind: "opened", opened: READY, existed: true },
    ]);
  });

  it("asks what the browser held before it opens anything, once, and says what it found", async () => {
    // Opening is what creates the folder, so the question is only worth asking ahead of it.
    const order: string[] = [];
    const held = vi.fn((directory: string) => {
      order.push(`held ${directory}`);
      return Promise.resolve(false);
    });
    const { engine, posted } = harness(
      {
        open: vi.fn((directory: string) => {
          order.push(`open ${directory}`);
          return Promise.resolve(JSON.stringify(READY));
        }),
      },
      held,
    );

    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });

    expect(order).toEqual(["held mtg-grimoire", "open mtg-grimoire"]);
    // The second ask is answered with the first's finding: asked again now, it would find the
    // folder the first open made and call a cleared database an ordinary launch.
    expect(posted).toEqual([
      { kind: "opened", opened: READY, existed: false },
      { kind: "opened", opened: READY, existed: false },
    ]);
  });

  it("opens the database all the same when the browser cannot be asked what it held", async () => {
    const thrown = harness({}, () => Promise.reject(new DOMException("no", "SecurityError")));
    await thrown.engine.handle({ kind: "open", directory: "mtg-grimoire" });
    expect(thrown.posted).toEqual([{ kind: "opened", opened: READY, existed: null }]);

    // A throw before any promise is the same answer: not known, and never a reason not to open.
    const synchronous = harness({}, () => {
      throw new TypeError("navigator.storage is undefined");
    });
    await synchronous.engine.handle({ kind: "open", directory: "mtg-grimoire" });
    expect(synchronous.posted).toEqual([{ kind: "opened", opened: READY, existed: null }]);
  });

  it("answers a second tab's refusal as the open's answer, and remembers it", async () => {
    const { engine, glue, posted } = harness({
      open: vi.fn(() => Promise.resolve('{"kind":"already-open"}')),
    });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });

    expect(glue.open).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([
      { kind: "opened", opened: { kind: "already-open" }, existed: true },
      { kind: "opened", opened: { kind: "already-open" }, existed: true },
    ]);
  });

  it("says the module never loaded, in words, instead of saying nothing", async () => {
    const { engine, load, posted } = harness();
    load.mockImplementation(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    );

    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    // Kept apart from a database that would not open: a reload can cure this one.
    expect(posted).toEqual([
      {
        kind: "opened",
        opened: {
          kind: "unloaded",
          message: "TypeError: Failed to fetch dynamically imported module",
        },
        existed: true,
      },
    ]);

    // And a call made of it is refused with the same words rather than left waiting.
    await engine.handle({ kind: "call", id: 1, command: "list_sets" });
    expect(posted[1]).toEqual({
      kind: "err",
      id: 1,
      message: "TypeError: Failed to fetch dynamically imported module",
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reports an open that trapped as a failure with the trap's own line", async () => {
    const { engine, posted } = harness({
      open: vi.fn(() => Promise.reject(new WebAssembly.RuntimeError("unreachable"))),
    });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    expect(posted).toEqual([
      {
        kind: "opened",
        opened: { kind: "failed", message: "RuntimeError: unreachable" },
        existed: true,
      },
    ]);
  });

  it("forwards a call by name, its arguments as JSON text, and answers by its id", async () => {
    const { engine, glue, load, posted } = harness({
      call: vi.fn(() => Promise.resolve('{"ok":{"rows":3}}')),
    });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "call", id: 41, command: "search_cards", args: { text: "bolt" } });
    await engine.handle({ kind: "call", id: 42, command: "list_sets" });

    expect(glue.call).toHaveBeenNthCalledWith(1, "search_cards", '{"text":"bolt"}', undefined);
    // No arguments is the JSON text `null`, never an empty string or an absent parameter.
    expect(glue.call).toHaveBeenNthCalledWith(2, "list_sets", "null", undefined);
    expect(posted.slice(1)).toEqual([
      { kind: "ok", id: 41, result: { rows: 3 } },
      { kind: "ok", id: 42, result: { rows: 3 } },
    ]);
    // Each call asks for the module, and each is handed the one the open loaded: a second
    // instantiate here is the heap corruption this file's `once` exists to prevent.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("hands a byte payload to the engine as bytes, its headers as the arguments", async () => {
    const { engine, glue } = harness();
    const body = new Uint8Array([1, 2, 3]);
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({
      kind: "call",
      id: 1,
      command: "scanner_frame",
      args: { "x-scanner-options": "{}" },
      body,
    });
    expect(glue.call).toHaveBeenCalledWith("scanner_frame", '{"x-scanner-options":"{}"}', body);
  });

  it("answers the engine's refusal as an err for that id", async () => {
    const { engine, posted } = harness({
      call: vi.fn(() => Promise.resolve('{"err":"No such deck."}')),
    });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "call", id: 8, command: "deck_get", args: { id: 999 } });
    expect(posted[1]).toEqual({ kind: "err", id: 8, message: "No such deck." });
  });

  it("turns a trap inside a call into an err the page can show", async () => {
    // The engine never rejects — a rejection is a trap — and round one sat at "running…" over
    // one because nothing carried it out of the Worker.
    const { engine, posted } = harness({
      call: vi.fn(() =>
        Promise.reject(new WebAssembly.RuntimeError("memory access out of bounds")),
      ),
    });
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });
    await engine.handle({ kind: "call", id: 5, command: "search_cards" });
    expect(posted[1]).toEqual({
      kind: "err",
      id: 5,
      message: "RuntimeError: memory access out of bounds",
    });
  });

  it("makes a call that arrives while the database is opening wait for it", async () => {
    const opening = gate<string>();
    const { engine, glue, posted } = harness({ open: vi.fn(() => opening.promise) });

    const opened = engine.handle({ kind: "open", directory: "mtg-grimoire" });
    const called = engine.handle({ kind: "call", id: 1, command: "list_sets" });
    await Promise.resolve();
    expect(glue.call).not.toHaveBeenCalled();
    expect(posted).toEqual([]);

    opening.resolve(JSON.stringify(READY));
    await Promise.all([opened, called]);
    expect(glue.call).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ kind: "ok", id: 1, result: null });
  });

  it("refuses a call nobody opened a database for, and loads nothing to do it", async () => {
    const { engine, load, posted } = harness();
    await engine.handle({ kind: "call", id: 1, command: "list_sets" });
    expect(posted).toEqual([{ kind: "err", id: 1, message: NOT_OPENED }]);
    expect(load).not.toHaveBeenCalled();
  });

  it("forwards an engine event with its payload parsed, and drops one that is not JSON", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { engine, posted, emit } = harness();
    await engine.handle({ kind: "open", directory: "mtg-grimoire" });

    emit("sync:progress", '{"phase":"ingesting","done":3}');
    emit("sync:progress", "not json");

    expect(posted.slice(1)).toEqual([
      { kind: "event", event: "sync:progress", payload: { phase: "ingesting", done: 3 } },
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
