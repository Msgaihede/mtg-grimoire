# The light app

The Android and web face of MTG Grimoire — card search, decks, collection, wishlist and scanner —
as one second entry over the desktop's own components. **What is built is phase 1, the skeleton:
it runs in a browser over the Storybook fake (§2.1) and in a phone-sized window over the real
Rust core (§2.2), and both were driven. There is no Android host, no WASM host, no service worker
and no sync on a light install yet.** Underneath it, phase 2 has started: the engine is moving
into a crate those hosts can link, a step at a time (§6).

- The design, all seven phases: [the spec](../superpowers/specs/2026-10-01-light-app-android-and-web-design.md).
- How the skeleton was built: [the plan](../superpowers/plans/2026-10-01-light-app-skeleton.md).
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

- **The Collection and Wishlist walls draw open shelves only.** The desktop hooks fetch the cards
  of the shelves the reader has left open, and deck groups, `Recently removed` and a deck's
  managed wishlist folder start shut — so on the `starter` seed the collection wall draws 9 of 12
  rows. When every row is on a shut shelf the page says so; it cannot open one.
- ~~After a refused next page a wall stops asking and says nothing~~ — **fixed 2026-10-03**: the
  wall ends on `The next cards could not be read.` and a `Try again` that calls `fetchNextPage`
  itself (`parts.tsx`'s `NextPageRefused`, through `CardWall`'s `footer`). It still stops asking
  on its own until then, and still re-arms on any refetch.
- ~~When the whole-wall figure itself fails to load over an empty wall, the page draws
  nothing~~ — **fixed 2026-10-03**: the collection and the wishlist say the rest could not be
  counted, from `useCollection`'s new `figuresRefused` and `useWishlist`'s `countsQuery`.
- A tile with no card to open (a wish whose card the corpus no longer has) is a button that does
  nothing.
- Two rows of one printing get one accessible name; the desktop wall folds them into one tile.
- ~~`DeckPage` keys its own query, so crossing 1024 with a deck open refetches it; it always reads
  the `live` list~~ — **fixed 2026-10-03 in step 3.4** (§7.4): it asks through `deckDetailQuery`
  (`src/features/decks/deckQuery.ts`), the key `useDeck` itself reads under, and opens on the list
  the deck remembers (`lastVariant` where it keeps a plan) with a Theory / Actual switch. And
  ~~`facesOf` now exists twice~~ — **fixed 2026-10-03**: it lives once, in
  `src/features/card/faces.ts`, read by `CardTextDialog` and the phone's card sheet (§7.1).
- The wall's list semantics count rows rather than cards; no test scrolls a long wall to its end.
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

- `FaceBoundary` catches a face that throws — a lazy chunk that never arrives included — and
  offers a reload. What it does not do is recover: a deploy that renamed the chunks needs the
  service worker's update story, which is this phase's.
- A refused history **push** is swallowed like a refused replace, but costs more than a stale
  URL — the entry is never made. `back()`'s latch has one release, a `popstate`; a
  `history.back()` the browser drops leaves ✕ and Escape inert until the next one.
- `public/light.webmanifest` is copied into every build's output, the desktop's and the share
  viewer's included, because `public/` is shared. It is inert there.
- The manifest's and the page's `#0e0f13` is two levels off `--color-bg`'s real sRGB value.

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
this section is what each step built and measured. **Nothing here runs on a phone or in a
browser yet**: what exists is a crate the desktop links, compiled for two more targets. All
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
found one clock read the plan had missed, in an `#[ignore]`d benchmark.

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
  there; the first thing to call one is phase 5's Worker.
- **CORS is unmeasured, and it decides whether the browser arm of the client works at all.** A
  request from a Worker is cross-origin: `If-None-Match` and `Range` cost a pre-flight, and
  `ETag`, `Retry-After` and `Content-Range` read as absent unless the host exposes them — in
  which case a bulk check stores no ETag, every 429 falls to thirty seconds and a resume is
  refused. Which of those `api.scryfall.com`, `data.scryfall.io` and `cards.scryfall.io` expose
  is the first thing phase 5 measures, against the real hosts.
- **A browser's `Tick` is the wall clock**, in whole milliseconds, so a clock stepped forwards
  opens the pacing gate early there. `performance.now()` is monotonic and a Worker has it; the
  web host should give `platform::clock` that arm before it paces a request.
- **`futures_util`'s mutex is not FIFO-fair** where tokio's was. The gate promises spacing, not
  order, and one request is in flight at a time in this app — but a caller that needed the order
  would not get it.
- **A download in a browser is unanswered.** `Client::download` writes a temp file and
  `ingest_gz` reads one; `StreamIngest` already takes chunks, so the web host can feed it a body
  directly. That is its decision.
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
  is phase 5's.
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
  browser's half — a `WebSocket`, or the polling spec §7 names — is phase 6's.
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
  host that is for phases 4 and 5's seams to settle. A to-do box on the phone is drawn and cannot
  be pressed, and says `Done:` or `To do:`.
- **Not on the phone yet**: Compare, the theory-match ticks on the Actual list, the deck's
  description, and the stats band beyond the mana curve (the band carries write buttons).

Driven at 360 and 800 wide over the `starter` seed's decks 2 and 4: nothing scrolls sideways.

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
  a link exists (phases 4 and 5).
- **Driven in Chromium over the fake** (`mobile:dev` on port 5176): every group opened at 360 wide
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
