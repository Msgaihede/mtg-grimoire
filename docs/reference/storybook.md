# Storybook

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

`npm run storybook` · `npm run build-storybook`. **387 stories across 49 story files, 48 docs
pages** — counted off `storybook-static/index.json`, which is the only place the three agree
(`Object.values(index.entries)`, grouped by `type`; the 50th `importPath` is the `.mdx`).
**Measured 2026-08-14** off a fresh `build-storybook` on the column-overflow branch **with the
borderless-stacks and deck-stats-band `main` merged in**: 435 entries, 387 `story`, 48 `docs`, 50
distinct `importPath`s.

**An earlier draft of this headline said 386 and added a paragraph explaining that it was one low,
because `cf13568`'s `PinnedSideboard` had not been counted yet and arithmetic said 387.** The
arithmetic was right this time. That is not why the number here is 387: it is 387 because the tree
was rebuilt and the index read. **Writing down a figure you have reasoned to, alongside a note
saying it is the figure you reasoned to, is still not a measurement** — and this file is four
paragraphs of branches whose arithmetic was also nearly right. Re-derive all four figures off a
fresh `build-storybook` on the merge commit you are shipping, and let the ones that did not move
say so.

The twelve over the 375 that `main` carried this morning arrived in three shapes, and the shapes
are the point. `Decks/StackView`'s `PinnedSideboard` is the twelfth, from the borderless-stacks
branch, and it went into a file that already existed. `Decks/QuickAdd`'s **six** came in a story file that did not exist before, so the
file, docs-page and `importPath` counts moved with them, as they had the last time a whole file
arrived. `Decks/Editor`'s **one** — `ReopensOnThePlan`, the deck that reopens on the tab, grouping
and sort it was left on — and the deck views' **four** — `WrappedColumns` and `SideboardRail` in
each of `StackView` and `TextView` — went into files that already existed, so they move the story
and entry totals and nothing else. **Which shape a branch is does not tell you which figures to
re-derive**: re-derive all of them, and let the ones that did not move say so.

**This headline has now conflicted on three consecutive merges of `main`, and every resolution
was a rebuild rather than an addition.** All three happened to agree with the arithmetic
afterwards. That agreement is not the reason to trust them: the paragraph below is a branch that
trusted the arithmetic and was wrong, and the one under that is two branches that were each right
about a tree nobody was shipping.

**That 375 was itself measured twice on 2026-08-14, on two trees, and meant two different
things**: 375 across **48** files on the game-changer branch (422 entries, 47 docs, 49
`importPath`s — five stories added to `CardArt`, `SearchPage` and `CardGrid`, no new file), and
375 across **49** files on the quick-add-dropdown branch before its merge (423 entries, 48 docs,
50 `importPath`s — 369 plus `QuickAdd`'s six). Equal totals, different trees, and only the *file*
count told them apart. It is the same trap the paragraph below records, one day later and one
column over.

The seventeen of `main`'s 375 over the 358 measured 2026-08-12 come from six branches that never
saw each other's stories: five are `Card/DetailPane`'s, when the printings list gained a group-by
selector (a story per mode that renders differently, plus one that drives the select) and the card
art gained a foil view; five are `Components/CardZoomIndicator`'s, **the one new story _file_ in
that set**, which is why the file and docs-page counts moved when they had held for four
measurements; one is `Search/Page`'s `Unplayable`; one is `Search/SetCombobox`'s `PickedFirst`,
pinning the picked sets to the top of the paged list; and five are the game changer's. The 358
were themselves five over `main`'s 353 — `Settings/MarketplacePanel` went from three stories to
eight when Card Kingdom and Mana Pool became selectable and a feed gained a state to draw.

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
shipping**, which is the merge commit and not either parent. That branch re-measured four times
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
**47 of the 49 are `autodocs`**, plus `.storybook/DesignSystem.mdx`: the tag is declared per
file in the meta and `CategoriesPanel`/`TheoryDiffDialog` do not carry it, so those two have
stories and no docs page. A new story file gets neither unless it says `tags: ["autodocs"]`.
(Re-derived 2026-08-14 from the built index rather than carried forward: `47 + 1 mdx = 48` docs
pages against 49 story files, and the two opting out are still the same two. **The line above it
and this parenthetical disagreed for one merge** — the headline had been updated to 47-of-49
while the arithmetic under it still read `46 + 1 mdx = 47` against 48 files, which was true one
merge earlier. A derived count went stale two terms at a time while the term that names it, 47
autodocs, stayed right, inside the very sentence that says not to carry one forward. Two branches
found it independently, which is the only reason it did not survive a third merge.)

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
  the docs page cannot leave a pulse behind in the page's own store. The other **39 docs pages
  render inline** (47 autodocs pages less the seven framed wholesale and that one framed in
  part). The arithmetic changed under this figure without moving it — it was `45 − 7` on
  2026-08-12 and `46 − 7 − 1` before the quick-add merge, which took it to the `47 − 7 − 1` it
  reads today, which is exactly the way a derived count goes stale while still looking right. The
  column-overflow merge is the opposite case: four stories into two story files that already
  existed, framing nothing, so **both** terms held and the 39 is re-derived rather than carried.
  Re-derive it from `inline: false` in source, as this was (re-checked 2026-08-14 on the merged
  tree: still the same **eight** files — `Decks/QuickAdd` was a ninth story file and framed
  nothing, which is why only the total moved then, and nothing this merge adds frames either);
  a new story file that writes the store needs the same parameter or its docs page shows one
  story's view under every heading.
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
  (**296** plays today, in a file of **299** tests — the other three are its own;
  `grep -rE "^\s+play:" src --include=*.stories.tsx | wc -l` for the first, and the file's own
  structure for the second — one `it` per play, plus the glob tripwire and the two
  mounted-together stories — both re-derived 2026-08-14 on the merge commit being shipped).
  **This pair has rotted or conflicted on every measurement it has ever had** — 264/267, then
  270/273, then 279/282 and 283/286 on two branches at once, then 291/294, and now these.

  **Two of those sides could not both be right, and neither predicted the merge.** One had
  measured 283 and accounted for it as `277 + Decks/QuickAdd`'s six; the other had measured 285
  and accounted for it as its own base plus one. Their merged tree answered **291**, which was
  neither side's figure and neither side's arithmetic — because each was counting a base the other
  had already moved. **So do not reconcile the deltas; rebuild and count.** A number here is a
  claim about a _tree_, and the only tree that matters is the merge commit you are shipping.

  **And it rots faster than the story totals above for a structural reason, not a careless one:
  no build produces it.** Every figure in the headline falls out of `storybook-static/index.json`,
  and the index knows nothing about plays — so a branch can rebuild, re-derive the story total,
  the entries, the files and the docs pages correctly off a fresh index, and leave this line
  untouched, which is exactly what the commit carrying 429/381/48/50 did while its own tree
  grepped to 290. The grep has to be run as deliberately as the build. This is what puts a story's
  own claim inside `npm run verify` — `build-storybook` compiles stories, it never plays them.
  `composeStories` **snapshots project annotations at call time**, so `setProjectAnnotations` must
  run before it, at module scope; after the scan it is a no-op and the failure is a story running
  with no decorator.
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
