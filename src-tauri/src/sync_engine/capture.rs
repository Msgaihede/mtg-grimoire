//! Turning a local write into a row in `sync_ops`, inside the caller's own transaction.
//!
//! **Triggers, and the choice is load-bearing.** Three candidates were weighed:
//!
//! * `update_hook` — what [`crate::mirror::watch`] uses — fires per row inside SQLite's own
//!   callback, gives the table and the rowid but **no values**, and must not call back into the
//!   database. It cannot build an op.
//! * `preupdate_hook` does give old and new values, but it fires *before commit*, so an
//!   in-memory buffer is the only record of an op between the commit and the drain. **A crash
//!   there loses an op silently, and a lost op is a device that has diverged for good.**
//! * A trigger runs inside the caller's transaction, rolls back with it, cannot be forgotten by
//!   a write site added next year, and is identical on native and on wasm. It is the rule
//!   [`crate::deck_audit`] already follows one table over: *written inside the caller's
//!   transaction, where one is open.*
//!
//! # Three things about SQLite that this module's shape is entirely determined by
//!
//! All three were measured against SQLite 3.53.0 on 2026-08-28 rather than read.
//!
//! 1. **`PRAGMA recursive_triggers` is OFF by default and that does *not* mean a trigger's
//!    statements fire no triggers.** It stops a trigger firing *itself*; a trigger's `UPDATE`
//!    fires the `AFTER UPDATE` trigger on the same table perfectly happily. The uid mint below
//!    is an `UPDATE`, so a naive update trigger would record a second op for every insert — and
//!    an op with no fields in it, which no rule in [`super::merge`] has an answer for.
//! 2. **The update trigger carries two guards and either one alone would do**, which was
//!    established by mutation rather than assumed. `AFTER UPDATE OF <columns>` is syntactic:
//!    the trigger fires only when the statement *names* one of those columns, and the mint
//!    names `sync_uid`, which is on no spec. The `WHEN` clause is semantic: the mint moves no
//!    captured column, so its condition is false. **Removing either leaves every test in this
//!    module green; removing both makes one insert write two ops.** Both stay - the `OF`
//!    clause is the cheaper of the two, since SQLite skips the trigger without evaluating
//!    anything, and the `WHEN` is the only one of them that can also see
//!    `UPDATE decks SET notes = notes`, which names a captured column and moves nothing.
//! 3. **`last_insert_rowid()` and `changes()` are unaffected by a trigger's own writes.** The
//!    op row this module inserts does not become the answer a caller's `INSERT INTO decks` gets
//!    back, which would have broken most of the crate silently.

use rusqlite::Connection;

/// What one synced table needs captured.
pub struct Spec {
    pub table: &'static str,
    /// The columns that identify a row locally. `id` for everything except `muted_tags`, which
    /// is `WITHOUT ROWID` on `(namespace, tag_id)` and has no `id` at all.
    pub keys: &'static [&'static str],
    /// Scalar fields — last-writer-wins **per field** (spec §7.3).
    ///
    /// **`created_at` and `updated_at` are deliberately on no list.** They are facts about when
    /// *this* device wrote a row; the group's ordering is the hybrid logical clock, and syncing
    /// a timestamp would put two answers to "when" in the database with nothing to say which
    /// one a reader is being shown.
    pub fields: &'static [&'static str],
    /// Counter fields — ops carry `NEW - OLD`, never the value.
    pub counters: &'static [&'static str],
    /// The foreign rows this one names. The parent's `sync_uid` is what travels, because a
    /// local id means nothing on the far device.
    pub parents: &'static [Parent],
    /// `true` for `deck_audit` alone: spec §7.3 makes it union/append-only, and it is also the
    /// one synced table a CASCADE empties — deleting a deck takes its audit rows with it, and a
    /// DELETE trigger would emit thousands of delete-ops for rows the far device's own CASCADE
    /// is about to remove anyway. An **update** trigger is left off for the first reason: a row
    /// that records what happened is not edited, and a rule that says "union" has no answer for
    /// one that was.
    pub append_only: bool,
}

/// One foreign row a synced row names.
pub struct Parent {
    /// The key it travels under, inside the op's `parents` object.
    pub key: &'static str,
    /// The local column holding the foreign row's id.
    pub col: &'static str,
    /// The table that id is in. Its `sync_uid` is what the op carries.
    pub table: &'static str,
    /// What the column holds when the op says "nobody".
    pub absent: Absent,
    /// **A soft parent is fixed up after the batch rather than deferring the row**, and there
    /// is exactly one: `decks.default_category_id`. `decks` and `deck_categories` name each
    /// other — a category belongs to a deck, and a deck names a default category — so no
    /// order of tables can resolve both in one pass. Deferring the deck would deadlock the
    /// pair; writing the deck and settling its default afterwards does not.
    pub soft: bool,
}

/// What a local column holds when the op names no parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Absent {
    /// The ordinary case: a nullable foreign key, and NULL is the root.
    Null,
    /// `decks.default_category_id` alone. It is `NOT NULL DEFAULT 0` with `0` meaning Auto
    /// (`crate::deck::AUTO_CATEGORY`), so "nobody" is a zero and a NULL would fail the column.
    Zero,
}

impl Spec {
    /// Every column an op about this table reads or writes, in one list — what the
    /// `AFTER UPDATE OF` clause names and what the change guard compares.
    fn watched(&self) -> Vec<&'static str> {
        let mut cols: Vec<&'static str> = self.fields.to_vec();
        cols.extend_from_slice(self.counters);
        cols.extend(self.parents.iter().map(|p| p.col));
        cols
    }
}

/// One spec per synced table. `schema::SYNCED_TABLES` is the census this is held to.
pub const TABLES: [Spec; 11] = [
    Spec {
        table: "collection_entries",
        keys: &["id"],
        fields: &[
            "card_id",
            "set_code",
            "collector_number",
            "lang",
            "finish",
            "condition",
            "condition_original",
            "purchase_price",
            "purchase_currency",
            "acquired_at",
            "acquisition_source",
            "serial_number",
            "altered",
            "signed",
            "proxy",
            "misprint",
            "grading",
            "tags",
            "notes",
            "needs_review",
        ],
        counters: &["quantity", "tradelist_quantity"],
        parents: &[Parent {
            key: "folder",
            col: "folder_id",
            table: "collection_folders",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: false,
    },
    Spec {
        table: "collection_folders",
        keys: &["id"],
        fields: &["name", "kind", "sort_order", "needs_review"],
        counters: &[],
        parents: &[
            Parent {
                key: "parent",
                col: "parent_id",
                table: "collection_folders",
                absent: Absent::Null,
                soft: false,
            },
            Parent {
                key: "deck",
                col: "deck_id",
                table: "decks",
                absent: Absent::Null,
                soft: false,
            },
        ],
        append_only: false,
    },
    Spec {
        table: "deck_audit",
        keys: &["id"],
        fields: &[
            "at",
            "variant",
            "kind",
            "card_id",
            "card_name",
            "payload",
            "delta",
        ],
        counters: &[],
        parents: &[Parent {
            key: "deck",
            col: "deck_id",
            table: "decks",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: true,
    },
    Spec {
        table: "deck_cards",
        keys: &["id"],
        fields: &[
            "variant",
            "card_id",
            "set_code",
            "collector_number",
            "lang",
            "name",
            "finish",
            "needs_review",
        ],
        counters: &["quantity"],
        parents: &[
            Parent {
                key: "deck",
                col: "deck_id",
                table: "decks",
                absent: Absent::Null,
                soft: false,
            },
            Parent {
                key: "category",
                col: "category_id",
                table: "deck_categories",
                absent: Absent::Null,
                soft: false,
            },
            Parent {
                key: "tag",
                col: "tag_id",
                table: "deck_tags",
                absent: Absent::Null,
                soft: false,
            },
        ],
        append_only: false,
    },
    Spec {
        table: "deck_categories",
        keys: &["id"],
        fields: &["name", "kind", "is_active", "sort_order", "origin"],
        counters: &[],
        parents: &[Parent {
            key: "deck",
            col: "deck_id",
            table: "decks",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: false,
    },
    Spec {
        table: "deck_folders",
        keys: &["id"],
        fields: &["name", "sort_order", "needs_review"],
        counters: &[],
        parents: &[Parent {
            key: "parent",
            col: "parent_id",
            table: "deck_folders",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: false,
    },
    Spec {
        table: "deck_tags",
        keys: &["id"],
        fields: &["name", "name_key", "color"],
        counters: &[],
        parents: &[],
        append_only: false,
    },
    Spec {
        table: "decks",
        keys: &["id"],
        fields: &[
            "name",
            "format_key",
            "game_key",
            "description",
            "cover_kind",
            "cover_card_id",
            "cover_image_path",
            "archived",
            "notes",
            "theory_enabled",
            "last_variant",
            "last_group_by",
            "last_sort_by",
            "separate_x_group",
            "bracket",
        ],
        counters: &[],
        parents: &[
            Parent {
                key: "folder",
                col: "folder_id",
                table: "deck_folders",
                absent: Absent::Null,
                soft: false,
            },
            // **A local row id in a plain INTEGER column with a `0` sentinel**
            // (`crate::deck::AUTO_CATEGORY`), and not a declared foreign key — but a *parent*
            // all the same, and the plan this was built from had it as a field. A field would
            // carry the **originating device's** category id, and nothing at the far end can
            // turn one of those into anything: the id names a row in a database this device has
            // never seen. What travels is the category's uid, and `Absent::Zero` is what keeps
            // an Auto deck reading as Auto rather than failing a NOT NULL column.
            Parent {
                key: "default_category",
                col: "default_category_id",
                table: "deck_categories",
                absent: Absent::Zero,
                soft: true,
            },
        ],
        append_only: false,
    },
    Spec {
        table: "muted_tags",
        keys: &["namespace", "tag_id"],
        // **The primary key is on the field list, and it is the only table where that is so.**
        // Everywhere else the key is a rowid the far device assigns itself; here it is
        // `(namespace, tag_id)`, both `NOT NULL`, and an op that did not carry them would be an
        // op the far device cannot turn into a row at all.
        fields: &["namespace", "tag_id", "slug", "muted_at"],
        counters: &[],
        parents: &[],
        append_only: false,
    },
    Spec {
        table: "wishlist_entries",
        keys: &["id"],
        fields: &[
            "oracle_id",
            "card_id",
            "set_code",
            "collector_number",
            "lang",
            "name",
            "preferred_finish",
            "notes",
            "needs_review",
        ],
        counters: &["quantity"],
        parents: &[Parent {
            key: "folder",
            col: "folder_id",
            table: "wishlist_folders",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: false,
    },
    Spec {
        table: "wishlist_folders",
        keys: &["id"],
        fields: &["name", "sort_order", "needs_review"],
        counters: &[],
        parents: &[Parent {
            key: "parent",
            col: "parent_id",
            table: "wishlist_folders",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: false,
    },
];

/// The `sync_state` key an apply parks under. Read by every capture trigger's `WHEN`.
pub const APPLYING: &str = "applying";

/// The subquery every capture trigger is gated on. One indexed single-row read against a
/// `WITHOUT ROWID` table whose primary key is the text being matched.
const GUARD: &str = "(SELECT value FROM sync_state WHERE key = 'applying') IS NULL";

/// The stamp expression: `max(clock, wall)` millis, and the counter that follows from it.
///
/// The same rule [`super::hlc::Hlc::tick`] spells in Rust, in the one place SQL has to own it —
/// and the two are held together by
/// [`tests::the_trigger_stamp_agrees_with_the_rust_clock`].
const STAMP_MS: &str = "max(c.ms, cast(unixepoch('subsec') * 1000 AS INTEGER))";
const STAMP_CTR: &str =
    "CASE WHEN cast(unixepoch('subsec') * 1000 AS INTEGER) > c.ms THEN 0 ELSE c.ctr + 1 END";

/// A sparse JSON object of the fields that changed.
///
/// **Sparse is the requirement, not a nicety.** Last-writer-wins is per field (spec §7.3), so an
/// op carrying every column would clobber a field it never touched — one device editing a note
/// would undo another's price edit on the same row, which is the exact failure that row of the
/// table exists to prevent. `IS NOT` is the null-safe comparison, which matters because most of
/// these columns are nullable and `<>` answers NULL rather than true.
///
/// # Why it is a `json_group_object` over a `UNION ALL` and not a fold of `json_set`
///
/// **The obvious shape is exponential and it hung the whole test file.** Nesting
/// `CASE WHEN … THEN json_set(<expr>, …) ELSE <expr> END` names `<expr>` *twice* per column, so
/// the generated SQL doubles in length with every field — 2²⁰ copies of the innermost
/// expression for `collection_entries`, which is a `CREATE TRIGGER` that never finishes being
/// built. Measured 2026-08-28: every test in this module sat at "running for over 60 seconds".
///
/// Nesting `json_patch` instead is linear, and wrong in a quieter way: `json_patch` implements
/// RFC 7386 merge semantics, where a null value **removes** the key. A field the reader cleared
/// would be a field the op does not mention, and the far device would keep the old value
/// forever. `clearing_a_field_to_null_still_names_it` is what holds that shut.
///
/// A `SELECT … WHERE <unchanged>` contributes no row, `json_group_object` over no rows is `{}`,
/// and the whole thing is one subquery whose length is linear in the field count.
fn changed_fields(spec: &Spec) -> String {
    sparse_object(spec.fields.iter().map(|f| {
        (
            f.to_string(),
            format!("NEW.{f}"),
            format!("NEW.{f} IS NOT OLD.{f}"),
        )
    }))
}

/// Every field, for an insert. A row that has just come into existence has no field that did
/// not change, so this one is a plain `json_object` — and a NULL column travels as a JSON null
/// rather than being left out, which is the initial value and not an absence.
fn all_fields(spec: &Spec) -> String {
    let pairs: Vec<String> = spec
        .fields
        .iter()
        .map(|f| format!("'{f}', NEW.{f}"))
        .collect();
    if pairs.is_empty() {
        "json_object()".to_owned()
    } else {
        format!("json_object({})", pairs.join(", "))
    }
}

/// Counter deltas. `old` is `None` for an insert, where the delta is the whole value.
///
/// **A counter that did not move is omitted**, so a note edit does not ship a `+0` that the
/// applier then has to know is harmless.
fn counter_object(spec: &Spec, old: Option<&str>) -> String {
    match old {
        None => {
            let pairs: Vec<String> = spec
                .counters
                .iter()
                .map(|c| format!("'{c}', NEW.{c}"))
                .collect();
            if pairs.is_empty() {
                "json_object()".to_owned()
            } else {
                format!("json_object({})", pairs.join(", "))
            }
        }
        Some(o) => sparse_object(spec.counters.iter().map(|c| {
            (
                c.to_string(),
                format!("NEW.{c} - {o}.{c}"),
                format!("NEW.{c} <> {o}.{c}"),
            )
        })),
    }
}

/// `{k: v}` for every `(key, value, when)` whose condition holds, and `{}` when none does.
fn sparse_object(rows: impl Iterator<Item = (String, String, String)>) -> String {
    let arms: Vec<String> = rows
        .enumerate()
        .map(|(i, (k, v, cond))| {
            let head = if i == 0 { "SELECT" } else { "UNION ALL SELECT" };
            let alias = if i == 0 { " AS k" } else { "" };
            let valias = if i == 0 { " AS v" } else { "" };
            format!("{head} '{k}'{alias}, {v}{valias} WHERE {cond}")
        })
        .collect();
    if arms.is_empty() {
        return "json_object()".to_owned();
    }
    format!(
        "coalesce((SELECT json_group_object(k, v) FROM ({})), json_object())",
        arms.join(" ")
    )
}

/// Foreign rows named by their `sync_uid`, never by a local id.
///
/// A `NULL` local id is a row at the root, which is a real value rather than an absence —
/// `json_set` stores it as a JSON null and [`super::merge`] reads it back as `Some(None)`.
///
/// **Complete on an insert and sparse on an update, for `changed_fields`' reason.** A note edit
/// that shipped the row's current folder as well would win last-writer-wins against a
/// concurrent *move* carrying an earlier stamp — the move would be silently undone by an edit
/// that had nothing to do with it, which is the whole failure per-field LWW exists to prevent,
/// one column type over. The plan this was built from emitted the full object both times.
fn all_parents(spec: &Spec) -> String {
    let mut expr = "json_object()".to_owned();
    for p in spec.parents {
        expr = format!(
            "json_set({expr}, '$.{key}', (SELECT sync_uid FROM {table} WHERE id = NEW.{col}))",
            key = p.key,
            table = p.table,
            col = p.col
        );
    }
    expr
}

fn changed_parents(spec: &Spec) -> String {
    sparse_object(spec.parents.iter().map(|p| {
        (
            p.key.to_string(),
            format!(
                "(SELECT sync_uid FROM {} WHERE id = NEW.{})",
                p.table, p.col
            ),
            format!("NEW.{col} IS NOT OLD.{col}", col = p.col),
        )
    }))
}

/// `NEW.a IS NOT OLD.a OR …` over every watched column — the semantic half of the update
/// guard, and the half that stops a no-op `UPDATE` writing an op with nothing in it.
fn something_moved(spec: &Spec) -> String {
    let terms: Vec<String> = spec
        .watched()
        .iter()
        .map(|c| format!("NEW.{c} IS NOT OLD.{c}"))
        .collect();
    if terms.is_empty() {
        "0".to_owned()
    } else {
        terms.join(" OR ")
    }
}

/// The `INSERT INTO sync_ops … SELECT` every trigger ends with.
///
/// The cross join is what makes an unpaired device record nothing: `sync_group` is empty until
/// pairing, and a join against an empty table produces no row. It is also why the v29 rung and
/// `USER_SEED_SQL` both seed `sync_clock` — that one is joined too, and an empty clock would
/// silence a *paired* device just as completely, with nothing anywhere to say so.
fn emit(table: &str, uid: &str, kind: &str, fields: &str, counters: &str, parents: &str) -> String {
    format!(
        "INSERT INTO sync_ops
             (tbl, uid, kind, fields, counters, parents, hlc_ms, hlc_ctr, device_id)
         SELECT '{table}', {uid}, '{kind}', {fields}, {counters}, {parents},
                {STAMP_MS}, {STAMP_CTR}, i.device_id
           FROM sync_clock c, sync_identity i, sync_group g;"
    )
}

fn key_match(spec: &Spec, row: &str) -> String {
    spec.keys
        .iter()
        .map(|k| format!("{k} = {row}.{k}"))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// The insert trigger: mint a uid if the row has none, then write one `put`.
///
/// **The mint is unconditional — it runs on an unpaired device too**, and that is deliberate.
/// A uid is a row's *name*, and a device that pairs next year must not discover that everything
/// it wrote in the meantime is anonymous. `schema::mint_missing_uids` exists for the three
/// creation paths that are not this trigger, and between them every row in the file has a name
/// at all times.
fn insert_trigger(spec: &Spec) -> String {
    let t = spec.table;
    let key = key_match(spec, "NEW");
    let body = emit(
        t,
        &format!("(SELECT sync_uid FROM {t} WHERE {key})"),
        "put",
        &all_fields(spec),
        &counter_object(spec, None),
        &all_parents(spec),
    );
    format!(
        "DROP TRIGGER IF EXISTS sync_ins_{t};
         CREATE TRIGGER sync_ins_{t} AFTER INSERT ON {t}
         WHEN {GUARD}
         BEGIN
             UPDATE {t} SET sync_uid = lower(hex(randomblob(16)))
              WHERE {key} AND sync_uid IS NULL;
             {body}
         END;"
    )
}

/// The update trigger.
///
/// **Two guards, and for the mint above either one alone would do.** The `OF` list does not
/// name `sync_uid`, so the mint's `UPDATE` does not reach this trigger at all; the `WHEN` finds
/// no captured column moved, so it would refuse the op even if it did. That redundancy is a
/// measured fact rather than a claim — removing either leaves every test in this module green,
/// and removing both makes one insert write two ops. Both stay: the `OF` clause is the cheaper
/// of the two, and the `WHEN` is the only one of them that can also see
/// `UPDATE decks SET notes = notes`.
fn update_trigger(spec: &Spec) -> String {
    let t = spec.table;
    let watched = spec.watched().join(", ");
    let moved = something_moved(spec);
    let body = emit(
        t,
        "NEW.sync_uid",
        "put",
        &changed_fields(spec),
        &counter_object(spec, Some("OLD")),
        &changed_parents(spec),
    );
    format!(
        "DROP TRIGGER IF EXISTS sync_upd_{t};
         CREATE TRIGGER sync_upd_{t} AFTER UPDATE OF {watched} ON {t}
         WHEN {GUARD} AND ({moved})
         BEGIN
             {body}
         END;"
    )
}

/// The delete trigger: a tombstone, and nothing else in it.
fn delete_trigger(spec: &Spec) -> String {
    let t = spec.table;
    let body = emit(
        t,
        "OLD.sync_uid",
        "del",
        "json_object()",
        "json_object()",
        "json_object()",
    );
    format!(
        "DROP TRIGGER IF EXISTS sync_del_{t};
         CREATE TRIGGER sync_del_{t} AFTER DELETE ON {t}
         WHEN {GUARD} AND OLD.sync_uid IS NOT NULL
         BEGIN
             {body}
         END;"
    )
}

/// The clock follows the op it just stamped.
///
/// A separate trigger rather than a second statement inside each of the thirty-one, so the rule
/// lives once. It is not recursive — a different table — so `PRAGMA recursive_triggers` has no
/// bearing on it either way, and nothing here depends on that pragma's value.
const CLOCK_TRIGGER: &str = "DROP TRIGGER IF EXISTS sync_ops_clock;
     CREATE TRIGGER sync_ops_clock
     AFTER INSERT ON sync_ops
     BEGIN
         UPDATE sync_clock SET ms = NEW.hlc_ms, ctr = NEW.hlc_ctr WHERE id = 1;
     END;";

/// Install every capture trigger on `conn`.
///
/// **`DROP` then `CREATE`, never `CREATE … IF NOT EXISTS`.** A trigger is stored SQL: a build
/// that changed the generator and shipped `IF NOT EXISTS` would leave every existing database
/// running last year's rules forever, silently, and a bug fixed here would reach nobody who
/// already had the app. Thirty-one drops and creates at open is a fraction of a millisecond.
///
/// Called from [`crate::schema::prepare_database`], so it reaches the desktop, Android and the
/// browser through the one door. **Not** on a read-only connection: it never writes, and a
/// trigger there is thirty-one objects nobody fires.
pub fn install(conn: &Connection) -> rusqlite::Result<()> {
    for spec in &TABLES {
        conn.execute_batch(&insert_trigger(spec))?;
        if !spec.append_only {
            conn.execute_batch(&update_trigger(spec))?;
            conn.execute_batch(&delete_trigger(spec))?;
        }
    }
    conn.execute_batch(CLOCK_TRIGGER)
}

/// Read one `sync_ops` row as an [`Op`](super::merge::Op).
///
/// **One reader, two callers**, and they must not drift: [`super::apply`] loads this device's
/// own history for a row so that add-wins can compare a remote tombstone against a local edit,
/// and [`super::client`] drains the unpushed tail. The column order below is the order both
/// their `SELECT`s use, and `OPS_SELECT` is what keeps that true.
pub const OPS_SELECT: &str =
    "SELECT seq, tbl, uid, kind, fields, counters, parents, hlc_ms, hlc_ctr, device_id \
     FROM sync_ops";

/// `(seq, op)` from a row of [`OPS_SELECT`].
pub fn op_from_row(row: &rusqlite::Row) -> rusqlite::Result<(i64, super::merge::Op)> {
    use super::merge::{Kind, Op};
    let kind: String = row.get(3)?;
    let json = |i: usize| -> rusqlite::Result<serde_json::Value> {
        let text: String = row.get(i)?;
        Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
    };
    let fields = json(4)?;
    let counters = json(5)?;
    let parents = json(6)?;
    Ok((
        row.get(0)?,
        Op {
            table: row.get(1)?,
            uid: row.get(2)?,
            kind: if kind == "del" { Kind::Del } else { Kind::Put },
            fields: fields
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
            counters: counters
                .as_object()
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| v.as_i64().map(|n| (k.clone(), n)))
                        .collect()
                })
                .unwrap_or_default(),
            parents: parents
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().map(std::borrow::ToOwned::to_owned)))
                        .collect()
                })
                .unwrap_or_default(),
            at: super::hlc::Hlc {
                ms: row.get(7)?,
                ctr: row.get(8)?,
                device: row.get(9)?,
            },
        },
    ))
}

/// Run `f` with capture switched off — what [`super::apply`] wraps every write in.
///
/// **The guard is cleared even on a panic**, through a guard struct rather than a bare pair of
/// statements: a sticky `applying` row is a device that silently stops syncing, and it would
/// survive a restart because the row is in the database.
pub fn suppressed<T>(conn: &Connection, f: impl FnOnce() -> T) -> T {
    struct Guard<'a>(&'a Connection);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            let _ = self
                .0
                .execute("DELETE FROM sync_state WHERE key = ?1", [APPLYING]);
        }
    }
    let _ = conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, '1')",
        [APPLYING],
    );
    let _g = Guard(conn);
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        install(&conn).unwrap();
        // A device with no group records nothing, so every test needs one.
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-a', x'00', x'01', 'A', 0)",
            [],
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

    fn ops(conn: &Connection) -> Vec<(String, String, String, String)> {
        let mut s = conn
            .prepare("SELECT tbl, kind, fields, counters FROM sync_ops ORDER BY seq")
            .unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// The census must name every table the schema says is synced, and no other.
    #[test]
    fn every_synced_table_is_on_the_census() {
        let mut got: Vec<&str> = TABLES.iter().map(|t| t.table).collect();
        let mut want: Vec<&str> = crate::schema::SYNCED_TABLES.to_vec();
        want.sort_unstable();
        got.sort_unstable();
        assert_eq!(got, want, "a synced table with no capture spec never syncs");
    }

    /// **Every column a spec names actually exists.** A typo here is not a compile error and is
    /// not a runtime error either on the table it is on: `CREATE TRIGGER` is not checked against
    /// the schema until it fires, so a misspelt column is a *write* that starts failing for the
    /// reader, in a command that has nothing to do with sync.
    #[test]
    fn every_column_a_spec_names_exists_on_its_table() {
        let conn = crate::schema::memory_pair();
        for spec in &TABLES {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT name FROM pragma_table_info('{}')",
                    spec.table
                ))
                .unwrap();
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let mut named = spec.watched();
            named.extend_from_slice(spec.keys);
            for c in named {
                assert!(
                    cols.iter().any(|have| have == c),
                    "{}.{c} is on a capture spec and not in the schema",
                    spec.table
                );
            }
            assert!(
                cols.iter().any(|c| c == "sync_uid"),
                "{} has no sync_uid",
                spec.table
            );
        }
    }

    /// **No captured column may be `created_at` or `updated_at`.** They are facts about when
    /// *this* device wrote a row, and syncing one puts two answers to "when" in the database.
    #[test]
    fn no_spec_captures_a_local_timestamp() {
        for spec in &TABLES {
            for c in spec.watched() {
                assert!(
                    c != "created_at" && c != "updated_at",
                    "{}.{c} is local bookkeeping and must not travel",
                    spec.table
                );
            }
        }
    }

    /// An insert mints a uid and writes one `put`.
    ///
    /// **The `assert_eq!(1)` is the whole test.** The mint is an `UPDATE`, and with
    /// `recursive_triggers` off a trigger's `UPDATE` still fires the `AFTER UPDATE` trigger on
    /// the same table — so an update trigger written without its `OF` clause makes this two.
    #[test]
    fn an_insert_mints_a_uid_and_writes_one_put() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let uid: Option<String> = conn
            .query_row("SELECT sync_uid FROM decks", [], |r| r.get(0))
            .unwrap();
        assert!(uid.is_some(), "the insert trigger must mint a uid");

        let o = ops(&conn);
        assert_eq!(o.len(), 1, "one insert is one op: {o:?}");
        assert_eq!((o[0].0.as_str(), o[0].1.as_str()), ("decks", "put"));
        let fields: serde_json::Value = serde_json::from_str(&o[0].2).unwrap();
        assert_eq!(fields["name"], "A");
    }

    /// ...and the op's uid is the row's, not a NULL and not a second mint.
    #[test]
    fn the_op_names_the_row_by_the_uid_the_row_kept() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let (row, op): (String, String) = conn
            .query_row(
                "SELECT (SELECT sync_uid FROM decks), (SELECT uid FROM sync_ops)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, op);
    }

    /// **An update carries only what changed.** Per-field last-writer-wins is the rule
    /// (spec §7.3), and an op carrying every column would clobber a field it never touched.
    #[test]
    fn an_update_carries_only_the_fields_that_moved() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET notes = 'hello'", [])
            .unwrap();

        let o = ops(&conn);
        assert_eq!(o.len(), 1);
        let fields: serde_json::Value = serde_json::from_str(&o[0].2).unwrap();
        assert_eq!(fields["notes"], "hello");
        assert!(
            fields.get("name").is_none(),
            "name did not change: {fields}"
        );
    }

    /// **A field cleared to NULL is a change and must travel as one.** `json_patch` would have
    /// *removed* the key instead — RFC 7386 merge semantics — and the far device would keep the
    /// old note forever with nothing anywhere to say the clear had happened.
    #[test]
    fn clearing_a_field_to_null_still_names_it() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, notes, created_at, updated_at)
             VALUES ('A', 'commander', 'old', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET notes = NULL", []).unwrap();

        let o = ops(&conn);
        assert_eq!(o.len(), 1, "clearing a field is a change: {o:?}");
        let fields: serde_json::Value = serde_json::from_str(&o[0].2).unwrap();
        assert!(
            fields.get("notes").is_some(),
            "the op must name the cleared field: {fields}"
        );
        assert!(fields["notes"].is_null());
    }

    /// An update that moves nothing writes nothing.
    #[test]
    fn an_update_that_changes_nothing_writes_no_op() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET name = name", []).unwrap();
        assert!(ops(&conn).is_empty());
        // ...and `updated_at` is not captured, so touching it alone is not a change either.
        conn.execute("UPDATE decks SET updated_at = updated_at + 1", [])
            .unwrap();
        assert!(ops(&conn).is_empty(), "updated_at is local bookkeeping");
    }

    /// **Quantity travels as a delta, never as a value.** This is the counter rule's whole
    /// mechanism, and a `+1` that shipped as `1` is what turns two additions into one card.
    #[test]
    fn a_quantity_change_is_captured_as_a_delta() {
        let conn = db();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE collection_entries SET quantity = 5", [])
            .unwrap();

        let o = ops(&conn);
        assert_eq!(o.len(), 1);
        let counters: serde_json::Value = serde_json::from_str(&o[0].3).unwrap();
        assert_eq!(counters["quantity"], 3, "5 - 2, not 5");
        assert!(
            counters.get("tradelist_quantity").is_none(),
            "a counter that did not move is not in the op: {counters}"
        );
    }

    /// ...and on an INSERT the delta is the whole value, because the row was not there.
    #[test]
    fn an_inserted_quantity_is_its_own_delta() {
        let conn = db();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        let o = ops(&conn);
        let counters: serde_json::Value = serde_json::from_str(&o[0].3).unwrap();
        assert_eq!(counters["quantity"], 4);
    }

    /// A parent travels as the parent's uid, and the root travels as a JSON null.
    #[test]
    fn a_parent_travels_as_its_uid_and_the_root_as_a_null() {
        let conn = db();
        conn.execute(
            "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
             VALUES ('Binder', 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let folder_uid: String = conn
            .query_row("SELECT sync_uid FROM deck_folders", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
             VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('B', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();

        let mut s = conn
            .prepare("SELECT parents FROM sync_ops WHERE tbl = 'decks' ORDER BY seq")
            .unwrap();
        let rows: Vec<serde_json::Value> = s
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|p| serde_json::from_str(&p.unwrap()).unwrap())
            .collect();
        assert_eq!(rows[0]["folder"], serde_json::json!(folder_uid));
        assert!(
            rows[1]["folder"].is_null(),
            "the root is a value, not an absence: {}",
            rows[1]
        );
    }

    /// **An edit that is not a move does not ship the row's parents.** A note edit carrying
    /// the row's current folder would win last-writer-wins against a concurrent *move* with an
    /// earlier stamp, and the move would be silently undone by an edit that had nothing to do
    /// with it -- per-field LWW's whole argument, one column type over.
    #[test]
    fn an_edit_that_is_not_a_move_ships_no_parent() {
        let conn = db();
        conn.execute(
            "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
             VALUES ('Binder', 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
             VALUES ('A', 'commander', 1, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        conn.execute("UPDATE decks SET notes = 'hello'", [])
            .unwrap();
        let parents: String = conn
            .query_row("SELECT parents FROM sync_ops", [], |r| r.get(0))
            .unwrap();
        let parents: serde_json::Value = serde_json::from_str(&parents).unwrap();
        assert!(
            parents.get("folder").is_none(),
            "a note edit must not restate the folder: {parents}"
        );

        // ...and a move ships exactly the parent that moved.
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET folder_id = NULL", [])
            .unwrap();
        let parents: String = conn
            .query_row("SELECT parents FROM sync_ops", [], |r| r.get(0))
            .unwrap();
        let parents: serde_json::Value = serde_json::from_str(&parents).unwrap();
        assert!(parents.get("folder").is_some(), "a move must travel");
        assert!(parents["folder"].is_null(), "the root is a value");
    }

    /// `decks.default_category_id` travels as the **category's uid**, and Auto travels as a
    /// null. A field would have carried the originating device's row id, which names a row in
    /// a database the far device has never seen.
    #[test]
    fn the_default_category_travels_as_a_uid_and_auto_as_a_null() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_categories
                (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
             VALUES (1, 'Ramp', 'main', 1, 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let cat_uid: String = conn
            .query_row("SELECT sync_uid FROM deck_categories", [], |r| r.get(0))
            .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET default_category_id = 1", [])
            .unwrap();

        let parents: String = conn
            .query_row(
                "SELECT parents FROM sync_ops WHERE tbl = 'decks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parents: serde_json::Value = serde_json::from_str(&parents).unwrap();
        assert_eq!(parents["default_category"], serde_json::json!(cat_uid));

        // ...and back to Auto, which is a `0` locally and a null on the wire.
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET default_category_id = 0", [])
            .unwrap();
        let parents: String = conn
            .query_row(
                "SELECT parents FROM sync_ops WHERE tbl = 'decks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parents: serde_json::Value = serde_json::from_str(&parents).unwrap();
        assert!(parents.get("default_category").is_some());
        assert!(parents["default_category"].is_null());
        // And it is not on the field list any more, so no raw id travels.
        let fields: String = conn
            .query_row("SELECT fields FROM sync_ops WHERE tbl = 'decks'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            !fields.contains("default_category_id"),
            "a foreign device's row id must not travel: {fields}"
        );
    }

    /// **One statement touching five rows is five stamps.** [`super::merge::fold`] keys its
    /// dedupe on the stamp, so two ops sharing one would be silently folded into one -- a
    /// whole row's change lost, from a `UPDATE … WHERE` nobody would think to suspect.
    #[test]
    fn a_multi_row_update_gets_one_stamp_per_row() {
        let conn = db();
        for i in 0..5 {
            conn.execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES (?1, 'commander', unixepoch(), unixepoch())",
                rusqlite::params![format!("d{i}")],
            )
            .unwrap();
        }
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET notes = 'swept'", [])
            .unwrap();

        let (rows, stamps): (i64, i64) = conn
            .query_row(
                "SELECT count(*), count(DISTINCT hlc_ms || ':' || hlc_ctr) FROM sync_ops",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, 5);
        assert_eq!(stamps, 5, "five rows in one statement need five stamps");
    }

    /// The clock actually advances, and two ops never share a stamp.
    #[test]
    fn every_op_gets_a_distinct_stamp() {
        let conn = db();
        for i in 0..20 {
            conn.execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES (?1, 'commander', unixepoch(), unixepoch())",
                rusqlite::params![format!("d{i}")],
            )
            .unwrap();
        }
        let distinct: i64 = conn
            .query_row(
                "SELECT count(DISTINCT hlc_ms || ':' || hlc_ctr) FROM sync_ops",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            distinct, 20,
            "twenty writes in one millisecond need twenty stamps"
        );
    }

    /// The stamp the trigger writes is the stamp [`super::super::hlc::Hlc::tick`] would have
    /// written from the same clock row. Two spellings of one rule, held together.
    #[test]
    fn the_trigger_stamp_agrees_with_the_rust_clock() {
        use crate::sync_engine::hlc::Hlc;
        let conn = db();
        conn.execute("UPDATE sync_clock SET ms = ?1, ctr = 7", [i64::MAX / 2])
            .unwrap();
        let before = Hlc {
            ms: i64::MAX / 2,
            ctr: 7,
            device: "dev-a".into(),
        };
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let (ms, ctr): (i64, i64) = conn
            .query_row("SELECT hlc_ms, hlc_ctr FROM sync_ops", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        // The wall clock is far below a clock parked at i64::MAX/2, which is the backwards-wall
        // case both spellings have to answer the same way.
        let want = Hlc::tick(&before, 1_756_000_000_000);
        assert_eq!((ms, ctr), (want.ms, want.ctr));
    }

    /// A device in no group records nothing at all — but it still names its rows.
    #[test]
    fn an_unpaired_device_records_no_ops_and_still_mints_uids() {
        let conn = crate::schema::memory_pair();
        install(&conn).unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        assert!(ops(&conn).is_empty());
        let uid: Option<String> = conn
            .query_row("SELECT sync_uid FROM decks", [], |r| r.get(0))
            .unwrap();
        assert!(
            uid.is_some(),
            "a device that pairs next year must not find its rows anonymous"
        );
    }

    /// **The apply guard.** Without it two devices ping-pong an op forever.
    #[test]
    fn writes_inside_suppressed_record_nothing() {
        let conn = db();
        suppressed(&conn, || {
            conn.execute(
                "INSERT INTO decks (name, format_key, sync_uid, created_at, updated_at)
                 VALUES ('A', 'commander', 'u1', unixepoch(), unixepoch())",
                [],
            )
            .unwrap();
        });
        assert!(ops(&conn).is_empty());

        // ...and the guard lifts.
        conn.execute("UPDATE decks SET notes = 'x'", []).unwrap();
        assert_eq!(ops(&conn).len(), 1, "the guard must not be sticky");
    }

    /// ...and it lifts through a panic, because a sticky `applying` row is a device that
    /// silently stops syncing and survives a restart while doing it.
    #[test]
    fn the_apply_guard_lifts_after_a_panic() {
        let conn = db();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            suppressed(&conn, || panic!("apply blew up"));
        }));
        assert!(caught.is_err());
        let stuck: i64 = conn
            .query_row(
                "SELECT count(*) FROM sync_state WHERE key = 'applying'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stuck, 0);
    }

    /// A delete writes a tombstone.
    #[test]
    fn a_delete_writes_one_tombstone() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let uid: String = conn
            .query_row("SELECT sync_uid FROM decks", [], |r| r.get(0))
            .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("DELETE FROM decks", []).unwrap();

        let o = ops(&conn);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].1, "del");
        let tombstone: String = conn
            .query_row("SELECT uid FROM sync_ops", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tombstone, uid);
    }

    /// `deck_audit` is append-only: neither a delete nor an update there writes an op.
    #[test]
    fn deck_audit_captures_inserts_only() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_audit (deck_id, at, kind, payload, delta)
             VALUES (1, unixepoch(), 'add', '{}', 1)",
            [],
        )
        .unwrap();
        assert_eq!(
            ops(&conn).iter().filter(|o| o.0 == "deck_audit").count(),
            1,
            "an audit insert is the one thing that does travel"
        );
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE deck_audit SET card_name = 'x'", [])
            .unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();
        assert!(
            ops(&conn).is_empty(),
            "an audit update or delete must emit nothing"
        );
    }

    /// `muted_tags` has no `id` — it is `WITHOUT ROWID` on `(namespace, tag_id)` — so every
    /// statement the generator builds for it addresses rows by those two columns.
    #[test]
    fn a_table_with_a_composite_key_is_captured_too() {
        let conn = db();
        conn.execute(
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
             VALUES ('art', 't1', 'dragon', 0)",
            [],
        )
        .unwrap();
        let o = ops(&conn);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].0, "muted_tags");
        let uid: Option<String> = conn
            .query_row("SELECT sync_uid FROM muted_tags", [], |r| r.get(0))
            .unwrap();
        assert!(uid.is_some());
    }

    /// Installing twice is installing once — `prepare_database` runs at every launch.
    #[test]
    fn installing_twice_leaves_one_set_of_triggers() {
        let conn = db();
        install(&conn).unwrap();
        install(&conn).unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        assert_eq!(ops(&conn).len(), 1);
    }

    /// A rolled-back write leaves no op, which is the whole reason this is a trigger.
    #[test]
    fn a_rolled_back_write_leaves_no_op() {
        let conn = db();
        {
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('A', 'commander', unixepoch(), unixepoch())",
                [],
            )
            .unwrap();
            tx.rollback().unwrap();
        }
        assert!(ops(&conn).is_empty());
        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decks, 0);
    }

    /// A trigger's own insert must not become the answer the caller gets back.
    #[test]
    fn a_captured_insert_still_reports_its_own_rowid() {
        let conn = db();
        let changed = conn
            .execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('A', 'commander', unixepoch(), unixepoch())",
                [],
            )
            .unwrap();
        assert_eq!(changed, 1, "changes() must not count the op row");
        assert_eq!(
            conn.last_insert_rowid(),
            1,
            "last_insert_rowid() must be the deck's, not the op's"
        );
    }

    /// **The one that is invisible to every test above.** Fifty thousand rows in one
    /// transaction, in four arrangements — the bulk-import case spec §7.7 calls out as the only
    /// one near a free-tier limit, broken down so the cost can be attributed rather than
    /// guessed at.
    ///
    /// `cargo test --release --lib -- --ignored bulk_import_with_capture --nocapture`
    #[test]
    #[ignore]
    fn bulk_import_with_capture() {
        /// `paired` writes ops; `suppress` runs the whole import behind the apply guard.
        fn load(capture: bool, paired: bool, suppress: bool) -> (std::time::Duration, i64) {
            let conn = crate::schema::memory_pair();
            if capture {
                install(&conn).unwrap();
            }
            if paired {
                conn.execute(
                    "INSERT INTO sync_identity
                        (id, device_id, secret_key, public_key, name, created_at)
                     VALUES (1, 'dev-a', x'00', x'01', 'A', 0)",
                    [],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
                     VALUES (1, 'g', 0, x'02', 0)",
                    [],
                )
                .unwrap();
            }
            let import = || {
                let started = std::time::Instant::now();
                let tx = conn.unchecked_transaction().unwrap();
                {
                    let mut stmt = tx
                        .prepare(
                            "INSERT INTO collection_entries
                                (card_id,set_code,collector_number,lang,finish,condition,
                                 quantity,created_at,updated_at)
                             VALUES (?1,'lea',?2,'en','nonfoil','NM',1,0,0)",
                        )
                        .unwrap();
                    for i in 0..50_000 {
                        stmt.execute(rusqlite::params![format!("c{i}"), format!("{i}")])
                            .unwrap();
                    }
                }
                tx.commit().unwrap();
                started.elapsed()
            };
            let elapsed = if suppress {
                suppressed(&conn, import)
            } else {
                import()
            };
            let ops: i64 = conn
                .query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
                .unwrap();
            (elapsed, ops)
        }

        let (bare, _) = load(false, false, false);
        let (unpaired, unpaired_ops) = load(true, false, false);
        let (guarded, guarded_ops) = load(true, true, true);
        let (full, ops) = load(true, true, false);
        let r = |d: std::time::Duration| d.as_secs_f64() / bare.as_secs_f64();
        eprintln!("50 000 collection_entries rows in one transaction (release):");
        eprintln!("  no triggers at all        {bare:>12?}   1.00x");
        eprintln!(
            "  triggers, unpaired        {unpaired:>12?}   {:.2}x   {unpaired_ops} ops              (the uid mint alone)",
            r(unpaired)
        );
        eprintln!(
            "  triggers, apply guard on  {guarded:>12?}   {:.2}x   {guarded_ops} ops              (WHEN short-circuits)",
            r(guarded)
        );
        eprintln!(
            "  triggers, paired          {full:>12?}   {:.2}x   {ops} ops -> {} relay writes",
            r(full),
            (ops + 199) / 200
        );
        assert_eq!(ops, 50_000, "one op per row");
        assert_eq!(unpaired_ops, 0);
        assert_eq!(guarded_ops, 0);
    }
}
