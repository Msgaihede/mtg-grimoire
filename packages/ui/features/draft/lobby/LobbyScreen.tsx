import { useEffect, useId, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Copy, Crown, LogIn, LogOut, Play, Users, X } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type DraftView,
  type LobbyPeer,
  type LobbyState,
  type PlaytestDifficulty,
  type PodFormat,
  type SetSummary,
} from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import type { DraftRole } from "../build/BuildPanel";
import {
  COMMANDER_DECK_SIZE,
  COMMANDER_SETS,
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DRAFT_PACKS,
  freshDraftName,
  POD_SEATS,
  podSeats,
} from "../setup/deal";
import { AddPackWall, PackOrder } from "../setup/PackOrder";
import {
  FIELD,
  FlowBar,
  InlineError,
  LABEL,
  PANEL,
  PrimaryButton,
  QUIET_BUTTON,
  SeatPicker,
  Segmented,
} from "../setup/parts";
import { useDealDraft } from "../setup/useDealDraft";
import {
  LOBBY_ALPHABET,
  LOBBY_CODE_LENGTH,
  LOBBY_KEY,
  normalizeCode,
  useLobbyState,
  useMayHostPod,
} from "./useLobby";

/** The name the reader goes by in a lobby, for the window's life. */
const nameMemory = viewMemory<string>("draft.lobbyName");
/** What the host has chosen: the packs, the bots' skill, what the pod drafts and how many seats
 *  each format's table has. */
interface HostHeld {
  rounds: SetSummary[];
  difficulty: PlaytestDifficulty;
  format: PodFormat;
  seats: Record<PodFormat, number>;
}

const HOST_FRESH: HostHeld = {
  rounds: [],
  difficulty: DEFAULT_DIFFICULTY,
  format: "booster",
  seats: {
    booster: POD_SEATS.booster.start,
    commander: POD_SEATS.commander.start,
    winston: POD_SEATS.winston.start,
  },
};

/** The host's choices, for the window's life. */
const hostMemory = viewMemory<HostHeld>("draft.lobbyHost");

/** A pod's formats, in the host's words (spec §4a). */
const POD_FORMATS: readonly { id: PodFormat; label: string }[] = [
  { id: "booster", label: "Booster draft" },
  { id: "commander", label: "Commander" },
  { id: "winston", label: "Winston" },
];

/**
 * The Pod Draft flow before the first pick: create a lobby or join one by its code, then the
 * room — for the host, the code to share, who is in, the packs and Start; for a guest, who is in
 * and the wait for the host.
 *
 * **The host's app runs the draft** (spec §6), so the host's Start deals and calls `lobby_start`
 * and moves on with the view it answers; a guest moves on with the first `draft:view` the host
 * pushes, which is listened for here — before the page swaps to the pick screen — so it is not
 * lost between the two.
 */
export function LobbyScreen({
  onBack,
  onDraft,
}: {
  onBack: () => void;
  /** The pod has started: the pick screen, from this seat. */
  onDraft: (draft: number | null, view: DraftView | null, role: DraftRole) => void;
}): JSX.Element {
  const lobby = useLobbyState();
  const role = lobby?.role ?? null;
  const phase = lobby?.phase ?? null;

  useEffect(() => {
    if (role !== "guest" || phase === "closed") return;
    return ipc.onDraftView((view) => onDraft(null, view, "guest"));
  }, [role, phase, onDraft]);

  const live = lobby !== null && lobby.phase !== "closed";
  return (
    <section className="flex h-full min-h-0 flex-col">
      <FlowBar
        title="Pod Draft"
        onBack={onBack}
        step="choose"
        meta={live ? `Lobby ${lobby.code}` : undefined}
        actions={live ? <LeaveButton host={lobby.role === "host"} /> : undefined}
      />
      {!live ? (
        <LobbyDoor closed={lobby} />
      ) : lobby.role === "host" ? (
        <HostRoom lobby={lobby} onDraft={onDraft} />
      ) : (
        <GuestRoom lobby={lobby} />
      )}
    </section>
  );
}

function LeaveButton({ host }: { host: boolean }): JSX.Element {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {error !== null && <span className="text-xs text-destructive">{error}</span>}
      <button
        type="button"
        onClick={() => {
          ipc.lobbyLeave().then(
            () => client.setQueryData(LOBBY_KEY, null),
            (e: unknown) => setError(ipcError(e)),
          );
        }}
        className={QUIET_BUTTON}
      >
        <LogOut className="size-4" aria-hidden="true" />
        {host ? "Close lobby" : "Leave lobby"}
      </button>
    </span>
  );
}

/** Create a lobby (a supporter's) or join one with a code. A lobby that closed says why. */
function LobbyDoor({ closed }: { closed: LobbyState | null }): JSX.Element {
  const client = useQueryClient();
  const mayHost = useMayHostPod();
  const [name, setNameState] = useState(() => nameMemory.recall() ?? "");
  const setName = (next: string) => {
    nameMemory.keep(next);
    setNameState(next);
  };
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const codeId = useId();
  const named = name.trim() !== "";

  const enter = async (which: "create" | "join") => {
    setBusy(which);
    setError(null);
    try {
      const state =
        which === "create"
          ? await ipc.lobbyCreate(name.trim())
          : await ipc.lobbyJoin(code, name.trim());
      client.setQueryData(LOBBY_KEY, state);
    } catch (e) {
      setError(ipcError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-6 pt-3">
      {closed?.phase === "closed" && (
        <p
          role="status"
          className="m-0 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
        >
          The lobby {closed.code} closed{closed.closedReason ? `: ${closed.closedReason}` : "."}
        </p>
      )}
      <div className="flex max-w-xl flex-col gap-1.5">
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
      <div className="grid max-w-4xl grid-cols-2 gap-4">
        <div className={cn(PANEL, "flex flex-col gap-4 p-5")}>
          <div className="flex items-center gap-2.5">
            <Crown className="size-5 text-accent" aria-hidden="true" />
            <h3 className="m-0 font-heading text-lg font-semibold">Host a pod</h3>
          </div>
          <p className="m-0 text-sm text-dim">
            Open a lobby, share its code, and start when your table is in. Bots take the seats
            nobody sits in.
          </p>
          <PrimaryButton
            className="mt-auto self-start"
            ready={mayHost && named}
            busy={busy === "create"}
            onPress={() => void enter("create")}
          >
            <Users className="size-4" aria-hidden="true" />
            Create lobby
          </PrimaryButton>
          {!mayHost && <p className="m-0 text-xs text-dim">Hosting a pod is for supporters.</p>}
        </div>
        <div className={cn(PANEL, "flex flex-col gap-4 p-5")}>
          <div className="flex items-center gap-2.5">
            <LogIn className="size-5 text-accent" aria-hidden="true" />
            <h3 className="m-0 font-heading text-lg font-semibold">Join with a code</h3>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={codeId} className={LABEL}>
              Lobby code
            </label>
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
                if (e.key === "Enter" && named && code.length === LOBBY_CODE_LENGTH)
                  void enter("join");
              }}
              className={cn(FIELD, "h-12 font-mono text-2xl tracking-[0.3em] uppercase")}
            />
          </div>
          <PrimaryButton
            className="self-start"
            ready={named && code.length === LOBBY_CODE_LENGTH}
            busy={busy === "join"}
            onPress={() => void enter("join")}
          >
            <LogIn className="size-4" aria-hidden="true" />
            Join
          </PrimaryButton>
        </div>
      </div>
      {!named && <p className="m-0 text-xs text-dim">Give yourself a name to host or join.</p>}
      <InlineError message={error} />
    </div>
  );
}

/** The code, large, and the way to copy it. */
function CodePlate({ code }: { code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className={cn(PANEL, "flex flex-col gap-3 p-5")}>
      <h3 className={LABEL}>Lobby code</h3>
      <div className="flex flex-wrap items-center gap-4">
        <output
          aria-label="Lobby code"
          className="font-mono text-5xl font-semibold tracking-[0.25em] text-accent select-all"
        >
          {code}
        </output>
        <button
          type="button"
          onClick={() => {
            copyText(code).then(
              () => setCopied(true),
              (e: unknown) => setError(ipcError(e)),
            );
          }}
          className={QUIET_BUTTON}
        >
          {copied ? (
            <Check className="size-4 text-ok" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="m-0 text-xs text-dim">
        Anyone with the code can join — no membership needed. The lobby lasts six hours.
      </p>
      <InlineError message={error} />
    </div>
  );
}

/** Who is in the room: the host, each guest (online or dropped), and how many bots fill in. */
function People({
  lobby,
  seats,
  onKick,
}: {
  lobby: LobbyState;
  /** The table's seats, when this app knows them (the host's); a guest is told no bot count. */
  seats?: number;
  onKick?: (peer: LobbyPeer) => void;
}): JSX.Element {
  const online = lobby.peers.filter((p) => p.online).length;
  const bots = seats === undefined ? 0 : Math.max(0, seats - 1 - online);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <h3 className={LABEL}>At the table</h3>
        <span className="text-xs text-dim">
          {plural(1 + online, "person", "people")}
          {seats !== undefined && ` · ${plural(bots, "bot")}`}
        </span>
      </div>
      <ul aria-label="People" className="m-0 flex list-none flex-col gap-1.5 p-0">
        <li className="flex h-10 items-center gap-2.5 rounded-lg border border-border bg-surface px-3">
          <OnlineDot online={lobby.hostOnline} />
          <span className="min-w-0 flex-1 truncate text-sm">{lobby.hostName}</span>
          <span className="inline-flex items-center gap-1 text-xs text-accent">
            <Crown className="size-3.5" aria-hidden="true" />
            Host
          </span>
        </li>
        {lobby.peers.map((peer) => (
          <li
            key={peer.peer}
            className="flex h-10 items-center gap-2.5 rounded-lg border border-border bg-surface pl-3 pr-1"
          >
            <OnlineDot online={peer.online} />
            <span className={cn("min-w-0 flex-1 truncate text-sm", !peer.online && "text-dim")}>
              {peer.name}
              {lobby.role === "guest" && peer.name === lobby.name && " (you)"}
            </span>
            {onKick !== undefined && (
              <button
                type="button"
                aria-label={`Kick ${peer.name}`}
                onClick={() => onKick(peer)}
                className={cn(
                  "grid size-8 place-items-center rounded-md text-dim hover:text-destructive",
                  PRESS,
                  FOCUS,
                )}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
        {bots > 0 && (
          <li className="flex h-10 items-center gap-2.5 rounded-lg border border-dashed border-border px-3 text-sm text-dim">
            <Bot className="size-4" aria-hidden="true" />
            {plural(bots, "bot")} in the empty seats
          </li>
        )}
      </ul>
    </div>
  );
}

function OnlineDot({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={online ? "Online" : "Offline"}
      className={cn("size-2 shrink-0 rounded-full", online ? "bg-ok" : "bg-dim/50")}
    />
  );
}

/**
 * The host's room: the code, the people, what the pod drafts (a booster draft of 2–8, a Commander
 * draft of 3–8, a Winston draft of 2–4) and at how many seats, the packs, the bots' skill, and
 * Start — which deals three boosters for every seat and sends the format (`podFormat`); a
 * Commander pod's deck floor is 60. A seat count below the people in the room is not offered: the
 * table seats everyone online, and bots in the rest.
 */
function HostRoom({
  lobby,
  onDraft,
}: {
  lobby: LobbyState;
  onDraft: (draft: number | null, view: DraftView | null, role: DraftRole) => void;
}): JSX.Element {
  // Over `HOST_FRESH`, so a shape kept before the format was added still has every field.
  const [held, setHeldState] = useState<HostHeld>(() => ({ ...HOST_FRESH, ...hostMemory.recall() }));
  const setHeld = (patch: Partial<HostHeld>) => {
    const next = { ...held, ...patch };
    hostMemory.keep(next);
    setHeldState(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dealSets } = useDealDraft();
  const range = POD_SEATS[held.format];
  const people = 1 + lobby.peers.filter((p) => p.online).length;
  const seats = Math.min(range.max, Math.max(held.seats[held.format], people, range.min));
  const crowded = people > range.max;
  const ready = held.rounds.length === DRAFT_PACKS && lobby.phase === "open" && !crowded;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const setup = await dealSets({
        mode: "pod",
        podFormat: held.format,
        rounds: held.rounds,
        difficulty: held.difficulty,
        seats: podSeats(lobby.name, lobby.peers, seats),
      });
      const draft = freshDraftName();
      const view = await ipc.lobbyStart(setup, draft);
      onDraft(draft, view, "host");
    } catch (e) {
      setError(ipcError(e));
      setBusy(false);
    }
  };

  const kick = (peer: LobbyPeer) => {
    ipc.lobbyKick(peer.peer).catch((e: unknown) => setError(ipcError(e)));
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pb-6 pr-6 pt-3">
        <CodePlate code={lobby.code} />
        <AddPackWall
          chosen={held.rounds}
          max={DRAFT_PACKS}
          onChange={(rounds) => setHeld({ rounds })}
          suggested={held.format === "commander" ? COMMANDER_SETS : undefined}
        />
      </div>
      <aside
        aria-label="Pod setup"
        className="flex w-[24rem] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-surface/45 px-6 pb-6 pt-3"
      >
        <People lobby={lobby} seats={seats} onKick={kick} />
        <Segmented
          label="Format"
          options={POD_FORMATS}
          value={held.format}
          onPick={(format) => setHeld({ format })}
        />
        {!crowded && (
          <SeatPicker
            range={range}
            floor={people}
            value={seats}
            onPick={(n) => setHeld({ seats: { ...held.seats, [held.format]: n } })}
          />
        )}
        <p className="m-0 text-xs leading-relaxed text-dim">
          {held.format === "commander"
            ? `Two cards a pick; everyone builds a ${COMMANDER_DECK_SIZE}-card deck with a commander.`
            : held.format === "winston"
              ? "One face-down stack in three piles, shared by the table: take a pile or decline it."
              : "Three boosters each, passed left, right, left."}
        </p>
        <Segmented
          label="Bot difficulty"
          options={DIFFICULTIES}
          value={held.difficulty}
          onPick={(difficulty) => setHeld({ difficulty })}
        />
        <PackOrder
          chosen={held.rounds}
          max={DRAFT_PACKS}
          onChange={(rounds) => setHeld({ rounds })}
        />
        <div className="mt-auto flex flex-col gap-2 pt-2">
          <PrimaryButton ready={ready} busy={busy} onPress={() => void start()}>
            <Play className="size-4 fill-current" aria-hidden="true" />
            Start draft
          </PrimaryButton>
          <InlineError message={error} />
          {error === null && (
            <p className="m-0 text-center text-xs text-dim">
              {lobby.phase === "connecting"
                ? "Connecting to the lobby…"
                : crowded
                  ? `${people} people are in; ${POD_FORMATS.find((f) => f.id === held.format)?.label ?? "this format"} seats ${range.max} at most.`
                  : held.rounds.length < DRAFT_PACKS
                    ? `Choose ${DRAFT_PACKS - held.rounds.length} more ${DRAFT_PACKS - held.rounds.length === 1 ? "pack" : "packs"} to start.`
                    : `${seats} seats: whoever is online now, and bots.`}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

/** A guest's room: who is hosting, what they will draft, who is in, and the wait. */
function GuestRoom({ lobby }: { lobby: LobbyState }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-6 pt-3">
      <div className={cn(PANEL, "flex max-w-2xl flex-col gap-2 p-5")}>
        <h3 className={LABEL}>{lobby.phase === "drafting" ? "Dealing" : "Waiting room"}</h3>
        <p role="status" className="m-0 text-lg">
          {lobby.phase === "connecting"
            ? "Connecting to the lobby…"
            : !lobby.hostOnline
              ? `${lobby.hostName} has dropped — waiting for them to come back.`
              : lobby.phase === "drafting"
                ? `${lobby.hostName} is dealing the packs…`
                : `Waiting for ${lobby.hostName} to start the draft.`}
        </p>
        {lobby.label !== "" && <p className="m-0 text-sm text-dim">{lobby.label}</p>}
      </div>
      <div className="max-w-md">
        <People lobby={lobby} />
      </div>
    </div>
  );
}
