import { describe, expect, it } from "vitest";
import type { DeckRow, LobbyPeer, LobbyState } from "@/lib/ipc";
import { lobbyGameSeats, lobbyReadiness, lobbySeats, unseated, type SeatDeck } from "./table";

const peer = (name: string, over: Partial<LobbyPeer> = {}): LobbyPeer => ({
  peer: `p-${name}`,
  name,
  online: true,
  deck: `${name}'s deck`,
  ...over,
});

const lobby = (peers: LobbyPeer[], over: Partial<LobbyState> = {}): LobbyState => ({
  role: "host",
  kind: "game",
  code: "K7QX2M",
  phase: "open",
  name: "Ada",
  hostName: "Ada",
  hostOnline: true,
  peers,
  label: "",
  closedReason: null,
  trade: null,
  ...over,
});

const deck = (id: number, name: string) => ({ id, name }) as DeckRow;
const yours = deck(1, "Simic Tempo");
const ai =
  (decks: Record<number, DeckRow>) =>
  (seat: number): SeatDeck | undefined =>
    decks[seat] === undefined ? undefined : { deck: decks[seat], variant: "live" };

describe("a lobby game's seats", () => {
  it("seats the guests in join order after the host, and the AI in the seats left over", () => {
    const seats = lobbySeats([peer("Bea"), peer("Cy")], 3);
    expect(seats).toEqual([
      { kind: "guest", peer: peer("Bea") },
      { kind: "guest", peer: peer("Cy") },
      { kind: "ai", seat: 3 },
    ]);
    expect(lobbySeats([peer("Bea"), peer("Cy")], 1)).toEqual([
      { kind: "guest", peer: peer("Bea") },
    ]);
    expect(unseated([peer("Bea"), peer("Cy")], 1)).toEqual([peer("Cy")]);
  });

  it("deals each guest by peer and each AI seat by deck, named for the plates", () => {
    const seats = lobbySeats([peer("Bea")], 3);
    expect(lobbyGameSeats(seats, ai({ 2: deck(9, "Boros Aggro") }))).toBeNull();
    expect(
      lobbyGameSeats(seats, ai({ 2: deck(9, "Boros Aggro"), 3: deck(11, "Kenrith Pod") })),
    ).toEqual({
      seats: [
        { peer: "p-Bea", deckId: null, variant: null },
        { peer: null, deckId: 9, variant: "live" },
        { peer: null, deckId: 11, variant: "live" },
      ],
      names: ["Bea", "Boros Aggro", "Kenrith Pod"],
    });
  });
});

describe("the host's Start", () => {
  const ready = (state: LobbyState, table: "duel" | "fourPlayer" = "duel", decks = {}) =>
    lobbyReadiness({ lobby: state, table, yours, aiDeck: ai(decks) });

  it("deals a duel once the host and the guest both have a deck", () => {
    expect(ready(lobby([peer("Bea")]))).toEqual({ ready: true, hint: null });
    expect(ready(lobby([peer("Bea", { deck: null })]))).toEqual({
      ready: false,
      hint: "Waiting for Bea to pick a deck.",
    });
    expect(
      lobbyReadiness({
        lobby: lobby([peer("Bea")]),
        table: "duel",
        yours: undefined,
        aiDeck: ai({}),
      }),
    ).toEqual({ ready: false, hint: "Pick your deck to start." });
  });

  it("waits for somebody to join, and for the lobby to connect", () => {
    expect(ready(lobby([]))).toEqual({
      ready: false,
      hint: "Share the code: a game needs someone to join it.",
    });
    expect(ready(lobby([peer("Bea")], { phase: "connecting" })).hint).toBe(
      "Connecting to the lobby…",
    );
    expect(ready(lobby([peer("Bea")], { phase: "playing" })).ready).toBe(false);
  });

  it("fills a four-player table's empty seats from the wall before it deals", () => {
    const state = lobby([peer("Bea")]);
    expect(ready(state, "fourPlayer", { 2: deck(9, "Boros Aggro") })).toEqual({
      ready: false,
      hint: "Pick a deck for Opponent 3 to start.",
    });
    expect(
      ready(state, "fourPlayer", { 2: deck(9, "Boros Aggro"), 3: deck(9, "Boros Aggro") }).ready,
    ).toBe(true);
  });

  it("seats no more people than the table has room for", () => {
    expect(ready(lobby([peer("Bea"), peer("Cy")]))).toEqual({
      ready: false,
      hint: "3 people are in; a duel seats 2.",
    });
    expect(ready(lobby([peer("Bea"), peer("Cy")]), "fourPlayer", { 3: yours }).ready).toBe(true);
  });
});
