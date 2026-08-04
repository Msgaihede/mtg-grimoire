import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SyncProgressEvent } from "@/lib/ipc";

const onSyncProgress = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onSyncProgress, syncStatus: vi.fn(), syncRun: vi.fn(), searchCards: vi.fn() },
}));

import { useSyncProgress } from "./useSyncProgress";

/** Pushes one `sync:progress` event through the listener the hook registered. */
let emit: (e: SyncProgressEvent) => void;

beforeEach(() => {
  unlisten.mockClear();
  onSyncProgress.mockReset().mockImplementation((cb: (e: SyncProgressEvent) => void) => {
    emit = (e) => act(() => cb(e));
    return Promise.resolve(unlisten);
  });
});

/** The listener is registered asynchronously; nothing can be emitted before it lands. */
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

/**
 * `listen` resolves a tick later than an unmount can happen, so the handle has to be
 * dropped on arrival too — otherwise it outlives the component for the app's lifetime.
 */
it("drops a handle that arrives after the unmount", async () => {
  let land!: (fn: () => void) => void;
  onSyncProgress.mockReturnValue(
    new Promise<() => void>((resolve) => {
      land = resolve;
    }),
  );
  const { unmount } = renderHook(() => useSyncProgress());
  await listening();

  unmount();
  await act(async () => land(unlisten));

  expect(unlisten).toHaveBeenCalled();
});

/**
 * Outside a Tauri window (a plain `vite dev`) the registration rejects. Losing the fast
 * path for progress is not worth taking the app down for — the status poll still answers.
 */
it("survives a registration that never succeeds", async () => {
  onSyncProgress.mockRejectedValue(new Error("not a tauri window"));

  const { result } = renderHook(() => useSyncProgress());
  await listening();

  expect(result.current).toBeNull();
});
