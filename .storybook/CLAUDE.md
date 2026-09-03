# .storybook — the workbench and its fake

`npm run storybook` · `npm run build-storybook`. Full detail, every count and the reasoning
behind each rule: [docs/reference/storybook.md](../docs/reference/storybook.md).

**What it is for: a design workbench, a living catalogue, and an a11y surface** — build a
component against every state at once, find the one that already exists before writing a second,
and let `@storybook/addon-a11y` check contrast and names per story. **Not visual regression,
deliberately**: no screenshots are stored.

## Rules for the fake

- **`main.ts` aliases four specifiers** — `@tauri-apps/api/core`, `@tauri-apps/api/event`,
  `@tauri-apps/api/window` and `@/lib/images` — to `.storybook/fake/`. **The fake sits _under_
  `src/lib/ipc.ts`, not in place of it**, and that is the point: `ipc.ts` is a hand-written mirror
  of the Rust structs and is exactly the thing that can drift, so a fake beneath it means every
  story exercises the mirror too. Aliasing `ipc.ts` itself would story the components against a
  second, agreeing copy of a contract nobody had checked. **`src/lib/window.ts` is the second
  module that boundary sits under** (added 2026-08-20): it mirrors four Tauri window methods and
  the four ACL permissions in `capabilities/default.json`, and a fake replacing *it* would prove
  nothing about the one file that can drift from that capability.
- **The window fake keeps module state where the other three keep per-world state**, and that is
  the honest model rather than an oversight: a story's *backend* is its own, and two docs-page
  stories may hold different databases — but there is one window, on the desk and here. What it
  costs is exactly what `scope.ts` exists to prevent, so `installWorld` calls `resetWindow()`
  beside the store reset. A story that maximized the window must not leave the next one maximized.
- **The fake stores table rows and derives DTOs** (`fake/db.ts`), because `ownedQuantity` means
  three different things on three DTOs. A fake that stored DTOs would make all three agree, and
  teach a reader a model the app does not have.
- **Seeds and faults are state, not response stubs**: `parameters: { fake: { seed, fault } }`.
  **Seven** seeds
  (`empty`/`starter`/`needsReview`/`large`/`bracketMismatch`/`combosMissing`/`paired`),
  **twenty-four** faults
  (`busy`/`syncing`/`syncError`/`imageFailures`/`gone`/`indexCold`/`deckMeta`/`updateAvailable`/
  `updateError`/`errorLog`/`feedFetchError`/`oracleTagsMissing`/`oracleTagsFetchError`/
  `artTagsMissing`/`artTagsFetchError`/`imageUrisMissing`/`exportWriteError`/
  `mirrorRootUnwritable`/`combosFetchError`/`pairingReadError`/`patreonDeclined`/
  `patreonLapsed`/`patreonGroupEntitled`/`wishGone`); saying
  nothing gets `starter` with no fault. A
  fault is set on the _world_, so a story shows what the **app** does with a refusal rather than
  what one mocked call returns. **`syncing` is `busy`'s neighbour and reaches exactly one
  command**: `cache_clear` refuses outright while a card update is in flight, because
  `data/tmp/` is where the corpus download puts 77 MB the ingest then reads back — and it is
  checked *before* the write connection is asked for, which is why it is not `busy`.
  **Seven of the twenty-four are not failures at all** — `indexCold` is
  the search index mid-build; `oracleTagsMissing` is the Oracle tag taxonomy having never
  been ingested, which is every install's first launch and the state the type-line fallback
  exists for; `artTagsMissing` is the same thing one dataset over, where the honest floor is a
  Tags page that says it has nothing yet; and `imageUrisMissing` is a corpus whose
  `cards.image_uris` is NULL throughout, so
  `card_image_uri` answers `null` for every printing and "Copy card image" copies nothing.
  **`patreonDeclined`, `patreonLapsed` and `patreonGroupEntitled` are the other three, and they
  are the three supporter states no press can reach.** Connecting *is* reachable — paste a claim
  code, press Connect — so there is neither fault nor seed for it; what a reader can never
  produce from this window is Patreon declining their card (§7.2's grace window, where sync keeps
  working), their pledge ending, or **another device's membership covering this one**, which is
  decided at the far end of `/token`'s group door. **`patreonGroupEntitled` is a good state
  rather than a bad one** — the second device in a group whose first device connected, holding no
  refresh secret at all and supporting anyway. It differs from the lapse in exactly one stored
  field, the *status*, which is why `db.ts` **derives** `entitled` from `refreshSecret` and
  `status` instead of storing it: a stored fourth boolean could be set to disagree with both, and
  a panel reading the wrong one of those two states draws **Connect Patreon at a paid-up
  supporter on every device but the one that pressed it**. That shipped.
  **The lapsed one is written out in `db.ts` because it is easy to get subtly wrong**:
  `entitlement::revoke` is `clear` plus one row, so a lapsed device has no refresh secret, no
  access token and **no `since`** — every field but `groupBound` reads exactly as a device out of
  the box, and a fault carrying a plausible date would let a panel keyed on that date pass. It
  did, for one wave. Both are assignments onto the world through `applySupporterFault`, which is
  `mirrorFailedPass`'s shape and exported for its reason: `makeDb({ fault })` cannot stand up a
  fault that writes rows.
  **The two taxonomy pairs are separate faults because the datasets are two files on two
  schedules** — either can be missing, or failing, while the other is fine, and the Tags page has
  to stand in all four of those worlds.
  **The tag faults empty rows and `imageUrisMissing` branches in the handler**, and the
  difference is ownership rather than taste: `seeds.ts` shares `cards` **by reference** between
  worlds, so nulling a column there would null it for every story on the page.
  **`mirrorRootUnwritable` is the one fault that does both halves — a row change *and* a
  handler branch.** The plain-text mirror's root has gone, which is a pass that has already
  failed: `installWorld` records it on the world so the Backup panel draws the sentence with
  nothing pressed, and `mirror_rebuild` refuses so that pressing the button cannot clear the
  error by succeeding into a folder that is not there. Nothing else about the world changes —
  no database write ever waits on a mirror write.
  **`paired` is a seed and `pairingReadError` is a fault, and the split is `combosMissing`'s
  read from both ends.** Being paired is not something that has gone wrong with a world — it is
  where a reader arrives after two presses, and the only state the roster, a removed row **the
  status command filters away** and the key version are reachable from. What *is* a fault is the
  one refusal in that flow a reader cannot produce by typing: every other way it fails is a shape
  the handler raises itself, and what is left is a blob failing to open. **Since 2026-08-31 that
  fault lands on `sync_pairing_poll`, on the offering device's read of the joining device's
  answer** — not on `sync_pairing_respond`, which no longer exists as a command: the rendezvous
  moved that read inside `poll`, and the fault moved with it. Nothing is typed here either way,
  which is the whole reason it is a fault rather than a shape.
  **Re-count this list when you add one** — it said "four" for three faults' worth of drift, and
  then "eight" while `errorLog` had been in the union for a whole feature, because a prose-only
  edit routes to neither CI job and nothing goes red.
- **The combo feed is a *seed* where the two taxonomies are a fault, and the asymmetry is the
  feature's.** `oracleTagsMissing`/`artTagsMissing` are worlds a taxonomy has gone missing from;
  a never-fetched combo table is the world **every install stays in** until somebody presses
  Refresh, because `combos::refresh_if_due` will not pull that file uninvited. So `combosMissing`
  is a seed, `combosFetchError` is the fault beside `feedFetchError` and the two tag ones, and
  `bracketMismatch` is `starter` plus a fifth deck the reader has told `Bracket 2` whose cards
  force the estimate's floor to 4. `starter` seeds the combo catalogue itself, exactly as it
  seeds the price feeds and both taxonomies — **seven combos, two of them live-verified against
  Commander Spellbook on 2026-08-27 and five constructed**, because the 52-printing corpus can
  make only two real ones and neither reaches the `R`/`P`/`C`/`E` letters the advisory has to
  draw. `COMBO_FIXTURES` in `db.ts` says which is which, per row.
- **`starter` seeds both tag taxonomies too**, derived from the corpus the same way. Oracle: **32
  oracle cards, covering 42 of the 52 printings** (measured by `db.test.ts`, which fails rather
  than letting this line rot), closed over their ancestors as `oracle_tag_cards` stores them, so
  a deck story shows real piles rather than everything falling back to card type. Art: **eleven
  tagged printings over thirteen tags and four roots**, keyed on `illustration_id` because an art
  tag is a fact about a *picture* — one of the four Lightning Bolts carries `lightning` and the
  other three carry nothing, which is the difference from the oracle table in one line. `empty`
  and `large` deliberately go without both, and `oracleTagsMissing`/`artTagsMissing` are how a
  story stands in the never-ingested state on a *full* corpus. The two oracle reads answer **one
  entry per requested id, in request order, deduped, `slugs: []` for anything unknown** — a fake
  that answered only the matches would look right in Storybook and break every caller that
  matches by id.
- **Every art tag in the fixture is true of the picture it is on**, which is why there is no
  `dog` in it: nobody in these 52 printings is a dog, and a wall of cats filed under "Dog"
  would teach a reader that the Tags page's whole subject is decorative. The crate's own fixture
  (`tags/query.rs`'s tests) is where the `dog`/`hound`/`bulldog` branch lives. What the seed does
  carry is the *shape* every story needs: a category with no direct taggings of its own
  (`animal`, reached only through `cat` and `monkey`), a tag with **two** parents (`forest`, under
  both `plant` and `landscape` — 43 % of real art tags have more than one), one `weak` tagging so
  the weight floor visibly changes a wall, and one illustration tagged twice so the closure's
  fold to the *strongest* weight has something to fold.
- **Muting is never seeded.** `muted_tags` is a user table and the only one in that group, so a
  Settings list showing a muted tag is about a press the story made — `deckUndo`'s rule.
- **`indexCold`'s response answers every map with an *empty* one and every scalar with `0`, and
  only the first of those is self-describing.** An empty map makes every lookup miss, and a miss
  is the `undefined` the filter row fails open on. `FacetResponse.manaX` — the X chip's count —
  is a number with no empty to take, so the cold handler sends `0`, which is exactly what a warm
  response sends for "no X cards here". **`ready: false` is the whole of what separates them**;
  a scalar added to that response later needs the same `0` and the same paragraph. Full
  reasoning: [docs/reference/search-faceting.md](../docs/reference/search-faceting.md).
- **`starter` seeds both price feeds**, derived from the corpus rather than written out:
  `marketplacePrices` is the fake's `marketplace_prices`, so a story can select Card Kingdom or
  Mana Pool and see *different numbers* rather than the same ones under a new label. Every
  fourth printing is left out of Mana Pool's on purpose — a card one feed lists and another does
  not is the state no amount of currency arithmetic could produce, and it is the one the em-dash
  rule exists for.
- **Three of the fake's commands are Tauri _plugins_, not this app's** — `pluginHandlers()` in
  `db.ts`, merged into `allHandlers` beside the two mirrored tables:
  `plugin:clipboard-manager|write_text`, `plugin:opener|open_url` and `plugin:dialog|save`. The
  fake `invoke` is the whole IPC layer here, so without them a Copy, an Open on or a Save as… is
  answered `No fake handler registered` — a rejection about the workbench drawn in a `role="alert"`
  the app wrote about the reader's disk. It takes **no store**: they mirror no table and no crate
  module, and `db.test.ts`'s busy sweep walks `writeHandlers` asserting everything there can be
  refused by a running sync, which none of these can. **`save` answering a path is not the same
  decision as `import_read_file` throwing**: the picker there would invent the *decklist*,
  which is the screen's whole subject, while this one invents only a file name over text the
  reader is already looking at.
- **Undo is a wrapper over `writeHandlers`, not a line in each of them.** `journalled()` snapshots
  the deck either side of every deck write and files a step under the **last** history row that
  write produced, so a new deck write is covered by construction rather than by somebody
  remembering — the fake's version of `every_deck_write_leaves_exactly_one_audit_row`. It stores
  the deck twice rather than transcribing the crate's four `Op` primitives, deliberately: a step's
  whole job is "make the deck look like this again", the crate needs ops because SQL has no other
  way to say it, and a second transcription would be a second implementation to keep in step.
  **The known gap is the fake's own and predates this**: the **seven** card writes
  (`deck_add_card`, `deck_set_card_quantity`, `deck_move_card`, `deck_swap_printing`,
  `deck_set_card_finish`, `deck_category_clear` and `deck_clear`) record no history row here, so
  Storybook's history drawer does not list a card added from *search* and — consistently — Undo
  does not offer to take one back. Closing it means giving those seven a `record(…)` call, which
  changes what the *history* stories draw and belongs with them.
  **It said "five" here and in `db.ts` until 2026-09-01, and it was wrong by one before
  `deck_clear` was written**: `deck_set_card_finish` arrived with `Set as foil` and its crate twin
  `set_card_finish` writes a `SWAP` row, so the gap had widened once with nothing to notice. That
  is the argument for naming them rather than counting them — a count in prose routes to neither
  CI job, and this one drifted twice before anybody read it.
  **`collection_to_deck` and `deck_to_collection` are outside that gap and record as of
  2026-08-23**, when the Collection Search tab gave the first of them a caller; both are on
  `NO_UNDO_STEP` because a step could restore the `deck_cards` half and would leave the copies
  where they went. **`collection_to_deck` also rolls back the pile its name arm invented when a
  later refusal fires** — the crate gets that free from the transaction the create sits in
  (`a_refused_filing_by_name_leaves_no_pile_behind`), and a fake with no transaction has to undo
  the write by hand or it shows an empty column standing after a press that failed: a state the
  backend cannot produce, which is the class of defect this feature has already shipped once.
- **A world belongs to a story, not to the module** — a docs page mounts every story on it at
  once, which the canvas hides. `.storybook/fake/scope.ts` owns the four ways the global pointer
  is kept right; adding an entry point to the fake means asking which of the four covers it.
- **`useAppStore` is the one global that cannot be made per-story**, so every story file that
  writes it during render carries `docs: { story: { inline: false, height } }`. A new story file
  that writes the store needs the same parameter or its docs page shows one story's view under
  every heading. (This used to name a count of such files, and the count went stale the first time
  one was added — the imports answer it, so it is not written down here.)
- **A fixture more than one story file needs lives in `.storybook/fake/fixtures.ts`.** A CSF file
  cannot own one — every non-default export is indexed as a story. Not in `cards.ts`: that file is
  generated wholesale.
- **The corpus has exactly one `{X}` printing** — Agadeem's Awakening (`znr 90`,
  `{X}{B}{B}{B}`, mana value 3, `modal_dfc` with a land on the back). A story about the X mana
  chip, the deck editor's `Split X` toggle or the tenth curve bar has to reach that printing or
  it draws a heading over nothing. Its mana value being 3 is the useful part rather than an
  accident: `fixtures.ts`'s `deckGroups` puts a second mana-value-3 card beside it, so switching
  the split on moves it **out of a bucket that survives** — a curve whose `3` column vanished
  with the card would leave a reader unable to tell a re-filing from a disappearance.
- **Art is synthetic by default**, with a Live toolbar switch, so a checkout with no network
  renders every story exactly as one with it. **No card image bytes are committed.**
- **Searching `.storybook/fake/db.ts` works, and this line said the opposite for over a year of
  commits.** ripgrep classified it as **binary** — so Grep answered "no matches" for strings
  plainly in it, and a session acted on that once, adding handlers the file already had until
  `tsc -p .storybook` caught it with `TS1117`. **The cause was never the size**: it was a single
  NUL byte, from `deck_tag_suggestions` building a group key as `` `${t.name}\0${t.color}` ``.
  Schema v21 replaced that function with `deck_label_all` (`deck_tag_all` until v33 renamed the
  deck card's mark) and the byte went with it on 2026-08-22.
  Verified 2026-09-03 — zero NULs in the file (733 KB) and Grep returns real counts.
  **The rule that outlives the fix**: a NUL is invisible in every editor, eslint and `tsc` stay
  green over one, and a `\0` separator in a template literal is the plausible way one gets in.
  So if Grep ever calls a file here binary again, suspect that rather than the length —
  `python -c "print(open(p,'rb').read().count(b'\x00'))"` finds it, and Bash `grep` saying
  "Binary file … matches" is the tell.

## Rules for stories

- **`tags: ["autodocs"]` is declared per file in the meta** — a new story file gets no docs page
  unless it says so.
- **Do not write a story, story-file, docs-page or plays total into any document** (removed
  2026-08-14). The reference page used to carry them and the figure conflicted on **five
  consecutive merges of `main`**, each resolution correct and each obsolete within the hour: a
  count is a fact about a *tree*, so every open branch has its own and none is the one being
  shipped. The archaeology defending it had grown longer than the rules it sat above. If a number
  is genuinely needed, measure it at the moment of need — `npm run build-storybook` then
  `storybook-static/index.json` for everything except plays, and a grep for those, since **the
  index knows nothing about plays** and a branch that re-derived every other figure off a fresh
  build left that one stale exactly that way.
- **The lesson that outlived the numbers: rebuild and read the index on the merge commit you are
  shipping, and never add one branch's delta to another's total.** No side of a merge has ever
  predicted the merge here — two branches once measured 283 and 285 plays, each accounting for
  its own honestly, and the merge answered 291.
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
- **It `vi.mock`s three of the four aliases, and the fourth (`@/lib/images`) must never be mocked.**
  **The symptom is a silent 300-second hang with no output and no failing test** — if the suite
  goes quiet, this is why.
- **jsdom lays nothing out, so a virtualised list renders zero rows** without that runner's
  `offsetHeight`/`offsetWidth`/`scrollTo` stub. **Assert the content presence of a named row,
  never a count.**
- **A green Storybook proves nothing about the shipped window** — no WRY OLE drop target, no
  `mtgimg://` handler. Drag-and-drop and image loading stay the live CDP pass's to prove.
