#!/usr/bin/env node
// Regenerate the foil pattern textures in `packages/ui/assets/foil/`.
//
//     node scripts/foil-textures.ts            every texture
//     node scripts/foil-textures.ts surge      just the ones named
//
// **Why the app draws its own foil at all.** Scryfall keeps one picture per printing, and a
// printing sold plain *and* in a special foil (693 surge, 369 silver, 316 ripple, 326 etched in
// the 2026-11 corpus) is photographed plain: the kind of foil lives only in `promo_types`. So the
// pattern a real surge or ripple card shows has to be drawn over the picture, and these are the
// patterns. `FoilOverlay` (`packages/ui/components/CardArt.tsx`) lays them on as CSS masks and
// backgrounds; `lib/foilEffect.ts` chooses which.
//
// **Every shape here was tuned against the real thing**, in a design canvas the owner reviewed
// card by card on 2026-11-15 with photos of his own cards: surge is soft, rounded blotches
// stretched along the diagonal ("like tiger stripes or stretch marks… blotchier, with rounded
// edges, not sharp"); mana foil is the lattice measured off a scan of Foundations' own (issue
// #1689). Ripple has no picture any more: its rings are CSS gradients, so each can grow and fade
// on its own. Change a recipe and the picture changes on every card of that kind — look at one
// before committing.
//
// Deterministic: a seeded RNG, so a rerun writes byte-identical files and a diff means a recipe
// changed. No dependencies: a small PNG encoder over `node:zlib`, and mana-font's own SVG paths
// filled by a scanline rasteriser here.
//
// Card-relative patterns are drawn at 504×702 (a 5:7 card; mana at 750×1050, for its fine
// rims) and stretched to the card; fine
// grains are small tiles at screen scale, which the CSS repeats at a fixed pixel size so they
// stay crisp at every zoom.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = new URL("../packages/ui/assets/foil/", import.meta.url);

type Rgb = readonly [number, number, number];
type Canvas = { w: number; h: number; px: Buffer };

// ---- PNG --------------------------------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function png({ w, h, px }: Canvas): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing ------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const canvas = (w = 504, h = 702): Canvas => ({ w, h, px: Buffer.alloc(w * h * 4) });

/** "Over" compositing of one coloured pixel at alpha `a`; `wrap` tiles across the edges. */
function blend(c: Canvas, x: number, y: number, [r, g, b]: Rgb, a: number, wrap = false): void {
  if (wrap) {
    x = ((x % c.w) + c.w) % c.w;
    y = ((y % c.h) + c.h) % c.h;
  }
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const p = c.px;
  const i = (y * c.w + x) * 4;
  const da = p[i + 3] / 255;
  const oa = a + da * (1 - a);
  p[i] = Math.round((r * a + p[i] * da * (1 - a)) / oa);
  p[i + 1] = Math.round((g * a + p[i + 1] * da * (1 - a)) / oa);
  p[i + 2] = Math.round((b * a + p[i + 2] * da * (1 - a)) / oa);
  p[i + 3] = Math.round(oa * 255);
}

/** An anti-aliased disc. */
function dot(c: Canvas, cx: number, cy: number, rad: number, col: Rgb, a = 1, wrap = false): void {
  for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++)
    for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
      const cover = Math.min(1, Math.max(0, rad + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      blend(c, x, y, col, a * cover, wrap);
    }
}

/** A "planet": a disc lit from the upper left, fading to its rim. */
function shadedDisc(c: Canvas, cx: number, cy: number, rad: number, [r, g, b]: Rgb): void {
  for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++)
    for (let x = Math.floor(cx - rad - 1); x <= cx + rad + 1; x++) {
      const edge = Math.min(1, Math.max(0, rad + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      const lit =
        1 - Math.min(1, Math.hypot(x - (cx - rad * 0.35), y - (cy - rad * 0.35)) / (rad * 1.6));
      const lift = (v: number) => Math.min(255, v + 90 * lit);
      blend(c, x, y, [lift(r), lift(g), lift(b)], edge * (0.55 + 0.45 * lit));
    }
}

/** A 4- or 6-point star: a core and thin arms. */
function star(c: Canvas, cx: number, cy: number, len: number, col: Rgb, points = 4): void {
  dot(c, cx, cy, Math.max(0.6, len * 0.16), col);
  for (let k = 0; k < points; k++) {
    const t = (k * Math.PI * 2) / points;
    for (let s = 1; s <= len; s++)
      blend(
        c,
        Math.round(cx + Math.cos(t) * s),
        Math.round(cy + Math.sin(t) * s),
        col,
        (1 - s / len) ** 1.5,
      );
  }
}

function ring(c: Canvas, cx: number, cy: number, rad: number, col: Rgb): void {
  for (let y = Math.floor(cy - rad - 2); y <= cy + rad + 2; y++)
    for (let x = Math.floor(cx - rad - 2); x <= cx + rad + 2; x++) {
      const off = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - rad);
      blend(c, x, y, col, Math.max(0, 1 - off / 0.9));
    }
}

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Smooth value noise in 0..1, one lattice point per `cell` pixels. */
function noise2(seed: number, cell: number): (x: number, y: number) => number {
  const r = rng(seed);
  const G = 64;
  const grid = Float32Array.from({ length: G * G }, () => r());
  const at = (i: number, j: number) => grid[(((j % G) + G) % G) * G + (((i % G) + G) % G)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = smooth(fx - i);
    const v = smooth(fy - j);
    return (
      at(i, j) * (1 - u) * (1 - v) +
      at(i + 1, j) * u * (1 - v) +
      at(i, j + 1) * (1 - u) * v +
      at(i + 1, j + 1) * u * v
    );
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const WHITE: Rgb = [255, 255, 255];

// ---- the textures -------------------------------------------------------------------------

/**
 * Mana foil (Foundations, FDN 362–421): a lattice of rings, each holding one of the five mana
 * symbols. Measured on the high-passed scan of FDN 362 (issue #1689): rows 0.1012 of the card's
 * width apart, rings 0.2083 apart along a row, alternate rows offset by half, ring radius 0.0484,
 * the first row's first ring at (0.298 W, 0.203 H), each symbol in a box 1.25 of the radius,
 * W U B R G running along a row and two places on per row.
 *
 * Two white masks at 750×1050: `discs` (each ring's rim, and its disc faint around the symbol)
 * catches the light; `glyphs` (the symbols, and a thinner rim) is darkened under it. Pictures, not
 * SVG: an SVG mask is redrawn on every repaint, and a wall of mana foils cost 174 ms a frame that
 * way on the design canvas.
 */
const MANA_SVG = new URL("../node_modules/mana-font/svg/", import.meta.url);
const MANA_KEYS = ["w", "u", "b", "r", "g"] as const;

type Point = readonly [number, number];

/** A path's subpaths as point lists, curves flattened. Handles M L H V C S Q Z, either case. */
function flatten(d: string, steps = 12): Point[][] {
  const tok = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const polys: Point[][] = [];
  let poly: Point[] = [];
  let i = 0;
  let cmd = "";
  let [x, y, sx, sy, cx, cy] = [0, 0, 0, 0, 0, 0];
  const num = () => Number.parseFloat(tok[i++]);
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      poly.push([
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    [cx, cy, x, y] = [x2, y2, x3, y3];
  };
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const [ox, oy] = rel ? [x, y] : [0, 0];
    switch (cmd.toUpperCase()) {
      case "M":
        if (poly.length > 1) polys.push(poly);
        x = ox + num();
        y = oy + num();
        [sx, sy, cx, cy] = [x, y, x, y];
        poly = [[x, y]];
        cmd = rel ? "l" : "L"; // further pairs are lines
        break;
      case "L":
        x = ox + num();
        y = oy + num();
        poly.push([x, y]);
        [cx, cy] = [x, y];
        break;
      case "H":
        x = ox + num();
        poly.push([x, y]);
        [cx, cy] = [x, y];
        break;
      case "V":
        y = oy + num();
        poly.push([x, y]);
        [cx, cy] = [x, y];
        break;
      case "C": {
        const a = [num(), num(), num(), num(), num(), num()];
        cubic(ox + a[0], oy + a[1], ox + a[2], oy + a[3], ox + a[4], oy + a[5]);
        break;
      }
      case "S": {
        const a = [num(), num(), num(), num()];
        cubic(2 * x - cx, 2 * y - cy, ox + a[0], oy + a[1], ox + a[2], oy + a[3]);
        break;
      }
      case "Q": {
        const [qx, qy, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
        cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        [cx, cy] = [qx, qy];
        break;
      }
      case "Z":
        [x, y] = [sx, sy];
        poly.push([x, y]);
        polys.push(poly);
        poly = [[x, y]];
        [cx, cy] = [x, y];
        break;
      default:
        throw new Error(`path command ${cmd}`);
    }
  }
  if (poly.length > 1) polys.push(poly);
  return polys;
}

/** Coverage (0..1 a pixel) of `polys` filled nonzero into a w×h grid, 4×4 samples a pixel. */
function fill(polys: Point[][], w: number, h: number, ss = 4): Float32Array {
  const cov = new Float32Array(w * h);
  const edges: [number, number, number, number][] = [];
  for (const p of polys)
    for (let k = 0; k < p.length; k++) {
      const [x0, y0] = p[k];
      const [x1, y1] = p[(k + 1) % p.length];
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  for (let sy = 0; sy < h * ss; sy++) {
    const y = (sy + 0.5) / ss;
    const hits: [number, number][] = [];
    for (const [x0, y0, x1, y1] of edges)
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0))
        hits.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    hits.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let k = 0; k < hits.length - 1; k++) {
      wind += hits[k][1];
      if (wind === 0) continue;
      const a = Math.max(0, Math.ceil(hits[k][0] * ss - 0.5));
      const b = Math.min(w * ss - 1, Math.floor(hits[k + 1][0] * ss - 0.5));
      const row = Math.floor(sy / ss) * w;
      for (let c = a; c <= b; c++) cov[row + Math.floor(c / ss)] += 1 / (ss * ss);
    }
  }
  return cov;
}

/** Both mana masks, drawn together because they share the lattice and the glyph tiles. */
function manaMasks(w = 750): { discs: Canvas; glyphs: Canvas } {
  const h = Math.round(w * 1.4);
  const [sx, sy, r, y0, x0] = [w * 0.2083, w * 0.1012, w * 0.0484, h * 0.203, w * 0.298];
  const cells: { x: number; y: number; k: (typeof MANA_KEYS)[number] }[] = [];
  for (let i = -Math.ceil(y0 / sy) - 1; y0 + i * sy < h + sy; i++) {
    const y = y0 + i * sy;
    const off = ((i % 2) + 2) % 2 === 0 ? 0 : sx / 2;
    for (let j = -Math.ceil(x0 / sx) - 1; x0 + j * sx < w + sx; j++) {
      const x = x0 + j * sx + off;
      if (x < -r || x > w + r || y < -r || y > h + r) continue;
      cells.push({ x, y, k: MANA_KEYS[(((j + 2 * i) % 5) + 5) % 5] });
    }
  }
  // Each symbol's coverage once, centred in a tile; a cell's tile lands on the nearest pixel.
  const pad = Math.ceil(r + 3);
  const size = pad * 2;
  const scale = (r * 1.25) / 32; // the font's 32-unit box
  const glyph = Object.fromEntries(
    MANA_KEYS.map((k) => {
      const d = readFileSync(new URL(`${k}.svg`, MANA_SVG), "utf8").match(/ d="([^"]+)"/)?.[1];
      if (!d) throw new Error(`no path in mana-font's ${k}.svg`);
      const polys = flatten(d).map((p) => p.map(([px, py]): Point => [pad + (px - 16) * scale, pad + (py - 16) * scale]));
      return [k, fill(polys, size, size)];
    }),
  );
  const discs = canvas(w, h);
  const glyphs = canvas(w, h);
  const unit = w / 500; // the rims' widths were set on a 500-wide drawing
  const ringR = r - 1.2 * unit;
  for (const cell of cells) {
    const [ox, oy] = [Math.round(cell.x) - pad, Math.round(cell.y) - pad];
    const g = glyph[cell.k];
    for (let ty = 0; ty < size; ty++)
      for (let tx = 0; tx < size; tx++) {
        const [x, y] = [ox + tx, oy + ty];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const dist = Math.hypot(x + 0.5 - cell.x, y + 0.5 - cell.y);
        const disc = Math.min(1, Math.max(0, r + 0.5 - dist));
        const rimWide = Math.min(1, Math.max(0, 1.2 * unit + 0.5 - Math.abs(dist - ringR)));
        const rimThin = Math.min(1, Math.max(0, 0.8 * unit + 0.5 - Math.abs(dist - ringR)));
        const mark = Math.min(1, g[ty * size + tx]);
        raise(discs, x, y, Math.max(rimWide, 0.3 * disc * (1 - mark)));
        raise(glyphs, x, y, Math.max(mark, rimThin));
      }
  }
  return { discs, glyphs };
}

/** A white pixel at least `a` opaque — overlapping rims keep the stronger, never add. */
function raise(c: Canvas, x: number, y: number, a: number): void {
  const i = (y * c.w + x) * 4;
  const alpha = Math.round(Math.min(1, Math.max(0, a)) * 255);
  if (alpha <= c.px[i + 3]) return;
  c.px[i] = c.px[i + 1] = c.px[i + 2] = 255;
  c.px[i + 3] = alpha;
}

let mana: ReturnType<typeof manaMasks> | undefined;
const manaOnce = () => (mana ??= manaMasks());

/**
 * Galaxy: a dense pinpoint starfield, a few dozen small stars, diamonds and rings, and a handful
 * of shaded planets — each its own hue. Two sets, which the CSS trades as the light moves so the
 * stars blink.
 */
function galaxySet(seed: number): Canvas {
  const c = canvas();
  const r = rng(seed);
  const hue = () => hsl(r() * 360, 0.85, 0.62);
  for (let i = 0; i < 700; i++)
    dot(c, r() * c.w, r() * c.h, 0.45 + r() * 0.5, r() < 0.6 ? WHITE : hue(), 0.5 + r() * 0.5);
  for (let i = 0; i < 40; i++) {
    const kind = r();
    const x = r() * c.w;
    const y = r() * c.h;
    const col = hue();
    if (kind < 0.5) star(c, x, y, 3 + r() * 4, col, r() < 0.5 ? 4 : 6);
    else if (kind < 0.75) star(c, x, y, 2.5 + r() * 2, col, 4);
    else ring(c, x, y, 1.6 + r() * 2.2, col);
  }
  for (let i = 0; i < 8; i++) shadedDisc(c, r() * c.w, r() * c.h, 3 + r() * 9, hsl(r() * 360, 0.7, 0.45));
  return c;
}

const RECIPES: Record<string, () => Canvas> = {
  /**
   * Surge: soft, rounded blotches stretched along the ~40° lower-left→upper-right diagonal.
   * Domain-warped value noise, stretched along that diagonal and cut with a soft threshold — the
   * tiger-stripe recipe — with a fine mottle inside each blotch so it shimmers rather than
   * reading as paint. A white mask: the CSS supplies the rainbow.
   */
  surge() {
    const c = canvas();
    const th = (40 * Math.PI) / 180;
    const [nx, ny, dx, dy] = [Math.sin(th), Math.cos(th), Math.cos(th), -Math.sin(th)];
    const [n1, n2, n3, wu, wv, big] = [101, 102, 103, 104, 105, 106].map((s) => noise2(s, 1));
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const u0 = x * nx + y * ny;
        const v0 = x * dx + y * dy;
        const u = u0 + 52 * (wu(u0 / 70, v0 / 110) - 0.5);
        const v = v0 + 80 * (wv(u0 / 90, v0 / 130) - 0.5);
        const f = 0.55 * n1(u / 22, v / 95) + 0.3 * n2(u / 11, v / 48) + 0.15 * n3(u / 6, v / 22);
        const patch = 0.55 + 0.45 * big(x / 170, y / 170);
        const mottle = 0.62 + 0.38 * (0.6 * n3(x / 5, y / 5) + 0.4 * n2(x / 2.5, y / 2.5));
        blend(c, x, y, WHITE, smoothstep(0.5, 0.6, f) * patch * mottle);
      }
    return c;
  },

  /** Etched and silver: a fine frosted grain — single pixels at random strength. A 128px tile. */
  grain() {
    const c = canvas(128, 128);
    const r = rng(21);
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const v = r();
        if (v > 0.45) blend(c, x, y, WHITE, Math.min(1, (v - 0.45) * 2.2));
      }
    return c;
  },

  // Mana foil's two masks (see manaMasks). Ripple has no picture since issue #1689: its nine
  // rings are CSS gradients (components/foilTextures.ts), so they can grow and fade one by one.
  "mana-discs": () => manaOnce().discs,
  "mana-glyphs": () => manaOnce().glyphs,

  "galaxy-a": () => galaxySet(11),
  "galaxy-b": () => galaxySet(29),

  /** Confetti: a dense mosaic of tiny flat flakes (~35% cover), neighbours in different hues. */
  confetti() {
    const c = canvas(200, 200);
    const r = rng(5);
    for (let i = 0; i < 2600; i++) {
      const cx = r() * c.w;
      const cy = r() * c.h;
      const col = hsl(r() * 360, 0.9, 0.6);
      const s = 0.7 + r() * 1.2;
      if (r() < 0.5) dot(c, cx, cy, s * 0.75, col, 1, true);
      else
        for (let y = -2; y <= 2; y++)
          for (let x = -2; x <= 2; x++)
            if (Math.abs(x) + Math.abs(y) <= s * 1.4)
              blend(c, Math.round(cx + x), Math.round(cy + y), col, 1, true);
    }
    return c;
  },

  /**
   * Textured: fine contour lines like an engraving, flowing in broad curves. Generic — a real
   * textured foil's raised lines are drawn for its own art, which no shared texture can match.
   */
  contour() {
    const c = canvas();
    const [n, m] = [noise2(41, 120), noise2(42, 40)];
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const v = (n(x, y) * 3 + m(x, y) * 0.4) * 14;
        blend(c, x, y, WHITE, Math.max(0, 1 - Math.abs(v - Math.floor(v) - 0.5) * 9));
      }
    return c;
  },

  /**
   * Fracture: shattered glass — a jittered-grid Voronoi of small shards, each its own hue, with
   * bright cracks along the edges.
   */
  shards() {
    const c = canvas();
    const r = rng(3);
    const S = 16;
    const gw = Math.ceil(c.w / S) + 1;
    const gh = Math.ceil(c.h / S) + 1;
    const seeds: { x: number; y: number; col: Rgb }[] = [];
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++)
        seeds.push({ x: (i + r()) * S, y: (j + r()) * S, col: hsl(r() * 360, 0.8, 0.3 + r() * 0.25) });
    const owner = new Int32Array(c.w * c.h);
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const gi = Math.floor(x / S);
        const gj = Math.floor(y / S);
        let best = 0;
        let bestD = Infinity;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const i = gi + di;
            const j = gj + dj;
            if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
            const k = j * gw + i;
            const d = (x - seeds[k].x) ** 2 + (y - seeds[k].y) ** 2;
            if (d < bestD) [bestD, best] = [d, k];
          }
        owner[y * c.w + x] = best;
      }
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const k = owner[y * c.w + x];
        const edge =
          (x + 1 < c.w && owner[y * c.w + x + 1] !== k) ||
          (y + 1 < c.h && owner[(y + 1) * c.w + x] !== k);
        blend(c, x, y, edge ? [235, 240, 255] : seeds[k].col, 1);
      }
    return c;
  },
};

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, draw] of Object.entries(RECIPES)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue;
  const bytes = png(draw());
  writeFileSync(new URL(`${name}.png`, OUT), bytes);
  console.log(`${name}.png  ${bytes.length.toLocaleString()} bytes`);
}
