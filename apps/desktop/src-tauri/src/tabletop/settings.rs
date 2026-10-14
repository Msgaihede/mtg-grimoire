//! Whether the integration runs and which `Saves` folder it writes into — two `app_meta` rows and
//! the Settings panel's four commands.
//!
//! The mirror's two rules bind here verbatim: **reading never fails** (a missing, hand-edited or
//! newer row reads as the default, because a tick has nothing better to do with an error), and
//! **writing validates**.

use crate::mirror::run::PassReport;
use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `app_meta`: whether the integration runs, `1` or `0`.
pub const K_ENABLED: &str = "tabletop_enabled";

/// `app_meta`: the Tabletop Simulator `Saves` folder the reader chose, as an absolute path. Absent
/// is the folder TTS makes by default. **A path on this computer**, so a full-data archive leaves
/// it out as it leaves the mirror's (`grimoire_core::archive`).
pub const K_SAVES: &str = "tabletop_saves";

/// `app_meta`: whether the saves name local copies of the pictures, `1` or `0` — see
/// [`crate::tabletop::images`]. Off, the saves name Scryfall's links (the owner's call, 2026-10-14).
pub const K_LOCAL_IMAGES: &str = "tabletop_local_images";

/// Off until the reader switches it on: it writes into another program's folder.
pub const DEFAULT_ENABLED: bool = false;

/// The folder the integration owns, inside the saves folder.
pub const FOLDER_NAME: &str = "MTG Grimoire";

/// What a pass says when there is no saves folder to write into at all — no Documents folder the
/// OS would name, and none chosen.
pub const NO_SAVES_FOLDER: &str =
    "Tabletop Simulator's saves folder could not be found. Choose where your saves are.";

const ON: &str = "1";
const OFF: &str = "0";

/// Does the integration run?
pub fn enabled(conn: &Connection) -> bool {
    match crate::app_meta::get_app_meta(conn, K_ENABLED).as_deref() {
        Some(ON) => true,
        Some(OFF) => false,
        _ => DEFAULT_ENABLED,
    }
}

/// Do the saves name local copies of the pictures? Off unless the row says `1`.
pub fn local_images(conn: &Connection) -> bool {
    crate::app_meta::get_app_meta(conn, K_LOCAL_IMAGES).as_deref() == Some(ON)
}

pub fn set_local_images(conn: &Connection, on: bool) -> Result<(), String> {
    crate::app_meta::set_app_meta(conn, K_LOCAL_IMAGES, if on { ON } else { OFF })
        .map_err(|e| format!("could not save the Tabletop Simulator image setting: {e}"))
}

pub fn set_enabled(conn: &Connection, on: bool) -> Result<(), String> {
    crate::app_meta::set_app_meta(conn, K_ENABLED, if on { ON } else { OFF })
        .map_err(|e| format!("could not save the Tabletop Simulator setting: {e}"))
}

/// Where Tabletop Simulator keeps saves when nobody has moved them —
/// `Documents/My Games/Tabletop Simulator/Saves`, on Windows and macOS alike.
pub fn default_saves(documents: &Path) -> PathBuf {
    documents
        .join("My Games")
        .join("Tabletop Simulator")
        .join("Saves")
}

/// The saves folder: the reader's choice if it is absolute, else the default under Documents.
pub fn saves(conn: &Connection, documents: Option<&Path>) -> Option<PathBuf> {
    crate::app_meta::get_app_meta(conn, K_SAVES)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| documents.map(default_saves))
}

/// The `MTG Grimoire` folder a pass writes into.
pub fn folder(conn: &Connection, documents: Option<&Path>) -> Option<PathBuf> {
    saves(conn, documents).map(|s| s.join(FOLDER_NAME))
}

/// Choose the saves folder. Absolute, existing, and text this app can store — the picker answers
/// the first two, and the checks stay because [`saves`] discards a bad row silently.
pub fn set_saves(conn: &Connection, path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("\"{}\" is not a folder.", path.display()));
    }
    let text = path.to_str().ok_or_else(|| {
        format!(
            "\"{}\" cannot be saved: the folder has to be text this app can store.",
            path.display()
        )
    })?;
    // A reader who picks the `MTG Grimoire` folder itself means the saves folder above it.
    let text = match path.file_name().and_then(|n| n.to_str()) {
        Some(FOLDER_NAME) => path.parent().and_then(Path::to_str).unwrap_or(text),
        _ => text,
    };
    crate::app_meta::set_app_meta(conn, K_SAVES, text)
        .map_err(|e| format!("could not save the Tabletop Simulator folder: {e}"))
}

/// Everything the Integrations panel draws about Tabletop Simulator, in one round trip.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabletopStatus {
    pub enabled: bool,
    /// Whether the saves name local copies of the pictures rather than Scryfall's links.
    pub local_images: bool,
    /// The Tabletop Simulator `Saves` folder, or `None` when there is none to name.
    pub saves_folder: Option<String>,
    /// Whether that folder exists — `false` is TTS not installed, or saves kept elsewhere.
    pub saves_found: bool,
    /// The `MTG Grimoire` folder inside it.
    pub folder: Option<String>,
    pub last_run_at: Option<String>,
    pub last_report: Option<PassReport>,
    pub last_error: Option<String>,
}

pub fn status(
    conn: &Connection,
    documents: Option<&Path>,
    last: crate::mirror::watch::LastPass,
) -> TabletopStatus {
    let saves = saves(conn, documents);
    TabletopStatus {
        enabled: enabled(conn),
        local_images: local_images(conn),
        saves_found: saves.as_deref().is_some_and(Path::is_dir),
        folder: saves
            .as_ref()
            .map(|s| s.join(FOLDER_NAME).display().to_string()),
        saves_folder: saves.map(|s| s.display().to_string()),
        last_run_at: last.last_run_at,
        last_report: last.last_report,
        last_error: last.last_error,
    }
}

/// What the Integrations panel polls. Infallible, `mirror_status`'s contract.
#[tauri::command(async)]
pub fn tabletop_status(state: tauri::State<'_, Arc<AppState>>) -> TabletopStatus {
    let state = state.inner();
    let last = crate::sync::lock_plain(&state.tabletop.last).clone();
    status(
        &crate::sync::lock_db_read(state),
        state.tabletop.documents.as_deref(),
        last,
    )
}

/// Switch the integration on or off. On takes effect within a tick: the thread sees the switch
/// and runs a full pass. Off leaves every save already written where it is.
#[tauri::command]
pub async fn tabletop_set_enabled(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| set_enabled(conn, enabled))
    })
    .await
    .map_err(|e| format!("the Tabletop Simulator setting could not be saved: {e}"))?
}

/// Switch the saves between Scryfall's links and local copies of the pictures. Marked, because
/// `app_meta` marks nothing on its own and every save changes.
#[tauri::command]
pub async fn tabletop_set_local_images(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let saved = crate::sync::with_write(&state, |conn| set_local_images(conn, enabled));
        if saved.is_ok() {
            state.tabletop.mark();
        }
        saved
    })
    .await
    .map_err(|e| format!("the Tabletop Simulator image setting could not be saved: {e}"))?
}

/// One pass over the folder the settings name, with the pictures fetched by the app's own client
/// when local images are on — the thread's pass and [`rebuild_now`]'s, so the two cannot differ.
pub fn pass_now(state: &AppState, conn: &Connection) -> Result<PassReport, String> {
    let Some(root) = folder(conn, state.tabletop.documents.as_deref()) else {
        return Err(NO_SAVES_FOLDER.to_owned());
    };
    if local_images(conn) {
        let fetch = crate::tabletop::images::ClientFetch(&state.client);
        super::run::run_pass(conn, &root, Some(&fetch))
    } else {
        super::run::run_pass(conn, &root, None)
    }
}

/// Let the reader choose Tabletop Simulator's saves folder — the OS picker, opened at the current
/// one — for a reader whose saves are not where TTS puts them by default. Answers whether it moved;
/// `false` is Cancel. **It takes no path**, the mirror's rule (issue #545): nothing in the page can
/// aim a background writer at a folder.
#[tauri::command]
pub async fn tabletop_pick_folder(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let state = state.inner().clone();
    let reading = state.clone();
    let dialog = move || {
        let current = saves(
            &crate::sync::lock_db_read(&reading),
            reading.tabletop.documents.as_deref(),
        );
        let picker = crate::file_dialog::modal_to(&window)
            .set_title("Choose your Tabletop Simulator saves folder");
        match current
            .as_deref()
            .and_then(crate::mirror::settings::starting_folder)
        {
            Some(folder) => picker.set_directory(folder),
            None => picker,
        }
        .blocking_pick_folder()
    };
    let Some(chosen) = crate::file_dialog::show(crate::file_dialog::FOLDER_PICKER, dialog).await?
    else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || set_saves_now(&state, &chosen))
        .await
        .map_err(|e| format!("the Tabletop Simulator folder could not be saved: {e}"))??;
    Ok(true)
}

/// [`tabletop_pick_folder`] after the picker. `app_meta` marks nothing on its own, so a moved
/// folder is marked here or it would sit empty until the next deck edit.
pub fn set_saves_now(state: &AppState, path: &Path) -> Result<(), String> {
    let saved = crate::sync::with_write(state, |conn| set_saves(conn, path));
    if saved.is_ok() {
        state.tabletop.mark();
    }
    saved
}

/// Write every deck's saves now, and answer what the pass did.
#[tauri::command]
pub async fn tabletop_rebuild(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PassReport, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || rebuild_now(&state))
        .await
        .map_err(|e| format!("the Tabletop Simulator saves could not be rebuilt: {e}"))?
}

/// [`tabletop_rebuild`]'s body: a read-only connection of its own, falling back to the shared one,
/// and the pass recorded for the panel — `mirror::settings::rebuild_now`'s shape.
pub fn rebuild_now(state: &AppState) -> Result<PassReport, String> {
    let own = crate::db::open_read(&state.data_dir).ok();
    let outcome = {
        let shared = own.is_none().then(|| crate::sync::lock_db_read(state));
        let conn = own
            .as_ref()
            .or(shared.as_deref())
            .expect("one or the other");
        pass_now(state, conn)
    };
    super::watch::record(state, &outcome);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_is_off_and_under_documents_until_somebody_says_otherwise() {
        let conn = crate::schema::memory_pair();
        assert!(!enabled(&conn));
        assert_eq!(
            folder(&conn, Some(Path::new("C:/Users/me/Documents"))),
            Some(PathBuf::from(
                "C:/Users/me/Documents/My Games/Tabletop Simulator/Saves/MTG Grimoire"
            ))
        );
        assert_eq!(folder(&conn, None), None);
    }

    #[test]
    fn switching_it_on_and_off_round_trips_and_junk_reads_as_off() {
        let conn = crate::schema::memory_pair();
        set_enabled(&conn, true).unwrap();
        assert!(enabled(&conn));
        set_enabled(&conn, false).unwrap();
        assert!(!enabled(&conn));
        crate::app_meta::set_app_meta(&conn, K_ENABLED, "perhaps").unwrap();
        assert!(!enabled(&conn));
    }

    #[test]
    fn a_chosen_saves_folder_wins_and_a_relative_row_is_ignored() {
        let conn = crate::schema::memory_pair();
        let tmp = tempfile::tempdir().unwrap();
        set_saves(&conn, tmp.path()).unwrap();
        assert_eq!(saves(&conn, None).as_deref(), Some(tmp.path()));

        crate::app_meta::set_app_meta(&conn, K_SAVES, "Saves").unwrap();
        assert_eq!(saves(&conn, None), None);
    }

    /// Picking our own folder means the saves folder it sits in — not `MTG Grimoire/MTG Grimoire`.
    #[test]
    fn choosing_the_mtg_grimoire_folder_itself_means_its_parent() {
        let conn = crate::schema::memory_pair();
        let tmp = tempfile::tempdir().unwrap();
        let ours = tmp.path().join(FOLDER_NAME);
        std::fs::create_dir(&ours).unwrap();
        set_saves(&conn, &ours).unwrap();
        assert_eq!(saves(&conn, None).as_deref(), Some(tmp.path()));
    }

    #[test]
    fn a_folder_that_is_not_there_is_refused() {
        let conn = crate::schema::memory_pair();
        let tmp = tempfile::tempdir().unwrap();
        assert!(set_saves(&conn, &tmp.path().join("nope")).is_err());
        assert!(set_saves(&conn, Path::new("Saves")).is_err());
    }

    #[test]
    fn the_status_says_whether_the_saves_folder_is_there() {
        let conn = crate::schema::memory_pair();
        let tmp = tempfile::tempdir().unwrap();
        let s = status(&conn, Some(tmp.path()), Default::default());
        assert!(!s.saves_found, "no My Games folder in a fresh temp dir");
        std::fs::create_dir_all(default_saves(tmp.path())).unwrap();
        let s = status(&conn, Some(tmp.path()), Default::default());
        assert!(s.saves_found);
        assert!(s.folder.unwrap().ends_with(FOLDER_NAME));
        assert!(!s.enabled);
        assert!(
            !s.local_images,
            "Scryfall's links until the reader asks for copies"
        );
    }

    #[test]
    fn local_images_round_trip() {
        let conn = crate::schema::memory_pair();
        assert!(!local_images(&conn));
        set_local_images(&conn, true).unwrap();
        assert!(local_images(&conn));
        set_local_images(&conn, false).unwrap();
        assert!(!local_images(&conn));
    }
}
