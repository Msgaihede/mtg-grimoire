import { useEffect, useState, type JSX } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { ipcError } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { InlineError, LABEL, PANEL, QUIET_BUTTON } from "../setup/parts";

/**
 * The pieces a lobby's room is drawn from wherever it is drawn: the Pod Draft's room
 * (`LobbyScreen`) and the Playtesting setup's game lobby (issue #1419), which meet in the same
 * lobby over the same relay. A file of its own so Playtesting takes these and not the draft's
 * screen — its packs, its seats and its deal — into its chunk.
 */

/**
 * The code, large, and the way to copy it. `compact` is a narrower column's: the Playtesting
 * setup's 26rem aside, where the draft room's 5xl code would crowd its copy button onto a line of
 * its own.
 */
export function CodePlate({
  code,
  compact = false,
}: {
  code: string;
  compact?: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className={cn(PANEL, "flex flex-col gap-3", compact ? "p-4" : "p-5")}>
      <h3 className={LABEL}>Lobby code</h3>
      <div className="flex flex-wrap items-center gap-4">
        <output
          aria-label="Lobby code"
          className={cn(
            "font-mono font-semibold text-accent select-all",
            compact ? "text-3xl tracking-[0.2em]" : "text-5xl tracking-[0.25em]",
          )}
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

/** Whether a person in the room is connected: a green dot, or a grey one. */
export function OnlineDot({ online }: { online: boolean }): JSX.Element {
  return (
    <span
      role="img"
      aria-label={online ? "Online" : "Offline"}
      className={cn("size-2 shrink-0 rounded-full", online ? "bg-ok" : "bg-dim/50")}
    />
  );
}
