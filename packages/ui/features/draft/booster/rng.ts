/**
 * The random numbers every booster is opened with.
 *
 * **A seeded generator, never `Math.random`**, because the same seed has to open the same packs
 * twice: a test pins exact cards, and a draft hands its boosters to Rust as printing ids — the
 * page makes them, so a seed written down is a table that can be dealt again
 * (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §3–§4).
 */

/** A uniform number in `[0, 1)`, one per call. */
export type Rng = () => number;

/**
 * mulberry32 — a 32-bit state, one multiply-xorshift round per draw.
 *
 * Small and fast enough for the 10 000-pack simulation (well under a microsecond a draw), and
 * its period of 2^32 is far beyond any one page's needs. Not for anything that must be
 * unpredictable: a seed is a convenience here, never a secret.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh 32-bit seed from the platform's generator — a new pack each press. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
