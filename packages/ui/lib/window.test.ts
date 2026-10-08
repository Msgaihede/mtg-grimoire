import { beforeEach, describe, expect, it, vi } from "vitest";

const windowListen = vi.hoisted(() => vi.fn(async () => () => undefined));
const globalListen = vi.hoisted(() => vi.fn(async () => () => undefined));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "window-2", listen: windowListen }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: globalListen }));

import { SNAP_HOVER_EVENTS, onSnapHover } from "./window";

beforeEach(() => {
  windowListen.mockClear();
  globalListen.mockClear();
});

describe("onSnapHover", () => {
  /**
   * The snap-layout plugin emits to one window's label. A global `listen` hears every label, so
   * with two windows open, hovering one maximize button lit both.
   */
  it("listens on its own window, never app-wide", async () => {
    await onSnapHover(() => undefined);
    expect(windowListen).toHaveBeenCalledWith(SNAP_HOVER_EVENTS.enter, expect.any(Function));
    expect(windowListen).toHaveBeenCalledWith(SNAP_HOVER_EVENTS.leave, expect.any(Function));
    expect(globalListen).not.toHaveBeenCalled();
  });
});
