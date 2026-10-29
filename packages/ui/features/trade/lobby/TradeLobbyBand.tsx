import { useEffect, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Handshake, LogOut, Undo2 } from "lucide-react";
import { OnlineDot } from "@/features/draft/lobby/LobbyParts";
import { LOBBY_KEY } from "@/features/draft/lobby/useLobby";
import { copyText } from "@/lib/clipboard";
import { ipc, ipcError } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { FIGURE, REFUSAL, TRADE_BUTTON, TRADE_BUTTON_ACCENT } from "../tradeControls";
import { dealLine, readerLine, unknownLine } from "./tradeLobbyWords";
import { otherReader, youAccepted, type TradeLobby } from "./useTradeLobby";

/**
 * **The trade lobby, over the trade**: the code to share, who the reader is trading with, where
 * the deal stands, and the three presses it has — accept (or take it back), finish once both
 * have, and leave. Drawn by the Trade page above whichever trade is shown, so a reader who
 * wanders to another trade still sees the lobby and the way back to the trade it is about.
 */
export function TradeLobbyBand({
  lobby,
  showing,
  onShow,
  onFinish,
  sendFailure,
}: {
  lobby: TradeLobby;
  /** Whether the trade on screen is this lobby's. */
  showing: boolean;
  /** Show the lobby's trade. */
  onShow: () => void;
  /** Open Finish trade on the lobby's trade. */
  onFinish: () => void;
  /** Why this reader's offer could not be sent, if it could not. */
  sendFailure: string | null;
}): JSX.Element {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const closed = lobby.phase === "closed";
  const agreed = lobby.phase === "agreed";
  const other = otherReader(lobby);
  const yours = youAccepted(lobby);
  const canAccept = lobby.phase === "open" && other !== null;
  const unknown = unknownLine(lobby.trade.unknown);

  const accept = () => {
    if (busy || !canAccept) return;
    setBusy(true);
    setFailure(null);
    ipc
      .lobbyTradeAccept(lobby.trade.deal.rev, !yours)
      .catch((e: unknown) => setFailure(ipcError(e)))
      .finally(() => setBusy(false));
  };

  const leave = () => {
    ipc.lobbyLeave().then(
      () => client.setQueryData(LOBBY_KEY, null),
      (e: unknown) => setFailure(ipcError(e)),
    );
  };

  return (
    <section
      aria-label="Online trade"
      className="flex shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {!closed && <CodeChip code={lobby.code} />}
        <p role="status" className="m-0 flex min-w-0 items-center gap-2 text-sm">
          {other !== null && !closed && <OnlineDot online={other.online} />}
          <span className="min-w-0">{readerLine(lobby)}</span>
        </p>
        {!closed && other !== null && (
          <p
            className={cn(
              "m-0 flex min-w-0 items-center gap-1.5 text-sm",
              agreed ? "text-ok" : "text-dim",
            )}
          >
            {agreed && <Handshake className="size-4 shrink-0" aria-hidden="true" />}
            <span className="min-w-0">{dealLine(lobby)}</span>
          </p>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!showing && !closed && (
            <button type="button" onClick={onShow} className={TRADE_BUTTON}>
              Show the trade
            </button>
          )}
          {agreed ? (
            <button type="button" onClick={onFinish} className={TRADE_BUTTON_ACCENT}>
              <Check className="size-4" aria-hidden="true" />
              Finish trade
            </button>
          ) : (
            !closed && (
              <button
                type="button"
                aria-disabled={!canAccept || busy || undefined}
                aria-pressed={yours}
                onClick={accept}
                className={yours ? TRADE_BUTTON : TRADE_BUTTON_ACCENT}
              >
                {yours ? (
                  <Undo2 className="size-4" aria-hidden="true" />
                ) : (
                  <Handshake className="size-4" aria-hidden="true" />
                )}
                {yours ? "Take back" : "Accept trade"}
              </button>
            )
          )}
          <button type="button" onClick={leave} className={TRADE_BUTTON}>
            <LogOut className="size-4" aria-hidden="true" />
            {closed ? "Dismiss" : lobby.role === "host" ? "Close lobby" : "Leave lobby"}
          </button>
        </div>
      </div>
      {unknown !== null && !closed && <p className="m-0 text-xs text-dim">{unknown}</p>}
      {(failure ?? sendFailure) !== null && (
        <p role="alert" className={REFUSAL}>
          {failure ?? sendFailure}
        </p>
      )}
    </section>
  );
}

/** The lobby's code, and the way to copy it. */
function CodeChip({ code }: { code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-dim">Lobby code</span>
      <output
        aria-label="Lobby code"
        className={cn(FIGURE, "text-base font-semibold tracking-[0.2em] text-accent select-all")}
      >
        {code}
      </output>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy the code"}
        onClick={() => {
          copyText(code).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
        className="grid size-7 place-items-center rounded-md text-dim hover:text-text"
      >
        {copied ? (
          <Check className="size-4 text-ok" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * A code joined from this page that turned out to be another page's lobby — a pod's or a game's
 * — says where it belongs, and offers the way out.
 */
export function MisplacedLobby({ kind }: { kind: "draft" | "game" }): JSX.Element {
  const client = useQueryClient();
  const where = kind === "draft" ? "a draft’s, on Draft & Packs" : "a game’s, on Playtesting";
  return (
    <section
      aria-label="Online trade"
      className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm"
    >
      <p role="status" className="m-0 min-w-0 flex-1">
        That lobby is {where}, not a trade’s.
      </p>
      <button
        type="button"
        onClick={() => {
          void ipc.lobbyLeave().then(() => client.setQueryData(LOBBY_KEY, null));
        }}
        className={TRADE_BUTTON}
      >
        <LogOut className="size-4" aria-hidden="true" />
        Leave lobby
      </button>
    </section>
  );
}
