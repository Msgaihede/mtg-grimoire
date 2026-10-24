//! **What the scanner's module does, with no browser in it** — so every decision it makes is
//! compiled and tested on a desktop. `glue.rs` is the browser: the exports, a `thread_local`,
//! a clock and a console. Everything those exports *answer* is built here.
//!
//! [`Scanner`] is one session and what a reload owes it. Four of its calls answer the JSON text
//! an export hands back, each `{"ok": …}` or `{"err": "<sentence>"}` ([`ok`], [`err`]) — the
//! web host's envelope (`grimoire_web::wire::answer`), written here rather than shared because
//! this crate links none of the engine. The fifth and sixth, [`Scanner::load_neural`] and
//! [`Scanner::load_neural_evidence`], answer the crate's refusal or nothing.
//!
//! **A verdict is serialised straight from the crate's type**, never through a
//! `serde_json::Value`: a `Value` sorts an object's keys and widens every `f32` to an `f64`
//! (`0.3` comes out as `0.30000001192092896`), and what a page reads here is meant to be what
//! the desktop's `scanner_frame` hands its own page, byte for byte.

use std::borrow::Cow;

use card_scanner::filters::ScanFilters;
use card_scanner::neural::evidence::EvidenceFiles;
use card_scanner::neural::Files;
use card_scanner::reference::Reference;
use card_scanner::session::Session;
use serde::Serialize;

/// How many candidates a verdict carries. The app's (`grimoire_core::scanner`).
pub const TOP: usize = 5;

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

/// What a [`Scanner::load`] found — facts, never a sentence about where the bytes came from:
/// that is the page's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Loaded {
    /// Labels attached. Zero is a session that names a printing by its id alone — no labels
    /// were handed over, or what was handed over would not decode.
    pub labels: u32,
    /// Filters an earlier session held that this one would not take, in the crate's words —
    /// see [`Scanner::load`]. `null` when nothing is owed.
    pub unapplied_filters: Option<String>,
}

/// Filters no session has taken yet.
///
/// **A debt, not a hand-over**: what a replaced session was searching under is owed to the
/// next, stays owed past a load that cannot take it (no labels to build a mask from), and is
/// settled only by a session accepting it or by the page's own newer word being accepted.
/// Offered once and dropped, a reload without labels would search every printing under a
/// popover that still showed the filters.
#[derive(Debug, Clone)]
struct Owed {
    filters: ScanFilters,
    /// What the session loaded since said to them, if one has been asked.
    refusal: Option<String>,
}

/// One session, and what a reload owes it.
pub struct Scanner {
    session: Session,
    /// Whether [`Scanner::load`] has run. Until it has, the session is one with no labels, and
    /// is never asked about filters.
    loaded: bool,
    owed: Option<Owed>,
}

impl Default for Scanner {
    fn default() -> Scanner {
        Scanner::new()
    }
}

impl Scanner {
    /// A scanner with nothing loaded: a frame is answered as a session with no recogniser
    /// answers one.
    pub fn new() -> Scanner {
        Scanner {
            session: Session::new(None, TOP),
            loaded: false,
            owed: None,
        }
    }

    /// The filters in force on the session there is.
    pub fn filters(&self) -> &ScanFilters {
        self.session.filters()
    }

    /// Build the session from the labels the engine encoded (`card_scanner::labels`), replacing
    /// the one there was, and say how many were attached.
    ///
    /// **Labels of no bytes are no labels**, which is what the engine hands over while its corpus
    /// is empty, and labels that will not decode are none either: the session names a printing
    /// by its id, and builds no filter.
    ///
    /// **The session there was goes first, and the labels as soon as they have been read.** A
    /// WASM memory never shrinks, so what is alive at once is the figure the page pays: the glue
    /// has copied the labels into this memory before the first line here runs, and what is
    /// spared is the *old* session beside them.
    ///
    /// **What a reload keeps is the filters** ([`Owed`]): the ones the replaced session held,
    /// or the ones the page set before any session was loaded, are offered to the new one. If
    /// it will not take them its sentence is `unapplied_filters`, and they stay owed. The
    /// evidence for the card in front of the lens goes, and `decision_seq` starts again from
    /// zero.
    ///
    /// **The Neural files go with the session they were loaded into**
    /// ([`Scanner::load_neural`]): carrying them across would need them twice in a memory that
    /// never shrinks. The page loads each Worker once, and the Neural files after that load — so
    /// a Worker that was asked to load again would be asked for the Neural files again too.
    pub fn load(&mut self, labels: Option<Vec<u8>>) -> Loaded {
        let held = self.session.filters().clone();
        if self.loaded && self.owed.is_none() && !held.is_empty() {
            self.owed = Some(Owed {
                filters: held,
                refusal: None,
            });
        }
        self.session = Session::new(None, TOP);

        let mut facts = Loaded::default();
        let reference = labels.filter(|bytes| !bytes.is_empty()).and_then(|bytes| {
            let mut reference = Reference::new();
            let attached = card_scanner::labels::attach(&mut reference, &bytes).ok()?;
            facts.labels = u32::try_from(attached).unwrap_or(u32::MAX);
            Some(reference)
        });

        self.session = Session::new(reference, TOP);
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
    pub fn load_json(&mut self, labels: Option<Vec<u8>>) -> String {
        ok(self.load(labels))
    }

    /// Give the session the Neural mode's four files — `card-neural`'s detector, embedder,
    /// gallery and `neural.json`, as the page fetched them — and answer `None`, or the crate's
    /// sentence when they would not load. A refusal leaves the session as it was: a frame then
    /// says its models are not loaded (`card_scanner::session::NEURAL_UNAVAILABLE_ERROR`).
    ///
    /// **Each buffer is handed over, never copied again.** The glue has already copied all
    /// four into this module's memory — some twenty-seven megabytes — and they pass to the
    /// recogniser as owned `Cow`s: the gallery is searched where it lies, and the networks are
    /// `rten`'s from those buffers. What a session costs is therefore about what was
    /// handed in, and is given back only by ending the Worker.
    ///
    /// Into the session there is, which [`Scanner::load`] replaces — see there.
    pub fn load_neural(
        &mut self,
        detector: Vec<u8>,
        embedder: Vec<u8>,
        gallery: Vec<u8>,
        meta: Vec<u8>,
    ) -> Option<String> {
        let files = Files {
            detector: Cow::Owned(detector),
            embedder: Cow::Owned(embedder),
            gallery: Cow::Owned(gallery),
            meta: Cow::Owned(meta),
        };
        self.session.load_neural(files).err()
    }

    /// Give the recogniser its printing evidence — `card-neural`'s set symbol and collector
    /// band networks and their two galleries, as the page fetched them **after**
    /// [`Scanner::load_neural`] took the recogniser — and answer `None`, or the crate's sentence
    /// when they would not load: before the recogniser, without an `evidence` section in its
    /// `neural.json`, or files that are not them. **A refusal leaves the recogniser reading as
    /// it did**, choosing among a look's printings without the evidence — the page logs it and
    /// goes on.
    ///
    /// Handed over, never copied again, for [`Scanner::load_neural`]'s reason. Into the session
    /// there is, and let go with it by the next [`Scanner::load`], as the recogniser is.
    pub fn load_neural_evidence(
        &mut self,
        symbol_net: Vec<u8>,
        band_net: Vec<u8>,
        symbols: Vec<u8>,
        bands: Vec<u8>,
    ) -> Option<String> {
        let files = EvidenceFiles {
            symbol_net: Cow::Owned(symbol_net),
            band_net: Cow::Owned(band_net),
            symbols: Cow::Owned(symbols),
            bands: Cow::Owned(bands),
        };
        self.session.load_neural_evidence(files).err()
    }

    /// Whether a frame can be read: the session there is has its Neural files.
    pub fn has_neural(&self) -> bool {
        self.session.has_neural()
    }

    /// One frame through the session: `{"ok": <Verdict>}`, the verdict serialised as the
    /// desktop's `scanner_frame` serialises it. `jpeg` is the frame, whole.
    ///
    /// A JPEG that will not decode is not an `err`: it is a verdict, `ok: false` with the
    /// decoder's sentence, exactly as on the desktop — and so is a frame before the Neural files
    /// have loaded, with the crate's sentence for that.
    pub fn frame(&mut self, jpeg: &[u8]) -> String {
        ok(self.session.frame(jpeg))
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
    use card_scanner::ids::ID_LEN;
    use card_scanner::labels::{Encoder, Row};
    use card_scanner::reference::Label;
    use card_scanner::session::NEURAL_UNAVAILABLE_ERROR;
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

    // ---- The fixture --------------------------------------------------------------------------

    /// A card face, `w` wide: a dark border round light title, art, type and text bands.
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

    /// Three printings' labels: one in `hob`, two in `ltr`.
    fn rows() -> Vec<Row> {
        [(1u8, 10u8, "hob"), (2, 20, "ltr"), (3, 30, "ltr")]
            .into_iter()
            .map(|(n, oracle, set)| Row {
                id: id(n),
                oracle: Some(id(oracle)),
                label: Label {
                    name: format!("Card {oracle}"),
                    set: set.into(),
                    number: n.to_string(),
                    lang: "en".into(),
                    released: "2025-01-01".into(),
                },
                finishes: vec!["nonfoil".into(), "foil".into()],
                promo: false,
                token: false,
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
        let facts = scanner.load(Some(labels()));
        assert_eq!(facts.labels, 3, "{facts:?}");
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
    fn a_load_of_nothing_says_nothing_loaded() {
        let mut scanner = Scanner::new();
        assert_eq!(
            scanner.load_json(None),
            r#"{"ok":{"labels":0,"unapplied_filters":null}}"#
        );
        // Labels of no bytes — what the engine hands over while its corpus is empty — are the
        // same thing.
        assert_eq!(scanner.load(Some(Vec::new())), Loaded::default());
    }

    #[test]
    fn labels_load_and_say_how_many() {
        let mut scanner = Scanner::new();
        let facts = answered(&scanner.load_json(Some(labels())));
        assert_eq!(facts, json!({ "labels": 3, "unapplied_filters": null }));
    }

    /// Every way of cutting a labels file short, and bytes that are none: no labels, never a
    /// panic, and the scanner still answers afterwards.
    #[test]
    fn labels_that_will_not_decode_are_no_labels() {
        let mut scanner = Scanner::new();
        let whole = labels();
        for len in 1..whole.len() {
            let facts = scanner.load(Some(whole[..len].to_vec()));
            assert_eq!(facts.labels, 0, "{len} bytes of labels attached some");
        }
        assert_eq!(scanner.load(Some(b"<!doctype html>".to_vec())).labels, 0);
        let sentence = refused(&scanner.set_filters(LTR));
        assert!(
            sentence.starts_with("Filters need card names"),
            "{sentence}"
        );
        let verdict = answered(&scanner.frame(&card_frame_jpeg(0)));
        assert_eq!(verdict["ok"], false);
    }

    // ---- A frame ------------------------------------------------------------------------------

    #[test]
    fn before_the_neural_files_a_frame_is_the_sessions_own_refusal() {
        let frame = card_frame_jpeg(0);
        let mut bare = Session::new(None, TOP);
        let expected = bare.frame(&frame);

        let mut scanner = Scanner::new();
        let verdict = answered(&scanner.frame(&frame));
        assert_eq!(verdict["ok"], false);
        assert_eq!(verdict["matcher"], false);
        assert_eq!(verdict["error"], NEURAL_UNAVAILABLE_ERROR);
        assert_eq!(verdict["decision_seq"], 0);
        assert_eq!(
            without_timings(verdict),
            without_timings(as_a_page_reads(&expected))
        );
        assert_eq!(scanner.reset(), r#"{"ok":null}"#);
    }

    /// **The same frames through this module's `frame` and through the crate's own session
    /// are the same verdicts**, but for their timings — a session with the same labels attached
    /// a row at a time, and the same Neural files.
    #[test]
    fn a_frame_is_the_sessions_own_verdict() {
        let mut reference = Reference::new();
        for row in rows() {
            row.attach(&mut reference);
        }
        let mut direct = Session::new(Some(reference), TOP);
        let [d, e, g, m] = neural_files();
        direct
            .load_neural(Files {
                detector: Cow::Owned(d),
                embedder: Cow::Owned(e),
                gallery: Cow::Owned(g),
                meta: Cow::Owned(m),
            })
            .expect("the files in git");
        let mut scanner = loaded();
        assert_eq!(load_neural(&mut scanner, neural_files()), None);

        for i in 0..3 {
            let frame = card_frame_jpeg(i);
            let expected = direct.frame(&frame);
            let text = scanner.frame(&frame);
            // The envelope around the crate's own serialisation, and nothing re-ordered.
            assert!(text.starts_with(r#"{"ok":{"ok":"#), "{text}");
            assert_eq!(
                without_timings(answered(&text)),
                without_timings(as_a_page_reads(&expected)),
                "frame {i}"
            );
        }
    }

    #[test]
    fn a_frame_that_is_not_a_picture_is_a_verdict() {
        let mut scanner = loaded();
        assert_eq!(load_neural(&mut scanner, neural_files()), None);
        for not_a_picture in [&b""[..], b"not a jpeg", &[0xff, 0xd8, 0xff, 0xe0, 0, 16]] {
            let verdict = answered(&scanner.frame(not_a_picture));
            assert_eq!(verdict["ok"], false);
            // **The decoder's own refusal, and not a panic the session caught.** Natively
            // `Session::guarded` turns a panic into this same shape — `ok: false` and a
            // sentence — and in the module, built with `panic = "abort"`, that panic would
            // be a trap. So the sentence is held to the one a decode that *returned* writes.
            let error = verdict["error"].as_str().expect("a sentence");
            assert!(error.starts_with("decode:"), "{error}");
        }
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
        nameless.load(None);
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
    fn filters_set_before_the_first_load_are_owed_to_it() {
        let mut scanner = Scanner::new();
        assert_eq!(scanner.set_filters(LTR), r#"{"ok":null}"#);
        assert!(
            scanner.filters().is_empty(),
            "there is no session to hold them yet"
        );
        let facts = scanner.load(Some(labels()));
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
        scanner.load(Some(labels()));
        assert!(scanner.filters().is_empty());
    }

    #[test]
    fn a_reload_carries_the_filters_and_a_session_that_cannot_take_them_leaves_them_owed() {
        let mut scanner = loaded();
        scanner.set_filters(LTR);

        // Reloaded whole: the new session searches under them.
        let facts = scanner.load(Some(labels()));
        assert_eq!(facts.unapplied_filters, None);
        assert!(scanner.filters().same_as(&ltr()));

        // Reloaded with no labels: there is no mask to build. The session searches every
        // printing, the load says so in the crate's words, and the debt stands.
        let facts = scanner.load(None);
        let sentence = facts.unapplied_filters.expect("a refusal");
        assert!(
            sentence.starts_with("Filters need card names"),
            "{sentence}"
        );
        assert!(scanner.filters().is_empty());
        // And through a second one, which is offered them again and still cannot.
        let facts = scanner.load(None);
        assert!(facts.unapplied_filters.is_some());

        // The labels arrive: the filters the reader chose three sessions ago are in force.
        let facts = scanner.load(Some(labels()));
        assert_eq!(facts.unapplied_filters, None);
        assert!(scanner.filters().same_as(&ltr()));
    }

    #[test]
    fn an_accepted_push_settles_a_debt_and_a_refused_one_does_not() {
        let hob = r#"{"sets":["hob"]}"#;
        let owing = || {
            let mut scanner = loaded();
            scanner.set_filters(LTR);
            let facts = scanner.load(None);
            assert!(facts.unapplied_filters.is_some());
            scanner
        };

        // Refused — there are still no labels — so the older filters are still the ones owed.
        let mut scanner = owing();
        refused(&scanner.set_filters(hob));
        scanner.load(Some(labels()));
        assert!(scanner.filters().same_as(&ltr()));

        // Accepted: clearing the filters needs no labels, and it is the reader's newer word.
        let mut scanner = owing();
        assert_eq!(scanner.set_filters("{}"), r#"{"ok":null}"#);
        let facts = scanner.load(Some(labels()));
        assert_eq!(facts.unapplied_filters, None);
        assert!(scanner.filters().is_empty(), "a settled debt came back");
    }

    // ---- The Neural mode's files --------------------------------------------------------------

    /// `card-neural`'s four files, the ones in git that the web build serves, as a page hands
    /// them over: owned, in `load_neural`'s order.
    fn neural_files() -> [Vec<u8>; 4] {
        [
            include_bytes!("../../card-neural/models/detector.onnx").to_vec(),
            include_bytes!("../../card-neural/models/embedder.onnx").to_vec(),
            include_bytes!("../../card-neural/models/gallery.bin").to_vec(),
            include_bytes!("../../card-neural/models/neural.json").to_vec(),
        ]
    }

    fn load_neural(scanner: &mut Scanner, [d, e, g, m]: [Vec<u8>; 4]) -> Option<String> {
        scanner.load_neural(d, e, g, m)
    }

    #[test]
    fn the_neural_files_in_git_load_into_the_session_a_neural_frame_reads() {
        let mut scanner = loaded();
        assert!(!scanner.has_neural());
        // Unloaded, a frame is a verdict that says so — never an `err`, never a trap.
        let verdict = answered(&scanner.frame(&card_frame_jpeg(0)));
        assert_eq!(verdict["ok"], false);
        assert_eq!(verdict["error"], NEURAL_UNAVAILABLE_ERROR);

        assert_eq!(load_neural(&mut scanner, neural_files()), None);
        assert!(scanner.has_neural());
        // The labelled session is the one that took them: its names and filters stand.
        assert_eq!(scanner.set_filters(LTR), r#"{"ok":null}"#);
        let verdict = answered(&scanner.frame(&card_frame_jpeg(0)));
        // Read by the networks this time: the drawn card is no card they know — a frame with no
        // card in it — and not a session without its files.
        assert_ne!(verdict["error"], NEURAL_UNAVAILABLE_ERROR, "{verdict}");
        assert_eq!(verdict["matcher"], true, "{verdict}");
        assert!(verdict["tracked"].is_object(), "{verdict}");
    }

    #[test]
    fn neural_files_that_are_not_them_are_the_crates_sentence_and_the_session_stays_unloaded() {
        let noise = |n: usize| -> Vec<u8> {
            (0..n as u32)
                .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
                .collect()
        };
        let real = neural_files();
        let half = |bytes: &Vec<u8>| bytes[..bytes.len() / 2].to_vec();
        let cases: Vec<(&str, [Vec<u8>; 4])> = vec![
            ("nothing", [vec![], vec![], vec![], vec![]]),
            ("noise", [noise(4096), noise(4096), noise(4096), noise(64)]),
            (
                "a web page for each",
                [
                    b"<!doctype html>".to_vec(),
                    b"<!doctype html>".to_vec(),
                    b"<!doctype html>".to_vec(),
                    b"<!doctype html>".to_vec(),
                ],
            ),
            (
                "a detector that is not one",
                [
                    noise(4096),
                    real[1].clone(),
                    real[2].clone(),
                    real[3].clone(),
                ],
            ),
            (
                "an embedder cut in half",
                [
                    real[0].clone(),
                    half(&real[1]),
                    real[2].clone(),
                    real[3].clone(),
                ],
            ),
            (
                "a gallery cut short",
                [
                    real[0].clone(),
                    real[1].clone(),
                    half(&real[2]),
                    real[3].clone(),
                ],
            ),
            (
                "the files in the wrong order",
                [
                    real[2].clone(),
                    real[0].clone(),
                    real[1].clone(),
                    real[3].clone(),
                ],
            ),
        ];
        for (what, files) in cases {
            let mut scanner = loaded();
            let refusal = load_neural(&mut scanner, files);
            let sentence = refusal.unwrap_or_else(|| panic!("{what} loaded"));
            assert!(!sentence.is_empty(), "{what}");
            assert!(!scanner.has_neural(), "{what}");
            let verdict = answered(&scanner.frame(&card_frame_jpeg(0)));
            assert_eq!(
                verdict["error"], NEURAL_UNAVAILABLE_ERROR,
                "{what}: {sentence}"
            );
        }
    }

    /// Four buffers that are none of the evidence files, in `load_neural_evidence`'s order.
    fn not_evidence() -> [Vec<u8>; 4] {
        [
            b"not a network".to_vec(),
            b"not a network".to_vec(),
            b"not a gallery".to_vec(),
            b"not a gallery".to_vec(),
        ]
    }

    fn load_neural_evidence(scanner: &mut Scanner, [s, b, y, n]: [Vec<u8>; 4]) -> Option<String> {
        scanner.load_neural_evidence(s, b, y, n)
    }

    #[test]
    fn evidence_that_would_not_load_is_the_crates_sentence_and_the_recogniser_reads_on() {
        let mut scanner = loaded();
        // Before the recogniser: refused, and nothing loaded by it.
        let refusal = load_neural_evidence(&mut scanner, not_evidence());
        assert!(!refusal.expect("refused before the recogniser").is_empty());
        assert!(!scanner.has_neural());

        assert_eq!(load_neural(&mut scanner, neural_files()), None);
        // After it: refused — files that are not the evidence, or a `neural.json` with no
        // `evidence` section to read them by — and never a panic.
        let refusal = load_neural_evidence(&mut scanner, not_evidence());
        assert!(!refusal.expect("refused after the recogniser").is_empty());
        // The recogniser stands: a frame is read by its networks, as it was before.
        assert!(scanner.has_neural());
        let verdict = answered(&scanner.frame(&card_frame_jpeg(0)));
        assert_ne!(verdict["error"], NEURAL_UNAVAILABLE_ERROR, "{verdict}");
        assert!(verdict["tracked"].is_object(), "{verdict}");
    }

    #[test]
    fn a_reload_lets_the_neural_files_go_with_the_session_they_were_loaded_into() {
        let mut scanner = loaded();
        assert_eq!(load_neural(&mut scanner, neural_files()), None);
        // The page never does this — one load a Worker — and if it did, it would owe the files
        // again: they are not kept anywhere but the session.
        scanner.load(Some(labels()));
        assert!(!scanner.has_neural());
        assert_eq!(load_neural(&mut scanner, neural_files()), None);
        assert!(scanner.has_neural());
    }
}
