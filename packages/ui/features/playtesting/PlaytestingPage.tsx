import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDeckWallMarks } from "@/features/decks/deckWall";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDecks } from "@/features/decks/useDecks";
import { useDeckSort } from "@/features/decks/useDeckSort";
import { isLive, LOBBY_KEY, lobbyFor, useLobbyState } from "@/features/draft/lobby/useLobby";
import { ipc, ipcError, type LobbyState, type PlaytestPlayer } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { forgetGuestGame, guestGameFor, keepGame, keptGame, keptGuestGame } from "./keptGame";
import type { GuestHeldState } from "./play/guestGame";
import { holdGame, type HeldGame, type PlaytestPicks } from "./play/heldGame";
import { PlaytestPage } from "./play/PlaytestPage";
import { OPPONENTS } from "./play/players";
import { PlaytestSetup } from "./PlaytestSetup";
import { freshBook } from "./undo";

/**
 * The Playtesting view: a setup screen, and the game it starts — against the goldfish, one deck
 * or three, or with friends over a lobby.
 *
 * A file of its own so the router branch names a page — it was a `WorkInProgress` sentence, and
 * `App.tsx`'s branch did not change when it grew into this, which is what that placeholder was a
 * file of its own for. `App.tsx` loads it lazily, and the board with it (static here, so one
 * chunk: a session that never playtests fetches neither).
 *
 * **The board covers the window, the setup stays under it** (`PlaytestPage` is `fixed` at
 * `LAYER.stage`), so the way back — the back button, Escape, the result's Back — finds the setup
 * as it was left, its picks still made, and leaving that way puts the game away (asked first
 * while it is underway).
 *
 * **Going to another view does not** (issue #1322): the game is kept (`./keptGame.ts`), and this
 * page opens on it again when the reader comes back — the same board, the same log, an AI turn
 * that finished meanwhile already played.
 *
 * **A game with friends** (issue #1419) is one of two boards. The **host's** is an ordinary held
 * game with a lobby in its picks — dealt and played on this app, kept the same way — whose way
 * back also closes the lobby. A **guest's** is held from the join on (`guestGameFor`), listening
 * for the host's steps, and its board comes up with the first one; its way back leaves the lobby.
 * On either board, a lobby that closed — or a host who dropped — is said over the game, and the
 * host's board offers the AI a guest's seat the game waits on while that guest is offline.
 *
 * **The setup's wall is the Decks page's**, so it reads what that page reads: the folders, each
 * deck's colours and bracket (`useDeckWallMarks`), and the order the reader keeps the gallery in.
 * Every one of them is a query the gallery shares, so a reader arriving from Decks asks nothing new.
 */
export function PlaytestingPage(): JSX.Element {
  const { decks, query } = useDecks();
  const { folders } = useDeckFolders();
  const marks = useDeckWallMarks(decks);
  const { sort } = useDeckSort();
  const client = useQueryClient();
  const lobby = useLobbyState();
  const gameLobby = lobbyFor(lobby, "game");
  const [playing, setPlaying] = useState<HeldGame | null>(keptGame);

  // A guest's game: held while the lobby is live, and kept for its code once it has closed, so
  // the board stays up to say so.
  const guest =
    gameLobby === null || gameLobby.role !== "guest"
      ? null
      : gameLobby.phase !== "closed"
        ? guestGameFor(gameLobby.code)
        : keptGuestGame(gameLobby.code);
  useEffect(() => {
    guest?.start();
  }, [guest]);
  const guestState = useSyncExternalStore(
    guest?.subscribe ?? noSubscribe,
    guest?.state ?? noGuestState,
  );

  const start = useCallback((picks: PlaytestPicks) => {
    const game = holdGame(picks);
    game.start();
    keepGame(game);
    setPlaying(game);
  }, []);
  /** Leave the lobby a game was played in — the host's closes it — and forget it here. */
  const leaveLobby = useCallback(() => {
    forgetGuestGame();
    ipc.lobbyLeave().then(
      () => client.setQueryData(LOBBY_KEY, null),
      (e: unknown) => notify.error(ipcError(e)),
    );
  }, [client]);
  const back = useCallback(() => {
    playing?.end();
    keepGame(null);
    setPlaying(null);
    if (playing?.picks.lobby !== undefined) leaveLobby();
  }, [playing, leaveLobby]);
  const nameOf = (id: number) => decks.find((d) => d.id === id)?.name ?? "Deck";
  const notice = lobbyNotice(gameLobby);

  /**
   * The host's way to let the AI play a guest's seat the game waits on: only for a guest who is
   * offline, or gone from the room — a guest who is there is deciding. Kicking a guest seated in
   * a running game hands their seat to the AI (`lobbyKick`).
   */
  const handOver = (picks: PlaytestPicks) => (player: PlaytestPlayer) => {
    const seat = picks.lobby?.seats[OPPONENTS.indexOf(player)];
    if (seat?.peer == null || gameLobby === null || !isLive(gameLobby)) return null;
    const peer = gameLobby.peers.find((p) => p.peer === seat.peer);
    if (peer?.online) return null;
    const id = seat.peer;
    return () => {
      ipc.lobbyKick(id).catch((e: unknown) => notify.error(ipcError(e)));
    };
  };

  return (
    <>
      <PlaytestSetup
        decks={decks}
        folders={folders}
        marks={marks}
        sort={sort}
        loading={query.isPending}
        lobby={lobby}
        onStart={start}
      />
      {/* A guest's board first: a game with people waits on them, where a kept game of their own
          does not. */}
      {guest !== null && guestState.dealt ? (
        <PlaytestPage
          picks={guest.picks}
          held={guest}
          deckName={guestState.deck || "Deck"}
          opponentNames={guestState.names}
          notice={notice}
          onBack={leaveLobby}
        />
      ) : (
        playing !== null && (
          <PlaytestPage
            picks={playing.picks}
            held={playing}
            deckName={nameOf(playing.picks.deckId)}
            // The goldfish has no deck to name it: its plate says what it is. A lobby's plates name
            // the people at the table, and the AI seats' decks.
            opponentNames={
              playing.picks.lobby !== undefined
                ? playing.picks.lobby.names
                : playing.picks.opponents.length === 0
                  ? ["Goldfish"]
                  : playing.picks.opponents.map((o) => nameOf(o.deckId))
            }
            handOver={playing.picks.lobby === undefined ? undefined : handOver(playing.picks)}
            notice={playing.picks.lobby === undefined ? null : notice}
            onBack={back}
          />
        )
      )}
    </>
  );
}

/** A sentence for a lobby game's board about the table, not the game — or `null`. */
function lobbyNotice(lobby: LobbyState | null): string | null {
  if (lobby === null) return null;
  if (lobby.phase === "closed")
    return `The lobby closed${lobby.closedReason ? `: ${lobby.closedReason}` : "."}`;
  if (lobby.role === "guest" && !lobby.hostOnline)
    return `${lobby.hostName} has dropped — the game goes on when they are back.`;
  return null;
}

const noSubscribe = () => () => {};
const NO_GUEST_STATE: GuestHeldState = {
  view: null,
  book: freshBook(),
  error: null,
  busy: false,
  lastHappened: [],
  names: [],
  deck: "",
  dealt: false,
};
const noGuestState = () => NO_GUEST_STATE;
