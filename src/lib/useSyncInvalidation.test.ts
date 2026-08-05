import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { SyncPhase, SyncProgressEvent } from "@/lib/ipc";

const onCollectionReconciled = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onCollectionReconciled, onSyncProgress: vi.fn(), syncStatus: vi.fn() },
}));

import { queryClient } from "@/lib/query";
import { SYNC_INVALIDATED, useSyncInvalidation } from "./useSyncInvalidation";

/** Pushes one `collection:reconciled` through the listener the hook registered. */
let emit: () => void;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

beforeEach(() => {
  unlisten.mockClear();
  onCollectionReconciled.mockReset().mockImplementation((cb: () => void) => {
    emit = () => act(() => cb());
    return Promise.resolve(unlisten);
  });
  // Cleared, not merely re-spied: `spyOn` over an already-spied method hands back the same
  // spy, so its calls would accumulate across the file.
  invalidate = vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(Promise.resolve());
  invalidate.mockClear();
});

/** The listener is registered asynchronously; nothing can be emitted before it lands. */
const listening = () => vi.waitFor(() => expect(onCollectionReconciled).toHaveBeenCalled());

const event = (phase: SyncPhase): SyncProgressEvent => ({
  phase,
  done: 1,
  total: 1,
  message: null,
});

const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);

/**
 * The bug this hook exists for: a sync rewrites all 116,590 rows of `cards` and every
 * mounted query went on drawing the pre-sync answer until the view was remounted — the
 * set list worst of all, whose `staleTime` is `Infinity` once it has data.
 */
it("invalidates every list a sync rewrites, when the sync finishes", async () => {
  const { rerender } = renderHook(
    ({ p }: { p: SyncProgressEvent | null }) => useSyncInvalidation(p),
    {
      initialProps: { p: null as SyncProgressEvent | null },
    },
  );
  await listening();

  rerender({ p: event("ingesting") });
  expect(invalidate).not.toHaveBeenCalled();

  rerender({ p: event("done") });

  expect(invalidatedKeys()).toEqual([...SYNC_INVALIDATED]);
});

/**
 * Keyed on the *phase*, not on the event: `sync:progress` carries a fresh object every
 * tick, and an invalidation per tick would refetch the visible search a hundred times
 * during one ingest.
 */
it("invalidates once per sync rather than once per event", async () => {
  const { rerender } = renderHook(
    ({ p }: { p: SyncProgressEvent | null }) => useSyncInvalidation(p),
    {
      initialProps: { p: null as SyncProgressEvent | null },
    },
  );
  await listening();

  rerender({ p: event("done") });
  const first = invalidate.mock.calls.length;
  rerender({ p: { ...event("done"), message: "116,590 cards" } });

  expect(invalidate.mock.calls.length).toBe(first);
});

/**
 * A reconcile repoints and flags the user's own rows, and it is emitted from both paths a
 * sync can finish by — including the 304 one, which never ingests anything at all.
 */
it("invalidates when the reconciler has moved user rows", async () => {
  renderHook(() => useSyncInvalidation(null));
  await listening();

  emit();

  expect(invalidatedKeys()).toEqual([...SYNC_INVALIDATED]);
});

it("stops listening when it unmounts", async () => {
  const { unmount } = renderHook(() => useSyncInvalidation(null));
  await listening();

  unmount();

  expect(unlisten).toHaveBeenCalled();
});

/**
 * Outside a Tauri window (a plain `vite dev`) the registration rejects, exactly as
 * `useSyncProgress`'s does. Losing one of the two triggers is not worth taking the app
 * down for — the `done` phase still arrives through the props.
 */
it("survives a registration that never succeeds", async () => {
  onCollectionReconciled.mockRejectedValue(new Error("not a tauri window"));

  const { rerender } = renderHook(
    ({ p }: { p: SyncProgressEvent | null }) => useSyncInvalidation(p),
    {
      initialProps: { p: null as SyncProgressEvent | null },
    },
  );
  await listening();
  rerender({ p: event("done") });

  expect(invalidatedKeys()).toEqual([...SYNC_INVALIDATED]);
});
