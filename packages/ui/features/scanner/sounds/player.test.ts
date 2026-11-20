import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scanner's speaker under the app's volume (issue #1703), over a Web Audio fake — jsdom has
 * none, and on a host with none the player is silent by design, which would prove nothing.
 *
 * The player keeps its context in module state, so each test imports a fresh copy of it, and of
 * `@/lib/volume` with it: the store the player subscribes to must be the store the test moves.
 */

class FakeParam {
  value = 1;
  setTargetAtTime = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn();
}

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

const made = { gains: [] as FakeGain[], sources: [] as FakeSource[], contexts: [] as unknown[] };

class FakeContext {
  state = "running";
  currentTime = 0;
  destination = { kind: "speakers" };
  constructor() {
    made.contexts.push(this);
  }
  createGain() {
    const gain = new FakeGain();
    made.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new FakeSource();
    made.sources.push(source);
    return source;
  }
  decodeAudioData = vi.fn(() => Promise.resolve({ duration: 0.2 }));
  resume = vi.fn(() => Promise.resolve());
}

async function fresh() {
  vi.resetModules();
  const volume = await import("@/lib/volume");
  const player = await import("./player");
  return { ...volume, ...player };
}

beforeEach(() => {
  made.gains = [];
  made.sources = [];
  made.contexts = [];
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("playScanSound", () => {
  it("plays through one gain at the app's volume, between the sound and the speakers", async () => {
    const { useAppVolume, playScanSound } = await fresh();
    useAppVolume.getState().setVolume(50);

    playScanSound("ok");
    await vi.waitFor(() => expect(made.sources).toHaveLength(1));

    expect(made.gains).toHaveLength(1);
    const [level] = made.gains;
    const [context] = made.contexts as FakeContext[];
    expect(level!.gain.value).toBe(0.25);
    expect(level!.connect).toHaveBeenCalledWith(context!.destination);
    expect(made.sources[0]!.connect).toHaveBeenCalledWith(level);
    expect(made.sources[0]!.start).toHaveBeenCalled();
  });

  it("follows the slider while a sound rings, eased rather than stepped", async () => {
    const { useAppVolume, playScanSound } = await fresh();
    playScanSound("jackpot");
    await vi.waitFor(() => expect(made.sources).toHaveLength(1));
    const [level] = made.gains;
    expect(level!.gain.value).toBe(1);

    useAppVolume.getState().setVolume(0);
    expect(level!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.015);
    useAppVolume.getState().setVolume(50);
    expect(level!.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.25, 0, 0.015);
  });

  it("makes no audio at all for a level moved before any sound", async () => {
    const { useAppVolume } = await fresh();
    useAppVolume.getState().setVolume(30);
    expect(made.contexts).toHaveLength(0);
  });
});
