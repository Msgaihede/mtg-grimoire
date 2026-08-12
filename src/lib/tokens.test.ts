import { describe, expect, it } from "vitest";
/**
 * The stylesheet as it ships, read through Vite rather than through `node:fs` — this
 * project has no `@types/node` on purpose (see `vite.config.ts`'s one `@ts-expect-error`),
 * and `?raw` is how `iconFont.test.ts` already reads the files it asserts against.
 */
import css from "@/index.css?raw";

/**
 * Every source file in the app, as text, for the sweep below.
 *
 * The stylesheet is in the sweep too, and not only the components: Tailwind's scanner reads
 * prose as eagerly as code, so a class named in a *comment* is a class the build emits a
 * rule for — which is how a retired name goes on looking alive in `dist/`.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The class this rename retired, assembled from two pieces on purpose.
 *
 * Written out whole it would match this very file — but the real reason is the second one:
 * the rename was done with a find-and-replace over `src/`, and a guard that spells the
 * banned name out is rewritten by that same sweep into a guard against the *new* name,
 * which then passes on a codebase where nothing was renamed at all.
 */
const OLD_DIM_TEXT = new RegExp(`\\btext-${"muted"}\\b(?!-foreground)`);

describe("colour tokens", () => {
  /**
   * The tripwire this rename removed: Tailwind builds `bg-muted` *and* the dim-text class
   * from one `--color-muted` literal, so as long as that literal was the app's dim *text*
   * colour, every vendored shadcn component rendered text on the same colour as its
   * background (a stock `TabsList` had invisible labels). Ours is `--color-dim` now, and
   * `--color-muted` means what shadcn means by it.
   */
  it("keeps dim text and the muted surface as two different tokens", () => {
    expect(css).toMatch(/--color-dim:\s*oklch/);
    expect(css).toMatch(/--color-muted:\s*var\(--color-surface\)/);
    expect(css).toMatch(/--muted-foreground:\s*var\(--color-dim\)/);
  });

  /**
   * A guard rather than a ceremony test: the old class still *compiles* — it is now a
   * surface colour on text, which renders as very nearly invisible rather than as an
   * error. The failure mode is a screen nobody can read, found by a user.
   */
  it("has no dim-text class left under the old name", () => {
    // A glob that stops matching returns `{}`, and a sweep over nothing finds nothing —
    // which is a green test over an unswept codebase. The app is ~50 files; 20 is a floor
    // that only a broken pattern falls through.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => OLD_DIM_TEXT.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

/**
 * How far after a `transition-*` class the sweep below will look for its opt-out.
 *
 * The two live in one `cn(…)` call, but not always on one line — the widest real gap in
 * this codebase is 216 characters (`CollectionTable`'s remove button, whose class list runs
 * to five lines). 400 is that with room, and still far narrower than the distance to the
 * *next element's* className, which is what makes a missing token a failure rather than a
 * near-miss: run against the commit before this guard, it named all four sites that had
 * lost it and nothing else.
 */
const MOTION_WINDOW = 400;

/**
 * A transition class, ignoring `transition-none` — which is what the opt-out itself is
 * spelled with, and is by definition already still.
 */
const TRANSITION = /\btransition-(?!none)/g;

describe("reduced motion", () => {
  /**
   * The direction's rule, and WCAG 2.3.3: every animation this app runs has an opt-out for
   * a reader who asked the OS for less motion. It is a class, not a stylesheet rule, so
   * forgetting it is invisible — the control looks and behaves correctly to anyone who did
   * not ask, which is everyone writing the code. Four of them had been missed by the end of
   * Plan 3.
   *
   * Not a check that the *right* opt-out was chosen: `motion-reduce:animate-none` and
   * `motion-reduce:hidden` are both correct answers elsewhere, and only transitions are
   * swept here because only transitions are common enough to forget.
   */
  it("gives every transition a motion-reduce opt-out", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      // Tests name classes to assert on them, and asserting on one is not shipping it.
      if (path.includes(".test.")) continue;
      for (const match of source.matchAll(TRANSITION)) {
        const window = source.slice(match.index, match.index + MOTION_WINDOW);
        if (!window.includes("motion-reduce:transition-none")) {
          offenders.push(`${path}: ${source.slice(match.index, match.index + 40)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * An opening `<MotionConfig` tag and everything up to the `>` that closes it, so a prop can be
 * read off the tag it is actually on.
 */
const MOTION_CONFIG_TAG = /<MotionConfig\b[^>]*>/g;

/**
 * The two `motion` APIs the shipped CSP silently disables, assembled from pieces.
 *
 * Both halves of that assembly earn themselves. A guard that spells its banned string matches
 * **this file** and fails on itself; and the app's own source is edited by find-and-replace,
 * which would rewrite a spelled-out guard along with the code it guards and leave it passing
 * over a codebase where nothing was fixed. `OLD_DIM_TEXT` above is here for the same two
 * reasons.
 */
const FORBIDDEN_MOTION_APIS = [`pop${"Layout"}`, `animate${"View"}`];

describe("motion vocabulary", () => {
  /**
   * One reduced-motion switch for the whole app, set to the one value that honours the reader.
   *
   * `motion` ships `reducedMotion: "never"` in `MotionConfigContext`, so the *absence* of this
   * provider is not a neutral state — it is every animation in the app running at full travel
   * for someone who asked their OS for less. And a second `MotionConfig` anywhere inside the
   * first would override it for its whole subtree, silently, and only for the readers who
   * cannot watch it working correctly for everyone else.
   *
   * Sibling mounts of the *same* rule are fine and one exists: `.storybook/preview.tsx` carries
   * one so the workbench matches the app. This sweep is `/src/**` and does not see it.
   *
   * The `.test.` skip is the transition sweep's, for the transition sweep's reason — a test
   * that mounts a `MotionConfig` to assert on one is not shipping a second provider.
   */
  it("mounts exactly one MotionConfig, and it is the reader's preference", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const tags: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.includes(".test.")) continue;
      for (const match of source.matchAll(MOTION_CONFIG_TAG)) tags.push(`${path}: ${match[0]}`);
    }

    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('reducedMotion="user"');
  });

  /**
   * **This sweep is the only thing in the project that can catch either name, which is why it
   * must not be deleted as redundant.**
   *
   * The shipped CSP is `style-src 'self'; style-src-attr 'unsafe-inline'`: an inline `style=`
   * attribute is allowed — which is what `motion` writes, and why it is usable here at all —
   * but a `<style>` **element** appended at runtime is blocked. Two public `motion` APIs append
   * exactly that: the out-of-flow exit mode for `AnimatePresence`, and the view-transition
   * builder exported from `motion`'s root. Under the shipped policy the stylesheet they insert
   * a rule into is `null`, which both already guard for — so they **do nothing at all**. No
   * throw, no console error, just exiting siblings that jump. `MotionConfig`'s `nonce` prop is
   * not a way out: it needs a nonce-based `style-src` and this app has `'self'`.
   *
   * **The dev CSP has `style-src 'self' 'unsafe-inline'`.** So `tauri dev`, Storybook, jsdom
   * and every test in this suite are green on a violation that appears only in the built exe.
   * There is no runtime check to write, no story that can fail, and no assertion to make about
   * behaviour — the only observable is the source text.
   *
   * Prose counts, deliberately: a doc comment naming one of these is how it gets typed into a
   * component by whoever copies that comment. `src/lib/motion.ts` describes both without
   * spelling either, and says why.
   */
  it("names neither of the two motion APIs the shipped CSP silently disables", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      for (const api of FORBIDDEN_MOTION_APIS) {
        if (source.includes(api)) offenders.push(`${path}: ${api}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
