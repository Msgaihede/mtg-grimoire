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
// Semantics are `case`'s, kept exactly: **first match wins** — the order of `ARMS` is the rule
// every arm below is placed by — and `*` matches any run of characters **including `/`**, so
// `src/*` is the whole tree and `*.md` is a Markdown file at any depth. Nothing else is special.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Every job a `changes` output gates, in the order the outputs are printed. */
export const JOBS = ["frontend", "rust", "powershell", "wasm", "android"];

/** The four jobs that build something. The fail-safe sets these and not `powershell`. */
const BUILD = ["frontend", "rust", "wasm", "android"];

export const ARMS = [
  // The gate itself. A change to the gate re-runs the whole gate.
  { match: [".github/workflows/ci.yml", "scripts/ci-route.mjs"], jobs: JOBS },

  // The wasm build's own inputs, and nothing else's. **Above `scripts/*` and `src/*`**, both of
  // which match more broadly and would route the wrong jobs first. `vite.web.config.ts` is not
  // matched by the `vite.config.ts` literal below, but it is listed here so the pair reads as
  // one decision.
  { match: ["scripts/build-wasm.mjs", "vite.web.config.ts"], jobs: ["frontend", "wasm"] },

  // The frontend half of the web target: what the web bundle adds on top of the desktop one,
  // and `npm run web:build` type-checks and bundles all of it.
  { match: ["src/workers/*", "src/web/*", "src/lib/core/*"], jobs: ["frontend", "wasm"] },

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
      ".github/workflows/release.yml",
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

  // The two files under `gen/android/` that a Rust test `include_str!`s — one pins
  // `minSdk`/`targetSdk`/the debug suffix, the other pins the permission list to `INTERNET`
  // alone. Test inputs rather than build inputs, and no frontend test reads either. **Above the
  // arm that silences the rest of that tree.**
  {
    match: [
      "src-tauri/gen/android/app/build.gradle.kts",
      "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    ],
    jobs: ["rust"],
  },

  // The rest of the Android Gradle project. Nothing reads it: `cargo` does not compile Kotlin,
  // `eslint` does not lint a `.gradle.kts`, and the `android` job cross-compiles the library
  // without Gradle. **Above `src-tauri/*`**, or a theme colour would run the whole matrix.
  { match: ["src-tauri/gen/android/*"], jobs: [] },

  // Rust — and the frontend too. **Every build job reads this tree**:
  //   - `rust` compiles and tests it;
  //   - `wasm` and `android` build the same crate for two more targets, and each has broken
  //     with `verify` green (a `use tauri::` on the wasm side of `lib.rs`'s map; #270 for
  //     Android, found by building an APK by hand);
  //   - `frontend` reads files here as text — `ipc.test.ts`'s mirror of every command module
  //     it wraps, `db.rs`, `image_uri.rs`, `share/publish.rs`, `tauri.conf.json` and the share
  //     golden `share/__golden__/snapshot.json` — so a Rust change that drifts from
  //     `src/lib/ipc.ts` is red only in `frontend`.
  // Narrowing `frontend` to exactly those paths was considered and not done: a new `?raw` import
  // would need a new entry here, and forgetting it is the silent skip this arm exists to
  // prevent. The `dist/index.html` that `tauri-build` demands is stubbed by the jobs themselves.
  { match: ["src-tauri/*"], jobs: BUILD },

  // The TypeScript side's files that Rust tests read. `transfer::write` asserts the Rust export
  // writer reproduces every golden file byte for byte (with `card.rs` and `fields.rs` reading
  // `corpus.json` and `fields.json`), and `changes` asserts `userTables.json` is the user side
  // of its table registry. Test inputs only — every read is in a `#[cfg(test)]` module — so
  // neither `wasm` nor `android`, whose builds compile no tests. **Above `src/*`.**
  {
    match: ["src/features/transfer/__golden__/*", "src/lib/userTables.json"],
    jobs: ["frontend", "rust"],
  },

  // Frontend. What `npm run build` (`tsc && vite build`), `eslint .` and `vitest run` read.
  { match: ["src/*", "public/*", "index.html"], jobs: ["frontend"] },
  {
    match: ["package.json", "package-lock.json", "components.json", ".prettierrc"],
    jobs: ["frontend", "wasm"],
  },
  // `npm run web:build` is `tsc && vite build --config vite.web.config.ts`, and that config
  // merges `vite.config.ts` — so all four of these are wasm inputs too.
  {
    match: ["tsconfig.json", "tsconfig.node.json", "vite.config.ts", "eslint.config.js"],
    jobs: ["frontend", "wasm"],
  },
  // `scripts/` because `eslint .` lints it — its ignore list does not name it — and because
  // `vitest` collects `scripts/**/*.test.mjs`.
  { match: ["scripts/*"], jobs: ["frontend"] },

  // The `card-scanner` crate: a separate cargo package, deliberately not a workspace member,
  // that `src-tauri` takes as a path dependency. `rust` compiles it into the app and runs its
  // own suite, `android` cross-compiles it, and `frontend` reads eight of its `.rs` files as
  // text (`ipc.test.ts`'s mirror rows) and lints `crates/*/scripts/**/*.mjs`. `wasm` is kept
  // although `src-tauri/Cargo.toml` has the dependency in its `cfg(not(target_family =
  // "wasm"))` block — which block it sits in is that manifest's decision, not this router's.
  { match: ["crates/*"], jobs: BUILD },

  // Anything unrecognised runs every build job. This is the fail-safe that makes the lists above
  // safe to be wrong in the cheap direction: a new root config, a new top-level directory, a
  // path nobody thought about — all of it gets full CI until someone deliberately narrows it.
  // **It is load-bearing for `share-worker/`**: a Rust test reads `share-worker/wrangler.jsonc`
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
