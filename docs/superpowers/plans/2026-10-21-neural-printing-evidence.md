# Neural printing evidence (set symbol + collector band) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once Neural has decided a card, choose among that card's printings with two new small
networks — one on the set symbol crop, one on the collector band crop — over a candidate list
widened by a lower whole-card bar, deciding one printing only when the evidence is sure.

**Architecture:** `card-neural` gains an optional second file set (two crop embedders + two
`CNGALLR1` galleries keyed by printing) and a pure `narrow` rule; `card-scanner`'s Neural mode
keeps a per-card buffer of voting frames' embeddings and, on a new decision, widens and narrows
the printings. Without the evidence files every decision is exactly today's. The networks are
made and tuned in the scanner lab (`E:\mtg-scanner`), then shipped to every host and added to
the monthly retraining.

**Tech Stack:** Rust (`rten` 0.26, `card-neural`, `card-scanner`, `grimoire-core`,
`grimoire-scan` WASM), TypeScript (web Worker loader, replay scripts), Python 3.10 + PyTorch +
timm (lab and `crates/card-neural/train/`), Modal.

**Spec:** [`docs/superpowers/specs/2026-10-21-neural-printing-evidence-design.md`](../specs/2026-10-21-neural-printing-evidence-design.md)
— read it before any task; this plan argues from it.

## Global Constraints

- **Card identity untouched:** the whole-card match, its thresholds and `card_neural::Agreement` do not change. Nothing here may change *which card* is decided.
- **The floor:** wrong cards and *resolved wrong printings* on the replay no higher than today's Neural pass (measured in Task 1). A wrong printing is worse than a pick in the tray.
- **No delay:** the decision arrives on the same frame as today. Neural never asks for a detail frame (`wants_detail` stays false); crops come from the ordinary frame.
- **Without evidence files, exactly today:** `neural_decision`'s output is byte-identical to today's when no evidence is loaded, or `neural.json` has no `evidence` section.
- **No new UI and no IPC change:** `DecisionView`, `ChoiceView` and `packages/ui/lib/ipc/*` keep their fields. Choices are ordered best first by the evidence.
- **Browser Worker rules** (`crates/card-neural/CLAUDE.md` §2): no clock, threads or files outside `cli`; bytes in through `Cow`s.
- **Each served file ≤ 25 MiB** (`HOST_FILE_LIMIT`), each with a row in `crates/card-neural/models/README.md`'s table (bytes, `head8…tail8` of the sha256).
- **Size target** (Claude's call, from the design's ~40 MB estimate): each crop network ≤ 3 MB; the evidence files together ≤ 20 MB.
- **Only our own weights**, trained on Scryfall images. Nothing from `E:\mtg-scanner\data\quickdraw\`.
- **Test set:** the 124 readers' scans up to 2026-10-15 are never trained on; thresholds are tuned on them by grouped cross-validation only. The newer scans are neither trained nor tuned on in this work — they are the owner's merge gate (Task 13).
- **Monthly retraining ≤ $10 a run** (`budget.HARD_LIMIT_USD`).
- **Lab first:** networks, crop boxes and thresholds are found in `E:\mtg-scanner`; only the production recipe lands in `crates/card-neural/train/`.
- **Testing:** run only the task's own tests while working (repo `CLAUDE.md`); `pnpm verify` once, in Task 13.
- **Commits:** Conventional Commits, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A candidate printing newer than the evidence galleries** (no symbol or band row — a set released after the files were built) must never be ruled out and must block a single-printing decision. → Task 3, `a_candidate_with_no_evidence_row_is_kept_and_blocks_a_decision`.
2. **Filters that admit only some of the card's printings**, including filtering out the decided look's pictured printing: candidates are only admitted printings, and a lone admitted candidate is resolved. → Task 6, `the_filters_limit_the_widened_candidates`.
3. **A double-faced card read on its back face** is compared with back-face band rows, never front-face ones. → Task 4, `a_back_face_is_compared_with_back_face_rows_only`.
4. **Evidence still downloading on the web, or absent** — the decision is exactly today's. → Task 6, `without_evidence_the_decision_is_todays`.
5. **The reader switches cards between voting frames** (a vote for another card, or the votes reset): the old card's frames must not leak into the new card's evidence. → Task 6, `a_vote_for_another_card_clears_the_evidence_frames`.

---

## Phase 1 — the repo, measurable with no new networks

### Task 1: The replay counts what the floor and the bar are read on

**Files:**
- Modify: `crates/card-scanner/src/replay.rs` (beside `score`, ~line 133)
- Modify: `crates/card-scanner/src/bin/replay.rs` (`PassOut` ~304, its fill ~488)
- Modify: `scripts/scanner-replay/results.ts`, `scripts/scanner-replay/summary.ts`
- Test: `crates/card-scanner/src/replay.rs` tests, `scripts/scanner-replay/summary.test.ts`

**Interfaces:**
- Produces: `pub enum Settled { RightPrinting, WrongPrinting, Ambiguous, Other }` and
  `pub fn settled(score: Score, ambiguous: bool) -> Settled` in `replay.rs`;
  `PassOut { settled: Settled, choices: usize, .. }` serialised as `"settled"`
  (`"right_printing" | "wrong_printing" | "ambiguous" | "other"`) and `"choices"`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_resolved_decision_settles_right_or_wrong_and_an_ambiguous_one_never_does() {
    assert_eq!(settled(Score::Printing, false), Settled::RightPrinting);
    assert_eq!(settled(Score::Card, false), Settled::WrongPrinting);
    assert_eq!(settled(Score::Printing, true), Settled::Ambiguous, "a right first choice is not a settled printing");
    assert_eq!(settled(Score::Card, true), Settled::Ambiguous);
    assert_eq!(settled(Score::Wrong, false), Settled::Other);
    assert_eq!(settled(Score::Undecided, false), Settled::Other);
}
```

In `summary.test.ts`: a fixture with passes `{settled: "right_printing"}`, `{settled: "wrong_printing"}`, two `{settled: "ambiguous", choices: 3}` and `{…, choices: 28}` renders columns **resolved right** = 1, **resolved wrong printing** = 1, **ambiguous** = 3, **median choices** = 3, **mean choices** = 11.3.

- [ ] **Step 2:** `cargo test -p card-scanner --lib replay::` and `pnpm vitest run scripts/scanner-replay/summary.test.ts` — both FAIL (no `settled`, no columns).
- [ ] **Step 3:** Implement `settled`; set `out.settled` and `out.choices = d.choices.len()` where `ambiguous` is set (bin/replay.rs ~488); extend the results type and the summary table (columns after `ambiguous`). Update the key-set assertion at bin/replay.rs ~1467 to include `"settled"` and `"choices"`.
- [ ] **Step 4:** Re-run both — PASS.
- [ ] **Step 5: Measure today's baseline.** Run the replay over the 124 scans per `docs/reference/card-scanner.md` §10 *The replay* (`pnpm scanner:replay`; corpus `D:\Code\mtg-grimoire\.scanner-corpus`). Write the Neural pass's card ✓, wrong, resolved right, resolved wrong printing, ambiguous, median/mean choices and `true_in_choices` count into a new section **Baseline** at the end of this plan. **Resolved wrong printing here is the floor.**
- [ ] **Step 6: Commit** — `feat(scanner): replay counts settled printings and choices per decision`

### Task 2: `card-neural` keeps the frame's fingerprint and indexes a card's looks

**Files:**
- Modify: `crates/card-neural/src/scanner.rs` (`Found`, `Recognizer::fingerprint`)
- Modify: `crates/card-neural/src/gallery.rs` (`Gallery`, `from_bytes`)
- Test: same files' `mod tests`

**Interfaces:**
- Produces: `Found.embedding: Vec<f32>` (the winning view's unit vector, `meta.embedder.dim` long);
  `Gallery::looks_of(&self, card: u32) -> &[u32]` (every entry with that card group, ascending).

- [ ] **Step 1: Write the failing tests**

```rust
// gallery.rs
#[test]
fn looks_of_lists_every_look_of_a_card_and_nothing_else() {
    // cards [7, 9, 7, 7]
    let g = /* Gallery::build with those card groups */;
    assert_eq!(g.looks_of(7), &[0, 2, 3]);
    assert_eq!(g.looks_of(9), &[1]);
    assert!(g.looks_of(42).is_empty());
}
// lib.rs tests, with the shipped files
#[test]
fn a_found_card_carries_the_fingerprint_its_score_came_from() {
    // Recognizer::fingerprint on the 320×192 grey frame with one hand-made Detection whose quad
    // is the frame's inset rectangle (flip 0.0, so one view): the search always answers, so one Found.
    // assert_eq!(found.embedding.len(), r.meta().embedder.dim);
    // assert!((r.gallery().score(found.scored.entry, &found.embedding) - found.scored.score).abs() < 1e-5);
}
```

- [ ] **Step 2:** `cargo test -p card-neural` — FAIL.
- [ ] **Step 3:** Build the card index once in `from_bytes` (a `Vec<u32>` of entries sorted by card plus per-card offsets, or `HashMap<u32, Vec<u32>>`; the bytes stay borrowed). In `fingerprint`, copy the winning view's embedding slice into `Found.embedding`. Update every `Found { .. }` literal in tests (`embedding: vec![]` where unused).
- [ ] **Step 4:** `cargo test -p card-neural` — PASS.
- [ ] **Step 5: Commit** — `feat(card-neural): keep each card's fingerprint and index looks by card`

### Task 3: The evidence section of `neural.json` and the `narrow` rule

**Files:**
- Modify: `crates/card-neural/src/meta.rs`
- Create: `crates/card-neural/src/narrow.rs` (and `pub mod narrow;` in `lib.rs`)
- Test: both files' `mod tests`

**Interfaces:**
- Produces, in `meta.rs`:

```rust
pub struct Meta { /* existing */ #[serde(default)] pub evidence: Option<EvidenceMeta> }
pub struct EvidenceMeta { pub symbol: CropMeta, pub band: CropMeta, pub thresholds: EvidenceThresholds }
pub struct CropMeta { pub width: usize, pub height: usize, #[serde(rename = "box")] pub crop: [f32; 4], pub dim: usize }
pub struct EvidenceThresholds {
    /// A look of the decided card is a candidate when its whole-card score is within this of the decided look's.
    pub candidate_gap: f32,
    pub symbol_weight: f32,
    pub band_weight: f32,
    /// The best candidate's lead over the second needed to decide one printing.
    pub decide_margin: f32,
    /// Candidates within this of the best stay choices.
    pub keep_gap: f32,
}
```
  All `camelCase` like the rest of the file. `CropMeta` converts to an `EmbedderMeta` with
  `max_batch: 1, topk: 0` for `Embedder::load`.
- Produces, in `narrow.rs`:

```rust
pub struct Candidate { pub printing: Id, pub whole: f32, pub symbol: Option<f32>, pub band: Option<f32> }
pub struct Narrowed { pub decided: Option<Id>, /** best first */ pub choices: Vec<Id> }
pub fn narrow(candidates: &[Candidate], th: &EvidenceThresholds) -> Narrowed
```

Rule (the spec leaves the combiner to the builder; this is the first one, tuned in Task 9):
`combined = whole + symbol_weight·symbol + band_weight·band` for a candidate with both scores.
A candidate missing either score is **unknown**. `decided = Some(best)` only when there is no
unknown candidate and either one candidate or `best − second ≥ decide_margin`. Otherwise
`choices` = known candidates with `combined ≥ best − keep_gap`, best first, then every unknown
candidate in input order; `decided = None`. One candidate alone is always decided.

- [ ] **Step 1: Write the failing tests**

```rust
// meta.rs
#[test] fn a_file_without_an_evidence_section_reads_as_none() { /* the shipped neural.json → m.evidence.is_none() */ }
#[test] fn an_evidence_section_reads_its_crops_and_thresholds() { /* json with evidence.symbol.box [0.78,0.535,0.965,0.625] → crop equals it; thresholds.decideMargin 0.1 → 0.1 */ }
// narrow.rs  (th: candidate_gap 0.08, symbol_weight 1, band_weight 1, decide_margin 0.1, keep_gap 0.15)
#[test] fn one_candidate_is_decided() { /* [c(1, .7, None, None)] → decided Some(1) */ }
#[test] fn a_clear_lead_on_the_crops_decides() { /* c(1,.70,.9,.8) vs c(2,.71,.3,.2) → decided Some(1) */ }
#[test] fn a_narrow_lead_stays_ambiguous_with_both_choices_best_first() { /* c(1,.7,.6,.6) vs c(2,.7,.58,.57) → None, choices [1,2] */ }
#[test] fn candidates_far_behind_the_best_are_dropped_from_the_choices() { /* three, the third combined 0.4 below → choices has two */ }
#[test] fn a_candidate_with_no_evidence_row_is_kept_and_blocks_a_decision() { /* c(1,.7,.9,.9), c(2,.7,None,Some(.1)) → decided None, choices [1,2] */ }
```

- [ ] **Step 2:** `cargo test -p card-neural meta:: narrow::` — FAIL.
- [ ] **Step 3:** Implement as specified. Keep `the_shipped_file_reads_and_names_the_aimed_ranking` passing (no section yet).
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5: Commit** — `feat(card-neural): evidence thresholds and the narrowing rule`

### Task 4: `Evidence` — the crop networks, their galleries, and scores by printing

**Files:**
- Create: `crates/card-neural/src/evidence.rs` (`pub mod evidence;`, re-export `Evidence`, `EvidenceFiles`, `EvidenceNets`, `EvidenceIndex`, `Glance` from `lib.rs`)
- Modify: `crates/card-neural/src/lib.rs` (file-name constants; `read_dir_evidence` under `cli`)
- Test: `evidence.rs` `mod tests`

**Interfaces:**
- Consumes: `CropMeta`, `EvidenceMeta` (Task 3); `Gallery`, `Face`, `Id`; `Embedder`; `frame::sample_card`.
- Produces:

```rust
pub const SYMBOL_NET_FILE: &str = "symbol.onnx";
pub const BAND_NET_FILE: &str = "band.onnx";
pub const SYMBOLS_FILE: &str = "symbols.bin";
pub const BANDS_FILE: &str = "bands.bin";
pub struct EvidenceFiles<'a> { pub symbol_net: Cow<'a, [u8]>, pub band_net: Cow<'a, [u8]>, pub symbols: Cow<'a, [u8]>, pub bands: Cow<'a, [u8]> }
#[cfg(feature = "cli")] pub fn read_dir_evidence(dir: &Path) -> io::Result<EvidenceFiles<'static>>;

/// Both crops of one card on one frame, embedded.
#[derive(Clone, Debug)] pub struct Glance { pub symbol: Vec<f32>, pub band: Vec<f32> }

/// The galleries and their printing index — no networks, so the scoring is testable alone.
pub struct EvidenceIndex { /* symbols, bands: Gallery; index printing → rows */ }
impl EvidenceIndex {
    pub fn new(symbols: Gallery, bands: Gallery) -> EvidenceIndex;
    /// Mean cosine over the glances, against the printing's symbol row; None when it has none.
    pub fn symbol(&self, glances: &[Glance], printing: &Id) -> Option<f32>;
    /// The same against the printing's band row **of this face**; None when it has none.
    pub fn band(&self, glances: &[Glance], printing: &Id, face: Face) -> Option<f32>;
}
/// The two crop networks.
pub struct EvidenceNets { /* symbol, band: Embedder; symbol_crop, band_crop: CropMeta; buffers */ }
impl EvidenceNets {
    /// Cut both crops through `quad` (the winning view's, already turned) and embed them.
    pub fn glance(&mut self, frame: &Frame, quad: &Quad) -> Result<Glance, Error>;
}
/// Everything the files make, in parts: the scanner keeps the index and thresholds apart from
/// the networks, so its decision logic is testable with galleries built by hand.
pub struct Evidence { pub nets: EvidenceNets, pub index: EvidenceIndex, pub thresholds: EvidenceThresholds }
impl Evidence {
    /// Refused (`Error::Meta`) when `meta.evidence` is None; galleries' dims must match the CropMetas'.
    pub fn load(files: EvidenceFiles<'static>, meta: &Meta) -> Result<Evidence, Error>;
}
```

Gallery conventions for the two files (Task 8 builds them with `build-gallery` unchanged):
**bands** — one entry per printing face, `printing` = that printing, `covers = [printing]`,
`face` its face; **symbols** — one entry per symbol class, `covers` = every printing showing it,
`face` front. `card` is 0 and `name` a debugging label (`"BBD 119"`, `"bbd/common"`). A printing
in several band rows of one face is a build error the index refuses.

- [ ] **Step 1: Write the failing tests** (galleries from `Gallery::build`, 2-d rows)

```rust
#[test] fn a_printings_band_score_is_its_rows_cosine_averaged_over_the_glances() { /* two glances, expected mean */ }
#[test] fn a_printing_with_no_row_scores_none() { /* symbol and band both None */ }
#[test] fn a_back_face_is_compared_with_back_face_rows_only() { /* printing P has front row (1,0), back row (0,1); glance band (0,1); band(.., Face::Back) ≈ 1, band(.., Face::Front) ≈ 0 */ }
#[test] fn printings_sharing_a_symbol_class_get_the_same_symbol_score() { /* one symbol row covering P and Q */ }
#[test] fn evidence_is_refused_without_an_evidence_section() { /* Evidence::load with shipped neural.json → Err(Error::Meta(_)) — needs no ONNX: check meta before parsing networks */ }
#[test] fn a_crop_through_a_turned_quad_is_the_turned_cards_crop() {
    // a 40×56 synthetic frame with a marked bottom-left region; rotate the image 180° and the quad with
    // rotate_half: sample_card on (frame, quad, band box) and (rotated frame, rotate_half(quad'), band box)
    // give equal buffers — the evidence crop follows the winning view's orientation.
}
```

- [ ] **Step 2:** `cargo test -p card-neural evidence::` — FAIL.
- [ ] **Step 3:** Implement. `EvidenceNets::glance` calls `sample_card(frame, quad, crop.crop, crop.width, crop.height, buf, None)` per crop and `Embedder::run(buf, 1)`; a degenerate quad is `Error::Frame`. Check `meta.evidence` before `Embedder::load`.
- [ ] **Step 4:** Re-run — PASS. `cargo clippy -p card-neural --all-targets --features cli,bundled -- -D warnings`.
- [ ] **Step 5: Commit** — `feat(card-neural): crop evidence networks and their printing galleries`

### Task 5: `card-neural`'s `probe` cuts and saves the two crops

So the lab can see what the runtime cuts, before any network exists.

**Files:**
- Modify: `crates/card-neural/src/bin/probe.rs`

**Interfaces:**
- Consumes: `Recognizer::read`, `frame::sample_card`, a `--evidence-meta <json>` file holding only an `EvidenceMeta`.
- Produces: `probe --evidence-meta e.json --crops <dir> frame.jpg …` writes `<stem>.symbol.png` and `<stem>.band.png` for the frame's best card (RGB via `sample_card`'s `view`).

- [ ] **Step 1:** Implement the flag (no unit test: a `cli` binary; verified by Step 2).
- [ ] **Step 2:** Run it on three readers' frames from `.scanner-corpus` (one sleeved, one binder, one loose) with the starting boxes — symbol `[0.78, 0.535, 0.965, 0.625]` at 72×48, band `[0.0, 0.905, 0.80, 0.995]` at 256×40. Expected: PNGs showing the symbol and the band (number, set, artist) of the aimed card.
- [ ] **Step 3: Commit** — `feat(card-neural): probe saves the evidence crops`

### Task 6: The Neural mode widens and narrows the printing

**Files:**
- Modify: `crates/card-scanner/src/neural_mode.rs`
- Test: `neural_mode.rs` `mod tests::loaded`

**Interfaces:**
- Consumes: `Found.embedding`, `Gallery::looks_of` (Task 2); `narrow`, `EvidenceThresholds` (Task 3); `Evidence`, `EvidenceIndex`, `Glance`, `EvidenceFiles` (Task 4).
- Produces:

```rust
impl Session {
    /// Give the Neural mode its evidence files, after `load_neural`. Refused (a sentence) when no
    /// recogniser is loaded or its neural.json has no evidence section; a refusal leaves today's behaviour.
    #[cfg(feature = "neural")] pub fn load_neural_evidence(&mut self, files: card_neural::EvidenceFiles<'static>) -> Result<(), String>;
    /// The last Neural decision's candidates and their scores — for the replay, not the page.
    #[cfg(feature = "neural")] pub fn neural_evidence_report(&self) -> Option<EvidenceReport>;
}
#[derive(Clone, Debug, Serialize)] pub struct EvidenceReport { pub candidates: Vec<CandidateReport>, pub decided: Option<String> }
#[derive(Clone, Debug, Serialize)] pub struct CandidateReport { pub printing: String, pub look: u32, pub whole: f32, pub symbol: Option<f32>, pub band: Option<f32> }
```

Behaviour:
- `Loaded` gains `nets: Option<card_neural::EvidenceNets>`, `index: Option<(card_neural::EvidenceIndex, EvidenceThresholds)>` (both set by `load_neural_evidence` from `Evidence`'s parts; "evidence loaded" means `index` is `Some`), `frames_seen: Vec<Seen>` (`Seen { card: u32, face: Face, embedding: Vec<f32>, glance: Option<Glance> }`) and `report: Option<EvidenceReport>`. Cleared by `forget`.
- In `neural_read`, after `recognizer.read`: when the read votes (`accepted || supported`) and evidence is loaded, `nets.glance` the best card through `best.quad`; push a `Seen` for `best.scored.card`. Clear `frames_seen` first when the agreement's votes are 0 after `observe`, or the pushed card differs from the buffer's. A glance error drops that frame's glance, not the frame. (The pixels and quad are in `neural_read`; pass the `Seen` into `neural_verdict` rather than the pixels.)
- On a new decision with evidence loaded: whole score of each look `e` of `decision.card` = mean of `gallery.score(e, &seen.embedding)` over the buffer; candidate looks = those within `candidate_gap` of the decided look's (the decided look always in); candidate printings = their covers the mask permits, deduplicated, the decided look's admitted covers first; `narrow` them with each printing's `whole` (its look's), `index.symbol`, `index.band(.., face)`. `decided = Some(p)` → `Outcome::Resolved`, printing `p`, no choices; else `Ambiguous` with `choices` in `narrow`'s order and `printing = choices[0]`. A choice's `distance` = `normalized(its look's whole)`. Record the `EvidenceReport`.
- Without evidence: today's `neural_decision`, untouched.

- [ ] **Step 1: Write the failing tests.** Drive `neural_verdict` with hand-made reads as the module's tests already do; set `Loaded.index` directly (the tests are a child module) to an `EvidenceIndex` of galleries from `Gallery::build`, leave `nets` `None`, and pass hand-made `Seen`s carrying hand-made `Glance`s — no ONNX is needed.

```rust
#[test] fn without_evidence_the_decision_is_todays() { /* same reads, no evidence: DecisionView equals the one built by today's neural_decision */ }
#[test] fn a_lower_scored_look_of_the_card_within_the_gap_adds_its_printings() { /* card with looks A (0.80) and B (0.75), gap 0.08: B's covers among the choices */ }
#[test] fn a_look_outside_the_gap_adds_nothing() { /* B at 0.70 */ }
#[test] fn sure_crop_evidence_resolves_a_look_of_many_printings() { /* A covers P,Q,R; band rows favour Q by > decide_margin → Resolved, printing Q */ }
#[test] fn unsure_crop_evidence_leaves_fewer_choices_best_first() { /* → Ambiguous, choices [Q, R] */ }
#[test] fn the_filters_limit_the_widened_candidates() { /* mask permits only R and B's cover → choices drawn from those; mask permitting one → Resolved */ }
#[test] fn a_vote_for_another_card_clears_the_evidence_frames() { /* Seen for card 1 then a voting read of card 2: buffer holds card 2 only */ }
#[test] fn the_report_names_every_candidate_with_its_scores() { /* neural_evidence_report after a decision */ }
#[test] fn evidence_is_refused_before_the_recogniser_or_without_a_section() { /* load_neural_evidence → Err */ }
```

- [ ] **Step 2:** `cargo test -p card-scanner --features neural neural_mode::` — FAIL.
- [ ] **Step 3:** Implement as specified.
- [ ] **Step 4:** Re-run — PASS; the existing `neural_mode` tests pass unchanged.
- [ ] **Step 5: Commit** — `feat(scanner): Neural narrows the printing on set symbol and collector band evidence`

### Task 7: The replay loads evidence and writes each decision's candidates

**Files:**
- Modify: `crates/card-scanner/src/bin/replay.rs` (`Args`, `Ingredients`, `pinned`, `session_for`, `PassOut`)
- Modify: `scripts/scanner-replay/results.ts`, `scripts/scanner-replay/cli.ts` (pass the flag through)

**Interfaces:**
- Consumes: `Session::load_neural_evidence`, `Session::neural_evidence_report` (Task 6); `card_neural::read_dir_evidence` (Task 4).
- Produces: `replay … --neural-evidence <dir>` (optional; absent = no evidence, today's pass); `PassOut.evidence: Option<EvidenceReport>` serialised as `"evidence"` on the Neural pass. `--neural-evidence-meta <neural.json>` overrides the `neural.json` read from `--neural-models`, so the lab can tune without copying files.

- [ ] **Step 1: Write the failing test** — extend the bin's existing key-set test: a Neural pass built with `Ingredients { neural_evidence: None, .. }` serialises `"evidence": null`.
- [ ] **Step 2:** `cargo test -p card-scanner --features builder,neural --bin replay` — FAIL.
- [ ] **Step 3:** Implement; `pinned_evidence` leaks the four buffers as `pinned` does.
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5: Commit** — `feat(scanner): the replay records the Neural evidence per decision`

---

## Phase 2 — the scanner lab (`E:\mtg-scanner`, outside the repo; no repo commits)

The lab's rules hold (its `README.md`): long runs detached with `Start-Process`, one heavy job at
a time, Quickdraw's files never used. Work in `spike\train\` with `data\venv-oracle`. Record each
run in `data\runs\<run>\run.json` and the findings in `docs\neural-scanner.md` §5 (new:
*Printing evidence*).

### Task 8: Crop boxes, training views and the two networks

**Files (lab):**
- Create: `spike\train\ev_data.py`, `spike\train\ev_train.py`, `spike\train\ev_export.py`
- Modify: `spike\train\scryfall_fetch.py` (index rows gain `rarity`) — then re-index the dataset in `E:\MTG-datasets\scryfall-default-cards\` (no image re-download)

**Interfaces:**
- Consumes: `qd_data.camera_view`'s scene steps and `qd_scene.detector_quad` (the same jittered, sometimes-plastic-outline quad); `looks.scan_path`; `index.jsonl`.
- Produces, per network `<kind>` ∈ {`symbol`, `band`}: `data\runs\ev-<kind>-<n>\export\<kind>.onnx` (input `crops` `[n,3,h,w]` ImageNet-normalised, output `embedding` `[n,dim]` unit-length — the names `Embedder::load` looks up), `<kind>s.matrix` (`NSGALLR1` f32, as `qd_export.py` writes) and `<kind>s.json` (`build_gallery.rs`'s `{source, entries:[{card:0,name,id,face,covers}]}`), with the conventions of Task 4.

Decisions fixed here:
- **Classes:** band — one class per printing face. Symbol — one class per **(printed set, rarity)**, where printed set is the collector number's prefix for `plst` (`"BBD-119"` → `bbd`) and `set` otherwise; so a PLST printing shares its original's symbol class, as the card does.
- **Views:** a camera view of the whole card exactly as the embedder's training draws it (card height 130–340 px, contexts, glare, blur, JPEG), then the crop cut through the detector quad with the region box; 12 % clean reference crops. Train only on Scryfall `normal` scans.
- **Loss:** ArcFace (the embedder's head, margin 0.3, scale 30), prototype-initialised; fingerprint `dim` 64 for both unless the lab measures a reason to differ.
- **Backbone:** small enough for the size target (≤ 3 MB ONNX), e.g. timm `mobilenetv3_small_050`; lab's choice.

- [ ] **Step 1: Fix the boxes.** With `probe --crops` (Task 5) on ~40 readers' frames across frame types (old, modern, borderless, showcase, full-art, saga, adventure, split, flip) and with `ev_data.reference_crop` on the same printings' Scryfall scans, widen or move the starting boxes until both crops contain their region on every sample under the detector's quad error. Record the boxes and sizes.
- [ ] **Step 2: Smoke** each trainer on 2 000 classes for 1 epoch; expected: loss falls, export loads in `card-neural` (`Evidence::load` through a scratch `neural.json` with the evidence section).
- [ ] **Step 3: Train** both, detached. Record wall time and the GPU used (Task 12 sizes the budget from it).
- [ ] **Step 4: Measure retrieval within a card**: for 3 000 cards with ≥ 2 printings, a camera view's crop scored against that card's printings' rows — top-1 rate for band, symbol, and both. These numbers become the pipeline floors (Task 12) at ~90 % of what is reached.
- [ ] **Step 5: Build the galleries** with the repo's `build-gallery` into `data\runs\ev-<kind>-<n>\export\<kind>s.bin`; check sizes against the Global Constraints.

### Task 9: Tune on the readers' scans, with the owner's label audit

**Files (lab):**
- Create: `scratch\qd-tools\tune_evidence.py`

**Interfaces:**
- Consumes: the repo replay with `--neural-evidence` (Task 7) → `results.json`; the 124 labels.
- Produces: the `evidence` section of `neural.json` (`symbol`, `band`, `thresholds`), and `docs\neural-scanner.md` §5's table.

- [ ] **Step 1:** Run the replay on the 124 scans with the new files and permissive thresholds (`candidateGap` 0.2, `decideMargin` 99) so every decision records its widest candidate list.
- [ ] **Step 2: Label audit — owner checkpoint.** List every run where the evidence's best candidate ≠ the label, with both crops and the two printings' Scryfall crops, as an HTML page in `scratch\`. **Stop and ask the owner to judge them.** A label the owner overturns is corrected in a lab-side override file (`scratch\label-overrides.json`, id → printing, with the owner's reason); the scans' labels are never edited.
- [ ] **Step 3: Tune** `tune_evidence.py`: grouped cross-validation (the same folds the lab's `replay --tune` uses) over `candidateGap`, the two weights, `decideMargin`, `keepGap`, objective = most resolved-right then fewest choices, **subject to zero resolved-wrong-printings beyond the baseline and `true_in_choices` ≥ today's in every fold**. Report the held-out and in-sample figures.
- [ ] **Step 4:** Write the chosen section into a scratch `neural.json`; replay once more with it; the Neural pass must meet the floor with the overrides applied. If no setting meets it, stop and report to the owner with the numbers — do not ship.

---

## Phase 3 — ship it everywhere, keep it retrained

### Task 10: The files in git, and the native hosts load them

**Files:**
- Add: `crates/card-neural/models/{symbol.onnx,band.onnx,symbols.bin,bands.bin}`; modify `models/neural.json` (the `evidence` section from Task 9), `models/README.md` (four rows, the recipe, the measured figures), `.gitattributes` if it lists files by name
- Modify: `crates/card-neural/src/lib.rs` (`bundled_evidence()` under `bundled`; a shipped-evidence test)
- Modify: `crates/grimoire-core/src/scanner.rs` (`Embedded.neural_evidence: Option<card_scanner::neural::EvidenceFiles<'static>>`, loaded right after `load_neural`, a refusal logged and not fatal)
- Modify: `apps/desktop/src-tauri/src/scanner/mod.rs` (~50, ~59), `apps/light/src-tauri/src/lib.rs` (~376): `neural_evidence: Some(card_neural::bundled_evidence())`
- Modify: `crates/card-scanner/src/bin/serve.rs` (~470): load evidence when present
- Modify: `crates/card-scanner/src/bin/replay.rs`: default `--neural-evidence` to `crates/card-neural/models/` when its files exist

**Interfaces:**
- Produces: `#[cfg(feature = "bundled")] pub fn bundled_evidence() -> EvidenceFiles<'static>`.

- [ ] **Step 1: Write the failing test** in `lib.rs`: `the_shipped_evidence_loads_beside_the_shipped_recogniser` — `Evidence::load(shipped_evidence(), recognizer.meta())` is Ok; both galleries' `dim` equal their `CropMeta.dim`; `bands` has ≥ 100 000 rows; `nets.glance` on the grey frame with a hand quad returns two unit vectors.
- [ ] **Step 2:** `cargo test -p card-neural` — FAIL until the files are copied in.
- [ ] **Step 3:** Copy the files, update README and `neural.json`, add `bundled_evidence`, wire the hosts and `serve`.
- [ ] **Step 4:** `cargo test -p card-neural`, `cargo test -p card-scanner --features neural neural_mode::`, `cargo test -p grimoire-core scanner::` — PASS. Run the replay with the shipped files: the Neural pass matches Task 9 Step 4's figures.
- [ ] **Step 5: Commit** — `feat(card-neural): ship the set symbol and collector band networks`

### Task 11: The web fetches the evidence files after the recogniser, without holding up a card

**Files:**
- Modify: `packages/ui/lib/core/web/assets.ts` (`NEURAL_EVIDENCE_FILES`; `neuralFileOf`, `neuralFault` and the table check cover them), `assets.test.ts`
- Modify: `packages/ui/lib/core/web/scanNeural.ts` (`fetchNeuralEvidence`, `neuralKept` covers all eight), `scanner.test.ts`
- Modify: `packages/ui/lib/core/web/scanProtocol.ts`, `scanSession.ts`, `scanSession.test.ts`, `scanProtocol.test.ts`, `grimoire_scan.d.ts`, `scanner.ts`
- Modify: `crates/grimoire-scan/src/glue.rs` (`load_neural_evidence`), `crates/grimoire-scan/src/scanner.rs` (`Scanner::load_neural_evidence`)
- Modify: `apps/light/vite.config.ts` (`webNeural` checks and emits the eight; `VITE_NEURAL_BYTES` includes them)

**Interfaces:**
- Produces:

```ts
export const NEURAL_EVIDENCE_FILES = ["symbol.onnx", "band.onnx", "symbols.bin", "bands.bin"] as const; // load_neural_evidence's order
export async function fetchNeuralEvidence(env, source): Promise<NeuralEvidenceFiles>; // { symbolNet, bandNet, symbols, bands }
```
```rust
#[wasm_bindgen] pub fn load_neural_evidence(symbol_net: Vec<u8>, band_net: Vec<u8>, symbols: Vec<u8>, bands: Vec<u8>) -> Option<String>;
```
  A Worker message `load-neural-evidence` carrying the four buffers transferred, as `load-neural` does.

Behaviour: once `load_neural` has answered OK, `scanner.ts` starts `fetchNeuralEvidence` and posts the result when it arrives; frames are sent meanwhile and decide as today. A failed evidence fetch is logged and Neural carries on without it (no error shown to the reader). A Worker made again posts both sets again from the caches.

- [ ] **Step 1: Write the failing tests:** `assets.test.ts` — `NEURAL_EVIDENCE_FILES` equals `card_neural`'s four constants in order; `neuralFault` faults on a missing evidence file. `scanSession.test.ts` — a `load-neural-evidence` message calls `glue.load_neural_evidence(bytes(5), bytes(6), bytes(7), bytes(8))`. `scanner.test.ts` — the first Neural frame is posted before the evidence fetch resolves; the evidence is posted after `load_neural`'s OK; a 404 on `bands.bin` leaves frames flowing and no error state.
- [ ] **Step 2:** `pnpm vitest run packages/ui/lib/core/web` — FAIL.
- [ ] **Step 3:** Implement; rebuild the WASM (`pnpm web:wasm`) so `grimoire_scan.d.ts` matches.
- [ ] **Step 4:** Re-run — PASS. `pnpm web:build` passes the table check.
- [ ] **Step 5: Live check:** `pnpm web:preview`, scan one card in Neural with the network panel open (built-in browser): the four recogniser files load, a decision appears, then the four evidence files load; a second card's decision carries narrowed choices.
- [ ] **Step 6: Commit** — `feat(web): fetch the Neural evidence files after the recogniser`

### Task 12: The monthly retraining makes the evidence files too

**Files:**
- Create: `crates/card-neural/train/ev_data.py`, `ev_train.py`, `ev_export.py` (the lab's Task 8 code, production subset, defaults = the shipped runs' values) and tests in `train/tests/`
- Modify: `crates/card-neural/train/scryfall_fetch.py` (`rarity` in `index.jsonl`), `modal_app.py` (`train_symbol`, `train_band` stages, `FLOORS`, `_floors_failed`, `DONE.json` `files`), `budget.py` (`shares` gains `symbol` and `band`), `deliver.py` (`EXPORTS`; builds `symbols.bin`/`bands.bin` with `build-gallery`), `update_readme.py` (`FILES` has eight), `train/README.md`
- Modify: `.github/workflows/neural-train.yml` / `neural-deliver.yml` only if they list files by name

**Interfaces:**
- Produces: `budget.shares(budget_usd, detector) -> {"refresh", "pipeline", "embedder", "detector", "symbol", "band"}`; the symbol and band shares are each Task 8's measured cost ×2 headroom at Modal rates, taken from the embedder and detector shares in their current 0.45 : 0.55 ratio.

- [ ] **Step 1: Write the failing tests** (`python -m unittest discover crates/card-neural/train/tests`): `test_budget` — `shares(10.0, True)` has six keys summing to 10.0 and `symbol`, `band` > 0; `test_paths` — `ev_data.symbol_class({"set":"plst","collector_number":"BBD-119","rarity":"common"}) == ("bbd","common")` and `({"set":"2x2","collector_number":"32","rarity":"rare"}) == ("2x2","rare")`; `test_fetch` — an index row carries `rarity`; `test_deliver` — a delivery commits the eight files plus README and `training.json`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; `neural.json` stays hand-kept (the evidence thresholds are the lab's, as the others are).
- [ ] **Step 4:** Run — PASS. A local smoke run per `train/README.md` (`--limit`) produces all eight files and `build-gallery` reads both new galleries.
- [ ] **Step 5: Commit** — `feat(card-neural): the monthly retraining remakes the evidence networks`

### Task 13: Documentation, the whole-feature check, and the owner's gate

**Files:**
- Modify: `docs/reference/card-scanner.md` §10 *Neural* (what a decision says now; the new table beside today's; the replay's new columns; stale "three passes" → four in §10 *The replay*), `crates/card-neural/CLAUDE.md` (§1: eight files in two sets; §5: the evidence trainers), `crates/card-neural/src/lib.rs` module doc, `crates/card-scanner/src/neural_mode.rs` module doc ("no band is read" no longer true)

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `pnpm verify` — PASS (one run; see the repo memory on never running two at once).
- [ ] **Step 3:** Final replay on the 124 scans; compare with the **Baseline** section below: wrong ≤ baseline, resolved wrong printing ≤ baseline, ambiguous < 42, resolved right > baseline, `true_in_choices` + resolved right ≥ today's 118. Record the figures in the doc.
- [ ] **Step 4: Owner's gate.** Ask the owner to run `pnpm scanner:corpus pull` (their R2 credentials) and the replay on the scans after 2026-10-15; the same floor must hold there. Do not open the PR for merge until they confirm.
- [ ] **Step 5: Commit** — `docs(scanner): Neural printing evidence`

---

## Baseline

Measured 2026-10-21 by Task 1 on commit `eaf1125aa` plus the Task 1 replay changes (`+dirty`),
with `pnpm scanner:replay` and the shipped bundle `apps/desktop/src-tauri/scanner-assets/card-hashes.bin`
(122,390 printings). The corpus mirror holds exactly 124 scans, received 2026-10-12 to 2026-10-15
(the labels' `received_at`), so the test set and "everything present" are the same 124. Nothing
was pulled from R2.

**The Neural pass, 124 scans** (`results.json` `passes[name = "Neural"]`):

| measure | value |
| --- | ---: |
| card ✓ (the reader's card: printing or another printing of it) | 119 (96.0 %) |
| printing ✓ (first choice is the reader's printing, ambiguous included) | 112 (90.3 %) |
| wrong card | **0** |
| undecided | 5 (4.0 %) |
| resolved right | **77** |
| resolved wrong printing (**the floor**) | **0** |
| ambiguous | **42** |
| median choices (over the 42 ambiguous) | 2 |
| mean choices (over the 42 ambiguous) | 2.2 (94 choices in all: thirty-four decisions of 2, six of 3, two of 4) |
| `true_in_choices` | **41** |

Resolved right + `true_in_choices` = 77 + 41 = **118**, the "today's 118" of Task 13 Step 3. The 42
ambiguous decisions are the 42 of "ambiguous < 42"; the other 5 of the 124 are undecided. The 119
card ✓ are the 77 resolved right, the 42 ambiguous and 0 resolved wrong printing: a right first
choice among the ambiguous still scores `printing`, which is why the bar is not read on
`printing ✓`.

For reference, the same replay's other passes: As scanned and Exact are identical (49 resolved
right, 2 resolved wrong printing, 24 ambiguous, 10 wrong card, 45 undecided, 34 never resolved);
Fast has 42 resolved right, 11 resolved wrong printing, 12 wrong card, 59 undecided.
