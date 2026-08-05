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
 * The guard the constant could not be: asserting `SYNC_INVALIDATED` against itself let any
 * key be deleted with the suite still green — every other test in this file spreads the
 * constant into its own expectation. One literal list makes the contract real; updating it
 * is a *decision*, not a rename that rides along.
 *
 * `["decks"]` is the sixth and was added deliberately, by exactly that mechanism: every
 * fact a deck card shows except its denormalized identity is read from `cards` through a
 * LEFT JOIN, and the reconciler now walks `deck_cards` too — so a sync that repoints a
 * printing has changed what an open deck says about it.
 *
 * `["formatSpecs"]` is **not** here and must not be: the table is seeded by a migration and
 * a sync cannot touch it.
 */
it("invalidates exactly the six known roots", () => {
  expect(SYNC_INVALIDATED).toEqual([
    ["cards"],
    ["collection"],
    ["wishlist"],
    ["card"],
    ["sets"],
    ["decks"],
  ]);
});

/**
 * The gap plan 3 ledgered: a swap that succeeded followed by a `/sets` that failed surfaces
 * as the `error` phase and no `done`, leaving the cache describing a corpus that is no
 * longer on disk until some later run finishes. The frontend can see the whole story in the
 * phases it already receives: an `error` after an `ingesting` is a run that may have
 * committed. (An error after `ingesting` but *before* the swap also matches; invalidating
 * then refetches unchanged data, which is cheap and correct.)
 */
it("invalidates on an error that follows an ingest, and not on one that does not", async () => {
  const { rerender } = renderHook(
    ({ p }: { p: SyncProgressEvent | null }) => useSyncInvalidation(p),
    {
      initialProps: { p: null as SyncProgressEvent | null },
    },
  );
  await listening();

  rerender({ p: event("checking") });
  rerender({ p: event("error") });
  expect(invalidate).not.toHaveBeenCalled(); // a failed *check* changed nothing on disk

  rerender({ p: event("checking") });
  rerender({ p: event("ingesting") });
  rerender({ p: event("error") });
  expect(invalidatedKeys()).toEqual([...SYNC_INVALIDATED]);

  // …and the flag does not leak into the next run: a later error with no ingest is quiet.
  invalidate.mockClear();
  rerender({ p: event("checking") });
  rerender({ p: event("error") });
  expect(invalidate).not.toHaveBeenCalled();
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
