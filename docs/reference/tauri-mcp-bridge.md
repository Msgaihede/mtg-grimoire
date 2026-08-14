# The Tauri MCP bridge

The second way to drive the real window, beside
[the CDP harness](live-ui-verification.md). Everything below was measured on 2026-08-14
against a **debug** build (`npm run tauri dev`), plugin `0.12.0`, Tauri 2.11.5.

## It is two halves, and only one of them was ever installed

`.mcp.json` runs `@hypothesi/tauri-mcp-server`, and that package is **only ever a client**.
It dials a WebSocket that `tauri-plugin-mcp-bridge` opens **inside the running app**. Until
2026-08-14 this repo had the client and no plugin, so every `mcp__tauri__*` tool was listed,
none of them worked, and `driver_session status` answered `{"connected":false}` with nothing
to say why. That is the whole of what was wrong — there was no bug to find in the app.

Four pieces, and the bridge is dark if any one is missing:

| Piece | Where | Why |
| --- | --- | --- |
| `tauri-plugin-mcp-bridge = "0.12"` | `src-tauri/Cargo.toml` | the server half |
| `Builder::new().bind_address("127.0.0.1").build()` | `src-tauri/src/lib.rs`, under `#[cfg(debug_assertions)]` | opens the port |
| `"withGlobalTauri": true` | `src-tauri/tauri.conf.json` | `bridge.js` reaches IPC through `window.__TAURI__` |
| three `mcp-bridge:` permissions | `src-tauri/capabilities/default.json` | the ACL gates the webview's half |

**Keep the crate and the npm package on the same minor.** They are one protocol in two
packages, so `.mcp.json` pins `@0.12` against the crate's `"0.12"`. The `-y` beside it is
not cosmetic: an unprimed `npx` prompts to install, and a stdio MCP server that stops to ask
a question never finishes starting.

## Why three permissions and not `mcp-bridge:default`

`:default` grants all thirteen commands. Ten of them are dispatched **in Rust** by the
plugin's own `websocket.rs` and never cross the IPC boundary, so the ACL is not in their
path and granting them buys nothing. The webview invokes exactly three:

- **`report_ipc_event`** — `bridge.js:145`, the wrapper that makes IPC monitoring work
- **`request_script_injection`** — `bridge.js:658`, on page load and `popstate`
- **`script_result`** — `commands/execute_js.rs:249`, baked into the wrapper `execute_js`
  evals. **This is the one that looks droppable and is not**: it is how a script's return
  value gets home, so without it every `webview_execute_js` succeeds and answers nothing.

Invoking one of *this app's* commands needs no entry at all. Tauri v2's ACL gates `core:`
and `plugin:` commands; an app's own `#[tauri::command]` is always callable.

## `ipc_execute_command` does not reach app commands

Measured, and it is upstream's shape rather than a misconfiguration: the `invoke_tauri`
handler in the plugin's `websocket.rs` matches a hardcoded six —
`get_window_info`, `get_backend_state`, `start_ipc_monitor`, `stop_ipc_monitor`,
`get_ipc_events`, `emit_event` — and everything else falls to
`_ => "Unsupported Tauri command: {name}"`. So:

```
ipc_execute_command  get_marketplace                    → Unsupported Tauri command
ipc_execute_command  plugin:mcp-bridge|get_window_info  → {"success":true, …}
```

**Reach the app's own commands through `webview_execute_js` instead**, which works because
`withGlobalTauri` is on — this returned `"tcgplayer"` and 25 format specs:

```js
(async () => await window.__TAURI__.core.invoke('get_marketplace'))()
```

The IPC monitor still sees those calls; they are ordinary `invoke`s once they leave the page.

## What was verified working

`driver_session` · `webview_execute_js` (with return values) · `webview_dom_snapshot`
(`structure`, scoped) · `webview_find_element` · `webview_interact` · `webview_wait_for` ·
`webview_screenshot` · `manage_window` · `ipc_get_backend_state` · `ipc_execute_command`
(plugin commands) · `ipc_monitor` + `ipc_get_captured` · `read_logs source=console`.

`ipc_get_captured` returns **whole arguments and whole results** — the DOM snapshot that
went through it came back in full, tens of kilobytes of it. Filter it.

## Traps

- **`127.0.0.1`, not the plugin's `0.0.0.0` default.** The bridge executes arbitrary
  JavaScript and any command in the handler on request, and authenticates nothing. Upstream
  binds every interface so you can drive a phone on your LAN; here that would offer a
  local-only app's whole IPC surface to whatever network the machine is on.
- **Port 9223**, and the plugin counts *upward* from it when it is busy — so a second app
  would answer on 9224 and `driver_session` would connect to the wrong one. It cannot
  happen here, because single-instance means there is never a second app. 9223 is
  deliberately clear of the three ports this repo hardcodes: 1420 Vite, 6006 Storybook,
  9222 CDP.
- **The `app` lock still applies.** The bridge is not a way around it — it needs the running
  app, so it is the same one app across every worktree. `running-the-app` owns that protocol.
- **The bridge needs no `--remote-debugging-port`**, unlike CDP. Both can be up at once;
  they are different transports onto the same window.
- **`tauri.conf.json` is embedded at compile time**, so `withGlobalTauri` arrived with a Rust
  rebuild rather than a dev-server restart.
- **Persistent script injection is the one feature the CSP refuses.**
  `__MCP_INJECT_SCRIPTS__` appends a `<script>` to the DOM, which `script-src 'self'` blocks
  — unlike `execute_js`, whose eval is host-injected and never sees the policy. No MCP tool
  exposes it, so nothing an agent can reach is affected.

## Where else this is written down

`src-tauri/CLAUDE.md` carries the binding rules — the permission set, the bind address, and
what keeps `withGlobalTauri` honest in a release build.
