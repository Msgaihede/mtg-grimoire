import type { Message } from "./openrouter.ts";
export interface Release {
  isDraft: boolean;
  body?: string;
}
export interface PushResult {
  tag: string;
  outcome: "pushed" | "draft" | "refused";
  why: string;
}
export interface PushOptions {
  version: string;
  hasNotes: boolean;
  latestTag: string | null;
  view: (tag: string) => Release | null;
  wasKept: (tag: string) => boolean;
  keep: (tag: string, body: string) => void;
  edit: (tag: string, isLatest: boolean) => unknown;
}
// Release notes, written from the pull requests in a release
// (docs/superpowers/specs/2026-10-11-generated-release-notes-design.md).
//
//   node scripts/changelog/cli.ts next                      # CI: the coming release's notes
//   node scripts/changelog/cli.ts tag v0.41.0 [--force]     # one past release's file
//   node scripts/changelog/cli.ts backfill [--force]        # every tag that has no file yet
//   node scripts/changelog/cli.ts push 0.41.0 [0.42.0 …]    # a file → its release's body
//   node scripts/changelog/cli.ts push --all [--backup <dir>]
//
// **`next`** is what `release.yml`'s `changelog-write` runs on a push that cut no release. The
// released version is this tree's `.release-please-manifest.json`; the coming one is the release
// branch's copy of that file. With no release branch, or the same version on both, there is
// nothing to write and that is not a failure. It writes `release-notes/<version>.md`, which the
// next job puts on the release branch as `changelog/<version>.md`.
//
// **`tag` and `backfill`** write `changelog/<version>.md` for releases that already have a tag.
// `backfill` skips a file that exists, so it can be stopped and started; a release whose answer
// fails its checks twice is reported, the rest are still written, and the exit code is 1.
//
// **`push`** sets a *published* release's body from its file, and keeps the body it replaces —
// once — in a folder outside the repository. A draft is left alone. Every edit says whether its
// release is the one GitHub marks "Latest", so the mark cannot move. It ends with a tally and
// exits 1 if any release that was asked for was not pushed (with `--all`, a draft is not one).
// This is the only command that changes anything on GitHub, and it is how a published note is
// corrected: change the file, then push.
//
// Needs `OPENROUTER_API_KEY` for everything but `push`. GitHub is read with `GITHUB_TOKEN`,
// `GH_TOKEN`, or `gh auth token`, and `push` runs `gh`.
//
// The parsing and the planning are pure, and `cli.test.ts` holds them. Everything that touches
// git, the disk or the network is in `main`.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collect, githubPulls } from "./collect.ts";
import { notesFor } from "./generate.ts";
import { SCHEMA, omittedLines } from "./notes.ts";
import { complete } from "./openrouter.ts";

export const REPO = "Msgaihede/mtg-grimoire";
/** release-please's branch for this repository's one package. */
export const RELEASE_BRANCH = "release-please--branches--main--components--mtg-grimoire";
export const MANIFEST = ".release-please-manifest.json";
/** Where a release's notes are kept. */
export const NOTES_DIR = "changelog";
/** Where `next` leaves its file for the job that commits it. Ignored by git. */
export const OUT_DIR = "release-notes";

const VERSION = /^\d+\.\d+\.\d+$/;

/** The released version a manifest's text names, or `null` when it is not three plain numbers. */
export function versionOf(manifestText: string) {
  let version: unknown;
  try {
    version = JSON.parse(manifestText)["."];
  } catch {
    return null;
  }
  return typeof version === "string" && VERSION.test(version) ? version : null;
}

/** `v0.43.0` or `0.43.0` as `0.43.0`; anything else is `null`. */
export function versionArg(name: string) {
  const version = String(name).replace(/^v/, "");
  return VERSION.test(version) ? version : null;
}

const numbers = (version: string) => version.replace(/^v/, "").split(".").map(Number);
const byVersion = (a: string, b: string) => {
  const [x, y] = [numbers(a), numbers(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The release tags in `git tag --list`'s output, oldest first. */
export function releaseTags(tagList: string) {
  return String(tagList)
    .split(/\s+/)
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort(byVersion);
}

/** The tag before `tag` in `tags`, or `null` for the first. */
export function previousTag(tags: string[], tag: string) {
  const at = tags.indexOf(tag);
  return at > 0 ? tags[at - 1] : null;
}

/** The commit range of a release: from the tag before it, or from the beginning. */
export function rangeOf(previous: string | null, tag: string) {
  return previous === null ? tag : `${previous}..${tag}`;
}

/** Whether `next` has a release to write for, and the sentence that says so. */
export function nextPlan({ released, coming }: { released: string | null; coming: string | null }) {
  if (released === null) {
    return { write: false, failed: true, why: `${MANIFEST} names no released version.` };
  }
  if (coming === null) {
    return {
      write: false,
      failed: false,
      why: "There is no release branch with a version on it, so there is no coming release to write notes for.",
    };
  }
  if (coming === released) {
    return {
      write: false,
      failed: false,
      why: `The release branch is still at ${released}, the version already released; there is nothing to write.`,
    };
  }
  return {
    write: true,
    failed: false,
    why: `Writing the notes for ${coming}, from v${released} to this commit.`,
  };
}

/** `argv` after the script's own name. */
export function parseArgs(argv: string[]) {
  const out = {
    command: argv[0] ?? "",
    names: [] as string[],
    force: false,
    all: false,
    backup: null as string | null,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") out.force = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--backup") out.backup = argv[++i] ?? null;
    else out.names.push(arg);
  }
  return out;
}

/**
 * `push`, for one release: set a **published** release's body from its file.
 *
 * - `hasNotes`: whether `changelog/<version>.md` exists;
 * - `latestTag`: the release GitHub marks "Latest" before anything is edited;
 * - `view(tag)`: `{ isDraft, body }`, or `null` when GitHub has no such release or could not be
 *   asked;
 * - `wasKept(tag)` and `keep(tag, body)`: the body being replaced is kept **once** — a second
 *   run must not replace the original with the notes the first run wrote;
 * - `edit(tag, isLatest)`: sets the body. **It is told whether this is the latest release, and
 *   says so either way**, so an edit to an old release cannot move the mark: `release.yml`'s
 *   deploy refusal reads `releases/latest`.
 *
 * Answers `{ tag, outcome, why }`; `outcome` is `"pushed"`, `"draft"` (left alone: one of them
 * must never be published) or `"refused"`. It does not throw: a failed edit is one refusal, and
 * the releases after it are still tried.
 */
export function pushOne({
  version,
  hasNotes,
  latestTag,
  view,
  wasKept,
  keep,
  edit,
}: PushOptions): PushResult {
  const tag = `v${version}`;
  const refused = (why: string): PushResult => ({ tag, outcome: "refused", why });
  if (!hasNotes) return refused(`${NOTES_DIR}/${version}.md does not exist`);
  const release = view(tag);
  if (release === null) return refused("GitHub has no such release, or gh could not ask");
  if (release.isDraft) return { tag, outcome: "draft", why: "a draft, left alone" };
  if (!wasKept(tag)) keep(tag, release.body ?? "");
  try {
    edit(tag, tag === latestTag);
  } catch (error) {
    const said = String(
      error instanceof Error
        ? "stderr" in error
          ? error.stderr || error.message
          : error.message
        : error,
    )
      .trim()
      .split(/\r?\n/)[0];
    return refused(`the edit failed: ${said}`);
  }
  return { tag, outcome: "pushed", why: `the release body is ${NOTES_DIR}/${version}.md` };
}

/**
 * `push`'s exit code and its closing line, from every release's result.
 *
 * With `--all` a draft among the files is expected and is no failure. **Any other release that
 * was not pushed is one**, `--all` or not: forty-five rewritten and one skipped must not read as
 * forty-six.
 */
export function pushVerdict(results: PushResult[], { all }: { all: boolean }) {
  const count = (outcome: PushResult["outcome"]) =>
    results.filter((result) => result.outcome === outcome).length;
  const [pushed, drafts, refused] = [count("pushed"), count("draft"), count("refused")];
  return {
    code: refused > 0 || (!all && drafts > 0) ? 1 : 0,
    tally: `${pushed} pushed, ${drafts} ${drafts === 1 ? "draft" : "drafts"} left alone, ${refused} refused`,
  };
}

const USAGE = [
  "node scripts/changelog/cli.ts next",
  "node scripts/changelog/cli.ts tag <version>… [--force]",
  "node scripts/changelog/cli.ts backfill [--force]",
  "node scripts/changelog/cli.ts push <version>… | --all [--backup <dir>]",
].join("\n");

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = parseArgs(process.argv.slice(2));
  const run = (program: string, list: string[]) =>
    execFileSync(program, list, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A release's whole log with every commit's body; the default megabyte is no promise.
      maxBuffer: 256 * 1024 * 1024,
    });
  const tryRun = (program: string, list: string[]) => {
    try {
      return run(program, list);
    } catch {
      return null;
    }
  };
  const git = (list: string[]) => run("git", list);
  const say = (line: string) => console.error(line);
  const summary = (text: string) => {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  const repo = process.env.GITHUB_REPOSITORY || REPO;

  /** One release's notes: its entries read, the model asked, the answer checked. */
  const write = async (version: string, range: string) => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set.");
    const token =
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      tryRun("gh", ["auth", "token"])?.trim() ||
      null;
    const entries = await collect({ range, git, pull: githubPulls({ repo, token, fetch }) });
    say(`${version}: ${entries.length} entries in ${range}`);
    const ask = async (messages: Message[]) => {
      const { text, usage } = await complete({
        key,
        messages,
        schema: SCHEMA,
        fetch,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      });
      if (usage)
        say(`${version}: ${usage.prompt_tokens} tokens in, ${usage.completion_tokens} out`);
      return text;
    };
    const result = await notesFor({ version, entries, ask });
    for (const line of omittedLines(result.answer)) say(`${version}: left out ${line}`);
    return result;
  };

  if (args.command === "next") {
    const released = versionOf(readFileSync(join(root, MANIFEST), "utf8"));
    const onBranch = tryRun("git", ["show", `origin/${RELEASE_BRANCH}:${MANIFEST}`]);
    const coming = onBranch === null ? null : versionOf(onBranch);
    const plan = nextPlan({ released, coming });
    say(plan.why);
    if (!plan.write) {
      summary(`### Release notes — not written\n\n${plan.why}`);
      return plan.failed ? 1 : 0;
    }
    if (tryRun("git", ["rev-parse", "-q", "--verify", `refs/tags/v${released}`]) === null) {
      throw new Error(
        `The tag v${released} is not in this checkout, so there is no range to read.`,
      );
    }
    const { markdown, answer } = await write(coming!, `v${released}..HEAD`);
    mkdirSync(join(root, OUT_DIR), { recursive: true });
    writeFileSync(join(root, OUT_DIR, `${coming}.md`), markdown);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${coming}\n`);
    summary(
      [
        `### Release notes for ${coming}`,
        "",
        markdown,
        "<details><summary>Left out</summary>",
        "",
        ...omittedLines(answer).map((line) => `- ${line}`),
        "",
        "</details>",
      ].join("\n"),
    );
    console.log(`${OUT_DIR}/${coming}.md`);
    return 0;
  }

  if (args.command === "tag" || args.command === "backfill") {
    const tags = releaseTags(git(["tag", "--list", "v*"]));
    const writeTag = async (tag: string) => {
      const version = tag.slice(1);
      const file = join(root, NOTES_DIR, `${version}.md`);
      if (existsSync(file) && !args.force) {
        say(`${version}: ${NOTES_DIR}/${version}.md exists; --force writes it again`);
        return;
      }
      const { markdown } = await write(version, rangeOf(previousTag(tags, tag), tag));
      mkdirSync(join(root, NOTES_DIR), { recursive: true });
      writeFileSync(file, markdown);
      console.log(`${NOTES_DIR}/${version}.md`);
    };

    if (args.command === "tag") {
      const picked = args.names.map(versionArg);
      if (picked.length === 0 || picked.includes(null)) {
        say(USAGE);
        return 2;
      }
      for (const version of picked) {
        if (!tags.includes(`v${version}`)) {
          say(`v${version} is not a release tag in this checkout.`);
          return 1;
        }
        await writeTag(`v${version}`);
      }
      return 0;
    }

    const failed = [];
    for (const tag of tags) {
      try {
        await writeTag(tag);
      } catch (error) {
        failed.push(tag);
        say(`${tag}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length) say(`No notes were written for: ${failed.join(", ")}`);
    return failed.length ? 1 : 0;
  }

  if (args.command === "push") {
    const versions = args.all
      ? readdirSync(join(root, NOTES_DIR))
          .map((name) => /^(\d+\.\d+\.\d+)\.md$/.exec(name)?.[1])
          .filter((version): version is string => version !== undefined)
          .sort(byVersion)
      : args.names.map(versionArg);
    if (versions.length === 0 || versions.some((version) => version === null)) {
      say(USAGE);
      return 2;
    }
    // Asked before anything is edited, and said back on every edit, so the mark cannot move.
    // Without an answer nothing is pushed: an edit that cannot say whether it is the latest
    // release is one whose effect on the mark is a guess.
    const latestTag =
      tryRun("gh", ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"])?.trim() || null;
    if (latestTag === null) {
      say("GitHub did not say which release is the latest one, so nothing was pushed.");
      return 1;
    }
    const backup = args.backup ?? join(tmpdir(), "mtg-grimoire-release-bodies");
    mkdirSync(backup, { recursive: true });
    say(`The latest release is ${latestTag}. The bodies being replaced are kept in ${backup}`);
    const notes = (version: string) => join(root, NOTES_DIR, `${version}.md`);
    const results = versions.map((version) => {
      if (version === null) throw new Error("Invalid release version");
      const result = pushOne({
        version,
        hasNotes: existsSync(notes(version)),
        latestTag,
        view: (tag) => {
          const seen = tryRun("gh", [
            "release",
            "view",
            tag,
            "--repo",
            repo,
            "--json",
            "isDraft,body",
          ]);
          return seen === null ? null : JSON.parse(seen);
        },
        wasKept: (tag) => existsSync(join(backup, `${tag}.md`)),
        keep: (tag, body) => writeFileSync(join(backup, `${tag}.md`), body),
        edit: (tag, isLatest) =>
          run("gh", [
            "release",
            "edit",
            tag,
            "--repo",
            repo,
            "--notes-file",
            notes(version),
            isLatest ? "--latest" : "--latest=false",
          ]),
      });
      (result.outcome === "pushed" ? console.log : say)(`${result.tag}: ${result.why}`);
      return result;
    });
    const verdict = pushVerdict(results, { all: args.all });
    say(verdict.tally);
    return verdict.code;
  }

  say(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
