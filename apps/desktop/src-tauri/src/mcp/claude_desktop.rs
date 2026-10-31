//! **Claude Desktop's one-click install**: an MCP Bundle (`.mcpb`, the format Claude Desktop calls
//! an extension) built from the server's address and token, handed to Claude Desktop by opening it,
//! or saved where the reader chooses.
//!
//! **Why a bundle rather than the config snippet.** Claude Desktop's config file starts local
//! processes; it does not connect to a URL, so the snippet runs `mcp-remote` through `npx` — which
//! needs Node.js installed, a JSON file edited by hand, and a restart. A bundle is a zip with a
//! `manifest.json` and a server, and Claude Desktop answers opening one with its own install
//! dialog. Its server here is [`SERVER_JS`]: a bridge from stdio to this app's HTTP endpoint with
//! no dependencies, run on the Node.js Claude Desktop ships with, so the reader installs nothing.
//!
//! **The address and the token are written into the manifest** (`mcp_config.env`), not asked for
//! in the install dialog (`user_config`): asking would make the reader paste the token, which is
//! the step this replaces. The token is then in Claude Desktop's extension folder in plain text —
//! as it is in the snippet's config file. *New token* and a moved port break it, as they break
//! every client; the reader installs it again, and the panel says so.
//!
//! **No path crosses IPC** (issue #545): the install command writes the bundle into the data
//! folder and opens it itself, and Save asks for a path in its own dialog.

use super::{current_settings, on_pool, url_of, McpSlot, Settings};
use crate::file_dialog;
use crate::sync::AppState;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

/// The bridge Claude Desktop runs: stdio in, `POST /mcp` out. Tested end to end against the real
/// listener below, when a `node` is on the `PATH`.
pub const SERVER_JS: &str = include_str!("claude_desktop/server.js");

/// The extension's picture in Claude Desktop — the app's own icon.
const ICON: &[u8] = include_bytes!("../../icons/128x128.png");

/// The bundle's file name, in the data folder and as Save's suggestion.
pub const FILE_NAME: &str = "mtg-grimoire.mcpb";

/// The bundle's `manifest.json` (MCPB manifest 0.3) for the server at `url` with `token`.
///
/// `name` is the snippets' `mtg-grimoire`, so the tools read the same in every client. `version`
/// is the app's: an install from a newer app is an update of the extension rather than a second
/// one.
pub fn manifest(url: &str, token: &str) -> Value {
    json!({
        "manifest_version": "0.3",
        "name": "mtg-grimoire",
        "display_name": "MTG Grimoire",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Your Magic: The Gathering collection, wishlist and decks in MTG Grimoire, \
    read while the app is open on this computer, and custom home widgets built for you. Nothing \
    leaves the computer.",
        "author": { "name": "MTG Grimoire" },
        "icon": "icon.png",
        "server": {
            "type": "node",
            "entry_point": "server/index.js",
            "mcp_config": {
                "command": "node",
                "args": ["${__dirname}/server/index.js"],
                "env": { "MTG_GRIMOIRE_URL": url, "MTG_GRIMOIRE_TOKEN": token },
            },
        },
        // `fetch` without a flag.
        "compatibility": { "runtimes": { "node": ">=18.0.0" } },
    })
}

/// The bundle's bytes: the manifest, the bridge and the icon, deflated.
pub fn bundle(url: &str, token: &str) -> Result<Vec<u8>, String> {
    let manifest = serde_json::to_vec_pretty(&manifest(url, token))
        .map_err(|e| format!("the extension's manifest could not be written: {e}"))?;
    let failed = |e: &dyn std::fmt::Display| format!("the extension could not be built: {e}");
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in [
        ("manifest.json", manifest.as_slice()),
        ("server/index.js", SERVER_JS.as_bytes()),
        ("icon.png", ICON),
    ] {
        zip.start_file(name, options).map_err(|e| failed(&e))?;
        zip.write_all(bytes).map_err(|e| failed(&e))?;
    }
    Ok(zip.finish().map_err(|e| failed(&e))?.into_inner())
}

/// The address a bundle names: where the server listens now, else where it will.
fn address(settings: &Settings, slot: &McpSlot) -> String {
    let running = slot.lock().live.as_ref().map(|live| live.gate.port);
    url_of(running.unwrap_or(settings.port))
}

/// The bundle for the server as it is now. **Refused while the switch is off**: an extension
/// installed then would fail on Claude Desktop's first request, and the panel offers it only
/// while the switch is on.
async fn current_bundle(state: &Arc<AppState>, slot: &McpSlot) -> Result<Vec<u8>, String> {
    let read = state.clone();
    let settings = on_pool(move || current_settings(&read)).await?;
    if !settings.enabled {
        return Err("Switch the server on first.".into());
    }
    bundle(&address(&settings, slot), &settings.token)
}

/// **Install in Claude Desktop**: write the bundle into the data folder and open it, which Claude
/// Desktop answers with its install dialog. Opened by this process — the page is granted no opener
/// for files, and no path reaches it.
#[tauri::command]
pub async fn mcp_claude_desktop_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, Arc<McpSlot>>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let state = state.inner().clone();
    let bytes = current_bundle(&state, &slot).await?;
    let path = on_pool(move || write_bundle(state.data_dir.join("mcp"), &bytes)).await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            format!(
                "The extension could not be opened — is Claude Desktop installed? Save it \
                 instead and open it from Claude Desktop's Settings → Extensions. ({e})"
            )
        })
}

/// **Save the extension…**: the same bundle, where the reader chooses — for a Claude Desktop
/// that did not take the file when it was opened, or another computer's. `false` for Cancel.
#[tauri::command]
pub async fn mcp_claude_desktop_save(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, Arc<McpSlot>>,
) -> Result<bool, String> {
    let state = state.inner().clone();
    let bytes = current_bundle(&state, &slot).await?;
    let dialog = move || {
        file_dialog::modal_to(&window)
            .set_file_name(FILE_NAME)
            .add_filter("Claude Desktop extension", &["mcpb"])
            .blocking_save_file()
    };
    let Some(path) = file_dialog::show(file_dialog::SAVE_DIALOG, dialog).await? else {
        return Ok(false);
    };
    on_pool(move || {
        std::fs::write(&path, &bytes)
            .map_err(|e| format!("could not write {}: {e}", path.display()))
    })
    .await?;
    Ok(true)
}

/// Write `bytes` as [`FILE_NAME`] in `dir`, made if missing, replacing an earlier build — whose
/// token may be one *New token* has since replaced.
fn write_bundle(dir: PathBuf, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let path = dir.join(FILE_NAME);
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::process::{Command, Stdio};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn unzip(bytes: &[u8]) -> zip::ZipArchive<std::io::Cursor<&[u8]>> {
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap()
    }

    fn entry(bytes: &[u8], name: &str) -> Vec<u8> {
        let mut archive = unzip(bytes);
        let mut file = archive.by_name(name).unwrap();
        let mut out = Vec::new();
        file.read_to_end(&mut out).unwrap();
        out
    }

    /// The three files at the archive's root, where Claude Desktop looks, and nothing else.
    #[test]
    fn the_bundle_holds_the_manifest_the_bridge_and_the_icon() {
        let bytes = bundle(&url_of(39147), TOKEN).unwrap();
        let mut names: Vec<String> = unzip(&bytes).file_names().map(String::from).collect();
        names.sort();
        assert_eq!(names, ["icon.png", "manifest.json", "server/index.js"]);
        assert_eq!(entry(&bytes, "server/index.js"), SERVER_JS.as_bytes());
        assert_eq!(entry(&bytes, "icon.png"), ICON);
    }

    /// **The address and the token are the manifest's own**, so the install asks nothing; the
    /// entry point is the file the bundle holds, run through `${__dirname}`, which Claude Desktop
    /// replaces with where it unpacked the bundle.
    #[test]
    fn the_manifest_carries_the_address_and_the_token() {
        let bytes = bundle(&url_of(40000), TOKEN).unwrap();
        let manifest: Value = serde_json::from_slice(&entry(&bytes, "manifest.json")).unwrap();
        assert_eq!(manifest["manifest_version"], "0.3");
        assert_eq!(manifest["name"], "mtg-grimoire");
        assert_eq!(manifest["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(manifest["server"]["type"], "node");
        assert_eq!(manifest["server"]["entry_point"], "server/index.js");
        let config = &manifest["server"]["mcp_config"];
        assert_eq!(config["command"], "node");
        assert_eq!(config["args"], json!(["${__dirname}/server/index.js"]));
        assert_eq!(
            config["env"]["MTG_GRIMOIRE_URL"],
            "http://127.0.0.1:40000/mcp"
        );
        assert_eq!(config["env"]["MTG_GRIMOIRE_TOKEN"], TOKEN);
        assert!(
            manifest.get("user_config").is_none(),
            "nothing to ask the reader"
        );
    }

    #[test]
    fn a_second_build_replaces_the_first() {
        let dir = crate::scratch::path("mcpb-write");
        let _ = std::fs::remove_dir_all(&dir);
        write_bundle(dir.clone(), b"first").unwrap();
        let path = write_bundle(dir.clone(), b"second").unwrap();
        assert_eq!(path, dir.join(FILE_NAME));
        assert_eq!(std::fs::read(path).unwrap(), b"second");
    }

    /// A `node` to run the bridge on, or `None` where there is none — the bridge is Claude
    /// Desktop's to run, and a machine without Node.js cannot say anything about it.
    fn node() -> Option<&'static str> {
        Command::new("node")
            .arg("--version")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|_| "node")
    }

    /// The bridge driven as Claude Desktop drives it — lines on stdin, lines on stdout — against
    /// the real listener: the handshake, its notification (answered by nothing), the tool list;
    /// then the same bridge holding a stale token, and one pointed at a port nobody listens on,
    /// each answered with a JSON-RPC error in words rather than silence.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_bridge_carries_a_session_to_the_real_listener() {
        let Some(node) = node() else {
            eprintln!("skipped: no node on the PATH");
            return;
        };
        let script = crate::scratch::path("mcpb-bridge.js");
        std::fs::write(&script, SERVER_JS).unwrap();

        let state = crate::mcp::testing::state("mcpb-bridge");
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let gate = Arc::new(crate::mcp::Gate::new(port, TOKEN.to_string()));
        let server = tokio::spawn(crate::mcp::http::serve(listener, state, gate));

        let run = move |url: String, token: &'static str, lines: Vec<Value>| {
            let script = script.clone();
            tokio::task::spawn_blocking(move || {
                let mut child = Command::new(node)
                    .arg(&script)
                    .env("MTG_GRIMOIRE_URL", url)
                    .env("MTG_GRIMOIRE_TOKEN", token)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                {
                    let mut stdin = child.stdin.take().unwrap();
                    for line in lines {
                        writeln!(stdin, "{line}").unwrap();
                    }
                }
                let answers: Vec<Value> = BufReader::new(child.stdout.take().unwrap())
                    .lines()
                    .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
                    .collect();
                assert!(child.wait().unwrap().success());
                answers
            })
        };
        let hello = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "claude-ai", "version": "0" } } });
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });

        let answers = run(
            url_of(port),
            TOKEN,
            vec![hello.clone(), initialized.clone(), list.clone()],
        )
        .await
        .unwrap();
        assert_eq!(answers.len(), 2, "the notification is answered by nothing");
        assert_eq!(answers[0]["id"], 1);
        assert_eq!(answers[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(answers[0]["result"]["serverInfo"]["name"], "mtg-grimoire");
        assert_eq!(answers[1]["id"], 2);
        assert!(answers[1]["result"]["tools"].as_array().unwrap().len() > 1);

        let stale = "f".repeat(64).leak();
        let answers = run(url_of(port), stale, vec![hello.clone()]).await.unwrap();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0]["id"], 1);
        assert!(answers[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Install the Claude Desktop extension again"));

        server.abort();
        let nobody = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let closed = nobody.local_addr().unwrap().port();
        drop(nobody);
        let answers = run(url_of(closed), TOKEN, vec![hello]).await.unwrap();
        assert_eq!(answers[0]["id"], 1);
        assert!(answers[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("isn't answering"));
    }
}
