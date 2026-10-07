# The light app

The Android and web face of MTG Grimoire — card search, decks, collection, wishlist and scanner —
as one second entry over the desktop's own components. **What is built is phase 1, the skeleton,
and phase 3, the pages:** it runs in a browser over the Storybook fake (§2.1, §7) and in a
phone-sized window over the real Rust core (§2.2). Underneath it, phase 2 moved the engine into a
crate those hosts can link (§6), **phase 4 built the Android host on it** (§8) — an APK
CI builds, which a phone first ran on 2026-10-04 (§8.6) — and **phase 5 built the web host** (§9): since
step 5.1 (2026-10-04) the engine is a WASM module in a dedicated Worker, and it opens its
database in a browser's OPFS and answers commands there, and **since step 5.2 (the same day) it
builds its corpus there** — the launch's downloads streamed into their sinks, run once against
the real hosts (§9.2) — and **since step 5.4 the clipboard, a link out and the desktop face's
file dialogs are a browser's own there, and the manifest is finished** (§9.4), and **since step
5.3 a service worker precaches the shell, answers card pictures on the app's own origin from
Cache Storage, and holds a newer build until the reader takes it** (§9.3) — so a built web app
draws its pictures and opens with the network gone — and **since the first half of step 5.5
the hosting Worker's source, its policy and its runbook are in `app-worker/`** (§9.5), and
**since its second half the module's `opt-level` is settled by timings, CI's smoke run is
served under that policy, and the built app has been driven end to end on both faces against
the real hosts** (§9.6). **It is deployed at `https://mtg-grimoire.app` since 2026-10-04**
(§9.7) — the deploy is the owner's, and each one that day was run by an agent at his ask; one
headless Chrome on Windows has driven the web host, and the owner has used it in Firefox and
on a phone and said so in a sentence each. **Sync on a light install is phase 6, built a step at
a time in §10 — and complete since 2026-10-05**: a light install is another device in the
group, pairing by the same invite and keeping in step over the live socket, on both hosts —
the loop is the core's, the Android host and the web host each run it — with a pull that is
paged and a socket that is let go of when its device leaves or is removed. **Both Workers are
deployed with all of it**, the relay and then the web app, twice each (§10.7), and **the owner
has paired a browser with a desktop in production and synced between them** (2026-10-05; his
sentence, not a measurement). What has still not been seen: sync on a phone — the camera's
grant, a real lens on a real code, a socket across the app going to the background; in
Safari; and in Firefox. §10 closes with what is open and whose it is.

- The design, all seven phases: [the spec](../superpowers/specs/2026-10-01-light-app-android-and-web-design.md).
- How the skeleton was built: [the plan](../superpowers/plans/2026-10-01-light-app-skeleton.md); the
  pages: [the phase 3 plan](../superpowers/plans/2026-10-03-light-app-phase-3.md); the web host:
  [the phase 5 plan](../superpowers/plans/2026-10-04-light-app-phase-5.md); sync:
  [the phase 6 plan](../superpowers/plans/2026-10-04-light-app-phase-6.md).
- What is left, phase by phase: [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761).
- The binding rules for anyone changing it: [`mobile/CLAUDE.md`](../../mobile/CLAUDE.md).

This page is the record: what was measured, on what, and what is known to be open.

## 1. What it is, in four sentences

`mobile/` is one Vite entry. At **≥ 1024px** of viewport it draws the desktop UI itself under a
light `Edition` — the same pages, a rail of six rows, no caption row. **Below 1024px** it draws a
phone face of its own in `mobile/phone/`. The Android app and the web app are the same bundle, the
face is chosen by width and by nothing else, and the URL is the navigation state both faces read —
so a browser dragged across 1024 swaps faces and stays where it was.

**Why two faces rather than one responsive one.** The first Android and PWA builds (removed on
2026-09-27, PR #602) bent the desktop's components down to 360px, and the owner's verdict was on
the design, not the engine. Here every component is drawn only at the widths it was designed for.

## 2. What was driven, and on what

Two passes, both on 2026-10-01 on Windows 11, and they are kept apart because they prove
different things. **§2.1 is the browser over the fake; §2.2 is the Tauri window over the real
Rust core.** Nothing here was measured on a phone, in Firefox or Safari, or against a production
bundle.

### 2.1 In a browser, over the fake

**`npm run mobile:dev` (Vite's dev server, not a build), the Storybook fake's `starter` seed,
driven in the Claude desktop app's built-in Chromium pane with its viewport emulated.**
`?art=live` was on, so the pictures are Scryfall's.

#### The phone face, 360 × 800

| What | Measured |
| --- | --- |
| Columns on the search wall | 2 |
| Tile width | 162px |
| A tab's box | 72 × 52px, all five; the lit one carries `aria-current="page"` |
| `documentElement.scrollWidth` | 360 — nothing scrolls sideways |
| The card sheet's panel | 360 wide, 752px tall, 24px of scrim above and below |

- A tile is `components/CardTile` — the desktop's own card frame and chin — and reads as one: the
  rarity gem, the set and number, the price, a foil's finish glyph beside it, and the count tag in
  the art's bottom-left for a row of more than one copy.
- The sheet for the seed's first search result, a double-faced card, draws both faces' names,
  costs as mana symbols and rules text, the printing's set line, and three prices with an em dash
  for the finish that printing does not come in.
- Scanner and Settings each draw their one placeholder sentence.
- The console carried no error and no warning from the app.

#### The desktop face, 1280 × 800

- The rail's rows are **Search, Decks, Collection, Wishlist, Scanner, Settings**, and Collapse.
  No caption row is drawn (`data-tauri-drag-region` matches nothing).
- The pages are the desktop's own: the search page with its filter bar and the grid-or-table
  pair, the decks gallery with its folder tree, the deck editor with its docked search column.
- `documentElement.scrollWidth` 1280.

#### The crossing

| Sequence | Result |
| --- | --- |
| Phone, a card open (`/search?card=…`) → widen to 1280 | The desktop face, the same URL, the same card open in the desktop's card modal |
| Escape on that modal | URL `/search`; `history.length` unchanged — a `replaceState` |
| Desktop: rail → Decks → a deck | `/decks`, then `/decks/2`; one history entry each |
| Desktop on `/decks/2` → narrow to 360 | The phone face on the same deck, its name in the heading and its cards on the wall |

#### History on the phone face

| Step | URL | `history.length` | Sheet |
| --- | --- | --- | --- |
| On a deck | `/decks/2` | 5 | — |
| Press a tile | `/decks/2?card=…`, `history.state` `{ pushed: true }` | 6 | open |
| Escape | `/decks/2` | 6 — the router went *back*, it did not push | closed |
| Browser Back | `/decks` | — | closed; the card did not reopen |

### 2.2 In the Tauri window, over the real core

**`npm run mobile:tauri` — a debug build, under the `app` lock, WebView2 driven over CDP on 9222
(`scripts/cdp.mjs`), the frame measured with Win32.** The database was a copy of the main
checkout's dev `data/` folder, so the corpus, the decks and the picture cache are real. The desk
is one 2560 × 1392 work area at 100% scale.

| What | Measured |
| --- | --- |
| Cold build, after a `verify` had built the desktop config | 2 m 09 s; the process was up 136 s after launch |
| Client area | **412 × 915** logical, exactly the overlay's size |
| Outer frame | 428 × 954 at (1066, 222) — OS-framed, centred, titled `MTG Grimoire — light` |
| The page | `http://localhost:5175/`, `innerWidth` 412, the phone face, the startup gate passed |
| The wall | 2 columns, tile **180.5px**, `scrollWidth` 412. That width is (412 − 36 of padding and gap − 15) / 2, so the wall's scroller is wearing a classic 15px scrollbar here — inferred from the sum, not read off the element |
| Pictures | `http://mtgimg.localhost/display/<id>/0`, loaded — the app's own protocol and cache |

- **A real search narrows**: `lightning bolt` typed into the box took the wall to three tiles,
  named `Lightning Bolt, PLST CLB-187`, `Emeritus of Conflict // Lightning Bolt, SOS 113` and
  `Toralf's Disciple, MB2 261, Foil` — the last one a foil-only printing, marked and said.
- **A tile opens the sheet** with a marked push (`history.state` `{ pushed: true }`) and the
  card's real text and set line; Escape went back to `/` with `history.length` unchanged.
- **Decks** listed the reader's five decks as links; one opened to `/decks/3` with its name in
  the heading and its cards on the wall. **Wishlist** drew a full window of tiles.
- **Collection drew one tile.** That is what the open-shelves rule of §5 predicts for a reader
  whose copies are filed in their decks' own groups, which start shut — the likely reading, and
  not one this pass confirmed by counting the shelves.
- **Widened to a 1280 × 915 client, the window drew the desktop face over the real core**: the
  rail's six rows and Collapse, no in-app caption, heading *Search* — not Home, which is where
  the same database opens the desktop app. The ribbon was mid-ingest (`Importing cards · 42,000
  cards`) and the wall drew regardless. Narrowed again, it was the phone face on the same place.
- After the lock's `release`, nothing was left listening on 5175 or 1420.

**Then `npm run tauri dev`, to see the desktop app had not moved** (27 s rebuild — the overlay
arrives through the build's environment, so each switch rebuilds): client **1920 × 1080** (the
ladder's top rung on this desk), `http://localhost:1420/` with no path written, the in-app
caption drawn, the rail's rows Home, Search, Tagger, Decks, Collection, Wishlist, Scanner, Trade,
Playtesting, Settings, and the app open on **Home**. That is ten rows, and it is all of them:
the eleventh the spec counts is Shared, which the rail draws only while a shared binder is open.
**The plan's `Ctrl+1` goes Home check was not driven** — `cdp.mjs key` has no digit — so the
chord guard's desktop half rests on `AppShell.test.tsx`.

### 2.3 The suites

`npm run verify` on the branch with `main` merged in — the build's four `tsc` programs, ESLint,
`cargo fmt --check`, clippy, Vitest and both cargo test runs — was run twice: once before the
whole-branch review's fixes (2026-10-01, exit 0 in 847 s) and once on the last commit that
changed code, `f2c6fb99` (2026-10-02, exit 0 in 576 s). Everything after that commit is prose.
No total is written here; a count is a fact about one tree.

Two builds `verify` does not run were run by hand between those two runs, both exit 0:
`npm run mobile:build` (§3's checks repeated — the page at the root, no fake in any chunk) and
`npm run share:build`, because `share/ShareTile.tsx` now draws through `CardTile` and nothing
else bundles the public viewer. **The share viewer was built, not looked at**: its tile gained
one wrapper element, and whether that moved a pixel on the public page is unmeasured.

## 3. The build

**`npm run mobile:build`, 2026-10-01, before `main` was merged in: exit 0 in 21 s including
`tsc`.** Neither `verify` nor CI runs it.

| Chunk | Raw | gzip | Loaded by |
| --- | --- | --- | --- |
| `index` (the entry) | 244.99 kB | 77.12 kB | the page, statically |
| `routes` (what both faces share) | 282.73 kB | 90.47 kB | either face |
| `PhoneApp` | 14.07 kB | 4.67 kB | the phone face |
| `DesktopFace` | 1,460.89 kB | 438.33 kB | the desktop face |
| `NoteEditor` | 473.06 kB | 148.17 kB | the desktop face, lazily, as in the desktop app |
| the stylesheet | 197.27 kB | 35.44 kB | the page |

- `dist-mobile/index.html` is at the root and there is no `dist-mobile/mobile/`.
- The page's only static script is the entry; each face is fetched when its width asks for it.
  **A phone therefore fetches about 542 kB of script (172 kB gzipped) and never the 1.46 MB
  desktop chunk** — which is the point of the two lazy faces.
- None of the five scripts contains `No fake handler`, `installWorld`, `fakeBoot` or `bootFake`:
  the fake backend is not in a production bundle.
- **Chunk names carry a hash and these sizes are one tree's.** Re-measure rather than quote.

## 4. What the first live pass found

**`npm run mobile:dev` did not stay up.** The server printed its URL and exited a few seconds
later, during "bundling dependencies", with `UNLOADABLE_DEPENDENCY: Could not load
../../../../../.storybook/fake/core.ts`; the page was blank and every dependency request was
`ERR_CONNECTION_REFUSED`. The two Tauri plugins the app imports each import
`@tauri-apps/api/core` from inside `node_modules`, the dependency optimizer applies the fake's
alias while it pre-bundles them, and a root-relative replacement is not a path it can load.

It went unseen for seven tasks because the entry was a stub when it was first served, and no
suite starts a dev server. The fix (`vite.mobile.config.ts`) is absolute alias paths, as
Storybook's are, **and both plugins left out of the optimizer in fake mode** — bundled, each
would carry its own copy of the fake with no world installed in it, so a Copy or an Open-on
would be answered by nobody. That second half is reasoned, not driven: no press in the pass
reached a plugin.

Every jsdom suite was green over this. It is the repo's standing rule — a green suite proves
nothing about the running app — arriving on schedule.

**The same server then died a second way, left up while `npm run verify` ran**: `EBUSY: resource
busy or locked, watch '…\crates\card-scanner\target\…\sqlite3.o'`, the moment cargo reached that
crate, having already reloaded the page once for `dist/index.html`. The root is the whole
repository, so Vite watches all of it, and Windows refuses a watch on a file a compiler is still
writing. `vite.mobile.config.ts` now keeps the watcher out of every build output under the root,
**and that was driven the same way it was found**: the server was left up through the second
`verify` of §2.3, cargo's run over that crate included, and was still listening when it ended.
**The base config ignored `src-tauri` only, so the desktop's and the share viewer's dev servers
had the same exposure** — flagged here, and fixed by #760: `vite.watch.ts` is the list every
server takes from the base config, and the light config's own copy was dropped in phase 3.

## 5. Open, and where each belongs

Nothing below blocks the skeleton. Each was found by a review or the live pass and left on
purpose; the phase that owns the surface owns the fix.

### Phase 3 — the phone pages (each comes to the owner as built options first)

- ~~**The Collection and Wishlist walls draw open shelves only.**~~ — **fixed 2026-10-03 for the
  collection in step 3.2** (§7.2): it is the cabinet, every shelf headed and every one openable,
  a deck's group and `Recently removed` included — **and for the wishlist in step 3.3** (§7.3),
  a deck's managed wishlist folder included.
- ~~After a refused next page a wall stops asking and says nothing~~ — **fixed 2026-10-03**: the
  wall ends on `The next cards could not be read.` and a `Try again` that calls `fetchNextPage`
  itself (`parts.tsx`'s `NextPageRefused`, through `CardWall`'s `footer`). It still stops asking
  on its own until then, and still re-arms on any refetch.
- ~~When the whole-wall figure itself fails to load over an empty wall, the page draws
  nothing~~ — **fixed 2026-10-03**: the collection and the wishlist say the rest could not be
  counted, from `useCollection`'s new `figuresRefused` and `useWishlist`'s `countsQuery`.
- ~~A tile with no card to open (a wish whose card the corpus no longer has) is a button that does
  nothing~~ — **fixed 2026-10-03 in step 3.3** (§7.3): a wish is drawn as the printing it is drawn
  as (`artCardId`), and a tile with none is no control at all, on both walls (`WallTile`).
- ~~Two rows of one printing get one accessible name~~ — **fixed 2026-10-03 in step 3.2**
  (§7.2): the phone folds them into one tile exactly as the desktop wall does
  (`collectionWall.ts`'s `collectionTiles`), so `Lightning Bolt, STA 105, Etched, 2 copies` is
  one name for one tile.
- ~~`DeckPage` keys its own query, so crossing 1024 with a deck open refetches it; it always reads
  the `live` list~~ — **fixed 2026-10-03 in step 3.4** (§7.4): it asks through `deckDetailQuery`
  (`src/features/decks/deckQuery.ts`), the key `useDeck` itself reads under, and opens on the list
  the deck remembers (`lastVariant` where it keeps a plan) with a Theory / Actual switch. And
  ~~`facesOf` now exists twice~~ — **fixed 2026-10-03**: it lives once, in
  `src/features/card/faces.ts`, read by `CardTextDialog` and the phone's card sheet (§7.1).
- ~~The wall's list semantics count rows rather than cards~~ — **fixed 2026-10-03 for the
  shelved wall** (§7.2): each shelf is its own list named for the shelf, and each card says
  `aria-setsize`/`aria-posinset` within it, so a virtualised shelf announces its whole count. The
  flat `CardWall` (Search) still counts rows. ~~No test scrolls a long wall to its end~~ — the
  collection's paging test scrolls the `large` seed's 600-tile shelf to its far end.
- ~~In landscape the bars stop short of the screen's edge beside a cutout.~~ **Closed
  2026-10-03 (§7.8)**: the bars bleed and inset their content.
- **A constraint on the sheet's design, not a defect yet**: a step from one card to another
  *inside* the sheet must be `navigate(…, { replace: true })` — **held since 2026-10-03** by
  `linkTo(place, { replace: true })` on every printing row (§7.1). A plain `navigate` is a second
  marked push, and one close would then land on the first card instead of the page.
- ~~In the light edition `Ctrl+Shift+N` still asks for a new window.~~ **Closed 2026-10-03
  (§7.8)**, and `F1` is left to the browser on purpose.
- ~~**The desktop face can reach a view the light edition does not draw.**~~ **Closed
  2026-10-03 (§7.8)**: the way in is hidden through `useReaches`, and the adapter refuses the
  move.
- **A crossing unmounts the face it leaves**, so anything half-typed on the desktop face — a
  note, an import's text, a rename — is discarded by a browser resize or a tablet's rotation; a
  zoom gesture still inside its trailing write is not persisted; and the desktop's launch reads
  run again on each widening. **Accepted, 2026-10-03 (§7.8)** — not closed.
- ~~**History across the floor has two warts.**~~ **Both closed 2026-10-03 (§7.8)**, by two
  history marks both faces read.

### Phase 5 — the web host

**Steps 5.1 and 5.2 (§9.1, §9.2) closed none of these four; step 5.4 (§9.4) closed the last
three and step 5.3 (§9.3) the first.** What each step itself left open is at its own foot —
§9.1's, §9.2's and §9.3's *Found and left*, §9.4's *Not measured*.

- ~~`FaceBoundary` catches a face that throws — a lazy chunk that never arrives included — and
  offers a reload. What it does not do is recover: a deploy that renamed the chunks needs the
  service worker's update story, which is this phase's.~~ **Closed 2026-10-04 (§9.3), by
  taking the case away rather than by recovering from it**: a page's own build is precached
  whole, in a cache named for that build, and served to the page for as long as it is open —
  so a face's chunk is found by the name this page knows, however many deploys have installed
  behind it and are waiting. `FaceBoundary` asks the host whether a newer build is waiting and
  offers *that* when one is, the reload otherwise. **Still unrecoverable in place**: a browser
  that evicts Cache Storage under a live page, with no update waiting and the old chunk gone
  from the host, cannot draw a lazy face that page has not yet loaded. No real eviction has
  been seen.
- ~~A refused history **push** is swallowed like a refused replace, but costs more than a stale
  URL — the entry is never made. `back()`'s latch has one release, a `popstate`; a
  `history.back()` the browser drops leaves ✕ and Escape inert until the next one.~~ **Closed
  2026-10-04 (§9.4)**: the phone router holds a place the browser would not write, `back()`
  waits a bounded time for its Back and then renames the entry, and the desktop adapter makes a
  refused push late, on its next write. Each is held by a test with the refusal simulated —
  thrown and dropped — and by nothing a real browser was made to do.
- ~~`public/light.webmanifest` is copied into every build's output, the desktop's and the share
  viewer's included, because `public/` is shared. It is inert there.~~ **Closed 2026-10-04
  (§9.4)**: the manifest, its icons and a copy of the favicon are in `mobile/public/`, the
  light builds' own public directory.
- ~~The manifest's and the page's `#0e0f13` is two levels off `--color-bg`'s real sRGB
  value.~~ **Closed 2026-10-04 (§9.4)**: `#0C0D12` in the manifest, the page's `theme-color`
  and Android's window ground, held equal by `mobile/host.test.ts`.

### The fences

**Closed in phase 3, step 3.8** — each with a case in `fence.test.ts` that runs it on a tree with
the weld or the probe in it:

- The import walk sees `import.meta.glob` (every file a pattern matches is an edge), a
  root-absolute specifier, and a template-literal `import()` — followed when nothing is
  interpolated, **refused** when something is, as is an `import()` of any non-literal. The comment
  stripper is string- and regex-aware; its guesses (a `/` after a token, an apostrophe in JSX
  text) are bounded to their line and can only leave prose in, never take an import out.
- The probe sweep asks for the question rather than one spelling: the bare word `userAgent`,
  `navigator.platform` by dot, bracket or destructure, and `@tauri-apps/plugin-os`. It still reads
  `.ts`, `.tsx`, `.css` and `.html` only.
- `vite.mobile.config.ts` and `.storybook/main.ts` read the fake's four aliases from one list,
  `.storybook/fake/aliases.ts`. The light config's own watch list is gone: the base config has
  carried `vite.watch.ts`'s for every server since #760, which also closed §4's closing sentence.
- `src/lib/tokens.test.ts` reads `mobile/` and counts one `MotionConfig` per face. Nothing under
  `mobile/` broke any of its sweeps.
- Storybook's story glob, `preview.css`'s Tailwind sources and `src/stories.test.tsx`'s module
  glob reach `mobile/`; `Phone/Shell`, `Phone/TabBar` and `Phone/CardWall` are the first stories.

### The dev window

- `window::open_sized_to_monitor` centres the phone-sized window without clamping it. On a work
  area shorter than about 954 logical px — a 1080p panel at 125% or 150% — the OS caption opens
  above the top of the screen.

## 6. The shared core — phase 2, a step at a time

The engine is moving out of `src-tauri` into `crates/grimoire-core`, a crate with no `tauri`
dependency that the desktop, the Android host and the WASM host will all link (spec §2). The
rules for working in it are [`crates/grimoire-core/CLAUDE.md`](../../crates/grimoire-core/CLAUDE.md);
this section is what each step built and measured. **Nothing in this section ran on a phone or
in a browser**: what phase 2 left is a crate the desktop links, compiled for two more targets.
(The hosts that run it there came after — phase 4's for Android, §8, and since 2026-10-04 the
web host, which runs it in a browser, §9.1.) All
seven steps have landed — the leaves, the storage layer, the state a host holds over it, and
the domain: the decks, the collection, the wishlist and the search — and the whole of the
fifth, in three parts: a request, a timer, a file, a lock and background work under
`platform/`; the Scryfall client, the ingest and the reconciler over them; the card sync and
the facet index that drive those; and the three feeds and the image cache. **The sixth came in
two**: the sync client, the entitlement and pairing were restated to reach the database a
stretch at a time, on a lane, holding nothing across a request — and then moved. **The seventh**
moved the scanner's session glue, and with it `card-scanner` became a dependency of the core.
**The command table came last** — `grimoire_core::dispatch`, the one entry point the light app's
hosts call, with its read commands in it and the rest on an explicit list until a page asks.

### 6.1 Step 1 — the workspace, the crate and the leaves (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-1-leaves.md). Everything below was
measured that day on Windows 11, debug builds, unless a line says CI.

**The repository is a cargo workspace now, and `target/` did not move.** Three arrangements were
measured or weighed and put to Markus, who chose a workspace at the repository root:

| Arrangement | What cargo answered |
| --- | --- |
| No workspace, the core a path dependency | `cargo test -p grimoire-core` from `src-tauri` ran — until the core had a dev-dependency: `package grimoire-core cannot be tested because it requires dev-dependencies and is not a member of the workspace`. So: a second `Cargo.lock` and a second build tree |
| A workspace rooted at `src-tauri` | `cargo metadata`: root `src-tauri`, target `src-tauri/target`; `test`, `clippy`, `fmt -p` all ran |
| **A workspace at the root** (built) | `cargo metadata`: root the repository, target `src-tauri/target` — with the pin below |

- **`.cargo/config.toml` pins `build.target-dir` to `src-tauri/target`.** A root workspace
  builds into `<root>/target` otherwise, which would have moved every checkout's dev database
  (a debug build keeps `data/` beside its executable), the portable-zip path in `release.yml`,
  and 37 mentions of `src-tauri/target` in 22 files outside `docs/superpowers/`. What moved is
  `Cargo.lock`, to the root, and the seventeen `[profile.dev.package.*]` overrides, to the root
  manifest — cargo reads profiles from the build root only.
- **`crates/card-scanner` is excluded by name and builds where it always did.** The pin reaches
  any cargo run under the repository, because config follows the working directory and not
  `--manifest-path`: from the root, `cargo metadata --manifest-path crates/card-scanner/Cargo.toml`
  answered `src-tauri/target`; from inside that folder, its own `target`, through a
  `.cargo/config.toml` of its own. Scripted runs from the root pass
  `--target-dir crates/card-scanner/target`.
- **`tauri dev` was launched under it** and built to `src-tauri/target/debug/mtg-grimoire.exe`
  (1 m 49 s with the dependencies already built).

**Ten modules moved, with their tests, and no caller changed.** `app_meta`, `slug`,
`cardtypes`, `legalities`, `feed::frame` (and `feed`'s `mostly_unusable`), `index::bitset`,
`sync_pair::{crypto, invite}` and `sync_engine::{hlc, merge}`. Each is `git mv`'d and
re-exported from `src-tauri` at the path it had — `pub mod legalities;` became
`pub use grimoire_core::legalities;` — so `crate::legalities` still resolves there.

- **The spec listed fifteen leaves and six were not.** `sorting`, `image_uri`, `card_row`,
  `errors`, `feed::backoff` and `sync_engine::wire` name `schema`, `sync` or
  `sync_pair::identity` — three of them only in their *tests*, which open
  `schema::memory_pair()`. A module's tests move with it, so those wait for step 2. The plan has
  each reason.
- **One test changed crates rather than moving with its module**: `slug`'s check that `tags`
  re-exports its function names `crate::tags`, which the core cannot, so it sits beside the
  re-export in `src-tauri/src/tags/mod.rs`.
- **No test was lost.** `#[test]` and `#[tokio::test]` attributes: 3 356 under `src-tauri/src`
  before; 3 231 there and 131 in the core after — the difference is the six the core's
  `platform` module added. `cargo test --workspace`: every one of them passed, 5 ignored as before.
- The pairing cryptography's four crates (`x25519-dalek`, `chacha20poly1305`, `hkdf`,
  `qrcode`) left `src-tauri/Cargo.toml` for the core's, with the comments that argue their
  versions. Nothing in `src-tauri` names them any more.

**`platform/` holds the clock and a fence.** `platform::clock` answers the wall clock from
`SystemTime` natively and `Date.now()` in a browser — the first web build hit
`SystemTime::now()`'s panic five times — and has no caller yet: the leaves take their time as
an argument or from SQLite. `platform::fence` is the source sweep the spec's §2.2 asks for. It
refuses a target `cfg`, `cfg(windows)`/`cfg(unix)`, `SystemTime::now` and `Instant::now`
outside `src/platform/`, and a `tauri` dependency in the manifest; each rule has a case proving
the detector fires, including one that runs it over `clock.rs` and expects offences. HTTP, files,
a sleep and background work are named in the module doc and not written: none has a caller.

**The core compiles for WASM, here.** `cargo build --lib -p grimoire-core --target
wasm32-unknown-unknown` — 19 s cold for that target — and `clippy -- -D warnings` the same way,
clean. That compiles SQLite's C through `sqlite-wasm-rs` 0.5.5 under `rusqlite` 0.40.1, with
clang 22.1.8 from `C:\Program Files\LLVM`, which `cc-rs` only finds through
`CC_wasm32_unknown_unknown`. **Compiles is all it proves**: nothing instantiated the module.
**The Android compile has run nowhere yet**: there is no NDK on this machine, so its first
run is the `core` job on the pull request that adds it.

**CI gained a `core` job**: `cargo build --lib` and `clippy` of the crate for
`wasm32-unknown-unknown` and `aarch64-linux-android`, on Ubuntu 24.04. The desktop compile and
every test are still the `rust` job's, now over `--workspace`.
[ci-and-releases.md](ci-and-releases.md) has the routing.

**The desktop, after the move** — the real window, `tauri dev`, over a copy of the main
checkout's data (118 610 printings):

| Asked through the live `ipc` module | Answer | Reaches |
| --- | --- | --- |
| `search_cards`, text `lightning bolt` | 78 printings, first `Lightning Bolt`, 9 ms warm | — |
| `search_cards`, text `bolt`, format `modern`, type `Instant` | 94 | `legalities`' mask and `cardtypes`' — both moved |
| `facet_cards`, text `bolt` | `ready: true`, 23 formats, 8 types | `index::bitset` — moved |

**No figure in [data-and-sync.md](data-and-sync.md) or
[search-faceting.md](search-faceting.md) was re-taken, and a release one could have moved.**
A debug build cannot have: it inlines nothing before or after. A release build can, because
the moved code is now called across a crate boundary with no LTO, and a non-generic function
is only inlined across crates when it says so. `index::bitset`'s per-printing and per-word
methods are the ones on a hot path — the facet index calls `set` and `contains` once per
printing per dimension — and they gained `#[inline]` with the move for that reason. **That
restores what the compiler was free to do; it was not measured.** The pass above is a check
that the app still answers, in a debug build, and not a timing.

**What the root workspace costs every other checkout.** Cargo finds a workspace by walking up
parent directories, and the agent worktrees live under the main checkout
(`.claude/worktrees/<name>/`). Reproduced in a scratch copy of the layout, with the main
checkout carrying the root manifest:

| Checkout nested under it | `cargo metadata` |
| --- | --- |
| A worktree whose branch predates the workspace — no root manifest of its own | **Refused**: `current package believes it's in a workspace when it's not` |
| An up-to-date worktree, its `src-tauri` | Its own root, its own `src-tauri/target` |
| An up-to-date worktree, `crates/card-scanner` with no `[workspace]` table | **Refused**, the same way — its own root excludes it, so the walk carries on up |
| …with the empty `[workspace]` table it now has | Its own root |
| A stale worktree, if the main root also excluded `.claude` | Resolves — **into the main checkout's `src-tauri/target`**, so its app would open the main checkout's dev database |

So once the main checkout has this change, **every worktree that has not merged `main` fails
every cargo command until it does**, and a worktree parked on an older commit on purpose needs
an empty `[workspace]` table added to its `src-tauri/Cargo.toml` by hand. Markus weighed that
against a workspace rooted at `src-tauri` — where all of those cases resolved, also reproduced —
and kept the root: the break is one merge per open branch, and the layout is the conventional
one the Android and WASM hosts join as ordinary members. The fifth row is why the root manifest
says never to exclude `.claude`.

**Open after step 1:**

- **`release.yml` has not run under the workspace.** `tauri-action`'s lookup was read at the
  pinned SHA and honours `build.target-dir`; the first release is still the first proof.
- **`scripts/coverage-rust.mjs` was rewritten for two members and not run against cargo.**
- **Moving `target/` to the root** is deleting `.cargo/config.toml` and sweeping what names the
  folder — on an announced day, since every checkout rebuilds and its dev database moves.
- **The fence sweeps test code too**, and `index/mod.rs`'s tests time themselves with
  `Instant::now()`. When they arrive they go through `platform`, or the fence learns to read
  `#[cfg(test)]`.
- **`errors::kind_of` names `scryfall::ScryfallError`**, a type the I/O step moves — the one
  place a storage-step module depends on a later step's.
- Doc links in the core to modules still in `src-tauri` (`crate::filters`, `super::apply`) do
  not resolve until those arrive. Nothing builds docs, so nothing is red.

### 6.2 Step 2 — storage (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-2-storage.md). Everything below was
measured that day on Windows 11, debug builds, on the branch's own tree over `main` at
`fb290538`.

**The core holds the database now, and seven of the sixteen modules this step had on its list
are not in it.** Each one's code and tests were read for what they name:

| Moved | |
| --- | --- |
| `db` | The connections, the pragmas, `lock_for` and `lock_background` |
| `schema` | Every table, both ladders, the grains, the staging swaps — 22 900 of its 23 900 lines |
| `sync_meta` | **New**: `get_meta`, `set_meta`, `set_meta_opt`, carved out of `sync` as `app_meta` was out of `update` |
| `filters`, `sorting`, `card_row`, `image_uri` | Whole |
| `errors` | All but `kind_of` |
| `feed::backoff`, `sync_engine::capture` | Whole; `src-tauri/src/feed/` is gone |
| `scratch` | The test helper, behind a feature |

| Waits | For | It calls |
| --- | --- | --- |
| `reconcile` | step 4 | `collection::fold_entry` |
| `managed_wishlist` | step 4 | `deck_theory::wanted`, `wishlist::add_wish_silent` |
| `sync_engine::apply`, `baseline` | step 4 | `collection_folders::refile_entry`, `wishlist_folders::refile_wish` |
| `collection_source` | step 4 | `AppState`, `sync::with_write`, `index::lifecycle` |
| `sync_pair::identity`, `sync_engine::wire` | step 6 | `sync_engine::client`'s cursor keys; `identity::Group` |

Markus was shown that table with two alternatives — moving `identity` and `wire` now by hoisting
the client's keys, or moving all sixteen through callbacks the desktop supplies — and chose
this: nothing gets a seam the next step deletes.

**`schema` and `errors` each left one function in `src-tauri`**, in a module that re-exports the
rest (`src-tauri/src/schema/mod.rs`, `errors/mod.rs`). An item a module defines shadows a glob
import of the same name, so no caller changed.

- **`prepare_database` is cut at the line it already drew.** `schema::bring_to_head` is the two
  ladders and the capture triggers — every step of a launch that may stop it. The desktop's
  `prepare_database` is that call followed by the logged passes, which call `maintenance`,
  `managed_wishlist`, `deck_tokens` and `deck_meta`. **The two halves rejoin to the original
  130-line body byte for byte**, checked by a script against `main`'s file.
- `prepare_data_dir` is `split::convert`, then `schema::replace_unreadable_corpus`.
- `errors::kind_of` names `scryfall::ScryfallError` and waits for the I/O step.
- **Named `x/mod.rs` rather than `x.rs` on purpose**: with the old path gone, git records
  `schema.rs` as a rename at 95% similarity and its history follows.

**Twenty-one tests stayed, unedited**, because each names a module still in `src-tauri`: 17 of
`schema`'s 280, 3 of `capture`'s 42, 1 of `errors`' 10. Compared by a script, test by test: 310
bodies identical in the core, 21 identical in `src-tauri`, and one changed — a `capture`
benchmark that timed itself with `Instant::now()`, as two of `db`'s tests did. `#[test]` attributes: 3 362 before, 3 366
after (2 810 in `src-tauri`, 556 in the core); the four are this step's own.

**Test scaffolding crosses the crate through a `testing` feature.** 77 files in `src-tauri` open
`schema::memory_pair()`, 20 use `schema::tests::{seed_card, deck, category}`, 19 take a path from
`scratch`. A dependency's `cfg(test)` is off while another crate's tests build, so the core
gates those on `any(test, feature = "testing")` and `src-tauri` asks for the feature under
`[dev-dependencies]` only.

- 48 helpers of `schema`'s test module — the seeds, the `UNDO_V*` rewind chain, the
  version-pinned databases — became `schema::fixtures`, at the foot of the file.
- ⚠️ **One thing behind that feature is not scaffolding, and the suite found it**:
  `image_uri::is_allowed_host` lets a loopback host through under `cfg!(test)` so the image
  fetcher's tests can use a mock server. Moved, it refused, and ten `images` tests were served
  the placeholder. It follows the feature now, which makes it the one thing behind `testing`
  that would matter in a shipped build. **Two fences**: `platform::fence` sweeps every workspace
  member's manifest and refuses the feature outside a `dev-dependencies` table — as text, so a
  `[workspace.dependencies]` entry or a renamed dependency passes it — and CI's `rust` job fails
  when `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints
  `feature "testing"`, which no spelling passes. Today it prints `default` and nothing else.
- **CI stopped compiling the host as it ships, and the review caught it.** `clippy
  --all-targets` and `cargo test` both build test targets, so both switch `testing` on for the
  app's ordinary library as well; a non-test use of `memory_pair` would have passed them and
  first failed in `tauri build`. `cargo check -p mtg-grimoire --locked` is now the last line of
  `lint:rust` and a step of the `rust` job — 14 to 36 s here, warm.

**`platform/` gained a tick and a pause**, for `db::lock_for` and `lock_background`:
`clock::Tick` (`Instant` natively, `Date.now()` in a browser) and `pause(Duration) -> bool`
(`thread::sleep` natively; `false` at once in a browser, where no other thread can let a lock
go). On the desktop the arithmetic is unchanged. **Neither browser arm has run.** The fence
found one clock read the plan had missed, in an `#[ignore]`d benchmark. (**Both have since, and
the browser's `Tick` is no longer `Date.now()`**: it is `performance.now()` since step 5.2,
2026-10-04 — §9.2. `now_ms` and `now_secs` are still `Date.now()` there.)

**It compiles for WASM with SQLite's storage layer in it**: `cargo build --lib -p grimoire-core
--target wasm32-unknown-unknown`, 24 s, and `clippy -- -D warnings` clean. Compiles is still all
that proves. The Android compile is CI's.

**An existing database, upgraded by this build and by `main`, side by side.** The main
checkout's dev data turned out to be at user schema **v46** — thirteen rungs behind head — so
the check was a real upgrade rather than a reopen. Two byte copies of it (30 tables, 4 645 rows),
one launched under `main`'s binary and one under this branch's, each stopped 20 s after its
`user_version` read 59:

| | `main` | this branch |
| --- | --- | --- |
| `user_version` reached 59 after | 1 426 ms | 1 438 ms |
| Tables / rows / schema objects | 33 / 5 209 / 145 | 33 / 5 209 / 145 |
| `foreign_key_check`, `integrity_check` | 0, `ok` | 0, `ok` |
| `backups/user.v46.db` | written | written, and equal to the file before the climb row for row |

Compared row by row, 30 of the 33 tables are identical. The three that differ, differ in a
clock and a random number: two `app_meta` values (`mirror_installation`, minted per install, and
`update_last_check_at`), and three `unixepoch()` stamps on the token rows the v52 conversion
wrote — 31 s apart, which is the gap between the two launches.

What the climb itself changes is the ladder's, and the same under both: `deck_undo` loses 36
steps (the v53 rung clears the journal of every deck with a plan), `deck_categories` grows
70 → 121 and 336 `deck_cards` are repointed (v53's plan piles), `price_snapshots` gains the
day's rows. **No collection, wishlist or deck row goes.**

**The real window, on this branch**, `tauri dev` over a third copy:

| Asked | Answer |
| --- | --- |
| `startup_status` | `ready` |
| `search_cards`, `lightning bolt` | 78 printings, 6–8 ms warm |
| `facet_cards`, `bolt` | `ready: true` |
| `deck_list`; `deck_get` on the largest | 5 decks; 122 rows in 14 piles |
| `collection_list`, `collection_folder_list` | 277 entries; 7 folders of all three kinds |
| `wishlist_list` | 87 |
| Search, Collection, Wishlist, Decks, the deck editor — pressed and read | Each drew: 340 cards / 273 unique, 89 wishes, 5 decks, a 100+3 card deck with its stats |
| A deck made, renamed and deleted; a sticky note made and deleted | Each landed, through `with_write` and so `db::lock_for` |
| **The launch's own card sync, left to finish** | 118 610 → 118 467 printings, 0 skipped, no error — through `create_staging` and `swap_staging`, which moved; the collection still 340 / 273 / 277, nothing flagged |
| `error_log` | The two rows it arrived with |

**Nothing in [data-and-sync.md](data-and-sync.md) or
[search-faceting.md](search-faceting.md) was re-taken.** Step 1's caveat stands and is wider
now: a release build inlines a non-generic function across crates only when it says so, there
is no LTO, and `filters`, `sorting` and `card_row` are now a crate away from `search` and
`ingest`. Their functions build a SQL string or one row per call; a boundary costs a call. The
row above is a debug build answering, not a timing.

**Open after step 2:**

- **`schema` reaches the filesystem in seven functions** — `remove_database_files`,
  `back_up_user_file`, `prune_user_backups`, `replace_unreadable_corpus`,
  `corpus_is_readable`, `check_corpus` and `mark_corpus_damaged`. Each compiles for a browser and fails there when called. The I/O step's
  files interface inherits them.
- **`db::lock_for` in a browser answers `BUSY` on its first contended attempt.** Right for one
  thread; whether one write connection in a Worker is the shape at all is step 3's.
- **A new user rung owes its rewind constant in two files** while the launch tests stay behind:
  `schema::fixtures` in the core, and the two chains left in `src-tauri/src/schema/mod.rs` —
  the v59 conversion test's, which goes red by itself, and
  `migrate_the_real_database_to_v29`'s, which is `#[ignore]`d and does not.
- **`scripts/coverage-rust.mjs` was not run**, again. It splits a file at its first column-0
  `#[cfg(test)]`; `schema::memory_pair` carried one and now carries
  `any(test, feature = "testing")`, so the staging functions below it count as shipped code for
  the first time, and `scratch.rs` does too.
- `index/mod.rs`'s tests still time themselves with `Instant::now()`; they arrive with the index.
- The card-scanner suite was not run locally for this step: nothing under `crates/card-scanner`
  changed, and CI's `rust` job runs it.

### 6.3 Step 3 — state (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-3-state.md). Everything below was
measured that day on Windows 11, on the branch's own tree over `main` at `2531db8a`; debug builds
unless a line says release.

**The core owns the state every host holds and the one update hook — and `with_write` is not in
it.** This step moved no file. It added three modules and changed what `AppState` is made of:

| New in the core | |
| --- | --- |
| `state` | `State`: the write connection, an optional read one, the data directory, the cross-file fence, the event sink |
| `hooks` | `install` — SQLite's one update, commit and rollback hook per connection — and `WriteObserver` |
| `events` | `EventSink`, the one way an event leaves the crate |

The spec gave this step four things, and each was read for what it names:

| | Names | |
| --- | --- | --- |
| `AppState`'s `db`, `db_read`, `data_dir`, `fence` | `rusqlite`, `PathBuf`, `db::CrossFileFence` | **in `State`** |
| `syncing`, `client`, `images`, `index` | `run_sync`, `scryfall::Client`, `images::Cache`, `index::lifecycle::IndexSlot` | wait for step 5 |
| `pairing` | `sync_pair::pairing::Pending` | waits for step 6 |
| `mirror`, `mirror_status`, `changes` | the mirror; the other windows | the desktop's, for good |
| `with_write` | `managed_wishlist::{arm, settle_logged}`, `deck_tokens::reconcile_dirty_logged` | waits for step 4, whole |
| The hook installer | The fence, once its riders are observers | **in `hooks`** |
| `EventSink` | Nothing — and nothing in the core emits: of 15 `emit` sites, 8 are in step-5 modules, 3 in step-6, 4 the desktop's | **in `events`**, the trait and the field |

Markus was shown that with two alternatives — moving `with_write` now through riders the desktop
registers and step 4 deletes, or rewriting the eleven emit sites onto the sink now — and chose
this, step 2's rule again. **`with_write` has no line to be cut at**, which is where it differs
from `prepare_database`: its three calls sit around the caller's closure, between the lock and
the fence's assertion, so a split would leave the core a write with no managed-wishlist settle.

**The hook's riders are observers, and the desktop registers all three.** Until now
`mirror::watch::install_hook_with_changes` put four things on the one hook. The core's
`hooks::install` carries the one the core itself reads — the fence — and tells a list of
`WriteObserver`s: `row(db, table)` from the update hook, `committed()` from the commit hook.

- The spec's §2.1 counted the other windows' change mask among core state. Read against the
  tree, its one reader emits only while two or more windows are open, all seven hand marks are in
  command wrappers, and both it and live sync's wake are `tokio::sync::Notify`. A browser is one
  tab and Android one window. Markus chose observers: **the core gained no dependency**
  (`cargo tree -p grimoire-core -i tokio` matches no package).
- **One list gives both hooks their old call order**: `mirror::watch::observers` is wake, change
  mask, mirror mask. A row is heard by the change mask and then the mirror's; a commit by the wake
  and then the change mask's bell. `hooks`' tests pin that list order is call order.
- `mirror::watch::install_hook` and `install_hook_with_changes` are that installer under their
  old names, on a bare connection, **and exist in test builds only now** — called on the app's
  write connection, either would replace the hooks `State::new` installed. Of their 24 call
  sites, the desktop's and seven fixtures' became `State::new`; the 16 left — 15 of `watch`'s
  own tests and one of `changes`' — assert what they asserted.
- **The fence is ahead of every observer.** Pinned on the commit hook; on the update hook the
  bits a row leaves are private, so no observer can ask and no test can tell.
- The hook's two blind spots are pinned where it is installed now: a `WITHOUT ROWID` write and a
  bare `DELETE` on a table nothing points at each reach `committed` and never `row`.

**`AppState` wraps the core's `State` and derefs to it.** `AppState` is named 480 times in 73
files and `state.db` 79 times in 16 (`git grep` at `2531db8a`); none was edited. What was: the nine places that build one
(`desktop::init_state` and eight test fixtures), and the five that passed `&state.db_read` as a
mutex, which ask `state.reader()`.

**The hook goes on when the state is built.** `State::new` installs it before the write
connection is behind its mutex, so no host holds a state whose fence is not riding. On the
desktop that moves the install from `start` to the end of `init_state`, still after
`prepare_database`. One write sat between the two — `mirror::settings::ensure_installation`,
which mints the mirror's name ahead of the hook on purpose — and it moved with it, to just above
`State::new`.

**One connection in a Worker is the shape, and `State` allows it.** Issue #761 gave this step
the question; spec §6 had measured that `opfs-sahpool` permits one connection. `State`'s read
connection is optional, and `reader()` answers the write connection where there is no other.
`lock_db_read` keeps its 111 callers. Tested natively both ways — and the two-connection test
asserts the hooks are on the connection that *writes*, since with two in hand there is a wrong
one, and a state hooked on its reader looks healthy for ever. **No browser has run either.**

**No test was lost.** `#[test]` and `#[tokio::test]` attributes: 3 366 before, 3 382 after —
2 810 in `src-tauri`, unchanged, and 556 → 572 in the core. The sixteen are this step's own:
nine of the installer's and its measurement, two of the sink's, four of the state's.
`cargo test --workspace`: `src-tauri` 2 806 passed and 4 ignored, as before. A reviewer ran
sixteen mutations of the three new files against them; the two that survived are closed — the
hooks installed on the read connection, and an observer told ahead of the fence on a commit.

**What the observer list costs per row** — the one thing the installer added to a hook that
called its riders directly. A **release** build of the core alone, one `UPDATE` over 100 000
rows, the best of nine rounds, six runs:

| | ns per row |
| --- | --- |
| No observer | 72.9 – 74.0 |
| Three observers, each one atomic add | 76.9 – 77.9 |
| The difference | **+2.9 to +4.4** |

About 0.4 ms per hundred thousand rows, against an ingest measured in tens of seconds. It is an
upper bound on the list: the three riders did their atomic work before this too.
`cargo test -p grimoire-core --release -- --ignored --nocapture what_three_observers` re-takes it.

**It compiles for WASM** with the hook installer in it — 20 s, `clippy -- -D warnings` clean —
and `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` still prints
`default` and nothing else.

**The real window**, `tauri dev` over a copy of the main checkout's two databases (user schema
v46, so the launch climbed thirteen rungs; in no sync group, mirroring to its own folder):

| Asked or done | Answer |
| --- | --- |
| `startup_status` | `ready` |
| The copy after the launch | `user_version` 59, 33 tables, `backups/user.v46.db` written; 5 decks, 699 deck cards, 277 collection entries, 89 wishes, as before it |
| `search_cards`, `lightning bolt` | 78 printings, 6–10 ms warm |
| The mirror's startup pass | 128 files written, none failed |
| **A deck created** | A pass 2 323 ms later: 15 files written, 113 unchanged — seven under `Decks/`, seven under `Collection/` |
| **Renamed in one window, a second window listening** | The second heard `db:changed` naming `collection_folders`, `deck_audit`, `deck_undo` and `decks`; the mirror wrote 15 and pruned 16 |
| Deleted | The mirror pruned its 16 |
| **The launch's own card sync, left to finish** | 118 610 → 118 467 printings, 0 skipped, no error — every row through the observer list |
| `error_log`; the app's stderr | The two rows it arrived with; no fence sentence, no panic |

That is the mirror's observer and the change mask's driven end to end. **The third was not**:
the copy is in no sync group, so live sync stays off, and what holds the wake is
`watch`'s `a_commit_leaves_a_permit_on_the_write_wake`, through the delegate.

**Open after step 3:**

- **`with_write` waits for step 4**, with `collection_source::with_write_owned` behind it.
- **`EventSink` has no caller.** The desktop's implementation — `desktop::WindowEvents`, three
  lines over `app.emit` — has never run. Its first caller is step 5's `run_sync`.
- **A `State` with one connection has never run in a browser.** There `reader()` is the write
  connection's own mutex, so a read asked for while the same thread holds the write connection
  is a lock taken twice. The desktop's two connections never notice; phase 5 has to look.
- **`State::new` takes connections that are already at head.** A host-neutral "open the data
  folder" needs the launch's logged passes, which are `src-tauri`'s until step 4.
- **Seven of the eight fixtures now hook the state's own change mask**, where they used to hand
  the hook a throwaway (`watch`'s `state_at` never hooked its connection and passes no
  observers). Nothing reads it there; it is what the app does.
- **`init_state`'s wiring is proven by the live pass and by nothing else.** It builds the mask
  and the change mask, hands clones to `observers(…)` and moves them into `AppState`; given a
  different `Arc`, both suites would still pass. No test reads a fixture's `state.mirror` or
  `state.changes` after a hooked write.
- **`EventSink` and `WriteObserver` are `Send + Sync`**, so a browser's sink cannot hold a
  `JsValue`. Phase 5 meets that first.
- `scripts/coverage-rust.mjs` was not run, and neither was the card-scanner suite locally.

### 6.4 Step 4 — the domain cluster (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-4-domain.md). Everything below was
measured that day on Windows 11, debug builds, on the branch's own tree over `main` at `28258b21`.

**Forty-nine modules moved in one run of a script, and most of the engine is in the core now.**
`src-tauri/src` went from 183 533 lines to 77 880, and `crates/grimoire-core/src` from 38 223 to
144 519 — 105 386 of them the forty-nine: the decks (`deck`, `deck_meta`, `deck_tokens`,
`deck_undo`, `deck_theory` and eleven more), the collection (`collection`, `collection_folders`,
`collection_alloc`, `collection_source`), the wishlist (`wishlist`, `wishlist_folders`,
`wishlist_optimize`, `managed_wishlist`), `search`, `card`, `import`, `bulk_undo`, `activity`,
the home page's reads, the view-state modules, `maintenance`, `reset`, and the sync engine's
`apply` and `baseline`.

**It was read before it was moved.** `scripts/lib/rs-items.mjs` cuts a rustfmt-formatted file into
its top-level items by tracking comments, literals and bracket depth, and every item of every file
in `src-tauri/src` was read for what it names. Two things came out of that:

- **What holds a domain file in `src-tauri` is one block at its foot** — the `#[tauri::command]`
  wrappers, the `use crate::sync::{with_write, AppState}` line above them, an
  `unfinished(e: tauri::Error)` helper in eight files, and the inner `mod commands` four files
  register from. No item that moves names an item that stays, in any of the forty-nine.
- **The cluster is closed only as a whole.** Eighteen of the forty-nine name none of the others
  — the view-state modules and a few reads. The other thirty-one are one knot: `deck` names
  twelve of them, and each of those names `deck` or one another. That is the first web build's
  "no leaf modules", measured.

**The wrappers stayed at each module's own path, not in a `commands/` folder.** Spec §2.3 wrote
the folder. Read against the tree, 245 of `generate_handler!`'s 257 entries are a path through a
module (`deck::deck_create`, `deck_pull::commands::deck_pull_plan`), and
`collection_source::with_write_owned` — which stays, because it names the index — is called from
wrappers in 14 files. Markus was shown both layouts and chose this one:
`src-tauri/src/deck/mod.rs` is `pub use grimoire_core::deck::*;` and deck's wrappers below it,
step 2's `schema/mod.rs` shape. **No handler entry, no caller and no test path was edited.**

| | |
| --- | --- |
| Modules that left a file behind | 46, holding 183 of the 257 commands in 5 783 lines |
| Modules that moved whole | 3 — `managed_wishlist`, `sync_engine::apply`, `sync_engine::baseline` |
| Commands in the core | 0 |

**Nothing was hoisted, so three things on this step's list wait for step 5.** Each names code
the I/O step moves:

| | Names | So |
| --- | --- | --- |
| `reconcile` | `scryfall::Migration`, the type its `apply` takes | waits whole |
| `tags::query`, `tags::muted` | `tags::Dataset` and its two constants, in the fetch engine | `tags/` waits whole |
| `deck::bracket_reads` | `combos::match_combos` — `combos` is a feed, with `reqwest` in its error type | `deck` arrived without it |

The alternative was to move those three small pieces into the core ahead of their modules.
Markus declined it, as he had in step 2 for the sync client's cursor keys. Nothing else in the
cluster calls `reconcile` or the tag queries.

**What else stayed, by the rule that a function naming a later step's code stays alone**:
`collection_source::with_write_owned` (the facet index's lifecycle), `reset::clear_cache` and
what only it calls (`images::Cache`, the three feeds), and — for good —
`marketplace::set_marketplace_now` (it tells the mirror), `import::read_import_file` (a path the
desktop's own file dialog answered: a host reads its own file) and `schema::prepare_data_dir`
(`split`). `share/` was never on this step's list.

**`with_write` is the core's.** `state::with_write`, `with_write_waiting` and the private
`written` they share moved out of `sync.rs` byte for byte but for one word — the parameter is
`&State` where it was `&AppState`. `sync` re-exports the two, and a wrapper holding an
`Arc<AppState>` passes `&state` as before, through the `Deref` step 3 added. `sync`'s two tests
of them stayed where they were and pass unedited, which is the same body called through the
re-export.

**`prepare_database` went home, and ten tests with it.** It rejoined `bring_to_head` in the
core's `schema.rs`, directly below it. Of the tests step 2 left in `src-tauri` because they named
a module still there, nine of `schema`'s seventeen and one of `capture`'s three name nothing
`src-tauri` holds any more and joined their file's own `mod tests`. The eight of `schema`'s that
remain drive `split`, or the tag search; the two of `capture`'s drive `reconcile`.
`maintenance::K_FTS_REBUILD_PENDING`, parked in `sync_meta` since step 2, is `maintenance`'s
again.

**Thirty-two of the cluster's 1 684 tests stayed**, each because it names something that did —
and for nine of them that something is `split`, which stays for good:

| Module | Stayed | Names |
| --- | --- | --- |
| `maintenance` | 9 | a database `split` converted |
| `reset` | 8 | `clear_cache` |
| `deck` | 5 | `bracket_reads` |
| `import` | 5 | `read_import_file` |
| `deck_tokens` | 2 | `index::fixtures`, `sync_engine::client` |
| `card`, `collection`, `search` | 1 each | `images::resolve`; `index::fixtures`; an `AppState` built whole |

A helper both sides call became a fixture — a `pub mod fixtures` at the foot of the core file,
behind `any(test, feature = "testing")` — in six modules: `card`, `collection`, `deck`,
`deck_tokens`, `maintenance`, `reset`. A helper only the staying tests call went with them.

**No test was lost.** `#[test]` and `#[tokio::test]` attributes: 3 382 before (2 810 in
`src-tauri`, 572 in the core) and 3 382 after (1 148 and 2 234). `cargo test --workspace` on the
final tree: the core 2 232 passed and 2 ignored, `src-tauri` 1 144 passed and 4 ignored. It
passed on the script's first complete output too, and on every run between.

**Three bodies were edited rather than moved**, each an exact replacement the script refuses to
make if its text is not there:

- `maintenance::reclaim_freed_pages` slept between chunks with `std::thread::sleep`, which panics
  in a browser. It asks `platform::pause`, which is that call natively.
- `bulk_undo::with_store` switched on `cfg(test)` between a process-wide ticket store and a
  per-thread one. A dependency's `cfg(test)` is off while another crate's tests build, so both
  arms follow `any(test, feature = "testing")` — the second thing behind that feature that is
  behaviour rather than scaffolding, after `image_uri`'s loopback allowance.
- Four paths: `crate::sync::{get_meta, set_meta, set_meta_opt}` are `crate::sync_meta`'s,
  `crate::sync::with_write` is `crate::state`'s, `crate::sync::lock_plain` is `crate::db`'s and
  `crate::schema::tests` is `crate::schema::fixtures`. In code only: a doc link was left as it
  stood.

**Fourteen names were widened to `pub`**, because `src-tauri` still reaches them: `bulk_undo`'s
`Table`, `Store`, `Store::table_of` and both `with_store` arms; `card::card_image_uri_inner`;
`collection`'s `commit_import`, `commit_import_with` and `fold_entry`; `collection_folders`'
`LOCKED_FOLDER_IDS` and `effectively_locked`; `deck::THEORY` (for a staying test);
`deck_undo::apply_reversal`; `import::decode`; `wishlist::commit_import`. Two of those the sweep
cannot see and are on a list in the script: a wrapper asks `with_store(|s| s.table_of(id))`, and
a closure parameter never spells its type.

- ⚠️ **The first version of that sweep published nine things nothing reaches, and the compiler
  said nothing** — a reviewer diffing visibilities against the base found them. It matched a
  member by `.name` anywhere in `src-tauri`, so `.name`, `.id` and `.record(` on unrelated types
  made fields of four private structs `pub`, and a wrapper's *parameter* called `category_name`
  made a function of that name `pub`. A member is widened now only where its type is named by
  this module's path, and a function only by a call. **Too wide is silent and too narrow is a
  compile error**, so the sweep leans narrow.

**The script**, `scripts/core-step-4.mjs`: 49 modules in one run, `cargo fmt` at the end, and a
second run changes nothing — a module whose file is gone from `src-tauri/src` is skipped and
each one-off step checks whether it has been done. `--dry` prints what would stay, move and widen
without writing. The splitter rejoins every Rust file in both crates byte for byte, which
`scripts/lib/rs-items.test.mjs` holds on every run. Git records 51 renames.

- **It was right about the cut on its first run and wrong about three smaller things**, each
  found by the compiler and fixed in the script rather than in its output: a constant used only
  inside a format string (`"{GRAIN}"`) is a reference the literal hides; a fully qualified
  `std::sync::Mutex::new(…)` uses no import; and a re-export is the module's API, which the
  remainder's glob already carries.
- ⚠️ **`git mv` stages.** A `git commit` of the script alone, made after a run, committed the
  fifty-one renames with their old contents, and the reset that followed threw the run away.
  Commit the script with the tree clean, or by path.
- **A reviewer replayed it**: the script at its own commit, run on an extract of that commit and
  put through `rustfmt`, reproduces the output commit's files byte for byte. And item by item,
  the 4 177 non-`use` items of the forty-nine modules, `schema`, `capture` and `sync` each appear
  exactly once after the move — 4 170 unchanged but for whitespace, visibility and the four
  paths, the other seven the edits this section names.
- **What the splitter gets wrong is written into its test**: a brace in an item's head — the
  const argument in `impl Foo<{ N }> for X` — ends the item early. The pieces still rejoin, and
  neither crate has one.
- **A branch that edited a moved file runs the script before it merges `main`** — the plan has
  the four commands — and one that did not just merges: git follows the renames. **Driven on a
  scratch branch** with an edit to a core item, an edit to a wrapper's helper, a new test and a
  new command: the merge reported seven conflicts. Three were the branch's own changes, one hunk
  each, where its side is the answer. Four were in files the branch never touched — the ones
  edited by hand on `main` after the script (`lib.rs`, `maintenance.rs`, `state.rs`,
  `schema/mod.rs`) — where `main`'s side is. The core item's edit and the new test merged clean.

**It compiles for WASM with the domain in it.** `cargo build --lib -p grimoire-core --target
wasm32-unknown-unknown`: 30 s, and `clippy -- -D warnings` for that target clean. The core gained
**no dependency**: 105 386 lines of decks, collection and search needed nothing the storage layer
had not already brought. `cargo tree -p grimoire-core -i tokio` and `-i tauri` each match no
package, and `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints
`default` and nothing else. Outside `platform/` and the test-only `scratch`, the crate's non-test
code names a filesystem in the five `schema` functions step 2 left for the I/O step and nowhere
else, and names no thread. **Compiles is still all that proves**; the Android compile is CI's.

**An existing database, upgraded by this build and by `main`, side by side.** Two byte copies of
the main checkout's dev data — user schema v46, 30 tables, 4 645 rows — one launched under a
binary built from `main` and one under this branch's, each stopped 20 s after its `user_version`
read 59:

| | `main` | this branch |
| --- | --- | --- |
| `user_version` reached 59 after | 1 369 ms | 1 172 ms |
| Tables / rows / schema objects | 33 / 5 209 / 148 | 33 / 5 209 / 148 |
| The whole of `sqlite_master` | — | identical |
| `foreign_key_check`, `integrity_check` | 0, `ok` | 0, `ok` |
| `backups/user.v46.db` | written | written, and equal to the file before the climb row for row |

Compared row by row, 30 of the 33 tables are identical. The three that differ, differ in a clock
and a random number: two `app_meta` values (`mirror_installation`, minted per install, and
`update_last_check_at`) and three `unixepoch()` stamps on the token rows the launch conversion
wrote — 33 s apart, the gap between the two launches. That is the launch's logged passes run
from their new crate and writing what `main`'s wrote.

⚠️ **The control build poisoned the branch's, and only `cmp` showed it.** The control was built
from a scratch worktree into this worktree's `target`. Cargo then reused `main`'s `grimoire-core`
for this branch's — the same package name and version, built later than this branch's sources
were last touched — and `cargo build` failed with 61 unresolved imports that `clippy` and
`cargo test`, which build other units, had not. The first "branch" binary copied out was
`main`'s, byte for byte. `touch` both `lib.rs` files after a control build, and `cmp` the two
binaries before trusting either.

**The real window, on this branch**, `tauri dev` over a third copy (v46, so the launch climbed
thirteen rungs; in no sync group, mirroring to its own folder):

| Asked or done | Answer |
| --- | --- |
| `startup_status` | `ready` |
| `search_cards`, `lightning bolt` | 78 printings, 11 ms |
| `facet_cards`, `bolt` | `ready: true`, 23 formats |
| `deck_list`; `collection_list`; `collection_folder_list`; `wishlist_list` | 5 decks; 277 entries; 7 folders; 87 wishes |
| The mirror's startup pass | 128 files written, none failed |
| **A deck created, two cards added, renamed** | Each landed, through the wrappers and the core's `with_write`; `deck_get` read 2 cards in 5 piles |
| `deck_bracket_reads` on it — the function that stayed | 2 cards, no combos |
| **A collection entry added, removed by `collection_remove_many`, then `bulk_undo`** | `removed: 1, copies: 2, undoId: 1`, then `restored: 1` and the entry back at 2 — the process-wide ticket store, in a build without `testing` |
| A wish added and removed; a sticky note made and deleted | 87 wishes and no notes, as before |
| The mirror after those writes | A pass: 15 files written, 127 unchanged |
| The deck deleted | 5 decks |
| **The launch's own card sync, left to finish** | 118 610 → 118 467 printings, 0 skipped, no error — through the ingest, `swap_staging`, `price_history::snapshot` and `maintenance::reclaim_freed_pages`, the last two from their new crate; the facet index `ready` again after it |
| Search, Collection, Wishlist, Decks and a deck — pressed and read | Each drew: 118,467 cards; 340 cards / 273 unique; 89 wishes; 5 decks; a 100+3 card deck with its stats and `Bracket ~4` |
| `error_log`; the app's stderr | The two rows it arrived with; no fence sentence, no panic |

The copy afterwards: `user_version` 59, 33 tables, 5 decks, 699 deck cards, 277 collection
entries, 89 wishes, `foreign_key_check` 0, `integrity_check` `ok`.

**The frontend**: `ipc.test.ts` reads each split module as both halves, joined under the name
its assertions already used, and passes unedited below its imports; `npm run test:run`, 459
files and 12 904 tests with `main` at `7e397710` merged in; `npm run build` and `npm run lint` clean.

**Nothing in [data-and-sync.md](data-and-sync.md) or [search-faceting.md](search-faceting.md)
was re-taken, and this is the step that could have moved a release figure most.** A debug build
inlines nothing before or after. A release build has no LTO and inlines a non-generic function
across crates only when it says so — and the wrappers now call every domain function across a
crate boundary, where they called it across a file. Each such call is one per command, around a
statement that runs for milliseconds; what moved *together* — `search` with `filters` and
`sorting`, `deck` with `deck_undo` — is in one crate as it was. The rows above are a debug build
answering, not a timing.

**Open after step 4:**

- **`reconcile`, `tags/` and `deck::bracket_reads` wait for step 5**, with
  `collection_source::with_write_owned` and `reset::clear_cache` behind them, and the cluster's
  tests that name `images`, `index` or the sync client.
- **A module's own `//!` doc may say its wrappers are "at the foot".** The docs moved unedited;
  the wrappers are at the foot of `src-tauri`'s file of that name.
- **`State::new` still takes connections already at head.** `schema::prepare_database` is the
  whole launch and is the core's now, but the desktop converts a single file first with a module
  only it has. What a host-neutral "open the data folder" should be is left to the first host
  that is not the desktop.
- **A new user rung still owes its `UNDO_V<N>` in two files**: one chain is left in
  `src-tauri/src/schema/mod.rs`, in a test that is `#[ignore]`d.
- **The `testing` feature now gates two behaviours**, not one: a host that turned it on would
  accept a loopback image host *and* keep its bulk-undo tickets per thread, where a command and
  the write it undoes run on different ones.
- **The one-connection `State` is likelier to bite now.** `with_write` holds the write
  connection while a caller's closure runs; on a host with one connection, a closure that asked
  for `lock_db_read` would take a lock its own thread holds. No wrapper does — a write closure is
  handed the connection — but nothing checks it. Phase 5's.
- `scripts/coverage-rust.mjs` was not run, and neither was the card-scanner suite locally:
  nothing under `crates/card-scanner` changed, and CI's `rust` job runs it.

### 6.5 Step 5, first part — `platform`'s request, timer and files, and the Scryfall client over them (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-5-io.md). Everything below was
measured that day on Windows 11, debug builds, on the branch's own tree over `main` at `52c9513a`.

**This is the first step that changes code rather than moving it**, which is why it is three
pull requests where step 4 was one script. The engine's remaining modules each reach a network or
a disk, and a browser has neither a socket nor a filesystem — so before a module can move, what
it calls has to exist twice. Markus took three decisions first: `reqwest` on both arms, three
parts, and auto-merge with auto-fix on each.

**Three interfaces joined the clock and the pause under `crates/grimoire-core/src/platform/`:**

| | Native | Browser | Lines |
| --- | --- | --- | --- |
| `http` — `Client`, `Request`, `Response`, `Body`, `Error` | `reqwest` over rustls, a connect bound and a per-read bound | `reqwest` over `fetch`: no timeouts to set, `is_connect()` always `false` | 178 |
| `timer` — `sleep`, `timeout` | `tokio::time` | a `Promise` around the global `setTimeout` | 106 |
| `files` — seven plain functions, and `files::aio` for an `async fn` | `std::fs`; `tokio::fs` | refused: `ErrorKind::Unsupported` | 367 |

`http` is one implementation with three lines that differ, because `reqwest`'s own wasm backend
*is* `fetch`. It carries `GET` and nothing else — the first `POST` is the sync client's. `files`
refuses in a browser rather than pretending: the database there is OPFS behind SQLite's VFS, and
a download with no temp file is a shape the web host decides.

**Three modules moved onto them, and two leftovers came home.**

| | Lines | Tests | What changed in it |
| --- | --- | --- | --- |
| `scryfall` | 1 823 | 29 | every `reqwest`, `tokio` and `std::fs` call, the pacing gate, both clock reads |
| `ingest` | 1 134 | 14, and 1 that stays | one line: the file is opened through `platform::files` |
| `reconcile` | 2 061 | 29 | nothing but a test's import |
| `errors::kind_of` | — | 1 | nothing; `src-tauri/src/errors/mod.rs` is gone |
| `capture`'s two reconcile tests | — | 2 | nothing; `capture_tests.rs` is gone |

`crates/grimoire-core/src` went from 144 519 lines to 150 538 and `src-tauri/src` from 77 880 to
72 769. `schema`'s eleven file calls — the corpus it replaces, the backup before a climb, the
damage mark — go through `platform::files` too, so nothing the crate ships names `std::fs`.

**Four things that are not a move:**

- **The pacing gate lost its runtime.** It was `tokio::sync::Mutex<tokio::time::Instant>` and
  slept *until* the stored instant. It is `futures_util::lock::Mutex<(Tick, Duration)>` — when
  the last request claimed its slot, and the gap its endpoint asks for — and sleeps for what is
  left of that gap. The lock is still held across the sleep, which is what makes concurrent
  callers a queue. `requests_are_paced_to_the_published_rate` moved unedited but for its clock.
- **The engine's version became the app's.** `USER_AGENT` is built from
  `env!("CARGO_PKG_VERSION")`, which reads the package that compiles it — moved as it stood,
  every request the app makes would have announced `MTGGrimoire/0.0.0`. The core's manifest
  carries 0.39.0, release-please bumps both, and `desktop.rs`'s
  `the_core_wears_the_apps_version` goes red if they part. The router sends
  `release-please-config.json` to `rust` and `frontend`, since a Rust test reads it now.
- **The tag datasets' names changed hands.** `scryfall::BULK_ORACLE_TAGS` aliased
  `tags::oracle::BULK_NAME`; `tags` is still the desktop's, so the string lives in `scryfall`
  and `tags` aliases it. One definition either way.
- **The fence has a fifth rule**: `reqwest`, `tokio`, and `std`'s `fs`, `thread`, `net`,
  `process` and `env` are refused outside `src/platform/` in what the crate ships, as is a
  disk asked through a path (`.exists()`, `.is_file()`). It reads above a file's first column-0
  `#[cfg(test)]` **that gates a module** — a test of a download has to write a file — and
  derives the two files that are tests throughout from the gate on their `mod` line.

**What was checked.**

| | |
| --- | --- |
| `#[test]` and `#[tokio::test]` attributes | 3 382 before, 3 390 after: 75 moved from `src-tauri` to the core, 8 are new (2 files, 2 timer, 3 fence, 1 version) |
| `cargo test --workspace` | core 2 314 passed and 2 ignored; desktop 1 070 passed and 4 ignored |
| `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check -p mtg-grimoire --locked` | clean |
| `cargo build` and `clippy --lib -p grimoire-core --target wasm32-unknown-unknown` | clean — after clippy refused `drop(file)` on a writer that is a unit struct in a browser (`drop_non_drop`), which no desktop build can see. Hence `Writer::close` |
| `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` | `default`, and no `testing` |
| `Cargo.lock` | 653 packages before and after: seven new edges from `grimoire-core`, no new crate |
| `npm run build`, `npm run lint`, `npm run test:run` | clean; 459 files, 12 905 tests |

**An existing database, upgraded by `main`'s binary and by this branch's.** Two byte copies of
the main checkout's dev data (user schema v46, 4 645 rows, corpus schema 6), one launched under
each binary with no dev server behind it, each left running twenty seconds:

| | `main` | This branch |
| --- | --- | --- |
| `user_version` reached | 59, after 1 319 ms | 59, after 1 158 ms |
| Schema objects, tables, rows | 148, 33, 5 209 | 148, 33, 5 209 |
| `foreign_key_check`, `integrity_check` | 0, `ok` | 0, `ok` |
| `backups/user.v46.db` — written by `schema`'s moved file calls | 2 007 040 bytes | **byte-identical** |
| The four files each launch downloaded | 78 689 871, 5 977 157, 12 973 147 and 28 824 447 bytes | **byte-identical, all four** |

30 of the 33 tables are identical row for row. The other three differ in what two honest
launches always differ in: `app_meta.update_last_check_at` and `mirror_installation` (a clock and
a random name), and the `unixepoch()` stamps on three rows the token conversion writes.

**A real card sync, interrupted and resumed.** The branch's binary over a copy with `corpus.db`
deleted — the documented way to force a resync:

| | |
| --- | --- |
| Run 1, stopped 1 135 ms in | a partial of 15 149 632 bytes, and beside it an origin record naming `default-cards-20261002090546.jsonl.gz` |
| Run 2 | the file never measured below 15 149 632, grew to 78 689 871, and its record was gone 1 342 ms after launch — a `Range` resume through `files::aio::Writer::append`, not a restart |
| The ingest over the spliced file | 118 467 cards, 0 skipped, 93 s after launch. A gzip member checks its own CRC, so a wrong splice fails here |
| The rest of the sync | 1 053 sets, 2 806 migration rows applied by `reconcile`, no row flagged for review, no new `error_log` row |

**Then the window**, `tauri dev` over that copy, driven over CDP:

| | |
| --- | --- |
| `startup_status`; `sync_status` | `ready`; 118 467 cards, no error |
| Four forced `sync_run`s back to back | each `updated: false` — the conditional check through the core's client and its gate; `last_check_at` advanced |
| The feeds, which share Scryfall's client for their check and download | Oracle tags 4 560 over 235 017 taggings; art tags 11 611 over 492 668; 111 410 combos |
| Search, pressed | "118,467 cards", 30 of 30 images loaded from `mtgimg://`, none broken |
| The image cache | 211 files, 15.5 MB, from empty — each a `fetch_image` under `timer::timeout` |
| `error_log`; the app's stderr | the two rows it arrived with; nothing |

**What a fresh reviewer found**, reading the commit against `main` item by item with no cargo:
no behaviour change on the desktop — every request, status arm, file call and error string
compared equal — and four things that were wrong anyway.

- **The fifth rule was not reading about 3 500 shipped lines.** It cut at a file's first
  column-0 `#[cfg(test)]`, and four files in the core carry one far above their tests: a
  test-only `use` at `wishlist.rs:22`, a `thread_local!` in `sync_engine/apply.rs`, a helper in
  `bulk_undo.rs`, a constant in `apply/rehome.rs`. Everything below each was unread. The cut is
  a gate over a *module* now, and the rule's own tests carry both shapes.
- **`scripts/coverage-rust.mjs` made the same cut, and had since it was written** — eleven files
  across both crates, the whole of `wishlist.rs` among them, counted as test code. Fixed the
  same way; the figure below is from after it.
- **An assertion that depended on the order a directory is read in.** By name on NTFS, by
  nothing in particular on the ext4 that CI's Linux leg runs. The derived list is sorted.
- **Shapes the rule walked past**: `pub(crate) use std::{fs, io}`, a glob over `std`,
  `path.is_file()`, `std::net`, `std::process`, `std::env::temp_dir()`. All refused now; the
  crate was clean under every one of them.

**Open after this part:**

- **No browser arm has run.** `http`, `timer` and `files` compile for `wasm32` and are linted
  there; the first thing to call one is phase 5's Worker. (**All three have since, on 2026-10-04**:
  the refusing `files` in step 5.1 (§9.1), and `http` and `timer` in step 5.2, when the web
  host first started a download — §9.2 has the requests a browser made.)
- **CORS is unmeasured, and it decides whether the browser arm of the client works at all.** A
  request from a Worker is cross-origin: `If-None-Match` and `Range` cost a pre-flight, and
  `ETag`, `Retry-After` and `Content-Range` read as absent unless the host exposes them — in
  which case a bulk check stores no ETag, every 429 falls to thirty seconds and a resume is
  refused. Which of those `api.scryfall.com`, `data.scryfall.io` and `cards.scryfall.io` expose
  is the first thing phase 5 measures, against the real hosts. (**Measured 2026-10-04, with
  `curl` — §9.1's CORS table.** None of the three exposes any of them.)
- **A browser's `Tick` is the wall clock**, in whole milliseconds, so a clock stepped forwards
  opens the pacing gate early there. `performance.now()` is monotonic and a Worker has it; the
  web host should give `platform::clock` that arm before it paces a request. (**Closed in step
  5.2, 2026-10-04**: a browser's `Tick` is `performance.now()`, read off the Worker's global
  scope and counted in whole microseconds, with the wall clock as the fallback for a host that
  has no `performance` object — §9.2.)
- **`futures_util`'s mutex is not FIFO-fair** where tokio's was. The gate promises spacing, not
  order, and one request is in flight at a time in this app — but a caller that needed the order
  would not get it.
- **A download in a browser is unanswered.** `Client::download` writes a temp file and
  `ingest_gz` reads one; `StreamIngest` already takes chunks, so the web host can feed it a body
  directly. That is its decision. (**Answered in step 5.2**: `platform::host` says whether a
  host keeps files, and each download streams into its sink where it does not — §9.2.)
- **The fence's fifth rule does not read below a file's tests.** Code there that is not a test
  would be missed; every file keeps its tests and fixtures at the foot and nothing else.
- **`sync::run_sync`, which drives all three moved modules, is still the desktop's**, as are the
  facet index's lifecycle, the feeds and the image cache — the step's second and third parts.
  `State` gains no field here: `scryfall::Client` is the core's type, held by `AppState`.
- **`npm run test:coverage:rust` ran for the first time since it was rewritten for two workspace
  members**, and works: one `cargo llvm-cov --workspace` run, 93.77% of 105 876 lines with the
  test modules in and **82.93% of 35 234 shipped lines** with them out — 82.20% of 31 399 before
  the script's cut was fixed (above), which is 3 835 shipped lines it had been calling tests.
  The moved client scores
  96.36% of its 357 shipped lines, `ingest` 97.86%, `reconcile` 90.35%, `platform::files` 97.17%
  and `platform::http` 76.92%: the twelve lines it misses are `Error`'s three predicates, which run
  only when a request fails in transit — and no test makes one do that, before the move or
  after. Every `<module>/mod.rs` of command wrappers reads 0%: a wrapper needs a window. **README.md and [test-coverage.md](test-coverage.md) still quote 77.45% of
  7 503 lines**, a run from before most of the app existed; only the sentence about the cut
  was edited there. The run
  installed rustup's `llvm-tools-preview` component for the pinned toolchain, which the script
  needs and this machine did not have.
- The card-scanner suite was not run locally: nothing under `crates/card-scanner` changed, and
  CI's `rust` job runs it.

### 6.6 Step 5, second part — the state's last three fields, the facet index and the card sync (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-5-io.md), Part 5b. Measured that
day on Windows 11, debug builds, on the branch's own tree over `main` at `4b0bb2d3`.

**The card sync took a window, and that was the whole of what kept it in `src-tauri`.** Of
`sync.rs`'s 51 items, seven name the desktop and mean it — `AppState`, its `Deref`, four lock
helpers and `status`. Nine more took a `tauri::AppHandle` for one purpose: to emit. So this part
is a move with a small, regular rewrite inside it — a window becomes the state's event sink, an
`Arc<AppState>` becomes an `Arc<State>`, and tauri's blocking pool becomes `platform::spawn`.

| | Before, in `src-tauri` | Now, in the core | What stayed |
| --- | --- | --- | --- |
| `sync.rs` | 1 899 lines | 1 472, and `sync/run_tests.rs`, 391 | `sync/mod.rs`, 448: `AppState`, the lock helpers, `status`, five tests |
| `index/mod.rs` | 1 097 | 1 068 | 14: the re-export and `pub mod facets;` |
| `index/facets.rs` | 2 805 | 2 783 | `index/facets/mod.rs`, 31: the `facet_cards` command |
| `index/lifecycle.rs` | 537 | 541 | nothing |
| `collection_source`'s `with_write_owned` | its own file | in the core's `collection_source` | nothing; the desktop's file is gone |

`crates/grimoire-core/src` went from 150 538 lines to 157 318 and `src-tauri/src` from 72 769 to
66 801. One more interface joined `platform/` — `spawn`, 211 lines: `blocking(f).await` for
synchronous work under an `async fn`, and `background(f)` for work nobody waits for. Natively the
async runtime's blocking pool and a thread; **in a browser both run the work where it stands**,
because a Worker has one thread and deferring to a microtask would only move the block while
letting the caller think it had been taken off them.

**Five things that are not a move:**

- **`run_sync(state: Arc<State>, force)` — no window.** `sync:progress` and
  `collection:reconciled` leave through `state.events`, and the desktop's sink forwards both to
  every window, as `app.emit` did. Same names, same payloads — with one difference a page cannot
  see: a payload reaches the sink as a `serde_json::Value`, so its keys are in alphabetical
  order (`done, message, phase, total`) where the struct's own order was `phase, done, total,
  message`.
- **`State` holds `syncing`, `client` and `index`**, and `State::new` takes a sixth argument: the
  client, which the host builds. `AppState.core` is an `Arc<State>` — a sync and an index build
  each outlive the call that starts them — and `AppState` still derefs to it, so every
  `state.client` on the desktop reads as it did.
- **The mirror hears a swap as an observer.** `WriteObserver` gained `corpus_replaced`, defaulting
  to nothing; `State::corpus_replaced()` tells every observer once, and `do_sync` calls it where it
  called `note_mirror_after_swap`, which is gone. The alternative was an event name the desktop's
  sink intercepts — a mirror rule inside a function called "emit".
- **The core builds its own index fixture**, at head, through a new `schema::build_pair`
  (`memory_pair`'s second half, on connections somebody else opened). The desktop's — an
  `AppState` over a file `split` converted — went with its last caller.
- **`status` stayed, alone**: it reads the image cache's failure count, and the cache is the
  third part's. Nothing was hoisted to bring it.

**`run_sync` has a test of its own for the first time.** While it took a window nothing in the
suite could enter it — [text-mirror.md](text-mirror.md) carried that as an open item — so its
pieces were tested and the function was not. `sync/run_tests.rs` runs it whole against a local
mock Scryfall, with a sink that records and an observer that counts:

| Test | What it pins |
| --- | --- |
| `a_first_sync_ingests_and_says_so_and_the_next_one_finds_nothing_new` | the phases in order, ending `done` with its message; the cards stored; the facet index warm afterwards; **one** `corpus_replaced`; then a forced second run that is a 304, emits `checking` and `done`, and tells no observer; then an unforced third inside the throttle, which asks nothing and says nothing |
| `a_sync_that_repoints_a_copy_says_what_moved` | a migration row applied to an owned copy, and `collection:reconciled` emitted with its count |
| `a_sync_whose_download_is_refused_says_so_and_swaps_nothing` | an `error` phase carrying the sentence, `last_error` and an `error_log` row written, the flag given back, no `last_check_at` to throttle on, and no `corpus_replaced` |

**What was checked.**

| | |
| --- | --- |
| The move, item by item | of `sync.rs`'s 78 items and tests, 56 byte-identical and 21 changed — each one on the script's replacement list — and one gone |
| The script, re-run on a checkout from before the move | 13 files written and 4 removed, each identical to the tree's |
| `#[test]` and `#[tokio::test]` attributes | 3 390 before, 3 398 after: 94 moved from `src-tauri` to the core, 8 are new (4 `spawn`, 1 `state`, 3 `sync::run_tests`) |
| `cargo test --workspace` | core 2 414 passed and 4 ignored; desktop 978 passed and 2 ignored |
| `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check -p mtg-grimoire --locked` | clean |
| `cargo build` and `clippy --lib -p grimoire-core --target wasm32-unknown-unknown` | clean |
| `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` | no `testing` |
| `Cargo.lock` | 653 packages before and after |
| `npm run build`, `npm run lint`, `npm run test:run` | clean; 459 files, 12 916 tests |

**An existing database, upgraded by `main`'s binary and by this branch's** — the check §6.5
describes, on two fresh byte copies of the main checkout's dev data (user schema v46):

| | `main` | This branch |
| --- | --- | --- |
| `user_version` reached | 59, after 1 432 ms | 59, after 1 336 ms |
| Schema objects, tables, rows | 148, 33, 5 209 | 148, 33, 5 209 |
| `foreign_key_check`, `integrity_check` | 0, `ok` | 0, `ok` |
| `backups/user.v46.db` | 2 007 040 bytes | **byte-identical** |
| The four files each launch downloaded | 78 689 871, 5 977 157, 12 973 147 and 28 824 447 bytes | **byte-identical, all four** |

30 of the 33 tables are identical row for row; the other three differ in the same clock and the
same random name as before. **Both launches ran a card sync** — this branch's through the moved
`run_sync` — and the two downloads came out equal to the byte.

**Then the window**, `tauri dev` over a copy with `corpus.db` deleted, with a listener on
`sync:progress` installed in the page before the sync began:

| | |
| --- | --- |
| Events the page received | 120: `downloading` 56, `ingesting` 60 over 89 s, `reclaiming` 2, `sets` 1, `done` 1 with "118,467 cards" — every one carrying `done`, `message`, `phase` and `total` |
| The facet index | cold through the sync; ready on the first sample after `done` |
| A forced `sync_run` afterwards | `updated: false`, and two events: `checking`, `done` |
| An owned facet around a collection write | 273, 274 after one copy added, 273 after it was removed — `with_write_owned`, from the core |
| The mirror after the swap | one full pass 3 s after `done`, with nothing else writing: 58 files compared, none rewritten — `corpus_replaced` reaching the desktop's mask |
| Search, pressed | "118,467 cards", 30 of 30 images loaded |
| `sync_status`; the app's stderr | 118 467 cards, not syncing, no error; nothing |

**What a fresh reviewer found**, reading the diff against `main` with no cargo: no behaviour
change on the desktop, and six things worth fixing.

- **`spawn::blocking` started its work when first polled, not when called.** It was an
  `async fn` around tokio's `spawn_blocking`, which is eager. Every caller awaits at once, so
  nothing ran differently — but the interface promised less than what it replaced. It hands the
  work over at the call now, and a test holds that.
- **The desktop kept a fixture nothing called.** Every test that used the index's
  `state_with_seeded_cards` moved; the copy left behind compiled, passed clippy under
  `#[cfg(test)]`, and was dead.
- **The move script ran `git mv` and then reset the index.** A run that stopped between the two
  left a tree the script's own guard then called finished. It writes and removes files now, and
  git infers the renames at commit.
- **Nine comments the move made false** — `events.rs` saying nothing emits yet, `desktop.rs`
  explaining a constraint that no longer exists, `ipc.ts` naming two paths that moved.
- **A miscount**: five tests stayed in `sync/mod.rs`, not six — the sixth item is the fixture
  they share.
- **`run_sync` had no end-to-end test**, which is the table above.

**Open after this part:**

- **No browser arm has run**, `spawn`'s included. In a browser a panic inside `blocking` is a
  panic in the caller, not an `Err(Lost)`: there is no pool to catch it.
- **The index's build opens a second connection.** `lifecycle::build_now` calls `db::open_read`
  so a full pass over `cards` never holds the connection every search waits on. A browser's
  storage permits one (spec §6); the web host has to answer that, and nothing here does.
- **A browser's sync runs its ingest on the caller.** Ninety seconds of SQLite, in the Worker,
  with no message answered meanwhile. Whether that is acceptable, or the ingest has to yield, is
  phase 5's to measure.
- **`sync::status`, the three feeds and the image cache are still the desktop's** — the third
  part. `AppState` keeps `images` and `pairing` until then and until step 6.

### 6.7 Step 5, third part — the three feeds and the image cache (2026-10-02)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-5-io.md), Part 5c. Measured that
day on Windows 11, debug builds, on the branch's own tree over `main` at `bdd1b80e`.

**Every `refresh` already took its progress as a callback**, "for `ingest`'s reason", so the
window was named only by the two things that called one: a command, and the launch. That made
the feeds a move with the small rewrite 5b had made — a window becomes the state's event sink,
tauri's blocking pool becomes `platform::spawn::blocking` — plus each feed's client onto
`platform::http` and its temp file onto `platform::files`. **The image cache was the part that
was not regular**: the one module that reads a file's modified time, walks a directory tree,
renames into place and bounds its own concurrency.

| | Before, in `src-tauri` | Now, in the core | What stayed |
| --- | --- | --- | --- |
| `combos.rs` | 5 042 lines | 4 920 | `combos/mod.rs`, 159: five commands |
| `marketplace_feed.rs` | 2 182 | 2 235 | `marketplace_feed/mod.rs`, 58: two commands |
| `tags/mod.rs` | 2 255 | 2 278 | 18: the re-export and four `pub mod` lines |
| `tags/{oracle,art,query,muted}.rs` | 3 719 | 3 440 | four `mod.rs` files, 271: twelve commands |
| `images.rs` | 3 825 | 3 472 | `images/mod.rs`, 363: the `mtgimg://` answer, two commands, the upkeep thread, seven tests |
| `reset::clear_cache`, `deck::bracket_reads`, `sync::status` | in three `mod.rs` remainders | home | one of `reset`'s tests |

`crates/grimoire-core/src` went from 157 318 lines to 175 393 and `src-tauri/src` from 66 801
to 49 414. `scripts/core-step-5c.mjs` made the move: 30 files written, 8 removed, every
rewrite an exact replacement that has to match the number of times it says.

**`platform/` grew three things, each with its first caller:**

| | What | For |
| --- | --- | --- |
| `clock::Wall` | a wall-clock moment that can be stored and compared: whole milliseconds since the epoch, with `+` and `-` a `Duration` | the cache's used-stamp, which is a file's modified time |
| `files::{listing, set_modified, remove_dir}`, `aio::{read, create_dir_all, rename}` | a directory's entries with each one's kind, length and time; a stamp that never creates the file; an empty folder removed; a file read whole; a rename that replaces | the cache's store, its eviction walk, and the cache sweep |
| `sync::{Semaphore, Lock}` | a permit and a lock an `async fn` holds across an `.await`, first come first served — `tokio::sync` on every host, since it needs no runtime | the cache's sixteen fetches at once, and its one fetch per key |

**What is not a move:**

- **A feed says what it is doing through the sink.** `combos::emit`, `tags::emit` and a new
  `marketplace_feed::emit` — the last was one closure written out twice — and
  `refresh_if_due(&Arc<State>)` takes no window. Same four event names, same payload keys.
- **A finished price refresh tells the observers.** `state.mirror.mark_all()` became
  `state.corpus_replaced()`: `marketplace_prices` is a corpus table rewritten whole, and the
  mirror's mask is an observer. `WriteObserver::corpus_replaced` now means *a* corpus table was
  replaced, and does not say which.
- **`State` holds `images`**, and `State::new` takes a seventh argument: the cache, which the
  host builds. Seven is clippy's ceiling; the next thing a host hands the state wants a struct.
- **The cache's 429 deadline is a `Tick` and how long the penalty runs**, where it was a
  `tokio::time::Instant` moved forward. *The later of the two* is kept as *replace it only when
  the new penalty outlasts what is left*; `lockout_remaining` is the one read of it, and the
  fetch and the tests share it.
- **The eviction walk reads a listing.** Same files found, same files skipped, and the same
  rule that a walk which fails deletes nothing. An entry's name that is not Unicode is given
  lossily and its path exactly, so nothing is dropped for its name.
- **The upkeep pass is the core's and the thread is the host's.** `images::upkeep_tick` is one
  wake of the old loop, cut where it slept; `spawn_upkeep` stays in `src-tauri` as a thread that
  sleeps and calls it.
- **The cache sweep counts a directory it could not list.** `files::listing` is whole or an
  error, so one unreadable entry skips its directory where the old walk skipped the entry — and
  that directory is one `failed` now, where an unreadable one was skipped in silence.
- **Fixtures build a core `State` at head.** Every test that built an `AppState` over a file
  `split` converted now builds through `state::fixtures::on_files` and `schema::build_pair`. No
  assertion read the desktop's three observers or the capture triggers those fixtures also
  installed; the feeds' and `with_write`'s paths are no longer exercised with them riding.
- **One test stayed for a reason of its own**: `the_cache_sweep_unlinks_rather_than_follows`
  makes a symlink with a Windows call behind `#[cfg(windows)]`, and the core's fence keeps a
  platform gate out of every file but `platform/`'s, tests included. It drives the core's
  `clear_cache` from `src-tauri`.

**New tests**, ten: `Wall`'s arithmetic; a listing that tells a file from a folder and carries
a stamp that can be set; a rename that replaces; a freed permit going to whoever has waited
longest; a lock held by one at a time; **a whole price refresh** through a seam that takes the
feed's address (`refresh_from` — a provider's own address is the live host), telling its
observers once and a refused download telling nobody; **what each feed's `emit` hands the
sink**, by name and by key; and a lockout that runs out.

**What was checked.**

| | |
| --- | --- |
| The move, item by item | 728 items and tests across the fourteen files: 616 byte-identical but for whitespace, 110 changed — each on the script's replacement list — and 2 gone (`read_dir_if_present`, `sync::lock_conn`) |
| The script and the hand edits, re-run on a checkout from before the move | every file they write identical to the tree's |
| `#[test]` and `#[tokio::test]` attributes | 3 398 before, 3 408 after: 231 moved from `src-tauri` to the core, 10 new, none lost |
| `cargo test --workspace` | core 2 654 passed and 5 ignored; desktop 748 passed and 1 ignored |
| `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check -p mtg-grimoire --locked` | clean |
| `cargo build` and `clippy --lib -p grimoire-core --target wasm32-unknown-unknown` | clean |
| `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` | no `testing` |
| `Cargo.lock` | 653 packages before and after |
| `npm run build`, `npm run lint`, `npm run test:run` | clean; 459 files, 12 916 tests |

**An existing database, upgraded by `main`'s binary and by this branch's** — §6.5's check, on
two fresh byte copies of the main checkout's dev data (user schema v46, 4 645 rows):

| | `main` | This branch |
| --- | --- | --- |
| `user_version` reached | 59, after 1 350 ms | 59, after 1 169 ms |
| Schema objects, tables, rows | 148, 33, 5 209 | 148, 33, 5 209 |
| `foreign_key_check`, `integrity_check` | 0, `ok` | 0, `ok` |
| `backups/user.v46.db` | 2 007 040 bytes | **byte-identical** |
| The four files each launch downloaded | 78 689 871, 5 977 157, 12 973 147 and 28 824 583 bytes | **byte-identical, all four** |

30 of the 33 tables are identical row for row; the other three differ in the same clock and the
same random name as in every A/B before. **All four downloads on the branch's side went through
moved code** — the tag files through `tags`, the combos through `combos`' own client — and each
launch was stopped with the same three ingests under way.

One thing looked like a difference and was not. The branch's first run was stopped with a
1.89 GB write-ahead log beside its corpus where `main`'s stood at 64 MB. Sampled once a second
over six further launches — two under `main`'s binary, four under the branch's — both grow the
log for about five seconds (the samples that caught the top read 176 to 293 MB) and then reset
it to 64 MB, where it stays. A log cannot restart under a reader, and the launch's `corpus-check` reads every
page of the corpus in one read transaction; that thread is the desktop's and this part does
not touch it. Its duration on a copy the system had not cached is the likeliest reason for
the one long run, and is not a measured one.

**Then the window**, `tauri dev` over a copy with both tag closures emptied so a forced refresh
had to download, with a listener on each feed's event installed in the page first:

| | |
| --- | --- |
| `oracle_tags_refresh` | `checking`, `downloading` to 5 977 157 of 5 977 157, `ingesting`, `done` — 16 events over 61.7 s; 4 560 tags over 235 017 taggings afterwards |
| `art_tags_refresh` | the same four phases, 29 events over 80.8 s; 11 611 tags over 492 668 taggings |
| `combos_clear`, then `combos_refresh` | cleared to zero; `checking`, `downloading` to 28 824 583, `ingesting`, `done` — 33 events over 49.1 s; 111 410 combos over 7 386 cards. A second press while it ran was refused: "Combo data is already being refreshed." |
| `marketplace_feed_refresh`, Card Kingdom | `downloading`, `ingesting`, `done` in 10.0 s, each event carrying `marketplace`; 151 684 rows, the feed's own stamp read back |
| The mirror after the price refresh | one full pass about two seconds after `done`, 128 files compared, none rewritten — `corpus_replaced` reaching the desktop's mask. No pass after the tag or combo refreshes, which is right: neither changes what a mirrored file says |
| The moved reads | `tag_search`, `oracle_tags_for_printings` (40 of 40 tagged), `deck_bracket_reads` (five decks; one holds 2 combos), `sync_status` with its eight fields |
| Forty pictures, from an empty cache | 40 of 40 loaded through `mtgimg://` at 672 × 936, 40 files and 4 132 174 bytes on disk; loaded again, the slowest took 43 ms. An unknown card, an id that is a path, and a variant that is not one each loaded nothing |
| The upkeep tick | three served pictures written at 22:40:53 carried a modified time of 22:41:39 a minute later: `upkeep_tick` on the desktop's thread, stamping through `files::set_modified` |
| `prewarm_collection` | 401 queued; 442 files and 36 075 254 bytes on disk when it finished |
| `cache_clear` | 442 files, 36 075 254 bytes and 442 rows gone, 0 failed; no file left under `images/` |
| `error_log`; the app's stderr | the two rows it arrived with; nothing |

**What a fresh reviewer found**, reading the move against its parent with no cargo: no request,
event, error sentence or file order changed on the desktop — and these, each fixed here.

- **The cache's permits had stopped being first come, first served.** The move had put the
  semaphore on `async-lock`, which needs no runtime; the reviewer read that crate's source and
  found a released permit goes to whoever asks first. A pre-warm asks for its next picture the
  instant it lets go of the last, so it would have kept one of the sixteen for its whole run,
  ahead of every tile on screen. `tokio::sync` needs no runtime either and builds for a
  browser, so `platform::sync` is the primitive the cache always had, and a test holds the order.
- **The cache sweep could leave a directory behind and answer as if it had not** — the count
  that is now `failed`, above — and would have left a file whose name it could not spell.
- **The move script deleted before it wrote.** A write that failed would have left sources
  gone and outputs half there. It writes first now, and says how to finish if `rustfmt` fails.
- **Stale prose**: twenty-odd comments in both crates that still said "the desktop's", "takes
  an `AppHandle`", or named a file by its old path.
- **Nothing tested a lockout running out**, before the rewrite or after. One does now.

Two things it found are a browser's and are written down rather than changed: **the combo feed
and the price feeds send their request before they make the folder**, so a host with no files
spends a request per launch with no backoff; and **neither races its request with a deadline**
there, so a host that never answers holds that feed's refresh claim for good.

**Open after this part:**

- **No browser arm has run**, and the image cache there is a fetcher: `files` refuses, so every
  picture is fetched, served and counted as a store failure. What a web host keeps pictures in
  is phase 5's. (**Decided in step 5.3, 2026-10-04**: Cache Storage, kept by the service
  worker, which asks the engine only where a picture is — §9.3. The cache here is not called
  by that host at all.)
- **The two findings above**, before a web host runs a feed.
- **Card Kingdom's refresh emitted 4 426 progress events for one 67.8 MB download.** The host
  declares no length, so the throttle's `done >= total` is true for every chunk. The code is
  unchanged from `main`; the page it floods is too.
- **`live_ingest`** — the one test that asks Commander Spellbook for the real file — moved with
  the feed and was rewritten onto a tokio runtime of its own and a database built at head. It
  is `#[ignore]`d and was not run.
- **Step 5 is whole.** What is left of the engine in `src-tauri` is the sync client, the
  entitlement and pairing (step 6), and the scanner's session (step 7).

### 6.8 Step 6, first part — a sync operation that holds nothing across a request (2026-10-03)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-6-sync.md), Part 6a, and
[the spike](../superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md) the spec
asked for before it. Measured on Windows 11, debug builds, on the branch's own tree over `main`
at `fdaec0f9`.

**This is the step where code changes rather than moves, so it is two pull requests and this
one moves nothing.** The sync client, the entitlement and pairing are restated where they are,
in `src-tauri`, under the tests they already had; the move is the second part's. What is new in
the core is small and is there because the lane is a field of `State`: `state::Store`,
`state::Lane`, `State::lane()` and `lane_for_press()`.

| | Before | Now |
| --- | --- | --- |
| A sync operation | `with_write(&state, \|conn\| runtime.block_on(run_once(conn)))` — the write connection held through every request | `run_once(&lane)`: the database inside `db.with(\|conn\| …)`, a request between two stretches |
| One operation at a time | by accident: they all held the one connection | the lane — one async lock on `State`, whose guard is the app's only `Store` |
| A press during a sync | `db::BUSY` after 5 s | the same, from `lane_for_press` |
| A reader's write during a sync | `db::BUSY` after 5 s | lands, in milliseconds |
| Leave group during a sync | waited for the connection | waits for the lane |
| The pending pairing offer | a `std` mutex held across the request | an async lock, held across the request |
| `share`'s publisher | the connection for the whole publish | the lane, then the connection; its token asked through the connection in hand |

**Thirty-one functions held a connection across an `.await`, fifty-six awaits between them;
none does.** `scripts/core-step-6-census.mjs` counts, and its test holds the eight files at
none, and at no `block_on`. The compiler holds the rule itself: each entry point's future is
handed to `fn sendable<T: Send>(_: T)` by a function that is never called, and a `MutexGuard`
across an `.await` is not `Send`. `clippy::await_holding_lock` refuses the same everywhere,
which two of the lane's own tests found out.

**The tests the modules had did not change**: 87 in the client, 49 in the entitlement, 40 in
pairing hand over a bare connection, which is a store whose stretches run back to back — in a
test build only. Eleven are new — six in the core for the lane and one for its wait, four in
`src-tauri`. Core 2 661 passed and 5 ignored, desktop 752 and 1; clippy for the workspace and for `wasm32`; the wasm
build; `cargo check --locked`; no `testing` in the shipped tree; the frontend's build and lint.

**What building it found, that a prototype of three functions had not.** A test lands a write
behind every one of a round trip's nineteen stretches, with a second trip behind it and a peer
that pulls after each. It was red behind seven of them: `3 here, 4 there`. A baseline emitted
while that write was pending held it in its rows and under its horizon, and the op itself went
out a trip later — where a peer that had pulled in between counted it again. A card out of
nothing. **No baseline is begun while an op written since the trip read its outbox is pending**;
the marker stays unset and the next trip, which the write has already asked for, emits behind
it. [2026-10-03: widened to *nothing pending at all* by
[the claim emissions design](../superpowers/specs/2026-10-03-baseline-claim-emissions-design.md)
§5 — an op an earlier refusal left pending reaches a peer a page late in the same way.] With the
rule switched off the test is red at those seven boundaries and nowhere else.

**Driven in `tauri dev`, against a mock relay on the loopback** — the dev copy was in no group
and held no grant, its `relay_url` was pointed at `127.0.0.1`, and its files were put back
afterwards; nothing reached the real relay. A sticky note written 1.5 s into a trip whose pull
took 8 s **answered in 9 ms**, where it was told the database was busy after five seconds; the
socket's own trip then pushed it, unasked. A second Sync now during that trip was told `BUSY`
after 5 013 ms. Leave group, pressed one second into a six-second trip, waited 5 016 ms, posted
its rotation 3 ms behind the pull's answer, and left no group and no grant. The nine pairing
commands each answered — a begin, two polls that found nobody, a cancel, and each refusal in
words. [sync.md](sync.md) has the table.

**A fresh reviewer read the branch and found no must-fix.** What it found was fixed: the
departure's test took the lane itself and so could not tell a departure on a press's lane from
one on `lane()` — it drives the command's own body on a paused clock now, and the mutation is
red; a press's two waits had a bound each, where one is promised; a stretch waited invisibly to
an ingest's batch loops, where a sync operation used to be an ask they stood aside for
(`db::lock_waiting`); the census missed a connection spelled any other way and the methods of an
`impl`; and eleven passages and comments the step had made false.

**No upgrade check against `main`'s binary this time**: nothing here touches a schema rung, a
launch pass or a file. What a launch does is unchanged.

**Open after this part:**

- **A baseline op the peer's watermark has already passed is skipped, while its horizon still
  filters the delta** — an edit made in the same second the peer last heard from this device is
  lost on that peer. It is `apply`'s, it was reproduced on `main`'s code, and it is filed as its
  own task. The new rule above turns a mid-trip write into this shape rather than into an
  over-count when the two share a second or the emitter's clock runs ahead; that is no wider
  than the bug already was.
- **The lane's wait ends because every request does, and in a browser none has a deadline.**
  The second part owes `platform::http` one. *(It has one: §6.9.)*
- **`share::publish` still holds the connection for a whole publish.** It takes the lane first
  now, so it cannot interleave with a sync; a reader's write during an upload still waits.
- **The second part**: `client`, `entitlement`, `wire`, `schedule`, `identity`, `pairing` and
  the commands' plain functions move, with `platform::http`'s `POST`. *(§6.9.)*

### 6.9 Step 6, second part — the sync client, the entitlement and pairing move (2026-10-03)

[The plan](../superpowers/plans/2026-10-02-light-app-core-step-6-sync.md), Tasks 8 to 10.
Measured on Windows 11, debug builds, on the branch's own tree over `main` at `dfce2194` (6a's
merge).

**Moved by `scripts/core-step-6b.mjs`**, the I/O step's scripts with another list:
`sync_engine::{client, entitlement, wire, schedule}` and `sync_pair::{identity, pairing}` whole,
every test of theirs with them, and `sync_engine::commands` split — the sync panel's reads to the
core, the wrappers to `src-tauri/src/sync_engine/commands/mod.rs` over a glob re-export, as
pairing's went to `src-tauri/src/sync_pair/pairing/mod.rs`. **`src-tauri` keeps `live.rs`**, the
connection manager — a socket, `tokio` timers and two events emitted through a window — and is
meant to: how a host keeps a socket open is the host's, and `schedule`, the half that decides
when, is the core's. Git records all eight as renames.

| | Before | Now |
| --- | --- | --- |
| A relay request | `reqwest` | `platform::http`'s new `post`, `body` and `text` |
| Its bound in a browser | none | `Client::deadline`: **120 s** for the client, whose pull is unpaged, **30 s** for the entitlement — a whole-request bound, because `fetch` has no connect phase and no per-read one. Natively it is not applied: the connect and read bounds already end a request that stops answering |
| The pending pairing offer | `AppState.pairing` | `State.pairing`, a `platform::sync::Shared` |
| A device's default name | the environment, read in `identity` | `platform::device::name()`, `None` in a browser |
| The relay clients' per-call test client | `cfg(test)` | `any(test, feature = "testing")`, because the desktop's sync tests link the core with the feature on and a dependency's `cfg(test)` is off |

**Nothing a request sends changed**: the modules' own mock-relay tests moved with their mock
expectations unedited and pass where they now live — the only edits are paths: a fixture's in
the client's tests, and the clock's at pairing's 23 `now_ms` sites — and a fresh reviewer
compared all eight requests old against new. Core **2 954** passed and 5 ignored, desktop **460** and 1 — one more than
6a's 3 413 between them, the `Shared` test, and none lost; clippy for the workspace and for
`wasm32`; the WASM build; `cargo check --locked`; no `testing` in the shipped tree; the
frontend's build, lint and suite.

**What the move found: the fence that holds 6a's rule failed the WASM compile.** Each
`nothing_is_held_across_a_request` handed its entry points' futures to `fn sendable<T: Send>`,
and in a browser no future that awaits a request is `Send` — a `reqwest` response there is a
JavaScript promise. Every native gate was green; the WASM clippy was red at every entry point.
**`platform::Sendable`** is the bound now: `Send` natively, so the desktop's question is the one
it was, and anything in a browser, where there is no other thread to send to. A mutation — an
`Rc` handed to the fence — is still refused natively.

**Driven in `tauri dev` again, against the loopback mock** — the dev copy in no group before and
after, its files put back: a claim 12 ms; a trip 21 ms; a sticky note written during an 8 s trip
**7 ms**; a second Sync now during it `BUSY` after 5 013 ms; the slow trip 8 014 ms, then the
socket's own trip pushing the note (641 B); Leave group behind the socket's trip, waiting
6 428 ms and then clearing the group and the grant; the pairing commands as before.

**No upgrade check against `main`'s binary**, for 6a's reason: no schema rung, launch pass or
file is touched.

**Open after this step:**

- **No browser has run a relay request.** The two deadlines are reasoned, not measured; the web
  host's phase measures what a pull costs a Worker and starts from them.
- **A web host needs its own socket.** `live.rs` is `tokio` tasks and `tokio-tungstenite`; the
  browser's half — a `WebSocket`, or the polling spec §7 names — is phase 6's. (**The loop moved
  to the core in step 6.2 and the browser's arm is step 6.3 — §10.2.**)
- **The same-second baseline skip in `apply`** (§6.8) was fixed on its own: #780, merged
  2026-10-03 and in v0.40.0 — [sync.md](sync.md), *A claim names its emission*. The two
  whole-trip tests in `sync_engine/client/tests.rs` that backdated their fixtures ten seconds to
  stand clear of it stopped the same day. Both pass without it; on the commit before #780 the
  round-trip one is red without it (`3 here, 2 there` behind 7 of its 19 stretches) and the
  emission one was already green — [sync.md](sync.md), *The tests that hold it*.
- **`share::publish` still holds the connection for a whole publish** (§6.8), and stays the
  desktop's.
- **Step 7**: the scanner's session glue — and then the command table. *(§6.10.)*

**6b merged the same day, #772**, its `core` job green on wasm32 and Android — the first
Android compile of the relay client and pairing, and of the `Sendable` bound above.

### 6.10 Step 7 — the scanner's session glue (2026-10-03)

[The plan](../superpowers/plans/2026-10-03-light-app-core-step-7-scanner.md). Measured on
Windows 11, debug builds, on the branch's own tree over `main` at `91e5bc59` (6b's merge).

**Measured before it was decided.** With `card-scanner` (`corpus`, `ocr`) added to the core for an
experiment, the core checked clean for wasm32 in **27 s** and built in **68 s**, and
`cargo tree --target wasm32-unknown-unknown -i libsqlite3-sys` printed nothing: the crate's
`rusqlite` asks for `bundled`, and in a browser build that names a package that is not in the
tree. Android cannot be compiled here (no NDK); the `core` job is its first compile. **Running the
session in a browser is still impossible** — the crate keeps `std::thread::scope` and `Instant`,
which panic there — and nothing calls it there before phase 7 (spec §8).

**Markus chose the whole glue, and its state as a field of `State`.** The other two answers on
the table were moving only what names no engine (prefs, tray, lease), and deferring the step to
phase 7. The field reverses the desktop's documented choice — the scanner's state was
`app.manage`d beside `AppState` because it is optional and shares nothing but the data directory
— because the command table that comes next reaches everything through one handle.

**Moved by `scripts/core-step-7.mjs`**, the 6b script's shape with a split inside the tests module
as well (`rs-items.mjs`'s `inner`):

| | Now |
| --- | --- |
| The session and its lazy load, the lease, the asset load order, prefs, tray, the tray's commit, the capture writer, and 34 tests | `crates/grimoire-core/src/scanner.rs` |
| The assets `build.rs` embeds, the three request headers and the raw-body parsing, the 12 commands, and the 8 tests of that body | `src-tauri/src/scanner/mod.rs`, under `pub use grimoire_core::scanner::*;` |
| The scanner's state | `State.scanner`, built empty by `State::new` from the data directory — no new argument |
| What the binary embeds | the desktop's `scanner::compiled()` — the only place `cfg(scanner_assets)` is asked — handed once to `state.scanner.carry(…)` above `app.manage`, so no command reaches the state before it is said |
| The lease's clock | `platform::clock::Tick`, which grew `==`, `+ Duration` and `saturating_duration_since` |
| The asset and capture files | `platform::files`, which grew a whole-file `read` |
| The model pair | read through `files` and handed to `TitleReader::from_bytes`, with `TitleReader::load`'s sentences kept word for word — a test now pins that the refusal still names both files |
| A `card-scanner` change in CI | runs the `core` job too |

**Nothing a command answers changed**: the same twelve names, arguments, refusals and sentences,
and the page is untouched. All 42 of the module's tests pass where they now live; core **2 989**
and desktop **426**, which is 6b's 3 414 and the `Tick` test, none lost; clippy for the workspace
and for `wasm32`; the wasm build; `cargo check --locked`; no `testing` in the shipped tree; the
frontend's build and lint, and its suite but one: `ScannerPage.test.tsx`'s refused-camera test
timed out a 1 s `findByText` at 1.46 s under the full run's load and passed 40/40 three times
alone — the branch touches no frontend code but `ipc.test.ts`'s import.

**A fresh reviewer read the branch and found no must-fix** — every command, every test, the
fence, the router and `read_models`' sentences checked against the old code. What it found was
prose the move had made false, the CI docs above all (`crates/*` "never runs `core`"), and a
claim here that every module the spec named had moved: `share/snapshot` and `share/cache` were
on §2.3's list and on no step's.

**The live pass came after the merge, the same day.** It could not run before #773 merged:
Markus's own portable build was running from Explorer, and a dev build launched beside it only
opens a window in that app — the single-instance guard keys on the identifier, not the build — so
driving the scanner's commands would have driven his real data. (A static check stood in: every
one of the twelve commands asks for `State<Arc<AppState>>`, which `desktop::start` manages, and no
`ScannerState` is managed or asked for anywhere.) Once he had closed it: `tauri dev`, debug build,
`main` at `49162fd2`, CDP through the page's own `ipc`, with the published `scanner-bundle-v3`
assets (5.5 + 2.5 + 9.7 MB, downloaded with his say-so) placed in the dev data folder's
`scanner/` — so the load took the **file** path, the one this step rewrote onto `platform::files`
and `read_models`, and the build embedded nothing.

| | Measured |
| --- | --- |
| `scanner_status`, first | **1 555 ms**, the lazy load: bundle and both models `source: "file"`, `loaded: true`; **118 467 labels** from `corpus.db` |
| `scanner_status`, second | 2 ms — loaded once |
| A real card through `scanner_frame` | Counterspell, MH2 267: its cached 672×936 picture on a dark 1280×960 table, eight frames. Four corners every frame; the exact printing top from the second (distance 40); `wants_detail` on the sixth, and the seventh carried the detail image through `DETAIL_HEADER`'s two-JPEG body; **resolved to MH2 267 on the seventh**. 179–317 ms a frame |
| Two windows | the first held the scanner; 178 ms later the second was told `elsewhere`, its hold refused in exactly *The scanner is open in another window.*, its status answered; **admitted 11 879 ms later** — the first window's 10 s heartbeat and the 2 s lease after its last beat |
| Prefs, tray, commit | prefs read and written back; a tray row of none refused in *A tray row needs at least one copy.*; one row stored and read back; `scanner_tray_commit` — `added: 1`, the card owned 0 → 1 and the tray empty, one write |
| Capture | `live-<epoch>.jpg` and its sidecar under `data/scanner/scans/`, the sidecar's `Æther Vial` intact through the ASCII escape |

The first try at the two-window row was a probe error, not the lease's: a heartbeat on
`setInterval` first fires at 500 ms, and the second window asked at 182 ms, while the scanner was
genuinely free. Holding once, awaited, before the second window asks is what the row above
measures. Afterwards the dev copy's `user.db` was put back from a copy taken first, the assets and
the capture deleted, and the app launched once more so the mirror's startup pass re-rendered the
seven Collection files the commit had written.

**No upgrade check against `main`'s binary**: no schema rung, launch pass or file changed. The two
`app_meta` rows are read and written by the same functions, now in the core.

**Open after this step:**

- **The command table** (`core::dispatch`), with a name-parity test against `generate_handler!` —
  the last item of phase 2.
- **The scanner in a browser** is phase 7's: the crate's threads and clock need a seam, and the
  assets a download (spec §8).
- ~~A live pass of the Scanner view over the moved glue~~ — run the same day, above.

### 6.11 The command table — the machinery and the reads (2026-10-03)

[The plan](../superpowers/plans/2026-10-03-light-app-core-command-table.md); spec §2.4. Measured on
Windows 11, debug builds.

**Surveyed first.** A script read every `#[tauri::command]` under `src-tauri/src` and what its
body touches: **257** registered commands, of which about 199 are thin wrappers — one core call
inside a read of the read connection (89), a write (93) or an owned write (17) — 13 reach a
network or the sync lane, 13 are status reads and housekeeping, and about 30 name the desktop.
**Markus chose the machinery and the reads first**, the rest joining as the light app's pages ask
for them, and **a `macro_rules!` table** over a hand-written match.

**What exists.** `crates/grimoire-core/src/commands.rs`: the `commands!` block, one line per
command — kind, name, the module whose items its body names, the arguments, the body — and
`grimoire_core::dispatch(&state, name, args, body)`, which parses the arguments (camelCase, an
absent `Option` read as `None`), runs the body as its kind says, and answers JSON. **88 reads**:
the survey's 89 less the two that start a picture fetch (`prefetch_images`, `prewarm_collection`
— tasks, not reads) and plus `card_holdings`, which a word in its doc comment had excluded. They
were drafted from the wrappers by `scripts/core-command-table.mjs` — each body is its wrapper's,
the connection renamed — and five were written by hand: `marketplace_feed_status` (a block),
`error_log_list` (in `desktop.rs`, calling `errors`), and three whose inline `mod commands`
renamed what it imported.

| Kind | Runs | In the table |
| --- | --- | --- |
| `read` | blocking pool, the read connection | 88 |
| `write` | blocking pool, `state::with_write` | 0 — proven by the kinds' own test table |
| `owned` | blocking pool, `collection_source::with_write_owned` | 0 — the same |
| `task` | awaited where it stands, with the `Arc<State>` | 0 — the same |
| `bytes` | blocking pool, with the call's raw body | 0 — the same |

**The fence**, `src-tauri/src/command_table.rs`, three tests: every one of the 257 registered
commands is in the table, on `DESKTOP_ONLY` (16, each with its reason — windows, the updater, the
file dialogs, the mirror, the launch, the socket) or on `NOT_YET` (153), and in only one; nothing
on either list or in the table is a command the app does not register; and every table entry takes
exactly its wrapper's arguments, by name, in order and by type. **Both were mutated and went red** — a
renamed argument and a name taken off `NOT_YET`. **The arguments test found something the day it
was written**: its first version told Tauri's own parameters apart by *name*, and dropped
`price_movers`' `window`, a span of time; it reads their `tauri::` *type* now.

**Tests**: the table's own five and the fence's four.

- **Every kind through its arm**, and the two that look alike told apart: over a warm facet
  index, an `owned` write publishes the index again and a `write` leaves it — the one thing
  `with_write_owned` adds. **A read answers while another thread holds the write connection**, so
  a `read` arm that took the writer's would time out.
- **Each refusal in words**: no such command, arguments that do not parse, snake_case where
  camelCase is the wire, a body where none belongs and none where one does.
- **Four real reads through `dispatch`, compared with their functions' own answers** over rows
  that tell a wrong answer from a right one: three decks, the third with four history rows, asked
  for its two newest — an entry that swapped its two integers would answer the second deck's one
  row, and one that dropped the limit all four; `deck_get` with its optional marketplace left out;
  a read with no arguments; `combos_for_card`.
- **No name declared twice**, and the fence's arguments test compares **types** as well as names,
  normalised to what they name (`crate::sorting::Marketplace` is `Marketplace`).
- **`dispatch` holds nothing across an `.await`** — checked over the real table and over the
  kinds' own, whose arms the real table does not expand yet.

**Each was mutated and went red**: the `owned` arm swapped for plain `with_write`, and
`deck_audit_list`'s two arguments swapped. Clippy for the workspace and for `wasm32`, and the WASM
build, are clean with all 88 arms in one `async fn`.

**A fresh reviewer compared all 88 entries with their wrappers by hand and found none that answers
differently.** What it found was tests proving less than they said — the first version of the
reads test passed on an empty database whatever the bodies did, the kinds test could not tell
`owned` from `write`, and the fence compared argument names and not types — all closed above.

**Nothing on the desktop changed**: its wrappers are untouched and do not call `dispatch`, so
there is no live pass to make and no upgrade to compare. **Nothing has called `dispatch` from a
real host yet** — that is phases 4 and 5.

**Open after this:**

- **Phase 2's seven steps and its table are built, and #761's phase 2 list has no open item**
  (2026-10-03). The decision it held is made — `target/` stays pinned to `src-tauri/target`
  (Markus; `src-tauri/target` is named 140 times in 75 tracked files, and a move rebuilds every
  checkout and moves every worktree's dev database). The check it held is made — §6.12. What it
  leaves are two standing rules, which are not tasks: a new user rung's `UNDO_V<N>` in two files,
  and the `testing` feature off every host's `[dependencies]`.
- The writes, tasks and bytes commands join the table as phase 3's pages ask for them — one line
  in `commands!`, one name off `NOT_YET`.
- **A sixth kind, before five of the reads on `NOT_YET` can join**: `combos_status`,
  `oracle_tags_status`, `art_tags_status`, `sync_status` and `facet_cards` take the `State` rather
  than a connection, and the table has no kind for "the blocking pool, the `Arc<State>`, no body" —
  `task` runs where it stands and `bytes` needs a body.
- **The chain from the table to the page is unpinned for 14 of the 88 reads**, which
  `ipc.test.ts` names nowhere — eight of them with arguments (the spec's §2.4 note lists them).
- `share/snapshot` and `share/cache`, which the spec listed and no step moved.

### 6.12 The first release under the workspace — v0.40.0 (2026-10-03)

Two things about a release could only be read, not run, while the workspace was being built
(§6.1): whether `release.yml` still finds what `tauri-action` builds, and whether release-please
bumps both crates. **v0.40.0 settled both**, published 2026-10-03 at 11:34 UTC by
[run 37119190167](https://github.com/Msgaihede/mtg-grimoire/actions/runs/37119190167) on the merge
of release PR #748 — four jobs green, 17 minutes end to end (the Windows leg 16.5, the Linux leg
12).

| Asked | Answered |
| --- | --- |
| Does `tauri-action` find its bundles with the workspace at the root and `target/` pinned under `src-tauri`? | Yes. All five files are on the release: the NSIS installer, the MSI, the portable zip, the `.deb` and the AppImage — each within 1% of v0.39.0's size (the portable zip 31 566 234 B against 31 315 169) |
| Does the portable step find the exe? | Yes — `src-tauri/target/release/mtg-grimoire.exe`, where `.cargo/config.toml` puts it |
| Does release-please bump the engine with the app? | Yes. At the tag, `crates/grimoire-core/Cargo.toml`, `src-tauri/Cargo.toml` and both of their entries in the root `Cargo.lock` read 0.40.0, and the build passed `--locked` |
| Does the embedded-assets build compile since step 7 moved it (§6.10)? | Yes — the *Scanner assets* step and the build behind it passed on both legs. No CI job compiles `cfg(scanner_assets)`, so this was its first real compile since `include_bytes!` went one folder deeper |

**The embedded-assets path was checked an hour before the release, without a download**: three
four-byte placeholder files in `src-tauri/scanner-assets/`, then
`cargo check -p mtg-grimoire --locked` — 24 s, and the build script's output confirmed
`rustc-cfg=scanner_assets` was set. `build.rs` asks only whether the three files exist, so a
placeholder turns the cfg on; it is a compile check and says nothing about the bytes. The
placeholders were deleted afterwards. It is the cheap check to repeat whenever
`src-tauri/src/scanner/mod.rs` moves again.

**Not checked**: nobody has installed or launched any of the five files — the run proves they
were built and attached, and the Linux pair is as unrun as it has always been. And the release's
own `rust-cache` reported `No cache found` on both legs — a first run under a new key, so the
build was cold and the cache line in `release.yml` is still unproven (`ci.yml`'s restores). The release also
carries #780 (the sync fix §6.9 left open), which merged twelve minutes before the release PR.

## 7. The phone pages — phase 3, a step at a time

The plan is [the phase 3 plan](../superpowers/plans/2026-10-03-light-app-phase-3.md): one pull
request per step. **The owner waived the built-options round for this phase** (2026-10-03): each
page is the implementer's pick, shipped, and redirected in review. Every figure below is from
`npm run mobile:dev` — Vite's dev server over the Storybook fake's `starter` seed — in headless
Chromium 141 on **Linux**, emulating a touch phone; nothing here was measured on a phone or
against a production bundle.

### 7.1 Step 3.1 — Search and the card sheet (2026-10-03)

**Search is one line and a sheet.** The box keeps 16px text and its name; beside it one
`Filters` button, gold with a badge while anything is on (`Filters — N active`). Under the line,
only once something is on, the desktop's own `StatedFiltersLine` with the result count in place
of its caption, and `TagQueryRow` under that so `otag:`/`atag:` resolve exactly as they do on
the desktop. The sheet holds every cell `SEARCH_TRAY` offers — sort and its direction, format
with `Any card`, colour identity, mana value with X, rarity, type, border, finish, owned, set,
price, printings — over the same `useCardSearch`, dimmed by `facets.ts` the way the desktop's
tray is, with `Reset all` and `Show N cards` in a footer. It is not a place: opening it writes no
history.

- **No `Exact` glyph chip on the phone.** Seven 44px round chips do not fit 328px with room for
  the pressed ring, and a tooltip-only glyph tells a finger nothing; a `Within` / `Exactly` pair
  under the six colours sets the same flag.
- **Everything in the sheet is at least 44px tall whatever the pointer**, and every text box in it
  is 16px, so a focused picker's search box does not zoom the page.
- **What moved out of `FilterBar.tsx`**, store-free and re-exported from it so no desktop caller
  changed: `filterOptions.ts` (the sort rows, rarities, `sortDirectionName`,
  `useFormatOptions`, `activeChips`, and `formatPickerRows`, which the tray used to build inline)
  and `StatedFiltersLine.tsx`; `countOf` left the desktop `SearchPage` for `resultCount.ts`.

**The card sheet reads the desktop modal's own query keys**, so a card open on one side of the
floor is painted from the cache on the other. One column: the picture and the words; prices for
the finishes the printing is sold in, with the marketplace's as-of line; *In your grimoire*
(owned, wished, in decks); printings grouped by the stored preference, five then `Show all N`;
legality behind its summary (`Legal in 16 of 23 formats · banned in 1`); oracle tags; combos,
three then `Show all N`, each opening to its pieces, brackets, prerequisites and steps. **Each
empty state is its own sentence** — tags never fetched, untagged, no oracle card, a failed read;
combos never downloaded, reading, failed, none — for the rule `commander-brackets.md` gives the
card side.

- **A step to another printing is a link that replaces** (`linkTo(place, { replace: true })`):
  history length stayed 3 across two printing presses at 360px, and the ✕ went back to `/search`.
- **What moved out of the desktop's dialogs**, store-free, so both faces read one copy:
  `faces.ts`, `legality.ts`, `oracleTags.ts`, `combos.ts`, and `cardKeys.ts` (the printings and
  holdings keys `CardDetailModal` spelled inline).
- **Not on the sheet**: the `Open on …` rows and Commander Spellbook's link (they go through the
  opener plugin, a host seam phases 4 and 5 own); art tags (no command answers them for one card,
  and the desktop modal does not draw them either); an owned count per printing (printings do not
  carry one); the printing group-by control (choosing it is a write).

**`Dialog`'s ✕ is 44px under a coarse pointer** and its 24px box everywhere a mouse aims; the card
sheet takes the top safe-area inset when it fills the window, as the filters sheet does.

**Two of phase 1's leftovers closed here** (§5): a refused next page and an uncountable empty
wall each say so now, and `facesOf` lives once.


### 7.2 Step 3.2 — Collection (2026-10-03)

**The collection is the cabinet.** Under the line — the box (`Search your collection`) and the one
`Filters` button, with the stated filters under them once one is on — the wall is the desktop's
shelves in `buildShelves`' order: Not sorted, the reader's folders depth first, then **Decks**,
each deck's group by name and `Recently removed` last. The figures band (`CollectionSummaryHeader`:
Cards, Unique, Value with its unpriced count, For trade) heads the wall and scrolls away with it.
Each shelf is a 48px heading — the chevron, the desktop's `ShelfGlyph`, the name with its path, the
figures under it (`Locked · …` for a drawer set aside), a peek of three cards while shut — over its
own cards, laid out from the shelf counts so every heading is placed before its page lands.

- **Every shelf opens.** A press on a heading folds it in place; its `→` opens the folder as a
  level, with a path row (`←` and the trail) that stays put above the wall. A deck's group carries
  a `Deck` link to its deck. **A fold is the phone's own and is not stored**: the shelves start
  from the reader's stored folds and a press is held by the page, because nothing on the phone face
  writes yet and `mobile:tauri` shares the desktop's `app_meta`. `useCollection({ folds })` is the
  seam; the desktop passes nothing. **Reversed in step 3.5b (§7.5b)**: a fold is stored now, and
  the seam has no caller.
- **The level is not in the URL**, unlike the deck gallery's `?folder=`: its controls are buttons,
  and Back leaves the view rather than the folder.
- **One tile per printing, finish and folder**, the desktop wall's grain, so two grades of one
  printing are one tile counting both — and `ShelfCount.tiles` counts the same grain, which is what
  lets the wall be laid out from the counts at all.
- **Filters through 3.1's sheet**, which now takes any `FilterSurface` and a `tray`: the collection
  offers the desktop bar's own cells (`COLLECTION_TRAY`, moved beside `useCollection`) — set,
  format, rarity, type, border, price, finish, condition, needs review — with its own sort rows, and
  no Owned, Printings or `Any card`. A filter suspends folding, as on the desktop.
- **Headings only are indented**, 12px a level; the cards under a nested shelf use the wall's full
  width, because one column count serves every shelf and a 360px wall indented the desktop's 32px
  a level drops to one column.
- **What moved in `src/`**, each re-exported or imported where it was: `collectionWall.ts` (the
  tile fold, `ownedFinishes`, `tilesByShelf`, `subtotalsOf`, `shelfTotal`, out of the welded
  `CollectionPage`); `loadedShelves` and `fillShelves` (out of `CardGrid`'s sectioned memos) into
  `shelfLayout.ts`; one generic `trailOf` in `folderTree.ts`; `TrayCell` and `SEARCH_TRAY` into
  `filterOptions.ts`.
- **The wall ends on 3.1's `Try again`** when a next page is refused, and a refused whole-level
  figure says so under the band while the shelves go on saying what they hold.

Driven at 360 and 800 wide over `starter`: nothing scrolls sideways, at the root, inside `Binder`,
with a deck's group opened, and with the sheet open.

### 7.3 Step 3.3 — Wishlist (2026-10-03)

**The wishlist is the collection's cabinet one table over**, on the same shelved wall and under the
same line (`Search your wishlist`, `Filters`, the stated filters): Not sorted, the reader's folders,
then **Managed by decks**. The figures band is the desktop's (`WishlistSummaryHeader`: Cards and
`Total cost` with its unpriced count), counted from the shelf counts. One tile per wish, keyed by
the wish, so a card wished for at the root and again in a folder is two tiles — and the chin says
so: it is the desktop wall's caption, `wallPrinting` with the `elsewhere` mark beside it (three of
`starter`'s five loose wishes wear it).

- **A deck's managed wishlist is a read.** Its heading carries a `Deck` link to its deck (its
  `Tokens` child, named for no deck, carries none); an empty one says
  `managedEmptySentence` for the view the deck follows; standing inside one draws
  `ManagedFolderNote` — whose way to the deck is now a real link when it is handed one, and a
  button on the desktop as before. Nothing in it is editable here, which a read-only page keeps
  true for nothing.
- **A wish with no card is no control.** The tile's picture is `artCardId` — a pinned wish's own
  printing, the newest for a wish for any printing, and nothing for a wish whose card the corpus
  has lost — and `WallTile` gives a tile with no card no `onPress`, so `CardTile` draws it as a
  plain box with the no-art frame naming the card. The `needsReview` seed's Orcish Bowmasters is
  the case.
- **The sheet offers the desktop bar's own cells** (`WISHLIST_TRAY`, moved beside `useWishlist`):
  set, format, rarity, type, border and needs review — no price, finish or condition, because a wish
  asks none of those questions. Folds are the page's own, as on the collection
  (`useWishlist({ folds })`) — **stored since step 3.5b** (§7.5b) — and paging reads the hook's `hasMore`, held while a level arrives.
- **What moved in `src/`**: `preferredFinishOf` and `wallPrinting` into `wish.ts` (out of
  `WishlistGrid`); `subtotalsOf`, `FolderTotals` and `folderFigures` into `wishShelfPlan.ts` and
  the figures band into `WishlistSummary.tsx` (out of the welded `WishlistPage`).
- **Not tested on the phone**: a refused next page on the wishlist — no seed holds more than a
  page of wishes; the footer is the collection's, wired the same way.

Driven at 360 and 800 wide over `starter`: nothing scrolls sideways, at the root, inside the
managed folder, and with the sheet open.

### 7.4 Step 3.4 — Decks, read (2026-10-03)

**The gallery** is the reader's cabinet: the folders at this level as link rows, then two columns
of cover links (three from 640px) — the art crop, `DeckColorBar`, the name, and format · card
count — in the desktop's own stored sort, with archived decks behind a disclosure. **A folder is a
place**: `?folder=<id>` on `/decks`, absent rather than `null` when there is none, and an id the
cabinet does not hold opens the top level, so `parsePlace` stays total. The badge and the bracket
reading stack in one corner, because side by side they do not fit at 360px, and **the illustrator
is credited in visible text on the picture** — an art crop needs its artist named, and a phone has
no hover for the desktop's tooltip.

**The deck page is one column, the owner's call** (2026-10-03): a header with the way back to the
deck's own folder, the name and — on a deck that keeps a plan — the Theory / Actual switch; a
figures line (format, cards, lands, price, owned, missing); then the piles in the desktop's own
order, through `buildGroups` and `splitRail` — **the commander first**, then the companion, then
the deck's piles, then the sideboard, the maybeboard and any switched-off pile — under the
desktop's `GroupHeader`; then **the side rail, last**: the check, the bracket estimate (Commander
formats only), tokens, the mana curve, deck notes and deck to-do lists, in the order the desktop
draws its bands. A card is a compact row — quantity, label dot, name, mana cost, unit price —
about ten to a screen, and opens the card sheet; a rule break is red with a warning glyph
(`validateForMarks`), and a card owned short of the deck's count carries a small red dot.

- **The variant is local state, not a place.** It opens on the list the deck remembers
  (`lastVariant` where it keeps a plan, Actual otherwise), as the desktop's restore does, and
  writes nothing back — a way of looking at one deck, which the desktop face would drop from the
  URL anyway.
- **The deck is read under the desktop editor's own key** (`deckDetailQuery` in the new
  `src/features/decks/deckQuery.ts`), so crossing 1024px paints it from the cache — phase 1's
  leftover, closed.
- **What was split in `src/`**, each re-exported from its old home: `deckQuery.ts` (the deck read
  and its defaults, out of the welded `useDeck`, which also makes `useDeckTokens`, `useDeckNotes`,
  `useDeckMeta`, `useDeckPlays` and `useDeckAudit` clean); `deckCover.ts` (out of `DeckTile`);
  `ValidationPanel`'s popover body as `ValidationFindings`; `DeckBracket`'s reading as
  `useBracketReading` and its body as `BracketAdvisory`, whose picker is drawn only when it is
  handed `onBracket`; `noteBody.tsx` and `todoBody.tsx`, the bodies of a deck note and a deck to-do
  list, which a phone draws without the cards' edit controls.
- **Links in deck notes and to-do lists** are a plain `<a target="_blank" rel="noopener
  noreferrer">` on the phone, because nothing below `@/lib/core` opens a URL yet; on a Tauri light
  host that is for phases 4 and 5's seams to settle. (**They are still plain links, and that is
  now the choice rather than the stand-in**: since step 5.4 `@/lib/core` does open a URL — §9.4 —
  and a link a reader can long-press needs no host to open it; phase 4's guard hands it to the
  system browser on Android.) A to-do box on the phone is drawn and cannot be pressed, and says
  `Done:` or `To do:`.
- **Not on the phone yet**: Compare, the theory-match ticks on the Actual list, the deck's
  description, and the stats band beyond the mana curve (the band carries write buttons).

Driven at 360 and 800 wide over the `starter` seed's decks 2 and 4: nothing scrolls sideways.

### 7.5 Step 3.5a — deck writes on the phone (2026-10-03)

**Every write goes through the mutation the desktop editor presses**, with its optimistic patch and
its invalidations, so the desktop face — and the desktop app over the same database — reads the
change the moment it lands. There is no new command and no second copy of a write: what made that
possible is one split in `src/` (below), after which the phone's deck page calls `useDeckCore`,
the desktop's own `useDeck` without the app store.

**A row's actions are a sheet behind a visible `⋯`**, a 44px button at the row's far end, beside
the row's own press (which still opens the card sheet) and never inside it. A long-press was
weighed and refused: nothing on screen announces it, a scroll's slow start can fire it, and a
screen reader or a keyboard cannot make it at all — a button at the right edge is under the thumb
of a hand holding the phone, is found by looking, and is a tab stop. Its name says which row it is
about (`Edit Sol Ring, foil in Ramp`), because one card can be two rows. The sheet (`deck/sheet.tsx`)
is `Dialog` with a `self-end` panel — the app's one modal shell, as a bottom sheet below 640px and
the centred panel above it — and page state, not a place. It holds, top to bottom:

- **Copies** — `−`, the number, `+`, each 44px. `−` at one copy is the removal and says so.
- **Pile ▸** — every pile of the list in the reader's order, the desktop menu's `Category ▸` and
  for its reason: filing is the drag onto a heading, refused only for the pile the card is in
  (marked, `already here`). A switched-off pile says what that costs.
- **Set as commander / Set as companion** — the claims, present only where the format and the deck
  have the zone, **refused in words under the row**. The desktop menu greys them silently because
  a sentence widens every row of a menu; a sheet row is the window's width and has a second line.
- **Label ▸** — `None`, then the labels this list wears (most-used first), then every other label:
  the desktop's `Label card ▸` and `More labels…` on one page.
- **Printing ▸** — the card sheet's own printings read and row (`PrintingFace`, split out of
  `card/Printings.tsx`), as buttons that swap the deck's printing. **Finish ▸** — the finishes that
  printing is sold in, in Scryfall's order; refused in words where there is one.
- **Add to actual / Add to theory** — one copy into the other list, only on a deck that keeps a plan.
- **Remove from <pile>** — every copy, the same write as the stepper's zero.

**A write that moves the row moves the sheet with it**: a pile, a printing and a finish are parts
of the row's address, so the page re-points the sheet at the new address when each answers, and
carries what the write is known to have changed onto the row last seen, so nothing blanks while the
deck is re-read. A removal has no address to follow and closes the sheet.

**The receipt is the desktop's undo, read at the right moment** (`deck/receipt.tsx`). One line at
the foot of the page — or of whichever sheet is up, never both — says what the last write did, in
the press's own words (`Moved Lightning Bolt to Sideboard.`); and once the deck's undo state
(`useDeckUndo`, the desktop toolbar's hook) answers with a newer step than the one at the press,
`Undo` appears beside it, named by that step's own sentence, and reverses it. Two things it does not
pretend: **a cut from an Actual list files no undo step** — it is `deck_to_collection`, a collection
write the desktop cannot undo either — so its line says where the copies went (`The copies are in
Recently removed.`) and offers no `Undo`; and **the Storybook fake journals no card write**
(`deck_add_card`, the quantity, the move, the swap, the finish — its own `journalled` doc names the
gap), so over the fake only the label, the bracket and the notes show `Undo`. Over the real core
every one of them files a step. The phone draws no Redo; the hook's redo stack is cleared after each
write, as its contract asks.

**`Add cards`** is the page's foot, with `Deck settings` beside it — a bar rather than a floating
button, because a button floating over the right edge would sit on the rows' own `⋯`. It opens the
card database as a full-height sheet (`deck/AddCards.tsx`) through the Search page's own line and
wall — `SearchLine` and `SearchResults`, split out of `SearchPage` for it — over `useCardSearch`
with the deck's format as the opening filter where the database can answer it (the editor's
`searchFormatDefault`) and `availableForDeck`. **A press on a tile adds one copy** (the tile's name
starts `Add …`), through `addCard` with `deckDefault`: the pile Deck settings names, else the pile
the card's Oracle tags file it under. The foot says what was added and how many of that printing the
list now holds. The filters sheet opens over it, stacked inside its panel.

**The card sheet's `Add to <deck>`** sits at the top of the sheet when it is open over a deck page,
and adds one copy of the printing on screen to **the list the page is showing**. That needed the
list to be readable from outside the page: `PhoneFace` now holds each deck's switched list for the
session, and `deck/list.ts`' `shownList` is the one rule both the page and the sheet read. The
sheet's actions are a slot list (`card/Actions.tsx`): each action is a file and one entry with an
`applies` test, so step 3.5b adds the collection's and the wishlist's rows without touching this one.

**Deck notes and to-do lists are written through the desktop's own dialogs.** `New note` and
`Edit` open `NoteEditorDialog`, whose save the page hosts exactly as the desktop band does (a create
sends an empty title and the body; an edit sends the note's own title back unchanged) — so the
history row and the undo step are the desktop's. `Delete` asks first in the band's words. A to-do
box ticks in place with the card's compare-and-set; `New list` and `Edit` open `TodoListDialog` and
its autosave; `Delete` asks first. **Tiptap on touch works**: driven in headless Chromium with touch
emulation at 360px, a tap put the caret in the editor and typed text landed. The dialog fills the
width below 640px and keeps the desktop's footer buttons, which are under the 44px floor.

**Deck-level**: the bracket picker is the advisory's own (`onBracket` → `deck.update`), its rungs
raised to 44px from the phone's side; and **`Deck settings` is the desktop's `DeckSettingsDialog`,
whole** — name, format, game, kind (Theory + Actual / Virtual), the theory marks, the managed
wishlist, the folder, the cover, the default pile, the pull and the two clears. It was clean to
reuse once it read the store-free hook, and nothing in it scrolls sideways at 360px; several of its
controls are desktop-sized.

**What moved in `src/`**, each re-exported from its old home so no desktop caller or test changed:

- `useDeck.ts` → **`useDeckCore.ts`**: the whole hook body, store-free. What a write does to the
  desktop card modal's address for a deck row — re-anchor it on a move, plan a departure before a
  removal, step off it after — stays in `useDeck.ts` as the `DeckAnchor` it hands in; the phone
  hands none (`NO_ANCHOR`).
- `deckCardMenu.tsx` → **`deckCardRules.ts`**: `ALREADY_HERE`, `REGULAR`, `finishChoices`,
  `companionRefusal`, and the commander/companion claims as `zoneClaims`, which the menu now maps
  to its rows.
- `DeckNotesPanel.tsx` → **`DeleteNoteDialog.tsx`**; `DeckTokensPanel.tsx`'s `TOKENS_HEADING` →
  `deckTokens.ts`, which is what made `auditText` and so `useDeckUndo` clean.
- `DeckSettingsDialog` reads `useDeckCore` (nothing it writes moves a row), and `TodoBody` grew a
  `touch` prop: a 44px `<label>` round the same 14px box, pulled back out of the layout.

**Not done**: attaching cards to a deck note (`NoteCardsDialog` is a desktop picker); categories and
labels as things in themselves (create, rename, switch off, delete — the Categories and Labels
dialogs); the token pile's steppers and the tokens band's writes; the stats band's writes (missing
to wishlist, pull, quick add to collection) and the card menu's `Collection link ▸`; Compare; a
picked set and any write to several rows at once; Redo. A long list of printings in the `Printing ▸`
page draws them all, unfolded.

Driven at 360 and 800 wide over the `starter` seed's decks 1, 2 and 4, in headless Chromium 141 on
Linux with touch emulation: nothing scrolls sideways — the page, the action sheet, the add search,
the card sheet and Deck settings.

### 7.5b Step 3.5b — collection and wishlist writes on the phone (2026-10-03)

**Every write is a desktop mutation, moved out of the page that owned it rather than written a
second time.** The collection's and the wishlist's writes lived inside `CollectionPage` and
`WishlistPage`, which reach the app store, so the phone face could not call them; the split (below)
moved each verbatim into a store-free module the desktop page now calls, and the phone calls the
same one. No new command, and no new IPC.

**A tile's actions are a sheet behind a visible `⋯`**, 3.5a's choice for a deck row read across to
a wall: a 44px control, drawn as the stepper-over-art's backed circle, in the tile's **top-left**
corner — top-right is the finish chip's on every card face here and bottom-left is the count's. It
is a sibling of the picture's button (`WallTile`'s `onActions`), so a press on the art still opens
the card sheet. Its name says which tile (`Edit Tarmogoyf, FUT 153`). The sheet is 3.5a's
`ActionSheet`, and what the writes did is one receipt line at the foot of the page, or of the sheet
while it is up — `ReceiptBar`, which now takes any `ReceiptLine`, fed by `lists/receipt.ts`.

**A collection tile can stand for several rows, and every write addresses one** — the desktop's
rule from both of its ends: the card modal's `Edit` turns into `Edit which copy` over a printing in
more than one row, and the wall's `Move to` asks `PickCopies` rather than moving every copy behind
the art. So a tile of several rows (two grades or two languages of one printing, finish and folder)
opens on **its copies, listed** in the modal's own words (`copyOption`: `1× Near mint · Etched · JA`,
the drawer beside it), and a press on one opens that copy's actions; a tile of one row opens on its
actions at once. `All copies on this tile` goes back. Nothing writes to a row the reader did not
name — the desktop tile stepper's *first row behind the art* was weighed and refused here, because a
sheet has the room to ask and a wall of art does not.

The collection sheet (`lists/CopyActions.tsx`) offers what the desktop's edits to one copy offer:

- **Copies** — `useCollectionEntryWrites`' stepper, fenced by `entryFences`' `quantityRefusal` and
  said in its sentence where it refuses (`In Modern Goodstuff. Remove it from the deck to change the
  quantity.`). **`−` at one copy is the removal** — the same press as `Remove from collection`,
  which is the menu's `collection_remove_many`, so the receipt offers its **ticket** back through the
  desktop's `bulk_undo` (`useBulkUndoAction`, `UndoNotice` less its drawing). The desktop stepper's
  zero is `set_quantity(0)` and has no undo; the phone takes the write that has one.
- **Condition** — `EditCopy`'s save (`useCopyUpdate`), the grade alone, one press per grade.
- **Finish** and **Printing** — the card modal's `Edit` (`useCopyFinish`, `useCopyPrinting`). A
  printing never made in the copy's finish refuses before anything is written, in the modal's words
  (`finishRefusal`).
- **Move to** — `useSetCollectionFolder`, the menu's `Move to`: the root and the reader's own
  drawers, nested, **a drawer set aside offered and marked** (`set aside`) as the menu offers it —
  the locked-edge confirmation is the drag's alone on the desktop. Drawn only once the reader has a
  drawer. A copy in a deck's group is not fenced here, as it is not in the menu: the backend refuses
  the move in its own words (`Those copies are in a deck. Cut the card from the deck to get them
  back.`), said on the receipt line.
- **Remove from collection** — refused in words under the row where the count is.

**A write that folds the row follows it**: grade, finish, printing and drawer are all grain
columns, so each can land on a row already there and answer its id; the sheet re-points at that id
and keeps the row last seen, carrying what the write changed, until the re-read arrives.

The wish sheet (`lists/WishActions.tsx`) is `EditWish`'s panel: **Copies** (`−` at one is the
removal, with **no undo** — the desktop's wish removal takes none); **Printing** — `Any printing`
first, withheld from a wish already for any (`EditWish`'s rule), then every printing, a press
**pinning** the wish (the All printings modal's `wishlist_set_printing` from a wish, now
`useWishEntryWrites`' `setPrinting`); **Move to** the root and the reader's own folders, never a
managed list; **Remove from wishlist**. **A wish a deck manages draws no `⋯`** — the backend refuses
every hand write to one in `MANAGED_REFUSAL`'s words, and a control whose only answer is that
sentence teaches nothing — and, were one opened, the sheet says that sentence and offers nothing.

**Not offered, because no surface on the desktop offers them either**: a copy's **language** (no
write changes it — it is a grain term `collection_update`'s patch does not carry), its **entry
note** and its **tradelist count** (the patch carries both and nothing in the desktop UI writes
them), its **purchase price** (`EditCopy`'s other field — left for a later step), and a wish's
**preferred finish** and **note** (`wishlist_entries` has no update command; the finish is drawn in
the sheet's subtitle). Folder management — create, rename, delete — is left too: the desktop does it
on shelf headings and in a strip above the wall, neither of which is a dialog the phone could host.

**The card sheet's adds** are two rows of 3.5a's slot list (`card/Actions.tsx`), on every card:

- **Add to collection** — one copy into **the root**, the card modal's destination, through the
  menu's write (`useCollectionAdd`, `MENU_CONDITION`). Where the printing is sold more than one way,
  the quick-add popup's finish chips sit under the press (a radio group, opening on the printing's
  first finish — so a press without a look is the modal's add exactly).
- **Add to wishlist** — this printing, or `Any printing` beside it (the popup's other answer, keyed
  on the oracle card; absent for a printing that has lost one), through `useWishlistAdd`.
- Each has its own receipt, and **its `Undo` is the desktop's stepper one copy back** —
  `set_quantity` to the count before the add, which deletes a row the add made. The desktop offers
  no undo for an add; this is the nearest write it makes, and the button's name says what it takes
  back.

**A fold is stored now**, through `useCollection`'s and `useWishlist`'s `setFold` — `useShelfFolds`,
the desktop's own write, only where a fold leaves its shelf kind's default, and nothing while a
filter is on (the desktop's C-I2 ruling). §7.2 held folds in the page for two reasons. *Nothing on
the phone face writes* is gone. *`mobile:tauri` shares the desktop's `app_meta`* does not survive a
second look: that is a dev arrangement, not a product one, and the two faces of one install are one
app over one database — the light app's own rule is that light is the menu and the face, never the
data — so a fold pressed on the phone face and found again on the desktop face after a resize is the
cabinet being one cabinet. A reader who folds a 600-card binder away on a phone now finds it folded
at the next launch, which a page-held fold could never do.

**What moved in `src/`**, each re-exported or called from where it was, no desktop test changed:

- `CollectionPage` → **`useCollectionEntryWrites.ts`**: the stepper, the removal and the bulk
  removal with its undo offer, and the cache arithmetic they share. Its `countEditable` and
  `quantityBlocked` → **`entryFences.ts`** (`countEditableIn`, `quantityRefusal`), pure, with a test.
- `WishlistPage` → **`useWishEntryWrites.ts`**: the stepper, the removal, the filing and back to any
  printing, plus `setPrinting` (the modal's repoint, which keeps its own copy because it closes
  itself on the answer).
- `EditCopy`'s save and the card modal's `Edit` writes → **`useCopyWrites.ts`**; `useCardMenuDeps`'
  two adds → **`card/useCardAdds.ts`**; `UndoNotice`'s behaviour → **`useBulkUndoAction`** in the
  same file. `AllPrintingsDialog`'s own copy of the printing write is left where it is.

Driven at 360 and 800 wide over `starter`, in headless Chromium 141 on Linux with touch emulation:
nothing scrolls sideways — the wall, a tile's sheet, a tile's copies, the printings and folders
pages, a deck group's fenced copy, the receipt with `Undo`, a wish's sheet and printings, and the
card sheet's adds with a receipt.

### 7.6 Step 3.6 — import and export on the phone (2026-10-03)

**Import and export are the desktop's own decisions in sheets drawn for a finger.** Nothing that
turns a list into cards or cards into a list was written twice: the parser, the resolver press,
the four planners, the destinations' second steps, the seven writers and the field registry are
the ones the desktop dialogs use, and the golden fence (`src/features/transfer/__golden__/`) is
untouched. What the phone owns is the drawing, where its choices are remembered, and the file.

**On the deck page** the foot grows a joined pair — the desktop's mirror glyphs, 44px each, drawn
without their words because at 360px `Add cards` needs the room; the names (`Import cards into this
deck`, `Export this deck`) carry the meaning.

- **Import** is a full-window sheet (`phone/transfer/ImportSheet.tsx`). Its first step is the
  phone's: a 16px monospaced box that fills the width, the line and card counts as they are typed,
  `Choose a file…` (a 44px button pressing a hidden `<input type="file">`), the Windows-1252
  notice under a file that needed it, and a full-width `Preview`. **The second step is the
  desktop's** — `DeckPreviewBody`, the deck preview with its tally, its unmatched lines, Merge or
  Replace and the "I own these" box — under a touch floor set from the container (every button and
  every `<label>` at least 44px, every text box 16px), the filters sheet's arrangement. The import
  lands in the list the page is showing, and the preview's own sentence (`9 cards imported.`) is
  said in the page's receipt line, where the deck's undo is offered as for any other write: over
  the fake, `deck_import_commit` files a step and `Undo` appeared.
- **Export** is a bottom sheet (`ExportSheet.tsx`): the seven formats as 44px chips that wrap, the
  fields this format and this surface share as 44px checkbox rows in two columns, the Arena and
  inactive-pile boxes where they apply, the desktop's three omission lines word for word, the text
  behind a `Show decklist (N lines)` disclosure that opens shut, and `Copy` / `Download` at the
  foot. The subject, the cards and the file name are the editor's `exportSubject` — the whole list
  on screen, switched-off piles included and left to the format — so a phone export of a deck is
  titled, filled and named as the desktop's `Export deck` is.

**`CollectionTransfer`** (`phone/transfer/CollectionTransfer.tsx`) is the collection's pair, with
its words, built self-contained because step 3.2 is rewriting the Collection page: the same two
sheets over the collection destination, and the desktop's `UndoNotice` under the pair — the
collection preview files its undo ticket in `@/lib/bulkUndo` as it does on the desktop, so a phone
import reads `Imported 4 cards into your collection.` with `Undo`. Export sweeps whatever `filters`
the host hands it through `useExportScope` (the wall it draws, the desktop's rule), gated on the
sheet being open; with none it sweeps the whole collection, says `N cards in your collection` and
draws no box to widen what is already everything. A host that already draws the collection's undo
notice passes `undoNotice={false}`. **It is mounted nowhere yet**: the collection header takes it
at merge.

**The file seam is a browser stand-in, and every install draws it the same way.** The spec puts
file open and save below `Core` (§3.5); phase 3 adds no command and no host seam, so
`phone/transfer/browserFiles.ts` answers with the web host's own APIs: a picked `File`, read and
decoded; a `Blob` handed to an `<a download>` and its URL released a task later; and
`navigator.clipboard.writeText`, which rejects where the browser offers none rather than claiming
a copy. It is not in `src/lib/`, because the desktop cannot share it — its whole rule (issue #545)
is that no file handle reaches the page. When phases 4 and 5 seam it, this module is what moves.
(**It moved on 2026-10-04, step 5.4 — §9.4**: the read, the decode and the download are
`src/lib/core/browserFiles.ts`, which the web host's own file commands read too, and the copy is
`@/lib/clipboard`'s on both faces, refused in the same sentence.)

- **The decode follows `import.rs`'s order** — a UTF-8 mark, a UTF-16 mark, valid UTF-8, then
  Windows-1252 — and refuses a file over the megabyte in that file's own sentence before reading a
  byte. **The Windows-1252 step is the backend's 32-entry table, not `TextDecoder`**: Node's decoder
  reads that label as Latin-1 and turned `0x92` into a C1 control rather than `’`, which the seam's
  own test caught. A browser gets it right; a table cannot disagree with itself between engines.
- **A download cannot say whether it landed.** The desktop's `saveExport` answers whether a file
  was written; a download is handed to the browser and the sheet says `Downloading <name>.`, which
  is all it knows.
- **A WebView may not honour `<a download>` at all** — an Android host is phase 4's to answer, with
  the system picker; nothing here asks which it is running in.

**The choices are remembered per surface for the session** (`phone/transfer/prefs.ts`), in a phone
store that opens on the desktop store's own values — both now read `@/features/transfer/prefs`,
so a first export of the collection is CSV on either face and an import's condition opens on
`Not set`. A crossing of the 1024px floor loses only a choice made since launch.

**What moved in `src/`**, each with the old names kept so no desktop caller or test changed:

- `transfer/prefs.ts` — `ExportPrefs`, `ImportDefaults` and their opening values, which
  `useAppStore` now opens on (and re-exports `ExportPrefs`).
- `export/useExportModel.ts` — the field intersection, the two row filters, the text and the count
  lines, out of `ExportDialog`'s body, which now draws from it.
- `import/useImportSource.ts` — the paste, a file's encoding note, the parse, the one resolve press
  and the step machine, out of `ImportDialog`'s body; `resolveLinesOf` is the line shape the
  resolver takes. `ImportDialog` itself is store-free now (its one weld was `useImport` taking
  `DEFAULT_VARIANT` through `useDeck`), though the phone draws its own first step.
- `destinations/CollectionPreviewBody.tsx` and `DeckPreviewBody.tsx` — the two steps, taking the
  import's fallbacks as props; `CollectionPreview.tsx` and `DeckPreview.tsx` are now the desktop's
  store-reading wrappers and re-export the rest. The deck step reads its deck through `useDeckCore`.
  `deckIntoWith.ts` binds the deck descriptor to either step.
- `decks/deckExport.ts` — `exportSubject` and `exportFileName`, re-exported from `DeckEditor`.

**Not done**: the wishlist's import and export (its preview reads the store the same way and splits
the same way — 3.3's); a pile's own `Export cards…` and `Import cards…` (the
editor's category heading menu); reading a list from the clipboard (a read permission the app has
never asked for). The desktop previews' own controls — the radios, the commander candidates, the
dropdowns — are the desktop's sizes inside rows floored to 44px.

Driven at 360 and 800 wide over the `starter` seed (Vite on port 5181, headless Chromium 141 on
Linux with touch emulation): the deck page's foot, the import sheet's paste and preview steps, an
import landing with its receipt and `Undo`, the export sheet shut and open on CSV; and
`CollectionTransfer` mounted in a scratch root over the collection page — its pair, the collection
preview, the undo notice after an import, and the export sheet. `scrollWidth` equalled the
viewport on every one.

### 7.7 Step 3.7 — light Settings, on both faces (2026-10-03)

**The edition grew its Settings entries**: `Edition.settings`, `null` for every panel (the full
edition, so it cannot fall behind a new panel) and `LIGHT_SETTINGS` for the light one — `prices`,
`sync`, `review`, `hidden-tags`, `theory-marks`, `labels`, `cache`, `errors`, `danger`. Left out:
`updates` and `backup` by the spec's name, `data-folder` (a path a browser or a phone cannot
open) and `start-view` (a light install opens where its URL says). `edition.ts` carries each
reason. `SettingsPage` is the edition's second reader, as spec §3.1 grants; `nav.ts` grew
`panelsOf` and `groupsOf`, and a rail entry with no panel in it is not drawn.

- **The desktop face** lands on the first entry it draws (`Card data`, where the full edition's
  is `Updates`), searches only what it draws, and drops a hand-off naming a panel it leaves out.
  The full edition is unchanged; no existing test was edited.
- **The phone face** lists the same six groups as 52px rows; one opens at a time, its panels drawn
  beneath it by the desktop's own components, its row pinned while they scroll. The group is not
  in the URL, so Back leaves Settings from an open group as from a closed one. No search box.
- **`SyncPanel` was welded** through `@/lib/externalLinks` (the plugin-opener, for *Connect
  Patreon*). It is now `SyncPanelBody`, which takes `openLink`, and a one-line `SyncPanel` that
  hands it `openExternal`; the phone face hands it a `window.open` until the host seam for opening
  a link exists (phases 4 and 5). (**It exists since step 5.4 — §9.4**: `openExternal` is the
  host's, and the phone's Settings draws `SyncPanel` itself. The body keeps the prop for its
  suite.)
- **Driven in Chromium over the fake** (`mobile:dev`, which this record puts on port 5176 — the
  config's port for that script was 5175 then and is now, so the pass named another by hand or
  the figure is a slip; **since 2026-10-04 port 5176 is `web:dev`'s**): every group opened at 360 wide
  with no sideways scroll (`scrollWidth` 360 for each), the Clear collection dialog over the
  window rather than the list, the sync group at 800 in a `max-w-2xl` column, and the desktop
  face at 1280×800 with six rail entries and `dropbox` matching nothing.

**Open**: the phone face mounts no `useMarketplaceProgress`, so a price feed refreshed from the
phone's Settings reports through its own mutation and the status read but not the progress event
(`AppShell` is that hook's one caller); the Mana Pool row is still offered in a browser, which spec
§4 says it should not be (the host-capability question is phase 5's); and the Sync panel's
*Scan a code* asks for a camera on a host that may not grant one — phase 6's, with sync itself.

### 7.8 Step 3.8 — the desktop face in the light edition, and the shell (2026-10-03)

**Build: `vite --config vite.mobile.config.ts --mode fake` (Vite's dev server, not a bundle) over
the Storybook fake's `starter` seed, driven by Playwright in headless Chromium 1194 on Linux.**
No `?art=live`, so every card is its placeholder. The desktop face was driven at device scale 1
with no touch; the phone face with mobile emulation (touch, scale 2). Nothing here was measured on
a phone, a tablet, Windows or a production bundle.

#### The desktop face below its 700px height floor

Widths 1024, 1100 and 1280 at heights 560, 600, 650 and 700, on Search, a card modal, a deck
(`/decks/1`) with its import and export dialogs, Collection with its import and export dialogs,
Wishlist, Settings and Scanner. At every size `documentElement.scrollHeight` equalled the
viewport — nothing scrolls the document.

| What | 1100 × 600 | 1280 × 650 | 1024 × 700 | 1024 × 560 |
| --- | --- | --- | --- | --- |
| A deck's *Import a decklist* | 540 tall, its body scrolls (400 of 451) | 585, scrolls (445 / 451) | 591, fits | 504, scrolls (364 / 451) |
| Export (a deck's, the collection's) | 363 / 411, fit | fit | fit | fit |
| The card modal's middle column | fits, 3 columns | fits, 3 columns | **0px tall** | **0px tall** |

- **The rail fits to 560**: its six rows and Collapse, Collapse's foot at 525.
- **The deck editor stays usable at 600**: header, stats, the view row and the quick-add row take
  the top ~270px, and the stacks and the docked search panel scroll in what is left (~330px).
- **The card modal breaks, and it is not the height.** The panel is `Dialog`'s, inset 80px a side,
  so a window between 1024 and about 1062 wide draws it at 864–899px — under its own
  `@min-[900px]/card` rung, at the two-column one. There the grid's rows are
  `minmax(0,1fr) auto`: the rail of options takes its whole content height (eight rows and more
  over the fake's card), the printings-and-prices column above it gets what is left, and the rail spills
  over the footer. Measured: the middle column **0px** at 1024 × 700 and 1024 × 560, 34px at
  1024 × 800 and 1060 × 800, 194px at 1024 × 1000. **1024 × 700 is the desktop window's own
  floor**, so this is the full edition's bug as much as the light one's — `tauri.conf.json` lets a
  reader size the window there. Not fixed here: the modal's grid is a measured arrangement with
  its own reasons at every class, and a fix belongs in a change of its own that drives the shipped
  window too. Screenshots `3.8b-desktop-card-modal-1024x700.png` and `…-1024x560.png`.
- Nothing else was cheap to fix because nothing else broke.

#### The tablet rail — decided: a rail from 600px

The band between 600 and 1024 is a portrait tablet, an unfolded foldable, or a phone on its side.
Measured after the change (the "before" column is the bar's 53px given back, and the wall at the
old width):

| Viewport | Before: the bar | After | The wall |
| --- | --- | --- | --- |
| 360 × 800 | 2 columns | unchanged — a bar below 600 | 2 × 162px tiles |
| 599 × 900 | 3 columns | unchanged | 3 × 184px |
| 600 × 900 | 3 columns | rail 80 × 850 | 3 × 157px |
| 800 × 1280 | 5 columns of ~144px | rail 80 × 1230 | 4 × 165px |
| 915 × 412 | page 309px tall, **under one row** | rail 80 × 362, page 362 | 5 × 153px, one whole row |
| 740 × 360 | — | rail 80 × 310, five tabs of 62px | 4 × 150px |

**On the phone on its side the vertical is what is scarce**, and the bar's 53px was a sixth of
what the page had: at 915 × 412 the wall drew less than one row. The rail spends 80px of width
instead, which on a portrait tablet costs one column out of a height it has to spare, and each
tile gets bigger. Upright below 600 nothing changed — the spec's measurement there stands. The
rail asks the viewport's width and nothing else; the tabs are links in the same document order at
every width (`flex-row-reverse` draws the rail on the left), and in the rail each is a share of
the column between 44 and 64px, because five 64px rows do not fit a 360-tall landscape screen.
Screenshots `3.8b-tabbar-before-{915x412,800x1280}.png` and `3.8b-rail-{915x412,800x1280}.png`.

#### The bars beside a cutout

Driven with `Emulation.setSafeAreaInsetsOverride` (left 44, bottom 20): at 560 × 360 the header's
row is padded 60px on the left (16 + 44), the bar paints from x 0 and pads its tabs 44 and 20, the
page is padded 44; at 915 × 412 the rail is 124 wide from x 0 (80 + 44) and the page beside it is
padded 20 at the bottom and nothing on the left. `scrollWidth` equal to the width at both. **The
page's own sticky line (Search's box) still stops at the inset** — it is the page's bar, under
`pages/`, and bleeds when that page chooses to. Screenshots `3.8b-cutout-*.png`.

#### Decided without a measurement

- **A view the light edition does not draw.** The collection's *Open a shared collection* is
  hidden where the shell answers `useReaches("shared")` with false (`src/lib/reach.ts`, provided by
  `AppShell` from its edition) — so a page asks whether a destination exists here, never which
  edition it is in — and `useDesktopPlace` refuses any store move onto such a view, putting the
  store back on the URL's place without touching history. Hidden rather than refused on the press:
  a link that answered would have nowhere to land, and a share link is a web page a browser opens
  anyway. At 1280 × 800 the collection draws Import and Export and no Open half.
- **A publish the light hosts cannot make** (2026-10-07). The collection's *Share* half was still
  drawn for an entitled device in the desktop face — the web app at 1024px and up, an Android
  tablet — though the five `share_*` commands are registered by the desktop host alone and
  `grimoire_core::commands` has none of them, so its list and its publish answered *"There is no
  command named … on this host."* The edition now says `publishes: false`, `AppShell` answers
  `usePublishes()` from it beside `useReaches`, and `ShareFolderMenu` draws no Share half and
  asks no `share_list` where it is false. Still a capability rather than a platform question: the
  page never learns which edition or host it is on. The phone face never drew the control.
- **`Ctrl+Shift+N`** is the full edition's alone; in the light edition the press is left to the
  browser, where it is the browser's own private-window chord.
- **`F1` stays the browser's.** Mounting the key map without the caption row would mean an
  edition-aware catalogue — it lists chords this edition makes inert — for a keyboard story that
  belongs to the web host (phase 5).
- **The two history warts are closed by two marks** in `routes.ts`, which both faces read:
  `PUSHED` (the phone router's; its card entry has the same page directly beneath) and `OVERLAID`
  (a card the desktop face wrote onto an entry by replace). Driven both ways at 360 ↔ 1280:
  - a card the phone pushed, closed on the desktop face with Escape: `history.back()` to
    `/search` with `history.length` unchanged, and the next Back went to `/decks`, the page
    before — not to a second `/search`;
  - a card the desktop opened (`history.state` `{ overlaid: true }`), narrowed to the phone face:
    the entry was split (`{ pushed: true }`, length +1, the address bar unmoved), Back closed the
    sheet onto `/search`, and the next Back went to `/collection`, the page before.
  A card reached by a link is neither and keeps the old rule on both faces. **One race is left**:
  the desktop face's close is a `history.back()`, and a card opened again before that traversal
  lands is closed by it.
- **A crossing still discards half-typed text, and that is accepted.** Holding the face while a
  text field has focus would draw the desktop UI below its floor — the rule `mobile/CLAUDE.md`
  exists to keep — and would freeze a resize for a caret in an empty search box: the app has no
  signal for *unsaved* that covers a controlled input and the note editor alike, and a debounce
  protects nothing typed. The realistic trigger is a tablet rotating across 1024; what it costs is
  re-typing, and what would prevent it is keeping both faces mounted, which this step did not buy.

#### The fences and the tooling

- **Stories for phone UI**: Storybook's story glob, its stylesheet's `@source` and
  `src/stories.test.tsx`'s module glob reach `mobile/` (the desktop's own `src/index.css` does
  not, so the desktop bundle carries no phone class). `Shell`, `TabBar` and `CardWall` have
  stories; a page's stories come with its step. `npx storybook build` listed `phone-shell`,
  `phone-tabbar` and `phone-cardwall`, and the phone-only `.h-13` was in the iframe's CSS.
- **`src/lib/tokens.test.ts` reads `mobile/`**, every sweep of it. The one exception it kept is
  the `MotionConfig` count, which is now one mount per face — `src/App.tsx` and
  `mobile/phone/PhoneApp.tsx`, each with `reducedMotion="user"`. A planted third mount and a
  planted transition with no reduced-motion opt-out each went red. Nothing in `mobile/` violated
  it.
- **The fence's blind spots are closed** (`mobile/phone/fence.test.ts`): an `import.meta.glob`
  pattern is followed to every file it matches, a root-absolute specifier is followed, a
  template-literal `import()` with nothing interpolated is read as a string and any other
  non-literal `import()` is refused; the comment stripper is one pass that knows strings,
  templates and regexes, and over every non-test file in `src/` and `mobile/` it finds exactly the
  specifiers the old one did; the probe sweep catches `userAgent` however it is spelled,
  `navigator.platform` by dot, bracket or destructuring, and `@tauri-apps/plugin-os`. Each new
  rule has a case that fails on a tree with the weld.
- **The fake's four aliases are one list**, `.storybook/fake/aliases.ts`, read by Storybook and by
  `vite.mobile.config.ts`. The light config's own copy of the watch-ignore globs was deleted:
  `vite.watch.ts` (#760) already gives every server the same list, which also settles the `EBUSY`
  sentence in §4.

## 8. The Android host — phase 4, a step at a time

**Decided by Markus, 2026-10-03**, before anything was built: **the APK is built in CI** (this
session's container could not reach `dl.google.com` — the egress proxy answered 403 — so neither
the SDK nor the NDK could be installed; the `ubuntu-24.04` runner ships both and JDK 21); **two
pull requests to start**, the host and then the command table; **a debug-signed APK** until a real
phone has run it; and **tablets keep the width rule** — an Android tablet at least 1024px wide gets
the desktop face, as a wide browser does, because pinning it to the phone face would need the host
to tell the page what it is.

### 8.1 Step 4.1 — the host, its seam and the APK (2026-10-03)

**What was built.**

- **`mobile/src-tauri`, a second Tauri project and the workspace's third member** (`grimoire-light`,
  library `grimoire_light_lib`, crate types `staticlib`/`cdylib`/`rlib`). It holds almost nothing:
  the mobile entry point (`run`, `#[cfg_attr(mobile, tauri::mobile_entry_point)]`), **one command,
  `core_call(name, args, body)`**, which forwards to `grimoire_core::dispatch`, the startup gate
  the page waits on, and the `mtgimg` protocol. No plugin. `core:default` is its one capability.
- **`startup_status` is answered inside `core_call`**, not by the core: it is the question asked
  before the state exists. The shapes are the desktop's (`useStartup` is one file for both hosts),
  and any other name before the state lands is told the app is still starting.
- **The launch is the desktop's less what only the desktop has**, on a `startup` thread:
  `grimoire_core::launch::open` (new — corpus replacement, the write connection brought to head,
  the read connection, the image cache, the Scryfall client with any stored 429 lockout re-entered),
  `State::new` with an event sink that forwards to the page and **no write observers**, then the
  facet index, the image upkeep thread, `settle(Ready)`, the corpus check, and the card sync with
  the optional feeds behind it on a first run (issue #551's rule). No mirror, no updater, no second
  window, no live socket (phase 6). (**It runs one since step 6.2, with live sync's wake as its
  one write observer — §10.2.**)
- **The image answer is the core's now**: `grimoire_core::images::{Reply, answer}` — the status,
  the three headers that carry meaning and the body, with no HTTP crate in it. The desktop's
  `respond`/`fail`/`not_ready` became one `to_response` over it, and its seven tests of that answer
  run through the conversion unchanged. One contract for both hosts' protocol handlers.
- **The `Core` seam picks the transport by a mark, below `@/lib/core`.** The host calls
  `append_invoke_initialization_script("window.__GRIMOIRE_CORE__ = \"table\";")`, and
  `src/lib/core/index.ts`'s `pickCore` sends every call through `tableCore` when it is set —
  `invoke("core_call", { name, args })`, a byte payload as base64 in `body` with its headers as
  `args`, and Tauri's own `listen` for events. `tableCore` calls through `tauriCore` rather than
  importing Tauri's API, so `tauri.ts` stays the fence's one door. Nothing under `mobile/` reads
  the mark (`phone/fence.test.ts`).
- **`imageOrigin` answers `http://mtgimg.localhost` for an Android user agent**, as for Windows:
  Android's WebView serves a custom scheme from that origin.
- **`gen/android` is committed**, generated by `npx tauri android init --ci
  --skip-targets-install` against a stub SDK (an empty `ANDROID_HOME` and an `NDK_HOME` holding
  only a `source.properties` — the generator reads the NDK's version and nothing else). **Hand
  edits, each held by `mobile/host.test.ts`** because a re-init reverts them: `allowBackup="false"`
  and `fullBackupContent="false"`; the `CAMERA` permission with the camera feature *not required*;
  the TV launcher removed; the `FileProvider` narrowed from the whole of external storage and the
  cache to `cache/exports/`; the release build type signed with the debug key; and **Gradle's Rust
  task calling `npm run tauri:light`** (`cd mobile && tauri`, a root script) rather than `npm run
  tauri` — `npm run` starts a script at the repository root, where the CLI finds the desktop's
  project, and the first `android` run failed exactly so: *"Android Studio project directory
  …/src-tauri/gen/android doesn't exist"*, after the release Rust build had finished in 4 m 47 s.
- **CI's `android` job** builds `npx tauri android build --apk --target aarch64` from `mobile/` on
  `ubuntu-24.04` with JDK 21 from the image (`JAVA_HOME_21_X64`) and the image's newest NDK,
  writes the APK's size and the `.so`'s to the step summary, and uploads the APK as an artifact for
  14 days. The router sends it the host's tree, the cargo workspace's shared files and the
  toolchain pin — **not** the fail-safe, which an unrecognised path cannot need, and not
  `crates/grimoire-core/*`, whose Android compile is `core`'s and whose API is compiled against the
  host by `rust`. `mobile/*` got an arm of its own at the same time (`frontend`, `storybook`); it
  had been falling to the fail-safe and running the whole Rust matrix for a phone sheet.
- **release-please bumps the host with the rest** — its `tauri.conf.json` (which Android reads for
  `versionName`), its `Cargo.toml` and its lockfile entry — because one core is one schema version
  and the three hosts ship from one tag. `mobile/host.test.ts` holds the two configs' versions
  equal.

**Measured, 2026-10-03, on Linux** (Ubuntu 24.04 in this session's container, with
`libwebkit2gtk-4.1-dev` installed for the purpose — **the first Linux build of these crates
anyone has recorded**; every desktop figure elsewhere in this repo is Windows):

- `cargo clippy -p grimoire-light -p mtg-grimoire -p grimoire-core --all-targets -- -D warnings`
  clean; the lockfile gained the one package and no other edge.
- **The Tauri CLI picks the project by the directory it starts in**: from the repository root
  `npx tauri info` reports the desktop's (`frontendDist: ../dist`, `devUrl` 1420), from `mobile/`
  the light host's (`../../dist-mobile`, 5175). So `npm run tauri dev`, `tauri-action` in
  `release.yml` and every other root-level invocation still find the desktop.
- `npm run mobile:build` builds the light bundle in 5.0 s.

**Not measured.** Nothing here has run on a phone or an emulator: the APK's first build is this
PR's `android` job, and its size is that job's summary. The cold start, the first corpus ingest on
a phone and whether Tauri's WebChromeClient grants the camera to `getUserMedia` are a device's.
**`core_call` answered the table's 88 reads and refused every write** until step 4.2 (§8.2) moved them in. **The first `android` run that built** (the PR's second push) uploaded an artifact of 10 043 964 B — the zipped APK, about 10 MB.

### 8.2 Step 4.2 — the table covers the light app (2026-10-03)

Issue #761, phase 4. The Android host answers every frontend call through one
`core_call(name, args)`, which forwards to `grimoire_core::dispatch` — so a command the table
lacks is a page that is refused on a phone. Until this step the table held the 88 reads (§6.11)
and every write was on `src-tauri`'s `NOT_YET`. Built and tested on Linux, debug builds.

**The survey, and the rule it settled on.** The light app reaches the phone face's pages and —
on any screen at least 1024px wide, an Android tablet included — the desktop UI itself in the light
edition: Search, Decks, Collection, Wishlist, Scanner and nine Settings panels (`prices`, `sync`,
`review`, `hidden-tags`, `theory-marks`, `labels`, `cache`, `errors`, `danger`). That graph reaches
nearly every write the desktop has, so the rule was **move every `NOT_YET` command a light install
can answer**, a few home-page-only writes included (`set_home_layout`, the sticky notes), and keep
back only those that cannot run yet on a host with no window. Of the **153** on `NOT_YET`,
**136 moved** and **17 stay**:

| Kind | Moved | What they are |
| --- | --- | --- |
| `write` | 97 | every deck, folder, label, note, to-do, token, undo, setting and view-state write; the wishlist's; the wishlist's and the decks' clears; the error log's clear; mute and unmute; the sync panel's status reads and the review queue (their wrappers take the write connection); the Patreon begin; the device rename |
| `owned` | 15 | every write whose wrapper takes `with_write_owned` — the collection's own writes and folder moves, `Recently removed`'s clear, the deck-to-binder move, the pull, the quick add, the deck-wide record, the collection clear |
| `blocking` | 10 | **new** — see below: the five `State`-taking reads (`combos_status`, `sync_status`, both tag statuses, `facet_cards`), `cache_clear`, `combos_clear`, and three that decide before they take a connection (`bulk_undo`, `collection_to_deck`, `sync_review_clear`) |
| `task` | 14 | the card sync, the three feeds' refreshes, the claim, `sync_now`, and pairing's begin, accept, confirm, poll, cancel, revoke and leave |

**What stays on `NOT_YET`**, each group with its reason beside it in `command_table.rs`:

- **`prefetch_images`, `prewarm_collection`** — each starts a fetch nobody waits for and answers at
  once. The core can start background work only as a closure, never a future, so an entry would
  await every fetch before answering; and how a picture reaches a light host's page is that host's
  own question. Every page that asks swallows the refusal.
- **The scanner's ten** (all but its two reads). A session or tray command admits the calling
  window's *label* on the lease, which a table call does not carry; a frame is a JPEG plus a JSON
  header where Android carries base64 (spec §2.4); and the session panics in a browser until
  phase 7. The phone face's Scanner asks for none of them — **but the desktop face's Scanner page,
  drawn on an Android tablet past 1024px, would be refused**: phase 7's to close.
- **`share/`'s five** — the module is still `src-tauri`'s (§6.11). The light edition draws no shared
  view, and the Share control shows only to a connected reader.

**A sixth kind, `blocking`** — the blocking pool, the `Arc<State>`, no connection — which §6.11
said was owed. It is what a body takes when it reads the `State` itself, and when the wrapper
decides something before it takes a connection: `bulk_undo` asks the ticket which table it names
and then takes `with_write_owned` or `with_write`; `collection_to_deck` reads its pile before the
lock; `sync_review_clear` checks a table name from the page against the census before splicing
it into SQL; `combos_clear` takes the connection by hand, as its wrapper does. Folding any of those
into `write` would answer `BUSY` where the desktop answers the refusal.

**What a wrapper did beside the core, and where it went:**

- **Marking `AppState.changes`** — `error_log_clear`, `tag_mute`, `tag_unmute`, `sync_device_rename`,
  `sync_patreon_claim`, `sync_group_leave` — is left out. The mask tells the desktop's *other
  windows* about a write the update hook cannot see; it is `AppState`'s and a light host has one
  window. Each entry says so.
- **Telling the mirror** — `set_marketplace` is `set_marketplace_now` on the desktop, which then
  calls `mirror.mark_all()`. The mirror is the desktop's for good; the entry is the store alone.
- **`sync_now`'s `sync:applied`** went through the window; the entry sends it through
  `state.events`, after the lane is let go, as the desktop does.
- **Where a sync press runs**: the desktop runs one on `sync::on_a_worker`, a thread with a runtime
  of its own; a `task` awaits where it stands, as the kind always has. The stretches in between
  are short SQLite work on whatever runtime thread the host awaits `dispatch` on.

**Tests** — `commands::tests` holds three new ones over the real table and one new arm in the kinds'
own:

- **`a_write_through_the_table_lands`**: `deck_create` through `dispatch`, then `deck_list` answers
  it, then `deck_update` renames it and the core's own `get_deck` reads the new name.
- **`an_owned_write_through_the_table_lands_and_moves_the_index`**: over a seeded printing and a
  warm facet index, `collection_add` through `dispatch` — `collection_list` answers what
  `list_entries` answers and names the printing, the table holds the three copies, and the index is
  published again with one owned card, which a `write` entry would not do.
- **`a_task_through_the_table_holds_the_offer_and_lets_it_go`**: `sync_pairing_begin` mints an
  offer under the state's own lock with no request made, and `sync_pairing_cancel` takes it back.
- **`blocking` through its own arm**, reading and writing in turn — it holds no connection.

**The fence was mutated**: two `i64` arguments of `deck_undo_apply` swapped in the table, and
`every_command_in_the_table_takes_its_wrappers_arguments` went red naming it; reverted. Green:
`cargo test -p grimoire-core` whole, `cargo test -p mtg-grimoire command_table`, clippy over the
workspace with `-D warnings`, `cargo fmt --check` for both crates, `cargo check -p mtg-grimoire`
(the build that ships), and `cargo check` and clippy for `grimoire-core` on
`wasm32-unknown-unknown` (clang 18).

**Nothing on the desktop changed**: no wrapper was touched, and none calls `dispatch`. **The
Android host (§8.1) is the first caller**, through `core_call`; no device has run one yet.

**Open after this:**

- The scanner on the table (phase 7): the lease needs a caller the table can name, and a frame a
  body the Android host can carry.
- The picture warms, once a light host serves pictures and the core can start a future nobody
  awaits.
- `share/`, as §6.11 left it.

### 8.3 Step 4.3 — the back gesture, the insets and files (2026-10-03)

**The back gesture's history walk needed no code, and the record says why.** Read off the
shipped sources (`tauri` 2.11.5's `AppPlugin.kt`): it registers an `OnBackPressedCallback` that
calls `webView.goBack()` while `canGoBack()` and hands the press to the activity only from the
first entry — and the plugin's `back-button` event, which would replace that, has no listener
here. (This paragraph also named `wry`'s `WryActivity` as registering one; it does not here, because
Tauri's `TauriActivity` turns `handleBackNavigation` off — corrected 2026-10-04.) A `pushState` is
an entry `canGoBack()` counts, so the phone router's pushes are exactly what the gesture walks: a
card sheet closes, a folder level goes up. **What the last back does was changed on 2026-10-04**,
after a real phone aborted the process on it (§8.6): `MainActivity` now registers a callback of
its own that moves the task to the back instead of letting the activity finish — §8.6 has the
chain and `mobile/host.test.ts` holds the edit.

**The insets are the host's, as padding rather than `env()`.** From target SDK 35 Android draws
every app edge to edge and no longer resizes a window for the keyboard, and whether a WebView
reports the bars and a cutout through `env(safe-area-inset-*)` is a property of a WebView version
the app does not ship. So `MainActivity` pads `android.R.id.content` by `systemBars()`,
`displayCutout()` and `ime()` — the page is simply smaller, its `100dvh` is the safe area, its own
`env()` insets read 0, and a search box is never under the keyboard. Both bars draw light icons
(`SystemBarStyle.dark`), and the window behind them is `#0e0f13`, the web manifest's
`background_color` — so the bars, the launch and the page's ground agree, two levels off
`--color-bg` exactly as the manifest already is (§5, phase 5's). (**`#0C0D12` since step 5.4 —
§9.4**: the token's own sRGB value, in the manifest, the page's `theme-color` and `colors.xml`
alike. No device has drawn the new ground.)

**Files.**

- **Picking needed no seam.** wry's `RustWebChromeClient.onShowFileChooser` answers an
  `<input type="file">` with the system picker and hands the page a `File` over the chosen
  `content://` document, which the page reads as it reads any other. `phone/transfer/browserFiles.ts`
  keeps the read and the decode (`src/lib/core/browserFiles.ts` since step 5.4). **One catch,
  found in review**: both that chooser and the dialog
  plugin turn each extension into a MIME type through `MimeTypeMap` and drop the ones it does not
  know, so `.dec` and `.dek` were greyed out. `DECKLIST_ACCEPT` now carries
  `application/octet-stream` — what the system picker calls a file of an unknown extension — and
  the host's own picker passes no filter on a phone.
- **Saving did.** A WebView has no download manager for a `blob:` URL, so a `Blob` and
  `<a download>` saves nothing on Android. `@/lib/core/files`'s `saveText` is the seam: on the
  light host it calls the desktop's own `export_save_file` — answered by the host, not the table —
  and in a browser it is the download it was. The phone's export sheet now says `Saved Burn.txt.`,
  says nothing for a cancelled dialog, and still says `Downloading Burn.txt.` in a browser.
- **The host answers the desktop's two file commands by their names and arguments**
  (`mobile/src-tauri/src/files.rs`): `export_save_file(fileName, contents) -> bool` and
  `import_pick_file() -> ImportFile | null`, through `tauri-plugin-dialog` (the Storage Access
  Framework on Android) and `tauri-plugin-fs` (`Fs::open`, which on Android asks the Kotlin side for
  a descriptor for the `content://` URI). So the desktop face, drawn on a tablet past 1024px, saves
  and picks as it does on Windows. No URI crosses to the page in either direction, the desktop's
  rule (issue #545); the capability grants no `dialog:` or `fs:` permission. (This said *or
  `opener:`* too until 2026-10-04, against the paragraph below and against
  `capabilities/light.json`, which holds the opener pair for the desktop face.)
  `read_bounded` and `suggested_name` moved into the core's `import` so both hosts share the
  megabyte cap and the name rule.

**Links.** `mobile/src-tauri/src/navigation.rs` is the desktop's `app_origin` guard restated for this
host's origins, with one addition: an `http(s)` link off the app's pages is handed to the system
browser through `tauri-plugin-opener` (an intent on Android) and the window stays where it was; any
other scheme is refused. So a deck note's link opens the browser rather than replacing the app.
**The hand-off runs off the hook's thread, and a reviewer found why it must**: on Android the
hook is called on the UI thread (wry's `shouldOverrideUrlLoading`), and the opener's mobile arm
waits for a Kotlin command that the UI thread's own looper runs — called inline, the first web
link would have frozen the app for good. The dev server's origin is the config's `devUrl` read at
run time, since `tauri android dev` may serve from the machine's address. **The desktop face** —
a tablet past 1024px — opens its links through `@tauri-apps/plugin-opener` from the page, so the
capability grants the desktop's exact pair, `opener:allow-open-url` and `opener:allow-default-urls`.
**What this does not do** is give the phone card sheet its `Open on …` rows — those are still not
drawn; with the guard in place they can be plain links. (**Drawn since step 5.4, as plain
links — §9.4.** The plugin is no longer imported by `externalLinks.ts`: `src/lib/core/tauri.ts`
names it, `src/lib/core/index.ts` picks it as this host's way out, and a press on either face
that has to compute its address first — *Connect Patreon* — goes through it. The clipboard on
this host is the WebView's own, since the host registers no clipboard plugin.)

**Measured, 2026-10-03, on Linux**: clippy clean on the three crates with the plugins in;
`cargo test -p grimoire-light` adds the guard's four tests and the file module's two; the lockfile
gained only `tauri-plugin-fs`'s edge from the host. **Not measured**: every claim above about a
device — the back gesture, the padding, the system dialogs, the browser hand-off — is read off the
sources and pinned by text, not driven. A phone or an emulator is step 4.5's.

### 8.4 Step 4.4 — the mobile-data prompt (2026-10-03)

The spec's §4: *"Any feed over 5 MB shows its measured size and, where the connection reports
itself metered, defaults to Not now."* Every launch download this repository has measured is over
5 MB — the card file 77 MB, Card Kingdom's prices 63.7 MiB and Mana Pool's 48.4 MiB, the combos
27.5 MB, the art tags 12.5 MB, the oracle tags 5.85 MB — so on a metered link the rule is: ask
before any of them.

- **The host decides whether to ask, and the page only draws the question.** The Android host asks
  `ConnectivityManager.isActiveNetworkMetered()` over JNI at launch (through the activity tao
  keeps; `ACCESS_NETWORK_STATE`, a normal permission, is in the manifest for it). On a metered link
  where the reader has not said *always*, it starts none of the launch's downloads and holds them.
  **The check fails open**: a JNI call that cannot be made answers *not metered*, and the launch
  downloads as it always has. **The hold is decided before the page is told it may mount**
  (`startup::settle`): the prompt asks once, as it mounts, and a review found that deciding after
  `settle` let that question read `held: false` a moment before the hold came down — a metered
  first run with no cards and no prompt.
- **Two host commands**, answered inside `core_call` beside the file commands:
  `light_downloads` → `{ held, metered, due }`, each due download over 5 MB with its size, and
  `light_downloads_start { always }`, which starts exactly what the launch would have — the card
  sync, then the feeds behind it on a first run — and with `always` stores `app_meta`'s
  `light_downloads_on_metered = "always"`. A second press, or a press on a launch that never held,
  starts nothing.
- **What is due is the core's**, `grimoire_core::downloads::launch_due`: each feed's own launch
  rule (`combos::due_at_launch`, `tags::due_at_launch`, the new `marketplace_feed::selected_due`
  that `refresh_selected_if_due` now uses too) and the card sync's throttle, with each measured
  size beside it. A due card check may cost a few hundred bytes — the file has not rotated — and
  is listed anyway, because Scryfall rotates it daily.
- **The prompt is `mobile/DownloadsPrompt.tsx`, mounted by `LightApp` above both faces.** It asks
  `light_downloads` once and draws only when the host says it is holding: the desktop binary under
  `mobile:tauri` and the Storybook fake have no such command, and a refusal is nothing to ask. Not
  now is the first button and Escape and the scrim are Not now too; it sends nothing, and the next
  launch asks again. Sizes are decimal megabytes rounded up, prefixed *about*.

**Measured, 2026-10-03, on Linux**: the core's `downloads` tests (a first launch owes cards, combos
and both tag files; a feed-backed marketplace adds its price list at its own size; a card check
made an hour ago is not due), the host's `downloads` tests (an unmetered launch starts at once, a
metered one holds, `always` releases it, only large downloads are listed), and the prompt's
vitest file. **Not measured**: the JNI call has compiled only in CI's `android` job and has never
run; whether `isActiveNetworkMetered` says *metered* on a phone's mobile data is a device's to
show.

### 8.5 Step 4.5 — the first run, on an emulator (2026-10-03)

Issue #761's box — *"First run on a real phone: corpus ingest time, cold start, APK size — none was
ever measured"* — has no phone to answer it, so its first figures come from an **Android emulator
on a GitHub runner**: `.github/workflows/android-emulator.yml`, with the measuring in
`scripts/android-first-run.sh`. The workflow had not run when this was
written; it runs on a pull request or a push to `main` that touches the host, the core or the
lockfile (and on a manual dispatch), so its first run is the pull request that adds it, and its
numbers are that run's step summary and its `android-first-run` artifact. **Its first run, on #800
(run 37162904846), passed** — the first card sync finished on the emulator; its figures are that
run's step summary and artifact, not copied here. The phone figures are §8.6.

**What it does.**

- **Builds an x86_64 release APK** — `npx tauri android build --apk --target x86_64 --ci` from
  `mobile/`, the `android` job's steps otherwise (JDK 21, the image's newest NDK, the composite
  toolchain action, `rust-cache` keyed `android-x86_64`). x86_64 because the emulator is x86_64
  under KVM and cannot run arm64 code; the shipped APK is arm64 (§8.1). **So the `.so` measured
  here is not the one a phone loads**, and its size is the x86_64 compile's.
- **Boots an emulator** with `reactivecircus/android-emulator-runner` v2.38.0 after the README's
  KVM udev rule: API 34, `google_apis`, x86_64, 4 cores, 4096M RAM, a 6000M data partition (the
  corpus is ~900 MB on disk, beside its WAL and the image cache). `google_apis` because its adbd
  runs as root.
- **Measures, in order**, and writes each to the step summary and to `first-run.json`:
  1. **The APK's size** in bytes and the `.so`'s uncompressed size, read off `unzip -l`.
  2. **The first launch's `TotalTime`** from `am start -W` — the time to the activity's first
     frame. The page's startup gate and the databases' creation run on the host's `startup`
     thread, so this figure does not wait for them; it is reported apart from the cold starts.
  3. **The first corpus ingest.** The host prints `launch: card sync started` before
     `run_sync` and `launch: card sync finished in N ms` after it (`spawn_downloads` in
     `mobile/src-tauri/src/lib.rs`, timed with the core's `Tick`; the existing
     `initial sync failed: …` is the other end). Tauri's Android shell pipes stdout and stderr to
     logcat under the tag **`RustStdoutStderr`** — tao's `ndk_glue::create`, unconditionally, so
     a release build logs as a debug one does. The script tees `adb logcat -s RustStdoutStderr`
     into a file from before the launch, because logcat's ring buffer can turn over in 45 minutes,
     and reports **N** — the host's own figure, download and ingest together — beside the wall
     clock from `am start` to the line's appearance (±10 s, the poll).
  4. **`corpus.db` and `user.db` on the device** the moment the ingest finished, and the app's
     whole private folder. **The data folder is `/data/data/com.mtggrimoire.app/data`**: the host
     opens `app_data_dir()/data`, and Tauri's Android `PathPlugin.getDataDir` answers the
     activity's `dataDir` (read off `tauri` 2.11.5's sources, not seen on a device). **A release
     build is not debuggable, so `run-as` refuses it**; the script reads the folder through
     `adb root`, which a `google_apis` image allows, falls back to `run-as`, and otherwise writes
     *not measurable on a release build*. The optional feeds start behind the sync on a first
     run, so `corpus.db` keeps growing after this figure.
  5. **A screenshot** after the ingest (`adb exec-out screencap -p`), and another after the last
     cold start, so a person can see the phone face as the emulator drew it.
  6. **Three cold starts**, each `am force-stop`, five seconds, `am start -W`; each `TotalTime` and
     the median. **Process-cold, not cache-cold**: the page cache still holds the APK and the
     databases.
- **Fails when there is no ingest figure**, after writing what it did measure: a sync that
  failed, one still running at 45 minutes, or none started within 60 s of the launch. That last
  is step 4.4's hold — the host starts nothing when Android says the network is metered — and the
  summary says *held — the emulator reported a metered network* (or *the app died before the card
  sync started*, when its process is gone), with the host's last stderr lines. The emulator's
  default Wi-Fi is expected to report itself unmetered — expected, not checked here — and
  `dumpsys connectivity` goes into the artifact so a held run can be read.

**What an emulator cannot stand in for.** The emulator's CPU is the runner's, through KVM — a
cloud x86 core, not a phone's big.LITTLE ARM cluster — so the ingest figure says how the code
behaves, not how long a reader waits. Its storage is a file on the runner's disk, with none of a
phone's flash characteristics. A phone throttles under a sustained load like a 45-minute ingest
and an emulator does not. The emulator's network is the runner's datacentre link, never a real
cellular one, so a real metered link — and whether `isActiveNetworkMetered` says *metered* on
mobile data — is still a device's to show. The emulator draws through SwiftShader, in software
(the action's default `-gpu swiftshader_indirect`).
And the APK is x86_64, a different compile of the same source. **Every figure from this workflow
is an emulator figure and is to be named as one**; the issue's box stayed open for a phone, which
§8.6 closed.

### 8.6 The first run on a real phone (2026-10-04)

**Run on Markus's phone on 2026-10-04, 02:17–02:28 CEST**, by a local session that drove it over
`adb shell input` and `uiautomator dump` (the WebView exposes its accessibility tree to it) and
changed no code. The APK was CI run 37163586973's `mtg-grimoire-light-arm64` artifact, built from
`main` at `2abf2d7a` — the arm64 **release** build, signed with the CI debug key — on a clean first
install (`com.mtggrimoire.app` was not on the phone; a separate `com.mtggrimoire.app.debug` was,
and was left alone).

| | |
| --- | --- |
| Device | OnePlus `CPH2581`, SoC `SM8650`, `arm64-v8a` |
| Android | **16** (SDK 36); WebView `com.google.android.webview` 153.0.8010.36 |
| Display | 1080 × 2376 @ 480 dpi (an override of the panel's 1440 × 3168) → **360 × 792 dp** |
| Navigation | Gesture navigation, guide bar hidden |
| Network | Wi-Fi, `NOT_METERED`, ≥ 110 Mbps down |
| App | 0.40.0 (versionCode 40000), targetSdk 36, minSdk 26 |

**The figures** — every one a release build, on that phone:

| | |
| --- | --- |
| APK | **35 023 411 B** (33.4 MiB); the zipped CI artifact 12 322 058 B. `adb install` 3.5 s |
| First launch | `am start -W` → **`TotalTime` 158 ms** (`WaitTime` 162, `COLD`); the loader at +1.0 s, the phone face on Search at +5.4 s; process start to `launch: card sync started` 0.33 s |
| First card sync | **18 745 ms**, the host's own figure (`launch: card sync finished in 18745 ms`); ≈ 19.2 s wall clock from `am start` |
| The feeds behind it | Oracle Tags and the combos were on the card sheet by three minutes in, with no log line of their own; the process was at 0 % CPU 70 s after the sync, 48 s of CPU used in all |
| Later launches' sync | 13, 10 and 7 ms — the daily throttle |
| Cold starts | `am force-stop`, 5 s, `am start -W`: **108, 113, 112 ms — median 112 ms** (two more later: 117 and 112); the wall drawn with pictures 1.5 s after each. Process-cold, not cache-cold |
| On-device data size | **Not measurable**: a release build refuses `run-as`, and `dumpsys diskstats` had no row for the package yet |

No `initial sync failed`, no panic, no `E/AndroidRuntime`, no ANR and no tombstone in the
100 882-line capture. **Against §8.5's emulator caveats**: these are a phone's CPU, flash and
WebView, over Wi-Fi — what a reader on a fast home link waits — and the APK is the shipped arm64
compile.

**Ten checks — eight pass, one fails, one not run:**

| # | Check | Result |
| --- | --- | --- |
| 1 | Search "lightning bolt" draws results with pictures | Pass — 3 cards, prices in the chins |
| 2 | The card sheet: printings, prices, legality | Pass — 68 printings · 51 release dates, a price row, *Legal in 15 of 23 formats · banned in 1*, oracle tags and combos |
| 3 | The back gesture closes the sheet; from the start page it leaves | Pass — a left-edge swipe closed the sheet with the query intact; after three tab moves four backs walked Decks → Collection → Search → launcher (but see finding 2) |
| 4 | Nothing under the bars, the cutout or the keyboard | Pass, partly exercised — clear in both orientations, landscape padded 120 px on the cutout side; the search box, the results and the tab bar sat above the keyboard. The nav-bar inset was 0 (the gesture bar hidden); 3-button navigation not tried |
| 5 | A card added to the collection appears in Collection | Pass — *Added 1 × Lightning Bolt…* with Undo, 1 card / 1 unique, still there after a force-stop |
| 6 | Create a deck and add a card to it | **Fail — not reachable**: the Decks page said *No decks* and offered nothing |
| 7 | Export: the save dialog opens and the file is written | Pass — the system dialog on `collection.csv`, *Saved collection.csv.*, 84 bytes in `/sdcard/Download` |
| 8 | The import picker offers `.txt` and `.dec` | Pass — both enabled and read (*2 lines · 3 cards*), a `.json` greyed; the `.txt` reached the preview, not committed |
| 9 | Landscape: the tab bar becomes a rail | Pass — at 792 dp the five destinations are a rail and the wall four columns |
| 10 | The mobile-data prompt | Not run — and this phone may not show it: `dumpsys connectivity` has its carrier's cellular network `NOT_METERED` too, so `isActiveNetworkMetered()` may answer *false* on mobile data |

**What it found:**

1. **No deck can be created on the phone face** (check 6). The gallery's empty state was
   `<DimNote>No decks</DimNote>` and `decks.test.tsx` asserted it offered nothing; the card sheet
   offers the collection and the wishlist only. A phone never reaches the 1024px face and a light
   install has no sync, so a light install had no way to its first deck — and no deck write had
   run through `core_call` on a device.
2. **The Search wall still said *No cards match.* after the first sync finished** (6 s and 36 s
   after it), and nothing showed progress during it. Typing a query brought results at once; the
   next launch drew the wall.
3. **Leaving by the back gesture ended the process with a bionic abort**, both times:
   `FORTIFY: pthread_mutex_lock called on a destroyed mutex`, then `has died: cch CRE`. No dialog,
   no tombstone, data intact, the next launch a normal cold start.
4. **A first launch logged that the card database "could not be opened and has been replaced"**
   when there was no database to open. Log only.
5. **Typing a query lit the Filters button as *1 active*** with no filter chosen in the sheet.
6. **Export's button said *Download*** on a host where it opens a save dialog and reports *Saved*.
7. WebView noise, twice at one cold start while the wall drew, with no visible effect:
   `tile memory limits exceeded, some content may not draw`.

**Fixed since — the three wording findings (4–6), in one pull request.**

- **(4)** `schema::replace_unreadable_corpus` took its replace path whenever
  `corpus_is_readable` said `false` — and it says `false` for a file that is not there, so a
  clean install deleted nothing and logged the sentence. A missing, unmarked corpus now answers
  `false` in silence (the `ATTACH` creates it); a damage mark over a missing file still takes the
  old path so the mark is cleared, and a corpus that is present and will not open is still
  replaced with the same sentence. The desktop's first run never hit it — `split::convert`'s
  fresh arm makes the file first — but a reader who deleted `corpus.db` to force a resync did,
  and that is quiet now too. `launch.rs`'s `a_first_launch_replaces_nothing` and
  `an_unreadable_corpus_is_still_replaced` hold both arms.
- **(5)** The phone's `Filters` button and the sheet's *Reset all* counted the surface's
  `activeCount`, which counts a non-empty box as one kind. On the phone the box sits beside the
  button, outside the sheet, so both now count `sheetFilterCount` (`FiltersSheet.tsx`) —
  `activeCount` less the box — on Search and on both cabinets, and *Reset all* clears what the
  sheet holds and leaves the query, which is the reader's own words in its own control and would
  otherwise change out of sight. **The desktop bar is unchanged on purpose**: there the box, the
  button and *Reset all* are one row, and the button's count is documented as the whole search.
- **(6)** Export's button reads **Save file** — true on both hosts. The status line still
  reports what the host did: *Saved <name>.* on Android, *Downloading <name>.* in a browser,
  nothing for a cancelled dialog.

**Fixed since — a new deck on the phone (1).** The gallery's foot is a bar on every state
(empty, full, inside a folder, a read error): a gold **New deck** and a bordered **From a list**
(named *New deck from a list*), both 44px, and the empty state reads *No decks yet.* **New deck is
the desktop's `CreateDeckDialog`, whole** — `useDecks().create` (`deck_create`), `useNewDeckFormat`,
the folder select defaulting to the drawer the gallery is open on, and the cover picker — inside a
`display: contents` wrapper that raises its *Create deck* button to 44px and its text boxes to
16px; the rest of the form keeps its desktop sizes, as Deck settings does on the phone. **From a
list is the phone's `ImportSheet` over the desktop's new-deck step**: `NewDeckPreview` was split
as `DeckPreview` was — `NewDeckPreviewBody` is store-free and takes `importDefaults`,
`NEW_DECK_DESTINATION` is the shared key and label, `NewDeckPreview` the desktop's store-reading
wrapper — and `importIntoNewDeck` takes an optional `folderId`, so the phone files the deck in the
open folder (the desktop passes none and is unchanged). Either door ends on the new deck's page, by
a push. Every command it calls was already on the core's table. Held by `decks.test.tsx` over the
fake; **not yet driven on a phone**, so a deck write through `core_call` on a device is still
unproven.

**Fixed since — the phone face hears the card sync and the feeds (2).** Nothing on the phone face
listened for the sync's end: `PhoneFace` and `Shell` mounted none of the desktop shell's listeners
and drew `<ManaLine sync={null} />`, so the wall's `["cards","search",…]` query kept the empty
answer it got over the empty database — after its 30 s `staleTime` a query refetches only on a
remount, a focus or a reconnect, which a WebView rarely sees. (The card sheet looked right because
it mounts fresh queries each time it opens.) `PhoneFace` now mounts the desktop's own listeners
once — `phone/cardData.ts`'s `useCardDataWatch`: `useSync`, `useSyncProgress`,
`useSyncInvalidation`, the three feed hooks and `useMarketplace` — plus one trigger the desktop
lacks: when the polled `sync_status` count leaves zero, it invalidates `SYNC_INVALIDATED`, for a
`done` event Tauri delivered before the page was listening. `useSyncInvalidation` takes an
optional query client (the module's by default, so the desktop is unchanged), which is what lets a
`renderPhone` test see the refresh. The header's mana line carries the loudest running job (the
card sync, the price feed, Oracle Tags, the combos) as a progress bar named after its phase, and an
empty card search draws `phone/search/NoCards.tsx`: *No cards match.* only over a database with
cards; over an empty one, *Setting up your card database* with the phase and its count while a
sync runs, or *No card data yet* (with the last error, if any) when none does — a *Not now* on a
metered link, or a failed first download. A deck's Add cards shares the same results, so it says
the same. `cardData.test.tsx` holds the in-flight text, the refill on a `done` event, the refill on
the count leaving zero with no event, and the empty seed's sentence. **Not yet driven on a phone.**

**Fixed since — leaving the app ends nothing (3).** Read off `tauri` 2.11.5, `tao` 0.35.3, `wry`
0.55.1 and `tauri-runtime-wry` 2.11.4: `TauriActivity` sets `handleBackNavigation = false`, so the
only back handler is Tauri's `AppPlugin`, which walks the WebView's history and from the first entry
turns itself off and calls `activity.onBackPressed()` — and on that phone the root activity
finished. `WryActivity.onDestroy` → `Rust.onActivityDestroy` → tao sends `WindowEvent::Destroyed`;
`tauri-runtime-wry` removes the last window, `ExitRequested` is not prevented, the loop exits, and
**tao's Android `EventLoop::run` calls `std::process::exit`** on its own thread. `exit()` runs every
loaded library's static destructors while the framework's threads are alive — the second abort
fired 5 ms after HWUI's `RenderThread::destroyRenderingContext`, at the same faulting address in
both processes, which fits a static in a zygote-preloaded system library. The process cannot simply
be kept: Tauri builds its window once per process (wry keys its WebView attributes by the first
activity, and the plugin manager ignores a second `onActivityCreate`), so a second activity would
be blank. **Two fixes.** `MainActivity` registers an `OnBackPressedCallback` in `onCreate`, ahead
of the plugin's, so it is reached only when the plugin hands the press on: it checks the WebView's
`canGoBack()` itself (in case a later Tauri orders the callbacks differently) and otherwise calls
`moveTaskToBack(true)` — Android 12+'s own default for a root launcher activity — so the app stays
warm and nothing exits. And the host now `.build()`s and `.run()`s the app so that on Android
`RunEvent::Exit` prints a marker line and ends the process with `libc::_exit(0)`, running no
destructors — the way Android kills a cached process; committed SQLite data is durable and an
uncommitted write rolls back on the next open — for an activity destroyed any other way.
**`scripts/android-first-run.sh` now leaves the app twice** after the cold starts: back ×2 from an
untouched start page (process kept, return launch's `TotalTime` and `LaunchState`), then the
activity destroyed on purpose (*Don't keep activities* and Home, or a clear-task launch as the
fallback), and the run **fails on a `FORTIFY`, `destroyed mutex` or `Fatal signal` line in the
app's process** in either. Stock API 34 already moves a root task to the back, so the first step
cannot fail there the way the phone did; the second is the test of the exit path. **Not yet seen
on the phone.**

**Method notes.** This phone's logcat ring buffers are 256 KiB and had turned over by the end, so
the record is a `logcat` streamed from before the first launch. The phone's clock ran 9.69 s ahead
of the PC's (measured); every time above is the phone's. The one manual step was turning the phone
to landscape (auto-rotate is off on it). Left on the phone: the app with its corpus and one
collection row, and four small files in `/sdcard`.

## 9. The web host — phase 5, a step at a time

`grimoire-core` compiled to WASM, loaded by one dedicated Worker, with the page talking to it
through the `Core` seam (spec §6, and §3.5 for the seams).
[The plan](../superpowers/plans/2026-10-04-light-app-phase-5.md) has the five steps, one pull
request each; the rules for the host crate are
[`crates/grimoire-web/CLAUDE.md`](../../crates/grimoire-web/CLAUDE.md).

**Decided before anything was built** (the plan's table), the last of them by Markus on
2026-10-04:

- **The host is `crates/grimoire-web`, a fourth workspace member** — a `cdylib` whose
  `#[wasm_bindgen]` shell is the only thing gated to the target, so every `--workspace` command
  still reaches it natively.
- **The page is a build of its own, `dist-web/`** — the light entry in a `web` mode. The page's
  code is the Android app's; what differs is below `@/lib/core`, as the fake's build already
  differs. The desktop's `dist/` and the APK's `dist-mobile/` are to carry neither the module
  nor the Worker nor the service worker.
- **The service worker is hand-written**, as round one's was: no `workbox`, no
  `vite-plugin-pwa`.
- **`platform::files` keeps refusing in a browser.** The databases are SQLite's own OPFS VFS, a
  download is streamed into its sink, and card images are the service worker's, in Cache
  Storage.
- **Nobody here deploys.** The hosting Worker's source and its `wrangler.jsonc` are committed;
  Markus runs `wrangler deploy`. (The rule stands. The 2026-10-04 deploy was run by an agent
  because he asked for it in chat, and that ask was for one deploy — §9.7.)
- **The web app's origin is `https://mtg-grimoire.app`** (Markus, 2026-10-04) — a domain he
  bought on Cloudflare for it, rather than a `workers.dev` name beside the relay's. An origin is
  a PWA's identity: both OPFS databases and the install are bound to it, and the relay's CORS
  allow-list (phase 6) names it. **Nothing is deployed there**; the Worker that will serve it is
  step 5.5's, §9.5. (Deployed 2026-10-04, §9.7.)

**What the tree held before the phase started** (surveyed 2026-10-04, `main` at `2abf2d7a`):

- **The core compiled for `wasm32-unknown-unknown` and nothing had ever instantiated it.** No
  browser arm of `platform/` had run; there was no host crate, no `cdylib`, no OPFS code.
- **`launch::open` could not run in a browser as written**: it makes the data folder first,
  opens a second, read-only connection, and returned it as a field that was not optional — and
  `index::lifecycle`'s build and `invalidate_owned` each opened a connection of their own.
- **Every launch download goes through a temp file**, which a browser does not have. The card
  sync and the tagger feeds refuse before they ask; the combo and price feeds ask first and
  then refuse, on every launch — which is why the host of §9.1 starts none of them, and what
  step 5.2 gave each a second shape for (§9.2).
- **The page had two transports and no third**: `pickCore` answered `tableCore` or `tauriCore`,
  so in a plain browser the production bundle waited on "Opening your collection…" for ever,
  and `imageOrigin` answers two origins a browser cannot reach.

Round one's web host is in git history and worked end to end — removed on 2026-09-27 for its
faces, not its engine — and the plan names each file to read before writing the same thing
again: ported, never restored. The toolchain was already on this machine: the
`wasm32-unknown-unknown` target, clang 22.1.8 in `C:\Program Files\LLVM\bin` (not on `PATH`)
and `wasm-bindgen` 0.2.127, the version `Cargo.lock` resolves. No `wasm-opt`, no `wasm-pack`,
no `wrangler`.

### 9.1 Step 5.1 — the engine in a browser (2026-10-04)

**What was built.**

- **`crates/grimoire-web`, the web host** (`grimoire-web`, library `grimoire_web`, crate types
  `cdylib`/`rlib`). It holds almost nothing, and **three exports are the whole of it**:
  `open(directory)` — the OPFS pool, the two databases on one connection, the state and the
  facet index; `call(name, args, body?)` — every command, forwarded to
  `grimoire_core::dispatch`, so a command the table lacks is refused in the table's own words;
  and `listen(handler)` — the engine's events, handed to the Worker's script. `open` and `call`
  answer **JSON text and never reject**: `{"kind":"ready",…}`, `{"kind":"already-open"}` or
  `{"kind":"failed","message":…}` from the one, `{"ok":…}` or `{"err":"…"}` from the other. A
  trap in a Worker arrives in its `onerror` with nothing a page can show, so a call before
  `open`, arguments that are not JSON and a body where none belongs are each an answer.
  **Only `glue.rs` is gated to the target** — the `#[wasm_bindgen]` shell, the pool's install
  and three `thread_local`s. `wire.rs` (the JSON) and `host.rs` (everything the exports
  *decide*) compile on every target and are tested natively: a module gated to the browser is
  invisible to `cargo test`, and a typo in a wire string there is an `undefined` in a page.
- **`open` runs once whoever asks.** `host::Once` keeps the first call's *future* and every
  later caller awaits a clone of it — a second pool is never installed and the state is never
  replaced under a call in flight (`the_first_open_is_the_only_one_and_everyone_gets_its_answer`).
  A page that wants another attempt reloads, which is a new Worker. (**Since §9.6 the page
  makes that new Worker itself in one case**: an `already-open` met while this document holds
  the database's Web Lock. The Worker's own rule is unchanged — it opens once.)
- **The host starts nothing.** No card sync, no feed, no image upkeep: a download in a browser
  has no temp file to land in (step 5.2), and the upkeep loop evicts files this host does not
  have. No write observers either — the desktop's three are its mirror, its other windows and
  its live socket. (**True of this step only.** Since step 5.2 a `ready` open starts the
  launch's downloads — §9.2. Still no upkeep loop and no observers.)
- **The one-connection opener**, in the core. `db::open_single` is `open_write` statement for
  statement — one private body, `open_pair`, serves both, so the pair cannot be opened two
  ways — with two differences: **the journal each file got is answered rather than assumed**
  (`db::Journal`; `apply_pragmas` and `attach_corpus` now return what `PRAGMA journal_mode =
  WAL` *said*), and **`temp_store = FILE`**. `launch::open_single(databases, data_dir)` is the
  launch over it — no folder made, no file asked after, no read connection: `Opened.read` is an
  `Option` now and `None` here, handed to `State::new` as it is. `databases` is empty in a
  browser, where the pool is the filesystem and its two names are bare; `data_dir` is what
  Settings shows and need not be a path (`OPFS:/mtg-grimoire`). `State::one_connection()` says
  which kind of host a state is, and `index::lifecycle::over_the_corpus` is the one place the
  facet index's two long reads decide between a connection of their own and the state's.
  `the_single_opener_sets_what_the_write_opener_sets_and_says_what_it_got` compares the two
  openers pragma for pragma.
- **Why `temp_store`, and what it is not.** The SQLite a browser build compiles keeps its
  temporary b-trees — the sort behind a `CREATE INDEX`, an FTS rebuild — in memory unless told
  otherwise, and in a browser memory is the module's linear memory, which grows and is never
  given back. In the VFS they are files deleted when the statement ends. **It is a decision
  about a browser's memory and not a measured necessity**: round one first set it against a
  failure later traced to something else, and memory has never been measured in its place.
  What it costs is file slots, which is why the pool is sized at 64 files against two
  databases and two journals — round one's figure, and headroom nobody has justified by
  measurement either.
- **`platform::alone` — a native test made to feel the browser's one thread.** Three things
  behave differently in a Worker and none can be seen from a native test: `spawn` runs its work
  where it stands, `pause` answers that nothing was waited for, and a lock asked for twice by
  the one thread is **a trap** (std's `Mutex` panics on a recursive lock on
  `wasm32-unknown-unknown`) where a desktop's is a test that never ends. `alone::emulate()`
  makes the *calling thread* such a host until its guard drops: both `spawn` arms run on the
  caller, `pause` answers `false`, and `db`'s lock helpers panic on a lock already held, naming
  the line that asked. Per thread and never global, `cfg(test)` and the `testing` feature only;
  `emulated()` is a constant `false` in a build that ships.
- **Every command, run that way.** `commands`' test
  `every_command_answers_on_one_connection_and_one_thread` opens the database through
  `launch::open_single`, builds a state with no read connection, stands in for a Worker and
  dispatches every entry of `commands::TABLE` — 224 on the day — failing with the command's
  name on a panic, on a `BUSY` answered against itself, and on a call that never answers. It
  refuses a table that has grown a `blocking` or `task` entry without a row of chosen
  arguments, because those are the kinds handed the state. **It found no lock taken twice.**
  `a_lock_taken_twice_fails_by_name_instead_of_hanging` is the mutation that shows each failure
  is caught. No request leaves the machine in it, so the far side of a download is not run
  there.
- **One site was found by reading, and fixed.** `index::lifecycle`'s `amend_owned` noted a
  failed `owned` refresh to `error_log` while holding the reader — which on one connection is
  the write connection's own mutex, so the row was never written. It hands the failure back
  now and `invalidate_owned` writes it down once the pass has let go
  (`a_failed_owned_refresh_on_one_connection_is_still_written_down`).
- **The Worker, in `src/lib/core/web/`.** `worker.ts` is the dedicated Worker — not an
  optimisation: OPFS's synchronous access handles exist only off the main thread, and the pool
  permits one connection, so there is nowhere else for the database to be. It is **its own
  `tsc` program** (`tsconfig.web-worker.json`, the `WebWorker` lib; the root program excludes
  the one file), and everything it decides is in `engine.ts`, which the suite drives with
  neither a Worker nor a module. `grimoire_web.d.ts` types the module **by hand**, because
  `dist-wasm/` is ignored and `tsc` runs on machines that never built it. The Worker loads the
  glue **by URL, through a variable, with an origin** — each of the three for a reason
  `worker.ts` gives at its own site.
- **The protocol** (`protocol.ts`, pinned by `protocol.test.ts`): `open` and `call` one way;
  `opened`, `ok`, `err` and `event` the other. **Answers are matched by id and never by
  arrival** — a slow search is overtaken by a fast one — and a byte payload is transferred
  rather than copied, its headers riding as `args`, as `table.ts` carries the same call.
  (**`opened` carries a second field since step 5.2**: `existed`, whether OPFS already held the
  database's folder before the open — §9.2.)
- **The third `Core`, and how a build chooses it.** `src/lib/core/web/index.ts`'s `webCore`
  sends every command to the Worker. **`src/lib/core/index.ts` chooses by
  `import.meta.env.MODE === "web"`** — which build this is, replaced at compile time, not a
  probe — and reaches `./web` by a **dynamic import with the comparison written out at the
  `import()`**: Vite bundles a Worker for every file it transforms that spells
  `new Worker(new URL(…))`, so a static import would put the Worker's chunk in the desktop's
  `dist/` and the APK's `dist-mobile/`. `deferredCore` is what `core` is while that chunk is on
  its way, and `refusedCore` what it becomes if the chunk never comes — the gate is then told
  so, with a reload, where a rejected `startup_status` would have read as *still loading* for
  ever. Every other mode still goes through `pickCore`. **A refusal is the engine's sentence as
  a bare string**, because that is what a Tauri command rejects with and the pages read one.
- **Loaded once, on both sides.** Two instances of a `wasm-bindgen` module in one Worker
  corrupt each other's heap — round one measured it on 2026-08-28, a first run that failed two
  times in three — and React's StrictMode is what asks twice. So: the page makes **one Worker**
  on the first call or subscription and never another (`createWebCore`, a module singleton);
  the Worker memoises the *load* as a promise (`engine.ts`'s `once`), so two messages landing in
  one turn share one instantiate; and it memoises the *open*, as the module itself does.
- **The startup gate is answered on the page.** `startup_status` is `loading` until the Worker
  reports its open, and `startup:changed` is emitted when it does — the two things the Android
  host answers in Rust — so `boot/useStartup.ts` is one gate on every host. A call made before
  the database is open **waits and is not refused**: held, and sent in the order made. A
  Worker that dies rejects every call in flight and refuses every later one.
- **A second tab is told so, and offered a way out.** The pool holds exclusive access handles,
  so a second document of the origin is refused at the *install*, before it names a database.
  `wire::Opened::from_install_error` tells that from a real failure by the `DOMException`'s
  **name** (`NoModificationAllowedError`), anywhere in the text. The page turns it into
  `{ state: "failed", message, reload: true }`. (**True of this step. Since §9.6 the pool's
  refusal is not what tells a second tab**: a Web Lock is, asked before any engine starts, and
  an `already-open` met by the document that holds the lock is retried with a fresh Worker
  rather than told — it is a page that has gone, not a tab that is open.)
  **`StartupStatus` grew `reload?: true`** — a
  host saying that starting again can cure the failure — and the web host sends it for a second
  tab, for an engine that never loaded and for one that stopped; never for a database that
  would not open, which will not open the second time either. **`mobile/BootScreen.tsx` draws
  the way out from what the host answered, not from where it runs**: `ReloadLink`, a link to
  where the reader already is, which `FaceBoundary` now draws too. A failure a reload can cure
  is told in the plain text colour; one that stays failed keeps the destructive one.
- **The `web` mode.** `vite.mobile.config.ts` in mode `web` builds the light entry into
  **`dist-web/`**; every other mode is `dist-mobile/` as before. `npm run web:dev` serves it on
  **port 5176** (the light server keeps 5175, so both can be up), `web:build` runs `tsc`, the
  Worker's program and the bundle, and `web:preview` serves the result on 4176 with Vite's own
  single-page fallback turned off, so a file a deploy removed is a 404 as on a real host.
- **The engine's address is `/wasm/<build id>/`.** Its two files have fixed names
  (`grimoire_web.js`, `grimoire_web_bg.wasm`), so without the id one URL would serve every
  build there will ever be, and anything that keeps a response by URL would pair this build's
  glue with the last build's module. **The id hashes the engine's files — each one's name, its
  length and its bytes** (`assets.ts`'s `buildIdOf`, FNV-1a, sixteen hex digits) — so a deploy
  that changed only the page keeps the address and a changed byte moves it; a dev server's id
  is the word `dev` and it serves `dist-wasm/` uncached. A directory and not a query, because
  the glue finds what it imports beside itself by its own URL. A `web` build whose engine is
  not there **fails**, with the sentence that says what to run.
- **`scripts/build-wasm.mjs`** (`npm run web:wasm`): `cargo build -p grimoire-web --lib` for
  the target under **a profile of its own, `wasm`** — it inherits `release` and adds fat LTO,
  one codegen unit and `panic = "abort"`, and `[profile.release]` is deliberately not written,
  so nothing here reaches the desktop's or the APK's build — then `wasm-bindgen --target web`
  into `dist-wasm/`, the name section stripped unless `--names` asks. It checks three things
  that fail without naming themselves: the CLI is exactly the version `Cargo.lock` resolves,
  clang 18 or newer is reachable (it looks in the LLVM installer's folder on Windows), and
  every function the Worker imports is exported.
- **`scripts/web-smoke.mjs`** (`npm run web:smoke`): serves `dist-web/` on `localhost`, opens
  it in headless Chromium over the DevTools protocol with no dependency, and asks five things —
  the app got past its gate and said which journal it got; the database is in OPFS; a read came
  back through the engine; a reload opens the database a second time, heard as a second console
  line; a second tab is told and offered a Reload. **It is the run that instantiates the
  module**: vitest drives the Worker's logic over a fake and cargo compiles the engine for a
  browser without starting one. **Its reload check is "it opens again", not "it kept what was
  written"** — nothing in the script can write through the engine, so a browser that wiped OPFS
  between the two opens would pass; that a write survives is the dev pass's, below. Everything
  it starts is stopped whatever fails, and one timer bounds the whole run at three minutes.
  (**It asks nine things since step 5.2**, as an offline first run over fixtures, and its
  reload check is now "it still holds the cards" — §9.2. **Step 5.3 added the service
  worker's**: the shell, a picture, a reload with the server gone, and an update — §9.3.)
- **CI's `web` job** builds the module and the page on `ubuntu-24.04`, reports every `.wasm`
  raw and `gzip -9`, runs the smoke script in the image's own Chrome and uploads `dist-web/`.
  The router gives it everything `core` runs for and everything the page is bundled from.
  [ci-and-releases.md](ci-and-releases.md) has each step and each arm. `lint:rust`'s and CI's
  `cargo fmt` line gained `-p grimoire-web`, the `testing`-feature check names the host, and
  release-please bumps its manifest and lockfile entry with the others
  (`the_host_wears_the_cores_version` goes red if the versions part).

**Measured, 2026-10-04, on Windows 11.**

- **The module** (`node scripts/build-wasm.mjs`: profile `wasm`, name section stripped, no
  `wasm-opt`): `grimoire_web_bg.wasm` is **8 548 543 B**, **2 982 372 B** through `gzip -9`; the
  glue `grimoire_web.js` is 60 568 B. The build took 221.8 s cold on this machine and 142.3 s
  warm. With the function names kept (`--names`) the root `Cargo.toml` records 10 146 090 B.
  **Round one's module was 2 642 182 B.** Two causes were read off the build: the core is far
  larger than round one's subset, and `ocrs`'s default `export-wasm` feature roots the OCR
  runtime's own `#[wasm_bindgen]` API — about 1.84 MB that nothing calls, measured on a scratch
  copy with the feature off at 6 703 909 B. `opt-level = "s"` measured 7 036 825 B. (Both
  comparisons were taken against the build before the review's fixes, 8 547 708 B — 835 B
  smaller than the one that ships.)
  **Neither was adopted in this step**: no size-optimised build has been timed in a browser,
  and the `ocrs` line is `crates/card-scanner`'s. Both are step 5.5's, with timings.
  (**Settled there, §9.6**: the `ocrs` feature is off, worth 1 882 984 B rather than the
  scratch copy's 1.84 MB; `"s"`, `"z"` and a build with only the Rust at `"s"` were each timed
  on a first run and each was slower, so `opt-level` stays 3. The module that ships is
  6 767 338 B, 2 372 783 B through `gzip -9`.)
- **Under Node 24's V8, before any browser** (the module through a temporary export, since
  removed; which profile that module was built under is not on this record): the whole engine
  as WASM over SQLite's in-memory VFS — launch to schema 59 in 76 ms, `journal: "delete"` on
  both files, 27 commands of every kind answered, no trap.
- **In a browser, the built app** (`npm run web:build`, then `npm run web:smoke`; headless
  Chrome 154.0.8037.95, `--headless=new`, an 800-wide window and so the phone face). All five
  checks passed, in 3.4 s to 4.1 s across five runs. The page's console line read `journal
  delete, corpus journal delete, schema 59`; OPFS held `mtg-grimoire/` with 65 entries; the
  read was the Search page's sentence over an empty corpus — *No cards match.* on this branch's
  own tree, and *No card data yet* once `main`'s `NoCards` (§8.6) was merged in, which takes
  `sync_status`' count as well as the search's answer; the reload opened the
  database again; and the second tab was told *"MTG Grimoire is already open in another tab of this
  browser. Close that tab, then reload this one."* and offered a Reload. `dist-web/` is
  11 996 428 B in total.
- **In a browser, the dev build under React StrictMode** (`npm run web:dev`, Vite's dev server
  on port 5176 over the module in `dist-wasm/`; the same Chrome, driven over CDP by importing
  the page's own `core`). **One Worker** was requested. `startup_status` settled `ready` **900 ms** after
  the page's first ask on an empty OPFS — instantiate, install the pool, open, migrate to head,
  build the facet index. Then: `sync_status` 7.3 ms (`dataDir` reads `OPFS:/mtg-grimoire`,
  `cardCount` 0); `deck_create` 13.9 ms; `deck_list` 0.3–0.6 ms; an unknown command refused in
  the table's sentence — *"There is no command named no_such_command on this host."* — in
  0.2 ms; malformed arguments refused in a sentence naming the field. The deck written was
  still there after a fresh navigation (`deck_list` in 3 ms).
- **Storage after that first open**: OPFS held 64 files totalling 1 507 328 B, while
  `navigator.storage.estimate()` reported `usage` 67 122 634 — a second measurement of the
  spec's rule that the estimate gates nothing. `navigator.storage.persisted()` was `false`;
  nothing asked on that build (each launch does since step 5.2 — §9.2). (64 is also the pool's capacity in files. The smoke run's 65 is
  a count of *entries*, and its walk counts a directory as one — the likeliest reason for the
  difference, not checked.)
- **The suites**: `cargo test` green for the core, `grimoire-web`, `grimoire-light` and the
  desktop on the final tree, and clippy clean natively and for wasm32. The new TypeScript tests
  are `src/lib/core/web/`'s four files, `deferred.test.ts`, `core.test.ts`'s *"the core a build
  chooses"* and `mobile/BootScreen.test.tsx`.

**CORS, measured 2026-10-04 with `curl`** sending `Origin: https://mtg-grimoire.app` and
reading the response headers a browser's CORS check reads. **Server behaviour only: no browser
had made these requests** when the table was taken. This is what §6.5 left as phase 5's first
measurement, and what step 5.2 builds on — and §9.2 is where a browser first made every one of
them but the last row's and Mana Pool's, which is never asked.

| Host | `Access-Control-Allow-Origin` | Pre-flight (`OPTIONS`) | `Access-Control-Expose-Headers` | Notes |
| --- | --- | --- | --- | --- |
| `api.scryfall.com` (`/bulk-data`) | `*` | 200; `allow-headers` lists `If-Modified-Since`, `Cache-Control`, `Accept`, `User-Agent`, … — **not `If-None-Match`, not `Range`** | none | `ETag` is sent but a page cannot read it |
| `data.scryfall.io` (the bulk files) | `*` on `GET`/`HEAD` | **403** | none | `Accept-Ranges: bytes`, and a ranged `GET` answers 206 with `ACAO: *`; `Content-Length` and `Last-Modified` are safelisted and readable, `ETag` and `Content-Range` are not |
| `json.commanderspellbook.com` (`variants.json.gz`) | `*` | **403** | none | `Content-Encoding: gzip` — a `fetch` always decodes it, so `Content-Length` (28 832 784) is not the body's length; `Last-Modified` readable, `ETag` not |
| `api.cardkingdom.com` (`/api/v2/pricelist`) | `*` | not asked | none | answered `Content-Type: text/html` to curl; read the body before trusting it |
| `manapool.com` (`/api/v1/prices/singles`) | **absent** | — | — | only `Access-Control-Allow-Headers: sentry-trace, baggage`; unreachable from a page, as spec §4 says |
| `cards.scryfall.io` (card images) | `*` | allowed (`GET, OPTIONS`) | none | a CORS `fetch` gets a readable (non-opaque) response, so Cache Storage holds it at its real size |

What follows for the engine in a browser:

- **No request may carry `If-None-Match`.** It is not a safelisted request header, so it costs
  a pre-flight, and both `data.scryfall.io` and Spellbook answer a pre-flight 403 — the request
  itself then fails. `api.scryfall.com` answers the pre-flight but does not list the header.
- **No `ETag` can be read anywhere**: nobody sends `Access-Control-Expose-Headers`. A freshness
  check in a browser has the descriptor's own body (`updated_at`, and a file name that carries
  its timestamp), `Last-Modified` (safelisted) and the app's own refresh interval.
- **A simple `Range: bytes=N-` is a safelisted request header** in current browsers and needs
  no pre-flight, but `Content-Range` cannot be read, so a resumed download cannot verify what it
  got. **A browser download is one streamed request with no resume.**
- **`Retry-After` is not exposed either**: a 429's wait cannot be read from a page.
- Bulk sizes on the day: `default_cards` 78 692 716 B gzipped, `oracle_tags` 5 977 799,
  `art_tags` 12 975 578.

**Not measured, and not built.**

- **Any browser but Chromium on a desktop, and any phone.** Both browser passes above are one
  Chrome on Windows; neither drove a page of the desktop face over the engine — the smoke run
  is the phone face and the dev pass called `core` itself.
- **The corpus.** No download runs in a browser — the host starts none — so every figure above
  is over an empty one: no ingest, no search over cards, no memory high-water mark, no storage
  figure worth comparing with round one's. (**§9.2 has one run of each.**)
- **Card images.** The page still asks the `mtgimg` origins, which a browser cannot reach
  (step 5.3 — **built 2026-10-04, §9.3**: the web build asks its own origin under `/mtgimg`
  and the service worker answers).
- **Clipboard, links and files on the desktop face** in a browser (step 5.4 — **built and
  driven 2026-10-04, §9.4**), **a service worker** (5.3 — **built and driven 2026-10-04,
  §9.3**) and **hosting** (5.5 — **the Worker, its policy and its runbook built 2026-10-04,
  §9.5; not deployed** — deployed 2026-10-04, §9.7).
- **CI's `web` job has not run.** Its first run is this step's pull request, and its sizes are
  that run's summary — a Linux Chrome's, not the one above.
  - **It has since, on this step's pull request** (#805, merged 2026-10-04): the job's first
    run, on `ubuntu-24.04` with a cold cache, took **4 min 59 s** for the whole job — clang
    18.1.3 from apt, the `wasm-bindgen` CLI compiled from crates.io at the lockfile's 0.2.127,
    the host linted for wasm32, the module built (**8 571 014 B**; Vite reported it
    3 040.62 kB gzipped), the page built, and the smoke run passed in the runner's own Chrome.
    `ci-ok` was green on the pull request's first run. A warm run's time is not on this record.
- **A trap inside the engine.** With `panic = "abort"` a panic in a call is an uncaught error in
  the Worker and the call's promise never settles; what the page hears is the Worker's own
  `error` event, on which its core rejects everything in flight and refuses what follows. That
  path is exercised by fakes only — nothing here made the real module trap.
- **`eprintln!` is silent on wasm**, so the launch's logged passes say nothing in a browser.
- **There is no backup before a schema climb in a browser**: `VACUUM INTO` needs a file, and
  the copy is logged and skipped as on any host that cannot write it.
- **A corpus that will not migrate cannot be replaced in a pool yet** —
  `launch.rs`'s `unreadable_corpus_seam` is the line, and says what a browser gets today in
  each of its three cases. One that is simply gone reads as a first run. (**Closed in step 5.2
  for the bullet's own case**, and the seam is deleted: `launch::open_single_replacing` throws a
  corpus that will not open or migrate away through the pool's own delete. One that is simply
  gone still reads to the engine as a first run — what the page now notices is the whole folder
  gone — and a corpus damaged inside a sound first page is still not looked for. §9.2.)
- **Three values are round one's and were not re-measured**: `synchronous = NORMAL` on a
  rollback journal, `temp_store = FILE`, and the pool's capacity of 64.

**Reviewed before it shipped**, by a reader given the code and not the conclusion: no must-fix,
and eight things that claimed more than they did — each closed in the same change.

- **The one-connection test proved less than its name.** A bounded ask that found the
  connection held answered `None` and its caller dropped the work in silence — the shape of the
  bug found by reading. On an emulated thread `db::lock_for` now refuses by name
  (`alone::refuse_held`), and re-running that bug's mutation fails at `sync.rs`'s line instead
  of by a missing row. Arguments that never reach a body are counted and pinned by name; the
  list is empty since the four commands on it were given real ones. **"By name instead of
  hanging" holds for four locks** — a connection and the facet index (a panic), the sync lane
  and the pairing offer (a deadline) — and not for `lock_plain` or a bare `.lock()`, which
  would block the thread.
- **The smoke run** left its server listening, and so its process alive, when the browser
  failed to start; its deadline bounded only its own polls; and its reload check waited on a
  tab bar the old document had already drawn.
- **The dev server's engine route read outside `dist-wasm/` on Windows** for a path with a
  backslash in it (`/wasm/dev/..\package.json`) — loopback only, and only from a client that is
  not a browser. `wasmFileOf` is an allow-list of plain segments now.
- **A byte payload that was a view of part of a buffer** would have handed over the whole
  buffer, emptying every other view of it; such a view is copied and the copy crosses. **One
  held call whose post throws** no longer strands the calls behind it.
- **Two false sentences**: that a trap surfaces as a rejected call (above), and that the CLI's
  install needed a `--target-dir` — `cargo install` from a registry never reads this
  repository's cargo config. And one omission: `glue.rs` was linted by nothing, since the
  `rust` job's clippy is native and `core`'s names the engine alone; the `web` job runs
  `cargo clippy --lib -p grimoire-web` for wasm32 ahead of the build.
- **What a `wasm-bindgen` mismatch does** had two accounts in the tree and both are partly
  right: the CLI refuses a module on another *schema*, which is not the crate's version
  (0.2.127 is on schema 0.2.122), so a neighbouring release can pass that check with glue
  nobody has run. Exact equality stays the rule because it is the only pair anyone has.

**Left for the rest of the phase** ([the plan](../superpowers/plans/2026-10-04-light-app-phase-5.md)):

- ~~**5.2 — the first run.**~~ **Built 2026-10-04 — §9.2**, with two things built differently
  from this line as it stood: a storage clearing is a **notice** rather than an offered
  rebuild, because the rebuild is the launch's own download, and `persist()` is asked **again,
  at most weekly, while the answer is no** rather than once.
- ~~**5.3 — the service worker.** The shell precached, card images from Cache Storage on the
  app's own origin, the update flow, and a face whose chunk a deploy renamed recovering.~~
  **Built 2026-10-04 — §9.3**, with two things beyond this line as it stood: the Scryfall
  address is asked of the engine *through the page*, because a service worker cannot reach
  the database Worker, and the tagger feeds' and the combos' finishes take a turn between
  their batches — §9.2's two longest tails. And the last clause was built as its opposite: a
  deploy no longer renames a chunk under an open page, so there is nothing to recover from.
- ~~**5.4 — the browser's seams and the manifest.**~~ **Built 2026-10-04 — §9.4**, with one
  thing built differently from the plan's line as it stood: the Android host opens a link
  through Tauri's opener, which its capability grants, rather than through the WebView.
- **5.5 — hosting, and the phase's own run.** ~~The Cloudflare Worker with static assets at
  `mtg-grimoire.app`, its runbook~~ — **built 2026-10-04, §9.5, and not deployed** (deployed
  later that day, §9.7), with one
  thing this line did not say: the Worker has a script, because the single-page fallback alone
  answers a missing file with the document. **Still to come**: the module's size taken up with
  timings, CI's smoke run served under the policy (§9.5's foot has what that takes), and the
  built app driven end to end against round one's figures.

### 9.2 Step 5.2 — the first run (2026-10-04)

A web install builds its corpus: the launch's downloads run in a browser with no temp file, and
the page says what the browser did with its storage. The engine's rules for it are
[`crates/grimoire-core/CLAUDE.md`](../../crates/grimoire-core/CLAUDE.md)'s *A download has two
shapes*; the host's are [`crates/grimoire-web/CLAUDE.md`](../../crates/grimoire-web/CLAUDE.md)'s
*What the host starts*.

**What was built — the engine.**

- **`platform::host` is two facts, not a download abstraction.** `keeps_files()` — is there a
  folder a download can land in and be read back from — and `asks_as_a_page()` — is every
  request a cross-origin `fetch`. Each native download keeps its statements as they were, and
  the arm for a host with no files **branches before it sends anything**: `sync`'s
  `ingest_streamed` into `ingest::StreamIngest`, `tags`' `refresh_streamed` into `StreamTags`,
  and `combos`' and `marketplace_feed`'s into a `StreamRead` each and then `store`. No host is a
  page that keeps files, so both questions are answered from one switch; they stay two
  functions because a call site asks one of them.
- **`host::emulate_page()` makes a native test a page.** Until its guard drops, every
  `platform::files` call on that thread refuses as the browser arm does, `platform::http` hides
  the response headers that are outside the CORS safelist, and the thread is alone
  (`platform::alone`). It is what lets each download's mock-server tests run the page's arm on
  a desktop — a run that passes there has written no file and read no `ETag` — and the core's
  table test stands under it too.
- **What a download is on a page**, each line from §9.1's CORS table:
  - **No conditional header is sent and no `ETag` is read.** "Unchanged" is the descriptor's
    `updated_at` against the stored one for the card file and both Tagger files, and the
    answer's `Last-Modified` for the combos, which have no descriptor — kept where a desktop
    keeps the ETag, with the response dropped unread when it matches.
  - **One streamed request with no resume.** A page cannot read `Content-Range`.
  - **The card file and the tag files end only at exactly the descriptor's
    `compressed_size`** (`scryfall::Stream::chunk`), so a sink's `finish` — the swap — is
    unreachable over a body that is short or long. The combos and the price list have no
    listed size on any host; they are held to a bound, and a body the browser has already
    gunzipped is held to a decoded one.
  - **A stall bound of 60 s** (`scryfall::STALL`, the native read timeout's own figure) on the
    wait for an answer to begin and on each chunk — never on the whole body. A deadline that
    fires is given **a one-second second look** (`http::SECOND_LOOK`) on the same wait, which is
    not dropped between the two, before it is called a stall: a timer on one thread counts
    whatever that thread was doing, and a chunk that arrived during a long synchronous stretch
    is due beside the timer that would have condemned it.
  - **No `User-Agent` is set on wasm** — a page may not choose one, so the browser's own is
    what every host sees.
  - **`Tick` is `performance.now()`**, off the Worker's global scope, in whole microseconds. It
    was `Date.now()` until this step first paced a request (§6.5's open item); a host with no
    `performance` object falls back to the wall clock rather than trapping.
  - **A deadline that was beaten clears its `setTimeout`.** It used to be left to fire into
    nothing, which was one stray timer for a relay request and would have been one per chunk
    here.
- **Card Kingdom's list goes through a push parser** (`marketplace_feed::StreamRead`). The list
  was 66 787 283 B decoded when the feed was measured on 2026-08-12; buffered whole it would be
  64 MB of linear memory, and linear memory never shrinks.
- **A pushed body that ends inside its array is refused** (`feed::frame::Elements::cut_short`,
  asked by both `StreamRead::finish`es), never stored as a prefix. A real `.gz` fails at its
  trailer; a body the browser decoded has none.
- **`feed::StreamedProgress`**: a report on a byte step, never per chunk, and a total only for
  a body that arrived still gzipped — otherwise `total: 0`. A `Content-Length` is the wire's
  length, and a body `fetch` has decoded is not that long.
- **Mana Pool is refused before any request, in a sentence.** `marketplace_feed::reachable` is
  `FeedProvider::permits_a_page()` or `!host::asks_as_a_page()`; a refresh of a feed that fails
  it answers *"… prices cannot be downloaded in a browser: … does not let a web page read its
  price list. The desktop and Android apps can."* with nothing asked, nothing logged and no
  phase said, `selected_due` never calls it due, and `FeedStatus.reachable` is `false`.
- **`timer::yield_to_host()` and `timer::Breather`.** A yield is a message posted to itself
  over a `MessageChannel`, awaited — a task on the source a page's own messages arrive on —
  and every streamed loop keeps a `Breather` on a 50 ms budget (`feed::WORK_BUDGET`), taking one
  turn each time the budget is spent. **Added after the first measured run below found the
  engine starved during the card download**; that run is of the module without it.
- **`launch::open_single_replacing`.** A corpus that will not open, or will not migrate, for a
  reason that is about the file, is deleted through the host's own delete — the pool's
  `delete_db`, the journal before the database, every file attempted whatever an earlier one
  answered — and the pair is opened again. **`user.db` is never deleted**, and a failure that
  says nothing about the file (busy, locked, full, an I/O error) never deletes anything. It is
  tried once; `Opened.corpus_replaced` says it happened and the console is told.
- **The web host starts the launch's downloads.** `glue`'s `open` answers `ready` and then
  `spawn_local`s `host::launch_downloads`: the card sync, then each feed in turn — the price
  list if a feed marketplace is selected, the oracle tags, the art tags, the combos — each when
  it is due, **on every launch and never side by side**. A Worker is one thread and its memory
  is linear memory that never shrinks, so two ingests at once gain overlap on the network and
  a high-water mark that is a sum. **No upkeep loop, and no hold on a metered connection.**

**What was built — the page.**

- **The marketplace picker offers what the host can reach.** `MarketplaceFeedStatus.reachable`
  mirrors the engine's field; an unreachable feed's row is greyed with a sentence saying why
  and where the prices can be had, and draws neither a feed line nor a refresh. **A stored
  choice that is unreachable here is quoted as the same-currency marketplace whose prices ride
  the card data** (`fallbackMarketplace`: TCGplayer for a dollar marketplace) **and is never
  written away** — the same database may sync back to a host that can reach it.
- **`persist()` is asked again while the answer is no, at most once a week — a deliberate
  departure from the spec's "asked once".** Each launch reads `persisted()` first, which asks
  nobody; a yes ends the asking; otherwise `persist()` is asked if a week has passed since the
  last ask, and the ask is stamped **before** the answer, so a prompt left unanswered still
  counts as the week's. The reason is Chromium's: it decides at the moment of the call — from
  engagement, a bookmark, an install — so a first visit's no, frozen for good, would never
  become a yes after the reader installs the app. The record is in `localStorage`
  (`grimoire.storage.persist`), said on the console beside the open's line, and read back
  through the host command `storage_persistence`. Nothing reads it to decide anything, and
  nothing reads `estimate()`.
- **Storage cleared under the app is a notice, not an offered rebuild.** The plan and the spec
  both say *a rebuild offered*; the rebuild is automatic — it is the launch's own download —
  so what a reader needs is to be told why the app is empty and what is not coming back. The
  Worker reads whether the OPFS folder existed **before** the open, which is what creates it
  (`existed`, on the protocol's `opened` message); the page compares that with a mark it keeps
  in `localStorage` and **records the occurrence whatever became of the open**, because an open
  that creates the folder and then fails leaves a launch that looks ordinary behind it.
  `mobile/StorageNotice.tsx` asks the host command `storage_cleared` and draws one dismissible
  notice from the answer — the host's own sentences — so nothing under `mobile/` asks where it
  runs; the Android host and the desktop refuse the name, which is nothing to draw. (**Since
  step 6.4 there is a second name the web host alone answers, `storage_group_warning` —
  §10.4.**)
- **The startup status may move once more, from `ready` to `failed` with `reload`**, when the
  Worker dies. A dead engine then replaces the whole app with a sentence and a Reload, rather
  than leaving each page to find out alone. `useStartup` keeps its listener after `ready` for
  it; the desktop and the Android host never emit after `ready`, so nothing changes for them.
- **The web core's `emit` isolates each handler**: one message fans out to every subscriber of
  a name in a loop, and a throw left to climb would take the event from every handler behind
  it.

**What was built — the smoke run.** `scripts/web-smoke.mjs` is an **offline first run** now,
and no request leaves the machine.

- **One browser-level `Fetch.enable`** pauses the Worker's requests. Measured on the way
  (Chrome 154, 2026-10-04): the Worker's own CDP session has no `Fetch` domain; a fulfilled
  response is CORS-checked like any other; and `Fetch.fulfillRequest` does not decode a
  `Content-Encoding`.
- **Every cross-origin request is answered from `scripts/web-smoke/` or fails the run** — six
  real-shaped cards from the core's own test fixture, tags, sets, migrations, a Card Kingdom
  list and Spellbook variants. **A request carrying a header that would cost a pre-flight
  fails the run**, and the real hosts cannot resolve (`--host-resolver-rules`), so a request
  the interception never saw is answered by nobody.
- **Nine checks**, listed in the script's header: past the gate on a rollback journal; the
  database in OPFS; an empty corpus reading as a first run while the card file is on its way;
  the card sync finished and a typed search drawing that card's tile; the launch's three feeds
  stored with nothing in the error log; Settings greying Mana Pool and downloading Card
  Kingdom when it is picked; a reload that still holds the cards and asks no host for
  anything, and a forced check that asks for the listing and no card file; a second tab told
  and offered a reload; and no request that would cost a pre-flight or that went to a host
  with no fixture. **So §9.1's caveat is closed**: the reload check is "it kept the cards".
- **`scripts/ci-route.mjs` routes `scripts/web-smoke/*` to `web`** (and `frontend`), beside the
  script itself: a fixture changed is a first run changed.

**Measured, 2026-10-04, offline: the smoke run.** Windows 11, headless Chrome 154.0.8037.95.
Sixteen consecutive passes at 3.8–4.8 s, on the module as it stood before the review's fixes,
and one more in headless Edge 154.0.4258.53.

**Measured, 2026-10-04: one first run against the real hosts.** Windows 11, Ryzen 9 5900X,
32 GB; headless Chrome 154.0.8037.95; the built app through `web:preview`; a fresh profile; the
default headless window, inner 764 × 485, so the phone face. Started 04:40:05 UTC. **One run,
and the machine was not quiet** — a game held about five logical cores, and total CPU read
36–53 % for the length of it. **The module is the one before the review's fixes and before the
yield**, 8 587 535 B. Round one's figures beside these are the spec's §6 table: August,
desktop Edge.

- **The card sync**, in milliseconds after navigation:

  | | ms |
  | --- | --- |
  | Worker constructed | 113 |
  | Database open | 1 007 |
  | Shell drawn | about 1 350 |
  | First-run words on the page | 1 364 |
  | First `downloading` | 1 369 |
  | Last `downloading` | 17 767 |
  | `ingesting` — the synchronous finish | 17 770 → 22 465 |
  | `sets` | 22 503 |
  | `done` | 23 812 |

  **16.40 s for the 78 692 716 B download**, `reclaiming` 201 pages, no `compacting`, and
  **`done` with 118 469 cards and 0 skipped**. Round one, over a narrower card row: 117 606
  rows in 15.6–16.3 s.
- **The feeds, all done at 76.6 s.** Oracle tags: 1.9 s of download (5 977 799 B) and an
  **11.3 s finish** — 4 560 tags, 235 037 taggings. Art tags: 7.7 s (12 975 578 B) and a
  **23.4 s finish** — 11 611 tags, 492 784 taggings. Combos: 3.9 s (28.87 MB on the wire,
  677 301 311 B decoded) and a 3.7 s store — 111 486 combos, 7 387 cards.
- **Card Kingdom is not asked at launch**, because the default marketplace is TCGplayer.
  Chosen through the engine it took 4.75 s (9.65 MB on the wire, 67 800 789 B decoded, 0.8 s
  store, 151 684 rows). **Its answer is `Content-Type: text/html; charset=utf-8`, is JSON, and
  has no `Content-Length`** — which settles §9.1's "read the body before trusting it".
- **Mana Pool was never requested.** `reachable` was `false`, and the refusal is the sentence
  above.
- **All nine cross-origin requests were answered 200 over h2.** The request headers were the
  browser's own `User-Agent`, `accept` and `Referer` — **no `If-None-Match`, no `Range`**.
  `error_log` was empty and nothing was thrown.
- **Responsiveness** — a `sync_status` sent once a second through the page's core. **During the
  card download the Worker took a queued call eight times in 16.4 s**, at a latency of
  3.5–8.4 s, median 6.4 s. During Card Kingdom's download the same calls answered in
  0.7–119 ms, median 1.4 ms. The card download was CPU-bound rather than waiting on the
  network: an offline run of 60 000 synthetic cards ingested at about the same rate. **The
  longest single wait was 26.1 s**, across the end of the art download and its finish. The
  page's main thread never stalled over 200 ms.
- **The same run again, on the module that ships** (8 592 080 B, with the review's fixes and the
  yield; started 05:18:23 UTC; a quieter machine — 19–32 % total CPU during it, against 36–53 % —
  so the two runs are not like for like). **The yield is what it was added for: all 15
  `sync_status` calls sent during the card download answered, in 24–440 ms, median 185 ms.**
  Cards searchable at 21 870 ms (the download 15.30 s); all launch feeds done at 76.07 s; the
  same rows in every table; no error. During the feeds' downloads the same call answered in
  56 and 298 ms (oracle tags), 15 ms–1.48 s with a median of 266 ms (art tags), 4–37 ms (combos)
  and 0.5–0.7 ms (Card Kingdom). **The synchronous tails are as long as they were, because
  nothing in them takes a turn**: the card finish 4.28 s, the oracle tags' finish 10.76 s, the
  art tags' 23.56 s, the combos' store 3.80 s, Card Kingdom's 0.80 s — and the longest single
  wait was the art finish, 23.57 s. Combos reported 348 `downloading` events, every one with
  `total: 0`, where the earlier module sent 327 with a total that climbed; Card Kingdom 48,
  against 157. Linear memory could be watched now that the Worker answers while it downloads:
  127.9 MiB at 2 s, 160.0 MiB from 5 s through the cards and both tag feeds, and its peak of
  193.8 MiB after the combos' store. **A reload on that database asked nothing of any host**
  (20 card pictures to `mtgimg.localhost` aside): open at 1 685 ms, the shell at 1 995 ms, first
  tiles at 2 860 ms; the console's persistence line ended `(from the record)`. The offline smoke
  passed five times in a row on this module, in 3.8–4.7 s.
- **The desktop face's first run**, at 1280 wide (inner 1264 × 705), over the smoke's fixtures
  with the card file held back four seconds — not the real hosts. A full-window dialog named
  *Setting up your card database* was up 1 175 ms after navigation, with an indeterminate bar
  and the generic label *Syncing card data*: the page hears neither `checking` nor the first
  `downloading`, which fire before the dialog mounts. **It went away about 240 ms after the card
  sync's `done`, and does not wait for the feeds.** A real download's phases in that dialog
  were not seen.
- **Storage afterwards**: OPFS held 64 files, 960 569 344 B — one file of 959 451 136 B (the
  corpus), `user.db` at 864 256 B and 62 empty slots. `estimate()` said 1 238 382 026 B of
  11 975 800 266 B, and `persisted()` was `false`. Round one was about 526 MB; this machine's
  desktop `corpus.db` is 950 554 624 B, so **the web corpus is the desktop's size**.
- **Memory**: the module's linear memory was **203 358 208 B (193.9 MiB)**, read from the
  Worker's live instance over its CDP session — already there at the first reading, 8.8 s in,
  and it never grew through the tags, the combos or Card Kingdom. Round one: 148.6–171.6 MB.
  The Worker's JS heap peaked at 33.3 MB used (sampled every 2 s), and the renderer process's
  working set at 645.8 MB.
- **Search afterwards**, nine calls each — the first, then the median of the rest, in ms:

  | Call | First | Median of the rest |
  | --- | --- | --- |
  | `bolt` | 8.5 | 1.7 |
  | `bolt`, playable | 2.4 | 1.9 |
  | `dragon`, playable (2 363 hits) | 67.6 | 59 |
  | no text, playable | 42.2 | 42.5 |
  | `forest` | 50.5 | 55.9 |
  | `facet_cards`, `bolt` | 4.9 | 1.7 |
  | `facet_cards`, no text | 5.6 | 4.8 |

  Round one: search median 53 ms, cold 134 ms; facet 5 ms.
- **A reload with the corpus present**: the database open at 1 843 ms, the shell at 2 161 ms,
  the first tiles at 3 107 ms. No cross-origin request went out but the card pictures', which
  fail — the page still asks `mtgimg.localhost`, and that is step 5.3's — so every tile shows
  the card's name and "Retrying…". (**True of this step's build only.** Since step 5.3 the
  web build asks its own origin and the tiles draw their pictures; the same reload, with
  pictures and with the server stopped, is timed in §9.3.)
- **The suites, on the final tree**: `cargo test` green for the four packages, and clippy clean
  natively and for wasm32. The frontend suite green in four shards but for one test in a file
  this change does not touch (`src/components/table/VirtualTable.test.tsx`), which failed once
  under load and passed alone. **The final module is 8 592 080 B, 3 001 242 B through
  `gzip -9`.**

**Reviewed before it shipped**, by a reader given the code and not the conclusion. **No
must-fix**: the native paths are unchanged request for request, and the streamed card sync
cannot reach its swap over a short body or a long one. Seven should-fixes, each closed in the
same change and each with a mutation run against its test:

- A pushed feed body that ended early was stored as a prefix.
- The stall timer could fire over another future's synchronous work — which is the second look,
  and the launch's downloads run in turn rather than joined.
- `persist()` froze a first visit's no.
- Progress on a decoded body was an event per chunk, with the bar pinned at 100 %.
- The attach-side guard — never delete a corpus for a transient failure — had no test.
- The cleared-storage detection missed an open that created the folder and then failed.
- False sentences.

**Found and left**, each with what is known:

- **The synchronous tails freeze the engine, with the wall drawn and nothing saying why.** The
  figures are above: the card sync's `ingesting` from 17 770 to 22 465 ms, 11.3 s and 23.4 s of
  tag finish, 3.7 s of combo store, and a longest wait of 26.1 s. Assessed and not built: the tag and combo tails already
  write staging tables in short transactions and swap at the end, so each could be written
  once as an `async fn` that takes a turn between batches — under a hundred lines.
  `ancestor_closures` is pure CPU with no batch boundary; each batch commit is a
  rollback-journal cycle in OPFS, which may be most of the time; and the card swap is one
  transaction by need, as Card Kingdom's store is by contract.
  - **Built in step 5.3, the same day (§9.3)**, for the tag and combo tails: each takes a
    turn between its batches, and on a host with no files the tag closure is written in key
    order, 8 000 rows to a transaction. One run on that module: the oracle tags' finish
    **1.74 s** against the 10.76 s and 11.34 s here, the art tags' **4.11 s** against 23.56 s
    and 23.38 s, all launch feeds done at **50.84 s** against 76.07 s and 76.56 s, and a
    longest single wait of **4.79 s** against 23.57 s and 26.1 s. **What is still one
    synchronous stretch**: the card finish — which is now that longest wait — each tag
    file's swap, the combos' swap and Card Kingdom's store. `ancestor_closures`, which has
    no batch boundary, needed none: natively it is 4.3–6.5 ms.
- **A chunk is inflated whole before it is framed.** A synthetic 1.9 MB chunk that inflates to
  185 MB took linear memory to 946 733 056 B; real data peaked at the 193.9 MiB above. Feeding
  the decoder in slices is about forty lines, and touches the native paths' batch boundaries.
- **With no denominator, the feed rows show no byte figure at all** (`src/lib/activity.ts`
  draws megabytes only against a total).
- **The first-run label reads the generic "Syncing card data" until a `downloading` event is
  heard**, because the launch's downloads start before a face has mounted its listeners.
- **`estimate()` was 278 MB above the files.** Not explained; it gates nothing.
- **No metered-connection hold on the web host.** Android has one (§8.4).
- **A corpus damaged inside a sound first page is not looked for in a browser**:
  `check_corpus` needs a second connection.
- **`eprintln!` is still silent on wasm.**
- **On an Android tablet at desktop width with an empty corpus, `DownloadsPrompt` — a `Dialog`
  — would sit under the first-run gate.** Read, not driven.
- **A deck-category write's readback is priced at the stored marketplace, not the fallback**,
  until the next list read (`deck_meta.rs`'s `readback_marketplace`). Reachable only once a
  stored Mana Pool choice can arrive in a browser, which is sync — phase 6.
- **The notice's mark is `localStorage`**: a browser that clears it together with OPFS shows a
  silent first run. No real eviction has been seen.

**Not measured.**

- **Any second run, and a quiet machine**, for every figure of the first run above.
- **The desktop face's first-run dialog over the engine** — the run was the phone face.
- **Any browser but Chromium on Windows, and any phone.**
- **The dead-engine screen, and a real trap.**
- **A real eviction.**
- **The pool's `delete_db` in a browser**: the native tests stand a closure in for it.

### 9.3 Step 5.3 — the service worker (2026-10-04)

A built web app draws its card pictures, opens with the network gone, and holds a newer build
until the reader takes it — and the engine answers through two finishes it used to be silent
for. Numbered for its step: §9.4's was merged first (#807), so that section's passes are over
a tree with no service worker in it. The page's rules are
[`mobile/CLAUDE.md`](../../mobile/CLAUDE.md)'s *The web host*; the engine's are
[`crates/grimoire-core/CLAUDE.md`](../../crates/grimoire-core/CLAUDE.md)'s *A finish that
writes staging…* and *The command table*; the picture cache's are
[image-cache.md](image-cache.md#in-a-browser-cache-storage-and-a-service-worker).

**What was built — the worker and the shell.**

- **Hand-written, in `src/lib/core/web/sw/`, and its own `tsc` program.** `sw.ts` is the four
  events only a real worker has, and has no branch of its own. What it decides is in the four
  modules beside it, with no global in them, and the suite drives those over fakes: `shell.ts`
  (which request is whose, and the cache's name), `pictures.ts` (a picture's path, the
  budget), `bridge.ts` (asking the page where a picture is) and `serve.ts` (the install, the
  activation and every answer, with its caches, its `fetch`, its pages and its clock handed
  in). `tsconfig.web-sw.json` holds `sw.ts` under the `WebWorker` lib and the root program
  excludes that one file, as it excludes the database Worker's; the four modules are followed
  from both programs, so each is checked under both libs and may name no global only one has.
- **Built by the `web` mode alone, and last.** `vite.sw.ts`'s plugin runs in `closeBundle` —
  the first hook at which the build's hashed names and the public directory's copies are all
  on disk — and makes one nested build: an IIFE at `dist-web/sw.js`, with a fixed name, no
  chunk and no hash. Its address is the one thing in the build that must not move: a browser
  finds a new build by asking for that file again. No other build has the plugin, so `dist/`,
  `dist-mobile/` and `dist-share/` carry no worker. **Only after a build that wrote its
  files** (`writeBundle`): Vite empties the output at `renderStart`, so a build that failed
  before then leaves the last build's document on disk, and a worker built then would name
  that build's files as this one's. A nested build that fails, fails `web:build`.
- **Registered only by the built web app's page, and never by `web:dev`.** The web core's page
  half registers `/sw.js` under `import.meta.env.PROD`, with `updateViaCache: "none"`. A dev
  server behind a service worker goes on serving the last build it cached, so `npm run
  web:dev` registers nothing — **and therefore draws no card picture**. `npm run web:preview`
  is the command that runs the worker, and it serves `sw.js` `no-cache`, as a host must.
- **One shell cache per build, `grimoire-shell-<build id>`.** The id is `shell.ts`'s
  `shellBuildId` — `assets.ts`'s `buildIdOf`, the engine's own FNV hash — over every file the
  build wrote but `sw.js`, **the ones that are not precached included**: a deploy that
  changed only the host's `_headers` is a new id, a new worker and a new shell cache, which is
  the one way a changed policy reaches a reader who already has the app. **Unchanged sources
  give a byte-identical `sw.js`**, which is the property the update flow rests on: a browser
  decides there is a new worker by comparing that file's bytes, and a timestamp in it would
  put *a new version is ready* in front of a reader with nothing to gain.
- **What is precached** (`shell.ts`'s `precacheList`): the document as `/` — never
  `/index.html`, which a static host redirects, and a redirected response may not answer a
  navigation — and every other file by its own path, sorted. Not `sw.js`, which the browser
  keeps, and not a top-level entry whose name starts with `_` or `.`, which a host reads
  rather than serves.
- **The install is all or nothing.** Every file is fetched with `cache: "no-cache"`, so a
  stale document in the HTTP cache is never paired with this build's files; each is **read to
  its end as it arrives, four at a time** (`serve.ts`'s `PRECACHE_LANES`), and nothing is
  written until the last has. One that does not answer 200 fails the install, and the build
  the reader already has goes on working. **A path that is not a document and is answered as
  `text/html` refuses the install too**: a host that hands its document to any path it does
  not know answers a missing script with a 200 of HTML, and that is a broken deploy to refuse
  rather than to cache. **A worker whose install fails says why to every open page** before
  it is dropped (`grimoire:install-failed`), and the page says it once on its console — a
  browser tells nobody.
- **Routing is a closed list, and passing through is the default** (`shell.ts`'s `routeFor`).
  A request that is not a `GET`, one to another origin, and a same-origin file the build does
  not know get **no `respondWith` at all** — so the engine's own downloads, the 78 MB card
  file among them, never go through this worker. A navigation to a place is answered with
  the cached document. One of the build's own files (`/assets/`, `/wasm/`,
  anything precached) is answered from **its own build's cache, then by the network's own
  answer — never the document**: a page handed HTML for a script fails on a MIME error
  rather than a missing file, and that is the failure an update must not meet. The picture
  prefix is read before the mode, **and a navigation under it is a 404**: a picture's
  address opened as a page is never the app and never the picture either — a picture is
  drawn by an `<img>`, and a body this worker stored is never served as a document on the
  app's own origin.
- **A Cache Storage that throws is a miss, not an outage.** A shell lookup that throws goes
  to the network, so with the host online the app loads as if there were no worker; a
  picture is asked for, fetched and answered, and only not kept; and the activation's
  housekeeping never rejects, so the claim follows whatever it did.
- **Every Cache Storage lookup and delete passes `ignoreVary`, and it is part of the type**
  (`pictures.ts`'s `CacheLike`). A static host answers `Vary: Origin`, a precached entry was
  stored from a request with no `Origin`, and the page's module scripts carry one — so
  without it every asset misses, and with the server up nothing shows it. Round one measured
  the blank page on 2026-08-28.
- **A first visit is claimed, not reloaded.** The worker calls `clients.claim()` on every
  activation, so the page already open comes under it and the pictures it asks for from then
  on are answered; the page's own guard keeps that first `controllerchange` from being read
  as an update. **A hard reload starts a page no worker controls**, by the browser's own
  rule, for the life of the document: the page posts `grimoire:claim` to the active worker,
  which takes it.
- **An activating worker deletes the other builds' shells, by prefix** — `grimoire-shell-`
  and nothing else, because the picture cache is in the same Cache Storage and belongs to no
  build.

**What was built — card pictures.**

- **A picture's address is the app's own origin**:
  `<origin>/mtgimg/<variant>/<card id>/<face>`. `src/lib/images.ts`'s `imageOrigin` answers
  it in the `web` build, by the build's mode, so **no call site changed** and no other
  bundle carries the branch. A prefix and not the root, because the root's first segments
  are the app's places.
- **Kept in `grimoire-pictures-v1`, which is not per build**: a deploy that threw the
  pictures away would undo the point of keeping them. The key is the address without its
  query — `useImageRetry`'s `?retry=N` and `CardImage`'s `?stall=N` are new requests for the
  same picture.
- **A miss is asked of the engine through the page.** The engine is in a dedicated Worker
  that only the page which made it can reach, so the service worker posts
  `grimoire:picture-source` to **the page that asked**, over a `MessageChannel` made for that
  one question; the page asks its `Core` for `card_image_source`; and the answer comes back
  on the port. A request no page is known to have made asks each window in turn.
- **The worker fetches from `https://cards.scryfall.io` and nowhere else** (`isFetchable`,
  the desktop fetcher's own rule), with CORS and no credentials, and **stores a response
  rebuilt from the bytes**, never the one `fetch` returned. That is what lets the page's
  `img-src` be `'self'` alone: measured on the hosting step's branch in Chrome 154, a
  cross-origin response passed through by a service worker is refused by `img-src 'self'`,
  and only a rebuilt one loads. The rebuilt response carries the size the body was measured
  at, when it was stored (`X-Grimoire-Stored`) and the address it came from
  (`X-Grimoire-Source`, Scryfall's `?<epoch>` included).
- **A 200 is not yet a picture.** What is kept is served again on the app's own origin for
  as long as the address stands, so the worker stores only a body that declares a raster
  image (`pictures.ts`'s `PICTURE_TYPES` — never SVG, never HTML) and has bytes in it; an
  error page under a 200, or an empty body, is a failed fetch. Everything answered under the
  prefix carries `X-Content-Type-Options: nosniff`.
- **The answers are the desktop protocol's statuses**, so `useImageRetry` and `CardImage`'s
  watchdog heal them as they heal the desktop's:

  | What the worker found | Answer |
  | --- | --- |
  | The picture, in the cache | 200, and the engine is not asked |
  | The engine says `uri`, and the fetch succeeds | 200, rebuilt and stored |
  | The engine says `missing` | 200, the desktop's placeholder SVG, `no-store`, never stored |
  | The engine says `unknown`; the path is under the prefix and is no picture's — a face that is not `0` or `1`, a variant nothing stores; or it was asked for as a page | 404 |
  | No page to ask, a page or an engine that does not answer; Scryfall answers 429 | 503 with `Retry-After` |
  | The fetch failed; Scryfall answered any other status, a 200 that is not a raster image, or an empty body | 502 |

- **One ask per picture in flight**, as the desktop cache is single-flight per key: a wall
  that mounts a card twice, a watchdog's second ask and a retry each join the ask already
  out. **The bridge waits 20 s for a page** (`bridge.ts`'s `ASK_TIMEOUT_MS`) — long on
  purpose, since a call made during a synchronous finish waits for it, and a frame that
  gives up and asks again joins the same ask.
- **The budget is 3 000 entries, swept once the cache is past 3 100, oldest first by Cache
  Storage's own insertion order.** Entries and not bytes, and no ledger: Cache Storage keeps
  no size and no access time, and a second record beside it can disagree with it — round
  one's counted 9 of 78 pictures. Nothing is spared; a browser has no pre-warm to fetch a
  spared picture back.
- **A picture stored more than 7 days ago is served and then checked against the engine**:
  the same address puts the same bytes back under a new stamp, which also moves the entry to
  the young end of the cache's order; a changed address fetches the new picture; `missing`
  deletes the entry, because the card is known and has no picture any more. **`unknown`
  leaves it**: after a card-data clear, or a corpus the engine replaced, that is every card
  until the sync has run again.
- **Settings' *Clear cache* is answered on the page**, from Cache Storage, in the shape the
  panel already reads — entry by entry, the bytes a sum of each entry's own `Content-Length`.
  The engine is not called: on this host it holds no picture. No panel was forked.
- **The engine says where a picture is and fetches nothing**: `card_image_source(path)`, over
  `images::resolve` whole — `{"kind":"uri","uri":…}`, `{"kind":"missing","svg":…}` or
  `{"kind":"unknown"}`, and never an address that is not Scryfall's. It is in the core's
  table and on **`TABLE_ONLY`** in `src-tauri`'s parity fence — a fourth list, a reason per
  entry — because the desktop has no wrapper for it and is not to grow one nobody calls.

**What was built — the update flow.**

- **A new build installs and waits.** Nothing in the worker skips the wait; while a page of
  the old build is open the old worker goes on answering from its own cache, a reload
  included — which is why a reload is not an update.
- **The host says so, and only the press hands over.** Two host commands and an event
  (`src/lib/core/hostUpdate.ts`), answered on the page by the web core and refused by every
  other host: `host_update` → `{ title, action } | null`, `host_update_apply`, and
  `host-update:changed`. **Not the desktop updater's `update_status` and `update_apply`.**
  `mobile/UpdateNotice.tsx`, mounted by `LightApp` beside the faces, draws only what the
  host answers, in the host's words, as `StorageNotice` does: not a modal, along the bottom
  clear of the phone face's tab bar, its `role="status"` mounted before it has anything to
  say. The press posts `grimoire:skip-waiting` to the waiting worker; the page reloads once,
  on the new worker's `controllerchange`. A press with nothing waiting is **refused in a
  sentence**, so the control that greyed itself comes back.
- **The bar is on `LAYER.header`, and it can be put away.** The highest rung a page itself
  draws on: over a wall and its sticky header, under everything a reader opened — a menu, a
  picker, a dialog. It was on `popup` until the review, where, being later in the document
  than either face, it painted over a menu opened near the foot of the window. *Not now*
  hides it until the host next speaks of an update, or until the next load; the waiting
  build is not touched, and `FaceBoundary` still offers it.
- **A first install is not an update, and being claimed is not being taken over.** A worker
  that reaches `installed` on a page nothing controls is not reported, and the first
  `controllerchange` of a first visit is not a reload.
- **Only the page that holds the database starts again.** A second tab never activates a
  build and is not reloaded by the press: its database never opened, its only control is
  already a link to a fresh document, and a reload would race the tab that pressed for the
  database — as would a tab still opening.
- **A page that comes back into view asks for a newer worker, at most hourly**: an installed
  app left open navigates nowhere, and a browser looks only on a navigation and about once a
  day.
- **`FaceBoundary` offers the update when one waits, and the reload otherwise** — §5's
  leftover, closed there.

**What was built — the engine: two finishes that take turns.**

- **`platform::timer::Turn`, `NoTurn` and `unbroken`.** A feed's finish is a run of short
  transactions with the connection given back between two of them; natively that gap is for
  another thread, and in a Worker it lets nobody in unless the loop returns to the event
  loop there. So each finish is **one body**, an `async fn` that awaits a `Turn` in every
  gap: `tags::StreamTags::finish_in_turns` and `combos::store_in_turns`. The streamed arm
  hands it the `Breather` its download kept; the file-backed door hands it `NoTurn` and
  runs it through `unbroken`, which is a function call — one poll, no runtime.
- **Natively the statements and the transactions are the ones they were**, and that is
  pinned by SQLite's own commit hook, as numbers read off the tree before the change: **13**
  commits for the oracle fixture, **14** for the art one, **6** for the combos'.
- **On a host with no files the tag closure is written in key order, 8 000 rows to a
  transaction** (`tags::ClosurePlan::of_this_host`), where every other host writes it in the
  file's order, 2 000 at a time, as it always has. The rows that land are identical — a test
  compares every table of both taxonomies written both ways. The timings behind it are below.
- **Two races, decided and tested.** A `combos_clear` taken between two batches is answered
  truthfully, and the swap that follows installs the new file with its watermark — the only
  press that reaches it is *clear, then a forced refresh*, and a file fetched a moment ago
  is what that asks for. A second refresh of the same feed mid-finish is **refused**: the
  claim is held until after the swap. A `cache_clear` mid-finish is refused by the claim
  check it already had.
- **What takes no turn**: the card finish (one transaction by need), each tag file's swap —
  one transaction that also rebuilds two indexes over the whole closure — the combos' swap,
  and Card Kingdom's store.

**What was built — the smoke run.**

- **Fourteen checks on the day, listed in the script's header.** What this step added: the
  worker controls the page and its one shell cache holds the document, the database
  Worker's chunk and both engine files; a tile's picture is decoded, and stored under the
  app's own address with `X-Grimoire-Source` naming the fixture address it came from, and a
  second ask does not reach the picture host; **offline — the server dropping every
  connection unanswered — a reload draws the app, opens the database, answers a search and
  draws the cached picture**; *Clear cache*, pressed in Settings, empties the pictures and
  leaves the shell; a second `sw.js` installs and waits with the bar drawn and two shell
  caches standing, no bar in the second tab, and a reload changing none of it; and the
  press hands over with exactly one new document.
- **Picture fixtures**: every address the six fixture cards name is answered with
  `scripts/web-smoke/card.webp`, 736 B. **`mtgimg.localhost` is no longer excused** — a
  request there fails the run, as a request to any host without a fixture does.
- **A browser-level `Fetch.enable` pauses a service worker's fetches too** (confirmed,
  Chrome 154), so §9.2's one enable still covers every request.
- **`scripts/ci-route.mjs` routes `vite.sw.ts` to `frontend` and `web`**, named rather than
  left to the fail-safe, which would run the Rust matrix for a service worker.

**Measured, 2026-10-04, offline: the smoke run.** Windows 11, headless Chrome 154.0.8037.95.
**Ten passes of ten on the final file, in 9.2–12.5 s**; 75 further direct runs before the
last small edit passed. **One failure in about a hundred runs is unexplained**: *the first
tab did not open its database*, 1.4 s in, under a mutation harness whose filter cut off the
reason. Eight repeats passed, and the message now prints the page's console.

**Measured, 2026-10-04, natively: the closure write behind `ClosurePlan`.** A release
build on NTFS, Ryzen 9 5900X, over the real art graph rebuilt from the dev corpus — 11 603
tags, 488 864 taggings, 53 237 illustrations, 979 249 closure rows. The closure's write
alone, in seconds, two runs each:

| Journal | File order, 2 000 rows | File order, 8 000 | Key order, 2 000 | Key order, 8 000 |
| --- | --- | --- | --- | --- |
| Rollback — what a browser's file gets | 16.6, 17.8 | 10.5, 10.5 | 6.1, 5.4 | 2.6, 2.8 |
| WAL — every native host | 10.4, 11.6 | 9.8, 8.3 | 4.2, 5.2 | 2.1, 2.1 |

- **The cost is order more than batch size.** The closure's key is `(subject, slug)`, the
  file's order puts nearly every row on a page of its own, and a rollback journal writes
  every touched page twice.
- **`ancestor_closures` itself is 4.3–6.5 ms**, so the graph walk takes no turn and needs
  none. **Each tag swap is 1.1–2.0 s natively.**
- **The desktop was left alone**: its native statements were not to move in this step. It
  would gain the same on its weekly art refresh — a decision not taken, not one taken
  against it.

**Measured, 2026-10-04: one first run against the real hosts, on this step's module.**
Windows 11, Ryzen 9 5900X; headless Chrome 154.0.8037.95; the built app through
`web:preview`; a fresh profile; the default headless window, inner 764 × 485, so the phone
face. Started 07:49:50 UTC. **One run, and the machine was not quiet** — total CPU read
17–38 % during it. The module is **8 684 745 B**, 3 030 884 B through `gzip -9` (step 5.2
shipped 8 592 080 B and 3 001 242 B; **the last module of this size** — §9.6 took the OCR
runtime out, and ships 6 767 338 B); `sw.js` is build `318e5370c53b423c`, with 42 files
precached. Beside it, §9.2's two runs, which were not like for like with each other either:

| | This run | §9.2's first run | §9.2's second run |
| --- | --- | --- | --- |
| Database open | 796 ms | 1 007 ms | 891 ms |
| Card download | 16.47 s | 16.40 s | 15.30 s |
| Card finish | 5.26 s | 4.70 s | 4.28 s |
| Cards `done` | 24.48 s | 23.81 s | 21.87 s |
| Oracle tags' finish | **1.74 s** | 11.34 s | 10.76 s |
| Art tags' finish | **4.11 s** | 23.38 s | 23.56 s |
| Combos' finish | 4.10 s | 3.67 s | 3.80 s |
| All launch feeds done | **50.84 s** | 76.56 s | 76.07 s |
| Longest single wait | **4.79 s** — the card finish | 26.1 s | 23.57 s |
| Linear memory, peak | 205 979 648 B | 203 358 208 B | 203 227 136 B |
| Renderer CPU time | 57.4 s | 79.6 s | 82.1 s |

No error, and the same rows in every table as before.

- **Inside each finish**, with a `sync_status` sent once a second through the page's core:

  | Finish | Moments it answered | Longest stretch with no answer | Longest single wait |
  | --- | --- | --- | --- |
  | Oracle tags | 3 | 0.96 s, at the end | 53 ms |
  | Art tags | 4 | 2.06 s, at the end | 1.10 s |
  | Combos | 3 | 1.65 s, at the end | 0.81 s |
  | Card finish | none | 5.3 s | 4.79 s |

  In each feed the longest silent stretch is the last one before `done`, which is
  consistent with the swap — **its position was timed, not its cause**. **The samples are
  few**: 1, 5 and 4 of the once-a-second calls fell inside the three feed finishes. During
  the card download all 16 calls answered, in 6–476 ms, median 246 ms.
- **The first visit.** The precache ran from 109 ms to 942 ms after navigation and the
  worker took the page at 980 ms — 22 s before the first picture was asked for. 1.29 MB
  crossed the wire for the 12.2 MB shell, the page's own loads being revalidated rather
  than fetched again. Nothing showed it competing with the engine's start.
- **Pictures, uncached.** On the first wall, mount to decoded took 1.15–1.72 s, median
  1.70 s, for the 20 tiles that stayed mounted — and that is the fetch itself: the worker's
  requests to `cards.scryfall.io` took 0.56–2.04 s, median 1.67 s. With the engine idle:
  0.98–1.74 s, median 1.73 s. **Inside the art tags' finish**: 24 pictures, 1.12–2.24 s,
  median 1.88 s. **All 105 picture requests the page made were answered 200 by the worker —
  none 503, and no `error` event.** While it waits a tile is an empty frame.
- **What reached Scryfall**: 66 requests, all 200 over h2, 5 165 161 B. The worker's request
  headers were the browser's own `User-Agent` and `Referer`; the response was `image/webp`
  with `Access-Control-Allow-Origin: *`.
- **Pictures, cached, after a reload**: 22–27 ms for 18 of 20.
- **A back face was not reached in the real run** — the phone card sheet has no control
  that turns a card over. Over the smoke's fixtures a transform card's `/1` came from its
  `back` address.
- **Reloads with the real corpus**, in milliseconds after navigation:

  | | Online | Offline — the preview server stopped |
  | --- | --- | --- |
  | Database open | 2 031 | 1 923 |
  | Past the gate | 2 349 | 2 235 |
  | First tiles | 3 313 | 3 144 |
  | First picture | 3 324 | 3 150 |

  Offline, all 20 pictures came from the cache in 19–25 ms, and a search answered in 11 ms
  and then 2 ms.
- **Storage afterwards**: OPFS 64 files, 959 537 152 B; `grimoire-shell-318e5370c53b423c`
  42 entries, 12 215 805 B; `grimoire-pictures-v1` 64 entries, 5 018 940 B by their
  `Content-Length`. `estimate()` said `usage` 1 255 719 794 B — caches 17 329 152, the file
  system 1 238 382 026, the registration 8 616 — and `persisted()` was `false`.

**Reviewed before it shipped, and found by the run** — each closed in the same change:

- **A stored picture trusted any 200 body, and Scryfall's `Content-Type`.** An empty 200 or
  an HTML one would have been kept as that card's picture, and a navigation to a picture's
  path could have rendered stored HTML on the app's own origin. Three locks now: only a
  declared raster image with bytes in it is stored, a navigation under the prefix is a 404,
  and every answer there says `nosniff`.
- **The shell side had no answer for Cache Storage failing**, and a housekeeping pass that
  failed skipped the claim. A throw there was every navigation answered with a network error
  by a worker the reader cannot get rid of short of clearing the site's data — which takes
  the collection in OPFS with it. It is a miss now, and the claim follows the housekeeping
  whatever that did.
- **The install hung for good on an HTTP/1.1 host that serves the shell `no-store`** —
  measured in Chrome 154: 7 of the 42 requests reached the server. The precache read no body
  until every fetch had answered, an unread body holds its connection, and such a host gives
  a browser six. An HTTP cache hides it — a cacheable body is drained into the cache whether
  or not it is read. Each file is now read as it arrives, four at a time.
- **The update bar could not be put away**, and sat over the last row of a wall: *Not now*.
- **The build id is pinned to include `_headers`**, a file the host reads and the worker
  does not precache (`shellBuildId`, with its test).
- Smaller: the worker's face grammar was looser than the engine's — any number of up to
  three digits, where the engine serves `0` and `1` — and a stale picture was deleted when
  the engine answered `unknown`.

**Found and left**, each with what is known:

- **Cache Storage throws `UnknownError` when Chrome's profile path is long, on Windows.** The
  install fails and the page runs with no worker — no picture, no offline shell. It used to
  say nothing at all; the page's console now says so once, with the worker's own reason
  where the worker got one across. On the console and not on the page: the app works, and a
  reload retries the install.
- **The card finish is still one synchronous stretch, 4.3–5.3 s across the three runs
  above, and each tag swap 1–2 s.** The figures are in the tables.
- **A picture is stored twice**: in the HTTP cache and in Cache Storage.
- **The 3 000-entry sweep and the weekly re-check were driven over a fake cache only.** The
  real run stored 64 pictures, all the same day.
- **A browser that evicts Cache Storage under a live page**, with no update waiting and the
  old chunk gone from the host, cannot draw a lazy face that page has not loaded (§5).
- **The one smoke failure above.**
- **The desktop's closure is still written in the file's order.**

**Not measured.**

- **Any browser but Chromium on Windows.**
- **An installed PWA.**
- **A real eviction**, of the pictures, of the shell or of both.
- **The bridge's 20 s bound in a real browser**: no picture waited that long.
- **A second run of these figures, or a quiet machine.**

### 9.4 Step 5.4 — the browser's seams and the manifest (2026-10-04)

What a face still asked a Tauri window for, answered below `@/lib/core`; the web manifest
finished and moved to where only the light builds copy it; and phase 1's two history leftovers
(§5). The rules that came out of it are in [`mobile/CLAUDE.md`](../../mobile/CLAUDE.md).

**What was built — the clipboard and a link out.**

- **A second seam beside `Core`: `Host`** (`src/lib/core/types.ts`) — `copyText` and `openUrl`,
  the spec's §3.5 third row. Not two more methods on `Core`: a `Core` is the command boundary,
  which can be deferred, refused or wrapped whole, and neither of these reaches a backend.
  **`src/lib/core/index.ts` chooses `host` where it chooses `core`, by the same two questions**:

  | Build, or window | Chosen by | Copy | Open a link |
  | --- | --- | --- | --- |
  | The web build | `import.meta.env.MODE === "web"` | `navigator.clipboard.writeText` | `window.open(url, "_blank")`, the opener cut at once |
  | The Android host | the mark it sets, `__GRIMOIRE_CORE__` | `navigator.clipboard.writeText` | Tauri's opener plugin |
  | The desktop, `mobile:tauri`, the fake | everything else | Tauri's clipboard plugin | Tauri's opener plugin |

- **`@/lib/clipboard`'s `copyText` and `@/lib/externalLinks`' `openExternal` keep their
  signatures**, so no call site changed and every suite that mocks either module still does.
  The two plugins are imported in `src/lib/core/tauri.ts` and nowhere else — the one door
  `fence.test.ts` lets the phone face through — so the URL builders beside `openExternal` are
  importable by that face.
- **One sentence for a copy with no clipboard, on both faces**: `this browser offers no
  clipboard here.`, the tail of whatever the caller frames. The phone's own `copyToClipboard` is
  deleted and its export sheet copies through `@/lib/clipboard`. No `execCommand` fallback.
- **A link is opened without the `noopener` feature, and the opener is cut on the next line.**
  The feature makes `window.open` answer `null` whether or not a tab opened, and `null` is the
  only thing that says a pop-up blocker refused one — which is what the Sync panel's *Connect
  Patreon* meets, opening after a round trip to the engine. A refusal is a rejection the panel
  reports: `The link could not be opened. This browser may be blocking new tabs.`
- **A browser's `openUrl` opens only a whole `http` or `https` address** (added in review). On
  the desktop the opener's `allow-default-urls` scope refuses anything else whatever a caller
  hands it; a page's `window.open` refuses nothing, and a `javascript:` URL there would run in
  the app's own origin, beside the database. Every caller today builds its address or takes it
  from the note dialect, which keeps only `http(s)`, so this is the fence behind them. No
  `mailto:` or `tel:`: nothing in the app opens one. The Android host never reaches
  `window.open` — its arm is the opener — so its fence is still the scope.
- **The Android host opens through Tauri's opener, which is not what this step's brief said.**
  The brief had neither plugin granted to that page. The opener is: `capabilities/light.json`
  holds the desktop's exact pair and `mobile/host.test.ts` holds the list. It is also the
  answer that needs nothing from the WebView — a `window.open` there navigates the app's own
  window, and only the host's guard turns that back into a hand-off. The clipboard *is* the
  WebView's own, because the host registers no clipboard plugin; until this step the desktop
  face on a tablet asked for one that was not there (read off `mobile/src-tauri/src/lib.rs`,
  not driven). **That an Android WebView grants the write is an assumption**: its origin,
  `http://tauri.localhost`, is a secure context, so the API is there to call, and no copy has
  run on a device from either face — the phone's export sheet has called it since phase 3 and
  no record shows it doing so on a phone. If it is refused the cure is a clipboard plugin on
  that host, which this step did not add.
- **`dist-web/` carries neither plugin, and this step's first build of it carried both.** The
  first `tableHost` read
  `browserHost.copyText` and `tauriHost.openUrl` at the top of its module, and a member read
  there is something a bundler must assume has an effect: the object stayed in the web build,
  and both plugins' calls with it. Written as two functions that call, it and they fall out.
  The desktop's `dist/` and the APK's `dist-mobile/` carry both, as they always did.

**What was built — files on the desktop face in a browser.**

- **The web host answers `export_save_file` and `import_pick_file` on the page**
  (`src/lib/core/web/files.ts`'s `answeringFiles`), in the desktop commands' own result shapes
  — `boolean` and `ImportFile | null`, a refusal a bare string — so
  `src/features/transfer/files.ts`, both dialogs and `ipc.ts` are untouched. The engine's table
  has neither: a Worker has no document. It is a wrapper round the Worker's `Core`, composed at
  the dynamic import in `src/lib/core/index.ts`, so `web/index.ts` did not change.
- **Two sets of page commands, each with its own answerer.** `web/index.ts` answers the gate
  and step 5.2's three storage commands; this answers the two files in front of it and sends
  everything else on. A test builds the pair as a build does and holds that the Worker is asked
  to open and nothing else for the first five, and is never sent a file command.
- **What a save reports, per host:**

  | Host | The desktop face's `export_save_file` | The phone face's `saveText` |
  | --- | --- | --- |
  | Desktop | `true` written, `false` cancelled | — |
  | Android | `true`, `false` | `"saved"`, `"cancelled"` |
  | Web | `true`: *handed to the browser* | `"handed"`, drawn as `Downloading <name>.` |

  The web's `true` is honest only because of what its one reader draws: `ExportDialog` says
  nothing after a save on any host and never reads the boolean. Its button still says
  `Save as…`, and a browser may not ask where.
- **The pick is a hidden `<input type="file">`, pressed for the reader**, with the phone
  picker's accept list. `change` answers the file and the input's own `cancel` answers `null`,
  as the desktop's cancelled dialog does. **Where a browser reports no `cancel`, the window's
  focus coming back is the fallback** (added in review): a second after it returns with
  neither event, the input itself is asked — a file on it is the pick, none is a cancel — and
  a `change` or a `cancel` inside that second wins. The first build had no fallback and said a
  second ask would rescue the first; the Import dialog greys its button while the pick is
  pending, so no second ask could come. A second ask still answers the first with `null`, for
  a caller that can make one. Held by tests with the events simulated; the second is a chosen
  figure, and a browser that hands a file over later than that after giving the focus back
  would have the pick read as cancelled.
- **A download's object URL is released after forty seconds, not after a task** (changed in
  review). A browser reads the `Blob` through the URL on its own schedule — after a save
  prompt, in some — and a URL revoked first is a download that fails; forty seconds is
  FileSaver.js's figure for the same reason. Only headless Chrome was driven, where one task
  had been enough.
- **The megabyte and the four readings are shared, not copied**:
  `mobile/phone/transfer/browserFiles.ts` moved to `src/lib/core/browserFiles.ts` — a leaf, so
  `files.ts` and the web host both import it without a cycle — and took `downloadText` with
  it. The phone's import sheet keeps an input of its own on every host and reads through the
  same module.

**What was built — the phone card sheet's `Open on` rows.**

- **`mobile/phone/card/OpenOn.tsx`**: Scryfall, EDHREC and the selected marketplace, the
  desktop's ladder in the desktop's order, **as `<a target="_blank" rel="noopener noreferrer">`**
  — which a browser opens in a tab, and phase 4's guard hands to the system browser on Android.
  The implementer's pick, to be redirected in review: at the foot of the sheet, under Combos;
  the heading reads `Open on`, a row's visible text is the site, and its accessible name is the
  whole phrase.
- **The addresses are the desktop's own.** `openMarketplace.ts` grew `marketplaceUrlForCard` —
  the press's whole decision with the lookup taken out — and `openMarketplaceForCard` now calls
  it, so the link and the press cannot disagree. A link always names a printing
  ([external-links.md](external-links.md)): the sheet names no finish, so the printing answers
  for itself.
- **One read the desktop does not make until the press.** An `href` has to exist before it is
  pressed, so the sheet asks `card_tcgplayer_ids` as it opens, and only while the marketplace
  is TCGplayer. Until it answers, and if it is refused, the row is the name search.
- **The phone's Settings draws `SyncPanel`**, the desktop's own, and its hand-written
  `window.open` is gone. The Spellbook link under Combos is still not drawn.

**What was built — the manifest.**

- **`mobile/public/light.webmanifest`**: an `id`, `start_url` and `scope` of `/`,
  `display: standalone`, both names, and both colours `#0C0D12` — `oklch(0.16 0.01 270)`
  converted by hand, and the value this Chrome rasterised the token to. The page's
  `theme-color` and Android's `colors.xml` took the same value, and `mobile/host.test.ts` holds
  the three equal.
- **Raster icons at 192 and 512 in two drawings**: the transparent mark, for the reason the
  desktop's icon is the mark ([`logos/README.md`](../../logos/README.md)), and a **maskable**
  one on the ground to every edge. One purpose to a file.
- **`node scripts/light-icons.mjs` made them**, from `logos/svg/mtg-grimoire-mark.svg` alone:
  it derives the maskable drawing rather than reading a third SVG, renders each size in
  headless Chromium over the DevTools protocol — no image library is a dependency — and
  **measures the furthest painted pixel**, failing a mark that leaves the safe zone. At
  `scale(0.70)` the mark reaches **37.5%** of the width from the centre, against 40%.
- **`mobile/public/` is the light builds' own public directory** (`vite.mobile.config.ts`'s
  `publicDir`), so the manifest and its icons reach `dist-mobile/`, `dist-web/` and both dev
  servers and nothing else. The favicon is a second copy of the mark there, held equal to the
  master by a test.
- **No install button, and nothing asks a `display-mode` question**: a browser's own install UI
  is the install.

**What was built — history.**

- **The phone router holds a place the browser would not write.** `navigate` writes, then
  reads the address: one browser throws on a rationed call and another drops it without a
  word, and the only thing both leave is an address that did not move. The place is then kept
  in memory, the listeners are told and the page draws it; the next write the browser takes,
  or the next Back, puts the address in step again. **Not a fallback to a replace**: the
  ration is one counter for both verbs, and a replace that was taken would rename the entry
  beneath — the page under an open card — and break `PUSHED`'s promise. Leaving a held place
  is forgetting it, unless the browser's own entry is a pushed card over the same page.
- **A card is pushed over its own page, or not at all** (found in review). The first build
  broke `PUSHED`'s promise itself: a press to `/decks/7` refused and held, then a card opened
  there and *that* push taken, left a marked card directly over `/collection` — and ✕, which
  goes back to what the mark promises is beneath, landed the reader on the page they had left.
  The router now writes the card's page first where the browser's entry is not it, and the
  card only once that landed; a page the browser still refuses leaves the card held with it.
  **Paid, rather than pushing the card unmarked**, which would also keep the promise: unmarked,
  ✕ renames the entry and is right, but Android's back gesture leaves the page with the sheet.
  It costs one more write from a browser that was rationing them.
- **Not every held page is paid back.** One the reader leaves by a push elsewhere never gets
  an entry, and Back's path is then a page short. **And a hold ends with the address it was
  made over**: a traversal ends it, and so does a write the desktop face made after a resize
  crossed the floor — the first build kept it until the next `popstate`, and would have drawn
  it over an address that had moved on.
- **`back()` waits `BACK_WAIT_MS`, 500 ms, for its Back.** Its one release was the `popstate`.
  When the wait is up and the reader is still where they pressed, the entry is renamed, as a
  linked card's is — which leaves the page as two entries, the cost a rename has there.
- **The desktop adapter owes a push the browser refused**, and makes its next write as that
  push whatever kind it would have been, marked `OVERLAID` if it carries a card.

**Measured and driven, 2026-10-04.** Windows 11, headless Chrome 154.0.8037.95, a fresh
profile for each pass, on the tree with step 5.2 merged in. Every host but `localhost` was
unresolvable (`--host-resolver-rules`), so nothing below is over a corpus.

- **The built app, through `vite preview` on port 4196**, at inner 360 × 800 and 1280 × 800:
  `Page.getAppManifest` answered the manifest with **no errors**, `Page.getInstallabilityErrors`
  answered **none**, and the four PNGs came back `image/png` and decoded at their declared
  sizes. **Not on 4176**: another worktree's preview held that port, the first pass read *its*
  manifest without saying so, and every pass here was moved to a port of its own.
- **What each output holds beside `assets/`**: `dist/` — `index.html` and the mark;
  `dist-share/` — the mark; `dist-mobile/` and `dist-web/` — the document, the manifest, the
  mark and the four icons, `dist-web/` with the engine under `wasm/<build id>/` as well.
- **The web app over the real engine, a dev server in the `web` mode on port 5196.** The
  database opened on a rollback journal. `copyText` put its text on the clipboard, read back
  with `readText`. `openExternal` outside a user activation was refused in the sentence above;
  inside one it opened a tab whose `window.opener` read `null`. `ipc.exportSaveFile` with a
  path for a name answered `true` and downloaded `Burn.txt` holding the text it was given.
- **The desktop face, 1280 wide.** *Export deck*: Copy drew `Copied.` and replaced what the
  clipboard held; Save as… downloaded `Burn.txt` and drew no alert. *Import cards*: Choose
  file… opened a chooser on the hidden input; a Windows-1252 file arrived in the box as
  `1 Séance` under the dialog's own notice about that reading, and the input was gone
  afterwards; a file one byte over the megabyte drew `Couldn't read a decklist from a file —
  That file is over 1 MB. …`. *Connect Patreon* opened Patreon's authorize address in a new
  tab.
- **The phone face, 360 wide.** The export sheet's Copy drew `Copied.`, its Save file drew
  `Downloading Burn.txt.`, and *Connect Patreon* opened the same address.
- **Two limits on that pass.** The deck was empty — nothing can be added with no corpus — so
  both dialog saves were empty files and the text was proven by the direct call. And **the
  desktop face's presses were scripted clicks inside a user activation, not pointer presses**:
  with no host to download from, that face sits under its full-window first-run screen, which
  takes the pointer. The dialogs are a rung beneath it and were found by their content.
- **The card sheet over the fake** (`mobile:dev`'s config on port 5215), 360 wide: three rows,
  44px each, nothing scrolling sideways; for Agadeem's Awakening, ZNR 90, the Scryfall
  permalink, EDHREC's router by name and
  `https://www.tcgplayer.com/product/222163?Printing=Normal`; each found by its computed
  accessible name; a press opened the Scryfall address in a new tab with no opener, and the
  app's own tab did not move. **Over the fake the phone's Copy and *Connect Patreon* are
  no-ops, and were not driven there**: that build picks the desktop's host, whose two plugin
  commands the fake accepts and does nothing with — a `Copied.` over it is the press accepted,
  not text on a clipboard. The copy and the link above are the web build's, over the engine.
- **The smoke run passed on the merged tree** (`npm run web:smoke`), with no request to a
  host without a fixture. The manifest and the icons are requests to the app's own origin,
  which that run lets through — and which it does not ask for: nothing in CI opens the
  manifest in a browser.

**Measured, 2026-10-04: what Chrome delivers for the light edition's chords.** The same
Chrome, over the fake, two tabs in one window, keys sent with `Input.dispatchKeyEvent`, and
each tab's `visibilityState` as the witness for a tab switch.

- **`Ctrl+1` to `Ctrl+9` reach the page first**, every one a trusted `keydown`.
- **Where the page prevents the default, the tab switcher does not run**: `Ctrl+4` moved the
  app to `/decks` and its tab stayed visible. On the desktop face the light edition takes 2,
  4, 5, 6 and 7.
- **Where it does not, the tab switcher runs**: `Ctrl+9` hid the app's tab and showed the last
  one, and `Ctrl+1` hid it for the first, the tab the browser opened itself with. That is 1, 3, 8 and 9 on the desktop face, and every
  digit on the phone face, which binds none.
- **`F1`** reached the page, which leaves it alone, and Chrome opened a tab of its own.
  **`Ctrl+Shift+N` never reached the page**: no `keydown` arrived and new browser targets
  appeared — the chord's private window, read from that and not seen.
- **So the guess `mobile/CLAUDE.md` carried from phase 3 is wrong for Chrome**, and it now says
  what was seen: the digits are not the tab switcher's *before* the page sees them. That the
  browser acted on these keys at all — the tab switch, the private window — is what makes the
  order Chrome's own and not an artefact of injecting past it. Nothing was built from it: the
  chords the edition leaves inert still switch tabs, and whether to take them is a decision
  for whoever owns the web host's keys.

**Not measured.**

- **A real keyboard in a window with a tab strip.** The keys were injected over the DevTools
  protocol into a headless browser. Nor Firefox, Safari, an installed standalone window —
  which has no tabs to switch — or a hardware keyboard on Android.
- **Anything on an Android device**: a copy through the WebView's clipboard, **from the phone
  face as much as from the desktop face** — no record shows either; *Connect Patreon* on the
  phone face through the opener plugin rather than `window.open`; the sheet's `_blank` rows
  reaching the navigation guard; and the window's new ground. And **`tauri android dev` served
  from a LAN address is not a secure context**, so there the page has no clipboard at all and
  a copy is refused in the seam's own sentence.
- **A copy after an `await`.** `cardMenu`'s *Copy card image* asks the engine for the address
  before it copies; a browser that ties the clipboard to a user activation may refuse that as a
  stricter one refuses `window.open` after an `await`. Chrome, with the clipboard permission
  granted to the test profile, is all that was driven, and of the desktop face's copies only
  the Export dialog's: not *Copy card image*, *Copy card name*, or `ShareFolderMenu`'s *Copy
  link*.
- **`mobile:tauri`**, where the phone face's copy now goes through the desktop's clipboard
  plugin. It takes the `app` lock and was not run.
- **Any browser but Chromium on Windows.** In particular a stricter browser's rule for
  `window.open` after an `await`, which is *Connect Patreon*'s shape and the TCGplayer press's
  on the desktop face; and a real cancelled picker, which only jsdom has been made to report.
- **A browser rationing its History API.** Every history fix above — the hold, the page paid
  before its card, the bounded Back, the adapter's late push — is held by tests in which the
  refusal is simulated, thrown and dropped. No browser was driven to its limit.
- **The picker's focus fallback, and the forty-second release, in any browser.** Both are for
  browsers that were not driven; the Chrome that was reports a cancel and reads a `Blob` at
  once.
- **An install.** No installability errors is Chrome's reading of the manifest; no prompt was
  accepted, no icon was drawn by a launcher, and no `apple-touch-icon` was added.
- **The desktop face's dialogs by pointer over a corpus**, for the reason above.

### 9.5 Step 5.5 — hosting (2026-10-04)

Where the web build is served from, and under what policy: a third Cloudflare Worker,
`app-worker/`, for `https://mtg-grimoire.app`. **This is the step's first half.** The module's
size taken up with timings, and the built app driven end to end against round one's figures,
are not in this section — they are the second half, §9.6. **Nothing is deployed** (deployed 2026-10-04, §9.7): what was committed is
source, configuration and a runbook, and [`app-worker/README.md`](../../app-worker/README.md)
is that runbook — the probes, the steps in order, rollback and cost. Numbered for its step; 5.3
was still in flight when this was written, on a tree with no service worker in it, and §9.3
arrived above it when the two met (2026-10-04). **What that meeting changed is marked where it
stands below**; every measurement here is still of the tree it names.

**What was built.**

- **`app-worker/`, Worker `mtg-grimoire-app`** — `wrangler.jsonc`, a `_headers` file, a script of
  a few lines, and a reader of that file's format. Beside the relay and the share Worker and
  never either (spec §6), for the share Worker's reason: every deploy is by hand, by one person,
  and a bad build of a page must not be a sync outage. **It shares nothing with them**: no D1, no
  R2, no KV, no Durable Object, no `vars`, no secret. Its own `tsc` program,
  `tsconfig.app-worker.json`, runs in `npm run build`.
- **Static assets, and one thing configuration could not say.** `not_found_handling:
  "single-page-application"` answers every address that matches no file with `index.html` and a
  200 — which `/decks/12` needs, and a chunk a deploy renamed must never get: a page loaded
  before the deploy would be handed HTML where it asked for JavaScript, a MIME error in place of
  the failed import the app is built to recover from (5.3). **So there is a script, and it is
  the smallest that closes that**: with `main` present and a compatibility date of 2025-04-01 or
  later, Cloudflare answers a request carrying `Sec-Fetch-Mode: navigate` with the document
  *before the script runs*, and sends every other miss to the script, where it is a `404
  text/plain` marked `nosniff` and `no-store`. A file that exists never reaches it. No
  `run_worker_first`: that would bill a Worker request for every chunk.
- **A navigation that did not say so** — `curl`, a link preview — is answered by `isNavigation`,
  the rule the dev server and the preview serve by, imported from `src/lib/core/web/assets.ts`
  so the three cannot disagree. The script asks its binding for `/` by name, which is the
  document under every setting.
- **Three trees hold no place at all**: under `/assets/`, `/wasm/` and `/mtgimg/` a miss is the
  404 whatever the caller accepts. The third is 5.3's: card pictures are asked of the app's own
  origin there and answered by the service worker, so a page that worker does not control yet
  asks the network, and the document in answer would be a broken picture with a 200 a cache has
  no reason to refuse. An `<img>`'s request is `no-cors`, never a navigation, so the edge sends
  it to the script; the tree is named so the script cannot hand it the document either.
  (**The list is `NOT_A_PLACE` in `src/lib/core/web/assets.ts` since §9.6**, read by
  `isNavigation` itself, because the three local servers were found without it.)
  `/_headers` is refused the same way: the host parses that file and does not serve it, so its
  address is a miss with no extension.
- **`app-worker/_headers`, emitted into `dist-web/` and nowhere else.** `vite.mobile.config.ts`
  gained a second `web`-mode plugin, `web:hosting`, which copies the file to the build's root —
  where `wrangler deploy` parses it — and fails the build, by line, on a file that does not
  parse. (**Three, with step 5.3's**: `web:hosting` is listed first, so its headers are on a
  preview response before any other plugin's middleware answers it — `sw.js` included — and
  `web:service-worker` last, so the build id it hashes covers the emitted `_headers`.) **In neither public directory**: the root's is copied into `dist/` and `dist-share/`,
  and `mobile/public/` into the APK's `dist-mobile/`.

  | Build, listed 2026-10-04 | `_headers` | Manifest and icons | Engine and its Worker |
  | --- | --- | --- | --- |
  | `dist/` (`npm run build`) | — | — | — |
  | `dist-mobile/` (`mobile:build`) | — | yes | — |
  | `dist-share/` (`share:build`) | — | — | — |
  | `dist-web/` (`web:build`) | at the root, byte for byte the source | yes | yes |

- **`app-worker/src/headers.ts` reads that format as Cloudflare does** — every matching rule in
  order, a header two rules both set **joined with a comma**, `! Name` to detach, one splat to a
  path, 100 rules, 2,000 characters a line — and refuses what it does not model (an absolute
  URL pattern, a placeholder) rather than skipping it. **It also refuses two things Cloudflare
  accepts in silence**, each read off its parser: a second rule for a path, of which the host
  keeps only the last (the rules are stored by path), and a rule with nothing under it, which
  the host drops. Either would be a file the preview and the host read differently. It exists so the policy is met before a
  deploy: **`npm run web:preview` sends what the built file says each address is sent**, answers
  a missing file with a bare 404 as the script does, and answers `/_headers` itself with a 404,
  as the host does. The dev server sends none of it — Vite's injected `<style>`, its inline
  preamble and its WebSocket are each what the policy forbids.

**The configuration, and the page of Cloudflare's documentation behind each key** (read
2026-10-04).

| Key | Value | Verified at |
| --- | --- | --- |
| `main` | `src/index.ts` | `workers/static-assets/` — "If no matching asset is found and a Worker script is present, the request will be processed by the Worker" |
| `compatibility_date` | `2026-08-27`, the relay's | `workers/configuration/compatibility-flags/` — `assets_navigation_prefers_asset_serving`, "Default as of 2025-04-01" |
| `routes` | `mtg-grimoire.app`, `custom_domain: true` | `workers/configuration/routing/custom-domains/` — the apex is the page's own example; the deploy creates the DNS record and the certificate, and cannot over an existing CNAME |
| `workers_dev`, `preview_urls` | `false`, `false` | `workers/versions-and-deployments/version-urls/` — "If `preview_urls` is omitted, Wrangler does not change an existing Version URL setting". Each would be a second origin: a second OPFS and a second install |
| `assets.directory` | `../dist-web` | `workers/static-assets/binding/` |
| `assets.binding` | `ASSETS` | `workers/wrangler/configuration/` — "only useful when a Worker script is set with `main`" |
| `assets.not_found_handling` | `single-page-application` | `workers/static-assets/routing/single-page-application/` — with a script, "*navigation requests* will not invoke the Worker script" |
| `observability` | enabled | as the other two |

Of `_headers`, from `workers/static-assets/headers/`: `#` begins a comment; the file "will not
itself be served as a static asset"; and it is "not applied to responses generated by your
Worker code" — so the script's 404 carries its own three headers.

**And what the documentation does not say, read off Cloudflare's own source** —
`cloudflare/workers-sdk`, `packages/workers-shared`, at `f025bbfd` (2026-10-03): the asset
worker and the router worker that `wrangler dev` runs and Cloudflare runs in front of a Worker
with assets. A reviewer read it first; each line below was then read again for this record.
**Read, not run.**

- **`_headers` is attached to every response the asset worker returns**, matched on the path of
  the request it was handed (`handleRequest` → `attachCustomHeaders`): the file, the single-page
  fallback document at `/decks/12`, the document the script fetches through its binding, and the
  `304`. That closes what the documentation leaves open about the last two.
- **The navigation split is `canFetch`'s**: `not_found_handling` is kept only for a request
  carrying `Sec-Fetch-Mode: navigate`; for any other, a miss is no asset, and the router hands
  it to the script. A list in `run_worker_first` sets `has_static_routing`, which keeps the
  fallback for *every* request — which is why the one setting that could 404 a navigation to
  `/mtgimg/…` would hand a missing chunk the document again.
- **Each matching rule applies in the file's order**, its detaches first; a header this file
  has already set is appended to, anything else replaced — so detach-then-set yields one value,
  and `no-cache` replaces Cloudflare's default rather than joining it.
- **A spent free plan answers `429 text/html` for every dispatch to the script**
  (`routeToUserWorker`, `eyeballConfig.limitedAssetsOnly`) — the no-asset path as much as a
  `run_worker_first` one. A file that exists and a browser's navigation are not behind that
  check. So on such a day a renamed chunk, a `/mtgimg/…` miss and a `curl`-style deep link are
  each Cloudflare's 429 — not the script's 404, and not the document.

**The policy.** One line in the file — wrapped here — on `/*`, and so on every static
response: the document, every chunk, the engine, `sw.js`.

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self';
style-src-attr 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'
https://api.scryfall.com https://data.scryfall.io https://cards.scryfall.io
https://json.commanderspellbook.com https://api.cardkingdom.com; manifest-src 'self';
object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'
```

- **`connect-src` is exactly the hosts the engine asks**, each from its own source:

  | Host | Where it comes from |
  | --- | --- |
  | `api.scryfall.com` | `launch.rs`, `SCRYFALL_API` |
  | `data.scryfall.io` | **not a constant** — the card sync and both Tagger feeds download whatever `jsonl_download_uri` Scryfall's descriptor names. The fence reads the descriptors transcribed into `scryfall.rs`'s and `tags/oracle.rs`'s tests |
  | `cards.scryfall.io` | `image_uri.rs`, `IMAGE_HOST` |
  | `json.commanderspellbook.com` | `combos.rs`, `FEED_URL` |
  | `api.cardkingdom.com` | `marketplace_feed.rs`, Card Kingdom's `FeedProvider` |

  **Not Mana Pool**, which sends no `Access-Control-Allow-Origin` (§9.1's table). **Not the
  relay**: sync in a browser is phase 6, which adds the host in the change that adds this origin
  to the relay's CORS allow-list; until then the request fails either way. (**Since §9.6 no
  such request is made**: the engine refuses a relay call on a page in a sentence,
  `NOT_FROM_A_BROWSER_YET`, before anything is sent — so the policy's refusal is no longer
  what a reader meets first.) (**Since step 6.1 the relay is on the list and that refusal is
  deleted — §10.1.**)
- ⚠️ **`data.scryfall.io` is pinned by this policy and by nothing in the engine.** No shipped
  line names the host; the desktop follows the descriptor anywhere. If Scryfall moves its bulk
  files, **every suite stays green** and a browser's first run fails — the page says `http
  request failed: error sending request`, seen below — while the desktop keeps working. The fix
  is one host in `_headers` and a deploy, and the third finding below is what it took for that
  deploy to reach a reader who has been before.
- **`'wasm-unsafe-eval'` and never `'unsafe-eval'`**; **`style-src 'self'`**, with the
  desktop's `style-src-attr 'unsafe-inline'` and `font-src 'self' data:`. The same components run
  in both, so each directive the two hosts share is held to the desktop's shipped policy.
  `form-action 'none'` is the desktop's too.
- **`img-src` is `'self' data:` and does not name `cards.scryfall.io`** — the second finding
  below is why, and what it asks of the service worker.
- **`Referrer-Policy: strict-origin-when-cross-origin`**: the origin, never a path. A page has
  no `User-Agent` of its own to tell Scryfall who is asking, and a shop behind an *Open on …*
  link learns the app's name and not which deck was open. `X-Content-Type-Options: nosniff`.
  **No isolation headers** — the OPFS pool needs neither, and `require-corp` would refuse every
  card picture. No `Strict-Transport-Security`: `.app` is on the browsers' preload list.
- **Caching is a default, two trees, and two files.** `no-cache` for everything — the document
  at every route, the manifest, the favicon and the manifest's `icons/*.png`, whose names carry
  no hash. A year, `immutable`, for `/assets/*` and `/wasm/*`, which are content-addressed —
  **less `assets/worker-<hash>.js`, the engine's Worker, which is `no-cache`** (the third
  finding). `/sw.js` restates `no-cache` by a rule of its own, written before the file existed
  (it does since step 5.3 — §9.3), so loosening `/*` cannot take it along. Each narrower rule detaches before it sets, or the
  two values would be joined.

**Three findings, in headless Chrome 154.0.8037.95 on Windows 11, 2026-10-04.**

- **A dedicated Worker is governed by the policy on its own script's response, not the
  page's.** Against the built app, one header changed at a time: the Worker's chunk sent
  `default-src 'none'` could not import the engine's glue; the *document's* policy stripped of
  `'wasm-unsafe-eval'` changed nothing, and the *chunk's* stripped of it failed with a
  `CompileError`; `api.scryfall.com` taken out of the document's `connect-src` alone was still
  asked by the Worker, and taken out of every response was refused each time. **A service worker
  is the same**: its `fetch` is held to the policy on `sw.js`'s response, and a `sw.js` sent with
  none is held to nothing. That is why there is one policy and it is sent with everything.
- **`img-src` is checked against the address of the response a service worker returns, as well
  as the address the page asked.** Two `localhost` origins, a page under `img-src 'self'`, and a
  service worker answering a same-origin picture with the other origin's bytes five ways:
  the fetched response passed along, an opaque one, one out of Cache Storage under the other
  origin's key, one out of Cache Storage under the page's own key — **all four blocked** — and
  `new Response(bytes)`, which was drawn. With the other origin named in `img-src`, all five
  were drawn. **So 5.3's worker rebuilds what it returns**, and the host is not in `img-src`: the
  policy is the tighter one, and a worker that ever stops rebuilding goes wrong where it can be
  seen.
- **A change of policy does not reach a Worker whose script the HTTP cache keeps** — found in
  review, from the first finding, and then measured. A Worker script whose address and bytes
  stay put while the server changes the policy sent with it, two visits in one profile:

  | The script's `Cache-Control` | On the second visit | The Worker ran under |
  | --- | --- | --- |
  | a year, `immutable` | not requested at all | **the old policy** |
  | `no-cache`, the `304` carrying the new policy | one conditional request | the new policy |
  | `no-cache`, the `304` carrying no policy | one conditional request | the old policy |

  The engine's Worker is a hashed chunk, and the first commit of `_headers` kept it for a year
  with its neighbours. A deploy that changes only `_headers` renames nothing, so "one host in
  `_headers` and a deploy" would have fixed new visitors and nobody who had been before — the
  day Scryfall moves its bulk files, and the day phase 6 adds the relay. **So that one hashed
  file has a rule of its own, `no-cache`**: a few kilobytes, a 304, and the 304 carries the
  policy (the source above). The rule is written for the name Vite gives the chunk, and the
  fence reads the line that constructs the Worker, so a renamed file is a failure there.
  **The service worker is a second cache with the same property** — it serves the shell out of
  Cache Storage with the headers it stored. Step 5.3 re-fetches the shell per build and hashes
  `_headers` into its build id; that is a property of that step, to be pinned by a test there,
  and nothing here relies on it or checks it. (**Pinned there**: `shell.test.ts`'s *moves when
  only the host's `_headers` changed* — §9.3.)

**What a browser said under the policy** — the same Chrome, over `npm run web:build` of `main`
at `92cbc02b` with this step merged in. **The module was a copy from the phase's working tree
that day, not this tree's own build**: `grimoire_web_bg.wasm` at 8 623 589 B, 3 065.86 kB
gzipped by Vite's report.

- **`npm run web:smoke` passed as it stands** (4.5 s), all nine checks. It serves the build
  with no policy. (It serves under the policy since the step's second half — §9.6.)
- **The same first run, under the policy**: a scratch copy of that script whose server sends
  what `headersFor` answers and which listens for violations on the page and, by auto-attach,
  in the Worker. All nine checks passed again — the engine compiled, the card sync asked
  `api.scryfall.com` and followed the descriptor to `data.scryfall.io`, both Tagger files and
  the combos finished, a typed search drew a tile, Settings downloaded Card Kingdom's pricelist,
  a reload kept the cards, a second tab was told. **Every host in `connect-src` was asked and
  let through.**
- **One violation, seventeen times: `img-src` refusing `http://mtgimg.localhost/…`.** `main`'s
  page still names the desktop's image protocol; 5.3 moves pictures to `/mtgimg/…`. Until then a
  card picture in a browser is refused by the policy where before it was a connection nobody
  accepted, and the tile draws its retry either way. (**True of the tree this run was made
  on.** With step 5.3 beside it the page asks `/mtgimg/…` of its own origin and the service
  worker answers with a response rebuilt from the bytes. This run has not been made again, so
  no card picture has been seen drawn under the policy.)
- **The zero for the Worker is not a vacuous one.** With `data.scryfall.io` taken out of
  `connect-src`, the same run stopped at the card sync and named the Worker's three refused
  downloads.
- **Both faces as deep links**, through `web:preview` with real hosts unresolvable: at
  360 × 800 and 1280 × 800, `/search`, `/collection`, `/decks`, `/wishlist` and `/settings` each
  reached its shell with no violation and nothing thrown.

**The fence — `app-worker/src/hosting.test.ts`.** Nothing compiles the policy and the engine
together, so a feed that moved would build green on both sides and fail in a reader's browser
with the reason in a console nobody has open. The test reads `_headers`, `wrangler.jsonc`, the
desktop's shipped CSP and the engine's Rust as text, and asks `headersFor` what each address is
sent rather than matching the file's text — two rules that each look right can join into
`no-cache, public, max-age=31536000, immutable`.

**What it holds about `connect-src`, in two halves, and what it cannot:**

- **A host that moved or left.** The engine's addresses are read by name — `SCRYFALL_API`,
  `IMAGE_HOST`, `FEED_URL` and Card Kingdom's `url()` — and the policy is held **set-equal** to
  their hosts and the bulk files', so a missing entry and an extra one are both red.
- **A host that is new** (added in review: the first version went red on a moved host and
  stayed green on a sixth feed). A census of every `https://` literal in the code the three
  crates **ship** — `grimoire-core`, `grimoire-web` and `card-scanner`'s library, each file read
  above its first column-0 `#[cfg(test)]` that gates a module, which is the crate's own rule and
  `scripts/coverage-rust.mjs`'s cut; files a parent declares behind a test gate left out;
  comment lines dropped. Each host has to be in `connect-src` or on a short list of hosts a
  browser's engine never *asks*, with the reason beside it: Mana Pool (unreachable, and refused
  before any request), the relay (until phase 6), Patreon's authorize page (an address the page
  opens, not one the engine asks), the repository's address inside the `User-Agent`, and the
  scanner's debug page. An entry on that list has to still be in the code, and may not be in
  the policy. A literal in a test module or a comment is not counted, and two controls in the
  mutation run show it.
- ⚠️ **It cannot hold an address nobody wrote.** `data.scryfall.io` arrives in Scryfall's
  descriptor; no shipped line names it, and a test says so. The fence reads it from descriptors
  transcribed into two *test* modules (`scryfall.rs`, `tags/oracle.rs`; `tags/art.rs`
  transcribes none), which pins the policy to what Scryfall sent on the day they were written.
  The same is true of any address built from parts or read from a setting.

**And beside that**: Mana Pool and the relay absent; one policy on every kind of address; the
two `unsafe` sources the policy means and no other; each shared directive no looser than the
desktop's; `img-src` as above, with the reason; the caching rule for each kind of address, the
Worker chunk's among them, with the chunk's name read from the line that constructs it; the
configuration key by key, with an exact list of keys so a `vars` block or a binding is red; and
that the directory holds no account id, nothing shaped like one, and no secret's name.

**The sweep for a `.dev.vars` could not fail until review**: a glob import skips dotfiles
unless it is `exhaustive`, so that assertion and the 32-hex sweep never saw one. It sees them
now — shown on a dotfile that is always there, and by a mutation that drops one in — with
`.wrangler/` left out by name. **The fence for a secret file is still `.gitignore`**, which
ignores `.dev.vars` and `.wrangler/` everywhere; CI's checkout never has either, so what the
test adds is on the machine that does.

**Fifty-three mutations and two controls, none wrong** (2026-10-04, after the review's fixes):
twenty-three of the policy and its caching, nine of `wrangler.jsonc`, ten of the Rust and the
page's source — a constant moved, a constant renamed, a new literal in a feed's file, in a file
the test never named and in the web host, an allow-listed address removed, the Worker's file
renamed — seven of the script, two of the reader, and two dotfiles dropped into the directory.
The controls are a new literal in a test module and one in a comment, which must stay green
and did. Each kill is recorded by the name of the
test it failed, because the first mutation run was itself vacuous: its harness read a report
from the wrong place and called every run red.

**Routing.** `app-worker/*` → `frontend` and `web`, out of the fail-safe:
[ci-and-releases.md](ci-and-releases.md) has the arm. No job deploys.

**Not run, and not built.**

- **Every probe in the runbook.** A table of `curl`s with the answer each *should* give, each
  marked not yet run: the document and its policy; **the fallback document at a deep link, with
  its headers** — the policy and `no-cache` have to be on that one too; the same link without
  `Sec-Fetch-Mode: navigate`, and with `Accept: text/html` alone; a missing chunk (**`200
  text/html` there means the script is not deployed**); the module's content type, caching and
  compression; the Worker chunk's `no-cache`, and **the `304` that must carry the policy**;
  `/sw.js`; `/_headers`; the `workers.dev` name; and an `<img>`'s request for `/mtgimg/…`, which
  must be a `no-store` 404. (**Each run on 2026-10-04, locally and then at the real address —
  §9.7.**)
- **`npx wrangler dev`, which would settle most of them before anything is public.** It runs
  the asset worker and the router locally over this configuration and this `dist-web/`, and so
  answers the navigation split, the headers on both documents, the detach, the Worker chunk's
  304, `/_headers` and the content types — in Cloudflare's code rather than this repository's
  reading of it. The runbook has it as the owner's step between building and deploying, and
  says why it matters more here than for the other two Workers: with both alternate origins
  off, the first deploy is live on the apex the moment it finishes. **Not run** — wrangler is
  not installed here and no agent may add or run it. Until it is, what stands is the source
  above, read. (**Run on 2026-10-04 as `wrangler dev --local`, which reaches nothing — §9.7.**)
- **What only a deploy can settle**, now that the rest has somewhere else to be asked: how long
  the certificate takes and whether the apex had a record in the way; what the edge compresses
  the module with, and so what a first visit downloads; that neither alternate origin answers;
  that a rollback brings a version's files back; the real hosts' own CORS answers to a page at
  this origin. (**The 2026-10-04 deploy settled each but the rollback — §9.7.**)
- **What the zone does to the page.** A Cloudflare zone has features that rewrite proxied HTML
  to add a script — Web Analytics' automatic setup (`static.cloudflareinsights.com/beacon.min.js`,
  and its *exclude EU visitors* option would hide that from an owner in Denmark), Rocket Loader,
  Email Address Obfuscation, the bot settings' JavaScript Detections (an inline script) — and
  `script-src 'self'` refuses each on every load. **Nobody here has seen the zone.** The runbook
  has a check before the first deploy: each off, and the served document equal to the built one.
  (**Read through Cloudflare's API on 2026-10-04: three off, Email Address Obfuscation on and
  idle, and the document equal — §9.7.**)
- **A spent day** — the source above, not seen: every request the script would have answered is
  Cloudflare's `429 text/html`; files and browser navigations are untouched. (This line read one
  sentence of the billing page backwards for two commits and said a miss would fall back to the
  document.)
- **A browser's navigation to a missing file or picture gets the document**, by Cloudflare's
  rule — `/assets/gone.js` typed into the address bar shows the app, and under `/assets/` it is
  sent with that tree's `immutable`, because `_headers` is matched on the address asked. Nothing
  in the app navigates to one. The setting that would close it keeps the fallback for every
  request (the source above), and was not taken.
- **`npx wrangler preview` must not be run for this Worker**: a Preview is the bundle at
  another origin. Cloudflare's pages say `preview_urls: false` withholds its `workers.dev`
  address; the review read it as not governed by that key; nobody has run it.
- **What a card picture costs before the service worker controls its page**: each `/mtgimg/…`
  that reaches the network is one Worker request, from the 100,000 a day the relay's sync
  shares. Nobody has counted a first visit. (**One has been since, at the real origin: every
  answer the page had from it was a 200, so no picture reached the script — §9.7's request
  table. One run.**)
- **The desktop face over a corpus under the policy** — the smoke's fixtures drive the phone
  face, and at 1280 an empty database draws its *No card data yet* wall — **a card picture
  drawn**, **a service worker** (built since, in step 5.3, and driven with no policy — §9.3;
  the two have not been driven together in a browser), **the real hosts** rather than
  fixtures, **any browser but one Chrome**, and any phone.
- ~~**`scripts/web-smoke.mjs` runs with no policy.** CI's `web` job therefore proves the build
  and not the build as served. What it would take: serve through `headersFor`, answer a miss
  and `/_headers` with a 404, and listen for violations in the Worker as well as on the page.~~
  **Closed in the step's second half (§9.6)**: the smoke's server answers as the host is read
  to, and a refusal by the policy in the page, the engine's Worker or the service worker fails
  the run.
- ~~**The step's second half**: the module's size with timings, and the phase's own run.~~
  **Done the same day — §9.6**, which also drove what the bullet above this pair lists as not
  seen together: the desktop face over a real corpus, card pictures drawn, the service worker
  and the real hosts, all under the policy. Still one Chrome, and still no phone.

### 9.6 Step 5.5, second half — the phase's own run (2026-10-04)

The module's size taken up with timings, and the built app driven as a reader would use it —
both faces, under the hosting policy, against the real hosts. **Nothing is deployed, and no
figure below was taken at `https://mtg-grimoire.app`** (it was deployed later that day, and
§9.7 has the figures that were taken there): each is the built app on `localhost`,
answered as §9.5 reads the host to answer, in headless Chrome 154.0.8037.95 on Windows 11
(Ryzen 9 5900X) — one browser, one machine, one day. What the run found is listed with what
became of each, and what only the owner can close is at the foot.

**The module: one line cut, four builds timed, and `opt-level` left at 3.**

- **`ocrs` is taken without its default `export-wasm` feature** (`crates/card-scanner/Cargo.toml`)
  — the dead OCR API §9.1 found and left. The module at `opt-level` 3 went from **8 684 745 B to
  6 801 761 B**, 3 030 884 B to 2 388 746 B through `gzip -9`: 1 882 984 B that nothing called.
  Natively the line compiles what it always did; the root `Cargo.toml`'s `wasm` profile and the
  core's `CLAUDE.md` have the mechanism, and the symptom to look for if it happens again.
- **Four builds of that tree, differing in the `wasm` profile's `opt-level` alone, each given
  four first runs.** The built app under the hosting's headers; a fresh profile per run; the
  runs interleaved A, B, C, D four times over between 09:26 and 09:42 UTC, total CPU reading
  12–23 % before each. **The network was loopback, on purpose**: the real hosts' own files,
  downloaded once that day, answered locally under the real hosts' headers with every other
  name unresolvable — so the four builds were handed the same bytes at the same speed, and
  what differs between rows is the engine. Medians, with the range:

  | Build | Module | `gzip -9` | Cards: download and ingest | Cards `done` | Every launch feed done |
  | --- | --- | --- | --- | --- | --- |
  | **A — `opt-level = 3`** | 6 801 761 B | 2 388 746 B | **14.03 s** (13.77–14.12) | 19.71 s (19.62–20.20) | 40.90 s (40.26–41.23) |
  | B — `"s"` | 5 535 141 B | 1 865 782 B | 16.38 s (16.15–17.60) | 22.37 s (21.85–23.62) | 44.43 s (42.75–45.27) |
  | C — `"z"` | 4 771 206 B | 1 617 653 B | 21.03 s (20.97–21.13) | 26.86 s (26.78–26.97) | 49.41 s (48.84–49.60) |
  | D — the Rust at `"s"`, SQLite's C at 3 | 6 090 581 B | 2 055 851 B | 16.38 s (16.08–16.70) | 22.20 s (21.81–22.81) | 43.45 s (42.51–44.84) |

  Every one of the sixteen runs ended on the same counts — 118 470 cards, and 4 561, 11 612
  and 111 486 in the oracle-tag, art-tag and combo statuses — with no error.
- **Each smaller build was slower where a first run spends its time.** B gives back 522 964 B
  of the compressed download and costs **+2.35 s** on the card phase; C gives back 771 093 B
  and costs +7.01 s. **D was no faster than B there** — 16.38 s both — so what `"s"` costs on
  that phase is in the Rust, not in SQLite's C, and keeping SQLite at 3 buys back nothing for
  its 190 069 B.
- **Nothing else separated the four.** The card sync's finish was 3.90 s, 4.09 s, 3.92 s and
  3.90 s; `search_cards` for `dragon` settled at 48–50 ms and the no-text wall at
  34–37 ms on each; a reload opened the database in 1.61–1.67 s; linear memory after the feeds
  was 190 251 008–204 406 784 B across all sixteen, with no build apart from the others.
- **So A ships: `opt-level = 3`.** A module is downloaded once per build and then kept by the
  service worker; the ingest is paid on every first run and again whenever the card file is
  taken anew. **A measurement of one machine**: what a phone's CPU makes of the same trade
  was not taken, and a slow link — where the smaller download would count for more — was not
  emulated.
- **The module that ships is 6 767 338 B, 2 372 783 B through `gzip -9`** — A's profile, with
  the engine changes of finding 2 below in it; built in 181.7 s, name section stripped, no
  `wasm-opt`. Why it is 34 423 B smaller was not looked into. **It was not timed again**:
  every figure in this section is the 6 801 761 B build's. Round one's module was
  2 642 182 B.

**The run, on A, against the real hosts.** The built app on `localhost:4176` under the
hosting policy; a fresh profile; started 10:39:35 UTC; the phone face at the headless
default, 764 × 485, and the desktop face at 1280 × 800. **One run**, and the machine's load
during it was not recorded.

- **The first run**, in time after navigation, beside §9.3's — one run each, hours apart,
  over a network nobody controlled, so the two columns are not like for like:

  | | This run | §9.3's run |
  | --- | --- | --- |
  | Module | 6 801 761 B | 8 684 745 B |
  | Database open | 892 ms | 796 ms |
  | Card download, 78 693 900 B | 14.48 s | 16.47 s |
  | Cards `done` — **118 470 cards searchable** | **20.88 s** | 24.48 s |
  | Oracle tags' finish | 1.43 s | 1.74 s |
  | Art tags' finish | 3.15 s | 4.11 s |
  | Combos' finish | 3.36 s | 4.10 s |
  | Every launch feed done | **43.81 s** | 50.84 s |
  | Linear memory, peak | 198 377 472 B | 205 979 648 B |

  The engine's Worker asked `api.scryfall.com` four times, `data.scryfall.io` three and
  `json.commanderspellbook.com` once; the service worker asked `cards.scryfall.io` twenty
  times. Every one was a 200 and none was blocked.
- **Zero Content-Security-Policy violations across the run's tasks** — the page, the engine's
  Worker and the service worker each listened to. The one place the policy did refuse
  something is the second finding below, which no task in the run pressed.
- **Search and facets**, nine calls each once the feeds were in, all `playableOnly`:

  | Call | Hits | First | Median of the next eight | Round one |
  | --- | --- | --- | --- | --- |
  | `search_cards`, `bolt` | 142 | 11.3 ms | 2.1 ms | — |
  | `search_cards`, `dragon` | 2 363 | 52.3 ms | 48.95 ms | median 53 ms, cold 134 ms |
  | `search_cards`, no text | 5 000 | 33.8 ms | 32.65 ms | — |
  | `facet_cards`, no text | 100 275 | 7.7 ms | 4.3 ms | 5 ms |
  | `facet_cards`, `bolt` | 142 | 2.2 ms | 1.05 ms | — |

- **Pictures.** The first wall's twenty were each asked of the app's own origin, answered 200
  by the service worker in 248–420 ms, median 402.5 ms — its own requests to Scryfall a median
  of 377 ms — and stored as `image/webp`, 1 455 750 B for the twenty. After a reload the
  database was open at 1 598 ms, the shell drawn at 1 919 ms and the tiles at 2 125 ms; each
  of the twenty pictures came from the cache in 6 ms, and Scryfall was not asked again.
- **The phone face, twelve reader tasks of twelve**: a typed search narrowed in the filters
  sheet; the card sheet with its price, 140 printings, legality, oracle tags, 118 combos and
  three *Open on …* links; an add to the collection and to the wishlist — both landed, and
  the sheet's own figures did not move, which is finding 3; a deck created;
  cards added from *Add cards*; a quantity changed and the commander set; a card added from
  the card sheet; the deck's check and bracket; the deck exported — copied, and saved as a
  file; a decklist imported from a file, its one unmatched line named; Settings' prices —
  Mana Pool greyed with its sentence, Card Kingdom's list of 151 684 rows down in 5.75 s; and
  *Clear cache*, which freed the 43 pictures and left the shell's cache alone.
- **The desktop face, nine of nine**: the rail with no caption — no drag region, no window
  buttons, no keyboard map, no *New window*; the Search wall with 25 pictures decoded; the
  card modal, its 68 printings and a step to another; *Open on Scryfall* opening a tab; a
  context menu's *Copy card name* pasted back into the search box; the deck editor's stacks,
  docked search and stats band — the add landed, under a control that named another category,
  which is finding 4; *Export deck* saving a 127-byte file; *Import* through *Choose file*;
  the collection and wishlist pages.
- **Offline, the server stopped**: the phone face reloaded with the database open at 1 541 ms
  and all twenty pictures drawn; a search, a card sheet with every section, and the deck with
  its check and bracket all answered; the desktop face opened at 1 544 ms with 25 of 25 and
  12 of 12 pictures in the wall and the editor. **With the network cut at the browser as
  well**, a picture never cached was the service worker's 502 in 6–7 ms and the frame's
  *Retrying…*, and the card behind it still had its printings and combos. ⚠️ The cut reached
  the page and the service worker only — Chrome answered *Not supported* for the dedicated
  Worker — so the engine was never asked to fetch with no network.
- **A second tab** was told at once, and the first went on answering. **The update flow, once**:
  a second build's worker waited, the bar read *A new version of MTG Grimoire is ready.*, a
  reload changed nothing, the press left one shell cache — the new build's — and 118 470
  cards, and the second tab was neither told nor reloaded. **The cleared-storage notice**: drawn
  after the browser's storage was emptied, still there after a reload, gone on *Got it* and
  gone for good; the card data came back by itself, and the decks and the collection did not.
  **The first attempt at these three stopped on the second-tab screen with no second tab
  open** — finding 1, met by the run itself — and each passed when asked again.
- **Storage.** After the phone face: OPFS 64 files, **959 348 736 B**; at the end, after the
  clearing and the rebuild, 947 716 096 B, with 10 317 486 B of shell (42 entries) and
  5 147 434 B of pictures (67) in Cache Storage. `estimate()` said `usage` 1 028 072 185 B and
  `persisted()` was `false`. The largest renderer process peaked at 634.3 MB of working set.

**What the run found, and what became of each.**

1. **A reload that landed inside a synchronous engine call stranded the reader on the
   second-tab screen** — three times in three, with no other tab open, and still there 40 s
   later. **Fixed.** The cause, measured: a dedicated Worker is ended with its document, but
   one inside a long synchronous call — the ingest's finish — keeps the pool's access handles
   until it has ended. From the reload being asked to every file being free again:

   | The old document's Worker was | All of the pool's files free |
   | --- | --- |
   | idle, or awaiting a `fetch` | by the first look, 37–42 ms |
   | inside the engine's finish | 984 ms, 2 897 ms |
   | the same, with `worker.terminate()` on `pagehide` | 1 589 ms, 1 045 ms |

   The new document asks about 140 ms after the reload, so it always lost; and `terminate()`
   on the way out asks for the ending the browser was already giving. **The fix is a Web
   Lock, `mtg-grimoire:database`, taken before any engine starts** (`src/lib/core/web/holder.ts`):
   a document's locks go with the document, which a dying Worker's handles do not. Held by
   another document, this one is a second tab and is told at once, with no Worker started.
   Free, any `already-open` it then meets is a pool still being let go: the refused Worker is
   ended and a fresh one asked after 200, 400 and then 800 ms, for at most 10 s, the gate
   reading *Opening your collection…* throughout. When the bound is spent the reader is told
   the browser has not let go of the collection yet — `STILL_HELD`, which does not say a tab
   is open. **A browser with no Web Locks retries the same and then says `ALREADY_OPEN`.**
   **A document whose database did not open ends its Worker as well as letting the lock go**
   — the review's finding, read from source and not driven: the engine installs the pool
   before it opens a database, so a living Worker whose open failed, or was refused part-way
   through the pool's handles, still holds them, and the next tab would have found the lock
   free, the pool taken, and waited out its bound on a page that could never open.
   The same reload then opened on the fifth ask, 3.0–3.3 s after the first refusal, six runs
   in six. Nine scenarios driven with the fix in:

   | Scenario | Until the app was drawn — or a second tab told |
   | --- | --- |
   | A reload inside the card sync's finish | 3 735 ms, 3 589 ms, 3 552 ms |
   | A reload with the card file's handle held | 1 137 ms |
   | A reload with a feed's file held | 941 ms |
   | A reload with the engine idle | 940 ms |
   | The tab closed inside the finish, and a new one opened | 2 037 ms, on the third ask |
   | A real second tab, the first idle | told at 108 ms |
   | A real second tab, the first busy | told at 125 ms |
   | The second tab's *Reload*, after the first had closed | 967 ms, 1 421 ms |
   | A navigation to `/decks`, then Back | 944 ms, 1 193 ms |

   **Not proved**: any browser but this Chrome; that 10 s is enough — it is three times the
   longest hold seen on one machine, not a ceiling; **a tab still running a build from before
   the lock**, which holds the pool and no lock, so a new tab would retry for 10 s and then
   say `STILL_HELD` — reasoned, not driven; "during a feed" was driven only with the
   feed's file held, never with a reload timed into a feed's own finish; and **a lock held
   elsewhere is believed on one ask** — a browser that lets a departing document's lock go
   later than the next document asks for it would tell a reload it is a second tab, which is
   this finding by another route. Not seen in Chrome; nothing rules it out elsewhere.
2. **Settings → Sync asked the relay, which the policy refuses and the relay could not have
   answered.** One press of *Pair a device* was thirteen violations in fifteen seconds
   (`entitlement.rs` has the count), each a request the browser refuses and the engine can
   only call "error sending request". **Fixed in the engine**: on a host whose requests are
   a page's, every command that would ask the relay answers one sentence before anything is
   sent — *"Syncing from a browser is not available yet. The desktop and Android apps can
   pair and sync; this browser keeps its collection here."*
   (`sync_engine::entitlement::NOT_FROM_A_BROWSER_YET`). Local reads, a rename, a cancel and
   leaving a group are untouched. And **a device with no machine name is called what it is**:
   `platform::device::kind()` answers `Browser`, `Android` or `Desktop`, where every host said
   `Desktop` and a browser's own Devices panel read "Desktop — not paired yet." Phase 6
   deletes the refusal in the change that gives the relay its CORS answers. (**Deleted in step
   6.1 — §10.1.**)
3. **The phone card sheet's *In your grimoire* figures did not move after an add** — `Owned 0`
   beside the receipt, and again when the sheet was closed and opened. Nothing on the phone
   face settled that read; and the desktop's hook, which did, watched `useIsMutating` fall to
   zero — **which does nothing for a write answered inside one task**, the count going
   0 → 1 → 0 between two renders. **Fixed**: `useHoldingsFreshness`
   (`src/features/card/useHoldingsFreshness.ts`) hears the mutation cache itself, and the
   phone face mounts it in the sheet's shell, where it is heard with no card open.
   ⚠️ **Left**: the desktop modal mounts it with the open card, so a write made while the
   modal is closed leaves the cached figure for up to 30 s on the next open.
4. **The deck editor's docked search names the wrong category on its add control** — it read
   *Add Rampant Growth to Sorcery* and the card landed in Ramp. **Found, not fixed here**:
   handed off as its own task. (**Fixed in #813**, merged 2026-10-04 at 13:17 UTC — **on
   `main` and not in production**: the build then deployed was taken from `main` one merge
   earlier, and the live deck editor still read the old wording. §9.7.) (**Deployed at 13:43
   UTC the same day, and seen**: on the live site the control read *Add Cultivate to Ramp*,
   and the card landed in Ramp — §9.7, *The final deploy*.)
5. ***Copy card image* on the web copies the picture's address as text** — the clipboard
   held `text/plain`, a `cards.scryfall.io` URL, and no image. That is what the row's code
   does on every host (`cardMenu.tsx`'s `copyCardImage` copies the address it is answered);
   a browser is where it was read back. **Noted only.**

**Beside the five.**

- **The three local servers handed the document to `/mtgimg/x`** asked for as a page — the
  dev server, the preview and the smoke's own — where the host answers a 404. `NOT_A_PLACE`
  moved out of the hosting Worker's script into `src/lib/core/web/assets.ts`, and
  `isNavigation` reads it: **the hosting Worker, `web:dev`, `web:preview` and the smoke now
  answer by one list.** The dev server needed one thing more, which the review read out of
  Vite's source: with the rewrite gone, Vite's own single-page fallback answered those
  paths with `/index.html` — at this root, the *desktop's* document — so `light:entry`
  writes the 404 itself there.
- **`web:smoke` runs under the hosting policy.** Its server sends what `dist-web/_headers`
  gives each address — parsed by `app-worker/src/headers.ts`, the reader `web:preview` serves
  by — and answers a miss with the host's 404; a `ContentSecurityPolicyIssue` in a page, in the engine's
  Worker or in the service worker fails the run, and so does a run that listened to no Worker
  or no service worker. The HTTP cache is emptied before the offline reload, because the
  policy now lets it keep `assets/` and `wasm/` for a year. **Added in this step**: a check
  that reloads while the engine is inside a synchronous call and requires the next document
  to open — finding 1, asked on every run of the smoke from now on.
- **An activity row for a download with no readable total shows the bytes so far.** A body the
  browser decompressed in transit declares the wire's length, so the engine sends `total: 0`
  for the combos and Card Kingdom's list, and the row said nothing while 677 301 270 B went
  by. No fraction and no bar still; the count is the one sign the job is moving.

**Not measured.**

- **The module that ships.** The timings and the run are the 6 801 761 B build's.
- **A second real run, or a quiet machine.** The four-build comparison had four runs each;
  the run against the real hosts was one.
- **A slow link, or a slow CPU** — the two things the `opt-level` trade turns on.
- **The engine with no network.** The cut never reached its Worker.
- **An installed PWA, a headed window, a real eviction.** As §9.3 left them.
- **The lock anywhere but Chrome 154**, and each of finding 1's *Not proved*.

**What only the owner can close.**

- ~~**The deploy itself.** `npx wrangler dev` first — Cloudflare's own asset worker and router
  over this configuration, before anything is public — and then the checks
  [`app-worker/README.md`](../../app-worker/README.md) lists for the zone: each feature that
  rewrites HTML off, and the served document equal to the built one. Every probe in that
  runbook is still marked not yet run.~~ **Closed on 2026-10-04 — §9.7**: he asked for the
  deploy in chat and an agent ran it, `wrangler dev` first, the zone read before it, and every
  probe answered at the real address afterwards. One feature that rewrites HTML was found on,
  and idle. The three below stand.
- **A run in a real phone's browser.** Every figure here is a desktop CPU's. (**Run, by the
  owner, on the live site on 2026-10-04 — one sentence, §9.7.** No phone, browser or figure was
  named, so every figure here is still a desktop CPU's.)
- **Firefox and Safari.** One Chrome, headless, on Windows is the whole of what has run the
  web host — the lock, the pool, the service worker and the policy included. (**Firefox, since:
  the owner used the live site in it on 2026-10-04 and reported one sentence — §9.7.** That it
  works and that a second tab is refused is all it says; nothing was measured there. **Safari
  stands.**)
- **Android's clipboard on a device** — never run (§9.4).

### 9.7 The deploy (2026-10-04)

**The web host is at `https://mtg-grimoire.app` since 2026-10-04, 12:47 UTC.** Markus asked for
the deploy in chat, and an agent ran it. **The rule did not change**: no agent deploys, and no
job does; his asking lifted it for this one deploy, as it had for the relay's on 2026-10-01,
and the next deploy needs its own. [`app-worker/README.md`](../../app-worker/README.md) is the
runbook this followed and now carries each answer in its tables; this section is the day's
record. **Every figure is one deploy's, one minute's or one run's**, taken from one machine in
Denmark.

**Where the day ended: production is `main`'s code, at `e1e76f78`** — version
`e9947184-6ee1-4a07-ad79-841d93196210`, the third build, deployed at 13:43:02 UTC and the first
to rename chunks (*The final deploy*, below). `main`'s head had gained only prose past that
commit. Before it, a second build went out at 13:27 UTC and was rolled back and forward again
to see a rollback work — *Three deploys*. (Until the final deploy this paragraph said
production was `4929cc6e` and not `main`: #813 had merged after that build was taken.)

**What was deployed.** `main` at `d8c3779b`, the merge of #810, from a clean tree:
`npm run web:build` over the engine `npm run web:wasm` built from the same source — engine
build id `6d63009f7fa1062b`, the module 6 767 338 B, which is §9.6's *module that ships* to the
byte. `npm run web:smoke` passed on that bundle (17.0 s).

**The runbook's step 5, run for the first time: `wrangler dev --local`** (wrangler 4.146.0,
port 8787) — Cloudflare's asset worker and router over this `wrangler.jsonc` and this
`dist-web/`, reaching nothing. Every probe that can be asked locally — all but the
`workers.dev` name and plain `http` — answered as the runbook's table says it should, the 304
with the policy on it among them, and the document served equalled the built one. So what §9.5
could only read off Cloudflare's source was run before anything was public. Three things it
answered differently from the edge, none a fault: text types carried `; charset=utf-8` where
the edge sends none; every `ETag` was another value for the same bytes; and the module's
brotli transfer was 1 986 553 B, which is not what the edge sends.

**The zone, read through Cloudflare's API before the deploy** — read-only, and nothing was
changed by it. (Two of the rows below were changed an hour later, at the owner's ask — *Two
zone settings*, further down. The table is the read.)

| Read | 2026-10-04 |
| --- | --- |
| The zone | `mtg-grimoire.app`, active, Free plan |
| DNS | **no record at all** — nothing in the apex's way |
| Rocket Loader | off |
| Bot JavaScript Detections (`enable_js`), bot fight mode | off, off |
| Web Analytics | no site on the account |
| **Email Address Obfuscation** | ⚠️ **on** — the zone's default. Idle: the built document contains no `@`. Left as found; it is the owner's setting |
| **Always Use HTTPS** | ⚠️ **off** |
| SSL mode, brotli | `full`, on |
| HSTS at the zone | none configured; `.app` is HSTS-preloaded as a TLD |
| The account's Workers | `mtg-grimoire-relay` and `mtg-grimoire-share`, and no Worker custom domain |

**The deploy.** `wrangler deploy --dry-run`, then `wrangler deploy` at 12:47 UTC. It read 48
files from `dist-web/` and uploaded 43 assets in 3.80 s — why the two differ was not looked
into — with a script of 1.09 KiB (0.61 KiB gzipped) and a startup of 1 ms; bound `env.ASSETS`;
attached `mtg-grimoire.app (custom domain)`; version
`cdee3c1c-d3ae-4246-8e8a-c50eb3025152`.

- ⚠️ **It printed no line about `_headers`.** The runbook told its reader to read how many
  rules were parsed; wrangler 4.146.0 says nothing of them. **What proves the rules were taken
  is the probes answering with each rule's `Cache-Control`** — the default, both trees, `sw.js`
  and the engine's Worker — and the runbook's step is corrected to say so.
- **The apex answered 200 with the document on the first request after the command returned.**
  The deploy made the DNS record and the certificate; no wait for either was observed, and no
  duration was measured.

**Step 0's probes against the real address, 12:48 UTC** — `curl`, each row's answer written
into the runbook's table. **The policy line was compared byte for byte with
`dist-web/_headers`' and was equal on every response that should carry it**, the 304 included.

- **Everything §9.5 read, the edge does.** The document at `/`, at a deep link asked as a
  navigation, and at one asked with `Accept: text/html` alone were one response — one `ETag`,
  `no-cache`, the policy — so `_headers` reaches the fallback and the document the script
  fetches through its binding. A deep link and a missing chunk asked as `curl` asks were the
  script's `Not found 404 text/plain; charset=utf-8`; a missing chunk asked as a navigation was
  `200 text/html`, Cloudflare's rule. `/_headers` was a 404. An `<img>`'s request under
  `/mtgimg/` was a `no-store` 404 with the script's own three headers and no policy line, and
  so was one that accepted HTML.
- **Each caching rule yields one value**: `public, max-age=31536000, immutable` on the module
  and on a hashed chunk; `no-cache` on the document, an icon, `sw.js` and the engine's Worker.
  **The Worker chunk's conditional request was a `304` with the policy on it** — the response
  §9.5's third finding turns on.
- **What the module costs to download**, 6 767 338 B before encoding:

  | Asked by | Sent as | On the wire |
  | --- | --- | --- |
  | `curl`, offering `br, gzip` | `br` | 2 139 023 B |
  | `curl`, offering gzip alone | `gzip` | 2 373 483 B |
  | Chrome 154, in the run below | **`zstd`** | **2 176 146 B** |
  | `wrangler dev --local`, offering `br, gzip` | `br` | 1 986 553 B — not the edge's |

  The edge's `ETag` turns weak, `W/"…"`, on a compressed response. **The figure for a reader
  is the browser's**, and in this Chrome that is zstd, 37 123 B more than the brotli `curl`
  was sent.
- **The edge sends `text/html` and `text/javascript` with no `charset`.** The document
  declares its own.
- **The `workers.dev` name is a 404, and `www.mtg-grimoire.app` does not resolve.** ⚠️ A
  per-version preview address was not asked; the runbook has no probe for one. (**`www` is a
  redirect to the apex since 13:48 UTC** — *Two zone settings*, below.)
- ⚠️ **Plain `http` is answered: `HTTP/1.1 200 OK`, the document, no redirect.** *Always Use
  HTTPS* is off. A browser never asks — `.app` is preloaded — but a `curl http://` is handed
  the document in the clear. Turning the setting on is the owner's. (**He asked for it, and
  since 13:48 UTC plain `http` is a `301`** — the same paragraph.)
- **The document served is the document built** — `diff` against `dist-web/index.html` printed
  nothing, for a navigation and for a plain `GET /`. That is the check no zone feature can
  pass by being off in a dashboard; it was made from Denmark and from nowhere else.

**A browser at the real origin, started 12:50 UTC.** Headless Chrome 154.0.8037.95 on Windows,
a fresh temporary profile, listening only — the page, each session of the engine's Worker and
the service worker. **One pass, one run**, three minutes after the deploy; the machine's load
was not recorded.

- **The first load.** Database open at 1 155 ms and the shell drawn at 1 484 ms, on a cold
  profile; the console said `database open in OPFS — journal delete, corpus journal delete,
  schema 59`. The service worker was activated and in control by 1 553 ms, with one shell
  cache of 42 entries. **Its precache requests were each a 200, and a file the page had just
  fetched cost it 810–848 B on the wire** — so the module was downloaded once. On the wire,
  all zstd: the document 1 568 B, the index chunk 127 060 B, the stylesheet 36 824 B, the
  engine's glue 11 242 B, the module 2 176 146 B.
- **The document in the browser was the built one, byte for byte**, with one `<script>` in the
  HTML and one in the live DOM, and none of `cloudflare-static`, `email-decode`,
  `beacon.min.js`, `__cf_email__`, `rocket-loader` or `cdn-cgi` in either.
- **The first run against the real hosts, from this origin**, in time after navigation.
  §9.6's column is the build before the engine's last change, on `localhost` two hours
  earlier — **not like for like**, and beside it only to show nothing moved by much:

  | | At `mtg-grimoire.app` | §9.6, on `localhost` |
  | --- | --- | --- |
  | Module | 6 767 338 B | 6 801 761 B |
  | Database open | 1 155 ms | 892 ms |
  | Card download and ingest | 15.06 s | 14.48 s, as *card download* |
  | The card sync's finish | 3.70 s | — |
  | Cards `done` — **118 470 cards searchable** | **21.4 s** | 20.88 s |
  | Oracle tags `done`, 4 561 tags | 24.8 s | — |
  | Art tags `done`, 11 612 tags | 36.3 s | — |
  | Combos `done`, 111 486 — the last feed | **44.1 s** | 43.81 s |
  | Linear memory, peak (sampled every 2 s) | 201 785 344 B | 198 377 472 B |

  The error log was empty.
- **Zero Content-Security-Policy violations** — on the page, in three sessions of the engine's
  Worker and in the service worker — with no request blocked or failed, no console error and
  nothing thrown while online.
- **Who asked whom, across the online session.** Every host in `connect-src` was asked and
  answered, and the app asked no other:

  | From | To | Requests |
  | --- | --- | --- |
  | The page | `mtg-grimoire.app` | 94 — 91 a 200, and 3 loads of the Worker's script, whose responses a page's session is not shown |
  | The service worker | `mtg-grimoire.app` | 42, each a 200 |
  | The engine's Worker | `mtg-grimoire.app` | 6, each a 200 |
  | The engine's Worker | `api.scryfall.com` | 4, each a 200 |
  | The engine's Worker | `data.scryfall.io` | 3, each a 200 |
  | The engine's Worker | `json.commanderspellbook.com` | 1, a 200 |
  | The engine's Worker | `api.cardkingdom.com` | 1, a 200 |
  | The service worker | `cards.scryfall.io` | 33, each a 200 |

  **This is the answer no fixture and no `localhost` could give**: each host's own CORS reply
  to a page at this origin. (The listener also recorded one request by a service worker that
  is not the app's, to an id of the shape Chrome gives an extension. Not looked into.)
- **Card pictures, drawn under the policy as the host sends it.** The phone face at 360 × 800:
  the first wall 12 of 12 decoded and a typed search 5 of 5, each 672 × 936 and each asked of
  `/mtgimg/display/…` on the app's own origin; 17 asked, 17 answered 200 by the service
  worker, and `grimoire-pictures-v1` holding 17 `image/webp` entries, 1 312 870 B. **An
  uncached picture took a median of 995 ms, at most 1 106 ms** — against 402.5 ms in §9.6's
  local run; Scryfall's share of it was not separated. The desktop face at 1280 × 800: 25 of
  25 in the wall, and Lightning Bolt's modal with 67 printing rows.
- **The card sheet and Settings.** Sol Ring's sheet had its price, *140 printings · 97 release
  dates* and *118 combos*; an add moved *Owned 0* to *Owned 1* in 440 ms with no reload, which
  is §9.6's third finding fixed and seen. Card Kingdom's list was 151 684 rows in 4.6 s; Mana
  Pool was greyed with its sentence.
- **A deep link, a reload, and a launch with no network.** `/decks` in the same profile: the
  document answered by the service worker, the database open at 1 615 ms and the shell at
  1 941 ms. A reload: 1 529 ms and 1 853 ms. **Then the same profile in a new browser that
  resolves no name**: the database open at 1 614 ms, the shell at 1 946 ms, 12 of 12 cached
  wall pictures drawn, and a picture never cached reading *Retrying…* over the service
  worker's 502.
- **Settings → Sync → *Pair a device*.** The device line read *Browser — not paired yet.*, one
  `role="alert"` carried `NOT_FROM_A_BROWSER_YET`'s sentence, and **no cross-origin request
  was made** — no violation, because nothing was asked.
- **Storage at the end.** `estimate()` said 1 036 968 697 B used of 11 774 386 937 B. OPFS held
  64 files, 959 324 160 B — the corpus 958 197 760 B and the reader's database 872 448 B. The
  shell cache was 10 284 648 B; the pictures' 33 entries, 2 476 978 B. `persisted()` was
  `false`: headless Chrome refused `persist()`. The largest renderer's working set peaked at
  631.1 MB.

**Not driven in that first pass**, and driven later the same day, below: a second tab; a launch
after storage was cleared; decks, import and export, a context menu, an *Open on …* link; the
engine asked to fetch with no network; the update flow, which needed a second deploy.

**Firefox, by the owner — one sentence.** Markus opened the live site in Firefox that day and
reported: *"it works fine. multiple tabs locks the user out until the first tab is closed."*
**That is the whole of the report** — no version, no figure, no console. It is the first run
of any of this in a second engine, and what it says of the one-tab rule is that a second tab
is refused there as designed. It does not say by which of §9.6's routes — the Web Lock or the
pool's own refusal — and it says nothing of the service worker, the policy, the update flow or
a timing in Firefox.

**The rest of a reader's tasks at the real origin.** Headless Chrome 154 again, one fresh
profile, the real hosts, on the first deploy's build. **Zero policy violations, no request
blocked or failed while online, and nothing thrown** — across 4 pages, 16 sessions of the
engine's Worker and the service worker. **The machine was busy**: total CPU read 69–75 %
through the first two items, so their timings are noisy, and 6–7 % through the cleared-storage
rebuild.

- **A second tab.** Opened while the first was in the middle of its first run, it was told at
  130 ms; with the first idle, at 87 ms. The sentence: *MTG Grimoire is already open in another
  tab of this browser. Close that tab, then reload this one.* No Worker was started and no
  engine file fetched; `navigator.locks` showed `mtg-grimoire:database` held, exclusive; the
  first tab was unaffected. With the first closed, the second's *Reload* drew the app at
  1 967 ms, opened on the first ask.
- **A reload inside the real card sync's finish** — §9.6's first finding, against the real
  download. A reload landing 278 ms into the finish: the app at 4 616 ms, *opened on attempt
  5, 4140 ms after the first*. The tab closed 255 ms into the finish and a new one opened:
  4 351 ms, attempt 5, 3 869 ms after the first. Each on the first try. **The held pool took
  longer to come free than on `localhost`** — 4.1 s and 3.9 s against 3.0–3.3 s — under about
  70 % load, and it was still the fifth ask, inside the 10 s bound.
  ⚠️ **In both, the interrupted finish left no cards, and the new document started the whole
  card download again.** That third first run then completed under the same load: cards at
  31.2 s, the combos — the last feed — at 56.4 s.
- **A launch after the browser's storage was cleared.** The OPFS folder removed by hand, with
  `localStorage` keeping its marks. The console warned *…this browser cleared the app's storage
  since the database was last opened here — a new, empty one was created*; the notice was
  drawn, through the rebuild and after a reload; *Got it* removed it for good. The rebuild ran
  by itself — cards at 20.9 s, oracle tags 25.4 s, art tags 44.7 s, combos 51.5 s — with linear
  memory peaking at 174 522 368 B. The reader's data was gone, as the notice says.
- **The phone face: every reader task worked.** The filters sheet; the card sheet's sections;
  ***Open on …* as real links, each opening a tab** — Scryfall, EDHREC, TCGplayer; adds that
  moved the sheet's figures; a deck created, *Add cards*, a quantity and the commander, an add
  from the sheet, the check and the bracket; an export, copied and saved as a 51 B file; an
  import with its one unmatched line named; Card Kingdom's 151 684 rows in 4.8 s, with Mana
  Pool greyed; and *Clear cache*, which said *Freed 3 MB across 33 files.*
- **The desktop face: every task worked.** No caption; the wall 25 of 25; the modal and a step
  through its printings; *Open on Scryfall*; a context menu's copy pasted back; the deck editor;
  an export of 127 B; an import through *Choose file*; the collection and wishlist pages.
  **The docked search's control still read *Add Rampant Growth to Sorcery*** — §9.6's fourth
  finding, as it was. Its fix, #813, is in neither build that has been deployed. (It is in
  the third — *The final deploy*, below.)
- **Offline, with the engine asked to fetch** — what §9.6's cut never reached. A browser that
  resolves no name, so the engine's Worker had no network. The app opened from the service
  worker in 1 975 ms. A Card Kingdom refresh: *Download failed. No prices yet.*, the alert
  *could not reach api.cardkingdom.com: error sending request*, and a line in the log. The
  desktop face's *Refresh data*: the ribbon back at *118,470 cards · data from 2026-10-04*,
  the alert *http request failed: error sending request*, and `bulk_check` logged.
  ⚠️ **Those are the engine's raw words, not a sentence written for a reader.** *Refresh
  combos* stopped at its confirm — it deletes first — and was not driven.
- **Installability.** `Page.getInstallabilityErrors` returned none. The manifest had no error
  and the id `https://mtg-grimoire.app/`; it is served 200 as `application/manifest+json`,
  `no-cache`, with the policy; all five icons answered 200 and decoded. **No install was
  made**: headless Chrome has no install UI.
- **At the end**: `persisted()` false, and `persist()` answering false in headless;
  `estimate()` usage 1 029 148 153 B.

**Two small things that pass found, neither chased.**

- **`/favicon.ico` answers 404.** The app's own document names an SVG icon, so a browser asks
  for the `.ico` only when it opens a document of the origin that is not the app's.
- **The phone's Errors group once read *No errors.* about 15 s after a failure was logged.**
  Seen once.

**Three deploys: the update flow and a rollback.** Markus approved it through the question
tool — a marker deploy then, and a rollback after it. #812 added two comment lines to
`app-worker/_headers`, a file the service worker hashes into its build id (§9.5); built from
`main` at `4929cc6e`, **the only files of `dist-web/` that differed from the first deploy's
were `_headers` and `sw.js`**. Below, **v1** is the first deploy — version
`cdee3c1c-d3ae-4246-8e8a-c50eb3025152`, shell cache `grimoire-shell-a893ad74a5be6b00` — and
**v2** the marker: version `f724bbc1-9853-4978-9ffe-8b3c0af6c339`,
`grimoire-shell-5ef20f18bbeecb8c`.

| UTC | Command | What the host's `sw.js` then was |
| --- | --- | --- |
| 13:27 | `wrangler deploy` of v2 — *Uploaded 1 file (42 already uploaded)* | v2's, 3 s later |
| 13:28:58 | `wrangler rollback <v1's id> -m … -y` | v2's at the first look, **v1's five seconds later** |
| 13:30:22 | `wrangler rollback <v2's id>`, to roll forward | v1's at the first two looks, 5 s apart; v2's at the third |

- **A rollback does bring a version's files back.** That was the open question §9.5 left. It
  is answered for a build that changed no schema and renamed no chunk.
- **What the command said.** Non-interactive, `-y` printed *Using fallback value in
  non-interactive context: yes*, and it warned that it *will not rollback any of the bound
  resources* — this Worker has none but its assets. **`rollback` takes any version id**, so the
  same command rolled forward. `wrangler deployments list` shows the three deployments with
  their messages.
- **Production ended that test on v2, which is `main` at `4929cc6e`.** The runbook's probes 1–11 and
  14–18, asked again of it, answered as they had of v1 — the policy equal on each response
  that should carry it, the 304 included, and the document equal to the built one. The
  module's brotli transfer was 2 139 182 B this time, 159 B more than v1's for the same bytes.

**One tab held open across all three.** Headless Chrome 154, one profile, with a reader's data
in it — a deck of two cards, a collection card, a wishlist card — and that profile's own first
run made on v1 beforehand: cards `done` at 20.5 s, every feed in at 43.2 s. Then three
handovers, v1 → v2 → v1 → v2:

| | v1 → v2 | v2 → v1 | v1 → v2 |
| --- | --- | --- | --- |
| The page open before the check | 107 s | 57 s | 51 s |
| The bar, after `registration.update()` | 654 ms | 689 ms | 648 ms |
| The install — the service worker's requests | 43, 35 129 B | 43, 35 107 B | 43, 35 072 B |
| The module among them, on the wire | 843 B | 843 B | 844 B |
| A reload while waiting — database open, shell | 1 674 ms, 2 011 ms | 1 876 ms, 2 206 ms | 1 603 ms, 1 931 ms |
| The press, to the new document | 2 590 ms | 2 596 ms | 2 664 ms |
| Database open in that document | 2 531 ms | 2 523 ms | 2 589 ms |

- **While a build waits.** The waiting worker was `installed`, both shell caches were held,
  and `host_update` answered `{ title: "A new version of MTG Grimoire is ready.", action:
  "Reload to update" }` — the bar's sentence, with its buttons *Reload to update* and *Not
  now*. **A reload changed nothing**: the old build again, the bar back, and neither the
  second-tab screen nor the still-held line of §9.6's first finding. *Not now* put the bar
  away with the worker still waiting, and the next load brought it back.
- **The press.** A new document, one shell cache — the new build's — no bar, 118 470 cards, and
  **the reader's data intact every time**: the deck and its two rows, the collection card, the
  wishlist card.
- **Nothing was downloaded again.** The install was 43 requests of about 810–845 B each — 35 KB
  — every one a 200, with no response over 50 KB; the engine's module was 843 B on the wire;
  and no other host was asked. After the press the new document's requests to the origin were
  answered by the service worker with nothing on the wire — all but the load of the Worker's
  script, whose response a page's session is not shown. **That is the engine keeping its
  address across a deploy that did not change it, seen at the host.**
- **A rollback is an update to a page that is open.** v1's `sw.js` is different bytes from
  v2's, so the bar is offered the same way in that direction. Before taking it, the open v2
  page went on working with the host back on v1 — Settings, the deck, the collection and the
  wishlist all answered.
- **Zero violations, failed requests or console errors across the session.** At its end
  `estimate()` said 1 025 483 513 B, with one shell cache, v2's, of 10 284 648 B.

**Not exercised in that session — and the first of these is the one a reader depends on.**

- ⚠️ **The app's own check for a new build.** Every check was the driver's
  `registration.update()`. Headless Chrome would not fire `visibilitychange`, and the app asks
  at most hourly; the page had been open under two minutes each time. So that a reader is
  *offered* a new build without anybody calling for it has not been seen at the real origin.
  (**Seen once since, in the owner's Firefox — below.** And the event was not what held it: in
  the final deploy's session `visibilitychange` was made to fire and the app still did not
  ask.)
- **Which cache answered a given document** — inferred from the controller, not observed.
- **A second tab standing by during a handover**, an installed app, any other browser.
- **Why the database opened at about 2.5 s in the document after a handover**, against
  1.6–1.9 s on an ordinary reload. Not looked into.

**A phone, by the owner — one sentence.** Of the live site, the same day: *"i tested on a
phone too. looks good."* **That is the whole of the report** — no phone, no browser and no
figure named. It is the first phone browser to run the web host. How long its first run took,
and what its browser said when asked for some 960 MB of storage, are not known.

**The app's own update check, seen once — in Firefox, by the owner.** With the live site open
in Firefox he wrote, at about 13:42 UTC: *"That worked i got a little toast notifying me a new
version is available"*. **That is the first sighting of the page asking by itself** — no
driver called `registration.update()` in his browser — and it is in a second engine.

- **Which build the toast offered is inferred, not reported.** His message arrived before the
  final deploy was run — that finished at 13:43:02 UTC — so the build waiting for his tab was
  the marker, v2, on the host since 13:27 and again since 13:30. Nothing his tab said is the
  source of that; the timing is.
- **Not reported**: whether he pressed it, and what the tab did afterwards.

**The final deploy: the first to rename chunks.** Asked for by the owner in chat — *"Lets go
ahead and run the last deploy"*, then *"go ahead and run the deploy"*. `wrangler deploy` at
**13:43:02 UTC**, from `main` at `e1e76f78`, the merge of #813; `npm run web:smoke` had passed
on the bundle first (15.3 s). Version `e9947184-6ee1-4a07-ad79-841d93196210` — **v3** below —
and *Uploaded 9 files (34 already uploaded)*.

- **Against v2**: seven chunks renamed — `DesktopFace`, `NoteEditor`, `PhoneApp`, `index`,
  `list`, `routes` and `web` — with `index.html` and `sw.js` changed, which is the nine. The
  engine, `6d63009f7fa1062b`, and the engine's Worker chunk kept their names and their bytes.
- **The host served v3's `sw.js` at the first look.** The document served was byte for byte
  the built one. An old chunk's name answered `404 text/plain; charset=utf-8`, and the new
  name 200.
- **All eighteen of the runbook's probes, asked of v3, answered as its table says** — the
  policy equal byte for byte on every response that carries it, the 304 included; the module
  2 138 948 B as brotli; the `workers.dev` name a 404; plain `http` still a 200, five minutes
  before the setting behind it was turned on.

**Two browsers held open across it.** Headless Chrome 154, a fresh profile each, the real
hosts; each made its own first run on v2 beforehand — cards `done` at 21.5 s and 18.9 s, every
feed in at 38.8 s and 40.7 s. One was an ordinary page, in the service worker's control; the
other was staged as a page that worker does not serve. **The two are the two shapes of §9.3's
question**, what a page meets when a deploy renames a chunk it has not loaded yet.

- **A page the service worker controls never meets the rename.** Browser 1 was on v2 at
  360 × 800 with a reader's data in it — a deck of Command Tower and Rampant Growth, a
  collection card, a wishlist card — and `DesktopFace`, `list` and `NoteEditor` not yet
  loaded. After the deploy the host answered all seven of v2's renamed chunks `404`,
  `text/plain; charset=utf-8`, `no-store`. **The page then opened the desktop face, the deck
  editor and the note editor anyway**: each of the three old chunks was answered by the
  service worker out of its own shell cache, 0 B on the wire, among 21 requests to the origin
  that it answered every one of. **That is step 5.3's promise — a page's build held whole
  while the page is open — seen at the real host.** Its docked search read *Add Cultivate to
  Sorcery*, which is v2.
- **`visibilitychange` fired, and the app did not check.** The event was made to fire three
  ways — another tab brought in front and back, the page frozen and resumed, the window
  minimised and restored. **The app asks at most hourly, and the document was 226 s old.** So
  the check was again the driver's `registration.update()`.
- **The handover, with chunks to fetch this time.** The bar 659 ms after the check; both shell
  caches held while v3 waited; a reload stayed on v2, the database open at 1 565 ms and the
  bar back; the press gave a new document in 2 655 ms, the database open at 2 569 ms, with
  `grimoire-shell-f09946cade8a42f6` alone, the reader's data intact and 118 470 cards.

  | The install's 43 requests, each a 200 | On the wire |
  | --- | --- |
  | `DesktopFace` | 250 301 B |
  | `routes` | 235 688 B |
  | `NoteEditor` | 153 487 B |
  | `index` | 127 539 B |
  | `PhoneApp` | 35 839 B |
  | `web` | 5 781 B |
  | **The engine's module — not downloaded again** | **843 B** |
  | All 43 | 839 607 B |

  The seventh renamed chunk, `list`, is about a kilobyte and is in the total. So a deploy that
  changes the page costs a returning reader the chunks that changed and nothing of the
  engine — against 35 KB for the marker, which changed none.
- **The fix, on v3.** The docked search's control read *Add Cultivate to Ramp*; pressed, and
  Cultivate landed in Ramp beside Rampant Growth. §9.6's fourth finding, closed where a reader
  is.
- **A page the service worker does not serve gets a 404, not HTML, and a sentence.** Browser 2
  was staged with `Network.setBypassServiceWorker` and the HTTP cache off, on v2 at
  `/settings`, its files fetched from the network. After the deploy the window was widened to
  1280: `GET /assets/DesktopFace-mRVVnW91.js` and `/assets/list-uE7upxBf.js` were each **`404`,
  `text/plain; charset=utf-8`, `no-store` — the script's answer, and not the document with a
  200**, which is what `app-worker/` has a script for. The console said *Failed to fetch
  dynamically imported module*. **The reader saw the app's mark, *This page could not be
  drawn.*, and one control, a *Reload* link** — `FaceBoundary`. That link drew the desktop
  face on v3 in 2 109 ms, 737 142 B from the network, with 118 470 cards and the reader's
  data intact.
- ⚠️ **What that staging is and is not.** `navigator.serviceWorker.controller` still named
  `sw.js` throughout: a page with a null controller could not be held, because the worker
  claims it. So this is a page whose requests go past the worker, not a browser with none.
  **With the bypass lifted, the next ordinary load was served v2's shell again** by the
  still-active v2 worker, with v3 waiting and the bar drawn, and the press gave v3 — a step
  back that may be the staging's own doing and nothing a reader would meet.
- **Otherwise**: no failed request but browser 2's two expected 404s, no console error but the
  failed import they caused, and no policy violation but the one below. The database again
  opened at about 2.5 s in the document after a handover against about 1.6 s on a plain
  reload. Still not looked into.

**One finding: opening the deck note editor raises two policy violations.** Pressing *New
note* on the desktop face logged two `style-src-elem` violations — an inline `<style>` element
refused by `style-src 'self'` — on v2 and on v3 alike, so the deploy did not bring it.

- **The editor still opened**, drew its toolbar and took typing. ~~What the refused styles would
  have changed was not looked at.~~ **Nothing on screen — below.**
- **The cause, read and not run.** The editor is Tiptap, whose `injectCSS` option defaults to
  true — `node_modules/@tiptap/core/dist/index.js` builds a style tag with
  `createStyleTag(style, this.options.injectNonce)` when it is — and `NoteEditor.tsx`'s
  `useEditor` does not set it.
- ⚠️ **The packaged desktop sends the same `style-src 'self'`, so it is presumably refused
  there too.** ~~**Not checked.**~~ **Checked, and it is — below.**
- **Why no earlier pass saw it: none opened the note editor.** Every "zero violations" in this
  section and in §9.5 and §9.6 stands for the surfaces that pass drew; this is the one surface
  on the live site known to break the policy.
- ~~**Found, not fixed here**: handed off as its own task.~~ **Fixed — below.**

**That finding, taken up the same day: measured on both hosts, and fixed.** The handover
asked for the packaged desktop to be checked first, and for whatever the refused sheet
carried to be put in the app's own stylesheet. The first found what was presumed; the second
found there was nothing to put. **Every measurement below is 2026-10-04, one machine, debug
or `wasm`-profile builds as named; the machine's load was not recorded.**

- **The cause.** Tiptap's editor class (`@tiptap/core` 3.31.3) appends a
  `<style data-tiptap-style>` to `<head>` as it builds a view, unless its `injectCSS` option is
  off; it is on by default and `NoteEditor.tsx` did not set it. That file's header had checked
  for exactly this on 2026-09-10 — in `prosemirror-view`, which appends nothing. The injection is
  one library up.
- **The packaged desktop app has it too — measured, where the handover could only presume.** A
  `tauri build --debug --no-bundle` binary of `main` at `ca2f1493` (which enforces the shipped
  policy; `tauri dev` has none), WebView2 154.0.4258.53, driven over CDP on a copy of the dev
  database. *New note*: one `securitypolicyviolation` (`style-src-elem`, `inline`), one console
  error, and one `<style data-tiptap-style>` in `<head>` whose `sheet` was `null`. Closing the
  dialog took the element away; *New to-do list* appended it again, for a second violation.
  **One per editor built**, because the library removes the element with its last editor.
- **Two on the web is two editors, not two sheets and not the to-do editor.** On the built web
  app under the hosting policy — `web:smoke`'s server, headless Chrome 154.0.8037.95, the phone
  face — one press appended the element twice, and the page heard two violations with one
  editor on screen. The stacks: `@tiptap/react`'s hook built an editor during render
  (`getInitialEditor`); the library's own 1 ms *never mounted* timer destroyed it 4 ms later,
  taking the element with it; and the hook's effect built a second at commit, 232 ms after the
  first (`refreshEditorInstance`). The packaged desktop window built one, on each of two opens.
  ⚠️ **Why the commit came 232 ms after the render was not looked into** — the editor is a lazy
  chunk behind `Suspense`, and that is as far as it was read. One run.
- **Nothing was missing on screen, which is why nobody had seen it — and the handover's premise
  was wrong.** It read that every shipped build had run the editor without the sheet's rules.
  `NoteEditor.tsx` imports `prosemirror-view/style/prosemirror.css`, which Vite bundles, and the
  refused sheet is those rules over again plus three things. In the packaged window *before* the
  fix the surface computed `white-space: break-spaces`, `position: relative`,
  `overflow-wrap: break-word` and ligatures `none`, and ProseMirror's console warning for a
  missing `white-space` was not printed. The three, each measured in that window:

  | In Tiptap's sheet and not ProseMirror's | What was found |
  | --- | --- |
  | `white-space: normal` on `contenteditable="false"` | A to-do list with a nested to-do has four such islands — two boxes, two delete buttons — and no whitespace-only text node in any. All 22 elements' rectangles were identical with the rule forced on them and without |
  | The gap cursor's drawing | No position in either dialect can hold one. ArrowDown and ArrowRight at the end of a note that ends in a quote made none; `NoteEditor.test.tsx` now asks the library's own rule of every position in both committed corpora, and finds none |
  | `width: 0; height: 0` on `img.ProseMirror-separator` | 0 × 0 without it |

  **So no rule was added to any stylesheet.** The gap cursor is the one to watch: a kit that
  gains a rule line, an image or a code block makes it reachable, and unstyled it is an empty
  `<div>` with the real caret hidden — the new test goes red on that day and says which rules to
  bundle. **One sentence in `NoteEditor.tsx` was wrong and is corrected**: the gap cursor is not
  how a caret gets past a quote that ends a note. Enter on the quote's empty last line is —
  driven: `<blockquote><p>quote</p></blockquote><p>out</p>`.
- **The fix is one line and three fences.** `injectCSS: false` on the app's one editor.
  `src/lib/tokens.test.ts`: every `useEditor(` and `new Editor(` outside a test sets it, the
  sweep names `NoteEditor.tsx` so it cannot pass over nothing, the library's component form is
  refused, and every file that builds an editor imports ProseMirror's sheet. `NoteEditor.test.tsx`:
  the option has one spelling in the file, and the gap-cursor sweep above with a stock kit to
  prove it can find a stop. `web:smoke`: a seventeenth check, fourteenth in order — a deck made,
  *New note*, a sentence typed, no `<style>` element on the page.
- **After, on the same two hosts.** The packaged window rebuilt from the branch, *New note* and
  *New to-do list*: no violation, no console error, no `<style>` element, and the same four
  computed values. A run of spaces typed was kept (`a  b   c `); a node selection hid the caret
  — on the surface and, by inheritance, on its children — and outlined the node
  `rgb(136, 204, 255) solid 2px`, which is ProseMirror's own light blue and not a colour of this
  app's. Noted, not changed. The web build: `web:smoke` passed all seventeen in 17.8 s, the
  module 6 767 338 B. **On the same tree with the one line taken out, the new check
  failed the run** — `style-src-elem (kInlineViolation)`, two issues — with the thirteen before
  it green, which is the run that would have caught this before the deploy.
- **Not done.** ⚠️ **The live site still raises them**: this is in no build that has been
  deployed, and the deploy is the owner's to ask for. Android carries the same policy line
  (`mobile/src-tauri/tauri.conf.json`) and the same editor, and was not run. No browser but
  Chrome 154 and WebView2 154 has been asked.

**Two zone settings, changed at the owner's ask.** In chat: *"always use https should be
**on** and we should add a redirect from www. to the plain domain"*. An agent made both
through Cloudflare's API at about 13:48 UTC. **Neither is in this repository, and no deploy of
the Worker touches either.**

- **Always Use HTTPS is on.** `curl -sI http://mtg-grimoire.app/` is a `301` with `Location:
  https://mtg-grimoire.app/`, and `http://mtg-grimoire.app/decks/12?x=1` a `301` to that path
  and query on `https`. So the runbook's probe 13 has two answers that day: the document in
  the clear at 12:48 and at 13:43, and a redirect since.
- **`www.mtg-grimoire.app` redirects to the apex** — a rule on the zone and never a second
  Custom Domain on the Worker, which is the shape the runbook already prescribed.
  - A proxied DNS record with no origin behind it, `AAAA www → 100::`, its comment saying it
    exists only so the rule runs. No Worker is attached to it.
  - One Single Redirect rule in the zone's `http_request_dynamic_redirect` entrypoint ruleset,
    which held none: when `http.host eq "www.mtg-grimoire.app"`, a `301` to
    `concat("https://mtg-grimoire.app", http.request.uri.path)`, the query string preserved.
  - The zone's certificates already covered `*.mtg-grimoire.app` — an advanced pack and a
    universal one, both active.
- **Probed after**, through Cloudflare's resolver, the local one holding a cached *no such
  name* from the 12:48 probe for a little while. `https://www.mtg-grimoire.app/` → `301` to
  `https://mtg-grimoire.app/`. `https://www…/decks/12?x=1` → `301` to the same path and query
  on the apex. `http://www…/search` → `301` straight to `https://mtg-grimoire.app/search`, one
  hop. `http://www…/decks/12` followed as a navigation → `200` at
  `https://mtg-grimoire.app/decks/12` after one redirect.
- **The apex was unchanged by either**: its document still byte for byte the built one, and
  the policy still equal on every response that carries it.
- **`www` is not an origin of the app.** A browser that follows the redirect lands on the
  apex, so there is still exactly one OPFS, one service worker and one install.
- **Email Address Obfuscation is still on**, still idle, and still the owner's. Of the zone
  table above it is the one row left as found that the policy has a stake in.

**Not proved**, as the day ended.

- ~~**A deploy that renames a chunk.** v1 and v2 differ in `_headers` and `sw.js` alone, so a
  page meeting a renamed chunk across a deploy — the case §9.3 built the held cache for — is
  still unseen at the real host. A deploy of `main` as it stands would be the first to rename
  one: #813 changed the page's code.~~ **Seen in both shapes at 13:43 UTC — *Two browsers
  held open across it*, above**: a controlled page never meets it, and a page the worker does
  not serve gets a 404 and a *Reload*.
- **A page with no controller at all.** The second shape was a bypass, with
  `navigator.serviceWorker.controller` still set. A browser with no service worker, or one
  that evicted the cache under a live page, was not staged.
- **A rollback across a schema rung, or of a build that renamed chunks.** The one made rolled
  back neither. The runbook's rule for the first is unchanged: fix forwards.
- **The app's own update check in a driven browser.** Seen once, in the owner's Firefox, by
  his sentence. Never in a browser anything was measured in: in Chrome the hourly limit held
  it every time, and no session has kept a page open for an hour.
- **A spent free-plan day.** §9.5 has what Cloudflare's source says it does; nobody has seen
  the 429.
- **Any browser's figures but one Chrome's.** The policy, the lock, the pool and the service
  worker have been *measured* in Chrome 154, headless, on Windows, and nowhere else. Firefox
  and a phone have the owner's sentence each. **Safari has not run it at all.**
- **A phone's first run** — how long it takes, what the browser answers when asked for the
  storage, whether the corpus survives there.
- **A real install.** Nothing stands in its way by Chrome's own check; none was made.
- ~~**What the note editor's refused styles cost**, on the web and on the packaged desktop.~~
  **Nothing on screen, and a console error for each editor built — measured on both, above.**
- **What a reload inside the card sync's finish costs on a slow link.** It cost the whole card
  download again both times it was seen; what that is to a reader on a slow link was not
  measured.
- ~~**A rollback.** Never exercised: this deploy was the Worker's first, so there has been no
  version to go back to, and nobody has watched one bring a version's files back.~~ **Run at
  13:28 UTC — *Three deploys*, above.**
- ~~**A deploy over a live page.** The update flow against the real host — a page open with its
  service worker in control while a second build goes out — has never been seen. §9.6 saw it
  once, on `localhost`.~~ **Seen three times, above** — for a build with no chunk renamed, and
  by the driver's check rather than the app's.
- **The zone on any other day, and the document from any other country.** A setting is the
  owner's to change; the read and the `diff` are 2026-10-04's, from Denmark.
- **Email Address Obfuscation with an address to obfuscate.** It is on, and idle only because
  the document has no `@`. Nothing in the repository keeps one out; the `diff` is what would
  say so.
- **That no per-version preview address answers.** `preview_urls` is `false` in the
  configuration, and no probe asked the host.
- **How long a certificate takes.** None was waited for.
- **The offline launch's wall.** The driver's own clock put the twelve cached pictures
  complete at 19 195 ms in that launch, beside tiles at 2 127 ms. What it waited on was not
  looked into.

## 10. Sync on a light install — phase 6, a step at a time

A light install is another device in the group: the same invite, the same six digits, one of the
membership's five slots, and the same socket (spec §7).
[The plan](../superpowers/plans/2026-10-04-light-app-phase-6.md) has the six steps it began
with and the two it grew, 6.3b and 6.5b — one pull request each.

**Decided before anything was built** (the plan's table), by Markus on 2026-10-04:

- **No polling: a light install uses the live socket, on every host.** Spec §7 gave a browser
  "none at first — pull on focus, on a timer and after a write", and issue #761 held a box for
  deciding after living with that. It was decided before any of it was built, so nothing polls
  and there is nothing to take out.
- **A browser presents its bearer in the socket's sub-protocol**, because its `WebSocket` cannot
  set a header: it offers `grimoire.live.v1` and `bearer.<token>`, and the relay verifies the
  second as it verifies the header and selects the first. The header stays for every build
  already released.
- **The agent building the phase deploys what a step needs** — the relay, then the web app —
  where every phase before this one said nobody here deploys. That is for this phase's deploys
  and nothing else; each is from `main` at a merged commit and is written down below.

**What the tree held before the phase started** (surveyed 2026-10-04, `main` at `daa70e12`):

- **The pairing UI was already on the phone face.** Step 3.7 (§7.7) drew the desktop's own
  `SyncPanel` there — pair, paste, scan, the six digits, the roster — and Android's manifest
  declares the camera. Nothing had driven it at phone width, and the phone face mounted nothing
  that hears `sync:applied`.
- **The relay answered no page**: no `OPTIONS` arm, no `Access-Control-*` header, and a socket
  that reads its bearer from a header a browser cannot set.
- **The engine refused instead of asking** — §9.6's second finding — and the hosting policy left
  the relay out of `connect-src`, with a test holding its absence.
- **The socket's connection manager was the desktop crate's** (§6.9's second open item), so the
  Android host started none and the web host had no loop of any kind.

### 10.1 Step 6.1 — the relay answers a page, and the engine asks it (2026-10-04)

Three things the code said move together, and did: the relay's CORS answers, the engine's
refusal, and the policy's `connect-src`. **Written and not deployed** (**Deployed 2026-10-04 at
17:22 UTC and verified at 23:09 — the runbook's step 0 has both columns.**) — asked at 15:49 and again
at 15:59 UTC, the deployed relay answered an `OPTIONS /token` from `https://mtg-grimoire.app`
with `405`, `Allow: POST` and no `access-control-*` line, and the live site's policy does not
name the relay. The tree is ahead of both hosts until the deploys below.

**The relay** (`relay/src/cors.ts`, `ticket.ts`, and the router around them):

- **An allow-list, `APP_ORIGINS`**, a `vars` entry shipped as `https://mtg-grimoire.app` and
  matched exactly against `Origin` — no wildcard, no suffix, and unset allows nobody. It is not
  an access control: it bounds which pages a *browser* lets ask, and weakens nothing, since no
  route trusts a cookie and each is gated by a token, a code or a secret.
- **A pre-flight is answered `204` before the rate limiter, D1, the HMAC and any Durable
  Object** — so it spends none of a caller's budget and is never the request that is billed. It
  names the route's own methods, `authorization, content-type`, and a day's `max-age`.
- **Every answer to an allowed origin carries `Access-Control-Allow-Origin` and `Vary: Origin`,
  refusals included**, because the engine acts on a refusal's status and body: a 401 with a
  membership that ended, a 403 `device_limit`, the rendezvous poll's 404 that means *not yet*.
  No header is exposed, because the client reads none.
- **A request with no `Origin` is answered byte for byte as before** — every desktop and Android
  build. `cors.test.ts` asks sixteen answers twice, with the header and without, and compares
  status, body and headers.
- **`GET /g/{group}/ws`** takes its bearer from a `bearer.<token>` sub-protocol when there is no
  `Authorization` header — for `ws` alone; a push, a pull and an ack ignore one — selects
  `grimoire.live.v1` in its 101 when that was offered, and refuses an `Origin` that is present
  and not on the list with a 403 before the gate, since CORS does not apply to a socket. The
  Durable Object answers the text frame `ping` with `pong` through `setWebSocketAutoResponse`,
  without waking: a browser cannot send the protocol ping the native client sends.

**The engine**: `entitlement::NOT_FROM_A_BROWSER_YET`, `not_from_a_page_yet` and the two `relay()`
doors that stood behind it are deleted, and `pairing::begin`, `accept`,
`commands::begin_authorize` and `ensure_group` no longer ask what kind of host they are on.
Nothing replaced it. **What the engine sends is held to what the relay allows**: eight requests,
two request headers and no response header read —
`sync_engine::client::tests::the_relay_is_asked_with_two_headers_and_no_other` reads both Rust
files and the relay's `ALLOW_HEADERS` literal, so a third header on either side alone is red.
**The test that held the refusal is turned round**:
`commands::tests::on_a_page_the_sync_commands_ask_the_relay_as_any_host_does` walks every press
a Sync panel can make, natively and then under `platform::host::emulate_page`, against a mock
answering 500, and the two walks are equal press for press — five requests and four `error_log`
rows on either host. One connection and one thread found no lock taken twice on any relay path.

**The policy**: `connect-src` names `https://mtg-grimoire-relay.denmark-east.workers.dev`, read
from `RELAY_BASE` by `hosting.test.ts`, whose absence test became a row of the allowed hosts.
`https://` only — no `wss://` source is written until step 6.3 has opened a socket in a browser.

**Found on the way**: `package.json` had lost its `web:smoke` script in `daa70e12` while CI's
`web` job and the runbooks still call it, so that job could only fail on its next run. Restored
here.

**Open after this step:**

- ~~**No browser has asked.** A mock is sent no pre-flight and asked for no
  `Access-Control-Allow-Origin`; the first request from a page is the deploy's own probe.~~
  **answered — a browser has, of the relay's own code under workerd** (§10.3): headless Chrome
  154 claimed, minted a token, paired, pushed, pulled and acked from a page, every pre-flight a
  `204` and no request failed. The *deployed* relay had still been asked by no browser holding a
  membership — until the owner's, on 2026-10-05, by his word (§10.7).
- ~~**Whether workerd carries the 101's `Sec-WebSocket-Protocol` to a browser.** The types say the
  response may carry headers and no test can open a real socket; step 6.3's local relay settles
  it before a deploy has to.~~ **answered — it does** (§10.3): both of Chrome's sockets read
  `grimoire.live.v1` off the 101 and stayed open.
- **What a browser's keepalive costs.** The auto-response is documented as costing no duration;
  the pricing page exempts only *protocol* pings from the 20:1 rule for incoming messages. Read
  as written, `ping` every 45 s is 96 Durable Object requests a day for a tab that never
  closes, against a desktop's none. The runbook's item 13 is the one-hour check after a deploy.
- ~~**A bearer in a sub-protocol is not redacted in Workers Logs**, where `authorization` is by
  its name. It is a token that lives a day at most, in the account's own three-day log;
  `invocation_logs: false` would take it out and is the owner's to choose.~~ **answered — chosen
  by the owner on 2026-10-04: accepted, and nothing is changed for it.**
- ~~**A pull's pre-flight is cached per address**, and `?since=` moves with the cursor, so most
  pulls from a browser cost one more Worker invocation — and no Durable Object request.~~
  **answered in part — counted in the relay's own log under workerd** (§10.5): 250 pushes to
  one address stood behind no pre-flight, the address having been asked about minutes before;
  seven live pulls stood behind six, and eight on a join behind five. A paged pull pays one a
  page — counted in §10.5b: 25 pages behind 25, 125 behind 125. **Two things are still not shown**: that a pre-flight reaches no Durable Object is
  the code's word (`index.ts`), which nothing local counts; and how long a browser keeps the
  answer — the relay says a day, Chromium honours two hours of it — was not waited for.

### 10.2 Step 6.2 — the live socket is the core's, and Android runs it (2026-10-04)

**The connection manager moved, whole.** `sync_engine::live` — the relay doorbell's loop: one
socket per device, five wakes, the scheduler it asks, `sync:live`, the loop's `sync:applied`,
the `error_log` note and the write wake — is `grimoire-core`'s. `live::run(state, writes)` is the
loop as a future **a host spawns** once its launch has settled; the desktop spawns it where
`live::spawn` was, and keeps one thing beside a re-export of the core's module: the bounded push
on the way out (`anything_pending`, `push_now`). Nothing the relay sees changed: the same upgrade
request, the same protocol ping, the same trips. [sync.md](sync.md), *The connection manager,
too*, has the was-and-is table.

**What it stands on**, all under `platform/`:

- **`socket`** — the one place a WebSocket is named: `connect(url, bearer)`, `Socket::next() ->
  Event::{Text, Closed(code), Failed}`, `Socket::keepalive()`, `ws_origin`. The native arm, on the
  desktop and Android, is `tokio-tungstenite` 0.28 over rustls with the roots compiled in, so a
  phone is asked for no system store; the bearer rides `Authorization`. The browser arm compiles
  and refuses every `connect`. (**It opens a real socket since step 6.3 — §10.3.**)
- **`timer::interval`**, for the 45 s ping and the 250 ms tick: a first tick at once, a late beat
  keeps the grid, a tick dropped mid-wait loses nothing. **Beats missed outright are dropped
  rather than owed**, which parts from tokio's default on purpose: tokio bursts, and after an
  hour frozen — Android does that to a background process — that is 14 400 ticks and eighty
  pings taken back to back, by an interval that passes through no timer for a beat already due
  and so never yields its thread or reads a frame until the burst is over.
- **`sync::Bell`**, the write wake: `notify_one`, so a commit that lands while the loop is in a
  trip, on a backoff or dialling is kept as one permit.
- **`spawn::on_a_worker`**, for a trip: a pool thread with a runtime of its own, as the desktop
  always ran one, and awaited where it stands on a host with one thread.
- The five wakes race in `futures_util::select!` over fused futures — as fair as the
  `tokio::select!` the fence keeps out of the core.

**A dead socket is noticed.** A socket that has answered a ping once and then leaves one
unanswered is ended within two ping periods — an ordinary failed socket, a backoff and a
reconnect — where it used to read `live` until TCP gave up, which on Android's Linux defaults is
on the order of a quarter of an hour. **A peer that never answers any ping is left to TCP, as
before**: the deadline arms only on a first pong, because of what it rests on — **measured
2026-10-04 against the step-6.1 relay under `wrangler dev --local` (wrangler 4.146.0): a raw
protocol ping (opcode 9, empty) on a hibernatable socket was answered opcode 10, empty;
production's edge has not been watched doing it.** Held from the first ping, an edge that
answered none would end every socket at its second keepalive, on every device.

**The fence names the socket's crate.** `platform::fence` swept for the word `tokio`, which reads
straight past `tokio_tungstenite`; it refuses that and `tungstenite` outside `platform/` now, and
was seen to fail on a `use` planted in `sync_engine/live.rs`. **`sync_live_state` is in the
command table**, off the desktop-only list, so a light host answers the read a page makes when it
mounts after the last `sync:live`.

**Android** (`mobile/src-tauri`): `open` registers `live::WriteWake` as the state's one write
observer, and `start` spawns the loop after `startup::settle`. `PageEvents` forwards `sync:live`
and `sync:applied`. **No push on the way out** — the process ends by `_exit` or the system's
kill, neither a hook a request can be awaited in — so the loop's 3 s write debounce pushes, and
an op that missed it goes with the next launch's first trip.

**The web host does not run it.** It registers no wake and spawns no loop, and `sync_live_state`
answers `off` there. (**It runs one since step 6.3 — §10.3.**)

**What was tested, natively**: the socket against a loopback listener — the bearer in
`Authorization`, a text frame, a protocol ping, a 4001 close with its code, a dropped
connection, a peer that answers its pings, one that answered and went silent, one that never
answers — and the loop itself: in no group, `off` once over twelve idle polls and nothing
dialled; in a group, `connecting`, `live`, a ping first, then 4001 → `offline` and a `live` row;
and on one connection and one thread (`platform::alone`), twice — with no socket and with one up
and a `head` ahead of the cursor — no lock taken twice. Twenty-seven tests are new and five moved
with the code; each new behaviour was seen to fail against a mutation. On the tree merged with
step 6.1: `grimoire-core` 3 229 passed, the desktop 427, Vitest 13 933, and the core builds and
lints clean for `wasm32-unknown-unknown`.

**Open after this step:**

- **The desktop app has not been driven against a relay since the move.** Its loop is the same
  code path by path, and the tests above are a stand-in that upgrades and cannot answer a trip.
- **No phone has run it.** Whether Android lets a backgrounded process keep the socket, and what
  the loop looks like after a freeze, are a device's to say.
- **Android was not compiled on the machine that wrote it** — no target, no NDK. CI's
  `core (aarch64-linux-android)` job is the first build; the dependency tree for that target
  resolves the socket's crate with rustls on `ring` alone.
- **Production's pong.** The runbook's item 13 has the three-minute check after the relay's next
  deploy.
- ~~**The browser's arm — step 6.3**: a page's own `WebSocket` in `platform::socket` (the bearer in
  the sub-protocol, the text `ping`, the same pong deadline from the text `pong`), the web host
  registering the wake and spawning the loop, and `wss://` in the policy's `connect-src`.~~
  **answered — built, and driven in a browser** (§10.3).

### 10.3 Step 6.3 — the browser's socket (2026-10-04)

The web app joins live sync over the same socket the desktop and Android use: no polling, and
no second loop. **Three things moved together — the socket's browser arm, the web host starting
the loop, and the policy's `wss://` source — and a fourth is how any of it is known**: a walk of
two browsers through the relay's own code.

**The socket** (`platform::socket`, browser arm). The engine Worker's own `WebSocket`, reached
through `js_sys::Reflect` off the Worker's global as `timer` reaches `setTimeout` — no `web-sys`,
for a constructor, four properties and two methods. It offers exactly two sub-protocols,
`grimoire.live.v1` and `bearer.<access token>`. Its four events feed a queue that `next()`
drains: a text frame is `Event::Text`, **except the keepalive's `pong`, which is swallowed where
it arrives** and counts as the answer to the outstanding ping; a `close` is `Closed(code)`, 4001
among them; an `error` is `Failed`. The first ending is the ending — a browser says `error` and
then `close`, and a caller is owed one. `keepalive()` sends the text frame `ping` under the
native arm's rule, word for word: a peer that has answered once and leaves a ping unanswered
fails it, one that has never answered is left alone; before concluding it gives the event loop
one turn, which is its look at what has already arrived. `Drop` clears the four handlers, closes
the socket and only then lets the closures go. **What the arm decides is a module of its own
(`heard`) that compiles for a test**, so a desktop's `cargo test` runs every rule above in eight
tests, one of which holds the two sub-protocols and the `ping`/`pong` pair to `relay/src/ticket.ts`
as text; the arm itself is the constructor, the handlers and a `send`.

**A refused upgrade is one generic sentence**, because a browser is: a 401, a 403, a host that
is not there and a policy that forbids the connection all reach a page as an `error` with
nothing in it — *the live socket could not be opened (a browser does not say why)* — which is
what `error_log` gets.

**The web host runs the loop** (`crates/grimoire-web`): `host::start` registers `live::WriteWake`
as the state's one write observer and hands back its bell; `glue::open` spawns
`host::live_sync` beside the launch's downloads once `open` has answered, for the Worker's
life. `sync:live` and `sync:applied` reach the page through `listen`, where both faces hear them
— the desktop face through `AppShell`, the phone face since step 6.4. No push on the way out: a
closing tab gives a Worker no moment to await one.

**The policy.** Measured first, in headless Chrome 154.0.8037.95, in a page and in a dedicated
Worker alike, under `connect-src 'self' https://mtg-grimoire-relay.denmark-east.workers.dev`:
`new WebSocket("wss://…")` constructs, sends nothing, and fires `error` with no `close`; the
`securitypolicyviolation` names `connect-src` and the `wss://` address, and the console says
*Connecting to 'wss://mtg-grimoire-relay.denmark-east.workers.dev/g/abc/ws?device=d1' violates
the following Content Security Policy directive: "connect-src 'self'
https://mtg-grimoire-relay.denmark-east.workers.dev". The action has been blocked.* With
`wss://<relay>` beside it the upgrade reached the relay. So `_headers` names the relay twice,
and `hosting.test.ts` derives the second from `RELAY_BASE` by `ws_origin`'s rule, reads that
rule out of `socket.rs`, and holds `connect-src` to it: every source `https://`, that one
`wss://` and no other, in no other directive.

**The walk** (`npm run web:sync-smoke`, `scripts/web-sync-smoke.mjs`, written in the first
smoke's harness — the server, the browser and the two fences, which are a module of their own
now, `scripts/web-smoke/harness.mjs`, so that neither run has to ask whether it is the script
Node started; the first cut asked, by comparing two spellings of a path, and a run that
answered *no* would have checked nothing and exited 0):

- **The relay under real workerd**: `wrangler dev --local` (4.146.0) on `relay/wrangler.jsonc`,
  `--local-protocol https`, with `--var RELAY_HMAC_KEY:<32 random bytes, drawn per run>` and
  `--var APP_ORIGINS:<the run's page origin>` and no file — the key has no value in the
  repository, this script included. Its D1 is seeded with `schema.sql`, one
  `entitlements` row and one `claim_codes` row before it starts (`d1 execute --local`), so the
  claim is the real one: the page's claim-code field, the engine, `/claim`, `/token`, the gate.
- **By the relay's real name**, so the shipped `RELAY_BASE` and the shipped `connect-src` are
  what runs: each browser is started with `--host-resolver-rules=MAP
  mtg-grimoire-relay.denmark-east.workers.dev 127.0.0.1:<port>, MAP * ~NOTFOUND, EXCLUDE
  localhost` and `--ignore-certificate-errors` (wrangler's certificate is self-signed).
  `--host-rules` beside the smoke's catch-all resolver rule answered `ERR_NAME_NOT_RESOLVED`.
- **Two profiles, two faces**: the desktop face at 1280 × 800 claims, offers and removes; the
  phone face at 412 × 915 types the code. Every step is a press on the page's own controls.

Eight runs, on the machine that wrote it (Windows 11, Chrome 154, everything on loopback),
the last three back to back and alike:

| | |
| --- | --- |
| The relay up, seeded | 3.9–4.5 s |
| The claim's press → `connecting` | 4.0–4.4 s — the loop's five-second read of `sync_group` |
| `connecting` → `live` | 90–155 ms on the claiming device (a round trip, then the upgrade), 49–63 ms on the joining one |
| A write on one device → its tile on the other, nothing pressed | **4.2–4.5 s**, both ways — the 3 s write debounce, the 1 s frame debounce and a trip; `sync:applied` arrived 20–50 ms before the tile |
| The relay's answers before the removal | 47–49 requests and **18 pre-flights**; 2 upgrades, both `101` selecting `grimoire.live.v1`; no refusal but the rendezvous poll's two not-yets |
| The keepalive | a `ping` at once on each socket and one 45 s later, each answered `pong` |
| The whole walk | 35 s; 155 s with the two idle minutes |

**One thread, one connection** (`-- --measure`: V8's sampling profiler on the engine's Worker,
a minute each). **Idle and in no group the Worker was busy 5.0–6.2 ms of the minute** — the
loop's twelve reads of `sync_group` are inside that, most of the rest is the collector. **Idle,
paired and live: 4.8–9.3 ms of the minute**, 240 ticks and two pings inside it. Not visible, and
nothing was redesigned for it. A `search_cards` issued over and over while `sync_now` ran its
round trip (37–73 ms) answered in a median 0.6 ms — what it answers alone — and at worst in
6.3–10.9 ms: a page's command waits out one stretch of a trip, never the trip.

**`web:smoke` still passes with the loop running**, and now says so: a device in no group opens
no socket — asked of the Worker's own `Network` domain, since no request interception sees an
upgrade — and makes no request to the relay, which has no fixture there.

**Found on the way:**

- **A removed device is told nothing.** The relay closes no socket on a rotation (4001 is for a
  group that is gone), so the removed device goes on reading a group of two until its next
  round trip — its own write, a *Sync now*, or the next push by a device still in the group.
  The walk presses *Sync now* there, and says so.
- **The loop asks whether the device is in a group only between sockets.** After that trip had
  cleared `sync_group`, the removed device's loop still held its socket and `sync_live_state`
  still answered `live` six seconds on. True of every host since the loop was written; not
  changed here — the loop is not this step's to restructure.
- **wrangler 4.146 on Windows turns an absolute `--persist-to` into `./C:\…`**, and its D1 then
  answers *internal error*. The run keeps its state under `relay/.wrangler/`, named relatively.
- **A `wrangler dev` stopped by force leaves its bundle in `.wrangler/tmp/`, and `eslint .`
  walked into it**: 620 errors on the first `npm run verify` after the walk, none in a file a
  person wrote. The lint ignores `**/.wrangler/` now, as git always did, and the walk removes
  what it made.
- **A run that is interrupted stops what it started** (review, the same day): Ctrl-C, an
  uncaught exception and an unhandled rejection each run the orderly stop and leave non-zero,
  and the process's own `exit` stops every child synchronously — on POSIX the relay is a
  process group of its own and the whole group is signalled. Seen on Windows, by pid: a run
  ended mid-walk by a real Ctrl-C (exit 130) and one by a throw from a timer (exit 1) each had
  36 processes — two workerd, two esbuild, 26 Chrome — and left none, and no state on disk.
  A run that is itself killed outright (`taskkill /F`, `SIGKILL`) still leaves them: no handler
  runs.
- **The desktop face's *Add to wishlist* is greyed until the card's own read answers**, and a
  press on it then is no press. The walk's first measured run pressed it early and waited a
  minute on the other device for a write that was never made; it now presses an enabled
  control and checks the write landed where it was made.

**CI**: `relay/**` and the new script route to `web`, and the job runs the walk after the first
smoke. wrangler is not a root dependency: the step installs it from `app-worker/`'s own
lockfile (step 6.6's, `npm ci --ignore-scripts --prefix app-worker`), which is also where the
script looks first. **It has run on one Windows machine and on no runner**: its first run there
is this step's own pull request.

**Open after this step:**

- ~~**Production.** A real browser against the deployed relay needs a real membership — the
  owner's — and the web app's deploy, which carries the `wss://` source and the new engine
  together. Until then the live site's engine opens no socket.~~ **answered — by the owner's
  word** (§10.7): on 2026-10-05 he paired the deployed web app with a desktop and synced
  between them. Nobody read the socket itself there.
- **Safari and Firefox.** Each opens a socket with sub-protocols and applies `connect-src` to
  it; neither has been driven, and neither has run any browser arm of the engine.
- **What a keepalive is billed.** The local relay answers `ping` with `pong`; whether the
  dashboard counts each as a request is the runbook's one-hour check, still not run.
- **A phone's browser freezing the Worker.** `timer::interval` drops the beats a frozen Worker
  missed and the pong rule ends a socket that died meanwhile, by reasoning; no backgrounded tab
  has been watched coming back.
- ~~**The removed device's stale socket**, above: a relay that closed a departed device's socket,
  or a loop that asked about its group while connected, would each end it. Neither is built.~~
  **answered — both are built, in step 6.3b (§10.3b)**: the loop lets go of a socket whose
  group its device is no longer in, and a rotation's roster closes the sockets of the devices it
  leaves out. The relay's half was deployed on 2026-10-05 (§10.7).
- ~~**The sync smoke on a runner**: Linux, wrangler installed without its lifecycle scripts, a
  runner's clock under every wait. The pull request's own `web` job is the first.~~ **answered —
  it ran green there**: pull request #823's `web` job, on `ubuntu-24.04`, merged 2026-10-04.

### 10.3b Step 6.3b — a device that left lets go of its socket (2026-10-04)

Step 6.3's walk found two things wrong that were not the browser's, and review found the second
worse than it looked. **A socket is its group's** — the relay's object is addressed by the group
id — **and the loop asked which group its device was in only between sockets.** So a device that
pressed *Leave group* kept its socket and read `live`; one that left and then joined another
group listened to the group it had **left**, for up to the socket's twelve hours, while the group
it was in rang on nobody; and one that was removed was told nothing by the relay, and kept the
socket even after the trip on which it learned. Every host, the desktop included, since the
socket was built. Fixed as one thing, on both sides.

**The loop** (`sync_engine::live`, every consequence in `schedule.rs`):

- **It looks at its group on the commit that could have changed it** — the write wake, ahead of
  the outbox's question — and on every keepalive beat. A device in no group, or in another, ends
  the socket as `Disconnect::Left`: no backoff, no row, the attempt counter untouched; the loop
  then says `off`, or dials for the group it is in now.
- **The look is on the write connection, and two tests hold why**: with a commit hook held open
  mid-commit, the read connection still answered the group being deleted — the look that would
  have kept the socket — while a look on the write connection waited for the writer and
  answered none; and **the loop itself**, rung by the real hook and driven with that commit
  held, says `off` on the one ring its departure gave (asked of the read connection it never
  does). The first runs on two connections and on one — and its one-connection arm is a second
  native thread waiting on a mutex, which is the mutex's order and not a browser: on wasm the
  look runs between two turns of the event loop, and a connection found taken answers "unknown"
  at once, which keeps the socket until the next commit or ping.
- **Both of the write wake's questions — which group, anything to push — are one taking of the
  write connection**, where two made a batch ingest stand aside twice per commit.
- **The relay's close for a removal is 4002, and it is read behind the sync lane**, because a
  device's own departure is a manifest without it and the relay now closes its socket for
  that: asked at once it is a removal — `offline`, a row — over something the reader just
  chose. The press holds the lane to its last write, so behind it the group is gone and the
  close is quiet.
- **4001 is left to mean what it always has — a dropped group, a membership ended — and is now
  never a row.** The step's first commit closed removed devices with 4001 too, and review
  found two wrong rows in that: a *released* desktop reads 4001 as "the group no longer
  exists", so its own *Leave group* would have logged one once this relay deployed; and at a
  lapse the close arrives while the device is still in its group with a stored `active`, so the
  loop — asking its database, which knows nothing yet — wrote a row for a lapse, one per
  connected device. Now: 4002 → the removal path; 4001 → back off, write nothing, conclude
  nothing, and let the trip behind the backoff speak. Tested on a device that pressed Connect
  and on one that only paired.
- **No group is not a failed dial.** A removed device clears its group on the trip in front of
  its reconnect; reaching the dial with none is `Left`, where it was a second backoff and a
  second row.
- **A dial has a deadline** — twenty seconds, the relay's other clients' connect and read bounds
  added. A relay that took the connection and never answered held the loop at `connecting`, with
  no trip, for as long as the stack allowed; a browser allows minutes. **It takes one last turn
  before it gives up**: in a browser the deadline and the socket's `open` are both queued
  tasks, and behind a stretch that holds the thread past twenty seconds — this section's own
  relaunch held it ten, and nineteen once, at 30 000 cards; a real first ingest is ~117 000 —
  both are waiting when the thread comes back. Deadline first, and an opened socket was dropped
  with a row saying the relay never answered. So at the deadline the dial yields once to the
  host and polls the connect once more (`timer::timeout_after_a_last_turn`). Tested natively,
  on a runtime whose order is known; **a browser's task order is not specified**, and no
  browser run has staged it.

**The relay** (`relay/src/group.ts`, `log.ts`; **not deployed** when this was written —
**deployed 2026-10-05 at 02:21:29 UTC**, §10.7): a rotation's roster closes,
with **4002**, every open socket whose device the adopted manifest does not name, and marks a
device it knows only by its socket departed with the rest; it compacts first, and a close that
throws costs nothing else. `drop` still closes a whole group with 4001. The client's next act
after a 4002 is the round trip on which it finds itself off the manifest, so it cannot spin:
removed → 4002 → one backoff → the trip → no group → `off`. `notifyTargets` is unchanged — a device a roster took
out holds no socket to tell. No upgrade is refused on the `departed` mark: a lost roster post
would then leave a re-paired device with no doorbell.

**What the loop records.** A lapse is the one background failure kept out of `error_log`, and the
loop asked `entitlement::membership_ended` for it — alone, which is also true of every healthy
device that joined by pairing: no refresh secret, and the `active` the group door answered. Such
a device recorded nothing: found here as a removed browser whose log stayed empty. It asks
behind `commands::entitled` now, as that function's doc said and the Settings panel does. Tests
on both kinds of device: a failed background trip and a fallen socket are each a row; a lapse —
the relay's 401 on a sync route — is none, and neither is what follows it.

**How a lapse is said in production, as far as the source says.** A device with no refresh
secret learns of one from the group door's 401 carrying `membership_ended`. The relay deployed
on 2026-10-04 is `main` at `ea0aa88e`; `relay/src/claim.ts` there defines that code and stamps
it on that 401, and nothing under `relay/src` changed between that commit and this step's base.
So the code is there to be answered. **Production itself has not been asked with a lapsed
membership** — nobody has let one lapse to see.

**A joiner's first trip met the join's rotation — found by the walk, three runs in twenty-one,
and not asked for by this step.** The device that confirms a pairing seals the key at the
group's epoch and publishes the join's rotation a moment later; the joiner's page runs a trip
the moment it holds the key (20 ms after, here). A trip opens with `/keys` and then asks the
group door for a token — two requests, and the rotation landed between them: the check answered
the epoch the joiner held, the door was asked with that epoch's auth, and the relay, one
rotation on, refused it. `POST /token 401`, the trip failed, and the device waited for its next
one. It has always been there on every host; the old walk's timing never met it. **A trip now
takes that refusal to `/keys`, as a push takes a `stale_epoch`** (`client::
token_across_a_rotation`): a rotation adopted there is the reason and the door is asked again
under the new key; a removal ends the trip quietly; a relay still on this device's epoch is a
refusal that stands. One retry. The relay's 401 is right and still happens — the walk allows
it in exactly that shape, once, and says so when it does.

**What a desktop does differently:**

1. It lets go of its socket the moment it leaves its group, is removed, or changes group, and
   reads `off` — where it read `live` until the socket ended.
2. Joined to another group, its socket is that group's within five seconds, not twelve hours.
3. Removed, once a relay that sends 4002 tells it: `offline` for one backoff, then `off`, and
   one row — *the relay says this device is no longer in its sync group*. **And a 4001 — a
   dropped group — writes no row**, where it wrote *…this device's sync group no longer
   exists*: `offline` for a backoff, and the trip behind it speaks. That one is live against
   the relay deployed today.
4. A dial the relay never answers fails after twenty seconds.
5. **A desktop that joined by pairing starts showing background relay failures in its Errors
   panel**, which it was silently dropping — folded on the message, as on every other device.
6. Each commit on its write connection costs the loop one more read, of `sync_group` — in the
   same taking of the connection as the outbox's, so no more waiting than before.
7. A round trip whose token is refused because a rotation landed behind its key check adopts
   the rotation and asks once more, where it failed and waited for the next trip.

**The walk, extended** (`npm run web:sync-smoke`; three more steps, 41–54 s for the whole of it
over some thirty runs on a machine other work was loading, and up to 72 s at its worst):

| | |
| --- | --- |
| The phone face founds a group of its own, goes `live`, and presses *Leave group* | `off` **72–134 ms** after the press; never `offline`; its socket closed; nothing logged |
| It then joins the desktop face's group | its socket is that group's address, not the one it left's — the regression test: with the old loop the second doorbell below never rings |
| It relaunches, paired, into a first ingest of 30 000 cards | below |
| The desktop face removes it from the roster | in no group **2.2–4.2 s** after the press (the backoff's two to four seconds, and a trip), **with nothing pressed on it**: it said `offline`, `connecting`, `off`, its socket closed, and its log holds one row, the removal's sentence — on a device that joined by pairing, which logged nothing before this step. (Step 6.3 pressed *Sync now* here, and said so.) |

**A paired browser's relaunch — the one thing nothing covered.** A paired device's launch is two
things on the engine's one connection and one thread: the launch's downloads, and the loop's
first act — a round trip, then the socket. No earlier run put them together: a first run is in
no group, and a relaunch inside a day downloads nothing. So the phone face pairs with its card
file *held* — in a group, with no card — and is then reloaded with the file let go. **It does
not deadlock and does not panic.** Every run alike, the quiet ones first and a loaded machine's
in brackets:

- the loop's launch trip asked the relay **3.2–3.7 s** after the reload, as the database
  opened, and got as far as its pull (read off the device's own requests: the relay's log
  cannot tell its `/keys` from the other device's);
- then it was **deaf for as long as the ingest held the thread**: no ack and no dial until the
  ingest's synchronous tail ended. The longest any read of the engine waited was **4.6–5.8 s**
  (to 10 s, and 19 s once);
- the socket was upgraded at **9.0–10.4 s** (to 15 s, and 26 s once), `live` was read some
  30–300 ms later, and the ingest was done within 60 ms of that;
- a wish made on the other device meanwhile was on its wishlist about 70 ms after that. Nothing
  was lost: the launch trip's own pull and the reconnect's trip take whatever was missed.
- No console error, no `error_log` row, no policy refusal.

That silence is the ingest's shape, not the loop's — §9's figures for a page's own commands
during an ingest are the same wait — and on a real first run of ~117 000 cards it will be
longer in proportion.

**Open after this step:**

- ~~**The relay's half is not deployed.** Until it is, a removed device learns at its own next
  round trip, as before — and then lets go of its socket, which is new. The runbook's ninth half
  has what each side does with the other's old build, and the one look that says it is live.~~
  **answered — deployed 2026-10-05 at 02:21:29 UTC, and the client that reads 4002 in the web
  app eight minutes later** (§10.7). The one look has not been taken: nobody has watched the
  deployed relay tell a removed device.
- **A released desktop against the new relay** reads the 4002 its own *Leave group* earns as a
  plain close: a second or two of `offline`, then `off`, and a row (*the relay closed the
  socket*) only if its socket was under a minute old. Read off the released loop's code
  (v0.40.0, `daa70e12`), not driven; the runbook's table has every cell.
- **The dial's last turn in a browser**: no run has staged a deadline and an `open` queued
  together, and the dial itself has no test of its own for it — the timer it calls has.
- **A Sync panel left open on a removed device keeps its old roster** until its own query is
  read again: the engine says `off` on `sync:live`, and nothing on the page re-reads the pairing
  for that.
- **No desktop has been driven through any of it**: the loop's tests are native and its walk is
  two browsers.
- **The relaunch on a real corpus, and on a phone's browser.**

### 10.4 Step 6.4 — pairing on the phone face (2026-10-04)

The phone face has drawn the desktop's own `SyncPanel` since step 3.7, and nothing had driven it
at a phone's width. **Driven now, and what was wrong is fixed in the shared components** — in
headless Chrome 154 under a touch pointer (so `pointer: coarse` matches), dark scheme, at 360×800,
412×915, 800×600 (the side-rail width) and 800×360, over the Storybook fake, state by state: idle,
the offer, the six digits on both sides, a typed and a pasted code, the scanner, a roster of five
long names, Rename, both confirm dialogs, the claim-code row, each alert and the four socket
states. **Nothing here asked the relay**: the fake has none.

**A sync that applied refreshes the face.** `useDeviceSyncInvalidation` was `AppShell`'s alone —
the desktop face of the light app is that shell, so it had it — and the phone face mounted nothing
that hears `sync:applied`. It is mounted in `useCardDataWatch`, once for the face, handed the
face's own query client; `cardData.test.tsx` clears the fake's wishlist behind a wall with Settings
closed and watches the tile leave on the event, and stay for a trip that only pushed. Red without
the mount.

**What was measured** (before → after; nothing scrolled sideways in any state, before or after):

| Viewport, state | Before | After |
| --- | --- | --- |
| 360, the offer's QR code | 288×288 in a step 268px wide inside: 20px through its frame | 268×268, inside, 4.26px a module for the 53-module invite, white on the dark theme |
| 412, the typed code | 20px wide and 1 228px tall beside the picture: two characters a line | 320×58, on the line under it |
| every button on the panel | 34px tall; the roster's Rename and Remove 28 | 44 |
| text boxes | 12–14px type, 32px tall | 16px type, 44px; a code box 144px, the whole code on screen |
| 360, a roster name | 105px beside its two presses, about eleven capitals | the whole row; the presses wrap under a long name, together |
| 800×360, the viewfinder | 256×256 in the 258px left under the pinned row | 180×180, its sentence on screen |

The two dialogs were already over the window and not in the list: a fixed scrim at 0,0 the size of
the viewport, hit at the top, bottom and left edge. The socket's line draws for `offline` alone
and fits at every width. **The desktop is unmoved**: the desktop face over the same fake at
1280×800 and 1024×768, every visible box of the Sync, Local cache and Clear data panels and their
dialogs recorded before and after — identical in 28 of 30 captures, and the two that differ are
the refused camera, whose sentence is a line longer on every host.

**The touch floor is Settings' own.** `PANEL_BUTTON` is `BUTTON` plus a 44px least height under a
coarse pointer, and every panel in `src/features/settings/` draws its buttons from it; a text box
adds `TOUCH_FIELD`, 16px, below which a phone zooms the page on focus. `BUTTON` itself is
unchanged, because the share menu, the two share dialogs and the public share viewer import it and
none was measured under a finger. `controls.test.ts` pins each utility in its constant and
compiles it against `src/index.css`; the panel's and the dialog's suites pin them on the rendered
boxes.

**The scanner, with a camera** — `npm run mobile:scan-smoke` (`scripts/pairing-scan-smoke.mjs`),
against `mobile:dev`. A headless Chromium launched with
`--headless=new --remote-debugging-port=0 --user-data-dir=<temp> --use-fake-device-for-media-stream
--use-fake-ui-for-media-stream --use-file-for-fake-video-capture=<invite.y4m>` takes a file for a
camera, and the file is a screenshot of the panel's own QR code at 360px, centred on a 640×480
frame. `jsQR` reads that drawing before any camera sees it (162 bytes, the relay's `/pair#` URL);
the scanner's `getUserMedia` → `<video>` → canvas → `jsQR` loop then decodes it and calls
`sync_pairing_accept` once with exactly that text, about 130 ms after the press, and the six
digits follow. With `--deny-permission-prompts` and no fake device the same press lands on
*MTG Grimoire needs camera access to scan a code. Allow the camera and try again, or type the code
instead.* over a box to type into, and the typed code gives the same digits. **For that the fake
grew a real QR encoder** (`.storybook/fake/qr.ts`: version 9 at level M, read back by `jsQR`),
where it drew a 21×21 picture; its `sync_pairing_accept` takes the URL a QR carries, as
`Invite::decode` does; and its copy of `RELAY_BASE` is held to `entitlement.rs`.

**The camera's grant was read, not seen.** On Android, wry 0.55.1's
`RustWebChromeClient.onPermissionRequest` asks for the `CAMERA` runtime permission when the page
asks for video, and grants or denies the page's request by the answer; the manifest already
declares the permission and an optional camera, and nothing was added. On the web app, a page
served with exactly the headers `app-worker/_headers` sends for `/` — `main`'s, with the relay in
`connect-src` — ran the scanner's chain against the fake camera and decoded the invite: no
`Permissions-Policy` is sent, `srcObject` is not a fetch, and `jsQR` needs no `eval` (the probe's
own `eval` was the one violation, refused).

**Clearing site data** (spec §7). No press in the app deletes a device's identity: `reset.rs`
names the collection, the wishlist, the decks and the picture cache, and nothing of
`sync_identity` or `sync_group`; *Leave group* is the one press that touches the group, and it is
the cure. The browser's own *clear site data* does, and the app then opens as a new device while
the old entry still counts toward the group's five. So there is no dialog for the sentence, and
it stands under the roster instead: the Sync panel asks the host `storage_group_warning` and draws
the answer while the device is in a group. The web host alone answers, with its own sentence
(`web/storage.ts`, beside the cleared notice's lines); the desktop and the Android host refuse the
name, silently. The panel never learns what kind of host it is on. The storage notice gained a
fourth paragraph, an *if* — the page cannot know it was paired once the database is gone — saying
where the old entry is removed.

**Open after this step:**

- **No grant prompt has been seen on a phone**: Android's runtime prompt, first use and after a
  refusal; a browser's on the installed web app; iOS Safari at all.
- **No real lens has read the code off a real screen**, and the decode loop — `jsQR` over the
  camera's whole frame, every animation frame — has not been timed on a phone.
- ~~**A browser pairing end to end against the deployed relay.** The relay half was deployed on
  2026-10-04 at 17:22 UTC and `connect-src` names it on `main`; what it waits on now is the web
  app's deploy and step 6.3.~~ **answered — by the owner's word** (§10.7): he paired the
  deployed web app with a desktop on 2026-10-05. Which face he paired on is not recorded.
- **Whether 16px type stops the zoom on the owner's browsers**, and the on-screen keyboard over
  the code box and the typed word's box.
- **A browser that really clears its site data**: whether `localStorage` outlives OPFS there is
  the limit `web/storage.ts` states for the whole notice, and it decides whether the fourth
  paragraph is ever read.
- **The four importers of `BUTTON` outside Settings under a finger.**
- **Android's system *Clear storage* has the same effect and says nothing**: the Android host
  answers no `storage_group_warning` yet.
- **The scan smoke runs nowhere but by hand**: no CI job starts `mobile:dev` for it.

### 10.5 Step 6.5 — an unpaged pull in a Worker, measured (2026-10-04)

Spec §7 left one question to the phase that drives browser sync: `pull` answers everything after
a device's cursor in **one response**, and in a browser the engine that reads it is one thread
with one linear memory. **Measured, and nothing is changed by this step**: the measurement is a
script, the engine and the relay are as they were, and what the figures ask for is a relay
deploy, so it is written down below as a design and not built.

**The run** — `npm run web:sync-pull -- --ops <n>` (`scripts/web-sync-pull.mjs`), a sibling of
the sync smoke on its harness: the relay's own code under workerd (`wrangler dev --local`
4.146.0, workerd 1.20261001.1), two headless Chrome 154.0.8037.95 profiles on Windows 11 (Ryzen
9 5900X, 32 GB), everything on loopback, the built app under the hosting's headers, the engine
at 6 836 569 B. A sibling and not a mode of the walk, because it shares the walk's relay,
devices, claim and pairing and none of its shape; those four are a module of their own now,
`scripts/web-smoke/sync-harness.mjs`, beside the harness both smokes are written in, and the
walk reads as it did. Nothing runs the measurement but a person; it fails by name when the two
devices do not end up with the same rows — **row for row**: each device's whole list read
through `collection_list`, each row reduced to what an import line set, the lines sorted, and
the SHA-256 of both compared. (The first record of this step compared a count and a sum of
copies and called it the rows; every run in the relay-heap rows below, and every run since,
compares the digest.) `release-rule.test.mjs` counts wrangler's subcommands across the files
of the run — `d1 execute --local` and `dev --local`, both in the harness — holds each file to
its relative imports by name, so the list is the whole of the run, pins the one PowerShell
pipeline the measurement starts to the three cmdlets it is, and holds all of them to none of
the words that reach Cloudflare.

- **The log is made by the app's own commands.** Each device's first run ingests the smoke's six
  cards grown to as many as thirty thousand printings. The importing device — the desktop face —
  is then asked `collection_import_commit`, the import dialog's own command, with `n` lines that
  each name a printing, finish and condition no other line names, so each is a row and an op of
  its own, fifty thousand lines to a call. The capture triggers, the 3 s write debounce,
  `client::push`, the sealing and the batching are the engine's. A line carries a quantity, a
  condition, a price, a currency, a date and a source, and seals to **about 890 B of response
  per op** — nearer `sync.md`'s fat op than its 453 B average.
- **Each device is loaded again after its first run, and measured then**: the ingest leaves
  linear memory at its own high-water mark (219 MB for ten thousand printings, 555 MB for
  thirty thousand, which is this fixture's and not a real corpus's), and a pull measured in that
  Worker read as costing nothing. After a reload it stands at 8–21 MB.
- **The pulling device — the phone face, on its Collection page — is left behind by holding its
  requests to the relay** where the harness pauses every request: its socket rings, its loop
  starts a trip, and the trip's first request waits as one on a stalled link would. Letting it
  through is the pull.
- **What is read**: `WebAssembly.Memory`'s byte length off the Worker's live instance over its
  DevTools session (`Runtime.queryObjects`); `Runtime.getHeapUsage` there five times a second
  — **answered on the Worker's own thread, so no sample lands inside a synchronous stretch**:
  that row is the heap either side of the apply, never its peak, and no DevTools domain reads
  it from outside; the tab's process and workerd's from the system's process table; the
  Worker's own `Network` events for each request, and the relay's own log for the pre-flights;
  and `search_cards` asked from the page every 100 ms, each timed to its answer.
- **The relay isolate's heap is read by request, not by run.** `Runtime.getHeapUsage` over
  wrangler's inspector, fifty times a second, each sample kept with its time; the heap
  collected (`HeapProfiler.collectGarbage`) before the pushes, before the measured pull and
  again before the ack that follows it; and a request's cost read as the used heap just before
  it was sent against the highest sample by a quarter-second after its last byte. **The first
  record of this step printed the whole run's peak as the pull's** — the pushes, the importing
  device's own pull, every ack's compaction and the measured pull, with whatever garbage lay
  between them — and that figure, 143–157 MB at 50 000 ops, said more than the pull costs.
- **The runs**: three to five a size for the pull left behind, two a size for the live and
  join cases, and one each for the quota, the claimed join and the slow link — between 21:57
  and 22:40 local, total CPU reading 2–40 % before each, other agents' work being on the
  machine. Ranges are every one of those runs'. **Three more, taken at 22:47–22:55 with the CPU
  at 76–100 %, are kept out of the ranges**: the same applies took 1.6 s, 6.2 s and 48.3 s —
  1.2 to 3.5 times as long — and linear memory came out the same to the megabyte. **And the
  re-runs for the relay's heap, 00:00–00:20 on the 5th with the CPU at 32–100 %, give no time
  to any table here** — a 50 000-op apply took 60 and 73 s in them — only heap figures and
  the row-for-row comparison, neither of which the load moves. Time here is this machine's
  on a quiet quarter of an hour; the memory is the engine's.

**One device left behind, then let through — one pull:**

| | 1 000 ops | 10 000 ops | 50 000 ops |
| --- | --- | --- | --- |
| The response, decoded (on the wire) | 0.89 MB (0.67) | 8.9 MB (6.7) | 44.6 MB (33.6) |
| Envelopes | 5 | 50 | 250 |
| The relay's headers / the last byte, from the request | 7–11 ms / 27–31 ms | 22–38 ms / 228–256 ms | 97–190 ms / 1.1–1.4 s |
| Read, opened and applied — last byte to the ack | 445–546 ms | 4.82–5.25 s | 28.8–29.8 s |
| `sync:applied` / the wall redrawn, from the request | 483–593 ms / 521–638 ms | 5.18–5.73 s / 5.35–5.92 s | 30.1–31.0 s / 30.7–31.8 s |
| **Longest wait of a `search_cards`** (alone: 0.4–0.6 ms) | **376–496 ms** | **4.76–5.21 s** | **28.7–29.7 s** |
| The page's own thread, late by at most | 11–13 ms | 13–14 ms | 15–17 ms |
| **Linear memory**, before → after | 8.1 → 19.4–19.7 MB | 20.7 → **131.5 MB** | 21.0 → **569.9 MB** |
| The tab's process | 185 → 214–218 MB | 186–190 → 337–340 MB | 188–190 → 803–944 MB |
| The Worker's JS heap, highest sample either side of the apply | 1.5–1.8 MB | 2.3–3.1 MB | 7.9–9.3 MB |
| workerd's process, before → peak | 88 → 115 MB | 88 → 166 MB | 88 → 357–370 MB |
| The two collections, row for row (the re-runs; before them, by count) | equal | equal | equal |

**The relay isolate's JS heap, by request** — used heap just before the request → its highest
sample after it; the re-runs of 2026-10-05 00:00–00:20, one at 1 000 and two a size above,
alike to a tenth of a megabyte:

| | 1 000 ops (0.89 MB of log) | 10 000 ops (8.9 MB) | 50 000 ops (44.6 MB) |
| --- | --- | --- | --- |
| The pushes — 5, 50, 250 requests, nothing collected between them | 1.0 → 2.4 MB | 1.0 → 18.4 MB | 1.0 → 16.9–18.3 MB |
| The importing device's own pull, and the ack behind it | 2.3 → 2.4 MB | 5.0 → 18.4 MB | 17.8 → 61.9 MB |
| **The measured pull** | 1.0 → 2.8 MB | 1.0 → 18.9 MB | 1.0 → **90.2 MB** |
| The ack after it — a compaction | 1.0 → 1.9 MB | 1.0 → 10.0 MB | 1.0 → 45.7 MB |
| The whole run's highest, collected as above | 2.8 MB | 18.9 MB | 90.2 MB |
| The whole run's highest in the first runs, never collected | 4.8 MB | 29.5 MB | 142.6–156.7 MB |

- **The wire is not the cost.** The relay answered its headers in under 200 ms and the body was
  down in 1.4 s at 45 MB; `fetch`'s body is a JS string for a moment and the Worker's heap never
  showed it. **Everything else is the one stretch `client::pull` applies a page in**: about half
  a millisecond an op, with the engine answering nothing from the first envelope opened to the
  cursor's move.
- **The engine is deaf for the whole of it, and the page is not.** Every command waits — a
  search, a card's sheet, a wall's next page, a write — and none is refused: the three hundred
  searches asked across the 50 000-op apply were each answered when it ended. The page's own
  thread never ran more than 17 ms late, so what is already drawn scrolls and what is typed
  appears; whatever needs the engine shows its own waiting state for half a minute, with
  nothing on screen saying a sync is why.
- **Linear memory grew by twelve times the response and is never given back**: 11 MB, 111 MB
  and 549 MB, for the tab's life. By the code, the response's text, the parsed page, every
  opened batch and the apply's one transaction are all alive at once.
- **On the relay, a pull costs twice the log and a compaction costs it once.** The measured
  pull raised the isolate's heap by 1.9, 17.9 and 89.2 MB for logs of 0.89, 8.9 and 44.6 MB —
  the rows, and the one string they are serialised into. The ack that follows it, whose moved
  cursor runs `compactNow`, raised it by 0.9, 9.0 and 44.7 MB: every row read whole, for a
  decision that needs each row's length. The importing device's own trip costs the log once
  too — its pull reads the rows it has just pushed, to drop them, and its ack compacts. **A
  push is not what costs**: 250 of them left 17 MB of garbage between them, no more than 50
  did. So by these figures production's 128 MB is met by a pull at a log of about 64 MB —
  some 72 000 of these ops — and by a compaction, or an own-row pull, only at the quota
  itself, which is 134 MB. **At 50 000 ops the pull's 90 MB is inside the limit**; the first
  record of this step said it was past it, by reading the run's uncollected peak. The
  answer's bytes on their way out are outside the JS heap and in none of these figures. Local
  workerd enforces no limit, so nothing failed here at any size.

**The same import, heard live** (`--live`: nothing held, the 1 s frame debounce at work):

| | 1 000 ops | 10 000 ops | 50 000 ops |
| --- | --- | --- | --- |
| `head` frames heard → pulls made | 5 → 1 | 50 → 2 | 250 → 3 |
| The largest pull | 0.9 MB | 4.6–5.2 MB | 25.5–27.6 MB |
| Longest wait of a `search_cards` | 415–456 ms | 2.5–3.0 s | 14.9–15.8 s |
| Linear memory, before → after | 8.1 → 19.3 MB | 20.7 → 80.0–84.8 MB | 21 → 346–371 MB |
| Rows equal, after the importer's outbox emptied | 1.4–1.5 s | 5.0–5.3 s | 17.4–19.9 s |
| The relay isolate's JS heap, the whole run's highest, uncollected | 4.7–4.8 MB | 33.6–38.5 MB | 158–182 MB |

That last row is **the run's, and no request's**: here the pushes, the pulls and the acks
overlap, nothing can be collected between them, and each ack's compaction reads the whole log
again. In the re-run at 50 000 the largest pull — 18.3 MB that time, of four — raised the heap
by 34.4 MB across its own window, the same twice-its-size the collected runs show.

**Being live does not make the pulls small.** The first trip takes what one second of pushing
left, and while it applies — deaf to its own socket as to its page — the rest of the import
lands behind it: the second or third pull is most of the log.

**The push side, on the importing device:**

| | 1 000 lines | 10 000 lines | 50 000 lines |
| --- | --- | --- | --- |
| `collection_import_commit`, in a group (in none) | 0.9–1.0 s (0.7) | 8.8–10.1 s (7.1) | 45.3–49.8 s (34.9–37.8) |
| The first `POST` after the import answered | 3.0 s | 3.1–3.2 s | 3.8 s |
| `POST /push`, and how long they took | 5, 0.2 s | 50, 2.0–2.4 s | 250, 10.1–13.2 s |
| Pre-flights for them, by the relay's own log | 0 | 0 | 0 |
| Longest wait of a `search_cards` asked after the import answered | 44 ms | 106 ms | 1.1 s |
| Linear memory, before → after | 8.5 → 14.0 MB | 21.1 → 67.9 MB | 21.3 → 213.8 MB |

The import is one transaction and the engine answers nothing inside it, paired or not — its
longest wait is the import's own length — and that is the importer's to know: the dialog is on
screen. **The push itself is not deaf**: one read of the outbox, which is the second at 50 000,
then a seal and a request per envelope, each request an await — a search asked during it was
answered in a median 1.0–1.2 ms (that row is one run a size, from the loaded three).

**Pre-flights, counted in the relay's log** (an `OPTIONS` to the same path; a Worker's own
`Network` events do not show them reliably). Every push shares one address, and a browser
keeps a pre-flight's answer per address: none of the 5, 50 or 250 pushes was pre-flighted,
the pairing's own pushes minutes earlier having been. A pull's address carries its cursor, so
a pull whose cursor has moved is asked about again: in the left-behind runs the two pulls
(the importer's own and the measured one) stood behind one pre-flight, the measured pull's
address being one the device had already asked; live at 50 000, seven pulls behind six; on
the join, eight behind five. **How long the answer is kept is the browser's**: the relay says
a day (`cors.ts`, `MAX_AGE_SECS`), Chromium caps what it honours at two hours and Firefox at
a day ([MDN, Access-Control-Max-Age](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age),
read 2026-10-05, which cites Chromium's `preflight_result.cc`) — so a tab open past two
hours pre-flights its next push again, which no run here lasted long enough to see. That a
pre-flight costs a Worker invocation and no Durable Object request is the code's word
(`index.ts` answers it before the object is addressed) and not a measurement: local workerd
counts neither.

**A device paired into a collection that size** (`--join`: imported in no group, then claimed
and paired — the baseline):

| | 1 000 rows | 10 000 rows | 50 000 rows |
| --- | --- | --- | --- |
| The baseline, sent | 6 `POST`s, 0.2 s | 51, 2.0–2.2 s | 251, 11.7–13.4 s |
| Pulls that carried anything; in all | 1; 1.0 MB | 2; 9.8 MB | 3–5; 48.9 MB |
| The largest pull | 1.0 MB | 8.4–9.6 MB | 26.0–28.0 MB |
| Longest wait of a `search_cards`, joining device | 469–515 ms | 3.4–4.7 s | 13.3–16.3 s |
| … on the device sending the baseline | 1–9 ms | 109–129 ms | 869–895 ms |
| Linear memory, joining device | 7.7 → 19.8 MB | 20.4 → 120–133 MB | 20.6 → 335–357 MB |
| Rows equal, after *Codes match* | 3.2–3.5 s | 7.4–9.2 s | 33.5–36.3 s |
| The relay isolate's JS heap, the whole run's highest, uncollected | 3.8 MB | 39.8–42.9 MB | 224–258 MB |

A join is the same cost by another road. The relay's last row is again the run's and no
request's — 251 pushes, six to eight pulls and as many acks, each ack a compaction over the
whole log, with nothing collected between — and in the re-run its largest pull, 27.6 MB,
raised the heap by 35.0 MB across its own window. **A device that claimed before it imported
leaves that import on the log too** (`--join --claimed`, 10 000 rows, one run): the joining
device was answered 18.7 MB for the same 10 000 rows — 8.9 MB sealed under a key it never
held, read in 170 ms, stepped over and recorded in one `error_log` row, then the baseline —
and the relay's heap over that whole run, uncollected, reached 74.4 MB.

**The two-minute deadline is a floor on the link, and a pull that misses it starts over.** The
sync client's whole-request deadline in a browser (120 s, `client::REQUEST_DEADLINE`) covers
the body. With the pulling device's link paced (`--kbps 40`, a TCP relay in front of the local
one — DevTools' network emulation answers *Not supported* on a Worker's session; **downstream
only**, what the device sends going up unpaced), a 1 000-op pull was given up on **120.0 s**
after it was sent, all three times it was run: twice with 0.7 of its 0.89 MB read, by a first
version of the pacing that slept a fixed tenth of a second a slice and so delivered about
35 kbit/s, and once with 0.8 MB read at a true 40, paced against the clock. Either way the
`fetch` aborted, `error_log` says *error decoding response body*, the cursor stood still, and
the device held no row. The engine answered every search in a millisecond throughout — waiting
on a body is not deafness. The next trip asks for the same response from its first byte. By
the wire sizes above the pull needs 45 kbit/s at 1 000 ops, 0.45 Mbit/s at 10 000 and **2.2
Mbit/s at 50 000**, sustained, or it never lands.

**Production's limits, from Cloudflare's documentation as read 2026-10-04** — none is enforced
by local workerd, and none was met against the deployed relay:

- **Memory: 128 MB an isolate**, the JS heap and WebAssembly together, *"per-isolate, not
  per-invocation"*. Past it the runtime lets requests in flight finish and starts a new isolate
  for the next ones; a Worker over its limit is answered error 1102, and buffering a body that
  will not fit raises `Memory limit would be exceeded before EOF`
  ([Workers limits, Memory](https://developers.cloudflare.com/workers/platform/limits/#memory)).
  One isolate can host several Durable Objects of a class, which share its memory
  ([Durable Objects metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)):
  the 128 MB is every group's on that isolate, not one group's.
- **CPU: 30 s a request for a Durable Object** by default, configurable to five minutes — past
  it there is *"a heightened chance that the individual Durable Object is evicted and reset"* —
  and **10 ms an HTTP request for a Worker on the free plan**
  ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
  [Workers limits, CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)).
  The object answered a 45 MB pull's headers in under 200 ms of wall time here; the Worker in
  front of it passes the body through unread (`cors.ts`'s `withCors`).
- **No limit on a response's size**, and **2 MB a string or a row** in a Durable Object's
  SQLite — the cap `MAX_SEALED_CHARS` already stands under (the same two pages).

Against the memory limit, by the per-request table above: a pull is twice its log, so one
request passes 128 MB at a log of about 64 MB; a compaction is once its log, and passes it
only near the quota. Both share the isolate with every other group on it.

**The largest pull there can be is the group's quota, and it was made** (`--ops 250000`, one
run). A group's log may hold 128 MiB of sealed text (`MAX_GROUP_LOG_CHARS`): the relay stored
150 600 of the ops — 753 envelopes — and answered the next push 507 `quota`; 99 400 stayed on
the importing device, recorded once in its `error_log`, as designed. The device left behind
then pulled the whole log in one response: **134.2 MB** (101.3 MB on the wire), down in 3.5 s;
**244 s to apply**, 1.6 ms an op where 50 000 took 0.6; linear memory 21 → **1 647 MB**, the
tab's process peaking at 1.94 GB; the page's own thread 248 ms late at worst; and the 150 600
rows on both, by count — the quota left the two collections different by design. The relay's
heap over that whole run, never collected, reached 1 370 MB and workerd 1.89 GB: every later
trip of the importing device is refused again, and `push` runs `compactNow` over the whole
log before each refusal, 45 times in this run. By the per-request table the pull itself is
some 270 MB of that and each compaction 134 MB. **Nothing failed**, on a desktop with
32 GB and a runtime that enforces no limit: this run found no size at which the unpaged pull
stops working locally, only sizes at which nobody should be asked to wait for it.

**The decision: the unpaged pull is not acceptable at the sizes a reader will meet, and what it
needs is paging.** The plan said paging is built only if the figures ask for it. They do, and
this step builds none — it changes the pull's contract on both sides and needs a relay
deploy, which was the owner's to say yes to with the figures in hand. **Markus said yes on
2026-10-04 — "Build it now" — and it is step 6.5b (§10.5b).** Up to a couple of thousand ops
in one pull it is unremarkable: under a second deaf, 25 MB. A collection of ten thousand rows
— an ordinary one — already freezes a browser's engine for five seconds with nothing saying
why, on a join as on an import, and keeps 110 MB. At fifty thousand, the spec's own example,
two things are past what can be shipped on trust: a tab holding 570 MB of linear memory for
the rest of its life, and half a minute of an engine that answers nothing — on a phone,
whose memory was not measured. **The relay is not a third at that size**, which the first
record of this step said it was: the pull took its isolate to 90 MB, under production's 128.
**What breaks first, by size**: the reader's patience, from about two thousand ops; a slow
link's two minutes; and then, at about seventy thousand ops by the pull's own cost on the
relay, a limit this run could not make fail.

**Why not a turn between envelopes inside the apply** — the idiom the ingests use, and the
cheaper fix, looked at first. `client::pull` opens, classifies and applies the whole page in one
stretch on purpose: `apply_page` is one transaction over one group per row across every
envelope, parents first, in passes; which sender is held for its clock, or behind a newer
build's batch, is decided over the page before any of it is applied; and the cursor moves or
holds on the page's outcome. A turn taken inside `db.with` would hand the one connection to a
reader's command inside the pull's open transaction. Splitting the stretch is a rewrite of the
hold rules, not a `breathe()`, and the desktop would run it too. Paging gets the same turns
between pages — the request for the next page is the await — and leaves a page's apply the
one stretch it is.

**The design after review — built as step 6.5b (§10.5b).** The design this section first
carried was read by an independent reviewer, who found the measurement sound and three things
in the design wrong. What follows is the corrected one; where it differs from the first, it
says so. §10.5b is what was built from it, the two things it added, and the figures again.

- **The relay, with `limit`**: `GET /g/{group}/pull?since=&device=&limit=<rows>` answers at
  most that many **whole rows** after `since`, in `seq` order, the caller's own rows left out
  *by the query* — and never more than a budget of sealed characters the relay enforces
  whatever `limit` says, which always admits one row, since one row may be 1.5 M characters.
  Sorted by the hybrid clock within the page, as now. Answered `{ envelopes, cursor, more }`:
  `more` is whether a row of another device lies past the page, asked without reading a body;
  `cursor` is the last row returned while `more` is true, and otherwise the head of the whole
  log — **past the caller's own trailing rows**, or its ack would pin the compaction floor
  under them and a client that loops on "the cursor advanced" would loop for ever.
- **The relay, without `limit`: today's answer, byte for byte, and never a cap.** Every
  released desktop sends none, and an old client is not a pager: it decides its holds, its
  release, its conversions and its baselines on whatever one answer hands it, and schedules
  nothing after progress — so a cap on a request that asked for none would strand it. *The
  first design left this path as it is.* It cannot stay as it is either, because the
  per-request table says where its memory goes: so the own-row filter moves into the query,
  with the head read on its own; the answer is **streamed**, row by row, in place of one
  string twice the log's size; and `compactNow` reads each row's length and never its body.
- **Why a page in `seq` order is safe**: it is what a device that pulled when the log's head
  stood there was handed. **Not** what one unpaged pull would have been handed — and the
  statement the step is held to is exactly that: *a paged catch-up equals what an always-live
  device's sequence of pulls produces, not what one unpaged pull produced.* `apply` decides
  some things over a page — a child and its parent, a `gone` decision and the op that reverses
  it, a covered put and its claim, two other devices' ops on one row — and a page edge can
  fall between them as two pushes a second apart always could. *The first design said paging
  "adds no order of arrival the engine does not already meet" and left it there.* Step 6.5b
  tests each of those split across an edge against the unpaged database, and says which
  converge and which do not.
- **The client**: ask with `limit`; apply a page in today's one stretch; **write the cursor
  per page**, after that page's apply has committed; go on while `more` is true and the
  cursor advanced. A tab closed after page three of ten resumes at page four.
- **A page that would hold, while `more` is true, holds nothing.** *The first design fell back
  to the unpaged request there, which re-creates the failure*: the fallback fires on the
  ordinary join, where a child can precede its parent's page, and a `newer` hold would pull
  unpaged on every trip until the device updates. In its place the page's envelopes are
  **carried**: the next page is fetched, the two are sorted by the clock together and
  evaluated again as one, and the carry is dropped when the cursor advances. **Only the
  evaluation that reaches `more: false` may write a hold, release a wait, run the conversions
  that follow a pull which read everything, or let a baseline be emitted** — a partial view is
  never treated as the whole.
- **One `/keys` ask a trip; one ack at the end — and also when a later page fails**, so what
  advanced is acked and a flaky link does not pin the floor.
- **Old and new, either way round**: an old client sends no `limit` and is answered as it
  always was; a new client's `limit` is a parameter an old relay ignores, and an answer with
  no `more` reads as the last page. The relay deploys first and nothing waits on it.
- **The page's size** is one constant on each side, chosen from the figures above: about
  0.12 s of apply and 2.2 MB of linear memory an envelope of 200 ops, and a link of 40 kbit/s
  to fit inside the 120 s a request is given.

**Found on the way:**

- **Two of this record's own figures were wrong, and a reviewer found both.** The relay's heap
  was the run's peak printed as the pull's, and "rows equal" was a count and a sum of copies.
  Both are corrected above, in place, with what the first reading said kept beside it. What
  made the heap readable by request is in the script: V8 runs a requested collection as a
  task of the isolate's own, which workerd reaches at the isolate's next *request* — ten
  seconds of inspector messages did not reach it, and ten seconds of silence did not — so the
  run nudges the relay with a request it answers `404` in its Worker, and the collection
  follows.
- **The probe measured itself, once.** The grown card file is six names thirty thousand times
  over, so a search for `bolt` matches five thousand printings and costs 68 ms there. Asked
  every 100 ms through a 29 s apply, the 290 asks queued behind it took another 19 s to answer —
  ahead of the trip's own ack — and that run reported `sync:applied` at 49 s and the importing
  device's first `POST` at 73 s. The probe searches for a word no card carries now (0.5 ms at
  any size), and the figures above are from runs with it wherever the two differ. **It is also
  what a reader who keeps typing does to themselves**: every command asked of a deaf engine is
  answered, in order, before the engine goes on.
- **What capture costs an import in a browser**: 7.1 s in no group against 8.8–10.1 s in one at
  10 000 lines, 35–38 s against 45–50 s at 50 000 — about 1.3 times. [sync.md](sync.md)'s
  native figures put 1.9 times between the same two states, over a bare insert some fifty
  times cheaper than this import (0.7 s and 1.34 s for 50 000 rows).
- **A wait that asks the engine can wait for ever.** On the loaded machine one run sat at a
  device's startup until its whole deadline: an evaluation awaiting `startup_status` from a
  document that does not answer never returns to be polled again. The script's gate now gives
  each ask three seconds and reads the gate's own refusal beside it. The walk's `engineUntil`
  awaits a call the same way; it has not hung, and is not changed.
- **wrangler's inspector refuses a socket that names no origin.** Node's `WebSocket` sends
  none; handed `Origin: http://127.0.0.1:<port>` through its options, it is let in.
- **A first run's ingest sets linear memory's high-water mark for the tab's life** — and this
  fixture's is not a real corpus's: 555 MB for thirty thousand copies of six cards, where §9.6
  read 190–204 MB for the real 118 470.

**Open after this step:**

- **Production's limits.** No pull has been made against the deployed relay at any size: what
  an isolate past 128 MB does to the request that took it there, to the group's socket and to
  the other groups on that isolate, and what a Durable Object's 30 s of CPU makes of a full
  log, are unmeasured. The heap figures here are V8's as it left them, garbage included.
- ~~**A phone's memory.** Chrome on a desktop grew a Worker to 570 MB without complaint. No phone
  browser has been handed any of it, and a tab killed mid-apply has not been watched coming
  back — by the code it pulls the same page again, the cursor having stood still.~~ **answered
  in part — the 570 MB is gone** (§10.5b): the same catch-up, paged, leaves linear memory at
  69.5 MB, and a pull cut short while it applies resumes at the page it had reached
  (`a_pull_cut_short_after_a_page_resumes_at_the_next`, natively). No phone browser has run
  either.
- **Safari and Firefox**: neither has run the engine at all.
- ~~**A real link.** The deadline was met on a paced loopback socket; a phone's radio dropping a
  45 MB body part-way was not staged, and nothing resumes one.~~ **answered in part — there
  is no 45 MB body** (§10.5b): a page is 0.27 MB on the wire and inside the deadline on its
  own. What a dropped one costs is still the catch-up's fetching — a pull applies nothing until
  it has fetched to the head, so the pages that had landed are asked for again — and a phone's
  radio has still dropped nothing.
- **A group at its quota stays there.** The 99 400 ops left on the importing device are offered
  on every trip and refused on every trip, ~~each refusal a read of the whole log by the
  relay~~ (**since §10.5b a read of each row's length and of no body** — deployed
  2026-10-05, §10.7); the thirty-day tail keeps an acked import that long. What a reader is told,
  beyond one `error_log` row, was not looked at.
- **Ops unlike these.** One shape of op, 890 B sealed: a deck's, a note's and a delete's cost
  were not taken, and nor was a page that holds — a newer build's batch, a clock, a waiting
  parent — where the page comes back whole on every trip. (§10.5b tests what a paged pull
  decides behind a newer hold and a waiting one — a clock hold across pages has no test of its
  own — and what a hold to the head of the log costs is still not measured.)
- **A reader is told nothing while it happens**: no face says a sync is applying. Paging
  shortens the wait; it does not say so either.

### 10.5b Step 6.5b — the pull is paged (2026-10-04)

§10.5's figures asked for paging and the owner said to build it in this phase. It is built on
both sides: the relay answers a page; the engine fetches a catch-up in pages, looks into it,
and applies it a page at a time — or, when a baseline from a build older than v0.40.0 is in
it, as the one answer it used to be.
**Written and not deployed** (**Deployed 2026-10-05: the relay's half at 02:21:29 UTC and the
engine that pages at 02:29:39 — §10.7.**) — the relay's half is the runbook's tenth
([hosted-relay-deploy.md](hosted-relay-deploy.md)), and until it was out a build that paged was
answered by the live relay as it always was: one answer, read as the last page.

**The relay** (`relay/src/group.ts`, `log.ts`; the Worker in front of the object is untouched):

- **With `limit`, a page.** `GET /g/{group}/pull?since=&device=&limit=<rows>`: whole rows after
  `since` in `seq` order, the caller's own left out by the query, inside a budget of sealed
  characters the object enforces whatever `limit` says — `PULL_PAGE_CHARS`, half a mebibyte —
  which always admits one row, since one row may be 1.5 M characters. The sizes are read first
  (`length(sealed)`), a row at a time and no further than the first that does not fit, then
  the bodies of exactly the rows that fit. `limit` is capped at 1 024 and a malformed one is a
  `400`.
- **`{ envelopes, cursor, more }`.** `more` is an `EXISTS` for another device's row past the
  page, no body read. `cursor` is the page's last row while `more` is true and otherwise the
  head of the whole log, **past the caller's own trailing rows** — a cursor that stopped short
  of them would pin the compaction floor under them, and loop a client that goes on "while the
  cursor advanced".
- **Without `limit`: today's answer byte for byte, never capped, and streamed.** The caller's
  own rows are left out in SQL with the head read on its own; the order is asked of SQLite
  over the stamps alone; and each row is read and written as the stream is pulled from, where
  it was every row in an array and then one string. `withCors` already passed a body through
  unread. The one visible difference is a stream's: no `Content-Length`.
- **`compactNow` reads `length(sealed)` and no body** — behind every ack that moves a cursor,
  and before a push is refused for the quota.
- **Tested over SQLite.** `Group` was tested over a stand-in state in `ticket.test.ts`; that
  stand-in moved to `relay/src/fakeState.ts` and grew a `storage.sql` backed by Node's own
  `node:sqlite`, which counts the `sealed` characters each statement read — so "a compaction
  reads no body" and "a page never reads a row that is not in it" are numbers.
  `group.test.ts`, twenty-one tests: the page's edges, an all-own tail's cursor, the budget
  admitting one oversized row, `more` exact at the boundary, the unpaged bytes against the old
  implementation over a fixture log, a push landing mid-stream. **Two existing relay test
  files were edited, and no assertion in either**: `ticket.test.ts`, whose helpers moved, and
  step 6.3b's day-old `group.test.ts`, whose nine roster tests had a stand-in of their own
  that answered SQL by what a statement said — they run over the shared one now, on SQLite,
  reading `written()` where they read `written`. The other thirteen files are as they were.

**The engine** (`crates/grimoire-core/src/sync_engine/client.rs`; `apply.rs` is untouched). A
pull is three things, in this order:

- **Fetch.** Every page to the head of the log (`limit=256`, `PULL_PAGE_ROWS`; the relay's
  budget sizes it), each kept as it arrived — sealed — beside its cursor. Nothing is applied
  and the cursor does not move: a request that fails, or a tab that closes, anywhere in here
  loses the fetching and nothing else, and the next trip asks from the same cursor
  (`a_pull_whose_fetching_fails_has_applied_nothing_and_moved_nothing`).
- **Classify**, as each page arrives: is a baseline from a build before v0.40.0 anywhere in
  the catch-up? The page is opened, looked into and its plaintext let go.
- **Evaluate, one of two ways, chosen once for the whole catch-up** — a page at a time when
  there is none, as one answer when there is. `RelayOutcome` says which, in two new fields
  no face reads: `pullPages` and `pullWhole`.

**A page at a time** — every emitter sends references:

- **Each page is the one stretch the whole answer was**: opened, measured and applied in
  `apply_page`'s one transaction, **`PULL_CURSOR` written in that stretch when nothing in it
  is held**, and then a turn given to the host (`platform::timer::yield_to_host`) before the
  next. That turn is where a one-thread host answers its page
  (`a_page_command_is_answered_between_two_pages_of_a_pull`, on one connection and one thread)
  and where the reader's own write lands (`a_write_between_two_pages_is_kept_and_counted_once`).
  A pull cut short after page three resumes at page four
  (`a_pull_cut_short_after_a_page_resumes_at_the_next`).
- **Only the last page decides.** A page that is not the last and would hold writes no hold,
  releases nothing and leaves the cursor: its envelopes are **carried**, put together with the
  next page's, sorted by the group's clock and evaluated again as one. On an advance the carry
  is dropped. Only the evaluation of the last page may call `note_hold`, release a wait, run
  the conversions behind a pull that read everything, or answer `Ok` — which is what lets
  `round_trip` begin a baseline. **A page that is not the last never touches the stored hold**,
  not even to clear it: a first cut cleared it behind a clean page and so started a wait
  further up the log over (`a_wait_is_counted_on_across_a_page_that_applied_clean`). **There
  is no fallback to an unpaged request.**
- **The carry's bound is the catch-up**, which is already in hand. It is read again when its
  pages have doubled (two, four, eight) and at the last page, so a trip's work stays inside
  three times the unpaged pull's; a first cut weighed it in characters, and a parent's page a
  few bytes smaller than its child's then waited for the end of the log
  (`a_carry_the_next_page_resolves_is_dropped_there`).

**As one answer** — an older build's baseline is in it. Every page's envelopes sorted together,
one evaluation, one move of the cursor: **the unpaged pull exactly**, at its cost in memory and
in one long stretch, for that catch-up only. Why, and why it is decided before anything is
applied, is the next heading.

**Either way**: `/keys` once a trip; one ack at the end — and behind a pull that stopped part
of the way through its pages, which only the database can make it do, for what the earlier
pages took; and `sync:applied` **once a trip**, as before. A trip that applied pages and then
failed leaves `sync_state.pull_unannounced`, which the next trip to end well takes and answers
`changed` for — without it those rows are in the database and on no screen
(`a_pull_that_fails_between_two_pages_acks_what_it_took_and_emits_nothing`). An answer with no
`more` is the last page, which was every relay deployed when this was written; all 98 of the client's earlier
tests ran over this pull unedited, their mocks answering the old shape.

**The page's size is two constants, and the relay's is the one that sizes it.**
`PULL_PAGE_CHARS` = 512 KiB: two full envelopes of these ops, 0.36 MB decoded and 0.27 on the
wire; 79 s on a 40 kbit/s link against the 120 s a request is given; a megabyte of the
relay's heap. `PULL_PAGE_ROWS` = 256 on the client is a ceiling for a log of single edits,
where a budget's worth would be over a thousand envelopes in one stretch. **The same on every
host**: a desktop would not notice pages ten times the size, and two sizes would be two
schedules of arrival to test. `REQUEST_DEADLINE`'s comment says what it bounds now — a page —
with §10.5's measurement of the one it replaced.

**A paged pull must never lose a row that one unpaged answer delivered, on any mix of builds
— and as first built, it did.** The design said a paged catch-up equals what an always-live
device's pulls produce. It does; and against a build older than v0.40.0 an always-live
device's pulls **lose rows**. Such a build's baseline is claims with no references, judged by
their sender's watermark like any op and stamped with their rows' `updated_at` in table
order — stamps that do not rise with the log. One answer is sorted by stamp before it is
applied. In pieces, whatever is applied first lifts the watermark past what comes later with
a lower stamp, and that is skipped as seen, for good: [sync.md](sync.md)'s "a baseline pulled
in two halves" and "a sparse op pulled ahead of its baseline", which claim references ended
on 2026-10-03 for the builds that send them, one day before this step. Two fixtures, each run
three ways (`client/tests/paged.rs`):

| An older build's… | One unpaged answer | A page at a time | A live device, a pull after each push |
| --- | --- | --- | --- |
| baseline in two chunks, the first carrying the later stamp | both rows | **one row** | one row |
| own `+1`, a page ahead of its baseline — **any join** | both rows | **one row** | one row |

The second is not an edge: a device joining a group pulls the log from nought, and a log
holds an older build's ordinary ops ahead of the baseline it re-emits at every pairing. A
guard on the page — "do not evaluate a page that shows such a chunk" — catches the first and
not the second: by the time a page shows the chunk, the page before has moved the watermark.
So the catch-up is **classified whole, before any of it is applied**, which is why a pull
fetches first.

**What says "an older build's baseline" is a horizon with no reference**, and it is exact:
every build that has emitted a baseline has put the horizon on the first op of every chunk
(since `94265442`, v0.18.0) and on nothing else; since v0.40.0 every op of a baseline carries
its emission as well; and both generations stamp the same user schema, 59, so nothing
cheaper tells them apart. `only_a_horizon_with_no_reference_is_an_older_builds_baseline`
holds it to what a current build really writes — a copy, a binder, a filing, a rename, a
delete, a deck, and a baseline with references, whole and a chunk an op — because the failure
on that side is silent: every catch-up read as one answer, paging off, and nothing lost to
say so. `a_baseline_in_two_chunks_across_a_page_edge_ends_as_the_unpaged_pull_ends` holds a
current baseline to `pullWhole: false`.

**What changes on the desktop, then: a catch-up with no older build's baseline in it equals
what an always-live device's sequence of pulls produces, not what one unpaged pull produced;
one with such a baseline equals the unpaged pull, being it.** A page is the rows the relay
held up to some `seq` — what a pull made at that moment was always answered — so no page is
an arrival the engine could not already meet. But `apply` decides some things over what it
is handed at once. Each, split across a page edge and run the same three ways:

| Split across the edge | Paged against live | Paged against unpaged |
| --- | --- | --- |
| A child and the parent it names | equal | **equal** — the live device holds `waiting` for one pull, the paged one carries; rows, cursor and hold end alike |
| A covered put and its claim | equal | **equal**, two copies — with the put first, the only order a log can hold: a baseline is never begun while anything is pending, so what a horizon covers has the lower `seq` |
| … the claim first | equal — **four** copies | two. Not reachable; pinned as a premise by `the_other_order_is_not_one_a_log_can_hold` |
| A baseline with references, in two chunks | equal | **equal** |
| A sender held for its clock, its earlier batch a page before | equal | **equal once the clock catches up**; while it is held, the earlier batch has applied where one answer held the sender whole |
| A `gone` decision and the op that reverses it | equal | ⚠️ **different** |

⚠️ **The last row is a convergence defect in `apply` that paging did not make and does not
hide.** The fixture
(`a_gone_decision_and_its_reversal_across_a_page_edge_end_as_a_live_devices_pulls_do`): this
device deleted a binder; another, not having heard, files a copy into it, and in a later push
renames it — later than the delete, so add-wins brings the binder back. One answer carrying
both: the rename ranks first, the binder is back, the copy is in it. The copy's push alone,
then the rename's: the copy names a parent that is gone and nothing handed over can bring it
back, a binder's key is `SET NULL`, so the copy is written **at the root** and nothing is held;
the rename then brings the binder back, **empty**. The sender keeps the copy in the binder.
The two devices differ and nothing either will send says so — the move to the root is
`apply`'s own write, behind `capture::suppressed`. **A live device pulling between those two
pushes ends exactly so today**, on the code before this step; paging lets a device that is
catching up meet it too, when a page edge falls between the two pushes. The test holds paged
to live and, in its last assertion, the difference itself.

**Measured again, a page at a time** — `npm run web:sync-pull`, the same harness and machine
as §10.5, the engine at 6 869 005 B, on 2026-10-05. **Every figure below is of the pull as
committed** (fetch, classify, then a page at a time, against the relay that measures a page's
sizes a row at a time; the engine committed is 6 861 693 B — the one measured still carried a
switch for staging an older build's baseline, compiled out and never used, and removed with
the measurement it was for): one run a cell, taken 03:04–03:18 local with the CPU reading 6–19 %
before it, except the 50 000-row join, which read 44 %. Fourteen more runs, taken 02:24–03:04
with the CPU at 19–100 % for other agents' work — ten of them against the relay before it
measured a page's sizes a row at a time — are in no cell: a device left behind came out the
same to a tenth of a megabyte in every one of them, a live or joining one within eight
megabytes as its trips fell differently, and the times up to twice as long. Beside §10.5's
figures for the unpaged pull:

*One device left behind, then let through:*

| | 10 000 ops, unpaged | paged | 50 000 ops, unpaged | paged |
| --- | --- | --- | --- | --- |
| Pulls, and the pre-flights in front of them | 1 | 25, behind 25 | 1 | 125, behind 125 |
| The largest answer, decoded | 8.9 MB | 0.36 MB | 44.6 MB | 0.36 MB |
| The fetching, first request to the last page's last byte | 0.23–0.26 s | 0.64 s | 1.1–1.4 s | 3.3 s |
| **Longest wait of a `search_cards`**, asked before the page was told | **4.76–5.21 s** | **0.19 s** (median 73 ms) | **28.7–29.7 s** | **0.23 s** (median 85 ms) |
| … asked after it, behind the page's own refresh | not read apart | 0.26 s | not read apart | 1.18 s |
| `sync:applied`, from the first request | 5.18–5.73 s | 5.35 s | 30.1–31.0 s | 27.6 s |
| **Linear memory**, before → after | 20.7 → **131.5 MB** | 20.8 → **33.6 MB** | 21.0 → **569.9 MB** | 21.0 → **69.5 MB** |
| The tab's process, after | 337–340 MB | 240 MB | 803–944 MB | 329 MB |
| **The relay isolate's JS heap, for the pull** | 1.0 → 18.9 MB, one request | 1.0 → 5.4 MB over 25, nothing collected between | 1.0 → **90.2 MB** | 1.0 → **11.8 MB** over 125 |
| … for the ack behind it, a compaction | 1.0 → 10.0 MB | + 0.1 MB | 1.0 → 45.7 MB | + 0.1 MB |
| … for the importing device's own pull and ack | 5.0 → 18.4 MB | + 0.1 MB | 17.8 → 61.9 MB | + 0.2 MB |
| The two collections, row for row | equal | equal | equal | equal |

*The same import heard live, and a device paired into a collection that size:*

| | 10 000, unpaged | paged | 50 000, unpaged | paged |
| --- | --- | --- | --- | --- |
| Live: trips that pulled, and their pages | 2 pulls | 2 trips — 20 and 6 pages | 3 pulls | 3 trips — 20, 68 and 37 pages |
| Live: longest wait of a `search_cards`, the page's own refreshes included | 2.5–3.0 s | 0.25 s | 14.9–15.8 s | 1.12 s |
| Live: linear memory | 20.7 → 80.0–84.8 MB | 20.8 → 33.8 MB | 21 → 346–371 MB | 21.0 → 52.8 MB |
| Live: rows equal, after the importer's outbox emptied | 5.0–5.3 s | 6.2 s | 17.4–19.9 s | **28.7 s** |
| Join: trips that pulled, and their pages | 2 pulls | 2 trips — 16 and 9 pages | 3–5 pulls | 3 trips — 1, 25 and 99 pages |
| Join: longest wait, joining device | 3.4–4.7 s | 0.19 s | 13.3–16.3 s | 0.38 s |
| Join: linear memory, joining device | 20.4 → 120–133 MB | 20.4 → 31.1 MB | 20.6 → 335–357 MB | 20.6 → 67.7 MB |
| Join: rows equal, after *Codes match* | 7.4–9.2 s | 7.7 s | 33.5–36.3 s | 35.9 s (CPU at 44 %) |

- **The engine answers within a page.** What a search waited behind the unpaged pull for half
  a minute it waits a fifth of a second for — one page's apply — and the median is under a
  tenth. The longest wait left is not the pull's: it is asked after `sync:applied`, behind the
  page's own refresh — the wall asking again over fifty thousand rows.
- **Linear memory is the catch-up's sealed text and what the rows cost the database**, not
  twelve times the answer: 12.8 MB for a catch-up of 8.9 MB, 48.5 MB for one of 44.6 MB.
  **Fetching first costs about eleven megabytes of that at 50 000**: the first cut of this
  step applied each page as it arrived and ended at 58.1–58.2 MB there (32.5–32.6 MB at
  10 000), two runs a size earlier that night — and lost rows to an older build's baseline,
  which is why it was not kept.
- **Looking into a page costs seven to eleven milliseconds** — the gap between a page's last
  byte and the engine's next request, which is the answer parsed and its envelopes opened —
  against about two hundred to apply it. That is the "open twice" the classification costs,
  and why the opened ops are not kept instead: they are the memory paging exists to give back.
- **On the relay, a pull is a page.** 125 requests left 10.8 MB of garbage between them where
  one request held 89 MB; the compaction behind the ack, and the importing device's own pull,
  no longer show. The unpaged answer, streamed — measured with an engine that sends no `limit`,
  before the client paged — took the heap from 1.0 to 20.4 MB at 50 000 and to 10.9 MB at
  10 000, where it took it to 90.2 and 18.9.
- **Being live now costs time at the large end**: 28.7 s to converge on a 50 000-op import
  where three unpaged pulls took 17.4–19.9 s, and 6.2 s against 5.0–5.3 s at 10 000. One run
  a size; where the extra goes was not taken apart. Nothing is added for a device left behind
  (27.6 s against 30.1–31.0 s, 5.35 s against 5.18–5.73 s).

**Found on the way:**

- **The design as handed over lost rows against every released build but one**, and the
  split-across-an-edge tests it asked for are what found it — the heading above. v0.40.0 was a
  day old.
- **The `gone` reversal**, and the premise beside it: a claim stored ahead of the put it
  covers would double a row, on a live device as on a paged one. Neither is new; both are now
  tests.
- **A page's sizes were read 128 pages ahead.** `limit` is a ceiling in rows — 256 from the
  app — and SQLite loads a row's text to say how long it is, so asking every candidate's
  `length(sealed)` at once had each request measure 45 MB of log to answer 0.36 MB: 30–90 ms a
  page under workerd, and the fetching of 125 pages 9–20 s. Read a row at a time, and no
  further than the first that does not fit, it is 6 ms a page and 3.3 s
  (`measures no further into the log than the page goes`).
- **A browser pre-flights every page.** A pull's address carries its cursor, so each of the 25
  and each of the 125 stood behind an `OPTIONS` of its own — a Worker invocation, answered
  before the object. §10.1 said "a paged pull pays one a page"; it does.
- **Two first cuts of the carry were wrong**, and a test holds each now: weighed in
  characters, a parent's page a few bytes smaller than its child's waited for the end of the
  log; and a clean page that cleared the stored hold started a wait further up the log over.

**Reviewed, independently and read-only (2026-10-05): "ship after fixes", and no blocker.**
Its first should-fix was its condition for the relay's deploy: the streamed answer — the one
every released build is given — had its bytes held to the old implementation's only by
`group.test.ts`, over a stand-in state, and under workerd had been read by Chrome from a page
with nothing comparing them. **Answered before that deploy, under real workerd** (2026-10-05:
`wrangler dev --local` on the paging branch at `4fe47f3c`, a local D1 made from
`relay/schema.sql`, tokens minted with a throwaway key). The request is the one a released
desktop makes — `GET /g/{group}/pull?since=0&device=…` with a bearer, no `limit`, no
`Origin` — over two logs, each interleaved between two devices with the tail the caller's
own: 40 rows of 20 000 characters, and 120 rows of 400 000.

- `200`, `application/json`, no `Content-Length`; the caller's own rows absent; the rows in
  the group's order; `cursor` equal to the log's head.
- **The same bytes when asked twice**, and the same with the app's `Origin`, which adds the
  allow-origin header.
- **Equal to the `limit=7` pages joined** — 4 pages and 79 — with the cursors equal.
- The 31.6 MB answer took **869 ms**; an ack after it answered `204`.

The rest of what the review found is in the list below, each marked as its.

**Open after this step:**

- **The fetching has no bound** (the review's). Fetching all of a catch-up first puts no cap on
  it — not in pages, not in bytes, not in time — and a trip has no timeout of its own. A log at
  its quota is 128 MiB held sealed before the first row is applied; an interrupted fetch starts
  again from page one (below); and the sync lane is held for up to pages × 120 s, with a
  departure waiting on it. **No safe bound was found**: any window applied early can lift an
  older emitter's watermark ahead of its baseline, which is the loss fetching first exists to
  prevent.
- **A stale hold can be displayed** (the review's): clean pages advance past a block that has
  resolved without clearing the stored hold.
- **Four gaps in the tests** (the review's). The older-emitter fixtures are a current build's
  output with `emission` stripped, not a sealed golden from v0.39. Nothing covers a compaction
  mid-stream or between two pages — and the relay's own comment on it was wrong for a device
  that holds no floor, corrected since (`group.ts`'s `pullWhole`): such a caller's listed rows
  can go behind another device's ack, which is the answer a pull a moment later would have
  had. Byte parity is held with ASCII device ids only. And the ack-after-error test fails at
  `watermarks()` on an empty last page, never inside an apply.
- **The one-answer evaluation was not measured in a browser.** No current build can put a
  baseline without references on a relay's log, so the harness has no way to stage one. By
  the code it is the unpaged evaluation over the same envelopes — §10.5's stretch and §10.5's
  memory — with the catch-up's sealed text held beside it; that is a reading of the code and
  not a figure. Its results are tested against the unpaged database natively; its cost is not.
- ~~**The relay's half is not deployed**, and nothing has asked a deployed object for a page.~~
  **answered in part — deployed 2026-10-05 at 02:21:29 UTC** (§10.7), and the web app that
  pages eight minutes later. **Nothing has been seen asking a deployed object for a page.**
  There is no credential-free tell for it: `GET /g/abc/pull?limit=1` answers the gate's `401`
  before and after. The runbook's item 14 has the two tells a device's own token gives, and
  neither has been read.
- **A device that is live while a build older than v0.40.0 pushes its baseline still loses
  rows**, as it always has; [sync.md](sync.md)'s *What is still owed* has it as its own entry,
  with the fixtures. It ends when no device in a group is older than v0.40.0.
- **The `gone` reversal is not fixed.** It needs `apply` to revisit a `SET NULL` it made when
  the parent comes back — its own entry there too.
- **A catch-up's pages are fetched again from the first when one request of it fails**, since
  nothing is applied until the last has arrived. Each page is inside the deadline on its own,
  which the unpaged answer was not; a link that drops one page in a hundred pays the hundred
  again.
- **A catch-up is many requests.** 125 pulls and, from a browser, 125 pre-flights where there
  was one of each: Worker invocations and Durable Object requests on a metered plan, once per
  device per large import. Moving `since` out of the address would let one pre-flight stand
  for all of them; not done.
- **A hold to the head of the log still costs the whole log, every trip.** Behind a newer
  build's batch the client fetches everything above its cursor and carries it all — the
  unpaged pull's memory and its one long stretch at the end, until the reader updates. Tested
  for what it decides (`a_hold_to_the_end_of_the_log_is_written_once_by_the_last_page`), not
  measured for what it costs. **The review reads it wider**: the carry has no bound under a
  `newer`, a `clock` or a `behind` hold alike — the unpaged cost, on every trip while the
  hold stands.
- **Nothing is drawn until the last page.** `sync:applied` is one telling a trip; the rows of
  the earlier pages are in the database for the half-minute a 50 000-op catch-up still takes.
  A list refetched for another reason in that time shows them, which is right; nothing
  refetches because of them. And still no face says a sync is under way.
- **Unchanged from §10.5**: production's limits, a phone's memory, Safari and Firefox, a real
  link — none was measured here either. Every time above is this machine's.

### 10.6 Step 6.6 — the release rule: the three hosts ship from one tag (2026-10-04)

One core means one user schema per commit, and sync stamps every op with the sender's
`USER_SCHEMA_VERSION`: a device on an older build **holds** an op stamped newer until it updates.
So a host that ships ahead strands the others — a web app deployed from a `main` one rung past
the last release leaves every paired desktop holding ops with no update to install. Until this
step release-please bumped all four crates from one tag and **the tag built only the desktop**:
the APK was a CI artifact under a runner's debug key, which updates over nothing, and the web
app was deployed by hand from whatever `main` was. **Written and not run** — no release has been
cut since, and nothing below has met a real key, a real token or a real tag.
[ci-and-releases.md](ci-and-releases.md), *The release rule*, is the full record.

**`release.yml` is seven jobs** (`release-please`; `build`; `android` → `android-sign`; `web` →
`web-deploy`; `publish`):

- **`android` and `web` build at the tag as `ci.yml` builds them, and hold nothing.** They run
  whether or not a key or a token exists: a tag one host cannot be built from is a red run.
- **`android-sign` re-signs the APK and attaches it** as
  `mtg-grimoire-<version>-android-arm64.apk` (`scripts/android-sign.sh`). **Gradle does not
  sign**: a `keystore.properties` would put the key on disk beside every npm script, cargo build
  script and Gradle plugin a build runs, and the rule a removed `sign` job left behind is that a
  secret sits in a job that builds nothing. The Gradle project is unchanged and knows no key.
- **The key is held to a committed fingerprint**, `mobile/src-tauri/release-signer.sha256` —
  public, one line, absent until the owner makes the key. "Signed by the keystore in the
  settings" is not "signed by the key the last release was"; a keystore made a second time
  would sign happily and every phone would uninstall. No file, no APK; another key or an
  Android debug certificate is refused before anything is signed.
- **`web-deploy` deploys `app-worker/` and asks the address whether it serves that bundle**
  (`scripts/web-deploy-probe.mjs`: 200, the built policy, the built document). It is the only
  job that deploys anything and this is the only Worker — so **merging the release PR is a
  deploy**. `wrangler` is pinned by a lockfile, `app-worker/package-lock.json`: installed with
  `npm ci --ignore-scripts` in a step that holds nothing, run with `npx --no-install`. It goes
  last, because a deploy is live the moment it returns, and it refuses a tag older than the
  newest published release.
- **`publish` waits for all three.** Any failure leaves the release a draft.

**The two jobs that hold a value take it from a `release` environment**, which the owner
restricts to `main` — a repository secret is readable from any branch's workflow. Without its
values a job ships nothing, says so in the run's summary and ends green; some and not all is a
failure; a debug-signed APK is never attached. `scripts/release-rule.test.mjs` holds the graph,
the trigger, every spelling of `secrets` and which job may read which, and the exact list of
commands those two jobs may run — each checked by breaking the workflow that way, 23 mutations.

**Between releases**, `npm run web:deploy-guard` is the same rule for a deploy by hand: it
refuses a tree whose user schema is not the last release tag's, or whose last release is still a
draft — release-please makes the tag with the draft. **59 on both sides and v0.40.0 published
that day**, so `main` was not ahead. ⚠️ Equal schemas are necessary, not sufficient: a wire
change that is not a schema rung reaches an older build as `Malformed`, which the client steps
over — dropped, not held — and the guard cannot see it.

**The Android `versionCode`** is Tauri's arithmetic on the version release-please bumps (major
× 1,000,000 + minor × 1,000 + patch; `0.40.0` is `40000`), so every release installs over the
last; the signing script reads it back out of the APK and refuses another.

**What was driven**, on Windows: the guard against the real tag and the real release; the probe
against a local server, in each way it should fail; the workflow's own asking steps, extracted
from the YAML; a lockfile install with no script run and a `wrangler deploy --dry-run` after
it; the signing script with the real `keytool` and the SDK's three tools stubbed.

**Open after this step:**

- **No release has run these jobs.** The environment handing a value to a job on `main`, the
  artifact hand-off, the APK's upload, a deploy under an API token, the probe at the real
  address, and an APK updating over the last one on a phone are the first release's to show.
- ~~The first `ci.yml` `android` run is the signing script's first meeting with the real SDK
  tools.~~ **Met, on the pull request (#821), and the first meeting failed**: build-tools 37.0.0
  words a signer `V2 Signer: certificate SHA-256 digest: …` (`V3.0 Signer:` once re-signed),
  not the `Signer #1 …` of AOSP's source that the stubs spoke, and the script refused the
  runner's own build without printing what the tool had said. It now prints every tool's raw
  answer and reads any of the three wordings. The second run signed, held the APK to its
  fingerprint, kept the alignment (4 KB and 16 KB, in and out), read `versionCode='40000'
  versionName='0.40.0'` out of the APK, and refused another key's fingerprint and a debug
  certificate. **Still a throwaway key**: the release key has signed nothing.
- **`npm ci --ignore-scripts` and `wrangler` have not run on Linux**, which is what the runner
  is. The lockfile gives a Linux runner its platform packages and `esbuild` finds its binary
  without the script; nobody has watched it.
- **The token's minimum permissions are unverified**: Cloudflare's own table says the Workers
  *Editor* role on this one Worker and *Workers Routes: Write* on the zone, and no deploy has
  been made with such a token.
- **The owner's list**: restrict the `release` environment to `main` *before* anything is put in
  it; make the keystore and back it up; commit its fingerprint; set three Android values and two
  Cloudflare ones in the environment; and uninstall the debug-signed app from his phone once —
  the first release-signed APK does not install over it. The commands are in
  [ci-and-releases.md](ci-and-releases.md), *What only the owner can do*.

### 10.7 The deploys (2026-10-04 and 2026-10-05)

Two pairs, each in the order the runbooks hold them to — the relay first, and the web app only
once the relay answered a page — and all four run by an agent under the owner's standing ask
for this phase (*"you should deploy the changes we need, when we need them"*). **The first
pair, on 2026-10-04**, carries neither step 6.3b — the relay's ninth half and a client that
reads 4002 — nor step 6.5b: the tenth half — a page of a pull, the streamed answer, compaction
by length — and an engine that pages. **The second pair, on 2026-10-05, carries both**, and
follows the first below.

**The relay, at 17:22:12 UTC** — step 6.1's half, the browser's: CORS and the socket ticket.
From `main` at `ea0aa88e` (#818), version `75f903b6-94c3-431c-bf83-3ce36ed5d9e8`, wrangler
4.146.0, `--dry-run` first; no migration, no secret touched. Step 0's twelve probes were asked
at 17:21:24 UTC, before, and at **23:09:03 UTC, after** — five and three-quarter hours late: the
permission classifier refused the probe script straight after the deploy, and the owner allowed
it at 23:09.

- The six bodiless probes answered the same before and after: `400 {"error":"malformed token
  request"}`, `401`, `400 {"error":"that is not a device id"}`, `401 {"error":"unauthorized"}`,
  `404 {"error":"nothing there"}`, `400 {"error":"that is not an epoch"}`.
- **(a) the pre-flight, from the app**: before `405`, `Allow: POST`; **after `204`,
  `Access-Control-Allow-Origin: https://mtg-grimoire.app`, `Vary: Origin`,
  `access-control-allow-headers: authorization, content-type`, `access-control-allow-methods:
  POST`, `access-control-max-age: 86400`**. Its control, from `example.com`: `405`, `Allow:
  POST`, no `access-control-` line — before and after.
- **(b) a refusal a page can read**: before `401`; **after `401` with
  `Access-Control-Allow-Origin: https://mtg-grimoire.app` and `Vary: Origin`**. Control: `401`,
  no such line.
- **(c) the socket's origin check**, from `example.com`: before `401`; **after `403 origin not
  allowed`**. Control, from the app: `401`, before and after.

**The web app, at 23:19:22 UTC.** From `main` at `2bbd4446` (through #824 — step 6.3's engine
and the `wss://` source; not 6.3b, not 6.5b), version `befbcbd9-be3d-45f5-8150-4af8ff5337c9`,
engine build id `d6f5dc2a123a220e`, `index-B-KQBiDj.js`, `worker-WDxbzWW_.js`; the wrangler
`app-worker`'s lockfile pins. The runbook's steps in order: `npm ci`; `web:wasm` (6 836 569 B);
`web:build`; `web:smoke` passed in 19.0 s; `web:sync-smoke` passed in 37.9 s;
`web:deploy-guard` exit 0 (59 on both sides, v0.40.0); `wrangler dev --local` with probes 1–11
and 14–19 answering as the table says; `deploy --dry-run` (48 files read); the deploy (13 files
uploaded, 30 already there). **Just before it, at 23:18:35 UTC**, production answered probe 1
with the old policy, probe 19 `0`, and probe 20 — the relay's pre-flight — `204` with the
allow-origin line: the answer that means *go*.

**All twenty probes at 23:19:35 UTC, against the real address**, each as the runbook's table
says: the document `200`, `text/html`, `no-cache`, with the policy equal byte for byte to
`dist-web/_headers`; the module `application/wasm`, a year and immutable, **2 169 729 bytes on
the wire** as brotli (it is 6 836 569); the 404s as plain text; plain `http` a `301`; the 304
carrying the policy; **probe 19 `1`** — the policy names the relay, and its `wss://` twin is in
the same line; **probe 20 `204`** with `Access-Control-Allow-Origin: https://mtg-grimoire.app`.
The document served, to a plain `GET /` and to a navigation of `/decks/12`, is byte for byte
`dist-web/index.html`. `app-worker/README.md` has every cell.

**One look in a real browser, at 23:21 UTC** — headless Chrome on a throwaway profile at
1280×800, `https://mtg-grimoire.app/settings`, for 17 s. No policy violation. No error of the
app's: the one console error was Chrome's own new-tab page failing to resolve a Google host.
The first run began (`api.scryfall.com`, `data.scryfall.io`). **No request to the relay and no
socket**, from a device in no group. And the Sync panel, 4.6 s in: *Browser — not paired yet.*,
*Pair a device*, *Enter a code from another device*, *Not connected.*, *Connect Patreon*, *Sync
is off. Nothing leaves this device until you connect a membership.* — the sentence that said
this build could not sync is gone. Nothing was pressed that asks the relay.

**The second pair, on 2026-10-05 — steps 6.3b and 6.5b, on both Workers.**

**Before it, the unpaged pull was asked of real workerd as a released desktop asks it** — the
review's condition for this deploy, since every released build is answered by the streamed
path and its bytes had been compared only over a stand-in. Two logs, `200` with no
`Content-Length`, the same bytes asked twice and the same as the `limit=7` pages joined, a
31.6 MB answer in 869 ms: §10.5b has every line.

**The relay, at 02:21:29 UTC.** From `main` at `117827d2`, version
`8139d6e7-c5db-48fc-afc6-cd438a815d7f`, wrangler 4.146.0 from `app-worker`'s lockfile,
`--dry-run` first (85.29 KiB); no migration, no secret, no var changed. It carries three
things:

- **issue #752's fix**, from PR #827: `/claim` requires current auth when the group has key
  rows. Another session's work, not this phase's — `main` held it, and the owner chose to
  ship it with this deploy;
- **step 6.3b's roster close with 4002** — the runbook's ninth half;
- **step 6.5b's paged pull, streamed unpaged answer and compaction by length** — the tenth.

Step 0's twelve probes were asked at 02:21:04 UTC, before, and at 02:21:32, after. **Identical,
and identical to the first deploy's after-column**: `400 malformed token request`, `401`,
`400 that is not a device id`, `401 unauthorized`, `404 nothing there`, `400 that is not an
epoch`; (a) `204` with the allow-origin line, and `405` for its control; (b) `401` with the
line, and `401` without; (c) `403 origin not allowed`, and `401`. **None of the three changes
has a credential-free tell**: the probes say the Worker is whole after the deploy, and what
says the three are in it is the tree that was deployed.

**The web app, at 02:29:39 UTC.** From `main` at `117827d2` — so it carries 6.3b and 6.5b,
and beside them #828's backup archive and #830's *Not sorted* controls, two other sessions'
work that `main` held — version `685ae2ad-2309-4824-b707-6a39c159053e`, engine build id
`a3947b5c7a3ba658` (the module 6 862 338 B), `index-ByCbemTm.js`, `worker-DfcE0hqp.js`. The
runbook's steps in order: `npm ci`; `web:wasm`; `web:build`; `web:smoke` passed in 20.9 s;
`web:sync-smoke` — below; `web:deploy-guard` exit 0 (59 on both sides, v0.40.0); `wrangler
dev --local` with probes 1–11 and 14–19 answering as the table says (the module's brotli
2 025 348 B locally); `deploy --dry-run` (48 files read); the deploy (12 files uploaded, 31
already there).

⚠️ **The sync smoke's first run failed in teardown, not in the walk**: `EBUSY … unlink
…\grimoire-web-smoke-…\first_party_sets.db-journal` — a temp profile Chrome had not let go
of — and the walk's own lines were not printed. **The second run passed all twelve lines in
63.3 s.** A walk that passed must not report FAILED for a file Windows still holds:
`scripts/web-smoke/harness.mjs` now tries the removal for longer, and names a directory it
has to leave behind in one line without failing the run.

**All twenty probes at 02:29:46 UTC, against the real address**, each as the first deploy's:
the policy byte for byte the built one on every response that carries it, the 304 included;
both relay sources named; the document equal to the built one; **the module 2 178 693 bytes as
brotli**; probe 20 `204`.

**One look in a real browser, at 02:30 UTC** — a throwaway headless Chrome. No policy
violation. No error of the app's. No request to the relay and no socket, from a device in no
group. The Sync panel as before.

**What only the owner's membership can show.** One sentence of it has been said: **on
2026-10-05 the owner paired the deployed web app (`https://mtg-grimoire.app`, version
`befbcbd9`) with a desktop and synced between them, and said "it works"** — production's
first browser sync, on the first pair's web app, before the second went out. That is the owner's sentence and not a measurement: nobody read how long
the socket stayed live, saw a `pong`, or read what a tab's keepalive is billed. So, still
shown by nothing but that sentence, or by nothing at all:

- a browser claiming or pairing against the deployed relay — **done, by the owner's word**;
- a browser's socket in production — the 101's sub-protocol reaching a page and the text `ping`
  answered `pong` were settled under local workerd (§10.3), not there;
- a write on one device drawn on another through the deployed relay, with nothing pressed —
  "synced between them" is what was said; whether anything was pressed was not;
- what a keepalive is billed, which is the runbook's one-hour check;
- **that a released desktop still syncs through the streamed answer in production — confirmed
  by nobody since the second relay deploy.** Every released build's pull is that path now. The
  owner was asked on 2026-10-05, and this stays open until he, or anyone with a membership and
  a released build, says so;
- a removed device told by the deployed relay, and a pull answered by it in pages — live by
  the tree that was deployed, and seen by nobody.

**Phase 6 is complete (2026-10-05).** Eight pull requests — #818 (6.1), #819 (6.2), #823 (6.3),
#825 (6.3b), #820 (6.4), #824 (6.5), #829 (6.5b) and #821 (6.6) — and two deploys of each
Worker. A light install is another device in the group on either host, over the live socket,
and its pull is paged. What is open, and whose, drawn from the lists above and adding nothing
to them:

- **The owner's, on GitHub** (§10.6): the release rule's list — restrict the `release`
  environment to `main` before anything is put in it, make the keystore and back it up, commit
  its fingerprint, set the five values, uninstall the debug-signed app once
  ([ci-and-releases.md](ci-and-releases.md), *What only the owner can do*). And the first
  release, which is the first run of those jobs.
- **The owner's, in production** (§10.7, and the runbook's items 13 and 14): a released
  desktop through the streamed answer; a removed device told; a browser's socket read, and
  what its keepalive is billed.
- **A real phone's** (§10.2, §10.3, §10.4): the camera's grant and a real lens on a real code;
  whether a backgrounded app, or a frozen tab, keeps its socket and what it does coming back.
- **Safari's and Firefox's** (§10.3, §10.5): neither has been driven — no socket watched, no pull
  measured.
- **The paged pull's** (§10.5b): the fetching has no bound; the carry has none under a hold; a
  stale hold can be displayed; the four test gaps; the one-answer evaluation measured in no
  browser; a catch-up's many requests and pre-flights; nothing drawn until the last page.
- **Production's limits** (§10.5): no pull of any size has been measured against the deployed
  relay, and a group at its quota stays there.
- **Smaller, and anyone's** (§10.3b, §10.4): a Sync panel left open on a removed device keeps
  its old roster; no desktop has been driven through step 6.3b; the Android host answers no
  `storage_group_warning`; the scan smoke runs only by hand; and no face says a sync is under
  way.

**Two defects older than this phase, which step 6.5b surfaced and nothing here fixed** — each
under *What is still owed* in [sync.md](sync.md), with its fixture in
`crates/grimoire-core/src/sync_engine/client/tests/paged.rs`:

- **an older emitter's baseline arriving in two separate pushes** leaves a live receiver
  missing rows;
- **a copy filed into a binder that was deleted on the receiver**, whose sender later brings
  the binder back, is kept on one device and not the other.
