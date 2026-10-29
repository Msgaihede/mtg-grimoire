import type { DeckRow, DeckVariant, LobbyGameSeat, LobbyPeer, LobbyState } from "@/lib/ipc";

/**
 * **A game's table in a lobby** (issue #1419): who sits where, and when the host may deal.
 *
 * The host sits first, as on the setup page; then the opponent seats in turn order after them,
 * **the lobby's guests first, in the order they joined** (`LobbyState.peers`), and any seat left
 * over — a four-player table with one or two guests — is one of the host's own decks for the AI,
 * picked from the wall as a solo game's opponent is. A guest plays the deck they sent
 * (`lobbyDeck`), which the host's room only names (`LobbyPeer.deck`).
 *
 * Pure, so the rules the setup's Start follows are tested here rather than through the panel.
 */

/** A lobby game's tables: a duel, or four players. The goldfish seats nobody to play with. */
export type LobbyTable = "duel" | "fourPlayer";

/** How many opponents each table seats besides the host: its most guests, too. */
export const LOBBY_OPPONENTS: Record<LobbyTable, number> = { duel: 1, fourPlayer: 3 };

/** One opponent seat of the host's table: a guest, or a seat for one of the host's decks. */
export type LobbySeat =
  | { kind: "guest"; peer: LobbyPeer }
  /** `seat` is its place at the table, 1 to 3 — the setup's seat whose deck the AI plays. */
  | { kind: "ai"; seat: number };

/** The opponent seats for `opponents` of them: the guests in join order, then the AI's. */
export function lobbySeats(peers: readonly LobbyPeer[], opponents: number): LobbySeat[] {
  return Array.from({ length: opponents }, (_, i): LobbySeat => {
    const peer = peers[i];
    return peer === undefined ? { kind: "ai", seat: i + 1 } : { kind: "guest", peer };
  });
}

/** The guests a table this size has no seat for — more people came than it seats. */
export function unseated(peers: readonly LobbyPeer[], opponents: number): LobbyPeer[] {
  return peers.slice(opponents);
}

/** An AI seat's deck as the setup holds it: the deck, and the list it is dealt from. */
export interface SeatDeck {
  deck: DeckRow;
  variant: DeckVariant;
}

/** Whether the host's Start deals now, and if not, the one line that says what it waits for. */
export interface LobbyReadiness {
  ready: boolean;
  /** `null` when there is nothing to say: ready, or a lobby that is not open to deal in. */
  hint: string | null;
}

/**
 * **Start is ready when every seat has a deck** — the host's own, each AI seat's, and every seated
 * guest's sent one — in an open lobby with at least one guest (a game with nobody is a solo
 * game, the setup's other half) and no more people than the table seats. The first thing missing
 * is the line under the button.
 */
export function lobbyReadiness({
  lobby,
  table,
  yours,
  aiDeck,
}: {
  lobby: LobbyState;
  table: LobbyTable;
  /** The host's own deck, if picked. */
  yours: DeckRow | undefined;
  /** The deck seated for the AI at `seat`, if any. */
  aiDeck: (seat: number) => SeatDeck | undefined;
}): LobbyReadiness {
  const opponents = LOBBY_OPPONENTS[table];
  const not = (hint: string | null): LobbyReadiness => ({ ready: false, hint });
  if (lobby.phase === "connecting") return not("Connecting to the lobby…");
  if (lobby.phase === "playing") return not("A game is underway at this table.");
  if (lobby.phase !== "open") return not(null);
  if (lobby.peers.length > opponents) {
    const seats = opponents + 1;
    return not(
      `${lobby.peers.length + 1} people are in; ${table === "duel" ? "a duel" : "a four-player game"} seats ${seats}.`,
    );
  }
  if (lobby.peers.length === 0) return not("Share the code: a game needs someone to join it.");
  if (yours === undefined) return not("Pick your deck to start.");
  for (const seat of lobbySeats(lobby.peers, opponents)) {
    if (seat.kind === "guest" && seat.peer.deck === null)
      return not(`Waiting for ${seat.peer.name} to pick a deck.`);
    if (seat.kind === "ai" && aiDeck(seat.seat) === undefined)
      return not(`Pick a deck for ${seatTitle(seat.seat, opponents)} to start.`);
  }
  return { ready: true, hint: null };
}

/** An opponent seat's name in the setup: `Opponent`, or `Opponent 2` at a four-player table. */
export function seatTitle(seat: number, opponents: number): string {
  return opponents > 1 ? `Opponent ${seat}` : "Opponent";
}

/**
 * What `lobbyGameStart` deals from — each opponent seat in turn order, a guest's by its peer and
 * an AI seat's by its deck — and the plates' names in the same order: a person's lobby name, an
 * AI seat's deck. `null` while an AI seat has no deck (Start is not ready then).
 */
export function lobbyGameSeats(
  seats: readonly LobbySeat[],
  aiDeck: (seat: number) => SeatDeck | undefined,
): { seats: LobbyGameSeat[]; names: string[] } | null {
  const out: LobbyGameSeat[] = [];
  const names: string[] = [];
  for (const seat of seats) {
    if (seat.kind === "guest") {
      out.push({ peer: seat.peer.peer, deckId: null, variant: null });
      names.push(seat.peer.name);
      continue;
    }
    const picked = aiDeck(seat.seat);
    if (picked === undefined) return null;
    out.push({ peer: null, deckId: picked.deck.id, variant: picked.variant });
    names.push(picked.deck.name);
  }
  return { seats: out, names };
}
