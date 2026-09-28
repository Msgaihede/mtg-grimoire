//! **Where a test puts a real file: `%TEMP%/mtgtest-run-<pid>/t<thread>/<name>`**, private to
//! one `cargo test` process and, inside it, to one test.
//!
//! `std::env::temp_dir()` is one directory for every worktree and every process on the machine,
//! so the fixed `mtgtest-<name>` paths this replaces were the same path in two runs at once.
//! Observed 2026-09-28: `ingest::tests::a_writer_gets_the_connection_between_batches_of_an_ingest`
//! failed inside an `npm run verify` with `UNIQUE constraint failed: cards_staging.id` — another
//! worktree's run of the same test was ingesting the same card ids into the same `corpus.db` —
//! and passed 6/6 run alone. The process id separates the runs; the thread separates the tests
//! inside one, because libtest gives every test a thread of its own, so a name has to be unique
//! within the test that asks for it and nowhere else.
//!
//! **Nothing is deleted when a test ends. A run's directory is deleted by a later run.** A test
//! binary has no exit hook, a failed test's files are the evidence, and a run killed mid-flight
//! would leak every one of them anyway. So each run holds an exclusive lock on
//! `mtgtest-run-<pid>.lock` beside its directory for as long as the process lives — the OS lets
//! go of it however the process ends — and the first path a run asks for starts a [`sweep`] that
//! deletes every other run whose lock it can take. `%TEMP%` holds the last finished run's
//! scratch, which is what the fixed names held, plus whatever runs are still going.
//!
//! Not `tempfile`: a `TempDir` is deleted when it drops, and most of these directories hold a
//! database that the `AppState` a fixture returns still has open — on Windows that delete fails,
//! and a fixture that returned the guard as well would have to be rewritten at every caller.

use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Every run's directory is this plus its process id, and its lock file that plus `.lock`.
const RUN_PREFIX: &str = "mtgtest-run-";

struct Run {
    root: PathBuf,
    /// Held for the life of the process, and never read: holding it is the whole of its job.
    _lock: File,
}

static RUN: OnceLock<Run> = OnceLock::new();

/// A path of this test's own for a file or directory called `name`. Its parent exists; the path
/// itself is left for the caller to create, or not — several tests are about what happens when
/// it is missing.
pub(crate) fn path(name: &str) -> PathBuf {
    let thread: String = format!("{:?}", std::thread::current().id())
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let dir = run().root.join(format!("t{thread}"));
    std::fs::create_dir_all(&dir).expect("create this test's scratch directory");
    dir.join(name)
}

fn run() -> &'static Run {
    RUN.get_or_init(|| {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path(&base, pid))
            .expect("open this run's scratch lock");
        lock.lock().expect("lock this run's scratch directory");
        // A sweep deletes a directory only while it holds that directory's lock, so none can be
        // inside this one now: anything already here was left by a dead process with this pid.
        let root = root_path(&base, pid);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create this run's scratch directory");
        // Off the test's thread, because the last run's leftovers can be a couple of hundred
        // databases. A process that exits mid-sweep leaves the rest to the next one.
        std::thread::spawn(move || sweep(&base, pid));
        Run { root, _lock: lock }
    })
}

fn root_path(base: &Path, pid: u32) -> PathBuf {
    base.join(format!("{RUN_PREFIX}{pid}"))
}

fn lock_path(base: &Path, pid: u32) -> PathBuf {
    base.join(format!("{RUN_PREFIX}{pid}.lock"))
}

/// Delete every run in `base` but `ours` whose lock nobody holds. Every failure is a skip: a run
/// still going refuses the lock, and a file something still has open fails the delete and leaves
/// the lock file for the next sweep to try again.
///
/// A directory with no lock file beside it is never touched, since there is no asking whether
/// its run has ended. The one way to make one is a sweep that took a run's lock in the instant
/// between that run creating the file and locking it: the run then locks a file that is no longer
/// there and its directory outlives it — a leak, and nothing worse, because the run creates its
/// directory only once it holds the lock.
fn sweep(base: &Path, ours: u32) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix(RUN_PREFIX))
            .and_then(|n| n.strip_suffix(".lock"))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == ours {
            continue;
        }
        let Ok(lock) = OpenOptions::new().read(true).write(true).open(entry.path()) else {
            continue;
        };
        if lock.try_lock().is_err() {
            continue;
        }
        match std::fs::remove_dir_all(root_path(base, pid)) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        // Still holding the lock, so no sweep can be between its own open and try_lock on this
        // file and take a lock on a name that is gone.
        let _ = std::fs::remove_file(entry.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property two concurrent runs depend on: a sweep takes a run that has ended and never
    /// one that is still going — and what tells them apart is the lock, not the process id.
    #[test]
    fn a_sweep_deletes_an_ended_run_and_leaves_a_live_one() {
        let base = path("sweep");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let seed = |pid: u32| {
            let db = root_path(&base, pid).join("t2").join("user.db");
            std::fs::create_dir_all(db.parent().unwrap()).unwrap();
            std::fs::write(&db, b"a run's database").unwrap();
            File::create(lock_path(&base, pid)).unwrap()
        };
        drop(seed(1)); // ended: its lock file is there and nobody holds it
        let live = seed(2);
        live.lock().unwrap(); // going: this test holds its lock, as a running process does
        drop(seed(3)); // this process's own run, which a sweep never judges
        let stranger = base.join(format!("{RUN_PREFIX}db-wal"));
        std::fs::create_dir_all(&stranger).unwrap();

        sweep(&base, 3);

        assert!(!root_path(&base, 1).exists(), "an ended run is deleted");
        assert!(!lock_path(&base, 1).exists(), "and its lock file with it");
        assert!(root_path(&base, 2).join("t2").join("user.db").exists());
        assert!(lock_path(&base, 2).exists(), "a live run is left whole");
        assert!(root_path(&base, 3).exists(), "and so is our own");
        assert!(
            stranger.exists(),
            "a name that is not a run's is not ours to delete"
        );

        drop(live);
        sweep(&base, 3);
        assert!(
            !root_path(&base, 2).exists(),
            "once the run lets go of its lock, the next sweep takes it"
        );
    }
}
