import { describe, expect, it } from "vitest";
import {
  BODY_LIMIT,
  LOG_FORMAT,
  collect,
  cut,
  entriesOf,
  githubPulls,
  parseLog,
  prNumberOf,
} from "./collect.mjs";

const hash = (pair) => pair.repeat(20);
const commit = (pair, subject, parents = ["p0"], body = "") => ({
  hash: hash(pair),
  subject,
  parents: parents.map(hash),
  body,
});
const merged = (title, head = "claude/a-branch", body = "what it does") => ({
  title,
  body,
  merged: true,
  head,
});
/** A `pull` that answers from a table, and `null` — not a pull request — for anything else. */
const pulls = (table) => async (number) => table[number] ?? null;

describe("parseLog", () => {
  it("reads hash, parents, subject and a body of several lines", () => {
    const text = "h1\x1fp1 p2\x1fsubject one\x1fline a\nline b\n\x1e\nh2\x1f\x1froot commit\x1f\x1e\n";
    expect(parseLog(text)).toEqual([
      { hash: "h1", parents: ["p1", "p2"], subject: "subject one", body: "line a\nline b" },
      { hash: "h2", parents: [], subject: "root commit", body: "" },
    ]);
  });

  it("answers nothing for an empty range", () => {
    expect(parseLog("")).toEqual([]);
    expect(parseLog("\n")).toEqual([]);
  });
});

describe("prNumberOf", () => {
  it("reads the two forms GitHub writes", () => {
    expect(prNumberOf("Merge pull request #861 from Msgaihede/claude/web-scanner")).toBe(861);
    expect(prNumberOf("feat(android): build and sign an app bundle for Google Play (#857)")).toBe(857);
    expect(prNumberOf("fix: a thing (#12)  ")).toBe(12);
  });

  it("reads nothing else as one", () => {
    expect(prNumberOf("Merge branch 'main' of https://github.com/Msgaihede/mtg-grimoire")).toBeNull();
    expect(prNumberOf("fix #12 for good")).toBeNull();
    expect(prNumberOf("see (#12) for why")).toBeNull();
    expect(prNumberOf('Revert "feat: a thing (#12)"')).toBeNull();
    expect(prNumberOf("add release signer")).toBeNull();
  });
});

describe("cut", () => {
  it("leaves a short body alone, and trims it", () => {
    expect(cut("  what it does\r\nand why  ")).toBe("what it does\nand why");
    expect(cut(null)).toBe("");
  });

  it("cuts a long body at the limit and says so", () => {
    const body = cut("x".repeat(BODY_LIMIT + 1000));
    expect(body.startsWith("x".repeat(BODY_LIMIT))).toBe(true);
    expect(body).toContain(`cut at ${BODY_LIMIT} characters`);
    expect(body.length).toBeLessThan(BODY_LIMIT + 60);
  });
});

describe("entriesOf", () => {
  it("reads a merge, a squash and a direct commit, oldest first", async () => {
    const commits = [
      commit("c3", "Merge pull request #12 from o/claude/b", ["c2", "x1"]),
      commit("x1", "feat: inner work", ["c2"]),
      commit("c2", "fix(sync): a thing (#11)", ["c1"]),
      commit("c1", "add release signer", ["c0"], "why"),
    ];
    const entries = await entriesOf({
      commits,
      firstParent: [hash("c3"), hash("c2"), hash("c1")],
      pull: pulls({ 11: merged("fix(sync): a thing"), 12: merged("feat: b") }),
    });
    expect(entries).toEqual([
      { id: "c1c1c1c", title: "add release signer", body: "why" },
      { id: "#11", title: "fix(sync): a thing", body: "what it does" },
      { id: "#12", title: "feat: b", body: "what it does" },
    ]);
  });

  // Review Focus 2: `(#761)` closing a hand-written subject is an issue, and the commit is real.
  it("reads a number that is an issue as part of a direct commit", async () => {
    const entries = await entriesOf({
      commits: [commit("d1", "docs: the light app's plan (#761)", ["d0"], "the plan")],
      firstParent: [hash("d1")],
      pull: pulls({}),
    });
    expect(entries).toEqual([
      { id: "d1d1d1d", title: "docs: the light app's plan (#761)", body: "the plan" },
    ]);
  });

  // The first release's range reaches the repository's first commit, which has no parent.
  it("reads the first commit of all, which has no parent", async () => {
    const entries = await entriesOf({
      commits: [commit("f1", "Add design spec", [])],
      firstParent: [hash("f1")],
      pull: pulls({}),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["f1f1f1f"]);
  });

  it("reads an unmerged pull request's number the same way", async () => {
    const entries = await entriesOf({
      commits: [commit("d2", "wip (#20)", ["d1"])],
      firstParent: [hash("d2")],
      pull: pulls({ 20: { ...merged("wip"), merged: false } }),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["d2d2d2d"]);
  });

  it("skips a release PR, merged either way, and the commit inside it", async () => {
    const release = "release-please--branches--main--components--mtg-grimoire";
    const entries = await entriesOf({
      commits: [
        commit("r3", `Merge pull request #851 from Msgaihede/${release}`, ["r2", "r1"]),
        commit("r1", "chore(main): release 0.43.0", ["r0"]),
        commit("r2", "chore(main): release 0.5.0 (#12)", ["r0"]),
      ],
      firstParent: [hash("r3"), hash("r2")],
      pull: pulls({
        851: merged("chore(main): release 0.43.0", release),
        12: merged("chore(main): release 0.5.0", release),
      }),
    });
    expect(entries).toEqual([]);
  });

  it("reads a pull request merged into another's branch", async () => {
    const entries = await entriesOf({
      commits: [
        commit("m2", "Merge pull request #853 from o/claude/outer", ["m0", "m1"]),
        commit("m1", "Merge pull request #852 from o/claude/inner", ["a1", "a2"]),
      ],
      firstParent: [hash("m2")],
      pull: pulls({ 852: merged("feat: inner"), 853: merged("feat: outer") }),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["#852", "#853"]);
  });

  it("carries nothing for a merge that is not a pull request's, and keeps what was pushed beside it", async () => {
    const entries = await entriesOf({
      commits: [
        commit("l2", "Merge branch 'main' of https://github.com/o/r", ["l1", "z9"]),
        commit("l1", "add release signer", ["l0"]),
        commit("z9", "Merge pull request #30 from o/claude/c", ["z8", "z7"]),
      ],
      firstParent: [hash("l2"), hash("l1")],
      pull: pulls({ 30: merged("feat: c") }),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["#30", "l1l1l1l"]);
  });

  it("names a pull request once however many commits name it", async () => {
    const entries = await entriesOf({
      commits: [
        commit("s2", "Merge pull request #40 from o/claude/d", ["s0", "s1"]),
        commit("s1", "feat: d (#40)", ["s0"]),
      ],
      firstParent: [hash("s2")],
      pull: pulls({ 40: merged("feat: d") }),
    });
    expect(entries.map((entry) => entry.id)).toEqual(["#40"]);
  });

  it("reads no commit off the first-parent line that names no pull request", async () => {
    const entries = await entriesOf({
      commits: [commit("q1", "fix: inside a branch", ["q0"])],
      firstParent: [],
      pull: pulls({}),
    });
    expect(entries).toEqual([]);
  });

  it("cuts a long description", async () => {
    const [entry] = await entriesOf({
      commits: [commit("b1", "feat: big (#50)", ["b0"])],
      firstParent: [hash("b1")],
      pull: pulls({ 50: merged("feat: big", "claude/big", "y".repeat(BODY_LIMIT + 500)) }),
    });
    expect(entry.body).toContain(`cut at ${BODY_LIMIT} characters`);
  });
});

describe("collect", () => {
  it("asks git for the range twice: every commit, and the first-parent line", async () => {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      return args[0] === "log"
        ? `${"a".repeat(40)}\x1f${"b".repeat(40)}\x1fadd a thing\x1fwhy\n\x1e\n`
        : `${"a".repeat(40)}\n`;
    };
    const entries = await collect({ range: "v1.0.0..v1.1.0", git, pull: pulls({}) });
    expect(calls).toEqual([
      ["log", LOG_FORMAT, "v1.0.0..v1.1.0"],
      ["rev-list", "--first-parent", "v1.0.0..v1.1.0"],
    ]);
    expect(entries).toEqual([{ id: "aaaaaaa", title: "add a thing", body: "why" }]);
  });
});

describe("githubPulls", () => {
  const answer = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  it("asks for one pull request, with the token, and reads the four things it needs", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return answer(200, {
        title: "feat: a",
        body: null,
        merged_at: "2026-10-07T00:00:00Z",
        head: { ref: "claude/a" },
      });
    };
    const pull = githubPulls({ repo: "o/r", token: "t0ken", fetch });
    expect(await pull(7)).toEqual({ title: "feat: a", body: "", merged: true, head: "claude/a" });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/7");
    expect(calls[0].init.headers.authorization).toBe("Bearer t0ken");
  });

  it("answers null for a number that is not a pull request", async () => {
    const pull = githubPulls({ repo: "o/r", token: null, fetch: async () => answer(404, {}) });
    expect(await pull(761)).toBeNull();
  });

  it("sends no authorization without a token", async () => {
    let seen;
    const fetch = async (_url, init) => {
      seen = init.headers;
      return answer(404, {});
    };
    await githubPulls({ repo: "o/r", token: null, fetch })(1);
    expect(seen).not.toHaveProperty("authorization");
  });

  it("fails on any other answer rather than reading it as 'not a pull request'", async () => {
    const pull = githubPulls({ repo: "o/r", token: null, fetch: async () => answer(403, {}) });
    await expect(pull(7)).rejects.toThrow("GitHub answered 403 for pull request #7");
  });
});
