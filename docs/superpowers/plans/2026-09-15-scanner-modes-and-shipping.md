# Scanner modes, filters, tray and shipped bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the hash bundle and OCR models inside the app, add Fast and Exact scan modes with set/date filters, and land scanned cards in a review tray that commits to the collection.

**Architecture:** The `card-scanner` crate gains a filter mask that constrains every tier, a `ScanMode` on `FrameOptions`, an Exact-mode tier pipeline (`resolve.rs`) run over a three-frame burst, and a `decision_seq`/`decision` pair on the verdict. `src-tauri` embeds the assets under a `build.rs` cfg, adds filter/prefs/tray commands, and the Scanner view becomes a reader-facing bar + camera + tray with today's panels behind a Developer switch. A weekly CI workflow builds and publishes the bundle; the release job embeds it; a synthetic `eval` binary fences both modes.

**Tech Stack:** Rust (image, imageproc, ocrs 0.13 / rten 0.26, rusqlite 0.40, serde), Tauri 2.11, React 19 + TypeScript 6, TanStack Query, Vitest, Storybook, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-15-scanner-modes-and-shipping-design.md` — read it before your task. Section numbers "§n" without a file refer to `docs/reference/card-scanner.md`.

## Global Constraints

- Filters are **sets** and a **release-date range** only. **No language anywhere** — no filter, no tray default, no field.
- `FORMAT_VERSION` in `crates/card-scanner/src/index.rs` is **not changed** by this plan. The descriptor is untouched.
- `Verdict` and every struct it contains stay `#[serde(rename_all = "snake_case")]`-compatible: new keys are snake case.
- Exact constants: `FAST_RESCUE_AFTER = 8`, `EXACT_STEADY_FRAMES = 3`, `EXACT_BURST = 3`, `EXACT_TOP = 32`, `EXACT_MARGIN_BITS = 6`, `EXACT_MAX_CHOICES = 12`.
- Release tag for assets: `scanner-bundle-v<FORMAT_VERSION>`, prerelease, not latest. Asset names: `card-hashes.bin`, `text-detection.rten`, `text-recognition.rten`.
- `src-tauri/scanner-assets/` holds the three embedded files; only its `README.md` is tracked.
- `app_meta` keys: `scanner_prefs`, `scanner_tray`. No schema rung. Not synced.
- New scanner commands are `#[cfg(not(target_family = "wasm"))]`, like the existing four.
- The tray commits through the existing `collection_import_commit`.
- **Tests run once, at the end, after fan-in** (root `CLAUDE.md`). A subagent reports what it changed; it does not run `npm run verify`. The one exception is noted per task: the crate task may run the crate's own `cargo test`, because nothing else touches `crates/card-scanner/src/` while it runs.
- Never install `@types/node`. Never pattern-kill node processes. Commits: `feat(scanner): …` / `test(scanner): …` / `docs(scanner): …` / `ci(scanner): …`, ending with the attribution lines the session supplies.
- UI work follows `src/CLAUDE.md` (Storybook-MCP rule, `frontend-design` skill, layers). Rust work follows `src-tauri/CLAUDE.md`.

## File map and waves

| Wave | Task | Owns (no other task edits these) |
| --- | --- | --- |
| 1 | T1 Crate: filters, modes, Exact tiers, decision | `crates/card-scanner/src/{filters.rs,resolve.rs,reference.rs,track.rs,session.rs,ocr.rs,lib.rs}`, `crates/card-scanner/src/bin/{live.html,serve.rs}` |
| 1 | T2 Shipping: builder `--bulk`, workflow, release step, assets script, build.rs cfg | `crates/card-scanner/src/bin/build_hashes.rs`, `crates/card-scanner/Cargo.toml`, `.github/workflows/{scanner-bundle.yml,release.yml}`, `scripts/scanner-assets.mjs`, `package.json` (scripts only), `src-tauri/build.rs`, `src-tauri/scanner-assets/README.md`, `.gitignore` |
| 1 | T3 App commands + IPC types + fixtures + Storybook fake | `src-tauri/src/scanner.rs`, `src-tauri/src/lib.rs` (command registration only), `src/lib/ipc.ts` (scanner section only), `src/lib/ipc.test.ts` (mirror rows only), `src/features/scanner/{types.ts,fixtures.ts}`, `.storybook/fake/db.ts` (scanner handlers only), `.storybook/CLAUDE.md` (only if a fault is added) |
| 1 | T4 Tray model + reader-facing components | new files under `src/features/scanner/reader/` |
| 2 | T5 ScannerPage integration + Tiers panel | `src/features/scanner/{ScannerPage.tsx,ScannerPage.test.tsx,ScannerPage.stories.tsx,useScanLoop.ts,useScanLoop.test.ts,ScannerPanels.tsx,verdictText.ts,verdictText.test.ts,useScannerPrefs.ts,useTray.ts}` (+ tests), `src/features/scanner/panels/TiersPanel.tsx`, `src/lib/store.ts` (`PrintingsRequest.pick` only), `src/features/card/AllPrintingsDialog.tsx` (the `pick` branch only) |
| 2 | T6 Synthetic eval binary | `crates/card-scanner/src/bin/eval.rs`, `crates/card-scanner/eval/printings.txt`, `crates/card-scanner/Cargo.toml` `[[bin]]` entry (T2 is finished by then) |
| 3 | T7 Fan-in: verify, live pass, docs | `docs/reference/card-scanner.md`, area `CLAUDE.md` files |

---

### Task 1: The crate — filters, modes, the Exact tiers, and the decision

**Files:**
- Create: `crates/card-scanner/src/filters.rs`, `crates/card-scanner/src/resolve.rs`
- Modify: `crates/card-scanner/src/lib.rs` (declare `pub mod filters; pub mod resolve;`), `reference.rs`, `track.rs`, `session.rs`, `ocr.rs` (`TitleReader::from_bytes`), `bin/serve.rs` (query params, `/filters`), `bin/live.html` (mode segment + filters)
- Test: inline `#[cfg(test)]` modules in each file above

**Interfaces:**
- Consumes: the existing crate (`Reference`, `Mask`, `Tracker`, `Session`, `TitleReader`, `Observation`).
- Produces (T3, T5, T6 rely on these exact names):
  - `card_scanner::filters::ScanFilters { sets: Vec<String>, released_from: Option<String>, released_to: Option<String> }` — `Debug, Clone, Default, PartialEq, Serialize, Deserialize`, `#[serde(default)]`; `fn is_empty(&self) -> bool`.
  - `Reference::add_label(&mut self, id: [u8; 16], oracle: Option<[u8; 16]>, illustration: Option<[u8; 16]>, label: Label)` — public, no feature gate; `load_labels` calls it per row.
  - `Reference::mask_for(&self, f: &ScanFilters) -> Mask`
  - `Reference::lookup_by_name_masked(&self, read: &str, mask: &Mask) -> Option<([u8; 16] /* oracle */, u32 /* edits */)>`
  - `Reference::lookup_collector_masked(&self, candidates: &[(String, String)], mask: &Mask) -> Option<[u8; 16]>`
  - `Reference::printings_of(&self, oracle: &[u8; 16]) -> &[[u8; 16]]`
  - `Tracker::commit_to(&mut self, key: [u8; 16], member: [u8; 16])`
  - `TitleReader::from_bytes(detection: &[u8], recognition: &[u8]) -> anyhow_lite::Result<TitleReader>` (under `ocr`)
  - `card_scanner::session::ScanMode { Fast, Exact }` — `#[serde(rename_all = "lowercase")]`, `Default` = `Fast`; new field `FrameOptions::mode: ScanMode`.
  - `Session::set_filters(&mut self, f: ScanFilters) -> Result<(), String>`; `Session::filters(&self) -> &ScanFilters`
  - In `resolve.rs`, re-exported from `session.rs`:
    - `pub enum Outcome { Resolved, Ambiguous, NotFound }` — `#[serde(rename_all = "snake_case")]`
    - `pub struct ChoiceView { pub id: String, pub oracle_id: Option<String>, pub label: Option<Label>, pub distance: Option<f32> }` — `oracle_id` is `None` when the corpus has no oracle for the printing (never the printing id standing in for one)
    - `pub struct TierView { pub tier: String, pub survivors: usize, pub detail: String }` — `tier` ∈ `"filters" | "whole_card" | "title" | "collector" | "re_rank" | "classifier"`
    - `pub struct ResolutionView { pub outcome: Outcome, pub choices: Vec<ChoiceView>, pub tiers: Vec<TierView>, pub elapsed_ms: f32 }`
  - In `session.rs`: `pub struct DecisionView { pub printing: String, pub oracle_id: Option<String>, pub label: Option<Label>, pub outcome: Outcome, pub choices: Vec<ChoiceView> }`
  - `Reference::oracle_id_of(&self, printing: &[u8; 16]) -> Option<[u8; 16]>` — the corpus oracle only, no fallback (`oracle_for` keeps its fallback for the tracker)
  - Verdict additions: `mode: ScanMode`, `decision_seq: u64`, `decision: Option<DecisionView>`, `resolution: Option<ResolutionView>`
  - Constants — `session.rs`: `FAST_RESCUE_AFTER: u32 = 8`, `EXACT_STEADY_FRAMES: u32 = 3`, `EXACT_BURST: usize = 3`; `resolve.rs`: `EXACT_TOP: usize = 32`, `EXACT_MARGIN_BITS: u32 = 6`, `EXACT_MAX_CHOICES: usize = 12`.

**This task may run the crate's own suite** (`cargo test --locked --features cli --manifest-path crates/card-scanner/Cargo.toml`): it is the only task touching `crates/card-scanner/src/` other than T2's `bin/build_hashes.rs`, which `--features cli` does not compile, and the crate builds into its own `crates/card-scanner/target/`.

- [ ] **Step 1: Filters and the label seam — tests first** (`filters.rs`, `reference.rs`)

Refactor `Reference::load_labels`' loop body into `add_label`, so tests and the eval attach labels without SQLite. Add `oracle_printings: HashMap<[u8; 16], Vec<[u8; 16]>>`, filled by `add_label`. Change `by_name` to map normalized name → **oracle id** (the printing's own id when the row has no oracle), so a masked name lookup can ask whether a card has any permitted printing. Keep `lookup_by_name`'s existing `([u8; 16] printing, u32)` contract as `lookup_by_name_masked(read, &Mask::all())` mapped to the oracle's first printing.

Tests in `reference.rs`, with `fn id(n: u8) -> [u8; 16] { [n; 16] }` and a helper `labelled(rows: &[(u8 printing, u8 oracle, &str name, &str set, &str number, &str released)]) -> Reference` built on a tiny `BundleBuilder` bundle plus `add_label`:

```rust
#[test]
fn a_set_filter_permits_exactly_that_sets_printings() {
    let r = labelled(&[(1, 10, "Forest", "hob", "193", "2025-01-01"),
                       (2, 10, "Forest", "ltr", "270", "2023-06-23"),
                       (3, 20, "Shock", "hob", "100", "2025-01-01")]);
    let m = r.mask_for(&ScanFilters { sets: vec!["HOB".into()], ..Default::default() });
    assert!(m.permits(&id(1)) && m.permits(&id(3)) && !m.permits(&id(2)));
}

#[test]
fn a_date_range_is_inclusive_at_both_ends() {
    let r = /* same three rows */;
    let both = ScanFilters { released_from: Some("2023-06-23".into()), released_to: Some("2025-01-01".into()), ..Default::default() };
    assert_eq!(r.mask_for(&both).len(), Some(3));
    let later = ScanFilters { released_from: Some("2023-06-24".into()), ..Default::default() };
    assert!(!r.mask_for(&later).permits(&id(2)));
}

#[test]
fn empty_filters_are_unrestricted() {
    assert!(r.mask_for(&ScanFilters::default()).is_unrestricted());
}

#[test]
fn a_name_read_cannot_resolve_to_a_card_with_no_permitted_printing() {
    let ltr = r.mask_for(&ScanFilters { sets: vec!["ltr".into()], ..Default::default() });
    assert_eq!(r.lookup_by_name_masked("shock", &ltr), None);
    assert_eq!(r.lookup_by_name_masked("forest", &ltr), Some((id(10), 0)));
}

#[test]
fn a_collector_read_skips_a_pairing_that_names_an_excluded_printing() {
    let ltr = r.mask_for(&ScanFilters { sets: vec!["ltr".into()], ..Default::default() });
    let c = vec![("hob".to_string(), "193".to_string()), ("ltr".to_string(), "270".to_string())];
    assert_eq!(r.lookup_collector_masked(&c, &ltr), Some(id(2)));
}

#[test]
fn printings_of_lists_every_reprint_of_a_card() {
    assert_eq!(r.printings_of(&id(10)).len(), 2);
}
```

`mask_for`: empty filters → `Mask::all()`. Otherwise iterate every label and permit it when `sets` is empty or holds `label.set` case-insensitively, **and** `label.released` (a `YYYY-MM-DD` string, compared lexicographically) is `>= released_from` and `<= released_to` for each bound that is set. A label with an empty `released` fails any date bound.

- [ ] **Step 2: `Tracker::commit_to` — tests first** (`track.rs`)

```rust
#[test]
fn commit_to_freezes_on_the_given_card_and_ten_absent_frames_release_it() {
    let mut t = Tracker::default(); // Votes rule, reset_after_misses = 10
    t.commit_to(id(7), id(70));
    assert!(t.last_committed());
    for _ in 0..9 {
        assert!(t.observe(&[]).committed);
    }
    assert!(!t.observe(&[]).committed);
}

#[test]
fn commit_to_reports_the_member_as_the_leaders_printing() {
    let mut t = Tracker::default();
    t.commit_to(id(7), id(70));
    let s = t.observe(&[Observation::appearance(id(7), id(71), 0.2)]);
    assert_eq!(s.leader().unwrap().best_member, id(70));
}
```

Implementation: `reset()`, force `self.opts.rule = CommitRule::Votes` (a freeze only exists under votes), seed `scores[key]` at twice `decide_at`, `seen[key] = 1`, `members[key] = {member: 1e6}` (so later appearance frames cannot move the reported printing), `best_n[key] = 0.0`, `leader = Some(key)`, `frozen = true`. Read how `observe` and `snapshot` treat a frozen tally first. If `snapshot().committed` is not true after the seed, adjust the seed, not the commit rule.

- [ ] **Step 3: `resolve.rs` — the tier pipeline, tests first**

```rust
pub struct BurstView<'a> {
    pub upright: &'a RgbImage,
    pub flipped: &'a RgbImage,
    pub alternates: &'a [(RgbImage, RgbImage)],
    pub cardness: f32,
}

/// What the readers found — injected, so the tiers are testable without models.
pub trait Readers {
    /// The normalized title text when the read is usable.
    fn title(&self, view: &BurstView) -> Option<String>;
    /// The collector line's (set, number) parse candidates.
    fn collector(&self, view: &BurstView) -> Vec<(String, String)>;
}
pub struct NoReaders;

pub fn resolve(r: &Reference, mask: &Mask, burst: &[BurstView], readers: &dyn Readers,
               max_normalized: f32) -> ResolutionView
```

Push one `TierView` per tier, in order:

1. **`filters`** — survivors = `mask.len()`, or the bundle's card-section length when unrestricted. Detail: `"unrestricted"` or `"N printings"`.
2. **`whole_card`** — for each view, `r.match_views(&views, EXACT_TOP, mask)`, where `views` is `(upright, flipped)` followed by the alternates. Keep candidates with `normalized <= max_normalized`, taking the best normalized per printing across the burst. Survivors = those printings. Detail: `"N printings of M cards"`.
3. **`title`** — sort the views by `cardness`, descending. Call `readers.title` on the first, and on the second only if the first returned `None`.
   - A read that resolves through `lookup_by_name_masked`: survivors = `printings_of(oracle)` filtered by `mask.permits`, deliberately **not** intersected with tier 2. Detail: `read "<text>" → <name> (edits e)`.
   - Otherwise survivors are unchanged. Detail: `no read`, or `read "<text>", no card`.
4. **`collector`** — the same two-view walk with `readers.collector`, resolved through `lookup_collector_masked`.
   - The printing's oracle is among the survivors' oracles: survivors = `[printing]`. Detail: `<SET> <num> → <label.display()>`.
   - It names another card: survivors unchanged. Detail: `conflict: <SET> <num> is <name>, not among survivors`.
   - Nothing resolved: survivors unchanged, `no read`.
5. **`re_rank`** — with one survivor, pass through. Otherwise take each survivor's best distance in bits (`normalized × bundle.bits`) across the burst.
   - A survivor added by a name read and never matched in tier 2 is scored by searching the burst with `Mask::allow_only(survivors)` at `k = survivors.len()`.
   - Sort ascending. If `second − best >= EXACT_MARGIN_BITS`, survivors = `[best]`; otherwise keep every survivor within `EXACT_MARGIN_BITS` of the best. Detail: `margin m bits`.
6. **`classifier`** — unchanged, detail `not implemented`.

Outcome: 0 survivors → `NotFound`, 1 → `Resolved`, otherwise `Ambiguous` with the first `EXACT_MAX_CHOICES`, best first. `choices` carry `r.label_for` and the best normalized distance (`None` for a printing never matched). `elapsed_ms` is wall time.

Tests: build a small `Bundle` from generated images the way `reference.rs::tests` does with `img(seed)`, attach labels with `add_label`, and use a `FakeReaders { title: Option<String>, collector: Vec<(String, String)> }`:

```rust
#[test] fn a_clean_hash_with_no_reads_resolves_to_the_nearest_printing() { /* burst of img(5); outcome Resolved; choices[0].id == id(5) */ }
#[test] fn a_name_read_reaches_a_printing_the_hash_never_found() { /* burst of an image far from every bundle entry; title names card X; X's printing is among choices */ }
#[test] fn a_collector_read_of_another_card_is_a_conflict_and_ignored() { /* tiers[3].detail starts with "conflict" and survivors unchanged */ }
#[test] fn reprints_inside_the_margin_are_ambiguous_best_first() { /* two printings of one oracle hashed from the same image -> Ambiguous, 2 choices */ }
#[test] fn more_than_twelve_survivors_report_twelve() { /* 14 printings of one oracle, name read resolves it, all identical images -> choices.len() == 12 */ }
#[test] fn nothing_inside_the_gate_and_no_read_is_not_found() {}
#[test] fn every_tier_is_reported_in_order() { /* ["filters","whole_card","title","collector","re_rank","classifier"] */ }
#[test] fn the_mask_excludes_a_printing_from_every_tier() { /* a masked-out exact image never appears in any choice */ }
```

The production `Readers` lives in `session.rs` under `#[cfg(feature = "ocr")]`. It wraps `TitleReader` and returns `read.normalized` when `read.is_usable()` for the title and `col.candidates` for the collector, and it keeps the last `OcrView`/`CollectorView` it produced (a `RefCell`) so a resolve frame can fill the verdict's `ocr` and `collector` keys.

- [ ] **Step 4: `TitleReader::from_bytes`** (`ocr.rs`)

Mirror `load`, using rten 0.26's in-memory loader. Check `rten::Model` in `~/.cargo/registry/src/*/rten-0.26*/src/model.rs` for the exact name, and prefer one taking owned or borrowed bytes over one demanding `'static`. Refactor `load` to read both files and call `from_bytes`. No new test: the models are not in the repo, and `load`'s existing behaviour is the fence.

- [ ] **Step 5: Session — mode, filters, Fast cadence, Exact trigger, decision — tests first** (`session.rs`)

New `Session` fields: `mask: Mask`, `filters: ScanFilters`, `mode: ScanMode`, `decision_seq: u64`, `was_committed: bool`, `leaderless_locked: u32`, `steady: u32` (consecutive trusted frames with a detection), `attempted: bool` (a resolve ran in this stretch), `burst: VecDeque<StoredView>` (owned `rectified`, `rectified_180`, `alternates` and `cardness`, capacity `EXACT_BURST`), and `last_resolution: Option<ResolutionView>`.

Rules, in `frame_inner`:
- **Mode switch.** `opts.mode != self.mode` → set it, then `reset()`, which clears the tracker, lock, burst and counters but **not** `decision_seq`.
- **Mask.** Pass `&self.mask` wherever `Mask::all()` is passed today.
- **Stretch counter.** A trusted frame with a detection increments `steady`. Any other frame sets it to 0, sets `attempted = false` and clears `burst`.
- **Fast.** Readers are eligible only when `!settled && leaderless_locked >= FAST_RESCUE_AFTER`, then `due()` applies as today, and **only `read_title`** runs (no collector read). `leaderless_locked` increments on trusted uncommitted frames and resets to 0 on commit, or whenever `steady` resets.
- **Exact.** No per-frame readers. While trusted, push the frame's views into `burst`. When `steady >= EXACT_STEADY_FRAMES && !settled && !attempted && burst.len() == EXACT_BURST`:
  - run `resolve::resolve(r, &self.mask, &views, &readers, self.tracker.options().max_normalized)`;
  - set `attempted = true`, put the result in `v.resolution`, and fill `v.ocr`/`v.collector` from the readers' last views;
  - on `Resolved` or `Ambiguous`, call `tracker.commit_to(r.oracle_for(&best), best)` **before** this frame's `tracker.observe`, and keep the result in `last_resolution`.
- **Decision bookkeeping, after `tracker.observe`.**
  - `tracked.committed && !self.was_committed` → `decision_seq += 1`.
  - `!tracked.committed && self.was_committed` → `attempted = false`, `last_resolution = None`.
  - Then `was_committed = tracked.committed`.
- **`v.decision`, on every committed frame.** Fast: `printing` = the leader's `best_member`, `outcome: Resolved`, `choices: []`. Exact: from `last_resolution`, with `printing` = its first choice.
- **Every verdict**, including `Verdict::failed` (thread the two values through), carries `v.mode = self.mode` and `v.decision_seq = self.decision_seq`.
- **`set_filters(f)`:**
  - `f.is_empty()` → `Mask::all()`, Ok.
  - No reference, or `label_count() == 0` → `Err("Filters need card names, and the scanner has none loaded — it needs corpus.db beside the bundle.")`.
  - Otherwise build with `mask_for`. `mask.len() == Some(0)` → `Err("No printing matches these filters.")`, keeping the previous mask.
  - On Ok: store both, then `reset()`.

Tests. There are no models and no card photo, so drive the counters through seams. Add `#[cfg(test)]` helpers only where the frame path cannot reach the state:

```rust
#[test] fn decision_seq_moves_once_per_commit_and_not_on_frozen_frames() {}
#[test] fn fast_mode_runs_no_reader_before_the_eighth_leaderless_locked_frame() {}
#[test] fn switching_mode_resets_the_tracker_but_keeps_decision_seq() {}
#[test] fn filters_without_labels_are_a_sentence() {}
#[test] fn filters_that_match_nothing_are_a_sentence_and_keep_the_old_mask() {}
#[test] fn a_failed_verdict_still_carries_mode_and_decision_seq() {}
```

Update the existing `the_reader_runs_every_fourth_frame_and_stands_down_once_decided` so it exercises `ScanMode::Fast` past the rescue threshold.

- [ ] **Step 6: The debug server and page**

- `bin/serve.rs::options_from_query` reads `mode` (`fast`/`exact`, default fast).
- `POST /filters?sets=hob,ltr&from=YYYY-MM-DD&to=YYYY-MM-DD` calls `set_filters` and answers `{"ok": bool, "error": string|null}`.
- `live.html` gains:
  - a `mode: fast | exact` segment carried on the frame query;
  - a sets text field and two date inputs that post to `/filters`;
  - a block in the Match panel showing `decision_seq`, `decision`, and `resolution.tiers` as tier / survivors / detail.
- Add `mode` to `the_query_string_and_the_json_spell_the_same_options`.
- Run `node crates/card-scanner/scripts/check-live-page.mjs` after editing `live.html` (§6 says why).

- [ ] **Step 7: Run the crate's suite, and clippy on the new files**

Run: `cargo test --locked --features cli --manifest-path crates/card-scanner/Cargo.toml`
Expected: PASS, including `every_key_the_debug_page_reads_is_in_the_verdict`.

Run: `cargo clippy --locked --features cli --manifest-path crates/card-scanner/Cargo.toml`
Expected: no warning in `filters.rs`, `resolve.rs` or the lines you added (four pre-existing warnings elsewhere are known — §8.10).

Run: `cargo fmt --manifest-path crates/card-scanner/Cargo.toml -- --check crates/card-scanner/src/filters.rs crates/card-scanner/src/resolve.rs`

- [ ] **Step 8: Commit**

```bash
git add crates/card-scanner/src
git commit -m "feat(scanner): set and date filters through every tier, Fast and Exact modes, and one decision per card"
```

---

### Task 2: Shipping — the bundle workflow, the release step, and the embedded-assets cfg

**Files:**
- Modify: `crates/card-scanner/src/bin/build_hashes.rs` (`--bulk`), `crates/card-scanner/Cargo.toml` (only if `--bulk` needs a feature change), `.github/workflows/release.yml`, `src-tauri/build.rs`, `package.json` (one script), `.gitignore`
- Create: `.github/workflows/scanner-bundle.yml`, `scripts/scanner-assets.mjs`, `src-tauri/scanner-assets/README.md`

**Interfaces:**
- Consumes: nothing from T1.
- Produces:
  - `cfg(scanner_assets)` — set by `src-tauri/build.rs` when `src-tauri/scanner-assets/{card-hashes.bin,text-detection.rten,text-recognition.rten}` all exist. T3 `include_bytes!`s them under it.
  - `npm run scanner:assets` — downloads the three into `src-tauri/scanner-assets/` from release `scanner-bundle-v<FORMAT_VERSION>`.
  - `build-hashes --bulk <default-cards.json>`, an alternative to `--corpus`.

- [ ] **Step 1: `build-hashes --bulk` — test first**

`corpus` becomes `Option<PathBuf>`, joined by `bulk: Option<PathBuf>`; exactly one is required (clap `ArgGroup` with `required = true`). The row source becomes a function yielding `(id, illustration_id: Option<String>, image_uris_json: String)`, the shape the `SELECT id, illustration_id, image_uris FROM cards WHERE image_uris IS NOT NULL` query yields today. Two sources:
- `rows_from_corpus(&Connection)` — the existing query, moved.
- `rows_from_bulk(reader: impl Read)` — **streams** the top-level JSON array with `serde_json::Deserializer::from_reader` and a `SeqAccess` visitor that deserializes one card at a time into `struct BulkCard { id: String, illustration_id: Option<String>, image_uris: Option<serde_json::Value> }`, skipping cards without `image_uris`, and re-serializing `image_uris` to the string the corpus path stores. The file is hundreds of megabytes; never `from_str` the whole thing. Wrap the file in a `BufReader`.

Test in `build_hashes.rs`'s test module (add one if absent, under `#[cfg(test)]`):

```rust
#[test]
fn a_bulk_file_yields_the_rows_the_corpus_query_does() {
    let json = r#"[
      {"id":"00000000-0000-0000-0000-000000000001","illustration_id":"00000000-0000-0000-0000-0000000000aa",
       "image_uris":{"small":"https://cards.scryfall.io/small/front/0/0/1.jpg?1"}},
      {"id":"00000000-0000-0000-0000-000000000002","card_faces":[{}]}
    ]"#;
    let rows: Vec<_> = rows_from_bulk(json.as_bytes()).collect::<Result<_, _>>().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "00000000-0000-0000-0000-000000000001");
    assert!(rows[0].2.contains("cards.scryfall.io/small"));
}
```

Run: `cargo test --locked --features builder --bin build-hashes --manifest-path crates/card-scanner/Cargo.toml`. **Only after T1 has reported done** — `--features builder` compiles the library T1 is editing. If T1 is still running, report the test as unrun, and T7 runs it.

- [ ] **Step 2: `src-tauri/build.rs` — the cfg**

At the very top of `main()`, before the wasm early return (so `unexpected_cfgs` never fires on any target):

```rust
println!("cargo:rustc-check-cfg=cfg(scanner_assets)");
```

After the wasm return, before `tauri_build::build()`:

```rust
// **The three load together or the cfg is off.** A bundle embedded without its models, or
// the reverse, is a half-shipped scanner — see the 2026-09-15 scanner spec §4.2.
let assets = std::path::Path::new("scanner-assets");
println!("cargo:rerun-if-changed=scanner-assets");
let names = ["card-hashes.bin", "text-detection.rten", "text-recognition.rten"];
for n in names {
    println!("cargo:rerun-if-changed=scanner-assets/{n}");
}
if names.iter().all(|n| assets.join(n).is_file()) {
    println!("cargo:rustc-cfg=scanner_assets");
}
```

`rerun-if-changed` on a path that does not exist makes cargo rerun the script on every build, so the directory must always exist. That is what `scanner-assets/README.md` is for. Per-file lines for absent files have the same effect: emit the per-file lines **only for files that exist**, and rely on the directory line (its mtime moves when a file is added) for the rest.

- [ ] **Step 3: `src-tauri/scanner-assets/README.md` and `.gitignore`**

The README says, in a few lines, what the three files are, that `npm run scanner:assets` fetches them, that `build.rs` embeds them only when all three are present, and that a file in `data/scanner/` still overrides the embedded copy. `.gitignore` gains:

```
src-tauri/scanner-assets/*
!src-tauri/scanner-assets/README.md
```

- [ ] **Step 4: `scripts/scanner-assets.mjs` and the npm script**

Node ESM, no dependencies:
- Read `FORMAT_VERSION` from `crates/card-scanner/src/index.rs` with the regex `/pub const FORMAT_VERSION: u8 = (\d+);/` (confirm the declaration's exact spelling first and match it; fail loudly if it is not found).
- Download `card-hashes.bin`, `text-detection.rten` and `text-recognition.rten` from `https://github.com/Msgaihede/mtg-grimoire/releases/download/scanner-bundle-v<N>/<name>` into `src-tauri/scanner-assets/`, following redirects, with a `User-Agent`.
- Write to `<name>.part`, then rename, so a failed download never leaves a truncated file that `build.rs` would embed.
- Skip a file that is already present with the same size as the `content-length`.
- Exit non-zero on any failure.

`package.json` → `"scanner:assets": "node scripts/scanner-assets.mjs"`. Confirm the repository slug with `gh repo view --json nameWithOwner --jq .nameWithOwner` before hard-coding it.

- [ ] **Step 5: `.github/workflows/scanner-bundle.yml`**

```yaml
name: scanner-bundle
on:
  workflow_dispatch:
  schedule:
    - cron: "17 4 * * 1"   # weekly: actions/cache evicts entries unused for 7 days
permissions:
  contents: write
concurrency:
  group: scanner-bundle
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: crates/card-scanner
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Format version
        id: fv
        run: echo "v=$(grep -oP 'pub const FORMAT_VERSION: u8 = \K\d+' crates/card-scanner/src/index.rs)" >> "$GITHUB_OUTPUT"
      - name: Scryfall default_cards
        run: |
          url=$(curl -sfL -H 'User-Agent: mtg-grimoire-scanner-bundle' -H 'Accept: application/json' \
            https://api.scryfall.com/bulk-data/default-cards | jq -r .download_uri)
          curl -sfL -H 'User-Agent: mtg-grimoire-scanner-bundle' -o default-cards.json "$url"
      - uses: actions/cache/restore@v4
        with:
          path: card-hashes-cache.db
          key: scanner-cache-v${{ steps.fv.outputs.v }}-${{ github.run_id }}
          restore-keys: scanner-cache-v${{ steps.fv.outputs.v }}-
      - name: Build the bundle
        run: cargo run --locked --release --bin build-hashes --features builder --manifest-path crates/card-scanner/Cargo.toml -- --bulk default-cards.json --cache card-hashes-cache.db --out card-hashes.bin --sections card
      - uses: actions/cache/save@v4
        if: always()
        with:
          path: card-hashes-cache.db
          key: scanner-cache-v${{ steps.fv.outputs.v }}-${{ github.run_id }}
      - name: OCR models
        run: node crates/card-scanner/scripts/fetch-ocr-models.mjs models
      # T6 adds the eval step here.
      - name: Publish if changed
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: scanner-bundle-v${{ steps.fv.outputs.v }}
        run: |
          if ! gh release view "$TAG" >/dev/null 2>&1; then
            gh release create "$TAG" --prerelease --latest=false --title "Scanner bundle v${{ steps.fv.outputs.v }}" \
              --notes "Card hashes and OCR models embedded by release builds. Built by scanner-bundle.yml."
          fi
          if gh release download "$TAG" -p card-hashes.bin -O old.bin 2>/dev/null && cmp -s old.bin card-hashes.bin; then
            echo "Bundle unchanged; nothing published." >> "$GITHUB_STEP_SUMMARY"
          else
            gh release upload "$TAG" card-hashes.bin models/text-detection.rten models/text-recognition.rten --clobber
            echo "Published $(stat -c%s card-hashes.bin) bytes to $TAG." >> "$GITHUB_STEP_SUMMARY"
          fi
```

Before writing it, match the action versions to those already in `.github/workflows/ci.yml` and `release.yml`, and read `.github/CLAUDE.md` (the `changes` router, and whether a new workflow needs a routing entry or a `ci-ok` exemption). Check whether `build-hashes`' header stamps `built_at` from the clock: if it does, the `cmp` will always differ, so compare the entry bytes past the 32-byte header instead (`cmp -s -i 32`).

- [ ] **Step 6: `release.yml` — fetch before build**

On the build job, immediately after `npm ci` and before `tauri-apps/tauri-action`:

```yaml
      # The scanner's hash bundle and OCR models are embedded into the binary (build.rs sets
      # cfg(scanner_assets)). A release without them cannot scan, so this fails the leg.
      - name: Scanner assets
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: npm run scanner:assets
```

- [ ] **Step 7: Commit**

```bash
git add crates/card-scanner/src/bin/build_hashes.rs .github/workflows/scanner-bundle.yml .github/workflows/release.yml scripts/scanner-assets.mjs package.json src-tauri/build.rs src-tauri/scanner-assets/README.md .gitignore
git commit -m "ci(scanner): build the hash bundle weekly, publish it with the models, and embed all three in release builds"
```

---

### Task 3: The app's commands, the IPC mirror, the fixtures and the fake

**Files:**
- Modify: `src-tauri/src/scanner.rs`, `src-tauri/src/lib.rs` (register four commands), `src/lib/ipc.ts` (scanner section, ~6240–6520 and ~9153–9177), `src/lib/ipc.test.ts` (mirror rows), `src/features/scanner/types.ts`, `src/features/scanner/fixtures.ts`, `.storybook/fake/db.ts` (`scannerHandlers`, ~19625)
- Test: `scanner.rs` `#[cfg(test)]`, `ipc.test.ts`

**Interfaces:**
- Consumes (T1, exact names): `card_scanner::filters::ScanFilters`, `card_scanner::session::{ScanMode, Session::set_filters, DecisionView, ResolutionView, ChoiceView, TierView, Outcome}`, `card_scanner::ocr::TitleReader::from_bytes`; (T2) `cfg(scanner_assets)`.
- Produces (T4/T5 rely on these):
  - Rust: `#[serde(rename_all = "lowercase")] pub enum AssetSource { File, Embedded, Absent }`; `Asset::source: AssetSource`.
  - Rust commands: `scanner_set_filters(filters: ScanFilters) -> Result<(), String>`, `scanner_prefs() -> ScannerPrefs`, `set_scanner_prefs(prefs: ScannerPrefs) -> Result<(), String>`, `scanner_tray() -> Vec<ScannerTrayRow>`, `set_scanner_tray(rows: Vec<ScannerTrayRow>) -> Result<(), String>`.
  - Rust structs, `#[serde(rename_all = "camelCase", default)]`:
    - `ScannerPrefs { mode: ScanMode, filters: ScanFilters, finish: String /* "nonfoil" */, condition: String /* "NONE" */, folder_id: Option<i64>, developer: bool }`
    - `ScannerTrayRow { key: String, card_id: String, oracle_id: Option<String>, name: String, set_code: String, collector_number: String, finish: String, quantity: i64, choices: Vec<ScannerTrayChoice>, added_at: i64 }`
    - `ScannerTrayChoice { card_id: String, oracle_id: Option<String>, name: String, set_code: String, collector_number: String }`
  - TS types (exported from `@/lib/ipc`): `ScanMode = "fast" | "exact"`; `ScanFilters { sets: string[]; released_from: string | null; released_to: string | null }`; `ScannerOutcome = "resolved" | "ambiguous" | "not_found"`; `ScannerChoice { id: string; oracle_id: string | null; label: ScannerLabel | null; distance: number | null }`; `ScannerDecision { printing: string; oracle_id: string | null; label: ScannerLabel | null; outcome: ScannerOutcome; choices: ScannerChoice[] }`; `ScannerTier { tier: "filters" | "whole_card" | "title" | "collector" | "re_rank" | "classifier"; survivors: number; detail: string }`; `ScannerResolution { outcome: ScannerOutcome; choices: ScannerChoice[]; tiers: ScannerTier[]; elapsed_ms: number }`; `ScannerAssetSource = "file" | "embedded" | "absent"`; `ScannerPrefs { mode: ScanMode; filters: ScanFilters; finish: Finish; condition: Condition; folderId: number | null; developer: boolean }`; `ScannerTrayChoice { cardId: string; oracleId: string | null; name: string; setCode: string; collectorNumber: string }`; `ScannerTrayRow { key: string; cardId: string; oracleId: string | null; name: string; setCode: string; collectorNumber: string; finish: Finish; quantity: number; choices: ScannerTrayChoice[]; addedAt: number }`. (Use whatever the existing TS label type for the crate's `Label` is named — find it beside `ScannerStanding`.)
  - `ScannerOptions.mode: ScanMode`; `ScannerVerdict` gains `mode: ScanMode; decision_seq: number; decision: ScannerDecision | null; resolution: ScannerResolution | null`; `ScannerAsset.source: ScannerAssetSource`.
  - `ipc.scannerSetFilters(filters: ScanFilters): Promise<void>`, `ipc.scannerPrefs(): Promise<ScannerPrefs>`, `ipc.setScannerPrefs(prefs: ScannerPrefs): Promise<void>`, `ipc.scannerTray(): Promise<ScannerTrayRow[]>`, `ipc.setScannerTray(rows: ScannerTrayRow[]): Promise<void>`.
  - `fixtures.ts`: `DEFAULT_SCANNER_PREFS: ScannerPrefs`; `STATUS.present` (bundle `source: "file"`), `STATUS.embedded` (all three `"embedded"`), `STATUS.missing`; `VERDICTS` gains `exactResolved`, `exactAmbiguous` (3 choices of one card), `exactNotFound` — each with a `resolution` whose `tiers` has all six rows — and every existing verdict gains `mode`, `decision_seq`, `decision`, `resolution`; `TRAY_ROWS: ScannerTrayRow[]` (4 rows: two resolved, one ×3 quantity, one with 3 choices).

- [ ] **Step 1: Rust tests first** (`scanner.rs` tests)

```rust
#[test]
fn a_file_beats_the_embedded_copy_and_says_so() {
    let dir = tempdir(); // follow the existing tests' temp-dir helper
    write_bundle(&dir.join("scanner").join(BUNDLE_FILE)); // a valid tiny bundle, as a_bundle_with_no_corpus_beside_it does
    let l = load(&dir.join("scanner"), &dir.join("corpus.db"), 5, Embedded { bundle: Some(TINY_BUNDLE_BYTES), models: None });
    assert_eq!(l.status.bundle.source, AssetSource::File);
}
#[test]
fn with_no_file_the_embedded_bundle_loads() { /* source Embedded, loaded true */ }
#[test]
fn nothing_anywhere_is_absent() { /* Embedded::none() -> source Absent, present false */ }
#[test]
fn prefs_round_trip_through_app_meta_and_default_when_unset() {
    let conn = in-memory user db with app_meta (use the helper home.rs's tests use);
    assert_eq!(stored_prefs(&conn), ScannerPrefs::default());
    let p = ScannerPrefs { mode: ScanMode::Exact, developer: true, folder_id: Some(4), ..Default::default() };
    store_prefs(&conn, &p).unwrap();
    assert_eq!(stored_prefs(&conn), p);
}
#[test]
fn a_tray_row_with_zero_quantity_is_refused_with_a_sentence() {}
#[test]
fn an_unreadable_stored_tray_reads_as_empty_rather_than_failing() {}
```

`Embedded` is a new struct: `pub struct Embedded { pub bundle: Option<&'static [u8]>, pub models: Option<(&'static [u8], &'static [u8])> }` with `fn none()` and, under `#[cfg(scanner_assets)]`, `fn compiled()` returning `include_bytes!("../scanner-assets/card-hashes.bin")` etc. (`#[cfg(not(scanner_assets))] fn compiled() -> Embedded { Embedded::none() }`). `ScannerState::ensure` passes `Embedded::compiled()`. For a test bundle, build one with `card_scanner::index::BundleBuilder` and `Box::leak(bundle.to_bytes().into_boxed_slice())`.

- [ ] **Step 2: Implement `scanner.rs`**

- `load(dir, corpus, top, embedded)`: per asset, file first (today's code), else embedded bytes (`Bundle::from_bytes(bytes)`, `TitleReader::from_bytes(det, rec)`), else absent. `Asset.path` stays the file path it looked at, so the "put it here" sentence still names a path when absent. Models stay a pair: a pair is `File` only if both files exist; otherwise the embedded pair; otherwise absent.
- Prefs and tray, modelled on `src-tauri/src/home.rs` (`K_HOME_LAYOUT` :61, read at :254 through `crate::sync::lock_db_read` + `get_app_meta`, write at :267 through `spawn_blocking` + `crate::sync::with_write` + `set_app_meta`). Keys `K_SCANNER_PREFS = "scanner_prefs"`, `K_SCANNER_TRAY = "scanner_tray"`. A stored value that does not parse reads as the default (prefs) or empty (tray) — never an error. `set_scanner_tray` refuses a row with `quantity < 1` (`"A tray row needs at least one copy."`) or more than 5,000 rows (`"The tray holds at most 5,000 rows — add these to the collection first."`).
- `scanner_set_filters`: `ensure()`, then `session.set_filters(filters)`; the `Err` string is the command's error.
- Keep every existing `#[cfg(not(target_family = "wasm"))]` gate pattern for the new commands; register all five in `lib.rs`'s `generate_handler!` beside the existing four. **Check `src-tauri/CLAUDE.md` for whether a command census test (e.g. a `web::route` census or a command-list test) must be told about new desktop-only commands**, and update it.
- Read `src-tauri/CLAUDE.md` and check whether `app_meta` keys have a registry/census that must list the two new keys.

- [ ] **Step 3: IPC types, functions, mirror rows**

Add the TS types and five functions from **Interfaces**. `ScanFilters`, `ScannerChoice`, `ScannerDecision`, `ScannerTier`, `ScannerResolution` are snake case → rows in `snakeMirrors` (`["ScannerChoice", resolveRs, "ChoiceView"]` etc., adding `import resolveRs from "../../crates/card-scanner/src/resolve.rs?raw"` and `filtersRs`). `ScannerPrefs`, `ScannerTrayRow`, `ScannerTrayChoice` are camel case → rows in `mirrors`. `ScannerAsset` already has a row; it now also carries `source`.

`ScannerOptions.mode` rides the existing `x-scanner-options` header, already escaped by `asciiJson` — no new header.

- [ ] **Step 4: `types.ts`, `fixtures.ts`, the fake**

Re-export the new types from `src/features/scanner/types.ts`. Update `fixtures.ts` as listed under **Interfaces** — every `ScannerVerdict` literal must type-check with the four new required fields. `scannerHandlers(db)` gains five handlers backed by two in-memory fields initialised per fake db (`scannerPrefs: DEFAULT_SCANNER_PREFS`, `scannerTray: []`): `scanner_set_filters` answers `undefined` (or throws `"No printing matches these filters."` when `filters.sets` includes `"zzz"`, so a story can show the refusal), `scanner_prefs`/`set_scanner_prefs`, `scanner_tray`/`set_scanner_tray`. Read `.storybook/CLAUDE.md` first — how per-db state is declared, how a handler throws an IPC error, and the fault census rule if you add a fault (prefer not to).

- [ ] **Step 5: Commit** (tests run at T7)

```bash
git add src-tauri/src/scanner.rs src-tauri/src/lib.rs src/lib/ipc.ts src/lib/ipc.test.ts src/features/scanner/types.ts src/features/scanner/fixtures.ts .storybook/fake/db.ts
git commit -m "feat(scanner): load embedded assets after data/scanner, set filters, and keep prefs and the tray in app_meta"
```

---

### Task 4: The tray model and the reader-facing components

**Files (all new):**
- `src/features/scanner/reader/tray.ts`, `tray.test.ts` — the pure reducer
- `src/features/scanner/reader/readerText.ts`, `readerText.test.ts` — the status line and filter summary
- `src/features/scanner/reader/ScanBar.tsx`, `ScanBar.test.tsx`, `ScanBar.stories.tsx`
- `src/features/scanner/reader/TrayPanel.tsx`, `TrayPanel.test.tsx`, `TrayPanel.stories.tsx`

**Interfaces:**
- Consumes (T3, from `@/lib/ipc`): `ScanMode`, `ScanFilters`, `ScannerDecision`, `ScannerResolution`, `ScannerVerdict`, `ScannerPrefs`, `ScannerTrayRow`, `ScannerTrayChoice`, `CollectionImportItem`, `SetSummary`; `Finish` (`@/lib/finish`), `Condition` (`@/lib/conditions`); fixtures `TRAY_ROWS`, `VERDICTS`, `DEFAULT_SCANNER_PREFS` from `../fixtures`.
- Produces (T5 relies on these):

```ts
// tray.ts
export interface RowDefaults { finish: Finish }
export function rowFromDecision(d: ScannerDecision, defaults: RowDefaults, now: number, key: string): ScannerTrayRow;
/** Newest first. A resolved decision naming the newest row's printing (and that row has no choices) bumps its quantity instead of adding. Returns the rows and whether it bumped. */
export function addDecision(rows: readonly ScannerTrayRow[], d: ScannerDecision, defaults: RowDefaults, now: number, key: string): { rows: ScannerTrayRow[]; bumped: boolean };
export function setQuantity(rows: readonly ScannerTrayRow[], key: string, quantity: number): ScannerTrayRow[]; // clamps to >= 1
export function setFinish(rows: readonly ScannerTrayRow[], key: string, finish: Finish): ScannerTrayRow[];
export function pickChoice(rows: readonly ScannerTrayRow[], key: string, cardId: string): ScannerTrayRow[]; // adopts the choice's ids/name/set/number, clears choices
export function setPrinting(rows: readonly ScannerTrayRow[], key: string, p: ScannerTrayChoice): ScannerTrayRow[]; // for "More printings…"
export function removeRow(rows: readonly ScannerTrayRow[], key: string): ScannerTrayRow[];
export function unresolvedCount(rows: readonly ScannerTrayRow[]): number; // rows with choices.length > 0
export function totalCopies(rows: readonly ScannerTrayRow[]): number;
export function importItems(rows: readonly ScannerTrayRow[], condition: Condition): CollectionImportItem[]; // {cardId, quantity, finish, condition}; throws if any row is unresolved

// readerText.ts
export type LastAdded = { name: string; setCode: string; collectorNumber: string; bumpedTo: number | null } | null;
export function statusLine(verdict: ScannerVerdict | null, mode: ScanMode, lastAdded: LastAdded, hasBundle: boolean, lastResolution: ScannerResolution | null): string;
export function filterSummary(filters: ScanFilters): string; // "Any set" | "HOB, LTR" | "HOB · from 2023-06-23" | "3 sets · 2020-01-01 – 2024-12-31"

// ScanBar.tsx
export interface ScanBarProps {
  mode: ScanMode; onMode: (m: ScanMode) => void;
  filters: ScanFilters; onFilters: (f: ScanFilters) => void;
  filterError: string | null;            // the last set_filters refusal, drawn inside the popover
  filtersDisabled: string | null;        // a reason, or null when filters can be used
  finish: Finish; onFinish: (f: Finish) => void;
  condition: Condition; onCondition: (c: Condition) => void;
  developer: boolean; onDeveloper: (on: boolean) => void;
}
// TrayPanel.tsx
export interface TrayPanelProps {
  rows: readonly ScannerTrayRow[];
  onRows: (rows: ScannerTrayRow[]) => void;
  folderId: number | null; onFolder: (id: number | null) => void;
  onCommit: () => void; committing: boolean; commitError: string | null;
  onMorePrintings: (row: ScannerTrayRow) => void;
  flashKey: string | null;               // the row just added or bumped, for the flash
}
```

Before any UI: invoke the `frontend-design` skill, read `src/CLAUDE.md` and `docs/superpowers/specs/2026-08-04-visual-design-direction.md`. **The Storybook MCP server is not connected in this session** — read each design-system component's source and its stories for its props instead of guessing, and say in your report which components you checked that way.

- [ ] **Step 1: `tray.test.ts` — failing tests**

```ts
import { describe, expect, it } from "vitest";
import { addDecision, importItems, pickChoice, removeRow, rowFromDecision, setQuantity, totalCopies, unresolvedCount } from "./tray";
import { VERDICTS } from "../fixtures";

const resolved = VERDICTS.exactResolved.decision!;
const ambiguous = VERDICTS.exactAmbiguous.decision!;

describe("tray", () => {
  it("adds a resolved decision as a new newest row with the default finish", () => {
    const { rows, bumped } = addDecision([], resolved, { finish: "foil" }, 1, "a");
    expect(bumped).toBe(false);
    expect(rows[0]).toMatchObject({ key: "a", cardId: resolved.printing, quantity: 1, finish: "foil", choices: [] });
  });
  it("bumps the newest row when the same printing is decided again", () => {
    const first = addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows;
    const { rows, bumped } = addDecision(first, resolved, { finish: "nonfoil" }, 2, "b");
    expect(bumped).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(2);
  });
  it("never bumps a row that is still waiting for a pick", () => {
    const first = addDecision([], ambiguous, { finish: "nonfoil" }, 1, "a").rows;
    expect(addDecision(first, ambiguous, { finish: "nonfoil" }, 2, "b").rows).toHaveLength(2);
  });
  it("an ambiguous decision carries its choices and counts as unresolved until picked", () => {
    const rows = addDecision([], ambiguous, { finish: "nonfoil" }, 1, "a").rows;
    expect(rows[0].choices).toHaveLength(3);
    expect(unresolvedCount(rows)).toBe(1);
    const picked = pickChoice(rows, "a", ambiguous.choices[2].id);
    expect(picked[0].cardId).toBe(ambiguous.choices[2].id);
    expect(unresolvedCount(picked)).toBe(0);
  });
  it("clamps quantity to at least one", () => {
    const rows = addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows;
    expect(setQuantity(rows, "a", 0)[0].quantity).toBe(1);
  });
  it("builds import items and refuses while a row is unresolved", () => {
    const rows = addDecision([], resolved, { finish: "etched" }, 1, "a").rows;
    expect(importItems(rows, "NM")).toEqual([{ cardId: resolved.printing, quantity: 1, finish: "etched", condition: "NM" }]);
    const mixed = addDecision(rows, ambiguous, { finish: "nonfoil" }, 2, "b").rows;
    expect(() => importItems(mixed, "NM")).toThrow();
  });
  it("counts copies and removes rows", () => {
    const rows = addDecision(addDecision([], resolved, { finish: "nonfoil" }, 1, "a").rows, resolved, { finish: "nonfoil" }, 2, "b").rows;
    expect(totalCopies(rows)).toBe(2);
    expect(removeRow(rows, "a")).toHaveLength(0);
  });
});
```

(`rowFromDecision` for an `Ambiguous` decision takes the first choice as the row's provisional `cardId`/name and maps every choice to a `ScannerTrayChoice`; a decision with no label uses `name: "Unknown card"`, empty set and number.)

- [ ] **Step 2: Implement `tray.ts`** until the tests pass (they run at T7; write them to pass).

- [ ] **Step 3: `readerText.ts` + tests**

`statusLine`, in priority order (`lastResolution` is the page's last non-null `verdict.resolution`, cleared when a frame has no quad — a resolve is on one frame only):
1. `!hasBundle` → `"The scanner has no card hashes loaded, so it can find a card but not name it."`
2. `verdict === null` or `verdict.quad === null` → `"Point the camera at a card"`
3. `lastResolution?.outcome === "not_found"` → `"No match — try better light, or clear the filters"`
4. `lastResolution?.outcome === "ambiguous"` and `verdict.tracked?.committed` → `"Pick a printing below"`
5. `lastAdded` non-null and `verdict.tracked?.committed` → `lastAdded.bumpedTo ? \`Added ${name} again — ×${bumpedTo}\` : \`Added ${name} — ${SET} ${number}\``
6. Exact, locked, not committed → `"Hold steady — reading the card…"`
7. otherwise → `"Hold steady"`

Test each branch with the fixtures. `filterSummary` per the examples in **Interfaces**; set codes upper-cased; more than two sets → `"N sets"`.

- [ ] **Step 4: `ScanBar.tsx` + test + stories**

A single row that wraps on a narrow window: a two-option segmented control **Fast | Exact** (find the app's existing segmented control — the scanner's `ControlsPanel` has rule/method segments; reuse whatever it uses), a **Filters** button whose label is `filterSummary(filters)` opening a popover (`SetCombobox` from `src/features/search/SetCombobox.tsx` with `selected={filters.sets}` and `onToggle` adding/removing a code; two `type="date"` inputs for from/to; a **Clear** button; `filterError` as an alert line), a **Defaults** button opening a popover with finish (from `FINISHES`) and condition (from `CONDITIONS`) selects, and a **Developer** switch at the end. When `filtersDisabled` is a string, the Filters button is `aria-disabled` and its tooltip (via `useTooltip()`) is that string. Popovers and their z-index follow the Dropdown/LAYER rules in `src/CLAUDE.md`; Escape closes one layer.

Tests (`@testing-library/react` + `userEvent`, matching neighbouring tests' setup): pressing Exact calls `onMode("exact")`; the Filters button shows `"Any set"` for empty filters; a disabled reason makes the button `aria-disabled="true"` and does not open the popover; toggling the Developer switch calls `onDeveloper(true)`; Clear calls `onFilters({ sets: [], released_from: null, released_to: null })`.

Stories: `Default`, `ExactWithFilters`, `FilterRefused` (popover open, `filterError` set), `FiltersDisabled`.

- [ ] **Step 5: `TrayPanel.tsx` + test + stories**

A region labelled **Scanned cards** with a count in its heading (mind the "CSS gap breaks the accessible name" trap — put the count in its own element with a visually separate accessible name). Newest first. Each row: a small art crop through `CardImage` + `cardArtSrc(cardImageUrl(row.cardId, 0, "art"))` exactly as `src/features/decks/PullFromCollectionDialog.tsx:628,685-699` does; name; `SET number` in dim text; a finish select; a quantity stepper (− / value / +); **More printings…** (calls `onMorePrintings(row)`; hidden when `row.oracleId` is null); remove. A row with `choices.length > 0` instead shows *Pick a printing* and its choices as a wrapping row of small `CardImage` buttons labelled `"<name> — <SET> <number>"`; pressing one calls `onRows(pickChoice(…))`. The `flashKey` row gets a brief highlight using a `src/lib/motion.ts` preset (no `AnimatePresence mode="popLayout"`). The row list scrolls (`relative`, `min-h-0 flex-1 overflow-y-auto`).

Footer: a folder picker — `MoveToFolder` from `src/features/decks/MoveToFolder.tsx` with `inline`, `rootLabel="Collection"`, `nodes` from `buildFolderTree(useCollectionFolderList().folders, [])`, and `forbidden` computed the way `src/features/collection/AddToCollection.tsx` computes it around :431 (deck folders are not a destination) — behind a button showing the current folder's name; then **Add N to collection** where N is `totalCopies(rows)`, `aria-disabled` with a tooltip when the tray is empty (`"Nothing scanned yet"`) or `unresolvedCount(rows) > 0` (`"Pick a printing for every card first"`), and `committing` shows a pending state. `commitError` renders as an alert above the footer. Empty tray body: *Cards you scan appear here.*

Tests: rows render newest first with name and set; pressing + calls `onRows` with quantity 2; a choices row shows *Pick a printing* and pressing a choice calls `onRows` with that `cardId`; the add button is `aria-disabled` with an unresolved row and pressing it does not call `onCommit`; with resolved rows it calls `onCommit`; `commitError` is announced as an alert. If `MoveToFolder`/`useCollectionFolderList` need a query client, wrap with the test utility neighbouring collection tests use.

Stories: `Empty`, `Rows` (`TRAY_ROWS`), `NeedsPick`, `Committing`, `CommitRefused`.

- [ ] **Step 6: Commit** (tests run at T7)

```bash
git add src/features/scanner/reader
git commit -m "feat(scanner): the review tray, the mode and filters bar, and the reader's status line"
```

---

### Task 5: The Scanner page — wiring the bar, the tray, the decision and the Tiers panel

Wave 2: starts after T1, T3 and T4 have reported, and after the orchestrator has confirmed `npm run build` type-checks the wave-1 tree.

**Files:**
- Modify: `src/features/scanner/ScannerPage.tsx`, `ScannerPage.test.tsx`, `ScannerPage.stories.tsx`, `useScanLoop.ts`, `useScanLoop.test.ts`, `ScannerPanels.tsx`, `verdictText.ts`, `verdictText.test.ts`, `src/lib/store.ts` (`PrintingsRequest`), `src/features/card/AllPrintingsDialog.tsx`
- Create: `src/features/scanner/useScannerPrefs.ts`, `useScannerPrefs.test.ts`, `src/features/scanner/useTray.ts`, `useTray.test.ts`, `src/features/scanner/panels/TiersPanel.tsx`, and a `TiersPanel` story in `ScannerPanels.stories.tsx`

**Interfaces:**
- Consumes: T3's IPC and fixtures; T4's `ScanBar`, `TrayPanel`, `tray.ts`, `readerText.ts` exactly as declared in Task 4.
- Produces: the finished view. `useScanLoop` args gain `onDecision?: (decision: ScannerDecision, seq: number) => void`. `PrintingsRequest` gains `pick?: (p: ScannerTrayChoice) => void`. `ScannerPanelId` gains `"tiers"`.

Before any UI: `frontend-design` skill, `src/CLAUDE.md`. Storybook MCP is down — read component sources for props.

- [ ] **Step 1: `useScanLoop` — the decision edge, test first**

```ts
it("calls onDecision once per decision_seq change, never on repeats or null decisions", async () => {
  const onDecision = vi.fn();
  // drive the loop's fake scannerFrame with verdicts: seq 0 (no decision), seq 1 (decision), seq 1 again, seq 2 (decision)
  // expect onDecision called twice, with seq 1 then seq 2
});
it("does not call onDecision for the seq it saw when the camera started", () => {
  // first verdict after live=true already has decision_seq 4 and a decision (a frozen card from before) -> no call
});
```

Follow the existing `useScanLoop.test.ts` harness for faking frames. Implementation: a `lastSeq` ref initialised from the first verdict after `live` turns true (so a card still frozen from before a view switch is not re-added), then `if (v.decision && v.decision_seq !== lastSeq.current) onDecision(v.decision, v.decision_seq)`, updating the ref on every verdict. `onDecision` is read through a ref, like `options`.

- [ ] **Step 2: `useScannerPrefs` and `useTray`, tests first**

```ts
// useScannerPrefs.ts
export function useScannerPrefs(): {
  prefs: ScannerPrefs;                       // DEFAULT_SCANNER_PREFS until loaded
  loaded: boolean;
  update: (patch: Partial<ScannerPrefs>) => void; // optimistic, persists via setScannerPrefs
  filterError: string | null;                // the last scannerSetFilters refusal
};
```
Query key `["scanner","prefs"]`, `staleTime: Infinity`. On load, and on every `filters` change, call `ipc.scannerSetFilters(prefs.filters)`; a rejection sets `filterError` (via `ipcError`) and **does not** persist the refused filters; success clears it and persists. Tests: loads stored prefs; `update({mode:"exact"})` persists; a refused filter keeps the previous filters and exposes the sentence.

```ts
// useTray.ts
export function useTray(): {
  rows: ScannerTrayRow[]; loaded: boolean;
  setRows: (rows: ScannerTrayRow[]) => void;  // state now, persisted after 400 ms of quiet and on unmount
};
```
Query key `["scanner","tray"]`. Tests with fake timers (read memory note: fake timers + userEvent hang — use `act` + `vi.advanceTimersByTime`, no userEvent): two quick `setRows` persist once, the last value; unmount flushes a pending write.

- [ ] **Step 3: `PrintingsRequest.pick` and the dialog branch**

`src/lib/store.ts:1007` — add `pick?: (p: ScannerTrayChoice) => void` (import the type from `@/lib/ipc`) with a doc comment: *the scanner tray's hand-back; when present a tile press hands the printing back and closes, and neither the deck nor the wish branch runs.* In `AllPrintingsDialog.tsx`'s `onSelect` (~:710), check `request.pick` first: build the `ScannerTrayChoice` from the tile's printing row (`cardId`, `oracleId` from the request, `name`, `setCode`, `collectorNumber` — read the row type the dialog's tiles are drawn from and map its field names), call `pick`, then `closeAllPrintings()`. Add a test beside the dialog's existing tests: with `pick` set, pressing a tile calls it once with that printing's id and set, and closes the dialog.

- [ ] **Step 4: `TiersPanel.tsx`**

A `Panel` (id `"tiers"`, title **Tiers**, folded by default like its siblings — add `tiers: false` to `scannerFolds`' initial value in `store.ts`) listing the **last** non-null `verdict.resolution` (kept by the page like `lastOcr`): outcome, `elapsed_ms`, then one row per tier — tier name, survivors, detail — and the choices with distances. Empty: *No resolve yet — switch to Exact and hold a card steady.* Story `Tiers` in `ScannerPanels.stories.tsx` driven from `VERDICTS.exactAmbiguous.resolution`.

- [ ] **Step 5: `ScannerPage.tsx`**

`LiveScanner` becomes:
- `const { prefs, update, filterError, loaded } = useScannerPrefs()`; `const tray = useTray()`.
- `options` state keeps the developer sliders; the frame options sent are `{ ...options, mode: prefs.mode }`.
- `useScanLoop({ …, onDecision })` where `onDecision(d)`:
  - `addDecision(tray.rows, d, { finish: prefs.finish }, Date.now(), crypto.randomUUID())` → `tray.setRows`, `setFlashKey(rows[0].key)`, `setLastAdded(...)`.
- Layout: `ScanBar` across the top (wraps). Below it the existing video box + overlay, with the old `headline` pill replaced by `statusLine(...)` from `readerText.ts` in an `aria-live="polite"` line under the video. The side column (wide: `w-80 shrink-0`, narrow: stacked — keep both existing layout arms and their comments) holds `TrayPanel` and, when `prefs.developer`, `ScannerPanels` and `TiersPanel` under it in the same scrolling column.
- `TrayPanel.onCommit`: `ipc.collectionImportCommit(importItems(tray.rows, prefs.condition), "add", prefs.folderId)`; on success `tray.setRows([])`, clear `commitError`, and invalidate the collection's queries exactly as the existing add/import paths do (find the invalidation `AddToCollection.tsx` or the import dialog runs after a write, and call the same helper); on failure `setCommitError(ipcError(e))` and keep the rows.
- `onMorePrintings(row)`: `openAllPrintings({ cardId: row.cardId, oracleId: row.oracleId!, name: row.name, deck: null, wish: null, pick: (p) => tray.setRows(setPrinting(rowsRef.current, row.key, p)) })` — `rowsRef` mirrors `tray.rows`, because more cards may have been scanned while the dialog was open.
- The page keeps `lastResolution` (the last non-null `verdict.resolution`, cleared on a verdict with `quad === null`) and passes it to `statusLine` and `TiersPanel`.
- `filtersDisabled`: `status.labels === 0 ? "Filters need card names — the scanner has no corpus.db beside its bundle." : null`.
- `hasBundle`: `status?.bundle.loaded === true`.
- `verdictText.ts`: `bundleSentence` returns `null` (draw nothing) for `source === "embedded"` with `loaded`; the "put it at *path*" sentence stays for `absent`, and the error sentence for a present-but-unloaded file. Update `verdictText.test.ts` for the embedded case. `RectifiedPanel`/`MatchPanel` (developer) show the source word beside the bundle line if they already show asset state — check, and only add it where asset state is already drawn.

- [ ] **Step 6: Page tests and stories**

`ScannerPage.test.tsx` (extend the existing harness that stubs `navigator.mediaDevices` and `ipc`):
- a verdict with a new `decision_seq` adds a tray row, and the same seq again does not;
- pressing **Add N to collection** calls `collectionImportCommit` with the rows' items, `"add"` and the prefs' folder, then empties the tray;
- a rejected commit keeps the rows and shows the sentence;
- the Developer switch shows the Match panel and hides it again;
- switching to Exact sends `mode: "exact"` on the next frame.

Stories in `ScannerPage.stories.tsx`: keep `CameraRefused` and `AssetsMissing`; add `WithTray` (fake tray seeded with `TRAY_ROWS`) and `Developer` (prefs `developer: true`).

- [ ] **Step 7: Commit** (tests run at T7)

```bash
git add src/features/scanner src/lib/store.ts src/features/card/AllPrintingsDialog.tsx
git commit -m "feat(scanner): scanned cards land in the tray and commit to the collection; panels move behind Developer"
```

---

### Task 6: The synthetic evaluation

Wave 2: starts after T1 and T2 have reported.

**Files:**
- Create: `crates/card-scanner/src/bin/eval.rs`, `crates/card-scanner/eval/printings.txt`, `crates/card-scanner/src/synth.rs` (the degradations — a library module behind `builder`, so its tests run under `--features builder`)
- Modify: `crates/card-scanner/Cargo.toml` (`[[bin]] name = "eval"`, `required-features = ["builder"]`), `crates/card-scanner/src/lib.rs` (`#[cfg(feature = "builder")] pub mod synth;`), `.github/workflows/scanner-bundle.yml` (the eval step where T2 left the comment)

**Interfaces:**
- Consumes: `Session::new/frame/set_filters`, `FrameOptions { mode, .. }`, `ScanMode`, `Verdict { decision_seq, decision }`, `Reference::add_label`, `TitleReader::load`, `Bundle::from_bytes` (T1); `build-hashes --bulk`'s row reader shape (T2) — copy its streaming approach rather than importing a bin's private function.
- Produces: `eval --bundle <bin> (--corpus <db> | --bulk <json>) --models <dir> --printings crates/card-scanner/eval/printings.txt --cache <dir> [--seed 7] [--summary <md>]`, printing a markdown table.

- [ ] **Step 1: `synth.rs` — tests first**

```rust
pub struct SynthOptions { pub seed: u64, pub frames: usize /* 12 */, pub long_edge: u32 /* 1280 */ }
/// A burst of JPEG frames of one card render, degraded deterministically.
pub fn burst(card: &RgbImage, opts: &SynthOptions, card_index: u64) -> Vec<Vec<u8>>;
```

Per card, from `StdRng::seed_from_u64(seed ^ card_index)` (add `rand`/`rand_chacha` under `builder` only if the crate lacks an RNG; a 30-line xorshift is acceptable and adds no dependency): a base pose (scale 25–70% of the frame's short edge, rotation 0–360°, perspective up to 12% corner jitter, position inside the frame), a background (flat grey-brown, value noise, or wood-like stripes), a white-balance gain per channel 0.85–1.15 and exposure 0.7–1.2, one elliptical specular glare blob (alpha ≤ 0.6), Gaussian blur σ 0–1.6, JPEG quality 60–90. Frames jitter the pose by ≤ 1.5% translation and ≤ 1° rotation. Warp with `imageproc::geometric_transformations::warp` and a `Projection::from_control_points`.

Tests: same inputs → byte-identical frames; different `card_index` → different frames; every frame decodes and has `long_edge` on its long side; a burst of a synthetic high-contrast card rectangle is **detected** by `detect::detect` with default options on at least 10 of 12 frames (this is the test that proves the generator produces something the detector can see — keep it, it is not ceremony).

- [ ] **Step 2: `printings.txt`**

~150 Scryfall ids, one per line, `#` comments naming each stratum. Choose them by querying the dev corpus (`D:/Code/mtg-grimoire/src-tauri/target/debug/data/corpus.db`, read-only — see memory "Query the dev db with node:sqlite"): ~15 per frame era (1993, 1997, 2003, 2015, future/showcase), 20 basic lands from 4 sets (HOB and LTR included), 15 borderless/full-art, 10 split/adventure, 10 double-faced (front face), 20 cards with 3+ reprints (2–3 printings each), and the rest random. Only English, only printings with `image_uris`.

- [ ] **Step 3: `eval.rs`**

For each id: fetch `image_uris.large` (cache under `--cache/<id>.jpg`, `User-Agent` header, 100 ms between uncached fetches), build a burst, then for each pass — `Fast`, `Exact`, `Exact + own-set filter` — create a fresh `Session` from the same loaded `Reference` (load once; clone or reload cheaply — if `Reference` is not `Clone`, reload the bundle bytes per pass, they are 5 MB) and feed the frames in order, stopping at the first verdict whose `decision_seq` moved. Record: decided (bool), the decision's printing, card correct (oracle equal), printing correct (id equal), ambiguous (Exact: outcome `ambiguous`, and whether the true printing is among `choices`), frames to decision, mean ms per frame. Labels: `--corpus` uses `load_labels`; `--bulk` streams the JSON and calls `add_label` (id, oracle_id, illustration_id, name, set, collector_number, released_at).

Output a markdown table: rows = pass × {all, each stratum}, columns = n, decided %, card ✓ %, printing ✓ %, ambiguous % (true in choices %), not found %, median frames, mean ms. Print it and write `--summary` when given. Head it with the sentence from spec §5: *"Synthetic: Scryfall renders degraded in software — a regression fence, not an accuracy claim about a camera."*

- [ ] **Step 4: The workflow step**

In `.github/workflows/scanner-bundle.yml`, replace the `# T6 adds the eval step here.` comment with:

```yaml
      - name: Synthetic evaluation
        run: |
          cargo run --locked --release --bin eval --features builder --manifest-path crates/card-scanner/Cargo.toml -- \
            --bundle card-hashes.bin --bulk default-cards.json --models models \
            --printings crates/card-scanner/eval/printings.txt --cache eval-cache --summary eval.md
          cat eval.md >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 5: Run it once locally (release)**

The orchestrator has built a bundle at `D:/Code/mtg-grimoire/.scanner-bundle/card-hashes-v5.bin` with models in `D:/Code/mtg-grimoire/.scanner-bundle/models`. If the file exists, run:

```
cargo run --locked --release --bin eval --features builder --manifest-path crates/card-scanner/Cargo.toml -- --bundle D:/Code/mtg-grimoire/.scanner-bundle/card-hashes-v5.bin --corpus D:/Code/mtg-grimoire/src-tauri/target/debug/data/corpus.db --models D:/Code/mtg-grimoire/.scanner-bundle/models --printings crates/card-scanner/eval/printings.txt --cache D:/Code/mtg-grimoire/.scanner-bundle/eval-cache --summary C:/Users/Markus/AppData/Local/Temp/claude/D--Code-mtg-grimoire/6667a05e-d56b-48d9-b450-c855a053e1dc/scratchpad/eval.md
```

Report the table verbatim. If the bundle is not there yet, report that and stop — do not build one.

- [ ] **Step 6: Commit**

```bash
git add crates/card-scanner/src/bin/eval.rs crates/card-scanner/src/synth.rs crates/card-scanner/src/lib.rs crates/card-scanner/Cargo.toml crates/card-scanner/eval/printings.txt .github/workflows/scanner-bundle.yml
git commit -m "test(scanner): a synthetic evaluation of both modes, run by the bundle workflow"
```

---

### Task 7: Fan-in — verify, the live pass, measurements, docs, and the PR

Run by the orchestrator, with one docs subagent.

- [ ] **Step 1: Type-check and test the whole tree, once**

`npm run verify` (never two at once; never piped through `tail` — read the exit code). Then `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` in `src-tauri` (CI runs both; verify does not). Fix what is red with the owning task's subagent when the fix is non-trivial.

- [ ] **Step 2: Prove the embed**

Copy `D:/Code/mtg-grimoire/.scanner-bundle/card-hashes-v5.bin` to `src-tauri/scanner-assets/card-hashes.bin` and both models beside it; `cargo build --release` in `src-tauri`; record the exe size against a build without them (spec §11.1). Remove the three files again afterwards only if they would confuse a later check (they are gitignored either way).

- [ ] **Step 3: The live pass**

Follow the `running-the-app` skill (lock, then `npm run tauri dev`) and `docs/reference/live-ui-verification.md`. With the embedded assets in place and the worktree's data folder populated per memory "Live-testing from a worktree": open Scanner, confirm no asset sentence is drawn, scan a real card in Fast (row added once, not repeatedly while held), switch to Exact (Tiers panel shows six rows), set a set filter, pick a printing on an ambiguous row, press Add to collection into a folder, confirm the collection shows the rows, then delete those collection rows. Record §11's measurements 2 and 3.

- [ ] **Step 4: Docs** (one subagent, after steps 1–3 so the numbers exist)

`docs/reference/card-scanner.md`: a new **§10 Modes, filters, the tray and the shipped bundle** carrying the design's decisions as built, the eval table with its caveat sentence, and §11's measurements with date and build; §8 items 1 and 2 rewritten (the corpus is lost, not unversioned); §9's "Assets are files in `data/scanner/`, and nothing downloads them" paragraph amended to point at §10. `src-tauri/CLAUDE.md`: the `scanner_assets` cfg and load order. `.github/CLAUDE.md`: the `scanner-bundle` workflow and the release step, and that the first release after merge needs the workflow to have run once. **Licence (spec §4.4):** find where the app credits third-party work (grep `licen`, `attribution`, `third-party` under `src/features/settings` and `README.md`) and add ocrs and its models, trained on HierText (CC-BY-SA 4.0); if no such place exists, add the line to `README.md`. Re-count any counts touched.

- [ ] **Step 5: Ship**

`shipping-a-branch` then `auto-pr`. The PR body says, above the fold: **the `scanner-bundle` workflow must be dispatched once after merge, before the next release, or the release legs fail at `npm run scanner:assets`.**
