/**
 * Keeping this device's shares current — issue #1025.
 *
 * The crate decides what is due; what this hook owns is *when* it asks, *who* asks, and what the
 * answer does to the list the Share control draws.
 */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const shareAutoUpdate = vi.hoisted(() => vi.fn());
const shareList = vi.hoisted(() => vi.fn());
const syncSupporterStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareAutoUpdate, shareList, syncSupporterStatus },
}));

import type { ShareRow, SupporterStatus } from "@/lib/ipc";
import {
  AUTO_UPDATE_EVERY_MS,
  AUTO_UPDATE_FIRST_MS,
  useShareAutoUpdate,
} from "./useShareAutoUpdate";
import { SHARE_LIST_KEY } from "@/features/share/useShares";

const row = (over: Partial<ShareRow> = {}): ShareRow => ({
  id: "testshareid00000",
  folderUid: "uid-Trade binder",
  title: "Trade binder",
  ownerName: "Giradeli",
  url: "https://share.example/s/testshareid00000",
  fields: [],
  state: "live",
  published: 1_757_000_000,
  updatedAt: 1_757_000_000,
  ...over,
});

const SUPPORTING: SupporterStatus = {
  entitled: true,
  status: "active",
  since: 1_750_000_000,
  groupBound: true,
};
const NOTHING_CONNECTED: SupporterStatus = {
  entitled: false,
  status: "dead",
  since: null,
  groupBound: false,
};

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Let the membership read land, then move the clock. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  shareAutoUpdate.mockResolvedValue([]);
  syncSupporterStatus.mockResolvedValue(SUPPORTING);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the share auto-update pass", () => {
  it("asks once shortly after launch and then on every interval", async () => {
    renderHook(() => useShareAutoUpdate(true), { wrapper });

    await advance(AUTO_UPDATE_FIRST_MS - 1);
    expect(shareAutoUpdate).not.toHaveBeenCalled();
    await advance(1);
    expect(shareAutoUpdate).toHaveBeenCalledTimes(1);
    await advance(AUTO_UPDATE_EVERY_MS - AUTO_UPDATE_FIRST_MS);
    expect(shareAutoUpdate).toHaveBeenCalledTimes(2);
    await advance(AUTO_UPDATE_EVERY_MS);
    expect(shareAutoUpdate).toHaveBeenCalledTimes(3);
  });

  /** An unconnected reader has no shares to keep, and the light app has no command to ask. */
  it.each([
    ["a reader who has connected nothing", true, NOTHING_CONNECTED],
    ["a window that cannot publish", false, SUPPORTING],
  ] as const)("asks nothing for %s", async (_, publishes, status) => {
    syncSupporterStatus.mockResolvedValue(status);
    renderHook(() => useShareAutoUpdate(publishes), { wrapper });

    await advance(AUTO_UPDATE_EVERY_MS * 2);
    expect(shareAutoUpdate).not.toHaveBeenCalled();
  });

  /**
   * **Patched, not invalidated**: re-reading the list is `share_list`, the one share read that
   * reconciles against the relay while holding the write connection.
   */
  it("patches the updated rows into the share list without asking for it again", async () => {
    const stale = row();
    const other = row({ id: "othershareid0000", folderUid: "uid-Spares", title: "Spares" });
    client.setQueryData(SHARE_LIST_KEY, [stale, other]);
    const fresh = row({ published: 1_757_999_999, updatedAt: 1_757_999_999 });
    shareAutoUpdate.mockResolvedValue([fresh]);

    renderHook(() => useShareAutoUpdate(true), { wrapper });
    await advance(AUTO_UPDATE_FIRST_MS);

    expect(client.getQueryData(SHARE_LIST_KEY)).toEqual([fresh, other]);
    expect(shareList).not.toHaveBeenCalled();
  });

  /** Nothing the reader pressed failed, so a refused pass is swallowed and the timer goes on. */
  it("keeps going after a pass that failed", async () => {
    shareAutoUpdate.mockRejectedValueOnce("database is busy");
    renderHook(() => useShareAutoUpdate(true), { wrapper });

    await advance(AUTO_UPDATE_FIRST_MS);
    await advance(AUTO_UPDATE_EVERY_MS);
    expect(shareAutoUpdate).toHaveBeenCalledTimes(2);
  });

  it("stops asking once unmounted", async () => {
    const { unmount } = renderHook(() => useShareAutoUpdate(true), { wrapper });
    await advance(AUTO_UPDATE_FIRST_MS);
    unmount();

    await advance(AUTO_UPDATE_EVERY_MS * 3);
    expect(shareAutoUpdate).toHaveBeenCalledTimes(1);
  });
});
