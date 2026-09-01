import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import preview from "../.storybook/preview";
import { CARDS } from "../.storybook/fake/cards";
// **The two story modules the block at the foot of this file names.** Imported rather than
// pulled out of the glob below, because `composeStories` types its result from the module's own
// exports and the glob types every module as `unknown` — a story reached that way has no
// `Gallery` on it as far as the compiler is concerned. The glob loads these two eagerly as
// well; a module is one instance either way, so this costs nothing but the two lines.
import * as AppShellStories from "./components/AppShell.stories";
import * as DecksPageStories from "./features/decks/DecksPage.stories";

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
// The third boundary, mirroring `.storybook/main.ts`'s third alias. `TitleBar` reaches it
// through `src/lib/window.ts`, which is in this file's graph, so the specifier is rewritten
// and the paragraph below about `node_modules` does not apply.
vi.mock("@tauri-apps/api/window", () => import("../.storybook/fake/window"));

/**
 * The three Tauri **plugin** wrappers, re-pointed at the same fake — because **the two mocks
 * above do not reach inside `node_modules`.**
 *
 * `@tauri-apps/plugin-dialog`, `-clipboard-manager` and `-opener` are thin wrappers that each
 * import `invoke` from `@tauri-apps/api/core` *within their own package*. Vitest externalizes
 * dependency ESM by default and `vite.config.ts` sets no `server.deps.inline`, so an externalized
 * package's own imports are never rewritten: `vi.mock` matches the specifier as this file's graph
 * resolves it, and the copy of `@tauri-apps/api/core` those three see is the **real** one. Its
 * `invoke` reads `window.__TAURI_INTERNALS__`, which jsdom does not have.
 *
 * **Measured 2026-08-14, which is the only reason this paragraph is not a guess.** With the two
 * mocks above and nothing else, `Decks/Export dialog`'s three save/copy plays failed with
 * `Could not save that export — Cannot read properties of undefined (reading 'invoke')` — the
 * app's own refusal banner reporting the workbench's plumbing. Every component test that
 * touches a plugin mocks the **plugin package** rather than relying on the core mock; a story
 * cannot, because CSF indexes every non-default export and a `vi.mock` belongs to a test file.
 * So it belongs here, once, for every story.
 *
 * **Which suites those are is deliberately not listed.** It was, and the roster was wrong twice
 * over — it named three deck suites that stopped mocking the plugin when custom covers were
 * removed on 2026-08-31, and it had never mentioned three others that always did.
 * `grep -rln 'vi.mock("@tauri-apps/plugin-dialog"' src/` is the question, and it answers about
 * the tree in front of you rather than the one somebody last edited this comment on.
 *
 * **Each stands in for the wrapper and not for the answer**, which is the whole point: the
 * command name and the argument names below are copied from the packages' own `dist-js` and the
 * reply comes from `pluginHandlers()` in `.storybook/fake/db.ts`, so a story exercises the same
 * dispatch the Storybook browser does rather than a second, agreeing stub. That is `main.ts`'s
 * alias reasoning one layer out.
 *
 * `plugin:dialog|open` is deliberately answered by nothing, so it rejects with "No fake handler
 * registered" — the file *picker* opens a native window CDP cannot drive, and inventing a path
 * for it would invent the decklist behind it. `save` is the one that answers, and
 * `.storybook/CLAUDE.md` carries why the two differ.
 */
vi.mock("@tauri-apps/plugin-dialog", async () => {
  const { invoke } = await import("../.storybook/fake/core");
  return {
    open: (options: unknown = {}) => invoke("plugin:dialog|open", { options }),
    save: (options: unknown = {}) => invoke("plugin:dialog|save", { options }),
  };
});
vi.mock("@tauri-apps/plugin-clipboard-manager", async () => {
  const { invoke } = await import("../.storybook/fake/core");
  return {
    writeText: (text: string, opts?: { label?: string }) =>
      invoke("plugin:clipboard-manager|write_text", { label: opts?.label, text }),
  };
});
vi.mock("@tauri-apps/plugin-opener", async () => {
  const { invoke } = await import("../.storybook/fake/core");
  // `with`, not `openWith` — the wire name is a reserved word in the package's own call, and
  // `invoke` matches by name, so a typo here is a rejection exactly as it is in the app.
  return {
    openUrl: (url: string, openWith?: string) =>
      invoke("plugin:opener|open_url", { url, with: openWith }),
  };
});

/**
 * Layout, faked, so that a `play` over a **virtualised** list has rows to look at.
 *
 * jsdom lays nothing out: every element measures 0, so `@tanstack/react-virtual` sizes its
 * scroll container at 0px, computes an empty window and renders no rows at all. Measured
 * 2026-08-09 with no stub: `VirtualTable` and `CollectionTable` each render **1** element with
 * `role="row"` — the header — and `CardGrid` renders **0** tile buttons. It scrolls through
 * `Element.scrollTo`, which jsdom does not implement either. The same three lines
 * `VirtualTable.test.tsx`'s own `beforeAll` and the three views' own suites use, for the same
 * reason.
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
 *    measures its own rows container with `clientWidth` and a `ResizeObserver` (`CardGrid`'s
 *    effect over `rowsRef`), and `src/test-setup.ts` stubs `ResizeObserver` to a no-op. So
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
 *
 * ## `testingLibraryRender`, which is what **unmounts** a story
 *
 * Without it a story is mounted by `@storybook/react`'s own `renderToCanvas`, which calls
 * `createRoot` and hands the unmount function back to a caller that never runs it. Storybook's
 * `runStory` does clean up — but only at the *start of the next* run, and all it does is
 * `removeChild` the container. **Detaching a container does not unmount React.** So every play
 * below left a live root behind: effects still mounted, queries still subscribed, timers still
 * armed, for the whole length of the file.
 *
 * Passing RTL's `render` puts those roots under this suite's `afterEach(cleanup)`
 * (`src/test-setup.ts`), so each story is torn down when its `it` ends.
 *
 * **What that was costing is a red CI run with `Tests 0 failed`.** Vitest fails a run on an
 * unhandled error even when every test passed, and the error was
 * `ReferenceError: window is not defined` from the debounce `setState` at
 * `features/wishlist/useWishlist.ts` — a 300ms timer armed on *mount* (not on typing) by a
 * story whose root was never unmounted, firing after jsdom had been torn down.
 * `features/wishlist/WishlistPage.stories.tsx` sorts **last** of every story file, which is why
 * it is that hook and not one of the others: its timer is the one still in flight at the end of
 * the file. Measured here by counting 300ms debounce timers left armed at `afterAll` — **1**
 * under a full-suite run before this, **0** after, and 0 either way when the file runs alone,
 * which is why it only ever went red on CI.
 */
setProjectAnnotations([preview, { testingLibraryRender: render }]);

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

/**
 * Two stories with different seeds, **mounted at the same time**.
 *
 * This is the shape of an autodocs page and it is the one shape every other test in this
 * repository misses: the loop above renders one story per `it`, and `.storybook/`'s own suite
 * has no React in it at all (`vite.config.ts` collects `.test.ts` there, never `.test.tsx`).
 * The fake used to install a story's world by overwriting module globals, which is correct
 * when Storybook unmounts one story before mounting the next and wrong when ten of them mount
 * together — the last one to render owned the dispatch table for the whole page. Ten story
 * files put differing seeds and faults on one docs page.
 *
 * The two pairs below are the two ways a story's data arrives:
 *
 * * `DecksPage` reads through TanStack Query.
 * * `AppShell` does not. Its card count comes from `useSync`, which is `setState` and a
 *   chained `setTimeout` by deliberate choice (the *plain hooks rather than TanStack Query*
 *   paragraph on `useSync`), and its first poll is made straight out of a **mount effect**.
 *
 * **Measured 2026-08-10, by breaking each half of the fix in turn and re-running this block**,
 * because "two mechanisms cover this" is worth nothing unless someone has checked which:
 *
 * * Simulate the old module-global world — one shared scope for every `installWorld` — and
 *   **both** fail. That is the regression this block exists for.
 * * Disable the `queryFn`/`mutationFn` binding in `world.ts` and both still pass: on a *first*
 *   mount TanStack Query's fetch starts from `useSyncExternalStore`'s subscribe, which runs in
 *   the layout phase after `<Activate>`'s. The binding is what covers everything after that
 *   first mount — a refetch, a retry, an invalidation — and `world.test.ts`'s "keeps a world's
 *   fetches in it" is where that half is proved, because it can ask for one out of turn.
 * * Move `preview.tsx`'s `<Activate>` after `{children}` and the **`AppShell` pair fails** while
 *   the `DecksPage` pair passes. That is the ordering claim in `Activate`'s doc, measured: a
 *   mount effect reaching the fake directly has nothing else holding the pointer for it.
 *
 * Both pairs are written so that each half asserts something **positive** that only its own
 * seed can produce. A pair of negatives would stay green on a page where nothing rendered.
 */
describe("two stories with different seeds, mounted together", () => {
  /** What `sync_status` answers under the `starter` seed — `db.cards.length`, which is the
   *  generated corpus. Derived rather than typed, so a regeneration moves it. */
  const STARTER_CARDS = CARDS.length.toLocaleString("en-US");

  /** Each story in a box of its own, so `within` can ask one of them a question. A composed
   *  story brings its own decorators, and both of these bring a fixed-size frame. */
  const both = (first: ReactElement, second: ReactElement) => {
    render(
      <>
        <div data-testid="first">{first}</div>
        <div data-testid="second">{second}</div>
      </>,
    );
    return [within(screen.getByTestId("first")), within(screen.getByTestId("second"))] as const;
  };

  it("answers each one's queries out of its own world", async () => {
    const { Gallery, Empty } = composeStories(DecksPageStories);
    const [starter, empty] = both(<Gallery />, <Empty />);

    // `starter` has three decks and `empty` has none, and each half waits for its own answer.
    await waitFor(async () => {
      await expect(starter.getByRole("list", { name: "Your decks" })).toBeInTheDocument();
    });
    await waitFor(async () => {
      await expect(empty.getByText("No decks")).toBeInTheDocument();
    });
    // …and neither has the other's. Read after both positives have landed, on a DOM that has
    // already committed both stories.
    await expect(empty.queryByRole("list", { name: "Your decks" })).toBeNull();
    await expect(starter.queryByText("No decks")).toBeNull();
  });

  it("answers each one's mount-effect poll out of its own world", async () => {
    const { Search, FirstRun } = composeStories(AppShellStories);
    const [starter, empty] = both(<Search />, <FirstRun />);

    // The `starter` shell knows how many cards it has…
    await waitFor(async () => {
      await expect(starter.getByText(new RegExp(`${STARTER_CARDS} cards`))).toBeInTheDocument();
    });
    // …and the `empty` one is still setting up, which is the whole of what a `cardCount` of
    // exactly 0 means.
    await waitFor(async () => {
      await expect(empty.getByRole("dialog")).toHaveTextContent("Setting up your card database");
    });
    await expect(starter.queryByRole("dialog")).toBeNull();
    await expect(empty.queryByText(new RegExp(`${STARTER_CARDS} cards`))).toBeNull();
    // Both stories set the same `activeView`, so this pair says nothing about `useAppStore` —
    // which `preview.tsx` explains cannot be made per-story from outside `src/`, and which is
    // why the four story files that write it during render render in frames on their docs
    // pages instead.
    await expect(starter.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
  });
});
