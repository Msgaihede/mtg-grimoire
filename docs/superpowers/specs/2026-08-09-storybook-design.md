# Storybook — Design

**Date:** 2026-08-09
**Repo:** `github.com/Msgaihede/mtg-grimoire`
**Status:** approved, ready to plan

## Goal

A component workbench and catalogue for the React frontend: every visual state of every
component reachable in one click, without seeding SQLite or driving the real window over
CDP. Three jobs, chosen deliberately and in this order:

1. **Design workbench** — iterate on look and feel in isolation. This is the gap the
   current setup actually has: `CLAUDE.md`'s "Verifying UI in the real app" protocol is
   excellent at proving a flow works and terrible at *composing* one, because reaching a
   state costs a seeded database and a live window.
2. **Living catalogue** — browsable documentation of what exists, built from the JSDoc the
   components already carry.
3. **Accessibility auditing** — `addon-a11y` runs axe per story. The components lean hard
   on accessible names (`OwnedBadge`'s `sr-only` counts, `RarityGem`'s word-as-name,
   `ManaText`'s load-bearing trailing space), so this has teeth here.

**Visual regression is deliberately out of scope.** No Chromatic, no screenshot runner, no
`@storybook/addon-vitest`. Stories-as-tests would duplicate a Vitest suite that already
covers behaviour, and would drag in browser-mode Playwright for it.

## Starting state

- No `.storybook/`. Storybook has never been installed.
- 30 components across `src/components` and five `src/features/*` directories, ~19.7 k
  lines including their colocated tests.
- Every data-touching module reaches Rust through one seam: `src/lib/ipc.ts`, a
  hand-written mirror of the `#[serde(rename_all = "camelCase")]` structs, over
  `@tauri-apps/api`'s `invoke`.
- Card art is served over the `mtgimg://` custom protocol and drawn through
  `components/CardImage`.
- `tsconfig.json` includes `["src"]` only. `index.css` runs `source(none)` with two
  explicit `@source` entries. `eslint` runs `--max-warnings 0`.
- Storybook 10.5.7 is current and supports React 19 + Vite 7 (checked 2026-08-09).

## Decisions

### The fake sits under `ipc.ts`, not over it

Three modules are swapped by **Vite alias** in `.storybook/main.ts`. No component and no
app file changes.

| Real module | Storybook alias | What it fakes |
|---|---|---|
| `@tauri-apps/api/core` | `.storybook/fake/core.ts` | `invoke` |
| `@tauri-apps/api/event` | `.storybook/fake/event.ts` | `listen` — `sync:progress`, `collection:reconciled` |
| `@/lib/images` | `.storybook/fake/images.ts` | re-export, overriding **only** `cardImageUrl` |

Aliasing `invoke` rather than `ipc.ts` is the decision. `ipc.ts` is the mirror that can
drift silently from Rust, and it is worth exercising; a fake beneath it means every story
proves the mirror as well as the component. A fake that replaced `ipc.ts` would prove
neither.

`fake/images.ts` re-exports the real module and overrides one function. The constants stay
real — `CARD_ASPECT`, `ART_ASPECT`, `IMAGE_RETRY_*` — because a frame at the wrong ratio is
the one thing a card workbench must not show, and `imageOrigin`'s platform rule is pinned
by a test that the fake has no business restating.

### The fake backend stores rows, not DTOs

`.storybook/fake/db.ts` holds `cards`, `collectionEntries`, `wishlistEntries`, `decks`,
`deckCards`. Command handlers derive DTOs the way Rust does.

This is the load-bearing choice. `ownedQuantity` appears on three DTOs and answers three
different questions — every copy of one printing and finish-blind on `CardSummary`, the
copies filling one wish and finish-**aware** on `WishRow`, a deck's *allocation* on
`DeckCard`. A fake storing DTOs would hard-code all three, they would agree, and the
stories would quietly teach a model the app does not have. Derived from rows, they come out
right without anyone deciding they should.

`format_specs_list` is served from the existing `src/features/decks/validation/fixtures.ts`
`SPECS`, never a second copy. That file's own header warns that a second hand-copied mirror
is a second place for a cell to drift from `schema.rs`'s `FORMAT_SPECS_SEED`.

**Rules the fake honours, because each is visible on screen:**

- Collection `setQuantity(0)` keeps the row; wishlist and deck `0` remove it. Three
  steppers, two behaviours, and the asymmetry is deliberate app design.
- Deck grain `(deck, card, zone)`: adding twice sums; `deck_swap_printing` onto an occupied
  slot folds and answers `folded: true` with the landed total.
- `needsReview` is a sentence that flags and never hides; the first message wins.
- Wishlist fulfillment is finish-aware — a foil wish reads 0 with the nonfoil in the binder.
- Search `owned: true` counts *entries*, so a row stepped to zero still passes it while its
  `ownedQuantity` reads 0.
- `total` caps at 5 000 with `totalIsCapped`, so the pager's `5,000+` caption is reachable.

**Rules it simplifies, documented in the file header:** FTS5 prefix matching becomes a
substring match over name and type line; the allocator is greedy over the fixture set
without cross-deck built subtraction. Neither difference is visible in a component, and
both are cheaper to state than to reimplement.

### Seeds and faults are state, not response stubs

A story selects a dataset; it does not stub a response. `parameters: { fake: { seed, fault } }`.

| Seed | What it is for |
|---|---|
| `empty` | first run — nothing synced, empty collection, no decks. Every zero state. |
| `starter` | the default. ~40 cards spanning the render branches: DFC, split, adventure, a Vehicle with a P/T box, hybrid and Phyrexian mana, `*` power, a game changer, partners, a companion, basics. A modest collection, three decks, some wishes. |
| `needsReview` | orphaned rows in all three user card tables, plus a folded migration. |
| `large` | past the 5 000 cap and deep enough to make the virtualisers real. |

Faults are a flag the handlers read, not an intercepted return: `busy` gives
`collection::BUSY` refusals, `syncError` a non-null `lastError`, `imageFailures` a non-zero
`imageStoreFailures`, `gone` a `deck_get` of `null` for the editor's GONE paragraph.

The reason for both: a stubbed response is a claim about what the backend *would* say, and
a claim can be wrong in a way nothing catches. A seed is an input the same code path reads,
so a story showing an empty collection is showing what an empty collection actually renders
as.

### Card art: synthetic by default, live on a toolbar switch

`cardImageUrl` resolves to a generated SVG data URI at the variant's exact dimensions,
carrying the card's name and set. Offline, deterministic, nothing committed, and it works
in a static `build-storybook`.

A toolbar global swaps it to real art fetched from `cards.scryfall.io`. Fixtures carry the
real Scryfall `image_uris` so the switch is a lookup rather than a second data path. This
is for the half of a card-app workbench that synthetic placeholders cannot serve: how an
actual illustration sits in a tile, a zone row's `art` crop, the pane's `display` variant.

**No card images are committed to the repo.** Card art is Wizards' and the artists'; a
handful of checked-in WEBPs would also only ever show the same handful of cards.

### Per-story isolation: two singletons must be re-created

`src/lib/query.ts` exports a module-singleton `QueryClient`, and `useAppStore` is a
module-singleton zustand store. Shared across stories, the first leaks its cache into the
second and "empty collection" renders the previous story's rows.

A decorator therefore builds a fresh `QueryClient` per story, and resets the store — whose
fields (`activeView`, `selectedCardId`, `openDeckId`, `paneDeckContext`) are themselves
story inputs. A `CardDetailPane` with deck context is a different story from one without,
and that difference lives only in the store.

### The canvas is dark, because the app is

`preview.tsx` imports `index.css`, `mana-font/css/mana.css` and `keyrune/css/keyrune.css`
exactly as `main.tsx` does. `preview-head.html` sets `<html class="dark">`. The app is
dark-only by design (spec §7) and `:root`/`.dark` carry identical values — a light canvas
would be a state the app cannot reach.

## Story inventory

30 components, three tiers, ~128 stories. Colocated as `*.stories.tsx` beside each
component, matching the existing `*.test.tsx` convention.

### Tier 1 — presentational, props only, no backend (10 components, ~44)

| Component | Use cases |
|---|---|
| `ManaText` | generic, hybrid `{W/U}`, Phyrexian `{U/P}`, `{X}`, `{C}`, `{S}`, a token the font has no glyph for (braces fallback), `null` → renders nothing, inline in oracle text |
| `ManaLine` | idle gradient (`sync: null`), determinate, indeterminate (`value: null`, which omits `aria-valuenow`), each sync phase |
| `RarityGem` | all six rarities and `null`, `withLabel` on and off — including `special`/`bonus`, which have no colour token and fall back to the hairline |
| `OwnedBadge` | renders nothing at 0-and-unwished, owned only, wishlisted only, both, four-digit count |
| `QuantityStepper` | `sm` and `md`, at min, at max, mid-typing draft (the empty box between "1" and "12") |
| `CardImage` | fresh load, **swap card mid-flight**, failed load showing `alt`, decorative `alt=""` |
| `Figure` / `FigureRow` | value, with note, with `title` as-of, the em-dash in-flight state, a full row |
| `FilterChips` | single- and multi-select, mana values 0–8, colours, rarity, none selected, overflow |
| `CollectionSummaryHeader` | `undefined` (all em dashes), full, unpriced notes, tradelist present and absent, needs-review count |
| `DropIndicator` | alone, and on a zone's top edge |

`CardImage`'s swap story is the one worth building deliberately. `CLAUDE.md` records that
the stale-frame bug is *"invisible to the DOM and therefore to the test suite in the obvious
place… what a person can see is a screenshot"* — setting `src` resets `complete` and
`naturalWidth` while the old frame stays painted. A story that swaps the card under a slow
image is the surface where a human can see it, which is exactly what the test suite cannot
give.

### Tier 2 — prop-driven composites, fixtures (12 components, ~49)

- **`CardGrid`** — results wall, empty, image-failed tile, owned/wishlisted badges, drag
  payload on and off, narrow container (column count), long names
- **`CollectionTable`** — rows, empty, needs-review sentence, orphan row with null card
  fields, foil and etched, graded, zero-quantity row, each sort
- **`DeckStats`** — curve, colours, types, price, empty deck, commander deck, maybe pile
- **`ValidationPanel`** (~9, the largest) — legal, size, copy limits, singleton, **both**
  restricted semantics, commander eligibility, partners, companion, orphans, bracket advisory
- **`PrintingPreview`** — single-faced, DFC with flip, no image, retry, artist credit
- **`FilterBar`** and **`CollectionFilterBar`** — default, active filters, cleared
- **`Ribbon`** — idle, syncing, error, card count
- **`SetCombobox`** — closed, open, filtered, no match, selected
- **`AppShell`** — each active view, sidebar drop target live, and inert with no deck open
- **`ZoneColumn`** — populated, empty, below the 17rem container query (dense text row),
  orphan row fed `null`
- **`SyncProgress`** — each phase (`checking`, `downloading`, `ingesting`, `reclaiming`,
  `sets`, `compacting`), `done`, `error`, and the throttled run that emits nothing at all

### Tier 3 — connected, fake backend + seeds (8 components, ~35)

`SearchPage`, `CollectionPage`, `WishlistPage`, `DecksPage`, `DeckEditor`,
`DeckSearchPanel`, `CardDetailPane`, `AddToCollection` — each across `starter`, `empty`,
`needsReview`, and where it matters `large` (virtualiser, the `5,000+` cap) and the `busy`
fault.

`DeckEditor` takes four more: a deck with a commander, the GONE paragraph, the Built toggle,
and a swap that folds two rows into one.

### Docs-only

A **Design system** section rendering the palette tokens, type scale and the mana/set glyph
sets from `index.css` — the catalogue job, and the one page that is documentation rather
than a component.

## Integration

Five existing configs force changes. Each is a silent failure if missed.

1. **`tsconfig.json` gains `.storybook` in `include`.** It is `["src"]` today. Stories under
   `src/` are already type-checked by `npm run build`; the fake backend would not be — and it
   mirrors every DTO in `ipc.ts`, so untyped it drifts exactly the way that file's header
   warns the Rust mirror can.
2. **`index.css` gains `@source "../.storybook"`.** It runs `source(none)` with two explicit
   sources, and its header states that an unlisted directory is a silently missing style.
   Decorators carry classes.
3. **`eslint.config.js` gains a block for `.storybook` with Node globals**, as the one for
   `scripts` already has — `main.ts` runs in Node. Plus `eslint-plugin-storybook`.
   `--max-warnings 0` means stories must be clean, not merely compiling.
4. **`.gitignore` gains `storybook-static/`.**
5. **`vite.config.ts`'s `test.include` widens to reach `.storybook`**, so the fake
   backend's own tests run in the existing suite. See *Testing* below for what they cover.

Vitest's current `include: ["src/**/*.test.{ts,tsx}"]` does not collect `*.stories.tsx`,
and the widening in point 5 keeps that true — it adds `.storybook/**/*.test.ts`, not the
stories. The two suites never collide.

**Scripts:** `npm run storybook` (dev, port 6006) and `npm run build-storybook`.

**Dependencies**, all `10.5.7`: `storybook`, `@storybook/react-vite`,
`@storybook/addon-a11y`, `@storybook/addon-docs`; plus `eslint-plugin-storybook`.

### `npm run verify` is unchanged, and CI gains no job

Points 1 and 3 mean every story and the whole fake backend are type-checked and linted on
every `verify` and therefore on every CI run — a broken story already fails `ci-ok` through
the existing `frontend` job. Adding `build-storybook` would roughly double verify's wall
time to catch a class of error the type-checker has largely already caught.

No GitHub Pages publish either: this is a single-maintainer app, and a hosted catalogue with
one reader is overhead.

## Testing

Storybook is not a test surface here — that is the point of leaving `addon-vitest` out. What
is checked, and how:

- **Type safety** — `tsc` over `src` and `.storybook`, in `npm run build`. This is the real
  guarantee: a story that names a prop that no longer exists fails the build.
- **Lint** — `eslint` with `eslint-plugin-storybook`, `--max-warnings 0`.
- **Accessibility** — `addon-a11y` per story, read by a human. Not gated, because axe
  reports on rendered stories and a story is allowed to render a deliberately broken state.
- **The fake backend's derivations** get colocated Vitest tests under `.storybook/fake/`
  for the four rules that are easy to get wrong and invisible when wrong: the three
  `ownedQuantity` derivations, the collection-keeps-zero / wishlist-removes-zero asymmetry,
  the deck grain fold, and finish-aware fulfillment. These run in the existing suite, via
  the `test.include` widening at Integration point 5.

## Out of scope

- Visual regression, screenshot diffing, Chromatic.
- Stories as tests (`@storybook/addon-vitest`, `play` functions as assertions). `play`
  functions may still be used to *set up* a state a story needs.
- A hosted catalogue.
- Committed card images.
- Any change to a component's source to make it storyable. If a component cannot be storied
  without editing it, that is a finding to raise, not a licence to edit.
