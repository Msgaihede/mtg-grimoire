# Managed Tokens, Improved — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tokens default to 0 and appear in the deck's stacks only once counted; dismiss, reset and
the mode control go; a hand-added token is marked; Add printing can browse every token; Compare and
the managed wishlist carry tokens; the theory mark says "Match" when printings are not told apart.

**Architecture:** Two lanes, each in its own git worktree. **Lane R** (Rust): Task 1 (the token
model, two new commands, the launch pass, the v55 rung) then Task 2 (Compare's token rows, the
managed wishlist's Tokens subfolder). **Lane T** (TypeScript): Task 3 (the IPC contract, the fake,
the band, the pile, the picker) then Task 4 (Compare's view, Deck settings, the theory wording).
Task 5 (docs) runs at fan-in on the integration branch.

**Tech Stack:** Rust (rusqlite; `deck_tokens.rs`, `deck_theory.rs`, `managed_wishlist.rs`,
`schema.rs`), React 19 + TypeScript 6 (Vitest, Testing Library), the Storybook fake.

**Spec:** `docs/superpowers/specs/2026-09-27-token-improvements-design.md` (absolute:
`D:\Code\mtg-grimoire\.claude\worktrees\token-stacks\docs\superpowers\specs\2026-09-27-token-improvements-design.md`).

## Global Constraints

- **Base:** every lane branch starts from `worktree-sync-folder-deletes` at the commit the dispatch
  names (it carries user schema v54, `sync_gone`, above `main`'s v53, the per-list piles),
  fast-forwarded from `main`. This plan's rung is **v55** — written as v54 in the lanes, whose base
  still had `sync_gone` at v53, and renumbered at fan-in when `main`'s v53 had landed under it.
- **Quantity default is 0**, in Rust (`implicit_quantity`), in `DEFAULT_TOKEN_QUANTITY` and in the
  fake. A legacy stored quantity is still honoured.
- **The pile filter is `quantity > 0`, applied to the pile's list only** (`DeckEditor`'s
  `tokenPile.tokens`). The band, Add printing and the plan's live side see every row.
- **`deck_tokens.state` keeps `'hidden'` in its CHECK and `decks.token_mode` stays in the schema, on
  the `decks` capture spec and on `deck_undo::DECK_FIELDS`.** Nothing new reads either.
- **A hand-added token is `derived === false`** — never `state === "manual"` (a derived token can be
  manual).
- **Exact words:** the badge `NOT MADE BY DECK`; its tooltip `Nothing in this deck makes {name}. It
  was added by hand.`; the toggle `All tokens`; the button `Remove printing`; the history line
  `Removed {name}'s {SET} #{number} printing` (with ` (foil)` / ` (etched)` for a non-regular
  finish); the Compare view `Tokens`; the managed-wishlist mode label `Tokens`; the subfolder name
  `Tokens`; the switch `Any printing` (was `Different printing`); the mark word `Match` (only with the
  exact switch off).
- **New commands:** `deck_token_remove(deckId, variant, oracleId, entry: {cardId, finish})` and
  `token_printings(marketplace)`. **Removed from the IPC surface:** `deck_token_state`,
  `deck_token_reset`.
- **v55:** `wishlist_folders.managed_tokens INTEGER NOT NULL DEFAULT 0`;
  `idx_wishlist_folders_managed` unique on `(managed_deck_id, managed_tokens)`; not synced.
- **Every managed-folder lookup by `managed_deck_id` that means the deck's own folder adds
  `AND managed_tokens = 0`.**
- **Implementers commit on their own lane branch** (each lane is its own worktree — no shared index).
  Conventional prefixes, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Cargo only through** `pwsh -NoProfile -File D:\Code\mtg-grimoire\.claude\worktrees\token-stacks\.superpowers\sdd\cargo-global.ps1 <cargo args>`
  (a global lock across every worktree of this session; it runs in the caller's worktree's
  `src-tauri`). `rustfmt --edition 2021` on your own files. No `npm run verify` — GitHub CI is the
  gate; run the targeted tests each task names, plus `npx tsc --noEmit -p .` and `npx eslint <your
  files>` for TypeScript.
- **Never touch `src-tauri/src/sync_engine/`** — another plan owns it.
- Comments follow the surrounding code's density and voice: say why, in full sentences.

## Review Focus

1. **An old dismissed token arriving by sync after the launch pass ran** — it must draw as an
   ordinary token (treated as not hidden) until the next launch retires it; nothing may hide it.
   Pinned in Task 3 (the view layer ignores `hidden`) and Task 1 (the pass is idempotent).
2. **A hand-added token stepped to 0** stays in the band at 0 with its mark and its Remove button,
   and is not in the pile. Pinned in Task 3.
3. **Removing a hand-added token's last entry in one list while the other list still holds one** —
   it leaves this list's band only. Pinned in Task 1.
4. **Compare on a deck whose plan counts no tokens** — the Tokens view says so in words, and All is
   exactly the card rows. Pinned in Task 4.
5. **The managed wishlist switched from All to Missing** — the Tokens subfolder and its wishes go,
   the card wishes stay. Pinned in Task 2.

---

## Execution map

| Lane | Task | Owns | Runs |
| --- | --- | --- | --- |
| R | 1 — the token model | `deck_tokens.rs`, `schema.rs`, `desktop.rs`, `web/route.rs`, `card.rs` (only if a row mapper must become `pub(crate)`) | first |
| R | 2 — Compare and the wishlist | `deck_theory.rs`, `managed_wishlist.rs`, `deck.rs`, `wishlist_folders.rs` (only if a lookup lives there) | after 1 |
| T | 3 — IPC, fake, band, pile, picker | `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts`, `.storybook/fake/seeds.ts`, `src/features/decks/{deckTokens,useDeckTokens,DeckTokensPanel,TokenArtPicker,DeckEditor,auditText}.*`, `src/features/decks/views/TokenPile.*`, their stories | with 1 |
| T | 4 — Compare, settings, wording | `src/features/decks/{TheoryDiffDialog,DeckSettingsForm,DeckSettingsDialog,CreateDeckDialog,theoryMatch,managedWishlist,CardMarks,TokenModeControl}.*`, the Settings → Appearance matching row, their tests and stories | after 3 |
| — | 5 — docs | the docs §6 of the spec names | at fan-in |

---

### Task 1: The token model — quantity 0, Remove printing, the launch pass, every token, v55

**Files:** `src-tauri/src/deck_tokens.rs`, `src-tauri/src/schema.rs`, `src-tauri/src/desktop.rs`,
`src-tauri/src/web/route.rs` (and `src-tauri/src/card.rs` only to expose an existing row mapper).

**Interfaces — produces (Lane T codes against these names and shapes):**

```rust
/// deck_token_remove's command: one entry, deleted unconditionally.
#[tauri::command]
pub async fn deck_token_remove(state, deck_id: i64, variant: String, oracle_id: String,
                               entry: TokenEntryKey) -> Result<(), String>;

/// token_printings' command.
#[tauri::command]
pub async fn token_printings(state, marketplace: Option<String>) -> Result<Vec<TokenPrinting>, String>;

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct TokenPrinting {
    pub oracle_id: String,
    pub name: String,
    /// The subtitle facts `deckTokens.ts`' `tokenSubtitle` reads — the same fields `DeckTokenRow` carries.
    pub colors: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub oracle_text: Option<String>,
    pub layout: String,
    /// The printing, in `card.rs`'s `Printing` shape (finishPrices included), flattened.
    #[serde(flatten)]
    pub printing: crate::card::Printing,
}

pub fn retire_hidden(conn: &Connection) -> Result<(), String>;   // the launch pass
pub fn remove_entry(conn, deck_id, variant, oracle_id, entry: &TokenEntryKey) -> Result<(), String>;
```

(If `card::Printing` is not `Serialize` with `camelCase` already, match what `card_printings`
returns so the picker's tile code renders both without a branch. The TypeScript side will be
`interface TokenPrinting extends Printing { oracleId; name; colors; power; toughness; oracleText; layout }`.)

- [ ] **Step 0: Set up the lane.** In your worktree (PowerShell): `git merge --ff-only <BASE>` (the
  dispatch names BASE). Confirm `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs` reads 53.

- [ ] **Step 1: Failing tests** (in `deck_tokens.rs`' `mod tests`, reusing its fixtures):
  - `an_untouched_token_reads_zero_and_its_first_step_writes_one` — a deck whose card makes
    Treasure; `deck_token_rows` answers the implicit row at `quantity 0`; `set_quantity(.., None, 1)`
    materialises one entry at 1. (Update the existing tests that assert 1 for an untouched token —
    `:3827`, `:4006` at the time of writing — to 0.)
  - `a_legacy_quantity_is_still_honoured` — a `deck_tokens` row with a stored `quantity 3` and no
    entries reads 3.
  - `removing_a_derived_tokens_last_entry_falls_back_to_its_default_printing_at_zero`.
  - `a_hand_added_token_is_drawn_only_in_a_list_that_holds_an_entry_of_it` — add a printing of a
    token the deck does not make to `live`; `deck_token_rows(.., "theory")` answers no row for it.
  - `removing_a_hand_added_tokens_last_entry_in_one_list_keeps_it_in_the_other` (Review Focus 3).
  - `removing_a_hand_added_tokens_last_entry_everywhere_takes_it_off_the_deck` — its `deck_tokens`
    row is gone and neither list draws it.
  - `a_remove_files_one_history_row_and_one_undo_step_that_puts_it_back` — the audit payload is
    `{field:"token", action:"remove", …}` and `deck_undo`'s undo restores the entry.
  - `retire_hidden_zeroes_a_dismissed_tokens_entries_and_keeps_them` — a `hidden` derived token with
    entries at 2 (live) and 1 (theory) ends `auto` with both entries at 0, printings unchanged; a
    `hidden` token the deck does not derive ends `manual`; **no `sync_ops` row is written**; a second
    run changes nothing (Review Focus 1).
  - `token_printings_answers_every_token_and_nothing_else` — fixtures: a `token`, an `emblem`, a
    `double_faced_token`, a `flip` Role token (type line `Token Enchantment — Role // …`), a `normal`
    card and a non-paper token; the answer is the first four, each with its `oracleId`.

- [ ] **Step 2: Run them red.** `pwsh -NoProfile -File <cargo-global> test --lib deck_tokens::`

- [ ] **Step 3: Quantity 0.** `implicit_quantity`: `legacy.unwrap_or(0)`, doc rewritten (the default
  is 0 because a token is something the reader starts to use, spec §3.1). Every doc comment in the
  file that says the implicit entry is "at … or 1" says 0.

- [ ] **Step 4: The hand-added tail per list.** In `deck_token_rows`' manual tail (the arm that
  emits a token nothing derives), emit a token only for the entries it has **in the asked list** —
  no implicit row for a list with none. A derived token is unchanged.

- [ ] **Step 5: `remove_entry` and `deck_token_remove`.** In one `journal_in` write: delete the entry
  `(deck_id, variant, card_id, finish)` (`ENTRY_GONE` if absent); then, when the token is not derived
  and holds no entry in either list, return its state to `auto` through `write_state` (which deletes
  the row). Audit payload `{field:"token", action:"remove", oracle_id, name, variant, card_id,
  set_code, collector_number, finish}` — read what the neighbouring actions store and match their
  keys. The command registers in `desktop.rs`' `generate_handler!` and routes in `web/route.rs`
  beside the other token writes.

- [ ] **Step 6: Retire the state and reset commands.** Unregister `deck_token_state` and
  `deck_token_reset` (desktop and web) and delete the two command functions; delete `set_state` /
  `reset` only if nothing else calls them (the theory switch and `retire_hidden` may) — clippy's
  `dead_code` decides. `HIDDEN_STATE` stays for the CHECK and the pass.

- [ ] **Step 7: `retire_hidden`.** Behind `crate::sync_engine::capture::suppressed` (read-only use of
  that module's public fn is fine): for every `deck_tokens` row with `state = 'hidden'`,
  `UPDATE deck_token_printings SET quantity = 0 WHERE deck_id = ? AND oracle_id = ?` (both lists),
  then its state becomes `auto` where `derive` says the deck still makes the token and `manual`
  where it does not (via `write_state`). Idempotent. Add `retire_hidden_logged(conn)` (logs and
  returns, like the neighbouring launch passes) and call it in `schema.rs`' `prepare_database`
  straight after `repair_entry_finishes`, with a comment in that block's voice.

- [ ] **Step 8: `token_printings`.** One statement over `cards`:
  `is_paper = 1 AND (layout IN ('token','double_faced_token','emblem') OR (layout IN
  ('flip','reversible_card') AND (type_line LIKE 'Token%' OR type_line LIKE 'Emblem%' OR type_line
  LIKE '% // Token%' OR type_line LIKE '% // Emblem%')))` — held to `is_token_printing` by the test
  (write the layout lists from `TOKEN_LAYOUTS` / `TWO_SIDED_LAYOUTS` with `sorting::`-style literal
  helpers, never retyped). Order by name, then oracle id, then released date descending, then set,
  then collector number. Price through the same `finishPrices` builder `card_printings` uses. Read
  connection (`lock_db_read`), `spawn_blocking`. Register and route.

- [ ] **Step 9: v55** (written as v54, and renumbered at fan-in — see Global Constraints). In
  `schema.rs`: `USER_SCHEMA_VERSION = 55`; a bottom-of-ladder `if v < 55`:

```sql
ALTER TABLE wishlist_folders ADD COLUMN managed_tokens INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS idx_wishlist_folders_managed;
CREATE UNIQUE INDEX idx_wishlist_folders_managed
    ON wishlist_folders (managed_deck_id, managed_tokens);
PRAGMA main.user_version = 55;
```

  with the ladder's comment (the managed wishlist's Tokens subfolder, spec §3.8; not synced; owes
  `UNDO_V55`). `USER_SCHEMA_SQL`: the column on `wishlist_folders` and the widened index, stored text
  byte-identical to the ladder's. `tests::UNDO_V55`:
  `DROP INDEX IF EXISTS idx_wishlist_folders_managed; ALTER TABLE wishlist_folders DROP COLUMN
  managed_tokens; CREATE UNIQUE INDEX idx_wishlist_folders_managed ON wishlist_folders
  (managed_deck_id);` prepended to **every** rewind chain that starts with `{UNDO_V54}`. Re-count
  the table-count test (tables unchanged, indexes unchanged — one replaced). Bump the head-literal
  assertions 54 → 55. A test: `the_v55_rung_widens_the_managed_index` — two folders with one
  `managed_deck_id` and `managed_tokens` 0 and 1 are accepted; two with the same pair are refused.

- [ ] **Step 10: Green.** `test --lib deck_tokens::`, `test --lib schema::`, `test --lib web::` (if the
  route table has a test), then host `clippy --all-targets -- -D warnings` and the wasm leg as CI
  runs it (`clippy --lib --target wasm32-unknown-unknown -- -D warnings`, see `.github/` for the exact
  line). Commit: `feat(tokens): quantity 0 by default, Remove printing, every token for the picker,
  and the Tokens subfolder's column (user schema v55)`.

---

### Task 2: Compare's token rows and the managed wishlist's Tokens subfolder

**Files:** `src-tauri/src/deck_theory.rs`, `src-tauri/src/managed_wishlist.rs`, `src-tauri/src/deck.rs`
(the `managed_wishlist_mode` vocabulary), `src-tauri/src/wishlist_folders.rs` (only if a
managed-folder lookup lives there).

**Interfaces:**
- Consumes (Task 1): `deck_tokens::deck_token_rows(conn, deck_id, variant, market) -> Vec<DeckTokenRow>`
  (implicit rows included, quantity 0 by default), `wishlist_folders.managed_tokens`.
- Produces: `TheoryDiffRow.is_token: bool` (`isToken` on the wire); the managed-wishlist mode word
  `tokens`; the Tokens subfolder `{ managed_deck_id: deck, managed_tokens: 1, parent_id: <the deck's
  managed folder>, name: "Tokens" }`.

- [ ] **Step 0:** `git merge --ff-only <Task 1's lane head>` (the dispatch names it).

- [ ] **Step 1: Failing tests.**
  - `deck_theory`: `the_diff_answers_token_rows_at_the_printing_and_finish_grain` — plan Treasure
    TMOM nonfoil ×3 and foil ×1, actual TMOM nonfoil ×1: two token rows, `quantity` 2 and 1,
    `isToken`, category `Tokens & Emblems`, the foil one with `finish = "foil"`;
    `a_plan_counting_no_tokens_adds_no_token_rows`; `held_as_other_printing_counts_the_actual_lists_other_printings_of_the_token`;
    `sending_a_token_row_to_the_wishlist_files_a_wish_pinned_to_its_printing_and_finish`.
  - `managed_wishlist`: `all_fills_a_tokens_subfolder_with_the_plans_missing_tokens`;
    `tokens_mode_fills_only_the_subfolder`; `missing_mode_has_no_tokens_subfolder` and
    `switching_from_all_to_missing_removes_the_subfolder_and_keeps_the_card_wishes` (Review Focus
    5); `a_token_step_re_settles_the_wishlist` (the dirty triggers); `no_token_wants_no_subfolder`.

- [ ] **Step 2: Run them red.** `test --lib deck_theory::` and `test --lib managed_wishlist::`.

- [ ] **Step 3: Token rows in `theory_diff`.** After the card rows, from `deck_token_rows` for
  `theory` and `live` (treating `hidden` as not hidden): per `(card_id, finish)`, `planned − actual`,
  positive only → a row with `is_token: true`, `category_name: "Tokens & Emblems"`, the token's name,
  the printing's `unit_price` at that finish, set and number, `finish` spelled as card rows spell it
  (NULL for the regular copy), `owned_spare` through `OWNED_SPARE_SQL` (its `coalesce(?2,'nonfoil')`
  already handles the NULL), and `held_as_other_printing` = the actual list's copies of the same
  token in other `(card_id, finish)` pairs, capped at `quantity` as the card rows cap it. Card rows
  get `is_token: false`. `missing_to_wishlist(deck, only, folder)`: a key naming a token row files a
  wish with that `card_id`, the token's `oracle_id` and name, and `preferred_finish` = the entry's
  finish (`nonfoil` spelled out).

- [ ] **Step 4: The mode word.** Add `tokens` wherever `managed_wishlist_mode`'s vocabulary is
  validated (`deck.rs`), with the same refusal sentence shape.

- [ ] **Step 5: The subfolder.** In `managed_wishlist.rs`:
  - Every lookup of the deck's own managed folder adds `AND managed_tokens = 0`
    (`grep -n managed_deck_id src-tauri/src/*.rs`).
  - `settle_deck`: card wants for `all | missing | other` into the parent as now (`tokens` → none);
    token wants (the token rows above) for `all | tokens` into the child, created on demand with
    `managed_tokens = 1`, `parent_id` = the parent, name `Tokens`; the child is deleted (its wishes
    first) when the mode stops including tokens or there is no token want.
  - The delete path removes the child's wishes, then the child, then the parent's wishes and the
    parent.
  - The TEMP dirty triggers gain `deck_token_printings` and `deck_tokens` (INSERT, UPDATE, DELETE),
    marking `deck_id` dirty like the card triggers.
  - The guard: confirm the child is covered (it carries `managed_deck_id`); widen any guard clause
    that names the parent only.

- [ ] **Step 6: Green.** The two filters, then `test --lib wishlist` and `test --lib deck::`, clippy
  host and wasm. Commit: `feat(tokens): Compare counts tokens, and the managed wishlist files them in
  a Tokens subfolder`.

---

### Task 3: The IPC contract, the fake, the band, the pile and the picker

**Files:** `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts`,
`.storybook/fake/seeds.ts`, `src/features/decks/deckTokens.ts` (+ test), `useDeckTokens.ts` (+ test),
`DeckTokensPanel.tsx` (+ test, stories), `TokenArtPicker.tsx` (+ test, stories), `DeckEditor.tsx`
(+ test), `auditText.ts` (+ test), `views/TokenPile.tsx` (+ test, stories).

**Interfaces — produces (Task 4 consumes):**

```ts
// ipc.ts
export interface TokenPrinting extends Printing {
  oracleId: string; name: string; colors: string | null; power: string | null;
  toughness: string | null; oracleText: string | null; layout: string;
}
export const ipc = {
  // …
  deckTokenRemove(deckId: number, variant: DeckVariant, oracleId: string, entry: TokenEntryKey): Promise<void>,
  tokenPrintings(marketplace: Marketplace): Promise<TokenPrinting[]>,
  // deckTokenState and deckTokenReset are removed.
};
export interface TheoryDiffRow { /* … */ isToken: boolean }
export type ManagedWishlistMode = "off" | "all" | "missing" | "other" | "tokens";
```

(`TokenEntryKey`, `Printing`, `DeckVariant`, `Marketplace` are the existing names; match them. The
`ipc.test.ts` struct fence rows for `TheoryDiffRow` and the command list follow.)

- [ ] **Step 0:** `git merge --ff-only <BASE>`; `npm install`.

- [ ] **Step 1: Failing tests.**
  - `deckTokens.test.ts`: `DEFAULT_TOKEN_QUANTITY` is 0; `pileTokens(views)` keeps only
    `quantity > 0`; `isHandAdded(view)` is `!view.derived`; a `hidden` row is treated as any other
    (Review Focus 1).
  - `DeckTokensPanel.test.tsx`: no `Show dismissed`, no dismiss/restore, no `Reset printings`, no
    mode control; a hand-added token's tile draws the badge `NOT MADE BY DECK` and the destructive
    outline, and a derived one neither; a tile for an entry draws `Remove printing` (named for its
    entry) and an implicit row does not; pressing it calls `deckTokenRemove` with the entry; a
    hand-added token at 0 is drawn (Review Focus 2).
  - `views` / `TokenPile.test.tsx`: the pile omits a token at 0 and draws one at 1; the badge and
    outline on a hand-added token in Stacks and Grid; the tag words in Table and Text.
  - `TokenArtPicker.test.tsx`: the `All tokens` toggle, off by default; on, the picker lists every
    token from `ipc.tokenPrintings`, grouped by token with its subtitle, the search narrowing by
    name and by set code; a pick calls `deckTokenAddPrinting` as now.
  - `DeckEditor.test.tsx`: the pile draws for a deck whose `tokenMode` is `hidden` (the gate is
    gone) and omits tokens at 0; the band has no mode control.
  - `auditText.test.ts`: the `remove` action reads `Removed Treasure's TMOM #12 printing` and
    `… (foil)`; the old `state`, `reset` and `tokenMode` lines still word old rows.
  - `db.test.ts` (the fake): implicit quantity 0; `deck_token_remove`'s three outcomes; no
    `deck_token_state` / `deck_token_reset`; `token_printings`; `deck_theory_diff`'s token rows
    (`isToken`, the grain); the managed wishlist's `tokens` mode and Tokens subfolder — mirroring
    Task 2's Rust tests.
  - `ipc.test.ts`: the new commands and the `isToken` field on the fence.

- [ ] **Step 2: Run them red.** `npx vitest run <each file>`.

- [ ] **Step 3: The contract and the fake.** `ipc.ts` as above (remove the two wrappers and their
  types if nothing else uses them; keep `DeckTokenState` including `"hidden"` — the wire can still
  carry it). The fake mirrors every Rust behaviour Task 1 and Task 2 specify (spec §3.1, §3.4, §3.6,
  §3.7, §3.8), with seeds for a hand-added token and a plan that counts tokens.

- [ ] **Step 4: The view layer.** `deckTokens.ts`: `DEFAULT_TOKEN_QUANTITY: number = 0`;
  `deckTokenViews` loses its `showDismissed` parameter and filters nothing; add

```ts
/** The tokens the deck's stacks draw: the ones the reader has counted (spec §3.2). */
export function pileTokens(views: readonly DeckTokenView[]): DeckTokenView[] {
  return views.filter((v) => v.quantity > 0);
}
/** A token nothing in the deck makes — `derived`, never `state` (a derived token can be manual). */
export function isHandAdded(view: Pick<DeckTokenView, "derived">): boolean {
  return !view.derived;
}
```

  `useDeckTokens`: drop `dismiss`, `restore`, `reset`, `showDismissed`; add
  `remove(entry: TokenEntryRef)` as a journalled write in the `writes` list, invalidating the
  `["decks"]` root like the others.

- [ ] **Step 5: The band.** `DeckTokensPanel.tsx`: remove the eye button, `Show dismissed`, the
  dismissed count and sentences, `Reset printings`, and the mode control and its props (leave
  `TokenModeControl.tsx` itself — Task 4 deletes it with its last import). Add `Remove printing` on
  every non-implicit tile (a trash glyph, `aria-label` built through `tokenEntryName("Remove", view)`
  or its equivalent verb helper, tooltip `Remove printing`). A hand-added token's tile: the
  destructive outline on the tile's wrapper (the `CardChin` gets `tone="destructive"`), and a badge
  reading `NOT MADE BY DECK` placed and styled like `DeckCardFace`'s `RULE BREAK` badge (reuse that
  component or its classes — do not fork a second style), `aria-hidden`, with the tooltip
  `Nothing in this deck makes {name}. It was added by hand.`; the words join the tile's accessible
  name.

- [ ] **Step 6: The pile.** `DeckEditor.tsx`: `tokenPile.tokens` = `pileTokens(keptTokens-equivalent)`
  (every row now — `keptTokens` no longer filters `hidden`); `tokenPileDrawn` stops reading the mode;
  the band loses its mode wiring; wire `remove`. `views/TokenPile.tsx`: Stacks and Grid tiles take
  the destructive outline and the badge for a hand-added token (`TokenFace` passes the badge where
  it passed `ruleBreakText={null}`); Table and Text draw `NOT MADE BY DECK` as a small destructive
  tag after the name; `Remove printing` in the Stacks card's control column and on the Grid tile.

- [ ] **Step 7: The picker.** `TokenArtPicker.tsx`, add mode: a `ToggleChip` `All tokens` in the
  header, off by default. Off: today's body. On: `useQuery(["tokenPrintings", marketplace], () =>
  ipc.tokenPrintings(marketplace))`, grouped by `oracleId` under the token's name and
  `tokenSubtitle`, every printing × finish as a tile (`printingTiles`), the search box narrowing by
  name or set code. **Keep it responsive**: render groups with `content-visibility: auto` and a
  `contain-intrinsic-size` sized to one group row, so off-screen groups cost no layout; the lane's
  report states how long first paint takes in a Storybook frame with the full fake list.

- [ ] **Step 8: History.** `auditText.ts`: the `remove` action, words as the Global Constraints give.

- [ ] **Step 9: Green.** Every test file above, `npx tsc --noEmit -p .`, `npx eslint` on your
  files, and the stories you touched through `npx vitest run src/stories.test.tsx -t <Story title>`
  (see `.storybook/CLAUDE.md` for how the story runner is filtered). Commit: `feat(tokens): counted
  tokens only in the stacks, no dismiss or reset, Remove printing, the hand-added mark, and every
  token in Add printing`.

---

### Task 4: Compare's Tokens view, Deck settings and the theory wording

**Files:** `src/features/decks/TheoryDiffDialog.tsx` (+ test, stories), `managedWishlist.ts` (+ test),
`DeckSettingsForm.tsx` (+ test, stories), `DeckSettingsDialog.tsx`, `CreateDeckDialog.tsx`,
`theoryMatch.ts` (+ test), `CardMarks.tsx` (only where it words the mark), `TokenModeControl.tsx`
and its test (deleted), the Settings → Appearance component that draws the theory-mark colour rows
(`grep -rn "Different printing" src/`).

**Interfaces — consumes (Task 3):** `TheoryDiffRow.isToken`, `ManagedWishlistMode` with `"tokens"`.

- [ ] **Step 0:** `git merge --ff-only <Task 3's lane head>`; `npm install` if the lockfile moved.

- [ ] **Step 1: Failing tests.**
  - `TheoryDiffDialog.test.tsx`: four views `All | Missing | Different printing | Tokens`; Tokens
    shows only `isToken` rows; All shows both; Missing and Different printing show no token row; a
    plan with no token rows: the Tokens view's empty sentence is `The plan counts no tokens the deck
    is short of.` and All equals the card rows (Review Focus 4); a token row's Wishlist button sends
    its key.
  - `managedWishlist.test.ts`: the `tokens` mode's label `Tokens` and its hint.
  - `DeckSettingsForm.test.tsx`: no token mode row; the theory switch row reads `Any printing`; the
    managed-wishlist group offers `Tokens`.
  - `theoryMatch.test.ts`: with the exact switch off, an exact row resolves on the name tier and its
    label is `Match`; a genuine different printing with the switch off is also `Match`; with the
    switch on a name-tier row is `Art Mismatch`; the grouping headings are unchanged.

- [ ] **Step 2: Run them red.**

- [ ] **Step 3: Compare.** `DiffView` gains `"tokens"`; `VIEWS` = `["all", "missing", "other",
  "tokens"]`, label `Tokens`, its `NOTHING_SHOWN` sentence above; `inView`: `missing` and `other`
  exclude `isToken` rows, `tokens` is `isToken` rows only, `all` everything. Totals follow the rows
  shown. Keep the file's argued-comment voice (the ladder order stays deliberate).

- [ ] **Step 4: Settings.** `DeckSettingsForm`: delete the token mode row, `canSetTokenMode` and the
  value field (and the props `DeckSettingsDialog` / `CreateDeckDialog` pass); the theory switch
  `Different printing` → `Any printing` (and its hint if it says "different"); the managed-wishlist
  group offers `Tokens` (`managedWishlist.ts` label and hint: *a Tokens subfolder holds the token
  printings the plan is short of*). Delete `TokenModeControl.tsx` and its test. The Settings →
  Appearance row that says `Different printing` says `Any printing`.

- [ ] **Step 5: The mark's words.** `TheoryMark` gains `anyPrinting: boolean` — true when the exact
  switch is off and the row resolved on the name tier (whether or not its printing matches);
  `theoryMatchLabel` says `Match` for it (tooltip, `sr-only` twin, accessible-name clause) and
  `Art Mismatch` otherwise on the name tier. `THEORY_TIER_NAMES` and the grouping headings are
  unchanged.

- [ ] **Step 6: Green.** The test files, `tsc`, `eslint`, the stories touched. Commit:
  `feat(tokens): Compare's Tokens view, the managed wishlist's Tokens mode, Any printing, and Match`.

---

### Task 5: Docs (fan-in)

Per spec §6: `src/features/decks/CLAUDE.md` *Tokens & Emblems* (the entry rules — quantity 0, the
hand-added tail per list, Remove printing; the mode bullet → removed and why the column stays; one
read / two drawings; the plan's marks; the picker and All tokens; the default; `restore` /
`showDismissed` → removed; the theory mark's `Match` and `Any printing`), `docs/reference/decks-storage.md`
(the default, the commands — `deck_token_remove`, `token_printings`, the two retired — rule 3, rule 7,
`decks.token_mode`, `retire_hidden`), `docs/reference/wishlist-folders.md` (managed wishlists: the
`tokens` mode and the subfolder, v55), `src-tauri/CLAUDE.md` (`deck_tokens.rs` bullet "at the legacy
quantity or 1" → 0; the managed-wishlist bullet; the rung history's v55 sentence), and a line under
`docs/superpowers/specs/2026-09-26-token-stacks-design.md` §4.5 that the mode control is gone. No
counts a build answers. Commit: `docs(tokens): …`.
