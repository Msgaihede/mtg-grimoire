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
//      those jobs may run, and that one job in one workflow deploys one Worker.
//
// Text, like the two fences beside it (`actions-pinned.test.mjs`, `toolchain.test.mjs`): nothing
// here runs a workflow. What a real release proves is docs/reference/ci-and-releases.md's to say.
import { describe, expect, it } from "vitest";
import releaseConfig from "../release-please-config.json?raw";
import releaseManifest from "../.release-please-manifest.json?raw";
import packageJson from "../package.json?raw";
import packageLock from "../package-lock.json?raw";
import workspaceToml from "../Cargo.toml?raw";
import cargoLock from "../Cargo.lock?raw";
import desktopToml from "../src-tauri/Cargo.toml?raw";
import coreToml from "../crates/grimoire-core/Cargo.toml?raw";
import lightToml from "../mobile/src-tauri/Cargo.toml?raw";
import webToml from "../crates/grimoire-web/Cargo.toml?raw";
import desktopConf from "../src-tauri/tauri.conf.json?raw";
import lightConf from "../mobile/src-tauri/tauri.conf.json?raw";
import appGradle from "../mobile/src-tauri/gen/android/app/build.gradle.kts?raw";
import appWorkerPackage from "../app-worker/package.json?raw";
import appWorkerLock from "../app-worker/package-lock.json?raw";
import releaseYml from "../.github/workflows/release.yml?raw";
import ciYml from "../.github/workflows/ci.yml?raw";
import syncSmoke from "./web-sync-smoke.mjs?raw";
import syncHarness from "./web-smoke/sync-harness.mjs?raw";
import syncPull from "./web-sync-pull.mjs?raw";

const WORKFLOWS = import.meta.glob("/.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The cargo workspace's members: where each lives, its manifest, and whether it is a Tauri host. */
const CRATES = [
  { name: "mtg-grimoire", dir: "src-tauri", toml: desktopToml, conf: desktopConf },
  { name: "grimoire-core", dir: "crates/grimoire-core", toml: coreToml, conf: null },
  { name: "grimoire-light", dir: "mobile/src-tauri", toml: lightToml, conf: lightConf },
  { name: "grimoire-web", dir: "crates/grimoire-web", toml: webToml, conf: null },
];

/** A file with its `#` comment lines removed — these files explain themselves in prose. */
const code = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** `[package]`'s `name` and `version`, from a manifest's text. */
function packageOf(toml) {
  const body = toml.slice(toml.indexOf("[package]")).split(/^\[/m)[1] ?? "";
  return {
    name: /^name = "([^"]+)"$/m.exec(body)?.[1],
    version: /^version = "([^"]+)"$/m.exec(body)?.[1],
  };
}

/** Every version the root `Cargo.lock` records for a package name. */
const lockedVersions = (name) =>
  [...cargoLock.matchAll(/^\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/gm)]
    .filter((m) => m[1] === name)
    .map((m) => m[2]);

describe("one version in the tree", () => {
  const version = JSON.parse(packageJson).version;
  const extra = JSON.parse(releaseConfig).packages["."]["extra-files"];
  const names = (file) =>
    extra.some((entry) => Object.keys(file).every((k) => entry[k] === file[k]));

  it("is a plain semantic version, and the one release-please last released", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // The deploy guard finds the last tag here (`scripts/web-deploy-guard.mjs`).
    expect(JSON.parse(releaseManifest)).toEqual({ ".": version });
    const lock = JSON.parse(packageLock);
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
  });

  it("knows every member of the cargo workspace", () => {
    // A fifth member owes a row above, and with it a manifest and a lockfile selector in the
    // config: one the config does not name is not bumped, and ships a version behind the app.
    const members = /^members = \[([^\]]*)\]$/m.exec(workspaceToml)?.[1];
    expect(members).toBeDefined();
    expect(
      members
        .split(",")
        .map((m) => m.trim().replace(/^"|"$/g, ""))
        .sort(),
    ).toEqual(CRATES.map((crate) => crate.dir).sort());
  });

  it.each(CRATES)("$name wears it, in its manifest and in the lockfile", ({ name, toml }) => {
    expect(packageOf(toml)).toEqual({ name, version });
    expect(lockedVersions(name)).toEqual([version]);
  });

  it.each(CRATES.filter((crate) => crate.conf !== null))(
    "$name's tauri.conf.json wears it",
    ({ conf }) => {
      expect(JSON.parse(conf).version).toBe(version);
    },
  );

  it.each(CRATES)(
    "release-please bumps $name's manifest and its lockfile entry",
    ({ name, dir }) => {
      expect(
        names({ type: "toml", path: `${dir}/Cargo.toml`, jsonpath: "$.package.version" }),
      ).toBe(true);
      // `@.name.value`, never `@.name`: release-please parses TOML into tagged nodes, and the bare
      // form matches nothing — as a warning, not an error.
      expect(
        names({
          type: "toml",
          path: "Cargo.lock",
          jsonpath: `$.package[?(@.name.value=='${name}')].version`,
        }),
      ).toBe(true);
    },
  );

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
    expect(extra).toHaveLength(CRATES.length * 2 + tauriHosts);
  });
});

/**
 * Tauri's own arithmetic for an Android `versionCode`, when the config names none
 * (`bundle.android.versionCode`'s description in `@tauri-apps/cli`'s `config.schema.json`).
 * The CLI writes the result to the generated `tauri.properties`, which Gradle reads.
 */
const versionCode = (version) => {
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
function jobsOf(src) {
  const body = src.slice(src.search(/^jobs:/m));
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):[ \t]*$/gm)];
  return Object.fromEntries(
    starts.map((m, i) => [m[1], code(body.slice(m.index, starts[i + 1]?.index ?? body.length))]),
  );
}

/** A job's steps, each from its `- ` to the next. */
const stepsOf = (job) =>
  job
    .slice(job.search(/^ {4}steps:/m))
    .split(/^ {6}- /m)
    .slice(1);

/** `needs:` as a list, whether written `needs: a` or `needs: [a, b]`. */
const needsOf = (job) =>
  (/^ {4}needs: \[?([^\]\n]*)\]?$/m.exec(job)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Every secret a piece of workflow text reads, `GITHUB_TOKEN` aside. */
const secretsOf = (text) =>
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
const secretRefs = (text) =>
  [...text.matchAll(/secrets/gi)].map((m) => {
    const exact = /^secrets\.([A-Z][A-Z0-9_]*)(?![\w.[*])/.exec(text.slice(m.index));
    const alone = !/[\w.]/.test(text[m.index - 1] ?? " ");
    return {
      seen: text.slice(Math.max(0, m.index - 10), m.index + 44).replace(/\s+/g, " "),
      name: exact && alone ? exact[1] : null,
    };
  });

/**
 * What can run a program, as a word on a line: package runners, interpreters, build tools,
 * downloaders, `gh`. Lines that only *name* one — an action, the shell, the Node pin — are not
 * commands. (No `tauri`: its CLI is only ever reached through `npx`, `npm` or `cargo`, and the
 * word is in every path under `mobile/src-tauri/`.)
 */
const RUNS_SOMETHING =
  /\b(?:npx|npm|pnpm|yarn|bun|deno|node|cargo|rustc|gradle\w*|python\d*|pip\d*|curl|wget|bash|sh|pwsh|docker|gh|make)\b/;
const commandsOf = (job) =>
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
/** Every secret each job may read, and it must read exactly these. */
const MAY_READ = {
  "release-please": ["GITHUB_TOKEN"],
  build: ["GITHUB_TOKEN"],
  android: [],
  "android-sign": [...ANDROID_SECRETS, "GITHUB_TOKEN"],
  web: [],
  "web-deploy": [...CLOUDFLARE_SECRETS, "GITHUB_TOKEN"],
  publish: ["GITHUB_TOKEN"],
};
const ON_A_RELEASE = "    if: needs.release-please.outputs.release_created == 'true'";
/** The committed fingerprint of the certificate every release's APK is signed with. */
const SIGNER_PIN = "mobile/src-tauri/release-signer.sha256";

describe("release.yml", () => {
  const jobs = jobsOf(releaseYml);

  it("has the seven jobs, chained as the rule needs", () => {
    expect(Object.keys(jobs)).toEqual([
      "release-please",
      "build",
      "android",
      "android-sign",
      "web",
      "web-deploy",
      "publish",
    ]);
    expect(needsOf(jobs.build)).toEqual(["release-please"]);
    expect(needsOf(jobs.android)).toEqual(["release-please"]);
    expect(needsOf(jobs["android-sign"])).toEqual(["release-please", "android"]);
    expect(needsOf(jobs.web)).toEqual(["release-please"]);
    // The deploy is live the moment it returns, so it goes after everything that can still fail.
    expect(needsOf(jobs["web-deploy"])).toEqual(["release-please", "build", "android-sign", "web"]);
    expect(needsOf(jobs.publish)).toEqual([
      "release-please",
      "build",
      "android-sign",
      "web-deploy",
    ]);
  });

  it("runs every job after release-please on a release, and on nothing looser", () => {
    // No `always()`, `failure()` or `!cancelled()`: without a status function a job runs only
    // when every job it needs succeeded, which is the whole of "publish waits for all three".
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "release-please") continue;
      const conditions = job.split("\n").filter((line) => /^ {4}if:/.test(line));
      expect(conditions, name).toEqual([ON_A_RELEASE]);
    }
    expect(code(releaseYml)).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|continue-on-error/);
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

  it("gives the signing key to `android-sign` and the deploy token to `web-deploy`, alone", () => {
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
  it("takes what it holds from the `release` environment, in those two jobs and no other", () => {
    const environments = Object.entries(jobs)
      .map(([name, job]) => [name, job.split("\n").filter((line) => /^\s*environment:/.test(line))])
      .filter(([, lines]) => lines.length > 0);
    expect(environments).toEqual([
      ["android-sign", ["    environment: release"]],
      ["web-deploy", ["    environment: release"]],
    ]);
  });

  it.each(["android", "android-sign", "web", "web-deploy"])("%s has a deadline", (name) => {
    expect(jobs[name]).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  // The rule the removed `sign` job left behind: a secret never sits in a build leg, because a
  // build leg runs every npm lifecycle script, cargo build script and Gradle plugin, and any of
  // them can read a file or an environment. **Held as a list of everything the job may run**,
  // to the letter: a second `npx`, a `node -e`, an `npm run`, a `curl | sh` is a line that is
  // not on it.
  it.each([
    [
      "android-sign",
      ["actions/checkout", "actions/download-artifact"],
      [
        'bash scripts/android-sign.sh apk-in/mtg-grimoire-light-arm64.apk "$apk"',
        'gh release upload "${{ needs.release-please.outputs.tag_name }}" \\',
      ],
    ],
    [
      "web-deploy",
      ["actions/checkout", "actions/download-artifact", "actions/setup-node"],
      [
        'latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name)',
        // The lockfile's packages, no lifecycle script; then what that installed, or nothing.
        "run: npm ci --ignore-scripts",
        "run: npx --no-install wrangler deploy",
        "run: node scripts/web-deploy-probe.mjs dist-web",
      ],
    ],
  ])("%s builds nothing, and runs only what is listed here", (name, actions, commands) => {
    expect([...jobs[name].matchAll(/uses: ([\w./-]+)@/g)].map((m) => m[1]).sort()).toEqual(actions);
    expect(commandsOf(jobs[name])).toEqual(commands);
    expect(jobs[name]).not.toMatch(/rust-cache|rust-toolchain|tauri-action|\bcache:/);
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

  // "Signed by the keystore in the settings" is not "signed by the key the last release was".
  it("attaches no APK without the committed fingerprint, and holds the key to it", () => {
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

  it("attaches the APK the signing script wrote, under the release's name", () => {
    const sign = jobs["android-sign"];
    expect(sign).toContain('apk="mtg-grimoire-$VERSION-android-arm64.apk"');
    expect(sign).toMatch(
      /bash scripts\/android-sign\.sh apk-in\/mtg-grimoire-light-arm64\.apk "\$apk"/,
    );
    expect(sign).toMatch(/gh release upload [^\n]*\\\n\s+"\$SIGNED_APK" --clobber/);
    // The keystore is decoded outside the checkout and removed however the step ends.
    expect(sign).toContain('export ANDROID_KEYSTORE="$RUNNER_TEMP/release.keystore"');
    expect(sign).toContain(`trap 'rm -f "$ANDROID_KEYSTORE"' EXIT`);
    // What it signs is what `android` built, and nothing else is ever uploaded to the release.
    expect(jobs.android).toContain("name: android-apk-debug-signed");
    expect(sign).toContain("name: android-apk-debug-signed");
    expect(jobs.android).not.toMatch(/gh release/);
  });

  it("builds the APK and the web app as `ci.yml` does", () => {
    // The two build legs are copies of jobs that run green on every pull request; a command
    // that differs is one no pull request has run.
    for (const command of [
      "npx tauri android build --apk --target aarch64 --ci",
      "key: android-aarch64",
    ]) {
      expect(jobs.android, command).toContain(command);
      expect(ciYml, command).toContain(command);
    }
    for (const command of [
      "sudo apt-get update && sudo apt-get install -y clang",
      'cargo install wasm-bindgen-cli --version "$bindgen" --locked',
      "run: npm run web:wasm",
      "run: npm run web:build",
      "run: npm run web:smoke",
      "key: web-wasm32",
    ]) {
      expect(jobs.web, command).toContain(command);
      expect(ciYml, command).toContain(command);
    }
    // And the signing a release runs is the signing a pull request proved.
    expect(ciYml).toMatch(/^\s+bash scripts\/android-sign\.sh /m);
  });

  it("deploys the bundle `web` built and opened in a browser, then asks the host", () => {
    const web = stepsOf(jobs.web);
    const at = (needle) => web.findIndex((step) => step.includes(needle));
    expect(at("npm run web:smoke")).toBeGreaterThan(at("npm run web:build"));
    expect(at("name: web-bundle")).toBeGreaterThan(at("npm run web:smoke"));

    const deploy = stepsOf(jobs["web-deploy"]);
    const step = (needle) => deploy.findIndex((s) => s.includes(needle));
    const order = [
      // Before anything is downloaded or installed: is this tag older than what is published?
      'gh api "repos/$REPO/releases/latest"',
      "name: web-bundle",
      "run: npm ci --ignore-scripts",
      "run: npx --no-install wrangler deploy",
      "run: node scripts/web-deploy-probe.mjs dist-web",
    ].map(step);
    expect(order[0]).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  // A re-run of this job long after its run would upload this tag's bundle over a later
  // release's: an older user schema in front of desktops that have moved on.
  it("refuses to deploy a release older than the newest published one", () => {
    const refusal = stepsOf(jobs["web-deploy"]).find((s) => s.includes("releases/latest"));
    expect(refusal).toMatch(
      /newest=\$\(printf '%s\\n%s\\n' "\$latest" "\$TAG" \| sort -V \| tail -1\)/,
    );
    expect(refusal).toMatch(/if \[ "\$newest" != "\$TAG" \]; then[\s\S]*exit 1/);
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

  // **The one job that may deploy anything, and the one Worker it may deploy.** The relay holds
  // secrets and a D1 with real entitlements, and the share Worker a D1 and R2 of its own; their
  // deploys stay by hand (root CLAUDE.md, "Deployments").
  it("runs wrangler once: `web-deploy`, the lockfile's, from app-worker/", () => {
    const wrangler = lines.filter(({ line }) => /\bwrangler\b/.test(line));
    expect(wrangler).toEqual([
      {
        // Not a run of it: the name of the `web` job's step that *installs* the same lockfile,
        // for the sync smoke (phase 6, step 6.3). No workflow line there starts wrangler; the
        // script does, and the test below holds what it may ask of it.
        path: "/.github/workflows/ci.yml",
        line: "      - name: Install wrangler from app-worker's lockfile",
      },
      {
        path: "/.github/workflows/release.yml",
        // `--no-install`: what the lockfile's install put there, or a failure. Never a
        // version typed here, which `npx` would resolve — with everything under it — on the day.
        line: "        run: npx --no-install wrangler deploy",
      },
    ]);
    const steps = stepsOf(jobsOf(releaseYml)["web-deploy"]);
    const at = steps.findIndex((s) => /\bwrangler\b/.test(s));
    expect(steps[at]).toMatch(/^ {8}working-directory: app-worker$/m);
    expect(secretsOf(steps[at])).toEqual(CLOUDFLARE_SECRETS);
    // The install is the step before it, in the same directory, and **nothing is in its
    // environment**: what it installs is not run until the token's step, and it runs no script.
    expect(steps[at - 1]).toMatch(/^ {8}run: npm ci --ignore-scripts$/m);
    expect(steps[at - 1]).toMatch(/^ {8}working-directory: app-worker$/m);
    expect(steps[at - 1]).not.toMatch(/^ {8}env:/m);
    expect(secretRefs(steps[at - 1])).toEqual([]);
  });

  // **What "pinned" means here: a lockfile.** `npx wrangler@4.146.0` pinned one package of
  // ninety-one; the rest came through floating ranges, resolved on the day of the deploy.
  it("pins wrangler and everything under it in app-worker's lockfile", () => {
    const manifest = JSON.parse(appWorkerPackage);
    const lock = JSON.parse(appWorkerLock);
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
    const others = Object.entries(lock.packages).filter(([path]) => path !== "");
    expect(others.length).toBeGreaterThan(20);
    // Each one from the registry, with the hash `npm ci` checks the tarball against.
    for (const [path, entry] of others) {
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
    // The runner's platform is in it: `npm ci` on Linux installs these two without a script.
    expect(lock.packages["node_modules/@esbuild/linux-x64"]).toBeDefined();
    expect(lock.packages["node_modules/@cloudflare/workerd-linux-64"]).toBeDefined();
  });

  // **The other place wrangler is installed, and why it is not a deploy** (phase 6, step 6.3):
  // CI's `web` job runs `scripts/web-sync-smoke.mjs`, which starts the *relay's* code under
  // workerd on the runner and pairs two browsers through it. The same lockfile, the same
  // `--ignore-scripts`, no secret — and a script that may ask wrangler for two things, both
  // `--local`. A third subcommand there, or one of these without the flag, is a workflow that
  // can reach the account.
  it("installs wrangler in CI for a run that is local, start to finish", () => {
    const steps = stepsOf(jobsOf(ciYml).web);
    const install = steps.findIndex((s) => /\bwrangler\b/.test(s));
    expect(steps[install]).toMatch(/^ {8}run: npm ci --ignore-scripts --prefix app-worker$/m);
    expect(steps[install]).not.toMatch(/^ {8}env:/m);
    expect(steps[install + 1]).toMatch(/^ {8}run: npm run web:sync-smoke$/m);
    expect(steps[install + 1]).not.toMatch(/^ {8}env:/m);
    expect(secretRefs(code(jobsOf(ciYml).web))).toEqual([]);

    // Every wrangler subcommand the run spawns, as the argv it writes: the word after the
    // script's own path, or after the `d1()` helper's fixed `d1 execute`. **Three files are the
    // run since step 6.5**: the relay is started by `web-smoke/sync-harness.mjs`, for the walk
    // and for `web-sync-pull.mjs` — the measurement of a large pull, which no job runs and
    // which is held to the same two commands all the same. So the spawns are counted across all
    // three, and found in the harness alone.
    const spawned = /\[\s*script,\s*"([a-z0-9]+)",\s*"([^"]+)"/g;
    const starts = [...`${syncSmoke}\n${syncHarness}\n${syncPull}`.matchAll(spawned)];
    expect(starts.map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(["d1 execute", "dev --local"]);
    expect([...syncHarness.matchAll(spawned)]).toHaveLength(2);
    expect(syncHarness).toMatch(/\[\s*script,\s*"d1",\s*"execute",\s*"[\w-]+",\s*"--local",/);
    // Neither run starts a process of its own but one: the measurement asks the system's
    // process table what a tab and workerd weigh.
    const processes = (source) =>
      [...source.matchAll(/\bspawn(?:Sync)?\(\s*([^,\s]+)/g)].map((m) => m[1]);
    expect(processes(syncSmoke)).toEqual([]);
    expect(processes(syncPull)).toEqual(['"powershell.exe"']);
    // And none of the words that reach Cloudflare is an argument anywhere in them.
    const reaching = /["'`](?:deploy|publish|rollback|versions|secret|tail|login|--remote)["'`]/;
    for (const [name, source] of Object.entries({ syncSmoke, syncHarness, syncPull })) {
      expect(source, name).not.toMatch(reaching);
    }
  });

  it("names neither of the other two Workers, and no Cloudflare secret anywhere else", () => {
    // One line names the relay, and it deploys nothing: the sync smoke's step in `ci.yml`,
    // which runs the relay's code on the runner — the test above has what that run may do.
    expect(lines.filter(({ line }) => /\b(?:relay|share-worker)\b/.test(line))).toEqual([
      {
        path: "/.github/workflows/ci.yml",
        line: "      - name: Pair two browsers through the local relay",
      },
    ]);
    const cloudflare = lines.filter(({ line }) => /CLOUDFLARE_|ANDROID_KEY/.test(line));
    // `ci.yml` names the Android variables for the throwaway key it mints itself — never a secret.
    expect([...new Set(cloudflare.map(({ path }) => path))].sort()).toEqual([
      "/.github/workflows/ci.yml",
      "/.github/workflows/release.yml",
    ]);
    expect(secretsOf(code(ciYml))).toEqual([]);
  });

  it("commits no account id: the deploy reads it from a secret", () => {
    const step = stepsOf(jobsOf(releaseYml)["web-deploy"]).find((s) => /\bwrangler\b/.test(s));
    expect(step).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    // A Cloudflare account id is 32 hex characters; an action's pin is 40.
    expect(code(releaseYml)).not.toMatch(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/);
  });
});

describe("the guards' own guards", () => {
  it("sees every spelling of a secret, and names only the honest one", () => {
    const names = (text) => secretRefs(text).map((ref) => ref.name);
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
