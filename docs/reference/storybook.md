# Storybook

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

`npm run storybook` · `npm run build-storybook`. **385 stories across 49 story files, 48 docs
pages** — counted off `storybook-static/index.json`, which is the only place the three agree
(`Object.values(index.entries)`, grouped by `type`; the last `importPath` is the `.mdx`).
**Measured 2026-08-14** off a fresh `build-storybook` on the merge of the X-mana-category branch
and `origin/main`: **433 entries, 385 `story`, 48 `docs`, 50 distinct `importPath`s.**
**Re-measured on the oracle-tags merge the same day and unchanged in every term** — that branch
added `play` functions to stories that already existed and no story of its own, so it moved the
plays figure below and none of these. Worth one line because it is the *true negative* the rule
above is missing: "I touched stories, so the totals moved" is wrong exactly as often as its
opposite, and only a rebuild tells you which you are looking at.

**This figure was measured twice in one hour and moved between them**, which is the strongest
form of the lesson below: the first build of the merged tree answered **384** (432 entries), and
a further `main` — PR #46's stack-border work, adding stories to a file that already existed —
took it to 385 without moving the file or docs-page counts. A branch that sits open while `main`
advances does not have a story total; it has one *per merge*.

**Both sides of this merge measured honestly, and neither figure survived it — the third time
running.** On 2026-08-14 the X-mana-category branch built **383** stories across 49 files with the
then-`main` merged in (431 entries, 383 `story`, 48 `docs`, 50 distinct `importPath`s), and the
per-deck-view-memory branch built **382** across 49 files against that same base (430 entries, 382
`story`, 48 `docs`, 50 `importPath`s). Each was right about its own tree; the tree that ships is
the merge of the two and is neither. **The two resolutions before this one were each a rebuild
rather than an addition**, and both happened to agree with the arithmetic afterwards — which is
not the reason to trust it. Further down this page a branch trusted the arithmetic and was wrong
(`369 + 6 = 375` against a tree of 374), and below that two branches wrote the same
`416 entries, 369 story` into the same paragraph within an hour, each right about a tree nobody
was shipping.

Each side's delta is kept because it says where the stories came from, and neither is a licence to
add. **381** was the quick-add `main` both branches started from. The two over it on the
X-mana-category side are `Decks/DeckStats`' `ManaCurveWithX` and `ManaCurveSplitX`, the pair the X
mana category is measured over: one deck drawn twice with nothing between them but the toggle.
**No story file and no docs page moved with them** — they take that file from seven stories to
nine and it already had a docs page, which is why 49 and 48 were the quick-add branch's own
numbers unchanged. The other three story files that branch touched changed stories they already
had (`Components/FilterChips`' mana-value pair gained the X chip, `Decks/DeckEditor`'s
`GroupAndSort` gained the `Split X` control, `Search/Page`'s `Empty` gained a paragraph), and a
rewritten story is invisible to every count on this line. The one over 381 on the
per-deck-view-memory side is `Decks/Editor`'s `ReopensOnThePlan` — the deck that reopens on the
tab, grouping and sort it was left on — which adds no file either. The X branch alone, before it
took `main` in, was **372**.

The six that took `main` from 375 to 381 are all `Decks/QuickAdd`'s, a story file that did not
exist before — so the file and the docs-page counts moved with them, as they did the last time a
whole file arrived.

**That 375 was itself measured twice on 2026-08-14, on two trees, and meant two different
things**: 375 across **48** files on the game-changer branch (422 entries, 47 docs, 49
`importPath`s — five stories added to `CardArt`, `SearchPage` and `CardGrid`, no new file), and
375 across **49** files on this one before the merge (423 entries, 48 docs, 50 `importPath`s —
369 plus this file's six). Equal totals, different trees, and only the *file* count told them
apart. It is the same trap the paragraph below records, one day later and one column over.

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
shipping**, which is the merge commit and not either parent. This branch re-measured four times
(363 → 369 → 374 → 375) and every intermediate number was stale before CI finished.

**The oracle-tags branch is the counterexample that makes the rule readable: it moved the plays
count and moved none of these.** It added five `play` functions to stories that already existed,
and no story and no story file of its own — so the headline above survived its merge unchanged
while the plays figure below did not. Measured on both sides to know that rather than infer it,
which is the whole point: the two numbers are not derivable from one another, and a branch that
reasons "I touched stories, so the totals moved" is as wrong as one that reasons the opposite.

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
**47 of the 49 are `autodocs`**, plus `.storybook/DesignSystem.mdx`: the tag is
declared per file in the meta and `CategoriesPanel`/`TheoryDiffDialog` do not carry it, so those
two have stories and no docs page. A new story file gets neither unless it says
`tags: ["autodocs"]`.
(Re-derived on the merged tree 2026-08-14, from source and from the built index rather than from
either side of the merge: **47 autodocs + 1 `.mdx` = 48 docs pages**, against 49 story files, and
the two opting out are still `CategoriesPanel` and `TheoryDiffDialog` — checked by grepping the
tag, not by subtracting. **The line above it and this parenthetical disagreed for one merge** —
the headline had been updated to 47-of-49 while the arithmetic under it still read 46-of-48,
which is a derived count going stale inside the very sentence that says not to carry one
forward.)

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
  seeds `empty`/`starter`/`needsReview`/`large`, **twelve** faults — `busy`/`syncError`/
  `imageFailures`/`gone`/`indexCold`/`deckMeta`/`updateAvailable`/`updateError`/`errorLog`/
  `feedFetchError`/`oracleTagsMissing`/`oracleTagsFetchError`. Saying nothing gets `starter` with no
  fault. A fault is set on the world, so a story about `BUSY` shows what the _app_ does with a
  refusal rather than what one mocked call returns. **`indexCold` is one of the two that are not
  a failure at all**: it is the search index mid-build, which `facet_cards` answers `ready: false`
  with every map **empty** rather than zeroed, and the filter row leaves every control live on
  it. The fake has no warm-up of its own, so it is the only way a story can stand there.
  **One field of that response is not a map and has no empty to send**: `manaX` — the mana row's
  X chip — is a count, so the cold handler answers `0`, which is character for character what a
  warm response sends for "no X cards in this search". `ready: false` is the whole of what tells
  those two apart, so this fault is the only place a story can prove the X chip stays live rather
  than merely showing a row with no counts on it. A scalar added to `FacetResponse` later needs
  the same line here and the same reasoning; see
  [search-faceting.md](search-faceting.md).
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
  **The last two arrived with the Oracle tags**, and they are the other pair that is not one
  thing. **`oracleTagsMissing` is the second fault that is no failure at all**: the taxonomy has
  never been ingested, which is every install's first launch and the permanent state of one that
  cannot reach Scryfall Tagger. `oracle_tags_status` **resolves** — every field `null`,
  `stale: true` — and both tag reads answer an empty slug list for every id, so `autoCategoryFor`
  files by type line. It is applied by emptying the *rows* in `installWorld` (the `errorLog`
  fault's shape, inverted) rather than by branching in the handlers, which is what lets a story
  press Refresh in that state and watch the piles regroup. **`oracleTagsFetchError`** is
  `feedFetchError` one dataset over: `oracle_tags_refresh` refuses, the taxonomy already ingested
  **stays**, and the reason goes to `error_log` — a refusal a story has to be able to show
  without the screen behind it changing at all, because nothing about categorising a card may
  fail a deck add.
- **`starter` seeds the taxonomy as well as both price feeds** — **32 oracle cards, covering 38
  of the 43 printings**, closed over their ancestors exactly as `oracle_tag_cards` stores them,
  so a deck story shows real piles rather than everything falling back to card type. Both counts
  are measured by `db.test.ts` rather than asserted here, because every count on this page has
  drifted at least once. Five printings are deliberately left untagged (both basic lands, Delver
  of Secrets, Tarmogoyf, Little Girl) so a `starter` deck holds cards on both sides of the
  fallback at once; `empty` and `large` go without a taxonomy entirely, `large` for the reason it
  goes without price feeds. The one anchor slug the corpus cannot reach is `sacrifice-outlet`:
  no card in these 43 printings is one, and tagging one that is not would be worse than the hole.
  Both reads answer **one entry per requested id, in request order, deduped, `slugs: []` for
  anything unknown** — a fake that answered only the matches, or that reordered, would look fine
  in Storybook and break every caller that matches by id.
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
  render inline** — `47 − 7 − 1`, the 47 autodocs pages the merged tree's index counted less the
  seven framed wholesale and the one framed in part.
  **The framed side of that subtraction is settled and
  is not a build number**: re-checked in source on the merged tree 2026-08-14 (`inline: false`
  under `src/**/*.stories.tsx`), still the same **eight** files — seven framing in a meta
  (`AppShell`, `CardDetailPane`, `CollectionPage`, `SearchPage`, `CreateDeckDialog`,
  `DeckSettingsDialog`, `import/ImportDeckDialog`) and `CardZoomIndicator` framing one story.
  Every story file that arrived across the 2026-08-14 merges frames nothing, so only the minuend
  moves. **The arithmetic has changed under this figure without moving it, twice** — `45 − 7` on
  2026-08-12, `46 − 7 − 1` before the 2026-08-14 merges, `47 − 7 − 1` after the first of them —
  which is exactly the way a derived count goes stale while still looking right: **every term
  moved and the figure did not**. Re-derive it, never carry it. A new story file that writes the
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
  (**294 plays, in a file of 297 tests** — the other three are its own; measured 2026-08-14 on the
  merge commit, `grep -rE "^\s+play:" src --include=*.stories.tsx | wc -l` for the first and **the
  runner's own summary** for the second, from an actual `vitest run src/stories.test.tsx`. The
  `plays + 3` relation has now held on every measurement it has ever had, and the second number is
  still measured rather than derived — a relation that has always held is exactly the one nobody
  checks the day it stops).
  This is what puts a story's own claim inside `npm run verify` — `build-storybook` compiles
  stories, it never plays them. `composeStories` **snapshots project annotations at call time**,
  so `setProjectAnnotations` must run before it, at module scope; after the scan it is a no-op and
  the failure is a story running with no decorator.

  **That pair has rotted or conflicted on every measurement it has ever had** — 264/267, then
  270/273, then 279/282 and 283/286 on two branches at once, then 291/294 on one side of the
  2026-08-14 merges and 292 plays on the other, **293/296** on the merge of those two and
  **294/297** one `main` later the same hour. The
  shape never changes: 264/267 was written
  against a tree already answering 269/272, and 270/273 against one already answering 278, and
  twice the branch that found the drift had contributed almost none of it — prose-only rot rather
  than anyone's carelessness.

  **And no side of a merge has ever predicted the merge.** On 2026-08-14 one branch measured 283
  plays and accounted for them as `277 + Decks/QuickAdd`'s six, another measured 285 and accounted
  for them as its own base plus one, and their merge answered **291** — neither figure and neither
  arithmetic, because each was counting a base the other had already moved. The X-mana-category
  branch then measured **280** at `09ea7db` and its own merge with `main` answered **292**, more
  than either side plus the other's visible delta. Nobody can check that after the fact. **So do
  not reconcile the deltas; rebuild and count.** A number here is a claim about a *tree*, and the
  only tree that matters is the merge commit you are shipping.
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
