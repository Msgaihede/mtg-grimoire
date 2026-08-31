import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SyncProgressEvent } from "@/lib/ipc";

const onSyncProgress = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onSyncProgress, syncStatus: vi.fn(), syncRun: vi.fn(), searchCards: vi.fn() },
}));

import { PHASE_LABEL, useSyncProgress } from "./useSyncProgress";

/**
 * The phase strings are a hand-mirrored union of `sync::PHASES` in `src-tauri/src/sync.rs`,
 * and a phase Rust emits that is missing here has no label — the mana line renders
 * `undefined` while the sync runs perfectly, so nothing fails except what the user reads.
 * The Rust half is pinned by `the_progress_phases_are_the_ones_the_frontend_mirrors`; this
 * is the other half, and the two lists are meant to be compared by eye when either moves.
 */
it("labels every phase the backend can emit", () => {
  expect(Object.keys(PHASE_LABEL)).toEqual([
    "checking",
    "downloading",
    "ingesting",
    "reclaiming",
    "sets",
    "compacting",
    "done",
    "error",
  ]);
  expect(Object.values(PHASE_LABEL).every((label) => label.length > 0)).toBe(true);
});

/** Pushes one `sync:progress` event through the listener the hook registered. */
let emit: (e: SyncProgressEvent) => void;

beforeEach(() => {
  unlisten.mockClear();
  onSyncProgress.mockReset().mockImplementation((cb: (e: SyncProgressEvent) => void) => {
    emit = (e) => act(() => cb(e));
    return unlisten;
  });
});

/** Registration is synchronous now that it goes through `@/lib/core`, but the mount that
 *  triggers it is not — this waits for the effect to have run. */
const listening = () => vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

it("holds the latest event and nothing before one arrives", async () => {
  const { result } = renderHook(() => useSyncProgress());
  expect(result.current).toBeNull();
  await listening();

  emit({ phase: "downloading", done: 5, total: 10, message: null });
  expect(result.current?.phase).toBe("downloading");

  emit({ phase: "ingesting", done: 1_000, total: 117_000, message: null });
  expect(result.current?.done).toBe(1_000);
});

/**
 * One registration per call, which is why `AppShell` is the only caller and both consumers
 * read the result as a prop.
 */
it("registers exactly one listener per call", async () => {
  renderHook(() => useSyncProgress());

  await listening();

  expect(onSyncProgress).toHaveBeenCalledTimes(1);
});

it("stops listening when it unmounts", async () => {
  const { unmount } = renderHook(() => useSyncProgress());
  await listening();

  unmount();

  expect(unlisten).toHaveBeenCalled();
});

/*
 * There is no "drops a handle that arrives after the unmount" test here any more. That race —
 * the transport resolving a tick after the component is gone — stopped being this hook's to
 * lose when `ipc.onSyncProgress` became synchronous. It now belongs to the one place that can
 * still see it, and is asserted there: `src/lib/core/core.test.ts`, "returns a synchronous
 * unsubscribe that survives being called before listen resolves".
 */


/**
 * Outside a Tauri window (a plain `vite dev`) the registration never lands. It no longer
 * *rejects* at this hook — `lib/core/tauri.ts` swallows that, because a synchronous subscribe
 * leaves a caller nothing to attach a `.catch` to — so what the hook sees is simply an event
 * that never arrives. Losing the fast path for progress is not worth taking the app down for;
 * the status poll still answers. The swallow itself is asserted in `core.test.ts`.
 */
it("survives a registration that never succeeds", async () => {
  onSyncProgress.mockReturnValue(() => {});

  const { result } = renderHook(() => useSyncProgress());
  await listening();

  expect(result.current).toBeNull();
});
