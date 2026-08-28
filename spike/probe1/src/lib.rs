//! Probe 1: does `rusqlite` work on `wasm32-unknown-unknown` over `sqlite-wasm-rs`?
//!
//! Every step reports separately, because the interesting outcomes are not "it worked"
//! and "it didn't" but *which* step died. Two are predicted to be dangerous:
//!
//! * `sqlite3_threadsafe()` returns 0 — the amalgamation is built `-DSQLITE_THREADSAFE=0`
//!   — and rusqlite has an `Error::SqliteSingleThreadedMode` it can raise on open.
//! * `-DSQLITE_OS_OTHER` means there is no default VFS, so an open can fail for a reason
//!   that has nothing to do with the path.
//!
//! FTS5 is compiled in (`-DSQLITE_ENABLE_FTS5` in the crate's build.rs), so the FTS step
//! is a confirmation rather than a question — but it is the one the app cannot do without,
//! so it gets asserted rather than assumed.

use wasm_bindgen::prelude::*;

fn line(out: &mut String, step: &str, ok: bool, detail: &str) {
    out.push_str(if ok { "PASS " } else { "FAIL " });
    out.push_str(step);
    out.push_str("  |  ");
    out.push_str(detail);
    out.push('\n');
}

/// Runs the probe and returns a plain-text report. Never panics out to JS: a panic here
/// would be reported as a generic wasm trap and lose the step that caused it.
#[wasm_bindgen]
pub fn run() -> String {
    console_error_panic_hook::set_once();
    let mut out = String::new();

    // --- Step 1: the C is linked and answers at all. -------------------------------
    let threadsafe = unsafe { rusqlite::ffi::sqlite3_threadsafe() };
    line(
        &mut out,
        "link/sqlite3_threadsafe",
        true,
        &format!("returns {threadsafe} (0 = SQLITE_THREADSAFE=0, as built)"),
    );

    let version = unsafe {
        let p = rusqlite::ffi::sqlite3_libversion();
        std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned()
    };
    line(&mut out, "link/sqlite3_libversion", true, &version);

    // --- Step 2: rusqlite opens a connection. --------------------------------------
    // The predicted failure. rusqlite guards on the threading mode; if that guard runs
    // against a THREADSAFE=0 build it refuses here and the whole approach is dead.
    let conn = match rusqlite::Connection::open("probe1.db") {
        Ok(c) => {
            line(&mut out, "rusqlite/Connection::open", true, "opened");
            c
        }
        Err(e) => {
            line(
                &mut out,
                "rusqlite/Connection::open",
                false,
                &format!("{e:?} — this is the kill condition if it names the threading mode"),
            );
            return out;
        }
    };

    // --- Step 3: ordinary SQL through rusqlite's own API. --------------------------
    match conn.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0)) {
        Ok(v) => line(&mut out, "rusqlite/query_row", true, &v),
        Err(e) => line(&mut out, "rusqlite/query_row", false, &format!("{e:?}")),
    }

    // --- Step 4: FTS5, which `cards_fts` cannot do without. ------------------------
    let fts = (|| -> rusqlite::Result<usize> {
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(name, oracle_text);
             INSERT INTO t VALUES ('Lightning Bolt', 'deals 3 damage to any target');
             INSERT INTO t VALUES ('Shock', 'deals 2 damage to any target');
             INSERT INTO t VALUES ('Llanowar Elves', 'add one green mana');",
        )?;
        conn.query_row("SELECT count(*) FROM t WHERE t MATCH 'damage'", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n as usize)
    })();
    match fts {
        Ok(n) => line(
            &mut out,
            "fts5/create+match",
            n == 2,
            &format!("MATCH 'damage' returned {n} rows (expected 2)"),
        ),
        Err(e) => line(&mut out, "fts5/create+match", false, &format!("{e:?}")),
    }

    // --- Step 5: the compile options, as ground truth. -----------------------------
    // Read rather than recalled: this is what the research doc quotes.
    let opts = (|| -> rusqlite::Result<String> {
        let mut s = conn.prepare("PRAGMA compile_options")?;
        let rows = s.query_map([], |r| r.get::<_, String>(0))?;
        let mut v: Vec<String> = Vec::new();
        for r in rows {
            v.push(r?);
        }
        Ok(v.join(","))
    })();
    match opts {
        Ok(v) => line(&mut out, "pragma/compile_options", true, &v),
        Err(e) => line(&mut out, "pragma/compile_options", false, &format!("{e:?}")),
    }

    // --- Step 6: the update_hook the plain-text mirror is built on. ----------------
    // The mirror itself is desktop-only, but `db.rs` hangs the hook off the one write
    // connection for every target, so if the hook were unavailable on wasm the shape of
    // that module would change everywhere. A static counter rather than a captured cell
    // because rusqlite requires the closure to be `Send`.
    static HOOK_FIRED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    conn.update_hook(Some(|_action, _db: &str, _tbl: &str, _rowid: i64| {
        HOOK_FIRED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }));
    let hook_res = conn.execute_batch(
        "CREATE TABLE hooked (v INTEGER); INSERT INTO hooked VALUES (1);          UPDATE hooked SET v = 2; DELETE FROM hooked WHERE v = 2;",
    );
    let fired = HOOK_FIRED.load(std::sync::atomic::Ordering::Relaxed);
    match hook_res {
        Ok(()) => line(
            &mut out,
            "rusqlite/update_hook",
            fired == 3,
            &format!("hook fired {fired} times (expected 3: insert, update, delete-with-WHERE)"),
        ),
        Err(e) => line(&mut out, "rusqlite/update_hook", false, &format!("{e:?}")),
    }

    out
}
