//! **Sending one scan**: the last couple of seconds of camera frames and the card a reader says
//! they show, to the scan inbox (`infrastructure/scan-worker/`), where they are kept to improve
//! the scanner (issue #776).
//!
//! **The one thing in this crate that sends a picture off the device**, and it has one caller:
//! a reader's press on Send, with those pictures on the screen and the printing and the finish
//! chosen by hand. Nothing here runs on a launch, on a schedule or on a frame — the scanner
//! itself still examines every picture where it was taken and keeps none.
//!
//! **A scan is a run of frames and never one picture.** The scanner decides over a run — a lock
//! that settles, evidence that pools, a vote that crosses a bar — so a single frame cannot say
//! what it did, and a still taken for the purpose is a picture the scanner never judged. What is
//! sent is the frames it *was* given, byte for byte and in order, each beside what it answered
//! for it: put back through the scanner, that is the scan again. So [`pictures`] takes a whole
//! run or refuses: one too short to be a run is turned away in a sentence, and nothing here
//! trims one to fit — what a reader was shown is what is sent, or nothing is.
//!
//! **Sending a scan is a supporter's** (the owner's decision, 2026-10-11): a device with a
//! membership behind it — its own, or its sync group's — and nobody else. It is held three
//! times. The page draws no press for anybody else; [`submit`] asks
//! [`crate::sync_engine::commands::entitled`] before it reads a frame; and **the inbox asks for
//! the relay's token**, the one sync is done with, which only a supporter's device can mint — a
//! check made here alone would be a suggestion. The token names the device's sync group, so it
//! is the one thing in a submission that could say who sent it: it rides in the request's
//! `authorization` header, the inbox checks it and keeps none of it, and it is in no [`Label`].
//! **No sentence here names a membership**: the build Google Play distributes may not lead a
//! reader to one bought elsewhere, and its host rewords only what a `sync_` command says
//! (`apps/light/src-tauri/src/membership.rs`).
//!
//! **What is sent is the run and a [`Label`], and the label says nothing of who sent it**: the
//! printing and its finish, what the scanner had read, what it was narrowed to, the app's
//! version and what kind of host it is on. No device id, no group, no collection. The privacy
//! policy (`apps/light/public/privacy.html`) promises exactly that, so a field added to
//! [`Label`] is a sentence owed there.
//!
//! **The page names the card by id and nothing else about it.** [`label_for`] reads the
//! printing's name, set, number and language out of this install's own card data, and refuses a
//! finish the printing is not made in — so a label cannot pair one printing's id with another's
//! name, and "foil" beside a card that has no foil never reaches the inbox. The label is the
//! whole value of a submission; a wrong one is worse than none.
//!
//! **A `task` in the table, and its pictures are base64 in its arguments** — not a `bytes` entry
//! like the scanner's frame. A frame is nine a second and is answered by this engine; this is
//! one call a press, awaited across a network, and `bytes` runs its body on the blocking pool
//! where nothing can be awaited. Four thirds of two megabytes, once, is the price.
//!
//! **Every host sends it the same way**, a page included: a `fetch` from the engine's Worker,
//! which the inbox answers for the web app's origin by name
//! (`infrastructure/scan-worker/src/cors.ts`) and the hosting policy's `connect-src` allows
//! (`infrastructure/app-worker/_headers`). The body's type and the label's header each cost a
//! browser a pre-flight, which that Worker answers.

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use card_scanner::filters::ScanFilters;
use rusqlite::{Connection, OptionalExtension};

use crate::platform::http;
use crate::state::State;
use crate::sync_engine::entitlement;

/// The scan inbox's address. Compiled in and public on [`crate::sync_engine::entitlement::
/// RELAY_BASE`]'s terms: a name of its own on the web app's zone, as the relay's and the share
/// Worker's are (the owner's decision, 2026-10-11) — a Custom Domain the Worker's deploy
/// states, so no build has ever been cut with a `workers.dev` address for it and none answers.
/// No trailing slash.
///
/// ⚠️ **Three files have to agree with it**: `infrastructure/scan-worker/wrangler.jsonc`'s
/// `routes`, the web policy's `connect-src` and the privacy policy's table of hosts. The first
/// two each have a test that reads this line (`scan-worker`'s `wrangler.test.ts`,
/// `app-worker`'s `hosting.test.ts`), and `apps/light/host.test.ts` holds the third to the
/// second.
pub const SCAN_BASE: &str = "https://scans.mtg-grimoire.app";

/// A `sync_state` row that points this install at another inbox — [`crate::sync_engine::
/// client::RELAY_URL`]'s shape, and like it a row with no UI: it is how a test asks a local
/// server and how a developer asks `wrangler dev --local`.
pub const SCAN_URL: &str = "scan_url";

/// The fewest frames that are a run. Under this the scanner had not been looking long enough
/// for the frames to say anything a single picture would not — and a single picture is what
/// this never sends. `infrastructure/scan-worker/src/env.ts`'s `MIN_RUN_FRAMES`, which a test
/// there reads this line to hold, and the page's `RUN_MIN_FRAMES` (`ipc.test.ts`).
pub const MIN_RUN_FRAMES: usize = 5;

/// The most frames in a run: about two seconds at the pump's nine a second. `env.ts`'s
/// `MAX_RUN_FRAMES` and the page's `RUN_MAX_FRAMES`, held the same way.
pub const MAX_RUN_FRAMES: usize = 20;

/// Two megabytes a run, every frame of it together — **`env.ts`'s `MAX_RUN_BYTES`**, held the
/// same way. Refused here first, so a reader on a slow link is told in a sentence rather than
/// after an upload. The page keeps its run under less than this (`RUN_MAX_BYTES`), so the
/// refusal is a backstop and not something a reader meets.
pub const MAX_RUN_BYTES: usize = 2 * 1024 * 1024;

/// The header the label rides in — `cors.ts`'s `LABEL_HEADER`, which the same test holds.
pub const LABEL_HEADER: &str = "x-scan-label";

/// The label's header, in characters — `env.ts`'s `MAX_LABEL_CHARS`, held the same way. A real
/// one is some four thousand: twenty frames' figures are most of it.
pub const MAX_LABEL_CHARS: usize = 8192;

/// The label's shape. A second shape is a second number, and an inbox deployed for it.
pub const LABEL_VERSION: u8 = 1;

/// The finishes a card comes in, as `cards.finishes` and the page both spell them.
const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

/// How many set codes a label's filters carry. Past this the list is cut, which is the one
/// place a label says less than was so — a reader narrowed to more sets than this is not a
/// thing the popover makes easy, and the header has a size.
const MAX_FILTER_SETS: usize = 64;

/// The furthest back a frame's `ms` is believed: a minute, where a run is two seconds.
const MAX_AGE_MS: f64 = 60_000.0;

/// The inbox's word for "full", `submit.ts`'s `INBOX_FULL` — matched on the code, never on the
/// sentence beside it.
const INBOX_FULL_CODE: &str = "inbox_full";

/// The inbox's word for "this address has sent too many", `index.ts`'s. Matched with the
/// status, because a 429 is not only the inbox's to send: the host in front of it answers one
/// for its own reasons, and "wait a minute" would be the wrong thing to tell a reader then.
const RATE_LIMITED_CODE: &str = "rate_limited";

pub const NO_SUCH_PRINTING: &str = "That printing is not in this device's card data.";
pub const NOT_A_PICTURE: &str = "One of those pictures could not be read.";
pub const TOO_LARGE: &str = "That scan is too large to send.";
/// The page says this first and in these words (`submitText.ts`), before it opens a dialog.
pub const TOO_SHORT: &str =
    "Not enough of the scan yet. Hold the card under the camera a moment and press again.";
pub const INBOX_FULL: &str = "The scan inbox is full for now. Thank you — try again in a few days.";
pub const SLOW_DOWN: &str = "Too many scans were sent at once. Wait a minute and send it again.";
pub const UNREACHABLE: &str = "The scan could not be sent: the server could not be reached.";
/// What a device with no membership behind it is told, before anything about the scan. The page
/// draws it no press, so this is the rule held a second time — and **it names no membership**,
/// for the module's reason: the page says it as it stands, on every host.
pub const NOT_ON: &str = "Sending scans is not turned on for this device.";
/// The relay could not be asked for this device's token — or answered something that is neither
/// a token nor "no". Its own sentence is not passed on: some of them name a membership.
pub const UNCONFIRMED: &str =
    "The scan could not be sent: the server could not confirm this device. Try again in a moment.";
/// The inbox would not take the token: 401 or 403. A key that is not set on it, a token that
/// died on the way, a device since removed from its group.
pub const NOT_ACCEPTED: &str = "The scan could not be sent: the server did not accept this device.";

/// What a reader says a scan shows, and what the scanner had said — the page's half of a
/// [`Label`], mirrored as `ScannerSubmission` in `packages/ui/lib/ipc.ts`.
///
/// The four after `finish` are the scanner's side at the press, each absent when it had none.
/// They are taken as the page gives them and tidied in [`label_for`]: nothing in them is a
/// reason to turn a submission away, because a run the scanner made nothing of is as much
/// worth having as one it named wrongly.
///
/// **`reported` is the printing the scanner had decided on, and absent while it had decided
/// nothing** — never the card it was only leaning towards. The tracker's leader is keyed by
/// what its evidence pooled on, which is an oracle id: sent here it would be an id of another
/// kind beside `card_id`, and "the scanner got it right" could never be read off the two.
///
/// **`card_id` and `finish` name the card in the last frame**, the one under the camera at the
/// press. `filters` is the scanner crate's own struct, snake case inside as it is everywhere.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub card_id: String,
    pub finish: String,
    pub reported: Option<String>,
    pub mode: String,
    pub confidence: Option<f64>,
    pub distance: Option<u32>,
    pub bundle: Option<u32>,
    pub filters: ScanFilters,
    pub run: Vec<SubmissionFrame>,
}

/// One frame of a run: the picture the scanner was given, and what it answered for it —
/// `ScannerSubmissionFrame` in `ipc.ts`.
///
/// **`jpeg` is the pump's own frame**, in base64: the bytes `scanner_frame` judged, not a
/// picture made for sending. `ms` is when it was taken, counted back from the press — zero or
/// negative, and a number of any spelling, since it is a difference of two of the page's
/// clock readings.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionFrame {
    pub jpeg: String,
    pub ms: f64,
    pub ok: bool,
    pub lock: Option<String>,
    pub confidence: Option<f64>,
    pub distance: Option<u32>,
    pub decided: Option<String>,
    pub detail: bool,
}

/// A scan the inbox took, and the reference it filed it under — `ScannerSubmitted` in `ipc.ts`.
/// The reader is shown the id: nothing sent says who sent it, so it is the only way one
/// submission is ever found again.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Submitted {
    pub id: String,
}

/// What the inbox stores beside a run — `Label` in `infrastructure/scan-worker/src/label.ts`,
/// which checks every field and stores only what it checked. `label.test.ts` there reads these
/// six structs' fields and fails when the two part.
///
/// **`run` is one entry a frame, oldest first, and it is the index of the body**: the frames
/// are sent end to end with nothing between them, and each entry's `bytes` is where the next
/// one starts.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Label {
    pub v: u8,
    pub card: LabelCard,
    pub finish: String,
    pub scanner: LabelScanner,
    pub app: LabelApp,
    pub run: Vec<LabelFrame>,
}

/// The printing, by Scryfall's id and by what is printed on it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelCard {
    pub id: String,
    pub set: String,
    pub number: String,
    pub lang: String,
    pub name: String,
}

/// The scanner's side at the press. An absent figure is `null` on the wire and never left out:
/// the inbox tells "it had none" from "this build does not send it" by the key being there.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelScanner {
    pub reported: Option<String>,
    pub mode: String,
    pub confidence: Option<f64>,
    pub distance: Option<u32>,
    pub bundle: Option<u32>,
    pub filters: LabelFilters,
}

/// What the scanner was narrowed to: it decides which printings it could have answered with,
/// so a run replayed without it is another scan. Empty `sets` and two `null`s is no filter.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelFilters {
    pub sets: Vec<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelApp {
    pub version: String,
    pub platform: String,
}

/// One frame of the run: where it is in the body, how big it is, and what the scanner answered
/// for it. `bytes`, `width` and `height` are facts read off the frame here; the rest is the
/// page's, tidied.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelFrame {
    pub ms: i32,
    pub bytes: u32,
    pub width: u32,
    pub height: u32,
    pub ok: bool,
    pub lock: Option<String>,
    pub confidence: Option<f64>,
    pub distance: Option<u32>,
    pub decided: Option<String>,
    pub detail: bool,
}

/// The inbox this install asks: the override when one is stored, [`SCAN_BASE`] otherwise.
pub fn base(conn: &Connection) -> String {
    let stored = crate::sync_engine::client::get_state(conn, SCAN_URL).unwrap_or_default();
    let trimmed = stored.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        SCAN_BASE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// One frame as it was found in the body: how long it is and its size in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Measured {
    pub bytes: u32,
    pub width: u32,
    pub height: u32,
}

/// A run out of its base64: the frames end to end, oldest first, and each one measured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pictures {
    pub body: Vec<u8>,
    pub frames: Vec<Measured>,
}

/// The run's pictures, or the sentence that refuses the whole of it.
///
/// **All of the frames or none.** A run too short is not a run ([`TOO_SHORT`]); one too long or
/// too heavy is refused rather than cut ([`TOO_LARGE`]), because a cut one is not what the
/// reader was shown; and one frame that is not a picture refuses the lot ([`NOT_A_PICTURE`]),
/// because the frames either side of a hole are not the scan.
///
/// **Each frame is checked as a JPEG here, not trusted as one**: its size is read out of its
/// own frame header, so bytes that are not a JPEG have none and are refused before any request
/// — and what the label says of a frame is then a fact about these bytes rather than something
/// the page said about them.
pub fn pictures(run: &[SubmissionFrame]) -> Result<Pictures, String> {
    if run.len() < MIN_RUN_FRAMES {
        return Err(TOO_SHORT.to_owned());
    }
    if run.len() > MAX_RUN_FRAMES {
        return Err(TOO_LARGE.to_owned());
    }
    // Four characters carry three bytes, and each frame's text is padded to a whole four: a
    // text this long cannot decode to a run that fits.
    let text: usize = run.iter().map(|frame| frame.jpeg.len()).sum();
    if text > (MAX_RUN_BYTES / 3 + 1 + run.len()) * 4 {
        return Err(TOO_LARGE.to_owned());
    }

    let mut body = Vec::with_capacity(text / 4 * 3);
    let mut frames = Vec::with_capacity(run.len());
    for frame in run {
        let jpeg = base64::engine::general_purpose::STANDARD
            .decode(&frame.jpeg)
            .map_err(|_| NOT_A_PICTURE.to_owned())?;
        if body.len() + jpeg.len() > MAX_RUN_BYTES {
            return Err(TOO_LARGE.to_owned());
        }
        let (width, height) = jpeg_size(&jpeg).ok_or_else(|| NOT_A_PICTURE.to_owned())?;
        frames.push(Measured {
            // Under the cap, which is far inside a `u32`.
            bytes: u32::try_from(jpeg.len()).map_err(|_| TOO_LARGE.to_owned())?,
            width,
            height,
        });
        body.extend_from_slice(&jpeg);
    }
    Ok(Pictures { body, frames })
}

/// A JPEG's width and height, from its first frame header — or `None` for bytes that are not
/// one. It walks the markers and decodes nothing.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return None;
    }
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        match marker {
            // A fill byte before a marker.
            0xff => at += 1,
            // Markers that stand alone, with no length after them.
            0x01 | 0xd0..=0xd8 => at += 2,
            // The scan, with no frame header before it: not a picture anything could size.
            0xda => return None,
            _ => {
                let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
                if length < 2 {
                    return None;
                }
                // A start of frame: every `c_` marker but the three that are tables.
                if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                    let header = bytes.get(at + 4..at + 9)?;
                    let height = u32::from(u16::from_be_bytes([header[1], header[2]]));
                    let width = u32::from(u16::from_be_bytes([header[3], header[4]]));
                    return (width > 0 && height > 0).then_some((width, height));
                }
                at += 2 + length;
            }
        }
    }
    None
}

/// A scan mode's name, a lock's phase, or anything shaped like one: a short lower-case word,
/// which is what the inbox takes. Not the list of either, so a third mode is not a submission
/// refused.
fn is_word(text: &str) -> bool {
    (1..=16).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A Scryfall id as this app spells one: thirty-two lower-case hex digits in the five groups
/// of a UUID. `label.ts`'s `UUID`, which is what the inbox takes for the two ids the scanner
/// supplies.
fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// The printing the scanner had decided on, as the page gave it — or `None` for one that is
/// blank or is not an id.
///
/// **Held to the shape the inbox checks**, and tidied away rather than sent where it is not
/// that: the inbox refuses a label whose `reported` or `decided` is anything else, and a
/// figure of the scanner's must never be why a reader's scan is turned away.
fn tidy_id(id: Option<&str>) -> Option<String> {
    id.map(str::trim)
        .filter(|id| is_uuid(id))
        .map(str::to_owned)
}

/// How many cards a bundle can hold, as far as the inbox believes one: `label.ts`'s bound.
const MAX_BUNDLE_LABELS: u32 = 10_000_000;

/// A share of the evidence, so between nothing and all of it — and to three places, which is
/// more than the figure means and keeps twenty of them inside a header.
fn tidy_confidence(confidence: Option<f64>) -> Option<f64> {
    confidence
        .filter(|c| c.is_finite())
        .map(|c| (c.clamp(0.0, 1.0) * 1000.0).round() / 1000.0)
}

/// A count of bits out of 256. A figure outside its own range is one the scanner did not mean.
fn tidy_distance(distance: Option<u32>) -> Option<u32> {
    distance.filter(|bits| *bits <= 256)
}

/// `YYYY-MM-DD`, or nothing: a cleared date input reports a blank, which is no bound.
fn tidy_date(date: Option<&str>) -> Option<String> {
    let date = date.map(str::trim)?;
    let shaped = date.len() == 10
        && date.bytes().enumerate().all(|(at, b)| match at {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    shaped.then(|| date.to_owned())
}

/// The reader's narrowing as the label carries it: set codes in lower case, each once, in the
/// order they were given, and the two dates.
fn tidy_filters(filters: &ScanFilters) -> LabelFilters {
    let mut sets: Vec<String> = Vec::new();
    for set in &filters.sets {
        let set = set.trim().to_lowercase();
        let coded = (2..=8).contains(&set.len())
            && set
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        if coded && !sets.contains(&set) && sets.len() < MAX_FILTER_SETS {
            sets.push(set);
        }
    }
    LabelFilters {
        sets,
        from: tidy_date(filters.released_from.as_deref()),
        to: tidy_date(filters.released_to.as_deref()),
    }
}

/// One frame's entry: what was measured of it, and the page's figures tidied.
fn tidy_frame(frame: &SubmissionFrame, measured: Measured) -> LabelFrame {
    LabelFrame {
        // Before the press, so never after it; and a whole number of milliseconds.
        ms: if frame.ms.is_finite() {
            frame.ms.round().clamp(-MAX_AGE_MS, 0.0) as i32
        } else {
            0
        },
        bytes: measured.bytes,
        width: measured.width,
        height: measured.height,
        ok: frame.ok,
        lock: frame.lock.clone().filter(|phase| is_word(phase)),
        confidence: tidy_confidence(frame.confidence),
        distance: tidy_distance(frame.distance),
        decided: tidy_id(frame.decided.as_deref()),
        detail: frame.detail,
    }
}

/// The label for one submission: the printing read out of this install's own card data, the
/// finish checked against it, and the scanner's figures tidied.
///
/// **Refuses three things, each in a sentence**: a finish that is not a finish, a printing
/// these cards do not have, and a finish that printing is not made in. `cards.finishes` that is
/// missing or unreadable is *unknown* and refuses nothing — an older corpus, not a card with no
/// foil.
///
/// `frames` is [`pictures`]' measure of `submission.run`, one for one.
pub fn label_for(
    conn: &Connection,
    submission: &Submission,
    frames: &[Measured],
) -> Result<Label, String> {
    let finish = submission.finish.as_str();
    if !FINISHES.contains(&finish) {
        return Err(format!("{finish} is not a finish a card comes in."));
    }
    if !is_word(&submission.mode) {
        return Err(format!("{} is not a scan mode.", submission.mode));
    }

    let printing = conn
        .query_row(
            "SELECT name, set_code, collector_number, lang, finishes FROM cards WHERE id = ?1",
            [&submission.card_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("The card could not be read: {e}"))?;
    let Some((name, set, number, lang, finishes)) = printing else {
        return Err(NO_SUCH_PRINTING.to_owned());
    };

    let made_in: Vec<String> = finishes
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    if !made_in.is_empty() && !made_in.iter().any(|known| known == finish) {
        return Err(format!(
            "{name} ({} {number}) does not come in {finish}.",
            set.to_uppercase()
        ));
    }

    Ok(Label {
        v: LABEL_VERSION,
        card: LabelCard {
            id: submission.card_id.clone(),
            set: set.to_lowercase(),
            number,
            lang: lang.to_lowercase(),
            name,
        },
        finish: finish.to_owned(),
        scanner: LabelScanner {
            reported: tidy_id(submission.reported.as_deref()),
            mode: submission.mode.clone(),
            confidence: tidy_confidence(submission.confidence),
            distance: tidy_distance(submission.distance),
            bundle: submission
                .bundle
                .filter(|cards| *cards <= MAX_BUNDLE_LABELS),
            filters: tidy_filters(&submission.filters),
        },
        app: LabelApp {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: crate::platform::device::kind().to_lowercase(),
        },
        run: submission
            .run
            .iter()
            .zip(frames)
            .map(|(frame, measured)| tidy_frame(frame, *measured))
            .collect(),
    })
}

/// The label as the header carries it: JSON with every character past `~` escaped.
///
/// A header's value is bytes a server reads as Latin-1, so a name sent as it is spelled would
/// arrive as something else; the inbox refuses a header that is not ASCII rather than repair
/// one. `packages/ui/lib/ipc.ts`'s `asciiJson` is this rule for the scanner's own frames. Only
/// a string can hold such a character in JSON, so escaping them one at a time is safe.
///
/// **And inside [`MAX_LABEL_CHARS`]**, which the inbox refuses a header past. Every field that
/// could run on is bounded above, so this is the same backstop the byte cap is — but a label
/// that got past it would be a 400 with a developer's sentence, and this is the reader's.
fn ascii_json(label: &Label) -> Result<String, String> {
    let json = serde_json::to_string(label)
        .map_err(|e| format!("The scan's label could not be written: {e}"))?;
    let mut ascii = String::with_capacity(json.len());
    for c in json.chars() {
        if c.is_ascii() && c != '\u{7f}' {
            ascii.push(c);
            continue;
        }
        let mut units = [0u16; 2];
        for unit in c.encode_utf16(&mut units) {
            let _ = write!(ascii, "\\u{unit:04x}");
        }
    }
    if ascii.len() > MAX_LABEL_CHARS {
        return Err(TOO_LARGE.to_owned());
    }
    Ok(ascii)
}

/// One client for the app's life. **Split into an app arm and a test arm for
/// `sync_engine::entitlement::http`'s reason**: one static client, `httpmock`'s pooled ports,
/// and a runtime per `#[tokio::test]`.
#[cfg(not(any(test, feature = "testing")))]
fn http() -> http::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<http::Client> = OnceLock::new();
    CLIENT.get_or_init(build_http).clone()
}

/// See [`http`]: a test build takes a fresh client so nothing is shared across runtimes.
#[cfg(any(test, feature = "testing"))]
fn http() -> http::Client {
    build_http()
}

/// Ten seconds to connect, and **two minutes for the answer to begin** — which is not a gap
/// between reads here: the client starts that clock when the request is sent, so it runs
/// through the whole upload, and a run of a megabyte and a half over a phone's weak uplink is
/// most of the wait. Two and a half minutes for all of it where the host has no socket to
/// bound.
fn build_http() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: crate::scryfall::USER_AGENT,
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(120)),
        https_only: false,
    })
    .deadline(Duration::from_secs(150))
}

/// What a refusal's body says its reason is, when it says one.
fn code_of(body: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Refusal {
        code: Option<String>,
    }
    serde_json::from_str::<Refusal>(body).ok()?.code
}

/// The id out of the inbox's `201`. An answer with none, or with something that is not an id,
/// is not a submission the reader can be handed a reference for.
fn taken(body: &str) -> Result<Submitted, String> {
    let taken: Submitted = serde_json::from_str(body)
        .map_err(|_| "The scan was sent, but the server's answer could not be read.".to_owned())?;
    let plain = (1..=64).contains(&taken.id.len())
        && taken
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !plain {
        return Err("The scan was sent, but the server's answer could not be read.".to_owned());
    }
    Ok(taken)
}

/// Post one run and its label to the inbox at `base`, and read what it answers.
///
/// **The body is the frames end to end and nothing else** — no wrapper, no separator: the
/// label's `run` says how long each is, so what the inbox stores is the scanner's own bytes
/// and one cut per entry finds them again. It is sent as `application/octet-stream`, because a
/// run of JPEGs is not a JPEG.
///
/// **Every refusal the inbox words is reworded here for a reader**, matched on the status or on
/// the code and never on the inbox's own sentence, which is written for a developer. A status
/// with no sentence of its own is named — on a native host a Worker that is not deployed answers
/// 404, and "the server answered 404" is what says so.
///
/// **`token` is the relay's, for this device** ([`token`]), sent as a bearer: it is what the
/// inbox lets a scan in by. It is never logged, never in the label and never in a sentence.
async fn send(base: &str, body: Vec<u8>, label: &Label, token: &str) -> Result<Submitted, String> {
    let header = ascii_json(label)?;
    let response = http()
        .post(&format!("{base}/scan"))
        .header("content-type", "application/octet-stream")
        .header("authorization", &format!("Bearer {token}"))
        .header(LABEL_HEADER, &header)
        .bytes(body)
        .send()
        .await
        .map_err(|_| UNREACHABLE.to_owned())?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    match (status, code_of(&body).as_deref()) {
        (201, _) => taken(&body),
        (401 | 403, _) => Err(NOT_ACCEPTED.to_owned()),
        (413, _) => Err(TOO_LARGE.to_owned()),
        (429, Some(RATE_LIMITED_CODE)) => Err(SLOW_DOWN.to_owned()),
        (_, Some(INBOX_FULL_CODE)) => Err(INBOX_FULL.to_owned()),
        _ => Err(format!(
            "The scan could not be sent: the server answered {status}."
        )),
    }
}

/// Send one scan — the table's `scanner_submit` and the desktop wrapper of the same name.
///
/// The run is decoded and the label read on the blocking pool, holding the read connection for
/// one indexed row and letting it go before anything is awaited; then the request. **No
/// lease**: who holds the scanner is one question and what a reader chooses to send is another,
/// as it is for the scanner's files.
///
/// **Who may send is asked first, and what is sent second**: a device with no membership behind
/// it is told [`NOT_ON`] whatever it handed over, before a frame is decoded. Then the token —
/// on the sync lane, as every request to the relay is made, and let go before the upload — and
/// only then the inbox.
pub async fn submit(state: &Arc<State>, submission: Submission) -> Result<Submitted, String> {
    let shared = Arc::clone(state);
    let (body, label, base) = crate::platform::spawn::blocking(move || -> Result<_, String> {
        if !crate::sync_engine::commands::entitled(&shared.lock_db_read()) {
            return Err(NOT_ON.to_owned());
        }
        let Pictures { body, frames } = pictures(&submission.run)?;
        let conn = shared.lock_db_read();
        let label = label_for(&conn, &submission, &frames)?;
        Ok((body, label, base(&conn)))
    })
    .await
    .map_err(|e| format!("The scan could not be sent: {e}"))??;
    let token = token(state).await?;
    send(&base, body, &label, &token).await
}

/// The relay's token for this device: the one a sync trip is made with, held while it is fresh
/// and minted again when it is not ([`entitlement::access_token`]).
///
/// **On the lane, for a press** — the relay is asked one thing at a time, and a reader who
/// presses Send during a sync is told the app is busy rather than left to wait out its trip.
/// The lane is let go when this returns: the upload is the inbox's and holds nothing of sync's.
///
/// `Ok(None)` is the relay saying there is no membership — it has ended since the page drew its
/// press — which is [`NOT_ON`]. Anything else it could not say is [`UNCONFIRMED`], in this
/// module's words and never the relay's own.
async fn token(state: &State) -> Result<String, String> {
    let lane = state.lane_for_press().await?;
    match entitlement::access_token(&lane).await {
        Ok(Some(token)) => Ok(token),
        Ok(None) => Err(NOT_ON.to_owned()),
        Err(_) => Err(UNCONFIRMED.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::Method::POST;

    /// Two printings' ids, as the scanner names what it decided on.
    const SHOCK: &str = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
    const BOLT: &str = "ce711943-c1a1-43a0-8b89-8d169cfb8e06";

    /// A JPEG's headers and nothing under them: start of image, a JFIF segment, a baseline
    /// frame header for 160×120, end of image. Enough for [`jpeg_size`], which decodes nothing.
    const TINY_JPEG: &[u8] = &[
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x78, 0x00, 0xa0, 0x01,
        0x01, 0x11, 0x00, 0xff, 0xd9,
    ];

    fn base64_of(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// One frame of `bytes`, taken `ms` before the press, that the scanner made nothing of.
    fn frame_of(bytes: &[u8], ms: f64) -> SubmissionFrame {
        SubmissionFrame {
            jpeg: base64_of(bytes),
            ms,
            ok: false,
            lock: None,
            confidence: None,
            distance: None,
            decided: None,
            detail: false,
        }
    }

    /// `frames` tiny pictures, 110 ms apart and the last one at the press — oldest first.
    fn run_of(frames: usize) -> Vec<SubmissionFrame> {
        (0..frames)
            .map(|at| frame_of(TINY_JPEG, -110.0 * (frames - 1 - at) as f64))
            .collect()
    }

    fn submission(card_id: &str, finish: &str) -> Submission {
        Submission {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            reported: Some(SHOCK.to_owned()),
            mode: "fast".to_owned(),
            confidence: Some(0.82),
            distance: Some(31),
            bundle: Some(98_000),
            filters: ScanFilters::default(),
            run: run_of(MIN_RUN_FRAMES),
        }
    }

    /// The token a [`seeded`] supporter holds: fresh, so nothing asks the relay for another.
    const HELD: &str = "a-held-access-token";

    /// A state on files with one printing in it, made in nonfoil and foil — **a supporter's**:
    /// the device that connected, holding a token good for another day.
    fn seeded(name: &str) -> Arc<State> {
        let state = unconnected(name);
        connect(&state, 86_400);
        state
    }

    /// The same state with no membership behind it: a device that never connected.
    fn unconnected(name: &str) -> Arc<State> {
        let (state, _dir) = crate::state::fixtures::on_files(name, "http://127.0.0.1:1");
        {
            let conn = state.lock_db();
            crate::schema::fixtures::seed_card(&conn, "c-bolt", "2X2", "117");
            conn.execute(
                "UPDATE cards SET finishes = '[\"nonfoil\",\"foil\"]' WHERE id = 'c-bolt'",
                [],
            )
            .expect("the printing's finishes");
        }
        state
    }

    /// Give `state` a grant whose token dies `good_for` seconds from now — in the past, for one
    /// the relay would have to be asked to replace.
    fn connect(state: &State, good_for: i64) {
        let conn = state.lock_db();
        let now: i64 = conn
            .query_row("SELECT unixepoch()", [], |row| row.get(0))
            .expect("the clock");
        entitlement::store_grant(&conn, HELD, "a-refresh-secret", now + good_for).expect("a grant");
    }

    fn labelled(state: &State, submission: &Submission) -> Result<Label, String> {
        let measured = pictures(&submission.run)?;
        label_for(&state.lock_db_read(), submission, &measured.frames)
    }

    /// What [`pictures`] measures of one [`TINY_JPEG`].
    const TINY: Measured = Measured {
        bytes: 35,
        width: 160,
        height: 120,
    };

    /// A label written out, for the tests that are about the wire and need no card data.
    fn written() -> Label {
        Label {
            v: LABEL_VERSION,
            card: LabelCard {
                id: "c-bolt".to_owned(),
                set: "2x2".to_owned(),
                number: "117".to_owned(),
                lang: "en".to_owned(),
                name: "Lightning Bolt".to_owned(),
            },
            finish: "foil".to_owned(),
            scanner: LabelScanner {
                reported: None,
                mode: "exact".to_owned(),
                confidence: None,
                distance: None,
                bundle: None,
                filters: LabelFilters {
                    sets: Vec::new(),
                    from: None,
                    to: None,
                },
            },
            app: LabelApp {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                platform: "desktop".to_owned(),
            },
            run: run_of(MIN_RUN_FRAMES)
                .iter()
                .map(|frame| tidy_frame(frame, TINY))
                .collect(),
        }
    }

    #[test]
    fn the_inbox_is_one_https_origin_with_no_trailing_slash() {
        assert!(SCAN_BASE.starts_with("https://"));
        assert!(!SCAN_BASE.ends_with('/'));
        assert_eq!(SCAN_BASE.matches('/').count(), 2, "an origin, with no path");
    }

    #[test]
    fn a_run_is_read_out_of_its_base64_end_to_end_with_each_frame_measured() {
        // Two sizes of picture, so "end to end" is told from "the same one five times".
        let mut longer = TINY_JPEG.to_vec();
        longer.extend_from_slice(&[0; 7]);
        let mut run = run_of(MIN_RUN_FRAMES);
        run[1] = frame_of(&longer, -330.0);

        let read = pictures(&run).expect("a run");
        let mut expected = Vec::new();
        for at in 0..MIN_RUN_FRAMES {
            expected.extend_from_slice(if at == 1 { &longer } else { TINY_JPEG });
        }
        assert_eq!(read.body, expected);
        assert_eq!(read.frames.len(), MIN_RUN_FRAMES);
        assert_eq!(read.frames[0], TINY);
        assert_eq!(read.frames[1], Measured { bytes: 42, ..TINY });
        // The entries are the index of the body: their lengths are the whole of it.
        let total: u32 = read.frames.iter().map(|frame| frame.bytes).sum();
        assert_eq!(total as usize, read.body.len());
    }

    /// **Never one picture.** The rule the whole module is built on: fewer frames than a run is
    /// a refusal in a sentence, not a submission of what there was.
    #[test]
    fn a_run_too_short_to_be_one_is_refused_and_a_single_picture_most_of_all() {
        for frames in 0..MIN_RUN_FRAMES {
            assert_eq!(
                pictures(&run_of(frames)).unwrap_err(),
                TOO_SHORT,
                "{frames}"
            );
        }
        assert!(pictures(&run_of(MIN_RUN_FRAMES)).is_ok());
        // Whatever the floor is moved to, it is never one.
        const _: () = assert!(MIN_RUN_FRAMES > 1);
    }

    #[test]
    fn one_frame_that_is_not_a_picture_refuses_the_whole_run() {
        // Base64 of bytes that are no JPEG, a JPEG cut off before its frame header, a scan with
        // no frame header in front of it, and text that is not base64 at all.
        let headless = [0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0];
        let wrong = [
            base64_of(b"GIF89a...."),
            base64_of(&TINY_JPEG[..20]),
            base64_of(&headless),
            "not base64 at all!".to_owned(),
            String::new(),
        ];
        for bad in wrong {
            // Wherever in the run it is: nothing is sent around a hole.
            for at in [0, 2, MIN_RUN_FRAMES - 1] {
                let mut run = run_of(MIN_RUN_FRAMES);
                run[at].jpeg.clone_from(&bad);
                assert_eq!(pictures(&run).unwrap_err(), NOT_A_PICTURE, "{bad} at {at}");
            }
        }
    }

    #[test]
    fn a_run_over_the_cap_is_refused_by_its_count_its_text_and_its_bytes() {
        // One frame too many, however small each is: refused, never cut to the newest twenty.
        assert_eq!(
            pictures(&run_of(MAX_RUN_FRAMES + 1)).unwrap_err(),
            TOO_LARGE
        );
        assert!(pictures(&run_of(MAX_RUN_FRAMES)).is_ok());

        // By the text alone, before any of it is decoded: this is not base64 and is never read.
        let mut long = run_of(MIN_RUN_FRAMES);
        long[0].jpeg = "!".repeat(MAX_RUN_BYTES / 3 * 4 + 64);
        assert_eq!(pictures(&long).unwrap_err(), TOO_LARGE);

        // Frames that each fit and together do not: one byte past the cap…
        let share = MAX_RUN_BYTES / MIN_RUN_FRAMES;
        let padded = |length: usize| {
            let mut jpeg = TINY_JPEG.to_vec();
            jpeg.resize(length, 0);
            jpeg
        };
        let mut over: Vec<SubmissionFrame> = (0..MIN_RUN_FRAMES)
            .map(|_| frame_of(&padded(share), 0.0))
            .collect();
        over[0] = frame_of(
            &padded(MAX_RUN_BYTES - share * (MIN_RUN_FRAMES - 1) + 1),
            0.0,
        );
        assert_eq!(pictures(&over).unwrap_err(), TOO_LARGE);
        // …and exactly at it, which is a run.
        over[0] = frame_of(&padded(MAX_RUN_BYTES - share * (MIN_RUN_FRAMES - 1)), 0.0);
        assert_eq!(pictures(&over).expect("a run").body.len(), MAX_RUN_BYTES);
    }

    #[test]
    fn the_label_is_the_printing_as_this_install_knows_it() {
        let state = seeded("submit-label");
        let label = labelled(&state, &submission("c-bolt", "foil")).expect("a label");
        assert_eq!(label.v, LABEL_VERSION);
        assert_eq!(
            label.card,
            LabelCard {
                id: "c-bolt".to_owned(),
                // Lower case, whatever the row holds: the inbox takes a set code one way.
                set: "2x2".to_owned(),
                number: "117".to_owned(),
                lang: "en".to_owned(),
                name: "Lightning Bolt".to_owned(),
            }
        );
        assert_eq!(label.finish, "foil");
        assert_eq!(label.scanner.reported.as_deref(), Some(SHOCK));
        assert_eq!(label.scanner.mode, "fast");
        assert_eq!(label.scanner.confidence, Some(0.82));
        assert_eq!(label.scanner.distance, Some(31));
        assert_eq!(label.scanner.bundle, Some(98_000));
        assert_eq!(label.app.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(label.app.platform, "desktop");
    }

    #[test]
    fn the_label_has_an_entry_a_frame_in_the_runs_own_order() {
        let state = seeded("submit-run");
        let mut sent = submission("c-bolt", "foil");
        sent.run = run_of(6);
        sent.run[5] = SubmissionFrame {
            ok: true,
            lock: Some("locked".to_owned()),
            confidence: Some(0.9126),
            distance: Some(12),
            decided: Some(BOLT.to_owned()),
            detail: true,
            ..frame_of(TINY_JPEG, 0.0)
        };
        let label = labelled(&state, &sent).expect("a label");
        assert_eq!(
            label.run.iter().map(|frame| frame.ms).collect::<Vec<_>>(),
            [-550, -440, -330, -220, -110, 0]
        );
        // What the scanner made nothing of says so in `null`s, with its size beside it…
        assert_eq!(
            label.run[0],
            LabelFrame {
                ms: -550,
                bytes: 35,
                width: 160,
                height: 120,
                ok: false,
                lock: None,
                confidence: None,
                distance: None,
                decided: None,
                detail: false,
            }
        );
        // …and the frame it decided on carries what it said.
        assert_eq!(
            label.run[5],
            LabelFrame {
                ms: 0,
                bytes: 35,
                width: 160,
                height: 120,
                ok: true,
                lock: Some("locked".to_owned()),
                confidence: Some(0.913),
                distance: Some(12),
                decided: Some(BOLT.to_owned()),
                detail: true,
            }
        );
    }

    #[test]
    fn a_printing_these_cards_do_not_have_is_refused() {
        let state = seeded("submit-unknown");
        let refused = labelled(&state, &submission("c-nobody", "nonfoil")).unwrap_err();
        assert_eq!(refused, NO_SUCH_PRINTING);
    }

    #[test]
    fn a_finish_the_printing_is_not_made_in_is_refused_by_name() {
        let state = seeded("submit-finish");
        let refused = labelled(&state, &submission("c-bolt", "etched")).unwrap_err();
        assert_eq!(refused, "Lightning Bolt (2X2 117) does not come in etched.");
        // And a word that is no finish at all, before the card is read.
        let refused = labelled(&state, &submission("c-nobody", "shiny")).unwrap_err();
        assert_eq!(refused, "shiny is not a finish a card comes in.");
    }

    #[test]
    fn a_printing_whose_finishes_are_unknown_refuses_none() {
        let state = seeded("submit-unknown-finishes");
        for unknown in ["NULL", "'[]'", "'not json'"] {
            state
                .lock_db()
                .execute(
                    &format!("UPDATE cards SET finishes = {unknown} WHERE id = 'c-bolt'"),
                    [],
                )
                .expect("the row");
            for finish in FINISHES {
                assert!(
                    labelled(&state, &submission("c-bolt", finish)).is_ok(),
                    "{unknown} {finish}"
                );
            }
        }
    }

    #[test]
    fn the_scanners_figures_are_tidied_and_never_a_reason_to_refuse() {
        let state = seeded("submit-figures");
        let mut sent = submission("c-bolt", "nonfoil");
        sent.reported = Some("   ".to_owned());
        sent.confidence = Some(1.4);
        sent.distance = Some(900);
        sent.bundle = None;
        // One frame with every figure outside its own range.
        sent.run[0] = SubmissionFrame {
            ms: 250.4,
            lock: Some("Locked On".to_owned()),
            confidence: Some(f64::INFINITY),
            distance: Some(257),
            decided: Some("an id\nwith a line in it".to_owned()),
            ..frame_of(TINY_JPEG, 0.0)
        };
        sent.run[1].ms = f64::NAN;
        sent.run[2].ms = -9_000_000.0;
        sent.run[3].ms = -219.6;
        sent.run[3].confidence = Some(-0.2);
        // An id of another kind — the tracker's leader is an oracle card, by a name like this
        // one in a test — is not a printing the scanner decided on.
        sent.run[3].decided = Some("c-bolt".to_owned());
        sent.run[4].decided = Some(BOLT.to_uppercase());
        let label = labelled(&state, &sent).expect("a label");
        assert_eq!(label.scanner.reported, None);
        assert_eq!(label.scanner.confidence, Some(1.0));
        assert_eq!(label.scanner.distance, None);
        assert_eq!(label.scanner.bundle, None);
        // A frame is never after the press, never a fraction and never further back than a
        // minute; a clock that read nothing is the press itself.
        assert_eq!(label.run[0].ms, 0);
        assert_eq!(label.run[1].ms, 0);
        assert_eq!(label.run[2].ms, -60_000);
        assert_eq!(label.run[3].ms, -220);
        assert_eq!(label.run[0].lock, None);
        assert_eq!(label.run[0].confidence, None);
        assert_eq!(label.run[0].distance, None);
        assert_eq!(label.run[0].decided, None);
        assert_eq!(label.run[3].confidence, Some(0.0));
        assert_eq!(label.run[3].decided, None);
        assert_eq!(label.run[4].decided, None);
        // And an id that is one, with a space the page left round it, is kept.
        sent.reported = Some(format!(" {SHOCK} "));
        sent.bundle = Some(MAX_BUNDLE_LABELS + 1);
        let kept = labelled(&state, &sent).expect("a label");
        assert_eq!(kept.scanner.reported.as_deref(), Some(SHOCK));
        assert_eq!(kept.scanner.bundle, None);
        sent.reported = Some("   ".to_owned());
        sent.bundle = None;

        sent.confidence = Some(f64::NAN);
        assert_eq!(
            labelled(&state, &sent).expect("a label").scanner.confidence,
            None
        );

        // A mode is a short word; anything else is a build that has drifted.
        sent.mode = "Fast Mode".to_owned();
        assert_eq!(
            labelled(&state, &sent).unwrap_err(),
            "Fast Mode is not a scan mode."
        );
    }

    #[test]
    fn the_filters_cross_as_set_codes_and_dates_and_nothing_else() {
        let state = seeded("submit-filters");
        let mut sent = submission("c-bolt", "foil");
        assert_eq!(
            labelled(&state, &sent).expect("a label").scanner.filters,
            LabelFilters {
                sets: Vec::new(),
                from: None,
                to: None
            }
        );

        sent.filters = ScanFilters {
            sets: [" 2X2 ", "lea", "", "2x2", "not a set code", "../x"]
                .map(str::to_owned)
                .to_vec(),
            // A cleared date input is a blank, which is no bound; a date is `YYYY-MM-DD`.
            released_from: Some("  ".to_owned()),
            released_to: Some("2022-07-08".to_owned()),
            exclude_promos: false,
        };
        assert_eq!(
            labelled(&state, &sent).expect("a label").scanner.filters,
            LabelFilters {
                sets: vec!["2x2".to_owned(), "lea".to_owned()],
                from: None,
                to: Some("2022-07-08".to_owned())
            }
        );

        sent.filters.released_to = Some("8 July 2022".to_owned());
        sent.filters.sets = (0..200).map(|n| format!("s{n}")).collect();
        let filters = labelled(&state, &sent).expect("a label").scanner.filters;
        assert_eq!(filters.to, None);
        assert_eq!(filters.sets.len(), MAX_FILTER_SETS);
        assert_eq!(filters.sets[0], "s0");
    }

    #[test]
    fn a_label_crosses_as_ascii_and_reads_back_whole() {
        let state = seeded("submit-ascii");
        state
            .lock_db()
            .execute(
                "UPDATE cards SET name = 'Lim-Dûl’s Vault 🜂', collector_number = '107★'
                  WHERE id = 'c-bolt'",
                [],
            )
            .expect("the row");
        let label = labelled(&state, &submission("c-bolt", "nonfoil")).expect("a label");
        let header = ascii_json(&label).expect("a header");
        assert!(
            header.bytes().all(|b| (0x20..=0x7e).contains(&b)),
            "{header}"
        );
        // A character past the basic plane is a surrogate pair, as JSON spells one.
        assert!(header.contains("\\ud83d\\udf02"), "{header}");
        assert_eq!(serde_json::from_str::<Label>(&header).expect("JSON"), label);
        // An absent figure is `null`, never a missing key — at the press and in every frame.
        let bare = ascii_json(&written()).expect("a header");
        for absent in [
            "reported",
            "confidence",
            "distance",
            "bundle",
            "from",
            "to",
            "lock",
            "decided",
        ] {
            assert!(
                bare.contains(&format!("\"{absent}\":null")),
                "{absent}: {bare}"
            );
        }
    }

    /// **The header has a size and the label has twenty frames in it.** Every field that could
    /// run on is bounded where it is tidied; this is the sum of those bounds, with the longest
    /// card name there is spelled in characters that each cost six.
    #[test]
    fn the_longest_label_a_run_can_make_fits_its_header() {
        let id = "f".repeat(8) + "-ffff-ffff-ffff-" + &"f".repeat(12);
        let worst = SubmissionFrame {
            ms: -59_999.0,
            ok: false,
            lock: Some("a".repeat(16)),
            confidence: Some(0.123_456),
            distance: Some(256),
            decided: Some(id.clone()),
            detail: false,
            ..frame_of(TINY_JPEG, 0.0)
        };
        let widest = Measured {
            bytes: u32::try_from(MAX_RUN_BYTES).expect("a cap"),
            width: 65_535,
            height: 65_535,
        };
        let mut label = written();
        label.card = LabelCard {
            id: id.clone(),
            set: "a".repeat(8),
            number: "★".repeat(32),
            lang: "zhs".to_owned(),
            name: "龍".repeat(200),
        };
        label.scanner = LabelScanner {
            reported: Some(id),
            mode: "a".repeat(16),
            confidence: Some(0.123),
            distance: Some(256),
            bundle: Some(MAX_BUNDLE_LABELS),
            filters: tidy_filters(&ScanFilters {
                sets: (0..200).map(|n| format!("set{n:05}")).collect(),
                released_from: Some("1993-08-05".to_owned()),
                released_to: Some("2026-10-11".to_owned()),
                exclude_promos: false,
            }),
        };
        label.run = vec![tidy_frame(&worst, widest); MAX_RUN_FRAMES];
        let header = ascii_json(&label).expect("inside the header");
        assert!(header.len() <= MAX_LABEL_CHARS, "{}", header.len());
        // And it is a bound that is met, not one with nothing near it: a label this side could
        // not have built — a name of a thousand such characters — is refused in the reader's
        // sentence rather than sent to be a 400.
        label.card.name = "龍".repeat(1000);
        assert_eq!(ascii_json(&label).unwrap_err(), TOO_LARGE);
    }

    /// **The wire, held from both ends by one file.** The inbox is another deploy in another
    /// language, and each side's suite was written against a label of its own making: a number
    /// spelled another way, a `null` left out, an escape in another case would be a 400 for
    /// every submission with both suites green. So one header, exactly as this side writes it,
    /// is kept beside the source — and `infrastructure/scan-worker`'s `label.test.ts` reads the
    /// same file and holds `readLabel` to taking it whole.
    #[test]
    fn the_label_on_the_wire_is_the_one_the_inbox_is_tested_against() {
        let golden = include_str!("__golden__/scan-label.txt").trim_end();
        let seen = |ms: i32, bytes: u32| LabelFrame {
            ms,
            bytes,
            width: 960,
            height: 540,
            ok: true,
            lock: Some("acquiring".to_owned()),
            confidence: None,
            distance: Some(44),
            decided: None,
            detail: false,
        };
        let label = Label {
            v: LABEL_VERSION,
            card: LabelCard {
                id: "ce711943-c1a1-43a0-8b89-8d169cfb8e06".to_owned(),
                set: "2x2".to_owned(),
                number: "117★".to_owned(),
                lang: "en".to_owned(),
                name: "Lim-Dûl’s Vault".to_owned(),
            },
            finish: "foil".to_owned(),
            scanner: LabelScanner {
                reported: Some("f29ba16f-c8fb-42fe-aabf-87089cb214a7".to_owned()),
                mode: "exact".to_owned(),
                confidence: Some(0.82),
                distance: Some(31),
                bundle: None,
                filters: LabelFilters {
                    sets: vec!["2x2".to_owned(), "lea".to_owned()],
                    from: None,
                    to: Some("2022-07-08".to_owned()),
                },
            },
            app: LabelApp {
                version: "0.43.0".to_owned(),
                platform: "android".to_owned(),
            },
            run: vec![
                LabelFrame {
                    ms: -440,
                    bytes: 48_211,
                    width: 960,
                    height: 540,
                    ok: false,
                    lock: None,
                    confidence: None,
                    distance: None,
                    decided: None,
                    detail: false,
                },
                seen(-330, 51_877),
                seen(-220, 52_340),
                LabelFrame {
                    lock: Some("locked".to_owned()),
                    confidence: Some(0.413),
                    distance: Some(31),
                    detail: true,
                    ..seen(-110, 52_102)
                },
                LabelFrame {
                    lock: Some("locked".to_owned()),
                    confidence: Some(0.82),
                    distance: Some(31),
                    decided: Some("f29ba16f-c8fb-42fe-aabf-87089cb214a7".to_owned()),
                    ..seen(0, 51_990)
                },
            ],
        };
        assert_eq!(ascii_json(&label).expect("a header"), golden);
    }

    #[test]
    fn the_inbox_asked_is_the_override_when_one_is_stored() {
        let state = seeded("submit-base");
        assert_eq!(base(&state.lock_db_read()), SCAN_BASE);
        crate::sync_engine::client::set_state(&state.lock_db(), SCAN_URL, " http://local/ ")
            .expect("the override");
        assert_eq!(base(&state.lock_db_read()), "http://local");
    }

    /// The whole trip: the table's own entry point, against an inbox that takes it.
    #[tokio::test]
    async fn a_scan_is_posted_as_its_frames_end_to_end_with_its_label_in_a_header() {
        let inbox = httpmock::MockServer::start();
        let state = seeded("submit-trip");
        crate::sync_engine::client::set_state(&state.lock_db(), SCAN_URL, &inbox.base_url())
            .expect("the override");
        let expected = labelled(&state, &submission("c-bolt", "foil")).expect("a label");
        let header = ascii_json(&expected).expect("a header");
        let took = inbox.mock(|when, then| {
            when.method(POST)
                .path("/scan")
                .header("content-type", "application/octet-stream")
                // The relay's token for this device, which is what the inbox lets a scan in by.
                .header("authorization", format!("Bearer {HELD}").as_str())
                .header(LABEL_HEADER, header.as_str())
                // The frames byte for byte and nothing between them: nothing wraps a frame and
                // nothing re-encodes one.
                .is_true(|sent| sent.body_ref() == TINY_JPEG.repeat(MIN_RUN_FRAMES).as_slice());
            then.status(201)
                .header("content-type", "application/json")
                .body(r#"{"id":"20261011T101500Z-0123456789abcdef"}"#);
        });

        let sent = submit(&state, submission("c-bolt", "foil")).await;
        took.assert();
        assert_eq!(sent.expect("taken").id, "20261011T101500Z-0123456789abcdef");
    }

    #[tokio::test]
    async fn a_refusal_from_this_side_asks_the_inbox_nothing() {
        let inbox = httpmock::MockServer::start();
        let state = seeded("submit-unasked");
        crate::sync_engine::client::set_state(&state.lock_db(), SCAN_URL, &inbox.base_url())
            .expect("the override");
        let asked = inbox.mock(|when, then| {
            when.any_request();
            then.status(201).body(r#"{"id":"x"}"#);
        });

        let no_card = submit(&state, submission("c-nobody", "foil")).await;
        assert_eq!(no_card.unwrap_err(), NO_SUCH_PRINTING);

        let mut holed = submission("c-bolt", "foil");
        holed.run[2].jpeg = "!!".to_owned();
        assert_eq!(submit(&state, holed).await.unwrap_err(), NOT_A_PICTURE);

        // One picture is never sent, whatever else about the submission is whole.
        let mut single = submission("c-bolt", "foil");
        single.run.truncate(1);
        assert_eq!(submit(&state, single).await.unwrap_err(), TOO_SHORT);
        asked.assert_calls(0);
    }

    /// One inbox answering one status, and what the reader is told for it.
    async fn told(status: u16, body: &str) -> String {
        let inbox = httpmock::MockServer::start();
        inbox.mock(|when, then| {
            when.method(POST).path("/scan");
            then.status(status).body(body);
        });
        send(&inbox.base_url(), TINY_JPEG.to_vec(), &written(), HELD)
            .await
            .expect_err("a refusal")
    }

    #[tokio::test]
    async fn each_refusal_of_the_inboxs_is_a_sentence_for_a_reader() {
        assert_eq!(
            told(413, r#"{"error":"…","code":"run_limit"}"#).await,
            TOO_LARGE
        );
        // The inbox would not take this device's token, with or without a word about why.
        assert_eq!(told(401, r#"{"error":"unauthorized"}"#).await, NOT_ACCEPTED);
        assert_eq!(told(403, "").await, NOT_ACCEPTED);
        assert_eq!(
            told(429, r#"{"error":"…","code":"rate_limited"}"#).await,
            SLOW_DOWN
        );
        assert_eq!(
            told(503, r#"{"error":"…","code":"inbox_full"}"#).await,
            INBOX_FULL
        );
        // A 429 that is not the inbox's own limiter — the host in front of it has limits of its
        // own — is not a thing a minute's wait cures, and is named by its number instead.
        assert_eq!(
            told(429, "error code: 1027").await,
            "The scan could not be sent: the server answered 429."
        );
        // A 503 that is not the inbox's own is a server that is down, and says so by number.
        assert_eq!(
            told(503, "upstream").await,
            "The scan could not be sent: the server answered 503."
        );
        assert_eq!(
            told(404, "").await,
            "The scan could not be sent: the server answered 404."
        );
        // The inbox's sentence for a developer is never the reader's.
        assert_eq!(
            told(400, r#"{"error":"that label is not JSON"}"#).await,
            "The scan could not be sent: the server answered 400."
        );
    }

    #[tokio::test]
    async fn a_201_with_no_reference_in_it_is_not_a_scan_taken() {
        let unread = "The scan was sent, but the server's answer could not be read.";
        assert_eq!(told(201, "").await, unread);
        assert_eq!(told(201, r#"{"id":""}"#).await, unread);
        assert_eq!(told(201, r#"{"id":"<b>hello</b>"}"#).await, unread);
    }

    /// **Sending a scan is a supporter's**, held in the engine: a device with no membership
    /// behind it is refused before a frame is read, whatever it handed over, and neither the
    /// relay nor the inbox hears of it.
    #[tokio::test]
    async fn a_device_with_no_membership_behind_it_sends_nothing() {
        let inbox = httpmock::MockServer::start();
        let state = unconnected("submit-unconnected");
        crate::sync_engine::client::set_state(&state.lock_db(), SCAN_URL, &inbox.base_url())
            .expect("the override");
        let asked = inbox.mock(|when, then| {
            when.any_request();
            then.status(201).body(r#"{"id":"x"}"#);
        });

        let whole = submit(&state, submission("c-bolt", "foil")).await;
        assert_eq!(whole.unwrap_err(), NOT_ON);
        // Who may send is asked before what is sent: one picture, from this device, is told
        // about the device.
        let mut single = submission("c-bolt", "foil");
        single.run.truncate(1);
        assert_eq!(submit(&state, single).await.unwrap_err(), NOT_ON);
        asked.assert_calls(0);

        // And a membership that has ended is no membership: the status the relay last gave.
        entitlement::store_status(&state.lock_db(), "dead", None).expect("the status");
        let ended = submit(&state, submission("c-bolt", "foil")).await;
        assert_eq!(ended.unwrap_err(), NOT_ON);
        asked.assert_calls(0);
    }

    /// A supporter through its **group** — a phone paired to the device that connected — holds
    /// no secret of its own and sends all the same: the status is the signal.
    #[tokio::test]
    async fn a_device_entitled_through_its_group_is_let_past_the_first_check() {
        let state = unconnected("submit-group");
        entitlement::store_status(&state.lock_db(), "active", None).expect("the status");
        // Past `entitled`, and stopped at the token: this state is in no group, so there is
        // nothing to mint one with — which the relay's own module calls sync being off.
        let refused = submit(&state, submission("c-bolt", "foil")).await;
        assert_eq!(refused.unwrap_err(), NOT_ON);
        // A card Patreon is still retrying is a membership that has not ended.
        entitlement::store_status(&state.lock_db(), "grace", None).expect("the status");
        assert!(crate::sync_engine::commands::entitled(
            &state.lock_db_read()
        ));
    }

    /// A token that has to be minted again and a relay that cannot be reached: the scan is not
    /// sent, the inbox is not asked, and the sentence is this module's own.
    #[tokio::test]
    async fn a_token_the_relay_cannot_be_asked_for_stops_the_scan_before_the_inbox() {
        let inbox = httpmock::MockServer::start();
        let state = unconnected("submit-unconfirmed");
        // Dead a minute ago, so the refresh door is asked — at a relay that is not there.
        connect(&state, -60);
        {
            let conn = state.lock_db();
            crate::sync_engine::client::set_state(&conn, SCAN_URL, &inbox.base_url())
                .expect("the override");
            crate::sync_engine::client::set_state(
                &conn,
                crate::sync_engine::client::RELAY_URL,
                "http://127.0.0.1:1",
            )
            .expect("the relay's override");
        }
        let asked = inbox.mock(|when, then| {
            when.any_request();
            then.status(201).body(r#"{"id":"x"}"#);
        });
        let refused = submit(&state, submission("c-bolt", "foil")).await;
        assert_eq!(refused.unwrap_err(), UNCONFIRMED);
        asked.assert_calls(0);
    }

    /// **No sentence of this module names a membership.** The page says each as it stands on
    /// every host, and the build Google Play distributes may not lead a reader to a membership
    /// bought elsewhere; its host rewords only what a `sync_` command says, and this is not one.
    #[test]
    fn no_sentence_a_reader_is_shown_names_a_membership() {
        for sentence in [
            NO_SUCH_PRINTING,
            NOT_A_PICTURE,
            TOO_LARGE,
            TOO_SHORT,
            INBOX_FULL,
            SLOW_DOWN,
            UNREACHABLE,
            NOT_ON,
            UNCONFIRMED,
            NOT_ACCEPTED,
        ] {
            let said = sentence.to_lowercase();
            for word in ["patreon", "membership", "supporter", "pledge", "subscri"] {
                assert!(!said.contains(word), "{sentence}");
            }
        }
    }

    #[tokio::test]
    async fn an_inbox_that_cannot_be_reached_is_said_in_one_sentence() {
        let refused = send("http://127.0.0.1:1", TINY_JPEG.to_vec(), &written(), HELD).await;
        assert_eq!(refused.unwrap_err(), UNREACHABLE);
    }
}
