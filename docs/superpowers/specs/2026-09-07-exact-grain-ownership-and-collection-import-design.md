# Exact-grain ownership, and importing missing cards from the collection

**Date:** 2026-09-07
**Issue:** the deck settings need an `Import missing cards from collection` button
**Status:** design, approved

## The problem, in one sentence

A deck can read *12 missing* and its `Pull from collection` dialog can honestly offer nothing,
because the two are asking at different grains.

`deck::owned_by_oracle` attributes a deck's held copies by **oracle id** — "a Bolt is a Bolt", so
an M10 Bolt filed in the group makes an LEA line read as owned. `deck_pull::CANDIDATE_SQL` matches
**`(card_id, finish)`** exactly, and `deck_pull.rs`'s own header calls that "a deliberate
narrowing … this fills strictly *fewer* holes than the app itself would count". Both are
defensible alone. Together they are a screen that says a reader is short of twelve cards and a
dialog that says there is nothing to be done about it.

**The resolution is exactness everywhere.** The count narrows to meet the pull; the pull does not
widen to meet the count.

## The rule

> **A deck's group holds only copies its live list claims at `(card_id, finish)`.**

Everything below is that sentence made true and kept true, plus the one button the issue asked
for.

---

## 1. The count narrows

`src-tauri/src/deck.rs`.

### 1.1 `owned_by_oracle` → `owned_by_printing`

```sql
SELECT e.card_id, e.finish, sum(e.quantity)
  FROM collection_entries e
  JOIN collection_folders f ON f.id = e.folder_id
 WHERE f.deck_id = ?1
 GROUP BY e.card_id, e.finish
```

Keyed `(String, String)` — the collection's spelling of the finish, `nonfoil` / `foil` / `etched`.

**`JOIN cards` goes away**, and that is a behaviour change worth stating rather than an
optimisation. Today an orphaned printing — a `collection_entries` row whose `card_id` is not in
`cards` — has no oracle id, so it is dropped from the map and the deck reads it as owned 0. At the
printing grain there is nothing to look up: the deck row and the collection row name the same
`card_id`, and the copy counts. The existing doc's `JOIN cards` argument ("an orphaned row names
no oracle card, so it reads owned 0 until the reconciler or the next sync gives it its identity
back") describes a limitation the new grain simply does not have.

### 1.2 `attribute_owned` keys on the printing

The signature takes the new map. Per row, the key is `(row.card_id, row.finish ?? "nonfoil")` —
`normalise_finish`'s translation read the other way, which `release_group_copies` already does
verbatim (`let entry_finish = finish.unwrap_or(crate::schema::FINISHES[0])`). Spelled through
`crate::schema::FINISHES[0]`, never the literal.

**Unchanged, and each for its existing reason:**

- a `variant != LIVE` row is zeroed — a plan reserves nothing;
- a row in an inactive category is zeroed — a switched-off pile counts toward nothing;
- the walk order is the slice's own, which is `read_deck_cards`' `ORDER BY`. The pool is still a
  scarce thing handed out in a defined order, so the same printing short in two piles still
  shares one pool.

The one guard that changes shape: `let Some(oracle) = row.oracle_id...` becomes a plain key build,
because a deck row always has a `card_id`. The `category_active` test moves out of that `filter`
and stands on its own, beside the `variant` test.

### 1.3 What follows for free

**TypeScript needs no arithmetic change.** `DeckStats.tsx:474` computes `missing` from
`ownedQuantity` alone (`const have = Math.min(card.ownedQuantity, card.quantity)`), and
`quickCollection.ts`'s `shortfall`, `cardControl.tsx`'s guards and `CardStack.tsx`'s `N/M` badge
all read that same field. Every surface in the app narrows together because there is one number.

**`missing_to_wishlist` inherits it.** It walks `row.quantity - row.owned_quantity`, so a copy of
the wrong printing sitting in the deck's group now reaches the shopping list. That is the rule
being consistent, not a side effect — under §2 that copy will have left the group anyway, so the
case is transitional.

---

## 2. The group is kept honest

### 2.1 `release_unclaimed_copies(tx, deck_id)` — new, in `deck.rs`

Sweep this deck's group and move every copy no **live** `deck_cards` row claims at
`(card_id, finish)` into `Recently removed`.

Per `(card_id, finish)` present in the group: `surplus = held - claimed`. Where `surplus > 0`,
walk the group's rows for that identity `ORDER BY id` (oldest first —
`collection_folders::take_copies`' rule and `release_group_copies`') and take `surplus` copies
through `collection_folders::take_copies(tx, id, take, Some(removed))`. The move is that
function's and is not written a second time — `collection_alloc`'s first rule.

**A partial take, not a folder swap.** A group row of 4 LEA Bolt against a line of 2 is 2 claimed
and 2 surplus, and `idx_collection_grain` is UNIQUE on
`(card_id, finish, condition, lang, altered, signed, proxy, misprint, serial_number, grading, folder_id)`
— so a bare `UPDATE … SET folder_id` would both move too much and collide with whatever
`Recently removed` already holds at that grain. `take_copies` splits the row and folds the
remainder, including the trade-list clamp.

**A deck with no group holds nothing rather than refusing**, and a missing `Recently removed`
folder is resolved only when there is something to file — both are `release_group_copies`'
existing asymmetries, carried over so the two functions behave alike.

### 2.2 Two callers: `swap_printing` and `set_card_finish`

These are the only two commands that rewrite a live row's **identity** while touching no
collection table — confirmed by reading both: `swap_printing` reads `deck_cards`, `cards` and
writes `deck_cards` plus the audit and undo rows; `set_card_finish` reads `cards.finishes` and
writes `deck_cards`. `release_group_copies`' own doc records the consequence: "after *Use this
printing* the group still holds the *old* printing's row."

Each calls `release_unclaimed_copies` **after** its rewrite, inside its existing transaction.

**A sweep after, rather than a targeted release before**, because a swap can *fold* into a line
the deck already has (`SwapResult.folded`). Reading the finished list against the group answers
both the plain case and the folded one with one query; a targeted `release_group_copies` on the
old identity would have to reason about the fold to get the quantity right.

### 2.3 `release_group_copies` drops its oracle-grain fallback

Its `ORDER BY CASE` currently has three arms: exact `(card_id, finish)`, then same `card_id` any
finish, then any row in the group sharing an `oracle_id`. The third exists to cure exactly the
stranding §2.2 now prevents at the source.

Under the exact grain it is a bug. A deck may legitimately list **both** LEA Bolt and M10 Bolt,
with the group holding both; cutting the LEA line and coming up short would then give back M10
copies that the M10 line still claims. The second arm is the same bug in the finish dimension.

So the query narrows to the exact `(card_id, finish)` match, and the `ORDER BY` reduces to
`e.id`. Its doc section "It matches on the **oracle card**, not on the printing, and that is the
fix for a stranding" is rewritten to record why the fallback existed, what replaced it, and that
`swap_printing` and `set_card_finish` are now the ones that keep the promise.

### 2.4 The residual, named rather than mechanised

A device running an older build can still sync a `collection_entries.folder_id` that mismatches.
`release_unclaimed_copies` is idempotent and cheap, so the state is curable, but nothing in this
design runs it on a sync. That is a known gap, written down here and in
`docs/reference/decks-storage.md`, not a mechanism.

---

## 3. One migration rung — v35

`USER_SCHEMA_VERSION` 34 → 35, as an `if v < 35 { … }` block below the `if v < 34` one.

It applies §2.1's sweep to every `collection_folders` row with `kind = 'deck'`. The v25 conversion
"replaced matched candidates by oracle id, so the conversion routinely files a printing the deck
does not list" (`release_group_copies`' own doc) — this is the one-time pass that brings existing
files under the rule.

**The rung carries its own SQL and its own arithmetic, and must not call
`collection_folders::take_copies` or `release_unclaimed_copies`.** A migration step is history the
day it ships, and app code it called would silently change what an old file is converted into. The
v25 rung is the model: it inlines `take_copies`' split with both clamps and says why.

The folder kinds are spelled as literals — `'deck'`, `'removed'` — for the same reason:
`COLLECTION_FOLDER_KINDS` is a constant that may be reordered, and a rung reading it would convert
a v34 file differently next year.

**Where the copies land is load-bearing.** `Recently removed` is ranked **second** in
`CANDIDATE_SQL`'s `ORDER BY CASE` — after the root, before the reader's own folders. So the first
press of the new button offers those copies straight back for every line that genuinely matches
them, and the lines that do not match are honestly missing. The reader is not left with a state
they cannot act on, which is what made this rung acceptable rather than merely correct.

A missing `Recently removed` folder skips the rung's move rather than failing it: a rung that
errors blocks startup, and a hand-edited file without that folder must still open.

### Fixture discipline

`schema.rs`'s tests require a real fixture one rung below head. Add a **v34** fixture holding a
deck whose group carries both a matching copy and a mismatched one, and assert:

- the rung moves the mismatched copy to `Recently removed` and leaves the matching one;
- a partly-claimed row is **split**, not moved whole;
- another deck's group is untouched;
- the head schema is unchanged by the rung (it moves data, not shape) — so
  `the_user_schema_is_byte_identical_to_what_the_ladder_builds` still holds with no new DDL.

---

## 4. The button

`src/features/decks/DeckSettingsDialog.tsx`.

### 4.1 Where and what it says

A new section directly **above** the existing `Empty a list` block, built to that block's shape:
`mt-5 border-t border-border pt-4`, an `h3.text-xs` heading, one line of `text-dim` small print,
and a `RowAction`.

The small print says the two things that cannot be read off the button: it moves copies from the
collection into this deck's folder, and it **writes no card into the list** — the same fact
`PullFromCollectionDialog`'s footer states, because a reader in the settings dialog has not seen
that footer yet.

The button reads `Import missing cards from collection…`. When the plan is empty it reads
`Import missing cards from collection… (nothing to import)` and is `disabled` — **the reason
travels in the visible name**, which is the rule the two Clear buttons beside it already follow:
"a greyed control whose name is the bare label reads to a screen reader — and to a test — as a
control that is missing rather than one that has nothing to do."

The heading is `Fill this deck from your collection`; the button is the one control in it.

### 4.2 What it opens

`PullFromCollectionDialog`, over the **whole** plan — no `cardName`, which is the deck-wide
shape the stats-band entrance already uses. **No new dialog and no new IPC command.**

It is mounted **nested inside** the settings dialog rather than delegated upward.
`useDismissOnEscape`'s `captureStack` is innermost-last by mount order and was built for a layer
opened over an already-open dialog, so one Escape closes the pull and the next closes settings.
`Dialog` is `fixed inset-0` and unportalled, and the nested one renders later in the tree, so it
paints above with no z-index of its own.

**Delegating to `DeckEditor`'s `Layer` union was rejected for a structural reason**: the settings
dialog has three hosts — `DeckEditor`, `DecksPage`'s gallery panel, and `DecksPage`'s tile menu —
and two of them have no editor and no pull layer. A button that worked only from inside the
editor would be a control that changed meaning with where it was opened from.

### 4.3 The read and the write

`useDeck.ts` already exports `pullPlanQuery` and `usePullPlan`; the write is
`ipc.deckPullFromCollection`. Both are reused as-is. The plan is fetched only while the settings
dialog is open — `Dialog` renders `children` only when `open`, which is the property this file
already relies on for `deck_get`, the folder read and the format read.

Invalidation on success is whatever the editor's entrance already does; it is the same command
answering the same `DeckPullOutcome`.

### 4.4 What is not touched

The stats-band `Pull from collection` button, `deckCardMenu`'s per-card entrance,
`quickCollection.ts`'s `choosePull`, and `PullFromCollectionDialog` itself. This section adds a
third entrance to a dialog that already has two.

---

## 5. Testing

**Rust — `deck.rs`:**

- `attribute_owned` at the new grain: a matching printing counts; a different printing of the same
  oracle card does **not**; a different finish does not; a theory row is zeroed; an inactive pile
  is zeroed; two piles listing one printing share one pool in read order.
- An orphaned printing now counts, where the oracle-grain version read 0.
- `release_unclaimed_copies`: sweeps the unclaimed, spares the claimed, **splits** a partly-claimed
  row, spares another deck's group, and is a no-op on a deck with no group.
- `release_group_copies` no longer reaches a sibling printing: the LEA/M10 case from §2.3.

**Rust — `swap_printing` / `set_card_finish`:** each pushes the old identity's copies to
`Recently removed` and leaves the new line reading missing; the folded-swap case lands right.

**Rust — `schema.rs`:** the v35 rung on a real v34 fixture, per §3.

**TypeScript:** the settings section renders; the button's name carries its reason and is disabled
on an empty plan; the press opens the pull dialog; Escape closes the pull and leaves settings open;
a second Escape closes settings. Plus a story for the section.

**Live:** drive the real window per `docs/reference/live-ui-verification.md` — open a deck's
settings from both the editor and the gallery, press the button, confirm a pull, and confirm the
deck's missing count moves.

## 6. Docs to update in the same commits

- `docs/reference/decks-storage.md` — how owned/missing is answered, at the new grain, and §2.4's
  residual.
- `docs/reference/collection-folders.md` — the honesty rule and what the v35 rung did.
- `src-tauri/CLAUDE.md` — the schema ladder's head.

Numbers and lists in these files are re-counted in the commit that changes them (the repo's
prose-only rule: a prose edit routes to neither CI job).
