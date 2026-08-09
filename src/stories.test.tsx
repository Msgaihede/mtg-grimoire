import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { describe, expect, it, vi } from "vitest";
import preview from "../.storybook/preview";

/**
 * The module aliases `.storybook/main.ts` gives the Storybook build, given to this file.
 *
 * `setProjectAnnotations` alone is **not** enough for a story that talks to the backend, and
 * the half it does not cover is invisible until something calls a command. The decorator
 * installs a fake world into `.storybook/fake/core.ts`'s dispatch table — but `src/lib/ipc.ts`
 * imports `@tauri-apps/api/core`, and under Vitest that resolves to the *real* module, whose
 * `invoke` reads `window.__TAURI_INTERNALS__`. Measured 2026-08-09 with a throwaway story that
 * called `ipc.listSets()`: with the annotations and without these mocks it renders
 * `TypeError: Cannot read properties of undefined (reading 'invoke')` — a seeded world nobody
 * is asking.
 *
 * `vi.mock` rather than an alias in `vite.config.ts`, because Vitest's `resolve.alias` is
 * shared by all 60 test files and three of these specifiers are ones the app's own tests are
 * entitled to see unmocked. Hoisted above the imports by Vitest's transform, so the position
 * here is for reading, not for ordering.
 *
 * Keep this list in step with `.storybook/main.ts`'s — with **one deliberate omission**.
 * `main.ts` also aliases `@/lib/images` to `.storybook/fake/images.ts`, and that one cannot be
 * expressed here: the fake begins `export * from "../../src/lib/images"`, and a relative path
 * to the very file being mocked. Vite's alias matches the *specifier*, so the fake's own
 * import escapes it; `vi.mock` matches the *resolved id*, so it does not, and the factory ends
 * up importing what it is replacing. Measured 2026-08-09: the run hangs, no output, no
 * timeout. Nothing is lost by leaving it out — the fake's sole override is `cardImageUrl`,
 * which swaps a `mtgimg://` URL for a synthetic data URI, and jsdom loads neither.
 */
vi.mock("@tauri-apps/api/core", () => import("../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../.storybook/fake/event"));

/**
 * Every `play` function in every story, run under Vitest.
 *
 * A `play` is the right place for a story's claim: it travels with the story, and a reader who
 * opens Storybook sees it pass or fail in the Interactions panel beside the thing it is about.
 * But nothing else in this repository's checks runs one — `npm run build-storybook` compiles
 * stories, it does not play them. So the stories whose entire subject is a fact nobody can
 * *see* (a component that renders `null`, an ARIA attribute that must be absent, an `sr-only`
 * accessible name) would be asserted only by a browser `npm run verify` never opens.
 *
 * `composeStories` closes that: it applies each story's args and returns something renderable,
 * and `.run()` renders it and awaits its `play`.
 *
 * This is not a second copy of the component tests. `ManaText.test.tsx` and friends cover the
 * components; this covers the *stories*, and it fails for the two reasons a story fails on its
 * own — args that stopped type-checking against the component, and a play whose claim about
 * the rendered DOM stopped being true.
 */

/**
 * Every story module under `src/`, **found rather than listed**.
 *
 * The first draft of this file named its four modules by hand, and that is the one systemic
 * failure it could have: a module nobody remembered to add contributes no plays and no
 * failure, which on the terminal is indistinguishable from a green run. Nine more story files
 * are coming; the thing this file must not have is a registration step.
 *
 * `eager` because a `describe` block cannot be built from a promise — Vitest collects the file
 * synchronously, so a lazy glob would register no tests at all.
 */
const MODULES = import.meta.glob("/src/**/*.stories.tsx", { eager: true });

/** What `composeStories` will accept. `import.meta.glob` types its modules as `unknown`, so
 *  the cast is unavoidable; it is narrowed to the parameter's own type rather than to `any`. */
type StoriesModule = Parameters<typeof composeStories>[0];

interface Played {
  run: () => Promise<void>;
}

/**
 * The stories in one composed module that carry a `play`.
 *
 * Narrowed through the returned record rather than through `composeStories`' own generic
 * result, because a loop over modules of four different shapes widens to a union it will not
 * accept.
 */
function playsIn(stories: Record<string, unknown>): [string, Played][] {
  return Object.entries(stories).filter((entry): entry is [string, Played] => {
    const story = entry[1] as { play?: unknown };
    return typeof story?.play === "function";
  });
}

/**
 * The preview's own annotations, installed **before the first `composeStories` call below**.
 *
 * `composeStories` snapshots the project annotations at call time, so this is not a statement
 * of preference about where to put it: annotating after `SCANNED` is built has no effect at
 * all, and the failure is a story running with no decorator and no explanation. It is one
 * line, and it is one line in the only position that works.
 *
 * It buys `preview.tsx`'s `FakeWorld` decorator — the `QueryClientProvider` and the per-story
 * seeded fake backend — for every story here, including the props-only ones, which neither
 * need it nor notice it. Measured: the three CSS side-effect imports load fine under Vitest,
 * and `context.globals.art` being `undefined` in a portable story is already handled (the
 * decorator narrows anything that is not the literal `"live"` to synthetic art).
 */
setProjectAnnotations([preview]);

const SCANNED = Object.entries(MODULES)
  .map(([path, mod]) => ({
    file: path.replace(/^\/src\//, ""),
    plays: playsIn(composeStories(mod as StoriesModule)),
  }))
  .sort((a, b) => a.file.localeCompare(b.file));

/**
 * A tripwire, not a census.
 *
 * A glob that matched nothing — a moved directory, a renamed extension, a pattern that stopped
 * being rooted at the project root — would leave this file passing while running nothing at
 * all, which is exactly the failure the glob was introduced to remove. The floors are what
 * existed when Task 8 landed (5 story files, 5 plays); they are deliberately not exact, so
 * adding a story file never means editing this test.
 */
describe("story files", () => {
  it("globbed story modules, and found plays inside them", () => {
    expect(SCANNED.length, SCANNED.map((s) => s.file).join(", ")).toBeGreaterThanOrEqual(5);
    expect(SCANNED.flatMap((s) => s.plays).length).toBeGreaterThanOrEqual(5);
  });
});

for (const { file, plays } of SCANNED) {
  // No `describe` for a file with no plays: most story files are all-visible states and want
  // none, and an empty block per file would be ceremony. The count above is what notices a
  // file that lost the plays it used to have.
  if (plays.length === 0) continue;

  describe(file, () => {
    for (const [name, story] of plays) {
      it(`${name} plays`, async () => {
        // Deliberately no `setProjectAnnotations` anywhere in this file, so `preview.tsx`'s
        // `FakeWorld` decorator and its three CSS imports stay out of jsdom — every story with
        // a play today is props-only and asks the fake backend nothing. The first story that
        // needs the fake world will fail here, loudly, and the fix is to install the project
        // annotations rather than to quietly drop the story from a list.
        await story.run();
      });
    }
  });
}
