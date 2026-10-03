# mobile — the light app

A second app over the same `src/` components and the same Rust core: card search, decks,
collection, wishlist and scanner, for Android and for browsers. The design is
[the light-app spec](../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md);
read its §3 before changing anything here.

**Light is the menu and the face, never the data.** A light install runs the same commands
against the same two databases. What it leaves out is destinations.

**What is here is phase 1, the skeleton.** Every rule below is held by a jsdom test or by
construction, and what was actually driven on 2026-10-01 — a browser over the fake, and the
`mobile:tauri` window over the real core — is in [light-app.md](../docs/reference/light-app.md),
with the date, the build and the width of each figure.

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
  offline, or a deploy that renamed it before a resize crossed the floor — is the ordinary way
  to need it.

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
- **`import.meta.env.MODE === "fake"` is not a probe.** It is which *build* this is, replaced at
  compile time, and it is how `main.tsx` keeps the Storybook fake out of a production bundle.
- **What differs between two installs lives below `@/lib/core`** (spec §3.5): how a command is
  called, how a file is picked, where a card image is served from. The one user-agent read the
  phone face's graph reaches today is that seam's own — `src/lib/images.ts`'s `imageOrigin`,
  which picks a URL's origin and decides nothing a page draws.
- **What only one host has arrives from the host, in a form both understand**: Android's back
  gesture as History navigation, a cutout as the `env()` safe-area insets — the phone shell's bars
  paint to the screen's edges and inset their content, and the page between them is inset on the
  sides. Never a banner one install draws and the other does not.

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
  the edition makes inert, and in a browser tab the digit chords it would teach are, in most
  browsers, the tab switcher's before the page sees them (not measured here). The light edition's
  keyboard story is the web host's (phase 5).

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
- **A refused history write is swallowed.** Browsers ration the History API and the write is made
  from inside the store's own `set`: a throw there cuts off every subscriber registered after
  the adapter. The URL is one step stale and the next write the browser accepts puts it right.
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

## Running it

| Command | Backend | Use it for |
| --- | --- | --- |
| `npm run mobile:dev` | The Storybook fake, by the aliases Storybook uses | UI work in any browser. No Rust, **no lock**. `?art=live` draws real pictures |
| `npm run mobile:tauri` | The real Rust core and the dev database | The same UI against a real corpus, in a 412 × 915 window |
| `npm run mobile:build` | — | `tsc`, then the bundle into `dist-mobile/` |

- **`mobile:tauri` is the desktop binary with a config overlay** (`src-tauri/tauri.light.conf.json`):
  it **takes the `app` lock** and reads `src-tauri/target/debug/data`. Read the `running-the-app`
  skill first. Widen the window past 1024 and the face changes.
- **Both dev servers use port 5175**, so they cannot run at once — `mobile:tauri` starts its own
  with `mobile:serve`, which is `mobile:dev` without the fake.
- **Fake mode has no startup gate**: the fake answers no `startup_status`, and the gate reads a
  rejected ask as *still loading*, so gating there would wait for ever. It also installs one
  world, `starter`, once, before React.
- **Neither `verify` nor CI runs `mobile:build`**, like `share:build`. `mobile/` is in
  `tsconfig.json`'s `include`, so `npm run build` type-checks it; nothing bundles it.

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

- **The phone pages are a skeleton.** Each real page — the filters sheet, the card sheet, the two
  cabinets, the deck editor — comes to the owner as built options before it is built, in phase 3,
  under the `frontend-design` skill like all UI here.
- **Scanner is a placeholder**: a sentence, no camera and no permission asked. Settings is the
  light edition's groups as rows, each opening the desktop's own panels beneath it (step 3.7).
- **The Collection and Wishlist walls draw open shelves only** — the desktop hooks fetch the
  cards of the shelves the reader has left open, and the wall draws them as one run with no
  heading, no fold and no way into a folder. **Search has its filters** (`phone/search/
  FiltersSheet.tsx`): the box and a `Filters` button on one line, the stated filters under it,
  and everything else in a sheet that is page state rather than a place in the URL.
- **Nothing on the phone face writes except Settings**, whose panels make the desktop's own writes
  (a marketplace, a clear, a label) through the commands the desktop calls.
- **No Android host, no WASM host, no service worker** — `public/light.webmanifest` is the whole
  of the PWA so far — **and no sync on a light install**: the phone face runs none and draws the
  mana line at rest. `mobile:tauri` is the desktop binary, not a light host.
