/**
 * The group's own published shares.
 *
 * A thin read, and the only one of the five `share_*` commands that reconciles against the relay
 * before answering — which is why it is a query at all rather than something the publish dialog
 * holds: two surfaces read this list (the cabinet's Share control, and this view's *published by
 * you* mark) and neither owns it.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    const { result } = renderHook(() => useShares(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual([row]));
    expect(client.getQueryData(SHARE_LIST_KEY)).toEqual([row]);
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
