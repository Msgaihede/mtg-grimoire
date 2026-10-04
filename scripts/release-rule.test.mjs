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
import releaseYml from "../.github/workflows/release.yml?raw";
import ciYml from "../.github/workflows/ci.yml?raw";

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

const ANDROID_SECRETS = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];
const CLOUDFLARE_SECRETS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
const ON_A_RELEASE = "    if: needs.release-please.outputs.release_created == 'true'";

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

  it("gives the signing key to `android-sign` and the deploy token to `web-deploy`, alone", () => {
    const holders = Object.fromEntries(
      Object.entries(jobs)
        .map(([name, job]) => [name, secretsOf(job)])
        .filter(([, secrets]) => secrets.length > 0),
    );
    expect(holders).toEqual({
      "android-sign": ANDROID_SECRETS,
      "web-deploy": CLOUDFLARE_SECRETS,
    });
  });

  // The rule the removed `sign` job left behind: a secret never sits in a build leg, because a
  // build leg runs every npm lifecycle script, cargo build script and Gradle plugin, and any of
  // them can read a file or an environment.
  it.each(["android-sign", "web-deploy"])("%s builds nothing", (name) => {
    expect(jobs[name]).not.toMatch(
      /\bnpm (?:ci|install|run|exec)\b|\bcargo\b|\btauri\b|gradle|rust-cache|rust-toolchain|tauri-action|\bcache: npm\b/i,
    );
    const actions = [...jobs[name].matchAll(/uses: ([\w./-]+)@/g)].map((m) => m[1]).sort();
    expect(actions).toEqual(
      name === "android-sign"
        ? ["actions/checkout", "actions/download-artifact"]
        : ["actions/checkout", "actions/download-artifact", "actions/setup-node"],
    );
  });

  it.each([
    ["android-sign", "key", ANDROID_SECRETS, 2],
    ["web-deploy", "token", CLOUDFLARE_SECRETS, 2],
  ])(
    "%s asks first whether its secrets are set, and does nothing without them",
    (name, id, secrets, readers) => {
      const steps = stepsOf(jobs[name]);
      // The first step reads them and answers; it is the only one that runs without them.
      expect(steps[0]).toMatch(new RegExp(`^ {8}id: ${id}$`, "m"));
      expect(secretsOf(steps[0])).toEqual(secrets);
      expect(steps[0]).toContain('echo "present=true" >> "$GITHUB_OUTPUT"');
      expect(steps[0]).toContain('echo "present=false" >> "$GITHUB_OUTPUT"');
      // Some and not all is a mistake in the settings, and a failure — never a quiet skip.
      expect(steps[0]).toMatch(/if \[ "\$found" -gt 0 \]; then[\s\S]*?exit 1/);
      // And it says so where a release's reader looks.
      expect(steps[0]).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
      for (const step of steps.slice(1)) {
        expect(step).toMatch(
          new RegExp(`^ {8}if: steps\\.${id}\\.outputs\\.present == 'true'$`, "m"),
        );
      }
      // The secrets reach the step that asks and the one step that uses them.
      expect(steps.filter((step) => secretsOf(step).length > 0)).toHaveLength(readers);
    },
  );

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
    expect(step("name: web-bundle")).toBeGreaterThan(-1);
    expect(step("wrangler@")).toBeGreaterThan(step("name: web-bundle"));
    expect(step("node scripts/web-deploy-probe.mjs dist-web")).toBeGreaterThan(step("wrangler@"));
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
  it("runs wrangler once: `web-deploy`, an exact version, from app-worker/", () => {
    const wrangler = lines.filter(({ line }) => /\bwrangler\b/.test(line));
    expect(wrangler).toEqual([
      {
        path: "/.github/workflows/release.yml",
        line: expect.stringMatching(/^ {8}run: npx --yes wrangler@\d+\.\d+\.\d+ deploy$/),
      },
    ]);
    const step = stepsOf(jobsOf(releaseYml)["web-deploy"]).find((s) => /\bwrangler\b/.test(s));
    expect(step).toMatch(/^ {8}working-directory: app-worker$/m);
    expect(secretsOf(step)).toEqual(CLOUDFLARE_SECRETS);
  });

  it("names neither of the other two Workers, and no Cloudflare secret anywhere else", () => {
    expect(lines.filter(({ line }) => /\b(?:relay|share-worker)\b/.test(line))).toEqual([]);
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
