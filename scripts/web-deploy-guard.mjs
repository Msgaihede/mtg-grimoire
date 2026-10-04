// May the web app be deployed from this tree, between releases? — the release rule's guard
// (light app phase 6, step 6.6).
//
//   npm run web:deploy-guard            # one sentence; exit 0 = yes, 1 = no, 2 = could not tell
//   node scripts/web-deploy-guard.mjs --json
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
// **Strict on purpose**: a constant it cannot find, on either side, is a failure with its own
// sentence and its own exit code, never a pass. A guard that answered "nothing to compare, go
// ahead" the day somebody reformatted the declaration would be no guard.
//
// Dependency-free, like the router beside it. The parse and the verdict are pure, so
// `web-deploy-guard.test.mjs` needs no git.
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
 * The answer, and the one sentence that says it.
 *
 * `tree` and `release` are what `userSchemaVersion` read on each side (`null`: not found), `tag`
 * what `releaseTag` read (`null`: no version), `headIsTag` whether `HEAD` is the tagged commit,
 * and `unreadable` git's own words when it could not show the file at the tag.
 *
 * `code` is the exit code: 0 deploy, 1 do not, 2 nothing was compared.
 */
export function verdict({ tree, release, tag, headIsTag = false, unreadable = null }) {
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
  return {
    ok: true,
    code: 0,
    sentence: headIsTag
      ? `HEAD is ${tag}, user schema ${tree}: this is the release, and the web app may be deployed from it.`
      : `This tree's user schema is ${tree}, and so is the last release's (${tag}): a web app deployed from here sends a paired desktop nothing it must hold.`,
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // `schema.rs` is the longest source in the repository; the default megabyte is not a
      // promise about it.
      maxBuffer: 64 * 1024 * 1024,
    });
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
      release = userSchemaVersion(git("show", `${tag}:${SCHEMA_PATH}`));
      headIsTag = git("rev-parse", "HEAD").trim() === git("rev-parse", `${tag}^{commit}`).trim();
    } catch (error) {
      const said = String(error.stderr ?? error.message ?? error).trim();
      unreadable = said.split(/\r?\n/)[0] || "git failed";
    }
  }

  const answer = verdict({ tree, release, tag, headIsTag, unreadable });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...answer, tree, release, tag, headIsTag }));
  } else if (answer.ok) {
    console.log(answer.sentence);
  } else {
    console.error(answer.sentence);
  }
  process.exitCode = answer.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
