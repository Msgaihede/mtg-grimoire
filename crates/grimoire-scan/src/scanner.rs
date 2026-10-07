//! **What the scanner's module does, with no browser in it** — so every decision it makes is
//! compiled and tested on a desktop. `glue.rs` is the browser: the exports, a `thread_local`,
//! a clock and a console. Everything those exports *answer* is built here.
//!
//! [`Scanner`] is one session and what a reload owes it. Its four calls answer the JSON text
//! an export hands back, each `{"ok": …}` or `{"err": "<sentence>"}` ([`ok`], [`err`]) — the
//! web host's envelope (`grimoire_web::wire::answer`), written here rather than shared because
//! this crate links none of the engine.
//!
//! **A verdict is serialised straight from the crate's type**, never through a
//! `serde_json::Value`: a `Value` sorts an object's keys and widens every `f32` to an `f64`
//! (`0.3` comes out as `0.30000001192092896`), and what a page reads here is meant to be what
//! the desktop's `scanner_frame` hands its own page, byte for byte.

use card_scanner::filters::ScanFilters;
use card_scanner::index::Bundle;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::session::{FrameOptions, Session};
use serde::Serialize;

/// How many candidates a verdict carries. The app's (`grimoire_core::scanner`).
pub const TOP: usize = 5;

/// What a load says when it was handed one model and not the other. The readers are a pair:
/// one alone reads nothing.
pub const ONE_MODEL: &str = "one model without the other: the readers need both";

/// What every export answers once a panic has ended the instance — see `glue`.
pub const PANICKED: &str =
    "the scanner panicked earlier and this instance cannot answer again: start a new one";

/// An export's answer: one key, never both, and the key is the switch.
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Answer<T> {
    Ok(T),
    Err(String),
}

fn text<T: Serialize>(answer: &Answer<T>) -> String {
    // Still something parseable if a value will not encode: a caller waiting on a string that
    // never came is the one outcome this module may not have.
    serde_json::to_string(answer).unwrap_or_else(|e| {
        serde_json::json!({ "err": format!("an answer would not encode: {e}") }).to_string()
    })
}

/// `{"ok": <value>}`. An answer of nothing is `{"ok":null}`.
pub fn ok<T: Serialize>(value: T) -> String {
    text(&Answer::Ok(value))
}

/// `{"err": "<sentence>"}`.
pub fn err(sentence: impl Into<String>) -> String {
    text(&Answer::<()>::Err(sentence.into()))
}

/// What a [`Scanner::load`] found — facts, and the crate's own words where something would
/// not load. Never a sentence about where the bytes came from: that is the page's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Loaded {
    pub bundle: BundleFacts,
    /// Labels attached. Zero is a session that answers ids with no names.
    pub labels: u32,
    pub models: ModelFacts,
    /// Filters an earlier session held that this one would not take, in the crate's words —
    /// see [`Scanner::load`]. `null` when nothing is owed.
    pub unapplied_filters: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BundleFacts {
    pub loaded: bool,
    /// Entries in the bundle's card section — one per face a printing is filed under.
    pub entries: u32,
    /// Why the bundle did not load; or, beside `loaded: true`, why its labels did not
    /// (`labels: …`) — a state of its own, in which a frame still answers, with ids.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ModelFacts {
    /// Whether both readers loaded. They are a pair.
    pub loaded: bool,
    pub error: Option<String>,
}

/// Filters no session has taken yet.
///
/// **A debt, not a hand-over** — `grimoire_core::scanner`'s rule, mirrored: what a replaced
/// session was searching under is owed to the next, stays owed past a load that cannot take it
/// (no labels to build a mask from), and is settled only by a session accepting it or by the
/// page's own newer word being accepted. Offered once and dropped, a reload without labels
/// would search every printing under a popover that still showed the filters.
#[derive(Debug, Clone)]
struct Owed {
    filters: ScanFilters,
    /// What the session loaded since said to them, if one has been asked.
    refusal: Option<String>,
}

/// One session, and what a reload owes it.
pub struct Scanner {
    session: Session,
    /// Whether [`Scanner::load`] has run. Until it has, the session is one with no reference:
    /// it answers a frame, with no card named, and is never asked about filters.
    loaded: bool,
    owed: Option<Owed>,
}

impl Default for Scanner {
    fn default() -> Scanner {
        Scanner::new()
    }
}

impl Scanner {
    /// A scanner with nothing loaded: a frame is answered as a session with no reference
    /// answers one.
    pub fn new() -> Scanner {
        Scanner {
            session: Session::new(None, None, TOP),
            loaded: false,
            owed: None,
        }
    }

    /// The filters in force on the session there is.
    pub fn filters(&self) -> &ScanFilters {
        self.session.filters()
    }

    /// Build the session from bytes, replacing the one there was, and say what loaded.
    ///
    /// Each input is optional and each failure is a fact on its own asset, never an error out
    /// of here: a session with no models still names cards, and one with no labels still
    /// answers ids. **The models are a pair** — one without the other loads neither
    /// ([`ONE_MODEL`]). **Labels of no bytes are no labels**, which is what the engine hands
    /// over while its corpus is empty; labels that will not decode are `labels: …` on the
    /// bundle's `error`, beside `loaded: true`, and none of them is attached.
    ///
    /// **The session there was goes first, and each input as soon as it has been read.** A
    /// WASM memory never shrinks, so what is alive at once is the figure the page pays. That
    /// peak is not the session alone: the glue has copied all four inputs into this memory
    /// before the first line here runs — some twenty-four megabytes with a full corpus's
    /// labels — and they stand beside the session as it is built, each until it has been
    /// read. What is spared is the *old* session under them, which is why it goes first.
    ///
    /// **What a reload keeps is the filters** ([`Owed`]): the ones the replaced session held,
    /// or the ones the page set before any session was loaded, are offered to the new one. If
    /// it will not take them its sentence is `unapplied_filters`, and they stay owed. The
    /// evidence for the card in front of the lens goes, and `decision_seq` starts again from
    /// zero.
    pub fn load(
        &mut self,
        bundle: Option<Vec<u8>>,
        labels: Option<Vec<u8>>,
        detection: Option<Vec<u8>>,
        recognition: Option<Vec<u8>>,
    ) -> Loaded {
        let held = self.session.filters().clone();
        if self.loaded && self.owed.is_none() && !held.is_empty() {
            self.owed = Some(Owed {
                filters: held,
                refusal: None,
            });
        }
        self.session = Session::new(None, None, TOP);

        let mut facts = Loaded::default();
        let reference = bundle.and_then(|bytes| match Bundle::from_bytes(&bytes) {
            Ok(bundle) => {
                drop(bytes);
                facts.bundle.loaded = true;
                facts.bundle.entries = u32::try_from(bundle.cards.len()).unwrap_or(u32::MAX);
                Some(Reference::new(bundle))
            }
            Err(e) => {
                facts.bundle.error = Some(e.to_string());
                None
            }
        });
        let reference = reference.map(|mut reference| {
            if let Some(bytes) = labels.filter(|bytes| !bytes.is_empty()) {
                match card_scanner::labels::attach(&mut reference, &bytes) {
                    Ok(attached) => facts.labels = u32::try_from(attached).unwrap_or(u32::MAX),
                    Err(e) => facts.bundle.error = Some(format!("labels: {e}")),
                }
            }
            reference
        });

        let reader = match (detection, recognition) {
            (None, None) => None,
            (Some(detection), Some(recognition)) => {
                match TitleReader::from_bytes(&detection, &recognition) {
                    Ok(reader) => {
                        facts.models.loaded = true;
                        Some(reader)
                    }
                    Err(e) => {
                        facts.models.error = Some(e);
                        None
                    }
                }
            }
            _ => {
                facts.models.error = Some(ONE_MODEL.to_owned());
                None
            }
        };

        self.session = Session::new(reference, reader, TOP);
        self.loaded = true;
        if let Some(debt) = self.owed.as_mut() {
            match self.session.set_filters(debt.filters.clone()) {
                Ok(()) => self.owed = None,
                // No labels to build the mask from. The session searches unfiltered, as a
                // first load does; the debt stands for the next load.
                Err(sentence) => debt.refusal = Some(sentence),
            }
        }
        facts.unapplied_filters = self.owed.as_ref().and_then(|debt| debt.refusal.clone());
        facts
    }

    /// [`Scanner::load`], as the JSON an export answers: `{"ok": <Loaded>}`.
    pub fn load_json(
        &mut self,
        bundle: Option<Vec<u8>>,
        labels: Option<Vec<u8>>,
        detection: Option<Vec<u8>>,
        recognition: Option<Vec<u8>>,
    ) -> String {
        ok(self.load(bundle, labels, detection, recognition))
    }

    /// One frame through the session: `{"ok": <Verdict>}`, the verdict serialised as the
    /// desktop's `scanner_frame` serialises it.
    ///
    /// `options` is a `FrameOptions` as JSON — what a page's `x-scanner-options` header
    /// carries. Empty text is the defaults, as an absent header is — **and so is text that is
    /// not a `FrameOptions`**, which is `grimoire_core::scanner::frame_from`'s rule for an
    /// unreadable header: the same page sends the same header to every host, and a slider that
    /// defaulted costs a frame where a refusal would cost every frame until a reload. (This
    /// answered an `err` until the page's half was written, 2026-10-07.)
    ///
    /// `detail` is the same frame at the camera's resolution, for the readers
    /// (`Session::frame_with_detail`); none, or no bytes, is none.
    ///
    /// A JPEG that will not decode is not an `err`: it is a verdict, `ok: false` with the
    /// decoder's sentence, exactly as on the desktop.
    pub fn frame(&mut self, jpeg: &[u8], detail: Option<&[u8]>, options: &str) -> String {
        let options: FrameOptions = serde_json::from_str(options).unwrap_or_default();
        let detail = detail.filter(|bytes| !bytes.is_empty());
        ok(self.session.frame_with_detail(jpeg, detail, &options))
    }

    /// Forget the card in front of the lens, keeping the session: `{"ok":null}`.
    pub fn reset(&mut self) -> String {
        self.session.reset();
        ok(())
    }

    /// Narrow every later frame to these sets and release dates. `filters` is a `ScanFilters`
    /// as JSON; `{"ok":null}`, or `{"err": …}` with **the crate's own sentence** — no labels
    /// to filter by, or filters that match no printing — and a refusal keeps the filters
    /// already in force.
    ///
    /// **An accepted push settles whatever a reload still owed**: the session holds what the
    /// page just sent, which is the reader's newer word. **Before the first load there is no
    /// session to ask**, so the filters are taken as they are and owed to it; the load says
    /// what became of them (`unapplied_filters`).
    pub fn set_filters(&mut self, filters: &str) -> String {
        let filters: ScanFilters = match serde_json::from_str(filters) {
            Ok(filters) => filters,
            Err(e) => return err(format!("the scanner's filters did not parse: {e}")),
        };
        if !self.loaded {
            self.owed = (!filters.is_empty()).then_some(Owed {
                filters,
                refusal: None,
            });
            return ok(());
        }
        match self.session.set_filters(filters) {
            Ok(()) => {
                self.owed = None;
                ok(())
            }
            Err(sentence) => err(sentence),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_scanner::hash::{hash_rgb, HashKind};
    use card_scanner::index::{format_uuid, BundleBuilder, Section, ID_LEN};
    use card_scanner::labels::{Encoder, Row};
    use card_scanner::reference::Label;
    use card_scanner::session::ScanMode;
    use image::RgbImage;
    use serde_json::{json, Value};

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).expect("the Worker must be able to parse it")
    }

    /// An answer's `ok`, which it must have.
    fn answered(text: &str) -> Value {
        let mut value = parsed(text);
        assert!(value.get("err").is_none(), "{text}");
        value.get_mut("ok").expect("an ok").take()
    }

    fn refused(text: &str) -> String {
        let value = parsed(text);
        assert!(value.get("ok").is_none(), "{text}");
        value["err"].as_str().expect("a sentence").to_owned()
    }

    // ---- The fixture: `card_scanner::host`'s own, drawn again ----------------------------------

    /// The banded card, face on, `w` wide: a dark border round light title, art, type and text
    /// bands — the horizontal structure card-likeness scores.
    fn banded(w: u32, h: u32) -> RgbImage {
        let border = 11 * w / 250;
        RgbImage::from_fn(w, h, |x, y| {
            if x < border || y < border || x >= w - border || y >= h - border {
                return image::Rgb([16, 16, 18]);
            }
            let v = match y as f32 / h as f32 {
                t if t < 0.10 => 238,
                t if t < 0.55 => 150,
                t if t < 0.62 => 238,
                t if t < 0.92 => 205,
                _ => 140,
            };
            image::Rgb([v, v, v])
        })
    }

    /// A 960×540 JPEG of that card on a flat grey table, `dx` pixels right of centre.
    fn card_frame_jpeg(dx: u32) -> Vec<u8> {
        let card = banded(250, 349);
        let mut frame = RgbImage::from_pixel(960, 540, image::Rgb([96, 100, 104]));
        image::imageops::replace(&mut frame, &card, i64::from(355 + dx), 95);
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(&frame)
            .expect("encode");
        out
    }

    fn id(n: u8) -> [u8; ID_LEN] {
        let mut raw = [0u8; ID_LEN];
        raw[0] = n;
        raw
    }

    /// A bundle that knows the banded card among two it does not — its negative and a
    /// gradient — in colour, as the app's is.
    fn bundle() -> Vec<u8> {
        let kind = HashKind::DHashChroma32;
        let face = banded(card_scanner::RECTIFIED_W, card_scanner::RECTIFIED_H);
        let negative = RgbImage::from_fn(face.width(), face.height(), |x, y| {
            let p = face.get_pixel(x, y).0;
            image::Rgb([255 - p[0], 255 - p[1], 255 - p[2]])
        });
        let gradient = RgbImage::from_fn(60, 84, |x, y| image::Rgb([((x * 3 + y) % 256) as u8; 3]));
        let mut b = BundleBuilder::new(kind, 256);
        for (n, image) in [(1u8, &face), (2, &negative), (3, &gradient)] {
            b.push(Section::Card, id(n), &hash_rgb(image, kind, 256));
        }
        b.finish(0).to_bytes()
    }

    /// The three printings' labels: the banded card in `hob`, the other two in `ltr`.
    fn rows() -> Vec<Row> {
        [(1u8, 10u8, "hob"), (2, 20, "ltr"), (3, 30, "ltr")]
            .into_iter()
            .map(|(n, oracle, set)| Row {
                id: id(n),
                oracle: Some(id(oracle)),
                illustration: None,
                label: Label {
                    name: format!("Card {oracle}"),
                    set: set.into(),
                    number: n.to_string(),
                    lang: "en".into(),
                    released: "2025-01-01".into(),
                },
                finishes: vec!["nonfoil".into(), "foil".into()],
            })
            .collect()
    }

    fn labels() -> Vec<u8> {
        let mut encoder = Encoder::new();
        for row in rows() {
            encoder.push(&row);
        }
        encoder.finish()
    }

    fn loaded() -> Scanner {
        let mut scanner = Scanner::new();
        let facts = scanner.load(Some(bundle()), Some(labels()), None, None);
        assert_eq!((facts.bundle.loaded, facts.labels), (true, 3), "{facts:?}");
        scanner
    }

    /// A verdict as a page parses it. **Through its text, never `serde_json::to_value`**: a
    /// `Value` made from the type holds every `f32` widened to an `f64`
    /// (`0.8880208134651184`), and the text holds what was written (`0.8880208`).
    fn as_a_page_reads(verdict: &card_scanner::session::Verdict) -> Value {
        parsed(&serde_json::to_string(verdict).expect("json"))
    }

    /// A verdict as JSON without what a clock put in it: every `…_ms` key, at any depth.
    fn without_timings(mut verdict: Value) -> Value {
        fn strip(value: &mut Value) {
            match value {
                Value::Object(map) => {
                    map.retain(|key, _| !key.ends_with("_ms"));
                    map.values_mut().for_each(strip);
                }
                Value::Array(items) => items.iter_mut().for_each(strip),
                _ => {}
            }
        }
        strip(&mut verdict);
        verdict
    }

    // ---- The envelope -------------------------------------------------------------------------

    #[test]
    fn an_answer_is_ok_or_err_and_never_both() {
        assert_eq!(ok(()), r#"{"ok":null}"#);
        assert_eq!(ok(json!({ "labels": 2 })), r#"{"ok":{"labels":2}}"#);
        assert_eq!(err("no"), r#"{"err":"no"}"#);
        // A sentence with a quote and a newline in it is still one JSON string.
        assert_eq!(
            refused(&err("it said \"no\"\nand meant it")),
            "it said \"no\"\nand meant it"
        );
    }

    // ---- A load's facts -----------------------------------------------------------------------

    #[test]
    fn a_load_of_nothing_says_nothing_loaded_and_names_no_fault() {
        let mut scanner = Scanner::new();
        assert_eq!(
            scanner.load_json(None, None, None, None),
            r#"{"ok":{"bundle":{"loaded":false,"entries":0,"error":null},"labels":0,"models":{"loaded":false,"error":null},"unapplied_filters":null}}"#
        );
        // Labels with no bundle to attach them to are not a fault either: there is no session
        // to name anything in.
        let facts = scanner.load(None, Some(labels()), None, None);
        assert_eq!(facts, Loaded::default());
    }

    #[test]
    fn a_bundle_and_its_labels_load_and_say_how_many() {
        let mut scanner = Scanner::new();
        let facts = answered(&scanner.load_json(Some(bundle()), Some(labels()), None, None));
        assert_eq!(
            facts,
            json!({
                "bundle": { "loaded": true, "entries": 3, "error": null },
                "labels": 3,
                "models": { "loaded": false, "error": null },
                "unapplied_filters": null,
            })
        );
        // No labels, and labels of no bytes — what the engine hands over while its corpus is
        // empty — are the same thing, and neither is a fault.
        for none in [None, Some(Vec::new())] {
            let facts = scanner.load(Some(bundle()), none, None, None);
            assert_eq!(
                (facts.bundle.loaded, facts.labels, facts.bundle.error),
                (true, 0, None)
            );
        }
    }

    #[test]
    fn a_bundle_that_is_not_one_is_a_fact_in_the_crates_words() {
        let mut scanner = Scanner::new();
        let facts = scanner.load(
            Some(b"<!doctype html>".to_vec()),
            Some(labels()),
            None,
            None,
        );
        assert_eq!(
            facts.bundle,
            BundleFacts {
                loaded: false,
                entries: 0,
                error: Some("not a card-scanner bundle (bad magic)".into()),
            }
        );
        assert_eq!(facts.labels, 0);

        // Every way of cutting a real one short, and a bundle of no bytes: refused, none
        // panics, and the scanner still answers a frame afterwards.
        let whole = bundle();
        for len in 0..whole.len() {
            let facts = scanner.load(Some(whole[..len].to_vec()), None, None, None);
            assert!(!facts.bundle.loaded, "the first {len} bytes loaded");
            assert!(facts.bundle.error.is_some(), "{len} bytes named no fault");
        }
        // A header that claims more entries than any file holds.
        let mut greedy = whole.clone();
        greedy[22..30].copy_from_slice(&[0xff; 8]);
        let facts = scanner.load(Some(greedy), None, None, None);
        assert!(!facts.bundle.loaded && facts.bundle.error.is_some());
        let verdict = answered(&scanner.frame(&card_frame_jpeg(0), None, "{}"));
        assert_eq!(verdict["matcher"], false);
    }

    #[test]
    fn labels_that_will_not_decode_are_a_fault_beside_a_loaded_bundle_and_none_is_attached() {
        let mut scanner = Scanner::new();
        let whole = labels();
        for len in 1..whole.len() {
            let facts = scanner.load(Some(bundle()), Some(whole[..len].to_vec()), None, None);
            assert!(facts.bundle.loaded, "the bundle is its own asset");
            assert_eq!(facts.labels, 0, "{len} bytes of labels attached some");
            let error = facts.bundle.error.expect("a fault");
            assert!(error.starts_with("labels: "), "{error}");
        }
        let facts = scanner.load(Some(bundle()), Some(b"[[\"0000419b".to_vec()), None, None);
        assert_eq!(
            facts.bundle.error.as_deref(),
            Some("labels: not a card-scanner labels file (bad magic)")
        );
        // A frame still answers, and names the card by its id alone.
        let mut named = Value::Null;
        for i in 0..9 {
            let options = r#"{"decide_at":4}"#;
            named = answered(&scanner.frame(&card_frame_jpeg(i % 3), None, options));
        }
        assert_eq!(named["decision"]["printing"], format_uuid(&id(1)));
        assert_eq!(named["decision"]["label"], Value::Null);
    }

    #[test]
    fn the_models_are_a_pair_and_a_model_that_is_not_one_is_a_fact() {
        let mut scanner = Scanner::new();
        for (detection, recognition) in [(Some(vec![1, 2, 3]), None), (None, Some(vec![1, 2, 3]))] {
            let facts = scanner.load(Some(bundle()), None, detection, recognition);
            assert_eq!(
                facts.models,
                ModelFacts {
                    loaded: false,
                    error: Some(ONE_MODEL.into()),
                }
            );
            assert!(
                facts.bundle.loaded,
                "the bundle does not wait for the readers"
            );
        }
        // Bytes that are no model: no bytes, a web page, and noise.
        let noise: Vec<u8> = (0..4096u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        for not_a_model in [Vec::new(), b"<!doctype html><html>".to_vec(), noise] {
            let facts = scanner.load(None, None, Some(not_a_model.clone()), Some(not_a_model));
            assert!(!facts.models.loaded);
            let error = facts.models.error.expect("a fault");
            assert!(error.starts_with("detection model: "), "{error}");
        }
    }

    // ---- A frame ------------------------------------------------------------------------------

    #[test]
    fn before_any_load_a_frame_is_answered_as_a_session_with_no_reference_answers_it() {
        let _one_thread = card_scanner::host::inline();
        let frame = card_frame_jpeg(0);
        let mut bare = Session::new(None, None, TOP);
        let expected = bare.frame_with_detail(&frame, None, &FrameOptions::default());

        let mut scanner = Scanner::new();
        // No options at all are the defaults, as an absent header is.
        for options in ["{}", "", "  "] {
            let verdict = answered(&scanner.frame(&frame, None, options));
            assert_eq!(verdict["ok"], true);
            assert_eq!(verdict["matcher"], false, "no bundle is loaded");
            assert_eq!(verdict["decision_seq"], 0);
            assert_eq!(
                without_timings(verdict),
                without_timings(as_a_page_reads(&expected))
            );
            scanner.reset();
            bare.reset();
        }
        assert_eq!(scanner.reset(), r#"{"ok":null}"#);
    }

    /// **The same frames through this module's `frame` and through the crate's own session
    /// are the same verdicts**, but for their timings — a session built from the same bundle
    /// with its labels attached a row at a time, as `load_labels` attaches them.
    ///
    /// Both under `host::inline()`, which is the browser: one thread, and a resolve inside
    /// the frame it started on.
    fn the_module_answers_what_the_session_does(mode: ScanMode, frames: u32) -> Value {
        let _one_thread = card_scanner::host::inline();
        let options = FrameOptions {
            mode,
            previews: true,
            decide_at: 4.0,
            ..Default::default()
        };
        let options_json = serde_json::to_string(&options).expect("options");

        let mut reference = Reference::new(Bundle::from_bytes(&bundle()).expect("bundle"));
        for row in rows() {
            row.attach(&mut reference);
        }
        let mut direct = Session::new(Some(reference), None, TOP);
        let mut scanner = loaded();

        let mut last = Value::Null;
        for i in 0..frames {
            let frame = card_frame_jpeg(i % 3);
            let expected = direct.frame_with_detail(&frame, None, &options);
            let text = scanner.frame(&frame, None, &options_json);
            // The envelope around the crate's own serialisation, and nothing re-ordered.
            assert!(
                text.starts_with(r#"{"ok":{"ok":true,"frame":{"w":960,"h":540},"#),
                "{text}"
            );
            last = answered(&text);
            assert_eq!(
                without_timings(last.clone()),
                without_timings(as_a_page_reads(&expected)),
                "frame {i} in {mode:?}"
            );
        }
        // The premise: the stream reached a decision, and the labels named it.
        assert_eq!(last["decision_seq"], 1, "never decided in {mode:?}");
        assert_eq!(last["decision"]["printing"], format_uuid(&id(1)));
        assert_eq!(last["decision"]["label"]["name"], "Card 10");
        assert_eq!(last["decision"]["finishes"], json!(["nonfoil", "foil"]));
        last
    }

    #[test]
    fn a_fast_frame_is_the_sessions_own_verdict() {
        let last = the_module_answers_what_the_session_does(ScanMode::Fast, 9);
        assert_eq!(last["mode"], "fast");
    }

    #[test]
    fn an_exact_frame_is_the_sessions_own_verdict() {
        let last = the_module_answers_what_the_session_does(ScanMode::Exact, 7);
        assert_eq!(last["mode"], "exact");
    }

    #[test]
    fn a_frame_that_is_not_a_picture_is_a_verdict_and_options_that_are_not_json_the_defaults() {
        let mut scanner = loaded();
        for not_a_picture in [&b""[..], b"not a jpeg", &[0xff, 0xd8, 0xff, 0xe0, 0, 16]] {
            let verdict = answered(&scanner.frame(not_a_picture, None, "{}"));
            assert_eq!(verdict["ok"], false);
            // **The decoder's own refusal, and not a panic the session caught.** Natively
            // `Session::guarded` turns a panic into this same shape — `ok: false` and a
            // sentence — and in the module, built with `panic = "abort"`, that panic would
            // be a trap. So the sentence is held to the one a decode that *returned* writes.
            let error = verdict["error"].as_str().expect("a sentence");
            assert!(error.starts_with("decode:"), "{error}");
        }
        // A detail image that is not one costs the read it was for, never the frame; and a
        // detail of no bytes is no detail.
        let frame = card_frame_jpeg(0);
        for detail in [&b"not a jpeg"[..], b""] {
            let verdict = answered(&scanner.frame(&frame, Some(detail), "{}"));
            assert_eq!(verdict["ok"], true, "{verdict}");
        }

        // Options nobody can read are the defaults, as the engine's table reads an unreadable
        // header (`grimoire_core::scanner::frame_from`) — never a refusal of the frame.
        let defaults = serde_json::to_value(FrameOptions::default().mode).expect("a mode");
        for options in ["{not json", r#"{"mode":"thorough"}"#, "null", "7"] {
            let verdict = answered(&scanner.frame(&frame, None, options));
            assert_eq!(verdict["ok"], true, "{options}: {verdict}");
            assert_eq!(verdict["mode"], defaults, "{options}: {verdict}");
        }
        // A key this build has never heard of is not a fault: the options are `serde(default)`.
        let verdict = answered(&scanner.frame(&frame, None, r#"{"some_later_slider":3}"#));
        assert_eq!(verdict["ok"], true);
    }

    // ---- Filters, and what a reload owes ------------------------------------------------------

    const LTR: &str = r#"{"sets":["LTR"]}"#;

    fn ltr() -> ScanFilters {
        serde_json::from_str(LTR).expect("filters")
    }

    #[test]
    fn filters_are_the_crates_to_refuse_and_its_sentence_is_the_err() {
        let mut scanner = loaded();
        assert_eq!(scanner.set_filters(LTR), r#"{"ok":null}"#);
        assert!(scanner.filters().same_as(&ltr()));
        assert_eq!(
            refused(&scanner.set_filters(r#"{"sets":["nope"]}"#)),
            "No printing matches these filters."
        );
        assert!(
            scanner.filters().same_as(&ltr()),
            "a refusal keeps the filters in force"
        );
        for filters in ["{not json", r#"{"sets":"ltr"}"#, "null", ""] {
            let sentence = refused(&scanner.set_filters(filters));
            assert!(
                sentence.starts_with("the scanner's filters did not parse: "),
                "{filters:?}: {sentence}"
            );
        }
        assert_eq!(scanner.set_filters("{}"), r#"{"ok":null}"#);
        assert!(scanner.filters().is_empty());

        // With no labels there is nothing to build a mask from, and the crate says so.
        let mut nameless = Scanner::new();
        nameless.load(Some(bundle()), None, None, None);
        let sentence = refused(&nameless.set_filters(LTR));
        assert!(
            sentence.starts_with("Filters need card names"),
            "{sentence}"
        );
        assert_eq!(
            nameless.set_filters("{}"),
            r#"{"ok":null}"#,
            "no filter needs no labels"
        );
    }

    #[test]
    fn filters_narrow_what_a_frame_can_name() {
        let _one_thread = card_scanner::host::inline();
        let mut scanner = loaded();
        scanner.set_filters(LTR);
        // The banded card is the `hob` printing, which the filters exclude: it is not among
        // the candidates, and the frame's best answer is one of the two that are left.
        // The lock takes three frames to trust the card; the match is on the frame after.
        let mut verdict = Value::Null;
        for i in 0..5 {
            verdict = answered(&scanner.frame(&card_frame_jpeg(i % 3), None, "{}"));
        }
        let candidates = verdict["match"]["candidates"]
            .as_array()
            .expect("candidates");
        assert_eq!(candidates.len(), 2, "{candidates:?}");
        assert!(candidates.iter().all(|c| c["label"]["set"] == "ltr"));
    }

    #[test]
    fn filters_set_before_the_first_load_are_owed_to_it() {
        let mut scanner = Scanner::new();
        assert_eq!(scanner.set_filters(LTR), r#"{"ok":null}"#);
        assert!(
            scanner.filters().is_empty(),
            "there is no session to hold them yet"
        );
        let facts = scanner.load(Some(bundle()), Some(labels()), None, None);
        assert_eq!(facts.unapplied_filters, None);
        assert!(
            scanner.filters().same_as(&ltr()),
            "the first session took them"
        );

        // The reader's newer word replaces an older one nothing has taken, and no filters at
        // all owes nothing.
        let mut scanner = Scanner::new();
        scanner.set_filters(r#"{"sets":["hob"]}"#);
        scanner.set_filters("{}");
        scanner.load(Some(bundle()), Some(labels()), None, None);
        assert!(scanner.filters().is_empty());
    }

    #[test]
    fn a_reload_carries_the_filters_and_a_session_that_cannot_take_them_leaves_them_owed() {
        let mut scanner = loaded();
        scanner.set_filters(LTR);

        // Reloaded whole — the models arriving, say: the new session searches under them.
        let facts = scanner.load(Some(bundle()), Some(labels()), None, None);
        assert_eq!(facts.unapplied_filters, None);
        assert!(scanner.filters().same_as(&ltr()));

        // Reloaded with no labels: there is no mask to build. The session searches every
        // printing, the load says so in the crate's words, and the debt stands.
        let facts = scanner.load(Some(bundle()), None, None, None);
        let sentence = facts.unapplied_filters.expect("a refusal");
        assert!(
            sentence.starts_with("Filters need card names"),
            "{sentence}"
        );
        assert!(scanner.filters().is_empty());
        // And through a second one, which is offered them again and still cannot.
        let facts = scanner.load(Some(bundle()), None, None, None);
        assert!(facts.unapplied_filters.is_some());

        // The labels arrive: the filters the reader chose three sessions ago are in force.
        let facts = scanner.load(Some(bundle()), Some(labels()), None, None);
        assert_eq!(facts.unapplied_filters, None);
        assert!(scanner.filters().same_as(&ltr()));
    }

    #[test]
    fn an_accepted_push_settles_a_debt_and_a_refused_one_does_not() {
        let hob = r#"{"sets":["hob"]}"#;
        let owing = || {
            let mut scanner = loaded();
            scanner.set_filters(LTR);
            let facts = scanner.load(Some(bundle()), None, None, None);
            assert!(facts.unapplied_filters.is_some());
            scanner
        };

        // Refused — there are still no labels — so the older filters are still the ones owed.
        let mut scanner = owing();
        refused(&scanner.set_filters(hob));
        scanner.load(Some(bundle()), Some(labels()), None, None);
        assert!(scanner.filters().same_as(&ltr()));

        // Accepted: clearing the filters needs no labels, and it is the reader's newer word.
        let mut scanner = owing();
        assert_eq!(scanner.set_filters("{}"), r#"{"ok":null}"#);
        let facts = scanner.load(Some(bundle()), Some(labels()), None, None);
        assert_eq!(facts.unapplied_filters, None);
        assert!(scanner.filters().is_empty(), "a settled debt came back");
    }
}
