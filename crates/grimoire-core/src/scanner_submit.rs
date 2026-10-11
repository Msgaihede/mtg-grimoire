//! **Sending one scan**: a camera picture and the card a reader says it shows, to the scan inbox
//! (`infrastructure/scan-worker/`), where they are kept to improve the scanner (issue #776).
//!
//! **The one thing in this crate that sends a picture off the device**, and it has one caller:
//! a reader's press on Send, with that picture on the screen and the printing and the finish
//! chosen by hand. Nothing here runs on a launch, on a schedule or on a frame — the scanner
//! itself still examines every picture where it was taken and keeps none.
//!
//! **What is sent is the picture and a [`Label`], and the label says nothing of who sent it**:
//! the printing and its finish, what the scanner had read, the app's version and what kind of
//! host it is on. No device id, no group, no collection. The privacy policy
//! (`apps/light/public/privacy.html`) promises exactly that, so a field added to [`Label`] is a
//! sentence owed there.
//!
//! **The page names the card by id and nothing else about it.** [`label_for`] reads the
//! printing's name, set, number and language out of this install's own card data, and refuses a
//! finish the printing is not made in — so a label cannot pair one printing's id with another's
//! name, and "foil" beside a card that has no foil never reaches the inbox. The label is the
//! whole value of a submission; a wrong one is worse than none.
//!
//! **A `task` in the table, and its picture is base64 in its arguments** — not a `bytes` entry
//! like the scanner's frame. A frame is nine a second and is answered by this engine; this is
//! one call a press, awaited across a network, and `bytes` runs its body on the blocking pool
//! where nothing can be awaited. Four thirds of two megabytes, once, is the price.
//!
//! **Every host sends it the same way**, a page included: a `fetch` from the engine's Worker,
//! which the inbox answers for the web app's origin by name
//! (`infrastructure/scan-worker/src/cors.ts`) and the hosting policy's `connect-src` allows
//! (`infrastructure/app-worker/_headers`). The picture's type and the label's header each cost a
//! browser a pre-flight, which that Worker answers.

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};

use crate::platform::http;
use crate::state::State;

/// The scan inbox's address. Compiled in and public on [`crate::sync_engine::entitlement::
/// RELAY_BASE`]'s terms: the Worker's name and the account's `workers.dev` subdomain. No
/// trailing slash.
///
/// ⚠️ **Three files have to agree with it**: `infrastructure/scan-worker/wrangler.jsonc`'s
/// `name`, the web policy's `connect-src` and the privacy policy's table of hosts. The first
/// two each have a test that reads this line (`scan-worker`'s `wrangler.test.ts`,
/// `app-worker`'s `hosting.test.ts`), and `apps/light/host.test.ts` holds the third to the
/// second.
pub const SCAN_BASE: &str = "https://mtg-grimoire-scans.denmark-east.workers.dev";

/// A `sync_state` row that points this install at another inbox — [`crate::sync_engine::
/// client::RELAY_URL`]'s shape, and like it a row with no UI: it is how a test asks a local
/// server and how a developer asks `wrangler dev --local`.
pub const SCAN_URL: &str = "scan_url";

/// Two megabytes a picture — **`infrastructure/scan-worker/src/env.ts`'s `MAX_FRAME_BYTES`**,
/// which a test there reads this line to hold. Refused here first, so a reader on a slow link
/// is told in a sentence rather than after an upload.
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

/// The header the label rides in — `cors.ts`'s `LABEL_HEADER`, which the same test holds.
pub const LABEL_HEADER: &str = "x-scan-label";

/// The label's shape. A second shape is a second number, and an inbox deployed for it.
pub const LABEL_VERSION: u8 = 1;

/// The finishes a card comes in, as `cards.finishes` and the page both spell them.
const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

/// The inbox's word for "full", `submit.ts`'s `INBOX_FULL` — matched on the code, never on the
/// sentence beside it.
const INBOX_FULL_CODE: &str = "inbox_full";

/// The inbox's word for "this address has sent too many", `index.ts`'s. Matched with the
/// status, because a 429 is not only the inbox's to send: the host in front of it answers one
/// for its own reasons, and "wait a minute" would be the wrong thing to tell a reader then.
const RATE_LIMITED_CODE: &str = "rate_limited";

pub const NO_SUCH_PRINTING: &str = "That printing is not in this device's card data.";
pub const NOT_A_PICTURE: &str = "That picture could not be read.";
pub const TOO_LARGE: &str = "That picture is too large to send.";
pub const INBOX_FULL: &str = "The scan inbox is full for now. Thank you — try again in a few days.";
pub const SLOW_DOWN: &str = "Too many scans were sent at once. Wait a minute and send it again.";
pub const UNREACHABLE: &str = "The scan could not be sent: the server could not be reached.";

/// What a reader says a picture shows, and what the scanner had said — the page's half of a
/// [`Label`], mirrored as `ScannerSubmission` in `packages/ui/lib/ipc.ts`.
///
/// The four after `finish` are the scanner's side at the press, each absent when it had none.
/// They are taken as the page gives them and tidied in [`label_for`]: nothing here is a reason
/// to turn a submission away, because a picture the scanner made nothing of is as much worth
/// having as one it named wrongly.
///
/// **`reported` is the printing the scanner had decided on, and absent while it had decided
/// nothing** — never the card it was only leaning towards. The tracker's leader is keyed by
/// what its evidence pooled on, which is an oracle id: sent here it would be an id of another
/// kind beside `card_id`, and "the scanner got it right" could never be read off the two.
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
}

/// A scan the inbox took, and the reference it filed it under — `ScannerSubmitted` in `ipc.ts`.
/// The reader is shown the id: nothing sent says who sent it, so it is the only way one
/// submission is ever found again.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Submitted {
    pub id: String,
}

/// What the inbox stores beside a picture — `Label` in `infrastructure/scan-worker/src/label.ts`,
/// which checks every field and stores only what it checked. `label.test.ts` there reads these
/// five structs' fields and fails when the two part.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Label {
    pub v: u8,
    pub card: LabelCard,
    pub finish: String,
    pub scanner: LabelScanner,
    pub app: LabelApp,
    pub frame: LabelFrame,
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

/// The scanner's side. An absent figure is `null` on the wire and never left out: the inbox
/// tells "it had none" from "this build does not send it" by the key being there.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelScanner {
    pub reported: Option<String>,
    pub mode: String,
    pub confidence: Option<f64>,
    pub distance: Option<u32>,
    pub bundle: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelApp {
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LabelFrame {
    pub width: u32,
    pub height: u32,
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

/// The picture out of its base64, and its size in pixels as its own header states it.
///
/// **Checked as a JPEG here, not trusted as one**: the size is read out of the frame header, so
/// bytes that are not a JPEG have none and are refused before any request — and the label's
/// `frame` is then a fact about these bytes rather than something the page said about them.
pub fn picture(frame: &str) -> Result<(Vec<u8>, u32, u32), String> {
    // Four characters carry three bytes: a text this long cannot decode to a picture that fits.
    if frame.len() > MAX_FRAME_BYTES / 3 * 4 + 4 {
        return Err(TOO_LARGE.to_owned());
    }
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(frame)
        .map_err(|_| NOT_A_PICTURE.to_owned())?;
    if jpeg.len() > MAX_FRAME_BYTES {
        return Err(TOO_LARGE.to_owned());
    }
    let (width, height) = jpeg_size(&jpeg).ok_or_else(|| NOT_A_PICTURE.to_owned())?;
    Ok((jpeg, width, height))
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

/// A scan mode's name, or anything shaped like one: a short lower-case word, which is what the
/// inbox takes. Not the list of modes, so a third mode is not a submission refused.
fn is_word(text: &str) -> bool {
    (1..=16).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// The label for one submission: the printing read out of this install's own card data, the
/// finish checked against it, and the scanner's figures tidied.
///
/// **Refuses three things, each in a sentence**: a finish that is not a finish, a printing
/// these cards do not have, and a finish that printing is not made in. `cards.finishes` that is
/// missing or unreadable is *unknown* and refuses nothing — an older corpus, not a card with no
/// foil.
pub fn label_for(
    conn: &Connection,
    submission: &Submission,
    width: u32,
    height: u32,
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
            reported: submission
                .reported
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned),
            mode: submission.mode.clone(),
            // A share of the evidence, so between nothing and all of it; and a count of bits
            // out of 256. A figure outside its own range is one the scanner did not mean.
            confidence: submission
                .confidence
                .filter(|c| c.is_finite())
                .map(|c| c.clamp(0.0, 1.0)),
            distance: submission.distance.filter(|bits| *bits <= 256),
            bundle: submission.bundle,
        },
        app: LabelApp {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: crate::platform::device::kind().to_lowercase(),
        },
        frame: LabelFrame { width, height },
    })
}

/// The label as the header carries it: JSON with every character past `~` escaped.
///
/// A header's value is bytes a server reads as Latin-1, so a name sent as it is spelled would
/// arrive as something else; the inbox refuses a header that is not ASCII rather than repair
/// one. `packages/ui/lib/ipc.ts`'s `asciiJson` is this rule for the scanner's own frames. Only
/// a string can hold such a character in JSON, so escaping them one at a time is safe.
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

/// Ten seconds to connect, and **a minute for the answer to begin** — which is not a gap
/// between reads here: the client starts that clock when the request is sent, so it runs
/// through the whole upload, and a picture of a megabyte over a phone's weak uplink is most of
/// the wait. Ninety seconds for all of it where the host has no socket to bound.
fn build_http() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: crate::scryfall::USER_AGENT,
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(60)),
        https_only: false,
    })
    .deadline(Duration::from_secs(90))
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

/// Post one picture and its label to the inbox at `base`, and read what it answers.
///
/// **Every refusal the inbox words is reworded here for a reader**, matched on the status or on
/// the code and never on the inbox's own sentence, which is written for a developer. A status
/// with no sentence of its own is named — on a native host a Worker that is not deployed answers
/// 404, and "the server answered 404" is what says so.
async fn send(base: &str, jpeg: Vec<u8>, label: &Label) -> Result<Submitted, String> {
    let header = ascii_json(label)?;
    let response = http()
        .post(&format!("{base}/scan"))
        .header("content-type", "image/jpeg")
        .header(LABEL_HEADER, &header)
        .bytes(jpeg)
        .send()
        .await
        .map_err(|_| UNREACHABLE.to_owned())?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    match (status, code_of(&body).as_deref()) {
        (201, _) => taken(&body),
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
/// The picture is decoded and the label read on the blocking pool, holding the read connection
/// for one indexed row and letting it go before anything is awaited; then the request. **No
/// lease**: who holds the scanner is one question and what a reader chooses to send is another,
/// as it is for the scanner's files.
pub async fn submit(
    state: &Arc<State>,
    frame: String,
    submission: Submission,
) -> Result<Submitted, String> {
    let shared = Arc::clone(state);
    let (jpeg, label, base) = crate::platform::spawn::blocking(move || -> Result<_, String> {
        let (jpeg, width, height) = picture(&frame)?;
        let conn = shared.lock_db_read();
        let label = label_for(&conn, &submission, width, height)?;
        Ok((jpeg, label, base(&conn)))
    })
    .await
    .map_err(|e| format!("The scan could not be sent: {e}"))??;
    send(&base, jpeg, &label).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::Method::POST;

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

    fn submission(card_id: &str, finish: &str) -> Submission {
        Submission {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            reported: Some("c-shock".to_owned()),
            mode: "fast".to_owned(),
            confidence: Some(0.82),
            distance: Some(31),
            bundle: Some(98_000),
        }
    }

    /// A state on files with one printing in it, made in nonfoil and foil.
    fn seeded(name: &str) -> Arc<State> {
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

    fn labelled(state: &State, submission: &Submission) -> Result<Label, String> {
        label_for(&state.lock_db_read(), submission, 160, 120)
    }

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
            },
            app: LabelApp {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                platform: "desktop".to_owned(),
            },
            frame: LabelFrame {
                width: 160,
                height: 120,
            },
        }
    }

    #[test]
    fn the_inbox_is_one_https_origin_with_no_trailing_slash() {
        assert!(SCAN_BASE.starts_with("https://"));
        assert!(!SCAN_BASE.ends_with('/'));
        assert_eq!(SCAN_BASE.matches('/').count(), 2, "an origin, with no path");
    }

    #[test]
    fn a_picture_is_read_out_of_its_base64_with_its_own_size() {
        let (jpeg, width, height) = picture(&base64_of(TINY_JPEG)).expect("a JPEG");
        assert_eq!(jpeg, TINY_JPEG);
        assert_eq!((width, height), (160, 120));
    }

    #[test]
    fn what_is_not_a_picture_is_refused_before_any_request() {
        assert_eq!(picture("").unwrap_err(), NOT_A_PICTURE);
        assert_eq!(picture("not base64 at all!").unwrap_err(), NOT_A_PICTURE);
        // Base64 of bytes that are no JPEG, and of a JPEG cut off before its frame header.
        assert_eq!(
            picture(&base64_of(b"GIF89a....")).unwrap_err(),
            NOT_A_PICTURE
        );
        assert_eq!(
            picture(&base64_of(&TINY_JPEG[..20])).unwrap_err(),
            NOT_A_PICTURE
        );
        // A scan with no frame header in front of it.
        let headless = [0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0];
        assert_eq!(picture(&base64_of(&headless)).unwrap_err(), NOT_A_PICTURE);
    }

    #[test]
    fn a_picture_over_the_cap_is_refused_by_its_text_and_by_its_bytes() {
        // By the text alone, before it is decoded…
        let long = "A".repeat(MAX_FRAME_BYTES / 3 * 4 + 8);
        assert_eq!(picture(&long).unwrap_err(), TOO_LARGE);
        // …and a JPEG one byte past the cap, whose text is inside the first bound's slack.
        let mut over = TINY_JPEG.to_vec();
        over.resize(MAX_FRAME_BYTES + 1, 0);
        assert_eq!(picture(&base64_of(&over)).unwrap_err(), TOO_LARGE);
        // At the cap it is a picture.
        let mut at = TINY_JPEG.to_vec();
        at.resize(MAX_FRAME_BYTES, 0);
        assert!(picture(&base64_of(&at)).is_ok());
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
        assert_eq!(label.scanner.reported.as_deref(), Some("c-shock"));
        assert_eq!(label.scanner.mode, "fast");
        assert_eq!(label.scanner.confidence, Some(0.82));
        assert_eq!(label.scanner.distance, Some(31));
        assert_eq!(label.scanner.bundle, Some(98_000));
        assert_eq!(label.app.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(label.app.platform, "desktop");
        assert_eq!(
            label.frame,
            LabelFrame {
                width: 160,
                height: 120
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
        let label = labelled(&state, &sent).expect("a label");
        assert_eq!(label.scanner.reported, None);
        assert_eq!(label.scanner.confidence, Some(1.0));
        assert_eq!(label.scanner.distance, None);
        assert_eq!(label.scanner.bundle, None);

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
        // An absent figure is `null`, never a missing key.
        let bare = ascii_json(&written()).expect("a header");
        for absent in ["reported", "confidence", "distance", "bundle"] {
            assert!(
                bare.contains(&format!("\"{absent}\":null")),
                "{absent}: {bare}"
            );
        }
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
            },
            app: LabelApp {
                version: "0.43.0".to_owned(),
                platform: "android".to_owned(),
            },
            frame: LabelFrame {
                width: 1920,
                height: 1080,
            },
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
    async fn a_scan_is_posted_as_a_jpeg_with_its_label_in_a_header() {
        let inbox = httpmock::MockServer::start();
        let state = seeded("submit-trip");
        crate::sync_engine::client::set_state(&state.lock_db(), SCAN_URL, &inbox.base_url())
            .expect("the override");
        let expected = labelled(&state, &submission("c-bolt", "foil")).expect("a label");
        let header = ascii_json(&expected).expect("a header");
        let took = inbox.mock(|when, then| {
            when.method(POST)
                .path("/scan")
                .header("content-type", "image/jpeg")
                .header(LABEL_HEADER, header.as_str())
                // The picture byte for byte: nothing wraps it and nothing re-encodes it.
                .is_true(|sent| sent.body_ref() == TINY_JPEG);
            then.status(201)
                .header("content-type", "application/json")
                .body(r#"{"id":"20261011T101500Z-0123456789abcdef"}"#);
        });

        let sent = submit(&state, base64_of(TINY_JPEG), submission("c-bolt", "foil")).await;
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

        let no_card = submit(&state, base64_of(TINY_JPEG), submission("c-nobody", "foil")).await;
        assert_eq!(no_card.unwrap_err(), NO_SUCH_PRINTING);
        let no_picture = submit(&state, "!!".to_owned(), submission("c-bolt", "foil")).await;
        assert_eq!(no_picture.unwrap_err(), NOT_A_PICTURE);
        asked.assert_calls(0);
    }

    /// One inbox answering one status, and what the reader is told for it.
    async fn told(status: u16, body: &str) -> String {
        let inbox = httpmock::MockServer::start();
        inbox.mock(|when, then| {
            when.method(POST).path("/scan");
            then.status(status).body(body);
        });
        send(&inbox.base_url(), TINY_JPEG.to_vec(), &written())
            .await
            .expect_err("a refusal")
    }

    #[tokio::test]
    async fn each_refusal_of_the_inboxs_is_a_sentence_for_a_reader() {
        assert_eq!(
            told(413, r#"{"error":"…","code":"frame_limit"}"#).await,
            TOO_LARGE
        );
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

    #[tokio::test]
    async fn an_inbox_that_cannot_be_reached_is_said_in_one_sentence() {
        let refused = send("http://127.0.0.1:1", TINY_JPEG.to_vec(), &written()).await;
        assert_eq!(refused.unwrap_err(), UNREACHABLE);
    }
}
