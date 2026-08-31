import { readFileSync, writeFileSync } from "node:fs";
const ROOT = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src";
function edit(rel, pairs) {
  const p = `${ROOT}/${rel}`;
  let s = readFileSync(p, "utf8");
  for (const [from, to] of pairs) {
    if (!s.includes(from)) throw new Error(`${rel}: NOT FOUND: ${from.slice(0, 90)}`);
    if (s.split(from).length > 2) throw new Error(`${rel}: NOT UNIQUE: ${from.slice(0, 90)}`);
    s = s.replace(from, to);
  }
  writeFileSync(p, s);
  console.log("patched " + rel);
}

// `null` and `undefined` were an unobservable distinction here — both are falsy in the render
// and `selfUpdating` short-circuits on `status` before it ever reads this. Found by a mutation
// that flipped it and killed nothing.
edit("features/settings/UpdatePanel.tsx", [
  [
    `  const elsewhere = status ? ELSEWHERE[status.installKind] : null;`,
    `  const elsewhere = status ? ELSEWHERE[status.installKind] : undefined;`,
  ],
]);

// `useUpdate`'s effect had no test at all — the file covers only its three pure helpers — and
// the web build's whole panel now hangs on that effect running once.
edit("lib/useUpdate.test.ts", [
  [
    `import { describe, expect, it } from "vitest";
import type { UpdateAsset, UpdateStatus } from "@/lib/ipc";
import { formatBytes, formatChecked, nextAction } from "@/lib/useUpdate";`,
    `import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAsset, UpdateStatus } from "@/lib/ipc";
import { formatBytes, formatChecked, nextAction, useUpdate } from "@/lib/useUpdate";

// \`isWebTarget\` reads \`__CORE__\`, a build-time constant vitest fixes at "tauri", so the web
// answer is only reachable by mocking the module — which its own doc says.
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

const backend = vi.hoisted(() => ({
  updateStatus: vi.fn(),
  onUpdateProgress: vi.fn(() => () => {}),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    updateStatus: backend.updateStatus,
    onUpdateProgress: backend.onUpdateProgress,
  },
}));`,
  ],
  [
    `describe("formatBytes", () => {`,
    `/**
 * **The one effect in this hook, and until 2026-08-31 nothing covered it** — this file tested
 * the three pure helpers beside it and stopped there. It matters now because the web build's
 * Updates panel is decided entirely by the answer this effect fetches: with no \`status\`,
 * \`UpdatePanel\` cannot tell "a browser" from "not asked yet" and draws neither the version
 * nor the sentence naming the service worker.
 *
 * Found by mutation: re-adding the \`if (isWebTarget()) return\` that PR #315 put here killed
 * no test at all.
 */
describe("useUpdate's status effect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    backend.updateStatus.mockReset();
    backend.updateStatus.mockResolvedValue(status({ installKind: "web" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Flush the pending microtasks the chained poll is waiting on, inside \`act\`. */
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  /**
   * **Read once, not never.** The web target answers \`update_status\` — it is
   * \`installKind: "web"\` and two \`app_meta\` reads — and the panel needs that answer to know
   * it must not offer a Download button.
   *
   * **And not polled**, which is the other half: the poll exists for exactly one thing, the
   * check Rust spawns at startup and emits no event for, and a browser runs no such check.
   * Nothing can change the answer while the tab is open.
   */
  it("reads the status once on the web target and never polls", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(true);

    const { result } = renderHook(() => useUpdate());
    await settle();

    expect(backend.updateStatus).toHaveBeenCalledTimes(1);
    expect(result.current.status?.installKind).toBe("web");

    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    await settle();
    expect(backend.updateStatus).toHaveBeenCalledTimes(1);
  });

  /** The desktop keeps its minute poll, which is what catches the startup check's answer. */
  it("keeps polling everywhere else", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(false);

    renderHook(() => useUpdate());
    await settle();
    expect(backend.updateStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(backend.updateStatus.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("formatBytes", () => {`,
  ],
]);
