import { useEffect, useId, useRef, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Crown, LogIn } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { FIELD } from "@/features/decks/formFields";
import {
  isLive,
  LOBBY_ALPHABET,
  LOBBY_CODE_LENGTH,
  LOBBY_KEY,
  lobbyNameMemory,
  normalizeCode,
  useLobbyState,
  useMayHostPod,
} from "@/features/draft/lobby/useLobby";
import { ipc, ipcError } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { REFUSAL, TRADE_BUTTON, TRADE_BUTTON_ACCENT } from "../tradeControls";
import { useTradeWrites } from "../useTrades";

/**
 * **Trade online**: the way into a trade with another reader of the app, over a lobby code.
 *
 * Either press makes **a new trade of the reader's own first** — their copy of the one they are
 * about to build together, priced in their own marketplace — and then opens the lobby with it, so
 * the lobby always has a trade to write the other reader's offer into. A lobby that could not be
 * opened takes that trade back with it: nothing is left behind that the reader did not get.
 *
 * **Hosting is a supporter's, joining anybody's** — the pod's rule (`useMayHostPod`), read the
 * same way; the host's app refuses a lapsed membership in a sentence of its own, drawn here.
 *
 * A lobby of another kind already open — a pod's or a game's — is said instead: one lobby at a
 * time, and opening one closes the other.
 */
export function TradeLobbyDialog({
  open,
  onOpened,
  onDismiss,
  onClose,
}: {
  open: boolean;
  /** The lobby is open, and this is the reader's copy of the trade. The page selects it. */
  onOpened: (tradeId: number) => void;
  onDismiss: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Trade online"
      subtitle="Build one trade with another reader, each in your own app."
      closeLabel="Close"
      size="w-[30rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body onOpened={onOpened} onDismiss={onDismiss} />
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so a half-typed code does not outlive it. */
function Body({
  onOpened,
  onDismiss,
}: {
  onOpened: (tradeId: number) => void;
  onDismiss: () => void;
}): JSX.Element {
  const id = useId();
  const client = useQueryClient();
  const writes = useTradeWrites();
  const mayHost = useMayHostPod();
  const lobby = useLobbyState();
  const elsewhere = isLive(lobby) && lobby.kind !== null && lobby.kind !== "trade" ? lobby : null;
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setNameState] = useState(() => lobbyNameMemory.recall() ?? "");
  const setName = (next: string) => {
    lobbyNameMemory.keep(next);
    setNameState(next);
  };
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const named = name.trim() !== "";
  const coded = code.length === LOBBY_CODE_LENGTH;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const enter = async (which: "create" | "join") => {
    if (busy !== null || !named) return;
    setBusy(which);
    setFailure(null);
    let tradeId: number | null = null;
    try {
      tradeId = await writes.create({});
      const state =
        which === "create"
          ? await ipc.lobbyCreate(name.trim(), "trade", tradeId)
          : await ipc.lobbyJoin(code, name.trim(), tradeId);
      client.setQueryData(LOBBY_KEY, state);
      onOpened(tradeId);
    } catch (e) {
      if (tradeId !== null) void writes.remove(tradeId).catch(() => {});
      setFailure(ipcError(e));
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-[1.125rem] overflow-y-auto px-5 py-[1.125rem]">
        {elsewhere !== null && (
          <p
            role="status"
            className="m-0 rounded-lg border border-border bg-surface px-3 py-2 text-xs"
          >
            Your lobby {elsewhere.code} is {elsewhere.kind === "draft" ? "a draft’s" : "a game’s"}.
            Opening one here closes it.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-[0.8125rem] text-dim">
            Your name in the lobby
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            value={name}
            maxLength={32}
            placeholder="Ada"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            className={cn(FIELD, "h-9 px-3")}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] text-dim">Start a trade</span>
          <button
            type="button"
            aria-disabled={!(mayHost && named) || busy !== null || undefined}
            aria-busy={busy === "create" || undefined}
            onClick={() => {
              if (mayHost) void enter("create");
            }}
            className={cn(TRADE_BUTTON_ACCENT, "self-start")}
          >
            <Crown className="size-4" aria-hidden="true" />
            Create lobby
          </button>
          <span className="text-xs text-dim">
            {mayHost
              ? "You get a code to share. Each of you adds what you give, and the trade goes through when you both accept."
              : "Starting a trade online is for supporters; anybody can join one with its code."}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-code`} className="text-[0.8125rem] text-dim">
            Join with a code
          </label>
          <div className="flex gap-2">
            <input
              id={`${id}-code`}
              value={code}
              autoComplete="off"
              spellCheck={false}
              placeholder="K7QX2M"
              maxLength={LOBBY_CODE_LENGTH}
              pattern={`[${LOBBY_ALPHABET}]{${LOBBY_CODE_LENGTH}}`}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && coded) void enter("join");
              }}
              className={cn(FIELD, "h-9 min-w-0 flex-1 px-3 font-mono tracking-[0.3em] uppercase")}
            />
            <button
              type="button"
              aria-disabled={!(named && coded) || busy !== null || undefined}
              aria-busy={busy === "join" || undefined}
              onClick={() => {
                if (coded) void enter("join");
              }}
              className={TRADE_BUTTON}
            >
              <LogIn className="size-4" aria-hidden="true" />
              Join
            </button>
          </div>
        </div>
        {!named && <p className="m-0 text-xs text-dim">Give yourself a name to start or join.</p>}
      </div>

      <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3.5">
        {failure !== null && (
          <p role="alert" className={cn(REFUSAL, "min-w-0 flex-1")}>
            {failure}
          </p>
        )}
        <button type="button" onClick={onDismiss} className={TRADE_BUTTON}>
          Cancel
        </button>
      </footer>
    </>
  );
}
