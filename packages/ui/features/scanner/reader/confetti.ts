/**
 * The confetti a landing throws over the camera picture, by the price tier its sound plays at —
 * the pure half: which pieces there are, where each one is at a given millisecond, and how bright
 * the flash and the edge glow are. `TierConfetti` draws it on a canvas; nothing here touches one.
 *
 * **Every length is tuned for a 600 px tall picture** and scaled by `height / 600`, so a phone's
 * short picture and a desktop's tall one throw the same shape of burst — the pieces' sizes, how far
 * they fly and how far they fall alike. Times are not scaled: a jackpot lasts as long on a phone.
 */
import type { PriceTier } from "../sounds/scanSounds";

/** The colours a piece can be — each a token of the app's palette, `--color-<name>`. */
export type ConfettiColor =
  "accent" | "text" | "mana-w" | "mana-u" | "mana-b" | "mana-r" | "mana-g";

/**
 * Each colour's custom property, spelled out rather than built from the name, so a search for a
 * token finds the confetti among its users.
 */
export const CONFETTI_TOKEN: Record<ConfettiColor, string> = {
  accent: "--color-accent",
  text: "--color-text",
  "mana-w": "--color-mana-w",
  "mana-u": "--color-mana-u",
  "mana-b": "--color-mana-b",
  "mana-r": "--color-mana-r",
  "mana-g": "--color-mana-g",
};

/** One tier's burst — {@link CONFETTI}'s row. Lengths in pixels of a 600 px tall picture. */
export interface ConfettiSpec {
  /** How many pieces fly out from behind the Added popup. */
  burst: number;
  /** How many fall from the top of the picture as well — the jackpot's rain. */
  rain: number;
  /** The width of the cone the burst leaves in, in degrees, centred straight up. */
  spread: number;
  /** How far a burst piece flies out along its angle, least and most. */
  reach: [number, number];
  /** How far a burst piece falls once it is out, least and most. */
  fall: [number, number];
  /** How long a burst piece lives, in milliseconds, least and most. */
  duration: [number, number];
  /** A piece's size; a chip is about this long, a streamer a few times it. */
  size: number;
  /** The share of the pieces that are long thin streamers rather than chips. */
  streamers: number;
  /** The colours the pieces take, in turn. */
  colors: readonly ConfettiColor[];
  /** A gold glow at the origin as the burst leaves. */
  flash: boolean;
  /** A gold edge round the whole picture, swelling and fading. */
  glow: boolean;
}

/**
 * **More pieces, further, longer and in more colours the higher the tier** — the design canvas's
 * values. The first tier is a gold-and-white puff; the third adds the five mana colours and a
 * flash; the jackpot adds rain from the top (`RAIN`), a second wave (`SECOND_WAVE`) and the edge
 * glow.
 */
export const CONFETTI: Record<PriceTier, ConfettiSpec> = {
  tier1: {
    burst: 26,
    rain: 0,
    spread: 62,
    reach: [70, 165],
    fall: [80, 140],
    duration: [1100, 1450],
    size: 6,
    streamers: 0,
    colors: ["accent", "mana-w"],
    flash: false,
    glow: false,
  },
  tier2: {
    burst: 58,
    rain: 0,
    spread: 76,
    reach: [120, 275],
    fall: [140, 240],
    duration: [1300, 1850],
    size: 7,
    streamers: 0.15,
    colors: ["accent", "mana-w", "text"],
    flash: false,
    glow: false,
  },
  tier3: {
    burst: 112,
    rain: 0,
    spread: 88,
    reach: [170, 410],
    fall: [200, 340],
    duration: [1600, 2350],
    size: 8,
    streamers: 0.25,
    colors: ["accent", "mana-w", "mana-u", "mana-r", "mana-g", "mana-b"],
    flash: true,
    glow: false,
  },
  jackpot: {
    burst: 176,
    rain: 120,
    spread: 102,
    reach: [230, 560],
    fall: [260, 470],
    duration: [2000, 3000],
    size: 10,
    streamers: 0.3,
    colors: ["accent", "mana-w", "mana-u", "mana-r", "mana-g", "mana-b", "text"],
    flash: true,
    glow: true,
  },
};

/** The picture height {@link CONFETTI}'s lengths are tuned for. */
export const DESIGN_HEIGHT = 600;

/**
 * The jackpot's second wave: **every third burst piece leaves late**, 320–460 ms after the rest,
 * so the burst reads as two pops rather than one bigger one. No other tier has one.
 */
export const SECOND_WAVE: Partial<Record<PriceTier, { every: number; delay: [number, number] }>> = {
  jackpot: { every: 3, delay: [320, 460] },
};

/**
 * A rain piece: dropped from just above the top of the picture somewhere across its width, it
 * falls `fall` (scaled, like every length) at a steady pace over `duration` ms, starting `delay` ms
 * after the landing, and sways up to `sway` either side as it goes.
 */
export const RAIN = {
  fall: [300, 660],
  duration: [1900, 3300],
  delay: [120, 1900],
  sway: 70,
} as const;

/** How long the flash takes to fade, in milliseconds — longer for the jackpot. */
export const FLASH_MS = 900;
export const JACKPOT_FLASH_MS = 1400;
/** How long the jackpot's edge glow takes to swell and fade, in milliseconds. */
export const GLOW_MS = 2200;

/** The share of a burst piece's life spent flying out; it falls for the rest. */
export const OUT = 0.34;
/** The share at the end of every piece's life over which it fades out. */
export const FADE = 0.14;

/** One piece of confetti, as {@link confettiPieces} throws it and {@link pieceAt} moves it. */
export interface ConfettiPiece {
  /** Out from the origin, or down from the top. */
  kind: "burst" | "rain";
  /** A small card of paper, or a long thin ribbon. */
  shape: "chip" | "streamer";
  color: ConfettiColor;
  /** Where it starts, in the box's CSS pixels. */
  x: number;
  y: number;
  /** The direction a burst piece flies out, in radians: `-π/2` is straight up. */
  angle: number;
  /** How far a burst piece flies out along `angle`; 0 for rain. */
  reach: number;
  /** How far it falls: once out for a burst piece, over its whole life for rain. */
  fall: number;
  /** How far a rain piece sways either side; 0 for a burst piece. */
  sway: number;
  /** How fast a rain piece sways, in radians per millisecond; 0 for a burst piece. */
  swing: number;
  /** When it appears, in milliseconds after the landing. */
  delay: number;
  /** How long it lives once it has appeared, in milliseconds. */
  duration: number;
  /** Its size across and along, in CSS pixels. */
  width: number;
  length: number;
  /** Its turn when it appears, in radians, and how fast it turns, in radians per millisecond. */
  turn: number;
  spin: number;
  /** How fast it tumbles end over end, in radians per millisecond, and where in it it starts. */
  tumble: number;
  phase: number;
}

/** Where a piece is at one moment — what the canvas draws. */
export interface PiecePose {
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  /** The tumble: 1 face on, 0 edge on, below 0 the back face. */
  scaleY: number;
}

/** The box the confetti flies in: the picture's size and where the burst leaves from. */
export interface ConfettiBox {
  width: number;
  height: number;
  originX: number;
  originY: number;
}

/**
 * Pure and seeded: **the same tier, box and seed throw the same pieces**, so a story or a test can
 * hold a burst still. The burst pieces come first, then the rain.
 *
 * Colours are dealt in turn rather than drawn at random, so every colour a tier names is in every
 * burst of it. Whether a piece is a streamer is drawn, at the tier's share.
 */
export function confettiPieces(tier: PriceTier, box: ConfettiBox, seed: number): ConfettiPiece[] {
  const spec = CONFETTI[tier];
  const random = mulberry32(seed);
  const between = ([lo, hi]: readonly [number, number]) => lo + (hi - lo) * random();
  const scale = box.height / DESIGN_HEIGHT;
  const size = spec.size * scale;
  const wave = SECOND_WAVE[tier];
  const pieces: ConfettiPiece[] = [];

  for (let i = 0; i < spec.burst; i++) {
    const shape = shapeOf(random() < spec.streamers, size, between);
    const angle = -Math.PI / 2 + (random() - 0.5) * spec.spread * (Math.PI / 180);
    const reach = between(spec.reach) * scale;
    const fall = between(spec.fall) * scale;
    const duration = between(spec.duration);
    const late = wave !== undefined && i % wave.every === wave.every - 1;
    const delay = late ? between(wave.delay) : 0;
    pieces.push({
      kind: "burst",
      ...shape,
      color: spec.colors[i % spec.colors.length],
      x: box.originX,
      y: box.originY,
      angle,
      reach,
      fall,
      sway: 0,
      swing: 0,
      delay,
      duration,
      ...tumbleOf(between),
    });
  }

  for (let i = 0; i < spec.rain; i++) {
    const shape = shapeOf(random() < spec.streamers, size, between);
    const x = random() * box.width;
    const fall = between(RAIN.fall) * scale;
    const duration = between(RAIN.duration);
    const delay = between(RAIN.delay);
    const sway = (random() * 2 - 1) * RAIN.sway * scale;
    // One sway a second and a half to two and a half: slow enough to read as drifting paper.
    const swing = (2 * Math.PI) / between([1500, 2500]);
    pieces.push({
      kind: "rain",
      ...shape,
      color: spec.colors[i % spec.colors.length],
      x,
      // Above the top edge by its own length, so it enters the picture rather than appearing in it.
      y: -shape.length,
      angle: Math.PI / 2,
      reach: 0,
      fall,
      sway,
      swing,
      delay,
      duration,
      ...tumbleOf(between),
    });
  }

  return pieces;
}

/**
 * Where `piece` is `ms` after the landing, or `null` while it has not appeared yet and once it is
 * gone — inclusive at both ends.
 *
 * **A burst piece flies out to `reach` along its angle over the first {@link OUT} of its life,
 * easing out, then falls `fall`, easing in** — so it slows to a hang at the top of its flight and
 * only then drops, with no jump in speed between the two. A rain piece falls at a steady pace,
 * swaying. Every piece fades over the last {@link FADE} of its life.
 */
export function pieceAt(piece: ConfettiPiece, ms: number): PiecePose | null {
  const age = ms - piece.delay;
  if (age < 0 || age > piece.duration) return null;
  const t = age / piece.duration;

  let x: number;
  let y: number;
  if (piece.kind === "burst") {
    const out = easeOut(Math.min(t / OUT, 1));
    const down = t > OUT ? easeIn((t - OUT) / (1 - OUT)) : 0;
    x = piece.x + Math.cos(piece.angle) * piece.reach * out;
    y = piece.y + Math.sin(piece.angle) * piece.reach * out + piece.fall * down;
  } else {
    x = piece.x + piece.sway * Math.sin(piece.phase + piece.swing * age);
    y = piece.y + piece.fall * t;
  }

  return {
    x,
    y,
    rotation: piece.turn + piece.spin * age,
    opacity: t <= 1 - FADE ? 1 : (1 - t) / FADE,
    scaleY: Math.cos(piece.phase + piece.tumble * age),
  };
}

/**
 * How bright the flash at the origin is `ms` after the landing — 1 at the landing, fading fast and
 * then slowly to 0 at {@link FLASH_MS} ({@link JACKPOT_FLASH_MS} for the jackpot) — or `null` for a
 * tier with no flash and outside it.
 */
export function flashAt(tier: PriceTier, ms: number): number | null {
  if (!CONFETTI[tier].flash) return null;
  const length = tier === "jackpot" ? JACKPOT_FLASH_MS : FLASH_MS;
  if (ms < 0 || ms > length) return null;
  return (1 - ms / length) ** 2;
}

/**
 * How bright the edge glow is `ms` after the landing — one swell from 0 to 1 and back over
 * {@link GLOW_MS} — or `null` for a tier with no glow and outside it.
 */
export function glowAt(tier: PriceTier, ms: number): number | null {
  if (!CONFETTI[tier].glow) return null;
  if (ms < 0 || ms > GLOW_MS) return null;
  return Math.sin((Math.PI * ms) / GLOW_MS);
}

/**
 * When a burst is over, in milliseconds after the landing: the last piece gone, and the flash and
 * the glow with it. The canvas stops drawing there.
 */
export function confettiEnd(tier: PriceTier, pieces: readonly ConfettiPiece[]): number {
  const spec = CONFETTI[tier];
  let end = 0;
  for (const piece of pieces) end = Math.max(end, piece.delay + piece.duration);
  if (spec.flash) end = Math.max(end, tier === "jackpot" ? JACKPOT_FLASH_MS : FLASH_MS);
  if (spec.glow) end = Math.max(end, GLOW_MS);
  return end;
}

/**
 * A seed for {@link confettiPieces} out of a landing's stamp (FNV-1a), so each landing throws its
 * own burst and the same landing, drawn again, throws the same one.
 */
export function confettiSeed(stamp: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stamp.length; i++) {
    hash ^= stamp.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A chip is about `size` long and over half as wide; a streamer a thin ribbon a few times it. */
function shapeOf(
  streamer: boolean,
  size: number,
  between: (range: readonly [number, number]) => number,
): Pick<ConfettiPiece, "shape" | "width" | "length"> {
  if (streamer)
    return { shape: "streamer", width: size * 0.32, length: size * between([2.4, 3.6]) };
  const length = size * between([0.85, 1.15]);
  return { shape: "chip", width: length * between([0.55, 0.8]), length };
}

/**
 * A piece's turn and tumble: any turn to start, a third to two turns a second either way, and one
 * to two and a half flips a second — paper, not a spinning coin.
 */
function tumbleOf(
  between: (range: readonly [number, number]) => number,
): Pick<ConfettiPiece, "turn" | "spin" | "tumble" | "phase"> {
  const turn = between([0, 2 * Math.PI]);
  const spin = between([0.002, 0.012]) * (between([0, 1]) < 0.5 ? -1 : 1);
  const tumble = between([0.006, 0.016]);
  const phase = between([0, 2 * Math.PI]);
  return { turn, spin, tumble, phase };
}

/** Out fast, slowing to a stop. */
function easeOut(p: number): number {
  return 1 - (1 - p) ** 3;
}

/** From a standstill, gathering speed. */
function easeIn(p: number): number {
  return p * p;
}

/** A small, fast, seeded generator of numbers in `[0, 1)` — Mulberry32. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
