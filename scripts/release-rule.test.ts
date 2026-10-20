// **The release rule, held**: the three hosts ship from one tag (light app phase 6, step 6.6).
//
// One core means one user schema per commit, and sync stamps every op with the sender's. A device
// on an older build holds an op stamped newer until it updates — so a host that ships ahead of
// the others strands them. Three things keep them together, and each is a file a careless edit
// can quietly undo:
//
//   1. **one version in the tree** — release-please bumps every version-bearing file from one
//      commit, and only the files `release-please-config.json` names;
//   2. **an Android `versionCode` that rises with it** — or an update will not install;
//   3. **`release.yml`'s shape** — what `publish` waits for, which jobs hold a secret and what
//      those jobs may run, and that four jobs in one workflow deploy four Workers, each from
//      its own folder (`relay-deploy`, `share-deploy`, `scan-deploy`, `web-deploy`).
//
// Text, like the two fences beside it (`actions-pinned.test.ts`, `toolchain.test.ts`): nothing
// here runs a workflow. What a real release proves is docs/reference/ci-and-releases.md's to say.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import releaseConfig from "../release-please-config.json?raw";
import releaseManifest from "../.release-please-manifest.json?raw";
import packageJson from "../package.json?raw";
import workspaceToml from "../Cargo.toml?raw";
import cargoLock from "../Cargo.lock?raw";
import desktopToml from "../apps/desktop/src-tauri/Cargo.toml?raw";
import coreToml from "../crates/grimoire-core/Cargo.toml?raw";
import lightToml from "../apps/light/src-tauri/Cargo.toml?raw";
import webToml from "../crates/grimoire-web/Cargo.toml?raw";
import scanToml from "../crates/grimoire-scan/Cargo.toml?raw";
import playToml from "../crates/grimoire-play/Cargo.toml?raw";
import desktopConf from "../apps/desktop/src-tauri/tauri.conf.json?raw";
import lightConf from "../apps/light/src-tauri/tauri.conf.json?raw";
import appGradle from "../apps/light/src-tauri/gen/android/app/build.gradle.kts?raw";
import deployToolPackage from "../infrastructure/wrangler/package.json?raw";
import deployToolLock from "../infrastructure/wrangler/package-lock.json?raw";
import appWorkerPackage from "../infrastructure/app-worker/package.json?raw";
import workspaceYaml from "../pnpm-workspace.yaml?raw";
import releaseYml from "../.github/workflows/release.yml?raw";
import ciYml from "../.github/workflows/ci.yml?raw";
import syncSmoke from "./web-sync-smoke.ts?raw";
import smokeHarness from "./web-smoke/harness.ts?raw";
import syncHarness from "./web-smoke/sync-harness.ts?raw";
import syncPull from "./web-sync-pull.ts?raw";
import signProof from "./android-release/proof.sh?raw";
import checkVersionSh from "./android-release/check-version.sh?raw";

const WORKFLOWS = import.meta.glob<string>("/.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Which lockfiles the root holds, by name. Not read: pnpm's is a quarter of a megabyte. */
const ROOT_LOCKS = import.meta.glob<string>([
  "/package-lock.json",
  "/npm-shrinkwrap.json",
  "/yarn.lock",
  "/pnpm-lock.yaml",
]);

/** The cargo workspace's members: where each lives, its manifest, and whether it is a Tauri host. */
const CRATES = [
  { name: "mtg-grimoire", dir: "apps/desktop/src-tauri", toml: desktopToml, conf: desktopConf },
  { name: "grimoire-core", dir: "crates/grimoire-core", toml: coreToml, conf: null },
  { name: "grimoire-light", dir: "apps/light/src-tauri", toml: lightToml, conf: lightConf },
  { name: "grimoire-web", dir: "crates/grimoire-web", toml: webToml, conf: null },
  // The browser's scanner: a module of its own, shipped beside the web host's from the same tag.
  { name: "grimoire-scan", dir: "crates/grimoire-scan", toml: scanToml, conf: null },
  // The game board's rules engine (goldfish and playtest), linked by the desktop alone.
  { name: "grimoire-play", dir: "crates/grimoire-play", toml: playToml, conf: null },
];

/** A file with its `#` comment lines removed — these files explain themselves in prose. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** `[package]`'s `name` and `version`, from a manifest's text. */
function packageOf(toml: string) {
  const body = toml.slice(toml.indexOf("[package]")).split(/^\[/m)[1] ?? "";
  return {
    name: /^name = "([^"]+)"$/m.exec(body)?.[1],
    version: /^version = "([^"]+)"$/m.exec(body)?.[1],
  };
}

/** Every version the root `Cargo.lock` records for a package name. */
const lockedVersions = (name: string) =>
  [...cargoLock.matchAll(/^\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/gm)]
    .filter((m) => m[1] === name)
    .map((m) => m[2]);

describe("one version in the tree", () => {
  const version = JSON.parse(packageJson).version;
  const extra = JSON.parse(releaseConfig).packages["."]["extra-files"];
  const names = (file: Record<string, string>) =>
    extra.some((entry: Record<string, string>) =>
      Object.keys(file).every((k) => entry[k] === file[k]),
    );

  it("is a plain semantic version, and the one release-please last released", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // The deploy guard finds the last tag here (`scripts/web-deploy-guard.ts`).
    expect(JSON.parse(releaseManifest)).toEqual({ ".": version });
    // pnpm's lockfile records no version for the root package, so a release moves nothing in
    // it. npm's did, and release-please would go on bumping one left behind; a `yarn.lock` would
    // do worse, because `tauri-action` asks for yarn before pnpm (read at v1.0.0).
    expect(Object.keys(ROOT_LOCKS)).toEqual(["/pnpm-lock.yaml"]);
  });

  it("knows every member of the cargo workspace", () => {
    // A sixth member owes a row above, and with it a lockfile selector in the config (its
    // manifest inherits the workspace's version): one the config does not name is not bumped
    // in the lockfile, and ships a version behind the app.
    const members = /^members = \[([^\]]*)\]$/m.exec(workspaceToml)?.[1];
    expect(members).toBeDefined();
    expect(
      members!
        .split(",")
        .map((m) => m.trim().replace(/^"|"$/g, ""))
        .sort(),
    ).toEqual(CRATES.map((crate) => crate.dir).sort());
  });

  it("the workspace carries it", () => {
    const table =
      workspaceToml.slice(workspaceToml.indexOf("[workspace.package]")).split(/^\[/m)[1] ?? "";
    expect(/^version = "([^"]+)"$/m.exec(table)?.[1]).toBe(version);
  });

  it.each(CRATES)("$name inherits it, and the lockfile agrees", ({ name, toml }) => {
    const body = toml.slice(toml.indexOf("[package]")).split(/^\[/m)[1] ?? "";
    expect(/^name = "([^"]+)"$/m.exec(body)?.[1]).toBe(name);
    // A literal here is a second version, and release-please no longer writes this file.
    expect(body).toMatch(/^version\.workspace = true$/m);
    expect(body).not.toMatch(/^version = /m);
    expect(lockedVersions(name)).toEqual([version]);
  });

  it.each(CRATES.filter((crate) => crate.conf !== null))(
    "$name's tauri.conf.json wears it",
    ({ conf }) => {
      expect(JSON.parse(conf).version).toBe(version);
    },
  );

  it("release-please bumps the workspace's version, in one manifest", () => {
    expect(
      names({ type: "toml", path: "Cargo.toml", jsonpath: "$.workspace.package.version" }),
    ).toBe(true);
    expect(
      extra.filter((entry: Record<string, string>) => /(^|\/)Cargo\.toml$/.test(entry.path)),
    ).toHaveLength(1);
  });

  it.each(CRATES)("release-please bumps $name's lockfile entry", ({ name }) => {
    // `@.name.value`, never `@.name`: release-please parses TOML into tagged nodes, and the bare
    // form matches nothing — as a warning, not an error.
    expect(
      names({
        type: "toml",
        path: "Cargo.lock",
        jsonpath: `$.package[?(@.name.value=='${name}')].version`,
      }),
    ).toBe(true);
  });

  it.each(CRATES.filter((crate) => crate.conf !== null))(
    "release-please bumps $name's tauri.conf.json",
    ({ dir }) => {
      expect(names({ type: "json", path: `${dir}/tauri.conf.json`, jsonpath: "$.version" })).toBe(
        true,
      );
    },
  );

  it("names nothing else, so this file is the whole list", () => {
    const tauriHosts = CRATES.filter((crate) => crate.conf !== null).length;
    // The workspace's one manifest, each member's lockfile entry, each Tauri host's config.
    expect(extra).toHaveLength(1 + CRATES.length + tauriHosts);
  });
});

/**
 * Tauri's own arithmetic for an Android `versionCode`, when the config names none
 * (`bundle.android.versionCode`'s description in `@tauri-apps/cli`'s `config.schema.json`).
 * The CLI writes the result to the generated `tauri.properties`, which Gradle reads.
 */
const versionCode = (version: string) => {
  const [major, minor, patch] = version.split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
};

describe("the Android versionCode", () => {
  const light = JSON.parse(lightConf);
  const [major, minor, patch] = light.version.split(".").map(Number);

  it("is derived from the version release-please bumps, not typed or counted", () => {
    // An explicit code would stay put while the version moved, and Android refuses an update
    // whose code is not higher. `autoIncrementVersionCode` counts builds in a file that is not
    // committed here, so every runner would start again from one.
    expect(light.bundle.android?.versionCode).toBeUndefined();
    expect(light.bundle.android?.autoIncrementVersionCode).toBeUndefined();
    expect(appGradle).toContain(
      'versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()',
    );
  });

  it("is read back from where the light host's build writes it", () => {
    // `ci.yml` and `release.yml` call the check with the version alone, so its default path is
    // the one that runs. A folder that moved without it makes every Android build fail after the
    // bundle is made: the file is not there to read. The folder comes from the table above.
    const lightDir = CRATES.find((crate) => crate.name === "grimoire-light")!.dir;
    expect(checkVersionSh).toContain(`PROPS=\${2:-${lightDir}/gen/android/app/tauri.properties}`);
  });

  it("rises with every bump the version can take", () => {
    const now = versionCode(light.version);
    expect(now).toBeGreaterThan(0);
    for (const next of [
      `${major}.${minor}.${patch + 1}`,
      `${major}.${minor + 1}.0`,
      `${major + 1}.0.0`,
    ]) {
      expect(versionCode(next), next).toBeGreaterThan(now);
    }
    // 0.40.0, the last release before the APK shipped from a tag.
    expect(now).toBeGreaterThanOrEqual(versionCode("0.40.0"));
  });

  it("stays inside the range where the arithmetic keeps its order", () => {
    // Three digits each for the minor and the patch: at 1000 a patch bump would land on the
    // next minor's code. And Google Play's ceiling, which Tauri's schema repeats.
    expect(minor).toBeLessThan(1000);
    expect(patch).toBeLessThan(1000);
    expect(versionCode(light.version)).toBeLessThanOrEqual(2_100_000_000);
  });
});

/** `release.yml`'s jobs: each one's name and its text, from its key to the next job's. */
function jobsOf(src: string) {
  const body = src.slice(src.search(/^jobs:/m));
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):[ \t]*$/gm)];
  return Object.fromEntries(
    starts.map((m, i) => [m[1], code(body.slice(m.index, starts[i + 1]?.index ?? body.length))]),
  );
}

/** A job's steps, each from its `- ` to the next. */
const stepsOf = (job: string) =>
  job
    .slice(job.search(/^ {4}steps:/m))
    .split(/^ {6}- /m)
    .slice(1);

/** `needs:` as a list, whether written `needs: a` or `needs: [a, b]`. */
const needsOf = (job: string) =>
  (/^ {4}needs: \[?([^\]\n]*)\]?$/m.exec(job)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Every secret a piece of workflow text reads, `GITHUB_TOKEN` aside. */
const secretsOf = (text: string) =>
  [...new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))]
    .filter((name) => name !== "GITHUB_TOKEN")
    .sort();

/**
 * **Every appearance of the word `secrets`, in any case and any form** — and for each, the name
 * it reads when it is exactly `secrets.NAME`, or `null` when it is anything else:
 * `secrets.lower_case` (GitHub's names are case-insensitive, a list of allowed names is not),
 * `secrets['NAME']`, `toJSON(secrets)`, `secrets.*`, `secrets: inherit`. A fence that looked for
 * the one honest spelling would let every other one through.
 */
const secretRefs = (text: string) =>
  [...text.matchAll(/secrets/gi)].map((m) => {
    const exact = /^secrets\.([A-Z][A-Z0-9_]*)(?![\w.[*])/.exec(text.slice(m.index));
    const alone = !/[\w.]/.test(text[m.index - 1] ?? " ");
    return {
      seen: text.slice(Math.max(0, m.index - 10), m.index + 44).replace(/\s+/g, " "),
      name: exact && alone ? exact[1] : null,
    };
  });

/**
 * **Every line a job hands to its shell, by the `run:` that holds it**: `run: x`, each line of a
 * `run: |` or a `run: >-`, and a value continued on the lines below its key. What belongs to a
 * `run:` is what YAML says belongs to it — every line indented deeper than the key — so nothing
 * here asks what a line starts. Blank lines and `#` lines run nothing; every other line is kept,
 * `./tools/sign`, `perl -e`, `sudo` and `pipx` as much as `npx`.
 */
function runsOf(job: string) {
  const lines = job.split("\n");
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^( *(?:- +)?)(["']?)run\2 *:(?: +(.*))?$/.exec(lines[i]);
    if (!key) continue;
    const head = (key[3] ?? "").trim();
    const value = /^[|>][1-9+-]{0,2}(?: +#.*)?$/.test(head) ? [] : [head];
    for (; i + 1 < lines.length; i++) {
      const next = lines[i + 1];
      if (next.trim() !== "" && next.search(/\S/) <= key[1].length) break;
      value.push(next.trim());
    }
    runs.push(value.filter((line) => line !== "" && !line.startsWith("#")));
  }
  return runs;
}

/** Every `run:` key in a text, however it is written: the ones `runsOf` reads, and any it cannot. */
const RUN_KEYS = /\brun["']? *:/g;

/**
 * What can run a program, as a word on a line: package runners, interpreters, build tools,
 * downloaders, `gh`. Lines that only *name* one — an action, the shell, the Node pin — are not
 * commands. (No `tauri`: its CLI is only ever reached through `pnpm`, `npx` or `cargo`, and the
 * word is in every path under `apps/light/src-tauri/`.) **Not the list of what a job may run** —
 * a program it does not know is a line it does not see — but a net under `runsOf`: a line that
 * names one is a line some `run:` holds, wherever in the job it sits.
 */
const RUNS_SOMETHING =
  /\b(?:npx|npm|pnpm|yarn|bun|deno|node|cargo|rustc|gradle\w*|python\d*|pip\d*|curl|wget|bash|sh|pwsh|docker|gh|make|java|jarsigner|keytool)\b/;
const commandsOf = (job: string) =>
  job
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => RUNS_SOMETHING.test(line))
    .filter((line) => !/^(?:- )?(?:uses|shell|node-version-file|name):/.test(line));

const ANDROID_SECRETS = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_PASSWORD",
];
const CLOUDFLARE_SECRETS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
/** What the three jobs that deploy the relay, the share Worker and the scan inbox read: a token of their own. */
const INFRA_SECRETS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_INFRA_API_TOKEN"];
/** The four jobs that start wrangler, with the Worker's folder each one deploys from. */
const DEPLOYS: Record<string, string> = {
  "relay-deploy": "infrastructure/relay",
  "share-deploy": "infrastructure/share-worker",
  "scan-deploy": "infrastructure/scan-worker",
  "web-deploy": "infrastructure/app-worker",
};
/**
 * How many times each of them runs wrangler: a database's migrations and then the deploy, or —
 * for the two Workers with no database — the deploy alone.
 */
const WRANGLER_RUNS: Record<string, number> = {
  "relay-deploy": 2,
  "share-deploy": 2,
  "scan-deploy": 1,
  "web-deploy": 1,
};
const WRANGLER = "node ../wrangler/node_modules/wrangler/bin/wrangler.js";
/** Every secret each job may read, and it must read exactly these. */
const MAY_READ: Record<string, string[]> = {
  "release-please": ["GITHUB_TOKEN"],
  build: ["GITHUB_TOKEN"],
  android: [],
  "android-sign": [...ANDROID_SECRETS],
  web: [],
  share: [],
  "relay-deploy": [...INFRA_SECRETS, "GITHUB_TOKEN"],
  "share-deploy": [...INFRA_SECRETS, "GITHUB_TOKEN"],
  "scan-deploy": [...INFRA_SECRETS, "GITHUB_TOKEN"],
  "web-deploy": [...CLOUDFLARE_SECRETS, "GITHUB_TOKEN"],
  "play-upload": ["PLAY_SERVICE_ACCOUNT_JSON"],
  publish: ["GITHUB_TOKEN"],
  announce: ["DISCORD_WEBHOOK_URL", "GITHUB_TOKEN"],
  "changelog-write": ["GITHUB_TOKEN", "OPENROUTER_API_KEY"],
  "changelog-commit": ["GITHUB_TOKEN"],
};
const ON_A_RELEASE = "    if: needs.release-please.outputs.release_created == 'true'";
/**
 * The two jobs that write the coming release's notes run on the *other* answer, to the letter:
 * a push that cut no release, which is when the release PR is open to carry the file.
 */
const BETWEEN_RELEASES = "    if: needs.release-please.outputs.release_created != 'true'";
const CHANGELOG_JOBS = ["changelog-write", "changelog-commit"];
/** The committed fingerprint of the upload certificate every release's bundle is signed with. */
const SIGNER_PIN = "apps/light/src-tauri/release-signer.sha256";
/** The first step of a job that deploys with the infra token: the token alone decides. */
const infraAsk = (heading: string, still: string, nothing: string, runbook: string) => [
  "set -euo pipefail",
  'if [ "$HAS_TOKEN" != true ]; then',
  'echo "present=false" >> "$GITHUB_OUTPUT"',
  "{",
  `echo "### ${heading} — not deployed"`,
  "echo",
  `echo "**${still}** The \\\`release\\\` environment holds no"`,
  `echo "\\\`CLOUDFLARE_INFRA_API_TOKEN\\\`, so this release ${nothing}"`,
  `echo "Deploy $TAG by hand — \\\`${runbook}\\\`."`,
  "echo",
  'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the commands."',
  '} >> "$GITHUB_STEP_SUMMARY"',
  "exit 0",
  "fi",
  'if [ "$HAS_ACCOUNT" != true ]; then',
  'echo "CLOUDFLARE_INFRA_API_TOKEN is set in the release environment and CLOUDFLARE_ACCOUNT_ID is not." >&2',
  "echo \"Set both — docs/reference/ci-and-releases.md, 'What only the owner can do'.\" >&2",
  "exit 1",
  "fi",
  'echo "present=true" >> "$GITHUB_OUTPUT"',
];
/** The step that refuses a tag older than the newest published release, by what it would deploy. */
const refuseOlder = (what: string) => [
  "set -euo pipefail",
  'latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name)',
  'newest=$(printf \'%s\\n%s\\n\' "$latest" "$TAG" | sort -V | tail -1)',
  'echo "this run\'s tag: $TAG; the newest published release: $latest"',
  'if [ "$newest" != "$TAG" ]; then',
  `echo "$latest is published and is newer than $TAG: deploying $TAG's ${what} would put older code behind it. Nothing was deployed." >&2`,
  "exit 1",
  "fi",
];
/**
 * **Every line the eight jobs that hold a secret run** (`android-sign`, `relay-deploy`,
 * `share-deploy`, `scan-deploy`, `web-deploy`, `play-upload` and `announce` on a release; `changelog-write` between releases), step by
 * step, as `runsOf` reads them: the whole of each `run:`, its summary's wording too. A line
 * changed in one of those steps is changed here in the same commit, and a line added to any of
 * them, whatever it starts, is a line this list does not have.
 */
const RUNS: Record<string, string[][]> = {
  "android-sign": [
    // Is there a key to sign with, and a fingerprint to hold it to
    [
      "set -euo pipefail",
      'missing=""',
      "found=0",
      'has() { if [ "$2" = true ]; then found=$((found + 1)); else missing="$missing $1"; fi; }',
      'has ANDROID_KEYSTORE_BASE64 "$HAS_KEYSTORE"',
      'has ANDROID_KEYSTORE_PASSWORD "$HAS_KEYSTORE_PASSWORD"',
      'has ANDROID_KEY_PASSWORD "$HAS_KEY_PASSWORD"',
      'if [ -n "$missing" ] && [ "$found" -gt 0 ]; then',
      'echo "Some of the upload key\'s values are set in the release environment and these are not:$missing" >&2',
      "echo \"Set all three or none — docs/reference/ci-and-releases.md, 'What only the owner can do'.\" >&2",
      "exit 1",
      "fi",
      'if [ -z "$missing" ] && [ -f "$PIN" ]; then',
      'echo "present=true" >> "$GITHUB_OUTPUT"',
      "exit 0",
      "fi",
      'echo "present=false" >> "$GITHUB_OUTPUT"',
      "{",
      'echo "### Android bundle — not signed"',
      "echo",
      'if [ -n "$missing" ]; then',
      'echo "This release has **no bundle to upload to Google Play**. The \\`release\\` environment"',
      'echo "holds no upload key (\\`ANDROID_KEYSTORE_BASE64\\`, \\`ANDROID_KEYSTORE_PASSWORD\\`,"',
      'echo "\\`ANDROID_KEY_PASSWORD\\`), and Play takes no bundle signed with a runner\'s debug key."',
      "else",
      'echo "⚠️ This release has **no bundle to upload to Google Play, although the upload key is"',
      'echo "set**: this tag holds no \\`$PIN\\`. Without the certificate\'s fingerprint in the tree"',
      'echo "nothing says the key in the settings is the one Play Console knows. Commit the"',
      'echo "fingerprint; the next release signs a bundle."',
      "fi",
      'echo "The bundle was built at this tag, so the tag is known to build one."',
      "echo",
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the commands."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
    // Sign the bundle with the upload key
    [
      "set -euo pipefail",
      ': "${JAVA_HOME_21_X64:?the runner image did not set JAVA_HOME_21_X64}"',
      'export JAVA_HOME="$JAVA_HOME_21_X64"',
      'export ANDROID_KEYSTORE="$RUNNER_TEMP/release.keystore"',
      "trap 'rm -f \"$ANDROID_KEYSTORE\"' EXIT",
      "umask 077",
      'printf \'%s\' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$ANDROID_KEYSTORE"',
      "unset ANDROID_KEYSTORE_BASE64",
      'aab="mtg-grimoire-$VERSION-android.aab"',
      'bash scripts/android-release/sign-bundle.sh aab-in/mtg-grimoire-light-arm64.aab "$aab"',
      'echo "SIGNED_AAB=$aab" >> "$GITHUB_ENV"',
      'IFS=. read -r major minor patch <<< "$VERSION"',
      "{",
      "echo",
      'echo "**Signed \\`$aab\\`** — this run\'s artifact \\`play-upload-bundle\\`, versionCode $((major * 1000000 + minor * 1000 + patch))."',
      'echo "The job *android (upload to Play)* puts it on Play\'s internal track once the deploys are through."',
      'echo "If that job did not run, or says it uploaded nothing, upload it by hand:"',
      'echo "Play Console → *Test and release* → the track → *Create new release*."',
      "echo",
      'echo "Until it is on a track and Play has reviewed it, phones stay on the previous version:"',
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
  ],
  "relay-deploy": [
    // Is there a token to deploy with
    infraAsk(
      "Relay",
      "The relay still runs the previous deploy.",
      "applied no migration and deployed nothing to it.",
      "docs/reference/hosted-relay-deploy.md",
    ),
    // Refuse to deploy an older release over a newer one
    refuseOlder("relay"),
    // Install the lockfile's packages, running no script
    ["npm ci --ignore-scripts"],
    // Apply the database's pending migrations
    [`${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`],
    // Deploy the Worker
    [`${WRANGLER} deploy`],
    // Ask the host
    ["node scripts/relay-deploy-probe.ts"],
  ],
  "share-deploy": [
    // Is there a token to deploy with
    infraAsk(
      "Share Worker",
      "The share Worker still runs the previous deploy.",
      "applied no migration and deployed nothing to it.",
      "infrastructure/share-worker/README.md",
    ),
    // Refuse to deploy an older release over a newer one
    refuseOlder("share Worker"),
    // Check the bundle arrived whole
    [
      "set -euo pipefail",
      '[ -s apps/share/dist-share/assets/share.js ] || { echo "apps/share/dist-share/assets/share.js is missing or empty" >&2; exit 1; }',
    ],
    // Install the lockfile's packages, running no script
    ["npm ci --ignore-scripts"],
    // Apply the database's pending migrations
    [`${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`],
    // Deploy the Worker
    [`${WRANGLER} deploy`],
    // Ask the host
    ["node scripts/share-deploy-probe.ts apps/share/dist-share"],
  ],
  "scan-deploy": [
    // Is there a token to deploy with
    infraAsk(
      "Scan inbox",
      "The scan inbox still runs the previous deploy, if it has had one.",
      "deployed nothing to it.",
      "infrastructure/scan-worker/README.md",
    ),
    // Refuse to deploy an older release over a newer one
    refuseOlder("scan inbox"),
    // Install the lockfile's packages, running no script
    ["npm ci --ignore-scripts"],
    // Deploy the Worker: no database, so no migration before it
    [`${WRANGLER} deploy`],
    // Ask the host
    ["node scripts/scan-deploy-probe.ts"],
  ],
  "web-deploy": [
    // Is there a token to deploy with
    [
      "set -euo pipefail",
      'missing=""',
      "found=0",
      'has() { if [ "$2" = true ]; then found=$((found + 1)); else missing="$missing $1"; fi; }',
      'has CLOUDFLARE_API_TOKEN "$HAS_TOKEN"',
      'has CLOUDFLARE_ACCOUNT_ID "$HAS_ACCOUNT"',
      'if [ -z "$missing" ]; then',
      'if [ "$RELAY_DEPLOYED" != true ] || [ "$SHARE_DEPLOYED" != true ] || [ "$SCAN_DEPLOYED" != true ]; then',
      'echo "The web app\'s token is set and the other three Workers were not all deployed (relay: $RELAY_DEPLOYED, share: $SHARE_DEPLOYED, scan: $SCAN_DEPLOYED)." >&2',
      'echo "A page ahead of the relay asks it without its half, so nothing was deployed and the release stays a draft." >&2',
      "echo \"Set CLOUDFLARE_INFRA_API_TOKEN, or deploy $TAG by hand — docs/reference/ci-and-releases.md, 'What only the owner can do'.\" >&2",
      "exit 1",
      "fi",
      'echo "present=true" >> "$GITHUB_OUTPUT"',
      "exit 0",
      "fi",
      'if [ "$found" -gt 0 ]; then',
      'echo "One of the deploy\'s two values is set in the release environment and this one is not:$missing" >&2',
      "echo \"Set both or neither — docs/reference/ci-and-releases.md, 'What only the owner can do'.\" >&2",
      "exit 1",
      "fi",
      'echo "present=false" >> "$GITHUB_OUTPUT"',
      "{",
      'echo "### Web app — not deployed"',
      "echo",
      'echo "**https://mtg-grimoire.app still serves the previous deploy.** The \\`release\\`"',
      'echo "environment holds no \\`CLOUDFLARE_API_TOKEN\\` and \\`CLOUDFLARE_ACCOUNT_ID\\`, so this"',
      'echo "release deployed nothing. The web app was built at $TAG and opened in a browser,"',
      'echo "so the tag is known to build one."',
      "echo",
      'echo "If this release moved the user schema, a browser paired with a desktop that"',
      'echo "updates to it holds that desktop\'s changes until the web app is deployed from"',
      'echo "$TAG by hand — \\`infrastructure/app-worker/README.md\\`, *The steps, in order*."',
      "echo",
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the commands."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
    // Refuse to deploy an older release over a newer one
    [
      "set -euo pipefail",
      'latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name)',
      'newest=$(printf \'%s\\n%s\\n\' "$latest" "$TAG" | sort -V | tail -1)',
      'echo "this run\'s tag: $TAG; the newest published release: $latest"',
      'if [ "$newest" != "$TAG" ]; then',
      'echo "$latest is published and is newer than $TAG: deploying $TAG\'s bundle would put an older web app in front of it. Nothing was deployed." >&2',
      "exit 1",
      "fi",
    ],
    // Check the bundle arrived whole
    [
      "set -euo pipefail",
      "for file in index.html _headers sw.js; do",
      '[ -s "apps/light/dist-web/$file" ] || { echo "apps/light/dist-web/$file is missing or empty" >&2; exit 1; }',
      "done",
    ],
    // Install the lockfile's packages, running no script
    ["npm ci --ignore-scripts"],
    // Deploy the Worker
    ["node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy"],
    // Ask the host
    ["node scripts/web-deploy-probe.ts apps/light/dist-web"],
  ],
  "play-upload": [
    // Is there an account to upload with, and a bundle to upload
    [
      "set -euo pipefail",
      'if [ "$HAS_ACCOUNT" = true ] && [ "$SIGNED" = true ]; then',
      'echo "present=true" >> "$GITHUB_OUTPUT"',
      "exit 0",
      "fi",
      'echo "present=false" >> "$GITHUB_OUTPUT"',
      "{",
      'echo "### Google Play — nothing uploaded"',
      "echo",
      'if [ "$SIGNED" != true ]; then',
      'echo "This release signed no bundle (the summary of \\`android (sign for Play)\\` says why), so there is nothing to upload."',
      "else",
      'echo "The \\`release\\` environment holds no \\`PLAY_SERVICE_ACCOUNT_JSON\\`, so the signed bundle was not uploaded."',
      'echo "It is this run\'s artifact \\`play-upload-bundle\\`: upload it by hand in Play Console."',
      "fi",
      "echo",
      'echo "Phones stay on the previous version until a bundle is on a track."',
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the steps."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
    // Upload the bundle to the internal track
    [
      "set -euo pipefail",
      'IFS=. read -r major minor patch <<< "$VERSION"',
      'node scripts/android-release/play-upload.ts "aab-in/mtg-grimoire-$VERSION-android.aab" "$((major * 1000000 + minor * 1000 + patch))"',
    ],
  ],
  announce: [
    // Is there a webhook to post to
    [
      "set -euo pipefail",
      'if [ "$HAS_HOOK" = true ]; then',
      'echo "present=true" >> "$GITHUB_OUTPUT"',
      "exit 0",
      "fi",
      'echo "present=false" >> "$GITHUB_OUTPUT"',
      "{",
      'echo "### Discord — not announced"',
      "echo",
      'echo "The \\`discord\\` environment holds no \\`DISCORD_WEBHOOK_URL\\`, so this release was not announced."',
      "echo",
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the commands."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
    // Read the published notes
    [
      "set -euo pipefail",
      'gh release view "$TAG" --repo "$REPO" --json body --jq .body > notes.md',
    ],
    // Post the release to Discord
    ["node scripts/changelog/discord.ts notes.md"],
  ],
  "changelog-write": [
    // Is there a key to write with
    [
      "set -euo pipefail",
      'if [ "$HAS_KEY" = true ]; then',
      'echo "present=true" >> "$GITHUB_OUTPUT"',
      "exit 0",
      "fi",
      'echo "present=false" >> "$GITHUB_OUTPUT"',
      "{",
      'echo "### Release notes — not written"',
      "echo",
      'echo "The \\`changelog\\` environment holds no \\`OPENROUTER_API_KEY\\`, so no notes were written for the"',
      'echo "coming release. A release merged without its \\`changelog/<version>.md\\` is published with"',
      'echo "the notes release-please wrote."',
      "echo",
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the commands."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
    // Write the notes for the coming release
    ["node scripts/changelog/cli.ts next"],
  ],
};

describe("release.yml", () => {
  const jobs = jobsOf(releaseYml);

  it("has the fifteen jobs, chained as the rule needs", () => {
    expect(Object.keys(jobs)).toEqual([
      "release-please",
      "build",
      "android",
      "android-sign",
      "web",
      "share",
      "relay-deploy",
      "share-deploy",
      "scan-deploy",
      "web-deploy",
      "play-upload",
      "publish",
      "announce",
      "changelog-write",
      "changelog-commit",
    ]);
    expect(needsOf(jobs.build)).toEqual(["release-please"]);
    expect(needsOf(jobs.android)).toEqual(["release-please"]);
    expect(needsOf(jobs["android-sign"])).toEqual(["release-please", "android"]);
    expect(needsOf(jobs.web)).toEqual(["release-please"]);
    expect(needsOf(jobs.share)).toEqual(["release-please"]);
    // A deploy is live the moment it returns, so the first of them goes after everything that
    // can still fail to build…
    expect(needsOf(jobs["relay-deploy"])).toEqual([
      "release-please",
      "build",
      "android-sign",
      "web",
      "share",
    ]);
    // …and they go one behind the other: the relay, whose tokens the share Worker verifies and
    // whose CORS answer the web app's page waits on; the share Worker; the scan inbox, whose
    // host the page's policy names and whose CORS answer its Send waits on; then the page.
    expect(needsOf(jobs["share-deploy"])).toEqual(["release-please", "share", "relay-deploy"]);
    expect(needsOf(jobs["scan-deploy"])).toEqual(["release-please", "share-deploy"]);
    expect(needsOf(jobs["web-deploy"])).toEqual([
      "release-please",
      "build",
      "android-sign",
      "web",
      "relay-deploy",
      "share-deploy",
      "scan-deploy",
    ]);
    // The one step of a release that cannot be taken back — Play takes a versionCode once —
    // so it goes after every deploy, when only the flip of the draft is left.
    expect(needsOf(jobs["play-upload"])).toEqual(["release-please", "android-sign", "web-deploy"]);
    expect(needsOf(jobs.publish)).toEqual([
      "release-please",
      "build",
      "android-sign",
      "relay-deploy",
      "share-deploy",
      "scan-deploy",
      "web-deploy",
      "play-upload",
    ]);
    // The announcement, once the release is out — and nothing waits for it.
    expect(needsOf(jobs.announce)).toEqual(["release-please", "publish"]);
    for (const [name, job] of Object.entries(jobs)) {
      expect(needsOf(job), name).not.toContain("announce");
    }
  });

  // The notes are written between releases, by two jobs nothing waits for: a failure there turns
  // that run red and holds no release up.
  it("writes the notes in two jobs that nothing else needs", () => {
    expect(needsOf(jobs["changelog-write"])).toEqual(["release-please"]);
    expect(needsOf(jobs["changelog-commit"])).toEqual(["release-please", "changelog-write"]);
    for (const [name, job] of Object.entries(jobs)) {
      if (CHANGELOG_JOBS.includes(name)) continue;
      expect(
        needsOf(job).filter((need) => CHANGELOG_JOBS.includes(need)),
        name,
      ).toEqual([]);
    }
  });

  it("builds the desktop through the root's `tauri` script", () => {
    // `tauri-action` runs `pnpm tauri build` from the repository root: it finds `pnpm-lock.yaml`
    // and, in this manifest, `@tauri-apps/cli` (read at v1.0.0, `src/runner.ts`). So a release
    // depends on this script's text — it is what takes the build into the desktop host's folder —
    // and on the CLI being declared here: without it the action installs a global one with npm.
    // The light host's script is pinned in `apps/light/host.test.ts`.
    expect(JSON.parse(packageJson).scripts.tauri).toBe("cd apps/desktop && tauri");
    expect(JSON.parse(packageJson).devDependencies["@tauri-apps/cli"]).toBeDefined();
  });

  it("runs every job after release-please on a release, and on nothing looser", () => {
    // No `always()`, `failure()` or `!cancelled()`: without a status function a job runs only
    // when every job it needs succeeded, which is the whole of "publish waits for all three".
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "release-please") continue;
      const conditions = job.split("\n").filter((line) => /^ {4}if:/.test(line));
      expect(conditions, name).toEqual([
        CHANGELOG_JOBS.includes(name) ? BETWEEN_RELEASES : ON_A_RELEASE,
      ]);
    }
    expect(code(releaseYml)).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/);
  });

  // **A release ships the commit it is tagged at** (#1197). The `release` group is shared by every
  // push to `main`, so the run that creates a release can be a later push's — on a newer commit
  // than the release PR's merge, which is what release-please tags. Every checkout on a release
  // names the tagged commit, and release-please refuses to go on without one: an empty `ref`
  // checks out `github.sha` without a word.
  it("builds, signs and deploys the commit release-please tagged, not the run's", () => {
    const TAGGED = "          ref: ${{ needs.release-please.outputs.sha }}";
    expect(jobs["release-please"]).toMatch(/^ {6}sha: \$\{\{ steps\.release\.outputs\.sha \}\}$/m);
    const [, guard] = stepsOf(jobs["release-please"]);
    expect(guard).toMatch(/^ {8}if: steps\.release\.outputs\.release_created == 'true'$/m);
    expect(guard).toContain('if [ -z "$SHA" ]; then');
    expect(guard).toContain("exit 1");
    let checkouts = 0;
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "release-please" || CHANGELOG_JOBS.includes(name)) continue;
      expect(job, name).not.toContain("github.sha");
      for (const step of stepsOf(job).filter((s) => /^uses: actions\/checkout@/.test(s))) {
        expect(step.split("\n"), name).toContain(TAGGED);
        checkouts++;
      }
    }
    expect(checkouts).toBeGreaterThanOrEqual(11);
  });

  // **A release is a push to `main` and nothing else.** A `workflow_dispatch` or a
  // `pull_request` trigger would let a branch's copy of this file run — and ask for the release
  // environment — with only that environment's branch rule in the way.
  it("is triggered by a push to main, and by nothing else", () => {
    const top = code(releaseYml).slice(0, code(releaseYml).search(/^jobs:/m));
    const on = /^on:\n(?: .*\n|\n)*/m.exec(top)?.[0].trimEnd();
    expect(on).toBe("on:\n  push:\n    branches: [main]");
    expect(top).not.toMatch(/^env:/m);
    expect(secretRefs(top)).toEqual([]);
  });

  it("gives each secret to the jobs that hold it (`android-sign`, `relay-deploy`, `share-deploy`, `scan-deploy`, `web-deploy`, `play-upload`), alone", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const refs = secretRefs(job);
      // Every appearance of the word is the one honest spelling…
      expect(
        refs.filter((ref) => ref.name === null),
        name,
      ).toEqual([]);
      // …and reads a secret this job may read; and the job reads all of those and no other.
      expect([...new Set(refs.map((ref) => ref.name))].sort(), name).toEqual(
        [...MAY_READ[name]].sort(),
      );
    }
    expect(Object.keys(MAY_READ)).toEqual(Object.keys(jobs));
  });

  // A job-level `env:` would hand its values to every step of the job — the checkout, the
  // artifact download, the install — which is the hole the per-step rule below exists to close.
  it.each(Object.keys(MAY_READ))("%s names no secret and no env above its steps", (name) => {
    const head = jobs[name].slice(0, jobs[name].search(/^ {4}steps:/m));
    expect(head.length).toBeGreaterThan(0);
    expect(secretRefs(head)).toEqual([]);
    expect(head).not.toMatch(/^ {4}env:/m);
  });

  // **An environment's values, not the repository's.** A repository secret is handed to any
  // workflow on any branch of this repository; an environment's only to a job that names it,
  // from a branch the environment allows.
  it("takes what it holds from an environment, in those eight jobs and no other", () => {
    const environments = Object.entries(jobs)
      .map(([name, job]) => [name, job.split("\n").filter((line) => /^\s*environment:/.test(line))])
      .filter(([, lines]) => lines.length > 0);
    expect(environments).toEqual([
      ["android-sign", ["    environment: release"]],
      ["relay-deploy", ["    environment: release"]],
      ["share-deploy", ["    environment: release"]],
      ["scan-deploy", ["    environment: release"]],
      ["web-deploy", ["    environment: release"]],
      ["play-upload", ["    environment: release"]],
      // The webhook, apart from the release's keys and tokens: a credential to post in a channel.
      ["announce", ["    environment: discord"]],
      // An environment of its own: it runs on every push to `main` and sends pull request text
      // to another service, and the signing key and the deploy token are not within its reach.
      ["changelog-write", ["    environment: changelog"]],
    ]);
  });

  it.each([
    "release-please",
    "build",
    "android",
    "android-sign",
    "web",
    "share",
    "relay-deploy",
    "share-deploy",
    "scan-deploy",
    "web-deploy",
    "play-upload",
    "announce",
    "changelog-write",
    "changelog-commit",
    "publish",
  ])("%s has a deadline", (name) => {
    expect(jobs[name]).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  // The rule the removed `sign` job left behind: a secret never sits in a build leg, because a
  // build leg runs every build tool and plugin, cargo build script, Gradle plugin and whatever
  // install script pnpm is told to allow, and any of them can read a file or an environment.
  // **Held as a list of everything the job may run**, to the letter: every line of every `run:`
  // (`RUNS`), so a second `npx`, a `node -e`, an `npm run`, a `curl | sh` — and a `./tools/sign`,
  // a `perl -e`, a `sudo`, which no list of programs names — is a line that is not on it.
  it.each([
    ["android-sign", ["actions/checkout", "actions/download-artifact", "actions/upload-artifact"]],
    ["relay-deploy", ["actions/checkout", "actions/setup-node"]],
    ["share-deploy", ["actions/checkout", "actions/download-artifact", "actions/setup-node"]],
    ["scan-deploy", ["actions/checkout", "actions/setup-node"]],
    ["web-deploy", ["actions/checkout", "actions/download-artifact", "actions/setup-node"]],
    ["play-upload", ["actions/checkout", "actions/download-artifact", "actions/setup-node"]],
    ["announce", ["actions/checkout", "actions/setup-node"]],
    ["changelog-write", ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]],
  ])("%s builds nothing, and runs only what is listed here", (name, actions) => {
    expect([...jobs[name].matchAll(/uses: ([\w./-]+)@/g)].map((m) => m[1]).sort()).toEqual(actions);
    const runs = runsOf(jobs[name]);
    expect(runs).toEqual(RUNS[name]);
    // Those are all the `run:`s there are: one `runsOf` cannot read, a `- { run: x }`, is
    // counted here all the same.
    expect(jobs[name].match(RUN_KEYS)).toHaveLength(runs.length);
    // A line anywhere in the job that names a program is one of the lines above.
    for (const line of commandsOf(jobs[name])) {
      expect(runs.flat(), line).toContain(line.replace(/^(?:- )?run: /, ""));
    }
    // And what those lines are handed to: a `shell:` is a command line too (`shell: perl {0}`).
    expect([...new Set(jobs[name].match(/\bshell["']? *:.*$/gm))]).toEqual(["shell: bash"]);
    // No cache of any kind, under any key. One line has the word and turns a cache *off*; it is
    // taken out to the letter, so `package-manager-cache: true` is still a line that is refused.
    expect(jobs[name].replace(/^ {10}package-manager-cache: false$/gm, "")).not.toMatch(
      /rust-cache|rust-toolchain|tauri-action|\bcache\b/,
    );
  });

  // `setup-node` turns a cache on by itself when `package.json`'s `packageManager` names npm
  // (`getNameFromPackageManagerField`, read at the pinned v7.0.0). It names pnpm, so nothing is
  // cached with or without the key; the key is what keeps that true if the field or the action's
  // default moves. **The step is held whole**: a `cache:` or a `cache-dependency-path:` beside
  // it is a line that is not here.
  it.each([
    ...Object.keys(DEPLOYS).map((name) => [name, "token"]),
    ["play-upload", "account"],
    ["announce", "hook"],
  ])("%s sets Node up with caching off by name, and with nothing else", (name, id) => {
    const node = stepsOf(jobs[name]).filter((step) => /^uses: actions\/setup-node@/.test(step));
    expect(node).toHaveLength(1);
    expect(node[0].trimEnd().split("\n").slice(1)).toEqual([
      `        if: steps.${id}.outputs.present == 'true'`,
      "        with:",
      "          node-version-file: .nvmrc",
      "          package-manager-cache: false",
    ]);
  });

  it("runs no Node in `android-sign`, so there is no step of it to hold there", () => {
    expect(jobs["android-sign"]).not.toMatch(/setup-node/);
  });

  // The workspace is pnpm's; the six jobs that hold a secret on a release are not part of it. None sets
  // pnpm up, installs with it or runs it: what they run is the list above, to the letter.
  // `jobsOf` has already dropped comment lines, so this reads what the job runs.
  it.each([
    "android-sign",
    "relay-deploy",
    "share-deploy",
    "scan-deploy",
    "web-deploy",
    "play-upload",
    "changelog-write",
    "changelog-commit",
  ])("%s never sees pnpm", (name) => {
    expect(code(jobs[name])).not.toMatch(/pnp[mx]|corepack/);
  });

  it.each([
    ["android-sign", "key", ANDROID_SECRETS],
    ["web-deploy", "token", CLOUDFLARE_SECRETS],
  ])("%s asks whether its secrets are set, and does nothing without them", (name, id, secrets) => {
    const [checkout, ask, ...rest] = stepsOf(jobs[name]);
    // The checkout, which holds nothing; then the step that asks, the only other one that
    // runs without them.
    expect(checkout).toMatch(/^uses: actions\/checkout@/);
    expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
    expect(ask).toMatch(new RegExp(`^ {8}id: ${id}$`, "m"));
    expect(secretsOf(ask)).toEqual(secrets);
    // **It is told whether each is set, never what it is**: every read in it is the
    // comparison, so no key and no token is in the environment of a step that only counts.
    expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toHaveLength(secrets.length);
    expect(ask.match(/\$\{\{ secrets\.[A-Z0-9_]+ != '' \}\}/g)).toHaveLength(secrets.length);
    expect(ask).toContain('echo "present=true" >> "$GITHUB_OUTPUT"');
    expect(ask).toContain('echo "present=false" >> "$GITHUB_OUTPUT"');
    // Some and not all is a mistake in the settings, and a failure — never a quiet skip.
    expect(ask).toMatch(/\[ "\$found" -gt 0 \][^\n]*then[\s\S]*?exit 1/);
    // And it says so where a release's reader looks.
    expect(ask).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
    expect(rest.length).toBeGreaterThan(2);
    for (const step of rest) {
      expect(step).toMatch(
        new RegExp(`^ {8}if: steps\\.${id}\\.outputs\\.present == 'true'$`, "m"),
      );
    }
    // The values themselves reach exactly one step.
    expect(rest.filter((step) => secretsOf(step).length > 0)).toHaveLength(1);
  });

  // **The token alone decides, for these three.** `CLOUDFLARE_ACCOUNT_ID` is in the environment
  // already — `web-deploy` reads it — so "one of two is a mistake" would fail every release
  // until the owner made the second token. No token is a job that deploys nothing and says so;
  // a token with no account is the mistake.
  it.each(["relay-deploy", "share-deploy", "scan-deploy"])(
    "%s asks for the token alone, and does nothing without it",
    (name) => {
      const [checkout, ask, ...rest] = stepsOf(jobs[name]);
      expect(checkout).toMatch(/^uses: actions\/checkout@/);
      expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
      expect(ask).toMatch(/^ {8}id: token$/m);
      expect(secretsOf(ask)).toEqual(INFRA_SECRETS);
      // Told whether each is set, never what it is.
      expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toHaveLength(2);
      expect(ask.match(/\$\{\{ secrets\.[A-Z0-9_]+ != '' \}\}/g)).toHaveLength(2);
      expect(ask).toContain("HAS_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN != '' }}");
      expect(ask).toContain("HAS_ACCOUNT: ${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' }}");
      // No token: `present=false`, the summary, and a green end — before the account is looked at.
      const lines = runsOf(ask)[0];
      const at = (line: string) => lines.indexOf(line);
      expect(at('if [ "$HAS_TOKEN" != true ]; then')).toBe(1);
      expect(at("exit 0")).toBeGreaterThan(at('} >> "$GITHUB_STEP_SUMMARY"'));
      expect(at('if [ "$HAS_ACCOUNT" != true ]; then')).toBeGreaterThan(at("exit 0"));
      expect(at("exit 1")).toBeGreaterThan(at('if [ "$HAS_ACCOUNT" != true ]; then'));
      expect(lines.at(-1)).toBe('echo "present=true" >> "$GITHUB_OUTPUT"');
      expect(lines.filter((line) => line.includes("present=true"))).toHaveLength(1);
      for (const step of rest) {
        expect(step).toMatch(/^ {8}if: steps\.token\.outputs\.present == 'true'$/m);
      }
      // The token reaches wrangler's steps and no other: the migrations and the deploy — or,
      // for the scan inbox, which has no database, the deploy alone.
      const holding = rest.filter((step) => secretsOf(step).length > 0);
      expect(holding).toHaveLength(WRANGLER_RUNS[name]);
      for (const step of holding) {
        expect(secretsOf(step)).toEqual(INFRA_SECRETS);
        expect(step).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN }}");
        expect(step).toMatch(
          /^ {8}run: node \.\.\/wrangler\/node_modules\/wrangler\/bin\/wrangler\.js /m,
        );
      }
    },
  );

  // **The web app goes live only behind the other three** (issue #1198). With no infra token
  // they end green having deployed nothing, so each says whether it deployed, and `web-deploy`
  // holding its own token fails on any of them that did not — before anything is downloaded or
  // deployed, so the release stays a draft rather than a page ahead of its relay.
  it.each(["relay-deploy", "share-deploy", "scan-deploy"])(
    "%s says whether it deployed, from its token step",
    (name) => {
      expect(jobs[name]).toMatch(
        /^ {4}outputs:\n {6}deployed: \$\{\{ steps\.token\.outputs\.present \}\}$/m,
      );
    },
  );

  it("web-deploy refuses to deploy, its token in hand, unless the other three deployed", () => {
    const ask = stepsOf(jobs["web-deploy"])[1];
    for (const [env, job] of [
      ["RELAY_DEPLOYED", "relay-deploy"],
      ["SHARE_DEPLOYED", "share-deploy"],
      ["SCAN_DEPLOYED", "scan-deploy"],
    ]) {
      expect(ask).toContain(`${env}: \${{ needs.${job}.outputs.deployed }}`);
      expect(needsOf(jobs["web-deploy"])).toContain(job);
    }
    const lines = runsOf(ask)[0];
    const at = (line: string) => lines.indexOf(line);
    const check =
      'if [ "$RELAY_DEPLOYED" != true ] || [ "$SHARE_DEPLOYED" != true ] || [ "$SCAN_DEPLOYED" != true ]; then';
    // Inside "both values are set", and before `present=true` is ever written.
    expect(at(check)).toBe(at('if [ -z "$missing" ]; then') + 1);
    expect(lines[at(check) + 4]).toBe("exit 1");
    expect(at('echo "present=true" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(at(check) + 4);
  });

  it("builds the share viewer at the tag, as every pull request does, and hands it on", () => {
    const share = stepsOf(jobs.share);
    const at = (needle: string) => share.findIndex((step) => step.includes(needle));
    expect(at("run: pnpm share:build")).toBeGreaterThan(at("run: pnpm install --frozen-lockfile"));
    expect(at("apps/share/dist-share/assets/share.js")).toBeGreaterThan(
      at("run: pnpm share:build"),
    );
    expect(at("name: share-bundle")).toBeGreaterThan(at("apps/share/dist-share/assets/share.js"));
    expect(share[at("name: share-bundle")]).toContain("path: apps/share/dist-share/");
    expect(share[at("name: share-bundle")]).toContain("if-no-files-found: error");
    expect(secretRefs(jobs.share)).toEqual([]);
    // The same command, in the leg of `ci.yml` that builds: a pull request that breaks the
    // viewer is red before a tag is.
    expect(ciYml).toMatch(/^ {8}run: pnpm share:build$/m);
  });

  it("applies the migrations, deploys and asks the host, in that order, in each Worker's job", () => {
    const orderOf = (name: string, needles: string[]) => {
      const steps = stepsOf(jobs[name]);
      const order = needles.map((needle) => steps.findIndex((s) => s.includes(needle)));
      expect(order[0], name).toBeGreaterThan(-1);
      expect(order, name).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size, name).toBe(order.length);
    };
    orderOf("relay-deploy", [
      'gh api "repos/$REPO/releases/latest"',
      "run: npm ci --ignore-scripts",
      `run: ${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`,
      `run: ${WRANGLER} deploy`,
      "run: node scripts/relay-deploy-probe.ts",
    ]);
    orderOf("share-deploy", [
      'gh api "repos/$REPO/releases/latest"',
      "name: share-bundle",
      "[ -s apps/share/dist-share/assets/share.js ]",
      "run: npm ci --ignore-scripts",
      `run: ${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`,
      `run: ${WRANGLER} deploy`,
      "run: node scripts/share-deploy-probe.ts apps/share/dist-share",
    ]);
    // The scan inbox has no database and no bundle: the install, the deploy, the probe.
    orderOf("scan-deploy", [
      'gh api "repos/$REPO/releases/latest"',
      "run: npm ci --ignore-scripts",
      `run: ${WRANGLER} deploy`,
      "run: node scripts/scan-deploy-probe.ts",
    ]);
    expect(jobs["scan-deploy"]).not.toMatch(/d1 migrations|download-artifact/);
    // What `share-deploy` uploads is what `share` built: one artifact name, one folder.
    expect(stepsOf(jobs["share-deploy"]).find((s) => s.includes("name: share-bundle"))).toContain(
      "path: apps/share/dist-share",
    );
  });

  // **Uploads only what was signed, with a key that is set.** A service account with no signed
  // bundle is a release that had no upload key or no fingerprint: `android-sign` already said
  // so, and this job must not go looking for an artifact that was never made.
  it("asks for the account and the signed bundle, and does nothing without both", () => {
    const [checkout, ask, ...rest] = stepsOf(jobs["play-upload"]);
    expect(checkout).toMatch(/^uses: actions\/checkout@/);
    expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
    expect(ask).toMatch(/^ {8}id: account$/m);
    // Told whether the key is set, never what it is.
    expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toEqual(["secrets.PLAY_SERVICE_ACCOUNT_JSON"]);
    expect(ask).toContain("HAS_ACCOUNT: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON != '' }}");
    expect(ask).toContain("SIGNED: ${{ needs.android-sign.outputs.signed }}");
    const lines = runsOf(ask)[0];
    expect(lines[1]).toBe('if [ "$HAS_ACCOUNT" = true ] && [ "$SIGNED" = true ]; then');
    expect(lines.filter((line) => line.includes("present=true"))).toHaveLength(1);
    // Neither absence is a failure: the job ends green and says which it was.
    expect(lines).not.toContain("exit 1");
    expect(ask).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
    expect(rest).toHaveLength(3);
    for (const step of rest) {
      expect(step).toMatch(/^ {8}if: steps\.account\.outputs\.present == 'true'$/m);
    }
    // **Three steps after the asking one, in this order, and nothing else**: Node, the bundle,
    // then the script. The script's step above the download is a step that runs with the key
    // and no bundle to read; a fourth step is one nothing here has looked at.
    const [node, download, script] = rest;
    expect(node).toMatch(/^uses: actions\/setup-node@/);
    expect(download).toMatch(/^uses: actions\/download-artifact@/);
    expect(script).toMatch(/^name: Upload the bundle to the internal track$/m);
    // The key reaches one step: the script's.
    const holding = rest.filter((step) => secretsOf(step).length > 0);
    expect(holding).toEqual([script]);
    // …and it is the step that runs the script, nothing else.
    expect(runsOf(script)).toEqual([RUNS["play-upload"][1]]);
    // The download step is held whole, as the Node step is: it holds no key and no extra key.
    expect(download.trimEnd().split("\n").slice(1)).toEqual([
      "        if: steps.account.outputs.present == 'true'",
      "        with:",
      "          name: play-upload-bundle",
      "          path: aab-in",
    ]);
    // **And the step that holds the key is held whole, every line of it.** `RUNS` holds what
    // its `run:` runs; this holds what stands beside it, which runs things too: a
    // `NODE_OPTIONS: --import ./x.ts` in `env:` is code run with the key and no `run:` line
    // changed, a `working-directory:` is another file under the same path, and a `VERSION` read
    // from anywhere but release-please's own `version` output is another bundle and another
    // versionCode. The deadline is the script's own deadlines and a margin; the job's is above it.
    expect(script.trimEnd().split("\n")).toEqual([
      "name: Upload the bundle to the internal track",
      "        if: steps.account.outputs.present == 'true'",
      "        shell: bash",
      "        timeout-minutes: 20",
      "        env:",
      "          PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}",
      "          VERSION: ${{ needs.release-please.outputs.version }}",
      "        run: |",
      ...RUNS["play-upload"][1].map((line) => `          ${line}`),
    ]);
    expect(RUNS["play-upload"][1]).toHaveLength(3);
  });

  it("uploads the bundle `android-sign` signed, under the name and the versionCode it gave it", () => {
    const sign = jobs["android-sign"];
    const play = jobs["play-upload"];
    // One artifact, one file name, on both sides.
    // Line-anchored, so `play-upload-bundle-signed` on either side is a different artifact.
    expect(stepsOf(sign).at(-1)).toMatch(/^ {10}name: play-upload-bundle$/m);
    expect(play).toMatch(/^ {10}name: play-upload-bundle$/m);
    expect(sign).toContain('aab="mtg-grimoire-$VERSION-android.aab"');
    expect(play).toContain('"aab-in/mtg-grimoire-$VERSION-android.aab"');
    // And one arithmetic: Tauri's, which `versionCode` above computes and the summary prints.
    const arithmetic = "$((major * 1000000 + minor * 1000 + patch))";
    expect(sign).toContain(arithmetic);
    expect(play).toContain(arithmetic);
    // It can write nothing to the repository or the release.
    expect(play).not.toMatch(/gh release|GITHUB_TOKEN|GH_TOKEN|contents: write/);
    expect(play).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
  });

  // "Signed by the keystore in the settings" is not "signed by the key the last release was".
  it("signs no bundle without the committed fingerprint, and holds the key to it", () => {
    const [, ask, , sign] = stepsOf(jobs["android-sign"]);
    expect(ask).toContain(`PIN: ${SIGNER_PIN}`);
    // `present=true` is said in one place, and only with every value set and the file there.
    expect(ask.match(/present=true/g)).toHaveLength(1);
    expect(ask).toMatch(
      /if \[ -z "\$missing" \] && \[ -f "\$PIN" \]; then\n\s+echo "present=true"/,
    );
    expect(sign).toContain(`ANDROID_SIGNER_PIN: ${SIGNER_PIN}`);
    // The alias is a plain word: as a secret, GitHub would mask every `mtg-grimoire` in the log.
    expect(sign).toMatch(/^ {10}ANDROID_KEY_ALIAS: mtg-grimoire$/m);
    // Nobody else on the runner reads the keystore while it exists.
    expect(sign.indexOf("umask 077")).toBeGreaterThan(-1);
    expect(sign.indexOf("umask 077")).toBeLessThan(sign.indexOf("base64 --decode"));
  });

  it("hands the signed bundle to `play-upload` as an artifact, and puts nothing on the release", () => {
    const sign = jobs["android-sign"];
    expect(sign).toContain('aab="mtg-grimoire-$VERSION-android.aab"');
    expect(sign).toMatch(
      /bash scripts\/android-release\/sign-bundle\.sh aab-in\/mtg-grimoire-light-arm64\.aab "\$aab"/,
    );
    // The keystore is decoded outside the checkout and removed however the step ends.
    expect(sign).toContain('export ANDROID_KEYSTORE="$RUNNER_TEMP/release.keystore"');
    expect(sign).toContain(`trap 'rm -f "$ANDROID_KEYSTORE"' EXIT`);
    // What it signs is what `android` built…
    expect(jobs.android).toContain("name: android-aab-debug-signed");
    expect(sign).toContain("name: android-aab-debug-signed");
    // …under one file name on both sides: `android-sign` runs only at a release, so a rename
    // in `android` alone would be found there and nowhere sooner.
    expect(jobs.android).toContain('cp "$aab" aab-out/mtg-grimoire-light-arm64.aab');
    expect(jobs.android).toContain("path: aab-out/mtg-grimoire-light-arm64.aab");
    expect(sign).toContain("path: aab-in");
    // …and what it signed leaves as an artifact, which `play-upload` puts on Play's internal track.
    const upload = stepsOf(sign).at(-1);
    expect(upload).toMatch(/^uses: actions\/upload-artifact@/);
    expect(upload).toContain("name: play-upload-bundle");
    expect(upload).toContain("path: ${{ env.SIGNED_AAB }}");
    expect(upload).toContain("if-no-files-found: error");
    // Retention is stated in the documents: thirty days for the bundle `play-upload` takes,
    // fourteen for the debug-signed build a sign job re-runs from.
    expect(upload).toContain("retention-days: 30");
    // And it says whether it signed one, which is what `play-upload` asks first.
    expect(sign).toMatch(/^ {4}outputs:\n {6}signed: \$\{\{ steps\.key\.outputs\.present \}\}$/m);
    expect(
      stepsOf(jobs.android).find((s) => s.includes("name: android-aab-debug-signed")),
    ).toContain("retention-days: 14");
    // **Play is the only place an Android build is published.** Neither job touches the
    // release, and the job that holds the key can write nothing to the repository.
    expect(jobs.android).not.toMatch(/gh release/);
    expect(sign).not.toMatch(/gh release|GITHUB_TOKEN|GH_TOKEN/);
    expect(sign).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
    expect(sign).not.toMatch(/contents: write/);
    // The build also makes a debug-signed APK, as every pull request's does. No job names one.
    expect(code(releaseYml)).not.toMatch(/\.apk\b/);
  });

  it("builds the Android app and the web app as `ci.yml` does", () => {
    // The two build legs are copies of jobs that run green on every pull request; a command
    // that differs is one no pull request has run.
    for (const command of [
      "pnpm exec tauri android build --apk --aab --target aarch64 --ci",
      'bash scripts/android-release/check-version.sh "$VERSION"',
      "key: android-aarch64",
    ]) {
      expect(jobs.android, command).toContain(command);
      expect(ciYml, command).toContain(command);
    }
    for (const command of [
      "sudo apt-get update && sudo apt-get install -y clang",
      'cargo install wasm-bindgen-cli --version "$bindgen" --locked',
      "run: pnpm web:wasm",
      // The card scanner's three files, and a build that fails without them (step 7.5): a web
      // app released without its scanner opens, passes its smoke, and cannot scan.
      "run: pnpm scanner:assets --web",
      "GRIMOIRE_SCANNER_ASSETS: required",
      "run: pnpm web:build",
      "run: pnpm web:smoke",
      "key: web-wasm32",
    ]) {
      expect(jobs.web, command).toContain(command);
      expect(ciYml, command).toContain(command);
    }
    // In that order, in both: the modules' build empties the folder the files land in, and
    // the page's build ships what is there when it runs.
    for (const text of [jobs.web, ciYml]) {
      const at = (needle: string) => text.indexOf(needle);
      expect(at("run: pnpm scanner:assets --web")).toBeGreaterThan(at("run: pnpm web:wasm"));
      expect(at("run: pnpm web:build")).toBeGreaterThan(at("run: pnpm scanner:assets --web"));
      expect(at("run: pnpm web:build")).toBeGreaterThan(at("GRIMOIRE_SCANNER_ASSETS: required"));
    }
    // And a pull request scans a card with what it built.
    expect(ciYml).toContain("run: pnpm web:scanner-smoke");
    // And the signing a release runs is the signing a pull request proved: `ci.yml` runs the
    // proof over its own bundle, and the proof runs the script `android-sign` runs.
    expect(ciYml).toMatch(
      /^\s+run: bash scripts\/android-release\/proof\.sh aab-out\/mtg-grimoire-light-arm64\.aab$/m,
    );
    expect(signProof).toContain('bash "$HERE/sign-bundle.sh"');
  });

  it("deploys the bundle `web` built and opened in a browser, then asks the host", () => {
    const web = stepsOf(jobs.web);
    const at = (needle: string) => web.findIndex((step) => step.includes(needle));
    expect(at("pnpm web:smoke")).toBeGreaterThan(at("pnpm web:build"));
    expect(at("name: web-bundle")).toBeGreaterThan(at("pnpm web:smoke"));

    const deploy = stepsOf(jobs["web-deploy"]);
    const step = (needle: string) => deploy.findIndex((s) => s.includes(needle));
    const order = [
      // Before anything is downloaded or installed: is this tag older than what is published?
      'gh api "repos/$REPO/releases/latest"',
      "name: web-bundle",
      "run: npm ci --ignore-scripts",
      "run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy",
      "run: node scripts/web-deploy-probe.ts apps/light/dist-web",
    ].map(step);
    expect(order[0]).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  // A re-run of this job long after its run would upload this tag's bundle over a later
  // release's: an older user schema in front of desktops that have moved on.
  it.each(Object.keys(DEPLOYS))(
    "%s refuses to deploy a release older than the newest published one",
    (name) => {
      const refusal = stepsOf(jobs[name]).find((s) => s.includes("releases/latest"));
      expect(refusal).toMatch(
        /newest=\$\(printf '%s\\n%s\\n' "\$latest" "\$TAG" \| sort -V \| tail -1\)/,
      );
      expect(refusal).toMatch(/if \[ "\$newest" != "\$TAG" \]; then[\s\S]*exit 1/);
      expect(refusal).toMatch(/^ {8}if: steps\.token\.outputs\.present == 'true'$/m);
    },
  );

  // One job has the key and can write nothing; the other writes and has no key.
  it("keeps the key and the write apart in the two changelog jobs", () => {
    const write = jobs["changelog-write"];
    const commit = jobs["changelog-commit"];
    expect(write).toMatch(
      /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {4}outputs:$/m,
    );
    // No permission of the key's job is a write. (Its step `id: write` sits two levels deeper.)
    expect(write).not.toMatch(/^ {6}[a-z-]+: write$/m);
    expect(commit).toMatch(/^ {4}permissions:\n {6}contents: write\n {4}steps:$/m);
    expect(commit).not.toMatch(/environment:|OPENROUTER|actions\/checkout|setup-node/);
    // What the second puts on the release branch is the first's artifact, by name…
    expect(write).toContain("name: release-notes");
    expect(commit).toContain("name: release-notes");
    // …through the contents API, onto release-please's branch and nowhere else.
    expect(commit).toContain('args=(-X PUT "repos/$REPO/contents/$file" -f "branch=$BRANCH")');
    expect(commit).toContain("BRANCH: release-please--branches--main--components--mtg-grimoire");
    expect(commit).not.toMatch(/gh release|git push/);
    // The blob to replace is read from a *successful* answer only. `gh api` prints a 404's JSON
    // to stdout and exits 1, so `$(…) || true` would send that text as the file's `sha` and
    // fail the first commit of every release's notes.
    expect(commit).toContain(
      'if found=$(gh api "repos/$REPO/contents/$file?ref=$BRANCH" --jq .sha 2>/dev/null); then sha=$found; fi',
    );
    expect(commit).not.toMatch(/\|\| true/);
  });

  it("asks whether the key is set before `changelog-write` does anything with it", () => {
    const [checkout, ask, ...rest] = stepsOf(jobs["changelog-write"]);
    expect(checkout).toMatch(/^uses: actions\/checkout@/);
    // The range is the last tag to this commit, so the checkout is all of history.
    expect(checkout).toMatch(/^ {10}fetch-depth: 0$/m);
    expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
    expect(ask).toMatch(/^ {8}id: key$/m);
    // **Told whether it is set, never what it is.**
    expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toEqual(["secrets.OPENROUTER_API_KEY"]);
    expect(ask).toContain("HAS_KEY: ${{ secrets.OPENROUTER_API_KEY != '' }}");
    expect(ask).toContain('echo "present=true" >> "$GITHUB_OUTPUT"');
    expect(ask).toContain('echo "present=false" >> "$GITHUB_OUTPUT"');
    expect(ask).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
    expect(rest).toHaveLength(3);
    for (const step of rest) {
      expect(step).toMatch(
        /^ {8}if: steps\.key\.outputs\.present == 'true'(?: && steps\.write\.outputs\.version != '')?$/m,
      );
    }
    // The key itself reaches exactly one step, and that step runs one file.
    expect(rest.filter((step) => secretsOf(step).length > 0)).toHaveLength(1);
    expect(rest[1]).toMatch(/^ {8}run: node scripts\/changelog\/cli\.ts next$/m);
    expect(secretsOf(rest[1])).toEqual(["OPENROUTER_API_KEY"]);
  });

  // No model is asked anything on a release: the body is the file the release PR merged.
  it("publishes the notes the tag holds, and release-please's when it holds none", () => {
    const [notes, flip] = stepsOf(jobs.publish);
    expect(stepsOf(jobs.publish)).toHaveLength(2);
    expect(notes).toContain('file="changelog/$VERSION.md"');
    expect(notes).toContain("SHA: ${{ needs.release-please.outputs.sha }}");
    expect(notes).toContain('"repos/$REPO/contents/$file?ref=$SHA" > notes.md');
    expect(notes).toContain('gh release edit "$TAG" --notes-file notes.md --repo "$REPO"');
    // **Notes never hold a release up**: nothing in the step can end it non-zero.
    expect(notes).not.toMatch(/set -e|exit 1|--draft/);
    expect(notes).toMatch(/^ {10}else$/m);
    expect(flip).toMatch(/--draft=false/);
    expect(code(releaseYml)).not.toMatch(/openrouter\.ai/);
  });

  it("asks whether the webhook is set, and hands it to one step that runs one file", () => {
    const [checkout, ask, ...rest] = stepsOf(jobs.announce);
    expect(checkout).toMatch(/^uses: actions\/checkout@/);
    expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
    expect(ask).toMatch(/^ {8}id: hook$/m);
    // **Told whether it is set, never what it is.**
    expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toEqual(["secrets.DISCORD_WEBHOOK_URL"]);
    expect(ask).toContain("HAS_HOOK: ${{ secrets.DISCORD_WEBHOOK_URL != '' }}");
    expect(rest).toHaveLength(3);
    for (const step of rest) {
      expect(step).toMatch(/^ {8}if: steps\.hook\.outputs\.present == 'true'$/m);
    }
    const [, read, post] = rest;
    // The body is read with the run's token, by a step that never sees the webhook…
    expect(secretsOf(read)).toEqual([]);
    expect(read).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    // …and the webhook reaches the one step that posts, and nothing else there.
    expect(secretsOf(post)).toEqual(["DISCORD_WEBHOOK_URL"]);
    expect(post).not.toMatch(/GITHUB_TOKEN/);
    expect(post).toMatch(/^ {8}run: node scripts\/changelog\/discord\.ts notes\.md$/m);
    // It reads, and writes nothing here: what it changes is the channel.
    expect(jobs.announce).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
  });

  it("publishes last, and nothing else flips the draft", () => {
    const flips = Object.entries(jobs)
      .filter(([, job]) => /gh release edit/.test(job))
      .map(([name]) => name);
    expect(flips).toEqual(["publish"]);
    expect(jobs.publish).toMatch(/--draft=false/);
  });
});

describe("deploys, across every workflow", () => {
  /** Every line of every workflow that is not a comment, with where it is. */
  const lines = Object.entries(WORKFLOWS).flatMap(([path, src]) =>
    code(src)
      .split("\n")
      .map((line) => ({ path, line })),
  );

  it("reads the workflows", () => {
    expect(Object.keys(WORKFLOWS)).toEqual(
      expect.arrayContaining(["/.github/workflows/ci.yml", "/.github/workflows/release.yml"]),
    );
  });

  // **Four jobs start wrangler, each from its own Worker's folder** (the owner's decisions,
  // 2026-10-11: a release deploys everything, the scan inbox with the rest). Six commands, and
  // these are all of them: two `d1 migrations apply --remote` and four `deploy`. A seventh
  // line, a `secret`, a `rollback`, a `d1 execute --remote`, is a line that is not here.
  it("runs wrangler six times, in the four deploy jobs, from each Worker's own folder", () => {
    const wrangler = lines.filter(({ line }) => /\bwrangler\b/.test(line));
    const release = "/.github/workflows/release.yml";
    const install = { path: release, line: "        working-directory: infrastructure/wrangler" };
    const migrate = {
      path: release,
      line: `        run: ${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`,
    };
    const deploy = { path: release, line: `        run: ${WRANGLER} deploy` };
    expect(wrangler).toEqual([
      {
        // Not a run of it: the `web` job's step that *installs* the same lockfile, for the sync
        // smoke (phase 6, step 6.3). The test below holds what that run may ask of it.
        path: "/.github/workflows/ci.yml",
        line: "      - name: Install wrangler from its lockfile",
      },
      {
        path: "/.github/workflows/ci.yml",
        line: "        run: npm ci --ignore-scripts --prefix infrastructure/wrangler",
      },
      // relay-deploy
      install,
      migrate,
      deploy,
      // share-deploy
      install,
      migrate,
      deploy,
      // scan-deploy: no database, so no migration.
      install,
      deploy,
      // web-deploy: none there either.
      install,
      deploy,
    ]);
    for (const [name, folder] of Object.entries(DEPLOYS)) {
      const steps = stepsOf(jobsOf(releaseYml)[name]);
      const runs = steps.filter((s) => /^ {8}run: node \.\.\/wrangler\//m.test(s));
      expect(runs.length, name).toBe(WRANGLER_RUNS[name]);
      for (const step of runs) {
        // From the Worker's folder, where `wrangler.jsonc` is…
        expect(step, name).toMatch(new RegExp(`^ {8}working-directory: ${folder}$`, "m"));
        expect(secretsOf(step), name).toEqual(
          name === "web-deploy" ? CLOUDFLARE_SECRETS : INFRA_SECRETS,
        );
        expect(step, name).toContain('WRANGLER_SEND_METRICS: "false"');
      }
      // …and the install is the step before the first of them, in the tool's folder, with
      // **nothing in its environment**: what it installs is not run until a token's step.
      const before = steps[steps.indexOf(runs[0]) - 1];
      expect(before, name).toMatch(/^ {8}run: npm ci --ignore-scripts$/m);
      expect(before, name).toMatch(/^ {8}working-directory: infrastructure\/wrangler$/m);
      expect(before, name).not.toMatch(/^ {8}env:/m);
      expect(secretRefs(before), name).toEqual([]);
    }
  });

  // **What "pinned" means here: a lockfile.** `npx wrangler@4.146.0` pinned one package of
  // ninety-one; the rest came through floating ranges, resolved on the day of the deploy.
  it("pins wrangler and everything under it in a lockfile of its own, outside the workspace", () => {
    const manifest = JSON.parse(deployToolPackage);
    const lock = JSON.parse(deployToolLock);
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(Object.keys(manifest.devDependencies)).toEqual(["wrangler"]);
    const version = manifest.devDependencies.wrangler;
    // An exact version: a range in the manifest is a lockfile the next `npm install` may move.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""].devDependencies).toEqual({ wrangler: version });
    expect(lock.packages["node_modules/wrangler"].version).toBe(version);
    const others = Object.entries(
      lock.packages as Record<string, { resolved: string; integrity: string }>,
    ).filter(([path]) => path !== "");
    expect(others.length).toBeGreaterThan(20);
    // Each one from the registry, with the hash `npm ci` checks the tarball against.
    for (const [path, entry] of others) {
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
    // The runner's platform is in it: `npm ci` on Linux installs these two without a script.
    expect(lock.packages["node_modules/@esbuild/linux-x64"]).toBeDefined();
    expect(lock.packages["node_modules/@cloudflare/workerd-linux-64"]).toBeDefined();
    // The tool's folder is npm's. pnpm's workspace is these six entries and no glob that could
    // take `infrastructure/wrangler` in — a member's dependencies are resolved by pnpm-lock.yaml,
    // and this lockfile would stop being what installs.
    const packageList = workspaceYaml.split(/^packages:\r?\n/m)[1].split(/^\S/m)[0];
    const members = [...packageList.matchAll(/^ {2}- (\S+)\r?$/gm)].map((m) => m[1]);
    expect(members).toEqual([
      "scripts",
      "packages/*",
      "apps/*",
      "infrastructure/relay",
      "infrastructure/share-worker",
      "infrastructure/app-worker",
      "infrastructure/scan-worker",
    ]);
    // And the Worker's own manifest, in the folder the tool left, is not a second home for it.
    const worker = JSON.parse(appWorkerPackage);
    expect(worker.name).toBe("@grimoire/app-worker");
    expect({ ...worker.dependencies, ...worker.devDependencies }).not.toHaveProperty("wrangler");
  });

  // **The other place wrangler is installed, and why it is not a deploy** (phase 6, step 6.3):
  // CI's `web` job runs `scripts/web-sync-smoke.ts`, which starts the *relay's* code under
  // workerd on the runner and pairs two browsers through it. The same lockfile, the same
  // `--ignore-scripts`, no secret — and a script that may ask wrangler for two things, both
  // `--local`. A third subcommand there, or one of these without the flag, is a workflow that
  // can reach the account.
  it("installs wrangler in CI for a run that is local, start to finish", () => {
    const steps = stepsOf(jobsOf(ciYml).web);
    const install = steps.findIndex((s) => /\bwrangler\b/.test(s));
    expect(steps[install]).toMatch(
      /^ {8}run: npm ci --ignore-scripts --prefix infrastructure\/wrangler$/m,
    );
    expect(steps[install]).not.toMatch(/^ {8}env:/m);
    expect(steps[install + 1]).toMatch(/^ {8}run: pnpm web:sync-smoke$/m);
    expect(steps[install + 1]).not.toMatch(/^ {8}env:/m);
    expect(secretRefs(code(jobsOf(ciYml).web))).toEqual([]);

    // Every wrangler subcommand the run spawns, as the argv it writes: the word after the
    // script's own path, or after the `d1()` helper's fixed `d1 execute`. **Three files are the
    // run since step 6.5**: the relay is started by `web-smoke/sync-harness.ts`, for the walk
    // and for `web-sync-pull.ts` — the measurement of a large pull, which no job runs and
    // which is held to the same two commands all the same. So the spawns are counted across all
    // three, and found in the harness alone.
    const spawned = /\[\s*script,\s*"([a-z0-9]+)",\s*"([^"]+)"/g;
    const starts = [...`${syncSmoke}\n${syncHarness}\n${syncPull}`.matchAll(spawned)];
    expect(starts.map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(["d1 execute", "dev --local"]);
    expect([...syncHarness.matchAll(spawned)]).toHaveLength(2);
    expect(syncHarness).toMatch(/\[\s*script,\s*"d1",\s*"execute",\s*"[\w-]+",\s*"--local",/);
    // Every process any of them starts, by the first argument of each `spawn`: the browser and
    // wrangler (twice: `d1`, then `dev`) in the two harness modules, nothing in the walk, and
    // one in the measurement — the system's process table, asked what a tab and workerd weigh.
    const processes = (source: string) =>
      [...source.matchAll(/\bspawn(?:Sync)?\(\s*([^,\s]+)/g)].map((m) => m[1]);
    expect(processes(smokeHarness)).toEqual(["browserPath()"]);
    expect(processes(syncHarness).sort()).toEqual(
      ['"taskkill"', "process.execPath"].flatMap((name) =>
        name === "process.execPath" ? [name, name] : [name],
      ),
    );
    expect(processes(syncSmoke)).toEqual([]);
    expect(processes(syncPull)).toEqual(['"powershell.exe"']);
    // **And what that one is told to do**: read. The command is one pipeline of three cmdlets,
    // none of which writes, starts or stops anything — pinned by its words and not only by the
    // program's name, which could be handed anything.
    const asked = /spawnSync\(\s*"powershell\.exe",\s*\[([\s\S]*?)\],\s*\{/.exec(syncPull)?.[1];
    expect(asked).toMatch(/^\s*"-NoProfile",\s*"-NonInteractive",\s*"-Command",/);
    expect([...new Set(asked!.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g))].sort()).toEqual([
      "ConvertTo-Json",
      "Get-CimInstance",
      "Select-Object",
    ]);
    expect(asked).not.toMatch(/[;&`$]|\bInvoke-|\bStart-|\bStop-|\bRemove-|\bSet-|\biex\b/);

    // **The list above is a list of files, so it is held to being the whole of the run**: each
    // script's relative imports, by name. A module added beside these that started wrangler
    // itself would be read by none of the assertions above — and is refused here, until it is
    // added to them.
    const imports = (source: string) => {
      const file = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest);
      return file.statements
        .flatMap((statement) => {
          if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
          if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier))
            return [];
          if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;
            if (clause?.isTypeOnly) return [];
            const bindings = clause?.namedBindings;
            if (
              !clause?.name &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.length > 0 &&
              bindings.elements.every((item) => item.isTypeOnly)
            )
              return [];
          } else if (statement.isTypeOnly) return [];
          const name = statement.moduleSpecifier.text;
          return name.startsWith(".") ? [name] : [];
        })
        .sort();
    };
    expect(imports(syncSmoke)).toEqual(["./web-smoke/harness.ts", "./web-smoke/sync-harness.ts"]);
    expect(imports(syncPull)).toEqual(["./web-smoke/harness.ts", "./web-smoke/sync-harness.ts"]);
    expect(imports(syncHarness)).toEqual(["./harness.ts"]);
    expect(imports(smokeHarness)).toEqual([
      "../../infrastructure/app-worker/src/headers.ts",
      "../../packages/ui/lib/core/web/assets.ts",
    ]);
    for (const [name, source] of Object.entries({
      syncSmoke,
      syncHarness,
      syncPull,
      smokeHarness,
    })) {
      // No import that is computed, which the list above could not see.
      expect(source.replace(/`[^`]*`/gs, ""), name).not.toMatch(/\bimport\(/);
    }

    // And none of the words that reach Cloudflare is an argument anywhere in them.
    const reaching = /["'`](?:deploy|publish|rollback|versions|secret|tail|login|--remote)["'`]/;
    for (const [name, source] of Object.entries({
      syncSmoke,
      syncHarness,
      syncPull,
      smokeHarness,
    })) {
      expect(source, name).not.toMatch(reaching);
    }
  });

  it("deploys each Worker from its own job, and holds no Cloudflare secret anywhere else", () => {
    // The scan inbox (`infrastructure/scan-worker/`) is named by the release alone, and there
    // by its own job: no other workflow runs or deploys it.
    expect(
      lines.filter(
        ({ path, line }) => !path.endsWith("/release.yml") && /\bscan-worker\b/.test(line),
      ),
    ).toEqual([]);
    // A Worker's folder is a working directory in exactly one job: its own.
    const jobs = jobsOf(releaseYml);
    for (const [name, job] of Object.entries(jobs)) {
      const folders = [...job.matchAll(/^ {8}working-directory: (infrastructure\/[\w-]+)$/gm)]
        .map((m) => m[1])
        .filter((folder) => folder !== "infrastructure/wrangler");
      expect([...new Set(folders)], name).toEqual(name in DEPLOYS ? [DEPLOYS[name]] : []);
    }
    // No workflow but the release names the relay or the share Worker, bar `ci.yml`'s one line,
    // which deploys nothing: the sync smoke's step, which runs the relay's code on the runner —
    // the test above has what that run may do.
    expect(
      lines.filter(
        ({ path, line }) =>
          !path.endsWith("/release.yml") && /\b(?:relay|share-worker)\b/.test(line),
      ),
    ).toEqual([
      {
        path: "/.github/workflows/ci.yml",
        line: "      - name: Pair two browsers through the local relay",
      },
    ]);
    const held = lines.filter(({ line }) => /CLOUDFLARE_|ANDROID_KEY|PLAY_SERVICE/.test(line));
    // The throwaway key `ci.yml` proves the signing on is minted inside
    // `scripts/android-release/proof.sh`, so no workflow but the release names either.
    expect([...new Set(held.map(({ path }) => path))].sort()).toEqual([
      "/.github/workflows/release.yml",
    ]);
    expect(secretsOf(code(ciYml))).toEqual([]);
  });

  it("commits no account id: every deploy reads it from a secret", () => {
    for (const name of Object.keys(DEPLOYS)) {
      const steps = stepsOf(jobsOf(releaseYml)[name]).filter((s) =>
        /^ {8}run: node \.\.\/wrangler\//m.test(s),
      );
      for (const step of steps) {
        expect(step, name).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
      }
    }
    // A Cloudflare account id is 32 hex characters; an action's pin is 40.
    expect(code(releaseYml)).not.toMatch(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/);
  });

  // These jobs run wrangler with a token: a write scope on the repository's own token, an OIDC
  // token or a package or actions grant beside it is one more thing a hijacked step could use.
  it.each(Object.keys(DEPLOYS))("%s may read the repository and write nothing", (name) => {
    const job = jobsOf(releaseYml)[name];
    expect(job).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
    expect(job).not.toMatch(/contents: write|id-token|packages:|actions:/);
  });

  // **The token's step is held whole.** `toContain` finds the token in an environment that holds
  // a `NODE_OPTIONS` beside it, which runs a file of the branch's choosing in wrangler's process;
  // so the environment is these three lines, in this order, and no others. And the step that
  // asks the live host holds none at all: `PROBE_ATTEMPTS: 0` is a probe that asks nothing.
  it.each(Object.keys(DEPLOYS))("%s hands wrangler three variables and the probe none", (name) => {
    const token = name === "web-deploy" ? "CLOUDFLARE_API_TOKEN" : "CLOUDFLARE_INFRA_API_TOKEN";
    const envOf = (step: string) => {
      const lines = step.split("\n");
      const at = lines.findIndex((line) => /^ {8}env:$/.test(line));
      if (at === -1) return null;
      const block = [];
      for (const line of lines.slice(at + 1)) {
        if (line.trim() === "" || line.search(/\S/) <= 8) break;
        block.push(line);
      }
      return block;
    };
    const steps = stepsOf(jobsOf(releaseYml)[name]);
    const wranglers = steps.filter((step) => /^ {8}run: node \.\.\/wrangler\//m.test(step));
    expect(wranglers).toHaveLength(WRANGLER_RUNS[name]);
    for (const step of wranglers) {
      expect(envOf(step), name).toEqual([
        `          CLOUDFLARE_API_TOKEN: \${{ secrets.${token} }}`,
        "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
        '          WRANGLER_SEND_METRICS: "false"',
      ]);
    }
    const probes = steps.filter((step) =>
      /^ {8}run: node scripts\/[\w-]*deploy-probe\.ts/m.test(step),
    );
    expect(probes, name).toHaveLength(1);
    expect(probes[0], name).not.toMatch(/^ *env:/m);
  });
});

describe("the guards' own guards", () => {
  it("sees every spelling of a secret, and names only the honest one", () => {
    const names = (text: string) => secretRefs(text).map((ref) => ref.name);
    expect(names("X: ${{ secrets.CLOUDFLARE_API_TOKEN }}")).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(names("X: ${{ secrets.CLOUDFLARE_API_TOKEN != '' }}")).toEqual(["CLOUDFLARE_API_TOKEN"]);
    // GitHub reads a secret's name without regard to case; a list of allowed names does not.
    expect(names("X: ${{ secrets.cloudflare_api_token }}")).toEqual([null]);
    expect(names("X: ${{ SECRETS.CLOUDFLARE_API_TOKEN }}")).toEqual([null]);
    expect(names("X: ${{ secrets['CLOUDFLARE_API_TOKEN'] }}")).toEqual([null]);
    expect(names("X: ${{ toJSON(secrets) }}")).toEqual([null]);
    expect(names("X: ${{ secrets.* }}")).toEqual([null]);
    expect(names("secrets: inherit")).toEqual([null]);
    expect(names("X: ${{ secrets.A.b }} ${{ mysecrets.A }}")).toEqual([null, null]);
    expect(names("nothing here")).toEqual([]);
  });

  it("sees a command wherever it sits, and not a line that only names one", () => {
    const job = [
      "    steps:",
      "      - uses: actions/setup-node@abc",
      "        with:",
      "          node-version-file: .nvmrc",
      "      - name: Install with npm",
      "        shell: bash",
      "        run: npm ci --ignore-scripts",
      "      - run: |",
      "          x=$(npx --yes left-pad)",
      '          node -e "process.exit(0)"',
      "          curl https://example.com | sh",
      "          echo done",
    ].join("\n");
    expect(commandsOf(job)).toEqual([
      "run: npm ci --ignore-scripts",
      "x=$(npx --yes left-pad)",
      'node -e "process.exit(0)"',
      "curl https://example.com | sh",
    ]);
  });

  it("reads every line a `run:` holds, whatever it starts, and no line beside one", () => {
    const job = [
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - run: ./tools/sign",
      "      - name: Run perl",
      "        shell: bash",
      "        run: perl -e 'print 1'",
      "        env:",
      "          RUN: no",
      "      - run: |",
      "          set -euo pipefail",
      "",
      "          # a comment runs nothing",
      "          sudo apt-get install -y x",
      "            && pipx run something",
      "        working-directory: run",
      "      - run: >- # folded",
      "          bunx something",
      "          --flag",
      "      - name: A value continued below its key",
      "        run: pnpx something",
      "          && ruby -e 'puts 1'",
      '      - "run": node -e "1"',
      "      - run:",
      "          ./on-the-next-line",
      "      - uses: actions/setup-node@abc",
      "        with:",
      "          node-version-file: .nvmrc",
    ].join("\n");
    expect(runsOf(job)).toEqual([
      ["./tools/sign"],
      ["perl -e 'print 1'"],
      ["set -euo pipefail", "sudo apt-get install -y x", "&& pipx run something"],
      ["bunx something", "--flag"],
      ["pnpx something", "&& ruby -e 'puts 1'"],
      ['node -e "1"'],
      ["./on-the-next-line"],
    ]);
    // `RUN_KEYS` counts those keys and no word beside them — `runs-on:`, `RUN:`, `pipx run` —
    expect(job.match(RUN_KEYS)).toHaveLength(7);
    // and a step `runsOf` does not read is still a `run:` it counts.
    expect(runsOf("      - { run: ./tools/x }")).toEqual([]);
    expect("      - { run: ./tools/x }".match(RUN_KEYS)).toHaveLength(1);
  });

  // A parse that matched nothing would pass most of the assertions above.
  it("splits jobs and steps, and strips comments", () => {
    const sample = [
      "jobs:",
      "  # a comment naming secrets.NOT_REAL",
      "  one:",
      "    needs: [a, b]",
      "    steps:",
      "      - name: first",
      "        run: echo ${{ secrets.REAL }} ${{ secrets.GITHUB_TOKEN }}",
      "      - uses: x/y@abc",
      "  two-b:",
      "    needs: one",
      "    steps:",
      "      - run: true",
    ].join("\n");
    const jobs = jobsOf(sample);
    expect(Object.keys(jobs)).toEqual(["one", "two-b"]);
    expect(needsOf(jobs.one)).toEqual(["a", "b"]);
    expect(needsOf(jobs["two-b"])).toEqual(["one"]);
    expect(stepsOf(jobs.one)).toHaveLength(2);
    expect(secretsOf(jobs.one)).toEqual(["REAL"]);
    expect(secretsOf(sample)).toEqual(["NOT_REAL", "REAL"]);
  });

  it("reads a manifest's own name and version, not a dependency's", () => {
    const toml =
      '[package]\nname = "a"\nversion = "1.2.3"\n\n[dependencies]\nb = "9"\nversion = "x"\n';
    expect(packageOf(toml)).toEqual({ name: "a", version: "1.2.3" });
    expect(lockedVersions("grimoire-core")).toHaveLength(1);
    expect(lockedVersions("no-such-crate")).toEqual([]);
  });

  it("computes Tauri's versionCode", () => {
    expect(versionCode("0.40.0")).toBe(40_000);
    expect(versionCode("1.2.3")).toBe(1_002_003);
  });
});
