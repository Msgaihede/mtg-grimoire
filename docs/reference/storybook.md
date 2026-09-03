# Storybook

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

`npm run storybook` · `npm run build-storybook`.

**This page deliberately carries no story, story-file or docs-page totals.** It used to, and
the figure conflicted on five consecutive merges of `main` — a count is a fact about a *tree*,
so every open branch has a different one and none of them is the one being shipped. The
archaeology that grew up around defending it was longer than the rules it sat above.

If you need the numbers, measure them and do not write them down here:

```powershell
npm run build-storybook
# then, over storybook-static/index.json:
#   Object.values(index.entries) grouped by `type`  -> story / docs counts
#   distinct `importPath`         -> story files (+1 for DesignSystem.mdx)
```

The one portable lesson, which is the only reason any of this is still on the page: **rebuild
and read the index on the merge commit you are shipping.** Never add one branch's delta to
another's total — that has been wrong here more than once, and no side of a merge has ever
predicted the merge.

**`autodocs` is declared per file in the meta**, and
`CategoriesDialog`/`LabelsDialog`/`TheoryDiffDialog` do not carry it, so those three have stories
and no docs page. It read `CategoriesPanel`/`TheoryDiffDialog` until 2026-08-14: that panel is
two files now, and neither half declares it any more than the whole did. The other surfaces of
that change went the other way — `DeckDialog`, the shell `CategoriesDialog` and `LabelsDialog` are
drawn in (`TheoryDiffDialog` is not: it still carries its own chrome), and `DeckHistoryDialog`,
which was `AuditDrawer`, both carry it. A new story file gets neither unless
it says `tags: ["autodocs"]`.

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
  `CardSummary`; the copies filling one wish and finish-**aware** on `WishRow`; and on `DeckCard`
  the copies **in that deck's own group**, oracle-grained (a claim from the allocator until schema
  v25 deleted it). A fake that stored DTOs would make all three agree, and teach a reader a model
  the app does not have.
- **Seeds and faults are state, not response stubs**: `parameters: { fake: { seed, fault } }`,
  seeds `empty`/`starter`/`needsReview`/`large`, **eighteen** faults — `busy`/`syncing`/
  `syncError`/`imageFailures`/`gone`/`indexCold`/`deckMeta`/`updateAvailable`/`updateError`/
  `errorLog`/`feedFetchError`/`oracleTagsMissing`/`oracleTagsFetchError`/`artTagsMissing`/
  `artTagsFetchError`/`imageUrisMissing`/
  `exportWriteError`/`mirrorRootUnwritable`. (Re-counted 2026-08-20: this line said _twelve_ while `imageUrisMissing`
  and `exportWriteError` had both been in the union for a feature each, which is the third time
  this number has rotted; the art taxonomy's pair took it to seventeen the same day, and the
  plain-text mirror's unwritable root to eighteen on 2026-08-25.) Saying
  nothing gets `starter` with no
  fault. A fault is set on the world, so a story about `BUSY` shows what the _app_ does with a
  refusal rather than what one mocked call returns. **`indexCold` is one of the four that are not
  a failure at all** (`oracleTagsMissing`, `artTagsMissing` and `imageUrisMissing` are the
  others — this said "two" while the last of those had been in the union for a feature, the same
  rot the count above has): it is the search index mid-build, which `facet_cards` answers `ready: false`
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
  `deck_label_list`, `deck_label_all`, `deck_folder_list`, `deck_audit_list`,
  `deck_theory_diff`), each in its own Rust sentence, and deliberately not `deck_get`/
  `deck_list`: a screen that could not read the deck would not be showing a panel about it.
  **`feedFetchError` is the network at the far end of a price feed**, added 2026-08-12 with
  Card Kingdom and Mana Pool: `marketplace_feed_refresh` refuses and — the whole point — the
  rows already in `marketplace_prices` **stay**, because a failed fetch leaves the previous
  prices in place and writes the reason to `error_log`. It is the only way a story can stand in
  the state that has prices _and_ a failure, which is the one the panel's wording is hardest to
  get right in. The backend refuses a feed that parses to zero rows for the same reason, so an
  error page cannot wipe a working table.
  **`mirrorRootUnwritable` is the only fault that is both a row change and a handler branch**,
  added 2026-08-25 with the plain-text mirror. A root that has gone — a stick unplugged, a sync
  folder uninstalled, a permission revoked — is a pass that has **already** failed, so
  `installWorld` records it on the world (`mirrorFailedPass`) and the Backup panel draws the
  sentence with nothing having been pressed; and `mirror_rebuild` still refuses, because a
  button that cleared the error by succeeding into a folder that is not there would be showing a
  state the app cannot be in. Nothing else about the world changes, which is the fault's whole
  point: no database write ever waits on a mirror write, so the story still edits decks and
  still shows every number it showed before. What is lost is a folder of text files.
  **`artTagsMissing` and `artTagsFetchError` are the Oracle pair below, one dataset over**, and
  they are two more faults rather than a reuse of those two because the taxonomies are two files
  on two schedules: either can be absent, or failing, while the other is fine, and the Tags page
  has to be able to stand in all four of those worlds. `artTagsMissing` empties `art_tags`, its
  parents, its closure and its watermark together — one ingest writes all four, and a watermark
  with no taxonomy behind it is the state the backend goes out of its way never to leave.
  `art_tags_status` resolves with every field `null`, `tag_search` answers nothing for `art`
  while still answering for `oracle`, and a card wall filtered by an art tag comes back empty
  rather than refusing.
  **The pair before them arrived with the Oracle tags**, and they are the other pair that is not
  one thing. **`oracleTagsMissing` is the second fault that is no failure at all**: the taxonomy has
  never been ingested, which is every install's first launch and the permanent state of one that
  cannot reach Scryfall Tagger. `oracle_tags_status` **resolves** — every field `null`,
  `stale: true` — and both tag reads answer an empty slug list for every id, so `autoCategoryFor`
  files by type line. It is applied by emptying the *rows* in `installWorld` (the `errorLog`
  fault's shape, inverted) rather than by branching in the handlers, which is what lets a story
  press Refresh in that state and watch the piles regroup.
  **`syncing` arrived last, with the Settings page's four clears**, and it is the narrowest fault
  here: it reaches `cache_clear` and nothing else. That command sweeps `data/images/` and
  `data/tmp/`, and the second of those is where the corpus download puts 77 MB that the ingest
  reads back — so the crate refuses the whole command rather than skipping one directory, and
  refuses it *before* the write connection is asked for, which is why a mid-sync story cannot be
  told with `busy`. The three destructive clears beside it are unaffected by it, deliberately.
  **`oracleTagsFetchError`** is
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
- **`starter` seeds the _art_ taxonomy beside it, and it is keyed on the illustration** —
  **eleven tagged printings over thirteen tags and four roots** (`creature`, `plant`,
  `landscape`, `lightning`). The key is the whole difference from the paragraph above: an art tag
  is a fact about a *picture*, so `lightning` is on the `lea` Lightning Bolt alone and the other
  three printings of that card carry nothing, where the oracle tag `burn` reaches all four.
  Ancestral Recall is the mirror case and is deliberately left untagged — `lea` and `2ed` share
  one illustration, so `db.test.ts` proves that join against a store built for it rather than by
  inventing a motif for a picture nobody has looked at. **Every tag in the fixture is true of the
  picture it is on**, which is why there is no `dog` and no `hound`: nobody in these 43
  illustrations is a dog, and the `dog`/`hound`/`bulldog` branch lives in the crate's own fixture
  in `tags/query.rs`. What the seed carries instead is the shape every story needs — `animal`
  with no direct taggings of its own (reached only through `cat` and `monkey`, the same shape as
  the real `removal`, which has zero of its own and answers 6 686 cards), `forest` under **two**
  parents (43 % of real art tags have more than one), one `weak` tagging so the weight floor
  visibly changes a wall, and Island `lea` tagged twice at two weights so the closure's fold to
  the *strongest* has something to fold. `muted_tags` is never seeded: it is a user table, so a
  muted tag in a story is a press that story made.
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
  **frame** and with it its own module graph. `DeckDialog`, `DeckSettingsDialog`,
  `CreateDeckDialog` and `import/ImportDialog` — **four** files — carry the same parameter for
  an unrelated reason: their scrim is `fixed inset-0`, so inline it would cover the docs page
  rather than its own block. **A third kind arrived 2026-08-14 with the zoom work**:
  `CardZoomIndicator` sets the parameter on **one story** rather than in its meta, because that
  story is the only one on its page that writes the store — every other story there takes its
  figure as an argument, so there is no second view for a write to overwrite — and what the frame
  buys is that pressing Zoom in on the docs page cannot leave a pulse behind in the page's own
  store. That sentence deliberately carries **no count of the stories beside it**: the file gained
  one on the per-section-zoom branch, and a number there would need re-counting every time it
  gains another.
  **Nine story files carry `inline: false`** — re-counted in source 2026-08-14 on the
  per-section-zoom branch, sweeping `inline: false` under `src/**/*.stories.tsx`: **eight** frame
  wholesale in a meta, four of them because they write `useAppStore` during render (`AppShell`,
  `CardDetailPane`, `CollectionPage`, `SearchPage`) and four because of the scrim (`DeckDialog`,
  `DeckSettingsDialog`, `CreateDeckDialog`, `import/ImportDialog`), and `CardZoomIndicator`
  frames a single story. **`DeckDialog` was missing from this list** and is the correction that
  found the rot below: the shell arrived with the deck-dialog work, framed from the day it landed,
  and no prose-only edit routes to a CI job that would have said so.
  **The count of docs pages rendering inline used to be written here and has been deleted.** It
  read "39 render inline — `47 − 7 − 1`", and by the time anybody re-derived it **both** terms had
  moved: the framed side is eight rather than seven, and the minuend is a fact about whichever tree
  you are standing in. It had already survived two rewrites of its own arithmetic (`45 − 7`,
  `46 − 7 − 1`, `47 − 7 − 1`) with the answer never once moving, which is exactly how a derived
  count goes stale while still looking right — **every term moved and the figure did not**. It goes
  the way the story and plays totals went on 2026-08-14, for the reason the root `CLAUDE.md` gives:
  **a count is a fact about a tree, and every open branch has a different one.** What is worth
  writing down is the list above, which a grep settles in a second, and the rule it exists for.
  A new story file that writes the store needs the same parameter or its docs
  page shows one story's view under every heading.
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
- **`src/stories.test.tsx` runs every story's `play` under Vitest** through `composeStories`,
  which is what puts a story's own claim inside `npm run verify` — `build-storybook` compiles
  stories, it never plays them. `composeStories` **snapshots project annotations at call time**,
  so `setProjectAnnotations` must run before it, at module scope; after the scan it is a no-op
  and the failure is a story running with no decorator.

  **No count of plays is recorded here either, and this one rotted for a structural reason**:
  every figure a build produces falls out of `storybook-static/index.json`, and *the index knows
  nothing about plays*. So a branch could rebuild, re-derive every story figure correctly off a
  fresh index, and leave a hand-grepped plays total untouched — which happened. If you want the
  number, `grep -rE "^\s+play:" src --include=*.stories.tsx | wc -l`, or read the runner's own
  summary from `vitest run src/stories.test.tsx`.
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
