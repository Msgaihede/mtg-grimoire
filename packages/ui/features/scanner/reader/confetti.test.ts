import { describe, expect, it } from "vitest";
import { PRICE_TIERS } from "../sounds/scanSounds";
import {
  CONFETTI,
  CONFETTI_TOKEN,
  confettiEnd,
  confettiPieces,
  confettiSeed,
  DESIGN_HEIGHT,
  FADE,
  flashAt,
  GLOW_MS,
  glowAt,
  JACKPOT_FLASH_MS,
  FLASH_MS,
  OUT,
  pieceAt,
  RAIN,
  SECOND_WAVE,
  type ConfettiPiece,
} from "./confetti";

/** The design canvas's own picture: 640 wide, 600 tall, the burst leaving 64 px above the foot. */
const BOX = { width: 640, height: 600, originX: 320, originY: 536 };

/** A thousandth of a millisecond: how far inside a piece's end a test asks for its last pose. */
const EPSILON = 0.001;

const burstOf = (pieces: ConfettiPiece[]) => pieces.filter((p) => p.kind === "burst");
const rainOf = (pieces: ConfettiPiece[]) => pieces.filter((p) => p.kind === "rain");

describe("CONFETTI", () => {
  it("throws more pieces, further and longer, the higher the tier", () => {
    for (let i = 1; i < PRICE_TIERS.length; i++) {
      const lower = CONFETTI[PRICE_TIERS[i - 1]];
      const higher = CONFETTI[PRICE_TIERS[i]];
      expect(higher.burst).toBeGreaterThan(lower.burst);
      expect(higher.reach[1]).toBeGreaterThan(lower.reach[1]);
      expect(higher.duration[1]).toBeGreaterThan(lower.duration[1]);
      expect(higher.colors.length).toBeGreaterThanOrEqual(lower.colors.length);
    }
  });

  it("keeps the flash for the top two tiers and the glow and the rain for the jackpot", () => {
    expect(PRICE_TIERS.filter((t) => CONFETTI[t].flash)).toEqual(["tier3", "jackpot"]);
    expect(PRICE_TIERS.filter((t) => CONFETTI[t].glow)).toEqual(["jackpot"]);
    expect(PRICE_TIERS.filter((t) => CONFETTI[t].rain > 0)).toEqual(["jackpot"]);
  });

  it("names each colour's token as --color-<name>", () => {
    for (const [name, token] of Object.entries(CONFETTI_TOKEN))
      expect(token).toBe(`--color-${name}`);
  });
});

describe("confettiPieces", () => {
  it("throws tier1's 26 pieces in its two colours, and no rain", () => {
    const pieces = confettiPieces("tier1", BOX, 7);
    expect(pieces).toHaveLength(26);
    expect(rainOf(pieces)).toHaveLength(0);
    expect(new Set(pieces.map((p) => p.color))).toEqual(new Set(CONFETTI.tier1.colors));
    expect(pieces.every((p) => p.shape === "chip")).toBe(true);
  });

  it("deals every colour a tier names into each burst of it", () => {
    for (const tier of PRICE_TIERS) {
      const colors = new Set(confettiPieces(tier, BOX, 11).map((p) => p.color));
      expect(colors).toEqual(new Set(CONFETTI[tier].colors));
    }
  });

  it("throws the jackpot's 176 burst pieces and 120 rain, 296 in all", () => {
    const pieces = confettiPieces("jackpot", BOX, 7);
    expect(pieces).toHaveLength(296);
    expect(burstOf(pieces)).toHaveLength(176);
    expect(rainOf(pieces)).toHaveLength(120);
  });

  it("sends every third jackpot burst piece as a second wave, and nothing else late", () => {
    const wave = SECOND_WAVE.jackpot;
    expect(wave).toEqual({ every: 3, delay: [320, 460] });
    const burst = burstOf(confettiPieces("jackpot", BOX, 3));
    burst.forEach((piece, i) => {
      if (i % 3 === 2) {
        expect(piece.delay).toBeGreaterThanOrEqual(320);
        expect(piece.delay).toBeLessThanOrEqual(460);
      } else {
        expect(piece.delay).toBe(0);
      }
    });
    expect(burstOf(confettiPieces("tier3", BOX, 3)).every((p) => p.delay === 0)).toBe(true);
  });

  it("drops the rain from above the top, across the width, inside its ranges", () => {
    for (const piece of rainOf(confettiPieces("jackpot", BOX, 5))) {
      expect(piece.y).toBeLessThan(0);
      expect(piece.x).toBeGreaterThanOrEqual(0);
      expect(piece.x).toBeLessThanOrEqual(BOX.width);
      expect(piece.fall).toBeGreaterThanOrEqual(RAIN.fall[0]);
      expect(piece.fall).toBeLessThanOrEqual(RAIN.fall[1]);
      expect(piece.duration).toBeGreaterThanOrEqual(RAIN.duration[0]);
      expect(piece.duration).toBeLessThanOrEqual(RAIN.duration[1]);
      expect(piece.delay).toBeGreaterThanOrEqual(RAIN.delay[0]);
      expect(piece.delay).toBeLessThanOrEqual(RAIN.delay[1]);
      expect(Math.abs(piece.sway)).toBeLessThanOrEqual(RAIN.sway);
    }
  });

  it("leaves the origin inside the tier's cone, reach, fall and duration", () => {
    for (const tier of PRICE_TIERS) {
      const spec = CONFETTI[tier];
      const half = (spec.spread / 2) * (Math.PI / 180);
      for (const piece of burstOf(confettiPieces(tier, BOX, 13))) {
        expect(piece.x).toBe(BOX.originX);
        expect(piece.y).toBe(BOX.originY);
        expect(Math.abs(piece.angle + Math.PI / 2)).toBeLessThanOrEqual(half);
        expect(piece.reach).toBeGreaterThanOrEqual(spec.reach[0]);
        expect(piece.reach).toBeLessThanOrEqual(spec.reach[1]);
        expect(piece.fall).toBeGreaterThanOrEqual(spec.fall[0]);
        expect(piece.fall).toBeLessThanOrEqual(spec.fall[1]);
        expect(piece.duration).toBeGreaterThanOrEqual(spec.duration[0]);
        expect(piece.duration).toBeLessThanOrEqual(spec.duration[1]);
      }
    }
  });

  it("scales every length by the picture's height over 600, and no time", () => {
    const full = confettiPieces("jackpot", BOX, 9);
    const half = confettiPieces(
      "jackpot",
      { width: 320, height: DESIGN_HEIGHT / 2, originX: 160, originY: 268 },
      9,
    );
    full.forEach((piece, i) => {
      const small = half[i];
      expect(small.reach).toBeCloseTo(piece.reach / 2);
      expect(small.fall).toBeCloseTo(piece.fall / 2);
      expect(small.sway).toBeCloseTo(piece.sway / 2);
      expect(small.width).toBeCloseTo(piece.width / 2);
      expect(small.length).toBeCloseTo(piece.length / 2);
      expect(small.delay).toBe(piece.delay);
      expect(small.duration).toBe(piece.duration);
    });
  });

  it("throws the same pieces for the same seed, and others for another", () => {
    expect(confettiPieces("tier3", BOX, 42)).toEqual(confettiPieces("tier3", BOX, 42));
    expect(confettiPieces("tier3", BOX, 42)).not.toEqual(confettiPieces("tier3", BOX, 43));
  });

  it("makes some streamers at a tier that has them", () => {
    const pieces = confettiPieces("jackpot", BOX, 1);
    const streamers = pieces.filter((p) => p.shape === "streamer");
    expect(streamers.length).toBeGreaterThan(0);
    expect(streamers.length).toBeLessThan(pieces.length);
    for (const s of streamers) expect(s.length).toBeGreaterThan(s.width);
  });
});

describe("pieceAt", () => {
  const pieces = confettiPieces("jackpot", BOX, 21);
  const late = burstOf(pieces).find((p) => p.delay > 0);
  const rain = rainOf(pieces)[0];

  it("is null a millisecond before a piece appears and a millisecond after it is gone", () => {
    for (const piece of [pieces[0], late, rain]) {
      if (piece === undefined) throw new Error("no such piece");
      expect(pieceAt(piece, piece.delay - 1)).toBeNull();
      expect(pieceAt(piece, piece.delay)).not.toBeNull();
      // A hair inside the end: `(delay + duration) - delay` is not exactly `duration` for every
      // pair in floating point, so the last instant is asked for just short of it.
      expect(pieceAt(piece, piece.delay + piece.duration - EPSILON)).not.toBeNull();
      expect(pieceAt(piece, piece.delay + piece.duration + 1)).toBeNull();
    }
  });

  it("starts a burst piece at the origin and has it above the origin when it is out", () => {
    for (const piece of burstOf(pieces)) {
      const start = pieceAt(piece, piece.delay);
      expect(start?.x).toBeCloseTo(BOX.originX);
      expect(start?.y).toBeCloseTo(BOX.originY);
      const out = pieceAt(piece, piece.delay + OUT * piece.duration);
      expect(out?.y).toBeLessThan(BOX.originY);
    }
  });

  it("flies a burst piece the whole of its reach, then drops it the whole of its fall", () => {
    const piece = burstOf(pieces)[0];
    const out = pieceAt(piece, piece.delay + OUT * piece.duration);
    const topY = BOX.originY + Math.sin(piece.angle) * piece.reach;
    expect(out?.y).toBeCloseTo(topY);
    expect(out?.x).toBeCloseTo(BOX.originX + Math.cos(piece.angle) * piece.reach);
    const end = pieceAt(piece, piece.delay + piece.duration);
    expect(end?.y).toBeCloseTo(topY + piece.fall);
  });

  it("drops a rain piece its whole fall at a steady pace", () => {
    const halfway = pieceAt(rain, rain.delay + rain.duration / 2);
    expect(halfway?.y).toBeCloseTo(rain.y + rain.fall / 2);
    expect(pieceAt(rain, rain.delay + rain.duration - EPSILON)?.y).toBeCloseTo(rain.y + rain.fall);
  });

  it("holds full opacity until the last 14 % and fades to nothing", () => {
    const piece = pieces[0];
    expect(pieceAt(piece, piece.delay + (1 - FADE) * piece.duration)?.opacity).toBeCloseTo(1);
    expect(pieceAt(piece, piece.delay + (1 - FADE / 2) * piece.duration)?.opacity).toBeCloseTo(0.5);
    expect(pieceAt(piece, piece.delay + piece.duration)?.opacity).toBeCloseTo(0);
  });
});

describe("the flash, the glow and the end", () => {
  it("flashes only tier3 and the jackpot, the jackpot's for longer", () => {
    expect(flashAt("tier1", 0)).toBeNull();
    expect(flashAt("tier2", 0)).toBeNull();
    expect(flashAt("tier3", 0)).toBe(1);
    expect(flashAt("tier3", FLASH_MS)).toBe(0);
    expect(flashAt("tier3", FLASH_MS + 1)).toBeNull();
    expect(flashAt("jackpot", FLASH_MS + 1)).toBeGreaterThan(0);
    expect(flashAt("jackpot", JACKPOT_FLASH_MS + 1)).toBeNull();
  });

  it("swells and fades the jackpot's glow over 2200 ms, and no other tier's", () => {
    expect(glowAt("tier3", GLOW_MS / 2)).toBeNull();
    expect(glowAt("jackpot", 0)).toBeCloseTo(0);
    expect(glowAt("jackpot", GLOW_MS / 2)).toBeCloseTo(1);
    expect(glowAt("jackpot", GLOW_MS + 1)).toBeNull();
  });

  it("ends a burst when its last piece is gone", () => {
    for (const tier of PRICE_TIERS) {
      const pieces = confettiPieces(tier, BOX, 17);
      const end = confettiEnd(tier, pieces);
      expect(pieces.every((p) => pieceAt(p, end + 1) === null)).toBe(true);
      expect(pieces.some((p) => pieceAt(p, end - EPSILON) !== null)).toBe(true);
    }
  });

  it("seeds each stamp its own burst, and the same stamp the same one", () => {
    expect(confettiSeed("a:1")).toBe(confettiSeed("a:1"));
    expect(confettiSeed("a:1")).not.toBe(confettiSeed("a:2"));
  });
});
