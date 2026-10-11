// The fast Rust build for development, and only for it — opt-in, one command at a time.
//
//   pnpm tauri:fast dev                       # `pnpm tauri dev`, built the fast way
//   pnpm cargo:fast test -p grimoire-core     # any dev-profile cargo command
//
// **What it is**: a second, nightly toolchain and the two settings in `.cargo/fast.toml` —
// rustc's parallel front end, and `rust-lld` in place of `link.exe`. That file has what each
// one measured, and what was measured and left out.
//
// **Why a script and not a line in `.cargo/config.toml`.** The front end's flag is nightly-only,
// and the pinned toolchain does not skip a setting it cannot use, it stops: measured 2026-10-11
// on 1.98.1, `-Zthreads` in `build.rustflags` is `the option `Z` is only accepted on the nightly
// compiler` from every cargo command, `pnpm verify`'s and CI's included. The linker is stable,
// but cargo sets one per target and not per profile, so in that file it would link the release
// too. So both sit in a file cargo does not read by itself, and this script is the only thing
// that hands it over, with the toolchain that understands it. Nothing here reaches
// `pnpm verify`, CI or a release: those build with `rust-toolchain.toml`'s pin and the
// platform's own linker, as they always have.
//
// **What it costs.** A second toolchain's artifacts beside the first's: nothing one compiler
// built is of use to another, so a checkout that runs both `pnpm verify` and this keeps two sets
// of dependencies in one build tree (3.4 GB for the desktop app, measured that day). And a
// different compiler: a test that passes here has not passed the gate.
//
// The toolchain is installed on first use. The pure halves — the refusal and the two argument
// lists — are what `rust-fast.test.mjs` holds.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The nightly the fast build uses. **Dated, never `nightly`**, for `rust-toolchain.toml`'s
 * reason: a floating channel is a different compiler after every `rustup update`, and a nightly
 * is allowed to break. Moving it is an edit here and one cold build.
 */
export const NIGHTLY = "nightly-2026-10-11";
/** The settings, from the repository root. Cargo reads `.cargo/config.toml` there and not this. */
export const CONFIG_PATH = ".cargo/fast.toml";

const USAGE = "usage: node scripts/rust-fast.mjs <cargo|tauri> <arguments>";

/** The arguments in the runs a bare `--` divides them into: the tool's own, then what it hands on. */
function runs(args) {
  const out = [[]];
  for (const arg of args) {
    if (arg === "--") out.push([]);
    else out.at(-1).push(arg);
  }
  return out;
}

/** Whether a cargo argument names a profile other than the one a bare command builds. */
const namesProfile = (arg) =>
  arg === "--release" || arg === "-r" || arg === "--profile" || arg.startsWith("--profile=");

/**
 * Why this command is not run, in one sentence, or `null` when it is.
 *
 * **A release build is refused, and so is every profile that is named.** The file's linker and
 * the nightly would reach any profile, and a release binary built that way is not the one CI
 * builds from the same commit.
 */
export function refusal(tool, args) {
  if (tool !== "cargo" && tool !== "tauri") return USAGE;
  const [mine, handed = []] = runs(args);
  let named;
  if (tool === "tauri") {
    if (mine[0] !== "dev") {
      return "The fast build is `tauri dev` only: `pnpm tauri:fast dev`. Everything else is `pnpm tauri`, on the pinned toolchain.";
    }
    // `-r` is the CLI's `--runner`, and a profile only in what it hands to cargo after `--`.
    named = mine.find((arg) => arg === "--release") ?? handed.find(namesProfile);
  } else {
    if (mine[0]?.startsWith("+")) {
      return `The fast build names its own toolchain (${NIGHTLY}): leave \`${mine[0]}\` out, or use plain \`cargo\`.`;
    }
    named = mine.find(namesProfile);
  }
  if (named !== undefined) {
    return `The fast build is for the dev profile only, and \`${named}\` names another. Use the pinned toolchain for it.`;
  }
  return null;
}

/** `cargo`'s arguments with the settings handed over: `--config` is cargo's own, before any subcommand. */
export function cargoArgs(args, config) {
  return ["--config", config, ...args];
}

/**
 * `tauri dev`'s arguments with the settings handed to the cargo it runs. The CLI passes what
 * follows the first `--` to cargo and what follows a second to the app, so the pair goes
 * directly after the first — which is added when the command has none.
 */
export function tauriArgs(args, config) {
  const at = args.indexOf("--");
  if (at === -1) return [...args, "--", "--config", config];
  return [...args.slice(0, at + 1), "--config", config, ...args.slice(at + 1)];
}

/**
 * Whether `rustup toolchain list` printed the nightly. A line is the toolchain's name and the
 * host's triple, so the name and its hyphen are the match: `nightly-2026-10-11-x86_64-…`, and
 * not a longer date that a bare prefix would also find.
 */
export function hasToolchain(list) {
  return String(list)
    .split(/\r?\n/)
    .some((line) => line.startsWith(`${NIGHTLY}-`));
}

function ensureToolchain() {
  const listed = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8" });
  if (listed.error) {
    console.error(
      "rust-fast: `rustup` was not found; the fast build needs it to install a nightly.",
    );
    return false;
  }
  if (hasToolchain(listed.stdout)) return true;
  // Installed here rather than left to cargo. **rustup installs a toolchain the moment a command
  // names one it does not have, and whole** — measured 2026-10-11, `rustup component list
  // --toolchain nightly` on a machine without one downloaded 1.35 GB, documentation included.
  // The fast build needs the compiler and cargo, which is the small profile.
  console.error(`rust-fast: installing ${NIGHTLY} — once for this machine.`);
  const install = spawnSync(
    "rustup",
    ["toolchain", "install", NIGHTLY, "--profile", "minimal", "--no-self-update"],
    { stdio: "inherit" },
  );
  return install.status === 0;
}

function main() {
  const [tool, ...args] = process.argv.slice(2);
  const refused = refusal(tool, args);
  if (refused !== null) {
    console.error(refused);
    process.exitCode = 2;
    return;
  }
  if (!ensureToolchain()) {
    process.exitCode = 1;
    return;
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const config = join(root, ...CONFIG_PATH.split("/"));
  // `RUSTUP_TOOLCHAIN` outranks `rust-toolchain.toml`, for this command and the cargo it starts.
  const env = { ...process.env, RUSTUP_TOOLCHAIN: NIGHTLY };
  const child =
    tool === "cargo"
      ? spawn("cargo", cargoArgs(args, config), { stdio: "inherit", env })
      : // The CLI's own entry, run where `pnpm tauri` runs it. Not `tauri` off the PATH: on
        // Windows that is a `.cmd`, which Node starts only through a shell.
        spawn(
          process.execPath,
          [
            createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js"),
            ...tauriArgs(args, config),
          ],
          { stdio: "inherit", env, cwd: join(root, "apps", "desktop") },
        );
  child.on("error", (error) => {
    console.error(`rust-fast: could not start ${tool}: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
