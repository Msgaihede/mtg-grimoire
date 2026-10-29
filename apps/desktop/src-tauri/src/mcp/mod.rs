//! **The local MCP server** (issue #1395; issue #1396's PR 1; spec
//! `2026-10-24-integration-data-access-design.md` §7.2): a streamable-HTTP MCP endpoint on
//! `http://127.0.0.1:{port}/mcp`, served by the running app while the reader has it switched on in
//! Settings → Integrations, so an AI agent on this computer — Claude Desktop, Claude Code, Cursor —
//! can read and add to the collection, the wishlist and the decks.
//!
//! **The running app serves it, and that is the design rather than a convenience.** A second
//! process opening `user.db` is the single-instance trap `RUNNING_AND_VERIFYING.md` describes; here
//! every tool is a call into the same `grimoire_core::commands::dispatch` the light app's hosts
//! answer through, on this process's own connections, so a tool reads and writes with the fidelity
//! of a press — the capture triggers record an add and it syncs to every device as this device's
//! own op. Nothing leaves the computer, and nothing is gated on a membership: it costs the service
//! nothing (issue #1396, knob 5).
//!
//! Four files:
//!
//! - this one: the setting (`app_meta` `mcp_server`), the [`McpSlot`] holding the one listener, the
//!   five `#[tauri::command]`s behind the panel, and [`resume`] at launch;
//! - [`http`]: the listener and the gates a request passes before it is read — the host, the
//!   origin, the method, the token, the size;
//! - [`rpc`]: JSON-RPC 2.0 and MCP's lifecycle — `initialize`, `ping`, `tools/list`, `tools/call`;
//! - [`tools`]: the ten tools, each a short translation into one or two table commands.
//!
//! **Who can reach it.** A listener on the loopback is reachable by every process on the computer
//! and by any web page the reader opens, so it answers nobody who does not carry the token, and it
//! refuses a request a browser could have made on a page's behalf before it looks at the token:
//! one whose `Host` is not the loopback (DNS rebinding) or whose `Origin` is a web page's
//! ([`http::gate`]). The token is 32 random bytes, kept in `app_meta` beside the switch — a row
//! no sync spec names, so it never leaves this installation — and compared in constant time.

pub mod http;
pub mod rpc;
pub mod tools;

use crate::sync::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// The `app_meta` key holding [`Settings`] as JSON. `app_meta` is on no sync spec, so the switch,
/// the port and the token are this installation's: a paired laptop has a server of its own or none.
pub const K_SETTINGS: &str = "mcp_server";

/// Where the server listens unless the reader moves it. Unassigned by IANA and far from the
/// development ports a reader's other tools default to (3000, 5173, 6006, 8080…).
pub const DEFAULT_PORT: u16 = 39147;

/// The lowest port the panel may move it to: below this a port is privileged on Linux and macOS,
/// and on every system it is some well-known service's.
pub const MIN_PORT: u16 = 1024;

/// What `app_meta` holds. **Reading can never fail**, `mirror::settings`' rule: a missing row and a
/// row a newer build wrote both read as the default, off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: false,
            port: DEFAULT_PORT,
            token: String::new(),
        }
    }
}

/// What the panel draws. `packages/ui/lib/ipc.ts`'s `McpStatus` mirrors it, field for field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// The switch as stored: whether the reader wants the server on.
    pub enabled: bool,
    /// Whether it is listening right now.
    pub running: bool,
    pub port: u16,
    /// `http://127.0.0.1:{port}/mcp` — what a client's configuration names.
    pub url: String,
    /// The bearer token a client sends as `Authorization: Bearer <token>`, 64 hex digits.
    pub token: String,
    /// Why a switched-on server is not listening — the port was taken at launch — else `None`.
    pub error: Option<String>,
}

/// The URL a client is configured with. **`127.0.0.1`, never `localhost`**: the listener is bound
/// to the IPv4 loopback alone, and a client that resolves `localhost` to `::1` first would find
/// nothing there.
pub fn url_of(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

/// What a running listener shares with every request it answers.
///
/// **The token is behind a lock rather than copied into the listener**, so *New token* takes
/// effect on the next request without a restart — a client still holding the old one is refused
/// at once, which is what a reader rotating it because it leaked is asking for.
pub struct Gate {
    pub port: u16,
    token: RwLock<String>,
    /// Set when the listener is stopped. A keep-alive connection accepted before the stop outlives
    /// the accept loop, so every request asks this before it is answered.
    stopped: AtomicBool,
}

impl Gate {
    pub fn new(port: u16, token: String) -> Self {
        Gate {
            port,
            token: RwLock::new(token),
            stopped: AtomicBool::new(false),
        }
    }

    /// Whether `presented` is the token, compared in constant time over its bytes.
    pub fn admits(&self, presented: &str) -> bool {
        let token = self.token.read().unwrap_or_else(|e| e.into_inner());
        same_secret(presented.as_bytes(), token.as_bytes())
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn rotate(&self, token: String) {
        *self.token.write().unwrap_or_else(|e| e.into_inner()) = token;
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

/// Equal length and equal bytes, with no early exit on the first difference — so how long a refusal
/// takes says nothing about how much of a guess was right. The length is not secret: every token
/// this module makes is 64 hex digits.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A running listener: its gate, and the accept loop's task.
struct Live {
    gate: Arc<Gate>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Live {
    fn stop(self) {
        self.gate.stop();
        self.task.abort();
    }
}

#[derive(Default)]
struct Slot {
    live: Option<Live>,
    /// Why [`resume`] could not start a switched-on server. Cleared by any start that succeeds and
    /// by switching it off.
    error: Option<String>,
}

/// The one listener, managed from `setup` so the panel's first `mcp_status` has something to ask.
///
/// **A plain mutex, never held across an await**: a bind is a synchronous call on a std socket, so
/// every change to the slot is a few instructions under the lock.
#[derive(Default)]
pub struct McpSlot(Mutex<Slot>);

impl McpSlot {
    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The setting as stored, or the default.
pub fn read_settings(conn: &rusqlite::Connection) -> Settings {
    grimoire_core::app_meta::get_app_meta(conn, K_SETTINGS)
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
}

fn write_settings(conn: &rusqlite::Connection, settings: &Settings) -> Result<(), String> {
    let raw = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    grimoire_core::app_meta::set_app_meta(conn, K_SETTINGS, &raw).map_err(|e| e.to_string())
}

/// A fresh token: 32 bytes from the system's randomness, as 64 lowercase hex digits.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no randomness to make a token with: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Whether a stored token is one this module made. A hand-edited row that is not is replaced, so
/// the gate never compares against something short enough to guess.
fn well_formed(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Read the setting, change it with `change`, give it a token if it has none, and write it back —
/// one write, under `with_write` like every other.
fn update_settings(
    state: &AppState,
    change: impl FnOnce(&mut Settings) -> Result<(), String>,
) -> Result<Settings, String> {
    grimoire_core::state::with_write(state, |conn| {
        let mut settings = read_settings(conn);
        let before = settings.clone();
        change(&mut settings)?;
        if !well_formed(&settings.token) {
            settings.token = new_token()?;
        }
        if settings != before {
            write_settings(conn, &settings)?;
        }
        Ok(settings)
    })
}

/// The setting as it stands, given a token if it has none. **A read, unless there is no token** —
/// the panel asks on every open, and a status that waited for the write lock would be answered
/// `db::BUSY` behind an import.
fn current_settings(state: &AppState) -> Result<Settings, String> {
    let settings = read_settings(&state.lock_db_read());
    if well_formed(&settings.token) {
        return Ok(settings);
    }
    update_settings(state, |_| Ok(()))
}

/// Bind the loopback port, or say in words why not.
///
/// **A std bind, then handed to tokio**, so the answer is known before the command returns: a port
/// another program holds is the panel's refusal, never a server the switch says is on and nothing
/// answers.
fn bind(port: u16) -> Result<std::net::TcpListener, String> {
    let listener =
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).map_err(|e| match e
            .kind()
        {
            std::io::ErrorKind::AddrInUse => format!(
                "Port {port} is already in use by another program. Choose another port below."
            ),
            std::io::ErrorKind::PermissionDenied => {
                format!("This computer does not allow the app to listen on port {port}.")
            }
            _ => format!("Could not listen on port {port}: {e}"),
        })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    Ok(listener)
}

/// Start a listener on `listener`'s port. Called inside the async runtime: tokio's
/// `from_std` needs one.
fn start(
    state: &Arc<AppState>,
    listener: std::net::TcpListener,
    port: u16,
    token: String,
) -> Result<Live, String> {
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    let gate = Arc::new(Gate::new(port, token));
    let task = tauri::async_runtime::spawn(http::serve(listener, state.clone(), gate.clone()));
    Ok(Live { gate, task })
}

/// The status as of now.
fn status_of(settings: &Settings, slot: &Slot) -> McpStatus {
    let running = slot.live.as_ref().map(|live| live.gate.port);
    McpStatus {
        enabled: settings.enabled,
        running: running.is_some(),
        port: running.unwrap_or(settings.port),
        url: url_of(running.unwrap_or(settings.port)),
        token: settings.token.clone(),
        error: if settings.enabled && running.is_none() {
            slot.error.clone()
        } else {
            None
        },
    }
}

/// Run `work` on the blocking pool — every command here writes `app_meta` at most once.
async fn on_pool<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("the MCP server's settings could not be reached: {e}"))?
}

/// Start the server at launch if the reader left it on. Spawned by `desktop::start` after
/// `startup::settle`, on the runtime. A port taken since is not fatal: the panel says so
/// ([`McpStatus::error`]) and the reader picks another.
pub async fn resume(state: Arc<AppState>, slot: Arc<McpSlot>) {
    let read = state.clone();
    let settings = match on_pool(move || current_settings(&read)).await {
        Ok(settings) => settings,
        Err(e) => {
            eprintln!("mcp: the setting could not be read: {e}");
            return;
        }
    };
    if !settings.enabled {
        return;
    }
    let mut held = slot.lock();
    match bind(settings.port).and_then(|l| start(&state, l, settings.port, settings.token)) {
        Ok(live) => {
            held.live = Some(live);
            held.error = None;
        }
        Err(e) => held.error = Some(e),
    }
}

/// The managed slot, as an `Arc` so [`resume`] can hold it from a task.
type SlotState<'a> = tauri::State<'a, Arc<McpSlot>>;

/// What the panel draws. Gives the setting a token the first time it is read, so the panel can
/// show a client's configuration before the switch is ever pressed.
#[tauri::command]
pub async fn mcp_status(
    state: tauri::State<'_, Arc<AppState>>,
    slot: SlotState<'_>,
) -> Result<McpStatus, String> {
    let state = state.inner().clone();
    let settings = on_pool(move || current_settings(&state)).await?;
    let held = slot.lock();
    Ok(status_of(&settings, &held))
}

/// Switch the server on: listen, then store the switch. A port that cannot be bound is the
/// refusal, and the switch stays off.
#[tauri::command]
pub async fn mcp_enable(
    state: tauri::State<'_, Arc<AppState>>,
    slot: SlotState<'_>,
) -> Result<McpStatus, String> {
    let state = state.inner().clone();
    let read = state.clone();
    let settings = on_pool(move || current_settings(&read)).await?;
    {
        let mut held = slot.lock();
        if held.live.is_none() {
            let listener = bind(settings.port)?;
            held.live = Some(start(&state, listener, settings.port, settings.token)?);
        }
        held.error = None;
    }
    let settings = match on_pool(move || {
        update_settings(&state, |s| {
            s.enabled = true;
            Ok(())
        })
    })
    .await
    {
        Ok(settings) => settings,
        // A switch that could not be stored is not on: what the next launch reads is off.
        Err(e) => {
            if let Some(live) = slot.lock().live.take() {
                live.stop();
            }
            return Err(e);
        }
    };
    let held = slot.lock();
    Ok(status_of(&settings, &held))
}

/// Switch the server off: stop listening and store the switch.
#[tauri::command]
pub async fn mcp_disable(
    state: tauri::State<'_, Arc<AppState>>,
    slot: SlotState<'_>,
) -> Result<McpStatus, String> {
    {
        let mut held = slot.lock();
        if let Some(live) = held.live.take() {
            live.stop();
        }
        held.error = None;
    }
    let state = state.inner().clone();
    let settings = on_pool(move || {
        update_settings(&state, |s| {
            s.enabled = false;
            Ok(())
        })
    })
    .await?;
    let held = slot.lock();
    Ok(status_of(&settings, &held))
}

/// A new token, in force on the next request. A client configured with the old one is refused from
/// then on.
#[tauri::command]
pub async fn mcp_rotate_token(
    state: tauri::State<'_, Arc<AppState>>,
    slot: SlotState<'_>,
) -> Result<McpStatus, String> {
    let token = new_token()?;
    let stored = token.clone();
    let state = state.inner().clone();
    let settings = on_pool(move || {
        update_settings(&state, |s| {
            s.token = stored;
            Ok(())
        })
    })
    .await?;
    let held = slot.lock();
    if let Some(live) = &held.live {
        live.gate.rotate(token);
    }
    Ok(status_of(&settings, &held))
}

/// Move the server to `port`. While it runs, the new port is bound **before** the old one is let
/// go, so a refusal leaves it answering where it was; switched on and not running (its port was
/// taken at launch), it starts on the new one.
#[tauri::command]
pub async fn mcp_set_port(
    state: tauri::State<'_, Arc<AppState>>,
    slot: SlotState<'_>,
    port: u16,
) -> Result<McpStatus, String> {
    if port < MIN_PORT {
        return Err(format!(
            "Choose a port from {MIN_PORT} to 65535 — the ones below are reserved for the system."
        ));
    }
    let state = state.inner().clone();
    let read = state.clone();
    let current = on_pool(move || current_settings(&read)).await?;
    {
        let mut held = slot.lock();
        // Bound while it runs — and while it is switched on and not running, which is a launch
        // that found its port taken: moving it is the reader's way out, so it starts here.
        let listening = held.live.as_ref().map(|live| live.gate.port);
        let wanted = listening.is_some() || current.enabled;
        if wanted && listening != Some(port) {
            let listener = bind(port)?;
            let next = start(&state, listener, port, current.token.clone())?;
            if let Some(old) = held.live.replace(next) {
                old.stop();
            }
        }
        held.error = None;
    }
    let settings = on_pool(move || {
        update_settings(&state, |s| {
            s.port = port;
            Ok(())
        })
    })
    .await?;
    let held = slot.lock();
    Ok(status_of(&settings, &held))
}

/// The fixture the tool and socket tests share: an `AppState` on a scratch directory, migrated to
/// head — `sync_engine::live`'s, with a silent event sink.
#[cfg(test)]
pub(crate) mod testing {
    use crate::sync::AppState;
    use std::sync::{Arc, Mutex};

    pub(crate) fn state(name: &str) -> Arc<AppState> {
        let dir = crate::scratch::path(&format!("mcp-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        // Both files at head, as the launch leaves them: a tool reads what a press reads, and
        // `deck_get` names corpus columns a bare file does not have yet.
        crate::schema::prepare_database(&conn).unwrap();
        let read = crate::db::open_read(&dir).unwrap();
        let mirror = Arc::new(crate::mirror::watch::Mask::default());
        let changes = Arc::new(crate::changes::Changes::new());
        Arc::new(AppState {
            core: Arc::new(grimoire_core::state::State::new(
                conn,
                Some(read),
                dir.clone(),
                grimoire_core::events::silent(),
                crate::mirror::watch::observers(
                    mirror.clone(),
                    changes.clone(),
                    Arc::new(grimoire_core::platform::sync::Bell::new()),
                ),
                crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                crate::images::Cache::new(dir.join("images")),
            )),
            mirror,
            mirror_status: Mutex::new(crate::mirror::watch::LastPass::default()),
            mirror_pass: Mutex::new(()),
            changes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_foreign_row_reads_as_off_on_the_default_port() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        assert_eq!(read_settings(&conn), Settings::default());
        grimoire_core::app_meta::set_app_meta(&conn, K_SETTINGS, "not json").unwrap();
        assert_eq!(read_settings(&conn), Settings::default());
        grimoire_core::app_meta::set_app_meta(&conn, K_SETTINGS, r#"{"enabled":true}"#).unwrap();
        let read = read_settings(&conn);
        assert!(read.enabled);
        assert_eq!(read.port, DEFAULT_PORT);
    }

    #[test]
    fn a_token_is_64_hex_digits_and_never_the_same_twice() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert!(well_formed(&a) && well_formed(&b));
        assert_ne!(a, b);
        assert!(!well_formed(""));
        assert!(!well_formed("abc"));
    }

    #[test]
    fn the_gate_admits_the_token_and_nothing_else_and_follows_a_rotation() {
        let gate = Gate::new(DEFAULT_PORT, "a".repeat(64));
        assert!(gate.admits(&"a".repeat(64)));
        assert!(!gate.admits(&"a".repeat(63)));
        assert!(!gate.admits(&format!("{}b", "a".repeat(63))));
        assert!(!gate.admits(""));
        gate.rotate("b".repeat(64));
        assert!(!gate.admits(&"a".repeat(64)));
        assert!(gate.admits(&"b".repeat(64)));
    }

    #[test]
    fn an_empty_token_admits_nobody_not_even_an_empty_header() {
        let gate = Gate::new(DEFAULT_PORT, String::new());
        assert!(!gate.admits(""));
    }

    #[test]
    fn the_status_names_the_running_port_and_an_error_only_while_switched_on() {
        let settings = Settings {
            enabled: true,
            port: 40000,
            token: "t".into(),
        };
        let slot = Slot {
            live: None,
            error: Some("Port 40000 is already in use".into()),
        };
        let status = status_of(&settings, &slot);
        assert!(status.enabled && !status.running);
        assert_eq!(status.url, "http://127.0.0.1:40000/mcp");
        assert_eq!(
            status.error.as_deref(),
            Some("Port 40000 is already in use")
        );
        let off = status_of(
            &Settings {
                enabled: false,
                ..settings
            },
            &slot,
        );
        assert_eq!(off.error, None);
    }

    #[test]
    fn a_port_in_use_is_refused_in_words() {
        let held = bind(0).unwrap();
        let port = held.local_addr().unwrap().port();
        let refusal = bind(port).unwrap_err();
        assert!(refusal.contains(&port.to_string()), "{refusal}");
    }
}
