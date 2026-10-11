// Which changes are in a release? — the entries its notes are written from
// (docs/superpowers/specs/2026-10-11-generated-release-notes-design.md, §5 "Collect").
//
// A release is a commit range, `<previous tag>..<tag>`, and an entry is one change in it: a pull
// request, read from GitHub by its number, or a commit pushed straight to `main`.
//
// **Pull request numbers come from commit subjects**, in the two forms GitHub writes:
// `Merge pull request #N from …` and a squash's trailing `(#N)`. Every commit in the range is
// read and not only the first-parent line, so a pull request merged into another's branch is an
// entry too. **A number is a pull request only once GitHub says so** — `(#761)` closing a
// hand-written subject is an issue — and a release PR is none of the release's own changes.
//
// **A direct commit is a first-parent commit that is neither**: not a merge, and not a subject
// naming a merged pull request. Known gap, accepted: a commit pushed straight to `main` that a
// later local merge put on the *second*-parent side is not on that line and is not read.
//
// Dependency-free, and `git` and GitHub are passed in, so `collect.test.mjs` needs neither.

/** A release PR's head branch starts with this; it is the release, not a change in it. */
export const RELEASE_BRANCH_PREFIX = "release-please--";

/** Where a description is cut. The average here is 3,086 characters and the longest 34,672. */
export const BODY_LIMIT = 6000;

/** `git log`'s format for {@link parseLog}: hash, parents, subject, body, one record a commit. */
export const LOG_FORMAT = "--format=%H%x1f%P%x1f%s%x1f%b%x1e";

/** What `git log` printed in {@link LOG_FORMAT}, newest first as git prints it. */
export function parseLog(text) {
  return String(text)
    .split("\x1e")
    .map((record) => record.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash = "", parents = "", subject = "", body = ""] = record.split("\x1f");
      return { hash, parents: parents.split(" ").filter(Boolean), subject, body: body.trim() };
    });
}

const MERGE = /^Merge pull request #(\d+) from /;
const SQUASH = /\(#(\d+)\)$/;

/** The number a commit subject names in one of GitHub's two forms, or `null`. */
export function prNumberOf(subject) {
  const found = MERGE.exec(subject) ?? SQUASH.exec(subject.trimEnd());
  return found ? Number(found[1]) : null;
}

/** A description, trimmed, and cut at `limit` with a line that says so. */
export function cut(text, limit = BODY_LIMIT) {
  const body = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  return body.length <= limit ? body : `${body.slice(0, limit)}\n[… cut at ${limit} characters]`;
}

/** `work` over `items`, at most `width` at a time. */
async function pooled(items, width, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(width, queue.length) }, async () => {
      while (queue.length) await work(queue.shift());
    }),
  );
}

/**
 * The entries of a range, oldest first.
 *
 * - `commits`: every commit in the range, newest first — {@link parseLog}'s answer;
 * - `firstParent`: the hashes on the first-parent line;
 * - `pull(number)`: `{ title, body, merged, head }`, or `null` for a number that is not a pull
 *   request.
 */
export async function entriesOf({ commits, firstParent, pull }) {
  const line = new Set(firstParent);
  const numbers = [
    ...new Set(commits.map((commit) => prNumberOf(commit.subject)).filter((n) => n !== null)),
  ];
  const answers = new Map();
  await pooled(numbers, 8, async (number) => {
    answers.set(number, await pull(number));
  });

  const entries = [];
  const seen = new Set();
  for (const commit of [...commits].reverse()) {
    const number = prNumberOf(commit.subject);
    const answer = number === null ? null : answers.get(number);
    if (answer && answer.merged) {
      if (seen.has(number) || answer.head.startsWith(RELEASE_BRANCH_PREFIX)) continue;
      seen.add(number);
      entries.push({ id: `#${number}`, title: answer.title, body: cut(answer.body) });
      continue;
    }
    // Not a pull request's commit by its subject. A merge carries nothing of its own, and a
    // commit off the first-parent line arrived inside something that is already an entry.
    // (`<= 1`, not `=== 1`: the repository's first commit has no parent and is a commit too.)
    if (commit.parents.length <= 1 && line.has(commit.hash)) {
      entries.push({ id: commit.hash.slice(0, 7), title: commit.subject, body: cut(commit.body) });
    }
  }
  return entries;
}

/** The entries of `range`, asked of `git(args)` and of GitHub through `pull`. */
export async function collect({ range, git, pull }) {
  const commits = parseLog(git(["log", LOG_FORMAT, range]));
  const firstParent = git(["rev-list", "--first-parent", range]).split(/\s+/).filter(Boolean);
  return entriesOf({ commits, firstParent, pull });
}

/** {@link entriesOf}'s `pull`, answered by GitHub's REST API for `repo` (`owner/name`). */
export function githubPulls({ repo, token, fetch }) {
  return async (number) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "mtg-grimoire-changelog",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    // An issue's number answers 404 here, which is the whole of how the two are told apart.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for pull request #${number}`);
    }
    const pr = await response.json();
    return {
      title: pr.title ?? "",
      body: pr.body ?? "",
      merged: pr.merged_at != null,
      head: pr.head?.ref ?? "",
    };
  };
}
