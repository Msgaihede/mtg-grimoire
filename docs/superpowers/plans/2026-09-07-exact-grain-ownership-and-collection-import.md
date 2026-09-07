# Exact-Grain Ownership and Collection Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow a deck's owned/missing count from the oracle card to `(card_id, finish)` so it agrees with the pull that fills it, keep every deck's group holding only what its live list claims at that grain, and add an `Import missing cards from collection…` button to the deck settings dialog.

**Architecture:** Rust owns the plumbing — the attribution query, a new sweep that evicts unclaimed copies to `Recently removed`, and a one-time v35 migration rung. TypeScript owns no new arithmetic at all: every surface derives `missing` from the one `ownedQuantity` field, so the narrowing propagates for free. The button is a third entrance to the existing `PullFromCollectionDialog` — no new IPC command and no new dialog.

**Tech Stack:** Rust + rusqlite (SQLite), React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-09-07-exact-grain-ownership-and-collection-import-design.md` — read it before starting any task.

## Global Constraints

- **File ownership is absolute.** Tasks 1–5 run in parallel in ONE worktree. Two subagents editing one file clobber each other. Edit **only** the files listed under your task's **Files:** block. If you believe another file must change, say so in your report — do not edit it.
- **Do not run `npm run verify`, `npm test`, or a full `cargo test`.** Your slice compiles against a tree your siblings are still changing. Run only the narrow commands your task names. The orchestrator runs `verify` once after fan-in.
- **Do not commit.** The git index is shared across parallel agents in one worktree; a `git add` sweeps a sibling's half-written file into your commit. Report what you changed and stop.
- Schema constants are spelled through `crate::schema::*` in app code (`FINISHES[0]`, `COLLECTION_FOLDER_KINDS[…]`), and as **literals** inside a migration rung. A rung is history the day it ships.
- Rust: `cargo fmt` style. Every new function and every non-obvious branch carries a doc comment in this file's voice — say *why*, not *what*.
- Never write a number into prose that a build already answers (story counts, test counts).
- **Out of scope for every task:** `src-tauri/src/search.rs` (its local `owned_by_oracle` is the facet index's collection-wide question, not a deck's), `PullFromCollectionDialog.tsx`, `DeckStats.tsx`, `quickCollection.ts`, `deckCardMenu.tsx`, and `src/lib/ipc.ts`'s **types** (no IPC shape changes in this plan).

## File ownership map

| Task | Owns (exclusive) |
| --- | --- |
| 1 | `src-tauri/src/deck.rs`, `src-tauri/src/collection_alloc.rs` |
| 2 | `src-tauri/src/schema.rs` |
| 3 | `src/features/decks/DeckSettingsDialog.tsx`, `.test.tsx`, `.stories.tsx` |
| 4 | `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts` |
| 5 | `docs/reference/decks-storage.md`, `docs/reference/collection-folders.md`, `src-tauri/CLAUDE.md`, and **doc comments only** in `src-tauri/src/deck_pull.rs`, `src-tauri/src/deck_quick_add.rs`, `src-tauri/src/collection_source.rs`, `src/lib/ipc.ts` |

---

### Task 1: The grain, the sweep, and the two callers

**Files:**
- Modify: `src-tauri/src/deck.rs` — `owned_by_oracle` (~3966), `attribute_owned` (~4011), its call site (~3752), `release_group_copies` (~1108), `swap_printing` (~3140), `set_card_finish` (~3303)
- Modify: `src-tauri/src/collection_alloc.rs` — the one test asserting oracle-grain ownership (~1166)
- Test: inline `#[cfg(test)]` modules in both files

**Interfaces:**
- Consumes: `crate::schema::FINISHES[0]` (`"nonfoil"`), `deck_group(conn, deck_id) -> Result<Option<i64>, String>`, `removed_group(conn) -> Result<Option<i64>, String>`, `crate::collection_folders::take_copies(tx, id, quantity, dest) -> Result<i64, String>`, `crate::collection_alloc::NO_REMOVED_FOLDER`.
- Produces: `fn owned_by_printing(conn: &Connection, deck_id: i64) -> Result<HashMap<(String, String), i64>, String>`; `fn attribute_owned(rows: &mut [DeckCardRow], owned: &HashMap<(String, String), i64>)`; `pub(crate) fn release_unclaimed_copies(tx: &Connection, deck_id: i64, variant: &str) -> Result<(), String>`. Task 4 mirrors these names in TypeScript; keep them.

`DeckCardRow` already carries `card_id: String`, `finish: Option<String>`, `variant: String`, `category_active: bool`, `quantity: i64`, `owned_quantity: i64`. Nothing about the struct changes.

- [ ] **Step 1: Add the two finish-aware test helpers**

The module's existing helpers are finish-blind: `file_into_group(conn, deck_id, card_id, quantity)` files a **nonfoil** copy (through `own`, whose `EntryInput` hard-codes `finish: "nonfoil"`), and `folder_copies(conn, folder, card_id)` sums a printing across every finish. The new tests need both axes. Add these beside them, in the same voice:

```rust
    /// [`file_into_group`], in a named finish — the axis that helper does not carry, because
    /// the sixty tests above it are about printings and the grain is now both.
    fn file_finish_into_group(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        finish: &str,
        quantity: i64,
    ) -> i64 {
        let folder = group_of(conn, deck_id);
        let entry = crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: finish.to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        crate::collection_folders::refile_entry(conn, entry, Some(folder))
            .unwrap()
            .id
    }

    /// [`folder_copies`] at the grain custody is now kept at. The finish-blind form stays: the
    /// tests that use it are asking "how many of this card are in this place", which is still a
    /// fair question and still its own.
    fn folder_copies_of(conn: &Connection, folder: i64, card_id: &str, finish: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE folder_id = ?1 AND card_id = ?2 AND finish = ?3",
            params![folder, card_id, finish],
            |r| r.get(0),
        )
        .unwrap()
    }
```

- [ ] **Step 2: Write the failing tests for the new grain**

`seeded()` already carries three printings of one Lightning Bolt (`bolt-lea`, `bolt-m10`, `bolt-jp`, all `oracle_id = 'o1'`) and `bolt-m10` is the one sold in foil. Nothing new is needed in the fixture. `owned_of(conn, deck_id, card_id, category_id)` reads the count the way the editor does.

```rust
    /// **The whole point of the narrowing.** The group holds an M10 Bolt and the list names the
    /// LEA one, so the deck is honestly short of the card it actually lists — and
    /// `deck_pull_plan` can now offer to fill exactly the hole the editor draws, which is the
    /// disagreement this replaced.
    #[test]
    fn a_different_printing_of_the_same_card_is_not_owned() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        file_into_group(&conn, deck.id, "bolt-m10", 4);

        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", main),
            0,
            "an M10 copy fills no LEA line — the pull cannot move it, so the count must not claim it"
        );
    }

    /// The same rule one axis over. `bolt-m10` is the printing `seeded()` sells in both.
    #[test]
    fn a_different_finish_of_the_same_printing_is_not_owned() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add_foil(&conn, deck.id, "bolt-m10", main, 2);
        file_into_group(&conn, deck.id, "bolt-m10", 2);

        assert_eq!(owned_of(&conn, deck.id, "bolt-m10", main), 0);
    }

    /// And the case that must keep working: the deck row's `NULL` finish is the collection
    /// row's `'nonfoil'`, which is the whole of the translation between the two tables.
    #[test]
    fn the_exact_printing_and_finish_is_owned() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        file_into_group(&conn, deck.id, "bolt-lea", 3);

        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", main), 3);
    }

    /// A foil line filled by foil copies — the other half of the translation, and the one a
    /// `coalesce` written the wrong way round would break silently.
    #[test]
    fn a_foil_line_is_filled_by_foil_copies() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add_foil(&conn, deck.id, "bolt-m10", main, 2);
        file_finish_into_group(&conn, deck.id, "bolt-m10", "foil", 2);

        assert_eq!(owned_of(&conn, deck.id, "bolt-m10", main), 2);
    }

    /// **An orphaned printing now counts, where it used to read 0.** `owned_by_oracle` needed an
    /// INNER `JOIN cards` to learn a row's oracle id, so a row whose printing had left the
    /// database was dropped from the map until the next sync gave it its identity back. At this
    /// grain there is nothing to look up.
    #[test]
    fn an_orphaned_printing_now_counts() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-jp", main, 1);
        file_into_group(&conn, deck.id, "bolt-jp", 1);
        conn.execute("DELETE FROM cards WHERE id = 'bolt-jp'", [])
            .unwrap();

        assert_eq!(owned_of(&conn, deck.id, "bolt-jp", main), 1);
    }
```

Also pin what does **not** change. Search the module for the existing theory and inactive-category attribution tests (`the_allocator_claims_nothing_for_the_theory_variant` is one) and confirm each still passes; where its fixture relied on cross-printing matching, re-point the fixture at the same printing.

- [ ] **Step 3: Run them and watch them fail**

```
cd src-tauri && cargo test --lib deck:: 2>&1 | tail -40
```

Expected: the three narrowing tests FAIL (they read the full quantity as owned, because the oracle grain still matches). `an_orphaned_printing_now_counts` FAILs reading 0.

**A filter that selects no tests exits 0** — check the summary line names a non-zero count of run tests before believing any result.

- [ ] **Step 4: Replace `owned_by_oracle` with `owned_by_printing`**

```rust
/// Copies this deck **holds**, per printing **and finish**.
///
/// Since schema v25 this is a question about where a collection row physically sits: a deck's
/// group is one `collection_folders` row with `kind = 'deck'` and `deck_id` set, and every
/// `collection_entries` row filed into it is a copy in that deck.
///
/// **Grouped by `(card_id, finish)`, and that is deliberately not the oracle card.** It was the
/// oracle card until 2026-09-07 — "a Bolt is a Bolt", carried over from the allocator, which
/// matched across printings. What that bought was a deck that counted an M10 Bolt toward its LEA
/// line; what it cost was a deck reading *12 missing* whose `deck_pull_plan` could honestly offer
/// nothing, because [`crate::deck_pull::CANDIDATE_SQL`] matches the printing and the finish
/// exactly. Two grains asking one question is a screen that contradicts the dialog it opens, so
/// the count came down to meet the pull rather than the pull going up to meet the count.
///
/// **No `JOIN cards`, and its absence is a behaviour change rather than a tidy-up.** The oracle
/// version needed an INNER join to learn a row's oracle id, so an orphaned printing — a row whose
/// `card_id` is not in `cards` — was dropped from the map and read as owned 0 until the next
/// sync gave it its identity back. At this grain there is nothing to look up: the deck row and
/// the collection row name the same `card_id`, so the copy counts.
fn owned_by_printing(
    conn: &Connection,
    deck_id: i64,
) -> Result<HashMap<(String, String), i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.card_id, e.finish, sum(e.quantity)
               FROM collection_entries e
               JOIN collection_folders f ON f.id = e.folder_id
              WHERE f.deck_id = ?1
              GROUP BY e.card_id, e.finish",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Re-key `attribute_owned`**

Keep the whole doc comment and update the two paragraphs that name the oracle grain. The body:

```rust
fn attribute_owned(rows: &mut [DeckCardRow], owned: &HashMap<(String, String), i64>) {
    let mut left = owned.clone();
    for row in rows.iter_mut() {
        // **A plan reserves nothing**, and a switched-off pile counts toward nothing anywhere in
        // the app. Both zero the row rather than taking from the pool — the copies stay in `left`
        // for the rows that are the deck.
        if row.variant != LIVE || !row.category_active {
            row.owned_quantity = 0;
            continue;
        }
        // The deck row's `NULL` is the collection row's `'nonfoil'` — [`normalise_finish`]'s
        // translation read the other way, and the same line [`release_group_copies`] already
        // carries. The `oracle_id` guard this replaced is gone with the join that needed it: a
        // deck row always has a `card_id`.
        let key = (
            row.card_id.clone(),
            row.finish
                .clone()
                .unwrap_or_else(|| crate::schema::FINISHES[0].to_owned()),
        );
        let remaining = left.entry(key).or_insert(0);
        let take = (*remaining).min(row.quantity).max(0);
        *remaining -= take;
        row.owned_quantity = take;
    }
}
```

Update the call site at ~3752 to `attribute_owned(&mut cards, &owned_by_printing(conn, id)?);`.

- [ ] **Step 6: Run the tests and confirm they pass**

```
cd src-tauri && cargo test --lib deck:: 2>&1 | tail -40
```

Expected: PASS. Other `deck.rs` tests that assumed the oracle grain will now fail — fix each by making its fixture file the printing the list names, **not** by widening the code. If a test's whole point was cross-printing attribution, rewrite it to assert the new rule and say so in its name.

- [ ] **Step 7: Fix `collection_alloc.rs`'s oracle-grain test**

`collection_alloc.rs:1166` asserts `"a Bolt is a Bolt — \`owned_by_oracle\`'s rule"`. Read the test, decide which of the two it is, and:
- if it is really testing `collection_to_deck`/`deck_to_collection` and merely *used* a cross-printing fixture, file the matching printing and keep the assertion;
- if cross-printing attribution is its subject, invert it: the copy is now **not** counted, rename it to say so, and replace the message with a sentence naming this change.

- [ ] **Step 8: Write the failing tests for the sweep**

```rust
    /// The state the exact grain creates and this function exists to prevent: a printing sitting
    /// in the group that the list does not name. It leaves for `Recently removed`, which
    /// `CANDIDATE_SQL` ranks **second** — so the next press of the import offers it back.
    #[test]
    fn the_sweep_evicts_a_printing_the_list_does_not_name() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        file_into_group(&conn, deck.id, "bolt-m10", 2);

        release_unclaimed_copies(&conn, deck.id, LIVE).unwrap();

        let group = group_of(&conn, deck.id);
        assert_eq!(folder_copies(&conn, group, "bolt-m10"), 0);
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-m10"), 2);
    }

    /// A row of 4 against a line of 2 is 2 claimed and 2 surplus. `idx_collection_grain` is
    /// UNIQUE with `folder_id` in it, so this cannot be a folder swap: the row is split.
    #[test]
    fn the_sweep_splits_a_partly_claimed_row() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 2);
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        release_unclaimed_copies(&conn, deck.id, LIVE).unwrap();

        assert_eq!(folder_copies(&conn, group_of(&conn, deck.id), "bolt-lea"), 2);
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-lea"), 2);
    }

    /// The finish axis, which the printing test above cannot reach: the list names the foil and
    /// the group holds the regular copy.
    #[test]
    fn the_sweep_evicts_a_finish_the_list_does_not_name() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add_foil(&conn, deck.id, "bolt-m10", main, 2);
        file_into_group(&conn, deck.id, "bolt-m10", 2);

        release_unclaimed_copies(&conn, deck.id, LIVE).unwrap();

        let group = group_of(&conn, deck.id);
        assert_eq!(folder_copies_of(&conn, group, "bolt-m10", "nonfoil"), 0);
        assert_eq!(
            folder_copies_of(&conn, removed_group(&conn), "bolt-m10", "nonfoil"),
            2
        );
    }

    /// **Custody follows what the list NAMES; the switch decides only what is counted.** A sweep
    /// that read an inactive pile as claiming nothing would turn a display toggle into a press
    /// that moves cardboard out of the reader's deck — the one way this function can be
    /// destructive, so it is pinned here rather than left to the reviewer.
    #[test]
    fn the_sweep_spares_a_switched_off_pile() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", side, 3);
        file_into_group(&conn, deck.id, "bolt-lea", 3);
        // Switch the pile off — copy the call the Categories dialog makes; search the module for
        // an existing test that flips `is_active` and use whatever it uses.
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
            params![side],
        )
        .unwrap();

        release_unclaimed_copies(&conn, deck.id, LIVE).unwrap();

        assert_eq!(
            folder_copies(&conn, group_of(&conn, deck.id), "bolt-lea"),
            3,
            "a switched-off pile still names its cards, so the deck still holds them"
        );
    }

    /// A plan holds no cards, so `theory` is a loop that never runs — `release_live_copies`'
    /// shape, and the reason the guard is inside this function rather than in its two callers.
    #[test]
    fn the_sweep_is_a_loop_that_never_runs_for_theory() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 1);
        file_into_group(&conn, deck.id, "bolt-m10", 1);

        release_unclaimed_copies(&conn, deck.id, THEORY).unwrap();

        assert_eq!(folder_copies(&conn, group_of(&conn, deck.id), "bolt-m10"), 1);
    }

    #[test]
    fn the_sweep_leaves_another_decks_group_alone() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let mine = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let theirs = create_deck(&conn, &input("Angels", "modern")).unwrap();
        add(&conn, mine.id, "bolt-lea", main_of(&conn, mine.id), 1);
        file_into_group(&conn, mine.id, "bolt-lea", 1);
        file_into_group(&conn, theirs.id, "bolt-m10", 2);

        release_unclaimed_copies(&conn, mine.id, LIVE).unwrap();

        assert_eq!(
            folder_copies(&conn, group_of(&conn, theirs.id), "bolt-m10"),
            2,
            "another deck's group is not this sweep's business, however wrong it looks"
        );
    }
```

Add one more for a deck with no group. `create_deck` always makes one, so delete the group row directly (`DELETE FROM collection_folders WHERE deck_id = ?`) and assert the call is `Ok` and moves nothing — the asymmetry `release_group_copies` already has, so a hand-edited database still opens.

- [ ] **Step 9: Run them and watch them fail**

```
cd src-tauri && cargo test --lib deck::tests::the_sweep 2>&1 | tail -30
```

Expected: FAIL to compile — `release_unclaimed_copies` not found.

- [ ] **Step 10: Write `release_unclaimed_copies`**

Put it directly below `release_live_copies`, whose shape it mirrors.

```rust
/// Give back every copy this deck's group holds that its live list does not claim at
/// `(card_id, finish)`.
///
/// **This is the function that makes the exact grain a rule rather than a report.**
/// [`owned_by_printing`] narrowed the count to the printing the list names; on its own that
/// leaves a hole, because two commands rewrite a live row's *identity* and touch no collection
/// table — [`swap_printing`] and [`set_card_finish`]. After *Use this printing* the group still
/// holds the old printing's row, which the new count attributes to nothing and which
/// [`crate::deck_pull::CANDIDATE_SQL`] cannot offer back: it excludes every `kind = 'deck'`
/// folder, this deck's own included. The reader would be looking at a line reading *4 missing*
/// with its four copies filed under that very deck and no press anywhere that reaches them.
///
/// So the copies leave, for `Recently removed` — which `CANDIDATE_SQL` ranks **second**, after
/// the root and before the reader's own folders. The state is not merely correct, it is one the
/// next press of `Import missing cards from collection…` can act on.
///
/// **"Claimed" is every live `deck_cards` row, switched-off piles included**, and reading that
/// the other way would be destructive. [`attribute_owned`] hands an inactive pile no copies, so
/// it is tempting to treat its rows as claiming nothing — but then flipping a category off would
/// evict that pile's cards from the deck, turning a display switch into a press that moves
/// cardboard. Custody follows what the list **names**; the switch decides only what is counted.
/// [`release_live_copies`] already works this way — it filters by `category_id` and never by
/// `category_active`.
///
/// **A sweep rather than a targeted release, because a swap can fold.** `swap_printing` onto a
/// printing the deck already lists merges two rows into one ([`SwapResult::folded`]), so the
/// quantity a targeted [`release_group_copies`] would need is a function of the fold. Reading the
/// finished list against the group answers the plain case and the folded one with one query.
///
/// **The `live` fence is here rather than in the callers**, [`release_live_copies`]' rule: a plan
/// holds no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so `theory` is a loop that
/// never runs, and a rule written down twice is a rule one copy will not have.
///
/// A deck with no group holds nothing rather than refusing, and `Recently removed` is resolved
/// only once there is something to file — both [`release_group_copies`]' asymmetries, so the two
/// behave alike on a hand-edited database.
///
/// Called inside the caller's transaction, [`crate::deck_audit::record`]'s contract: a rolled-back
/// swap must not have moved a card.
pub(crate) fn release_unclaimed_copies(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<(), String> {
    if variant != LIVE {
        return Ok(());
    }
    let Some(group) = deck_group(tx, deck_id)? else {
        return Ok(());
    };

    // What the list names, at the grain custody is now kept at. The deck row's `NULL` finish is
    // the collection row's `'nonfoil'`, resolved in SQL so the two sides of the comparison below
    // are one spelling.
    let nonfoil = crate::schema::FINISHES[0];
    let claimed: HashMap<(String, String), i64> = tx
        .prepare(
            "SELECT card_id, coalesce(finish, ?3), sum(quantity)
               FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2
              GROUP BY card_id, coalesce(finish, ?3)",
        )
        .and_then(|mut s| {
            s.query_map(params![deck_id, LIVE, nonfoil], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;

    let held: Vec<(String, String, i64)> = tx
        .prepare(
            "SELECT card_id, finish, sum(quantity)
               FROM collection_entries
              WHERE folder_id = ?1
              GROUP BY card_id, finish",
        )
        .and_then(|mut s| {
            s.query_map(params![group], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .map_err(|e| e.to_string())?;

    for (card_id, finish, have) in held {
        let want = claimed
            .get(&(card_id.clone(), finish.clone()))
            .copied()
            .unwrap_or(0);
        let mut surplus = have - want;
        if surplus <= 0 {
            continue;
        }
        // Resolved only when there is something to file — a hand-edited database missing the
        // folder still opens, and a deck with nothing surplus never asks for it.
        let removed = removed_group(tx)?
            .ok_or_else(|| crate::collection_alloc::NO_REMOVED_FOLDER.to_owned())?;
        // Oldest row first — `take_copies`' rule and `release_group_copies`'. `id` is the
        // primary key, so the walk is total.
        let rows: Vec<(i64, i64)> = tx
            .prepare(
                "SELECT id, quantity FROM collection_entries
                  WHERE folder_id = ?1 AND card_id = ?2 AND finish = ?3
                  ORDER BY id",
            )
            .and_then(|mut s| {
                s.query_map(params![group, card_id, finish], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect()
            })
            .map_err(|e| e.to_string())?;
        for (id, row_held) in rows {
            if surplus <= 0 {
                break;
            }
            let take = row_held.min(surplus);
            // **The move is `take_copies`' and is not written a second time** —
            // `collection_alloc`'s first rule. It splits the row where the take is partial and
            // folds the travelling half into whatever `Recently removed` already holds at that
            // grain, which `idx_collection_grain` (UNIQUE, `folder_id` included) requires.
            crate::collection_folders::take_copies(tx, id, take, Some(removed))?;
            surplus -= take;
        }
    }
    Ok(())
}
```

- [ ] **Step 11: Run the sweep tests**

```
cd src-tauri && cargo test --lib deck::tests::the_sweep 2>&1 | tail -30
cd src-tauri && cargo test --lib deck::tests::a_deck_with_no_group 2>&1 | tail -20
```

Expected: PASS, with a non-zero run count on each.

- [ ] **Step 12: Write the failing tests for the two callers**

```rust
    /// **The live defect the exact grain would otherwise open.** *Use this printing* rewrites the
    /// row's identity and touches no collection table, so without the sweep the LEA copies would
    /// sit in this deck's own group claimed by nothing — and `deck_pull::CANDIDATE_SQL` excludes
    /// every deck group, so no press anywhere could reach them.
    #[test]
    fn use_this_printing_sends_the_old_printings_copies_back() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        file_into_group(&conn, deck.id, "bolt-lea", 4);

        swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap();

        assert_eq!(folder_copies(&conn, group_of(&conn, deck.id), "bolt-lea"), 0);
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-lea"), 4);
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-m10", main),
            0,
            "the deck now lists a printing it does not hold, and says so"
        );
    }

    /// Swapping onto a printing the deck already lists merges the two rows
    /// ([`SwapResult::folded`]). The M10 copies are still claimed by the merged line; only the
    /// LEA ones are surplus — which is why the sweep reads the finished list rather than
    /// releasing a quantity worked out from the swap.
    #[test]
    fn a_folded_swap_evicts_only_the_printing_that_left() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-m10", main, 2);
        file_into_group(&conn, deck.id, "bolt-lea", 4);
        file_into_group(&conn, deck.id, "bolt-m10", 2);

        let result = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap();
        assert!(result.folded, "the fixture is the folded case or this proves nothing");

        let group = group_of(&conn, deck.id);
        assert_eq!(folder_copies(&conn, group, "bolt-m10"), 2);
        assert_eq!(folder_copies(&conn, group, "bolt-lea"), 0);
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-lea"), 4);
    }

    /// The same hole one axis over. `bolt-m10` is the printing `seeded()` sells in both finishes,
    /// so `FINISH_NOT_SOLD` does not refuse this.
    #[test]
    fn changing_a_rows_finish_sends_the_old_finishs_copies_back() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-m10", main, 2);
        file_into_group(&conn, deck.id, "bolt-m10", 2);

        set_card_finish(&conn, deck.id, "bolt-m10", main, LIVE, None, Some("foil")).unwrap();

        let group = group_of(&conn, deck.id);
        assert_eq!(folder_copies_of(&conn, group, "bolt-m10", "nonfoil"), 0);
        assert_eq!(
            folder_copies_of(&conn, removed_group(&conn), "bolt-m10", "nonfoil"),
            2
        );
    }
```

**Read `swap_printing`'s and `set_card_finish`'s real signatures before writing these calls** and match the argument order to the function, not to this sketch. `SwapResult`'s field is `folded`.

- [ ] **Step 13: Run them and watch them fail**

```
cd src-tauri && cargo test --lib deck::tests::use_this_printing deck::tests::a_folded_swap deck::tests::changing_a_rows_finish 2>&1 | tail -30
```

Expected: FAIL — the copies are still in the group.

- [ ] **Step 14: Call the sweep from both commands**

In `swap_printing` and in `set_card_finish`, after every `deck_cards` write and **before** `tx.commit()` (put it directly above the `crate::deck_audit::record(` call in each, so the audit and undo rows are the last thing written):

```rust
    // The line's identity changed and the group did not follow it, which is the hole the exact
    // grain opens: `deck_cards` is rewritten here and no collection table is touched, so the old
    // printing's copies would sit in this deck's group claimed by nothing — and
    // `deck_pull::CANDIDATE_SQL` excludes every deck group, so no press could reach them. The
    // sweep is a no-op on `theory` and on a deck holding exactly what it lists.
    release_unclaimed_copies(&tx, deck_id, variant)?;
```

- [ ] **Step 15: Run the caller tests**

```
cd src-tauri && cargo test --lib deck::tests::use_this_printing deck::tests::a_folded_swap deck::tests::changing_a_rows_finish 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 16: Narrow `release_group_copies`**

Replace its `backing` query. The three-armed `ORDER BY CASE` and the `OR c.oracle_id = …` go; the `LEFT JOIN cards` goes with them.

```rust
    let backing: Vec<(i64, i64)> = tx
        .prepare(
            "SELECT id, quantity FROM collection_entries
              WHERE folder_id = ?1 AND card_id = ?2 AND finish = ?3
              ORDER BY id",
        )
        .and_then(|mut s| {
            s.query_map(params![group, card_id, entry_finish], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;
```

Rewrite its `# It matches on the **oracle card**…` section to:

```
/// # It matches the printing and the finish exactly, and the fallback that is gone
///
/// This query had three arms until 2026-09-07: the exact `(card_id, finish)`, then any row in
/// the group with the same `card_id`, then any row sharing an `oracle_id`. The two fallbacks
/// existed to cure a stranding — `deck_swap_printing` and `set_card_finish` rewrite a row's
/// identity and touch no collection table, so an exact match found nothing and the copies stayed
/// filed under a deck that no longer listed them.
///
/// [`release_unclaimed_copies`] cures that at the source now: both commands sweep the group as
/// they finish, so a copy the list does not name is never in it to be stranded. And under the
/// exact grain the fallbacks are a **bug** rather than a safety net — a deck may legitimately
/// list LEA Bolt *and* M10 Bolt with the group holding both, and cutting the LEA line while its
/// own rows come up short would give back M10 copies the M10 line still claims. The second arm
/// is the same bug one axis over, in the finish.
```

- [ ] **Step 17: Write and run the test that pins it**

```rust
    /// A deck may legitimately list two printings of one card with the group holding both. The
    /// old third arm matched on `oracle_id`, so cutting the LEA line while its own copies were
    /// absent gave back an M10 copy the M10 line still claims — the bug the fallback becomes
    /// once `release_unclaimed_copies` cures the stranding it was written for.
    #[test]
    fn a_release_never_reaches_a_sibling_printing() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 1);
        add(&conn, deck.id, "bolt-m10", main, 1);
        file_into_group(&conn, deck.id, "bolt-m10", 1);

        let released = release_group_copies(&conn, deck.id, "bolt-lea", None, 1).unwrap();

        assert_eq!(released.moved, 0);
        assert_eq!(folder_copies(&conn, group_of(&conn, deck.id), "bolt-m10"), 1);
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-m10"), 0);
    }
```

```
cd src-tauri && cargo test --lib deck:: collection_alloc:: 2>&1 | tail -40
```

Expected: PASS across both modules. Any remaining failure is a test whose fixture assumed cross-printing attribution — fix the **fixture**, never the code.

- [ ] **Step 18: Mutation check**

Break each new behaviour on purpose and confirm a test catches it: (a) make `attribute_owned` ignore the finish half of the key — `the_exact_printing_and_finish_is_owned`'s sibling must go red; (b) make `release_unclaimed_copies` treat an inactive pile as claiming nothing — `the_sweep_spares_a_switched_off_pile` must go red; (c) drop the `variant != LIVE` guard — the theory test must go red. Revert all three.

- [ ] **Step 19: Format and report**

```
cd src-tauri && cargo fmt && cargo clippy --lib 2>&1 | tail -20
```

`npm run verify` does **not** run `fmt` or `clippy`; CI does, and they are the only reds a green verify can still produce. Report the functions you added, the tests you added, and every test you had to re-point, with its old and new assertion. **Do not commit.**

---

### Task 2: The v35 migration rung

**Files:**
- Modify: `src-tauri/src/schema.rs` — `USER_SCHEMA_VERSION` (313), a new `if v < 35 { … }` block below the `if v < 34` one (~4856), and the fixture/test sections at the end of the file
- Test: `schema.rs`'s inline `#[cfg(test)]` module

**Interfaces:**
- Consumes: nothing from another task. **The rung is self-contained by rule** — it must not call `crate::deck::release_unclaimed_copies` or `crate::collection_folders::take_copies`.
- Produces: `USER_SCHEMA_VERSION = 35`. Task 5 documents it.

Read `docs/superpowers/specs/2026-09-07-exact-grain-ownership-and-collection-import-design.md` §3 first, then read the `if v < 34` rung and the v33/v34 fixture tests to copy their shape exactly.

- [ ] **Step 1: Write the failing rung tests**

Build a **real v34 fixture** the way the existing ones are built (find `user_file_at_31` and its siblings; there is an established rewind-from-head pattern — use it, do not hand-write DDL). The fixture holds one deck with a group carrying: a copy the deck's live list names at `(card_id, finish)`, a copy of a different printing, a copy of the right printing in the wrong finish, and a row of 4 against a line of 2. A second deck's group holds one mismatched copy.

```rust
#[test]
fn the_v35_rung_evicts_what_the_list_does_not_name() {
    let conn = user_file_at_34();
    assert_eq!(user_version(&conn), 34, "the fixture is a v34 file");

    migrate_user(&conn).unwrap();

    assert_eq!(user_version(&conn), 35);
    assert_eq!(in_group(&conn, DECK_A, "bolt-lea", "nonfoil"), 2, "named, kept");
    assert_eq!(in_group(&conn, DECK_A, "bolt-m10", "nonfoil"), 0, "wrong printing, gone");
    assert_eq!(in_group(&conn, DECK_A, "bolt-lea", "foil"), 0, "wrong finish, gone");
    assert_eq!(in_removed(&conn, "bolt-m10", "nonfoil"), 1);
    assert_eq!(in_removed(&conn, "bolt-lea", "foil"), 1);
}

#[test]
fn the_v35_rung_splits_a_partly_claimed_row() {
    let conn = user_file_at_34();
    migrate_user(&conn).unwrap();
    // The line names 2 and the group's single row held 4.
    assert_eq!(in_group(&conn, DECK_A, "swamp", "nonfoil"), 2);
    assert_eq!(in_removed(&conn, "swamp", "nonfoil"), 2);
}

#[test]
fn the_v35_rung_reaches_every_deck() {
    let conn = user_file_at_34();
    migrate_user(&conn).unwrap();
    assert_eq!(in_group(&conn, DECK_B, "island", "nonfoil"), 0);
    assert_eq!(in_removed(&conn, "island", "nonfoil"), 1);
}

#[test]
fn the_v35_rung_folds_into_a_row_recently_removed_already_holds() {
    // `idx_collection_grain` is UNIQUE with `folder_id` in it, so a bare folder update would
    // hit the constraint. The rung merges.
    let conn = user_file_at_34_with_a_matching_removed_row();
    migrate_user(&conn).unwrap();
    assert_eq!(in_removed(&conn, "bolt-m10", "nonfoil"), 3);
}

#[test]
fn the_v34_fixture_carries_none_of_v35() {
    // The mirror of `the_v33_fixture_carries_none_of_v34`: prove the fixture really sits below
    // the rung under test, or every assertion above is vacuous.
    let conn = user_file_at_34();
    assert!(in_group(&conn, DECK_A, "bolt-m10", "nonfoil") > 0);
}
```

- [ ] **Step 2: Run them and watch them fail**

```
cd src-tauri && cargo test --lib schema::tests::the_v35 schema::tests::the_v34_fixture 2>&1 | tail -30
```

Expected: FAIL. Confirm the summary names a non-zero run count.

- [ ] **Step 3: Bump the version**

`pub const USER_SCHEMA_VERSION: i64 = 35;`

- [ ] **Step 4: Write the rung**

Below the `if v < 34` block. The kinds are **literals**, and the arithmetic is the rung's own.

```rust
    // v35: a deck's group holds only what its live list claims at (card_id, finish).
    //
    // `deck::owned_by_printing` narrowed the count from the oracle card to the printing, so a
    // deck now reads as short of the exact object its list names. The v25 conversion filed
    // placements by matching the old allocator's claims **across** printings — its own doc says
    // it "routinely files a printing the deck does not list" — so an upgraded file is full of
    // copies the new count attributes to nothing and which `deck_pull::CANDIDATE_SQL` cannot
    // offer back, because it excludes every `kind = 'deck'` folder including the deck's own.
    // This is the one-time pass that brings those files under the rule.
    //
    // **They land in `Recently removed`, and that is chosen rather than convenient**: it is
    // ranked second in `CANDIDATE_SQL`, after the root and before the reader's own folders, so
    // the first press of `Import missing cards from collection…` offers every one of them back
    // for the lines that genuinely match. A reader is left with a state they can act on.
    //
    // **Spelled out literally and calling no app code.** `'deck'` and `'removed'` are written
    // out rather than read from `COLLECTION_FOLDER_KINDS`, and the split below is this rung's
    // own rather than `collection_folders::take_copies`. A migration step is history the day it
    // ships: a constant that is reordered, or a helper whose rules change, would silently
    // convert a v34 file differently next year. v25's rung inlines the same arithmetic for the
    // same reason.
    //
    // **A missing `Recently removed` folder skips the move rather than failing the rung.** A
    // rung that errors blocks startup, and a hand-edited file without that folder must open.
    if v < 35 {
        let tx = conn.unchecked_transaction()?;

        // `None` skips the move and still stamps the version — a hand-edited file with no
        // holding area must open, and a rung that errors blocks startup.
        let removed: Option<i64> = tx
            .query_row(
                "SELECT id FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(removed) = removed {
            // Every copy in a deck group that its deck's **live** list does not name at
            // `(card_id, finish)`, oldest row first.
            //
            // **`claimed` sums every live row, switched-off piles included.** Custody follows
            // what the list *names*; `is_active` decides only what is counted. Reading it the
            // other way would make this rung empty every reader's Maybeboard into the holding
            // area on upgrade — the one way this can be destructive.
            //
            // The deck row's `NULL` finish is the collection row's `'nonfoil'`, resolved in SQL
            // so both sides of the comparison are one spelling.
            let surplus: Vec<(i64, i64)> = {
                let mut stmt = tx.prepare(
                    "SELECT e.id,
                            e.quantity - max(0, coalesce((
                              SELECT sum(d.quantity) FROM deck_cards d
                               WHERE d.deck_id = f.deck_id
                                 AND d.variant = 'live'
                                 AND d.card_id = e.card_id
                                 AND coalesce(d.finish, 'nonfoil') = e.finish
                            ), 0) - coalesce((
                              SELECT sum(p.quantity) FROM collection_entries p
                               WHERE p.folder_id = e.folder_id
                                 AND p.card_id = e.card_id
                                 AND p.finish = e.finish
                                 AND p.id < e.id
                            ), 0))
                       FROM collection_entries e
                       JOIN collection_folders f ON f.id = e.folder_id
                      WHERE f.kind = 'deck'
                      ORDER BY e.id",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };

            for (entry_id, take) in surplus {
                // The rows before this one in the same group already soaked up the claim, so
                // `take` is what is left over on **this** row: `0` or less means fully claimed.
                if take <= 0 {
                    continue;
                }
                let (held, offered): (i64, i64) = tx.query_row(
                    "SELECT quantity, tradelist_quantity FROM collection_entries WHERE id = ?1",
                    params![entry_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                let take = take.min(held);
                // **The trade list is split, never copied** — v25's rung's clamp, and its
                // reason: carrying the number onto both halves would have the reader promising
                // twice the copies they hold, and no CHECK ties the two columns.
                let moved_trade = offered.min(take);
                let kept_trade = (offered - moved_trade).min(held - take);

                // **The placement carries every grain column and every column that is the row's
                // story** — v25's rung's insert, verbatim, for its reason: these are the same
                // physical cards, bought on the same day for the same money, and a bare row
                // would be the upgrade quietly deleting a history that took years to build.
                // `ON CONFLICT` is the eleven-term grain `idx_collection_grain` builds, and the
                // `DO UPDATE` sums the trade list beside the quantity because two rows that
                // merge are one pile.
                tx.execute(
                    "INSERT INTO collection_entries
                         (card_id, set_code, collector_number, lang, finish, condition,
                          condition_original, quantity, tradelist_quantity, purchase_price,
                          purchase_currency, acquired_at, acquisition_source, serial_number,
                          altered, signed, proxy, misprint, grading, tags, notes, needs_review,
                          folder_id, created_at, updated_at)
                     SELECT card_id, set_code, collector_number, lang, finish, condition,
                            condition_original, ?2, ?4, purchase_price,
                            purchase_currency, acquired_at, acquisition_source, serial_number,
                            altered, signed, proxy, misprint, grading, tags, notes, needs_review,
                            ?3, created_at, unixepoch()
                       FROM collection_entries WHERE id = ?1
                     ON CONFLICT (card_id, finish, condition, lang, altered, signed, proxy,
                                  misprint, coalesce(serial_number, ''), coalesce(grading, ''),
                                  coalesce(folder_id, 0))
                     DO UPDATE SET quantity = quantity + excluded.quantity,
                                   tradelist_quantity = tradelist_quantity
                                                        + excluded.tradelist_quantity,
                                   updated_at = unixepoch()",
                    params![entry_id, take, removed, moved_trade],
                )?;
                // The source loses exactly what left it, and is deleted at zero rather than
                // left standing empty — v24's rule: with the folder in the grain, a row holding
                // no copies is indistinguishable from one somebody filed and emptied.
                tx.execute(
                    "UPDATE collection_entries
                        SET quantity = quantity - ?2, tradelist_quantity = ?3,
                            updated_at = unixepoch()
                      WHERE id = ?1",
                    params![entry_id, take, kept_trade],
                )?;
                tx.execute(
                    "DELETE FROM collection_entries WHERE id = ?1 AND quantity = 0",
                    params![entry_id],
                )?;
            }
        }

        tx.execute_batch("PRAGMA main.user_version = 35;")?;
        tx.commit()?;
    }
```

Two things to check against the file before you trust the SELECT above:

- **`sync_uid`.** The insert copies v25's column list, which does not name it. Confirm what v25's rung leaves it as and match — if a placement needs a fresh uid, it is `NULL` here and the sync assigns one, and the `ON CONFLICT` path never inserts at all. Whatever v25 does, do the same and say so in a comment.
- **The running-total subquery** (`p.id < e.id`) is what makes a multi-row group split correctly: each row is charged against the claim only after the older rows in its own group have taken their share. Write a test for two rows of 2 against a line of 3 — the older row keeps 2, the newer keeps 1 and gives up 1.

- [ ] **Step 5: Run the rung tests**

```
cd src-tauri && cargo test --lib schema::tests::the_v35 schema::tests::the_v34_fixture 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 6: Run the whole schema module**

```
cd src-tauri && cargo test --lib schema:: 2>&1 | tail -40
```

Expected: PASS. `the_user_schema_is_byte_identical_to_what_the_ladder_builds` must still hold — this rung moves **data**, not shape, so it adds no DDL and `USER_SCHEMA_SQL` is untouched. If that test fails you have added DDL you did not mean to.

- [ ] **Step 7: Mutation check**

Make the rung count only *active* categories as claiming, and confirm a test goes red (add one if none does — a switched-off pile's copies surviving the upgrade is the assertion). Revert.

- [ ] **Step 8: Format and report**

```
cd src-tauri && cargo fmt && cargo clippy --lib 2>&1 | tail -20
```

Report the rung, the fixture you added, and the tests. **Do not commit.**

---

### Task 3: The settings dialog's section and button

**Files:**
- Modify: `src/features/decks/DeckSettingsDialog.tsx`
- Modify: `src/features/decks/DeckSettingsDialog.test.tsx`
- Modify: `src/features/decks/DeckSettingsDialog.stories.tsx`

**Interfaces:**
- Consumes, all existing and unchanged: `PullFromCollectionDialog` from `./PullFromCollectionDialog` (props: `rows`, `loading`, `readError`, `open`, `onDismiss`, `onClose`, and a write — **read the component's own props interface and match it exactly**); `usePullPlan` / `pullPlanQuery` from `./useDeck`; `ipc.deckPullFromCollection`; `RowAction` from `./metaRows`.
- Produces: nothing another task consumes.

Read `src/features/decks/CLAUDE.md` and `src/CLAUDE.md` before starting. Read `DeckEditor.tsx`'s `openPull` wiring (~2050) and its `PullFromCollectionDialog` mount to see how the existing entrance passes rows and the write — copy that wiring rather than inventing one.

- [ ] **Step 1: Write the failing tests**

In `DeckSettingsDialog.test.tsx`, following the file's existing setup (it already renders the dialog against a mocked `ipc`):

```tsx
it("offers the import when the deck is short of something it owns", async () => {
  // one plan row, so the button is live
  renderSettings({ pullRows: [aPullRow()] });
  expect(
    await screen.findByRole("button", { name: "Import missing cards from collection…" }),
  ).toBeEnabled();
});

it("carries its reason in the name when there is nothing to import", async () => {
  // The rule the two Clear buttons beside it follow: a greyed control whose name is the bare
  // label reads as a control that is missing rather than one with nothing to do.
  renderSettings({ pullRows: [] });
  const button = await screen.findByRole("button", {
    name: "Import missing cards from collection… (nothing to import)",
  });
  expect(button).toBeDisabled();
});

it("opens the pull dialog over the settings dialog", async () => {
  const user = userEvent.setup();
  renderSettings({ pullRows: [aPullRow()] });
  await user.click(
    await screen.findByRole("button", { name: "Import missing cards from collection…" }),
  );
  expect(await screen.findByRole("dialog", { name: /pull/i })).toBeInTheDocument();
});

it("Escape closes the pull first and leaves the settings open", async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn();
  renderSettings({ pullRows: [aPullRow()], onDismiss });
  await user.click(
    await screen.findByRole("button", { name: "Import missing cards from collection…" }),
  );
  await user.keyboard("{Escape}");
  expect(onDismiss).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(onDismiss).toHaveBeenCalledOnce();
});
```

Match the pull dialog's real accessible name — read `PullFromCollectionDialog`'s `Dialog` title and use it, rather than the `/pull/i` placeholder above.

**Do not press Escape with `window.dispatchEvent`.** `useDismissOnEscape` orders its capture rung by a mount-order stack, and a synthetic window event collapses that into registration order — the test would pass on a broken ladder. `userEvent.keyboard` is the only honest form here.

- [ ] **Step 2: Run them and watch them fail**

```
npx vitest run src/features/decks/DeckSettingsDialog.test.tsx 2>&1 | tail -30
```

Expected: FAIL — no such button.

- [ ] **Step 3: Add the section**

Directly **above** the `Empty a list` block, matching its markup exactly (`mt-5 border-t border-border pt-4`, an `h3.text-xs`, one `mt-1 text-[0.6875rem] leading-relaxed text-dim` paragraph, then the control):

```tsx
{/* **The other direction from `Empty a list`, and it sits above it because it is the
    constructive half.** A deck reads *N missing* and some of those copies are already on
    the reader's desk; this is the press that files them into the deck's folder without
    spending anything. It is the third entrance to `PullFromCollectionDialog` — the stats
    band's button and a deck card's `Collection ▸ Pull …` are the other two — and it earns
    its place here because the other two live in the **editor**, and this dialog opens from
    the gallery as well.

    **Mounted nested rather than handed up to `DeckEditor`'s `Layer` union**, which is
    forced rather than chosen: this file has three hosts and two of them have no editor
    and no layer to hand it to. `useDismissOnEscape`'s capture stack is innermost-last by
    mount order and was built for a layer opened over an open dialog, so one Escape closes
    the pull and the next closes this. `Dialog` is `fixed inset-0` and unportalled, and the
    nested one renders later in the tree, so it paints above with no z-index of its own. */}
<div className="mt-5 border-t border-border pt-4">
  <h3 className="text-xs">Fill this deck from your collection</h3>
  <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
    Copies you already own move into this deck&rsquo;s folder. Nothing is added to the list
    and nothing is bought.
  </p>
  <div className="mt-2.5">
    <RowAction
      ref={importTrigger}
      disabled={pullRows.length === 0 || pullLoading}
      onClick={() => setImporting(true)}
    >
      {pullRows.length === 0
        ? "Import missing cards from collection… (nothing to import)"
        : "Import missing cards from collection…"}
    </RowAction>
  </div>
</div>
```

The small print states the one thing a reader here has not seen: this writes no `deck_cards` row. `PullFromCollectionDialog`'s own footer says it too, but that footer is behind the press.

- [ ] **Step 4: Wire the plan and the dialog**

Use `usePullPlan(deckId)` (read its signature in `useDeck.ts` — if it takes an `enabled`/open flag, pass the dialog's `open` so a closed settings dialog costs no `deck_pull_plan`). Mount `PullFromCollectionDialog` at the end of the `{row && (…)}` block, gated on `importing`, returning focus to `importTrigger` on dismiss the way the `ClearDeck` triggers already do in this file.

Match `DeckEditor`'s mount for the write and the invalidation — same command, same outcome handling. Do not add a second mutation shape.

- [ ] **Step 5: Run the tests**

```
npx vitest run src/features/decks/DeckSettingsDialog.test.tsx 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 6: Add a story**

In `DeckSettingsDialog.stories.tsx`, following the file's existing stories and `.storybook/CLAUDE.md`: one story with a plan that has rows, one with an empty plan showing the disabled name. Use the fake's seeds — do not hand-build a db.

**Do not run the story-play suite.** `stories.test.tsx` collects the whole tree and will fail on siblings' half-finished work. Type-check your file only:

```
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i decksettings
```

Expected: no output. (IDE diagnostics lag mid-fan-out; `tsc` is the authority.)

- [ ] **Step 7: Mutation check**

Make the disabled arm render the bare label without `(nothing to import)` and confirm the second test goes red. Revert.

- [ ] **Step 8: Report**

Report the props you actually passed to `PullFromCollectionDialog` (its real interface), and whether `usePullPlan` needed a gate. **Do not commit.**

---

### Task 4: The Storybook fake follows the same grain

**Files:**
- Modify: `.storybook/fake/db.ts` — the module header (~line 9), `ownedByOracle` (~4744), `attributeOwned` (~4892), the doc at ~4949, and the `deck_get` call site (~6563)
- Modify: `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes: the spec's §1. This task mirrors Task 1's behaviour in TypeScript; the two are checked against each other by nothing but this plan, so read Task 1's `attribute_owned` above and match it exactly.
- Produces: nothing another task consumes.

Read `.storybook/CLAUDE.md` first. The fake exists so a story teaches the model the app actually has — a fake left at the oracle grain would make every deck story show a count the shipped app does not produce.

- [ ] **Step 1: Write the failing tests**

In `db.test.ts`, beside the existing attribution tests. The file already has everything these need: `makeDeckDb(init)`, `deckCard(...)`, `entry(over)`, `groupId(deckId)`, `liveDeck(db, id)`, and — the key fixture — `BOLT_A` / `BOLT_B`, which are two printings sharing one `oracleId` (`const [BOLT_A, BOLT_B] = CARDS.filter((c) => c.oracleId === BOLT.oracleId)`). Read `makeDeckDb`'s signature and the neighbouring attribution tests and follow their shape exactly.

```ts
it("does not count a different printing of the same card", () => {
  // The narrowing's whole point: the group holds BOLT_B and the list names BOLT_A. The two
  // share an oracle id, which is exactly what the old grain matched on.
  const db = makeDeckDb({
    deckCards: [deckCard({ cardId: BOLT_A.id, quantity: 4 })],
    collectionEntries: [
      entry({ id: 1, cardId: BOLT_B.id, quantity: 4, folderId: groupId(1) }),
    ],
  });
  expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(0);
});

it("does not count a different finish of the same printing", () => {
  const db = makeDeckDb({
    deckCards: [deckCard({ cardId: BOLT_A.id, finish: "foil", quantity: 2 })],
    collectionEntries: [
      entry({ id: 1, cardId: BOLT_A.id, finish: "nonfoil", quantity: 2, folderId: groupId(1) }),
    ],
  });
  expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(0);
});

it("counts the exact printing and finish", () => {
  // A deck row's null finish is a collection row's "nonfoil" — the translation, in the fake.
  const db = makeDeckDb({
    deckCards: [deckCard({ cardId: BOLT_A.id, quantity: 4 })],
    collectionEntries: [
      entry({ id: 1, cardId: BOLT_A.id, finish: "nonfoil", quantity: 3, folderId: groupId(1) }),
    ],
  });
  expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(3);
});

it("counts a foil line against foil copies", () => {
  const db = makeDeckDb({
    deckCards: [deckCard({ cardId: BOLT_A.id, finish: "foil", quantity: 2 })],
    collectionEntries: [
      entry({ id: 1, cardId: BOLT_A.id, finish: "foil", quantity: 2, folderId: groupId(1) }),
    ],
  });
  expect(liveDeck(db)!.cards[0].ownedQuantity).toBe(2);
});
```

If `deckCard` takes no `finish`, add it — a fake that cannot express a foil deck row cannot mirror the new grain at all, and that is this task's subject. Check `FakeDeckCard`'s shape against `DeckCardRow` first.

- [ ] **Step 2: Run them and watch them fail**

```
npx vitest run .storybook/fake/db.test.ts 2>&1 | tail -30
```

Expected: the first two FAIL reading the full quantity.

- [ ] **Step 3: Re-key the fake**

Rename `ownedByOracle` → `ownedByPrinting`, key its `Map` on a `\`${cardId}\u0000${finish}\`` string (a two-field tuple is not a usable `Map` key in JS — use a separator that cannot occur in either field, and say so in a comment). `attributeOwned` builds the same key from `card.cardId` and `card.finish ?? "nonfoil"`, and its `variant`/`categoryActive` guards are unchanged. Update the call site in `deck_get`.

- [ ] **Step 4: Update the two docs that state the old grain**

The module header's line reading `` `ownedQuantity` … on `DeckCard` it is what this deck's **own group** physically holds — oracle-grained, finish-blind, condition-blind `` becomes printing-and-finish-grained, still condition-blind, and says the count now agrees with `deck_pull_plan`. The doc at ~4949 that reads "the deck's owned count is attributed at the **oracle** grain — `ownedByOracle` keys on …" is rewritten the same way. Keep the "Rust file named is the behaviour" convention: point at `deck::owned_by_printing`.

- [ ] **Step 5: Run the tests**

```
npx vitest run .storybook/fake/db.test.ts 2>&1 | tail -30
```

Expected: PASS. Other tests in this file that assumed the oracle grain fail — fix each **fixture**, and where a test's subject was cross-printing attribution, invert it and rename it.

- [ ] **Step 6: Type-check**

```
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "storybook/fake"
```

Expected: no output.

- [ ] **Step 7: Mutation check**

Drop the finish from the key and confirm "does not count a different finish" goes red. Revert.

- [ ] **Step 8: Report**

Report the rename, every test you re-pointed, and any story you believe now shows a different number (name it — do not edit it; stories belong to Task 3 and to nobody else here). **Do not commit.**

---

### Task 5: The record — docs and the stale doc comments

**Files:**
- Modify: `docs/reference/decks-storage.md`
- Modify: `docs/reference/collection-folders.md`
- Modify: `src-tauri/CLAUDE.md`
- Modify (**doc comments only — change no code, no test, no SQL**): `src-tauri/src/deck_pull.rs`, `src-tauri/src/deck_quick_add.rs`, `src-tauri/src/collection_source.rs`, `src/lib/ipc.ts`

**Interfaces:**
- Consumes: the spec, which is the source for every claim here. Do not measure anything; do not run the app.
- Produces: nothing another task consumes.

**You own no logic.** If a doc comment you are rewriting sits above code you think is wrong, say so in your report and leave it.

- [ ] **Step 1: Fix the doc comments that now state the wrong rule**

- `src-tauri/src/deck_pull.rs` — the module header's third bullet (~line 51) argues the pull's exact matching is "a deliberate narrowing … this fills strictly *fewer* holes than the app itself would count", naming `owned_by_oracle`'s "a Bolt is a Bolt". That premise is gone: **the count came down to meet the pull.** Rewrite the bullet to say the two now agree at `(card_id, finish)`, that this is why the trade it describes no longer costs anything, and keep the sentence about never moving a card the list did not name. Check the header's other paragraphs for the same premise — the "four rules" list and the empty-plan argument both lean on it, and the empty-plan paragraph's "a deck that reads *12 missing* can legitimately have nothing to pull" is now **false** and must go.
- `src-tauri/src/deck_quick_add.rs` (~622) and `src-tauri/src/collection_source.rs` (~151) — check each "a Bolt is a Bolt" in context. Both may be about a *different* question (a collection-wide owned badge, a sync uid scheme) and correctly unchanged. Change only the ones that are about a **deck's** owned count, and say in your report which you left and why.
- `src/lib/ipc.ts` (~3200–3208) — the `DeckCard.ownedQuantity` doc says the count "is `owned_by_oracle` — `sum(quantity)` per `cards.oracle_id` over that one folder" and "oracle-grained (a Bolt is a Bolt), finish-blind". Rewrite for the new grain: `owned_by_printing`, `sum(quantity)` per `(card_id, finish)` over that folder, finish-**aware**, still condition-blind. **Touch no type.**

- [ ] **Step 2: `docs/reference/decks-storage.md`**

Update the section on how owned/missing is answered. It must now record: the grain is `(card_id, finish)`; the change date (2026-09-07) and the reason (the count and `deck_pull_plan` disagreed by construction, so a deck could read *N missing* with nothing to pull); that an orphaned printing now counts where it used to read 0; that the group is kept honest by `release_unclaimed_copies`, called from `swap_printing` and `set_card_finish`; that `release_group_copies` lost its oracle fallback and why that fallback would now be a bug; and the residual — a device on an older build can still sync a mismatched placement, the sweep is idempotent, and nothing runs it on a sync.

- [ ] **Step 3: `docs/reference/collection-folders.md`**

Add the honesty rule — *a deck's group holds only what its live list claims at `(card_id, finish)`* — with: what "claims" means (every live `deck_cards` row, switched-off piles included, because custody follows what the list names and reading it otherwise would make a display switch move cardboard); what the v35 rung did to existing files; and why the copies land in `Recently removed` rather than the root (it is ranked second in `CANDIDATE_SQL`, so the first press of the new button offers them back).

- [ ] **Step 4: `src-tauri/CLAUDE.md`**

Update the schema ladder's head to 35 and add the one-line description of what the rung does. Follow the file's existing format for a rung entry exactly.

- [ ] **Step 5: Re-count anything you touched**

A prose-only edit routes to neither CI job, so nothing goes red when a document rots. If any list or count in a section you edited changed, re-count it in the same edit. Add no new count that a build could answer.

- [ ] **Step 6: Verify you changed no code**

```
git diff --stat -- src-tauri/src/deck_pull.rs src-tauri/src/deck_quick_add.rs src-tauri/src/collection_source.rs src/lib/ipc.ts
git diff -U0 -- src-tauri/src/deck_pull.rs src-tauri/src/deck_quick_add.rs src-tauri/src/collection_source.rs src/lib/ipc.ts | grep -E "^[+-]" | grep -vE "^[+-]{3}" | grep -vE "^[+-]\s*(///|//!|//|\*|/\*)" 
```

Expected: the second command prints **nothing**. Anything it prints is a non-comment line you changed — revert it.

- [ ] **Step 7: Report**

List every file, and for each "a Bolt is a Bolt" you found, whether you changed it and why. **Do not commit.**

---

## After fan-in — the orchestrator's steps

- [ ] Read every subagent report. Reconcile any file two agents claim to have touched.
- [ ] `npm run verify` — **once**, not piped through `tail` (its exit code lies through a pipe; redirect to a file and read that, then check `$LASTEXITCODE`). Never run two verifies at once.
- [ ] `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings` — verify runs neither, and CI runs both.
- [ ] Fix whatever is red. A test that asserted cross-printing attribution is fixed by re-pointing its fixture, never by widening the code.
- [ ] Prove the migration on a **copy** of the real dev db (`src-tauri/target/debug/data/user.db`) — a worktree is a fresh install and can never show an upgrade bug. Copy the whole `data` folder, launch against it, confirm the rung runs once and the decks read sensibly.
- [ ] Live pass per `docs/reference/live-ui-verification.md`: open a deck's settings from the editor **and** from the gallery, press the button, confirm the pull, watch the missing count move. Take the app lock first (`running-the-app` skill).
- [ ] Commit in coherent pieces (`feat:`/`fix:`/`test:`/`docs:`), then ship with the `auto-pr` skill.
