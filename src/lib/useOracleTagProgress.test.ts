import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OracleTagProgressEvent, OracleTagStatus } from "@/lib/ipc";

const onOracleTagProgress = vi.hoisted(() => vi.fn());
const oracleTagsStatus = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onOracleTagProgress, oracleTagsStatus },
}));

import {
  ORACLE_TAG_PHASE_LABEL,
  ORACLE_TAGS_STATUS_KEY,
  useOracleTagProgress,
} from "./useOracleTagProgress";

/**
 * The phase strings are a hand-mirrored union of `oracle_tags::PHASES` in
 * `src-tauri/src/oracle_tags.rs`, and a phase Rust emits that is missing here has no label —
 * the ribbon renders `undefined` while the refresh runs perfectly, so nothing fails except what
 * the reader is told. The Rust half is pinned by
 * `the_progress_phases_are_the_ones_the_frontend_mirrors`; this is the other half, and the two
 * lists are meant to be compared by eye when either moves.
 *
 * **Five, against `SyncPhase`'s eight**, and the order is the order one refresh produces them:
 * the taxonomy has no `reclaiming`, no `sets` and no `compacting`, because it swaps four small
 * staging tables rather than rewriting the corpus.
 */
it("labels every phase the backend can emit", () => {
  expect(Object.keys(ORACLE_TAG_PHASE_LABEL)).toEqual([
    "checking",
    "downloading",
    "ingesting",
    "done",
    "error",
  ]);
  expect(Object.values(ORACLE_TAG_PHASE_LABEL).every((label) => label.length > 0)).toBe(true);
});

const NEVER: OracleTagStatus = {
  updatedAt: null,
  ingestedAt: null,
  checkedAt: null,
  tagCount: null,
  taggingCount: null,
  stale: true,
  refreshing: false,
};

/** A taxonomy ingested an hour ago, and nothing running. */
const INGESTED: OracleTagStatus = {
  updatedAt: "2026-08-11T09:04:16.113+00:00",
  ingestedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  tagCount: 4_521,
  taggingCount: 229_633,
  stale: false,
  refreshing: false,
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** Pushes one `oracle-tags:progress` event through the listener the hook registered. */
let emit: (e: OracleTagProgressEvent) => void;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unlisten.mockClear();
  oracleTagsStatus.mockReset().mockResolvedValue(NEVER);
  onOracleTagProgress.mockReset().mockImplementation((cb: (e: OracleTagProgressEvent) => void) => {
    emit = (e) => act(() => cb(e));
    return Promise.resolve(unlisten);
  });
});

/** The listener is registered asynchronously; nothing can be emitted before it lands. */
const listening = () => vi.waitFor(() => expect(onOracleTagProgress).toHaveBeenCalled());

/**
 * The never-ingested state, which is what a first launch answers and what an install with no
 * network stays in — and it is a **resting** state, not a running one. Nothing may put a line
 * in the ribbon for a taxonomy that simply is not there.
 */
it("reads the status and describes nothing running", async () => {
  const { result } = renderHook(() => useOracleTagProgress(), { wrapper });

  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.status).toEqual(NEVER);
  expect(result.current.refreshing).toBe(false);
  expect(result.current.progress).toBeNull();
});

/**
 * **The case the status read exists for.** `oracle_tags::refresh_if_due` is spawned at launch,
 * so the ordinary refresh begins before this window has a listener and Tauri drops every event
 * it emitted first. A hook built on the event alone would report nothing at all through the
 * whole of it.
 */
it("reports a refresh that was already running when it mounted", async () => {
  oracleTagsStatus.mockResolvedValue({ ...NEVER, refreshing: true });

  const { result } = renderHook(() => useOracleTagProgress(), { wrapper });

  await waitFor(() => expect(result.current.refreshing).toBe(true));
  // With no event yet, which is exactly the state the ribbon has to describe generically.
  expect(result.current.progress).toBeNull();
});

/**
 * **The stuck ribbon, found by driving the shipped window on 2026-08-14** (`tauri dev`, debug):
 * it read *"Updating card tags"* indefinitely while a direct `oracle_tags_status()` answered
 * `refreshing: false` with the ingest long finished.
 *
 * The two facts above compose into a trap. The status read is what reports a refresh that began
 * before this window had a listener — the ordinary case — and the *only* thing that took the
 * flag back down was a terminal event invalidating the cached status. So the very run that needs
 * the status read is the run whose terminal event is most likely to have been missed, and the
 * flag then stays up for the life of the window. Circular, and it took a live pass to see:
 * every unit test delivered the event it was asserting about.
 *
 * The fix is that the query polls itself while it believes a refresh is running, so a missed
 * event self-heals. **This test never emits an event at all** — that is the whole point of it.
 */
it("takes the line down when the terminal event never arrives", async () => {
  vi.useFakeTimers();
  try {
    oracleTagsStatus.mockResolvedValue({ ...INGESTED, refreshing: true });
    const { result } = renderHook(() => useOracleTagProgress(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.refreshing).toBe(true);

    // The refresh ends in the backend. Nothing tells this window: no `done`, no `error`.
    oracleTagsStatus.mockResolvedValue(INGESTED);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(result.current.refreshing).toBe(false);
    // And it clears without ever having had an event to clear from.
    expect(result.current.progress).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

/** …and the other half: a refresh that starts *after* the status read is carried by the event,
 *  because nothing would re-read the status on its own. */
it("reports a refresh that starts after the status read, from the event alone", async () => {
  const { result } = renderHook(() => useOracleTagProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.refreshing).toBe(false);

  emit({ phase: "downloading", done: 512_000, total: 5_850_000 });

  expect(result.current.refreshing).toBe(true);
  expect(result.current.progress).toEqual({
    phase: "downloading",
    done: 512_000,
    total: 5_850_000,
  });
});

/**
 * `done` and `error` are terminal, and their event can outlive the run by a status read — so
 * neither may be read as "in flight". The refetch is what takes the backend's own flag down:
 * without it a window that mounted mid-refresh would describe that refresh forever.
 */
it("stops describing the run on a terminal phase, and re-reads the status", async () => {
  oracleTagsStatus.mockResolvedValue({ ...NEVER, refreshing: true });
  const { result } = renderHook(() => useOracleTagProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.refreshing).toBe(true));

  oracleTagsStatus.mockResolvedValue(INGESTED);
  emit({ phase: "done", done: 0, total: 0 });

  await waitFor(() => expect(result.current.refreshing).toBe(false));
  expect(result.current.status).toEqual(INGESTED);
  expect(client.getQueryData(ORACLE_TAGS_STATUS_KEY)).toEqual(INGESTED);
});

/**
 * A failed refresh leaves the previous taxonomy exactly where it was, so there is nothing new
 * to read — but the flag on the status this window last read is still true, and only a refetch
 * takes it down. Hence **both** terminal phases invalidate, not just `done`.
 */
it("re-reads the status on a failed refresh too", async () => {
  oracleTagsStatus.mockResolvedValue({ ...INGESTED, refreshing: true });
  const { result } = renderHook(() => useOracleTagProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.refreshing).toBe(true));

  oracleTagsStatus.mockResolvedValue(INGESTED);
  emit({ phase: "error", done: 0, total: 0 });

  await waitFor(() => expect(result.current.refreshing).toBe(false));
  expect(oracleTagsStatus).toHaveBeenCalledTimes(2);
});

/** One registration per call, which is why `AppShell` is the only caller and the ribbon reads
 *  the result rather than starting a second subscription. */
it("registers exactly one listener per call", async () => {
  renderHook(() => useOracleTagProgress(), { wrapper });

  await listening();

  expect(onOracleTagProgress).toHaveBeenCalledTimes(1);
});

it("stops listening when it unmounts", async () => {
  const { unmount } = renderHook(() => useOracleTagProgress(), { wrapper });
  await listening();

  unmount();

  expect(unlisten).toHaveBeenCalled();
});

/**
 * `listen` resolves a tick later than an unmount can happen, so the handle has to be dropped on
 * arrival too — otherwise it outlives the component for the app's lifetime.
 */
it("drops a handle that arrives after the unmount", async () => {
  let land!: (fn: () => void) => void;
  onOracleTagProgress.mockReturnValue(
    new Promise<() => void>((resolve) => {
      land = resolve;
    }),
  );
  const { unmount } = renderHook(() => useOracleTagProgress(), { wrapper });
  await listening();

  unmount();
  await act(async () => land(unlisten));

  expect(unlisten).toHaveBeenCalled();
});

/**
 * Outside a Tauri window (a plain `vite dev`, a story) the registration rejects, and losing the
 * fast path costs less here than anywhere else in the app: the status read still answers, and a
 * taxonomy that never arrives costs categories filed by card type rather than by what a card
 * does. Nothing about this may take the app down.
 */
it("survives a registration that never succeeds", async () => {
  onOracleTagProgress.mockRejectedValue(new Error("not a tauri window"));

  const { result } = renderHook(() => useOracleTagProgress(), { wrapper });
  await listening();

  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.progress).toBeNull();
  expect(result.current.refreshing).toBe(false);
});
