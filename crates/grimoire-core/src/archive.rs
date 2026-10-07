//! Portable snapshots of the reader's database. Corpus rows are downloaded facts; pairing
//! credentials and replication cursors belong to a device and must not travel in an archive.

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema_version: i64,
    tables: BTreeMap<String, Table>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

fn tables() -> impl Iterator<Item = &'static str> {
    crate::schema::TABLES.iter().filter_map(|&(table, side)| {
        (side == crate::schema::Side::User && !table.starts_with("sync_")).then_some(table)
    })
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut query = conn
        .prepare("SELECT name FROM pragma_table_info(?1, 'main') ORDER BY cid")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([table], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn encode(cell: SqlValue) -> Result<Value, String> {
    match cell {
        SqlValue::Null => Ok(Value::Null),
        SqlValue::Integer(value) => Ok(json!(value)),
        SqlValue::Real(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| "An archive cannot represent a non-finite SQLite number.".into()),
        SqlValue::Text(value) => Ok(Value::String(value)),
        SqlValue::Blob(value) => Ok(json!({"$blob": STANDARD.encode(value)})),
    }
}

fn decode(cell: &Value) -> Result<SqlValue, String> {
    match cell {
        Value::Null => Ok(SqlValue::Null),
        Value::String(value) => Ok(SqlValue::Text(value.clone())),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(SqlValue::Integer(value))
            } else if value.is_f64() {
                value
                    .as_f64()
                    .map(SqlValue::Real)
                    .ok_or_else(|| "Invalid archive number.".into())
            } else {
                Err("An archive integer is outside SQLite's signed 64-bit range.".into())
            }
        }
        Value::Object(value) if value.len() == 1 => value
            .get("$blob")
            .and_then(Value::as_str)
            .ok_or_else(|| "Invalid archive binary value.".to_owned())
            .and_then(|value| {
                STANDARD
                    .decode(value)
                    .map_err(|_| "Invalid archive binary encoding.".to_owned())
            })
            .map(SqlValue::Blob),
        _ => Err("Invalid archive cell: expected text, number, null, or a binary value.".into()),
    }
}

/// Read one consistent snapshot. Every value is SQLite data, never executable SQL, and IDs,
/// timestamps, undo history, dashboard layout and preferences are kept verbatim.
pub fn dump(conn: &Connection) -> Result<Value, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let version: i64 = tx
        .query_row("PRAGMA main.user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version != crate::schema::USER_SCHEMA_VERSION {
        return Err("The database must be upgraded before creating an archive.".into());
    }
    let mut exported = Map::new();
    for table in tables() {
        let names = columns(&tx, table)?;
        let filter = if table == "app_meta" {
            " WHERE key NOT IN ('mirror_root','mirror_installation')"
        } else {
            ""
        };
        let mut query = tx
            .prepare(&format!("SELECT * FROM main.\"{table}\"{filter}"))
            .map_err(|e| e.to_string())?;
        let mut rows = query.query([]).map_err(|e| e.to_string())?;
        let mut exported_rows = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let cells = (0..names.len())
                .map(|column| encode(row.get::<_, SqlValue>(column).map_err(|e| e.to_string())?))
                .collect::<Result<Vec<_>, String>>()?;
            exported_rows.push(cells);
        }
        exported.insert(
            table.into(),
            json!({"columns": names, "rows": exported_rows}),
        );
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"schemaVersion": version, "tables": exported}))
}

fn parse(conn: &Connection, dump: &Value) -> Result<Snapshot, String> {
    let snapshot: Snapshot =
        serde_json::from_value(dump.clone()).map_err(|e| format!("Invalid archive data: {e}"))?;
    let version: i64 = conn
        .query_row("PRAGMA main.user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if snapshot.schema_version != crate::schema::USER_SCHEMA_VERSION
        || snapshot.schema_version != version
    {
        return Err("This archive uses a different database schema. Restore it with the matching version of MTG Grimoire.".into());
    }
    if snapshot.tables.len() != tables().count()
        || tables().any(|table| !snapshot.tables.contains_key(table))
    {
        return Err(
            "The archive's user-table list is incomplete or contains an unknown table.".into(),
        );
    }
    for table in tables() {
        let data = &snapshot.tables[table];
        if data.columns != columns(conn, table)? {
            return Err(format!("The archive's columns do not match {table}."));
        }
        for row in &data.rows {
            if row.len() != data.columns.len() {
                return Err(format!(
                    "An archive row has the wrong number of columns in {table}."
                ));
            }
            for cell in row {
                decode(cell)?;
            }
            if table == "app_meta"
                && matches!(row[0].as_str(), Some("mirror_root" | "mirror_installation"))
            {
                return Err(
                    "An archive must not carry another installation's mirror path or identity."
                        .into(),
                );
            }
        }
    }
    Ok(snapshot)
}

/// Validate constraints and relationships before a host asks the reader to confirm replacing
/// their data. The trial database is disposable, so a bad archive never touches the live one.
pub fn validate(conn: &Connection, dump: &Value) -> Result<(), String> {
    let snapshot = parse(conn, dump)?;
    let trial = Connection::open_in_memory().map_err(|e| e.to_string())?;
    trial
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    crate::schema::migrate_user(&trial).map_err(|e| e.to_string())?;
    replace(&trial, &snapshot)
}

/// Replace user data atomically and detach this device from its sync group. The host must hold
/// the sync lane as well as the write connection so no in-flight relay reply can rejoin it.
pub fn restore(conn: &Connection, dump: &Value) -> Result<(), String> {
    validate(conn, dump)?;
    replace(conn, &parse(conn, dump)?)
}

fn replace(conn: &Connection, snapshot: &Snapshot) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "PRAGMA defer_foreign_keys = ON;
         DELETE FROM main.sync_group;
         DELETE FROM main.sync_devices;
         DELETE FROM main.sync_ops;
         DELETE FROM main.sync_peers;
         DELETE FROM main.sync_gone;
         DELETE FROM main.sync_orphans;
         DELETE FROM main.sync_state;
         INSERT INTO main.sync_state (key,value) VALUES ('applying','1');",
    )
    .map_err(|e| e.to_string())?;
    // `sync_orphans` goes once, here, where `sync_gone` goes again at the foot: both describe
    // the discarded database — which rows an apply placed while their parent was gone, by uids
    // the restored rows may carry too — but only the tombstones have a trigger to refill them
    // while the user tables below are emptied. Nothing writes an orphan record but `apply`.
    // Deleting the group first makes capture's cross join empty before the first user delete.
    // Identity and clock stay local: neither is imported nor reused from another machine.
    for table in tables() {
        // A restored mirror cannot inherit another writer's pruning authority or path.
        let filter = if table == "app_meta" {
            " WHERE key NOT IN ('mirror_root','mirror_installation')"
        } else {
            ""
        };
        tx.execute(&format!("DELETE FROM main.\"{table}\"{filter}"), [])
            .map_err(|e| e.to_string())?;
    }
    for table in tables() {
        let data = &snapshot.tables[table];
        let placeholders = vec!["?"; data.columns.len()].join(",");
        let mut insert = tx
            .prepare(&format!(
                "INSERT INTO main.\"{table}\" VALUES ({placeholders})"
            ))
            .map_err(|e| e.to_string())?;
        for row in &data.rows {
            let values = row.iter().map(decode).collect::<Result<Vec<_>, _>>()?;
            insert
                .execute(params_from_iter(values))
                .map_err(|e| format!("Invalid archive row in {table}: {e}"))?;
        }
    }
    // Explicitly check even when a host connection has foreign_keys disabled. Deferred keys
    // alone would otherwise let an orphan commit on such a connection.
    let invalid = tx
        .prepare("PRAGMA main.foreign_key_check")
        .map_err(|e| e.to_string())?
        .exists([])
        .map_err(|e| e.to_string())?;
    if invalid {
        return Err("The archive contains a broken relationship between user rows.".into());
    }
    // The usual write wrapper reconciles dirty decks against this machine's corpus. A restore
    // promises the archived rows verbatim, including token choices and managed wishlists, so
    // discard the restore's marks inside the transaction. On failure the old marks roll back.
    for table in ["managed_wishlist_dirty", "managed_wishlist_token_dirty"] {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            tx.execute(&format!("DELETE FROM temp.\"{table}\""), [])
                .map_err(|e| e.to_string())?;
        }
    }
    // Parent-deletion tombstones fire even with capture suppressed and no group. They describe
    // the discarded database, not the restored one, and must not poison its next pairing.
    tx.execute_batch(
        "DELETE FROM main.sync_gone; DELETE FROM main.sync_state WHERE key='applying';",
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::sync_pair::identity::ensure(&conn).unwrap();
        crate::sync_engine::capture::install(&conn).unwrap();
        crate::managed_wishlist::arm(&conn).unwrap();
        conn
    }

    #[test]
    fn restores_preferences_notes_ids_and_binary_without_corpus_or_pairing() {
        let source = database();
        source
            .execute_batch(
                "INSERT INTO app_meta (key,value) VALUES ('home_widgets','[\"stickyNotes\"]');
             INSERT INTO sticky_notes (id,title,body,color,pinned,sort_order,created_at,updated_at)
             VALUES (42,'Archive','Unicode: æ 🧙','slate',1,0,123,456);
             INSERT INTO sync_group (id,group_id,group_key,joined_at) VALUES (1,'old',x'0102',0);",
            )
            .unwrap();
        // SQLite permits blobs in a TEXT column; the archive must preserve storage classes.
        source
            .execute(
                "INSERT INTO app_meta (key,value) VALUES ('binary',?1)",
                [vec![0_u8, 255, 17]],
            )
            .unwrap();
        let snapshot = dump(&source).unwrap();
        assert!(!snapshot["tables"]
            .as_object()
            .unwrap()
            .contains_key("cards"));
        assert!(!snapshot["tables"]
            .as_object()
            .unwrap()
            .contains_key("sync_group"));
        let target = database();
        target.execute_batch("INSERT INTO sync_group (id,group_id,group_key,joined_at) VALUES (1,'target',x'03',0);").unwrap();
        restore(&target, &snapshot).unwrap();
        assert_eq!(dump(&target).unwrap(), snapshot);
        assert_eq!(
            target
                .query_row("SELECT count(*) FROM sync_group", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            target
                .query_row("SELECT value FROM app_meta WHERE key='binary'", [], |row| {
                    row.get::<_, Vec<u8>>(0)
                })
                .unwrap(),
            vec![0, 255, 17]
        );
    }

    #[test]
    fn invalid_schema_columns_and_constraints_leave_live_data_unchanged() {
        let conn = database();
        conn.execute(
            "INSERT INTO app_meta (key,value) VALUES ('keep','mine')",
            [],
        )
        .unwrap();
        let snapshot = dump(&conn).unwrap();
        let mut invalid = snapshot.clone();
        invalid["schemaVersion"] = json!(0);
        assert!(restore(&conn, &invalid).is_err());
        invalid = snapshot.clone();
        invalid["tables"]["app_meta"]["columns"][0] = json!("unexpected");
        assert!(restore(&conn, &invalid).is_err());
        invalid = snapshot.clone();
        invalid["tables"]["app_meta"]["rows"] = json!([["duplicate", "one"], ["duplicate", "two"]]);
        assert!(restore(&conn, &invalid).is_err());
        assert_eq!(dump(&conn).unwrap(), snapshot);
    }

    #[test]
    fn restores_parent_relationships_without_reconciling_archived_notes_or_wishes() {
        let source = database();
        source
            .execute_batch(
                "INSERT INTO decks (id,name,created_at,updated_at,sync_uid)
             VALUES (99,'My deck',0,0,'deck-original');
             INSERT INTO deck_notes (id,deck_id,title,body,sort_order,created_at,updated_at)
             VALUES (77,99,'Plan','Keep this prose',0,0,0);
             INSERT INTO deck_note_cards (id,note_id,oracle_id,created_at,updated_at)
             VALUES (55,77,'missing-oracle',0,0);
             INSERT INTO sync_state (key,value) VALUES ('applying','1');
             INSERT INTO wishlist_folders (id,name,sort_order,created_at,updated_at,managed_deck_id)
             VALUES (44,'Deck wishes',0,0,0,99);
             DELETE FROM sync_state WHERE key='applying';
             INSERT INTO price_snapshots (day,marketplace,card_id,finish,price,copies)
             VALUES ('2026-10-05','tcgplayer','missing-card','nonfoil',1.0,2);",
            )
            .unwrap();
        let snapshot = dump(&source).unwrap();
        let target = database();
        target
            .execute_batch(
                "INSERT INTO app_meta (key,value) VALUES ('mirror_root','C:/My archive');
             INSERT INTO app_meta (key,value) VALUES ('mirror_installation','local-owner');
             INSERT INTO sync_orphans (tbl,uid,parent_tbl,parent_uid,twin,alias,state)
             VALUES ('collection_entries','copy','collection_folders','binder','copy','old','{}');",
            )
            .unwrap();
        // Exercise managed-folder deletion protection and parent tombstone triggers on the
        // second replacement, with the same production triggers still armed.
        restore(&target, &snapshot).unwrap();
        restore(&target, &snapshot).unwrap();
        crate::deck_tokens::reconcile_dirty(&target).unwrap();
        crate::managed_wishlist::settle_logged(&target);
        assert_eq!(dump(&target).unwrap(), snapshot);
        assert_eq!(
            target
                .query_row("SELECT count(*) FROM sync_gone", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        // What the discarded database's applies did with rows whose parents were gone says
        // nothing about the restored one, and no trigger refills it: seeded above, gone here.
        assert_eq!(
            target
                .query_row("SELECT count(*) FROM sync_orphans", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            target
                .query_row(
                    "SELECT value FROM app_meta WHERE key='mirror_installation'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "local-owner"
        );
        let mut orphan = snapshot.clone();
        let note_column = orphan["tables"]["deck_note_cards"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .position(|column| column == "note_id")
            .unwrap();
        orphan["tables"]["deck_note_cards"]["rows"][0][note_column] = json!(123456);
        assert!(validate(&target, &orphan).is_err());
        assert_eq!(dump(&target).unwrap(), snapshot);
    }

    #[test]
    fn failed_live_insert_rolls_back_user_rows_and_group_detachment() {
        let source = database();
        source
            .execute(
                "INSERT INTO app_meta (key,value) VALUES ('new','archive')",
                [],
            )
            .unwrap();
        let snapshot = dump(&source).unwrap();
        let target = database();
        target
            .execute_batch(
                "INSERT INTO app_meta (key,value) VALUES ('keep','mine');
             INSERT INTO sync_group (id,group_id,group_key,joined_at) VALUES (1,'paired',x'01',0);
             CREATE TEMP TRIGGER refuse_archive BEFORE INSERT ON main.app_meta
             WHEN NEW.key = 'new' BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
            )
            .unwrap();
        let before = dump(&target).unwrap();
        assert!(restore(&target, &snapshot).is_err());
        assert_eq!(dump(&target).unwrap(), before);
        assert_eq!(
            target
                .query_row("SELECT group_id FROM sync_group", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "paired"
        );
        assert!(target.is_autocommit());
    }
}
