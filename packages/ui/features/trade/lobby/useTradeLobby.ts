import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lobbyFor, useLobbyState } from "@/features/draft/lobby/useLobby";
import { ipc, ipcError, type LobbyState, type LobbyTrade, type Trade } from "@/lib/ipc";
import { useReaches } from "@/lib/reach";
import { linesOf } from "../trade";
import { TRADE_KEY } from "../useTrades";

/**
 * **A trade over a lobby**, the Trade page's half: two readers, each on their own app, building
 * one trade — the lobby a pod drafts in and a game is played over (`features/draft/lobby/`),
 * opened for a trade (`LobbyKind` `trade`). Each reader keeps their own copy of the trade, an
 * ordinary open trade: their side is what they offer, and the other side is what the other
 * reader offers, written into it by the host app each time their offer moves. Both accept, and
 * each finishes their own copy with Finish trade, as they would a trade made at a table.
 */

/** A lobby of this page's: a trade's, with this reader's copy of the trade in it. */
export type TradeLobby = LobbyState & { trade: LobbyTrade };

/**
 * Whether this window can meet anybody in a lobby. **The lobby is the desktop's** — its commands
 * are registered beside Draft & Packs, which no light host draws — so a window that has that page
 * has lobbies, and one without it has none to offer a trade in.
 */
export function useLobbiesHere(): boolean {
  return useReaches("draft");
}

/** The lobby as this page sees it: a trade's, or a guest's whose kind is not known yet, joined
 *  from here with a trade to hold. A draft's or a game's is another page's. */
export function tradeLobbyOf(lobby: LobbyState | null): TradeLobby | null {
  const ours = lobbyFor(lobby, "trade");
  return ours !== null && ours.trade !== null ? (ours as TradeLobby) : null;
}

/**
 * This app's trade lobby, or `null` — and **every push read as the other side moving**: the host
 * app writes the other reader's offer into this reader's copy of the trade and then says so, so
 * each `lobby:state` of a trade's lobby asks the trade again.
 */
export function useTradeLobby(): TradeLobby | null {
  const lobby = tradeLobbyOf(useLobbyState());
  const client = useQueryClient();
  useEffect(() => {
    if (lobby !== null) void client.invalidateQueries({ queryKey: TRADE_KEY });
  }, [client, lobby]);
  return lobby;
}

/** Whether this reader has accepted the deal on the table. */
export function youAccepted(lobby: TradeLobby): boolean {
  return lobby.role === "host" ? lobby.trade.deal.hostAccepted : lobby.trade.deal.guestAccepted;
}

/** Whether the other reader has. */
export function theyAccepted(lobby: TradeLobby): boolean {
  return lobby.role === "host" ? lobby.trade.deal.guestAccepted : lobby.trade.deal.hostAccepted;
}

/** The other reader, as far as this app knows them: their name and whether they are on the line.
 *  `null` for a host nobody has joined yet. */
export function otherReader(lobby: TradeLobby): { name: string; online: boolean } | null {
  if (lobby.role === "guest") {
    return { name: lobby.hostName || "The host", online: lobby.hostOnline };
  }
  const first = lobby.peers[0];
  return first === undefined ? null : { name: first.name, online: first.online };
}

/** This reader's side of `trade` as it crosses: printing, finish and count, in the trade's order
 *  — what changes when their offer does, and nothing else. */
export function offerKey(trade: Trade): string {
  return linesOf(trade.lines, "mine")
    .map((line) => `${line.cardId}|${line.finish}|${line.quantity}`)
    .join(",");
}

/**
 * **Send this reader's offer whenever it may have moved**: their copy's side changed, the lobby
 * opened again after a drop, or — for a guest — the host came back on the line, since a guest's
 * message to a host that is away is dropped by the relay. The host's app compares the offer with
 * the one it holds, so one sent again unchanged accepts nothing away. Answers the refusal, if the
 * last send had one.
 */
export function useSendOffer(lobby: TradeLobby | null, trade: Trade | null): string | null {
  const [failure, setFailure] = useState<string | null>(null);
  const key =
    lobby !== null &&
    trade !== null &&
    trade.id === lobby.trade.tradeId &&
    trade.status === "open" &&
    lobby.phase === "open"
      ? offerKey(trade)
      : null;
  const reachable = lobby === null || lobby.role === "host" || lobby.hostOnline;
  const code = lobby?.code ?? null;
  useEffect(() => {
    if (key === null || !reachable) return;
    let current = true;
    ipc.lobbyTradeOffer().then(
      () => {
        if (current) setFailure(null);
      },
      (e: unknown) => {
        if (current) setFailure(ipcError(e));
      },
    );
    return () => {
      current = false;
    };
  }, [key, reachable, code]);
  return key === null ? null : failure;
}
