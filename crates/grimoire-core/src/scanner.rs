//! The scanner's session glue: the `card-scanner` crate's [`Session`] behind a lazy load, the
//! lease that says which window may use it, and the reader's scanner preferences and review tray.
//!
//! **What every scanner command does is here, once** (the light app's step 7.3, 2026-10-07): the
//! session's five doors on [`ScannerState`] ([`ScannerState::status`], [`ScannerState::frame`],
//! [`ScannerState::reset`], [`ScannerState::set_filters`], [`ScannerState::capture`]), the four
//! writes ([`save_prefs`], [`save_tray`], [`commit_tray`], [`archive_tray`]), and what a capture
//! is read out of ([`capture_from`] — a body and a header lookup, so a host hands over whatever
//! it calls a header). A frame is the body alone: the JPEG, and nothing beside it. **Two
//! callers, and each only fetches what is its own**: the command table (`commands.rs`), for a
//! host with one page, which admits [`PAGE`] on the lease and reads the capture's header out of
//! the call's arguments; and the desktop's `#[tauri::command]` wrappers (`src-tauri`'s `scanner`
//! module, over a glob re-export of this one), which admit the calling webview's label and read
//! the header out of Tauri's raw request.
//!
//! **A field of [`crate::state::State`], `State.scanner`**, built empty from the data directory —
//! since the extraction's seventh step (2026-10-03); it was the desktop's own managed state,
//! beside its `AppState`, until then. Empty is free: nothing is read until a command first asks
//! for the session, and a host whose reader never opens the scanner never loads a byte of it. The
//! prefs and the tray are `app_meta` rows and touch no session, so they answer before it has
//! loaded; their writes take the lease, for its own reason below, and asking whose the lease is
//! loads nothing.
//!
//! **The session is the Neural scanner's files and the corpus's labels.** The files are built in
//! or absent ([`Embedded::neural`], [`ScannerStatus::neural`]): they are in git, so the desktop
//! and Android carry them on every build, and the host says so once, through
//! [`ScannerState::carry`], before any command can ask; a host that never says carries nothing,
//! and its frames answer `card_scanner::session::NEURAL_UNAVAILABLE_ERROR`. The labels — every
//! printing's name, set, number, finishes — are read from `corpus.db` as the session loads; with
//! none, a decision names a printing by its id alone and no filter can be built.
//!
//! **In a browser this module runs no session at all**: the page's scanner is a Worker of its own
//! on a module of its own (`crates/grimoire-scan`, the light app's step 7.5), and the web host
//! answers the session's commands on the page, in front of this table. So every door here to the
//! session and to a file is shut on a page in one sentence ([`not_in_a_browser_yet`]) — a
//! backstop no reader should meet — while the prefs, the tray and the lease, which are rows and a
//! mutex, answer on a page as anywhere.
//!
//! **The first load is kept for the life of the process.** Nothing here reloads a session: what
//! the binary carries is said once, and the labels are read once, on the first command that asks.
//!
//! **The seventh connection.** Labels are loaded on a read-only connection opened for the
//! load and dropped after — never the state's read connection, the rule the mirror thread and
//! `Rebuild now` already follow, because a 117k-row read on the shared read connection queues
//! every search behind it. It opens `corpus.db` *directly* rather than the pair
//! [`crate::db::open_read`] does, because `Reference::load_labels` reads an unqualified
//! `FROM cards` — the corpus is `main` here, and there is nothing on the user side to attach.
//!
//! **One window scans at a time, and it holds the scanner by a [`LEASE`] it keeps renewing.** The
//! process has one session and every window can open the Scanner view, so every command that
//! *uses* the scanner admits the calling window's label and refuses any other window with
//! [`OPEN_ELSEWHERE`] while the holder has a command still running, and for two seconds after its
//! last one settled: the four session commands, the mounted view's heartbeat — which is what holds
//! it while the camera is still starting or has failed — and the writes of the prefs and the
//! tray. **An admission holds the scanner until its command settles** ([`LeaseGuard`]), not only
//! at the moment it was let in. Those writes are not the session, and they take the lease
//! anyway: a tray write waiting up to five seconds for the write connection holds the scanner the
//! whole time, and the page's next try comes 1.5 s after the last one settled — inside the two
//! seconds — so a window with an unsaved tray keeps the scanner until the write lands, and no
//! second window can open a tray read from a row that is about to change under it.
//! [`ScannerState::elsewhere`] asks the same question without taking anything, and the reads
//! take nothing either. The lease keeps its time on `platform::clock::Tick`, so its tests
//! can say "two seconds later" without waiting two seconds.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use card_scanner::filters::ScanFilters;
use card_scanner::reference::Reference;
use card_scanner::session::{Session, Verdict};
use rusqlite::Connection;

use crate::platform::clock::Tick;
use crate::platform::files;
use crate::state::State;

/// Candidates per frame.
const TOP: usize = 5;

/// The `app_meta` key holding [`ScannerPrefs`], one JSON document written whole. Not synced: a
/// scanner's defaults are about the device in the reader's hand.
pub const K_SCANNER_PREFS: &str = "scanner_prefs";
/// The `app_meta` key holding the review tray, one JSON array written whole. Not synced either:
/// the tray is a session's worth of cards not yet in the collection, and it reaches another
/// device only once it has been committed — as ordinary collection rows.
pub const K_SCANNER_TRAY: &str = "scanner_tray";
/// The most rows [`store_tray`] keeps. Far past a real scanning session; a fence against a loop
/// minting rows, not a limit anybody scanning reaches.
pub const MAX_TRAY_ROWS: usize = 5_000;
/// A tray row holding no copy is a row the commit would refuse — refused at the write instead,
/// where the page can still say so beside the row.
pub const TRAY_ROW_NEEDS_A_COPY: &str = "A tray row needs at least one copy.";
/// [`MAX_TRAY_ROWS`], in words.
pub const TRAY_IS_FULL: &str =
    "The tray holds at most 5,000 rows — add these to the collection first.";
/// [`ScannerPrefs::finish`]'s default: **let the scanner decide each card's finish** from the
/// printing's own finishes — the one it exists in, or `unknown` for the reader to settle where
/// it exists in several.
///
/// **Deliberately not one of `schema::FINISHES`, and it must never become one.** It is a policy the
/// page applies as each card lands — `reader/trayFinish.ts` turns it into a finish, or into
/// `unknown` for the reader to settle — so it can reach neither a tray row nor the collection, and
/// a word the collection's `CHECK` accepts would be a word that could be filed by mistake. A row
/// stored before this existed holds a real finish and keeps it: a reader who chose `nonfoil` chose
/// a fixed finish, and a new default is no reason to take that back.
pub const DETECT_FINISH: &str = "detect";

/// Where an asset came from.
///
/// `File` is a file that was read from a folder, and `Absent` is "nothing to load anywhere".
///
/// **`Store` is a host that has no folder**: the web host keeps what it fetched in the
/// browser's own storage, where no reader can put a file, and says so whether it has fetched
/// it yet or not. [`load`] never answers it, and never answers `File` either — the Neural
/// scanner's files are built in or absent here. The status a page reads is composed by the web
/// host (`packages/ui/lib/core/web/scanner.ts`) in this struct's shape; the variants are declared
/// here because the shape is, and `packages/ui/lib/ipc.ts` mirrors it from this text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetSource {
    File,
    Embedded,
    Absent,
    Store,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Asset {
    /// Where the asset is from — [`NEURAL_SOURCE`] for the Neural scanner's files, carried or
    /// not, so the status always has a place to name.
    pub path: String,
    /// There was something to load: the binary carries it (or, on a page, the store holds it).
    pub present: bool,
    pub loaded: bool,
    pub error: Option<String>,
    pub source: AssetSource,
}

/// The files compiled into the host's binary, if any — said to [`ScannerState::carry`].
///
/// **A struct passed to [`load`] rather than a `cfg!` inside it**: both arms of the load compile
/// and are tested on every build, whatever this one carries, and the core's fence refuses a `cfg`
/// outside `platform/`.
///
/// **`Clone`, not `Copy`**: [`card_scanner::neural::Files`] holds `Cow`s, so that a host handed
/// owned buffers needs no copy. A clone of what a host carries is borrowed slices — no byte is
/// copied.
#[derive(Debug, Clone, Default)]
pub struct Embedded {
    /// The Neural scanner's four files — `card_neural::bundled()`, which the desktop and Android
    /// carry on every build because the files are in git (`crates/card-neural/models/`).
    /// **Built in or nothing**: no file in `data/scanner/` overrides them, since the four are one
    /// set (the gallery is the embedder's own and the thresholds were tuned on the pair) and a
    /// new set is a rebuild.
    pub neural: Option<card_scanner::neural::Files<'static>>,
    /// The Neural scanner's printing evidence — `card_neural::bundled_evidence()`: the set symbol
    /// and collector band networks and their galleries, in git beside [`Embedded::neural`] and
    /// built in or nothing for the same reasons. Loaded after those files, whose `neural.json`
    /// says how to read and weigh them; **without it the scanner still decides**, a look with its
    /// printings as the choices, so a refusal is logged and is not the asset's error.
    pub neural_evidence: Option<card_scanner::neural::EvidenceFiles<'static>>,
}

impl Embedded {
    /// Nothing embedded — a host that carries no files, and every test that is about none.
    pub fn none() -> Embedded {
        Embedded {
            neural: None,
            neural_evidence: None,
        }
    }
}

/// [`ScannerStatus::neural`]'s `path`: where the Neural scanner's files are built in from — the
/// repository, not `data/scanner/`, because no file there is read for them. Named whether or not
/// this build carries them.
pub const NEURAL_SOURCE: &str = "crates/card-neural/models";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerStatus {
    /// **The Neural scanner's files, as one asset** — its detector, its embedder, the gallery of
    /// looks they are searched against and `neural.json` load together or not at all
    /// (`Session::load_neural`). `Embedded` and loaded on the desktop and Android, which build
    /// them in; `Absent` on a host that carries none, where a frame answers
    /// `card_scanner::session::NEURAL_UNAVAILABLE_ERROR`; `Embedded` with the crate's sentence in
    /// `error` when they were carried and did not load. Never `File`. The web host composes its
    /// own (`Store`).
    pub neural: Asset,
    /// Labels loaded from `corpus.db`; 0 when there is none to read them from.
    pub labels: usize,
    /// Where `scanner_capture` writes.
    pub scans_dir: String,
    /// **The reader's filters are not in force**, and this is the sentence the loaded session
    /// refused them with — `None` on every session that searches under what the reader chose.
    ///
    /// **Always `None` from this crate**, which loads one session for the life of the process and
    /// so never has filters to carry across a reload. The web host's scanner Worker can reload
    /// its session, and its status says so here, in this struct's shape.
    pub unapplied_filters: Option<String>,
}

/// What the panel said at the moment of capture, verbatim, beside what the reader typed.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Sidecar {
    pub expected: String,
    pub reported: String,
    pub confidence: String,
    pub votes: String,
    pub distance: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Captured {
    pub saved: String,
}

pub struct Loaded {
    pub session: Session,
    pub status: ScannerStatus,
}

/// What a second window's scanner hears, and what its page draws. `verdictText.ts`'s
/// `SCANNER_OPEN_ELSEWHERE` is the same string and `ipc.test.ts` pins this line.
pub const OPEN_ELSEWHERE: &str = "The scanner is open in another window.";

/// How long a window holds the scanner after its last admitted command **settled** — and it holds
/// it without limit while any of them is still running, however long that takes.
///
/// **Settled, not admitted, and that is a correction.** The lease used to be stamped at admission
/// only, so a tray write that waited five seconds for the write connection before answering `BUSY`
/// let its own lease lapse at two: a second window got through the gate and read a tray the first
/// window's write was about to change. [`LeaseGuard`] counts a command in flight until it returns,
/// and re-stamps the lease when it does.
///
/// **A lease the view keeps renewing, never a claim and a release.** A claim on mount and a release
/// on unmount would race: Tauri does not order two IPC calls, and `main.tsx`'s `StrictMode` mounts
/// every effect twice, so *claim, release, claim* can land as *claim, claim, release* and leave a
/// scanner on screen owning nothing. A reload runs no unmount at all, and a closed window none
/// either. So the mounted view renews it instead: `scanner_hold` on mount and once a second
/// after, whatever the camera is doing, and every frame and every prefs or tray write besides. The
/// heartbeat and the frames stop when the view does, and a write the view left owed stops once it
/// lands; a reload or a closed window stops all of it, and a command already running still settles
/// and releases. So two seconds after the owner's last command settles, the scanner is free, with
/// no hook for any of the three.
///
/// **The heartbeat, not the frames, is what makes it "the view is open".** The lease used to be
/// renewed by the frames alone, and a view with its camera still starting — or refused, or
/// failed — sent none: its lease lapsed in two seconds, a second window got through the gate, and
/// both had the tray on screen, each writing it whole over the other.
pub const LEASE: Duration = Duration::from_secs(2);

/// The label every call through the command table admits on the lease: **the page**.
///
/// A lease is held by a label, and a table call carries a name, its arguments and a body — no
/// window. It does not need one: **a host of the table has exactly one page.** Android's host
/// has one window, built once per process; the web host refuses a second tab before any engine
/// starts (the page's Web Lock, `mtg-grimoire:database`). So every call the table answers comes
/// from the same place, and this is its name.
///
/// What follows from one label: `scanner_elsewhere` answers `false` there, always — nobody
/// else can have admitted anything — and `scanner_hold` and every write are admitted, always.
/// The lease is still taken and still settles, so the code a light host runs is the code the
/// desktop runs, and a host that one day has two pages changes this constant for a label per
/// page and nothing else.
///
/// **The desktop never passes this**: its wrappers admit the calling webview's own label
/// (`main`, `window-2`, …), and it does not dispatch through the table. A desktop that did
/// would have every window admitted as one, which is the reason it must not without a label.
pub const PAGE: &str = "page";

/// What every scanner command that would load the session, run it, or write a file answers
/// **when it is asked of this crate** on a host that is a web page. The name and the words are
/// step 7.3's, from when no browser ran a scanner; since step 7.5 one does, and this is what
/// the engine says if a session command ever reaches it instead of the page's own scanner.
pub const NOT_IN_A_BROWSER_YET: &str = "The scanner does not run in a browser yet.";

/// **This crate runs no scanner session on a page, so a page is refused before one is
/// loaded.** `Ok` on every host that keeps files; on one that does not
/// (`platform::host::keeps_files`) the refusal, in a sentence — [`NOT_IN_A_BROWSER_YET`].
///
/// **The reason is where the session would be, not whether it could run.** The `card-scanner`
/// crate runs on one thread with a clock handed to it since step 7.1, so it compiles and runs
/// as WebAssembly — in a module and a Worker **of its own** (`crates/grimoire-scan`). Not in
/// this one: the web host's module is built with `panic = "abort"`, so a panic anywhere in a
/// frame would be a trap that ends the instance holding the reader's databases; a read frame
/// would block the one Worker every search queues through; and a session's memory would be
/// memory the engine's Worker can never give back.
///
/// **A backstop, and what makes the linker drop the session.** The web host answers the
/// session's commands on the page, in front of the table (`packages/ui/lib/core/web/scanner.ts`),
/// so nothing a reader does arrives here. This stays because the table still names those
/// commands for every host, and because on `wasm32` it is a constant refusal: everything behind
/// it — the session, the recogniser, the network runtime — is unreachable, and fat LTO leaves it
/// out of the engine's module. **That holds for an ordinary function and not for an
/// `async fn`**, whose later states stay reachable whatever its first line returns — so no door
/// to the session may be one.
///
/// **Where it is asked**, which is every way in: [`ScannerState::ensure`] — the one door to the
/// session, so the status, a frame, a reset and a filter push all pass it — and
/// [`ScannerState::capture`], which writes files and touches no session.
///
/// **What it deliberately leaves alone**: the prefs and the tray, read and written, and the
/// tray's commit — rows in a database a page has too; and the lease's two commands, which are a
/// mutex. Those the web host passes through to this crate, unchanged.
///
/// `verdictText.ts`'s `SCANNER_NOT_IN_A_BROWSER_YET` is the same sentence, `ipc.test.ts` pins
/// it, and the page reads it as it reads the web host's own two for a scanner it cannot offer
/// (`packages/ui/lib/core/hostScanner.ts`): quietly, with no camera asked for and no frame sent.
pub fn not_in_a_browser_yet() -> Result<(), String> {
    if !crate::platform::host::keeps_files() {
        return Err(NOT_IN_A_BROWSER_YET.to_owned());
    }
    Ok(())
}

/// Which window holds the scanner, when it last admitted or settled a command, and how many of
/// its admitted commands have not settled yet.
#[derive(Debug)]
struct Lease {
    label: String,
    at: Tick,
    /// Admitted commands still running. **Above zero the lease is held whatever its age** — see
    /// [`held_by_another`].
    in_flight: u32,
}

/// Admit `label` if the lease is free, already its own, or lapsed and idle — renewing it and
/// counting one more command in flight. A refusal renews and counts nothing. Every admission is
/// owed exactly one [`release_lease`], which [`LeaseGuard`]'s drop is.
fn take_lease(owner: &mut Option<Lease>, label: &str, now: Tick) -> bool {
    if held_by_another(owner, label, now) {
        return false;
    }
    match owner.as_mut() {
        Some(held) if held.label == label => {
            held.at = now;
            held.in_flight += 1;
        }
        _ => {
            *owner = Some(Lease {
                label: label.to_owned(),
                at: now,
                in_flight: 1,
            })
        }
    }
    true
}

/// One of `label`'s admitted commands has settled: count it out and re-stamp the lease, so its two
/// seconds run from completion rather than from admission.
///
/// **Only `label`'s own lease is touched.** Another window can hold the scanner by now only if this
/// one's lease went idle and lapsed first — so a release arriving after that is a stray, and must
/// neither count down the new holder's commands nor move its clock.
fn release_lease(owner: &mut Option<Lease>, label: &str, now: Tick) {
    if let Some(held) = owner.as_mut().filter(|held| held.label == label) {
        held.in_flight = held.in_flight.saturating_sub(1);
        held.at = now;
    }
}

/// Whether a window other than `label` holds the scanner: a command of its still running, or its
/// last one settled less than [`LEASE`] ago. Takes nothing.
fn held_by_another(owner: &Option<Lease>, label: &str, now: Tick) -> bool {
    matches!(owner, Some(held)
        if held.label != label
            && (held.in_flight > 0 || now.saturating_duration_since(held.at) < LEASE))
}

/// An admitted command's hold on the scanner, from admission until the command settles.
///
/// **Kept alive across the command's whole body, the awaited `spawn_blocking` included** — bind it
/// as `let _lease = …`, never `let _ = …`, which drops it on the spot. A tray write can wait five
/// seconds for the write connection before it answers `BUSY`; a lease stamped once at entry lapsed
/// under it at two, and a second window got through the gate to read a tray about to change.
/// Dropping it — the command returning, failing, or its future being dropped — is
/// [`release_lease`].
#[derive(Debug)]
#[must_use = "the scanner is held only while the guard lives"]
pub struct LeaseGuard<'a> {
    owner: &'a Mutex<Option<Lease>>,
    label: String,
}

impl Drop for LeaseGuard<'_> {
    /// Never panics: a poisoned lock is recovered rather than unwrapped, because this runs during
    /// unwinding as well and a panic there aborts the process.
    fn drop(&mut self) {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        release_lease(&mut owner, &self.label, Tick::now());
    }
}

pub struct ScannerState {
    data_dir: PathBuf,
    loaded: Mutex<Option<Loaded>>,
    /// The window holding the scanner, if any — [`ScannerState::admit`] takes and renews it.
    ///
    /// **A mutex of its own rather than a field inside `loaded`, because the cheap commands must
    /// never wait behind a frame.** `loaded` is held for the whole of a read, and
    /// `scanner_elsewhere` and `scanner_hold` are asked every second from every window on the
    /// Scanner view, the holder's own heartbeat among them: behind that lock a heartbeat would
    /// queue for a frame, and a slow one could let the very lease it was renewing lapse. A
    /// refusal not waiting behind the holder's frame is the same property from the other side.
    owner: Mutex<Option<Lease>>,
    /// What the host's binary carries — [`ScannerState::carry`]'s word, and [`Embedded::none`]
    /// until it is said.
    embedded: OnceLock<Embedded>,
}

impl ScannerState {
    pub fn new(data_dir: PathBuf) -> ScannerState {
        // The crate's stage timings read this host's clock from here on: it has none of its own
        // in a browser, where `Instant::now()` panics. Once per process; a second state's word
        // is ignored, and is the same word.
        card_scanner::host::set_clock(crate::platform::clock::monotonic_ms);
        ScannerState {
            data_dir,
            loaded: Mutex::new(None),
            owner: Mutex::new(None),
            embedded: OnceLock::new(),
        }
    }

    /// Say what this host's binary carries — once, before any command asks for the session. A
    /// second word is ignored: the session may already have loaded from the first, and a status
    /// that no longer described the loaded session would be worse than none.
    pub fn carry(&self, embedded: Embedded) {
        let _ = self.embedded.set(embedded);
    }

    /// What the host said its binary carries, or nothing if it never said. A clone, which
    /// copies references and no bytes ([`Embedded`]).
    fn carried(&self) -> Embedded {
        self.embedded.get().cloned().unwrap_or_default()
    }

    /// Admit the calling window, or refuse with [`OPEN_ELSEWHERE`]. The answer is the command's
    /// hold on the scanner, and it lasts exactly as long as the [`LeaseGuard`] does.
    pub fn admit(&self, label: &str) -> Result<LeaseGuard<'_>, String> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| "the scanner state is poisoned".to_string())?;
        if take_lease(&mut owner, label, Tick::now()) {
            Ok(LeaseGuard {
                owner: &self.owner,
                label: label.to_owned(),
            })
        } else {
            Err(OPEN_ELSEWHERE.to_owned())
        }
    }

    /// Whether another window holds the scanner — what a second window's page asks before it opens
    /// a camera it would only be refused.
    pub fn elsewhere(&self, label: &str) -> bool {
        self.owner
            .lock()
            .map(|owner| held_by_another(&owner, label, Tick::now()))
            .unwrap_or(false)
    }

    pub fn dir(&self) -> PathBuf {
        self.data_dir.join("scanner")
    }

    /// The session, loading it on first use. Held for the length of one frame.
    ///
    /// **The one door to the session, so the one place it is shut on a page**
    /// ([`not_in_a_browser_yet`]): nothing is loaded there — a page's session is its own
    /// Worker's.
    pub fn ensure(&self) -> Result<MutexGuard<'_, Option<Loaded>>, String> {
        not_in_a_browser_yet()?;
        let mut guard = self
            .loaded
            .lock()
            .map_err(|_| "the scanner state is poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(load(
                &self.dir(),
                &self.data_dir.join(crate::db::CORPUS_DB),
                TOP,
                self.carried(),
            ));
        }
        Ok(guard)
    }

    /// Whether a session is loaded right now, asked without loading one — for a test of what a
    /// refused command cost.
    #[cfg(any(test, feature = "testing"))]
    pub fn is_loaded(&self) -> bool {
        self.loaded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    /// The loaded session, for one piece of work — loaded first if nothing has asked yet.
    fn session<T>(&self, work: impl FnOnce(&mut Loaded) -> T) -> Result<T, String> {
        let mut guard = self.ensure()?;
        match guard.as_mut() {
            Some(loaded) => Ok(work(loaded)),
            // `ensure` answers a guard over `Some`; a sentence rather than a panic all the same.
            None => Err("the scanner did not load".to_owned()),
        }
    }

    /// `scanner_status`: what loaded. Loads the session if this is the first scanner command;
    /// takes no lease — it is a read.
    pub fn status(&self) -> Result<ScannerStatus, String> {
        self.session(|loaded| loaded.status.clone())
    }

    /// `scanner_frame`'s work: one frame in, one verdict out, on the loaded session. The frame
    /// is the call's whole body, a JPEG.
    ///
    /// **The caller has admitted its window first** ([`ScannerState::admit`]) and holds that
    /// guard across this call — the lease is the caller's because the label is.
    pub fn frame(&self, jpeg: &[u8]) -> Result<Verdict, String> {
        self.session(|loaded| loaded.session.frame(jpeg))
    }

    /// `scanner_reset`'s work: forget the card in front of the lens.
    pub fn reset(&self) -> Result<(), String> {
        self.session(|loaded| loaded.session.reset())
    }

    /// `scanner_set_filters`' work: narrow every later frame to these sets and release dates.
    /// Loads the session if this is the first scanner command, because the mask is built from
    /// the loaded labels.
    ///
    /// **The crate's sentence is the error, verbatim** — no labels to filter by, or filters
    /// that match no printing — and a refusal keeps the previous filters in force.
    pub fn set_filters(&self, filters: ScanFilters) -> Result<(), String> {
        self.session(|loaded| loaded.session.set_filters(filters))?
    }

    /// `scanner_capture`'s work: the frame and its sidecar into `scans/` ([`write_capture`]).
    /// No session is touched, and a page has no folder to write into
    /// ([`not_in_a_browser_yet`]).
    pub fn capture(&self, jpeg: &[u8], sidecar: &Sidecar) -> Result<Captured, String> {
        not_in_a_browser_yet()?;
        write_capture(&self.dir().join("scans"), jpeg, sidecar)
    }
}

/// Read the labels and build the session. Every failure is a fact on the status or a line in the
/// log, never an error out of here: the page is useful without labels, and without the Neural
/// files it says so.
///
/// **The labels are `corpus.db`'s**, read on a connection of their own ([`ScannerStatus::labels`]);
/// a corpus that is not there, or will not read, is a session with no reference — decisions by id,
/// and no filters. The Neural scanner's files are the embedded copy or nothing
/// ([`load_neural`]), and so is their printing evidence, loaded once they have
/// ([`load_neural_evidence`]). `dir` is `data/scanner/`, where captures go.
pub fn load(dir: &Path, corpus: &Path, top: usize, embedded: Embedded) -> Loaded {
    let (reference, labels) = load_labels(corpus);
    let mut session = Session::new(reference, top);
    let neural = load_neural(&mut session, embedded.neural);
    if neural.loaded {
        load_neural_evidence(&mut session, embedded.neural_evidence);
    }

    Loaded {
        session,
        status: ScannerStatus {
            neural,
            labels,
            scans_dir: dir.join("scans").display().to_string(),
            unapplied_filters: None,
        },
    }
}

/// Every printing's label out of `corpus.db`, and how many there were — or no reference, with
/// the reason in the log, when there is no corpus to read or it would not read.
fn load_labels(corpus: &Path) -> (Option<Reference>, usize) {
    if !files::is_file(corpus) {
        eprintln!(
            "scanner: no labels — corpus.db not found at {}",
            corpus.display()
        );
        return (None, 0);
    }
    let mut reference = Reference::new();
    let read = Connection::open_with_flags(
        corpus,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .and_then(|conn| reference.load_labels(&conn));
    match read {
        Ok(n) => (Some(reference), n),
        Err(e) => {
            eprintln!("scanner: the labels did not load: {e}");
            (None, 0)
        }
    }
}

/// The Neural scanner's files into `session`, and the asset that says how that went:
/// `Embedded` when the binary carries them — loaded, or with the crate's sentence in `error` —
/// and `Absent` when it carries none. **No file is looked for**: see [`Embedded::neural`] for why
/// the four are built in or nothing.
fn load_neural(
    session: &mut Session,
    files: Option<card_scanner::neural::Files<'static>>,
) -> Asset {
    let mut asset = Asset {
        path: NEURAL_SOURCE.to_owned(),
        present: false,
        loaded: false,
        error: None,
        source: AssetSource::Absent,
    };
    if let Some(files) = files {
        asset.present = true;
        asset.source = AssetSource::Embedded;
        match session.load_neural(files) {
            Ok(()) => asset.loaded = true,
            Err(sentence) => asset.error = Some(sentence),
        }
    }
    asset
}

/// The Neural scanner's printing evidence into `session`, whose Neural files have loaded. **A
/// refusal is logged and goes no further**: the session decides as it did before the evidence
/// existed — a look, with its printings as the choices — so the reader loses a narrower choice
/// and keeps the scanner, and the Neural asset still says what it loaded.
fn load_neural_evidence(
    session: &mut Session,
    files: Option<card_scanner::neural::EvidenceFiles<'static>>,
) {
    if let Some(files) = files {
        if let Err(sentence) = session.load_neural_evidence(files) {
            eprintln!("scanner: the Neural printing evidence did not load: {sentence}");
        }
    }
}

/// How the reader last left the scanner: the filters, what a new tray row defaults to, and
/// whether the developer panels are showing. One `app_meta` row, written whole.
///
/// **`finish` and `condition` are strings here and `Finish | "detect"`/`Condition` on the page**,
/// and they are not validated on write: they are the defaults a tray row is *born* with, and the
/// commit through `collection_import_commit` is where a grade or a finish the collection does not
/// know is refused, in its own words. `finish` defaults to [`DETECT_FINISH`], which is not a finish
/// at all — see it. Language is deliberately absent (spec §3 decision 7): a tray row
/// records none and the collection row takes the import's default.
///
/// `#[serde(default)]` on the struct, so a row written by an older build with fewer fields — or a
/// newer one's missing a field this build has — reads with the rest intact; a key this build does
/// not know (an older build's `mode`) is ignored.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannerPrefs {
    /// Snake case inside, because [`ScanFilters`] is the crate's.
    pub filters: ScanFilters,
    pub finish: String,
    pub condition: String,
    /// The folder a commit files into; `None` is the collection's root.
    pub folder_id: Option<i64>,
    pub developer: bool,
    /// The camera the reader picked, as the webview's `deviceId` for it; `None` is whichever
    /// camera the platform offers first. A fact about this computer: `app_meta` is on no sync
    /// spec, and a `deviceId` names nothing on another machine. A stored id whose camera has
    /// gone is not an error — the page opens the default and leaves the choice standing.
    pub camera_id: Option<String>,
    /// How the review tray lays out its cards: `grid` or `list`. Stored verbatim and not
    /// validated, for `finish`'s reason: which layouts exist is the page's vocabulary, and it
    /// reads a word it does not know as the grid.
    pub tray_layout: String,
    /// **Point and shoot**: recognition runs only for a press — a click on the desktop face, a
    /// hold on the phone's — rather than from Start until Stop, so a camera moving between two
    /// cards reads nothing. The page's to act on; stored here so the choice outlives the visit.
    pub point_and_shoot: bool,
}

impl Default for ScannerPrefs {
    fn default() -> ScannerPrefs {
        ScannerPrefs {
            filters: ScanFilters::default(),
            // A policy and not a finish — see the constant.
            finish: DETECT_FINISH.to_owned(),
            // What a write that names no grade records — not the sentinel, though today they
            // hold one string; see `collection.rs`.
            condition: crate::collection::DEFAULT_CONDITION.to_owned(),
            folder_id: None,
            developer: false,
            camera_id: None,
            tray_layout: "grid".to_owned(),
            point_and_shoot: false,
        }
    }
}

/// One printing a tray row could be — an `Ambiguous` resolve's candidates, kept on the row so the
/// reader can pick among them after the camera has moved on.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannerTrayChoice {
    pub card_id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    /// The finishes the printing exists in — what settles an Unknown row's finish when the
    /// reader picks this printing. Empty when unknown, and in a tray written before it existed.
    pub finishes: Vec<String>,
}

/// One card waiting in the review tray.
///
/// **The row the page built, stored as the page sent it.** `key` is the page's own stable id for
/// the row; `choices` is non-empty only while the row is still a choice to make; `added_at` is
/// the page's clock in milliseconds, used for nothing here but kept so a restored tray orders the
/// way it did.
///
/// **`finish` may be `unknown`** — a card whose finish the scanner could not read, waiting for the
/// reader — and it is stored like any other string: [`valid_tray`] checks the copies and the count
/// and nothing about the finish. The page never sends an `unknown` row as an import line; it keeps
/// it in `remaining`, and were one to reach the import it would be refused there in the
/// collection's own words.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannerTrayRow {
    pub key: String,
    pub card_id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub finish: String,
    /// The finishes the row's printing exists in — what the tray's finish control offers, so a
    /// foil-only printing is never filed as nonfoil (issue #982). Empty when unknown, and in a
    /// tray written before it existed; an empty list constrains nothing, and is not written, so
    /// such a row round-trips as it was sent.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub finishes: Vec<String>,
    pub quantity: i64,
    pub choices: Vec<ScannerTrayChoice>,
    pub added_at: i64,
}

/// The reader's scanner preferences, or the defaults.
///
/// **Every failure is the default** — no row, a row that is not JSON, a row holding the wrong
/// shape — `home::stored`'s read rule: none of those is worth failing over, and all of them mean
/// nothing usable was stored.
pub fn stored_prefs(conn: &Connection) -> ScannerPrefs {
    crate::app_meta::get_app_meta(conn, K_SCANNER_PREFS)
        .and_then(|raw| serde_json::from_str::<ScannerPrefs>(&raw).ok())
        .unwrap_or_default()
}

/// Remember the reader's scanner preferences.
pub fn store_prefs(conn: &Connection, prefs: &ScannerPrefs) -> Result<(), String> {
    let json = serde_json::to_string(prefs)
        .map_err(|e| format!("could not save the scanner settings: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SCANNER_PREFS, &json)
        .map_err(|e| format!("could not save the scanner settings: {e}"))
}

/// The review tray as it was last written, or an empty one.
///
/// **An unreadable tray is an empty tray, never an error** — the page opens on it before the
/// camera starts, and a scanner that refused to open over a damaged row would cost the reader the
/// scanner as well as the tray.
pub fn stored_tray(conn: &Connection) -> Vec<ScannerTrayRow> {
    crate::app_meta::get_app_meta(conn, K_SCANNER_TRAY)
        .and_then(|raw| serde_json::from_str::<Vec<ScannerTrayRow>>(&raw).ok())
        .unwrap_or_default()
}

/// Remember the review tray, whole.
///
/// Two refusals, both before `app_meta` is touched so a refused write leaves the stored tray
/// exactly as it was: more than [`MAX_TRAY_ROWS`] rows ([`TRAY_IS_FULL`]), and any row holding
/// fewer than one copy ([`TRAY_ROW_NEEDS_A_COPY`]) — a row of nothing is a row the commit would
/// refuse, so it is refused where the page can still fix it.
pub fn store_tray(conn: &Connection, rows: &[ScannerTrayRow]) -> Result<(), String> {
    valid_tray(rows)?;
    let json =
        serde_json::to_string(rows).map_err(|e| format!("could not save the scanner tray: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SCANNER_TRAY, &json)
        .map_err(|e| format!("could not save the scanner tray: {e}"))
}

/// [`store_tray`]'s two refusals, askable before anything is written.
fn valid_tray(rows: &[ScannerTrayRow]) -> Result<(), String> {
    if rows.len() > MAX_TRAY_ROWS {
        return Err(TRAY_IS_FULL.to_owned());
    }
    if rows.iter().any(|row| row.quantity < 1) {
        return Err(TRAY_ROW_NEEDS_A_COPY.to_owned());
    }
    Ok(())
}

/// The tray into the collection **and** what is left of it into `app_meta`, in one transaction.
///
/// **Why one write and not the import followed by [`store_tray`].** The page used to commit through
/// `collection_import_commit` and let its debounced tray write catch up afterwards; an app closed
/// in that window, a `BUSY` on the second write, or an older tray write landing after the commit
/// each left the committed rows in the stored tray, so the next launch restored them and the next
/// Add filed the same cards twice. Here the import's rows and the stored tray commit together, so
/// there is no moment at which the collection holds a card the tray still offers.
///
/// The import is [`crate::collection::commit_import_with`] in `add` mode — the collection's own
/// logic, its own refusals and its own activity row, not a copy. `remaining` is refused on
/// [`store_tray`]'s terms **before** the import starts, so a tray that could not be stored costs
/// no rolled-back import; any refusal from either half leaves the collection and the stored tray
/// exactly as they were.
///
/// **And the pile goes into the scan history in the same write** (issue #989): one
/// [`crate::scan_history::FILED`] batch of the lines the import took, recorded inside the
/// import's transaction, so the history can never name cards the collection did not take nor
/// miss a pile it did. A commit of no lines records nothing.
pub fn tray_commit(
    conn: &Connection,
    items: &[crate::collection::CollectionImportItem],
    folder_id: Option<i64>,
    remaining: &[ScannerTrayRow],
) -> Result<crate::collection::ImportCommitOutcome, String> {
    valid_tray(remaining)?;
    crate::collection::commit_import_with(conn, items, "add", folder_id, |tx| {
        if !items.is_empty() {
            crate::scan_history::record_batch(tx, items, crate::scan_history::FILED, folder_id)?;
        }
        store_tray(tx, remaining)
    })
}

/// The tray's rows **into the scan history and nowhere else**, and what is left of the tray into
/// `app_meta`, in one savepoint — Archive, the trade page's *put away without touching the
/// collection* for a pile the reader wants a record of and does not own (issue #989).
///
/// [`tray_commit`]'s shape with the import taken out: `remaining` is refused on [`store_tray`]'s
/// terms before anything is written, the batch's own refusals
/// ([`crate::scan_history::record_batch`]) are made before it writes, and a refusal from either
/// leaves the history and the stored tray as they were. Answers the batch's id, or `None` for an
/// archive of no lines, which records nothing and only stores the tray.
pub fn tray_archive(
    conn: &Connection,
    items: &[crate::collection::CollectionImportItem],
    remaining: &[ScannerTrayRow],
) -> Result<Option<i64>, String> {
    valid_tray(remaining)?;
    crate::db::in_savepoint(conn, "scanner_tray_archive", || {
        let id = if items.is_empty() {
            None
        } else {
            Some(crate::scan_history::record_batch(
                conn,
                items,
                crate::scan_history::ARCHIVED,
                None,
            )?)
        };
        store_tray(conn, remaining)?;
        Ok(id)
    })
}

/// `live-<epoch>.jpg` and its `.json`, the frame and what the panel said of it.
///
/// **A capture never replaces one already in `scans/`** (issue #1131). Two presses inside one
/// wall-clock second used to share a name, and the second frame and sidecar silently replaced
/// the first — a lost labelled sample. The frame is now created exclusively
/// ([`files::create_new`]), and a name that is taken moves on to `live-<epoch>-2.jpg`,
/// `live-<epoch>-3.jpg` and so on; the sidecar follows whichever name the frame won.
pub fn write_capture(scans: &Path, jpeg: &[u8], sidecar: &Sidecar) -> Result<Captured, String> {
    let stamp = u64::try_from(crate::platform::clock::now_secs()).unwrap_or(0);
    write_capture_at(scans, jpeg, sidecar, stamp)
}

/// How many names one second's captures may take before a capture gives up — far more presses
/// than a second holds, so reaching it means something other than a reader is writing here.
const CAPTURE_NAMES_PER_SECOND: u32 = 1000;

/// [`write_capture`] at a given second, so a test can make two captures collide.
fn write_capture_at(
    scans: &Path,
    jpeg: &[u8],
    sidecar: &Sidecar,
    stamp: u64,
) -> Result<Captured, String> {
    if jpeg.is_empty() {
        return Err("empty frame".into());
    }
    files::create_dir_all(scans).map_err(|e| format!("{}: {e}", scans.display()))?;
    let (name, jpg) = (1..=CAPTURE_NAMES_PER_SECOND)
        .find_map(|n| {
            let name = if n == 1 {
                format!("live-{stamp}.jpg")
            } else {
                format!("live-{stamp}-{n}.jpg")
            };
            let jpg = scans.join(&name);
            match files::create_new(&jpg, jpeg) {
                Ok(()) => Some(Ok((name, jpg))),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(e) => Some(Err(format!("{}: {e}", jpg.display()))),
            }
        })
        .unwrap_or_else(|| {
            Err(format!(
                "{}: every capture name for second {stamp} is taken",
                scans.display()
            ))
        })?;
    let json = serde_json::json!({
        "captured_at_epoch": stamp,
        "image": name,
        "expected": sidecar.expected,
        "reported": sidecar.reported,
        "confidence": sidecar.confidence,
        "votes": sidecar.votes,
        "distance": sidecar.distance,
    });
    let side = jpg.with_extension("json");
    files::write(&side, &serde_json::to_vec_pretty(&json).unwrap_or_default())
        .map_err(|e| format!("{}: {e}", side.display()))?;
    Ok(Captured { saved: name })
}

/// The header a capture carries its [`Sidecar`] in, as JSON.
pub const CAPTURE_HEADER: &str = "x-scanner-capture";

/// One header of a raw-body call, as far as the host that received it could read it.
///
/// **Three states, because a sidecar that is there and unreadable is a refusal and one that was
/// not sent is not** ([`capture_from`]) — so "could not be read" may not be folded into "was not
/// sent". Each host fills it from what it calls a header: the desktop from Tauri's `HeaderMap`,
/// where a value outside visible ASCII is the unreadable one; the command table from the call's
/// arguments ([`Header::of_json`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Header<'a> {
    Absent,
    Text(&'a str),
    /// There, and not text — with what the host had to say about it, which ends the sentence.
    Unreadable(String),
}

impl<'a> Header<'a> {
    /// A header as a call through the command table carries it: **the call's arguments are the
    /// headers**, an object of strings, exactly as `packages/ui/lib/core/table.ts` and the web
    /// host's `protocol.ts` send a `Uint8Array` call — `{"x-scanner-capture": "<json>"}`. A key
    /// that is missing or `null` was not sent; a value that is not a string is there and
    /// unreadable, as a header of raw bytes is on the desktop.
    pub fn of_json(value: Option<&'a serde_json::Value>) -> Header<'a> {
        match value {
            None | Some(serde_json::Value::Null) => Header::Absent,
            Some(serde_json::Value::String(text)) => Header::Text(text),
            Some(_) => Header::Unreadable("it is not a string".to_owned()),
        }
    }
}

/// The capture from a call's body and its sidecar from [`CAPTURE_HEADER`].
///
/// **A sidecar header that is there and unreadable is a refusal.** A defaulted sidecar would
/// write a JPEG to disk with five empty fields and report success, which is an *unlabelled*
/// capture the reader believes they labelled — the one thing the dataset cannot recover from
/// later. An **absent** header still means [`Sidecar::default`], because capturing without
/// typing a name is a thing the reader chooses. On the desktop the unreadable case is
/// `HeaderValue::to_str` refusing any byte outside visible ASCII, so the page escapes non-ASCII
/// as `\uXXXX` before it puts this JSON on the wire — for every host, though only that one
/// needs it.
pub fn capture_from<'b, 'h>(
    body: &'b [u8],
    header: &dyn Fn(&str) -> Header<'h>,
) -> Result<(&'b [u8], Sidecar), String> {
    let sidecar = match header(CAPTURE_HEADER) {
        Header::Absent => Sidecar::default(),
        Header::Unreadable(e) => return Err(format!("the capture's sidecar did not parse: {e}")),
        Header::Text(text) => serde_json::from_str(text)
            .map_err(|e| format!("the capture's sidecar did not parse: {e}"))?,
    };
    Ok((body, sidecar))
}

/// `set_scanner_prefs`' work: the reader's scanner preferences, through the state's one
/// definition of a write. Answers [`crate::db::BUSY`] if a sync holds the write connection.
///
/// **The caller has admitted its window first, and holds that guard until this returns** — the
/// admission is the point. The row is written whole, so only the window holding the scanner
/// may write it; and `with_write` can wait five seconds for the write connection before it
/// answers `BUSY` — longer than [`LEASE`] — so the scanner stays that window's for as long as
/// its write is waiting, and for two seconds after it settles, which is long enough for the
/// page's next try.
#[track_caller]
pub fn save_prefs(state: &State, prefs: &ScannerPrefs) -> Result<(), String> {
    crate::state::with_write(state, |conn| store_prefs(conn, prefs))
}

/// `set_scanner_tray`'s work: the review tray, whole. The two refusals are [`store_tray`]'s; a
/// busy write connection answers [`crate::db::BUSY`]. Admitted first and held until it settles
/// by the caller, for [`save_prefs`]' reason.
#[track_caller]
pub fn save_tray(state: &State, rows: &[ScannerTrayRow]) -> Result<(), String> {
    crate::state::with_write(state, |conn| store_tray(conn, rows))
}

/// `scanner_tray_commit`'s work: the tray's rows into the collection and what is left of the
/// tray into `app_meta`, as one write — see [`tray_commit`]. Through `with_write_owned`,
/// `collection_import_commit`'s own door, so the facet index's `owned` dimension moves with the
/// copies and a busy write connection answers [`crate::db::BUSY`] with nothing written.
///
/// **Admitted first and held until it settles by the caller, like the tray's own write**:
/// `remaining` is the tray written whole, and a window that has lost the scanner is a window
/// whose tray may be older than the stored one — its commit would file rows another window has
/// already filed, and store a tray over theirs.
#[track_caller]
pub fn commit_tray(
    state: &State,
    items: &[crate::collection::CollectionImportItem],
    folder_id: Option<i64>,
    remaining: &[ScannerTrayRow],
) -> Result<crate::collection::ImportCommitOutcome, String> {
    crate::collection_source::with_write_owned(state, |conn| {
        tray_commit(conn, items, folder_id, remaining)
    })
}

/// `scanner_tray_archive`'s work: the tray's rows into the scan history and what is left of the
/// tray into `app_meta`, as one write — see [`tray_archive`]. Through `with_write`, the tray's own
/// door: the collection is not touched, so the facet index has nothing to publish. A busy write
/// connection answers [`crate::db::BUSY`] with nothing written.
///
/// **Admitted first and held until it settles by the caller**, [`commit_tray`]'s reason exactly:
/// `remaining` is the tray written whole.
#[track_caller]
pub fn archive_tray(
    state: &State,
    items: &[crate::collection::CollectionImportItem],
    remaining: &[ScannerTrayRow],
) -> Result<Option<i64>, String> {
    crate::state::with_write(state, |conn| tray_archive(conn, items, remaining))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::set_app_meta;
    use std::borrow::Cow;

    /// The table [`K_SCANNER_PREFS`] and [`K_SCANNER_TRAY`] live in, as `schema.rs` builds it —
    /// `home.rs`' own test helper. Nothing here reads a second table.
    fn meta() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        c
    }

    fn tray_row(key: &str, quantity: i64) -> ScannerTrayRow {
        ScannerTrayRow {
            key: key.into(),
            card_id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7".into(),
            oracle_id: Some("4457ed35-7c10-48c8-9776-456485fdf070".into()),
            name: "Lightning Bolt".into(),
            set_code: "2x2".into(),
            collector_number: "117".into(),
            finish: "nonfoil".into(),
            finishes: vec!["nonfoil".into(), "foil".into()],
            quantity,
            choices: vec![ScannerTrayChoice {
                card_id: "b14fae63-2e82-49c1-8e62-d84a65f27479".into(),
                oracle_id: Some("4457ed35-7c10-48c8-9776-456485fdf070".into()),
                name: "Lightning Bolt".into(),
                set_code: "sta".into(),
                collector_number: "105".into(),
                finishes: Vec::new(),
            }],
            added_at: 1_757_900_000_000,
        }
    }

    #[test]
    fn nothing_anywhere_is_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let l = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
            Embedded::none(),
        );
        let n = &l.status.neural;
        assert_eq!(n.source, AssetSource::Absent, "{n:?}");
        assert!(!n.present && !n.loaded, "{n:?}");
        // A host that carries no Neural files: no Neural scanner, and still the place they come
        // from, so the status has a path to name.
        assert!(!l.session.has_neural());
        assert_eq!(n.path, NEURAL_SOURCE);
        assert_eq!(n.error, None);
    }

    /// **The Neural scanner's files, as the desktop and Android carry them**, load into the
    /// session and say so — and they need nothing else: no labels, no folder.
    #[test]
    fn the_built_in_neural_files_load_and_say_so() {
        let dir = tempfile::tempdir().expect("tempdir");
        let l = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
            Embedded {
                neural: Some(card_neural::bundled()),
                ..Embedded::none()
            },
        );
        let n = &l.status.neural;
        assert_eq!(n.source, AssetSource::Embedded, "{n:?}");
        assert!(n.present && n.loaded && n.error.is_none(), "{n:?}");
        assert_eq!(n.path, NEURAL_SOURCE);
        assert!(l.session.has_neural());
        // No `corpus.db`, so no labels.
        assert!(!l.session.has_reference());
        assert_eq!(l.status.labels, 0);
        // Carried without its evidence: the files load, and decide as they did before it.
        assert!(!l.session.has_neural_evidence());
    }

    /// **The printing evidence the desktop and Android carry loads after the Neural files**;
    /// evidence that does not load leaves the Neural scanner loaded and its asset without an
    /// error, and evidence without the files it belongs to is not tried.
    #[test]
    fn the_built_in_evidence_loads_beside_the_neural_files_and_a_refusal_is_not_fatal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let load_with = |neural, neural_evidence| {
            load(
                &dir.path().join("scanner"),
                &dir.path().join("corpus.db"),
                5,
                Embedded {
                    neural,
                    neural_evidence,
                },
            )
        };
        let both = load_with(
            Some(card_neural::bundled()),
            Some(card_neural::bundled_evidence()),
        );
        assert!(both.session.has_neural() && both.session.has_neural_evidence());
        assert!(both.status.neural.loaded && both.status.neural.error.is_none());

        let garbage = card_scanner::neural::EvidenceFiles {
            symbol_net: Cow::Borrowed(&b"not a network"[..]),
            band_net: Cow::Borrowed(&b"not a network"[..]),
            symbols: Cow::Borrowed(&b"not a gallery"[..]),
            bands: Cow::Borrowed(&b"not a gallery"[..]),
        };
        let refused = load_with(Some(card_neural::bundled()), Some(garbage));
        assert!(refused.session.has_neural() && !refused.session.has_neural_evidence());
        let n = &refused.status.neural;
        assert!(n.loaded && n.error.is_none(), "{n:?}");

        let alone = load_with(None, Some(card_neural::bundled_evidence()));
        assert!(!alone.session.has_neural() && !alone.session.has_neural_evidence());
        assert_eq!(alone.status.neural.source, AssetSource::Absent);
    }

    /// Files the binary carries that do not load are `Embedded`, there, not loaded, and carry
    /// the crate's sentence — and the session is built anyway, with no Neural scanner.
    #[test]
    fn neural_files_that_do_not_load_say_why() {
        let dir = tempfile::tempdir().expect("tempdir");
        let garbage = card_scanner::neural::Files {
            detector: Cow::Borrowed(&b"not a model"[..]),
            embedder: Cow::Borrowed(&b"not a model"[..]),
            gallery: Cow::Borrowed(&b"not a gallery"[..]),
            meta: Cow::Borrowed(&b"not json"[..]),
        };
        let l = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
            Embedded {
                neural: Some(garbage),
                ..Embedded::none()
            },
        );
        let n = &l.status.neural;
        assert_eq!(n.source, AssetSource::Embedded, "{n:?}");
        assert!(n.present && !n.loaded, "{n:?}");
        assert!(n.error.as_deref().is_some_and(|e| !e.is_empty()), "{n:?}");
        assert!(!l.session.has_neural());
    }

    /// **What the host carries reaches the load**, said once through `carry`, and a frame with
    /// no Neural files carried says so in the crate's words rather than failing.
    #[test]
    fn a_carried_neural_scanner_is_the_one_the_session_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bare = ScannerState::new(dir.path().to_path_buf());
        let verdict = bare.frame(&[0xFF, 0xD8, 0xFF]).expect("a verdict");
        assert_eq!(
            verdict.error.as_deref(),
            Some(card_scanner::session::NEURAL_UNAVAILABLE_ERROR)
        );

        let state = ScannerState::new(dir.path().to_path_buf());
        state.carry(Embedded {
            neural: Some(card_neural::bundled()),
            ..Embedded::none()
        });
        // A second word is ignored.
        state.carry(Embedded::none());
        let status = state.status().expect("status");
        assert!(status.neural.loaded, "{:?}", status.neural);
        assert!(state
            .ensure()
            .expect("ensure")
            .as_ref()
            .expect("loaded")
            .session
            .has_neural());
    }

    #[test]
    fn prefs_round_trip_through_app_meta_and_default_when_unset() {
        let conn = meta();
        assert_eq!(stored_prefs(&conn), ScannerPrefs::default());
        let p = ScannerPrefs {
            developer: true,
            folder_id: Some(4),
            ..Default::default()
        };
        store_prefs(&conn, &p).unwrap();
        assert_eq!(stored_prefs(&conn), p);
    }

    #[test]
    fn a_prefs_row_that_does_not_parse_reads_as_the_default() {
        let conn = meta();
        for junk in ["not json", "[]", r#"{"developer":"yes"}"#] {
            set_app_meta(&conn, K_SCANNER_PREFS, junk).unwrap();
            assert_eq!(stored_prefs(&conn), ScannerPrefs::default(), "{junk}");
        }
    }

    #[test]
    fn the_default_row_detects_the_finish_and_is_ungraded() {
        let p = ScannerPrefs::default();
        assert_eq!(p.finish, "detect");
        assert_eq!(p.condition, "NONE");
        assert_eq!(p.folder_id, None);
        assert!(!p.developer);
        assert_eq!(p.camera_id, None);
        assert_eq!(p.tray_layout, "grid");
        assert!(!p.point_and_shoot);
    }

    /// A row an older build wrote has no camera and no tray layout, and `#[serde(default)]` is
    /// what reads it: the reader's folder survives, and the two new fields take the defaults
    /// rather than the whole row falling back to them. **Its `mode`, which the scanner no longer
    /// has, is a key this build ignores** rather than a reason to drop the row.
    #[test]
    fn a_row_from_before_the_camera_and_the_layout_keeps_what_it_had() {
        let conn = meta();
        set_app_meta(
            &conn,
            K_SCANNER_PREFS,
            r#"{"mode":"exact","folderId":4,"developer":true}"#,
        )
        .unwrap();
        let p = stored_prefs(&conn);
        assert_eq!(p.folder_id, Some(4));
        assert!(p.developer);
        assert_eq!(p.camera_id, None);
        assert_eq!(p.tray_layout, "grid");
        assert!(!p.point_and_shoot);
    }

    /// **Detect is a policy, so it must never be a word the collection would file.**
    #[test]
    fn detect_is_not_a_finish() {
        assert!(!crate::schema::FINISHES.contains(&DETECT_FINISH));
    }

    /// **A reader who chose a fixed finish keeps it** — the new default is for a row never
    /// written, and a stored `nonfoil` is a choice rather than an old default to migrate away.
    #[test]
    fn a_stored_fixed_finish_survives_the_new_default() {
        let conn = meta();
        set_app_meta(
            &conn,
            K_SCANNER_PREFS,
            r#"{"mode":"fast","finish":"nonfoil","condition":"NONE","developer":false}"#,
        )
        .unwrap();
        assert_eq!(stored_prefs(&conn).finish, "nonfoil");
    }

    /// **The rename is the contract, and `ipc.test.ts` cannot see it** — its mirror table camel-cases
    /// the Rust field names unconditionally, so a dropped `rename_all` stays green there. Read off
    /// the real wire here instead.
    #[test]
    fn prefs_and_tray_rows_travel_under_the_names_the_page_reads() {
        let p = serde_json::to_value(ScannerPrefs {
            folder_id: Some(4),
            camera_id: Some("cam-1".to_owned()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(p["folderId"], 4);
        assert!(p.get("mode").is_none(), "{p}");
        assert_eq!(p["cameraId"], "cam-1");
        assert_eq!(p["trayLayout"], "grid");
        assert_eq!(p["pointAndShoot"], false);
        // The filters keep the crate's snake case inside the camel-case document.
        assert!(p["filters"].get("released_from").is_some(), "{p}");

        let row = serde_json::to_value(tray_row("k", 1)).unwrap();
        for key in [
            "key",
            "cardId",
            "oracleId",
            "name",
            "setCode",
            "collectorNumber",
            "finish",
            "quantity",
            "choices",
            "addedAt",
        ] {
            assert!(row.get(key).is_some(), "{key} missing from {row}");
        }
        assert!(row["choices"][0].get("collectorNumber").is_some(), "{row}");

        assert_eq!(serde_json::to_value(AssetSource::Absent).unwrap(), "absent");
    }

    #[test]
    fn a_tray_round_trips_whole() {
        let conn = meta();
        assert!(stored_tray(&conn).is_empty());
        let rows = vec![tray_row("a", 1), tray_row("b", 3)];
        store_tray(&conn, &rows).unwrap();
        assert_eq!(stored_tray(&conn), rows);
        store_tray(&conn, &[]).unwrap();
        assert!(
            stored_tray(&conn).is_empty(),
            "an empty tray is a tray, not a missing row"
        );
    }

    /// **An `unknown` finish is a row like any other to the store**, and a tray commit that files
    /// the known rows keeps it in what is left — the page's half of "Add 8 · 2 need a finish".
    #[test]
    fn a_row_of_unknown_finish_round_trips_and_stays_behind_a_commit() {
        let unknown = ScannerTrayRow {
            finish: "unknown".into(),
            ..tray_row("u", 1)
        };
        let conn = meta();
        store_tray(&conn, &[unknown.clone(), tray_row("k", 1)]).unwrap();
        assert_eq!(stored_tray(&conn), vec![unknown.clone(), tray_row("k", 1)]);
        assert_eq!(stored_tray(&conn)[0].finish, "unknown");

        let conn = pair_with_a_card();
        store_tray(&conn, &[unknown.clone(), tray_row("k", 1)]).unwrap();
        tray_commit(
            &conn,
            &[import_line("card-1", 1)],
            None,
            std::slice::from_ref(&unknown),
        )
        .unwrap();
        assert_eq!(copies(&conn), 1);
        assert_eq!(stored_tray(&conn), vec![unknown]);
    }

    #[test]
    fn a_tray_row_with_zero_quantity_is_refused_with_a_sentence() {
        let conn = meta();
        let kept = vec![tray_row("a", 2)];
        store_tray(&conn, &kept).unwrap();

        let err = store_tray(&conn, &[tray_row("a", 2), tray_row("b", 0)]).unwrap_err();
        assert_eq!(err, TRAY_ROW_NEEDS_A_COPY);
        assert_eq!(err, "A tray row needs at least one copy.");
        assert_eq!(
            stored_tray(&conn),
            kept,
            "a refused write leaves the stored tray as it was"
        );
        assert!(store_tray(&conn, &[tray_row("c", -1)]).is_err());
    }

    #[test]
    fn a_tray_past_five_thousand_rows_is_refused_with_a_sentence() {
        let conn = meta();
        let full = vec![tray_row("r", 1); MAX_TRAY_ROWS];
        store_tray(&conn, &full).expect("exactly the limit is a tray");
        let over = vec![tray_row("r", 1); MAX_TRAY_ROWS + 1];
        assert_eq!(
            store_tray(&conn, &over).unwrap_err(),
            "The tray holds at most 5,000 rows — add these to the collection first."
        );
        assert_eq!(stored_tray(&conn).len(), MAX_TRAY_ROWS);
    }

    /// Both halves of a tray commit: one printing in `cards`, and a user side holding the
    /// collection and `app_meta`. Torn down with the connection.
    fn pair_with_a_card() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,finishes,prices,raw)
             VALUES ('card-1','o1','Test Card','tst','1','en','normal','common',
                '[\"nonfoil\"]','{}','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn import_line(card_id: &str, quantity: i64) -> crate::collection::CollectionImportItem {
        crate::collection::CollectionImportItem {
            card_id: card_id.into(),
            quantity,
            finish: "nonfoil".into(),
            condition: None,
            condition_original: None,
            purchase_price: None,
            purchase_currency: None,
            acquired_at: None,
            acquisition_source: None,
            notes: None,
            serial_number: None,
            altered: false,
            signed: false,
            proxy: false,
            misprint: false,
            grading: None,
            tradelist_quantity: None,
            tags: None,
        }
    }

    fn copies(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_tray_commit_adds_the_rows_and_stores_what_is_left_in_the_same_write() {
        let conn = pair_with_a_card();
        store_tray(&conn, &[tray_row("taken", 2), tray_row("left", 1)]).unwrap();
        let out = tray_commit(
            &conn,
            &[import_line("card-1", 2)],
            None,
            &[tray_row("left", 1)],
        )
        .unwrap();
        assert_eq!((out.added, out.updated, out.removed), (1, 0, 0));
        assert_eq!(copies(&conn), 2);
        assert_eq!(
            stored_tray(&conn),
            vec![tray_row("left", 1)],
            "the committed row is still in the stored tray, so a restart files it twice"
        );
    }

    /// Recognition and filing are separate: a tray can keep miscellaneous cards without
    /// an Oracle identity, and a failed Add must not discard the scan (#742).
    #[test]
    fn a_scan_without_an_oracle_survives_storage_and_a_refused_add() {
        let conn = pair_with_a_card();
        let mut row = tray_row("art", 1);
        row.card_id = "unknown-art-printing".into();
        row.oracle_id = None;
        row.name = "Art card".into();
        row.choices.clear();
        store_tray(&conn, &[row.clone()]).unwrap();
        assert_eq!(stored_tray(&conn), vec![row.clone()]);

        assert!(tray_commit(&conn, &[import_line(&row.card_id, 1)], None, &[]).is_err());
        assert_eq!(copies(&conn), 0);
        assert_eq!(stored_tray(&conn), vec![row]);
    }

    #[test]
    fn a_refused_tray_commit_leaves_the_collection_and_the_stored_tray_as_they_were() {
        let conn = pair_with_a_card();
        let before = vec![tray_row("a", 1), tray_row("b", 1)];
        store_tray(&conn, &before).unwrap();

        // An unknown card, after a line the import has already written inside its transaction.
        let err = tray_commit(
            &conn,
            &[import_line("card-1", 1), import_line("no-such-card", 1)],
            None,
            &[],
        )
        .unwrap_err();
        assert!(err.contains("no-such-card"), "{err}");
        assert_eq!(copies(&conn), 0, "a refused import kept its first line");
        assert_eq!(
            stored_tray(&conn),
            before,
            "a refused import emptied the tray"
        );

        // A remaining tray `store_tray` would refuse is refused before the import writes.
        let err = tray_commit(
            &conn,
            &[import_line("card-1", 1)],
            None,
            &[tray_row("z", 0)],
        )
        .unwrap_err();
        assert_eq!(err, TRAY_ROW_NEEDS_A_COPY);
        assert_eq!(copies(&conn), 0);
        assert_eq!(stored_tray(&conn), before);

        // And the tray write is inside the import's transaction, not after its commit: a refusal
        // from that last write takes the imported rows back out with it.
        let err = crate::collection::commit_import_with(
            &conn,
            &[import_line("card-1", 1)],
            "add",
            None,
            |tx| {
                store_tray(tx, &[])?;
                Err("the disk filled".to_owned())
            },
        )
        .unwrap_err();
        assert_eq!(err, "the disk filled");
        assert_eq!(
            copies(&conn),
            0,
            "the import committed before the tray was written"
        );
        assert_eq!(stored_tray(&conn), before);
    }

    fn batches(conn: &Connection) -> Vec<crate::scan_history::ScanBatchSummary> {
        crate::scan_history::list_batches(conn).unwrap()
    }

    /// Issue #989: an Add records the pile it filed, in the same write — and a refused Add
    /// records nothing, because the batch is inside the import's transaction.
    #[test]
    fn a_tray_commit_records_a_filed_batch_and_a_refused_one_records_nothing() {
        let conn = pair_with_a_card();
        let err = tray_commit(
            &conn,
            &[import_line("card-1", 1), import_line("no-such-card", 1)],
            None,
            &[],
        )
        .unwrap_err();
        assert!(err.contains("no-such-card"), "{err}");
        assert!(
            batches(&conn).is_empty(),
            "a refused Add left a batch behind"
        );

        tray_commit(&conn, &[], None, &[]).unwrap();
        assert!(
            batches(&conn).is_empty(),
            "a commit of nothing records nothing"
        );

        tray_commit(&conn, &[import_line("card-1", 3)], None, &[]).unwrap();
        let list = batches(&conn);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status, crate::scan_history::FILED);
        assert_eq!((list[0].line_count, list[0].copies), (1, 3));
        assert_eq!(list[0].folder_id, None);
    }

    /// Archive keeps the pile in the history and out of the collection, and stores the tray
    /// that is left in the same write; a refusal from either half writes neither.
    #[test]
    fn a_tray_archive_records_the_pile_and_files_nothing() {
        let conn = pair_with_a_card();
        store_tray(&conn, &[tray_row("taken", 2), tray_row("left", 1)]).unwrap();

        let id = tray_archive(&conn, &[import_line("card-1", 2)], &[tray_row("left", 1)])
            .unwrap()
            .expect("a batch");
        assert_eq!(copies(&conn), 0, "an archive filed into the collection");
        assert_eq!(stored_tray(&conn), vec![tray_row("left", 1)]);
        let batch = crate::scan_history::get_batch(&conn, id).unwrap().unwrap();
        assert_eq!(batch.summary.status, crate::scan_history::ARCHIVED);
        assert_eq!(batch.lines[0].name, "Test Card");

        // A remaining tray `store_tray` would refuse, and a line the history would refuse.
        let before = stored_tray(&conn);
        assert_eq!(
            tray_archive(&conn, &[import_line("card-1", 1)], &[tray_row("z", 0)]).unwrap_err(),
            TRAY_ROW_NEEDS_A_COPY
        );
        assert_eq!(
            tray_archive(&conn, &[import_line("no-such-card", 1)], &[]).unwrap_err(),
            crate::scan_history::NO_SUCH_CARD
        );
        assert_eq!(
            stored_tray(&conn),
            before,
            "a refused archive moved the tray"
        );
        assert_eq!(
            batches(&conn).len(),
            1,
            "a refused archive left a batch behind"
        );

        assert_eq!(tray_archive(&conn, &[], &[]).unwrap(), None);
        assert!(stored_tray(&conn).is_empty());
        assert_eq!(batches(&conn).len(), 1);
    }

    #[test]
    fn an_unreadable_stored_tray_reads_as_empty_rather_than_failing() {
        let conn = meta();
        for junk in ["not json", r#"{"key":"a"}"#, r#"[{"quantity":"many"}]"#] {
            set_app_meta(&conn, K_SCANNER_TRAY, junk).unwrap();
            assert!(stored_tray(&conn).is_empty(), "{junk}");
        }
    }

    #[test]
    fn an_empty_data_dir_loads_no_labels_and_still_answers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let loaded = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
            Embedded::none(),
        );
        let s = &loaded.status;
        assert_eq!(s.labels, 0);
        assert!(s.scans_dir.ends_with("scans"));
        assert_eq!(s.unapplied_filters, None);
        assert!(!loaded.session.has_reference());
    }

    /// A `corpus.db` that is there and is not one is no labels, as an absent one is — and the
    /// session is built either way: nameless is a state, not a failure.
    #[test]
    fn a_corpus_that_will_not_read_is_no_labels() {
        let dir = tempfile::tempdir().expect("tempdir");
        let corpus = dir.path().join("corpus.db");
        std::fs::write(&corpus, b"not a database").expect("write");
        let loaded = load(&dir.path().join("scanner"), &corpus, 5, Embedded::none());
        assert_eq!(loaded.status.labels, 0);
        assert!(!loaded.session.has_reference());
    }

    #[test]
    fn a_capture_writes_the_frame_and_its_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scans = dir.path().join("scans");
        let sidecar = Sidecar {
            expected: "Plains".into(),
            reported: "Plains".into(),
            votes: "8.0".into(),
            ..Default::default()
        };
        let saved = write_capture(&scans, &[0xFF, 0xD8, 0xFF], &sidecar).expect("write");
        assert!(
            saved.saved.starts_with("live-") && saved.saved.ends_with(".jpg"),
            "{}",
            saved.saved
        );
        let json = std::fs::read_to_string(scans.join(&saved.saved).with_extension("json"))
            .expect("sidecar");
        let v: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(v["expected"], "Plains");
        assert_eq!(v["votes"], "8.0");
        assert_eq!(v["image"], saved.saved);
        assert!(v["captured_at_epoch"].is_number());
    }

    #[test]
    fn two_captures_in_one_second_keep_both_frames() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scans = dir.path().join("scans");
        let label = |expected: &str| Sidecar {
            expected: expected.into(),
            ..Default::default()
        };
        let first = write_capture_at(&scans, &[0xFF, 0xD8, 1], &label("Plains"), 1_757_300_000)
            .expect("first");
        let second = write_capture_at(&scans, &[0xFF, 0xD8, 2], &label("Island"), 1_757_300_000)
            .expect("second");
        let third = write_capture_at(&scans, &[0xFF, 0xD8, 3], &label("Swamp"), 1_757_300_000)
            .expect("third");
        assert_eq!(first.saved, "live-1757300000.jpg");
        assert_eq!(second.saved, "live-1757300000-2.jpg");
        assert_eq!(third.saved, "live-1757300000-3.jpg");
        for (saved, byte, expected) in [
            (&first, 1, "Plains"),
            (&second, 2, "Island"),
            (&third, 3, "Swamp"),
        ] {
            let jpg = scans.join(&saved.saved);
            assert_eq!(std::fs::read(&jpg).expect("frame"), [0xFF, 0xD8, byte]);
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(jpg.with_extension("json")).expect("sidecar"),
            )
            .expect("json");
            assert_eq!(v["expected"], expected);
            assert_eq!(v["image"], saved.saved);
            assert_eq!(v["captured_at_epoch"], 1_757_300_000);
        }
    }

    /// One command from `label` at `at` that settled in the same instant — admitted and released
    /// together, which is what every lease test here meant before an admission could be in flight.
    fn used(owner: &mut Option<Lease>, label: &str, at: Tick) -> bool {
        let admitted = take_lease(owner, label, at);
        if admitted {
            release_lease(owner, label, at);
        }
        admitted
    }

    /// How many of the holder's admitted commands have not settled.
    fn in_flight(state: &ScannerState) -> u32 {
        state
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map_or(0, |lease| lease.in_flight)
    }

    #[test]
    fn a_free_lease_is_taken_and_its_holder_readmitted() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(used(&mut owner, "main", t0));
        assert!(used(&mut owner, "main", t0 + Duration::from_millis(1)));
    }

    #[test]
    fn another_window_is_refused_inside_the_lease_and_admitted_after_it() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(used(&mut owner, "main", t0));
        assert!(!used(
            &mut owner,
            "window-2",
            t0 + Duration::from_millis(1999)
        ));
        assert!(used(&mut owner, "window-2", t0 + LEASE));
        assert_eq!(owner.map(|lease| lease.label).as_deref(), Some("window-2"));
    }

    /// A refused frame must not keep the lease alive, or a second window asking every frame would
    /// hold the first one's lease open forever on its behalf.
    #[test]
    fn a_refusal_does_not_renew_the_holders_lease() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(used(&mut owner, "main", t0));
        assert!(!used(&mut owner, "window-2", t0 + Duration::from_secs(1)));
        assert!(used(&mut owner, "window-2", t0 + LEASE));
    }

    /// **The holder's own admissions renew the lease**, which is the whole of what lets a mounted
    /// view hold the scanner on a heartbeat: used at t0 and again at t0 + 1.5 s, it is still the
    /// holder's at t0 + 2.5 s — half a second past where a lease used once would have lapsed.
    #[test]
    fn the_holders_own_admissions_renew_the_lease() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(used(&mut owner, "main", t0));
        assert!(used(&mut owner, "main", t0 + Duration::from_millis(1500)));
        assert!(
            !used(&mut owner, "window-2", t0 + Duration::from_millis(2500)),
            "a renewal did not move the lease's clock"
        );
        assert_eq!(owner.map(|lease| lease.label).as_deref(), Some("main"));
    }

    /// **An admitted command holds the scanner until it settles, however long that takes.** A tray
    /// write waits up to `WRITE_LOCK_WAIT` (5 s) for the write connection before it can answer
    /// `BUSY`, which is longer than the lease: stamped once at entry, the lease lapsed under the
    /// write, and a second window got through the gate and read a tray about to change.
    #[test]
    fn a_command_in_flight_holds_the_lease_past_its_two_seconds() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(take_lease(&mut owner, "main", t0));
        for later in [LEASE, LEASE * 3, Duration::from_secs(60)] {
            assert!(
                held_by_another(&owner, "window-2", t0 + later),
                "free under a command still in flight, {later:?} in"
            );
            assert!(!take_lease(&mut owner, "window-2", t0 + later), "{later:?}");
        }
        assert!(
            !held_by_another(&owner, "main", t0 + LEASE * 3),
            "a window is not elsewhere to itself"
        );
        assert!(
            take_lease(&mut owner, "main", t0 + LEASE * 3),
            "the holder is readmitted beside its own command"
        );
    }

    /// **Settling re-stamps the lease, so it runs its two seconds from completion.** A write
    /// admitted at t0 that answers at t0 + 5 s holds the scanner until t0 + 7 s — which is what
    /// lets the page's next try, 1.5 s after the answer, find the scanner still its own.
    #[test]
    fn settling_restamps_so_the_lease_runs_from_completion() {
        let t0 = Tick::now();
        let done = t0 + Duration::from_secs(5);
        let mut owner = None;
        assert!(take_lease(&mut owner, "main", t0));
        release_lease(&mut owner, "main", done);
        assert!(!take_lease(
            &mut owner,
            "window-2",
            done + Duration::from_millis(1999)
        ));
        assert!(take_lease(&mut owner, "window-2", done + LEASE));
    }

    /// **The count balances across one window's overlapping commands.** A frame decoding while a
    /// tray write waits for the lock is two admissions; the first to settle must not free the
    /// scanner under the second.
    #[test]
    fn overlapping_commands_from_one_window_hold_it_until_the_last_settles() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(take_lease(&mut owner, "main", t0));
        assert!(take_lease(
            &mut owner,
            "main",
            t0 + Duration::from_millis(100)
        ));
        release_lease(&mut owner, "main", t0 + Duration::from_secs(1));
        assert!(
            !take_lease(&mut owner, "window-2", t0 + Duration::from_secs(10)),
            "the first to settle freed the scanner under the second"
        );
        let last = t0 + Duration::from_secs(11);
        release_lease(&mut owner, "main", last);
        assert!(!take_lease(
            &mut owner,
            "window-2",
            last + Duration::from_millis(1999)
        ));
        assert!(take_lease(&mut owner, "window-2", last + LEASE));
    }

    /// **A release is its own window's and nobody else's.** Another window can take the scanner
    /// only once this one's lease is idle and lapsed; a release for this window arriving after that
    /// must neither count down the new holder's commands nor move its clock.
    #[test]
    fn a_late_release_never_touches_another_windows_lease() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(used(&mut owner, "main", t0));
        let taken = t0 + LEASE;
        assert!(
            take_lease(&mut owner, "window-2", taken),
            "an idle, lapsed lease is free"
        );
        release_lease(&mut owner, "main", taken + Duration::from_secs(1));
        let held = owner.as_ref().expect("held");
        assert_eq!(
            (held.label.as_str(), held.at, held.in_flight),
            ("window-2", taken, 1)
        );
        assert!(
            !take_lease(&mut owner, "main", taken + LEASE * 5),
            "the new holder's command is still in flight"
        );
    }

    /// The refusal the page matches on is the sentence and nothing else — `verdictText.ts`'s
    /// `SCANNER_OPEN_ELSEWHERE` is compared against it byte for byte, so a prefix, a wrapper or a
    /// second sentence would be a window that never learns it was refused.
    #[test]
    fn a_refused_admission_is_exactly_the_open_elsewhere_sentence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = ScannerState::new(dir.path().to_path_buf());
        let _held = state.admit("main").expect("a free scanner admits");
        assert_eq!(
            state.admit("window-2").err(),
            Some(OPEN_ELSEWHERE.to_owned())
        );
        assert!(state.elsewhere("window-2"));
        assert!(!state.elsewhere("main"));
    }

    /// **The guard is the command's hold.** While any of the holder's guards lives another window
    /// is refused, and each drop settles exactly one command.
    #[test]
    fn an_admission_holds_the_scanner_for_as_long_as_its_guard_lives() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = ScannerState::new(dir.path().to_path_buf());
        let frame = state.admit("main").expect("a free scanner admits");
        let write = state.admit("main").expect("the holder is readmitted");
        assert_eq!(in_flight(&state), 2);
        assert!(state.admit("window-2").is_err());
        drop(frame);
        assert_eq!(in_flight(&state), 1);
        assert!(state.elsewhere("window-2"));
        drop(write);
        assert_eq!(in_flight(&state), 0);
        assert_eq!(
            state.admit("window-2").err(),
            Some(OPEN_ELSEWHERE.to_owned()),
            "settling re-stamps the lease: two more seconds from now"
        );
    }

    /// A guard dropped over a poisoned lock settles its command rather than panicking — `drop`
    /// runs during unwinding too, and a panic there aborts the process.
    #[test]
    fn a_guard_dropped_over_a_poisoned_lock_does_not_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = ScannerState::new(dir.path().to_path_buf());
        let held = state.admit("main").expect("admitted");
        let poisoner = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _owner = state.owner.lock();
                    panic!("poisoning the scanner's lease on purpose");
                })
                .join()
        });
        assert!(poisoner.is_err() && state.owner.is_poisoned());
        drop(held);
        assert_eq!(in_flight(&state), 0, "the drop did not settle the command");
    }

    #[test]
    fn asking_never_takes_the_lease() {
        let t0 = Tick::now();
        let mut owner = None;
        assert!(
            !held_by_another(&owner, "window-2", t0),
            "a free scanner is nobody's"
        );
        assert!(used(&mut owner, "main", t0));
        assert!(held_by_another(
            &owner,
            "window-2",
            t0 + Duration::from_secs(1)
        ));
        assert!(
            !held_by_another(&owner, "main", t0),
            "a window is not elsewhere to itself"
        );
        assert!(
            !held_by_another(&owner, "window-2", t0 + LEASE),
            "a lapsed lease is free"
        );
        assert_eq!(owner.map(|lease| lease.label).as_deref(), Some("main"));
    }

    /// A call's headers as the command table hands them over: its arguments, by name.
    fn carried<'a>(args: &'a serde_json::Value) -> impl Fn(&str) -> Header<'a> + 'a {
        move |name| Header::of_json(args.get(name))
    }

    #[test]
    fn a_header_out_of_a_calls_arguments_is_absent_text_or_unreadable() {
        let args = serde_json::json!({ "text": "3", "nothing": null, "number": 3, "list": [] });
        let header = carried(&args);
        assert_eq!(header("text"), Header::Text("3"));
        assert_eq!(header("missing"), Header::Absent);
        assert_eq!(header("nothing"), Header::Absent);
        // There, and not a string: unreadable, never quietly absent — the capture's sidecar
        // turns on the difference.
        assert!(matches!(header("number"), Header::Unreadable(_)));
        assert!(matches!(header("list"), Header::Unreadable(_)));
    }

    #[test]
    fn a_capture_reads_its_sidecar_from_the_header() {
        let args = serde_json::json!({ CAPTURE_HEADER: r#"{"expected":"Plains","votes":"8.0"}"# });
        let (jpeg, sidecar) = capture_from(&[7], &carried(&args)).expect("payload");
        assert_eq!(jpeg, [7]);
        assert_eq!(sidecar.expected, "Plains");
        assert_eq!(sidecar.votes, "8.0");
        // An absent header is the reader's own choice, not a failure.
        let none = serde_json::json!({});
        let (_, sidecar) = capture_from(&[7], &carried(&none)).expect("payload");
        assert_eq!(sidecar.expected, "");
    }

    /// The page escapes non-ASCII as `\uXXXX` for every host, so the name survives as the same
    /// JSON — and a host whose wire is not a header reads the letter itself just as well.
    #[test]
    fn a_card_name_comes_back_with_its_accent_escaped_or_not() {
        for sent in [
            r#"{"expected":"\u00c6ther Vial"}"#,
            "{\"expected\":\"\u{c6}ther Vial\"}",
        ] {
            let args = serde_json::json!({ CAPTURE_HEADER: sent });
            let (_, sidecar) = capture_from(&[7], &carried(&args)).expect("payload");
            assert_eq!(sidecar.expected, "\u{c6}ther Vial", "{sent}");
        }
    }

    /// The failure that used to file an unlabelled capture as a success: a sidecar that is there
    /// and cannot be read is refused, rather than falling back to five empty fields and a
    /// written JPEG.
    #[test]
    fn a_capture_header_that_cannot_be_read_is_a_sentence() {
        for unreadable in [
            serde_json::json!({ CAPTURE_HEADER: "{not json" }),
            serde_json::json!({ CAPTURE_HEADER: { "expected": "Plains" } }),
            serde_json::json!({ CAPTURE_HEADER: 7 }),
        ] {
            let err = capture_from(&[7], &carried(&unreadable)).expect_err("unreadable header");
            assert!(
                err.starts_with("the capture's sidecar did not parse: "),
                "{err}"
            );
        }
    }

    /// A `corpus.db` in `data_dir` that names one printing — the least a session needs to
    /// accept a filter, which is built from labels.
    fn a_labelled_corpus(data_dir: &Path) {
        let id = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
        let corpus = Connection::open(data_dir.join(crate::db::CORPUS_DB)).expect("corpus.db");
        corpus
            .execute_batch(&format!(
                "CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT, set_code TEXT,
                    collector_number TEXT, lang TEXT, released_at TEXT, oracle_id TEXT,
                    finishes TEXT, promo INTEGER NOT NULL DEFAULT 0,
                    layout TEXT NOT NULL DEFAULT 'normal', type_line TEXT);
                 INSERT INTO cards VALUES ('{id}', 'Lightning Bolt', '2x2', '117', 'en',
                    '2022-07-08', NULL, '[\"nonfoil\"]', 0, 'normal', 'Instant');"
            ))
            .expect("a card");
    }

    /// The filters a session is searching under right now, loading one if none is.
    fn in_force(state: &ScannerState) -> ScanFilters {
        state
            .ensure()
            .expect("ensure")
            .as_ref()
            .expect("loaded")
            .session
            .filters()
            .clone()
    }

    /// **The labels are `corpus.db`'s**, and a filter is built from them: with the one printing
    /// named, its set narrows the scan, and a set nothing is printed in is the crate's refusal.
    #[test]
    fn the_labels_come_from_the_corpus_and_a_filter_is_built_from_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        a_labelled_corpus(dir.path());
        let state = ScannerState::new(dir.path().to_path_buf());
        assert_eq!(state.status().expect("status").labels, 1);
        assert!(state
            .ensure()
            .expect("ensure")
            .as_ref()
            .expect("loaded")
            .session
            .has_reference());

        let filters = ScanFilters {
            sets: vec!["2x2".to_owned()],
            ..Default::default()
        };
        state
            .set_filters(filters.clone())
            .expect("a set that is there");
        assert_eq!(in_force(&state), filters);
        let none = ScanFilters {
            sets: vec!["lea".to_owned()],
            ..Default::default()
        };
        assert_eq!(
            state.set_filters(none).unwrap_err(),
            "No printing matches these filters."
        );
        assert_eq!(
            in_force(&state),
            filters,
            "a refusal keeps what is in force"
        );

        // Without the corpus, no filter but none can be built.
        let bare = tempfile::tempdir().expect("tempdir");
        let state = ScannerState::new(bare.path().to_path_buf());
        let said = state.set_filters(filters).unwrap_err();
        assert!(said.starts_with("Filters need card names"), "{said}");
        assert_eq!(state.set_filters(ScanFilters::default()), Ok(()));
    }
    /// **On a page every door to the session and to a file is one sentence**, and nothing is
    /// loaded or written on the way to it; the lease, which is a mutex, answers as anywhere.
    #[test]
    fn on_a_page_the_session_and_the_capture_are_refused_in_one_sentence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = ScannerState::new(dir.path().to_path_buf());
        {
            let _page = crate::platform::host::emulate_page();
            let refused = Some(NOT_IN_A_BROWSER_YET.to_owned());
            assert_eq!(not_in_a_browser_yet().err(), refused);
            assert_eq!(state.status().err(), refused);
            assert_eq!(state.frame(&[1, 2, 3]).err(), refused);
            assert_eq!(state.reset().err(), refused);
            assert_eq!(state.set_filters(ScanFilters::default()).err(), refused);
            assert_eq!(
                state
                    .capture(&[0xFF, 0xD8, 0xFF], &Sidecar::default())
                    .err(),
                refused
            );
            assert!(state.ensure().is_err());
            // Holding the scanner is no session and no file.
            let _held = state.admit(PAGE).expect("the page is admitted");
            assert!(!state.elsewhere(PAGE));
        }
        assert!(!state.is_loaded(), "a refused command loaded the session");
        assert!(
            !dir.path().join("scanner").exists(),
            "a refused capture made a folder"
        );
        // And the same state, on a host that keeps files, answers.
        assert_eq!(not_in_a_browser_yet(), Ok(()));
        assert!(state.status().is_ok());
    }

    /// Whether `state::with_write` has run on this state's write connection: its first act is
    /// to arm the managed wishlists' guards there (`managed_wishlist::arm`), which a write made
    /// on the bare connection never does. The trigger is the one `arm` itself looks for.
    fn armed(state: &State) -> bool {
        state
            .lock_db()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM temp.sqlite_master
                                WHERE type = 'trigger' AND name = 'mw_guard_folder_del')",
                [],
                |r| r.get(0),
            )
            .expect("the connection's own triggers")
    }

    /// A state over files with `pair_with_a_card`'s printing in it and a warm facet index that
    /// owns nothing — so a write that goes through `with_write` shows (the guards it arms), and
    /// one that goes through `with_write_owned` shows again (the index, published anew).
    fn a_state_with_a_card(name: &str) -> (std::sync::Arc<State>, PathBuf) {
        let (state, dir) = crate::state::fixtures::on_files(name, "http://127.0.0.1:1");
        state
            .lock_db()
            .execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,finishes,prices,raw)
                 VALUES ('card-1','o1','Test Card','tst','1','en','normal','common',
                    '[\"nonfoil\"]','{}','{}')",
                [],
            )
            .expect("a card");
        crate::index::lifecycle::build_now(&state).expect("an index over the fixture");
        assert!(!armed(&state), "nothing has written through the state yet");
        (state, dir)
    }

    /// **The prefs and the tray are written through `state::with_write`, not on the connection
    /// underneath it** — a state of its own each, because arming happens once per connection
    /// and the second write on one state could not show it. That the rows land is this module's
    /// other tests' business, on a bare connection; what is under test here is the door. Plain
    /// writes, so the facet index is left exactly as it was.
    #[test]
    fn the_prefs_and_the_tray_are_written_through_the_states_own_write() {
        let (state, _dir) = a_state_with_a_card("scanner-write-prefs");
        let index = crate::index::lifecycle::current(&state).expect("a warm index");
        let prefs = ScannerPrefs {
            developer: true,
            ..Default::default()
        };
        save_prefs(&state, &prefs).expect("prefs");
        assert_eq!(stored_prefs(&state.lock_db_read()), prefs);
        assert!(armed(&state), "`save_prefs` wrote beside `with_write`");
        assert!(std::sync::Arc::ptr_eq(
            &index,
            &crate::index::lifecycle::current(&state).expect("a warm index")
        ));

        let (state, _dir) = a_state_with_a_card("scanner-write-tray");
        let index = crate::index::lifecycle::current(&state).expect("a warm index");
        save_tray(&state, &[tray_row("a", 2), tray_row("b", 1)]).expect("tray");
        assert_eq!(stored_tray(&state.lock_db_read()).len(), 2);
        assert!(armed(&state), "`save_tray` wrote beside `with_write`");
        assert!(std::sync::Arc::ptr_eq(
            &index,
            &crate::index::lifecycle::current(&state).expect("a warm index")
        ));
        assert_eq!(
            save_tray(&state, &[tray_row("z", 0)]).unwrap_err(),
            TRAY_ROW_NEEDS_A_COPY
        );
    }

    /// **The commit is an owned write** — `with_write_owned`, `collection_import_commit`'s own
    /// door: beside the rows and the tray, the facet index is published again with the card it
    /// now owns. Through plain `with_write` every row here still lands and the index goes stale,
    /// so the Search view's "owned" filter misses a card the reader has just filed.
    #[test]
    fn the_trays_commit_is_an_owned_write_and_moves_the_index() {
        let (state, _dir) = a_state_with_a_card("scanner-write-commit");
        let before = crate::index::lifecycle::current(&state).expect("a warm index");
        assert_eq!(before.owned.count(), 0);
        save_tray(&state, &[tray_row("a", 2), tray_row("b", 1)]).expect("tray");

        let out = commit_tray(
            &state,
            &[import_line("card-1", 2)],
            None,
            &[tray_row("b", 1)],
        )
        .expect("commit");
        assert_eq!((out.added, out.updated, out.removed), (1, 0, 0));
        assert_eq!(copies(&state.lock_db_read()), 2);
        assert_eq!(stored_tray(&state.lock_db_read()), vec![tray_row("b", 1)]);

        let after = crate::index::lifecycle::current(&state).expect("a warm index");
        assert!(
            !std::sync::Arc::ptr_eq(&before, &after),
            "the commit did not publish the index: it is not an owned write"
        );
        assert_eq!(after.owned.count(), 1);
    }
}
