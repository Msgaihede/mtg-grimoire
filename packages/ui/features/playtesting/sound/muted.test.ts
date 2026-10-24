import { afterEach, describe, expect, it, vi } from "vitest";
import { MUTED_KEY, useTableSoundsMuted } from "./muted";

afterEach(() => {
  vi.restoreAllMocks();
  useTableSoundsMuted.getState().setMuted(false);
});

describe("useTableSoundsMuted", () => {
  it("remembers a mute on this device, and forgets it when sounds come back on", () => {
    useTableSoundsMuted.getState().setMuted(true);
    expect(window.localStorage.getItem(MUTED_KEY)).toBe("1");
    expect(useTableSoundsMuted.getState().muted).toBe(true);
    useTableSoundsMuted.getState().setMuted(false);
    expect(window.localStorage.getItem(MUTED_KEY)).toBeNull();
  });

  it("keeps the setting for the session when the store refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("refused");
    });
    useTableSoundsMuted.getState().setMuted(true);
    expect(useTableSoundsMuted.getState().muted).toBe(true);
  });
});
