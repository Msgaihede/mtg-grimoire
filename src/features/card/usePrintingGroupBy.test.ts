import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const printingGroupBy = vi.hoisted(() => vi.fn());
const setPrintingGroupBy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { printingGroupBy, setPrintingGroupBy },
}));

import { PRINTING_GROUP_BY_KEY, usePrintingGroupBy } from "./usePrintingGroupBy";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who has chosen something other than the default, which is the case that proves
  // the row is read at all rather than the fallback being right by accident.
  printingGroupBy.mockReset().mockResolvedValue("set");
  setPrintingGroupBy.mockReset().mockResolvedValue(undefined);
});

/**
 * The card pane's grouping preference: one `app_meta` row, read once per app run and written
 * optimistically.
 *
 * Everything below is about the two ends this setting can fail at, because neither of them is
 * allowed to cost the reader a card pane — the list they are looking at is the point, and the
 * order it is in is a preference.
 */
describe("usePrintingGroupBy", () => {
  it("opens on the mode the last run stored", async () => {
    const { result } = renderHook(() => usePrintingGroupBy(), { wrapper });

    await waitFor(() => expect(result.current.mode).toBe("set"));
  });

  /**
   * A mode this build has never heard of is the default, and it is not an error.
   *
   * The row outlives the build that wrote it: a mode that is renamed or dropped goes on sitting
   * in `app_meta` for as long as that row survives, and the reader's next launch would otherwise
   * be a pane grouped by nothing. The raw string is asserted from the cache as well, because the
   * narrowing is the hook's and must not be mistaken for the backend having answered `artist`.
   */
  it("falls back to the default when the stored row is a mode this build does not know", async () => {
    printingGroupBy.mockResolvedValue("illustration");

    const { result } = renderHook(() => usePrintingGroupBy(), { wrapper });

    await waitFor(() =>
      expect(client.getQueryState(PRINTING_GROUP_BY_KEY)?.data).toBe("illustration"),
    );
    expect(result.current.mode).toBe("artist");
  });

  /**
   * **A read that fails is the default, and nothing about it reaches the pane.**
   *
   * The command answers `BUSY` while a sync holds the write connection, which is a state the app
   * spends whole minutes in on a first run — and the visible symptom of surfacing that would be
   * a grey unsorted list under a card the reader can otherwise see perfectly well. The query is
   * driven all the way into `error` rather than merely being observed for a beat, so this cannot
   * pass on a read that had not answered yet.
   */
  it("is the default when the preference cannot be read at all", async () => {
    printingGroupBy.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    const { result } = renderHook(() => usePrintingGroupBy(), { wrapper });

    await waitFor(() =>
      expect(client.getQueryState(PRINTING_GROUP_BY_KEY)?.status).toBe("error"),
    );
    expect(result.current.mode).toBe("artist");
  });

  /**
   * The list re-orders on the press, not a round trip later.
   *
   * The whole point of the control is a reader hunting through forty printings who wants a
   * different order *now*, so the cache is written before the command is sent. The write here
   * never settles, which is what makes the claim a real one: a mode that waited on it would
   * still be `set` at the end of this test.
   */
  it("moves to the chosen mode before the write has answered", async () => {
    setPrintingGroupBy.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePrintingGroupBy(), { wrapper });
    await waitFor(() => expect(result.current.mode).toBe("set"));

    act(() => result.current.setMode("price"));

    await waitFor(() => expect(result.current.mode).toBe("price"));
    expect(setPrintingGroupBy).toHaveBeenCalledWith("price");
  });

  /**
   * **A refused write keeps the reader's choice**, and says nothing.
   *
   * `set_printing_group_by` answers `BUSY` while a sync holds the write connection. Rolling the
   * selector back in that window would be the worst of both: the order they asked for flicking
   * back under their hand, with nothing on screen saying why, in a pane whose only real job is
   * showing a card. What is lost is only that the next launch opens on the mode before it.
   *
   * The mutation is driven into `error` before the assertion, so this is a settled rejection
   * rather than one still in flight — and a rejection that escaped the mutation would be an
   * unhandled rejection in this run rather than a silent pass.
   */
  it("keeps the mode a refused write never stored, and raises nothing", async () => {
    setPrintingGroupBy.mockRejectedValue(
      "The database is busy with a sync — try again in a moment.",
    );
    const { result } = renderHook(() => usePrintingGroupBy(), { wrapper });
    await waitFor(() => expect(result.current.mode).toBe("set"));

    act(() => result.current.setMode("price"));

    await waitFor(() =>
      expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"),
    );
    expect(result.current.mode).toBe("price");
  });
});
