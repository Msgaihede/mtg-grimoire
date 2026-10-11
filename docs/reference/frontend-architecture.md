# Frontend Architecture & Conventions

General architectural patterns, component invariants, and host boundaries across the React frontend in `packages/ui/`.

Styling tokens, themes, and CSS layer conventions are documented in [frontend-design.md](frontend-design.md);
animation and motion constraints are in [motion.md](motion.md).

---

## The `CardImage` Component Invariant

Card artwork across the app must always be rendered via `components/CardImage`, never with a bare `<img>` element.

- **Mandatory Keying**: `CardImage` must explicitly key its internal image element on its image URL:
  ```tsx
  <img key={imageUrl} src={imageUrl} ... />
  ```
- **The Problem**: Browsers keep displaying the previous image's decoded bitmap until the newly assigned `src` finishes downloading and decoding. In virtualized card lists and grid views, DOM elements correspond to reusable *slots* rather than persistent cards. Without keying on the URL, rapidly scrolling or switching card selections causes the previous card's art to visibly linger and flash on screen.

---

## Context Menu Architecture (`packages/ui/components/menu/`)

Right-click context menus are owned by a single root provider:

1. **Root-Level Mounting**:
   - `ContextMenuProvider` wraps the app in `App.tsx` and renders the menu container as a **direct sibling of `AppShell`**.
   - Menus are assigned `LAYER.popup` z-index over a view, and `LAYER.menuOverDialog` when the element they were opened from is inside a `role="dialog"` (`menuLayer` in `ContextMenu.tsx`). A root-mounted menu is a sibling of every dialog's scrim, so at `popup` a menu opened from the card detail modal painted behind it (issue #846).
2. **Escaping Stacking Contexts**:
   - CSS properties such as `transform`, `filter`, `perspective`, and `contain` create new CSS stacking contexts.
   - Mounting menus inside nested component trees causes their `z-index` to be trapped within the local stacking context, resulting in menus being clipped by overflow containers or rendered behind dialog scrims.
3. **Usage Pattern**:
   - Components declare a `MenuItem[]` array and invoke `useContextMenu({ items })`.
   - Components own no custom popup markup or portal containers.

---

## IPC Mirroring & Text Verification

- **Mirror Maintenance**: TypeScript interfaces in `packages/ui/lib/ipc.ts` mirror Rust DTOs by hand.
- **One module, thirteen files** (issue #557, 2026-10-11): `ipc.ts` is a barrel. The interfaces and wrappers live in `packages/ui/lib/ipc/<domain>.ts`, each domain exporting a `<domain>Commands` object that the barrel spreads into `ipc`; the transport (`invoke`, `asciiJson`, `ipcError`) is `ipc/invoke.ts`. The barrel re-exports every type with `export type *` and values by name, so a commands object never reaches a page except as part of `ipc`.
  - Everything outside the mirror imports `@/lib/ipc` — the seam `vi.mock("@/lib/ipc", …)` replaces in 140-odd suites. ESLint refuses `@/lib/ipc/*` and a relative path into the folder.
  - `ipc.test.ts` reads the barrel and every domain file (a glob) as one text, and fails on a method two domains both define (a spread would keep the last silently) and on a domain the barrel does not re-export.
  - A new command goes in its domain's object; a new domain is a file in `ipc/`, one `export type *` line and one spread in the barrel.
- **Verification Fence (`ipc.test.ts`)**:
  - `ipc.test.ts` uses Vite's `?raw` import to load Rust `.rs` files as text.
  - It parses struct definitions and compares field names and casing against the TypeScript mirror to catch drift at test time before runtime serialization errors occur.

---

## Store-Free Transfer Logic (`packages/ui/features/transfer/`)

File import and export machinery is strictly segregated:

1. **Pure TypeScript Core**:
   - Decklist parsers, format planners, and text serializers must remain pure TypeScript functions.
   - They **must not import Zustand stores** (such as `useAppStore`).
   - Keeping the transfer core store-free allows it to be reused without modification across the desktop app, the mobile phone face, Storybook fakes, and headless unit tests.
2. **File Handle Abstraction (`files.ts`)**:
   - Desktop and Android: File operations invoke native backend dialog commands (`import_pick_file`, `export_save_file`).
   - Web App: File operations fall back to browser file input elements and downloads.

---

## Light App Dual-Face & Reachability Architecture

When running the light app (`apps/light/`):

1. **`useFace` Single Evaluation**:
   - The UI entry point evaluates `DESKTOP_FLOOR_PX` via `matchMedia` exactly once in `useFace.ts`.
   - Feature views and nested components must never query window dimensions or media queries to determine face layout.
2. **Feature Reachability (`useReaches`)**:
   - The light app exposes different feature sets depending on host capabilities.
   - Navigation links and action triggers use `useReaches(view)` from `packages/ui/lib/reach.ts` to hide controls pointing to views that are unsupported on that edition.
3. **Routing Model**:
   - Phone Face: Driven by a lightweight, zero-dependency History API router in `apps/light/phone/router.ts` (`usePlace`, `navigate`, `back`).
   - Desktop Face: Driven by the Zustand application store adapted to URL query parameters via `useDesktopPlace.ts`.

---

## IPC Rejections Have One Shape

Hosts used to disagree about what a refused command rejects with: Tauri hands back the Rust command's `Err(String)`, the web host's Worker and the Android table a string too, the fake core an `Error`, and a transport fault whatever it likes. `DeckHistoryDialog` read `error instanceof Error && error.message`, which passed under the fake and on the shipped desktop always replaced the real Rust sentence with a generic one (issue #557).

- `invoke` in `ipc.ts` now runs every rejection through `ipcError`, so an `ipc.*` wrapper **always rejects with a plain string** — the contract the crates already keep, a value the scanner and the light app compare to their sentence constants with `===`, and one that renders as a React child where an `Error` would throw.
- Render an IPC failure with `ipcError(e)`; it still handles the other shapes, for what does not come through `invoke` (a direct `core.call`, a file read, a `fetch`).

---

## Route-Level Code Splitting

`App.tsx` imports the five everyday views (Home, Search, Collection, Wishlist, Decks) statically and loads the six occasional ones — Scanner, Settings, Tags, Trade, Playtesting, Shared — with `React.lazy`, under one `Suspense` with no fallback around `ActiveView` (inside the shell, so the rail and title bar never blank).

- Measured on 2026-10-11 with `vite build --config apps/desktop/vite.config.ts`: the JavaScript the first page loads (the entry plus its `modulepreload`s) went from 1,966 KiB (591 KiB gzipped) in one file to 1,671 KiB (503 KiB gzipped). `jsQR` is now only in the Settings chunk.
- The light app splits one level higher too: `LightApp.tsx` loads each face as its own chunk, and the desktop face it loads is this `App`.
- `App.test.tsx` reads `App.tsx` as text and fails on a static import of any of the six.
