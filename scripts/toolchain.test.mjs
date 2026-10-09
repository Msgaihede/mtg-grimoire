// The toolchain pins, held to the workflows that must read them. A pin nobody reads is a comment:
// `rust-toolchain.toml` says 1.98.1 and a workflow that still installs `dtolnay/rust-toolchain@stable`
// builds with whatever stable is current — which is the drift the pin exists to stop, and the one
// place it would go unnoticed is `release.yml`, whose binaries nobody lints.
import { describe, expect, it } from "vitest";
import toolchainToml from "../rust-toolchain.toml?raw";
import rustAction from "../.github/actions/rust-toolchain/action.yml?raw";
import nvmrc from "../.nvmrc?raw";
import packageJson from "../package.json?raw";
import workspaceYaml from "../pnpm-workspace.yaml?raw";

// Every workflow, so a new one is held to the same rules the day it lands.
const WORKFLOWS = import.meta.glob("/.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("rust-toolchain.toml", () => {
  it("pins an exact release, never a channel name", () => {
    const channel = /^channel = "([^"]+)"$/m.exec(toolchainToml)?.[1];
    expect(channel).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The composite action parses the file with `sed`; this is the shape that `sed` expects.
  it("is the shape the composite action reads", () => {
    expect(rustAction).toContain(
      `sed -n 's/^channel *= *"\\([^"]*\\)".*$/\\1/p' rust-toolchain.toml`,
    );
    expect(rustAction).toContain("toolchain: ${{ steps.read.outputs.channel }}");
  });
});

describe("every workflow", () => {
  const entries = Object.entries(WORKFLOWS);

  it("is found", () => {
    expect(entries.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/.github/workflows/ci.yml",
        "/.github/workflows/release.yml",
        "/.github/workflows/scanner-bundle.yml",
      ]),
    );
  });

  it.each(entries)("%s installs Rust only through the pinned action", (_path, src) => {
    expect(src).not.toMatch(/dtolnay\/rust-toolchain/);
    expect(src).not.toMatch(/rustup (?:default|toolchain install|update)/);
  });

  it.each(entries)("%s takes Node from .nvmrc", (_path, src) => {
    expect(src).not.toMatch(/node-version:/);
    const setups = src.match(/uses: actions\/setup-node@/g)?.length ?? 0;
    const pinned = src.match(/node-version-file: \.nvmrc/g)?.length ?? 0;
    expect(pinned).toBe(setups);
  });

  // pnpm comes from the action, at the version `package.json` pins, and before Node:
  // `setup-node` asks pnpm where its store is in order to cache it.
  const installsOf = (src) => src.match(/^\s+- run: pnpm install --frozen-lockfile$/gm)?.length ?? 0;

  it.each(entries)("%s sets pnpm up, pinned, before Node, wherever it installs", (_path, src) => {
    const text = src.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const installs = installsOf(text);
    expect(text.match(/uses: pnpm\/action-setup@[0-9a-f]{40} # v\d/g)?.length ?? 0).toBe(installs);
    expect(text.match(/^\s+cache: pnpm$/gm)?.length ?? 0).toBe(installs);
    // No `with:` under it: the version is `packageManager`'s, and one typed here is a second pin.
    expect(text).not.toMatch(/pnpm\/action-setup@[^\n]*\n\s+with:/);
    expect(text).not.toMatch(/\bcache: npm\b|\bnpm ci(?! --ignore-scripts)/);
    // The pair, adjacent and in this order, once for every install: pnpm's step, a blank line,
    // then Node's step asking for pnpm's cache.
    const pairs =
      text.match(
        /uses: pnpm\/action-setup@[0-9a-f]{40} # v[\d.]+\n\s*\n\s+- uses: actions\/setup-node@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+node-version-file: \.nvmrc\n\s+cache: pnpm\n/g,
      )?.length ?? 0;
    expect(pairs).toBe(installs);
  });

  // Guards the count above: a workflow that stopped installing would pass a comparison of zeros.
  it("finds the eight installs", () => {
    expect(installsOf(WORKFLOWS["/.github/workflows/ci.yml"])).toBe(4);
    expect(installsOf(WORKFLOWS["/.github/workflows/release.yml"])).toBe(3);
    expect(installsOf(WORKFLOWS["/.github/workflows/android-emulator.yml"])).toBe(1);
  });

  // **A third pin, and the one with no file of its own**: the `wasm-bindgen` CLI has to be the
  // very version of the `wasm-bindgen` crate the module was compiled against — the CLI refuses a
  // module whose schema it does not know — and that version is whatever `Cargo.lock` resolves. So
  // a workflow reads it from the lock, in a shell variable; a number typed beside `--version` is
  // right until the day the crate moves, and then the job is red for a reason its diff does not
  // show. `--locked` because every cargo call here carries it.
  const installs = (src) =>
    src.split("\n").filter((line) => !/^\s*#/.test(line) && /\bwasm-bindgen-cli\b/.test(line));

  it.each(entries)("%s installs wasm-bindgen-cli only at the lockfile's version", (_path, src) => {
    for (const line of installs(src)) {
      expect(line).toMatch(/\bcargo install wasm-bindgen-cli --version "\$[a-z_]+" --locked\b/);
    }
  });

  // Guards the filter above: a job that stopped installing the CLI, or spelled it another way,
  // would pass a loop over nothing.
  it("finds the web job's install", () => {
    expect(installs(WORKFLOWS["/.github/workflows/ci.yml"])).toHaveLength(1);
  });
});

describe(".nvmrc", () => {
  it("is a bare major at or above package.json's engines floor", () => {
    const major = Number(nvmrc.trim());
    expect(nvmrc.trim()).toMatch(/^\d+$/);
    const floor = /^>=(\d+)/.exec(JSON.parse(packageJson).engines?.node ?? "")?.[1];
    expect(floor).toBeDefined();
    expect(major).toBeGreaterThanOrEqual(Number(floor));
  });
});

describe("pnpm", () => {
  it("is pinned in package.json, to a version and the hash of its tarball", () => {
    // Corepack and the setup action both read this field; the hash is what makes the pin a pin.
    expect(JSON.parse(packageJson).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });

  // Two settings decide what a command does on a tree that is behind, and each has its
  // measurement in the file's own comment. A setting nothing holds is one a tidy-up deletes, and
  // the docs go on describing it. This is the whole list of the file's one-line settings, so a
  // third is added here on purpose.
  it("reads the lockfile on every install, and refuses to run on a tree a manifest has moved past", () => {
    const settings = workspaceYaml.split("\n").filter((line) => /^[A-Za-z]+: \S/.test(line));
    expect(settings).toEqual(["optimisticRepeatInstall: false", "verifyDepsBeforeRun: error"]);
  });
});
