#!/usr/bin/env node
// Readers' scans, replayed through the card scanner — the table, and the page.
//
//   pnpm scanner:replay                          replay the whole mirror
//   pnpm scanner:replay --baseline first         and say what changed since `baselines/first.json`
//   pnpm scanner:replay --save-baseline first    keep this run's results as that baseline
//   pnpm scanner:replay --only "lightning bolt"  runs whose card name or id contains the text
//
// Also `--corpus <corpus.db>`, found in the main checkout when left out, `--jobs <n>`, and
// `--no-build`, which trusts the binary as it is. The recogniser's files are the ones in git
// (`crates/card-neural/models/`). `--neural-evidence <dir>` hands the passes the set symbol and
// collector band files, and each decision then records its candidates and scores (`evidence`);
// `--neural-evidence-meta <neural.json>` reads the thresholds from that file instead of the
// models' own.
//
// **Two passes a scan**: As scanned (the label's filters) and Neural (none). A scan sent while
// the scanner still had its Fast and Exact modes is replayed all the same: its frames are what
// the camera saw.
//
// **Run `pnpm scanner:corpus pull` first**: this reads the local mirror and asks no network.
// It writes `out/results.json`, `out/summary.md` and `out/report.html` beside the corpus.
// None of it is for git: the report draws readers' photographs. Only the summary's table
// belongs in the reference document.
//
// The binary supplies facts (`crates/card-scanner/src/bin/replay.rs`); every count here is
// `scripts/scanner-replay/summary.ts`'s, which the summary and the page both read. The
// arguments are `scripts/scanner-replay/cli.ts`'s.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDir } from "./scanner-corpus/mirror.ts";
import { baselineNote, commitLabel, parseArgs } from "./scanner-replay/cli.ts";
import { reportHtml } from "./scanner-replay/report.ts";
import { parseResults } from "./scanner-replay/results.ts";
import { summaryMarkdown } from "./scanner-replay/summary.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(ROOT, "crates/card-scanner");
const TARGET_DIR = join(SCANNER, "target");
const EXE = process.platform === "win32" ? ".exe" : "";

function fail(message: string): never {
  console.error(`scanner:replay: ${message}`);
  process.exit(1);
}

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  fail((error as Error).message);
}

const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
const main = dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
const dir = corpusDir(process.env, join(main, ".git"));
if (!existsSync(join(dir, "labels"))) fail(`no scans in ${dir} — run \`pnpm scanner:corpus pull\` first`);

// Said before the replay, not after minutes of it.
const baselines = join(dir, "baselines");
const baselineFile = args.baseline ? join(baselines, `${args.baseline}.json`) : null;
if (baselineFile && !existsSync(baselineFile)) fail(`no baseline ${args.baseline} in ${baselines}`);
// Parsed here too, so a file that is not a results file fails in a second, not after the replay.
let base: ReturnType<typeof parseResults> | null = null;
if (baselineFile) {
  try {
    base = parseResults(readFileSync(baselineFile, "utf8"));
  } catch (error) {
    fail(`baseline ${args.baseline} (${baselineFile}) is not a results file: ${(error as Error).message}`);
  }
}

/** The given path, else the first candidate that exists, in this checkout and then the main one. */
function find(what: string, flag: string, given: string | null, candidates: string[]): string {
  if (given) return existsSync(given) ? given : fail(`${flag} ${given} does not exist`);
  for (const base of [ROOT, main]) {
    for (const candidate of candidates) {
      if (existsSync(join(base, candidate))) return join(base, candidate);
    }
  }
  return fail(`no ${what} found — pass ${flag}`);
}

const corpus = find("corpus.db", "--corpus", args.corpus, [
  "target/debug/data/corpus.db",
  "src-tauri/target/debug/data/corpus.db",
]);
const out = join(dir, "out");

if (!args.noBuild) {
  const cargo = [
    "build", "--locked", "--manifest-path", join(SCANNER, "Cargo.toml"), "--target-dir", TARGET_DIR,
    "--release", "--features", "cli", "--bin", "replay",
  ];
  const built = spawnSync("cargo", cargo, { cwd: ROOT, stdio: "inherit" });
  if (built.status !== 0) fail("the replay binary did not build");
}

mkdirSync(out, { recursive: true });
const dirty = git("status", "--porcelain", "--", "crates/card-scanner") !== "";
const ran = spawnSync(
  join(TARGET_DIR, "release", `replay${EXE}`),
  [
    "--corpus-dir", dir, "--corpus", corpus, "--out", out,
    "--commit", commitLabel(git("rev-parse", "--short", "HEAD"), dirty, args.noBuild),
    ...args.only.flatMap((text) => ["--only", text]),
    ...(args.jobs ? ["--jobs", args.jobs] : []),
    ...(args.neuralEvidence ? ["--neural-evidence", args.neuralEvidence] : []),
    ...(args.neuralEvidenceMeta ? ["--neural-evidence-meta", args.neuralEvidenceMeta] : []),
  ],
  { cwd: ROOT, stdio: "inherit" },
);
if (ran.status !== 0) fail("the replay did not finish");

const now = parseResults(readFileSync(join(out, "results.json"), "utf8"));

const summary = summaryMarkdown(now, base);
writeFileSync(join(out, "summary.md"), summary);
writeFileSync(join(out, "report.html"), reportHtml(now, base, { frames: "../frames" }));
const saved = args.saveBaseline ? join(baselines, `${args.saveBaseline}.json`) : null;
const replaced = saved !== null && existsSync(saved);
if (saved) {
  mkdirSync(baselines, { recursive: true });
  copyFileSync(join(out, "results.json"), saved);
}

console.log(summary);
console.log(`summary  ${join(out, "summary.md")}`);
console.log(`report   ${pathToFileURL(join(out, "report.html")).href}`);
if (saved && args.saveBaseline) console.log(baselineNote(args.saveBaseline, saved, replaced));
