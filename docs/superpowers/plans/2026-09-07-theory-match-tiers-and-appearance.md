# Two theory match tiers and an Appearance tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the deckbuilder's theory mark in two tiers — green where the live row is the planned
printing, blue where it is the same card in another printing — make each tier switchable per deck,
and give the reader an Appearance group in Settings that owns both colours and the app-wide label
list.

**Architecture:** Rust's `theory_slots` gains a second key (the card's name, verbatim) so the plan
can be looked up at two grains; `theoryMatch.ts` folds both grains plus the deck's two switches
into one `theoryMatchMark()` that answers a tier and a delta; the four drawing surfaces pass that
mark through instead of a bare number; the colours reach the marks as CSS custom properties written
from one `app_meta` row.

**Tech Stack:** Rust (rusqlite, tauri 2.11), React 19, TypeScript 6, TanStack Query, zustand,
Tailwind 4, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-09-07-theory-match-tiers-and-appearance-design.md` — read it
before Task 1. Every "why" in this plan is argued there.

**Issue:** [#386 — Mark cards as matching theory when only the art differs](https://github.com/Msgaihede/mtg-grimoire/issues/386),
reported as a possible regression of #164. The reporter's case — a live card matching the plan by
name but drawn with different art — is the **blue** tier, and their optional ask ("use a more
faded, muted, or different blue or colour to indicate that a card matches the theory but not the
art") is what the two tiers and the Appearance colours answer. **The PR must carry `Closes #386`
in its body.**

## Global Constraints

- **Work in this worktree only:** `D:\Code\mtg-grimoire\.claude\worktrees\live-theory-indicators`,
  branch `worktree-live-theory-indicators`.
- **Rust supplies facts; TS draws conclusions.** No tier resolution in Rust. No SQL in TS.
- **Never install `@types/node`.** npm `xlsx` is banned. TypeScript stays on 6.0.x.
- **`src/lib/ipc.ts` is a hand-written mirror** of the Rust structs and nothing type-checks it
  against the crate. Task 5 is its single owner; no other task edits it.
- **A *tag* in this app is one of Scryfall's two tagger datasets. A *label* is the deckbuilder's
  coloured per-card mark. Never let the words trade places.**
- **Do not run `npm run verify` inside a task.** Tests run once, after fan-in — see Task 15. Run
  only the narrow suite each task names.
- **Do not commit if you are one of several subagents working in this tree at once** — the git
  index is shared. Report what you changed; the dispatcher commits.
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `docs:`.
- Colour literals: default green `#56bd78` (`oklch(0.72 0.14 152)` converted, in gamut, verified
  2026-09-07), default blue `#0e68ab` (today's `--color-pie-u`).
- The name key fold is `toLowerCase()` **in TypeScript only**. SQL never lowers a card name —
  SQLite's `lower()` is ASCII-only and would disagree with JS on `Lim-Dûl's Vault`.

---

## File Structure

**Rust — `src-tauri/src/`**

| File | Responsibility | Task |
| --- | --- | --- |
| `deck_theory.rs` | `TheorySlot.name_key`; `theory_slots` joins `cards` | 1 |
| `schema.rs` | user v35: two `decks` columns + `UNDO_V35` | 2 |
| `deck.rs` | `DeckRow` / `DeckPatch` / create / update carry both columns | 2 |
| `markcolors.rs` | **new** — the `mark_colors` `app_meta` row, modelled on `listview.rs` | 3 |
| `desktop.rs`, `web/route.rs`, `lib.rs` | register the two new commands | 3 |
| `deck_meta.rs` | label commands take `Option<i64>` deck | 4 |

**TypeScript — `src/`**

| File | Responsibility | Task |
| --- | --- | --- |
| `lib/ipc.ts` | the mirror: all four Rust changes, in one edit | 5 |
| `features/decks/theoryMatch.ts` (+ `.test.ts`) | the tier rule — the whole domain decision | 6 |
| `lib/useMarkColors.ts` (+ `.test.ts`) | **new** — read/write the colours, write the CSS vars | 7 |
| `index.css` | the four custom properties and their defaults | 7 |
| `components/AppShell.tsx` | calls the effect once | 7 |
| `features/decks/CardMarks.tsx` | both marks take a `tier` | 8 |
| `features/decks/{DeckEditor,CardStack,cardControl}.tsx`, `views/{Stack,Grid,Table}View.tsx` | thread `TheoryMark` instead of `number \| null` | 9 |
| `features/decks/{DeckSettingsForm,DeckSettingsDialog,CreateDeckDialog}.tsx` | the two switches | 10 |
| `features/settings/nav.ts` | the Appearance group and its two panels | 11 |
| `features/settings/TheoryMarksPanel.tsx` | **new** — the two colour pickers | 11 |
| `features/settings/LabelsPanel.tsx` | **new** — the app-wide label list | 12 |
| `features/settings/SettingsPage.tsx` | mounts both panels | 11, 12 |
| `*.stories.tsx` | the workbench | 13 |
| `docs/reference/*.md`, `**/CLAUDE.md` | the record | 14 |

**Dispatch waves.** Tasks in one wave touch disjoint files and may run as parallel subagents.

| Wave | Tasks | Note |
| --- | --- | --- |
| 1 | 1, 2, 3, 4 | all Rust, disjoint files |
| 2 | 5 | sole owner of `ipc.ts` |
| 3 | 6, 7, 8 | disjoint |
| 4 | 9, 10, 11 | disjoint |
| 5 | 12 | needs Task 11's nav entry |
| 6 | 13, 14 | stories and docs |
| 7 | 15 | verify + live pass, by the dispatcher |

---

## Task 1: `TheorySlot` carries the card's name

**Files:**
- Modify: `src-tauri/src/deck_theory.rs` — the `TheorySlot` struct (~line 52-67) and
  `theory_slots` (~line 878-906)
- Test: `src-tauri/src/deck_theory.rs`, its inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing.
- Produces: `TheorySlot { key: String, name_key: Option<String>, quantity: i64 }`, serialised
  camelCase, so the wire field is `nameKey`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `src-tauri/src/deck_theory.rs`. Find the existing helper that
builds a deck fixture with theory rows (look for `theory_slots_answers_group_keys_rather_than_a_second_spelling`,
~line 2303) and follow its fixture style exactly — same helpers, same card ids.

```rust
    /// The name travels with the slot so the *loose* tier has something to match on, and it
    /// travels **verbatim**: SQLite's `lower()` is ASCII-only and the webview's `toLowerCase()`
    /// is not, so a name folded here and a live row folded there would spell two keys for one
    /// card — and they would differ on exactly the names with diacritics, which is the failure
    /// nobody notices. `theoryMatch.ts`'s `theoryNameKey` is the one place the fold happens.
    #[test]
    fn a_slot_carries_the_printed_name_unfolded() {
        let (conn, d) = deck_with_theory(&[("bolt-lea", None, 4)]);
        // `deck_with_theory` seeds `cards` with a row whose name is the id's card. Assert the
        // exact string the corpus holds, capitals and all.
        let slots = theory_slots(&conn, d).unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].name_key.as_deref(), Some("Lightning Bolt"));
    }

    /// Two printings of one card are still two slots — the exact grain is untouched by this
    /// change — and both carry the same name, which is what lets the loose tier fold them.
    #[test]
    fn two_printings_are_two_slots_with_one_name() {
        let (conn, d) = deck_with_theory(&[("bolt-lea", None, 2), ("bolt-m10", None, 2)]);
        let mut names: Vec<_> = theory_slots(&conn, d)
            .unwrap()
            .into_iter()
            .map(|s| s.name_key)
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![Some("Lightning Bolt".to_owned()), Some("Lightning Bolt".to_owned())]
        );
    }

    /// **The join is LEFT and this is why.** A theory row whose printing has left the corpus is
    /// an orphan — `deck_cards.card_id` is a soft reference — and an inner join would drop it
    /// from the plan entirely, taking its *exact* tick with it. It keeps its `group_key` and
    /// simply has no loose tier: `None` is "this card cannot be matched by name", which is the
    /// honest answer when the app does not know what the card is called.
    #[test]
    fn an_orphan_keeps_its_exact_key_and_has_no_name() {
        let (conn, d) = deck_with_theory(&[("nothing-at-all", None, 1)]);
        let slots = theory_slots(&conn, d).unwrap();
        assert_eq!(slots.len(), 1, "an orphan must not vanish from the plan");
        assert_eq!(slots[0].key, group_key("nothing-at-all", None));
        assert_eq!(slots[0].name_key, None);
    }
```

If `deck_with_theory` does not exist under that name, use whatever the neighbouring tests use and
keep the fixture identical to theirs. If the fixture's `cards` seed has no `name` column value,
add one — **seed user tables only is a rule about the reader's database, and `cards` in an
in-memory test fixture is not the reader's.**

- [ ] **Step 2: Run the tests to verify they fail**

```
cd src-tauri && cargo test deck_theory:: 2>&1 | tail -30
```

Expected: FAIL — `no field name_key on type TheorySlot` (a compile error counts as the red).

> A `cargo test` filter that matches nothing exits 0. Confirm the output names these three tests
> before believing any result.

- [ ] **Step 3: Add the field**

In `src-tauri/src/deck_theory.rs`, in the `TheorySlot` struct, after `key`:

```rust
    /// The card's printed name, exactly as `cards.name` holds it — or `None` for an orphan whose
    /// printing has left the corpus.
    ///
    /// **The second grain, and the loose tier's whole input.** `key` above answers *is this the
    /// printing I planned*; this answers *is this the card I planned*, which is the question a
    /// reader holding a different Forest is asking. It is a name rather than an `oracle_id`
    /// because Scryfall omits that field on reversible cards, on both sides of the comparison,
    /// and an identity with a fallback chain is two rules for two sides to disagree about.
    ///
    /// **Unfolded on purpose.** SQLite's `lower()` is ASCII-only; the webview's `toLowerCase()`
    /// is not. Folded here, `Lim-Dûl's Vault` and `Æther Vial` would spell one key in the plan
    /// and another in the live list, and the mark would go dark on exactly the cards whose
    /// absence is hardest to notice. `theoryMatch.ts`'s `theoryNameKey` folds both sides, in one
    /// language, and is the only place the rule is written.
    pub name_key: Option<String>,
```

- [ ] **Step 4: Join the corpus in `theory_slots`**

Replace the statement and the row build in `theory_slots`:

```rust
    let mut stmt = conn
        .prepare(
            "SELECT dc.card_id, dc.finish, SUM(dc.quantity), c.name
               FROM deck_cards dc
               JOIN deck_categories cat ON cat.id = dc.category_id
               LEFT JOIN cards c ON c.id = dc.card_id
              WHERE dc.deck_id = ?1 AND dc.variant = ?2 AND cat.is_active = 1
              GROUP BY dc.card_id, dc.finish",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, THEORY], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut slots = Vec::new();
    for row in rows {
        let (card_id, finish, quantity, name) = row.map_err(|e| e.to_string())?;
        slots.push(TheorySlot {
            key: group_key(&card_id, finish.as_deref()),
            name_key: name,
            quantity,
        });
    }
    Ok(slots)
```

Check the `cards` primary-key column name first — if it is not `id`, use whatever
`src-tauri/src/schema.rs`'s `CARDS_COLUMNS` calls it. `c.name` needs no `GROUP BY` term: it is
functionally dependent on `dc.card_id`, which is grouped, and SQLite permits the bare column.

- [ ] **Step 5: Update the struct's own doc comment**

The struct's header says "Two fields and no third: this is a mark's whole input, and every column
that is *not* here (the name, the set, the price, the pile) is one the tick would have to be told
to ignore." That is now false. Replace it:

```rust
/// One card the plan asks for — [`theory_slots`]' row, and the deck editor's theory tick.
///
/// **Three fields since 2026-09-07, and the third is the name.** This carried two until the mark
/// grew a second tier: a green tick for the printing the plan named and a blue one for the same
/// card in a printing it did not. The loose tier needs an identity that survives a different
/// printing, and the name is it. What is still *not* here is everything a mark would have to be
/// told to ignore — the set, the price, the pile.
```

- [ ] **Step 6: Update `theory_slots`' doc comment**

Its note says "one indexed scan of `deck_cards`, three columns, no join to `cards` and no
marketplace." Amend the clause that is now wrong, keeping the argument it was making:

```rust
/// This command answers neither a comparison nor a priced row: one indexed scan of `deck_cards`,
/// four columns, a LEFT JOIN to `cards` for the name alone, and no marketplace. The join arrived
/// with the loose tier on 2026-09-07 and is a primary-key lookup per group; what the founding
/// argument was really against is still absent — this does not price a row, does not roll up what
/// the group holds, and does not become a second `deck_get`.
```

- [ ] **Step 7: Run the tests to verify they pass**

```
cd src-tauri && cargo test deck_theory:: 2>&1 | tail -30
```

Expected: PASS, and every pre-existing `deck_theory` test still passing.

- [ ] **Step 8: Prove the tests can fail**

Change `LEFT JOIN` to `JOIN` and re-run: `an_orphan_keeps_its_exact_key_and_has_no_name` must go
red. Put the `LEFT` back. Report that you did this.

- [ ] **Step 9: Report**

Do not commit. Report: files changed, the three test names, and the exact string your fixture's
`cards` row holds for `bolt-lea`'s name (Task 6 needs to know whether it is `Lightning Bolt`).

---

## Task 2: Schema v35 — two switches on a deck

**Files:**
- Modify: `src-tauri/src/schema.rs` — `USER_SCHEMA_VERSION` (line 313), the migration ladder
  (after the `if v < 34` rung at ~line 4856), `USER_SCHEMA_SQL`'s frozen `decks` shape (~line
  3418-3436), and the test module's undo constants (~line 5947+)
- Modify: `src-tauri/src/deck.rs` — `DeckRow` (~line 551+), `DeckPatch` (~line 421+), `DeckInput`
  (~line 359-367), `deck_get`'s SELECT (~line 876-935), `deck_create` (~line 1339-1350),
  `deck_update` (~line 1549-1573), and the `deck_list` SELECT (~line 1482-1505)
- Test: both files' inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing.
- Produces: `DeckRow.theory_mark_exact: bool`, `DeckRow.theory_mark_name: bool`;
  `DeckPatch.theory_mark_exact: Option<bool>`, `DeckPatch.theory_mark_name: Option<bool>`. Wire
  names (serde camelCase): `theoryMarkExact`, `theoryMarkName`.

- [ ] **Step 1: Write the failing schema test**

In `schema.rs`'s test module, beside the existing `has_column` assertions (search for
`has_column(&conn, "decks", "bracket")`, ~line 7325):

```rust
    /// v35's two columns — which of the theory mark's two tiers this deck draws.
    ///
    /// **Both `DEFAULT 1`, and that is the migration.** Every deck that already exists gets both
    /// marks the moment the build lands, with no backfill and no group of older decks behaving
    /// differently forever for a reason nothing on screen explains.
    #[test]
    fn v35_gives_every_deck_both_theory_marks() {
        let conn = user_file_at_head();
        assert_eq!(has_column(&conn, "decks", "theory_mark_exact"), 1);
        assert_eq!(has_column(&conn, "decks", "theory_mark_name"), 1);
        let (exact, named): (i64, i64) = conn
            .query_row(
                "SELECT theory_mark_exact, theory_mark_name FROM decks WHERE id = ?1",
                params![seed_one_deck(&conn)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((exact, named), (1, 1), "a deck is born with both marks on");
    }
```

Use whatever the neighbouring tests use to build a head-version file and to insert a deck — read
the tests either side of `has_column(&conn, "decks", "bracket")` and copy their helpers verbatim
rather than inventing `user_file_at_head` / `seed_one_deck` if those names do not exist.

- [ ] **Step 2: Run it to verify it fails**

```
cd src-tauri && cargo test schema::tests::v35 2>&1 | tail -20
```

Expected: FAIL — `has_column` returns 0.

- [ ] **Step 3: Add the rung**

Bump `pub const USER_SCHEMA_VERSION: i64 = 34;` to `35`. Then, after the `if v < 34 {` block:

```rust
    if v < 35 {
        // **The theory mark grew a second tier, and a deck can now be told which of the two it
        // draws** (2026-09-07). Green where a live row is the printing the plan named, blue where
        // it is the same card in a printing it did not — and a reader who wants one, the other or
        // neither says so per deck, because whether a substitute printing is worth a mark is a
        // statement about how *this* deck is being built rather than about the app.
        //
        // **Both `NOT NULL DEFAULT 1`**, which is the whole of the upgrade: every deck that
        // already exists draws both marks from the first launch on the new build. The alternative
        // — defaulting the new tier off so nothing changes — leaves the headline half of the
        // feature invisible until somebody finds a switch they have no reason to look for, and
        // splits the reader's decks into two groups that behave differently with nothing on
        // screen saying why.
        //
        // Per deck rather than per user, `theory_enabled`'s own argument one column along.
        //
        // `decks` is in `SYNCED_TABLES` and the capture enumerates columns through
        // `PRAGMA table_info`, so both travel to a paired device with no change to the envelope.
        tx.execute_batch(
            "ALTER TABLE decks ADD COLUMN theory_mark_exact INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE decks ADD COLUMN theory_mark_name INTEGER NOT NULL DEFAULT 1;",
        )?;
    }
```

Match the surrounding rungs' exact idiom for `tx` and error handling — read the v34 rung first.

- [ ] **Step 4: Update the frozen schema**

`USER_SCHEMA_SQL`'s `CREATE TABLE {schema}.decks` must end with the two new columns appended to
its trailing `ALTER`-added tail, in ladder order, immediately before `sync_uid TEXT`… — read how
`bracket` sits there and place both the same way. The doc comment above `USER_SCHEMA_SQL` names a
version; bump it.

- [ ] **Step 5: Add the undo**

In the test module, beside `UNDO_V34`:

```rust
    /// v35's rewind. Owed for [`UNDO_V13`]'s **loud** reason rather than [`UNDO_V14`]'s quiet
    /// one: `ALTER TABLE decks ADD COLUMN` is not idempotent, so a fixture that kept either
    /// column dies on the rung's second run rather than skipping it.
    ///
    /// **It runs first, before [`UNDO_V34`]**, for that constant's stated reason: a rewind walks
    /// the ladder backwards.
    ///
    /// **No index needs a line of its own**, [`UNDO_V20`]'s rule: the rung creates none.
    const UNDO_V35: &str = "ALTER TABLE decks DROP COLUMN theory_mark_name;
                            ALTER TABLE decks DROP COLUMN theory_mark_exact;";
```

Then find every helper that builds a file at an older version by applying the undo constants in
reverse and add `UNDO_V35` at the front of the chain. Grep for `UNDO_V34` — every site that names
it needs `UNDO_V35` before it.

- [ ] **Step 6: Run the schema tests**

```
cd src-tauri && cargo test schema:: 2>&1 | tail -40
```

Expected: PASS, including every existing ladder and round-trip test.

- [ ] **Step 7: Carry the columns through `deck.rs`**

Four edits, each following `theory_enabled`'s existing shape character for character:

1. `DeckRow` — two `pub` bools after `theory_enabled`:

```rust
    /// Whether this deck draws the **green** theory mark — the live row that is the printing the
    /// plan named. Per deck rather than per user, [`Self::theory_enabled`]'s argument.
    ///
    /// **Off does not mean unmarked.** An exact row on a deck with this off is re-resolved as a
    /// loose one and draws blue, with blue's own number — `theoryMatch.ts`'s `theoryMatchMark`
    /// carries the rule. That is the reader's request: turning the strict mark off is asking for
    /// less precision, not for less information.
    pub theory_mark_exact: bool,
    /// Whether this deck draws the **blue** theory mark — the same card in a printing the plan
    /// did not name. See [`Self::theory_mark_exact`].
    pub theory_mark_name: bool,
```

2. `DeckPatch` — `pub theory_mark_exact: Option<bool>` and `pub theory_mark_name: Option<bool>`.
3. `deck_get`'s and `deck_list`'s SELECTs — add both columns and bump every positional `r.get(n)`
   after the insertion point. **The doc comments that say "`theory_enabled` at 13,
   `separate_x_group` at 17" are load-bearing; re-count and rewrite them.** Append the two columns
   at the **end** of each SELECT list to keep the renumbering to zero rows.
4. `deck_update`'s UPDATE — two more `coalesce(?n, column)` clauses and two more bound params.
   `deck_create` needs nothing: the columns default to 1.

- [ ] **Step 8: Write the round-trip test**

In `deck.rs`'s test module:

```rust
    /// Both switches survive a write and a read, independently — a deck can draw one mark, the
    /// other, both or neither, and the patch's `coalesce` must not carry one field's answer onto
    /// the other.
    #[test]
    fn both_theory_marks_round_trip_independently() {
        let (conn, id) = deck_fixture();
        for (exact, named) in [(true, true), (false, true), (true, false), (false, false)] {
            update_deck(
                &conn,
                DeckPatch {
                    id,
                    theory_mark_exact: Some(exact),
                    theory_mark_name: Some(named),
                    ..Default::default()
                },
            )
            .unwrap();
            let row = get_deck(&conn, id).unwrap();
            assert_eq!((row.theory_mark_exact, row.theory_mark_name), (exact, named));
        }
    }

    /// A deck is born with both marks on, which is what makes v35 need no backfill.
    #[test]
    fn a_new_deck_draws_both_marks() {
        let (conn, id) = deck_fixture();
        let row = get_deck(&conn, id).unwrap();
        assert!(row.theory_mark_exact && row.theory_mark_name);
    }
```

Use the neighbouring tests' real fixture, patch and getter names — `deck_fixture`, `update_deck`,
`get_deck` and `DeckPatch::default()` are placeholders for whatever `deck.rs` actually calls them.
If `DeckPatch` has no `Default`, build it the way the existing patch tests do.

- [ ] **Step 9: Run and confirm**

```
cd src-tauri && cargo test deck:: 2>&1 | tail -40
```

Expected: PASS.

- [ ] **Step 10: Prove a test can fail**

Change one `DEFAULT 1` to `DEFAULT 0` in the rung, re-run `cargo test schema::tests::v35` and
confirm red. Put it back.

- [ ] **Step 11: Report**

Do not commit. Report: the new `USER_SCHEMA_VERSION`, the two column names, the exact `DeckRow`
and `DeckPatch` field names, and every doc comment whose positional-index prose you re-counted.

---

## Task 3: The `mark_colors` setting

**Files:**
- Create: `src-tauri/src/markcolors.rs`
- Modify: `src-tauri/src/lib.rs` (declare the module), `src-tauri/src/desktop.rs` (~line 480,
  the `invoke_handler` list), `src-tauri/src/web/route.rs` (~line 170, the command allow-list;
  ~line 1682, the dispatch match)
- Test: inline `#[cfg(test)] mod tests` in the new file

**Interfaces:**
- Consumes: nothing.
- Produces: commands `mark_colors` → `BTreeMap<String, String>` and
  `set_mark_color(key: String, color: Option<String>)` → `Result<(), String>`. A `None` colour
  **removes** the entry.

**Read `src-tauri/src/listview.rs` in full before starting.** This module is that one with the
vocabulary moved: there the *values* are a closed pair of words and the keys are the frontend's;
here the *values* are a hex shape and the keys are still the frontend's.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/markcolors.rs` containing only the test module and the constants it needs,
so the tests fail on missing functions rather than a missing file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// What went in comes back out. The setting outlives the process and there is nothing else to
    /// be right about.
    #[test]
    fn a_colour_round_trips() {
        let conn = db();
        store(&conn, "theoryExact", Some("#56bd78")).unwrap();
        assert_eq!(
            stored(&conn).get("theoryExact").map(String::as_str),
            Some("#56bd78")
        );
    }

    /// **`None` clears rather than writing a default**, which is what Reset in the panel means.
    /// A reader who has never chosen and a reader who has reset are the same state — the
    /// stylesheet's own value — and a stored "default" hex would freeze today's palette into the
    /// database, which is the cost `labelColors.ts` already documents for a label.
    #[test]
    fn clearing_a_colour_removes_the_entry() {
        let conn = db();
        store(&conn, "theoryName", Some("#ff0000")).unwrap();
        store(&conn, "theoryName", None).unwrap();
        assert!(!stored(&conn).contains_key("theoryName"));
    }

    /// A database nobody has customised says nothing about any mark, and the frontend's own
    /// defaults stand. This is the state every fresh install is in.
    #[test]
    fn a_missing_row_customises_nothing() {
        let conn = db();
        assert!(stored(&conn).is_empty());
    }

    /// Two marks share one row, so a write to either rewrites the whole document — and an entry a
    /// *newer* build wrote survives a write this build makes beside it. Written past `store`
    /// deliberately: this build cannot produce a third key, which is exactly why the case has to
    /// be built by hand.
    #[test]
    fn a_write_keeps_every_other_entry() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_MARK_COLORS, r#"{"ruleBreak":"#d3202a"}"#).unwrap();
        store(&conn, "theoryExact", Some("#56bd78")).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_MARK_COLORS).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            map.get("ruleBreak").and_then(Value::as_str),
            Some("#d3202a"),
            "a mark this build does not know must not be emptied by a write beside it"
        );
        assert_eq!(
            stored(&conn).get("theoryExact").map(String::as_str),
            Some("#56bd78")
        );
    }

    /// A row this build cannot make sense of costs the reader their colours and nothing else.
    /// Every one of these is what a hand-edit or a different build left behind.
    #[test]
    fn an_unreadable_row_customises_nothing_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "null",
            "\"#56bd78\"",
            r#"{"theoryExact":1}"#,
            r#"{"theoryExact":null}"#,
            r#"{"theoryExact":"green"}"#,
            r#"{"theoryExact":"#xyzxyz"}"#,
            r#"{"":"#56bd78"}"#,
        ] {
            crate::app_meta::set_app_meta(&conn, K_MARK_COLORS, junk).unwrap();
            assert!(
                !stored(&conn).contains_key("theoryExact"),
                "`{junk}` must read as nothing stored, not as a colour and not as a failure"
            );
        }
    }

    /// The complement of the read rule: a colour this build cannot draw is refused at the door
    /// rather than stored and silently discarded on the next launch. Shorthand is refused too —
    /// the webview normalises `#f00` to `#ff0000` before it sends, so a three-digit value
    /// arriving here is a caller that skipped `normalizeLabelColor`.
    #[test]
    fn a_colour_that_is_not_a_full_hex_is_refused() {
        let conn = db();
        for junk in ["", "green", "#f00", "56bd78", "#56BD78 ", "rgb(1,2,3)", "#56bd7"] {
            assert!(
                store(&conn, "theoryExact", Some(junk)).is_err(),
                "`{junk}` must be refused rather than stored"
            );
        }
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_MARK_COLORS), None);
    }

    /// Uppercase is a colour, not junk: `#56BD78` and `#56bd78` are the same paint, and refusing
    /// one of them would be a rule about typing rather than about colour. Stored lowercased, so
    /// the row has one spelling per colour.
    #[test]
    fn uppercase_is_accepted_and_stored_lowercased() {
        let conn = db();
        store(&conn, "theoryExact", Some("#56BD78")).unwrap();
        assert_eq!(
            stored(&conn).get("theoryExact").map(String::as_str),
            Some("#56bd78")
        );
    }

    /// A blank key is a bug in the caller, not a mark — `listview`'s `NO_SECTION` verbatim.
    #[test]
    fn a_blank_key_is_refused() {
        let conn = db();
        assert!(store(&conn, "", Some("#56bd78")).is_err());
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Declare the module in `src-tauri/src/lib.rs` first — `pub mod markcolors;` in the same block the
other modules are declared in — or the tests never compile and `cargo test` reports nothing while
looking green.

```
cd src-tauri && cargo test markcolors:: 2>&1 | tail -30
```

Expected: FAIL to compile — `cannot find function store`.

> An undeclared module makes every `cargo` run vacuous. Confirm the output names these tests.

- [ ] **Step 3: Write the module**

Above the test module in `src-tauri/src/markcolors.rs`:

```rust
//! What colour the reader has each card mark drawn in — the setting, and nothing else.
//!
//! **Which marks are customisable is TypeScript's; the row is this crate's.** That is
//! [`crate::listview`]'s split with the bound moved one step further out: there the frontend owns
//! which *walls* exist and this crate owns the two words a wall may be drawn in, and here the
//! frontend owns which *marks* exist and this crate owns only the shape a colour may have. It
//! knows nothing about a theory tick.
//!
//! The two rules are [`crate::listview`]'s two:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, an entry whose value is a
//!   number or a word — every one reads as "nothing stored for that mark", and a mark with
//!   nothing stored is drawn in the colour `index.css` gives it. A preference that cannot be read
//!   is not worth refusing to draw a card over.
//! * **Writing validates.** [`store`] refuses a blank key and anything that is not `#rrggbb`, so
//!   the row cannot accumulate entries every later read would silently discard.
//!
//! **A `None` colour deletes the entry rather than storing a default**, and that is the one thing
//! this module has that its model does not. Reset in the Appearance panel has to leave the reader
//! in the state they were in before they ever chose, and a default hex written into the row is a
//! different state: it freezes today's palette into the database, which is exactly the cost
//! `src/features/decks/labelColors.ts` records for a stored label colour. A cleared key means
//! "the stylesheet decides", forever.
//!
//! **A write preserves entries this build does not understand**, [`crate::listview`]'s rule
//! verbatim: the row is read back as a raw `serde_json::Map` and only the key being written is
//! touched, so a build that learns to colour a fourth mark does not have its row quietly emptied
//! by an older build pointed at the same file.
//!
//! No migration: `app_meta` is schema v6's key/value table, and this is a key in it. It is not in
//! `SYNCED_TABLES`, so these colours are **this device's** — every other stored preference in the
//! app is too, and the two per-deck switches beside this feature are not.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta`.
pub const K_MARK_COLORS: &str = "mark_colors";

/// A blank key is a bug in the caller, not a mark — [`crate::listview`]'s `NO_SECTION`.
const NO_KEY: &str = "A mark cannot be blank.";

/// Is this `#rrggbb`?
///
/// **Six digits and a hash, and nothing else.** Shorthand is not accepted here even though the
/// webview's own field takes it: `normalizeLabelColor` expands `#f00` to `#ff0000` before
/// anything is sent, so three digits arriving at this boundary means a caller that skipped it —
/// and a row holding two spellings of one colour is a row whose entries cannot be compared.
fn is_hex(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_MARK_COLORS)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Every mark this database has a usable colour for.
///
/// **A mark is absent rather than defaulted**: what an uncustomised mark is drawn in lives in
/// `index.css`, so a default invented here would be a second opinion about a colour the
/// stylesheet already owns. Entries are dropped one at a time, so a single hand-edited value
/// costs that mark its colour and leaves the others intact.
pub fn stored(conn: &Connection) -> BTreeMap<String, String> {
    stored_object(conn)
        .into_iter()
        .filter(|(mark, _)| !mark.is_empty())
        .filter_map(|(mark, value)| {
            let color = value.as_str().filter(|c| is_hex(c))?;
            Some((mark, color.to_ascii_lowercase()))
        })
        .collect()
}

/// Remember one mark's colour, or — with `None` — forget it, leaving every other entry alone.
pub fn store(conn: &Connection, mark: &str, color: Option<&str>) -> Result<(), String> {
    if mark.is_empty() {
        return Err(NO_KEY.to_owned());
    }
    let mut colors = stored_object(conn);
    match color {
        Some(color) => {
            if !is_hex(color) {
                return Err(format!(
                    "\"{color}\" is not a colour this app can store. Expected #rrggbb."
                ));
            }
            colors.insert(mark.to_owned(), Value::from(color.to_ascii_lowercase()));
        }
        // Reset. See the module doc: the absence *is* the default.
        None => {
            colors.remove(mark);
        }
    }
    let json = serde_json::to_string(&Value::Object(colors))
        .map_err(|e| format!("could not save the colour: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_MARK_COLORS, &json)
        .map_err(|e| format!("could not save the colour: {e}"))
}

/// Every mark's remembered colour, as mark → `#rrggbb`.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason: the
/// frontend reads this once at launch to paint over defaults it already holds, and there is
/// nothing a card could do with an error here that is not just "draw the colour you already
/// have".
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn mark_colors(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, String> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one mark's colour, or clear it. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes. Unlike the rail and the list
/// layout, **this refusal is worth surfacing**: the reader is standing in front of a colour picker
/// watching a swatch, so the panel says the write did not land rather than leaving them to find
/// out at the next launch.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_mark_color(
    state: tauri::State<'_, Arc<AppState>>,
    mark: String,
    color: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &mark, color.as_deref()))
    })
    .await
    .map_err(|e| format!("the colour could not be saved: {e}"))?
}
```

- [ ] **Step 4: Register the two commands**

Three places, each modelled on `list_view` / `set_list_view`:

1. `src-tauri/src/desktop.rs` — add `markcolors::mark_colors,` and `markcolors::set_mark_color,`
   to the `invoke_handler` list, in the same neighbourhood as `listview::`.
2. `src-tauri/src/web/route.rs` — add `"mark_colors"` and `"set_mark_color"` to the allow-list
   (~line 170) **and** a `match` arm each (~line 1682), copying `list_view`'s arms exactly and
   reading `mark` and `color` from the payload. `color` is optional — read it as
   `Option<String>`, not a required string, or Reset breaks on the web build only.
3. `src-tauri/src/lib.rs` — the `pub mod markcolors;` you added in Step 2.

- [ ] **Step 5: Run the tests**

```
cd src-tauri && cargo test markcolors:: 2>&1 | tail -30
```

Expected: PASS, all eight.

- [ ] **Step 6: Prove a test can fail**

Make `is_hex` return `true` unconditionally, re-run, and confirm
`a_colour_that_is_not_a_full_hex_is_refused` and
`an_unreadable_row_customises_nothing_rather_than_failing` both go red. Revert.

- [ ] **Step 7: Check it compiles for the web target**

```
cd src-tauri && cargo check --target wasm32-unknown-unknown 2>&1 | tail -20
```

If that target is not installed, say so in your report rather than skipping silently — the
`#[cfg(not(target_family = "wasm"))]` gates are the thing at risk and Task 15 must know they are
unverified.

- [ ] **Step 8: Report**

Do not commit. Report: the command names, their exact argument names (`mark`, `color`), the three
registration sites you edited, and whether the wasm check ran.

---

## Task 4: Label commands work without a deck

**Files:**
- Modify: `src-tauri/src/deck_meta.rs` — `create_label` (~line 1233), `update_label`,
  `delete_label` (~line 1448), and the three `#[tauri::command]` wrappers (~lines 2007, 2025,
  2043)
- Test: inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing.
- Produces: `deck_label_create(deck_id: Option<i64>, name, color)`,
  `deck_label_update(deck_id: Option<i64>, id, name, color)`,
  `deck_label_delete(deck_id: Option<i64>, id)`. All three keep every existing behaviour when a
  deck is given.

**Background.** `deck_id` is load-bearing today: each of the three calls `crate::deck::touch_deck`
and writes a `deck_audit` row through `record_label`, and the audit is what a deck's undo step
hangs off. The Appearance panel has no deck. So the argument becomes optional, and a call with no
deck does the label write and **nothing else**.

- [ ] **Step 1: Write the failing tests**

```rust
    /// **A label can be made with no deck in the room** — the Appearance panel in Settings owns
    /// the app-wide list, and there is no deck there to touch or to write a history entry for.
    ///
    /// A label has been one app-wide row since v21, so this needs no new storage: what `deck_id`
    /// was ever for here is the *deck's* side effects, and a global edit has none.
    #[test]
    fn a_label_can_be_created_without_a_deck() {
        let conn = fixture();
        let label = create_label(&conn, None, "Cut candidate", "#d9b95c").unwrap();
        assert_eq!(label.name, "Cut candidate");
        assert!(list_all_labels(&conn).unwrap().iter().any(|l| l.id == label.id));
    }

    /// **And it writes no deck history**, which is the trade this option is, stated as a test
    /// rather than discovered. A rename made from Settings is not an event in any one deck's life
    /// — it reaches every deck wearing the label — so attributing it to one would be a false
    /// entry, and attributing it to all of them is a feature nobody asked for. The cost is that
    /// such an edit is not in a deck's undo stack; the deck editor's own dialog is unchanged and
    /// still records everything it always did.
    #[test]
    fn a_deckless_label_write_records_no_audit_and_no_undo() {
        let conn = fixture();
        let before = audit_count(&conn);
        let label = create_label(&conn, None, "Cut candidate", "#d9b95c").unwrap();
        update_label(&conn, None, label.id, "Cut", "#0e68ab").unwrap();
        delete_label(&conn, None, label.id).unwrap();
        assert_eq!(audit_count(&conn), before);
    }

    /// The deck path is untouched: given a deck, all three still touch it and still write the
    /// history entry the editor's dialog depends on.
    #[test]
    fn a_label_write_with_a_deck_still_records_history() {
        let (conn, deck) = deck_fixture();
        let before = audit_count(&conn);
        create_label(&conn, Some(deck), "Cut candidate", "#d9b95c").unwrap();
        assert!(audit_count(&conn) > before);
    }
```

`fixture`, `deck_fixture`, `audit_count` and `list_all_labels` are placeholders — use whatever the
neighbouring label tests in this file already use, and write `audit_count` as a
`SELECT count(*) FROM deck_audit` helper if none exists.

- [ ] **Step 2: Run to verify they fail**

```
cd src-tauri && cargo test deck_meta::tests 2>&1 | tail -30
```

Expected: FAIL to compile — `expected i64, found Option<i64>`.

- [ ] **Step 3: Make the deck optional**

In each of `create_label`, `update_label` and `delete_label`, change the parameter to
`deck_id: Option<i64>` and guard both side effects:

```rust
    // **The deck's side effects, and only when there is a deck.** A label is one app-wide row
    // (v21), so the write itself never needed one; what `deck_id` buys is the deck's `updated_at`
    // and the history entry its editor draws. The Appearance panel in Settings has neither to
    // offer — a global rename belongs to no single deck — so a deckless call does the label and
    // stops. See this module's tests for the trade that makes.
    if let Some(deck_id) = deck_id {
        crate::deck::touch_deck(&tx, deck_id)?;
    }
```

and, around each `record_label(...)` call and the `deck_undo` step that follows it:

```rust
    if let Some(deck_id) = deck_id {
        let audit_id = record_label(&tx, deck_id, &payload)?;
        // …the existing undo step, unchanged…
    }
```

Read each function in full first — `delete_label` computes an unlabelled-card count *for the
payload* before writing it. Keep that computation inside the guard if it is only used by the
payload; hoist nothing that the delete itself needs.

- [ ] **Step 4: Update the three command wrappers**

```rust
pub async fn deck_label_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    name: String,
    color: String,
) -> Result<GlobalLabel, String> {
```

…and pass `deck_id` straight through. Same for `update` and `delete`. **Tauri fills a missing
`Option` argument with `None`**, so the deck editor's existing calls, which send `deckId`, are
unchanged and a caller that omits it gets `None`.

- [ ] **Step 5: Document the option on each command**

On `deck_label_create`, add:

```rust
/// **`deck_id` is optional, and its absence is the Appearance panel.** A label is one app-wide row
/// and always was; the deck is what the *side effects* need — its `updated_at`, and the history
/// entry the editor's dialog draws. A call from Settings has no deck to name, so it makes the
/// label and writes no history. See the module tests for the trade.
```

Refer to it from the other two rather than repeating it.

- [ ] **Step 6: Run the tests**

```
cd src-tauri && cargo test deck_meta:: 2>&1 | tail -40
```

Expected: PASS, including every pre-existing label test.

- [ ] **Step 7: Prove a test can fail**

Drop the `if let Some(deck_id)` guard around `record_label` in `create_label` (leaving it to
`unwrap()`), re-run, confirm a red, revert.

- [ ] **Step 8: Report**

Do not commit. Report: the three signatures, and — importantly — **whether `delete_label` had any
work inside the audit branch that the delete itself needed**. Task 12 draws the confirm dialog and
needs to know exactly what a deckless delete does and does not do.

---

## Task 5: The IPC mirror

**Files:**
- Modify: `src/lib/ipc.ts` — `TheorySlot` (~line 2281 **and** ~line 2319: the interface appears
  twice in this file, check both), the `Deck` interface, `DeckPatch`, the label command block
  (~line 5343-5367), and the settings block (~line 5980-6130)
- Modify: `src/lib/ipc.test.ts` — the mirror's own fence
- Test: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: Task 1's `nameKey`, Task 2's `theoryMarkExact` / `theoryMarkName`, Task 3's
  `mark_colors` / `set_mark_color`, Task 4's optional `deckId`.
- Produces: everything Tasks 6-12 import. **No other task edits this file.**

- [ ] **Step 1: Mirror `TheorySlot`**

```ts
export interface TheorySlot {
  /** `deck_theory.rs`'s own `group_key` — `` `${cardId}|${finish ?? ""}` ``.
   *  `features/decks/theoryMatch.ts` spells the same string for a **live** row and looks it up. */
  key: string;
  /**
   * The card's printed name, exactly as `cards.name` holds it — `null` for an orphan whose
   * printing has left the corpus and which therefore cannot be matched by name at all.
   *
   * **Unfolded, and that is deliberate.** SQLite's `lower()` is ASCII-only and this side's
   * `toLowerCase()` is not, so a name folded in SQL and a live row folded in JS would spell two
   * keys for `Lim-Dûl's Vault`. `theoryNameKey` in `features/decks/theoryMatch.ts` folds both
   * sides, in one language, and is the only place the rule is written.
   */
  nameKey: string | null;
  /** How many copies the plan asks for, summed across every active pile it filed them in. */
  quantity: number;
}
```

**Check whether this interface really is declared twice** (grep `export interface TheorySlot`). If
it is, one of them is dead — delete the duplicate rather than editing both, and say so in your
report.

- [ ] **Step 2: Mirror the two deck columns**

On the `Deck` interface, beside `theoryEnabled`:

```ts
  /**
   * Whether this deck draws the **green** theory mark — a live row that is the printing the plan
   * named.
   *
   * **Off does not mean unmarked.** `theoryMatch.ts`'s `theoryMatchMark` re-resolves an exact row
   * as a loose one when this is off, so it draws blue with blue's own name-grain number. Turning
   * the strict mark off asks for less precision, not for less information.
   */
  theoryMarkExact: boolean;
  /** Whether this deck draws the **blue** theory mark — the same card in a printing the plan did
   *  not name. See {@link Deck.theoryMarkExact}. */
  theoryMarkName: boolean;
```

Add both to `DeckPatch` as optional, following `theoryEnabled`'s exact shape there.

- [ ] **Step 3: Mirror the colour setting**

In the settings block, after `setFlattenState`:

```ts
  /**
   * What colour the reader has each card mark drawn in, as mark name → `#rrggbb`.
   *
   * The **eighth** `app_meta` setting and the fourth whose shape is a map — see this file's
   * header, and {@link listView} beside it, whose contract this copies whole. **A mark is absent
   * rather than defaulted**: what an uncustomised mark is drawn in lives in `index.css`, so a
   * missing entry means the reader has never chosen and the backend does not invent a colour the
   * stylesheet owns. **Infallible by signature** — a whole unreadable row answers `{}`.
   *
   * `Record<string, string>` and not a keyed record, for {@link listView}'s reason on the key
   * half: which marks are customisable is this side's vocabulary, so `isMarkColorKey` narrows it
   * in `@/lib/useMarkColors`. The **values** are checked at the far end, which is where a hex has
   * a shape worth refusing.
   */
  markColors: () => invoke<Record<string, string>>("mark_colors"),
  /**
   * Remember one mark's colour — or, with `null`, **forget it**, which is what Reset means.
   *
   * `null` rather than writing the default hex, deliberately: a reader who has never chosen and
   * one who has reset must end in the same state, and a default written into the row would freeze
   * today's palette into the database — the cost `labelColors.ts` records for a stored label
   * colour, paid for no reason.
   *
   * Rejects a blank mark and anything that is not `#rrggbb`, so `app_meta` cannot collect entries
   * every later read would discard. **Unlike its neighbours a refusal here is worth surfacing**:
   * the reader is watching a swatch, so the panel says the write did not land rather than leaving
   * them to discover it at the next launch.
   */
  setMarkColor: (mark: string, color: string | null) =>
    invoke<void>("set_mark_color", { mark, color }),
```

- [ ] **Step 4: Make the label commands' deck optional**

```ts
  /** Make a label. **`deckId` is optional and its absence is Settings' Appearance panel**: a
   *  label has been one app-wide row since v21, and the deck is only what the side effects need —
   *  the deck's `updated_at` and its history entry. A deckless write makes the label and records
   *  no history, which is honest for an edit that reaches every deck wearing it. */
  deckLabelCreate: (deckId: number | null, name: string, color: LabelColor) =>
    invoke<GlobalLabel>("deck_label_create", { deckId, name, color }),
```

Same treatment for `deckLabelUpdate` and `deckLabelDelete`. **Every existing call site passes a
number and keeps working**; do not change any of them.

- [ ] **Step 5: Extend the mirror's fence**

`src/lib/ipc.test.ts` exercises the mirror against the real command surface. Add cases for
`markColors` / `setMarkColor` (including `color: null`) and read `nameKey` back off a
`deckTheorySlots` answer, following the file's existing style — read three neighbouring cases
first. A mirror that typed `nameKey` as `string` rather than `string | null` would make every
orphan a crash, so read it back rather than only calling.

- [ ] **Step 6: Run the mirror suite**

```
npm run test:run -- src/lib/ipc.test.ts
```

Expected: PASS.

- [ ] **Step 7: Type-check**

```
npx tsc --noEmit
```

Expected: errors **only** in files Tasks 6-12 will rewrite (`theoryMatch.ts` and its callers, if
`TheorySlot` changed shape in a way they read). List them in your report — they are Task 6's and
Task 9's inbox. IDE diagnostics lag; `tsc --noEmit` is the authority.

- [ ] **Step 8: Report**

Do not commit. Report: whether `TheorySlot` was duplicated, the exact new field and command names,
and the `tsc` error list.

---

## Task 6: The tier rule

**Files:**
- Modify: `src/features/decks/theoryMatch.ts` — the whole module
- Test: `src/features/decks/theoryMatch.test.ts`

**Interfaces:**
- Consumes: `TheorySlot { key, nameKey, quantity }` and `DeckCard` from `@/lib/ipc`.
- Produces:

```ts
export type TheoryTier = "exact" | "name";
export interface TheoryMark { tier: TheoryTier; delta: number }
export interface TheoryPlan {
  exact: ReadonlyMap<string, number>;
  byName: ReadonlyMap<string, number>;
  marks: TheoryMarkSwitches;
}
export interface TheoryMarkSwitches { exact: boolean; name: boolean }
export function theorySlot(card: Pick<DeckCard, "cardId" | "finish">): string;
export function theoryNameKey(name: string): string;
export function theoryMatchPlan(
  slots: readonly TheorySlot[] | undefined,
  live: readonly Pick<DeckCard, "cardId" | "finish" | "name" | "quantity" | "categoryActive">[],
  marks: TheoryMarkSwitches,
): TheoryPlan | undefined;
export function theoryMatchMark(
  plan: TheoryPlan | undefined,
  card: Pick<DeckCard, "cardId" | "finish" | "name">,
): TheoryMark | null;
```

`theoryMatchDelta` is **deleted**. Task 9 updates every caller.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/decks/theoryMatch.test.ts`, keeping every existing test that still describes
true behaviour (the exact-grain arithmetic is unchanged). Use the file's existing fixture helpers.

```ts
const BOTH = { exact: true, name: true } as const;

describe("the two tiers", () => {
  it("draws the exact tier for the printing the plan names", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );
    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })))
      .toEqual({ tier: "exact", delta: 0 });
  });

  it("draws the loose tier for another printing of the same card", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );
    expect(theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt" })))
      .toEqual({ tier: "name", delta: 0 });
  });

  it("draws the loose tier for the same printing in the wrong finish", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|foil", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 })],
      BOTH,
    );
    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })))
      .toEqual({ tier: "name", delta: 0 });
  });

  it("draws nothing for a card the plan does not ask for at all", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "ring-c11", finish: null, name: "Sol Ring", quantity: 1 })],
      BOTH,
    );
    expect(theoryMatchMark(plan, card({ cardId: "ring-c11", finish: null, name: "Sol Ring" })))
      .toBeNull();
  });
});

describe("the number's grain follows the tier", () => {
  /**
   * The reader's own example, 2026-09-07. The plan asks for eight Forests of one printing; the
   * list holds eight over four printings, two of each.
   *
   * **Every one of the eight is marked** — the maps are built once and read, never consumed, so
   * this is not "the last Forest wins" — and the numbers differ by tier on purpose: the green
   * rows report the *printing* they are two of against the eight planned, and the blue rows
   * report the *card*, which is exactly right at eight against eight.
   */
  it("marks all eight Forests, green ones by printing and blue ones by card", () => {
    const printings = ["forest-a", "forest-b", "forest-c", "forest-d"];
    const live = printings.map((cardId) =>
      card({ cardId, finish: null, name: "Forest", quantity: 2 }),
    );
    const plan = theoryMatchPlan(
      [{ key: "forest-a|", nameKey: "Forest", quantity: 8 }],
      live,
      BOTH,
    );
    const marks = printings.map((cardId) =>
      theoryMatchMark(plan, card({ cardId, finish: null, name: "Forest" })),
    );
    expect(marks[0]).toEqual({ tier: "exact", delta: -6 });
    expect(marks.slice(1)).toEqual([
      { tier: "name", delta: 0 },
      { tier: "name", delta: 0 },
      { tier: "name", delta: 0 },
    ]);
    expect(marks.every((m) => m !== null)).toBe(true);
  });

  it("counts every finish of every printing on the loose tier", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [
        card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt", quantity: 1 }),
        card({ cardId: "bolt-m10", finish: "foil", name: "Lightning Bolt", quantity: 1 }),
      ],
      BOTH,
    );
    // Two live, four planned, at the card's grain.
    expect(theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: "foil", name: "Lightning Bolt" })))
      .toEqual({ tier: "name", delta: -2 });
  });
});

describe("the switches", () => {
  it("re-resolves an exact row as a loose one when the exact mark is off", () => {
    const plan = theoryMatchPlan(
      [{ key: "forest-a|", nameKey: "Forest", quantity: 8 }],
      [
        card({ cardId: "forest-a", finish: null, name: "Forest", quantity: 2 }),
        card({ cardId: "forest-b", finish: null, name: "Forest", quantity: 6 }),
      ],
      { exact: false, name: true },
    );
    // Blue, and blue's number: eight live against eight planned, not two against eight.
    expect(theoryMatchMark(plan, card({ cardId: "forest-a", finish: null, name: "Forest" })))
      .toEqual({ tier: "name", delta: 0 });
  });

  it("draws nothing for a loose row when the loose mark is off, and keeps the exact one", () => {
    const live = [
      card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 }),
      card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt", quantity: 4 }),
    ];
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      live,
      { exact: true, name: false },
    );
    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })))
      .toEqual({ tier: "exact", delta: 0 });
    expect(theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "Lightning Bolt" })))
      .toBeNull();
  });

  it("draws nothing at all with both switches off", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 4 }],
      [card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt", quantity: 4 })],
      { exact: false, name: false },
    );
    expect(theoryMatchMark(plan, card({ cardId: "bolt-lea", finish: null, name: "Lightning Bolt" })))
      .toBeNull();
  });
});

describe("the name key", () => {
  it("folds case on both sides", () => {
    const plan = theoryMatchPlan(
      [{ key: "bolt-lea|", nameKey: "Lightning Bolt", quantity: 1 }],
      [card({ cardId: "bolt-m10", finish: null, name: "LIGHTNING BOLT", quantity: 1 })],
      BOTH,
    );
    expect(theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "LIGHTNING BOLT" })))
      ?.tier
      .toString();
    expect(
      theoryMatchMark(plan, card({ cardId: "bolt-m10", finish: null, name: "LIGHTNING BOLT" })),
    ).toEqual({ tier: "name", delta: 0 });
  });

  /** A slot with no name is an orphan: it can still be matched exactly and can match nothing
   *  loosely. A `null` that fell into the map as a key would make every unnamed live row match
   *  every orphan. */
  it("gives an orphan slot no loose tier", () => {
    const plan = theoryMatchPlan(
      [{ key: "gone|", nameKey: null, quantity: 1 }],
      [card({ cardId: "other", finish: null, name: "Forest", quantity: 1 })],
      BOTH,
    );
    expect(plan?.byName.size).toBe(0);
    expect(theoryMatchMark(plan, card({ cardId: "other", finish: null, name: "Forest" })))
      .toBeNull();
  });
});

describe("the difference floor", () => {
  /** Commander: every row a 1-of, so no reader there ever meets a number — on either tier. */
  it("draws a tick rather than a number for a singleton on both tiers", () => {
    const plan = theoryMatchPlan(
      [{ key: "ring-c11|", nameKey: "Sol Ring", quantity: 1 }],
      [card({ cardId: "ring-ltr", finish: null, name: "Sol Ring", quantity: 1 })],
      BOTH,
    );
    expect(theoryMatchMark(plan, card({ cardId: "ring-ltr", finish: null, name: "Sol Ring" })))
      .toEqual({ tier: "name", delta: 0 });
  });
});

describe("no plan", () => {
  it("answers undefined for a deck that keeps no theory list", () => {
    expect(theoryMatchPlan(undefined, [], BOTH)).toBeUndefined();
    expect(theoryMatchMark(undefined, card({ cardId: "x", finish: null, name: "X" }))).toBeNull();
  });
});
```

Delete the stray `?.tier.toString()` line above when you paste — it is a typo left in to be caught;
the assertion below it is the real one. Write `card()` as a small local factory if the file has no
equivalent.

- [ ] **Step 2: Run to verify they fail**

```
npm run test:run -- src/features/decks/theoryMatch.test.ts
```

Expected: FAIL — `theoryMatchMark is not a function`.

- [ ] **Step 3: Rewrite the module**

Keep `theorySlot` and `DIFFERENCE_FLOOR` exactly as they are. Add:

```ts
/**
 * A card's identity across printings, folded — the loose tier's key.
 *
 * **The fold happens here and nowhere else.** `deck_theory.rs` answers `cards.name` verbatim and
 * this side lowercases both halves, because SQLite's `lower()` is ASCII-only and this one is not:
 * a plan folded in SQL and a live row folded here would spell two keys for `Lim-Dûl's Vault` and
 * `Æther Vial`, and the mark would go dark on exactly the names nobody thinks to check.
 *
 * A name rather than an `oracle_id` because Scryfall omits that field on reversible cards — on
 * both sides — and an identity with a fallback chain is two rules for two sides to disagree
 * about. What it costs: two distinct oracle cards that share a printed name would collapse into
 * one loose tier. That is a blue tick that should not be there, on a pair no deck holds both of.
 */
export function theoryNameKey(name: string): string {
  return name.trim().toLowerCase();
}
```

Rewrite `theoryMatchPlan` to build both maps in one pass over `slots` and one over `live`, apply
`DIFFERENCE_FLOOR` per grain, and carry `marks` through. Then:

```ts
/**
 * What the plan says about this row: `null` where it says nothing, and otherwise which tier the
 * row is in and how far it is from the plan **at that tier's grain**.
 *
 * ## The tier decides the colour and the number together
 *
 * That is the whole rule, and it is why this is one function rather than a tier test beside a
 * delta lookup. An **exact** row is the printing the plan named, and its number is about that
 * printing: two of the eight planned Forests of that art is `-6`, which is true. A **name** row is
 * another printing of a planned card, and its number is about the *card*: eight Forests against
 * eight planned is `0`, which is also true. The reader chose this arrangement on 2026-09-07 over
 * one name-grain number for both tiers, having been shown the case it costs the most in.
 *
 * ## Turning the exact mark off does not silence the row
 *
 * It re-resolves it as a loose one — blue, with blue's number. An exact match *is* a name match,
 * so the fact survives the switch; what the switch turns off is the finer statement. This is why
 * the fallback needs no arithmetic of its own: it is the same call, one tier down.
 */
export function theoryMatchMark(
  plan: TheoryPlan | undefined,
  card: Pick<DeckCard, "cardId" | "finish" | "name">,
): TheoryMark | null {
  if (plan === undefined) return null;
  const exact = plan.exact.get(theorySlot(card));
  if (exact !== undefined && plan.marks.exact) return { tier: "exact", delta: exact };
  if (!plan.marks.name) return null;
  const byName = plan.byName.get(theoryNameKey(card.name));
  return byName === undefined ? null : { tier: "name", delta: byName };
}
```

Note what that body gets right by construction: a slot with `nameKey === null` never enters
`byName`, and a row whose exact key hits while `marks.exact` is false falls through to the loose
lookup — which is the fallback, for free.

- [ ] **Step 4: Rewrite the module's header comment**

The file's opening doc describes one question and one grain. It now describes two. Keep every
existing argument that is still true — the category is still not part of any key, an inactive pile
still counts on neither side, the shopping list is still a different question — and add the two
tiers, the name key's reasoning, and the "maps are read, never consumed" property the land case
depends on. Do not delete the `|` separator note or the NUL story; both are still live.

- [ ] **Step 5: Run the tests**

```
npm run test:run -- src/features/decks/theoryMatch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Mutate and confirm**

Make three deliberate breaks, one at a time, and confirm which test catches each. Revert each
before the next:

1. In `theoryMatchMark`, return `null` instead of falling through when `marks.exact` is false.
   Expect `re-resolves an exact row as a loose one` to go red.
2. In `theoryMatchPlan`, `delete` each `byName` entry as it is read. Expect the eight-Forest test
   to go red. **This is the "only the last Forest gets a tick" bug the reader named; it must be
   caught.**
3. Let a `null` `nameKey` into `byName` under the key `""`. Expect `gives an orphan slot no loose
   tier` to go red.

Report what each mutation did.

- [ ] **Step 7: Report**

Do not commit. Report: the exported signatures verbatim, and the three mutation results.

---

## Task 7: The colours reach the marks

**Files:**
- Create: `src/lib/useMarkColors.ts`, `src/lib/useMarkColors.test.ts`
- Modify: `src/index.css` (the `:root` block that holds `--color-ok` at ~line 340 and
  `--color-pie-u` at ~line 355)
- Modify: `src/components/AppShell.tsx` — one hook call

**Interfaces:**
- Consumes: `ipc.markColors` / `ipc.setMarkColor` from Task 5.
- Produces:

```ts
export const MARK_COLORS_KEY: readonly string[];        // ["markColors"]
export const MARK_COLOR_KEYS = ["theoryExact", "theoryName"] as const;
export type MarkColorKey = (typeof MARK_COLOR_KEYS)[number];
export const MARK_COLOR_DEFAULTS: Readonly<Record<MarkColorKey, string>>;
export function isMarkColorKey(key: string): key is MarkColorKey;
export function useMarkColors(): {
  colors: Readonly<Record<MarkColorKey, string>>;   // stored, or the default
  setColor: (key: MarkColorKey, hex: string) => void;
  resetColor: (key: MarkColorKey) => void;
  failure: string | null;
};
export function useMarkColorVars(): void;            // AppShell calls this once
```

- [ ] **Step 1: Add the custom properties**

In `src/index.css`, in the same `:root` block, after `--color-pie-u`:

```css
  /* The deckbuilder's two theory marks (2026-09-07). Green where a live row is the printing the
     plan named, blue where it is the same card in a printing it did not.

     Literal hexes rather than `var(--color-ok)` / `var(--color-pie-u)`, for `LABEL_COLORS`'
     reason one file over: these are the values a colour picker opens on and the values a reader's
     own choice replaces, so they cannot be a reference to something the palette decides later.
     `#56bd78` is `--color-ok`'s `oklch(0.72 0.14 152)` converted to sRGB — in gamut, so exact.

     The `-fg` pair is what is legible printed on each: the banner mark is a filled box with a
     tick or a signed number on it. `useMarkColors` overwrites all four when the reader has
     chosen, computing each foreground with `labelFgCss`' luminance formula, so a pale custom
     green does not swallow the tick. */
  --color-theory-exact: #56bd78;
  --color-theory-exact-fg: var(--color-text);
  --color-theory-name: #0e68ab;
  --color-theory-name-fg: var(--color-text);
```

- [ ] **Step 2: Write the failing tests**

`src/lib/useMarkColors.test.ts`. Render the hook with a QueryClientProvider the way the other hook
tests in `src/lib/` do — read one first.

```ts
describe("useMarkColors", () => {
  it("answers the stylesheet's default for a mark nobody has chosen", async () => {
    mockIpc({ mark_colors: {} });
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#56bd78"));
    expect(result.current.colors.theoryName).toBe("#0e68ab");
  });

  it("answers a stored colour", async () => {
    mockIpc({ mark_colors: { theoryExact: "#123456" } });
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#123456"));
  });

  /** A key a newer build wrote is not this build's business and must not become a colour. */
  it("ignores a mark this build does not draw", async () => {
    mockIpc({ mark_colors: { ruleBreak: "#d3202a" } });
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#56bd78"));
    expect(Object.keys(result.current.colors)).toEqual(["theoryExact", "theoryName"]);
  });

  /** Reset sends `null`, which clears the row. Writing the default hex instead would freeze
   *  today's palette into the reader's database. */
  it("resets by clearing rather than by writing the default", async () => {
    const sent = mockIpc({ mark_colors: { theoryExact: "#123456" } });
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    await waitFor(() => expect(result.current.colors.theoryExact).toBe("#123456"));
    act(() => result.current.resetColor("theoryExact"));
    expect(sent).toContainEqual(["set_mark_color", { mark: "theoryExact", color: null }]);
  });

  it("surfaces a refused write", async () => {
    const { result } = renderHook(() => useMarkColors(), { wrapper });
    // …make `set_mark_color` reject, then:
    await waitFor(() => expect(result.current.failure).not.toBeNull());
  });
});

describe("useMarkColorVars", () => {
  it("writes all four properties, foregrounds included", async () => {
    mockIpc({ mark_colors: { theoryExact: "#f8e7b9" } });
    renderHook(() => useMarkColorVars(), { wrapper });
    const root = document.documentElement;
    await waitFor(() =>
      expect(root.style.getPropertyValue("--color-theory-exact")).toBe("#f8e7b9"),
    );
    // `#f8e7b9` has luma 0.91 — `labelFgCss` puts the app's near-black on it, and a tick in
    // `--color-text` would be invisible.
    expect(root.style.getPropertyValue("--color-theory-exact-fg")).toBe("var(--color-accent-fg)");
  });

  /** An uncustomised mark must be left to the stylesheet: an inline property set to the default
   *  would win over a future theme, which is the one thing an *absent* entry is protecting. */
  it("writes nothing for a mark nobody has chosen", async () => {
    mockIpc({ mark_colors: {} });
    renderHook(() => useMarkColorVars(), { wrapper });
    await waitFor(() => expect(true).toBe(true));
    expect(document.documentElement.style.getPropertyValue("--color-theory-exact")).toBe("");
  });
});
```

`mockIpc` is a placeholder — use whatever `src/lib/*.test.ts` already uses to fake `invoke`, and
reset `document.documentElement.style` in an `afterEach` or the second test inherits the first's
properties. **Store and DOM state leak between tests in this suite; clean up explicitly.**

- [ ] **Step 3: Run to verify they fail**

```
npm run test:run -- src/lib/useMarkColors.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the hook**

`src/lib/useMarkColors.ts`. Model the query/mutation shape on `src/lib/useNavCollapsed.ts` — read
it first — with two differences it states itself: this write's failure **is** surfaced, and the
cache is the value's only home.

```ts
/**
 * What colour each card mark is drawn in — the reader's choice, and the four custom properties it
 * becomes.
 *
 * ## Why custom properties rather than a prop or a store read
 *
 * The theory mark is drawn on four surfaces (the stack's banner, the grid tile's chip, the
 * table's badge and the text columns'), and none of them decides its colour. Threading a hex from
 * `DeckEditor` through `StackView → CardStack → row` and through two more views is five props for
 * a value nobody on the path has an opinion about; reading a store inside the mark puts a
 * subscription in a component that renders once per card on a wall of two hundred.
 *
 * So the colour lives on `:root`, `index.css` holds the defaults, and this writes over them. The
 * marks name a variable and stay dumb — which is also what lets a story or a vitest render draw
 * the real colours with no provider and no seeding.
 *
 * **No Tailwind arbitrary value anywhere in it.** A mistyped `bg-[…]` emits no CSS at all and
 * fails nothing, and a mark that has quietly lost its fill is invisible to both suites.
 *
 * ## An uncustomised mark is left alone
 *
 * Absent means absent: nothing is written for a mark the reader has never chosen, so the
 * stylesheet's own value stands and a future palette change moves it. Writing today's default
 * inline would pin it forever — the cost `labelColors.ts` records for a stored label colour, paid
 * for nothing.
 */
```

`useMarkColorVars` reads the same query (same key, so one fetch) and, in an effect, sets or
removes each property on `document.documentElement`, computing the foreground with `labelFgCss`.
`labelFgCss` lives in `src/features/decks/labelColors.ts`; importing it from `src/lib/` inverts
the usual direction — **move `labelFgCss`, `normalizeLabelColor`, `labelColorCss` and `HEX` to
`src/lib/hexColor.ts` and re-export them from `labelColors.ts`** so nothing else has to change, or
keep the import and say in your report that you chose to. Either is defensible; do one of them
deliberately.

- [ ] **Step 5: Call it once**

In `src/components/AppShell.tsx`, call `useMarkColorVars()` beside whatever other app-level hooks
it already calls. One call site, at the root, for the life of the window.

- [ ] **Step 6: Run the tests**

```
npm run test:run -- src/lib/useMarkColors.test.ts
```

Expected: PASS.

- [ ] **Step 7: Mutate and confirm**

Make `resetColor` write `MARK_COLOR_DEFAULTS[key]` instead of `null`; confirm `resets by clearing`
goes red. Revert. Make `useMarkColorVars` write the default for an absent key; confirm `writes
nothing for a mark nobody has chosen` goes red. Revert.

- [ ] **Step 8: Report**

Do not commit. Report: the exported names, whether you moved `labelFgCss`, and the AppShell line.

---

## Task 8: Both marks take a tier

**Files:**
- Modify: `src/features/decks/CardMarks.tsx` — `TheoryMatchMark` (~line 290), `TheoryMatchBadge`
  (~line 411), and the doc comments above both
- Test: `src/features/decks/CardMarks.test.tsx` if it exists; otherwise assert through
  `CardStack.test.tsx` in Task 9 and say so

**Interfaces:**
- Consumes: `TheoryTier` from `./theoryMatch`.
- Produces: `<TheoryMatchMark tier={...} delta={...} variant={...} />` and
  `<TheoryMatchBadge tier={...} delta={...} />`. **`tier` is required** — a default would let a
  caller that has not thought about it draw green on a substitute.

- [ ] **Step 1: Add the prop and the paint**

Both components take `tier: TheoryTier`. Replace `"bg-pie-u text-text"` in `TheoryMatchMark` with
an inline style, and `text-pie-u` in `TheoryMatchBadge` likewise:

```tsx
      style={{
        ...(banner ? { clipPath: COUNT_TAG_SLANT_MIRRORED } : null),
        backgroundColor: `var(--color-theory-${tier === "exact" ? "exact" : "name"})`,
        color: `var(--color-theory-${tier === "exact" ? "exact" : "name"}-fg)`,
      }}
```

Write the variable names as two explicit branches rather than interpolating the tier word if that
reads better — the point is that a grep for `--color-theory-exact` finds this file.

- [ ] **Step 2: Extend `theoryMatchLabel`**

The tooltip and the `sr-only` twin say "In the theory list". A blue mark means something the reader
cannot see from those words. Give `theoryMatchLabel` the tier:

```ts
/** The word for the loose tier, and the whole of what blue adds to the sentence. */
const OTHER_PRINTING = "In the theory list · a different printing";
```

so an exact match keeps today's sentence exactly and a name match says which it is. `deckCardName`
in `cardControl.tsx` joins this clause; Task 9 owns that call site and must pass the tier through.

- [ ] **Step 3: Rewrite the colour argument in the doc**

`TheoryMatchMark`'s header records the 2026-08-20 pass that ruled green out. Replace that
paragraph — do not delete the pass, reverse it with its date:

```
 * ## The fill was one azure and is now two colours, and green is no longer disqualified
 *
 * The 2026-08-20 pass ruled `--color-ok` out in these words: *it is this app's "nothing is wrong
 * here" colour, which is the one reading a tick must not have.* That was a finding about a mark
 * meaning **this card is in the plan** — a fact, not a verdict — and it stood for as long as the
 * mark said only that.
 *
 * The mark says two things since 2026-09-07. Green is the *exact* tier: this is the printing you
 * planned, which **is** a "nothing is wrong here" verdict and is the one reading it should have.
 * Azure keeps the looser one — the same card in a printing the plan did not name — where the old
 * argument still applies, because that is a fact rather than a verdict.
 *
 * The four separations that made a tick drawable at all are untouched: the **place** (this in the
 * top-right corner, `RuleBreakMark` in the bottom-left), the **shape** (a filled mark against a
 * hairline box), the card's own **edge**, and the **colour** — green and azure are both distant
 * from destructive. A reader who sets a custom colour can defeat the fourth, which is theirs to
 * do and not the app's to prevent.
 *
 * Neither colour is a literal here any more. Both are `--color-theory-*` custom properties, so
 * the reader's own choice in Settings → Appearance moves every surface at once; `src/index.css`
 * holds the defaults and `@/lib/useMarkColors` writes over them.
```

Keep the "It **is** one of the six label colours" paragraph — still true of the azure — and add
that `#56bd78` is not.

- [ ] **Step 4: Run whatever covers these components**

```
npm run test:run -- src/features/decks/CardMarks.test.tsx
```

If that file does not exist, run `npm run test:run -- src/features/decks/CardStack.test.tsx` and
expect **failures**, because `tier` is now required and Task 9 has not landed. Say so in your
report; do not add a default to make them pass.

- [ ] **Step 5: Report**

Do not commit. Report: the two component signatures, the label constant, and which suites are red
pending Task 9.

---

## Task 9: Thread the mark through the four surfaces

**Files:**
- Modify: `src/features/decks/DeckEditor.tsx` (~line 3130, the `theoryMatchPlan` call)
- Modify: `src/features/decks/CardStack.tsx` (~lines 727, 810, 1080)
- Modify: `src/features/decks/cardControl.tsx` (~line 360, `deckCardName`)
- Modify: `src/features/decks/views/StackView.tsx` (~lines 348, 363, 739, 803, 948, 963, 1151)
- Modify: `src/features/decks/views/GridView.tsx` (~lines 75, 90, 159, 177, 188, 244, 286, 300,
  359, 460, 470)
- Modify: `src/features/decks/views/TableView.tsx` (~lines 76, 102, 117, 148)
- Test: the existing `DeckEditor.test.tsx`, `CardStack.test.tsx` and the views' tests

**Interfaces:**
- Consumes: `TheoryPlan`, `TheoryMark`, `theoryMatchMark` (Task 6); `tier` on both marks (Task 8).
- Produces: nothing new.

**The prop rename is mechanical and the type change is not.** `theoryMatches?: ReadonlyMap<string,
number>` becomes `theoryPlan?: TheoryPlan`; `theoryDelta: number | null` becomes `theoryMark:
TheoryMark | null`.

- [ ] **Step 1: Update `DeckEditor`'s call**

It calls `theoryMatchPlan(planned.data, deck.cards)`. Add the switches from the deck row:

```tsx
        ? theoryMatchPlan(planned.data, deck.cards, {
            exact: deck.theoryMarkExact,
            name: deck.theoryMarkName,
          })
```

- [ ] **Step 2: Rename the prop through the three views and `CardStack`**

`theoryMatches` → `theoryPlan`, typed `TheoryPlan | undefined`. Every `theoryMatchDelta(theoryMatches, card)`
becomes `theoryMatchMark(theoryPlan, card)`.

- [ ] **Step 3: Update the two draw sites**

`CardStack.tsx` ~line 1080 and `GridView.tsx` ~line 470:

```tsx
{theoryMark !== null && (
  <TheoryMatchMark tier={theoryMark.tier} delta={theoryMark.delta} className="ml-auto" />
)}
```

and `TableView`'s `TheoryMatchBadge` likewise, plus its `sr-only` twin.

- [ ] **Step 4: Update `deckCardName`**

It takes `theoryDelta: number | null` and joins `theoryMatchLabel(delta)`. It now takes the mark
and passes the tier, so a blue card's accessible name says which tier it is. Update every caller
(grep `deckCardName(`).

- [ ] **Step 5: Add the wiring tests**

In `src/features/decks/DeckEditor.test.tsx`, beside the existing theory-mark test:

```tsx
  /**
   * The deck's two switches reach the mark. A green tick on a deck that has the exact mark off is
   * the wiring bug this is here for — a fix can be fully unit-tested in `theoryMatch.ts` and
   * still be unreachable because the editor never passed the switches down.
   */
  it("passes the deck's mark switches to the plan", async () => {
    renderEditor({ deck: deckWith({ theoryMarkExact: false, theoryMarkName: true }), /* … */ });
    // The exactly-matching card must draw the loose mark, not the exact one.
    await waitFor(() =>
      expect(screen.getByTestId(/* … */).getAttribute("data-theory-match")).toBe(/* … */),
    );
  });
```

`THEORY_MATCH_ATTR` (`data-theory-match`) is the handle both marks already carry, and a live CDP
probe uses it. **Give it the tier as its value** — `data-theory-match="exact"` / `"name"` — in
Task 8's components rather than leaving it empty, so this test and the live pass can both tell the
two apart without reading a colour. Go back and make that one-line change in `CardMarks.tsx`; note
it in your report so Task 14's docs record it.

- [ ] **Step 6: Run the deck suites**

```
npm run test:run -- src/features/decks
```

Expected: PASS. Existing tests that assert the old prop name or the old number will need updating
— that is expected work, not a signal to add a compatibility shim.

- [ ] **Step 7: Type-check**

```
npx tsc --noEmit
```

Expected: clean, except anything Tasks 10-12 own.

- [ ] **Step 8: Report**

Do not commit. Report: every file touched, the `data-theory-match` values, and any test whose
expectation you changed and why.

---

## Task 10: The two switches in deck settings

**Files:**
- Modify: `src/features/decks/DeckSettingsForm.tsx` — `DeckSettingsValue` (~line 22-47), the
  panel body (~line 203-226), and a new component beside `TheorySwitch` (~line 477)
- Modify: `src/features/decks/DeckSettingsDialog.tsx` — the patch relay (~line 297) and the value
  it builds (~line 349)
- Modify: `src/features/decks/CreateDeckDialog.tsx` — its `DeckSettingsValue` literal
- Test: `src/features/decks/DeckSettingsForm.test.tsx`, `DeckSettingsDialog.test.tsx`

**Interfaces:**
- Consumes: `Deck.theoryMarkExact` / `theoryMarkName` (Task 5).
- Produces: `DeckSettingsValue.theoryMarkExact: boolean`, `.theoryMarkName: boolean`.

- [ ] **Step 1: Write the failing test**

```tsx
  /**
   * The two marks are drawn **under** the theory switch and only while it is on. A deck with no
   * plan has nothing for either mark to compare against, so a control for them there would be a
   * switch that changes nothing — and the reader would have no way to find that out.
   */
  it("offers both mark switches only when the theory list is on", async () => {
    const { rerender } = render(<DeckSettingsForm value={value({ theoryEnabled: false })} … />);
    expect(screen.queryByRole("switch", { name: /matching printing/i })).not.toBeInTheDocument();
    rerender(<DeckSettingsForm value={value({ theoryEnabled: true })} … />);
    expect(screen.getByRole("switch", { name: /matching printing/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /different printing/i })).toBeInTheDocument();
  });

  it("reports each switch on its own", async () => {
    const onChange = vi.fn();
    render(<DeckSettingsForm value={value({ theoryEnabled: true })} onChange={onChange} … />);
    await userEvent.click(screen.getByRole("switch", { name: /different printing/i }));
    expect(onChange).toHaveBeenCalledWith({ theoryMarkName: false });
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ theoryMarkExact: expect.anything() }));
  });
```

- [ ] **Step 2: Run to verify it fails**

```
npm run test:run -- src/features/decks/DeckSettingsForm.test.tsx
```

- [ ] **Step 3: Add the fields and the control**

Two booleans on `DeckSettingsValue`, documented:

```ts
  /**
   * Whether this deck draws the **green** theory mark — a live row that is the printing the plan
   * named. See `theoryMatch.ts` for what "off" does, which is not "nothing": an exact row on a
   * deck with this off draws the blue mark instead.
   */
  theoryMarkExact: boolean;
  /** Whether this deck draws the **blue** theory mark — the same card in a printing the plan did
   *  not name. */
  theoryMarkName: boolean;
```

A `TheoryMarkSwitches` component beside `TheorySwitch`, drawn only when `value.theoryEnabled`, in
the same row idiom (`role="switch"`, `aria-checked`, `aria-labelledby` naming the heading **and**
the state word — never `aria-label`, which would replace the visible word and fail WCAG 2.5.3).
Indent it under the theory switch so the two read as one subject. Wording:

- **Matching printing** — "A green mark on a card that is the exact printing your plan names."
- **Different printing** — "A blue mark on a card your plan asks for in a different printing.
  Turning the green one off draws this one instead."

Draw each label's swatch in `var(--color-theory-exact)` / `var(--color-theory-name)` so the words
green and blue are not the only thing carrying the distinction — a reader who has recoloured them
sees their own colours here.

- [ ] **Step 4: Relay the patch**

In `DeckSettingsDialog.tsx`, beside the `patch.theoryEnabled !== undefined` line, relay both new
fields the same way, and add both to the `value` literal it builds from `row`.

- [ ] **Step 5: Fill the create dialog**

`CreateDeckDialog` builds a `DeckSettingsValue` and sends only some of it. Give both fields `true`
and send neither — a new deck's columns default to 1 in SQL, and a create that sent them would be
a second opinion about a default the schema owns.

- [ ] **Step 6: Run the suites**

```
npm run test:run -- src/features/decks/DeckSettingsForm.test.tsx src/features/decks/DeckSettingsDialog.test.tsx src/features/decks/CreateDeckDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Mutate and confirm**

Make the blue switch call `onChange({ theoryMarkExact: false })`. Confirm `reports each switch on
its own` goes red. Revert.

- [ ] **Step 8: Report**

Do not commit. Report: the two switch labels exactly as written, and the accessible names your
tests match on.

---

## Task 11: The Appearance group and the colour panel

**Files:**
- Modify: `src/features/settings/nav.ts` — `PanelId`, `GroupId`, `PANELS`, `GROUPS`
- Create: `src/features/settings/TheoryMarksPanel.tsx`
- Modify: `src/features/settings/SettingsPage.tsx` — mount it
- Test: `src/features/settings/nav.test.ts`, `src/features/settings/TheoryMarksPanel.test.tsx`

**Interfaces:**
- Consumes: `useMarkColors` (Task 7); `LabelColorPanel` / `LabelColorRow` from
  `src/features/decks/LabelColorPicker.tsx` — **read that file's exports before importing; do not
  guess a prop name.**
- Produces: `PanelId` gains `"theory-marks"` and `"labels"`; `GroupId` gains `"appearance"`.

- [ ] **Step 1: Write the failing nav test**

```ts
  /**
   * Appearance is a rail entry of its own and **not** a section of Tags. A *tag* in this app is
   * one of Scryfall's two tagger datasets; a *label* is the deckbuilder's coloured per-card mark.
   * Filing the label list under Tags would put the two words on one rail entry, which is the one
   * thing this repo's vocabulary rule forbids.
   */
  it("draws both appearance panels under their own group", () => {
    expect(visiblePanels("appearance", "", false)).toEqual(["theory-marks", "labels"]);
  });

  it("finds the colours by the words a reader would type", () => {
    for (const query of ["colour", "color", "green", "checkmark", "theory mark"]) {
      expect(visiblePanels("updates", query, false)).toContain("theory-marks");
    }
  });

  it("finds the labels without finding the tag panels", () => {
    expect(visiblePanels("updates", "label", false)).toEqual(["labels"]);
  });
```

- [ ] **Step 2: Run to verify it fails**

```
npm run test:run -- src/features/settings/nav.test.ts
```

- [ ] **Step 3: Add the group and both panels**

In `nav.ts`, add `"theory-marks"` and `"labels"` to `PanelId`, `"appearance"` to `GroupId`, then
entries in `PANELS` — **declaration order is drawing order within a group**, so put `theory-marks`
first — and a `GROUPS` entry. Place `appearance` after `tags` in the `GROUPS` literal;
`GROUP_ORDER` is `Object.keys`, so that one edit moves the rail.

```ts
  "theory-marks": {
    title: "Theory marks",
    group: "appearance",
    keywords:
      "colour color green blue tick checkmark check match plan printing deck mark customise " +
      "customize theory",
  },
  labels: {
    title: "Labels",
    group: "appearance",
    keywords: "colour color rename recolour delete swatch dot cut candidate deck card",
  },
```

```ts
  appearance: { label: "Appearance" },
```

Update the `GROUPS` doc comment: it says "The six entries in the rail" and "**Six entries and not
twelve**". Re-count both — it is seven now, and a prose-only edit routes to neither CI job, so
nothing else will catch it.

- [ ] **Step 4: Write the panel's failing test**

```tsx
  it("opens on the stylesheet's default and writes the reader's choice", async () => { … });

  /** Reset clears rather than storing today's default — see `useMarkColors`. */
  it("offers a reset that clears the stored colour", async () => {
    // …stored theoryExact = "#123456"…
    await userEvent.click(screen.getByRole("button", { name: /reset the matching-printing mark/i }));
    expect(sent).toContainEqual(["set_mark_color", { mark: "theoryExact", color: null }]);
  });

  /** The reader is watching a swatch, so a refused write says so here — unlike the rail and the
   *  list layout, which swallow theirs. */
  it("says so when the write is refused", async () => { … });

  it("says the colours are this device's", () => {
    expect(screen.getByText(/only on this device/i)).toBeInTheDocument();
  });
```

- [ ] **Step 5: Write the panel**

`TheoryMarksPanel.tsx` renders a `<SettingsSection id="theory-marks" title="Theory marks">` (read
`panelChrome.tsx` for its real props) holding, for each of the two marks: a live preview of the
mark itself (`<TheoryMatchMark tier="exact" delta={0} />` and one with a number, so the reader sees
both states), the colour control, and a Reset. Plus one line: *These colours are saved on this
device only — your paired devices keep their own.*

Use `PanelAlert` for the refusal. Reuse `LabelColorPanel`/`LabelColorRow` from
`features/decks/LabelColorPicker.tsx`, and keep its draft-then-commit behaviour: `input[type=color]`
fires all the way down a drag through the OS dialog, so a control that wrote on every change would
send one command per pixel of travel.

- [ ] **Step 6: Mount it**

In `SettingsPage.tsx`, beside the other `shown(...)` lines:

```tsx
        {shown("theory-marks") && <TheoryMarksPanel />}
```

- [ ] **Step 7: Run both suites**

```
npm run test:run -- src/features/settings/nav.test.ts src/features/settings/TheoryMarksPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Report**

Do not commit. Report: the group's position in the rail, both panel ids, and the exact prop names
you found on `LabelColorPanel` / `LabelColorRow`.

---

## Task 12: The label panel

**Files:**
- Create: `src/features/settings/LabelsPanel.tsx`, `src/features/settings/LabelsPanel.test.tsx`
- Modify: `src/features/settings/SettingsPage.tsx` — mount it

**Interfaces:**
- Consumes: `nav.ts`'s `"labels"` panel id (Task 11); `ipc.deckLabelAll`, `deckLabelCreate`,
  `deckLabelUpdate`, `deckLabelDelete` with a `null` deck (Task 5); `LabelColorButton`,
  `LabelColorPanel`, `LabelSwatch` from `features/decks/LabelColorPicker.tsx`; `RenameField`,
  `RowAction`, `META_FIELD`, `META_SUBMIT`, `CONFIRM_DESTRUCTIVE`, `CONFIRM_CANCEL`,
  `sectionFailure`, `useConfirmFocus` from `features/decks/metaRows.tsx`.
- Produces: nothing.

**Read `src/features/decks/LabelsDialog.tsx` first.** This panel is its second section — *every
other label* — standing alone, with the deck-scoped first section and the Remove action gone,
because Settings has no deck.

- [ ] **Step 1: Write the failing tests**

```tsx
  it("lists every label the reader owns", async () => { … });

  it("adds a label with no deck", async () => {
    await userEvent.type(screen.getByRole("textbox", { name: /new label/i }), "Cut candidate");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(sent).toContainEqual([
      "deck_label_create",
      { deckId: null, name: "Cut candidate", color: "#d9b95c" },
    ]);
  });

  /**
   * **Delete says how far it reaches before it goes.** A label is one app-wide row, so deleting it
   * from here strips it off cards in every deck wearing it — and this panel, unlike the editor's
   * dialog, is not standing inside any one of them. `GlobalLabel.deckCount` is what makes that
   * sentence sayable.
   */
  it("names the decks a delete reaches before deleting", async () => {
    // …a label with deckCount 3…
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(screen.getByText(/3 decks/)).toBeInTheDocument();
  });

  it("recolours without renaming and renames without recolouring", async () => { … });

  /** An empty list is the state a reader who has never made a label is in, and it is who this
   *  screen is hardest for. */
  it("says what a label is when there are none", async () => {
    expect(screen.getByText(/labels are yours/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

```
npm run test:run -- src/features/settings/LabelsPanel.test.tsx
```

- [ ] **Step 3: Write the panel**

A `<SettingsSection id="labels" title="Labels">` holding an add row first (a reader with no labels
is who this is hardest for — `LabelsDialog`'s own rule), then every label from `deckLabelAll`, each
with a swatch that opens the picker, a rename field, and Delete behind a confirm that names the
deck count.

`deckLabelUpdate` renames **and** recolours in one command with no patch shape, so each half sends
the other back unchanged — copy `LabelsDialog`'s handling rather than inventing a patch.

Note in a doc comment what a deckless write does not do:

```
 * ## What a label edited from here does not do
 *
 * It writes no deck history and no undo step. Both of those hang off a `deck_id`, and a rename
 * that reaches every deck wearing the label belongs to none of them — attributing it to one would
 * be a false entry and attributing it to all is a feature nobody asked for. The deck editor's own
 * dialog is unchanged and still records everything it always did. `deck_meta.rs`'s
 * `a_deckless_label_write_records_no_audit_and_no_undo` is the test that says so out loud.
```

- [ ] **Step 4: Mount it**

```tsx
        {shown("labels") && <LabelsPanel />}
```

- [ ] **Step 5: Run the suite**

```
npm run test:run -- src/features/settings/LabelsPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Check the editor's dialog still works**

```
npm run test:run -- src/features/decks/LabelsDialog.test.tsx
```

Expected: PASS, untouched.

- [ ] **Step 7: Report**

Do not commit. Report: the confirm's wording, and whether anything in `metaRows.tsx` had to change
to be usable outside the decks feature (it should not have).

---

## Task 13: Stories

**Files:**
- Modify: `src/features/decks/CardStack.stories.tsx`, `views/StackView.stories.tsx`,
  `views/GridView.stories.tsx`, `views/TableView.stories.tsx`, `DeckSettingsForm.stories.tsx`
- Create: `src/features/settings/TheoryMarksPanel.stories.tsx`,
  `src/features/settings/LabelsPanel.stories.tsx`
- Test: `npm run test:run -- src/stories.test.tsx` **only after fan-in** — a story test collects
  the whole tree and fails for its siblings' reasons mid-fan-out.

**Interfaces:**
- Consumes: everything Tasks 6-12 produced. The Storybook fake is `.storybook/`'s — read
  `.storybook/CLAUDE.md` before adding a seed or a fault.

- [ ] **Step 1: Read the conventions**

The `mtg-grimoire-sb-mcp` MCP server is configured. If it connects, call
`get-storybook-story-instructions` and follow it. **If it does not connect, say so in your report
and follow the conventions in `.storybook/CLAUDE.md` and the neighbouring story files instead** —
do not invent props for a design-system component you have not verified.

- [ ] **Step 2: Update the existing deck stories**

The four view stories set `args: { theoryMatches: deckTheoryMatches() }`. Rename to `theoryPlan`
and change the fake's helper to build a `TheoryPlan` — find `deckTheoryMatches` in
`.storybook/` and give it both maps plus `marks: { exact: true, name: true }`.

- [ ] **Step 3: Add a story per tier**

One story showing a wall with both marks on it — an exactly-matched card, a substitute printing, a
card with a shortfall on each tier — so the workbench shows the two colours side by side. And one
with the exact switch off, showing the fallback.

- [ ] **Step 4: Story the two panels**

Default, a customised colour, an empty label list, and a refused write for the colour panel.

- [ ] **Step 5: Report**

Do not commit. Do not run the story suite. Report: story names added, and whether the MCP server
connected.

---

## Task 14: The record

**Files:**
- Modify: `docs/reference/frontend-design.md` — the 2026-08-20 theory-mark colour pass
- Modify: `docs/reference/decks-storage.md` — the two deck columns, the label commands' optional
  deck and what a deckless write skips
- Modify: `docs/reference/data-and-sync.md` — the schema ladder gains v35
- Modify: `src/features/decks/CLAUDE.md` — the tier rule and the switches
- Modify: `src/CLAUDE.md` — the four `--color-theory-*` properties, if it lists custom properties
- Modify: `src-tauri/CLAUDE.md` — v35 and `markcolors.rs`
- Modify: root `CLAUDE.md` — the reference-docs table, only if a new doc is added

- [ ] **Step 1: Reverse the colour finding where it is recorded**

`frontend-design.md` holds the 2026-08-20 pass that photographed four candidates and ruled green
out. **Do not delete it.** Add the 2026-09-07 reversal beneath it with its reasoning: the finding
was about a mark that meant *this card is in the plan*, and green is now the *exact* tier, which is
a verdict and should read as one. Record `#56bd78` and where it came from.

- [ ] **Step 2: Write down what the switches do**

In `src/features/decks/CLAUDE.md`, the tier table from the spec, the fallback rule, and the one
property the land case turns on: the maps are read, never consumed, so every row of a matching name
is marked.

- [ ] **Step 3: Record the sync asymmetry**

In `decks-storage.md` or `data-and-sync.md`, whichever holds the synced-tables list: the two deck
columns travel; the colours do not, because `app_meta` is not in `SYNCED_TABLES`. State it as a
design decision, not an omission.

- [ ] **Step 4: Re-count anything you touched**

A prose-only edit routes to neither CI job. If you changed a list or a count — the settings rail's
"six entries", a table of `app_meta` settings that says "seven" — re-count it in the same edit.
Grep for `seven` and `six` in the files you touch.

- [ ] **Step 5: Report**

Do not commit. Report: every file, and every count you re-counted.

---

## Task 15: Verify and drive the real window

**Owner:** the dispatcher, after every other task has reported. Not a subagent.

- [ ] **Step 1: Fan-in review**

Read every subagent's report. Grep for any symbol a report names against the tree, because
`git grep` skips untracked files and a wiring sweep mid-fan-out misses every new one. Confirm
nothing is tested-but-unwired: `theoryMatchMark` must be reachable from `DeckEditor`, and
`useMarkColorVars` from `AppShell`.

- [ ] **Step 2: Line endings**

```
git diff --stat
```

A subagent write can flip a file to CRLF, which breaks source-parsing tests locally while CI stays
green. Check any file whose diff is suspiciously whole-file.

- [ ] **Step 3: Verify**

```
npm run verify
```

Never with a pipe — `| tail` reports tail's exit code while tests fail. Never concurrently with
another verify — two at once fake ~18 Rust schema failures.

- [ ] **Step 4: The two verify does not run**

```
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

These are the only reds obtainable from a fully green `npm run verify`.

- [ ] **Step 5: Commit**

One commit per coherent slice, or one for the feature. `feat(decks): draw the theory mark in two
tiers` and siblings.

- [ ] **Step 6: Drive the real window**

Take the app lock through `.claude/skills/running-the-app/lock.ps1`, run `npm run tauri dev`, and
drive it over `scripts/cdp.mjs` from **PowerShell** (Bash refuses `cdp.mjs eval` in a worktree as
unverifiable). `docs/reference/live-ui-verification.md` is the contract. Confirm, on a real deck
with a theory list:

1. A card that matches the plan's printing draws a green mark; `data-theory-match` reads `exact`.
2. A different printing of a planned card draws blue; the attribute reads `name`.
3. **Eight basic lands over several printings all carry a mark** — count the marks, do not eyeball
   a screenshot.
4. Turning the green switch off in deck settings turns those cards blue rather than blank.
5. A colour changed in Settings → Appearance moves the mark on the deck screen without a restart.
6. A label renamed in Settings → Appearance shows the new name in the deck editor.

Copy the real `data` folder into the worktree's `src-tauri/target/debug/` first, or the window has
no decks to look at.

- [ ] **Step 7: Ship**

Use the `auto-pr` skill. The agent does not press Merge.

**The PR body must contain `Closes #386`, and it will not get there by itself.** `pr-auto.ps1 open`
fills the body with `--fill`, which keeps a `Closes #N` trailer when the branch has exactly one
non-merge commit and **drops it at two or more** — and this branch will have many. So pass the body
explicitly rather than trusting the fill, and verify after opening:

```
gh pr view --json body --jq .body | Select-String "Closes #386"
```

If it is missing, `gh pr edit <n> --body-file <file>` before arming auto-merge. A merged PR that
never closed the issue is the failure this step exists to prevent.

---

## Self-review

**Spec coverage.** §1.1 tier table → Task 6. §1.2 name key → Tasks 1, 6. §1.3 switches and
fallback → Tasks 2, 6, 10. §1.4 invariants → Task 6's tests. §2 domain module → Task 6. §3 Rust
slot and the fold → Task 1. §4 schema → Task 2. §5.1 CSS properties → Task 7. §5.2 storage → Task
3. §5.3 defaults and the reversal → Tasks 7, 8, 14. §6 Appearance group → Tasks 11, 12. §7 testing
→ each task's own steps plus Task 15. §8 out of scope → nothing added.

**One spec gap found and closed:** the spec left the label commands' `deckId` as an open question
("check whether it is load-bearing; if it is, report rather than work around"). It **is** — it
drives `touch_deck`, the audit row and the undo step — so Task 4 makes it optional and Task 12
documents what a deckless write does not do. That is a decision the spec deferred and this plan
makes; it is worth the reader's eye.

**Type consistency.** `TheoryPlan` / `TheoryMark` / `TheoryTier` / `theoryMatchMark` /
`theoryNameKey` / `theoryMatchPlan` are spelled identically in Tasks 6, 8, 9, 10. `nameKey`
(wire) ↔ `name_key` (Rust) in Tasks 1 and 5. `theoryMarkExact` / `theoryMarkName` (wire) ↔
`theory_mark_exact` / `theory_mark_name` (Rust/SQL) in Tasks 2, 5, 9, 10. `mark` and `color` are
the command's argument names in Tasks 3, 5, 7, 11 — not `key`, which is what the map's TS type
calls them.

**Placeholders.** Every fixture helper named as a placeholder (`deck_with_theory`, `deck_fixture`,
`audit_count`, `mockIpc`, `card()`) is flagged in its own step with an instruction to use the
neighbouring tests' real name instead. That is deliberate: inventing names for helpers that may
already exist under other names is how a task ends with a second fixture nobody reuses.
