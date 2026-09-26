# Token stacks, PR 2 — printings and modes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A token holds several printings — each a printing **and** a finish, with its own quantity, per list (`live`/`theory`) — added from the band's **Add printing** picker or from the deck's search column (tokens never become deck cards); a click swaps only that entry; every token write is undoable and in the deck's history; a **Managed / Hide** mode replaces the stack switch; a token nothing makes any more is removed; theory marks work at the printing-and-finish grain.

**Architecture:** Rust owns a new synced table `deck_token_printings` (user schema **v52**) and every rule about entries (materialise, fold, zero-keeps-last, reconcile) in `deck_tokens.rs`; writes record a `deck`-kind audit row (`field: "token"`) and an `Op::Tokens` undo step; the reconcile runs inside the step-filing card writes and as a `with_write` backstop. TypeScript turns each wire row into one view per entry, keys everything on `(cardId, finish)`, and draws the mode control, the picker grain and the band.

**Tech Stack:** Tauri 2 / Rust (rusqlite), React 19, TypeScript 6.0, Vitest, Storybook fake.

**Spec:** `docs/superpowers/specs/2026-09-26-token-stacks-design.md` §4 (as amended 2026-09-26 — read §4 in full, and §2's vocabulary). PR 1 (§3, merged as #542) is the base.

## Global Constraints

- User schema **v52** (main is at v51 = PR 1). If `main` ships a v52 first, renumber in its own commit before merging (memory `schema-rung-collisions-with-main`).
- A token is never a deck card: never a `deck_cards` row. `deck::add_card` and `collection_alloc::collection_to_deck` **reroute** a token-layout printing (`token`, `double_faced_token`, `emblem`) to a token entry; a rerouted `add_card` returns `EntryChange { id: 0, .. }`; a rerouted `collection_to_deck` moves no copy.
- Entry grain `(deck_id, variant, card_id, finish)`; `finish` NOT NULL, one of `nonfoil`/`foil`/`etched`.
- Entry rules 1–7 of spec §4.2 verbatim. Rule 3: stepping to 0 deletes the entry unless it is the token's last entry in that list.
- History: `deck_audit` kind **`deck`**, payload `{ "field": "token", "action": …, … }` — **never** a new kind (synced table; mixed-version stall).
- Undo: `Op::Tokens { restore: Vec<TokenEntryRow>, delete: Vec<TokenEntryRow>, states: Vec<TokenStateRow> }`; mode via `Op::Deck { token_mode }` (`DECK_FIELDS` gains `token_mode`).
- `decks.token_mode TEXT NOT NULL DEFAULT 'managed' CHECK (token_mode IN ('managed','collection','hidden'))`; `token_stack` dropped. **PR 2's control draws Managed and Hide only.** Every deck starts on `managed`.
- No token write touches the collection.
- Z-indexes only from `LAYER`; tooltips only via `useTooltip()`; `aria-disabled`, never `disabled`; accessible names spelled whole (`Missing2`); TS 6.0.x; no `@types/node`.
- **Tests run once, at fan-in.** A subagent runs only its own new tests (`npx vitest run <file>`, `cargo test <filter>`); never `npm run verify`. Only the two Rust tasks run cargo, and **never at the same time** — Task RA runs cargo only after Task RB reports, or each runs `cargo check` / focused tests when the other is idle (the controller sequences them if both need it).
- **Subagents do not commit.** One git index is shared.

## Review Focus

1. **A reader zeroes the only printing of a token** — expected: the entry stays at 0 (the implicit default does not reappear). Pinned in Task RB.
2. **Undo of a cut restores the reader's printings** — cut the card that makes Treasure (with Treasure at two printings), Ctrl+Z: card and both entries back. Pinned in Task RB (`card_write_cases`-style case).
3. **A paired device on v51 receives a v52 device's token history** — expected: the *history row* does not stall it, because the row is kind `deck`. Pinned by the absence of any `CHECK` change (Task RA test: `AUDIT_KINDS` unchanged) and a Task RB test that a token audit row is `kind = 'deck'`. *(Amended at the task reviews, 2026-09-26: "nothing stalls" was false. Every entry write also emits a `deck_token_printings` op, a table a v51 peer does not sync, so its applier defers that op and holds the stream until the peer upgrades — the cost every new synced table has paid, `deck_notes` at v43 included. The kind choice keeps the history from adding a second, permanent reason; it does not buy a stall-free mixed-version group.)*
4. **A token dropped from the search column onto the Main deck pile** — expected: a token entry, no `deck_cards` row, the deck's card count unchanged. Pinned in Task RA (`add_card` reroute) and Task TC (the editor shows it in the pile).
5. **Swapping onto a printing+finish the list already holds** — expected: the two fold (quantities summed), one tile. Pinned in Task RB.

---

## File map

| File | Task |
| --- | --- |
| `src-tauri/src/schema.rs`, `sync_engine/capture.rs`, `sync_engine/apply.rs`, `sync_engine/apply/tests.rs`, `mirror/watch.rs`, `changes.rs` (if it asserts the table list), `src/lib/userTables.json`, `src/lib/crossWindow.ts`, `docs/reference/sync.md` (registration list) | **RA** |
| `src-tauri/src/deck.rs` (token_mode column; `add_card` reroute; theory-switch reconcile) | **RA** |
| `src-tauri/src/deck_tokens.rs`, `deck_undo.rs`, `deck_meta.rs`, `deck_audit.rs` (tests), `sync.rs`, `collection_alloc.rs`, `desktop.rs`, `web/route.rs` | **RB** |
| `src/lib/ipc.ts`, `ipc.test.ts`, `src/features/decks/deckTokens.ts` (+test), `useDeckTokens.ts`, `auditText.ts` (+test), `DeckHistoryDialog.tsx` (if its band needs the token field), `.storybook/fake/db.ts`, `seeds.ts`, `db.test.ts`, and the `tokenStack → tokenMode` fixture rename in every test/story file **not** owned by TB/TC | **TA** |
| `src/features/decks/DeckTokensPanel.tsx` (+stories), `TokenArtPicker.tsx`, new `TokenModeControl.tsx` (+test), `DeckSettingsForm.tsx` (+test, stories), `DeckSettingsDialog.tsx` (+test), `CreateDeckDialog.tsx` (+test) | **TB** |
| `src/features/decks/DeckEditor.tsx` (+test, stories), `views/TokenPile.tsx` (+test, stories), `tokenTheory.ts` (+test), `views/views.test.tsx`, `useDeck.ts` (+test) | **TC** |

All five run **in parallel** against the interfaces below. Task F (controller) is fan-in.

## Interfaces (every task builds against these, verbatim)

**Rust (RB defines, RA consumes):**
```rust
// deck_undo.rs
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEntryRow { pub variant: String, pub oracle_id: String, pub card_id: String, pub finish: String, pub quantity: i64 }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStateRow { pub oracle_id: String, pub card_id: Option<String>, pub quantity: Option<i64>, pub state: Option<String> }
// Op gains:  Tokens { #[serde(default)] restore: Vec<TokenEntryRow>, #[serde(default)] delete: Vec<TokenEntryRow>, #[serde(default)] states: Vec<TokenStateRow> }

// deck_tokens.rs
pub fn is_token_layout(layout: &str) -> bool;                       // token | double_faced_token | emblem
/// Deletes the entries of every token a list no longer derives and is not `manual`; returns them.
pub fn reconcile_in(tx: &Connection, deck_id: i64, variants: &[&str]) -> Result<Vec<crate::deck_undo::TokenEntryRow>, String>;
/// The whole add-a-printing write (rule 5), inside the caller's transaction: materialise, upsert,
/// mark `manual` if not derived, touch the deck, audit row, undo step. Returns the entry's quantity.
pub fn add_printing_in(tx: &Connection, deck_id: i64, variant: &str, card_id: &str, finish: Option<&str>, quantity: i64) -> Result<i64, String>;
pub fn repair_entry_finishes(conn: &Connection) -> Result<(), String>;   // launch-time, idempotent
```

**Schema (RA defines, RB consumes):** table `deck_token_printings (id INTEGER PRIMARY KEY, deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE, variant TEXT NOT NULL CHECK (variant IN ('live','theory')), oracle_id TEXT NOT NULL, card_id TEXT NOT NULL, finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')), quantity INTEGER NOT NULL CHECK (quantity >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sync_uid TEXT)`, unique index `idx_deck_token_printings_grain ON (deck_id, variant, card_id, finish)`, `idx_deck_token_printings_uid ON (sync_uid)`; `pub const DECK_TOKEN_PRINTING_GRAIN: &str = "deck_id, variant, card_id, finish";`; `decks.token_mode` as in Global Constraints; `DeckRow.token_mode: String`, `DeckPatch.token_mode: Option<String>`.

**Commands (RB defines; wire names camelCase):**
| Command | Args | Returns |
| --- | --- | --- |
| `deck_tokens` | `deckId, variant, marketplace?` | `DeckTokenRow[]` — **one per entry** |
| `deck_token_set_quantity` | `deckId, variant, oracleId, entry: {cardId, finish} \| null, quantity` | `()` |
| `deck_token_swap` | `deckId, variant, oracleId, from: {cardId, finish} \| null, to: {cardId, finish}` | `()` |
| `deck_token_add_printing` | `deckId, variant, cardId, finish` | `()` |
| `deck_token_state` | `deckId, oracleId, state: "auto"\|"hidden"\|"manual"` | `()` |
| `deck_token_reset` | `deckId, variant, oracleId` | `()` |

`deck_token_set` / `deck_token_clear` / `deck_token_add` are removed (Rust, route, handler list, ipc, fake).

**Wire row (RB emits, TA mirrors):** `DeckTokenRow = { oracleId, name, typeLine, layout, power, toughness, colors, oracleText, defaultCardId, sources, derived, state: "auto"|"hidden"|"manual", cardId: string /* this entry's printing */, finish: "nonfoil"|"foil"|"etched", quantity: number /* effective */, implicit: boolean, imageUris, setCode, collectorNumber, setName, rarity, finishes, unitPrice /* at this entry's finish */ }`. An implicit entry's `cardId` is the resolver's default printing and its `finish` that printing's default finish; its `quantity` is `deck_tokens.quantity ?? 1`.

**TS (TA defines, TB/TC consume):**
```ts
// deckTokens.ts
export interface DeckTokenView { /* PR 1 fields */ …; finish: Finish; implicit: boolean; entryKey: string /* tileKeyOf(printingId, finish) */ }
export interface TokenEntryRef { oracleId: string; cardId: string; finish: Finish; implicit: boolean }
export function isTokenLayout(layout: string | null | undefined): boolean;
export function entryRef(view: DeckTokenView): TokenEntryRef;
// useDeckTokens(deckId, variant) returns:
{ query, tokens: DeckTokenView[], failure, showDismissed, setShowDismissed,
  setQuantity: (entry: TokenEntryRef, quantity: number) => void,
  swap: (entry: TokenEntryRef, to: { cardId: string; finish: Finish }) => void,
  addPrinting: (cardId: string, finish: Finish) => void,
  dismiss: (oracleId: string) => void, restore: (oracleId: string) => void, reset: (oracleId: string) => void }
// ipc.ts: DeckRow.tokenMode: "managed" | "collection" | "hidden"; DeckPatch.tokenMode?: same; tokenStack removed.
```
> **Amended at fan-in (2026-09-26):** the routing predicate is not `is_token_layout` /
> `isTokenLayout`. A layout-only test let six two-sided tokens (five `flip` Role tokens and the
> `reversible_card` Mechtitan, debug corpus) become deck cards through `add_card`, so RB's fix
> round added `deck_tokens::is_token_printing(layout, type_line)` and `printing_is_token(conn,
> card_id)` — the three layouts, or a `flip` / `reversible_card` printing whose type line or a
> ` // ` face begins `Token` / `Emblem` — which both reroutes and `NOT_A_TOKEN` ask, and TA added
> its twin `isTokenPrinting(layout, typeLine)` to `deckTokens.ts`. `is_token_layout` /
> `isTokenLayout` survive as the first half only.
**TS (TB defines, TC consumes):** `TokenModeControl({ value, onChange, idPrefix }: { value: TokenMode; onChange: (m: TokenMode) => void; idPrefix: string })` drawing **Managed** and **Hide** only; `TokenArtPicker` props become `{ mode: { kind: "swap"; entry: DeckTokenView } | { kind: "add"; tokens: readonly DeckTokenView[] } | null; zoom; onPick: (to: { cardId: string; finish: Finish }) => void; onDismiss; onClose }`; `DeckTokensPanel` props gain `onAddPrinting: () => void`, `mode: TokenMode`, `onMode: (m: TokenMode) => void`, and `onPick: (view: DeckTokenView) => void`.
**TS (TC):** `TokenPile` interface: `setQuantity: (entry: TokenEntryRef, quantity: number) => void; pickArt: (view: DeckTokenView) => void` (the rest as PR 1); React keys are `view.entryKey`.

---

### Task RA: Rust — schema v52, sync registration, `decks.token_mode`, the `add_card` reroute, the theory-switch reconcile

**Files:** `src-tauri/src/schema.rs`, `sync_engine/capture.rs`, `sync_engine/apply.rs`, `sync_engine/apply/tests.rs`, `mirror/watch.rs`, `deck.rs`, `changes.rs` (only if it needs the table), `src/lib/userTables.json`, `src/lib/crossWindow.ts`, `docs/reference/sync.md`.

- [ ] **Step 1: Failing tests.**
  - `schema.rs`: `v52_creates_deck_token_printings_moves_overrides_and_swaps_the_stack_for_a_mode` on a v51 file (`user_file_at_51` helper — add it, rewinding `{UNDO_V52}` only) seeded with: deck A `token_stack = 1` with a `deck_tokens` row (`oracle 'o1', card_id 'p1', quantity 3, state 'auto'`), deck B `token_stack = 0` with a quantity-only row (`oracle 'o2', card_id NULL, quantity 2`). After `migrate`: `deck_token_printings` has **two** rows for A/o1 (`live` and `theory`, `card_id 'p1'`, `finish 'nonfoil'`, `quantity 3`) and none for o2; A's `deck_tokens` row has `card_id NULL, quantity NULL, state 'auto'`; B's row is untouched (`quantity 2`); both decks read `token_mode = 'managed'`; `has_column(decks, token_stack) == 0`; a second `migrate` is a no-op. Plus `the_v51_fixture_carries_none_of_v52`.
  - `UNDO_V52` exists and heads every rewind chain.
  - Registration fences go red on their own when you add the table to `TABLES`/`SYNCED_TABLES` without the rest (the existing tests: synced-list length, capture `[Spec; 17]`, apply `[Meta; 17]`, apply/tests unique-index list, `watch.rs` census, `userTables.json` via `changes.rs:281`, `crossWindow.ts` `TABLE_KEYS`) — make them pass by completing each site.
  - `capture.rs`: `a_deck_token_printing_is_captured` (insert → one op with `variant`, `oracle_id`, `card_id`, `finish`, `quantity`) and `a_decks_token_mode_is_captured`.
  - `deck.rs`: `token_mode_round_trips_audits_and_undoes` (copy PR 1's `token_rail_index` test: patch `hidden`, audit field `tokenMode`, undo → `managed`; `duplicate_deck` carries it; a bad word is refused in words). `a_token_card_added_to_a_pile_becomes_a_token_entry` — `add_card(deck, <token printing>, Some(main), …)` returns `EntryChange { id: 0, .. }`, leaves `deck_cards` empty for it and `deck_token_printings` holding the entry at 1 (uses RB's `add_printing_in`; red until RB lands). `the_theory_switch_reconciles_tokens_and_undo_restores_them`.
- [ ] **Step 2: Schema rung (after v51).** One transaction: `CREATE TABLE deck_token_printings …` + both indexes (frozen literals); `ALTER TABLE decks ADD COLUMN token_mode TEXT NOT NULL DEFAULT 'managed' CHECK (token_mode IN ('managed','collection','hidden'))`; migrate overrides (`INSERT INTO deck_token_printings (deck_id, variant, oracle_id, card_id, finish, quantity, created_at, updated_at) SELECT deck_id, v.variant, oracle_id, card_id, 'nonfoil', coalesce(quantity, 1), created_at, unixepoch() FROM deck_tokens, (SELECT 'live' AS variant UNION ALL SELECT 'theory') v WHERE card_id IS NOT NULL`, then `UPDATE deck_tokens SET card_id = NULL, quantity = NULL WHERE card_id IS NOT NULL`); drop `token_stack` **with v43's move** — drop the `sync_*_decks` capture triggers before `ALTER TABLE decks DROP COLUMN token_stack` (`capture::install` reinstalls them after migration; read v43 at schema.rs:6360-6367 and copy its reasoning); literal `PRAGMA main.user_version = 52`. `USER_SCHEMA_VERSION = 52`; `USER_SCHEMA_SQL` byte-identical to the ladder (the `decks` line loses `token_stack`, gains `token_mode`; the new table and indexes). `UNDO_V52` rewinds all of it (recreate `token_stack INTEGER NOT NULL DEFAULT 0`, drop the table and `token_mode`). Doc comment: why each piece, including why the rung writes `nonfoil` (spec §4.3 — no rung reads the corpus) and why `collection` is in the CHECK already (PR 3).
- [ ] **Step 3: Registration.** `TABLES` (Side::User), `SYNCED_TABLES` (sorted), user-table prose counts, grain constant `DECK_TOKEN_PRINTING_GRAIN` + the plain-grain test; capture `Spec { table: "deck_token_printings", keys: &["id"], fields: &["variant","oracle_id","card_id","finish","quantity"], counters: &[], parents: &[Parent { key: "deck", col: "deck_id", table: "decks", absent: Absent::Null, soft: false }], append_only: false }`; apply `Meta { table: "deck_token_printings", order: 16, grains: &[Grain { predicate: "deck_id = ? AND variant = ? AND card_id = ? AND finish = ?", sources: &[Source::Parent("deck"), Source::Field("variant"), Source::Field("card_id"), Source::Field("finish")] }], counters: &[], timestamps: true, needs_review: false, tree: None }` (+ the "ten of the sixteen" doc count); `decks` capture fields swap `token_stack` → `token_mode`; `watch.rs` maps the table to `DECKS_ONLY` beside `deck_tokens`; `userTables.json`, `crossWindow.ts` `TABLE_KEYS`; `docs/reference/sync.md`'s registration list. Launch: beside `managed_wishlist::settle_all` (schema.rs ~5023) call `crate::deck_tokens::repair_entry_finishes(conn)` with the same error handling that call has.
- [ ] **Step 4: `deck.rs`.** `token_stack` → `token_mode` everywhere it is threaded (DeckPatch/DeckRow/DECK_SELECT/`deck_row` index/DeckBefore/`update_deck` binding — validate the word, refusing an unknown one with a sentence constant; `record_deck_edit` field `tokenMode` with from/to words; `duplicate_deck`). **`add_card` reroute** right after the card lookup: if the printing's `layout` is a token layout, `let q = crate::deck_tokens::add_printing_in(&tx, deck_id, variant, card_id, finish, quantity)?; tx.commit(); return Ok(EntryChange { id: 0, quantity: q, removed: false })` — doc the `id: 0` contract. **Theory switch**: where `update_deck` moves live into theory, after the move call `crate::deck_tokens::reconcile_in(&tx, id, &[LIVE, THEORY])?` and push `Op::Tokens { restore: removed.clone(), delete: vec![], states: vec![] }` onto `undo` and `Op::Tokens { restore: vec![], delete: removed, states: vec![] }` onto `redo`.
- [ ] **Step 5:** `cargo fmt` and `cargo check --tests` only — **never `cargo test` while Task RB may be running it** (two concurrent test runs share on-disk fixtures and fake ~18 schema failures — memory `never-run-two-verifies-at-once`). Your tests also need RB's `add_printing_in`/`reconcile_in`; the controller runs them at fan-in and routes failures back to you. Report. Do not commit.

### Task RB: Rust — entries, the resolver, the commands, undo/history, reconcile

**Files:** `src-tauri/src/deck_tokens.rs`, `deck_undo.rs`, `deck_meta.rs`, `deck_audit.rs` (tests only), `sync.rs`, `collection_alloc.rs`, `desktop.rs`, `web/route.rs`.

- [ ] **Step 1: Failing tests** (in `deck_tokens.rs` unless noted):
  - Resolver: a derived token with no entries yields **one** implicit row (`implicit: true`, `cardId` = default, `finish` = its default finish, `quantity` = legacy or 1); with two entries yields two rows (`implicit: false`), none implicit; theory and live rows differ when the lists' entries differ; a dismissed token's rows carry `state: "hidden"`; a manual token nothing derives yields its entries; price read at the entry's finish (`sorting::price_expr(market, "'foil'")`).
  - Rule 2 materialise: `set_quantity(live, oracle, None, 3)` on an implicit token inserts one live entry at the default printing (3) and nothing in theory.
  - Rule 3: two entries, step one to 0 → deleted; the last one to 0 → kept at 0.
  - Rule 4: swap onto an entry the list holds folds (quantities summed, one row).
  - Rule 5: `add_printing` new → 1; again → 2; a token nothing derives becomes `manual`.
  - `reset` deletes that list's entries only; `state` hidden/auto/manual as today (restore chooses auto/manual by derivation).
  - History + undo per write: each command writes **one** `deck_audit` row, `kind = 'deck'`, payload `field = "token"` with its `action` (`quantity`, `swap`, `add`, `state`, `reset`), and one `deck_undo` step; `apply_reversal` undo → table state before; redo → after. Add a `token_write_cases()` + `#[test]` in `deck_undo.rs` driven by `drive_cases`, with `snapshot` extended to read `deck_token_printings` and `deck_tokens`, and a `seeded()` variant holding a token maker (Smothering Tithe-shaped raw with `all_parts`).
  - Reconcile: `reconcile_in` deletes a non-manual token's entries when its maker is gone from that list, keeps manual ones, returns the removed rows; **cut the maker through `set_card_quantity(.., 0)` with two Treasure entries → entries gone; `apply_reversal` undo → card and both entries back** (the Review Focus 2 case, via the `record_cells` hook); `set_category_active(off)` and `delete_category` hooks likewise; the backstop: `deck_to_collection` cut (no step) → entries gone after `with_write` returns.
  - `add_printing_in` from `collection_to_deck` with a token row: no copy moves, one entry added (`collection_alloc.rs` test).
  - `repair_entry_finishes`: an entry `nonfoil` on a foil-only printing becomes `foil`; a correct entry is untouched; idempotent.
  - `deck_audit.rs`: `every_deck_write_leaves_exactly_one_audit_row` gains the five token commands; `AUDIT_KINDS` stays nine (assert it).
- [ ] **Step 2: Resolver.** Keep the derivation; replace the one-row-per-oracle pushes (dt:482, dt:502) with one row per stored entry of `(deck_id, variant)` for that oracle, or one implicit row when there are none. `stored_overrides` stays for `state` and the legacy implicit quantity; add `stored_entries(conn, deck_id, variant) -> HashMap<String, Vec<(card_id, finish, quantity)>>`. Chin/picture/price for each entry's printing through the existing `drawn_for`/`picked_printing` path, priced at the entry's finish. `DeckTokenRow`: `card_id: String`, `finish: String`, `quantity: i64`, `implicit: bool`, `state: String` (effective; `auto` when absent) — update every doc comment the change makes false.
- [ ] **Step 3: Writes.** One private `fn write_tokens<F>(conn, deck_id, variant, audit_payload, f: F)` (or similar) that opens the transaction, `touch_deck`s, snapshots the affected rows before/after, runs `f`, records the audit row (`deck_audit::record(tx, deck_id, DECK_LEVEL, DECK, None, &payload, 0)`) and the `Op::Tokens` step, commits — so the five commands cannot differ in how they journal. Materialisation (rule 2) resolves the default printing with the resolver's own code for that single oracle. Audit payloads carry `field: "token"`, `action`, `name` (the token's name), `subtitle`, `card_id`, `finish`, `list` (`live`|`theory`), `from`, `to`.
- [ ] **Step 4: `deck_undo.rs`.** `TokenEntryRow`, `TokenStateRow`, `Op::Tokens` (interfaces above); `apply` arm: deletes by grain first, then `restore` as `INSERT … ON CONFLICT (DECK_TOKEN_PRINTING_GRAIN) DO UPDATE SET quantity = excluded.quantity`, then `states` (upsert or delete); `holds` arm checks the leaving side's rows exist as recorded. `DECK_FIELDS` gains `token_mode` (comment: a mode is an arrangement the reader chose, like the rail index). **Reconcile hooks** in `record_cells` and `record_variant`: after the "after" read, `let removed = crate::deck_tokens::reconcile_in(tx, deck_id, &variants_of(cells))?;` and when non-empty push `Op::Tokens { restore: removed }` to undo and `Op::Tokens { delete: removed }` to redo (after the card ops). `deck_meta.rs`: the same in `set_category_active` and `delete_category` (both variants).
- [ ] **Step 5: Backstop.** In `sync::with_write`, after `managed_wishlist::settle_logged`, call `crate::deck_tokens::reconcile_dirty_logged(&conn)`, which reads the same TEMP dirty-deck table the wishlist's `arm` fills and reconciles both variants of each dirty deck, logging (never failing) on error. Read `managed_wishlist.rs` first and do not disturb its settle.
- [ ] **Step 6: `collection_to_deck` reroute** in `collection_alloc.rs`: a token-layout source row → `deck_tokens::add_printing_in(&tx, deck_id, LIVE, &row.card_id, Some(&row.finish), quantity)`, no copy moved, the command's outcome says nothing moved (read `MoveOutcome` and pick the honest answer; doc it).
- [ ] **Step 7: Registration.** `desktop.rs` handler list and `web/route.rs` `COMMANDS` + arms: add the five commands, remove the three retired ones (their route test names each).
- [ ] **Step 8:** `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib deck_tokens deck_undo deck_meta deck_audit collection_alloc web::` — **only when Task RA is not running cargo**. Report. Do not commit.

### Task TA: TypeScript data — mirror, views, hook, history text, fake, the fixture rename

**Files:** `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/features/decks/deckTokens.ts` (+test), `useDeckTokens.ts`, `auditText.ts` (+test), `DeckHistoryDialog.tsx` (only if its `auditBand` would misfile a `field: "token"` row — check), `.storybook/fake/db.ts`, `seeds.ts`, `db.test.ts`, and every test/story fixture outside TB's and TC's files that names `tokenStack`.

- [ ] **Step 1: Failing tests.** `deckTokens.test.ts`: one view per wire row; `entryKey` = `tileKeyOf(cardId, finish)`; a token's entries sort together by set, collector number, finish (nonfoil < foil < etched); `implicit` passes through; `isTokenLayout` true for the three layouts and false for `normal`/`null`. `auditText.test.ts`: `{field:"token", action:"add", name:"Treasure", finish:"foil", to:1}` → *Added 1 × Treasure (foil)*; `quantity` `from 1 to 3` → *Treasure 1 → 3*; `swap` → *Swapped Treasure's art*; `state` `hidden` → *Dismissed Treasure*, `auto`/`manual` → *Restored Treasure*; `reset` → *Reset Treasure's printings*; an unknown action falls back to a sentence that still names the token. `ipc.test.ts`: the new struct fields and the five command argument names; the three retired commands gone. `db.test.ts`: the fake mirrors Rust — per-entry rows, the five commands with rules 2–5, an audit row `kind: "deck"` + `field: "token"` per write, **undo/redo** through the fake's `journalled` machinery (take the three old commands off `NO_UNDO_STEP` and add the new five as journalled; extend `FakeDeckState`/`deckState`/`restoreDeck` with the token tables), `tokenMode` default `managed`, `tokenStack` gone.
- [ ] **Step 2: Implement** to the Interfaces block. `useDeckTokens` keeps its signature and query key; its writes invalidate `["decks", "tokens", deckId]` **and** `["decks", "detail", deckId]`-rooted undo state the way other deck writes do (read `useDeck`'s `invalidate` and match it so the Undo button's label refreshes). Rename `tokenStack` → `tokenMode: "managed"` in every fixture you own.
- [ ] **Step 3: Run** your files' tests. Report. Do not commit.

### Task TB: The band, the picker, the mode control, Deck settings

**Files:** `DeckTokensPanel.tsx` (+stories), `TokenArtPicker.tsx`, new `TokenModeControl.tsx` (+test), `DeckSettingsForm.tsx` (+test, stories), `DeckSettingsDialog.tsx` (+test), `CreateDeckDialog.tsx` (+test).

- [ ] **Step 1: Failing tests.** `TokenModeControl.test.tsx`: a `role="group"` named *Tokens*, two `aria-pressed` buttons *Managed* and *Hide* (no *Collection* in PR 2), pressing one calls `onChange` with its word, the pressed one reflects `value`. `DeckSettingsForm.test.tsx`: the switch is gone; the control is there and writes `{ tokenMode }`. Picker (`TokenArtPicker` test or story play): a printing sold in nonfoil and foil draws **two** tiles, the foil one with the sheen and its finish named; in `swap` mode the current entry's tile is marked current by `(cardId, finish)`; in `add` mode the grid lists the printings of every token passed, with a search box filtering by name and set code; a press calls `onPick({ cardId, finish })`. Band: one tile per entry (keys `entryKey`), a tile's stepper names its printing and finish in its accessible name (two Treasure entries must not share a name — the `tileName` rule), an **Add printing** button calls `onAddPrinting`, the mode control sits in the header and the header is drawn even with no tokens (so a reader can switch modes on any deck).
- [ ] **Step 2: Implement.** `TokenModeControl` is `DeckKindGroup`'s shape (read `DeckSettingsForm.tsx:641-730` and copy its classes and doc stance — never a radiogroup). The picker's grain: expand each `Printing` into one tile per finish in `parseFinishes(printing.finishes)` (nonfoil first), keyed `tileKeyOf(id, finish)`, drawing `CardArt`'s `finish` prop and the price at that finish (`finishPrices`); `add` mode fetches `ipc.cardPrintings` for each token oracle (one query per oracle, `useQueries`) and merges. Write the accessible names whole.
- [ ] **Step 3: Run** your tests and the DeckTokensPanel / DeckSettingsForm story plays (`npx vitest run src/stories.test.tsx -t "<file>"`). Report. Do not commit.

### Task TC: The editor, the pile, theory marks, the add path

**Files:** `DeckEditor.tsx` (+test, stories), `views/TokenPile.tsx` (+test, stories), `tokenTheory.ts` (+test), `views/views.test.tsx`, `useDeck.ts` (+test).

- [ ] **Step 1: Failing tests.** `tokenTheory.test.ts`: slots keyed `theorySlot({ cardId, finish })` with the real finish; a plan asking for foil is not satisfied by the nonfoil entry (name tier on `oracleId`, delta counted across entries); quantity-4 cases keep their zero-delta meaning. `TokenPile.test.tsx`: two entries of one token draw two cards with distinct keys and names; the chin names the entry's finish; `setQuantity`/`pickArt` receive the entry. `DeckEditor.test.tsx`: `tokenMode: "hidden"` draws no pile and no plan-token read; `managed` draws it; a press on a pile card opens the picker in `swap` mode for **that entry** and a pick calls `swap`; the band's **Add printing** opens the picker in `add` mode and a pick calls `addPrinting`; the band's mode control writes `{ tokenMode }` through `update`; an `addCard` answering `id: 0` marks nothing as landed. `useDeck.test.ts`: `addCard` success with `id: 0` invalidates the token query too (it already invalidates `["decks"]` — assert the token key refetches).
- [ ] **Step 2: Implement.** `tokenStack` → `tokenMode !== "hidden"` everywhere it gates (pile, plan-token read). Picker state is `{ kind: "swap"; entryKey } | { kind: "add" } | null`, looked up in `deckTokens.tokens` by `entryKey` (never a frozen view — the `Layer` rule the existing comment states). `TokenPile` keys on `entryKey`, passes the entry to `setQuantity`/`pickArt`, feeds `tokenFaceFacts` the entry's finish (`finish` as `DeckFinish`: `nonfoil` → `null`), and `CardChin` `finish` from the entry. `tokenTheory.ts` uses real finishes. The onAdded landed mark skips `id === 0`.
- [ ] **Step 3: Run** your tests and the TokenPile/DeckEditor story plays. Report. Do not commit.

### Task F (controller): fan-in, docs, verify, live pass, ship

- [ ] `npx tsc --noEmit -p .` and `-p .storybook`; fix seams. `cargo fmt/clippy/test` once. Full verify step by step (build, lint, 4 vitest shards, cargo tests). Docs: `src/features/decks/CLAUDE.md` Tokens & Emblems (entries, modes, picker grain, routing, undo, reconcile), `docs/reference/decks-storage.md` (the table, the commands, the reconcile's two layers), `docs/reference/data-and-sync.md` (v52 row). Live pass on a copy of the real db: v52 migrated (overrides now entries in both lists; `token_mode = managed`); two Treasure printings side by side; a swap touching one; a token dragged from the search column onto a pile lands in the pile, not the deck; cut the maker → Treasure gone, Ctrl+Z → back with both printings; mode Hide removes the pile; Undo labels read. Task reviews (7 → 5 packages), final whole-branch review, fix wave, auto-pr.
