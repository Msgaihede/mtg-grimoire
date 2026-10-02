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
**The base config ignores `src-tauri` only, so the desktop's and the share viewer's dev servers
have the same exposure** — outside this branch, and flagged rather than fixed.

## 5. Open, and where each belongs

Nothing below blocks the skeleton. Each was found by a review or the live pass and left on
purpose; the phase that owns the surface owns the fix.

### Phase 3 — the phone pages (each comes to the owner as built options first)

- **The Collection and Wishlist walls draw open shelves only.** The desktop hooks fetch the cards
  of the shelves the reader has left open, and deck groups, `Recently removed` and a deck's
  managed wishlist folder start shut — so on the `starter` seed the collection wall draws 9 of 12
  rows. When every row is on a shut shelf the page says so; it cannot open one.
- After a refused next page a wall stops asking and says nothing. It re-arms on any refetch of
  that query (a tab away and back, a window refocus), so it is not stuck for the session.
- When the whole-wall figure itself fails to load over an empty wall, the page draws nothing —
  neither empty-state sentence is known to be true. `useWishlist` does return the query that
  could say so; `useCollection` returns only the figure.
- A tile with no card to open (a wish whose card the corpus no longer has) is a button that does
  nothing.
- Two rows of one printing get one accessible name; the desktop wall folds them into one tile.
- `DeckPage` keys its own query, so crossing 1024 with a deck open refetches it; it always reads
  the `live` list; and `facesOf` now exists twice (the desktop's lives in a module that imports
  the store).
- The wall's list semantics count rows rather than cards; no test scrolls a long wall to its end.
- In landscape the bars stop short of the screen's edge beside a cutout — the shell pads the
  root by the side insets. Whether the bars should bleed with their content inset is a device
  pass's call.
- **A constraint on the sheet's design, not a defect yet**: a step from one card to another
  *inside* the sheet must be `navigate(…, { replace: true })`. A plain `navigate` is a second
  marked push, and one close would then land on the first card instead of the page.
- In the light edition `Ctrl+Shift+N` still asks for a new window, and on the desktop face the
  key map has no mount (so `F1` is left to the browser).
- **The desktop face can reach a view the light edition does not draw.** The collection's
  share menu opens a shared binder with `setActiveView("shared")`; the URL has no word for it, so
  the adapter writes `/search` while the binder is on screen, no rail row is lit, and a reload, a
  resize or Forward lands on Search. It is the one such path besides `Ctrl+Shift+N`.
- **A crossing unmounts the face it leaves**, so anything half-typed on the desktop face — a
  note, an import's text, a rename — is discarded by a browser resize or a tablet's rotation; a
  zoom gesture still inside its trailing write is not persisted; and the desktop's launch reads
  run again on each widening.
- **History across the floor has two warts.** A card the phone face *pushed*, closed on the
  desktop face by `replaceState`, leaves two entries for one place — one Back that shows nothing.
  And a card opened on the desktop face is written by replace, so carried to the phone face its
  sheet is not an entry of the router's: ✕ and Escape close it, Back leaves the page beneath.

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

- `fence.test.ts`'s import walk cannot see `import.meta.glob`, a template-literal `import()` or
  a root-absolute specifier; none exists under `mobile/` today. Its comment stripper is not
  string-aware either: a `/*` inside a string or a regex literal would swallow the text after it,
  import edges included. No reachable file has one.
- `vite.mobile.config.ts` restates Storybook's four fake aliases by hand, with nothing holding
  the two lists together.
- Its probe sweep is literal about spelling — a destructured `userAgent`, a bracket access or
  `@tauri-apps/plugin-os` would pass — and reads `.ts`, `.tsx`, `.css` and `.html` only.
- `src/lib/tokens.test.ts` still stops at `src/`: it counts exactly one `MotionConfig`, and the
  phone face rightly mounts its own.

### The dev window

- `window::open_sized_to_monitor` centres the phone-sized window without clamping it. On a work
  area shorter than about 954 logical px — a 1080p panel at 125% or 150% — the OS caption opens
  above the top of the screen.

## 6. The shared core — phase 2, a step at a time

The engine is moving out of `src-tauri` into `crates/grimoire-core`, a crate with no `tauri`
dependency that the desktop, the Android host and the WASM host will all link (spec §2). The
rules for working in it are [`crates/grimoire-core/CLAUDE.md`](../../crates/grimoire-core/CLAUDE.md);
this section is what each step built and measured. **Nothing here runs on a phone or in a
browser yet**: what exists is a crate the desktop links, compiled for two more targets. Three
steps of seven have landed — the leaves, the storage layer, and the state a host holds over it.

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
  old names. Their 24 call sites — 15 of them `watch`'s own tests — are unedited.
- The hook's two blind spots are pinned where it is installed now: a `WITHOUT ROWID` write and a
  bare `DELETE` on a table nothing points at each reach `committed` and never `row`.

**`AppState` wraps the core's `State` and derefs to it.** `AppState` is named 480 times in 73
files and `state.db` 164 times in 38; none was edited. What was: the nine places that build one
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
`lock_db_read` keeps its 112 callers. Tested natively both ways; **no browser has run it**.

**No test was lost.** `#[test]` and `#[tokio::test]` attributes: 3 366 before, 3 382 after —
2 810 in `src-tauri`, unchanged, and 556 → 572 in the core. The sixteen are this step's own:
eight of the installer's and its measurement, three of the sink's, four of the state's.
`cargo test --workspace`: `src-tauri` 2 806 passed and 4 ignored, as before.

**What the observer list costs per row** — the one thing the installer added to a hook that
called its riders directly. A **release** build of the core alone, one `UPDATE` over 100 000
rows, the best of nine rounds, five runs:

| | ns per row |
| --- | --- |
| No observer | 72.9 – 74.0 |
| Three observers, each one atomic add | 76.9 – 77.6 |
| The difference | **+2.9 to +4.1** |

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
- **The eight fixtures now hook the state's own change mask**, where they used to hand the hook
  a throwaway. Nothing reads it there; it is what the app does.
- `scripts/coverage-rust.mjs` was not run, and neither was the card-scanner suite locally.
