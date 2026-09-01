import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SyncLiveEvent } from "@/lib/ipc";

const onSyncLive = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
const syncLiveState = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onSyncLive, syncLiveState },
}));

import { useDeviceSyncLive } from "./useDeviceSyncLive";

/** Pushes one `sync:live` through the listener the hook registered. */
let emit: (e: SyncLiveEvent) => void;

beforeEach(() => {
  unlisten.mockClear();
  onSyncLive.mockReset().mockImplementation((cb: (e: SyncLiveEvent) => void) => {
    emit = (e) => act(() => cb(e));
    return unlisten;
  });
  syncLiveState.mockReset();
});

it("seeds from syncLiveState before any event arrives", async () => {
  syncLiveState.mockResolvedValue("live");
  const { result } = renderHook(() => useDeviceSyncLive());
  expect(result.current).toBe("off");
  await waitFor(() => expect(result.current).toBe("live"));
});

/**
 * The web target has no relay commands at all (`web/route.rs`'s `COMMANDS` carries none of
 * them), so `syncLiveState()` rejects there. The hook must stay `"off"` with no throw and no
 * unhandled rejection — a rejected seed is not worth taking the app down for.
 */
it("stays off when syncLiveState rejects, with no unhandled rejection", async () => {
  syncLiveState.mockRejectedValue(new Error("no relay commands on web"));
  const { result } = renderHook(() => useDeviceSyncLive());
  await waitFor(() => expect(syncLiveState).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(result.current).toBe("off");
});

/**
 * The defect this hook was fixed for. The Rust manager deduplicates `sync:live` — it emits
 * only on a transition — so if a real event lands before the seed's `.then` runs and the seed
 * is allowed to overwrite it anyway, there is no second event to correct the ribbon: it would
 * sit on the stale, pre-transition value until the next genuine transition, which on a healthy
 * socket may be hours away or never for the life of the session. A real event must always win
 * over a value read before it.
 */
it("does not let a late-resolving seed overwrite an event that arrived first", async () => {
  let resolveSeed: (value: string) => void = () => {};
  syncLiveState.mockReturnValue(
    new Promise((resolve) => {
      resolveSeed = resolve;
    }),
  );

  const { result } = renderHook(() => useDeviceSyncLive());
  await waitFor(() => expect(onSyncLive).toHaveBeenCalled());

  // The real transition arrives first...
  emit({ state: "live" });
  expect(result.current).toBe("live");

  // ...and only then does the seed — read from before that transition — resolve.
  await act(async () => {
    resolveSeed("connecting");
  });

  expect(result.current).toBe("live");
});

it("registers exactly one listener", () => {
  syncLiveState.mockResolvedValue("off");
  const { rerender } = renderHook(() => useDeviceSyncLive());
  rerender();
  expect(onSyncLive).toHaveBeenCalledTimes(1);
});

it("updates on a live transition after the seed has already landed", async () => {
  syncLiveState.mockResolvedValue("off");
  const { result } = renderHook(() => useDeviceSyncLive());
  await waitFor(() => expect(result.current).toBe("off"));

  emit({ state: "live" });

  expect(result.current).toBe("live");
});

it("stops listening when it unmounts", async () => {
  syncLiveState.mockResolvedValue("off");
  const { unmount } = renderHook(() => useDeviceSyncLive());
  await waitFor(() => expect(onSyncLive).toHaveBeenCalled());

  unmount();

  expect(unlisten).toHaveBeenCalled();
});
