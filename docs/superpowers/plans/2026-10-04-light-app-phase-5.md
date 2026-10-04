# The light app, phase 5 — the web host

Issue #761's phase 5: `grimoire-core` compiled to WASM, loaded by a dedicated Worker, with the
page talking to it through the `Core` seam. The design is
[the light-app spec](../specs/2026-10-01-light-app-android-and-web-design.md) §6 (and §3.5 for the
seams); the record of each step is [light-app.md](../../reference/light-app.md) §9.

> **For agentic workers:** each step is **one pull request**, opened with auto-merge and auto-fix
> armed. Tick a step here and on [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761)
> when its PR merges, and keep the issue's line current while a step is in flight.

## What the tree holds before it starts (surveyed 2026-10-04, `main` at `2abf2d7a`)

- **The core compiles for `wasm32-unknown-unknown` and nothing has ever instantiated it.** No
  browser arm of `platform/` has run. There is no host crate, no `cdylib`, no OPFS code and no
  `sqlite-wasm-vfs` in any manifest.
- **`launch::open` cannot run in a browser as written**: it makes the data folder first
  (`platform::files` refuses there), opens a second, read-only connection, and returns it as a
  field that is not optional. `index::lifecycle`'s build and `invalidate_owned` each open a
  connection of their own.
- **Every launch download goes through a temp file**, which a browser does not have. The card
  sync and the tagger feeds refuse before they ask; the combo and price feeds ask first and then
  refuse, on every launch. The push sinks a browser needs already exist for three of the four
  (`ingest::StreamIngest`, `tags::StreamTags`, `combos::ingest_stream`); the price feeds parse
  over `Read` only.
- **The page has two transports and no third**: `pickCore` answers `tableCore` (Android) or
  `tauriCore`. In a plain browser the production bundle waits on "Opening your collection…" for
  ever. `imageOrigin` answers `http://mtgimg.localhost` or `mtgimg://localhost`, neither of which
  a browser can reach. The desktop face's clipboard and open-a-link are Tauri plugins.
- **Round one's web host is in git history and worked end to end** — removed on 2026-09-27 for
  its faces, not its engine. Read it before writing the same thing again, and port, never
  restore: `git show 95de1a59^:<path>` for `src-tauri/src/web/{glue,net,wire}.rs`,
  `src-tauri/src/db.rs` (`install_opfs_pool`, `open_pooled_pair`), `scripts/build-wasm.mjs`,
  `src/workers/{db,protocol}.ts`, `src/lib/core/browser.ts`, `src/pwa/*` (the service worker, the
  update bar, persistence, the image ledger) and `src/web/*` (the boot, the corpus build, the
  second tab). Its 4 729-line `route.rs` is what `grimoire_core::dispatch` replaced.
- **The toolchain is on this machine**: the `wasm32-unknown-unknown` target, clang 22.1.8 at
  `C:\Program Files\LLVM\bin` (not on `PATH` — `CC_wasm32_unknown_unknown` and
  `AR_wasm32_unknown_unknown` name it), and `wasm-bindgen` 0.2.127, which is the version
  `Cargo.lock` resolves. No `wasm-opt`, no `wasm-pack`, no `wrangler`.

## Decided before building

| Question | Answer |
| --- | --- |
| Where the host lives | **`crates/grimoire-web`**, a fourth workspace member: a `cdylib` whose `#[wasm_bindgen]` shell is the only thing gated to the target, so `--workspace` commands still reach it natively |
| What the page loads | **A build of its own, `dist-web/`** — the light entry in a `web` mode. The page's code is the Android app's; what differs is below `@/lib/core`, as the fake's build already differs. The desktop's `dist/` and the APK's `dist-mobile/` never carry the module, the Worker or the service worker |
| The service worker | **Hand-written**, as round one's was. No `workbox`, no `vite-plugin-pwa` |
| Files in a browser | **`platform::files` keeps refusing.** The databases are SQLite's own OPFS VFS; a download is streamed into its sink; card images are the service worker's, in Cache Storage |
| Who deploys | **Nobody here.** The hosting Worker's source and `wrangler.jsonc` are committed; Markus runs `wrangler deploy` |
| The web app's origin | **`https://mtg-grimoire.app`** (Markus, 2026-10-04) — a domain he bought on Cloudflare for it, rather than a `workers.dev` name beside the relay's. An origin is a PWA's identity: both OPFS databases and the install are bound to it, and the relay's CORS allow-list (phase 6) names it |

## Global constraints

- **Nothing under `mobile/` asks where it is running**, comments included. A screen only the
  browser can need — a second tab, a corpus to build — is drawn from what the host *answers*
  (a startup state, a command's refusal), never from a probe.
- **The core's five rules hold**: no `cfg(target_…)` outside `platform/`, no clock, `reqwest`,
  `tokio` or `std::fs` named outside it. A browser difference is a `platform` arm.
- **The desktop and Android must not change**: no request, no file layout, no schema. A step
  that touches a moved download or the opener re-runs what it could have moved.
- **No `@types/node`.** A Worker or service-worker file is its own `tsc` program with the
  `WebWorker` lib, as the relay's and the share Worker's are their own.
- **A green suite proves the host it ran on.** Each step ends driven in a real browser — headless
  Chromium over CDP against the built app on `localhost`, which is a secure context — and its
  figures are written down with the browser and the build named.
- **Tests run once per step, after fan-in.**

## Steps — one PR each

- [x] **5.1 — the engine in a browser** (#805, merged 2026-10-04). `crates/grimoire-web`: `open`, `call` and the event
  sink over `grimoire_core::dispatch`; the OPFS pool and one connection with no WAL, the journal
  reported rather than assumed; `launch::open` and the facet index on a host with one connection,
  and every table command run that way natively so a lock taken twice fails a test instead of
  trapping a Worker. The DB Worker, its protocol and the third `Core`; the module instantiated
  once, whatever StrictMode does; the startup gate answered by the Worker; a second tab told so
  in a sentence with a Reload. `scripts/build-wasm.mjs`, `npm run web:build` into `dist-web/`, and
  a CI `web` job that builds both and opens the database in a headless browser.
- [ ] **5.2 — the first run.** The launch's downloads without a temp file: the card sync, both
  tagger feeds, the combos and the Card Kingdom list, each streamed into its sink; CORS and the
  pacing clock measured, which phase 2 left as this phase's first measurements; a stall bound on
  each wait of a download — the answer, and every chunk — rather than a deadline on the whole
  request. The corpus-build screen with its progress; searches queued behind an ingest,
  measured; storage found cleared at launch and the reader **told so in a notice** — not a
  rebuild offered, because the rebuild is the launch's own download; `persist()` asked when the
  database opens and **again, at most once a week, while the answer is no** — not once, because
  Chromium decides at the call and a first visit's no would otherwise stand after an install —
  and recorded. The marketplace picker offers what the host can reach.
  ([light-app.md](../../reference/light-app.md) §9.2 is the record.)
- [ ] **5.3 — the service worker.** The shell precached; card images answered from Cache Storage
  on the app's own origin, the Scryfall address asked of the core; the image-cache panel over
  it; the update flow — a waiting worker, a bar, and only that press activates it; a face whose
  chunk a deploy renamed recovers instead of offering a reload that cannot work.
- [ ] **5.4 — the browser's seams and the manifest.** Clipboard and open-a-link below
  `@/lib/core` on both faces; file open and save on the desktop face in a browser; the phone
  card sheet's `Open on …` rows. The manifest finished — raster and maskable icons, an `id`,
  installable by the browser's own install UI and by no button of the app's — and moved out of
  the `public/` every build copies; the page's colour made the token's. Phase 1's two history
  leftovers: a refused push, and `back()`'s one-release latch. **Built differently in one
  place**: the Android host opens a link through Tauri's opener, which its capability grants,
  and only its clipboard is the browser's.
  ([light-app.md](../../reference/light-app.md) §9.4 is the record.)
- [ ] **5.5 — hosting, and the phase's own run.** A Cloudflare Worker with static assets at an
  origin root, beside the relay and never the same one: the single-page fallback, the headers a
  service worker and a WASM module need, its `wrangler.jsonc` with `mtg-grimoire.app` as its
  custom domain, and a runbook that opens with asking the host. Then the built app driven end to end against round one's
  figures — the module's size, the first run, a search, storage.
  **The hosting half is built and not deployed** (`app-worker/`;
  [light-app.md](../../reference/light-app.md) §9.5 is the record), **differently in one
  place**: the Worker is not assets alone — the fallback by itself answers a missing file with
  the document, so a script of a few lines makes that a 404. The headers are a `_headers` file
  only the web build carries. **The box stays open for the second half**: the module's size
  with timings, and the phase's own run.

What only Markus can close stays open on the issue: the deploy itself, and a run on a real phone's
browser over `adb reverse`.
