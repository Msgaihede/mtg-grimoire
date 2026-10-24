import { describe, expect, it } from "vitest";
import {
  RECIPES,
  Voice,
  buildGraph,
  createTableSynth,
  nextTake,
  rngFor,
  type SoundId,
} from "./synth";

/**
 * Just enough of Web Audio to build every sound and see what it asked for: jsdom has none. It
 * records each ramp's target and each source's start and stop, and refuses what a real context
 * refuses — an exponential ramp to zero or below, a non-finite time.
 */
class FakeParam {
  value = 0;
  ramps: number[] = [];
  setValueAtTime(v: number, t: number) {
    finite(v, t);
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    finite(v, t);
    if (v <= 0) throw new RangeError(`exponential ramp to ${v}`);
    this.ramps.push(v);
  }
  setTargetAtTime(v: number, t: number, k: number) {
    finite(v, t, k);
    this.value = v;
  }
}

function finite(...xs: number[]) {
  for (const x of xs) if (!Number.isFinite(x)) throw new RangeError(`not finite: ${x}`);
}

class FakeNode {
  out: FakeNode[] = [];
  connect(n: FakeNode) {
    this.out.push(n);
    return n;
  }
}

class FakeSource extends FakeNode {
  frequency = new FakeParam();
  type = "";
  buffer: unknown = null;
  started: number[] = [];
  stopped: number[] = [];
  start(t: number, offset = 0) {
    finite(t, offset);
    if (offset < 0) throw new RangeError("negative offset");
    this.started.push(t);
  }
  stop(t: number) {
    finite(t);
    this.stopped.push(t);
  }
}

class FakeContext {
  currentTime = 10;
  sampleRate = 8000;
  state = "running";
  destination = new FakeNode();
  sources: FakeSource[] = [];
  params: FakeParam[] = [];
  private param() {
    const p = new FakeParam();
    this.params.push(p);
    return p;
  }
  private source() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: this.param() });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(), { pan: this.param() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: "", Q: this.param(), frequency: this.param() });
  }
  createWaveShaper() {
    return Object.assign(new FakeNode(), { curve: null, oversample: "none" });
  }
  createConvolver() {
    return Object.assign(new FakeNode(), { buffer: null });
  }
  createDynamicsCompressor() {
    const p = () => this.param();
    return Object.assign(new FakeNode(), {
      threshold: p(),
      knee: p(),
      ratio: p(),
      attack: p(),
      release: p(),
    });
  }
  createOscillator() {
    const s = this.source();
    return s;
  }
  createBufferSource() {
    return this.source();
  }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / this.sampleRate, getChannelData: (c: number) => data[c] };
  }
}

const fake = () => new FakeContext() as unknown as AudioContext & FakeContext;

describe("every sound", () => {
  const ids = Object.keys(RECIPES) as SoundId[];

  it.each(ids)("%s builds every take, each node started and stopped", (id) => {
    for (let take = 0; take < RECIPES[id].takes; take++) {
      const ctx = fake();
      const graph = buildGraph(ctx);
      const before = ctx.sources.length;
      RECIPES[id].play(new Voice(graph, rngFor(`${id}:${take}`), 1.03, 0.97), 10, take);
      const made = ctx.sources.slice(before);
      expect(made.length, `${id} take ${take + 1} made no sound`).toBeGreaterThan(0);
      for (const s of made) {
        expect(s.started).toHaveLength(1);
        expect(s.started[0]).toBeGreaterThanOrEqual(10);
        // An oscillator stops itself; a noise read stops by its duration (start's third
        // argument), so it has no stop call.
        if (s.buffer === null) expect(s.stopped).toHaveLength(1);
      }
    }
  });

  it("gives the busiest sounds three takes, against fatigue", () => {
    for (const id of ["draw", "play", "cast", "tap", "counterAdd", "damage"] as const)
      expect(RECIPES[id].takes).toBe(3);
  });

  it("plays a take the same way every time: its seed is its id and take", () => {
    const run = () => {
      const ctx = fake();
      RECIPES.shuffle.play(new Voice(buildGraph(ctx), rngFor("shuffle:0")), 10, 0);
      return ctx.sources.map((s) => s.started[0]);
    };
    expect(run()).toEqual(run());
  });
});

describe("nextTake", () => {
  it("never plays the last take again, and reaches every other", () => {
    for (let last = 0; last < 3; last++) {
      const seen = new Set<number>();
      for (let i = 0; i < 50; i++) seen.add(nextTake(3, last, Math.random));
      expect(seen.has(last)).toBe(false);
      expect(seen.size).toBe(2);
    }
    expect(nextTake(1, 0)).toBe(0);
    expect([0, 1]).toContain(nextTake(2, undefined, () => 0.99));
  });
});

describe("createTableSynth", () => {
  it("makes no context until the first sound, and plays nothing where there is none", () => {
    let made = 0;
    const silent = createTableSynth(() => {
      made++;
      return null;
    });
    expect(made).toBe(0);
    silent.play("draw");
    silent.play("draw");
    expect(made).toBe(1);
  });

  it("schedules a sound its delay after now, and resumes a suspended context", () => {
    const ctx = fake();
    let resumed = 0;
    ctx.state = "suspended";
    Object.assign(ctx, { resume: () => (resumed++, Promise.resolve()) });
    const synth = createTableSynth(() => ctx);
    synth.play("choose", 0.5);
    expect(resumed).toBe(1);
    const starts = ctx.sources.filter((s) => s.started.length > 0).map((s) => s.started[0]);
    expect(Math.min(...starts)).toBeCloseTo(10.52);
  });

  it("plays through the reader's volume, set before the context is made or after", () => {
    const ctx = fake();
    const synth = createTableSynth(() => ctx);
    synth.setVolume(0.25);
    synth.play("draw");
    // The first gain made is the volume, wired straight to the speakers.
    const master = ctx.params[0];
    expect(master.value).toBe(0.25);
    synth.setVolume(2);
    expect(master.value).toBe(1);
    synth.setVolume(0);
    expect(master.value).toBe(0);
  });
});
