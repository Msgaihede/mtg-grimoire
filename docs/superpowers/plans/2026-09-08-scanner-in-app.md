# Scanner in the App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The card-scanner crate becomes a dependency of the app, its per-frame handler moves into the crate so the debug server and the app share it, and the app gets a seventh view, Scanner, that does what the debug page does today in the app's chrome.

**Architecture:** One typed per-frame `Session` in the crate; a thin `serve.rs` and a thin `src-tauri/src/scanner.rs` around it. Frames travel as a raw-body Tauri command on desktop and as base64 JSON on Android. The view is a camera half (stream, pump, overlay) and a pure panels half driven by props, so the panels can be tested and storied without a camera.

**Tech Stack:** Rust (crate `card-scanner`, `tauri 2.11.5`, `tauri::ipc::Request`), React 19 + TypeScript 6 + Tailwind 4 tokens, zustand store, Vitest + Testing Library, Storybook with the `.storybook/fake/` backend.

**Spec:** `docs/superpowers/specs/2026-09-08-scanner-in-app-design.md` — read it first; every task below argues from it. The scanner's own design is `docs/superpowers/specs/2026-09-01-card-scanner-design.md`, and the record of the crate is `docs/reference/card-scanner.md`.

## Global Constraints

- The debug page `crates/card-scanner/src/bin/live.html` and its server **stay as they are for a reader**: same panels, same JSON keys, same sliders. `node crates/card-scanner/scripts/check-live-page.mjs` must pass after any change under `crates/card-scanner/src/bin/`.
- The crate stays a standalone package (no workspace). `src-tauri` takes it as `card-scanner = { path = "../crates/card-scanner", features = ["corpus", "ocr"] }` in the **non-wasm** target block only.
- Every JSON the app reads from the scanner is **snake_case**, the crate's field names verbatim; the TS mirrors keep those names.
- Errors over IPC are sentences in `Result<T, String>`, never enums. Commands are `async` and answer on `tauri::async_runtime::spawn_blocking`.
- No schema rung, no capability entry, no `error_log` source, no CSP edit.
- Assets: `data/scanner/card-hashes.bin`, `data/scanner/models/text-detection.rten`, `data/scanner/models/text-recognition.rten`; captures to `data/scanner/scans/`. The page names the exact missing path.
- Rail order after this plan: Search, Tagger, Decks, Collection, Wishlist, **Scanner**, Settings. Scanner is `Ctrl+6`; Settings becomes `Ctrl+7`.
- Copy: "The scanner needs the desktop or Android app — this build has no detector." (web); "MTG Grimoire needs camera access to scan a card." (`NotAllowedError`); "No camera on this device." (`NotFoundError`); "No reference bundle. Put `card-hashes.bin` at *path*." ; "No OCR models. Put `text-detection.rten` and `text-recognition.rten` at *path*."
- Frontend rules that bite here: dim text is `text-dim` never `text-muted`; every `transition-*` has a `motion-reduce:transition-none` neighbour; no `sm:`/`md:`/`lg:` outside `AppShell`; z-index only from `LAYER`; no interpolated class names; no `setState` inside an effect for derived state; `useNarrowWindow` is the one viewport branch and its doc must name the scanner as its second reader.
- **Tests run once, after fan-in.** A subagent runs only the file(s) it wrote (`npx vitest run <file>`, `cargo test <filter>`), never `npm run verify`. The plan's last task runs verify. Never run two verifies at once.
- Commit after each task with the trailer lines the session requires. Do not run `git stash`.
- Windows: every figure recorded names the build (debug or release).

---

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `crates/card-scanner/src/session.rs` (new) | `FrameOptions`, `Method`, the typed `Verdict` and its views, `Session::frame` | 1 |
| `crates/card-scanner/src/lib.rs` | `pub mod session;` | 1 |
| `crates/card-scanner/src/track.rs` | `CommitRule` gains `Deserialize`; stale `from_collector` doc numbers fixed | 1 |
| `crates/card-scanner/src/bin/serve.rs` | Thin: query → `FrameOptions`, `session.frame`, serialise, log, dump | 1 |
| `crates/card-scanner/scripts/drive-frames.mjs` (new) | POST a photo to `/frame` N times — the camera-less drive | 1 |
| `src-tauri/Cargo.toml` | The dependency, the profile overrides | 2 |
| `package.json` | `verify` runs the crate's suite | 2 |
| `src-tauri/src/scanner.rs` (new) | `ScannerState`, asset loading, the four commands | 3 |
| `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs` | Module, `manage`, `generate_handler!` | 3 |
| `src/lib/core/types.ts`, `tauri.ts`, `browser.ts`, `.storybook/fake/core.ts` | `Core.call` widens to bytes + headers | 4 |
| `src/lib/bytes.ts` (new) | `bytesToBase64` | 5 |
| `src/lib/ipc.ts`, `src/lib/ipc.test.ts` | Types, four wrappers, argument cases, mirror rows | 5 |
| `src/features/scanner/scannerOptions.ts`, `verdictText.ts` | Defaults, header encoding, the sentence functions | 6 |
| `src/features/scanner/fixtures.ts` | Canned verdicts for tests and stories | 6 |
| `src/lib/store.ts` | `scannerFolds`, `setScannerFold` | 7 |
| `src/features/scanner/ScannerPanels.tsx`, `panels/*.tsx` | The pure panel column | 7 |
| `src/features/scanner/useCamera.ts`, `useScanLoop.ts`, `Overlay.tsx` | Stream, pump, box | 8 |
| `src/features/scanner/ScannerPage.tsx` | Assembly, web dispatch, layout, sentences | 9 |
| `src/lib/store.ts`, `src/components/nav.ts`, `src/App.tsx`, `src/lib/shortcuts.ts` + tests, `docs/reference/keyboard-shortcuts.md` | The seventh view | 10 |
| `.storybook/fake/db.ts`, `src/features/scanner/*.stories.tsx` | Fake handlers, the `scannerMissing` fault, stories | 11 |
| `docs/reference/card-scanner.md`, `CLAUDE.md`, `src-tauri/CLAUDE.md`, `src/CLAUDE.md`, the 2026-09-01 spec | The record | 12 |
| — | Live verification, the four measurements, `npm run verify` | 13 |

**Waves for a fan-out** (files are disjoint inside a wave): W1 `{1, 4, 6}` → W2 `{2, 5}` → W3 `{3, 7, 8}` → W4 `{9}` → W5 `{10, 11}` → W6 `{12}` → W7 `{13}`.

---

### Task 1: `session::Session` — the per-frame handler moves into the crate

**Files:**
- Create: `crates/card-scanner/src/session.rs`
- Create: `crates/card-scanner/scripts/drive-frames.mjs`
- Modify: `crates/card-scanner/src/lib.rs` (add `pub mod session;`)
- Modify: `crates/card-scanner/src/track.rs:167-175` (`CommitRule` derives), `:231-260` (two stale numbers in `from_collector`'s doc)
- Modify: `crates/card-scanner/src/bin/serve.rs` (everything between `FrameOptions` and `load_reference` shrinks)

**Interfaces:**
- Consumes: `detect::{detect, rectify_views, DetectOptions, DetectTimings, Detection, DetectTrace, EdgeMethod, QuadScore}`, `hash::{hash, HashKind}`, `index::{format_uuid, parse_uuid, Mask}`, `lock::{LockState, QuadLock}`, `reference::{Label, MatchReport, Reference}`, `track::{CommitRule, Observation, Tracker, TrackerOptions}`, `trim::Margin`, `cardness::Cardness`, `ocr::TitleReader` (behind `feature = "ocr"`).
- Produces (used by Tasks 3 and 5):

```rust
pub const OCR_EVERY: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method { Canny, Otsu, #[default] Both }

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FrameOptions {
    pub work_long_edge: u32,   // 1024
    pub method: Method,        // Both
    pub canny_low: f32,        // 40.0
    pub canny_high: f32,       // 100.0
    pub aspect_tolerance: f32, // 0.18
    pub min_cardness: f32,     // cardness::MIN_SCORE
    pub stages: bool,          // false
    pub rule: CommitRule,      // Votes
    pub decide_at: f32,        // 8.0
    pub lead_margin: f32,      // 1.3
}

pub struct Session { /* private */ }
impl Session {
    pub fn new(reference: Option<Reference>, reader: Option<TitleReader>, top: usize) -> Session;
    pub fn frame(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict;   // never panics
    pub fn reset(&mut self);
    pub fn has_reference(&self) -> bool;
    pub fn has_reader(&self) -> bool;
}
```

  and the verdict, every field `pub`, every struct `#[derive(Debug, Clone, serde::Serialize)]`:

```rust
pub struct FrameSize { pub w: u32, pub h: u32 }
pub struct Stages { pub binary: Option<String>, pub contours: Option<String>, pub quad: Option<String> }
pub struct StandingView { pub id: String, pub evidence: f32, pub share: f32, pub seen: u32, pub label: Option<Label>, pub best_distance: f32 }
pub struct TrackedView { pub committed: bool, pub confidence: f32, pub rule: CommitRule, pub decide_at: f32, pub lead: Option<f32>, pub frozen: bool, pub streak: u32, pub frames: u32, pub misses: u32, pub standings: Vec<StandingView> }
pub struct CollectorTry { pub set: String, pub number: String, pub matched: Option<String> }
pub struct CollectorView { pub raw: String, pub rotated: bool, pub elapsed_ms: f32, pub pairings: usize, pub tried: Vec<CollectorTry>, pub more: usize, pub band: Option<String>, pub matched: Option<String> }
pub struct OcrView { pub raw: String, pub normalized: String, pub rotated: bool, pub elapsed_ms: f32, pub band: Option<String>, pub matched: Option<String>, pub edits: Option<u32> }
pub struct Verdict {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub frame: FrameSize,
    pub decode_ms: f32,
    pub matcher: bool,
    pub lock: Option<LockState>,
    pub quad: Option<[(f32, f32); 4]>,
    pub quad_raw: Option<[(f32, f32); 4]>,
    pub method: Option<String>,
    pub cardness: Option<Cardness>,
    pub rejected_cardness: Option<Cardness>,
    pub trim: Option<Margin>,
    pub from_lock: bool,
    pub score: Option<QuadScore>,
    pub hash: Option<String>,
    pub rectified: Option<String>,
    pub timings: Option<DetectTimings>,
    pub candidates_examined: Option<usize>,
    pub stages: Option<Stages>,
    pub r#match: Option<MatchReport>,
    pub tracked: Option<TrackedView>,
    pub collector: Option<CollectorView>,
    pub ocr: Option<OcrView>,
}
```

  `Option` fields serialise as `null`, which is what the page's `j.tracked?.…`, `j.lock ? …`, `if (j.stages)` already treat as absent. The one exception is `error`, skipped when `None`, because the page reads `j.error ?? ''` and a `null` there is fine too — it is skipped so the JSON of a good frame carries no `error` key, as today.

- [ ] **Step 1: Write the failing tests**

Append to `crates/card-scanner/src/session.rs` (the module does not exist yet; write the tests module now and the code above it in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// A 320x240 JPEG with nothing card-shaped in it — a grey field with one dark bar, so the
    /// detector runs every stage and finds no quad. No corpus photograph: the census is about
    /// the verdict's keys, and a blank frame has all of them.
    fn blank_jpeg() -> Vec<u8> {
        let mut img = image::RgbImage::from_pixel(320, 240, image::Rgb([128, 128, 128]));
        for x in 40..280 {
            for y in 100..110 {
                img.put_pixel(x, y, image::Rgb([20, 20, 20]));
            }
        }
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
            .encode_image(&img)
            .expect("encode");
        out
    }

    /// Every top-level key `live.html` reads off a frame — `j.<key>` and `latest?.<key>` —
    /// except the one the page itself adds (`round_trip_ms`) and the names that are not
    /// verdict keys (`ok` is; `tracked` is; `error` is).
    fn keys_the_page_reads() -> Vec<String> {
        let html = include_str!("bin/live.html");
        let mut keys = std::collections::BTreeSet::new();
        for needle in ["j.", "latest?.", "latest."] {
            for (i, _) in html.match_indices(needle) {
                let rest = &html[i + needle.len()..];
                let key: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if !key.is_empty() && key != "round_trip_ms" {
                    keys.insert(key);
                }
            }
        }
        keys.into_iter().collect()
    }

    #[test]
    fn every_key_the_debug_page_reads_is_in_the_verdict() {
        let mut s = Session::new(None, None, 5);
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        let json = serde_json::to_value(&v).expect("serialise");
        let obj = json.as_object().expect("an object");
        let missing: Vec<_> = keys_the_page_reads()
            .into_iter()
            // `error` is skipped when there is none; a blank frame has one, so it is present.
            .filter(|k| !obj.contains_key(k))
            .collect();
        assert!(missing.is_empty(), "live.html reads keys the verdict lacks: {missing:?}");
        assert!(!v.ok, "a blank frame is not a card");
        assert_eq!(v.frame.w, 320);
        assert!(!v.matcher, "no reference was given");
    }

    #[test]
    fn a_frame_the_detector_panics_on_answers_a_sentence() {
        // `imageproc`'s canny asserts low <= high. Measured on the debug server: without the
        // guard one slider drag killed every worker thread. The guard is the session's now.
        let mut s = Session::new(None, None, 5);
        let opts = FrameOptions { method: Method::Canny, canny_low: 200.0, canny_high: 50.0, ..Default::default() };
        let v = s.frame(&blank_jpeg(), &opts);
        assert!(!v.ok);
        assert!(v.error.as_deref().is_some_and(|e| e.contains("panicked")), "{:?}", v.error);
        // And the session is still usable afterwards.
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        assert!(v.error.as_deref().is_some_and(|e| !e.contains("panicked")));
    }

    #[test]
    fn undecodable_bytes_are_a_decode_error() {
        let mut s = Session::new(None, None, 5);
        let v = s.frame(b"not a jpeg", &FrameOptions::default());
        assert!(!v.ok);
        assert!(v.error.as_deref().is_some_and(|e| e.starts_with("decode:")));
        assert_eq!(v.frame.w, 0);
    }

    #[test]
    fn the_reader_runs_every_fourth_frame_and_stands_down_once_decided() {
        let mut s = Session::new(None, None, 5);
        let due: Vec<bool> = (0..8).map(|_| s.reader_due(false)).collect();
        assert_eq!(due, [true, false, false, false, true, false, false, false]);
        assert!(!s.reader_due(true), "a decided card asks the reader for nothing");
    }

    #[test]
    fn options_default_to_what_the_page_sliders_start_at() {
        let o = FrameOptions::default();
        assert_eq!(o.work_long_edge, 1024);
        assert_eq!(o.method, Method::Both);
        assert_eq!(o.canny_low, 40.0);
        assert_eq!(o.canny_high, 100.0);
        assert_eq!(o.aspect_tolerance, 0.18);
        assert_eq!(o.min_cardness, crate::cardness::MIN_SCORE);
        assert!(!o.stages);
        assert_eq!(o.rule, CommitRule::Votes);
        assert_eq!(o.decide_at, 8.0);
        assert_eq!(o.lead_margin, 1.3);
    }

    #[test]
    fn options_deserialise_with_every_field_optional() {
        let o: FrameOptions = serde_json::from_str(r#"{"method":"otsu","decide_at":12}"#).expect("parse");
        assert_eq!(o.method, Method::Otsu);
        assert_eq!(o.decide_at, 12.0);
        assert_eq!(o.canny_low, 40.0);
        let o: FrameOptions = serde_json::from_str("{}").expect("empty object");
        assert_eq!(o, FrameOptions::default());
        let rule: CommitRule = serde_json::from_str(r#""confidence""#).expect("rule");
        assert_eq!(rule, CommitRule::Confidence);
    }

    #[test]
    fn reset_forgets_the_tracker_and_the_lock() {
        let mut s = Session::new(None, None, 5);
        s.frame(&blank_jpeg(), &FrameOptions::default());
        s.reset();
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        assert_eq!(v.lock.as_ref().map(|l| l.misses), Some(1));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crates/card-scanner && cargo test --lib session`
Expected: compile error — `session` is not a module yet.

- [ ] **Step 3: Write `session.rs`**

Everything below the doc comment is `serve.rs::handle_frame` and its helpers, moved and typed. Read `serve.rs` lines 323–700 beside this while writing it; the comments there are the rationale and travel with the code.

```rust
//! One frame in, one verdict out — the per-frame pipeline both callers share.
//!
//! The debug server (`bin/serve.rs`) and the app (`src-tauri/src/scanner.rs`) each hand a
//! JPEG and a [`FrameOptions`] to a [`Session`] and get a [`Verdict`] back. Everything that
//! decides a frame lives here once: the detector sweep, the quad lock, the rectification from
//! the lock's quad, the descriptor and the search, the two readers and their cadence, the
//! tracker, and the panic guard. What stays with each caller is transport: a query string or
//! an IPC header in, JSON out, plus the server's log line and dump directory.
//!
//! **The JSON keys are the debug page's.** `live.html` reads them by name and is not changing,
//! so [`Verdict`] is snake case and `session::tests::every_key_the_debug_page_reads_is_in_the_verdict`
//! scrapes the page for the keys it reads and fails when one leaves.

use crate::cardness::Cardness;
use crate::detect::{
    detect, rectify_views, DetectOptions, DetectTimings, Detection, DetectTrace, EdgeMethod,
    QuadScore,
};
use crate::hash::{hash, HashKind};
use crate::index::{format_uuid, parse_uuid, Mask};
use crate::lock::{LockState, QuadLock};
#[cfg(feature = "ocr")]
use crate::ocr::TitleReader;
use crate::reference::{Label, MatchReport, Reference};
use crate::track::{CommitRule, Observation, Tracker, TrackerOptions};
use crate::trim::Margin;

/// Reading a title costs ~250 ms against a ~80 ms frame (release), so the readers run on one
/// frame in four and only while the tracker is still unsure.
pub const OCR_EVERY: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Canny,
    Otsu,
    /// Both detectors, and card-likeness picks the winner.
    #[default]
    Both,
}

impl Method {
    /// The query-string spelling, which is also the JSON one. Anything unknown is `Both`.
    pub fn parse(s: &str) -> Method {
        match s {
            "canny" => Method::Canny,
            "otsu" => Method::Otsu,
            _ => Method::Both,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Canny => "canny",
            Method::Otsu => "otsu",
            Method::Both => "both",
        }
    }

    fn edge_methods(self) -> Vec<EdgeMethod> {
        match self {
            Method::Canny => vec![EdgeMethod::Canny],
            Method::Otsu => vec![EdgeMethod::Otsu],
            Method::Both => vec![EdgeMethod::Canny, EdgeMethod::Otsu],
        }
    }
}

/// Everything a caller can change between frames. Every field has a default, so a JSON
/// object with any subset of them parses, and `{}` is the page's sliders as they start.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FrameOptions {
    pub work_long_edge: u32,
    pub method: Method,
    pub canny_low: f32,
    pub canny_high: f32,
    pub aspect_tolerance: f32,
    pub min_cardness: f32,
    /// Return the binary and contour images as well as the quad. Roughly doubles the
    /// response time, so a page asks for it only while its pipeline panel is open.
    pub stages: bool,
    pub rule: CommitRule,
    pub decide_at: f32,
    pub lead_margin: f32,
}

impl Default for FrameOptions {
    fn default() -> Self {
        FrameOptions {
            work_long_edge: 1024,
            method: Method::Both,
            canny_low: 40.0,
            canny_high: 100.0,
            aspect_tolerance: 0.18,
            min_cardness: crate::cardness::MIN_SCORE,
            stages: false,
            rule: CommitRule::Votes,
            decide_at: 8.0,
            lead_margin: 1.3,
        }
    }
}

impl FrameOptions {
    pub fn tracker_options(&self) -> TrackerOptions {
        TrackerOptions {
            rule: self.rule,
            decide_at: self.decide_at.clamp(0.5, 100.0),
            lead_margin: self.lead_margin.clamp(1.0, 5.0),
            ..Default::default()
        }
    }

    /// `settled` drops the extra framings once the tracker has an answer — measured on a 720 px
    /// frame they cost 63 ms against 112, almost all of it building descriptors for a question
    /// nobody is asking any more.
    fn detect_options(&self, method: EdgeMethod, settled: bool) -> DetectOptions {
        DetectOptions {
            method,
            work_long_edge: self.work_long_edge.clamp(240, 2048),
            canny_low: self.canny_low,
            canny_high: self.canny_high,
            aspect_tolerance: self.aspect_tolerance,
            min_cardness: self.min_cardness,
            query_insets: if settled { Vec::new() } else { DetectOptions::default().query_insets },
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FrameSize {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Stages {
    pub binary: Option<String>,
    pub contours: Option<String>,
    pub quad: Option<String>,
}

/// One accumulated candidate with its label resolved — the tracker deals in ids and the page
/// needs names, and `track` is deliberately independent of the corpus.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StandingView {
    pub id: String,
    pub evidence: f32,
    pub share: f32,
    pub seen: u32,
    pub label: Option<Label>,
    pub best_distance: f32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TrackedView {
    pub committed: bool,
    pub confidence: f32,
    pub rule: CommitRule,
    pub decide_at: f32,
    pub lead: Option<f32>,
    pub frozen: bool,
    pub streak: u32,
    pub frames: u32,
    pub misses: u32,
    pub standings: Vec<StandingView>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CollectorTry {
    pub set: String,
    pub number: String,
    pub matched: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CollectorView {
    pub raw: String,
    pub rotated: bool,
    pub elapsed_ms: f32,
    pub pairings: usize,
    pub tried: Vec<CollectorTry>,
    pub more: usize,
    pub band: Option<String>,
    pub matched: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrView {
    pub raw: String,
    pub normalized: String,
    pub rotated: bool,
    pub elapsed_ms: f32,
    pub band: Option<String>,
    pub matched: Option<String>,
    pub edits: Option<u32>,
}

/// What one frame came to. The keys are the debug page's — see the module doc.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Verdict {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub frame: FrameSize,
    pub decode_ms: f32,
    /// Whether a bundle is loaded at all — "no bundle" and "this frame held no card" are
    /// different states, and the page said the former for both until this existed.
    pub matcher: bool,
    pub lock: Option<LockState>,
    /// The lock's smoothed quad, which is what an overlay draws.
    pub quad: Option<[(f32, f32); 4]>,
    /// This frame's own quad, for showing the jitter the smoothing removes.
    pub quad_raw: Option<[(f32, f32); 4]>,
    pub method: Option<String>,
    pub cardness: Option<Cardness>,
    pub rejected_cardness: Option<Cardness>,
    pub trim: Option<Margin>,
    pub from_lock: bool,
    pub score: Option<QuadScore>,
    pub hash: Option<String>,
    pub rectified: Option<String>,
    pub timings: Option<DetectTimings>,
    pub candidates_examined: Option<usize>,
    pub stages: Option<Stages>,
    pub r#match: Option<MatchReport>,
    pub tracked: Option<TrackedView>,
    pub collector: Option<CollectorView>,
    pub ocr: Option<OcrView>,
}

impl Verdict {
    fn failed(error: String, frame: FrameSize, decode_ms: f32, matcher: bool) -> Verdict {
        Verdict {
            ok: false,
            error: Some(error),
            frame,
            decode_ms,
            matcher,
            lock: None,
            quad: None,
            quad_raw: None,
            method: None,
            cardness: None,
            rejected_cardness: None,
            trim: None,
            from_lock: false,
            score: None,
            hash: None,
            rectified: None,
            timings: None,
            candidates_examined: None,
            stages: None,
            r#match: None,
            tracked: None,
            collector: None,
            ocr: None,
        }
    }
}

/// One scanning session: the reference, the reader, and the two things that remember across
/// frames — the tracker and the quad lock. One per camera.
pub struct Session {
    reference: Option<Reference>,
    #[cfg(feature = "ocr")]
    reader: Option<TitleReader>,
    tracker: Tracker,
    lock: QuadLock,
    /// Frames since the session started, for the reader's cadence.
    seq: u64,
    top: usize,
}

impl Session {
    pub fn new(
        reference: Option<Reference>,
        #[cfg(feature = "ocr")] reader: Option<TitleReader>,
        top: usize,
    ) -> Session {
        Session {
            reference,
            #[cfg(feature = "ocr")]
            reader,
            tracker: Tracker::default(),
            lock: QuadLock::default(),
            seq: 0,
            top: top.clamp(1, 25),
        }
    }

    pub fn has_reference(&self) -> bool {
        self.reference.is_some()
    }

    pub fn has_reader(&self) -> bool {
        #[cfg(feature = "ocr")]
        {
            self.reader.is_some()
        }
        #[cfg(not(feature = "ocr"))]
        {
            false
        }
    }

    /// Forget the card: the reader pressed reset, or moved on.
    pub fn reset(&mut self) {
        self.tracker.reset();
        self.lock.reset();
    }

    /// Should the readers run on this frame? Every `OCR_EVERY`-th, and never once committed —
    /// an expensive tier stands down when the cheap one has settled it.
    pub fn reader_due(&mut self, committed: bool) -> bool {
        let n = self.seq;
        self.seq += 1;
        !committed && n % OCR_EVERY == 0
    }

    /// One frame. **Never panics**: the options come from sliders and the image crates assert
    /// on arguments they consider impossible — `edges::canny` panics outright when the low
    /// threshold exceeds the high one. Measured on the debug server before the guard existed:
    /// one slider drag killed every worker thread and exited the server.
    pub fn frame(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict {
        let matcher = self.reference.is_some();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.frame_inner(jpeg, opts))) {
            Ok(v) => v,
            Err(_) => Verdict::failed(
                "the detector panicked on this frame — see the log for the assertion".into(),
                FrameSize { w: 0, h: 0 },
                0.0,
                matcher,
            ),
        }
    }

    fn frame_inner(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict {
        let matcher = self.reference.is_some();
        let decode_started = std::time::Instant::now();
        let source = match image::load_from_memory(jpeg) {
            Ok(i) => i,
            Err(e) => {
                return Verdict::failed(format!("decode: {e}"), FrameSize { w: 0, h: 0 }, 0.0, matcher)
            }
        };
        let decode_ms = decode_started.elapsed().as_secs_f32() * 1000.0;
        let frame = FrameSize { w: source.width(), h: source.height() };

        // The page's rule and bar, applied before anything reads the verdict: the tally is
        // kept, only the judgement of it changes.
        self.tracker.set_options(opts.tracker_options());
        // Asked once, so both detectors and the re-rectify below see the same decision.
        let settled = self.tracker.last_committed();

        // ---- detect: the sweep over the methods, card-likeness picks the winner -----------
        let mut best: Option<(EdgeMethod, Detection, Option<DetectTrace>)> = None;
        let mut fallback_trace: Option<DetectTrace> = None;
        let mut error = None;
        for m in opts.method.edge_methods() {
            let (result, trace) = detect(&source, &opts.detect_options(m, settled));
            match result {
                Ok(d) => {
                    if best.as_ref().is_none_or(|(_, b, _): &(_, Detection, _)| {
                        d.cardness.score > b.cardness.score
                    }) {
                        best = Some((m, d, trace));
                    }
                }
                Err(e) => {
                    error = Some(e.to_string());
                    if trace.is_some() {
                        fallback_trace = trace;
                    }
                }
            }
        }

        let mut v = Verdict::failed(String::new(), frame, decode_ms, matcher);
        v.ok = best.is_some();
        v.error = None;

        // ---- lock ---------------------------------------------------------------------------
        let lock_state = self.lock.observe(best.as_ref().map(|(_, d, _)| d.quad));
        v.quad = lock_state.quad.map(|q| q.corners);
        let trusted = lock_state.is_trusted();
        let held_quad = lock_state.quad;
        v.lock = Some(lock_state);

        // ---- rectify from the quad the lock holds, not the one this frame found ------------
        let relocked = match (&held_quad, &best) {
            (Some(q), Some((method, d, _))) if trusted && q.corners != d.quad.corners => {
                rectify_views(&source.to_rgb8(), q, &opts.detect_options(*method, settled))
            }
            _ => None,
        };

        match best {
            Some((method, d, trace)) => {
                let view = relocked.as_ref();
                let rectified = view.map_or(&d.rectified, |x| &x.rectified);
                let rectified_180 = view.map_or(&d.rectified_180, |x| &x.rectified_180);
                let alternates = view.map_or(&d.alternates, |x| &x.alternates);
                let margin = view.map_or(d.margin, |x| x.margin);

                let descriptor = hash(
                    &image::DynamicImage::ImageRgb8(rectified.clone()).to_luma8(),
                    HashKind::DHash,
                    256,
                );
                v.method = Some(method.as_str().to_string());
                v.quad_raw = Some(d.quad.corners);
                if v.quad.is_none() {
                    v.quad = Some(d.quad.corners);
                }
                v.cardness = Some(d.cardness);
                v.trim = Some(margin);
                v.from_lock = relocked.is_some();
                v.score = Some(d.score);
                v.hash = Some(descriptor.to_hex());
                if let Some(t) = &trace {
                    v.timings = Some(t.timings);
                    v.candidates_examined = Some(t.candidates.len());
                    if opts.stages {
                        v.stages = Some(Stages {
                            binary: preview_uri(&t.binary, 300, 62),
                            contours: preview_uri(&t.contours, 300, 62),
                            quad: preview_uri(&t.quads, 300, 62),
                        });
                    }
                }
                v.rectified = preview_uri(rectified, 320, 78);

                // ---- match, readers, track ------------------------------------------------
                if let Some(r) = self.reference.as_ref().filter(|_| trusted) {
                    let mut views: Vec<(&image::RgbImage, &image::RgbImage)> =
                        vec![(rectified, rectified_180)];
                    views.extend(alternates.iter().map(|(a, b)| (a, b)));
                    let report = r.match_views(&views, self.top, &Mask::all());
                    let mut observations: Vec<Observation> = report
                        .candidates
                        .iter()
                        .filter_map(|c| {
                            parse_uuid(&c.id).map(|id| {
                                Observation::appearance(r.oracle_for(&id), id, c.normalized)
                            })
                        })
                        .collect();

                    #[cfg(feature = "ocr")]
                    if let Some(reader) = self.reader.as_ref() {
                        if self.reader_due(settled) {
                            let (col, obs) = read_collector(reader, r, rectified, rectified_180);
                            if let Some(o) = obs {
                                observations.insert(0, o);
                            }
                            v.collector = Some(col);
                            let (ocr, obs) = read_title(reader, r, rectified, rectified_180);
                            if let Some(o) = obs {
                                observations.insert(0, o);
                            }
                            v.ocr = Some(ocr);
                        }
                    }
                    #[cfg(not(feature = "ocr"))]
                    {
                        let _ = self.reader_due(settled);
                    }

                    let tracked = self.tracker.observe(&observations);
                    v.tracked = Some(tracked_view(&tracked, Some(r)));
                    v.r#match = Some(report);
                } else if matcher {
                    // Detected but not yet trusted: tell the tracker nothing was seen, so a box
                    // that never locks can never accumulate a name.
                    let tracked = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&tracked, self.reference.as_ref()));
                }
            }
            None => {
                // A frame with no card is still an observation: it is how the tracker learns
                // the card has been taken away.
                if matcher {
                    let tracked = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&tracked, self.reference.as_ref()));
                }
                v.error = Some(error.unwrap_or_else(|| "no card".into()));
                if let Some(t) = &fallback_trace {
                    v.rejected_cardness = t.candidates.first().map(|c| c.cardness);
                    v.timings = Some(t.timings);
                    v.candidates_examined = Some(t.candidates.len());
                    if opts.stages {
                        v.stages = Some(Stages {
                            binary: preview_uri(&t.binary, 300, 62),
                            contours: preview_uri(&t.contours, 300, 62),
                            quad: preview_uri(&t.quads, 300, 62),
                        });
                    }
                }
            }
        }
        v
    }
}

#[cfg(feature = "ocr")]
fn read_collector(
    reader: &TitleReader,
    r: &Reference,
    rectified: &image::RgbImage,
    rectified_180: &image::RgbImage,
) -> (CollectorView, Option<Observation>) {
    // Every pairing the parse produced, and what each resolved to — "it failed" and "it read
    // HOBEN where the card says HOB" are different problems and only the list tells them apart.
    const SHOWN: usize = 14;
    let col = reader.read_collector(rectified, rectified_180);
    let printing = r.lookup_collector(&col.candidates);
    let tried = col
        .candidates
        .iter()
        .take(SHOWN)
        .map(|(set, number)| CollectorTry {
            set: set.clone(),
            number: number.clone(),
            matched: r.lookup_pair(set, number).and_then(|id| r.label_for(&id)).map(|l| l.display()),
        })
        .collect();
    let view = CollectorView {
        raw: col.raw.clone(),
        rotated: col.rotated,
        elapsed_ms: col.elapsed_ms,
        pairings: col.candidates.len(),
        tried,
        more: col.candidates.len().saturating_sub(SHOWN),
        band: col.band.as_ref().and_then(|b| preview_uri(b, 360, 70)),
        matched: printing.and_then(|id| r.label_for(&id)).map(|l| l.display()),
    };
    let obs = printing.map(|id| Observation::from_collector(r.oracle_for(&id), id));
    (view, obs)
}

#[cfg(feature = "ocr")]
fn read_title(
    reader: &TitleReader,
    r: &Reference,
    rectified: &image::RgbImage,
    rectified_180: &image::RgbImage,
) -> (OcrView, Option<Observation>) {
    let read = reader.read_title(rectified, rectified_180);
    let hit = read.is_usable().then(|| r.lookup_by_name(&read.normalized)).flatten();
    let view = OcrView {
        raw: read.raw.clone(),
        normalized: read.normalized.clone(),
        rotated: read.rotated,
        elapsed_ms: read.elapsed_ms,
        band: read.band.as_ref().and_then(|b| preview_uri(b, 360, 70)),
        matched: hit.and_then(|(id, _)| r.label_for(&id)).map(|l| l.name),
        edits: hit.map(|(_, d)| d),
    };
    let obs = hit.map(|(id, edits)| Observation::from_ocr(r.oracle_for(&id), id, edits));
    (view, obs)
}

fn tracked_view(t: &crate::track::Tracked, reference: Option<&Reference>) -> TrackedView {
    TrackedView {
        committed: t.committed,
        confidence: t.confidence,
        rule: t.rule,
        decide_at: t.decide_at,
        lead: t.lead,
        frozen: t.frozen,
        streak: t.streak,
        frames: t.frames,
        misses: t.misses,
        standings: t
            .standings
            .iter()
            .map(|s| StandingView {
                id: format_uuid(&s.id),
                evidence: s.evidence,
                share: s.share,
                seen: s.seen,
                label: reference.and_then(|r| r.label_for(&s.best_member)),
                best_distance: s.best_normalized,
            })
            .collect(),
    }
}

/// A small JPEG data URI a page can put straight into an `<img>`.
pub fn preview_uri(img: &image::RgbImage, max_edge: u32, quality: u8) -> Option<String> {
    let dynamic = image::DynamicImage::ImageRgb8(img.clone());
    let small = dynamic.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&buf)))
}

fn base64(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}
```

Three things to check against the code you are moving from, since the snippet above was written from `serve.rs` as it stands and names must match it exactly: `DetectTrace`'s image fields (`binary`, `contours`, `quads`), `Detection`'s (`rectified`, `rectified_180`, `alternates`, `margin`, `quad`, `cardness`, `score`), and `Views`' (`rectified`, `rectified_180`, `alternates`, `margin`). If `rectified_180`'s preview in `serve.rs` is drawn from the 180° image anywhere, keep that too. Where `serve.rs` has a comment you did not carry over, carry it over.

Then, in `crates/card-scanner/src/lib.rs`, add `pub mod session;` in the module list, and in `track.rs` change `CommitRule`'s derive to `#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]`. While in `track.rs`, fix the two stale numbers in `Observation::from_collector`'s doc (lines ~239–243): it says "at 8.0 against appearance's 1.0" and "12 of 39 … 11 right" — the shipped weight is `2.0` for the card and `20.0` for the printing, and the fallback crops took the corpus figure to 15 of 39 with 14 right (`git log -1 d62dcf95` has the numbers). Rewrite those two sentences to the shipped values.

- [ ] **Step 4: Run the session tests**

Run: `cd crates/card-scanner && cargo test --lib session`
Expected: 7 passed. If `every_key_the_debug_page_reads_is_in_the_verdict` fails, the message lists the keys; each is a field to add to `Verdict`, never a key to drop from the page.

- [ ] **Step 5: Thin `serve.rs`**

Replace the server's `FrameOptions`, its `from_query`/`detect_options`/`tracker_options`, `OCR_EVERY`, `Shared`/`SharedLock`, `tracked_json`, `preview_uri`, `base64` and the body of `handle_frame` with:

```rust
use card_scanner::session::{FrameOptions, Method, Session, Verdict};

/// The session is shared rather than per-request, because it is the one deliberately
/// stateful piece of this server: a stable answer is a property of the *stream*.
type Shared = Arc<Mutex<Session>>;

/// The page's sliders, from the query string. The keys are the page's short names; the JSON
/// spelling the app uses is `FrameOptions`' own field names.
fn options_from_query(url: &str) -> FrameOptions {
    let q = query_pairs(url);
    let num = |key: &str, default: f32| -> f32 {
        q.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    let d = FrameOptions::default();
    FrameOptions {
        work_long_edge: num("edge", d.work_long_edge as f32) as u32,
        method: q.get("method").map_or(Method::Both, |m| Method::parse(m)),
        canny_low: num("lo", d.canny_low),
        canny_high: num("hi", d.canny_high),
        aspect_tolerance: num("aspect", d.aspect_tolerance),
        min_cardness: num("cardness", d.min_cardness),
        stages: q.get("stages").map(String::as_str) == Some("1"),
        rule: match q.get("rule").map(String::as_str) {
            Some("confidence") => card_scanner::track::CommitRule::Confidence,
            _ => card_scanner::track::CommitRule::Votes,
        },
        decide_at: num("decide", d.decide_at),
        lead_margin: num("margin", d.lead_margin),
    }
}

fn handle_frame(
    body: &[u8],
    opts: &FrameOptions,
    session: &Shared,
    log: bool,
    dump: Option<&std::path::Path>,
) -> serde_json::Value {
    let verdict: Verdict = match session.lock() {
        Ok(mut s) => s.frame(body, opts),
        Err(_) => return serde_json::json!({ "ok": false, "error": "the session lock is poisoned" }),
    };
    let out = serde_json::to_value(&verdict).unwrap_or_default();
    if let Some(dir) = dump {
        // A rolling window, so a long session does not fill the disk.
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 40;
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(
            dir.join(format!("{n:02}-frame.json")),
            serde_json::to_vec_pretty(&out).unwrap_or_default(),
        );
    }
    if log {
        // ... the existing log block, verbatim, reading `out[...]` as it does today ...
    }
    out
}
```

The `--dump-dir` rectified PNG was a clone of the rectification the session no longer hands out; keep the JSON dump and drop the PNG line, and say so in the flag's doc (the rectified preview is in the JSON as a data URI). In `main`, build the session once — `load_reference(&args)` and the reader load as today, then `Arc::new(Mutex::new(Session::new(reference, reader, args.top)))` — and remove the `catch_unwind` around `handle_frame` in the request loop (the session owns it). `/reset` becomes `session.lock().map(|mut s| s.reset())`. Keep `save_capture`, `query_pairs`, `decode_component` and the three existing tests. Add one test beside them:

```rust
    #[test]
    fn the_query_string_and_the_json_spell_the_same_options() {
        let from_query = options_from_query("/frame?edge=800&method=otsu&decide=12&rule=confidence&stages=1");
        let from_json: FrameOptions = serde_json::from_str(
            r#"{"work_long_edge":800,"method":"otsu","decide_at":12,"rule":"confidence","stages":true}"#,
        )
        .expect("json");
        assert_eq!(from_query, from_json);
        assert_eq!(options_from_query("/frame"), FrameOptions::default());
    }
```

- [ ] **Step 6: Run the server's tests and the page check**

Run: `cd crates/card-scanner && cargo test --features cli` then `node crates/card-scanner/scripts/check-live-page.mjs`
Expected: every test passes (the whole crate, both tiers); the page check prints four `ok` lines.

- [ ] **Step 7: Write the camera-less drive script**

Create `crates/card-scanner/scripts/drive-frames.mjs`:

```js
#!/usr/bin/env node
// POST one photograph to the debug server's /frame N times and print the verdict per frame.
//
//   node crates/card-scanner/scripts/drive-frames.mjs <image> <frames> [reset] [key=value ...]
//
// Keys go on the query string exactly as the page sends them (edge, method, lo, hi, aspect,
// cardness, stages, rule, decide, margin). `reset` POSTs /reset first. `port=7778` picks a
// server. The tracker's cross-frame behaviour — the decision, the freeze, the swap, the reset —
// is only visible across frames, and this is how to see it without a card in hand: found this
// way on 2026-09-08, a decision that reset itself every ten frames on a held card.
import { readFileSync } from 'node:fs';

const [image, frames, ...rest] = process.argv.slice(2);
if (!image || !frames) {
  console.error('usage: drive-frames.mjs <image> <frames> [reset] [key=value ...]');
  process.exit(2);
}
let port = '7777';
let reset = false;
const params = [];
for (const arg of rest) {
  if (arg === 'reset') reset = true;
  else if (arg.startsWith('port=')) port = arg.slice(5);
  else params.push(arg);
}
const base = `http://127.0.0.1:${port}`;
const body = readFileSync(image);
if (reset) {
  await fetch(`${base}/reset`, { method: 'POST' });
  console.log('reset');
}
for (let f = 1; f <= Number(frames); f++) {
  const t0 = performance.now();
  const res = await fetch(`${base}/frame?${params.join('&')}`, { method: 'POST', body });
  const j = await res.json();
  const ms = (performance.now() - t0).toFixed(0);
  const t = j.tracked;
  const lead = t?.standings?.[0];
  const name = lead?.label ? `${lead.label.name} ${lead.label.set.toUpperCase()} ${lead.label.number}` : '-';
  const tally = lead ? lead.evidence.toFixed(1) : '-';
  const reads = [j.ocr?.matched && `ocr=${j.ocr.matched}`, j.collector?.matched && `col=${j.collector.matched}`]
    .filter(Boolean)
    .join(' ');
  console.log(
    `${String(f).padStart(2)} ${String(ms).padStart(5)} ms lock=${j.lock?.phase ?? '-'} ` +
      `${t ? `rule=${t.rule} committed=${t.committed} frozen=${t.frozen} tally=${tally}/${t.decide_at} misses=${t.misses}` : 'no tracker'} ` +
      `:: ${name} ${reads} ${j.error ? `err=${j.error}` : ''}`,
  );
}
```

- [ ] **Step 8: Drive the release server with it**

Build and start: `cd crates/card-scanner && cargo build --release --bin serve --features cli`, then from the repo root
`crates/card-scanner/target/release/serve.exe --bundle .scanner-bundle/card-hashes-v5.bin --corpus D:/Code/mtg-grimoire/src-tauri/target/debug/data/corpus.db --ocr-models .scanner-bundle/models` (check `netstat -ano | findstr :7777` is empty first; stop any `serve` on it by PID).

Run: `node crates/card-scanner/scripts/drive-frames.mjs docs/scanner/scans/IMG20260823054948.jpg 20 reset rule=votes decide=8 edge=1024 method=canny`
Expected: `lock=locked` from frame 3, `tally` climbing 1.0 per frame, `committed=true frozen=true` at the eighth locked frame (frame 10), and `misses=0` on every frame after — the presence rule holding. Then without `reset`:
`node crates/card-scanner/scripts/drive-frames.mjs docs/scanner/scans/IMG20260823054959.jpg 24 rule=votes decide=8 edge=1024 method=canny`
Expected: the Plains stays decided for nine frames, `frozen=false` on the tenth with Mirkwood Nurturer at `tally=1.0`, an `ocr=` read on the next frame, decided within another seven. Stop the server afterwards.

- [ ] **Step 9: Commit**

```bash
git add crates/card-scanner/src/session.rs crates/card-scanner/src/lib.rs crates/card-scanner/src/track.rs crates/card-scanner/src/bin/serve.rs crates/card-scanner/scripts/drive-frames.mjs
git commit -m "refactor(scanner): move the per-frame handler into the crate as a Session"
```

---

### Task 2: The crate becomes a dependency of the app

**Files:**
- Modify: `src-tauri/Cargo.toml` (the non-wasm block at line ~146; a new `[profile.dev.package.*]` block at the end)
- Modify: `package.json:24` (`verify`)

**Interfaces:**
- Produces: `card_scanner::*` resolvable from `src-tauri` on every non-wasm target.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, inside `[target.'cfg(not(target_family = "wasm"))'.dependencies]`, after the `rusqlite` line:

```toml
# The card scanner. A plain path dependency across two standalone packages, which is what the
# crate's own manifest anticipates — it is deliberately not a workspace member, so its three
# tools keep building into `crates/card-scanner/target/`. `corpus` is the join back to
# `corpus.db` for labels and unifies with the `rusqlite = "0.40"` above; `ocr` is the two
# readers. Non-wasm only: the web build has no detector and says so on the page.
card-scanner = { path = "../crates/card-scanner", features = ["corpus", "ocr"] }
```

At the end of the file:

```toml
# **The scanner's image crates at full optimisation in a debug build.** These overrides live
# in `crates/card-scanner/Cargo.toml` too, and there they do nothing for this package: cargo
# reads `[profile.*]` from the build root only. Measured 2026-09-08 on the debug server: one
# rectification 2022 ms against 48 ms in release, a 960 px JPEG decode 230 ms against 4, so a
# `tauri dev` scanner without these is a slideshow. `rten` is listed after the measurement in
# the plan's last task decided it — remove the line if that measurement said it was not needed.
[profile.dev.package.image]
opt-level = 3
[profile.dev.package.imageproc]
opt-level = 3
```

- [ ] **Step 2: Check it resolves**

Run: `cd src-tauri && cargo check`
Expected: `Finished` with no new warnings. If `image` versions conflict (`cargo tree -i image` shows two), the crate's `image = "0.25"` and the app's transitive one are both 0.25.x and unify; a different major is a stop-and-report.

- [ ] **Step 3: The crate's suite joins verify**

In `package.json`, change `verify` to:

```json
"verify": "npm run build && npm run lint && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path crates/card-scanner/Cargo.toml --features cli"
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock package.json
git commit -m "build(scanner): take the card-scanner crate as an app dependency"
```

### Task 3: `src-tauri/src/scanner.rs` — state, assets, four commands

**Files:**
- Create: `src-tauri/src/scanner.rs`
- Modify: `src-tauri/src/lib.rs:194-216` (the "Desktop and Android" block), `src-tauri/src/desktop.rs:355-578` (`generate_handler!`) and `:607` (after `app.manage(state.clone())`)

**Interfaces:**
- Consumes: `card_scanner::session::{FrameOptions, Session, Verdict}`, `card_scanner::index::Bundle`, `card_scanner::reference::Reference`, `card_scanner::ocr::TitleReader`, `tauri::ipc::{InvokeBody, Request}`, `base64::engine::general_purpose::STANDARD` (already a dependency), `crate::sync::AppState::data_dir`.
- Produces (mirrored in Task 5):

```rust
pub const BUNDLE_FILE: &str = "card-hashes.bin";
pub const DETECTION_MODEL: &str = "models/text-detection.rten";
pub const RECOGNITION_MODEL: &str = "models/text-recognition.rten";

#[derive(Debug, Clone, serde::Serialize)]
pub struct Asset { pub path: String, pub present: bool, pub loaded: bool, pub error: Option<String> }
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerStatus { pub bundle: Asset, pub detection_model: Asset, pub recognition_model: Asset, pub labels: usize, pub scans_dir: String }
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Sidecar { pub expected: String, pub reported: String, pub confidence: String, pub votes: String, pub distance: String }
#[derive(Debug, Clone, serde::Serialize)]
pub struct Captured { pub saved: String }

pub struct ScannerState { /* private */ }
impl ScannerState { pub fn new(data_dir: PathBuf) -> ScannerState; }

// commands: scanner_status, scanner_frame, scanner_reset, scanner_capture
```

- [ ] **Step 1: Write the failing tests**

At the bottom of the new `src-tauri/src/scanner.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderMap;
    use tauri::ipc::InvokeBody;

    #[test]
    fn an_empty_data_dir_names_three_absent_paths_and_still_answers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let loaded = load(&dir.path().join("scanner"), &dir.path().join("corpus.db"), 5);
        let s = &loaded.status;
        assert!(!s.bundle.present && !s.bundle.loaded);
        assert!(s.bundle.path.ends_with(BUNDLE_FILE), "{}", s.bundle.path);
        assert!(s.detection_model.path.ends_with("text-detection.rten"));
        assert!(s.recognition_model.path.ends_with("text-recognition.rten"));
        assert_eq!(s.labels, 0);
        assert!(s.scans_dir.ends_with("scans"));
        assert!(!loaded.session.has_reference());
        assert!(!loaded.session.has_reader());
    }

    #[test]
    fn a_bundle_that_is_not_a_bundle_is_present_and_not_loaded_with_a_sentence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scanner = dir.path().join("scanner");
        std::fs::create_dir_all(&scanner).expect("mkdir");
        std::fs::write(scanner.join(BUNDLE_FILE), b"nonsense").expect("write");
        let loaded = load(&scanner, &dir.path().join("corpus.db"), 5);
        assert!(loaded.status.bundle.present);
        assert!(!loaded.status.bundle.loaded);
        assert!(loaded.status.bundle.error.is_some());
    }

    #[test]
    fn a_raw_body_with_no_header_uses_the_default_options() {
        let body = InvokeBody::Raw(vec![1, 2, 3]);
        let (jpeg, opts) = frame_payload(&body, &HeaderMap::new()).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        assert_eq!(opts, FrameOptions::default());
    }

    #[test]
    fn a_raw_body_reads_its_options_from_the_header() {
        let body = InvokeBody::Raw(vec![9]);
        let mut headers = HeaderMap::new();
        headers.insert(OPTIONS_HEADER, r#"{"decide_at":12,"method":"otsu"}"#.parse().expect("value"));
        let (_, opts) = frame_payload(&body, &headers).expect("payload");
        assert_eq!(opts.decide_at, 12.0);
        assert_eq!(opts.method, card_scanner::session::Method::Otsu);
    }

    #[test]
    fn a_json_body_carries_the_frame_as_base64_for_android() {
        let body = InvokeBody::Json(serde_json::json!({ "jpeg": "AQID", "options": { "decide_at": 6 } }));
        let (jpeg, opts) = frame_payload(&body, &HeaderMap::new()).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        assert_eq!(opts.decide_at, 6.0);
    }

    #[test]
    fn a_json_body_with_no_frame_is_a_sentence_not_a_panic() {
        let body = InvokeBody::Json(serde_json::json!({ "options": {} }));
        let err = frame_payload(&body, &HeaderMap::new()).expect_err("no jpeg");
        assert!(err.contains("jpeg"), "{err}");
        let body = InvokeBody::Json(serde_json::json!({ "jpeg": "not base64!" }));
        assert!(frame_payload(&body, &HeaderMap::new()).is_err());
    }

    #[test]
    fn a_capture_writes_the_two_files_the_debug_server_writes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scans = dir.path().join("scans");
        let sidecar = Sidecar { expected: "Plains".into(), reported: "Plains".into(), votes: "8.0".into(), ..Default::default() };
        let saved = write_capture(&scans, &[0xFF, 0xD8, 0xFF], &sidecar).expect("write");
        assert!(saved.saved.starts_with("live-") && saved.saved.ends_with(".jpg"), "{}", saved.saved);
        let json = std::fs::read_to_string(scans.join(&saved.saved).with_extension("json")).expect("sidecar");
        let v: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(v["expected"], "Plains");
        assert_eq!(v["votes"], "8.0");
        assert_eq!(v["image"], saved.saved);
        assert!(v["captured_at_epoch"].is_number());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test scanner::`
Expected: compile error — the module does not exist.

- [ ] **Step 3: Write the module**

```rust
//! The card scanner inside the app: the crate's [`Session`] behind four commands.
//!
//! **Its own managed state, not a field on `AppState`.** It is optional and desktop/Android
//! only, it loads lazily, and the only thing it shares with the rest of the app is the data
//! directory and one read of `corpus.db` for labels. `app.manage` holds it beside `AppState`.
//!
//! **Assets are files in `data/scanner/`, and the page names the missing one.** Nothing here
//! downloads: the bundle has no release asset yet and the models are not ours. A missing bundle
//! is a session that detects and rectifies and names nothing — the debug server's behaviour —
//! and a missing model pair is a session with no reader. `scanner_status` reports the exact
//! path it looked at for each, so "no bundle" is never the whole message.
//!
//! **`scanner_frame` is the one command that takes a raw body.** On desktop the JPEG is the
//! request body and the options are a header; on Android Tauri carries no raw bytes
//! (`tauri::ipc::Request`'s own doc: "on all platforms except Android"), so the same command
//! also accepts `{ "jpeg": "<base64>", "options": {…} }` as ordinary arguments. Both land in
//! [`frame_payload`], which is the whole difference.
//!
//! **The seventh connection.** Labels are loaded on a read-only connection opened for the
//! load and dropped after — never `AppState.db_read`, the rule the mirror thread and
//! `Rebuild now` already follow, because a 117k-row read on the shared read connection queues
//! every search behind it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use card_scanner::index::Bundle;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::session::{FrameOptions, Session, Verdict};
use tauri::http::HeaderMap;
use tauri::ipc::InvokeBody;

pub const BUNDLE_FILE: &str = "card-hashes.bin";
pub const DETECTION_MODEL: &str = "models/text-detection.rten";
pub const RECOGNITION_MODEL: &str = "models/text-recognition.rten";
/// The header a desktop frame carries its `FrameOptions` in, as JSON.
pub const OPTIONS_HEADER: &str = "x-scanner-options";
/// The header a desktop capture carries its `Sidecar` in, as JSON.
pub const CAPTURE_HEADER: &str = "x-scanner-capture";
/// Candidates per frame — the debug server's `--top` default.
const TOP: usize = 5;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Asset {
    pub path: String,
    pub present: bool,
    pub loaded: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerStatus {
    pub bundle: Asset,
    pub detection_model: Asset,
    pub recognition_model: Asset,
    /// Labels loaded from `corpus.db`; 0 when there is no bundle to label.
    pub labels: usize,
    /// Where `scanner_capture` writes — the same names and sidecar as the debug server's.
    pub scans_dir: String,
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

pub struct ScannerState {
    data_dir: PathBuf,
    loaded: Mutex<Option<Loaded>>,
}

impl ScannerState {
    pub fn new(data_dir: PathBuf) -> ScannerState {
        ScannerState { data_dir, loaded: Mutex::new(None) }
    }

    fn dir(&self) -> PathBuf {
        self.data_dir.join("scanner")
    }

    /// The session, loading it on first use. Held for the length of one frame.
    fn ensure(&self) -> Result<MutexGuard<'_, Option<Loaded>>, String> {
        let mut guard = self.loaded.lock().map_err(|_| "the scanner state is poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(load(&self.dir(), &self.data_dir.join("corpus.db"), TOP));
        }
        Ok(guard)
    }
}

fn asset(path: &Path) -> Asset {
    Asset { path: path.display().to_string(), present: path.is_file(), loaded: false, error: None }
}

/// Read the assets and build the session. Every failure is a sentence on its asset, never an
/// error out of here: the page is useful without a bundle, and it says which file is missing.
pub fn load(dir: &Path, corpus: &Path, top: usize) -> Loaded {
    let bundle_path = dir.join(BUNDLE_FILE);
    let mut bundle = asset(&bundle_path);
    let mut labels = 0;
    let reference = if bundle.present {
        match std::fs::read(&bundle_path).map_err(|e| e.to_string()).and_then(|b| {
            Bundle::from_bytes(&b).map_err(|e| e.to_string())
        }) {
            Ok(b) => {
                bundle.loaded = true;
                let mut reference = Reference::new(b);
                if corpus.is_file() {
                    match rusqlite::Connection::open_with_flags(
                        corpus,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
                    )
                    .and_then(|conn| reference.load_labels(&conn))
                    {
                        Ok(n) => labels = n,
                        Err(e) => bundle.error = Some(format!("labels: {e} — matches will be ids")),
                    }
                }
                Some(reference)
            }
            Err(e) => {
                bundle.error = Some(e);
                None
            }
        }
    } else {
        None
    };

    let det_path = dir.join(DETECTION_MODEL);
    let rec_path = dir.join(RECOGNITION_MODEL);
    let mut detection_model = asset(&det_path);
    let mut recognition_model = asset(&rec_path);
    let reader = if detection_model.present && recognition_model.present {
        match TitleReader::load(&det_path, &rec_path) {
            Ok(r) => {
                detection_model.loaded = true;
                recognition_model.loaded = true;
                Some(r)
            }
            Err(e) => {
                let s = e.to_string();
                detection_model.error = Some(s.clone());
                recognition_model.error = Some(s);
                None
            }
        }
    } else {
        None
    };

    Loaded {
        session: Session::new(reference, reader, top),
        status: ScannerStatus {
            bundle,
            detection_model,
            recognition_model,
            labels,
            scans_dir: dir.join("scans").display().to_string(),
        },
    }
}

/// The frame and its options, from either body shape. See the module doc.
pub fn frame_payload(body: &InvokeBody, headers: &HeaderMap) -> Result<(Vec<u8>, FrameOptions), String> {
    match body {
        InvokeBody::Raw(bytes) => {
            let opts = headers
                .get(OPTIONS_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Ok((bytes.clone(), opts))
        }
        InvokeBody::Json(value) => {
            let jpeg = value
                .get("jpeg")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "the frame has no `jpeg` field".to_string())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(jpeg)
                .map_err(|e| format!("the frame's base64 did not decode: {e}"))?;
            let opts = value
                .get("options")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("the frame's options did not parse: {e}"))?
                .unwrap_or_default();
            Ok((bytes, opts))
        }
    }
}

/// The capture and its sidecar, from either body shape.
fn capture_payload(body: &InvokeBody, headers: &HeaderMap) -> Result<(Vec<u8>, Sidecar), String> {
    match body {
        InvokeBody::Raw(bytes) => {
            let sidecar = headers
                .get(CAPTURE_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Ok((bytes.clone(), sidecar))
        }
        InvokeBody::Json(value) => {
            let jpeg = value
                .get("jpeg")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "the capture has no `jpeg` field".to_string())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(jpeg)
                .map_err(|e| format!("the capture's base64 did not decode: {e}"))?;
            let sidecar = value
                .get("sidecar")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("the capture's sidecar did not parse: {e}"))?
                .unwrap_or_default();
            Ok((bytes, sidecar))
        }
    }
}

/// `live-<epoch>.jpg` and its `.json`, the debug server's names and fields, so a frame captured
/// here can be copied into `docs/scanner/scans/` unchanged.
pub fn write_capture(scans: &Path, jpeg: &[u8], sidecar: &Sidecar) -> Result<Captured, String> {
    if jpeg.is_empty() {
        return Err("empty frame".into());
    }
    std::fs::create_dir_all(scans).map_err(|e| format!("{}: {e}", scans.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("live-{stamp}.jpg");
    let jpg = scans.join(&name);
    std::fs::write(&jpg, jpeg).map_err(|e| format!("{}: {e}", jpg.display()))?;
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
    std::fs::write(&side, serde_json::to_vec_pretty(&json).unwrap_or_default())
        .map_err(|e| format!("{}: {e}", side.display()))?;
    Ok(Captured { saved: name })
}

#[tauri::command]
pub async fn scanner_status(state: tauri::State<'_, Arc<ScannerState>>) -> Result<ScannerStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = state.ensure()?;
        Ok(guard.as_ref().expect("ensured").status.clone())
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_frame(
    state: tauri::State<'_, Arc<ScannerState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Verdict, String> {
    let (jpeg, opts) = frame_payload(request.body(), request.headers())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.ensure()?;
        Ok(guard.as_mut().expect("ensured").session.frame(&jpeg, &opts))
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_reset(state: tauri::State<'_, Arc<ScannerState>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.ensure()?;
        guard.as_mut().expect("ensured").session.reset();
        Ok(())
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_capture(
    state: tauri::State<'_, Arc<ScannerState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Captured, String> {
    let (jpeg, sidecar) = capture_payload(request.body(), request.headers())?;
    let scans = state.dir().join("scans");
    tauri::async_runtime::spawn_blocking(move || write_capture(&scans, &jpeg, &sidecar))
        .await
        .map_err(|e| format!("the scanner thread failed: {e}"))?
}
```

If the compiler refuses `tauri::ipc::Request<'_>` in an `async fn` (Tauri accepts borrowed arguments in async commands only when the return type is a `Result`, which these are), the fallback is a **sync** command that copies the payload out and calls `session.frame` inline — it blocks the IPC thread for one frame, which the single-in-flight pump tolerates; record that in the module doc if it happens.

Then in `src-tauri/src/lib.rs`, in the "Desktop and Android" block:

```rust
/// **The card scanner behind four commands.** Non-wasm for the crate's reason: the web build
/// has no detector, and the page says so. See `scanner`'s own doc for the two body shapes.
#[cfg(not(target_family = "wasm"))]
pub mod scanner;
```

In `src-tauri/src/desktop.rs`: add `scanner::scanner_status, scanner::scanner_frame, scanner::scanner_reset, scanner::scanner_capture,` to `generate_handler!` (before `sync_engine::commands::sync_live_state`, with a one-line comment: `// The scanner. Its state is managed separately below — see scanner.rs.`), and after `app.manage(state.clone());`:

```rust
            // The scanner's own state, beside `AppState` rather than inside it — it loads
            // lazily on the first status call and shares nothing but the data directory.
            app.manage(Arc::new(scanner::ScannerState::new(state.data_dir.clone())));
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test scanner::`
Expected: 7 passed. Then `cargo check` for the whole crate.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs src-tauri/src/lib.rs src-tauri/src/desktop.rs
git commit -m "feat(scanner): the crate's session behind four app commands"
```

---

### Task 4: `Core.call` widens to bytes and headers

**Files:**
- Modify: `src/lib/core/types.ts`, `src/lib/core/tauri.ts`, `src/lib/core/browser.ts`, `src/lib/core/index.ts`, `src/lib/core/core.test.ts`, `src/lib/core/browser.test.ts`, `.storybook/fake/core.ts:57`

**Interfaces:**
- Produces:

```ts
export type CallArgs = Record<string, unknown> | Uint8Array;
export interface CallOptions { headers?: Record<string, string> }
export interface Core {
  call<T>(command: string, args?: CallArgs, options?: CallOptions): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): () => void;
}
export const RAW_CALL_UNAVAILABLE = "The scanner needs the desktop or Android app — this build has no detector.";
```

- [ ] **Step 1: Write the failing tests**

In `src/lib/core/core.test.ts`, inside `describe("the Tauri core", …)`:

```ts
  it("forwards a byte payload and its headers to invoke as the third argument", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await tauriCore.call("scanner_frame", bytes, { headers: { "x-scanner-options": "{}" } });
    expect(invoke).toHaveBeenCalledWith("scanner_frame", bytes, {
      headers: { "x-scanner-options": "{}" },
    });
  });
```

In `src/lib/core/browser.test.ts`:

```ts
  it("rejects a byte payload with the web sentence and never spawns the Worker", async () => {
    await expect(browserCore.call("scanner_frame", new Uint8Array([1]))).rejects.toBe(
      RAW_CALL_UNAVAILABLE,
    );
    expect(workerSpawns()).toBe(0);
  });
```

(Use whatever that file already uses to count Worker constructions; if it has no counter, assert on the `Worker` constructor mock's call count.)

- [ ] **Step 2: Run the two files to verify they fail**

Run: `npx vitest run src/lib/core`
Expected: type errors on the third argument and a `RAW_CALL_UNAVAILABLE` import failure.

- [ ] **Step 3: Widen the seam**

`types.ts`: add `CallArgs` and `CallOptions` as above and change `call`'s signature. `tauri.ts`:

```ts
  call: <T,>(command: string, args?: CallArgs, options?: CallOptions) =>
    args === undefined
      ? invoke<T>(command)
      : options === undefined
        ? invoke<T>(command, args)
        : invoke<T>(command, args, { headers: options.headers }),
```

`browser.ts`, first lines of `call`:

```ts
      // **A byte payload cannot reach the Worker.** `web::route` is a match over JSON
      // arguments and the scanner is not compiled for this target; the page dispatches on
      // `isWebTarget()` before it ever calls, so this is the fence behind that, not a path a
      // reader sees. Rejected before an id is taken, for `cache_clear`'s reason above.
      if (args instanceof Uint8Array) return Promise.reject(RAW_CALL_UNAVAILABLE);
```

and `export const RAW_CALL_UNAVAILABLE = "The scanner needs the desktop or Android app — this build has no detector.";` at module level; `index.ts` re-exports it and the two types. `.storybook/fake/core.ts`: `export async function invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, _options?: { headers?: Record<string, string> }): Promise<T>` — the handler still receives `args ?? {}`.

- [ ] **Step 4: Run the tests and the two type-checks**

Run: `npx vitest run src/lib/core && npx tsc --noEmit && npx tsc -p .storybook --noEmit`
Expected: all pass. The Storybook program is the one that catches the fake's signature.

- [ ] **Step 5: Commit**

```bash
git add src/lib/core .storybook/fake/core.ts
git commit -m "feat(core): let a call carry bytes and headers, and refuse them on the web"
```

### Task 5: `ipc.ts` — types, four wrappers, and the fences

**Files:**
- Create: `src/lib/bytes.ts`, `src/lib/bytes.test.ts`
- Modify: `src/lib/ipc.ts` (header source index at `:11-38`; `invoke` at `:121`; types and wrappers appended), `src/lib/ipc.test.ts` (imports at `:12-28`; argument cases in the `describe` at `:56`; `rustFields` at `:2635`; a new `snakeMirrors` list beside `plainMirrors` at `:2791`)

**Interfaces:**
- Consumes: Task 4's `CallArgs`/`CallOptions`; Task 1's and Task 3's struct names.
- Produces (used by Tasks 6–11):

```ts
export type ScannerMethod = "canny" | "otsu" | "both";
export type ScannerRule = "votes" | "confidence";
export interface ScannerOptions { work_long_edge: number; method: ScannerMethod; canny_low: number; canny_high: number; aspect_tolerance: number; min_cardness: number; stages: boolean; rule: ScannerRule; decide_at: number; lead_margin: number }
export interface ScannerAsset { path: string; present: boolean; loaded: boolean; error: string | null }
export interface ScannerStatus { bundle: ScannerAsset; detection_model: ScannerAsset; recognition_model: ScannerAsset; labels: number; scans_dir: string }
export interface ScannerSidecar { expected: string; reported: string; confidence: string; votes: string; distance: string }
export interface ScannerCaptured { saved: string }
export interface ScannerFrameSize { w: number; h: number }
export type ScannerLockPhase = "idle" | "acquiring" | "locked";
export interface ScannerLock { phase: ScannerLockPhase; agree: number; misses: number }
export type ScannerCorner = [number, number];
export interface ScannerScore { via: string; skew: number; aspect: number; area_frac: number; max_angle_error: number; total: number }
export interface ScannerTimings { resize_ms: number; mask_ms: number; contour_ms: number; rectify_ms: number; total_ms: number }
export interface ScannerCardness { title: number; type_line: number; full_width_rows: number; score: number }
export interface ScannerTrim { left: number; top: number; right: number; bottom: number }
export interface ScannerStages { binary: string | null; contours: string | null; quad: string | null }
export interface ScannerLabel { name: string; set: string; number: string; lang: string; released: string }
export interface ScannerCandidate { id: string; distance: number; normalized: number; label: ScannerLabel | null; printings: number | null }
export interface ScannerMatch { section: string; rotated: boolean; view: number; views: number; candidates: ScannerCandidate[]; hash_ms: number; margin: number | null; search_ms: number }
export interface ScannerStanding { id: string; evidence: number; share: number; seen: number; label: ScannerLabel | null; best_distance: number }
export interface ScannerTracked { committed: boolean; confidence: number; rule: ScannerRule; decide_at: number; lead: number | null; frozen: boolean; streak: number; frames: number; misses: number; standings: ScannerStanding[] }
export interface ScannerCollectorTry { set: string; number: string; matched: string | null }
export interface ScannerCollector { raw: string; rotated: boolean; elapsed_ms: number; pairings: number; tried: ScannerCollectorTry[]; more: number; band: string | null; matched: string | null }
export interface ScannerOcr { raw: string; normalized: string; rotated: boolean; elapsed_ms: number; band: string | null; matched: string | null; edits: number | null }
export interface ScannerVerdict {
  ok: boolean; error?: string; frame: ScannerFrameSize; decode_ms: number; matcher: boolean;
  lock: ScannerLock | null; quad: ScannerCorner[] | null; quad_raw: ScannerCorner[] | null; method: string | null;
  cardness: ScannerCardness | null; rejected_cardness: ScannerCardness | null; trim: ScannerTrim | null; from_lock: boolean;
  score: ScannerScore | null; hash: string | null; rectified: string | null; timings: ScannerTimings | null;
  candidates_examined: number | null; stages: ScannerStages | null; match: ScannerMatch | null;
  tracked: ScannerTracked | null; collector: ScannerCollector | null; ocr: ScannerOcr | null;
}
// wrappers on `ipc`:
scannerStatus: () => Promise<ScannerStatus>
scannerFrame: (jpeg: Uint8Array, options: ScannerOptions) => Promise<ScannerVerdict>
scannerReset: () => Promise<void>
scannerCapture: (jpeg: Uint8Array, sidecar: ScannerSidecar) => Promise<ScannerCaptured>
// src/lib/bytes.ts
export function bytesToBase64(bytes: Uint8Array): string
```

  `LockState.quad` is `#[serde(skip)]` in Rust, so the TS `ScannerLock` has no `quad` field — the mirror parser sees only `pub` fields with a type after the colon and `quad` has one, so the mirror row for `ScannerLock` will *fail* unless `rustFields` skips a field whose preceding line is `#[serde(skip)]`. Add that skip to the helper (Step 5), and the same for `TitleRead`-style skips should any other struct need it.

- [ ] **Step 1: Write the failing tests**

`src/lib/bytes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./bytes";

describe("bytesToBase64", () => {
  it("encodes with the standard alphabet and padding, the one Rust's STANDARD engine decodes", () => {
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(bytesToBase64(new Uint8Array([255, 254]))).toBe("//4=");
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("survives a payload larger than one call stack of arguments", () => {
    // `String.fromCharCode(...bytes)` on 200 KB throws a RangeError; a frame is 140 KB.
    const big = new Uint8Array(300_000).fill(65);
    expect(bytesToBase64(big).length).toBe(400_000);
  });
});
```

In `src/lib/ipc.test.ts`, inside the argument-names `describe` (add `vi.mock("@/lib/platform", …)` at the top of the file if the file does not already mock it; it must default `isAndroid` to `false`):

```ts
  it("scanner_frame sends the frame as bytes with its options in a header on desktop", async () => {
    const jpeg = new Uint8Array([1, 2, 3]);
    await ipc.scannerFrame(jpeg, DEFAULT_SCANNER_OPTIONS);
    expect(invoke).toHaveBeenCalledWith("scanner_frame", jpeg, {
      headers: { "x-scanner-options": JSON.stringify(DEFAULT_SCANNER_OPTIONS) },
    });
  });

  it("scanner_frame sends the frame as base64 arguments on Android", async () => {
    vi.mocked(isAndroid).mockReturnValueOnce(true);
    await ipc.scannerFrame(new Uint8Array([1, 2, 3]), DEFAULT_SCANNER_OPTIONS);
    expect(invoke).toHaveBeenCalledWith("scanner_frame", { jpeg: "AQID", options: DEFAULT_SCANNER_OPTIONS });
  });

  it("scanner_capture carries the sidecar the same two ways", async () => {
    const sidecar = { expected: "Plains", reported: "", confidence: "", votes: "8.0", distance: "74" };
    await ipc.scannerCapture(new Uint8Array([9]), sidecar);
    expect(invoke).toHaveBeenCalledWith("scanner_capture", new Uint8Array([9]), {
      headers: { "x-scanner-capture": JSON.stringify(sidecar) },
    });
    vi.mocked(isAndroid).mockReturnValueOnce(true);
    await ipc.scannerCapture(new Uint8Array([9]), sidecar);
    expect(invoke).toHaveBeenCalledWith("scanner_capture", { jpeg: "CQ==", sidecar });
  });

  it("scanner_status and scanner_reset take nothing", async () => {
    await ipc.scannerStatus();
    expect(invoke).toHaveBeenCalledWith("scanner_status");
    await ipc.scannerReset();
    expect(invoke).toHaveBeenCalledWith("scanner_reset");
  });
```

`DEFAULT_SCANNER_OPTIONS` is defined in Task 6; for this task, define it inline in the test as the ten defaults from Task 1 and switch the import in Task 6.

Beside `plainMirrors`, a third list and its `it.each`:

```ts
  /**
   * **Snake case on both sides.** The scanner's JSON is the debug page's, which reads
   * `decide_at` and `best_distance` by name and is not changing — so these mirrors keep the
   * Rust field names verbatim and the row compares them with no camel step.
   */
  const snakeMirrors: [tsName: string, rustSource: string, rustName: string][] = [
    ["ScannerAsset", scannerRs, "Asset"],
    ["ScannerStatus", scannerRs, "ScannerStatus"],
    ["ScannerSidecar", scannerRs, "Sidecar"],
    ["ScannerCaptured", scannerRs, "Captured"],
    ["ScannerOptions", sessionRs, "FrameOptions"],
    ["ScannerVerdict", sessionRs, "Verdict"],
    ["ScannerFrameSize", sessionRs, "FrameSize"],
    ["ScannerStages", sessionRs, "Stages"],
    ["ScannerStanding", sessionRs, "StandingView"],
    ["ScannerTracked", sessionRs, "TrackedView"],
    ["ScannerCollectorTry", sessionRs, "CollectorTry"],
    ["ScannerCollector", sessionRs, "CollectorView"],
    ["ScannerOcr", sessionRs, "OcrView"],
    ["ScannerLabel", referenceRs, "Label"],
    ["ScannerCandidate", referenceRs, "Candidate"],
    ["ScannerMatch", referenceRs, "MatchReport"],
    ["ScannerLock", lockRs, "LockState"],
    ["ScannerScore", detectRs, "QuadScore"],
    ["ScannerTimings", detectRs, "DetectTimings"],
    ["ScannerCardness", cardnessRs, "Cardness"],
    ["ScannerTrim", trimRs, "Margin"],
  ];

  it.each(snakeMirrors)(
    "the %s mirror agrees with the Rust struct field for field, snake case kept",
    (tsName, rustSource, rustName) => {
      const rust = rustFields(rustSource, rustName);
      const ts = tsFields(ipcSource, tsName);
      expect(rust.length, `nothing parsed out of \`${rustName}\``).toBeGreaterThan(0);
      expect(ts.length, `nothing parsed out of \`${tsName}\``).toBeGreaterThan(0);
      expect([...ts].sort()).toEqual([...rust].sort());
    },
  );
```

with the imports:

```ts
import scannerRs from "../../src-tauri/src/scanner.rs?raw";
import sessionRs from "../../crates/card-scanner/src/session.rs?raw";
import referenceRs from "../../crates/card-scanner/src/reference.rs?raw";
import lockRs from "../../crates/card-scanner/src/lock.rs?raw";
import detectRs from "../../crates/card-scanner/src/detect.rs?raw";
import cardnessRs from "../../crates/card-scanner/src/cardness.rs?raw";
import trimRs from "../../crates/card-scanner/src/trim.rs?raw";
```

`vite.config.ts`'s `server.fs.allow` may need `crates/` added for the `?raw` imports to be served under vitest; if the import is refused, add the path there beside the existing `src-tauri` entry.

- [ ] **Step 2: Run the two test files to verify they fail**

Run: `npx vitest run src/lib/bytes.test.ts src/lib/ipc.test.ts`
Expected: `bytes` module missing; `ipc.scannerFrame` not a function; the mirror rows fail on missing interfaces.

- [ ] **Step 3: Write `bytes.ts`**

```ts
/**
 * A `Uint8Array` as standard base64 — the alphabet and padding Rust's
 * `base64::engine::general_purpose::STANDARD` decodes.
 *
 * **Chunked, because `String.fromCharCode(...bytes)` spreads the whole array onto the call
 * stack and throws `RangeError` somewhere past 100 KB — and a scanner frame is 140 KB.** Only
 * the Android leg of `ipc.scannerFrame` needs this; the desktop leg hands the bytes to Tauri
 * as they are.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
```

- [ ] **Step 4: Add the types and wrappers to `ipc.ts`**

Widen the helper: `const invoke = <T,>(command: string, args?: CallArgs, options?: CallOptions): Promise<T> => core.call<T>(command, args, options);` with `import type { CallArgs, CallOptions } from "@/lib/core"` and `import { isAndroid } from "@/lib/platform"` and `import { bytesToBase64 } from "@/lib/bytes"`. Add every interface from the Interfaces block above, each with a one-line doc naming its Rust source (`session.rs`, `scanner.rs`, `reference.rs`, `lock.rs`, `detect.rs`, `cardness.rs`, `trim.rs`), and add those files to the header source index. Then the four wrappers at the end of the `ipc` object:

```ts
  /** `scanner::scanner_status`. Lazy: the first call loads the bundle and the models. */
  scannerStatus: () => invoke<ScannerStatus>("scanner_status"),
  /**
   * `scanner::scanner_frame`. **Two shapes for one command.** On desktop the JPEG is the body
   * and the options ride in a header; on Android Tauri carries no raw bytes ("on all platforms
   * except Android", its own doc on `Request`), so the same command takes `{ jpeg, options }`
   * as named arguments. `isAndroid()`'s third reader, and the one its note asks to justify: the
   * core boundary is per *build* and both legs are the Tauri build — the difference is
   * Tauri's, per OS, and it is met here in the one wrapper that meets it.
   */
  scannerFrame: (jpeg: Uint8Array, options: ScannerOptions) =>
    isAndroid()
      ? invoke<ScannerVerdict>("scanner_frame", { jpeg: bytesToBase64(jpeg), options })
      : invoke<ScannerVerdict>("scanner_frame", jpeg, {
          headers: { "x-scanner-options": JSON.stringify(options) },
        }),
  /** `scanner::scanner_reset`. The reader pressed reset, or the next card is coming. */
  scannerReset: () => invoke<void>("scanner_reset"),
  /** `scanner::scanner_capture`. The same two shapes as `scannerFrame`. */
  scannerCapture: (jpeg: Uint8Array, sidecar: ScannerSidecar) =>
    isAndroid()
      ? invoke<ScannerCaptured>("scanner_capture", { jpeg: bytesToBase64(jpeg), sidecar })
      : invoke<ScannerCaptured>("scanner_capture", jpeg, {
          headers: { "x-scanner-capture": JSON.stringify(sidecar) },
        }),
```

- [ ] **Step 5: Extend `rustFields` for `r#match` and `#[serde(skip)]`**

Replace the field regex line in `rustFields` with a two-line walk:

```ts
    const lines = body.slice(0, end);
    return lines
      .map((line, i) =>
        /^\s*#\[serde\(skip\)\]/.test(lines[i - 1] ?? "")
          ? undefined
          : /^\s*pub\s+(?:r#)?([a-z0-9_]+)\s*:/.exec(line)?.[1],
      )
      .filter((f): f is string => f !== undefined);
```

with a doc comment: a `#[serde(skip)]` field is not in the JSON, so it is not in the mirror; `r#match` is the one raw identifier, because `match` is a keyword and the page reads `j.match`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/bytes.test.ts src/lib/ipc.test.ts src/lib/core && npx tsc --noEmit`
Expected: all pass, including every existing `mirrors` and `plainMirrors` row.

- [ ] **Step 7: Commit**

```bash
git add src/lib/bytes.ts src/lib/bytes.test.ts src/lib/ipc.ts src/lib/ipc.test.ts vite.config.ts
git commit -m "feat(ipc): the four scanner wrappers, and snake-case mirror rows for the verdict"
```

---

### Task 6: Options, sentences and fixtures — the pure half

**Files:**
- Create: `src/features/scanner/scannerOptions.ts`, `verdictText.ts`, `fixtures.ts`, `verdictText.test.ts`, `scannerOptions.test.ts`

**Interfaces:**
- Consumes: Task 5's types.
- Produces:

```ts
// scannerOptions.ts
export const DEFAULT_SCANNER_OPTIONS: ScannerOptions;   // the ten defaults of Task 1
/** The page's `send` slider — the long edge a frame is downscaled to before it is sent. Not a FrameOptions field. */
export const DEFAULT_SEND_PX = 960;
export const SEND_PX = { min: 480, max: 1440, step: 80 } as const;
export const SLIDERS: { key: keyof ScannerOptions; label: string; min: number; max: number; step: number; format: (v: number) => string }[];
// verdictText.ts
export const CARD_ASPECT = 63 / 88;
export const SURE_DISTANCE = 0.30;
export function headline(v: ScannerVerdict | null): string;             // "Storm of Saruman" | "no card" | "card located" | "suspect shape" | "looking…"
export function verdictWord(t: ScannerTracked | null): "decided" | "voting" | "confirmed" | "gathering" | null;
export function barFill(t: ScannerTracked | null): number;             // 0..1: votes/decide_at under votes, confidence otherwise
export function shareLine(t: ScannerTracked | null): string;           // "9.8/8 · 92f" | "80% over 12f" | "—"
export function leadLine(t: ScannerTracked | null): string;            // "×631.4" | "unopposed" | "—"
export function standingValue(s: ScannerStanding, rule: ScannerRule): string; // "8.0" | "90%"
export function cameraSentence(err: unknown): { name: string; message: string };
export function bundleSentence(status: ScannerStatus | null): string | null;  // null when loaded
export function modelsSentence(status: ScannerStatus | null): string | null;
export const WEB_SENTENCE: string;   // re-export of RAW_CALL_UNAVAILABLE
// fixtures.ts
export const VERDICTS: { voting: ScannerVerdict; decided: ScannerVerdict; confidence: ScannerVerdict; noMatch: ScannerVerdict; noCard: ScannerVerdict; panicked: ScannerVerdict };
export const STATUS: { present: ScannerStatus; missing: ScannerStatus; noModels: ScannerStatus };
```

- [ ] **Step 1: Write the failing tests**

`src/features/scanner/verdictText.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VERDICTS, STATUS } from "./fixtures";
import {
  barFill, bundleSentence, cameraSentence, headline, leadLine, modelsSentence, shareLine,
  standingValue, verdictWord,
} from "./verdictText";

describe("the headline", () => {
  it("is the decided card's name, and otherwise says what the frame is", () => {
    expect(headline(VERDICTS.decided)).toBe("Storm of Saruman");
    expect(headline(VERDICTS.voting)).toBe("card located");
    expect(headline(VERDICTS.noCard)).toBe("no card");
    expect(headline(null)).toBe("looking…");
  });
});

describe("the vote rule's numbers", () => {
  it("fills the bar with votes over the bar, capped at one", () => {
    expect(barFill(VERDICTS.voting.tracked)).toBeCloseTo(5 / 8);
    expect(barFill(VERDICTS.decided.tracked)).toBe(1);
    expect(barFill(VERDICTS.confidence.tracked)).toBeCloseTo(0.8);
    expect(barFill(null)).toBe(0);
  });

  it("writes the tally, the frames and the lead the way the debug page does", () => {
    expect(shareLine(VERDICTS.voting.tracked)).toBe("5.0/8 · 12f");
    expect(shareLine(VERDICTS.confidence.tracked)).toBe("80% over 12f");
    expect(leadLine(VERDICTS.voting.tracked)).toBe("×4.0");
    expect(leadLine(VERDICTS.decided.tracked)).toBe("unopposed");
    expect(leadLine(VERDICTS.confidence.tracked)).toBe("—");
    expect(verdictWord(VERDICTS.decided.tracked)).toBe("decided");
    expect(verdictWord(VERDICTS.voting.tracked)).toBe("voting");
    expect(verdictWord(VERDICTS.confidence.tracked)).toBe("confirmed");
    expect(standingValue(VERDICTS.voting.tracked!.standings[0], "votes")).toBe("5.0");
    expect(standingValue(VERDICTS.confidence.tracked!.standings[0], "confidence")).toBe("90%");
  });
});

describe("the sentences", () => {
  it("keys the camera's three on the DOMException name", () => {
    expect(cameraSentence(new DOMException("x", "NotAllowedError")).message).toBe(
      "MTG Grimoire needs camera access to scan a card.",
    );
    expect(cameraSentence(new DOMException("x", "NotFoundError")).message).toBe("No camera on this device.");
    expect(cameraSentence(new Error("boom")).message).toBe("Camera error: Error.");
  });

  it("names the missing file and where it looked", () => {
    expect(bundleSentence(STATUS.present)).toBeNull();
    expect(bundleSentence(STATUS.missing)).toBe(
      `No reference bundle. Put \`card-hashes.bin\` at ${STATUS.missing.bundle.path}.`,
    );
    expect(modelsSentence(STATUS.noModels)).toBe(
      `No OCR models. Put \`text-detection.rten\` and \`text-recognition.rten\` at ${STATUS.noModels.detection_model.path}.`,
    );
    expect(modelsSentence(STATUS.present)).toBeNull();
  });
});
```

`src/features/scanner/scannerOptions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SCANNER_OPTIONS, SLIDERS } from "./scannerOptions";

describe("the scanner options", () => {
  it("start where the debug page's sliders start", () => {
    expect(DEFAULT_SCANNER_OPTIONS).toEqual({
      work_long_edge: 1024, method: "both", canny_low: 40, canny_high: 100, aspect_tolerance: 0.18,
      min_cardness: 0, stages: false, rule: "votes", decide_at: 8, lead_margin: 1.3,
    });
  });

  it("draws one slider per numeric field, each holding its default", () => {
    for (const s of SLIDERS) {
      const v = DEFAULT_SCANNER_OPTIONS[s.key];
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(s.min);
      expect(v).toBeLessThanOrEqual(s.max);
      expect(s.format(v as number).length).toBeGreaterThan(0);
    }
    expect(SLIDERS.map((s) => s.key)).toEqual([
      "decide_at", "lead_margin", "work_long_edge", "canny_low", "canny_high", "aspect_tolerance", "min_cardness",
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/scanner`
Expected: modules missing.

- [ ] **Step 3: Write the three modules**

`scannerOptions.ts`:

```ts
import type { ScannerOptions } from "@/lib/ipc";

/** The debug page's sliders as they start — `FrameOptions::default()` in the crate, verbatim. */
export const DEFAULT_SCANNER_OPTIONS: ScannerOptions = {
  work_long_edge: 1024,
  method: "both",
  canny_low: 40,
  canny_high: 100,
  aspect_tolerance: 0.18,
  min_cardness: 0,
  stages: false,
  rule: "votes",
  decide_at: 8,
  lead_margin: 1.3,
};

/**
 * The long edge a frame is downscaled to before it is sent — the page's `send` slider. Not a
 * `FrameOptions` field: the detector never sees the size it was not sent.
 */
export const DEFAULT_SEND_PX = 960;
export const SEND_PX = { min: 480, max: 1440, step: 80 } as const;

export interface SliderSpec {
  key: keyof ScannerOptions;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

/** The seven numeric sliders, in the order the Controls panel draws them. */
export const SLIDERS: readonly SliderSpec[] = [
  { key: "decide_at", label: "decide at", min: 1, max: 40, step: 1, format: String },
  { key: "lead_margin", label: "lead margin", min: 1, max: 3, step: 0.1, format: (v) => v.toFixed(1) },
  { key: "work_long_edge", label: "work edge", min: 320, max: 1600, step: 64, format: String },
  { key: "canny_low", label: "canny lo", min: 5, max: 120, step: 5, format: String },
  { key: "canny_high", label: "canny hi", min: 20, max: 300, step: 10, format: String },
  { key: "aspect_tolerance", label: "aspect tol", min: 0.04, max: 0.4, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "min_cardness", label: "min cardness", min: 0, max: 0.8, step: 0.05, format: (v) => v.toFixed(2) },
];
```

`verdictText.ts`:

```ts
import { RAW_CALL_UNAVAILABLE } from "@/lib/core";
import type { ScannerRule, ScannerStanding, ScannerStatus, ScannerTracked, ScannerVerdict } from "@/lib/ipc";

export const CARD_ASPECT = 63 / 88;
/** The distance gate, as a fraction of the descriptor's bits — `TrackerOptions::max_normalized`. */
export const SURE_DISTANCE = 0.3;
export const WEB_SENTENCE = RAW_CALL_UNAVAILABLE;

function aspectOk(v: ScannerVerdict): boolean {
  return v.ok && v.score !== null && Math.abs(v.score.aspect - CARD_ASPECT) / CARD_ASPECT < 0.08;
}

/** The word over the video: the decided card, else what the frame is. */
export function headline(v: ScannerVerdict | null): string {
  if (v === null) return "looking…";
  const lead = v.tracked?.standings[0];
  if (v.tracked?.committed && lead?.label) return lead.label.name;
  if (!v.ok) return "no card";
  return aspectOk(v) ? "card located" : "suspect shape";
}

export function verdictWord(t: ScannerTracked | null): "decided" | "voting" | "confirmed" | "gathering" | null {
  if (t === null || t.standings.length === 0) return null;
  if (t.rule === "votes") return t.committed ? "decided" : "voting";
  return t.committed ? "confirmed" : "gathering";
}

/** 0..1. Votes over the bar under the vote rule; the two-way confidence otherwise. */
export function barFill(t: ScannerTracked | null): number {
  if (t === null) return 0;
  const lead = t.standings[0];
  if (t.rule === "votes") return lead === undefined ? 0 : Math.min(1, lead.evidence / t.decide_at);
  return Math.min(1, t.confidence);
}

export function shareLine(t: ScannerTracked | null): string {
  if (t === null) return "—";
  if (t.rule === "votes") {
    const tally = t.standings[0]?.evidence ?? 0;
    return `${tally.toFixed(1)}/${t.decide_at} · ${t.frames}f`;
  }
  return `${(t.confidence * 100).toFixed(0)}% over ${t.frames}f`;
}

export function leadLine(t: ScannerTracked | null): string {
  if (t === null || t.rule !== "votes" || t.standings.length === 0) return "—";
  return t.lead === null ? "unopposed" : `×${t.lead.toFixed(1)}`;
}

export function standingValue(s: ScannerStanding, rule: ScannerRule): string {
  return rule === "votes" ? s.evidence.toFixed(1) : `${(s.share * 100).toFixed(0)}%`;
}

/** The QR scanner's three sentences, with "scan a card" in place of "scan a code". */
export function cameraSentence(err: unknown): { name: string; message: string } {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "Error";
  switch (name) {
    case "NotAllowedError":
      return { name, message: "MTG Grimoire needs camera access to scan a card." };
    case "NotFoundError":
      return { name, message: "No camera on this device." };
    default:
      return { name, message: `Camera error: ${name}.` };
  }
}

export function bundleSentence(status: ScannerStatus | null): string | null {
  if (status === null || status.bundle.loaded) return null;
  return `No reference bundle. Put \`card-hashes.bin\` at ${status.bundle.path}.`;
}

export function modelsSentence(status: ScannerStatus | null): string | null {
  if (status === null || (status.detection_model.loaded && status.recognition_model.loaded)) return null;
  return `No OCR models. Put \`text-detection.rten\` and \`text-recognition.rten\` at ${status.detection_model.path}.`;
}
```

`fixtures.ts` — six verdicts and three statuses, built from one base. The voting fixture: `tracked.rule = "votes"`, `decide_at = 8`, `frames = 12`, `lead = 4`, `committed = false`, `frozen = false`, standings `[Plains 2XM 373 evidence 5.0 share 0.8 seen 10 best_distance 0.289, Honored Hierarch ORI 17 evidence 1.25 share 0.2 seen 3 best_distance 0.32]`, `match.candidates[0]` Plains at `distance 74, normalized 0.289`, `score.aspect 0.716`, `lock { phase: "locked", agree: 3, misses: 0 }`, `ok: true`. The decided fixture: same with `committed: true, frozen: true, evidence 8.0, lead: null`, one standing, label Storm of Saruman LTR 72. The confidence fixture: `rule: "confidence", confidence: 0.8, committed: true`, standings shares `0.9` and `0.1`. `noMatch`: `ok: true`, `matcher: true`, `tracked` with no standings, `match: null`. `noCard`: `ok: false, error: "no quadrilateral in this frame looks like a card (examined 365 contours)"`, `lock { phase: "idle", agree: 0, misses: 3 }`, everything else null. `panicked`: `ok: false, error: "the detector panicked on this frame — see the log for the assertion"`. `STATUS.present`: every asset `present: true, loaded: true, error: null`, `labels: 117630`, paths under `D:\\app\\data\\scanner\\`; `missing`: every asset `present: false, loaded: false`; `noModels`: bundle loaded, the two models absent. Give `timings` on the ok fixtures the release numbers `{ resize_ms: 2.1, mask_ms: 88.8, contour_ms: 5.3, rectify_ms: 47.8, total_ms: 144 }` and `decode_ms: 1.9`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/scanner && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/scanner/scannerOptions.ts src/features/scanner/scannerOptions.test.ts src/features/scanner/verdictText.ts src/features/scanner/verdictText.test.ts src/features/scanner/fixtures.ts
git commit -m "feat(scanner): the view's options, sentences and fixtures"
```

### Task 7: The panel column — pure, tested, storied

**Files:**
- Modify: `src/lib/store.ts` (a `scannerFolds` field and its setter, beside `keyMapOpen`)
- Create: `src/features/scanner/ScannerPanels.tsx`, `panels/Panel.tsx`, `panels/MatchPanel.tsx`, `panels/ControlsPanel.tsx`, `panels/PipelinePanel.tsx`, `panels/BudgetPanel.tsx`, `panels/RectifiedPanel.tsx`, `panels/ReadoutsPanel.tsx`, `ScannerPanels.test.tsx`, `ScannerPanels.stories.tsx`

**Interfaces:**
- Consumes: Task 5's types, Task 6's `DEFAULT_SCANNER_OPTIONS`, `SLIDERS`, `SEND_PX`, the sentence functions, `VERDICTS`/`STATUS`; `SettingsSection`'s classes (copied, not imported — `panels/Panel.tsx` is the scanner's own foldable section).
- Produces:

```ts
// store.ts
export type ScannerPanelId = "controls" | "pipeline" | "budget" | "rectified" | "readouts";
scannerFolds: Record<ScannerPanelId, boolean>;      // true = open; all false initially
setScannerFold: (id: ScannerPanelId, open: boolean) => void;

// ScannerPanels.tsx
export interface ScannerPanelsProps {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  roundTripMs: number | null;      // the pump's last round trip; the budget's "transport" is roundTripMs minus the stages
  rate: number | null;             // frames per second over the last twenty
  options: ScannerOptions;
  sendPx: number;
  onOptions: (next: ScannerOptions) => void;
  onSendPx: (px: number) => void;
  onReset: () => void;
  onCapture: (expected: string) => Promise<string>;   // resolves to the saved file name, rejects with a sentence
}
export function ScannerPanels(props: ScannerPanelsProps): JSX.Element;

// panels/Panel.tsx
export function Panel(props: { id: ScannerPanelId | "match"; title: string; children: ReactNode }): JSX.Element;
// "match" is never folded; the five others read and write `scannerFolds`.
```

- [ ] **Step 1: Write the failing tests**

`src/features/scanner/ScannerPanels.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { PRISTINE_STORE } from "@/lib/store"; // if the store exports a pristine snapshot; else reset the two fields by hand
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import { ScannerPanels, type ScannerPanelsProps } from "./ScannerPanels";
import { STATUS, VERDICTS } from "./fixtures";

function props(over: Partial<ScannerPanelsProps> = {}): ScannerPanelsProps {
  return {
    status: STATUS.present,
    verdict: VERDICTS.voting,
    roundTripMs: 180,
    rate: 5.6,
    options: DEFAULT_SCANNER_OPTIONS,
    sendPx: DEFAULT_SEND_PX,
    onOptions: vi.fn(),
    onSendPx: vi.fn(),
    onReset: vi.fn(),
    onCapture: vi.fn(async () => "live-1.jpg"),
    ...over,
  };
}

beforeEach(() => {
  useAppStore.setState({ scannerFolds: { controls: false, pipeline: false, budget: false, rectified: false, readouts: false } });
});

describe("the match panel", () => {
  it("draws the vote rule's verdict, bar, tally, lead and standings", () => {
    render(<ScannerPanels {...props()} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("Plains — 2XM 373")).toBeInTheDocument();
    expect(within(match).getByText("voting")).toBeInTheDocument();
    expect(within(match).getByText("5.0/8 · 12f")).toBeInTheDocument();
    expect(within(match).getByText("×4.0")).toBeInTheDocument();
    expect(within(match).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "63");
    const rows = within(match).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Plains · 2XM 373");
    expect(rows[0]).toHaveTextContent("5.0");
  });

  it("says decided at the bar and fills it", () => {
    render(<ScannerPanels {...props({ verdict: VERDICTS.decided })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("decided")).toBeInTheDocument();
    expect(within(match).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(within(match).getByText("unopposed")).toBeInTheDocument();
  });

  it("keeps the confidence rule's words and percentage", () => {
    render(<ScannerPanels {...props({ verdict: VERDICTS.confidence })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("confirmed")).toBeInTheDocument();
    expect(within(match).getByText("80% over 12f")).toBeInTheDocument();
    expect(within(match).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
  });

  it("names the missing bundle and where it looked, in place of a verdict", () => {
    render(<ScannerPanels {...props({ status: STATUS.missing, verdict: VERDICTS.noCard })} />);
    expect(screen.getByText(`No reference bundle. Put \`card-hashes.bin\` at ${STATUS.missing.bundle.path}.`)).toBeInTheDocument();
  });

  it("resets and captures through its two buttons", async () => {
    const p = props();
    render(<ScannerPanels {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset evidence" }));
    expect(p.onReset).toHaveBeenCalledOnce();
    await userEvent.type(screen.getByRole("textbox", { name: "What it actually is" }), "Plains");
    await userEvent.click(screen.getByRole("button", { name: "Add frame to dataset" }));
    expect(p.onCapture).toHaveBeenCalledWith("Plains");
    expect(await screen.findByText("saved live-1.jpg")).toBeInTheDocument();
  });
});

describe("the folded panels", () => {
  it("start folded, open on their heading, and remember it in the store", async () => {
    render(<ScannerPanels {...props()} />);
    const heading = screen.getByRole("button", { name: "Controls" });
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("slider", { name: "decide at" })).not.toBeInTheDocument();
    await userEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("slider", { name: "decide at" })).toBeInTheDocument();
    expect(useAppStore.getState().scannerFolds.controls).toBe(true);
  });

  it("writes a slider and a segment through onOptions", async () => {
    const p = props();
    useAppStore.setState({ scannerFolds: { controls: true, pipeline: false, budget: false, rectified: false, readouts: false } });
    render(<ScannerPanels {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "confidence" }));
    expect(p.onOptions).toHaveBeenLastCalledWith({ ...DEFAULT_SCANNER_OPTIONS, rule: "confidence" });
    const slider = screen.getByRole("slider", { name: "decide at" });
    // `fireEvent.change` rather than typing: a range input has no caret.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(slider, { target: { value: "12" } });
    expect(p.onOptions).toHaveBeenLastCalledWith({ ...DEFAULT_SCANNER_OPTIONS, decide_at: 12 });
  });

  it("shows the budget's six stages and the readouts' two reads when open", () => {
    useAppStore.setState({ scannerFolds: { controls: false, pipeline: false, budget: true, rectified: false, readouts: true } });
    render(<ScannerPanels {...props({ verdict: VERDICTS.decided })} />);
    const budget = screen.getByRole("region", { name: "Frame budget" });
    for (const k of ["decode", "resize", "mask", "contour", "rectify", "transport"]) {
      expect(within(budget).getByText(k)).toBeInTheDocument();
    }
    expect(within(budget).getByText("180 ms")).toBeInTheDocument();
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getByText(/Storm of Saruman/)).toBeInTheDocument();
  });

  it("says the models are missing inside the readouts", () => {
    useAppStore.setState({ scannerFolds: { controls: false, pipeline: false, budget: false, rectified: false, readouts: true } });
    render(<ScannerPanels {...props({ status: STATUS.noModels })} />);
    expect(screen.getByText(/No OCR models\. Put/)).toBeInTheDocument();
  });
});
```

If the store does not export a pristine snapshot, drop that import; the `beforeEach` above resets the one field this suite touches.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/scanner/ScannerPanels.test.tsx`
Expected: modules missing.

- [ ] **Step 3: The store field**

In `src/lib/store.ts`, beside `keyMapOpen`:

```ts
/** The five developer panels on the Scanner view. `match` is never folded. */
export type ScannerPanelId = "controls" | "pipeline" | "budget" | "rectified" | "readouts";
```

in `AppState`:

```ts
  /**
   * Which of the Scanner's developer panels are open. **In the store, not in the view**, so a
   * reader who folded the pipeline out of the way and jumped to Settings finds it still folded
   * on the way back — the same reason `openDeckId` is parked here. Session state: no `app_meta`
   * row and no persist middleware, exactly as `keyMapOpen` above.
   */
  scannerFolds: Record<ScannerPanelId, boolean>;
  setScannerFold: (id: ScannerPanelId, open: boolean) => void;
```

initial `scannerFolds: { controls: false, pipeline: false, budget: false, rectified: false, readouts: false }` and `setScannerFold: (id, open) => set((s) => ({ scannerFolds: { ...s.scannerFolds, [id]: open } }))`. If the store has a `PRISTINE_STORE` or a reset helper the Storybook world restores from, add the field there too.

- [ ] **Step 4: `panels/Panel.tsx`**

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/cn"; // whatever `SettingsSection` uses; if the repo has no `cn`, join strings
import { useAppStore, type ScannerPanelId } from "@/lib/store";

/**
 * One section of the Scanner's column: the Settings panel chrome — heading, then a bordered
 * `bg-surface` body — with a fold on every panel but `match`.
 *
 * **The heading is the disclosure button**, `aria-expanded` on it and `aria-controls` to the
 * body, so a screen reader hears "Controls, collapsed, button" rather than a heading and an
 * unrelated toggle. The region keeps its `aria-labelledby` either way, so `getByRole("region",
 * { name })` finds a folded panel too — its body is simply not in the tree.
 */
export function Panel({ id, title, children }: { id: ScannerPanelId | "match"; title: string; children: ReactNode }) {
  const open = useAppStore((s) => (id === "match" ? true : s.scannerFolds[id]));
  const setFold = useAppStore((s) => s.setScannerFold);
  const headingId = `scanner-${id}-heading`;
  const bodyId = `scanner-${id}-body`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="font-heading text-lg leading-none">
        {id === "match" ? (
          title
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setFold(id, !open)}
            className="flex w-full items-center gap-2 text-left"
          >
            <span aria-hidden="true" className={cn("inline-block transition-transform motion-reduce:transition-none", open && "rotate-90")}>▸</span>
            {title}
          </button>
        )}
      </h2>
      {open && (
        <div id={bodyId} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          {children}
        </div>
      )}
    </section>
  );
}
```

Use the repo's chevron icon from lucide (`ChevronRight`, `size-4`) rather than the `▸` character, rotated the same way.

- [ ] **Step 5: `ScannerPanels.tsx` and the six panels**

`ScannerPanels.tsx` lays the six out in order — Match, Controls, Pipeline, Budget, Rectified, Readouts — in a `flex flex-col gap-4` and passes each what it reads:

```tsx
export function ScannerPanels(p: ScannerPanelsProps) {
  const rule = p.options.rule;
  return (
    <div className="flex flex-col gap-4">
      <MatchPanel status={p.status} verdict={p.verdict} rate={p.rate} onReset={p.onReset} onCapture={p.onCapture} />
      <ControlsPanel options={p.options} sendPx={p.sendPx} onOptions={p.onOptions} onSendPx={p.onSendPx} />
      {p.options.stages && <PipelinePanel stages={p.verdict?.stages ?? null} />}
      <BudgetPanel verdict={p.verdict} roundTripMs={p.roundTripMs} />
      <RectifiedPanel verdict={p.verdict} />
      <ReadoutsPanel status={p.status} verdict={p.verdict} rule={rule} />
    </div>
  );
}
```

`MatchPanel` — the rows, top to bottom, every value from `verdictText.ts` or the verdict:

| Element | Content |
| --- | --- |
| Head | `lead.label ? "${name} — ${SET} ${number}" : lead ? id.slice(0, 8) : "—"` in `font-heading`; beside it `verdictWord(tracked)` in a small pill: `bg-accent text-accent-fg` when committed, `bg-bg text-dim` otherwise; `bundleSentence(status)` **replaces** the head when non-null |
| Bar | `<div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(barFill * 100)} aria-label="Evidence">` — `h-2 rounded bg-bg overflow-hidden relative`, fill `h-full bg-accent transition-[width] motion-reduce:transition-none` at `barFill*100%` (`bg-dim` while not committed), and a 1px mark `absolute inset-y-0 w-px bg-dim` at `left: 70%` under `confidence` and `right: 0` under `votes` |
| `dl` rows | `votes` or `confidence` → `shareLine`; `lead` → `leadLine`; `distance ↓` → `${best.distance} / 256 bits` (warn class `text-accent` when `best.normalized > SURE_DISTANCE`); `margin` → `${match.margin} bits`; `orientation` → `rotated 180°` / `upright`; `cardness` → `${score.toFixed(2)} (t${title.toFixed(2)}/y${type_line.toFixed(2)})`; `trim l/t/r/b` → `${l}/${t}/${r}/${b}` when any is non-zero else `—`; `collector` → `collector.matched ?? "[raw] no printing"`; `lock` → `${phase} ${agree}/3` |
| Standings | `<ol>` of `<li>` `"${name} · ${SET} ${number}"` + `standingValue(s, rule)`, first row `text-text`, the rest `text-dim` |
| This frame | `this frame: ${best.label?.name ?? id} · d=${distance}` or `this frame: no match` / `no card`, `text-dim` |
| Rate | `${rate.toFixed(1)}/s` in `text-dim tabular-nums` |
| Buttons | `Reset evidence`; a text input labelled `What it actually is` (visually a placeholder, `aria-label` set) and `Add frame to dataset`, with a `role="status"` line that reads `saving…`, then `saved ${name}` or the rejection's sentence |

`dl` uses `grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm`, `dt` in `text-dim`, `dd` in `text-right tabular-nums`. Sets are upper-cased for display, as the page does.

`ControlsPanel` — three segments and seven sliders plus the send slider:

```tsx
function Segment<T extends string>({ label, value, choices, onChange }: { label: string; value: T; choices: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 rounded-lg bg-bg p-0.5">
      {choices.map((c) => (
        <button key={c} type="button" aria-pressed={c === value} onClick={() => onChange(c)}
          className="flex-1 rounded-md px-2 py-1 text-sm aria-pressed:bg-surface aria-pressed:text-text text-dim">
          {c}
        </button>
      ))}
    </div>
  );
}
```

with `Segment` for `rule` (`["votes", "confidence"]`), `method` (`["canny", "otsu", "both"]`) and `stages` (`["overlay only", "full stages"]` mapped to the boolean), then one `label.grid grid-cols-[76px_1fr_46px]` row per `SLIDERS` entry — `<input type="range" aria-label={label} …>` with `<output>` holding `format(value)` — and the `send px` slider from `SEND_PX`. Every change calls `onOptions({ ...options, [key]: Number(value) })` or `onSendPx`.

`PipelinePanel`: three `<figure>`s with `<img alt="mask">`, `contours`, `quad` from `stages` (data URIs), captions `02 mask`, `03 contours`, `04 quad`; shown only while `options.stages` is true (the parent gates it).

`BudgetPanel`: the six parts as the page computes them — `decode = decode_ms`, then `resize_ms`, `mask_ms`, `contour_ms`, `rectify_ms` from `timings`, `transport = max(0, roundTripMs − sum)` — a stacked bar of six `<i>` widths by share, a legend row per part (`name` in `text-dim`, `${v.toFixed(1)} ms` tabular) and a `round trip` row reading `${roundTripMs} ms` (`180 ms`).

`RectifiedPanel`: `<img alt="the rectified card">` from `verdict.rectified` in a fixed `w-[122px] h-[170px]` slot (empty slot text `no rectification` in `text-dim` when null), beside a `dl` of `aspect` (`score.aspect.toFixed(3)`), `frame area` (`(area_frac*100).toFixed(1)%`), `corner err` (`max_angle_error.toFixed(1)°`), `detector` (`method`), `geometry` (`score.via`), `dhash` (`hash.slice(0, 12)`).

`ReadoutsPanel`: `modelsSentence(status)` first when non-null; then OCR: `raw`, `normalized`, `rotated`, `${elapsed_ms.toFixed(0)} ms`, `matched` (or `no name`), `edits`, and the band image; then Collector: `raw`, `matched` (or `no printing`), the band image, and a `<ul>` of `tried` rows `"${SET} ${number} → ${matched ?? "—"}"` with a trailing `+${more} more pairings not shown` when `more > 0`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/scanner && npx tsc --noEmit && npx eslint src/features/scanner src/lib/store.ts`
Expected: pass, no lint warnings. Two lint rules that bite here: `text-muted` is refused by `tokens.test.ts`, and every `transition-*` needs its `motion-reduce:transition-none`.

- [ ] **Step 7: Panel stories**

`src/features/scanner/ScannerPanels.stories.tsx` — `title: "Scanner/Panels"`, `component: ScannerPanels`, `tags: ["autodocs"]`, a `w-80` decorator, and one story per fixture: `Voting`, `Decided`, `ConfidenceRule`, `NoMatch`, `NoCard`, `Panicked`, `BundleMissing` (`status: STATUS.missing`), `ModelsMissing` (`status: STATUS.noModels`, readouts open via a `beforeEach`/`play` that sets `useAppStore.setState({ scannerFolds: … })` — and therefore `docs: { story: { inline: false, height: "720px" } }` per `.storybook/CLAUDE.md`). Each story's `play` asserts one sentence from the test above (`decided`, `voting`, `confirmed`, the two missing-file sentences) with `within(canvasElement)`.

Run: `npx vitest run src/stories.test.tsx -t "Scanner"` — note `-t` matches the **file path**, so run the whole file if the filter selects nothing: `npx vitest run src/stories.test.tsx` and check the Scanner plays appear in the output.

- [ ] **Step 8: Commit**

```bash
git add src/lib/store.ts src/features/scanner
git commit -m "feat(scanner): the panel column, folded in the store, with its stories"
```

---

### Task 8: The camera half — stream, pump, overlay

**Files:**
- Create: `src/features/scanner/useCamera.ts`, `useScanLoop.ts`, `Overlay.tsx`, `useCamera.test.ts`, `useScanLoop.test.ts`

**Interfaces:**
- Consumes: `ipc.scannerFrame`, Task 6's `cameraSentence`, `DEFAULT_SCANNER_OPTIONS`.
- Produces:

```ts
// useCamera.ts
export type CameraState = { kind: "starting" } | { kind: "live"; width: number; height: number } | { kind: "error"; name: string; message: string };
export function useCamera(videoRef: RefObject<HTMLVideoElement | null>): CameraState;
// Constraints: { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }.
// One stop function; every track stopped exactly once on unmount; a `play()` rejection is swallowed as the QR scanner does.

// useScanLoop.ts
export interface ScanLoop { verdict: ScannerVerdict | null; roundTripMs: number | null; rate: number | null; error: string | null; grab: (longEdge: number, quality: number) => Promise<Uint8Array | null>; }
export function useScanLoop(args: { videoRef: RefObject<HTMLVideoElement | null>; live: boolean; options: ScannerOptions; sendPx: number }): ScanLoop;
// One request in flight; while it is, frames are dropped; a frame is grabbed at `sendPx` long edge, JPEG q0.72; `rate` is 1000 / mean of the last twenty round trips.

// Overlay.tsx
export function Overlay({ videoRef, verdict }: { videoRef: RefObject<HTMLVideoElement | null>; verdict: ScannerVerdict | null }): JSX.Element;
// A canvas sized to the video's pixels, redrawn every animation frame: `quad_raw` dotted `#e88` behind, `quad` solid `#5ed69a` 3px, a dot on corner 0.
```

- [ ] **Step 1: Write the failing tests**

`src/features/scanner/useCamera.test.ts`:

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "./useCamera";

function mediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}
afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("useCamera", () => {
  it("keys the refused camera on the DOMException name", async () => {
    mediaDevices(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const ref = createRef<HTMLVideoElement>();
    const { result } = renderHook(() => useCamera(ref));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(result.current).toEqual({ kind: "error", name: "NotAllowedError", message: "MTG Grimoire needs camera access to scan a card." });
  });

  it("stops every track exactly once on unmount", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    mediaDevices(() => Promise.resolve(stream));
    const video = document.createElement("video");
    Object.defineProperty(video, "play", { value: () => Promise.resolve() });
    Object.defineProperty(video, "videoWidth", { value: 1280 });
    Object.defineProperty(video, "videoHeight", { value: 720 });
    const ref = { current: video };
    const { result, unmount } = renderHook(() => useCamera(ref));
    await waitFor(() => expect(result.current.kind).toBe("live"));
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("asks for the environment camera at 1080p and no audio", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", "NotFoundError")));
    mediaDevices(getUserMedia);
    renderHook(() => useCamera(createRef<HTMLVideoElement>()));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  });
});
```

`src/features/scanner/useScanLoop.test.ts` — mock `@/lib/ipc` so `scannerFrame` is a `vi.fn` returning a deferred promise, give the hook a `grab` you control (inject it: `useScanLoop` takes an optional `grabFrame` for tests, defaulting to the canvas grab), and assert: (1) with one call pending, five ticks send nothing more — `scannerFrame` called once; (2) resolving it with `VERDICTS.voting` sets `verdict` and sends the next; (3) the header options are the ones passed in — `expect(scannerFrame).toHaveBeenLastCalledWith(bytes, options)`; (4) `rate` after three resolved round trips of 100/200/300 ms (fake timers) is `1000 / 200` within 1; (5) a rejection sets `error` to the sentence and the loop continues. Use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(16)` per tick; the loop's idle wait is 16 ms as the page's is.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/scanner/useCamera.test.ts src/features/scanner/useScanLoop.test.ts`
Expected: modules missing.

- [ ] **Step 3: `useCamera.ts`**

Port `QrScanner.tsx`'s effect (lines 70–135): the same `cancelled` flag, the same `stopAll` held in a ref so unmount and a later stop are one function, the same swallowed `play()` rejection; on success set `{ kind: "live", width: video.videoWidth, height: video.videoHeight }` once `loadedmetadata` has fired (listen for it, or read after `play()` resolves and fall back to a `loadedmetadata` listener when both are 0); on failure `{ kind: "error", ...cameraSentence(err) }`. State via `useState`, set only from the async callbacks — never inside the effect body.

- [ ] **Step 4: `useScanLoop.ts`**

```ts
export function useScanLoop({ videoRef, live, options, sendPx, grabFrame }: { …; grabFrame?: (video: HTMLVideoElement, longEdge: number) => Promise<Uint8Array | null> }): ScanLoop
```

- A single `useEffect` keyed on `live` starts a loop and cancels it on cleanup (`let stopped = false`).
- The loop: `while (!stopped) { if (inFlight || video.readyState < 2) { await sleep(16); continue; } const bytes = await grab(video, sendPxRef.current); if (!bytes) { await sleep(16); continue; } inFlight = true; const t0 = performance.now(); try { const v = await ipc.scannerFrame(bytes, optionsRef.current); push round trip; setVerdict(v); setError(null); } catch (e) { setError(ipcError(e)); } finally { inFlight = false; } }`.
- `options` and `sendPx` are read through refs updated on every render, so the loop never restarts on a slider drag.
- Default `grabFrame`: a module-level `canvas`, `scale = min(1, longEdge / max(videoWidth, videoHeight))`, `drawImage`, `toBlob("image/jpeg", 0.72)`, `new Uint8Array(await blob.arrayBuffer())`.
- `rate`: keep the last twenty round trips in a ref; `rate = 1000 / mean`.
- Also expose `grab` so the page's capture button can take a full-resolution frame at q0.92 through the same code (`grab(Infinity, 0.92)`).

- [ ] **Step 5: `Overlay.tsx`**

A `<canvas className="absolute inset-0 h-full w-full" aria-hidden="true">` positioned over the video; a `useEffect` that runs `requestAnimationFrame` continuously while mounted, sizing `canvas.width/height` to `video.videoWidth/videoHeight` when they change, clearing, and drawing the latest verdict's `quad_raw` (dotted, `#e88`, 1px) then `quad` (solid `#5ed69a`, 3px) and a 6px dot on corner 0 — read from a ref the parent updates, so the redraw never re-renders React. Cancel the frame on unmount.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/scanner && npx tsc --noEmit`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/scanner/useCamera.ts src/features/scanner/useCamera.test.ts src/features/scanner/useScanLoop.ts src/features/scanner/useScanLoop.test.ts src/features/scanner/Overlay.tsx
git commit -m "feat(scanner): the camera stream, the single-in-flight pump and the overlay"
```

### Task 9: `ScannerPage.tsx` — assembly, layout, sentences, the web dispatch

**Files:**
- Create: `src/features/scanner/ScannerPage.tsx`, `ScannerPage.test.tsx`
- Modify: `src/lib/useNarrowWindow.ts:13-30` (the doc names its second reader)

**Interfaces:**
- Consumes: Tasks 5–8. `useNarrowWindow()` from `@/lib/useNarrowWindow`, `isWebTarget()` from `@/pwa/target`, `useQuery` from `@tanstack/react-query` as the other pages use it (`queryKey: ["scanner", "status"]`, `queryFn: ipc.scannerStatus`, `staleTime: Infinity` — the status changes only when a file is placed, and a `Reload assets` button invalidates it).
- Produces: `export function ScannerPage(): JSX.Element` — the seventh view.

- [ ] **Step 1: Write the failing test**

`src/features/scanner/ScannerPage.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { WEB_SENTENCE } from "./verdictText";
import { STATUS } from "./fixtures";

vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  return { ...real, ipc: { ...real.ipc, scannerStatus: vi.fn(async () => STATUS.missing), scannerFrame: vi.fn(), scannerReset: vi.fn() } };
});
import { isWebTarget } from "@/pwa/target";
import { ScannerPage } from "./ScannerPage";

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ScannerPage /></QueryClientProvider>);
}

describe("ScannerPage", () => {
  it("says the web build has no detector and asks for no camera", () => {
    vi.mocked(isWebTarget).mockReturnValueOnce(true);
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    mount();
    expect(screen.getByText(WEB_SENTENCE)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();
  });

  it("shows the refused camera's sentence in place of the video, and the panels beside it", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: () => Promise.reject(new DOMException("x", "NotAllowedError")) },
      configurable: true,
    });
    mount();
    expect(await screen.findByText("MTG Grimoire needs camera access to scan a card.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Match" })).toBeInTheDocument();
    expect(await screen.findByText(/No reference bundle\. Put/)).toBeInTheDocument();
  });

  it("has an sr-only heading, because the ribbon carries the visible title", () => {
    mount();
    expect(screen.getByRole("heading", { level: 2, name: "Scanner" })).toHaveClass("sr-only");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/scanner/ScannerPage.test.tsx`
Expected: module missing.

- [ ] **Step 3: Write the page**

```tsx
/**
 * The Scanner view: the camera on the left, the tracker's verdict and the developer panels on
 * the right — the debug page, in the app's chrome.
 *
 * **Dispatched above the hooks.** On the web target there is no detector, so the whole view is
 * one sentence and nothing below this line runs: no camera is asked for, no command is called,
 * and no `useQuery` is conditional — `BackupPanel`'s shape, for `BackupPanel`'s reason.
 *
 * **The camera and the panels are two halves on purpose.** `useCamera` and `useScanLoop` own
 * the stream and the pump; `ScannerPanels` is pure and takes the latest verdict as a prop, so
 * it is tested from fixtures and storied without a camera, and a change to a panel never
 * touches the loop.
 *
 * **The second reader of `useNarrowWindow`.** A phone holds the camera above the verdict, not
 * beside it; the branch is the one the app already has, and its doc names this view.
 */
export function ScannerPage(): JSX.Element {
  return isWebTarget() ? <WebSentence /> : <LiveScanner />;
}

function WebSentence() {
  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="sr-only">Scanner</h2>
      <p className="text-dim">{WEB_SENTENCE}</p>
    </section>
  );
}

function LiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camera = useCamera(videoRef);
  const [options, setOptions] = useState<ScannerOptions>(DEFAULT_SCANNER_OPTIONS);
  const [sendPx, setSendPx] = useState(DEFAULT_SEND_PX);
  const status = useQuery({ queryKey: ["scanner", "status"], queryFn: ipc.scannerStatus, staleTime: Infinity });
  const loop = useScanLoop({ videoRef, live: camera.kind === "live", options, sendPx });
  const narrow = useNarrowWindow();

  const onReset = () => { void ipc.scannerReset(); };
  const onCapture = async (expected: string) => {
    const bytes = await loop.grab(Infinity, 0.92);
    if (bytes === null) throw new Error("no video yet");
    const t = loop.verdict?.tracked ?? null;
    const lead = t?.standings[0];
    const saved = await ipc.scannerCapture(bytes, {
      expected,
      reported: lead?.label?.name ?? "",
      confidence: t ? t.confidence.toFixed(3) : "",
      votes: lead ? lead.evidence.toFixed(2) : "",
      distance: loop.verdict?.match?.candidates[0]?.distance.toString() ?? "",
    });
    return saved.saved;
  };

  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="sr-only">Scanner</h2>
      <div className={narrow ? "flex min-h-0 flex-1 flex-col gap-4 overflow-auto" : "flex min-h-0 flex-1 gap-4"}>
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} muted playsInline className="h-full w-full object-contain" />
          <Overlay videoRef={videoRef} verdict={loop.verdict} />
          <div className="absolute left-3 top-3 rounded-full bg-bg/85 px-3 py-1 text-sm">{headline(loop.verdict)}</div>
          {camera.kind === "error" && (
            <p role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-dim">{camera.message}</p>
          )}
          <p className="absolute bottom-2 left-3 min-h-[2.5em] text-xs text-dim" aria-live="polite">
            {loop.verdict?.ok === false ? (loop.verdict.error ?? "") : loop.error ?? ""}
          </p>
        </div>
        <div className={narrow ? "shrink-0" : "w-80 shrink-0 overflow-auto"}>
          <ScannerPanels
            status={status.data ?? null}
            verdict={loop.verdict}
            roundTripMs={loop.roundTripMs}
            rate={loop.rate}
            options={options}
            sendPx={sendPx}
            onOptions={setOptions}
            onSendPx={setSendPx}
            onReset={onReset}
            onCapture={onCapture}
          />
        </div>
      </div>
    </section>
  );
}
```

The detector's own sentence sits in a reserved two-line strip under the video (the page's `#err`), emptied rather than hidden so the video's box never changes height. In `useNarrowWindow.ts`'s doc add one sentence: the Scanner is the second reader — a phone stacks the camera above the verdict — and it is the same branch, not a second one.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/scanner && npx tsc --noEmit && npx eslint src/features/scanner`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/scanner/ScannerPage.tsx src/features/scanner/ScannerPage.test.tsx src/lib/useNarrowWindow.ts
git commit -m "feat(scanner): the Scanner view — camera beside the verdict, a sentence on the web"
```

---

### Task 10: The seventh view — nav, chord, router

**Files:**
- Modify: `src/lib/store.ts:18` (`ViewId`), `src/components/nav.ts:1-2,32-39`, `src/App.tsx:25-47`, `src/lib/shortcuts.ts:92-104,136-141`, `src/components/nav.test.ts:10`, `src/lib/shortcuts.test.ts:421-431`, `docs/reference/keyboard-shortcuts.md` (every `Ctrl+1…6` and the Settings row)

**Interfaces:**
- Consumes: Task 9's `ScannerPage`.
- Produces: `ViewId` includes `"scanner"`; `NAV[5]` is Scanner; `switchView.chords` has seven.

- [ ] **Step 1: Update the two census tests first**

`nav.test.ts:10`: `expect(ids).toEqual(["search", "tags", "decks", "collection", "wishlist", "scanner", "settings"]);`
`shortcuts.test.ts:421-431`: the title becomes `"gives switchView one chord per rail entry, Ctrl+1 through Ctrl+7"` and the array gains `["Ctrl", "7"]`.

Run: `npx vitest run src/components/nav.test.ts src/lib/shortcuts.test.ts`
Expected: both fail on the missing seventh.

- [ ] **Step 2: Add the view**

`store.ts:18`: `export type ViewId = "search" | "tags" | "collection" | "wishlist" | "decks" | "scanner" | "settings";` and fix the doc line above it ("The seven top-level destinations").

`nav.ts`: import `ScanLine` from `lucide-react` and insert `{ id: "scanner", label: "Scanner", Icon: ScanLine },` before the Settings entry, with a comment: before Settings so Settings stays the last row; the chord that moved is `Ctrl+7`, and the doc says so.

`shortcuts.ts`: a seventh chord `{ key: "7", ctrl: true },` and `scanner: [],` between `wishlist` and `settings`; update the "Six chords in `NAV` order" and "the six views" sentences to seven.

`App.tsx`: `if (activeView === "scanner") return <ScannerPage />;` before the Settings line, with `import { ScannerPage } from "@/features/scanner/ScannerPage";`.

- [ ] **Step 3: Run the census, the shortcuts, the shell and the app tests**

Run: `npx vitest run src/components src/lib/shortcuts.test.ts src/App.test.tsx && npx tsc --noEmit`
Expected: pass. `SHORTCUTS` is a total record, so the compiler names any scope you forgot.

- [ ] **Step 4: The keyboard doc**

In `docs/reference/keyboard-shortcuts.md`, every `Ctrl+1…6` becomes `Ctrl+1…7`; the rail table (if one lists the digits) gains Scanner at 6 and Settings at 7; add one dated line: on 2026-09-08 the Scanner took the slot before Settings, so Settings moved from `Ctrl+6` to `Ctrl+7` — chords bind by index into `NAV`, which is the design working.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts src/components/nav.ts src/App.tsx src/lib/shortcuts.ts src/components/nav.test.ts src/lib/shortcuts.test.ts docs/reference/keyboard-shortcuts.md
git commit -m "feat(shell): a Scanner view in the rail, Ctrl+6, and Settings on Ctrl+7"
```

---

### Task 11: Storybook — the fake's handlers and the page stories

**Files:**
- Modify: `.storybook/fake/db.ts` (`Fault` union at `:1032`; a `scannerHandlers(db)` beside `pluginHandlers()` at `:15509`; `allHandlers` at `:15553`)
- Create: `src/features/scanner/ScannerPage.stories.tsx`
- Modify: `.storybook/CLAUDE.md` (the fault list, one line)

**Interfaces:**
- Consumes: Tasks 6 and 9; `FakeDb.fault`.
- Produces: fake commands `scanner_status`, `scanner_frame`, `scanner_reset`, `scanner_capture`; fault `"scannerMissing"`.

- [ ] **Step 1: The handlers**

In `db.ts`, add `| "scannerMissing"` to `Fault` with the doc: *the three scanner assets are absent and `scanner_status` names their paths — not a failure, the state every installation is in until a reader places the files.* Then:

```ts
/**
 * The scanner's four commands. **No store**: nothing here mirrors a table, and a Storybook
 * has no camera, so `scanner_frame` answers the decided fixture whatever bytes it is handed
 * and the panel stories are driven from fixtures directly.
 */
export function scannerHandlers(db: FakeDb) {
  return {
    /** `scanner::scanner_status`. */
    scanner_status: (): ScannerStatus => (db.fault === "scannerMissing" ? STATUS.missing : STATUS.present),
    /** `scanner::scanner_frame`. */
    scanner_frame: (): ScannerVerdict => VERDICTS.decided,
    /** `scanner::scanner_reset`. */
    scanner_reset: (): void => undefined,
    /** `scanner::scanner_capture`. */
    scanner_capture: (): ScannerCaptured => ({ saved: "live-1757300000.jpg" }),
  } satisfies Record<string, CommandHandler>;
}
```

with `import { STATUS, VERDICTS } from "@/features/scanner/fixtures";` (the fake already imports from `src/` — check an existing import for the alias it uses) and `...scannerHandlers(db),` in `allHandlers`. In `.storybook/CLAUDE.md`'s fault list add `scannerMissing`.

- [ ] **Step 2: The page stories**

`src/features/scanner/ScannerPage.stories.tsx` — `title: "Scanner/Page"`, `component: ScannerPage`, `tags: ["autodocs"]`, the `h-[640px] w-[1032px]` decorator, and:

- `CameraRefused`: default fake; `play` waits for `MTG Grimoire needs camera access to scan a card.` — Storybook's browser has no camera grant and `getUserMedia` rejects, so this is the page's own path, not a mock.
- `AssetsMissing`: `parameters: { fake: { fault: "scannerMissing" } }`; `play` waits for `No reference bundle. Put`.
- `WebBuild`: mocks `@/pwa/target` through the story's own `beforeEach` if the workbench allows it, else it is a test-only case already covered in Task 9 — say so in the story file rather than ship a story that cannot mock.

- [ ] **Step 3: Run the story plays and the two type-checks**

Run: `npx vitest run src/stories.test.tsx && npx tsc -p .storybook --noEmit`
Expected: every play passes, the Scanner ones included.

- [ ] **Step 4: Commit**

```bash
git add .storybook/fake/db.ts .storybook/CLAUDE.md src/features/scanner/ScannerPage.stories.tsx
git commit -m "test(scanner): fake the four commands, and story the page's two honest states"
```

### Task 12: The record — reference doc, three `CLAUDE.md` rows, the old spec

**Files:**
- Modify: `docs/reference/card-scanner.md` (its final `## App integration` section), `CLAUDE.md` (the reference table), `src-tauri/CLAUDE.md`, `src/CLAUDE.md`, `docs/superpowers/specs/2026-09-01-card-scanner-design.md:246-251` (§13)

**Interfaces:** none — prose. Every number quoted must be one a task above recorded, with its date and build.

- [ ] **Step 1: The reference doc's app section**

Replace the one-sentence `## App integration` with the record of Tasks 2–11: the dependency line and why it is non-wasm; the profile overrides and the measured reason; `data/scanner/` and the three paths; the four commands and the two body shapes with the Android sentence from Tauri's doc; the `Session` shared with the debug server and the key census that fences it; the view's file map; the fold state in the store; Scanner at `Ctrl+6` and Settings' move; the web sentence; the Storybook fault. Add a `### Measured in the app` table with the four numbers Task 13 records, and add to "Bugs still open" whatever Task 13 leaves open.

- [ ] **Step 2: The three rule files**

`CLAUDE.md` reference table, one row: `| [card-scanner.md](docs/reference/card-scanner.md) | The crate, the pipeline and every measurement behind it, the three evidence tiers and their weights, both tracker verdicts and the failures that shaped them, the debug server and how to drive it without a camera, and the app's Scanner view |`.

`src-tauri/CLAUDE.md`, a short section "Card scanner": the crate is a path dependency in the non-wasm block and never in the wasm one; the `[profile.dev.package.*]` overrides live in this manifest because cargo reads profiles from the build root only; `data/scanner/` and what a missing file means (a session with no reference, never an error); `scanner_frame` is the one command that takes a raw body, and on Android the same command takes base64 in JSON; the label load is the seventh connection and is dropped after the load; the scanner's state is `app.manage`d beside `AppState`, not inside it.

`src/CLAUDE.md`, in the platform section: the Scanner is `useNarrowWindow`'s second reader and `isAndroid`'s third, with the one-sentence reason from the spec for each; the vote-rule folds live in the store; `ipc.scannerFrame` is the one wrapper that passes a `Uint8Array` and headers, and `Core.call` widened for it.

- [ ] **Step 3: The old spec's §13**

In the 2026-09-01 spec, remove "App integration: commands, a scanner page, the provisional mark on a collection row." and add: "App integration landed 2026-09-08 — `2026-09-08-scanner-in-app-design.md`. The provisional mark on a collection row is still not in any pass."

- [ ] **Step 4: Re-count anything you wrote a number for**

The rule in `CLAUDE.md`: a prose-only edit routes to neither CI job. Every count in the three rule files (seven views, four commands, seven chords) is re-read against the code in the same commit.

- [ ] **Step 5: Commit**

```bash
git add docs/reference/card-scanner.md CLAUDE.md src-tauri/CLAUDE.md src/CLAUDE.md docs/superpowers/specs/2026-09-01-card-scanner-design.md
git commit -m "docs(scanner): record the app integration, and the rules it binds"
```

---

### Task 13: Live verification, the four measurements, verify

**Files:**
- Modify: `docs/reference/card-scanner.md` (the `### Measured in the app` table), `src-tauri/Cargo.toml` (the `rten` override, added or explicitly not)

This task runs in the session, not in a subagent: it takes the app lock, drives the real window, and runs the one `npm run verify`.

- [ ] **Step 1: Place the assets**

Copy `.scanner-bundle/card-hashes-v5.bin` to `src-tauri/target/debug/data/scanner/card-hashes.bin` and `.scanner-bundle/models/*.rten` to `src-tauri/target/debug/data/scanner/models/` (the dev data dir; create the folders). Keep a note that a fresh worktree's `data/` is a fresh install — the memory `prove-a-migration-on-the-real-dev-db` applies to assets too.

- [ ] **Step 2: Run the app and open the view**

Follow the `running-the-app` skill (the lock, `npm run tauri dev`). Press `Ctrl+6`; the ribbon reads *Scanner*. Over CDP (`scripts/cdp.mjs`, per `docs/reference/live-ui-verification.md`) read: the Match region's head, the `progressbar`'s `aria-valuenow` climbing, the rate, and the frame budget's rows. Hold a card in the webcam. Expected: `voting` then `decided`, frozen, `misses` 0 while the card stays; press *Reset evidence* and watch the tally restart.

- [ ] **Step 3: Measurement 1 — IPC cost per frame (release)**

Build release: `npm run tauri build -- --debug` is not release; use `npm run tauri build` once, run the built exe with the same `data/scanner/` beside it, and read the Budget panel's `transport` row over twenty frames (the debug page's HTTP figure was 62.6 ms). Record: `transport` mean and the round trip mean, release, with the frame size (`send px` 960).

- [ ] **Step 4: Measurement 2 — frame time under `tauri dev`**

Back on `npm run tauri dev`, read the same rows. If the round trip is over ~600 ms and the OCR frames (every fourth, visible as a spike) are over ~1.5 s, add to `src-tauri/Cargo.toml`:

```toml
[profile.dev.package.rten]
opt-level = 3
[profile.dev.package.rten-tensor]
opt-level = 3
[profile.dev.package.rten-imageproc]
opt-level = 3
```

(the crate names under `rten` come from `cargo tree -p card-scanner -i rten` — list the ones that exist), rebuild and read again. Record both readings; remove the plan's "added after the measurement" clause from the manifest comment and state what was decided.

- [ ] **Step 5: Measurement 3 — the phone (optional, recorded either way)**

If a device is on `adb`: `npm run tauri android dev` per `docs/reference/android-target.md`, place the assets under the app's data dir (`adb push`), open Scanner. Record: whether the camera opened unaided or needed the tap, and one frame's round trip with the base64 body. If no device, record "not driven on a phone this pass" in the doc — a sentence, not a guess.

- [ ] **Step 6: Measurement 4 — the label load**

Add a one-line `eprintln!` timing around `reference.load_labels` in `scanner::load` for this measurement only (or read it from a `std::time::Instant` in a debug log the module keeps), run `scanner_status` once from the console over CDP (`await import('/src/lib/ipc.ts').then(m => m.ipc.scannerStatus())` — see the memory `reach-a-module-singleton-over-cdp`), record the seconds and the labels count, and remove the timing line before committing.

- [ ] **Step 7: Record, verify, commit**

Write the four numbers into `docs/reference/card-scanner.md`'s `### Measured in the app` table, each with date and build. Then, once, with nothing else running:

Run: `npm run verify`
Expected: green across build, lint, vitest, both cargo suites. Then `cargo fmt --check --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` — CI runs both and verify runs neither.

```bash
git add docs/reference/card-scanner.md src-tauri/Cargo.toml
git commit -m "docs(scanner): the four measurements the app integration owed"
```

Then ship per the `shipping-a-branch` skill.

---

## Self-review against the spec

- **§4 dependency, overrides, verify** → Task 2 and Task 13 step 4.
- **§5 Session, FrameOptions, Verdict, thin serve, panic guard, cadence, previews, key census** → Task 1.
- **§6 state, lazy load, seventh connection, four commands, two body shapes, capture names** → Task 3.
- **§7 nav, shortcuts, files, layout, chrome, sentences, ipc types and wrappers, Core widening, isAndroid** → Tasks 4, 5, 6, 7, 8, 9, 10.
- **§8 Storybook** → Tasks 7 (panels) and 11 (page, fault, handlers).
- **§9 fences** → nav.test/shortcuts.test (10), ipc arg cases and snake mirrors (5), useScanLoop/useCamera (8), ScannerPanels (7), verdictText (6), scanner::tests (3), session::tests (1), route census (the four commands are never routed — nothing to add; the `browser.test` case in Task 4 is the fence), stories.test (11), the page check (1).
- **§10 platforms** → desktop throughout; Android body in 3 and 5; web dispatch in 9 and refusal in 4.
- **§11 documents** → 10 (keyboard doc) and 12.
- **§12 measurements** → 13.
- **§13 not in this pass** → nothing above adds a download, a collection write, a filter or wasm.

Type names used across tasks: `FrameOptions`/`Verdict`/`Session` (1, 3, 5), `ScannerStatus`/`Asset`/`Sidecar`/`Captured` (3, 5), `CallArgs`/`CallOptions`/`RAW_CALL_UNAVAILABLE` (4, 5, 6), `ScannerOptions` and the verdict mirrors (5 → 6, 7, 8, 9, 11), `DEFAULT_SCANNER_OPTIONS`/`DEFAULT_SEND_PX`/`SLIDERS`/`SEND_PX` (6 → 7, 9), `ScannerPanelsProps` (7 → 9), `useCamera`/`useScanLoop`/`Overlay` (8 → 9), `ScannerPage` (9 → 10, 11), `scannerFolds`/`ScannerPanelId` (7 → 11's play). No placeholders remain: every step names its files and shows its code or its exact rows.

