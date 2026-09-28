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

import { DEVICE_SYNC_INVALIDATED } from "@/lib/crossWindow";
import { queryClient } from "@/lib/query";
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
  heldNewer: 0,
  dropped: 0,
  moot: 0,
  changed: true,
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

it("invalidates every root a synced table feeds, and the sync root, when a pull applies", () => {
  renderHook(() => useDeviceSyncInvalidation());
  emit(outcome({ pushed: 0, pulled: 3 }));
  expect(invalidatedKeys()).toEqual([...DEVICE_SYNC_INVALIDATED]);
});

/**
 * **A push-only trip changed no row a query reads**, and every write of the reader's own ends in
 * one — so the whole set here would re-read a deep search, an open card and the Tags page after
 * every press. What did move is the relay's own figures: the pile went, and the stamp.
 */
it("refreshes the sync root alone when a trip only pushed", () => {
  renderHook(() => useDeviceSyncInvalidation());
  emit(outcome({ pushed: 4, pulled: 0, applied: 0, changed: false }));
  expect(invalidatedKeys()).toEqual([["sync"]]);
});

/**
 * **`changed` and not `pulled`.** The moot arm deletes a row this device held and counts it in
 * `moot`, never in `applied`, so a trip that pushed and whose pull only mooted reports `pulled: 0`
 * — and gated on `pulled`, the deleted card stayed on screen.
 */
it("refreshes the whole set when a pull changed rows without applying an op", () => {
  renderHook(() => useDeviceSyncInvalidation());
  emit(outcome({ pushed: 2, pulled: 0, applied: 0, moot: 1, changed: true }));
  expect(invalidatedKeys()).toEqual([...DEVICE_SYNC_INVALIDATED]);
});

/**
 * `["sets"]` has `staleTime: Infinity` and is corpus data — a pull writes the reader's own rows
 * and never rebuilds the corpus, and invalidating it on every round trip would refetch the set
 * picker for ever. **`["card"]` used to sit beside it here, and was wrong to**: the card modal's
 * holdings and every printing's `wishlisted` are filed under it, and a pull moves both.
 */
it("does not invalidate the set list, and does reach the card root", () => {
  renderHook(() => useDeviceSyncInvalidation());
  emit(outcome({ pushed: 0, pulled: 3 }));
  const keys = JSON.stringify(invalidatedKeys());
  expect(keys).not.toContain("sets");
  expect(invalidatedKeys()).toContainEqual(["card"]);
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
 * into its own expectation, and `crossWindow.test.ts`' census is read off the same table map the
 * constant is, so a root dropped from `TABLE_KEYS` leaves both agreeing. One literal list makes
 * the contract real; updating it is a decision, not a rename that rides along.
 *
 * **It read `OWNED_WRITE_KEYS` and `["sync"]` until the sticky notes found the gap** — one
 * synced table's worth. What joined them is `["cards"]` and `["card"]` (a wish, a copy and a deck
 * card move `wishlisted`, the owned tri-state and the holdings), the four tag roots a mute
 * reaches, and the sticky notes' own.
 */
it("invalidates exactly the known roots", () => {
  expect(DEVICE_SYNC_INVALIDATED).toEqual([
    ["collection"],
    ["wishlist"],
    ["decks"],
    ["cards"],
    ["card"],
    ["sync"],
    ["tags-muted"],
    ["tag-search"],
    ["tag-children"],
    ["tags"],
    ["stickyNotes"],
  ]);
});
