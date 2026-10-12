import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type {
  Trade,
  TradeCreate,
  TradeFinishOptions,
  TradeLineChange,
  TradeLineInput,
  TradeOutcome,
  TradeSide,
  TradeSummary,
} from "@/lib/ipc";
import { invalidateOwnedWrite } from "@/lib/searchMarks";

/**
 * Reading and writing trades, for both faces.
 *
 * **One root, `["trade"]`.** `@/lib/crossWindow`'s `TABLE_KEYS` points both trade tables at it,
 * and the collection and the wishlist too, because a line says how many copies the collection
 * could give and whether its card is wished for.
 *
 * **Both reads are stale at once (`staleTime: 0`).** Those two marks change on pages that know
 * nothing about trades, and within one window nothing tells this root so — so the Trade page asks
 * again whenever it mounts rather than trusting an answer from before the reader went and moved a
 * card. Two small reads; the price is nothing.
 */
export const TRADE_KEY = ["trade"] as const;
export const TRADE_LIST_KEY = ["trade", "list"] as const;

export function tradeKey(id: number): readonly ["trade", "detail", number] {
  return ["trade", "detail", id];
}

export function useTradeList() {
  return useQuery({ queryKey: TRADE_LIST_KEY, queryFn: () => ipc.tradeList(), staleTime: 0 });
}

/** One trade. `null` asks for nothing; a trade that is gone answers `null`. */
export function useTrade(id: number | null) {
  return useQuery({
    queryKey: tradeKey(id ?? 0),
    queryFn: () => (id === null ? Promise.resolve(null) : ipc.tradeGet(id)),
    enabled: id !== null,
    staleTime: 0,
  });
}

/**
 * How many trade writes are in the air, per client.
 *
 * **A write settles the root only when it is the last one out.** A stepper pressed three times is
 * three writes; a refetch fired by the first would land between the second and third and draw the
 * quantity the reader has already moved past. Counting them and settling once is what keeps the
 * figure from stepping backwards under a fast hand.
 */
const inFlight = new WeakMap<QueryClient, number>();

async function write<T>(
  client: QueryClient,
  run: () => Promise<T>,
  options: { patch?: () => void; owned?: boolean } = {},
): Promise<T> {
  inFlight.set(client, (inFlight.get(client) ?? 0) + 1);
  if (options.patch) {
    // A read already on its way would overwrite the patch with the answer from before the write.
    await client.cancelQueries({ queryKey: TRADE_KEY });
    options.patch();
  }
  try {
    return await run();
  } finally {
    const left = (inFlight.get(client) ?? 1) - 1;
    inFlight.set(client, left);
    // On a failure this is also the undo: the patch is replaced by what is actually stored.
    if (left === 0) void client.invalidateQueries({ queryKey: TRADE_KEY });
    if (options.owned) invalidateOwnedWrite(client);
  }
}

function patchTrade(client: QueryClient, id: number, change: (trade: Trade) => Trade): void {
  client.setQueryData<Trade | null>(tradeKey(id), (trade) => (trade ? change(trade) : trade));
}

function patchSummary(
  client: QueryClient,
  id: number,
  change: (trade: TradeSummary) => TradeSummary,
): void {
  client.setQueryData<TradeSummary[]>(TRADE_LIST_KEY, (list) =>
    list?.map((trade) => (trade.id === id ? change(trade) : trade)),
  );
}

/**
 * Forget what the cache holds about one trade's own read.
 *
 * **A trade's id is not its own for ever.** `trades.id` is a plain `INTEGER PRIMARY KEY`, so the
 * highest id is handed out again once its trade is deleted: delete Trade 5, press New trade, and
 * the new trade is 5. A read of the old one that answered "no such trade" would then be standing
 * in the cache under the new one's key, and both faces would say a trade made a moment ago is
 * gone. So the entry is dropped at both ends of an id's life — when its trade is deleted, and
 * again when a create or a duplicate answers with it, because a page still looking at a deleted
 * trade can ask about it once more on its way out and put the `null` straight back.
 */
function forgetTrade(client: QueryClient, id: number): void {
  client.removeQueries({ queryKey: tradeKey(id), exact: true });
}

/**
 * Every write a trade has. Each answers a promise that rejects with the backend's own sentence,
 * so the caller decides where a refusal is drawn.
 *
 * Four of them patch the cache before they are answered — the percentage, a line's change, a
 * line's removal and the swap — because each sits under a control the reader is still holding.
 */
export interface TradeWrites {
  create(trade: TradeCreate): Promise<number>;
  rename(id: number, name: string): Promise<void>;
  setRate(id: number, side: TradeSide, rate: number): Promise<void>;
  addLines(id: number, side: TradeSide, lines: TradeLineInput[]): Promise<void>;
  /** `tradeId` is whose cache to patch; the write itself names only the line. */
  updateLine(tradeId: number, lineId: number, change: TradeLineChange): Promise<void>;
  removeLine(tradeId: number, lineId: number): Promise<void>;
  /** Every line onto the other side. */
  swapSides(id: number): Promise<void>;
  finish(id: number, options: TradeFinishOptions): Promise<TradeOutcome>;
  archive(id: number): Promise<void>;
  reopen(id: number): Promise<void>;
  duplicate(id: number): Promise<number>;
  remove(id: number): Promise<void>;
}

export function tradeWrites(client: QueryClient): TradeWrites {
  return {
    create: (trade) =>
      write(client, () => ipc.tradeCreate(trade)).then((id) => {
        forgetTrade(client, id);
        return id;
      }),
    rename: (id, name) => write(client, () => ipc.tradeRename(id, name)),
    setRate: (id, side, rate) =>
      write(client, () => ipc.tradeSetRate(id, side, rate), {
        patch: () => {
          const change = side === "mine" ? { rateMine: rate } : { rateTheirs: rate };
          patchTrade(client, id, (trade) => ({ ...trade, ...change }));
          patchSummary(client, id, (trade) => ({ ...trade, ...change }));
        },
      }),
    addLines: (id, side, lines) => write(client, () => ipc.tradeAddLines(id, side, lines)),
    updateLine: (tradeId, lineId, change) =>
      write(client, () => ipc.tradeUpdateLine(lineId, change), {
        // A new printing brings facts only the backend has, so it is left to the refetch.
        patch:
          change.cardId === undefined
            ? () =>
                patchTrade(client, tradeId, (trade) => ({
                  ...trade,
                  lines: trade.lines.map((line) => {
                    if (line.id !== lineId) return line;
                    const finish = change.finish ?? line.finish;
                    return {
                      ...line,
                      finish,
                      quantity: change.quantity ?? line.quantity,
                      side: change.side ?? line.side,
                      unitPrice:
                        change.finish === undefined ? line.unitPrice : line.finishPrices[finish],
                    };
                  }),
                }))
            : undefined,
      }),
    removeLine: (tradeId, lineId) =>
      write(client, () => ipc.tradeRemoveLine(lineId), {
        patch: () =>
          patchTrade(client, tradeId, (trade) => ({
            ...trade,
            lines: trade.lines.filter((line) => line.id !== lineId),
          })),
      }),
    swapSides: (id) =>
      write(client, () => ipc.tradeSwapSides(id), {
        patch: () =>
          patchTrade(client, id, (trade) => ({
            ...trade,
            lines: trade.lines.map((line) => ({
              ...line,
              side: line.side === "mine" ? "theirs" : "mine",
            })),
          })),
      }),
    // The one write that reaches past the trade: it moves cards in the collection and the wishlist.
    finish: (id, options) => write(client, () => ipc.tradeFinish(id, options), { owned: true }),
    archive: (id) => write(client, () => ipc.tradeArchive(id)),
    reopen: (id) => write(client, () => ipc.tradeReopen(id)),
    duplicate: (id) =>
      write(client, () => ipc.tradeDuplicate(id)).then((copy) => {
        forgetTrade(client, copy);
        return copy;
      }),
    remove: (id) =>
      write(client, () => ipc.tradeDelete(id)).then(() => {
        forgetTrade(client, id);
        // Out of the list too, without waiting for the read the write has just asked for: the
        // list a page draws next must not offer a trade the backend has said is deleted.
        client.setQueryData<TradeSummary[]>(TRADE_LIST_KEY, (list) =>
          list?.filter((trade) => trade.id !== id),
        );
      }),
  };
}

export function useTradeWrites(): TradeWrites {
  const client = useQueryClient();
  return useMemo(() => tradeWrites(client), [client]);
}
