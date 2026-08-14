# Storybook

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

`npm run storybook` · `npm run build-storybook`. **375 stories across 48 story files, 47 docs
pages** — counted off `storybook-static/index.json`, which is the only place the three agree
(`Object.values(index.entries)`, grouped by `type`; the 49th `importPath` is the `.mdx`).
**Measured 2026-08-14** off a fresh `build-storybook` on the game-changer branch **with the
facet-ordering `main` merged in**: 422 entries, 375 `story`, 47 `docs`, 49 distinct
`importPath`s. That branch adds **five** stories to three existing files (`CardArt` 2,
`SearchPage` 2, `CardGrid` 1) and no story *file*.

The seventeen over the 358 measured 2026-08-12 come from six branches that never saw each other's
stories: five are `Card/DetailPane`'s, when the printings list gained a group-by selector (a story
per mode that renders differently, plus one that drives the select) and the card art gained a foil
view; five are `Components/CardZoomIndicator`'s, **the one new story _file_ in the set**, which is
why the file and docs-page counts moved when they had held for four measurements; one is
`Search/Page`'s `Unplayable`; one is `Search/SetCombobox`'s `PickedFirst`, pinning the picked sets
to the top of the paged list; and five are the game changer's. The 358 were themselves five over
`main`'s 353 — `Settings/MarketplacePanel` went from three stories to eight when Card Kingdom and
Mana Pool became selectable and a feed gained a state to draw.

**On 2026-08-14 two branches wrote `416 entries, 369 story, 47 docs, 49 importPath` into this
paragraph within an hour of each other.** Both had rebuilt. Both were right about their own tree.
They were different trees — one carried the crown's stories, the other the printings rework's —
and because the *headline sentence* matched to the character, git merged that line clean and only
the paragraph under it conflicted. **A story count can be stale without being different from the
number you are merging into**, which is the one failure mode a conflict marker cannot warn you
about.

**An earlier draft of this paragraph claimed the total and the delta "do not reconcile by
arithmetic". That was wrong, and how it was wrong is the useful part.** It read 369 + 6 = 375
against a tree of 374 and called the missing one unknowable. The delta was simply miscounted: it
came from `git diff | grep '^+export const .*: Story'`, and `OwnedBadge`'s `Both` had been
**re-wrapped from one line to several**, so the same story appeared as one `+` and one `-`. Net of
removals the branch adds five, and 370 + 5 = 375 exactly. **A diff counts lines, not stories** — so
if you state a delta at all, count `+` minus `-`, and treat a figure that is off by one as a
miscount to find rather than a mystery to write up.

None of which changes the rule: **rebuild and read the index on the tree you are actually
shipping**, which is the merge commit and not either parent. This branch re-measured four times
(363 → 369 → 374 → 375) and every intermediate number was stale before CI finished.

**This line is where a derived count goes to die, three times over.** The deck-import branch's
own `CreateDeckDialog` commit counted from source without building and was one story file and
three stories short of what the index answered. Then two branches each re-measured correctly
against their own base — 346/46/45 and 344/45/44 — and **merged into a conflict where neither
was right**, because each was blind to the other's story files. The price-feed branch then
measured 349/45/44 against *its* base and merged into the same trap. A count is a measurement of
a tree, not of a branch: re-measure after every merge that touches stories, or the number is a
placeholder wearing a figure's clothes.
**Re-count them in the same commit that adds a story.** This line read 326 for three stories'
worth of drift and then took three more without noticing, because a prose-only edit routes to
neither CI job — the same rot that left the fault list below saying four. **It had rotted
again by 2026-08-12**: it read 43 story files when 44 were on disk, and the motion branch that
found it added _no_ story file, so the drift predates that branch entirely. Count the files
too, not just the stories — `Object.values(index.entries)` groups by `type`, and a whole file
can go missing from the prose while the story total still looks plausible.
**46 of the 48 are `autodocs`**, plus `.storybook/DesignSystem.mdx`: the tag is declared per
file in the meta and `CategoriesPanel`/`TheoryDiffDialog` do not carry it, so those two have
stories and no docs page. A new story file gets neither unless it says `tags: ["autodocs"]`.
(Re-derived 2026-08-14 from the built index rather than carried forward: `46 + 1 mdx = 47` docs
pages against 48 story files, and the two opting out are still the same two.)

- **What it is for: a design workbench, a living catalogue, and an a11y surface** — build a
  component against every state at once, find the one that already exists before writing a
  second, and let `@storybook/addon-a11y` check contrast and names per story. **Not visual
  regression, deliberately**: no screenshots are stored, so nothing here can fail because a
  font rendered a pixel differently on a different machine.
- **`.storybook/main.ts` aliases three specifiers** — `@tauri-apps/api/core`,
  `@tauri-apps/api/event` and `@/lib/images` — to `.storybook/fake/`. **The fake sits _under_
  `src/lib/ipc.ts`, not in place of it**, and that is the point: `ipc.ts` is a hand-written
  mirror of the Rust structs and is exactly the thing that can drift from them, so a fake
  beneath it means every story exercises the mirror too. Aliasing `ipc.ts` itself would story
  the components against a second, agreeing copy of a contract nobody had checked.
- **The fake stores table rows and derives DTOs** (`fake/db.ts`), because **`ownedQuantity`
  means three different things on three DTOs**: every copy of one printing and finish-blind on
  `CardSummary`; the copies filling one wish and finish-**aware** on `WishRow`; a deck's
  **allocation** on `DeckCard`. A fake that stored DTOs would make all three agree, and teach
  a reader a model the app does not have.
- **Seeds and faults are state, not response stubs**: `parameters: { fake: { seed, fault } }`,
  seeds `empty`/`starter`/`needsReview`/`large`, **ten** faults — `busy`/`syncError`/
  `imageFailures`/`gone`/`indexCold`/`deckMeta`/`updateAvailable`/`updateError`/`errorLog`/
  `feedFetchError`. Saying nothing gets `starter` with no
  fault. A fault is set on the world, so a story about `BUSY` shows what the _app_ does with a
  refusal rather than what one mocked call returns. **`indexCold` is the one that is not a
  failure at all**: it is the search index mid-build, which `facet_cards` answers `ready: false`
  with every map **empty** rather than zeroed, and the filter row leaves every control live on
  it. The fake has no warm-up of its own, so it is the only way a story can stand there.
  Counting the list is worth doing when one is added: this line said _four_ for three faults'
  worth of drift, because a prose-only edit routes to neither CI job and nothing goes red.
  **`deckMeta` is the one that refuses
  _reads_** — the six a deck screen makes _beside_ the deck (`deck_category_list`,
  `deck_tag_list`, `deck_tag_suggestions`, `deck_folder_list`, `deck_audit_list`,
  `deck_theory_diff`), each in its own Rust sentence, and deliberately not `deck_get`/
  `deck_list`: a screen that could not read the deck would not be showing a panel about it.
  **`feedFetchError` is the network at the far end of a price feed**, added 2026-08-12 with
  Card Kingdom and Mana Pool: `marketplace_feed_refresh` refuses and — the whole point — the
  rows already in `marketplace_prices` **stay**, because a failed fetch leaves the previous
  prices in place and writes the reason to `error_log`. It is the only way a story can stand in
  the state that has prices _and_ a failure, which is the one the panel's wording is hardest to
  get right in. The backend refuses a feed that parses to zero rows for the same reason, so an
  error page cannot wipe a working table.
- **A world belongs to a story, not to the module — because a docs page mounts every story on
  it at once.** The canvas hides this (Storybook unmounts one story before mounting the next),
  so a fake built on module globals looks right and answers all ten stories of a docs page as
  whichever one installed itself last. The global stays — `src/lib/ipc.ts` imports `invoke` as
  a bare function and no React context travels down an import — but it is a **pointer** at a
  world now, and `.storybook/fake/scope.ts` owns the four ways it is kept right: a per-world
  `QueryClient` binding every `queryFn`/`mutationFn`, an `<Activate>` sibling rendered
  **before** the story so its effect lands first (React fires effects in fiber-completion
  order), `invoke` re-pointing on the way out so an awaited continuation stays put, and one
  `setTimeout` patch for `useSync`'s poll chain. Adding an entry point to the fake means asking
  which of the four covers it. `src/stories.test.tsx` mounts two seeds **simultaneously** and
  is the test that fails if any of this regresses; `.storybook/fake/world.test.ts` covers the
  three unit-testable layers, each proven by breaking it.
- **`useAppStore` is the one global that cannot be made per-story from `.storybook/`** —
  zustand's `create` does not expose its initializer, and the actions close over that one
  store's `set`. So the four story files that write it during render (`AppShell`,
  `CardDetailPane`, `SearchPage`, `CollectionPage`) carry
  `docs: { story: { inline: false, height } }`, which gives each of their docs stories its own
  **frame** and with it its own module graph. `DeckSettingsDialog`, `CreateDeckDialog` and
  `import/ImportDeckDialog` carry the same parameter for an unrelated reason — their scrim is
  `fixed inset-0`, so inline it would cover the docs page rather than its own block. **A third
  kind arrived 2026-08-14 with the zoom work**: `CardZoomIndicator` sets the parameter on **one
  story** rather than in its meta, because only that story writes `cardZoom` and the four beside
  it take their figure as an argument — so what the frame buys there is that pressing Zoom in on
  the docs page cannot leave a pulse behind in the page's own store. The other **38 docs pages
  render inline** (46 autodocs pages less the seven framed wholesale and that one framed in
  part). The arithmetic changed under this figure without moving it — it was `45 − 7` on
  2026-08-12 and is `46 − 7 − 1` now, which is exactly the way a derived count goes stale while
  still looking right. Re-derive it from `inline: false` in source, as this was (re-checked
  2026-08-14 on the merged tree: still the same eight files); a new story file that writes the
  store needs the same parameter or its docs page shows one story's view under every heading.
- **`images.ts` is handed the installed world's corpus** (`installWorld` → `installCorpus`),
  because the `large` seed mints ~5,200 synthetic printings that a module-load snapshot of
  `CARDS` cannot see — they all drew the "Unknown card" placeholder, which is the affordance
  for _no such printing_. Lookup is the union of the live worlds' cards over `CARDS`.
- **A fixture more than one story file needs lives in `.storybook/fake/fixtures.ts`.** A CSF
  file cannot own one — every non-default export is indexed as a story — but a non-CSF module
  can, and `printing()` had been written out eleven times before it had a home. Not in
  `cards.ts`: that file is generated wholesale and says so.
- **Art is synthetic by default, with a Live toolbar switch.** Synthetic so a checkout with no
  network renders every story exactly as one with it, and so `build-storybook` produces a
  static site that draws card art without touching Scryfall. **No card image bytes are
  committed.**
- **`.storybook` is type-checked by its own program** — `tsc -p .storybook`, run by
  `npm run build` — so the fake is checked against `ipc.ts` by `verify` like the app is. And
  **`@types/node` must never be installed**: `types: []` blocks only the _automatic_ include,
  not a transitive `/// <reference types="node" />`, and `vitest` and `vite` each carry one. Its
  mere presence in the tree leaks Node types into the **app** program, which type-checks
  `process.env` in webview code and retypes `setTimeout` from `number` to `NodeJS.Timeout`.
  Its absence is the only fence; `.storybook/node-url.d.ts` shims the one function `main.ts`
  needs.
- **`src/stories.test.tsx` runs every story's `play` under Vitest** through `composeStories`
  (**270** plays today, in a file of **273** tests — the other three are its own;
`grep -rE "^\s+play:" src --include=*.stories.tsx | wc -l` for the first, and the runner's own
summary for the second, both measured 2026-08-14). **Both figures had rotted before this
re-count** — they read 264/267 against a tree already answering 269/272, which is six plays'
worth of drift added by branches that did not re-measure, and is the same prose-only rot the
story totals above have taken three times. Only one of the six is this branch's
(`Search/Page`'s `Unplayable`). This is what puts a story's own claim inside `npm run verify` —
  `build-storybook` compiles stories, it never plays them. `composeStories` **snapshots project
  annotations at call time**, so `setProjectAnnotations` must run before it, at module scope;
  after the scan it is a no-op and the failure is a story running with no decorator.
- It `vi.mock`s two of the three aliases, and **the third (`@/lib/images`) must never be
  mocked.** `vi.mock` matches the _resolved id_, so it resolves to the same `src/lib/images.ts`
  that the fake's own `export *` resolves to, and the factory imports the module it stands in
  for. **The symptom is a silent 300-second hang with no output and no failing test** — if the
  suite goes quiet, this is why.
- **jsdom lays nothing out, so a virtualised list renders zero rows** without the
  `offsetHeight`/`offsetWidth`/`scrollTo` stub in that runner. It lives there and not in a
  `play` because `play` also runs in the Storybook browser, where those are native prototype
  accessors a `defineProperty` cannot undo. Its viewport is a number and not this app's window:
  **assert the content presence of a named row, never a count.**
- **Every drag in a story is held in `try { … } finally { await held.cancel(); }`, and every
  assertion about a drag's result goes through `waitFor`.** pdnd schedules its drop-target
  change on a rAF and React's commit is a second hop, so one frame is not enough; and a throw
  mid-drag leaks pdnd's one global drag flag into the _next_ story, which is why one broken
  assertion reported two failures. Measured on `AppShell.stories.tsx`: **5 of 10 runs red
  before, 12 of 12 green after.**
- **Storybook CSS is `.storybook/preview.css`, never `src/index.css` directly.** That file
  imports the app entry and declares `@source "../.storybook"` itself, because `@source`
  resolves relative to the declaring file. Declaring it in `src/index.css` shipped Storybook's
  utilities to users: measured, `dist/assets/index-*.css` 119,935 → **119,126** bytes, 11 rules
  dropped and 0 added. Stories cannot be fenced off the same way and should not be — a
  `.stories.tsx` is under `src/`, which `@source "../src"` must scan.
- **`npm run build-storybook` runs in CI's `frontend` job**, and it is the **only** gate the
  `.mdx` page has. Stories are `.tsx` under `src/`, so `tsc` and ESLint already see them;
  `DesignSystem.mdx` is seen by neither — `tsc` reads only `.ts`/`.tsx` however the `include`
  glob is written, and `eslint` answers "File ignored because no matching configuration was
  supplied" (both measured 2026-08-10). Before this step the page could break and nothing would
  say so. It earns itself on more than MDX: a **CSS comment cannot hold a glob containing a
  star-slash** — that closes the comment — and `storybook build` is what caught exactly that in
  `preview.css` while this task was being written. `frontend` feeds `ci-ok`, the one protected
  check, which is why the step lives there rather than in a job of its own.
- **A green Storybook proves nothing about the shipped window.** It runs in a normal browser:
  no WRY OLE drop target, no `mtgimg://` protocol handler. **Drag-and-drop and image loading
  remain the live CDP pass's to prove** — see [live-ui-verification.md](live-ui-verification.md), and note that the same is true
  of the story runner, whose drags are synthetic events in jsdom.
