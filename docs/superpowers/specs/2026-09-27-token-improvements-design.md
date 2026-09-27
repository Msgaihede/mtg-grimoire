# Managed tokens, improved — design

**Date:** 2026-09-27 · **Status:** approved design, spec for review.
**Replaces token stacks PR 3 (Collection tokens)**, which the reader dropped the same day: taking
tokens out of the collection is too hard to get right with double-sided tokens, and it is not
needed. What the reader wants instead is the managed mode made the only mode, and made quieter.

Every cite is relative to the repository root; `deck_tokens.rs` means
`src-tauri/src/deck_tokens.rs`.

## 1. What the reader asked for

1. Tokens default to quantity 0.
2. A token at 0 is not in the deck's stacks; every token is always in the Tokens & Emblems band.
3. **Add printing** gains a toggle that shows every token in the game, not only the deck's.
4. A token the deck does not create is marked like a rule-break card: a red outline — **and a
   badge**.
5. The dismiss (hide) button goes.
6. The Compare dialog gains a **Tokens** view, and **All** includes tokens.
7. The managed wishlist carries tokens, in a subfolder called **Tokens**.
8. The **Managed | Hide** mode buttons go: with every token at 0 until the reader uses it, there is
   nothing left for a mode to decide.
9. With **Matching printing** switched off, a theory mark's words say **Match**, not "Art
   Mismatch".
10. The Deck settings switch **Different printing** is renamed **Any printing**.

**Decisions the reader made along the way** (AskUserQuestion, 2026-09-27):

- Existing untouched tokens (drawn at 1 today) go to 0. A count or printing the reader set stays.
- A token the deck does not create stays in the band at 0 (red outline), and every tile gains a
  **Remove printing** button; **Reset printings** is dropped, because Remove printing covers it.
- Tokens dismissed before this build come back as ordinary tokens at 0, their printings kept.
- **All tokens** browses everything — all of them at once, grouped by token, the search box
  narrowing.
- The managed wishlist follows the Compare view: a **Tokens** mode, and **All** and **Tokens**
  fill the Tokens subfolder.
- The not-made-by-this-deck mark is an outline **and** a badge.

## 2. What the code does today

Mapped 2026-09-27 (read off the code):

- **The default of 1** is `implicit_quantity` — `legacy.unwrap_or(1)` — in `deck_tokens.rs`
  (~744–750), called by the read (`push_rows`) and by the write that materialises an entry
  (`implicit_of`, rule 2). TypeScript's twin is `DEFAULT_TOKEN_QUANTITY` in
  `src/features/decks/deckTokens.ts`, which only the Storybook fake reads.
- **The pile** is `DeckEditor`'s `keptTokens` (every row but a dismissed token's), passed to the
  four views as `tokenPile`, drawn only while `tokenPileDrawn` — `row.tokenMode !== "hidden"`.
  `keptTokens` also feeds Add printing and the live side of the plan's token marks.
- **Dismiss** is `deck_tokens.state = 'hidden'`, written by `deck_token_state`, drawn as the eye
  button and **Show dismissed** in `DeckTokensPanel.tsx`, kept out of the pile by `keptTokens`.
- **The mode** is `decks.token_mode` (`managed | collection | hidden`, v52), drawn by
  `TokenModeControl.tsx` in the band and in `DeckSettingsForm`. It is on `deck_undo::DECK_FIELDS`,
  and **`apply` refuses any undo step naming a field that list does not carry**
  (`deck_undo.rs`'s `cover_image_path` note) — so the column cannot leave that list without
  breaking Ctrl+Z for every deck edit made since v52.
- **Whether the deck makes a token** is already on every row: `DeckTokenRow.derived`
  (`deck_tokens.rs`), copied to `DeckTokenView.derived`, and drawn today only as the words "Added
  by hand" / "From …". A derived token can be `state: manual` and still `derived: true`, so
  `!derived` is the signal.
- **No command lists tokens across the corpus.** `card_printings` is one oracle id;
  `search_cards` has no layout predicate and hides tokens under `playable_only`. The token
  predicate is `is_token_printing` (`TOKEN_LAYOUTS` + `TWO_SIDED_LAYOUTS`). The corpus holds
  **3 245 token and emblem printings over 1 078 oracle ids**, plus six flip/reversible tokens
  (`docs/superpowers/specs/2026-09-07-deck-token-management-design.md`).
- **Compare** (`deck_theory.rs` `theory_diff`, `TheoryDiffDialog.tsx`) reads `deck_cards` only;
  its views are `All | Missing | Different printing`.
- **The managed wishlist** (`managed_wishlist.rs`) keeps one folder per theory deck, derived per
  device, behind a TEMP guard, keyed by `wishlist_folders.managed_deck_id` with a **unique index**
  on it; its dirty triggers watch `deck_cards`, `deck_categories` and `decks`, not the token
  tables. The mode is `decks.managed_wishlist_mode` (`off` or a Compare view), offered only in
  `DeckSettingsForm`'s `ManagedWishlistGroup`.
- **The theory mark**: `theoryMatchMark` re-resolves an exact row as a name row when the exact
  switch is off, and every name-tier mark is worded `THEORY_TIER_NAMES.name` — "Art Mismatch" —
  even though the reader has just asked not to tell printings apart.

## 3. Design

### 3.1 Quantity 0 by default

- `implicit_quantity` becomes `legacy.unwrap_or(0)`. A legacy count a reader set before v52 is
  still honoured; an untouched token is 0. Both the read and the materialising write change with
  it, so a first `+` on an untouched token writes an entry at 1.
- `DEFAULT_TOKEN_QUANTITY` becomes `0`, and the Storybook fake with it.
- **Nothing is written to existing rows**: an untouched token was never stored, so it simply reads
  0 from this build on. A peer still on v52, v53 or v54 reads the same untouched token at 1 — a difference
  in what two builds *draw*, never in what they store.

### 3.2 The stacks show only what the reader uses; the band shows everything

- The pile's list is the band's list filtered to `quantity > 0` — a filter on `tokenPile.tokens`
  in `DeckEditor` and nowhere else (Add printing and the live side of the plan's marks keep every
  row). A token whose every entry is 0 draws nothing in the stacks, and the pile's heading, which
  already sums copies, is unchanged.
- The band draws every row: the deck's tokens at whatever count, hand-added tokens with their
  entries.
- `tokenPileDrawn`'s mode gate goes (§3.9); the pile draws whenever something is above 0.

### 3.3 Dismiss goes

- The band loses the eye button, **Show dismissed**, the dismissed count and the "every token is
  dismissed" sentence; `useDeckTokens` loses `dismiss`, `restore` and `showDismissed`; `ipc.ts`,
  `web::route` and the fake lose `deck_token_state`; the Rust command goes with them.
- **`'hidden'` stays in `deck_tokens.state`'s `CHECK`** — a peer on an older build can still write
  it, and an old undo step can restore it — and every reader treats it as not hidden.
- **A launch pass retires it**: `deck_tokens::retire_hidden`, after the corpus is readable (the
  `convert_legacy_picks` / `repair_entry_finishes` position), for every `state = 'hidden'` row:
  its entries' quantities go to 0 in both lists, and its state becomes `auto` where the deck still
  derives the token, `manual` where it does not. **Behind `capture::suppressed`**, because every
  device derives the same answer from the same synced rows, and idempotent, so a `hidden` that
  arrives later from an older peer is retired at the next launch. Until then the row draws like
  any other. The reader's rule — dismissed tokens come back at 0, their printings kept — is the
  whole of what it does.
- `auditText.ts`' "Dismissed X" / "Restored X" wording stays: history rows already on disk still
  need it.

### 3.4 Remove printing, and Reset goes

- **A new command, `deck_token_remove(deck_id, variant, entry)`**, deletes one entry
  unconditionally — the one thing no command does today (`deck_token_set_quantity` keeps a
  token's last entry at 0, `deck_token_reset` takes them all).
  - **A derived token** whose last entry in the list goes falls back to its implicit printing at 0
    — what Reset did.
  - **A hand-added token is drawn only in a list that holds an entry of it** (the manual tail in
    `deck_token_rows` stops emitting an implicit row for a list with none). When its last entry in
    *both* lists is gone, its state returns to `auto` — `write_state` deletes the row — and it
    leaves the band.
  - Journalled like every token write (`journal_in`): a `deck` audit row with
    `{field: "token", action: "remove", …}` worded **"Removed Treasure's TMOM #12 printing"**, and
    one `Op::Tokens` undo step.
- Every tile — band and pile — gains **Remove printing** (a trash glyph, named for its entry).
- **Reset printings goes**: the button, `useDeckTokens`' `reset`, the IPC wrapper, the fake
  handler and the Rust command. `auditText.ts` keeps the "Reset X's printings" wording for old
  rows.

### 3.5 Not made by this deck: an outline and a badge

- A token with `derived === false` is drawn like a rule-break card — `border-destructive` on the
  tile, `CardChin tone="destructive"` under it — in the band and in the Stacks and Grid piles, plus
  a corner badge reading **NOT MADE BY DECK** in the rule-break badge's place and style, with a
  tooltip: *"Nothing in this deck makes \<token\>. It was added by hand."*
- Table and Text rows carry the same words as a small destructive tag after the name.
- The band tile is `CardArt`, which has no tone: it gains the same outline through its wrapper
  (the chin's tone carries it through the foot), never by forking `CardArt`.
- The badge's words are also in the tile's accessible name, because the badge is `aria-hidden` like
  every other mark.

### 3.6 Add printing → All tokens

- **A new command, `token_printings(marketplace)`**: every paper printing `is_token_printing`
  answers yes for, as the `Printing` DTO the picker already renders (with `finishPrices`), plus each
  printing's `oracle_id`, name and the subtitle facts (colours, power, toughness, oracle text).
  One statement over `cards` with the token predicate in SQL; no index is added (it runs on a press,
  not per keystroke). Routed on the web target (`web::route`) and answered by the fake.
- The picker's header gains an **All tokens** `ToggleChip`, off by default. Off, it is today's
  picker over the deck's own tokens. On, it lists **every** token, grouped by token under its name
  and subtitle, every printing and finish as a tile; the search box narrows by token name or set
  code, as now.
- **It must stay responsive at 3 245 printings.** Tiles are `CardArt` (lazy images). If opening the
  toggle in the shipped window (debug build) takes more than about a second to first paint, the
  groups are virtualised; the plan's live pass measures it either way.
- A pick adds that printing to the list, as today — a token the deck does not make becomes a
  hand-added token (`manual`), drawn with §3.5's mark.

### 3.7 Compare → Tokens

- `deck_theory_diff` gains token rows: for each `(card_id, finish)` of a token entry, the plan's
  entries (theory list, implicit rows included) minus the actual list's, positive only — the same
  grain and the same subtraction the card rows use. A token row carries a flag (`isToken`), the
  category name **Tokens & Emblems**, the printing's price at that finish, `ownedSpare` from the
  collection (copies of that printing and finish in no deck group, the regular copy spelled
  `nonfoil`), and `heldAsOtherPrinting` from the actual list's other printings of the same token.
- The dialog's views become **All | Missing | Different printing | Tokens**: **Tokens** is the
  token rows alone; **All** is every row, tokens included; **Missing** and **Different printing**
  are card rows only.
- **Send to wishlist** takes token rows too: a wish pinned to the printing, with the entry's
  finish as the preferred finish — one wish per row, folded by the wishlist's own grain.

### 3.8 The managed wishlist → a Tokens subfolder

- `decks.managed_wishlist_mode` gains `tokens`; the setting's choices follow the Compare views
  (Off, All, Missing, Different printing, Tokens).
- **All** and **Tokens** fill a subfolder named **Tokens** inside the deck's managed folder with
  the token rows' wishes; **Missing** and **Different printing** leave tokens out; **Tokens** puts
  nothing in the parent folder itself.
- **The subfolder's identity is a column, not a name**: `wishlist_folders.managed_tokens INTEGER NOT
  NULL DEFAULT 0`, and `idx_wishlist_folders_managed` becomes unique on
  `(managed_deck_id, managed_tokens)`. **User schema v55** (v53 is `main`'s per-list piles and v54
  is `sync_gone`, folder deletes across devices; written as v54 and renumbered when the lanes met
  the folder-deletes branch). Not synced, like the rest of the managed wishlist: derived per device.
- The subfolder carries the deck's `managed_deck_id`, so the TEMP guard, `settle_deck`'s delete
  path and TypeScript's `isManaged` already cover it; `settle_deck` deletes the child's wishes
  before the child, and the child before the parent.
- The dirty triggers gain `deck_token_printings` and `deck_tokens`, so a token step settles the
  wishlist like a card step does.

### 3.9 Managed | Hide goes

- `TokenModeControl.tsx` is deleted; the band and `DeckSettingsForm` lose the control, its hint
  and the `canSetTokenMode` prop; `tokenPileDrawn` stops reading the mode.
- **`decks.token_mode` stays** — in the schema, on the `decks` capture spec and on
  `deck_undo::DECK_FIELDS` — and nothing reads it. A deck set to `hidden` draws its pile again,
  which after §3.1 is the tokens its reader has counted and nothing else. `auditText.ts` keeps the
  `tokenMode` wording for old rows.

### 3.10 The theory mark's words

- With the deck's **Matching printing** switch off, a row resolved on the name tier is worded
  **Match** — its tooltip, its `sr-only` twin and its clause in the card's accessible name. With
  the switch on, a name-tier row is a genuine different printing and keeps **Art Mismatch**.
  `theoryMatchMark` carries which it is (a field on `TheoryMark`), and `theoryMatchLabel` reads it.
- The switch labelled **Different printing** becomes **Any printing**, in `DeckSettingsForm` and
  in Settings → Appearance's matching-colour row, so the two surfaces say one thing.
- The **Matches theory** grouping's headings do not change: they bucket by the plan, whatever the
  switches say.

## 4. Sync and upgrade

- One user rung, v55 (§3.8). No wire change: `deck_token_remove` writes rows the existing capture
  specs already carry; `deck_tokens.state` and `decks.token_mode` keep their words.
- A peer on an older build keeps drawing untouched tokens at 1, can still dismiss (retired here at
  the next launch) and still draws the mode control. **Every device is updated before it syncs
  across a token-model change**, the standing rule.

## 5. Testing

- **Rust**: `implicit_quantity` answers 0 for an untouched token and the legacy count where one is
  stored; the first step writes 1. `retire_hidden` zeroes a dismissed token's entries in both lists,
  sets `auto` or `manual` by derivation, writes no op, and is idempotent. `deck_token_remove` on a
  derived token's last entry falls back to the implicit printing at 0; on a hand-added token's last
  entry in both lists removes the token; each files one history row and one undo step that puts it
  back. `token_printings` answers every token and emblem printing and nothing else (a flip token
  in, a normal card out). `theory_diff` answers token rows at the printing-and-finish grain, and
  the wishlist send files a pinned wish. The managed wishlist fills the Tokens subfolder for All and
  Tokens and not for Missing, re-settles on a token step, and the v55 rung builds the widened
  index.
- **TypeScript**: the pile omits a token at 0 and the band keeps it; the outline and badge on a
  hand-added token and not on a derived one; no dismiss, reset or mode control anywhere; the picker's
  toggle lists every token; Compare's four views filter as §3.7 says; the mark says Match with the
  exact switch off and Art Mismatch with it on; the settings row says Any printing.
- **Live pass** (shipped window, debug build): the All tokens toggle's time to first paint; a
  hand-added token's outline and badge at the stack card's size; Compare's Tokens view on a deck
  whose plan counts tokens.

## 6. Docs

`src/features/decks/CLAUDE.md`'s *Tokens & Emblems* (the entry rules, the mode bullet, one read /
two drawings, the count, the plan's marks, the picker, the default, `restore` / `showDismissed`),
`docs/reference/decks-storage.md`'s token sections (the default, the commands, rule 3, rule 7,
`decks.token_mode`), `docs/reference/wishlist-folders.md`'s managed wishlists, `src-tauri/CLAUDE.md`'s
`deck_tokens.rs` and managed-wishlist bullets and the rung history, and a line under the token-stacks
spec's §5.

## 7. What it costs

One user rung and one column. Two commands added (`deck_token_remove`, `token_printings`), two
removed from the IPC surface (`deck_token_state`, `deck_token_reset`). A launch pass that does
nothing on a database with no dismissed token. A corpus scan on the All tokens press. The
Compare read and the managed wishlist each gain a token arm.
