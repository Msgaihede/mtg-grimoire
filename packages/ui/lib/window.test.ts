import { beforeEach, describe, expect, it, vi } from "vitest";

const windowListen = vi.hoisted(() => vi.fn(async () => () => undefined));
const globalListen = vi.hoisted(() => vi.fn(async () => () => undefined));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "window-2", listen: windowListen }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: globalListen }));

import { SEARCH_SHOW_EVENT, SNAP_HOVER_EVENTS, onSearchShow, onSnapHover } from "./window";

beforeEach(() => {
  windowListen.mockClear();
  globalListen.mockClear();
});

describe("onSearchShow", () => {
  it("listens on its own window, never app-wide, and hands over the payload", async () => {
    const cb = vi.fn();
    await onSearchShow(cb);
    expect(windowListen).toHaveBeenCalledWith(SEARCH_SHOW_EVENT, expect.any(Function));
    expect(globalListen).not.toHaveBeenCalled();
    const handler = (
      windowListen.mock.calls[0] as unknown as [string, (e: { payload: unknown }) => void]
    )[1];
    handler({ payload: { id: 7 } });
    expect(cb).toHaveBeenCalledWith({ id: 7 });
  });
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
