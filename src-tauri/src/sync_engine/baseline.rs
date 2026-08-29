//! A device's whole state as ops, for a peer that has never heard from it.
//!
//! Spec §5, §7 and §10. **Nothing here is written to `sync_ops`**: a baseline is built in
//! memory, handed to [`super::client`] to seal and push, and forgotten. The outbox's contract is
//! "deltas, never values" and every op built here holds *values*, so filing one there would put
//! two incompatible meanings in one table — and the rows are a table scan away at any moment,
//! which is the other half of why there is nothing worth keeping.
//!
//! # The three things this module has to get right
//!
//! * **A claim is marked as one.** Every op carries `baseline: true`, which is what routes its
//!   counters into [`Resolved::claims`](super::merge::Resolved::claims) rather than summing them
//!   into a delta the far device already holds. Spec §8.
//! * **The stamp is the row's own modification time and never "now".** Spec §10.2: a baseline
//!   stamped now would beat a peer's genuinely newer edit under per-field last-writer-wins, so
//!   whichever device happened to pair second would win every argument it should lose. It also
//!   buys the three-device case its cheap exit — a device already up to date recognises almost
//!   every op of somebody else's re-broadcast as older than its own watermark and does no
//!   database work at all.
//! * **Rows are emitted parents-first**, in the order [`super::apply`] sorts by, which is read
//!   from [`super::apply::order_of`] rather than respelled here. A baseline emitted in an order
//!   that module disagrees with defers every child on the first pull — slow rather than wrong,
//!   and therefore the kind of thing nobody reports.

use super::apply::order_of;
use super::capture::{Spec, TABLES};
use super::hlc::Hlc;
use super::merge::{Horizon, Kind, Op};
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;

/// The relay's tail, in seconds. Mirrors `relay/src/log.ts`'s `TAIL_MS`.
///
/// The two are not held together by anything a build can check — the relay is TypeScript the
/// reader deploys themselves — so the number is written twice on purpose and this comment is
/// the fence. A value *smaller* than the relay's costs a wasted re-send; a value larger is the
/// silent failure §10.1 describes, where a device's inbox is compacted while this one believes
/// it has done its part.
pub const TAIL_SECS: i64 = 30 * 24 * 60 * 60;

/// Peers that need a baseline: on the roster, not revoked, not this device, and with no marker
/// or one older than the relay's tail. Spec §10 and §10.1.
///
/// # The marker is the whole condition, and `sync_peers` is deliberately not consulted
///
/// Spec §10 words the trigger as "a peer with no watermark", and that is wrong in two directions
/// this module has to survive:
///
/// * **§12.4's rotation repair would be a no-op.** Revoking a device clears `baselined_at` for
///   everybody who stays, precisely so the next sync carries their last words across the epoch
///   boundary — and those devices have been syncing for months, so every one of them has a
///   watermark. A watermark test would skip exactly the peers the repair exists for.
/// * **A device revoked and later re-paired would never be baselined**, for the same reason, and
///   would be left unable to read anything sealed under the old key.
///
/// The marker covers both, plus every case the watermark test was meant to: NULL is "never sent
/// one", which is the state of a peer never seen before, of a peer after a rotation, and of a
/// re-paired device. **Re-offering to a peer that did not strictly need one is harmless** —
/// claims resolve by `max`, the grain finds the same row and the horizon filters the batch — so
/// the marker can carry this alone where the watermark cannot.
///
/// # ...and the marker is advisory rather than final
///
/// Spec §10.1: a peer whose own baseline never got out is invisible to the relay's compaction
/// floor, so its inbox can be collected while this device believes it has done its part.
/// Re-offering once the relay's tail has closed costs one wasted re-send a month for a device
/// that never came back, and is the only thing standing between that device and being empty for
/// ever.
pub fn peers_needing(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT device_id
               FROM sync_devices
              WHERE revoked_at IS NULL
                AND device_id <> (SELECT device_id FROM sync_identity WHERE id = 1)
                AND (baselined_at IS NULL OR baselined_at < unixepoch() - ?1)
              ORDER BY added_at, device_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([TAIL_SECS], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|e| e.to_string())
}

/// The column a baseline op for `table` is stamped from. Spec §10.2.
///
/// Read off a **live database** rather than off `schema.rs`, which is a ladder and answers about
/// whichever rung the grep landed on:
/// [`tests::every_synced_table_carries_the_stamp_column_this_module_reads`] is where that
/// reading is done, over `PRAGMA table_info`.
///
/// Nine tables carry `updated_at`; the two that do not carry their own stamp as an ordinary
/// field instead, and have no `created_at`/`updated_at` pair at all. Every synced table has one,
/// so the `_` arm is the majority case and not a fallback — there is nothing to invent.
///
/// ⚠️ **`collection_entries.acquired_at` is not a modification time and must never be used
/// here.** It is the date the reader says they acquired the card — user data, `TEXT`, frequently
/// NULL and sometimes years old. Stamping a row's whole state under it would file that state at
/// a date having nothing to do with when it was written, and every last-writer-wins comparison
/// made against it would be wrong.
fn stamp_column(table: &str) -> &'static str {
    match table {
        "deck_audit" => "at",
        "muted_tags" => "muted_at",
        _ => "updated_at",
    }
}

/// The `SELECT` one table's baseline is read from, shaped exactly like the capture trigger's
/// insert op: the uid, every field, every counter, the stamp, and one correlated subquery per
/// parent.
///
/// **Complete rather than sparse, like an insert and unlike an update.** A baseline says "this
/// row exists, with these values", so a NULL column travels as a JSON null — the initial value
/// and not an absence — and a parent at the root travels as a JSON null too, which
/// [`super::merge`] reads back as `Some(None)`.
///
/// `WHERE sync_uid IS NOT NULL` is a fence and not a filter: the capture trigger mints on insert
/// and [`crate::schema::mint_missing_uids`] covers the other two creation paths, so a nameless
/// row is unreachable at head. An op carrying an empty name would be worse than a missing row —
/// every device would file every anonymous row under one uid.
fn select_for(spec: &Spec) -> String {
    let mut cols: Vec<String> = vec!["t.sync_uid".to_owned()];
    for f in spec.fields {
        cols.push(format!("t.{f}"));
    }
    for c in spec.counters {
        cols.push(format!("t.{c}"));
    }
    cols.push(format!("t.{}", stamp_column(spec.table)));
    for p in spec.parents {
        cols.push(format!(
            "(SELECT p.sync_uid FROM {} p WHERE p.id = t.{})",
            p.table, p.col
        ));
    }
    let order = spec
        .keys
        .iter()
        .map(|k| format!("t.{k}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {} FROM {} t WHERE t.sync_uid IS NOT NULL ORDER BY {order}",
        cols.join(", "),
        spec.table
    )
}

/// One column as JSON, matching what SQLite's own `json_object` would have made of it in the
/// capture trigger — an integer and a real become numbers, text becomes a string, NULL becomes a
/// JSON null.
///
/// A BLOB is the one shape `json_object` refuses outright, and no column on any spec's field
/// list is one; the arm is a fence rather than a case.
fn json_of(v: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null | ValueRef::Blob(_) => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        ValueRef::Text(t) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
    }
}

/// Every synced row as a baseline `put`, parents first. Spec §7 and §10.2.
///
/// `horizon` is left `None` on every op: [`super::client`] stamps it on the first op of each
/// batch it sends, because the horizon is a statement about the *emission* and this function
/// does not know how the ops will be cut up.
pub fn build(conn: &Connection, device: &str) -> Result<Vec<Op>, String> {
    // **The rank comes from `apply` and is never respelled here.** Two lists of the same order
    // are two lists that will disagree, and the failure is a first sync that defers every child
    // — slow, silent, and correct-looking.
    let mut ranked: Vec<(u8, &Spec)> = Vec::with_capacity(TABLES.len());
    for spec in &TABLES {
        let rank = order_of(spec.table)
            .ok_or_else(|| format!("no parents-first rank for {}", spec.table))?;
        ranked.push((rank, spec));
    }
    ranked.sort_by_key(|(rank, _)| *rank);

    let mut ops: Vec<Op> = Vec::new();
    for (_, spec) in ranked {
        let sql = select_for(spec);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let base = spec.fields.len() + spec.counters.len() + 1;
        let rows = stmt
            .query_map([], |r| {
                let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
                for (i, name) in spec.fields.iter().enumerate() {
                    fields.insert((*name).to_owned(), json_of(r.get_ref(i + 1)?));
                }
                let mut counters: BTreeMap<String, i64> = BTreeMap::new();
                for (i, name) in spec.counters.iter().enumerate() {
                    counters.insert((*name).to_owned(), r.get(spec.fields.len() + 1 + i)?);
                }
                let mut parents: BTreeMap<String, Option<String>> = BTreeMap::new();
                for (i, p) in spec.parents.iter().enumerate() {
                    parents.insert(p.key.to_owned(), r.get(base + 1 + i)?);
                }
                let stamp_secs: i64 = r.get(base)?;
                Ok(Op {
                    table: spec.table.to_owned(),
                    uid: r.get(0)?,
                    kind: Kind::Put,
                    fields,
                    // **Values, not deltas**, which is the whole of what `baseline` marks.
                    counters,
                    parents,
                    at: Hlc {
                        ms: stamp_secs * 1000,
                        // Filled in below from the running index.
                        ctr: 0,
                        device: device.to_owned(),
                    },
                    baseline: true,
                    horizon: None,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let mut op = row.map_err(|e| e.to_string())?;
            // **A running index across the whole emission, so two rows that share a second
            // still get distinct stamps.** `merge::fold` treats two ops with one stamp as the
            // same op and skips the second — the dedupe that stops a retried push counting its
            // deltas twice — so a repeated stamp here would silently drop a row from the
            // baseline, which is the one failure this whole feature exists to prevent.
            op.at.ctr = ops.len() as i64;
            ops.push(op);
        }
    }
    Ok(ops)
}

/// What this device had already absorbed when it read its tables: its `sync_peers` watermarks,
/// plus its own highest stamp. Spec §9.
///
/// **Its own stamp is half the answer and not a garnish.** The emitter's own ops are on the log
/// too, and every one of them is already inside the claims — that is §8.1's `+1`, the ordinary
/// case rather than an exotic one.
pub fn horizon(conn: &Connection, device: &str) -> Result<Horizon, String> {
    let mut out = Horizon::default();
    let mut stmt = conn
        .prepare("SELECT device_id, last_ms, last_ctr FROM sync_peers")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(Hlc {
                ms: r.get(1)?,
                ctr: r.get(2)?,
                device: id,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let stamp = row.map_err(|e| e.to_string())?;
        out.seen.insert(stamp.device.clone(), stamp);
    }
    let own: Option<(i64, i64)> = conn
        .query_row(
            "SELECT hlc_ms, hlc_ctr FROM sync_ops WHERE device_id = ?1
              ORDER BY hlc_ms DESC, hlc_ctr DESC LIMIT 1",
            [device],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((ms, ctr)) = own {
        out.seen.insert(
            device.to_owned(),
            Hlc {
                ms,
                ctr,
                device: device.to_owned(),
            },
        );
    }
    Ok(out)
}

/// Stamp the marker, once the whole baseline has been handed over. Spec §10.1.
///
/// **Only after every batch has landed.** Stamping before the push means a failed send is a
/// baseline that is never offered again, which is a device left empty for ever; stamping after
/// means a failed send is simply done again on the next run.
pub fn mark_sent(conn: &Connection, peer: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE sync_devices SET baselined_at = unixepoch() WHERE device_id = ?1",
        [peer],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The `deck_audit` rows among `ops` — what the reader is told separately. Spec §7 and §13.
///
/// History is included in a baseline so a deck's story reads the same wherever it is opened, and
/// it is the one synced table with no ceiling: append-only narrative proportional to how much
/// the reader has done rather than to what they own. Naming it on its own is what stops a large
/// first exchange reading as a bug.
pub fn history_count(ops: &[Op]) -> usize {
    ops.iter().filter(|o| o.table == "deck_audit").count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// A device in a group, with capture installed — [`super::super::apply::tests`]'s `paired`.
    ///
    /// Capture is what mints a `sync_uid` on insert, so a fixture without it builds rows this
    /// module is right to skip and every assertion below would be about an empty list.
    fn paired(device: &str) -> Connection {
        let conn = crate::schema::memory_pair();
        super::super::capture::install(&conn).unwrap();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, ?1, x'00', x'01', ?1, 0)",
            [device],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, x'02', 0)",
            [],
        )
        .unwrap();
        conn
    }

    /// A row on the roster. `added_at` orders `peers_needing`'s answer.
    fn roster(conn: &Connection, device: &str, added_at: i64) {
        conn.execute(
            "INSERT INTO sync_devices (device_id, public_key, name, added_at)
             VALUES (?1, x'00', ?1, ?2)",
            rusqlite::params![device, added_at],
        )
        .unwrap();
    }

    fn add_copy(conn: &Connection, card: &str, quantity: i64) {
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES (?1,'lea','1','en','nonfoil','NM',?2,unixepoch(),unixepoch())",
            rusqlite::params![card, quantity],
        )
        .unwrap();
    }

    fn ops_for(conn: &Connection, table: &str) -> Vec<Op> {
        build(conn, "dev-a")
            .unwrap()
            .into_iter()
            .filter(|o| o.table == table)
            .collect()
    }

    /// A fresh paired database offers its one seeded folder and nothing else, and the op is a
    /// claim rather than a change.
    #[test]
    fn a_fresh_database_baselines_its_seeded_folder() {
        let conn = paired("dev-a");
        let ops = build(&conn, "dev-a").unwrap();
        assert_eq!(ops.len(), 1, "{ops:?}");
        assert_eq!(ops[0].table, "collection_folders");
        assert_eq!(ops[0].kind, Kind::Put);
        assert!(ops[0].baseline, "a baseline op must be marked as a claim");
        assert_eq!(
            ops[0].horizon, None,
            "the horizon is the client's to stamp, per batch"
        );
        assert_eq!(
            ops[0].fields.get("name"),
            Some(&serde_json::Value::String("Recently removed".to_owned()))
        );
        assert_eq!(
            ops[0].parents.get("parent"),
            Some(&None),
            "a root parent is a JSON null and not an absent key"
        );
    }

    /// Parents before children, so a first sync is one pass rather than several.
    #[test]
    fn rows_are_emitted_parents_first() {
        let conn = paired("dev-a");
        conn.execute(
            "INSERT INTO collection_folders (parent_id, name, kind, sort_order,
                                             created_at, updated_at)
             VALUES (NULL, 'Binder', 'user', 1, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let folder: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE name = 'Binder'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',1,?1,unixepoch(),unixepoch())",
            [folder],
        )
        .unwrap();

        let ops = build(&conn, "dev-a").unwrap();
        let ranks: Vec<u8> = ops.iter().map(|o| order_of(&o.table).unwrap()).collect();
        assert!(
            ranks.windows(2).all(|w| w[0] <= w[1]),
            "emission is not parents-first: {ranks:?}"
        );
        let first_folder = ops
            .iter()
            .position(|o| o.table == "collection_folders")
            .expect("no folder op");
        let first_entry = ops
            .iter()
            .position(|o| o.table == "collection_entries")
            .expect("no entry op");
        assert!(
            first_folder < first_entry,
            "the folder must precede the card filed in it"
        );
    }

    /// A parent travels as the parent's `sync_uid`. A local row id means nothing on the far
    /// device, and shipping one would file the card under whatever row happened to hold that id
    /// there.
    #[test]
    fn a_parent_travels_as_its_uid_and_never_as_a_local_id() {
        let conn = paired("dev-a");
        conn.execute(
            "INSERT INTO collection_folders (parent_id, name, kind, sort_order,
                                             created_at, updated_at)
             VALUES (NULL, 'Binder', 'user', 1, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let (folder, uid): (i64, String) = conn
            .query_row(
                "SELECT id, sync_uid FROM collection_folders WHERE name = 'Binder'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',1,?1,unixepoch(),unixepoch())",
            [folder],
        )
        .unwrap();

        let entries = ops_for(&conn, "collection_entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].parents.get("folder"), Some(&Some(uid)));
    }

    /// A baseline's counters hold VALUES. That is the difference the `baseline` flag marks, and
    /// a claim read as a delta is spec §8.1's over-count.
    #[test]
    fn a_baseline_claim_holds_the_value_rather_than_a_delta() {
        let conn = paired("dev-a");
        add_copy(&conn, "c1", 4);
        conn.execute("UPDATE collection_entries SET tradelist_quantity = 2", [])
            .unwrap();
        let entries = ops_for(&conn, "collection_entries");
        assert_eq!(entries.len(), 1);
        assert!(entries[0].baseline);
        assert_eq!(entries[0].counters.get("quantity"), Some(&4));
        assert_eq!(entries[0].counters.get("tradelist_quantity"), Some(&2));
    }

    /// §10.2: the stamp is the row's own modification time, never "now" — and `acquired_at` is
    /// never read, because it is the date the reader says they got the card. User data, `TEXT`,
    /// frequently NULL and sometimes years old.
    #[test]
    fn a_baseline_op_is_stamped_from_the_rows_own_column() {
        const UPDATED: i64 = 1_700_000_000;
        const ACQUIRED: i64 = 1_500_000_000;
        let conn = paired("dev-a");
        add_copy(&conn, "c1", 1);
        conn.execute(
            "UPDATE collection_entries SET updated_at = ?1, acquired_at = ?2",
            rusqlite::params![UPDATED, ACQUIRED.to_string()],
        )
        .unwrap();

        let entries = ops_for(&conn, "collection_entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].at.ms,
            UPDATED * 1000,
            "the stamp must be the row's own updated_at"
        );
        assert_ne!(
            entries[0].at.ms,
            ACQUIRED * 1000,
            "acquired_at is user data and must never be a stamp"
        );
        // ...and it still travels as an ordinary field, which is what makes the assertion above
        // a statement about the STAMP rather than about the column being absent.
        assert_eq!(
            entries[0].fields.get("acquired_at"),
            Some(&serde_json::Value::String(ACQUIRED.to_string()))
        );
        assert_eq!(entries[0].at.device, "dev-a");
    }

    /// The two tables that carry their own stamp as an ordinary field rather than a
    /// `created_at`/`updated_at` pair.
    #[test]
    fn deck_audit_and_muted_tags_are_stamped_from_their_own_columns() {
        const AT: i64 = 1_600_000_000;
        const MUTED: i64 = 1_610_000_000;
        let conn = paired("dev-a");
        conn.execute(
            "INSERT INTO decks (name, created_at, updated_at)
             VALUES ('Krenko', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let deck: i64 = conn
            .query_row("SELECT id FROM decks", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO deck_audit (deck_id, at, variant, kind, card_id, card_name,
                                     payload, delta)
             VALUES (?1, ?2, 'live', 'add', 'c1', 'Bolt', '{}', 1)",
            rusqlite::params![deck, AT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
             VALUES ('oracle', 't1', 'ramp', ?1)",
            [MUTED],
        )
        .unwrap();

        let audit = ops_for(&conn, "deck_audit");
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].at.ms, AT * 1000, "deck_audit stamps from `at`");
        let muted = ops_for(&conn, "muted_tags");
        assert_eq!(muted.len(), 1);
        assert_eq!(
            muted[0].at.ms,
            MUTED * 1000,
            "muted_tags stamps from `muted_at`"
        );
        // `muted_tags` is the one table whose primary key is on the field list, because the far
        // device cannot invent `(namespace, tag_id)` for itself.
        assert_eq!(
            muted[0].fields.get("namespace"),
            Some(&serde_json::Value::String("oracle".to_owned()))
        );
    }

    /// The stamp map, read off a LIVE database rather than off `schema.rs`, which is a ladder
    /// and can show a shape a later rung already rebuilt.
    ///
    /// The second half is the argument for the two special cases: neither of those tables has
    /// an `updated_at` at all, so folding them into the majority arm is not a subtler stamp, it
    /// is a `SELECT` that names a column that does not exist.
    #[test]
    fn every_synced_table_carries_the_stamp_column_this_module_reads() {
        let conn = crate::schema::memory_pair();
        let has = |table: &str, column: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
                rusqlite::params![table, column],
                |r| r.get(0),
            )
            .unwrap()
        };
        for spec in &TABLES {
            let column = stamp_column(spec.table);
            assert_eq!(
                has(spec.table, column),
                1,
                "{} has no `{column}` column",
                spec.table
            );
        }
        for table in ["deck_audit", "muted_tags"] {
            assert_eq!(
                has(table, "updated_at"),
                0,
                "{table} does have an updated_at, so the special case needs re-arguing"
            );
        }
        assert_eq!(
            has("collection_entries", "acquired_at"),
            1,
            "the column the stamp must never be read from has moved"
        );
    }

    /// Every op in one emission has a distinct stamp, so `merge::fold`'s same-stamp dedupe
    /// cannot silently drop a row that happens to share a second with another.
    #[test]
    fn no_two_ops_in_one_baseline_share_a_stamp() {
        let conn = paired("dev-a");
        for i in 0..5 {
            add_copy(&conn, &format!("c{i}"), 1);
        }
        conn.execute("UPDATE collection_entries SET updated_at = 1700000000", [])
            .unwrap();

        let ops = build(&conn, "dev-a").unwrap();
        assert!(ops.len() >= 6, "expected the five rows and the seed folder");
        let stamps: BTreeSet<&Hlc> = ops.iter().map(|o| &o.at).collect();
        assert_eq!(
            stamps.len(),
            ops.len(),
            "two ops share a stamp and fold would drop one"
        );
        // ...and the five that share a second really do, so the assertion above is about the
        // counter rather than about five distinct `updated_at` values.
        let same_second = ops
            .iter()
            .filter(|o| o.at.ms == 1_700_000_000 * 1000)
            .count();
        assert_eq!(same_second, 5, "the fixture no longer shares a second");
    }

    /// A revoked device is off the group and is never spoken to again.
    #[test]
    fn a_revoked_peer_is_never_baselined() {
        let conn = paired("dev-a");
        roster(&conn, "dev-b", 1);
        roster(&conn, "dev-c", 2);
        conn.execute(
            "UPDATE sync_devices SET revoked_at = unixepoch() WHERE device_id = 'dev-b'",
            [],
        )
        .unwrap();
        assert_eq!(peers_needing(&conn).unwrap(), vec!["dev-c".to_owned()]);
    }

    /// **A peer that has already spoken is still baselined while its marker is clear**, and this
    /// is the case §12.4's rotation repair depends on: revoking a device clears `baselined_at`
    /// for everybody who stays, and every one of those has been syncing for months and has a
    /// `sync_peers` row. A watermark test would skip exactly the peers the repair exists for.
    #[test]
    fn a_peer_that_has_spoken_is_still_baselined_when_its_marker_is_clear() {
        let conn = paired("dev-a");
        roster(&conn, "dev-b", 1);
        conn.execute(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES ('dev-b', 900, 4)",
            [],
        )
        .unwrap();
        assert_eq!(
            peers_needing(&conn).unwrap(),
            vec!["dev-b".to_owned()],
            "a cleared marker must re-arm the baseline whatever the watermark says"
        );
    }

    /// This device is on its own roster and must not baseline itself.
    #[test]
    fn this_device_never_baselines_itself() {
        let conn = paired("dev-a");
        roster(&conn, "dev-a", 1);
        roster(&conn, "dev-b", 2);
        assert_eq!(peers_needing(&conn).unwrap(), vec!["dev-b".to_owned()]);
    }

    /// §10.1: the marker silences a peer, and stops silencing it once the relay's tail has
    /// passed — because by then the relay may have compacted an inbox this device believes it
    /// filled.
    #[test]
    fn a_marked_peer_is_left_alone_until_the_tail_has_passed() {
        let conn = paired("dev-a");
        roster(&conn, "dev-b", 1);
        assert_eq!(peers_needing(&conn).unwrap(), vec!["dev-b".to_owned()]);

        mark_sent(&conn, "dev-b").unwrap();
        assert!(
            peers_needing(&conn).unwrap().is_empty(),
            "a freshly marked peer must be left alone"
        );

        conn.execute(
            "UPDATE sync_devices SET baselined_at = unixepoch() - ?1 WHERE device_id = 'dev-b'",
            [TAIL_SECS + 1],
        )
        .unwrap();
        assert_eq!(
            peers_needing(&conn).unwrap(),
            vec!["dev-b".to_owned()],
            "a marker older than the relay's tail must re-arm"
        );
    }

    /// §9: the horizon is this device's own `sync_peers` plus its own top stamp. Both halves,
    /// because the emitter's own ops are inside its claims too — that is §8.1's `+1`.
    #[test]
    fn the_horizon_names_this_device_and_every_peer_it_has_heard() {
        let conn = paired("dev-a");
        conn.execute(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES ('dev-c', 500, 3)",
            [],
        )
        .unwrap();
        add_copy(&conn, "c1", 1);

        let h = horizon(&conn, "dev-a").unwrap();
        assert_eq!(
            h.seen.get("dev-c"),
            Some(&Hlc {
                ms: 500,
                ctr: 3,
                device: "dev-c".to_owned()
            })
        );
        let (ms, ctr): (i64, i64) = conn
            .query_row(
                "SELECT hlc_ms, hlc_ctr FROM sync_ops WHERE device_id = 'dev-a'
                  ORDER BY hlc_ms DESC, hlc_ctr DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            h.seen.get("dev-a"),
            Some(&Hlc {
                ms,
                ctr,
                device: "dev-a".to_owned()
            }),
            "the emitter's own top stamp is half the horizon"
        );
    }

    /// §7/§13: history is counted separately, because it is the part that can surprise.
    #[test]
    fn history_is_counted_on_its_own() {
        let conn = paired("dev-a");
        conn.execute(
            "INSERT INTO decks (name, created_at, updated_at)
             VALUES ('Krenko', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let deck: i64 = conn
            .query_row("SELECT id FROM decks", [], |r| r.get(0))
            .unwrap();
        for i in 0..3 {
            conn.execute(
                "INSERT INTO deck_audit (deck_id, at, variant, kind, card_id, card_name,
                                         payload, delta)
                 VALUES (?1, ?2, 'live', 'add', 'c1', 'Bolt', '{}', 1)",
                rusqlite::params![deck, 1_600_000_000 + i],
            )
            .unwrap();
        }
        add_copy(&conn, "c1", 1);

        let ops = build(&conn, "dev-a").unwrap();
        assert_eq!(history_count(&ops), 3);
        assert!(
            ops.len() > 3,
            "the emission must hold more than its history: {}",
            ops.len()
        );
        assert_eq!(history_count(&[]), 0);
    }
}
