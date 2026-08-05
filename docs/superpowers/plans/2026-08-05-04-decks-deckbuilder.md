# Plan 4/6: Decks & Deckbuilder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app grows its third pillar: decks. Schema v5 adds `decks`, `deck_cards`, `deck_allocations` and a **data-seeded `format_specs`** table covering all 23 Scryfall legality keys plus the `casual`/`limited` pseudo-formats; the reconciler learns deck rows and the one place an enforced foreign key exists is designed around its own fold; a **TypeScript validation engine** (spec §3: validation is TS, tested in Vitest) answers deck size, copy limits, restricted semantics, singleton exceptions by exact phrase, commander eligibility, partner/Background/companion pairing, colour identity and per-printing Old School — as data driven from `format_specs` + card legalities, never as per-format code; and a deckbuilder UI ships: a deck gallery with card-art covers, a zone editor with drag-and-drop (pragmatic-drag-and-drop, versions verified), a docked search panel built from the search view's own parts, live stats, a validation panel with precise human messages, and owned-vs-missing through non-destructive allocations with a one-click "missing → wishlist".

**Architecture:** One migration step, **v5**, does all the DDL: the four deck tables (with the FK design the Plan-3 review gated on — see Global Constraints), the `format_specs` seed (25 rows of *data*, so a rules change is an UPDATE and not a release), `decks.archived` (spec §7 "duplicate/archive"), and two new `cards` columns — `power`/`toughness`, backfilled through `schema::json_raw` exactly as v3's `artist` was — because commander eligibility ("Vehicle or Spacecraft with a P/T box") is unanswerable without them. Rust gains one module, `deck.rs`: CRUD, zone writes that denormalize the printing at write time, a deck read that carries every card fact the TS engine needs (including `ever_uncommon` for PDH and per-printing `legalities` for Old School), the greedy allocator behind availability, and `deck_missing_to_wishlist`. `reconcile.rs` extends its merge/sweep to `deck_cards` and repoints `deck_allocations` inside `fold_into_existing` *before* the row delete. React gains `src/features/decks/`: gallery, editor, docked search panel, drag-and-drop, stats, validation panel — and `src/features/decks/validation/` is the pure-TS engine with the plan's heaviest test matrix. Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md` §6 (data model), §7 (Deckbuilder), §3 (the TS/Rust boundary). Format data: `docs/superpowers/research/2026-08-04-mtg-domain-rules.md` — **the source for every number seeded here**. Carryover: `docs/superpowers/notes/plan-3-carryover.md` (the MUST-DO list, the three parked folds, THE FK design gate).

**Tech Stack:** Tauri 2.11.5, React 19, TypeScript 6.0.x, Vite 7, Tailwind CSS v4, TanStack Query 5, @tanstack/react-virtual 3, zustand 5, rusqlite 0.40 (bundled, FTS5), Vitest 4, httpmock 0.8. **New npm dependencies (versions verified live on npm, 2026-08-05):** `@atlaskit/pragmatic-drag-and-drop@2.0.2`, `@atlaskit/pragmatic-drag-and-drop-hitbox@2.0.0`, `@atlaskit/pragmatic-drag-and-drop-auto-scroll@3.0.0`. **Deliberately not adopted:** `@atlaskit/pragmatic-drag-and-drop-react-drop-indicator@4.1.1` — its dependency list (checked with `npm view`) pulls `@compiled/react`, a runtime CSS-in-JS that injects `<style>` elements the shipped CSP (`style-src 'self'`, no `unsafe-inline` — `tauri.conf.json`, pinned by `the_shipped_csp_allows_ipc_and_images_and_nothing_wild`) refuses, plus `@atlaskit/tokens`, a foreign design-token system the visual direction forbids. The drop indicator is ~30 lines of our own, drawn from hitbox's closest-edge data in the app's tokens. The three adopted packages manipulate elements via native drag events and `element.style` (covered by the existing `style-src-attr 'unsafe-inline'`), use no portals and inject no stylesheets — Task 14 verifies this in the running app. No new crates.

## Global Constraints

Binding values, copied verbatim from the sources that own them. Do not paraphrase them into code.

**CLAUDE.md database invariants** — unchanged and still absolute:

- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with `foreign_keys=ON`). So: user tables reference `cards.id` **without an enforced foreign key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang` (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE` deletes the user's collection on the next refresh. Orphans are *flagged*, never deleted. **`decks.cover_card_id` and `deck_cards.card_id` both obey this: soft references, printing denormalized beside `deck_cards.card_id`, and Task 2 ships the swap-survival test.**
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the swap drops the table with its indexes and replays only that list. **v5's `power`/`toughness` are not indexed and the deck tables are not `cards`, so `CARDS_INDEXES` is untouched by this plan.**
- `CARDS_COLUMNS` is **frozen**. Add columns in a new `if v < N` step in `migrate` with `ALTER TABLE` (`create_staging` derives its layout from `PRAGMA table_info(cards)`, so staging follows automatically). **Task 2 adds `if v < 5` and ends it with the literal `PRAGMA user_version = 5`, never `SCHEMA_VERSION`.**
- **`raw` is a gzip BLOB from schema v3 on, and a bare `json_extract(raw, …)` is a hard error, not a NULL.** Any migration reading `raw` goes through **`schema::json_raw`**, with the guard *inside* the expression, never as a `WHERE` term. **The v5 `power`/`toughness` backfill reads `raw` and is guarded exactly as the v3 `artist` backfill is; the ladder test `the_v3_backfill_steps_over_a_row_whose_raw_is_not_json` is extended to walk to head over a gzip row.**
- `cards_fts` is external-content with no triggers. **The v5 backfill writes two unindexed columns and renumbers nothing, so no rebuild (v2/v3's reasoning, v2/v3's style of test).**
- Two connections: `AppState.db` writes, `AppState.db_read` is read-only. **Every deck read command goes through `db_read`; every write takes `AppState.db` through `db::lock_for(&state.db, db::WRITE_LOCK_WAIT)` and answers `collection::BUSY` if it cannot.**

**THE FK gate (plan-3 carryover, final review I6) — the design this plan was gated on:**

> `deck_allocations.collection_entry_id` as an enforced FK collides with the reconciler. `reconcile::fold_into_existing` DELETEs the source collection row during a Scryfall merge (the app's only non-user delete); `foreign_keys=ON` everywhere. CASCADE would silently destroy deck allocations on a merge; plain REFERENCES aborts the reconcile. Plan 4 must: repoint allocations to the fold survivor inside `fold_into_existing` BEFORE the delete, and choose FK actions per delete-site (CASCADE is right for user-initiated `remove_entry`, wrong for the fold).

The resolution, binding on Tasks 2 and 3: **enforced foreign keys exist only between user tables, and there are exactly three** — `deck_cards.deck_id → decks(id) ON DELETE CASCADE`, `deck_allocations.deck_id → decks(id) ON DELETE CASCADE`, `deck_allocations.collection_entry_id → collection_entries(id) ON DELETE CASCADE`. CASCADE is correct at both *user-initiated* delete sites (deleting a deck takes its list and its reservations; `collection::remove_entry` frees the reservations on copies that no longer exist). The one *non-user* delete — the fold — **repoints (and where the survivor is already allocated, folds) every allocation onto the surviving entry before the DELETE runs**, so its CASCADE fires over nothing. Task 3 ships the test that proves a fold never costs a deck its reservation. Nothing else in the schema ever declares `REFERENCES`, and nothing ever declares it against `cards`.

**Validation is TypeScript (spec §3)** — *"TypeScript owns domain logic: deck/format validation, import format detection/parsing, export generation. This keeps the most intricate, most test-heavy logic in fast Vitest cycles, with card data supplied via IPC queries."* Rust supplies **facts** (Task 5's `DeckCardRow`: legalities, colour identity, oracle text, P/T, `ever_uncommon`, `game_changer`); TS draws every **conclusion** (Tasks 8–10). No legality rule, copy limit or eligibility test is ever expressed in SQL or Rust. The engine is **data-driven from `format_specs` + card `legalities`** — a new format is a seeded row, not a code branch.

**Format data (research doc, binding — the seed in Task 2 is this table):** all 23 legality keys in Scryfall's emitted order (`standard, future, historic, timeless, gladiator, pioneer, modern, legacy, pauper, vintage, penny, commander, oathbreaker, standardbrawl, brawl, competitivebrawl, alchemy, paupercommander, duel, oldschool, premodern, predh, tlr`) plus `casual`/`limited`. Legality values: `legal | not_legal | restricted | banned`. The traps, verbatim:

- **TRAP A** — `restricted` is overloaded: vintage/timeless/oldschool = **max 1 copy**; duel/tlr = **BANNED AS COMMANDER** (singleton formats). Stored as `format_specs.restricted_semantic` (`max_one` | `banned_as_commander`), never inferred.
- **TRAP B** — `oldschool` is the **only printing-sensitive key** (Serra Angel `lea`/`3ed` legal, `8ed` not_legal). Deck cards reference printings and Task 5 returns each row's own `legalities`, so the engine reads the printing's answer and Old School comes out right with no special case — Task 8 proves it with a two-printings fixture.
- **TRAP C** — `paupercommander` covers the 99 only; uncommon PDH commanders return `not_legal`. Eligibility is computed: **printed at uncommon anywhere** (`DeckCardRow.ever_uncommon`, Rust EXISTS over `idx_cards_oracle`) **AND creature/Vehicle/Spacecraft**, need **not** be legendary.
- Singleton exceptions anchor **exact phrases**: `"A deck can have any number of cards named"` and `"A deck can have up to"` (Seven Dwarves ≤ 7, Nazgûl ≤ 9) — the naive substring `"any number of cards named"` has 3 false positives (library-search triggers). Re-derived from oracle text on every read, **never a hardcoded card list**. Plus basic lands (supertype `Basic`), unlimited.
- Commander eligibility (CR 903.3, 2026): legendary creature OR **Vehicle OR Spacecraft with a P/T box** OR `"can be your commander"` text. Brawl is broader (adds planeswalkers, CR 903.12c). Partner variants (702.124): `partner`, `partner—[same text]`, `partner with [name]` (mutual), `choose a Background`, `Doctor's companion`; never mixed (702.124f), never more than two (702.124g), combined colour identity (702.124c). Colour identity: **use Scryfall's precomputed `color_identity`** (it already folds in DFC backs 903.4d, adventures 903.4e, reminder-text exclusion 903.4c, colour indicators, and basic land types — so one subset check answers 903.5c *and* 903.5d).
- `game_changer` boolean on the card = the Game Changers list (53 cards live, **don't hardcode**). Brackets: advisory only, never hard validation.
- **NEVER derive one format from another** (Standard Brawl allows Arcane Signet + Command Tower though not Standard-legal; Brawl ≠ Historic-minus-bans).

**Prices — read the blob per finish. NEVER `cards.price_usd`.** A deck card names a printing, not a finish, so its unit price is the **nonfoil `usd` key of that printing** — the same "cheapest way to satisfy it" rule `WishRow.unitPriceUsd` already documents — computed explicitly from the `prices` blob, `NULL` when absent and counted as unpriced. `tix` is never summed with fiat, and every price on screen carries `PRICES_AS_OF` (spec §5).

**Quantity semantics per table (CLAUDE.md, user-data hard rules):** collection zero **keeps** the row; wishlist zero **removes** it (table CHECK `quantity > 0`); **deck cards side with the wishlist** — `CHECK (quantity > 0)`, a zone slot at zero holds no condition, no price and no story, so zero removes. All three refuse negatives through `collection::valid_quantity`. Every collection write still goes through `add_entry`/`update_entry` (grading canonicalization, tradelist clamp) — the allocator touches `deck_allocations` only, never `collection_entries`.

**Frontend design — binding.** Every UI task in this plan (11–15) opens by invoking the **`frontend-design` skill**, and `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is a specification, not a mood board. For this plan concretely:

- **Card art is the loudest element** — deck covers use the `art` variant and, because an art crop lacks the printed frame, **artist + `Card images © Wizards of the Coast · Data © Scryfall` appear in the same interface** (Scryfall policy, spec §5).
- **Colour appears only where it carries Magic meaning.** Colour pips in deck stats use the direction doc's **pie deep variants** (`W #F8E7B9, U #0E68AB, B #3B3A3E, R #D3202A, G #00733E`, gold `#D9B95C`, colorless `#C8C4BF`); curve bars, counts, prices are data — Geist Mono, `tabular-nums`, no colour. A validation error is `text-destructive`; there is no green "legal" badge.
- **The mana line stays the app's only progress bar.** The drop indicator is a static 2px `--color-accent` line — an affordance, not an animation.
- **Motion budget:** 150 ms ease on chip/nav/stepper state; nothing else; every transition carries `motion-reduce:transition-none`.
- **Escape closes one layer per press — a handshake, not a z-index** (CLAUDE.md). The validation popover is an `"inner"` layer (capture + `preventDefault`); the card detail pane stays `"outer"`. `useDismissOnEscape` orders exactly two rungs: **never two `"inner"` peers open at once.** A layer Escape dismissed hands focus back to its opener before React flushes the close.
- **Quality floor, unannounced:** gold focus outline on every interactive element, AA contrast, works down to 1024px width; sentence case, verbs on buttons ("Add to deck", "Send missing to wishlist").
- Drag-and-drop **never replaces** click-to-add: every drag has a keyboard/click path (spec §7 "click-to-add fallback everywhere").

**Process:** all work on `main`, one commit per task, message style `feat:`/`fix:`/`chore:`/`test:`, with the trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

**`npm run verify` must be green before every commit** (build + lint + Vitest + `cargo test`). `npm run lint` runs with `--max-warnings 0`. UI tasks verify in the running app over CDP (`scripts/cdp.mjs`) — every UI task in Plans 2–3 found something the suite could not.

## File Structure

```
mtg-collection/
├── package.json                                # M: the three pragmatic-drag-and-drop packages (T14)
├── src-tauri/src/
│   ├── schema.rs                               # M: migrate v5 (deck tables, format_specs seed,
│   │                                           #    power/toughness), SCHEMA_VERSION=5, grain
│   │                                           #    constants DECK_CARD_GRAIN/ALLOCATION_GRAIN (T2)
│   ├── card_row.rs                             # M: power/toughness fields, faces[0] fallback (T2)
│   ├── ingest.rs                               # M: power/toughness in the staging INSERT (T2)
│   ├── reconcile.rs                            # M: deck_cards join merge/flag/sweep; allocations
│   │                                           #    repointed inside fold_into_existing; transitive
│   │                                           #    merge resolution (same-day chains) (T3)
│   ├── deck.rs                                 # NEW: CRUD, zone writes, deck_get + card facts,
│   │                                           #      allocator, missing→wishlist, format_specs_list
│   │                                           #      (T4, T5)
│   ├── wishlist.rs                             # M: WishlistQuery.needs_review, WishRow.unit_price_eur (T6)
│   ├── images.rs                               # M: deck_cards joins prewarm_keys' UNION (T4)
│   ├── scryfall.rs                             # M: MAX_MIGRATION_PAGES 10 → 20 (T1)
│   ├── card.rs                                 # M: one stale doc figure (T1)
│   └── lib.rs                                  # M: command registrations (T4, T5, T6)
├── src/
│   ├── App.tsx                                 # M: Decks view mounts gallery/editor (T11, T12)
│   ├── lib/ipc.ts                              # M: deck DTOs + commands, FormatSpec, wishlist EUR/
│   │                                           #    needsReview (T6, T7)
│   ├── lib/store.ts                            # M: openDeckId (T7)
│   ├── lib/useSyncInvalidation.ts + .test.ts   # M: literal-key assertion; invalidate on error
│   │                                           #    after an ingest; +["decks"] (T1, T7)
│   ├── features/wishlist/useWishlist.ts        # M: needsReview filter state (T6)
│   ├── features/wishlist/WishlistPage.tsx      # M: EUR figure, needs-review chip (T6)
│   ├── features/collection/AddToCollection.tsx # M: one stale doc figure (T1)
│   ├── features/card/CardDetailPane.tsx        # M: one stale doc figure (T1)
│   └── features/decks/
│       ├── useDecks.ts / useDeck.ts            # NEW: gallery + editor queries and mutations (T7)
│       ├── useFormatSpecs.ts                   # NEW: the seeded table, cached like sets (T7)
│       ├── DecksPage.tsx                       # NEW: gallery, create/duplicate/archive/delete (T11)
│       ├── DeckEditor.tsx                      # NEW: header, zones, layout (T12)
│       ├── ZoneColumn.tsx                      # NEW: one zone's rows, group-by, steppers (T12)
│       ├── DeckSearchPanel.tsx                 # NEW: docked search from the search view's parts (T13)
│       ├── dnd.ts + DropIndicator.tsx          # NEW: drag data contracts, the 2px indicator (T14)
│       ├── DeckStats.tsx                       # NEW: curve, pips, counts, price, owned/missing (T15)
│       ├── ValidationPanel.tsx                 # NEW: issues popover + bracket advisory (T15)
│       └── validation/
│           ├── types.ts                        # NEW: CardFacts, DeckZone, Issue, FormatSpec (T8)
│           ├── engine.ts + engine.test.ts      # NEW: validateDeck — size/copies/legality (T8)
│           ├── singleton.ts + .test.ts         # NEW: exact-phrase exceptions, basics (T8)
│           ├── commanders.ts + .test.ts        # NEW: eligibility, partners, colour identity (T9)
│           ├── companions.ts + .test.ts        # NEW: the ten companion conditions (T10)
│           └── bracket.ts + .test.ts           # NEW: advisory bracket estimate (T10)
└── docs/superpowers/plans/2026-08-05-04-decks-deckbuilder.md   # this file
```

Later plans build on: `deck.rs` + the zone model (Plan 5's deck-text import/export writes through `deck_add_card` exactly as the CSV importer writes through `collection_add`), `format_specs` (Plan 5's export headers; any future format is a row), the validation engine (Plan 5 validates imported decks with the same module), `DeckSearchPanel` (Plan 6's "add to open deck" from the global Search view), `decks.cover_image_path` + `cover_kind` (Plan 6's custom covers and licenses screen, which also owes the pragmatic-drag-and-drop Apache-2.0 NOTICE), and the allocator (Plan 6's rebalance polish).

---

### Task 1: The parked folds from Plan 3's final review

Plan 3's addendum names three residuals as **PLAN 4 EARLY FOLDS**, and they go first so the tree is honest before the migration lands: a test that asserts against its own constant (deleting `["sets"]` currently stays green), a swapped 116 k-row corpus that never invalidates when `/sets` fails after the swap (the `error` phase is all the frontend sees), and four doc figures still claiming the corpus size of 2026-08-04. While in `scryfall.rs`: the migration log is at 8 of the 10 pages the cap allows, and the warning when it overflows is an `eprintln!` nobody sees in release builds — raise the cap.

**Files:**
- Modify: `src/lib/useSyncInvalidation.ts`, `src/lib/useSyncInvalidation.test.ts`
- Modify: `src-tauri/src/scryfall.rs` (`MAX_MIGRATION_PAGES`), `src-tauri/src/schema.rs` (line 9 doc), `src-tauri/src/card.rs` (line 218 doc), `src/features/card/CardDetailPane.tsx` (line 106 comment), `src/features/collection/AddToCollection.tsx` (line 329 comment)

**Interfaces:**
- Consumes: `SyncProgressEvent`/`SyncPhase` (from `@/lib/ipc` — phases `"checking" | "downloading" | "ingesting" | "reclaiming" | "sets" | "compacting" | "done" | "error"`), `SYNC_INVALIDATED`, `queryClient` (from `@/lib/query`).
- Produces: no new exports. `useSyncInvalidation(progress: SyncProgressEvent | null): void` keeps its signature and gains one behaviour: **invalidate on `error` when this run reached `ingesting`**.

- [x] **Step 1: Write the failing tests**

Append to `src/lib/useSyncInvalidation.test.ts` (read the file first and reuse its existing render/mock idioms):

```ts
/**
 * The guard the constant could not be: asserting `SYNC_INVALIDATED` against itself let any
 * key be deleted with the suite still green. One literal list makes the contract real —
 * updating it is a *decision* (Task 7 makes exactly one, adding ["decks"]).
 */
it("invalidates exactly the five known roots", () => {
  expect(SYNC_INVALIDATED).toEqual([["cards"], ["collection"], ["wishlist"], ["card"], ["sets"]]);
});

/**
 * The gap plan-3 ledgered: a successful swap followed by a failed `/sets` surfaces as the
 * `error` phase — `do_sync` stores the ETag *before* fetching sets, so the run does not
 * retry, and the swapped 116k-row corpus never invalidates. The frontend can see the whole
 * story in the phases it already receives: an `error` after an `ingesting` means a run that
 * may have committed. (An error after `ingesting` but *before* the swap also matches;
 * invalidating then refetches unchanged data, which is cheap and correct.)
 */
it("invalidates on an error that follows an ingest, and not on one that does not", () => {
  const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  const { rerender } = renderHook(({ p }) => useSyncInvalidation(p), {
    initialProps: { p: phase("checking") },
  });
  rerender({ p: phase("error") });
  expect(spy).not.toHaveBeenCalled(); // a failed *check* changed nothing on disk

  rerender({ p: phase("checking") });
  rerender({ p: phase("ingesting") });
  rerender({ p: phase("error") });
  expect(spy).toHaveBeenCalledTimes(SYNC_INVALIDATED.length);

  // …and the flag does not leak into the next run: a later error with no ingest is quiet.
  spy.mockClear();
  rerender({ p: phase("checking") });
  rerender({ p: phase("error") });
  expect(spy).not.toHaveBeenCalled();
});
```

with a local helper `const phase = (p: SyncPhase): SyncProgressEvent => ({ phase: p, done: 0, total: 0, message: null });`.

- [x] **Step 2: Run and watch them fail** — `npm run test:run -- useSyncInvalidation`. The literal test passes immediately (it pins today's truth — it exists to catch tomorrow's deletion); the error-phase test fails: nothing invalidates on `error`.

- [x] **Step 3: Implement** — in `useSyncInvalidation.ts`, track the ingest with a ref (render-stable, and nothing renders from it):

```ts
export function useSyncInvalidation(progress: SyncProgressEvent | null): void {
  const phase = progress?.phase ?? null;
  // Whether the run in flight reached `ingesting` — the phase that means "the corpus on
  // disk may no longer be the one the cache described". `error` alone is ambiguous: most
  // errors are a failed 24 h check that changed nothing, but an error *after* an ingest
  // is the one reachable path (a network blip between the swap and `/sets`) where the
  // swapped corpus would otherwise never invalidate — the ETag is already stored, so the
  // next run is a 304 that emits no `done`.
  const sawIngest = useRef(false);
  useEffect(() => {
    if (phase === "checking" || phase === "downloading") sawIngest.current = false;
    if (phase === "ingesting") sawIngest.current = true;
    if (phase === "done" || (phase === "error" && sawIngest.current)) {
      sawIngest.current = false;
      invalidateAll();
    }
  }, [phase]);
  // …the collection:reconciled listener effect below is unchanged…
}
```

- [x] **Step 4: The doc sweep** — the corpus has been 116,590 since the 2026-08-05 sync and the final wave's cross-referencing docs already say so; four survivors contradict them. In each, replace the figure with a date-stamped one (`0 of 116,590 live rows (2026-08-05)` / `116 590 rows`): `schema.rs:9`, `card.rs:218`, `CardDetailPane.tsx:106`, `AddToCollection.tsx:329`. Doc text only — the `Ribbon.test.tsx`/`useSync.test.ts`/`AppShell.test.tsx` fixtures that feed `116,568` through a mocked `SyncStatus` are fixture data, not claims about the live corpus: leave them.

- [x] **Step 5: `MAX_MIGRATION_PAGES` 10 → 20** in `src-tauri/src/scryfall.rs`, updating the constant's doc with today's arithmetic: the live log is 2 569 entries (8 pages of 10); at ~1 000 entries/year the old cap had roughly two spare pages; unused pages cost nothing because the loop breaks on `has_more` long before the cap; and the overflow warning is an `eprintln!` that release builds never show, so headroom is the only real defence. `fetch_migrations_stops_at_the_page_cap` asserts against the constant and follows automatically — confirm it still passes.

- [x] **Step 6: Verify and commit** — `npm run verify` green, then:

```
chore: fold plan-3 review residuals (invalidation guard, error-after-ingest, doc figures, migration page cap)
```

---

### Task 2: Schema v5 — deck tables, the format_specs seed, and power/toughness

One migration step, everything DDL this plan needs. The four deck tables land with the FK design from Global Constraints (the only three enforced FKs in the schema, all user↔user). `format_specs` is **seeded data** — the research doc's format table, row for row, so the validation engine reads rules rather than embodying them. And `cards` gains `power`/`toughness` by the v3 `artist` playbook (ALTER + guarded backfill + ingest writes them), because "Vehicle or Spacecraft **with a P/T box**" (CR 903.3) is a commander-eligibility fact nothing else can answer: single-faced cards have `faces` NULL, and `raw` is a gzip BLOB nothing reads at runtime.

**Files:**
- Modify: `src-tauri/src/schema.rs` (`SCHEMA_VERSION = 5`, the `if v < 5` step, `DECK_ZONES`, `DECK_CARD_GRAIN`, `ALLOCATION_GRAIN`, `FORMAT_SPECS_SEED`), `src-tauri/src/card_row.rs` (two fields + face-0 fallback), `src-tauri/src/ingest.rs` (two columns in the staging INSERT)

**Interfaces:**
- Consumes: `schema::json_raw` (the gzip guard — mandatory for the backfill), `COLLECTION_GRAIN`'s style for grain constants, `crate::card_row::CardRow`.
- Produces:

```rust
// src-tauri/src/schema.rs
pub const SCHEMA_VERSION: i64 = 5;
/// The five deck zones, spec §6 verbatim. CHECK-constrained in SQL and mirrored in TS.
pub const DECK_ZONES: [&str; 5] = ["main", "side", "commander", "companion", "maybe"];
/// What makes two deck-card rows the same row: one printing in one zone of one deck.
pub const DECK_CARD_GRAIN: &str = "deck_id, card_id, zone";
/// One deck's claim on one collection entry.
pub const ALLOCATION_GRAIN: &str = "deck_id, collection_entry_id";
```

- [x] **Step 1: Write the failing tests** — append to `schema.rs`'s `mod tests`. Write small seed helpers once (`seed_card`/`deck`/`entry`/`deck_card`/`allocate` — plain INSERTs returning ids) and reuse them in Task 3.

```rust
/// The three enforced FKs, exercised at their delete sites. `foreign_keys=ON`, as
/// `db::open` sets it — these tests fail without the pragma, which is the point.
#[test]
fn deleting_a_deck_cascades_its_cards_and_allocations() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    migrate(&conn).unwrap();
    seed_card(&conn, "bolt", "lea", "161");
    let deck = deck(&conn, "Burn");
    let entry = entry(&conn, "bolt", 4);
    deck_card(&conn, deck, "bolt", "main", 4);
    allocate(&conn, deck, entry, 4);

    conn.execute("DELETE FROM decks WHERE id = ?1", [deck]).unwrap();

    for table in ["deck_cards", "deck_allocations"] {
        let n: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table} rows die with their deck");
    }
    // ...and the collection entry is untouched: a deck is a claim, never custody.
    let q: i64 = conn
        .query_row("SELECT quantity FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(q, 4);
}

#[test]
fn removing_a_collection_entry_frees_its_allocations_and_nothing_else() {
    // remove_entry's CASCADE site: the allocation goes (a reservation on copies that no
    // longer exist is a lie), the deck card STAYS (the deck still wants the card — it is
    // simply missing now, which Task 5's availability computes).
    // Seed deck + entry + deck_card + allocation; DELETE the entry with foreign_keys=ON;
    // assert deck_allocations empty and deck_cards intact.
}

#[test]
fn deck_rows_survive_the_swap_that_drops_cards() {
    // `user_rows_survive_the_swap_that_drops_cards`, grown to the deck tables: seed a deck
    // whose card_id and cover_card_id resolve, create_staging + swap_staging with
    // foreign_keys=ON, assert the deck, its cards (denormalized printing verbatim) and its
    // allocations all survive. This is what "soft reference" buys, and what a declared
    // REFERENCES cards(id) would abort.
}

#[test]
fn the_deck_card_grain_folds_and_the_zone_and_quantity_checks_hold() {
    // INSERT twice on (deck, card, zone) with ON CONFLICT(DECK_CARD_GRAIN) DO UPDATE
    // quantity add → one row, quantity 5. Same card in 'maybe' → a second row (zone is in
    // the grain). zone 'sideboard' → CHECK failure, and assert SQLITE_CONSTRAINT_CHECK as
    // the finish-enum test does (the enum is the five spec words, not their synonyms).
    // quantity 0 → CHECK failure (zero removes, like the wishlist — deck.rs owns that
    // translation).
}

#[test]
fn format_specs_is_seeded_with_all_25_formats_and_the_load_bearing_cells() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let n: i64 = conn.query_row("SELECT count(*) FROM format_specs", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 25, "23 legality keys + casual + limited");
    // One row per trap, read cell by cell (helper closure over a 12-column SELECT):
    // commander → (100, Some(100), Some(1), Some(0), singleton 1, requires 1, 'edh', 40,
    //              'max_one', has_legality 1, max_mv None, companion_ok 1)
    // vintage   → (60, None, Some(4), Some(15), 0, 0, None, 20, 'max_one', 1, None, 1)
    // duel      → restricted_semantic 'banned_as_commander'   [TRAP A's other half]
    // tlr       → (50, Some(50), Some(1), Some(10), 1, 1, 'tlr', 20,
    //              'banned_as_commander', 1, Some(3), 1)
    // paupercommander → life 30, commander_rule 'pdh'
    // gladiator → allows_companion 0                          [no sideboard → no companion]
    // limited   → (40, None, None, None, 0, 0, None, 20, 'max_one', 0, None, 1)
    // casual    → has_legality_data 0, deck_min 0
    // future    → enabled_in_picker 0
    // brawl vs standardbrawl → 100/100 vs 60/60, both life 25  [never derive one format
    //                                                            from another]
}

#[test]
fn the_v5_backfill_fills_power_and_toughness_from_raw_and_faces() {
    // A pre-v5 database with three rows: a creature carrying top-level
    // "power":"3","toughness":"3" in raw; a transform whose P/T live only on
    // card_faces[0] (raw has none at top level, `faces` holds the array verbatim);
    // a land with neither. Run migrate; assert ('3','3'), the face values, and NULL.
    // AND: extend `the_v3_backfill_steps_over_a_row_whose_raw_is_not_json` to walk the
    // ladder to head over a gzip-BLOB `raw` — the guard is invisible to fixture
    // databases, which is exactly why that test exists.
}
```

Also update `migrate_is_idempotent_and_creates_tables`: the `sqlite_master` IN-list grows `'decks','deck_cards','deck_allocations','format_specs'` and the count becomes 11.

- [x] **Step 2: Run and watch them fail** — `cargo test --manifest-path src-tauri/Cargo.toml schema::` — the v5 tables do not exist and `SCHEMA_VERSION` is 4.

- [x] **Step 3: The `if v < 5` step.** After the `if v < 4` block, one transaction ending in the **literal** `PRAGMA user_version = 5`:

```rust
if v < 5 {
    let tx = conn.unchecked_transaction()?;
    // Plan 4 (spec §6). Two invariants meet here and the DDL is their treaty:
    //
    // * Everything that names a CARD is a soft reference — `deck_cards.card_id` and
    //   `decks.cover_card_id` carry no REFERENCES clause, and the printing (plus the
    //   name: a deck list that cannot name an orphaned card is not a list) is
    //   denormalized beside `card_id`, exactly as the collection and wishlist do.
    // * Everything that names USER DATA is an enforced reference — the only three
    //   in the schema, all ON DELETE CASCADE, an action chosen per delete-site:
    //   right for the two user-initiated deletes (deck_delete, remove_entry), and
    //   made safe for the one non-user delete (the reconciler's fold) by
    //   `reconcile::fold_into_existing` repointing allocations BEFORE it deletes.
    tx.execute_batch(&format!(
        "ALTER TABLE cards ADD COLUMN power TEXT;
         ALTER TABLE cards ADD COLUMN toughness TEXT;

         CREATE TABLE IF NOT EXISTS decks (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            format_key TEXT NOT NULL DEFAULT 'casual',
            description TEXT,
            -- Spec §6: card_art today; 'custom' + cover_image_path are Plan 6's
            -- (user file copied into data/covers/), reserved here so the column
            -- story is stable.
            cover_kind TEXT NOT NULL DEFAULT 'card_art'
                CHECK (cover_kind IN ('card_art','custom')),
            cover_card_id TEXT,
            cover_image_path TEXT,
            -- Reserves availability, never decrements the collection (spec §6).
            is_built INTEGER NOT NULL DEFAULT 0,
            -- Spec §7 'duplicate/archive decks'. A flag, not a delete.
            archived INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS deck_cards (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            card_id TEXT NOT NULL,
            set_code TEXT NOT NULL,
            collector_number TEXT NOT NULL,
            lang TEXT NOT NULL DEFAULT 'en',
            name TEXT NOT NULL,
            zone TEXT NOT NULL CHECK (zone IN ('main','side','commander','companion','maybe')),
            -- Zero removes, like the wishlist and unlike the collection: a zone slot
            -- at zero holds no condition, no price and no acquisition story.
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            needs_review TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_cards_grain
            ON deck_cards ({deck_grain});
         CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards (card_id);

         CREATE TABLE IF NOT EXISTS deck_allocations (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            collection_entry_id INTEGER NOT NULL
                REFERENCES collection_entries(id) ON DELETE CASCADE,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_allocations_grain
            ON deck_allocations ({alloc_grain});
         CREATE INDEX IF NOT EXISTS idx_deck_allocations_entry
            ON deck_allocations (collection_entry_id);

         CREATE TABLE IF NOT EXISTS format_specs (
            key TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            enabled_in_picker INTEGER NOT NULL DEFAULT 1,
            deck_min INTEGER NOT NULL,
            deck_max INTEGER,             -- NULL = no maximum
            max_copies INTEGER,           -- NULL = unlimited (casual, limited)
            sideboard_max INTEGER,        -- 0 = no sideboard; NULL = uncapped (limited)
            singleton INTEGER NOT NULL DEFAULT 0,
            requires_commander INTEGER NOT NULL DEFAULT 0,
            -- Which eligibility rule the TS engine applies. Data, not code:
            -- NULL | 'edh' | 'brawl' | 'oathbreaker' | 'pdh' | 'duel' | 'tlr'.
            commander_rule TEXT,
            life INTEGER NOT NULL,
            -- TRAP A: what `restricted` MEANS here. Never inferred from the key.
            restricted_semantic TEXT NOT NULL DEFAULT 'max_one'
                CHECK (restricted_semantic IN ('max_one','banned_as_commander')),
            -- 0 for the two pseudo-formats: casual and limited check no legality
            -- and no pool (spec §6).
            has_legality_data INTEGER NOT NULL DEFAULT 1,
            -- Tiny Leaders: every card AND every face, MV <= this.
            max_mana_value INTEGER,
            -- Gladiator: no sideboard → no companions. EDH has sideboard_max 0 and
            -- DOES allow one ('effectively a 101st card'), so this cannot be derived
            -- from sideboard_max — it is its own fact.
            allows_companion INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL
         );",
        deck_grain = DECK_CARD_GRAIN,
        alloc_grain = ALLOCATION_GRAIN
    ))?;

    // The backfill, THROUGH json_raw — `raw` is a gzip BLOB on every database that has
    // synced since v3, and an unguarded json_extract there is a hard error that fails
    // this whole migration in the field while passing every fixture test (CLAUDE.md).
    // `faces` needs no guard: compact JSON or NULL, and json_extract over NULL is NULL.
    tx.execute_batch(&format!(
        "UPDATE cards
            SET power     = coalesce(json_extract({raw}, '$.power'),
                                     json_extract(faces, '$[0].power')),
                toughness = coalesce(json_extract({raw}, '$.toughness'),
                                     json_extract(faces, '$[0].toughness'))
          WHERE power IS NULL AND toughness IS NULL;",
        raw = json_raw("raw")
    ))?;

    tx.execute_batch(FORMAT_SPECS_SEED)?;
    // Literal `5`, for the reason v3 writes a literal `3` and v4 a literal `4`.
    tx.execute_batch("PRAGMA user_version = 5;")?;
    tx.commit()?;
}
```

No `CARDS_INDEXES` entry (nothing new is indexed on `cards`), no `CARDS_COLUMNS` edit (frozen), no FTS rebuild (two unindexed columns, no rowid renumbering — v2/v3's reasoning; add the twin test `the_v5_backfill_leaves_the_search_index_answering` in the v2/v3 style).

- [x] **Step 4: The seed — the research doc's table, cell for cell.** A module-level constant so the numbers are reviewable in one screen. `INSERT OR REPLACE`, so a future correction is a new migration step re-running the same constant:

```rust
/// The format rules as DATA (spec §6). Source of every cell:
/// docs/superpowers/research/2026-08-04-mtg-domain-rules.md — the format table, TRAP A,
/// and the CR citations there. Columns:
/// (key, display_name, picker, deck_min, deck_max, copies, sb, singleton, cmdr,
///  cmdr_rule, life, restricted, has_legality, max_mv, companion_ok, sort)
const FORMAT_SPECS_SEED: &str = "INSERT OR REPLACE INTO format_specs
    (key, display_name, enabled_in_picker, deck_min, deck_max, max_copies, sideboard_max,
     singleton, requires_commander, commander_rule, life, restricted_semantic,
     has_legality_data, max_mana_value, allows_companion, sort_order) VALUES
    ('standard',        'Standard',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 1),
    ('future',          'Future Standard',      0, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 2),
    ('historic',        'Historic',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 3),
    ('timeless',        'Timeless',             1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 4),
    ('gladiator',       'Gladiator',            1, 100, NULL, 1,    0,    1, 0, NULL,          20, 'max_one',             1, NULL, 0, 5),
    ('pioneer',         'Pioneer',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 6),
    ('modern',          'Modern',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 7),
    ('legacy',          'Legacy',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 8),
    ('pauper',          'Pauper',               1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 9),
    ('vintage',         'Vintage',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 10),
    ('penny',           'Penny Dreadful',       1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 11),
    ('commander',       'Commander',            1, 100, 100,  1,    0,    1, 1, 'edh',         40, 'max_one',             1, NULL, 1, 12),
    ('oathbreaker',     'Oathbreaker',          1, 60,  60,   1,    0,    1, 1, 'oathbreaker', 20, 'max_one',             1, NULL, 1, 13),
    ('standardbrawl',   'Standard Brawl',       1, 60,  60,   1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 14),
    ('brawl',           'Brawl',                1, 100, 100,  1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 15),
    ('competitivebrawl','Competitive Brawl',    1, 100, 100,  1,    0,    1, 1, 'brawl',       25, 'max_one',             1, NULL, 1, 16),
    ('alchemy',         'Alchemy',              1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 17),
    ('paupercommander', 'Pauper Commander',     1, 100, 100,  1,    0,    1, 1, 'pdh',         30, 'max_one',             1, NULL, 1, 18),
    ('duel',            'Duel Commander',       1, 100, 100,  1,    0,    1, 1, 'duel',        20, 'banned_as_commander', 1, NULL, 1, 19),
    ('oldschool',       'Old School',           1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 20),
    ('premodern',       'Premodern',            1, 60,  NULL, 4,    15,   0, 0, NULL,          20, 'max_one',             1, NULL, 1, 21),
    ('predh',           'PreDH',                1, 100, 100,  1,    0,    1, 1, 'edh',         40, 'max_one',             1, NULL, 1, 22),
    ('tlr',             'Tiny Leaders: Reborn', 1, 50,  50,   1,    10,   1, 1, 'tlr',         20, 'banned_as_commander', 1, 3,    1, 23),
    ('casual',          'Casual',               1, 0,   NULL, NULL, NULL, 0, 0, NULL,          20, 'max_one',             0, NULL, 1, 24),
    ('limited',         'Limited',              1, 40,  NULL, NULL, NULL, 0, 0, NULL,          20, 'max_one',             0, NULL, 1, 25);";
```

Deck-size semantics the engine relies on (document them **on the constant**): `deck_min`/`deck_max` count the `main` + `commander` zones together — "exactly 100 **incl cmdr**", "exactly 60 **incl OB+sig spell**" (Oathbreaker's planeswalker and signature spell both live in the `commander` zone; Task 9 validates the pair). The companion never counts toward deck size (EDH's is "effectively a 101st card"; in 60-card formats it occupies a sideboard slot, which Task 8 counts against `sideboard_max`). `predh` carries `'edh'` as its commander rule on purpose: the 2026 Vehicle/Spacecraft clause is harmless there because the `predh` legality key already excludes everything post-2011 — the pool check does the narrowing. That is not "deriving one format from another" (the seed never copies a *legality*); it is two formats genuinely sharing one eligibility rule.

- [x] **Step 5: `card_row.rs` + `ingest.rs`** — `CardRow` gains `pub power: Option<String>` and `pub toughness: Option<String>`, read with the same top-level-then-`card_faces[0]` fallback the artist uses (a transform's P/T live on its faces). `ingest.rs` adds the two columns to the staging INSERT's column list and bindings, and its fixture gains a card with `"power"`/`"toughness"` so the ingest path is proven, not just the backfill. `create_staging` needs nothing: it derives from `PRAGMA table_info(cards)`.

- [x] **Step 6: Run the suite** — the new tests pass, and the standing ones keep passing: `staging_takes_its_columns_from_the_live_table_not_from_the_v1_constant` now proves staging carries `power`/`toughness` for free, and `the_indexes_on_cards_are_identical_before_and_after_a_swap` proves the swap still replays only `CARDS_INDEXES`.

- [x] **Step 7: Verify and commit** — `npm run verify`, then:

```
feat: schema v5 — decks, deck_cards, deck_allocations, format_specs seed, cards P/T
```

---

### Task 3: The reconciler learns decks — and the fold learns the FK

`reconcile.rs`'s rule — a merge repoints, a delete flags, nothing removes a user row — now has a third table to keep it for, and one genuinely new obligation: `fold_into_existing` DELETEs a collection row, and as of Task 2 that DELETE cascades into `deck_allocations`. The fold must move the allocations to the survivor first (THE gate). While here, close the carryover's "same-day migration chains" item: `performed_at` is date-only, so two hops performed on one day arrive newest-first and `oldest_first` (a stable sort, equal keys) preserves that order — the row parks on a dead id forever. Resolve merge destinations transitively instead of hoping the sort saves us.

**Files:**
- Modify: `src-tauri/src/reconcile.rs`

**Interfaces:**
- Consumes: `Migration` (scryfall.rs), the deck-card grain's columns (spelled per-row, as `collision_target` spells the collection grain). The `deck`/`allocate` seed helpers below live in `reconcile`'s own `mod tests` (Task 2's schema helpers are a different module — mirror their shape, don't reach for them).
- Produces: no signature changes. `apply`/`merge`/`flag_deleted`/`sweep_orphans`/`user_data_is_empty` all grow `deck_cards`; `fold_into_existing` grows the allocation repoint; `merge` receives destinations resolved through the pass's own old→new map.

- [x] **Step 1: Write the failing tests**

```rust
/// THE gate (plan-3 final review, I6): the fold is the app's only non-user delete, and
/// with `deck_allocations.collection_entry_id` ON DELETE CASCADE it would silently
/// destroy a deck's reservation on copies that still exist. The allocations move to the
/// fold survivor BEFORE the delete — so the CASCADE, which is right for `remove_entry`,
/// fires over nothing here.
#[test]
fn a_fold_moves_deck_allocations_to_the_surviving_entry_before_it_deletes() {
    let mut conn = seeded();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    let old = own(&conn, "old-id", "foil", 3);
    let existing = own(&conn, "new-id", "foil", 2);
    let deck = deck(&conn, "Burn");
    allocate(&conn, deck, old, 3);

    apply(&mut conn, &[migration("m1", "merge", "old-id", Some("new-id"))]).unwrap();

    let (entry, qty): (i64, i64) = conn
        .query_row("SELECT collection_entry_id, quantity FROM deck_allocations", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((entry, qty), (existing, 3), "the claim survived the fold, on the survivor");
}

/// The collision case: the deck already holds a claim on the survivor. Two claims on
/// what is now one entry are one claim with both quantities — the same statement the
/// fold makes about the entries themselves.
#[test]
fn a_fold_merges_colliding_allocations_instead_of_violating_their_grain() {
    // allocate(deck, old, 2) AND allocate(deck, existing, 1); apply the merge;
    // assert ONE deck_allocations row, quantity 3, pointing at the survivor.
}

/// Deck rows are user rows: a merge repoints them (folding on the deck grain when the
/// deck already runs the new printing in that zone), a delete flags them, the sweep
/// flags and clears them, and none of it ever deletes one.
#[test]
fn a_merge_repoints_deck_cards_and_folds_same_zone_collisions() {
    // deck runs old-id x3 in main and new-id x2 in main → after the merge: ONE main row,
    // new-id x5, set_code/collector_number refreshed from the new printing ('2ed'/'162');
    // and an old-id row in 'maybe' repoints independently (zone is part of the grain).
}
#[test]
fn a_delete_flags_deck_rows_and_the_sweep_clears_what_returns() {
    // flag_deleted writes its sentence on deck_cards too; sweep_orphans flags a deck card
    // whose printing left `cards` and clears it when it returns — the collection test's
    // shape, third table.
}
#[test]
fn a_database_whose_only_user_rows_are_decks_still_reconciles() {
    // user_data_is_empty is false with one deck_cards row and empty collection/wishlist —
    // otherwise a decks-only user never polls /migrations at all.
}

/// Same-day chains (plan-3 carryover §4). `performed_at` is date-only, so A→B and B→C
/// performed on ONE day arrive newest-first and the stable sort keeps them that way —
/// order alone cannot save the row. Destinations resolve transitively instead.
#[test]
fn a_same_day_chain_lands_on_the_final_id() {
    let mut conn = seeded();
    let id = own(&conn, "a-id", "foil", 2);
    apply(&mut conn, &[
        Migration { performed_at: Some("2026-07-01".into()),
                    ..migration("m2", "merge", "b-id", Some("new-id")) },
        Migration { performed_at: Some("2026-07-01".into()),
                    ..migration("m1", "merge", "a-id", Some("b-id")) },
    ]).unwrap();
    let card: String = conn
        .query_row("SELECT card_id FROM collection_entries WHERE id = ?1", [id], |r| r.get(0))
        .unwrap();
    assert_eq!(card, "new-id", "resolved a→b→new through the map, not through the sort");
}
```

- [x] **Step 2: Run and watch them fail** — the allocation tests fail with the allocation gone (CASCADE fired), the deck-card tests with untouched rows, the chain test with `card_id = "b-id"`.

- [x] **Step 3: The fold gate.** In `fold_into_existing`, between the survivor UPDATE and the source DELETE:

```rust
// The FK treaty (schema v5): `deck_allocations.collection_entry_id` cascades on
// delete for `remove_entry`'s sake — so THIS delete, the app's only non-user one,
// must leave nothing for the cascade to take. Claims on the folding row move to the
// survivor; where the deck already claims the survivor, the two claims fold first
// (their grain is one row per (deck, entry), the same shape as the entries' own).
tx.execute(
    "UPDATE deck_allocations AS t SET
        quantity = t.quantity + s.quantity,
        updated_at = unixepoch()
      FROM (SELECT deck_id, quantity FROM deck_allocations
             WHERE collection_entry_id = ?2) AS s
      WHERE t.deck_id = s.deck_id AND t.collection_entry_id = ?1",
    params![target, source],
)?;
tx.execute(
    "DELETE FROM deck_allocations
      WHERE collection_entry_id = ?2
        AND EXISTS (SELECT 1 FROM deck_allocations t
                     WHERE t.deck_id = deck_allocations.deck_id
                       AND t.collection_entry_id = ?1)",
    params![target, source],
)?;
tx.execute(
    "UPDATE deck_allocations SET collection_entry_id = ?1, updated_at = unixepoch()
      WHERE collection_entry_id = ?2",
    params![target, source],
)?;
```

- [x] **Step 4: Deck rows join `merge`.** After the wishlist loop, a deck loop in the collection loop's shape: `UPDATE OR IGNORE deck_cards` repointing `card_id` and refreshing `set_code`/`collector_number`/`lang` (NOT `name` — the name is the oracle name and the merge does not change what the card is called; if it did, the sweep's flag is the honest channel) with the unconditional `needs_review = ?note`; when `OR IGNORE` swallows the grain collision, fold quantities into the row at `(deck_id, new_id, zone)` and delete the source; `flag_unfoldable(tx, "deck_cards", …)` as the defensive arm — it is table-generic already. `flag_deleted` and `sweep_orphans` change their table arrays to `["collection_entries", "wishlist_entries", "deck_cards"]` (the sweep's `card_id IS NOT NULL` guard is vacuous for deck rows and harmless). `user_data_is_empty` gains the third `count(*)`.

- [x] **Step 5: Transitive merge resolution.** In `apply`, before the loop:

```rust
// Merge destinations resolve through the pass's own map, so a chain lands every row
// on its FINAL id no matter how the log was ordered or dated. `oldest_first` still
// runs — it keeps `card_migrations` recorded in a sane order — but correctness no
// longer leans on dates Scryfall only publishes to the day. Bounded by the map's
// size, so a cycle (A→B, B→A) stops instead of spinning.
let resolved: std::collections::HashMap<&str, &str> = migrations.iter()
    .filter(|m| m.strategy == "merge")
    .filter_map(|m| {
        let new = m.new_card_id.as_deref()?.trim();
        (!new.is_empty()).then(|| (m.old_card_id.as_str(), new))
    })
    .collect();
let final_id = |mut id: &str| -> &str {
    for _ in 0..resolved.len() {
        match resolved.get(id) { Some(next) => id = next, None => break }
    }
    id
};
```

and `merge` is called with `final_id(new_id)` in place of `new_id`. The recorded `card_migrations` row keeps Scryfall's own `new_card_id` — the bookkeeping mirrors the log; the *rows* land on the truth. `a_chain_of_merges_delivered_newest_first_still_lands_on_the_last_id` (the dated-chain test) must still pass untouched.

- [x] **Step 6: Verify and commit** — the full `reconcile::` suite (20+ standing tests — fold-carries-the-receipt, first-message-wins, delete-flag-outlives are untouched invariants) plus the new ones, `npm run verify`, then:

```
feat: reconciler covers deck rows; fold repoints allocations; transitive merge chains
```

---

### Task 4: Deck CRUD and zone writes — `deck.rs`, and deck cards join the pre-warm

The deck module, shaped like `collection.rs`: pure functions over a `Connection`, `#[tauri::command]` wrappers on the blocking pool, writes through `db::lock_for(&state.db, WRITE_LOCK_WAIT)` answering `collection::BUSY`, reads through `db_read`. Zone writes denormalize the printing **and the name** at write time (the wishlist's reasoning: the row must stay sayable when the id stops resolving), and zero is a removal (`CHECK (quantity > 0)` — a zone slot holds no story). Deck cards also join `images::prewarm_keys`' UNION, which is carryover MUST-DO 3 and closes the wishlist-only-user asymmetry noted there.

**Files:**
- Create: `src-tauri/src/deck.rs`
- Modify: `src-tauri/src/lib.rs` (module + 9 command registrations), `src-tauri/src/images.rs` (the UNION + its test)

**Interfaces:**
- Consumes: `collection::{BUSY, valid_quantity, EntryChange}`, `schema::{DECK_ZONES, DECK_CARD_GRAIN}`, `db::{lock_for, WRITE_LOCK_WAIT}`, `sync::{AppState, lock_db_read}`.
- Produces (`#[serde(rename_all = "camelCase")]` throughout, mirrored in Task 7's `ipc.ts`):

```rust
// src-tauri/src/deck.rs
pub const ZONES: [&str; 5] = crate::schema::DECK_ZONES; // re-export for the CHECK's twin

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckInput { pub name: String, pub format_key: String, pub description: Option<String> }

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckPatch {
    pub name: Option<String>,
    pub format_key: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    pub is_built: Option<bool>,
    pub archived: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRow {
    pub id: i64,
    pub name: String,
    pub format_key: String,
    /// From format_specs, so the gallery never re-derives a display name.
    pub format_name: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    /// Scryfall image policy: an `art` crop lacks the printed frame, so wherever the
    /// gallery shows one it must credit the artist — read here so the tile can.
    pub cover_artist: Option<String>,
    pub is_built: bool,
    pub archived: bool,
    /// main + commander + companion copies — what "a 60-card deck" means in a caption.
    pub card_count: i64,
    pub updated_at: i64,
}

pub fn create_deck(conn: &Connection, input: &DeckInput) -> Result<DeckRow, String>;
pub fn update_deck(conn: &Connection, id: i64, patch: &DeckPatch) -> Result<DeckRow, String>;
/// DELETE FROM decks — the FKs cascade the cards and allocations (Task 2's test).
/// Like `remove_entry`: deleting what is already gone is a success.
pub fn delete_deck(conn: &Connection, id: i64) -> Result<(), String>;
/// Copy the deck and its cards (never its allocations, never is_built — a copy is a
/// draft). Name: `{name} (copy)`.
pub fn duplicate_deck(conn: &Connection, id: i64) -> Result<DeckRow, String>;
pub fn list_decks(conn: &Connection) -> Result<Vec<DeckRow>, String>;

/// Add copies to a zone, folding on the grain — the drag-in and click-to-add write.
pub fn add_card(conn: &Connection, deck_id: i64, card_id: &str, zone: &str, quantity: i64)
    -> Result<EntryChange, String>;
/// Absolute quantity — the stepper write. Zero removes (CHECK quantity > 0): a deck
/// slot, unlike a collection row, holds nothing worth keeping at zero.
pub fn set_card_quantity(conn: &Connection, deck_id: i64, card_id: &str, zone: &str, quantity: i64)
    -> Result<EntryChange, String>;
/// Move between zones in one transaction, folding into the row already at the target.
pub fn move_card(conn: &Connection, deck_id: i64, card_id: &str, from: &str, to: &str)
    -> Result<(), String>;
```

Commands: `deck_create`, `deck_update`, `deck_delete`, `deck_duplicate`, `deck_list`, `deck_add_card`, `deck_set_card_quantity`, `deck_move_card` (plus Task 5's `deck_get`, `deck_missing_to_wishlist`, `format_specs_list`). Every write ends by touching `decks.updated_at` — the gallery sorts by it.

- [x] **Step 1: Write the failing tests** (in `deck.rs`'s own `mod tests`, on the Task 2 helpers):

```rust
/// The zone write is the collection quick-add's contract on the deck grain: the same
/// printing in the same zone twice is one row with a bigger number, and the printing
/// AND name are denormalized from `cards` at write time — the only moment they are
/// knowable, and the reason the row outlives the id (spec §6, CLAUDE.md).
#[test]
fn adding_the_same_card_to_the_same_zone_twice_folds() { /* add 2 + 2 → one row, 4;
    assert set_code/collector_number/lang/name copied from the card row; a different
    zone is a second row */ }

#[test]
fn a_zone_the_schema_does_not_know_is_refused_in_words() { /* add(…, "sideboard", 1) →
    Err naming the five zones — validated in Rust like valid_finish, so the CHECK
    failure never reaches a user */ }

#[test]
fn zero_removes_the_deck_card_and_negative_is_refused() { /* set_card_quantity 0 →
    removed: true, row gone; -1 → the valid_quantity sentence */ }

#[test]
fn moving_a_card_between_zones_folds_into_the_target_row() { /* 4 in main, 1 in side;
    move main→side → one side row with 5, no main row; move to an empty zone creates */ }

#[test]
fn duplicate_copies_cards_but_not_allocations_or_built() { /* duplicate → new deck,
    "(copy)" name, same card rows, zero allocations, is_built false */ }

#[test]
fn list_decks_counts_main_commander_companion_and_reads_the_cover_artist() {
    /* deck with 2 main + 1 commander + 1 maybe → card_count 3; cover_card_id set →
       cover_artist from cards.artist; archived decks listed (the UI separates them) */ }

#[test]
fn a_card_id_that_does_not_resolve_is_refused() { /* add_card with an unknown id →
    Err — the same printing_of contract as collection::add_entry; a deck card is
    always born from a live printing, orphanhood only happens later */ }
```

And in `images.rs`: extend `the_prewarm_selects_owned_cards_that_are_not_cached_yet` — a third seeded row in `deck_cards` makes the count 3, and a cached one drops out. (`prewarm_keys` gains one arm: `UNION SELECT card_id FROM deck_cards` — carryover MUST-DO 3; still `grid`-only, per the constant's own doc.)

- [x] **Step 2: Run and watch them fail** — module doesn't exist; write `deck.rs` skeleton with `todo!()`s if needed to get names compiling, or write straight through.

- [x] **Step 3: Implement.** The upsert is `COLLECTION_GRAIN`'s pattern on `DECK_CARD_GRAIN`:

```rust
fn valid_zone(zone: &str) -> Result<&str, String> {
    ZONES.contains(&zone).then_some(zone).ok_or_else(|| {
        format!("`{zone}` is not a deck zone. Use one of: {}.", ZONES.join(", "))
    })
}

pub fn add_card(/* … */) -> Result<EntryChange, String> {
    let zone = valid_zone(zone)?;
    if quantity <= 0 {
        return Err("Adding a card needs a quantity of at least one.".into());
    }
    let (set_code, collector_number, lang, name): (String, String, String, String) = conn
        .query_row(
            "SELECT set_code, collector_number, lang, name FROM cards WHERE id = ?1",
            params![card_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional().map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no card with the id `{card_id}` is in the card database"))?;
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING id, quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    // …bind, then touch decks.updated_at, then reallocate (Task 5 wires the call)…
}
```

`move_card` is one transaction: read the source row's quantity, `add_card`-style upsert into the target zone, delete the source. `update_deck` is `coalesce(?n, column)` per `collection::update_entry`; a `format_key` not present in `format_specs` is refused in words (`SELECT 1 FROM format_specs WHERE key = ?`). `delete_deck` is one `DELETE FROM decks` (the CASCADEs are Task 2's proof). `list_decks`:

```sql
SELECT d.id, d.name, d.format_key, fs.display_name, d.description, d.cover_card_id,
       c.artist, d.is_built, d.archived,
       coalesce((SELECT sum(quantity) FROM deck_cards
                  WHERE deck_id = d.id AND zone IN ('main','commander','companion')), 0),
       d.updated_at
  FROM decks d
  LEFT JOIN format_specs fs ON fs.key = d.format_key
  LEFT JOIN cards c ON c.id = d.cover_card_id
 ORDER BY d.archived ASC, d.updated_at DESC, d.id DESC
```

(LEFT JOINs both: a vanished cover card or an unknown key must never hide a deck.)

- [x] **Step 4: Register the commands** in `lib.rs`'s `generate_handler!` and add `pub mod deck;`.

- [x] **Step 5: Verify and commit** — `npm run verify`, then:

```
feat: deck CRUD and zone writes; deck cards join the image pre-warm
```

---

### Task 5: The deck read, the allocator, and "missing → wishlist"

The read that feeds both the editor and the TS engine: one command, every fact. `DeckCardRow` carries the row's own denormalized identity (orphan-safe), the card facts validation needs — including this **printing's** `legalities` (TRAP B: `oldschool` is printing-sensitive, and because deck cards reference printings, returning each row's own blob makes Old School correct with no special case) and `ever_uncommon` (TRAP C: PDH commander eligibility is computed, not read) — and the availability numbers. Allocations are the non-destructive Deckbox model (spec §6): stored claims, recomputed by a greedy allocator inside every zone-write transaction; **the collection is never decremented**.

**Files:**
- Modify: `src-tauri/src/deck.rs`, `src-tauri/src/lib.rs` (3 registrations)

**Interfaces:**
- Consumes: `wishlist::add_wish` + `WishInput` (the one-click writes *through* the existing wishlist grain — no second write path), `collection.rs`'s `FROM`/LEFT JOIN discipline.
- Produces:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardRow {
    pub id: i64,
    pub card_id: String,
    pub zone: String,
    pub quantity: i64,
    // The entry's own columns — never NULL, they were copied at write time:
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    pub needs_review: Option<String>,
    // Card facts, all Option: an orphaned row is still a card in the deck.
    pub oracle_id: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub colors: Option<String>,          // JSON array
    pub color_identity: Option<String>,  // JSON array — Scryfall's precomputed field
    /// THIS printing's blob (23 keys). Per-printing on purpose: TRAP B.
    pub legalities: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub layout: Option<String>,
    pub rarity: Option<String>,
    /// The card_faces array verbatim (per-face mana_cost/cmc/power live here — TLR's
    /// per-face MV cap and DFC commander fronts read it).
    pub faces: Option<String>,
    pub game_changer: Option<bool>,
    /// TRAP C: printed at uncommon on ANY printing of this oracle card.
    pub ever_uncommon: bool,
    /// Nonfoil `usd` from the prices blob — WishRow.unitPriceUsd's rule, never price_usd.
    pub unit_price_usd: Option<f64>,
    /// Copies of this oracle card the allocator secured for this deck, attributed to
    /// this row (commander → main → side → companion → maybe order). Clamped to what
    /// each entry still holds, so a shrunk collection reads honestly.
    pub owned_quantity: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail { pub deck: DeckRow, pub cards: Vec<DeckCardRow> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatSpecRow {
    pub key: String, pub display_name: String, pub enabled_in_picker: bool,
    pub deck_min: i64, pub deck_max: Option<i64>, pub max_copies: Option<i64>,
    pub sideboard_max: Option<i64>, pub singleton: bool, pub requires_commander: bool,
    pub commander_rule: Option<String>, pub life: i64, pub restricted_semantic: String,
    pub has_legality_data: bool, pub max_mana_value: Option<i64>,
    pub allows_companion: bool, pub sort_order: i64,
}

pub fn get_deck(conn: &Connection, id: i64) -> Result<Option<DeckDetail>, String>;
/// Recompute this deck's claims. Runs inside every zone-write transaction and on
/// is_built toggles (this deck only). Greedy and deterministic: per deck card in
/// commander→main→side→companion order (never `maybe`), entries of the same ORACLE
/// card, exact printing first, proxies last, then entry id; availability = the
/// entry's quantity minus other BUILT decks' claims on it.
pub fn allocate_deck(conn: &Connection, deck_id: i64) -> Result<(), String>;
/// One wish per card still missing (any-printing, quantity = missing), through
/// wishlist::add_wish so the grain folds repeats. Returns how many wishes were touched.
pub fn missing_to_wishlist(conn: &Connection, deck_id: i64) -> Result<usize, String>;
pub fn list_format_specs(conn: &Connection) -> Result<Vec<FormatSpecRow>, String>;
```

Commands: `deck_get` (db_read), `format_specs_list` (db_read), `deck_missing_to_wishlist` (write).

- [x] **Step 1: Write the failing tests**

```rust
/// The allocator's whole contract in one scene: 4 Bolts wanted, 3 owned across two
/// entries (2 lea + 1 m10 — a DIFFERENT printing of the same oracle card), nothing
/// else claiming them → allocations total 3, the deck reads owned 3 of 4, and the
/// collection rows still say 2 and 1: availability is computed, never decremented
/// (spec §6, Deckbox semantics).
#[test]
fn the_allocator_reserves_owned_copies_across_printings_without_touching_the_collection() {}

/// Exact printing first: the deck runs the lea Bolt and the user owns lea x2 and
/// m10 x4 → the lea entry is drained before m10 is touched. Deterministic, so a
/// re-run allocates identically (delete + rebuild inside one transaction).
#[test]
fn the_allocator_prefers_the_exact_printing_then_other_printings() {}

/// is_built is what makes a claim RESERVE: two decks want the same 4 copies; deck A
/// (built) claims them; deck B's allocator finds availability 0 and B reads
/// owned 0 of 4. Unbuild A, reallocate B → B reads 4. A deck's own claims never
/// block itself.
#[test]
fn built_decks_reserve_availability_and_unbuilt_decks_do_not() {}

/// The read clamps: allocation says 4, the entry has since been stepped to 1 →
/// owned_quantity reads 1, not 4. A claim on copies that left the binder is not
/// ownership.
#[test]
fn owned_quantity_clamps_to_what_the_entry_still_holds() {}

/// TRAP B and TRAP C ride the read: two printings of one card with different
/// oldschool legalities come back with their own blobs; a rare printing whose oracle
/// card was ever printed at uncommon reads ever_uncommon = true.
#[test]
fn the_read_returns_per_printing_legalities_and_ever_uncommon() {}

/// An orphaned deck card is still a row: name/set/cn from the entry, card facts NULL,
/// owned 0 — listed, never dropped (the LEFT JOIN discipline).
#[test]
fn an_orphaned_deck_card_is_listed_from_its_denormalized_columns() {}

/// missing_to_wishlist: 4 wanted, 1 owned → an any-printing wish for 3 lands through
/// the wishlist grain; run twice → the wish is 6 (the fold is add_wish's contract,
/// not double-counted rows); a fully-owned card adds nothing; `maybe` never counts.
#[test]
fn missing_to_wishlist_writes_any_printing_wishes_through_the_wishlist_grain() {}
```

- [x] **Step 2: Run and watch them fail.**

- [x] **Step 3: The allocator.** Delete-and-rebuild inside the caller's transaction, so it is deterministic and idempotent:

```rust
pub fn allocate_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM deck_allocations WHERE deck_id = ?1", params![deck_id])
        .map_err(|e| e.to_string())?;
    // Wants: oracle-grouped, zone-ordered. `maybe` is a scratchpad, not a deck.
    // Availability: entry.quantity − other BUILT decks' claims (computed per entry).
    // Greedy walk in Rust: for each (oracle, wanted), take from candidate entries —
    // exact printing first, proxy last, entry id ascending — min(available, still
    // wanted), inserting one deck_allocations row per entry drawn from.
    // …
}
```

`get_deck`'s card query is the collection list's LEFT JOIN discipline (`deck_cards dc LEFT JOIN cards c ON c.id = dc.card_id`), with:

```sql
CAST(json_extract(c.prices, '$.usd') AS REAL)              AS unit_price_usd,
EXISTS(SELECT 1 FROM cards u
        WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon
```

and the owned attribution computed in Rust after the rows land: sum this deck's allocations per oracle card (each clamped to `min(a.quantity, e.quantity)` via a join), then walk the deck's rows for that oracle in commander→main→side→companion→maybe order handing out `min(remaining, row.quantity)`. Unit-testable as a pure function — write it as one (`fn attribute_owned(rows: &mut [DeckCardRow], owned_by_oracle: &HashMap<String, i64>)`).

- [x] **Step 4: Wire `allocate_deck`** into `add_card`/`set_card_quantity`/`move_card` (same transaction, after the write) and into `update_deck` when `is_built` changes. `missing_to_wishlist` loops the deck's still-missing cards calling `wishlist::add_wish` with `WishInput { oracle_id, name (the entry's, for the orphan case), quantity: missing, ..Default::default() }` under one write lock.

- [x] **Step 5: Verify and commit** — `npm run verify`, then:

```
feat: deck read with validation facts, the greedy allocator, missing-to-wishlist
```

---

### Task 6: The wishlist's Plan-4 companions — needs-review filter and the EUR twin

Two items the carryover names as natural Plan-4 companions, both halves of things Plan 3 already shipped: `CollectionQuery` has `needs_review` and the wishlist's flagged-row band renders, but `WishlistQuery` cannot filter to them; and the wishlist header prices in USD only where spec §7 says the view "mirrors" a collection header that shows both currencies — with the etched hole (`eur_etched` does not exist) already handled by the collection's own SQL rule.

**Files:**
- Modify: `src-tauri/src/wishlist.rs`, `src/lib/ipc.ts`, `src/features/wishlist/useWishlist.ts`, `src/features/wishlist/WishlistPage.tsx` (+ its test)

**Interfaces:**
- Consumes: `collection::FINISH_PRICE_EUR`'s etched-is-NULL shape (re-expressed over the wish's preferred finish), `eurPrice` from `@/lib/prices`, `FilterChips`' toggle-chip vocabulary.
- Produces: `WishlistQuery.needs_review: Option<bool>` (Rust) / `needsReview?: boolean` (`ipc.ts`); `WishRow.unit_price_eur: Option<f64>` / `unitPriceEur: number | null`; `WishlistFilterState` gains `needsReview: boolean | undefined`.

- [x] **Step 1: Rust tests first** — in `wishlist.rs`'s `mod tests`:

```rust
/// The backend half plan-3 deferred: `Some(true)` narrows to flagged wishes,
/// `Some(false)` to clean ones, `None` asks nothing — CollectionQuery's exact contract.
#[test]
fn the_needs_review_filter_narrows_the_list_and_the_count() {}

/// EUR per copy follows the wish's own finish, with the hole the data has: a foil wish
/// prices at eur_foil, an etched wish is NULL — unpriced, never the nonfoil rate.
#[test]
fn unit_price_eur_reads_the_blob_by_preferred_finish_and_etched_is_unpriced() {}
```

Implement: the filter is `collection.rs`'s three-way `match` verbatim; the price column joins the SELECT beside `unit_price_usd`:

```sql
CASE coalesce(w.preferred_finish, 'nonfoil') WHEN 'etched' THEN NULL ELSE
    CAST(json_extract(c.prices,
        CASE coalesce(w.preferred_finish, 'nonfoil')
            WHEN 'foil' THEN '$.eur_foil' ELSE '$.eur' END) AS REAL) END AS unit_price_eur
```

- [x] **Step 2: The TS mirror** — `ipc.ts` (`WishlistQuery.needsReview`, `WishRow.unitPriceEur`, doc comments in the file's voice), `useWishlist.ts` (state + `toggleNeedsReview` tri-state via the existing `cycleTriState`, `activeFilterCount` counts three, `resetAll` clears three, the query key gains the term).

- [x] **Step 3: The view** — WishlistPage's header cost `useMemo` grows the EUR sum + its own unpriced counter (the collection header's presentation: a second `Figure`, `eurPrice`, `PRICES_AS_OF` title, `n unpriced` note); the filter bar gains a "Needs review" chip (rendered only when the list has flagged rows or the filter is on — a permanent chip for a state most users never see is chrome). Extend `WishlistPage.test.tsx`: the EUR figure renders and the etched-wish unpriced counter counts; the chip narrows.

- [x] **Step 4: Verify and commit** — `npm run verify`, then:

```
feat: wishlist needs-review filter and EUR pricing
```

---

### Task 7: Frontend foundation — deck DTOs, queries, and the store

The TS half of Tasks 4–5: `ipc.ts` mirrors every deck struct field-for-field (the file's header lists its sources — add `deck.rs`), TanStack Query hooks own server state, the zustand store gains the one navigation fact (`openDeckId`), and `SYNC_INVALIDATED` makes its one Task-1-anticipated addition: `["decks"]`, because every deck card fact except the denormalized identity comes from `cards`.

**Files:**
- Modify: `src/lib/ipc.ts`, `src/lib/store.ts`, `src/lib/useSyncInvalidation.ts` + `.test.ts`, `src/lib/ipc.test.ts` (argument-name pins)
- Create: `src/features/decks/useDecks.ts`, `src/features/decks/useDeck.ts`, `src/features/decks/useFormatSpecs.ts`

**Interfaces:**
- Consumes: `invoke`, `queryClient`, `useAppStore` patterns.
- Produces (`ipc.ts`, exact mirrors of Task 4/5's structs):

```ts
export type DeckZone = "main" | "side" | "commander" | "companion" | "maybe";
export interface DeckInput { name: string; formatKey: string; description?: string }
export interface DeckPatch { name?: string; formatKey?: string; description?: string;
  coverCardId?: string; isBuilt?: boolean; archived?: boolean }
export interface DeckRow { id: number; name: string; formatKey: string;
  formatName: string | null; description: string | null; coverCardId: string | null;
  coverArtist: string | null; isBuilt: boolean; archived: boolean; cardCount: number;
  updatedAt: number }
export interface DeckCard { /* DeckCardRow, field for field — see deck.rs */ }
export interface DeckDetail { deck: DeckRow; cards: DeckCard[] }
export interface FormatSpec { key: string; displayName: string; enabledInPicker: boolean;
  deckMin: number; deckMax: number | null; maxCopies: number | null;
  sideboardMax: number | null; singleton: boolean; requiresCommander: boolean;
  commanderRule: "edh" | "brawl" | "oathbreaker" | "pdh" | "duel" | "tlr" | null;
  life: number; restrictedSemantic: "max_one" | "banned_as_commander";
  hasLegalityData: boolean; maxManaValue: number | null; allowsCompanion: boolean;
  sortOrder: number }

// in `ipc`:
deckList: () => invoke<DeckRow[]>("deck_list"),
deckGet: (id: number) => invoke<DeckDetail | null>("deck_get", { id }),
deckCreate: (deck: DeckInput) => invoke<DeckRow>("deck_create", { deck }),
deckUpdate: (id: number, patch: DeckPatch) => invoke<DeckRow>("deck_update", { id, patch }),
deckDelete: (id: number) => invoke<void>("deck_delete", { id }),
deckDuplicate: (id: number) => invoke<DeckRow>("deck_duplicate", { id }),
deckAddCard: (deckId: number, cardId: string, zone: DeckZone, quantity: number) =>
  invoke<EntryChange>("deck_add_card", { deckId, cardId, zone, quantity }),
deckSetCardQuantity: (deckId: number, cardId: string, zone: DeckZone, quantity: number) =>
  invoke<EntryChange>("deck_set_card_quantity", { deckId, cardId, zone, quantity }),
deckMoveCard: (deckId: number, cardId: string, from: DeckZone, to: DeckZone) =>
  invoke<void>("deck_move_card", { deckId, cardId, from, to }),
deckMissingToWishlist: (deckId: number) => invoke<number>("deck_missing_to_wishlist", { deckId }),
formatSpecs: () => invoke<FormatSpec[]>("format_specs_list"),
```

- [x] **Step 1: Failing tests** — `ipc.test.ts` pins the new commands' argument names (its existing style: a mocked `invoke` asserting name + payload keys); `useSyncInvalidation.test.ts`'s Task-1 literal grows `["decks"]` (six keys — this is the "one decision" that test exists to make visible).

- [x] **Step 2: Implement `ipc.ts`** with the file's documentation voice (every nullable explained, the two `ownedQuantity` disambiguations extended with the deck's third meaning: *allocation-clamped copies secured for this deck* — three names, three questions).

- [x] **Step 3: Hooks.**
  - `useFormatSpecs()` — `useQuery({ queryKey: ["formatSpecs"], staleTime: Infinity })` + `formatSpecFor(key)` helper; the seeded table changes once per migration, like `sets`. **Not** in `SYNC_INVALIDATED`: a sync cannot change it.
  - `useDecks()` — `["decks", "list"]`; mutations (`create`/`update`/`delete`/`duplicate`) invalidate `["decks"]`.
  - `useDeck(id)` — `["decks", "detail", id]`; card mutations invalidate `["decks"]` **and** `["wishlist"]` (missing→wishlist) — and collection mutations already invalidate `["collection"]`, so add `["decks"]` to the collection mutation invalidations in `useCollection.ts` (allocations shift when quantities do; find the existing `invalidateQueries` sites and extend them).
  - `store.ts`: `openDeckId: number | null` + `setOpenDeckId`, with `setActiveView` clearing it exactly as it clears `selectedCardId` (leaving Decks closes the editor; the doc comment explains it in the store's voice).

- [x] **Step 4: Verify and commit** — `npm run verify`, then:

```
feat: deck IPC mirrors, query hooks, format-spec cache, decks in sync invalidation
```

---

### Task 8: The validation engine, part 1 — size, copies, legality, singleton (pure TS)

The heart of spec §3's boundary: a pure module in `src/features/decks/validation/`, no IPC, no React, tested in Vitest against hand-built card facts. Everything is **data-driven from `FormatSpec` + each card's own `legalities`** — the engine has no `if (format === "vintage")` anywhere; TRAP A's semantics come from `restrictedSemantic`, the pseudo-formats from `hasLegalityData`, Tiny Leaders' cap from `maxManaValue`. Issues are precise human sentences (spec §7's example verbatim: *"Lightning Bolt is restricted in Vintage: max 1 copy; you have 3."*).

**Files:**
- Create: `src/features/decks/validation/types.ts`, `validation/engine.ts` + `engine.test.ts`, `validation/singleton.ts` + `singleton.test.ts`

**Interfaces:**
- Consumes: `DeckCard`, `FormatSpec`, `DeckZone` from `@/lib/ipc` (types only — the engine never invokes).
- Produces:

```ts
// validation/types.ts
/** One finding. `error` breaks the format's rules; `warning` is a fact worth a look
 *  (an orphaned row, an unknown legality); nothing here ever blocks a save. */
export interface ValidationIssue {
  severity: "error" | "warning";
  /** Stable machine handle: "deck-size" | "copy-limit" | "restricted" | "not-legal" |
   *  "banned" | "sideboard-size" | "singleton" | "mana-value" | "commander-*" |
   *  "companion-*" | "color-identity" | "orphan" — the panel groups by it. */
  code: string;
  /** The whole story in one sentence, card names and numbers included. */
  message: string;
  /** The rows the sentence is about, for the panel's click-to-highlight. */
  cardIds?: string[];
}

/** The facts the engine reads — DeckCard re-exported under the name the module means. */
export type CardFacts = DeckCard;

// validation/engine.ts
export function validateDeck(cards: CardFacts[], spec: FormatSpec): ValidationIssue[];
/** Copies allowed of this card under this spec: Infinity for basics and the exact-phrase
 *  exceptions, the parsed N for "up to N", spec.maxCopies ?? Infinity otherwise. */
export function copyLimitFor(card: CardFacts, spec: FormatSpec): number;

// validation/singleton.ts
/** The exact anchors (research doc): the naive substring has three false positives. */
export const ANY_NUMBER_PHRASE = "A deck can have any number of cards named";
export const UP_TO_PHRASE = "A deck can have up to";
/** Infinity | 7 | 9 | … | null (no exception printed on the card). Re-derived from
 *  oracle text on every call — never a hardcoded card list (the list churns; the
 *  phrase is the rule). */
export function copyException(oracleText: string | null): number | null;
export function isBasicLand(typeLine: string | null): boolean;
```

- [x] **Step 1: Write the failing tests.** A tiny fixture factory (`card(overrides): CardFacts`) and a `spec(key)` helper hard-coding the seed's rows for the formats under test (the engine tests must not invoke — the seed's *authority* is Task 2's Rust test; these fixtures mirror it and say so). The matrix, one `describe` per rule:

```ts
describe("deck size", () => {
  // 59 in main for a 60-min format → error "Modern decks need at least 60 cards; you
  //   have 59." · exactly-100 commander: 99 incl commander → error; 101 → error
  //   ("exactly 100 including the commander").
  // The companion counts toward NO deck size; `maybe` counts toward NOTHING at all.
  // limited: 40 is legal, 39 is not; casual: 0 cards, no issue.
});
describe("copy limits", () => {
  // 5 Bolts in Modern (main 3 + side 2 — the combined 4-limit, CR 100.4a) → error
  //   naming 5. Basics unlimited (30 Islands, silence). limited: 12 of anything,
  //   silence (maxCopies null).
  // Singleton: 2 Sol Ring in Commander → "Commander decks are singleton: max 1 copy
  //   of Sol Ring; you have 2."
});
describe("singleton exceptions (exact phrases)", () => {
  // Real oracle texts: Relentless Rats / Dragon's Approach ("A deck can have any
  //   number of cards named…") → Infinity even in Commander.
  // Seven Dwarves "A deck can have up to seven cards named Seven Dwarves." → 7:
  //   7 fine, 8 → error citing 7. Nazgûl → 9 (word-number table: the card says
  //   "nine", not "9").
  // THE TRAP, pinned: Battalion Foot Soldier's library-search text contains "any
  //   number of cards named" but NOT the anchor → null, and 5 copies in Commander
  //   is an error. This test is why the anchor is the whole phrase.
});
describe("legality (per printing — TRAP B)", () => {
  // legalities '{"modern":"banned"}' → "X is banned in Modern."
  // not_legal → "X is not legal in Modern."
  // restricted + restrictedSemantic max_one: 1 copy silent, 3 copies → the spec §7
  //   sentence verbatim. restricted + banned_as_commander (duel): 4 copies in main
  //   is FINE (it is a 1-max singleton format anyway — the copy rule already caps
  //   it); the commander complaint is Task 9's.
  // oldschool: TWO rows of the same oracle card, one printing legal and one
  //   not_legal — the not_legal row errors, the legal row is silent. No special
  //   case in the engine: each row carried its own blob.
  // hasLegalityData false (casual/limited): a banned-everywhere card is silent.
  // A missing key ({} or null legalities) → not_legal wording, severity error —
  //   except orphans (cardId facts all null), which get one "warning" naming the
  //   needs_review sentence instead of a legality guess.
});
describe("sideboard and mana value", () => {
  // side 16 in Modern → "Sideboards are capped at 15 cards; you have 16."
  //   sideboardMax 0 (Commander) + 1 side card → "Commander decks have no
  //   sideboard." sideboardMax null (limited) + 40 side cards → silence.
  // maxManaValue 3 (tlr): a cmc-4 card errors; an adventure whose FACE costs 4
  //   errors through `faces` even when the card's own cmc is 3 — "every card and
  //   every face" (research doc).
});
```

- [x] **Step 2: Run and watch them fail** — `npm run test:run -- validation`.

- [x] **Step 3: Implement.** The engine is a pipeline of small pure functions over one pre-computed view (`byOracle: Map<oracleId|name, {cards, mainAndSideQuantity}>` — copy limits count main + side combined, CR 100.4a; `zoneTotals`). `copyException`:

```ts
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10,
};

export function copyException(oracleText: string | null): number | null {
  if (!oracleText) return null;
  if (oracleText.includes(ANY_NUMBER_PHRASE)) return Infinity;
  // "A deck can have up to seven cards named …" — the number is printed as a word.
  const upTo = oracleText.match(
    new RegExp(`${UP_TO_PHRASE} (\\w+) cards named`),
  );
  if (!upTo) return null;
  return WORD_NUMBERS[upTo[1].toLowerCase()] ?? Number.parseInt(upTo[1], 10) || null;
}

export function isBasicLand(typeLine: string | null): boolean {
  return typeLine?.split("//")[0].includes("Basic") ?? false;
}
```

Per-face MV for `maxManaValue`: parse `faces` JSON, take each face's `cmc` if present, else compute from the face's `mana_cost` symbols (a helper `manaValueOf(cost)` — `{2}{U}` → 3, `{X}` → 0, hybrid `{W/U}` → 1 — export it; Task 15's curve uses the same arithmetic and there must be one). Messages are template helpers so wording is uniform; every message uses the card's `name` and real numbers, sentence case, no exclamation marks.

- [x] **Step 4: Verify and commit** — `npm run verify`, then:

```
feat: deck validation engine — size, copies, legality, singleton exceptions
```

---

### Task 9: The validation engine, part 2 — commanders, partners, colour identity

The commander suite, still pure TS, keyed by `spec.commanderRule` — six data values, six eligibility functions, one pairing rule, one identity rule. The research doc's CR citations ride along as comments so the next reader argues with the CR, not with us.

**Files:**
- Create: `src/features/decks/validation/commanders.ts` + `commanders.test.ts`
- Modify: `validation/engine.ts` (calls into it when `spec.requiresCommander`)

**Interfaces:**
- Produces:

```ts
/** Can this card sit in the commander zone under this rule? Returns null for "yes"
 *  or the sentence that says why not. */
export function commanderIneligibility(
  card: CardFacts, rule: NonNullable<FormatSpec["commanderRule"]>, spec: FormatSpec,
): string | null;
/** The zone as a whole: count (1, or 2 under a partner mechanic), pairing rules
 *  (702.124), oathbreaker's PW + signature spell, duel/tlr's banned-as-commander. */
export function validateCommanderZone(
  zone: CardFacts[], spec: FormatSpec,
): ValidationIssue[];
/** 903.5c/d in one subset test over Scryfall's precomputed field (it already folds in
 *  DFC backs, adventures, reminder-text exclusion, colour indicators AND basic land
 *  types — which is why there is no second check for lands). */
export function colorIdentityIssues(
  cards: CardFacts[], commanderIdentity: ReadonlySet<string>,
): ValidationIssue[];
export function identityOf(card: CardFacts): ReadonlySet<string>;
```

- [x] **Step 1: The test matrix**, real cards as fixtures (name them in the tests — reviewers can check them against Scryfall):

```ts
describe("eligibility by rule", () => {
  // edh: legendary creature ✓ · nonlegendary creature ✗ ("must be legendary") ·
  //   legendary Vehicle WITH P/T ✓ (Shorikai: power "1", toughness "5") · legendary
  //   Vehicle/Spacecraft with NO P/T box ✗ (the CR 903.3 2026 clause — power/
  //   toughness are the columns Task 2 added for exactly this line) · "can be your
  //   commander" text ✓ on a planeswalker (Teferi, Temporal Archmage) ·
  //   DFC: the FRONT face decides (read faces[0]'s type_line when layout is a
  //   faces-only layout).
  // brawl: adds any legendary planeswalker (CR 903.12c is broader than EDH) —
  //   Teferi, Hero of Dominaria ✓ in brawl, ✗ in edh.
  // oathbreaker: ONLY a planeswalker (the signature spell is checked by the zone
  //   rule, not eligibility).
  // pdh: TRAP C — everUncommon && creature/Vehicle/Spacecraft, legendary NOT
  //   required; a paupercommander:not_legal on the card itself must NOT veto it
  //   (the key covers the 99 only — the test seeds exactly that contradiction).
  // duel: legendary creature or "can be your commander"; PLUS banned-as-commander:
  //   legalities.duel === "restricted" in the commander zone → "X is banned as a
  //   commander in Duel Commander." — and the SAME card in the main deck is silent
  //   (that is TRAP A's whole point). tlr: same semantic, plus legendary
  //   creature/planeswalker/Vehicle eligibility and the MV cap from Task 8.
});
describe("partners and pairing (702.124)", () => {
  // Two commanders both with "Partner" ✓ · one with, one without ✗ (g: never more
  //   than two is its own error at 3) · "Partner with Blaring Captain" requires the
  //   NAMED card — mutual, checked by name · partner—[text]: "Friends forever" +
  //   "Friends forever" ✓, "Friends forever" + "Character select" ✗ (same text
  //   required; 702.124f: variants never mix — plain Partner + Friends forever ✗) ·
  //   "Choose a Background": commander + a LEGENDARY Background enchantment ✓;
  //   two Backgrounds ✗ · "Doctor's companion": + a legendary Time Lord Doctor
  //   (type line contains "Time Lord Doctor" and no other creature types) ✓.
  // Oathbreaker zone: PW + one instant/sorcery ✓; the spell's identity must fit
  //   inside the oathbreaker's (a red signature spell under a mono-white OB errors).
  // Combined identity (702.124c): a WU partner + a BR partner → deck identity WUBR;
  //   colorIdentityIssues receives the UNION.
});
describe("colour identity (903.5c/d via Scryfall's field)", () => {
  // Mono-W commander: a card with identity ["W"] ✓, ["W","U"] ✗ — "Azorius
  //   Charm's colour identity (WU) is outside your commander's (W)."
  // The land case rides the same field: Taiga (identity RG from its land TYPES,
  //   no mana symbols anywhere on it) under a mono-G commander ✗ — this fixture IS
  //   the 903.5d test, and it passes with no land-specific code because Scryfall
  //   already folded land types in.
  // Colourless artifacts ([] ) fit any identity; a colourless commander (Kozilek)
  //   admits only [].
});
```

- [x] **Step 2: Run, fail, implement.** Notes that are load-bearing:
  - Front face first: `factsFace0(card)` merges `faces[0]`'s `type_line`/`oracle_text`/`power`/`toughness` over the card's own when `faces` is present — eligibility and partner keywords read the front face (`card_row` already hoists cost/type for most layouts; the merge makes the engine independent of which).
  - Keyword detection is line-anchored on oracle text: `Partner with ([^\n(]+?)(?:\s*\(|\n|$)` (reminder text in parentheses is stripped first — 903.4c's lesson applies to parsing too); bare `Partner` must match a line that is exactly `Partner` or `Partner (`-prefixed, so "Partner with" never half-matches; `Partner—(.+)` captures the flavour text tag; `Doctor's companion` and `Choose a Background` are literal phrases; `can be your commander` is a phrase test on the unstripped text (it lives in rules text, not reminder text, on the 32 cards that carry it).
  - `identityOf` parses `color_identity` JSON to a Set once; the deck identity is the union across the commander zone's non-signature-spell cards.
  - `banned_as_commander` reads `card.legalities[spec.key] === "restricted"` **only for commander-zone cards** — main-deck restricted under this semantic is silence (Task 8 already routed by `restrictedSemantic`).

- [x] **Step 3: Verify and commit** — `npm run verify`, then:

```
feat: commander eligibility, partner pairing, colour identity validation
```

---

### Task 10: The validation engine, part 3 — companions and the bracket advisory

The ten companions are deck-shape conditions over facts the engine already holds, and the Commander bracket estimate is **advisory, never blocking** (research doc: brackets beta, B3 ≤ 3 game changers) — a separate module returning an estimate, not issues. Carryover MUST-DO 2 lands here: `game_changer: true` finally gets fixtures, in the Vitest matrix **and** in the Rust ingest fixture (one line card carrying `"game_changer": true`, asserted through to the column — the flag the whole estimate hangs on must be proven to survive the pipeline).

**Files:**
- Create: `src/features/decks/validation/companions.ts` + `companions.test.ts`, `validation/bracket.ts` + `bracket.test.ts`
- Modify: `validation/engine.ts` (companion zone wiring), `src-tauri/src/ingest.rs` (the game_changer fixture line + assertion)

**Interfaces:**

```ts
// companions.ts — one entry per companion, keyed by NAME (there are ten, printed once
// each; the research doc's list). Each condition is a pure predicate over the deck's
// main+commander cards with a message factory for its failures.
export function companionIssues(
  companionZone: CardFacts[], deck: CardFacts[], spec: FormatSpec,
): ValidationIssue[];

// bracket.ts
export interface BracketEstimate {
  /** 1–5, a heuristic reading, never enforced. */
  bracket: number;
  gameChangers: number;
  /** The cards behind the number, for the panel's disclosure. */
  gameChangerNames: string[];
  massLandDenial: string[];
  extraTurns: string[];
}
export function estimateBracket(cards: CardFacts[]): BracketEstimate;
```

- [x] **Step 1: The test matrix.**
  - Zone rules first: more than one companion → error; `spec.allowsCompanion` false (gladiator — the seed's data, not a key test) → "Gladiator has no sideboard, so it has no companions."; a companion that is not a companion (no "Companion —" text) → error; in EDH the companion must also satisfy singleton + the deck's colour identity ("effectively a 101st card") — reuse Task 8/9's functions over `[...deck, companion]`.
  - The ten conditions, one honest fixture each (research doc's own phrasings): **Gyruda** even MV only · **Jegantha** no cost with a repeated symbol — `{1}{W}{W}` fails, `{W}{U}{B}{R}{G}` passes, faces' costs count, generic `{2}` is one symbol · **Kaheera** every creature is Cat/Elemental/Nightmare/Dinosaur/Beast (changelings noted as a known false negative in a comment — "changeling" text is not a creature type list; documented, not solved) · **Keruga** every nonland MV ≥ 3 · **Lurrus** every permanent MV ≤ 2 · **Lutri** nonland names distinct (and the comment records: unbanned in Commander 2026-02-09, still banned in Brawl/CompBrawl — the *legality* half of that is Task 8's ordinary banned check, no code here) · **Obosh** odd MV + lands · **Umori** all nonlands share a card type · **Yorion** deck size ≥ deckMin + 20 (the one condition that reads the spec) · **Zirda** every permanent has an activated ability (heuristic: oracle text contains a `:` outside reminder parentheses; the comment owns its precision).
  - Bracket: 4 game changers → `gameChangers: 4`, bracket ≥ 4; zero flags + no extra-turn/MLD text → bracket 1–2; "Take an extra turn" and "Destroy all lands" fixtures land in their lists. Assert the shape, not a rules-lawyer table — the number is advisory and the test says so.
- [x] **Step 2: Run, fail, implement.** `companions.ts` is a `Record<string, CompanionRule>` with `{ applies: (deck, spec) => Issue[] }` per name; unknown companion names produce the not-a-companion error rather than silence. `estimateBracket` counts `gameChanger === true`, greps for `"extra turn"` and MLD phrases (`"destroy all lands"`, `"lands"` + `"sacrifice"` in one sentence) case-insensitively, and maps: any MLD or >6 changers → 5; 4–6 changers → 4; 1–3 → 3; extra-turns only → 3; else 2 with an empty-handed 1 when the deck also has no tutors marker (keep the mapping in one commented table — it is a heuristic and the comment says which beta document it paraphrases).
- [x] **Step 3: The Rust fixture** — `ingest.rs`'s fixture JSONL gains a card with `"game_changer": true`; the ingest test asserts the column reads 1. (MUST-DO 2 discharged: the flag is now proven end to end — bulk line → column → `DeckCardRow.game_changer` (Task 5's read serializes it) → `estimateBracket`.)
- [x] **Step 4: Verify and commit** — `npm run verify`, then:

```
feat: companion validation and the advisory bracket estimate
```

---

### Task 11: The Decks view — gallery, create, duplicate, archive

**This is a frontend task: invoke the `frontend-design` skill before writing any code, and execute `docs/superpowers/specs/2026-08-04-visual-design-direction.md` — palette, type roles, chip vocabulary and motion budget are decided there, not here.**

The gallery spec §7 promises: a wall of cover-art cards. A deck tile is the `art` variant of its cover card (`cover_card_id`, defaulting on the backend read to nothing — the tile without a cover shows the empty 5:7-adjacent frame the image layer already draws), and because an art crop lacks the printed frame, **the tile carries the artist credit and the gallery footer carries `Card images © Wizards of the Coast · Data © Scryfall`** (image policy, spec §5/§10). Creating a deck asks two things — a name and a format — and the format picker is the seeded table, `enabledInPicker` rows in `sortOrder`, so Future Standard never appears.

**Files:**
- Create: `src/features/decks/DecksPage.tsx` + `DecksPage.test.tsx`
- Modify: `src/App.tsx` (the `decks` blurb goes; `DecksPage`/`DeckEditor` mount by `openDeckId`)

**Interfaces:**
- Consumes: `useDecks()`, `useFormatSpecs()`, `ipc.deckCreate/deckUpdate/deckDelete/deckDuplicate`, `cardImageUrl(id, 0, "art")` from `@/lib/images` (its real argument order: card, face, variant), `useAppStore` (`openDeckId`, `setOpenDeckId`), `useDismissOnEscape` (`"inner"` for the create form popover), `Figure`/`FigureRow` if a summary strip is wanted — it is not: the gallery's story is the covers.
- Produces: `DecksPage` (no props — the store owns which view is open, `App.tsx`'s pattern).

- [x] **Step 1: Failing tests** — `DecksPage.test.tsx` with mocked `ipc`: an empty state that says what a deck is and carries the one primary action ("New deck"); tiles render name, format display name, `cardCount` in the mono data face, an `Archived` section separated and collapsed by default; the cover `<img>` src is the `art` URL and the credit line renders the artist; create flow: open form (focus lands in the name field), pick a format (seeded list order asserted, `future` absent), submit calls `deckCreate` and the new deck opens (`setOpenDeckId`); duplicate and archive actions call their commands; delete asks first (a deck is minutes of work — one confirm, in words naming the deck) and Escape closes the form popover without leaving the view.
- [x] **Step 2: Run, fail, implement.** Layout notes the direction binds: tiles are art-first (5:7-adjacent crop frame, name + format caption below in Geist, count in Geist Mono), the gallery is a CSS grid over `minmax(200px, 1fr)`, hover reveals the actions row (`REVEAL_ON_HOVER`'s pattern), focus-visible gold outline on every control, `motion-reduce:transition-none` on the one 150 ms hover transition. No colour anywhere except the art itself. The create form is a popover, an `"inner"` Escape layer that hands focus back to the New deck button.
- [x] **Step 3: Verify in the app** (CDP: create, rename, duplicate, archive, delete; covers paint; console clean), then `npm run verify` and commit:

```
feat: decks gallery with card-art covers and create/duplicate/archive
```

---

### Task 12: The deck editor — zones, steppers, click-to-add

**This is a frontend task: invoke the `frontend-design` skill before writing any code, and execute the visual direction doc.**

The editor spec §7 describes: zones center-stage, grouped by card type or mana value. Every edit is an IPC write through Task 4's commands — there is no draft state to save, which is what "autosave" honestly means here (spec §7 "Save/load to DB (autosave drafts)"): the DB row *is* the draft. Click-to-add is the spec's accessibility floor and lands in this task; drag arrives in Task 14 on top of it, never instead of it.

**Files:**
- Create: `src/features/decks/DeckEditor.tsx` + test, `src/features/decks/ZoneColumn.tsx` + test
- Modify: `src/App.tsx` (editor mounts when `openDeckId` is set and the view is `decks`)

**Interfaces:**
- Consumes: `useDeck(id)`, `useFormatSpecs()`, `ipc.deckAddCard/deckSetCardQuantity/deckMoveCard/deckUpdate`, `QuantityStepper` (`{ value, onChange, min, max, label }` — its real props), `ManaText`, `RarityGem`, `useAppStore().setSelectedCardId` (a row click opens the existing `CardDetailPane` — it is docked at `App` level and already an `"outer"` Escape layer, so the editor gets a detail pane for free), `usdPrice`/`PRICES_AS_OF`.
- Produces: `DeckEditor({ deckId })`, `ZoneColumn({ zone, title, cards, groupBy, onAdd, onSetQuantity, onMove })`.

- [x] **Step 1: Failing tests.** The editor renders: header (deck name as an inline-editable field committing on blur/Enter through `deckUpdate`; the format select; the **Built** toggle with its meaning in a tooltip — "reserves your copies for this deck"; a back control returning to the gallery via `setOpenDeckId(null)`); the five zones with `main` widest and `commander`/`companion` compact (hidden entirely when the format's spec neither requires a commander nor allows a companion — the seeded data drives the chrome); group-by control (Type default / Mana value) that regroups main's rows under Cinzel-free 12px `text-dim` headers with counts; each row: quantity stepper (zero removes — assert the row leaves and `deckSetCardQuantity(…, 0)` was the call), name, `ManaText` cost, set·number in mono, unit price, an owned mark (`3/4` in mono when `ownedQuantity < quantity`, nothing when fully owned — absence is the healthy state); a row click opens the card (`setSelectedCardId`), stepper clicks do not (stopPropagation, the search table's pattern); "Set as cover" in the row's hover actions calls `deckUpdate({ coverCardId })` — the cheap cover picker the plan scope allows; an orphaned row renders from its denormalized name with its `needs_review` sentence and no dead image.
- [x] **Step 2: Run, fail, implement.** Grouping is a pure `groupCards(cards, groupBy)` helper (exported, tested): by type — the eight buckets in printed order (Creature, Planeswalker, Instant, Sorcery, Artifact, Enchantment, Battle, Land; front face's type line decides; anything else lands in Other) — or by MV (0–7, 8+, the filter chips' own bucketing). Zones scroll independently inside the editor's own `overflow` containers (no page-level horizontal scroll at 1024px — the direction's floor). The `maybe` zone sits collapsed under the columns; it is a scratchpad, and the stats/validation of Task 15 never read it.
- [x] **Step 3: Verify in the app** (CDP at 1024 and 1280: add via the pane's printings + steppers, move via zone menu fallback — a small per-row "move to…" menu is the click path `deckMoveCard` needs before drag exists; Escape stack: pane closes before editor state is touched), then `npm run verify` and commit:

```
feat: deck editor — zone columns, grouping, steppers, inline rename, cover pick
```

---

### Task 13: The docked search panel

**This is a frontend task: invoke the `frontend-design` skill before writing any code, and execute the visual direction doc.**

Spec §7: "search panel docked right." Not a second search implementation — the panel is `useCardSearch` + `FilterBar` + `CardGrid`, the search view's own parts, in a 320px column. `CardGrid`'s two slots were built for exactly this (its doc: "Anything a *particular* wall needs beyond this arrives through the two slots"): the `action` slot becomes **Add to deck**, and the tiles stay selectable so the detail pane keeps working from inside the editor.

**Files:**
- Create: `src/features/decks/DeckSearchPanel.tsx` + test
- Modify: `src/features/decks/DeckEditor.tsx` (docks it)

**Interfaces:**
- Consumes: `useCardSearch()` (`{ query, rows, searchKey, total, … }` — the whole `CardSearch`), `FilterBar({ search })`, `CardGrid` (`rows/listKey/selectedId/onSelect/badge/action/onNeedNextPage`), `OwnedBadge`, `ipc.deckAddCard`, `parseFinishes` is **not** needed — a deck card has no finish.
- Produces: `DeckSearchPanel({ deckId, targetZone, onTargetZoneChange })`.

- [x] **Step 1: Failing tests.** The panel renders the filter bar and grid over a mocked search; its header carries a compact **target zone** select (Main default; Sideboard only when the spec has one; Commander/Companion when the spec does — seeded data drives it again) — this select is the click path's zone choice and therefore the keyboard's, which is what makes drag optional; each tile's action button calls `deckAddCard(deckId, cardId, targetZone, 1)` and the row's `OwnedBadge` still tells the collection story; tile click still opens the detail pane (`onSelect` → `setSelectedCardId`); the panel is collapsible (the editor is usable at 1024px with it closed; the toggle names itself "Search cards").
- [x] **Step 2: Run, fail, implement.** One narrow-column adaptation is allowed: `FilterBar` in the panel may wrap its chip rows (it already flex-wraps — verify, don't fork it). The grid's `listKey` is the panel's own `searchKey` so a new search scrolls to top; images warm through the existing `prefetchImages` effect pattern only if the panel reuses `SearchPage`'s effect — it does not: the grid's overscan warming is enough for a 320px column of ~2 tiles per row, and the comment says so.
- [x] **Step 3: Verify in the app**, `npm run verify`, commit:

```
feat: docked search panel in the deck editor, click-to-add with target zone
```

---

### Task 14: Drag and drop

**This is a frontend task: invoke the `frontend-design` skill before writing any code, and execute the visual direction doc.**

`@atlaskit/pragmatic-drag-and-drop@2.0.2` + `-hitbox@2.0.0` + `-auto-scroll@3.0.0` (versions verified on npm 2026-08-05; the indicator package is **deliberately absent** — Tech Stack records why, and the licenses screen owed for the Apache-2.0 NOTICE is Plan 6's). Drags: search tile → zone column (add), row → other zone (move), row → the remove tray (remove). Every one of these already has a click path from Tasks 12–13 — drag is speed, not capability (spec §7's "click-to-add fallback everywhere").

**Files:**
- Create: `src/features/decks/dnd.ts` + `dnd.test.ts`, `src/features/decks/DropIndicator.tsx`
- Modify: `package.json` (the three deps), `DeckSearchPanel.tsx`, `ZoneColumn.tsx`, `DeckEditor.tsx`

**Interfaces:**
- Consumes: `draggable`, `dropTargetForElements`, `monitorForElements` from `@atlaskit/pragmatic-drag-and-drop/element/adapter`; `attachClosestEdge`/`extractClosestEdge` from `-hitbox/closest-edge`; `autoScrollForElements` from `-auto-scroll/element`.
- Produces:

```ts
// dnd.ts — the data contract, typed once so a drop target cannot misread a source.
export type DragPayload =
  | { kind: "search-card"; cardId: string; name: string }
  | { kind: "deck-card"; cardId: string; name: string; fromZone: DeckZone };
export function dragData(p: DragPayload): Record<string, unknown>;
export function readDragData(data: Record<string, unknown>): DragPayload | null;
```

- [x] **Step 1: Failing tests** — `dnd.test.ts` round-trips the payload (`readDragData(dragData(p))` is `p`; garbage is `null` — drops from outside the app must be inert); `ZoneColumn.test.tsx` gains a drop test using the adapter's own events if practical, otherwise the drop handler is extracted (`onDropPayload(payload, targetZone, deckId)` → the right `deckAddCard`/`deckMoveCard` call) and unit-tested directly, with the wiring left to the live smoke — record which in the test file's header.
- [x] **Step 2: Implement.**
  - `npm install` the three exact versions.
  - Search tiles: `draggable({ element, getInitialData: () => dragData({ kind: "search-card", … }) })` in a `useEffect` per tile ref — attach via `CardGrid`'s `action` cell's parent? No: `CardGrid` stays untouched; the panel wraps each tile through `CardGrid`'s existing render slots only if a slot can carry a ref — it cannot, so the *panel* attaches one `draggable` per rendered tile via event delegation is not something the library offers either. The honest wiring: `CardGrid` gains one optional prop, `tileRef?: (card: T, el: HTMLElement | null) => void`, a callback ref forwarded to each tile's root — three lines in `CardGrid`, no behaviour change when absent, tested by the panel. (This is the one shared-component edit in the plan; keep it exactly this small.)
  - Zone columns: `dropTargetForElements` on the column's scroller (`getData: () => ({ zone })`, `canDrop` by payload kind), `autoScrollForElements` on the same element. Drop → `onDropPayload`.
  - Rows: `draggable` with `kind: "deck-card"`; while any drag is active (a `monitorForElements` in `DeckEditor` sets local state) a **remove tray** appears along the editor's bottom edge — a labelled drop target ("Remove from deck") that calls `deckSetCardQuantity(…, 0)`; it appears only for `deck-card` payloads, and it appears instantly (no transition — motion budget).
  - `DropIndicator`: a 2px `bg-accent` line at the closest edge of the hovered row/column (hitbox's `extractClosestEdge`), absolutely positioned, `aria-hidden` — ~20 lines, app tokens, the reason the Atlaskit indicator package stays out.
  - The drag preview is the platform's (the element snapshot `setDragImage` gives) — no custom preview, no portal, nothing for the CSP to see.
- [x] **Step 3: Verify in the app over CDP** — and this is the task whose verification is the point: drag from panel to main (row appears, count moves), between zones (fold honoured), to the tray (row leaves); **console shows zero CSP violations** (the `console out.jsonl` recorder watching both event families — a violation is exactly the class of error a suite cannot see); `prefers-reduced-motion: reduce` leaves no animation running; keyboard-only pass still builds a deck through Task 12–13's click paths. Then `npm run verify`, commit:

```
feat: drag-and-drop across zones, search panel and remove tray
```

---

### Task 15: Live stats and the validation panel

**This is a frontend task: invoke the `frontend-design` skill before writing any code, and execute the visual direction doc — the colour pips are the pie deeps, the curve is data-quiet, and nothing here animates.**

Spec §7's two remaining Deckbuilder clauses. Live stats: mana curve, colour pips, type counts, average MV, deck price, owned-vs-missing — every number derived from the same `DeckCard[]` the editor already holds, in a strip under the header. Validation: the engine's issues as precise sentences behind a header chip — never blocking, exactly as advisory as the spec demands, with the bracket estimate in the same panel for commander-rule formats.

**Files:**
- Create: `src/features/decks/DeckStats.tsx` + test, `src/features/decks/ValidationPanel.tsx` + test
- Modify: `src/features/decks/DeckEditor.tsx` (mounts both)

**Interfaces:**
- Consumes: `validateDeck`/`estimateBracket`/`manaValueOf` (Task 8–10 — the engine's one consumer), `useFormatSpecs`, `Figure`/`FigureRow`, `usdPrice`/`PRICES_AS_OF`, `eurPrice` is **not** used (deck price is USD; the EUR twin is the wishlist's story), `useDismissOnEscape` (`"inner"`), `ipc.deckMissingToWishlist`.
- Produces: `DeckStats({ cards })`, `ValidationPanel({ cards, spec })`, and a pure `deckStats(cards)` helper — exported and unit-tested; `maybe` excluded from all of it:
  - curve buckets 0–7/8+ over **nonlands** (lands have their own chart now; MV 0 lands would flood the first bucket),
  - pips per colour from `colors` (a WU card feeds both W and U — the overlapping "what can this deck cast" measure, kept alongside the pie, which answers a different question),
  - `colorDist`: nonland cards bucketed exactly one of W/U/B/R/G (mono), Multicolor (2+ letters in `colors`), Colorless (empty) — buckets sum to the nonland total so they can pie,
  - `landDist`: lands bucketed Plains/Island/Swamp/Mountain/Forest by basic land type on the front-face type line, Multi-type (2+ basic types), Other lands (none) — sums to the land total,
  - `typeDist`: counts per primary type (Creature/Instant/Sorcery/Artifact/Enchantment/Planeswalker/Battle/Land/Other) from the Task 12 grouping helper,
  - average MV over nonlands, price sum + unpriced count, owned/missing totals.

- [x] **Step 1: Failing tests.** `deckStats` over a hand-built deck: curve buckets right (an 8+ card lands in the last), pips count pips not cards (a WU card feeds both W and U — from `colors`, not identity: the curve strip describes casting costs), average MV ignores lands, price sums `unitPriceUsd` × quantity with an `n unpriced` counter (never `price_usd` — the row's field is already the blob's `usd`), owned/missing totals agree with the rows. `DeckStats` renders the pips row **and four charts, every chart carrying its numbers as visible text** (user requirement 2026-08-05, additive to the original strip — a chart with no numbers fails the task, and dropping a previously specced figure fails it too): the pips row stays as specced (one dot per colour in the **pie deep** fills with mono counts — the overlapping castability measure); the mana curve as 9 proportional bars with a mono count above/beside each bar (bars in `bg-surface` with a `bg-accent` fill — the curve stays data-quiet); **colour distribution as a pie** (hand-rolled inline SVG arcs — no chart library, no portal, no animation) in the **pie deep** fills (gold `#D9B95C` for Multicolor, `#C8C4BF` for Colorless) with a legend of mono counts per segment; **land distribution as a second pie**, same construction, basic-type segments in their pie deeps, Multi-type in gold, Other lands in colorless grey, legend with counts; **type distribution as horizontal bars** (the best chart for eight nameable categories — pies fail past six) with the count at each bar's end in mono. A zero bucket draws no segment and no legend row; an empty deck renders the strip's figures and no charts. Each chart's `<svg>` is `aria-hidden` — the legend/caption text IS the accessible story, no duplicate narration; price carries `PRICES_AS_OF` as its title; "3 of 60 missing" renders beside a **Send missing to wishlist** button that calls `deckMissingToWishlist` and reports what it did in words ("Added 3 wishes.") — and is absent when nothing is missing. `ValidationPanel`: the chip reads "No issues · Modern" or "3 issues" (`text-destructive` number, no red backgrounds); opening lists issues grouped by `code` with each `message` verbatim from the engine; clicking an issue's card name selects the card (`setSelectedCardId`); the chip is `aria-expanded` and the panel is an `"inner"` Escape layer handing focus back to the chip; for commander-rule formats the bracket section renders "Bracket ~3 · 2 game changers" with a disclosure naming them, and the copy says "estimate" — it is advisory and reads as one.
- [x] **Step 2: Run, fail, implement.** Validation runs in a `useMemo` over `(cards, spec)` — the engine is pure and a deck is ≤ a few hundred rows, so it runs on every edit without debouncing; if profiling in the smoke says otherwise, note it in the carryover rather than optimizing blind. The stats strip is one `FigureRow` plus the visual clusters (pips row, curve, the two pies, type bars); at 1024px the clusters wrap to further lines rather than truncating — the strip may become a stats *block* below the header at the editor's narrower widths, and that is fine; what is not fine is a chart whose numbers clip.
- [x] **Step 3: Verify in the app** (CDP: build an illegal Vintage deck and read the exact restricted sentence; a WU card under a mono-W commander names itself; the missing→wishlist round trip lands in the Wishlist view with the any-printing badge; **read the four charts' numbers off the live DOM against a seeded deck whose distribution you know** — a 24-land Boros deck's two pies and curve are checkable by hand), `npm run verify`, commit:

```
feat: live deck stats and the validation panel with bracket advisory
```

---

### Task 16: The live smoke, CLAUDE.md, and the carryover

The plan's Task 14-of-Plan-3 equivalent: drive the real app over CDP (`scripts/cdp.mjs`), fix what only the running window can show, write the invariants into CLAUDE.md, and hand Plan 5 its carryover. Seed and clean fixtures with `node:sqlite` against `src-tauri/target/debug/data/mtg.db` while the app holds it; delete every seeded row afterwards.

**Files:**
- Modify: `CLAUDE.md`, whatever the smoke indicts
- Create: `docs/superpowers/notes/plan-4-carryover.md`

- [x] **Step 1: The scripted smoke**, recorded in the carryover with numbers:
  - Deck lifecycle: create (Commander), rename, cover from a card, archive/unarchive, duplicate, delete — gallery truthful throughout.
  - Build a real Commander deck ~15 cards via all three add paths (panel click-to-add, drag, detail-pane printings). The grain: the same printing added twice folds; zones separate.
  - Validation truth-spotting against the live database: a 99-card commander deck reads the exactly-100 message; 2 Sol Ring reads the singleton message; Relentless Rats ×10 is silent; a `restricted`-in-Vintage card ×3 in a Vintage deck reads the spec §7 sentence verbatim; a WU card under a mono-W commander names itself; Serra Angel `8ed` in an Old School deck errors while `lea` does not (TRAP B, live).
  - Allocations: own 3 of a wanted 4 → "3 of 4"; mark Built, second deck wanting the same card reads 0 available; step the collection row to 0 → the deck reads honestly after refetch (`["decks"]` invalidation from the collection mutation — watch it happen).
  - Missing→wishlist round trip; the wishlist EUR figure and needs-review chip (flag a wish via a fake migration row, watch the chip narrow).
  - The reconciler in anger: seed a deck card on a fake id, force a sync, watch the flag arrive and the banner language; repoint and watch it clear. Confirm a fold scenario preserves an allocation (seed the collision, run the migration path).
  - Environment sweeps: 1024/1280 px no horizontal scroll; `prefers-reduced-motion: reduce` neutral; keyboard-only deck build (tab stops named, focus gold); Escape stack — validation popover → detail pane → nothing, one layer per press, focus handed back; console: **0 errors, 0 warnings, 0 CSP violations** across the whole session with both event families recorded.
  - Timings worth writing down: `deck_get` on a 100-card deck; `validateDeck` wall time in the panel; allocator cost inside a zone write (it runs per edit — this is the number that decides whether Plan 6 needs to care).
- [x] **Step 2: Fix what it finds** (small fixes inline in this task; anything structural becomes a ledgered carryover item instead).
- [x] **Step 3: CLAUDE.md** — a "Hard rules — decks" addition in the file's voice: the three enforced FKs and *why exactly three* (fold repoints before delete; nothing ever references `cards`); zones enum + zero-removes; `format_specs` is data (a rules change is a reseed step, never engine code); validation is TS and where it lives; deck price = the blob's nonfoil `usd`, never `price_usd`; deck cards ride the pre-warm UNION and the reconciler's three-table sweep. Amend the schema-version references (v5, P/T columns, the corpus figure if the smoke re-syncs).
- [x] **Step 4: `docs/superpowers/notes/plan-4-carryover.md`** — measured results, findings ledger, deferred-with-reasons (start from this plan's Later-plans section), and the MUST-DO list for Plan 5 (at minimum: deck import needs `deck_add_card`'s zone vocabulary and the Arena `arena_code ?? code` mapping already in `sets`; the export writers read the same `DeckDetail` the editor does; the Owned-chip semantics ruling plan-3 parked is still open).
- [x] **Step 5: `npm run verify`**, close the checkboxes, commit:

```
chore: complete plan 4 (decks & deckbuilder) — smoke, CLAUDE.md, carryover
```

---

## Carryover ledger

Every item from `docs/superpowers/notes/plan-3-carryover.md` addressed to Plan 4, and where it went.

| Carryover item | Landed |
|---|---|
| MUST-DO 1: the enforced FK belongs on `deck_allocations.collection_entry_id`, and nowhere near `cards` | **Task 2** (the DDL + delete-site tests) and Global Constraints (the treaty: three FKs, all user↔user). |
| THE design gate (final review I6): repoint-in-fold before delete; FK actions per delete-site | **Task 3** (`a_fold_moves_deck_allocations_to_the_surviving_entry_before_it_deletes` + the collision fold) over **Task 2**'s CASCADE choices. |
| MUST-DO 2: `game_changer: true` has no fixture | **Task 10** — Vitest fixtures for the bracket AND the ingest fixture line proving the flag survives bulk → column → `DeckCardRow`. |
| MUST-DO 3 / natural companion: deck cards join `prewarm_collection`'s UNION | **Task 4** (one UNION arm + the extended test; still `grid`-only per the constant's own doc — the wishlist-only-user asymmetry closes with it). |
| MUST-DO 4: read CLAUDE.md's user-data hard rules first | Global Constraints reproduces the load-bearing ones (grain, zero-keeps vs zero-removes, per-finish pricing, `needs_review` is a sentence) and Task 16 extends the file. |
| MUST-DO 5: every collection write goes through `add_entry`/`update_entry` | The allocator writes `deck_allocations` only — restated in Global Constraints and enforced by Task 5's "never touches the collection" test. |
| MUST-DO 6: verify in the running app with `scripts/cdp.mjs` | Tasks 11–15 each carry a CDP step; **Task 16** is the full smoke. |
| Parked fold 1: `useSyncInvalidation.test.ts` asserts against its own constant | **Task 1** (the literal five-key assertion; **Task 7** grows it to six with `["decks"]`). |
| Parked fold 2: ingest-then-`/sets`-failure never invalidates the swapped corpus | **Task 1** (invalidate on `error` after an `ingesting` phase — the frontend already sees the whole story in the phases). |
| Parked fold 3: four stale `116,568` doc copies; `MAX_MIGRATION_PAGES` at 8/10 | **Task 1** (date-stamped sweep to 116,590; cap 10 → 20 with the release-build `eprintln!` rationale). |
| Deferred §4: same-day migration chains (date-only `performed_at`) | **Task 3** (transitive destination resolution inside `apply` — order stops being load-bearing). |
| Natural companion: `WishlistQuery.needsReview` (the chip's backend half) | **Task 6**. |
| Natural companion: wishlist header EUR twin (spec §7 "mirrors this") | **Task 6** (`WishRow.unitPriceEur` with the etched-is-unpriced rule + the second Figure). |
| Deferred §4: `decks`/`deck_cards`/`deck_allocations`/`format_specs` | This whole plan (**Tasks 2–15**). |
| Finding 3 (Escape on the pane lands focus on BODY from a virtualized row) | **Not taken**: a Plan-2-chrome virtualizer-recycling issue, unchanged by this plan's files; stays on Plan 6's ledger. |
| Findings 1–2 (reconciled-banner invalidation; six `motion-reduce` stragglers) | Finding 1 was closed by plan-3's own final wave (`3161459`); finding 2 is Plan-2 chrome, Plan 6's ledger — this plan's new UI carries the guard everywhere (Tasks 11–15). |

### Explicitly deferred, with reasons

| Deferred | To | Why |
|---|---|---|
| Import/export, including deck text formats (Arena/MTGO/plain, `.dek` XML) | **Plan 5** | Spec §7's own split. This plan ships the seam: `deck_add_card` folds on the grain exactly as `collection_add` does, so an importer is a loop over an existing command; the export writers read `DeckDetail`. |
| Custom cover art (`cover_kind = 'custom'`, `cover_image_path`, `data/covers/`) + the licenses screen (which owes the pragmatic-drag-and-drop Apache-2.0 NOTICE and the Scryfall/WotC lines) | **Plan 6** | Plan scope says so explicitly. The columns exist and stay NULL; the gallery's card-art path is complete without them. |
| "Add to open deck" from the *global* Search view (spec §7's hover-action list) | **Plan 6** | The editor's docked panel covers deck-building search; a global hover action needs an "open deck" affordance outside the Decks view — chrome that deserves its own decision. `DeckSearchPanel`'s add path is the reusable half. |
| Hover previews with full card image / DFC flip animation (spec §7 "Previews & polish") | **Plan 6** | The detail pane already answers "what does this card look like" from every deck surface; the flourish belongs with the polish plan's motion review. |
| Allocation rebalancing UI (choosing *which* copies a deck reserves; resolving over-subscription between built decks) | **Plan 6** | The greedy allocator is deterministic and honest about shortage; hand-tuning is a nicety. Task 16 measures the allocator so Plan 6 decides with numbers. |
| `thumb` pre-warm; set-picker ranking; `role=grid` + roving tabindex; overlay focus containment; Cinzel dead `.woff`; `--chart-*` tokens; Escape-focus from virtualized rows | **Plan 6** | Plan-2/3 ledger, untouched by this plan's files. |
| Keyset pagination for deep offsets | **Still deferred** | A deck is hundreds of rows at most; nothing here pages at all. |
| The search Owned-chip semantics ruling (entry-exists vs copies>0) | **Plan 5** | Plan-3's ledger already routes it there; nothing in this plan changes the question. |

### Spec coverage

| Spec §6 / §7 requirement | Landed |
|---|---|
| `decks` — id, name, format, description, cover_kind/cover_card_id/cover_image_path, is_built | **Task 2** (DDL; archive added for §7), **Task 4** (CRUD), **Task 11/12** (UI incl. cover pick) |
| `deck_cards` — deck, card, zone (`main\|side\|commander\|companion\|maybe`), quantity | **Task 2** (DDL + grain), **Task 4** (writes), **Task 12** (UI) |
| `deck_allocations` — computed availability, never decrements, Deckbox-style | **Task 2** (DDL + FK), **Task 5** (allocator + clamped reads), **Task 15** (owned-vs-missing UI) |
| `format_specs` seeded data: all 23 keys + casual/limited, `restricted_semantic`, `enabled_in_picker` | **Task 2** (the seed, cell-checked), **Task 5/7** (read + cache), **Task 11** (picker) |
| §7 zones center-stage, grouped by type or mana value; search panel docked right | **Task 12**, **Task 13** |
| §7 drag search→zone, between zones, out to remove; click-to-add fallback everywhere | **Task 14** over **Tasks 12–13**'s click paths |
| §7 live stats: curve, pips, type counts, average MV, deck price, owned-vs-missing, missing→wishlist | **Task 15** (UI) over **Task 5** (`deck_missing_to_wishlist`) |
| §7 validation: size, copy limits, restricted semantics, singleton exact-phrase exceptions, commander eligibility (incl. Vehicle/Spacecraft/PDH/Brawl), partners/Backgrounds/Doctor's companion, colour identity (Scryfall field + 903.5d), companion conditions, Old School per-printing; precise messages | **Tasks 8–10** (engine), **Task 15** (panel); the spec §7 example sentence is a pinned test string |
| §7 advisory bracket (game_changer count, MLD/extra-turn heuristics), never blocking | **Task 10** (estimate), **Task 15** (advisory copy) |
| §7 save/load (autosave drafts); duplicate/archive decks | Write-through IPC (**Tasks 4, 12**); duplicate/archive (**Tasks 4, 11**) |
| §5 pre-warm covers deck cards | **Task 4** |
| §5/§10 art policy: artist + copyright wherever `art` crops appear | **Task 11** (tile credit + gallery footer) |
| §3 validation in TS, Vitest-tested | **Tasks 8–10**, restated as a Global Constraint |

---

## Later plans (not in this document)

5. **Import/export** — CSV/Excel importers with preview-then-commit over `collection_add`; deck-text import (Arena/MTGO/plain/site flavors) over `deck_add_card` with `arena_code ?? code` set resolution and companion-in-sideboard dedupe; exporters (Moxfield CSV verbatim headers, full-fidelity native CSV, Excel, Arena/MTGO text from `DeckDetail`, PDF deck sheets with cover art + artist credit); the imported deck runs through this plan's validation engine as its preview's legality line; the Owned-chip semantics ruling.
6. **Polish & distribution** — Settings screen (Compact database, Clear image cache, data-folder indicator); custom deck covers (`cover_kind='custom'`, `data/covers/`) and the licenses screen (pragmatic-drag-and-drop Apache-2.0 NOTICE, Scryfall/WotC attribution); "add to open deck" from global search; hover previews/DFC flip; allocation rebalancing (with Task 16's allocator numbers); `thumb` pre-warm; the Plan-2/3 accessibility ledger (`role=grid`, roving tabindex, overlay focus containment, Escape-focus from virtualized rows); set-picker ranking; `--chart-*`/pie-deep chart tokens for the collection value charts; portable build + ZIP artifact; e2e smoke.
