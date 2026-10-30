import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { copyText } from "@/lib/clipboard";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { ipc, ipcError, type McpStatus } from "@/lib/ipc";
import { MCP_KEY } from "@/lib/query";
import { radioKeys } from "@/lib/radioGroup";
import { cn } from "@/lib/utils";
import { writeFailure, type Write } from "@/lib/writes";
import { ConfirmDialog } from "./ConfirmDialog";
import { PANEL_BUTTON, SWITCH, switchTone, TOUCH_FIELD, TOUCH_FLOOR } from "./controls";
import { PanelAlert } from "./panelChrome";

/** The part's id stem — its heading is `mcp-heading`, its switch `mcp-switch`. */
const ID = "mcp";

/** The part's heading inside the Integrations panel, beside the cloud copy's own. */
export const MCP_HEADING = "AI agents on this computer (MCP)";

/**
 * What the server is, in one sentence: who can use it, what it may touch, and the two facts that
 * set it apart from the cloud copy below it — **nothing leaves this computer**, and **it is
 * free**. Exported so the tests and the stories assert the sentence the panel draws.
 */
export const MCP_SENTENCE =
  "Lets an AI agent on this computer — Claude Code, Claude Desktop, Codex, Gemini CLI and " +
  "others — read and add to your collection, wishlist and decks while this app is open. " +
  "Nothing leaves this computer, and it's free.";

/** The note beside a switch that is off. */
export const MCP_OFF = "Off.";

/** The note beside a running server — the address an agent is pointed at. */
export function listeningLine(url: string): string {
  return `Listening at ${url}`;
}

/**
 * What a switched-on server that is not listening says when the status carries no sentence — a
 * launch that could not read its setting, which records no bind failure. (A taken port carries
 * the bind's own sentence, and moving the port starts the server.) The way on is the switch, so
 * the line names it.
 */
export const NOT_RUNNING = "Not listening. Switch it off and on again to start it.";

/** The ports `mcp_set_port` accepts — a `u16` above the privileged range. */
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/** The panel's own refusal for a port it will not send: not a whole number, or out of range. */
export const PORT_RANGE = `Choose a port from ${PORT_MIN} to ${PORT_MAX}.`;

/**
 * A typed port, or `null` when it is not one `mcp_set_port` would take.
 *
 * **Digits only, never `Number(text)`**, which reads `" 4e4 "` as 40000 and `""` as 0: what the
 * box sends must be what the reader can see in it.
 */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= PORT_MIN && port <= PORT_MAX ? port : null;
}

/** The clients the panel says how to set up, in the order the choice draws them. */
export const CLIENTS = [
  "claude-code",
  "claude-desktop",
  "codex",
  "gemini",
  "antigravity",
  "cursor",
] as const;
export type McpClient = (typeof CLIENTS)[number];

/**
 * Each client's name on the choice, and where its snippet goes.
 *
 * **Only clients that run on this computer**: the server listens on `127.0.0.1`, so a client whose
 * agent runs on its vendor's servers — ChatGPT's chats, the Gemini app, claude.ai — cannot reach
 * it, and offering one would be a setup that never connects. ChatGPT's desktop app reaches it
 * through Codex, whose line says so.
 */
export const CLIENT_META: Record<McpClient, { label: string; where: string }> = {
  "claude-code": {
    label: "Claude Code",
    where: "Run this in a terminal. It adds the server for every project, not only this folder.",
  },
  "claude-desktop": {
    label: "Claude Desktop",
    where:
      "Add this to Claude Desktop's config file (Settings → Developer → Edit Config), then " +
      "restart Claude Desktop. It needs Node.js, for npx.",
  },
  codex: {
    label: "Codex",
    where:
      "Add this to .codex\\config.toml in your user folder — create it if it isn't there. The " +
      "Codex CLI, its IDE extension and the ChatGPT desktop app all read it.",
  },
  gemini: {
    label: "Gemini CLI",
    where: "Run this in a terminal. It adds the server for every project, not only this folder.",
  },
  antigravity: {
    label: "Antigravity",
    where:
      "In Antigravity, open Manage MCP Servers, choose View raw config, add this to " +
      "mcp_config.json, then Refresh.",
  },
  cursor: {
    label: "Cursor",
    where:
      "Add this to Cursor's mcp.json. Other clients that connect by URL with headers take the " +
      "same shape.",
  },
};

/** The name every snippet registers the server under — the one a reader sees in their agent. */
const SERVER_NAME = "mtg-grimoire";

/**
 * One client's configuration for the server at `url`, authenticated with `token`.
 *
 * Pure, and handed the token rather than reading it, so the panel draws the snippet with the
 * token masked and copies it with the real one — **one function for both**, so what is copied is
 * never a second spelling of what is shown.
 *
 * **A one-line command wherever the client has one** — Claude Code's and Gemini CLI's `mcp add`,
 * each at user scope, so the server is there in every project rather than the folder the terminal
 * happened to be in. The others take a file: Codex's `codex mcp add` has no header flag, only an
 * environment variable's name, so its TOML carries the header itself; Antigravity reads
 * `serverUrl`, not `url`.
 *
 * **Claude Desktop goes through `mcp-remote`**, because its config file starts local processes
 * rather than connecting to a URL. The header is passed as `Authorization:${AUTH}` with no space
 * and the value in `env`: on Windows, `npx` re-splits its arguments on spaces, and
 * `Authorization: Bearer …` arrives as three — the workaround `mcp-remote`'s own README gives.
 */
export function clientSnippet(client: McpClient, url: string, token: string): string {
  const bearer = `Bearer ${token}`;
  switch (client) {
    case "claude-code":
      return (
        `claude mcp add --transport http --scope user ${SERVER_NAME} ${url} ` +
        `--header "Authorization: ${bearer}"`
      );
    case "claude-desktop":
      return JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              command: "npx",
              args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH}"],
              env: { AUTH: bearer },
            },
          },
        },
        null,
        2,
      );
    case "codex":
      // The URL is the desktop's `http://127.0.0.1:{port}/mcp` and the token hex, so neither
      // needs a TOML escape.
      return [
        `[mcp_servers.${SERVER_NAME}]`,
        `url = "${url}"`,
        `http_headers = { Authorization = "${bearer}" }`,
      ].join("\n");
    case "gemini":
      // Options before the name, the order Gemini CLI's own reference writes.
      return (
        `gemini mcp add --scope user --transport http ` +
        `--header "Authorization: ${bearer}" ${SERVER_NAME} ${url}`
      );
    case "antigravity":
      return JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: { serverUrl: url, headers: { Authorization: bearer } },
          },
        },
        null,
        2,
      );
    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: { url, headers: { Authorization: bearer } },
          },
        },
        null,
        2,
      );
  }
}

/**
 * What a hidden token is drawn as. **A fixed run, never one dot per character**: the length is
 * public (every token is 64), but a mask that tracked it would be a mask that moves when a
 * rotation answers, and the reader would read that as the token being shown.
 */
export const MASK = "•".repeat(24);

/** No local refusal yet — the {@link Write} the panel's own checks start from. */
const NO_REFUSAL: Write = { submittedAt: 0, isError: false, error: null, isSuccess: false };

/**
 * Settings → Integrations, its first part: the local MCP server (issues #1395 and #1396, PR 1) —
 * an endpoint the running desktop app serves on `127.0.0.1`, so an AI agent on the same computer
 * can read and add to the reader's collection, wishlist and decks.
 *
 * **Not the cloud copy below it, and the two must not read as one switch.** That copy is the
 * group's, on a server, behind a membership; this is a socket on this computer, free, reading the
 * database directly — never the copy. So each part has its own heading, and this one says
 * *nothing leaves this computer* in its first sentence.
 *
 * **The token is the whole of the server's protection**, which is why it is masked until asked,
 * copied rather than retyped, and replaced only after a question: anything on the computer can
 * open a socket to `127.0.0.1` — a web page included — and the token is what makes that socket
 * refuse it. A new token breaks every client configured with the old one, at once.
 *
 * **The port is the reader's to move**, because a launch can find it taken by another program —
 * the one state where `enabled` and `running` disagree, and the status's `error` is the sentence
 * drawn beside the switch. Moving it is the way out, and a port that cannot be bound is refused
 * with the old one still serving.
 *
 * **`aria-disabled` and a guarded handler, never the attribute** — `IntegrationsPanel`'s rule and
 * the app's: a control that takes `disabled` under the reader's press drops the caret to `<body>`.
 *
 * **It reaches the backend itself**, the cloud part's rule: every command answers a fresh status,
 * written straight back under {@link MCP_KEY}, and a refusal re-reads it instead — whatever
 * refused the press is what the panel should draw next. Desktop only, with the panel it is in.
 */
export function LocalMcpSection(): JSX.Element {
  const client = useQueryClient();
  /** The question before replacing the token. */
  const [asking, setAsking] = useState(false);
  /** The token in the clear — off on every mount, so a reader who leaves Settings with it shown
   *  does not come back to it shown. */
  const [revealed, setRevealed] = useState(false);
  /** Which client's snippet is drawn. */
  const [target, setTarget] = useState<McpClient>("claude-code");
  /** The panel's own refusals — a port it would not send, a clipboard that refused — as a
   *  {@link Write}, so the newest of them and the commands' owns the line (`@/lib/writes`). */
  const [refusal, setRefusal] = useState<Write>(NO_REFUSAL);
  /** The New token button, so the question can hand the caret back to it. */
  const rotateRef = useRef<HTMLButtonElement>(null);

  const read = useQuery({ queryKey: MCP_KEY, queryFn: () => ipc.mcpStatus() });
  const status = read.data ?? null;
  const settle = (next: McpStatus) => client.setQueryData<McpStatus>(MCP_KEY, next);
  const reread = () => void client.invalidateQueries({ queryKey: MCP_KEY });
  /** A read in flight answers what was true before the press; landing after the press's own
   *  answer it would draw the old switch back. `IntegrationsPanel`'s `holdReads`. */
  const holdReads = () => client.cancelQueries({ queryKey: MCP_KEY });

  const enable = useMutation({
    mutationFn: () => ipc.mcpEnable(),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const disable = useMutation({
    mutationFn: () => ipc.mcpDisable(),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const rotate = useMutation({
    mutationFn: () => ipc.mcpRotateToken(),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const setPort = useMutation({
    mutationFn: (port: number) => ipc.mcpSetPort(port),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const busy = enable.isPending || disable.isPending || rotate.isPending || setPort.isPending;
  const pressable = status !== null && !busy;
  const on = status?.enabled === true;

  /** A refusal of the panel's own, stamped now so it outranks every earlier press's. */
  const refuse = (sentence: string) =>
    setRefusal({ submittedAt: Date.now(), isError: true, error: sentence, isSuccess: false });

  // The switch refuses a press it is drawn refusing — `aria-disabled`, so a click still lands.
  const toggle = () => {
    if (status === null || !pressable) return;
    if (status.enabled) disable.mutate();
    else enable.mutate();
  };

  const submitPort = (text: string) => {
    if (status === null || !pressable) return;
    const port = parsePort(text);
    if (port === null) return refuse(PORT_RANGE);
    if (port !== status.port) setPort.mutate(port);
  };

  /** A claim about the clipboard, made by the button once the write resolves; a refusal is said
   *  on the panel's line rather than swallowed. */
  const copy = (text: string): Promise<boolean> =>
    copyText(text).then(
      () => true,
      (e: unknown) => {
        refuse(`Couldn't copy: ${ipcError(e)}`);
        return false;
      },
    );

  const dismiss = () => {
    rotateRef.current?.focus();
    setAsking(false);
  };

  const problem =
    writeFailure([enable, disable, rotate, setPort, refusal]) ??
    (status === null && read.isError ? ipcError(read.error) : null);

  const note =
    status === null
      ? ""
      : !status.enabled
        ? MCP_OFF
        : status.running
          ? listeningLine(status.url)
          : (status.error ?? NOT_RUNNING);

  return (
    <div role="group" aria-labelledby={`${ID}-heading`} className="space-y-4">
      <h3 id={`${ID}-heading`} className="text-sm font-medium">
        {MCP_HEADING}
      </h3>
      <p className="text-sm">{MCP_SENTENCE}</p>

      {/* No switch until the status has answered — an Off drawn over a server that may be
          listening would be a claim this panel has not checked. */}
      {status === null ? (
        !read.isError && <p className="text-sm text-dim">Checking…</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p id={`${ID}-switch`} className="text-sm">
              Let agents on this computer connect
            </p>
            <p id={`${ID}-switch-note`} className="mt-0.5 break-all text-xs leading-snug text-dim">
              {note}
            </p>
          </div>
          {/* Named by the line beside it and its own word — `SwitchRow`'s reason, WCAG 2.5.3. */}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={`${ID}-switch ${ID}-switch-state`}
            aria-describedby={`${ID}-switch-note`}
            aria-busy={enable.isPending || disable.isPending || undefined}
            aria-disabled={!pressable || undefined}
            onClick={toggle}
            className={cn(
              SWITCH,
              pressable
                ? switchTone(on)
                : cn(
                    on ? "border-accent text-accent" : "border-border text-dim",
                    "cursor-not-allowed opacity-50 active:scale-100",
                  ),
            )}
          >
            <span id={`${ID}-switch-state`}>{on ? "On" : "Off"}</span>
          </button>
        </div>
      )}

      <PanelAlert tone="problem">{problem}</PanelAlert>

      {/* While on — or on and not running, where an agent's config is still what the reader
          needs once the port is moved. */}
      {status !== null && on && (
        <div className="space-y-4">
          <Field label="Address">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{status.url}</code>
            <CopyButton subject="the address" onCopy={() => copy(status.url)} />
          </Field>

          <Field label="Token">
            <code id={`${ID}-token`} className="min-w-0 flex-1 break-all font-mono text-xs">
              {revealed ? (
                status.token
              ) : (
                <>
                  <span aria-hidden="true">{MASK}</span>
                  <span className="sr-only">Hidden</span>
                </>
              )}
            </code>
            <button
              type="button"
              aria-controls={`${ID}-token`}
              aria-label={revealed ? "Hide the token" : "Show the token"}
              onClick={() => setRevealed((r) => !r)}
              className={cn(PANEL_BUTTON, "h-8 border-border px-2.5 text-xs")}
            >
              {revealed ? "Hide" : "Show"}
            </button>
            <CopyButton subject="the token" onCopy={() => copy(status.token)} />
            <button
              ref={rotateRef}
              type="button"
              aria-disabled={!pressable || undefined}
              aria-busy={rotate.isPending || undefined}
              onClick={() => {
                if (pressable) setAsking(true);
              }}
              className={cn(
                PANEL_BUTTON,
                "h-8 border-border px-2.5 text-xs",
                !pressable && "cursor-not-allowed opacity-50 active:scale-100",
              )}
            >
              New token
            </button>
          </Field>
          <p className="text-xs leading-snug text-dim">
            Agents send the token with every request. Anyone with it can change your collection
            while the app is open, so keep it to your own agents.
          </p>

          <Snippets
            status={status}
            revealed={revealed}
            target={target}
            onTarget={setTarget}
            onCopy={copy}
          />
        </div>
      )}

      {status !== null && (
        // Keyed by the stored port, so a press that moved it — here or in another window —
        // re-seeds the box, and a refused one leaves the reader's draft where they can fix it.
        <PortForm
          key={status.port}
          port={status.port}
          pressable={pressable}
          busy={setPort.isPending}
          onSubmit={submitPort}
        />
      )}

      <ConfirmDialog
        open={asking}
        title="Replace the token"
        confirmLabel="Replace token"
        typeToConfirm={false}
        pending={rotate.isPending}
        onConfirm={() => rotate.mutate()}
        onDismiss={dismiss}
        onClose={() => setAsking(false)}
      >
        Agents set up with the current token stop working at once, until you give them the new one.
      </ConfirmDialog>
    </div>
  );
}

/** A label and the controls on its row — the address's and the token's. */
function Field({ label, children }: { label: string; children: JSX.Element[] | JSX.Element }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-dim">{label}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** How long a Copy button says *Copied* — the lobby code's two seconds (`LobbyParts`). */
const COPIED_MS = 2_000;

/**
 * A Copy button that says *Copied* once the clipboard has taken the text — a claim about the
 * clipboard, so made only after the write resolves (`ExportDialog`'s rule), and inline rather
 * than a toast: the reader is looking at the button.
 */
function CopyButton({ subject, onCopy }: { subject: string; onCopy: () => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      // The visible word first, so the name keeps what is drawn (WCAG 2.5.3).
      aria-label={copied ? `Copied ${subject}` : `Copy ${subject}`}
      onClick={() => void onCopy().then((ok) => ok && setCopied(true))}
      className={cn(PANEL_BUTTON, "h-8 border-border px-2.5 text-xs")}
    >
      {copied ? (
        <Check className="size-3.5 text-ok" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The client choice and its snippet.
 *
 * **A radio group drawn as a segmented switch** — `PriceHistoryDialog`'s `RangeSwitch`: exactly
 * one client is drawn at a time, `aria-checked` says which, and the arrows choose
 * (`radioKeys`, every radio group's since #558). The snippet is drawn with the token masked while
 * the token is, and copied whole either way — {@link clientSnippet} writes both.
 */
function Snippets({
  status,
  revealed,
  target,
  onTarget,
  onCopy,
}: {
  status: McpStatus;
  revealed: boolean;
  target: McpClient;
  onTarget: (next: McpClient) => void;
  onCopy: (text: string) => Promise<boolean>;
}) {
  return (
    <div className="space-y-2">
      <p id={`${ID}-clients`} className="text-xs text-dim">
        Set up an agent
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${ID}-clients`}
        className="flex w-fit max-w-full flex-wrap overflow-hidden rounded-md border border-border"
      >
        {CLIENTS.map((option, i) => {
          const chosen = option === target;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={chosen}
              onClick={() => onTarget(option)}
              {...radioKeys(CLIENTS, target, onTarget, i)}
              className={cn(
                "h-8 px-3 text-xs",
                TOUCH_FLOOR,
                "transition-colors duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none",
                chosen ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
                FOCUS_INSET,
              )}
            >
              {CLIENT_META[option].label}
            </button>
          );
        })}
      </div>
      <p className="text-xs leading-snug text-dim">{CLIENT_META[target].where}</p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-bg p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {clientSnippet(target, status.url, revealed ? status.token : MASK)}
        </pre>
        <CopyButton
          subject={`the ${CLIENT_META[target].label} configuration`}
          onCopy={() => onCopy(clientSnippet(target, status.url, status.token))}
        />
      </div>
    </div>
  );
}

/**
 * The port box and its Save.
 *
 * **A draft until Save or Enter**, never sent on each keystroke: a port typed digit by digit
 * passes through ports nobody chose — `4`, `40`, `400` — and a running server would rebind to
 * each. **Checked here before it is sent** ({@link parsePort}), because a box's text that is not a
 * `u16` would reach the command as a deserialisation error rather than a sentence; the range
 * itself is the desktop's to enforce, and it does.
 */
function PortForm({
  port,
  pressable,
  busy,
  onSubmit,
}: {
  port: number;
  pressable: boolean;
  busy: boolean;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(String(port));
  const unchanged = draft.trim() === String(port);
  const savable = pressable && !unchanged;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (savable) onSubmit(draft);
      }}
      className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
    >
      <label htmlFor={`${ID}-port`} className="text-sm">
        Port
      </label>
      <input
        id={`${ID}-port`}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-describedby={`${ID}-port-hint`}
        className={cn(
          "w-24 rounded-md border border-border bg-bg px-2 py-1 font-mono text-sm text-text",
          TOUCH_FIELD,
          TOUCH_FLOOR,
          FOCUS,
        )}
      />
      <button
        type="submit"
        aria-disabled={!savable || undefined}
        aria-busy={busy || undefined}
        className={cn(
          PANEL_BUTTON,
          "h-8 border-border px-2.5 text-xs",
          !savable && "cursor-not-allowed opacity-50 active:scale-100",
        )}
      >
        Save
      </button>
      <p id={`${ID}-port-hint`} className="w-full text-xs leading-snug text-dim">
        {PORT_MIN}–{PORT_MAX}. Agents need the new address after a change.
      </p>
    </form>
  );
}
