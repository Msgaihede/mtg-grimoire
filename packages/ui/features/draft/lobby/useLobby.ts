import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type LobbyKind, type LobbyState } from "@/lib/ipc";
import { SUPPORTER_KEY, supporterState } from "@/lib/query";
import { viewMemory } from "@/lib/viewMemory";

/** The cache entry the lobby lives in — read by the hub's *Draft in progress*, the lobby screen
 *  and the Playtesting setup alike, and written by every `lobby:state` push. */
export const LOBBY_KEY = ["draft", "lobby"] as const;

/**
 * The name the reader goes by in a lobby, for the window's life — one name for both kinds, so a
 * reader who drafted with their friends sits down to play them under the same one.
 */
export const lobbyNameMemory = viewMemory<string>("draft.lobbyName");

/** The six-character alphabet the relay draws a code from (spec §6): no `0`/`O`, no `1`/`I`. */
export const LOBBY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LOBBY_CODE_LENGTH = 6;

/** What the reader typed, as a code: upper-cased, every character outside the alphabet dropped,
 *  six at most — so a code pasted with a space or read out as lower case still joins. */
export function normalizeCode(text: string): string {
  return [...text.toUpperCase()]
    .filter((c) => LOBBY_ALPHABET.includes(c))
    .join("")
    .slice(0, LOBBY_CODE_LENGTH);
}

/**
 * This app's lobby, or `null` — the host's answer (`lobby_state`) once, then every
 * `lobby:state` push written into the same entry, so whoever is drawing it is drawing the latest.
 * `retry: false`: a refusal is a host without lobbies (a web build), said once.
 */
export function useLobbyState(): LobbyState | null {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: LOBBY_KEY,
    queryFn: () => ipc.lobbyState(),
    retry: false,
  });
  useEffect(
    () => ipc.onLobbyState((state) => client.setQueryData<LobbyState | null>(LOBBY_KEY, state)),
    [client],
  );
  return query.data ?? null;
}

/** A lobby still worth returning to: open, drafting, or playing. */
export function isLive(lobby: LobbyState | null): lobby is LobbyState {
  return lobby !== null && lobby.phase !== "closed";
}

/**
 * The lobby as a page of `kind` sees it: `null` for a lobby of the other kind (issue #1419) — the
 * Draft & Packs page leaves a game's lobby to Playtesting, and Playtesting a pod's to Draft &
 * Packs. **A guest's lobby whose kind is not known yet is either page's**: the room that says it
 * arrives a moment after the join, and the page that joined is the one drawing it then.
 */
export function lobbyFor(lobby: LobbyState | null, kind: LobbyKind): LobbyState | null {
  return lobby !== null && lobby.kind !== null && lobby.kind !== kind ? null : lobby;
}

/**
 * Whether this device may host a pod: **a supporter's, and no other** (the owner's rule, spec §6)
 * — a membership that reads `active` or `grace`, as `useMaySendScans` reads it, through the one key
 * and the one reading of its fields (`@/lib/query`). `unknown` is `false`, for that hook's reason:
 * a press drawn before the answer would flash at the reader the answer then takes it from.
 *
 * It gates the press, not the lobby: the host refuses `lobby_create` for a lapsed membership in
 * a sentence of its own, which the screen draws.
 */
export function useMayHostPod(): boolean {
  const supporter = useQuery({ queryKey: SUPPORTER_KEY, queryFn: () => ipc.syncSupporterStatus() });
  const membership = supporterState(supporter.data ?? null);
  return membership === "active" || membership === "grace";
}
