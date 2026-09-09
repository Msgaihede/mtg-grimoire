/**
 * Somebody else's binder, fetched.
 *
 * One command, one parse and no second implementation of the format: everything this hook knows
 * about what a snapshot is comes from `@/lib/shareSnapshot`, which is the module both viewers
 * read it through.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const shareOpen = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareOpen },
}));

import golden from "../../../src-tauri/src/share/__golden__/snapshot.json?raw";
import { SNAPSHOT_TOO_NEW, SNAPSHOT_VERSION } from "@/lib/shareSnapshot";
import { shareSnapshotKey, useSharedSnapshot } from "./useSharedSnapshot";

const LINK = "https://share.example/s/testshareid00000";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("a shared snapshot", () => {
  /**
   * `share_open` answers `serde_json::Value`, so what arrives here is already an object.
   * Re-serialising it to hand `parseSnapshot` a string would cost a round trip through JSON over
   * the measured 2.07 MB a 50 000-card binder weighs, for a value that is already in hand.
   */
  it("parses what the command already parsed", async () => {
    shareOpen.mockResolvedValue(JSON.parse(golden));
    const { result } = renderHook(() => useSharedSnapshot(LINK), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.owner).toBe("Giradeli");
    expect(result.current.data?.cards).toHaveLength(2);
    expect(shareOpen).toHaveBeenCalledWith(LINK);
  });

  it("files each link under its own key", async () => {
    shareOpen.mockResolvedValue(JSON.parse(golden));
    const { result } = renderHook(() => useSharedSnapshot(LINK), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(client.getQueryData(shareSnapshotKey(LINK))).toBeDefined();
    expect(client.getQueryData(shareSnapshotKey("https://share.example/s/other"))).toBeUndefined();
  });

  it("fetches nothing until there is a link to fetch", async () => {
    const { result } = renderHook(() => useSharedSnapshot(null), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(shareOpen).not.toHaveBeenCalled();
  });

  /**
   * A document this build cannot read is named rather than drawn half-way, and the sentence is
   * the format module's — not one spelled here, which would be a second vocabulary for one
   * refusal.
   */
  it("names a snapshot published by a newer build", async () => {
    shareOpen.mockResolvedValue({ ...JSON.parse(golden), v: SNAPSHOT_VERSION + 1 });
    const { result } = renderHook(() => useSharedSnapshot(LINK), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error)).toContain(SNAPSHOT_TOO_NEW);
  });

  /**
   * The crate's refusals are sentences a reader can act on — *withdrawn*, *no longer
   * available*, *not a shared collection link* — and every one of them is terminal. A retry
   * spends a second request to be told the same thing, which is what the app's default
   * `retry: 1` would do to every one of them.
   */
  it("asks once and reports the refusal", async () => {
    client = new QueryClient();
    shareOpen.mockRejectedValue("That shared collection is no longer available.");
    const { result } = renderHook(() => useSharedSnapshot(LINK), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(shareOpen).toHaveBeenCalledTimes(1);
  });
});
