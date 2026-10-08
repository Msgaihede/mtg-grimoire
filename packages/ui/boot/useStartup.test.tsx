import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StartupStatus } from "@/lib/ipc";

/**
 * The gate by itself, under `ipc.ts` and not in place of it — `DesktopBoot.test.tsx`'s
 * arrangement, for its reason. That file holds what the gate does on the way *to* an answer; this
 * one holds what it does **after** one: the listener it keeps past `ready`, and the one later move
 * it follows.
 */
const invoke = vi.hoisted(() => vi.fn<(command: string) => Promise<StartupStatus>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));

import { STARTUP_POLL_MS, useStartup } from "@/boot/useStartup";
import { emitFake, resetListeners } from "@grimoire/fake/event";
import { activeScope } from "@grimoire/fake/scope";

const LOADING: StartupStatus = { state: "loading" };
const READY: StartupStatus = { state: "ready" };
/** What the web host says when its engine's Worker dies under an open app. */
const STOPPED: StartupStatus = {
  state: "failed",
  message: "MTG Grimoire's card engine stopped. Reload to start it again.",
  reload: true,
};

const asks = () => invoke.mock.calls.filter(([command]) => command === "startup_status").length;
/** How many subscriptions to the gate's event are live right now. */
const subscribed = () => activeScope().listeners.get("startup:changed")?.size ?? 0;
const say = (status: StartupStatus) => act(() => emitFake("startup:changed", status));

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  invoke.mockReset();
  resetListeners();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the gate, once the app is up", () => {
  it("stops asking at ready and goes on listening", async () => {
    invoke.mockResolvedValue(READY);
    const { result } = renderHook(() => useStartup());
    await advance(0);
    expect(result.current).toEqual(READY);

    await advance(STARTUP_POLL_MS * 10);
    // The reliable half is done — nothing can be missed once there is an answer —
    expect(asks()).toBe(1);
    // — and the fast half stays, for the one thing a host may still have to say.
    expect(subscribed()).toBe(1);
  });

  /**
   * **`ready` to `failed`, the one later move.** The web host's engine can stop under an open
   * app; from then until a reload there is nothing behind the page, and the gate is where the
   * whole window hears it — rather than each hook finding out alone, or not at all.
   */
  it("hears a failure after ready, and takes the host's sentence and its reload", async () => {
    invoke.mockResolvedValue(READY);
    const { result } = renderHook(() => useStartup());
    await advance(0);
    expect(result.current.state).toBe("ready");

    say(STOPPED);

    expect(result.current).toEqual(STOPPED);
    // That is the end of it: nothing more is listened for, and nothing was asked again.
    expect(subscribed()).toBe(0);
    expect(asks()).toBe(1);
  });

  it("hears it whichever half delivered the ready", async () => {
    invoke.mockResolvedValue(LOADING);
    const { result } = renderHook(() => useStartup());
    await advance(0);
    say(READY);
    expect(result.current.state).toBe("ready");

    say(STOPPED);
    expect(result.current).toEqual(STOPPED);
  });

  it("never comes back from a failure, before or after the app was up", async () => {
    invoke.mockResolvedValue(READY);
    const up = renderHook(() => useStartup());
    await advance(0);
    say(STOPPED);
    say(READY);
    say(LOADING);
    expect(up.result.current).toEqual(STOPPED);
    up.unmount();

    invoke.mockResolvedValue({ state: "failed", message: "user.db is locked." });
    const never = renderHook(() => useStartup());
    await advance(0);
    say(READY);
    expect(never.result.current).toEqual({ state: "failed", message: "user.db is locked." });
  });

  /**
   * The way a `ready` can still reach a gate that has failed: an ask that was in flight when the
   * failure was heard. The listener is gone by then, so the case above cannot show the guard —
   * this one can, and without it the app would be mounted over a host that said it will not start.
   */
  it("is not reopened by an ask that answers ready after the failure was heard", async () => {
    let answer!: (status: StartupStatus) => void;
    invoke.mockReturnValue(new Promise<StartupStatus>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useStartup());
    await advance(0);
    expect(asks()).toBe(1);

    say({ state: "failed", message: "user.db is locked." });
    await act(async () => {
      answer(READY);
      await Promise.resolve();
    });

    expect(result.current).toEqual({ state: "failed", message: "user.db is locked." });
    // And the late answer re-armed nothing.
    await advance(STARTUP_POLL_MS * 5);
    expect(asks()).toBe(1);
  });

  it("is not moved, or re-rendered, by a second ready", async () => {
    invoke.mockResolvedValue(READY);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStartup();
    });
    await advance(0);
    const before = renders;
    const answer = result.current;

    say({ state: "ready" });
    say(LOADING);

    // The same object the gate first settled on: no state was set, so nothing above it re-ran.
    expect(result.current).toBe(answer);
    expect(renders).toBe(before);
  });

  it("takes only the first failure after ready", async () => {
    invoke.mockResolvedValue(READY);
    const { result } = renderHook(() => useStartup());
    await advance(0);

    say(STOPPED);
    say({ state: "failed", message: "something else", reload: true });

    expect(result.current).toEqual(STOPPED);
  });

  it("lets go of its listener when the gate unmounts with the app up", async () => {
    invoke.mockResolvedValue(READY);
    const { unmount } = renderHook(() => useStartup());
    await advance(0);
    expect(subscribed()).toBe(1);

    unmount();
    expect(subscribed()).toBe(0);
  });

  /**
   * StrictMode mounts the effect, unmounts it and mounts it again. The first run's listener must
   * be gone and the second's must be the one that hears — two would set the state twice, and none
   * would leave an app whose engine died drawing its last screen for ever.
   */
  it("keeps exactly one listener across StrictMode's double mount, and it is the one that hears", async () => {
    invoke.mockResolvedValue(READY);
    const { result } = renderHook(() => useStartup(), { reactStrictMode: true });
    await advance(0);
    expect(result.current.state).toBe("ready");
    expect(subscribed()).toBe(1);
    // Both runs asked once each and neither re-armed: the first run's answer landed on a dead
    // effect and the second's settled the gate.
    await advance(STARTUP_POLL_MS * 10);
    expect(asks()).toBe(2);

    say(STOPPED);
    expect(result.current).toEqual(STOPPED);
    expect(subscribed()).toBe(0);
  });

  it("subscribes to nothing and asks nothing on a host with no startup to wait for", async () => {
    const { result } = renderHook(() => useStartup(false));
    await advance(STARTUP_POLL_MS * 3);

    expect(result.current).toEqual(READY);
    expect(asks()).toBe(0);
    expect(subscribed()).toBe(0);
    // And so nothing closes it: fake mode has no host to say its engine stopped.
    say(STOPPED);
    expect(result.current).toEqual(READY);
  });
});
