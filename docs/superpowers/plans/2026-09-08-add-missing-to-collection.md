# Add missing to collection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deck-wide `Add missing to collection` press in the deck editor's stats band that
previews every copy the live list is short of and records the ticked ones into the deck's own
collection folder, taking unambiguous wishlist lines down with them.

**Architecture:** Rust answers *facts* — one shortfall walk (`deck::live_shortfall`) now shared by
three callers, plus a new `deck_missing` module holding a read (`deck_missing_plan`) and an
all-or-nothing write (`deck_missing_to_collection`) that re-plans inside its own transaction.
TypeScript draws the *conclusion* — a pure `addMissingPlan.ts` derives what the press will do from
the backend's rows plus the reader's departures from them, and a query-free dialog draws it.

**Tech Stack:** Rust + rusqlite (SQLite, WAL), Tauri 2.11 commands; React 19 + TypeScript 6,
TanStack Query, Tailwind, Vitest + Testing Library, Storybook.

**Spec:** [`docs/superpowers/specs/2026-09-08-add-missing-to-collection-design.md`](../specs/2026-09-08-add-missing-to-collection-design.md)
— read it before starting any task. Branch `worktree-send-deck-to-collection`.

## Global Constraints

- **No schema change.** `USER_SCHEMA_VERSION` is not touched. No new `deck_audit.kind` — the
  press reuses `move` with a `{"quickAdd": …}` payload, so `AUDIT_KINDS` stays at nine.
- **The button reads exactly `Add missing to collection`.** The dialog heading is the same six
  words. Do not respell it as "Send…", "Record…" or "Add all…".
- **The wire names are `deck_missing_plan` and `deck_missing_to_collection`.**
- **Each task owns the files listed under it and touches no others.** The tree and the git index
  are shared with sibling agents.
- **Do not run test suites and do not run any git command.** Not `npm run verify`, not
  `cargo test`, not `git add`/`commit`/`status`. The dispatcher runs the suites once after
  fan-in. Report what you changed instead.
- **Two verbs that must never trade places:** a **label** is the deckbuilder's coloured per-card
  mark (`deck_labels`); a **tag** is a Scryfall tagger term. Neither appears in this feature.
- **`src/features/decks/auditText.ts` needs no change and must not get one.** Its `quickAddLine`
  already renders this payload as *"Recorded N copies for this deck"* + *"M copies off your
  wishlist"*, which reads correctly for a batch.
- **Four things are deliberately out of scope** (spec §7) — do not add them because they look
  like an omission: no purchase price, source or acquired-at on the recorded copies; no per-row
  wish picker; no mark on rows the reader could pull instead; no entrance in `DeckSettingsDialog`.
- Never install `@types/node`. TypeScript stays on 6.0.x.
- Rust doc comments in this crate carry the *reasoning*, not a restatement of the signature.
  Match the density of the module you are editing — `deck_pull.rs` and `deck_quick_add.rs` are
  the two neighbours to imitate.

---

## Wave plan

Dispatch **Wave 1 in one message** (five agents, no shared files), then **Wave 2** (three agents),
then fan in.

| Wave | Tasks | Why they can run together |
| --- | --- | --- |
| 1 | T1, T3, T4, T6, T8 | Disjoint files; T3/T4/T8 build against the wire contract written out in this plan rather than against each other's code |
| 2 | T2, T5, T7 | T2 needs T1's `ShortfallRow`; T5 and T7 need T3's types and T4's plan API, all spelled out below |
| fan-in | `npm run verify`, then T9, then the live pass | — |

---

### Task 1: `deck::live_shortfall` — one shortfall walk, three callers

**Files:**
- Modify: `src-tauri/src/deck.rs` (add `ShortfallRow` + `live_shortfall`; refactor
  `missing_to_wishlist` at `:4610`)
- Modify: `src-tauri/src/deck_pull.rs` (refactor `plan` at `:305`)
- Test: the `#[cfg(test)]` modules already at the bottom of both files

**Interfaces:**
- Consumes: nothing.
- Produces — Task 2 depends on these exact names:

```rust
// in src-tauri/src/deck.rs
#[derive(Debug, Clone)]
pub struct ShortfallRow {
    pub card_id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub finish: Option<String>,
    pub short: i64,
    pub categories: Vec<String>,
    pub image_uris: Option<std::collections::BTreeMap<String, String>>,
}

pub fn live_shortfall(conn: &Connection, deck_id: i64) -> Result<Vec<ShortfallRow>, String>;
```

**This is a pure refactor. No command, no wire, no behaviour change.** Its whole fence is that
every existing test in both files passes untouched.

- [ ] **Step 1: Read the two functions being merged**

`src-tauri/src/deck_pull.rs:305-365` (`plan`) and `src-tauri/src/deck.rs:4610-4654`
(`missing_to_wishlist`). Note what they share: `get_deck(conn, deck_id, LIVE,
Marketplace::default())`, `.ok_or_else(|| GONE.to_owned())`, `if !card.category_active
{ continue }`, `let short = card.quantity - card.owned_quantity; if short <= 0 { continue }`.
Note what differs: the fold grain, and the wishlist's extra `oracle_id` skip.

- [ ] **Step 2: Add `ShortfallRow` and `live_shortfall` to `deck.rs`**

Place them directly above `missing_to_wishlist`. The body is `deck_pull::plan`'s fold verbatim —
the `Vec` + `HashMap<(String, Option<String>), usize>` shape, **not** a `BTreeMap`, because the
answer must keep the deck's own read order:

```rust
pub fn live_shortfall(conn: &Connection, deck_id: i64) -> Result<Vec<ShortfallRow>, String> {
    let detail = get_deck(conn, deck_id, LIVE, crate::sorting::Marketplace::default())?
        .ok_or_else(|| GONE.to_owned())?;

    let mut rows: Vec<ShortfallRow> = Vec::new();
    let mut at: HashMap<(String, Option<String>), usize> = HashMap::new();
    for card in &detail.cards {
        if !card.category_active {
            continue;
        }
        let short = card.quantity - card.owned_quantity;
        if short <= 0 {
            continue;
        }
        let key = (card.card_id.clone(), card.finish.clone());
        match at.get(&key).copied() {
            Some(i) => {
                rows[i].short += short;
                if !rows[i].categories.iter().any(|c| c == &card.category_name) {
                    rows[i].categories.push(card.category_name.clone());
                }
            }
            None => {
                at.insert(key, rows.len());
                rows.push(ShortfallRow {
                    card_id: card.card_id.clone(),
                    oracle_id: card.oracle_id.clone(),
                    name: card.name.clone(),
                    set_code: card.set_code.clone(),
                    collector_number: card.collector_number.clone(),
                    finish: card.finish.clone(),
                    short,
                    categories: vec![card.category_name.clone()],
                    image_uris: card.image_uris.clone(),
                });
            }
        }
    }
    Ok(rows)
}
```

Its doc comment must carry three things, because they are the load-bearing claims: the read order
is the deck's own and callers that want another order sort what they are given; the grain is
`(card_id, finish)` and an inactive pile is short of nothing; and **folding twice equals folding
once** — `oracle_id` is a property of the `cards` row, so every bucket of one printing carries the
same one and summing per pair then per oracle id is the same sum.

- [ ] **Step 3: Refactor `missing_to_wishlist` onto it**

Replace its `get_deck` call and its `for row in &detail.cards` loop with a fold over
`live_shortfall(&tx, deck_id)?`. Everything after — the `BTreeMap`, `add_wish`, `touched`,
`tx.commit()` — is unchanged:

```rust
    let mut missing: BTreeMap<String, (String, i64)> = BTreeMap::new();
    for row in live_shortfall(&tx, deck_id)? {
        let Some(oracle_id) = row.oracle_id else {
            continue;
        };
        let entry = missing.entry(oracle_id).or_insert_with(|| (row.name.clone(), 0));
        entry.1 += row.short;
    }
```

The `BTreeMap` sorts by key regardless of arrival order, so `add_wish` is still called in
oracle-id order and `touched` is the same count. **Do not change the transaction boundary** —
`live_shortfall` takes `&tx`, which is a `&Connection`.

- [ ] **Step 4: Refactor `deck_pull::plan` onto it**

`plan` keeps its `PullRow`, its `CANDIDATE_SQL` prepare, its per-row `candidates(…)` call and its
`rows.retain(|row| !row.candidates.is_empty())`. Only the fold is replaced:

```rust
pub fn plan(conn: &Connection, deck_id: i64) -> Result<Vec<PullRow>, String> {
    let mut rows: Vec<PullRow> = crate::deck::live_shortfall(conn, deck_id)?
        .into_iter()
        .map(|s| PullRow {
            card_id: s.card_id,
            name: s.name,
            set_code: s.set_code,
            collector_number: s.collector_number,
            finish: s.finish,
            short: s.short,
            categories: s.categories,
            image_uris: s.image_uris,
            candidates: Vec::new(),
        })
        .collect();

    let mut stmt = conn.prepare(CANDIDATE_SQL).map_err(|e| e.to_string())?;
    for row in &mut rows {
        row.candidates = candidates(&mut stmt, &row.card_id, row.finish.as_deref())?;
    }
    rows.retain(|row| !row.candidates.is_empty());
    Ok(rows)
}
```

Move the fold's explanatory comments (the `HashMap`-not-`BTreeMap` note, the inactive-pile note,
the "named once each" note) **to `live_shortfall`** rather than deleting them, and leave a line in
`plan`'s own doc pointing at it. Drop the now-unused `HashMap` import from `deck_pull.rs` if
nothing else there uses it (`BTreeMap` is still used).

- [ ] **Step 5: Add three tests for `live_shortfall` in `deck.rs`'s test module**

Follow the fixtures already in that module. Cover: an inactive pile contributes nothing; one
printing short in two active piles folds to one row whose `short` is the sum and whose
`categories` names both; the returned order is the deck's read order (category, then name, then
row id) rather than card-id order.

- [ ] **Step 6: Report**

Do not run tests. Report: the two functions refactored, the three tests added, and any existing
test whose text you had to touch (there should be none — say so explicitly if there is one).

---

### Task 2: `deck_missing` — the read, the write, and the registration

**Files:**
- Create: `src-tauri/src/deck_missing.rs`
- Modify: `src-tauri/src/deck_quick_add.rs` (extract `record_copies`; `quick_add`'s step 5 calls it)
- Modify: `src-tauri/src/lib.rs` (declare `mod deck_missing;`)
- Modify: `src-tauri/src/desktop.rs` (register both commands, beside the pull's pair at `:394`)
- Modify: `src-tauri/src/web/route.rs` (the name list near `:134` **and** the dispatch `match`
  near `:1307`)
- Test: `#[cfg(test)]` at the bottom of `deck_missing.rs`

**Interfaces:**
- Consumes: `deck::ShortfallRow` and `deck::live_shortfall` from Task 1 (signature above).
- Produces — the wire contract Task 3 mirrors and Task 8 fakes:

```rust
pub struct MissingRow {          // serde camelCase
    pub card_id: String, pub name: String, pub set_code: String,
    pub collector_number: String, pub finish: Option<String>, pub short: i64,
    pub categories: Vec<String>,
    pub image_uris: Option<BTreeMap<String, String>>,
    pub wishes: Vec<crate::deck_quick_add::QuickAddWish>,
}
pub struct MissingPick {         // serde camelCase, Deserialize
    pub card_id: String, pub finish: Option<String>, pub quantity: i64,
}
pub struct MissingOutcome {      // serde camelCase
    pub copies: i64, pub cards: i64, pub wish_copies: i64,
}
pub fn plan(conn: &Connection, deck_id: i64) -> Result<Vec<MissingRow>, String>;
pub fn to_collection(conn: &Connection, deck_id: i64, picks: &[MissingPick],
                     clear_wishes: bool) -> Result<MissingOutcome, String>;
```

- [ ] **Step 1: Read the two neighbours whose shape this copies**

`src-tauri/src/deck_pull.rs` (module header, error constants, `plan`, `from_collection`, the
`pub mod commands` block) and `src-tauri/src/deck_quick_add.rs` (`quick_add`'s seven-step doc,
`take_wish`, `wishes`, `WISH_SQL`, its `commands` block). This module is their child and should
read like it — including a module header that argues *why* this write is a create and not a move.

- [ ] **Step 2: Extract `record_copies` in `deck_quick_add.rs`**

The one piece genuinely written twice. Place it below `quick_add`:

```rust
/// File copies into a deck's group — the one spelling of the `EntryInput` a deck-boundary
/// *create* uses.
///
/// **`..Default::default()` rather than explicit empties**, so a column added to `EntryInput`
/// later does not need a line here to keep meaning "the reader did not say": a menu press and a
/// batch record *copies*, and a purchase price or an acquisition source either of them invented
/// would be provenance nobody entered.
///
/// The grain fold is [`crate::collection::add_entry_filed`]'s: the folder is `COLLECTION_GRAIN`'s
/// eleventh term, so a second press on the same line raises the row already in the group rather
/// than making a second one.
///
/// The finish arrives already translated into the **collection's** spelling — the caller has run
/// [`crate::deck::normalise_finish`] and defaulted to [`NONFOIL`] — because both callers need
/// that word for their wishlist half too and a second translation is a second thing to drift.
pub(crate) fn record_copies(
    tx: &Connection,
    group: i64,
    card_id: &str,
    finish: &str,
    condition: Option<&str>,
    quantity: i64,
) -> Result<crate::collection::EntryChange, String> {
    let input = crate::collection::EntryInput {
        card_id: card_id.to_owned(),
        finish: finish.to_owned(),
        condition: condition.map(str::to_owned),
        quantity,
        folder_id: Some(group),
        ..Default::default()
    };
    crate::collection::add_entry_filed(tx, &input, crate::collection::DECK_WRITE_FOLDERS)
}
```

Replace `quick_add`'s step-5 block (the `let input = …` + `add_entry_filed` call) with
`let change = record_copies(&tx, group, card_id, &finish, condition, quantity)?;`. Keep step 5's
existing comment by moving its substance into the new doc above, and leave `quick_add`'s numbered
doc list saying step 5 is `record_copies`. **Change nothing else in `quick_add`** — its
`plays_card` fence, its `take_wish` call, its audit row and its outcome stay exactly as they are.

- [ ] **Step 3: Create `deck_missing.rs` with its header and constants**

Module header must argue: this is the deck-wide form of `quick_add`; it *creates* cardboard where
`deck_pull` *moves* it; the pick is addressed by `(card_id, finish)` because the row does not
exist yet; and the write is all-or-nothing because it files no `deck_undo` step.

```rust
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

/// Reused verbatim rather than respelled — this crate's standing rule.
use crate::deck_pull::{MORE_THAN_MISSING, NOT_SHORT_OF_THAT};

/// What [`to_collection`] says when it was handed an empty list.
///
/// [`crate::deck_pull::NOTHING_PICKED`]'s refusal with this press's verb: that one says "pull
/// into this deck", and a batch that records nothing is a different sentence about the same
/// mistake. Refused rather than answered with a zero outcome, because a caller that reaches
/// this has lost track of what the reader ticked.
pub const NOTHING_PICKED: &str = "Pick at least one copy to add to your collection.";

/// What [`to_collection`] says about a pick whose printing has left `cards`.
///
/// A corpus resync under an open dialog. Distinct from [`NOT_SHORT_OF_THAT`], which is about the
/// **deck** — the copies could be recorded and it does not want them — where this is about the
/// **card**: [`crate::collection::add_entry_filed`] reads `set_code`, `collector_number` and
/// `lang` off the `cards` row, so a printing that is gone cannot be filed at all.
pub const LEFT_THE_DATABASE: &str =
    "That printing has left the card database and cannot be recorded.";

/// `FINISHES[0]` — the word [`crate::deck::normalise_finish`] maps *away* on a deck row and the
/// one `collection_entries.finish` stores for a plain copy.
const NONFOIL: &str = crate::schema::FINISHES[0];
```

- [ ] **Step 4: Write `plan`**

```rust
pub fn plan(conn: &Connection, deck_id: i64) -> Result<Vec<MissingRow>, String> {
    let shortfall = crate::deck::live_shortfall(conn, deck_id)?;
    // One prepared statement for the whole plan rather than one per row — `deck_pull::plan`'s
    // rule about `CANDIDATE_SQL`, for the same reason.
    let mut known = conn
        .prepare("SELECT 1 FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    let mut rows = Vec::new();
    for row in shortfall {
        // **The one filter, and it is the write's own precondition rather than a second
        // opinion**: `collection::add_entry_filed` reads the printing off `cards`, so a row
        // this drops is exactly a row the write would have refused. A row the dialog could only
        // draw as an apology is left out — `deck_pull::plan`'s rule about an empty candidate
        // list, applied to a different reason for the same emptiness.
        //
        // **Narrower than `missing_to_wishlist`'s `oracle_id.is_none()` and deliberately so:** a
        // `cards` row can exist with a NULL `oracle_id`, which no wish can be written for and
        // which a collection entry records perfectly well.
        let exists = known
            .exists(rusqlite::params![&row.card_id])
            .map_err(|e| e.to_string())?;
        if !exists {
            continue;
        }
        let wishes = crate::deck_quick_add::wishes(conn, &row.card_id, row.finish.as_deref())?;
        rows.push(MissingRow {
            card_id: row.card_id,
            name: row.name,
            set_code: row.set_code,
            collector_number: row.collector_number,
            finish: row.finish,
            short: row.short,
            categories: row.categories,
            image_uris: row.image_uris,
            wishes,
        });
    }
    Ok(rows)
}
```

`MissingRow::wishes` gets a doc saying it is `deck_quick_add::wishes`' answer verbatim — the same
function the per-card menu calls, so the two entrances cannot come to disagree about what fills a
wish — and that empty is the ordinary answer.

- [ ] **Step 5: Write `to_collection`**

Eight steps, in this order, each carrying the doc line that says why it is where it is (§3.4 of
the spec is the source text):

```rust
pub fn to_collection(
    conn: &Connection,
    deck_id: i64,
    picks: &[MissingPick],
    clear_wishes: bool,
) -> Result<MissingOutcome, String> {
    // 1. Before the transaction opens: a refusal that has already begun a write is a rollback
    //    the reader pays for.
    if picks.is_empty() {
        return Err(NOTHING_PICKED.to_owned());
    }
    // Sum duplicate picks for one key *before* checking, so two picks of 3 against a shortfall
    // of 4 are one refusal and not two accepted writes. Insertion order is kept so the audit
    // and the outcome describe the plan's order rather than a hash order.
    let mut wanted: Vec<((String, String), i64)> = Vec::new();
    let mut at: HashMap<(String, String), usize> = HashMap::new();
    for pick in picks {
        if pick.quantity <= 0 {
            return Err(crate::collection::ZERO_ADD.to_owned());
        }
        let finish = crate::deck::normalise_finish(pick.finish.as_deref())?
            .unwrap_or_else(|| NONFOIL.to_owned());
        let key = (pick.card_id.clone(), finish);
        match at.get(&key).copied() {
            Some(i) => wanted[i].1 += pick.quantity,
            None => {
                at.insert(key.clone(), wanted.len());
                wanted.push((key, pick.quantity));
            }
        }
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // 2. The deck fence, and the stamp this press owes on its own account: what the deck holds
    //    moved. A stale editor hears `deck::GONE` rather than something about cards.
    crate::deck::touch_deck(&tx, deck_id)?;
    // 3. One group per deck since schema v25 — `None` is a hand-edited database, and filing at
    //    the root would record copies no deck claims.
    let group = crate::deck::deck_group(&tx, deck_id)?
        .ok_or_else(|| crate::collection_alloc::NO_DECK_GROUP.to_owned())?;

    // 4. The dialog's answer is a round trip old. `deck_pull::from_collection`'s discipline:
    //    nothing the caller sent is trusted, and the re-plan is the fence that subsumes
    //    `plays_card` — a card the deck does not play has no shortfall row.
    let current = plan(&tx, deck_id)?;
    let mut short_at: HashMap<(&str, String), i64> = HashMap::new();
    for row in &current {
        let finish = crate::deck::normalise_finish(row.finish.as_deref())?
            .unwrap_or_else(|| NONFOIL.to_owned());
        short_at.insert((row.card_id.as_str(), finish), row.short);
    }

    // 5. Every pick checked *before* anything is written, so a refusal on the last one has not
    //    already inserted the first.
    for ((card_id, finish), quantity) in &wanted {
        match short_at.get(&(card_id.as_str(), finish.clone())) {
            Some(short) if quantity <= short => {}
            Some(_) => return Err(MORE_THAN_MISSING.to_owned()),
            None => {
                // Told apart because they are two different things for a stale dialog to hear.
                let known: bool = tx
                    .query_row("SELECT 1 FROM cards WHERE id = ?1", rusqlite::params![card_id],
                               |_| Ok(true))
                    .optional()
                    .map_err(|e| e.to_string())?
                    .unwrap_or(false);
                return Err(if known { NOT_SHORT_OF_THAT } else { LEFT_THE_DATABASE }.to_owned());
            }
        }
    }

    // 6, 7. Record, then the wish — per row, inside the one transaction.
    let mut copies = 0i64;
    let mut wish_copies = 0i64;
    for ((card_id, finish), quantity) in &wanted {
        // **`None` for the condition, rather than a constant spelled here.**
        // `collection::valid_condition` turns an absent one into
        // `collection::DEFAULT_CONDITION` already, so the batch *says nothing* about a grade —
        // which is the truth: nobody was asked. A constant at this call site would be a second
        // place to keep in step with a default that has moved once already (schema v35).
        crate::deck_quick_add::record_copies(&tx, group, card_id, finish, None, *quantity)?;
        copies += quantity;
        if clear_wishes {
            wish_copies += take_lone_wish(&tx, card_id, finish, *quantity)?;
        }
    }

    // 8. One row for the press, not N — the reader did one thing.
    crate::deck_audit::record(
        &tx, deck_id, crate::schema::DECK_VARIANTS[0], crate::deck_audit::MOVE, None,
        &json!({ "quickAdd": { "copies": copies, "wishes": wish_copies } }), 0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MissingOutcome { copies, cards: wanted.len() as i64, wish_copies })
}
```

**On the condition:** `collection::DEFAULT_CONDITION` and `collection::CONDITION_NOT_SET`
(`src-tauri/src/collection.rs:46` and `:64`) are the same string under two names, and
`valid_condition` (`:331`) already does `condition.unwrap_or(DEFAULT_CONDITION)`. So pass `None`
and spell neither. Do **not** reach for `crate::schema::` — the condition vocabulary is not there.

- [ ] **Step 6: Write `take_lone_wish`**

```rust
/// Take copies off this printing's wish, but **only when exactly one line matches**.
///
/// `quick_add` is *pointed at* a wish and so can be stale about one — hence its [`WISH_GONE`]
/// and [`WISH_WRONG_CARD`]. This press chooses inside the transaction instead, because a
/// deck-wide batch over thirty rows cannot ask thirty questions and the design settled on no
/// nested picker. So there is **no stale-wish refusal here**: a line that vanished under the
/// dialog is simply not among the matches, and the press carries on.
///
/// None, or two or more, is left alone — and the dialog said so beside the row before the press,
/// so the reader is not surprised by what did not happen.
fn take_lone_wish(tx: &Connection, card_id: &str, finish: &str, quantity: i64)
    -> Result<i64, String>
```

Body: `crate::deck_quick_add::wishes(tx, card_id, Some(finish))?`; if `len() != 1` return `Ok(0)`;
else `take = quantity.min(wish.quantity)`, then `DELETE` when `take >= wish.quantity` (the column
is `CHECK (quantity > 0)`, so a wish taken to nothing has to go) else
`UPDATE … SET quantity = quantity - ?, updated_at = unixepoch()`. Return `take`.

Note the finish translation: `wishes` takes the **deck's** spelling and normalises internally, and
this hands it the collection's word. `normalise_finish` maps `Some("nonfoil")` → `None` →
`NONFOIL`, so the round trip is stable; confirm that by reading `normalise_finish` and say in the
doc which spelling crosses the call.

- [ ] **Step 7: Write the `commands` module**

`deck_pull::commands`' shape exactly. `deck_missing_plan` takes a **read** connection
(`crate::sync::lock_db_read`) and no marketplace — nothing in the answer is priced.
`deck_missing_to_collection` takes **`crate::collection_source::with_write_owned`**, not bare
`with_write`: the facet index's `owned` dimension counts `collection_entries` rows and this
command makes several in one press. Both `#[cfg(not(target_family = "wasm"))]`, both
`spawn_blocking`, error text `"the plan could not be read: {e}"` / `"the copies could not be
recorded: {e}"`.

- [ ] **Step 8: Register the module and both commands**

1. `src-tauri/src/lib.rs`: add `mod deck_missing;` in the alphabetical run beside `mod
   deck_meta;`. **This step is not optional and not cosmetic** — an undeclared module compiles to
   nothing and every test in it silently never runs.
2. `src-tauri/src/desktop.rs:~394`: add `deck_missing::commands::deck_missing_plan,` and
   `deck_missing::commands::deck_missing_to_collection,` beside the pull's pair, with the same
   one-line comment about `generate_handler!` taking the last path segment.
3. `src-tauri/src/web/route.rs`: add both names to the list near `:134` **and** both arms to the
   dispatch `match` near `:1307`. Copy the `deck_pull_plan` and `deck_quick_add_to_collection`
   arms' argument-extraction shape; `picks` deserialises as `Vec<MissingPick>` and `clearWishes`
   as a `bool`.

- [ ] **Step 9: Tests in `deck_missing.rs`**

Copy the fixture style from `deck_pull.rs`'s test module (a `memory_pair()` database, seeded
`cards`, a deck with a group). The bullets below name fourteen — this line said "twelve" while
they did, which is the miscount this repo's own rule about re-counting in the same commit exists
to catch. Eighteen were written: the four extra pin `NOTHING_PICKED`, `ZERO_ADD`, the
wish-deleted-outright arm, and the exact-shortfall boundary the mutation check demanded.

*Plan:* an inactive pile contributes nothing; one printing short in two active piles is one row
whose `short` is the sum and whose `categories` names both; an orphaned printing (a `deck_cards`
row whose `card_id` is not in `cards`) is dropped; a card row with a NULL `oracle_id` is **kept**
(the case that separates this filter from the wishlist's); a row with no matching wish is kept
with `wishes: []`.

*Write:* a partial pick records fewer than `short` and leaves the rest short; two picks of one key
are summed and refused together when they exceed `short`; a pick above `short` gets
`MORE_THAN_MISSING`; a `(card_id, finish)` the deck is not short of gets `NOT_SHORT_OF_THAT`; a
printing deleted from `cards` between plan and press gets `LEFT_THE_DATABASE`; recording onto a
group that already holds that grain raises the existing row rather than making a second;
exactly-one-wish is decremented and a two-wish row is left standing; `clear_wishes: false` leaves
a lone match standing; a refusal writes nothing at all (assert `collection_entries`,
`wishlist_entries` **and** `deck_audit` are unchanged).

**Mutation check before you report:** break `to_collection`'s `quantity <= short` comparison to
`<=` → `<` and confirm at least one test goes red; then put it back. Do the same for the
`clear_wishes` gate. Say in your report which tests caught which.

- [ ] **Step 10: Report**

Do not run tests or git. Report the file list, the exact command names registered, the constant
you used for the condition, and the mutation-check result.

---

### Task 3: The wire

**Files:**
- Modify: `src/lib/ipc.ts` (types near the `DeckPullRow` block at `:2140`; invokers near `:6249`)
- Modify: `src/lib/ipc.test.ts` (the mirrors table)

**Interfaces:**
- Consumes: the Rust shapes in Task 2's Produces block.
- Produces — Tasks 4, 5, 7 and 8 import these exact names:

```ts
export interface DeckMissingRow {
  cardId: string; name: string; setCode: string; collectorNumber: string;
  finish: DeckFinish; short: number; categories: string[];
  imageUris?: Partial<Record<ImageVariant, string>> | null;
  wishes: DeckQuickAddWish[];
}
export interface DeckMissingPick { cardId: string; finish: DeckFinish; quantity: number }
export interface DeckMissingOutcome { copies: number; cards: number; wishCopies: number }

ipc.deckMissingPlan(deckId: number): Promise<DeckMissingRow[]>
ipc.deckMissingToCollection(
  deckId: number, picks: DeckMissingPick[], clearWishes: boolean,
): Promise<DeckMissingOutcome>
```

- [ ] **Step 1: Read the block you are extending**

`src/lib/ipc.ts:2140-2270` — `DeckPullRow`, `DeckPullCandidate`, `DeckPullPick`,
`DeckPullOutcome`, `DeckQuickAddWish`. The new types sit immediately after `DeckQuickAddWish` so
the three deck-boundary features read in one run.

- [ ] **Step 2: Add the three interfaces**

Field docs carry the reasoning from the reader's end, matching the density of `DeckPullRow`'s.
The four claims that must be written down:

- `finish` — the deck row's spelling, `null` is nonfoil; and **the pick is addressed by
  `(cardId, finish)` and not by an entry id, because the row does not exist yet.** That is the
  one structural difference from `DeckPullPick`.
- `short` — copies of this printing and finish the live list still wants, over its **active**
  piles.
- `wishes` — reuses `DeckQuickAddWish`, and is the same command's answer, so the per-card menu and
  this dialog cannot disagree about what fills a wish. **Only a row with exactly one entry has its
  wish cleared**; none and two-or-more are left alone, which is why no wish id travels on
  `DeckMissingPick`.
- `DeckMissingOutcome.cards` — rows of the plan that got at least one copy, so printings **and
  finishes**, at `DeckMissingRow`'s grain. Spell it out for `DeckPullOutcome.cards`' reason: three
  places count it (the crate, the Storybook fake, `addMissingPlan.ts`'s footer preview) and a
  grain mismatch would surface only on a deck short of one printing in two finishes.

Also note on `DeckMissingRow` that **an orphaned printing is not in the plan at all** — the
backend drops it because the write could not file it — so the type has no "unrecordable" state.

- [ ] **Step 3: Add the two invokers**

Beside `deckPullPlan` / `deckPullFromCollection`, in the same order and with the same doc shape:

```ts
  deckMissingPlan: (deckId: number) =>
    invoke<DeckMissingRow[]>("deck_missing_plan", { deckId }),

  deckMissingToCollection: (deckId: number, picks: DeckMissingPick[], clearWishes: boolean) =>
    invoke<DeckMissingOutcome>("deck_missing_to_collection", { deckId, picks, clearWishes }),
```

- [ ] **Step 4: Add both to the `ipc.test.ts` mirrors table**

Find the table (grep `deck_pull_plan` in that file) and add a row for each new command in exactly
the existing shape. This is the opt-in fence that catches Rust↔`ipc.ts` drift; a new command with
no row is a command outside it.

- [ ] **Step 5: Report** — the names added, and confirmation that both mirror rows are in.

---

### Task 4: `addMissingPlan.ts` — what the press will do

**Files:**
- Create: `src/features/decks/addMissingPlan.ts`
- Test: `src/features/decks/addMissingPlan.test.ts`

**Interfaces:**
- Consumes: `DeckMissingRow`, `DeckMissingPick` from Task 3; `pullKey` and `PullKey` from
  `./pullPlan`.
- Produces — Task 5 imports all of these:

```ts
export const NO_MISSING_CHOICE: MissingChoice;
export interface MissingChoice {
  readonly off: ReadonlySet<PullKey>;
  readonly copies: ReadonlyMap<PullKey, number>;
}
export function toggleRow(choice: MissingChoice, key: PullKey, on: boolean): MissingChoice;
export function setCopies(choice: MissingChoice, key: PullKey, copies: number): MissingChoice;

export type RowWish =
  | { readonly kind: "one"; readonly clears: number; readonly folderName: string | null }
  | { readonly kind: "ambiguous"; readonly matches: number }
  | null;

export interface PlannedMissingRow {
  readonly row: DeckMissingRow;
  readonly key: PullKey;
  readonly on: boolean;
  readonly copies: number;   // clamped to [1, row.short]; meaningful only when `on`
  readonly wish: RowWish;    // null when `clearWishes` is false, or no line matches
}
export interface AddMissingPlan {
  readonly rows: readonly PlannedMissingRow[];
  readonly picks: readonly DeckMissingPick[];
  readonly copies: number;
  readonly cards: number;
  readonly wishesCleared: number;
}
export function planAddMissing(
  rows: readonly DeckMissingRow[], choice: MissingChoice, clearWishes: boolean,
): AddMissingPlan;
```

- [ ] **Step 1: Read `pullPlan.ts` end to end**

`src/features/decks/pullPlan.ts` (299 lines). This file is its sibling and must follow its three
disciplines: the **default is everything**, so the choice holds only departures; nothing is ever
mutated in place and an unchanged write returns the **same reference**; and a choice naming a row
that no longer exists is **ignored, not repaired**.

- [ ] **Step 2: Write the module doc**

It must argue the one thing that differs from `pullPlan.ts`: **the pull's departure is a source,
this one's is a count.** A pull chooses *which* copies because they exist and sit somewhere; this
chooses *how many*, because they do not exist yet and the reader may have bought two of the four
their deck wants. And it must say that `pullKey` is imported rather than respelled — a
`DeckMissingRow` satisfies its `Pick<DeckPullRow, "cardId" | "finish">` parameter structurally,
the grain is identical, and a second spelling of `cardId|finish` is a second thing to drift.

- [ ] **Step 3: Write the failing tests first**

`src/features/decks/addMissingPlan.test.ts`, using a small `row()` factory. Cover:

```ts
// the default
it("ticks every row at its full shortfall", …)            // copies === short, cards === rows.length
it("is one pick per row, addressed by cardId and finish", …)
// departures
it("drops an unticked row from the picks and from both totals", …)
it("honours a lowered count and keeps the row", …)
it("returns the same choice reference when a toggle changes nothing", …)
it("returns the same choice reference when setCopies repeats the current count", …)
// the clamp — the load-bearing one
it("clamps a stored count above a re-read row's shortfall", …)  // stored 4, short now 2 → 2
it("clamps a stored count below one to one", …)
it("ignores a stored count for a key no row carries", …)
// wishes
it("reports a lone wish as the copies it will clear, capped by the wish's quantity", …)
it("reports two or more matches as ambiguous and clears nothing", …)
it("reports no wish at all when the row has none", …)
it("reports no wish and clears nothing when clearWishes is false", …)
it("counts wishesCleared only over ticked rows", …)
```

The clamp tests are the reason this file exists: a stale count that reached the footer would
preview a press the backend refuses with `MORE_THAN_MISSING`.

- [ ] **Step 4: Implement**

Derivation only — hold no copy of the plan. `copies` is
`Math.min(Math.max(choice.copies.get(key) ?? row.short, 1), row.short)`.

`wish` is derived in this order, and the first arm is the one that is easy to get wrong:

```ts
const wish: RowWish =
  !clearWishes                ? null
  : row.wishes.length === 1   ? { kind: "one",
                                  clears: Math.min(copies, row.wishes[0].quantity),
                                  folderName: row.wishes[0].folderName }
  : row.wishes.length >= 2    ? { kind: "ambiguous", matches: row.wishes.length }
  : null;
```

**`!clearWishes` comes first and collapses every row to `null`**, ambiguous ones included: the
sentence beside a row must not describe something the press will not do, and "2 wishlist lines
match — left alone" over a press that was never going to touch a wish is a fact about the wrong
world. There is a test for exactly that.

`picks`, `copies`, `cards` and `wishesCleared` are summed over ticked rows only.

- [ ] **Step 5: Mutation check** — change the clamp's `Math.min` to a bare read and confirm the
clamp tests go red; restore. Report which tests caught it.

- [ ] **Step 6: Report** — the exported API, the test names, the mutation result. Do not run the
suite; you may reason about it, but the dispatcher runs it.

---

### Task 5: `AddMissingToCollectionDialog`

**Files:**
- Create: `src/features/decks/AddMissingToCollectionDialog.tsx`
- Create: `src/features/decks/AddMissingToCollectionDialog.test.tsx`
- Create: `src/features/decks/AddMissingToCollectionDialog.stories.tsx`

**Interfaces:**
- Consumes: Task 3's `DeckMissingRow` / `DeckMissingPick` / `DeckMissingOutcome`; Task 4's
  `planAddMissing`, `NO_MISSING_CHOICE`, `toggleRow`, `setCopies`, `PlannedMissingRow`.
- Produces — Task 7 imports these:

```ts
export interface AddMissingWrite {
  mutate: (input: { picks: DeckMissingPick[]; clearWishes: boolean }) => void;
  isPending: boolean; isSuccess: boolean; isError: boolean;
  error: unknown; data: DeckMissingOutcome | undefined;
}
export interface AddMissingToCollectionDialogProps {
  open: boolean;
  deckName: string;
  rows: readonly DeckMissingRow[] | null;
  loading: boolean;
  readError: string | null;
  add: AddMissingWrite;
  onClose: () => void;
}
export function AddMissingToCollectionDialog(
  props: AddMissingToCollectionDialogProps,
): JSX.Element;
```

- [ ] **Step 1: Read `PullFromCollectionDialog.tsx` whole**

It is the model, and this dialog is deliberately simpler: **no source picker, no `Dropdown`, no
per-row candidate list**, and no `cardName` prop — there is exactly one entrance, the deck-wide
press, because the per-card form already exists as `Collection ▸ Quick add N copies` and needs no
dialog. Copy its `Dialog` usage (`title`, `subtitle`, `closeLabel`, `size`, one `onDismiss`/
`onClose` callback), its body/footer split, its `PullWrite`-style narrowed write prop, and its
rule that **the component holds no query and no mutation**.

- [ ] **Step 2: The four body states, drawn apart**

`loading`, `readError`, **empty**, and rows. The empty state must be worded, because it looks like
a failure and is an ordinary answer:

> Nothing here can be recorded — everything this deck is short of has left the card database.

That is the only way a plan is empty while the button that opened it was drawn (the button lives
inside `missing > 0`), and a blank panel reads as broken.

- [ ] **Step 3: The chrome**

```tsx
<Dialog
  open={open}
  title="Add missing to collection"
  subtitle={`Records copies you have just acquired into ${deckName}'s folder. Nothing is moved out of your collection.`}
  closeLabel="Close the add list"
  size="w-[47.5rem]"
  onDismiss={onClose}
  onClose={onClose}
>
```

`w-[47.5rem]` rather than the pull's `w-[52rem]`: a row here carries no source sentence — no
folder name, condition and up to four traits — so it needs the narrower of the two widths this
app already uses. Say that in a comment.

- [ ] **Step 4: The row**

Art (`CardImage` + `cardArtSrc`, as the pull does), name, `FinishMark`, set/collector, the piles
it is short in, a checkbox, and a stepper defaulted to `short`. Everything ticked on open — the
body is mounted and unmounted by `Dialog` with `open`, so each open starts clean and no effect has
to reset anything.

The wish line sits beside the row as a **fact, not a question**, and the three shapes come
straight off `PlannedMissingRow.wish`:

- `{ kind: "one" }` → `Clears N copies off a wish in <folderName ?? "Wishlist">` (sentence-cased:
  it is a standalone line, not a fragment continuing the row)
- `{ kind: "ambiguous" }` → `N wishlist lines match — left alone`
- `null` → nothing at all

Word `null` folder names as `Wishlist` **here**, not in the backend — `QuickAddWish.folderName`'s
own doc says the sentence belongs on the page that shows it.

- [ ] **Step 5: The footer**

A checkbox `Also take these off my wishlist`, on by default, and the press
`Add {copies} {copy/copies} to collection` (use `plural` from `@/lib/counts`). Disabled while
`add.isPending` or when `plan.picks.length === 0`. The answer is worded from
`add.data` — *"Recorded N copies of M cards"* plus *"K copies off your wishlist"* when `K > 0` —
and a refusal is drawn **inside the panel** (`add.error` through `ipcError`), because the editor's
banner is behind this scrim. That is `ClearCategory`'s arrangement and the reason the pull's body
takes its own failure.

- [ ] **Step 6: Tests**

`AddMissingToCollectionDialog.test.tsx`, no query client — the write is a plain object:

```
renders the four states apart (loading / readError / empty / rows)
opens with every row ticked at its full shortfall
unticking a row drops it from the footer count and from the picks the press sends
lowering a stepper lowers the footer count and the pick's quantity
the press sends clearWishes true by default and false once the checkbox is off
a row with one matching wish says which folder it clears from
a row with two matching wishes says they are left alone
a row with no wishes says nothing about wishes
the footer press is disabled while pending and when nothing is ticked
a refusal is drawn inside the panel
```

Assert the wish sentence with `classList.contains` / exact text, never
`className.includes` — a `hover:` variant makes a class assertion vacuous. Where a label and its
count sit in two spans, remember a CSS gap breaks the accessible name (`"Missing2"`).

- [ ] **Step 7: Stories**

Four states plus the two-wish row, against the Storybook fake. Read `.storybook/CLAUDE.md` first.
Do **not** run Storybook — the lock is shared across worktrees and another agent may hold it.

- [ ] **Step 8: Report** — the exported props, the state names, and any place you departed from
the pull dialog's shape and why.

---

### Task 6: The third button in the stats band

**Files:**
- Modify: `src/features/decks/DeckStats.tsx` (the `Missing` component at `:706-850`, and
  `DeckStats`' own props at `:544-561`)
- Modify: `src/features/decks/DeckStats.test.tsx` (every `<DeckStats …>` call site — the prop is
  required)
- Modify: `src/features/decks/DeckStats.stories.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `DeckStats` gains a **required** prop
  `onAddMissing: (() => void) | null`, threaded to `Missing` under the same name. Task 7 passes
  `variant === "live" ? openAddMissing : null`.

- [ ] **Step 1: Read `Missing` and the two buttons it already draws**

`src/features/decks/DeckStats.tsx:706-850`. Note the three rules the new button inherits: it is
drawn only inside the `stats.missing > 0` arm; its class list is its neighbours', character for
character; and it takes `aria-haspopup="dialog"` with **no** `aria-expanded`, because the layer it
opens is a full-window overlay and no reader can observe the state.

- [ ] **Step 2: Add the prop**

Required, and `null` where there is nothing to open — `onPull`'s shape exactly, and the doc says
why in the same words: a plan holds no cards, so the theory list is short of nothing; **absent,
never greyed**.

- [ ] **Step 3: Add the button between the two**

```tsx
{onAddMissing !== null && (
  <button
    type="button"
    aria-haspopup="dialog"
    onClick={onAddMissing}
    className={cn(
      "rounded-md border border-border px-2 py-1 text-dim",
      "transition-colors duration-150 hover:text-text disabled:opacity-50",
      "aria-disabled:opacity-50 aria-disabled:hover:text-dim",
      "motion-reduce:transition-none",
      FOCUS,
    )}
  >
    Add missing to collection
  </button>
)}
```

The comment above it carries the order argument: the row now reads own → just acquired → not yet
owned, and it must not be reordered into "buy these" before "record what you bought". Also state
the two things it deliberately lacks — **no `spent` state** (pressing twice re-plans against a
shortfall the first press closed and finds nothing to offer, where the wishlist press would wish
for the same copies again) and **no `disabled` from a sibling write in flight** (three
independent writes about one number).

- [ ] **Step 4: Fix every call site in the test file**

~10 `<DeckStats …>` renders in `DeckStats.test.tsx` need `onAddMissing={null}` (or a spy where the
test is about it). Same for the stories.

- [ ] **Step 5: Add tests**

```
draws all three presses when the deck is short
draws none of them when nothing is missing
omits the add press when onAddMissing is null and still draws the other two
the add press calls its callback
the add press is not disabled while the wishlist write is pending
the add press has no aria-disabled after the wishlist press is spent
```

The last two are the two "it is not its neighbour" claims and are the ones worth having.

- [ ] **Step 6: Report** — the prop name, the button's position in the row, and the number of call
sites you updated.

---

### Task 7: The editor wiring

**Files:**
- Modify: `src/features/decks/useDeck.ts` (the query factory + hook beside `pullPlanQuery`/
  `usePullPlan` at `:1325-1355`; the mutation beside `quickAddToCollection` at `:1202`; the
  returned object at `:1277-1285`)
- Modify: `src/features/decks/DeckEditor.tsx` (the `Layer` union at `:648`; an opener beside
  `openPull` at `:2017`; the plan query at `:2050`; the `<DeckStats>` call at `:4426`; the dialog
  mount beside `<PullFromCollectionDialog>` at `:4707`)
- Modify: `src/features/decks/DeckEditor.test.tsx`

**Interfaces:**
- Consumes: Task 3's `ipc.deckMissingPlan` / `ipc.deckMissingToCollection` and
  `DeckMissingPick`; Task 5's `AddMissingToCollectionDialog` and `AddMissingWrite`; Task 6's
  `onAddMissing` prop.
- Produces: `useDeck(...)` returns `addMissingToCollection`; `useMissingPlan(deckId, enabled)` and
  `missingPlanQuery(deckId)` are exported from `useDeck.ts`.

- [ ] **Step 1: Add the query factory and hook to `useDeck.ts`**

```ts
export function useMissingPlan(deckId: number | null, enabled: boolean) {
  return useQuery({ ...missingPlanQuery(deckId), enabled: enabled && deckId !== null });
}

export function missingPlanQuery(deckId: number | null) {
  return {
    queryKey: ["decks", "missingPlan", deckId],
    queryFn: () => ipc.deckMissingPlan(opened(deckId)),
  };
}
```

The key is `usePullPlan`'s shape — root, question, id — and it must sit under `["decks"]` so
`useDeck`'s own `invalidate` reaches it: the press closes the very holes it answers. **No
`variant` and no `marketplace` in the key**, for the pull's reasons (the command reads the live
list only and nothing it answers is priced). Unlike the pull's, there is only **one** reader, so
say in the doc that the factory exists for symmetry with its neighbour rather than because a
second caller needs it — and if you would rather not export a factory with one caller, fold it
into the hook and say so in your report.

- [ ] **Step 2: Add the mutation**

```ts
const addMissingToCollection = useMutation({
  mutationFn: ({ picks, clearWishes }: { picks: DeckMissingPick[]; clearWishes: boolean }) =>
    ipc.deckMissingToCollection(opened(id), picks, clearWishes),
  onSuccess: () => {
    for (const queryKey of OWNED_WRITE_KEYS) void queryClient.invalidateQueries({ queryKey });
  },
});
```

Its doc must say why it takes `OWNED_WRITE_KEYS` and not the narrower `invalidateCollection` the
three movers share — **this creates rows**, so `CardSummary.ownedQuantity` moves from 0 to N and a
30 s `staleTime` would otherwise keep saying the old number for half a minute. `["wishlist"]` in
that set is load-bearing rather than incidental here, because the write can delete a wish
outright. `["decks"]` is in the set already, so do **not** call `invalidate()` beside it — that
would be a second spelling of a root the constant carries. No optimistic patch: every number this
moves is a sum the backend computes over rows in another table.

Add `addMissingToCollection` to the returned object beside `quickAddToCollection`.

- [ ] **Step 3: Add the layer arm and the opener in `DeckEditor.tsx`**

```ts
  | { kind: "addMissing" }
```

with a doc saying it carries **no payload and needs none**: there is one opener (the stats band)
because the per-card form is a menu row that writes outright, so unlike `pull` this arm can never
grow a `card` field and `layerMatches` needs no narrowing clause for it.

```ts
const openAddMissing = useCallback(() => {
  const opener = document.activeElement;
  openLayer({ kind: "addMissing" }, () => {
    if (opener instanceof HTMLElement) opener.focus();
  });
}, [openLayer]);

const missingPlan = useMissingPlan(deckId, layer?.kind === "addMissing");
```

- [ ] **Step 4: Pass the prop and mount the dialog**

`<DeckStats … onAddMissing={variant === "live" ? openAddMissing : null} />` beside the existing
`onPull` line. Then, beside `<PullFromCollectionDialog>`:

```tsx
<AddMissingToCollectionDialog
  open={layer?.kind === "addMissing"}
  deckName={row?.name ?? ""}
  rows={missingPlan.data ?? null}
  loading={missingPlan.isLoading}
  readError={missingPlan.isError ? ipcError(missingPlan.error) : null}
  add={deck.addMissingToCollection}
  onClose={dismiss}
/>
```

`dismiss` rather than `close`, the pull's reason: every way out of this dialog is the reader
saying "put me back", and the caret's destination is a button in the stats band.

- [ ] **Step 5: Tests in `DeckEditor.test.tsx`**

```
the stats band's add press opens the dialog
the dialog is not mounted open before the press, and the plan is not fetched
closing it returns the caret to the button that opened it
the theory tab draws no add press
a successful press closes nothing by itself and the editor re-reads the deck
```

The "not fetched" one is the `enabled` gate and is the test worth having: the plan is the second
widest read this editor makes.

- [ ] **Step 6: Report** — the query key you used, whether you kept the options factory, and the
call sites you touched.

---

### Task 8: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts`
- Modify: `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes: the wire contract in Task 3's Produces block.
- Produces: `deck_missing_plan` and `deck_missing_to_collection` answer from the fake.

- [ ] **Step 1: Read `.storybook/CLAUDE.md` and the fake's existing pull handlers**

Grep `deck_pull_plan` and `deck_quick_add_to_collection` in `.storybook/fake/db.ts`. The fake is
the Rust backend's second implementation for the workbench and has to agree with it.

**Note:** a stray NUL in this file has made `grep` call it binary before — if a search returns "no
matches" for a string you can see, that is why. Use `rg --text` or read the file.

- [ ] **Step 2: Implement `deck_missing_plan`**

The live list's shortfall folded at `(cardId, finish)`, inactive categories skipped, orphans
dropped, with `wishes` filled from whatever the fake's `deck_quick_add_wishes` handler already
answers. Reuse that handler's matcher rather than writing a second wish predicate.

- [ ] **Step 3: Implement `deck_missing_to_collection`**

Record into the deck's group folder, folding onto an existing row of the same grain; take a wish
down **only when exactly one matches**; answer `{ copies, cards, wishCopies }` where `cards`
counts distinct `(cardId, finish)` rows that got a copy — the same grain the real command uses,
because `DeckPullOutcome.cards`' note explains what a mismatch here would cost.

- [ ] **Step 4: Seed**

Add to the deck fixture a shortfall that exercises the interesting rows: one printing short in two
active categories, one card short in two finishes, one row with exactly one matching wish, and one
row with two matching wishes. The stories in Task 5 draw from this.

- [ ] **Step 5: Tests in `db.test.ts`**

The fold, the one-wish rule, the two-wish rule, and the `cards` grain.

- [ ] **Step 6: Report** — the handler names and the seed rows you added.

---

### Task 9: The record — after fan-in, not during

**Files:**
- Modify: `docs/reference/decks-storage.md`
- Modify: `src/features/decks/CLAUDE.md` (only if it enumerates the deck-boundary writes)
- Modify: `src-tauri/CLAUDE.md` (only if it enumerates them)
- Modify: `docs/reference/test-coverage.md` (only if it quotes a figure this changes)

**Run this only after `npm run verify` is green.** A docs edit routes to neither CI job, so nothing
goes red when one rots — and `tauri dev` watches `src-tauri/CLAUDE.md`, so editing it mid-run
restarts another agent's app.

- [ ] **Step 1: `decks-storage.md`**

Add the new pair to the deck-boundary write list, and write down the four things only this feature
knows: that the press **creates** rows where the pull moves them; that the shortfall walk is now
`deck::live_shortfall` with three callers; that the plan drops an orphaned printing because
`add_entry_filed` reads the printing off `cards`; and that the wish half acts **only on an
unambiguous match**, which is why the wire carries no wish id.

- [ ] **Step 2: Count nothing you do not re-count**

If you change a list or a count in any of these files, re-count it in the same edit. Better still,
do not write down a number a build already answers.

- [ ] **Step 3: Report** — the files touched and the claims added.

---

## Fan-in

1. `npm run verify` — **once, by the dispatcher, never inside a task, and never two at a time**
   (concurrent runs fake ~18 Rust schema failures). Do not pipe it to `tail`: the exit code is the
   pipe's, and a failing suite reports 0.
2. `cargo fmt --check` and `cargo clippy` in `src-tauri/` — `verify` runs neither, and CI runs
   both.
3. Live pass in the real window (`npm run tauri dev`, then `scripts/cdp.mjs`; read
   `docs/reference/live-ui-verification.md` first, and take the app lock via
   `.claude/skills/running-the-app/lock.ps1`). Check, on a deck with a real shortfall: the third
   button appears beside the other two and the band wraps rather than overflowing; the dialog's
   footer count matches the sum of the ticked steppers; the press lands and the band's missing
   count drops by exactly what was recorded; the copies appear in the deck's collection folder;
   an unambiguous wish goes down and an ambiguous one does not; and the deck's history drawer
   shows one row reading *"Recorded N copies for this deck"*.
4. Then Task 9, then `shipping-a-branch` / `auto-pr`.
