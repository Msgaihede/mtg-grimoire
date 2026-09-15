import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { StartupStatus } from "@/lib/ipc";

/**
 * **Under `ipc.ts`, not in place of it** — `invoke` is the transport and the event module is the
 * workbench's fake, so the command name and the event name this gate depends on are the ones
 * `ipc.ts` actually spells. A mocked `ipc` would test the gate against a second copy of the
 * contract that nothing had checked. Typed on the mirror's union, so a fixture the Rust side
 * could never send does not compile.
 */
const invoke = vi.hoisted(() => vi.fn<(command: string) => Promise<StartupStatus>>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
// The caption the loader draws reaches Tauri's window API; the workbench's fake stands in, as
// it does in `TitleBar.test.tsx`.
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));
// The real App mounts the whole product and fires its queries. What this suite is about is
// *whether* it is mounted, so it stands in for itself — `WebBoot.test.tsx`'s arrangement.
vi.mock("@/App", () => ({ default: () => <div>the app</div> }));

import { DesktopBoot, STARTUP_POLL_MS } from "@/boot/DesktopBoot";
import { STARTUP_LOADING_LABEL } from "@/boot/StartupScreen";
import { ACTIVITY_DELAY_MS } from "@/lib/activity";
import { emitFake, resetListeners } from "../../.storybook/fake/event";
import { resetWindow } from "../../.storybook/fake/window";

const LOADING: StartupStatus = { state: "loading" };
const READY: StartupStatus = { state: "ready" };

/** How many times the gate has asked, ignoring the caption's own window calls. */
const asks = () => invoke.mock.calls.filter(([command]) => command === "startup_status").length;

/**
 * Run the clock forward and let every promise that settles along the way land — the async
 * variant awaits between timers, which is what an ask answering and re-arming its timer needs.
 */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  // Only the two the gate uses. `userEvent` is not used here at all: under fake timers it hangs.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  invoke.mockReset();
  resetListeners();
  resetWindow();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the desktop boot", () => {
  it("draws the loader, and not the app, while the data folder is still opening", async () => {
    invoke.mockResolvedValue(LOADING);
    render(<DesktopBoot />);
    await advance(ACTIVITY_DELAY_MS);

    expect(screen.getByRole("status")).toHaveTextContent(STARTUP_LOADING_LABEL);
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
    // The caption is up, so the window can be closed while it waits.
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  /** The reliable half: the event never comes, and the poll alone gets the app mounted. */
  it("mounts the app when a later poll answers ready", async () => {
    invoke.mockResolvedValueOnce(LOADING).mockResolvedValue(READY);
    render(<DesktopBoot />);
    await advance(0);
    expect(screen.queryByText("the app")).not.toBeInTheDocument();

    await advance(STARTUP_POLL_MS);
    expect(screen.getByText("the app")).toBeInTheDocument();
  });

  /** The fast half: the answer arrives by event while every poll still says loading. */
  it("mounts the app when the event says ready, and stops asking", async () => {
    invoke.mockResolvedValue(LOADING);
    render(<DesktopBoot />);
    // Let the listener register — the fake's `listen` is async, like Tauri's.
    await advance(0);

    act(() => emitFake<StartupStatus>("startup:changed", READY));
    expect(screen.getByText("the app")).toBeInTheDocument();

    const before = asks();
    await advance(STARTUP_POLL_MS * 5);
    expect(asks()).toBe(before);
  });

  it("shows the native side's own sentence when the folder would not open", async () => {
    const message =
      "The data folder could not be opened:\nD:\\Grimoire\\data\nCheck it is writable.";
    invoke.mockResolvedValue({ state: "failed", message });
    render(<DesktopBoot />);
    await advance(0);

    expect(
      screen.getByRole("heading", { name: "The data folder would not open" }),
    ).toBeInTheDocument();
    // `textContent`, not `toHaveTextContent`, which collapses whitespace and would pass over a
    // message whose line breaks had been flattened on the way through.
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
  });

  /**
   * A rejection says nothing about the data folder — a call before the command is there, a
   * dropped transport — so it is not a failure to draw, and the next tick asks again.
   */
  it("treats a rejected ask as still loading and asks again", async () => {
    invoke.mockRejectedValueOnce(new Error("state not managed")).mockResolvedValue(READY);
    render(<DesktopBoot />);
    await advance(0);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();

    await advance(STARTUP_POLL_MS);
    expect(asks()).toBe(2);
    expect(screen.getByText("the app")).toBeInTheDocument();
  });

  /** Neither answer ever moves back, so the gate has nothing left to ask once it has one. */
  it.each<[string, StartupStatus]>([
    ["ready", READY],
    ["failed", { state: "failed", message: "no" }],
  ])("stops polling once the answer is %s", async (_name, answer) => {
    invoke.mockResolvedValue(answer);
    render(<DesktopBoot />);
    await advance(0);
    expect(asks()).toBe(1);

    await advance(STARTUP_POLL_MS * 10);
    expect(asks()).toBe(1);
  });

  it("stops asking once it is unmounted mid-load", async () => {
    invoke.mockResolvedValue(LOADING);
    const { unmount } = render(<DesktopBoot />);
    await advance(STARTUP_POLL_MS);
    const before = asks();
    expect(before).toBeGreaterThan(0);

    unmount();
    await advance(STARTUP_POLL_MS * 10);
    expect(asks()).toBe(before);
  });
});
