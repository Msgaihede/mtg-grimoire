import { describe, expect, it } from "vitest";
import { MotionGlobalConfig } from "motion/react";
/**
 * The stylesheet as it ships. Read through Vite with `?raw`, exactly as `tokens.test.ts` and
 * `iconFont.test.ts` read the files they assert against — this project has no `@types/node`,
 * so `node:fs` is not available to a test and is not going to be.
 */
import css from "@/index.css?raw";
import * as MOTION from "./motion";
import { DURATION, EASE, cssEase, seconds, statusLineGap } from "./motion";

/** Every duration on the scale, in seconds, which is the unit a `Transition` is written in. */
const ALLOWED = new Set(Object.values(DURATION).map(seconds));

/** The slowest thing the vocabulary permits. */
const SLOWEST = seconds(DURATION.slow);

/**
 * Every `duration` reachable from a preset, with the path that got there.
 *
 * A deep walk over the **module namespace** rather than a hand-written list of the seven
 * presets, because the list is the thing that rots: a preset added next month is covered by
 * this the day it is exported, and a hand-written list is green about the six it still knows.
 * Functions are stepped over — `statusLineGap` is called explicitly below, and `seconds`,
 * `cssEase` and `variants` hold no timings.
 */
function durationsIn(value: unknown, path: string): [string, number][] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    if (key === "duration" && typeof child === "number") return [[here, child] as [string, number]];
    return durationsIn(child, here);
  });
}

const FOUND = [
  ...durationsIn(MOTION, "motion"),
  ...durationsIn(statusLineGap(8), "statusLineGap(8)"),
];

describe("the motion scale", () => {
  /**
   * A tripwire before the two assertions below, both of which are vacuously green over an empty
   * list — a renamed export, a preset that stopped carrying its own `transition`, or a walk that
   * stopped descending would all leave them passing while checking nothing. Seven presets carry
   * at least a dozen durations between them; ten is a floor only a broken walk falls through.
   */
  it("finds the durations the presets are built from", () => {
    expect(FOUND.length, FOUND.map(([p]) => p).join(", ")).toBeGreaterThan(10);
  });

  /**
   * The whole point of the file: nobody writes a number. A duration that is on no tier is a
   * number somebody wrote, and it is invisible in review because 0.2 looks exactly as
   * deliberate as 0.18.
   */
  it("builds every preset out of the three tiers and nothing else", () => {
    const offenders = FOUND.filter(([, duration]) => !ALLOWED.has(duration));
    expect(offenders).toEqual([]);
  });

  /**
   * The budget, as an inequality rather than as a set — so it still means something on the day
   * a fourth tier is added. The direction doc's 150ms was widened to 260ms only for surfaces
   * that cross the window; anything slower than the slowest tier is a new policy, not a tweak.
   */
  it("keeps every preset inside the slow tier", () => {
    const offenders = FOUND.filter(([, duration]) => duration > SLOWEST);
    expect(offenders).toEqual([]);
  });
});

describe("the CSS tokens", () => {
  /**
   * The two halves of the vocabulary, compared character for character.
   *
   * They are two files because they have two consumers — a `motion` prop and a Tailwind
   * utility — and the failure mode of letting them drift is the one nobody reports: a drawer
   * that slides at 260ms next to a chevron that turns at 240, which reads as sloppiness rather
   * than as a bug and is never traced to a number.
   */
  it("agree with the JS scale", () => {
    for (const [tier, ms] of Object.entries(DURATION)) {
      expect(css, `--duration-${tier}`).toContain(`--duration-${tier}: ${ms}ms;`);
    }
    for (const [name, curve] of Object.entries(EASE)) {
      expect(css, `--ease-${name}`).toContain(`--ease-${name}: ${cssEase(curve)};`);
    }
  });

  /**
   * **`@theme static`, and it is not a stylistic preference.**
   *
   * A plain `@theme` emits only the variables something references, so a token read purely
   * through `var()` — which is every `--duration-*`, because Tailwind has no `duration-*` theme
   * namespace and generates no utility from them — is tree-shaken out and never reaches
   * `:root`. Measured 2026-08-12 against tailwindcss 4.3.3 by compiling the block both ways:
   * absent from the output under `@theme`, present under `@theme static`. The symptom is a
   * `duration-[var(--duration-base)]` that resolves to nothing and a transition that runs at
   * the browser's default — in the built bundle only, since the dev server emits the same CSS
   * and would show the same absence nobody was looking for.
   */
  it("are declared in a block that cannot be tree-shaken", () => {
    const block = css.match(/@theme static \{[^}]*\}/);
    expect(block, "no `@theme static` block in index.css").not.toBeNull();
    for (const tier of Object.keys(DURATION)) {
      expect(block?.[0], `--duration-${tier} outside @theme static`).toContain(
        `--duration-${tier}:`,
      );
    }
  });
});

describe("the test environment", () => {
  /**
   * `src/test-setup.ts` set this, and this test file can see it.
   *
   * Two things fail here and both are silent otherwise. If the setup line is dropped, the ~242
   * story `play` functions go back to asserting against half-finished fades — jsdom has no
   * `Element.prototype.animate`, so `motion` runs its own `requestAnimationFrame` driver and
   * animates for real (probed: `opacity: 0.08` at mount for a 180ms fade). And if the module
   * graph ever hands a test file a second copy of `motion`, the flag set over there is not the
   * flag read over here, which is exactly the failure a global config object cannot report.
   */
  it("skips animations, out of the same module instance the setup file wrote", () => {
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
  });
});
