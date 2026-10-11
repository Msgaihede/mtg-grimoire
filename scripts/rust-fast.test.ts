// The fast build's fences: what it refuses, what it hands to cargo, and that nothing but its own
// two scripts can reach it. No rustup and no cargo here; `pnpm cargo:fast` is that half's own
// test.
import { describe, expect, it } from "vitest";
import { CONFIG_PATH, NIGHTLY, cargoArgs, hasToolchain, refusal, tauriArgs } from "./rust-fast.ts";
import fastToml from "../.cargo/fast.toml?raw";
import cargoConfig from "../.cargo/config.toml?raw";
import worktreeCargo from "../.claude/hooks/worktree-cargo.toml?raw";
import rootManifest from "../Cargo.toml?raw";
import packageJson from "../package.json?raw";

const WORKFLOWS = import.meta.glob<string>("/.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A file's settings: its lines with the comments taken out. */
const settings = (toml: string): string =>
  toml
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("the nightly", () => {
  it("is a dated one, never the channel", () => {
    expect(NIGHTLY).toMatch(/^nightly-\d{4}-\d{2}-\d{2}$/);
  });

  it("is recognised in rustup's list by its whole name", () => {
    const host = "x86_64-pc-windows-msvc";
    expect(
      hasToolchain(`stable-${host} (default)\n${NIGHTLY}-${host}\n1.98.1-${host} (active)\n`),
    ).toBe(true);
    expect(hasToolchain(`stable-${host} (default)\r\n${NIGHTLY}-${host}\r\n`)).toBe(true);
    // The channel, another date, and a longer date this one is a prefix of.
    expect(hasToolchain(`nightly-${host}\nnightly-2026-04-19-${host}\n${NIGHTLY}0-${host}\n`)).toBe(
      false,
    );
    expect(hasToolchain("")).toBe(false);
  });
});

describe("refusal", () => {
  it.each<[string, string[]]>([
    ["cargo", ["build", "-p", "mtg-grimoire"]],
    ["cargo", ["test", "--workspace"]],
    // What follows cargo's `--` is the test binary's, and none of this script's business.
    ["cargo", ["test", "-p", "grimoire-core", "--", "--release", "-r"]],
    ["tauri", ["dev"]],
    ["tauri", ["dev", "--config", "src-tauri/tauri.light.conf.json"]],
    // `-r` is the CLI's `--runner`, not a profile.
    ["tauri", ["dev", "-r", "cargo"]],
    ["tauri", ["dev", "--", "--features", "x", "--", "--release"]],
  ])("runs `%s %j`", (tool, args) => {
    expect(refusal(tool, args)).toBeNull();
  });

  it.each<[string, string[], string]>([
    ["cargo", ["build", "--release"], "--release"],
    ["cargo", ["build", "-r"], "-r"],
    ["cargo", ["build", "--profile", "wasm"], "--profile"],
    ["cargo", ["build", "--profile=wasm"], "--profile=wasm"],
    ["tauri", ["dev", "--release"], "--release"],
    ["tauri", ["dev", "--", "--release"], "--release"],
    ["tauri", ["dev", "--", "-r"], "-r"],
  ])("refuses `%s %j` for the profile it names", (tool, args, named) => {
    expect(refusal(tool, args)).toContain(`\`${named}\``);
  });

  it("refuses every tauri command but dev", () => {
    expect(refusal("tauri", ["build"])).toMatch(/`tauri dev` only/);
    expect(refusal("tauri", ["android", "dev"])).toMatch(/`tauri dev` only/);
    expect(refusal("tauri", [])).toMatch(/`tauri dev` only/);
  });

  it("refuses a toolchain of the caller's", () => {
    expect(refusal("cargo", ["+stable", "build"])).toContain(NIGHTLY);
  });

  it("refuses a tool it does not know", () => {
    expect(refusal(undefined, [])).toMatch(/^usage:/);
    expect(refusal("rustc", ["--version"])).toMatch(/^usage:/);
  });
});

describe("the settings, handed over", () => {
  it("go before cargo's subcommand", () => {
    expect(cargoArgs(["test", "--workspace", "--", "--nocapture"], "C")).toEqual([
      "--config",
      "C",
      "test",
      "--workspace",
      "--",
      "--nocapture",
    ]);
  });

  it("go to the cargo that `tauri dev` runs, and never to the app", () => {
    expect(tauriArgs(["dev"], "C")).toEqual(["dev", "--", "--config", "C"]);
    expect(tauriArgs(["dev", "--", "--features", "x"], "C")).toEqual([
      "dev",
      "--",
      "--config",
      "C",
      "--features",
      "x",
    ]);
    expect(tauriArgs(["dev", "--", "--", "--flag"], "C")).toEqual([
      "dev",
      "--",
      "--config",
      "C",
      "--",
      "--flag",
    ]);
  });
});

describe(CONFIG_PATH, () => {
  it("is the file this test read", () => {
    expect(CONFIG_PATH).toBe(".cargo/fast.toml");
  });

  // What the refusal rests on: the file changes how a build is made, never which build it is. A
  // profile written here would be one more thing a fast build and the gate's disagree about.
  it("holds the two settings, and no profile", () => {
    const text = settings(fastToml);
    expect(text).toMatch(/^rustflags = \["-Zthreads=\d+"\]$/m);
    expect(text).toMatch(/^\[target\.x86_64-pc-windows-msvc\]\r?\nlinker = "rust-lld"$/m);
    expect(text).not.toMatch(/^\[profile\./m);
  });
});

describe("everything that is not the fast build", () => {
  // The pinned toolchain stops on a nightly flag rather than skipping it, so one in a file cargo
  // reads by itself is every cargo command red, in every checkout the file reaches.
  it.each([
    [".cargo/config.toml", cargoConfig],
    [".claude/hooks/worktree-cargo.toml", worktreeCargo],
    ["Cargo.toml", rootManifest],
  ])("%s holds no nightly-only setting", (_path, toml) => {
    expect(settings(toml)).not.toMatch(/"-Z|^\[unstable\]|^cargo-features|codegen-backend/m);
  });

  // A linker is per target and not per profile: in the file every build reads it would link the
  // release too.
  it("leaves the linker of every other build alone", () => {
    expect(settings(cargoConfig)).not.toMatch(/linker/);
  });

  it("is reached by a script of its own, and by no other", () => {
    const { scripts } = JSON.parse(packageJson) as { scripts: Record<string, string> };
    expect(scripts["cargo:fast"]).toBe("node scripts/rust-fast.ts cargo");
    expect(scripts["tauri:fast"]).toBe("node scripts/rust-fast.ts tauri");
    const others = Object.entries(scripts).filter(([name]) => !name.endsWith(":fast"));
    // Guards the loop: `verify` and `lint:rust` are the two a fast build must never be in.
    expect(others.map(([name]) => name)).toEqual(expect.arrayContaining(["verify", "lint:rust"]));
    for (const [name, command] of others) {
      expect(command, name).not.toMatch(/rust-fast|:fast\b|fast\.toml|nightly/);
    }
  });

  it.each(Object.entries(WORKFLOWS))("%s never builds with it", (_path, src) => {
    expect(src).not.toMatch(/rust-fast|:fast\b|fast\.toml|nightly/);
  });
});
