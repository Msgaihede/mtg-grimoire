# apps/light — the light app

A second app surface sharing the core `packages/ui/` components and Rust engine: card search, decks, collection, wishlist, and scanner, targeting Android and web browsers (see [the light-app spec](../../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md), [frontend-architecture.md](../../docs/reference/frontend-architecture.md), [grimoire-web.md](../../docs/reference/grimoire-web.md), and [light-app.md](../../docs/reference/light-app.md)).

"Light" refers to the menu and presentation face, never the underlying data. It executes the same commands against the same SQLite databases (`user.db` and `corpus.db`).

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. One Entry, Two Faces

`LightApp` dynamically selects an interface face based strictly on viewport width:

| Viewport | Face | Implementation |
| --- | --- | --- |
| ≥ 1024px (`DESKTOP_FLOOR_PX`) | **Desktop Face** | `packages/ui/`, hosted via `DesktopFace.tsx` (`LIGHT_EDITION`) |
| < 1024px | **Phone Face** | `apps/light/phone/` |

- **Single media query**: Face selection occurs solely in `useFace.ts` (`matchMedia(DESKTOP_FLOOR_PX)`). Components in `packages/ui/` never make top-level face decisions.
- **Lazy loading**: Each face is an independent lazy chunk; a phone never loads desktop deck editor chunks, and desktop viewports never load mobile sheets.
- **Crossing behavior**: Dragging across 1024px unmounts the previous face and mounts the new one. Both faces share a single `queryClient` (`@/lib/query`), so cached card and collection data persist. Active navigation place and open card survive; local uncontrolled text inputs and filter sheet states reset.
- **Phone layout breakpoints**: Under the phone face, the bottom tab bar transitions to a side rail at ≥ 600px (`TabBar.tsx`) for landscape phones and small tablets.
- **Failure boundary**: `FaceBoundary` isolates render crashes to the active face, presenting a reload option without blanking the host shell.

---

## 2. Platform Fence: "Nothing Asks Where It Is Running"

The Android app and the Web app share identical client-side code; the phone face is strictly one face (1:1 feature parity).

- **Automated enforcement**: `phone/fence.test.ts` sweeps all `.ts`, `.tsx`, `.css`, and `.html` under `apps/light/` (including comments) for platform probes: `userAgent`, `userAgentData`, `navigator.platform`, `isTauri`, `__TAURI`, `isAndroid`, `isWebTarget`, `display-mode`, and `@tauri-apps/plugin-os`.
- **Compile-time flags allowed**: `import.meta.env.MODE === "fake"` and `=== "web"` are build-level configurations, not platform runtime probes.
- **Platform abstraction below `@/lib/core`**:
  - File saving/picking: `@/lib/core/files` handles Android native file dialogs and browser file downloads/pickers without leaking OS-specific paths.
  - Clipboard & links: `@/lib/clipboard` (`copyText`) and `@/lib/externalLinks` (`openExternal`). Controls leaving the app prefer semantic `<a target="_blank">` links where supported.
  - Insets and gestures: Handled transparently by the host shell (Android paddings/cutouts or CSS `env(safe-area-inset-*)`).
  - Storage the host does not own: `@/lib/core/hostStorage`. A component asks a name (`storage_cleared`, `storage_group_warning`) and draws **the host's own sentences** only if the host answered; a host that owns its folder refuses the name, silently. Never infer the kind of host from an answer, and never word the host's sentence on the page. `StorageNotice` and the Sync panel's warning about cleared site data are both drawn this way.
  - A membership the host does not offer: `@/lib/core/hostMembership`. The Sync panel asks `membership_elsewhere` and, handed a sentence, draws it in place of everything about a membership — the offer, the status line, the claim code. Only the light Tauri host answers (it is the build Google Play distributes, and Play forbids leading a reader to a payment made elsewhere); every other host refuses the name. Never word that sentence on the page, and never add a string under the panel that names Patreon, a membership or a payment without asking what a host that answered should say instead.
- **The face mounts its own listeners**: the phone face has no `AppShell`, so `phone/cardData.ts` (`useCardDataWatch`) mounts the card sync, the feeds, and `sync:applied` (`useDeviceSyncInvalidation(client)`) once for the face. A listener the desktop shell mounts is one this face must mount too, or its lists go stale.

---

## 3. Edition and Import Boundaries

### The Edition Model
- Defined in `packages/ui/lib/edition.ts`. `DesktopFace` injects `LIGHT_EDITION`; phone Settings reads `LIGHT_SETTINGS`.
- Chords and views outside the edition are inert.
- Navigation guard: `useReaches(view)` hides unreachable options, and `useDesktopPlace` rejects programmatic moves outside the edition.
- Capability guard: `usePublishes()` (`packages/ui/lib/reach.ts`, from the edition's `publishes`) is false in the light edition, whose hosts have no `share_*` commands, so the collection's Share half is not drawn there for any membership and `share_list` is never asked.

### The Phone Import Fence
`phone/fence.test.ts` verifies that `apps/light/phone/` never imports:
- `@grimoire/ui/lib/store`, `@grimoire/ui/App`, `@grimoire/ui/components/{AppShell,TitleBar,Ribbon}`, `@grimoire/ui/boot/*`, `@grimoire/ui/lib/window`, or `@tauri-apps/*` (except via `@grimoire/ui/lib/core`).
- When a phone component needs state from a desktop store-backed component, refactor the desktop component in `packages/ui/` to accept props rather than duplicating code.
- Clean hooks (`useCardSearch`, `useDecks`, `useCollection`, `useWishlist`) and presentational components in `packages/ui/` are shared.
- Type imports must always use `import type`.

---

## 4. URL-Driven Navigation & History Model

Navigation grammar is standardized in `routes.ts`: views, decks, `?folder=<id>` (phone only), and `?card=<id>`.

- **Phone Router** (`phone/router.ts`): Hand-written over the HTML5 History API (`usePlace`, `navigate`, `back`, `linkTo`).
- **Semantic links**: Navigation controls must render semantic anchor tags (`<a {...linkTo(place)}>`), preserving standard browser middle-click and tab behaviors.
- **Card modal vs. card sheet**:
  - Desktop: Cards open as modals via `replaceState` (marked `OVERLAID` in history state).
  - Phone: Cards open as bottom sheets via `pushState` (marked `PUSHED`). Back gestures close the sheet.
  - Stepping printings: Replaces the current state (`replace: true`) so Back exits the card rather than stepping back through every printing.
  - Cross-face transitions: When crossing from desktop to phone with an active card modal, `adoptOverlay` splits history so Back cleanly dismisses the sheet.

---

## 5. Host Architectures

### Android Host (`apps/light/src-tauri/`, in light mode)
- Workspace member with minimal footprint: mobile entry, `core_call` IPC forwarding to `grimoire_core::dispatch`, `mtgimg` image protocol, and the launch's background tasks.
- `gen/android/` configuration is pinned and validated by `host.test.ts` (backup disabled, camera optional, `cache/exports/` FileProvider, and the launcher's icon). The icon is rendered from the master mark by `node scripts/light-icons.mjs` and committed; never run `tauri android init` or `tauri icon` over `gen/android` — both put stock art back.
- Scoped capabilities in `capabilities/light.json`: `core:default`, `opener:allow-open-url`, and `opener:allow-default-urls`.
- Metered network check: Launches hold heavy card downloads until user confirms or unmetered Wi-Fi is available.
- Pair-only for sync (`apps/light/src-tauri/src/membership.rs`): answers `membership_elsewhere` with its own sentence, refuses `sync_patreon_begin` and `sync_patreon_claim` before the core's table, and rewords four of the core's sentences wherever they appear in an error, replaces any other sync error that still names a membership with a plain sentence, and rewords the same sentences in the rows Settings → Errors reads (`error_log_list`). `host.test.ts` holds the routing, the names and the sentences; the crate's own tests hold the rewording. A phone gets sync by pairing into a group that has it.
- Ships from the release tag, with the desktop and the web app — **to Google Play, and nowhere else**: `release.yml` builds the bundle as CI does (debug-signed), and a job that holds the owner's upload key and builds nothing re-signs it (`scripts/android-release/sign-bundle.sh`) and leaves it as an artifact he uploads to Play Console. The Gradle project reads no keystore — never add a signing config or a `keystore.properties` to `gen/android`. `src-tauri/release-signer.sha256` (absent until the owner makes the key) is the upload certificate's public fingerprint: never regenerate or replace it without the owner (`host.test.ts`; [ci-and-releases.md](../../docs/reference/ci-and-releases.md), "The release rule").
- Scanner: the scanner's commands — the session's twelve and the two for its files — answer through `core_call` like any other (the core's table, steps 7.3 and 7.4). A camera frame is `core_call { name: "scanner_frame", args: <the desktop's headers, as an object of strings>, body: <the JPEG, base64> }` — `packages/ui/lib/core/table.ts` builds it from the same `ipc.scannerFrame` call the desktop makes — and the core's session judges it on the blocking pool. The host adds nothing for it: no plugin, no capability, no CSP source (the video is a `srcObject`, the frame a canvas `toBlob` read as bytes), and the camera grant is the manifest's `CAMERA` through wry. **The session's three assets are fetched when the reader asks for them** (step 7.4): this host embeds none, so `scanner_assets` answers all three as owed — `card-hashes.bin`, `text-detection.rten`, `text-recognition.rten`, 18.1 MB together — and `packages/ui/features/scanner/ScannerAssets.tsx` draws an offer with that size in place of a path nobody on a phone can reach (on both faces: the desktop face's Scanner page, and the phone's `apps/light/phone/scanner/ScannerDataSlot.tsx`, under its camera). The press calls `scanner_assets_fetch`: the core downloads them from the repository's `scanner-bundle-v<FORMAT_VERSION>` GitHub release into `<app data>/data/scanner/` (the models under `models/`), checks each before it takes its name, reports through `scanner:assets`, and lets its session go so the next frame reads them — no restart. It is a native request, so the webview's CSP does not govern it and the host adds nothing: no plugin, no capability, no command of its own. **Nothing is fetched until that press, and the launch's metered-network hold does not cover it** — the offer states the size and the reader decides. Until the files are there a frame is detected and names nothing. A table call holds the scanner's lease as `scanner::PAGE` — this host has one window. Both faces draw a Scanner over it: the phone's page (§7) and, from 1024px, the desktop's.
- Live sync: `start()` spawns the core's connection manager (`grimoire_core::sync_engine::live::run`) after `startup::settle`, with the write wake `open()` registered as the state's one `WriteObserver`. It opens no socket until the device is in a sync group; `sync:live` and `sync:applied` reach the page through `PageEvents`, and `sync_live_state` is answered by the core's table. There is no push on exit (Android gives the host no hook to await one in): the loop's 3 s write debounce pushes, and anything unpushed goes with the next launch's first trip.

### Web Worker Host (`crates/grimoire-web`)
- Runs `grimoire-core` in WebAssembly inside a dedicated Web Worker using OPFS storage; see [`crates/grimoire-web/CLAUDE.md`](../../crates/grimoire-web/CLAUDE.md).
- Singleton Worker instance initialized lazily by `webCore`.
- Second-tab protection via Web Locks (`mtg-grimoire:database`).
- Service Worker handles shell precaching and card picture caching in Cache Storage via the app origin (`/mtgimg`).
- One document is not the app: `apps/light/public/privacy.html`, the privacy policy, served at `/privacy`. It runs no script and loads one stylesheet; the service worker answers a navigation to a place whose `.html` it precached with that file (`sw/shell.ts`). `host.test.ts` holds its shape and holds its list of hosts to the web policy's `connect-src` — a new host there owes the page a row.
- Shipped under strict Content Security Policy (`style-src 'self'`). No runtime `<style>` tags or unauthorized `motion` APIs allowed.
- Scanner (step 7.5): **a Worker and a module of its own** — `packages/ui/lib/core/web/scanWorker.ts` over `crates/grimoire-scan`, never the engine's: a panic there ends the instance, a read frame blocks its Worker for a second, and its memory (121 MB with a full corpus) is only given back by ending it. The session's commands (`scanner_status`, `_frame`, `_reset`, `_set_filters`, `_capture`) and the two for its files are **answered on the page, in front of the engine's `Core`** (`web/scanner.ts`, composed in `packages/ui/lib/core/index.ts`), in the core's shapes; the prefs, the tray, its commit and the lease pass through to the engine, which hands the scanner only the labels (`scanner_labels`, bytes transferred; a read it gave up on is a rejection, not an empty corpus). **Neither the module nor any of its three files is fetched before a reader presses Download** — opening the Scanner asks only `/scanner-assets/manifest.json`, for the offer's sizes — and none is precached; with no file in the store no Worker is made and a frame is refused in a sentence, a second late. The files come from the app's own origin (a release download sends no CORS header), are kept only whole and hashed (length and SHA-256; the models' digests are the core's, and a browser that cannot hash keeps nothing) in Cache Storage `grimoire-scanner-v1`, which no deploy deletes and *Clear cache* leaves alone; the service worker keeps the module there the first time it is loaded, so a reader who has scanned once scans offline (asking the host only for the manifest and `sw.js`) until a deploy changes the module. **The Worker ends 15 s after the view's `scanner_hold` stops** (`IDLE_MS`), on a trap, and when an ask passes its deadline (30 s a frame, 2 min a load); a build that fails is waited out, 5 s doubling to 60. A browser without WASM SIMD, and a build made without the files, are refused in `packages/ui/lib/core/hostScanner.ts`'s sentences, which the page reads as no scanner at all (`scannerUnavailable`). Never import `web/scanner` statically: it spells a Worker.
- Live sync: the web host runs the core's connection manager too (`host::live_sync`, spawned beside the launch's downloads once `open` has answered), over the engine Worker's own `WebSocket` — the bearer in a sub-protocol, a text `ping`. `sync:live` and `sync:applied` reach the page through the Worker's event path, and both faces hear them. The policy's `connect-src` names the relay twice, `https://` and `wss://`: Chrome refuses the socket under the first alone.

---

## 6. Running, Testing, and Verification

Run tests only at the end of a feature (not after each change):

| Command | Environment | Purpose |
| --- | --- | --- |
| `pnpm mobile:dev` | Vite (port 5175) | Fast UI development over Storybook fake data |
| `pnpm mobile:tauri` | Desktop Tauri overlay | Run mobile UI against real Rust engine (takes app lock) |
| `pnpm mobile:build` | Production bundler | Type-checks and builds `apps/light/dist-mobile/` bundle |
| `pnpm web:wasm` | Rust toolchain | Compile WASM engine into `dist-wasm/` |
| `pnpm web:dev` | Vite (port 5176) | Run web light app over local OPFS |
| `pnpm web:preview` | Local preview (port 4176) | Test production web build and Service Worker under CSP |
| `pnpm web:smoke` | Headless Chromium | Offline first-run and data verification smoke tests |
| `pnpm web:scanner-smoke` | Headless Chromium, a file for a camera | The built app scans one real card on the desktop face — the offer, Download, the tray, the collection, then offline, a staged fault, and the Worker gone on leaving — and again on the phone face at 360px in a profile of its own (`pnpm scanner:assets --web` before `web:build`, and after `web:wasm`, which empties `dist-wasm/`; the card's picture comes from Scryfall once, or `SCAN_CARD_PICTURE`) |
| `pnpm web:sync-smoke` | Two headless Chromiums, the relay under workerd | A claim, a pairing and a write crossing each way without a press — the phone face and the desktop face (needs a wrangler; the script's header says where it looks) |
| `pnpm mobile:scanner-smoke` | Headless Chromium, a fake camera, `mobile:dev` | The phone's Scanner page at 360 and 412: cards land, a quantity, a folder, Add, the camera let go, each refusal (`scripts/phone-scanner-smoke.mjs`; another origin after the script's name, `--shots=<dir>` for pictures) |

Driving a shared panel at a phone's width (no lock needed, `mobile:dev` only):
- `http://localhost:5175/settings?seed=paired&fault=lentStorage` — `?seed=` and `?fault=` are a story's `parameters.fake`, read once by `fakeBoot.ts`.
- `pnpm mobile:scan-smoke` (`scripts/pairing-scan-smoke.mjs`; another origin after the script's name) — headless Chromium with a fake camera fed the Sync panel's own QR code at 360px: the drawing decodes, the scanner calls `sync_pairing_accept`, a refused camera lands on typing. The camera *grant* (Android's prompt, a browser's) is a real device's to show.
- Measure under a touch pointer (`Emulation.setTouchEmulationEnabled`): the shared panels take their 44px floor from `coarse:`, which a mouse-driven window never matches.

- The Scanner page is driven the same way: over the fake a camera that opens is answered by a scripted pile of five cards (`packages/fake/scannerScript.ts`), so `http://localhost:5175/scanner` in a browser with a camera scans. `?fault=scannerMissing` and `?fault=scannerElsewhere` are its two refusals.

Test requirements:
- `apps/light/**/*.test.{ts,tsx}` executes in the Vitest suite.
- A test that walks through `/scanner` meets a jsdom with no `navigator.mediaDevices`: the page must mount there without a throw or a console line. A test *about* the camera stubs `mediaDevices`, the `<video>`'s pixels and the canvas (`pages/ScannerPage.test.tsx`), and paces its `scanner_frame` answers — an answer already settled starves every timer in the file.
- Tests mounting virtualized card walls must call `installLayout()` (`phone/testing.tsx`) to supply mock dimensions in jsdom.
- Commits must match feature size (one commit per feature), cleanly grouping implementation, tests, and documentation for `release-please`.

---

## 7. The Scanner Page (`phone/pages/ScannerPage.tsx`, `phone/scanner/`)

The desktop reader's parts in the phone's idioms ([card-scanner.md](../../docs/reference/card-scanner.md), *On the phone face*).

- **Everything that decides is `packages/ui/features/scanner`'s, imported** — `useCamera`, `useScanLoop`, `useTray`, `useScannerPrefs`, `useScannerHold`, `useTrayLanding`, `useTrayFolder`/`useTrayCommit`, `useScannerStatus`, `usePageParked`, the `reader/tray.ts` reducers and the sentences. A rule the phone needs that still lives inside the desktop page is **moved out and shared**, never written twice.
- **Never import** `useWindowParked` (the window), `ScannerPanels`/`panels/*` or `AllPrintingsDialog` (the store), or the desktop `ScannerPage`. `TrayPanel` and `ScanBar` pass the fence but are built for a pointer: the phone draws `scanner/Tray.tsx` and `scanner/ScanControls.tsx` + `OptionsSheet.tsx` over the same reducers and words.
- **The tray and the prefs are the desktop face's rows too.** The phone sends `previews: false` whatever `prefs.developer` says and never writes that switch or `trayLayout`.
- **The desktop page's rules hold**: the camera stays shut until the prefs load, the loop off until the prefs and the tray have; every tray writer builds on `tray.latest()`; a commit and a clear subtract a snapshot.
- **A phone parks itself**: hidden, the pump stops at once and the camera and the heartbeat after `PARK_GRACE_MS`; a page that *mounts* hidden opens no camera; leaving the page stops every track.
- **A host with no session** (`useScannerPrefs`' `unavailable`, a web page until step 7.5): both gates hang on `loaded`, which never goes true there. The page draws the engine's sentence in `CameraBox`, no status line or Reset, and refuses the filters; the tray still works.
- **A refusal is words on the page, never a tooltip**: under Add (and its `aria-describedby`), on a sheet row's second line, over the picture. A live region stays mounted and is filled; it is never mounted with its words inside.
- **A sheet hands the caret back to the press that opened it** on a choice, Escape and the ✕ (`ActionSheet`'s `onDismiss`), not on a scrim press. In the tray the press is found again after the render — a row redrawn by the choice can have replaced it.
- **The two-column arrangement asks the viewport (720px)**, not a container: the page's sheets are mounted inside it, and a container is the containing block for a `fixed` scrim. Not the rail's 600: there the tray's column was 288px and its controls under the floor.
- **`scanner/ScannerDataSlot.tsx` is where the scanner's missing data is offered**: it draws the shared `packages/ui/features/scanner/ScannerAssets.tsx` — the offer with its measured size, a Download at a finger's size, the bar, a failure with a Retry — from what `scanner_assets` answers, and nothing at all (no element) where nothing is owed. The page hands it `onLoaded`: `resync()` and `loop.clearReads()`, for the engine's new session. Change the shared component, not the page.
