import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { RelayOutcome } from "@/lib/ipc";

const onSyncApplied = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onSyncApplied },
}));

import { DEVICE_SYNC_INVALIDATED, queryClient } from "@/lib/query";
import { useDeviceSyncInvalidation } from "./useDeviceSyncInvalidation";

/** Pushes one `sync:applied` through the listener the hook registered. */
let emit: (outcome: RelayOutcome) => void;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

const outcome = (over: Partial<RelayOutcome> = {}): RelayOutcome => ({
  pushed: 0,
  pulled: 3,
  unreadable: 0,
  applied: 3,
  resurrected: 0,
  cyclesBroken: 0,
  skipped: 0,
  deferred: 0,
  baselineOps: 0,
  baselineHistory: 0,
  ...over,
});

beforeEach(() => {
  unlisten.mockClear();
  onSyncApplied.mockReset().mockImplementation((cb: (e: RelayOutcome) => void) => {
    emit = (e) => act(() => cb(e));
    return unlisten;
  });
  // Cleared, not merely re-spied: `spyOn` over an already-spied method hands back the same
  // spy, so its calls would accumulate across the file.
  invalidate = vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(Promise.resolve());
  invalidate.mockClear();
});

const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);

it("invalidates the owned-write roots and the sync root when a sync applies", () => {
  renderHook(() => useDeviceSyncInvalidation());
  emit(outcome({ pushed: 0, pulled: 3 }));
  expect(invalidatedKeys()).toEqual([...DEVICE_SYNC_INVALIDATED]);
});

/**
 * `["sets"]` has `staleTime: Infinity` and `["card"]` is corpus data — no relay op can touch
 * either, and invalidating them on every round trip would refetch the set picker for ever.
 */
it("does not invalidate the corpus roots", () => {
  renderHook(() => useDeviceSyncInvalidation());
  emit(outcome({ pushed: 0, pulled: 3 }));
  const keys = JSON.stringify(invalidatedKeys());
  expect(keys).not.toContain("sets");
  expect(keys).not.toContain('["card"]');
});

it("registers exactly one listener", () => {
  const { rerender } = renderHook(() => useDeviceSyncInvalidation());
  rerender();
  expect(onSyncApplied).toHaveBeenCalledTimes(1);
});

it("stops listening when it unmounts", () => {
  const { unmount } = renderHook(() => useDeviceSyncInvalidation());
  unmount();
  expect(unlisten).toHaveBeenCalled();
});

/**
 * The guard the constant could not be: asserting `DEVICE_SYNC_INVALIDATED` against itself lets
 * any key be deleted with the suite still green — the first test above spreads the constant
 * into its own expectation, and "does not invalidate the corpus roots" only checks that
 * `"sets"` and `["card"]` are *absent*, never that the real keys are *present*. One literal list
 * makes the contract real; updating it is a decision, not a rename that rides along.
 */
it("invalidates exactly the five known roots", () => {
  expect(DEVICE_SYNC_INVALIDATED).toEqual([
    ["collection"],
    ["wishlist"],
    ["cards", "search"],
    ["decks"],
    ["sync"],
  ]);
});
