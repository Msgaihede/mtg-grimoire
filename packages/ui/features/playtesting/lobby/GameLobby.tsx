import { useEffect, useId, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Crown, LogIn, LogOut, Users, X } from "lucide-react";
import { OnlineDot } from "@/features/draft/lobby/LobbyParts";
import {
  LOBBY_ALPHABET,
  LOBBY_CODE_LENGTH,
  LOBBY_KEY,
  lobbyNameMemory,
  normalizeCode,
  useMayHostPod,
} from "@/features/draft/lobby/useLobby";
import { FIELD, InlineError, LABEL, PANEL, QUIET_BUTTON } from "@/features/draft/setup/parts";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckVariant, type LobbyPeer, type LobbyState } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { forgetGuestGame } from "../keptGame";

/**
 * **The Playtesting setup's way to a game with friends** (issue #1419): the lobby the Draft & Packs
 * pod meets in (`features/draft/lobby/`), opened for a game instead — its door, its leave and its
 * guests' rows. The host's table itself (seats, Start) is the setup's own aside, drawn by
 * `../PlaytestSetup.tsx` with these pieces in it, since its seats are picked from the same wall.
 *
 * **Hosting is a supporter's, joining anybody's** — the draft's rule, read the same way
 * (`useMayHostPod`); the host's app refuses a lapsed membership in a sentence of its own, drawn
 * here.
 */

/**
 * The door: the reader's name at the table, **Create lobby** (a supporter's) and **Join with a
 * code**. A lobby that closed says why above it; a lobby that turned out to be a draft's says
 * where it belongs instead (`draft`), and offers the way out.
 */
export function FriendsDoor({
  closed,
  draft,
}: {
  /** The game lobby that closed, if the last one did. */
  closed: LobbyState | null;
  /** A draft's lobby this app holds — joined here by its code, or hosted on Draft & Packs. */
  draft: LobbyState | null;
}): JSX.Element {
  const client = useQueryClient();
  const mayHost = useMayHostPod();
  const [name, setNameState] = useState(() => lobbyNameMemory.recall() ?? "");
  const setName = (next: string) => {
    lobbyNameMemory.keep(next);
    setNameState(next);
  };
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const codeId = useId();
  const named = name.trim() !== "";
  const coded = code.length === LOBBY_CODE_LENGTH;

  const enter = async (which: "create" | "join") => {
    if (busy !== null) return;
    setBusy(which);
    setError(null);
    try {
      const state =
        which === "create"
          ? await ipc.lobbyCreate(name.trim(), "game")
          : await ipc.lobbyJoin(code, name.trim());
      client.setQueryData(LOBBY_KEY, state);
    } catch (e) {
      setError(ipcError(e));
    } finally {
      setBusy(null);
    }
  };

  if (draft !== null) {
    return (
      <section aria-label="Play with friends" className={SECTION}>
        <h3 className={LABEL}>Play with friends</h3>
        <p role="status" className="m-0 text-sm">
          {draft.role === "guest"
            ? "That code is a draft’s lobby — join it from Draft & Packs."
            : `Your lobby ${draft.code} is a draft’s, on Draft & Packs. Close it there to open one for a game.`}
        </p>
        <LeaveLobby host={draft.role === "host"} className="self-start" />
      </section>
    );
  }

  return (
    <section aria-label="Play with friends" className={SECTION}>
      <h3 className={LABEL}>Play with friends</h3>
      {closed !== null && (
        <p
          role="status"
          className="m-0 rounded-lg border border-border bg-surface px-3 py-2 text-xs"
        >
          The lobby {closed.code} closed{closed.closedReason ? `: ${closed.closedReason}` : "."}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className={LABEL}>
          Your name at the table
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={32}
          placeholder="Ada"
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          aria-disabled={!(mayHost && named) || busy !== null}
          aria-busy={busy === "create" || undefined}
          onClick={() => {
            if (mayHost && named) void enter("create");
          }}
          className={cn(QUIET_BUTTON, "self-start")}
        >
          <Crown className="size-4 text-accent" aria-hidden="true" />
          Create lobby
        </button>
        <p className="m-0 text-xs text-dim">
          {mayHost
            ? "Host a game: share the code, and your friends bring their own decks."
            : "Hosting a game is for supporters; anybody can join one."}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={codeId} className={LABEL}>
          Join with a code
        </label>
        <div className="flex gap-2">
          <input
            id={codeId}
            value={code}
            autoComplete="off"
            spellCheck={false}
            placeholder="K7QX2M"
            maxLength={LOBBY_CODE_LENGTH}
            pattern={`[${LOBBY_ALPHABET}]{${LOBBY_CODE_LENGTH}}`}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && named && coded) void enter("join");
            }}
            className={cn(FIELD, "min-w-0 flex-1 font-mono tracking-[0.3em] uppercase")}
          />
          <button
            type="button"
            aria-disabled={!(named && coded) || busy !== null}
            aria-busy={busy === "join" || undefined}
            onClick={() => {
              if (named && coded) void enter("join");
            }}
            className={QUIET_BUTTON}
          >
            <LogIn className="size-4" aria-hidden="true" />
            Join
          </button>
        </div>
      </div>
      {!named && <p className="m-0 text-xs text-dim">Give yourself a name to host or join.</p>}
      <InlineError message={error} />
    </section>
  );
}

/** The lobby section's frame below the solo setup: a rule above it, the aside's rhythm in it. */
const SECTION = "flex flex-col gap-3 border-t border-border pt-5";

/**
 * Leave the lobby — **Close lobby** for its host, which ends it for everyone. A guest's held game
 * is put away with it (`forgetGuestGame`): there is nothing more for it to hear.
 */
export function LeaveLobby({
  host,
  className,
}: {
  host: boolean;
  className?: string;
}): JSX.Element {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <button
        type="button"
        onClick={() => {
          ipc.lobbyLeave().then(
            () => {
              forgetGuestGame();
              client.setQueryData(LOBBY_KEY, null);
            },
            (e: unknown) => setError(ipcError(e)),
          );
        }}
        className={QUIET_BUTTON}
      >
        <LogOut className="size-4" aria-hidden="true" />
        {host ? "Close lobby" : "Leave lobby"}
      </button>
      <InlineError message={error} />
    </div>
  );
}

/**
 * A guest's seat at the host's table: who, whether they are connected, the deck they brought —
 * or "Picking a deck…" until it arrives — and the host's ✕ that kicks them. A guest with no seat
 * (more came than the table seats) is drawn the same, its title saying so.
 */
export function GuestSeatRow({
  title,
  peer,
  onKick,
}: {
  title: string;
  peer: LobbyPeer;
  onKick: (peer: LobbyPeer) => void;
}): JSX.Element {
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border bg-surface p-2">
      <span className="grid aspect-[626/457] w-16 shrink-0 place-items-center rounded-md bg-bg text-accent">
        <Users className="size-5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={LABEL}>{title}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <OnlineDot online={peer.online} />
          <span className={cn("truncate text-sm", !peer.online && "text-dim")}>{peer.name}</span>
        </span>
        <span className="truncate text-xs text-dim">
          {peer.deck === null ? "Picking a deck…" : peer.deck}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Kick ${peer.name}`}
        onClick={() => onKick(peer)}
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md text-dim hover:text-destructive",
          PRESS,
          FOCUS,
        )}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * A guest's room, above its one seat: whose lobby it is, and where the game stands — connecting,
 * waiting for the host (or for the host to come back), or starting.
 */
export function GuestRoomHeader({ lobby }: { lobby: LobbyState }): JSX.Element {
  return (
    <div className={cn(PANEL, "flex flex-col gap-1.5 p-4")}>
      <h3 className={LABEL}>
        Lobby {lobby.code} — hosted by {lobby.hostName}
      </h3>
      <p role="status" className="m-0 text-sm">
        {lobby.phase === "connecting"
          ? "Connecting to the lobby…"
          : !lobby.hostOnline
            ? `${lobby.hostName} has dropped — waiting for them to come back.`
            : lobby.phase === "playing"
              ? `${lobby.hostName} is dealing the game…`
              : `Waiting for ${lobby.hostName} to start the game.`}
      </p>
      {lobby.peers.length > 1 && (
        <ul aria-label="People" className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
          {lobby.peers
            .filter((p) => p.name !== lobby.name)
            .map((p) => (
              <li key={p.peer} className="flex items-center gap-1.5 text-xs text-dim">
                <OnlineDot online={p.online} />
                {p.name}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** What became of the guest's deck: on its way, at the host by name, or refused. */
export interface SentDeck {
  /** The deck's name as the host read it, once it answered for the deck picked now. */
  name: string | null;
  sending: boolean;
  error: string | null;
}

/**
 * **A guest's deck goes to the host as soon as it is picked** — and again on every new pick, or a
 * new list of the same deck — while the lobby is open: the host's Start waits on it, and the
 * host's room names it. Nothing is sent while connecting (there is no host to send it to yet) or
 * once the game is dealt. `lobbyDeck` answers the deck's name, which the seat shows.
 */
export function useSendDeck(
  lobby: LobbyState | null,
  deckId: number | null,
  variant: DeckVariant,
): SentDeck {
  const open = lobby !== null && lobby.role === "guest" && lobby.phase === "open";
  const key = open && deckId !== null ? `${lobby.code}:${deckId}:${variant}` : null;
  const [answer, setAnswer] = useState<{ key: string; name: string | null; error: string | null }>({
    key: "",
    name: null,
    error: null,
  });
  useEffect(() => {
    if (key === null || deckId === null) return;
    let current = true;
    ipc.lobbyDeck(deckId, variant).then(
      (name) => {
        if (current) setAnswer({ key, name, error: null });
      },
      (e: unknown) => {
        if (current) setAnswer({ key, name: null, error: ipcError(e) });
      },
    );
    return () => {
      current = false;
    };
  }, [key, deckId, variant]);
  if (key === null) return { name: null, sending: false, error: null };
  return answer.key === key
    ? { name: answer.name, sending: false, error: answer.error }
    : { name: null, sending: true, error: null };
}
