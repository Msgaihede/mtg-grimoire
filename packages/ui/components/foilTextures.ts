/**
 * The pattern each foil drawing masks with, handed to its layers as CSS custom properties.
 *
 * **Imported here and set as properties rather than written as `url()`s in `index.css`**, so the
 * bundler owns their addresses (hashed, same-origin, under the CSP's `img-src 'self'`) and the
 * stylesheet names only `var(--foil-tex-…)`. A drawing that asks for none gets no property, so a
 * plain traditional foil fetches nothing.
 *
 * The pictures are generated: `node scripts/foil-textures.ts` rewrites every one of them, and that
 * script is where each shape is described. Ripple's is not a picture: its nine rings are CSS
 * gradients, built here from `RIPPLE_RINGS`, so each ring can grow and fade on its own.
 */
import confetti from "@/assets/foil/confetti.png";
import contour from "@/assets/foil/contour.png";
import galaxyA from "@/assets/foil/galaxy-a.png";
import galaxyB from "@/assets/foil/galaxy-b.png";
import grain from "@/assets/foil/grain.png";
import manaDiscs from "@/assets/foil/mana-discs.png";
import manaGlyphs from "@/assets/foil/mana-glyphs.png";
import shards from "@/assets/foil/shards.png";
import surge from "@/assets/foil/surge.png";
import { type FoilEffect, RIPPLE_RINGS } from "@/lib/foilEffect";

const url = (src: string) => `url("${src}")`;

/** A ring's half-width, in card widths. */
const RIPPLE_BAND = 0.04;

/**
 * Across a ring, outside to inside: red to violet (the order a real ripple foil shows), each stop
 * as `[offset in half-widths, hue, alpha]`, clear at both edges.
 */
const RIPPLE_STOPS: readonly (readonly [number, number, number])[] = [
  [-1, 275, 0],
  [-0.66, 268, 0.45],
  [-0.33, 220, 0.85],
  [0, 140, 1],
  [0.33, 55, 0.85],
  [0.66, 15, 0.45],
  [1, 0, 0],
];

const pct = (n: number) => `${Number(n.toFixed(2))}%`;

/**
 * Ripple's nine rings as one `background-image` list. Ring `i` reads `--foil-gI` (its size, 0.7 to
 * 1.3) and `--foil-sI` (how much it shows, 0 to 1) — both written by `foilLight`. A radial
 * gradient's stops are in % of the ray to the farthest corner, so each ring's radius is converted
 * for a 5:7 card from its own centre.
 */
export function rippleImage(): string {
  const aspect = 7 / 5;
  return RIPPLE_RINGS.map(([cx, cy, r], i) => {
    const y = cy * aspect;
    const far = Math.max(
      Math.hypot(cx, y),
      Math.hypot(1 - cx, y),
      Math.hypot(cx, aspect - y),
      Math.hypot(1 - cx, aspect - y),
    );
    const radius = (r / far) * 100;
    const band = (RIPPLE_BAND / far) * 100;
    const stops = RIPPLE_STOPS.map(([t, hue, a]) => {
      const off = t * band;
      const at = `calc(var(--foil-g${i + 1}) * ${pct(radius)} ${off < 0 ? "-" : "+"} ${pct(Math.abs(off))})`;
      const alpha = a === 0 ? "0" : `calc(var(--foil-s${i + 1}) * ${a})`;
      return `hsl(${hue} 100% 60% / ${alpha}) ${at}`;
    });
    return `radial-gradient(circle at ${pct(cx * 100)} ${pct(cy * 100)}, ${stops.join(", ")})`;
  }).join(", ");
}

/**
 * Up to three CSS images per drawing, in the order its CSS reads them: `--foil-tex-1` first.
 * A drawing absent from this table uses gradients alone.
 */
const TEXTURES: Partial<Record<FoilEffect, readonly string[]>> = {
  etched: [url(grain)],
  silver: [url(grain)],
  surge: [url(surge)],
  ripple: [rippleImage()],
  mana: [url(manaDiscs), url(manaGlyphs)],
  galaxy: [url(galaxyA), url(galaxyB)],
  confetti: [url(confetti)],
  textured: [url(contour)],
  fracture: [url(shards)],
};

/** The `--foil-tex-N` properties a drawing's layers read. */
export function foilTextureVars(effect: FoilEffect): Record<string, string> {
  const vars: Record<string, string> = {};
  (TEXTURES[effect] ?? []).forEach((image, i) => {
    vars[`--foil-tex-${i + 1}`] = image;
  });
  return vars;
}
