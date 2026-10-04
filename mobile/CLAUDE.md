# mobile — the light app

A second app surface sharing the core `src/` components and Rust engine: card search, decks, collection, wishlist, and scanner, targeting Android and web browsers (see [the light-app spec](../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md), [frontend-architecture.md](../docs/reference/frontend-architecture.md), [grimoire-web.md](../docs/reference/grimoire-web.md), and [light-app.md](../docs/reference/light-app.md)).

"Light" refers to the menu and presentation face, never the underlying data. It executes the same commands against the same SQLite databases (`user.db` and `corpus.db`).

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../docs/agent/WORKFLOW.md)
- [Code Style](../docs/agent/CODE_STYLE.md)
- [Verification Guide](../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. One Entry, Two Faces

`LightApp` dynamically selects an interface face based strictly on viewport width:

| Viewport | Face | Implementation |
| --- | --- | --- |
| ≥ 1024px (`DESKTOP_FLOOR_PX`) | **Desktop Face** | `src/`, hosted via `DesktopFace.tsx` (`LIGHT_EDITION`) |
| < 1024px | **Phone Face** | `mobile/phone/` |

- **Single media query**: Face selection occurs solely in `useFace.ts` (`matchMedia(DESKTOP_FLOOR_PX)`). Components in `src/` never make top-level face decisions.
- **Lazy loading**: Each face is an independent lazy chunk; a phone never loads desktop deck editor chunks, and desktop viewports never load mobile sheets.
- **Crossing behavior**: Dragging across 1024px unmounts the previous face and mounts the new one. Both faces share a single `queryClient` (`@/lib/query`), so cached card and collection data persist. Active navigation place and open card survive; local uncontrolled text inputs and filter sheet states reset.
- **Phone layout breakpoints**: Under the phone face, the bottom tab bar transitions to a side rail at ≥ 600px (`TabBar.tsx`) for landscape phones and small tablets.
- **Failure boundary**: `FaceBoundary` isolates render crashes to the active face, presenting a reload option without blanking the host shell.

---

## 2. Platform Fence: "Nothing Asks Where It Is Running"

The Android app and the Web app share identical client-side code; the phone face is strictly one face (1:1 feature parity).

- **Automated enforcement**: `phone/fence.test.ts` sweeps all `.ts`, `.tsx`, `.css`, and `.html` under `mobile/` (including comments) for platform probes: `userAgent`, `userAgentData`, `navigator.platform`, `isTauri`, `__TAURI`, `isAndroid`, `isWebTarget`, `display-mode`, and `@tauri-apps/plugin-os`.
- **Compile-time flags allowed**: `import.meta.env.MODE === "fake"` and `=== "web"` are build-level configurations, not platform runtime probes.
- **Platform abstraction below `@/lib/core`**:
  - File saving/picking: `@/lib/core/files` handles Android native file dialogs and browser file downloads/pickers without leaking OS-specific paths.
  - Clipboard & links: `@/lib/clipboard` (`copyText`) and `@/lib/externalLinks` (`openExternal`). Controls leaving the app prefer semantic `<a target="_blank">` links where supported.
  - Insets and gestures: Handled transparently by the host shell (Android paddings/cutouts or CSS `env(safe-area-inset-*)`).

---

## 3. Edition and Import Boundaries

### The Edition Model
- Defined in `src/lib/edition.ts`. `DesktopFace` injects `LIGHT_EDITION`; phone Settings reads `LIGHT_SETTINGS`.
- Chords and views outside the edition are inert.
- Navigation guard: `useReaches(view)` hides unreachable options, and `useDesktopPlace` rejects programmatic moves outside the edition.

### The Phone Import Fence
`phone/fence.test.ts` verifies that `mobile/phone/` never imports:
- `@/lib/store`, `@/App`, `@/components/{AppShell,TitleBar,Ribbon}`, `@/boot/*`, `@/lib/window`, or `@tauri-apps/*` (except via `@/lib/core`).
- When a phone component needs state from a desktop store-backed component, refactor the desktop component in `src/` to accept props rather than duplicating code.
- Clean hooks (`useCardSearch`, `useDecks`, `useCollection`, `useWishlist`) and presentational components in `src/` are shared.
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

### Android Host (`src-tauri/` in light mode)
- Workspace member with minimal footprint: mobile entry, `core_call` IPC forwarding to `grimoire_core::dispatch`, `mtgimg` image protocol, and the launch's background tasks.
- `gen/android/` configuration is pinned and validated by `host.test.ts` (backup disabled, camera optional, `cache/exports/` FileProvider).
- Scoped capabilities in `capabilities/light.json`: `core:default`, `opener:allow-open-url`, and `opener:allow-default-urls`.
- Metered network check: Launches hold heavy card downloads until user confirms or unmetered Wi-Fi is available.
- Ships from the release tag, with the desktop and the web app: `release.yml` builds the APK as CI does (debug-signed), and a job that holds the release key and builds nothing re-signs it (`scripts/android-sign.sh`). The Gradle project reads no keystore — never add a signing config or a `keystore.properties` to `gen/android`. `src-tauri/release-signer.sha256` (absent until the owner makes the key) is the public fingerprint every release's signer is held to: never regenerate or replace it without the owner (`host.test.ts`; [ci-and-releases.md](../docs/reference/ci-and-releases.md), "The release rule").
- Live sync: `start()` spawns the core's connection manager (`grimoire_core::sync_engine::live::run`) after `startup::settle`, with the write wake `open()` registered as the state's one `WriteObserver`. It opens no socket until the device is in a sync group; `sync:live` and `sync:applied` reach the page through `PageEvents`, and `sync_live_state` is answered by the core's table. There is no push on exit (Android gives the host no hook to await one in): the loop's 3 s write debounce pushes, and anything unpushed goes with the next launch's first trip.

### Web Worker Host (`crates/grimoire-web`)
- Runs `grimoire-core` in WebAssembly inside a dedicated Web Worker using OPFS storage; see [`crates/grimoire-web/CLAUDE.md`](../crates/grimoire-web/CLAUDE.md).
- Singleton Worker instance initialized lazily by `webCore`.
- Second-tab protection via Web Locks (`mtg-grimoire:database`).
- Service Worker handles shell precaching and card picture caching in Cache Storage via the app origin (`/mtgimg`).
- Shipped under strict Content Security Policy (`style-src 'self'`). No runtime `<style>` tags or unauthorized `motion` APIs allowed.

---

## 6. Running, Testing, and Verification

Run tests only at the end of a feature (not after each change):

| Command | Environment | Purpose |
| --- | --- | --- |
| `npm run mobile:dev` | Vite (port 5175) | Fast UI development over Storybook fake data |
| `npm run mobile:tauri` | Desktop Tauri overlay | Run mobile UI against real Rust engine (takes app lock) |
| `npm run mobile:build` | Production bundler | Type-checks and builds `dist-mobile/` bundle |
| `npm run web:wasm` | Rust toolchain | Compile WASM engine into `dist-wasm/` |
| `npm run web:dev` | Vite (port 5176) | Run web light app over local OPFS |
| `npm run web:preview` | Local preview (port 4176) | Test production web build and Service Worker under CSP |
| `npm run web:smoke` | Headless Chromium | Offline first-run and data verification smoke tests |

Test requirements:
- `mobile/**/*.test.{ts,tsx}` executes in the Vitest suite.
- Tests mounting virtualized card walls must call `installLayout()` (`phone/testing.tsx`) to supply mock dimensions in jsdom.
- Commits must match feature size (one commit per feature), cleanly grouping implementation, tests, and documentation for `release-please`.
