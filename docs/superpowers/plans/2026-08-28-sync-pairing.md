# Sync, PR 6 — Device Pairing Without An Account

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two devices become one pairing group with no account, no server-side identity and no password — and a man-in-the-middle sitting where the relay will later sit cannot join, because both readers compare a six-digit code that only the true pair can produce.

**Architecture:** A new Rust module tree `src-tauri/src/sync_pair/` holds four pure layers and one storage layer. `crypto` does X25519, HKDF-SHA256, XChaCha20-Poly1305 and the SAS derivation with no database and no I/O. `invite` encodes the 64-byte pairing payload as a Crockford-base32 code with a checksum, and hands out a QR *module matrix* — a fact — that the webview renders as an SVG. `identity` owns three new SQLite tables: this device's keypair, the group it belongs to, and the roster of the devices in it. `pairing` is the state machine and the eight `#[tauri::command]`s. TypeScript renders, compares and confirms; it never sees a key.

**Tech Stack:** Rust 2021, `rusqlite`, `serde`. Four new crates: `x25519-dalek 3`, `chacha20poly1305 0.10`, `hkdf 0.12`, `getrandom 0.3`, plus `qrcode 0.14`. `sha2 0.10` is already in the tree. React 19 + TypeScript 6 for the Settings panel.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §7.5 (pairing), §7.6 (unpairing and revocation), and §2's architectural rule.

---

## What this PR is, and what it deliberately is not

§7.5's step 4 — "A wraps the group key to B's public key and **sends it through the relay**" — names a relay this PR does not have. PR 7 builds it. So the split is:

- **PR 6 (this one)** ships every byte of the pairing *protocol* and carries the two blobs it produces **by hand**: the invite as a QR code or a typed code, and the sealed group key as a second QR/typed blob. No network of any kind. Two windows side by side, or a phone photographing a laptop, complete a pairing with the app offline.
- **PR 7** replaces the second hand-carried hop with a relay round trip. The crypto, the SAS, the roster and the rotation are all this PR's and PR 7 changes none of them.

That split is not a compromise — it is what makes the security claim testable. **A pairing that never touches a network cannot be attacked by a network**, so every test here is about the protocol rather than about the transport, and PR 7 inherits a verified protocol instead of debugging both at once.

**Two things §7.5 does not say and this plan decides:**

1. **There is no scanner.** §7.5 says "Device B scans". Nothing in this repo can scan: the Tauri webview has no camera permission, `getUserMedia` is not reachable under the CSP in `tauri.conf.json` (`default-src 'self'`, no `media-src`), and there is no Android build until Phase 4. So this PR **displays** a QR code — which a phone's own camera app can read into a clipboard today — and **accepts a typed or pasted code**. The scanner is Phase 4's, in the PR that adds the camera.
2. **The typed code is 105 characters and that is a floor, not a design failure.** The payload is a 16-byte group id, a 32-byte X25519 public key and a 16-byte one-time token = 64 bytes. Crockford base32 is 5 bits per character, so 64 bytes is `ceil(512/5)` = 103 characters, plus a 2-character checksum. The public key is the irreducible half and nothing can shrink it while the invite stays self-contained. That is exactly why §7.5 makes the QR primary: 105 alphanumeric characters is a version-6 QR at error-correction level M, and it is a miserable thing to type. The typed form exists for the machine with no camera pointed at it.

---

## Global Constraints

Copied from the spec and the repo's `CLAUDE.md`; every task's requirements implicitly include these.

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; CI does, and those are the only reds a fully green verify can produce. Run both in `src-tauri/` before each commit.
- **Redirect `npm run verify` to a file and grep it.** Piping to `tail` reports tail's exit code while tests fail underneath.
- **Never install `@types/node`.** `xlsx` is banned. TypeScript stays on 6.0.x.
- `clippy` caps function arguments at 7.
- **Never hand-write rows into `cards` or `sync_meta`.** Tests use `Connection::open_in_memory()` plus `crate::schema::migrate`.
- **A new migration step goes at the *bottom* of the ladder and takes the next free number.** `schema::SCHEMA_VERSION` is **26** as this plan is written. **Read it again at the moment you land** — three branches once numbered themselves 12 against a head of 11 on the same day, a collision git cannot see. This plan says **v27** throughout; if head has moved, the number moves with it and nothing else about the step changes.
- **A new table must be decided about in `mirror::watch::surface_of`**, or `watch::tests::every_table_in_the_schema_has_been_decided_about` goes red. That test asserts the whole of `sqlite_master` against a written-down list, sorted by name.
- **`data/` is the user's and is never committed.**
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.
- **Nothing here is provisioned, registered or uploaded anywhere.** This PR makes no network request of any kind.

### The one thing about keys that has to be said out loud

**The device's secret key and the group key live in `mtg.db`, in the clear.** There is no OS keystore for a portable Windows exe that a reader copies onto a stick, and inventing one would be a second store to lose. The consequence is exact and belongs in the panel's own words in Task 6: **copying the data folder copies the identity.** Somebody who has the database already has the collection it protects, so the key adds no new exposure — but a *backup* of `mtg.db` is a backup of the pairing, and restoring it onto a second machine makes two devices claim one identity. Task 4's `ensure_identity` therefore mints on absence only and never on a mismatch, so a restored database stays the device it was rather than silently forking.

---

### Task 1: Schema v27 — the three sync tables, and everything the ladder charges for one

**Files:**
- Modify: `src-tauri/src/schema.rs` — the new `if v < 27` step at the bottom of `migrate`, `SCHEMA_VERSION`, `UNDO_V27`, and 17 rewind fixtures
- Modify: `src-tauri/src/mirror/watch.rs` — the `ignored` census in `every_table_in_the_schema_has_been_decided_about`
- Test: the inline `#[cfg(test)] mod tests` already in each file

**Interfaces:**
- Consumes: nothing.
- Produces: tables `sync_identity`, `sync_group`, `sync_devices`; `schema::SCHEMA_VERSION == 27`.

> **Why three tables and not three `app_meta` rows.** `app_meta` is TEXT-valued and every one of its keys is a *preference* — a thing whose absence has a sensible default and whose corruption costs a re-choice. A secret key has neither property: it is a BLOB, its absence means "not paired", and a junk value must fail loudly rather than fall back. The schema's own rule (`update.rs`'s `get_app_meta` swallows errors by design) would turn a corrupt key into a silent unpairing.

> ⚠️ **`sync_identity` and `sync_group` hold at most one row each, enforced by `CHECK (id = 1)`.** A second row is not a state this app has an answer for — two identities on one device is the bug where sync silently forks — so the database refuses it rather than the code remembering to.

> ⚠️ **These three tables must never themselves sync.** They are per-device secrets. PR 7's synced-table list must not name them, and Task 1's census entry in `watch::surface_of` is `None` — a key is not something a mirrored text file quotes.

- [ ] **Step 1: Write the failing test**

Append inside `schema.rs`'s existing `mod tests`:

```rust
/// The three tables v27 creates, with the shapes the pairing code reads.
#[test]
fn v27_creates_the_three_pairing_tables() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    for t in ["sync_identity", "sync_group", "sync_devices"] {
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![t],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{t} is missing");
    }

    // The single-row fence is the database's, not the caller's.
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, 'a', x'00', x'01', 'This device', 0)",
        [],
    )
    .unwrap();
    let second = conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (2, 'b', x'00', x'01', 'Another', 0)",
        [],
    );
    assert!(second.is_err(), "a second identity row must be refused");
}

/// A v26 database walks up and keeps everything it had.
#[test]
fn migrating_a_v26_database_adds_the_pairing_tables_and_nothing_else() {
    let conn = v26_database();
    conn.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('Keep me', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();

    migrate(&conn).unwrap();

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 27);
    let decks: i64 = conn
        .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(decks, 1, "the upgrade must not touch the reader's decks");
    let identities: i64 = conn
        .query_row("SELECT count(*) FROM sync_identity", [], |r| r.get(0))
        .unwrap();
    assert_eq!(identities, 0, "v27 creates the table and mints nothing");
}
```

And beside `v25_database`, the fixture the second test needs:

```rust
/// A database at version 26, as a fixture — the shape every other `vNN_database` on this
/// ladder has. It is head minus one until the next rung lands, at which point this doc line
/// and [`v25_database`]'s move together.
fn schema_at_26(conn: &Connection) {
    migrate(conn).unwrap();
    conn.execute_batch(&format!("{UNDO_V27} PRAGMA user_version = 26;"))
        .unwrap();
}

fn v26_database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    schema_at_26(&conn);
    conn
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test schema::tests::v27 2>&1 | tail -20`
Expected: compile error — `cannot find value UNDO_V27 in this scope`. That is the correct first red: the constant is what every rewind fixture will need, and it does not exist yet.

- [ ] **Step 3: Write the migration step**

At the **bottom** of `migrate`, after the `if v < 26` block:

```rust
    if v < 27 {
        let tx = conn.unchecked_transaction()?;
        // **Pairing, and the three things a paired device has to remember**: who it is, which
        // group it is in, and who else is in that group. Spec §7.5.
        //
        // Three tables rather than three `app_meta` rows, and the difference is what a bad
        // value costs. Every key in `app_meta` is a *preference* — `get_app_meta` swallows a
        // read error and every caller falls back on a default, which is right for a zoom level
        // and catastrophic for a secret key: a corrupt row would read as "not paired" and the
        // app would cheerfully offer to pair again while the reader's other device kept
        // encrypting to a key this one had just forgotten.
        //
        // **Spelled out literally**, [`CARDS_COLUMNS`]' rule and the one every rung from v4 on
        // repeats: a migration step is history the day it ships, and a step that interpolated a
        // constant would silently rewrite what a *fresh* install creates the next time that
        // constant moved.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_identity (
                 -- One row, forever. A second identity on one device is the bug where sync
                 -- silently forks, so the database refuses it rather than the code remembering
                 -- to. `id = 1` is the constant, not an autoincrement.
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 -- 16 random bytes as lowercase hex. The deterministic tiebreak in the hybrid
                 -- logical clock (spec §7.3) is an ordering over these, so it must be an
                 -- opaque fixed-width string and never a name a reader can change.
                 device_id TEXT NOT NULL,
                 -- X25519. 32 bytes each, stored raw — see this rung's plan note: there is no
                 -- keystore for a portable exe, and copying the data folder copies the
                 -- identity. That is a property of the app rather than a hole in this table.
                 secret_key BLOB NOT NULL,
                 public_key BLOB NOT NULL,
                 -- What the other devices call this one. The reader's, and the only field here
                 -- they can edit.
                 name TEXT NOT NULL,
                 created_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS sync_group (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 -- 16 random bytes as hex, minted by whichever device paired first. Stable
                 -- across every key rotation, which is exactly why it is not derived from a
                 -- key: revocation replaces the key and must not replace the group.
                 group_id TEXT NOT NULL,
                 -- Bumped by every revocation. A device holding an older epoch cannot read
                 -- anything written after the rotation, which is the whole of §7.6.
                 epoch INTEGER NOT NULL DEFAULT 0,
                 -- 32 bytes. Never leaves the paired devices.
                 group_key BLOB NOT NULL,
                 joined_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS sync_devices (
                 device_id TEXT PRIMARY KEY,
                 public_key BLOB NOT NULL,
                 name TEXT NOT NULL,
                 added_at INTEGER NOT NULL,
                 -- NULL is the normal state. A stamp here means this device was removed: it is
                 -- kept rather than deleted so the roster can still say who was taken off and
                 -- when, and so a rotation can be explained rather than merely happening.
                 revoked_at INTEGER
             ) WITHOUT ROWID;",
        )?;
        // Literal `27`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 27.
        tx.execute_batch("PRAGMA user_version = 27;")?;
        tx.commit()?;
    }
```

Move `SCHEMA_VERSION` to 27:

```rust
pub const SCHEMA_VERSION: i64 = 27;
```

And in the test module, beside `UNDO_V26`:

```rust
    /// And v27's three pairing tables.
    ///
    /// Owed for [`UNDO_V14`]'s quieter reason rather than [`UNDO_V13`]'s loud one: the rung's
    /// DDL is `CREATE TABLE IF NOT EXISTS` throughout, so a fixture that kept these three would
    /// migrate perfectly happily while claiming a version that never had them — green, and
    /// lying about what it tests.
    ///
    /// **No index needs a line of its own.** `sync_devices` is `WITHOUT ROWID` and the other
    /// two are one row each; the rung creates no `CREATE INDEX` at all, so there is nothing a
    /// `DROP TABLE` does not already take.
    ///
    /// **It runs first, before [`UNDO_V26`]**, for that constant's stated reason: newest-first
    /// is the order every rewind always meant.
    const UNDO_V27: &str = "DROP TABLE IF EXISTS sync_devices;
         DROP TABLE IF EXISTS sync_group;
         DROP TABLE IF EXISTS sync_identity;";
```

- [ ] **Step 4: Prepend `{UNDO_V27}` to every rewind fixture — there are exactly 17**

Every fixture below head replays this rung on the way back up, so each rewind chain gains `{UNDO_V27}` **at the front**.

Run this first and write the number down:

```bash
cd src-tauri && grep -c "UNDO_V26" src/schema.rs
```

Expected: **19** — one `const` definition, one doc-comment reference in `schema_at_25`'s docs, and **17 uses inside `format!` strings**. Every one of those 17 gains `{UNDO_V27} ` immediately before `{UNDO_V26}`. After the edit:

```bash
cd src-tauri && grep -c "UNDO_V27" src/schema.rs
```

Expected: **19 as well** — the definition, its own doc line, and the same 17 uses. **If the two counts differ, a fixture was missed**, and a missed fixture is a test that walks back up through a rung it never undid and dies at `table sync_identity already exists`.

- [ ] **Step 5: Decide the three tables in the mirror's census**

In `src-tauri/src/mirror/watch.rs`, `surface_of` needs **no new arm** — a key is not something any mirrored text file quotes, so all three land on the default `_ => None`. What does need editing is the census that makes that a decision rather than an oversight. In `every_table_in_the_schema_has_been_decided_about`, add to the `ignored` array **in sorted position** (the query is `ORDER BY name`), which puts all three between `sets` and `sync_meta`:

```rust
                "sets",
                // Pairing's three (schema v27). They map to nothing for the sharpest reason on
                // this list: they hold this device's secret key, the group key and the roster,
                // and a mirrored file that quoted any of them would write a key into a folder
                // the reader syncs with Dropbox.
                "sync_devices",
                "sync_group",
                "sync_identity",
                "sync_meta",
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test schema:: 2>&1 | tail -12
cd src-tauri && cargo test mirror::watch 2>&1 | tail -12
```

Expected: both green, and the schema suite's count is **two higher** than before this task. **A filter that matches nothing also exits 0** — confirm the number moved.

- [ ] **Step 7: Mutate to prove the fences bite**

Three mutations, all of which must go red:

1. Delete the `"sync_group",` line from the census in `watch.rs`. `every_table_in_the_schema_has_been_decided_about` must FAIL with a left/right array diff. Revert.
2. Delete `{UNDO_V27} ` from `schema_at_25` only. `cargo test schema::` must FAIL — the fixture rewinds to 25 with v27's tables still standing, and `migrate` then answers `table sync_identity already exists`. Revert.
3. Change the step's `CHECK (id = 1)` on `sync_identity` to no check. `v27_creates_the_three_pairing_tables` must FAIL on the second insert. Revert.

**Stop and report if any of the three survives.** Number 2 in particular is the one that has cost this repo whole waves: a rewind fixture that silently does not rewind is a test asserting about head while claiming to assert about a rung.

- [ ] **Step 8: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/schema.rs src-tauri/src/mirror/watch.rs
git commit -m "feat(sync): schema v27 - the three tables a paired device remembers

Who it is, which group it is in, and who else is in it. Three tables rather than three
app_meta rows because every key in that table is a preference: get_app_meta swallows a read
error and every caller falls back on a default, which is right for a zoom level and
catastrophic for a secret key - a corrupt row would read as 'not paired' while the other
device kept encrypting to a key this one had just forgotten.

Both single-row tables carry CHECK (id = 1). Two identities on one device is the bug where
sync silently forks, so the database refuses it rather than the code remembering to.

All three are decided about in the mirror's census as None: a mirrored file that quoted any
of them would write a key into a folder the reader syncs with Dropbox."
```

---

### Task 2: `sync_pair::crypto` — X25519, the derived pair key, and the six digits

**Files:**
- Create: `src-tauri/src/sync_pair/mod.rs`
- Create: `src-tauri/src/sync_pair/crypto.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod sync_pair;` in alphabetical position (between `pub mod sync;` and `pub mod tags;`)
- Modify: `src-tauri/Cargo.toml`
- Test: inline `#[cfg(test)] mod tests` in `crypto.rs` (house style — every module in this crate tests inline)

**Interfaces:**
- Consumes: nothing.
- Produces: `crypto::Keypair { secret: [u8; 32], public: [u8; 32] }`, `crypto::keypair() -> Keypair`, `crypto::random_bytes<const N: usize>() -> [u8; N]`, `crypto::pair_key(secret, their_public, group_id, token) -> [u8; 32]`, `crypto::sas(pair_key, initiator_pub, joiner_pub) -> String`, `crypto::seal(key, aad, plaintext) -> Vec<u8>`, `crypto::open(key, aad, sealed) -> Result<Vec<u8>, CryptoError>`.

> ⚠️ **`lib.rs` must actually name the module before the first red step.** A module the crate never declares compiles nothing and runs no tests, and `cargo test` answers `running 0 tests … ok` and **exits 0**. That has cost this repo four waves of work. Declare `pub mod sync_pair;` in Step 1, not later.

> **Why `chacha20poly1305 0.10` and not 0.11.** 0.11 moved RustCrypto's array types from `generic-array 0.14` to `hybrid-array`, which would put a **second** array stack in a tree that already carries `sha2 0.10 → digest 0.10 → crypto-common 0.1 → generic-array 0.14`. `chacha20poly1305 0.10` and `hkdf 0.12` both sit on that same stack, so the tree stays single-versioned. Step 5 checks it with `cargo tree -d` rather than trusting this paragraph.

- [ ] **Step 1: Add the dependencies and declare the module**

In `src-tauri/Cargo.toml`, after the `sha2` entry:

```toml
# Pairing (spec §7.5). Four crates, and the version choices are one decision rather than four.
#
# `x25519-dalek` gets `getrandom` so `StaticSecret::random()` exists and this crate never has to
# hold an RNG of its own, and `static_secrets` because a device's key is reused for every pairing
# it ever does — an `EphemeralSecret` is consumed by its one `diffie_hellman`.
x25519-dalek = { version = "3", features = ["static_secrets", "getrandom"] }
# **0.10 and deliberately not 0.11.** 0.11 moves RustCrypto's array types to `hybrid-array`,
# which would stand a second array stack beside the `sha2 0.10 -> digest 0.10 -> crypto-common
# 0.1 -> generic-array 0.14` this tree already carries. 0.10 and `hkdf 0.12` sit on that one.
# XChaCha20-Poly1305 rather than the 96-bit-nonce variant: a 192-bit nonce can be drawn at
# random for every message with no counter to keep, and a counter kept across three devices and
# a restore-from-backup is exactly the thing that gets reused.
chacha20poly1305 = "0.10"
hkdf = "0.12"
# Random bytes for the group key, the group id, the device id, the pairing token and every
# nonce. `fill` is the whole API this uses, and it is spelled the same in 0.3 and 0.4 — so if
# `cargo tree -i getrandom` ever shows two majors, moving this pin is a one-word edit with no
# code change. On wasm this crate needs its `wasm_js` feature; that belongs to Phase 2's target
# block, not here, because this PR ships desktop only.
getrandom = "0.3"
# The invite as a picture. This app renders the matrix itself in the webview — see
# `sync_pair::invite::qr_matrix` — so the crate's own `image` and `svg` renderers are dead
# weight and `default-features = false` drops them. Building the matrix is the fact; drawing it
# is the page's, which is this repo's boundary applied to a QR code.
qrcode = { version = "0.14", default-features = false }
```

Create `src-tauri/src/sync_pair/mod.rs`:

```rust
//! Pairing two devices into one group, with no account and no server-side identity.
//!
//! Four layers, and the boundary between them is that only the last one touches SQLite:
//!
//! * [`crypto`] — X25519, HKDF-SHA256, XChaCha20-Poly1305 and the six-digit short
//!   authentication string. No database, no I/O, no clock.
//! * [`invite`] — the 64-byte pairing payload as a typed code and as a QR module matrix.
//! * [`identity`] — this device's keypair, the group it is in, and the roster, in three tables.
//! * [`pairing`] — the state machine and the commands the webview calls.
//!
//! **TypeScript renders, compares and confirms; it never sees a key.** The six digits cross the
//! IPC boundary as a string because they are what a *person* compares, and everything else that
//! crosses is either a public key or a sealed blob.

pub mod crypto;
```

In `src-tauri/src/lib.rs`, add `pub mod sync_pair;` between `pub mod sync;` and `pub mod tags;`.

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/sync_pair/crypto.rs` with only this test module and no implementation yet:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Both sides of a real exchange must derive the same pair key. This is the whole of the
    /// ECDH, and it is genuinely two-sided: two independent keypairs, each deriving from the
    /// other's public half, never sharing a secret.
    #[test]
    fn both_sides_derive_the_same_pair_key() {
        let a = keypair();
        let b = keypair();
        let gid = [7u8; 16];
        let token = [9u8; 16];

        let ka = pair_key(&a.secret, &b.public, &gid, &token);
        let kb = pair_key(&b.secret, &a.public, &gid, &token);
        assert_eq!(ka, kb);
        assert_ne!(ka, [0u8; 32], "a key of zeroes is a derivation that did nothing");
    }

    /// A man in the middle substitutes its own public key. Both readers then see *different*
    /// six-digit codes, which is the entire security argument of §7.5 step 3.
    #[test]
    fn a_substituted_key_makes_the_two_codes_disagree() {
        let a = keypair();
        let b = keypair();
        let m = keypair(); // the relay, lying to both ends
        let gid = [1u8; 16];
        let token = [2u8; 16];

        // A believes it is talking to M, thinking M is B.
        let a_side = pair_key(&a.secret, &m.public, &gid, &token);
        // B believes it is talking to M, thinking M is A.
        let b_side = pair_key(&b.secret, &m.public, &gid, &token);

        let a_code = sas(&a_side, &a.public, &m.public);
        let b_code = sas(&b_side, &m.public, &b.public);
        assert_ne!(
            a_code, b_code,
            "if these matched, the SAS would defeat nothing and pairing would be unsafe"
        );
    }

    /// Six digits, zero-padded, and stable for one input.
    #[test]
    fn the_sas_is_six_digits_and_deterministic() {
        let k = [3u8; 32];
        let p = [4u8; 32];
        let q = [5u8; 32];
        let code = sas(&k, &p, &q);
        assert_eq!(code.len(), 6, "got {code:?}");
        assert!(code.chars().all(|c| c.is_ascii_digit()), "got {code:?}");
        assert_eq!(code, sas(&k, &p, &q));
    }

    /// Order is part of the transcript: the initiator's key first, the joiner's second. Both
    /// sides know which role they are, so this is not ambiguity — it is what stops a reflection.
    #[test]
    fn the_sas_depends_on_which_side_is_the_initiator() {
        let k = [3u8; 32];
        let p = [4u8; 32];
        let q = [5u8; 32];
        assert_ne!(sas(&k, &p, &q), sas(&k, &q, &p));
    }

    /// A sealed blob opens under the same key and the same associated data.
    #[test]
    fn a_sealed_blob_round_trips() {
        let k = random_bytes::<32>();
        let sealed = seal(&k, b"aad", b"the group key").unwrap();
        assert_ne!(sealed, b"the group key", "the ciphertext is not the plaintext");
        assert_eq!(open(&k, b"aad", &sealed).unwrap(), b"the group key");
    }

    /// The three ways it must refuse: the wrong key, tampered associated data, and one flipped
    /// ciphertext bit. Each is an authentication failure and none may return plaintext.
    #[test]
    fn open_refuses_a_wrong_key_wrong_aad_or_a_flipped_bit() {
        let k = random_bytes::<32>();
        let other = random_bytes::<32>();
        let sealed = seal(&k, b"aad", b"secret").unwrap();

        assert!(open(&other, b"aad", &sealed).is_err(), "wrong key");
        assert!(open(&k, b"different", &sealed).is_err(), "wrong aad");

        let mut bent = sealed.clone();
        let last = bent.len() - 1;
        bent[last] ^= 1;
        assert!(open(&k, b"aad", &bent).is_err(), "flipped bit");
    }

    /// A blob shorter than a nonce cannot be a blob, and must not panic on the slice.
    #[test]
    fn open_refuses_a_truncated_blob_without_panicking() {
        let k = random_bytes::<32>();
        assert!(open(&k, b"aad", &[0u8; 4]).is_err());
        assert!(open(&k, b"aad", &[]).is_err());
    }

    /// Two nonces in a row must differ. A repeated nonce under one key is the failure that
    /// breaks this cipher outright, and a `seal` that forgot to draw one would look fine.
    #[test]
    fn two_seals_of_one_plaintext_differ() {
        let k = random_bytes::<32>();
        assert_ne!(seal(&k, b"a", b"same").unwrap(), seal(&k, b"a", b"same").unwrap());
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd src-tauri && cargo test sync_pair::crypto 2>&1 | tail -20`
Expected: **compile error** — `cannot find function keypair in this scope`. The module is declared (Step 1), so this is a real red rather than "0 tests ran".

- [ ] **Step 4: Write the implementation**

Above the test module in `src-tauri/src/sync_pair/crypto.rs`:

```rust
//! The cryptography of pairing, with no database and no clock in sight.
//!
//! Everything here is a pure function of its arguments, which is why it is testable at all: the
//! man-in-the-middle test below runs a real three-party exchange in a few microseconds because
//! there is nothing to mock.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// The domain separator every derivation in this module carries.
///
/// Versioned, because the day the KDF changes is the day two devices on two builds must fail to
/// pair rather than derive two different keys and blame the network.
const INFO_PAIR: &[u8] = b"mtg-grimoire/pair/v1";
const INFO_SAS: &[u8] = b"mtg-grimoire/sas/v1";

/// XChaCha20-Poly1305's nonce: 192 bits.
const NONCE: usize = 24;

/// One device's X25519 key material.
///
/// The secret is raw bytes rather than a `StaticSecret` so this struct can be written straight
/// into a BLOB column and read straight back — the conversion is `StaticSecret::from`, which is
/// infallible for any 32 bytes.
#[derive(Clone)]
pub struct Keypair {
    pub secret: [u8; 32],
    pub public: [u8; 32],
}

/// What a failed `open` says.
///
/// One variant, deliberately. An AEAD that distinguished "wrong key" from "tampered" would be
/// telling an attacker which half of their guess was right, and there is nothing a caller here
/// could do differently with the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("that pairing message could not be read — it is for another device, or it was altered")]
pub struct CryptoError;

/// `N` bytes from the system CSPRNG.
///
/// **Panics if the operating system cannot supply randomness.** That is the right shape: every
/// caller here is minting a key or a nonce, and continuing with a predictable one is worse in
/// every way than not continuing. The condition does not occur on a running Windows session.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the operating system refused to supply random bytes");
    out
}

/// A fresh X25519 keypair for this device.
pub fn keypair() -> Keypair {
    let secret = StaticSecret::random();
    let public = PublicKey::from(&secret);
    Keypair {
        secret: secret.to_bytes(),
        public: public.to_bytes(),
    }
}

/// The key the two pairing devices share, from one ECDH plus one HKDF extract-and-expand.
///
/// **The group id and the token are the salt, not the info.** They are the two values unique to
/// *this* pairing attempt, so binding them into the extract step means a shared secret reused
/// across two attempts still yields two unrelated keys — which is what makes the token
/// one-time in fact rather than by convention.
pub fn pair_key(
    secret: &[u8; 32],
    their_public: &[u8; 32],
    group_id: &[u8; 16],
    token: &[u8; 16],
) -> [u8; 32] {
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(*their_public));
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(group_id);
    salt[16..].copy_from_slice(token);

    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(INFO_PAIR, &mut out)
        .expect("32 bytes is far below HKDF-SHA256's output limit");
    out
}

/// The six digits both readers compare — §7.5 step 3, and the step that is not optional.
///
/// **It is computed over the *derived* key and both public keys, in role order.** A relay that
/// substituted its own key changes the derived key on both sides *and* changes which public key
/// each side saw, so both halves of the transcript move and the two codes disagree. A SAS over
/// the shared secret alone would still work; including the keys is what stops a reflection
/// attack, where an attacker replays A's own key back at A.
///
/// Zero-padded to six characters. `042913` and `42913` are the same number and not the same
/// code, and a reader comparing two screens is comparing characters.
pub fn sas(pair_key: &[u8; 32], initiator_public: &[u8; 32], joiner_public: &[u8; 32]) -> String {
    let mut transcript = [0u8; 64];
    transcript[..32].copy_from_slice(initiator_public);
    transcript[32..].copy_from_slice(joiner_public);

    let hk = Hkdf::<Sha256>::new(Some(&transcript), pair_key);
    let mut out = [0u8; 4];
    hk.expand(INFO_SAS, &mut out).expect("4 bytes");
    format!("{:06}", u32::from_be_bytes(out) % 1_000_000)
}

/// Seal `plaintext` under `key`, authenticating `aad`.
///
/// The 24-byte nonce is drawn fresh and prefixed to the ciphertext, so a caller never has to
/// carry one. That is the whole reason this is XChaCha20 rather than the 96-bit-nonce variant:
/// a random 192-bit nonce is safe to draw for every message forever, and a counter kept across
/// three devices and a restore-from-backup is exactly the thing that gets reused.
pub fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = random_bytes::<NONCE>();
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError)?;
    let mut out = Vec::with_capacity(NONCE + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// The other half. Refuses anything it cannot authenticate, and anything too short to be a blob.
pub fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    // The length check comes before the slice, not after: a blob shorter than a nonce is a
    // panic waiting in `sealed[..NONCE]`, and this function is reachable from a paste box.
    if sealed.len() <= NONCE {
        return Err(CryptoError);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(&sealed[..NONCE]),
            Payload {
                msg: &sealed[NONCE..],
                aad,
            },
        )
        .map_err(|_| CryptoError)
}
```

Add `pub mod crypto;`'s siblings to `sync_pair/mod.rs` as later tasks create them.

- [ ] **Step 5: Run the tests, and check the dependency tree is single-versioned**

```bash
cd src-tauri && cargo test sync_pair::crypto 2>&1 | tail -12
```
Expected: `test result: ok. 8 passed`. Confirm the number is 8 and not 0.

```bash
cd src-tauri && cargo tree -d 2>&1 | grep -E "generic-array|crypto-common|digest|getrandom" || echo "no duplicates"
```
Expected: **`no duplicates`.** If `getrandom` shows two majors, change the `getrandom` pin in `Cargo.toml` to whichever major `x25519-dalek` resolved and re-run — `fill` is spelled the same in both, so no code changes. If `generic-array` or `crypto-common` shows two, the `chacha20poly1305 = "0.10"` pin has been raised; put it back.

- [ ] **Step 6: Mutate to prove the security tests bite**

Two mutations, both of which must go red:

1. In `sas`, drop the transcript: change `Hkdf::<Sha256>::new(Some(&transcript), pair_key)` to `Hkdf::<Sha256>::new(None, pair_key)`. `the_sas_depends_on_which_side_is_the_initiator` must FAIL. Revert.
2. In `open`, change `Payload { msg: …, aad }` to `Payload { msg: …, aad: b"" }` in **both** `seal` and `open` — a cipher that authenticates no associated data. `open_refuses_a_wrong_key_wrong_aad_or_a_flipped_bit` must FAIL on the `wrong aad` assertion. Revert.

**Stop and report if either survives.** The second is the one worth staring at: an AEAD with its AAD quietly dropped passes every round-trip test there is.

- [ ] **Step 7: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/sync_pair/ src-tauri/src/lib.rs
git commit -m "feat(sync): the pairing cryptography - X25519, HKDF, and the six digits

Pure functions of their arguments, which is why the man-in-the-middle test is a real
three-party exchange rather than a mock: A and B each derive against the attacker's key, and
the test asserts the two six-digit codes DISAGREE. If they matched, the SAS would defeat
nothing and §7.5 step 3 would be decoration.

chacha20poly1305 is pinned at 0.10 and not 0.11 on purpose: 0.11 moves RustCrypto's array
types to hybrid-array, which would stand a second array stack beside the one sha2 0.10
already puts in this tree. cargo tree -d is the check, not this message."
```

---

### Task 3: `sync_pair::invite` — the typed code, its checksum, and the QR matrix as a fact

**Files:**
- Create: `src-tauri/src/sync_pair/invite.rs`
- Modify: `src-tauri/src/sync_pair/mod.rs` — add `pub mod invite;`
- Test: inline `#[cfg(test)] mod tests` in `invite.rs`

**Interfaces:**
- Consumes: nothing from Task 2 at the type level.
- Produces: `invite::Invite { group_id: [u8; 16], public_key: [u8; 32], token: [u8; 16] }`, `invite::Invite::encode(&self) -> String`, `invite::Invite::decode(&str) -> Result<Invite, InviteError>`, `invite::QrMatrix { width: usize, modules: Vec<bool> }`, `invite::qr_matrix(&str) -> Result<QrMatrix, InviteError>`.

> **Crockford base32, and why not base64.** The typed form is read off one screen and typed into another. Crockford's alphabet omits `I`, `L`, `O` and `U`, and its decoder folds `I`/`L` onto `1` and `O` onto `0` — so the three confusions a person actually makes are corrected rather than rejected. Base64 has `l`/`1`/`I`, `0`/`O`, and case sensitivity, all three of which this code cannot afford.

> **The checksum is two characters and it is not security.** It catches the typo, so the reader is told "that code has a typo in it" instead of being told the pairing failed — which is a different sentence and points at a different fix. A tampered code fails at the SAS, which is where tampering is supposed to fail.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/sync_pair/invite.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Invite {
        Invite {
            group_id: [0x11; 16],
            public_key: [0x22; 32],
            token: [0x33; 16],
        }
    }

    #[test]
    fn an_invite_round_trips_through_the_typed_code() {
        let inv = sample();
        let code = inv.encode();
        let back = Invite::decode(&code).unwrap();
        assert_eq!(back.group_id, inv.group_id);
        assert_eq!(back.public_key, inv.public_key);
        assert_eq!(back.token, inv.token);
    }

    /// 64 payload bytes at 5 bits per character is 103 characters, plus a 2-character
    /// checksum. The groups are cosmetic and the decoder ignores them.
    #[test]
    fn the_code_is_the_length_the_payload_forces() {
        let raw: String = sample().encode().chars().filter(|c| *c != '-').collect();
        assert_eq!(raw.len(), 105, "103 payload characters plus a 2-character checksum");
    }

    /// The three confusions a person actually makes, corrected rather than rejected.
    #[test]
    fn the_decoder_folds_the_letters_that_look_like_digits() {
        let code = sample().encode();
        let bent: String = code
            .chars()
            .map(|c| match c {
                '1' => 'I',
                '0' => 'O',
                other => other,
            })
            .collect();
        assert_eq!(
            Invite::decode(&bent).unwrap().public_key,
            sample().public_key,
            "I for 1 and O for 0 must decode, not fail"
        );
    }

    /// Spaces, hyphens and case are the reader's, not the format's.
    #[test]
    fn separators_and_case_are_ignored() {
        let code = sample().encode();
        let messy = format!("  {}  ", code.to_lowercase().replace('-', " "));
        assert_eq!(Invite::decode(&messy).unwrap().token, sample().token);
    }

    /// One transposed pair — the commonest typing error there is — must be caught by the
    /// checksum and named as a typo, rather than reaching the ECDH as a valid-looking key.
    #[test]
    fn a_transposition_is_caught_by_the_checksum() {
        let code: String = sample().encode().chars().filter(|c| *c != '-').collect();
        let mut chars: Vec<char> = code.chars().collect();
        // Two adjacent characters that actually differ, so the swap is a real change.
        let i = (0..chars.len() - 1)
            .find(|&i| chars[i] != chars[i + 1])
            .expect("the code has two adjacent characters that differ");
        chars.swap(i, i + 1);
        let bent: String = chars.into_iter().collect();
        assert_eq!(Invite::decode(&bent), Err(InviteError::Checksum));
    }

    #[test]
    fn a_short_or_junk_code_is_refused_by_shape() {
        assert_eq!(Invite::decode("ABC"), Err(InviteError::Length));
        let code: String = sample().encode().chars().filter(|c| *c != '-').collect();
        // `U` is not in Crockford's alphabet and is not one of the folded letters.
        let bent = format!("U{}", &code[1..]);
        assert!(matches!(
            Invite::decode(&bent),
            Err(InviteError::Alphabet) | Err(InviteError::Checksum)
        ));
    }

    /// The matrix is square, non-empty, and both colours occur — a matrix of all-light is
    /// what an encoder that silently did nothing produces.
    #[test]
    fn the_qr_matrix_is_square_and_has_both_colours() {
        let m = qr_matrix(&sample().encode()).unwrap();
        assert_eq!(m.modules.len(), m.width * m.width);
        assert!(m.width >= 21, "the smallest QR version is 21 modules");
        assert!(m.modules.iter().any(|d| *d), "no dark modules at all");
        assert!(m.modules.iter().any(|d| !*d), "no light modules at all");
    }

    /// Two different invites must not draw the same picture.
    #[test]
    fn two_invites_draw_different_matrices() {
        let a = qr_matrix(&sample().encode()).unwrap();
        let mut other = sample();
        other.token = [0x44; 16];
        let b = qr_matrix(&other.encode()).unwrap();
        assert_ne!(a.modules, b.modules);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod invite;` to `sync_pair/mod.rs` **first**, then:
Run: `cd src-tauri && cargo test sync_pair::invite 2>&1 | tail -20`
Expected: compile error — `cannot find type Invite in this scope`.

- [ ] **Step 3: Write the implementation**

Above the test module in `src-tauri/src/sync_pair/invite.rs`:

```rust
//! The pairing invite: 64 bytes, as a typed code and as a picture.
//!
//! **105 characters is a floor and not a design failure.** The payload is a 16-byte group id, a
//! 32-byte X25519 public key and a 16-byte one-time token; base32 is 5 bits per character, so
//! 64 bytes is `ceil(512 / 5)` = 103 characters, and the checksum adds two. The public key is
//! the irreducible half — an invite that omitted it would need the relay to supply it, which is
//! precisely the hop the six-digit SAS exists to distrust. That is why §7.5 makes the QR
//! primary; the typed form is for the machine with no camera pointed at it.

/// Crockford base32, in encode order. No `I`, `L`, `O` or `U`.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// How many payload bytes an invite carries.
const PAYLOAD: usize = 16 + 32 + 16;

/// Payload characters, before the checksum. `ceil(64 * 8 / 5)`.
const BODY_CHARS: usize = 103;

/// Characters per hyphen-separated group in the displayed form. Cosmetic; the decoder strips
/// every separator before it looks at anything.
const GROUP: usize = 5;

/// What a reader is shown, and what device B is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    pub group_id: [u8; 16],
    pub public_key: [u8; 32],
    pub token: [u8; 16],
}

/// Why a typed code was refused.
///
/// Three variants because they are three different sentences to a reader: the code is the wrong
/// length (they pasted half of it), it has a character no code contains (they pasted something
/// else entirely), or it has a typo (they typed it and slipped). Only the third is worth
/// "check the code and try again".
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InviteError {
    #[error("that is not a full pairing code — it should be 105 characters")]
    Length,
    #[error("that does not look like a pairing code")]
    Alphabet,
    #[error("that pairing code has a typo in it")]
    Checksum,
    #[error("that pairing code is too long to draw as a QR code")]
    TooLong,
}

impl Invite {
    /// The typed form: 105 base32 characters in groups of five, separated by hyphens.
    pub fn encode(&self) -> String {
        let mut bytes = Vec::with_capacity(PAYLOAD);
        bytes.extend_from_slice(&self.group_id);
        bytes.extend_from_slice(&self.public_key);
        bytes.extend_from_slice(&self.token);

        let mut body = base32_encode(&bytes);
        body.push_str(&checksum(&body));

        let mut out = String::with_capacity(body.len() + body.len() / GROUP);
        for (i, c) in body.chars().enumerate() {
            if i > 0 && i % GROUP == 0 {
                out.push('-');
            }
            out.push(c);
        }
        out
    }

    /// The other half. Tolerant of case, of separators, and of the three letters a person
    /// substitutes for digits; intolerant of everything else.
    pub fn decode(code: &str) -> Result<Invite, InviteError> {
        let cleaned: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| match c.to_ascii_uppercase() {
                // Crockford's own folding rule, and the whole reason this alphabet was chosen:
                // these are the three confusions a person actually makes.
                'I' | 'L' => '1',
                'O' => '0',
                other => other,
            })
            .collect();

        if cleaned.len() != BODY_CHARS + 2 {
            return Err(InviteError::Length);
        }
        let (body, given) = cleaned.split_at(BODY_CHARS);
        if checksum(body) != given {
            return Err(InviteError::Checksum);
        }
        let bytes = base32_decode(body)?;

        let mut inv = Invite {
            group_id: [0; 16],
            public_key: [0; 32],
            token: [0; 16],
        };
        inv.group_id.copy_from_slice(&bytes[..16]);
        inv.public_key.copy_from_slice(&bytes[16..48]);
        inv.token.copy_from_slice(&bytes[48..64]);
        Ok(inv)
    }
}

/// Two characters over the body, position-weighted.
///
/// **The weighting is what catches a transposition.** A plain sum of symbol values is identical
/// for `AB` and `BA`, and swapping two adjacent characters is the commonest typing error there
/// is — so the sum is over `value * (position + 1)`, which moves when the order does.
fn checksum(body: &str) -> String {
    let mut acc: u32 = 0;
    for (i, c) in body.bytes().enumerate() {
        let v = ALPHABET.iter().position(|a| *a == c).unwrap_or(0) as u32;
        acc = acc.wrapping_add(v.wrapping_mul(i as u32 + 1));
    }
    let acc = acc % 1024;
    let hi = ALPHABET[(acc / 32) as usize] as char;
    let lo = ALPHABET[(acc % 32) as usize] as char;
    format!("{hi}{lo}")
}

/// Big-endian bit packing, five bits at a time. The tail is zero-padded, which is why the
/// decoder is allowed to discard the trailing bits it cannot fill.
fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for b in bytes {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

fn base32_decode(text: &str) -> Result<Vec<u8>, InviteError> {
    let mut out = Vec::with_capacity(PAYLOAD);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in text.bytes() {
        let v = ALPHABET
            .iter()
            .position(|a| *a == c)
            .ok_or(InviteError::Alphabet)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    // 103 characters carry 515 bits and the payload is 512; the last three are the encoder's
    // zero padding and are dropped rather than trusted.
    out.truncate(PAYLOAD);
    if out.len() != PAYLOAD {
        return Err(InviteError::Length);
    }
    Ok(out)
}

/// A QR code as a grid of booleans — `true` is a dark module.
///
/// **A fact, not a picture.** The webview draws it as an SVG, which is where a decision about
/// colour, quiet-zone width and pixel size belongs; this side answers only what the encoder
/// produced. `modules` is row-major and `width * width` long, always.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub width: usize,
    pub modules: Vec<bool>,
}

/// Encode `text` at error-correction level M — the default, and the level the 105-character
/// invite fits comfortably at.
pub fn qr_matrix(text: &str) -> Result<QrMatrix, InviteError> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|_| InviteError::TooLong)?;
    let width = code.width();
    let modules = code
        .to_colors()
        .into_iter()
        .map(|c| c.select(true, false))
        .collect();
    Ok(QrMatrix { width, modules })
}
```

Add `pub mod invite;` to `sync_pair/mod.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sync_pair::invite 2>&1 | tail -12`
Expected: `test result: ok. 8 passed`.

If `qr_matrix` does not compile because `QrCode::new` needs a feature the `default-features = false` line dropped, that is a **loud** failure at exactly this step rather than a silent one — put the needed feature back explicitly (never `default-features = true`) and note which one in the commit message.

- [ ] **Step 5: Mutate to prove the checksum bites**

Change `checksum`'s inner term from `v.wrapping_mul(i as u32 + 1)` to plain `v` — a positional-blind sum, which is what a first draft looks like. `a_transposition_is_caught_by_the_checksum` must FAIL. Revert.

**Stop and report if it survives** — an unweighted checksum passes every round-trip test in this file and catches nothing a person actually does.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_pair/invite.rs src-tauri/src/sync_pair/mod.rs
git commit -m "feat(sync): the pairing invite as a typed code and as a matrix

105 characters is a floor rather than a design failure: 16-byte group id, 32-byte X25519
public key, 16-byte token, at five bits a character, plus a two-character checksum. The
public key is the irreducible half, and an invite that omitted it would need the relay to
supply it - which is the hop the six digits exist to distrust.

Crockford base32 because its decoder folds I/L onto 1 and O onto 0, which are the three
confusions a person typing off one screen into another actually makes. The checksum is
position-weighted so a transposition moves it; an unweighted sum is identical for AB and BA
and catches nothing.

qr_matrix answers a grid of booleans and the page draws the SVG - the boundary this repo
draws everywhere else, applied to a QR code."
```

---

### Task 4: `sync_pair::identity` — the device, the group, the roster, and rotation

**Files:**
- Create: `src-tauri/src/sync_pair/identity.rs`
- Modify: `src-tauri/src/sync_pair/mod.rs` — add `pub mod identity;`
- Test: inline `#[cfg(test)] mod tests` in `identity.rs`

**Interfaces:**
- Consumes: `crypto::keypair`, `crypto::random_bytes` from Task 2.
- Produces: `identity::Device { device_id, public_key, name, added_at, revoked_at }`, `identity::Group { group_id, epoch, group_key }`, and `identity::{ensure, group, create_group, join_group, roster, add_device, rename_device, revoke_device, rotate_key}`.

> **`ensure` mints on absence and never on a mismatch.** A restored `mtg.db` is the device it was, not a new one. Two devices claiming one identity is worse than a device that has to be re-paired, and this is the only line that decides which of those a restore produces.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/sync_pair/identity.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn ensure_mints_once_and_is_stable_afterwards() {
        let conn = db();
        let first = ensure(&conn).unwrap();
        let second = ensure(&conn).unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.keypair.public, second.keypair.public);
        assert_eq!(first.device_id.len(), 32, "16 bytes as hex");
    }

    #[test]
    fn a_fresh_database_is_in_no_group() {
        let conn = db();
        ensure(&conn).unwrap();
        assert!(group(&conn).unwrap().is_none());
    }

    #[test]
    fn creating_a_group_leaves_this_device_on_the_roster() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        let g = create_group(&conn, &me).unwrap();
        assert_eq!(g.epoch, 0);
        assert_eq!(g.group_id.len(), 32);

        let list = roster(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].device_id, me.device_id);
        assert!(list[0].revoked_at.is_none());
    }

    #[test]
    fn joining_a_group_stores_the_key_it_was_given() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        let key = [42u8; 32];
        join_group(&conn, "abc123", 3, &key, &me).unwrap();

        let g = group(&conn).unwrap().unwrap();
        assert_eq!(g.group_id, "abc123");
        assert_eq!(g.epoch, 3);
        assert_eq!(g.group_key, key);
    }

    /// Revocation rotates the key, bumps the epoch, and leaves the removed device on the
    /// roster as removed — §7.6. A deleted row could not answer "who did I take off, and when".
    #[test]
    fn revoking_a_device_rotates_the_key_and_bumps_the_epoch() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();

        let before = group(&conn).unwrap().unwrap();
        revoke_device(&conn, "deadbeef").unwrap();
        let after = group(&conn).unwrap().unwrap();

        assert_eq!(after.group_id, before.group_id, "the group survives a rotation");
        assert_eq!(after.epoch, before.epoch + 1);
        assert_ne!(after.group_key, before.group_key, "the key must actually change");

        let phone = roster(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == "deadbeef")
            .expect("the removed device stays on the roster");
        assert!(phone.revoked_at.is_some());
    }

    /// This device cannot remove itself. "Leave the group" is a different command with
    /// different consequences, and confusing the two loses the reader their key.
    #[test]
    fn this_device_cannot_revoke_itself() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        assert!(revoke_device(&conn, &me.device_id).is_err());
    }

    #[test]
    fn renaming_a_device_changes_only_its_name() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        rename_device(&conn, &me.device_id, "Desk").unwrap();
        let list = roster(&conn).unwrap();
        assert_eq!(list[0].name, "Desk");
        assert_eq!(list[0].device_id, me.device_id);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod identity;` to `sync_pair/mod.rs` first, then:
Run: `cd src-tauri && cargo test sync_pair::identity 2>&1 | tail -20`
Expected: compile error — `cannot find function ensure in this scope`.

- [ ] **Step 3: Write the implementation**

```rust
//! This device's identity, the group it belongs to, and who else is in it.
//!
//! The one layer of `sync_pair` that touches SQLite. Everything above it is pure, which is why
//! the protocol tests never need a database and these tests never need a network.

use crate::sync_pair::crypto::{self, Keypair};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// This device, as the rest of the app refers to it.
pub struct Identity {
    pub device_id: String,
    pub keypair: Keypair,
    pub name: String,
}

/// The group this device is in, if it is in one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub group_id: String,
    pub epoch: i64,
    pub group_key: [u8; 32],
}

/// One row of the roster. The public key is not serialised — the webview draws a list of
/// devices, and a key on that list is a key in a screenshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub added_at: i64,
    pub revoked_at: Option<i64>,
    #[serde(skip)]
    pub public_key: [u8; 32],
}

/// The default name a device gives itself.
///
/// Deliberately not the hostname. A hostname is often a person's own name and it would travel
/// to every paired device without anybody choosing to send it; "This device" is honest, and
/// `rename_device` is one press away.
const DEFAULT_NAME: &str = "This device";

/// Read this device's identity, minting one the first time.
///
/// **It mints on absence and never on a mismatch**, which is the whole of what a restored
/// `mtg.db` gets: the device it was. Re-minting on anything that looked wrong would turn a
/// restore into a silent fork, where two machines both believe they are the same device and
/// both write under that id.
pub fn ensure(conn: &Connection) -> rusqlite::Result<Identity> {
    if let Some(id) = read(conn)? {
        return Ok(id);
    }
    let device_id = hex(&crypto::random_bytes::<16>());
    let kp = crypto::keypair();
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, ?1, ?2, ?3, ?4, unixepoch())",
        params![device_id, kp.secret.as_slice(), kp.public.as_slice(), DEFAULT_NAME],
    )?;
    Ok(Identity {
        device_id,
        keypair: kp,
        name: DEFAULT_NAME.to_owned(),
    })
}

fn read(conn: &Connection) -> rusqlite::Result<Option<Identity>> {
    conn.query_row(
        "SELECT device_id, secret_key, public_key, name FROM sync_identity WHERE id = 1",
        [],
        |r| {
            Ok(Identity {
                device_id: r.get(0)?,
                keypair: Keypair {
                    secret: bytes32(r.get::<_, Vec<u8>>(1)?),
                    public: bytes32(r.get::<_, Vec<u8>>(2)?),
                },
                name: r.get(3)?,
            })
        },
    )
    .optional()
}

/// The group this device is in, or `None`.
pub fn group(conn: &Connection) -> rusqlite::Result<Option<Group>> {
    conn.query_row(
        "SELECT group_id, epoch, group_key FROM sync_group WHERE id = 1",
        [],
        |r| {
            Ok(Group {
                group_id: r.get(0)?,
                epoch: r.get(1)?,
                group_key: bytes32(r.get::<_, Vec<u8>>(2)?),
            })
        },
    )
    .optional()
}

/// Mint a group with this device alone in it. Idempotent: a device already in a group gets the
/// group it is already in, because "pair another device" must never quietly leave the first one.
pub fn create_group(conn: &Connection, me: &Identity) -> rusqlite::Result<Group> {
    if let Some(g) = group(conn)? {
        return Ok(g);
    }
    let g = Group {
        group_id: hex(&crypto::random_bytes::<16>()),
        epoch: 0,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(conn, &g)?;
    add_device(conn, &me.device_id, &me.keypair.public, &me.name)?;
    Ok(g)
}

/// Join a group somebody else minted, with the key they sealed to this device.
pub fn join_group(
    conn: &Connection,
    group_id: &str,
    epoch: i64,
    key: &[u8; 32],
    me: &Identity,
) -> rusqlite::Result<()> {
    write_group(
        conn,
        &Group {
            group_id: group_id.to_owned(),
            epoch,
            group_key: *key,
        },
    )?;
    add_device(conn, &me.device_id, &me.keypair.public, &me.name)
}

fn write_group(conn: &Connection, g: &Group) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
              VALUES (1, ?1, ?2, ?3, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
              group_id = excluded.group_id,
              epoch = excluded.epoch,
              group_key = excluded.group_key",
        params![g.group_id, g.epoch, g.group_key.as_slice()],
    )?;
    Ok(())
}

/// Every device the group has ever had, oldest first, removed ones included.
pub fn roster(conn: &Connection) -> rusqlite::Result<Vec<Device>> {
    let mut stmt = conn.prepare(
        "SELECT device_id, public_key, name, added_at, revoked_at
           FROM sync_devices ORDER BY added_at, device_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Device {
            device_id: r.get(0)?,
            public_key: bytes32(r.get::<_, Vec<u8>>(1)?),
            name: r.get(2)?,
            added_at: r.get(3)?,
            revoked_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Put a device on the roster, or update the key and name of one already there.
pub fn add_device(
    conn: &Connection,
    device_id: &str,
    public_key: &[u8; 32],
    name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_devices (device_id, public_key, name, added_at, revoked_at)
              VALUES (?1, ?2, ?3, unixepoch(), NULL)
         ON CONFLICT(device_id) DO UPDATE SET
              public_key = excluded.public_key,
              name = excluded.name,
              -- Re-pairing a device that was removed puts it back. The reader pressed Pair
              -- and compared six digits; refusing them would be the app disagreeing with a
              -- decision it just asked for.
              revoked_at = NULL",
        params![device_id, public_key.as_slice(), name],
    )?;
    Ok(())
}

pub fn rename_device(conn: &Connection, device_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_devices SET name = ?2 WHERE device_id = ?1",
        params![device_id, name],
    )?;
    Ok(())
}

/// Take a device off the group and rotate the key — §7.6, and the two halves are one statement.
///
/// **The rotation is the removal.** Marking the row and leaving the key alone would produce an
/// app that says a device is gone while that device can still read every op written afterwards.
/// The epoch is what the remaining devices compare, and it is bumped in the same transaction.
///
/// **This device cannot revoke itself.** "Leave the group" is a different press with different
/// consequences — it throws this device's own copy of the key away — and collapsing the two
/// would let a mis-click cost the reader the group they are standing in.
pub fn revoke_device(conn: &Connection, device_id: &str) -> Result<Group, String> {
    let me = ensure(conn).map_err(|e| e.to_string())?;
    if me.device_id == device_id {
        return Err("This device cannot remove itself. Use Leave group instead.".to_owned());
    }
    let Some(current) = group(conn).map_err(|e| e.to_string())? else {
        return Err("This device is not in a pairing group.".to_owned());
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE sync_devices SET revoked_at = unixepoch() WHERE device_id = ?1",
        params![device_id],
    )
    .map_err(|e| e.to_string())?;
    let rotated = Group {
        group_id: current.group_id,
        epoch: current.epoch + 1,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(&tx, &rotated).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rotated)
}

/// Rotate the key without removing anybody — the press behind "Rotate key now".
pub fn rotate_key(conn: &Connection) -> Result<Group, String> {
    let Some(current) = group(conn).map_err(|e| e.to_string())? else {
        return Err("This device is not in a pairing group.".to_owned());
    };
    let rotated = Group {
        group_id: current.group_id,
        epoch: current.epoch + 1,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(conn, &rotated).map_err(|e| e.to_string())?;
    Ok(rotated)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A 32-byte column as an array.
///
/// A short or long BLOB yields zeroes rather than a panic: these columns are written only by
/// this module, so a wrong length means a hand-edited database, and a panic at startup would
/// be the worst possible answer to one.
fn bytes32(v: Vec<u8>) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = v.len().min(32);
    out[..n].copy_from_slice(&v[..n]);
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sync_pair::identity 2>&1 | tail -12`
Expected: `test result: ok. 7 passed`.

- [ ] **Step 5: Mutate to prove the rotation test bites**

In `revoke_device`, change `group_key: crypto::random_bytes::<32>()` to `group_key: current.group_key` — a revocation that marks the row and leaves the key alone, which is what a first draft does and is exactly the bug §7.6 exists to prevent. `revoking_a_device_rotates_the_key_and_bumps_the_epoch` must FAIL on `the key must actually change`. Revert.

**Stop and report if it survives** — a test that only checks the epoch would pass over a removal that removed nothing.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_pair/identity.rs src-tauri/src/sync_pair/mod.rs
git commit -m "feat(sync): the device identity, the group, and revocation that actually rotates

ensure() mints on absence and never on a mismatch, so a restored mtg.db is the device it was.
Re-minting on anything that looked wrong turns a restore into a silent fork where two
machines both write under one id.

Revocation rotates the key in the same transaction that marks the row, because the rotation
IS the removal: marking the row alone produces an app that says a device is gone while that
device can still read every op written afterwards. The removed row is kept rather than
deleted so the roster can say who was taken off and when.

This device cannot revoke itself - leaving a group throws this device's own key away, and
collapsing the two presses would let a mis-click cost the reader the group they are in."
```

---

### Task 5: `sync_pair::pairing` — the state machine and the eight commands

**Files:**
- Create: `src-tauri/src/sync_pair/pairing.rs`
- Modify: `src-tauri/src/sync_pair/mod.rs` — add `pub mod pairing;`
- Modify: `src-tauri/src/sync.rs` — one field on `AppState`
- Modify: `src-tauri/src/lib.rs` — eight entries in `generate_handler!`
- Modify: `src/lib/ipc.ts` — the DTO mirrors and eight methods on `ipc`
- Test: inline `#[cfg(test)] mod tests` in `pairing.rs`; `src/lib/ipc.test.ts` for the argument names

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: commands `sync_pairing_status`, `sync_pairing_begin`, `sync_pairing_accept`, `sync_pairing_respond`, `sync_pairing_confirm`, `sync_pairing_complete`, `sync_pairing_cancel`, `sync_device_revoke` (+ `sync_device_rename`).

> **The pending offer lives in `AppState`, not in SQLite, and that is the token being one-time in fact.** An offer that survived a restart would be an invite a reader printed last month still being accepted today. It has to survive a page reload — the reader may open Settings twice — and `AppState` outlives the webview, which is exactly the right lifetime.

The flow, and which side holds what:

| Press | Command | A holds | B holds |
| --- | --- | --- | --- |
| A: *Pair a device* | `sync_pairing_begin` | pending offer, the invite | — |
| B: pastes the code | `sync_pairing_accept(code)` | — | pair key, **six digits**, a response blob |
| A: pastes the response | `sync_pairing_respond(blob)` | pair key, **six digits** | — |
| both compare | — | | |
| A: *They match* | `sync_pairing_confirm` | group created if needed; **sealed key** | — |
| B: pastes the sealed key | `sync_pairing_complete(blob)` | — | joined |

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/sync_pair/pairing.rs` with only this test module. **This test drives two independent databases against each other** — the only way a pairing test proves anything:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn
    }

    /// A whole pairing, two databases, no network. Both ends must end up holding the same
    /// group key, and the six digits both readers were shown must have matched.
    #[test]
    fn two_databases_pair_and_agree_on_the_key() {
        let a = db();
        let b = db();
        let mut a_pending = None;
        let mut b_pending = None;

        let offer = begin(&a, &mut a_pending).unwrap();
        let accepted = accept(&b, &mut b_pending, &offer.code).unwrap();
        let responded = respond(&a, &mut a_pending, &accepted.response).unwrap();

        assert_eq!(
            accepted.sas, responded.sas,
            "the two readers must be shown the same six digits"
        );

        let sealed = confirm(&a, &mut a_pending).unwrap();
        complete(&b, &mut b_pending, &sealed.sealed_key).unwrap();

        let ga = crate::sync_pair::identity::group(&a).unwrap().unwrap();
        let gb = crate::sync_pair::identity::group(&b).unwrap().unwrap();
        assert_eq!(ga.group_id, gb.group_id);
        assert_eq!(ga.group_key, gb.group_key);
        assert_eq!(ga.epoch, gb.epoch);
    }

    /// Each side ends up knowing about the other.
    #[test]
    fn both_rosters_name_both_devices() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        let sealed = confirm(&a, &mut pa).unwrap();
        complete(&b, &mut pb, &sealed.sealed_key).unwrap();

        let ra = crate::sync_pair::identity::roster(&a).unwrap();
        let rb = crate::sync_pair::identity::roster(&b).unwrap();
        assert_eq!(ra.len(), 2, "A knows about B");
        assert_eq!(rb.len(), 2, "B knows about A");
    }

    /// A third device that intercepts and re-offers gets a *different* six digits at each end.
    /// This is the man-in-the-middle run end to end rather than at the crypto layer, and it is
    /// genuinely three-party: M begins its own offer to B while accepting A's.
    #[test]
    fn a_relay_in_the_middle_makes_the_two_codes_disagree() {
        let a = db();
        let m = db();
        let b = db();
        let (mut pa, mut pm_join, mut pm_offer, mut pb) = (None, None, None, None);

        // A offers. M accepts it, so A ends up computing digits against M's key.
        let a_offer = begin(&a, &mut pa).unwrap();
        let m_accepts_a = accept(&m, &mut pm_join, &a_offer.code).unwrap();
        let a_sees = respond(&a, &mut pa, &m_accepts_a.response).unwrap();

        // M makes its own offer to B, so B computes digits against M's key too.
        let m_offer = begin(&m, &mut pm_offer).unwrap();
        let b_sees = accept(&b, &mut pb, &m_offer.code).unwrap();

        assert_ne!(
            a_sees.sas, b_sees.sas,
            "if these matched, a relay could join the group and §7.5 step 3 would be theatre"
        );
    }

    /// The token is one-time. A second acceptance of the same offer must be refused.
    #[test]
    fn an_offer_cannot_be_accepted_twice() {
        let a = db();
        let b = db();
        let c = db();
        let (mut pa, mut pb, mut pc) = (None, None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        confirm(&a, &mut pa).unwrap();

        // The offer is spent; C arrives with the same code.
        let acc_c = accept(&c, &mut pc, &offer.code).unwrap();
        assert!(
            respond(&a, &mut pa, &acc_c.response).is_err(),
            "a spent offer must not accept a second joiner"
        );
    }

    /// Confirming before the two sides have exchanged keys is a state that cannot produce a
    /// key, and it must say so rather than sealing to nothing.
    #[test]
    fn confirm_before_respond_is_refused() {
        let a = db();
        let mut pa = None;
        begin(&a, &mut pa).unwrap();
        assert!(confirm(&a, &mut pa).is_err());
    }

    /// A tampered sealed key is refused, and B stays unpaired rather than half-paired.
    #[test]
    fn a_tampered_sealed_key_leaves_b_unpaired() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        let sealed = confirm(&a, &mut pa).unwrap();

        let mut bent = sealed.sealed_key.clone();
        let last = bent.len() - 1;
        // The blob is base32 over the wire; bend one character of it.
        bent.replace_range(last..,  if bent.ends_with('Z') { "Y" } else { "Z" });

        assert!(complete(&b, &mut pb, &bent).is_err());
        assert!(
            crate::sync_pair::identity::group(&b).unwrap().is_none(),
            "B must be unpaired, not half-paired"
        );
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod pairing;` to `sync_pair/mod.rs` first, then:
Run: `cd src-tauri && cargo test sync_pair::pairing 2>&1 | tail -20`
Expected: compile error — `cannot find function begin in this scope`.

- [ ] **Step 3: Write the implementation**

```rust
//! The pairing state machine, and the eight commands the webview presses.
//!
//! **The pending offer lives in memory and never in SQLite**, which is what makes the token
//! one-time in fact rather than by convention: an offer that survived a restart would be an
//! invite a reader printed last month still being accepted today. It has to outlive a page
//! reload, because a reader may open Settings twice, and `AppState` is exactly that lifetime.
//!
//! Every blob that crosses a screen is base32 through [`super::invite`]'s alphabet — the same
//! reason the invite is: a reader may have to type it.

use crate::sync_pair::crypto::{self, CryptoError};
use crate::sync_pair::identity::{self, Identity};
use crate::sync_pair::invite::{Invite, InviteError, QrMatrix};
use rusqlite::Connection;
use serde::Serialize;

/// A pairing in flight, on either side. One at a time per device: a second `begin` replaces the
/// first, which is what a reader who pressed the button twice means.
pub struct Pending {
    /// True on the device that displayed the code.
    initiator: bool,
    group_id: [u8; 16],
    token: [u8; 16],
    /// Filled once the other side's public key has arrived.
    peer_public: Option<[u8; 32]>,
    peer_device_id: Option<String>,
    peer_name: Option<String>,
    pair_key: Option<[u8; 32]>,
    /// Set by `confirm` on the initiator, so a spent offer cannot serve a second joiner.
    spent: bool,
}

/// What the reader is shown when a pairing starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub code: String,
    pub qr: QrMatrix,
}

/// What each side gets once it knows the other's key: six digits to compare, and a blob to
/// carry back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub sas: String,
    /// Empty on the initiator's side — A has nothing further to hand B until Confirm.
    pub response: String,
}

/// The wrapped group key, for the reader to carry to the joining device.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedKey {
    pub sealed_key: String,
}

/// What Settings draws when nothing is in flight.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub device_id: String,
    pub device_name: String,
    pub group_id: Option<String>,
    pub epoch: Option<i64>,
    pub devices: Vec<identity::Device>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Start an offer. Mints a token, replaces any offer already in flight.
pub fn begin(conn: &Connection, pending: &mut Option<Pending>) -> Result<Offer, String> {
    let me = identity::ensure(conn).map_err(err)?;
    // A device already in a group invites into *that* group; a device in none mints the id now
    // and only writes it at Confirm, so a cancelled pairing leaves nothing behind.
    let group_id = match identity::group(conn).map_err(err)? {
        Some(g) => from_hex16(&g.group_id).ok_or("that group id is unreadable")?,
        None => crypto::random_bytes::<16>(),
    };
    let token = crypto::random_bytes::<16>();

    let inv = Invite {
        group_id,
        public_key: me.keypair.public,
        token,
    };
    let code = inv.encode();
    let qr = crate::sync_pair::invite::qr_matrix(&code).map_err(err)?;

    *pending = Some(Pending {
        initiator: true,
        group_id,
        token,
        peer_public: None,
        peer_device_id: None,
        peer_name: None,
        pair_key: None,
        spent: false,
    });
    Ok(Offer { code, qr })
}

/// The joining device reads the code, does the ECDH, and produces both the six digits and the
/// blob the initiator needs.
pub fn accept(
    conn: &Connection,
    pending: &mut Option<Pending>,
    code: &str,
) -> Result<Handshake, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let inv = Invite::decode(code).map_err(|e: InviteError| err(e))?;
    let pair_key = crypto::pair_key(&me.keypair.secret, &inv.public_key, &inv.group_id, &inv.token);
    let sas = crypto::sas(&pair_key, &inv.public_key, &me.keypair.public);

    // The response carries B's key and name, sealed under the pair key. Sealed rather than
    // plain so that a relay cannot swap the *name* either — a device the reader accepted under
    // one name and that appears under another is a lie the roster would repeat forever.
    let mut plain = Vec::new();
    plain.extend_from_slice(&me.keypair.public);
    plain.extend_from_slice(me.device_id.as_bytes());
    plain.push(0);
    plain.extend_from_slice(me.name.as_bytes());
    let sealed = crypto::seal(&pair_key, inv.group_id.as_slice(), &plain).map_err(err)?;

    *pending = Some(Pending {
        initiator: false,
        group_id: inv.group_id,
        token: inv.token,
        peer_public: Some(inv.public_key),
        peer_device_id: None,
        peer_name: None,
        pair_key: Some(pair_key),
        spent: false,
    });
    Ok(Handshake {
        sas,
        response: blob_encode(&sealed),
    })
}

/// The initiator reads the joiner's blob, derives the same key, and shows the same six digits.
pub fn respond(
    conn: &Connection,
    pending: &mut Option<Pending>,
    response: &str,
) -> Result<Handshake, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_mut().ok_or("There is no pairing in progress.")?;
    if !p.initiator {
        return Err("This device is joining a group, not offering one.".to_owned());
    }
    if p.spent {
        return Err("That pairing code has already been used.".to_owned());
    }

    let sealed = blob_decode(response)?;
    // The peer's key is not known yet, so the pair key cannot be derived before the blob is
    // parsed — which is why the first 32 bytes of the *plaintext* are the key and the blob is
    // opened with a key derived from them. Read them out of the sealed bytes' own prefix?  No:
    // do it the other way round. The joiner's public key travels in the clear ahead of the
    // sealed remainder, and the seal is what proves it belongs to the same handshake.
    if sealed.len() <= 32 {
        return Err("That response is not a pairing response.".to_owned());
    }
    let mut peer_public = [0u8; 32];
    peer_public.copy_from_slice(&sealed[..32]);
    let pair_key = crypto::pair_key(&me.keypair.secret, &peer_public, &p.group_id, &p.token);
    let plain = crypto::open(&pair_key, p.group_id.as_slice(), &sealed[32..])
        .map_err(|e: CryptoError| err(e))?;

    // `<32-byte key><device id>\0<name>`
    if plain.len() <= 32 {
        return Err("That response is not a pairing response.".to_owned());
    }
    if plain[..32] != peer_public {
        return Err("That response does not match the key it was sent with.".to_owned());
    }
    let rest = &plain[32..];
    let split = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
    let device_id = String::from_utf8_lossy(&rest[..split]).into_owned();
    let name = if split + 1 < rest.len() {
        String::from_utf8_lossy(&rest[split + 1..]).into_owned()
    } else {
        "Paired device".to_owned()
    };

    p.peer_public = Some(peer_public);
    p.peer_device_id = Some(device_id);
    p.peer_name = Some(name);
    p.pair_key = Some(pair_key);

    Ok(Handshake {
        sas: crypto::sas(&pair_key, &me.keypair.public, &peer_public),
        response: String::new(),
    })
}

/// The initiator confirms the digits matched: the group is created if needed, the joiner goes on
/// the roster, and the group key is sealed for it to carry.
pub fn confirm(conn: &Connection, pending: &mut Option<Pending>) -> Result<SealedKey, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_mut().ok_or("There is no pairing in progress.")?;
    let (Some(pair_key), Some(peer_public), Some(peer_id)) =
        (p.pair_key, p.peer_public, p.peer_device_id.clone())
    else {
        return Err("The other device has not answered yet.".to_owned());
    };
    if p.spent {
        return Err("That pairing code has already been used.".to_owned());
    }

    let group = identity::create_group(conn, &me).map_err(err)?;
    identity::add_device(
        conn,
        &peer_id,
        &peer_public,
        p.peer_name.as_deref().unwrap_or("Paired device"),
    )
    .map_err(err)?;

    // `<group_id>\0<epoch>\0<32-byte key>` — the id and the epoch travel with the key because a
    // key with no epoch cannot be compared against a later rotation.
    let mut plain = Vec::new();
    plain.extend_from_slice(group.group_id.as_bytes());
    plain.push(0);
    plain.extend_from_slice(group.epoch.to_string().as_bytes());
    plain.push(0);
    plain.extend_from_slice(&group.group_key);

    let sealed = crypto::seal(&pair_key, me.device_id.as_bytes(), &plain).map_err(err)?;
    p.spent = true;
    Ok(SealedKey {
        sealed_key: blob_encode(&sealed),
    })
}

/// The joiner unwraps the group key and is in the group.
pub fn complete(
    conn: &Connection,
    pending: &mut Option<Pending>,
    sealed_key: &str,
) -> Result<(), String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_ref().ok_or("There is no pairing in progress.")?;
    let (Some(pair_key), Some(peer_public)) = (p.pair_key, p.peer_public) else {
        return Err("This device has not read a pairing code yet.".to_owned());
    };

    let sealed = blob_decode(sealed_key)?;
    // The AAD is the *initiator's* device id, which the joiner does not know yet — so it is
    // carried in the clear ahead of the sealed bytes, exactly as the joiner's key was.
    let split = sealed
        .iter()
        .position(|b| *b == 0)
        .ok_or("That is not a pairing key.")?;
    let peer_id = String::from_utf8_lossy(&sealed[..split]).into_owned();
    let plain = crypto::open(&pair_key, peer_id.as_bytes(), &sealed[split + 1..])
        .map_err(|e: CryptoError| err(e))?;

    let mut parts = plain.splitn(3, |b| *b == 0);
    let group_id = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
    let epoch: i64 = String::from_utf8_lossy(parts.next().unwrap_or_default())
        .parse()
        .map_err(|_| "That pairing key is unreadable.")?;
    let key_bytes = parts.next().ok_or("That pairing key is unreadable.")?;
    if key_bytes.len() != 32 {
        return Err("That pairing key is unreadable.".to_owned());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(key_bytes);

    identity::join_group(conn, &group_id, epoch, &key, &me).map_err(err)?;
    identity::add_device(
        conn,
        &peer_id,
        &peer_public,
        p.peer_name.as_deref().unwrap_or("Paired device"),
    )
    .map_err(err)?;
    Ok(())
}

/// Read the whole panel's state in one go.
pub fn status(conn: &Connection) -> Result<PairingStatus, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let g = identity::group(conn).map_err(err)?;
    Ok(PairingStatus {
        device_id: me.device_id,
        device_name: me.name,
        group_id: g.as_ref().map(|g| g.group_id.clone()),
        epoch: g.as_ref().map(|g| g.epoch),
        devices: identity::roster(conn).map_err(err)?,
    })
}

/// Base32 over the same alphabet the invite uses, for the two blobs a reader may have to carry
/// by hand. No checksum: these are pasted rather than typed, and a bent one already fails at
/// the AEAD with a sentence of its own.
fn blob_encode(bytes: &[u8]) -> String {
    crate::sync_pair::invite::blob_encode(bytes)
}

fn blob_decode(text: &str) -> Result<Vec<u8>, String> {
    crate::sync_pair::invite::blob_decode(text).map_err(err)
}

fn from_hex16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}
```

**`invite.rs` gains the two helpers `pairing` calls** — they belong beside the alphabet they use:

```rust
/// Base32 for a variable-length blob, over the invite's own alphabet.
///
/// No checksum and no grouping: these blobs are pasted rather than typed, and a bent one
/// already fails at the AEAD with a sentence of its own. The length is carried by the
/// encoding itself — the tail's zero padding is dropped by the decoder's bit accounting.
pub fn blob_encode(bytes: &[u8]) -> String {
    base32_encode(bytes)
}

pub fn blob_decode(text: &str) -> Result<Vec<u8>, InviteError> {
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect();
    let mut out = Vec::with_capacity(cleaned.len() * 5 / 8);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in cleaned.bytes() {
        let v = ALPHABET
            .iter()
            .position(|a| *a == c)
            .ok_or(InviteError::Alphabet)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}
```

- [ ] **Step 4: Add the `AppState` field and the eight commands**

In `src-tauri/src/sync.rs`, on `AppState`:

```rust
    /// A pairing in flight, if there is one.
    ///
    /// **In memory rather than in the database, deliberately**, and it is the same argument
    /// `mirror_status` makes one field up: an offer that survived a restart would be an invite
    /// a reader printed last month still being accepted today. It outlives the webview, which
    /// is what a reader who opens Settings twice needs, and dies with the process, which is
    /// what makes the token one-time in fact.
    pub pairing: Mutex<Option<crate::sync_pair::pairing::Pending>>,
```

Initialise it as `Mutex::new(None)` wherever `AppState` is constructed (`lib.rs`'s `init_state`, plus each test helper that builds one — `cargo check` names them all).

In `src-tauri/src/lib.rs`, eight commands. Each takes the write connection through `sync::with_write`, so a sync in flight answers `BUSY` like every other write here:

```rust
/// What Settings draws: this device, the group it is in, and the roster.
#[tauri::command]
async fn sync_pairing_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<sync_pair::pairing::PairingStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, sync_pair::pairing::status)
    })
    .await
    .map_err(|e| format!("could not read the pairing status: {e}"))?
}

/// Start offering a pairing. Replaces any offer already in flight.
#[tauri::command]
async fn sync_pairing_begin(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<sync_pair::pairing::Offer, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = crate::db::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| {
            sync_pair::pairing::begin(conn, &mut pending)
        })
    })
    .await
    .map_err(|e| format!("could not start pairing: {e}"))?
}
```

`sync_pairing_accept(code: String)`, `sync_pairing_respond(response: String)`, `sync_pairing_confirm()`, `sync_pairing_complete(sealedKey: String)`, `sync_pairing_cancel()` (clears the pending slot), `sync_device_rename(deviceId: String, name: String)` and `sync_device_revoke(deviceId: String)` follow the same shape.

> ⚠️ **`with_write` must not be called while holding a guard on `state.db`.** It is a bounded `try_lock` loop, so a reentrant call spends the whole `WRITE_LOCK_WAIT` failing against its own thread and then answers `BUSY` against itself. The `state.pairing` guard is a *different* mutex and is safe to hold across it — take it first, as above.

Register all eight in `generate_handler!`, grouped after the `mirror::` block.

- [ ] **Step 5: Mirror the DTOs in `ipc.ts`**

In `src/lib/ipc.ts`, add to the "Sources, verified field by field" list:

```
 * `PairingStatus`/`Offer`/`Handshake`/`SealedKey`/`QrMatrix`/
 * `Device`                                       — `src-tauri/src/sync_pair/pairing.rs`
 *                                                  and `.../identity.rs`, `.../invite.rs`
```

and the types plus the eight methods:

```ts
/**
 * A QR code as a grid, row-major, `width * width` long. `true` is a dark module.
 *
 * **A fact rather than a picture, which is why it crosses the boundary in this shape.** Rust
 * answers what the encoder produced; this side decides the colour, the module size and the
 * quiet zone, because all three are questions about a screen.
 */
export interface QrMatrix {
  width: number;
  modules: boolean[];
}

/** One device on the pairing roster. The public key is deliberately not sent. */
export interface PairedDevice {
  deviceId: string;
  name: string;
  addedAt: number;
  /** A stamp means this device was removed. The row is kept so the panel can say when. */
  revokedAt: number | null;
}

/** What Settings draws when no pairing is in flight. `groupId` is null on an unpaired device. */
export interface PairingStatus {
  deviceId: string;
  deviceName: string;
  groupId: string | null;
  epoch: number | null;
  devices: PairedDevice[];
}

/** The invite, in both forms. */
export interface PairingOffer {
  code: string;
  qr: QrMatrix;
}

/**
 * The six digits to compare, and the blob to carry back.
 *
 * `response` is empty on the offering device — A has nothing further to hand B until Confirm.
 * **The digits are what the reader compares and the whole of what defeats a man in the middle**
 * (spec §7.5 step 3), so the panel must never auto-advance past them.
 */
export interface PairingHandshake {
  sas: string;
  response: string;
}

/** The wrapped group key, for the reader to carry to the joining device. */
export interface PairingSealedKey {
  sealedKey: string;
}
```

```ts
  /** This device, the group it is in, and the roster. */
  syncPairingStatus: () => invoke<PairingStatus>("sync_pairing_status"),
  /** Start offering a pairing. Replaces any offer already in flight. */
  syncPairingBegin: () => invoke<PairingOffer>("sync_pairing_begin"),
  /** Read an offer on the joining device. Answers the six digits and a blob to carry back. */
  syncPairingAccept: (code: string) => invoke<PairingHandshake>("sync_pairing_accept", { code }),
  /** Read the joiner's blob on the offering device. Answers the same six digits. */
  syncPairingRespond: (response: string) =>
    invoke<PairingHandshake>("sync_pairing_respond", { response }),
  /** The reader says the digits matched. Answers the sealed group key. */
  syncPairingConfirm: () => invoke<PairingSealedKey>("sync_pairing_confirm"),
  /** The joining device unwraps the key and is in the group. */
  syncPairingComplete: (sealedKey: string) =>
    invoke<void>("sync_pairing_complete", { sealedKey }),
  /** Throw away whatever is in flight. */
  syncPairingCancel: () => invoke<void>("sync_pairing_cancel"),
  syncDeviceRename: (deviceId: string, name: string) =>
    invoke<void>("sync_device_rename", { deviceId, name }),
  /**
   * Remove a device and rotate the group key.
   *
   * **The rotation is the removal** — see §7.6. What it cannot do is reach the removed device:
   * whatever that device already synced, it keeps, and no server can take it back. The panel
   * says so in those words rather than implying a lost phone has been cleaned.
   */
  syncDeviceRevoke: (deviceId: string) => invoke<void>("sync_device_revoke", { deviceId }),
```

Add the argument-name pins to `src/lib/ipc.test.ts` beside the existing ones — `code`, `response`, `sealedKey`, `deviceId`, `name`. **`invoke` matches arguments by name and a typo is a runtime rejection**, which is the whole reason that file exists.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test sync_pair:: 2>&1 | tail -12
npm run test:run -- src/lib/ipc.test.ts 2>&1 | tail -12
```
Expected: 6 new Rust tests green (23 in `sync_pair::` in total), and the ipc pins green.

- [ ] **Step 7: Mutate to prove the man-in-the-middle test bites**

In `respond`, change the SAS argument order to `crypto::sas(&pair_key, &peer_public, &me.keypair.public)` — the joiner's ordering used on the initiator's side. `two_databases_pair_and_agree_on_the_key` must FAIL on `the two readers must be shown the same six digits`. Revert.

Then, in `confirm`, remove the `p.spent = true;` line. `an_offer_cannot_be_accepted_twice` must FAIL. Revert.

**Stop and report if either survives.** The second is the quieter one: a token that is one-time only in the documentation is a token that is not one-time.

- [ ] **Step 8: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_pair/ src-tauri/src/sync.rs src-tauri/src/lib.rs src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(sync): the pairing state machine and its eight commands

The tests drive two independent in-memory databases against each other and assert both end
up holding the same group key - and a third test runs a real three-party interception, where
a middle device accepts A's offer and makes its own to B, and asserts the two six-digit
codes DISAGREE. If they matched, a relay could join the group and §7.5 step 3 would be
theatre.

The pending offer lives in AppState and never in SQLite. An offer that survived a restart
would be an invite a reader printed last month still being accepted today; this one outlives
the webview, which is what a reader who opens Settings twice needs, and dies with the
process, which is what makes the token one-time in fact rather than in the documentation."
```

---

### Task 6: `SyncPanel` — the panel, and the sentence about a removed device

**Files:**
- Create: `src/features/settings/SyncPanel.tsx`
- Create: `src/features/settings/SyncPanel.test.tsx`
- Create: `src/features/settings/SyncPanel.stories.tsx`
- Create: `src/features/settings/QrCode.tsx`
- Modify: `src/features/settings/SettingsPage.tsx` — one `<SyncPanel />`
- Modify: `.storybook/fake/db.ts` — the fake's answers for the eight commands

**Interfaces:**
- Consumes: `ipc.syncPairing*`, `ipc.syncDevice*` from Task 5.
- Produces: `SyncPanel`, `QrCode`.

> **Before writing any of this, follow `src/CLAUDE.md`:** invoke the `frontend-design` skill, and use the `mtg-grimoire-sb-mcp` tools (`get-storybook-story-instructions`, `list-all-documentation`, `get-documentation`) rather than reading component sources. **Never use a prop that is not in the documentation.** `SettingsSection`, `PanelAlert` from `./panelChrome` and `BUTTON`, `SWITCH`, `switchTone` from `./controls` are the panel chrome every sibling uses.

> **The one sentence that is not negotiable.** §7.6: *"It cannot be un-told what it already knows."* The removal confirmation must say, in the reader's words, that the removed device keeps whatever it already synced, that no server can reach into it, and that rotating the key stops it reading anything **new**. A dialog that says "Remove" and nothing else is a dialog that implies a lost phone has been wiped.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SyncPanel } from "./SyncPanel";

const unpaired = {
  deviceId: "aa".repeat(16),
  deviceName: "This device",
  groupId: null,
  epoch: null,
  devices: [],
};

const paired = {
  deviceId: "aa".repeat(16),
  deviceName: "Desk",
  groupId: "bb".repeat(16),
  epoch: 2,
  devices: [
    { deviceId: "aa".repeat(16), name: "Desk", addedAt: 1, revokedAt: null },
    { deviceId: "cc".repeat(16), name: "Phone", addedAt: 2, revokedAt: null },
    { deviceId: "dd".repeat(16), name: "Old laptop", addedAt: 3, revokedAt: 99 },
  ],
};

describe("SyncPanel", () => {
  it("offers to pair when this device is in no group", async () => {
    render(<SyncPanel status={unpaired} />);
    expect(await screen.findByRole("button", { name: /pair a device/i })).toBeInTheDocument();
  });

  it("lists the group's devices, and marks a removed one as removed", async () => {
    render(<SyncPanel status={paired} />);
    expect(await screen.findByText("Phone")).toBeInTheDocument();
    // A greyed row's accessible name carries its reason, so match loosely.
    expect(screen.getByText(/old laptop/i)).toBeInTheDocument();
    expect(screen.getByText(/removed/i)).toBeInTheDocument();
  });

  /**
   * The six digits are the whole security argument. They must be *shown*, and the confirm
   * button must not be pressable before they are — a panel that let a reader confirm a code
   * they had not seen would be a panel with no man-in-the-middle defence at all.
   */
  it("shows the six digits and refuses to confirm before they exist", async () => {
    const user = userEvent.setup();
    const begin = vi.fn().mockResolvedValue({ code: "ABCDE-FGHJK", qr: { width: 21, modules: Array(441).fill(false) } });
    render(<SyncPanel status={unpaired} onBegin={begin} />);

    await user.click(screen.getByRole("button", { name: /pair a device/i }));
    const confirm = await screen.findByRole("button", { name: /codes match/i });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
  });

  /**
   * §7.6, in the reader's own words. A removal dialog that does not say this implies a lost
   * phone has been wiped, which is the opposite of what happens.
   */
  it("says what removing a device cannot do", async () => {
    const user = userEvent.setup();
    render(<SyncPanel status={paired} />);
    await user.click(screen.getByRole("button", { name: /remove.*phone/i }));
    expect(
      await screen.findByText(/keeps? (whatever|what) it (has )?already/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot/i)).toBeInTheDocument();
  });

  /** A matrix of `width * width` booleans draws `width * width` cells. */
  it("draws every module of the matrix", async () => {
    const modules = Array.from({ length: 441 }, (_, i) => i % 3 === 0);
    const begin = vi.fn().mockResolvedValue({ code: "X", qr: { width: 21, modules } });
    const user = userEvent.setup();
    render(<SyncPanel status={unpaired} onBegin={begin} />);
    await user.click(screen.getByRole("button", { name: /pair a device/i }));
    const svg = await screen.findByTestId("pairing-qr");
    expect(svg.querySelectorAll("rect")).toHaveLength(modules.filter(Boolean).length);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/features/settings/SyncPanel.test.tsx 2>&1 | tail -20`
Expected: `Failed to resolve import "./SyncPanel"`.

- [ ] **Step 3: Write `QrCode.tsx`**

```tsx
/**
 * A QR matrix, drawn.
 *
 * Rust answers `{ width, modules }` and nothing about a screen; this decides the module size,
 * the quiet zone and the colours — which is the same boundary `combos_for_cards` draws one
 * feature over, applied to a picture.
 *
 * **One `<rect>` per dark module and none per light one.** A 21×21 code is 441 cells and a
 * version-6 one is 1 681; drawing both colours would double the node count for a background
 * `fill` already answers. The quiet zone is four modules, which is the spec's own minimum and
 * the difference between a code a phone reads instantly and one it hunts for.
 */
export function QrCode({ matrix, label }: { matrix: QrMatrix; label: string }) {
  const quiet = 4;
  const side = matrix.width + quiet * 2;
  return (
    <svg
      data-testid="pairing-qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${side} ${side}`}
      className="h-56 w-56 rounded bg-white p-1"
      shapeRendering="crispEdges"
    >
      {matrix.modules.map((dark, i) =>
        dark ? (
          <rect
            key={i}
            x={(i % matrix.width) + quiet}
            y={Math.floor(i / matrix.width) + quiet}
            width={1}
            height={1}
            fill="#000"
          />
        ) : null,
      )}
    </svg>
  );
}
```

> ⚠️ **`bg-white` and `fill="#000"` are literal and stay literal.** This is the one surface in the app that must not follow the theme: a QR code inverted by dark mode is a QR code no camera reads. Say so in the component's doc comment rather than letting a later theme pass "fix" it.

- [ ] **Step 4: Write `SyncPanel.tsx`**

Follow the `CombosPanel` shape: `useQuery` on `["sync", "status"]`, `useMutation` per press, `SettingsSection` for the frame, `PanelAlert` for the failure line, and a `ConfirmDialog` for the removal. Three states — **not paired**, **pairing in flight**, **paired** — and the in-flight state is a small stepper: *show the code* → *paste their answer* → **compare six digits** → *hand over the key*.

The removal dialog's body, verbatim:

```tsx
/**
 * §7.6, in the reader's words.
 *
 * **This wording is load-bearing and not copy.** Rotating the key stops the removed device
 * reading anything new; it cannot reach into that device and take back what it already has, and
 * no server anywhere can. A dialog that said only "Remove" would imply a lost phone had been
 * wiped, which is the opposite of what happens.
 */
const REMOVAL_WARNING =
  "Removing a device changes the key your devices share, so it can read nothing new from now on. " +
  "It keeps whatever it already synced — nothing here can reach into it and take that back, and " +
  "no server has a copy to delete.";
```

- [ ] **Step 5: Wire it into the page and the fake**

One `<SyncPanel />` in `SettingsPage.tsx`, above `<ErrorLogPanel />`. In `.storybook/fake/db.ts`, answer all eight commands: an unpaired device by default, a `paired` seed, and a `pairing-fails` fault. Follow `.storybook/CLAUDE.md`.

- [ ] **Step 6: Run the tests, and photograph it**

```bash
npm run test:run -- src/features/settings/SyncPanel.test.tsx 2>&1 | tail -12
npm run lint
```

Then **call `preview-stories` from the `mtg-grimoire-sb-mcp` tools and put every returned URL in your report** — `src/CLAUDE.md` requires it for anything that changes how the UI looks.

- [ ] **Step 7: Mutate to prove the security test bites**

Remove the `aria-disabled` guard from the *Codes match* button so it is pressable before the digits arrive. `shows the six digits and refuses to confirm before they exist` must FAIL. Revert.

**Stop and report if it survives** — a confirm button that is live before the code is shown is a panel with no man-in-the-middle defence, and it would look completely normal.

- [ ] **Step 8: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src/features/settings/SyncPanel.tsx src/features/settings/SyncPanel.test.tsx src/features/settings/SyncPanel.stories.tsx src/features/settings/QrCode.tsx src/features/settings/SettingsPage.tsx .storybook/fake/db.ts
git commit -m "feat(settings): the pairing panel, and the sentence a removal owes

The six digits are the whole man-in-the-middle defence, so the Codes match button carries
aria-disabled until they exist and a test asserts it - a confirm button that is live before
the code is shown looks completely normal and defends nothing.

The removal dialog says what §7.6 says: rotating the key stops the removed device reading
anything new, and nothing here can reach into it and take back what it already has. A dialog
that said only Remove would imply a lost phone had been wiped.

The QR is drawn from a matrix of booleans Rust answered, one rect per dark module. Its white
ground and black modules are literal and stay literal: a QR code inverted by dark mode is a
QR code no camera reads."
```

---

### Task 7: The record — `docs/reference/sync.md`, and the rows the ladder owes

**Files:**
- Create: `docs/reference/sync.md`
- Modify: `CLAUDE.md` — one row in the reference-docs table
- Modify: `src-tauri/CLAUDE.md` — the schema-ladder line, and a "Hard rules — pairing" section
- Modify: `docs/reference/data-and-sync.md` — the v27 rung

- [ ] **Step 1: Write `docs/reference/sync.md`**

It holds, with the date and the build every measurement was taken on:

- **The protocol, step by step**, and which side holds what at each step — the table from Task 5.
- **Why the typed code is 105 characters**, with the arithmetic: 64 bytes, 5 bits per character, 103 + 2.
- **What the six digits defend against and what they do not.** They defeat a substituted key. They do not defend against a reader who presses *Codes match* without looking, which is why the button is disabled until the code exists and why the panel shows both codes in the same type size.
- **Where the keys live and what that costs.** In `mtg.db`, in the clear; copying the data folder copies the identity; a restore is the device it was, never a new one.
- **§7.6 in full**, including the sentence the dialog uses and why.
- **What PR 7 changes and what it does not**: the second hand-carried blob becomes a relay hop; the crypto, the SAS, the roster and the rotation are untouched.
- **Two things §7.5 asked for that are not here**: the scanner (Phase 4, with the camera) and the relay hop (PR 7).

- [ ] **Step 2: Update the three `CLAUDE.md` neighbours**

In the root `CLAUDE.md` reference table:

```markdown
| [sync.md](docs/reference/sync.md) | Pairing — the protocol step by step, why the typed code is 105 characters, what the six digits do and do not defend, where the keys live, and what revocation cannot do |
```

In `src-tauri/CLAUDE.md`, correct the ladder line — **it currently reads v25 and head is 27 after this rung** — and add:

```markdown
## Hard rules — pairing

- **`sync_identity`, `sync_group` and `sync_devices` never sync.** They are this device's
  secrets. They are `None` in `watch::surface_of` for the sharpest reason on that list: a
  mirrored file quoting any of them would write a key into a folder the reader syncs with
  Dropbox.
- **`identity::ensure` mints on absence and never on a mismatch.** A restored `mtg.db` is the
  device it was. Re-minting on anything that looked wrong turns a restore into a silent fork.
- **Revocation rotates the key in the same transaction that marks the row.** Marking the row
  alone produces an app that says a device is gone while that device can still read every op
  written afterwards.
- **`chacha20poly1305` is pinned at 0.10 and not 0.11**, and the reason is `cargo tree -d`: 0.11
  moves RustCrypto's array types to `hybrid-array`, which stands a second array stack beside the
  `generic-array 0.14` that `sha2 0.10` already puts in this tree.
```

In `docs/reference/data-and-sync.md`, add the v27 rung beside v25 and v26, and **move the "Schema is v26" line to v27 in the same commit** — that line has read the wrong number for two whole rungs at a time, three times, because a prose-only edit routes to neither CI job.

- [ ] **Step 3: Re-count anything you changed**

```bash
grep -c "UNDO_V27" src-tauri/src/schema.rs   # 19
grep -n "Schema is v" docs/reference/data-and-sync.md
grep -n "Schema is at" src-tauri/CLAUDE.md
```

- [ ] **Step 4: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add docs/reference/sync.md CLAUDE.md src-tauri/CLAUDE.md docs/reference/data-and-sync.md
git commit -m "docs(sync): the pairing record, and the ladder line corrected to v27

Both CLAUDE.md ladder lines were behind - src-tauri's read v25 against a head of 26 before
this rung. A prose-only edit routes to neither CI job, so nothing goes red when one rots, and
this is the third time that line has been two rungs stale."
```

---

## Self-Review

**Spec coverage.** This plan implements §7.5 in full — the X25519 keypair on first run, the QR and typed-code invite carrying a group id, a public key and a one-time token, the ECDH, the six-digit SAS both readers compare, and the group key wrapped to the joining device — and §7.6 in full: rotation on revocation, the removed device kept on the roster, and the UI saying in the reader's own words what a removal cannot do. It does **not** implement §7.5's *"sends it through the relay"*: PR 7 does, and this plan carries that hop by hand instead, which is stated at the top rather than left to be discovered.

**Placeholders.** None. Every step carries the code it needs; no step says "similar to Task N".

**Type consistency.** `Keypair { secret: [u8; 32], public: [u8; 32] }` is produced by `crypto::keypair` in Task 2 and consumed by `identity::ensure` in Task 4 and by `pairing::begin` in Task 5. `crypto::pair_key(&[u8;32], &[u8;32], &[u8;16], &[u8;16]) -> [u8;32]` is called with those exact shapes in Tasks 2 and 5. `crypto::seal`/`open` take `(&[u8;32], &[u8], &[u8])` and are used that way in Task 5 both times. `Invite { group_id: [u8;16], public_key: [u8;32], token: [u8;16] }` is what `begin` builds and `accept` decodes. `QrMatrix { width: usize, modules: Vec<bool> }` serialises to `{ width: number, modules: boolean[] }`, which is what `QrCode.tsx` indexes with `i % matrix.width`.

**Five things were checked against the source rather than assumed:**

- **`schema::SCHEMA_VERSION` is 26, not 25.** `src-tauri/CLAUDE.md` says v25 and `docs/reference/data-and-sync.md` says v26; the constant is the answer and Task 7 corrects the prose.
- **`UNDO_V26` has exactly 17 uses** inside `format!` strings in `schema.rs`'s test module, plus its definition and one doc reference. Task 1 Step 4 pins that number as a `grep -c` on both sides of the edit, because a missed rewind fixture is a test that walks up through a rung it never undid.
- **`watch::tests::every_table_in_the_schema_has_been_decided_about` asserts the `ignored` array by name and in `ORDER BY name` order**, so the three new tables go between `sets` and `sync_meta` and nowhere else. The count-only version of that test could not fail and was replaced for exactly this reason.
- **`errors::Source` is CHECK-constrained in SQL** (`'scryfall_api','scryfall_image','github_update','database','image_store'`) and mirrored as a closed union in `ipc.ts` with a total `Record<ErrorSource, string>` label map. **This PR adds no new source** — nothing here touches the network — so no `error_log` rung is owed. PR 7 owes one.
- **`x25519-dalek` is at 3.0** and its `getrandom` feature is what supplies `StaticSecret::random()`, so this crate never holds an RNG of its own. `chacha20poly1305 0.11` exists and is not used, for the `cargo tree -d` reason.

**Two things this plan decides that §7.5 leaves open, both flagged at the top rather than buried:** there is no scanner (no camera permission exists in this app, and Phase 4 is where one arrives), and the typed code is 105 characters because the public key is irreducible.
