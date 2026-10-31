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

|               |                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport     | MCP **streamable HTTP**: `POST /mcp`, one JSON-RPC message (or a batch) per request, answered with one `application/json` body, or `202` and no body for notifications. No SSE stream: `GET` is `405`, which the transport names as the answer of a server that offers none. No session id. |
| Revisions     | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. `initialize` answers the client's own revision when it is one of these and the newest otherwise. An `MCP-Protocol-Version` header naming another is `400`.                                                                          |
| Address       | `127.0.0.1` only (the IPv4 loopback — clients are configured with `127.0.0.1`, never `localhost`, which can resolve to `::1` first). Port `39147` by default, movable in the panel (1024–65535).                                                                                            |
| Who serves it | **The running app.** Not a second process: a second process opening `user.db` is the single-instance trap (`docs/agent/RUNNING_AND_VERIFYING.md`). Closing the app closes the server; the agent's calls fail until it is open again.                                                        |
| Gating        | **None but the token.** It costs the service nothing, so it is free (issue #1396, knob 5).                                                                                                                                                                                                  |
| Platforms     | The desktop only. The light app (Android, web) has no server and no row for it.                                                                                                                                                                                                             |

The remote tier — the same tools for a hosted agent while the computer is off — is PR 5 of the plan,
over the integrations store. It is not this.

## 2. The tools

Every tool but the read graph's three (and `widget_create`'s checks before its write) is a translation onto `grimoire_core::commands::dispatch`,
the table the light app's hosts answer through; those three are `crates/grimoire-graph`'s doors,
over the same read connection. Nothing in `mcp/tools.rs` reads or writes SQL of its own; a refusal is the
core's own sentence, handed to the agent as a tool result with `isError: true`.

| Tool                | Calls                                                                  | Answers                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_cards`        | `search_cards` (paper printings; one per card unless `allPrintings`)   | Printings with their Scryfall id (`cardId`), set, number, rarity, cost, type and price                                                                                                                                                   |
| `get_card`          | `card_detail`, `card_holdings`                                         | Oracle text, finishes, legalities, prices per finish, and what the reader owns of the card                                                                                                                                               |
| `search_collection` | `collection_list`                                                      | Entries by name words and folder: printing, finish, condition, language, quantity, folder                                                                                                                                                |
| `search_wishlist`   | `wishlist_list`, `wishlist_folder_list`                                | Wishes by name words and folder, with whether a wish is for any printing                                                                                                                                                                 |
| `list_folders`      | `collection_folder_list` / `wishlist_folder_list` / `deck_folder_list` | Folder ids, names and parents; a collection folder's `kind` (only `user` takes an add)                                                                                                                                                   |
| `list_decks`        | `deck_list`                                                            | Deck ids, names, formats and card counts; archived decks only when asked                                                                                                                                                                 |
| `get_deck`          | `deck_get`                                                             | One list (`live` or `theory`) pile by pile                                                                                                                                                                                               |
| `add_to_collection` | `collection_add`                                                       | Copies of one printing into the root or a `user` folder                                                                                                                                                                                  |
| `add_to_wishlist`   | `wishlist_add` (with `card_detail` for an any-printing wish)           | A wish for the printing, or for the card                                                                                                                                                                                                 |
| `graph_schema`      | `grimoire_graph::Graph::sdl`                                           | The read graph's whole schema (SDL): everything above and the home page's figures, as one read-only GraphQL schema with a description on every field — what a model writes a home widget's data query against ([graphql.md](graphql.md)) |
| `graph_validate`    | `Graph::validate`                                                      | Whether a GraphQL query is valid, and every problem with its line and column, without running it                                                                                                                                         |
| `graph_query`       | `Graph::run`                                                           | The query's answer as a widget gets it: `data`, `errors` (a failed field is `null` beside the rest) and `extensions.invalidatedBy`                                                                                                       |
| `add_card_to_deck`  | `deck_category_list`, `deck_add_card`                                  | Copies into a named pile (made if missing) or the list's first main pile — `Main deck` when it has none yet (the editor's by-type pile choice is TypeScript's and is not repeated)                                                       |
| `widget_list`       | `custom_widgets`                                                       | The reader's own home-page widgets: id (`widgetId`, what a placed widget's `config` names), name, description and footprint — not the query or the spec                                                                                  |
| `widget_create`     | `Graph::validate`, then `custom_widget_create`                         | A custom widget stored, once its query passed the read graph and its spec the widget catalogue's contract (below); the stored widget as the table answers it                                                                             |

**The four writes are adds, and only adds** — the issue's three, and a custom widget. Nothing
changes or removes a row; an agent proposing that asks the reader, whose app is open. A quantity is
1–99. Each add is a real write: `with_write`'s fence, the capture triggers, the activity feed, the
plain-text mirror, and a sync op like any press, so it reaches the reader's other devices on the
next trip — except a custom widget, which is device-local (user schema v68: never synced, carried
by the full export).

**`widget_create` checks before it writes, and says everything at once.** The query goes through
the read graph's `validate` (each problem with its line and column). The spec is held to the
committed widget catalogue contract, `packages/ui/features/home/generated/catalog.contract.json`
(compiled in with `include_str!`; [generated-widgets.md](generated-widgets.md)), structurally and
with no new crate: the root names an element; every element's `type` is a contract component;
every child key is an element; every prop is one its component declares and every `required` one is
present (a value is never type-checked — any may be an expression like `{"$state": …}`); every
`on.<event>` binding, one or a list, names a contract action or one of json-render's `setState`,
`pushState`, `removeState`, `validateForm`. Every problem of both halves is one sentence naming its
element, all in one refusal, and nothing is stored. Then the table's `custom_widget_create` writes
it, and its own sentences (a blank name, a footprint outside 2–12 × 2–8) are the core's. `w` and
`h` default to 4 and 3.

**Every write tells every window.** `crate::changes` emits `db:changed` only while a second window
is open, because the window that pressed already knows. An agent's write has no such window, so each
write tool emits `db:changed` itself after its commit, naming the tables it can touch
(`tools::COLLECTION_TABLES`, `WISHLIST_TABLES`, `DECK_TABLES`, `CUSTOM_WIDGET_TABLES`, held to the
schema's user tables by a test). An open Collection page refreshes under the agent's add.

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
   hex digits, made on the first read of the setting, replaced by _New token_ and in force on the next
   request (a client holding the old one is refused at once). It lives in `app_meta` `mcp_server`
   beside the switch and the port — a row on no sync spec, so it never leaves this installation.
5. **At most 1 MiB of body**, counted as it arrives.

No CORS header is ever sent, so a page could not read an answer even past gate 2; and the bearer
header makes any page's request preflighted, which gate 3 refuses. Gates 1 and 2 exist anyway because
a write needs no answer read.

## 4. Configuring a client

The panel shows the URL and the token, and a ready-to-copy snippet for each of these — a one-line
command where the client has one (Claude Code, Gemini CLI), its config file's entry otherwise. Below,
`<token>` is the token the panel shows; the port is the default.

**Claude Code** — one line, at user scope so the server is there in every project:

```bash
claude mcp add --transport http --scope user mtg-grimoire http://127.0.0.1:39147/mcp --header "Authorization: Bearer <token>"
```

**Gemini CLI** — one line, at user scope, options before the name (the order its own reference
writes):

```bash
gemini mcp add --scope user --transport http --header "Authorization: Bearer <token>" mtg-grimoire http://127.0.0.1:39147/mcp
```

**Codex** (`~/.codex/config.toml`, which the Codex CLI, its IDE extension and the ChatGPT desktop
app all read). `codex mcp add --url` takes no header, only `--bearer-token-env-var` — an environment
variable the reader would have to set and every Codex process inherit — so the panel writes the
table with the header inline:

```toml
[mcp_servers.mtg-grimoire]
url = "http://127.0.0.1:39147/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

**Antigravity** (_Manage MCP Servers → View raw config_, `mcp_config.json`) reads `serverUrl` for a
streamable HTTP server, not `url`:

```json
{
  "mcpServers": {
    "mtg-grimoire": {
      "serverUrl": "http://127.0.0.1:39147/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Only clients that run on this computer are offered.** The server listens on `127.0.0.1`, so a
client whose agent runs on its vendor's servers cannot reach it: ChatGPT's chats (web and desktop —
custom MCP servers are connected from OpenAI's side, and its connector form takes OAuth or nothing,
no bearer header), the Gemini app, claude.ai, and — as far as is known — Claude Desktop's own
_Connectors_ page, which is why Claude Desktop goes through an extension or its config file below. The only bridges
(a tunnel, OpenAI's Secure MCP Tunnel) would put the collection on the internet, the opposite of
this server's promise. ChatGPT's desktop app reaches the server through Codex, which reads the file
above.

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

**Claude Desktop, in one click: an extension** (`src/mcp/claude_desktop.rs`). Claude Desktop runs
local servers as commands; it does not connect to a URL. The panel's _Install in Claude Desktop_ has
the desktop build an [MCP Bundle](https://github.com/modelcontextprotocol/mcpb) — a zip Claude
Desktop calls an extension — write it to `<data dir>/mcp/mtg-grimoire.mcpb` and open it, and Claude
Desktop answers with its own install dialog. _Save extension…_ writes the same file through the
desktop's save dialog, for a Claude Desktop that did not take it (it installs from Settings →
Extensions there too). No path crosses IPC either way.

- **Three files**: `manifest.json` (manifest `0.3`, `name` `mtg-grimoire`, `version` the app's),
  `server/index.js` and `icon.png` (the app's 128 px icon).
- **The server is a bridge with no dependencies** (`src/mcp/claude_desktop/server.js`): JSON-RPC
  lines on stdin, each `POST`ed to the app, every answer — JSON or an event stream's `data:` lines —
  written back a line at a time; the revision `initialize` agreed is sent as
  `MCP-Protocol-Version` after it. It runs on the Node.js Claude Desktop ships with (`fetch`,
  Node ≥ 18, the manifest's `compatibility`), so the reader installs nothing. A request the app
  cannot answer — closed, switched off, a replaced token — is answered with a JSON-RPC error in
  words, never silence.
- **The address and the token are in the manifest** (`mcp_config.env`: `MTG_GRIMOIRE_URL`,
  `MTG_GRIMOIRE_TOKEN`), not asked for by the install dialog (`user_config`), which would have the
  reader paste the token — the step the bundle replaces. So the token is in Claude Desktop's
  extension folder in plain text, as it is in the config file below, and _New token_ or a moved
  port means installing it again; the panel says so under the buttons.
- **Refused while the switch is off**: an extension installed then would fail on its first request.
- **Tested** by `claude_desktop::tests`: the archive's three entries and the manifest's fields, and
  the bridge run on `node` as Claude Desktop runs it, against the real listener — the handshake,
  a notification, the tool list, then a stale token and a closed port each answered in words. The
  test says so and passes where no `node` is on the `PATH`. **Not yet installed into a real Claude
  Desktop**; how it treats a second install of the same `version` (after _New token_) is unseen.

**Claude Desktop, by hand** (`claude_desktop_config.json`) runs local servers as commands, so it reaches an
HTTP one through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which needs Node.js. The
header is passed through an environment variable with no space after the colon — `mcp-remote`'s own
advice, because Windows splits an argument containing a space:

```json
{
  "mcpServers": {
    "mtg-grimoire": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:39147/mcp",
        "--header",
        "Authorization:${AUTH}"
      ],
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

- **Off by default.** _On_ binds the port first and stores the switch only if the bind succeeded,
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
- **No deck creation, no edits, no removals** — the issue named adds; a custom widget is
  created and never changed or deleted here (the page's dialog does that). Each would be one more
  translation in `tools.rs` over a command already in the table.
