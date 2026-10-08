/**
 * The fake's command table against the real one.
 *
 * `db.ts` is a hand-written second backend, and until this file nothing held it to the first:
 * a command added to `generate_handler!` with no fake handler was found only when a story
 * reached it and `core.ts` threw `No fake handler registered` at runtime — or never, when the
 * caller swallowed the rejection. This reads the Rust list as text and compares names, in both
 * directions, so the drift is a red build on the PR that caused it.
 *
 * It checks **names only**. Argument names and payload shapes are `ipc.ts`'s mirror and
 * `ipc.test.ts`'s business; a handler that exists and answers wrongly is still a story's to
 * catch.
 */
import { describe, expect, it } from "vitest";
import desktopRs from "../../apps/desktop/src-tauri/src/desktop.rs?raw";
import { allHandlers, makeDb } from "./db";

/**
 * Rust commands the fake deliberately does not answer, each with its reason. **The list is held
 * exact** — an entry the fake has since grown a handler for, or that Rust no longer registers,
 * fails below — so it cannot quietly become a place commands go to be forgotten.
 */
const ABSENT: Record<string, string> = {
  // The live socket. Nothing in the fake answers it by default, so `useDeviceSyncLive`'s seed
  // rejects and a story drives the state with `emitFake("sync:live", …)` — see
  // `SyncPanel.stories.tsx`'s `SocketDropsAfterASync`.
  sync_live_state: "the live socket is driven by `sync:live` events in stories",
  // Asked by `DesktopBoot` before `App` mounts. Storybook renders `App` and the boot screen
  // directly, so nothing in a story ever reaches this command.
  startup_status: "stories render past the desktop boot gate",
};

/** Commands a plugin registers rather than `generate_handler!`; Tauri names them `plugin:…|…`. */
const PLUGIN = /^plugin:[a-z-]+\|[a-z_]+$/;

/**
 * Every name `generate_handler!` registers. **The macro names a command after the last path
 * segment**, so `share::commands::share_list` is `share_list`. Line comments are stripped
 * first, because the list carries paragraphs of them and they are full of `::` and commas.
 */
function rustCommands(src: string): string[] {
  const block = /generate_handler!\[([\s\S]*?)\]\)/.exec(src)?.[1];
  if (block === undefined) throw new Error("no `generate_handler![…]` found in desktop.rs");
  return block
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((path) => path.split("::").pop() ?? path);
}

describe("the fake's command table", () => {
  const rust = rustCommands(desktopRs);
  const fake = Object.keys(allHandlers(makeDb()));

  // Guards the parser: a regex that matched nothing, or matched a comment, would pass every
  // assertion below vacuously.
  it("reads a plausible command list out of desktop.rs", () => {
    expect(rust.length).toBeGreaterThan(200);
    expect(rust.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name))).toEqual([]);
    expect(new Set(rust).size).toBe(rust.length);
    expect(rust).toContain("search_cards");
    expect(rust).toContain("share_list");
    expect(rust).toContain("window_count");
  });

  it("answers every command `generate_handler!` registers", () => {
    const missing = rust.filter((name) => !fake.includes(name) && !(name in ABSENT));
    expect(
      missing,
      "add a handler to `packages/fake/db.ts`, or an ABSENT entry with its reason",
    ).toEqual([]);
  });

  it("answers nothing Rust does not register, plugins aside", () => {
    const stale = fake.filter((name) => !rust.includes(name) && !PLUGIN.test(name));
    expect(stale, "a fake handler for a command the app no longer has").toEqual([]);
  });

  it("keeps ABSENT exact", () => {
    const answered = Object.keys(ABSENT).filter((name) => fake.includes(name));
    const unregistered = Object.keys(ABSENT).filter((name) => !rust.includes(name));
    expect(answered, "the fake answers these now; drop them from ABSENT").toEqual([]);
    expect(unregistered, "Rust no longer registers these; drop them from ABSENT").toEqual([]);
  });
});
