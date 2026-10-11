import { compile } from "tailwindcss";
import twEntry from "tailwindcss/index.css?raw";
import { describe, expect, it } from "vitest";
import appCss from "@/index.css?raw";
import source from "./DeckTile.tsx?raw";

/**
 * What one utility compiles to — the `@layer utilities` block of a sheet built from that one
 * candidate against the app's own stylesheet, and `""` where the build emitted nothing.
 *
 * `NoteEditor.test.tsx`'s arrangement, for its reason: one candidate at a time and one layer, so
 * nothing preflight wrote and nothing a sibling emitted can stand in for the rule being asked
 * about.
 */
async function compiled(utility: string): Promise<string> {
  const compiler = await compile(appCss, {
    base: "/",
    loadStylesheet: (id: string) =>
      Promise.resolve(
        id === "tailwindcss"
          ? { path: "/tailwindcss/index.css", base: "/tailwindcss", content: twEntry }
          : { path: "/empty.css", base: "/", content: "" },
      ),
    loadModule: () => Promise.reject(new Error("no JS modules expected")),
  });
  const sheet = compiler.build([utility]);
  return sheet.match(/@layer utilities \{([\s\S]*?)\n\}/)?.[1].trim() ?? "";
}

/** A declaration, with whatever spacing the compiler chose around its operators. */
function declares(property: string, value: string): RegExp {
  const loose = value
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/ /g, "\\s*");
  return new RegExp(`${property}:\\s*${loose}`);
}

/**
 * **The tag row's place on the art is three arbitrary values, and an arbitrary value Tailwind
 * does not accept emits nothing at all** — no error, no warning, and a row with no `bottom` and
 * no height sitting wherever the box model drops it. `DecksPage.test.tsx` pins *which* of the
 * two offsets a tile wears, and under jsdom that is an assertion about a string; this is the
 * other half, that each string is a rule.
 *
 * The two that add a hairline are the ones worth compiling: a `+` inside `calc()` is an
 * operator only with a space either side, and whether the build supplies those spaces is a fact
 * about the build rather than about the source. It does, for both spellings — measured below —
 * so the `_+_` in the tile is the readable form and not a workaround.
 *
 * Lifted out of the shipped source rather than copied here, so the class a tile wears and the
 * class this compiles cannot come to be two spellings.
 */
describe("the tag row's arbitrary values are really compiled", () => {
  const utilities = (pattern: RegExp) => [...source.matchAll(pattern)].map(([, u]) => u);
  const [raised] = utilities(/"(bottom-\[calc\(1\.625rem[^"]+)"/g);
  const [height] = utilities(/"(h-\[calc\(1rem[^"]+)"/g);

  it("finds them in the tile's source", () => {
    // A sweep over nothing finds nothing, and every assertion below would pass against `""`.
    expect(raised).toBe("bottom-[calc(1.625rem*var(--mark-scale,1)_+_2px)]");
    expect(height).toBe("h-[calc(1rem*var(--mark-scale,1)_+_2px)]");
  });

  it("lifts the row a mark and a quarter-rem above the art's edge", async () => {
    expect(await compiled(raised)).toMatch(
      declares("bottom", "calc(1.625rem * var(--mark-scale, 1) + 2px)"),
    );
  });

  it("makes the row exactly one tag tall, which is what clips a second line", async () => {
    expect(await compiled(height)).toMatch(
      declares("height", "calc(1rem * var(--mark-scale, 1) + 2px)"),
    );
  });

  /** Recorded rather than relied on: the build spaces a bare `+` itself, so a later edit that
   *  drops the underscores changes nothing on screen. */
  it("emits the same rule for the spelling without the underscores", async () => {
    expect(await compiled("h-[calc(1rem*var(--mark-scale,1)+2px)]")).toMatch(
      declares("height", "calc(1rem * var(--mark-scale, 1) + 2px)"),
    );
  });

  /** The fence on the fence: a candidate that is not a utility must come out **empty**, or the
   *  cases above would pass against a helper that returned the whole sheet. */
  it("emits nothing for a candidate that is not a rule", async () => {
    expect(await compiled("h-[calc(1rem*)]-not-a-utility")).toBe("");
  });
});
