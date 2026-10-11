import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trade, TradeSummary } from "@/lib/ipc";

const ipcMock = vi.hoisted(() => ({
  tradeCreate: vi.fn(),
  tradeDuplicate: vi.fn(),
  tradeDelete: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...real, ipc: { ...real.ipc, ...ipcMock } };
});

import { TRADE_LIST_KEY, tradeKey, tradeWrites } from "./useTrades";

function summary(id: number): TradeSummary {
  return {
    id,
    name: `Trade ${id}`,
    marketplace: "tcgplayer",
    rateMine: 100,
    rateTheirs: 100,
    status: "open",
    createdAt: 0,
    closedAt: null,
    lines: [],
  };
}
const whole = (id: number): Trade => ({
  ...summary(id),
  finishedBefore: false,
  outcome: null,
  lines: [],
});

/**
 * **A trade's id is handed out again.** `trades.id` is a plain `INTEGER PRIMARY KEY`, so deleting
 * the newest trade gives its number to the next one made. What the cache holds under that number
 * is then about a trade that is gone — "no such trade", if a page looked once more on its way out
 * — and both faces read it as the new trade's own answer. These are the two ends of an id's life
 * where the cache has to let go of it.
 */
describe("a trade's own read, across a delete and the next create", () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    ipcMock.tradeCreate.mockReset().mockResolvedValue(5);
    ipcMock.tradeDuplicate.mockReset().mockResolvedValue(5);
    ipcMock.tradeDelete.mockReset().mockResolvedValue(undefined);
  });

  it("drops a deleted trade's read, and takes it out of the list at once", async () => {
    client.setQueryData(tradeKey(5), whole(5));
    client.setQueryData(tradeKey(4), whole(4));
    client.setQueryData(TRADE_LIST_KEY, [summary(5), summary(4)]);

    await tradeWrites(client).remove(5);

    expect(ipcMock.tradeDelete).toHaveBeenCalledExactlyOnceWith(5);
    // Not `null` and not the old trade: nothing at all, so the next read of 5 is a first read.
    expect(client.getQueryState(tradeKey(5))).toBeUndefined();
    expect(client.getQueryData(tradeKey(4))).toEqual(whole(4));
    expect(client.getQueryData<TradeSummary[]>(TRADE_LIST_KEY)?.map((t) => t.id)).toEqual([4]);
  });

  it("keeps the read and the list when the delete is refused", async () => {
    ipcMock.tradeDelete.mockRejectedValue("database is locked");
    client.setQueryData(tradeKey(5), whole(5));
    client.setQueryData(TRADE_LIST_KEY, [summary(5), summary(4)]);

    await expect(tradeWrites(client).remove(5)).rejects.toBe("database is locked");

    expect(client.getQueryData(tradeKey(5))).toEqual(whole(5));
    expect(client.getQueryData<TradeSummary[]>(TRADE_LIST_KEY)?.map((t) => t.id)).toEqual([5, 4]);
  });

  it("forgets what was known about an id before handing it to a new trade", async () => {
    // A page that was still on the deleted trade asked once more, and was told it is gone.
    client.setQueryData(tradeKey(5), null);

    await expect(tradeWrites(client).create({ marketplace: "tcgplayer" })).resolves.toBe(5);

    // `undefined` is "not answered yet"; `null` would be "this trade is gone".
    expect(client.getQueryData(tradeKey(5))).toBeUndefined();
    expect(client.getQueryState(tradeKey(5))).toBeUndefined();
  });

  it("forgets it for a copy too", async () => {
    client.setQueryData(tradeKey(5), null);
    client.setQueryData(tradeKey(4), whole(4));

    await expect(tradeWrites(client).duplicate(4)).resolves.toBe(5);

    expect(client.getQueryState(tradeKey(5))).toBeUndefined();
    // The trade it was copied from is still what it was.
    expect(client.getQueryData(tradeKey(4))).toEqual(whole(4));
  });
});
