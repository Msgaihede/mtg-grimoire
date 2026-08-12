# .storybook — the workbench and its fake

`npm run storybook` · `npm run build-storybook`. Full detail, every count and the reasoning
behind each rule: [docs/reference/storybook.md](../docs/reference/storybook.md).

**What it is for: a design workbench, a living catalogue, and an a11y surface** — build a
component against every state at once, find the one that already exists before writing a second,
and let `@storybook/addon-a11y` check contrast and names per story. **Not visual regression,
deliberately**: no screenshots are stored.

## Rules for the fake

- **`main.ts` aliases three specifiers** — `@tauri-apps/api/core`, `@tauri-apps/api/event` and
  `@/lib/images` — to `.storybook/fake/`. **The fake sits _under_ `src/lib/ipc.ts`, not in place
  of it**, and that is the point: `ipc.ts` is a hand-written mirror of the Rust structs and is
  exactly the thing that can drift, so a fake beneath it means every story exercises the mirror
  too. Aliasing `ipc.ts` itself would story the components against a second, agreeing copy of a
  contract nobody had checked.
- **The fake stores table rows and derives DTOs** (`fake/db.ts`), because `ownedQuantity` means
  three different things on three DTOs. A fake that stored DTOs would make all three agree, and
  teach a reader a model the app does not have.
- **Seeds and faults are state, not response stubs**: `parameters: { fake: { seed, fault } }`.
  Four seeds (`empty`/`starter`/`needsReview`/`large`), **nine** faults
  (`busy`/`syncError`/`imageFailures`/`gone`/`indexCold`/`deckMeta`/`updateAvailable`/
  `updateError`/`errorLog`); saying nothing gets `starter` with no fault. A fault is set on the
  _world_, so a story shows what the **app** does with a refusal rather than what one mocked
  call returns.
  **Re-count this list when you add one** — it said "four" for three faults' worth of drift, and
  then "eight" while `errorLog` had been in the union for a whole feature, because a prose-only
  edit routes to neither CI job and nothing goes red.
- **A world belongs to a story, not to the module** — a docs page mounts every story on it at
  once, which the canvas hides. `.storybook/fake/scope.ts` owns the four ways the global pointer
  is kept right; adding an entry point to the fake means asking which of the four covers it.
- **`useAppStore` is the one global that cannot be made per-story**, so the four story files that
  write it during render carry `docs: { story: { inline: false, height } }`. A new story file that
  writes the store needs the same parameter or its docs page shows one story's view under every
  heading.
- **A fixture more than one story file needs lives in `.storybook/fake/fixtures.ts`.** A CSF file
  cannot own one — every non-default export is indexed as a story. Not in `cards.ts`: that file is
  generated wholesale.
- **Art is synthetic by default**, with a Live toolbar switch, so a checkout with no network
  renders every story exactly as one with it. **No card image bytes are committed.**
- Note for searching: ripgrep treats `.storybook/fake/db.ts` as binary, so "no matches" there is a
  lie — Read it instead.

## Rules for stories

- **`tags: ["autodocs"]` is declared per file in the meta** — a new story file gets no docs page
  unless it says so.
- **Re-count the story totals in the same commit that adds a story**, and **count the files too,
  not just the stories.** `storybook-static/index.json` is the only place the numbers agree.
  This has rotted twice: it read 326 stories for three stories' worth of drift, and by
  2026-08-12 it named 43 story files when 44 were on disk — a whole file can go missing from the
  prose while the story total still looks plausible.
- **Every drag is held in `try { … } finally { await held.cancel(); }`, and every assertion about
  a drag's result goes through `waitFor`.** A throw mid-drag leaks pdnd's one global drag flag into
  the _next_ story, which is why one broken assertion reported two failures.
- **CSS is `.storybook/preview.css`, never `src/index.css` directly** — that file declares
  `@source "../.storybook"` itself, because `@source` resolves relative to the declaring file.
  Declaring it in `src/index.css` shipped Storybook's utilities to users.
- **`npm run build-storybook` runs in CI's `frontend` job, and it is the only gate `DesignSystem.mdx`
  has** — `tsc` reads only `.ts`/`.tsx` and ESLint ignores the file.

## Rules that bite from outside

- **`.storybook` is type-checked by its own program** (`tsc -p .storybook`, run by `npm run build`).
- **`@types/node` must never be installed.** `types: []` blocks only the _automatic_ include, not a
  transitive `/// <reference types="node" />`. Its mere presence in the tree leaks Node types into
  the **app** program, which type-checks `process.env` in webview code and retypes `setTimeout`
  from `number` to `NodeJS.Timeout`. Its absence is the only fence.
- **`src/stories.test.tsx` runs every story's `play` under Vitest**, which is what puts a story's
  own claim inside `npm run verify` — `build-storybook` compiles stories, it never plays them.
  `setProjectAnnotations` must run at module scope, before `composeStories`.
- **It `vi.mock`s two of the three aliases, and the third (`@/lib/images`) must never be mocked.**
  **The symptom is a silent 300-second hang with no output and no failing test** — if the suite
  goes quiet, this is why.
- **jsdom lays nothing out, so a virtualised list renders zero rows** without that runner's
  `offsetHeight`/`offsetWidth`/`scrollTo` stub. **Assert the content presence of a named row,
  never a count.**
- **A green Storybook proves nothing about the shipped window** — no WRY OLE drop target, no
  `mtgimg://` handler. Drag-and-drop and image loading stay the live CDP pass's to prove.
