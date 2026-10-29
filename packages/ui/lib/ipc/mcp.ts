/**
 * The local MCP server: an endpoint the running desktop app serves on `127.0.0.1`, so an AI agent
 * on the same computer can read and add to the reader's collection, wishlist and decks (issues
 * #1395 and #1396, PR 1).
 *
 * **One domain of `../ipc.ts`.** Nothing outside `packages/ui/lib/ipc*` imports this file: every
 * page, hook, story and test goes through `@/lib/ipc`, which re-exports these types and spreads
 * `mcpCommands` into `ipc`. ESLint refuses the deep import, and `ipc.test.ts` reads this file with
 * its siblings, so the struct-parity walk and the argument-name fences cover it.
 *
 * **Not `./integrations.ts`, though the panel draws both**: that domain is the group's copy on a
 * server, behind a membership and a relay token; this one is a socket on the reader's own machine,
 * with no membership, no relay and nothing leaving the computer. The two share a Settings panel and
 * nothing else — the server reads the database directly, never the copy.
 *
 * **Desktop only.** The commands are registered by `desktop.rs` alone; the light app's hosts have
 * no socket to open, and its Settings leaves the panel out (`LIGHT_SETTINGS`).
 */
import { invoke } from "./invoke";

/**
 * What the panel's local part draws — `apps/desktop/src-tauri/src/mcp/mod.rs`' `McpStatus`.
 *
 * Every command of the domain answers one, so a press draws its outcome without a second read.
 *
 * **`enabled` and `running` are two facts, and the panel needs both**: `enabled` is the switch as
 * stored — what the reader asked for, and what the next launch will try — and `running` is whether
 * the socket is listening right now. They disagree exactly when a launch could not bind the port
 * (another program took it while the app was closed), and {@link error} is then the sentence.
 */
export interface McpStatus {
  /** The switch as stored: whether the reader wants the server on. */
  enabled: boolean;
  /** Whether it is listening right now. */
  running: boolean;
  /** The port it listens on, or will — 1024 to 65535. */
  port: number;
  /** `http://127.0.0.1:{port}/mcp`, built by Rust so the panel never spells the address itself. */
  url: string;
  /**
   * The bearer token a client sends as `Authorization: Bearer <token>` — 64 hex characters.
   *
   * **A secret on the wire to this window only**: the panel masks it until asked, and it is in no
   * notification, log line or export. Anything on the computer that can open a socket can reach
   * `127.0.0.1`, so the token is the whole of what stops a web page or another program writing to
   * the reader's collection.
   */
  token: string;
  /** Why an enabled server is not running — the port was taken at launch — or `null`. */
  error: string | null;
}

export const mcpCommands = {
  /** The panel's state — `mcp_status`. Nothing beyond this process is asked. */
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  /**
   * Start listening and store the switch on — `mcp_enable`. **Refused, with the switch left as it
   * was, when the port cannot be bound**: the switch is stored only once the socket is open, so a
   * press never stores On over a server no client can reach.
   */
  mcpEnable: () => invoke<McpStatus>("mcp_enable"),
  /** Stop listening and store the switch off — `mcp_disable`. Every connected client drops. */
  mcpDisable: () => invoke<McpStatus>("mcp_disable"),
  /**
   * A new token, effective at once — `mcp_rotate_token`. **Every client configured with the old
   * one stops working on its next request**, which is the point of the press and why the panel
   * asks first.
   */
  mcpRotateToken: () => invoke<McpStatus>("mcp_rotate_token"),
  /**
   * Move the server to `port` — `mcp_set_port`, 1024 to 65535. While running it rebinds, and a
   * port that cannot be bound is refused **with the old one still serving**, so a typo never takes
   * a working server down.
   *
   * `port` under its own name: `invoke` matches arguments by name, and a misspelt key is *dropped*
   * — here a refusal to deserialize rather than a silent default, but a sentence about a missing
   * field is not one the reader can act on. `ipc.test.ts` pins it.
   */
  mcpSetPort: (port: number) => invoke<McpStatus>("mcp_set_port", { port }),
};
