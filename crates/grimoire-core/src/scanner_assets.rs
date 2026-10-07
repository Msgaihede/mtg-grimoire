//! **The scanner's three files, fetched when a reader asks for them** — the light app's step 7.4
//! (2026-10-07; the tracking issue's box: *"Scanner assets fetched on first use with their
//! measured size … not embedded"*).
//!
//! The scanner needs a bundle of card hashes and two OCR models (`scanner`'s module doc). The
//! desktop's release build carries them in its binary; a phone's build carries nothing, and until
//! this module its status named an app-private path and told the reader to put a file there and
//! restart. This is the other way a host gets them: **what is owed** ([`owed`]) — which of the
//! three this install lacks and what fetching them costs — and **the fetch** ([`fetch`]), which
//! downloads every owed file into `<data>/scanner/` and lets the loaded session go
//! (`ScannerState::forget`) so the next scanner command reads them, with no restart.
//!
//! **Nothing here runs uninvited.** No launch calls [`fetch`], nothing schedules it, and a host
//! whose binary carries the files owes nothing and is never offered a download — so a desktop
//! release build makes no request. The one caller is a reader's press on the page's offer.
//!
//! **The source is this repository's own GitHub release**, `scanner-bundle-v<FORMAT_VERSION>`
//! ([`release_url`]), which `.github/workflows/scanner-bundle.yml` publishes weekly and
//! `scripts/scanner-assets.mjs` downloads for a release build — one place, two readers. The tag
//! carries the bundle's format version, so a build only ever fetches a bundle it can read.
//! **HTTPS on every hop, and the host and the path are constants.** GitHub answers a release
//! download with a redirect to its asset host, and the client follows it — `reqwest`'s default
//! policy, at most ten hops to whichever host each answer names — but it is built
//! `https_only` (`platform::http::Config`), so the request and every hop of a redirect are
//! HTTPS or the request ends as an error. **Not through `scryfall::Client`**: that client is
//! Scryfall's pacing gate and its 429 lockout, and GitHub is owed neither.
//!
//! **A file is trusted only after it has been checked, and only then does it take its name.**
//! Each download is written to `<name>.part` beside its destination — the same folder, so the
//! rename is one operation on one filesystem — and a load never reads that name.
//!
//! * **The two models are pinned.** They are the same two files in every release, so each must
//!   be **exactly** its length — refused on what the answer declares, before a byte is read —
//!   and then its **SHA-256 must be the one written here** ([`DETECTION_SHA256`],
//!   [`RECOGNITION_SHA256`]), before the loader sees a byte of it. Then the pair must build the
//!   reader the scanner will build. A model that is not byte for byte the published one is never
//!   parsed and never renamed.
//! * **The bundle cannot be pinned** — it is rebuilt every week — so it is held to what can be
//!   said of any bundle: under its ceiling ([`MAX_BUNDLE_BYTES`], counted as it arrives), parsed
//!   by `Bundle::from_bytes` (the magic, this build's format version, the length its header
//!   declares), and **not empty** — a header with no card behind it would load, name nothing,
//!   and never be owed again. What vouches for its contents is the HTTPS chain to GitHub and
//!   nothing else; a wrong bundle that parses names the wrong cards, and runs no code.
//!
//! A failure deletes the temporary file, is one sentence the page can show — naming the file,
//! never an app-private path — and is written to `error_log` as the feeds' failures are, so one
//! that happens after its page was left is recorded somewhere. **A temporary file a killed
//! process left is started over** — there is no resume: the whole of it is 18 MB, the bundle is
//! rebuilt every week, and a partial of last week's file continued with this week's is the bug
//! `scryfall::Client::download` keeps an `.origin` record to avoid.
//!
//! **Bounded, and one at a time.** Every wait — for an answer to begin and for each chunk — is
//! under the feeds' stall bound (`scryfall::STALL`). That is a bound on silence and not on the
//! whole: a link that keeps delivering slowly is never given up on, and nothing cancels a fetch
//! but its end. A second call while one runs is **refused** ([`ALREADY_FETCHING`]), as a second
//! card sync or combo refresh is; the claim is an atomic on the state's `ScannerState`, released
//! by a guard however the run ends. No retry loop: the reader's next press is the retry, and it
//! fetches only what is still owed — a file that landed is kept.
//!
//! **A fetch outlives the page that started it.** It is awaited by the host's command, not by
//! the page, so leaving the Scanner view changes nothing; [`Owed::fetching`] is how a page that
//! comes back learns one is running, and [`PROGRESS_EVENT`] how it draws how far.
//!
//! **On a page both commands are refused**, in `scanner::NOT_IN_A_BROWSER_YET` — GitHub sends no
//! CORS header, so a browser cannot ask this source at all, and a page keeps no files to put an
//! answer in. The browser's source and storage are the light app's web step's.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use card_scanner::index::{Bundle, Section, FORMAT_VERSION};
use card_scanner::ocr::TitleReader;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::downloads::Due;
use crate::errors::Kind;
use crate::platform::files::{self, aio};
use crate::platform::{http, spawn};
use crate::scanner::{Embedded, ScannerStatus, BUNDLE_FILE, DETECTION_MODEL, RECOGNITION_MODEL};
use crate::state::State;

/// Where this repository's release downloads live. The tag and the file's name follow.
pub const RELEASES: &str = "https://github.com/Msgaihede/mtg-grimoire/releases/download";

/// The release a build fetches from: `scanner-bundle-v<FORMAT_VERSION>`, the tag
/// `scanner-bundle.yml` publishes to and `scripts/scanner-assets.mjs` reads.
pub fn release_url() -> String {
    format!("{RELEASES}/scanner-bundle-v{FORMAT_VERSION}")
}

/// The bundle of card hashes, as measured on the release on 2026-10-07: 5 874 752 B. **A
/// measurement, used only for the offer** — the file is rebuilt weekly and grows with every
/// set, so nothing is checked against it; the bundle is trusted because it parses.
pub const BUNDLE_BYTES: u64 = 5_874_752;
/// The text-detection model: exactly 2 510 284 B. A file of any other length is not it.
pub const DETECTION_BYTES: u64 = 2_510_284;
/// The text-recognition model: exactly 9 716 568 B.
pub const RECOGNITION_BYTES: u64 = 9_716_568;

/// The text-detection model's SHA-256, lowercase hex.
///
/// **The two models are immutable, so they are pinned**: `ocrs-models`' published files, the
/// same two in every `scanner-bundle-v*` release. Read on 2026-10-07 three ways that agreed —
/// the release's own asset digests (`gh api …/releases/tags/scanner-bundle-v3`), a fresh
/// download hashed locally, and the copy the frame bench was run on. A model whose digest is
/// not this is not parsed, not loaded and not renamed, whatever sent it.
///
/// ⚠️ **`.github/workflows/scanner-bundle.yml` checks the same two digests before it publishes**,
/// so the workflow cannot upload a model every installed app would refuse. A deliberate change
/// of model is a change to both places and to the two lengths above, in one commit — and an
/// installed app keeps refusing the new files until it is updated, which is the pin working.
pub const DETECTION_SHA256: &str =
    "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca";
/// The text-recognition model's SHA-256 — see [`DETECTION_SHA256`].
pub const RECOGNITION_SHA256: &str =
    "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e";

/// The most a bundle may be. Ten times today's, and a fence rather than a forecast: a wrong
/// answer from a redirect must not be written to a phone's disk until it ends.
pub const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
// A ceiling under the file it is a ceiling for would refuse every download, in a sentence
// about the file. Held where it cannot be built.
const _: () = assert!(BUNDLE_BYTES < MAX_BUNDLE_BYTES);

/// The event a fetch reports itself through — [`Progress`].
pub const PROGRESS_EVENT: &str = "scanner:assets";

/// Bytes of download between two [`PROGRESS_EVENT`]s: about seventy for the whole fetch.
const PROGRESS_STEP: u64 = 256 * 1024;

/// [`Progress::phase`]'s four words, as the page reads them (`ScannerAssetsPhase` in `ipc.ts`).
pub const PHASE_DOWNLOADING: &str = "downloading";
pub const PHASE_CHECKING: &str = "checking";
pub const PHASE_DONE: &str = "done";
pub const PHASE_ERROR: &str = "error";

/// What a second fetch hears while one is running.
pub const ALREADY_FETCHING: &str = "The scanner's files are already downloading.";

/// What `error_log` files a failed fetch under — `combos`' and the price feeds' column, where
/// the operation names the feed because the schema has no source for it.
pub const ERROR_OPERATION: &str = "scanner_assets";

/// One of the three files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Piece {
    Bundle,
    Detection,
    Recognition,
}

impl Piece {
    /// What a row and an event call it.
    fn key(self) -> &'static str {
        match self {
            Piece::Bundle => "bundle",
            Piece::Detection => "detectionModel",
            Piece::Recognition => "recognitionModel",
        }
    }

    /// What the reader is told it is.
    fn label(self) -> &'static str {
        match self {
            Piece::Bundle => "Card hashes",
            Piece::Detection => "Text detection model",
            Piece::Recognition => "Text recognition model",
        }
    }

    /// Its place under `<data>/scanner/` — the models in a folder of their own.
    fn place(self) -> &'static str {
        match self {
            Piece::Bundle => BUNDLE_FILE,
            Piece::Detection => DETECTION_MODEL,
            Piece::Recognition => RECOGNITION_MODEL,
        }
    }

    /// Its name on the release, which is flat: the last part of [`Piece::place`].
    fn asset(self) -> &'static str {
        let place = self.place();
        place.rsplit('/').next().unwrap_or(place)
    }
}

/// What one model must be, to the byte.
#[derive(Clone)]
struct Pinned {
    bytes: u64,
    /// Lowercase hex.
    sha256: String,
}

/// Where the files come from and what they must be. **The shipped one is [`Source::shipped`]**;
/// the fields exist so a test can point the fetch at a local server, give it a stall bound of
/// milliseconds, a ceiling of a few bytes and models of nine — `combos::refresh_from`'s seam,
/// with more to hand in.
#[derive(Clone)]
struct Source {
    /// The release's address, with no trailing slash; a file's name is joined to it.
    base: String,
    /// Whether the client refuses anything but HTTPS, on the request and on every hop. `true`
    /// as shipped; a test's local server is plain HTTP.
    https_only: bool,
    /// How long nothing may arrive for, on the answer and on each chunk.
    stall: Duration,
    /// About how large the bundle is — the offer's figure.
    bundle_bytes: u64,
    /// The most a bundle may be, declared or received.
    bundle_ceiling: u64,
    detection: Pinned,
    recognition: Pinned,
    /// Whether a detection and a recognition model load as a pair.
    readable: fn(&[u8], &[u8]) -> Result<(), String>,
}

impl Source {
    fn shipped() -> Source {
        Source {
            base: release_url(),
            https_only: true,
            stall: crate::scryfall::STALL,
            bundle_bytes: BUNDLE_BYTES,
            bundle_ceiling: MAX_BUNDLE_BYTES,
            detection: Pinned {
                bytes: DETECTION_BYTES,
                sha256: DETECTION_SHA256.to_owned(),
            },
            recognition: Pinned {
                bytes: RECOGNITION_BYTES,
                sha256: RECOGNITION_SHA256.to_owned(),
            },
            readable: |detection, recognition| {
                TitleReader::from_bytes(detection, recognition).map(drop)
            },
        }
    }

    /// What a model must be; `None` for the bundle, which nothing pins.
    fn pinned(&self, piece: Piece) -> Option<&Pinned> {
        match piece {
            Piece::Bundle => None,
            Piece::Detection => Some(&self.detection),
            Piece::Recognition => Some(&self.recognition),
        }
    }

    /// What `piece` costs to fetch: exact for a model, about right for the bundle.
    fn bytes(&self, piece: Piece) -> u64 {
        self.pinned(piece)
            .map_or(self.bundle_bytes, |pinned| pinned.bytes)
    }

    /// The client GitHub is asked with: the feeds' bounds, the app's own user agent — which
    /// names the app, its version and this repository — HTTPS on every hop, and no pacing gate,
    /// which is Scryfall's. Built per fetch, which is one press: there is no pool worth keeping
    /// between two of them.
    fn client(&self) -> http::Client {
        http::Client::new(&http::Config {
            user_agent: crate::scryfall::USER_AGENT,
            connect_timeout: Some(Duration::from_secs(30)),
            read_timeout: Some(crate::scryfall::STALL),
            https_only: self.https_only,
        })
    }
}

/// What this install lacks of the scanner's files, and whether they are on their way.
///
/// `owed` is in the shape `downloads::launch_due` answers — a key, what to call it, about how
/// many bytes — so a page draws this offer as it draws that one. Empty is the answer on a host
/// whose binary carries the files, and on any host once they have landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owed {
    pub owed: Vec<Due>,
    /// All of `owed`, added up.
    pub bytes: u64,
    /// A fetch is running now — started by this page or by one that has since been left.
    pub fetching: bool,
}

/// How far a fetch has got — the payload of [`PROGRESS_EVENT`].
///
/// `phase` is one of the four `PHASE_*` words. `done` and `total` count bytes
/// across every file this run fetches, so one bar covers the whole of it; `total` moves once,
/// when the bundle's answer says its real length. `file` is the key of the file in hand
/// ([`Due::key`]), and `message` the sentence a failed run ends on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub file: Option<&'static str>,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

/// `scanner_assets`: what this install owes, read from what the session loaded.
///
/// **It asks the status, so it loads the session if nothing has yet** — the page asks
/// `scanner_status` beside it, and the two share the one load. Refused on a page, where the
/// status is ([`crate::scanner::not_in_a_browser_yet`]).
pub fn owed(state: &State) -> Result<Owed, String> {
    owed_from(state, &Source::shipped())
}

fn owed_from(state: &State, source: &Source) -> Result<Owed, String> {
    let rows: Vec<Due> = pieces_owed(state, source)?
        .into_iter()
        .map(|piece| Due {
            key: piece.key(),
            label: piece.label(),
            bytes: source.bytes(piece),
        })
        .collect();
    Ok(Owed {
        bytes: rows.iter().map(|row| row.bytes).sum(),
        owed: rows,
        fetching: state.scanner.fetching.load(Ordering::SeqCst),
    })
}

fn pieces_owed(state: &State, source: &Source) -> Result<Vec<Piece>, String> {
    let status = state.scanner.status()?;
    let carried = state.scanner.carried();
    // **The models on disk are hashed only when the pair did not load** and the binary carries
    // none — the one state in which what is on disk decides anything. A scanner that works is
    // never read twelve megabytes to say so.
    let pair_loaded = status.detection_model.loaded && status.recognition_model.loaded;
    let sound = if carried.models.is_some() || pair_loaded {
        [true, true]
    } else {
        let dir = state.scanner.dir();
        [Piece::Detection, Piece::Recognition].map(|piece| {
            source
                .pinned(piece)
                .is_some_and(|pinned| is_the_pinned_file(&dir.join(piece.place()), pinned))
        })
    };
    Ok(lacking(&status, carried, sound))
}

/// Whether `path` is a file of exactly the pinned length **and** the pinned digest. The length
/// is asked first, of the folder's listing, so a file that is not even the right size is never
/// read.
fn is_the_pinned_file(path: &Path, pinned: &Pinned) -> bool {
    let length = path
        .parent()
        .and_then(|folder| files::listing(folder).ok().flatten())
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry.path == path && entry.kind == files::Kind::File)
        .and_then(|entry| entry.len);
    length == Some(pinned.bytes)
        && files::read(path).is_ok_and(|bytes| sha256_hex(&bytes) == pinned.sha256)
}

/// SHA-256 as lowercase hex — the spelling GitHub's asset digests and `sha256sum` both print.
fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// **Which of the three a fetch would bring**, from what the session loaded and — for the
/// models, when the pair did not load — whether each file on disk is `sound`: there, a file,
/// its exact length and its pinned digest (detection, then recognition).
///
/// * **Nothing the binary carries is ever owed.** A file placed over an embedded copy that did
///   not load is the reader's own to remove — the status says why — and a release build offers
///   no download and makes no request.
/// * **The bundle is owed when none loaded**: absent, or there and not a bundle this build
///   reads — which is what an app update that moved `FORMAT_VERSION` leaves on a phone, where
///   nobody can reach the folder to replace it. A bundle that loaded without its card names is
///   not owed: the names are `corpus.db`'s.
/// * **A model is owed when the pair did not load and that file is not the pinned one** —
///   missing, the wrong length, or the right length and the wrong bytes. The last is what makes
///   an offer that can end: a detection model that is corrupt at its right length is owed
///   beside a missing recognition model, where a rule that went by length owed only the second
///   and failed the pair on every press.
/// * **Two sound files that still did not load owe nothing.** Fetching the same bytes again
///   changes nothing, so the offer would never clear; the status's own sentence says why the
///   pair did not load. (It is also a file placed by hand after the session loaded, which a
///   restart reads and a download would only repeat.)
fn lacking(status: &ScannerStatus, carried: Embedded, sound: [bool; 2]) -> Vec<Piece> {
    let mut owed = Vec::new();
    if carried.bundle.is_none() && !status.bundle.loaded {
        owed.push(Piece::Bundle);
    }
    let pair_loaded = status.detection_model.loaded && status.recognition_model.loaded;
    if carried.models.is_none() && !pair_loaded {
        if !sound[0] {
            owed.push(Piece::Detection);
        }
        if !sound[1] {
            owed.push(Piece::Recognition);
        }
    }
    owed
}

/// The claim on the one fetch a state runs at a time, let go however the run ends — an early
/// return, an error, a dropped future. `combos::RefreshGuard`'s shape, on the state rather than
/// in a static because two states are two installs.
struct Claim<'a>(&'a AtomicBool);

impl<'a> Claim<'a> {
    fn take(flag: &'a AtomicBool) -> Option<Claim<'a>> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Claim(flag))
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Why a fetch stopped: the sentence the page shows, and the kind `error_log` files it under.
///
/// **The sentence names the file and never where it is kept.** On a phone the folder is
/// app-private — `/data/user/0/…` — and a path in a sentence there is noise a reader cannot
/// act on; an I/O error's own words (*Access is denied*, *No space left on device*) carry no
/// path and are kept.
#[derive(Debug)]
struct Refusal {
    kind: Kind,
    sentence: String,
}

impl Refusal {
    fn new(kind: Kind, sentence: String) -> Refusal {
        Refusal { kind, sentence }
    }

    /// The request, or the body, did not arrive.
    fn wire(what: String, e: &http::Error) -> Refusal {
        let kind = if e.is_timeout() {
            Kind::Timeout
        } else {
            Kind::Http
        };
        Refusal::new(kind, format!("{what}: {e}"))
    }

    /// The disk refused.
    fn disk(label: &str, what: &str, e: &std::io::Error) -> Refusal {
        Refusal::new(Kind::Io, format!("{label} could not be {what}: {e}"))
    }
}

/// `scanner_assets_fetch`: download every owed file, check it, put it in place, and let the
/// loaded session go so the next scanner command reads it. Answers what is owed afterwards —
/// nothing, when it worked.
///
/// The module doc has the rules. `Err` is one sentence a page can show; a file that had already
/// landed when a later one failed stays landed, and the session is let go for it all the same.
pub async fn fetch(state: &Arc<State>) -> Result<Owed, String> {
    fetch_from(state, Source::shipped()).await
}

async fn fetch_from(state: &Arc<State>, source: Source) -> Result<Owed, String> {
    crate::scanner::not_in_a_browser_yet()?;
    let Some(_claim) = Claim::take(&state.scanner.fetching) else {
        return Err(ALREADY_FETCHING.to_owned());
    };

    let fetched = fetch_under_claim(state, &source).await;
    match fetched {
        Ok(now) => Ok(now),
        Err(refusal) => {
            crate::events::emit(
                &*state.events,
                PROGRESS_EVENT,
                &Progress {
                    phase: PHASE_ERROR,
                    file: None,
                    done: 0,
                    total: 0,
                    message: Some(refusal.sentence.clone()),
                },
            );
            note_failure(state, &source, refusal.kind, refusal.sentence.clone()).await;
            Err(refusal.sentence)
        }
    }
}

/// One fetch, under the claim: what is owed, each file, the session let go, and what is owed
/// after.
async fn fetch_under_claim(state: &Arc<State>, source: &Source) -> Result<Owed, Refusal> {
    let wanted = {
        let (state, source) = (state.clone(), source.clone());
        off_the_task(move || pieces_owed(&state, &source))
            .await?
            .map_err(|sentence| Refusal::new(Kind::Other, sentence))?
    };
    let mut run = Run {
        state,
        source,
        client: source.client(),
        dir: state.scanner.dir(),
        done: 0,
        total: wanted.iter().map(|piece| source.bytes(*piece)).sum(),
        said: 0,
        landed: 0,
    };
    let fetched = run.all(&wanted).await;

    // The session is let go whenever a file landed, a failed run included: the bundle that
    // arrived before a model failed is usable now, and what is owed next is read from a load
    // that has seen it. Off the task, because `forget` waits behind a frame in flight.
    if run.landed > 0 {
        let state = state.clone();
        off_the_task(move || state.scanner.forget()).await?;
    }
    fetched?;
    run.say(PHASE_DONE, None);
    // Read with the claim still held, so the answer's own `fetching` is put right here.
    let (state, source) = (state.clone(), source.clone());
    let mut now = off_the_task(move || owed_from(&state, &source))
        .await?
        .map_err(|sentence| Refusal::new(Kind::Other, sentence))?;
    now.fetching = false;
    Ok(now)
}

/// A failed fetch into `error_log`, best effort — `combos::note_failure`'s row, and its reason
/// for `Source::Database`: the schema has no source for this host, and the operation names it.
/// The detail is the release's address, the one place a reader sees where the files come from.
///
/// **Why it is recorded at all**: the page that pressed may be gone by the time a fetch fails —
/// it outlives its view — and an event nobody heard is then the only other account of it.
async fn note_failure(state: &Arc<State>, source: &Source, kind: Kind, sentence: String) {
    let (state, base) = (state.clone(), source.base.clone());
    // Off the task, because the ask for the connection waits; skipped rather than waited out if
    // it is busy, as every best-effort row here is.
    let _ = spawn::blocking(move || {
        if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
            crate::errors::record(
                &conn,
                crate::errors::Source::Database,
                ERROR_OPERATION,
                kind,
                &sentence,
                Some(&base),
            );
        }
    })
    .await;
}

/// Work that blocks — a load, a parse, a digest, a model built — off the async task. Work that
/// did not come back is a sentence without the runtime's own account of it, which goes to the
/// log: *task 12 panicked* is nothing a reader can act on.
async fn off_the_task<T, F>(work: F) -> Result<T, Refusal>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    spawn::blocking(work).await.map_err(|lost| {
        eprintln!("scanner_assets: work off the task did not come back: {lost}");
        Refusal::new(
            Kind::Other,
            "The scanner's download could not finish: something went wrong inside the app. Try \
             again."
                .to_owned(),
        )
    })
}

/// `<name>.part` beside `dest`: the name a download is written under until it has been checked.
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// One fetch in flight: where it writes and how far it has got.
struct Run<'a> {
    state: &'a Arc<State>,
    source: &'a Source,
    client: http::Client,
    dir: PathBuf,
    /// Bytes received so far, across every file.
    done: u64,
    /// Bytes this run expects in all.
    total: u64,
    /// The byte count last reported while downloading.
    said: u64,
    /// Files renamed into place.
    landed: u32,
}

impl Run<'_> {
    fn say(&self, phase: &'static str, piece: Option<Piece>) {
        crate::events::emit(
            &*self.state.events,
            PROGRESS_EVENT,
            &Progress {
                phase,
                file: piece.map(Piece::key),
                done: self.done,
                // A body that ran past what was expected has no denominator worth the name.
                total: self.total.max(self.done),
                message: None,
            },
        );
    }

    /// Every file in `wanted`, in order, stopping at the first that fails. The bundle takes its
    /// place as soon as it is checked; the models wait for each other, and take theirs together.
    ///
    /// **Whatever fails, no model's `.part` is left**: one that arrived whole is no use without
    /// its pair's check, and one whose pair was renamed and whose own rename then failed is
    /// 9.7 MB nothing would ever read. Removing a `.part` that was renamed away is a no-op.
    async fn all(&mut self, wanted: &[Piece]) -> Result<(), Refusal> {
        let fetched = self.each(wanted).await;
        if fetched.is_err() {
            for piece in wanted.iter().filter(|piece| **piece != Piece::Bundle) {
                let _ = aio::remove(&part_path(&self.dir.join(piece.place()))).await;
            }
        }
        fetched
    }

    async fn each(&mut self, wanted: &[Piece]) -> Result<(), Refusal> {
        // Before anything is asked of the network: a folder that cannot be made, or something
        // that is not a file where a file has to go, fails every press the same way — so it is
        // said now, for nothing, and not after eighteen megabytes.
        for &piece in wanted {
            self.has_room(piece).await?;
        }
        let mut models: Vec<Piece> = Vec::new();
        for &piece in wanted {
            let dest = self.dir.join(piece.place());
            let part = part_path(&dest);
            self.say(PHASE_DOWNLOADING, Some(piece));
            let checked = match self.download(piece, &part).await {
                Ok(()) => {
                    self.say(PHASE_CHECKING, Some(piece));
                    self.is_what_it_should_be(piece, &part).await
                }
                Err(refusal) => Err(refusal),
            };
            if let Err(refusal) = checked {
                let _ = aio::remove(&part).await;
                return Err(refusal);
            }
            match piece {
                Piece::Bundle => self.place(piece, &part, &dest).await?,
                Piece::Detection | Piece::Recognition => models.push(piece),
            }
        }
        if models.is_empty() {
            return Ok(());
        }
        self.say(PHASE_CHECKING, models.last().copied());
        self.pair_loads(&models).await?;
        for piece in models {
            let dest = self.dir.join(piece.place());
            self.place(piece, &part_path(&dest), &dest).await?;
        }
        Ok(())
    }

    /// Whether `piece` has somewhere to go: its folder there (made if it was not), and nothing
    /// but a file — or nothing — where it will be put.
    async fn has_room(&self, piece: Piece) -> Result<(), Refusal> {
        let dest = self.dir.join(piece.place());
        if let Some(folder) = dest.parent() {
            aio::create_dir_all(folder).await.map_err(|e| {
                Refusal::disk(piece.label(), "saved — its folder could not be made", &e)
            })?;
        }
        if files::exists(&dest) && !files::is_file(&dest) {
            return Err(Refusal::new(
                Kind::Io,
                format!(
                    "{} cannot be saved: something that is not a file is where it belongs.",
                    piece.label()
                ),
            ));
        }
        Ok(())
    }

    /// One file from the release into `part`, whole and of a believable length, or a refusal.
    /// The caller removes `part` on one.
    async fn download(&mut self, piece: Piece, part: &Path) -> Result<(), Refusal> {
        let name = piece.asset();
        let url = format!("{}/{name}", self.source.base);
        let answer = self
            .client
            .get(&url)
            .send_within(self.source.stall)
            .await
            .map_err(|e| Refusal::wire(format!("Couldn't reach the download for {name}"), &e))?;
        match answer.status() {
            200 => {}
            404 => {
                return Err(Refusal::new(
                    Kind::Http,
                    format!("{name} is not published for this version of the app (HTTP 404)."),
                ))
            }
            status => {
                return Err(Refusal::new(
                    Kind::Http,
                    format!("The download for {name} answered HTTP {status}."),
                ))
            }
        }

        // What the answer claims, held to what the file must be before a byte of it is read: a
        // model is one exact length, and the bundle is under its ceiling. A claim is all it is
        // — a chunked answer makes none — so the count as the body arrives is the one that
        // holds (`Run::write`).
        let declared = answer.content_length();
        let exact = self.source.pinned(piece).map(|pinned| pinned.bytes);
        match (declared, exact) {
            (Some(declared), Some(exact)) if declared != exact => {
                return Err(wrong_length(name, declared, exact));
            }
            (Some(declared), None) if declared > self.source.bundle_ceiling => {
                return Err(too_large(name));
            }
            _ => {}
        }
        // The bundle's size is a measurement until its answer says what it is today.
        if let (Piece::Bundle, Some(declared)) = (piece, declared) {
            self.total = self.total - self.source.bytes(piece).min(self.total) + declared;
        }

        // `create` empties a `.part` an earlier run left: nothing is resumed.
        let mut file = aio::Writer::create(part)
            .await
            .map_err(|e| Refusal::disk(piece.label(), "written", &e))?;
        let mut received = 0u64;
        let mut body = answer.into_body();
        let written = self
            .write(piece, &mut body, &mut file, &mut received, exact)
            .await;
        // Settled and let go before anything is said of it, on a failure too: the caller deletes
        // a refused `.part`, and a write still on its way to the disk is a file still open.
        let _ = file.flush().await;
        file.close();
        written?;

        // A body that ended short of what it declared never reaches here: the transport ends
        // it as an error, which `write` has already answered with. What is left to hold is a
        // model whose answer declared nothing.
        if let Some(exact) = exact.filter(|exact| *exact != received) {
            return Err(wrong_length(name, received, exact));
        }
        Ok(())
    }

    /// The body into the open `.part`, a chunk at a time, counted against what the file may be
    /// and made durable at its end. `received` is the caller's, so it has the count on a
    /// failure too.
    ///
    /// **The count is checked before the chunk is written**, so a body that runs past a model's
    /// length or the bundle's ceiling stops there: at most one chunk more than the limit is
    /// ever held, and none of it past the limit reaches the disk.
    async fn write(
        &mut self,
        piece: Piece,
        body: &mut http::Body,
        file: &mut aio::Writer,
        received: &mut u64,
        exact: Option<u64>,
    ) -> Result<(), Refusal> {
        let name = piece.asset();
        let ceiling = exact.unwrap_or(self.source.bundle_ceiling);
        while let Some(chunk) = body.chunk_within(self.source.stall).await {
            let chunk = chunk.map_err(|e| {
                Refusal::wire(format!("The download for {name} stopped partway"), &e)
            })?;
            *received += chunk.len() as u64;
            if *received > ceiling {
                return Err(match exact {
                    Some(exact) => wrong_length(name, *received, exact),
                    None => too_large(name),
                });
            }
            file.write_all(&chunk)
                .await
                .map_err(|e| Refusal::disk(piece.label(), "written", &e))?;
            self.done += chunk.len() as u64;
            if self.done.saturating_sub(self.said) >= PROGRESS_STEP {
                self.said = self.done;
                self.say(PHASE_DOWNLOADING, Some(piece));
            }
        }
        file.flush()
            .await
            .map_err(|e| Refusal::disk(piece.label(), "written", &e))?;
        // On the disk before it is checked and renamed: the rename is what makes it the file a
        // load reads, and it must not be a name over bytes still in the system's cache.
        file.sync_all()
            .await
            .map_err(|e| Refusal::disk(piece.label(), "written", &e))
    }

    /// The file at `part`, held to what its kind must be: the bundle parses and names at least
    /// one card; a model is the pinned one, by its digest — before any loader has seen it.
    async fn is_what_it_should_be(&self, piece: Piece, part: &Path) -> Result<(), Refusal> {
        let (part, name, label) = (part.to_owned(), piece.asset(), piece.label());
        let pinned = self.source.pinned(piece).cloned();
        off_the_task(move || {
            let bytes = files::read(&part).map_err(|e| Refusal::disk(label, "read back", &e))?;
            match pinned {
                Some(pinned) => {
                    if sha256_hex(&bytes) == pinned.sha256 {
                        Ok(())
                    } else {
                        Err(Refusal::new(
                            Kind::Parse,
                            format!(
                                "{name} is not the file this app expects — its SHA-256 does not \
                                 match — so it was not kept."
                            ),
                        ))
                    }
                }
                None => bundle_is_usable(&bytes),
            }
        })
        .await?
    }

    /// Both models as the pair a load will read — each from its `.part` if this run fetched it,
    /// and from its place if it was already there — built into a reader, or a refusal.
    async fn pair_loads(&self, fetched: &[Piece]) -> Result<(), Refusal> {
        let path_of = |piece: Piece| {
            let dest = self.dir.join(piece.place());
            if fetched.contains(&piece) {
                part_path(&dest)
            } else {
                dest
            }
        };
        let (detection, recognition) = (path_of(Piece::Detection), path_of(Piece::Recognition));
        let readable = self.source.readable;
        off_the_task(move || {
            let read = |piece: Piece, path: &Path| {
                files::read(path).map_err(|e| Refusal::disk(piece.label(), "read back", &e))
            };
            let (detection, recognition) = (
                read(Piece::Detection, &detection)?,
                read(Piece::Recognition, &recognition)?,
            );
            readable(&detection, &recognition).map_err(|e| {
                Refusal::new(
                    Kind::Parse,
                    format!("The OCR models that arrived did not load: {e}"),
                )
            })
        })
        .await?
    }

    /// `part` to `dest`, replacing what was there — the moment a download becomes a file a load
    /// reads.
    async fn place(&mut self, piece: Piece, part: &Path, dest: &Path) -> Result<(), Refusal> {
        if let Err(e) = aio::rename(part, dest).await {
            let _ = aio::remove(part).await;
            return Err(Refusal::disk(piece.label(), "put in place", &e));
        }
        self.landed += 1;
        Ok(())
    }
}

/// Whether `bytes` is a bundle worth putting in place: `Bundle::from_bytes` — the magic, this
/// build's format version, the length its own header declares — and **at least one entry**.
///
/// A header with nothing behind it parses. Put in place it would load, name no card, and never
/// be owed again, because what is owed is what did not load: a scanner that is permanently,
/// silently empty. The publishing workflow refuses to upload a bundle that shrank by a
/// hundredth; this is the same fence at the other end, for whatever else might answer.
fn bundle_is_usable(bytes: &[u8]) -> Result<(), Refusal> {
    let not_a_bundle = |why: String| {
        Refusal::new(
            Kind::Parse,
            format!("The card hashes that arrived are not a bundle this app reads: {why}."),
        )
    };
    let bundle = Bundle::from_bytes(bytes).map_err(|e| not_a_bundle(e.to_string()))?;
    if bundle.section(Section::Card).is_empty() && bundle.section(Section::Art).is_empty() {
        return Err(not_a_bundle("it holds no cards".to_owned()));
    }
    Ok(())
}

fn wrong_length(name: &str, got: u64, expected: u64) -> Refusal {
    Refusal::new(
        Kind::Parse,
        format!("{name} is {got} bytes where {expected} were expected, so it was not kept."),
    )
}

fn too_large(name: &str) -> Refusal {
    Refusal::new(
        Kind::Parse,
        format!("{name} is larger than this app will download, so it was not kept."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::fixtures::Recording;
    use crate::scanner::{AssetSource, NOT_IN_A_BROWSER_YET};
    use httpmock::prelude::*;
    use serde_json::Value;
    use std::sync::atomic::AtomicUsize;

    /// The two stand-in models: nine bytes and eleven, so a test serves them in a line.
    const DETECTION: &[u8] = b"detection";
    const RECOGNITION: &[u8] = b"recognition";

    /// A bundle that parses, with one entry — so a byte cut off its end is a truncation its own
    /// header gives away, and it is not the header-only bundle a fetch refuses.
    fn tiny_bundle() -> Vec<u8> {
        let mut builder = card_scanner::index::BundleBuilder::new(
            card_scanner::hash::HashKind::DHashChroma32,
            256,
        );
        builder.push(
            Section::Card,
            card_scanner::index::parse_uuid("f29ba16f-c8fb-42fe-aabf-87089cb214a7")
                .expect("a uuid"),
            &card_scanner::hash::Descriptor {
                words: [1, 2, 3, 4],
                bits: 256,
            },
        );
        builder.finish(0).to_bytes()
    }

    /// A bundle that parses and holds nothing: thirty-two bytes of header.
    fn empty_bundle() -> Vec<u8> {
        card_scanner::index::BundleBuilder::new(card_scanner::hash::HashKind::DHashChroma32, 256)
            .finish(0)
            .to_bytes()
    }

    /// A source at `base` whose models are the stand-ins — pinned by their own digests, as the
    /// shipped ones are by theirs — and "load" when they are byte for byte those. Plain HTTP,
    /// because a local server is.
    fn source(base: String) -> Source {
        Source {
            base,
            https_only: false,
            stall: Duration::from_secs(5),
            bundle_bytes: tiny_bundle().len() as u64,
            bundle_ceiling: 4096,
            detection: Pinned {
                bytes: DETECTION.len() as u64,
                sha256: sha256_hex(DETECTION),
            },
            recognition: Pinned {
                bytes: RECOGNITION.len() as u64,
                sha256: sha256_hex(RECOGNITION),
            },
            readable: |detection, recognition| {
                if detection == DETECTION && recognition == RECOGNITION {
                    Ok(())
                } else {
                    Err("not the pair".to_owned())
                }
            },
        }
    }

    /// A release serving `bundle` and the two models under their flat names.
    fn release<'a>(
        server: &'a MockServer,
        bundle: &[u8],
        detection: &[u8],
        recognition: &[u8],
    ) -> [httpmock::Mock<'a>; 3] {
        let serve = |name: &str, body: &[u8]| {
            let (path, body) = (format!("/v3/{name}"), body.to_vec());
            server.mock(move |when, then| {
                when.method(GET).path(path);
                then.status(200).body(body);
            })
        };
        [
            serve("card-hashes.bin", bundle),
            serve("text-detection.rten", detection),
            serve("text-recognition.rten", recognition),
        ]
    }

    /// **A host that answers in bytes a test wrote out itself** — what `httpmock` cannot be:
    /// it always declares a `Content-Length`, so a body with none (chunked), a body that runs
    /// past what a file may be, and a body that ends short of what it declared are all out of
    /// its reach. `feed::quiet_host`'s shape, with a route per file. Each connection is one
    /// request, answered and closed.
    mod raw_host {
        use std::io::{Read as _, Write as _};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        /// What happens as a request for a path arrives, before it is answered.
        pub(super) type Hook = Box<dyn Fn(&str) + Send + Sync>;

        pub(super) struct Host {
            pub(super) base: String,
            /// Requests answered or refused — every one that reached the listener.
            pub(super) asked: Arc<AtomicUsize>,
        }

        /// `200 OK` with no `Content-Length`: the body in chunks of `size`.
        pub(super) fn chunked(body: &[u8], size: usize) -> Vec<u8> {
            let mut out =
                b"HTTP/1.1 200 OK\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n"
                    .to_vec();
            for chunk in body.chunks(size) {
                out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                out.extend_from_slice(chunk);
                out.extend_from_slice(b"\r\n");
            }
            out.extend_from_slice(b"0\r\n\r\n");
            out
        }

        /// `200 OK` declaring `declared` bytes and carrying `body` — the whole of it when the
        /// two agree, and a body that ends early when they do not.
        pub(super) fn declaring(declared: usize, body: &[u8]) -> Vec<u8> {
            let mut out = format!(
                "HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: {declared}\r\n\r\n"
            )
            .into_bytes();
            out.extend_from_slice(body);
            out
        }

        /// Start one. A path is matched by how it ends; one no route matches is a 404.
        pub(super) fn start(routes: Vec<(&'static str, Vec<u8>)>, hook: Option<Hook>) -> Host {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
            let addr = listener.local_addr().expect("its address");
            let asked = Arc::new(AtomicUsize::new(0));
            let (routes, hook, counted) = (Arc::new(routes), Arc::new(hook), asked.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let (routes, hook, counted) = (routes.clone(), hook.clone(), counted.clone());
                    std::thread::spawn(move || {
                        let _ = stream.set_nodelay(true);
                        let mut head = [0u8; 4096];
                        let read = stream.read(&mut head).unwrap_or(0);
                        let request = String::from_utf8_lossy(&head[..read]).into_owned();
                        let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
                        counted.fetch_add(1, Ordering::SeqCst);
                        if let Some(hook) = hook.as_ref() {
                            hook(&path);
                        }
                        let answer = routes
                            .iter()
                            .find(|(ending, _)| path.ends_with(ending))
                            .map(|(_, bytes)| bytes.clone())
                            .unwrap_or_else(|| {
                                b"HTTP/1.1 404 Not Found\r\nconnection: close\r\n\
                                  content-length: 0\r\n\r\n"
                                    .to_vec()
                            });
                        let _ = stream.write_all(&answer);
                        let _ = stream.flush();
                        // Closed here: a body that declared more than it carried ends now.
                    });
                }
            });
            Host {
                base: format!("http://{addr}/v3"),
                asked,
            }
        }
    }

    /// Every file under `<data>/scanner/`, by its path from there, sorted — `.part`s and all.
    fn in_place(dir: &Path) -> Vec<String> {
        fn walk(root: &Path, at: &Path, out: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(at) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    let rel = path.strip_prefix(root).expect("under the root");
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        let mut out = Vec::new();
        walk(&dir.join("scanner"), &dir.join("scanner"), &mut out);
        out.sort();
        out
    }

    const ALL_THREE: [&str; 3] = [
        "card-hashes.bin",
        "models/text-detection.rten",
        "models/text-recognition.rten",
    ];

    /// The `scanner:assets` events among what was heard, as `(phase, file, done, total)`.
    fn said(heard: &Recording) -> Vec<(String, Option<String>, u64, u64)> {
        heard
            .taken()
            .into_iter()
            .filter(|(name, _)| name == PROGRESS_EVENT)
            .map(|(_, p)| {
                (
                    p["phase"].as_str().expect("a phase").to_owned(),
                    p["file"].as_str().map(str::to_owned),
                    p["done"].as_u64().expect("done"),
                    p["total"].as_u64().expect("total"),
                )
            })
            .collect()
    }

    fn keys(owed: &Owed) -> Vec<&'static str> {
        owed.owed.iter().map(|row| row.key).collect()
    }

    /// `error_log`'s rows for this module's operation: `(source, kind, message, detail, count)`.
    fn logged(state: &State) -> Vec<(String, String, String, Option<String>, i64)> {
        let conn = state.lock_db_read();
        let mut stmt = conn
            .prepare(
                "SELECT source, kind, message, detail, count FROM error_log
                  WHERE operation = ?1 ORDER BY id",
            )
            .expect("the error log");
        let rows = stmt
            .query_map([ERROR_OPERATION], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .expect("its rows");
        rows.collect::<rusqlite::Result<_>>().expect("read")
    }

    /// **The whole of it**: an install with nothing owes three files at their sizes; the fetch
    /// lands all three under the names a load reads, leaves no temporary file, says how far it
    /// got in order, and — with no restart — the session that had loaded empty reads them.
    #[tokio::test]
    async fn a_fetch_lands_the_three_files_and_the_session_reads_them_without_a_restart() {
        let server = MockServer::start();
        let bundle = tiny_bundle();
        let mocks = release(&server, &bundle, DETECTION, RECOGNITION);
        let source = source(server.url("/v3"));
        let (state, heard, dir) = crate::state::fixtures::listening("scanner-assets-happy");

        // Loaded empty, as a phone's first open of the scanner is.
        let before = state.scanner.status().expect("status");
        assert_eq!(before.bundle.source, AssetSource::Absent);
        let owed = owed_from(&state, &source).expect("owed");
        assert_eq!(
            keys(&owed),
            ["bundle", "detectionModel", "recognitionModel"]
        );
        let total = (bundle.len() + DETECTION.len() + RECOGNITION.len()) as u64;
        assert_eq!(owed.bytes, total);
        assert!(!owed.fetching);
        assert!(owed.owed.iter().all(|row| !row.label.is_empty()));

        let after = fetch_from(&state, source.clone()).await.expect("a fetch");
        for mock in &mocks {
            mock.assert_calls(1);
        }
        assert_eq!(in_place(&dir), ALL_THREE, "the three files and no `.part`");
        let scanner = dir.join("scanner");
        assert_eq!(std::fs::read(scanner.join(BUNDLE_FILE)).unwrap(), bundle);
        assert_eq!(
            std::fs::read(scanner.join(DETECTION_MODEL)).unwrap(),
            DETECTION
        );
        assert_eq!(
            std::fs::read(scanner.join(RECOGNITION_MODEL)).unwrap(),
            RECOGNITION
        );

        // The same state, no restart: `forget` was called, so the status is a fresh load's.
        let status = state.scanner.status().expect("status");
        assert_eq!(status.bundle.source, AssetSource::File);
        assert!(status.bundle.loaded, "{status:?}");
        for model in [&status.detection_model, &status.recognition_model] {
            assert_eq!(model.source, AssetSource::File);
            assert!(model.present);
        }
        // Nothing is owed: the bundle loaded, and each model on disk is the pinned one. (The
        // stand-ins are not models, so the session's own loader refuses the pair — and two
        // sound files that did not load owe nothing, because fetching them again changes
        // nothing.)
        assert_eq!(keys(&after), Vec::<&str>::new());
        assert!(!after.fetching);
        assert!(
            logged(&state).is_empty(),
            "a fetch that worked logs nothing"
        );

        let events = said(&heard);
        let phases: Vec<&str> = events.iter().map(|e| e.0.as_str()).collect();
        assert_eq!(
            phases,
            [
                "downloading",
                "checking",
                "downloading",
                "checking",
                "downloading",
                "checking",
                "checking",
                "done"
            ]
        );
        let files: Vec<Option<&str>> = events.iter().map(|e| e.1.as_deref()).collect();
        assert_eq!(
            files,
            [
                Some("bundle"),
                Some("bundle"),
                Some("detectionModel"),
                Some("detectionModel"),
                Some("recognitionModel"),
                Some("recognitionModel"),
                Some("recognitionModel"),
                None
            ]
        );
        assert!(
            events.windows(2).all(|pair| pair[0].2 <= pair[1].2),
            "the count never goes back: {events:?}"
        );
        assert_eq!(
            events.last().map(|e| (e.2, e.3)),
            Some((total, total)),
            "it ends on the whole of it"
        );
    }

    /// **A bundle that is not published is one sentence, a row in the error log, and nothing on
    /// the disk** — and the run stops there: the models are not asked for behind a failure.
    #[tokio::test]
    async fn a_file_the_release_does_not_have_leaves_nothing_and_says_so() {
        let server = MockServer::start();
        let gone = server.mock(|when, then| {
            when.method(GET).path("/v3/card-hashes.bin");
            then.status(404).body("Not Found");
        });
        let models = server.mock(|when, then| {
            when.method(GET).path_includes(".rten");
            then.status(200).body(DETECTION);
        });
        let (state, heard, dir) = crate::state::fixtures::listening("scanner-assets-404");
        let base = server.url("/v3");

        let refused = fetch_from(&state, source(base.clone())).await.unwrap_err();
        assert_eq!(
            refused,
            "card-hashes.bin is not published for this version of the app (HTTP 404)."
        );
        gone.assert_calls(1);
        models.assert_calls(0);
        assert_eq!(in_place(&dir), Vec::<String>::new());
        assert!(!state.scanner.fetching.load(Ordering::SeqCst));

        let events = heard.taken();
        let (name, last) = events.last().expect("a last word");
        assert_eq!(name, PROGRESS_EVENT);
        assert_eq!(last["phase"], "error");
        assert_eq!(last["message"], Value::String(refused.clone()));

        // **Recorded where a reader who was not looking can find it**: the feeds' row — the
        // operation names this fetch, the kind is the wire's, the detail is where it asked.
        assert_eq!(
            logged(&state),
            [(
                "database".to_owned(),
                "http".to_owned(),
                refused.clone(),
                Some(base.clone()),
                1
            )]
        );
        // The same failure again folds into the same row.
        assert_eq!(fetch_from(&state, source(base)).await.unwrap_err(), refused);
        assert_eq!(logged(&state).len(), 1);
        assert_eq!(logged(&state)[0].4, 2);

        // Any other status is its own sentence, and as empty-handed.
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/v3/card-hashes.bin");
            then.status(503);
        });
        let refused = fetch_from(&state, source(server.url("/v3")))
            .await
            .unwrap_err();
        assert_eq!(
            refused,
            "The download for card-hashes.bin answered HTTP 503."
        );
        assert_eq!(in_place(&dir), Vec::<String>::new());
    }

    /// **A body that stops arriving is given up on, and its half is deleted.** The host declares
    /// a hundred bytes, sends fifty and holds the connection open — the failure nothing but the
    /// stall bound ends. Logged as a timeout, which is what it is.
    #[tokio::test]
    async fn a_download_that_stops_partway_is_given_up_on_and_leaves_nothing() {
        let quiet = crate::feed::quiet_host::start(vec![7u8; 50], 100);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-short");
        let mut source = source(quiet);
        source.stall = Duration::from_millis(200);

        let refused = fetch_from(&state, source).await.unwrap_err();
        assert!(
            refused.starts_with("The download for card-hashes.bin stopped partway: "),
            "{refused}"
        );
        assert!(refused.contains("stalled"), "{refused}");
        assert_eq!(in_place(&dir), Vec::<String>::new());
        assert!(!state.scanner.fetching.load(Ordering::SeqCst));
        assert_eq!(logged(&state)[0].1, "timeout");
    }

    /// **A body that ends short of what it declared is the transport's failure, and nothing of
    /// it is kept** — the connection closed fifty bytes into a hundred. This is the one way a
    /// declared length and a received one part company, so no later check has to ask.
    #[tokio::test]
    async fn a_body_that_ends_short_of_what_it_declared_leaves_nothing() {
        let host = raw_host::start(
            vec![("card-hashes.bin", raw_host::declaring(100, &[7u8; 50]))],
            None,
        );
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-cut");
        let refused = fetch_from(&state, source(host.base)).await.unwrap_err();
        assert!(
            refused.starts_with("The download for card-hashes.bin stopped partway: "),
            "{refused}"
        );
        assert_eq!(in_place(&dir), Vec::<String>::new());
        assert_eq!(host.asked.load(Ordering::SeqCst), 1);
    }

    /// **A file that is not a usable bundle is never given the bundle's name.** Wrong magic; a
    /// real bundle cut short, which its own header's length gives away; and a bundle that
    /// parses and holds no card at all — which would load, name nothing, and never be owed
    /// again.
    #[tokio::test]
    async fn a_bundle_that_does_not_parse_or_holds_nothing_is_not_put_in_place() {
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-magic");
        let mut cut = tiny_bundle();
        cut.truncate(cut.len() - 1);
        assert!(Bundle::from_bytes(&empty_bundle()).is_ok());
        for (body, why) in [
            (b"<html>not a bundle at all</html>".to_vec(), "bad magic"),
            (cut, "truncated"),
            (empty_bundle(), "it holds no cards"),
        ] {
            let server = MockServer::start();
            let mocks = release(&server, &body, DETECTION, RECOGNITION);
            let refused = fetch_from(&state, source(server.url("/v3")))
                .await
                .unwrap_err();
            assert!(
                refused
                    .starts_with("The card hashes that arrived are not a bundle this app reads: "),
                "{refused}"
            );
            assert!(refused.contains(why), "{refused}");
            mocks[0].assert_calls(1);
            mocks[1].assert_calls(0);
            assert_eq!(in_place(&dir), Vec::<String>::new());
        }
        // Nothing landed, so the session was not let go for nothing.
        assert!(state.scanner.is_loaded());
        assert!(logged(&state).iter().all(|row| row.1 == "parse"));
    }

    /// **A bundle is counted against its ceiling as it arrives**, whatever its answer declared:
    /// one that declares too much is refused before a byte is read, and one that declares
    /// nothing — a chunked answer — is stopped at the ceiling, with nothing kept.
    #[tokio::test]
    async fn a_bundle_past_its_ceiling_is_refused_declared_or_not() {
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-ceiling");
        let too_large =
            "card-hashes.bin is larger than this app will download, so it was not kept.";
        let over = vec![9u8; 5000];

        // Declared: `httpmock` says how long its body is.
        let server = MockServer::start();
        let declared = server.mock(|when, then| {
            when.method(GET).path("/v3/card-hashes.bin");
            then.status(200).body(over.clone());
        });
        let source_at = |base: String| {
            let source = source(base);
            assert!((over.len() as u64) > source.bundle_ceiling);
            source
        };
        assert_eq!(
            fetch_from(&state, source_at(server.url("/v3")))
                .await
                .unwrap_err(),
            too_large
        );
        declared.assert_calls(1);
        assert_eq!(in_place(&dir), Vec::<String>::new());

        // Not declared: the count as the body arrives is the only fence there is.
        let host = raw_host::start(
            vec![("card-hashes.bin", raw_host::chunked(&over, 512))],
            None,
        );
        assert_eq!(
            fetch_from(&state, source_at(host.base)).await.unwrap_err(),
            too_large
        );
        assert_eq!(in_place(&dir), Vec::<String>::new());

        // And a bundle with no declared length that is under the ceiling lands: the answer
        // that says nothing of its size is still a download.
        let host = raw_host::start(
            vec![
                ("card-hashes.bin", raw_host::chunked(&tiny_bundle(), 16)),
                ("text-detection.rten", raw_host::chunked(DETECTION, 4)),
                ("text-recognition.rten", raw_host::chunked(RECOGNITION, 4)),
            ],
            None,
        );
        fetch_from(&state, source_at(host.base))
            .await
            .expect("a chunked release");
        assert_eq!(in_place(&dir), ALL_THREE);
    }

    /// **A model is one exact length, by what the answer declares or by what arrived** — and
    /// the bundle that landed before it stays landed and is read at once, so the next press
    /// owes the models and nothing else.
    #[tokio::test]
    async fn a_model_of_the_wrong_length_is_refused_and_the_bundle_before_it_is_kept() {
        let server = MockServer::start();
        let bundle = tiny_bundle();
        let mocks = release(&server, &bundle, b"detect", RECOGNITION);
        let source = source(server.url("/v3"));
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-length");
        assert!(!state.scanner.status().expect("status").bundle.loaded);

        let refused = fetch_from(&state, source.clone()).await.unwrap_err();
        assert_eq!(
            refused,
            "text-detection.rten is 6 bytes where 9 were expected, so it was not kept."
        );
        mocks[2].assert_calls(0);
        assert_eq!(in_place(&dir), ["card-hashes.bin"]);
        // No restart: the bundle is loaded, and what is owed is read from that.
        assert!(state.scanner.status().expect("status").bundle.loaded);
        let owed = owed_from(&state, &source).expect("owed");
        assert_eq!(keys(&owed), ["detectionModel", "recognitionModel"]);

        // With no length declared, a model that ends short is refused on what arrived…
        let host = raw_host::start(
            vec![("text-detection.rten", raw_host::chunked(b"detec", 2))],
            None,
        );
        assert_eq!(
            fetch_from(&state, self::source(host.base))
                .await
                .unwrap_err(),
            "text-detection.rten is 5 bytes where 9 were expected, so it was not kept."
        );
        // …and one that runs on is stopped as it passes its length, never read to its end.
        let host = raw_host::start(
            vec![("text-detection.rten", raw_host::chunked(&[b'd'; 4000], 10))],
            None,
        );
        let refused = fetch_from(&state, self::source(host.base))
            .await
            .unwrap_err();
        assert!(
            refused.starts_with("text-detection.rten is ")
                && refused.ends_with(" bytes where 9 were expected, so it was not kept."),
            "{refused}"
        );
        // The count in the sentence is where it was stopped: a chunk or so in, not the four
        // thousand bytes the host had to give.
        let stopped_at: u64 = refused
            .split_whitespace()
            .nth(2)
            .and_then(|count| count.parse().ok())
            .expect("the count");
        assert!(stopped_at > 9 && stopped_at < 4000, "{refused}");
        assert_eq!(in_place(&dir), ["card-hashes.bin"]);
    }

    static LOADS_OF_AN_UNPINNED_MODEL: AtomicUsize = AtomicUsize::new(0);

    /// **A model that is not byte for byte the pinned one is refused before any loader sees
    /// it** — the right length and the wrong contents, which no length check tells apart. The
    /// loader here counts its calls, and is never called.
    #[tokio::test]
    async fn a_model_whose_digest_is_wrong_is_refused_before_the_loader_sees_it() {
        fn counted(_: &[u8], _: &[u8]) -> Result<(), String> {
            LOADS_OF_AN_UNPINNED_MODEL.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        let server = MockServer::start();
        // Eleven bytes, as the recognition model is, and not it.
        let mocks = release(&server, &tiny_bundle(), DETECTION, b"RECOGNITION");
        let mut source = source(server.url("/v3"));
        source.readable = counted;
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-digest");

        let refused = fetch_from(&state, source).await.unwrap_err();
        assert_eq!(
            refused,
            "text-recognition.rten is not the file this app expects — its SHA-256 does not \
             match — so it was not kept."
        );
        mocks[1].assert_calls(1);
        mocks[2].assert_calls(1);
        assert_eq!(LOADS_OF_AN_UNPINNED_MODEL.load(Ordering::SeqCst), 0);
        // Neither model is kept — the detection model that arrived whole and sound included.
        assert_eq!(in_place(&dir), ["card-hashes.bin"]);
        assert_eq!(logged(&state)[0].1, "parse");
    }

    /// **A pinned pair that still does not build a reader is refused too, and neither is
    /// kept** — and the press after that, against a loader that takes them, lands the two.
    #[tokio::test]
    async fn a_pair_that_does_not_load_is_not_put_in_place() {
        let server = MockServer::start();
        let bundle = tiny_bundle();
        let mocks = release(&server, &bundle, DETECTION, RECOGNITION);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-pair");
        let mut refusing = source(server.url("/v3"));
        refusing.readable = |_, _| Err("not the pair".to_owned());

        let refused = fetch_from(&state, refusing).await.unwrap_err();
        assert_eq!(
            refused,
            "The OCR models that arrived did not load: not the pair"
        );
        assert_eq!(in_place(&dir), ["card-hashes.bin"]);

        fetch_from(&state, source(server.url("/v3")))
            .await
            .expect("the models");
        mocks[0].assert_calls(1);
        mocks[1].assert_calls(2);
        mocks[2].assert_calls(2);
        assert_eq!(in_place(&dir), ALL_THREE);
    }

    /// **Only the model that is missing is fetched, and it is checked against the one already
    /// there.** A fetch a network dropped after its first model leaves this.
    #[tokio::test]
    async fn one_missing_model_is_fetched_alone_and_checked_with_its_pair() {
        let server = MockServer::start();
        let mocks = release(&server, &tiny_bundle(), DETECTION, RECOGNITION);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-one");
        let scanner = dir.join("scanner");
        std::fs::create_dir_all(scanner.join("models")).unwrap();
        std::fs::write(scanner.join(BUNDLE_FILE), tiny_bundle()).unwrap();
        std::fs::write(scanner.join(DETECTION_MODEL), DETECTION).unwrap();
        let source = source(server.url("/v3"));
        assert_eq!(
            keys(&owed_from(&state, &source).expect("owed")),
            ["recognitionModel"]
        );

        fetch_from(&state, source).await.expect("a fetch");
        mocks[0].assert_calls(0);
        mocks[1].assert_calls(0);
        mocks[2].assert_calls(1);
        assert_eq!(
            std::fs::read(scanner.join(RECOGNITION_MODEL)).unwrap(),
            RECOGNITION
        );
    }

    /// **An offer that can end.** A detection model on disk at its right length and the wrong
    /// bytes, beside a missing recognition model: a rule that went by length owed only the
    /// second, failed the pair, deleted what it fetched and offered the same 9.7 MB for ever.
    /// By digest the first is owed too, one press fetches both, and nothing is owed after.
    #[tokio::test]
    async fn a_model_that_is_the_right_length_and_the_wrong_bytes_is_owed_and_replaced() {
        let server = MockServer::start();
        let mocks = release(&server, &tiny_bundle(), DETECTION, RECOGNITION);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-corrupt");
        let scanner = dir.join("scanner");
        std::fs::create_dir_all(scanner.join("models")).unwrap();
        std::fs::write(scanner.join(BUNDLE_FILE), tiny_bundle()).unwrap();
        std::fs::write(scanner.join(DETECTION_MODEL), b"DETECTION").unwrap();
        let source = source(server.url("/v3"));
        assert_eq!(
            keys(&owed_from(&state, &source).expect("owed")),
            ["detectionModel", "recognitionModel"]
        );

        let after = fetch_from(&state, source.clone()).await.expect("a fetch");
        mocks[0].assert_calls(0);
        mocks[1].assert_calls(1);
        mocks[2].assert_calls(1);
        assert_eq!(
            std::fs::read(scanner.join(DETECTION_MODEL)).unwrap(),
            DETECTION
        );
        assert_eq!(keys(&after), Vec::<&str>::new());
        assert_eq!(
            keys(&owed_from(&state, &source).expect("owed")),
            Vec::<&str>::new()
        );
    }

    /// **Something that is not a file where a file belongs is a sentence, for nothing** — said
    /// before any host is asked, on every press, where it would otherwise be eighteen megabytes
    /// downloaded to fail at the rename. A folder under a model's name, and a file under the
    /// models' folder's.
    #[tokio::test]
    async fn a_place_a_file_cannot_take_is_said_before_anything_is_asked() {
        let host = raw_host::start(Vec::new(), None);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-room");
        let scanner = dir.join("scanner");
        std::fs::create_dir_all(scanner.join(DETECTION_MODEL)).unwrap();
        let source = source(host.base.clone());
        assert_eq!(
            keys(&owed_from(&state, &source).expect("owed")),
            ["bundle", "detectionModel", "recognitionModel"]
        );
        for _ in 0..2 {
            assert_eq!(
                fetch_from(&state, source.clone()).await.unwrap_err(),
                "Text detection model cannot be saved: something that is not a file is where \
                 it belongs."
            );
        }
        assert_eq!(host.asked.load(Ordering::SeqCst), 0, "nothing was asked");
        assert_eq!(in_place(&dir), Vec::<String>::new());
        assert_eq!(logged(&state)[0].1, "io");

        // The models' folder, as a file.
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-room-file");
        let scanner = dir.join("scanner");
        std::fs::create_dir_all(&scanner).unwrap();
        std::fs::write(scanner.join("models"), b"not a folder").unwrap();
        let refused = fetch_from(&state, source.clone()).await.unwrap_err();
        assert!(
            refused.starts_with(
                "Text detection model could not be saved — its folder could not be made: "
            ),
            "{refused}"
        );
        assert!(
            !refused.contains(&dir.display().to_string()),
            "the sentence names an app-private path: {refused}"
        );
        assert_eq!(host.asked.load(Ordering::SeqCst), 0, "nothing was asked");
        assert_eq!(in_place(&dir), ["models"]);
    }

    /// **A rename that fails leaves no `.part` behind — the other model's included** — and its
    /// sentence names the file, not where it is kept. The first model's place is taken by a
    /// folder as the second model is being asked for, so the pair is fetched and checked and
    /// the first rename fails: the second model's 9.7 MB used to be left under its temporary
    /// name, because the list it was on had been emptied before the loop.
    #[tokio::test]
    async fn a_failed_rename_leaves_no_part_file_of_either_model() {
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-rename");
        let in_the_way = dir.join("scanner").join(DETECTION_MODEL);
        let host = raw_host::start(
            vec![
                (
                    "card-hashes.bin",
                    raw_host::declaring(tiny_bundle().len(), &tiny_bundle()),
                ),
                (
                    "text-detection.rten",
                    raw_host::declaring(DETECTION.len(), DETECTION),
                ),
                (
                    "text-recognition.rten",
                    raw_host::declaring(RECOGNITION.len(), RECOGNITION),
                ),
            ],
            Some(Box::new(move |path| {
                if path.ends_with("text-recognition.rten") {
                    std::fs::create_dir_all(&in_the_way).expect("a folder in the way");
                }
            })),
        );

        let refused = fetch_from(&state, source(host.base)).await.unwrap_err();
        assert!(
            refused.starts_with("Text detection model could not be put in place: "),
            "{refused}"
        );
        assert!(
            !refused.contains(&dir.display().to_string()),
            "the sentence names an app-private path: {refused}"
        );
        assert_eq!(host.asked.load(Ordering::SeqCst), 3);
        assert_eq!(
            in_place(&dir),
            ["card-hashes.bin"],
            "a model's `.part` was left behind"
        );
    }

    /// **GitHub's redirect is followed**: a release download answers 302 to another address,
    /// and the file is what that address serves.
    #[tokio::test]
    async fn a_redirect_is_followed_to_the_file() {
        let server = MockServer::start();
        let bundle = tiny_bundle();
        let elsewhere = server.url("/asset-host/card-hashes.bin");
        let redirect = server.mock(|when, then| {
            when.method(GET).path("/v3/card-hashes.bin");
            then.status(302).header("location", elsewhere.as_str());
        });
        let target = server.mock(|when, then| {
            when.method(GET).path("/asset-host/card-hashes.bin");
            then.status(200).body(bundle.clone());
        });
        release(&server, b"never asked here", DETECTION, RECOGNITION);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-redirect");

        fetch_from(&state, source(server.url("/v3")))
            .await
            .expect("a fetch across a redirect");
        redirect.assert_calls(1);
        target.assert_calls(1);
        assert_eq!(
            std::fs::read(dir.join("scanner").join(BUNDLE_FILE)).unwrap(),
            bundle
        );
    }

    /// **The shipped client asks nothing over plain HTTP.** The same release, the same source
    /// but for the switch the shipped one has on: the request is refused before it leaves, the
    /// server is never asked, and nothing lands. (That a *redirect* to plain HTTP ends the same
    /// way is the same switch in the client's redirect policy, `platform::http`'s to hold.)
    #[tokio::test]
    async fn the_https_only_client_asks_a_plain_http_release_nothing() {
        let server = MockServer::start();
        let mocks = release(&server, &tiny_bundle(), DETECTION, RECOGNITION);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-https");
        let mut secure = source(server.url("/v3"));
        secure.https_only = true;

        let refused = fetch_from(&state, secure).await.unwrap_err();
        assert!(
            refused.starts_with("Couldn't reach the download for card-hashes.bin: "),
            "{refused}"
        );
        for mock in &mocks {
            mock.assert_calls(0);
        }
        assert_eq!(in_place(&dir), Vec::<String>::new());
    }

    /// **A temporary file a killed run left is never read by a load, and the next fetch starts
    /// it over** — longer than the real file here, so an append or a resume would show.
    #[tokio::test]
    async fn a_part_file_left_behind_is_not_loaded_and_is_started_over() {
        let server = MockServer::start();
        let bundle = tiny_bundle();
        release(&server, &bundle, DETECTION, RECOGNITION);
        let (state, _heard, dir) = crate::state::fixtures::listening("scanner-assets-part");
        let scanner = dir.join("scanner");
        std::fs::create_dir_all(&scanner).unwrap();
        let left = part_path(&scanner.join(BUNDLE_FILE));
        assert_eq!(left, scanner.join("card-hashes.bin.part"));
        std::fs::write(&left, vec![0xAB; bundle.len() * 3]).unwrap();

        let status = state.scanner.status().expect("status");
        assert_eq!(status.bundle.source, AssetSource::Absent);

        fetch_from(&state, source(server.url("/v3")))
            .await
            .expect("a fetch");
        assert!(!left.exists());
        assert_eq!(std::fs::read(scanner.join(BUNDLE_FILE)).unwrap(), bundle);
    }

    /// **One at a time.** A second call while one runs is refused in a sentence and writes
    /// nothing — not a file, not a row in the error log; the read says a fetch is running; and
    /// the claim is let go when the first ends.
    #[tokio::test]
    async fn a_second_fetch_while_one_runs_is_refused() {
        let server = MockServer::start();
        let bundle = tiny_bundle();
        let slow = server.mock(|when, then| {
            when.method(GET).path("/v3/card-hashes.bin");
            then.status(200)
                .delay(Duration::from_millis(400))
                .body(bundle.clone());
        });
        server.mock(|when, then| {
            when.method(GET).path("/v3/text-detection.rten");
            then.status(200).body(DETECTION);
        });
        server.mock(|when, then| {
            when.method(GET).path("/v3/text-recognition.rten");
            then.status(200).body(RECOGNITION);
        });
        let source = source(server.url("/v3"));
        let (state, _heard, _dir) = crate::state::fixtures::listening("scanner-assets-twice");

        let first = {
            let (state, source) = (state.clone(), source.clone());
            tokio::spawn(async move { fetch_from(&state, source).await })
        };
        while !state.scanner.fetching.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            fetch_from(&state, source.clone()).await.unwrap_err(),
            ALREADY_FETCHING
        );
        assert!(
            state.scanner.fetching.load(Ordering::SeqCst),
            "the refused call let go of a claim that was not its own"
        );

        first.await.expect("joined").expect("the first fetch");
        slow.assert_calls(1);
        assert!(!state.scanner.fetching.load(Ordering::SeqCst));
        assert!(!owed_from(&state, &source).expect("owed").fetching);
        assert!(
            logged(&state).is_empty(),
            "a refused press is not a failure"
        );
    }

    /// **While a fetch runs, the read says so.** Asked from another task, as a page that came
    /// back to the Scanner view asks.
    #[tokio::test]
    async fn the_read_says_a_fetch_is_running() {
        let (state, _heard, _dir) = crate::state::fixtures::listening("scanner-assets-running");
        let source = source("http://127.0.0.1:1".to_owned());
        assert!(!owed_from(&state, &source).expect("owed").fetching);
        let claim = Claim::take(&state.scanner.fetching).expect("free");
        assert!(owed_from(&state, &source).expect("owed").fetching);
        assert!(Claim::take(&state.scanner.fetching).is_none());
        drop(claim);
        assert!(!owed_from(&state, &source).expect("owed").fetching);
    }

    /// **On a page both commands are the session's own refusal**, and nothing is asked of any
    /// host and nothing written on the way to it.
    #[tokio::test]
    async fn on_a_page_the_read_and_the_fetch_are_refused_in_the_scanners_sentence() {
        let server = MockServer::start();
        let mocks = release(&server, &tiny_bundle(), DETECTION, RECOGNITION);
        let source = source(server.url("/v3"));
        let (state, heard, dir) = crate::state::fixtures::listening("scanner-assets-page");
        {
            let _page = crate::platform::host::emulate_page();
            let refused = Err(NOT_IN_A_BROWSER_YET.to_owned());
            assert_eq!(owed(&state), refused);
            assert_eq!(owed_from(&state, &source), refused);
            assert_eq!(fetch_from(&state, source.clone()).await, refused);
            assert_eq!(fetch(&state).await, refused);
        }
        for mock in &mocks {
            mock.assert_calls(0);
        }
        assert!(heard.taken().is_empty(), "a refused fetch said something");
        assert!(!state.scanner.is_loaded());
        assert!(!state.scanner.fetching.load(Ordering::SeqCst));
        assert_eq!(in_place(&dir), Vec::<String>::new());
        assert!(logged(&state).is_empty());
    }

    /// A status with the three assets as given: `(present, loaded)` each.
    fn status(
        bundle: (bool, bool),
        detection: (bool, bool),
        recognition: (bool, bool),
    ) -> ScannerStatus {
        let asset = |(present, loaded): (bool, bool)| crate::scanner::Asset {
            path: "somewhere".to_owned(),
            present,
            loaded,
            error: None,
            source: if present {
                AssetSource::File
            } else {
                AssetSource::Absent
            },
        };
        ScannerStatus {
            bundle: asset(bundle),
            detection_model: asset(detection),
            recognition_model: asset(recognition),
            labels: 0,
            scans_dir: "somewhere/scans".to_owned(),
            unapplied_filters: None,
        }
    }

    /// **What is owed, case by case** — the rule [`lacking`] states, over statuses made up for
    /// it. `sound` is whether each model on disk is the pinned file.
    #[test]
    fn what_is_owed_is_what_did_not_load_and_the_binary_does_not_carry() {
        use Piece::{Bundle as B, Detection as D, Recognition as R};
        let none = Embedded::none();
        let (gone, there, broken) = ((false, false), (true, true), (true, false));

        // Nothing anywhere: all three.
        let nothing = status(gone, gone, gone);
        assert_eq!(lacking(&nothing, none, [false, false]), [B, D, R]);
        // Everything loaded: nothing.
        let all = status(there, there, there);
        assert_eq!(lacking(&all, none, [true, true]), []);
        // A bundle that is there and did not load — another format version's — is owed.
        let old = status(broken, there, there);
        assert_eq!(lacking(&old, none, [true, true]), [B]);
        // The pair did not load: each model that is not the pinned file, and only those.
        let pair = status(there, broken, broken);
        assert_eq!(lacking(&pair, none, [true, false]), [R]);
        assert_eq!(lacking(&pair, none, [false, true]), [D]);
        assert_eq!(lacking(&pair, none, [false, false]), [D, R]);
        // Both the pinned files and the pair still did not load: fetching the same bytes again
        // changes nothing, so nothing is owed and no offer is made that could never clear.
        assert_eq!(lacking(&pair, none, [true, true]), []);

        // What the binary carries is never owed, whatever a file placed over it did.
        let embedded = Embedded {
            bundle: Some(&b"carried"[..]),
            models: Some((&b"d"[..], &b"r"[..])),
        };
        assert_eq!(lacking(&nothing, embedded, [false, false]), []);
        assert_eq!(lacking(&old, embedded, [false, false]), []);
        // And each half on its own.
        let bundle_only = Embedded {
            bundle: embedded.bundle,
            models: None,
        };
        assert_eq!(lacking(&nothing, bundle_only, [false, false]), [D, R]);
    }

    /// **A file is the pinned one by its length and its digest, and by nothing less**: absent, a
    /// folder, the wrong length and the right length with the wrong bytes are each not it.
    #[test]
    fn a_file_is_the_pinned_one_only_byte_for_byte() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pinned = Pinned {
            bytes: DETECTION.len() as u64,
            sha256: sha256_hex(DETECTION),
        };
        let path = dir.path().join("models").join("text-detection.rten");
        assert!(!is_the_pinned_file(&path, &pinned), "no folder at all");
        std::fs::create_dir_all(&path).unwrap();
        assert!(!is_the_pinned_file(&path, &pinned), "a folder of that name");
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, b"detect").unwrap();
        assert!(!is_the_pinned_file(&path, &pinned), "the wrong length");
        std::fs::write(&path, b"DETECTION").unwrap();
        assert!(
            !is_the_pinned_file(&path, &pinned),
            "the right length, wrong bytes"
        );
        std::fs::write(&path, DETECTION).unwrap();
        assert!(is_the_pinned_file(&path, &pinned));
        // The spelling the pins are written in: lowercase hex, as `sha256sum` prints it.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// **The shipped source, pinned**: HTTPS only, this repository's release for the format
    /// version this build reads, the three flat names, the feeds' stall bound, the measured
    /// sizes — the page's "about 19 MB" is these three added up and rounded up — and the two
    /// models' digests, each a SHA-256 in the spelling [`sha256_hex`] prints.
    #[test]
    fn the_shipped_source_is_this_repositorys_release_over_https() {
        let source = Source::shipped();
        assert_eq!(
            source.base,
            format!(
                "https://github.com/Msgaihede/mtg-grimoire/releases/download/scanner-bundle-v{FORMAT_VERSION}"
            )
        );
        assert!(source.https_only);
        assert_eq!(source.stall, crate::scryfall::STALL);
        assert_eq!(source.bundle_ceiling, MAX_BUNDLE_BYTES);
        assert_eq!(
            [Piece::Bundle, Piece::Detection, Piece::Recognition].map(Piece::asset),
            [
                "card-hashes.bin",
                "text-detection.rten",
                "text-recognition.rten"
            ]
        );
        assert_eq!(
            [Piece::Bundle, Piece::Detection, Piece::Recognition].map(Piece::place),
            [BUNDLE_FILE, DETECTION_MODEL, RECOGNITION_MODEL]
        );
        let total: u64 = [Piece::Bundle, Piece::Detection, Piece::Recognition]
            .iter()
            .map(|piece| source.bytes(*piece))
            .sum();
        assert_eq!(total, 18_101_604);
        assert_eq!(PROGRESS_EVENT, "scanner:assets");
        assert_eq!(
            (source.detection.bytes, source.detection.sha256.as_str()),
            (DETECTION_BYTES, DETECTION_SHA256)
        );
        assert_eq!(
            (source.recognition.bytes, source.recognition.sha256.as_str()),
            (RECOGNITION_BYTES, RECOGNITION_SHA256)
        );
        for digest in [DETECTION_SHA256, RECOGNITION_SHA256] {
            assert_eq!(digest.len(), 64);
            assert!(digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        }
        assert_ne!(DETECTION_SHA256, RECOGNITION_SHA256);
        assert!(source.pinned(Piece::Bundle).is_none());
    }

    /// **The real thing, once, by hand**: the three published files from GitHub into a scratch
    /// state, checked — the two models against their pinned digests — and loaded. `#[ignore]`,
    /// because a test run must not download 18 MB —
    /// `cargo test -p grimoire-core --locked the_published_files -- --ignored --nocapture`.
    #[ignore = "downloads 18 MB from GitHub"]
    #[tokio::test]
    async fn the_published_files_land_and_load() {
        let (state, heard, dir) = crate::state::fixtures::listening("scanner-assets-real");
        let before = owed(&state).expect("owed");
        assert_eq!(
            keys(&before),
            ["bundle", "detectionModel", "recognitionModel"]
        );
        println!(
            "owed before: {} B in {} files",
            before.bytes,
            before.owed.len()
        );

        let began = crate::platform::clock::Tick::now();
        let after = fetch(&state).await.expect("the real fetch");
        let took = began.elapsed();
        let scanner = dir.join("scanner");
        let sizes = [BUNDLE_FILE, DETECTION_MODEL, RECOGNITION_MODEL]
            .map(|file| std::fs::metadata(scanner.join(file)).expect("landed").len());
        println!("fetched {sizes:?} B in {took:?}");
        let events = said(&heard);
        println!(
            "{} events; last {:?}",
            events.len(),
            events.last().expect("an event")
        );

        let load = crate::platform::clock::Tick::now();
        let status = state.scanner.status().expect("status");
        println!(
            "status after (asked again in {:?}): {status:?}",
            load.elapsed()
        );
        assert_eq!(after.owed, Vec::new(), "{status:?}");
        assert_eq!(status.bundle.source, AssetSource::File);
        assert!(status.bundle.loaded);
        assert!(status.detection_model.loaded && status.recognition_model.loaded);
        assert_eq!(sizes[1], DETECTION_BYTES);
        assert_eq!(sizes[2], RECOGNITION_BYTES);
        assert_eq!(
            sha256_hex(&std::fs::read(scanner.join(DETECTION_MODEL)).unwrap()),
            DETECTION_SHA256
        );
        assert_eq!(
            sha256_hex(&std::fs::read(scanner.join(RECOGNITION_MODEL)).unwrap()),
            RECOGNITION_SHA256
        );
        assert_eq!(in_place(&dir).len(), 3);
        assert!(logged(&state).is_empty());

        // Nothing is left behind: 18 MB a run is not scratch worth keeping.
        drop(state);
        let _ = std::fs::remove_dir_all(&scanner);
    }
}
