# Scanner in the app — design

**Date:** 2026-09-08
**Status:** approved in conversation; spec under review
**Scope:** the card-scanner crate becomes a dependency of the app, its per-frame handler moves
into the crate so the debug server and the app share it, and the app gets a Scanner view that
does what the debug page does today, in the app's chrome. No collection integration, no
download, no wasm.

Companion to [the scanner design](2026-09-01-card-scanner-design.md), whose §13 listed "app
integration: commands, a scanner page" as deliberately not in that pass. This is that pass.

---

## 1. What this is

A seventh view in the rail, **Scanner**, that opens the camera, draws the detector's box over
the feed, and shows the tracker's verdict as it votes and decides — the same panels the standalone
debug page has, styled as the rest of the app is. The reader can tune the detector and the vote
rule live, watch the pipeline stages and the frame budget, and capture a frame into a dataset
folder. The standalone debug page and its server stay exactly as they are.

Nothing is written to the collection. That is the next pass.

## 2. The facts this rests on

Measured 2026-09-08 on Windows unless stated. *Build named where it matters.*

| Fact | Value |
| --- | --- |
| The crate | `crates/card-scanner`, standalone package, pure Rust, its own `Cargo.lock`; `lib` plus three `cli`/`builder`-gated tools |
| Its manifest already says | "When integration lands, `src-tauri` takes this crate as a plain `path` dependency" |
| `rusqlite` | 0.40 with `bundled` on both sides, so the crate's `corpus` feature unifies to one SQLite |
| The crate's `[profile.dev.package.*]` overrides | `image` and `imageproc` at `opt-level = 3` — **applied only when the crate is the build root**; as a dependency they do nothing |
| Release, one locked frame of a 1600 px photograph, no reader | ~350 ms, both the previous binary and this one |
| Release, one such frame running both readers | ~1.3 s, both binaries (OCR ~340 ms, collector ~650 ms) |
| Release, the page's own 960 px webcam frame | 170–210 ms round trip at 5.6 frames a second |
| Debug, the cheapest path | ~580 ms; rectify alone 2022 ms against 48 ms in release |
| Page-sized frame | 960 px long edge, JPEG q0.72, ~140 KB; capture is full resolution at q0.92 |
| Camera in the app | `src-tauri/src/camera.rs` (on main, 2026-08-31) answers WebView2's `PermissionRequested` with ALLOW for the camera; without it `getUserMedia` fails as `NotSupportedError` |
| `getUserMedia` in this shell | `src/features/settings/QrScanner.tsx` is the one call site: `facingMode: "environment"`, `<video srcObject muted>`, one stop function, three error sentences keyed on `DOMException.name` |
| Bytes inward over IPC | No command takes bytes in today. The one that moves bytes out, the backup zip, is base64 in JSON and its own doc calls a megabyte through IPC "two copies for nothing" |
| Raw bodies | `tauri 2.11.5` has `tauri::ipc::Request` with `InvokeBody::Raw(Vec<u8>)` and `headers()`; `@tauri-apps/api 2.11.1`'s `invoke` takes `Uint8Array` as its args and `headers` in its options |
| `mtgimg://` | Reads only the URI; no POST path exists. The CSP string is pinned by a test on purpose |
| Navigation | One list, `src/components/nav.ts`; routing is a switch on `activeView`; `Ctrl+1…6` bind **by index** into that list; `SHORTCUTS` is a total record over every `ViewId` |
| Icons | lucide-react; `ScanLine` exists there |
| Data dir | `AppState.data_dir`; `src-tauri/target/debug/data/` under `tauri dev` |
| The corpus | `data/corpus.db`, which `Reference` already reads for labels through the crate's `corpus` feature |
| The bundle | `.scanner-bundle/card-hashes-v5.bin`, 5.4 MB, gitignored, published nowhere yet |
| The models | `text-detection.rten` 2.5 MB and `text-recognition.rten` 9.7 MB, from a stable ocrs URL |
| Android | `CAMERA` is in the manifest for the QR scanner; the permission is a human tap on the phone; whether wry answers `onPermissionRequest` unaided is recorded as unverified |
| Web | The web core diverts the four download commands by name in `src/lib/core/browser.ts`; a routed command is a `match` in `web::route::COMMANDS` |

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **A Tauri command with a raw body** carries each frame: `invoke("scanner_frame", bytes, { headers })` | Stays inside `ipc.ts` and its fences, no CSP edit, one path for desktop and Android, and the web build never routes it |
| 2 | **Assets live in `data/scanner/`** and the page names exactly what is missing | Matches "no integration yet"; the bundle has no URL to fetch from until it has a release asset |
| 3 | **All of the debug page becomes the view, developer panels folded** | Everything testable on the debug page is testable in the app, without switching tools |
| 4 | **The per-frame handler moves into the crate as `session::Session`**, shared by the debug server and the app | One typed verdict, one OCR cadence, one panic guard; the export writer is this repo's record of what a second copy costs |
| 5 | **Scanner sits before Settings; Settings moves from `Ctrl+6` to `Ctrl+7`** | Settings stays the last row, where readers look for it |
| 6 | **Desktop and Android share the command path; the web build keeps the entry and says the scanner needs the desktop or Android app** | The crate is not compiled to wasm in this pass |
| 7 | **The debug page and its server stay** | They are how the scanner is diagnosed with the camera held by one page; the app is a second caller, not a replacement |
| 8 | **One reference document** records the whole scanner, and the three area `CLAUDE.md` files get the rules that bind | The record this repo keeps for every subsystem |

## 4. The crate as a dependency

`src-tauri/Cargo.toml`, in the non-wasm target block:

```toml
card-scanner = { path = "../crates/card-scanner", features = ["corpus", "ocr"] }
```

- **Not** in the wasm block, so the web build never sees it and the wasm clippy job stays green.
- The crate stays standalone. No workspace is created; its three tools keep building into
  `crates/card-scanner/target/`.
- **The dev-profile overrides move up.** `src-tauri/Cargo.toml` repeats
  `[profile.dev.package.image]` and `[profile.dev.package.imageproc]` at `opt-level = 3`, with a
  comment saying why they are here and not only in the crate. Whether `rten` and its family need
  the same is a measurement in §12, not a guess.
- **`npm run verify` runs the crate's suite** as a step beside the `src-tauri` one. Today nothing
  in CI or verify runs it.

## 5. `session` — the per-frame handler, shared

A new module in the crate, `card_scanner::session`, holding what `serve.rs::handle_frame` and
its surroundings hold today:

```rust
pub struct Session {
    reference: Option<Reference>,
    reader: Option<TitleReader>,
    tracker: Tracker,
    lock: QuadLock,
    ocr_seq: u64,
    top: usize,
}

impl Session {
    pub fn new(reference: Option<Reference>, reader: Option<TitleReader>, top: usize) -> Session;
    /// One frame in, one verdict out. Never panics: the detector's own asserts are caught and
    /// reported as `ok: false` with a sentence.
    pub fn frame(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict;
    pub fn reset(&mut self);
    pub fn has_reference(&self) -> bool;
    pub fn has_reader(&self) -> bool;
}
```

- **`FrameOptions`** moves into the crate with its fields as they are: `work_long_edge`,
  `method`, `canny_low`, `canny_high`, `aspect_tolerance`, `min_cardness`, `stages`, `rule`,
  `decide_at`, `lead_margin`. It gets `Deserialize` with `serde(default)` per field, so both
  callers parse it the same way: the debug server from its query string, the app from a JSON
  header. `Default` is what the page's sliders start at. `method` becomes a three-value enum,
  `canny | otsu | both`, serialised as those words — `both` is what the query string's absent or
  unknown method already means, made a value rather than a `None`.
- **`Verdict`** is a typed struct, `serde(rename_all = "snake_case")`, carrying **exactly the
  keys `live.html` reads today**: `ok`, `error`, `frame`, `decode_ms`, `matcher`, `lock`, `quad`,
  `method`, `score`, `hash`, `rectified`, `cardness`, `rejected_cardness`, `trim`, `timings`,
  `candidates_examined`, `stages`, `match`, `tracked`, `collector`, `ocr`. Nested shapes reuse the
  crate's existing serialisable types (`LockState`, `Cardness`, `MatchReport`, `Tracked`); the
  ones built by hand in `serve.rs` today (`tracked` with labels, `collector`, `ocr`, `stages`)
  become structs. Snake case, because the debug page reads snake case and the page must not
  change; the app's `ipc.ts` mirror types use the same snake-case names, which the mirror fence
  compares after its `camel()` on both sides — see §9 for the one adjustment that needs.
- **What stays in `serve.rs`**: the HTTP server, the query-string parse into `FrameOptions`, the
  per-frame log line, the rolling dump directory, `/capture` and `/reset`. `handle_frame`
  becomes: parse, `session.frame`, serialise. The three shared `Arc<Mutex<…>>` collapse into one
  `Arc<Mutex<Session>>`.
- **The panic guard moves in.** `frame` wraps its body in `catch_unwind` and answers
  `ok: false, error: "the detector panicked on this frame — see the log for the assertion"`;
  the server's own guard goes, so there is one.
- **The OCR cadence moves in** with `OCR_EVERY` and the stand-down once committed, and so does
  the framing drop after a decision (`query_insets` emptied when `settled`).
- **Preview encoding** (`preview_uri`, the base64) moves in as the crate's, since both callers
  need data URIs the page can put in an `<img>` under `img-src 'self' data:`.
- **Fences.** The debug page's check script keeps passing, `serve`'s two tests keep passing, and
  a new `session` test feeds a corpus photograph twice and asserts the verdict's JSON has every
  key in a list scraped from `live.html`'s `j.` accessors — so a key the page reads cannot leave
  the verdict quietly.

## 6. The app's scanner module

`src-tauri/src/scanner.rs`, declared `#[cfg(not(target_family = "wasm"))]` in the "Desktop and
Android" block of `lib.rs`.

**State.** Its own managed state, not a field on `AppState`:

```rust
pub struct ScannerState {
    data_dir: PathBuf,
    session: Mutex<Option<card_scanner::session::Session>>,
    assets: Mutex<AssetReport>,
}
```

Registered with `app.manage(...)` in `.setup()`, with `data_dir` copied from `AppState` at that
moment. Loading is **lazy, on the first status call**:
the bundle is read from `data/scanner/card-hashes.bin`, the models from
`data/scanner/models/text-detection.rten` and `…/text-recognition.rten`, and the labels from the
app's own `corpus.db` on a read-only connection opened for the load and closed after — never
`AppState.db_read`, the rule the mirror thread already follows. A missing bundle means a session
with no reference, which detects and rectifies and names nothing, exactly as the debug server
does; missing models mean no reader.

**Four commands**, each `async`, answered on `spawn_blocking`, returning `Result<T, String>`
with sentences for errors:

| Command | In | Out |
| --- | --- | --- |
| `scanner_status` | — | `ScannerStatus { bundle: Asset, detection_model: Asset, recognition_model: Asset, labels: usize, scans_dir: String }` where `Asset { path: String, present: bool, loaded: bool, error: Option<String> }` |
| `scanner_frame` | `tauri::ipc::Request` — raw JPEG body, `x-scanner-options` header holding `FrameOptions` as JSON | `Verdict` |
| `scanner_reset` | — | `()` |
| `scanner_capture` | `tauri::ipc::Request` — raw full-resolution JPEG body, `x-scanner-capture` header holding `{ expected, reported, confidence, votes, distance }` | `Captured { saved: String }` |

- **The path is the message.** `scanner_status` reports the exact path it looked at for each
  asset, so the page can say "put `card-hashes.bin` at `D:\…\data\scanner\`" rather than "no
  bundle".
- `scanner_frame` on a body that is not `InvokeBody::Raw` answers an error sentence, never a
  panic. A missing or malformed header means `FrameOptions::default()`.
- `scanner_capture` writes `live-<epoch>.jpg` and its `.json` sidecar into `data/scanner/scans/`,
  the same names and fields the debug server writes into `docs/scanner/scans/`, so a captured
  frame can be copied into the repository's dataset unchanged.
- No schema rung: nothing is stored in either database. No capability entry: an app's own
  command is always callable. No `error_log` source: the page shows the sentence.

## 7. The view

**Navigation.** `ViewId` gains `"scanner"`. `NAV` gains
`{ id: "scanner", label: "Scanner", Icon: ScanLine }` between `wishlist` and `settings`.
`SHORTCUTS` gains `scanner: []` and `switchView.chords` gains a seventh, `{ key: "7", ctrl: true }`.
`App.tsx` gains one branch. The nav census pins seven ids in the new order.

**Files**, under `src/features/scanner/`:

| File | Owns |
| --- | --- |
| `ScannerPage.tsx` | The view: dispatches to the web sentence, or mounts the camera and the panels |
| `useCamera.ts` | `getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } })`, one stop function, the same three error sentences as the QR scanner with "scan a card" in place of "scan a code" |
| `useScanLoop.ts` | The pump: one request in flight, later frames dropped; grab at `send` px long edge, JPEG q0.72, `ipc.scannerFrame`; `roundTripMs` stamped on the verdict; a twenty-sample mean for the rate |
| `Overlay.tsx` | The canvas over the video: the smoothed quad, the raw one behind it, redrawn every animation frame from the latest verdict |
| `ScannerPanels.tsx` | Pure. `{ status, verdict, options, onOptions, onReset, onCapture }` in, the whole panel column out |
| `panels/MatchPanel.tsx` | Name, decided / voting / confirmed / gathering, the bar with its mark, votes or confidence, lead, distance, margin, orientation, cardness, trim, collector, lock, the standings, this frame's guess, reset, capture |
| `panels/ControlsPanel.tsx` | Rule segment, decide-at, lead-margin, method segment, work edge, canny low and high, aspect tolerance, send px, min cardness, stages toggle |
| `panels/PipelinePanel.tsx` | The three stage images, shown only when stages are on |
| `panels/BudgetPanel.tsx` | Decode, resize, mask, contour, rectify, transport, round trip, the stacked bar |
| `panels/RectifiedPanel.tsx` | The rectification, with the detection numbers: aspect, area, corner error, detector, geometry, hash |
| `panels/ReadoutsPanel.tsx` | OCR: raw, normalised, band, matched, edits. Collector: raw, band, every pairing tried and what it resolved to |
| `scannerOptions.ts` | `ScannerOptions`, its defaults, and the header encoding |
| `verdictText.ts` | The pure sentence functions the panels and the tests share |

**Layout.** `<section className="flex h-full flex-col gap-3">` with an `sr-only` heading, then
`flex min-h-0 flex-1 gap-4`: the video and its overlay in a `min-w-0 flex-1` box that keeps the
camera's aspect, and the panel column at `w-80 shrink-0 overflow-auto`. Under `useNarrowWindow`
the row becomes a column, video first — the scanner is the second use of the one viewport branch
and says so in its doc.

**Chrome.** Each panel is a section in the Settings panel chrome — heading, then a
`rounded-lg border border-border bg-surface p-4` body — and the developer panels fold on their
heading with `aria-expanded`, open state kept in the app store so it survives a view switch. Match
is open by default; Controls, Pipeline, Budget, Rectified and Readouts start folded. Dim text is
`text-dim`; the bar's fill is `bg-accent` when decided and `bg-dim` while voting; the mark is a
pseudo-element at 70% under the confidence rule and at the right edge under votes. Sliders are
range inputs with `accent-color` from the accent token. The rule, method and stages segments
are `aria-pressed` button pairs drawn as `FilterChips` draws its chips — there is no shared
segmented control in the app, and one is not added for three pairs.

**Sentences the page owes.**

| State | Where | Sentence |
| --- | --- | --- |
| Web build | In place of the whole view | "The scanner needs the desktop or Android app — this build has no detector." |
| Camera refused | In place of the video | "MTG Grimoire needs camera access to scan a card." |
| No camera | In place of the video | "No camera on this device." |
| Bundle missing | Match panel head | "No reference bundle. Put `card-hashes.bin` at *path*." |
| Models missing | Readouts panel | "No OCR models. Put `text-detection.rten` and `text-recognition.rten` at *path*." |
| Detector panicked | Under the video, two reserved lines | The verdict's own sentence |

Capture goes into `data/scanner/scans/` and the status line under the button names the file.

**`ipc.ts`.** Types `ScannerStatus`, `ScannerAsset`, `ScannerOptions`, `ScannerVerdict` and
every nested shape, plus `ScannerCaptured`; wrappers `scannerStatus()`, `scannerFrame(bytes,
options)`, `scannerReset()`, `scannerCapture(bytes, sidecar)`. `ScannerOptions` and the verdict
types keep the Rust field names — snake case — because the header JSON is deserialised straight
into `FrameOptions` and the verdict is what the debug page already reads. `scannerFrame` is the
first wrapper to pass a `Uint8Array` and `headers`, and the file header's source index gains the
crate's `session.rs` as a source file.

**`Core.call` widens.** Today both cores take `(command, args?: Record<string, unknown>)`. It
becomes `(command, args?: Record<string, unknown> | Uint8Array, options?: { headers })`: the
Tauri core passes both through to `invoke`, and the browser core rejects a `Uint8Array` before it
reaches the Worker, with the sentence the page shows for the web build. No other wrapper changes.

## 8. Storybook

- Fake handlers `scanner_status`, `scanner_frame`, `scanner_reset`, `scanner_capture` in a
  `scannerHandlers()` table beside `pluginHandlers()` — no store; each carries its
  `/** crate::fn */` doc. `scanner_frame` answers a canned decided verdict; `scanner_status`
  answers all-present unless the `scannerMissing` fault is set, which answers every asset absent
  with a path.
- **Panel stories** from canned verdicts, since Storybook has no camera: voting, decided,
  confidence rule, no match, no card, detector panicked, bundle missing, models missing.
- **Page stories**: the refused camera (jsdom and Storybook both throw from `getUserMedia`, so
  the page's own error path is what draws) and the web sentence (mock `@/pwa/target`).
- The sizing decorator every `h-full` page story carries: `h-[640px] w-[1032px]`.

## 9. Tests and fences

| Fence | What it pins |
| --- | --- |
| `nav.test.ts` | Seven ids in order; seven `switchView` chords |
| `shortcuts` | `SHORTCUTS.scanner` exists and is empty; the keyboard doc's table gains the row |
| `ipc.test.ts` argument cases | `scanner_frame` is invoked with a `Uint8Array` and an `x-scanner-options` header; `scanner_capture` likewise |
| `ipc.test.ts` mirrors | `ScannerStatus`, `ScannerAsset`, `ScannerOptions` ↔ `FrameOptions`, `ScannerVerdict` and each nested struct against `crates/card-scanner/src/session.rs` and `src-tauri/src/scanner.rs`. The mirror reads Rust sources through `?raw`; the crate's path is one more import. The parser camel-cases the Rust side today, and these mirrors are snake case on both sides, so the rows use the plain-parity list with a `snake` option that skips the camel step — one small extension to the helper, tested by the row that needs it |
| `useScanLoop.test.ts` | One in flight, frames dropped while it is, the rate mean, the options reaching the header |
| `useCamera.test.ts` | The three sentences by `DOMException.name`; the stream stopped exactly once on unmount |
| `ScannerPanels.test.tsx` | Each canned verdict draws its sentence and numbers; the bar width and mark per rule; the fold toggles `aria-expanded` |
| `verdictText.test.ts` | The pure sentence functions |
| `scanner::tests` (Rust) | Status on an empty data dir names three absent paths; a `Raw` body with no header uses defaults; a non-raw body is a sentence; capture writes the two files with the debug server's names |
| `session::tests` (Rust) | Every key `live.html` reads is in the verdict; a frame that panics the detector answers `ok: false`; the OCR cadence stands down after a decision |
| `route.rs` census | The four commands are absent from the routed census that `scripts/routed-census.mjs` re-derives, and a `core.test` case shows the browser core rejecting a `Uint8Array` with the web sentence |
| `stories.test.tsx` | Every story's play |
| The page check script | Still passes on the untouched debug page |

## 10. Platforms

- **Desktop.** The whole design.
- **Android.** The same commands over the same IPC. The manifest already carries `CAMERA`; the
  permission is a human tap on the phone, and whether wry answers the permission request unaided
  is verified by driving the page on the phone once, recorded either way.
- **Web.** The four commands are `#[cfg(not(target_family = "wasm"))]` and unrouted;
  `ScannerPage` dispatches above its hooks on `isWebTarget()` to the web sentence, so no camera is
  asked for, no command is called and no `useQuery` is conditional. The browser core's refusal of
  a `Uint8Array` is the fence behind that, not the path a reader sees.

## 11. Documentation

- **`docs/reference/card-scanner.md`**, new: the crate's layout, the pipeline and every
  measurement behind it with date and build, the three evidence tiers and their weights, both
  tracker rules and the measured failures that shaped them, the debug server and how to drive it
  without a camera, the bundle builder, the dataset and its sidecars, the app integration from
  this spec, the release-versus-debug table, and the bugs still open.
- **`CLAUDE.md`** reference table gains the row.
- **`src-tauri/CLAUDE.md`** gains: the crate is a path dependency in the non-wasm block; the
  dev-profile overrides and why they sit here; `data/scanner/` and what a missing file means;
  `scanner_frame` is the one command that takes a raw body and how; the seventh connection that
  loads labels and closes.
- **`src/CLAUDE.md`** gains: the scanner is the second `useNarrowWindow` reader; the one
  `Uint8Array` wrapper; the view's fold state lives in the store.
- **`docs/reference/keyboard-shortcuts.md`**: Settings is `Ctrl+7`, Scanner `Ctrl+6`.
- **The scanner spec's §13** loses "app integration" and gains a pointer here.

## 12. Measurements to take during implementation

Each is a number a build answers, so it is taken and recorded rather than assumed:

1. **IPC cost of one page-sized frame** through `scanner_frame`, release, against the 63 ms
   "transport" the debug page shows for HTTP on localhost.
2. **Frame time under `tauri dev`** with the profile overrides in place, and whether the `rten`
   family needs the same override for OCR to stay under a second in a debug build.
3. **The phone**: whether the camera opens unaided, and one frame's round trip.
4. **Label load**: how long the seventh connection is open and what the labels cost in memory.

## 13. Deliberately not in this pass

- Downloading the bundle or the models, and any Settings panel for the scanner.
- Writing a scanned card to the collection, and the provisional mark on a row.
- Set filters, and the fast / precise split.
- Compiling the crate to wasm.
- Replacing the debug page. It stays, and the app is a second caller of the same session.
