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
// targets `rust` never builds, so it reads that crate and what every cargo build in the
// workspace shares — the root manifest, the lockfile, cargo's config, the pinned toolchain —
// and nothing under `src-tauri/`, which the engine does not depend on. Its native compile and
// its tests are `rust`'s, so everything that routes to `core` routes to `rust` as well.
//
// Semantics are `case`'s, kept exactly: **first match wins** — the order of `ARMS` is the rule
// every arm below is placed by — and `*` matches any run of characters **including `/`**, so
// `src/*` is the whole tree and `*.md` is a Markdown file at any depth. Nothing else is special.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Every job a `changes` output gates, in the order the outputs are printed. */
export const JOBS = ["frontend", "rust", "core", "powershell", "storybook"];

/**
 * The two jobs a Rust source can break: `rust`, which compiles it, and `frontend`, whose tests
 * read it as text. Not `storybook` — nothing it builds imports a file under `src-tauri/` or
 * `crates/`, and the fake's parity with `generate_handler!` is a vitest test that runs in
 * `frontend`.
 */
const RUST_SIDE = ["frontend", "rust"];

/**
 * Those two and `core`, for what the engine's other two targets are built from: the
 * `grimoire-core` crate itself, and the files every cargo build in the workspace shares.
 */
const CORE_SIDE = [...RUST_SIDE, "core"];

/** Every job that builds something. The fail-safe sets these and not `powershell`. */
const BUILD = [...CORE_SIDE, "storybook"];

export const ARMS = [
  // The gate itself. A change to the gate re-runs the whole gate.
  { match: [".github/workflows/ci.yml", "scripts/ci-route.mjs"], jobs: JOBS },

  // The pinned Rust toolchain and the one action that installs it. `rust` and `core` read
  // them, and `frontend` because `scripts/toolchain.test.mjs` does — it holds every workflow to
  // installing Rust through that action and nothing else. **Above the `*` fail-safe only for
  // `storybook`'s sake**, which installs no Rust.
  { match: ["rust-toolchain.toml", ".github/actions/rust-toolchain/*"], jobs: CORE_SIDE },

  // The cargo workspace's own files, at the repository root since 2026-10-02: the manifest that
  // names the members and holds the profiles, the one lockfile both members resolve from, and
  // the config that says where they build. **`core` because the lockfile is shared**: a
  // dependency bumped for the desktop moves the versions the engine's other two targets
  // compile, and `rust` builds neither of them. `frontend` is here as it was while the lockfile
  // sat under `src-tauri/*`; no test reads these three today, so that half is the cheap
  // direction to be wrong in. Above the fail-safe for `storybook`'s sake, as the arm above is.
  // **The patterns are anchored, so these are the root's only** — `src-tauri/Cargo.toml` and
  // `crates/card-scanner/.cargo/config.toml` match their own trees' arms below.
  { match: ["Cargo.toml", "Cargo.lock", ".cargo/*"], jobs: CORE_SIDE },

  // The two workflows outside this gate, and Dependabot's config. No job in `ci.yml` runs any of
  // them, but `scripts/toolchain.test.mjs` reads both workflows — a release built on a floating
  // `stable` is the worst version of the drift the pin exists to stop — and
  // `scripts/actions-pinned.test.mjs` reads all three (every action pinned by SHA, every checkout
  // without its token, the signing secret in one job, Dependabot watching every pin), so a change
  // to any of them runs those tests. **Above the prose arm**, where `release.yml` sat until the
  // first test existed.
  {
    match: [
      ".github/workflows/release.yml",
      ".github/workflows/scanner-bundle.yml",
      ".github/dependabot.yml",
    ],
    jobs: ["frontend"],
  },

  // The Node version every job that installs Node reads through `node-version-file`. `rust` and
  // `powershell` install none.
  { match: [".nvmrc"], jobs: ["frontend", "storybook"] },

  // Affects no job. Nothing here is compiled, linted or tested: `eslint .` never sees a `.md`,
  // no test on either side reads one (`ci-route.test.mjs` holds that to the census), and
  // release-please's own files are read by `release.yml` rather than by this gate. **Keep this
  // list small — it is the only arm that can wrongly skip work.**
  {
    match: [
      "docs/*",
      "*.md",
      ".vscode/*",
      ".gitignore",
      ".gitattributes",
      ".release-please-manifest.json",
      "release-please-config.json",
    ],
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
  { match: ["src-tauri/*"], jobs: RUST_SIDE },

  // The TypeScript side's files that Rust tests read. `transfer::write` asserts the Rust export
  // writer reproduces every golden file byte for byte (with `card.rs` and `fields.rs` reading
  // `corpus.json` and `fields.json`), and `changes` asserts `userTables.json` is the user side
  // of its table registry and `syncedTables.json` is `schema::SYNCED_TABLES`. **Above `src/*`.**
  {
    match: [
      "src/features/transfer/__golden__/*",
      "src/lib/userTables.json",
      "src/lib/syncedTables.json",
    ],
    jobs: ["frontend", "rust", "storybook"],
  },

  // Frontend. What `npm run build` (`tsc && vite build`), `eslint .` and `vitest run` read — and
  // `storybook`, which builds every `*.stories.tsx` under `src/` and serves `public/` as its
  // static directory.
  { match: ["src/*", "public/*", "index.html"], jobs: ["frontend", "storybook"] },
  // The workbench and its fake. `frontend` because vitest collects `.storybook/**/*.test.ts`,
  // `tsc -p .storybook` is in `npm run build` and `eslint .` lints it. Until this arm it fell to
  // the fail-safe and ran the whole Rust matrix too; no Rust source reads a file here, which the
  // census below would say if one ever did.
  { match: [".storybook/*"], jobs: ["frontend", "storybook"] },
  {
    match: ["package.json", "package-lock.json", "components.json", ".prettierrc"],
    jobs: ["frontend", "storybook"],
  },
  // Storybook's Vite builder loads `vite.config.ts` as well.
  {
    match: ["tsconfig.json", "tsconfig.node.json", "vite.config.ts", "eslint.config.js"],
    jobs: ["frontend", "storybook"],
  },
  // `scripts/` because `eslint .` lints it — its ignore list does not name it — and because
  // `vitest` collects `scripts/**/*.test.mjs`.
  { match: ["scripts/*"], jobs: ["frontend"] },

  // The engine: `grimoire-core`, a workspace member three hosts link. `rust` compiles it for
  // the desktop and runs its tests, `core` compiles it for the two targets `rust` never builds,
  // and `frontend` because a module that moves here takes its `?raw` readers with it —
  // `ipc.test.ts`'s mirror rows follow the file (`filters.rs`, since 2026-10-02), as does
  // `useTray.test.ts`'s pin on `db.rs`, and the census holds this arm to them.
  // **Above `crates/*`**, and the order is the rule: first match wins, so that arm would take
  // this tree and skip `core`, the one job that exists for it.
  { match: ["crates/grimoire-core/*"], jobs: CORE_SIDE },

  // The `card-scanner` crate: a separate cargo package, excluded from the workspace on purpose,
  // that `src-tauri` takes as a path dependency. `rust` compiles it into the app and runs its
  // own suite, and `frontend` reads eight of its `.rs` files as text (`ipc.test.ts`'s mirror
  // rows) and lints `crates/*/scripts/**/*.mjs`. **Not `core`**: the engine does not depend on
  // it. The day it does — the scanner's session glue is the extraction's last step — this arm
  // gains `core` in the same commit.
  { match: ["crates/*"], jobs: RUST_SIDE },

  // Anything unrecognised runs every build job, `core` among them. This is the fail-safe that
  // makes the lists above safe to be wrong in the cheap direction: a new root config, a new
  // top-level directory, a path nobody thought about — all of it gets full CI until someone
  // deliberately narrows it. **It is load-bearing for `share-worker/`**: a Rust test reads
  // `share-worker/wrangler.jsonc` (`share::publish`'s `SHARE_BASE` check), so an arm narrowing
  // that tree must keep `rust`.
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
