/**
 * The playtest board's sounds, made in the webview by Web Audio — no sample files, so nothing to
 * ship, license or cache, and every sound is a few numbers to tune here.
 *
 * **Approved by ear, 2026-10-24.** The set was auditioned on a preview page first, and the owner
 * asked for the magical ones (keep, cast, mana, activate, exile, tokens, life, the turn) to be
 * darker and flatter: low, muted notes from {@link Voice.pluck} and {@link Voice.mallet}, never
 * a bright bell. Only the rare, grand moments (an emblem, a block, a game's end) still ring.
 *
 * **Takes, against fatigue.** The sounds the board makes most (a draw, a land, a cast, a tap, a
 * counter, damage) have three takes and some others two. {@link TableSynth.play} never plays the
 * take it played last, and every play is humanized — pitch and level nudged by up to 3% — so a
 * repeated take never lands identically. A take is fixed by its seed (`rngFor(id:take)`): take 2
 * of a draw is the same draw every time, and the randomness is only in which take and the nudge.
 *
 * **Loudness by frequency.** Handling sounds (draw, tap, counters) are quietest, since they fire
 * constantly; the turn, combat and the game's end are louder and carry a little room reverb. One
 * compressor sits before the output, so a busy beat never spikes.
 */

export type SoundId =
  | "draw"
  | "shuffle"
  | "mulligan"
  | "keep"
  | "mill"
  | "toHand"
  | "toLibrary"
  | "play"
  | "cast"
  | "tap"
  | "untap"
  | "untapAll"
  | "mana"
  | "activate"
  | "foretell"
  | "graveyard"
  | "exile"
  | "counterAdd"
  | "counterRemove"
  | "token"
  | "emblem"
  | "attack"
  | "block"
  | "damage"
  | "commanderDamage"
  | "lifeLoss"
  | "lifeGain"
  | "turnYours"
  | "turnTheirs"
  | "pass"
  | "choose"
  | "undo"
  | "redo"
  | "eliminated"
  | "win"
  | "lose";

/** The whole board's level, before the compressor. */
const LEVEL = 0.7;

// ---------- deterministic randomness ----------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator fixed by `key` (FNV-1a over its characters): one take's jitter and noise reads. */
export function rngFor(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0);
}

// ---------- primitives ----------

interface NoiseOptions {
  dur: number;
  f0: number;
  f1?: number;
  q?: number;
  type?: BiquadFilterType;
  gain?: number;
  a?: number;
  pan?: number;
  send?: number;
  /** A tanh drive on the filtered noise, for a crack. */
  drive?: number;
}

interface ToneOptions {
  f0: number;
  f1?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  a?: number;
  pan?: number;
  send?: number;
  /** How long the glide f0 → f1 takes; the whole note by default. */
  glide?: number;
  /** A lowpass on the oscillator, Hz; none at 0. */
  lp?: number;
}

interface Partials {
  ratios: readonly number[];
  decays: readonly number[];
  amps: readonly number[];
}

const SOFT: Partials = {
  ratios: [1, 2, 3.01, 4.17, 5.43],
  decays: [1, 0.55, 0.38, 0.27, 0.2],
  amps: [1, 0.42, 0.2, 0.11, 0.06],
};
const METAL: Partials = {
  ratios: [1, 2.76, 5.4, 8.93],
  decays: [1, 0.6, 0.38, 0.25],
  amps: [1, 0.55, 0.3, 0.16],
};
const SHIELD: Partials = {
  ratios: [1, 2.32, 3.73, 5.1, 6.8],
  decays: [1, 0.7, 0.5, 0.35, 0.25],
  amps: [1, 0.7, 0.45, 0.3, 0.2],
};

/** The graph every sound plays into, and the noise it reads from. */
interface Graph {
  ctx: BaseAudioContext;
  dry: AudioNode;
  wet: AudioNode;
  noise: AudioBuffer;
}

const curves = new Map<number, Float32Array<ArrayBuffer>>();
function driveCurve(k: number): Float32Array<ArrayBuffer> {
  let c = curves.get(k);
  if (c === undefined) {
    c = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = i / 511.5 - 1;
      c[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    curves.set(k, c);
  }
  return c;
}

/**
 * One play of one take: the graph, the take's own generator (`r`) and the humanize nudge
 * (`pf` on every frequency, `gf` on every level). Every node it makes stops by itself.
 */
export class Voice {
  constructor(
    private readonly g: Graph,
    readonly r: () => number,
    private readonly pf = 1,
    private readonly gf = 1,
  ) {}

  private env(gain: GainNode, t: number, peak: number, a: number, dur: number): void {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(peak * this.gf, 0.0002),
      t + Math.max(a, 0.0005),
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private route(node: AudioNode, pan: number, send: number): void {
    const { ctx, dry, wet } = this.g;
    let n = node;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      n.connect(p);
      n = p;
    }
    n.connect(dry);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      n.connect(s);
      s.connect(wet);
    }
  }

  /** Filtered noise, its filter swept f0 → f1 over its length. */
  noise(t: number, o: NoiseOptions): void {
    const { ctx, noise } = this.g;
    const { dur, f0, f1 = f0, q = 1, type = "bandpass", gain = 0.3, a = 0.004 } = o;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0 * this.pf, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1 * this.pf, t + dur);
    const g = ctx.createGain();
    this.env(g, t, gain, a, dur);
    src.connect(f);
    if (o.drive) {
      const w = ctx.createWaveShaper();
      w.curve = driveCurve(o.drive);
      w.oversample = "2x";
      f.connect(w);
      w.connect(g);
    } else f.connect(g);
    this.route(g, o.pan ?? 0, o.send ?? 0);
    src.start(t, this.r() * Math.max(0, noise.duration - dur - 0.2), dur + 0.05);
  }

  /** An oscillator, with an optional glide f0 → f1 and lowpass. */
  tone(t: number, o: ToneOptions): void {
    const { ctx } = this.g;
    const { f0, f1 = f0, dur, type = "sine", gain = 0.2, a = 0.003, glide = dur, lp = 0 } = o;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * this.pf, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1 * this.pf, t + glide);
    const g = ctx.createGain();
    this.env(g, t, gain, a, dur);
    if (lp > 0) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = lp;
      osc.connect(f);
      f.connect(g);
    } else osc.connect(g);
    this.route(g, o.pan ?? 0, o.send ?? 0);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** A struck note of sine partials: the rare, grand sounds only. */
  bell(
    t: number,
    o: { f: number; dur?: number; gain?: number; send?: number; pan?: number; kind?: Partials },
  ): void {
    const { f, dur = 1.2, gain = 0.1, send = 0.5, pan = 0, kind = SOFT } = o;
    kind.ratios.forEach((r, i) =>
      this.tone(t, {
        f0: f * r,
        dur: dur * kind.decays[i],
        gain: gain * kind.amps[i],
        a: 0.002,
        pan,
        send,
      }),
    );
  }

  /** A muted, felt-tipped note: a darkened triangle over a sine, no bell partials. */
  pluck(
    t: number,
    o: { f: number; dur?: number; gain?: number; lp?: number; send?: number },
  ): void {
    const { f, dur = 0.25, gain = 0.1, lp = 800, send = 0.2 } = o;
    this.tone(t, { f0: f, dur, type: "triangle", lp, gain, a: 0.01, send });
    this.tone(t, { f0: f, dur: dur * 0.9, gain: gain * 0.6, a: 0.01, send });
  }

  /** A low wooden mallet: the fundamental, a little second harmonic and a sub-octave. */
  mallet(t: number, o: { f: number; gain?: number }): void {
    const { f, gain = 0.13 } = o;
    const dur = 1.1;
    const send = 0.45;
    this.tone(t, { f0: f, dur, gain, a: 0.006, send });
    this.tone(t, {
      f0: f,
      dur: dur * 0.5,
      type: "triangle",
      lp: 1100,
      gain: gain * 0.35,
      a: 0.004,
      send,
    });
    this.tone(t, { f0: f * 2, dur: dur * 0.3, gain: gain * 0.1, a: 0.004, send });
    this.tone(t, { f0: f / 2, dur: dur * 0.8, gain: gain * 0.3, a: 0.01 });
  }

  click(t: number, f = 5000, gain = 0.1, pan = 0): void {
    this.noise(t, { dur: 0.009, f0: f, type: "highpass", q: 0.7, gain, a: 0.0008, pan });
  }

  /** A card sliding: bandpassed noise, its rise ~40% of its length. */
  slide(
    t: number,
    f0: number,
    f1: number,
    dur: number,
    gain = 0.3,
    o: { a?: number; q?: number; pan?: number } = {},
  ): void {
    this.noise(t, { f0, f1, dur, gain, a: o.a ?? dur * 0.42, q: o.q ?? 0.9, pan: o.pan ?? 0 });
  }

  /** A card meeting the felt: dull noise and a small body thump. */
  land(t: number, body = 165, lp = 2200, gain = 1): void {
    this.noise(t, {
      type: "lowpass",
      f0: lp,
      f1: 500,
      dur: 0.08,
      gain: 0.48 * gain,
      a: 0.002,
      q: 0.7,
    });
    this.tone(t, { f0: body, f1: body * 0.5, dur: 0.1, gain: 0.4 * gain, a: 0.002 });
    this.click(t, 3000, 0.05 * gain);
  }

  /** A deck squared against the table. */
  square(t: number, gain = 1): void {
    this.noise(t, { type: "lowpass", f0: 1200, f1: 400, dur: 0.05, gain: 0.3 * gain, a: 0.002 });
    this.tone(t, { f0: 165, f1: 120, dur: 0.06, gain: 0.2 * gain, a: 0.002 });
  }

  /** A riffle: `n` card ticks over `len` seconds, the two halves left and right. */
  riffle(t: number, n: number, len: number, gain = 1): void {
    this.noise(t, { f0: 3500, dur: len, q: 0.6, gain: 0.045 * gain, a: len * 0.35 });
    for (let i = 0; i < n; i++) {
      // Jittered, never before the riffle starts.
      const at = Math.max(t, t + len * Math.pow(i / n, 0.92) + (this.r() - 0.5) * 0.004);
      const side = (i % 2 ? 0.35 : -0.35) + (this.r() - 0.5) * 0.2;
      this.click(at, 3000 + this.r() * 2600, (0.06 + this.r() * 0.06) * gain, side);
    }
  }

  /** A knuckle on the table, the way players pass at a real one. */
  knock(t: number, f = 330, gain = 1): void {
    this.tone(t, { f0: f, f1: f * 0.9, dur: 0.06, gain: 0.3 * gain, a: 0.001 });
    this.noise(t, { f0: 1100, dur: 0.035, q: 4, gain: 0.26 * gain, a: 0.001 });
    this.noise(t, { type: "lowpass", f0: 400, dur: 0.045, gain: 0.2 * gain, a: 0.001 });
  }
}

// ---------- the sounds ----------

const DRAW = [
  { f0: 1800, f1: 4200, dur: 0.13, a: 0.05, g: 0.34, ticks: [0.115] },
  { f0: 1500, f1: 3500, dur: 0.17, a: 0.075, g: 0.3, ticks: [0.155] },
  { f0: 2200, f1: 5200, dur: 0.11, a: 0.035, g: 0.36, ticks: [0.085, 0.102] },
];
const PLAY = [
  { pre: 0.07, body: 170, lp: 2200, double: false },
  { pre: 0.045, body: 150, lp: 1900, double: false },
  { pre: 0, body: 185, lp: 2500, double: true },
];
const CAST_NOTES = [146.83, 164.81, 130.81];
const TAP = [
  { f0: 1100, f1: 2400, dur: 0.085, k: 240 },
  { f0: 900, f1: 2000, dur: 0.1, k: 210 },
  { f0: 1300, f1: 2800, dur: 0.072, k: 275 },
];
const HIT = [
  { k: 125, crack: 1800 },
  { k: 105, crack: 1400 },
  { k: 145, crack: 2300 },
];
const BEADS = [1760, 1975.5, 2217.5];
/** Life's two notes, as loss plays them: down. Gain plays them up. */
const LIFE = [
  [196, 146.83],
  [220, 164.81],
];

function draw(v: Voice, t: number, take: number): void {
  const p = DRAW[take];
  v.noise(t, { type: "lowpass", f0: 900, dur: 0.05, gain: 0.08, a: 0.002 });
  v.slide(t + 0.01, p.f0, p.f1, p.dur, p.g, { a: p.a });
  for (const d of p.ticks) v.click(t + d, 4800 + v.r() * 800, 0.1);
}

function tap(v: Voice, t: number, take: number, pan = 0.1, gain = 1): void {
  const p = TAP[take];
  v.slide(t, p.f0, p.f1, p.dur, 0.28 * gain, { q: 1.2, pan });
  v.tone(t + p.dur * 0.85, {
    f0: p.k,
    f1: p.k * 0.85,
    dur: 0.04,
    gain: 0.14 * gain,
    a: 0.001,
    pan,
  });
  v.click(t + p.dur * 0.85, 2600, 0.05 * gain, pan);
}

function untap(v: Voice, t: number, take: number, pan = -0.1, gain = 1): void {
  const p = TAP[take];
  v.tone(t, { f0: p.k * 0.9, f1: p.k * 0.8, dur: 0.035, gain: 0.09 * gain, a: 0.001, pan });
  v.slide(t + 0.01, p.f1 * 0.95, p.f0, p.dur * 1.05, 0.24 * gain, { q: 1.2, pan, a: p.dur * 0.3 });
}

function graveyard(v: Voice, t: number, take: number): void {
  v.slide(t, 2600, 1300, 0.1, 0.2);
  const at = t + 0.08;
  v.noise(at, { type: "lowpass", f0: take ? 1200 : 1000, f1: 250, dur: 0.1, gain: 0.45, a: 0.002 });
  v.tone(at, { f0: take ? 100 : 115, f1: take ? 48 : 55, dur: 0.16, gain: 0.32, a: 0.002 });
  v.noise(at + 0.01, { type: "lowpass", f0: 450, dur: 0.4, gain: 0.04, a: 0.05 });
}

function hit(v: Voice, t: number, take: number, gain = 1): void {
  const p = HIT[take];
  v.noise(t, { f0: p.crack, q: 0.8, dur: 0.06, gain: 0.55 * gain, a: 0.001, drive: 3 });
  v.tone(t, { f0: p.k, f1: p.k * 0.38, dur: 0.2, gain: 0.8 * gain, a: 0.001 });
  v.noise(t, { type: "lowpass", f0: 300, dur: 0.15, gain: 0.2 * gain, a: 0.002 });
}

function lifeStep(v: Voice, t: number, a: number, b: number): void {
  v.pluck(t, { f: a, dur: 0.16, gain: 0.1, lp: 700 });
  v.pluck(t + 0.12, { f: b, dur: 0.3, gain: 0.1, lp: 650 });
}

interface Recipe {
  takes: 1 | 2 | 3;
  play: (v: Voice, t: number, take: number) => void;
}

export const RECIPES: Record<SoundId, Recipe> = {
  draw: { takes: 3, play: draw },
  shuffle: {
    takes: 2,
    // A riffle, a bridge and two taps to square it; or an overhand shuffle.
    play(v, t, take) {
      if (take === 0) {
        v.riffle(t, 56, 0.6);
        v.slide(t + 0.63, 1400, 700, 0.22, 0.18, { a: 0.12 });
        v.square(t + 0.92);
        v.square(t + 1.02, 0.7);
        return;
      }
      for (let i = 0; i < 4; i++) {
        const at = t + i * 0.17;
        v.slide(at, 1100 + v.r() * 200, 2600, 0.12, 0.24, { a: 0.05, pan: i % 2 ? 0.15 : -0.15 });
        v.click(at + 0.11, 3500, 0.07);
      }
      v.square(t + 0.76);
    },
  },
  mulligan: {
    takes: 1,
    play(v, t) {
      [0, 0.06, 0.12].forEach((d, i) =>
        v.slide(t + d, 3400, 1500, 0.09, 0.2, { pan: (i - 1) * 0.3 }),
      );
      v.riffle(t + 0.3, 28, 0.32, 0.9);
      v.square(t + 0.72);
      v.tone(t + 0.82, { f0: 220, f1: 185, dur: 0.35, gain: 0.04, a: 0.04, send: 0.3 });
    },
  },
  keep: {
    takes: 1,
    // The hand squared and a low, muted "mm-hm".
    play(v, t) {
      v.square(t, 0.8);
      v.pluck(t + 0.03, { f: 196, dur: 0.2, gain: 0.09 });
      v.pluck(t + 0.12, { f: 293.66, dur: 0.3, gain: 0.09 });
    },
  },
  mill: {
    takes: 2,
    play(v, t, take) {
      v.slide(t, 2400, 1500, 0.08, 0.2);
      if (take) v.slide(t + 0.06, 2600, 1600, 0.07, 0.16);
      graveyard(v, t + (take ? 0.1 : 0.05), take);
    },
  },
  toHand: {
    takes: 2,
    play(v, t, take) {
      v.slide(t, take ? 1500 : 1300, take ? 5600 : 4800, take ? 0.17 : 0.2, 0.24, {
        a: take ? 0.11 : 0.13,
      });
      v.tone(t, { f0: 520, f1: 880, dur: 0.16, gain: 0.025, send: 0.3 });
    },
  },
  toLibrary: {
    takes: 1,
    play(v, t) {
      v.slide(t, 3000, 1200, 0.14, 0.26, { a: 0.05 });
      v.square(t + 0.15, 0.6);
    },
  },
  play: {
    takes: 3,
    // A short slide and a thwap on the felt; take 3 lands slightly off, with a double contact.
    play(v, t, take) {
      const p = PLAY[take];
      let at = t;
      if (p.pre > 0) {
        v.slide(t, 2600, 1500, p.pre + 0.02, 0.18, { a: p.pre * 0.6 });
        at = t + p.pre;
      }
      v.land(at, p.body, p.lp);
      if (p.double)
        v.noise(at + 0.018, {
          type: "lowpass",
          f0: p.lp * 0.8,
          f1: 400,
          dur: 0.06,
          gain: 0.3,
          a: 0.002,
        });
    },
  },
  cast: {
    takes: 3,
    // Played like a permanent, with a short dark swell before and a low muted note under it.
    play(v, t, take) {
      const p = PLAY[take];
      const f = CAST_NOTES[take];
      v.noise(t, { type: "lowpass", f0: 300, f1: 1400, q: 2, dur: 0.2, gain: 0.08, a: 0.16 });
      v.land(t + 0.17, p.body, p.lp);
      v.tone(t + 0.17, {
        f0: f,
        f1: f * 0.9,
        dur: 0.32,
        type: "triangle",
        lp: 600,
        gain: 0.06,
        a: 0.01,
        send: 0.25,
      });
    },
  },
  tap: { takes: 3, play: (v, t, take) => tap(v, t, take) },
  untap: { takes: 2, play: (v, t, take) => untap(v, t, take) },
  untapAll: {
    takes: 1,
    // Five cards turned back in a ragged sweep, left to right.
    play(v, t) {
      let at = t;
      for (let i = 0; i < 5; i++) {
        untap(v, at, i % 2, -0.6 + i * 0.3, 1 - i * 0.08);
        at += 0.05 + v.r() * 0.03;
      }
    },
  },
  mana: {
    takes: 2,
    // A tap that sinks into the ground: a woody creak and a low, earthy thrum.
    play(v, t, take) {
      tap(v, t, take);
      const f = take ? 98 : 110;
      v.tone(t + 0.07, {
        f0: f * 1.15,
        f1: f,
        dur: 0.32,
        type: "triangle",
        lp: 520,
        gain: 0.12,
        a: 0.008,
        glide: 0.06,
      });
      v.tone(t + 0.07, { f0: f / 2, dur: 0.28, gain: 0.08, a: 0.01 });
      v.noise(t + 0.07, { f0: 280, q: 3, dur: 0.14, gain: 0.08, a: 0.01 });
    },
  },
  activate: {
    takes: 2,
    play(v, t, take) {
      v.click(t, 3200, 0.08);
      v.tone(t, { f0: 300, f1: 720, dur: 0.09, type: "triangle", lp: 1400, gain: 0.06 });
      v.pluck(t + 0.06, { f: take ? 349.23 : 392, dur: 0.22, gain: 0.07, lp: 1100 });
    },
  },
  foretell: {
    takes: 1,
    play(v, t) {
      v.noise(t, { type: "lowpass", f0: 1800, f1: 700, dur: 0.18, gain: 0.26, a: 0.07 });
      v.tone(t + 0.05, { f0: 196, dur: 0.75, gain: 0.06, a: 0.15, send: 0.6 });
      v.tone(t + 0.1, { f0: 293.66, dur: 0.6, gain: 0.035, a: 0.2, send: 0.6 });
    },
  },
  graveyard: { takes: 2, play: graveyard },
  exile: {
    takes: 2,
    // A brief portal: a resonant low sweep down, two tones beating against each other, and a sub
    // thump as it closes.
    play(v, t, take) {
      const len = take ? 0.5 : 0.42;
      v.noise(t, {
        type: "lowpass",
        f0: take ? 1400 : 1100,
        f1: 110,
        q: 5,
        dur: len,
        a: 0.05,
        gain: 0.3,
        send: 0.35,
      });
      v.tone(t, { f0: take ? 240 : 220, f1: 50, dur: len, gain: 0.13, a: 0.02, send: 0.3 });
      v.tone(t, { f0: take ? 252 : 231, f1: 53, dur: len, gain: 0.08, a: 0.02 });
      v.tone(t + len * 0.6, { f0: 60, f1: 42, dur: 0.25, gain: 0.12, a: 0.01 });
    },
  },
  counterAdd: {
    takes: 3,
    // A glass bead set down, with one small bounce.
    play(v, t, take) {
      const f = BEADS[take];
      v.tone(t, { f0: f, f1: f * 0.98, dur: 0.06, gain: 0.16, a: 0.001 });
      v.tone(t, { f0: f * 2.7, dur: 0.025, gain: 0.04, a: 0.001 });
      v.click(t, 7000, 0.07);
      v.tone(t + 0.05, { f0: f * 1.01, dur: 0.035, gain: 0.05, a: 0.001 });
    },
  },
  counterRemove: {
    takes: 2,
    play(v, t, take) {
      const f = take ? 1318.5 : 1480;
      v.tone(t, { f0: f, f1: f * 0.75, dur: 0.07, gain: 0.14, a: 0.001 });
      v.click(t, 5000, 0.06);
    },
  },
  token: {
    takes: 2,
    // A soft, muted pop on the felt.
    play(v, t, take) {
      const lo = take ? 140 : 120;
      v.tone(t, {
        f0: lo,
        f1: lo * 2.6,
        dur: 0.07,
        type: "triangle",
        lp: 900,
        gain: 0.18,
        a: 0.002,
        glide: 0.045,
      });
      v.noise(t, { type: "lowpass", f0: 700, dur: 0.05, gain: 0.1, a: 0.002 });
      v.tone(t + 0.05, {
        f0: lo * 2.6,
        f1: lo * 2.4,
        dur: 0.08,
        type: "triangle",
        lp: 900,
        gain: 0.04,
      });
    },
  },
  emblem: {
    takes: 1,
    play(v, t) {
      [196, 293.66, 392].forEach((f, i) =>
        v.bell(t + i * 0.05, {
          f,
          dur: 2.4,
          gain: 0.09,
          send: 0.8,
          kind: METAL,
          pan: (i - 1) * 0.25,
        }),
      );
      v.tone(t, { f0: 98, dur: 1.8, gain: 0.08, a: 0.05, send: 0.4 });
    },
  },
  attack: {
    takes: 2,
    // A swoosh into a war drum; take 2 has a second drum, for a wider attack.
    play(v, t, take) {
      v.noise(t, { f0: 500, f1: 2600, q: 1.4, dur: 0.24, a: 0.16, gain: 0.28 });
      const drum = (at: number, g: number) => {
        v.tone(at, { f0: 95, f1: 52, dur: 0.32, gain: 0.75 * g, a: 0.002 });
        v.noise(at, { type: "lowpass", f0: 500, f1: 150, dur: 0.12, gain: 0.3 * g, a: 0.001 });
      };
      drum(t + 0.21, 1);
      if (take) drum(t + 0.36, 0.7);
    },
  },
  block: {
    takes: 1,
    play(v, t) {
      v.tone(t, { f0: 150, f1: 70, dur: 0.12, gain: 0.5, a: 0.001 });
      v.noise(t, { f0: 2600, q: 1, dur: 0.04, gain: 0.3, a: 0.001 });
      v.bell(t, { f: 380, dur: 0.6, gain: 0.1, send: 0.4, kind: SHIELD });
    },
  },
  damage: { takes: 3, play: (v, t, take) => hit(v, t, take) },
  commanderDamage: {
    takes: 1,
    play(v, t) {
      hit(v, t, 1, 1.15);
      v.bell(t + 0.02, { f: 146.83, dur: 1.6, gain: 0.1, kind: METAL, send: 0.7 });
    },
  },
  lifeLoss: { takes: 2, play: (v, t, take) => lifeStep(v, t, LIFE[take][0], LIFE[take][1]) },
  lifeGain: { takes: 2, play: (v, t, take) => lifeStep(v, t, LIFE[take][1], LIFE[take][0]) },
  turnYours: {
    takes: 1,
    play(v, t) {
      v.mallet(t, { f: 196 });
      v.mallet(t + 0.15, { f: 293.66 });
    },
  },
  turnTheirs: {
    takes: 1,
    // The same mallet lower and falling, so whose turn it is needs no look.
    play(v, t) {
      v.mallet(t, { f: 220, gain: 0.12 });
      v.mallet(t + 0.15, { f: 164.81, gain: 0.12 });
    },
  },
  pass: {
    takes: 2,
    play(v, t, take) {
      if (take) v.knock(t, 300, 1.25);
      else {
        v.knock(t, 340);
        v.knock(t + 0.13, 320, 0.85);
      }
    },
  },
  choose: {
    takes: 1,
    play(v, t) {
      v.tone(t, { f0: 1320, dur: 0.03, type: "triangle", gain: 0.07, a: 0.001 });
      v.click(t, 6000, 0.05);
    },
  },
  undo: {
    takes: 1,
    play(v, t) {
      v.noise(t, { f0: 3200, f1: 900, dur: 0.2, a: 0.16, gain: 0.16 });
      v.tone(t, { f0: 880, f1: 520, dur: 0.18, gain: 0.03, a: 0.1 });
    },
  },
  redo: {
    takes: 1,
    play(v, t) {
      v.noise(t, { f0: 900, f1: 3200, dur: 0.2, a: 0.16, gain: 0.16 });
      v.tone(t, { f0: 520, f1: 880, dur: 0.18, gain: 0.03, a: 0.1 });
    },
  },
  eliminated: {
    takes: 1,
    play(v, t) {
      v.tone(t, { f0: 196, f1: 49, dur: 1.2, gain: 0.18, a: 0.01 });
      v.noise(t, { type: "lowpass", f0: 260, f1: 80, dur: 1.4, a: 0.35, gain: 0.25 });
      v.bell(t + 0.1, { f: 98, dur: 2, gain: 0.06, kind: METAL, send: 0.8 });
    },
  },
  win: {
    takes: 1,
    // A climbing major arpeggio that settles into a held chord.
    play(v, t) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const at = [0, 0.1, 0.2, 0.32];
      notes.forEach((f, i) =>
        v.bell(t + at[i], { f, dur: 1.1, gain: 0.08, send: 0.7, pan: (i - 1.5) * 0.2 }),
      );
      for (const f of notes) v.bell(t + 0.55, { f, dur: 2.2, gain: 0.045, send: 0.8 });
    },
  },
  lose: {
    takes: 1,
    // A soft minor line stepping down: disappointing, never mocking.
    play(v, t) {
      [659.25, 523.25, 440, 329.63].forEach((f, i) =>
        v.tone(t + i * 0.2, {
          f0: f,
          dur: i === 3 ? 1.4 : 0.5,
          gain: 0.08,
          a: 0.01,
          type: "triangle",
          lp: 1800,
          send: 0.6,
        }),
      );
    },
  },
};

// ---------- the graph ----------

/** The graph for `ctx`: dry → compressor, a small wooden room on the send, 4 s of white noise. */
export function buildGraph(ctx: BaseAudioContext, out: AudioNode = ctx.destination): Graph {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 8;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.003;
  comp.release.value = 0.16;
  const level = ctx.createGain();
  level.gain.value = LEVEL;
  comp.connect(level);
  level.connect(out);
  const dry = ctx.createGain();
  dry.connect(comp);

  const rate = ctx.sampleRate;
  const rn = mulberry32(1337);
  const noise = ctx.createBuffer(1, rate * 4, rate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rn() * 2 - 1;

  // Stereo noise with an exponential tail, darkened as it decays.
  const ri = mulberry32(77);
  const irLen = Math.floor(rate * 1.7);
  const ir = ctx.createBuffer(2, irLen, rate);
  for (let c = 0; c < 2; c++) {
    const ch = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < irLen; i++) {
      const x = i / irLen;
      lp += (0.5 - 0.42 * x) * (ri() * 2 - 1 - lp);
      ch[i] = lp * Math.pow(1 - x, 3.2);
    }
  }
  const room = ctx.createConvolver();
  room.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  wet.connect(room);
  room.connect(comp);

  return { ctx, dry, wet, noise };
}

export interface TableSynth {
  /** Play `id` `delay` seconds from now: a take other than its last, humanized. */
  play: (id: SoundId, delay?: number) => void;
  /** Make (or resume) the audio context. Called from a press, which a webview's autoplay rule
   *  requires before a context made outside one may sound. */
  unlock: () => void;
}

/** A context of the webview's, or `null` where there is none (jsdom, a host without audio). */
function webContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

/** Which take to play: random, never `last` while there is another. */
export function nextTake(takes: number, last: number | undefined, random = Math.random): number {
  if (takes <= 1) return 0;
  let take = Math.floor(random() * (takes - 1));
  if (last !== undefined && take >= last) take += 1;
  return take;
}

/**
 * A synth that makes its context on first use — no audio is touched until the board sounds — and
 * plays nothing at all where `make` finds none.
 */
export function createTableSynth(make: () => AudioContext | null = webContext): TableSynth {
  let ctx: AudioContext | null = null;
  let graph: Graph | null = null;
  let tried = false;
  const last = new Map<SoundId, number>();

  const ready = (): Graph | null => {
    if (!tried) {
      tried = true;
      ctx = make();
      if (ctx !== null) graph = buildGraph(ctx);
    }
    if (ctx?.state === "suspended") void ctx.resume().catch(() => undefined);
    return graph;
  };

  return {
    unlock: () => void ready(),
    play: (id, delay = 0) => {
      const g = ready();
      if (g === null) return;
      const recipe = RECIPES[id];
      const take = nextTake(recipe.takes, last.get(id));
      last.set(id, take);
      const nudge = () => 1 + (Math.random() - 0.5) * 0.06;
      const voice = new Voice(g, rngFor(`${id}:${take}`), nudge(), nudge());
      recipe.play(voice, g.ctx.currentTime + 0.02 + Math.max(0, delay), take);
    },
  };
}
