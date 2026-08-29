# Syncing Device Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** renaming a device reaches every device in the group, and a joiner stops calling the
device it paired with "Paired device".

**Architecture:** a **twelfth synced table** holding names and nothing else. It rides the capture
triggers, the op log, per-field LWW and the baseline exactly like the other eleven. `sync_devices`
stays unsynced and keeps holding the keys.

**Tech Stack:** Rust (rusqlite), `cargo test`.

## Why this shape

Two defects, one cause — driven on the real pair 2026-08-29.

**Renames do not travel.** `identity::rename_device` writes `sync_devices` and `sync_identity`,
both local, and `sync_devices` is deliberately absent from `schema::SYNCED_TABLES`: `schema.rs`
says pairing's three tables **must never themselves sync**, because they hold this device's secret
key, the group key and the roster. A name therefore crosses only during a pairing ceremony.

**And pairing only carries it one way.** `Invite` — the offer code — is `group_id`, `public_key`,
`token`, with no name in it. `pairing.rs` sets `p.peer_name` in exactly one place, `respond`, which
only the **initiator** runs. So the initiator learns the joiner's name and the joiner falls back to
`DEFAULT_PEER_NAME`. Measured: the desktop's roster read `["main-game", "CPH2581"]` and the phone's
read `["Paired device", "CPH2581"]`.

A synced name table fixes both, and fixes the second **without touching the pairing protocol** —
the placeholder is simply overwritten on the first sync.

**Rejected:** putting the initiator's name in the sealed pairing blob. It fixes the joiner case
only, does nothing for a later rename, and changes a protocol both ends must agree on.

## Global Constraints

- **The schema head is `USER_SCHEMA_VERSION = 30`, so the new rung is v31.** Re-read the constant
  when you land — a spent version is spent.
- **No key material may join the synced set.** This table holds `device_id` and a name. It does
  **not** hold `public_key`, and `sync_devices` is not added to `SYNCED_TABLES`.
- **The count changes from eleven to twelve** in `SYNCED_TABLES: [&str; 11]`,
  `capture::TABLES: [Spec; 11]` and `apply::META: [Meta; 11]`, plus prose that says "eleven".
- **Every module under `sync_engine/` compiles for `wasm32-unknown-unknown`.** No `std::time`.
- `cargo fmt` and clippy are **not** in `npm run verify` but CI runs both, including
  `clippy --lib --target wasm32-unknown-unknown`.
- **Do not run `npm run verify`** while siblings are active; the controller runs it at fan-in.
- **Do not `git commit`.** Agents share one git index here.
- **Prefix scratchpad filenames with your task number.**
- `cargo test --lib a b` exits 1 — use `cargo test --lib -- a b`. A filter matching nothing exits
  0, so always report the "N passed; M filtered out" line.

---

## The shape, pinned

Every task writes against exactly this.

```sql
CREATE TABLE device_names (
    -- The device this names. A group member's id, not a foreign key: `sync_devices` is not
    -- synced, so a name can arrive before the roster row it describes and must survive that.
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sync_uid TEXT
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_device_names_uid ON device_names (sync_uid);
```

`WITHOUT ROWID` on a TEXT primary key, which is `muted_tags`' shape and the precedent for a synced
table keyed by something other than a rowid. Like `muted_tags`, **its primary key is on the field
list** — the far device cannot build the row without it.

```rust
// capture::TABLES gains, keeping the list's alphabetical-ish placement:
Spec {
    table: "device_names",
    keys: &["device_id"],
    fields: &["device_id", "name"],
    counters: &[],
    parents: &[],
    append_only: false,
},

// apply::META gains, after muted_tags:
Meta {
    table: "device_names",
    order: 11,
    grains: &[Grain { predicate: "device_id = ?", sources: &[Source::Field("device_id")] }],
    counters: &[],
    timestamps: true,
    needs_review: false,
    tree: None,
},
```

---

## Task 1: Schema v31 — the `device_names` table

**Files:** `src-tauri/src/schema.rs`, `src-tauri/src/mirror/watch.rs`

- [ ] **Step 1: Write the failing tests** in `schema.rs`'s `mod tests`

```rust
/// v31's table exists on an UPGRADED file, and the ladder is what put it there.
#[test]
fn a_device_name_survives_its_own_device_row() {
    let conn = Connection::open_in_memory().unwrap();
    migrate_single_file(&conn).unwrap();
    migrate_user(&conn).unwrap();
    conn.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at, sync_uid)
         VALUES ('dev-a', 'MAIN-PC', 0, 0, 'u1')",
        [],
    )
    .unwrap();
    let n: String = conn
        .query_row("SELECT name FROM device_names WHERE device_id = 'dev-a'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, "MAIN-PC");
    let v: i64 = conn.query_row("PRAGMA main.user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, USER_SCHEMA_VERSION);
    assert_eq!(USER_SCHEMA_VERSION, 31);
}

/// **It is synced, and `sync_devices` still is not.** The whole point is that a NAME travels
/// while the keys beside it do not.
#[test]
fn names_sync_and_the_roster_that_holds_keys_does_not() {
    assert!(SYNCED_TABLES.contains(&"device_names"));
    assert!(!SYNCED_TABLES.contains(&"sync_devices"));
    assert!(!SYNCED_TABLES.contains(&"sync_identity"));
    assert!(!SYNCED_TABLES.contains(&"sync_group"));
    assert_eq!(SYNCED_TABLES.len(), 12);
}

/// The table carries no key material. A column added here later that did would be a key on
/// the wire, which is the one thing this design exists to avoid.
#[test]
fn the_name_table_holds_no_key_material() {
    let conn = memory_pair();
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('device_names')").unwrap();
    let cols: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(cols, ["device_id", "name", "created_at", "updated_at", "sync_uid"]);
}
```

- [ ] **Step 2: Run them and watch them fail** —
  `cargo test --lib -- schema::tests::a_device_name_survives schema::tests::names_sync_and`

- [ ] **Step 3: `USER_SCHEMA_VERSION = 31`**, and update its doc comment.

- [ ] **Step 4: Add the table to `USER_SCHEMA_SQL`** using the pinned DDL, `{schema}.`-prefixed
  like its neighbours, plus the unique uid index.

- [ ] **Step 5: Add the v31 rung** at the bottom of `migrate_user`, **below the `v == 0` early
  return** and above the unconditional `sync_clock` repair. Plain `CREATE TABLE` + `CREATE UNIQUE
  INDEX` + `PRAGMA main.user_version = 31;` in one transaction, with a literal `31`.

  **The rung also owes a rewind fixture.** Task 1 of the baseline plan was caught by this: the
  test helpers build *head* with `create_user_schema` and wind back with `UNDO_V<n>` chains, so a
  new object that the chain does not drop is still standing when the ladder climbs and the
  `CREATE` fails with "table already exists". Add `UNDO_V31` (`DROP TABLE IF EXISTS
  device_names;`) and spell it first in every chain that already names `UNDO_V30`.

- [ ] **Step 6: `SYNCED_TABLES`** → `[&str; 12]`, inserted in its existing sort order.

- [ ] **Step 7: `schema::TABLES`** gains `("device_names", Side::User)` with a comment saying why
  it is the reader's: a name is something a person typed, and nothing rebuilds it.

- [ ] **Step 8: `mirror::watch::surface_of`'s census** — add `"device_names"` to the **ignored**
  list in `every_table_in_the_schema_has_been_decided_about`, with a comment: it describes a
  conversation rather than a collection, and no mirrored file quotes it.

- [ ] **Step 9: the second written-out list** —
  `schema::tests::the_user_side_is_the_…_tables_no_feed_can_rebuild` carries its count in its own
  name. Add the table and rename the test if the number is in the name.

- [ ] **Step 10: Run** `cargo test --lib -- schema:: mirror::watch::`. Report the selected count.

- [ ] **Step 11: Mutate, for real.** (a) Delete the `CREATE TABLE` from the rung — the v31 test
  and the byte-identical fence must both go red. (b) Drop `UNDO_V31` from the chains — the
  rewind tests must go red. (c) Add `public_key BLOB` to the table —
  `the_name_table_holds_no_key_material` must go red. **Report any survivor rather than
  strengthening the test.**

- [ ] **Step 12: Report.** Do not commit.

---

## Task 2: capture and apply — make it travel

**Files:** `src-tauri/src/sync_engine/capture.rs`, `src-tauri/src/sync_engine/apply.rs`,
`src-tauri/src/sync_engine/apply/tests.rs`

**Consumes:** Task 1's table. **Produces:** nothing other tasks call.

- [ ] **Step 1: Write the failing test** in `apply/tests.rs`, using the file's own two-database
  harness (`paired`, `outbox`, `apply`)

```rust
/// **A rename reaches the other device.** This is the whole feature: two devices converge on
/// one name for a third, with no pairing ceremony in between.
#[test]
fn a_renamed_device_is_renamed_on_the_other_device_too() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    for c in [&a, &b] {
        c.execute(
            "INSERT INTO device_names (device_id, name, created_at, updated_at, sync_uid)
             VALUES ('dev-c', 'This device', 0, 0, lower(hex(randomblob(16))))",
            [],
        )
        .unwrap();
    }
    a.execute("UPDATE device_names SET name = 'Kitchen tablet' WHERE device_id = 'dev-c'", [])
        .unwrap();
    apply(&b, &outbox(&a)).unwrap();

    let got: String = b
        .query_row("SELECT name FROM device_names WHERE device_id = 'dev-c'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(got, "Kitchen tablet");
    let rows: i64 = b.query_row("SELECT count(*) FROM device_names", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "the grain must match on device_id, not insert a second row");
}

/// Two devices that independently named the same peer end with ONE row, by grain.
#[test]
fn two_devices_naming_one_peer_end_with_one_row() { /* both insert dev-c, exchange, assert 1 */ }
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Add the `Spec`** to `capture::TABLES` exactly as pinned, and widen the array to
  `[Spec; 12]`. Comment that `device_id` is on the field list for `muted_tags`' reason — it is
  the key, and an op without it describes no row the far device can build.

- [ ] **Step 4: Add the `Meta`** to `apply::META` exactly as pinned, widening to `[Meta; 12]`.

- [ ] **Step 5: Run** `cargo test --lib -- sync_engine::`. Report the selected count.

- [ ] **Step 6: Mutate, for real.** (a) Drop `device_id` from the `Spec`'s `fields` — a test must
  go red. (b) Empty the `grains` list so it matches by uid alone —
  `two_devices_naming_one_peer_end_with_one_row` must go red. **Report any survivor.**

- [ ] **Step 7: Report.** Do not commit.

---

## Task 3: `identity` — write it and read it

**Files:** `src-tauri/src/sync_pair/identity.rs`

**Consumes:** Task 1's table. Does **not** need Task 2.

- [ ] **Step 1: Write the failing tests**

```rust
/// A rename is recorded where it can travel, as well as where it is read locally.
#[test]
fn renaming_writes_the_synced_name() {
    let conn = db();
    let me = ensure(&conn).unwrap();
    create_group(&conn, &me).unwrap();
    rename_device(&conn, &me.device_id, "Kitchen tablet").unwrap();
    let n: String = conn
        .query_row("SELECT name FROM device_names WHERE device_id = ?1", [&me.device_id], |r| r.get(0))
        .unwrap();
    assert_eq!(n, "Kitchen tablet");
    assert_eq!(roster(&conn).unwrap()[0].name, "Kitchen tablet");
}

/// **A synced name wins over the local roster copy**, which is what makes an arriving rename
/// visible and what quietly repairs "Paired device" on the first sync.
#[test]
fn a_synced_name_outranks_the_placeholder_the_roster_was_filed_under() {
    let conn = db();
    add_device(&conn, "dev-b", &[9u8; 32], "Paired device").unwrap();
    conn.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at, sync_uid)
         VALUES ('dev-b', 'MAIN-PC', 0, 0, 'u1')",
        [],
    )
    .unwrap();
    let row = roster(&conn).unwrap().into_iter().find(|d| d.device_id == "dev-b").unwrap();
    assert_eq!(row.name, "MAIN-PC");
}

/// ...and a device with no synced name still reads the name it was filed under.
#[test]
fn a_device_with_no_synced_name_keeps_its_local_one() { /* add_device only, assert that name */ }
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: `rename_device` writes the synced row** as a third statement in the same
  function, `INSERT … ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, updated_at =
  unixepoch()`.

- [ ] **Step 4: `roster()` prefers it**

```sql
SELECT d.device_id, d.public_key, coalesce(n.name, d.name), d.added_at, d.revoked_at
  FROM sync_devices d
  LEFT JOIN device_names n ON n.device_id = d.device_id
 ORDER BY d.added_at, d.device_id
```

  `coalesce` and not a join that could drop rows: a device with no synced name must still appear.

- [ ] **Step 5: `ensure`'s placeholder upgrade writes it too**, so an upgraded name travels like
  a typed one. It already updates `sync_identity` and `sync_devices`; add the synced row.

- [ ] **Step 6: Run** `cargo test --lib sync_pair`. Report the selected count.

- [ ] **Step 7: Mutate, for real.** (a) Make `roster` read `d.name` instead of the `coalesce` —
  `a_synced_name_outranks_…` must go red. (b) Change the `LEFT JOIN` to an inner `JOIN` —
  `a_device_with_no_synced_name_keeps_its_local_one` must go red, which is the row-dropping
  failure the `LEFT` is there to prevent. **Report any survivor.**

- [ ] **Step 8: Report.** Do not commit.

---

## Fan-in (controller only)

- [ ] `cargo fmt --all`, then `cargo clippy --all-targets -- -D warnings` and
  `cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings`.
  **Two clangs:** wasm needs `C:\Program Files\LLVM\bin`; Android needs the NDK's toolchain bin
  first, or `ring` fails with a misleading `'assert.h' file not found`.
- [ ] `cargo build --lib --target aarch64-linux-android` — CI has no Android job.
- [ ] `npm run verify` **once, serially**, redirected to a file. Never pipe it, and **never put a
  `; echo` after it** — that swallows its exit code and a failing run reads as green.
- [ ] Update the prose that says "eleven synced tables": `docs/reference/sync.md`,
  `docs/reference/data-and-sync.md`, `src-tauri/src/sync_engine/apply.rs`'s module doc.
- [ ] Verify each agent's mutation claims by re-running one yourself.
- [ ] Ship through `auto-pr`. **Do not press Merge.**

## The live pass

- [ ] Rebuild both devices, rename one from the panel, sync, and confirm the new name appears on
  the other **without a re-pairing**.
- [ ] Confirm the phone's roster stops reading "Paired device" for the desktop on the first sync
  after both are on this build.
