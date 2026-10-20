//! Portable, complete user-data archives. Paths belong to Rust's native pickers, never IPC.
use crate::{file_dialog, sync::AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const FORMAT: &str = "mtg-grimoire-full-archive";
const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    schema_version: Value,
    app_version: String,
    tables: BTreeMap<String, Table>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Table {
    columns: Vec<String>,
    row_count: usize,
}

fn write_archive(file: &mut File, data: &Value) -> Result<(), String> {
    let tables = data["tables"]
        .as_object()
        .ok_or("archive tables are missing")?;
    let mut manifest = Manifest {
        format: FORMAT.into(),
        version: 1,
        schema_version: data["schemaVersion"].clone(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        tables: BTreeMap::new(),
    };
    for (name, table) in tables {
        manifest.tables.insert(
            name.clone(),
            Table {
                columns: serde_json::from_value(table["columns"].clone())
                    .map_err(|e| e.to_string())?,
                row_count: table["rows"]
                    .as_array()
                    .ok_or("archive rows are missing")?
                    .len(),
            },
        );
    }
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("archive manifest is too large".into());
    }
    let mut written = 0;
    write_bounded(&mut zip, &manifest_bytes, &mut written, MAX_BYTES)?;
    for (name, table) in tables {
        zip.start_file(format!("{name}.jsonl"), options)
            .map_err(|e| e.to_string())?;
        for row in table["rows"].as_array().ok_or("archive rows are missing")? {
            // One row at a time keeps budgeting independent of the collection's total size.
            let bytes = serde_json::to_vec(row).map_err(|e| e.to_string())?;
            write_bounded(&mut zip, &bytes, &mut written, MAX_BYTES)?;
            write_bounded(&mut zip, b"\n", &mut written, MAX_BYTES)?;
        }
    }
    let file = zip.finish().map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("archive is too large".into());
    }
    file.sync_all().map_err(|e| e.to_string())
}

fn write_bounded(
    output: &mut impl Write,
    bytes: &[u8],
    written: &mut u64,
    limit: u64,
) -> Result<(), String> {
    let next = written
        .checked_add(bytes.len() as u64)
        .ok_or("expanded archive is too large")?;
    if next > limit {
        return Err("expanded archive is too large".into());
    }
    output.write_all(bytes).map_err(|e| e.to_string())?;
    *written = next;
    Ok(())
}

fn read_entry(zip: &mut zip::ZipArchive<File>, name: &str, limit: u64) -> Result<String, String> {
    let entry = zip.by_name(name).map_err(|e| e.to_string())?;
    if entry.size() > limit {
        return Err(format!("archive entry {name} is too large"));
    }
    let mut text = String::new();
    entry
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > limit {
        return Err(format!("archive entry {name} is too large"));
    }
    Ok(text)
}

fn read_archive(path: &Path) -> Result<Value, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("archive is too large".into());
    }
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if zip.len() > 128 {
        return Err("archive contains too many entries".into());
    }
    let manifest: Manifest =
        serde_json::from_str(&read_entry(&mut zip, "manifest.json", MAX_MANIFEST_BYTES)?)
            .map_err(|e| e.to_string())?;
    if manifest.format != FORMAT || manifest.version != 1 {
        return Err("unsupported archive format".into());
    }
    let mut expected = BTreeSet::from(["manifest.json".to_owned()]);
    for name in manifest.tables.keys() {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return Err("invalid archive table name".into());
        }
        expected.insert(format!("{name}.jsonl"));
    }
    let mut actual = BTreeSet::new();
    let mut size = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if !actual.insert(entry.name().to_owned()) {
            return Err("duplicate archive entry".into());
        }
        size = size
            .checked_add(entry.size())
            .ok_or("archive is too large")?;
        if size > MAX_BYTES {
            return Err("expanded archive is too large".into());
        }
    }
    if actual != expected {
        return Err("archive entries do not match its manifest".into());
    }
    let mut tables = serde_json::Map::new();
    for (name, table) in manifest.tables {
        let text = read_entry(&mut zip, &format!("{name}.jsonl"), MAX_BYTES)?;
        let rows: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        if rows.len() != table.row_count {
            return Err(format!("archive row count differs for {name}"));
        }
        tables.insert(name, json!({"columns":table.columns,"rows":rows}));
    }
    Ok(json!({"schemaVersion":manifest.schema_version,"tables":tables}))
}

fn save_archive(path: &Path, data: &Value) -> Result<(), String> {
    // The chosen target may already contain the only good backup. Persist replaces it only
    // after the new ZIP's central directory and bytes have been flushed successfully.
    let mut output =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("archive folder is missing")?)
            .map_err(|e| e.to_string())?;
    write_archive(output.as_file_mut(), data)?;
    output.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// How many automatic ZIPs [`automatic_backup`] keeps per reason. The same bound as the core's
/// `user.v{N}.db` copies: a full archive per update or restore forever would grow without limit
/// on a USB stick (issue #1148).
const AUTOMATIC_BACKUPS_KEPT: usize = 3;

/// A durable backup must finish before an updater launches or a restore changes any rows.
pub fn automatic_backup(
    conn: &rusqlite::Connection,
    dir: &Path,
    reason: &str,
) -> Result<(), String> {
    let dir = dir.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = dir.join(format!("mtg-grimoire-{reason}-{stamp}.zip"));
    let result = (|| {
        let data = grimoire_core::archive::dump(conn)?;
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        write_archive(&mut file, &data)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(path);
    } else {
        prune_automatic_backups(&dir, reason);
    }
    result
}

/// Keep the newest [`AUTOMATIC_BACKUPS_KEPT`] `mtg-grimoire-{reason}-{ns}.zip` archives by
/// stamp, and leave every other file in the folder alone — another reason's archives, the
/// core's `user.v{N}.db` copies and the reader's own files. Pruning is best-effort: the new
/// backup is already durable, so a file that cannot be removed is no reason to stop an update.
fn prune_automatic_backups(dir: &Path, reason: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("mtg-grimoire-{reason}-");
    let mut archives: Vec<(u128, std::path::PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let stamp = name
                .to_str()?
                .strip_prefix(&prefix)?
                .strip_suffix(".zip")?
                .parse()
                .ok()?;
            Some((stamp, entry.path()))
        })
        .collect();
    archives.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (_, path) in archives.into_iter().skip(AUTOMATIC_BACKUPS_KEPT) {
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
pub async fn archive_export(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let Some(path) = file_dialog::show(file_dialog::SAVE_DIALOG, move || {
        file_dialog::modal_to(&window)
            .add_filter("Full archive", &["zip"])
            .set_file_name("mtg-grimoire-full-archive.zip")
            .blocking_save_file()
    })
    .await?
    else {
        return Ok(false);
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db(&state);
        let data = grimoire_core::archive::dump(&conn)?;
        save_archive(&path, &data)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(true)
}

#[tauri::command]
pub async fn archive_import(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let picker = window.clone();
    let Some(path) = file_dialog::show(file_dialog::FILE_PICKER, move || {
        file_dialog::modal_to(&picker)
            .add_filter("Full archive", &["zip"])
            .blocking_pick_file()
    })
    .await?
    else {
        return Ok(false);
    };
    let state = state.inner().clone();
    let validate_state = state.clone();
    let data = tauri::async_runtime::spawn_blocking(move || {
        let data = read_archive(&path)?;
        grimoire_core::archive::validate(&crate::sync::lock_db_read(&validate_state), &data)?;
        Ok::<_, String>(data)
    })
    .await
    .map_err(|e| e.to_string())??;
    let confirm_window = window.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || confirm_window.dialog().message("Restore this full archive? This replaces all local user data. A backup of the current data will be saved in data/backups first. Device sync will be disconnected; reconnect it after reviewing the restored data.").title("Replace local data?").parent(&confirm_window).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom("Restore archive".into(), "Cancel".into())).blocking_show()).await.map_err(|e| file_dialog::did_not_open("restore confirmation", e))?;
    if !confirmed {
        return Ok(false);
    }
    crate::sync::on_a_worker(move || async move {
        // Pairing operations take this lock before the sync lane. Cancel the pending offer
        // only after a successful restore, so an old handshake cannot reconnect this data.
        let mut pending = state.pairing.lock().await;
        let _lane = state.lane_for_press().await?;
        // `with_write_owned` and not bare `with_write` (issue #1146): a restore replaces
        // `collection_entries` whole, and the facet index's `owned` bitset is built from it — a
        // skipped rebuild left the Owned and Missing facets answering for the old collection
        // until the next collection write or a restart. `collection_clear`'s reasoning.
        crate::collection_source::with_write_owned(&state, |conn| {
            automatic_backup(conn, &state.data_dir, "before-restore")?;
            grimoire_core::archive::restore(conn, &data)
        })?;
        crate::sync_pair::pairing::cancel(&mut pending);
        state.mirror.mark_all();
        for (name, side) in crate::schema::TABLES {
            if *side == crate::schema::Side::User {
                state.changes.mark_table(name);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    window
        .app_handle()
        .emit("archive:restored", ())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_budget_counts_every_entry_and_refuses_overflow_before_writing() {
        let mut output = Vec::new();
        let mut written = 0;
        write_bounded(&mut output, b"manifest", &mut written, 12).unwrap();
        write_bounded(&mut output, b"row\n", &mut written, 12).unwrap();
        assert_eq!(written, 12);
        assert!(write_bounded(&mut output, b"x", &mut written, 12).is_err());
        assert_eq!(output, b"manifestrow\n");
        assert_eq!(written, 12);
        written = u64::MAX;
        assert!(write_bounded(&mut output, b"x", &mut written, u64::MAX).is_err());
    }

    fn fixture() -> Value {
        json!({"schemaVersion": 55, "tables": {
            "app_meta": {"columns": ["key", "value"], "rows": [["language", "日本語\nDansk"], ["binary", {"$blob": "AAEC/w=="}]]},
            "empty": {"columns": ["id"], "rows": []}
        }})
    }

    fn make_archive(name: &str) -> std::path::PathBuf {
        let path = crate::scratch::path(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_archive(&mut File::create(&path).unwrap(), &fixture()).unwrap();
        path
    }

    #[test]
    fn jsonl_preserves_unicode_embedded_newlines_blobs_and_empty_tables() {
        let path = make_archive("archive-roundtrip.zip");
        assert_eq!(read_archive(&path).unwrap(), fixture());
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let lines = read_entry(&mut zip, "app_meta.jsonl", MAX_BYTES).unwrap();
        assert_eq!(lines.lines().count(), 2);
        drop(zip);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unexpected_entries_are_refused_without_extracting_files() {
        let path = make_archive("archive-extra.zip");
        let file = File::options().read(true).write(true).open(&path).unwrap();
        let mut zip = zip::ZipWriter::new_append(file).unwrap();
        zip.start_file("../outside.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"unexpected").unwrap();
        zip.finish().unwrap();
        assert!(read_archive(&path)
            .unwrap_err()
            .contains("entries do not match"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn wrong_row_counts_are_refused() {
        let path = crate::scratch::path("archive-wrong-count.zip");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        serde_json::to_writer(&mut zip, &json!({"format":FORMAT,"version":1,"schemaVersion":55,"appVersion":"test","tables":{"app_meta":{"columns":["key","value"],"rowCount":2}}})).unwrap();
        zip.start_file("app_meta.jsonl", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"[\"key\",\"value\"]\n").unwrap();
        zip.finish().unwrap();
        assert!(read_archive(&path)
            .unwrap_err()
            .contains("row count differs"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn entry_bounds_apply_to_expanded_data() {
        let path = make_archive("archive-bounded.zip");
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        assert!(read_entry(&mut zip, "app_meta.jsonl", 5)
            .unwrap_err()
            .contains("too large"));
        drop(zip);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn saving_replaces_an_existing_archive_only_when_complete() {
        let path = make_archive("archive-replace.zip");
        let old = std::fs::read(&path).unwrap();
        assert!(save_archive(
            &path,
            &json!({"tables":{"bad":{"columns":false,"rows":[]}}})
        )
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), old);
        save_archive(&path, &fixture()).unwrap();
        assert_eq!(read_archive(&path).unwrap(), fixture());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn automatic_backup_is_a_readable_complete_snapshot() {
        let conn = crate::schema::memory_pair();
        let dir = crate::scratch::path("archive-auto");
        automatic_backup(&conn, &dir, "before-update").unwrap();
        let files: Vec<_> = std::fs::read_dir(dir.join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(
            read_archive(&files[0]).unwrap(),
            grimoire_core::archive::dump(&conn).unwrap()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn automatic_backups_keep_the_newest_per_reason_and_nothing_else() {
        let conn = crate::schema::memory_pair();
        let dir = crate::scratch::path("archive-auto-prune");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).unwrap();
        // Older than anything a real clock stamps now, so the new archive is the newest.
        let others = [
            "mtg-grimoire-before-update-1.zip",
            "mtg-grimoire-before-update-2.zip",
            "mtg-grimoire-before-update-3.zip",
            "mtg-grimoire-before-restore-1.zip",
            "mtg-grimoire-before-update-x.zip",
            "mtg-grimoire-before-update-4.zip.bak",
            "user.v46.db",
            "my-own-backup.zip",
        ];
        for name in others {
            std::fs::write(backups.join(name), b"").unwrap();
        }
        automatic_backup(&conn, &dir, "before-update").unwrap();
        let mut names: Vec<String> = std::fs::read_dir(&backups)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        let newest = names
            .iter()
            .find(|name| !others.contains(&name.as_str()))
            .unwrap()
            .clone();
        let mut expected: Vec<String> = others
            .iter()
            .filter(|name| **name != "mtg-grimoire-before-update-1.zip")
            .map(|name| name.to_string())
            .chain([newest.clone()])
            .collect();
        expected.sort();
        assert_eq!(names, expected);
        assert_eq!(
            read_archive(&backups.join(newest)).unwrap(),
            grimoire_core::archive::dump(&conn).unwrap()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backup_directory_failures_are_reported_before_data_changes() {
        let conn = crate::schema::memory_pair();
        let dir = crate::scratch::path("archive-backup-failure");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("backups"), b"not a directory").unwrap();
        let before = grimoire_core::archive::dump(&conn).unwrap();
        assert!(automatic_backup(&conn, &dir, "before-update").is_err());
        assert_eq!(before, grimoire_core::archive::dump(&conn).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
