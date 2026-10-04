import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * **The first run's events, from the engine's sink to what each face draws** — the web host's
 * whole event path in one piece: the engine's `listen` handler (a name and JSON text), the
 * Worker's `engine.ts`, the protocol, the page's `createWebCore`, the chunk that is deferred, and
 * `ipc.ts`'s own subscriptions on top. Every hop is tested by itself beside its file; this is the
 * test that they agree with each other, and with the readers both faces mount.
 *
 * **It runs the real `ipc` in a `web` build.** The mode is stubbed before anything is imported —
 * hoisted above the imports below — so `@/lib/core` picks its web arm at evaluation, exactly as
 * the bundle does, and reaches `./index.ts`'s `webCore` through the dynamic import. What stands
 * in is the two things this suite cannot have: the `Worker`, which is a class that runs
 * `engine.ts` in this thread and clones what crosses it, and the module, which is a glue the test
 * wrote. Nothing between them is faked.
 *
 * **What it cannot show** is what a real download emits, in what order and how often — that is
 * the engine's, in a browser. The payloads here are the shapes `ipc.ts` mirrors.
 */
const tauri = vi.hoisted(() => {
  vi.stubEnv("MODE", "web");
  return { invoke: vi.fn(), listen: vi.fn() };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { SyncProgress } from "@/components/SyncProgress";
import { syncActivity } from "@/lib/activity";
import { core } from "@/lib/core";
import { ipc, type SyncProgressEvent, type SyncStatus } from "@/lib/ipc";
import { useSyncProgress } from "@/lib/useSyncProgress";
import { createEngine, type Glue } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";

/** The engine's side of the loop: its one event sink, and what it answers each command with. */
const engineSide = {
  made: 0,
  sink: undefined as ((name: string, payload: string) => void) | undefined,
  answers: new Map<string, unknown>(),
};

const READY = { kind: "ready", journal: "delete", corpusJournal: "delete", schemaVersion: 59 };

const glue: Glue = {
  open: () => Promise.resolve(JSON.stringify(READY)),
  call: (name) =>
    Promise.resolve(
      engineSide.answers.has(name)
        ? JSON.stringify({ ok: engineSide.answers.get(name) })
        : JSON.stringify({ err: `There is no command named ${name} on this host.` }),
    ),
  listen: (handler) => {
    engineSide.sink = handler;
  },
};

/** The engine says something, as `crates/grimoire-web` does: a name, and the payload as text. */
const emit = (name: string, payload: unknown) => engineSide.sink?.(name, JSON.stringify(payload));

/**
 * A `Worker` that is `engine.ts` in this thread. A message is cloned on its way in and on its way
 * out, as `postMessage` clones it, so nothing reaches the page that a real Worker could not send.
 */
class LoopbackWorker {
  private onMessage: ((event: { data: FromWorker }) => void) | undefined;
  private readonly engine = createEngine(
    () => Promise.resolve(glue),
    (message) => this.onMessage?.({ data: structuredClone(message) }),
    () => Promise.resolve(true),
  );

  constructor() {
    engineSide.made += 1;
  }

  postMessage(message: ToWorker): void {
    void this.engine.handle(structuredClone(message));
  }

  addEventListener(type: string, listener: (event: { data: FromWorker }) => void): void {
    if (type === "message") this.onMessage = listener;
  }
}

const SYNCING: SyncStatus = {
  cardCount: 0,
  lastCheckAt: null,
  bulkUpdatedAt: null,
  lastError: null,
  lastIngestSkipped: null,
  dataDir: "OPFS:/mtg-grimoire",
  syncing: true,
  imageStoreFailures: 0,
};

beforeAll(async () => {
  vi.stubGlobal("Worker", LoopbackWorker);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  engineSide.answers.set("sync_status", SYNCING);
  // The gate, as `LightApp` asks it: the first ask starts the Worker and the open.
  await waitFor(async () => expect(await ipc.startupStatus()).toEqual({ state: "ready" }));
});

describe("the web build's own wiring", () => {
  it("answers through one Worker and never through Tauri", async () => {
    expect(import.meta.env.MODE).toBe("web");
    expect(await ipc.syncStatus()).toEqual(SYNCING);
    expect(engineSide.made).toBe(1);
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(tauri.listen).not.toHaveBeenCalled();
  });

  it("passes the engine's refusal of a command it lacks on as a bare string", async () => {
    // `light_downloads` is the Android host's. What `DownloadsPrompt` reads here is a rejection,
    // which is "nothing to ask about" — and a string, as a Tauri command rejects with one.
    await expect(core.call("light_downloads")).rejects.toBe(
      "There is no command named light_downloads on this host.",
    );
  });
});

describe("an engine event, read by what both faces mount", () => {
  /**
   * Let a subscription land. In a web build `core` is a chunk reached by `import()`, so `listen`
   * attaches a turn *after* it is called (`deferred.ts`) — and an event said in that turn is one
   * nobody heard. A whole task rather than a counted microtask or two: how many hops the deferral
   * takes is not this test's to know.
   */
  const attached = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  /** Subscribe through `ipc`, and wait until the deferred core has really attached it. */
  async function heardBy<T>(subscribe: (cb: (payload: T) => void) => () => void) {
    const heard: T[] = [];
    const stop = subscribe((payload) => heard.push(payload));
    await attached();
    return { heard, stop };
  }

  /** The hook both faces read `sync:progress` through, mounted and listening. */
  async function mounted() {
    const hook = renderHook(() => useSyncProgress());
    await attached();
    return hook;
  }

  it("arrives as the payload itself — parsed, and with no envelope around it", async () => {
    const { heard, stop } = await heardBy<SyncProgressEvent>(ipc.onSyncProgress);
    const event: SyncProgressEvent = {
      phase: "downloading",
      done: 31_000_000,
      total: 77_000_000,
      message: null,
    };

    emit("sync:progress", event);

    // Not `{ event, id, payload }` as Tauri hands a listener, and not the JSON text the engine
    // wrote: the object a reader's `progress.phase` is read from.
    expect(heard).toEqual([event]);
    stop();
  });

  it("reaches each of the six subscriptions the faces make, under the engine's own names", async () => {
    // The names are the wire. `ipc.ts` spells the subscriber's half and the engine the emitter's;
    // a channel spelt two ways is a listener that hears nothing, for ever, with no error.
    const channels = [
      ["sync:progress", ipc.onSyncProgress],
      ["collection:reconciled", ipc.onCollectionReconciled],
      ["marketplace:progress", ipc.onMarketplaceProgress],
      ["oracle-tags:progress", ipc.onOracleTagProgress],
      ["art-tags:progress", ipc.onArtTagProgress],
      ["combos:progress", ipc.onCombosProgress],
    ] as const;
    // All six subscribed, then one wait for all of them — never six `act`s at once, which React
    // does not support and which leaves every later render in this file without its effects.
    const subscribed = channels.map(([name, subscribe]) => {
      const heard: unknown[] = [];
      const listen = subscribe as (cb: (payload: unknown) => void) => () => void;
      return { name, heard, stop: listen((payload) => heard.push(payload)) };
    });
    await attached();

    for (const [name] of channels) emit(name, { from: name });

    // Each heard its own event once, and nobody heard another's.
    for (const { name, heard, stop } of subscribed) {
      expect(heard, name).toEqual([{ from: name }]);
      stop();
    }
  });

  it("keeps the order the engine said things in, across a whole run", async () => {
    const { heard, stop } = await heardBy<SyncProgressEvent>(ipc.onSyncProgress);
    const run = ["checking", "downloading", "downloading", "ingesting", "sets", "done"] as const;

    run.forEach((phase, done) => emit("sync:progress", { phase, done, total: 0, message: null }));

    // One channel carries events and answers alike, so nothing overtakes: `done` is last.
    expect(heard.map((e) => e.phase)).toEqual(run);
    expect(heard.map((e) => e.done)).toEqual([0, 1, 2, 3, 4, 5]);
    stop();
  });

  it("is not replayed to a face that mounts after it, which the status poll then covers", async () => {
    // The launch's download starts with the open, before the gate lets a face mount — so its
    // first events are said to nobody, as Tauri drops one emitted before the page listens.
    emit("sync:progress", { phase: "checking", done: 0, total: 0, message: null });

    const { result, unmount } = await mounted();
    expect(result.current).toBeNull();
    // What both faces say in that gap: `sync_status` says a sync is running, and the fold
    // answers the generic sentence over an indeterminate bar rather than nothing at all.
    const status = await ipc.syncStatus();
    expect(syncActivity(result.current, status.syncing)).toMatchObject({
      label: "Syncing card data",
      value: null,
    });

    act(() => emit("sync:progress", { phase: "ingesting", done: 58_000, total: 0, message: null }));
    expect(result.current).toMatchObject({ phase: "ingesting", done: 58_000 });
    unmount();
  });

  it("is what the phone's line and the desktop's first-run screen are drawn from", async () => {
    const { result, unmount } = await mounted();
    act(() =>
      emit("sync:progress", {
        phase: "downloading",
        done: 31_000_000,
        total: 77_000_000,
        message: null,
      }),
    );

    // The phone face: `useCardDataWatch` folds exactly these two into the `sync` that `NoCards`
    // draws — the phase in the ribbon's words, the count beside it, the fraction on the line.
    expect(syncActivity(result.current, true)).toMatchObject({
      label: "Downloading card data",
      detail: "31 / 77 MB",
    });
    expect(syncActivity(result.current, true)?.value).toBeCloseTo(31 / 77);

    // The desktop face: `AppShell` hands the same event and `sync_status`' count to its gate.
    render(
      <SyncProgress progress={result.current} cardCount={0} error={null} busy onRetry={() => {}} />,
    );
    const gate = screen.getByRole("dialog", { name: "Setting up your card database" });
    expect(gate).toHaveTextContent("Downloading card data");
    expect(gate).toHaveTextContent("31 / 77 MB");
    expect(screen.getByRole("status")).toHaveTextContent("Downloading card data");
    // Nothing to retry while it runs.
    expect(screen.queryByRole("button", { name: "Retry download" })).toBeNull();
    unmount();
  });

  it("carries a failure's own sentence to the first-run screen, with the way to try again", async () => {
    const { result, unmount } = await mounted();
    act(() =>
      emit("sync:progress", {
        phase: "error",
        done: 0,
        total: 0,
        message: "Couldn't reach Scryfall: the request was blocked.",
      }),
    );

    render(
      <SyncProgress
        progress={result.current}
        cardCount={0}
        error={null}
        busy={false}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Couldn't reach Scryfall: the request was blocked.",
    );
    expect(screen.getByRole("button", { name: "Retry download" })).toBeInTheDocument();
    unmount();
  });
});
