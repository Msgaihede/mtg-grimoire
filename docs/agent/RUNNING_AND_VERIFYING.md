# Commands, running and verifying

The full command list and the traps you hit when you run the app, build it and verify it. Moved
out of the root [`CLAUDE.md`](../../CLAUDE.md) without changing the wording. The root file keeps
a short command table and the one-line versions of these rules.

Related: the `running-the-app` skill (locks and ports), [live-ui-verification.md](../reference/live-ui-verification.md)
(the CDP harness) and [tauri-mcp-bridge.md](../reference/tauri-mcp-bridge.md) (the other way to drive the window).

## Commands

- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild). Takes the `app` lock: only
  one app runs across every worktree. See the `running-the-app` skill.
- `npm run verify` — build + lint + `cargo fmt --check` + clippy + Vitest + cargo test. **Run
  at the end of a feature before committing (not after every intermediate change, to minimize re-fixing).**
  Rust is pinned by `rust-toolchain.toml` and Node by `.nvmrc`.
- `npm run test` / `test:run` — frontend tests; `cargo test --workspace` — Rust tests, for every
  member of the cargo workspace at the root (`src-tauri`, `crates/grimoire-core`, since
  2026-10-03 the light app's Android host `mobile/src-tauri`, and since 2026-10-04 its web
  host `crates/grimoire-web`, natively). **Its
  build tree is still `src-tauri/target`**: `.cargo/config.toml` pins it, so nothing that names
  that folder moved when the workspace arrived on 2026-10-02.
- `npm run test:coverage` / `test:coverage:rust` — coverage. **The Rust one's number is not
  `cargo llvm-cov`'s**: that counts the inline `#[cfg(test)]` modules, where every line is
  covered by definition, and reads ~14 points high. See
  [test-coverage.md](../reference/test-coverage.md) before quoting either figure.
- `npm run storybook` / `build-storybook` — the component workbench
- `npm run mobile:dev` / `mobile:tauri` — the light app, over the Storybook fake in a browser
  (port 5175, no lock) or over the real core in a phone-sized window (**takes the `app` lock**).
  See [`mobile/CLAUDE.md`](../../mobile/CLAUDE.md).
- `npm run web:wasm` / `web:build` / `web:smoke` — the light app's web host: the engine as a
  WASM module into `dist-wasm/` (needs clang and the `wasm-bindgen` CLI at `Cargo.lock`'s
  version), the page around it into `dist-web/`, and that bundle opened in headless Chromium.
  No lock; `web:dev` serves it on port 5176, and **`web:preview` serves the build under the
  hosting's own headers** — the local server to drive under the shipped policy; `web:smoke`
  serves under it too since 2026-10-04, and fails on a refusal.
  **`npm run web:sync-smoke`** is live sync end to end: two headless Chromium profiles (the
  desktop face and the phone face) claim, pair and sync through `relay/`'s own code under
  workerd (`wrangler dev --local`, a local D1, nothing that reaches Cloudflare), by the relay's
  real name and under the shipped policy; `-- --measure` adds a minute's profile of the idle
  loop, twice. It runs `app-worker`'s pinned wrangler (`npm ci --ignore-scripts --prefix
  app-worker` first), or the `wrangler.js` that `WRANGLER` names.
  **`npm run web:sync-pull -- --ops <n>`** is a measurement on that harness, not a check: what
  one unpaged `pull` of `n` ops costs the engine's Worker (`--live` and `--join` are the two
  neighbouring cases; [light-app.md](../reference/light-app.md) §10.5). Nothing runs it —
  half a minute at a thousand ops, five at fifty thousand.
  **`verify` runs none of them** — CI's `web` job runs the two smokes. See [`crates/grimoire-web/CLAUDE.md`](../../crates/grimoire-web/CLAUDE.md).
- `npm run web:deploy-guard` — may the web app be deployed from this tree, between releases?
  Compares `USER_SCHEMA_VERSION` here with the last release tag's (`git show`), in one sentence:
  exit 0 equal, 1 different, 2 could not tell. It also asks `gh` whether that release is
  published — a draft's tag exists before anybody can install it — which is exit 1 for a
  draft and 2 when it cannot ask; `--offline` skips the question and says so. Needs the tags
  fetched; builds and deploys nothing. **Equal schemas are necessary, not sufficient**: a wire
  change that is not a schema rung is dropped by an older build, and this cannot see it. The
  by-hand runbook runs it before `wrangler deploy`
  ([`app-worker/README.md`](../../app-worker/README.md)); a release deploys the tag and has no
  use for it.

## Running and verifying

- **Verify UI in the real app, not just in tests.** Every UI task in Plans 2–3 found something
  the suite could not. Drive the real window over CDP —
  [live-ui-verification.md](../reference/live-ui-verification.md) is the contract, and it
  documents traps that have each cost a session.
- **Under `tauri dev` the databases are `src-tauri/target/debug/data/user.db` and
  `corpus.db`** — not `src-tauri/data/`, and not one file: schema 27 split the reader's
  own tables out of the rebuildable ones. A folder still holding `mtg.db` is converted at
  the next launch. Delete that `data/` folder to force a clean first-run sync; deleting
  `corpus.db` alone costs a resync and nothing else, which is what the split is for.
- **A built app embeds `dist/` at compile time, so a frontend-only edit does not reach a
  `tauri build` binary.** Vite writes a new bundle, cargo then sees no Rust source change and
  leaves the old bundle inside the old exe — exiting 0. `touch src-tauri/src/main.rs` first, and
  stop the app before rebuilding or the link fails with `Access is denied. (os error 5)`.
  `npm run tauri dev` does not have this problem, which is why it is the command above.
- **A second launch does not start a second app — it opens another window in the one already
  running.** `tauri-plugin-single-instance` still gives the new process exit code 0, no window and
  no stderr, and a dev build still counts; what changed on 2026-09-20 is what the *first* process
  does about it. **So a dev build launched from another worktree opens a window in the running
  app, showing the RUNNING worktree's frontend** — a window that looks like yours and renders
  somebody else's branch. The `app` lock still prevents it; see the `running-the-app` skill and
  [multi-window.md](../reference/multi-window.md).
- **Every measured claim in this repo was measured on Windows. Nobody has run a Linux build.**
  Name the build (debug or release) in any figure you add; the same measurement can differ by ~8×.
