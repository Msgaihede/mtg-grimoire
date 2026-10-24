import { afterEach, describe, expect, it, vi } from "vitest";
import { VOLUME_KEY, clampVolume, useTableSoundsVolume, volumeGain } from "./volume";

afterEach(() => {
  vi.restoreAllMocks();
  useTableSoundsVolume.getState().setVolume(100);
});

describe("useTableSoundsVolume", () => {
  it("remembers a level on this device, and forgets it back at full", () => {
    useTableSoundsVolume.getState().setVolume(40);
    expect(window.localStorage.getItem(VOLUME_KEY)).toBe("40");
    expect(useTableSoundsVolume.getState().volume).toBe(40);
    useTableSoundsVolume.getState().setVolume(100);
    expect(window.localStorage.getItem(VOLUME_KEY)).toBeNull();
  });

  it("keeps the level for the session when the store refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("refused");
    });
    useTableSoundsVolume.getState().setVolume(25);
    expect(useTableSoundsVolume.getState().volume).toBe(25);
  });

  it("holds a level to a whole number in 0–100, and reads nonsense as full", () => {
    useTableSoundsVolume.getState().setVolume(140);
    expect(useTableSoundsVolume.getState().volume).toBe(100);
    useTableSoundsVolume.getState().setVolume(-5);
    expect(useTableSoundsVolume.getState().volume).toBe(0);
    expect(clampVolume(33.6)).toBe(34);
    expect(clampVolume(Number("loud"))).toBe(100);
  });
});

describe("volumeGain", () => {
  it("follows loudness as heard: the square of the level", () => {
    expect(volumeGain(100)).toBe(1);
    expect(volumeGain(50)).toBe(0.25);
    expect(volumeGain(0)).toBe(0);
  });
});
