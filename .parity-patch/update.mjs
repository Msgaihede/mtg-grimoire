import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
const GATE = '#[cfg(not(target_family = "wasm"))]';

function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}
/** Put the wasm gate immediately above an item, keeping any attributes it already carries. */
function gate(anchor) {
  must(anchor, GATE + "\n" + anchor);
}

// ── 1. Imports ───────────────────────────────────────────────────────────────────────────
must(
  `use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;`,
  `// **Gated rather than deleted**, because CI runs
// \`cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings\` and an unused import
// is a red build there. Every name below is reachable only from [\`Updater\`], from the check
// that fills it, or from the download-and-swap half of this file — all of which carry the
// same gate. **\`SystemTime\` is the one worth naming twice**: it does not merely go unused on
// wasm, \`SystemTime::now()\` *panics* there, and [\`unix_now\`] is the only thing that calls it.
${GATE}
use std::sync::atomic::{AtomicBool, Ordering};
${GATE}
use std::sync::{Arc, Mutex};
${GATE}
use std::time::{Duration, SystemTime, UNIX_EPOCH};
${GATE}
use tauri::Emitter;`,
);

// ── 2. `InstallKind::Web` ────────────────────────────────────────────────────────────────
must(
  `    /// An MSI install, a Linux build, or anything unrecognised. Gets the release page and
    /// nothing else — see the module docs.
    Other,
}`,
  `    /// A page in a browser, which the **service worker** replaces. Sibling of
    /// [\`InstallKind::Managed\`] and deliberately not the same value: both mean "something
    /// else installs this and this app does not update itself", and a reader is owed the
    /// name of the thing that does. Saying "Google Play" to somebody holding a laptop is the
    /// same wrong answer that variant's own doc refuses to give a phone.
    ///
    /// **It is answered by [\`crate::web::route\`] and by nothing else**, because that is the
    /// only place in the crate that knows it is running in a browser. [\`install_kind_for\`]
    /// never returns it: that function probes a filesystem beside an executable, and on this
    /// target there is neither.
    Web,
    /// An MSI install, a Linux build, or anything unrecognised. Gets the release page and
    /// nothing else — see the module docs.
    Other,
}`,
);

// ── 3. The updater's runtime state, and the guard on it ──────────────────────────────────
gate(`/// What a completed download left behind, and what [\`apply\`] will do with it.
#[derive(Clone, Debug)]
struct Staged {`);
gate(`/// Runtime state for the updater. Managed by Tauri beside \`AppState\`, rather than inside
/// it: nothing here needs the database except the two \`app_meta\` reads, which take a
/// connection as an argument like every other read in this app.
pub struct Updater {`);
gate(`/// Clears \`busy\` however the operation ends.
struct BusyGuard<'a>(&'a AtomicBool);`);
gate(`impl Drop for BusyGuard<'_> {`);
gate(`impl Updater {`);

// ── 4. `unix_now` — trap 1. Only `check_inner` calls it. ─────────────────────────────────
must(
  `/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes every check
/// due — \`sync::unix_now\`'s rule.
fn unix_now() -> u64 {`,
  `/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes every check
/// due — \`sync::unix_now\`'s rule.
///
/// **Gated, and this is the fourth module to need it.** \`SystemTime::now()\` does not fail on
/// \`wasm32-unknown-unknown\`, it **panics** — which arrives in the Worker's \`onerror\` with
/// nothing the page can show. \`sync\`, \`tags\` and \`combos\` were each caught by it before this
/// one; where a wasm caller needs a clock it reads \`SELECT unixepoch()\` off the connection.
/// Nothing here does, because the only caller is [\`check_inner\`], which is desktop's.
${GATE}
fn unix_now() -> u64 {`,
);

// ── 5. `status`, split so a target with no `Updater` can still answer ────────────────────
must(
  `pub fn status(state: &AppState, updater: &Updater) -> UpdateStatus {
    let conn = crate::sync::lock_db_read(state);
    let last_check_at = get_app_meta(&conn, K_LAST_CHECK_AT);
    let cached: Option<ReleaseInfo> = get_app_meta(&conn, K_LATEST_SEEN)
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|r: &ReleaseInfo| is_newer(&r.version, current_version()));
    drop(conn);

    let asset = cached
        .as_ref()
        .and_then(|r| pick_asset(&r.assets, updater.kind))
        .cloned();
    UpdateStatus {
        current_version: current_version().to_owned(),
        install_kind: updater.kind,
        available: cached,
        asset,
        last_check_at,
        busy: updater.busy.load(Ordering::SeqCst),
        staged: crate::sync::lock_plain(&updater.staged).is_some(),
    }
}`,
  `${GATE}
pub fn status(state: &AppState, updater: &Updater) -> UpdateStatus {
    status_for(
        state,
        updater.kind,
        updater.busy.load(Ordering::SeqCst),
        crate::sync::lock_plain(&updater.staged).is_some(),
    )
}

/// The same answer, for a target that has no [\`Updater\`] to read it off.
///
/// **The split is what makes the Updates panel decidable in a browser**, and the bug it
/// repairs is the one PR #315 found on the phone: \`UpdatePanel\` tests \`installKind\`, that
/// answer comes from this DTO, and where the command did not answer at all the panel read the
/// *absence* as "not managed" and drew a Download button over a page that cannot download
/// anything. **A feature gated on a backend answer is ungated wherever the backend cannot
/// answer** — so the fix is for the backend to answer, which is what this function is for.
///
/// The three parameters are the whole of what an \`Updater\` was being consulted about. A web
/// caller passes [\`InstallKind::Web\`], \`false\` and \`false\`: nothing there can be busy with a
/// check it cannot run, and nothing can be staged where there is no file to stage.
///
/// Everything else is read from \`app_meta\`, on every target. **On web both keys are always
/// empty and that is honest rather than broken**: only [\`check\`] writes them, \`app_meta\` is
/// not one of the synced tables, and so a browser answers "not checked yet" — which is
/// exactly what it is.
pub fn status_for(
    state: &AppState,
    kind: InstallKind,
    busy: bool,
    staged: bool,
) -> UpdateStatus {
    let conn = crate::sync::lock_db_read(state);
    let last_check_at = get_app_meta(&conn, K_LAST_CHECK_AT);
    let cached: Option<ReleaseInfo> = get_app_meta(&conn, K_LATEST_SEEN)
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|r: &ReleaseInfo| is_newer(&r.version, current_version()));
    drop(conn);

    let asset = cached.as_ref().and_then(|r| pick_asset(&r.assets, kind)).cloned();
    UpdateStatus {
        current_version: current_version().to_owned(),
        install_kind: kind,
        available: cached,
        asset,
        last_check_at,
        busy,
        staged,
    }
}`,
);

// ── 6. The check, and the error-log note only it uses ────────────────────────────────────
must(
  `/// Ask GitHub for the latest release, honouring the 24 h throttle unless \`force\`.
pub async fn check(`,
  `/// Ask GitHub for the latest release, honouring the 24 h throttle unless \`force\`.
///
/// **Desktop's, and \`update_check\` is therefore absent on web rather than broken.** Not for
/// want of a way to fetch — [\`crate::web::net::get_json\`] would do it — but for want of a way
/// to *call* it: \`web::route::call\` is synchronous, because the Worker's \`#[wasm_bindgen]
/// call\` is, so no \`async\` command can be a \`match\` arm there at all. The two async entry
/// points that do exist (\`glue::ingest_cards\`, \`glue::ingest_combos\`) are bespoke
/// \`#[wasm_bindgen]\` functions with their own \`postMessage\` kinds, which is the same reason
/// all four \`*_refresh\` commands are unrouted. A browser is offered no Check button, so
/// nothing calls this and nothing sees an \`unknown command\`.
${GATE}
pub async fn check(`,
);
gate(`/// Note a failed dealing with GitHub in the error log.`);
gate(`async fn check_inner(`);

// ── 7. Downloading, applying, and the relaunch dance — all desktop ───────────────────────
for (const anchor of [
  `pub async fn download(
    state: &Arc<AppState>,`,
  `async fn download_inner(`,
  `async fn stream_to_file(`,
  `fn extract_portable_exe(archive: &Path, dest: &Path) -> Result<(), String> {`,
  `pub fn apply(updater: &Arc<Updater>, app: &tauri::AppHandle) -> Result<(), String> {`,
  `fn swap_and_relaunch(exe: &Path, staged: &Path) -> Result<(), String> {`,
  `#[cfg(windows)]
fn wait_for_process(pid: u32) {`,
  `#[cfg(not(windows))]
fn wait_for_process(_pid: u32) {}`,
  `pub fn await_predecessor(exe: &Path, pid: Option<u32>) {`,
  `pub fn predecessor_pid<I: IntoIterator<Item = String>>(args: I) -> Option<u32> {`,
  `pub fn clean_up(exe: &Path) {`,
]) {
  gate(anchor);
}

writeFileSync(p, s);
console.log("update.rs patched");
