import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ComboProgress, ComboStatus } from "@/lib/ipc";
import { COMBOS_STATUS_KEY, combosForCardsKey } from "@/lib/query";
// The gallery's key builder, imported rather than transcribed: `useComboProgress` invalidates a
// two-segment prefix of it, and the only thing keeping the two spellings together is this test.
import { deckBracketsKey } from "@/features/decks/useDeckBrackets";

const onCombosProgress = vi.hoisted(() => vi.fn());
const combosStatus = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
// Spread rather than replaced: `ipc.ts` is a hand-written mirror of the Rust structs and a
// wholesale `vi.mock` of it erases every other export this file's module graph reaches, which
// fails at runtime inside a `useMemo` rather than at type-check.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onCombosProgress, combosStatus },
}));

import { COMBO_PHASE_LABEL, useComboProgress } from "./useComboProgress";

/**
 * The phase strings are a hand-mirrored union of `combos::PHASES` in `src-tauri/src/combos.rs`,
 * and a phase Rust emits that is missing here has no label — the ribbon renders `undefined`
 * while the download runs perfectly, so nothing fails except what the reader is told. The Rust
 * half is pinned by `the_progress_phases_are_the_ones_the_frontend_mirrors`; this is the other
 * half, and the two lists are meant to be compared by eye when either moves.
 *
 * **Five, and the order is the order one refresh produces them.** `checking`, then bytes, then
 * one `ingesting`, then exactly one of the two ways to stop.
 */
it("labels every phase the backend can emit", () => {
  expect(Object.keys(COMBO_PHASE_LABEL)).toEqual([
    "checking",
    "downloading",
    "ingesting",
    "done",
    "error",
  ]);
  expect(Object.values(COMBO_PHASE_LABEL).every((label) => label.length > 0)).toBe(true);
});

/** A database that has never fetched the file — every install's first launch, and where a
 *  machine that cannot reach Spellbook stays. **`stale: true` and nothing running.** */
const NEVER: ComboStatus = {
  combos: 0,
  cards: 0,
  stamp: null,
  fetchedAt: null,
  checkedAt: null,
  stale: true,
};

/** The feed as measured on 2026-08-27, ingested an hour ago, with nothing running. */
const INGESTED: ComboStatus = {
  combos: 105_478,
  cards: 7_310,
  stamp: "2026-08-27T03:12:44Z",
  fetchedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  stale: false,
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** Pushes one `combos:progress` event through the listener the hook registered. */
let emit: (e: ComboProgress) => void;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unlisten.mockClear();
  combosStatus.mockReset().mockResolvedValue(NEVER);
  onCombosProgress.mockReset().mockImplementation((cb: (e: ComboProgress) => void) => {
    emit = (e) => act(() => cb(e));
    return unlisten;
  });
});

/** Registration goes through `@/lib/core` and is synchronous, but the mount that triggers it is
 *  not — this waits for the effect to have run. */
const listening = () => vi.waitFor(() => expect(onCombosProgress).toHaveBeenCalled());

/**
 * The never-ingested state, which is what a first launch answers — and it is a **resting** state,
 * not a running one. Nothing may put a line in the ribbon for a list that simply is not there.
 */
it("reads the status and describes nothing running", async () => {
  const { result } = renderHook(() => useComboProgress(), { wrapper });

  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.status).toEqual(NEVER);
  expect(result.current.refreshing).toBe(false);
  expect(result.current.progress).toBeNull();
});

/**
 * **`stale` says a download is *due*, never that one is running, and the difference is the whole
 * reason this hook does not guess from the status.** `combos::refresh_if_due` is spawned at
 * launch on exactly this condition, so a stale status is suggestive — and the machine it is most
 * suggestive on is the one that cannot reach Spellbook at all, where the failure path never
 * moves `checkedAt` and the row therefore stays stale forever. A hook that read it as "running"
 * would put a sentence on that reader's ribbon for the life of every session.
 */
it("does not describe a run just because the feed is due for one", async () => {
  combosStatus.mockResolvedValue({ ...INGESTED, stale: true, checkedAt: 1 });

  const { result } = renderHook(() => useComboProgress(), { wrapper });

  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.status?.stale).toBe(true);
  expect(result.current.refreshing).toBe(false);
});

/**
 * **The event is the flag, because `ComboStatus` has no `refreshing` field to be one.**
 * `combos.rs` holds the claim in a module-level `AtomicBool` whose reader is `#[cfg(test)]`, so
 * the only thing in production that can say a run is in flight is the run's own progress event.
 */
it("reports a run from the event alone, from its first phase", async () => {
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.refreshing).toBe(false);

  emit({ phase: "checking", done: 0, total: 0 });

  expect(result.current.refreshing).toBe(true);
  expect(result.current.progress).toEqual({ phase: "checking", done: 0, total: 0 });
});

/** The bytes, which are the only numbers this job ever reports: `download` passes
 *  `content_length().unwrap_or(0)` straight through, and the ingest's callback is discarded. */
it("carries the download's own figures through", async () => {
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();

  emit({ phase: "downloading", done: 14_000_000, total: 27_500_000 });

  expect(result.current.refreshing).toBe(true);
  expect(result.current.progress).toEqual({
    phase: "downloading",
    done: 14_000_000,
    total: 27_500_000,
  });
});

/**
 * **The terminal event ends the run rather than joining it**, and it is the event and not a poll
 * that does so — which is legitimate here for one reason worth keeping: a flag raised by an event
 * can only have been raised by a window that was *listening*, and the listener that heard the run
 * start is still registered when it ends. Every path through `combos::refresh` that emits
 * `checking` reaches `done` or `error`, so the line cannot latch the way the tag ribbon did on
 * 2026-08-14.
 */
it("stops describing the run on a terminal phase, and re-reads the status", async () => {
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).toEqual(NEVER));

  emit({ phase: "ingesting", done: 0, total: 0 });
  expect(result.current.refreshing).toBe(true);

  combosStatus.mockResolvedValue(INGESTED);
  emit({ phase: "done", done: 0, total: 0 });

  expect(result.current.refreshing).toBe(false);
  await waitFor(() => expect(result.current.status).toEqual(INGESTED));
  expect(client.getQueryData(COMBOS_STATUS_KEY)).toEqual(INGESTED);
});

/**
 * A `done` that arrives with nothing before it is the ordinary shape of a launch refresh this
 * window attached to late — `ingesting` is emitted exactly once, so a window that mounted during
 * the 639 MB parse hears nothing until the run ends. It must refill the cache and it must not
 * put a job on the ribbon: there is nothing left to describe.
 */
it("never resurrects a finished run from its own terminal event", async () => {
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).toEqual(NEVER));

  combosStatus.mockResolvedValue(INGESTED);
  emit({ phase: "done", done: 27_500_000, total: 27_500_000 });

  expect(result.current.refreshing).toBe(false);
  await waitFor(() => expect(result.current.status).toEqual(INGESTED));
});

/**
 * A failed download leaves the previous combos exactly where they were — `combos::store` writes
 * staging tables and promotes them in one transaction — so this invalidation is not buying a
 * changed row. It is buying not having to be *right* about which failures changed one: a `done`
 * after a 304 moved `checkedAt` alone, a `done` after an ingest moved everything, and telling the
 * three apart from here would be a copy of that transaction discipline in the frontend. One read
 * of one small local table is the cheaper half of the trade.
 */
it("re-reads the status on a failed refresh too", async () => {
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).toEqual(NEVER));

  emit({ phase: "downloading", done: 1_000, total: 27_500_000 });
  expect(result.current.refreshing).toBe(true);

  emit({ phase: "error", done: 0, total: 0 });

  expect(result.current.refreshing).toBe(false);
  await waitFor(() => expect(combosStatus).toHaveBeenCalledTimes(2));
});

/**
 * **The open deck's advisory, and this hook is the whole of how a finished download reaches it.**
 * The launch refresh is a Rust task nobody pressed that has never heard of TanStack, and Settings'
 * combo panel — which used to do this invalidation on its own Refresh button — is gone. Without
 * it a deck editor that was open when the file landed goes on reading three bracket signals for
 * the rest of the session.
 *
 * Asserted through `getQueryState().isInvalidated` rather than by counting refetches: the key is a
 * prefix over a query this hook never mounts, so a call count would be zero whether the
 * invalidation ran or not.
 */
it("puts an open deck's combo answer out of date when a download lands", async () => {
  const deckKey = combosForCardsKey(["aaaa-1111", "bbbb-2222"]);
  client.setQueryData(deckKey, []);
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).toEqual(NEVER));
  expect(client.getQueryState(deckKey)?.isInvalidated).toBe(false);

  emit({ phase: "done", done: 0, total: 0 });

  await waitFor(() => expect(client.getQueryState(deckKey)?.isInvalidated).toBe(true));
});

/**
 * **The deck wall's copy of the same answer, which comes off a root sharing no prefix with the
 * one above.** `useDeckBrackets` reads `deck_bracket_reads` under `["decks", "brackets", …]`, so
 * an invalidation of `["combos"]` reaches no tile at all: a download landing while the gallery is
 * on screen would refill the open deck and leave every caption estimating from three signals
 * until some unrelated deck write fired `["decks"]`. That is exactly the invisible-stale-answer
 * failure the automatic download exists to remove, one surface over.
 *
 * The key is built by `deckBracketsKey` itself rather than typed out, which is what makes this a
 * fence rather than two files agreeing on a string literal: renaming a segment on either side
 * turns the prefix match off and turns this red.
 */
it("puts every deck tile's bracket estimate out of date when a download lands", async () => {
  const wallKey = deckBracketsKey([2, 10]);
  client.setQueryData(wallKey, []);
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).toEqual(NEVER));
  expect(client.getQueryState(wallKey)?.isInvalidated).toBe(false);

  emit({ phase: "done", done: 0, total: 0 });

  await waitFor(() => expect(client.getQueryState(wallKey)?.isInvalidated).toBe(true));
});

/**
 * A failed download moves the gallery's read for the same reason it moves the editor's: telling a
 * 304 from a real ingest from a refusal is `combos::store`'s transaction discipline, and a copy
 * of it here would be a copy that could drift.
 */
it("puts the deck tiles out of date on a failed refresh too", async () => {
  const wallKey = deckBracketsKey([7]);
  client.setQueryData(wallKey, []);
  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();
  await waitFor(() => expect(result.current.status).toEqual(NEVER));

  emit({ phase: "error", done: 0, total: 0 });

  await waitFor(() => expect(client.getQueryState(wallKey)?.isInvalidated).toBe(true));
});

/** One registration per call, which is why `AppShell` is the only caller and the ribbon reads
 *  the result rather than starting a second subscription. */
it("registers exactly one listener per call", async () => {
  renderHook(() => useComboProgress(), { wrapper });

  await listening();

  expect(onCombosProgress).toHaveBeenCalledTimes(1);
});

it("stops listening when it unmounts", async () => {
  const { unmount } = renderHook(() => useComboProgress(), { wrapper });
  await listening();

  unmount();

  expect(unlisten).toHaveBeenCalled();
});

/**
 * Outside a Tauri window (a plain `vite dev`, a story) the registration never lands —
 * `lib/core/tauri.ts` swallows it — and here that costs the ribbon its sentence and the app
 * nothing else: the status read still answers, and a combo list that never arrives costs the
 * bracket estimate its fourth signal. Nothing about this may take the app down.
 */
it("survives a registration that never succeeds", async () => {
  onCombosProgress.mockReturnValue(() => {});

  const { result } = renderHook(() => useComboProgress(), { wrapper });
  await listening();

  await waitFor(() => expect(result.current.status).toEqual(NEVER));
  expect(result.current.progress).toBeNull();
  expect(result.current.refreshing).toBe(false);
});
