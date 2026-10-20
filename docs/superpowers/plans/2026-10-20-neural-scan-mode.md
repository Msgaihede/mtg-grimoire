# Neural scan mode — plan

**Goal**: a third scanner mode, **Neural**, beside Fast and Exact, on all three hosts (desktop,
Android, web), so readers can try it before it replaces both. It is our own two-CNN recogniser
(the scanner lab's write-up, `E:\mtg-scanner\docs\neural-scanner.md` §4.3: 95.2 % card ✓, 0 wrong on the 124 readers' scans), moved
out of the spike into a crate of its own with its model files **in git**.

Owner's decisions (2026-10-20): all three hosts in this cut; the gallery lives in git with the
models (rebuilt and committed when a set comes out); desktop and Android **build the files in**;
the web fetches them from the app origin on first use of the mode.

## The contract

### 1. `crates/card-neural` (new, workspace member, fmt/clippy clean)

The spike's runtime only — no Quickdraw or oracle code, no `std::time`, no threads, no
`std::fs` outside the `cli` feature. Package `card-neural`, lib `card_neural`.

```text
crates/card-neural/
  Cargo.toml            rten 0.26, rten-tensor 0.26, serde, serde_json, thiserror
                        features: bundled (include_bytes! of models/), cli (bins: clap, image)
  CLAUDE.md
  models/
    detector.onnx       2.4 MB  — our detector (spike run det-a, step 30 000)
    embedder.onnx       10.6 MB — our embedder (spike run qd-mnv4-e, run 2)
    gallery.bin         ~14 MB  — CNGALLR1: int8 rows + per-row scale + index (below)
    neural.json         input sizes, decode constants, thresholds, ranking
    README.md           provenance, sha256, how each file is rebuilt
  src/ lib.rs frame.rs detect.rs embed.rs gallery.rs meta.rs scanner.rs session.rs
       bin/build_gallery.rs (cli)
```

API (what `card-scanner` calls):

As built (the crate's own docs are the reference):

```rust
pub struct Files<'a> { pub detector: Cow<'a, [u8]>, pub embedder: Cow<'a, [u8]>, pub gallery: Cow<'a, [u8]>, pub meta: Cow<'a, [u8]> }
#[cfg(feature = "bundled")] pub fn bundled() -> Files<'static>;
#[cfg(feature = "cli")] pub fn read_dir(dir: &Path) -> io::Result<Files<'static>>;

impl Recognizer {
    pub fn load(files: Files<'_>) -> Result<Recognizer, Error>;   // owned bytes move in, borrowed ones are copied once
    pub fn gallery(&self) -> &Gallery;
    pub fn meta(&self) -> &Meta;
    pub fn read(&mut self, frame: &Frame, admit: Option<&Admit>) -> Result<Read, Error>;
}
impl Frame { pub fn new(width: usize, height: usize, rgb: Vec<u8>) -> Result<Frame, Error>; }   // RGB, rows top to bottom
pub struct Read { pub cards: Vec<Found>, pub accepted, supported, instant, weak, present: bool, pub detector_runs, crops: usize }
// Found: detection {score, quad, flip}, quad, flipped, scored {entry, card, score, margin, twins},
//        top: Vec<(u32, f32)> (the search's best looks, best first), accepted, prominence, aimed

impl Agreement {                                 // Default: required 2, support 3, ages in ms, forget_after 5
    pub fn observe(&mut self, read: &Read, now_ms: f64) -> bool;   // true on a deciding frame
    pub fn decision(&self) -> Option<&Decision>;                    // {entry, card, score, twins, how}
    pub fn decisions(&self) -> usize;                               // moves on each new decision
    pub fn votes(&self) -> (usize, usize);                          // (held, of which accepted)
    pub fn absent(&self) -> u32;                                    // frames running with no card
    pub fn reset(&mut self);
}

impl Gallery {
    pub fn len(&self) -> usize;
    pub fn printing(&self, entry: u32) -> &[u8; 16];                        // the pictured printing
    pub fn covers(&self, entry: u32) -> impl ExactSizeIterator<Item = &[u8; 16]>;  // pictured first
    pub fn card(&self, entry: u32) -> u32;                                  // card group
    pub fn name(&self, entry: u32) -> &str;
    pub fn admit(&self, permits: impl Fn(&[u8; 16]) -> bool) -> Admit;      // a look passes when any cover does
}
```

**Thresholds shipped**: the spike's cross-validated choice for our pair — Quickdraw's thresholds
shifted Δs −0.025 (score bars) and scaled k 0.375 (margins) — and `"ranking": "aimed"`.

**`gallery.bin` (CNGALLR1)**, little-endian: magic `CNGALLR1`, `u32 n`, `u32 dim`, `u32 covers`;
`n × f32` row scales; `n × dim × i8` rows (value × scale ≈ the unit-length row); `n × 16` pictured
printing ids; `n × u32` card groups; `n × u8` faces (0 front, 1 back); `(n + 1) × u32` cover
offsets; `covers × 16` cover ids; `u32 bytes` + UTF-8 names joined by `\n`. Built by
`build-gallery` from the spike's `gallery.head.matrix` + `gallery.json`. int8 rows were measured
on the replay: every one of 2 336 frames' best card unchanged (fp16 the same), cross-validated
totals identical.

### 2. `card-scanner` — feature `neural`

- `ScanMode::Neural` (serialised `"neural"`), default still Fast. `pub use card_neural as neural;`
  under the feature. Without the feature the variant still parses (so prefs and labels survive)
  and a Neural frame is `Verdict::failed(NEURAL_UNAVAILABLE_ERROR, …)`.
- `Session::load_neural(&mut self, files: neural::Files<'_>) -> Result<(), String>` and
  `Session::has_neural() -> bool`. Not a `Session::new` parameter.
- `frame_inner` in Neural: decode as now, `rgb_of`, `Recognizer::read` with the filters' admit
  (rebuilt when the mask changes), `Agreement::observe` with a session clock (`host::Stopwatch`
  started at load; never `Instant`), then a `Verdict`:
  - `quad`/`quad_raw`: the first card's quad; `method: Some("neural")`; `lock: None`;
    `wants_detail: false`; no OCR fields.
  - `match`: `MatchReport { section: Card, rotated: flipped, view: 0, views: 1, hashes: crops,
candidates, margin, hash_ms, search_ms }` — each candidate one of the best card's `top`
    entries as its pictured printing, **`normalized = (1 − cosine) / 2` clamped to [0, 1] and
    `distance = round(normalized × 256)`**, so every reader of `distance` (the panels, the scan
    inbox's 0–256 bits) still holds; `margin = round(margin_cos × 128)` bits.
  - `tracked`: `committed` while a decision stands; `confidence` = votes over what deciding takes
    (1 when committed); `rule: Votes`; `decide_at: 2`; `standings`: the counted card.
  - **The decision**: a new one bumps `decision_seq` once. The printing is the look's pictured
    printing when the filters admit it, else its first admitted cover. A look whose admitted
    covers are more than one is `Outcome::Ambiguous` with those covers as `choices` (decided one
    first, `distance: Some(normalized)`); otherwise `Resolved` with no choices. Labels, oracle
    id and finishes from the `Reference` when there is one (none otherwise); `finish_mark: None`.
  - **A stretch break** (5 frames running with no card at or over `detAccept`) forgets the
    standing decision, so the same card shown again adds again; `replaces_previous` follows the
    existing `previous_card` rule (a switch from Fast/Exact to Neural on the same card replaces).
- Every `match` on the mode gains its arm; `serve.rs`/`live.html` learn `neural`;
  `replay.rs` labels parse `neural`; the replay binary can run the Neural pass with label times.

### 3. `grimoire-core` and the native hosts

- `card-scanner` with `["corpus", "ocr", "neural"]`.
- `Embedded { bundle, models, neural: Option<card_scanner::neural::Files<'static>> }`; `load()`
  calls `Session::load_neural`; `ScannerStatus` gains **`neural: Asset`** (source `Embedded` when
  built in, `Absent` when not; an error sentence when it failed to load).
- Desktop `scanner::compiled()` and the Android host carry `card_neural::bundled()` (direct dep
  `card-neural = { path, features = ["bundled"] }`); the engine's WASM module must not grow
  (`scripts/build-wasm.ts`' ceiling).

### 4. Web

- `crates/grimoire-scan`: `card-scanner` with `["ocr", "neural"]`; a seventh export
  `load_neural(detector, embedder, gallery, meta) -> Option<String>` (an error sentence, never a
  throw); `build-wasm.ts`' export list.
- The files are served from the app origin at `/scanner-neural/` (`detector.onnx`,
  `embedder.onnx`, `gallery.bin`, `neural.json`), copied from `crates/card-neural/models/` by the
  web build — each under Cloudflare's 25 MiB a file. The page fetches them the first time a
  Neural frame is due, posts them to the Worker once, and the composed `ScannerStatus.neural`
  says `store`/loaded.

### 5. UI

- `ScanMode = "fast" | "exact" | "neural"`; `SCAN_MODES` gains
  `{ id: "neural", label: "Neural", hint: "…" }` (a "new, try it" hint); every picker (desktop
  `ScanBar`, phone `ScanControls` — its rounding assumes two — and `OptionsSheet`) draws three.
- `matchStrip`, the fake (`packages/fake/scannerScript.ts`), stories and tests learn the third
  mode. `ScannerStatus.neural` mirrored in `packages/ui/lib/ipc/scanner.ts`.

### 6. Proof

- `cargo test` for `card-neural` (workspace), `card-scanner --features cli,neural`.
- The card-scanner replay's Neural pass on the 124 readers' scans must land where the spike's
  replay did for this pair (≈ 93–96 % card ✓, 0–1 wrong); the numbers go in the docs.
- `pnpm verify` once at the end; the web and phone pickers seen live.
