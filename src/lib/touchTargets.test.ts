import { describe, expect, it } from "vitest";
/**
 * The stylesheet as it ships, read through Vite rather than through `node:fs` — this project has
 * no `@types/node` on purpose, and `?raw` is how `tokens.test.ts` already reads this same file.
 */
import css from "@/index.css?raw";

/**
 * Every source file in the app, as text. Same glob and same reason as `tokens.test.ts`: Tailwind
 * reads prose as eagerly as code, so a variant named in a *comment* is a rule the build emits —
 * and a media query written in one is a second answer this sweep has to see.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The raw media query this variant exists to replace, assembled from two pieces.
 *
 * Written out whole it would match **this very file** — and worse, a find-and-replace over `src/`
 * would rewrite the guard along with the thing it guards, leaving a test that passes on a
 * codebase where nothing was fixed. `tokens.test.ts` spells `OLD_DIM_TEXT` the same way for the
 * same two reasons.
 *
 * `any-` is in the alternation deliberately: the near miss is the thing worth catching. A laptop
 * with a touchscreen has a fine pointer *and* a coarse one, so the `any-` spelling is true there
 * and would grow every control on the machine for a finger nobody is using — a component reaching
 * for it is a second answer *and* the wrong one.
 */
const RAW_POINTER_QUERY = new RegExp(`\\(\\s*(any-)?${"pointer"}\\s*:`);

describe("the coarse-pointer question has one spelling", () => {
  /**
   * Both halves of the foundation, and neither is applied anywhere yet — which control grows for
   * a finger is a design decision and belongs to 9b. This asserts the vocabulary exists, not that
   * anything speaks it.
   *
   * **A `@custom-variant` Tailwind does not accept fails silently**: the utility simply never
   * appears in the output, with `tsc` and this suite both green. So this assertion is necessary
   * and not sufficient — the sufficient check is a `grep` against `dist/assets/*.css` after a
   * build, recorded in `docs/reference/frontend-design.md`.
   */
  it("declares the variant and the floor", () => {
    expect(css).toMatch(/@custom-variant\s+coarse\s*\(/);
    expect(css).toMatch(/--target-min:\s*44px/);
  });

  /**
   * `layers.test.ts`'s rule applied to a media query: a raw query written in a component is a
   * second answer to a question this app should answer once, and the two drift the first time
   * either moves.
   */
  it("is asked nowhere else", () => {
    // A glob that stops matching returns `{}`, and a sweep over nothing finds nothing — which is
    // a green test over an unswept codebase. `tokens.test.ts`'s floor, for its reason.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const offenders = Object.entries(SOURCES)
      // The stylesheet is where the variant is declared, so it is the one file allowed to contain
      // the query. Everything else asks through `coarse:`.
      .filter(([path]) => !path.endsWith("/index.css"))
      .filter(([, text]) => RAW_POINTER_QUERY.test(text))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
