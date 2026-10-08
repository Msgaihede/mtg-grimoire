import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const navCollapsed = vi.hoisted(() => vi.fn());
const setNavCollapsed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { navCollapsed, setNavCollapsed },
}));

import { NAV_COLLAPSED_KEY, useNavCollapsed } from "./useNavCollapsed";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who collapsed the rail last time, which is the case that proves the row is read at
  // all rather than the fallback being right by accident — `false` is what every failure here
  // also answers.
  navCollapsed.mockReset().mockResolvedValue(true);
  setNavCollapsed.mockReset().mockResolvedValue(undefined);
});

/**
 * The rail's collapsed state: one `app_meta` row, read once per app run and written
 * optimistically.
 *
 * The setting is a bare boolean, so there is no unknown-vocabulary case to cover — the far end
 * folds a missing row, a junk row and an unreadable one into `false` before this side sees
 * anything. What is left is the two ends it can fail at, and neither of them is allowed to cost
 * the reader a shell or the fold they just asked for.
 */
describe("useNavCollapsed", () => {
  it("opens collapsed when that is what the last run stored", async () => {
    const { result } = renderHook(() => useNavCollapsed(), { wrapper });

    await waitFor(() => expect(result.current.collapsed).toBe(true));
  });

  /**
   * The stored `false` is read, not merely indistinguishable from the fallback.
   *
   * Every failure below also answers `false`, so a hook that never read the row at all would
   * pass the expanded case for the wrong reason. Asserting the command was called is what tells
   * the two apart.
   */
  it("opens expanded when that is what the last run stored", async () => {
    navCollapsed.mockResolvedValue(false);

    const { result } = renderHook(() => useNavCollapsed(), { wrapper });

    await waitFor(() => expect(navCollapsed).toHaveBeenCalled());
    expect(result.current.collapsed).toBe(false);
  });

  /**
   * **A read that fails leaves the rail expanded, and nothing about it reaches the shell.**
   *
   * `nav_collapsed` is infallible at the far end, so what is left to fail is the IPC boundary
   * and a `BUSY` under a sync — a state the app spends whole minutes in on a first run. Neither
   * is worth a shell that will not draw. The query is driven all the way into `error` rather
   * than merely being observed for a beat, so this cannot pass on a read that had not answered
   * yet.
   */
  it("leaves the rail expanded when the preference cannot be read at all", async () => {
    navCollapsed.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    const { result } = renderHook(() => useNavCollapsed(), { wrapper });

    await waitFor(() => expect(client.getQueryState(NAV_COLLAPSED_KEY)?.status).toBe("error"));
    expect(result.current.collapsed).toBe(false);
  });

  /**
   * The rail folds on the press, not a round trip later.
   *
   * A fold is a direct manipulation, and a control that answers late reads as a control that did
   * not take — so the cache is written before the command is sent. The write here never settles,
   * which is what makes the claim a real one: a rail that waited on it would still be collapsed
   * at the end of this test.
   */
  it("moves before the write has answered", async () => {
    setNavCollapsed.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useNavCollapsed(), { wrapper });
    await waitFor(() => expect(result.current.collapsed).toBe(true));

    act(() => result.current.setCollapsed(false));

    await waitFor(() => expect(result.current.collapsed).toBe(false));
    expect(setNavCollapsed).toHaveBeenCalledWith(false);
  });

  /**
   * **A refused write keeps the reader's choice**, and says nothing.
   *
   * `set_nav_collapsed` answers `BUSY` while a sync holds the write connection. Snapping the
   * rail back open under the reader's hand in that window, with nothing on screen saying why,
   * is worse than losing one launch's memory of the fold.
   *
   * The mutation is driven into `error` before the assertion, so this is a settled rejection
   * rather than one still in flight — and a rejection that escaped the mutation would be an
   * unhandled rejection in this run rather than a silent pass.
   */
  it("keeps a fold a refused write never stored, and raises nothing", async () => {
    setNavCollapsed.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useNavCollapsed(), { wrapper });
    await waitFor(() => expect(result.current.collapsed).toBe(true));

    act(() => result.current.setCollapsed(false));

    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(result.current.collapsed).toBe(false);
  });
});
