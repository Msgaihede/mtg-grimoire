# The local MCP server — an AI agent on this computer, reading the collection and building widgets

[Issue #1395](https://github.com/Msgaihede/mtg-grimoire/issues/1395), and the first PR of
[issue #1396](https://github.com/Msgaihede/mtg-grimoire/issues/1396)'s plan. The design is §7.2 of
[2026-10-24-integration-data-access-design.md](../superpowers/specs/2026-10-24-integration-data-access-design.md):
the local tier, first and free. The code is `apps/desktop/src-tauri/src/mcp/`; the panel is the
Local MCP part of Settings → Integrations (`packages/ui/features/settings/`).

**The one sentence: while the desktop app is open and the switch is on, it serves an MCP endpoint
at `http://127.0.0.1:39147/mcp`, behind a bearer token, whose tools are the app's own commands — so
an agent reads with the fidelity of the app's own pages, at once, and nothing leaves the computer.**
It writes nothing of the reader's cards, decks or wishlists; the one thing it writes is the reader's
custom home widgets, and the one thing it changes besides is what one window shows (`show_search`,
after the reader says yes in chat).

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

Every tool but the read graph's three, `read_guide` (which answers a prompt's text) and `widget_create`'s checks before its write is a translation onto `grimoire_core::commands::dispatch`,
the table the light app's hosts answer through; those three are `crates/grimoire-graph`'s doors,
over the same read connection. Nothing in `mcp/tools.rs` reads or writes SQL of its own; a refusal is the
core's own sentence, handed to the agent as a tool result with `isError: true`.

| Tool                | Calls                                                                  | Answers                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_cards` | `search_cards` (paper printings; one per card unless `allPrintings`) | Printings with their Scryfall id (`cardId`), set, number, rarity, cost, type and price. A `filters` object takes the Search page's filter bar: `format`, `colors` (`colorsExact`), `types`, `rarities`, `sets`, `manaValues` (`manaX`), `owned`, `priceMin`/`priceMax` (in the reader's marketplace currency), `oracleTags` and `gameChanger`, with or without a name `query`; `syntax` takes a Scryfall search beside both (below) |
| `show_search` | `format_specs_list` and `tag_resolve` (`find_cards`' filter checks), then `search:show` to one window | What the Search page shows once it has run the search: `shown`, `cameForward`, `total` (`totalIsCapped`), `keywords`, `words` and `unknownTags`, with a `note` when the wall is empty, the search failed, or the window stayed behind or did not answer. Takes `text` (the Search box, in Scryfall syntax; at most 1,000 characters), `find_cards`' `filters` plus `borders`, `finishes` and `universe`, `sort` and `allPrintings`. Changes what one window shows, never data (below) |
| `get_card` | `get_marketplace`, `card_detail`, `card_holdings`, `card_oracle_tags`, `card_related`, `combos_for_card`, and the two lists' status commands (`oracle_tags_status`, `combos_status`) | Oracle text, finishes, legalities, prices per finish (in the reader's marketplace), and what the reader owns of the card; its `faces`, its direct oracle `tags` (with `tagData`: when the tag list was downloaded), what it brings with it (`related`: tokens, emblems, meld parts, combo pieces; at most 25, with `relatedTotal` the full count when there are more; `comboPiece` is Scryfall's word for cards that refer to each other, not a Spellbook combo) and how many Spellbook combos name it (`comboCount`, with `comboData`) |
| `search_collection` | `collection_list`                                                      | Entries by name words, a Scryfall search (`syntax`) and folder: printing, finish, condition, language, quantity, folder |
| `search_wishlist`   | `wishlist_list`, `wishlist_folder_list`                                | Wishes by name words, a Scryfall search (`syntax`) and folder, with whether a wish is for any printing |
| `list_folders`      | `collection_folder_list` / `wishlist_folder_list` / `deck_folder_list` | Folder ids, names and parents; a collection folder's `kind` (only `user` takes an add)                                                                                                                                                                                                                                          |
| `list_decks`        | `deck_list`                                                            | Deck ids, names, formats and card counts; archived decks only when asked                                                                                                                                                                                                                                                        |
| `get_deck`          | `deck_get`                                                             | One list (`live` or `theory`) pile by pile                                                                                                                                                                                                                                                                                      |
| `graph_schema`      | `grimoire_graph::Graph::sdl`                                           | The read graph's whole schema (SDL): everything above and the home page's figures, as one read-only GraphQL schema with a description on every field — what a model writes a home widget's data query against ([graphql.md](graphql.md))                                                                                        |
| `graph_validate`    | `Graph::validate`                                                      | Whether a GraphQL query is valid, and every problem with its line and column, without running it                                                                                                                                                                                                                                |
| `graph_query`       | `Graph::run`                                                           | The query's answer as a widget gets it: `data`, `errors` (a failed field is `null` beside the rest) and `extensions.invalidatedBy`                                                                                                                                                                                              |
| `card_combos` | `combos_for_card` (`produces`, `search`, `cardCount`, `ownedOnly`) | Commander Spellbook combos that name a card, each short (`comboId`, cards, what it produces, bracket, templates needed, popularity), with `total`, `matching`, `ownedTotal`, `sizes` and `comboData` |
| `get_combo` | `combo_get` | One combo whole: cards, steps, prerequisites, templates, mana needed, what it produces and Spellbook's `url` |
| `held_combos` | `deck_get`, `combos_for_cards`, `deck_commander_identities`, `format_specs_list` and `combos_near` for a deck; `format_specs_list` and `combos_in_collection` for the collection; `combos_status` | The combos a deck holds whole (read by its active piles) and, by default, the ones it is one card short of, with the missing card; with no `deckId`, the same over the whole collection (`format` and `identity` narrow the missing card) |
| `card_scryfall` | `card_raw` | The whole Scryfall record of up to 20 printings in Scryfall's own format (`keywords`, `layout`, `produced_mana`, `card_faces`...), minus image and shop links unless `fields` names them; `missing` names an id the database lacks |
| `find_tags` | `tag_search`, `oracle_tags_status` | Scryfall's community oracle tags whose name matches words, with their slugs (what `find_cards` takes in `filters.oracleTags`) and how many cards hold each |
| `similar_cards` | `cards_similar` | Cards that do what a card does, ranked by the oracle tags they share (a rare tag weighs more), narrowed by `format` and `identity`; each row names its newest printing, type, cost, score and the shared tags that weigh most |
| `format_rules` | the core's format table | Each format's deck size, copies allowed, sideboard, singleton, commander, starting life, companion, mana value cap, what restricted means, whether the app checks decks in it (`validates`) and whether it has legality data (`searchable`) |
| `read_guide` | `prompts::get` | The text of one of the server's prompts by name, for a client that lists tools but shows its user no prompts |
| `widget_vocabulary` | the committed `catalog.prompt.md` (and `catalog.contract.json`)        | The widget catalogue as a model writes from it: the spec format, every component and its props, the actions and functions, and the app's rules — with `includeContract`, the same as JSON Schema                                                                                                                                |
| `widget_check`      | `Graph::validate`, the contract check                                  | Whether a query, a spec or both would be stored, and every problem by element — `widget_create`'s checks, storing nothing                                                                                                                                                                                                       |
| `widget_preview`    | `Graph::run`                                                           | The state a spec is drawn over: the answer's data at the root, `/ui` and `/settings` seeded from the spec (`settings` laid over), the query asked with the variables its settings fill (`variables`), beside the graph's errors and the spec's problems — the page's `widgetState` and `queryVariables`, held to shared goldens |
| `widget_list`       | `custom_widgets`                                                       | The reader's own home-page widgets: id (`widgetId`, what a placed widget's `config` names), name, description and footprint — not the query or the spec                                                                                                                                                                         |
| `widget_get`        | `custom_widgets`                                                       | One widget whole: name, description, query, spec and footprint                                                                                                                                                                                                                                                                  |
| `widget_create`     | `Graph::validate`, then `custom_widget_create`                         | A custom widget stored, once its query passed the read graph and its spec the widget catalogue's contract (below); the stored widget as the table answers it                                                                                                                                                                    |
| `widget_update`     | the same checks, then `custom_widget_update`                           | A widget changed: only the fields given, a query or spec given checked first; the stored widget                                                                                                                                                                                                                                 |
| `widget_delete`     | `custom_widget_delete`                                                 | A widget deleted; the home page takes its placed copies off when it next reads the list                                                                                                                                                                                                                                         |

**The card knowledge tools** (`card_combos` to `read_guide`) answer how cards work together. Their
core commands (`combo_get`, `combos_near`, `combos_in_collection`, `card_raw`, `card_related`,
`card_oracle_tags`, `cards_similar`) live in `grimoire-core` on `command_table::TABLE_ONLY`, so the
light app's hosts answer them too, and `combos_for_card` gained a `produces` filter. **The combo list is
Commander Spellbook's and holds Commander-legal combos only**; the oracle tags are Scryfall's. Each list
is downloaded on its own, so an answer whose list is missing says so in a note (`comboData`, `tagData`)
rather than answering "none". Schema 9 added `combos.requires` (the templates a combo needs, "a creature
with..."), so the combo tables rebuild and download again at the first launch after it. **Every answer
that is an object is also its `structuredContent`** (`rpc::done_result`; MCP allows nothing else there),
beside the text block older clients read; an array answer and a refusal carry the text alone.

**Scryfall syntax** (project C, [search-syntax.md](search-syntax.md#the-rust-port-project-c)):
`find_cards`, `search_collection` and `search_wishlist` take a Scryfall search in `syntax`, ANDed with
their other arguments. It is read by `grimoire_core::query_language`, the page's parser ported to Rust
and held to it by a shared golden, through `read`, which refuses every term it would not apply as
written in one answer; every tag it names, inside an `or` too, is resolved first (`tag_resolve`) and an
unknown one refused with its closest names (`tag_search`). The translation is `mcp/syntax.rs`; no core
command was added.

**No tool writes the reader's collection, wishlist or decks** (the owner's decision, 2026-10-31,
which retired the issue's three adds, `add_to_collection`, `add_to_wishlist` and
`add_card_to_deck`). An agent finds and explains; the reader makes a change in the app, which is
open. **A custom widget is the one thing a tool writes**: it is something an agent builds for the
reader, so `widget_create`, `widget_update` and `widget_delete` may store, rewrite or remove it —
the last two annotated `destructiveHint`. A widget is device-local (user schema v68: never synced,
carried by the full export).

**`show_search` changes what one window shows** (project B,
[2026-11-25-mcp-show-search-design.md](../superpowers/specs/2026-11-25-mcp-show-search-design.md);
`mcp/show.rs`). Every argument is checked before anything is sent, with `find_cards`' sentences, so
a refused call changes no window. The window is the one the reader last focused
(`window::LastFocused`, fed by `Focused(true)` and forgotten on `Destroyed`), else `main`, else the
first label in sorted order; the tool reaches it only through the `SearchWindows` seam
(`window::DesktopWindows`; a fake in tests), never an `AppHandle`. The search goes as a
`SearchHandoff` in the filter bar's own shape — a value the bar has no control for (`gameChanger`, a format the picker lacks, the `special`
and `bonus` rarities) goes into the text as a keyword, after the agent's text, which is put in
parentheses first when it holds an `or` — emitted as `search:show` to that window
alone. The page listens on its own window (`onSearchShow`), hands it to the store as the one-shot
`showSearchHandoff`, and the Search page applies it over a clean slate. Then the window is
unminimized, shown and focused, and Windows is asked whether it came forward (`GetForegroundWindow`,
since `set_focus` answers `Ok` either way); when it did not, its taskbar button flashes and the
answer says `cameForward: false`. The page answers once the wall has answered that search (never
the previous search's placeholder rows), through `mcp_search_shown(id, report)`. The tool waits at
most 5 seconds and then answers `shown: null`, the search sent and unanswered, which is not a
refusal; a second call while one waits answers the first `shown: false`. Annotated
`readOnlyHint: false`, `idempotentHint: true`. The tool cannot check that the reader said yes, so
its description, the `instructions` and the `search_cards` prompt each tell the agent to ask in chat
first and call once per yes.

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
`h` default to 4 and 3. `widget_update` checks whichever of the two halves it is given the same
way (`widget_problems`, which `widget_check` also answers), and a refused update changes nothing.
**A query's variables are its settings** (the page's rule, `queryVariables.ts`): each declared
variable is filled from the setting of its name, so the pair is checked too — a required variable
(`!`, no default) the spec's `state.settings` does not seed is refused, and an update that sends one
half is held to the stored other half.

**Writing a widget, as an agent would.** `widget_vocabulary` (or the MCP prompt `create_widget`,
below) for the catalogue; `graph_schema` for the data; `widget_check` and `widget_preview` until the
query, the spec and the state agree; then `widget_create`. `widget_preview`'s state is built in Rust
(`tools::widget_state`), and the page builds it in TypeScript (`widgetState.ts`): both hold to
`packages/ui/features/home/generated/__golden__/widget-state.json`, so a preview is what the page
draws.

**Five MCP prompts — the server's skills** (`prompts/list`, `prompts/get`; the `prompts`
capability; `mcp/prompts.rs`, the owner's decision 2026-10-31 to ship them as prompts rather than
files a reader installs). Each is a Markdown file beside the code, `mcp/prompts/*.md`, compiled in,
with one optional argument for the user's own words:

| Prompt              | Argument   | What it teaches                                                                                                                                                                                         |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_cards`      | `request`  | Which tool answers which question (all cards, the collection, the wishlist), the read graph's structured filters (`searchCards`, `collectionEntries`, `wishlistEntries`) for anything beyond a name, and when and how to show a search in the app (`show_search`: ask first, `filters` or `text`, reading the answer) |
| `create_widget`     | `idea`     | The steps to write, check, preview and store a custom widget, closing with the whole widget catalogue (`catalog.prompt.md`)                                                                             |
| `graphql_discovery` | `question` | A map of the graph's root fields, how its schema reads (nullability, ids, money, timestamps, filters, depth), and how to find, check and run a query                                                    |
| `card_interactions` | `question` | Which tool answers what a card does, its combos, cards that do the same job, what it brings with it, its Scryfall record and a format's rules, and what each source can and cannot tell (Commander-legal combos only, templates, a list not yet downloaded) |
| `scryfall_syntax` | `search` | Scryfall's search language as the three search tools take it in `syntax`: the grammar, what a bare `:` means per keyword, where the app differs from Scryfall (word-prefix `t:`/`o:`, tags by name, no regular expressions or display keywords), how a refusal reads and worked examples, closing with a keyword reference generated from the parser's table |

Every fenced `graphql` example in them is held to the graph (`every_example_query_is_valid`), so a
renamed field fails the build rather than an agent; every example search must pass the parser's
`read` (`every_example_search_reads_as_written`). The server's `instructions` name the four (a test holds them to every tool and prompt), and `read_guide`
answers any of them by name for a client that shows its user no prompts.

**Every write tells every window.** `crate::changes` emits `db:changed` only while a second window
is open, because the window that pressed already knows. An agent's write has no such window, so each
widget write tool emits `db:changed` itself after its commit, naming the tables it can touch
(`tools::CUSTOM_WIDGET_TABLES`, held to the
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
- **No resources**, only tools and prompts. A deck as a resource would be an addition on the same
  endpoint.
- **No deck creation, no edits, no removals** — the owner retired the adds; a custom widget is the
  one thing created, updated and deleted here. Each would be one more translation in `tools.rs` over a
  command already in the table.
- **Card knowledge is not whole.** Still to do, as the later projects of the card knowledge plan:
  rulings (project D), and deck statistics, validation, the bracket and the other deck tools
  (project E).
