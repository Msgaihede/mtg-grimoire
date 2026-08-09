/**
 * `@/lib/images`, with `cardImageUrl` replaced and nothing else.
 *
 * **The re-export names the real module by a relative path.** `@/lib/images` is the specifier
 * `main.ts` aliases *to this file* — importing it by that name here resolves back to this
 * module and the import is circular. A local `export` wins over a `export *` of the same name
 * (ES2015 §16.2.3: star exports exclude names the module exports explicitly), which is what
 * makes "re-export everything, override one function" a single pair of lines.
 *
 * **Everything else stays the real thing, deliberately.** `CARD_ASPECT`, `ART_ASPECT` and the
 * four `IMAGE_RETRY_*` constants are re-exported untouched: a frame at the wrong ratio is the
 * one thing a card workbench must not show, and `imageOrigin`'s platform rule is pinned by
 * `src/lib/images.test.ts`, which this file has no business restating. `images.test.ts` next
 * door asserts the identity so a future "just one more override" is caught.
 *
 * Two modes, switched by the **Art** toolbar global (see `preview.tsx`):
 *
 * * `synthetic` (the default) — a generated SVG data URI at the variant's exact pixel size,
 *   carrying the card's name and printing. Offline, deterministic and nothing committed: the
 *   picture is a string this file builds, so there is no asset for a bundler to find and
 *   nothing to fetch at story time. Measured 2026-08-09 against a throwaway story that
 *   rendered one tile: `storybook build`'s `iframe-*.js` carries `Unknown card`, the palette's
 *   `oklch(0.21 0.012 270)` and the `data:image/svg+xml;charset=utf-8,` prefix, and carries no
 *   `mtgimg.localhost` — which is also the proof that `main.ts`'s alias reaches a *built*
 *   story and not only a dev-server one. Without such a story the whole module is
 *   tree-shaken out of the build, so `build-storybook` alone proves nothing about it.
 * * `live` — the real JPG off `cards.scryfall.io`, read from the fixture's own columns. No
 *   image bytes are in this repository; only URLs are.
 */
export * from "../../src/lib/images";

import type { ImageVariant } from "../../src/lib/images";
import { CARDS, type FakeCard } from "./cards";

/**
 * `Variant::dimensions`, `src-tauri/src/images.rs:94-101`.
 *
 * The whole point of the synthetic art: the placeholder occupies exactly the space the real
 * bytes would, so a story's layout is the app's layout. There is no way to import a number out
 * of Rust, so it is copied — and `images.test.ts` therefore restates the four pairs from
 * `images.rs` rather than importing this constant, since a test that read it would only prove
 * the record agrees with itself.
 *
 * **`display` is 672x936.** The Task 7 brief said 745x1040; `images.rs` is the source of truth
 * and it says otherwise. The other three agree.
 */
const SIZE: Record<ImageVariant, readonly [number, number]> = {
  thumb: [146, 204],
  grid: [488, 680],
  display: [672, 936],
  art: [626, 457],
};

/** Where the art comes from. The values are also the toolbar item values in `preview.tsx`. */
export type ArtMode = "synthetic" | "live";

/**
 * Module state, and the one piece of it {@link import("./world").installWorld} deliberately
 * does **not** reset.
 *
 * A Storybook global is meant to outlive a story change — that is the difference between a
 * global and a parameter — so clearing this alongside the dispatch table and the listener map
 * would snap the toolbar back to Synthetic every time the reader clicked a different story,
 * while the toolbar still said Live. `preview.tsx` re-applies it on every decorator run
 * instead, which is also what makes flipping the toolbar take effect without reseeding the
 * world underneath it.
 */
let mode: ArtMode = "synthetic";

export function setArtMode(next: ArtMode): void {
  mode = next;
}

/** The 43 fixture printings by id. A `find` per tile would be fine; a wall of them per render
 *  is forty-odd scans for a lookup that never changes. */
const BY_ID = new Map<string, FakeCard>(CARDS.map((c) => [c.id, c]));

/**
 * The URL for one face of one printing at one size — the fake's answer, with the real
 * function's signature.
 *
 * Under `live`, **face 0 only**. The generator keeps `image_uris` from the top level *or*
 * from `card_faces[0]` (`scripts/gen-storybook-cards.mjs:194`), so every URL in the fixture is
 * a front; handing one back for face 1 would draw Delver of Secrets on the back of Delver of
 * Secrets — the exact mistake `images.rs:274-277` calls out as the reason the real resolver
 * tries the face before the top-level image. A back face therefore falls through to synthetic,
 * where it is at least labelled as one.
 */
export function cardImageUrl(cardId: string, face: number, variant: ImageVariant): string {
  const card = BY_ID.get(cardId);
  if (mode === "live" && card && face === 0) {
    // The fixture carries two of Scryfall's six `image_uris` keys — `art_crop` and `normal`
    // (`gen-storybook-cards.mjs:230-231`) — so `thumb` and `display` are served the 488x680
    // `normal` too: upscaled a little at `display`, downscaled at `thumb`, and honest about
    // which printing it is either way. Deriving `/small/` and `/large/` from the path is one
    // `replace` away and is deliberately not done — it would be a URL nobody has fetched.
    const url = variant === "art" ? card.artCropUrl : card.normalUrl;
    // 1 of the 43 rows is null in both columns: `Prismatic Ending // Prismatic Ending`
    // (`amh2 5s`, `imageStatus: "missing"`), which is the no-image branch's only fixture.
    // Live art must not turn that row into a broken `<img>`.
    if (url) return url;
  }
  return synthetic(card, cardId, face, variant);
}

/* -------------------------------------------------------------------------------------- */

/**
 * The app palette, as `src/index.css:178-198` defines it.
 *
 * `oklch()` literals rather than hex, copied verbatim, because a hand-converted sRGB
 * approximation is a colour nobody measured and it would drift the day a token moves. An SVG
 * in a data URI is its own document and inherits none of the page's custom properties, so the
 * values have to be inlined; the `<style>` block below is what parses them as CSS, which is
 * the one context `oklch()` is unambiguously supported in.
 *
 * Surface rather than background for the fill: the placeholder has to read as a panel both on
 * the search wall (`--color-bg` behind it) and inside a card (`--color-surface`), and the
 * lighter of the two with a border is the one that reads on both.
 */
const PALETTE = {
  surface: "oklch(0.21 0.012 270)",
  border: "oklch(0.3 0.01 270)",
  text: "oklch(0.93 0.005 90)",
  dim: "oklch(0.65 0.01 90)",
  accent: "oklch(0.75 0.12 85)",
} as const;

/**
 * The heading and data faces, minus their webfonts.
 *
 * `--font-heading` is `"Cinzel", Georgia, serif` and `--font-mono` is
 * `"Geist Mono Variable", ui-monospace, monospace`; an SVG loaded through `<img>` cannot reach
 * the page's `@font-face` rules, so these are those stacks with the loaded face dropped —
 * the app's own fallbacks rather than a new choice.
 */
const SERIF = "Georgia,serif";
const MONO = "ui-monospace,monospace";

/**
 * The most lines a card name is given.
 *
 * Three: the longest name in the corpus wraps to two at every variant (`Delver of Secrets //
 * Insectile Aberration`, 41 characters — measured), so the third is headroom for a name a
 * story invents. A cap at all because the block is centred and the SVG viewport clips: an
 * unbounded name would grow the block in both directions and lose its own first line off the
 * top of the frame, which reads as a rendering bug rather than as a long name.
 */
const MAX_NAME_LINES = 3;

/**
 * Average glyph advance as a fraction of the font size, used to budget characters per line.
 *
 * **An estimate, not a measurement** — there is no text-measuring API in a string builder, and
 * `~0.5em` is the usual figure for mixed-case Latin in a serif. If it is wrong the placeholder
 * wraps a word early or late; nothing else depends on it, and the frame's dimensions do not.
 */
const AVG_GLYPH_EM = 0.5;

/**
 * A card-shaped placeholder that says which card it is.
 *
 * Every measurement is derived from `Math.min(w, h)` rather than from the width, so `art`
 * (626x457, landscape) gets type scaled to its short edge instead of type sized for a card
 * twice its height. The three portrait variants come out at 20 characters per line and `art`
 * at 29, which is why one wrapping rule covers all four: `thumb` and `display` break the same
 * name in the same place at 12px and 56px type.
 */
function synthetic(
  card: FakeCard | undefined,
  cardId: string,
  face: number,
  variant: ImageVariant,
): string {
  const [w, h] = SIZE[variant];
  const base = Math.min(w, h);
  const pad = Math.round(base * 0.08);
  const nameSize = Math.max(10, Math.round(base / 12));
  const subSize = Math.max(8, Math.round(base / 22));
  const lineHeight = Math.round(nameSize * 1.2);
  const inner = w - 2 * pad;

  const perLine = Math.max(6, Math.floor(inner / (nameSize * AVG_GLYPH_EM)));
  const lines = wrapName(card ? card.name : "Unknown card", perLine, MAX_NAME_LINES);

  // A card id when there is no fixture row, because that is the one thing the reader can act
  // on: it says "this story asked for a printing the corpus does not have".
  const printing = card
    ? `${card.setCode.toUpperCase()} · ${card.collectorNumber}`
    : cardId.slice(0, 8);
  const sub = face === 0 ? printing : `${printing} · back`;

  const gap = Math.round(subSize * 0.9);
  const namesHeight = lines.length * lineHeight;
  const top = Math.round((h - (namesHeight + gap + subSize)) / 2);
  const ruleY = top + namesHeight + Math.round(gap / 2);
  const ruleW = Math.round(Math.min(inner, w * 0.34));
  const mid = w / 2;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<style>text{text-anchor:middle}` +
    `.bg{fill:${PALETTE.surface}}` +
    `.edge{fill:none;stroke:${PALETTE.border};stroke-width:2}` +
    `.rule{stroke:${PALETTE.accent};stroke-width:${Math.max(1, Math.round(base / 220))};stroke-linecap:round}` +
    `.name{fill:${PALETTE.text};font-family:${SERIF};font-size:${nameSize}px}` +
    `.sub{fill:${PALETTE.dim};font-family:${MONO};font-size:${subSize}px}</style>` +
    `<rect class="bg" width="${w}" height="${h}"/>` +
    `<rect class="edge" x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${Math.round(base * 0.03)}"/>` +
    lines
      .map(
        (line, i) =>
          `<text class="name" x="${mid}" y="${top + nameSize + i * lineHeight}">${escapeXml(line)}</text>`,
      )
      .join("") +
    `<line class="rule" x1="${mid - ruleW / 2}" y1="${ruleY}" x2="${mid + ruleW / 2}" y2="${ruleY}"/>` +
    `<text class="sub" x="${mid}" y="${top + namesHeight + gap + subSize}">${escapeXml(sub)}</text>` +
    `</svg>`;

  // `encodeURIComponent` rather than a hand-rolled escape of `#` and `%`: the corpus carries
  // `//`, `,` and `'` in names and the separator here is `·`, and one function that is right
  // about all of UTF-8 beats five character classes that are right about most of it.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Greedy word wrap on a character budget, hard-breaking a word that cannot fit and ellipsing
 * whatever does not fit in `maxLines`.
 *
 * Wrapping happens on the raw text and escaping afterwards, never the other way round: an
 * apostrophe is one character on screen and six as `&apos;`, and `Smuggler's Copter` is a
 * fixture row.
 */
function wrapName(name: string, perLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of name.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= perLine) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (rest.length > perLine) {
      lines.push(`${rest.slice(0, perLine - 1)}-`);
      rest = rest.slice(perLine - 1);
    }
    line = rest;
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(1, perLine - 1))}…`;
  return kept;
}

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Card names are data and a card id is whatever a story passed in, so both are escaped
 *  before they become markup — `&` alone would make the whole document unparseable and the
 *  `<img>` would show nothing at all. */
function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => XML_ESCAPES[c]);
}
