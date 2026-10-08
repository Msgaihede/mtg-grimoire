import { describe, expect, it } from "vitest";
/**
 * The stylesheet as it ships, read through Vite rather than through `node:fs` — this
 * project has no `@types/node` on purpose (see `vite.base.ts`'s one `@ts-expect-error`),
 * and `?raw` is how `iconFont.test.ts` already reads the files it asserts against.
 */
import css from "@/index.css?raw";
/**
 * The same trick, for the two files the mount sweep at the bottom of this file reads.
 * `App.tsx` is under `SOURCES`' glob already, but `.storybook/preview.tsx` is not — the glob
 * below is scoped to the app's two source roots, on purpose, and leaves the workbench's own
 * source out — and a second `?raw` import is what the top of this file already reaches for
 * rather than `node:fs`.
 */
import appSource from "@/App.tsx?raw";
import previewSource from "../../../.storybook/preview.tsx?raw";

/**
 * Every source file in the app, as text, for the sweep below — **the desktop's `packages/ui/` and the
 * light app's `apps/light/`**, which is the same program drawn as a second face. Until phase 3 this
 * stopped at `packages/ui/`, because the one-`MotionConfig` count below would have found the phone face's
 * own and gone red; the count now knows about both faces, so every other sweep here covers
 * `apps/light/` too rather than being followed there by hand.
 *
 * The stylesheet is in the sweep too, and not only the components: Tailwind's scanner reads
 * prose as eagerly as code, so a class named in a *comment* is a class the build emits a
 * rule for — which is how a retired name goes on looking alive in `dist/`.
 */
const SOURCES = import.meta.glob<string>(
  [
    "/packages/ui/**/*.{ts,tsx,css}",
    "/apps/desktop/src/**/*.{ts,tsx,css}",
    "/apps/light/**/*.{ts,tsx,css}",
    // The light app's root also holds its two configs and, after a build, `dist-mobile/` and
    // `dist-web/` — minified CSS and built HTML that nobody wrote.
    "!/apps/light/vite.*.ts",
    "!/apps/light/dist-*/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

/**
 * The class this rename retired, assembled from two pieces on purpose.
 *
 * Written out whole it would match this very file — but the real reason is the second one:
 * the rename was done with a find-and-replace over `packages/ui/`, and a guard that spells the
 * banned name out is rewritten by that same sweep into a guard against the *new* name,
 * which then passes on a codebase where nothing was renamed at all.
 */
const OLD_DIM_TEXT = new RegExp(`\\btext-${"muted"}\\b(?!-foreground)`);

/**
 * The seven colour-identity deeps deleted on 2026-09-28 — one per colour, colourless and gold — in
 * any spelling: the custom property, a utility built from it, or a bare name in prose. Assembled
 * from pieces for `OLD_DIM_TEXT`'s two reasons.
 */
const RETIRED_DEEP = new RegExp(`\\b${"pie"}-(?:w|u|b|r|g|c|gold)\\b`);

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

  /**
   * The mana colours are the only palette for anything that stands for a Magic colour, and the
   * saturated deeps that stood beside them are gone from `index.css`. What that leaves is the
   * failure `packages/ui/CLAUDE.md` names for a mistyped arbitrary value: a utility built from a deleted
   * token **compiles to no rule at all**, so a mark reaching for one loses its fill in silence and
   * neither suite can see it — jsdom applies no stylesheet. So the names are refused outright, in
   * prose too, since a doc comment naming one is how it gets copied into a component.
   */
  it("names none of the retired colour-identity deeps", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => RETIRED_DEEP.test(source))
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
 * **Where a `MotionConfig` is mounted: once per face, at that face's root.**
 *
 * The desktop's is `App.tsx`'s — which the light app's desktop face mounts whole, so that face
 * has no second one. The phone face is a whole app with providers of its own (`apps/light/CLAUDE.md`)
 * and mounts its own in `PhoneApp`. **The two never nest**: `apps/light/LightApp.tsx` draws one face
 * or the other, never both, and mounts no `MotionConfig` above them. A third mount anywhere is
 * what the count below refuses — inside either face it would override the reader's preference for
 * its whole subtree.
 */
const MOTION_CONFIG_MOUNTS = ["/apps/light/phone/PhoneApp.tsx", "/packages/ui/App.tsx"];

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
   * Sibling mounts of the *same* rule are fine, and two exist: the phone face's, which
   * {@link MOTION_CONFIG_MOUNTS} names, and `.storybook/preview.tsx`'s, so the workbench matches the
   * app — which this sweep does not read.
   *
   * The `.test.` skip is the transition sweep's, for the transition sweep's reason — a test
   * that mounts a `MotionConfig` to assert on one is not shipping a second provider.
   */
  it("mounts exactly one MotionConfig per face, and each is the reader's preference", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    // Both roots, or the count below could be met by one face twice over a glob that lost the other.
    expect(Object.keys(SOURCES).some((path) => path.startsWith("/apps/light/"))).toBe(true);

    const tags: [path: string, tag: string][] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.includes(".test.")) continue;
      for (const match of source.matchAll(MOTION_CONFIG_TAG)) tags.push([path, match[0]]);
    }

    // One a face, each in the file named for it — not two in one file, not one in a page.
    expect(tags.map(([path]) => path).sort()).toEqual(MOTION_CONFIG_MOUNTS);
    for (const [path, tag] of tags) expect(`${path}: ${tag}`).toContain('reducedMotion="user"');
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
   * **There is no CSP in `tauri dev` at all** — not a laxer one. Vite's dev server sends no
   * `Content-Security-Policy` header and the HTML has no CSP `meta` (measured 2026-08-28),
   * because a `devUrl` puts the webview on Vite's origin with Tauri out of the response
   * path. `devCsp` is therefore not the reason, and editing it does not make dev strict.
   * So `tauri dev`, Storybook, jsdom
   * and every test in this suite are green on a violation that appears only in the built exe.
   * There is no runtime check to write, no story that can fail, and no assertion to make about
   * behaviour — the only observable is the source text.
   *
   * Prose counts, deliberately: a doc comment naming one of these is how it gets typed into a
   * component by whoever copies that comment. `packages/ui/lib/motion.ts` describes both without
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

/**
 * Every way this app's source can build a Tiptap editor: the React hook and the bare class.
 * `\b` on both, so a longer identifier that merely ends in one of them is not a call.
 */
const EDITOR_CALL = /\b(?:useEditor|new Editor)\(/g;

/** The editor library's component form, which takes the same options as JSX props. */
const EDITOR_PROVIDER = /<EditorProvider\b/;

/** The one spelling of the option that counts — `true`, a variable and absence all inject. */
const INJECT_CSS_OFF = /\binjectCSS:\s*false\b/;

/** The import that puts ProseMirror's base rules in the bundle, where the policy permits them. */
const PROSEMIRROR_SHEET = 'import "prosemirror-view/style/prosemirror.css"';

/**
 * The text of a call's arguments: from just after its opening parenthesis to the one that
 * closes it. Counted rather than cut at a fixed width, because the options object of the one
 * real call runs to a dozen lines and will grow, and a window that stopped short of the line
 * would report a fenced editor as an offender.
 *
 * It reads parentheses inside strings and comments as code, which can only run the text long
 * or short by a balanced pair in prose — and an unbalanced one that ran it to the end of the
 * file would find the option in some later call and pass. That is the one way past this, and
 * it needs a lone parenthesis written inside an editor's own options.
 */
function callArguments(source: string, open: number): string {
  let depth = 1;
  let at = open;
  while (at < source.length && depth > 0) {
    const char = source[at];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    at += 1;
  }
  return source.slice(open, at);
}

describe("an editor's stylesheet", () => {
  /**
   * **The same policy as the motion sweep above, and the same reason a sweep is the only fence.**
   *
   * Tiptap's `injectCSS` option defaults to on, and on it appends a `<style>` element to
   * `<head>` for every editor it builds. `style-src 'self'` refuses that — in the packaged
   * desktop app, in the Android app and at `mtg-grimoire.app` — so the sheet is applied nowhere a
   * reader runs the app, and costs a console error each time. `tauri dev`, Storybook and jsdom
   * carry no policy and apply all of it. It shipped that way from the day the editor landed
   * until 2026-10-04, when the live site said so; `NoteEditor.tsx`'s header has what the sheet
   * carried and why nothing had to replace it.
   *
   * So an editor built with the option left on is green in every suite and every story, and
   * wrong only in a shipped window. `scripts/web-smoke.mjs` opens a note under the hosting
   * policy and hears it, but `pnpm verify` does not run that — this does.
   *
   * Tests are skipped: `NoteEditor.test.tsx` builds bare editors by the dozen to drive commands,
   * under jsdom, where a `<style>` in `<head>` is neither refused nor read.
   */
  it("turns the library's injected sheet off on every editor the app builds", () => {
    const calls: [path: string, args: string][] = [];
    const providers: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.includes(".test.")) continue;
      if (EDITOR_PROVIDER.test(source)) providers.push(path);
      for (const match of source.matchAll(EDITOR_CALL)) {
        calls.push([path, callArguments(source, match.index + match[0].length)]);
      }
    }

    // A sweep that finds no editor passes over a codebase where every editor injects. The app
    // has one, and this names its file so that a moved or renamed editor is a red test to read
    // rather than a guarantee that quietly became about nothing.
    expect(calls.map(([path]) => path)).toContain("/packages/ui/features/decks/NoteEditor.tsx");

    const offenders = calls
      .filter(([, args]) => !INJECT_CSS_OFF.test(args))
      .map(([path, args]) => `${path}: ${args.slice(0, 60)}`);
    expect(offenders).toEqual([]);

    // The component form spells the option as a prop, which the test above cannot read. Nothing
    // uses it; an editor that wants it has to teach this sweep its spelling first.
    expect(providers).toEqual([]);
  });

  /**
   * The other half, and what makes the first one safe to ask for: with the injection off, the
   * rules ProseMirror cannot work without — `white-space` above all, which it warns on the
   * console for the want of — reach the page only where the module that builds the editor
   * imports them for the bundler. `NoteEditor.tsx` does; a second editor in a second file that
   * copied the option and not the import would have no such rule on any host, dev included.
   */
  it("bundles ProseMirror's own sheet wherever an editor is built", () => {
    const bare = Object.entries(SOURCES)
      .filter(([path, source]) => !path.includes(".test.") && source.search(EDITOR_CALL) !== -1)
      .filter(([, source]) => !source.includes(PROSEMIRROR_SHEET))
      .map(([path]) => path);
    expect(bare).toEqual([]);
  });
});

/**
 * **The two mounts that make `useTooltip` do anything.**
 *
 * The hook falls back to a no-op API when no provider is above it — deliberately, because after
 * the sweep most surfaces bind a tooltip and every one of them is also a story and a test that
 * renders it alone, so a throw would be `stories.test.tsx` red for everybody. The cost of that
 * choice is that a dropped provider is *silent*: every hint in the app, or every hint in the
 * workbench, simply stops appearing. This is what makes it loud.
 */
describe("the tooltip provider is mounted where it has to be", () => {
  it("wraps the app", () => {
    expect(appSource).toContain("<TooltipProvider>");
  });

  it("wraps every story too", () => {
    expect(previewSource).toContain("<TooltipProvider>");
  });

  it("mounts the tooltip provider outside the context menu's, in the app", () => {
    // Not a style rule. `ContextMenuProvider` renders its menu panel as a *sibling* of its
    // children, so a tooltip context nested inside it would wrap every view and none of the
    // menu's own rows — and a row that binds a tooltip would get the no-op API, silently.
    //
    // `toBeGreaterThan(-1)` matters on its own: without it, a *deleted* provider's `indexOf`
    // of -1 is "less than" everything, and this assertion would pass on the exact failure —
    // a dropped `TooltipProvider` — it exists to catch. The presence test above already
    // covers that failure; this one is only for the ordering.
    expect(appSource.indexOf("<TooltipProvider>")).toBeGreaterThan(-1);
    expect(appSource.indexOf("<TooltipProvider>")).toBeLessThan(
      appSource.indexOf("<ContextMenuProvider>"),
    );
  });

  it("mounts the tooltip provider outside the context menu's, in the workbench too", () => {
    expect(previewSource.indexOf("<TooltipProvider>")).toBeGreaterThan(-1);
    expect(previewSource.indexOf("<TooltipProvider>")).toBeLessThan(
      previewSource.indexOf("<ContextMenuProvider>"),
    );
  });
});
