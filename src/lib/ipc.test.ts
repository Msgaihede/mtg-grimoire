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
    invoke.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });

    const res = await ipc.searchCards({ text: "bolt", limit: 50, offset: 0 });

    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { text: "bolt", limit: 50, offset: 0 },
    });
    expect(res).toEqual({ items: [], total: 0, totalIsCapped: false });
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
      lastIngestSkipped: 12,
      dataDir: "d",
      syncing: false,
    });

    const res = await ipc.syncStatus();

    expect(invoke).toHaveBeenCalledWith("sync_status");
    // Pinned rather than assumed: spec §8 requires the skipped-line count reach the user,
    // and a field this side spells differently is `undefined` with no type error anywhere.
    expect(res.lastIngestSkipped).toBe(12);
  });

  it("sends the new filters under the names Rust deserializes", async () => {
    invoke.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });

    await ipc.searchCards({ sets: ["lea"], manaValues: [1, 8], limit: 50, offset: 0 });

    // `search.rs` renames to camelCase, so `manaValues` — not `mana_values` — is the
    // spelling that lands in `SearchRequest.mana_values`.
    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { sets: ["lea"], manaValues: [1, 8], limit: 50, offset: 0 },
    });
  });

  it("takes no arguments for the set list", async () => {
    invoke.mockResolvedValue([]);
    await ipc.listSets();
    expect(invoke).toHaveBeenCalledWith("list_sets");
  });

  it("sends a card id under `id` and an oracle id under `oracleId`", async () => {
    invoke.mockResolvedValue(null);
    await ipc.cardDetail("p1");
    expect(invoke).toHaveBeenCalledWith("card_detail", { id: "p1" });

    invoke.mockResolvedValue({ items: [], total: 0 });
    const printings = await ipc.cardPrintings("o1");
    // Tauri maps a camelCase key onto the `oracle_id` parameter; spelling it
    // `oracle_id` here would be the runtime deserialization error no type can catch.
    expect(invoke).toHaveBeenCalledWith("card_printings", { oracleId: "o1" });
    // Not a bare array: `card::list_printings` caps the page at 400 and answers
    // `PrintingsResponse`, whose `total` is the only thing that says a list was truncated.
    // A mirror typed as `Printing[]` would read `.length` as the whole story and the
    // compiler would agree with it.
    expect(printings).toEqual({ items: [], total: 0 });
  });

  it("sends a prefetch batch under `cardIds` and `variant`", async () => {
    invoke.mockResolvedValue(undefined);

    await ipc.prefetchImages(["p1", "p2"], "grid");

    // `prefetch_images(card_ids, variant)` — Tauri maps the camelCase key onto
    // `card_ids`, and `variant` is parsed by `Variant::parse`, which rejects anything
    // outside the four WEBP names with an error rather than silently prefetching nothing.
    expect(invoke).toHaveBeenCalledWith("prefetch_images", {
      cardIds: ["p1", "p2"],
      variant: "grid",
    });
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
