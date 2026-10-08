import { renderHook, waitFor } from "@testing-library/react";
import { act, createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { oracleTagsForPrintings },
}));

import { ORACLE_TAGS_KEY } from "@/lib/useOracleTagProgress";
import { TAG_READ_CHUNK, useWallOracleTags } from "./useWallOracleTags";

let client: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client }, children);

/** The command's own contract: one entry per distinct id asked, in the order asked. */
const answering = (slugs: Record<string, string[]>) => (ids: string[]) =>
  Promise.resolve(ids.map((cardId) => ({ cardId, slugs: slugs[cardId] ?? [] })));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  oracleTagsForPrintings.mockReset().mockImplementation(answering({}));
});

describe("useWallOracleTags", () => {
  /**
   * **Not known and known-to-be-empty are two answers**, and the whole use of this hook is the
   * difference: a button names a pile for the second and not for the first.
   */
  it("holds nothing for a card until its read answers, and an empty list once it has", async () => {
    oracleTagsForPrintings.mockImplementation(answering({ sol: ["ramp"] }));
    const { result } = renderHook(() => useWallOracleTags(["sol", "bolt"], true), { wrapper });

    expect(result.current.get("sol")).toBeUndefined();
    expect(result.current.get("bolt")).toBeUndefined();

    await waitFor(() => expect(result.current.get("sol")).toEqual(["ramp"]));
    expect(result.current.get("bolt")).toEqual([]);
  });

  /** A deck that names its pile has answered already: off is no read at all. */
  it("reads nothing while it is off", async () => {
    const { result } = renderHook(() => useWallOracleTags(["sol"], false), { wrapper });

    await act(async () => {});

    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
    expect(result.current.get("sol")).toBeUndefined();
  });

  /**
   * The Collection tab draws a tile per printing **and finish**, so one card id heads two tiles —
   * and the command drops duplicates, which is why its answer is matched by id.
   */
  it("asks about each printing once however many tiles carry it", async () => {
    const { result } = renderHook(() => useWallOracleTags(["bolt", "bolt", "sol"], true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.get("sol")).toEqual([]));

    expect(oracleTagsForPrintings).toHaveBeenCalledTimes(1);
    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["bolt", "sol"]);
  });

  /**
   * **A page landing re-asks only about the cards it brought.** One key over every loaded id
   * would re-read the whole wall each time; a full chunk's key never changes.
   */
  it("does not re-read a full chunk when the wall grows", async () => {
    const first = Array.from({ length: TAG_READ_CHUNK }, (_, i) => `a${i}`);
    const second = ["b0", "b1"];
    const { result, rerender } = renderHook(({ ids }) => useWallOracleTags(ids, true), {
      wrapper,
      initialProps: { ids: first },
    });
    await waitFor(() => expect(result.current.get("a0")).toEqual([]));
    expect(oracleTagsForPrintings).toHaveBeenCalledTimes(1);

    rerender({ ids: [...first, ...second] });

    await waitFor(() => expect(result.current.get("b1")).toEqual([]));
    expect(oracleTagsForPrintings).toHaveBeenCalledTimes(2);
    expect(oracleTagsForPrintings).toHaveBeenLastCalledWith(second);
  });

  /**
   * **A tile that has been named keeps its pile while a longer list is read.** The last chunk is
   * part-full and its key changes as the wall grows; without the previous answer held, every tile
   * in it would lose its word for the length of the read.
   */
  it("keeps what it knew about a part-full chunk while the grown one is read", async () => {
    oracleTagsForPrintings.mockImplementation(answering({ sol: ["ramp"] }));
    const { result, rerender } = renderHook(({ ids }) => useWallOracleTags(ids, true), {
      wrapper,
      initialProps: { ids: ["sol"] },
    });
    await waitFor(() => expect(result.current.get("sol")).toEqual(["ramp"]));

    oracleTagsForPrintings.mockReturnValue(new Promise(() => {}));
    rerender({ ids: ["sol", "bolt"] });

    await waitFor(() => expect(oracleTagsForPrintings).toHaveBeenCalledTimes(2));
    expect(result.current.get("sol")).toEqual(["ramp"]);
    expect(result.current.get("bolt")).toBeUndefined();
  });

  /** A read that fails costs a word on a button and never a card: its ids just stay unknown. */
  it("leaves a card unknown when its read is refused", async () => {
    oracleTagsForPrintings.mockRejectedValue("The database is busy.");
    const { result } = renderHook(() => useWallOracleTags(["sol"], true), { wrapper });

    await waitFor(() => expect(oracleTagsForPrintings).toHaveBeenCalled());
    await act(async () => {});

    expect(result.current.get("sol")).toBeUndefined();
  });

  /**
   * An id the answer does not carry was still asked about — `useDeck`'s `oracleTagsFor` reads it
   * as no tags, and a label that came to a different answer than the press is the bug this hook
   * exists to end.
   */
  it("reads an id the answer left out as a card with no tags", async () => {
    oracleTagsForPrintings.mockResolvedValue([]);
    const { result } = renderHook(() => useWallOracleTags(["sol"], true), { wrapper });

    await waitFor(() => expect(result.current.get("sol")).toEqual([]));
  });

  /**
   * **Keyed under the taxonomy's own prefix**, which is what a finished refresh invalidates
   * (`useOracleTagProgress`): the tags have just been replaced under every pile a wall has named.
   */
  it("re-reads when the taxonomy's cache is invalidated", async () => {
    const { result } = renderHook(() => useWallOracleTags(["sol"], true), { wrapper });
    await waitFor(() => expect(result.current.get("sol")).toEqual([]));

    oracleTagsForPrintings.mockImplementation(answering({ sol: ["ramp"] }));
    await act(() => client.invalidateQueries({ queryKey: ORACLE_TAGS_KEY }));

    await waitFor(() => expect(result.current.get("sol")).toEqual(["ramp"]));
  });
});
