import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ipc, ipcError, type SyncProgressEvent } from "@/lib/ipc";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

/**
 * `invoke` matches arguments *by name* against the Rust command's parameters, so a
 * wrapper that spells one of them differently fails at runtime with a deserialization
 * error and no type error anywhere. These pin the three names Rust declares:
 * `search_cards(req)`, `sync_run(force)`, `sync_status()`.
 */
describe("ipc argument names match the Rust command signatures", () => {
  it("sends a search under `req`", async () => {
    invoke.mockResolvedValue({ items: [], total: 0 });

    const res = await ipc.searchCards({ text: "bolt", limit: 50, offset: 0 });

    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { text: "bolt", limit: 50, offset: 0 },
    });
    expect(res).toEqual({ items: [], total: 0 });
  });

  it("sends the throttle override under `force`", async () => {
    invoke.mockResolvedValue({ updated: false, cardCount: 7, updatedAt: null });

    await ipc.syncRun(true);

    expect(invoke).toHaveBeenCalledWith("sync_run", { force: true });
  });

  it("asks for status with no arguments", async () => {
    invoke.mockResolvedValue({
      cardCount: 1,
      lastCheckAt: null,
      bulkUpdatedAt: null,
      lastError: null,
      dataDir: "d",
      syncing: false,
    });

    await ipc.syncStatus();

    expect(invoke).toHaveBeenCalledWith("sync_status");
  });
});

it("unwraps the sync:progress payload and returns the unlisten handle", async () => {
  const unlisten = vi.fn();
  let emit: ((evt: { payload: SyncProgressEvent }) => void) | undefined;
  listen.mockImplementation(
    (_name: string, handler: (evt: { payload: SyncProgressEvent }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    },
  );
  const seen: SyncProgressEvent[] = [];

  const stop = await ipc.onSyncProgress((e) => seen.push(e));
  emit?.({ payload: { phase: "downloading", done: 5, total: 10, message: null } });

  expect(listen).toHaveBeenCalledWith("sync:progress", expect.any(Function));
  expect(seen).toEqual([{ phase: "downloading", done: 5, total: 10, message: null }]);
  expect(stop).toBe(unlisten);
});

/**
 * Every command returns `Result<_, String>`, so a rejection carries a bare string —
 * `e.message` would be `undefined` and `String(e)` would be `[object Object]` for the
 * cases that are not strings.
 */
describe("ipcError", () => {
  it("passes a Rust error string through unchanged", () => {
    expect(ipcError("sync already running")).toBe("sync already running");
  });

  it("reads an Error's message", () => {
    expect(ipcError(new Error("window closed"))).toBe("window closed");
  });

  it("never renders an object as [object Object]", () => {
    expect(ipcError({ code: 42 })).toContain('{"code":42}');
  });
});
