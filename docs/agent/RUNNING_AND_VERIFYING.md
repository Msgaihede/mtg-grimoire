# Commands, running and verifying

The full command list and the traps you hit when you run the app, build it and verify it. Moved
out of the root [`CLAUDE.md`](../../CLAUDE.md) without changing the wording. The root file keeps
a short command table and the one-line versions of these rules.

Related: the `running-the-app` skill (locks and ports), [live-ui-verification.md](../reference/live-ui-verification.md)
(the CDP harness) and [tauri-mcp-bridge.md](../reference/tauri-mcp-bridge.md) (the other way to drive the window).

## Commands

- `pnpm tauri dev` — run the app (Vite HMR + Rust rebuild). Takes the `app` lock: only
  one app runs across every worktree. See the `running-the-app` skill.
- `pnpm tauri:fast dev` / `pnpm cargo:fast <command>` — the same dev build made faster by a
  second toolchain: a dated nightly with rustc's parallel front end and `rust-lld`
  (`scripts/rust-fast.ts` hands cargo `.cargo/fast.toml`, which has every measurement). On the
  desktop app, debug, 2026-10-11: a rebuild after an edit in the core 11 s against 16 s, in the
  host 6.4 s against 8.4 s, a cold build 108 s against 136 s — **nearly all of it the newer
  compiler**, which 1.99.0 did not have, so it is a thing to measure again and likely delete
  when the pin moves. **Opt-in, one command at a time**: `pnpm verify`, CI and a release never
  use it, and a test that passes under it has not passed the gate. It takes the `app` lock
  exactly as `tauri dev` does, installs the nightly the first time, refuses a release build or
  any named profile, and keeps a second set of artifacts in the same build tree (3.4 GB) —
  nothing one compiler built is of use to the other.
- `pnpm verify` — build + lint + `cargo fmt --check` + clippy + Vitest + cargo test. **Run
  at the end of a feature before committing (not after every intermediate change, to minimize re-fixing).**
  Rust is pinned by `rust-toolchain.toml` and Node by `.nvmrc`.
- `pnpm test` / `test:run` — frontend tests; `cargo test --workspace` — Rust tests, for every
  member of the cargo workspace at the root (`apps/desktop/src-tauri`, `crates/grimoire-core`, since
  2026-10-03 the light app's Android host `apps/light/src-tauri`, and since 2026-10-04 its web
  host `crates/grimoire-web`, natively). **Its
  build tree is `target` at the root**: `.cargo/config.toml` pins it. It was `src-tauri/target`
  until 2026-10-08, which the workspace of 2026-10-02 had kept. **In an agent worktree the part
  cargo can rebuild is `target/cache`** — deletable at any time — and `target/debug` keeps the
  executables and `data/`; worktrees also build without an incremental cache
  (`.claude/hooks/worktree-cargo.toml`, since 2026-10-11).
- **A dev build carries line tables only, in every checkout and in CI** (the root
  `Cargo.toml`'s `[profile.dev]`, since 2026-10-11): a backtrace names the file and the line, a
  debugger shows no variables, and a dependency carries no debug info at all. On Windows the
  debug info was the link — a rebuild of the desktop app after an edit in the host went from
  13.8 s to 8.4 s, and the build tree from 13 GB to 5 GB. For a debugger session, set
  `CARGO_PROFILE_DEV_DEBUG=true` in the environment of the build: the workspace's own crates
  get their variables back, and only they rebuild.
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
  **`web:wasm` refuses an engine module over its ceiling** (10 000 000 B; `scripts/build-wasm.ts`
  has why, and how to raise it): the card scanner's session and network runtime linked into the
  engine are megabytes nothing else would notice. **A full `web:wasm` empties `dist-wasm/`.**
  **`pnpm web:scanner-smoke`** scans a card in the built app: a headless Chromium whose camera
  is a file showing one real card, on the desktop face — the tray, the collection, offline, a
  staged fault, and the Worker ended on leaving — and again on the phone face at 360px, in a
  profile of its own. The Neural scanner's files are served from the build's own origin (they
  are in git, `crates/card-neural/models/`); nothing is fetched first. The
  card's picture is fetched from Scryfall's CDN once by the script and kept in the temp
  folder; `SCAN_CARD_PICTURE=<file>` runs it with no request at all.
  **`pnpm web:sync-smoke`** is live sync end to end: two headless Chromium profiles (the
  desktop face and the phone face) claim, pair and sync through `infrastructure/relay/`'s own code under
  workerd (`wrangler dev --local`, a local D1, nothing that reaches Cloudflare), by the relay's
  real name and under the shipped policy; `--measure` adds a minute's profile of the idle
  loop, twice. It runs the pinned wrangler (`npm ci --ignore-scripts --prefix
  infrastructure/wrangler` first), or the `wrangler.js` that `WRANGLER` names. **A walk whose
  browser's network service died is walked again, up to five walks in all** (Chrome 155.0.8059.39's fault, issue
  #1296 — `scripts/web-smoke/fault.ts`); any other failure is final. A wait that never ends
  names the requests left unanswered, what each socket heard and the relay's last lines;
  `SYNC_SMOKE_RELAY_LOG=<file>`, `SMOKE_BROWSER_LOG=<file>` and `SMOKE_CRASH_DUMPS=<dir>` keep
  the relay's output, each browser's and a crashed process's minidump. ⚠️ Chrome and wrangler
  both obey `HTTPS_PROXY`: behind one, unset it for the run, or every relay request goes to the
  proxy. Two walks in one checkout no longer remove each other's wrangler bundle.
  **`pnpm web:sync-pull --ops <n>`** is a measurement on that harness, not a check: what
  a `pull` of `n` ops costs the engine's Worker and the relay (`--live` and `--join` are the two
  neighbouring cases; [light-app.md](../reference/light-app.md) §10.5, and §10.5b for the
  paged pull it measures now). Nothing runs it —
  half a minute at a thousand ops, five at fifty thousand.
  **`verify` runs none of them** — CI's `web` job runs the two smokes. See [`crates/grimoire-web/CLAUDE.md`](../../crates/grimoire-web/CLAUDE.md).
- `pnpm scanner:corpus status|pull [--drain]` — readers' scans, from the scan inbox to the private
  corpus bucket and down to `.scanner-corpus/` in the main checkout. Needs `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. **Never run `scanner:corpus pull` unasked**:
  it writes to a bucket, and `--drain` deletes from the inbox. `status` changes nothing. An
  argument it does not know is refused, before any network call.
  `pnpm scanner:corpus remove <id>... [--from-file <path>] [--yes]` takes named scans out of both
  buckets and the mirror (bad or mislabelled scans, cleanup; remove only, never a relabel). Without
  `--yes` it is a dry run that lists where each id is and deletes nothing; **never run
  `remove --yes` unasked**. The report's *Copy remove command* button builds the line.
  `pnpm scanner:replay [--baseline <name>] [--save-baseline <name>] [--only <text>]` replays that
  mirror through the Neural scanner — two passes a scan, as scanned and unfiltered — (a release
  build of `replay`, a few minutes the first time) and writes
  `summary.md` and `report.html` beside it; it asks no network and takes no lock. The mirror and
  the report are readers' photographs: none of it goes in git. [card-scanner.md](../reference/card-scanner.md)
  §10, *The replay*.
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
