import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
 * shared by all 60 test files, and both of these specifiers are ones the app's own tests are
 * entitled to see unmocked. Hoisted above the imports by Vitest's transform, so the position
 * here is for reading, not for ordering.
 *
 * Keep this list in step with `.storybook/main.ts`'s — with **one deliberate omission**, which
 * is worth reading in full before adding it back. `main.ts` has a third alias,
 * `@/lib/images` → `.storybook/fake/images.ts`, and it cannot be written as a `vi.mock` here.
 * `vite.config.ts` aliases `@` to `/src`, so `vi.mock("@/lib/images")` resolves to
 * `src/lib/images.ts`; the fake's first line is `export * from "../../src/lib/images"`, which
 * resolves to that same file. A Vite alias matches the *specifier* as written, so the fake's
 * relative import walks past it untouched — `vi.mock` matches the *resolved id*, so it does
 * not, and the mock factory ends up importing the very module it stands in for.
 *
 * **The symptom is a hang, not an error.** Measured 2026-08-09: `vitest run` on this file
 * printed no output, failed no test, hit no timeout, and was killed at 300 s. If someone adds
 * that third mock and the suite goes silent, this paragraph is the answer.
 *
 * Nothing is lost by leaving it out. The fake's only override is `cardImageUrl`, which swaps an
 * `mtgimg://` URL for a synthetic data URI, and jsdom loads neither — so a play asserts that an
 * image is *present*, never what its `src` says.
 */
vi.mock("@tauri-apps/api/core", () => import("../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../.storybook/fake/event"));

/**
 * Layout, faked, so that a `play` over a **virtualised** list has rows to look at.
 *
 * jsdom lays nothing out: every element measures 0, so `@tanstack/react-virtual` sizes its
 * scroll container at 0px, computes an empty window and renders no rows at all. Measured
 * 2026-08-09 with no stub: `VirtualTable` and `CollectionTable` each render **1** element with
 * `role="row"` — the header — and `CardGrid` renders **0** tile buttons. It scrolls through
 * `Element.scrollTo`, which jsdom does not implement either. The same three lines
 * `VirtualTable.test.tsx:14-18` and the three views' own suites use, for the same reason.
 *
 * **Here and not in a story's `play`, and that is the whole point of putting it in this file.**
 * A `play` runs in the Storybook *browser* as well as under Vitest, and `offsetHeight` is a
 * native prototype accessor there: `Object.defineProperty` over it cannot be undone — `delete`
 * removes the own property this call installed and does not restore the accessor it shadowed —
 * so a story that patched it would break layout for the whole iframe, permanently, for every
 * story the reader opened afterwards. This file is Vitest-only and the Storybook build never
 * loads it: `main.ts`'s `stories` glob requires a literal `.stories.tsx` suffix under `src/`,
 * which a `.test.tsx` cannot match. (The glob is not written out here: it ends in the two
 * characters that close a block comment.)
 *
 * **It is global to every play, present and future**, because it is installed once for the whole
 * file and every story in the repository runs through the loop below. Tasks 13–15 story
 * `SearchPage` and `WishlistPage` over this same `VirtualTable` and will inherit it with no
 * setup of their own.
 *
 * Two things it deliberately does **not** buy, both of which a story must keep deferring:
 *
 * 1. **A viewport.** 600 × 900 is a number, not this app's window, so *how many* rows the
 *    virtualiser draws here is an artefact of this file. A `play` therefore asserts the
 *    **presence of a named row near the top of the list** and never a count — a count would be
 *    a green assertion that silently re-measures the day anyone touches these two numbers, the
 *    row pitch, or `overscan`.
 * 2. **`CardGrid`'s column count.** That wall does not ask the virtualiser how wide it is: it
 *    measures its own rows container with `clientWidth` and a `ResizeObserver`
 *    (`CardGrid.tsx:191-198`), and `src/test-setup.ts` stubs `ResizeObserver` to a no-op. So
 *    `clientWidth` stays 0, `columnsFor` floors at one column, and every tile is
 *    `TILE_MIN_WIDTH` wide. Tiles render — which is what this stub is for — but a claim about
 *    *how many fit across* is still a claim only a browser can settle.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

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
        // Runs with the project annotations installed above, so `preview.tsx`'s `FakeWorld`
        // decorator is in place and every story here — props-only or backend-driven — gets the
        // `QueryClientProvider` and a freshly seeded fake world. The props-only ones neither
        // need it nor notice it. A new story needs no edit to this file: write it, give it a
        // `play`, and the glob finds it. A failure here is therefore the story disagreeing with
        // the DOM it renders, never this file missing its wiring.
        await story.run();
      });
    }
  });
}
