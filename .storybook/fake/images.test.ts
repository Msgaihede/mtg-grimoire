/**
 * What the Art toolbar global actually produces, and what it must leave alone.
 *
 * Task 7's brief asked for the toolbar to be checked in a browser. This suite covers the half
 * a browser was going to check by eye — that every variant's placeholder is the size the real
 * bytes would be, that a name and a card id survive becoming markup, and that Live falls back
 * rather than emitting a broken `<img>` — and keeps checking it. The *visual* half (the
 * toolbar item appears, the switch repaints) is still owed.
 *
 * The four dimension pairs are restated here from `src-tauri/src/images.rs:94-101` instead of
 * being imported from `images.ts`'s own `SIZE`. That is the whole value of the test: a
 * placeholder at the wrong size is a story whose layout is not the app's layout, and a test
 * that read the constant it is checking would agree with any typo in it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cardImageUrl, setArtMode } from "./images";
import * as fake from "./images";
import * as real from "../../src/lib/images";
import { IMAGE_VARIANTS, type ImageVariant } from "../../src/lib/images";
import { CARDS, type FakeCard } from "./cards";

/** `Variant::dimensions`, `src-tauri/src/images.rs:94-101`. */
const DIMENSIONS: Record<ImageVariant, [number, number]> = {
  thumb: [146, 204],
  grid: [488, 680],
  display: [672, 936],
  art: [626, 457],
};

const SYNTHETIC_PREFIX = "data:image/svg+xml;charset=utf-8,";

/** The SVG behind a synthetic URI, decoded. Asserts the prefix on the way through, so every
 *  caller below is also a "this is a data URI and not a Scryfall URL" assertion. */
function svgOf(url: string): string {
  expect(url.startsWith(SYNTHETIC_PREFIX)).toBe(true);
  return decodeURIComponent(url.slice(SYNTHETIC_PREFIX.length));
}

/**
 * The same SVG, parsed as XML — which is the assertion `toContain` cannot make.
 *
 * A browser loading a data URI through `<img>` parses it as a *document*: one unescaped `&`
 * anywhere and the whole thing is a parse error and the tile draws nothing, with no console
 * entry the story author would see. jsdom's `DOMParser` answers the same question here, and
 * every assertion below that goes through it is therefore also a well-formedness check.
 *
 * The guard is live rather than decorative: measured 2026-08-09, `<text>a & b</text>` inside
 * an otherwise valid SVG gives jsdom a document whose `parsererror` this finds.
 */
function docOf(url: string): Document {
  const doc = new DOMParser().parseFromString(svgOf(url), "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

/** A fixture row by name, so this file does not carry a second copy of 43 card ids that a
 *  regeneration would silently invalidate. */
function card(name: string): FakeCard {
  const found = CARDS.find((c) => c.name === name);
  if (!found) throw new Error(`fixture row gone: ${name}`);
  return found;
}

/** The one row of the 43 with no art anywhere — `imageStatus: "missing"`, both URL columns
 *  null. Live mode has nothing to serve for it. */
const NO_ART = "Prismatic Ending // Prismatic Ending";
/** A `transform` printing: two physical faces, and the fixture carries only the front's URL. */
const TWO_FACED = "Delver of Secrets // Insectile Aberration";
/** An apostrophe in a card name, which is `&apos;` by the time it is markup. */
const APOSTROPHE = "Smuggler's Copter";

beforeEach(() => setArtMode("synthetic"));

describe("the re-export", () => {
  it("replaces cardImageUrl and nothing else", () => {
    expect(fake.cardImageUrl).not.toBe(real.cardImageUrl);
    // Identity, not equality: these must be the *same* values the app reads, so a story that
    // renders a frame at `CARD_ASPECT` renders it at the app's ratio.
    expect(fake.CARD_ASPECT).toBe(real.CARD_ASPECT);
    expect(fake.ART_ASPECT).toBe(real.ART_ASPECT);
    expect(fake.IMAGE_VARIANTS).toBe(real.IMAGE_VARIANTS);
    expect(fake.imageOrigin).toBe(real.imageOrigin);
    expect(fake.imageRetryDelayMs).toBe(real.imageRetryDelayMs);
    expect(fake.IMAGE_RETRY_FLOOR_MS).toBe(real.IMAGE_RETRY_FLOOR_MS);
    expect(fake.IMAGE_RETRY_SPREAD_MS).toBe(real.IMAGE_RETRY_SPREAD_MS);
    expect(fake.IMAGE_RETRY_CEILING_MS).toBe(real.IMAGE_RETRY_CEILING_MS);
    expect(fake.IMAGE_RETRY_LIMIT).toBe(real.IMAGE_RETRY_LIMIT);
  });
});

describe("synthetic art", () => {
  it.each([...IMAGE_VARIANTS])("draws %s at the size the real bytes would be", (variant) => {
    const [w, h] = DIMENSIONS[variant];
    const root = docOf(cardImageUrl(card(APOSTROPHE).id, 0, variant)).documentElement;
    expect(root.tagName).toBe("svg");
    expect(root.getAttribute("width")).toBe(String(w));
    expect(root.getAttribute("height")).toBe(String(h));
    // The viewBox too: a mismatched one scales the drawing inside a correctly sized frame,
    // which looks like a font bug rather than a geometry one.
    expect(root.getAttribute("viewBox")).toBe(`0 0 ${w} ${h}`);
  });

  it("names the card and its printing", () => {
    const bruna = card("Bruna, the Fading Light");
    const svg = svgOf(cardImageUrl(bruna.id, 0, "grid"));
    expect(svg).toContain("Bruna,");
    expect(svg).toContain(`${bruna.setCode.toUpperCase()} · ${bruna.collectorNumber}`);
  });

  it("says which face it is drawing, so a back is not mistaken for a front", () => {
    const id = card(TWO_FACED).id;
    expect(svgOf(cardImageUrl(id, 1, "grid"))).toContain("· back");
    expect(svgOf(cardImageUrl(id, 0, "grid"))).not.toContain("· back");
  });

  it("answers an id the corpus does not have instead of throwing", () => {
    // The shape a story hits when it invents an id or outlives a fixture regeneration.
    const url = cardImageUrl("00000000-0000-0000-0000-000000000000", 0, "grid");
    const svg = svgOf(url);
    expect(svg).toContain("Unknown card");
    // The first 8 characters of the id, which is what tells the reader *which* id was missed.
    expect(svg).toContain("00000000");
  });

  it("wraps a long name rather than running it past the frame", () => {
    const svg = svgOf(cardImageUrl(card(TWO_FACED).id, 0, "grid"));
    // Two `.name` lines, not one 41-character one: 20 characters fit across a 488px grid tile.
    expect(svg.match(/class="name"/g)).toHaveLength(2);
  });

  it("escapes a card name into markup", () => {
    const svg = svgOf(cardImageUrl(card(APOSTROPHE).id, 0, "grid"));
    expect(svg).toContain("Smuggler&apos;s Copter");
    expect(svg).not.toContain("Smuggler's");
  });

  it("escapes an id, which is whatever the story passed in", () => {
    // All five specials, inside the 8 characters of the id the placeholder prints.
    const id = `&<>"'x`;
    expect(svgOf(cardImageUrl(id, 0, "grid"))).toContain(">&amp;&lt;&gt;&quot;&apos;x</text>");
    // And they survive the round trip: escaped enough to parse, not so much that the reader
    // is shown `&amp;` where the id said `&`.
    expect(docOf(cardImageUrl(id, 0, "grid")).documentElement.textContent).toContain(id);
  });
});

describe("live art", () => {
  beforeEach(() => setArtMode("live"));

  it("serves art_crop for the art variant and normal for the rest", () => {
    const bolt = card("Black Lotus");
    expect(cardImageUrl(bolt.id, 0, "art")).toBe(bolt.artCropUrl);
    for (const variant of ["thumb", "grid", "display"] as const) {
      expect(cardImageUrl(bolt.id, 0, variant)).toBe(bolt.normalUrl);
    }
    // The host is the whole of the allowlist `images.rs` enforces, and the fixture is the only
    // place these strings come from.
    expect(bolt.normalUrl).toContain("https://cards.scryfall.io/");
  });

  it("falls back to synthetic for the printing with no art anywhere", () => {
    const missing = card(NO_ART);
    expect(missing.artCropUrl).toBeNull();
    expect(missing.normalUrl).toBeNull();
    expect(svgOf(cardImageUrl(missing.id, 0, "art"))).toContain("Prismatic Ending");
  });

  it("falls back to synthetic for a back face, which the fixture has no URL for", () => {
    const delver = card(TWO_FACED);
    expect(cardImageUrl(delver.id, 0, "grid")).toBe(delver.normalUrl);
    // Not `normalUrl` again: that is the front, and drawing it here would put Delver of
    // Secrets on the back of Delver of Secrets.
    expect(svgOf(cardImageUrl(delver.id, 1, "grid"))).toContain("· back");
  });

  it("falls back to synthetic for an id the corpus does not have", () => {
    expect(svgOf(cardImageUrl("nope", 0, "grid"))).toContain("Unknown card");
  });

  it("goes back to synthetic when the toolbar does", () => {
    const bolt = card("Black Lotus");
    expect(cardImageUrl(bolt.id, 0, "grid")).toBe(bolt.normalUrl);
    setArtMode("synthetic");
    expect(svgOf(cardImageUrl(bolt.id, 0, "grid"))).toContain("Black Lotus");
  });
});
