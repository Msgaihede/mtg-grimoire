/**
 * The group's own published shares.
 *
 * A thin read, and the only one of the five `share_*` commands that reconciles against the relay
 * before answering — which is why it is a query at all rather than something the publish dialog
 * holds: two surfaces read this list (the cabinet's Share control, and this view's *published by
 * you* mark) and neither owns it.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const shareList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareList },
}));

import type { ShareRow } from "@/lib/ipc";
import { SHARE_KEY, SHARE_LIST_KEY, useShares } from "./useShares";

const row: ShareRow = {
  id: "testshareid00000",
  folderUid: "uid-Trade binder",
  title: "Trade binder",
  ownerName: "Giradeli",
  url: "https://share.example/s/testshareid00000",
  fields: ["condition"],
  state: "live",
  published: 1757308800,
  updatedAt: 1757308800,
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("the published shares", () => {
  it("reads the list and files it under the share root", async () => {
    shareList.mockResolvedValue([row]);
    const { result } = renderHook(() => useShares(true), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual([row]));
    expect(client.getQueryData(SHARE_LIST_KEY)).toEqual([row]);
  });

  /**
   * ⚠️ **The command behind this holds the write connection across a relay round trip**, so who
   * asks and how often is not a question about what the control draws.
   *
   * `share::commands::share_list` runs inside `on_the_write_connection` → `sync::with_write`,
   * which takes the exclusive write lock; every other user write then answers `BUSY` after
   * `WRITE_LOCK_WAIT` (5 s), against a share client whose read timeout is 60. That is `sync_now`'s
   * shape and `sync_now` is a **press** — this is a query mounted with the whole Collection page.
   */
  it("asks nothing at all on a device that has connected nothing", async () => {
    shareList.mockResolvedValue([row]);
    const { result } = renderHook(() => useShares(false), { wrapper });

    // Given a tick to be wrong in: a query that was going to fetch would have by now.
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(shareList).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same trip. TanStack refetches on window focus by **default**, so on a
   * connected device every alt-tab back to the Collection page held the write connection for a
   * relay round trip. The list changes on a press — publish, revoke — and both of those
   * invalidate {@link SHARE_KEY} themselves.
   */
  it("does not ask again when the window regains focus", async () => {
    shareList.mockResolvedValue([row]);
    const { result } = renderHook(() => useShares(true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([row]));
    expect(shareList).toHaveBeenCalledTimes(1);

    // The query is stale the moment it lands — this client sets no `staleTime` — so a refetch on
    // focus is exactly what the default would do here.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(shareList).toHaveBeenCalledTimes(1);
  });

  /**
   * The list and every fetched snapshot sit under one root, so a publish or a revoke can
   * invalidate `["share"]` and reach both — `invalidateQueries` matches by prefix, and a
   * writer that had to name each leaf is a writer that will forget one.
   */
  it("sits under a root a write can invalidate whole", () => {
    expect(SHARE_LIST_KEY.slice(0, SHARE_KEY.length)).toEqual(SHARE_KEY);
  });
});
