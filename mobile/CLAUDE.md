# mobile — the light app

A second app over the same `src/` components and the same Rust core: card search, decks,
collection, wishlist and scanner, for Android and for browsers. The design is
[the light-app spec](../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md);
read its §3 before changing anything here.

**Light is the menu and the face, never the data.** A light install runs the same commands
against the same two databases. What it leaves out is destinations.

**What is here is phase 1, the skeleton, and phase 3, the pages** (2026-10-03): Search and its
filters, the card sheet, the two cabinets, the deck gallery and the one-column deck page, writes,
import and export, and Settings. Every rule below is held by a jsdom test or by construction, and
what was actually driven — a browser over the fake, and on 2026-10-01 the `mobile:tauri` window
over the real core — is in [light-app.md](../docs/reference/light-app.md) (§2 and §7), with the
date, the build and the width of each figure.

## One entry, two faces

`LightApp` picks a face by the viewport's width and by nothing else.

| Viewport | Face | Lives in |
| --- | --- | --- |
| ≥ 1024px (`DESKTOP_FLOOR_PX`) | **The desktop UI itself**, in the light edition | `src/`, hosted by `DesktopFace.tsx` |
| < 1024px | **The phone face** | `mobile/phone/` |

- **The question is asked once, in `useFace.ts`**, as a `matchMedia` on `DESKTOP_FLOOR_PX` —
  quoted from `src/lib/viewports.ts`, never typed again. No page in `src/` picks a *face* and
  none may start; which one to draw is the light entry's question, and this is the only place
  it is asked. (Details in `src/` do answer to the viewport — the card modal's flanks at 900px,
  `Dialog`'s inset at 640, a few `min-[1200px]:` rungs — and none of them chooses a face.)
- **Each face is its own lazy chunk**, so a phone never downloads the desktop's deck editor and a
  laptop never downloads the phone's sheets. Neither is imported statically by `LightApp`, and an
  import that made one static would cost that without anything going red.
- **A narrowed browser window _is_ the phone app**, not a responsive rendering of the desktop one:
  dragging across 1024 swaps the face live and keeps the destination, because the URL is what
  both read. **The rule runs both ways** — an Android tablet wide enough to cross 1024 gets the
  desktop face, for the reason a wide browser does.
- **Every component is drawn only at the widths it was designed for.** That is the whole lesson of
  the phone layout removed on 2026-09-27: desktop components bent down to 360px. Do not add a
  narrow branch to a desktop page, and do not stretch a phone page past 1024.
- **Inside the phone face, the tab bar becomes a rail from 600px wide** (`TabBar.tsx`), by the width
  alone — the band between 600 and 1024 is a portrait tablet or a phone on its side, and on the
  phone on its side the bar cost the wall its only row. Decided 2026-10-03; light-app.md §7.8 has
  the widths.
- **Both faces are whole apps with their own providers, and they share one `queryClient`**
  (`@/lib/query`), so what one face read is still in the cache when a resize draws the other.
  **A crossing unmounts the whole face it leaves.** The destination and the open card survive
  it; filter state does not, and neither does anything half-typed on the desktop face — a note,
  an import's text, a rename. **That is accepted, not overlooked** (2026-10-03,
  [light-app.md](../docs/reference/light-app.md) §7.8): holding the crossing while a field has
  focus would draw the desktop UI below its floor — the one thing this page forbids — and freeze
  every resize for a caret in an empty search box, because the app has no signal for *unsaved*
  that covers a controlled input and the note editor alike.
- **`FaceBoundary` stands between a face that threw and a blank page**, keyed by the face so a
  failure in one does not follow the reader into the other. A lazy chunk that never arrives —
  offline, on a host that keeps no copy of the build — is the ordinary way to need it. **A
  deploy that renamed the chunks is no longer one on the web host** (step 5.3): the page's own
  build is precached whole under its own name and served to it until the reader takes the
  update. Its way out is the host's waiting build when the host says one is waiting
  (`useHostUpdate`), and the reload otherwise.

## Nothing here asks where it is running

The spec's §3, word for word: **"The Android app and the web app are the same program, and the
phone face is one face — not two that resemble each other."** It is the owner's rule, 2026-10-01 —
*"the web/PWA collapses down into the mobile view, and that view is 1:1 with the mobile app"* —
and what follows from it first: **"Nothing under `mobile/` asks where it is running. No user-agent
test, no `isTauri`, no `isAndroid`, no `display-mode` query deciding what a page draws."**

- **`phone/fence.test.ts`'s second arm is the fence**, because a resemblance kept by hand is N
  decisions that happen to agree today. It sweeps every `.ts`, `.tsx`, `.css` and `.html` under
  `mobile/` — tests included, itself excluded — for `userAgent` (the bare word, so a destructure
  or a bracket read asks it too), `userAgentData`, `navigator.platform` (however `navigator` is
  reached for it), `isTauri`, `__TAURI`, `isAndroid`, `isWebTarget`, `display-mode` and
  `@tauri-apps/plugin-os`.
  **It reads comments too**, so a source file may not name one even in prose; this file may,
  because the sweep does not read Markdown.
- **`import.meta.env.MODE === "fake"` is not a probe, and neither is `=== "web"`.** Each is
  which *build* this is, replaced at compile time and asked of no window. `fake` is how
  `main.tsx` keeps the Storybook fake out of a production bundle; `web` is how the web app's
  build — and no other — reaches the database Worker, **and that choice is made in
  `src/lib/core/index.ts`, below the seam, never here**: nothing under `mobile/` compares the
  mode to `web`.
- **What differs between two installs lives below `@/lib/core`** (spec §3.5): how a command is
  called, how a file is picked, where a card image is served from. The one user-agent read the
  phone face's graph reaches today is that seam's own — `src/lib/images.ts`'s `imageOrigin`,
  which picks a URL's origin and decides nothing a page draws.
- **Saving a file is below `@/lib/core` since phase 4** (step 4.3): `@/lib/core/files`'s
  `saveText` answers `"saved"`/`"cancelled"` on the Android host — which answers the desktop's own
  `export_save_file` with the system's save dialog — and `"handed"` in a browser, which downloads.
  **Picking needed no seam on the phone face**: Android's WebView answers an
  `<input type="file">` with the system picker and hands the page a `File` for the `content://`
  document, so the phone's import sheet keeps an input of its own on every install alike, and
  reads what it is handed with `@/lib/core/browserFiles` — the megabyte, the four readings, and
  the download `saveText` hands over. (That module was `phone/transfer/browserFiles.ts` until the
  web host needed the same read, step 5.4.) Do not grow a second file module beside either.
- **The clipboard and the way out to a browser are below `@/lib/core` since phase 5** (step 5.4):
  `src/lib/core/index.ts` chooses a `host` where it chooses the `core` — the two Tauri plugins on
  the desktop, a browser's clipboard and Tauri's opener on the Android host (which registers no
  clipboard plugin and grants the page the opener's pair), and a browser's own two answers in the
  web build. `@/lib/clipboard`'s `copyText` and `@/lib/externalLinks`' `openExternal` are how
  both faces ask, so a copy refused for want of a clipboard is one sentence everywhere, and the
  phone face imports the URL builders beside it. **A control that leaves the app from a phone page
  is still a real link where it can be** — `phone/card/OpenOn.tsx`'s three rows are
  `<a target="_blank">`, which a browser opens in a tab and the Android host's guard hands to the
  system browser; `openExternal` is for a press that has to compute its address first, as the Sync
  panel's *Connect Patreon* does.
- **What only one host has arrives from the host, in a form both understand**: Android's back
  gesture as History navigation (Tauri's shell sends it to the WebView's `goBack()` while there is
  an entry to go back to, so the phone router's pushes are what it walks; from the first entry the
  host's `MainActivity` moves the task to the back rather than finishing it), and the bars, a cutout
  and the keyboard as a page that is simply smaller — the Android host pads its content view by
  all three (step 4.3), so `env(safe-area-inset-*)` reads 0 there, and in a browser that has a
  cutout the phone shell's own `env()` insets do the work. Never a banner one install draws and
  the other does not.

## The edition

`src/lib/edition.ts`. The desktop shell reads an `Edition` from context — which rail rows to draw,
whether to draw the caption, which view chords act — and the full edition is the default, so the
desktop app provides nothing and `DesktopFace` provides `LIGHT_EDITION`. **A page never reads the
edition, and nothing under `src/` asks where it is running**; `AppShell` is one reader, and
`SettingsPage` the other spec §3.1 names — `Edition.settings` is its entry list, `null` for every
panel and `LIGHT_SETTINGS` for the light edition's. The phone face's Settings reads
`LIGHT_SETTINGS` directly, because it *is* the light edition. A chord for a view outside the
edition is **inert** — the digits do not move between editions.

- **The light app never stands on a view outside its edition, and two things hold it.** A page
  asks the shell `useReaches(view)` (`src/lib/reach.ts`) and hides a control whose only job is to
  go somewhere this window does not draw — the collection's *Open a shared collection* is the
  first. And `useDesktopPlace` refuses any store move onto such a view: the store goes back to
  the URL's place and history is not touched.
- **`Ctrl+Shift+N` is the full edition's alone.** In the light edition the press is left to
  whatever owns the window — in a browser, its own private-window chord.
- **`F1` is left to the browser on purpose.** The map's only mount is the caption row, which this
  edition does not draw, and mounting it elsewhere is not worth it yet: its catalogue lists chords
  the edition makes inert.
- **In Chrome the page sees `Ctrl+1…9` first, and the tab switcher runs only for the ones it
  leaves alone** (measured 2026-10-04, step 5.4, light-app.md §9.4 — this said the digits were
  the tab switcher's *before* the page saw them, which was a guess). The chords the edition
  takes on the desktop face — 2, 4, 5, 6, 7 — move the app and switch no tab; the inert ones —
  1, 3, 8, 9 — and every digit on the phone face, which binds none, switch tabs. `F1` reaches
  the page, which leaves it alone, and Chrome opens a tab of its own; `Ctrl+Shift+N` never
  reaches the page. **What that does not
  establish**: the keys were injected over the DevTools protocol into headless Chrome 154, so
  not a real keyboard in a window with a tab strip, not Firefox or Safari, and not an installed
  window, which has no tabs. No key map was built on it.

## What the phone face may import

Anything in `src/` whose import graph does not reach `@/lib/store`, `@/App`,
`@/components/{AppShell,TitleBar,Ribbon}`, `@/boot/*`, `@/lib/window`, or a `@tauri-apps/*` module
other than through `@/lib/core`. **`phone/fence.test.ts`'s first arm walks the graph from every
file under `mobile/phone/` and enforces it.**

- **It reads every way a module is reached**: `from`, a bare `import`, `import("…")`, a
  root-absolute specifier, and `import.meta.glob`, which is an import of every file it matches. An
  `import()` of anything but a literal is **refused** — what it loads is decided at runtime — and
  comments are stripped by a pass that knows a string and a regex from code, so a comment opener
  inside one cannot swallow the imports below it.
- **A refusal prints the whole trail**, from the phone file to the thing it reached, because the
  offending edge is usually between two files in `src/` and the last hop alone does not say
  which phone file has to change. **Do not weaken the fence to make it pass.**
- **When the phone face wants a component that reaches the store, change the component to take
  props, in `src/`** — so both faces gain. Do not copy it. **`components/CardTile` is the first
  such piece**: the one composition of a card and its chin, drawn by the phone wall
  (`phone/CardWall.tsx`) and by `share/ShareTile`.
- **In practice** that is the presentational components, `ipc.ts` and its types, the TypeScript
  domain logic, **and the desktop's own data hooks** — `useCardSearch`, `useDecks`,
  `useCollection` and `useWishlist` are all clean, and the phone pages call them rather than
  writing a second query for the same list.
- **A type-only import is not an edge.** `lib/edition.ts` and `components/nav.ts` import `ViewId`
  from the store as a type, which costs nothing at runtime. An inline `import { type X }` *is*
  counted, conservatively — write `import type` for an import that should carry no edge.
- **Tests and `phone/testing.tsx` are exempt, by name.** The harness installs a fake world and
  reaches the Storybook fake on purpose — which also makes it a dead end to the walk, so a real
  file that imports it is reported as an import the fence could not follow.
- **Files in `mobile/` outside `phone/` are not under this arm** — `LightApp` reads `@/boot`'s
  gate, `DesktopFace` mounts `@/App`, `useDesktopPlace` writes the store; hosting the desktop face
  is their job. They are under the other arm like everything else here.

## Navigation is the URL

`routes.ts` is the one grammar and the one place the two faces agree on a spelling: a view, a
deck under Decks, `?folder=<id>` on the deck gallery, and `?card=<id>` over any of them. **The
folder is the phone's alone** — the desktop gallery keeps its drawer in the page, so the desktop
face neither reads nor writes it, and a crossing drops it like any other filter state. It is an
optional field of `Place`, absent rather than `null` at the top level, so every place spelled
before it is still whole. `parsePlace` is total — a path that names nothing opens on the start
view — and `placeHref` is the only thing that spells a place out.

- **The phone face has its own router**, `phone/router.ts`, hand-written over the History API with
  no dependency: `usePlace`, `navigate`, `back`, `linkTo`.
- **The desktop face keeps its store, and `useDesktopPlace.ts` is the one adapter** between that
  store's three fields and the URL — which is why no router enters `src/`.

**On the desktop face** — `useDesktopPlace.test.ts` holds each of these, and the adapter says the
failure behind each at its own site:

- **One press writes one history entry.** The first place change in a task pushes; any later one
  in the same task rewrites that entry. The wishlist's open-a-deck press makes two store writes —
  the view, then the deck — and between them the store stands on the gallery or on whichever deck
  was parked, a place the reader never chose and Back would have stopped on. **A task is a run of
  synchronous code, whoever started it**: two "presses" back to back in one test body, or in one
  CDP script, are one press, and the second is replaced rather than pushed.
- **A card is written with `replaceState`, never pushed.** There it is a modal over a page, so it
  is written onto the entry it was opened over; opening and closing one must not grow history, or
  Back would reopen a card the reader closed. **The entry is marked `OVERLAID`** (`routes.ts`), so
  the phone face can tell this card from one a reader arrived on by a link.
- **A card the phone face pushed is closed with a Back, not a replace.** Its entry carries the
  phone router's `PUSHED`, which promises the same page directly beneath; renamed instead, one
  place had two entries and the next Back showed nothing. A step to another card keeps the mark.
- **A store move onto a view the edition does not draw is refused** — see *The edition* above.
- **The open card crosses the 1024px floor in both directions.** It is in the grammar, both faces
  read it, and the phone's sheet asks under the desktop modal's own query key — so the face a
  resize draws paints the card from the cache.
- **A `popstate` is followed without writing history.** Moving the store *to* the URL takes up to
  three writes, and the places between them are ones the URL never named; written back, they
  bury the entry the reader just went back to.
- **A refused history write is swallowed, and a refused _push_ is still owed.** Browsers ration
  the History API — one throws, another drops the call — and the write is made from inside the
  store's own `set`: a throw there cuts off every subscriber registered after the adapter. A
  refused replace costs a URL one step stale, which the next accepted write puts right. A refused
  push costs an entry, so the adapter remembers it and makes the next write *as* the push,
  whatever kind it would have been — otherwise a card opened over the new page renamed the entry
  the reader had left. The refusal is read off the address, since a dropped call throws nothing.
- **The URL wins over the stored start view.** `mobile:tauri` shares the desktop's database,
  whose stored view may be one the light rail has no row for, so the URL is seeded as a press.

**On the phone face:**

- **A control that changes the URL is a real link, not a button** — `<a {...linkTo(place)}>`, with
  a real `href`, so a middle click, "open in new tab" and "copy link" work and a screen reader
  hears *link*. The router takes **only an unmodified primary click that nothing else has
  handled**; every other press is the browser's. The tabs, the Settings control, a deck's cover
  and a folder's row in the gallery, a folder's way up and a deck's way back to it are all
  links. **A card tile is not**, and neither is a card's row on a deck page: a card opens a sheet
  over the page it is on, and `CardTile`'s control is a button by design.
- **A card is a place here, and opening one is a push** — which is what lets Android's back
  gesture close the sheet. The two faces differ on this on purpose: a sheet over a phone page is
  something a reader leaves with Back, a modal over a desktop page is not.
- **Closing the sheet leaves no Back step that reopens it.** The ✕, Escape and the scrim go
  through `back(fallback)`: a real Back when the entry beneath is one this router pushed (it marks
  its own entries in history state), and a replace when it is not — a reader who arrived on the
  card's own link has nothing of the app's beneath them, and a Back there would leave it. Closing
  by pushing again left the card one Back beneath the page it was closed over.
- **A desktop overlay is taken over as the phone face mounts** (`adoptOverlay`): the entry is split
  into the page and a marked push of the card, without moving the address bar, so Back closes a
  sheet the desktop face opened. An unmarked card — a link — is left to `back`'s rule above.
- **The history marks live in `routes.ts`, both faces read them, and their promise is one
  sentence**: an entry marked `PUSHED` that carries a card has the same place without the card
  directly beneath it. Neither face may write a card onto a marked page.

- **A step to another printing of the open card is a link that _replaces_** —
  `linkTo(place, { replace: true })`. The sheet is one place however many printings the reader
  steps through, so Back closes it from whichever printing they ended on; the replaced entry keeps
  this router's mark, so the ✕ still leaves by a real Back. `CardSheet.test.tsx` holds it.
- **`navigate` does nothing for the place the reader is already on, asked of the place and not of
  the string**: `/` is the start view without spelling it, and a press on the lit tab must not
  push `/search` over it.
- **A write the browser refuses does not strand the reader, and the place is held rather than
  written some other way** (step 5.4). The router keeps the place in memory, tells its listeners
  and draws it; the next write the browser takes, or the next Back, puts the address in step
  again. **Not a fallback to a replace**: the ration is one counter for both verbs, and a replace
  that was taken would rename the entry beneath — the page under an open card — and break
  `PUSHED`'s promise. Leaving a held place is forgetting it, unless the browser's own entry is a
  pushed card over the same page — a step between printings was the write refused — where the
  real Back is still the right close. A hold ends with the address it was made over: a
  traversal ends it, and so does a write the desktop face made after a crossing.
- **A card is pushed over its own page or not at all.** A page that was only held has no entry,
  so a card the browser *did* take would have sat, marked, on whatever the reader had left — and
  ✕ would go back past the page they were on. The router writes the page first where the
  browser's entry is not it, and the card only once that landed. A held page a reader leaves by
  some other push is not paid back: Back's path is then one page short.
- **`back()` waits a bounded time for its Back** (`BACK_WAIT_MS`). Its one release was the
  `popstate`, so a `history.back()` the browser dropped left ✕ and Escape inert; when the wait is
  up and the reader is still where they pressed, the entry is renamed instead, as a linked card's
  is. `router.test.ts` holds both, with the refusal thrown and dropped.

## Running it

| Command | Backend | Use it for |
| --- | --- | --- |
| `npm run mobile:dev` | The Storybook fake, by the aliases Storybook uses | UI work in any browser. No Rust, **no lock**. `?art=live` draws real pictures |
| `npm run mobile:tauri` | The real Rust core and the dev database | The same UI against a real corpus, in a 412 × 915 window |
| `npm run mobile:build` | — | `tsc`, then the bundle into `dist-mobile/` |
| `npm run mobile:android` | **The light app's Android host** (`src-tauri/` here) and its own data folder on the device | `tauri android dev` on a phone over `adb` — needs JDK 21, the Android SDK and NDK, which no machine of this repo's has yet; CI's `android` job builds the APK instead |
| `npm run web:wasm` | — | The engine as a WASM module into `dist-wasm/` (`scripts/build-wasm.mjs`). Needs clang 18 or newer and the `wasm-bindgen` CLI at the version `Cargo.lock` resolves; minutes, cold. **Run it before any of the three below** |
| `npm run web:dev` | **The web host**: the real engine in a Worker, its databases in this browser's OPFS | The web app in a browser on port 5176 — driven in Chrome only so far. No Rust process, **no lock**. A `web:wasm` beside a running server is picked up by a reload. **Registers no service worker, so it draws no card picture** — `web:preview` does |
| `npm run web:build` | — | `tsc`, the Worker's and the service worker's own `tsc` programs, then the bundle into `dist-web/` with the engine under `wasm/<build id>/` — and last, `sw.js` at its root, built from the list of what was just written. Fails, in a sentence, when `dist-wasm/` is not built |
| `npm run web:preview` | The same engine, from `dist-web/` | The built app on port 4176, where a missing file is a 404 as on a real host and `sw.js` is served `no-cache`. **The one command here that runs the service worker**: pictures, the offline shell, the update bar |
| `npm run web:smoke` | The same engine, in headless Chromium | The built app opened over CDP as an **offline first run**: every request the engine and the service worker make is answered from `scripts/web-smoke/`, and the checks in the script's header run over it — the card sync, the feeds, the picker, a card picture, a reload with the server gone, a waiting build and its press, and a second tab's refusal among them. `CHROME` names the browser; otherwise the first of Chrome and Edge found installed |

- **`mobile:tauri` is the desktop binary with a config overlay** (`src-tauri/tauri.light.conf.json`):
  it **takes the `app` lock** and reads `src-tauri/target/debug/data`. Read the `running-the-app`
  skill first. Widen the window past 1024 and the face changes.
- **`mobile:dev` and `mobile:serve` both use port 5175**, so those two cannot run at once —
  `mobile:tauri` starts its own with `mobile:serve`, which is `mobile:dev` without the fake.
  **`web:dev` is on 5176**, so the web app can be up beside either. (This said *both dev servers
  use port 5175* while there were two.)
- **Fake mode has no startup gate**: the fake answers no `startup_status`, and the gate reads a
  rejected ask as *still loading*, so gating there would wait for ever. It also installs one
  world, `starter`, once, before React.
- **`verify` bundles the light app** (`vite build --config vite.mobile.config.ts`, since phase 4:
  the Android host's `tauri-build` reads `dist-mobile/`), and CI's `android` job bundles it into
  the APK. CI's `rust` job stubs `dist-mobile/index.html` instead, as it stubs `dist/`.
- **`verify` does not build the web app.** Its `npm run build` type-checks the Worker's program
  and the service worker's (`tsc -p tsconfig.web-worker.json`, `tsc -p tsconfig.web-sw.json`)
  and `cargo test --workspace` runs the web host's native tests; the module, `dist-web/`, its
  `sw.js` and the smoke run are CI's `web` job, and yours by hand.

## Tests

`mobile/**/*.test.{ts,tsx}` runs in the one Vitest suite.

- **jsdom has no layout engine, so any test that _mounts_ a card wall calls `installLayout()`
  first** (`phone/testing.tsx`) — not only one that goes on to expect tiles. Every element
  measures 0 there, a virtualised wall draws no row at all, and a test asserting something is
  *absent* from the wall then passes over a wall that is simply empty. A wall in a test stays
  unmeasured and draws two columns.
- **`renderPhone` runs the Storybook fake under the real `ipc.ts`**, so a phone test exercises
  the hand-written mirror too. The file calling it mocks Tauri's three API modules with the
  fake's **in the test file itself** — a `vi.mock` is hoisted per file — and calls it from inside
  a test, which is what unmounts the world afterwards. **Never mock `@/lib/images`.**
- **An empty container means the tree crashed, not that it is slow.** A throw in a render or an
  effect unwinds React to nothing; a longer timeout waits on a tree that is not coming. Look for
  the error.
- **`src/lib/layers.test.ts`, `src/lib/motion.test.ts` and `src/lib/tokens.test.ts` read `mobile/`
  too**, so a z-index here comes from `LAYER`, a text field here wears no press recipe, and the
  token sweeps hold here as in `src/`: no retired colour class, no transition without its
  reduced-motion opt-out, neither `motion` API the shipped CSP disables. **`tokens.test.ts` counts
  one `MotionConfig` per face** — `App.tsx`'s and `phone/PhoneApp.tsx`'s — so a third, in a page or
  a sheet, is refused. [`src/CLAUDE.md`](../src/CLAUDE.md) has each rule.
- **Phone UI is storied where it lives**: Storybook's story glob, `.storybook/preview.css`'s
  Tailwind sources and `src/stories.test.tsx`'s module glob all reach `mobile/`, so a
  `phone/X.stories.tsx` is in the catalogue and its `play` runs in the suite. Box a story to a phone
  (`Shell.stories.tsx` is 360 wide, with an 800px story beside it) and swallow link presses in the
  decorator — a tab is a real link, and a press would move the workbench's own frame. A wall's item
  over a fixture printing is `wallItem` in `.storybook/fake/fixtures.ts`. `mobile:dev` is still
  the workbench for a whole page over the fake.

## Not here yet

- **Every destination has its page, and the owner waived the built-options round for phase 3**
  (2026-10-03): each page is the implementer's pick, to be redirected in review. A page added
  later goes back to the spec's rule — built options first, under the `frontend-design` skill.
- **Scanner is a placeholder**: a sentence, no camera and no permission asked. Settings is the
  light edition's groups as rows, each opening the desktop's own panels beneath it (step 3.7).
- **The Collection and the Wishlist are cabinets** (`phone/ShelfWall.tsx`, `pages/CollectionPage.tsx`,
  `pages/WishlistPage.tsx`): headed shelves laid out from the counts, folded by a press that
  stores the fold as the desktop does (step 3.5b), a folder opened as a level with a path row out,
  a deck's managed wishlist as a read with a link to its deck, and 3.1's sheet over each list's own
  hook (`CabinetFilters`). **Search has its filters** (`phone/search/
  FiltersSheet.tsx`): the box and a `Filters` button on one line, the stated filters under it,
  and everything else in a sheet that is page state rather than a place in the URL.
- **The phone face imports and exports a deck and the collection** (step 3.6, light-app.md §7.6):
  phone sheets over the desktop's own parse, plan, preview, commit and writers — the split
  modules are `useImportSource`, `useExportModel` and the `*PreviewBody` steps — with the
  remembered choices in `phone/transfer/prefs.ts`, which opens on `@/features/transfer/prefs` as
  the app store does. `phone/transfer/CollectionTransfer.tsx` sits in the collection's figures
  band, and the deck gallery's foot offers **New deck** (the desktop's `CreateDeckDialog`) and
  **From a list** (the import sheet over `NewDeckPreviewBody`), each filing the deck in the open
  folder and landing on its page (light-app.md §8.6). The wishlist's is not built.
- **The phone face writes decks, the collection, the wishlist and Settings** — each through the
  desktop's own mutation, never a second copy of one. Deck writes (step 3.5a, light-app.md §7.5) go
  through `useDeckCore` — `useDeck` without the app store — and a receipt's undo is the desktop's
  (`useDeckUndo`), only where the backend journals one. The collection's and the wishlist's entry
  writes and the card sheet's adds (step 3.5b, §7.5b) go through the store-free modules split out of
  the desktop pages (`useCollectionEntryWrites`, `useWishEntryWrites`, `useCopyWrites`,
  `useCardAdds`); a tile's `⋯` opens a sheet, **a tile of several rows asks which copy and every
  write addresses one row**, a managed wish has no `⋯`, a removal offers the desktop's `bulk_undo`
  ticket back, and an add's `Undo` is the stepper one copy back. Settings' panels make the desktop's
  own writes. **Not yet**: folder management, a copy's purchase price, the deck tokens band's and
  stats band's writes.
- **The web host opens its database, answers commands and builds its corpus** (phase 5, steps
  5.1 and 5.2, 2026-10-04 — *The web host* below): the launch's downloads run in a browser, so
  a web install has cards after its first run. **Its service worker is built** (step 5.3 —
  *The web host* below): the shell precached, card pictures answered on the app's own origin
  from Cache Storage, and a newer build held until the reader takes it. **The manifest and its
  icons** are in `mobile/public/`, the light builds' own public directory since step 5.4, so no
  other build carries them; `scripts/light-icons.mjs` renders the icons from the mark, and
  **there is no install button**: a browser's own install UI is the install. Nothing is hosted.
- **No device sync on a light install**: the phone face pairs with nothing. **It does hear the
  host's card sync and the feeds** — `phone/cardData.ts`'s `useCardDataWatch`, mounted once in
  `PhoneFace`, runs the desktop shell's own listeners (`useSyncInvalidation`, the feed hooks) and
  draws the loudest running job on the mana line; an empty card search says *No cards match.*
  only over a database that has cards (`phone/search/NoCards.tsx`). Over the fake no sync event
  comes, so the line rests; the web host has sent them since step 5.2, when it began to download.
  `mobile:tauri` is the desktop binary, not a light host.

## The Android host — `src-tauri/` here

A second Tauri project over `grimoire-core` (phase 4; [light-app.md](../docs/reference/light-app.md)
§8). It is the workspace's third member and holds almost nothing: the mobile entry point, **one
command, `core_call`**, which forwards every call to `grimoire_core::dispatch`, the startup gate,
and the `mtgimg` protocol over the core's `images::answer`.

- **The transport is chosen below `@/lib/core` by a mark the host sets**, `window.__GRIMOIRE_CORE__`
  — `src/lib/core/index.ts`'s `pickCore` reads it, and nothing here may (the fence's second arm).
  The page is the same program on both hosts; only how a call crosses differs.
- **A command the core's table does not have is refused on Android in the table's words.** The
  desktop answers through its typed wrappers, so a page that works in `mobile:tauri` can still be
  refused on a phone until its command joins `crates/grimoire-core/src/commands.rs`.
- **`gen/android` is committed and hand-edited, and a re-init reverts every edit** (spec §5):
  `allowBackup="false"`, the camera declared and not required, no TV launcher, the `FileProvider`
  narrowed to `cache/exports/`, a release build signed with the debug key, and Gradle's Rust task
  calling `npm run tauri:light` (`cd mobile && tauri`) — `npm run tauri` starts the CLI at the
  repository root, where it finds the desktop's project. **`host.test.ts`
  holds each one** — run it after any `tauri android init`, and put the edits back rather than
  deleting the assertion. Regenerate from `mobile/`, never the repository root: the CLI picks the
  project by the directory it starts in, and from the root it finds the desktop's.
- **Three plugins, and the page is granted one of them, narrowly** (step 4.3): `dialog` and `fs`
  answer the desktop's `export_save_file` and `import_pick_file` inside `core_call`
  (`src-tauri/src/files.rs` here) — the system's save dialog and picker, a `content://` document
  opened by the fs plugin, and no URI ever crossing to the page — and `opener` takes every
  `http(s)` link that is not one of the app's pages to the system browser (`navigation.rs`'s
  guard), so a deck note's link never replaces the app. **`capabilities/light.json` holds three
  permissions**: `core:default`, and `opener:allow-open-url` with `opener:allow-default-urls` —
  the desktop's exact pair, never `opener:default` — because a press that leaves the app goes
  through `@tauri-apps/plugin-opener` from the page on this host, by `@/lib/core`'s `host`
  (step 5.4): the desktop face's `Open on …` on a tablet past 1024px, and *Connect Patreon* on
  both faces. No clipboard permission, because the host has no clipboard plugin: a copy is the
  WebView's own `navigator.clipboard`, **which no device has been seen to grant**. No `dialog:`
  or `fs:` permission: both are used from Rust only. `host.test.ts` holds the list. (This said
  the file *stays `core:default` alone*, which the file and that test had both left behind.)
- **The launch's downloads wait on a metered link** (step 4.4): the host asks Android over JNI
  whether the network is metered and, unless the reader said *always*, holds every launch
  download. `DownloadsPrompt.tsx`, which `LightApp` mounts above both faces, asks the host's
  `light_downloads` and draws only when it says it is holding — so a host without the command
  draws nothing, and the page never asks where it runs. Not now is the default and sends nothing.
- **The insets are the host's**: `MainActivity.kt` pads the content view by the system bars, the
  cutout and the keyboard, draws light icons on both bars, and the window's ground behind them is
  the web manifest's colour (`themes.xml`, `colors.xml`). **The last back is the host's too**: a
  callback `MainActivity` registers ahead of Tauri's moves the task to the back instead of letting
  the activity finish, and on Android `RunEvent::Exit` ends the process with `_exit` — tao's
  `std::process::exit` ran static destructors under live framework threads and aborted on a real
  phone (light-app.md §8.6). `host.test.ts` holds all of it.
- **Never commit a keystore.** `src-tauri/.gitignore` here ignores `*.jks` and `*.keystore`, and
  `gen/android`'s own ignores `key.properties`. Signing is undecided (Markus, 2026-10-03: a
  debug-signed APK until a real phone has run it).
- **The host also runs on a desktop**, as a debugging aid: `cargo run -p grimoire-light` after
  `npm run mobile:build`, over a `light-data` folder beside the binary — never the desktop app's,
  which shares its identifier. It does not take the `app` lock and does not need it, because it
  opens a different folder; it still shares nothing with a running desktop app.

## The web host — none of it is here

`grimoire-core` as a WASM module in a dedicated Worker (phase 5;
[light-app.md](../docs/reference/light-app.md) §9). The crate is `crates/grimoire-web`, with
[a `CLAUDE.md` of its own](../crates/grimoire-web/CLAUDE.md), and the page's half is
`src/lib/core/web/` — **below `@/lib/core`, which is the only reason a file under `mobile/` can
stay ignorant of it.** The page is the Android app's program; `dist-web/` is the light entry
built in the `web` mode.

- **The Worker owns the one connection.** OPFS's synchronous access handles exist only off the
  main thread and the pool SQLite sits on permits one connection, so every read and every write
  of the web app queues through that Worker. Nothing on the page opens a database, and nothing
  here constructs a Worker.
- **The page loads the engine once**, whatever mounts above it: `webCore` is a module singleton
  that makes one Worker on the first call or subscription — StrictMode's second mount and a
  face crossing find it made — and the Worker memoises the module's load and its `open`. Two
  instances of the module in one Worker corrupt each other's heap; round one lost two first
  runs in three to it.
- **The startup gate is one gate on every host.** `LightApp` reads `@/boot/useStartup` as it
  does on Android; in the web build the status is answered on the page, from what the Worker
  reported. A call made before the database is open waits rather than being refused.
- **The gate can close again, once, and only this host closes it.** A Worker that dies after
  the database opened moves the startup status from `ready` to `failed` with `reload: true`
  and says so on `startup:changed`; `useStartup` keeps its listener after `ready` for exactly
  that, and `LightApp` then draws `BootScreen` — the sentence and the Reload link — *in place
  of* the faces, the face's boundary and everything mounted beside them. From a trap until a
  reload there is no app behind the page, and that is one fact for the whole window: left to
  each hook, it was a first-run bar that never moved again and walls that stopped answering.
  Never back to `ready`, never twice, and never from a gate that had already failed for a
  reason of its own. The desktop and Android say nothing after `ready`, so nothing changes
  for them.
- **A second tab is told so by the startup status the host answers** —
  `{ state: "failed", message, reload: true }` — and by nothing a page detects. `reload` is a
  host saying that a fresh document may find things different: a second tab (the first holds
  the database, and may since have closed), an engine that never loaded, one that stopped. A
  database that would not open carries none, and neither native host ever sends it.
- **`BootScreen` may draw `ReloadLink` for it, because that is drawn from what the host
  answered** — the rule above (*Nothing here asks where it is running*), kept rather than bent.
  Never offer the reload from a test of the page's surroundings. `ReloadLink` is a link to
  where the reader already is, not a button calling `location.reload()`, and `FaceBoundary`
  draws the same one.
- **A command the table lacks is refused in the table's words, as on Android**, and a refusal
  is a bare string on every host. `DownloadsPrompt` draws nothing here for that reason: this
  host has no `light_downloads`.
- **What a browser did with its storage is asked of the host, and only this host answers**
  (step 5.2; `src/lib/core/hostStorage.ts` has the three commands and their shapes). A browser
  lends its storage and can take it back while the page still opens, so the web host answers
  `storage_cleared`, `storage_cleared_dismiss` and `storage_persistence` **on the page, without
  the engine**, as it answers `startup_status`. `StorageNotice.tsx`, which `LightApp` mounts
  after both faces, asks the first once and draws only an answer — `DownloadsPrompt`'s
  arrangement — and **the sentences are the host's own**, as a startup failure's are, so
  nothing under `mobile/` says what kind of host it is drawn on. The Android host and the
  desktop refuse the name, which is nothing to draw.
  - **Found by the folder, not by a count of cards.** The Worker asks whether OPFS already
    held the database's folder *before* the engine opens it (opening creates one), and the
    page compares that with a mark it keeps in `localStorage`: a mark and no folder is storage
    cleared under the app. An empty card table has other causes — a download still running, a
    corpus the engine replaced, a reader who cleared the card data — and none of them took a
    collection with it.
  - **Not a modal, and drawn on the first-run screen's rung** (`LAYER.gate`), last in the
    document: at 1024px and wider an empty card database is the desktop face's full-window
    first-run screen, and equal rungs paint in document order. A `Dialog` is a rung below
    that screen and would be hidden for the whole download it explains.
  - **A clearing is recorded by the open that saw it, even one that then failed.** The pool's
    install makes the folder before anything can fail, so the launch after a failed one looks
    ordinary; the occurrence waits in `localStorage` for a launch that can draw it.
  - **`persist()` is asked when the database has opened, and again no more than once a week
    while the answer is no** — a yes is final. That departs from the spec's "asked once" on
    purpose: Chromium decides at the call, so a first visit's `false`, recorded for good,
    stopped the app asking after an install. Each launch reads `persisted()` first, which asks
    nobody. What was said is in `localStorage` with the day it was last asked — on the console
    beside the open's line, and read back by `storage_persistence`. Nothing reads it to decide
    anything, and nothing reads `estimate()` at all. No Settings row draws it yet.
- **The marketplace picker is drawn from the host's answer too**: `MarketplaceFeedStatus.reachable`
  is `false` for a feed the host cannot ask (Mana Pool in a browser), the row is greyed and says
  why, and `useMarketplace` quotes the fallback for a stored choice it cannot ask without
  writing the choice away. Both faces' Settings draw that one panel.
- **To run it**: `npm run web:wasm` once (and again after any Rust change), then `web:dev` for
  the dev server, or `web:build` and then `web:smoke` or `web:preview` for the built app. None
  takes a lock. The *Running it* table has each.
- **A web install builds its corpus** (step 5.2): a `ready` open starts the card sync and then
  each feed in turn, on every launch, and one first run against the real hosts is measured in
  [light-app.md](../docs/reference/light-app.md) §9.2. **Not there yet**, each with the step
  that owns it in [the plan](../docs/superpowers/plans/2026-10-04-light-app-phase-5.md): no
  hosting (5.5); no sync (phase 6).
- **The service worker is the web host's, and nothing here names it** (step 5.3;
  `src/lib/core/web/sw/`, registered by the page's half of the web core in a built app and
  never by the dev server). What a page sees of it is three things, each through the seam:
  - **A card picture's address is the app's own origin** — `src/lib/images.ts`'s `imageOrigin`
    answers `<origin>/mtgimg` in the `web` build, by the build's mode, so no call site
    changed. The worker answers it from Cache Storage, asking the engine where the picture is
    *through the page* (`card_image_source`; a service worker cannot reach the database
    Worker). A refusal is the desktop protocol's — 502, 503, 404 — so `useImageRetry` and
    `CardImage`'s watchdog heal it as they heal the desktop's. **Only a raster image is ever
    kept or served there** — a 200 that declares anything else, or has no bytes, is a 502 —
    and the address answers an `<img>` or a script, never a navigation.
  - **A newer build waits, and the host says so.** `UpdateNotice.tsx`, which `LightApp` mounts
    beside the faces, asks `host_update` and listens for `host-update:changed`
    (`src/lib/core/hostUpdate.ts`), and draws only an answer, in the host's words —
    `StorageNotice`'s arrangement. Only its press (`host_update_apply`) tells the waiting
    build to take over; a reload does not, and a second tab does not. The Android host and
    the desktop refuse the names, which is nothing to draw. **These are not the desktop's
    `update_status` and `update_apply`**, which are its own updater's. The bar is drawn on
    `LAYER.header` — under any menu, picker or dialog a reader opened — and its *Not now*
    puts it away until the host next says a build is waiting, or the next load; the press is
    refused in a sentence when nothing waits, and only the page that holds the database
    starts again when the new build takes over.
  - **Settings' *Clear cache* empties the pictures.** The web core answers `cache_clear` on
    the page, from Cache Storage, in the shape the panel already reads; no panel was forked.
  - **A first visit is claimed, not reloaded**: the worker takes the open page over when it
    first activates, and a picture asked for before that is a 404 the frame's retry heals.
    **A hard reload starts a page no worker controls**, by the browser's own rule; the page
    asks the active worker to take it, and it does (driven in Chrome, 2026-10-04).
- **The desktop face's file dialogs are answered on the page** (step 5.4): `export_save_file` is
  a download and `import_pick_file` a hidden `<input type="file">`, in front of the Worker
  (`src/lib/core/web/files.ts`), in the desktop commands' own result shapes — so
  `src/features/transfer/files.ts` and both dialogs are unchanged. A save answers `true` for
  *handed to the browser*, which is honest only because `ExportDialog` draws no sentence from it.
  The clipboard and a link out are a browser's own there (*Nothing here asks where it is
  running*, above), and light-app.md §9.4 has what was driven.
- **What the storage notice was shown to do, and what it was not.** Driven in Chromium on
  2026-10-04, in a dev build, by removing the database's OPFS folder by hand between two
  loads: the notice was drawn, survived a reload and went on its button. **No browser has
  been seen to evict**, which cannot be produced on demand — so that a real eviction leaves
  `localStorage` standing, as the hand-made one did, is an assumption. Where a browser clears
  the mark *with* OPFS the app is a first run again and says nothing.
