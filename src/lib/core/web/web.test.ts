import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheCleared, StartupStatus } from "@/lib/ipc";
import type { StorageCleared, StoragePersistence } from "../hostStorage";
import {
  HOST_UPDATE,
  HOST_UPDATE_APPLY,
  HOST_UPDATE_CHANGED,
  type HostUpdate,
} from "../hostUpdate";
import type { Heard } from "./sw/bridge";
import { PICTURE_CACHE, type CachesLike } from "./sw/pictures";
import type { Registration, WaitingWorker, WorkerContainer } from "./update";
import {
  ALREADY_OPEN,
  createWebCore,
  OPFS_DIRECTORY,
  type Browser,
  type WorkerPort,
  NOTHING_WAITING,
  STILL_HELD,
} from "./index";
import { DATABASE_LOCK, RETRY_BOUND_MS, type LockManagerLike } from "./holder";
import type { FromWorker, Opening, ToWorker } from "./protocol";
import {
  CLEARED_KEY,
  CLEARED_LINE,
  CLEARED_TITLE,
  HELD_KEY,
  PERSIST_KEY,
  type KeyStore,
} from "./storage";

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

  terminated = false;
  terminate(): void {
    this.terminated = true;
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

/** A `localStorage` the test owns: what the host wrote down, readable as a plain object. */
function fakeStore(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  const store: KeyStore = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
    removeItem: (key) => void kept.delete(key),
  };
  return { store, kept };
}

/** The clock every record below is stamped by: 2026-10-04T12:00:00Z. */
const NOW = Date.UTC(2026, 9, 4, 12);

/**
 * A core over one fake Worker, and a count of how many it asked for.
 *
 * **Its browser is the test's own** — a store nothing else writes to, a clock that does not move
 * and, unless a test hands one in, no `navigator.storage` at all — so no test here reads what
 * another left in jsdom's `localStorage`.
 */
function harness(browser: Partial<Browser> = {}) {
  const worker = new FakeWorker();
  const spawn = vi.fn(() => worker);
  const { store, kept } = fakeStore();
  const core = createWebCore(spawn, OPFS_DIRECTORY, {
    store,
    now: () => NOW,
    // No timer of the suite's is left running by a test that says `already-open` in passing.
    after: () => undefined,
    ...browser,
  });
  return { core, worker, spawn, kept };
}

const status = (core: ReturnType<typeof createWebCore>) =>
  core.call<StartupStatus>("startup_status");

/** `navigator.locks`, with the database's lock free or held by another document. */
function fakeLocks(heldElsewhere = false) {
  const state = { asked: [] as string[], held: heldElsewhere, released: false };
  const locks: LockManagerLike = {
    request(name, _options, callback) {
      state.asked.push(name);
      if (state.held) return Promise.resolve(callback(null));
      state.held = true;
      return Promise.resolve(callback({})).then(() => {
        state.held = false;
        state.released = true;
      });
    },
  };
  return { locks, state };
}

/** Let the lock's answer land. */
const asked = () => new Promise<void>((done) => setTimeout(done, 0));

/**
 * A second tab, as a page finds one: another living document holds the database's lock. No
 * Worker is started there, so the harness's `worker` hears nothing and is asked nothing.
 */
async function secondTab(browser: Partial<Browser> = {}) {
  const tab = harness({ locks: fakeLocks(true).locks, ...browser });
  void status(tab.core);
  await asked();
  return tab;
}

/** What the core said on the console. Caught, so an opened database does not print in the run. */
let said: ReturnType<typeof vi.spyOn>;
let warned: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  said = vi.spyOn(console, "info").mockImplementation(() => undefined);
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  said.mockRestore();
  warned.mockRestore();
});

describe("the web core's Worker", () => {
  it("says which journal each file got when the database opens, and nothing when it does not", async () => {
    await secondTab();
    const broken = harness();
    void status(broken.core);
    broken.worker.say({ kind: "opened", opened: { kind: "failed", message: "no" }, existed: true });
    expect(said).not.toHaveBeenCalled();

    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
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

    worker.say({ kind: "opened", opened: READY, existed: true });
    // A second `open` is answered with the first's answer (`engine.ts`), so `opened` can arrive
    // twice. The state moves once.
    worker.say({ kind: "opened", opened: READY, existed: true });

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
    worker.say({ kind: "opened", opened: READY, existed: true });

    await expect(refused).rejects.toBe("could not be cloned");
    expect(worker.messages[worker.messages.length - 1]).toMatchObject({ command: "deck_list" });
    expect(heard).toEqual([{ state: "ready" }]);
  });

  it("tells a second tab so in a sentence, and that a reload can cure it", async () => {
    // A second tab is one whose neighbour holds the database's lock — `holder.ts` — and it is
    // told from that alone.
    const { core } = harness({ locks: fakeLocks(true).locks });
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    await asked();

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
      existed: null,
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
    worker.say({
      kind: "opened",
      opened: { kind: "failed", message: "The pool would not open." },
      existed: true,
    });
    // No `reload` key at all: a database that would not open will not open the second time.
    expect(await status(core)).toEqual({ state: "failed", message: "The pool would not open." });
  });

  it("is not moved by a second word about the open, whichever way it settled", async () => {
    const opened = harness();
    void status(opened.core);
    opened.worker.say({ kind: "opened", opened: READY, existed: true });
    opened.worker.say({ kind: "opened", opened: { kind: "already-open" }, existed: true });
    expect(await status(opened.core)).toEqual({ state: "ready" });
    // Nor is an open database's Worker ended for it: asking again is for a gate still loading.
    expect(opened.worker.terminated).toBe(false);

    // And never back: a database that did not open is not opened by a later `ready`.
    const refused = harness();
    void status(refused.core);
    const failed: Opening = { kind: "failed", message: "The pool would not open." };
    refused.worker.say({ kind: "opened", opened: failed, existed: true });
    refused.worker.say({ kind: "opened", opened: READY, existed: true });
    expect(await status(refused.core)).toMatchObject({ state: "failed", message: failed.message });
  });
});

describe("a call through the web core", () => {
  it("is held while the database opens and sent, in order, when it has", async () => {
    const { core, worker } = harness();
    const sets = core.call("list_sets");
    const decks = core.call("deck_get", { id: 4 });
    // Queued, not refused and not sent: the Worker has heard `open` and nothing else.
    expect(worker.messages).toHaveLength(1);

    worker.say({ kind: "opened", opened: READY, existed: true });
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
    worker.say({ kind: "opened", opened: READY, existed: true });
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
    worker.say({ kind: "opened", opened: READY, existed: true });

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
    worker.say({ kind: "opened", opened: READY, existed: true });

    const call = core.call("deck_get", { id: 999 });
    worker.say({ kind: "err", id: 1, message: "No such deck." });
    // The bare string, not an `Error` wrapping it: the pages read a rejection with `ipcError`,
    // and some compare it to a sentence.
    await expect(call).rejects.toBe("No such deck.");
  });

  it("rejects what was waiting on a database that did not open, and whatever is asked after", async () => {
    const { core, worker, spawn } = harness({ locks: fakeLocks(true).locks });
    const waiting = core.call("list_sets");

    await expect(waiting).rejects.toBe(ALREADY_OPEN);
    await expect(core.call("deck_list")).rejects.toBe(ALREADY_OPEN);
    // Nothing was sent to a Worker, and none was made: there is no database behind this page.
    expect(spawn).not.toHaveBeenCalled();
    expect(worker.messages).toHaveLength(0);

    // The same for a Worker that did open nothing: its one message is the open it was asked for.
    const broken = harness();
    const held = broken.core.call("list_sets");
    broken.worker.say({ kind: "opened", opened: { kind: "failed", message: "no" }, existed: true });
    await expect(held).rejects.toBe("no");
    expect(broken.worker.messages).toHaveLength(1);
  });

  it("hands a byte payload over rather than copying it, with its headers as the arguments", () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });

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

  it("is not heard by a subscriber that arrives after it, and is not kept for one", () => {
    // What Tauri does with an event nobody is listening for, and what every reader of one is
    // written against: `sync_status` is the half that survives a face mounting late.
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "event", event: "sync:progress", payload: { phase: "checking" } });

    const late: unknown[] = [];
    core.listen("sync:progress", (payload) => late.push(payload));
    expect(late).toEqual([]);

    worker.say({ kind: "event", event: "sync:progress", payload: { phase: "downloading" } });
    expect(late).toEqual([{ phase: "downloading" }]);
  });

  it("still reaches the subscribers behind one that threw", () => {
    // One message fans out to every handler of the name: the ribbon's line, the invalidation
    // and the first-run screen all hang off one `sync:progress`.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { core, worker } = harness();
    const heard: unknown[] = [];
    core.listen("sync:progress", () => {
      throw new Error("a page's own bug");
    });
    core.listen("sync:progress", (payload) => heard.push(payload));

    worker.say({ kind: "event", event: "sync:progress", payload: { phase: "done" } });
    // And the next message is still read: the throw did not climb out of the Worker's listener.
    worker.say({ kind: "event", event: "sync:progress", payload: { phase: "checking" } });

    expect(heard).toEqual([{ phase: "done" }, { phase: "checking" }]);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

/**
 * `navigator.storage.persist()` — recorded and never trusted (the light-app spec §6), and asked
 * **again while the answer is no, at most once a week**: the spec's "asked once" froze a first
 * visit's `false` for good, which `storage.ts`'s `settlePersistence` has in full. A reload is a
 * second core over the first one's store, and the clock is the harness's, so "a week later" is a
 * number handed in and nothing here waits.
 */
describe("asking the browser to keep its storage", () => {
  const DAY = 86_400_000;
  /** The record as `storage_persistence` answers it, once anything this launch began has landed. */
  const persistence = async (core: ReturnType<typeof createWebCore>) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return core.call<StoragePersistence | null>("storage_persistence");
  };
  const recorded = (record: StoragePersistence) => ({ [PERSIST_KEY]: JSON.stringify(record) });

  /** A page load over `store` at `now`: the database opens, and the launch looks. */
  function launch(browser: Partial<Browser>) {
    const loaded = harness(browser);
    void status(loaded.core);
    loaded.worker.say({ kind: "opened", opened: READY, existed: true });
    return loaded;
  }

  it("asks once the database has opened, writes the answer down and says it was a fresh ask", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    const { core, worker, kept } = harness({ storage: { persist } });
    void status(core);
    // Not at import, not at the first call: there is nothing to keep until a database is open.
    expect(persist).not.toHaveBeenCalled();

    worker.say({ kind: "opened", opened: READY, existed: false });

    expect(await persistence(core)).toEqual({ askedAt: NOW, granted: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kept.get(PERSIST_KEY) ?? "null")).toEqual({ askedAt: NOW, granted: true });
    // Beside the open's own line, where a bug report can carry both.
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: persistent storage granted, asked 2026-10-04T12:00:00.000Z " +
        "(asked on this launch)",
    );
  });

  it("does not ask again within a week of a no, and says the answer is the record's", async () => {
    const { store } = fakeStore(recorded({ askedAt: NOW - 6 * DAY, granted: false }));
    const persist = vi.fn(() => Promise.resolve(true));
    const { core } = launch({ store, storage: { persist } });

    // The recorded answer, with the day it was given — a browser that prompts is not prompted
    // at every launch.
    expect(await persistence(core)).toEqual({ askedAt: NOW - 6 * DAY, granted: false });
    expect(persist).not.toHaveBeenCalled();
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: persistent storage not granted, asked 2026-09-28T12:00:00.000Z " +
        "(from the record)",
    );
  });

  /**
   * **The case "asked once" got wrong.** Chromium answers from what it knows at the call — a
   * first visit to a site that is neither installed nor bookmarked is a `false` — and a reader
   * who installs the app afterwards would be granted the next time anyone asked.
   */
  it("asks again a week after a no, and takes the yes it is then given", async () => {
    const { store, kept } = fakeStore(recorded({ askedAt: NOW - 7 * DAY, granted: false }));
    const persist = vi.fn(() => Promise.resolve(true));
    const { core } = launch({ store, storage: { persist } });

    expect(await persistence(core)).toEqual({ askedAt: NOW, granted: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kept.get(PERSIST_KEY) ?? "null")).toEqual({ askedAt: NOW, granted: true });
  });

  it("never asks again once the browser has said yes", async () => {
    const { store } = fakeStore(recorded({ askedAt: NOW - 400 * DAY, granted: true }));
    const persist = vi.fn(() => Promise.resolve(false));
    const { core } = launch({ store, storage: { persist } });

    expect(await persistence(core)).toEqual({ askedAt: NOW - 400 * DAY, granted: true });
    expect(persist).not.toHaveBeenCalled();
  });

  /**
   * Storage can become persistent with no ask from this app — an install does it. `persisted()`
   * asks nobody and prompts nothing, so every launch reads it first.
   */
  it("records storage the browser made persistent by itself, without asking", async () => {
    const { store, kept } = fakeStore(recorded({ askedAt: NOW - 2 * DAY, granted: false }));
    const persist = vi.fn(() => Promise.resolve(true));
    const persisted = vi.fn(() => Promise.resolve(true));
    const { core } = launch({ store, storage: { persist, persisted } });

    // Granted, and the date is still the last time this app asked: it did not ask today.
    expect(await persistence(core)).toEqual({ askedAt: NOW - 2 * DAY, granted: true });
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.parse(kept.get(PERSIST_KEY) ?? "null")).toMatchObject({ granted: true });
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: persistent storage granted, asked 2026-10-02T12:00:00.000Z " +
        "(the browser says so, unasked)",
    );

    // And a browser that was never asked at all has no date to give.
    const fresh = launch({ storage: { persisted } });
    expect(await persistence(fresh.core)).toEqual({ askedAt: null, granted: true });
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: persistent storage granted, never asked (the browser says so, unasked)",
    );
  });

  it("believes a browser that says its storage is no longer persistent over a yes on record", async () => {
    const { store, kept } = fakeStore(recorded({ askedAt: NOW - 2 * DAY, granted: true }));
    const persist = vi.fn(() => Promise.resolve(true));
    const { core } = launch({
      store,
      storage: { persist, persisted: () => Promise.resolve(false) },
    });

    // Recorded, not trusted — and not asked again inside the week either.
    expect(await persistence(core)).toEqual({ askedAt: NOW - 2 * DAY, granted: false });
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.parse(kept.get(PERSIST_KEY) ?? "null")).toMatchObject({ granted: false });
  });

  /**
   * A browser that asks by prompting answers when the reader does — which may be never. The
   * week's ask is stamped before the browser is asked, so an unanswered prompt is not a prompt
   * at every launch, and nothing that reads the record waits on a reader.
   */
  it("stamps the ask before it is answered, and does not wait on a reader to say so", async () => {
    const persist = vi.fn(() => new Promise<boolean>(() => undefined));
    const first = launch({ storage: { persist } });
    const store: KeyStore = {
      getItem: (key) => first.kept.get(key) ?? null,
      setItem: (key, value) => void first.kept.set(key, value),
      removeItem: (key) => void first.kept.delete(key),
    };

    // Answered now, while the prompt is still up: asked, and not granted yet.
    expect(await persistence(first.core)).toEqual({ askedAt: NOW, granted: false });
    expect(persist).toHaveBeenCalledTimes(1);

    // The next launch, the prompt never answered: this week's ask has been made.
    const next = launch({ store, storage: { persist }, now: () => NOW + DAY });
    expect(await persistence(next.core)).toEqual({ askedAt: NOW, granted: false });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("asks once however many times the Worker says the database opened", async () => {
    const persist = vi.fn(() => Promise.resolve(false));
    const { core, worker } = launch({ storage: { persist } });
    worker.say({ kind: "opened", opened: READY, existed: true });

    expect(await persistence(core)).toEqual({ askedAt: NOW, granted: false });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("records a browser that threw as one that did not say yes — and asks it again in a week", async () => {
    const { store, kept } = fakeStore();
    const persist = vi.fn(() => Promise.reject(new Error("SecurityError")));
    const { core } = launch({ store, storage: { persist } });
    expect(await persistence(core)).toEqual({ askedAt: NOW, granted: false });
    expect(kept.has(PERSIST_KEY)).toBe(true);

    const later = launch({ store, storage: { persist }, now: () => NOW + 7 * DAY });
    await persistence(later.core);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("says so, and writes nothing, in a browser with no way to ask", async () => {
    const { core, kept } = launch({ storage: {} });

    expect(await persistence(core)).toBeNull();
    // Nothing written, so a browser that gains the method starts clean.
    expect(kept.has(PERSIST_KEY)).toBe(false);
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: persistent storage not asked — this browser has no way to ask",
    );
  });

  it("asks nothing for a database that did not open", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    const persisted = vi.fn(() => Promise.resolve(true));
    const { core } = await secondTab({ storage: { persist, persisted } });

    // A second tab keeps nothing of its own; the first tab is the one that looked.
    expect(await persistence(core)).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
  });

  it("opens the database all the same in a browser whose storage cannot be named", async () => {
    const refusing: KeyStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const persist = vi.fn(() => Promise.resolve(true));
    const { core, worker } = harness({ store: refusing, storage: { persist } });
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: false });

    expect(await status(core)).toEqual({ state: "ready" });
    // Asked, and remembered for the life of the page — which is all there is to remember it in.
    expect(await persistence(core)).toEqual({ askedAt: NOW, granted: true });
  });
});

/**
 * **Storage cleared under the app** (the light-app spec §6: "the corpus can vanish while the
 * shell survives"). A browser can take back what a site stored while the page still opens; the
 * engine then creates an empty database and downloads the card data again by itself — and a
 * silent empty app reads as a bug, or as a first run that will bring a collection back.
 *
 * Found by comparing two things that are evicted apart: a mark in `localStorage` saying this
 * browser holds a database, and whether OPFS held the database's folder before this open.
 */
describe("storage cleared under the app", () => {
  const cleared = (core: ReturnType<typeof createWebCore>) =>
    core.call<StorageCleared | null>("storage_cleared");
  const HELD = { [HELD_KEY]: JSON.stringify({ at: NOW - 86_400_000 }) };

  /** A page load: a new core over a store that outlives it, told what the Worker found. */
  function load(store: KeyStore, existed: boolean | null) {
    const loaded = harness({ store });
    void status(loaded.core);
    loaded.worker.say({ kind: "opened", opened: READY, existed });
    return loaded.core;
  }

  it("says nothing on a first run, and remembers that a database is now held", async () => {
    const { store, kept } = fakeStore();
    expect(await cleared(load(store, false))).toBeNull();
    expect(JSON.parse(kept.get(HELD_KEY) ?? "null")).toEqual({ at: NOW });
    expect(warned).not.toHaveBeenCalled();
  });

  it("says nothing on an ordinary launch", async () => {
    const { store, kept } = fakeStore(HELD);
    expect(await cleared(load(store, true))).toBeNull();
    // The mark is the day the database was first held, not the last time it was opened.
    expect(JSON.parse(kept.get(HELD_KEY) ?? "null")).toEqual({ at: NOW - 86_400_000 });
  });

  it("starts remembering a database that is older than its mark", async () => {
    // One opened by a build before this, or whose mark alone was lost.
    const { store, kept } = fakeStore();
    expect(await cleared(load(store, true))).toBeNull();
    expect(kept.has(HELD_KEY)).toBe(true);
  });

  it("tells a reader, in the host's own words, when a database it held is gone", async () => {
    const { store } = fakeStore(HELD);
    const answer = await cleared(load(store, false));

    expect(answer).toEqual({ at: NOW, title: CLEARED_TITLE, lines: expect.any(Array) });
    // What happened, what is being rebuilt by itself, and what is not coming back — in that
    // order, and each for a reader rather than as a code.
    expect(answer?.title).toBe("Your browser cleared MTG Grimoire's saved data");
    expect(answer?.lines).toHaveLength(3);
    expect(answer?.lines[0]).toMatch(/Browsers can remove what a site has stored/);
    expect(answer?.lines[1]).toBe("The card data downloads again by itself.");
    expect(answer?.lines[2]).toMatch(/collection, wishlist and decks/);
    expect(answer?.lines[2]).toMatch(/nothing to restore it from/);
    expect(answer?.lines[2]).toMatch(/import those files again/);
    // And on the console, where a bug report can carry it — with what the open made of it.
    expect(warned).toHaveBeenCalledWith(`${CLEARED_LINE} — a new, empty one was created`);
    expect(CLEARED_LINE).toBe(
      "MTG Grimoire: this browser cleared the app's storage since the database was last " +
        "opened here",
    );
  });

  it("goes on saying it across reloads until it is dismissed, and never after", async () => {
    const { store, kept } = fakeStore(HELD);
    await cleared(load(store, false));

    // A reader who reloads because the app looks empty is still told why. The folder exists
    // now — the open that found it gone created a new one — so nothing new is noted.
    const again = load(store, true);
    expect(await cleared(again)).toMatchObject({ at: NOW, title: CLEARED_TITLE });

    expect(await again.call("storage_cleared_dismiss")).toBeNull();
    expect(await cleared(again)).toBeNull();
    expect(kept.has(CLEARED_KEY)).toBe(false);
    expect(await cleared(load(store, true))).toBeNull();
  });

  it("tells a second clearing as a new occurrence", async () => {
    const { store } = fakeStore(HELD);
    const first = load(store, false);
    await first.call("storage_cleared_dismiss");
    expect(await cleared(first)).toBeNull();

    // The mark was renewed for the database the first clearing left, so its loss is seen too.
    expect(await cleared(load(store, false))).toMatchObject({ title: CLEARED_TITLE });
  });

  it("says nothing where the Worker could not ask what the browser held", async () => {
    const { store } = fakeStore(HELD);
    expect(await cleared(load(store, null))).toBeNull();
  });

  /**
   * **The likeliest way a clearing is met, and the one a note taken only on success misses.**
   * The pool's install creates the folder before anything can fail. So: the browser evicts; the
   * next open makes a folder and then fails — out of quota, a trap, the tab closed mid-open; and
   * the launch after that finds a folder beside the mark and looks perfectly ordinary. The
   * clearing is recorded by the open that saw it, whatever became of that open, and waits for a
   * launch that gets far enough to draw it.
   */
  it("still tells it when the open that found the database gone then failed", async () => {
    const { store, kept } = fakeStore(HELD);

    // Launch one: no folder, a mark — and the open fails after making the folder.
    const failed = harness({ store });
    void status(failed.core);
    failed.worker.say({
      kind: "opened",
      opened: { kind: "failed", message: "The pool would not open." },
      existed: false,
    });
    expect(await status(failed.core)).toMatchObject({ state: "failed" });
    expect(kept.has(CLEARED_KEY)).toBe(true);
    expect(warned).toHaveBeenCalledWith(`${CLEARED_LINE} — and a new one could not be opened`);
    // No database opened, so the mark is not renewed: it still says what was held before.
    expect(JSON.parse(kept.get(HELD_KEY) ?? "null")).toEqual({ at: NOW - 86_400_000 });

    // Launch two: the folder is there now, the mark is there — nothing new to see, and the
    // reader is told all the same.
    const answer = await cleared(load(store, true));
    expect(answer).toMatchObject({ at: NOW, title: CLEARED_TITLE });
  });

  // A second tab is not on this list any more: it is told by the lock and starts no Worker, so
  // it never looks at the folder — and the tab that holds the database is the one that did.
  it.each<[string, Opening]>([
    ["an engine that never loaded", { kind: "unloaded", message: "TypeError: Failed to fetch" }],
    ["a database that would not open", { kind: "failed", message: "The pool would not open." }],
  ])("records it for %s too, and leaves the mark alone", async (_name, opened) => {
    const { store, kept } = fakeStore(HELD);
    const { core, worker } = harness({ store });
    void status(core);
    worker.say({ kind: "opened", opened, existed: false });
    expect(await status(core)).toMatchObject({ state: "failed" });

    // The folder was gone when this page looked, whoever goes on to open a database.
    expect(kept.has(CLEARED_KEY)).toBe(true);
    expect(JSON.parse(kept.get(HELD_KEY) ?? "null")).toEqual({ at: NOW - 86_400_000 });
  });

  it("writes no mark for a first run whose database did not open", async () => {
    // Nothing is held, so nothing says so — or the next launch's empty folder would be told
    // as a clearing of a database that never was.
    const { store, kept } = fakeStore();
    const { core, worker } = harness({ store });
    void status(core);
    worker.say({
      kind: "opened",
      opened: { kind: "failed", message: "The pool would not open." },
      existed: false,
    });
    expect(await status(core)).toMatchObject({ state: "failed" });

    expect(kept.has(HELD_KEY)).toBe(false);
    expect(kept.has(CLEARED_KEY)).toBe(false);
    expect(await cleared(load(store, true))).toBeNull();
  });

  it("waits for the open rather than answering before it is known what the open found", async () => {
    const { store } = fakeStore(HELD);
    const { core, worker } = harness({ store });
    let answered: StorageCleared | null | undefined;
    void cleared(core).then((answer) => (answered = answer));
    await Promise.resolve();
    await Promise.resolve();
    // Asked while the database is opening: an answer now would be "nothing to say", and wrong.
    expect(answered).toBeUndefined();

    worker.say({ kind: "opened", opened: READY, existed: false });
    await vi.waitFor(() => expect(answered).toMatchObject({ title: CLEARED_TITLE }));
    // Answered by the host and never sent to the engine, whose table has no such command.
    expect(worker.messages).toEqual([{ kind: "open", directory: "mtg-grimoire" }]);
  });

  it("is still answered by a page whose engine has since stopped", async () => {
    const { store } = fakeStore(HELD);
    const { core, worker } = harness({ store });
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: false });
    worker.crash("RuntimeError: unreachable");

    await expect(core.call("deck_list")).rejects.toMatch(/card engine stopped/);
    // About the browser and not the engine: true of a page whatever became of its Worker.
    expect(await cleared(core)).toMatchObject({ title: CLEARED_TITLE });
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
    worker.say({ kind: "opened", opened: READY, existed: true });
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

  /**
   * **The one move the gate makes after it opened.** From the Worker's `error` until a reload
   * there is no app behind the page, and that is said once, for the whole window — not left for
   * each page to find in a rejected read (a first-run bar that never moved again was the first
   * to find it, and it said nothing).
   */
  it("moves the gate from ready to failed, with a reload, and says so on the event", async () => {
    const { core, worker } = harness();
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    worker.say({ kind: "opened", opened: READY, existed: true });
    expect(heard).toEqual([{ state: "ready" }]);

    worker.crash("RuntimeError: unreachable");

    const told = {
      state: "failed",
      message: expect.stringMatching(/card engine stopped[\s\S]*RuntimeError: unreachable/),
      reload: true,
    };
    expect(heard).toEqual([{ state: "ready" }, told]);
    // The poll's half agrees with the event's: a gate mounted afterwards is told the same.
    expect(await status(core)).toEqual(heard[1]);
  });

  it("makes that move exactly once, however many times a dead Worker errors", async () => {
    const { core, worker } = harness();
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    worker.say({ kind: "opened", opened: READY, existed: true });
    const inFlight = core.call("search_cards");

    worker.crash("RuntimeError: unreachable");
    // A dead engine can go on raising `error`; the first is the news and the rest are not.
    worker.crash("RuntimeError: memory access out of bounds");
    worker.crash(undefined);

    expect(heard.map((next) => next.state)).toEqual(["ready", "failed"]);
    // The first error's sentence, on the gate and on every call: nothing later rewrote it.
    const first = heard[1];
    expect(first).toMatchObject({ message: expect.stringMatching(/RuntimeError: unreachable/) });
    expect(await status(core)).toBe(first);
    await expect(inFlight).rejects.toMatch(/RuntimeError: unreachable/);
    await expect(core.call("deck_list")).rejects.toMatch(/RuntimeError: unreachable/);
  });

  it("never comes back from it: a late word from the Worker opens nothing", async () => {
    const { core, worker } = harness();
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    worker.say({ kind: "opened", opened: READY, existed: true });
    worker.crash("RuntimeError: unreachable");
    const sent = worker.messages.length;

    // A Worker whose queue limps on after a trap can still post; none of it is an app again.
    worker.say({ kind: "opened", opened: READY, existed: true });

    expect(await status(core)).toMatchObject({ state: "failed", reload: true });
    expect(heard).toHaveLength(2);
    await expect(core.call("deck_list")).rejects.toMatch(/card engine stopped/);
    expect(worker.messages).toHaveLength(sent);
  });

  it("leaves a gate that had already failed with its own sentence", async () => {
    // An engine that never loaded: that is why there is no app here, and a Worker that then
    // also errors has nothing to add to it.
    const { core, worker } = harness();
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    worker.say({ kind: "opened", opened: { kind: "unloaded", message: "TypeError" }, existed: null });
    const told = await status(core);
    worker.crash("late");

    expect(told).toMatchObject({ state: "failed", reload: true });
    expect(await status(core)).toEqual(told);
    expect(heard).toHaveLength(1);

    // And one that would not open keeps offering no reload at all.
    const broken = harness();
    void status(broken.core);
    broken.worker.say({
      kind: "opened",
      opened: { kind: "failed", message: "The pool would not open." },
      existed: true,
    });
    broken.worker.crash("late");
    expect(await status(broken.core)).toEqual({
      state: "failed",
      message: "The pool would not open.",
    });
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

/**
 * A reload while the engine was busy left the new document on the second-tab screen with no
 * other tab open (reproduced 3 of 3 on 2026-10-04): the old document's Worker was still inside
 * the engine, still holding the pool, when the new one asked. `holder.ts` has the measurement.
 */
describe("a database another document may still hold", () => {
  const ELSEWHERE: Opening = { kind: "already-open" };

  /** A core that makes a new Worker per ask, over a clock and a timer the test owns. */
  function retrying(browser: Partial<Browser> = {}) {
    const workers: FakeWorker[] = [];
    const waits: { ms: number; run: () => void }[] = [];
    let now = NOW;
    const { store } = fakeStore();
    const core = createWebCore(
      () => {
        const made = new FakeWorker();
        workers.push(made);
        return made;
      },
      OPFS_DIRECTORY,
      { store, now: () => now, after: (ms, run) => void waits.push({ ms, run }), ...browser },
    );
    return {
      core,
      workers,
      waits,
      /** Let the wait before the next ask pass. */
      pass() {
        const wait = waits.shift();
        if (!wait) throw new Error("nothing is waiting");
        now += wait.ms;
        wait.run();
        return wait.ms;
      },
    };
  }

  it("tells a second tab at once, by the lock, and starts no engine there", async () => {
    const { locks, state } = fakeLocks(true);
    const { core, workers } = retrying({ locks });
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    await asked();

    const told = { state: "failed", message: ALREADY_OPEN, reload: true };
    expect(await status(core)).toEqual(told);
    expect(heard).toEqual([told]);
    expect(state.asked).toEqual([DATABASE_LOCK]);
    // No Worker: there is nothing one could add, and nothing for it to hold while it tried.
    expect(workers).toEqual([]);
    await expect(core.call("deck_list")).rejects.toBe(ALREADY_OPEN);
  });

  it("takes the lock before it starts the engine, and keeps it while the database is open", async () => {
    const { locks, state } = fakeLocks();
    const { core, workers } = retrying({ locks });
    void status(core);
    // Asked first: two tabs opened together must not each win one of the two.
    expect(workers).toEqual([]);
    await asked();
    expect(workers).toHaveLength(1);
    expect(workers[0].messages).toEqual([{ kind: "open", directory: OPFS_DIRECTORY }]);

    workers[0].say({ kind: "opened", opened: READY, existed: true });
    expect(await status(core)).toEqual({ state: "ready" });
    await asked();
    expect(state.held).toBe(true);
    expect(state.released).toBe(false);
  });

  it("asks again, with a fresh Worker, when the lock is its own and the pool is still held", async () => {
    const { locks } = fakeLocks();
    const { core, workers, waits, pass } = retrying({ locks });
    const heard: StartupStatus[] = [];
    core.listen<StartupStatus>("startup:changed", (next) => heard.push(next));
    const decks = core.call("deck_list");
    await asked();

    workers[0].say({ kind: "opened", opened: ELSEWHERE, existed: true });
    // To the gate it has not happened: still loading, nothing said, nothing refused.
    expect(await status(core)).toEqual({ state: "loading" });
    expect(heard).toEqual([]);
    // The refused Worker is ended — a Worker memoises its open — and the next is not made yet.
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(1);
    expect(waits.map(({ ms }) => ms)).toEqual([200]);

    pass();
    expect(workers).toHaveLength(2);
    expect(workers[1].messages).toEqual([{ kind: "open", directory: OPFS_DIRECTORY }]);
    workers[1].say({ kind: "opened", opened: READY, existed: true });

    expect(await status(core)).toEqual({ state: "ready" });
    expect(heard).toEqual([{ state: "ready" }]);
    // The call made before any of it is the second Worker's to answer.
    const sent = workers[1].messages.find((m) => m.kind === "call") as { id: number };
    expect(sent).toMatchObject({ command: "deck_list" });
    expect(workers[0].messages.some((m) => m.kind === "call")).toBe(false);
    workers[1].say({ kind: "ok", id: sent.id, result: [] });
    await expect(decks).resolves.toEqual([]);
    // Said once, beside the open's own line, where a bug report can carry it.
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: the database was still held by a page that had gone — opened on attempt 2, " +
        "200 ms after the first",
    );
  });

  it("waits a little longer each time, and never past its bound", async () => {
    const { locks } = fakeLocks();
    const { core, workers, pass, waits } = retrying({ locks });
    void status(core);
    await asked();

    const waited: number[] = [];
    while (workers[workers.length - 1]) {
      workers[workers.length - 1]?.say({ kind: "opened", opened: ELSEWHERE, existed: true });
      if (waits.length === 0) break;
      waited.push(pass());
    }
    expect(waited.slice(0, 4)).toEqual([200, 400, 800, 800]);
    expect(waited.reduce((sum, ms) => sum + ms, 0)).toBe(RETRY_BOUND_MS);
    expect((await status(core)).state).toBe("failed");
    // Every refused Worker was ended — the last one too, at the bound: it may have taken some of
    // the pool's handles before it met one it could not, and would keep them while the page stood.
    expect(workers.every((made) => made.terminated)).toBe(true);
  });

  it("says, when the bound is spent, that the database could not be opened — not that a tab is open", async () => {
    const { locks, state } = fakeLocks();
    const { core, workers, pass, waits } = retrying({ locks });
    const decks = core.call("deck_list");
    await asked();
    for (;;) {
      workers[workers.length - 1]?.say({ kind: "opened", opened: ELSEWHERE, existed: true });
      if (waits.length === 0) break;
      pass();
    }

    expect(await status(core)).toEqual({ state: "failed", message: STILL_HELD, reload: true });
    // This document holds the lock: there is no other tab for the sentence to name.
    expect(STILL_HELD).not.toMatch(/another tab/);
    expect(STILL_HELD).toMatch(/Reload to try again/);
    await expect(decks).rejects.toBe(STILL_HELD);
    // And it lets the lock go: a document with no database must not make the next one a "second".
    await asked();
    expect(state.released).toBe(true);
  });

  it("does not hear a Worker it has replaced", async () => {
    const { locks } = fakeLocks();
    const { core, workers, pass } = retrying({ locks });
    void status(core);
    await asked();
    workers[0].say({ kind: "opened", opened: ELSEWHERE, existed: true });
    pass();

    // The ended Worker's last words, and an `error` on its way down, are nobody's.
    workers[0].say({ kind: "opened", opened: READY, existed: true });
    workers[0].crash("terminated");
    expect(await status(core)).toEqual({ state: "loading" });

    workers[1].say({ kind: "opened", opened: READY, existed: true });
    expect(await status(core)).toEqual({ state: "ready" });
  });

  it("notes what the open found about storage once, from the answer that stood", async () => {
    const { locks } = fakeLocks();
    const { core, workers, pass } = retrying({ locks });
    void status(core);
    await asked();
    workers[0].say({ kind: "opened", opened: ELSEWHERE, existed: true });
    pass();
    workers[1].say({ kind: "opened", opened: READY, existed: true });
    // The first word about the open is noted once a page, and it is the open's, not the
    // refusal's: noted for the refusal, the database that then opened would never have been
    // asked about — its mark not written, its persistence never looked at.
    await expect(core.call("storage_persistence")).resolves.toBeNull();
    expect(said).toHaveBeenCalledWith(
      "MTG Grimoire: persistent storage not asked — this browser has no way to ask",
    );
    expect(warned).not.toHaveBeenCalled();
  });

  it("lets the lock go when the database will not open, so the next tab is told the real reason", async () => {
    const { locks, state } = fakeLocks();
    const { core, workers } = retrying({ locks });
    void status(core);
    await asked();
    workers[0].say({
      kind: "opened",
      opened: { kind: "failed", message: "user.db would not migrate." },
      existed: true,
    });
    expect(await status(core)).toEqual({ state: "failed", message: "user.db would not migrate." });
    await asked();
    expect(state.released).toBe(true);
    // **And its Worker is ended**, which is the half that makes the sentence above true: the
    // engine installs the pool before it opens a database, so a living Worker whose open failed
    // still holds every handle — and the next tab, finding the lock free and the pool taken,
    // would wait out its bound and be told the browser had not let go.
    expect(workers[0].terminated).toBe(true);
  });

  describe("in a browser with no Web Locks", () => {
    it("starts the engine in the same turn, as it always did", () => {
      const { core, workers } = retrying();
      void status(core);
      expect(workers).toHaveLength(1);
    });

    it("asks again all the same, and opens when the pool is let go", async () => {
      const { core, workers, pass } = retrying();
      void status(core);
      workers[0].say({ kind: "opened", opened: ELSEWHERE, existed: true });
      expect(await status(core)).toEqual({ state: "loading" });
      pass();
      workers[1].say({ kind: "opened", opened: READY, existed: true });
      expect(await status(core)).toEqual({ state: "ready" });
    });

    it("says the second-tab sentence when the bound is spent: it cannot tell, and that is the likelier", async () => {
      const { core, workers, pass, waits } = retrying();
      void status(core);
      for (;;) {
        workers[workers.length - 1]?.say({ kind: "opened", opened: ELSEWHERE, existed: true });
        if (waits.length === 0) break;
        pass();
      }
      expect(await status(core)).toEqual({ state: "failed", message: ALREADY_OPEN, reload: true });
    });

    it("is what a browser that refuses the lock gets, too", async () => {
      const refusing: LockManagerLike = {
        request: () => Promise.reject(new DOMException("denied", "SecurityError")),
      };
      const { core, workers, pass } = retrying({ locks: refusing });
      void status(core);
      await asked();
      expect(workers).toHaveLength(1);
      workers[0].say({ kind: "opened", opened: ELSEWHERE, existed: true });
      pass();
      workers[1].say({ kind: "opened", opened: READY, existed: true });
      expect(await status(core)).toEqual({ state: "ready" });
    });
  });
});

/** `navigator.serviceWorker`, as far as the page's half uses it — and the test is the browser. */
class FakeWorkers implements WorkerContainer {
  controller: unknown;
  registration = {
    active: null as FakeWaiting | null,
    waiting: null as FakeWaiting | null,
    installing: null as FakeWaiting | null,
    addEventListener: () => undefined,
    update: async () => undefined,
  };
  registered: string[] = [];
  started = 0;
  private changed: (() => void)[] = [];
  private messages: ((event: Heard) => void)[] = [];

  constructor(controller: unknown = {}) {
    this.controller = controller;
  }
  register(url: string): Promise<Registration> {
    this.registered.push(url);
    return Promise.resolve(this.registration);
  }
  addEventListener(type: "controllerchange", listener: () => void): void;
  addEventListener(type: "message", listener: (event: Heard) => void): void;
  addEventListener(type: string, listener: unknown): void {
    if (type === "controllerchange") this.changed.push(listener as () => void);
    else this.messages.push(listener as (event: Heard) => void);
  }
  startMessages(): void {
    this.started += 1;
  }
  /** The service worker asks this page something; what the page posted back. */
  ask(data: unknown): unknown[] {
    const replies: unknown[] = [];
    for (const listener of this.messages) {
      listener({ data, ports: [{ postMessage: (reply: unknown) => void replies.push(reply) }] });
    }
    return replies;
  }
  takeOver(): void {
    for (const listener of this.changed) listener();
  }
}

class FakeWaiting implements WaitingWorker {
  state = "installed";
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  addEventListener(): void {}
}

describe("the service worker's page half", () => {
  /** A core whose browser has a service worker container, and a page that counts its reloads. */
  function served(workers = new FakeWorkers(), browser: Partial<Browser> = {}) {
    const reload = vi.fn();
    const h = harness({ workers, page: { reload, onVisible: () => undefined }, ...browser });
    return { ...h, workers, reload };
  }

  it("is not started by building the core, and is started once however often it is used", async () => {
    const { core, workers } = served();
    expect(workers.registered).toEqual([]);
    void status(core);
    core.listen("startup:changed", () => {});
    void status(core);
    expect(workers.registered).toEqual(["/sw.js"]);
    expect(workers.started).toBe(1);
  });

  it("registers nothing in a browser — or a build — that has no worker to register", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    // And the host still answers its own commands about one: nothing waits, and a press for
    // nothing is refused in a sentence — so a control that greyed itself on it comes back.
    await expect(core.call(HOST_UPDATE)).resolves.toBeNull();
    await expect(core.call(HOST_UPDATE_APPLY)).rejects.toBe(NOTHING_WAITING);
    expect(NOTHING_WAITING).toBe("There is no newer version of MTG Grimoire waiting.");
  });

  it("refuses `host_update_apply` when the build has stopped waiting since the bar was drawn", async () => {
    const { core, worker } = served();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    await expect(core.call(HOST_UPDATE_APPLY)).rejects.toBe(NOTHING_WAITING);
  });

  it("answers the worker's ask for a picture's address from the engine's own command", async () => {
    const { core, worker, workers } = served();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });

    const replies = workers.ask({ kind: "grimoire:picture-source", path: "/display/abc/0" });
    const call = worker.messages.find((m) => m.kind === "call");
    expect(call).toMatchObject({ command: "card_image_source", args: { path: "/display/abc/0" } });

    const source = { kind: "uri", uri: "https://cards.scryfall.io/large/front/a/b/abc.webp?1" };
    worker.say({ kind: "ok", id: (call as { id: number }).id, result: source });
    await vi.waitFor(() => expect(replies).toEqual([{ kind: "source", source }]));
  });

  it("holds an ask made while the database is opening, and answers it once it has", async () => {
    const { core, worker, workers } = served();
    void status(core);
    const replies = workers.ask({ kind: "grimoire:picture-source", path: "/display/abc/0" });
    expect(worker.messages.filter((m) => m.kind === "call")).toEqual([]);

    worker.say({ kind: "opened", opened: READY, existed: true });
    const call = worker.messages.find((m) => m.kind === "call") as { id: number };
    worker.say({ kind: "ok", id: call.id, result: { kind: "unknown" } });
    await vi.waitFor(() =>
      expect(replies).toEqual([{ kind: "source", source: { kind: "unknown" } }]),
    );
  });

  it("refuses the ask at once in a second tab, so the worker does not wait on it", async () => {
    const { core, workers } = served(new FakeWorkers(), { locks: fakeLocks(true).locks });
    void status(core);
    await asked();
    const replies = workers.ask({ kind: "grimoire:picture-source", path: "/display/abc/0" });
    await vi.waitFor(() => expect(replies).toEqual([{ kind: "refused", message: ALREADY_OPEN }]));
  });

  it("answers `host_update` with its own words once a newer build waits, and says so as it changes", async () => {
    const { core, worker } = served();
    const heard: unknown[] = [];
    core.listen(HOST_UPDATE_CHANGED, (update) => heard.push(update));
    worker.say({ kind: "opened", opened: READY, existed: true });
    await expect(core.call(HOST_UPDATE)).resolves.toBeNull();

    // A newer build was already waiting when the registration answered.
    const second = served();
    second.workers.registration.waiting = new FakeWaiting();
    const said: unknown[] = [];
    second.core.listen(HOST_UPDATE_CHANGED, (update) => said.push(update));
    second.worker.say({ kind: "opened", opened: READY, existed: true });
    const update = await second.core.call<HostUpdate | null>(HOST_UPDATE);
    expect(update).toEqual({
      title: "A new version of MTG Grimoire is ready.",
      action: "Reload to update",
    });
    expect(said).toEqual([update]);
    expect(heard).toEqual([]);
  });

  it("tells the waiting build to take over only on `host_update_apply`, and reloads when it has", async () => {
    const { core, worker, workers, reload } = served();
    const waiting = new FakeWaiting();
    workers.registration.waiting = waiting;
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    await core.call(HOST_UPDATE);
    expect(waiting.posted).toEqual([]);

    await expect(core.call(HOST_UPDATE_APPLY)).resolves.toBeNull();
    expect(waiting.posted).toEqual([{ kind: "grimoire:skip-waiting" }]);
    expect(reload).not.toHaveBeenCalled();

    workers.takeOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload a second tab when the first one's press takes the page over", async () => {
    // The tab that pressed reloads and opens the database again; this one is a boot screen with
    // a Reload link, and a reload of its own would race the other for the database.
    const { core, workers, reload } = served(new FakeWorkers(), { locks: fakeLocks(true).locks });
    void status(core);
    await asked();
    expect(await status(core)).toMatchObject({ state: "failed", message: ALREADY_OPEN });
    workers.takeOver();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload a tab that is still opening its database, either", async () => {
    // Only the page that holds the database starts again: it is the one the bar was drawn on.
    // A tab still opening holds nothing yet, and reloading too it could win the database from
    // the tab the reader pressed in.
    const { core, workers, reload } = served();
    void status(core);
    workers.takeOver();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload a page whose engine stopped: it is a boot screen with its own way out", async () => {
    const { core, worker, workers, reload } = served();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    worker.crash("RuntimeError: unreachable");
    workers.takeOver();
    expect(reload).not.toHaveBeenCalled();
  });

  it("says once, on the console, that the worker could not install", async () => {
    const { core, worker, workers } = served(new FakeWorkers(null));
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    workers.ask({ kind: "grimoire:install-failed", reason: "UnknownError: Unexpected internal error" });
    workers.ask({ kind: "grimoire:install-failed", reason: "UnknownError: Unexpected internal error" });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0][0]).toMatch(
      /^MTG Grimoire: this browser could not save the app for offline use.*\(UnknownError: Unexpected internal error\)\.$/,
    );
    // And the app is an app all the same.
    expect(await status(core)).toEqual({ state: "ready" });
  });

  it("still opens the database when the service worker cannot be set up at all", async () => {
    const workers = new FakeWorkers();
    workers.startMessages = () => {
      throw new Error("InvalidStateError");
    };
    const { core, worker } = served(workers);
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    expect(await status(core)).toEqual({ state: "ready" });
    expect(warned).toHaveBeenCalledWith(
      "MTG Grimoire: the service worker could not be set up.",
      expect.any(Error),
    );
  });
});

describe("clearing the picture cache from Settings", () => {
  /** A `caches` holding pictures of these sizes under the worker's own cache name. */
  function fakeCaches(sizes: number[]): CachesLike {
    const entries = new Map(sizes.map((size, at) => [`https://app.test/mtgimg/display/c${at}/0`, size]));
    return {
      keys: async () => [PICTURE_CACHE],
      delete: async () => true,
      open: async () => ({
        match: async (key) =>
          entries.has(key)
            ? new Response("", { headers: { "Content-Length": String(entries.get(key)) } })
            : undefined,
        put: async () => undefined,
        delete: async (key) => entries.delete(key),
        keys: async () => [...entries.keys()].map((url) => ({ url })),
      }),
    };
  }

  it("answers `cache_clear` on the page, in the desktop's shape, and asks the engine nothing", async () => {
    const { core, worker } = harness({ caches: fakeCaches([93_000, 61_000]) });
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });

    await expect(core.call<CacheCleared>("cache_clear")).resolves.toEqual({
      files: 2,
      bytes: 154_000,
      rows: 0,
      failed: 0,
    });
    // The engine's own would sweep a folder a browser does not have.
    expect(worker.messages.filter((m) => m.kind === "call")).toEqual([]);
  });

  it("answers that nothing was cached in a browser with no Cache Storage", async () => {
    const { core, worker } = harness();
    void status(core);
    worker.say({ kind: "opened", opened: READY, existed: true });
    await expect(core.call("cache_clear")).resolves.toEqual({ files: 0, bytes: 0, rows: 0, failed: 0 });
  });
});
