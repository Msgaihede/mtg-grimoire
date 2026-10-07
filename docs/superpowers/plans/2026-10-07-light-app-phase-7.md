# The light app, phase 7 — the scanner on light installs

Issue #761's phase 7: a light install — the Android app, a browser tab — points its camera at a
card and names the printing, with the same engine, the same tray and the same commit the desktop
has. The design is
[the light-app spec](../specs/2026-10-01-light-app-android-and-web-design.md) §8; the record of
each step is [light-app.md](../../reference/light-app.md) §11; the engine's own reference is
[card-scanner.md](../../reference/card-scanner.md).

> **For agentic workers:** each step is **one pull request**, opened with auto-merge and auto-fix
> armed. Tick a step here and on [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761)
> when its PR merges, and keep the issue's line current while a step is in flight.

## What the tree holds before it starts (surveyed 2026-10-07, `main` at `63d1a44f`, v0.42.0)

- **The engine is linked into every host and runs on one.** `card-scanner` (`corpus`, `ocr`) is an
  unconditional dependency of `grimoire-core`, so CI compiles it for `wasm32` and for Android — and
  nothing calls it on either. In the web module fat LTO drops it whole (35 583 B left).
- **The crate assumes threads and a clock.** Five `std::thread::scope` sites (`detect.rs`
  `run_passes`, `session.rs` `each_method` and `fast_reads`, `reference.rs` `par_map`, `resolve.rs`
  `resolve`), one spawned thread (the Exact resolve, `ResolveOn::Background`, the default), about
  fourteen `Instant::now()` — every one of them telemetry for an `_ms` field, none a deadline — and
  `catch_unwind` twice as the panic guard. In a browser `Instant::now()` panics on the first frame,
  and under the `wasm` profile's `panic = "abort"` the guard guards nothing: a panic is a trap, and
  a trap in the engine's Worker takes the whole app to its failure screen.
- **`ocrs`/`rten` bring `rayon` and `num_cpus`.** Upstream has a one-thread fallback; nobody has
  run it in a Worker.
- **Two of the scanner's twelve commands are in the core's table** (`scanner_prefs`,
  `scanner_tray`). The other ten are the desktop's `#[tauri::command]`s, on `NOT_YET`, for three
  reasons the fence writes down: each admits the calling window's label on the lease, which a
  table call does not carry; a frame is a JPEG body with JSON in headers, and no table entry is of
  the `bytes` kind yet; and the session panics in a browser.
- **The wire for a body is already there on both light hosts.** `table.ts` sends a `Uint8Array`
  call as `core_call { name, args: headers, body: base64 }`; the web protocol transfers the buffer
  and sends the headers as `args`; `dispatch` takes `body: Option<Vec<u8>>`.
- **No light host has the assets, and nothing fetches them.** The desktop's release build embeds
  them (`cfg(scanner_assets)`); a file in `<data>/scanner/` overrides. The published
  `scanner-bundle-v3` is **18 101 604 B**: `card-hashes.bin` 5 874 752, `text-detection.rten`
  2 510 284, `text-recognition.rten` 9 716 568. `ScannerState::ensure` loads once and keeps what it
  found for the life of the process, `Embedded` wants `&'static [u8]`, and in a browser
  `platform::files` refuses every call — so the load reports all three absent — and the labels
  are read by opening a second connection on `corpus.db` by path, which a browser has not got.
- **A browser cannot ask GitHub for them.** A release download answers with no
  `Access-Control-Allow-Origin` (asked 2026-10-07 with the app's `Origin`: a 302, then a 200 with
  `Accept-Ranges` and an `ETag`, and no CORS line).
- **The phone face's Scanner is a sentence.** The desktop's `ScannerPage` imports the store and
  the window and lays a 400px tray beside the camera; its hooks (`useCamera`, `useScanLoop`,
  `useTray`, `useScannerPrefs`, `useScannerElsewhere`, `useScannedDeck`) and its reader parts are
  clean of the phone's fence. On the desktop face of a light host the real page mounts today and
  never starts: `scanner_set_filters` is refused, so the prefs never read as loaded.
- **Over the fake a camera never adds a card**: `scanner_frame` answers one decided verdict with
  one `decision_seq`, and the loop takes the first as its baseline.
- **Every recorded timing is a Windows desktop's.** No Android device is attached to the machine
  (`adb devices` lists none), and neither the Android target nor the NDK is installed on it — CI
  builds the APK.

## Decided before building

Four of these were put to Markus on 2026-10-07 and not answered — he said to keep going — so each
is the recommended default, written down as his to reverse.

| Question | Answer |
| --- | --- |
| The measurement on a real phone | **The bench is built so a phone can run it** — a native binary pushed with `adb`, and a page reached over `adb reverse` — **and this desktop's figures (native beside WASM in headless Chrome) decide what is built.** The phone's own run is the owner's, as phase 6's phone checks were; nothing is promised about Exact or OCR on a phone's browser until it has run |
| The real bundle, for measuring | **Downloaded** — the published `scanner-bundle-v3`, into a gitignored folder, with a handful of card pictures from Scryfall by id for frames. Nothing of it is committed |
| Where a browser gets the assets | **Its own origin**: the web build copies the three files into the app's static assets (each under the 25 MiB a file may be; outside the service worker's precache). As fresh as the release, like the desktop's embedded copy; no CSP change and nothing to provision. **Android asks the GitHub release**, as the desktop's build does |
| The phone Scanner page | **One design, built straight**: the desktop reader's parts in the phone's idioms — the camera sized by its aspect ratio, the options in a sheet, the tray under the strip, the folder as a sheet of choices |
| The lease on a table call | **One fixed label.** A light host has one page — Android one window, the web host one tab holding the database's lock — so a table call admits the page's label, `scanner_elsewhere` answers *false*, and the desktop goes on passing its window's |
| Where the crate's seam lives | **In the crate**, one module, `host.rs`: it cannot use the core's `platform` (the core depends on it). An installed clock wins, then `Instant` where there is one, then zero; the core installs one built on `platform::clock` |
| Where the browser's session runs | **Not decided before the figures.** In the engine's Worker it is one code path with Android, and a frame makes every engine command wait and a panic takes the database with it; in a Worker of its own neither is true, and the labels have to cross. Step 7.2 measures both costs |
| Who deploys | **Nobody by hand.** `release.yml`'s `web-deploy` puts the web app on its origin at a tag; this phase needs no deploy before one |

## Global constraints

- **The desktop must not change**: the same twelve commands, arguments, refusals and sentences,
  the same thread structure and verdicts, the same lease timing.
- **Nothing under `mobile/` asks where it is running**, comments included. What only one host can
  offer — a download, a camera — is drawn from what the host answers below `@/lib/core`.
- **The core's five rules hold**, and the crate gets a fence of its own: no thread, clock, panic
  guard or `cfg(target_…)` outside `host.rs`.
- **A green suite proves the host it ran on.** The browser's half ends driven in a real browser;
  what only a phone can show is written down as not seen.
- **Measuring is budgeted** — sizes, runs and a wall-clock cap, and the decision the figures feed.
- **Tests run once per step, after fan-in.** One commit per step.

## Steps — one PR each

- [ ] **7.1 — the crate runs where there is no thread and no clock.** `host.rs`: a stopwatch, the
  scoped helpers with an inline arm and a guard that makes a thread run them inline, the resolve's
  spawn, the panic guard; a fence over the crate; the same frames threaded and inline, equal but
  for the timings; the core handing the crate its clock. **And proved by running it**: the crate
  as WASM in a Worker in headless Chrome, a frame in as a transferred buffer, beside a native
  runner over the same inputs. ([light-app.md](../../reference/light-app.md) §11.1 is the record.)
- [ ] **7.2 — the measurement, and what it decides.** Native and WASM on this desktop over the
  published bundle — Fast and Exact, with and without the models, the first frame and the steady
  one, the module's size and the Worker's memory — and the same two runs on a phone when one is
  attached. It settles whether a browser gets Exact and OCR, and whose Worker the session is.
  (§11.2.)
- [ ] **7.3 — the scanner's commands are the core's, and Android answers them.** The ten off
  `NOT_YET` and into the table, a frame and a capture as its first `bytes` entries with the wire
  `table.ts` already sends; one implementation under the desktop's wrappers; the lease's fixed
  label; a page still refused, in one sentence from one helper, until the web step; a door for a
  session to load again. (§11.3.)
- [ ] **7.4 — the assets are fetched on first use.** A download in the core with its measured
  size and its progress, landing in `<data>/scanner/` on a host that keeps files; the session
  loading again when they arrive; the Scanner destination offering it, on both faces, drawn from
  what the host answers. (§11.4.)
- [ ] **7.5 — the web host.** The session in a Worker — whose, by 7.2 — fed a transferred
  buffer, its assets from the app's own origin and held without a file, its labels without a
  second connection; the refusal 7.3 left deleted; the hosting policy and the service worker
  taught the three files; driven in a real browser with a fake camera. (§11.5.)
- [ ] **7.6 — the phone's Scanner page.** Fast and Exact, the review tray, commit to a folder:
  the shared hooks under a phone page, the logic the desktop page kept to itself extracted and
  shared, a fake that steps through decisions, and a smoke that scans, edits and commits at 360px
  with a fake camera. (§11.6.)

## What only Markus can close

- **A real phone**: the bench's two runs (the native binary, and the page in the phone's browser),
  the camera grant in the Android WebView for the scanner, a real card under a real lens in both
  hosts.
- **The four defaults above** — each was his to choose and is his to reverse.
