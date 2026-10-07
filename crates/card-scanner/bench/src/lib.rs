//! One session, loaded from bytes, and one frame through it — the part of the bench both of
//! its faces share, so a native figure and a browser figure are figures about the same code.
//!
//! [`load`] builds a [`Session`] out of what a host can hand over as bytes: the reference
//! bundle, the labels as JSON, the two OCR models. [`frame`] puts one JPEG through it and
//! answers the verdict as JSON, exactly as `grimoire-core`'s scanner glue does. [`record`]
//! reduces a verdict to the handful of numbers a measurement keeps.
//!
//! **`glue` is the same three calls as a WASM module's exports**, and exists only on that
//! target: it keeps the session, installs `performance.now()` as the crate's clock
//! (`card_scanner::host::set_clock`) and writes a panic's sentence to the console before the
//! trap that follows it — with `panic = "abort"` there is nothing after that to write it.
//!
//! **No SQLite.** The app's labels come out of `corpus.db` (`Reference::load_labels`, behind
//! the crate's `corpus` feature); here they are a JSON array `bench-prep` wrote, attached
//! through `Reference::add_label` and `Reference::set_finishes`, which exist for a caller with
//! no database.

use card_scanner::index::{parse_uuid, Bundle};
use card_scanner::reference::{Label, Reference};
use card_scanner::session::{FrameOptions, Session};

/// How many candidates a verdict carries. The app's.
const TOP: usize = 5;

/// One printing's label, as `labels.json` holds it — an array, not an object, because the
/// corpus has 118,000 of them and nine key names apiece would double the file:
/// `[id, oracle_id, illustration_id, name, set, number, lang, released, finishes]`.
pub type LabelRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    Vec<String>,
);

/// A session, and what went into it.
pub struct Loaded {
    pub session: Session,
    /// Printings the bundle can recognise by appearance.
    pub printings: usize,
    /// Labels attached. Zero means every answer is an id with no name.
    pub labels: usize,
    /// Whether the two readers loaded.
    pub readers: bool,
}

/// Build a session from bytes. `models` is the detection model and the recognition model.
pub fn load(
    bundle: &[u8],
    labels_json: Option<&str>,
    models: Option<(&[u8], &[u8])>,
) -> Result<Loaded, String> {
    let bundle = Bundle::from_bytes(bundle).map_err(|e| format!("bundle: {e}"))?;
    let mut reference = Reference::new(bundle);
    let labels = match labels_json {
        Some(json) => attach_labels(&mut reference, json)?,
        None => 0,
    };
    let printings = reference.bundle_printings();
    let reader = readers(models)?;
    let readers = reader.is_some();
    Ok(Loaded {
        session: Session::new(Some(reference), reader, TOP),
        printings,
        labels,
        readers,
    })
}

#[cfg(feature = "ocr")]
fn readers(
    models: Option<(&[u8], &[u8])>,
) -> Result<Option<card_scanner::session::Reader>, String> {
    models
        .map(|(detection, recognition)| {
            card_scanner::ocr::TitleReader::from_bytes(detection, recognition)
        })
        .transpose()
}

#[cfg(not(feature = "ocr"))]
fn readers(
    models: Option<(&[u8], &[u8])>,
) -> Result<Option<card_scanner::session::Reader>, String> {
    match models {
        Some(_) => Err("this build has no readers: it was made without the `ocr` feature".into()),
        None => Ok(None),
    }
}

/// Attach every row of a `labels.json` to `reference`. A row whose id is not a UUID is skipped,
/// as `Reference::load_labels` skips one.
///
/// **A row at a time, never the whole array first.** Parsed into a `Vec` and then attached, the
/// corpus's 118,000 rows are held twice at the peak — and a WASM module's memory never shrinks,
/// so that peak would be the figure the bench reports for a session that needs half of it.
pub fn attach_labels(reference: &mut Reference, json: &str) -> Result<usize, String> {
    struct Rows<'a>(&'a mut Reference);

    impl<'de> serde::de::Visitor<'de> for Rows<'_> {
        type Value = usize;

        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an array of label rows")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut rows: A) -> Result<usize, A::Error> {
            let mut attached = 0;
            while let Some(row) = rows.next_element::<LabelRow>()? {
                let (id, oracle, illustration, name, set, number, lang, released, finishes) = row;
                let Some(id) = parse_uuid(&id) else { continue };
                self.0.set_finishes(id, finishes);
                self.0.add_label(
                    id,
                    oracle.as_deref().and_then(parse_uuid),
                    illustration.as_deref().and_then(parse_uuid),
                    Label {
                        name,
                        set,
                        number,
                        lang,
                        released,
                    },
                );
                attached += 1;
            }
            Ok(attached)
        }
    }

    let mut json = serde_json::Deserializer::from_str(json);
    let attached = serde::Deserializer::deserialize_seq(&mut json, Rows(reference))
        .map_err(|e| format!("labels: {e}"))?;
    json.end().map_err(|e| format!("labels: {e}"))?;
    Ok(attached)
}

/// One frame: a JPEG and a `FrameOptions` as JSON in — `{}` is the app's defaults — and the
/// verdict as JSON out. `detail` is the same frame at the camera's resolution, for the readers.
pub fn frame(
    session: &mut Session,
    jpeg: &[u8],
    options_json: &str,
    detail: Option<&[u8]>,
) -> String {
    let options: FrameOptions = match serde_json::from_str(options_json) {
        Ok(options) => options,
        Err(e) => {
            return serde_json::json!({ "ok": false, "error": format!("options: {e}") }).to_string()
        }
    };
    let verdict = session.frame_with_detail(jpeg, detail, &options);
    serde_json::to_string(&verdict)
        .unwrap_or_else(|e| serde_json::json!({ "ok": false, "error": e.to_string() }).to_string())
}

/// What a measurement keeps of one verdict: whether it found a card, the decision if there is
/// one and the card it names, the resolve's outcome on the frame it landed, what the two
/// readers read and what each read was matched to, and **every `…_ms` in it, by its path**
/// (`decode_ms`, `timings.total_ms`, `match.hash_ms`, `resolution.elapsed_ms`).
///
/// The reads are kept as text because "the readers ran" is not the claim worth making about a
/// host: a model that runs and returns noise costs the same milliseconds as one that reads.
///
/// The page's script makes the same record out of the same JSON (`web/summary.js`), and one
/// summariser reads both — so a native run and a browser run are compared field for field.
pub fn record(verdict: &serde_json::Value) -> serde_json::Value {
    fn timings(
        value: &serde_json::Value,
        path: &str,
        out: &mut serde_json::Map<String, serde_json::Value>,
    ) {
        let Some(map) = value.as_object() else { return };
        for (key, inner) in map {
            let at = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            if key.ends_with("_ms") && inner.is_number() {
                out.insert(at, inner.clone());
            } else {
                timings(inner, &at, out);
            }
        }
    }
    let mut ms = serde_json::Map::new();
    timings(verdict, "", &mut ms);
    let label = &verdict["decision"]["label"];
    let named = label["name"].as_str().map(|name| {
        let set = label["set"].as_str().unwrap_or_default().to_uppercase();
        format!(
            "{name} — {set} {}",
            label["number"].as_str().unwrap_or_default()
        )
    });
    serde_json::json!({
        "ok": verdict["ok"],
        "error": verdict["error"],
        "decision_seq": verdict["decision_seq"],
        "printing": verdict["decision"]["printing"],
        "named": named,
        "outcome": verdict["resolution"]["outcome"],
        "title": verdict["ocr"]["raw"],
        "title_matched": verdict["ocr"]["matched"],
        "collector": verdict["collector"]["raw"],
        "collector_matched": verdict["collector"]["matched"],
        "ms": ms,
    })
}

#[cfg(target_arch = "wasm32")]
mod glue {
    use card_scanner::session::Session;
    use std::cell::RefCell;
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        /// `performance.now()`, off the global scope: the host is a Worker, which has no
        /// `window`. `catch`, because a host with no such object would otherwise throw, and a
        /// throw here is a trap.
        #[wasm_bindgen(js_namespace = performance, js_name = now, catch)]
        fn performance_now() -> Result<f64, JsValue>;

        #[wasm_bindgen(js_namespace = console, js_name = error)]
        fn console_error(message: &str);
    }

    thread_local! {
        static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    }

    fn now_ms() -> f64 {
        performance_now().unwrap_or(0.0)
    }

    /// Run by the glue as the module is instantiated, before any export can be called.
    #[wasm_bindgen(start)]
    fn start() {
        // The default hook writes to a stderr this target does not have, so without this a
        // panic is `RuntimeError: unreachable` and nothing else.
        std::panic::set_hook(Box::new(|info| {
            console_error(&format!("scanner-bench panicked: {info}"))
        }));
        card_scanner::host::set_clock(now_ms);
    }

    /// Build the session, replacing any there was. Answers `{printings, labels, readers,
    /// threads}` as JSON — `threads` is the crate's own word for whether it will spawn any.
    #[wasm_bindgen]
    pub fn load(
        bundle: &[u8],
        labels: Option<String>,
        detection: Option<Vec<u8>>,
        recognition: Option<Vec<u8>>,
    ) -> Result<String, String> {
        let models = match (&detection, &recognition) {
            (Some(d), Some(r)) => Some((d.as_slice(), r.as_slice())),
            (None, None) => None,
            _ => return Err("one model without the other: the readers need both".into()),
        };
        // The session there was goes first. Built beside it, the new one would stand on top
        // of the old in a memory that never shrinks, and the figure the bench reports for a
        // session with the readers would be two sessions'.
        SESSION.with(|slot| slot.borrow_mut().take());
        let loaded = super::load(bundle, labels.as_deref(), models)?;
        let said = serde_json::json!({
            "printings": loaded.printings,
            "labels": loaded.labels,
            "readers": loaded.readers,
            "threads": card_scanner::host::threads(),
        });
        SESSION.with(|slot| *slot.borrow_mut() = Some(loaded.session));
        Ok(said.to_string())
    }

    /// One frame through the loaded session. See [`super::frame`].
    #[wasm_bindgen]
    pub fn frame(jpeg: &[u8], options: &str, detail: Option<Vec<u8>>) -> String {
        SESSION.with(|slot| match slot.borrow_mut().as_mut() {
            Some(session) => super::frame(session, jpeg, options, detail.as_deref()),
            None => r#"{"ok":false,"error":"no session: call load first"}"#.to_string(),
        })
    }

    /// Forget the card in frame — the tracker, the lock and any resolve — keeping the session.
    #[wasm_bindgen]
    pub fn reset() {
        SESSION.with(|slot| {
            if let Some(session) = slot.borrow_mut().as_mut() {
                session.reset();
            }
        });
    }

    /// The module's linear memory, in bytes. It only ever grows, so read after a run it is the
    /// run's high-water mark.
    #[wasm_bindgen]
    pub fn memory_bytes() -> f64 {
        core::arch::wasm32::memory_size(0) as f64 * 65_536.0
    }

    /// **Panic inside the session, on purpose** — where an assertion in an image crate would,
    /// with the session borrowed as [`frame`] borrows it. For seeing what a host is left with
    /// (`?trap=1` on the page): the crate's own guard catches nothing in this build, so this
    /// never returns.
    #[wasm_bindgen]
    pub fn trap() {
        SESSION.with(|slot| {
            let _held = slot.borrow_mut();
            panic!("a panic inside a frame, asked for by the bench");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_scanner::hash::{hash_rgb, HashKind};
    use card_scanner::index::{format_uuid, BundleBuilder, Section};

    fn id(n: u8) -> [u8; 16] {
        let mut raw = [0u8; 16];
        raw[0] = n;
        raw
    }

    fn bundle() -> Vec<u8> {
        let mut builder = BundleBuilder::new(HashKind::DHashChroma32, 256);
        for n in 1..=3u8 {
            let card = image::RgbImage::from_fn(60, 84, |x, y| {
                image::Rgb([((x * n as u32 + y) % 256) as u8; 3])
            });
            builder.push(
                Section::Card,
                id(n),
                &hash_rgb(&card, HashKind::DHashChroma32, 256),
            );
        }
        builder.finish(0).to_bytes()
    }

    #[test]
    fn a_session_loads_from_bytes_with_its_labels_and_answers_a_frame_as_json() {
        let labels = serde_json::json!([
            [
                format_uuid(&id(1)),
                format_uuid(&id(9)),
                null,
                "Card One",
                "hob",
                "1",
                "en",
                "2025-01-01",
                ["nonfoil", "foil"]
            ],
            [
                format_uuid(&id(2)),
                null,
                null,
                "Card Two",
                "hob",
                "2",
                "en",
                "",
                []
            ],
            ["not an id", null, null, "Nobody", "x", "0", "en", "", []],
        ])
        .to_string();
        let mut loaded = load(&bundle(), Some(&labels), None).expect("load");
        assert_eq!(
            (loaded.printings, loaded.labels, loaded.readers),
            (3, 2, false)
        );

        let blank = {
            let mut jpeg = Vec::new();
            image::RgbImage::from_pixel(320, 240, image::Rgb([128, 128, 128]))
                .write_to(
                    &mut std::io::Cursor::new(&mut jpeg),
                    image::ImageFormat::Jpeg,
                )
                .expect("encode");
            jpeg
        };
        let verdict: serde_json::Value =
            serde_json::from_str(&frame(&mut loaded.session, &blank, "{}", None)).expect("json");
        assert_eq!(verdict["frame"]["w"], 320);
        assert_eq!(verdict["matcher"], true);
        assert_eq!(verdict["mode"], "fast");
        let exact = frame(&mut loaded.session, &blank, r#"{"mode":"exact"}"#, None);
        assert!(exact.contains(r#""mode":"exact""#), "{exact}");

        let refused = frame(&mut loaded.session, &blank, "{not json", None);
        assert!(refused.contains("options:"), "{refused}");
        assert!(load(b"not a bundle", None, None).is_err());
        assert!(
            load(&bundle(), Some("{}"), None).is_err(),
            "labels are an array of rows"
        );
    }

    #[test]
    fn a_record_keeps_every_timing_by_its_path_and_nothing_bulky() {
        let verdict = serde_json::json!({
            "ok": true,
            "decode_ms": 1.5,
            "decision_seq": 2,
            "timings": { "total_ms": 9.0, "mask_ms": 4.0 },
            "match": { "hash_ms": 3.0, "candidates": [{ "id": "x", "distance": 3 }] },
            "decision": {
                "printing": "abc",
                "label": { "name": "Forest", "set": "blb", "number": "280", "lang": "en" },
            },
            "resolution": { "outcome": "resolved", "elapsed_ms": 40.0, "tiers": [] },
            "ocr": null,
            "collector": { "raw": "280 BLB EN", "matched": "Forest — BLB 280", "band": "data:…" },
        });
        let kept = record(&verdict);
        assert_eq!(kept["ok"], true);
        assert_eq!(kept["decision_seq"], 2);
        assert_eq!(kept["printing"], "abc");
        assert_eq!(kept["named"], "Forest — BLB 280");
        assert_eq!(kept["outcome"], "resolved");
        assert!(kept["title"].is_null() && kept["title_matched"].is_null());
        assert_eq!(kept["collector"], "280 BLB EN");
        assert_eq!(kept["collector_matched"], "Forest — BLB 280");
        let ms = kept["ms"].as_object().expect("timings");
        let mut paths: Vec<&str> = ms.keys().map(String::as_str).collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            [
                "decode_ms",
                "match.hash_ms",
                "resolution.elapsed_ms",
                "timings.mask_ms",
                "timings.total_ms"
            ]
        );
        assert!(kept.get("match").is_none(), "the candidates came along");
    }
}
