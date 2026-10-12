#!/usr/bin/env node
// Readers' scans, from the inbox to a corpus that lasts, and down to this machine.
//
//   pnpm scanner:corpus status         count what is where; changes nothing
//   pnpm scanner:corpus pull           copy new scans inbox → corpus, mirror the corpus here
//   pnpm scanner:corpus pull --drain   the same, then delete from the inbox what verified
//
// **The inbox holds 500 runs and expects to be emptied** (`infrastructure/scan-worker/
// README.md`); the corpus bucket is where a read scan lives after. Before a pair is copied its
// label must parse, its `bytes` must add up to the run and each frame must be a JPEG; one that
// does not is left in the inbox and reported as "do not add up". Each copy is then read back by
// size. `--drain` is the only thing here that deletes anything remote: every complete inbox pair,
// adopted now or by an earlier pull, whose copy in the freshly listed corpus has the same two
// sizes. It is the owner's to run — never an agent's unasked.
//
// **A scan deleted from the corpus bucket is deleted here on the next pull**: frames, slices,
// the last report and its rows in every baseline, here and in the bucket. That is how a
// deletion request is honoured. Baselines (`baselines/*.json`) go both ways and are reconciled
// against the corpus on every pull; an upload that fails is listed in `baselines/.pending.json`
// and retried on the next. A baseline is written once: a changed one is not re-uploaded.
//
// Credentials are `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, from the
// environment and nowhere else: an R2 API token with object read and write on the two buckets.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { keepingRuns, parsePending, settlePending } from "./scanner-corpus/baselines.ts";
import { parseArgs } from "./scanner-corpus/cli.ts";
import { checkPair, corpusDir, localIds, removePair, removeReport, sweepOrphans, writePair } from "./scanner-corpus/mirror.ts";
import { drainable, pairs, plan, refusesPrune, unverified } from "./scanner-corpus/plan.ts";
import { createS3, type Fetch } from "./scanner-corpus/s3.ts";

const INBOX = "mtg-grimoire-scans";
const CORPUS = "mtg-grimoire-scan-corpus";

function fail(message: string): never {
  console.error(`scanner:corpus: ${message}`);
  process.exit(1);
}

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  fail((error as Error).message);
}
const { command, drain } = parsed;

const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((name) => !process.env[name]);
if (missing.length) fail(`set ${missing.join(", ")} — an R2 API token for ${INBOX} and ${CORPUS}`);

const s3 = createS3(
  {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  fetch as unknown as Fetch,
);
const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
}).trim();
const dir = corpusDir(process.env, gitCommonDir);

const listBoth = async (bucket: string) => [
  ...(await s3.list(bucket, "runs/")),
  ...(await s3.list(bucket, "labels/")),
];

const inbox = await listBoth(INBOX);
const corpus = [...(await listBoth(CORPUS)), ...(await s3.list(CORPUS, "baselines/"))];
const todo = plan({ inbox, corpus, local: localIds(dir) });

console.log(
  `inbox   ${pairs(inbox).size} scans, ${todo.litter.length} runs with no label, ${todo.strange.length} keys with a strange name`,
);
console.log(`corpus  ${pairs(corpus).size} scans, ${todo.baselinesDown.length} baselines`);
console.log(`here    ${localIds(dir).length} scans in ${dir}`);
if (command === "status") {
  console.log(`a pull would adopt ${todo.adopt.length}, fetch ${todo.fetch.length}, prune ${todo.prune.length}`);
  process.exit(0);
}

if (refusesPrune(pairs(corpus).size, localIds(dir).length)) {
  fail(
    `${CORPUS} lists no scans but ${localIds(dir).length} are mirrored here — the bucket looks empty or unreadable, ` +
      `so nothing was adopted or pruned and all ${localIds(dir).length} local scans were kept`,
  );
}

const failed: string[] = [];
const wrong: string[] = [];
const copied: string[] = [];
for (const id of todo.adopt) {
  try {
    const label = await s3.get(INBOX, `labels/${id}.json`);
    const run = await s3.get(INBOX, `runs/${id}.bin`);
    // Both objects are in hand: nothing is put until the label and the run add up.
    const sentence = checkPair(label, run);
    if (sentence) {
      wrong.push(`${id}: ${sentence}`);
      continue;
    }
    await s3.put(CORPUS, `runs/${id}.bin`, run);
    await s3.put(CORPUS, `labels/${id}.json`, label);
    copied.push(id);
  } catch (error) {
    failed.push(`${id}: ${(error as Error).message}`);
  }
}
// Ids not to fetch: a pair that does not add up, and one whose adoption failed (already listed).
const skipped = new Set([...wrong, ...failed].map((line) => line.slice(0, line.indexOf(":"))));

// Read the corpus back: each copy made here must be there at the inbox's sizes. Drain reads it too.
const corpusAfter = await listBoth(CORPUS);
for (const id of unverified(copied, inbox, corpusAfter)) {
  failed.push(`${id}: the copy in ${CORPUS} is missing or not the inbox's size`);
}

let fetched = 0;
for (const id of todo.fetch.filter((id) => !skipped.has(id))) {
  try {
    // `cutFrames`, inside `writePair`, is where a pair that does not add up is caught.
    writePair(dir, id, await s3.get(CORPUS, `labels/${id}.json`), await s3.get(CORPUS, `runs/${id}.bin`));
    fetched += 1;
  } catch (error) {
    failed.push(`${id}: ${(error as Error).message}`);
  }
}
const pruned: string[] = [];
for (const id of todo.prune) {
  try {
    removePair(dir, id);
    pruned.push(id);
  } catch (error) {
    failed.push(`prune ${id}: ${(error as Error).message}`);
  }
}
// What a half-finished prune or a failed fetch left behind: frame and slice folders of no pair.
const swept = sweepOrphans(dir);
if (swept) console.log(`swept ${swept} frame or slice folders that belonged to no scan here`);
if (pruned.length && removeReport(dir)) {
  console.log("deleted out/results.json, out/summary.md and out/report.html: they held a pruned scan; the next replay rewrites them");
}

// Baselines, reconciled on every pull: down what the corpus has and this machine lacks; out of
// every local one the rows of any scan the corpus no longer holds; then up what only this
// machine has, what was just rewritten and what an earlier pull could not upload.
const baselines = join(dir, "baselines");
mkdirSync(baselines, { recursive: true });
const safeName = (name: string) => name.endsWith(".json") && !name.startsWith(".");
for (const key of todo.baselinesDown.filter((k) => safeName(basename(k)))) {
  try {
    const path = join(baselines, basename(key));
    if (!existsSync(path)) writeFileSync(path, await s3.get(CORPUS, key));
  } catch (error) {
    failed.push(`${key}: ${(error as Error).message}`);
  }
}
const remote = new Set(todo.baselinesDown.map((key) => basename(key)));
const pendingPath = join(baselines, ".pending.json");
const pending = parsePending(existsSync(pendingPath) ? readFileSync(pendingPath, "utf8") : null);
const held = [...pairs(corpusAfter).keys()];
const rewritten = new Set<string>();
const unreadable = new Set<string>();
for (const name of readdirSync(baselines).filter(safeName)) {
  try {
    const path = join(baselines, name);
    const text = held.length ? keepingRuns(readFileSync(path, "utf8"), held) : null;
    if (text === null) {
      JSON.parse(readFileSync(path, "utf8"));
      continue;
    }
    writeFileSync(path, text);
    rewritten.add(name);
    console.log(`baseline ${name} rewritten without the scans the corpus no longer holds`);
  } catch (error) {
    unreadable.add(name);
    failed.push(`baselines/${name}: not uploaded, ${(error as Error).message}`);
  }
}
const local = readdirSync(baselines).filter(safeName);
const upload = local.filter(
  (n) => !unreadable.has(n) && (!remote.has(n) || rewritten.has(n) || pending.includes(n)),
);
const uploaded: string[] = [];
const notUploaded: string[] = [];
for (const name of upload) {
  try {
    await s3.put(CORPUS, `baselines/${name}`, readFileSync(join(baselines, name)));
    uploaded.push(name);
  } catch (error) {
    notUploaded.push(name);
    failed.push(`baselines/${name}: ${(error as Error).message} — retried on the next pull`);
  }
}
// A pending name that no longer exists, or cannot be read, has nothing to retry.
const gone = pending.filter((n) => !local.includes(n) || unreadable.has(n));
const nextPending = settlePending(pending, notUploaded, [...uploaded, ...gone]);
if (nextPending.join() !== pending.join()) {
  const tmp = `${pendingPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(nextPending));
  renameSync(tmp, pendingPath);
}

console.log(`adopted ${copied.length}, fetched ${fetched}, pruned ${pruned.length}`);
if (wrong.length) {
  console.log(
    `\ndo not add up (${wrong.length}) — left in the inbox untouched; a label's frames must add up to the run's bytes:\n  ${wrong.join("\n  ")}`,
  );
}
if (drain) {
  // Every complete inbox pair whose copy is there at the same two sizes, adopted now or by an earlier pull.
  const everyPair = [...pairs(inbox).keys()];
  const verified = drainable(everyPair, inbox, corpusAfter);
  for (const id of verified) {
    // The label first, deliberately: a half-deleted scan is then a run with no label — litter
    // the inbox already counts — never a label with no run.
    try {
      await s3.remove(INBOX, `labels/${id}.json`);
      await s3.remove(INBOX, `runs/${id}.bin`);
    } catch (error) {
      failed.push(`drain ${id}: ${(error as Error).message}`);
    }
  }
  console.log(`drained ${verified.length} of ${everyPair.length} in the inbox`);
}
if (failed.length) fail(`${failed.length} did not copy:\n  ${failed.join("\n  ")}`);
