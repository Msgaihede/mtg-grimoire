// Which CI jobs a set of changed paths can possibly have broken — the `changes` job's router.
//
//   git diff --name-only --no-renames "$BASE_SHA" HEAD | node scripts/ci-route.mjs
//   node scripts/ci-route.mjs --all     # no usable base commit: every job, `powershell` too
//
// Prints one `job=true|false` line per job in `JOBS` order, which is the shape `$GITHUB_OUTPUT`
// takes. Dependency-free on purpose: the `changes` job runs it with no `npm ci`.
//
// **This was an inline `case` in `ci.yml`, and it moved so `ci-route.test.mjs` can hold it to
// what the two suites actually read.** That `case` said the two build jobs "share no inputs",
// and they share plenty: frontend tests read files under `src-tauri/` and `crates/` as text
// (`ipc.test.ts`'s mirror rows, the share golden), and Rust tests read
// `src/lib/userTables.json` and `src/features/transfer/__golden__/`. So a Rust-only change that
// drifted from `src/lib/ipc.ts` merged green and went red on the next unrelated PR. The test
// derives that census from the sources on every run, so it cannot rot the way the sentence did.
//
// **`core` is the narrow one** (2026-10-02). It compiles `crates/grimoire-core` for the two
// targets `rust` never builds, so it reads that crate, `card-scanner` (a dependency of the
// engine's since the scanner's session glue moved, 2026-10-03), and what every cargo build in
// the workspace shares — the root manifest, the lockfile, cargo's config, the pinned toolchain —
// and nothing under `src-tauri/`, which the engine does not depend on. Its native compile and
// its tests are `rust`'s, so everything that routes to `core` routes to `rust` as well.
//
// **`web` is the wide one** (phase 5, step 5.1). It builds the engine into a WASM module, the
// light page around it, and opens the result in a browser — so it reads both halves: everything
// `core` reads (the module is the engine, linked), the web host in `crates/grimoire-web`, and
// what the light page is bundled from. Everything that routes to `core` routes to `web`.
//
// Semantics are `case`'s, kept exactly: **first match wins** — the order of `ARMS` is the rule
// every arm below is placed by — and `*` matches any run of characters **including `/`**, so
// `src/*` is the whole tree and `*.md` is a Markdown file at any depth. Nothing else is special.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Every job a `changes` output gates, in the order the outputs are printed. */
export const JOBS = ["frontend", "rust", "core", "powershell", "storybook", "android", "web"];

/**
 * The two jobs a Rust source can break: `rust`, which compiles it, and `frontend`, whose tests
 * read it as text. Not `storybook` — nothing it builds imports a file under `src-tauri/` or
 * `crates/`, and the fake's parity with `generate_handler!` is a vitest test that runs in
 * `frontend`.
 */
const RUST_SIDE = ["frontend", "rust"];

/**
 * Those two, `core` and `web`, for what the engine's other two targets are built from: the
 * `grimoire-core` crate itself, `card-scanner` beside it, and the files every cargo build in the
 * workspace shares.
 *
 * **`web` is in the constant rather than beside it** (phase 5): `core`'s wasm leg proves the
 * engine compiles for a browser, and `web` is the job that links that compile into the module a
 * browser loads and opens it. Whatever can change the first can change the second, so no arm may
 * set one without the other — and one list is how that stays true without anybody remembering.
 */
const CORE_SIDE = [...RUST_SIDE, "core", "web"];

/**
 * The three jobs that bundle the page: `frontend` (`tsc`, `eslint`, `vitest` and the desktop's
 * `vite build`), `storybook`, and `web`, which is the only job that builds the light entry into
 * `dist-web/` and loads it. The light page is the app's own components under a second entry, so
 * what feeds one bundle feeds the other.
 */
const PAGE_SIDE = ["frontend", "storybook", "web"];

/**
 * Every job that builds something **for every change it cannot place**. The fail-safe sets these
 * and not `powershell` — **and not `android`**, which builds the light app's APK (phase 4,
 * 2026-10-03): its inputs are the host in `mobile/src-tauri`, the cargo workspace's shared files
 * and the frontend bundle, each of which has an arm that names it, and an unrecognised path is
 * none of them. It is also the slowest job here — a release build of the whole engine for
 * `aarch64-linux-android`, then Gradle — so a fail-safe that set it would make every new root
 * config a twenty-minute wait for a proof about nothing it touched.
 *
 * **`web` is in it, through `CORE_SIDE`, and `android`'s argument is why.** That one stays out
 * because an unrecognised path cannot be an input to the APK. It *can* be one to the web build,
 * which is the page and the engine both: a new root config that Vite or `tsc` loads, a new
 * directory the light entry imports from, a new crate the engine takes — each lands here first,
 * and `web` is the only job that would notice any of them in `dist-web/`. Only a wrong skip is
 * dangerous, and this job is minutes rather than twenty.
 */
const BUILD = [...CORE_SIDE, "storybook"];

export const ARMS = [
  // The gate itself. A change to the gate re-runs the whole gate.
  { match: [".github/workflows/ci.yml", "scripts/ci-route.mjs"], jobs: JOBS },

  // The pinned Rust toolchain and the one action that installs it. `rust` and `core` read
  // them, and `frontend` because `scripts/toolchain.test.mjs` does — it holds every workflow to
  // installing Rust through that action and nothing else. **Above the `*` fail-safe only for
  // `storybook`'s sake**, which installs no Rust.
  //
  // **And `android`**, which installs the same toolchain with the Android target added: a pin
  // the APK build cannot use is red there and nowhere else. `web` installs it with the wasm
  // target, and is in `CORE_SIDE`.
  {
    match: ["rust-toolchain.toml", ".github/actions/rust-toolchain/*"],
    jobs: [...CORE_SIDE, "android"],
  },

  // The cargo workspace's own files, at the repository root since 2026-10-02: the manifest that
  // names the members and holds the profiles, the one lockfile both members resolve from, and
  // the config that says where they build. **`core` because the lockfile is shared**: a
  // dependency bumped for the desktop moves the versions the engine's other two targets
  // compile, and `rust` builds neither of them. `frontend` is here as it was while the lockfile
  // sat under `src-tauri/*`; no test reads these three today, so that half is the cheap
  // direction to be wrong in. Above the fail-safe for `storybook`'s sake, as the arm above is.
  // **The patterns are anchored, so these are the root's only** — `src-tauri/Cargo.toml` and
  // `crates/card-scanner/.cargo/config.toml` match their own trees' arms below.
  // **And `android`**: the lockfile is what the APK links, and the root manifest names the light
  // host as a member — a dependency bumped for the desktop is a dependency the phone ships.
  // **And `web`, through `CORE_SIDE`, for two reasons of its own**: the lockfile is what the
  // module links, and it is where the job reads which `wasm-bindgen` CLI to install — a bump of
  // that crate is a different CLI on the next run, or glue that does not fit its module.
  { match: ["Cargo.toml", "Cargo.lock", ".cargo/*"], jobs: [...CORE_SIDE, "android"] },

  // The workflows outside this gate, and Dependabot's config. No job in `ci.yml` runs any of
  // them, but `scripts/toolchain.test.mjs` reads every workflow — a release built on a floating
  // `stable` is the worst version of the drift the pin exists to stop — and
  // `scripts/actions-pinned.test.mjs` reads them all and this config (every action pinned by SHA,
  // every checkout without its token, no workflow-wide write grant, Dependabot watching every
  // pin), so a change to any of them runs those tests. **Above the prose arm**, where
  // `release.yml` sat until the first test existed. `android-emulator.yml` (phase 4, step 4.5)
  // measures the light app's first run on an emulator and gates nothing — **not `android`**,
  // because it builds its own APK, and a change to it is proved by its own run.
  {
    match: [
      ".github/workflows/release.yml",
      ".github/workflows/scanner-bundle.yml",
      ".github/workflows/android-emulator.yml",
      ".github/dependabot.yml",
    ],
    jobs: ["frontend"],
  },

  // The Node version the jobs that bundle the page read through `node-version-file` — `web` among
  // them since phase 5. `rust`, `core` and `powershell` install none. (`android` installs it too
  // and is left to these three: every arm that sets it sets `rust`, and a Node the light bundle
  // will not build under is red in `web`, which builds that bundle through the same config.)
  { match: [".nvmrc"], jobs: PAGE_SIDE },

  // release-please's config, which says which files a release bumps. `desktop.rs`'s
  // `the_core_wears_the_apps_version` reads it: the engine's manifest carries the app's version
  // (the `User-Agent` is built from it), and a config that stopped naming that manifest would
  // ship a release whose two versions disagree. `frontend` beside `rust` because the census
  // test holds every file a Rust source reads from outside its crate to both. **Above the prose
  // arm**, where this file sat until a test read it.
  { match: ["release-please-config.json"], jobs: RUST_SIDE },

  // release-please's manifest: the last version it released. `scripts/release-rule.test.mjs`
  // holds it to every other version in the tree (step 6.6) — it is where
  // `scripts/web-deploy-guard.mjs` learns which tag to compare with, so a manifest that
  // disagreed with `package.json` would be a guard looking at the wrong release. **Above the
  // prose arm**, where this file sat until a test read it.
  { match: [".release-please-manifest.json"], jobs: ["frontend"] },

  // Affects no job. Nothing here is compiled, linted or tested: `eslint .` never sees a `.md`,
  // and no test on either side reads one (`ci-route.test.mjs` holds that to the census). **Keep
  // this list small — it is the only arm that can wrongly skip work.**
  {
    match: ["docs/*", "*.md", ".vscode/*", ".gitignore", ".gitattributes"],
    jobs: [],
  },

  // PowerShell. The `powershell` job runs this repo's `.ps1` test files, and nothing else here
  // consumes one: `eslint` does not lint it, `vitest` does not collect it, cargo does not read
  // it. **Above `src-tauri/*` and `scripts/*`** — `scripts/` is on the frontend list because
  // `eslint .` lints it, which is untrue of a `.ps1`, so a `scripts/*.ps1` matching that arm
  // first would run the wrong job and skip this one. Measured on PR #28 before this arm existed:
  // `lock.ps1` ran `frontend` and the full `rust` matrix to prove nothing about either.
  // `.psm1`/`.psd1` are here because **the fail-safe does not set `powershell`**, so a module
  // `lock.ps1` imports would otherwise run the build jobs and skip the only one that tests it.
  { match: ["*.ps1", "*.psm1", "*.psd1"], jobs: ["powershell"] },

  // Rust — and the frontend too. **Every build job but `storybook` reads this tree**:
  //   - `rust` compiles and tests it;
  //   - `frontend` reads files here as text — `ipc.test.ts`'s mirror of every command module
  //     it wraps, `share/publish.rs`, `tauri.conf.json` and the share golden
  //     `share/__golden__/snapshot.json`, and `desktop.rs`'s `generate_handler!` list,
  //     which `.storybook/fake/parity.test.ts` holds the Storybook fake to — so a Rust change
  //     that drifts from `src/lib/ipc.ts` or from the fake is red only in `frontend`.
  // Narrowing `frontend` to exactly those paths was considered and not done: a new `?raw` import
  // would need a new entry here, and forgetting it is the silent skip this arm exists to
  // prevent. The `dist/index.html` that `tauri-build` demands is stubbed by the jobs themselves.
  // **Not `core`**: the engine does not depend on the desktop host, so nothing here can change
  // what its other targets compile. What the two share is the lockfile, which has its own arm.
  // **Not `web`**, for the same reason one host over: the browser's host is
  // `crates/grimoire-web`, and nothing it links or bundles is in this tree.
  { match: ["src-tauri/*"], jobs: RUST_SIDE },

  // The TypeScript side's files that Rust tests read. `transfer::write` asserts the Rust export
  // writer reproduces every golden file byte for byte (with `card.rs` and `fields.rs` reading
  // `corpus.json` and `fields.json`), and `changes` asserts `userTables.json` is the user side
  // of its table registry and `syncedTables.json` is `schema::SYNCED_TABLES`. **Above `src/*`**,
  // so it owes whatever that arm sets — `web` since phase 5: `syncedTables.json` is a module the
  // page imports (`crossWindow.ts`), and the other two ride along rather than earning an arm
  // each.
  {
    match: [
      "src/features/transfer/__golden__/*",
      "src/lib/userTables.json",
      "src/lib/syncedTables.json",
    ],
    jobs: ["rust", ...PAGE_SIDE],
  },

  // **The light app's Android host** (phase 4, 2026-10-03): a workspace member, so `rust`
  // compiles it for the desktop and runs its tests; `android` builds it into an APK, which is the
  // only job that links it for a phone and packs `gen/android`; and `frontend` because
  // `mobile/host.test.ts` reads its manifest, its Gradle file and its config as text — the
  // hand edits a re-init would revert. **Above `mobile/*`**, and the order is the rule.
  // **Not `web`**: this is the phone's host, and the browser links none of it.
  { match: ["mobile/src-tauri/*"], jobs: ["frontend", "rust", "android"] },
  // The light app's pages and entry: a React tree like `src/`, which `tsc`, `eslint`, `vitest`
  // and Storybook's story glob all read. Until this arm it fell to the fail-safe and ran the
  // whole Rust matrix and `core` for a change to a phone sheet. **And `web`** (phase 5), whose
  // page this is: `mobile/index.html` is the document `dist-web/` is built from, and
  // `mobile/public/` — the web manifest, its icons, the favicon — is copied into it as it stands.
  { match: ["mobile/*"], jobs: PAGE_SIDE },
  // Frontend. What `npm run build` (`tsc && vite build`), `eslint .` and `vitest run` read — and
  // `storybook`, which builds every `*.stories.tsx` under `src/` and serves `public/` as its
  // static directory. **And `web`**: the light entry imports its components, its transports and
  // its Worker from `src/`. `public/` itself has reached no `dist-web/` since step 5.4 — the
  // light builds' public directory is `mobile/public/` — so `web` runs for it with nothing to
  // notice, which is the side to be wrong on: only a wrong skip costs anything.
  { match: ["src/*", "public/*"], jobs: PAGE_SIDE },
  // The desktop's document, at the root. **Not `web`**, whose document is `mobile/index.html`:
  // the light config names that one as its only input, so this file reaches no `dist-web/`.
  { match: ["index.html"], jobs: ["frontend", "storybook"] },
  // The one file under `.storybook/` the light config imports, and it imports it **in every
  // mode** — `vite.mobile.config.ts` reads `FAKE_ALIASES` at load, before it knows which mode it
  // is in — so a version of this file that will not load is a `web:build` that never starts.
  // **Above `.storybook/*`**, which would otherwise take it.
  { match: [".storybook/fake/aliases.ts"], jobs: PAGE_SIDE },
  // The workbench and its fake. `frontend` because vitest collects `.storybook/**/*.test.ts`,
  // `tsc -p .storybook` is in `npm run build` and `eslint .` lints it. Until this arm it fell to
  // the fail-safe and ran the whole Rust matrix too; no Rust source reads a file here, which the
  // census below would say if one ever did. **Not `web`**: the fake is aliased in under `fake`
  // mode alone, and the web build's backend is the engine itself.
  { match: [".storybook/*"], jobs: ["frontend", "storybook"] },
  // What `npm ci` installs and what `npm run` means, for every job that runs either.
  { match: ["package.json", "package-lock.json"], jobs: PAGE_SIDE },
  { match: ["components.json", ".prettierrc"], jobs: ["frontend", "storybook"] },
  // Every `tsc` program at the root, and the two files every Vite build here starts from.
  // Storybook's Vite builder loads `vite.config.ts` as well, and `.storybook/main.ts` imports
  // `vite.watch.ts`; `web:build` runs `tsc` over the root program and the Worker's own, then Vite
  // through `vite.config.ts`, which the light config merges over.
  //
  // **A glob for the programs, and it is a narrowing as well as a widening**: `tsconfig*.json`
  // is anchored, so it is the root's files only (`.storybook/tsconfig.json` matches its own arm,
  // `.design-sync/tsconfig.json` still falls through). It names the web Worker's program
  // whatever that file is called, and it takes `tsconfig.relay.json` and
  // `tsconfig.share-worker.json` out of the fail-safe, where they ran the whole Rust matrix and
  // `core` for a file only `npm run build`'s `tsc -p` reads. `storybook` and `web` are the cheap
  // direction for those two. **`vite.watch.ts` fell to the fail-safe as well** until this arm.
  { match: ["tsconfig*.json", "vite.config.ts", "vite.watch.ts"], jobs: PAGE_SIDE },
  { match: ["eslint.config.js"], jobs: ["frontend", "storybook"] },
  // **The light app's own Vite config**: the entry plugin, the `fake` mode's aliases and, since
  // phase 5, the `web` mode. Until this arm it fell to the fail-safe. Three jobs run something
  // through it: `frontend` lints it (`eslint .`); `web` builds `dist-web/` with it and opens the
  // result; and `android`, whose `beforeBuildCommand` is `npm run mobile:build` — **the only CI
  // build of this config's default mode**, into the `dist-mobile/` the APK packs, so an edit
  // that adds a mode for the browser and breaks the phone's is red there and nowhere else.
  // **`rust` is here for `android`'s rule and not because it reads the file**: every arm that
  // sets `android` sets `rust`, and the fail-safe was already running it for this path.
  // Not `storybook`, which loads `vite.config.ts` and never this file.
  { match: ["vite.mobile.config.ts"], jobs: ["frontend", "rust", "android", "web"] },
  // `vite.sw.ts` is the web mode's own plugin — it builds `dist-web/sw.js` after the bundle and
  // into no other build — so it is `web`'s alone to run, and `frontend` lints it. Named here
  // rather than left to the fail-safe, which would run the whole Rust matrix for a service worker.
  { match: ["vite.sw.ts"], jobs: ["frontend", "web"] },
  // The web build's two scripts: `web:wasm`, which compiles the module and runs `wasm-bindgen`
  // over it, and `web:smoke`, which serves `dist-web/` and opens it in a headless browser.
  // `frontend` lints them like the rest of `scripts/`; `web` is the job that runs them.
  // **Above `scripts/*`**, which would lint a broken build script and never run it.
  // `scripts/web-smoke/*` is what the smoke answers the engine with instead of the real hosts: a
  // fixture changed is a first run changed, and nothing but `web` runs it. **And, since step
  // 6.3, `harness.mjs` beside them**: the server, the browser and the two fences, a module both
  // browser runs are written in — a change to it is a change to both.
  // **`scripts/web-sync-smoke.mjs`** (phase 6, step 6.3) is the third script: it pairs two
  // browsers through the relay's own code under workerd — out of `web-smoke/sync-harness.mjs`
  // since step 6.5, which the same glob routes. **`scripts/web-sync-pull.mjs` is not here on
  // purpose**: it measures a large pull on that harness and no job runs it, so `scripts/*`
  // lints it and that is all a change to it needs.
  {
    match: [
      "scripts/build-wasm.mjs",
      "scripts/web-smoke.mjs",
      "scripts/web-sync-smoke.mjs",
      "scripts/web-smoke/*",
    ],
    jobs: ["frontend", "web"],
  },
  // The Android release's scripts (`sign-bundle.sh`, `StripSignature.java`, `proof.sh`,
  // `check-version.sh`). `release.yml`'s `android-sign` job signs a release's bundle with the
  // upload key, and **`android` runs the same script here first, on throwaway keys** — the only
  // run it gets before a release. `rust` because every arm that sets `android` sets `rust`;
  // `frontend` because `mobile/host.test.ts` and `scripts/release-rule.test.mjs` read two of
  // them as text. Above `scripts/*`, which would lint them and run nothing.
  { match: ["scripts/android-release/*"], jobs: ["frontend", "rust", "android"] },
  // `scripts/` because `eslint .` lints it — its ignore list does not name it — and because
  // `vitest` collects `scripts/**/*.test.mjs`. The deploy guard and the post-deploy probe
  // (`web-deploy-guard.mjs`, `web-deploy-probe.mjs`) are here: no job in this gate runs either —
  // the first is run by hand before a deploy, the second by `release.yml` after one — and their
  // tests are `frontend`'s.
  { match: ["scripts/*"], jobs: ["frontend"] },

  // **The web app's hosting** (phase 5, step 5.5): `app-worker/`, the third Cloudflare Worker —
  // its `wrangler.jsonc`, the `_headers` file a deploy reads, and a script of a few lines.
  // `frontend` type-checks it (`tsc -p tsconfig.app-worker.json` in `npm run build`), lints it
  // and runs its tests, the fence between the Content-Security-Policy and the engine's hosts
  // among them. **And `web`**, which is the only job that *uses* what is here:
  // `vite.mobile.config.ts` imports `app-worker/src/headers.ts` at load and copies `_headers`
  // into `dist-web/`, so a file here that will not load, or will not parse, is a `web:build`
  // that stops. Until this arm the tree fell to the fail-safe and ran the whole Rust matrix,
  // `core` and `storybook` for a response header.
  // **Not `rust`, and the census says so**: no Rust source reads a file here — unlike
  // `share-worker/`, whose `wrangler.jsonc` one does, which is why that tree still has no arm.
  // The crossing runs the other way (`hosting.test.ts` reads `crates/grimoire-core`), and the
  // engine's arm already sets `frontend`. No job in this gate deploys it; `release.yml`'s
  // `web-deploy` does, at a tag, and nothing else may (step 6.6). **`package.json` and
  // `package-lock.json` here are that job's**: the one tool that deploys, pinned with everything
  // under it. No job in this gate installs from them — the root's `npm ci` does not see a
  // manifest that is not a workspace — and `frontend` runs the test that holds them
  // (`scripts/release-rule.test.mjs`).
  { match: ["app-worker/*"], jobs: ["frontend", "web"] },

  // **The sync relay** (phase 6, step 6.3): `relay/`, the Worker every device of a group asks.
  // Until this arm it fell to the fail-safe, which ran `core` and `storybook` for it as well.
  //   - `frontend` type-checks it (`tsc -p tsconfig.relay.json`), lints it and runs its tests;
  //   - `rust`, because Rust tests read five of its sources as text and the census holds this
  //     arm to them: the client's two request headers against `cors.ts`'s allow-list, the
  //     lapse's code against `claim.ts`, the browser's sub-protocols and keepalive against
  //     `ticket.ts` (`platform::socket`), a removal's epoch step against `groupauth.ts`
  //     (`sync_pair::identity`), and the sealed cap and the clock's bound against `log.ts`
  //     (`sync_engine::wire`, `hlc`). A word changed here alone is red there alone;
  //   - **`web`**, which is the only job that *runs* this code: `scripts/web-sync-smoke.mjs`
  //     starts it under workerd from `wrangler.jsonc`, seeds its D1 from `schema.sql`, and pairs
  //     two browsers through it. A relay that no longer answers a page is red there and nowhere
  //     else — every other test of it is a mock on one side or the other.
  // **Not `core`**: the engine compiles nothing from this tree. **Not `storybook`**: nor does a
  // story. Its README is prose, by the arm above every tree's. No job deploys it.
  { match: ["relay/*"], jobs: ["frontend", "rust", "web"] },

  // **The light app's web host** (phase 5, step 5.1): `grimoire-web`, a workspace member, so
  // `rust` formats, lints and tests it natively, and `web` is the only job that compiles it for
  // `wasm32-unknown-unknown`, runs `wasm-bindgen` over it and loads what comes out. `frontend`
  // for `src-tauri/*`'s reason: a `.rs` file a test reads as text is red there alone, and
  // narrowing to the files read today is the silent skip the day one is added.
  // **Not `core`**, by that job's own definition: `core` compiles what the *engine* is built
  // from, and the engine does not depend on a host — this one no more than the desktop's or the
  // phone's. **Above `crates/grimoire-core/*` and `crates/*`**, and the order is the rule: the
  // second would take this tree and cross-compile the engine twice for a change that cannot
  // have moved it.
  { match: ["crates/grimoire-web/*"], jobs: ["frontend", "rust", "web"] },

  // The engine: `grimoire-core`, a workspace member three hosts link. `rust` compiles it for
  // the desktop and runs its tests, `core` compiles it for the two targets `rust` never builds,
  // and `frontend` because a module that moves here takes its `?raw` readers with it —
  // `ipc.test.ts`'s mirror rows follow the file (`filters.rs`, since 2026-10-02), as does
  // `useTray.test.ts`'s pin on `db.rs`, and the census holds this arm to them.
  // **Above `crates/*`**, and the order is the rule: first match wins, so that arm would take
  // this tree and skip `core`, the one job that exists for it. **And `web`** (in `CORE_SIDE`):
  // the module a browser loads is this crate, linked.
  { match: ["crates/grimoire-core/*"], jobs: CORE_SIDE },

  // The `card-scanner` crate: a separate cargo package, excluded from the workspace on purpose,
  // that `src-tauri` takes as a path dependency. `rust` compiles it into the app and runs its
  // own suite, and `frontend` reads eight of its `.rs` files as text (`ipc.test.ts`'s mirror
  // rows) and lints `crates/*/scripts/**/*.mjs`. **And `core`, since the extraction's seventh
  // step**: the engine depends on it for the scanner's session glue, so a change here is a
  // change to what the engine compiles for a browser and a phone — which this arm said it would
  // gain on that day, and does. **`web` with it**, for the same dependency: the crate is linked
  // into the module.
  { match: ["crates/*"], jobs: CORE_SIDE },

  // Anything unrecognised runs every build job, `core` and `web` among them — `BUILD` says why
  // `web` is one and `android` is not. This is the fail-safe that makes the lists above safe to
  // be wrong in the cheap direction: a new root config, a new top-level directory, a path nobody
  // thought about — all of it gets full CI until someone deliberately narrows it. **It is
  // load-bearing for `share-worker/`**: a Rust test reads `share-worker/wrangler.jsonc`
  // (`share::publish`'s `SHARE_BASE` check), so an arm narrowing that tree must keep `rust`.
  { match: ["*"], jobs: BUILD },
];

/** A `case` pattern as a regex: `*` is any run of characters, `/` included; the rest literal. */
function compile(pattern) {
  const body = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

const COMPILED = ARMS.map((arm) => ({ ...arm, re: arm.match.map(compile) }));

/** The first arm `path` matches — the one `case` would take. The last arm matches everything. */
export function armFor(path) {
  return COMPILED.find((arm) => arm.re.some((re) => re.test(path)));
}

/** Which jobs this set of changed paths routes to. Blank entries are skipped, as the `case` loop did. */
export function route(paths) {
  const on = Object.fromEntries(JOBS.map((job) => [job, false]));
  for (const path of paths) {
    if (!path) continue;
    for (const job of armFor(path).jobs) on[job] = true;
  }
  return on;
}

function main() {
  const flags = process.argv.includes("--all")
    ? Object.fromEntries(JOBS.map((job) => [job, true]))
    : route(readFileSync(0, "utf8").split(/\r?\n/));
  for (const job of JOBS) console.log(`${job}=${flags[job]}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
