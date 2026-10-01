# The light app's skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second browser entry, `mobile/`, that draws the desktop UI with a six-row menu at 1024px and above and a phone-designed face below it, running both in a plain browser over the Storybook fake and in a phone-sized Tauri window over the real Rust core.

**Architecture:** The desktop shell learns one thing — an `Edition` provided at the root — and is otherwise unchanged. `mobile/` is a new Vite entry over the same `src/` components: a light entry that gates on startup, picks a face by viewport width and lazy-loads it. The phone face reuses the desktop's own data hooks (`useCardSearch`, `useDecks`, `useCollection`, `useWishlist`), which a walk of the import graph on 2026-10-01 showed do not reach the desktop store, and draws them with one new shared component, `CardTile`.

**Tech Stack:** React 19, TypeScript 6.0.x, Vite 8, Tailwind v4, TanStack Query 5, `@tanstack/react-virtual` 3 (already a dependency), Vitest 5, Tauri 2.11 (one Rust edit).

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) — §3 and §10. Read both before starting.

## Global Constraints

- **No new npm dependency and no new crate.** Everything here is built from what `package.json` already has.
- **Never install `@types/node`.** TypeScript stays on 6.0.x.
- **The desktop app must be unchanged.** No existing test in `src/components/AppShell.test.tsx`, `src/components/nav.test.ts`, `src/App.test.tsx` or `src/boot/DesktopBoot.test.tsx` may need editing. If one goes red, the change is wrong — fix the change.
- **No platform check in a page.** There is an `Edition` handed to the shell and nothing else; do not add `isWeb()`, `isLight()` or a user-agent test anywhere under `src/`.
- **The phone face is one face on Android and on the web (spec §3, Markus 2026-10-01).** Nothing under `mobile/` asks where it is running: no `navigator.userAgent`/`userAgentData`/`navigator.platform`, no `isTauri`, no `__TAURI`, no `isAndroid`, no `display-mode` query. The face is chosen by viewport width alone. Task 8's fence sweeps `mobile/` for those probes (`mobile/main.tsx`'s `import.meta.env.MODE === "fake"` is a build mode, not a platform, and stays).
- **Files under `mobile/phone/` may not reach `@/lib/store`, `@/App`, `@/components/{AppShell,TitleBar,Ribbon}`, `@/boot/*`, `@/lib/window`, or any `@tauri-apps/*` module except through `@/lib/core`.** Task 8 adds the test that enforces it; write every phone file to pass it from the start.
- **Tailwind scans source text for whole class names.** Never build a class by interpolation; a computed size is an inline `style`.
- **Dim text is `text-dim`, never `text-muted`.** Card art is `CardArt`/`CardImage`, never a bare `<img>`.
- **No `setState` inside an effect body** — `react-hooks/set-state-in-effect` goes red only at `npm run verify`.
- **Ports:** the light dev server is **5175**, `strictPort`. Not 1420 (`tauri dev`), 5174 (share), or 6006 (Storybook).
- **Tests:** each task runs only its own test file with `npx vitest run <path>`. **Nobody runs `npm run verify` or the whole suite inside a task** — that happens once, in Task 9. Only Task 2 runs `cargo`.
- **Commits:** one per task, `feat:`/`test:`/`chore:`/`docs:`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use the PowerShell tool for git; Bash refuses several git forms in a worktree.
- **`npm run mobile:tauri` takes the `app` lock.** Read the `running-the-app` skill before launching it; only one app runs across every worktree.

## Review Focus

1. **A stored start view outside the light edition.** `mobile:tauri` shares the desktop's `user.db`, whose `start_view` may be `home` or `tags`. A reasonable person expects the light app to open on Search, not on a page with no rail row. → Task 5, *"lands on the URL's view even when the stored start view is outside the edition"*.
2. **A URL that names nothing.** `/`, `/nope`, `/decks/abc`, `/decks/` and `/index.html` must all open somewhere sensible rather than throw or draw blank. → Task 5, `parsePlace` cases.
3. **A viewport that crosses 1024px while the app is open.** Resizing a browser window, or rotating a tablet, must swap faces and land on the same destination. → Task 5, *"swaps the face when the viewport crosses the floor"* and *"keeps the destination across the swap"*.
4. **A wishlist row with no printing.** `WishRow.cardId`, `setCode` and `collectorNumber` are all nullable — a wish for *any* printing. The tile must draw "Any printing", not crash on a null spread and not print `null · null`. → Task 7, *"draws a wish for any printing without a set line"*.
5. **A card or deck id that no longer exists.** `/decks/999` and `?card=<gone>` are one stale link away. The page must say so in a sentence and leave Back working. → Task 7, *"says so when the deck is gone"* and *"says so when the card cannot be read"*.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/edition.ts` | The `Edition` type, the two editions, the context, `editionHas` | 1 |
| `src/components/AppShell.tsx` | Reads the edition: rail rows, caption, inert chords | 1 |
| `src-tauri/src/window.rs` | The ladder stands aside for a window configured below the desktop floor | 2 |
| `src-tauri/tauri.light.conf.json` | The `tauri dev` overlay: light dev server, phone-sized framed window | 2 |
| `src/components/CardTile.tsx` | `CardArt` + `CardChin`, the one composition of a card tile | 3 |
| `share/ShareTile.tsx` | Adopts `CardTile` | 3 |
| `vite.mobile.config.ts` | The light entry's build: port, entry rewrite, fake-mode aliases | 4 |
| `mobile/index.html`, `mobile/main.tsx`, `mobile/mobile.css` | The entry, side effects only | 4 |
| `mobile/fakeBoot.ts` | Installs the Storybook fake's world, fake mode only | 4 |
| `public/light.webmanifest` | The web app manifest | 4 |
| `src/boot/useStartup.ts` | The startup gate as a hook, shared by `DesktopBoot` and the light entry | 5 |
| `mobile/routes.ts` | URL ⇄ `Place`, pure | 5 |
| `mobile/useFace.ts` | Viewport width → `"phone" \| "desktop"` | 5 |
| `mobile/useDesktopPlace.ts` | URL ⇄ the desktop store's `activeView`/`openDeckId` | 5 |
| `mobile/DesktopFace.tsx` | `App` under the light edition | 5 |
| `mobile/BootScreen.tsx`, `mobile/LightApp.tsx` | The gate and the face switch | 5 |
| `mobile/phone/router.ts` | `usePlace`, `navigate` over the History API | 6 |
| `mobile/phone/TabBar.tsx`, `Shell.tsx`, `PhoneApp.tsx` | The phone shell and its providers | 6 |
| `mobile/phone/wall.ts`, `CardWall.tsx` | Column arithmetic and the virtualised wall | 6 |
| `mobile/phone/CardSheet.tsx` | A card, over the wall | 7 |
| `mobile/phone/pages/*.tsx` | Search, Decks, Deck, Collection, Wishlist, Scanner, Settings | 7 |
| `mobile/phone/fence.test.ts` | The import-graph fence | 8 |
| `mobile/CLAUDE.md`, root `CLAUDE.md` | The rules, and the row that points at them | 8 |

**Waves.** Tasks 1, 2, 3 and 4 touch disjoint files and can run at once. Task 5 needs 1 and 4. Task 6 needs 3 and 5. Task 7 needs 6. Task 8 needs 7. Task 9 is fan-in.

---

### Task 1: The edition seam

**Files:**
- Create: `src/lib/edition.ts`
- Create: `src/lib/edition.test.ts`
- Modify: `src/components/AppShell.tsx` — the imports, `Shell`'s key handler (~line 255–300), `entries` (~line 424), and the `<TitleBar />` mount (~line 457)
- Test: `src/components/AppShell.test.tsx` — one new `describe` at the end of the file

**Interfaces:**
- Consumes: `ViewId` from `@/lib/store` (type only); `NAV` from `@/components/nav`.
- Produces:
  - `LIGHT_VIEWS: readonly ["search","decks","collection","wishlist","scanner","settings"]`
  - `type LightView = (typeof LIGHT_VIEWS)[number]`
  - `LIGHT_START: LightView` (`"search"`)
  - `interface Edition { id: "full" | "light"; views: readonly ViewId[] | null; caption: boolean; startView: ViewId }`
  - `FULL_EDITION`, `LIGHT_EDITION: Edition`
  - `editionHas(edition: Edition, view: ViewId): boolean`
  - `isLightView(value: string): value is LightView`
  - `EditionContext: React.Context<Edition>` (default `FULL_EDITION`), `useEdition(): Edition`

- [ ] **Step 1: Write the failing unit test**

Create `src/lib/edition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NAV } from "@/components/nav";
import {
  editionHas,
  FULL_EDITION,
  isLightView,
  LIGHT_EDITION,
  LIGHT_START,
  LIGHT_VIEWS,
} from "@/lib/edition";

describe("the two editions", () => {
  it("lets the full edition draw every destination", () => {
    for (const { id } of NAV) expect(editionHas(FULL_EDITION, id)).toBe(true);
  });

  it("gives the light edition six destinations, in the rail's own order", () => {
    // The rail filters `NAV`, so a list written in another order would be a list the rail
    // silently re-sorts — and the phone's tab bar reads this one directly.
    const railOrder = NAV.filter((n) => editionHas(LIGHT_EDITION, n.id)).map((n) => n.id);
    expect(railOrder).toEqual([...LIGHT_VIEWS]);
    expect(railOrder).toEqual(["search", "decks", "collection", "wishlist", "scanner", "settings"]);
  });

  it("keeps the caption for the full edition only", () => {
    expect(FULL_EDITION.caption).toBe(true);
    expect(LIGHT_EDITION.caption).toBe(false);
  });

  it("opens the light edition on a view it draws", () => {
    expect(LIGHT_EDITION.startView).toBe(LIGHT_START);
    expect(editionHas(LIGHT_EDITION, LIGHT_EDITION.startView)).toBe(true);
  });

  it("narrows a word to a light view without walking the prototype", () => {
    expect(isLightView("decks")).toBe(true);
    expect(isLightView("home")).toBe(false);
    expect(isLightView("toString")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/lib/edition.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/edition"`.

- [ ] **Step 3: Write `src/lib/edition.ts`**

```ts
import { createContext, useContext } from "react";
import type { ViewId } from "./store";

/**
 * The destinations the light app draws, in the rail's own order.
 *
 * `satisfies` rather than an annotation: the tuple's literal members are what {@link LightView}
 * is derived from, and a view removed from `ViewId` is a compile error here.
 */
export const LIGHT_VIEWS = [
  "search",
  "decks",
  "collection",
  "wishlist",
  "scanner",
  "settings",
] as const satisfies readonly ViewId[];

export type LightView = (typeof LIGHT_VIEWS)[number];

/** Where a light install opens when the URL names no destination. */
export const LIGHT_START: LightView = "search";

const LIGHT_SET = new Set<string>(LIGHT_VIEWS);

/** A `Set` rather than `in`, which walks the prototype — `useStartView.ts`'s own reason. */
export function isLightView(value: string): value is LightView {
  return LIGHT_SET.has(value);
}

/**
 * Which app this shell is drawing — handed to it once, at the root.
 *
 * **A seam, not a platform check.** Nothing here says where the code is running; it says what to
 * draw. The desktop app provides nothing and gets {@link FULL_EDITION}; the light entry
 * (`mobile/DesktopFace.tsx`) provides {@link LIGHT_EDITION}. A page never reads this — its
 * readers are the shell's rail, its caption and its chords.
 */
export interface Edition {
  id: "full" | "light";
  /** The rail's rows. `null` is every destination `NAV` holds, so the full edition cannot fall
   *  behind a view added to the rail. */
  views: readonly ViewId[] | null;
  /** Whether this window draws its own caption. False wherever a browser or an OS owns the frame. */
  caption: boolean;
  /** The view a URL that names nothing opens on. The full edition's is the store's own default
   *  and nothing reads it there. */
  startView: ViewId;
}

export const FULL_EDITION: Edition = { id: "full", views: null, caption: true, startView: "home" };

export const LIGHT_EDITION: Edition = {
  id: "light",
  views: LIGHT_VIEWS,
  caption: false,
  startView: LIGHT_START,
};

export function editionHas(edition: Edition, view: ViewId): boolean {
  return edition.views === null || edition.views.includes(view);
}

export const EditionContext = createContext<Edition>(FULL_EDITION);

export function useEdition(): Edition {
  return useContext(EditionContext);
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run src/lib/edition.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing shell test**

Append to the end of `src/components/AppShell.test.tsx`. It uses helpers the file already defines — `render`, `noUpdate`, `useAppStore`, `userEvent`, `screen`, `within`, `act` — and adds one import beside the file's other `@/lib` imports:

```ts
import { EditionContext, LIGHT_EDITION } from "@/lib/edition";
```

```tsx
describe("the light edition", () => {
  const renderLight = () =>
    render(
      <EditionContext.Provider value={LIGHT_EDITION}>
        <AppShell update={noUpdate}>
          <div>content</div>
        </AppShell>
      </EditionContext.Provider>,
    );

  const railButtons = () =>
    within(screen.getByRole("navigation", { name: "Views" }))
      .getAllByRole("button")
      .map((b) => b.textContent);

  it("draws six destinations and nothing else", () => {
    renderLight();
    expect(railButtons()).toEqual([
      "Search",
      "Decks",
      "Collection",
      "Wishlist",
      "Scanner",
      "Settings",
      "Collapse",
    ]);
  });

  it("draws no window caption, and the full edition still does", () => {
    // `TitleBar` is the only thing in the shell that carries a drag region, and the attribute
    // does not inherit — so its presence is the caption's presence.
    const { unmount } = renderLight();
    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull();
    unmount();

    render(
      <AppShell update={noUpdate}>
        <div>content</div>
      </AppShell>,
    );
    expect(document.querySelector("[data-tauri-drag-region]")).not.toBeNull();
  });

  it("leaves the digits where they are and makes an out-of-edition chord inert", async () => {
    const user = userEvent.setup();
    renderLight();
    act(() => useAppStore.getState().setActiveView("decks"));

    // Ctrl+1 is Home in every edition. Light has no Home, so the press does nothing —
    // it does not become Search, because a chord's whole value is that it does not move.
    await user.keyboard("{Control>}1{/Control}");
    expect(useAppStore.getState().activeView).toBe("decks");

    // Ctrl+2 is Search in every edition, and light has it.
    await user.keyboard("{Control>}2{/Control}");
    expect(useAppStore.getState().activeView).toBe("search");
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `npx vitest run src/components/AppShell.test.tsx -t "the light edition"`
Expected: FAIL — the rail lists `Home`, `Tagger`, `Trade`, `Playtesting`; the drag region is present; Ctrl+1 moves to Home.

- [ ] **Step 7: Teach the shell its edition**

In `src/components/AppShell.tsx`:

Add the import beside the other `@/lib` imports:

```ts
import { editionHas, useEdition } from "@/lib/edition";
```

At the top of `Shell`, beside `const activeView = …`:

```ts
  // Which app this shell is drawing. A context value that never changes for the life of the
  // window, so naming it in a dependency list below costs nothing.
  const edition = useEdition();
```

In the key handler, directly after `if (i === -1 || i >= CHORD_NAV.length) return;` and **before** `e.preventDefault()`:

```ts
      // **The digits do not move between editions.** A chord for a view this edition does not
      // draw is inert rather than rebound to the next row, for `CHORD_NAV`'s own reason: one
      // press must not mean two things to two readers. Ahead of `preventDefault`, so the press
      // is left to whatever else wants it.
      if (!editionHas(edition, CHORD_NAV[i].id)) return;
```

and change that effect's dependency array from `[setActiveView, setKeyMapOpen]` to `[edition, setActiveView, setKeyMapOpen]`.

Replace the `entries` memo's body and dependencies:

```ts
  const entries = useMemo(
    () =>
      NAV.filter(
        (n) =>
          editionHas(edition, n.id) &&
          (n.id !== "shared" || openedShares.length > 0 || activeView === "shared"),
      ),
    [edition, openedShares.length, activeView],
  );
```

Replace `<TitleBar />` with:

```tsx
      {edition.caption && <TitleBar />}
```

Leave every comment in place. Add one sentence to the comment above the caption: `` `edition.caption` is false wherever a browser or an OS owns the frame — the light entry — and there this row is not drawn at all. ``

- [ ] **Step 8: Run the shell's whole file**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: PASS — the three new tests and every existing one. **If an existing test fails, the edit is wrong.**

- [ ] **Step 9: Commit**

```
git add src/lib/edition.ts src/lib/edition.test.ts src/components/AppShell.tsx src/components/AppShell.test.tsx
git commit -m "feat(shell): an edition decides the rail's rows, the caption and which chords act"
```

---

### Task 2: A phone-sized window for `tauri dev`

**Files:**
- Modify: `src-tauri/src/window.rs` — a new function after `opening_size`, two call sites, two tests
- Create: `src-tauri/tauri.light.conf.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `npm run tauri -- dev --config src-tauri/tauri.light.conf.json` opens a 412 × 915 framed window on `http://localhost:5175`. Task 4 adds the npm script and the server.

- [ ] **Step 1: Write the overlay**

Create `src-tauri/tauri.light.conf.json`. `--config` is a JSON merge patch, and **a merge patch replaces arrays whole**, so the window entry restates every field it needs:

```json
{
  "build": {
    "beforeDevCommand": "npm run mobile:serve",
    "devUrl": "http://localhost:5175"
  },
  "app": {
    "windows": [
      {
        "title": "MTG Grimoire — light",
        "width": 412,
        "height": 915,
        "minWidth": 320,
        "minHeight": 480,
        "visible": false,
        "dragDropEnabled": false,
        "decorations": true,
        "shadow": true
      }
    ]
  }
}
```

`decorations: true` because the light edition draws no caption — without the OS frame there would be no way to move or close the window. `visible: false` and `dragDropEnabled: false` are the main config's own, restated because the array is replaced.

- [ ] **Step 2: Write the failing tests**

In `src-tauri/src/window.rs`, inside `mod tests`, add:

```rust
    /// The light dev window is 412 wide — a phone — and the ladder would resize it to 1280.
    /// A window the config sized below the desktop floor keeps the size it was given.
    #[test]
    fn a_window_configured_below_the_desktop_floor_keeps_its_own_size() {
        assert_eq!(configured_small(412.0, 915.0), Some((412.0, 915.0)));
        assert_eq!(configured_small(1023.0, 700.0), Some((1023.0, 700.0)));
        // At the floor and above, the ladder decides, as it always has.
        assert_eq!(configured_small(1024.0, 700.0), None);
        assert_eq!(configured_small(1920.0, 1080.0), None);
    }

    /// The overlay `npm run mobile:tauri` passes to `tauri dev`. `--config` is a merge patch and
    /// replaces `app.windows` whole, so every field the main config relies on has to be restated
    /// there — `visible: false` above all, because `open_sized_to_monitor` is the only thing
    /// that shows a window.
    #[test]
    fn the_light_overlay_sizes_a_phone_and_names_the_light_dev_server() {
        let overlay: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.light.conf.json")).unwrap();
        let window = &overlay["app"]["windows"][0];
        let size = (
            window["width"].as_f64().unwrap(),
            window["height"].as_f64().unwrap(),
        );
        assert!(configured_small(size.0, size.1).is_some());
        assert_eq!(window["visible"], false);
        assert_eq!(window["dragDropEnabled"], false);
        assert_eq!(window["decorations"], true);
        assert_eq!(overlay["build"]["devUrl"], "http://localhost:5175");
    }
```

- [ ] **Step 3: Implement**

In `src-tauri/src/window.rs`, directly after `opening_size`:

```rust
/// The size a window keeps instead of climbing [`LADDER`]: the config's own, when the config
/// sized it **below the desktop floor**.
///
/// The ladder exists because the desktop UI has two layouts and a monitor decides which fits.
/// A window configured narrower than [`MIN`] is not asking that question — it is the light app's
/// phone-sized dev window (`tauri.light.conf.json`), and resizing it to 1280 would put the phone
/// face in a desktop frame. `None` at the floor and above, where the ladder decides as before.
pub fn configured_small(width: f64, height: f64) -> Option<(f64, f64)> {
    (width < MIN.0).then_some((width, height))
}

/// [`configured_small`] for the config this app was built with. Every window is cloned from the
/// config's first entry ([`open_new`]), so the first entry answers for all of them.
fn config_small(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let app = window.app_handle();
    let first = app.config().app.windows.first()?;
    configured_small(first.width, first.height)
}
```

In `place`, replace `let size = opening_size(room);` with:

```rust
    let size = config_small(window).unwrap_or_else(|| opening_size(room));
```

In `open_sized_to_monitor`, make this the first statement of the body:

```rust
    // A window the config sized below the desktop floor keeps that size: centre it and show it.
    if config_small(window).is_some() {
        let _ = window.center();
        let _ = window.show();
        return;
    }
```

- [ ] **Step 4: Run the module's tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib window::`
Expected: PASS — the two new tests and every existing `window::tests` case. This compiles the crate; allow ten minutes on a cold target. **Run no second `cargo` beside it.**

- [ ] **Step 5: Format and commit**

```
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/window.rs src-tauri/tauri.light.conf.json
git commit -m "feat(window): a window configured below the desktop floor keeps its size"
```

---

### Task 3: `CardTile`, the one composition of a card tile

**Files:**
- Modify: `src/components/CardChin.tsx:25` — export `ChinPrinting`
- Create: `src/components/CardTile.tsx`
- Create: `src/components/CardTile.test.tsx`
- Create: `src/components/CardTile.stories.tsx`
- Modify: `share/ShareTile.tsx` — the `return` only

**Interfaces:**
- Consumes: `CardArt`, `CardChin`, `cardScaleVars`, `DEFAULT_ZOOM`, `FOCUS`, `cn`.
- Produces:

```ts
export interface CardTileProps {
  cardId: string | null;
  name: string;
  /** Absent means the image cache; a present `null` means no picture. Passed through as given. */
  remoteSrc?: string | null;
  finish?: Finish | null;
  rarity: string | null;
  chin: ChinPrinting;
  money?: ReactNode;
  zoom?: number;
  /** Drawn over the art — a count tag, say. */
  overlay?: ReactNode;
  /** Makes the art a button. Absent, the tile is not a control. */
  onPress?: () => void;
  /** The button's accessible name. Defaults to `name`. */
  pressLabel?: string;
  loading?: "eager" | "lazy";
  className?: string;
}
export function CardTile(props: CardTileProps): ReactElement;
```

- [ ] **Step 1: Export the chin's printing type**

In `src/components/CardChin.tsx`, change `type ChinPrinting =` to `export type ChinPrinting =`. Nothing else in that file changes.

- [ ] **Step 2: Write the failing test**

Create `src/components/CardTile.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CardTile } from "@/components/CardTile";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";

const draw = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

const BOLT = {
  cardId: "00000000-0000-0000-0000-000000000001",
  name: "Lightning Bolt",
  rarity: "common",
  chin: { setCode: "lea", collectorNumber: "161" },
} as const;

describe("CardTile", () => {
  it("draws the picture and the printing line under it", () => {
    draw(<CardTile {...BOLT} />);
    expect(screen.getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(screen.getByText(/lea/i)).toBeInTheDocument();
    expect(screen.getByText(/161/)).toBeInTheDocument();
  });

  it("is not a control unless it is given a press", () => {
    draw(<CardTile {...BOLT} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("makes the art a button named for the card, and keeps the chin outside it", async () => {
    const onPress = vi.fn();
    draw(<CardTile {...BOLT} onPress={onPress} pressLabel="Lightning Bolt, LEA 161" />);

    const button = screen.getByRole("button", { name: "Lightning Bolt, LEA 161" });
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    // The chin is a sibling of the card's button, never a child — its text is a fact a screen
    // reader should reach, and a button's label would swallow it.
    expect(button).not.toContainElement(screen.getByText(/161/));
  });

  it("draws a caller's own printing line where there is no set to name", () => {
    draw(
      <CardTile
        cardId={null}
        name="Sol Ring"
        rarity={null}
        chin={{ printing: "Any printing", printingTitle: null }}
      />,
    );
    expect(screen.getByText("Any printing")).toBeInTheDocument();
  });

  it("draws what it is handed over the art", () => {
    draw(<CardTile {...BOLT} overlay={<span>four</span>} />);
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("hands a present null picture through, which is not the same as none given", () => {
    // `remoteSrc` absent asks the image cache; a present `null` says there is no picture.
    // A tile that collapsed the two would ask a browser for `mtgimg://`.
    draw(<CardTile {...BOLT} cardId={null} remoteSrc={null} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run src/components/CardTile.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/CardTile"`.

- [ ] **Step 4: Write `src/components/CardTile.tsx`**

```tsx
import type { ReactElement, ReactNode } from "react";
import { CardArt } from "@/components/CardArt";
import { CardChin, type ChinPrinting } from "@/components/CardChin";
import { cardScaleVars, DEFAULT_ZOOM } from "@/lib/cardZoom";
import type { Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

export interface CardTileProps {
  cardId: string | null;
  name: string;
  /** Absent means the image cache; a present `null` means no picture. Passed through as given —
   *  see `CardArt`'s own prop for why the two are different answers. */
  remoteSrc?: string | null;
  finish?: Finish | null;
  rarity: string | null;
  chin: ChinPrinting;
  money?: ReactNode;
  zoom?: number;
  /** Drawn over the art — a count tag, say. Inside the button when there is one. */
  overlay?: ReactNode;
  /** Makes the art a button. Absent, the tile is not a control at all. */
  onPress?: () => void;
  /** The button's accessible name. Defaults to `name`. */
  pressLabel?: string;
  loading?: "eager" | "lazy";
  className?: string;
}

/**
 * One card, drawn as a tile: the art, and the chin under it.
 *
 * **This is a composition and owns no drawing of its own.** `CardArt` is the frame and `CardChin`
 * the foot; what this file is the one definition of is *how the two are put together* — the scale
 * variables the chin's type reads, the seam between them, and whether the art is a control. It
 * exists because that composition was spelled out separately by every wall that drew a tile, and
 * a second app drawing cards is the point at which two spellings become drift.
 *
 * **The chin is a sibling of the button, never a child of it** — `CardChin`'s own rule. A button's
 * accessible name swallows its contents, and the printing and the price are facts a screen reader
 * should reach.
 *
 * `CardGrid` does not call this yet. It composes the same two components itself, with a selection
 * ring, a quick-add and a drag source this file knows nothing about; folding it in is a change to
 * that file, made when somebody is next in it.
 */
export function CardTile({
  cardId,
  name,
  remoteSrc,
  finish = null,
  rarity,
  chin,
  money,
  zoom = DEFAULT_ZOOM,
  overlay,
  onPress,
  pressLabel,
  loading,
  className,
}: CardTileProps): ReactElement {
  const art = (
    <>
      <CardArt
        cardId={cardId}
        name={name}
        finish={finish}
        loading={loading}
        // Spread only when given: an absent `remoteSrc` and a present `null` are two answers.
        {...(remoteSrc !== undefined ? { remoteSrc } : {})}
      />
      {overlay}
    </>
  );

  return (
    <div className={cn("group flex flex-col", className)} style={cardScaleVars(zoom)}>
      {onPress ? (
        <button
          type="button"
          aria-label={pressLabel ?? name}
          onClick={onPress}
          className={cn("relative block w-full rounded-lg text-left", FOCUS)}
        >
          {art}
        </button>
      ) : (
        <div className="relative">{art}</div>
      )}
      <CardChin {...chin} zoom={zoom} rarity={rarity} finish={finish} money={money} seam="art" />
    </div>
  );
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/components/CardTile.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 6: Adopt it in the share viewer**

In `share/ShareTile.tsx`, replace the two imports of `CardArt` and `CardChin` with:

```ts
import { CardTile } from "@/components/CardTile";
```

and remove `cardScaleVars` from the `@/lib/cardZoom` import (keep `DEFAULT_ZOOM`). Replace the component's `return (...)` with:

```tsx
  return (
    <li className="flex flex-col">
      <CardTile
        cardId={null}
        name={card.n}
        remoteSrc={card.img ?? null}
        finish={marked}
        rarity={null}
        chin={{ setCode: card.s, collectorNumber: card.cn }}
        zoom={DEFAULT_ZOOM}
        // `undefined` rather than `null`: the chin draws no money slot for the first and an em
        // dash for the second, which is precisely the difference between "nobody asked" and
        // "nobody quoted". Both are live states on this page.
        money={showValue ? formatPrice(card.p ?? null, currency) : undefined}
        overlay={
          card.q > 1 ? (
            // Bottom-left. The art's top-right corner is the finish chip's on every wall in this
            // app, and a bare number laid *on* a card is `CountTag` — no `×`.
            <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
              <CountTag count={card.q} title={`${card.q} copies`} />
            </span>
          ) : undefined
        }
      />
      {(showCondition || showLang) && (
        <span className="mt-1 flex items-baseline gap-2 overflow-hidden text-[0.6875rem]">
          {showCondition && <span className="truncate text-dim">{condition}</span>}
          {showLang && (
            <span className="shrink-0 font-mono uppercase text-dim">{card.l ?? NOTHING}</span>
          )}
        </span>
      )}
      <span className="sr-only">
        {card.n}
        {card.q > 1 ? `, ${card.q} copies` : ""}
      </span>
    </li>
  );
```

Keep the component's doc comment; change its opening sentence of the second paragraph to `` **`CardTile` rather than a frame of its own** `` and leave the rest.

- [ ] **Step 7: Run the share viewer's tests, which include its import fence**

Run: `npx vitest run share/`
Expected: PASS. The fence in `share/SharePage.test.tsx` walks into `CardTile.tsx`; it must still find no `@/lib/core`, `@/lib/ipc`, `@/features` or `@tauri-apps/`.

- [ ] **Step 8: Write the story**

Create `src/components/CardTile.stories.tsx`. Before writing it, read one neighbouring story file — `src/components/CountTag.stories.tsx` — and match its conventions (`tags: ["autodocs"]`, the `Meta`/`StoryObj` import path, how it names a fixture card from `.storybook/fake/fixtures`):

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CardTile } from "@/components/CardTile";
import { CountTag } from "@/components/CountTag";
import { CARDS } from "../../.storybook/fake/cards";

const card = CARDS[0];

const meta = {
  title: "Components/CardTile",
  component: CardTile,
  tags: ["autodocs"],
  args: {
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    chin: { setCode: card.setCode, collectorNumber: card.collectorNumber },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 170 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CardTile>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A tile that is not a control — the shared binder's. */
export const Plain: Story = {};

/** A tile whose art is a button — a wall's. */
export const Pressable: Story = {
  args: { onPress: fn(), money: "$1.25" },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: card.name }));
    await expect(args.onPress).toHaveBeenCalledTimes(1);
  },
};

/** A count laid on the art, and a foil copy. */
export const FoilWithCount: Story = {
  args: {
    finish: "foil",
    overlay: (
      <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
        <CountTag count={4} title="4 copies" />
      </span>
    ),
  },
};
```

`CARDS` rows carry `id`, `name`, `rarity`, `setCode` and `collectorNumber` (read on 2026-10-01); that file is generated, so if a name has moved, the file is the authority.

- [ ] **Step 9: Commit**

```
git add src/components/CardChin.tsx src/components/CardTile.tsx src/components/CardTile.test.tsx src/components/CardTile.stories.tsx share/ShareTile.tsx
git commit -m "feat(components): CardTile, the one composition of a card and its chin"
```

---

### Task 4: The light entry and its build

**Files:**
- Create: `vite.mobile.config.ts`, `mobile/index.html`, `mobile/main.tsx`, `mobile/mobile.css`, `mobile/fakeBoot.ts`, `mobile/LightApp.tsx` (a stub Task 5 replaces), `public/light.webmanifest`
- Modify: `tsconfig.json:67` (`include`), `vite.config.ts` (`test.include`), `package.json` (`scripts`), `.gitignore`, `eslint.config.js` (`ignores`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `npm run mobile:dev` — Vite on 5175, **fake mode**: `import.meta.env.MODE === "fake"`, Tauri's three API modules and `@/lib/images` aliased to `.storybook/fake/`.
  - `npm run mobile:serve` — Vite on 5175, real Tauri IPC. What `tauri dev` starts.
  - `npm run mobile:tauri` — `tauri dev` with Task 2's overlay.
  - `npm run mobile:build` — `tsc` then a production build into `dist-mobile/`, with `index.html` at its root.
  - `mobile/LightApp.tsx` exporting `LightApp({ gate }: { gate: boolean })`.

- [ ] **Step 1: Write the Vite config**

Create `vite.mobile.config.ts`:

```ts
import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "./vite.config.ts";

/** The light app's document, from the repository root. */
const ENTRY = "mobile/index.html";

/**
 * Serves the light entry at every path, and puts it at the root of the build.
 *
 * **The root stays the repository root**, for `vite.share.config.ts`'s reason: the base config's
 * `"@": "/src"` alias is root-relative, so `root: "mobile"` would quietly resolve every `@/…`
 * against `mobile/`. With the root where it is, `/` would serve the *desktop's* `index.html` —
 * so a navigation is rewritten to the light document instead, which is also the history
 * fallback the light app's path-based URLs need (`/decks/12` must load the app, not 404).
 */
function lightEntry(): Plugin {
  return {
    name: "light:entry",
    // `post`, because Vite's own `vite:build-html` emits the document in *its* `generateBundle`
    // and an unenforced plugin here would rename a file that has not been emitted yet.
    enforce: "post",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? "/").split("?")[0];
        const navigation =
          req.method === "GET" &&
          String(req.headers.accept ?? "").includes("text/html") &&
          // A file has an extension and a Vite internal starts `/@`; neither is a page.
          !path.includes(".") &&
          !path.startsWith("/@");
        if (navigation) req.url = `/${ENTRY}`;
        next();
      });
    },
    generateBundle(_options, bundle) {
      const html = bundle[ENTRY];
      if (!html) return;
      html.fileName = "index.html";
      delete bundle[ENTRY];
      bundle["index.html"] = html;
    },
  };
}

/**
 * The Storybook fake, under the real `ipc.ts` — the same four aliases `.storybook/main.ts`
 * declares, for the same reason: the fake sits *under* the hand-written mirror, so the light app
 * in a plain browser exercises the mirror too. `mergeConfig` puts these ahead of the base
 * config's `@` alias, and `@/lib/images` has to be tried before that prefix.
 */
const FAKE_ALIASES = [
  { find: /^@tauri-apps\/api\/core$/, replacement: "/.storybook/fake/core.ts" },
  { find: /^@tauri-apps\/api\/event$/, replacement: "/.storybook/fake/event.ts" },
  { find: /^@tauri-apps\/api\/window$/, replacement: "/.storybook/fake/window.ts" },
  { find: /^@\/lib\/images$/, replacement: "/.storybook/fake/images.ts" },
];

export default defineConfig(({ mode }) =>
  mergeConfig(base, {
    plugins: [lightEntry()],
    resolve: mode === "fake" ? { alias: FAKE_ALIASES } : {},
    build: {
      outDir: "dist-mobile",
      emptyOutDir: true,
      rolldownOptions: { input: ENTRY },
    },
    // Not 1420 (`tauri dev`), not 5174 (the share viewer), not 6006 (Storybook).
    server: { port: 5175, strictPort: true },
  }),
);
```

- [ ] **Step 2: Write the entry document and stylesheet**

Create `mobile/index.html`:

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/mtg-grimoire-mark.svg" />
    <link rel="manifest" href="/light.webmanifest" />
    <!-- `viewport-fit=cover` so the phone face can pad its tab bar by the safe-area inset. -->
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <!-- A hex of `--color-bg` (`oklch(0.16 0.01 270)`): a manifest and this tag are read before
         any stylesheet, and not every browser parses `oklch` there. -->
    <meta name="theme-color" content="#0e0f13" />
    <title>MTG Grimoire</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/mobile/main.tsx"></script>
  </body>
</html>
```

Create `mobile/mobile.css`:

```css
/* The light app's stylesheet: the app's own sheet, plus one line.

   `src/index.css` opens with `@import "tailwindcss" source(none)` and names its own sources, and
   its `@source "../src"` resolves against `src/`, which this directory is not under. Without the
   line below every class written under `mobile/` would emit no rule at all, silently — the page
   would draw with the app's tokens and none of its own layout. `share/share.css` is the same file
   for the same reason. */
@import "../src/index.css";
@source "../mobile";
```

Create `public/light.webmanifest`:

```json
{
  "name": "MTG Grimoire",
  "short_name": "Grimoire",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0e0f13",
  "theme_color": "#0e0f13",
  "icons": [
    { "src": "/mtg-grimoire-mark.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

- [ ] **Step 3: Write the fake boot, the entry and a stub app**

Create `mobile/fakeBoot.ts`:

```ts
import { setArtMode } from "../.storybook/fake/images";
import { installWorld } from "../.storybook/fake/world";

/**
 * Stands the Storybook fake's `starter` world up behind the light app — `npm run mobile:dev`.
 *
 * Called once, before React, because the fake answers from whichever world was installed last
 * and a query that fires against an empty dispatch table gets "No fake handler registered".
 * One world for the life of the page: there is no second story to keep it apart from.
 *
 * `?art=live` draws real Scryfall pictures instead of the synthetic frames, for a look that is
 * closer to the shipped app when there is a network to ask.
 */
export function bootFake(): void {
  const world = installWorld({ seed: "starter" });
  world.mount();
  if (new URLSearchParams(window.location.search).get("art") === "live") setArtMode("live");
}
```

Create `mobile/LightApp.tsx` — a stub; Task 5 replaces the body:

```tsx
export function LightApp({ gate }: { gate: boolean }) {
  return (
    <p className="p-6 text-sm text-dim">
      The light app{gate ? "" : " (fake backend)"}.
    </p>
  );
}
```

Create `mobile/main.tsx`:

```tsx
/**
 * The light app's entry point — side effects only.
 *
 * `LightApp` is where the app begins; what is left here is what can only be done to a real
 * document, in the order `src/main.tsx` does it and for its reasons.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { installKeyboardModality } from "@/lib/keyboardModality";
import { installNativeDragGuard } from "@/lib/nativeDrag";
import { LightApp } from "./LightApp";
import "./mobile.css";
// Mana and set glyphs, imported here rather than from the stylesheet so Vite owns them as
// modules and the `woff2IconFonts` plugin can trim their `@font-face` rules.
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

/** `npm run mobile:dev`: the Storybook fake answers every command and there is no Rust. */
const FAKE = import.meta.env.MODE === "fake";

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("mobile/index.html is missing its #root element");

  // Every focus outline is gated on the attribute this keeps on `<html>`.
  installKeyboardModality(window);
  installNativeDragGuard(window);

  // Before React, and a dynamic import so a production build carries none of the fake: Vite
  // replaces `MODE` at build time and the branch is dropped.
  if (FAKE) (await import("./fakeBoot")).bootFake();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {/* The fake does not answer `startup_status` — a story never mounts the boot gate — and a
          gate reads a rejected ask as "still loading". So fake mode has no gate. */}
      <LightApp gate={!FAKE} />
    </React.StrictMode>,
  );
}

void start();
```

- [ ] **Step 4: Wire the configs**

`tsconfig.json` — change `"include": ["src", "share"],` to `"include": ["src", "share", "mobile"],` and extend the comment above it with one paragraph:

```
  // `mobile/` is the light app — a third React entry over the same `src/` components, built by
  // `vite.mobile.config.ts`. In this program for `share/`'s reason: a webview program with no
  // Node in it, resolving `@/*` through the same paths.
```

`vite.config.ts` — in `test.include`, after the `"share/**/*.test.{ts,tsx}",` line, add:

```ts
      // The seventh is the **light app** — `mobile/`, built by `vite.mobile.config.ts`. A React
      // entry like `share/`, with one difference: it has a core, so its tests mock Tauri's API
      // modules with the Storybook fake the way `src/stories.test.tsx` does.
      "mobile/**/*.test.{ts,tsx}",
```

`package.json` — add to `scripts`, after `share:build`:

```json
    "mobile:dev": "vite --config vite.mobile.config.ts --mode fake",
    "mobile:serve": "vite --config vite.mobile.config.ts",
    "mobile:tauri": "tauri dev --config src-tauri/tauri.light.conf.json",
    "mobile:build": "tsc && vite build --config vite.mobile.config.ts",
```

`.gitignore` — after `dist-share/`, add `dist-mobile/`.

`eslint.config.js` — in the first block's `ignores`, after `"dist-share/",`, add:

```js
      // The light app's bundle (`npm run mobile:build`). Generated output like the two above.
      "dist-mobile/",
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. `mobile/fakeBoot.ts` pulls `.storybook/fake/world.ts` into this program, as several `src/` tests already do; if `tsc` reports an error *inside* `.storybook/fake/`, stop and report it rather than editing that directory.

- [ ] **Step 6: See the fake-mode page**

Run in the background: `npm run mobile:dev`
Then open `http://localhost:5175/` and `http://localhost:5175/decks/12` in the built-in browser.
Expected at both: the sentence *"The light app (fake backend)."*, dark background, no console error. `/decks/12` proves the history fallback. Stop the server.

If the page shows the **desktop** app instead, the middleware is not rewriting — check that `lightEntry()` is in `plugins` and that the request carries `Accept: text/html`.

- [ ] **Step 7: See the production build land at the root**

Run: `npm run mobile:build`
Expected: exit 0, and `dist-mobile/index.html` exists while `dist-mobile/mobile/index.html` does not. Confirm with `Test-Path dist-mobile/index.html; Test-Path dist-mobile/mobile/index.html` → `True`, `False`.

- [ ] **Step 8: Commit**

```
git add vite.mobile.config.ts mobile/ public/light.webmanifest tsconfig.json vite.config.ts package.json .gitignore eslint.config.js
git commit -m "feat(light): a second entry, its build, and the fake backend behind it"
```

---

### Task 5: The gate, the routes and the two faces

**Files:**
- Create: `src/boot/useStartup.ts`
- Modify: `src/boot/DesktopBoot.tsx` — the hook's body moves out
- Create: `mobile/routes.ts`, `mobile/routes.test.ts`
- Create: `mobile/useFace.ts`
- Create: `mobile/useDesktopPlace.ts`, `mobile/useDesktopPlace.test.ts`
- Create: `mobile/DesktopFace.tsx`, `mobile/BootScreen.tsx`
- Modify: `mobile/LightApp.tsx` — replace Task 4's stub
- Create: `mobile/LightApp.test.tsx`
- Create: `mobile/phone/PhoneApp.tsx` — a stub Task 6 replaces

**Interfaces:**
- Consumes: Task 1's `LIGHT_EDITION`, `LIGHT_START`, `LIGHT_VIEWS`, `LightView`, `isLightView`, `EditionContext`.
- Produces:
  - `useStartup(enabled?: boolean): StartupStatus` and `STARTUP_POLL_MS` from `@/boot/useStartup`
  - `interface Place { view: LightView; deckId: number | null; cardId: string | null }`
  - `parsePlace(pathname: string, search: string): Place`
  - `placeHref(place: Place): string`
  - `type Face = "phone" | "desktop"`, `faceFor(width: number): Face`, `useFace(): Face`
  - `mobile/phone/PhoneApp.tsx` with a **default export** component taking no props

- [ ] **Step 1: Write the failing route tests**

Create `mobile/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePlace, placeHref } from "./routes";

describe("parsePlace", () => {
  it("reads a destination off the path", () => {
    expect(parsePlace("/collection", "")).toEqual({ view: "collection", deckId: null, cardId: null });
  });

  it("reads an open deck", () => {
    expect(parsePlace("/decks/12", "")).toEqual({ view: "decks", deckId: 12, cardId: null });
  });

  it("reads an open card off the query, over any destination", () => {
    expect(parsePlace("/wishlist", "?card=abc-123")).toEqual({
      view: "wishlist",
      deckId: null,
      cardId: "abc-123",
    });
  });

  it.each([
    ["/", "the root"],
    ["", "an empty path"],
    ["/nope", "a word that is no destination"],
    ["/index.html", "the document's own file name"],
    ["/home", "a desktop destination the light app does not draw"],
  ])("opens on Search for %s (%s)", (path) => {
    expect(parsePlace(path, "").view).toBe("search");
  });

  it.each([["/decks/abc"], ["/decks/"], ["/decks/-3"], ["/decks/1.5"], ["/decks/12abc"]])(
    "opens the gallery, not a deck, for %s",
    (path) => {
      expect(parsePlace(path, "")).toEqual({ view: "decks", deckId: null, cardId: null });
    },
  );

  it("ignores a deck id under a destination that is not Decks", () => {
    expect(parsePlace("/search/12", "").deckId).toBeNull();
  });

  it("reads an empty card parameter as no card", () => {
    expect(parsePlace("/search", "?card=").cardId).toBeNull();
  });
});

describe("placeHref", () => {
  it("round-trips every shape", () => {
    for (const href of ["/search", "/decks", "/decks/12", "/collection?card=abc-123", "/decks/7?card=x"]) {
      const [path, search = ""] = href.split("?");
      expect(placeHref(parsePlace(path, search && `?${search}`))).toBe(href);
    }
  });

  it("escapes a card id, which is not ours to trust", () => {
    expect(placeHref({ view: "search", deckId: null, cardId: "a b&c" })).toBe("/search?card=a%20b%26c");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run mobile/routes.test.ts`
Expected: FAIL — `Failed to resolve import "./routes"`.

- [ ] **Step 3: Write `mobile/routes.ts`**

```ts
import { isLightView, LIGHT_START, type LightView } from "@/lib/edition";

/**
 * Where the reader is, as the URL says it.
 *
 * `/search`, `/decks`, `/decks/12`, `/collection`, `/wishlist`, `/scanner`, `/settings`, and
 * `?card=<id>` over any of them. Pure, and the one place the two faces agree on a spelling: the
 * phone face reads and writes it through its router, and the desktop face through one adapter
 * that maps it onto the store.
 */
export interface Place {
  view: LightView;
  /** The open deck. Only ever non-null while `view` is `"decks"`. */
  deckId: number | null;
  /** The open card, over whatever destination is behind it. */
  cardId: string | null;
}

/** A positive integer and nothing else — `Number("12abc")` is `NaN`, but `Number("1.5")` is not. */
const DECK_ID = /^[1-9]\d*$/;

/** A URL as a {@link Place}. **Total**: a path that names nothing opens on {@link LIGHT_START}. */
export function parsePlace(pathname: string, search: string): Place {
  const [head = "", tail = ""] = pathname.split("/").filter((part) => part.length > 0);
  const view = isLightView(head) ? head : LIGHT_START;
  const deckId = view === "decks" && DECK_ID.test(tail) ? Number(tail) : null;
  const card = new URLSearchParams(search).get("card");
  return { view, deckId, cardId: card !== null && card.length > 0 ? card : null };
}

export function placeHref(place: Place): string {
  const path =
    place.view === "decks" && place.deckId !== null ? `/decks/${place.deckId}` : `/${place.view}`;
  return place.cardId === null ? path : `${path}?card=${encodeURIComponent(place.cardId)}`;
}
```

- [ ] **Step 4: Run the route tests**

Run: `npx vitest run mobile/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Lift the startup gate into a hook**

Create `src/boot/useStartup.ts` by **moving** `STARTUP_POLL_MS`, its doc comment, and the body of `DesktopBoot`'s `useState` + `useEffect` out of `src/boot/DesktopBoot.tsx`. The effect is unchanged except for the `enabled` guard:

```ts
import { useEffect, useState } from "react";
import { ipc, type StartupStatus, type Unlisten } from "@/lib/ipc";

/** (move `STARTUP_POLL_MS`'s existing doc comment here, unchanged) */
export const STARTUP_POLL_MS = 150;

const READY: StartupStatus = { state: "ready" };
const LOADING: StartupStatus = { state: "loading" };

/**
 * Whether the native side has opened the data folder.
 *
 * (move `DesktopBoot`'s doc comment here from "**Why a gate at all.**" to the end, unchanged)
 *
 * **`enabled: false` answers `ready` at once and asks nothing** — for a host with no startup to
 * wait for. The light app's fake mode is the one caller: the Storybook fake answers no
 * `startup_status`, and this hook reads a rejected ask as *still loading*, so gating there would
 * wait for ever.
 */
export function useStartup(enabled: boolean = true): StartupStatus {
  const [status, setStatus] = useState<StartupStatus>(enabled ? LOADING : READY);

  useEffect(() => {
    if (!enabled) return;
    // (the existing effect body, verbatim: `live`, `settled`, `timer`, `unlisten`, `stop`,
    //  `settle`, the `onStartupChanged` subscription, `ask`, and the cleanup)
  }, [enabled]);

  return status;
}
```

Then `src/boot/DesktopBoot.tsx` becomes:

```tsx
import App from "@/App";
import { StartupScreen } from "./StartupScreen";
import { useStartup } from "./useStartup";

// Re-exported: `DesktopBoot.test.tsx` imports it from here.
export { STARTUP_POLL_MS } from "./useStartup";

/**
 * The app's root: nothing that queries is mounted until the native side says the data folder is
 * open. The gate itself is `useStartup`, which the light app's entry shares.
 */
export function DesktopBoot() {
  const status = useStartup();
  if (status.state === "ready") return <App />;
  return <StartupScreen status={status} />;
}
```

Run: `npx vitest run src/boot/`
Expected: PASS with **no edit** to `DesktopBoot.test.tsx`.

- [ ] **Step 6: Write `mobile/useFace.ts`**

```ts
import { useSyncExternalStore } from "react";
import { DESKTOP_FLOOR_PX } from "@/lib/viewports";

export type Face = "phone" | "desktop";

/**
 * The floor the desktop UI is designed and measured down to, and no further.
 *
 * At or above it the light app draws the desktop's own pages; below it, the phone face. The
 * desktop app itself has no viewport branch and must not grow one — this is the light entry's,
 * and it is the only one.
 */
const QUERY = `(min-width: ${DESKTOP_FLOOR_PX}px)`;

export function faceFor(width: number): Face {
  return width >= DESKTOP_FLOOR_PX ? "desktop" : "phone";
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const read = (): Face => (window.matchMedia(QUERY).matches ? "desktop" : "phone");

/** Which face the viewport's width asks for, kept current as the width changes. */
export function useFace(): Face {
  return useSyncExternalStore(subscribe, read, (): Face => "phone");
}
```

- [ ] **Step 7: Write the failing desktop-place tests**

Create `mobile/useDesktopPlace.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/lib/store";
import { useDesktopPlace } from "./useDesktopPlace";

const PRISTINE = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
  window.history.replaceState(null, "", "/");
});

describe("useDesktopPlace", () => {
  it("lands the store on the URL's view before anything is drawn", () => {
    window.history.replaceState(null, "", "/collection");
    renderHook(() => useDesktopPlace());
    expect(useAppStore.getState().activeView).toBe("collection");
  });

  it("opens the URL's deck", () => {
    window.history.replaceState(null, "", "/decks/12");
    renderHook(() => useDesktopPlace());
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(12);
  });

  it("lands on the URL's view even when the stored start view is outside the edition", () => {
    // `mobile:tauri` shares the desktop's `user.db`, whose stored start view may be `home`.
    // The seed counts as a press, so the shell's launch hydration is dropped rather than
    // moving the reader onto a page the light rail has no row for.
    renderHook(() => useDesktopPlace());
    expect(useAppStore.getState().activeView).toBe("search");

    act(() => useAppStore.getState().hydrateStartView("home"));
    expect(useAppStore.getState().activeView).toBe("search");
  });

  it("writes a press on the rail back to the URL", () => {
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(window.location.pathname).toBe("/wishlist");
  });

  it("writes an opened deck back to the URL", () => {
    window.history.replaceState(null, "", "/decks");
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setOpenDeckId(7));
    expect(window.location.pathname).toBe("/decks/7");
  });

  it("follows Back", () => {
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("wishlist"));

    act(() => {
      window.history.replaceState(null, "", "/search");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useAppStore.getState().activeView).toBe("search");
  });

  it("stops listening when the face goes", () => {
    const { unmount } = renderHook(() => useDesktopPlace());
    unmount();
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(window.location.pathname).toBe("/");
  });
});
```

- [ ] **Step 8: Run them to make sure they fail**

Run: `npx vitest run mobile/useDesktopPlace.test.ts`
Expected: FAIL — `Failed to resolve import "./useDesktopPlace"`.

- [ ] **Step 9: Write `mobile/useDesktopPlace.ts`**

```ts
import { useEffect, useState } from "react";
import { isLightView, LIGHT_START } from "@/lib/edition";
import { useAppStore } from "@/lib/store";
import { parsePlace, placeHref, type Place } from "./routes";

type DesktopWhere = Pick<ReturnType<typeof useAppStore.getState>, "activeView" | "openDeckId">;

/** Where the desktop store says the reader is, as a {@link Place}. A view the light edition does
 *  not draw — a shared binder, reached from the collection — reads as the start view: the URL
 *  has no word for it. */
function placeOf(where: DesktopWhere): Place {
  const view = isLightView(where.activeView) ? where.activeView : LIGHT_START;
  return { view, deckId: view === "decks" ? where.openDeckId : null, cardId: null };
}

const here = (): Place => parsePlace(window.location.pathname, window.location.search);

/**
 * Put the store where `place` says.
 *
 * **Through `setActiveView`, and always at least once**, which is what makes the URL win over the
 * stored start view: that action bumps `viewPulse`, and the shell's launch hydration drops a seed
 * that lands after the first press. `mobile:tauri` shares the desktop's database, whose stored
 * view may be `home` — a page the light rail has no row for.
 */
function apply(place: Place): void {
  const before = useAppStore.getState();
  if (before.activeView !== place.view || before.viewPulse === 0) before.setActiveView(place.view);
  // Read again: entering Decks hands back a parked deck, and the URL's answer is the one to keep.
  const after = useAppStore.getState();
  if (place.view === "decks" && after.openDeckId !== place.deckId) after.setOpenDeckId(place.deckId);
}

/**
 * Keeps the desktop face's store and the URL saying the same thing.
 *
 * The desktop UI has no router: where the reader is, is `activeView` and `openDeckId` in its
 * store. A browser needs a URL — for Back, for a link, and so that crossing the 1024px floor
 * lands on the same destination in the other face. This is the one adapter between the two, and
 * it lives in the light entry so that no router enters `src/`.
 */
export function useDesktopPlace(): void {
  // Seeded during the first render, before `App` mounts under this hook's caller — so the
  // desktop UI never draws Home for a frame on its way to the URL's view. A lazy initializer
  // rather than a ref read in render, which `react-hooks/refs` refuses; StrictMode runs it twice
  // and the second run changes nothing.
  useState(() => {
    apply(here());
    return null;
  });

  useEffect(() => {
    const onPop = () => apply(here());
    window.addEventListener("popstate", onPop);

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeView === previous.activeView && state.openDeckId === previous.openDeckId) {
        return;
      }
      const href = placeHref(placeOf(state));
      // Equal after a `popstate`, which moved the URL first — pushing then would bury the entry
      // the reader just went back to.
      if (href !== window.location.pathname + window.location.search) {
        window.history.pushState(null, "", href);
      }
    });

    return () => {
      window.removeEventListener("popstate", onPop);
      unsubscribe();
    };
  }, []);
}
```

- [ ] **Step 10: Run the desktop-place tests**

Run: `npx vitest run mobile/useDesktopPlace.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 11: Write the two faces' hosts and the boot screen**

Create `mobile/DesktopFace.tsx`:

```tsx
import App from "@/App";
import { EditionContext, LIGHT_EDITION } from "@/lib/edition";
import { useDesktopPlace } from "./useDesktopPlace";

/**
 * The light app at 1024px and above: **the desktop UI itself**, in the light edition.
 *
 * Not a lookalike. These are the desktop's own pages, drawn at the widths they were designed and
 * measured for, with a rail of six rows and no window caption. The hook is called before `App`
 * renders so the store is on the URL's view by then.
 */
export default function DesktopFace() {
  useDesktopPlace();
  return (
    <EditionContext.Provider value={LIGHT_EDITION}>
      <App />
    </EditionContext.Provider>
  );
}
```

Create `mobile/BootScreen.tsx`:

```tsx
import { GrimoireMark } from "@/components/GrimoireMark";
import type { StartupStatus } from "@/lib/ipc";

/** What the light app draws before there is an app: the mark, and one sentence. */
export function BootScreen({ status }: { status: StartupStatus }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-text">
      <GrimoireMark size={48} className="text-accent" />
      {status.state === "failed" ? (
        <p role="alert" className="max-w-prose text-center text-sm text-destructive">
          {status.message}
        </p>
      ) : (
        <p role="status" className="text-sm text-dim">
          Opening your collection…
        </p>
      )}
    </div>
  );
}
```

Create `mobile/phone/PhoneApp.tsx` — a stub; Task 6 replaces it:

```tsx
export default function PhoneApp() {
  return <p className="p-6 text-sm text-dim">The phone face.</p>;
}
```

- [ ] **Step 12: Write the failing switch test**

Create `mobile/LightApp.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./DesktopFace", () => ({ default: () => <div>the desktop face</div> }));
vi.mock("./phone/PhoneApp", () => ({ default: () => <div>the phone face</div> }));

const startupStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: { startupStatus, onStartupChanged: () => () => undefined },
}));

import { LightApp } from "./LightApp";

/** A `matchMedia` the test drives: one query, one answer, and a way to change it. */
function stubViewport(wide: boolean) {
  const listeners = new Set<() => void>();
  let matches = wide;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return matches;
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      }) as unknown as MediaQueryList,
  );
  return (next: boolean) => {
    matches = next;
    for (const cb of listeners) cb();
  };
}

beforeEach(() => startupStatus.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("LightApp", () => {
  it("draws the phone face below the desktop floor", async () => {
    stubViewport(false);
    render(<LightApp gate={false} />);
    expect(await screen.findByText("the phone face")).toBeInTheDocument();
  });

  it("draws the desktop face at the floor and above", async () => {
    stubViewport(true);
    render(<LightApp gate={false} />);
    expect(await screen.findByText("the desktop face")).toBeInTheDocument();
  });

  it("swaps the face when the viewport crosses the floor", async () => {
    const resize = stubViewport(false);
    render(<LightApp gate={false} />);
    expect(await screen.findByText("the phone face")).toBeInTheDocument();

    act(() => resize(true));
    expect(await screen.findByText("the desktop face")).toBeInTheDocument();
    expect(screen.queryByText("the phone face")).toBeNull();
  });

  it("draws neither face until the data folder is open", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "loading" });
    render(<LightApp gate />);
    expect(await screen.findByRole("status")).toHaveTextContent("Opening your collection…");
    expect(screen.queryByText("the phone face")).toBeNull();
  });

  it("says why when the data folder will not open", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "failed", message: "user.db is locked." });
    render(<LightApp gate />);
    expect(await screen.findByRole("alert")).toHaveTextContent("user.db is locked.");
  });

  it("draws the face once the data folder is open", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "ready" });
    render(<LightApp gate />);
    expect(await screen.findByText("the phone face")).toBeInTheDocument();
  });
});
```

- [ ] **Step 13: Run it to make sure it fails**

Run: `npx vitest run mobile/LightApp.test.tsx`
Expected: FAIL — the stub draws its own sentence and neither face.

- [ ] **Step 14: Write the real `mobile/LightApp.tsx`**

```tsx
import { lazy, Suspense } from "react";
import { useStartup } from "@/boot/useStartup";
import { BootScreen } from "./BootScreen";
import { useFace } from "./useFace";

// **Each face is its own chunk.** A phone never downloads the desktop's deck editor and a laptop
// never downloads the phone's sheets — which is also why neither is imported statically here.
const DesktopFace = lazy(() => import("./DesktopFace"));
const PhoneApp = lazy(() => import("./phone/PhoneApp"));

/**
 * The light app: a gate, and one of two faces.
 *
 * **The face is chosen by the viewport's width and by nothing else** — at 1024px and above, the
 * desktop UI itself; below it, the phone face. Both are whole apps with their own providers; what
 * they share is the URL, which is how a resize that crosses the floor lands on the same
 * destination in the other one.
 *
 * `gate` is false only in fake mode, where there is no startup to wait for.
 */
export function LightApp({ gate }: { gate: boolean }) {
  const status = useStartup(gate);
  const face = useFace();

  if (status.state !== "ready") return <BootScreen status={status} />;

  return (
    <Suspense fallback={<BootScreen status={{ state: "loading" }} />}>
      {face === "desktop" ? <DesktopFace /> : <PhoneApp />}
    </Suspense>
  );
}
```

- [ ] **Step 15: Run the switch test**

Run: `npx vitest run mobile/LightApp.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 16: Commit**

```
git add src/boot/useStartup.ts src/boot/DesktopBoot.tsx mobile/
git commit -m "feat(light): a startup gate, URL routes, and a face chosen by the viewport's width"
```

---

### Task 6: The phone shell and its wall

**Files:**
- Create: `mobile/phone/router.ts`, `mobile/phone/router.test.ts`
- Create: `mobile/phone/wall.ts`, `mobile/phone/wall.test.ts`
- Create: `mobile/phone/CardWall.tsx`
- Create: `mobile/phone/TabBar.tsx`, `mobile/phone/Shell.tsx`
- Modify: `mobile/phone/PhoneApp.tsx` — replace Task 5's stub
- Create: `mobile/phone/testing.tsx` — the test harness Task 7 also uses
- Create: `mobile/phone/Shell.test.tsx`

**Interfaces:**
- Consumes: Task 3's `CardTile`; Task 5's `Place`, `parsePlace`, `placeHref`; Task 1's `LIGHT_VIEWS`.
- Produces:
  - `usePlace(): Place`, `navigate(place: Place, options?: { replace?: boolean }): void`
  - `columnsFor(width: number): number`, `tileWidthFor(width: number, columns: number): number`, `rowHeightFor(tileWidth: number): number`, constants `TILE_MIN = 141`, `GAP = 12`
  - `interface WallItem { key: string; cardId: string | null; name: string; rarity: string | null; chin: ChinPrinting; finish: Finish | null; money: string | undefined; count: number; pressLabel: string }`
  - `CardWall({ label, items, onOpen, onNearEnd, resetKey }: { label: string; items: readonly WallItem[]; onOpen: (item: WallItem) => void; onNearEnd?: () => void; resetKey: string })`
  - `Shell({ title, children }: { title: string; children: ReactNode })`
  - `mobile/phone/testing.tsx`: `renderPhone(ui: ReactElement, options?: { path?: string }): RenderResult` and `installLayout(): void`
  - `PhoneApp` default export, drawing `<Shell>` around a `Pages` switch that Task 7 fills.

- [ ] **Step 1: Write the failing router test**

Create `mobile/phone/router.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { navigate, usePlace } from "./router";

beforeEach(() => window.history.replaceState(null, "", "/"));

describe("the phone router", () => {
  it("answers where the URL says the reader is", () => {
    window.history.replaceState(null, "", "/decks/4");
    const { result } = renderHook(() => usePlace());
    expect(result.current).toEqual({ view: "decks", deckId: 4, cardId: null });
  });

  it("moves on navigate, and puts an entry in the history", () => {
    const { result } = renderHook(() => usePlace());
    const before = window.history.length;

    act(() => navigate({ view: "wishlist", deckId: null, cardId: null }));

    expect(result.current.view).toBe("wishlist");
    expect(window.location.pathname).toBe("/wishlist");
    expect(window.history.length).toBe(before + 1);
  });

  it("replaces rather than pushes when asked", () => {
    const { result } = renderHook(() => usePlace());
    const before = window.history.length;

    act(() => navigate({ view: "decks", deckId: null, cardId: null }, { replace: true }));

    expect(result.current.view).toBe("decks");
    expect(window.history.length).toBe(before);
  });

  it("does nothing for the place it is already on", () => {
    window.history.replaceState(null, "", "/search");
    renderHook(() => usePlace());
    const before = window.history.length;
    act(() => navigate({ view: "search", deckId: null, cardId: null }));
    expect(window.history.length).toBe(before);
  });

  it("follows Back", () => {
    const { result } = renderHook(() => usePlace());
    act(() => navigate({ view: "collection", deckId: null, cardId: null }));

    act(() => {
      window.history.replaceState(null, "", "/search");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.view).toBe("search");
  });

  it("hands back one object while the URL holds still", () => {
    const { result, rerender } = renderHook(() => usePlace());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run mobile/phone/router.test.ts`
Expected: FAIL — `Failed to resolve import "./router"`.

- [ ] **Step 3: Write `mobile/phone/router.ts`**

```ts
import { useMemo, useSyncExternalStore } from "react";
import { parsePlace, placeHref, type Place } from "../routes";

/**
 * The phone face's router: the URL is where the reader is, and the History API is how they move.
 *
 * Small and hand-written rather than a dependency, because it has two verbs. What it buys is the
 * three things a phone needs and the desktop never did: Android's back gesture, a browser's back
 * button, and a link.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** A string, so `useSyncExternalStore` compares by value and a re-render costs no new object. */
const href = (): string => window.location.pathname + window.location.search;

/**
 * Go somewhere. A push by default, so Back undoes it — including closing a card, which is a
 * place like any other; `replace` for a correction the reader did not make.
 */
export function navigate(place: Place, { replace = false }: { replace?: boolean } = {}): void {
  const next = placeHref(place);
  if (next === href()) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  for (const notify of listeners) notify();
}

export function usePlace(): Place {
  const current = useSyncExternalStore(subscribe, href, () => "/");
  return useMemo(() => {
    const cut = current.indexOf("?");
    return cut === -1
      ? parsePlace(current, "")
      : parsePlace(current.slice(0, cut), current.slice(cut));
  }, [current]);
}
```

- [ ] **Step 4: Run the router test**

Run: `npx vitest run mobile/phone/router.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing wall-arithmetic test**

Create `mobile/phone/wall.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { columnsFor, GAP, rowHeightFor, TILE_MIN, tileWidthFor } from "./wall";

describe("the wall's arithmetic", () => {
  it("draws two columns on a 360px phone", () => {
    // 360 less the wall's own 12px padding each side.
    expect(columnsFor(336)).toBe(2);
  });

  it("draws two at the narrowest wall that holds two tiles", () => {
    expect(columnsFor(TILE_MIN * 2 + GAP)).toBe(2);
    expect(columnsFor(TILE_MIN * 2 + GAP - 1)).toBe(1);
  });

  it("never answers fewer than one column", () => {
    expect(columnsFor(100)).toBe(1);
  });

  it("answers two for a wall nothing has measured yet", () => {
    // Zero is what jsdom reports for ever and what the first paint reports before the observer
    // fires. One column there would flash a single huge tile on every open.
    expect(columnsFor(0)).toBe(2);
  });

  it("gains columns as the wall widens", () => {
    expect(columnsFor(600)).toBe(4);
    expect(columnsFor(1000)).toBe(6);
  });

  it("shares the wall out exactly, so the tiles reach both edges", () => {
    const columns = columnsFor(336);
    const width = tileWidthFor(336, columns);
    expect(width * columns + GAP * (columns - 1)).toBe(336);
  });

  it("falls back to the minimum tile on a wall nothing has measured", () => {
    expect(tileWidthFor(0, 2)).toBe(TILE_MIN);
  });

  it("makes a row a card, its chin and a gap", () => {
    // 162 wide → 227 of art at 5:7, a 28px chin ridden 4px up, and the 12px gap.
    expect(rowHeightFor(162)).toBe(227 + 28 - 4 + 12);
  });
});
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `npx vitest run mobile/phone/wall.test.ts`
Expected: FAIL — `Failed to resolve import "./wall"`.

- [ ] **Step 7: Write `mobile/phone/wall.ts`**

```ts
import { CHIN_HEIGHT, CHIN_RISE } from "@/lib/cardZoom";

/**
 * The narrowest a tile is drawn.
 *
 * **141, and it is a measurement rather than a taste**: on 2026-08-29 a OnePlus in Chrome
 * reported 360 CSS px, and 141 was the widest tile that drew two columns on the wall that left.
 * A wall of card faces showing one card is half the screen as felt.
 */
export const TILE_MIN = 141;

/** Between tiles, and between rows. */
export const GAP = 12;

/** A Magic card is 5:7. */
const CARD_HEIGHT_PER_WIDTH = 7 / 5;

/** What a wall draws before anything has measured it. */
const UNMEASURED_COLUMNS = 2;

/**
 * How many tiles fit across a wall `width` px wide.
 *
 * **Zero is unmeasured, and answers two** — what jsdom reports for ever, and what the first paint
 * reports before the `ResizeObserver` fires. One column there would be a single huge tile flashed
 * on every open.
 */
export function columnsFor(width: number): number {
  if (width <= 0) return UNMEASURED_COLUMNS;
  return Math.max(1, Math.floor((width + GAP) / (TILE_MIN + GAP)));
}

/**
 * The width each tile is drawn at: the wall shared out, so the tiles reach both edges.
 *
 * The desktop wall draws an exact tile and centres the remainder, because there a wheel steps the
 * tile's size and a stretched tile makes most steps move nothing. A phone has no such gesture, so
 * the remainder is better spent on the cards.
 */
export function tileWidthFor(width: number, columns: number): number {
  if (width <= 0) return TILE_MIN;
  return (width - GAP * (columns - 1)) / columns;
}

/** One row's height: the art, the chin ridden up onto it, and the gap under it. */
export function rowHeightFor(tileWidth: number): number {
  return Math.round(tileWidth * CARD_HEIGHT_PER_WIDTH) + CHIN_HEIGHT - CHIN_RISE + GAP;
}
```

- [ ] **Step 8: Run the wall test**

Run: `npx vitest run mobile/phone/wall.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Write `mobile/phone/CardWall.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CardTile } from "@/components/CardTile";
import type { ChinPrinting } from "@/components/CardChin";
import { CountTag } from "@/components/CountTag";
import type { Finish } from "@/lib/finish";
import { useElementWidth } from "@/lib/useElementWidth";
import { columnsFor, GAP, rowHeightFor, tileWidthFor } from "./wall";

/** One tile's worth of facts — what every list on the phone face is turned into. */
export interface WallItem {
  /** Unique on the wall. A collection row's id, not its card's: one printing can be two rows. */
  key: string;
  /** The picture. `null` draws the named frame. */
  cardId: string | null;
  name: string;
  rarity: string | null;
  chin: ChinPrinting;
  finish: Finish | null;
  /** Already formatted. `undefined` draws no money slot at all. */
  money: string | undefined;
  /** Copies. Drawn as a tag on the art only above one. */
  count: number;
  /** The tile's accessible name — the card and its printing, so two printings are two names. */
  pressLabel: string;
}

/** How close to the end of what is loaded the reader gets before more is asked for. */
const NEAR_END_ROWS = 4;

/**
 * A wall of card tiles, virtualised by row.
 *
 * It scrolls inside itself: the phone shell gives it the space between the top bar and the tab
 * bar, and nothing else on a page scrolls. Only the rows near the viewport are mounted, so a
 * search of five thousand cards costs what a screenful does.
 */
export function CardWall({
  label,
  items,
  onOpen,
  onNearEnd,
  resetKey,
}: {
  /** What this wall is a list of, for a screen reader: "Search results", "Your collection". */
  label: string;
  items: readonly WallItem[];
  onOpen: (item: WallItem) => void;
  /** Asked when the reader nears the end of `items`. The page decides whether there is more. */
  onNearEnd?: () => void;
  /** Changes when this is a different list — a new search — and sends the wall back to its top. */
  resetKey: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const columns = columnsFor(width);
  const tileWidth = tileWidthFor(width, columns);
  const rowHeight = rowHeightFor(tileWidth);
  const rowCount = Math.ceil(items.length / columns);

  const rows = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  });

  // A row's height follows the wall's width; tell the virtualiser when it moves.
  useEffect(() => {
    rows.measure();
  }, [rows, rowHeight]);

  // A different list starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const drawn = rows.getVirtualItems();
  const lastDrawn = drawn.length > 0 ? drawn[drawn.length - 1].index : -1;

  useEffect(() => {
    if (onNearEnd && rowCount > 0 && lastDrawn >= rowCount - NEAR_END_ROWS) onNearEnd();
  }, [onNearEnd, lastDrawn, rowCount]);

  return (
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
      <ul
        ref={measure}
        aria-label={label}
        className="relative w-full"
        style={{ height: rows.getTotalSize() }}
      >
        {drawn.map((row) => (
          <li
            key={row.key}
            className="absolute left-0 top-0 flex w-full"
            style={{ transform: `translateY(${row.start}px)`, height: rowHeight, gap: GAP }}
          >
            {items.slice(row.index * columns, row.index * columns + columns).map((item) => (
              <CardTile
                key={item.key}
                className="min-w-0 flex-1"
                cardId={item.cardId}
                name={item.name}
                rarity={item.rarity}
                chin={item.chin}
                finish={item.finish}
                money={item.money}
                pressLabel={item.pressLabel}
                onPress={() => onOpen(item)}
                overlay={
                  item.count > 1 ? (
                    <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
                      <CountTag count={item.count} title={`${item.count} copies`} />
                    </span>
                  ) : undefined
                }
              />
            ))}
            {/* A short last row keeps its tiles the width of the rows above it. */}
            {Array.from(
              { length: columns - Math.min(columns, items.length - row.index * columns) },
              (_, i) => (
                <span key={`pad-${i}`} aria-hidden className="min-w-0 flex-1" />
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 10: Write the shell**

Create `mobile/phone/TabBar.tsx`:

```tsx
import { NAV } from "@/components/nav";
import { LIGHT_VIEWS, type LightView } from "@/lib/edition";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The five destinations a thumb reaches for. Settings is the top bar's.
 *
 * **The words and the glyphs are the desktop rail's**, read out of `NAV` rather than written
 * again — one word per view, in both apps, is what that module exists to keep.
 */
const TABS = NAV.filter(
  (entry): entry is (typeof NAV)[number] & { id: LightView } =>
    (LIGHT_VIEWS as readonly string[]).includes(entry.id) && entry.id !== "settings",
);

export function TabBar({ view, onSelect }: { view: LightView; onSelect: (view: LightView) => void }) {
  return (
    <nav
      aria-label="Views"
      // The bar sits on the screen's bottom edge, which on a phone is under the home indicator.
      className="flex shrink-0 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-current={id === view ? "page" : undefined}
          onClick={() => onSelect(id)}
          className={cn(
            // 52px: over the 44px touch floor in both directions at five tabs on 360px.
            "flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs",
            id === view ? "text-accent" : "text-dim",
            FOCUS_INSET,
          )}
        >
          <Icon aria-hidden className="size-5" />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </nav>
  );
}
```

Create `mobile/phone/Shell.tsx`:

```tsx
import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { ManaLine } from "@/components/ManaLine";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { navigate, usePlace } from "./router";
import { TabBar } from "./TabBar";

/**
 * The phone face's frame: a title row, the page, and the tab bar.
 *
 * `h-dvh`, not `h-screen` — on a mobile browser `100vh` is the height the page would have with
 * the URL bar hidden, so an `h-screen` shell puts its own tab bar under browser chrome.
 *
 * The page is the one thing between the two bars and owns its own scrolling; the frame never
 * scrolls. The mana line is drawn once, under the title, exactly as the desktop's ribbon draws it
 * — a signature at both edges marks neither.
 */
export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const place = usePlace();
  const onSettings = place.view === "settings";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text select-none">
      <header className="shrink-0 bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-3 px-4">
          <h1 className="min-w-0 flex-1 truncate font-heading text-lg">{title}</h1>
          <button
            type="button"
            aria-label="Settings"
            aria-current={onSettings ? "page" : undefined}
            onClick={() => navigate({ view: "settings", deckId: null, cardId: null })}
            className={cn(
              "flex size-11 items-center justify-center rounded-md",
              onSettings ? "text-accent" : "text-dim",
              FOCUS,
            )}
          >
            <Settings aria-hidden className="size-5" />
          </button>
        </div>
        {/* `sync={null}` is the line at rest. The phone face runs no card sync of its own yet. */}
        <ManaLine sync={null} />
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col">{children}</main>

      <TabBar
        view={place.view}
        onSelect={(view) => navigate({ view, deckId: null, cardId: null })}
      />
    </div>
  );
}
```

`ManaLine` takes one required prop, `sync: ManaLineSync | null`, and `font-heading` is the class `Ribbon.tsx`'s own `<h1>` carries (Cinzel; never set it below 18px, which is why the title is `text-lg`). `Ribbon` itself must **not** be imported: the fence forbids it.

- [ ] **Step 11: Write the test harness**

Create `mobile/phone/testing.tsx`:

```tsx
import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { installWorld, type FakeParams } from "../../.storybook/fake/world";

/**
 * jsdom lays nothing out, so a virtualised wall mounts zero rows without a height to measure.
 * The numbers `src/stories.test.tsx` gives every story, for the same reason.
 */
export function installLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 360 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
}

/**
 * Render a piece of the phone face over the Storybook fake.
 *
 * The file calling this must mock Tauri's three API modules with the fake's, **in the file
 * itself** (a `vi.mock` is hoisted per file and cannot live in a helper):
 *
 * ```ts
 * vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
 * vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
 * vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));
 * ```
 *
 * **Never mock `@/lib/images`** — `.storybook/CLAUDE.md` records the symptom, a silent
 * 300-second hang.
 */
export function renderPhone(
  ui: ReactElement,
  { path = "/", fake }: { path?: string; fake?: FakeParams } = {},
): RenderResult {
  window.history.replaceState(null, "", path);
  const world = installWorld(fake ?? { seed: "starter" });
  world.mount();
  return render(
    <QueryClientProvider client={world.client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}
```

- [ ] **Step 12: Write the failing shell test**

Create `mobile/phone/Shell.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));

import { PhoneFace } from "./PhoneApp";
import { installLayout, renderPhone } from "./testing";

beforeAll(installLayout);

const tabs = () =>
  within(screen.getByRole("navigation", { name: "Views" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("the phone shell", () => {
  it("draws five tabs, in the rail's order", () => {
    renderPhone(<PhoneFace />);
    expect(tabs()).toEqual(["Search", "Decks", "Collection", "Wishlist", "Scanner"]);
  });

  it("opens on Search and says so in the title", () => {
    renderPhone(<PhoneFace />);
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-current", "page");
  });

  it("moves on a tab press, and the URL follows", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

    expect(window.location.pathname).toBe("/wishlist");
    expect(screen.getByRole("heading", { level: 1, name: "Wishlist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wishlist" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Search" })).not.toHaveAttribute("aria-current");
  });

  it("opens on the URL's destination", () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    expect(screen.getByRole("heading", { level: 1, name: "Collection" })).toBeInTheDocument();
  });

  it("reaches Settings from the top bar, and lights no tab there", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const tab of within(screen.getByRole("navigation", { name: "Views" })).getAllByRole("button")) {
      expect(tab).not.toHaveAttribute("aria-current");
    }
  });

  it("returns on Back", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("button", { name: "Decks" }));
    expect(screen.getByRole("heading", { level: 1, name: "Decks" })).toBeInTheDocument();

    window.history.back();
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 13: Run it to make sure it fails**

Run: `npx vitest run mobile/phone/Shell.test.tsx`
Expected: FAIL — `PhoneFace` is not exported from `./PhoneApp`.

- [ ] **Step 14: Write the real `mobile/phone/PhoneApp.tsx`**

Task 7 replaces `Pages`' placeholders with real pages; the shape here is final.

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { NAV } from "@/components/nav";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { LightView } from "@/lib/edition";
import { queryClient } from "@/lib/query";
import type { Place } from "../routes";
import { usePlace } from "./router";
import { Shell } from "./Shell";

/** The word for a destination — the desktop rail's, so the two apps cannot name one differently. */
const titleOf = (view: LightView): string => NAV.find((n) => n.id === view)?.label ?? "";

/** The page for a place. Task 7 fills each arm. */
function Pages({ place }: { place: Place }) {
  return <p className="p-4 text-sm text-dim">{titleOf(place.view)} arrives in the next task.</p>;
}

/**
 * The phone face, less its providers — what a test renders inside a fake world's own.
 */
export function PhoneFace() {
  const place = usePlace();
  return (
    <Shell title={titleOf(place.view)}>
      <Pages place={place} />
    </Shell>
  );
}

/**
 * The phone face: the light app below 1024px.
 *
 * Its providers are the desktop's own, in the desktop's order and for `App.tsx`'s reasons —
 * `MotionConfig` outermost because `motion` ships `reducedMotion: "never"`, and the one shared
 * `queryClient`, so data read by one face is still in the cache when a resize draws the other.
 */
export default function PhoneApp() {
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <PhoneFace />
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
```

- [ ] **Step 15: Run the shell test**

Run: `npx vitest run mobile/phone/Shell.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 16: Commit**

```
git add mobile/phone/
git commit -m "feat(light): the phone face's shell, router and virtualised wall"
```

---

### Task 7: The phone face's pages

**Files:**
- Create: `mobile/phone/items.ts`, `mobile/phone/items.test.ts`
- Create: `mobile/phone/CardSheet.tsx`
- Create: `mobile/phone/pages/SearchPage.tsx`, `DecksPage.tsx`, `DeckPage.tsx`, `CollectionPage.tsx`, `WishlistPage.tsx`, `ScannerPage.tsx`, `SettingsPage.tsx`
- Modify: `mobile/phone/PhoneApp.tsx` — `Pages`, and the card sheet's mount
- Create: `mobile/phone/pages/pages.test.tsx`

**Interfaces:**
- Consumes: Task 6's `CardWall`, `WallItem`, `navigate`, `usePlace`, `renderPhone`, `installLayout`; the desktop's `useCardSearch` (`@/features/search/useCardSearch`), `useDecks` (`@/features/decks/useDecks`), `useCollection` (`@/features/collection/useCollection`), `useWishlist` (`@/features/wishlist/useWishlist`), `useMarketplace` (`@/lib/useMarketplace`), and `ipc.cardDetail` / `ipc.deckGet`.
- Produces: `searchItem`, `collectionItem`, `wishItem`, `deckCardItem` — each `(row, currency: Currency) => WallItem`.

**Read before writing:** the return objects of the four hooks, at the bottom of their files. This task uses only these members, all confirmed present on 2026-10-01:
- `useCardSearch()` → `text`, `setText`, `rows` (`CardSummary[]`), `query` (an infinite query: `hasNextPage`, `isFetchingNextPage`, `fetchNextPage`, `isPending`, `isError`), `marketplace` (has `.currency`), `searchKey`, `total`, `totalIsCapped`
- `useDecks()` → `decks` (`DeckRow[]`), `query`
- `useCollection()` → `rows` (`CollectionRow[]`), `query`, `marketplace`, `total`, `scrollKey`
- `useWishlist()` → `rows` (`WishRow[]`), `query`, `hasMore`, `marketplace`, `total`, `queryKeyString`

- [ ] **Step 1: Write the failing item tests**

Create `mobile/phone/items.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CardSummary, CollectionRow, WishRow } from "@/lib/ipc";
import { collectionItem, searchItem, wishItem } from "./items";

const summary = (over: Partial<CardSummary> = {}): CardSummary =>
  ({
    id: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    rarity: "common",
    price: 1.5,
    ownedQuantity: 0,
    printings: 1,
    ...over,
  }) as CardSummary;

describe("searchItem", () => {
  it("names the tile for the card and its printing", () => {
    const item = searchItem(summary(), "usd");
    expect(item.pressLabel).toBe("Lightning Bolt, LEA 161");
    expect(item.chin).toEqual({ setCode: "lea", collectorNumber: "161", printingTitle: "Limited Edition Alpha" });
    expect(item.money).toBe("$1.50");
    expect(item.count).toBe(0);
  });

  it("writes an unpriced card as an em dash, never as zero", () => {
    expect(searchItem(summary({ price: null }), "usd").money).toBe("—");
  });

  it("counts what the reader owns", () => {
    expect(searchItem(summary({ ownedQuantity: 3 }), "usd").count).toBe(3);
  });
});

const entry = (over: Partial<CollectionRow> = {}): CollectionRow =>
  ({
    id: 9,
    cardId: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    setName: null,
    collectorNumber: "161",
    rarity: "common",
    finish: "foil",
    quantity: 2,
    unitPrice: 4,
    ...over,
  }) as CollectionRow;

describe("collectionItem", () => {
  it("keys on the row, because one printing can be two rows", () => {
    expect(collectionItem(entry(), "usd").key).toBe("9");
  });

  it("marks a foil copy and leaves a plain one unmarked", () => {
    expect(collectionItem(entry(), "usd").finish).toBe("foil");
    expect(collectionItem(entry({ finish: "nonfoil" }), "usd").finish).toBeNull();
  });

  it("names a card the corpus has forgotten rather than drawing nothing", () => {
    expect(collectionItem(entry({ name: null }), "usd").name).toBe("Unknown card");
  });
});

const wish = (over: Partial<WishRow> = {}): WishRow =>
  ({
    id: 3,
    oracleId: "oracle-1",
    cardId: null,
    name: "Sol Ring",
    setCode: null,
    collectorNumber: null,
    rarity: null,
    artCardId: "art-1",
    quantity: 1,
    preferredFinish: null,
    unitPrice: null,
    ...over,
  }) as WishRow;

describe("wishItem", () => {
  it("draws a wish for any printing without a set line", () => {
    const item = wishItem(wish(), "usd");
    expect(item.chin).toEqual({ printing: "Any printing", printingTitle: null });
    expect(item.pressLabel).toBe("Sol Ring, any printing");
    // The picture is the printing the wish is *drawn as*, which is not the one it asks for.
    expect(item.cardId).toBe("art-1");
  });

  it("draws a pinned wish's own printing", () => {
    const item = wishItem(wish({ cardId: "card-9", setCode: "c21", collectorNumber: "263" }), "usd");
    expect(item.chin).toEqual({ setCode: "c21", collectorNumber: "263" });
    expect(item.pressLabel).toBe("Sol Ring, C21 263");
    expect(item.cardId).toBe("card-9");
  });

  it("treats a set with no number as no printing at all", () => {
    // Both halves or neither — a chin reading `c21 · null` is the bug this guards.
    expect(wishItem(wish({ setCode: "c21", collectorNumber: null }), "usd").chin).toEqual({
      printing: "Any printing",
      printingTitle: null,
    });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run mobile/phone/items.test.ts`
Expected: FAIL — `Failed to resolve import "./items"`.

- [ ] **Step 3: Write `mobile/phone/items.ts`**

```ts
import { isFinish, type Finish } from "@/lib/finish";
import type { CardSummary, CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { WallItem } from "./CardWall";

/**
 * Each of the phone face's lists, turned into what the wall draws.
 *
 * Four DTOs and one tile. The rows are the desktop's own — the same commands answer both faces —
 * so everything a list knows about a card arrives here and what the wall needs is picked out once.
 */

/** A printing, said the way the chin writes it. */
const printingWords = (setCode: string, collectorNumber: string): string =>
  `${setCode.toUpperCase()} ${collectorNumber}`;

/** The finish a copy *is*, as a mark. `nonfoil` goes unmarked — the app's rule on every wall. */
function marked(finish: string | null): Finish | null {
  return finish !== null && isFinish(finish) && finish !== "nonfoil" ? finish : null;
}

export function searchItem(card: CardSummary, currency: Currency): WallItem {
  return {
    key: card.id,
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    chin: { setCode: card.setCode, collectorNumber: card.collectorNumber, printingTitle: card.setName },
    finish: null,
    money: formatPrice(card.price, currency),
    count: card.ownedQuantity,
    pressLabel: `${card.name}, ${printingWords(card.setCode, card.collectorNumber)}`,
  };
}

export function collectionItem(row: CollectionRow, currency: Currency): WallItem {
  const name = row.name ?? "Unknown card";
  return {
    key: String(row.id),
    cardId: row.cardId,
    name,
    rarity: row.rarity,
    chin: { setCode: row.setCode, collectorNumber: row.collectorNumber, printingTitle: row.setName },
    finish: marked(row.finish),
    money: formatPrice(row.unitPrice, currency),
    count: row.quantity,
    pressLabel: `${name}, ${printingWords(row.setCode, row.collectorNumber)}`,
  };
}

export function wishItem(row: WishRow, currency: Currency): WallItem {
  // A wish names a printing only when it has both halves; a wish for *any* printing has neither,
  // and is drawn as one particular printing whose set it must not claim.
  const pinned = row.setCode !== null && row.collectorNumber !== null;
  return {
    key: String(row.id),
    cardId: row.cardId ?? row.artCardId,
    name: row.name,
    rarity: row.rarity,
    chin: pinned
      ? { setCode: row.setCode as string, collectorNumber: row.collectorNumber as string }
      : { printing: "Any printing", printingTitle: null },
    finish: marked(row.preferredFinish),
    money: formatPrice(row.unitPrice, currency),
    count: row.quantity,
    pressLabel: pinned
      ? `${row.name}, ${printingWords(row.setCode as string, row.collectorNumber as string)}`
      : `${row.name}, any printing`,
  };
}

export function deckCardItem(card: DeckCard, currency: Currency): WallItem {
  return {
    key: String(card.id),
    cardId: card.cardId,
    name: card.name,
    rarity: card.rarity,
    chin: { setCode: card.setCode, collectorNumber: card.collectorNumber, printingTitle: card.setName },
    // A deck row spells the regular copy `null` already.
    finish: marked(card.finish),
    money: formatPrice(card.unitPrice, currency),
    count: card.quantity,
    pressLabel: `${card.name}, ${printingWords(card.setCode, card.collectorNumber)}`,
  };
}
```

- [ ] **Step 4: Run the item tests**

Run: `npx vitest run mobile/phone/items.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing page tests**

Create `mobile/phone/pages/pages.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

beforeAll(installLayout);

/** Long enough for the search box's 300ms debounce and a fake round trip. */
const SETTLE = { timeout: 3000 };

describe("Search", () => {
  it("draws a wall of cards before anything is typed", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("narrows the wall to what was typed", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    const names = () =>
      within(wall).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "");
    const before = await waitFor(() => names().length, SETTLE);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search cards" }), "lightning bolt");

    // Fewer tiles than the unfiltered wall drew, and the card that was typed among them. Not
    // "every tile is Lightning Bolt": the fake's text search is a substring over more than names.
    await waitFor(() => {
      expect(names().length).toBeLessThan(before);
      expect(names().some((name) => /^Lightning Bolt, /.test(name))).toBe(true);
    }, SETTLE);
  });

  it("says so when nothing matches, and offers no wall", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search cards" }), "zzzqqqxxx");
    expect(await screen.findByText("No cards match.", undefined, SETTLE)).toBeInTheDocument();
  });

  it("opens a card over the wall, and Back closes it", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    const first = await waitFor(() => within(wall).getAllByRole("button")[0], SETTLE);
    const name = (first.getAttribute("aria-label") ?? "").split(", ")[0];

    await userEvent.click(first);

    expect(window.location.search).toMatch(/^\?card=/);
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("heading", { name })).toBeInTheDocument();

    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.search).toBe("");
  });
});

describe("the card sheet", () => {
  it("says so when the card cannot be read", async () => {
    renderPhone(<PhoneFace />, { path: "/search?card=no-such-card" });
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
  });
});

describe("Decks", () => {
  it("lists the reader's decks", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const list = await screen.findByRole("list", { name: "Your decks" });
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("opens a deck as a wall of its cards, with the deck's name as the title", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const list = await screen.findByRole("list", { name: "Your decks" });
    const first = await waitFor(() => within(list).getAllByRole("button")[0], SETTLE);

    await userEvent.click(first);

    expect(window.location.pathname).toMatch(/^\/decks\/\d+$/);
    expect(await screen.findByRole("list", { name: "Cards in this deck" }, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to decks" })).toBeInTheDocument();
  });

  it("says so when the deck is gone", async () => {
    renderPhone(<PhoneFace />, { path: "/decks/999999" });
    expect(await screen.findByText("That deck is gone.", undefined, SETTLE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to decks" }));
    expect(window.location.pathname).toBe("/decks");
  });

  it("says so, and offers nothing, when there are no decks", async () => {
    renderPhone(<PhoneFace />, { path: "/decks", fake: { seed: "empty" } });
    expect(await screen.findByText("No decks", undefined, SETTLE)).toBeInTheDocument();
  });
});

describe("Collection", () => {
  it("draws the reader's cards", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await screen.findByRole("list", { name: "Your collection" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("says so when the collection is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/collection", fake: { seed: "empty" } });
    expect(await screen.findByText("Nothing in your collection yet.", undefined, SETTLE)).toBeInTheDocument();
  });
});

describe("Wishlist", () => {
  it("draws the reader's wishes", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await screen.findByRole("list", { name: "Your wishlist" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("says so when the wishlist is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist", fake: { seed: "empty" } });
    expect(await screen.findByText("Nothing on your wishlist yet.", undefined, SETTLE)).toBeInTheDocument();
  });
});

describe("Scanner and Settings", () => {
  it("says what is coming, and opens no camera", () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    expect(screen.getByText(/The scanner arrives in a later phase/)).toBeInTheDocument();
  });

  it("names the edition", () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    expect(screen.getByText(/light edition/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run them to make sure they fail**

Run: `npx vitest run mobile/phone/pages/pages.test.tsx`
Expected: FAIL — every page still draws Task 6's placeholder sentence.

- [ ] **Step 7: Write the card sheet**

Create `mobile/phone/CardSheet.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { ManaText } from "@/components/ManaText";
import { FINISHES, type Finish } from "@/lib/finish";
import { ipc } from "@/lib/ipc";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";

const FINISH_WORD: Record<Finish, string> = { nonfoil: "Nonfoil", foil: "Foil", etched: "Etched" };

/**
 * One card, over whatever the reader was looking at.
 *
 * **It is a place** — `?card=<id>` — so opening it pushes a history entry and Back closes it,
 * which is the gesture a phone reader reaches for. `Dialog` is the desktop's own shell; below
 * 640px it is full-bleed by its own rule, which is this face's whole width.
 *
 * Reading only, for the skeleton: the picture, the words, and what each finish costs.
 */
export function CardSheet({ cardId, onClose }: { cardId: string | null; onClose: () => void }) {
  const { marketplace, currency } = useMarketplace();
  const detail = useQuery({
    queryKey: ["card", "sheet", cardId, marketplace.id],
    queryFn: () => ipc.cardDetail(cardId as string, marketplace.id),
    enabled: cardId !== null,
    // A refusal here is a card that is not there. Asking twice says so twice as late.
    retry: false,
  });
  const card = detail.data ?? null;

  return (
    <Dialog
      open={cardId !== null}
      title={card?.name ?? "Card"}
      closeLabel="Close card"
      size="w-[28rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 select-text overflow-y-auto p-4">
        {detail.isPending && cardId !== null && <p className="text-sm text-dim">Reading the card…</p>}
        {(detail.isError || (detail.isSuccess && card === null)) && (
          <p role="alert" className="text-sm text-destructive">
            That card could not be read.
          </p>
        )}
        {card !== null && (
          <div className="flex flex-col gap-3">
            <div className="mx-auto w-full max-w-64">
              <CardArt cardId={card.id} name={card.name} variant="display" loading="eager" />
            </div>
            <p className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">{card.typeLine}</span>
              <ManaText source={card.manaCost} />
            </p>
            {card.oracleText !== null && (
              <p className="whitespace-pre-line text-sm">{card.oracleText}</p>
            )}
            <p className="font-mono text-xs uppercase text-dim">
              {card.setCode} · {card.collectorNumber}
              {card.setName !== null && <span className="normal-case"> — {card.setName}</span>}
            </p>
            <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
              {FINISHES.map((finish) => (
                <div key={finish}>
                  <dt className="text-xs text-dim">{FINISH_WORD[finish]}</dt>
                  <dd className="font-mono text-sm">{formatPrice(card.finishPrices[finish], currency)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </Dialog>
  );
}
```

`FinishPrices` is `{ nonfoil, foil, etched }`, each `number | null` — confirm in `src/lib/ipc.ts` and index it as above.

- [ ] **Step 8: Write the seven pages**

Create `mobile/phone/pages/SearchPage.tsx`:

```tsx
import { useCallback, useMemo } from "react";
import { useCardSearch } from "@/features/search/useCardSearch";
import { CardWall, type WallItem } from "../CardWall";
import { searchItem } from "../items";

/**
 * Card search: one line, and the wall.
 *
 * **The search is the desktop's** — `useCardSearch`, the hook behind `SearchPage` and the docked
 * columns — so the box reads the same query language and the same request reaches the same
 * command. What this page leaves for phase 3 is every control but the box: the filters live
 * behind a sheet that has not been designed yet.
 */
export function SearchPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const search = useCardSearch();
  const { query, marketplace } = search;
  const items = useMemo(
    () => search.rows.map((row) => searchItem(row, marketplace.currency)),
    [search.rows, marketplace.currency],
  );
  const more = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return (
    <>
      <div className="shrink-0 border-b border-border bg-surface px-3 py-2">
        <input
          type="search"
          aria-label="Search cards"
          placeholder="Search cards"
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          // 16px: below it, iOS and some Android browsers zoom the page on focus.
          className="h-11 w-full rounded-md border border-border bg-bg px-3 text-base text-text select-text"
        />
      </div>
      {query.isError ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          The search could not be read.
        </p>
      ) : !query.isPending && items.length === 0 ? (
        <p className="p-4 text-sm text-dim">No cards match.</p>
      ) : (
        <CardWall
          label="Search results"
          items={items}
          onOpen={onOpen}
          onNearEnd={more}
          resetKey={search.searchKey}
        />
      )}
    </>
  );
}
```

Create `mobile/phone/pages/DecksPage.tsx`:

```tsx
import { useDecks } from "@/features/decks/useDecks";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";

/** The reader's decks, as a list. The gallery's covers and folders are phase 3's. */
export function DecksPage({ onOpen }: { onOpen: (deckId: number) => void }) {
  const { decks, query } = useDecks();

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Your decks could not be read.
      </p>
    );
  }
  if (!query.isPending && decks.length === 0) return <p className="p-4 text-sm text-dim">No decks</p>;

  return (
    <ul aria-label="Your decks" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {decks.map((deck) => (
        <li key={deck.id} className="border-b border-border">
          <button
            type="button"
            onClick={() => onOpen(deck.id)}
            className={cn("flex min-h-14 w-full flex-col justify-center px-4 py-2 text-left", FOCUS_INSET)}
          >
            <span className="truncate text-base">{deck.name}</span>
            <span className="truncate text-xs text-dim">
              {deck.formatName ?? deck.formatKey} · {deck.cardCount} cards
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Create `mobile/phone/pages/DeckPage.tsx`:

```tsx
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { ipc } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { CardWall, type WallItem } from "../CardWall";
import { deckCardItem } from "../items";

/**
 * One deck, read-only: its actual list as a wall.
 *
 * Under `["decks"]` so every deck write the desktop face makes refreshes it. The editor — piles,
 * the plan, quantities — is phase 3's largest piece and none of it is here.
 */
export function DeckPage({
  deckId,
  onOpen,
  onBack,
}: {
  deckId: number;
  onOpen: (item: WallItem) => void;
  onBack: () => void;
}) {
  const { marketplace, currency } = useMarketplace();
  const deck = useQuery({
    queryKey: ["decks", "phone", deckId, marketplace.id],
    queryFn: () => ipc.deckGet(deckId, "live", marketplace.id),
  });
  const items = useMemo(
    () => (deck.data?.cards ?? []).map((card) => deckCardItem(card, currency)),
    [deck.data, currency],
  );
  const gone = deck.isError || (deck.isSuccess && deck.data === null);

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
        <button
          type="button"
          aria-label="Back to decks"
          onClick={onBack}
          className={cn("flex size-11 items-center justify-center rounded-md text-dim", FOCUS)}
        >
          <ChevronLeft aria-hidden className="size-5" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base">{deck.data?.deck.name ?? ""}</h2>
      </div>
      {gone ? (
        <p className="p-4 text-sm text-dim">That deck is gone.</p>
      ) : !deck.isPending && items.length === 0 ? (
        <p className="p-4 text-sm text-dim">No cards in this deck yet.</p>
      ) : (
        <CardWall label="Cards in this deck" items={items} onOpen={onOpen} resetKey={String(deckId)} />
      )}
    </>
  );
}
```

Create `mobile/phone/pages/CollectionPage.tsx`:

```tsx
import { useCallback, useMemo } from "react";
import { useCollection } from "@/features/collection/useCollection";
import { CardWall, type WallItem } from "../CardWall";
import { collectionItem } from "../items";

/** The reader's own cards, read-only. Folders, filters and edits are phase 3's. */
export function CollectionPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const collection = useCollection();
  const { query, marketplace } = collection;
  const items = useMemo(
    () => collection.rows.map((row) => collectionItem(row, marketplace.currency)),
    [collection.rows, marketplace.currency],
  );
  const more = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Your collection could not be read.
      </p>
    );
  }
  if (!query.isPending && items.length === 0) {
    return <p className="p-4 text-sm text-dim">Nothing in your collection yet.</p>;
  }
  return (
    <CardWall
      label="Your collection"
      items={items}
      onOpen={onOpen}
      onNearEnd={more}
      resetKey={collection.scrollKey}
    />
  );
}
```

Create `mobile/phone/pages/WishlistPage.tsx`:

```tsx
import { useCallback, useMemo } from "react";
import { useWishlist } from "@/features/wishlist/useWishlist";
import { CardWall, type WallItem } from "../CardWall";
import { wishItem } from "../items";

/** The reader's wishes, read-only. */
export function WishlistPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const wishlist = useWishlist();
  const { query, marketplace } = wishlist;
  const items = useMemo(
    () => wishlist.rows.map((row) => wishItem(row, marketplace.currency)),
    [wishlist.rows, marketplace.currency],
  );
  const more = useCallback(() => {
    if (wishlist.hasMore && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [wishlist.hasMore, query]);

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Your wishlist could not be read.
      </p>
    );
  }
  if (!query.isPending && items.length === 0) {
    return <p className="p-4 text-sm text-dim">Nothing on your wishlist yet.</p>;
  }
  return (
    <CardWall
      label="Your wishlist"
      items={items}
      onOpen={onOpen}
      onNearEnd={more}
      resetKey={wishlist.queryKeyString}
    />
  );
}
```

Create `mobile/phone/pages/ScannerPage.tsx`:

```tsx
import { Camera } from "lucide-react";

/** A sentence where the scanner will be. It opens no camera and asks for no permission. */
export function ScannerPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Camera aria-hidden className="size-8 text-dim" />
      <p className="max-w-prose text-sm text-dim">
        The scanner arrives in a later phase. It will point this device's camera at a card and name
        the printing.
      </p>
    </div>
  );
}
```

Create `mobile/phone/pages/SettingsPage.tsx`:

```tsx
/** What is here so far, said plainly. Sync, card data and the image cache are phase 3's. */
export function SettingsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 select-text">
      <p className="max-w-prose text-sm text-dim">
        This is the light edition of MTG Grimoire: card search, decks, your collection, your
        wishlist and the scanner. Pairing with your other devices and managing card data arrive in
        a later phase.
      </p>
    </div>
  );
}
```

- [ ] **Step 9: Wire the pages and the sheet into `mobile/phone/PhoneApp.tsx`**

Replace `Pages` and `PhoneFace`:

```tsx
/** Open a card over wherever the reader is. A push, so Back closes it. */
const openCard = (place: Place) => (item: WallItem) => {
  // A wish for any printing has no card of its own to open; its picture's is the honest one.
  if (item.cardId !== null) navigate({ ...place, cardId: item.cardId });
};

function Pages({ place }: { place: Place }) {
  const onOpen = openCard(place);
  switch (place.view) {
    case "search":
      return <SearchPage onOpen={onOpen} />;
    case "decks":
      return place.deckId === null ? (
        <DecksPage onOpen={(deckId) => navigate({ view: "decks", deckId, cardId: null })} />
      ) : (
        <DeckPage
          // Keyed by the deck: a second one is a fresh page, not the first one's scroll position.
          key={place.deckId}
          deckId={place.deckId}
          onOpen={onOpen}
          onBack={() => navigate({ view: "decks", deckId: null, cardId: null })}
        />
      );
    case "collection":
      return <CollectionPage onOpen={onOpen} />;
    case "wishlist":
      return <WishlistPage onOpen={onOpen} />;
    case "scanner":
      return <ScannerPage />;
    case "settings":
      return <SettingsPage />;
  }
}

export function PhoneFace() {
  const place = usePlace();
  return (
    <>
      <Shell title={titleOf(place.view)}>
        <Pages place={place} />
      </Shell>
      {/* A sibling of the shell, not a child of a page: `Dialog`'s scrim is `fixed inset-0`, and
          nothing that covers the window may mount inside a box that could become its containing
          block. `App.tsx` mounts the desktop's card modal the same way. */}
      <CardSheet cardId={place.cardId} onClose={() => navigate({ ...place, cardId: null })} />
    </>
  );
}
```

with the imports to match (`navigate` and `usePlace` from `./router`; `CardSheet`; the seven pages; `type WallItem` from `./CardWall`). A `switch` over `LightView` with no `default` — a seventh view added to the edition is then a compile error here.

- [ ] **Step 10: Run the page tests**

Run: `npx vitest run mobile/phone/`
Expected: PASS — `router`, `wall`, `items`, `Shell` and `pages`.

If a list is empty under the `starter` seed where a test expects rows, read what the fake seeds for that list (`.storybook/fake/seeds.ts`) before changing the test — `.storybook/CLAUDE.md` describes each seed.

- [ ] **Step 11: Commit**

```
git add mobile/phone/
git commit -m "feat(light): the phone face's pages - search, decks, collection, wishlist, and a card sheet"
```

---

### Task 8: The fence, and the rules written down

**Files:**
- Create: `mobile/phone/fence.test.ts`
- Create: `mobile/CLAUDE.md`
- Modify: root `CLAUDE.md` — one row in the "Where the rules live" table (after the `.github/CLAUDE.md` row), one line under Commands
- Modify: `src/CLAUDE.md` — the Layout table's last row gains a sibling

**Interfaces:**
- Consumes: everything under `mobile/phone/`.
- Produces: a red build when a phone file reaches the desktop store, the desktop shell or Tauri's window API.

- [ ] **Step 1: Write the fence**

Create `mobile/phone/fence.test.ts`:

```ts
import { describe, expect, it } from "vitest";

/**
 * **The phone face does not reach the desktop's store or its shell, and this is the fence.**
 *
 * Round one of this app's phone layout was the desktop's own components bent to fit 360px, and
 * it was removed. The phone face is a face of its own: it may use anything in `src/` that is not
 * welded to the desktop — the presentational components, `ipc`, the data hooks, the domain
 * logic — and nothing that is. A component it wants that *is* welded gets changed to take props,
 * in `src/`, so both faces gain.
 *
 * `share/SharePage.test.tsx` walks its bundle's graph the same way, and its two lessons are kept:
 * relative specifiers are followed as well as `@/…` ones, and a side-effect or dynamic import
 * counts. One thing is different on purpose — **a type-only import is not an edge**. `nav.ts`
 * imports `ViewId` from the store as a type, which costs nothing at runtime, and the phone's tab
 * bar reads its words from `nav.ts`.
 */
describe("the phone face's import graph", () => {
  const sources = import.meta.glob("../../src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const light = import.meta.glob("../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  /** Every specifier a module names at runtime — `from "x"`, a bare `import "x"`, `import("x")`. */
  function specifiersOf(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      // `import type … from` and `export type … from` carry no runtime edge.
      .replace(/\b(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["']/g, " ");
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
    return [...code.matchAll(pattern)].map(([, spec]) => spec);
  }

  /** `a/b/../c` → `a/c`, keeping the leading `..` that reaches out of `mobile/phone/`. */
  function normalise(path: string): string {
    const out: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  // Tests, stories, and the test harness — which installs a fake world and so reaches the store
  // on purpose. Matched with or without a leading directory: the keys are normalised below.
  const isTest = (key: string) =>
    /\.(test|stories)\.tsx?$/.test(key) || /(^|\/)testing\.tsx$/.test(key);

  const files: Record<string, string> = {};
  for (const [key, source] of Object.entries({ ...sources, ...light }))
    if (!isTest(key)) files[normalise(key)] = source;

  function resolve(from: string, spec: string): string | null {
    let stem: string;
    if (spec.startsWith("@/")) stem = normalise(`../../src/${spec.slice(2)}`);
    else if (spec.startsWith(".")) stem = normalise(`${from.split("/").slice(0, -1).join("/")}/${spec}`);
    else return null;
    for (const candidate of [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`])
      if (candidate in files) return candidate;
    return null;
  }

  /** The desktop's own: its store, its shell, its boot, and its window verbs. */
  const FORBIDDEN_FILES = [
    "../../src/lib/store.ts",
    "../../src/App.tsx",
    "../../src/components/AppShell.tsx",
    "../../src/components/TitleBar.tsx",
    "../../src/components/Ribbon.tsx",
    "../../src/lib/window.ts",
  ];
  const forbiddenFile = (file: string) =>
    FORBIDDEN_FILES.includes(file) || file.startsWith("../../src/boot/");

  /** Tauri's API is reached through `lib/core` and nowhere else. */
  const TAURI_DOOR = "../../src/lib/core/tauri.ts";

  it("skips a type-only import and keeps every other kind", () => {
    const specs = specifiersOf(`
      import type { ViewId } from "@/lib/store";
      export type { Place } from "../routes";
      import { a, type B } from "@/lib/a";
      import "@/lib/side-effect";
      const lazy = await import("@/features/late");
      // a comment naming "@/lib/store" must not count
    `);
    expect(specs).toEqual(["@/lib/a", "@/lib/side-effect", "@/features/late"]);
  });

  it("reaches no desktop store, no desktop shell and no Tauri window", () => {
    const seen = new Set<string>();
    // Every file under `mobile/phone/`, which is this file's own directory.
    const queue = Object.keys(light)
      .map(normalise)
      .filter((key) => !key.startsWith("..") && !isTest(key));
    expect(queue.length).toBeGreaterThan(10);

    const found: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = files[file];
      if (source === undefined) continue;
      for (const spec of specifiersOf(source)) {
        if (spec.startsWith("@tauri-apps/") && file !== TAURI_DOOR) found.push(`${file} → ${spec}`);
        const target = resolve(file, spec);
        if (target === null) continue;
        if (forbiddenFile(target)) found.push(`${file} → ${target}`);
        else queue.push(target);
      }
    }

    expect(found).toEqual([]);
    // The walk is worthless if it never left `mobile/phone/`. These are reached only by going
    // through a page, a hook and the mirror — so they prove the walk went the distance.
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "../../src/components/CardArt.tsx",
        "../../src/components/CardTile.tsx",
        "../../src/features/search/useCardSearch.ts",
        "../../src/lib/ipc.ts",
        "../routes.ts",
      ]),
    );
    expect(seen.size).toBeGreaterThan(40);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run mobile/phone/fence.test.ts`
Expected: PASS, 2 tests. **If `found` is not empty, do not weaken the fence** — the listed file reaches something it may not. Fix the import: use the data hook rather than the page, or pass the value in as a prop.

- [ ] **Step 3: Prove the fence can fail**

Temporarily add `import { useAppStore } from "@/lib/store";` and `void useAppStore;` to `mobile/phone/Shell.tsx`. Run the fence again.
Expected: FAIL, naming `Shell.tsx → ../../src/lib/store.ts`. Remove the two lines and run once more — PASS.

- [ ] **Step 4: Write `mobile/CLAUDE.md`**

```markdown
# mobile — the light app

A second app over the same `src/` components and the same Rust core: card search, decks,
collection, wishlist and scanner, for Android and for browsers. The design is
[the light-app spec](../docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md);
read §3 before changing anything here.

**Light is the menu and the face, never the data.** A light install runs the same commands
against the same two databases. What it leaves out is destinations.

## One app, two faces

`LightApp` picks a face by the viewport's width and by nothing else.

| Viewport | Face | Lives in |
| --- | --- | --- |
| ≥ 1024px (`DESKTOP_FLOOR_PX`) | **The desktop UI itself**, in the light edition | `src/`, hosted by `DesktopFace.tsx` |
| < 1024px | **The phone face** | `mobile/phone/` |

Each is a lazy chunk. The URL is what they share: `routes.ts` is the one spelling of where the
reader is, the phone face reads it through `phone/router.ts`, and the desktop face through
`useDesktopPlace.ts`, which maps it onto the desktop store so that no router enters `src/`.

**Every component is drawn only at the widths it was designed for.** That is the whole lesson of
the phone layout removed on 2026-09-27: desktop components bent down to 360px. Do not add a
narrow branch to a desktop page, and do not stretch a phone page past 1024.

## The edition

`src/lib/edition.ts`. The desktop shell reads an `Edition` from context — which rail rows to draw,
whether to draw a caption, which chords act — and the full edition is the default, so the desktop
app provides nothing. **A page never reads the edition, and nothing under `src/` asks where it is
running.** If a page needs something only a desktop can answer, that is answered below the `Core`
seam, not by a branch in the page.

A chord for a view outside the edition is **inert**; the digits do not move between editions.

## What the phone face may import

Anything in `src/` whose import graph does not reach `@/lib/store`, `@/App`,
`@/components/{AppShell,TitleBar,Ribbon}`, `@/boot/*`, `@/lib/window`, or a `@tauri-apps/*` module
other than through `@/lib/core`. `phone/fence.test.ts` walks the graph and enforces it; a
type-only import is not an edge.

In practice that is the presentational components, `ipc.ts` and its types, the TypeScript domain
logic, **and the desktop's own data hooks** — `useCardSearch`, `useDecks`, `useCollection` and
`useWishlist` were all clean when this was written, and the phone pages call them rather than
writing a second query for the same list.

**When the phone face wants a component that reaches the store, change the component to take
props, in `src/`.** Do not copy it, and do not weaken the fence.

Files in `mobile/` outside `phone/` — the entry, `LightApp`, `DesktopFace` — are not under the
fence: hosting the desktop face is their job.

## Running it

| Command | Backend | Use it for |
| --- | --- | --- |
| `npm run mobile:dev` | The Storybook fake, by the four aliases Storybook uses | UI work in any browser. No Rust, no lock. `?art=live` draws real pictures |
| `npm run mobile:tauri` | The real Rust core and the dev database | Checking against a real corpus, in a 412 × 915 window |

`mobile:tauri` is the desktop binary with a config overlay (`src-tauri/tauri.light.conf.json`): it
**takes the `app` lock** and reads `src-tauri/target/debug/data`. Read the `running-the-app` skill
first. Widen the window past 1024 and the face changes.

Both dev servers use port **5175**, so they cannot run at once.

Fake mode has **no startup gate**: the fake answers no `startup_status`, and the gate reads a
rejected ask as "still loading".

## Tests

`mobile/**/*.test.{ts,tsx}` runs in the one Vitest suite. A test that renders phone UI mocks
Tauri's three API modules with the fake's **in the test file itself**, and renders through
`phone/testing.tsx`'s `renderPhone`, which installs a fake world. **Never mock `@/lib/images`.**
A wall is virtualised, so a test that expects tiles calls `installLayout()` first.

`npm run mobile:build` is in neither `verify` nor CI, like `share:build`.

## Not here yet

Android, the WASM core, a service worker, sync and pairing UI, any write from the phone face, the
filters sheet, and Storybook stories for phone UI — Storybook's globs do not reach `mobile/`.
```

- [ ] **Step 5: Point the root files at it**

Root `CLAUDE.md`, in the "Where the rules live" table, after the `.github/CLAUDE.md` row:

```markdown
| [`mobile/CLAUDE.md`](mobile/CLAUDE.md) | The light app — the Android and web face: the two faces, the edition, what the phone face may import |
```

Root `CLAUDE.md`, under `## Commands`, after the `npm run storybook` line:

```markdown
- `npm run mobile:dev` / `mobile:tauri` — the light app, over the Storybook fake in a browser or
  over the real core in a phone-sized window. See [`mobile/CLAUDE.md`](mobile/CLAUDE.md).
```

`src/CLAUDE.md`, in the Layout table, after the `share/` row:

```markdown
| `mobile/` (repo root) | **The light app** — a third Vite entry. At ≥ 1024px it draws this program's own pages under the light `Edition` (`lib/edition.ts`); below that, a phone face of its own. [`mobile/CLAUDE.md`](../mobile/CLAUDE.md) |
```

And in `src/CLAUDE.md`'s Binding rules, replace the bullet that begins **"There is no viewport branch in the app."** with:

```markdown
- **There is no viewport branch in the app, and the light app's is not in `src/`.** The desktop
  window's floor is `DESKTOP_FLOOR_PX` (1024, quoted from `tauri.conf.json`) and every fold answers
  its own box; the one branch there was, `useNarrowWindow`, went with the phone layout on
  2026-09-27. The light app picks between this UI and a phone face by viewport width — in
  `mobile/useFace.ts`, which is the only place that question is asked. What `src/` reads instead is
  an **`Edition`** (`lib/edition.ts`), handed to the shell at the root: which rail rows to draw and
  whether to draw the caption. **A page never reads it.**
```

- [ ] **Step 6: Commit**

```
git add mobile/phone/fence.test.ts mobile/CLAUDE.md CLAUDE.md src/CLAUDE.md
git commit -m "test(light): fence the phone face's imports, and write the light app's rules down"
```

---

### Task 9: Fan-in — verify, and drive both run modes

**Files:** none created. Fixes land in the files the earlier tasks own.

- [ ] **Step 1: The whole suite, once**

Run: `npm run verify`
Expected: green — build, lint, `cargo fmt --check`, clippy, Vitest, `cargo test`, and the scanner crate's tests. This is the first time anything outside a task's own file has run. **Never run two `verify`s at once**, in this worktree or beside another.

Likely first failures, and what each means:
- `react-hooks/set-state-in-effect` or `react-hooks/refs` in a `mobile/` file — a rule that only goes red here. Fix the code; do not disable the rule.
- A source sweep under `src/lib/*.test.ts` (tokens, layers, motion) naming a `mobile/` or `src/components/CardTile.tsx` line — read the sweep's own message; it names the class it refuses.
- `ipc.test.ts` or `fake/parity.test.ts` — nothing in this plan adds a command, so one of these red means an unintended edit.

- [ ] **Step 2: Drive fake mode at phone width**

Start `npm run mobile:dev` in the background and open `http://localhost:5175/` in the built-in browser, sized to **360 × 800** (`resize_window` with a custom size, then reload so load-time gates re-run).

Confirm, reading the page rather than screenshots where possible:
- Five tabs — Search, Decks, Collection, Wishlist, Scanner — and Search is current.
- The wall draws **two** columns of card tiles. Read two adjacent tiles' rects: equal `top`, different `left`.
- No horizontal scroll: `document.documentElement.scrollWidth === clientWidth`.
- Each tab is at least 44px tall and wide.
- Typing `bolt` narrows the wall; a tile opens the card sheet; the URL gains `?card=`; the browser's Back closes it.
- Decks lists decks; one opens to its cards; Back returns to the list.
- The console holds no error.

- [ ] **Step 3: Drive fake mode at desktop width, in the same tab**

Resize to **1280 × 800** without reloading.

Confirm:
- The face changed: a left rail, the ribbon, the mana line.
- The rail's rows are exactly Search, Decks, Collection, Wishlist, Scanner, Settings (and the Collapse control). No Home, Tagger, Trade or Playtesting.
- No window caption — nothing in the page carries `data-tauri-drag-region`.
- The destination survived the swap: resize on `/collection` and the desktop face is on Collection.
- Pressing a rail row moves the URL; Back moves the rail.
- Resize back to 360 × 800: the phone face returns, on the same destination.

- [ ] **Step 4: Drive the real core**

Stop the fake server (both use 5175). Follow the `running-the-app` skill to take the `app` lock, then run `npm run mobile:tauri`. First launch compiles the crate.

Confirm:
- The window opens at about 412 × 915 with the OS frame, not at 1280 × 720.
- Search draws real card images from the dev database's corpus. If the worktree has no `src-tauri/target/debug/data`, the first-run sync starts — see the `worktree-setup` skill's `live-data.md` for copying the main checkout's data folder instead.
- Decks, Collection and Wishlist show the dev database's own rows.
- Widening the window past 1024px swaps in the desktop face with six rail rows.
- The app does **not** land on Home, whatever the desktop's stored start view is.

Release the lock when done.

- [ ] **Step 5: Confirm the desktop is untouched**

With the light app stopped and the lock taken again, run `npm run tauri dev`.
Confirm: the window opens at its usual size with its own caption, the rail has all eleven rows with Home first, and `Ctrl+1` lands on Home. Release the lock.

- [ ] **Step 6: Record what the live pass measured**

Create `docs/reference/light-app.md` holding what Steps 2–5 actually read, each figure with its date, the build (debug) and the viewport: the phone wall's column count and tile width at 360px, the tab bar's height, the widths at which the face swaps, and anything the pass found that the suite could not. Add a row for it to the root `CLAUDE.md`'s Reference docs table. **Write down only what was measured** — no figure from this plan is a measurement.

- [ ] **Step 7: Commit, and stop**

```
git add docs/reference/light-app.md CLAUDE.md
git commit -m "docs: the light app's first live pass"
```

Do not open a PR as part of this plan. Report what was verified and what was not, and hand back.

---

## Self-review notes

- **Spec §10.1 coverage:** entry and build → Task 4; edition seam → Task 1; phone shell, `CardTile`, Search, the three lists, Scanner placeholder → Tasks 3, 6, 7; the switch and URL adapter → Task 5; the fence → Task 8; `mobile/CLAUDE.md` and the root row → Task 8; both run modes → Tasks 2, 4, 9; the one Rust edit → Task 2.
- **Two places this plan departs from the spec as first written, both amended in the spec in the same commit as this plan:**
  1. **Chords.** The spec said `Ctrl+1…9` "binds against the edition's views". Reading `AppShell.tsx` showed its own rule — a digit must never mean two things to two readers — so an out-of-edition chord is **inert** and the digits do not move.
  2. **Stories.** The spec listed "stories for the shell under `Mobile/*`". Storybook's story glob, its stylesheet source and `src/stories.test.tsx`'s module glob all stop at `src/`; widening three globs for one story is phase 3's, when the pages that need a catalogue exist. `CardTile` gets a story now because it lives in `src/`. The skeleton's workbench is `mobile:dev`.
- **`Edition.settings`** — the spec's interface lists it; phase 1 builds no light Settings list, so the field is added in phase 3 with its first reader.
