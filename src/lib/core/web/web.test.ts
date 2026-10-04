import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupStatus } from "@/lib/ipc";
import { ALREADY_OPEN, createWebCore, OPFS_DIRECTORY, type WorkerPort } from "./index";
import type { FromWorker, Opening, ToWorker } from "./protocol";

const READY: Opening = {
  kind: "ready",
  journal: "delete",
  corpusJournal: "delete",
  schemaVersion: 59,
};

/** A Worker the test is the other end of: what the page posted, and a way to answer it. */
class FakeWorker implements WorkerPort {
  posted: { message: ToWorker; transfer: ArrayBuffer[] }[] = [];
  private onMessage: ((event: { data: FromWorker }) => void) | undefined;
  private onError: ((event: { message?: string }) => void) | undefined;

  postMessage(message: ToWorker, transfer: ArrayBuffer[]): void {
    this.posted.push({ message, transfer });
  }

  addEventListener(type: "message", listener: (event: { data: FromWorker }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  addEventListener(
    type: "message" | "error",
    listener: ((event: { data: FromWorker }) => void) | ((event: { message?: string }) => void),
  ): void {
    if (type === "message") this.onMessage = listener as (event: { data: FromWorker }) => void;
    else this.onError = listener as (event: { message?: string }) => void;
  }

  /** The Worker says something. */
  say(message: FromWorker): void {
    this.onMessage?.({ data: message });
  }

  /** The Worker's own `error` event. */
  crash(message?: string): void {
    this.onError?.({ message });
  }

  /** Every message posted, without what was handed over beside it. */
  get messages(): ToWorker[] {
    return this.posted.map(({ message }) => message);
  }
}

/** A core over one fake Worker, and a count of how many it asked for. */
function harness() {
  const worker = new FakeWorker();
  const spawn = vi.fn(() => worker);
  return { core: createWebCore(spawn), worker, spawn };
}

const status = (core: ReturnType<typeof createWebCore>) =>
  core.call<StartupStatus>("startup_status");

/** What the core said on the console. Caught, so an opened database does not print in the run. */
let said: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  said = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => said.mockRestore());

describe("the web core's Worker", () => {
  it("says which journal each file got when the database opens, and nothing when it does not", () => {
    const refused = harness();
    void status(refused.core);
    refused.worker.say({ kind: "opened", opened: { kind: "already-open" } });
    expect(said).not.toHaveBeenCalled();

    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });
    // `web-smoke.mjs` reads this line off a real browser's console; the words are its contract.
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: database open in OPFS — journal delete, corpus journal delete, schema 59",
    );
  });

  it("makes none until something is asked of it", () => {
    const { spawn } = harness();
    // Importing the module, or building the core, must not start a Worker: every build's bundle
    // would otherwise start one at load.
    expect(spawn).not.toHaveBeenCalled();
  });

  it("makes one, and opens the database once, whatever asks and however often", async () => {
    const { core, worker, spawn } = harness();

    // A gate mounted twice by StrictMode: subscribe, ask, unsubscribe, subscribe, ask — and then
    // a face's worth of queries behind it.
    const stopFirst = core.listen("startup:changed", () => {});
    void status(core);
    stopFirst();
    core.listen("startup:changed", () => {});
    void status(core);
    void core.call("list_sets").catch(() => {});
    void core.call("deck_list").catch(() => {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(worker.messages.filter((message) => message.kind === "open")).toEqual([
      { kind: "open", directory: OPFS_DIRECTORY },
    ]);
    expect(OPFS_DIRECTORY).toBe("mtg-grimoire");
  });
});

describe("the startup gate, answered from the open", () => {
  it("is loading until the Worker reports, and never reaches the engine to say so", async () => {
    const { core, worker } = harness();
    expect(await status(core)).toEqual({ state: "loading" });
    expect(await status(core)).toEqual({ state: "loading" });
    // The open, and no `startup_status` call behind it.
    expect(worker.messages).toEqual([{ kind: "open", directory: "mtg-grimoire" }]);
  });

  it("is ready once the database opened, and says so on the event once", async () => {
    const { core, worker } = harness();
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));

    worker.say({ kind: "opened", opened: READY });
    // A second `open` is answered with the first's answer (`engine.ts`), so `opened` can arrive
    // twice. The state moves once.
    worker.say({ kind: "opened", opened: READY });

    expect(await status(core)).toEqual({ state: "ready" });
    expect(heard).toEqual([{ state: "ready" }]);
  });

  it("fails one held call whose post throws, and still sends the rest and opens the gate", async () => {
    const { core, worker } = harness();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      if (message.kind === "call" && message.command === "uncloneable") {
        throw new Error("could not be cloned");
      }
      post(message, transfer);
    };
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));

    // Two calls held behind the open; the first cannot be posted when the open lands.
    const refused = core.call("uncloneable");
    void core.call("deck_list");
    worker.say({ kind: "opened", opened: READY });

    await expect(refused).rejects.toBe("could not be cloned");
    expect(worker.messages[worker.messages.length - 1]).toMatchObject({ command: "deck_list" });
    expect(heard).toEqual([{ state: "ready" }]);
  });

  it("tells a second tab so in a sentence, and that a reload can cure it", async () => {
    const { core, worker } = harness();
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));

    worker.say({ kind: "opened", opened: { kind: "already-open" } });

    const told = { state: "failed", message: ALREADY_OPEN, reload: true };
    expect(await status(core)).toEqual(told);
    expect(heard).toEqual([told]);
    // Written for a reader: what happened and what to do, with no code and no stack.
    expect(ALREADY_OPEN).toMatch(/already open in another tab/);
    expect(ALREADY_OPEN).toMatch(/reload this one/);
  });

  it("offers a reload for an engine that never loaded, with what the browser said", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({
      kind: "opened",
      opened: { kind: "unloaded", message: "TypeError: Failed to fetch" },
    });
    const answered = await status(core);
    expect(answered).toMatchObject({ state: "failed", reload: true });
    expect(answered).toMatchObject({
      message: expect.stringMatching(
        /could not load its card engine[\s\S]*TypeError: Failed to fetch/,
      ),
    });
  });

  it("passes the engine's own failure on as it is, and offers no reload for it", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: { kind: "failed", message: "The pool would not open." } });
    // No `reload` key at all: a database that would not open will not open the second time.
    expect(await status(core)).toEqual({ state: "failed", message: "The pool would not open." });
  });

  it("never moves again once it has settled", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });
    worker.say({ kind: "opened", opened: { kind: "already-open" } });
    worker.crash("late");
    expect(await status(core)).toEqual({ state: "ready" });
  });
});

describe("a call through the web core", () => {
  it("is held while the database opens and sent, in order, when it has", async () => {
    const { core, worker } = harness();
    const sets = core.call("list_sets");
    const decks = core.call("deck_get", { id: 4 });
    // Queued, not refused and not sent: the Worker has heard `open` and nothing else.
    expect(worker.messages).toHaveLength(1);

    worker.say({ kind: "opened", opened: READY });
    expect(worker.messages.slice(1)).toEqual([
      { kind: "call", id: 1, command: "list_sets" },
      { kind: "call", id: 2, command: "deck_get", args: { id: 4 } },
    ]);

    worker.say({ kind: "ok", id: 1, result: ["lea"] });
    worker.say({ kind: "ok", id: 2, result: { name: "Burn" } });
    expect(await sets).toEqual(["lea"]);
    expect(await decks).toEqual({ name: "Burn" });
  });

  it("goes straight to the Worker once the database is open", () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });
    void core.call("list_sets");
    expect(worker.messages[worker.messages.length - 1]).toEqual({
      kind: "call",
      id: 1,
      command: "list_sets",
    });
  });

  it("matches an answer to its call by id, not by the order answers arrive in", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });

    const slow = core.call("search_cards", { text: "the" });
    const fast = core.call("list_sets");
    // The later call is answered first.
    worker.say({ kind: "ok", id: 2, result: "sets" });
    worker.say({ kind: "ok", id: 1, result: "cards" });

    expect(await slow).toBe("cards");
    expect(await fast).toBe("sets");
  });

  it("rejects with the engine's sentence as a string, as a Tauri command does", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });

    const call = core.call("deck_get", { id: 999 });
    worker.say({ kind: "err", id: 1, message: "No such deck." });
    // The bare string, not an `Error` wrapping it: the pages read a rejection with `ipcError`,
    // and some compare it to a sentence.
    await expect(call).rejects.toBe("No such deck.");
  });

  it("rejects what was waiting on a database that did not open, and whatever is asked after", async () => {
    const { core, worker } = harness();
    const waiting = core.call("list_sets");
    worker.say({ kind: "opened", opened: { kind: "already-open" } });

    await expect(waiting).rejects.toBe(ALREADY_OPEN);
    await expect(core.call("deck_list")).rejects.toBe(ALREADY_OPEN);
    // Nothing was sent to a Worker with no database behind it.
    expect(worker.messages).toHaveLength(1);
  });

  it("hands a byte payload over rather than copying it, with its headers as the arguments", () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });

    const frame = new Uint8Array([9, 8, 7]);
    void core.call("scanner_frame", frame, { headers: { "x-scanner-options": "{}" } });

    expect(worker.posted[worker.posted.length - 1]).toEqual({
      message: {
        kind: "call",
        id: 1,
        command: "scanner_frame",
        args: { "x-scanner-options": "{}" },
        body: frame,
      },
      transfer: [frame.buffer],
    });
  });
});

describe("an event through the web core", () => {
  it("reaches every subscriber of its name with the payload, and none after unsubscribing", () => {
    const { core, worker } = harness();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stop = core.listen("sync:progress", (payload) => first.push(payload));
    core.listen("sync:progress", (payload) => second.push(payload));
    core.listen("combos:progress", () => first.push("the wrong event"));

    worker.say({ kind: "event", event: "sync:progress", payload: { done: 3 } });
    // Synchronous: gone by the time the call returns, with nothing to await.
    stop();
    worker.say({ kind: "event", event: "sync:progress", payload: { done: 4 } });

    // The payload itself, not an envelope around it.
    expect(first).toEqual([{ done: 3 }]);
    expect(second).toEqual([{ done: 3 }, { done: 4 }]);
  });
});

describe("a Worker that died", () => {
  it("fails the gate with a reload when it dies before the database opened", async () => {
    const { core, worker } = harness();
    const waiting = core.call("list_sets");
    // A Worker whose script never loaded fires `error` with no message at all.
    worker.crash(undefined);

    const answered = await status(core);
    expect(answered).toMatchObject({ state: "failed", reload: true });
    expect(answered).toMatchObject({ message: expect.stringMatching(/card engine stopped/) });
    await expect(waiting).rejects.toMatch(/card engine stopped/);
  });

  it("rejects every call in flight when it dies later, and every call after", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY });
    const one = core.call("search_cards");
    const two = core.call("list_sets");

    // A trap in the engine's own task queue names no call, so no `err` is coming for either.
    worker.crash("RuntimeError: unreachable");

    await expect(one).rejects.toMatch(/card engine stopped[\s\S]*RuntimeError: unreachable/);
    await expect(two).rejects.toMatch(/card engine stopped/);
    // And nothing more is sent to it: an answer from that heap is not one to wait for.
    const sent = worker.messages.length;
    await expect(core.call("deck_list")).rejects.toMatch(/Reload to start it again/);
    expect(worker.messages).toHaveLength(sent);
  });

  it("says so when there is no Worker to make at all", async () => {
    const core = createWebCore(() => {
      throw new Error("Worker is not defined");
    });
    expect(await status(core)).toMatchObject({
      state: "failed",
      reload: true,
      message: expect.stringMatching(/Worker is not defined/),
    });
  });
});
