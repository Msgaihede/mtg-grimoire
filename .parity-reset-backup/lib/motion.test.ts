import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { motion, MotionGlobalConfig } from "motion/react";
/**
 * The stylesheet as it ships. Read through Vite with `?raw`, exactly as `tokens.test.ts` and
 * `iconFont.test.ts` read the files they assert against — this project has no `@types/node`,
 * so `node:fs` is not available to a test and is not going to be.
 */
import css from "@/index.css?raw";
import * as CHIPS from "@/components/FilterChips";
import { isTextEntry } from "@/components/menu/panel";
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

describe("the press recipes", () => {
  /**
   * `PRESS` and `PRESS_SOFT` are template literals over `PRESS_STILL`, which is what
   * keeps the twelve-utility property list written once. The join is the risk that buys:
   * **a missing space would fuse `motion-reduce:transition-none` to `active:scale-[0.97]`,
   * Tailwind would extract neither, and the built CSS would carry no rule at all** — with
   * source still reading correctly and nothing else going red. `0.99` is the sharp end,
   * because `PRESS_SOFT` is the only place in `src/` that spells it.
   */
  it("compose into whole class names, so Tailwind can extract them", () => {
    for (const [name, recipe] of [
      ["PRESS", MOTION.PRESS],
      ["PRESS_SOFT", MOTION.PRESS_SOFT],
    ] as const) {
      const classes = recipe.split(" ").filter(Boolean);
      expect(classes, `${name} lost a class to a bad join`).toContain(
        "transition-[color,background-color,border-color,opacity,transform,scale]",
      );
      expect(classes, `${name} lost its duration`).toContain("duration-[var(--duration-fast)]");
      expect(classes, `${name} lost its curve`).toContain("ease-standard");
      // The opt-out `tokens.test.ts` sweeps for, and the reason it can be absent from the
      // twelve call sites: it travels inside the recipe rather than beside it.
      expect(classes, `${name} lost its reduced-motion opt-out`).toContain(
        "motion-reduce:transition-none",
      );
    }

    expect(MOTION.PRESS.split(" ")).toContain("active:scale-[0.97]");
    expect(MOTION.PRESS_SOFT.split(" ")).toContain("active:scale-[0.99]");
  });

  /** The dip is the whole of the difference — that is the claim `PRESS_STILL` rests on. */
  it("differ by exactly one utility", () => {
    const press = MOTION.PRESS.split(" ").filter(Boolean);
    const soft = MOTION.PRESS_SOFT.split(" ").filter(Boolean);
    expect(press.filter((c) => !soft.includes(c))).toEqual(["active:scale-[0.97]"]);
    expect(soft.filter((c) => !press.includes(c))).toEqual(["active:scale-[0.99]"]);
  });

  /**
   * The same claim from the other end: `PRESS_STILL` is a press recipe with the movement taken
   * out and nothing else taken out with it. A field that lost the reduced-motion opt-out or the
   * tier along with the dip would be a second timing vocabulary, which is the thing this file
   * exists to prevent.
   */
  it("leave a still recipe that is the dip removed and nothing else", () => {
    const press = MOTION.PRESS.split(" ").filter(Boolean);
    const still = MOTION.PRESS_STILL.split(" ").filter(Boolean);
    expect(press.filter((c) => !still.includes(c))).toEqual(["active:scale-[0.97]"]);
    expect(still.filter((c) => !press.includes(c))).toEqual([]);
  });
});

/**
 * Every `.tsx` in the app, as text. The same `?raw` glob `tokens.test.ts` sweeps with, and for
 * the same reason: this project has no `@types/node` on purpose, so a test cannot read the tree.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Every `<input …>` opening tag in a source file, **as code** — its comments dropped.
 *
 * Hand-sliced rather than regexed to the first `>`, because an attribute's arrow function ends
 * `=>` and would cut the tag off at its first handler — which reads as a green sweep over an
 * element nobody checked. The scan tracks brace depth, string quotes and both comment forms, so
 * the `>` it stops at is the tag's own: a JSX expression container is `{…}`, a backtick inside a
 * doc comment is not an unterminated template, and an apostrophe in prose is not a quote.
 *
 * **The comments come out, and that is not tidiness.** The first draft kept them, and the five
 * call sites this bug was fixed at all failed the sweep — on the sentence saying which recipe
 * they had stopped using. A class is a thing an element wears; a comment about a class is prose,
 * and a sweep that cannot tell them apart is one nobody can explain a rule in.
 */
function inputTags(source: string): string[] {
  const found: string[] = [];
  const opener = /<input(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let code = "<input";
    let depth = 0;
    let quote: string | null = null;
    let i = match.index + code.length;
    for (; i < source.length; i++) {
      const c = source[i];
      const next = source[i + 1];
      if (quote !== null) {
        code += c;
        if (c === "\\") {
          code += source[i + 1] ?? "";
          i++;
        } else if (c === quote) quote = null;
        continue;
      }
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end;
        continue;
      }
      if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i);
        i = end === -1 ? source.length : end + 1;
        continue;
      }
      code += c;
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push(code);
    opener.lastIndex = i + 1;
  }
  return found;
}

/** Every input the app draws, with the file it is drawn in. */
const INPUTS = Object.entries(SOURCES).flatMap(([path, source]) =>
  inputTags(source).map((tag) => ({ path, tag })),
);

/**
 * Whether this is a box with a caret in it, decided by **the app's own predicate** rather than
 * by a list written here — `menu/panel.ts` already had to answer "is this a thing you type
 * into" for the context menu's caret keys, and two lists would drift.
 *
 * A `type` written as an expression rather than as a literal counts as text entry: nothing in
 * `src/` does that today, and guessing "not a field" is the direction that fails quietly.
 */
function typedInto(tag: string): boolean {
  const literal = /\stype="([a-z]+)"/.exec(tag);
  const probe = document.createElement("input");
  if (literal !== null) probe.setAttribute("type", literal[1]);
  else if (/\stype=\{/.test(tag)) return true;
  return isTextEntry(probe);
}

/**
 * Every class recipe in the app that scales its control while it is held down, by name.
 *
 * Read off the modules rather than listed, so a fourth recipe is swept the day it is exported.
 * `active:scale-100` is not one of these — that is a recipe *undoing* the dip for a control
 * that is out of reach, which is the opposite fact.
 */
const DIPPING = Object.entries({ ...MOTION, ...CHIPS })
  .filter(([, value]) => typeof value === "string" && /active:scale-\[/.test(value))
  .map(([name]) => name);

describe("a box the reader types into", () => {
  /**
   * The regression behind issue #179, stated as the rule rather than as the symptom.
   *
   * Chromium draws the ✕ of an `<input type="search">` inside the field's own shadow tree, and a
   * `scale` pivots on the field's centre — so while the button is held down the whole box, and
   * that button with it, slides left by `width × (1/0.97 − 1) / 2`. `click` is dispatched to the
   * common ancestor of the press target and the release target, so once the button has travelled
   * out from under the pointer the click lands on the *field*, Blink's cancel-button handler
   * never runs, and the box dips without clearing. What gets reported is exactly that: the box
   * bounces and the text stays.
   *
   * **It is a width bug, which is why it read as one box working and the rest not.** Swept a
   * pixel at a time in Chromium 2026-08-21 against a 10px-wide cancel button: at 176px the press
   * still landed over 8 of those pixels, at 256px over 7, and at 700px over **none at all**. The
   * filter row's boxes are `min-w-56 flex-1`.
   *
   * **Nothing in the suite can see the behaviour** — jsdom has no layout engine and no
   * user-agent shadow tree, so there is no button to press and no hit test to miss. This sweeps
   * the cause instead, which is a class on an element, and is the only thing here that can go
   * red. The behaviour is checked in a browser, and the measurement above is that pass.
   */
  it("never wears a recipe that dips it under the pointer", () => {
    // Four ways this sweep goes vacuously green, each pinned: a glob that stopped matching, a
    // scanner that stopped finding tags, a scanner that finds tags but no *field*, and a
    // `DIPPING` emptied by a rename out from under it.
    expect(Object.keys(SOURCES).length, "the glob swept nothing").toBeGreaterThan(20);
    expect(INPUTS.length, "the scanner found no <input> at all").toBeGreaterThan(20);
    expect(INPUTS.filter(({ tag }) => typedInto(tag)).length).toBeGreaterThan(5);
    expect(DIPPING, "the recipe this bug was filed against").toContain("FILTER_CONTROL");

    const offenders = INPUTS.filter(({ tag }) => typedInto(tag)).filter(
      ({ tag }) =>
        /\bactive:scale-\[/.test(tag) ||
        DIPPING.some((name) => new RegExp(`\\b${name}\\b`).test(tag)),
    );

    expect(offenders.map(({ path }) => path)).toEqual([]);
  });

  /**
   * And the box that draws the ✕ really is one of the boxes above — a tripwire on the predicate
   * rather than on the sweep. `isTextEntry` is a deny-list, so a `search` input quietly dropping
   * out of it would leave the sweep green over the exact family issue #179 was about.
   */
  it("includes every search box in the app", () => {
    const searches = INPUTS.filter(({ tag }) => /\stype="search"/.test(tag));
    expect(searches.length).toBeGreaterThan(3);
    expect(searches.filter(({ tag }) => !typedInto(tag))).toEqual([]);
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

  /**
   * The flag alone is **not** enough, and this is the assertion that says so.
   *
   * `skipAnimations` still applies the final keyframe inside `frame.update(...)`, one
   * `requestAnimationFrame` after the commit — so without the frame flush `src/test-setup.ts`
   * installs beside it, a `motion` element sits at its `initial` (`opacity: 0` for every preset
   * in this file) for one frame after it renders. Anything asserting `toBeVisible` on content
   * inside a dialog or the card pane then races that frame, and loses on a loaded CI runner:
   * `byRole` finds the element, because the accessibility tree ignores opacity, and
   * `toBeVisible` refuses it, because it does not.
   *
   * A behavioural check rather than a check that the patch is installed, so that a `motion`
   * upgrade which changes *how* the keyframe is scheduled fails here rather than on CI a week
   * later. `dialog` is the preset the card pane and every modal spread.
   */
  it("paints a motion element at its animate value, not its initial, on the first frame", () => {
    // `role` rather than a `data-testid`: this file is `.ts`, so the element is built with
    // `createElement`, whose props are typed and reject an arbitrary `data-*` attribute.
    const { getByRole } = render(createElement(motion.div, { ...MOTION.dialog, role: "note" }));
    expect(getComputedStyle(getByRole("note")).opacity).toBe("1");
  });
});
