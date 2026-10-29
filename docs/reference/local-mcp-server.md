# The local MCP server — an AI agent on this computer, reading and adding to the collection

[Issue #1395](https://github.com/Msgaihede/mtg-grimoire/issues/1395), and the first PR of
[issue #1396](https://github.com/Msgaihede/mtg-grimoire/issues/1396)'s plan. The design is §7.2 of
[2026-10-24-integration-data-access-design.md](../superpowers/specs/2026-10-24-integration-data-access-design.md):
the local tier, first and free. The code is `apps/desktop/src-tauri/src/mcp/`; the panel is the
Local MCP part of Settings → Integrations (`packages/ui/features/settings/`).

**The one sentence: while the desktop app is open and the switch is on, it serves an MCP endpoint
at `http://127.0.0.1:39147/mcp`, behind a bearer token, whose tools are the app's own commands — so
an agent reads and adds with the fidelity of a press, at once, and nothing leaves the computer.**

---

## 1. What it is, and what it is not

| | |
| --- | --- |
| Transport | MCP **streamable HTTP**: `POST /mcp`, one JSON-RPC message (or a batch) per request, answered with one `application/json` body, or `202` and no body for notifications. No SSE stream: `GET` is `405`, which the transport names as the answer of a server that offers none. No session id. |
| Revisions | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. `initialize` answers the client's own revision when it is one of these and the newest otherwise. An `MCP-Protocol-Version` header naming another is `400`. |
| Address | `127.0.0.1` only (the IPv4 loopback — clients are configured with `127.0.0.1`, never `localhost`, which can resolve to `::1` first). Port `39147` by default, movable in the panel (1024–65535). |
| Who serves it | **The running app.** Not a second process: a second process opening `user.db` is the single-instance trap (`docs/agent/RUNNING_AND_VERIFYING.md`). Closing the app closes the server; the agent's calls fail until it is open again. |
| Gating | **None but the token.** It costs the service nothing, so it is free (issue #1396, knob 5). |
| Platforms | The desktop only. The light app (Android, web) has no server and no row for it. |

The remote tier — the same tools for a hosted agent while the computer is off — is PR 5 of the plan,
over the integrations store. It is not this.

## 2. The tools

Every tool is a translation onto `grimoire_core::commands::dispatch`, the table the light app's
hosts answer through. Nothing in `mcp/tools.rs` reads or writes SQL of its own; a refusal is the
core's own sentence, handed to the agent as a tool result with `isError: true`.

| Tool | Calls | Answers |
| --- | --- | --- |
| `find_cards` | `search_cards` (paper printings; one per card unless `allPrintings`) | Printings with their Scryfall id (`cardId`), set, number, rarity, cost, type and price |
| `get_card` | `card_detail`, `card_holdings` | Oracle text, finishes, legalities, prices per finish, and what the reader owns of the card |
| `search_collection` | `collection_list` | Entries by name words and folder: printing, finish, condition, language, quantity, folder |
| `search_wishlist` | `wishlist_list`, `wishlist_folder_list` | Wishes by name words and folder, with whether a wish is for any printing |
| `list_folders` | `collection_folder_list` / `wishlist_folder_list` / `deck_folder_list` | Folder ids, names and parents; a collection folder's `kind` (only `user` takes an add) |
| `list_decks` | `deck_list` | Deck ids, names, formats and card counts; archived decks only when asked |
| `get_deck` | `deck_get` | One list (`live` or `theory`) pile by pile |
| `add_to_collection` | `collection_add` | Copies of one printing into the root or a `user` folder |
| `add_to_wishlist` | `wishlist_add` (with `card_detail` for an any-printing wish) | A wish for the printing, or for the card |
| `add_card_to_deck` | `deck_category_list`, `deck_add_card` | Copies into a named pile (made if missing) or the list's first main pile — `Main deck` when it has none yet (the editor's by-type pile choice is TypeScript's and is not repeated) |

**The three writes are adds, and only adds** — the issue's list. Nothing changes or removes a row;
an agent proposing that asks the reader, whose app is open. A quantity is 1–99. Each add is a real
write: `with_write`'s fence, the capture triggers, the activity feed, the plain-text mirror, and a
sync op like any press, so it reaches the reader's other devices on the next trip.

**Every write tells every window.** `crate::changes` emits `db:changed` only while a second window
is open, because the window that pressed already knows. An agent's write has no such window, so each
write tool emits `db:changed` itself after its commit, naming the tables it can touch
(`tools::COLLECTION_TABLES`, `WISHLIST_TABLES`, `DECK_TABLES`, held to the schema's user tables by a
test). An open Collection page refreshes under the agent's add.

## 3. Who can reach it

A loopback listener is reachable by every process on the computer **and by every web page the reader
opens**. So a request meets five gates, in this order, before its body is read (`mcp/http.rs`):

1. **`Host` is the loopback and this port** (`127.0.0.1`, `localhost` or `[::1]`). This is the
   defence against DNS rebinding: a page whose name was re-pointed at `127.0.0.1` still sends its own
   name as `Host`. MCP's transport section requires the check.
2. **`Origin`, when present, is an `http://` loopback page.** A browser sends `Origin` on every
   cross-origin `POST`; no MCP client outside a browser does. A local inspector (`http://localhost:6274`)
   passes; any web page, `null`, and `https://` are refused.
3. **`POST /mcp`** — anything else is `404` or `405`.
4. **`Authorization: Bearer <token>`**, compared in constant time. The token is 32 random bytes as 64
   hex digits, made on the first read of the setting, replaced by *New token* and in force on the next
   request (a client holding the old one is refused at once). It lives in `app_meta` `mcp_server`
   beside the switch and the port — a row on no sync spec, so it never leaves this installation.
5. **At most 1 MiB of body**, counted as it arrives.

No CORS header is ever sent, so a page could not read an answer even past gate 2; and the bearer
header makes any page's request preflighted, which gate 3 refuses. Gates 1 and 2 exist anyway because
a write needs no answer read.

## 4. Configuring a client

The panel shows the URL and the token, and a ready-to-copy snippet for each of these. Below,
`<token>` is the token the panel shows; the port is the default.

**Claude Code**

```bash
claude mcp add --transport http mtg-grimoire http://127.0.0.1:39147/mcp --header "Authorization: Bearer <token>"
```

**Cursor** (`~/.cursor/mcp.json`) and **VS Code** (`.vscode/mcp.json` uses `"servers"` and
`"type": "http"` in place of `"mcpServers"`):

```json
{
  "mcpServers": {
    "mtg-grimoire": {
      "url": "http://127.0.0.1:39147/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`) runs local servers as commands, so it reaches an
HTTP one through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which needs Node.js. The
header is passed through an environment variable with no space after the colon — `mcp-remote`'s own
advice, because Windows splits an argument containing a space:

```json
{
  "mcpServers": {
    "mtg-grimoire": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:39147/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer <token>" }
    }
  }
}
```

**By hand**, to see it answer:

```bash
curl -s http://127.0.0.1:39147/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 5. The switch

- **Off by default.** *On* binds the port first and stores the switch only if the bind succeeded,
  so a port another program holds is the press's refusal, never a switch that says on over a server
  nobody answers.
- **At launch**, `desktop::start` resumes a switched-on server after `startup::settle`. A port taken
  since the last launch is not a launch failure: the panel shows the switch on with the reason under
  it (`McpStatus.error`) until the reader picks another port — which starts it there — or switches
  it off.
- **Moving the port while on** binds the new one before letting the old one go, so a refusal leaves
  the server answering where it was.
- **Off** stops the accept loop at once; a keep-alive connection accepted before is refused request
  by request (`503`).

## 6. What is not done

- **Not driven by a real client yet.** The suite covers the gates, the protocol, the settings and
  each tool against a real database on disk, and one test drives the whole path over a real socket
  (`http::tests::a_client_is_answered_over_a_real_socket`: handshake, notification, tool list, a
  call, then `401`, `405`, `400` and `503`). The server has not yet been driven by Claude Desktop,
  Claude Code or Cursor against a built app.
- **No resources or prompts**, only tools. A deck as a resource, or a "build me a deck from my
  collection" prompt, would be additions on the same endpoint.
- **No deck creation, no edits, no removals** — the issue named adds. Each would be one more
  translation in `tools.rs` over a command already in the table.
