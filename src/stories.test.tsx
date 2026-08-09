import { composeStories } from "@storybook/react-vite";
import { describe, expect, it } from "vitest";

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
