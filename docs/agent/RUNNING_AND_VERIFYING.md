# Commands, running and verifying

The full command list and the traps you hit when you run the app, build it and verify it. Moved
out of the root [`CLAUDE.md`](../../CLAUDE.md) without changing the wording. The root file keeps
a short command table and the one-line versions of these rules.

Related: the `running-the-app` skill (locks and ports), [live-ui-verification.md](../reference/live-ui-verification.md)
(the CDP harness) and [tauri-mcp-bridge.md](../reference/tauri-mcp-bridge.md) (the other way to drive the window).

## Commands

- `pnpm tauri dev` — run the app (Vite HMR + Rust rebuild). Takes the `app` lock: only
  one app runs across every worktree. See the `running-the-app` skill.
- `pnpm verify` — build + lint + `cargo fmt --check` + clippy + Vitest + cargo test. **Run
  at the end of a feature before committing (not after every intermediate change, to minimize re-fixing).**
  Rust is pinned by `rust-toolchain.toml` and Node by `.nvmrc`.
- `pnpm test` / `test:run` — frontend tests; `cargo test --workspace` — Rust tests, for every
  member of the cargo workspace at the root (`apps/desktop/src-tauri`, `crates/grimoire-core`, since
  2026-10-03 the light app's Android host `apps/light/src-tauri`, and since 2026-10-04 its web
  host `crates/grimoire-web`, natively). **Its
  build tree is `target` at the root**: `.cargo/config.toml` pins it. It was `src-tauri/target`
  until 2026-10-08, which the workspace of 2026-10-02 had kept.
- **Arguments follow a script's name with no `--`**: `pnpm web:wasm --only engine`. npm stripped a `--`; pnpm hands it to the script, so `pnpm mobile:scan-smoke -- http://host` gives the script `--` as its first argument.
- `pnpm exec vitest run --project <name>` runs one package's tests (the projects are the packages: `ui`, `light`, and so on).
- `pnpm install` after a merge or a pull that changes a manifest or `pnpm-lock.yaml`.
- `pnpm test:coverage` / `test:coverage:rust` — coverage. **The Rust one's number is not
  `cargo llvm-cov`'s**: that counts the inline `#[cfg(test)]` modules, where every line is
  covered by definition, and reads ~14 points high. See
  [test-coverage.md](../reference/test-coverage.md) before quoting either figure.
- `pnpm storybook` / `build-storybook` — the component workbench
- `pnpm mobile:dev` / `mobile:tauri` — the light app, over the Storybook fake in a browser
  (port 5175, no lock) or over the real core in a phone-sized window (**takes the `app` lock**).
  See [`apps/light/CLAUDE.md`](../../apps/light/CLAUDE.md).
  **`pnpm mobile:scan-smoke`** and **`pnpm mobile:scanner-smoke`** drive `mobile:dev` in a
  headless Chromium with a fake camera, at a phone's width under a touch pointer — the Sync
  panel's pairing scanner, and the phone's Scanner page (cards landing in the tray, the commit,
  every refusal, the 44px floor at 360 and 412). Neither takes a lock or runs in CI; each takes
  another origin after the script's name, for a server on a port of your own.
- `pnpm web:wasm` / `web:build` / `web:smoke` — the light app's web host: **two WASM
  modules** — the engine into `dist-wasm/`, and the card scanner (`crates/grimoire-scan`, built
  with `simd128` in a build tree of its own, `target/scanner-simd128`) into
  `dist-wasm/scanner/` — which needs clang, for the engine's SQLite, and the `wasm-bindgen` CLI
  at `Cargo.lock`'s version; `web:wasm --only engine` or `--only scanner` builds one and
  leaves the other. Then the page around them into `apps/light/dist-web/`, and that bundle opened in
  headless Chromium.
  No lock; `web:dev` serves it on port 5176, and **`web:preview` serves the build under the
  hosting's own headers** — the local server to drive under the shipped policy; `web:smoke`
  serves under it too since 2026-10-04, and fails on a refusal.
  **`web:wasm` refuses an engine module over its ceiling** (8 000 000 B; `scripts/build-wasm.mjs`
  has why, and how to raise it): the card scanner's OCR runtime linked into the engine is three
  megabytes nothing else would notice. **A full `web:wasm` empties `dist-wasm/`**, the scanner's
  files with it — run `scanner:assets --web` after it, not before.
  **`pnpm web:scanner-smoke`** scans a card in the built app: `pnpm scanner:assets
  --web` first (the scanner's three files into `dist-wasm/scanner-assets/`, which `web:build`
  then ships; without them the page says the build has no scanner), then a headless Chromium
  whose camera is a file showing one real card, on the desktop face — the offer, Download,
  the tray, the collection, offline, a staged fault, and the Worker ended on leaving — and
  again on the phone face at 360px, in a profile of its own. The
  card's picture is fetched from Scryfall's CDN once by the script and kept in the temp
  folder; `SCAN_CARD_PICTURE=<file>` runs it with no request at all.
  **`pnpm web:sync-smoke`** is live sync end to end: two headless Chromium profiles (the
  desktop face and the phone face) claim, pair and sync through `infrastructure/relay/`'s own code under
  workerd (`wrangler dev --local`, a local D1, nothing that reaches Cloudflare), by the relay's
  real name and under the shipped policy; `--measure` adds a minute's profile of the idle
  loop, twice. It runs the pinned wrangler (`npm ci --ignore-scripts --prefix
  infrastructure/wrangler` first), or the `wrangler.js` that `WRANGLER` names.
  **`pnpm web:sync-pull --ops <n>`** is a measurement on that harness, not a check: what
  a `pull` of `n` ops costs the engine's Worker and the relay (`--live` and `--join` are the two
  neighbouring cases; [light-app.md](../reference/light-app.md) §10.5, and §10.5b for the
  paged pull it measures now). Nothing runs it —
  half a minute at a thousand ops, five at fifty thousand.
  **`verify` runs none of them** — CI's `web` job runs the two smokes. See [`crates/grimoire-web/CLAUDE.md`](../../crates/grimoire-web/CLAUDE.md).
- `pnpm scanner:bench` — what a frame costs the card scanner as WASM in a Worker: builds
  `crates/card-scanner/bench` (needs the `wasm-bindgen` CLI at that package's lockfile's version;
  no clang), serves its page and runs it in headless Chromium, printing a JSON summary.
  `--native` runs the same frames through the native runner too, `--sizes` reports the
  module with and without the readers, `--simd` builds and runs it with WASM SIMD,
  `--dir <inputs>` takes a directory `bench-prep` made (the default is invented inputs: no
  real bundle, no models, so no readers), and `--serve --port 8787` leaves the page up for a
  phone over `adb reverse`. A measurement, not a check — though it exits 1 when a mode saw no
  card at all, or when `--native`'s hosts disagree about a decision or a read: no lock, no
  network, and **`verify` and CI do not run it** — CI runs the package's own unit tests and
  compiles it for WASM and Android. [card-scanner.md](../reference/card-scanner.md) §11.
- `pnpm web:deploy-guard` — may the web app be deployed from this tree, between releases?
  Compares `USER_SCHEMA_VERSION` here with the last release tag's (`git show`), in one sentence:
  exit 0 equal, 1 different, 2 could not tell. It also asks `gh` whether that release is
  published — a draft's tag exists before anybody can install it — which is exit 1 for a
  draft and 2 when it cannot ask; `--offline` skips the question and says so. Needs the tags
  fetched; builds and deploys nothing. **Equal schemas are necessary, not sufficient**: a wire
  change that is not a schema rung is dropped by an older build, and this cannot see it. The
  by-hand runbook runs it before `wrangler deploy`
  ([`infrastructure/app-worker/README.md`](../../infrastructure/app-worker/README.md)); a release deploys the tag and has no
  use for it.

### Three things pnpm does that npm did not

Measured 2026-10-08 with pnpm 11.5.0 in this repository.

- **pnpm refuses to run on a tree a manifest has moved past.** pnpm 11's own default is to
  install first: with a `package.json` edited, `pnpm exec <anything>` and `pnpm <script>` rewrote
  `pnpm-lock.yaml` to match the edit, relinked `node_modules` and only then ran the command.
  `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: error` (measured 2026-10-09; its comment has
  the cases): the command exits 1 with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` and `Run "pnpm
  install"`, and changes nothing. Put back an edit that was not meant to stay and the command
  runs again; run `pnpm install` for one that was. **It does not see a lockfile that moved by
  itself** — a merge that brings only `pnpm-lock.yaml` — so `pnpm install` after a merge is
  still yours, or the session hook's.
- **`pnpm install` always reads the lockfile here.** pnpm 11's default answers "Already up to
  date" whenever no manifest's modification time has moved, without reading the lockfile — a
  lockfile changed by itself got that answer and exit 0. `pnpm-workspace.yaml` sets
  `optimisticRepeatInstall: false` (its comment has the measurement); an install with nothing to
  do takes about 0.75 s instead of 0.3 s.
- **pnpm does not replace a tree npm made.** `pnpm install` over an npm-installed `node_modules`
  exits 0 and removes nothing: npm's hoisted packages stay at the root beside pnpm's links, so
  every import no manifest declares goes on resolving. Delete `node_modules` first, then
  `pnpm install`. The session hook (`.claude/hooks/worktree-deps.sh`) does this for a worktree
  whose `node_modules` has no `.modules.yaml` (about 20 s, once).

## Running and verifying

- **Verify UI in the real app, not just in tests.** Every UI task in Plans 2–3 found something
  the suite could not. Drive the real window over CDP —
  [live-ui-verification.md](../reference/live-ui-verification.md) is the contract, and it
  documents traps that have each cost a session.
- **Under `tauri dev` the databases are `target/debug/data/user.db` and
  `corpus.db`** (`src-tauri/target/debug/data/` before 2026-10-08, and still in a checkout that has
  not taken that change) — not `apps/desktop/src-tauri/data/`, and not one file: schema 27 split the reader's
  own tables out of the rebuildable ones. A folder still holding `mtg.db` is converted at
  the next launch. Delete that `data/` folder to force a clean first-run sync; deleting
  `corpus.db` alone costs a resync and nothing else, which is what the split is for.
- **A built app embeds `apps/desktop/dist/` at compile time, so a frontend-only edit does not reach a
  `tauri build` binary.** Vite writes a new bundle, cargo then sees no Rust source change and
  leaves the old bundle inside the old exe — exiting 0. `touch apps/desktop/src-tauri/src/main.rs` first, and
  stop the app before rebuilding or the link fails with `Access is denied. (os error 5)`.
  `pnpm tauri dev` does not have this problem, which is why it is the command above.
- **A second launch does not start a second app — it opens another window in the one already
  running.** `tauri-plugin-single-instance` still gives the new process exit code 0, no window and
  no stderr, and a dev build still counts; what changed on 2026-09-20 is what the *first* process
  does about it. **So a dev build launched from another worktree opens a window in the running
  app, showing the RUNNING worktree's frontend** — a window that looks like yours and renders
  somebody else's branch. The `app` lock still prevents it; see the `running-the-app` skill and
  [multi-window.md](../reference/multi-window.md).
- **Every measured claim in this repo was measured on Windows. Nobody has run a Linux build.**
  Name the build (debug or release) in any figure you add; the same measurement can differ by ~8×.
