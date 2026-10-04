// May the web app be deployed from this tree, between releases? — the release rule's guard
// (light app phase 6, step 6.6).
//
//   npm run web:deploy-guard            # one sentence; exit 0 = yes, 1 = no, 2 = could not tell
//   node scripts/web-deploy-guard.mjs --json
//   node scripts/web-deploy-guard.mjs --offline    # do not ask GitHub; the answer says it did not
//
// **What it guards.** Sync stamps every op with the sender's `USER_SCHEMA_VERSION`
// (`sync_engine/wire.rs`, `stamp`), and a device on an older build *holds* an op stamped newer —
// "A device in your group runs a newer version of MTG Grimoire. Update this device…" — with no
// bound. A desktop and a phone update from a release. The web app updates from a deploy. So a
// web app deployed from a `main` that is one schema rung past the last release sends every paired
// desktop ops it must hold, and there is no update for it to install.
//
// **What it compares**: the constant in this working tree — which is what `npm run web:build`
// compiles and `wrangler deploy` uploads — against the same constant at the last release's tag,
// `v` + the version in `.release-please-manifest.json`, read with `git show <tag>:<path>`. Equal
// is the only pass. `release.yml`'s `web-deploy` job has no use for it: it deploys the tag.
//
// **And it asks whether that release is published.** release-please creates the tag with the
// *draft* (`force-tag-creation`), and `release.yml` publishes only when every host is through —
// so after a release run that failed, the tag exists, this tree equals it, and no desktop can
// install it: the release people are on is the one before, whose schema may be older. So the
// guard asks `gh release view <tag> --json isDraft`, and a draft is a refusal. If `gh` is not
// there or the question fails, that is *could not tell*, not a pass; `--offline` skips the
// question on purpose, and the answer says that it was skipped.
//
// ⚠️ **What it cannot see: equal schemas are necessary, not sufficient.** The stamp is the only
// thing on the wire that tells an older build "update to read this". A change to the wire that
// is not a schema rung — a new op `kind`, a field an older parser refuses — arrives on an older
// build as a batch that does not parse and says nothing newer about itself, which is
// `WireError::Malformed` (`wire.rs`): the client **steps over** it. Not held until an update —
// dropped. This guard reads one constant and passes such a tree. A change of that kind is a
// reason to wait for a release that no script here will give you.
//
// **Strict on purpose**: a constant it cannot find, on either side, is a failure with its own
// sentence and its own exit code, never a pass. A guard that answered "nothing to compare, go
// ahead" the day somebody reformatted the declaration would be no guard.
//
// Dependency-free, like the router beside it. The parse and the verdict are pure, so
// `web-deploy-guard.test.mjs` needs neither git nor `gh`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the constant lives, from the repository root — in this tree and at the tag. */
export const SCHEMA_PATH = "crates/grimoire-core/src/schema.rs";
/** release-please's record of the last version it released. */
export const MANIFEST_PATH = ".release-please-manifest.json";

/** The declaration, whole and alone on its line. A doc comment naming the constant is not one. */
const DECLARATION = /^pub const USER_SCHEMA_VERSION: i64 = (\d+);[ \t]*\r?$/gm;

/**
 * The user schema's version as `schema.rs` declares it, or `null` when the source does not hold
 * **exactly one** declaration of that shape — none, two, or one that is not a bare integer.
 */
export function userSchemaVersion(source) {
  const found = [...String(source).matchAll(DECLARATION)];
  if (found.length !== 1) return null;
  const version = Number(found[0][1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

/** The last release's tag, from the manifest's text: `v` + the root package's version. */
export function releaseTag(manifest) {
  let version;
  try {
    version = JSON.parse(manifest)["."];
  } catch {
    return null;
  }
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : null;
}

/**
 * What `gh release view <tag> --json isDraft` printed, as one of the three things it can mean:
 * `"published"`, `"draft"`, or `null` when the text is not that answer.
 */
export function publicationOf(ghJson) {
  let isDraft;
  try {
    isDraft = JSON.parse(ghJson).isDraft;
  } catch {
    return null;
  }
  if (isDraft === false) return "published";
  if (isDraft === true) return "draft";
  return null;
}

/**
 * The answer, and the one sentence that says it.
 *
 * - `tree` and `release` are what `userSchemaVersion` read on each side (`null`: not found);
 * - `tag` is what `releaseTag` read (`null`: no version);
 * - `headIsTag` is whether `HEAD` is the tagged commit;
 * - `unreadable` is git's own words when it could not show the file at the tag;
 * - `publication` is `"published"`, `"draft"`, `"offline"` (not asked, on purpose) or
 *   `"unknown"` (asked, and no answer — `unasked` says why). **It defaults to `"unknown"`**: a
 *   caller that forgot to ask has not been told yes.
 *
 * `code` is the exit code: 0 deploy, 1 do not, 2 nothing was decided.
 */
export function verdict({
  tree,
  release,
  tag,
  headIsTag = false,
  unreadable = null,
  publication = "unknown",
  unasked = "it was not asked",
}) {
  const cannot = (sentence) => ({ ok: false, code: 2, sentence });
  const shape = "exactly one `pub const USER_SCHEMA_VERSION: i64 = N;` is expected";
  if (tag === null) {
    return cannot(
      `${MANIFEST_PATH} names no released version, so there is no tag to compare this tree with.`,
    );
  }
  if (tree === null) {
    return cannot(
      `USER_SCHEMA_VERSION was not found in ${SCHEMA_PATH} in this tree (${shape}), so nothing was compared.`,
    );
  }
  if (unreadable !== null) {
    return cannot(
      `git could not read ${SCHEMA_PATH} at ${tag} (${unreadable}), so nothing was compared — is the tag fetched? \`git fetch --tags\`.`,
    );
  }
  if (release === null) {
    return cannot(
      `USER_SCHEMA_VERSION was not found in ${SCHEMA_PATH} at ${tag} (${shape}), so nothing was compared.`,
    );
  }
  if (tree !== release) {
    return {
      ok: false,
      code: 1,
      sentence: `This tree's user schema is ${tree}, the last release (${tag}) is ${release}: a web app deployed from here would send paired desktops ops they must hold until a release exists.`,
    };
  }
  if (publication === "draft") {
    return {
      ok: false,
      code: 1,
      sentence: `${tag} is still a draft: its tag exists and this tree's user schema (${tree}) equals it, but no desktop can install a draft, so the release people are on is an older one. Publish ${tag}, or finish its release run, before the web app is deployed.`,
    };
  }
  if (publication !== "published" && publication !== "offline") {
    return cannot(
      `The user schemas are equal (${tree}), but whether ${tag} is published could not be asked (${unasked}), and a draft's tag exists before anybody can install it. Nothing was decided — \`--offline\` skips the question, if you know the answer.`,
    );
  }
  const equal = headIsTag
    ? `HEAD is ${tag}, user schema ${tree}: this is the release, and the web app may be deployed from it.`
    : `This tree's user schema is ${tree}, and so is the last release's (${tag}): a web app deployed from here sends a paired desktop nothing it must hold.`;
  return {
    ok: true,
    code: 0,
    sentence:
      publication === "offline"
        ? `${equal} (--offline: whether ${tag} is published, and not a draft, was not asked.)`
        : equal,
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const run = (program, args) =>
    execFileSync(program, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // `schema.rs` is the longest source in the repository; the default megabyte is not a
      // promise about it.
      maxBuffer: 64 * 1024 * 1024,
    });
  const firstLine = (error) =>
    String(error.stderr || error.message || error)
      .trim()
      .split(/\r?\n/)[0] || "it failed";
  const read = (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return "";
    }
  };

  const tag = releaseTag(read(MANIFEST_PATH));
  const tree = userSchemaVersion(read(SCHEMA_PATH));
  let release = null;
  let unreadable = null;
  let headIsTag = false;
  if (tag !== null) {
    try {
      release = userSchemaVersion(run("git", ["show", `${tag}:${SCHEMA_PATH}`]));
      headIsTag =
        run("git", ["rev-parse", "HEAD"]).trim() ===
        run("git", ["rev-parse", `${tag}^{commit}`]).trim();
    } catch (error) {
      unreadable = firstLine(error);
    }
  }

  // Asked last and only when it can change the answer: GitHub is not needed to say "no".
  let publication = "unknown";
  let unasked = "it was not asked";
  if (process.argv.includes("--offline")) {
    publication = "offline";
  } else if (tag !== null && tree !== null && tree === release) {
    try {
      const answer = publicationOf(run("gh", ["release", "view", tag, "--json", "isDraft"]));
      if (answer === null) unasked = "`gh release view` did not answer with `isDraft`";
      else publication = answer;
    } catch (error) {
      unasked =
        error.code === "ENOENT"
          ? "`gh` is not installed"
          : `\`gh release view\`: ${firstLine(error)}`;
    }
  }

  const answer = verdict({ tree, release, tag, headIsTag, unreadable, publication, unasked });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...answer, tree, release, tag, headIsTag, publication }));
  } else if (answer.ok) {
    console.log(answer.sentence);
  } else {
    console.error(answer.sentence);
  }
  process.exitCode = answer.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
