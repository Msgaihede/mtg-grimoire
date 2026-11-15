/**
 * The pattern pictures each foil drawing masks with, handed to its layers as CSS custom properties.
 *
 * **Imported here and set as properties rather than written as `url()`s in `index.css`**, so the
 * bundler owns their addresses (hashed, same-origin, under the CSP's `img-src 'self'`) and the
 * stylesheet names only `var(--foil-tex-…)`. A drawing that asks for none gets no property, so a
 * plain traditional foil fetches nothing.
 *
 * The files are generated: `node scripts/foil-textures.ts` rewrites every one of them, and that
 * script is where each shape is described.
 */
import confetti from "@/assets/foil/confetti.png";
import contour from "@/assets/foil/contour.png";
import galaxyA from "@/assets/foil/galaxy-a.png";
import galaxyB from "@/assets/foil/galaxy-b.png";
import grain from "@/assets/foil/grain.png";
import rippleA from "@/assets/foil/ripple-a.png";
import rippleB from "@/assets/foil/ripple-b.png";
import rippleC from "@/assets/foil/ripple-c.png";
import shards from "@/assets/foil/shards.png";
import surge from "@/assets/foil/surge.png";
import type { FoilEffect } from "@/lib/foilEffect";

const url = (src: string) => `url("${src}")`;

/**
 * Up to three pictures per drawing, in the order its CSS reads them: `--foil-tex-1` first.
 * A drawing absent from this table uses gradients alone.
 */
const TEXTURES: Partial<Record<FoilEffect, readonly string[]>> = {
  etched: [grain],
  silver: [grain],
  surge: [surge],
  ripple: [rippleA, rippleB, rippleC],
  galaxy: [galaxyA, galaxyB],
  confetti: [confetti],
  textured: [contour],
  fracture: [shards],
};

/** The `--foil-tex-N` properties a drawing's layers read. */
export function foilTextureVars(effect: FoilEffect): Record<string, string> {
  const vars: Record<string, string> = {};
  (TEXTURES[effect] ?? []).forEach((src, i) => {
    vars[`--foil-tex-${i + 1}`] = url(src);
  });
  return vars;
}
