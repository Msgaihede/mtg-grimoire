import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_VOLUME_KEY, appVolumeGain, clampVolume, useAppVolume, volumeGain } from "./volume";

afterEach(() => {
  vi.restoreAllMocks();
  useAppVolume.getState().setVolume(100);
});

describe("useAppVolume", () => {
  it("starts at full, remembers a level on this device, and forgets it back at full", () => {
    expect(useAppVolume.getState().volume).toBe(100);
    useAppVolume.getState().setVolume(35);
    expect(window.localStorage.getItem(APP_VOLUME_KEY)).toBe("35");
    expect(useAppVolume.getState().volume).toBe(35);
    useAppVolume.getState().setVolume(100);
    expect(window.localStorage.getItem(APP_VOLUME_KEY)).toBeNull();
  });

  it("keeps the level for the session when the store refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("refused");
    });
    useAppVolume.getState().setVolume(20);
    expect(useAppVolume.getState().volume).toBe(20);
  });

  it("holds a level to 0–100", () => {
    useAppVolume.getState().setVolume(250);
    expect(useAppVolume.getState().volume).toBe(100);
    useAppVolume.getState().setVolume(-1);
    expect(useAppVolume.getState().volume).toBe(0);
  });

  /**
   * **Every window reads one level.** A second window writes the store and this one is told by a
   * `storage` event — which the browser fires only in the *other* windows, so the test plays that
   * window's part by hand: write the value, then raise the event.
   */
  it("takes a level another window set, and full again when the store is cleared", () => {
    window.localStorage.setItem(APP_VOLUME_KEY, "40");
    window.dispatchEvent(new StorageEvent("storage", { key: APP_VOLUME_KEY, newValue: "40" }));
    expect(useAppVolume.getState().volume).toBe(40);

    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(useAppVolume.getState().volume).toBe(100);
  });

  it("ignores another window's change to a different key", () => {
    useAppVolume.getState().setVolume(60);
    window.dispatchEvent(new StorageEvent("storage", { key: "grimoire.playtest.volume" }));
    expect(useAppVolume.getState().volume).toBe(60);
  });
});

describe("clampVolume", () => {
  it("rounds to a whole number, and reads nonsense as full", () => {
    expect(clampVolume(33.6)).toBe(34);
    expect(clampVolume(Number("loud"))).toBe(100);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("volumeGain", () => {
  it("follows loudness as heard: the square of the level", () => {
    expect(volumeGain(100)).toBe(1);
    expect(volumeGain(50)).toBe(0.25);
    expect(volumeGain(0)).toBe(0);
  });

  it("is the app's level's gain, read now", () => {
    useAppVolume.getState().setVolume(50);
    expect(appVolumeGain()).toBe(0.25);
  });
});
