# Home widgets, round two — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four kinds to the home page's Add-widget catalogue — Deck completion, To review, Wishlist savings and Coming soon — each drawn in the existing widget chrome, on both the desktop and the browser build.

**Architecture:** Four independent widget kinds, each a `WIDGET_META` row, a body in `src/features/home/widgets/` and at most one new read. Three new Rust reads (`deck_completion`, `deck_review_count`, `upcoming_sets`) are routed on both targets; three one-shot store hand-offs (`pendingReviewFilter`, `pendingSettingsGroup`, `pendingOptimize`) carry a press into a page state it does not open in by itself, built exactly like `pendingFolder`.

**Tech Stack:** Rust (Tauri 2.11, rusqlite over `user.db` + attached `corpus.db`), React 19, TypeScript 6.0.x, TanStack Query, Zustand (`src/lib/store.ts`), Vitest + Testing Library, Storybook with the in-repo fake backend (`.storybook/fake/`).

**Spec:** `docs/superpowers/specs/2026-09-26-home-widgets-round-two-design.md` — read it before any task. The design canvas it describes is https://claude.ai/artifact/KD8KLMt59PTYHdkPbCZWKU.

## Global Constraints

- **Catalogue only.** `DEFAULT_LAYOUT` does not change in any of its three copies (`widgets.ts`, `src-tauri/src/home.rs`, the Storybook fake).
- **Deck completion counts what the deck editor counts**, character for character (spec §3.1): live list vs the deck's own group; a theory-enabled deck's theory list vs `Availability::ForDeck`; every active pile; exact `(card_id, finish)`, a `NULL` finish matching `'nonfoil'`.
- **Every new command is routed on both targets**: `desktop.rs` handler list **and** `web/route.rs` (`COMMANDS`, match arm, routed test, the `COMMANDS.len()` literal).
- **Money is `formatPrice(value, currency)` with the currency from `useMarketplace()`**; a `null` price is an em dash and never another marketplace's number; every priced query key carries `marketplace`.
- **"Today" is SQLite's UTC `date('now')`**; TypeScript formats dates with `timeZone: "UTC"` and parses `${d}T00:00:00Z`.
- **`setActiveView(view)` first, the hand-off second**, at every call site; a page consumes a hand-off in a **render-phase adjustment**, never in an effect body (`no-setstate-in-an-effect` fails only at `verify`).
- **Dim text is `text-dim`, never `text-muted`**; no class built by interpolation; computed sizes are inline styles; z-indexes from `LAYER`; hints through `useTooltip()`; `aria-disabled`, never `disabled`.
- **A `still` body (catalogue preview) writes nothing, opens nothing and draws no press.**
- **Never install `@types/node`; TypeScript stays on 6.0.x; no new dependency.**
- **Docs write down no count a build already answers** — not the number of widget kinds, not the `COMMANDS` total.
- **Parallel waves share one worktree and one git index.** An implementer in a parallel wave runs targeted tests only (one `npx vitest run <file>`, one `cargo test <filter>`), never `git add`/`git commit`, and never `npm run verify`; the controller commits each task's files **by path** after its review, and runs the full `npm run verify` once, at the end.

## Review Focus

1. **A deck's group holding more copies than the deck asks for, and one printing in two piles** — owned is capped at wanted, `missing` is never negative, and two rows of one `(card_id, finish)` in different active piles draw from one shared pool. Pinned in Task R1's fixture.
2. **A marketplace switch** — every priced widget refetches under the new key and never shows the old marketplace's figure beside the new currency symbol. Pinned in Tasks W1 and W3.
3. **The window's edges in Coming soon** — a set whose cards carry different dates (answers its earliest), a card releasing *today* (not upcoming: `released_at > date('now')`), one exactly `N` days out (included). Pinned in Task R3.
4. **Wishes that cannot be priced** — only any-printing wishes (`considered` is zero), or moves whose `from.price` is `null`: the total excludes them, nothing reads `NaN` or `$0.00 saved`. Pinned in Task W3.
5. **A brand-new database** — no decks, an empty wishlist, an empty tray, no flagged rows, no upcoming cards: every widget draws its own empty sentence and none throws. Pinned in each widget task's empty-state test.

## Waves

| Wave | Tasks | Runs |
| --- | --- | --- |
| 1 | Tasks 1 → 2 → 3 (R1–R3, Rust lane, sequential) ‖ Tasks 4, 5 (F1, F2, TS lane) | two lanes in parallel |
| 2 | Task 6 (F3: IPC mirror, keys, fake) | after Task 3 |
| 3 | Tasks 7 ‖ 8 ‖ 9 ‖ 10 (W1–W4) | in parallel, each in its own files |
| 4 | Task 11 (W5, HomePage wiring) → 12 (D1, docs) → 13 (V1, verify + live pass) → 14 (S1, auto-pr) | sequential |

Task headings carry both names — `Task 7 (W1)` — because the lanes were drafted apart and refer
to each other by the letter; the number is what the tooling extracts by.

---

## Wave 1a — the Rust lane (sequential)

## Lane: Rust — the three reads

Three tasks, **run one after another** (R2 extends R1's module and test helpers; all three edit
`desktop.rs` and `web/route.rs`). Every cargo command runs from the repo root
(`D:\Code\mtg-grimoire\.claude\worktrees\mtg-grimoire-deck-editor-117338`) with
`--manifest-path src-tauri/Cargo.toml`, the form `npm run verify` uses. Implementers do not
`git add` or commit.

**A new module's tests are invisible until `lib.rs` declares it**: `cargo test deck_completion`
over an undeclared module selects 0 tests and exits 0. Every task's Step 1 adds the `pub mod`
line with the test, and every run below must report a non-zero count for the new module.

---

### Task 1 (R1): `deck_completion`

**Files:**
- Create: `src-tauri/src/deck_completion.rs`
- Modify: `src-tauri/src/lib.rs` (after `pub mod deck_audit;`, line 68)
- Modify: `src-tauri/src/deck.rs` — `fn owned_by_printing` (line 5249) and `fn available_by_printing` (line 5309) become `pub(crate)`; no other change
- Modify: `src-tauri/src/desktop.rs` — the `use crate::{…}` list (lines 21-29) and the `generate_handler!` list (after `new_printings::mark_new_printings_seen,`, line 627)
- Modify: `src-tauri/src/web/route.rs` — `COMMANDS` (after `"mark_new_printings_seen",`, line 301), the `call` match (after the `"mark_new_printings_seen"` arm, ~line 2475), the tests module (after `the_new_printings_pair_is_routed`, ~line 3723), the `COMMANDS.len()` literal (line 4135, currently **181**)
- Test: `src-tauri/src/deck_completion.rs` (`mod tests`), `src-tauri/src/web/route.rs` (`mod tests`)

**Interfaces:**
- Consumes:
  - `crate::deck::owned_by_printing(conn: &Connection, deck_id: i64) -> Result<HashMap<(String, String), i64>, String>` (made `pub(crate)` here)
  - `crate::deck::available_by_printing(conn: &Connection, deck_id: i64) -> Result<HashMap<(String, String), i64>, String>` (made `pub(crate)` here)
  - `crate::sorting::deck_card_price_expr(market: Marketplace) -> String`; `crate::sorting::Marketplace::from_opt(Option<&str>) -> Marketplace`
  - `crate::sync::lock_db_read(&AppState) -> MutexGuard<'_, Connection>`
  - `crate::schema::DECK_VARIANTS: [&str; 2]` (`live`, `theory`), `crate::schema::FINISHES: [&str; 3]` (`nonfoil` first)
- Produces:
  - `pub struct DeckCompletion { pub deck_id: i64, pub list: String, pub wanted: i64, pub owned: i64, pub missing: i64, pub missing_cost: Option<f64>, pub unpriced_missing: i64 }` — `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]`
  - `pub fn deck_completion_for(conn: &Connection, marketplace: Marketplace) -> Result<Vec<DeckCompletion>, String>` — one row per non-virtual deck, ascending `deck_id`
  - `#[tauri::command] pub async fn deck_completion(state: tauri::State<'_, Arc<AppState>>, marketplace: Option<String>) -> Result<Vec<DeckCompletion>, String>` — wire name `deck_completion`, argument `marketplace` (optional)

**What the arithmetic is, read off the code:**
- `DeckStats.tsx:462-481`: over `cards.filter(c => c.categoryActive)`, `have = min(ownedQuantity, quantity)`, `short = quantity − have`; a row with `unitPrice === null` adds `quantity` to `unpriced`, otherwise `unitPrice × short` to `missingPrice` and `quantity` to `priced`; `missingPrice` is `null` **exactly when `priced === 0`** (`:509`) — no counted row priced at all, not "no missing copy priced". So a complete priced deck is `Some(0.0)`, and an empty deck is `None`.
- The row's price is `deck_card_price_expr` over `dc.finish` (`deck.rs:4848,4882`): NULL finish is the `nonfoil → foil → etched` chain, a named finish is that finish only. It depends on `(card_id, finish)` alone, so it is the key's price.
- `attribute_owned` (`deck.rs:5366-5390`) skips inactive rows, keys `(card_id, finish ?? FINISHES[0])`, hands `min(remaining, quantity)` down the read order — so per key the owned total is `min(Σ wanted, pool)` and the missing total is `Σ wanted − that`.
- `get_deck` (`deck.rs:4932-4936`) picks the pool by variant: `owned_by_printing` for `live`, `available_by_printing` (`Availability::ForDeck`) for `theory`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/deck_completion.rs` containing only this test module for now (Step 3 puts the implementation above it):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    // deck.rs:6552-6585 (`seeded`) — the column set every deck test seeds `cards` with.
    /// Five printings, each there for one rule.
    ///
    /// * `bolt` sells in both finishes at two prices, so its NULL-finish row and its foil row are
    ///   two keys at two rates.
    /// * `angel` has **no price** anywhere — the unpriced printing.
    /// * `shiny` is foil-only: a NULL-finish row of it is priced through the chain at its foil
    ///   rate and keyed at `nonfoil`, so a foil copy in the binder does not own it.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,power,toughness,prices,finishes,raw)
               VALUES
                 ('bolt','o-bolt','Lightning Bolt','m10','146','en','normal','common',
                  'Instant',NULL,NULL,'{"usd":"2.00","usd_foil":"10.00"}',
                  '["nonfoil","foil"]','{}'),
                 ('ring','o-ring','Sol Ring','c21','263','en','normal','uncommon',
                  'Artifact',NULL,NULL,'{"usd":"3.00"}','["nonfoil"]','{}'),
                 ('angel','o-angel','Serra Angel','lea','175','en','normal','uncommon',
                  'Creature — Angel','4','4',NULL,'["nonfoil"]','{}'),
                 ('bird','o-bird','Birds of Paradise','m12','165','en','normal','rare',
                  'Creature — Bird','0','1','{"usd":"0.50"}','["nonfoil"]','{}'),
                 ('shiny','o-shiny','Shiny Relic','sld','900','en','normal','rare',
                  'Artifact',NULL,NULL,'{"usd":null,"usd_foil":"7.00"}','["foil"]','{}');"#,
        )
        .unwrap();
        conn
    }

    // deck.rs:1797 (`create_deck`) — a deck that is not virtual is born with its group, and with
    // the four predefined piles, Sideboard active and Maybeboard off (schema.rs:989-994).
    fn make_deck(conn: &Connection, name: &str, theory: bool, virtual_only: bool) -> i64 {
        crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: name.to_owned(),
                format_key: "commander".to_owned(),
                theory_enabled: Some(theory),
                virtual_only: Some(virtual_only),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    // deck.rs:6605-6607 (`main_of`) — a pile by name, made on first ask.
    fn pile(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, name).unwrap()
    }

    // deck.rs:6590-6597 (`kind_of`) — a seeded pile by kind.
    fn seeded_pile(conn: &Connection, deck_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = ?2",
            params![deck_id, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    // deck.rs:6612-6652 (`add`, `add_foil`) — the app's own card write, at an explicit pile.
    fn put(
        conn: &Connection,
        deck_id: i64,
        pile: i64,
        variant: &str,
        card: &str,
        finish: Option<&str>,
        quantity: i64,
    ) {
        crate::deck::add_card(conn, deck_id, card, Some(pile), None, variant, finish, quantity)
            .unwrap();
    }

    // deck.rs:6685-6691 (`file_into_group`) — added at the root, then refiled. **The root must
    // not already hold this grain**: `add_entry` folds onto `COLLECTION_GRAIN`, so the add would
    // merge into that row and the refile would carry both. The fixture below writes every
    // refiled copy before the loose ones for exactly that reason.
    fn copies(conn: &Connection, card: &str, finish: &str, quantity: i64, folder: Option<i64>) -> i64 {
        let entry = crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card.to_owned(),
                finish: finish.to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        match folder {
            Some(folder) => crate::collection_folders::refile_entry(conn, entry, Some(folder))
                .unwrap()
                .id,
            None => entry,
        }
    }

    // collection.rs:88-133 (`EntryInput::folder_id`) — straight into one of the reader's own
    // folders, the only kind `add_entry` files into.
    fn filed(conn: &Connection, card: &str, finish: &str, quantity: i64, folder: i64) {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card.to_owned(),
                finish: finish.to_owned(),
                quantity,
                folder_id: Some(folder),
                ..Default::default()
            },
        )
        .unwrap();
    }

    // deck.rs:1341 (`deck_group`).
    fn group(conn: &Connection, deck_id: i64) -> i64 {
        crate::deck::deck_group(conn, deck_id)
            .unwrap()
            .expect("a deck that is not virtual has a group")
    }

    // deck.rs:6746-6753 (`removed_group`).
    fn removed(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// What the deck editor draws for one deck: `get_deck` (deck.rs:4914), then `deckStats`'
    /// copies-and-money loop (src/features/decks/DeckStats.tsx:455-509) — active rows only,
    /// `have = min(owned, quantity)`, a missing copy at its row's `unitPrice`, and the money
    /// `null` exactly when no counted row is priced. `unpriced_missing` is the missing copies of
    /// the unpriced rows, which is the contract's field and one step narrower than `unpriced`.
    struct Editor {
        wanted: i64,
        owned: i64,
        missing: i64,
        missing_cost: Option<f64>,
        unpriced_missing: i64,
    }

    fn editor(conn: &Connection, deck_id: i64, list: &str, market: Marketplace) -> Editor {
        let detail = crate::deck::get_deck(conn, deck_id, list, market)
            .unwrap()
            .expect("the deck is there");
        let (mut wanted, mut owned, mut missing, mut unpriced_missing, mut priced) =
            (0, 0, 0, 0, 0);
        let mut cost = 0.0;
        for card in detail.cards.iter().filter(|c| c.category_active) {
            let have = card.owned_quantity.min(card.quantity);
            let short = card.quantity - have;
            wanted += card.quantity;
            owned += have;
            missing += short;
            match card.unit_price {
                Some(price) => {
                    priced += card.quantity;
                    cost += price * short as f64;
                }
                None => unpriced_missing += short,
            }
        }
        Editor {
            wanted,
            owned,
            missing,
            missing_cost: (priced > 0).then_some(cost),
            unpriced_missing,
        }
    }

    /// Two sums of the same money taken in different orders, so equal to the float and no finer.
    fn assert_money(got: Option<f64>, want: Option<f64>, what: &str) {
        match (got, want) {
            (Some(g), Some(w)) => assert!((g - w).abs() < 1e-9, "{what}: {g} against {w}"),
            _ => assert_eq!(got, want, "{what}"),
        }
    }

    /// **The fence (spec §3.1).** For every deck, this read's `missing` and `missing_cost` are what
    /// `get_deck` plus the editor's arithmetic answer — over a live deck, a theory deck, a foil
    /// and a NULL-finish row of one printing, a foil-only printing on a NULL row, an inactive
    /// pile, a sideboard sharing the main pile's pool, a copy in `Recently removed`, copies in
    /// another deck's group, a locked folder, an unpriced printing, an empty deck and a virtual
    /// one. The numbers are pinned as well as compared, because a comparison alone passes over a
    /// fixture that built something other than what it says.
    #[test]
    fn every_deck_answers_what_its_editor_draws() {
        let conn = seeded();
        let a = make_deck(&conn, "Live", false, false);
        let b = make_deck(&conn, "Plan", true, false);
        let c = make_deck(&conn, "Other", false, false);
        let v = make_deck(&conn, "Proxies", false, true);
        let e = make_deck(&conn, "Empty", false, false);

        // A — the live list, measured against its own group.
        let a_main = pile(&conn, a, "Main deck");
        let a_side = seeded_pile(&conn, a, "side");
        let a_cuts = pile(&conn, a, "Cuts");
        crate::deck_meta::set_category_active(&conn, a_cuts, false).unwrap();
        put(&conn, a, a_main, LIVE, "bolt", None, 3);
        put(&conn, a, a_main, LIVE, "bolt", Some("foil"), 2);
        put(&conn, a, a_main, LIVE, "ring", None, 1);
        put(&conn, a, a_main, LIVE, "angel", None, 2);
        put(&conn, a, a_main, LIVE, "shiny", None, 1);
        put(&conn, a, a_side, LIVE, "bolt", None, 1);
        put(&conn, a, a_side, LIVE, "ring", None, 1);
        // Switched off: counts toward nothing and takes nothing from the pool.
        put(&conn, a, a_cuts, LIVE, "bird", None, 4);
        put(&conn, a, a_cuts, LIVE, "bolt", None, 1);

        // B — the plan is measured; its one live row is not.
        let b_main = pile(&conn, b, "Main deck");
        put(&conn, b, b_main, THEORY, "bolt", None, 4);
        put(&conn, b, b_main, THEORY, "ring", None, 1);
        put(&conn, b, b_main, THEORY, "angel", None, 1);
        put(&conn, b, b_main, THEORY, "bolt", Some("foil"), 1);
        put(&conn, b, b_main, LIVE, "bird", None, 1);

        // C — complete, and its group holds copies B may not count.
        let c_main = pile(&conn, c, "Main deck");
        put(&conn, c, c_main, LIVE, "ring", None, 2);

        // V — virtual, and answers no row whatever it lists.
        let v_main = pile(&conn, v, "Main deck");
        put(&conn, v, v_main, LIVE, "bird", None, 2);

        // The collection: every refiled copy first, then the reader's folders, then the root.
        copies(&conn, "bolt", "nonfoil", 2, Some(group(&conn, a)));
        copies(&conn, "bolt", "foil", 1, Some(group(&conn, a)));
        copies(&conn, "ring", "nonfoil", 1, Some(group(&conn, a)));
        copies(&conn, "bird", "nonfoil", 1, Some(group(&conn, a)));
        copies(&conn, "bolt", "nonfoil", 1, Some(group(&conn, b)));
        copies(&conn, "ring", "nonfoil", 5, Some(group(&conn, c)));
        copies(&conn, "bolt", "foil", 3, Some(group(&conn, c)));
        copies(&conn, "bolt", "nonfoil", 1, Some(removed(&conn)));
        let binder = crate::collection_folders::create_folder(&conn, None, "Binder")
            .unwrap()
            .id;
        filed(&conn, "bolt", "nonfoil", 1, binder);
        // Filed before it is locked, so the add is not the thing under test.
        let vault = crate::collection_folders::create_folder(&conn, None, "Vault")
            .unwrap()
            .id;
        filed(&conn, "ring", "nonfoil", 2, vault);
        filed(&conn, "bolt", "nonfoil", 5, vault);
        crate::collection_folders::set_folder_locked(&conn, vault, true).unwrap();
        copies(&conn, "angel", "nonfoil", 1, None);
        copies(&conn, "shiny", "foil", 1, None);

        let rows = deck_completion_for(&conn, Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.deck_id).collect::<Vec<_>>(),
            [a, b, c, e],
            "every deck but the virtual one, by id"
        );
        let row = |id: i64| rows.iter().find(|r| r.deck_id == id).unwrap();

        // A: wanted 4+2+2+2+1 over its active piles; its group owns 2 Bolts, 1 foil Bolt and
        // 1 Sol Ring. Recently removed, the binder and the root are not its box.
        let got = row(a);
        assert_eq!(
            (got.list.as_str(), got.wanted, got.owned, got.missing, got.unpriced_missing),
            ("live", 11, 4, 7, 2)
        );
        assert_money(got.missing_cost, Some(24.0), "A: 2×2.00 + 1×10.00 + 1×3.00 + 1×7.00");

        // B: its own group, Recently removed and the binder give 3 Bolts; the root gives the
        // Angel; A's and C's groups and the locked vault give nothing.
        let got = row(b);
        assert_eq!(
            (got.list.as_str(), got.wanted, got.owned, got.missing, got.unpriced_missing),
            ("theory", 7, 4, 3, 0)
        );
        assert_money(got.missing_cost, Some(15.0), "B: 1×2.00 + 1×3.00 + 1×10.00");

        // C: complete, and priced, so the money is a zero rather than nothing.
        let got = row(c);
        assert_eq!(
            (got.list.as_str(), got.wanted, got.owned, got.missing, got.unpriced_missing),
            ("live", 2, 2, 0, 0)
        );
        assert_money(got.missing_cost, Some(0.0), "C");

        // E: a deck with nothing in it is a row of zeros, and prices nothing.
        let got = row(e);
        assert_eq!(
            (got.list.as_str(), got.wanted, got.owned, got.missing, got.unpriced_missing),
            ("live", 0, 0, 0, 0)
        );
        assert_eq!(got.missing_cost, None);

        // And the fence itself, at a shop that quotes these cards and at one that quotes none.
        for market in [Marketplace::Tcgplayer, Marketplace::Cardmarket] {
            for got in deck_completion_for(&conn, market).unwrap() {
                let want = editor(&conn, got.deck_id, &got.list, market);
                let what = format!("deck {} at {market:?}", got.deck_id);
                assert_eq!(
                    (got.wanted, got.owned, got.missing, got.unpriced_missing),
                    (want.wanted, want.owned, want.missing, want.unpriced_missing),
                    "{what}"
                );
                assert_money(got.missing_cost, want.missing_cost, &what);
            }
        }
    }

    /// The wire names the page reads — `ipc.test.ts`' struct table cannot see whether serde
    /// actually camel-cases.
    #[test]
    fn a_completion_serialises_under_the_names_the_page_reads() {
        let wire = serde_json::to_value(DeckCompletion {
            deck_id: 7,
            list: "theory".into(),
            wanted: 100,
            owned: 96,
            missing: 4,
            missing_cost: None,
            unpriced_missing: 1,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "deckId": 7, "list": "theory", "wanted": 100, "owned": 96, "missing": 4,
                "missingCost": null, "unpricedMissing": 1
            })
        );
    }
}
```

In `src-tauri/src/lib.rs`, declare the module so the tests compile (Step 3 fills in its doc comment):

```rust
// before (lib.rs:68-69)
pub mod deck_audit;
pub mod deck_meta;

// after
pub mod deck_audit;
pub mod deck_completion;
pub mod deck_meta;
```

In `src-tauri/src/web/route.rs`, inside `mod tests`, directly after the closing `}` of
`fn the_new_printings_pair_is_routed()`:

```rust
    // route.rs:2876-2888 (`make_deck`) is this module's deck, a commander deck with a group.
    /// **The Deck completion read, routed.** Before any deck it answers `[]`; a deck of two
    /// unpriced copies it does not hold answers one row under the camel-cased names `ipc.ts`
    /// reads, and an absent `marketplace` quotes TCGplayer rather than refusing the widget.
    #[test]
    fn the_deck_completion_read_is_routed() {
        assert!(COMMANDS.contains(&"deck_completion"));
        let s = state("web-route-deck-completion");
        assert_eq!(call(&s, "deck_completion", &json!({})).unwrap(), json!([]));

        let id = make_deck(&s, "Web Deck");
        {
            let conn = crate::db::lock_blocking(&s.db);
            let main = crate::deck_meta::category_for_name(&conn, id, "Main deck").unwrap();
            crate::deck::add_card(&conn, id, "1", Some(main), None, "live", None, 2).unwrap();
        }
        let out = call(&s, "deck_completion", &json!({ "marketplace": "manapool" })).unwrap();
        assert_eq!(
            out,
            json!([{
                "deckId": id, "list": "live", "wanted": 2, "owned": 0, "missing": 2,
                "missingCost": null, "unpricedMissing": 2
            }])
        );
        assert_eq!(call(&s, "deck_completion", &json!({})).unwrap(), out);
    }
```

- [ ] **Step 2: Run it to see it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- deck_completion
```

Expected: the test build fails to compile in `src/deck_completion.rs` — `cannot find function
`deck_completion_for` in this scope`, `cannot find struct ... `DeckCompletion``, `cannot find type
`Marketplace``, and `cannot find value `LIVE`` / ``THEORY``. (If it instead prints
`running 0 tests`, the `pub mod deck_completion;` line is missing.)

- [ ] **Step 3: Implement**

3a. `src-tauri/src/deck.rs` — visibility only:

```rust
// before (deck.rs:5249)
fn owned_by_printing(
// after
pub(crate) fn owned_by_printing(

// before (deck.rs:5309)
fn available_by_printing(
// after
pub(crate) fn available_by_printing(
```

3b. `src-tauri/src/deck_completion.rs` — put this **above** the `#[cfg(test)] mod tests` from Step 1:

```rust
//! The home page's **Deck completion** read: for every deck, how many copies its measured list
//! wants, how many the reader holds, and what the rest would cost.
//!
//! **Owned is exactly what the deck editor calls owned**, rule for rule — a widget reading
//! *4 missing* over a deck that opens reading *6 missing* is a bug report (spec
//! `2026-09-26-home-widgets-round-two-design.md` §3.1):
//!
//! * A deck without a theory plan measures its **live** list against its own group,
//!   [`crate::deck::owned_by_printing`]. A deck with `theory_enabled` measures its **theory**
//!   list against every copy it could be built from, [`crate::deck::available_by_printing`] —
//!   the same choice `get_deck` makes by variant.
//! * **Every active pile counts**, sideboard and companion included: this is `DeckStats`'
//!   `missing`, and deliberately not [`crate::deck::deck_values_for`]'s narrower
//!   main + commander + maybe.
//! * The key is `(card_id, finish)`, a NULL deck finish meaning [`crate::schema::FINISHES`]`[0]`.
//!   `attribute_owned` hands a scarce pool down the read order, so summed over one key it owns
//!   `min(Σ wanted, pool)` — which is what this read computes directly.
//! * A missing copy costs its row's own price, [`crate::sorting::deck_card_price_expr`], which
//!   depends on the key alone. `missing_cost` is `None` exactly when nothing on the measured list
//!   is priced — `DeckStats`' `missingPrice`, `priced === 0 ? null : …`.
//!
//! **The pools are read through `deck.rs`'s own two functions, one statement per deck, and not
//! restated as one correlated statement over every deck.** [`crate::collection_source`]'s
//! `ForDeck` arm interpolates a literal deck id, so a single statement would need a second
//! spelling of "what this deck can use" — the drift that module exists to prevent. What is
//! aggregated in SQL is what can be: the wanted copies and the price per key, in one statement.
//!
//! **Virtual decks answer no row** — they hold nothing by definition, and 0% of every deck is not
//! a finding. **Tokens never count**: they are `deck_tokens`, which nothing here reads. A deck
//! with nothing on its measured list answers a row of zeros and reads no pool at all.
//!
//! Connection in, DTO out, no clock and no network, so it answers in a browser as on the desktop.

use crate::sorting::Marketplace;
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// `deck_cards.variant` for the list that is sleeved up.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// `deck_cards.variant` for the plan.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];
/// What a NULL deck-row finish is on the collection side — `attribute_owned`'s translation.
const REGULAR: &str = crate::schema::FINISHES[0];

/// One deck's completion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCompletion {
    pub deck_id: i64,
    /// `live` | `theory` — which list was measured.
    pub list: String,
    /// Copies the measured list asks for, active piles only.
    pub wanted: i64,
    /// Of those, copies the pool covers.
    pub owned: i64,
    /// `wanted − owned`.
    pub missing: i64,
    /// What the missing copies cost at the marketplace, summed over the priced ones.
    ///
    /// **`None` exactly when nothing on the measured list is priced**, which is the editor's rule
    /// and not "no missing copy is priced": a complete, priced deck is `Some(0.0)`, and so is a
    /// deck whose only missing copies are unpriced — beside a non-zero
    /// [`Self::unpriced_missing`].
    pub missing_cost: Option<f64>,
    /// Missing copies the marketplace has no price for — the widget's hint.
    pub unpriced_missing: i64,
}

/// One key of one deck's measured list: the copies wanted and what one costs.
struct Want {
    card_id: String,
    finish: String,
    wanted: i64,
    unit_price: Option<f64>,
}

/// Every non-virtual deck's completion at `marketplace`, ascending by id.
pub fn deck_completion_for(
    conn: &Connection,
    marketplace: Marketplace,
) -> Result<Vec<DeckCompletion>, String> {
    let decks = measured_decks(conn)?;
    let mut wants = wanted_by_deck(conn, marketplace)?;
    let mut out = Vec::with_capacity(decks.len());
    for (deck_id, theory) in decks {
        let wants = wants.remove(&deck_id).unwrap_or_default();
        // The editor's one line (`get_deck`, deck.rs:4932-4936): the list picks the pool.
        let pool = if wants.is_empty() {
            HashMap::new()
        } else if theory {
            crate::deck::available_by_printing(conn, deck_id)?
        } else {
            crate::deck::owned_by_printing(conn, deck_id)?
        };
        out.push(measure(deck_id, theory, &wants, &pool));
    }
    Ok(out)
}

/// Every deck this read answers for, and whether it measures its plan. `virtual_only = 0` also
/// drops the kindless `1/1` pair, which `deckKind.ts` reads as virtual.
fn measured_decks(conn: &Connection) -> Result<Vec<(i64, bool)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, theory_enabled FROM decks WHERE virtual_only = 0 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The copies every deck's measured list wants, per `(card_id, finish)`, with the key's price.
///
/// **The pile filter sits in the join**, `deck_values_for`'s arrangement: only active piles, and
/// only rows of the list the deck is measured by. The price is a bare column beside the `sum()`
/// — every row of a group shares `dc.card_id` and `dc.finish`, and so the `cards` row and the
/// price. `GROUP BY dc.finish` groups the NULLs together, which is the regular copy's one key.
fn wanted_by_deck(
    conn: &Connection,
    marketplace: Marketplace,
) -> Result<HashMap<i64, Vec<Want>>, String> {
    let price = crate::sorting::deck_card_price_expr(marketplace);
    let sql = format!(
        "SELECT dc.deck_id, dc.card_id, coalesce(dc.finish, '{REGULAR}'), sum(dc.quantity),
                {price}
           FROM decks d
           JOIN deck_categories cat
             ON cat.deck_id = d.id
            AND cat.is_active = 1
           JOIN deck_cards dc
             ON dc.category_id = cat.id
            AND dc.deck_id = d.id
            AND dc.variant = CASE WHEN d.theory_enabled = 1 THEN '{THEORY}' ELSE '{LIVE}' END
           LEFT JOIN cards c ON c.id = dc.card_id
          WHERE d.virtual_only = 0
          GROUP BY dc.deck_id, dc.card_id, dc.finish"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Want {
                    card_id: r.get(1)?,
                    finish: r.get(2)?,
                    wanted: r.get(3)?,
                    unit_price: r.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: HashMap<i64, Vec<Want>> = HashMap::new();
    for row in rows {
        let (deck_id, want) = row.map_err(|e| e.to_string())?;
        out.entry(deck_id).or_default().push(want);
    }
    Ok(out)
}

/// One deck's numbers from its wanted keys and its pool — `deckStats`' loop at the key's grain.
fn measure(
    deck_id: i64,
    theory: bool,
    wants: &[Want],
    pool: &HashMap<(String, String), i64>,
) -> DeckCompletion {
    let mut row = DeckCompletion {
        deck_id,
        list: if theory { THEORY } else { LIVE }.to_owned(),
        wanted: 0,
        owned: 0,
        missing: 0,
        missing_cost: None,
        unpriced_missing: 0,
    };
    let mut priced = false;
    let mut cost = 0.0;
    for want in wants {
        let held = pool
            .get(&(want.card_id.clone(), want.finish.clone()))
            .copied()
            .unwrap_or(0);
        // `attribute_owned`'s `min(remaining, quantity).max(0)`, summed over the key.
        let have = held.min(want.wanted).max(0);
        let short = want.wanted - have;
        row.wanted += want.wanted;
        row.owned += have;
        row.missing += short;
        match want.unit_price {
            Some(price) => {
                priced = true;
                cost += price * short as f64;
            }
            None => row.unpriced_missing += short,
        }
    }
    row.missing_cost = priced.then_some(cost);
    row
}

/// Every deck's completion, for the home page. **Read-only** connection, blocking pool, as every
/// read in this app is — [`crate::deck::deck_values`]' shape exactly, marketplace and fallback
/// included: anything this build does not recognise quotes TCGplayer rather than failing.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_completion(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: Option<String>,
) -> Result<Vec<DeckCompletion>, String> {
    let state = state.inner().clone();
    let marketplace = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        deck_completion_for(&crate::sync::lock_db_read(&state), marketplace)
    })
    .await
    .map_err(|e| format!("the deck completion could not be read: {e}"))?
}
```

3c. `src-tauri/src/lib.rs` — give the declaration from Step 1 its doc comment:

```rust
// before
pub mod deck_audit;
pub mod deck_completion;
pub mod deck_meta;

// after
pub mod deck_audit;
/// **The home page's Deck completion read** — how much of each deck the reader holds and what the
/// rest costs, by the deck editor's own rules and through its own two pool functions. No table of
/// its own, no clock and no network, so it sits on the every-target half with the deck modules.
pub mod deck_completion;
pub mod deck_meta;
```

3d. `src-tauri/src/desktop.rs` — the import list (lines 21-29) gains `deck_completion` after
`deck_audit` (`cargo fmt` in Step 5 rewraps the list):

```rust
// before
    activity, camera, card, collection, collection_alloc, collection_folders, combos, db, deck,
    deck_audit, deck_meta, deck_missing, deck_notes, deck_pull, deck_quick_add, deck_theory,

// after
    activity, camera, card, collection, collection_alloc, collection_folders, combos, db, deck,
    deck_audit, deck_completion, deck_meta, deck_missing, deck_notes, deck_pull, deck_quick_add,
    deck_theory,
```

and the handler list:

```rust
// before
            new_printings::new_printings,
            new_printings::mark_new_printings_seen,
            startview::start_view,

// after
            new_printings::new_printings,
            new_printings::mark_new_printings_seen,
            // The Deck completion widget: every deck's missing count and cost, on the read-only
            // connection, by the deck editor's own rules.
            deck_completion::deck_completion,
            startview::start_view,
```

3e. `src-tauri/src/web/route.rs` — `COMMANDS`:

```rust
// before
    "new_printings",
    "mark_new_printings_seen",
    "start_view",

// after
    "new_printings",
    "mark_new_printings_seen",
    // **The Deck completion widget's read.** Connection-only and clockless — one statement over
    // the decks and their piles plus the editor's own pool read per deck — so it is not a
    // download wearing a command's name.
    "deck_completion",
    "start_view",
```

the match arm, directly after the `"mark_new_printings_seen" => { … }` arm:

```rust
        // `deck_values`' arm, argument for argument: `marketplace` is `optional` and goes through
        // `Marketplace::from_opt`, so an absent or unknown one quotes TCGplayer.
        "deck_completion" => {
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_completion::deck_completion_for(&conn, marketplace)
                    .map_err(RouteError::Failed)?,
            )
        }
```

and the count in `every_advertised_command_is_actually_routed` — confirm the number with
`awk '/^pub const COMMANDS/,/^\];/' src-tauri/src/web/route.rs | grep -c '^\s*"'` (Bash tool) and
write what it prints (182 unless `main` has moved):

```rust
// before
        // **181 since a mover's detail routed `price_history`**, counted with that `awk` over the
        // array as it stands here — which answered 180 before it, not the 179 above, so the
        // literal had already moved once without this paragraph.
        assert_eq!(
            COMMANDS.len(),
            181,
            "update this number when a command is added"
        );

// after
        // **181 since a mover's detail routed `price_history`**, counted with that `awk` over the
        // array as it stands here — which answered 180 before it, not the 179 above, so the
        // literal had already moved once without this paragraph.
        //
        // **182 since the home widgets' second round routed `deck_completion`**, counted with the
        // same `awk`. If a later merge turns this red, take the number from `left`.
        assert_eq!(
            COMMANDS.len(),
            182,
            "update this number when a command is added"
        );
```

- [ ] **Step 4: Run to see it pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- deck_completion every_advertised_command_is_actually_routed
```

Expected: 4 tests, all passing — `deck_completion::tests::every_deck_answers_what_its_editor_draws`,
`deck_completion::tests::a_completion_serialises_under_the_names_the_page_reads`,
`web::route::tests::the_deck_completion_read_is_routed`,
`web::route::tests::every_advertised_command_is_actually_routed`. A count of 0 means the module is
undeclared.

- [ ] **Step 5: cargo fmt and clippy on the crate**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
$env:PATH = "C:\Program Files\LLVM\bin;$env:PATH"; cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked --target wasm32-unknown-unknown -- -D warnings
```

The third line is CI's wasm leg (it needs clang on `PATH` and `--lib`); it is what catches an
ungated `use` of `AppState`/`Arc`. All three clean. Re-run Step 4 if `cargo fmt` changed a file.

---

### Task 2 (R2): `deck_review_count`

**Files:**
- Modify: `src-tauri/src/deck_completion.rs` — module doc (first paragraph), a new fn and command above `#[cfg(test)]`, a new test in `mod tests`
- Modify: `src-tauri/src/lib.rs` — the `deck_completion` doc comment
- Modify: `src-tauri/src/desktop.rs` — handler list (after `deck_completion::deck_completion,`)
- Modify: `src-tauri/src/web/route.rs` — `COMMANDS` (after `"deck_completion",`), the match (after the `"deck_completion"` arm), tests (after `the_deck_completion_read_is_routed`), the `COMMANDS.len()` literal
- Test: `src-tauri/src/deck_completion.rs`, `src-tauri/src/web/route.rs`

**Interfaces:**
- Consumes: R1's test helpers (`seeded`, `make_deck`, `pile`, `put`, `copies`) and `LIVE`/`THEORY`; `crate::sync::lock_db_read`
- Produces:
  - `pub fn review_count(conn: &Connection) -> Result<i64, String>`
  - `#[tauri::command] pub async fn deck_review_count(state: tauri::State<'_, Arc<AppState>>) -> Result<i64, String>` — wire name `deck_review_count`, no arguments

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/deck_completion.rs`, inside `mod tests`, after
`a_completion_serialises_under_the_names_the_page_reads`:

```rust
    /// **To review's deck row** (spec §4.1): every `deck_cards` row carrying a sentence, either
    /// list, any deck — `sync_engine/commands.rs:111`'s per-table count for `deck_cards`, so the
    /// widget and the Needs review panel it opens agree. A flagged binder row is the collection's
    /// count and not this one.
    #[test]
    fn the_review_count_counts_flagged_deck_rows_and_nothing_else() {
        let conn = seeded();
        assert_eq!(review_count(&conn).unwrap(), 0, "an empty database");
        let live = make_deck(&conn, "Live", false, false);
        let plan = make_deck(&conn, "Plan", true, false);
        let live_main = pile(&conn, live, "Main deck");
        let plan_main = pile(&conn, plan, "Main deck");
        put(&conn, live, live_main, LIVE, "bolt", None, 1);
        put(&conn, live, live_main, LIVE, "ring", None, 1);
        put(&conn, plan, plan_main, THEORY, "angel", None, 1);
        assert_eq!(review_count(&conn).unwrap(), 0, "a row with no sentence is not flagged");

        conn.execute(
            "UPDATE deck_cards SET needs_review = 'That printing left the card database.'
              WHERE card_id IN ('bolt', 'angel')",
            [],
        )
        .unwrap();
        assert_eq!(review_count(&conn).unwrap(), 2, "a flagged row in either list");

        let entry = copies(&conn, "ring", "nonfoil", 1, None);
        conn.execute(
            "UPDATE collection_entries SET needs_review = 'Folded.' WHERE id = ?1",
            params![entry],
        )
        .unwrap();
        assert_eq!(review_count(&conn).unwrap(), 2, "a flagged binder row is not a deck row");
    }
```

In `src-tauri/src/web/route.rs`, inside `mod tests`, after `the_deck_completion_read_is_routed`:

```rust
    /// **To review's deck-card count, routed.** It is its own read rather than
    /// `sync_relay_status.reviewCount`, which sums six tables and is desktop-only, so a browser
    /// that could not answer it would draw that row as an error.
    #[test]
    fn the_deck_review_count_is_routed() {
        assert!(COMMANDS.contains(&"deck_review_count"));
        let s = state("web-route-deck-review-count");
        assert_eq!(call(&s, "deck_review_count", &json!({})).unwrap(), json!(0));

        let id = make_deck(&s, "Web Deck");
        {
            let conn = crate::db::lock_blocking(&s.db);
            let main = crate::deck_meta::category_for_name(&conn, id, "Main deck").unwrap();
            crate::deck::add_card(&conn, id, "1", Some(main), None, "live", None, 1).unwrap();
            crate::deck::add_card(&conn, id, "3", Some(main), None, "live", None, 1).unwrap();
            conn.execute(
                "UPDATE deck_cards SET needs_review = 'Flagged.' WHERE card_id = '1'",
                [],
            )
            .unwrap();
        }
        assert_eq!(call(&s, "deck_review_count", &json!({})).unwrap(), json!(1));
    }
```

- [ ] **Step 2: Run it to see it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- deck_completion deck_review_count
```

Expected: compile error in `src/deck_completion.rs` — `cannot find function `review_count` in this
scope`.

- [ ] **Step 3: Implement**

3a. `src-tauri/src/deck_completion.rs` — the module doc's first paragraph:

```rust
// before
//! The home page's **Deck completion** read: for every deck, how many copies its measured list
//! wants, how many the reader holds, and what the rest would cost.

// after
//! The home page's **Deck completion** read: for every deck, how many copies its measured list
//! wants, how many the reader holds, and what the rest would cost — and, at the foot of the file,
//! **To review**'s count of deck rows flagged for review ([`review_count`]).
```

and, between the `deck_completion` command and `#[cfg(test)]`:

```rust
/// How many `deck_cards` rows carry a `needs_review` sentence — any deck, either list.
///
/// **`sync_engine/commands.rs:111`'s count for this one table**, so To review's row and the Needs
/// review panel it opens say one number. Not `sync_relay_status.reviewCount` itself: that sums six
/// tables into one figure, is desktop-only and takes the write lock (spec §4.1).
pub fn review_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT count(*) FROM deck_cards WHERE needs_review IS NOT NULL",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// To review's deck-card count. **Read-only** connection, blocking pool.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_review_count(state: tauri::State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || review_count(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck cards to review could not be counted: {e}"))?
}
```

3b. `src-tauri/src/lib.rs`:

```rust
// before
/// **The home page's Deck completion read** — how much of each deck the reader holds and what the
/// rest costs, by the deck editor's own rules and through its own two pool functions. No table of
/// its own, no clock and no network, so it sits on the every-target half with the deck modules.
pub mod deck_completion;

// after
/// **The home page's Deck completion read and To review's deck-card count** — how much of each
/// deck the reader holds and what the rest costs, by the deck editor's own rules and through its
/// own two pool functions, and how many deck rows are flagged. No table of its own, no clock and
/// no network, so it sits on the every-target half with the deck modules.
pub mod deck_completion;
```

3c. `src-tauri/src/desktop.rs` handler list:

```rust
// before
            deck_completion::deck_completion,
            startview::start_view,

// after
            deck_completion::deck_completion,
            // To review's deck-card count — its own read, not `sync_relay_status`'s six-table sum.
            deck_completion::deck_review_count,
            startview::start_view,
```

3d. `src-tauri/src/web/route.rs` — `COMMANDS`:

```rust
// before
    "deck_completion",
    "start_view",

// after
    "deck_completion",
    // **To review's deck-card count**, one `count(*)`. `sync_review_list` is not routed here, so
    // the widget draws this row without a press on this target; the number itself still answers.
    "deck_review_count",
    "start_view",
```

the match arm, directly after the `"deck_completion"` arm:

```rust
        "deck_review_count" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_completion::review_count(&conn).map_err(RouteError::Failed)?,
            )
        }
```

and the count (confirm with the same `awk`; 183 unless `main` has moved):

```rust
// before
        // **182 since the home widgets' second round routed `deck_completion`**, counted with the
        // same `awk`. If a later merge turns this red, take the number from `left`.
        assert_eq!(
            COMMANDS.len(),
            182,

// after
        // **183 since the home widgets' second round routed `deck_completion` and
        // `deck_review_count`**, counted with the same `awk`. If a later merge turns this red,
        // take the number from `left`.
        assert_eq!(
            COMMANDS.len(),
            183,
```

- [ ] **Step 4: Run to see it pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- deck_completion deck_review_count every_advertised_command_is_actually_routed
```

Expected: 6 tests pass — R1's four plus
`deck_completion::tests::the_review_count_counts_flagged_deck_rows_and_nothing_else` and
`web::route::tests::the_deck_review_count_is_routed`.

- [ ] **Step 5: cargo fmt and clippy on the crate**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
$env:PATH = "C:\Program Files\LLVM\bin;$env:PATH"; cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked --target wasm32-unknown-unknown -- -D warnings
```

All three clean; re-run Step 4 if `cargo fmt` changed a file.

---

### Task 3 (R3): `upcoming_sets`

**Files:**
- Create: `src-tauri/src/upcoming_sets.rs`
- Modify: `src-tauri/src/lib.rs` (between `pub mod transfer;` and the doc comment of `pub mod update;`, lines 233-234)
- Modify: `src-tauri/src/new_printings.rs` — `const BASIC_LAND_LIKE` (line 93) becomes `pub(crate)`; no other change
- Modify: `src-tauri/src/search.rs` — `const NON_CARD_LAYOUTS` (line 562) becomes `pub(crate)`; no other change
- Modify: `src-tauri/src/desktop.rs` — the import list and the handler list (after `deck_completion::deck_review_count,`)
- Modify: `src-tauri/src/web/route.rs` — `COMMANDS` (after `"deck_review_count",`), the match (after the `"deck_review_count"` arm), tests (after `the_deck_review_count_is_routed`), the `COMMANDS.len()` literal
- Test: `src-tauri/src/upcoming_sets.rs` (`mod tests`), `src-tauri/src/web/route.rs`

**Interfaces:**
- Consumes: `crate::new_printings::BASIC_LAND_LIKE: &str` (`"Basic %Land%"`, made `pub(crate)` here); `crate::sync::lock_db_read`
- Produces:
  - `pub struct UpcomingSets { pub today: String, pub sets: Vec<UpcomingSet> }` and `pub struct UpcomingSet { pub code: String, pub name: String, pub released_at: String, pub previewed: i64, pub in_decks: i64 }` — both `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]`
  - `pub fn upcoming_sets_for(conn: &Connection, days: i64) -> Result<UpcomingSets, String>` — `days` clamped `1..=365`, sets soonest first then by code
  - `#[tauri::command] pub async fn upcoming_sets(state: tauri::State<'_, Arc<AppState>>, days: i64) -> Result<UpcomingSets, String>` — wire name `upcoming_sets`, argument `days` (required)

**Corpus and user tables in one statement:** `db::open_read`/`open_write` attach `corpus.db` as
`corpus`, so `cards` and `sets` (corpus) and `deck_cards`/`decks` (user) are named unqualified
in one statement, exactly as `new_printings.rs:314-336` does. Tests use `schema::memory_pair()`,
the same pair in memory; seeding `cards` in a test's in-memory pair is what every corpus-reading
test in the crate does (`new_printings.rs:597-615`) and touches no real `data/` folder.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/upcoming_sets.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // new_printings.rs:571-573 — the real pair, because the read joins `deck_cards` in the user
    // file to `cards` in the attached corpus.
    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    // new_printings.rs:597-615 (`printing`) — one paper printing, dated relative to SQLite's own
    // `date('now')` so a window is testable without a clock injected into the read. A negative
    // `days_ahead` is the past; zero is today. `type_line` and `lang` are set by UPDATE where a
    // test needs them, which keeps this at seven arguments.
    fn card(c: &Connection, id: &str, oracle: &str, set: &str, cn: &str, days_ahead: i64, layout: &str) {
        c.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang,
                                layout, released_at, is_paper, type_line, raw)
             VALUES (?1, ?2, ?2, ?3, 'Set ' || upper(?3), ?4, 'en', ?5,
                     date('now', ?6), 1, 'Artifact', '{}')",
            params![id, oracle, set, cn, layout, format!("{days_ahead:+} days")],
        )
        .unwrap();
    }

    // new_printings.rs:619-633 (`deck`) — one deck and the one pile its cards are filed under.
    fn deck(c: &Connection, id: i64, name: &str, virtual_only: bool) {
        c.execute(
            "INSERT INTO decks (id, name, format_key, virtual_only, created_at, updated_at)
             VALUES (?1, ?2, 'commander', ?3, 0, 0)",
            params![id, name, virtual_only],
        )
        .unwrap();
        c.execute(
            "INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
             VALUES (?1, ?1, 'Main deck', 'main', 1, 0, 0, 0)",
            params![id],
        )
        .unwrap();
    }

    // new_printings.rs:635-644 (`holds`) — one deck holding one printing, at `variant`.
    fn holds(c: &Connection, deck_id: i64, card_id: &str, qty: i64, variant: &str) {
        c.execute(
            "INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, created_at, updated_at)
             VALUES (?1, ?1, ?2, ?3, 'x', '1', 'en', ?3, ?4, 0, 0)",
            params![deck_id, variant, card_id, qty],
        )
        .unwrap();
    }

    fn codes(out: &UpcomingSets) -> Vec<&str> {
        out.sets.iter().map(|s| s.code.as_str()).collect()
    }

    /// **Both edges, and the clamp.** Today is not upcoming, the window's last day is, the day
    /// after it is not — and a hand-edited window is narrowed into `1..=365` rather than refused
    /// or passed through.
    #[test]
    fn the_window_is_after_today_up_to_its_last_day() {
        let c = conn();
        card(&c, "past", "o1", "old", "1", -5, "normal");
        card(&c, "today", "o2", "tdy", "1", 0, "normal");
        card(&c, "soon", "o3", "son", "1", 1, "normal");
        card(&c, "edge", "o4", "edg", "1", 90, "normal");
        card(&c, "late", "o5", "lat", "1", 91, "normal");
        assert_eq!(codes(&upcoming_sets_for(&c, 90).unwrap()), ["son", "edg"]);
        assert_eq!(codes(&upcoming_sets_for(&c, 89).unwrap()), ["son"]);
        assert_eq!(codes(&upcoming_sets_for(&c, 0).unwrap()), ["son"], "zero is one day");
        assert_eq!(codes(&upcoming_sets_for(&c, -30).unwrap()), ["son"], "and so is a negative");

        card(&c, "year", "o6", "yer", "1", 365, "normal");
        card(&c, "beyond", "o7", "bey", "1", 366, "normal");
        assert_eq!(
            codes(&upcoming_sets_for(&c, 99_999).unwrap()),
            ["son", "edg", "lat", "yer"],
            "a year at most"
        );
    }

    /// **Each excluded layout, and a printing that is not paper.** A set is counted by its real
    /// cards only, and a set of nothing but tokens is no set at all.
    #[test]
    fn each_excluded_layout_and_a_digital_printing_are_left_out() {
        let c = conn();
        card(&c, "real", "o-real", "tdm", "1", 10, "normal");
        for (i, layout) in ["token", "double_faced_token", "emblem", "art_series", "front_card"]
            .iter()
            .enumerate()
        {
            card(&c, &format!("x{i}"), &format!("o-x{i}"), "tdm", &format!("t{i}"), 10, layout);
        }
        card(&c, "arena", "o-arena", "tdm", "9", 10, "normal");
        c.execute("UPDATE cards SET is_paper = 0 WHERE id = 'arena'", [])
            .unwrap();
        card(&c, "tok", "o-tok", "ttdm", "1", 10, "token");

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["tdm"]);
        assert_eq!(out.sets[0].previewed, 1, "only the real card is previewed");
    }

    /// **`set_type` decides only where `sets` has a row.** The browser build never fills `sets`,
    /// so there the layout filter is the whole rule; on the desktop the four non-release types
    /// drop out, and a row with no type is kept.
    #[test]
    fn a_sets_row_drops_the_four_non_release_types_and_no_row_drops_nothing() {
        let c = conn();
        for code in ["exp", "prm", "mem", "mng", "tkn", "unk"] {
            card(&c, &format!("{code}-1"), &format!("o-{code}"), code, "1", 10, "normal");
        }
        assert_eq!(
            codes(&upcoming_sets_for(&c, 90).unwrap()),
            ["exp", "mem", "mng", "prm", "tkn", "unk"],
            "no `sets` rows, nothing dropped — same day, so by code"
        );

        c.execute_batch(
            "INSERT INTO sets (code, name, set_type) VALUES
               ('exp', 'Expansion', 'expansion'),
               ('prm', 'Promos', 'promo'),
               ('mem', 'Memorabilia', 'memorabilia'),
               ('mng', 'Minigames', 'minigame'),
               ('tkn', 'Tokens', 'token'),
               ('unk', 'Unknown', NULL);",
        )
        .unwrap();
        assert_eq!(codes(&upcoming_sets_for(&c, 90).unwrap()), ["exp", "unk"]);
    }

    /// **`in_decks` is `new_printings`' defaults**: a card counts once however many printings or
    /// languages of it the set previews, a theory row counts, and a card held only by a virtual
    /// deck or a basic land does not. `previewed` counts collector numbers, so a second language
    /// of one card is not a second card.
    #[test]
    fn in_decks_counts_held_cards_once_and_skips_basics_and_virtual_decks() {
        let c = conn();
        card(&c, "old-ring", "o-ring", "lea", "1", -900, "normal");
        card(&c, "old-bird", "o-bird", "lea", "2", -900, "normal");
        card(&c, "old-forest", "o-forest", "lea", "3", -900, "normal");
        card(&c, "old-angel", "o-angel", "lea", "4", -900, "normal");
        card(&c, "new-ring", "o-ring", "tdm", "1", 20, "normal");
        card(&c, "new-ring-ja", "o-ring", "tdm", "1", 20, "normal");
        card(&c, "new-ring-show", "o-ring", "tdm", "301", 20, "normal");
        card(&c, "new-bird", "o-bird", "tdm", "2", 20, "normal");
        card(&c, "new-forest", "o-forest", "tdm", "3", 20, "normal");
        card(&c, "new-angel", "o-angel", "tdm", "4", 20, "normal");
        card(&c, "new-other", "o-other", "tdm", "5", 20, "normal");
        c.execute_batch(
            "UPDATE cards SET lang = 'ja' WHERE id = 'new-ring-ja';
             UPDATE cards SET type_line = 'Basic Land — Forest' WHERE oracle_id = 'o-forest';",
        )
        .unwrap();
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old-ring", 1, "live");
        holds(&c, 1, "old-forest", 10, "live");
        deck(&c, 2, "Proxies", true);
        holds(&c, 2, "old-bird", 1, "live");
        deck(&c, 3, "Plan", false);
        holds(&c, 3, "old-angel", 1, "theory");

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["tdm"]);
        assert_eq!(out.sets[0].previewed, 6, "1, 301, 2, 3, 4 and 5 — the Japanese Sol Ring shares 1");
        assert_eq!(
            out.sets[0].in_decks, 2,
            "Sol Ring and Serra Angel; the bird is only in a virtual deck and the Forest is basic"
        );
    }

    /// **Soonest first, then by code; a set's date is its earliest card's; `today` is SQLite's
    /// UTC date, and a set with no name in `cards` answers its code.**
    #[test]
    fn sets_are_soonest_first_and_today_is_sqlite_s_date() {
        let c = conn();
        card(&c, "b1", "o1", "bbb", "1", 30, "normal");
        card(&c, "a1", "o2", "aaa", "1", 30, "normal");
        card(&c, "z1", "o3", "zzz", "1", 5, "normal");
        card(&c, "z2", "o4", "zzz", "2", 40, "normal");
        c.execute("UPDATE cards SET set_name = NULL WHERE set_code = 'aaa'", [])
            .unwrap();

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["zzz", "aaa", "bbb"]);
        let (today, in_five): (String, String) = c
            .query_row("SELECT date('now'), date('now', '+5 days')", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(out.today, today);
        assert_eq!(out.sets[0].released_at, in_five, "the earliest card's date");
        assert_eq!(out.sets[0].previewed, 2);
        assert_eq!(out.sets[0].name, "Set ZZZ");
        assert_eq!(out.sets[1].name, "aaa", "no set name falls back to the code");
    }

    /// An empty corpus is an ordinary answer — today, and no sets.
    #[test]
    fn nothing_announced_is_an_empty_list_not_an_error() {
        let c = conn();
        let out = upcoming_sets_for(&c, 90).unwrap();
        assert!(out.sets.is_empty());
        assert_eq!(out.today.len(), 10, "YYYY-MM-DD");
    }

    /// The wire names the page reads.
    #[test]
    fn upcoming_sets_serialise_under_the_names_the_page_reads() {
        let wire = serde_json::to_value(UpcomingSets {
            today: "2026-09-26".into(),
            sets: vec![UpcomingSet {
                code: "tdm".into(),
                name: "Tarkir: Dragonstorm".into(),
                released_at: "2026-10-08".into(),
                previewed: 79,
                in_decks: 3,
            }],
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "today": "2026-09-26",
                "sets": [{
                    "code": "tdm", "name": "Tarkir: Dragonstorm", "releasedAt": "2026-10-08",
                    "previewed": 79, "inDecks": 3
                }]
            })
        );
    }
}
```

In `src-tauri/src/lib.rs`, declare the module so the tests compile (Step 3 gives it a doc
comment):

```rust
// before (lib.rs:233-234)
pub mod transfer;
/// **The version, the release history and the clock they were read at — but never the swap.**

// after
pub mod transfer;
pub mod upcoming_sets;
/// **The version, the release history and the clock they were read at — but never the swap.**
```

In `src-tauri/src/web/route.rs`, inside `mod tests`, after `the_deck_review_count_is_routed`:

```rust
    /// **Coming soon's read, routed.** The fixture's printings carry no release date, so the
    /// first answer is empty; one printing ten days out is one set under `ipc.ts`' names. `days`
    /// is `field`, not `optional`: the widget always sends its window, and an absent one is a
    /// caller bug to be told about rather than a silent default.
    #[test]
    fn the_upcoming_sets_read_is_routed() {
        assert!(COMMANDS.contains(&"upcoming_sets"));
        let s = state("web-route-upcoming-sets");
        let out = call(&s, "upcoming_sets", &json!({ "days": 90 })).unwrap();
        assert_eq!(out["sets"], json!([]));
        assert_eq!(out["today"].as_str().map(str::len), Some(10), "YYYY-MM-DD");

        {
            let conn = crate::db::lock_blocking(&s.db);
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                    lang, layout, released_at, is_paper, raw)
                 VALUES ('soon', 'o-soon', 'Soon', 'tdm', 'Tarkir: Dragonstorm', '1', 'en',
                         'normal', date('now', '+10 days'), 1, '{}')",
                [],
            )
            .unwrap();
        }
        let out = call(&s, "upcoming_sets", &json!({ "days": 30 })).unwrap();
        assert_eq!(out["sets"][0]["code"], json!("tdm"));
        assert_eq!(out["sets"][0]["name"], json!("Tarkir: Dragonstorm"));
        assert_eq!(out["sets"][0]["previewed"], json!(1));
        assert_eq!(out["sets"][0]["inDecks"], json!(0));
        assert!(out["sets"][0]["releasedAt"].as_str().is_some());

        assert!(matches!(
            call(&s, "upcoming_sets", &json!({})),
            Err(RouteError::Args { .. })
        ));
    }
```

- [ ] **Step 2: Run it to see it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- upcoming_sets
```

Expected: compile error in `src/upcoming_sets.rs` — `cannot find function `upcoming_sets_for``,
`cannot find struct ... `UpcomingSets``/``UpcomingSet``, `cannot find type `Connection``,
`cannot find macro `params``. (`running 0 tests` means the `pub mod upcoming_sets;` line is
missing.)

- [ ] **Step 3: Implement**

3a. `src-tauri/src/new_printings.rs` — visibility only:

```rust
// before (new_printings.rs:93)
const BASIC_LAND_LIKE: &str = "Basic %Land%";
// after
pub(crate) const BASIC_LAND_LIKE: &str = "Basic %Land%";
```

3b. `src-tauri/src/upcoming_sets.rs` — put this **above** the `#[cfg(test)] mod tests` from Step 1:

```rust
//! The home page's **Coming soon** read — sets with printings announced for the next N days.
//!
//! **Over `cards`, not `sets`**, because the browser build never fills `sets` (`insert_sets` is
//! desktop-only, `sync.rs:587`) while every card row carries its own `set_code`, `set_name` and
//! `released_at`. `sets` is `LEFT JOIN`ed for the one thing only it knows — a `set_type` — and
//! where it has no row the layout filter is the whole rule.
//!
//! * **Which cards**: paper, released after today and on or before today + N, N clamped into
//!   `1..=365`; `search.rs`' `NON_CARD_LAYOUTS` (tokens, emblems, art series, front cards) left out. "Today" is
//!   SQLite's UTC `date('now')`, read once and bound into the window, so [`UpcomingSets::today`]
//!   is exactly the date the window was measured from.
//! * **Which sets**: where `sets` has a row, `set_type` `token`, `promo`, `memorabilia` and
//!   `minigame` drop out; a row with no type is kept.
//! * **`in_decks`** is `new_printings`' defaults: decks that are not virtual, live and theory rows
//!   alike, basic lands left out through [`crate::new_printings::BASIC_LAND_LIKE`].
//!
//! Connection in, DTO out, and no clock but SQLite's — so it answers in a browser as on the
//! desktop.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The longest window the read answers, in days — the widget offers 30, 90 and 365, and a
/// hand-edited `config` cannot ask for more.
const MAX_DAYS: i64 = 365;

/// Layouts that are not a card anyone plays — `search.rs`' list, shared rather than copied, so
/// a layout Scryfall adds is left out of the search's ranking and this count by one edit.
/// (Controller's ruling on the draft's contract problem 5: this carries `front_card` too.)
// search.rs:562 — change `const NON_CARD_LAYOUTS` to `pub(crate) const NON_CARD_LAYOUTS` there.
use crate::search::NON_CARD_LAYOUTS;

/// `sets.set_type`s that are not a release a reader waits for, as an SQL list.
const NON_RELEASE_SET_TYPES: &str = "('token','promo','memorabilia','minigame')";

/// The read: the date it was measured from, and the sets.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingSets {
    /// SQLite's `date('now')`, `YYYY-MM-DD`, UTC — what the widget counts days from.
    pub today: String,
    /// Soonest first, then by code.
    pub sets: Vec<UpcomingSet>,
}

/// One set with printings inside the window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingSet {
    pub code: String,
    /// `cards.set_name`, or the code where no card in the window carries one.
    pub name: String,
    /// The set's earliest card date in the window, `YYYY-MM-DD`.
    pub released_at: String,
    /// `count(DISTINCT collector_number)` — a second language of one card is not a second card.
    pub previewed: i64,
    /// Distinct oracle cards in the window that a deck which is not virtual already holds,
    /// basic lands left out.
    pub in_decks: i64,
}

/// The sets announced for the next `days` days, clamped into `1..=MAX_DAYS`.
pub fn upcoming_sets_for(conn: &Connection, days: i64) -> Result<UpcomingSets, String> {
    let days = days.clamp(1, MAX_DAYS);
    let today: String = conn
        .query_row("SELECT date('now')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let window = format!("+{days} days");
    // `held` is `new_printings`' held CTE (new_printings.rs:316-324) with its defaults fixed:
    // every deck that is not virtual, both lists, basics out. `count(DISTINCT h.oracle_id)` is the
    // held cards among the window's — `held` is distinct, so the join never multiplies a row.
    let sql = format!(
        "WITH upcoming AS (
             SELECT c.set_code AS set_code, c.set_name AS set_name,
                    c.collector_number AS collector_number, c.released_at AS released_at,
                    c.oracle_id AS oracle_id
               FROM cards c
               LEFT JOIN sets s ON s.code = c.set_code
              WHERE c.is_paper = 1
                AND c.released_at > ?1
                AND c.released_at <= date(?1, ?2)
                AND c.layout NOT IN {NON_CARD_LAYOUTS}
                AND coalesce(s.set_type, '') NOT IN {NON_RELEASE_SET_TYPES}
         ),
         held AS (
             SELECT DISTINCT c.oracle_id AS oracle_id
               FROM deck_cards dc
               JOIN decks d ON d.id = dc.deck_id
               JOIN cards c ON c.id = dc.card_id
              WHERE d.virtual_only = 0
                AND c.oracle_id IS NOT NULL AND c.oracle_id <> ''
                AND coalesce(c.type_line, '') NOT LIKE ?3
         )
         SELECT u.set_code,
                coalesce(max(u.set_name), u.set_code),
                min(u.released_at),
                count(DISTINCT u.collector_number),
                count(DISTINCT h.oracle_id)
           FROM upcoming u
           LEFT JOIN held h ON h.oracle_id = u.oracle_id
          GROUP BY u.set_code
          ORDER BY min(u.released_at) ASC, u.set_code ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![today, window, crate::new_printings::BASIC_LAND_LIKE],
            |r| {
                Ok(UpcomingSet {
                    code: r.get(0)?,
                    name: r.get(1)?,
                    released_at: r.get(2)?,
                    previewed: r.get(3)?,
                    in_decks: r.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let sets = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(UpcomingSets { today, sets })
}

/// Coming soon's read. **Read-only** connection, blocking pool. `days` is narrowed here as well as
/// in TypeScript, because it arrives from a `config` a reader can hand-edit.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn upcoming_sets(
    state: tauri::State<'_, Arc<AppState>>,
    days: i64,
) -> Result<UpcomingSets, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        upcoming_sets_for(&crate::sync::lock_db_read(&state), days)
    })
    .await
    .map_err(|e| format!("the upcoming sets could not be read: {e}"))?
}
```

3c. `src-tauri/src/lib.rs`:

```rust
// before
pub mod transfer;
pub mod upcoming_sets;

// after
pub mod transfer;
/// **The home page's Coming soon read** — sets with printings announced for the next N days,
/// read off `cards` rather than `sets` because the browser build never fills `sets`. One
/// `SELECT` whose only clock is SQLite's `date('now')`, so it answers on every target.
pub mod upcoming_sets;
```

3d. `src-tauri/src/desktop.rs` — the import list gains `upcoming_sets` before `update`
(`cargo fmt` rewraps):

```rust
// before
    set_completion, share, startup, startview, sticky_notes, sync, sync_engine, sync_pair, tags,
    update, wishlist, wishlist_folders, wishlist_optimize, zoom,

// after
    set_completion, share, startup, startview, sticky_notes, sync, sync_engine, sync_pair, tags,
    upcoming_sets, update, wishlist, wishlist_folders, wishlist_optimize, zoom,
```

and the handler list:

```rust
// before
            deck_completion::deck_review_count,
            startview::start_view,

// after
            deck_completion::deck_review_count,
            // The Coming soon widget: one `SELECT` over `cards` on the read-only connection, its
            // only clock SQLite's `date('now')`.
            upcoming_sets::upcoming_sets,
            startview::start_view,
```

3e. `src-tauri/src/web/route.rs` — `COMMANDS`:

```rust
// before
    "deck_review_count",
    "start_view",

// after
    "deck_review_count",
    // **The Coming soon widget's read.** Over `cards` rather than `sets`, which this target never
    // fills, and clocked by SQLite's `date('now')` — so it answers here as on the desktop.
    "upcoming_sets",
    "start_view",
```

the match arm, directly after the `"deck_review_count"` arm:

```rust
        // `days` is `field`: the widget always sends its window, and the module clamps it.
        "upcoming_sets" => {
            let days: i64 = field(command, args, "days")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::upcoming_sets::upcoming_sets_for(&conn, days).map_err(RouteError::Failed)?,
            )
        }
```

and the count (confirm with the same `awk`; 184 unless `main` has moved):

```rust
// before
        // **183 since the home widgets' second round routed `deck_completion` and
        // `deck_review_count`**, counted with the same `awk`. If a later merge turns this red,
        // take the number from `left`.
        assert_eq!(
            COMMANDS.len(),
            183,

// after
        // **184 since the home widgets' second round routed `deck_completion`,
        // `deck_review_count` and `upcoming_sets`**, counted with the same `awk`. If a later merge
        // turns this red, take the number from `left`.
        assert_eq!(
            COMMANDS.len(),
            184,
```

- [ ] **Step 4: Run to see it pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- upcoming_sets new_printings deck_completion deck_review_count every_advertised_command_is_actually_routed
```

Expected: every selected test passes — the seven `upcoming_sets::tests`,
`web::route::tests::the_upcoming_sets_read_is_routed`, the `new_printings` suite (the constant's
visibility is the only change there), and R1/R2's six.

- [ ] **Step 5: cargo fmt and clippy on the crate**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
$env:PATH = "C:\Program Files\LLVM\bin;$env:PATH"; cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked --target wasm32-unknown-unknown -- -D warnings
```

All three clean; re-run Step 4 if `cargo fmt` changed a file.

---


## Wave 1b — the shared TypeScript lane (Tasks 4 and 5 run beside the Rust lane; Task 6 after Task 3)

## Lane: the shared TypeScript foundation

F1 and F2 run in Wave 1 beside the Rust lane (R1 → R2 → R3) and touch disjoint files, so they can
run in parallel with each other too. F3 runs in Wave 2, **after R3**, because its `ipc.test.ts`
reads `src-tauri/src/deck_completion.rs` and `src-tauri/src/upcoming_sets.rs` as text and checks
the command names the Rust lane actually wrote.

Every implementer in this lane: targeted test runs only, no `git add`/`git commit`, no
`npm run verify`. Line numbers below were read on `cf98e4b5`; match on the quoted text, not on the
number.

---

### Task 4 (F1): The three one-shot hand-offs and the pages that answer them

**Files:**
- Modify: `src/lib/store.ts` — `AppState` (after `clearPendingSearchSet`, ~826), the
  `PendingFolder` interface (~1094-1106, a sibling type goes after it), `setActiveView`'s clear block
  (~1321-1324), the initial state (~1627-1637)
- Test: `src/lib/store.test.ts` — import line 4, new `describe` after "the set Search was asked to
  show" (~287-311)
- Create: `src/features/wishlist/wholeWishlistQuery.ts`
- Create: `src/features/wishlist/wholeWishlistQuery.test.ts`
- Modify: `src/features/collection/CollectionPage.tsx` — after the `pendingFolder` block (~738-751)
- Test: `src/features/collection/CollectionPage.test.tsx` — top-level `beforeEach` (~832-866), new
  `describe` at the end of the file
- Modify: `src/features/wishlist/WishlistPage.tsx` — imports (~65-69), after the `pendingFolder`
  block (~360-373), the sweep (~388-402), the Optimise button (~1571-1574), the dialog's `scope`
  (~2139-2143)
- Test: `src/features/wishlist/WishlistPage.test.tsx` — top-level `beforeEach` (~564-581), two new
  `describe`s at the end of the file
- Modify: `src/features/settings/SettingsPage.tsx` — imports (~2, ~17, ~23), a narrowing helper
  above `SettingsPage`, the render-phase block after `useState<GroupId>("updates")` (~121-122)
- Test: `src/features/settings/SettingsPage.test.tsx` — one import, new `describe` at the end

**Interfaces:**
- Consumes: `useCollection().needsReview` / `.setNeedsReview` (`useCollection.ts:207, 538, 544`);
  `useWishlist().needsReview` / `.setNeedsReview` / `.marketplace` (`useWishlist.ts:161, 389, 396,
  519`); `useWishlistOptimize(query: OptimizeQuery, open: boolean)` and
  `optimizePlanKey(query: OptimizeQuery)` (`useWishlistOptimize.ts:20, 40, 61`);
  `GROUP_ORDER: GroupId[]` (`features/settings/nav.ts:280`); `MarketplaceId`
  (`src/lib/marketplace.ts:30`).
- Produces (store, exactly the contract's shape):
  ```ts
  export interface PendingReviewFilter { scope: "collection" | "wishlist" }
  pendingReviewFilter: PendingReviewFilter | null;
  setPendingReviewFilter: (filter: PendingReviewFilter) => void;
  clearPendingReviewFilter: () => void;
  pendingSettingsGroup: string | null;
  setPendingSettingsGroup: (group: string) => void;
  clearPendingSettingsGroup: () => void;
  pendingOptimize: boolean;
  setPendingOptimize: () => void;   // sets true
  clearPendingOptimize: () => void;
  ```
- Produces (`src/features/wishlist/wholeWishlistQuery.ts`):
  ```ts
  export function wholeWishlistQuery(marketplace: MarketplaceId): OptimizeQuery; // { flatten: true, marketplace }
  ```
- Call-site rule for the widget lane: `setActiveView(view)` **first**, the hand-off **second**.

- [ ] **Step 1: Write the failing tests**

`src/lib/store.test.ts` — replace line 4:

```ts
import { useAppStore, type PaneDeckContext } from "@/lib/store";
```

with:

```ts
import { useAppStore, type PaneDeckContext, type ViewId } from "@/lib/store";
```

Then insert this block directly after the `describe("the set Search was asked to show", …)` block
(which ends `expect(useAppStore.getState().pendingSearchSet).toBeNull();\n  });\n});`) and before the
`/**\n * Which deck row the open card came from` comment:

```ts
/**
 * **The home page's three other one-shot hand-offs** (2026-09-26) — To review's needs-review filter
 * and its Settings group, and Wishlist savings' whole-list price sweep.
 *
 * Each is `pendingFolder`'s shape, so each is pinned the way that one is: spent by a view change
 * read or not, survived when the view is written first, and **wiped** when it is written second —
 * the order that type-checks, reads correctly and leaves the store holding nothing.
 */
describe("the home page's three other hand-offs", () => {
  interface Handoff {
    name: string;
    /** The view the press that writes it navigates to. */
    view: ViewId;
    write: () => void;
    read: () => unknown;
    written: unknown;
    spent: unknown;
  }

  const HANDOFFS: readonly Handoff[] = [
    {
      name: "pendingReviewFilter",
      view: "wishlist",
      write: () => useAppStore.getState().setPendingReviewFilter({ scope: "wishlist" }),
      read: () => useAppStore.getState().pendingReviewFilter,
      written: { scope: "wishlist" },
      spent: null,
    },
    {
      name: "pendingSettingsGroup",
      view: "settings",
      write: () => useAppStore.getState().setPendingSettingsGroup("sync"),
      read: () => useAppStore.getState().pendingSettingsGroup,
      written: "sync",
      spent: null,
    },
    {
      name: "pendingOptimize",
      view: "wishlist",
      write: () => useAppStore.getState().setPendingOptimize(),
      read: () => useAppStore.getState().pendingOptimize,
      written: true,
      spent: false,
    },
  ];

  /** Nobody has pressed anything, so no page is being sent anywhere. */
  it.each(HANDOFFS)("$name starts spent", ({ read, spent }) => {
    expect(read()).toEqual(spent);
  });

  /** Three fields, three clears — a page spending its own hand-off must not spend another's. */
  it("spends each through its own clear and leaves the other two standing", () => {
    for (const handoff of HANDOFFS) handoff.write();

    useAppStore.getState().clearPendingReviewFilter();
    expect(useAppStore.getState().pendingReviewFilter).toBeNull();
    expect(useAppStore.getState().pendingSettingsGroup).toBe("sync");
    expect(useAppStore.getState().pendingOptimize).toBe(true);

    useAppStore.getState().clearPendingSettingsGroup();
    expect(useAppStore.getState().pendingSettingsGroup).toBeNull();
    expect(useAppStore.getState().pendingOptimize).toBe(true);

    useAppStore.getState().clearPendingOptimize();
    expect(useAppStore.getState().pendingOptimize).toBe(false);
  });

  /** A hand-off nobody read does not outlive the navigation it was made for. */
  it.each(HANDOFFS)("$name is spent by a view change, read or not", ({ write, read, spent }) => {
    write();

    useAppStore.getState().setActiveView("decks");

    expect(read()).toEqual(spent);
  });

  /** The view first, the hand-off second — the order every call site in the widgets uses. */
  it.each(HANDOFFS)(
    "$name survives the view change that carries it, when the view is written first",
    ({ view, write, read, written }) => {
      useAppStore.getState().setActiveView(view);
      write();

      expect(useAppStore.getState().activeView).toBe(view);
      expect(read()).toEqual(written);
    },
  );

  /**
   * **The inverse is the whole reason this case exists**: it type-checks, reads correctly, and
   * lands the reader on the right page with nothing asked of it — no error anywhere.
   */
  it.each(HANDOFFS)(
    "$name is wiped when it is written before the view change",
    ({ view, write, read, spent }) => {
      write();
      useAppStore.getState().setActiveView(view);

      expect(read()).toEqual(spent);
    },
  );
});
```

Create `src/features/wishlist/wholeWishlistQuery.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { optimizePlanKey } from "./useWishlistOptimize";
import { wholeWishlistQuery } from "./wholeWishlistQuery";

describe("wholeWishlistQuery", () => {
  /** Every wish, wherever it is filed, with no filter on — and the marketplace that prices it. */
  it("asks about the whole list, flattened, at the marketplace it is handed", () => {
    expect(wholeWishlistQuery("cardkingdom")).toEqual({ flatten: true, marketplace: "cardkingdom" });
  });

  /**
   * **No paging, no order, no folder and no filter.** `useWishlistOptimize` adds `limit`/`offset`
   * itself and the command ignores both; a `sort` cannot change a plan; and any key present here
   * is a segment of the cache key the widget and the page share.
   */
  it("carries nothing but the two fields the question is made of", () => {
    expect(Object.keys(wholeWishlistQuery("tcgplayer")).sort()).toEqual(["flatten", "marketplace"]);
  });

  /**
   * **The widget's read and the hand-off's dialog are one cache entry.** `optimizePlanKey` puts the
   * object in the key and TanStack hashes it by value, so two builds of the same question are one
   * key — and a marketplace switch is a different one.
   */
  it("files two builds of one question under one plan key, and a second marketplace under another", () => {
    expect(optimizePlanKey(wholeWishlistQuery("manapool"))).toEqual(
      optimizePlanKey(wholeWishlistQuery("manapool")),
    );
    expect(optimizePlanKey(wholeWishlistQuery("manapool"))).not.toEqual(
      optimizePlanKey(wholeWishlistQuery("tcgplayer")),
    );
  });
});
```

`src/features/collection/CollectionPage.test.tsx` — in the top-level `beforeEach`, replace:

```tsx
    // hand-off writes one in every case.
    pendingFolder: null,
  });
});

describe("CollectionPage", () => {
```

with:

```tsx
    // hand-off writes one in every case.
    pendingFolder: null,
    // **The needs-review hand-off, for the folder's reason one line up** — this page consumes it,
    // and a case that left one written would open the next case on the flagged rows.
    pendingReviewFilter: null,
  });
});

describe("CollectionPage", () => {
```

and append at the very end of the file:

```tsx
/**
 * **The flagged rows another page asked this one to open on** — `store.ts`'s
 * `pendingReviewFilter`, whose only writer is the home page's To review widget.
 *
 * `pendingFolder`'s block above, one filter over: read as the page renders, spent as it is read,
 * and remembered by nothing. Each case asserts the *query* and the *field*, because three of the
 * four ways this could be wrong draw a page that looks fine.
 */
describe("a needs-review filter another page asked for", () => {
  /**
   * **Every request, not the last one.** A render-phase adjustment puts the filter on before the
   * first commit, so no unfiltered list is ever asked for; a mount effect would fetch the whole
   * binder first and then the flagged rows, which a `lastQuery()` assertion cannot tell apart.
   */
  it("asks for the flagged rows from its first request, and spends the hand-off", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    wrap(<CollectionPage />);

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(
      collectionList.mock.calls.every(([q]) => (q as CollectionQuery).needsReview === true),
    ).toBe(true);
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /** A hand-off that survived its read would open every later visit on the flagged rows. */
  it("does not survive to a second visit", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    const first = wrap(<CollectionPage />);
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());

    first.unmount();
    collectionList.mockClear();
    wrap(<CollectionPage />);

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().needsReview).toBeUndefined();
  });

  /** One field serves both lists, so the check is "is there one for me". */
  it("leaves the wishlist's hand-off untouched", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    wrap(<CollectionPage />);

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().needsReview).toBeUndefined();
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "wishlist" });
  });
});
```

`src/features/wishlist/WishlistPage.test.tsx` — in the top-level `beforeEach`, replace:

```tsx
    // case.
    pendingFolder: null,
  });
});

describe("WishlistPage", () => {
```

with:

```tsx
    // case.
    pendingFolder: null,
    // **The two other hand-offs this page consumes**, for the folder's reason: a case that left
    // either written would open the next case on the flagged wishes or inside the price sweep.
    pendingReviewFilter: null,
    pendingOptimize: false,
  });
});

describe("WishlistPage", () => {
```

and append at the very end of the file:

```tsx
/**
 * **The flagged wishes another page asked this one to open on** — `store.ts`'s
 * `pendingReviewFilter`, the To review widget's `Wishes` row. `CollectionPage.test.tsx`'s block
 * of the same name is the argument; this is the other cabinet.
 */
describe("a needs-review filter another page asked for", () => {
  it("asks for the flagged wishes from its first request, and spends the hand-off", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    wrap(<WishlistPage />);

    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(
      wishlistList.mock.calls.every(([q]) => (q as WishlistQuery).needsReview === true),
    ).toBe(true);
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  it("leaves the collection's hand-off untouched", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    wrap(<WishlistPage />);

    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().needsReview).toBeUndefined();
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "collection" });
  });
});

/**
 * **The price sweep another page asked for** — `store.ts`'s `pendingOptimize`, the home page's
 * Wishlist savings widget. The widget counted what *every* pinned wish would save, so the dialog it
 * opens has to plan the same list — and must not get there by writing the reader's own switches.
 */
describe("a price sweep another page asked for", () => {
  it("opens the dialog over every wish, flattened and unfiltered, and spends the hand-off", async () => {
    useAppStore.setState({ pendingOptimize: true });
    wrap(<WishlistPage />);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(wishlistOptimizePlan).toHaveBeenCalled());
    const asked = wishlistOptimizePlan.mock.calls[
      wishlistOptimizePlan.mock.calls.length - 1
    ][0] as WishlistQuery;
    // `wholeWishlistQuery` plus the paging `useWishlistOptimize` adds and the command ignores —
    // no folder, no filter, and flattened whatever the page's own switch says.
    expect(asked).toEqual({ flatten: true, marketplace: "tcgplayer", limit: 0, offset: 0 });
    // The scope sentence says so, rather than naming the root the page is standing at.
    expect(within(dialog).getByText("Every folder")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().pendingOptimize).toBe(false));
    // **A scope override and never a write**: the reader's persisted switch is as it was, and the
    // list behind the dialog is still the unflattened root.
    expect(useAppStore.getState().wishlistFlattened).toBe(false);
    expect(lastQuery().flatten).toBeUndefined();
  });

  /** The override is the hand-off's alone: the page's own button plans the page's own list. */
  it("plans the page's own list again when the Optimise button is pressed afterwards", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ pendingOptimize: true });
    wrap(<WishlistPage />);
    await screen.findByRole("dialog");
    await waitFor(() => expect(useAppStore.getState().pendingOptimize).toBe(false));

    await user.click(screen.getByRole("button", { name: "Close the price check" }));
    wishlistOptimizePlan.mockClear();
    // Straight to the button: a closing panel is still in the tree for the length of its fade.
    await user.click(screen.getByRole("button", { name: "Optimise wishlist prices" }));

    await waitFor(() => expect(wishlistOptimizePlan).toHaveBeenCalled());
    const asked = wishlistOptimizePlan.mock.calls[0][0] as WishlistQuery;
    expect(asked.flatten).toBeUndefined();
    expect(asked).toMatchObject({ marketplace: "tcgplayer", limit: 0, offset: 0 });
  });
});
```

`src/features/settings/SettingsPage.test.tsx` — add after `import type { Update } from "@/lib/useUpdate";`:

```tsx
import { useAppStore } from "@/lib/store";
```

and append at the very end of the file:

```tsx
/**
 * **The group another page asked this one to open on** — `store.ts`'s `pendingSettingsGroup`, the
 * To review widget's `Deck cards` row, which sends the reader to the Needs review panel under
 * `Sync`.
 *
 * The store is a module singleton this file does not otherwise reset, so every case here puts the
 * field back — a hand-off left written would open every later case on that group.
 */
describe("a group another page asked for", () => {
  afterEach(() => {
    useAppStore.setState({ pendingSettingsGroup: null });
  });

  /** Drawn on the first commit: a render-phase adjustment, so there is no frame of `Updates`. */
  it("opens on the group it names, and spends the hand-off doing it", async () => {
    useAppStore.setState({ pendingSettingsGroup: "sync" });
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByRole("region", { name: "Needs review" })).toBeInTheDocument();
    expect(screen.queryByText("panel:update")).not.toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().pendingSettingsGroup).toBeNull());
  });

  /**
   * **A word this rail has no group for is dropped, and still spent.** The store holds a plain
   * string so it needs nothing from this feature; the narrowing is the page's, and a prototype key
   * is not a group either.
   */
  it.each(["review", "constructor"])(
    "drops %s, opens on Updates, and spends the hand-off anyway",
    async (word) => {
      useAppStore.setState({ pendingSettingsGroup: word });
      render(wrap(<SettingsPage update={NO_UPDATE} />));

      expect(screen.getByText("panel:update")).toBeInTheDocument();
      await waitFor(() => expect(useAppStore.getState().pendingSettingsGroup).toBeNull());
    },
  );

  it("does not survive to a second visit", async () => {
    useAppStore.setState({ pendingSettingsGroup: "storage" });
    const first = render(wrap(<SettingsPage update={NO_UPDATE} />));
    expect(screen.getByText("panel:backup")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().pendingSettingsGroup).toBeNull());

    first.unmount();
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
    expect(screen.queryByText("panel:backup")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run, one file at a time:
- `npx vitest run src/lib/store.test.ts` — expected: the new block fails with
  `TypeError: useAppStore.getState(...).setPendingReviewFilter is not a function` (and the
  `starts spent` rows with `expected undefined to deeply equal null` / `… false`).
- `npx vitest run src/features/wishlist/wholeWishlistQuery.test.ts` — expected: fails to resolve
  `./wholeWishlistQuery`.
- `npx vitest run src/features/collection/CollectionPage.test.tsx -t "needs-review filter another page"`
  — expected: `needsReview` is `undefined` on the first request and the field is never cleared.
- `npx vitest run src/features/wishlist/WishlistPage.test.tsx -t "another page asked for"` —
  expected: no `dialog` found for the sweep cases, `needsReview` undefined for the filter cases.
- `npx vitest run src/features/settings/SettingsPage.test.tsx -t "a group another page asked for"`
  — expected: no region named `Needs review`; `panel:update` found where Sync was asked for.

- [ ] **Step 3: Implement**

`src/lib/store.ts`, **the `AppState` interface** — replace:

```ts
  /** Spend it — `SearchPage`, on the commit it applied it. */
  clearPendingSearchSet: () => void;
  /**
   * The card a reader asked to see every printing of, and the deck slot they asked from.
```

with:

```ts
  /** Spend it — `SearchPage`, on the commit it applied it. */
  clearPendingSearchSet: () => void;
  /**
   * **The needs-review filter a press somewhere else asked a list to open with** — the home page's
   * To review widget, and {@link pendingFolder}'s one-shot shape aimed at a filter rather than a
   * drawer. `CollectionPage` or `WishlistPage`, whichever `scope` names, turns its own
   * `needsReview` state on as it renders and spends this; the other page leaves it alone.
   *
   * **A scope and nothing more**, because the filter has one state worth being sent to: the
   * flagged rows. Cleared by {@link setActiveView} for `pendingFolder`'s reason, which makes the
   * same demand of the press: **the view first, this second**.
   */
  pendingReviewFilter: PendingReviewFilter | null;
  /** Ask a list to open on its flagged rows. **Call {@link setActiveView} before this, never
   *  after** — see {@link pendingFolder} for what the other order costs. */
  setPendingReviewFilter: (filter: PendingReviewFilter) => void;
  /** Spend it — the page its `scope` names, on the commit it read it. */
  clearPendingReviewFilter: () => void;
  /**
   * **The Settings rail group a press somewhere else asked that page to open on** — To review's
   * `Deck cards` row, which sends the reader to `sync` because that is the group holding the Needs
   * review panel.
   *
   * **A plain string and not `GroupId`**, so this module imports nothing from `features/settings`:
   * `SettingsPage` narrows it against its own rail and **drops** a word it has no group for, which
   * a newer build's word or a renamed group would otherwise turn into a refusal nobody can see.
   * Cleared by {@link setActiveView}; written after it.
   */
  pendingSettingsGroup: string | null;
  /** Ask Settings to open on a group. **Call {@link setActiveView} before this, never after.** */
  setPendingSettingsGroup: (group: string) => void;
  /** Spend it — `SettingsPage`, on the commit it read it. */
  clearPendingSettingsGroup: () => void;
  /**
   * **Whether a press somewhere else asked the Wishlist to open its price sweep over the whole
   * list** — the home page's Wishlist savings widget, which counted what every pinned wish would
   * save and has to open a dialog planning the same wishes.
   *
   * `WishlistPage` answers it with a **scope override** on the dialog — every wish, flattened, no
   * filters — and never by writing `wishlistFlattened` or a filter: those are the reader's, and
   * closing the dialog leaves the page exactly as they left it. A boolean because there is nothing
   * else to say; the widget only ever asks about the whole list. Cleared by {@link setActiveView};
   * written after it.
   */
  pendingOptimize: boolean;
  /** Ask the Wishlist to open the sweep over everything. **Call {@link setActiveView} before
   *  this, never after.** */
  setPendingOptimize: () => void;
  /** Spend it — `WishlistPage`, on the commit it opened the dialog. */
  clearPendingOptimize: () => void;
  /**
   * The card a reader asked to see every printing of, and the deck slot they asked from.
```

**The sibling type** — replace:

```ts
  id: number;
}

/**
 * The question the printings modal is open on — see {@link AppState.printingsRequest}, which is
```

with:

```ts
  id: number;
}

/**
 * Which list a needs-review hand-off is for — see {@link AppState.pendingReviewFilter}, the only
 * field of this shape. The two scopes are spelled out here for {@link PendingFolder}'s reason: they
 * agree with it today because the app has two lists that flag rows, and that is a coincidence
 * rather than one fact.
 */
export interface PendingReviewFilter {
  scope: "collection" | "wishlist";
}

/**
 * The question the printings modal is open on — see {@link AppState.printingsRequest}, which is
```

**`setActiveView`'s clear block** — replace:

```ts
        // The search hand-off, for the folder's reason on the line above. `showSetInSearch` writes
        // it *after* calling this, which is the order that survives.
        pendingSearchSet: null,
      };
    }),
```

with:

```ts
        // The search hand-off, for the folder's reason on the line above. `showSetInSearch` writes
        // it *after* calling this, which is the order that survives.
        pendingSearchSet: null,
        // The home page's three other hand-offs, for the folder's reason three lines up: each is
        // written after the view change that carries it, so this clears only one nobody read.
        pendingReviewFilter: null,
        pendingSettingsGroup: null,
        pendingOptimize: false,
      };
    }),
```

**The initial state** — replace:

```ts
  clearPendingSearchSet: () => set({ pendingSearchSet: null }),
  printingsRequest: null,
```

with:

```ts
  clearPendingSearchSet: () => set({ pendingSearchSet: null }),
  // Nothing pending until a home-page press names one, and never again after the page that
  // answered it has read it — `pendingFolder`'s arrangement three times over. Each setter writes
  // one field and has no opinion about the view, so the order its caller depends on stays
  // statable: `setActiveView` first, the hand-off second.
  pendingReviewFilter: null,
  setPendingReviewFilter: (pendingReviewFilter) => set({ pendingReviewFilter }),
  clearPendingReviewFilter: () => set({ pendingReviewFilter: null }),
  pendingSettingsGroup: null,
  setPendingSettingsGroup: (pendingSettingsGroup) => set({ pendingSettingsGroup }),
  clearPendingSettingsGroup: () => set({ pendingSettingsGroup: null }),
  pendingOptimize: false,
  setPendingOptimize: () => set({ pendingOptimize: true }),
  clearPendingOptimize: () => set({ pendingOptimize: false }),
  printingsRequest: null,
```

Create `src/features/wishlist/wholeWishlistQuery.ts`:

```ts
import type { MarketplaceId } from "@/lib/marketplace";

import type { OptimizeQuery } from "./useWishlistOptimize";

/**
 * The question the home page's **Wishlist savings** widget and the Wishlist page's
 * `pendingOptimize` hand-off both put to `wishlist_optimize_plan`: **every wish, wherever it is
 * filed, with no filter on** — `flatten: true`, and nothing else but the marketplace.
 *
 * **One builder rather than two literals, because the two must be one question.** The widget
 * counts what the sweep would save and a press on it opens the sweep's dialog, so a reader who
 * pressed a row saving `$18.40` has to meet a dialog planning the same wishes. Built through here
 * the two are also **one cache entry**: `optimizePlanKey` puts this object in the key and TanStack
 * hashes it by value, so the dialog opens on the widget's answer rather than asking again.
 *
 * **An `OptimizeQuery`, not a whole `WishlistQuery`.** `useWishlistOptimize` adds `limit: 0` and
 * `offset: 0` itself — the command ignores both, because a plan covers the whole query rather than
 * a page — and a `sort` cannot change a plan. Neither is part of the question, and carrying either
 * would put it in the key. `marketplace` is always sent because it decides every figure in the
 * answer, which `src/CLAUDE.md` requires of every priced query's key.
 */
export function wholeWishlistQuery(marketplace: MarketplaceId): OptimizeQuery {
  return { flatten: true, marketplace };
}
```

`src/features/collection/CollectionPage.tsx` — replace:

```tsx
  useEffect(() => {
    if (pendingHere !== null) clearPendingFolder();
  }, [pendingHere, clearPendingFolder]);

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
```

with:

```tsx
  useEffect(() => {
    if (pendingHere !== null) clearPendingFolder();
  }, [pendingHere, clearPendingFolder]);

  /**
   * **The flagged rows another surface asked this page to open on** — `store.ts`'s
   * `pendingReviewFilter`, whose only writer is the home page's To review widget.
   *
   * The folder hand-off's shape directly above, for its reasons: a **render-phase adjustment**
   * rather than a mount effect, so the first list this page asks for is already the flagged one
   * and no unfiltered page is fetched and thrown away — and a `setNeedsReview` inside an effect
   * body is the lint failure that dies only at `verify`. The effect below spends it whether or not
   * it changed anything, so it cannot fire on a later visit.
   *
   * **It sets the filter and nothing else.** Where the reader is standing and whether they read
   * the cabinet flat are theirs; `collectionFlattened` starts on, which is what puts a flagged row
   * filed in a drawer on screen. `!== true` rather than a falsy test for the banner's reason
   * further down: `false` is the chip's "not flagged" state, and a hand-off asking for the
   * flagged rows has to move off it.
   */
  const pendingReviewFilter = useAppStore((s) => s.pendingReviewFilter);
  const clearPendingReviewFilter = useAppStore((s) => s.clearPendingReviewFilter);
  const reviewHere = pendingReviewFilter?.scope === "collection";
  if (reviewHere && collection.needsReview !== true) {
    collection.setNeedsReview(true);
  }
  useEffect(() => {
    if (reviewHere) clearPendingReviewFilter();
  }, [reviewHere, clearPendingReviewFilter]);

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
```

`src/features/wishlist/WishlistPage.tsx` — **imports**: replace

```tsx
import { useWishlistOptimize } from "./useWishlistOptimize";
import type { WishDrop } from "./wishDrag";
```

with:

```tsx
import { useWishlistOptimize } from "./useWishlistOptimize";
import { wholeWishlistQuery } from "./wholeWishlistQuery";
import type { WishDrop } from "./wishDrag";
```

**The needs-review hand-off** — replace:

```tsx
  useEffect(() => {
    if (pendingHere !== null) clearPendingFolder();
  }, [pendingHere, clearPendingFolder]);

  /**
   * The export dialog, and the sweep that fills it — `CollectionPage`'s twin, for the same
```

with:

```tsx
  useEffect(() => {
    if (pendingHere !== null) clearPendingFolder();
  }, [pendingHere, clearPendingFolder]);

  /**
   * **The flagged wishes another surface asked this page to open on** — `store.ts`'s
   * `pendingReviewFilter`, To review's `Wishes` row. `CollectionPage`'s consume site is the
   * argument, one cabinet over: a render-phase adjustment so the first request is already
   * filtered, spent by the effect whether or not it changed anything, and read only when its
   * `scope` names this page.
   */
  const pendingReviewFilter = useAppStore((s) => s.pendingReviewFilter);
  const clearPendingReviewFilter = useAppStore((s) => s.clearPendingReviewFilter);
  const reviewHere = pendingReviewFilter?.scope === "wishlist";
  if (reviewHere && wishlist.needsReview !== true) {
    wishlist.setNeedsReview(true);
  }
  useEffect(() => {
    if (reviewHere) clearPendingReviewFilter();
  }, [reviewHere, clearPendingReviewFilter]);

  /**
   * The export dialog, and the sweep that fills it — `CollectionPage`'s twin, for the same
```

**The sweep and its override** — replace:

```tsx
   * marketplace all scope the sweep, and `considered` comes back equal to the `Wishes` figure in
   * the header above.
   */
  const [optimizing, setOptimizing] = useState(false);
  const optimize = useWishlistOptimize(wishlist.filters, optimizing);
```

with:

```tsx
   * marketplace all scope the sweep, and `considered` comes back equal to the `Wishes` figure in
   * the header above.
   */
  const [optimizing, setOptimizing] = useState(false);
  /**
   * **Which list the sweep is taken over** — the one on screen, or the whole wishlist.
   *
   * `"page"` is the Optimise button's, and it is `wishlist.filters` exactly as it always was.
   * `"whole"` is the home page's Wishlist savings widget, arriving through `store.ts`'s
   * `pendingOptimize`: the widget counted what *every* pinned wish would save, so the dialog it
   * opens plans {@link wholeWishlistQuery} — the widget's own question, and therefore its own cache
   * entry. **A scope override and never a write**: `wishlistFlattened` is the reader's persisted
   * switch and the filters are theirs, so the hand-off touches neither.
   *
   * **Left where it is when the dialog closes**, deliberately: the panel outlives the flag by the
   * length of its fade, and a scope put back on close would re-key the plan mid-fade and flash the
   * body to its loading sentence. The button writes `"page"` on its own press instead.
   */
  const [sweepOver, setSweepOver] = useState<"page" | "whole">("page");
  const optimize = useWishlistOptimize(
    sweepOver === "whole" ? wholeWishlistQuery(marketplace.id) : wishlist.filters,
    optimizing,
  );
  /**
   * **The sweep another page asked for** — `store.ts`'s `pendingOptimize`, read as this page
   * renders rather than in a mount effect, for the `pendingFolder` reasons above: the dialog is up
   * on the first commit, and `setOptimizing` inside an effect body is the lint failure that dies
   * only at `verify`. The guard is what makes the adjustment terminate — the hand-off stays in the
   * store until the effect below spends it.
   *
   * **No `apply.reset()` on the way in**, unlike the button's: `App.tsx` draws one view at a time,
   * so a hand-off always arrives on a freshly mounted page whose mutation has no receipt to clear.
   */
  const pendingOptimize = useAppStore((s) => s.pendingOptimize);
  const clearPendingOptimize = useAppStore((s) => s.clearPendingOptimize);
  if (pendingOptimize && !(optimizing && sweepOver === "whole")) {
    setSweepOver("whole");
    setOptimizing(true);
  }
  useEffect(() => {
    if (pendingOptimize) clearPendingOptimize();
  }, [pendingOptimize, clearPendingOptimize]);
```

**The Optimise button** — replace:

```tsx
              onClick={() => {
                optimize.apply.reset();
                setOptimizing(true);
              }}
```

with:

```tsx
              onClick={() => {
                optimize.apply.reset();
                // The page's own list, whatever a home-page hand-off last asked about.
                setSweepOver("page");
                setOptimizing(true);
              }}
```

**The dialog's scope** — replace:

```tsx
        scope={{
          folder: folderNameOf(folderId) ?? ROOT_LABEL,
          flatten,
          filtered: wishlist.activeCount > 0,
        }}
```

with:

```tsx
        scope={
          // The hand-off's override says what it planned — every folder, nothing filtered — rather
          // than naming the drawer and the filters the page happens to be standing in.
          sweepOver === "whole"
            ? { folder: ROOT_LABEL, flatten: true, filtered: false }
            : {
                folder: folderNameOf(folderId) ?? ROOT_LABEL,
                flatten,
                filtered: wishlist.activeCount > 0,
              }
        }
```

`src/features/settings/SettingsPage.tsx` — replace `import { useRef, useState } from "react";` with:

```tsx
import { useEffect, useRef, useState } from "react";
```

replace
`import { visiblePanels, type BadgeId, type GroupId, type PanelId } from "@/features/settings/nav";`
with:

```tsx
import {
  GROUP_ORDER,
  visiblePanels,
  type BadgeId,
  type GroupId,
  type PanelId,
} from "@/features/settings/nav";
```

replace `import { REVIEW_KEY } from "@/lib/query";` with:

```tsx
import { REVIEW_KEY } from "@/lib/query";
import { useAppStore } from "@/lib/store";
```

insert directly above the `/**\n * Settings.\n *\n * **A rail of seven entries and a pane` doc comment of `SettingsPage`:

```tsx
/**
 * A stored word as one of this rail's groups, or `null` for a word it has none for.
 *
 * `store.ts` keeps `pendingSettingsGroup` a plain `string` so it needs nothing from this feature,
 * and this is the other half of that bargain: the narrowing lives here, beside the rail. **An
 * `includes` over `GROUP_ORDER` and never `word in GROUPS`**, `isWidgetKind`'s reason — `in` walks
 * the prototype and would take `"constructor"` for a group.
 */
function asGroupId(word: string): GroupId | null {
  return (GROUP_ORDER as readonly string[]).includes(word) ? (word as GroupId) : null;
}

```

and replace:

```tsx
  const [group, setGroup] = useState<GroupId>("updates");
  const [query, setQuery] = useState("");
```

with:

```tsx
  const [group, setGroup] = useState<GroupId>("updates");
  const [query, setQuery] = useState("");
  /**
   * **The group another page asked this one to open on** — `store.ts`'s `pendingSettingsGroup`,
   * whose only writer is the home page's To review widget sending a reader to Needs review.
   *
   * `CollectionPage`'s `pendingFolder` arrangement: a render-phase adjustment rather than a mount
   * effect, so the pane draws the asked-for group on its first commit with no frame of `Updates`
   * and no `setState` in an effect body; and spent by the effect below whether or not it named a
   * group, so a word this rail has none for is **dropped** rather than left to fire on a later
   * visit. The query goes with it, `pickGroup`'s rule: a query outranks the group, so a group
   * arriving under one would be a press that visibly did nothing.
   */
  const pendingGroup = useAppStore((s) => s.pendingSettingsGroup);
  const clearPendingGroup = useAppStore((s) => s.clearPendingSettingsGroup);
  const askedGroup = pendingGroup === null ? null : asGroupId(pendingGroup);
  if (askedGroup !== null && group !== askedGroup) {
    setGroup(askedGroup);
    if (query !== "") setQuery("");
  }
  useEffect(() => {
    if (pendingGroup !== null) clearPendingGroup();
  }, [pendingGroup, clearPendingGroup]);
```

- [ ] **Step 4: Run them to see them pass**

Run, one file at a time:
- `npx vitest run src/lib/store.test.ts`
- `npx vitest run src/features/wishlist/wholeWishlistQuery.test.ts`
- `npx vitest run src/features/collection/CollectionPage.test.tsx`
- `npx vitest run src/features/wishlist/WishlistPage.test.tsx`
- `npx vitest run src/features/settings/SettingsPage.test.tsx`

Expected: all pass — including every pre-existing case in the three page files (the page scope is
`"page"` by default, so "takes the sweep over the same query the list is drawn from" is unchanged).

- [ ] **Step 5: Typecheck** (and lint the three pages, because a render-phase `setState` is exactly
  what the `react-hooks` rules police and `verify` is the only other place they run)

Run: `npx tsc --noEmit -p .`
Run: `npx eslint src/lib/store.ts src/features/collection/CollectionPage.tsx src/features/wishlist/WishlistPage.tsx src/features/wishlist/wholeWishlistQuery.ts src/features/settings/SettingsPage.tsx`
Expected: no errors from either.

---
- [ ] **Step 6 (controller ruling): a review hand-off shows the flagged rows wherever they are filed**

`collection_summary.needsReview` and the wishlist's review count are counted across **every
folder**, but both pages open at the root and their Flatten switch starts off
(`collectionFlattened` / `wishlistFlattened`, persisted in `app_meta.flatten_state`). Turning on
needs-review alone would therefore show a filtered **root** — often empty while To review says
"5 binder entries". So the `pendingReviewFilter` consumer on each page also sets a **local,
non-persisted** `reviewSweep` flag, and the page draws flattened while it is on:

- effective flatten = `stored || reviewSweep`; the Flatten button shows the effective state;
- pressing Flatten while `reviewSweep` is on clears `reviewSweep` and writes **nothing** to the
  store (the page falls back to the stored value); pressing it otherwise behaves as today;
- turning the needs-review filter off (its chip, or Reset all) clears `reviewSweep` too;
- the stored `collectionFlattened` / `wishlistFlattened` is **never** written by the hand-off —
  the same promise `pendingOptimize` makes;
- `reviewSweep` is `useState` on the page, so leaving the view drops it.

Tests, in each page's test file (write them first, watch them fail, then implement):
1. with the store's flatten off and a flagged entry filed in a folder, a `pendingReviewFilter`
   for that page renders the flagged entry, and the store's flatten field is still `false`;
2. pressing Flatten after the hand-off leaves the store's flatten field `false` and shows the
   root again;
3. clearing the needs-review filter after the hand-off shows the root again.

Run: `npx vitest run src/features/collection/CollectionPage.test.tsx` and
`npx vitest run src/features/wishlist/WishlistPage.test.tsx`, then Step 5's typecheck and lint.

---

### Task 5 (F2): The four registry rows, and Needs review refreshing the lists it clears

**Files:**
- Modify: `src/features/home/widgets.ts` — the `WidgetKind` doc and union (~34-52), four rows at the
  end of `WIDGET_META` (after `newPrintings`, ~357-409)
- Test: `src/features/home/widgets.test.ts` — imports (~5-15), `EVERY_KIND` (~25-37), the vocabulary
  pin (~161-224), two new cases after "carries the tenth kind…" (~235-262)
- Test: `src/features/home/widgetSettings.test.ts` — new `describe` at the end
- Modify: `src/features/settings/ReviewPanel.tsx` — imports (~1, ~4), `TABLE_ROOT` +
  `reviewRootOf` after `TABLE_ORDER` (~40), `clear`'s `onSuccess` (~158-170)
- Test: `src/features/settings/ReviewPanel.test.tsx` — imports, two new `describe`s at the end

**Interfaces:**
- Consumes: `WidgetPick`, `WidgetToggle.dflt`, `pickDefault`/`pickOf`/`toggleOnOf`/`chipLabel`
  (`widgetSettings.ts`); `DecksWidgetSettings` reads `deckScope(widget)` → `pickOf(widget, "scope")`
  and words its hint off **the `decks` row's** `scope` label and `pinned` option
  (`widgets/DecksWidget.tsx:143-148, 335-341`), so `deckCompletion`'s `scope` row must say the same
  two words; `REVIEW_KEY`, `RELAY_KEY` (`src/lib/query.ts:294, 220`); `ReviewTable`
  (`src/lib/ipc.ts:6402`).
- Produces:
  - `WidgetKind` gains `"deckCompletion" | "toReview" | "wishlistSavings" | "comingSoon"`, rows per
    spec §2.1 (footprints `def`/`min`/`max`; picks; toggles; chip). Config keys: deckCompletion
    `{ scope: "recent"|"pinned", deckIds, order: "done"|"cheapest"|"name", complete }` (`deckIds`
    is `DecksWidgetSettings`' own key, not a registry row); toReview `{ removed }`; comingSoon
    `{ window: 30|90|365 }`.
  - `export function reviewRootOf(table: string): QueryKey | null` in `ReviewPanel.tsx`.
  - `DEFAULT_LAYOUT` **unchanged**. The `HomePage.tsx` arms (`renderBody`, and `renderExtraSettings`
    for `deckCompletion` → `DecksWidgetSettings`) belong to the wiring task, not this one. Until it
    lands, the catalogue draws the four as unknown-widget placeholders; nothing asserts against
    that (checked: `HomePage.test.tsx` names `preview-priceMovers` and `preview-summary` only).

- [ ] **Step 1: Write the failing tests**

`src/features/home/widgets.test.ts` — replace the import block:

```ts
import {
  boundsOf,
  BREAKDOWN_DIMENSIONS,
  DEFAULT_LAYOUT,
  isWidgetKind,
  UNKNOWN_BOUNDS,
  widgetMeta,
  WIDGETS,
  type BreakdownDimension,
  type WidgetKind,
} from "./widgets";
```

with:

```ts
import {
  boundsOf,
  BREAKDOWN_DIMENSIONS,
  DEFAULT_LAYOUT,
  isWidgetKind,
  UNKNOWN_BOUNDS,
  widgetMeta,
  WIDGETS,
  type BreakdownDimension,
  type WidgetKind,
  type WidgetPick,
} from "./widgets";
```

Replace:

```ts
  newPrintings: true,
  stickyNotes: true,
};
```

with:

```ts
  newPrintings: true,
  stickyNotes: true,
  deckCompletion: true,
  toReview: true,
  wishlistSavings: true,
  comingSoon: true,
};
```

In "stores every setting under the key and words the widgets read", replace the pin's last entry
and its close:

```ts
        toggles: { virtual: false, theory: true, basics: false },
        chip: "window",
      },
    });
  });
```

with:

```ts
        toggles: { virtual: false, theory: true, basics: false },
        chip: "window",
      },
      // Round two (2026-09-26). `scope` is the `decks` row's two of three words — no `Archived
      // too`, because a deck put away is not one a reader is finishing — and `complete` is the
      // second switch in the registry that starts off: finished decks are counted in the footer
      // and listed only when asked for.
      deckCompletion: {
        picks: {
          scope: { ids: ["recent", "pinned"], dflt: undefined },
          order: { ids: ["done", "cheapest", "name"], dflt: undefined },
        },
        toggles: { complete: false },
        chip: "order",
      },
      // On by default: Recently removed is a holding area rather than a problem, and the switch
      // exists for the reader who uses it as an archive.
      toReview: { picks: {}, toggles: { removed: true }, chip: undefined },
      wishlistSavings: { picks: {}, toggles: {}, chip: undefined },
      // `newPrintings`' window, word for word and default for default, so a reader who set one
      // has learnt the other.
      comingSoon: {
        picks: { window: { ids: [30, 90, 365], dflt: 90 } },
        toggles: {},
        chip: "window",
      },
    });
  });
```

Insert directly after the "carries the tenth kind, off the catalogue and not the default layout"
case (it ends with `expect(pickDefault(meta.picks.find((pick) => pick.key === "langs")!)).toBe("en");\n  });`)
and before the `describe`'s closing `});`:

```ts

  /**
   * **Round two's four, off the catalogue and not the seed** — spec §2.1's footprints, which are
   * the design canvas's, and the default layout untouched: it fills an eight-by-seven rectangle
   * exactly, and a new kind in it would rearrange the page of every reader who never asked.
   */
  it("carries round two's four kinds at the canvas's footprints, off the default layout", () => {
    const kinds = ["deckCompletion", "toReview", "wishlistSavings", "comingSoon"] as const;
    const footprints = Object.fromEntries(
      kinds.map((kind) => {
        const { def, min, max } = widgetMeta(kind);
        return [kind, { def, min, max }];
      }),
    );

    expect(footprints).toEqual({
      deckCompletion: { def: [3, 3], min: [2, 2], max: [4, 6] },
      toReview: { def: [2, 3], min: [2, 2], max: [4, 4] },
      wishlistSavings: { def: [3, 3], min: [2, 2], max: [4, 6] },
      comingSoon: { def: [4, 2], min: [2, 2], max: [8, 4] },
    });
    for (const kind of kinds) {
      expect(DEFAULT_LAYOUT.widgets.some((widget) => widget.kind === kind), kind).toBe(false);
    }
    expect(DEFAULT_LAYOUT.widgets).toHaveLength(8);
    // The record's insertion order is the catalogue's, and these four are its newest.
    expect(WIDGETS.slice(-4).map((widget) => widget.kind)).toEqual([...kinds]);
  });

  /**
   * **`deckCompletion`'s `Pinned` checklist is `DecksWidgetSettings`, reused rather than copied**,
   * and that component words its hint off the *decks* row — `Choose Pinned under Which decks…`.
   * So this card's `scope` row has to say the same words, or the reused sentence names a control
   * this card does not have.
   */
  it("gives deck completion's scope row the decks widget's own words", () => {
    const labelOf = (pick: WidgetPick, id: string) =>
      pick.options.find((option) => option.id === id)?.label;
    const decks = widgetMeta("decks").picks.find((pick) => pick.key === "scope")!;
    const completion = widgetMeta("deckCompletion").picks.find((pick) => pick.key === "scope")!;

    expect(completion.label).toBe(decks.label);
    expect(labelOf(completion, "pinned")).toBe(labelOf(decks, "pinned"));
    expect(labelOf(completion, "recent")).toBe(labelOf(decks, "recent"));
  });
```

`src/features/home/widgetSettings.test.ts` — append at the end of the file:

```ts

/**
 * Round two's rows, read through the one set of readers every body and the settings panel use —
 * so a default here is the default the card draws, not a restatement of the registry.
 */
describe("round two's rows, through the settings readers", () => {
  it("defaults each pick to its registry answer", () => {
    expect(pickDefault(pickFor("deckCompletion", "scope"))).toBe("recent");
    expect(pickDefault(pickFor("deckCompletion", "order"))).toBe("done");
    // `dflt` names 90 while listing 30 first — `activity`'s shape, and `newPrintings`' number.
    expect(pickDefault(pickFor("comingSoon", "window"))).toBe(90);
    expect(pickValue(widget("comingSoon", { window: 45 }), pickFor("comingSoon", "window"))).toBe(90);
  });

  /** One switch that starts off and one that starts on, each read the right way round. */
  it("reads the two switches off their own rows", () => {
    expect(toggleOnOf(widget("deckCompletion"), "complete")).toBe(false);
    expect(toggleOnOf(widget("deckCompletion", { complete: true }), "complete")).toBe(true);
    expect(toggleOnOf(widget("toReview"), "removed")).toBe(true);
    expect(toggleOnOf(widget("toReview", { removed: false }), "removed")).toBe(false);
  });

  it("draws a chip for the two kinds that name one, and nothing for the two that do not", () => {
    expect(chipLabel(widget("deckCompletion"))).toBe("Nearest done");
    expect(chipLabel(widget("deckCompletion", { order: "cheapest" }))).toBe("Cheapest to finish");
    expect(chipLabel(widget("comingSoon"))).toBe("90 days");
    expect(chipLabel(widget("comingSoon", { window: 365 }))).toBe("A year");
    expect(chipLabel(widget("toReview"))).toBe("");
    expect(chipLabel(widget("wishlistSavings"))).toBe("");
  });

  it("names an unrenamed card by its kind", () => {
    expect(defaultTitle(widget("deckCompletion"))).toBe("Deck completion");
    expect(defaultTitle(widget("toReview"))).toBe("To review");
    expect(defaultTitle(widget("wishlistSavings"))).toBe("Wishlist savings");
    expect(defaultTitle(widget("comingSoon"))).toBe("Coming soon");
  });
});
```

`src/features/settings/ReviewPanel.test.tsx` — replace:

```tsx
import type { ReviewRow, ReviewTable } from "@/lib/ipc";
```

with:

```tsx
import type { ReviewRow, ReviewTable } from "@/lib/ipc";
import { RELAY_KEY, REVIEW_KEY } from "@/lib/query";
```

and replace:

```tsx
import { ReviewPanel, groupByTable } from "./ReviewPanel";
```

with:

```tsx
import { ReviewPanel, groupByTable, reviewRootOf } from "./ReviewPanel";
```

Append at the end of the file:

```tsx

/**
 * **Clearing a sentence refreshes the list the row belongs to** (spec §2.3). `sync_review_clear`
 * answers this panel's own list and nothing else, so without this a cleared row stayed counted —
 * on the collection's banner, the wishlist's chip, the deck editor and the home page's To review —
 * until something else happened to invalidate its root.
 */
describe("clearing a row refreshes the list it came from", () => {
  /** The panel under a client this test holds, so its invalidations can be read. */
  function mountWithClient() {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <ReviewPanel />
      </QueryClientProvider>,
    );
    return invalidate;
  }

  const WISH: ReviewRow = {
    table: "wishlist_entries",
    uid: "wishlist_entries:7",
    title: "Orcish Bowmasters",
    sentence: MISSING,
  };

  it.each([
    ["collection_entries", "Ragavan, Nimble Pilferer", ["collection"]],
    ["deck_cards", "Psychic Frog", ["decks"]],
    ["deck_folders", "Commander", ["decks"]],
    ["wishlist_entries", "Orcish Bowmasters", ["wishlist"]],
  ] as const)("invalidates the %s root when one of its rows is cleared", async (_table, title, root) => {
    syncReviewList.mockResolvedValue([...ROWS, WISH]);
    const user = userEvent.setup();
    const invalidate = mountWithClient();

    await user.click(await screen.findByRole("button", { name: `Looks fine, ${title}` }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [...root] }));
    // The Sync panel's figures still move, and this panel's own list is still not re-read — the
    // command answered what is left, which is the whole reason it answers a list.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: RELAY_KEY });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: REVIEW_KEY });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["sync"] });
  });

  /** A row from a table this build cannot name is still clearable, and refreshes nothing it
   *  cannot name either. */
  it("refreshes only the relay for a row from a table this build has no name for", async () => {
    const stray = {
      table: "muted_tags",
      uid: "muted_tags:1",
      title: "Ramp",
      sentence: "s",
    } as unknown as ReviewRow;
    syncReviewList.mockResolvedValue([stray]);
    const user = userEvent.setup();
    const invalidate = mountWithClient();

    await user.click(await screen.findByRole("button", { name: "Looks fine, Ramp" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: RELAY_KEY }));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("reviewRootOf", () => {
  /** All six tables `REVIEWABLE` names, each at the root its other writes already fire — a
   *  folder's cabinet is its entries'. */
  it("names a root for every table the backend can send a row from", () => {
    const roots: Record<ReviewTable, readonly string[]> = {
      collection_entries: ["collection"],
      deck_cards: ["decks"],
      wishlist_entries: ["wishlist"],
      collection_folders: ["collection"],
      deck_folders: ["decks"],
      wishlist_folders: ["wishlist"],
    };
    for (const [table, root] of Object.entries(roots)) {
      expect(reviewRootOf(table), table).toEqual(root);
    }
  });

  it("answers null for a stray table and for a prototype key", () => {
    for (const table of ["muted_tags", "", "constructor", "toString", "__proto__"]) {
      expect(reviewRootOf(table), table).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run:
- `npx vitest run src/features/home/widgets.test.ts` — expected: "carries exactly one meta for
  every widget kind" fails (the four kinds are missing from `WIDGETS`), the vocabulary pin fails,
  and the two new cases throw on `widgetMeta("deckCompletion")` being `{ kind, …undefined }`.
- `npx vitest run src/features/home/widgetSettings.test.ts` — expected: `pickFor` throws
  `deckCompletion has no scope pick`.
- `npx vitest run src/features/settings/ReviewPanel.test.tsx` — expected: `reviewRootOf is not a
  function`, and the invalidation cases time out waiting for the root.

- [ ] **Step 3: Implement**

`src/features/home/widgets.ts` — replace:

```ts
/**
 * The eleven kinds this build can draw.
 *
 * Adding a twelfth means a member here, a row in {@link WIDGET_META} (which will not compile
 * without one) and a component — and it means nothing at all to Rust, which stores whatever
 * string it is handed.
 */
export type WidgetKind =
  | "summary"
  | "decks"
  | "folders"
  | "collectionValue"
  | "wishlistValue"
  | "activity"
  | "recentCards"
  | "setCompletion"
  | "priceMovers"
  | "newPrintings"
  | "stickyNotes";
```

with:

```ts
/**
 * The kinds this build can draw.
 *
 * Adding one means a member here, a row in {@link WIDGET_META} (which will not compile without
 * one) and a component — and it means nothing at all to Rust, which stores whatever string it is
 * handed. **How many there are is `WIDGET_META`'s to answer and is not written down here**: this
 * comment said *eleven* while it was true and would have been wrong the day round two landed.
 */
export type WidgetKind =
  | "summary"
  | "decks"
  | "folders"
  | "collectionValue"
  | "wishlistValue"
  | "activity"
  | "recentCards"
  | "setCompletion"
  | "priceMovers"
  | "newPrintings"
  | "stickyNotes"
  | "deckCompletion"
  | "toReview"
  | "wishlistSavings"
  | "comingSoon";
```

and replace the end of `WIDGET_META`:

```ts
      { key: "basics", label: "Basic lands", dflt: false },
    ],
    chip: "window",
  },
};
```

with:

```ts
      { key: "basics", label: "Basic lands", dflt: false },
    ],
    chip: "window",
  },
  /**
   * **Round two (2026-09-26), the catalogue's newest four** — the spec is
   * `docs/superpowers/specs/2026-09-26-home-widgets-round-two-design.md` §2.1 and the footprints
   * are the design canvas's. `DEFAULT_LAYOUT` moves for none of them: it fills an eight-by-seven
   * rectangle exactly, and a new kind in it would break the rectangle.
   *
   * **`scope`'s label and its two options are the `decks` row's words, and that is load-bearing.**
   * A `Pinned` card draws `DecksWidget`'s own checklist through `extraSettings`, and that component
   * words its hint off the *decks* row (`Choose Pinned under Which decks…`) — so this row says the
   * same words or the reused sentence names a control this card does not have. `widgets.test.ts`
   * pins the pair. No `Archived too`: a deck put away is not one a reader is finishing.
   *
   * `complete` starts off, `newPrintings`' `dflt: false` precedent: a finished deck is counted in
   * the footer rather than listed, and a reader who wants the finished ones listed asks for them.
   */
  deckCompletion: {
    label: "Deck completion",
    description: "How much of each deck you own, and what the rest would cost.",
    def: [3, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [
      {
        key: "scope",
        label: "Which decks",
        options: [
          { id: "recent", label: "Most recent" },
          { id: "pinned", label: "Pinned" },
        ],
      },
      {
        key: "order",
        label: "Order",
        options: [
          { id: "done", label: "Nearest done" },
          { id: "cheapest", label: "Cheapest to finish" },
          { id: "name", label: "Name" },
        ],
      },
    ],
    toggles: [{ key: "complete", label: "Complete decks", dflt: false }],
    chip: "order",
  },
  /**
   * One row per place something is waiting, each drawn only when its count is above zero. `removed`
   * stays on by default and exists because Recently removed is a holding area rather than a
   * problem: a reader who uses it as an archive can take the row away.
   */
  toReview: {
    label: "To review",
    description: "Scanned cards, flagged rows and recently removed copies waiting for you.",
    def: [2, 3],
    min: [2, 2],
    max: [4, 4],
    picks: [],
    toggles: [{ key: "removed", label: "Recently removed" }],
  },
  /** The price sweep's own plan over the whole wishlist, read and never written. No settings:
   *  the question is fixed, which is what lets its press open the same sweep. */
  wishlistSavings: {
    label: "Wishlist savings",
    description: "What your pinned wishes would save on the cheapest printing of each card.",
    def: [3, 3],
    min: [2, 2],
    max: [4, 6],
    picks: [],
    toggles: [],
  },
  /**
   * Sets not released yet, soonest first. `window`'s options, words and `dflt: 90` are
   * `newPrintings`' exactly, so a reader who has set one has learnt the other.
   */
  comingSoon: {
    label: "Coming soon",
    description: "Unreleased sets, how much of each is previewed, and reprints of your deck cards.",
    def: [4, 2],
    min: [2, 2],
    max: [8, 4],
    picks: [
      {
        key: "window",
        label: "Window",
        dflt: 90,
        options: [
          { id: 30, label: "30 days" },
          { id: 90, label: "90 days" },
          { id: 365, label: "A year" },
        ],
      },
    ],
    toggles: [],
    chip: "window",
  },
};
```

`src/features/settings/ReviewPanel.tsx` — replace
`import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";` with:

```tsx
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
```

replace:

```tsx
const TABLE_ORDER = Object.keys(TABLE_LABEL) as ReviewTable[];
```

with:

```tsx
const TABLE_ORDER = Object.keys(TABLE_LABEL) as ReviewTable[];

/**
 * The query root each table's rows are read under — what a cleared sentence has to refresh besides
 * this panel.
 *
 * **Clearing a sentence changes a count somewhere else.** The collection's `needsReview` figure and
 * its banner, the wishlist's flagged-wish chip, the deck editor's rows and the home page's To
 * review widget all read these tables, and `sync_review_clear` answers only this panel's list — so
 * without this a cleared row stayed counted everywhere else until something unrelated invalidated
 * its root. The roots are the ones every other write to these tables already fires, and a folder's
 * cabinet is its entries', so nothing downstream learns a new key.
 *
 * **Total over `ReviewTable`**, `TABLE_LABEL`'s fence: a seventh table is a red build here too.
 */
const TABLE_ROOT: Record<ReviewTable, QueryKey> = {
  collection_entries: ["collection"],
  deck_cards: ["decks"],
  wishlist_entries: ["wishlist"],
  collection_folders: ["collection"],
  deck_folders: ["decks"],
  wishlist_folders: ["wishlist"],
};

/**
 * The root a row from `table` is read under, or `null` for a table this build has no name for —
 * the row filed under `Elsewhere`, which is still clearable and refreshes nothing it cannot name.
 * An own-property test rather than an index, because an index answers a function for
 * `"constructor"`.
 */
export function reviewRootOf(table: string): QueryKey | null {
  return Object.prototype.hasOwnProperty.call(TABLE_ROOT, table)
    ? TABLE_ROOT[table as ReviewTable]
    : null;
}
```

and replace the mutation's `onSuccess`:

```tsx
    onSuccess: (left) => {
      client.setQueryData(REVIEW_KEY, left);
```

…through…

```tsx
      void client.invalidateQueries({ queryKey: RELAY_KEY });
    },
```

with (the comment block between is unchanged; only the parameter list and the last three lines
move):

```tsx
    onSuccess: (left, { table }) => {
      client.setQueryData(REVIEW_KEY, left);
      // Two of the Sync panel's figures moved: `reviewCount` is one lower, and `pending` is one
      // *higher*, because clearing a sentence is a write like any other and is captured like
      // any other.
      //
      // **`RELAY_KEY` and deliberately not the `["sync"]` root.** The root matches this
      // panel's own key by prefix, so invalidating it would immediately re-fetch the list the
      // line above has just been handed — throwing away the whole reason the command answers
      // what is left. Correct in the shipped window, where the re-read agrees; a wasted round
      // trip on the one connection either way, and it hid a real bug in this test.
      void client.invalidateQueries({ queryKey: RELAY_KEY });
      // **And the list the row belongs to** — see {@link TABLE_ROOT}. Never the `["sync"]` root,
      // for the reason directly above.
      const root = reviewRootOf(table);
      if (root !== null) void client.invalidateQueries({ queryKey: root });
    },
```

- [ ] **Step 4: Run them to see them pass**

Run:
- `npx vitest run src/features/home/widgets.test.ts`
- `npx vitest run src/features/home/widgetSettings.test.ts`
- `npx vitest run src/features/settings/ReviewPanel.test.tsx`
- `npx vitest run src/features/home/HomePage.test.tsx` (unchanged file; it must stay green with the
  four new rows in the catalogue)

Expected: all pass. The `DEFAULT_LAYOUT` literal case in `widgets.test.ts` is untouched and green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p .`
Run: `npx eslint src/features/home/widgets.ts src/features/settings/ReviewPanel.tsx`
Expected: no errors. (`WIDGET_META` is a `Record<WidgetKind, …>`, so a union member without a row
would already be a type error here.)

---

### Task 6 (F3): The IPC mirror, the query keys, and the fake (after R3)

**Files:**
- Modify: `src/lib/ipc.ts` — three interfaces after `NewPrintings` (~6714-6729), three wrappers
  after `markNewPrintingsSeen` (~9441)
- Test: `src/lib/ipc.test.ts` — two `?raw` imports (~27, ~53), a new case after "sends the new
  widgets' reads…" (~2883-2980), three rows in `plainMirrors` (after `NewPrintings`, ~4812)
- Modify: `src/features/home/keys.ts` — imports (~82-88), one module-doc paragraph (~66-71), six
  keys at the end
- Test: `src/features/home/keys.test.tsx` — imports (~21-37), three cases at the end of `shape`
- Modify: `.storybook/fake/db.ts` — two type imports (~163, ~262), two constants after
  `BASIC_LAND_TYPE` (~2802), three read handlers after `set_completion` (~10954-10988)
- Modify: `.storybook/fake/seeds.ts` — header (~1-46), `SeedName` (~104-113), the `waiting` world
  before the switch (~2887), the switch (~2895-2916)
- Test: `.storybook/fake/db.test.ts` — one import (~79), four `describe`s after "set completion"
  (~15930-15997)
- Test: `.storybook/fake/world.test.ts` — `ALL_SEEDS` (~511-521), one case after "shared holds one
  published drawer…" (~666-678)
- Modify: `.storybook/CLAUDE.md` — the seeds list (~75-77) and one paragraph before "Re-count this
  list when you add one"

**Interfaces:**
- Consumes (from the Rust lane, read as text): `src-tauri/src/deck_completion.rs` declaring
  `pub struct DeckCompletion` (`deck_id, list, wanted, owned, missing, missing_cost,
  unpriced_missing`), `fn deck_completion(… marketplace: …)` and `fn deck_review_count(` with no
  parameter but the managed state; `src-tauri/src/upcoming_sets.rs` declaring `pub struct
  UpcomingSets` (`today, sets`), `pub struct UpcomingSet` (`code, name, released_at, previewed,
  in_decks`) and `fn upcoming_sets(… days: …)`; `desktop.rs` registering
  `deck_completion::deck_completion,`, `deck_completion::deck_review_count,` and
  `upcoming_sets::upcoming_sets,`. **Before Step 2, open both `.rs` files and `desktop.rs`**; if a
  name or a registration path differs from the contract, the contract is what the Rust task has to
  fix — do not bend the tests to match.
- Consumes (from F1): `wholeWishlistQuery(marketplace: MarketplaceId): OptimizeQuery`,
  `optimizePlanKey(query)`.
- Produces:
  ```ts
  export interface DeckCompletion { deckId: number; list: "live" | "theory"; wanted: number; owned: number; missing: number; missingCost: number | null; unpricedMissing: number }
  export interface UpcomingSet { code: string; name: string; releasedAt: string; previewed: number; inDecks: number }
  export interface UpcomingSets { today: string; sets: UpcomingSet[] }
  ipc.deckCompletion(marketplace: MarketplaceId): Promise<DeckCompletion[]>
  ipc.deckReviewCount(): Promise<number>
  ipc.upcomingSets(days: number): Promise<UpcomingSets>

  deckCompletionKey(marketplace: MarketplaceId): QueryKey   // ["decks", "completion", marketplace]
  upcomingSetsKey(days: number): QueryKey                    // ["decks", "upcoming", days]
  deckReviewCountKey: QueryKey                               // ["decks", "reviewCount"]
  wishlistReviewCountKey: QueryKey                           // ["wishlist", "reviewCount"]
  wishlistSavingsKey(marketplace: MarketplaceId): QueryKey   // optimizePlanKey(wholeWishlistQuery(marketplace)) — see Contract problems
  scannerTrayCountKey: QueryKey                              // ["scanner", "trayCount"]
  ```
  (each interface written **one field per line** in `ipc.ts` — `ipc.test.ts`'s `tsFields` parses
  one field per line and would find nothing in a one-line interface.)
- Produces (the fake): read handlers `deck_completion({ marketplace? })`, `deck_review_count()`,
  `upcoming_sets({ days })`, each computed from the fake's own rows; a new seed **`waiting`** —
  `needsReview` (a flagged collection row, a flagged wish, a flagged deck card) plus two copies in
  Recently removed plus seven unreleased printings in three invented sets. **No seed carries a
  scanner tray** (`FakeDb.scannerTray`'s own rule): the To review story writes `TRAY_ROWS` — whose
  Lightning Bolt still waits on a printing choice — through `ipc.setScannerTray` in a `useState`
  initializer, `ScannerPage.stories.tsx`'s `Written` arrangement.

- [ ] **Step 1: Write the failing tests**

`src/lib/ipc.test.ts` — replace:

```ts
import decksortRs from "../../src-tauri/src/decksort.rs?raw";
import deckMetaRs from "../../src-tauri/src/deck_meta.rs?raw";
```

with:

```ts
import decksortRs from "../../src-tauri/src/decksort.rs?raw";
import deckCompletionRs from "../../src-tauri/src/deck_completion.rs?raw";
import deckMetaRs from "../../src-tauri/src/deck_meta.rs?raw";
```

replace:

```ts
import syncLiveRs from "../../src-tauri/src/sync_engine/live.rs?raw";
import wishlistFoldersRs from "../../src-tauri/src/wishlist_folders.rs?raw";
```

with:

```ts
import syncLiveRs from "../../src-tauri/src/sync_engine/live.rs?raw";
import upcomingSetsRs from "../../src-tauri/src/upcoming_sets.rs?raw";
import wishlistFoldersRs from "../../src-tauri/src/wishlist_folders.rs?raw";
```

Insert directly after the case that ends

```ts
    declares(newPrintingsRs, "mark_new_printings_seen", "at");
  });
```

this case:

```ts

  /**
   * **Round two's three reads** (2026-09-26) — Deck completion, To review's deck-card count and
   * Coming soon — pinned on the day they were written, one case because they are one page's worth.
   *
   * Three traps, one per command. `deck_completion` takes `marketplace` alone, `deck_values`' shape
   * one read over, and a wrapper copied from `price_movers` would send three more keys Tauri has
   * nowhere to put. `deck_review_count` takes **no arguments**, `set_completion`'s trap: an argument
   * object sent to a command that declares only the managed state is a deserialisation error, not a
   * type error. And `upcoming_sets` takes `days` — `new_printings`' own word for its window — where
   * a wrapper copied from `recent_cards` would send `limit` and read an empty feed as "nothing
   * announced".
   *
   * **The registrations are asserted too**, because a command the handler list forgot answers
   * `unknown command` at run time with both suites green.
   */
  it("sends round two's three reads under the names their commands declare", async () => {
    // A pass must never be able to mean "the crate was never read".
    for (const [name, src] of [
      ["deck_completion.rs", deckCompletionRs],
      ["upcoming_sets.rs", upcomingSetsRs],
    ] as const) {
      expect(src.length, `${name} was not read`).toBeGreaterThan(1_000);
    }
    const declares = (src: string, command: string, param: string) =>
      expect(src, `\`${command}\` declares no \`${param}\``).toMatch(
        new RegExp(`fn ${command}\\([^)]*\\b${param}\\s*:`, "s"),
      );

    invoke.mockResolvedValue([]);
    await ipc.deckCompletion("cardkingdom");
    expect(invoke).toHaveBeenCalledWith("deck_completion", { marketplace: "cardkingdom" });
    declares(deckCompletionRs, "deck_completion", "marketplace");

    invoke.mockResolvedValue(2);
    await ipc.deckReviewCount();
    expect(invoke).toHaveBeenCalledWith("deck_review_count");
    expect(deckCompletionRs).toContain("fn deck_review_count(");

    invoke.mockResolvedValue({ today: "2026-09-26", sets: [] });
    await ipc.upcomingSets(90);
    expect(invoke).toHaveBeenCalledWith("upcoming_sets", { days: 90 });
    declares(upcomingSetsRs, "upcoming_sets", "days");

    for (const registered of [
      "deck_completion::deck_completion,",
      "deck_completion::deck_review_count,",
      "upcoming_sets::upcoming_sets,",
    ]) {
      expect(desktopRs).toContain(registered);
    }
  });
```

In `plainMirrors`, replace:

```ts
    ["NewPrintings", newPrintingsRs, "NewPrintings"],
    ["WishlistSummary", wishlistRs, "WishlistSummary"],
```

with:

```ts
    ["NewPrintings", newPrintingsRs, "NewPrintings"],
    // **Round two's three** (2026-09-26): `DeckCompletion` from `deck_completion.rs`, and
    // `UpcomingSet` nested inside `UpcomingSets` from `upcoming_sets.rs` — two rows for that one
    // command for `PriceMovers`' reason, since a field renamed inside a set leaves the outer struct
    // agreeing while every row reads `undefined`. Here and not on `mirrors`: no picture, and none
    // reaches ten fields.
    //
    // Every drift is the quiet kind. A renamed `missingCost` is `undefined`, which is not `null`,
    // so a deck's cost draws `NaN` where an em dash belongs; a renamed `wanted` makes every ratio
    // `NaN` and the order meaningless; a renamed `today` leaves the page no day to count *in N
    // days* from; and a renamed `inDecks` is `undefined`, so a caption's last clause never draws —
    // which is exactly what a set with no deck cards in it looks like.
    ["DeckCompletion", deckCompletionRs, "DeckCompletion"],
    ["UpcomingSet", upcomingSetsRs, "UpcomingSet"],
    ["UpcomingSets", upcomingSetsRs, "UpcomingSets"],
    ["WishlistSummary", wishlistRs, "WishlistSummary"],
```

`src/features/home/keys.test.tsx` — replace the `./keys` import block:

```tsx
import {
  activityKey,
  collectionBreakdownKey,
  collectionTotalKey,
  deckListKey,
  deckValuesKey,
  NEW_PRINTINGS_ROOT,
  newPrintingsKey,
  priceHistoryKey,
  priceMoversKey,
  RECENT_CARDS_ROOT,
  recentCardsKey,
  setCompletionKey,
  stickyNotesKey,
  wishlistBreakdownKey,
  wishlistTotalKey,
} from "./keys";
```

with:

```tsx
import { optimizePlanKey } from "@/features/wishlist/useWishlistOptimize";
import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import {
  activityKey,
  collectionBreakdownKey,
  collectionTotalKey,
  deckCompletionKey,
  deckListKey,
  deckReviewCountKey,
  deckValuesKey,
  NEW_PRINTINGS_ROOT,
  newPrintingsKey,
  priceHistoryKey,
  priceMoversKey,
  RECENT_CARDS_ROOT,
  recentCardsKey,
  scannerTrayCountKey,
  setCompletionKey,
  stickyNotesKey,
  upcomingSetsKey,
  wishlistBreakdownKey,
  wishlistReviewCountKey,
  wishlistSavingsKey,
  wishlistTotalKey,
} from "./keys";
```

At the end of `describe("shape", …)`, replace:

```tsx
    // Every language is the empty list, which joins to the empty string rather than to a word —
    // the same sentinel the wire carries.
    expect(newPrintingsKey("all", [], 30, [], flags, 25)[5]).toBe("");
  });
});
```

with:

```tsx
    // Every language is the empty list, which joins to the empty string rather than to a word —
    // the same sentinel the wire carries.
    expect(newPrintingsKey("all", [], 30, [], flags, 25)[5]).toBe("");
  });

  // Round two (2026-09-26). Each sits under the root its data's writes already invalidate — deck
  // completion carries the marketplace because its cost is priced at it, the upcoming feed its
  // window because the window is the question — and the two review counts under the table each
  // counts, which is also the root Needs review's clear now fires.
  it("files round two's reads under the roots their writes already invalidate", () => {
    expect(deckCompletionKey("cardkingdom")).toEqual(["decks", "completion", "cardkingdom"]);
    expect(upcomingSetsKey(90)).toEqual(["decks", "upcoming", 90]);
    expect(deckReviewCountKey).toEqual(["decks", "reviewCount"]);
    expect(wishlistReviewCountKey).toEqual(["wishlist", "reviewCount"]);
    expect(scannerTrayCountKey).toEqual(["scanner", "trayCount"]);
    // Not the gallery's value key: that one is the narrower main + commander + maybe pile.
    expect(deckCompletionKey("tcgplayer")).not.toEqual(deckValuesKey("tcgplayer"));
  });

  // **The savings widget and the Wishlist page's hand-off dialog plan one question, so they are
  // one cache entry**: the widget's key *is* `useWishlistOptimize`'s for the whole list, and the
  // dialog the widget opens is handed the widget's answer rather than asking again.
  it("files wishlist savings under the optimise plan's own key for the whole list", () => {
    expect(wishlistSavingsKey("manapool")).toEqual([
      "wishlist",
      "optimize",
      { flatten: true, marketplace: "manapool" },
    ]);
    expect(wishlistSavingsKey("manapool")).toEqual(optimizePlanKey(wholeWishlistQuery("manapool")));
    expect(wishlistSavingsKey("manapool")).not.toEqual(wishlistSavingsKey("cardmarket"));
  });

  // `["scanner", "tray"]` *is* the tray in the window that owns the scanner, written with
  // `setQueryData`; a count that shared it would be a second reader able to refetch it out from
  // under the scanner's own write.
  it("keeps the tray count off the scanner's own tray entry", () => {
    expect(scannerTrayCountKey).not.toEqual(["scanner", "tray"]);
    expect(scannerTrayCountKey.slice(0, 1)).toEqual(["scanner"]);
  });
});
```

`.storybook/fake/db.test.ts` — replace:

```ts
import { activityLine } from "@/features/home/activityText";
```

with:

```ts
import { activityLine } from "@/features/home/activityText";
// The deck editor's own arithmetic, borrowed for the one fence `deck_completion` exists to keep:
// the widget has to say what the editor says, and a hand-copy of the sum here would only prove the
// fake agrees with itself.
import { deckStats } from "@/features/decks/DeckStats";
```

Insert after the `describe("set completion", …)` block (it ends
`expect(readHandlers(seed("empty")).set_completion()).toEqual([]);\n  });\n});`):

```ts

/**
 * `deck_completion` — owned against wanted, **counted the way the deck editor counts it**: a live
 * list against its own group, a plan-keeping deck's theory list against every copy it could use,
 * every active pile, exact `(card_id, finish)`, one shared pool per key.
 */
describe("deck completion", () => {
  /** What the deck editor quotes one copy of deck 1's first row at. */
  const unitOf = (db: FakeDb, marketplace?: string) =>
    readHandlers(db).deck_get({ id: 1, variant: "live", marketplace })!.cards[0].unitPrice!;

  it("measures a live list against its own group, over every active pile, from one shared pool", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, categoryKind: "main", quantity: 4 }),
        // The same printing in the sideboard: one `(card_id, finish)` key, so the two rows share
        // the group's five rather than each being handed all of them.
        deckCard({ id: 2, categoryKind: "side", quantity: 2 }),
        // The Maybeboard ships switched off, and a switched-off pile counts toward nothing.
        deckCard({ id: 3, categoryKind: "maybe", quantity: 3 }),
      ],
      collectionEntries: [
        entry({ id: 1, folderId: groupId(1), quantity: 5 }),
        // At the root: a live list is custody, and a copy nobody filed into the deck is not its.
        entry({ id: 2, quantity: 9 }),
      ],
    });
    const unit = unitOf(db);

    const [row] = readHandlers(db).deck_completion({});

    expect(row).toMatchObject({
      deckId: 1,
      list: "live",
      wanted: 6,
      owned: 5,
      missing: 1,
      unpricedMissing: 0,
    });
    expect(row.missingCost).toBeCloseTo(unit, 9);
  });

  /** A deck that keeps a plan is measured by its plan, against the root, its own group and
   *  Recently removed — never another deck's group. */
  it("measures a theory deck's plan against every copy the deck could use", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, theoryEnabled: true }), deck({ id: 2, name: "Other" })],
      deckCards: [
        deckCard({ id: 1, variant: "theory", quantity: 4 }),
        // The live list is not what a plan-keeping deck is measured by.
        deckCard({ id: 2, quantity: 1 }),
      ],
      collectionEntries: [
        entry({ id: 1, quantity: 1 }),
        entry({ id: 2, folderId: REMOVED_FOLDER, quantity: 1 }),
        entry({ id: 3, folderId: groupId(1), quantity: 1 }),
        entry({ id: 4, folderId: groupId(2), quantity: 5 }),
      ],
    });

    expect(readHandlers(db).deck_completion({}).find((r) => r.deckId === 1)).toMatchObject({
      list: "theory",
      wanted: 4,
      owned: 3,
      missing: 1,
    });
  });

  /** A virtual deck holds nothing by definition, so 0 % of it is not a finding. An archived or an
   *  empty deck still answers — which decks to draw is the widget's decision. */
  it("answers no row for a virtual deck, and a row for an archived or an empty one", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1, archived: true }), deck({ id: 2, virtualOnly: true }), deck({ id: 3 })],
      deckCards: [deckCard({ id: 1, deckId: 2, quantity: 4 })],
    });
    const nothing = { list: "live", wanted: 0, owned: 0, missing: 0, missingCost: null, unpricedMissing: 0 };

    expect(readHandlers(db).deck_completion({})).toEqual([
      { deckId: 1, ...nothing },
      { deckId: 3, ...nothing },
    ]);
  });

  /** An unpriced copy is counted in its own figure and never summed as zero. */
  it("counts missing copies the marketplace cannot price, and answers null when nothing is priced", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, cardId: NO_PRICE.id, quantity: 3 })],
    });

    expect(readHandlers(db).deck_completion({})).toEqual([
      {
        deckId: 1,
        list: "live",
        wanted: 3,
        owned: 0,
        missing: 3,
        missingCost: null,
        unpricedMissing: 3,
      },
    ]);
  });

  /**
   * **`0` rather than `null` once anything counted is priced** — `deckStats`' `missingPrice` rule,
   * which is the editor's: `null` is "this marketplace quotes none of this deck", and a deck whose
   * priced copies are all in hand costs nothing to finish at the prices there are.
   */
  it("answers zero rather than null once anything counted is priced", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, quantity: 1 }),
        deckCard({ id: 2, cardId: NO_PRICE.id, categoryKind: "side", quantity: 2 }),
      ],
      collectionEntries: [entry({ id: 1, folderId: groupId(1), quantity: 1 })],
    });

    expect(readHandlers(db).deck_completion({})[0]).toMatchObject({
      missing: 2,
      missingCost: 0,
      unpricedMissing: 2,
    });
  });

  it("prices the missing copies at the marketplace it is asked for", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [deckCard({ id: 1, quantity: 2 })],
    });
    const eur = unitOf(db, "cardmarket");

    expect(readHandlers(db).deck_completion({ marketplace: "cardmarket" })[0].missingCost).toBeCloseTo(
      2 * eur,
      9,
    );
  });

  /**
   * **The fence**: for every deck in the starter world — a live deck with copies in its group, a
   * Commander deck, a deck with a plan — the numbers are the ones the editor's own `deckStats`
   * draws over `deck_get` of the list that was measured.
   */
  it("says what the deck editor says, for every deck in the starter world", () => {
    const db = seed("starter");
    const reads = readHandlers(db);
    const rows = reads.deck_completion({ marketplace: "tcgplayer" });

    expect(rows.map((r) => r.deckId)).toEqual(
      db.decks
        .filter((d) => !d.virtualOnly)
        .map((d) => d.id)
        .sort((a, b) => a - b),
    );
    // Non-vacuity: a plan is measured, and something is missing somewhere.
    expect(rows.some((r) => r.list === "theory")).toBe(true);
    expect(rows.some((r) => r.missing > 0)).toBe(true);
    for (const row of rows) {
      const cards = reads.deck_get({ id: row.deckId, variant: row.list, marketplace: "tcgplayer" })!
        .cards;
      const stats = deckStats(cards);
      expect(row.owned, `deck ${row.deckId} owned`).toBe(stats.owned);
      expect(row.missing, `deck ${row.deckId} missing`).toBe(stats.missing);
      expect(row.wanted, `deck ${row.deckId} wanted`).toBe(stats.owned + stats.missing);
      if (stats.missingPrice === null) expect(row.missingCost).toBeNull();
      else expect(row.missingCost).toBeCloseTo(stats.missingPrice, 9);
    }
  });
});

/** `deck_review_count` — `count(*)` of `deck_cards` carrying a sentence: rows, never copies. */
describe("deck review count", () => {
  it("counts the deck rows carrying a sentence, and only those", () => {
    const db = makeDeckDb({
      decks: [deck({ id: 1 })],
      deckCards: [
        deckCard({ id: 1, quantity: 4, needsReview: "This printing is not in the card database." }),
        deckCard({ id: 2, categoryKind: "side" }),
        // A switched-off pile still asks: the sentence is about the row, not about what it counts.
        deckCard({
          id: 3,
          categoryKind: "maybe",
          needsReview: "Another device deleted this while this one was still changing it, so it was kept.",
        }),
      ],
    });

    expect(readHandlers(db).deck_review_count()).toBe(2);
  });

  it("answers zero for starter and one for needsReview", () => {
    expect(readHandlers(seed("starter")).deck_review_count()).toBe(0);
    expect(readHandlers(seed("needsReview")).deck_review_count()).toBe(1);
  });
});

/**
 * `upcoming_sets` — sets with paper printings released after today and inside the window, read
 * over `cards` because the browser build never fills `sets`. The fake has no `set_type` at all,
 * which is the browser build's shape: the layout fence is the whole rule here.
 */
describe("upcoming sets", () => {
  const TODAY = new Date(CLOCK_BASE * 1_000).toISOString().slice(0, 10);
  const inDays = (days: number) =>
    new Date((CLOCK_BASE + days * 86_400) * 1_000).toISOString().slice(0, 10);
  /** A printing of `template` in a set `days` out — every column but the set, the number, the
   *  date and the id is the real row's. */
  const future = (
    template: FakeCard,
    set: string,
    number: string,
    days: number,
    over: Partial<FakeCard> = {},
  ): FakeCard => ({
    ...template,
    id: `future-${set}-${number}`,
    setCode: set,
    setName: `Set ${set.toUpperCase()}`,
    collectorNumber: number,
    releasedAt: inDays(days),
    ...over,
  });

  it("answers the sets after today and inside the window, soonest first, at their earliest date", () => {
    const db = makeDb({
      cards: [
        ...CARDS,
        future(BOLT, "bbb", "1", 20),
        future(BOLT, "aaa", "1", 5),
        // A later card of the same set: the set answers its earliest date and counts both.
        future(BOLT, "aaa", "2", 9),
        // Releasing today is released, not upcoming.
        future(BOLT, "zzz", "1", 0),
        // Exactly at the window's edge is inside it; one day past is not.
        future(BOLT, "xxx", "1", 30),
        future(BOLT, "yyy", "1", 31),
      ],
    });

    const got = readHandlers(db).upcoming_sets({ days: 30 });

    expect(got.today).toBe(TODAY);
    expect(got.sets.map((s) => [s.code, s.releasedAt, s.previewed])).toEqual([
      ["aaa", inDays(5), 2],
      ["bbb", inDays(20), 1],
      ["xxx", inDays(30), 1],
    ]);
  });

  it("leaves out tokens, emblems, art cards and digital printings", () => {
    const db = makeDb({
      cards: [
        ...CARDS,
        future(BOLT, "aaa", "1", 5),
        future(BOLT, "aaa", "T1", 5, { layout: "token" }),
        future(BOLT, "aaa", "T2", 5, { layout: "double_faced_token" }),
        future(BOLT, "aaa", "E1", 5, { layout: "emblem" }),
        future(BOLT, "aaa", "A1", 5, { layout: "art_series" }),
        future(BOLT, "ddd", "1", 5, { isPaper: false, digital: true }),
      ],
    });

    expect(readHandlers(db).upcoming_sets({ days: 90 }).sets).toEqual([
      { code: "aaa", name: "Set AAA", releasedAt: inDays(5), previewed: 1, inDecks: 0 },
    ]);
  });

  /** `new_printings`' defaults: live and theory rows, virtual decks left out, basics left out. */
  it("counts the oracle cards the reader's decks hold, live or theory, without virtual decks or basics", () => {
    const COUNTERSPELL = CARDS.find((c) => c.name === "Counterspell")!;
    const FOREST = CARDS.find((c) => c.typeLine === "Basic Land — Forest")!;
    const SOL_RING = CARDS.find((c) => c.name === "Sol Ring")!;
    const TOMB = CARDS.find((c) => c.name === "Ancient Tomb")!;
    const db = makeDeckDb({
      cards: [
        ...CARDS,
        future(BOLT, "aaa", "1", 5),
        future(COUNTERSPELL, "aaa", "2", 5),
        future(FOREST, "aaa", "3", 5),
        future(SOL_RING, "aaa", "4", 5),
        future(TOMB, "aaa", "5", 5),
      ],
      decks: [deck({ id: 1, theoryEnabled: true }), deck({ id: 2, virtualOnly: true })],
      deckCards: [
        deckCard({ id: 1, cardId: BOLT.id }),
        deckCard({ id: 2, cardId: COUNTERSPELL.id, variant: "theory" }),
        deckCard({ id: 3, cardId: FOREST.id, quantity: 20 }),
        deckCard({ id: 4, deckId: 2, cardId: SOL_RING.id }),
      ],
    });

    expect(readHandlers(db).upcoming_sets({ days: 90 }).sets).toEqual([
      { code: "aaa", name: "Set AAA", releasedAt: inDays(5), previewed: 5, inDecks: 2 },
    ]);
  });

  it("clamps the window into 1..=365", () => {
    const db = makeDb({
      cards: [
        ...CARDS,
        future(BOLT, "aaa", "1", 1),
        future(BOLT, "bbb", "1", 365),
        future(BOLT, "ccc", "1", 366),
      ],
    });
    const codes = (days: number) =>
      readHandlers(db)
        .upcoming_sets({ days })
        .sets.map((s) => s.code);

    expect(codes(0)).toEqual(["aaa"]);
    expect(codes(-5)).toEqual(["aaa"]);
    expect(codes(99_999)).toEqual(["aaa", "bbb"]);
  });

  /** The generated corpus has nothing unreleased but a token; the `waiting` world has three sets,
   *  one per window. */
  it("answers nothing for starter, and one, two and three sets for waiting's three windows", () => {
    expect(readHandlers(seed("starter")).upcoming_sets({ days: 365 }).sets).toEqual([]);
    const waiting = readHandlers(seed("waiting"));

    expect(waiting.upcoming_sets({ days: 30 }).sets.map((s) => s.code)).toEqual(["ftf"]);
    expect(waiting.upcoming_sets({ days: 90 }).sets.map((s) => s.code)).toEqual(["ftf", "vgd"]);
    expect(waiting.upcoming_sets({ days: 365 }).sets).toEqual([
      { code: "ftf", name: "Foretold Frontiers", releasedAt: inDays(12), previewed: 4, inDecks: 2 },
      { code: "vgd", name: "Vigil of the Drowned", releasedAt: inDays(40), previewed: 2, inDecks: 0 },
      { code: "lmr", name: "Lumen Reach", releasedAt: inDays(200), previewed: 1, inDecks: 1 },
    ]);
  });
});

/** The world To review is storied in: something behind every row it can draw but the scanner's. */
describe("the waiting world", () => {
  it("has something for each of To review's rows the store can seed", () => {
    const db = seed("waiting");
    const reads = readHandlers(db);

    expect(reads.collection_summary({ query: WHOLE_COLLECTION }).needsReview).toBe(1);
    expect(
      reads.wishlist_list({ query: { needsReview: true, flatten: true, limit: 1, offset: 0 } }).total,
    ).toBe(1);
    expect(reads.deck_review_count()).toBe(1);
    const removed = reads.collection_folder_list().find((f) => f.kind === "removed")!;
    expect(reads.collection_folder_summary({}).find((s) => s.folderId === removed.id)?.cards).toBe(2);
  });

  /** `FakeDb.scannerTray`'s rule: a tray row is a card somebody scanned, so a story writes one. */
  it("carries no scanner tray", () => {
    expect(seed("waiting").scannerTray).toEqual([]);
  });
});
```

`.storybook/fake/world.test.ts` — in `ALL_SEEDS`, replace:

```ts
    paired: true,
    shared: true,
  } satisfies Record<SeedName, true>) as SeedName[];
```

with:

```ts
    paired: true,
    shared: true,
    waiting: true,
  } satisfies Record<SeedName, true>) as SeedName[];
```

and insert directly after the case "shared holds one published drawer and one link from somebody
else" (it ends `expect(db.pairing.group).not.toBeNull();\n  });`):

```ts

  /**
   * **`waiting` is `needsReview` plus two things and nothing else** — a Recently removed row and
   * the unreleased printings — so every story on it sees exactly the decks, wishes and flagged rows
   * a `needsReview` story sees, and the corpus is the generated one with seven rows appended rather
   * than a different one.
   */
  it("waiting is needsReview plus a Recently removed row and seven unreleased printings", () => {
    const base = seed("needsReview");
    const db = seed("waiting");
    const today = new Date(CLOCK_BASE * 1_000).toISOString().slice(0, 10);

    expect(db.cards.slice(0, base.cards.length)).toEqual(base.cards);
    const extra = db.cards.slice(base.cards.length);
    expect(extra).toHaveLength(7);
    for (const card of extra) {
      expect(card.releasedAt > today, card.id).toBe(true);
      expect(base.cards.some((c) => c.id === card.id), card.id).toBe(false);
    }
    expect(db.collectionEntries.slice(0, base.collectionEntries.length)).toEqual(
      base.collectionEntries,
    );
    expect(db.collectionEntries).toHaveLength(base.collectionEntries.length + 1);
    expect(db.decks).toEqual(base.decks);
    expect(db.deckCards).toEqual(base.deckCards);
    expect(db.wishlistEntries).toEqual(base.wishlistEntries);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run:
- `npx vitest run src/lib/ipc.test.ts -t "round two|mirror agrees"` — expected: `ipc.deckCompletion is
  not a function`, and the three new `plainMirrors` rows fail with
  ``\`export interface DeckCompletion\` is not in ipc.ts``.
- `npx vitest run src/features/home/keys.test.tsx` — expected: `deckCompletionKey is not a function`.
- `npx vitest run .storybook/fake/db.test.ts -t "deck completion|deck review count|upcoming sets|the waiting world"`
  — expected: `reads.deck_completion is not a function` (and its two siblings); the waiting cases
  get `starter` back from `seed`'s default arm.
- `npx vitest run .storybook/fake/world.test.ts` — expected: the new case fails (`extra` has length
  0); `ALL_SEEDS`' `satisfies` is a type error only (`tsc`), not a runtime one.

- [ ] **Step 3: Implement**

`src/lib/ipc.ts` — **the three shapes**. Replace:

```ts
  seenAt: number | null;
}

/**
 * Which edge detector runs — `Method` in `crates/card-scanner/src/session.rs`, whose
```

with:

```ts
  seenAt: number | null;
}

/**
 * How much of one deck the reader owns — `deck_completion.rs`'s `DeckCompletion`, one row per deck
 * that is not virtual (archived ones included; which decks to draw is the widget's decision).
 *
 * **Counted exactly as the deck editor counts**, which is the whole point of the read: a widget
 * saying "4 missing" about a deck that opens saying "6 missing" is a bug report. So a deck with no
 * plan measures its live list against its own group, a deck with `theoryEnabled` measures its plan
 * against every copy it could use, every active pile counts — sideboard and companion included,
 * unlike {@link DeckValue}'s narrower pile — and ownership is exact printing and finish.
 */
export interface DeckCompletion {
  deckId: number;
  /** Which list was measured — `live` against the deck's own group, or `theory` for a deck that
   *  keeps a plan. The editor's `Actual`/`Theory` tab the numbers agree with. */
  list: "live" | "theory";
  /** Copies the measured list asks for, over every active pile. */
  wanted: number;
  /** Of those, copies the pool covers. Never more than `wanted`. */
  owned: number;
  /** `wanted − owned`. Never negative. */
  missing: number;
  /**
   * What the missing copies cost at the marketplace asked for. **`null` when nothing counted in
   * the list is priced there** — `DeckStats`' `missingPrice` rule — so a complete deck whose cards
   * are priced answers `0`, and `null` always draws an em dash rather than `$0.00`.
   */
  missingCost: number | null;
  /** Missing **copies** this marketplace has no price for — counted beside the cost, never summed
   *  into it as zero. */
  unpricedMissing: number;
}

/** One set with printings still to come — `upcoming_sets.rs`'s `UpcomingSet`. */
export interface UpcomingSet {
  code: string;
  name: string;
  /** The set's **earliest** card date, `YYYY-MM-DD` — cards of one set can carry different dates. */
  releasedAt: string;
  /** Distinct collector numbers previewed so far. */
  previewed: number;
  /** Distinct oracle cards in it that the reader's non-virtual decks hold, live or theory, basic
   *  lands left out — `new_printings`' defaults. */
  inDecks: number;
}

/**
 * The upcoming sets, and the day they were counted from — `upcoming_sets.rs`'s `UpcomingSets`.
 *
 * **Read over `cards`, not `sets`**, because the browser build never fills `sets`; where it has
 * rows the crate also drops token, promo, memorabilia and minigame sets.
 */
export interface UpcomingSets {
  /** SQLite's `date('now')`, UTC — the day *in N days* is counted from, so the page carries no
   *  clock of its own. */
  today: string;
  /** Soonest first, then by code. */
  sets: UpcomingSet[];
}

/**
 * Which edge detector runs — `Method` in `crates/card-scanner/src/session.rs`, whose
```

**The three wrappers**. Replace:

```ts
  markNewPrintingsSeen: (at: number) => invoke<void>("mark_new_printings_seen", { at }),
```

with:

```ts
  markNewPrintingsSeen: (at: number) => invoke<void>("mark_new_printings_seen", { at }),
  /**
   * How much of every deck the reader owns, priced at `marketplace` — see {@link DeckCompletion}.
   * `deck_values`' shape: one argument, and the marketplace belongs in the caller's query key.
   */
  deckCompletion: (marketplace: MarketplaceId) =>
    invoke<DeckCompletion[]>("deck_completion", { marketplace }),
  /**
   * How many `deck_cards` rows carry a `needs_review` sentence — rows, not copies, and only that
   * one table. Its own read rather than `sync_relay_status`' `reviewCount`, which sums six tables,
   * is desktop-only and takes the write lock. **Takes no arguments**: an argument object sent to a
   * command that declares only the managed state is a deserialisation error, not a type error.
   */
  deckReviewCount: () => invoke<number>("deck_review_count"),
  /**
   * The sets with paper printings released after today and within `days` (clamped `1..=365` in
   * Rust) — see {@link UpcomingSets}. Routed on both targets.
   */
  upcomingSets: (days: number) => invoke<UpcomingSets>("upcoming_sets", { days }),
```

`src/features/home/keys.ts` — **imports**: replace

```ts
import type { QueryKey } from "@tanstack/react-query";

import type { Finish } from "@/lib/finish";
import type { PriceMoverDirection, PriceMoverWindow } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

import type { BreakdownDimension } from "./widgets";
```

with:

```ts
import type { QueryKey } from "@tanstack/react-query";

import { optimizePlanKey } from "@/features/wishlist/useWishlistOptimize";
import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import type { Finish } from "@/lib/finish";
import type { PriceMoverDirection, PriceMoverWindow } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

import type { BreakdownDimension } from "./widgets";
```

**The module doc** — replace:

```ts
 * widget's own cursor write is not a deck write at all. Filed under `["decks"]` it would refetch
 * after every card added to any deck and stay stale after the sync that actually brings the new
 * printings in. The whole argument is at the constant itself.
 *
 * ## What is deliberately not here
```

with:

```ts
 * widget's own cursor write is not a deck write at all. Filed under `["decks"]` it would refetch
 * after every card added to any deck and stay stale after the sync that actually brings the new
 * printings in. The whole argument is at the constant itself.
 *
 * {@link scannerTrayCountKey} sits under `["scanner"]`, and it is the one key in this file **no
 * write invalidates at all**: the scanner writes its tray with `setQueryData` on its own entry, and
 * never on the same screen as the home page. What keeps it fresh is its reader's `staleTime`, which
 * its declaration argues.
 *
 * ## What is deliberately not here
```

**The six keys** — append at the end of the file, after `newPrintingsKey`'s closing `];`:

```ts

/**
 * How much of each deck the reader owns — `ipc.deckCompletion`, the Deck completion widget's read.
 *
 * Under `["decks"]` because a deck write changes what a deck *wants* — but **owned copies are
 * collection rows**, so an add to the binder, a move into a deck's group or a cut into Recently
 * removed changes the answer with no deck write at all. The widget bridges that itself, exactly as
 * `ActivityWidget` bridges {@link activityKey}: a marker query under `["collection"]` so the signal
 * exists, and a cache subscription that turns an invalidation there into one of this key. **Both
 * halves are load-bearing** — `invalidateQueries` dispatches nothing when it matches no cached
 * query. The marketplace is in the key because `missingCost` is priced at it.
 */
export const deckCompletionKey = (marketplace: MarketplaceId): QueryKey => [
  "decks",
  "completion",
  marketplace,
];

/**
 * The sets still to come within `days` — `ipc.upcomingSets`, Coming soon's read.
 *
 * Under `["decks"]` with no bridge, and the sync is why that is enough: the answer is half the
 * corpus and half `deck_cards`, a deck write changes the second half, and a finished sync — the
 * only thing that changes the first — invalidates `["decks"]` along with every other root
 * (`SYNC_INVALIDATED` in `src/lib/useSyncInvalidation.ts`). {@link NEW_PRINTINGS_ROOT} made the
 * other call for a feed that also carries a cursor write of its own; this one has none. The window
 * is in the key because it is the question.
 */
export const upcomingSetsKey = (days: number): QueryKey => ["decks", "upcoming", days];

/**
 * How many deck rows carry a review sentence — `ipc.deckReviewCount`, To review's `Deck cards` row.
 * Under `["decks"]`: a deck write that clears a row, a sync that flags one, and Needs review's own
 * clear (which invalidates the cleared table's root) all reach it.
 */
export const deckReviewCountKey: QueryKey = ["decks", "reviewCount"];

/**
 * How many wishes carry a review sentence — `wishlist_list({ needsReview: true, flatten: true,
 * limit: 1, offset: 0 }).total`, To review's `Wishes` row. A key of its own rather than
 * `useWishlist`'s list key, which is fourteen segments of one page's local state; under
 * `["wishlist"]`, which every wishlist write and Needs review's clear already fire.
 */
export const wishlistReviewCountKey: QueryKey = ["wishlist", "reviewCount"];

/**
 * What every pinned wish would save — `wishlist_optimize_plan` over {@link wholeWishlistQuery},
 * the Wishlist savings widget's read.
 *
 * **`useWishlistOptimize`'s own key for the whole list, and deliberately not a key of this file's
 * shape.** The widget's press opens the Wishlist's sweep dialog over the same list (`store.ts`'s
 * `pendingOptimize`), so the two are one question and should be one cache entry: the dialog opens
 * on the widget's answer, and the dialog's apply — which invalidates `["wishlist"]` — refreshes the
 * widget with it. The marketplace rides inside the query object, which is the key's last segment.
 */
export const wishlistSavingsKey = (marketplace: MarketplaceId): QueryKey =>
  optimizePlanKey(wholeWishlistQuery(marketplace));

/**
 * How many rows the scanner's review tray holds, and how many still wait on a printing —
 * To review's `Scanned cards` row reads `scanner_tray` under this key.
 *
 * **Never `["scanner", "tray"]`**, which *is* the tray in the window that owns the scanner, written
 * with `setQueryData` (`useTray.ts`); the stored copy can lag that entry by the tray's debounce, and
 * a second reader able to refetch it would race the scanner's own write. **Nothing invalidates this
 * key**, because the scanner and the home page are never on screen together in one window: its
 * reader must re-read on every mount (`staleTime: 0`) rather than trusting the app's 30-second
 * default across a trip to the Scanner and back.
 */
export const scannerTrayCountKey: QueryKey = ["scanner", "trayCount"];
```

`.storybook/fake/db.ts` — **types**: replace

```ts
  DeckCombo,
  DeckCoverKind,
```

with:

```ts
  DeckCombo,
  DeckCompletion,
  DeckCoverKind,
```

and replace

```ts
  UpdateStatus,
  WishInput,
```

with:

```ts
  UpdateStatus,
  UpcomingSet,
  UpcomingSets,
  WishInput,
```

**Constants** — replace:

```ts
const BASIC_LAND_TYPE = /^Basic .*Land/i;
```

with:

```ts
const BASIC_LAND_TYPE = /^Basic .*Land/i;

/** `upcoming_sets`' ceiling — the longest window Coming soon may ask about, in days. A
 *  hand-edited `config` cannot ask for the whole corpus. */
const MAX_UPCOMING_DAYS = 365;

/**
 * `upcoming_sets`' layout fence — the printings that are not a card a set is *previewing*: a
 * token, a double-faced token, an emblem and an art-series card.
 *
 * Where `sets` has rows the crate also drops four `set_type`s. **This fake has no `set_type`**
 * ({@link readHandlers.list_sets} answers `null` for it), which is the browser build's shape
 * exactly — there `sets` is never filled and this fence is the whole rule.
 */
const UPCOMING_SKIPPED_LAYOUTS: ReadonlySet<string> = new Set([
  "token",
  "double_faced_token",
  "emblem",
  "art_series",
]);
```

**The three read handlers** — replace:

```ts
        .sort((a, b) => cmp(a.name, b.name));
    },

    /**
     * `price_history::movers` — the owned printings whose price at `marketplace` moved most since
```

with:

```ts
        .sort((a, b) => cmp(a.name, b.name));
    },

    /**
     * `deck_completion::deck_completion` — owned against wanted for every deck, **counted the way
     * {@link readHandlers.deck_get} counts it** and then summed the way the editor's `deckStats`
     * sums it.
     *
     * **The measured list is the deck's kind's**: `theory` for a deck that keeps a plan, attributed
     * from {@link theoryPool}, and `live` otherwise, attributed from {@link ownedByPrinting} — the
     * same two pools `deck_get` picks between, handed to the same {@link attributeOwned} in the
     * same {@link deckReadOrder}, so one `(card_id, finish)` in two piles shares one pool. **Every
     * active pile counts**, sideboard and companion included — `deckStats`' `counted`, and
     * deliberately wider than {@link readHandlers.deck_values}' size pile.
     *
     * **A virtual deck answers no row**: it holds nothing by definition, and 0 % of every deck is
     * not a finding. Archived and empty decks answer one, ordered by id; which to draw is the
     * widget's decision.
     *
     * `missingCost` is `deckStats`' `missingPrice` exactly — `null` while nothing counted is priced
     * at this marketplace, else the priced rows' `unit × short` summed (so a complete, priced deck
     * answers `0`). `unpricedMissing` is missing **copies** with no price. The unit is
     * {@link deckPriceAt}, which is what this fake's deck rows quote — so a story's widget and the
     * editor it opens can never disagree.
     */
    deck_completion: (args: { marketplace?: MarketplaceId | null }): DeckCompletion[] => {
      const mp = marketplaceOf(args.marketplace);
      return [...db.decks]
        .filter((d) => !d.virtualOnly)
        .sort((a, b) => a.id - b.id)
        .map((d): DeckCompletion => {
          const list: DeckCompletion["list"] = d.theoryEnabled ? "theory" : "live";
          const rows = db.deckCards
            .filter((dc) => dc.deckId === d.id && dc.variant === list)
            .sort(deckReadOrder(db));
          const owned = attributeOwned(
            db,
            rows,
            list === "live" ? ownedByPrinting(db, d.id) : theoryPool(db, d.id),
          );
          const row: DeckCompletion = {
            deckId: d.id,
            list,
            wanted: 0,
            owned: 0,
            missing: 0,
            missingCost: null,
            unpricedMissing: 0,
          };
          for (const dc of rows) {
            // A switched-off pile counts toward nothing — `attributeOwned` already handed it no
            // copies, and it is not part of what the deck wants either.
            if (categoryById(db, dc.categoryId)?.isActive !== true) continue;
            const have = Math.min(owned.get(dc.id) ?? 0, dc.quantity);
            const short = dc.quantity - have;
            row.wanted += dc.quantity;
            row.owned += have;
            row.missing += short;
            const unit = deckPriceAt(db, cardById(db, dc.cardId), mp);
            if (unit === null) row.unpricedMissing += short;
            else row.missingCost = (row.missingCost ?? 0) + unit * short;
          }
          return row;
        });
    },

    /**
     * `deck_completion::deck_review_count` — how many `deck_cards` rows carry a sentence. Rows and
     * never copies: a flagged row of four is one thing to look at.
     */
    deck_review_count: (): number => db.deckCards.filter((dc) => dc.needsReview !== null).length,

    /**
     * `upcoming_sets::upcoming_sets` — every set with paper printings released after today and at
     * most `days` out, soonest first.
     *
     * **Today is {@link CLOCK_BASE}'s UTC day**, the fake's own, exactly as
     * {@link readHandlers.new_printings} measures from it — and it is answered, so the page counts
     * *in N days* from the same day the read used. `days` is clamped into `1..=`
     * {@link MAX_UPCOMING_DAYS}. A set answers its **earliest** card's date and the count of its
     * **distinct** collector numbers.
     *
     * `inDecks` is `new_printings`' defaults: distinct oracle ids held by decks that are not
     * virtual, in live and theory rows alike, basic lands left out — so a set reprinting the
     * Forests every deck holds is not "in your decks" on their account.
     */
    upcoming_sets: (args: { days: number }): UpcomingSets => {
      const days = Math.min(MAX_UPCOMING_DAYS, Math.max(1, Math.trunc(args.days) || 1));
      const today = dayOf(CLOCK_BASE);
      const until = dayOf(CLOCK_BASE + days * 86_400);
      const held = new Set<string>();
      for (const row of db.deckCards) {
        const deck = db.decks.find((d) => d.id === row.deckId);
        if (deck === undefined || deck.virtualOnly) continue;
        const card = cardById(db, row.cardId);
        if (card === null || card.oracleId === "") continue;
        if (BASIC_LAND_TYPE.test(card.typeLine ?? "")) continue;
        held.add(card.oracleId);
      }
      type Upcoming = {
        name: string;
        releasedAt: string;
        numbers: Set<string>;
        oracles: Set<string>;
      };
      const sets = new Map<string, Upcoming>();
      for (const card of db.cards) {
        if (!card.isPaper || UPCOMING_SKIPPED_LAYOUTS.has(card.layout)) continue;
        if (card.releasedAt <= today || card.releasedAt > until) continue;
        const set = sets.get(card.setCode) ?? {
          name: card.setName,
          releasedAt: card.releasedAt,
          numbers: new Set<string>(),
          oracles: new Set<string>(),
        };
        if (card.releasedAt < set.releasedAt) set.releasedAt = card.releasedAt;
        set.numbers.add(card.collectorNumber);
        if (held.has(card.oracleId)) set.oracles.add(card.oracleId);
        sets.set(card.setCode, set);
      }
      const answered: UpcomingSet[] = [...sets]
        .map(([code, set]) => ({
          code,
          name: set.name,
          releasedAt: set.releasedAt,
          previewed: set.numbers.size,
          inDecks: set.oracles.size,
        }))
        .sort((a, b) => cmp(a.releasedAt, b.releasedAt) || cmp(a.code, b.code));
      return { today, sets: answered };
    },

    /**
     * `price_history::movers` — the owned printings whose price at `marketplace` moved most since
```

`.storybook/fake/seeds.ts` — **the header**: replace ` * The six worlds a story can mount against.`
with ` * The worlds a story can mount against.` and replace:

```ts
 *   `combos_clear` puts one back. See {@link combosMissingSeed}. (The reason used to be that
 *   `combos::refresh_if_due` never fetched the file uninvited. It does since 2026-09-08, and the
 *   conclusion outlived the premise.)
 *
```

with:

```ts
 *   `combos_clear` puts one back. See {@link combosMissingSeed}. (The reason used to be that
 *   `combos::refresh_if_due` never fetched the file uninvited. It does since 2026-09-08, and the
 *   conclusion outlived the premise.)
 * * **`waiting`** — `needsReview` plus two copies in `Recently removed` and seven unreleased
 *   printings in three invented sets: the world the home page's To review and Coming soon widgets
 *   are storied in. See {@link waitingSeed}, including why it carries no scanner tray.
 *
```

**`SeedName`** — replace:

```ts
  | "paired"
  | "shared";
```

with:

```ts
  | "paired"
  | "shared"
  | "waiting";
```

**The world** — insert directly above
`/* ------------------------------------------------------------------ the switch --------- */`:

```ts
/* ------------------------------------------------------------------ waiting ------------ */

/**
 * `YYYY-MM-DD`, `days` after the fixture's today, in UTC — what `date('now', '+N days')` answers
 * and what `cards.released_at` holds. `db.ts`'s `dayOf` is the same arithmetic and is private to
 * that module.
 */
function dayAfter(days: number): string {
  return new Date((CLOCK_BASE + days * DAY) * 1_000).toISOString().slice(0, 10);
}

/**
 * Three sets Scryfall has started previewing and not yet released — **invented** names on **real**
 * rows, {@link largeCards}' split: every column of every printing is the corpus row it is cut from,
 * and only the set, the number, the date and the id are this seed's.
 *
 * Three rather than two so each of Coming soon's windows answers a different list — 30 days sees
 * `Foretold Frontiers` alone, 90 adds `Vigil of the Drowned`, a year adds `Lumen Reach` — and each
 * clause of a row's caption has a set that draws it and one that does not:
 *
 * * **`Foretold Frontiers`** — four previewed, **two in your decks**: Lightning Bolt and
 *   Counterspell, both in decks 1 and 2. Its Forest is held by every deck and is left out because
 *   it is a basic; its Emrakul is in no deck. The Counterspell lands three days after the rest, so
 *   the set answers its **earliest** date.
 * * **`Vigil of the Drowned`** — two previewed and **none** in a deck, so the caption's last clause
 *   is absent. Its Emrakul is the same oracle card as the first set's: a second set's reprint.
 * * **`Lumen Reach`** — one previewed, one in a deck (Sol Ring, decks 2 and 4).
 */
const UPCOMING_SETS: readonly {
  code: string;
  name: string;
  printings: readonly (readonly [setCode: string, collectorNumber: string, inDays: number])[];
}[] = [
  {
    code: "ftf",
    name: "Foretold Frontiers",
    printings: [
      ["2x2", "117", 12],
      ["mh2", "267", 15],
      ["unf", "239", 12],
      ["roe", "4", 12],
    ],
  },
  {
    code: "vgd",
    name: "Vigil of the Drowned",
    printings: [
      ["avr", "6", 40],
      ["roe", "4", 40],
    ],
  },
  { code: "lmr", name: "Lumen Reach", printings: [["c21", "263", 200]] },
];

/**
 * The unreleased printings themselves, cut from real rows.
 *
 * **Unpriced and unpictured, which is what a preview is**: Scryfall publishes no price before a
 * card is on sale, and `artCropUrl`/`normalUrl` are nulled so Live art falls back to the synthetic
 * frame naming *this* printing rather than drawing the picture of the one it was cut from. The
 * TCGplayer ids go for the same reason — an `Open on` link would name the template's product.
 * Ids are {@link synthId}'s third block, clear of `large`'s two.
 */
function upcomingCards(): FakeCard[] {
  const out: FakeCard[] = [];
  for (const set of UPCOMING_SETS) {
    set.printings.forEach(([setCode, collectorNumber, inDays], i) => {
      out.push({
        ...printing(setCode, collectorNumber),
        id: synthId(2, out.length),
        setCode: set.code,
        setName: set.name,
        collectorNumber: String(i + 1),
        releasedAt: dayAfter(inDays),
        prices:
          '{"eur":null,"eur_foil":null,"tix":null,"usd":null,"usd_etched":null,"usd_foil":null}',
        priceUsd: null,
        tcgplayerId: null,
        tcgplayerEtchedId: null,
        artCropUrl: null,
        normalUrl: null,
      });
    });
  }
  return out;
}

/**
 * `needsReview`, plus the two things the home page's To review and Coming soon widgets read that no
 * other world carries: **copies waiting in `Recently removed`** and **sets not yet released**.
 *
 * So To review has a count behind four of its five rows here — the flagged binder entry, the
 * flagged wish, the flagged deck card (all three `needsReview`'s) and the two removed copies — and
 * **the fifth, the scanner's tray, is deliberately not seeded**: that is {@link FakeDb.scannerTray}'s
 * rule, because a tray row is a card somebody scanned. A story that wants it writes `TRAY_ROWS` —
 * which already carries a Lightning Bolt still waiting on a printing — through `set_scanner_tray`,
 * `ScannerPage.stories.tsx`'s `Written` arrangement.
 *
 * **A seed of its own rather than rows added to `needsReview`**, {@link virtualDeckSeed}'s reason:
 * seven more `cards` rows move every count over the corpus in every story that world serves, and a
 * Recently removed row changes that folder's card on every collection story. **`cards` is a new
 * array**, never a push onto the shared one — every other world holds `CARDS` by reference.
 */
function waitingSeed(): FakeDb {
  const db = needsReviewSeed();
  db.cards = [...db.cards, ...upcomingCards()];
  const removed = db.collectionFolders.find((f) => f.kind === "removed");
  if (removed === undefined) throw new Error("the starter world has no Recently removed folder");
  // Two copies a cut filed away — what `deck_to_collection` leaves behind — so the To review row
  // says `2 copies`, and the folder answers a summary row at all: an empty folder answers none.
  db.collectionEntries.push(
    entry(db.collectionEntries.length + 1, printing("2ed", "48"), "nonfoil", "NM", 2, {
      folderId: removed.id,
    }),
  );
  return db;
}

```

**The switch** — replace:

```ts
    case "shared":
      return sharedSeed();
```

with:

```ts
    case "shared":
      return sharedSeed();
    case "waiting":
      return waitingSeed();
```

`.storybook/CLAUDE.md` — replace:

```markdown
  **Nine** seeds
  (`empty`/`starter`/`needsReview`/`large`/`bracketMismatch`/`combosMissing`/`paired`/
  `virtualDeck`/`shared`),
```

with:

```markdown
  **Ten** seeds
  (`empty`/`starter`/`needsReview`/`large`/`bracketMismatch`/`combosMissing`/`paired`/
  `virtualDeck`/`shared`/`waiting`),
```

and insert directly above the line `  **Re-count this list when you add one** — it said "four" for three faults' worth of`:

```markdown
  **`waiting` is `needsReview` plus two copies in `Recently removed` and seven unreleased
  printings in three invented sets** — the home page's To review and Coming soon world. The
  printings are real corpus rows re-dated past `CLOCK_BASE`, `large`'s derive-don't-write rule, and
  **the seed carries no scanner tray**, `FakeDb.scannerTray`'s rule: a story that wants the tray's
  row writes `TRAY_ROWS` through `set_scanner_tray` first, as `ScannerPage.stories.tsx` does.
  A seed of its own for `virtualDeck`'s reason — seven more `cards` rows would move every count in
  every story `needsReview` serves.
```

- [ ] **Step 4: Run them to see them pass**

Run:
- `npx vitest run src/lib/ipc.test.ts`
- `npx vitest run src/features/home/keys.test.tsx`
- `npx vitest run .storybook/fake/db.test.ts -t "deck completion|deck review count|upcoming sets|the waiting world|deck values"`
- `npx vitest run .storybook/fake/world.test.ts`

Expected: all pass. `deck values` is re-run beside the new blocks because it shares the helpers the
new cases lean on; it must be unchanged.

- [ ] **Step 5: Typecheck** (both programs — `.storybook` is type-checked by its own)

Run: `npx tsc --noEmit -p .`
Run: `npx tsc --noEmit -p .storybook`
Run: `npx eslint src/lib/ipc.ts src/features/home/keys.ts .storybook/fake/db.ts .storybook/fake/seeds.ts`
Expected: no errors. `world.test.ts`' `ALL_SEEDS` is a `satisfies Record<SeedName, true>`, so
forgetting `waiting: true` there is a `tsc` error here rather than a silent skip.

---


## Wave 3 — the widget bodies (Tasks 7-10 in parallel), then the wiring (Task 11)

## Lane W — the four widget bodies, and the page's wiring

**Wave 3 runs W1 ‖ W2 ‖ W3 ‖ W4 in parallel in one worktree; W5 runs after all four.** Each of
W1–W4 touches exactly its own three files (`*Widget.tsx`, `*Widget.test.tsx`,
`*Widget.stories.tsx`) under `src/features/home/widgets/`, and **no widget task edits
`HomePage.tsx`** — that file is W5's alone. No task in this lane runs `git add`, `git commit` or
`npm run verify`; each runs its own one vitest file and `tsc`, and the controller commits by path.

What the lane consumes from the foundation (F1–F3), by the contract's names:

- `src/lib/ipc.ts`: `DeckCompletion`, `UpcomingSet`, `UpcomingSets`, `ipc.deckCompletion(marketplace: MarketplaceId)`,
  `ipc.deckReviewCount()`, `ipc.upcomingSets(days: number)`.
- `src/features/home/keys.ts`: `deckCompletionKey(marketplace)`, `upcomingSetsKey(days)`,
  `deckReviewCountKey`, `wishlistReviewCountKey`, `wishlistSavingsKey(marketplace)`,
  `scannerTrayCountKey` (the four without parentheses are `QueryKey` constants).
- `src/lib/store.ts`: `setPendingReviewFilter`, `setPendingSettingsGroup`, `setPendingOptimize`
  and their three fields, all inside `setActiveView`'s clear block.
- `src/features/wishlist/wholeWishlistQuery.ts`: `wholeWishlistQuery(marketplace: MarketplaceId): WishlistQuery`.
- `src/features/home/widgets.ts`: the four `WIDGET_META` rows — `deckCompletion` picks `scope`
  (`recent`, `pinned`) and `order` (`done`, `cheapest`, `name`), toggle `complete` (`dflt: false`,
  label `Complete decks`); `toReview` toggle `removed`; `comingSoon` pick `window` (30/90/365,
  `dflt: 90`).
- `.storybook/fake/db.ts`: handlers for `deck_completion`, `deck_review_count`, `upcoming_sets`.

**Before every task:** read `src/CLAUDE.md` and `.storybook/CLAUDE.md` (they load when you touch
the files), and invoke the `frontend-design` skill once. Money is `formatPrice(value, currency)`
with the currency from `useMarketplace()`; dim text is `text-dim`; nothing here adds a z-index, a
`@container` or an interpolated class name.

---

### Task 7 (W1): Deck completion (`DeckCompletionWidget`)

Spec §3.2. **A deck is complete when `missing === 0`, and never because of its money.**
`missingCost` is `null` only when nothing on the deck's measured list is priced
(`DeckStats.tsx:497-509`'s rule, which the Rust read mirrors); a deck whose only missing copies are
unpriced answers `missingCost: 0` with `missing > 0` and `unpricedMissing > 0`. So the `Complete
decks` switch, the footer's `N decks complete` and the `Every deck here is complete` sentence all
key on `missing === 0`; the row's value is an em dash exactly when `missingCost` is `null`; and the
unpriced hint shows whenever `unpricedMissing > 0`.

**Files:**
- Create: `src/features/home/widgets/DeckCompletionWidget.tsx`
- Test: `src/features/home/widgets/DeckCompletionWidget.test.tsx`
- Create: `src/features/home/widgets/DeckCompletionWidget.stories.tsx`

**Interfaces:**
- Consumes: `ipc.deckList()`, `ipc.deckCompletion(marketplace.id)`, `deckListKey`,
  `deckCompletionKey(marketplace.id)`, `useMarketplace()`, `useAppStore`'s `setActiveView` and
  `setOpenDeckId`, `DecksWidget`'s exported `deckScope`, `pinnedDeckIds`, `decksToShow`
  (`DecksWidget.tsx:128-175`), `pickOf` / `toggleOnOf` (`widgetSettings.ts:48-76`),
  `widgetMeta("deckCompletion")`.
- Produces:
  ```ts
  export type CompletionOrder = "done" | "cheapest" | "name";
  export type CompletionRow = DeckCompletion & { name: string };
  export interface CompletionFooter { complete: number; cost: number | null; unpriced: number; text: string }
  export function completionRows(decks: readonly DeckRow[], completions: readonly DeckCompletion[], scope: "recent" | "pinned", deckIds: readonly number[]): CompletionRow[];
  export function sortCompletions(rows: readonly CompletionRow[], order: CompletionOrder): CompletionRow[];
  export function completionFooter(rows: readonly CompletionRow[], currency: Currency): CompletionFooter;
  export function countCaption(row: DeckCompletion): string;
  export function rowHint(row: DeckCompletion, marketplace: Marketplace): string | undefined;
  export const NO_DECKS: string; export const NOTHING_PINNED: string; export const ALL_COMPLETE: string;
  export function DeckCompletionWidget(props: WidgetBodyProps): ReactElement;
  ```
  `HomePage.tsx` (Task W5) draws `DecksWidgetSettings` as this kind's `extraSettings`; this task
  does not touch that file.

- [ ] **Step 1: Write the failing test**

Create `src/features/home/widgets/DeckCompletionWidget.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeckCompletion, DeckRow, HomeWidget } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The two reads this widget makes, in front of an **intact** mirror — `DecksWidget.test.tsx`'s
 * note: the module and the `ipc` object are both spread from the original, so every other command
 * stays real and a struct that grew a field fails under `tsc` rather than inside a render. Each
 * stub is typed against its own signature for the same reason.
 *
 * The cases that have data seed the cache through the widget's **exported** keys, so a seeded
 * answer only reaches the screen if the body reads the key it claims to. The stubs are for what a
 * cache cannot hold: a read still out, a read refused, and the refetch a bridge or a marketplace
 * switch causes.
 */
const deckList = vi.hoisted(() => vi.fn<() => Promise<DeckRow[]>>());
const deckCompletion = vi.hoisted(() =>
  vi.fn<(marketplace: MarketplaceId) => Promise<DeckCompletion[]>>(),
);
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, deckList, deckCompletion } };
});

import { DEFAULT_MARKETPLACE, MARKETPLACES } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { deckCompletionKey, deckListKey } from "../keys";
import type { Density } from "../widgetSettings";
import {
  ALL_COMPLETE,
  completionFooter,
  completionRows,
  DeckCompletionWidget,
  NO_DECKS,
  NOTHING_PINNED,
  rowHint,
  sortCompletions,
  type CompletionRow,
} from "./DeckCompletionWidget";

/** A deck row, annotated so the mirror checks the fixture — `DecksWidget.test.tsx`'s factory. */
function deck(over: Partial<DeckRow> & { id: number; name: string }): DeckRow {
  return {
    formatKey: "modern",
    formatName: "Modern",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 60,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    managedWishlist: "off",
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    tokenStack: false,
    statsOpen: true,
    ...over,
  };
}

/**
 * One deck's answer. The default is a **complete, priced** deck — `missingCost: 0` and not `null`,
 * because `null` means *nothing on the list is priced at all* (`DeckStats.tsx:497-509`), which is a
 * different deck.
 */
function completion(over: Partial<DeckCompletion> & { deckId: number }): DeckCompletion {
  return {
    list: "live",
    wanted: 60,
    owned: 60,
    missing: 0,
    missingCost: 0,
    unpricedMissing: 0,
    ...over,
  };
}

function row(name: string, over: Partial<DeckCompletion> & { deckId: number }): CompletionRow {
  return { ...completion(over), name };
}

const BURN = deck({ id: 1, name: "Burn" });
const ATRAXA = deck({ id: 2, name: "Atraxa", formatKey: "commander", cardCount: 100 });
const MONO = deck({ id: 3, name: "Mono Red" });
const SHELF = deck({ id: 4, name: "Old Shelf", archived: true });
const PROXIES = deck({ id: 5, name: "Proxy Pile", virtualOnly: true });

const BURN_AT = completion({ deckId: 1, owned: 56, missing: 4, missingCost: 12.5 });
const ATRAXA_AT = completion({ deckId: 2, wanted: 100, owned: 40, missing: 60, missingCost: 209.2 });
const MONO_AT = completion({ deckId: 3 });
const SHELF_AT = completion({ deckId: 4, owned: 10, missing: 50, missingCost: 5 });
// No answer for the virtual deck: `deck_completion` answers none (spec §3.1).

const DECKS = [BURN, ATRAXA, MONO, SHELF, PROXIES];
const ANSWERS = [BURN_AT, ATRAXA_AT, MONO_AT, SHELF_AT];

function widget(config: unknown = null): HomeWidget {
  return { id: "deckCompletion", kind: "deckCompletion", x: 0, y: 0, w: 3, h: 3, config };
}

/** The box a widget is told it is drawn in, at the grid's target cell. */
function fitFor(w: number, h: number, density: Density = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density });
}

/** Room for every fixture below, one list column, and a footer (three cells wide is tier 1). */
const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(decks: readonly DeckRow[], answers: readonly DeckCompletion[]) {
  qc.setQueryData(deckListKey, decks);
  qc.setQueryData(deckCompletionKey(DEFAULT_MARKETPLACE), answers);
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <DeckCompletionWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** Every row's accessible name, in drawn order — which rows, and what order, in one assertion. */
function rowNames(): string[] {
  return screen
    .queryAllByRole("button")
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((name) => name !== "");
}

const deckNames = () => rowNames().map((name) => name.split(" · ")[0]);

beforeEach(() => {
  deckList.mockReset().mockResolvedValue([]);
  deckCompletion.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  // The store is module-level and leaks between tests; the press cases replace two actions.
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("sortCompletions", () => {
  const alpha = row("Alpha", { deckId: 1, wanted: 10, owned: 5, missing: 5, missingCost: 3 });
  const beta = row("Beta", {
    deckId: 2,
    wanted: 10,
    owned: 5,
    missing: 5,
    missingCost: null,
    unpricedMissing: 5,
  });
  const gamma = row("Gamma", { deckId: 3, wanted: 10, owned: 10 });
  const delta = row("Delta", { deckId: 4, wanted: 10, owned: 9, missing: 1, missingCost: 40 });

  it("orders nearest done first, settling a tie by name", () => {
    expect(sortCompletions([beta, alpha, delta, gamma], "done").map((r) => r.name)).toEqual([
      "Gamma",
      "Delta",
      "Alpha",
      "Beta",
    ]);
  });

  /** A complete deck costs nothing to finish, so it leads; a deck nothing is priced in trails. */
  it("orders cheapest to finish, a complete deck first and an unpriced one last", () => {
    expect(sortCompletions([beta, delta, alpha, gamma], "cheapest").map((r) => r.name)).toEqual([
      "Gamma",
      "Alpha",
      "Delta",
      "Beta",
    ]);
  });

  it("orders by name through the app's one collator", () => {
    expect(sortCompletions([gamma, delta, beta, alpha], "name").map((r) => r.name)).toEqual([
      "Alpha",
      "Beta",
      "Delta",
      "Gamma",
    ]);
  });

  it("reads a deck that asks for nothing as done, and never sorts the cached array in place", () => {
    const empty = row("Empty", { deckId: 5, wanted: 0, owned: 0 });
    const input = [alpha, empty];
    expect(sortCompletions(input, "done").map((r) => r.name)).toEqual(["Empty", "Alpha"]);
    expect(input.map((r) => r.name)).toEqual(["Alpha", "Empty"]);
  });
});

describe("completionFooter", () => {
  const done = row("Done", { deckId: 1 });
  const short = row("Short", { deckId: 2, owned: 56, missing: 4, missingCost: 12.5 });
  const nothingPriced = row("Tokens", {
    deckId: 3,
    wanted: 40,
    owned: 0,
    missing: 40,
    missingCost: null,
    unpricedMissing: 40,
  });
  /** The coordinator's case: missing copies, all of them unpriced, over a list that is priced. */
  const unpricedGap = row("Proxy Night", {
    deckId: 4,
    owned: 57,
    missing: 3,
    missingCost: 0,
    unpricedMissing: 3,
  });

  it("counts the complete decks and prices the rest", () => {
    expect(completionFooter([done, short], "usd")).toEqual({
      complete: 1,
      cost: 12.5,
      unpriced: 0,
      text: "1 deck complete · $12.50 to finish the rest",
    });
  });

  it("says every deck when none is complete", () => {
    expect(completionFooter([short], "usd").text).toBe("$12.50 to finish every deck here");
  });

  /**
   * **`missing === 0` is what complete means, never the money.** A deck whose missing copies are
   * all unpriced answers `missingCost: 0` — it is short three cards and is not complete, and its
   * three copies are said as unpriced rather than summed as nothing.
   */
  it("counts a deck short only unpriced copies as not complete, and says the copies", () => {
    expect(completionFooter([done, unpricedGap], "usd")).toEqual({
      complete: 1,
      cost: 0,
      unpriced: 3,
      text: "1 deck complete · $0.00 to finish the rest · 3 copies unpriced",
    });
  });

  it("adds nothing for a deck nothing is priced in, and says its copies", () => {
    expect(completionFooter([short, nothingPriced], "eur")).toEqual({
      complete: 0,
      cost: 12.5,
      unpriced: 40,
      text: "€12.50 to finish every deck here · 40 copies unpriced",
    });
  });

  it("has no cost when every deck is complete, and nothing to say about nothing", () => {
    expect(completionFooter([done], "usd")).toEqual({
      complete: 1,
      cost: null,
      unpriced: 0,
      text: "1 deck complete",
    });
    expect(completionFooter([], "usd").text).toBe("");
  });
});

describe("rowHint", () => {
  const tcg = MARKETPLACES.tcgplayer;

  it("says nothing about a deck whose missing copies are all priced", () => {
    expect(rowHint(completion({ deckId: 1, missing: 4, missingCost: 12.5 }), tcg)).toBeUndefined();
  });

  it("says which copies the figure leaves out", () => {
    expect(
      rowHint(completion({ deckId: 1, missing: 4, missingCost: 9, unpricedMissing: 1 }), tcg),
    ).toBe("1 missing copy with no price at TCGplayer is not in this figure.");
    expect(
      rowHint(completion({ deckId: 1, missing: 3, missingCost: 0, unpricedMissing: 3 }), tcg),
    ).toBe("3 missing copies with no price at TCGplayer are not in this figure.");
  });

  it("says when nothing on the list is priced at all", () => {
    expect(
      rowHint(completion({ deckId: 1, missing: 40, missingCost: null, unpricedMissing: 40 }), tcg),
    ).toBe("Nothing on this deck's list has a price at TCGplayer.");
  });

  it("says a theory deck is measured against its plan", () => {
    expect(rowHint(completion({ deckId: 1, list: "theory" }), tcg)).toMatch(
      /^Measured against this deck's theory list/,
    );
  });
});

describe("completionRows", () => {
  it("keeps deck_list's order, leaves archived and virtual decks out, and drops an unanswered deck", () => {
    const answers = [SHELF_AT, MONO_AT, BURN_AT];
    expect(completionRows(DECKS, answers, "recent", []).map((r) => r.name)).toEqual([
      "Burn",
      "Mono Red",
    ]);
  });

  it("keeps a pinned archived deck, and drops a pin to a virtual deck", () => {
    expect(completionRows(DECKS, ANSWERS, "pinned", [4, 5, 2]).map((r) => r.name)).toEqual([
      "Old Shelf",
      "Atraxa",
    ]);
  });
});

describe("DeckCompletionWidget", () => {
  describe("what it draws", () => {
    it("draws a row per deck in scope, nearest done first, with its count, cost and track", () => {
      seed(DECKS, ANSWERS);

      draw();

      // Most recent, complete decks off: the archived shelf, the virtual pile and the complete
      // deck are all out.
      expect(deckNames()).toEqual(["Burn", "Atraxa"]);
      const burn = screen.getByRole("button", { name: /^Burn/ });
      expect(burn).toHaveAccessibleName("Burn · 56 of 60 · 4 missing · $12.50");
      expect(within(burn).getByText("56 of 60 · 4 missing")).toBeInTheDocument();
      expect(within(burn).getByText("$12.50")).toBeInTheDocument();
      // 56 of 60 is 93.3%, floored so a track never reaches its end before the deck does.
      expect(burn.querySelector(".bg-accent")).toHaveStyle({ width: "93%" });
    });

    /** The footer is about every deck in scope, not about the rows that fit. */
    it("counts a complete deck in the footer instead of listing it", () => {
      seed(DECKS, ANSWERS);

      draw();

      expect(screen.getByText("1 deck complete · $221.70 to finish the rest")).toBeInTheDocument();
      expect(screen.queryByText("Mono Red")).toBeNull();
    });

    it("lists complete decks when the switch is on, with no money to show", () => {
      seed(DECKS, ANSWERS);

      draw({ complete: true });

      expect(deckNames()).toEqual(["Mono Red", "Burn", "Atraxa"]);
      const mono = screen.getByRole("button", { name: /^Mono Red/ });
      expect(mono).toHaveAccessibleName("Mono Red · 60 of 60 · complete");
      expect(within(mono).queryByText("$0.00")).toBeNull();
    });

    it("orders by the reader's pick", () => {
      seed(DECKS, ANSWERS);

      draw({ order: "name", complete: true });

      expect(deckNames()).toEqual(["Atraxa", "Burn", "Mono Red"]);
    });

    it("draws the pinned decks, an archived pin included", () => {
      seed(DECKS, ANSWERS);

      draw({ scope: "pinned", deckIds: [4, 2] });

      // Nearest done: Atraxa has 40 of 100, the shelf 10 of 60.
      expect(deckNames()).toEqual(["Atraxa", "Old Shelf"]);
    });

    /** `null` is *nothing priced*, and the only case that draws an em dash. */
    it("draws an em dash for a deck nothing on whose list is priced", () => {
      const tokens = deck({ id: 6, name: "Tokens" });
      seed([tokens], [
        completion({ deckId: 6, wanted: 40, owned: 0, missing: 40, missingCost: null, unpricedMissing: 40 }),
      ]);

      draw();

      expect(screen.getByRole("button", { name: /^Tokens/ })).toHaveAccessibleName(
        "Tokens · 0 of 40 · 40 missing · —",
      );
    });

    /**
     * **Short three copies, none of them priced, on a priced list** — `missingCost: 0`. The deck is
     * listed with the switch off (it is not complete), its figure is the `$0.00` the editor's own
     * arithmetic answers, and the footer says the three copies rather than summing them as nothing.
     */
    it("lists a deck short only unpriced copies, and says them in the footer", () => {
      const proxies = deck({ id: 7, name: "Proxy Night" });
      seed([proxies, MONO], [
        completion({ deckId: 7, owned: 57, missing: 3, missingCost: 0, unpricedMissing: 3 }),
        MONO_AT,
      ]);

      draw();

      expect(deckNames()).toEqual(["Proxy Night"]);
      expect(screen.getByRole("button", { name: /^Proxy Night/ })).toHaveAccessibleName(
        "Proxy Night · 57 of 60 · 3 missing · $0.00",
      );
      expect(
        screen.getByText("1 deck complete · $0.00 to finish the rest · 3 copies unpriced"),
      ).toBeInTheDocument();
    });

    it("moves the shortfall under the name on a two-cell tile", () => {
      seed([BURN], [BURN_AT]);

      draw(null, { fit: fitFor(2, 3) });

      const burn = screen.getByRole("button", { name: /^Burn/ });
      expect(burn).toHaveTextContent("Burn4 missing · $12.50");
      expect(screen.queryByText("56 of 60 · 4 missing")).toBeNull();
      // A tile is too narrow for the footer.
      expect(screen.queryByText(/to finish/)).toBeNull();
    });

    it("drops the caption on a compact card and keeps the cost", () => {
      seed([BURN], [BURN_AT]);

      draw(null, { fit: fitFor(3, 3, "compact") });

      expect(screen.queryByText("56 of 60 · 4 missing")).toBeNull();
      expect(screen.getByText("$12.50")).toBeInTheDocument();
    });

    it("cuts the list to the rows the box holds", () => {
      const many = Array.from({ length: 12 }, (_, i) => deck({ id: 100 + i, name: `Deck ${i}` }));
      seed(
        many,
        many.map((d) => completion({ deckId: d.id, owned: 50, missing: 10, missingCost: 4 })),
      );
      const fit = fitFor(3, 3);

      draw(null, { fit });

      // A captioned row with a track is 57px, and the footer takes 22 before rows are counted.
      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(57, 22));
    });
  });

  describe("the states", () => {
    it("says it is measuring while a read is out", () => {
      qc.setQueryData(deckListKey, DECKS);
      deckCompletion.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Measuring your decks…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      qc.setQueryData(deckListKey, DECKS);
      deckCompletion.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not measure your decks — The database is busy."),
      ).toBeInTheDocument();
    });

    it("says there is nothing to measure when there are no decks", () => {
      seed([], []);

      draw();

      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
    });

    it("says there is nothing to measure when every deck is archived or virtual", () => {
      seed([SHELF, PROXIES], [SHELF_AT]);

      draw();

      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
    });

    it("points at the settings when Pinned has nothing pinned", () => {
      seed(DECKS, ANSWERS);

      draw({ scope: "pinned" });

      expect(screen.getByText(NOTHING_PINNED)).toBeInTheDocument();
      expect(rowNames()).toEqual([]);
    });

    it("says every deck is complete when the switch is off and nothing is short", () => {
      seed([MONO], [MONO_AT]);

      draw();

      expect(screen.getByText(ALL_COMPLETE)).toBeInTheDocument();
      expect(ALL_COMPLETE).toContain("Complete decks");
    });
  });

  describe("opening a deck", () => {
    /** `setActiveView` clears `openDeckId` on the way in, so the view is written first. */
    it("opens the deck it was pressed on, view first and id second", async () => {
      const user = userEvent.setup();
      const writes: string[] = [];
      const { setActiveView, setOpenDeckId } = useAppStore.getState();
      useAppStore.setState({
        setActiveView: (view) => {
          writes.push(`view:${view}`);
          setActiveView(view);
        },
        setOpenDeckId: (id) => {
          writes.push(`deck:${id}`);
          setOpenDeckId(id);
        },
      });
      seed(DECKS, ANSWERS);
      draw();

      await user.click(screen.getByRole("button", { name: /^Atraxa/ }));

      expect(writes).toEqual(["view:decks", "deck:2"]);
      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(2);
    });

    it("draws a still body with no presses", () => {
      seed(DECKS, ANSWERS);

      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Burn")).toBeInTheDocument();
    });
  });

  /**
   * **A switch re-issues the read.** The marketplace is in the key, so the card says it is
   * measuring rather than drawing the last marketplace's figure beside the new one's symbol.
   */
  it("measures again at a new marketplace rather than relabelling the old figure", async () => {
    seed(DECKS, ANSWERS);
    qc.setQueryData(MARKETPLACE_KEY, "cardmarket");
    deckCompletion.mockResolvedValue([
      completion({ deckId: 1, owned: 56, missing: 4, missingCost: 9.5 }),
    ]);

    draw();

    expect(screen.getByText("Measuring your decks…")).toBeInTheDocument();
    expect(screen.queryByText("$12.50")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Burn · 56 of 60 · 4 missing · €9.50" }),
    ).toBeInTheDocument();
    expect(deckCompletion).toHaveBeenCalledWith("cardmarket");
  });

  /**
   * **Owned copies are collection rows**, and a binder write invalidates `["collection"]` and
   * nothing under `["decks"]` — so the widget bridges the one root itself (`ActivityWidget`'s
   * mechanism).
   */
  describe("staying fresh", () => {
    it("measures again when a collection write invalidates its root", async () => {
      seed([BURN], [BURN_AT]);
      deckCompletion.mockResolvedValue([
        completion({ deckId: 1, owned: 58, missing: 2, missingCost: 6 }),
      ]);
      draw();
      expect(deckCompletion).not.toHaveBeenCalled();

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["collection"] });
      });

      expect(
        await screen.findByRole("button", { name: "Burn · 58 of 60 · 2 missing · $6.00" }),
      ).toBeInTheDocument();
    });

    it("leaves the read alone when an unrelated root is invalidated", async () => {
      seed([BURN], [BURN_AT]);
      draw();

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["cards", "search"] });
      });

      expect(deckCompletion).not.toHaveBeenCalled();
    });

    it("does not bridge from a still body", async () => {
      seed([BURN], [BURN_AT]);
      draw(null, { still: true });

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["collection"] });
      });

      expect(deckCompletion).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/home/widgets/DeckCompletionWidget.test.tsx`
Expected: FAIL — `Failed to resolve import "./DeckCompletionWidget"` (the module does not exist).

- [ ] **Step 3: Implement**

Create `src/features/home/widgets/DeckCompletionWidget.tsx`:

```tsx
/**
 * How much of each deck the reader already owns, and what the rest would cost — a row per deck,
 * with a track under the name and the missing cards' price at the right.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the `Order` chip, the settings popover and
 * the Customize tray; this draws the rows and the footer, cut to the box `fit` describes. The
 * `Pinned` checklist at the foot of the popover is `DecksWidgetSettings`, **reused rather than
 * copied** — `HomePage.tsx`'s `renderExtraSettings` hands it to this kind — which is why the scope
 * and the pins are read through `DecksWidget`'s own `deckScope` and `pinnedDeckIds`: the checklist
 * writes exactly what those two read.
 *
 * ## Owned is the deck editor's word, and Rust's
 *
 * `deck_completion` answers one row per non-virtual deck with the editor's own arithmetic — a live
 * deck against its own group, a theory deck's plan against every copy it can use, every active
 * pile, exact printing and exact finish (spec §3.1, fenced in Rust against `get_deck`). **Nothing
 * here re-derives a count.** A card saying "4 missing" about a deck that opens saying "6 missing"
 * is a bug report, so this file draws the numbers it is handed and decides only which decks, in
 * what order, and how many fit.
 *
 * **Complete is `missing === 0` and nothing else.** `missingCost` is `null` only when nothing on
 * the measured list is priced (`DeckStats.tsx:497-509`), and a deck short only unpriced copies
 * answers `0` — so money never decides whether a deck is done, an em dash is drawn exactly for
 * `null`, and {@link rowHint} says which copies a figure leaves out.
 *
 * ## Which decks is a filter; order is a display decision
 *
 * `Most recent` is `deck_list`'s own order with archived and virtual decks taken out — a filter,
 * never a sort, `DecksWidget`'s rule. `Pinned` is the reader's `deckIds`. {@link sortCompletions}
 * then orders what is left, because the registry's three orders are three readings of one answer
 * (`SetCompletionWidget.sortSets`' argument) and a command per order would be three places one
 * count is written. Every tie is settled by name through `sortOptions`.
 *
 * ## Complete decks, and the footer
 *
 * A deck missing nothing leaves the list unless the reader turns `Complete decks` on, and is counted
 * in the footer either way. **The footer is a statement about every deck in scope, never about the
 * rows the box had room for**, so a card resized smaller does not change what "$221.70 to finish
 * the rest" is a total of. See {@link completionFooter}.
 *
 * ## Staying fresh: one bridge, from `["collection"]`
 *
 * The key sits under `["decks"]`, which every deck write already invalidates. **But owned copies
 * are collection rows**, and a quantity stepped in the binder invalidates `["collection"]` and
 * nothing else — so a deck's shortfall would go stale under the reader's hand.
 * {@link useCollectionBridge} is `ActivityWidget`'s bridge, one root wide: a marker query under
 * `["collection"]` so an invalidation of that root always has something to match, and a cache
 * subscription that turns one into an invalidation of this key. Off on a `still` body.
 *
 * ## Money
 *
 * `missingCost` is priced at the marketplace in the key, so a switch re-issues the read and the
 * card says it is measuring rather than drawing the last marketplace's figure beside the new
 * one's symbol.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useEffect, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { plural } from "@/lib/counts";
import { ipc, ipcError, type DeckCompletion, type DeckRow } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE, type Currency, type Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";

import { deckCompletionKey, deckListKey } from "../keys";
import { WidgetFooter, WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";
import { deckScope, decksToShow, pinnedDeckIds } from "./DecksWidget";

/** The three orders the registry's `order` pick offers. */
export type CompletionOrder = "done" | "cheapest" | "name";

/** One deck's answer with the name it is drawn under. `deck_completion` carries ids only; the name
 *  is `deck_list`'s, joined here, so a rename lands with the gallery's own refetch. */
export type CompletionRow = DeckCompletion & { name: string };

/**
 * A row's height — `SetCompletionWidget.tsx:55-57`'s sum (36 bare, +15 a caption, +6 the track),
 * and this kind always draws its track. **Asked of the row actually drawn**, for that function's
 * reason: a tile moves its figure under the name, so it is a captioned row whatever its density.
 */
function rowPx(caption: boolean): number {
  return 36 + (caption ? 15 : 0) + 6;
}

/** The footer's line and the gap above it — `DecksWidget.tsx:92`'s `FOOTER_ROOM`. */
const FOOTER_ROOM = 22;

/** The bridge's marker segment — a word no other reader of `["collection"]` uses, so nothing that
 *  matches by prefix (`setQueriesData(["collection", "list"])`) can reach it. */
const BRIDGE_MARKER = "homeDeckCompletion";

const PENDING = "Measuring your decks…";
export const NO_DECKS =
  "No decks to measure — build one on the Decks page. Archived and virtual decks are left out here.";
/** `DecksWidget`'s sentence, for its reason: the chip reads `Pinned`, so drawing the recent decks
 *  under it would be the card claiming something it is not doing. */
export const NOTHING_PINNED =
  "No decks pinned yet — choose them in this card's settings under Customize.";
/** Names the switch by the registry's own label, so the sentence cannot point at a renamed row. */
export const ALL_COMPLETE = `Every deck here is complete — turn on ${completeWord()} in this card's settings to list them.`;

function completeWord(): string {
  return (
    widgetMeta("deckCompletion").toggles.find((toggle) => toggle.key === "complete")?.label ??
    "Complete decks"
  );
}

function orderOf(value: string | number | undefined): CompletionOrder {
  return value === "cheapest" || value === "name" ? value : "done";
}

/** How much of the deck is held, `0..=1`. A deck that asks for nothing is done. */
function share(row: DeckCompletion): number {
  return row.wanted <= 0 ? 1 : Math.min(1, row.owned / row.wanted);
}

/**
 * The decks in scope, each with its answer — `deck_list`'s order, filtered.
 *
 * `decksToShow` is `DecksWidget`'s own judgement (archived out under `recent`, the reader's order
 * and no duplicates under `pinned`), and a virtual deck is taken out here as well as by the join:
 * Rust answers no row for one, and saying so twice is what keeps a future answer from drawing a
 * pile that owns nothing by definition. **A deck with no answer is dropped in silence** — the
 * beat between a deck being created and this read refetching.
 */
export function completionRows(
  decks: readonly DeckRow[],
  completions: readonly DeckCompletion[],
  scope: "recent" | "pinned",
  deckIds: readonly number[],
): CompletionRow[] {
  const byDeck = new Map(completions.map((answer) => [answer.deckId, answer]));
  const rows: CompletionRow[] = [];
  for (const deck of decksToShow(decks, scope, deckIds)) {
    if (deck.virtualOnly) continue;
    const answer = byDeck.get(deck.id);
    if (answer !== undefined) rows.push({ ...answer, name: deck.name });
  }
  return rows;
}

/**
 * The rows in the reader's order. `sortOptions` copies, so the cached array is never sorted in
 * place, and its collator settles every tie by name.
 *
 * `cheapest`: a complete deck costs nothing to finish and leads; then the priced ones ascending;
 * then a deck nothing is priced in (`null`), last — spec §3.2.
 */
export function sortCompletions(
  rows: readonly CompletionRow[],
  order: CompletionOrder,
): CompletionRow[] {
  switch (order) {
    case "name":
      return sortOptions(rows, (row) => row.name);
    case "cheapest":
      return sortOptions(
        rows,
        (row) => row.name,
        (row) =>
          row.missing === 0 ? [0, 0] : row.missingCost === null ? [2, 0] : [1, row.missingCost],
      );
    case "done":
      return sortOptions(
        rows,
        (row) => row.name,
        (row) => [-share(row)],
      );
  }
}

/** The footer's facts and its sentence. */
export interface CompletionFooter {
  /** Decks in scope missing nothing. */
  complete: number;
  /** What the priced missing copies of the rest cost, or `null` when none of them is priced. */
  cost: number | null;
  /** Missing copies across the rest with no price at this marketplace. */
  unpriced: number;
  /** `2 decks complete · $221.70 to finish the rest · 3 copies unpriced`, or `""`. */
  text: string;
}

/**
 * The line under the rows — over **every deck in scope**, never over the rows that fit.
 *
 * Complete is `missing === 0`. The cost sums every incomplete deck's `missingCost` that is not
 * `null`; the unpriced copies are counted beside it at the same marketplace and never summed as
 * zero, so a deck short only unpriced copies adds `$0.00` and says its copies.
 */
export function completionFooter(
  rows: readonly CompletionRow[],
  currency: Currency,
): CompletionFooter {
  let complete = 0;
  let cost: number | null = null;
  let unpriced = 0;
  for (const row of rows) {
    if (row.missing === 0) {
      complete += 1;
      continue;
    }
    if (row.missingCost !== null) cost = (cost ?? 0) + row.missingCost;
    unpriced += row.unpricedMissing;
  }
  const parts: string[] = [];
  if (complete > 0) parts.push(`${plural(complete, "deck")} complete`);
  if (cost !== null) {
    parts.push(
      `${formatPrice(cost, currency)} to finish ${complete > 0 ? "the rest" : "every deck here"}`,
    );
  }
  if (unpriced > 0) parts.push(`${plural(unpriced, "copy", "copies")} unpriced`);
  return { complete, cost, unpriced, text: parts.join(" · ") };
}

/** The caption: `96 of 100 · 4 missing`, or `60 of 60 · complete`. */
export function countCaption(row: DeckCompletion): string {
  return `${row.owned} of ${row.wanted} · ${row.missing === 0 ? "complete" : `${row.missing} missing`}`;
}

/**
 * What a row's figure does not say. A theory deck is measured against its plan rather than its
 * sleeved list, and a figure that leaves copies out says how many — `null` being *nothing on the
 * list is priced*, and any other figure beside unpriced copies being a partial sum.
 */
export function rowHint(row: DeckCompletion, marketplace: Marketplace): string | undefined {
  const parts: string[] = [];
  if (row.list === "theory") {
    parts.push(
      "Measured against this deck's theory list, from every copy it can use — anywhere in the collection but another deck's group or a locked drawer.",
    );
  }
  if (row.missing > 0 && row.missingCost === null) {
    parts.push(`Nothing on this deck's list has a price at ${marketplace.label}.`);
  } else if (row.unpricedMissing > 0) {
    const n = row.unpricedMissing;
    parts.push(
      `${plural(n, "missing copy", "missing copies")} with no price at ${marketplace.label} ${n === 1 ? "is" : "are"} not in this figure.`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * Keep this read as fresh as the collection writes that move it — `ActivityWidget.tsx:124-155`'s
 * bridge, one root wide. The module doc has the argument.
 *
 * The marker is never read: `staleTime: Infinity` so nothing refetches it on its own, and
 * `notifyOnChangeProps: []` so its refetch re-renders nothing. The subscription listens for the
 * **invalidate action** rather than any event, because a query under `["collection"]` emits
 * `fetch` and `success` on every ordinary read. No loop: what it invalidates sits under `["decks"]`.
 */
function useCollectionBridge(enabled: boolean): void {
  const client = useQueryClient();

  useQuery({
    queryKey: ["collection", BRIDGE_MARKER],
    queryFn: () => true,
    staleTime: Infinity,
    notifyOnChangeProps: [],
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    // Every marketplace's entry: the key less its last segment, derived from the one definition in
    // `keys.ts` so this line cannot come to spell it differently.
    const root = deckCompletionKey(DEFAULT_MARKETPLACE).slice(0, -1);
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "invalidate") return;
      if (event.query.queryKey[0] !== "collection") return;
      void client.invalidateQueries({ queryKey: root });
    });
  }, [client, enabled]);
}

export function DeckCompletionWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  // `deckScope` knows a third word, `archived`, which only the Decks widget's registry offers —
  // `pickOf` can never answer it for this kind, so anything but `pinned` is `recent`.
  const scope = deckScope(widget) === "pinned" ? "pinned" : "recent";
  const deckIds = pinnedDeckIds(widget);
  const order = orderOf(pickOf(widget, "order"));
  const showComplete = toggleOnOf(widget, "complete");

  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);

  useCollectionBridge(!still);

  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const completionQuery = useQuery({
    queryKey: deckCompletionKey(marketplace.id),
    queryFn: () => ipc.deckCompletion(marketplace.id),
  });

  // The refusal is read before the emptiness: a failed read has no rows either, and calling it
  // "no decks to measure" would tell a reader with six decks that they have none.
  const failure = decksQuery.error ?? completionQuery.error;
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Could not measure your decks — {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (decksQuery.data === undefined || completionQuery.data === undefined) {
    return <WidgetMessage>{PENDING}</WidgetMessage>;
  }
  if (scope === "pinned" && deckIds.length === 0) {
    return <WidgetMessage>{NOTHING_PINNED}</WidgetMessage>;
  }

  const inScope = completionRows(decksQuery.data, completionQuery.data, scope, deckIds);
  if (inScope.length === 0) return <WidgetMessage>{NO_DECKS}</WidgetMessage>;
  const listed = showComplete ? inScope : inScope.filter((row) => row.missing > 0);
  if (listed.length === 0) return <WidgetMessage>{ALL_COMPLETE}</WidgetMessage>;

  /**
   * What the box carries. **On a two-cell tile the shortfall moves under the name** — `WidgetRow`'s
   * rule — and it is the missing count that is kept, with its price beside it, because *how far* is
   * what this card is about. A compact panel drops the `96 of 100` caption and keeps the price. The
   * footer is a panel's furniture and is drawn from three cells wide.
   */
  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const footer = completionFooter(inScope, currency);
  const footerShown = fit.tier >= 1 && footer.text !== "";
  const shown = sortCompletions(listed, order).slice(
    0,
    fit.rowsFit(rowPx(captioned), footerShown ? FOOTER_ROOM : 0),
  );

  /**
   * **`decks` is one view with two states**, told apart by `openDeckId` — and `setActiveView`
   * clears that id on the way in, so the view is written first (`DecksWidget.tsx:267-276`).
   */
  const openDeck = (id: number) => {
    setActiveView("decks");
    setOpenDeckId(id);
  };

  return (
    <>
      <WidgetRowList fit={fit} label="Decks">
        {shown.map((row) => {
          const caption = countCaption(row);
          // A complete deck has nothing to buy, so it draws no figure at all rather than a `$0.00`.
          const price = row.missing === 0 ? "" : formatPrice(row.missingCost, currency);
          // Floored, so a track never reaches the end of its rail beside a deck still short a card.
          const track = Math.floor(share(row) * 100) / 100;
          const hint = rowHint(row, marketplace);
          const onPress = still ? undefined : () => openDeck(row.deckId);
          // The whole row in one string: three flex children with a `gap` and no whitespace text
          // node compute to "Burn56 of 60 · 4 missing$12.50" (`DecksWidget.tsx:314-321`).
          const pressLabel = still
            ? undefined
            : [row.name, caption, price].filter((part) => part !== "").join(" · ");
          return tile ? (
            <WidgetRow
              key={row.deckId}
              name={row.name}
              caption={row.missing === 0 ? "Complete" : `${row.missing} missing · ${price}`}
              captionStrong
              track={track}
              hint={hint}
              onPress={onPress}
              pressLabel={pressLabel}
            />
          ) : (
            <WidgetRow
              key={row.deckId}
              name={row.name}
              caption={captioned ? caption : undefined}
              value={price}
              track={track}
              hint={hint}
              onPress={onPress}
              pressLabel={pressLabel}
            />
          );
        })}
      </WidgetRowList>
      {footerShown && <WidgetFooter>{footer.text}</WidgetFooter>}
    </>
  );
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/features/home/widgets/DeckCompletionWidget.test.tsx`
Expected: PASS, every case. If `ALL_COMPLETE` does not contain `Complete decks`, the foundation's
`deckCompletion` toggle is labelled differently — fix the registry row (F2), not this test.

- [ ] **Step 5: Write the stories**

Create `src/features/home/widgets/DeckCompletionWidget.stories.tsx`. Plays are checked at the end
of the wave (they cannot run mid-fan-out):

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { ipc, type HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import {
  ALL_COMPLETE,
  DeckCompletionWidget,
  NO_DECKS,
  NOTHING_PINNED,
} from "./DeckCompletionWidget";
import { DecksWidgetSettings } from "./DecksWidget";

/** The grid's target cell. Not exported, for CSF — every non-default export is a story. */
const CELL = 104;

/** A `deckCompletion` widget at a footprint, with a config. */
function completion(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "deckCompletion", kind: "deckCompletion", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, at the footprint's size on the target cell — with the pin
 * checklist the page hands this kind as its `extraSettings`, so the settings popover is the shipped
 * one.
 */
function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({ w: widget.w, h: widget.h, widthPx, heightPx, density: widgetDensity(widget) });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
          extraSettings={<DecksWidgetSettings widget={widget} onConfig={onConfig} />}
        >
          <DeckCompletionWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/**
 * An empty world with one deck that asks for nothing — which is missing nothing, so the card's
 * `every deck is complete` sentence has a deck to be about.
 *
 * **Staged through the command rather than seeded**, `DecksPage.stories.tsx`'s `OrphanedCover`
 * idiom: `useQuery` so it runs once in the story's own client, `staleTime: Infinity` so a refocus
 * does not write again, and the card held back until the write has landed.
 */
function OneEmptyDeck({ children }: { children: ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "empty-shell"],
    queryFn: () => ipc.deckCreate({ name: "Empty shell", formatKey: "modern" }),
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children}</> : null;
}

const meta = {
  title: "Home/DeckCompletionWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint and no config: `Most recent`, `Nearest done`, complete decks
    // hidden — the face a reader who adds one from the catalogue meets first.
    widget: completion(3, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "How much of each deck the reader owns, and what the rest would cost. **Owned is the " +
          "deck editor's word**: `deck_completion` measures a live deck against its own group and " +
          "a theory deck's plan against every copy it can use, over every active pile, exact " +
          "printing and exact finish — so the card and the deck it opens can never disagree.\n\n" +
          "**Complete is `missing === 0`**, never a price. A deck missing nothing leaves the list " +
          "unless `Complete decks` is on, and the footer counts it either way — over every deck " +
          "in scope, not over the rows that fit. `missingCost` is an em dash only when nothing on " +
          "the list is priced.\n\n" +
          "`Most recent` is `deck_list`'s order with archived and virtual decks taken out; " +
          "`Pinned` is the checklist `DecksWidget` draws, reused. The order is this body's.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default panel over `starter`: the live decks, nearest done first, with a track each. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · \d+ of \d+ · \d+ missing/ }),
    ).toBeInTheDocument();
  },
};

/** A band ordered cheapest to finish, complete decks listed: the footer a band has room for. */
export const CheapestOnABand: Story = {
  args: { widget: completion(4, 4, { order: "cheapest", complete: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · / }),
    ).toBeInTheDocument();
  },
};

/** A two-cell tile: the shortfall and its price moved under the name, no footer. */
export const Tile: Story = {
  args: { widget: completion(2, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · / }),
    ).toBeInTheDocument();
    await expect(card.queryByText(/to finish/)).not.toBeInTheDocument();
  },
};

/** `Pinned` with nothing pinned points at the checklist rather than drawing the recent decks. */
export const NothingPinned: Story = {
  args: { widget: completion(3, 3, { scope: "pinned" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NOTHING_PINNED)).toBeInTheDocument();
  },
};

/** A database with no decks at all. */
export const NoDecks: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_DECKS)).toBeInTheDocument();
  },
};

/** Every deck in scope is complete and the switch is off: the sentence names the switch. */
export const EveryDeckComplete: Story = {
  parameters: { fake: { seed: "empty" } },
  render: (args) => (
    <OneEmptyDeck>
      <Framed {...args} />
    </OneEmptyDeck>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(ALL_COMPLETE)).toBeInTheDocument();
  },
};

/** A catalogue preview: the same rows as pictures of rows — nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(await card.findByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Modern Goodstuff · / })).toBeNull();
  },
};
```

- [ ] **Step 6: Typecheck** (`npx tsc --noEmit -p .`)

Run: `npx tsc --noEmit -p .` then `npx eslint src/features/home/widgets/DeckCompletionWidget.tsx src/features/home/widgets/DeckCompletionWidget.test.tsx src/features/home/widgets/DeckCompletionWidget.stories.tsx`
Expected: no errors. (Other lanes' files may still be mid-edit; an error in a file this task did
not write is reported to the controller, not fixed here.)

---

### Task 8 (W2): To review (`ToReviewWidget`)

Spec §4.1. One row per place something is waiting, each opening that place; a row is drawn only
when its count is above zero, always in the order scanned → binder → wishes → deck cards →
Recently removed.

**Files:**
- Create: `src/features/home/widgets/ToReviewWidget.tsx`
- Test: `src/features/home/widgets/ToReviewWidget.test.tsx`
- Create: `src/features/home/widgets/ToReviewWidget.stories.tsx`

**Interfaces:**
- Consumes: `ipc.scannerTray()` under `scannerTrayCountKey`; `ipc.collectionSummary({ limit: 0,
  offset: 0, marketplace })` under `collectionTotalKey(marketplace.id)` — **the very key and
  query `SummaryWidget.tsx:174-181` reads**, one fetch between them; `ipc.wishlistList({
  needsReview: true, flatten: true, limit: 1, offset: 0 }).total` under `wishlistReviewCountKey`;
  `ipc.deckReviewCount()` under `deckReviewCountKey`; `useCollectionFolders()`
  (`src/features/collection/useCollectionFolders.ts:61`) for the `removed` folder and its copies;
  `isWebTarget()` (`src/pwa/target.ts:21`); `useAppStore`'s `setActiveView`,
  `setPendingReviewFilter`, `setPendingSettingsGroup`, `setPendingFolder`; `toggleOnOf(widget,
  "removed")`.
- Produces:
  ```ts
  export type ReviewRowKind = "scanned" | "binder" | "wishes" | "deckCards" | "removed";
  export interface ReviewCounts { scanned: number; unresolved: number; binder: number; wishes: number; deckCards: number; removed: number; removedFolderId: number | null }
  export interface ReviewRow { kind: ReviewRowKind; name: string; caption: string; tileCaption: string; value: string | null; pressable: boolean; hint?: string; folderId?: number }
  export function trayCounts(rows: readonly ScannerTrayRow[]): { scanned: number; unresolved: number };
  export function reviewRows(counts: ReviewCounts, opts: { web: boolean; removed: boolean }): ReviewRow[];
  export const EMPTY: string; export const WEB_DECK_HINT: string;
  export function ToReviewWidget(props: WidgetBodyProps & { web?: boolean }): ReactElement;
  ```
  **`web` is an optional prop that defaults to `isWebTarget()`**: the page never passes it, and a
  story passes it because `isWebTarget()` is a build-time define the workbench folds to the
  desktop answer (`ScannerPage.stories.tsx:183-190`).

- [ ] **Step 1: Write the failing test**

Create `src/features/home/widgets/ToReviewWidget.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollectionFolder,
  CollectionFolderSummary,
  CollectionQuery,
  CollectionSummary,
  HomeWidget,
  ScannerTrayRow,
  WishlistPage,
  WishlistQuery,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The six reads this body reaches, in front of an **intact** mirror, each typed against its own
 * signature — `NewPrintingsWidget.test.tsx`'s note.
 *
 * **The transport rather than the cache**, which is where this file parts from `DecksWidget`'s:
 * two of the six keys are `useCollectionFolders`' own and spelled nowhere this test may import
 * them from, and the question half the cases ask is *what the body asked* — a wishlist page of one
 * row, flattened and flagged; the collection with no filter at all. So every read is stubbed and
 * every assertion waits for the answer to land.
 */
const scannerTray = vi.hoisted(() => vi.fn<() => Promise<ScannerTrayRow[]>>());
const collectionSummary = vi.hoisted(() =>
  vi.fn<(query: CollectionQuery) => Promise<CollectionSummary>>(),
);
const wishlistList = vi.hoisted(() => vi.fn<(query: WishlistQuery) => Promise<WishlistPage>>());
const deckReviewCount = vi.hoisted(() => vi.fn<() => Promise<number>>());
const collectionFolderList = vi.hoisted(() => vi.fn<() => Promise<CollectionFolder[]>>());
const collectionFolderSummary = vi.hoisted(() =>
  vi.fn<(marketplace: MarketplaceId) => Promise<CollectionFolderSummary[]>>(),
);
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      scannerTray,
      collectionSummary,
      wishlistList,
      deckReviewCount,
      collectionFolderList,
      collectionFolderSummary,
    },
  };
});
/** The build's own answer, which only a module mock can reach — `ScannerPage.test.tsx:9`. */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { isWebTarget } from "@/pwa/target";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import {
  EMPTY,
  reviewRows,
  ToReviewWidget,
  trayCounts,
  WEB_DECK_HINT,
  type ReviewCounts,
} from "./ToReviewWidget";

const REMOVED_FOLDER = 9;

function trayRow(i: number, unresolved: boolean): ScannerTrayRow {
  return {
    key: `row-${i}`,
    cardId: `card-${i}`,
    oracleId: `oracle-${i}`,
    name: `Card ${i}`,
    setCode: "mh3",
    collectorNumber: String(100 + i),
    finish: "nonfoil",
    quantity: 1,
    choices: unresolved
      ? [
          {
            cardId: `alt-${i}`,
            oracleId: `oracle-${i}`,
            name: `Card ${i}`,
            setCode: "2x2",
            collectorNumber: "1",
          },
        ]
      : [],
    addedAt: 1_800_000_000_000 + i,
  };
}

function summary(needsReview: number): CollectionSummary {
  return {
    totalCards: 12,
    uniqueCards: 10,
    entries: 10,
    tradelistCards: 0,
    value: 40,
    unpriced: 0,
    needsReview,
  };
}

function folder(
  over: Partial<CollectionFolder> & { id: number; name: string; kind: string },
): CollectionFolder {
  return { parentId: null, deckId: null, sortOrder: 0, locked: false, syncUid: null, ...over };
}

/** A binder drawer, one deck's group, and the one holding area — the app's three folder kinds. */
const FOLDERS: CollectionFolder[] = [
  folder({ id: 1, name: "Binder", kind: "user" }),
  folder({ id: 4, name: "Burn", kind: "deck", deckId: 1 }),
  folder({ id: REMOVED_FOLDER, name: "Recently removed", kind: "removed" }),
];

interface World {
  scanned?: number;
  unresolved?: number;
  binder?: number;
  wishes?: number;
  deckCards?: number;
  removed?: number;
  folders?: CollectionFolder[];
}

/** Every read answering. `removed` copies are filed in the removed folder's summary row, and an
 *  empty folder answers no row at all — `CollectionFolderSummary`'s own rule. */
function world({
  scanned = 0,
  unresolved = 0,
  binder = 0,
  wishes = 0,
  deckCards = 0,
  removed = 0,
  folders = FOLDERS,
}: World = {}): void {
  scannerTray.mockResolvedValue(
    Array.from({ length: scanned }, (_, i) => trayRow(i, i < unresolved)),
  );
  collectionSummary.mockResolvedValue(summary(binder));
  wishlistList.mockResolvedValue({ items: [], total: wishes });
  deckReviewCount.mockResolvedValue(deckCards);
  collectionFolderList.mockResolvedValue(folders);
  collectionFolderSummary.mockResolvedValue(
    removed > 0 ? [{ folderId: REMOVED_FOLDER, cards: removed, value: null }] : [],
  );
}

const EVERYTHING: World = { scanned: 4, unresolved: 1, binder: 2, wishes: 1, deckCards: 3, removed: 5 };

function widget(config: unknown = null): HomeWidget {
  return { id: "toReview", kind: "toReview", x: 0, y: 0, w: 3, h: 6, config };
}

function fitFor(w: number, h: number, density: "comfortable" | "compact" = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density });
}

/** Room for all five rows, captioned, in one column. */
const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false, web }: { fit?: WidgetFit; still?: boolean; web?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <ToReviewWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
      web={web}
    />,
    { wrapper },
  );
}

/** The row names in drawn order. */
function drawnNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

/**
 * The writes a press makes, in the order it makes them — the half an end state cannot show, and
 * the half that matters: `setActiveView` clears every hand-off, so the view must come first.
 */
function recordWrites(): string[] {
  const writes: string[] = [];
  const real = useAppStore.getState();
  useAppStore.setState({
    setActiveView: (view) => {
      writes.push(`view:${view}`);
      real.setActiveView(view);
    },
    setPendingReviewFilter: (value) => {
      writes.push(`review:${value.scope}`);
      real.setPendingReviewFilter(value);
    },
    setPendingSettingsGroup: (group) => {
      writes.push(`group:${group}`);
      real.setPendingSettingsGroup(group);
    },
    setPendingFolder: (value) => {
      writes.push(`folder:${value.scope}:${value.id}`);
      real.setPendingFolder(value);
    },
  });
  return writes;
}

beforeEach(() => {
  for (const stub of [
    scannerTray,
    collectionSummary,
    wishlistList,
    deckReviewCount,
    collectionFolderList,
    collectionFolderSummary,
  ]) {
    stub.mockReset();
  }
  world();
  vi.mocked(isWebTarget).mockReturnValue(false);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("trayCounts", () => {
  it("counts every row, and the rows still waiting on a printing", () => {
    expect(trayCounts([trayRow(0, true), trayRow(1, false), trayRow(2, true)])).toEqual({
      scanned: 3,
      unresolved: 2,
    });
    expect(trayCounts([])).toEqual({ scanned: 0, unresolved: 0 });
  });
});

describe("reviewRows", () => {
  const ALL: ReviewCounts = {
    scanned: 4,
    unresolved: 1,
    binder: 2,
    wishes: 1,
    deckCards: 3,
    removed: 5,
    removedFolderId: REMOVED_FOLDER,
  };

  it("draws every row with a count, always in the same order", () => {
    expect(reviewRows(ALL, { web: false, removed: true }).map((r) => r.kind)).toEqual([
      "scanned",
      "binder",
      "wishes",
      "deckCards",
      "removed",
    ]);
  });

  it("leaves out a row whose count is zero", () => {
    expect(
      reviewRows({ ...ALL, binder: 0, wishes: 0 }, { web: false, removed: true }).map((r) => r.kind),
    ).toEqual(["scanned", "deckCards", "removed"]);
  });

  it("says what the scanned cards need, in the singular and the plural", () => {
    const one = reviewRows(ALL, { web: false, removed: true })[0];
    expect(one).toEqual(
      expect.objectContaining({
        name: "Scanned cards",
        caption: "1 needs a printing chosen",
        tileCaption: "4 · 1 to choose",
        value: "4",
      }),
    );
    expect(reviewRows({ ...ALL, unresolved: 3 }, { web: false, removed: true })[0].caption).toBe(
      "3 need a printing chosen",
    );
    const ready = reviewRows({ ...ALL, unresolved: 0 }, { web: false, removed: true })[0];
    expect([ready.caption, ready.tileCaption]).toEqual(["Ready to add", "4 ready"]);
  });

  /** Rows where the table counts rows, copies where the reader thinks in copies — and the
   *  removed row's caption is what says so, which is why it carries no second figure. */
  it("counts the removed folder in copies, in its caption", () => {
    const removed = reviewRows(ALL, { web: false, removed: true })[4];
    expect(removed).toEqual(
      expect.objectContaining({
        name: "Recently removed",
        caption: "5 copies",
        value: null,
        folderId: REMOVED_FOLDER,
      }),
    );
    expect(
      reviewRows({ ...ALL, removed: 1 }, { web: false, removed: true })[4].caption,
    ).toBe("1 copy");
  });

  it("leaves the removed row out when the reader switched it off, or there is no holding area", () => {
    expect(reviewRows(ALL, { web: false, removed: false }).map((r) => r.kind)).not.toContain(
      "removed",
    );
    expect(
      reviewRows({ ...ALL, removedFolderId: null }, { web: false, removed: true }).map((r) => r.kind),
    ).not.toContain("removed");
  });

  it("hides the scanner and disarms the deck cards on the browser build", () => {
    const rows = reviewRows(ALL, { web: true, removed: true });
    expect(rows.map((r) => r.kind)).toEqual(["binder", "wishes", "deckCards", "removed"]);
    const deckCards = rows.find((r) => r.kind === "deckCards");
    expect(deckCards?.pressable).toBe(false);
    expect(deckCards?.hint).toBe(WEB_DECK_HINT);
    expect(rows.filter((r) => r.kind !== "deckCards").every((r) => r.pressable)).toBe(true);
  });
});

describe("ToReviewWidget", () => {
  describe("what it draws", () => {
    it("draws a row per place with something waiting, in the fixed order", async () => {
      world(EVERYTHING);

      draw();

      expect(
        await screen.findByRole("button", { name: "Scanned cards · 1 needs a printing chosen · 4" }),
      ).toBeInTheDocument();
      expect(drawnNames()).toEqual([
        "Scanned cards",
        "Binder entries",
        "Wishes",
        "Deck cards",
        "Recently removed",
      ]);
      expect(
        screen.getByRole("button", { name: "Binder entries · Flagged for review · 2" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Wishes · Flagged for review · 1" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Deck cards · Flagged for review · 3" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Recently removed · 5 copies" })).toBeInTheDocument();
    });

    /** The questions the body asks: the whole collection, and a one-row page of flagged wishes. */
    it("asks the collection with no filter and the wishlist for one flagged row, flattened", async () => {
      world(EVERYTHING);

      draw();

      await screen.findByText("Binder entries");
      expect(collectionSummary).toHaveBeenCalledWith({
        limit: 0,
        offset: 0,
        marketplace: DEFAULT_MARKETPLACE,
      });
      expect(wishlistList).toHaveBeenCalledWith({
        needsReview: true,
        flatten: true,
        limit: 1,
        offset: 0,
      });
    });

    it("draws only the rows with a count", async () => {
      world({ binder: 2 });

      draw();

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(drawnNames()).toEqual(["Binder entries"]);
    });

    it("leaves Recently removed out when the reader switched it off", async () => {
      world({ removed: 5 });

      draw({ removed: false });

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    });

    it("draws no removed row in a database with no holding area", async () => {
      world({ removed: 5, folders: FOLDERS.slice(0, 2) });

      draw();

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    });

    it("moves each count under its name on a two-cell tile", async () => {
      world(EVERYTHING);

      draw(null, { fit: fitFor(2, 6) });

      expect(await screen.findByText("4 · 1 to choose")).toBeInTheDocument();
      expect(screen.getByText("2 flagged")).toBeInTheDocument();
      expect(screen.getByText("5 copies")).toBeInTheDocument();
      expect(screen.queryByText("Flagged for review")).toBeNull();
    });

    it("keeps the count and drops the caption on a compact card", async () => {
      world({ binder: 2, removed: 5 });

      draw(null, { fit: fitFor(3, 3, "compact") });

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByText("Flagged for review")).toBeNull();
      expect(screen.getByText("2")).toBeInTheDocument();
      // The removed row has no second figure, so its caption becomes the figure.
      expect(screen.getByText("5 copies")).toBeInTheDocument();
    });
  });

  describe("the states", () => {
    it("says it is looking while a read is out", () => {
      collectionSummary.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Looking for anything waiting on you…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      deckReviewCount.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not read what is waiting — The database is busy."),
      ).toBeInTheDocument();
    });

    it("says nothing is waiting when every count is zero", async () => {
      draw();

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
      expect(EMPTY).toBe("Nothing waiting for you.");
    });
  });

  describe("pressing a row", () => {
    it.each([
      ["Scanned cards", ["view:scanner"]],
      ["Binder entries", ["view:collection", "review:collection"]],
      ["Wishes", ["view:wishlist", "review:wishlist"]],
      ["Deck cards", ["view:settings", "group:sync"]],
      ["Recently removed", ["view:collection", `folder:collection:${REMOVED_FOLDER}`]],
    ])("%s opens its place, the view first", async (name, expected) => {
      const user = userEvent.setup();
      const writes = recordWrites();
      world(EVERYTHING);
      draw();

      await user.click(await screen.findByRole("button", { name: new RegExp(`^${name} · `) }));

      expect(writes).toEqual(expected);
    });

    /** The end state as well as the order: each hand-off survives the view change it rode in on. */
    it("leaves each hand-off in the store for the page to read", async () => {
      const user = userEvent.setup();
      world(EVERYTHING);
      draw();

      await user.click(await screen.findByRole("button", { name: /^Wishes · / }));
      expect(useAppStore.getState().activeView).toBe("wishlist");
      expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "wishlist" });

      await user.click(screen.getByRole("button", { name: /^Deck cards · / }));
      expect(useAppStore.getState().activeView).toBe("settings");
      expect(useAppStore.getState().pendingSettingsGroup).toBe("sync");
      // The previous hand-off went with the view change, which is what makes it one-shot.
      expect(useAppStore.getState().pendingReviewFilter).toBeNull();

      await user.click(screen.getByRole("button", { name: /^Recently removed · / }));
      expect(useAppStore.getState().pendingFolder).toEqual({
        scope: "collection",
        id: REMOVED_FOLDER,
      });
    });

    it("draws a still body with no presses", async () => {
      world(EVERYTHING);

      draw(null, { still: true });

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  describe("the browser build", () => {
    it("reads no tray and draws no scanner row", async () => {
      world(EVERYTHING);

      draw(null, { web: true });

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByText("Scanned cards")).toBeNull();
      expect(scannerTray).not.toHaveBeenCalled();
    });

    it("draws the deck cards without a press", async () => {
      world({ deckCards: 3 });

      draw(null, { web: true });

      expect(await screen.findByText("Deck cards")).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("says nothing is waiting when only the tray has rows", async () => {
      world({ scanned: 4 });

      draw(null, { web: true });

      expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    });

    /** The page never passes `web`, so the build's own answer is what decides there. */
    it("asks the build which target it is when nobody says", async () => {
      vi.mocked(isWebTarget).mockReturnValue(true);
      world(EVERYTHING);

      draw();

      expect(await screen.findByText("Binder entries")).toBeInTheDocument();
      expect(screen.queryByText("Scanned cards")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/home/widgets/ToReviewWidget.test.tsx`
Expected: FAIL — `Failed to resolve import "./ToReviewWidget"`.

- [ ] **Step 3: Implement**

Create `src/features/home/widgets/ToReviewWidget.tsx`:

```tsx
/**
 * What is waiting on the reader, one row per place it is waiting in — the scanner's tray, flagged
 * binder entries, flagged wishes, flagged deck cards, and the copies held in `Recently removed`.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the settings popover (one registry switch,
 * `Recently removed`) and the Customize tray; this draws the rows, cut to the box `fit` describes.
 *
 * ## One row per place, and each row opens that place
 *
 * Chosen by the reader over a single row into Settings (spec §1). A press is a view change and,
 * where the page does not open in the right state by itself, **a one-shot hand-off written after
 * it** — `setActiveView` first and the hand-off second, because the view change is what clears
 * every hand-off (`store.ts`'s `pendingFolder` argues it once for all of them). The binder and the
 * wishlist open with their needs-review filter on (`pendingReviewFilter`), the deck cards open
 * Settings on the `sync` group that holds Needs review (`pendingSettingsGroup`), and Recently
 * removed is the folder hand-off `FoldersWidget` already makes. The scanner needs none.
 *
 * ## Rows or copies, and the caption says which
 *
 * The flagged rows count **rows** — `collection_summary.needsReview` counts entries, a flagged wish
 * is a wish, a flagged deck card a `deck_cards` row — and each row's name says the unit. The
 * removed folder counts **copies**, because that is how a reader thinks of a holding area, so its
 * caption says `5 copies` and it carries no second figure to say the same thing twice.
 * {@link reviewRows} is where every one of these words is decided, and it is pure.
 *
 * ## Five reads, one of them new
 *
 * The tray under its own count key — **never `["scanner","tray"]`**, which *is* the tray in the
 * window that owns the scanner (`useTray.ts`, written with `setQueryData`), and which this card
 * must not write into. The collection's flagged entries through `collectionTotalKey`, which is
 * `SummaryWidget`'s own read and one fetch between the two. The flagged wishes as the `total` of a
 * one-row page, flattened so a wish filed in a drawer counts. `deck_review_count`, the one new
 * command — `sync_relay_status.reviewCount` sums six tables, is desktop-only and takes the write
 * lock. And `Recently removed` through `useCollectionFolders`: **found in the list, then looked up
 * in the summary**, because an empty folder answers no summary row and a missing row is zero.
 *
 * ## The browser build
 *
 * There is no scanner there (`ScannerPage.tsx:100`), so the tray is neither read nor drawn; and
 * `sync_review_list` is not routed on the web target, so the deck cards row is drawn **without a
 * press** and its hint says where the flags can be cleared. `web` is a prop defaulting to
 * `isWebTarget()` because that answer is a build-time define the workbench folds to the desktop
 * one — a story names it; the page never does.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import type { ReactElement, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Heart, Inbox } from "lucide-react";

import { CabinetFiling, Cards } from "@/components/icons";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { count } from "@/lib/counts";
import { ipc, ipcError, type ScannerTrayRow, type WishlistQuery } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { isWebTarget } from "@/pwa/target";

import {
  collectionTotalKey,
  deckReviewCountKey,
  scannerTrayCountKey,
  wishlistReviewCountKey,
} from "../keys";
import { WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { toggleOnOf } from "../widgetSettings";

/** The five places, in the order they are always drawn. */
export type ReviewRowKind = "scanned" | "binder" | "wishes" | "deckCards" | "removed";

/** What the five reads answered, as plain numbers. `removedFolderId` is `null` in a database with
 *  no holding area — every real one has one, and a row that could open nothing is not drawn. */
export interface ReviewCounts {
  scanned: number;
  unresolved: number;
  binder: number;
  wishes: number;
  deckCards: number;
  removed: number;
  removedFolderId: number | null;
}

/** One row as the body draws it. Every word is decided in {@link reviewRows}. */
export interface ReviewRow {
  kind: ReviewRowKind;
  name: string;
  /** The line under the name on a panel. */
  caption: string;
  /** The line under the name on a two-cell tile, where it carries the count. */
  tileCaption: string;
  /** The figure at the right, or `null` where the caption already is the count. */
  value: string | null;
  /** `false` only for the deck cards on the browser build, which have nowhere to open. */
  pressable: boolean;
  hint?: string;
  /** The removed folder's id, for the folder hand-off. */
  folderId?: number;
}

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx:55-57`'s sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;

const PENDING = "Looking for anything waiting on you…";
export const EMPTY = "Nothing waiting for you.";
export const WEB_DECK_HINT =
  "The browser build has no Needs review list to open — clear these in the desktop app, under Settings → Sync.";
const FLAGGED = "Flagged for review";

/** The flagged wishes, as a one-row page: `total` is the count, and `flatten` reaches every
 *  drawer. `limit: 1` rather than `0`, which the backend reads as its default page of 100. */
const FLAGGED_WISHES: WishlistQuery = { needsReview: true, flatten: true, limit: 1, offset: 0 };

/**
 * Each place's glyph — **the navigation rail's own** where the row opens a view (`nav.ts`: `Camera`
 * for the scanner, not `ScanLine`, which drew a barcode reader; `CabinetFiling`, `Heart`, `Cards`),
 * and `Inbox` for the holding area, which is the glyph `PinnedFolders.tsx` gives it.
 */
const ICONS: Record<ReviewRowKind, ReactNode> = {
  scanned: <Camera className="size-3.5" aria-hidden="true" />,
  binder: <CabinetFiling className="size-3.5" aria-hidden="true" />,
  wishes: <Heart className="size-3.5" aria-hidden="true" />,
  deckCards: <Cards className="size-3.5" aria-hidden="true" />,
  removed: <Inbox className="size-3.5" aria-hidden="true" />,
};

/** The tray's two numbers. A row is still a choice while it has `choices` (`tray.ts:228-231`). */
export function trayCounts(rows: readonly ScannerTrayRow[]): { scanned: number; unresolved: number } {
  return { scanned: rows.length, unresolved: rows.filter((row) => row.choices.length > 0).length };
}

function flaggedRow(
  kind: "binder" | "wishes" | "deckCards",
  name: string,
  n: number,
  pressable: boolean,
  hint?: string,
): ReviewRow {
  return {
    kind,
    name,
    caption: FLAGGED,
    tileCaption: `${count(n)} flagged`,
    value: count(n),
    pressable,
    hint,
  };
}

/**
 * Which rows are drawn, in which order, with which words — the whole of this card's judgement.
 *
 * A row is drawn only when its count is above zero. The browser build draws no scanner row and a
 * deck cards row with no press; the reader's `Recently removed` switch takes that row away, and a
 * database with no holding area never draws it.
 */
export function reviewRows(
  counts: ReviewCounts,
  opts: { web: boolean; removed: boolean },
): ReviewRow[] {
  const rows: ReviewRow[] = [];
  if (!opts.web && counts.scanned > 0) {
    const n = counts.unresolved;
    rows.push({
      kind: "scanned",
      name: "Scanned cards",
      caption: n > 0 ? `${count(n)} ${n === 1 ? "needs" : "need"} a printing chosen` : "Ready to add",
      tileCaption:
        n > 0 ? `${count(counts.scanned)} · ${count(n)} to choose` : `${count(counts.scanned)} ready`,
      value: count(counts.scanned),
      pressable: true,
    });
  }
  if (counts.binder > 0) rows.push(flaggedRow("binder", "Binder entries", counts.binder, true));
  if (counts.wishes > 0) rows.push(flaggedRow("wishes", "Wishes", counts.wishes, true));
  if (counts.deckCards > 0) {
    rows.push(
      flaggedRow(
        "deckCards",
        "Deck cards",
        counts.deckCards,
        !opts.web,
        opts.web ? WEB_DECK_HINT : undefined,
      ),
    );
  }
  if (opts.removed && counts.removed > 0 && counts.removedFolderId !== null) {
    const copies = `${count(counts.removed)} ${counts.removed === 1 ? "copy" : "copies"}`;
    rows.push({
      kind: "removed",
      name: "Recently removed",
      caption: copies,
      tileCaption: copies,
      value: null,
      pressable: true,
      folderId: counts.removedFolderId,
    });
  }
  return rows;
}

/** The whole row in one string — a `gap` between flex children with no whitespace text node
 *  computes to "WishesFlagged for review1" (`DecksWidget.tsx:314-321`). */
function spoken(row: ReviewRow): string {
  return [row.name, row.caption, row.value]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

export function ToReviewWidget({
  widget,
  fit,
  still,
  web = isWebTarget(),
}: WidgetBodyProps & { web?: boolean }): ReactElement {
  const withRemoved = toggleOnOf(widget, "removed");
  const { marketplace } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingReviewFilter = useAppStore((s) => s.setPendingReviewFilter);
  const setPendingSettingsGroup = useAppStore((s) => s.setPendingSettingsGroup);
  const setPendingFolder = useAppStore((s) => s.setPendingFolder);

  const tray = useQuery({
    queryKey: scannerTrayCountKey,
    queryFn: async () => trayCounts(await ipc.scannerTray()),
    // No scanner on the browser build, and `scanner_tray` is not routed there.
    enabled: !web,
    // Nothing invalidates this key — the tray's writes feed `["scanner", "tray"]` by
    // `setQueryData` — so it is read afresh on every mount rather than trusted for the app's 30 s.
    staleTime: 0,
  });
  const collection = useQuery({
    queryKey: collectionTotalKey(marketplace.id),
    // `SummaryWidget.tsx:174-181`'s query verbatim, so the two share one cache entry: no filter at
    // all is the whole cabinet, and `limit: 0` is the summary's idiom for "count, do not list".
    queryFn: () => ipc.collectionSummary({ limit: 0, offset: 0, marketplace: marketplace.id }),
  });
  const wishes = useQuery({
    queryKey: wishlistReviewCountKey,
    queryFn: async () => (await ipc.wishlistList(FLAGGED_WISHES)).total,
  });
  const deckCards = useQuery({
    queryKey: deckReviewCountKey,
    queryFn: () => ipc.deckReviewCount(),
  });
  const folders = useCollectionFolders();

  // One sentence for any refusal, `SummaryWidget`'s rule: a reader whose database will not answer
  // one of these is not helped by learning which, and the backend's words are the part to read.
  const failure =
    collection.error ??
    wishes.error ??
    deckCards.error ??
    tray.error ??
    (withRemoved ? (folders.query.error ?? folders.summaryQuery.error) : null);
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Could not read what is waiting — {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (
    collection.data === undefined ||
    wishes.data === undefined ||
    deckCards.data === undefined ||
    (!web && tray.data === undefined) ||
    (withRemoved && (folders.query.data === undefined || folders.summaryQuery.data === undefined))
  ) {
    return <WidgetMessage>{PENDING}</WidgetMessage>;
  }

  // Found in the list, then looked up: an empty folder answers no summary row.
  const removedFolder = folders.folders.find((entry) => entry.kind === "removed") ?? null;
  const rows = reviewRows(
    {
      scanned: tray.data?.scanned ?? 0,
      unresolved: tray.data?.unresolved ?? 0,
      binder: collection.data.needsReview,
      wishes: wishes.data,
      deckCards: deckCards.data,
      removed: removedFolder === null ? 0 : (folders.summary.get(removedFolder.id)?.cards ?? 0),
      removedFolderId: removedFolder?.id ?? null,
    },
    { web, removed: withRemoved },
  );
  if (rows.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;

  /** Each place, and the hand-off it needs — **the view first**, because the view change clears
   *  every hand-off and the inverse leaves the store holding nothing. */
  const open = (row: ReviewRow) => {
    switch (row.kind) {
      case "scanned":
        setActiveView("scanner");
        return;
      case "binder":
        setActiveView("collection");
        setPendingReviewFilter({ scope: "collection" });
        return;
      case "wishes":
        setActiveView("wishlist");
        setPendingReviewFilter({ scope: "wishlist" });
        return;
      case "deckCards":
        setActiveView("settings");
        setPendingSettingsGroup("sync");
        return;
      case "removed":
        if (row.folderId === undefined) return;
        setActiveView("collection");
        setPendingFolder({ scope: "collection", id: row.folderId });
        return;
    }
  };

  /**
   * What the box carries. **On a two-cell tile the count moves under the name** — `WidgetRow`'s rule
   * — as a short phrase that says its unit. A compact panel drops the caption and keeps the figure;
   * the removed row, whose caption *is* its figure, keeps that as the figure instead.
   */
  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const shown = rows.slice(0, fit.rowsFit(captioned ? ROW_CAPTIONED : ROW_BARE));

  return (
    <WidgetRowList fit={fit}>
      {shown.map((row) => {
        const onPress = still || !row.pressable ? undefined : () => open(row);
        const pressLabel = onPress === undefined ? undefined : spoken(row);
        return tile ? (
          <WidgetRow
            key={row.kind}
            name={row.name}
            caption={row.tileCaption}
            captionStrong
            icon={ICONS[row.kind]}
            hint={row.hint}
            onPress={onPress}
            pressLabel={pressLabel}
          />
        ) : (
          <WidgetRow
            key={row.kind}
            name={row.name}
            caption={captioned ? row.caption : undefined}
            value={row.value ?? (captioned ? undefined : row.caption)}
            icon={ICONS[row.kind]}
            hint={row.hint}
            onPress={onPress}
            pressLabel={pressLabel}
          />
        );
      })}
    </WidgetRowList>
  );
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/features/home/widgets/ToReviewWidget.test.tsx`
Expected: PASS. A failure naming `setPendingReviewFilter`/`setPendingSettingsGroup` as not a
function means F1's store fields have not landed in this tree — stop and report it.

- [ ] **Step 5: Write the stories**

Create `src/features/home/widgets/ToReviewWidget.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { TRAY_ROWS } from "@/features/scanner/fixtures";
import { ipc, type HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { EMPTY, ToReviewWidget } from "./ToReviewWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/** How long a play waits for five reads and a staged write to land. Not exported, for CSF. */
const LANDED = { timeout: 5_000 };

/** A `toReview` widget at a footprint, with a config. */
function review(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "toReview", kind: "toReview", x: 0, y: 0, w, h, config };
}

/** The body inside the real card. `web` is the one prop the page never passes — see the story
 *  that sets it. */
function Framed({
  widget,
  still = false,
  web,
}: {
  widget: HomeWidget;
  still?: boolean;
  web?: boolean;
}) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({ w: widget.w, h: widget.h, widthPx, heightPx, density: widgetDensity(widget) });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <ToReviewWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
            web={web}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/**
 * The two rows no seed carries, **written through the commands** — `DecksPage.stories.tsx`'s
 * `OrphanedCover` idiom, and `FakeDb.scannerTray`'s own doc says a story that wants tray rows writes
 * them. The scanner fixture's four rows, one still waiting on a printing; and deck 2 deleted, which
 * files the one copy in its group into `Recently removed` — the fake's `deck_delete` does exactly
 * what the crate does. `useQuery` so it runs once per story client, and the card is held back until
 * both writes have landed.
 */
function Staged({ children }: { children: ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "to-review"],
    queryFn: async () => {
      await ipc.setScannerTray(TRAY_ROWS);
      await ipc.deckDelete(2);
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children}</> : null;
}

const meta = {
  title: "Home/ToReviewWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint and no config — `Recently removed` on.
    widget: review(2, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "What is waiting on the reader, **one row per place** and each row opening that place: " +
          "the scanner's tray, flagged binder entries, flagged wishes, flagged deck cards, and the " +
          "copies held in `Recently removed`. A row is drawn only when its count is above zero, " +
          "always in that order.\n\n" +
          "A press is a view change and, where the page does not open in the right state by " +
          "itself, a one-shot hand-off after it — the binder and the wishlist open filtered to " +
          "Needs review, the deck cards open Settings on Sync.\n\n" +
          "**The browser build** has no scanner, so there is no tray row, and no Needs review list " +
          "to open, so the deck cards row is drawn without a press.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every row at once: `needsReview` flags one binder entry, one wish and one deck card, and the
 * staged writes add the tray and a copy in `Recently removed`.
 */
export const EverythingWaiting: Story = {
  args: { widget: review(3, 4) },
  parameters: { fake: { seed: "needsReview" } },
  render: (args) => (
    <Staged>
      <Framed {...args} />
    </Staged>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(
      await card.findByRole(
        "button",
        { name: "Scanned cards · 1 needs a printing chosen · 4" },
        LANDED,
      ),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Binder entries · Flagged for review · 1" }),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Wishes · Flagged for review · 1" }),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Deck cards · Flagged for review · 1" }),
    ).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Recently removed · 1 copy" })).toBeInTheDocument();
  },
};

/** The two-cell tile: each count moved under its name. */
export const Tile: Story = {
  args: { widget: review(2, 2) },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(await card.findAllByText("1 flagged", {}, LANDED)).toHaveLength(3);
  },
};

/**
 * **The browser build's face**, with the same rows staged: no scanner row even with a tray full of
 * cards, and the deck cards drawn without a press. `web` is passed because `isWebTarget()` is a
 * build-time define this workbench folds to the desktop answer — the page never passes it.
 */
export const BrowserBuild: Story = {
  args: { widget: review(3, 4), web: true },
  parameters: { fake: { seed: "needsReview" } },
  render: (args) => (
    <Staged>
      <Framed {...args} />
    </Staged>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Binder entries · / }, LANDED),
    ).toBeInTheDocument();
    await expect(card.queryByText("Scanned cards")).not.toBeInTheDocument();
    await expect(card.getByText("Deck cards")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Deck cards/ })).not.toBeInTheDocument();
  },
};

/** The reader switched `Recently removed` off: the holding area is not a problem to them. */
export const RecentlyRemovedOff: Story = {
  args: { widget: review(2, 3, { removed: false }) },
  render: (args) => (
    <Staged>
      <Framed {...args} />
    </Staged>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Scanned cards · / }, LANDED),
    ).toBeInTheDocument();
    await expect(card.queryByText("Recently removed")).not.toBeInTheDocument();
  },
};

/** `starter`: nothing flagged, an empty tray, an empty holding area. */
export const NothingWaiting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(EMPTY, {}, LANDED)).toBeInTheDocument();
  },
};

/** A catalogue preview: the rows as pictures, nothing to press. */
export const Still: Story = {
  args: { still: true },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "To review" }, LANDED));
    await expect(await card.findByText("Binder entries", {}, LANDED)).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Binder entries/ })).toBeNull();
  },
};
```

- [ ] **Step 6: Typecheck** (`npx tsc --noEmit -p .`)

Run: `npx tsc --noEmit -p .` then `npx eslint src/features/home/widgets/ToReviewWidget.tsx src/features/home/widgets/ToReviewWidget.test.tsx src/features/home/widgets/ToReviewWidget.stories.tsx`
Expected: no errors.

---

### Task 9 (W3): Wishlist savings (`WishlistSavingsWidget`)

Spec §5.2. The optimise plan over the whole wishlist, as a figure and the moves that save most.

**`considered === 0` means an empty wishlist, not "no wish is pinned".** `wishlist_optimize.rs:276`
sets `considered` to every wish scanned, and an any-printing wish is counted in `alreadyCheapest`
(`:288`), so a list of only any-printing wishes answers `considered > 0` with no moves. The two
empty sentences are therefore *the wishlist is empty* and *every pinned wish is already cheapest,
and a wish for any printing always is* — see Contract problems. A third sentence covers moves that
exist but none of which can be priced, so nothing ever reads `$0.00` saved.

**Files:**
- Create: `src/features/home/widgets/WishlistSavingsWidget.tsx`
- Test: `src/features/home/widgets/WishlistSavingsWidget.test.tsx`
- Create: `src/features/home/widgets/WishlistSavingsWidget.stories.tsx`

**Interfaces:**
- Consumes: `ipc.wishlistOptimizePlan(wholeWishlistQuery(marketplace.id))` under
  `wishlistSavingsKey(marketplace.id)`; `useMarketplace()`; `useAppStore`'s `setActiveView` and
  `setPendingOptimize`; `WidgetFigures` (`WidgetParts.tsx:60`).
- Produces:
  ```ts
  export function splitSavings(moves: readonly WishOptimizeMove[]): { priced: WishOptimizeMove[]; unpriced: number; total: number };
  export function moveCaption(move: WishOptimizeMove, currency: Currency): string;
  export function cutFooter(cut: readonly WishOptimizeMove[], currency: Currency): string;
  export function unpricedFooter(n: number): string;
  export function unpricedOnly(n: number, marketplace: Marketplace): string;
  export const NO_WISHES: string; export const ALL_CHEAPEST: string;
  export function WishlistSavingsWidget(props: WidgetBodyProps): ReactElement;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/home/widgets/WishlistSavingsWidget.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HomeWidget,
  OptimizePrinting,
  WishlistOptimizePlan,
  WishlistQuery,
  WishOptimizeMove,
} from "@/lib/ipc";

/**
 * The one read, typed, in front of an intact mirror. Cases with data seed the cache through the
 * exported `wishlistSavingsKey`; the stub answers what a cache cannot — a read out, a read refused,
 * and the re-issue a marketplace switch causes, which is also where the question itself is pinned.
 */
const wishlistOptimizePlan = vi.hoisted(() =>
  vi.fn<(query: WishlistQuery) => Promise<WishlistOptimizePlan>>(),
);
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, wishlistOptimizePlan } };
});

import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import { DEFAULT_MARKETPLACE, MARKETPLACES } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { wishlistSavingsKey } from "../keys";
import {
  ALL_CHEAPEST,
  cutFooter,
  moveCaption,
  NO_WISHES,
  splitSavings,
  unpricedFooter,
  unpricedOnly,
  WishlistSavingsWidget,
} from "./WishlistSavingsWidget";

function printingOf(over: Partial<OptimizePrinting> & { cardId: string }): OptimizePrinting {
  return { setCode: "2x2", collectorNumber: "117", lang: "en", price: 2.5, ...over };
}

/** One move. The default is the design's own row: pinned at $40.00, cheapest at $21.60. */
function move(over: Partial<WishOptimizeMove> & { wishId: number; name: string }): WishOptimizeMove {
  return {
    quantity: 1,
    preferredFinish: null,
    folderId: null,
    from: printingOf({ cardId: `from-${over.wishId}`, setCode: "lea", collectorNumber: "161", price: 40 }),
    to: printingOf({ cardId: `to-${over.wishId}`, price: 21.6 }),
    savedPerCopy: 18.4,
    saved: 18.4,
    ...over,
  };
}

function plan(
  moves: WishOptimizeMove[],
  over: Partial<Omit<WishlistOptimizePlan, "moves">> = {},
): WishlistOptimizePlan {
  return { moves, considered: moves.length + 3, alreadyCheapest: 3, skipped: 0, ...over };
}

const BOLT = move({ wishId: 1, name: "Lightning Bolt" });
const RING = move({
  wishId: 2,
  name: "Sol Ring",
  quantity: 2,
  from: printingOf({ cardId: "from-2", setCode: "c21", collectorNumber: "263", price: 5 }),
  to: printingOf({ cardId: "to-2", setCode: "cmm", collectorNumber: "410", price: 1.74 }),
  savedPerCopy: 3.26,
  saved: 6.52,
});
/** Pinned to a printing this marketplace does not list: a move, and no saving to count. */
const FROG = move({
  wishId: 3,
  name: "Psychic Frog",
  from: printingOf({ cardId: "from-3", setCode: "mh3", collectorNumber: "56", price: null }),
  savedPerCopy: null,
  saved: null,
});

function widget(): HomeWidget {
  return { id: "wishlistSavings", kind: "wishlistSavings", x: 0, y: 0, w: 3, h: 3, config: null };
}

function fitFor(w: number, h: number): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density: "comfortable" });
}

const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(answer: WishlistOptimizePlan) {
  qc.setQueryData(wishlistSavingsKey(DEFAULT_MARKETPLACE), answer);
}

function draw({ fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {}) {
  return render(
    <WishlistSavingsWidget
      widget={widget()}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  wishlistOptimizePlan.mockReset().mockResolvedValue(plan([]));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("splitSavings", () => {
  it("orders the priced moves by saving, counts the unpriced ones and sums only what is priced", () => {
    const split = splitSavings([FROG, RING, BOLT]);
    expect(split.priced.map((m) => m.name)).toEqual(["Lightning Bolt", "Sol Ring"]);
    expect(split.unpriced).toBe(1);
    expect(split.total).toBeCloseTo(24.92, 10);
  });

  it("settles a tie by name", () => {
    const beta = move({ wishId: 5, name: "Beta", saved: 5, savedPerCopy: 5 });
    const alpha = move({ wishId: 6, name: "Alpha", saved: 5, savedPerCopy: 5 });
    expect(splitSavings([beta, alpha]).priced.map((m) => m.name)).toEqual(["Alpha", "Beta"]);
  });

  /** A move with no current price is never summed as zero, and nothing reads `NaN`. */
  it("answers zero and no rows for moves none of which is priced", () => {
    expect(splitSavings([FROG])).toEqual({ priced: [], unpriced: 1, total: 0 });
    expect(splitSavings([])).toEqual({ priced: [], unpriced: 0, total: 0 });
  });
});

describe("the words", () => {
  it("captions a move with both prices per copy, and the copies when there are several", () => {
    expect(moveCaption(BOLT, "usd")).toBe("Pinned $40.00 · cheapest $21.60");
    expect(moveCaption(RING, "usd")).toBe("Pinned $5.00 · cheapest $1.74 · 2 copies");
  });

  it("says what the cut rows save, in the singular and the plural", () => {
    expect(cutFooter([BOLT], "usd")).toBe("1 more wish saves $18.40");
    expect(cutFooter([BOLT, RING], "eur")).toBe("2 more wishes save €24.92");
  });

  it("says the unpriced moves in their own line", () => {
    expect(unpricedFooter(1)).toBe("1 more has no current price");
    expect(unpricedFooter(2)).toBe("2 more have no current price");
  });

  it("says why there is no saving when no move is priced", () => {
    expect(unpricedOnly(1, MARKETPLACES.tcgplayer)).toBe(
      "1 pinned wish could move to a cheaper printing, but its current printing has no price at TCGplayer — so there is no saving to count.",
    );
    expect(unpricedOnly(3, MARKETPLACES.cardmarket)).toMatch(
      /^3 pinned wishes could move .* their current printings have no price at Cardmarket/,
    );
  });
});

describe("WishlistSavingsWidget", () => {
  describe("what it draws", () => {
    it("draws the figure, the moves biggest saving first, and the unpriced line", () => {
      seed(plan([FROG, RING, BOLT]));

      draw();

      expect(
        screen.getByRole("button", { name: "Could save $24.92 on 2 wishes · Optimise prices" }),
      ).toBeInTheDocument();
      expect(screen.getByText("$24.92")).toBeInTheDocument();
      const rows = screen.getAllByRole("listitem");
      expect(rows.map((row) => row.querySelector(".font-medium")?.textContent)).toEqual([
        "Lightning Bolt",
        "Sol Ring",
      ]);
      expect(
        screen.getByRole("button", {
          name: "Lightning Bolt · Pinned $40.00 · cheapest $21.60 · saves $18.40",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("1 more has no current price")).toBeInTheDocument();
      // Everything fitted, so there is no cut line.
      expect(screen.queryByText(/more wish(es)? save/)).toBeNull();
    });

    it("says what the rows that did not fit would save", () => {
      const eight = Array.from({ length: 8 }, (_, i) =>
        move({ wishId: 10 + i, name: `Wish ${i}`, saved: 1, savedPerCopy: 1 }),
      );
      seed(plan(eight));
      const fit = fitFor(3, 3);

      draw({ fit });

      // A captioned row is 51px; the figure line takes 74 and the cut line 22 before rows count.
      const shown = fit.rowsFit(51, 74 + 22);
      expect(shown).toBeLessThan(8);
      expect(screen.getAllByRole("listitem")).toHaveLength(shown);
      expect(
        screen.getByText(`${8 - shown} more wishes save ${formatPrice(8 - shown, "usd")}`),
      ).toBeInTheDocument();
    });

    it("moves the saving under the name on a two-cell tile", () => {
      seed(plan([BOLT]));

      draw({ fit: fitFor(2, 3) });

      const row = screen.getByRole("button", { name: /^Lightning Bolt · / });
      expect(row).toHaveTextContent("Lightning Bolt$18.40");
      expect(screen.queryByText("Pinned $40.00 · cheapest $21.60")).toBeNull();
    });

    /** The question: the whole list, flattened and unfiltered, at the reader's marketplace. */
    it("asks the plan about the whole wishlist", async () => {
      wishlistOptimizePlan.mockResolvedValue(plan([BOLT]));

      draw();

      expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
      expect(wishlistOptimizePlan).toHaveBeenCalledWith(wholeWishlistQuery(DEFAULT_MARKETPLACE));
    });

    it("asks again at a new marketplace rather than relabelling the old saving", async () => {
      seed(plan([BOLT]));
      qc.setQueryData(MARKETPLACE_KEY, "cardmarket");
      wishlistOptimizePlan.mockResolvedValue(
        plan([move({ wishId: 1, name: "Lightning Bolt", saved: 12, savedPerCopy: 12 })]),
      );

      draw();

      expect(screen.getByText("Pricing your pinned wishes…")).toBeInTheDocument();
      expect(screen.queryByText("$18.40")).toBeNull();
      expect(
        await screen.findByRole("button", { name: "Could save €12.00 on 1 wish · Optimise prices" }),
      ).toBeInTheDocument();
      expect(wishlistOptimizePlan).toHaveBeenCalledWith(wholeWishlistQuery("cardmarket"));
    });
  });

  describe("the states", () => {
    it("says it is pricing while the read is out", () => {
      wishlistOptimizePlan.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Pricing your pinned wishes…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      wishlistOptimizePlan.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not price your wishlist — The database is busy."),
      ).toBeInTheDocument();
    });

    it("says the wishlist is empty when the plan considered nothing", () => {
      seed(plan([], { considered: 0, alreadyCheapest: 0 }));

      draw();

      expect(screen.getByText(NO_WISHES)).toBeInTheDocument();
    });

    /** Only any-printing wishes answer here too: each is cheapest by construction. */
    it("says every pinned wish is already cheapest when there is no move", () => {
      seed(plan([], { considered: 4, alreadyCheapest: 4 }));

      draw();

      expect(screen.getByText(ALL_CHEAPEST)).toBeInTheDocument();
    });

    it("never reads $0.00 saved when no move can be priced", () => {
      seed(plan([FROG], { considered: 1, alreadyCheapest: 0 }));

      draw();

      expect(screen.getByText(unpricedOnly(1, MARKETPLACES.tcgplayer))).toBeInTheDocument();
      expect(screen.queryByText(/\$0\.00/)).toBeNull();
      expect(screen.queryByText("Could save")).toBeNull();
    });
  });

  describe("pressing", () => {
    function recordWrites(): string[] {
      const writes: string[] = [];
      const real = useAppStore.getState();
      useAppStore.setState({
        setActiveView: (view) => {
          writes.push(`view:${view}`);
          real.setActiveView(view);
        },
        setPendingOptimize: () => {
          writes.push("optimize");
          real.setPendingOptimize();
        },
      });
      return writes;
    }

    /** `setActiveView` clears every hand-off, so the view is written first. */
    it("opens the optimise dialog on the wishlist from a row, the view first", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed(plan([BOLT]));
      draw();

      await user.click(screen.getByRole("button", { name: /^Lightning Bolt · / }));

      expect(writes).toEqual(["view:wishlist", "optimize"]);
      expect(useAppStore.getState().activeView).toBe("wishlist");
      expect(useAppStore.getState().pendingOptimize).toBe(true);
    });

    it("opens the same dialog from the figure", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed(plan([BOLT]));
      draw();

      await user.click(screen.getByRole("button", { name: /^Could save / }));

      await waitFor(() => expect(writes).toEqual(["view:wishlist", "optimize"]));
    });

    it("draws a still body with no presses", () => {
      seed(plan([BOLT]));

      draw({ still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/home/widgets/WishlistSavingsWidget.test.tsx`
Expected: FAIL — `Failed to resolve import "./WishlistSavingsWidget"`.

- [ ] **Step 3: Implement**

Create `src/features/home/widgets/WishlistSavingsWidget.tsx`:

```tsx
/**
 * What moving the reader's pinned wishes to their cheapest printings would save — a figure, and the
 * moves that save most.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the popover and the Customize tray; this
 * draws the figure, the rows and two footer lines, cut to the box `fit` describes.
 *
 * ## No new command: the dialog's own plan, over the whole list
 *
 * `wishlist_optimize_plan` already answers, per pinned wish, both printings with their prices and
 * the saving (`WishOptimizeMove`). This asks it about **the whole wishlist** —
 * `wholeWishlistQuery`, flattened, no filters, at the reader's marketplace — which is the same value
 * `WishlistPage` hands the dialog when a press here lands there, so the dialog offers exactly what
 * this card counted. The marketplace decides every figure, so it is in the key.
 *
 * **What it inherits from the plan and does not paper over**: wishes in a deck's managed wishlist
 * and digital printings are skipped (`wishlist_optimize.rs:201-204, 270`), and the cheaper printing
 * may be in another language — the plan has no language filter. The card says what the dialog will
 * offer; a language rule, if one is wanted, belongs to the plan and both surfaces.
 *
 * ## Money that is not there is said, never summed
 *
 * `saved` is `null` exactly when `from.price` is — a wish whose printing this marketplace does not
 * list. {@link splitSavings} leaves those out of the figure and counts them for a line of their own
 * (`2 more have no current price`); a card whose moves are *all* like that says so in a sentence
 * rather than drawing `Could save $0.00`. The figure is gold and everything else body ink —
 * `WidgetParts.tsx`'s rule.
 *
 * ## Three empty sentences
 *
 * `considered` is **every** wish the plan scanned — an any-printing wish is counted in
 * `alreadyCheapest` (`wishlist_optimize.rs:276-288`) — so `considered === 0` is an empty wishlist,
 * not a list with nothing pinned. No move at all is *every pinned wish is already cheapest*, which is
 * also the true answer for a list of any-printing wishes. And moves none of which is priced is the
 * third.
 *
 * ## A press opens the dialog
 *
 * A row or the figure writes `setActiveView("wishlist")` and then `setPendingOptimize()` — the view
 * first, because the view change clears every hand-off — and `WishlistPage` opens
 * `OptimizeWishlistDialog` over the whole list without touching the reader's own flatten setting.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { wholeWishlistQuery } from "@/features/wishlist/wholeWishlistQuery";
import { count, plural } from "@/lib/counts";
import { ipc, ipcError, type WishOptimizeMove } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";

import { wishlistSavingsKey } from "../keys";
import {
  WidgetFigures,
  WidgetFooter,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
} from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx:55-57`'s sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;
/** The figure line, comfortable and compact — `CollectionValueWidget.tsx:98-99`'s two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;
/** One footer line and the gap above it. */
const FOOTER_PX = 22;

const PENDING = "Pricing your pinned wishes…";
export const NO_WISHES =
  "Nothing on your wishlist yet — pin a wish to a printing and this card looks for a cheaper one.";
export const ALL_CHEAPEST =
  "Every pinned wish is already on its cheapest printing, and a wish for any printing always is.";

/**
 * The moves split by whether they can be priced: the priced ones **biggest saving first** (ties by
 * name, through `sortOptions`, which copies), how many cannot be, and the sum of what can. A move
 * with no `saved` is never added as zero.
 */
export function splitSavings(moves: readonly WishOptimizeMove[]): {
  priced: WishOptimizeMove[];
  unpriced: number;
  total: number;
} {
  const priced = sortOptions(
    moves.filter((move) => move.saved !== null),
    (move) => move.name,
    (move) => [-(move.saved ?? 0)],
  );
  const total = priced.reduce((sum, move) => sum + (move.saved ?? 0), 0);
  return { priced, unpriced: moves.length - priced.length, total };
}

/** `Pinned $40.00 · cheapest $21.60` — both prices per copy — and the copies when there are more
 *  than one, so a saving twice the difference reads as what it is. */
export function moveCaption(move: WishOptimizeMove, currency: Currency): string {
  const base = `Pinned ${formatPrice(move.from.price, currency)} · cheapest ${formatPrice(move.to.price, currency)}`;
  return move.quantity > 1 ? `${base} · ${count(move.quantity)} copies` : base;
}

/** The moves that did not fit: `4 more wishes save $11.45`. */
export function cutFooter(cut: readonly WishOptimizeMove[], currency: Currency): string {
  const sum = cut.reduce((total, move) => total + (move.saved ?? 0), 0);
  const n = cut.length;
  return `${count(n)} more ${n === 1 ? "wish saves" : "wishes save"} ${formatPrice(sum, currency)}`;
}

/** The moves with no current price, on their own line: `2 more have no current price`. */
export function unpricedFooter(n: number): string {
  return `${count(n)} more ${n === 1 ? "has" : "have"} no current price`;
}

/** Moves exist and none of them can be priced — a sentence, never `Could save $0.00`. */
export function unpricedOnly(n: number, marketplace: Marketplace): string {
  return `${plural(n, "pinned wish", "pinned wishes")} could move to a cheaper printing, but ${
    n === 1 ? "its current printing has" : "their current printings have"
  } no price at ${marketplace.label} — so there is no saving to count.`;
}

export function WishlistSavingsWidget({ fit, still }: WidgetBodyProps): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingOptimize = useAppStore((s) => s.setPendingOptimize);

  const query = useQuery({
    queryKey: wishlistSavingsKey(marketplace.id),
    queryFn: () => ipc.wishlistOptimizePlan(wholeWishlistQuery(marketplace.id)),
  });

  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not price your wishlist — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;

  const plan = query.data;
  if (plan.considered === 0) return <WidgetMessage>{NO_WISHES}</WidgetMessage>;
  if (plan.moves.length === 0) return <WidgetMessage>{ALL_CHEAPEST}</WidgetMessage>;
  const { priced, unpriced, total } = splitSavings(plan.moves);
  if (priced.length === 0) return <WidgetMessage>{unpricedOnly(unpriced, marketplace)}</WidgetMessage>;

  /**
   * The furniture is reserved before the rows are laid in — the figure line, the unpriced line when
   * there is one, and the cut line **only when rows are cut**, which is known only once the rows
   * without it are counted. The second count can only shrink, so the cut line is never drawn into
   * space nothing reserved.
   */
  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const rowH = captioned ? ROW_CAPTIONED : ROW_BARE;
  const base = (fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX) + (unpriced > 0 ? FOOTER_PX : 0);
  const all = fit.rowsFit(rowH, base);
  const room = priced.length > all ? fit.rowsFit(rowH, base + FOOTER_PX) : all;
  const shown = priced.slice(0, room);
  const cut = priced.slice(room);

  const openOptimise = still
    ? undefined
    : () => {
        setActiveView("wishlist");
        setPendingOptimize();
      };
  const totalText = formatPrice(total, currency);
  const wishes = plural(priced.length, "wish", "wishes");

  return (
    <>
      <WidgetFigures
        fit={fit}
        divided
        figures={[
          {
            key: "saved",
            label: "Could save",
            value: totalText,
            note: `on ${wishes}`,
            tone: "accent",
            hint: pricesAsOf(marketplace),
            onPress: openOptimise,
            pressLabel:
              openOptimise === undefined ? undefined : `Could save ${totalText} on ${wishes} · Optimise prices`,
          },
        ]}
      />
      <WidgetRowList fit={fit} label="Wishes that could cost less">
        {shown.map((move) => {
          const saved = formatPrice(move.saved, currency);
          const caption = moveCaption(move, currency);
          // The whole row in one string (`DecksWidget.tsx:314-321`), saying what the figure is.
          const pressLabel =
            openOptimise === undefined ? undefined : `${move.name} · ${caption} · saves ${saved}`;
          return tile ? (
            <WidgetRow
              key={move.wishId}
              name={move.name}
              caption={saved}
              captionStrong
              onPress={openOptimise}
              pressLabel={pressLabel}
            />
          ) : (
            <WidgetRow
              key={move.wishId}
              name={move.name}
              caption={captioned ? caption : undefined}
              value={saved}
              onPress={openOptimise}
              pressLabel={pressLabel}
            />
          );
        })}
      </WidgetRowList>
      {cut.length > 0 && <WidgetFooter>{cutFooter(cut, currency)}</WidgetFooter>}
      {unpriced > 0 && <WidgetFooter>{unpricedFooter(unpriced)}</WidgetFooter>}
    </>
  );
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/features/home/widgets/WishlistSavingsWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the stories**

Create `src/features/home/widgets/WishlistSavingsWidget.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { ipc, type HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { ALL_CHEAPEST, NO_WISHES, WishlistSavingsWidget } from "./WishlistSavingsWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/** How long a play waits for the staged wishes and the plan to land. Not exported, for CSF. */
const LANDED = { timeout: 5_000 };

/**
 * Three printings of the generated corpus (`.storybook/fake/cards.ts`), named by id because that is
 * what a pinned wish stores: Alpha's Lightning Bolt at $620.00, Secret Lair's at $3.03 — both with a
 * cheaper printing, Double Masters 2022's at $2.50 — and Secret Lair's Sol Ring, which carries no
 * price at any marketplace, so its move has no saving to count. Not exported, for CSF.
 */
const LEA_BOLT = "d573ef03-4730-45aa-93dd-e45ac1dbaf4a";
const SLD_BOLT = "4f43c378-9e6a-4ece-9c24-5dc08c977746";
const SLD_SOL_RING = "16a2c470-b2b8-4633-89b1-7b936bcaff8d";

function savings(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "wishlistSavings", kind: "wishlistSavings", x: 0, y: 0, w, h, config };
}

function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({ w: widget.w, h: widget.h, widthPx, heightPx, density: widgetDensity(widget) });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <WishlistSavingsWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/**
 * `starter`'s pinned wishes are each already on their cheapest printing — every one has a single
 * printing in the corpus, or none cheaper — so the savings are **written through the command** a
 * reader's `+` makes: three pinned wishes at the root, `DecksPage.stories.tsx`'s `OrphanedCover`
 * idiom. `useQuery` so it runs once per story client, and the card is held back until they land.
 */
function WithSavings({ children }: { children: ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "wishlist-savings"],
    queryFn: async () => {
      await ipc.wishlistAdd({ cardId: LEA_BOLT, quantity: 1 });
      await ipc.wishlistAdd({ cardId: SLD_BOLT, quantity: 2 });
      await ipc.wishlistAdd({ cardId: SLD_SOL_RING, quantity: 1 });
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children}</> : null;
}

const meta = {
  title: "Home/WishlistSavingsWidget",
  component: Framed,
  tags: ["autodocs"],
  args: { widget: savings(3, 3) },
  render: (args) => (
    <WithSavings>
      <Framed {...args} />
    </WithSavings>
  ),
  parameters: {
    docs: {
      description: {
        component:
          "What moving the pinned wishes to their cheapest printings would save — the optimise " +
          "dialog's own plan, asked about the **whole** wishlist at the reader's marketplace. The " +
          "figure is gold; the rows are the biggest savings first, each captioned with both " +
          "prices per copy.\n\n" +
          "**A move with no current price is never summed as zero**: it is counted on its own " +
          "line, and a card whose moves are all like that says so in a sentence. A press — a row " +
          "or the figure — opens the dialog on the wishlist, over the whole list.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two priced moves and one the marketplace cannot price. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist savings" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Could save \$[\d,.]+ on 2 wishes · Optimise prices$/ }, LANDED),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", {
        name: /^Lightning Bolt · Pinned \$620\.00 · cheapest \$2\.50 · saves /,
      }),
    ).toBeInTheDocument();
    await expect(card.getByText("1 more has no current price")).toBeInTheDocument();
  },
};

/** A two-cell tile: each saving moved under its wish's name. */
export const Tile: Story = {
  args: { widget: savings(2, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist savings" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Lightning Bolt · / }, LANDED),
    ).toBeInTheDocument();
    await expect(card.queryByText(/^Pinned /)).not.toBeInTheDocument();
  },
};

/** `starter` as it is: every pinned wish is already on its cheapest printing. */
export const EveryWishCheapest: Story = {
  render: (args) => <Framed {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(ALL_CHEAPEST, {}, LANDED)).toBeInTheDocument();
  },
};

/** An empty wishlist. */
export const NoWishes: Story = {
  parameters: { fake: { seed: "empty" } },
  render: (args) => <Framed {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_WISHES, {}, LANDED)).toBeInTheDocument();
  },
};

/** A catalogue preview: the figure and the rows as pictures, nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist savings" }, LANDED));
    await expect(await card.findByText("Could save", {}, LANDED)).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Could save / })).toBeNull();
  },
};
```

- [ ] **Step 6: Typecheck** (`npx tsc --noEmit -p .`)

Run: `npx tsc --noEmit -p .` then `npx eslint src/features/home/widgets/WishlistSavingsWidget.tsx src/features/home/widgets/WishlistSavingsWidget.test.tsx src/features/home/widgets/WishlistSavingsWidget.stories.tsx`
Expected: no errors.

---

### Task 10 (W4): Coming soon (`ComingSoonWidget`)

Spec §6.2. Sets with previewed cards that have not released yet, soonest first, with two count
figures and a row per set that opens the set in the search.

**The face is its own exported component, `ComingSoonFace`, and that is forced by the
workbench.** The fake's "today" is `CLOCK_BASE` (`.storybook/fake/db.ts:8101`, 2026-08-09) and the
generated corpus's latest paper card is 2026-06-26 — its one later row, `thob 13`, is a token the
read excludes — so **no world the fake can stand up has anything announced**, in any window, and
the corpus is generated wholesale (no hand-written card rows). The body reads; `ComingSoonFace`
draws an answer; the full-face stories draw the face from a constructed `UpcomingSets`, which is
`OptimizeWishlistDialog.stories.tsx`'s precedent for a constructed answer.

**Files:**
- Create: `src/features/home/widgets/ComingSoonWidget.tsx`
- Test: `src/features/home/widgets/ComingSoonWidget.test.tsx`
- Create: `src/features/home/widgets/ComingSoonWidget.stories.tsx`

**Interfaces:**
- Consumes: `ipc.upcomingSets(days)` under `upcomingSetsKey(days)`; `pickOf(widget, "window")`;
  `useAppStore`'s `showSetInSearch` (`store.ts:825`, `:1633-1636` — the view change and the
  hand-off in one action, and it puts the format picker on `Any card`); `WidgetFigures`,
  `WidgetRowList`, `WidgetRow`.
- Produces:
  ```ts
  export function daysUntil(today: string, releasedAt: string): number;   // UTC, whole days
  export function whenLabel(days: number): string;
  export function setCaption(set: UpcomingSet, today: string): string;
  export function windowWords(days: number): string;
  export function emptySentence(days: number): string;
  export function ComingSoonFace(props: { answer: UpcomingSets; days: number; fit: WidgetFit; still: boolean }): ReactElement;
  export function ComingSoonWidget(props: WidgetBodyProps): ReactElement;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/home/widgets/ComingSoonWidget.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeWidget, UpcomingSet, UpcomingSets } from "@/lib/ipc";

/** The one read, typed, in front of an intact mirror. Cases with data seed `upcomingSetsKey`. */
const upcomingSets = vi.hoisted(() => vi.fn<(days: number) => Promise<UpcomingSets>>());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, upcomingSets } };
});

import { useAppStore } from "@/lib/store";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { upcomingSetsKey } from "../keys";
import {
  ComingSoonWidget,
  daysUntil,
  emptySentence,
  setCaption,
  whenLabel,
  windowWords,
} from "./ComingSoonWidget";

/** The UTC date the read used. Every expectation is counted from this, never from the clock. */
const TODAY = "2026-09-26";

function upcoming(over: Partial<UpcomingSet> & { code: string; name: string; releasedAt: string }): UpcomingSet {
  return { previewed: 10, inDecks: 0, ...over };
}

/** Soonest first, the order the read answers in. Constructed — no real set is being described. */
const GLASS = upcoming({ code: "gls", name: "Glass Tides", releasedAt: "2026-09-27", previewed: 12 });
const TREK = upcoming({
  code: "trk",
  name: "Horizon Trek",
  releasedAt: "2026-10-08",
  previewed: 79,
  inDecks: 3,
});
const ASH = upcoming({
  code: "ash",
  name: "Echoes of Ash",
  releasedAt: "2026-12-04",
  previewed: 5,
  inDecks: 1,
});

const ANSWER: UpcomingSets = { today: TODAY, sets: [GLASS, TREK, ASH] };

function widget(config: unknown = null): HomeWidget {
  return { id: "comingSoon", kind: "comingSoon", x: 0, y: 0, w: 4, h: 4, config };
}

function fitFor(w: number, h: number): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density: "comfortable" });
}

/** Four cells wide is two list columns, and room for every row. */
const ROOMY = fitFor(4, 4);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {},
) {
  return render(
    <ComingSoonWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

function drawnNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

beforeEach(() => {
  upcomingSets.mockReset().mockResolvedValue({ today: TODAY, sets: [] });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("daysUntil", () => {
  it("counts whole days between two calendar dates", () => {
    expect(daysUntil(TODAY, "2026-10-08")).toBe(12);
    expect(daysUntil(TODAY, "2026-09-27")).toBe(1);
    expect(daysUntil(TODAY, "2026-12-04")).toBe(69);
  });

  /** Both dates are read as UTC midnights, so a daylight-saving change is not an hour short. */
  it("crosses a month, a year, a leap day and a clock change without drifting", () => {
    expect(daysUntil("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysUntil("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysUntil("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysUntil("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysUntil("2026-10-24", "2026-10-26")).toBe(2);
  });
});

describe("the words", () => {
  it("says tomorrow for one day and counts the rest", () => {
    expect(whenLabel(1)).toBe("tomorrow");
    expect(whenLabel(12)).toBe("in 12 days");
    expect(whenLabel(0)).toBe("today");
    expect(whenLabel(Number.NaN)).toBe("date unknown");
  });

  it("captions a set, naming the deck cards only when there are some", () => {
    expect(setCaption(TREK, TODAY)).toBe("TRK · in 12 days · 79 seen · 3 in your decks");
    expect(setCaption(GLASS, TODAY)).toBe("GLS · tomorrow · 12 seen");
    expect(
      setCaption(upcoming({ code: "big", name: "Big", releasedAt: "2026-10-01", previewed: 1234 }), TODAY),
    ).toBe("BIG · in 5 days · 1,234 seen");
  });

  it("says the window in its own words", () => {
    expect(windowWords(30)).toBe("30 days");
    expect(windowWords(90)).toBe("90 days");
    expect(windowWords(365)).toBe("year");
    expect(emptySentence(90)).toBe("Nothing announced for the next 90 days.");
    expect(emptySentence(365)).toBe("Nothing announced for the next year.");
  });
});

describe("ComingSoonWidget", () => {
  describe("what it draws", () => {
    it("draws the two figures and a row per set, soonest first, in the card's columns", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);

      draw();

      expect(screen.getByText("Previewed so far")).toBeInTheDocument();
      expect(screen.getByText("96")).toBeInTheDocument();
      expect(screen.getByText("cards")).toBeInTheDocument();
      expect(screen.getByText("Reprints of your deck cards")).toBeInTheDocument();
      expect(screen.getByText("4")).toBeInTheDocument();
      expect(drawnNames()).toEqual(["Glass Tides", "Horizon Trek", "Echoes of Ash"]);
      expect(
        screen.getByRole("button", {
          name: "Horizon Trek · TRK · in 12 days · 79 seen · 3 in your decks",
        }),
      ).toBeInTheDocument();
      // The inline template `WidgetRowList` writes — read off `.style`, as
      // `DeckNotesPanel.test.tsx:324` does, rather than through a computed style jsdom lays out.
      expect(screen.getByRole("list", { name: "Announced sets" }).style.gridTemplateColumns).toBe(
        "repeat(2, minmax(0, 1fr))",
      );
      expect(ROOMY.listColumns).toBe(2);
    });

    it("cuts the list to the rows the box holds", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);
      const fit = fitFor(4, 2);

      draw(null, { fit });

      // A captioned row is 51px, and the figure line takes 74 before rows are counted.
      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(51, 74));
      expect(fit.rowsFit(51, 74)).toBeLessThan(3);
    });

    it("shortens the caption to the code and the day on a two-cell tile", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);

      draw(null, { fit: fitFor(2, 4) });

      expect(screen.getByText("GLS · tomorrow")).toBeInTheDocument();
      expect(screen.queryByText("GLS · tomorrow · 12 seen")).toBeNull();
    });

    it("asks for the window the reader picked", async () => {
      draw({ window: 30 });

      await waitFor(() => expect(upcomingSets).toHaveBeenCalledWith(30));
      expect(await screen.findByText("Nothing announced for the next 30 days.")).toBeInTheDocument();
    });

    /** A word no option carries reads as the registry's default, never as the backend's clamp. */
    it("reads a stored window it does not offer as ninety days", async () => {
      draw({ window: "90" });

      await waitFor(() => expect(upcomingSets).toHaveBeenCalledWith(90));
    });
  });

  describe("the states", () => {
    it("says it is looking while the read is out", () => {
      upcomingSets.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Looking for announced sets…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      upcomingSets.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not read what is announced — The database is busy."),
      ).toBeInTheDocument();
    });

    it.each([
      [30, "Nothing announced for the next 30 days."],
      [90, "Nothing announced for the next 90 days."],
      [365, "Nothing announced for the next year."],
    ])("says nothing is announced in a %i-day window, in its own words", (days, sentence) => {
      qc.setQueryData(upcomingSetsKey(days), { today: TODAY, sets: [] });

      draw({ window: days });

      expect(screen.getByText(sentence)).toBeInTheDocument();
    });
  });

  describe("pressing a set", () => {
    /** `showSetInSearch` is the view change and the hand-off in one action, in the order that
     *  survives — so the body makes one call and the store's own test owns the order. */
    it("shows the set in the search", async () => {
      const user = userEvent.setup();
      const calls: string[] = [];
      const real = useAppStore.getState().showSetInSearch;
      useAppStore.setState({
        showSetInSearch: (code) => {
          calls.push(code);
          real(code);
        },
      });
      qc.setQueryData(upcomingSetsKey(90), ANSWER);
      draw();

      await user.click(screen.getByRole("button", { name: /^Horizon Trek · / }));

      expect(calls).toEqual(["trk"]);
      expect(useAppStore.getState().activeView).toBe("search");
      expect(useAppStore.getState().pendingSearchSet).toBe("trk");
    });

    it("draws a still body with no presses", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);

      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Horizon Trek")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/home/widgets/ComingSoonWidget.test.tsx`
Expected: FAIL — `Failed to resolve import "./ComingSoonWidget"`.

- [ ] **Step 3: Implement**

Create `src/features/home/widgets/ComingSoonWidget.tsx`:

```tsx
/**
 * Sets whose cards are previewed and not yet released — a row per set, soonest first — with how
 * many of their cards are out and how many of those the reader's decks already play.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the `Window` chip, the popover and the
 * Customize tray; this draws two figures and the rows, cut to the box `fit` describes.
 *
 * ## Over the corpus's own dates, counted in UTC
 *
 * `upcoming_sets` reads `cards` rather than `sets` — the browser build never fills `sets` — and
 * "today" is SQLite's `date('now')`, which is UTC and **travels back beside the list**
 * (`UpcomingSets.today`). Days are counted from that date and never from this machine's clock
 * ({@link daysUntil}): a reader west of Greenwich in the evening would otherwise read a set as a
 * day nearer than the read that found it, and one list would disagree with itself. Both dates are
 * parsed as `T00:00:00Z` and the release day in a row's hint is formatted with `timeZone: "UTC"`,
 * `NewPrintingsWidget.tsx:167-191`'s rule and its reason: `releasedAt` is a calendar date, and a
 * formatter left on the local zone prints the day before it for everyone west of Greenwich.
 *
 * **A fold, never a sort**: the read answers soonest first, then by code, and re-ordering here would
 * be a second opinion about a question SQL has answered.
 *
 * ## Counts are body ink
 *
 * `Previewed so far` and `Reprints of your deck cards` are counts, so neither is gold —
 * `WidgetParts.tsx`'s rule that the accent is money. The second is the sum of `in_decks`, which is
 * `new_printings`' rule for "your decks": not virtual, live and theory rows, basics left out.
 *
 * ## A press shows the set
 *
 * `showSetInSearch(code)` is the view change and the hand-off in one store action, so no caller can
 * write them in the order that wipes the second — and it puts the format picker on `Any card`, so
 * legality does not hide a card that is not legal anywhere yet (`useCardSearch.ts:1635-1647`).
 *
 * ## The face is its own component
 *
 * {@link ComingSoonFace} draws an answer and {@link ComingSoonWidget} reads one. The split exists
 * for the workbench: the fake's clock is 2026-08-09 and its generated corpus holds no paper card
 * dated after it, so no world the fake can stand up has anything announced, and the full face can
 * only be drawn there from a constructed answer.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { count } from "@/lib/counts";
import { ipc, ipcError, type UpcomingSet, type UpcomingSets } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

import type { WidgetFit } from "../fit";
import { upcomingSetsKey } from "../keys";
import { WidgetFigures, WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf } from "../widgetSettings";

const DAY_MS = 86_400_000;

/**
 * The window a card reads when its stored one is not a number — the registry's `dflt`, which
 * `pickOf` already answers for everything but a kind whose pick is not numeric. Restated only so
 * the type narrows, `NewPrintingsWidget.tsx:154`'s `WINDOW_FALLBACK`.
 */
const WINDOW_FALLBACK = 90;

/** A row is a name over a caption, 51px — `SetCompletionWidget.tsx:55-57`'s sum. */
const ROW_PX = 51;
/** The figure line, comfortable and compact — `CollectionValueWidget.tsx:98-99`'s two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;

const PENDING = "Looking for announced sets…";

/** A release day in words, in UTC — see the module doc. */
const RELEASE_DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** Whole days from the read's own `today` to a set's release — both UTC midnights, so a clock
 *  change is never an hour short of a day. */
export function daysUntil(today: string, releasedAt: string): number {
  return Math.round(
    (Date.parse(`${releasedAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
}

/** `tomorrow`, `in 12 days`. `today` and `date unknown` are the read's contract failing, said
 *  plainly rather than as `in 0 days` or `in NaN days`. */
export function whenLabel(days: number): string {
  if (!Number.isFinite(days)) return "date unknown";
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** `TRK · in 12 days · 79 seen · 3 in your decks` — the last clause only when there is one. */
export function setCaption(set: UpcomingSet, today: string): string {
  const parts = [
    set.code.toUpperCase(),
    whenLabel(daysUntil(today, set.releasedAt)),
    `${count(set.previewed)} seen`,
  ];
  if (set.inDecks > 0) parts.push(`${count(set.inDecks)} in your decks`);
  return parts.join(" · ");
}

/** The window as the empty sentence says it: `90 days`, or `year` for the widest. */
export function windowWords(days: number): string {
  return days === 365 ? "year" : `${days} days`;
}

/** `Nothing announced for the next 90 days.` — the window's own words (spec §6.2). */
export function emptySentence(days: number): string {
  return `Nothing announced for the next ${windowWords(days)}.`;
}

/** The release day in words for a row's hint, or nothing for a date that does not parse. */
function releaseHint(set: UpcomingSet): string | undefined {
  const at = Date.parse(`${set.releasedAt}T00:00:00Z`);
  return Number.isFinite(at) ? `Releases ${RELEASE_DAY.format(new Date(at))}` : undefined;
}

/**
 * One answer, drawn: the empty sentence, or the two figures over the rows.
 *
 * **Rows flow into `fit.listColumns` columns** (`WidgetRowList`), and are cut to whole rows after
 * the figure line is reserved. On a two-cell tile the caption keeps the two clauses that tell sets
 * apart — the code and the day — and drops the counts the figures already sum.
 */
export function ComingSoonFace({
  answer,
  days,
  fit,
  still,
}: {
  answer: UpcomingSets;
  days: number;
  fit: WidgetFit;
  still: boolean;
}): ReactElement {
  const showSetInSearch = useAppStore((s) => s.showSetInSearch);

  if (answer.sets.length === 0) return <WidgetMessage>{emptySentence(days)}</WidgetMessage>;

  const previewed = answer.sets.reduce((sum, set) => sum + set.previewed, 0);
  const inDecks = answer.sets.reduce((sum, set) => sum + set.inDecks, 0);
  const tile = fit.tier === 0;
  const shown = answer.sets.slice(
    0,
    fit.rowsFit(ROW_PX, fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX),
  );

  return (
    <>
      <WidgetFigures
        fit={fit}
        divided
        figures={[
          {
            key: "previewed",
            label: "Previewed so far",
            value: count(previewed),
            note: "cards",
            tone: "text",
          },
          { key: "reprints", label: "Reprints of your deck cards", value: count(inDecks), tone: "text" },
        ]}
      />
      <WidgetRowList fit={fit} label="Announced sets">
        {shown.map((set) => {
          const caption = setCaption(set, answer.today);
          return (
            <WidgetRow
              key={set.code}
              name={set.name}
              caption={
                tile
                  ? `${set.code.toUpperCase()} · ${whenLabel(daysUntil(answer.today, set.releasedAt))}`
                  : caption
              }
              hint={releaseHint(set)}
              onPress={still ? undefined : () => showSetInSearch(set.code)}
              // The whole row in one string — a `gap` between the name and the caption computes to
              // "Horizon TrekTRK · in 12 days" (`DecksWidget.tsx:314-321`).
              pressLabel={still ? undefined : `${set.name} · ${caption}`}
            />
          );
        })}
      </WidgetRowList>
    </>
  );
}

export function ComingSoonWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  // The pick only ever answers one of its own options or its `dflt`, so a stored `"90"` or `9999`
  // reads as ninety here and never reaches the backend's clamp.
  const picked = pickOf(widget, "window");
  const days = typeof picked === "number" ? picked : WINDOW_FALLBACK;

  const query = useQuery({
    queryKey: upcomingSetsKey(days),
    queryFn: () => ipc.upcomingSets(days),
  });

  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read what is announced — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  return <ComingSoonFace answer={query.data} days={days} fit={fit} still={still} />;
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/features/home/widgets/ComingSoonWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the stories**

Create `src/features/home/widgets/ComingSoonWidget.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget, UpcomingSets } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { ComingSoonFace, ComingSoonWidget } from "./ComingSoonWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/**
 * An answer, **constructed** — the sets are invented and describe no real release. The fake's
 * clock is 2026-08-09 and its generated corpus has no paper card dated after it, so no seed can
 * make `upcoming_sets` answer a row; the face is drawn from this instead, which is
 * `OptimizeWishlistDialog.stories.tsx`'s precedent for a constructed answer. Five sets so a band
 * has two columns to fill and a whole row has four. Not exported, for CSF.
 */
const ANNOUNCED: UpcomingSets = {
  today: "2026-09-26",
  sets: [
    { code: "gls", name: "Glass Tides", releasedAt: "2026-09-27", previewed: 12, inDecks: 0 },
    { code: "trk", name: "Horizon Trek", releasedAt: "2026-10-08", previewed: 79, inDecks: 3 },
    { code: "emb", name: "Ember Court", releasedAt: "2026-10-30", previewed: 41, inDecks: 0 },
    { code: "ash", name: "Echoes of Ash", releasedAt: "2026-12-04", previewed: 5, inDecks: 1 },
    { code: "vlt", name: "Vault Relics", releasedAt: "2026-12-18", previewed: 164, inDecks: 7 },
  ],
};

function coming(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "comingSoon", kind: "comingSoon", x: 0, y: 0, w, h, config };
}

function fitOf(widget: HomeWidget) {
  return makeFit({
    w: widget.w,
    h: widget.h,
    widthPx: spanPx(widget.w, CELL),
    heightPx: spanPx(widget.h, CELL),
    density: widgetDensity(widget),
  });
}

/** The whole body inside the real card, reading through the fake. */
function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const fit = fitOf(widget);
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: fit.widthPx, height: fit.heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <ComingSoonWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/** The face inside the real card, drawn from {@link ANNOUNCED} — see there for why. */
function FramedFace({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const fit = fitOf(widget);
  return (
    <div className="p-2">
      <div style={{ width: fit.widthPx, height: fit.heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={fn()}
          onRemove={fn()}
        >
          <ComingSoonFace answer={ANNOUNCED} days={90} fit={fit} still={still} />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/ComingSoonWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint: four cells by two, ninety days.
    widget: coming(4, 2),
  },
  parameters: {
    docs: {
      description: {
        component:
          "Sets with previewed cards that have not released yet, soonest first — read from " +
          "`cards` rather than `sets`, which the browser build never fills. Two count figures " +
          "(body ink, not gold) and a row per set whose caption is its code, how far off it is " +
          "in UTC days from the read's own date, how many of its cards are out and — only when " +
          "there are some — how many your decks already play. A press shows the set in the " +
          "search with the format picker on `Any card`.\n\n" +
          "The full faces below are drawn from a **constructed** answer: the workbench's corpus " +
          "has no paper card dated after its clock, so the fake can only ever answer the empty " +
          "sentence, which is the last two stories.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default footprint: the figures, and the rows the box has room for. */
export const Default: Story = {
  render: (args) => <FramedFace {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(card.getByText("Previewed so far")).toBeInTheDocument();
    await expect(
      card.getByRole("button", { name: "Glass Tides · GLS · tomorrow · 12 seen" }),
    ).toBeInTheDocument();
  },
};

/** A whole row, three tall: every set, four columns across. */
export const WholeRow: Story = {
  args: { widget: coming(8, 3) },
  render: (args) => <FramedFace {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(
      card.getByRole("button", { name: "Vault Relics · VLT · in 83 days · 164 seen · 7 in your decks" }),
    ).toBeInTheDocument();
  },
};

/** A two-cell tile: the caption keeps the code and the day. */
export const Tile: Story = {
  args: { widget: coming(2, 3) },
  render: (args) => <FramedFace {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(card.getByText("GLS · tomorrow")).toBeInTheDocument();
  },
};

/** A catalogue preview: the rows as pictures, nothing to press. */
export const Still: Story = {
  args: { still: true },
  render: (args) => <FramedFace {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(card.getByText("Glass Tides")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Glass Tides · / })).toBeNull();
  },
};

/** Through the fake, which has nothing announced: the window's own words. */
export const NothingAnnounced: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Nothing announced for the next 90 days."),
    ).toBeInTheDocument();
  },
};

/** The widest window says `year`, not `365 days`. */
export const NothingInAYear: Story = {
  args: { widget: coming(4, 2, { window: 365 }) },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Nothing announced for the next year.")).toBeInTheDocument();
  },
};
```

- [ ] **Step 6: Typecheck** (`npx tsc --noEmit -p .`)

Run: `npx tsc --noEmit -p .` then `npx eslint src/features/home/widgets/ComingSoonWidget.tsx src/features/home/widgets/ComingSoonWidget.test.tsx src/features/home/widgets/ComingSoonWidget.stories.tsx`
Expected: no errors.

---

### Task 11 (W5): Wiring — the four arms in `HomePage.tsx`, and the page's fences

Runs after W1–W4 have landed in the tree. **The one edit to `HomePage.tsx` in this plan.** Both of
the page's switches are over `widget.kind`, a free `string` with a `default` arm, so a missing
`case` compiles, type-checks and silently draws the *newer build* placeholder for a kind this build
owns — `HomePage.test.tsx:218-238` is the fence for `newPrintings`, and this task extends it to the
four new kinds. The catalogue needs no edit: it renders `WIDGETS` through the page's own
`renderBody` (`WidgetCatalogue.tsx:186`), so each new kind is previewed as its real body with
`still: true` the moment its arm exists — which is why W1–W4 each proved their body writes nothing
and opens nothing while `still`.

**Files:**
- Modify: `src/features/home/HomePage.tsx` (imports; `renderBody`, `:215-242`; `renderExtraSettings`, `:246-259`)
- Test: `src/features/home/HomePage.test.tsx` (the body mocks, `:44-80`; two new cases)
- Modify: `src/features/home/HomePage.stories.tsx` (`CatalogueOpen`'s label loop, `:192-195`)

**Interfaces:**
- Consumes: `DeckCompletionWidget`, `ToReviewWidget`, `WishlistSavingsWidget`,
  `ComingSoonWidget` (W1–W4) and `DecksWidgetSettings` (`DecksWidget.tsx:351`).
- Produces: `renderBody` answers the four kinds; `renderExtraSettings` answers `deckCompletion`
  with `DecksWidgetSettings` — the Decks widget's pin checklist, **reused, not copied** (spec
  §2.1). Nothing is exported that was not before.

- [ ] **Step 1: Write the failing test**

In `src/features/home/HomePage.test.tsx`, replace the `DecksWidget` mock so its settings stub says
something a test can find (the page draws it for two kinds now, and `null` cannot tell "drawn" from
"not drawn"):

Replace:

```tsx
vi.mock("./widgets/DecksWidget", () => ({
  DecksWidget: stubs.body,
  DecksWidgetSettings: stubs.settings,
}));
```

with:

```tsx
/**
 * **A settings stub that says something**, `NewPrintingsWidget`'s below and for its reason: the
 * page hands `DecksWidgetSettings` to two kinds — `decks`, and `deckCompletion`, which reuses the
 * pin checklist rather than copying it — so a missing `renderExtraSettings` arm must be a sentence
 * that is absent rather than a `null` that looks the same either way.
 */
vi.mock("./widgets/DecksWidget", () => ({
  DecksWidget: stubs.body,
  DecksWidgetSettings: () => "the deck pin picker",
}));
```

Then, directly after the `vi.mock("./widgets/StickyNotesWidget", …)` line, add the four new bodies'
stubs — without them the catalogue case below would mount the real bodies, and each would fetch
through a Tauri `invoke` that is not there:

```tsx
vi.mock("./widgets/DeckCompletionWidget", () => ({ DeckCompletionWidget: stubs.body }));
vi.mock("./widgets/ToReviewWidget", () => ({ ToReviewWidget: stubs.body }));
vi.mock("./widgets/WishlistSavingsWidget", () => ({ WishlistSavingsWidget: stubs.body }));
vi.mock("./widgets/ComingSoonWidget", () => ({ ComingSoonWidget: stubs.body }));
```

Then, directly after the existing case `"draws the new printings body and its settings through the
page's two switches"`, add:

```tsx
  /**
   * **The four kinds of round two, through the same two switches** — four `renderBody` arms and
   * one `renderExtraSettings` arm. The previous case's argument holds for each: a forgotten `case`
   * is not a type error, so the placeholder's sentence is asserted absent as well as the body
   * present, and `deckCompletion`'s popover must carry the Decks widget's own checklist.
   */
  it("draws the four round-two bodies, and Deck completion's pin checklist, through the two switches", async () => {
    const user = userEvent.setup();
    mount(
      layoutOf(
        widget({ id: "dc", kind: "deckCompletion", x: 0, y: 0, w: 3, h: 3 }),
        widget({ id: "tr", kind: "toReview", x: 3, y: 0, w: 2, h: 3 }),
        widget({ id: "ws", kind: "wishlistSavings", x: 5, y: 0, w: 3, h: 3 }),
        widget({ id: "cs", kind: "comingSoon", x: 0, y: 3, w: 4, h: 2 }),
      ),
    );

    for (const id of ["dc", "tr", "ws", "cs"]) {
      expect(screen.getByText(`Body of ${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByText(/came from a newer version/)).toBeNull();

    await customize(user);
    await user.click(screen.getByRole("button", { name: "Settings for Deck completion" }));
    expect(await screen.findByText("the deck pin picker")).toBeInTheDocument();
  });

  /** Each new kind is in the catalogue, previewed as its own body told it is still. */
  it("offers the four round-two kinds in the catalogue, each previewed still", async () => {
    const user = userEvent.setup();
    mount(layoutOf());

    await user.click(screen.getByRole("button", { name: "Add widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Widget catalogue" });

    for (const [kind, label] of [
      ["deckCompletion", "Deck completion"],
      ["toReview", "To review"],
      ["wishlistSavings", "Wishlist savings"],
      ["comingSoon", "Coming soon"],
    ] as const) {
      expect(within(dialog).getByRole("button", { name: `Add ${label}` })).toBeInTheDocument();
      expect(within(dialog).getByText(`Body of preview-${kind}`)).toBeInTheDocument();
      expect(handed.get(`preview-${kind}`)).toEqual(
        expect.objectContaining({ still: true, editing: false }),
      );
    }
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/home/HomePage.test.tsx`
Expected: FAIL — the first new case cannot find `Body of dc` (the card draws the *newer version*
placeholder, because `renderBody` has no `deckCompletion` arm); the second cannot find
`Body of preview-deckCompletion` for the same reason. Every other case still passes.

- [ ] **Step 3: Implement**

In `src/features/home/HomePage.tsx`, replace the widget import block:

```tsx
import { ActivityWidget } from "./widgets/ActivityWidget";
import { CollectionValueWidget } from "./widgets/CollectionValueWidget";
import { DecksWidget, DecksWidgetSettings } from "./widgets/DecksWidget";
import { FoldersWidget, FoldersWidgetSettings } from "./widgets/FoldersWidget";
import { NewPrintingsWidget, NewPrintingsWidgetSettings } from "./widgets/NewPrintingsWidget";
import { PriceMoversWidget } from "./widgets/PriceMoversWidget";
import { RecentCardsWidget } from "./widgets/RecentCardsWidget";
import { SetCompletionWidget } from "./widgets/SetCompletionWidget";
import { StickyNotesWidget } from "./widgets/StickyNotesWidget";
import { SummaryWidget, SummaryWidgetSettings } from "./widgets/SummaryWidget";
import { WishlistValueWidget } from "./widgets/WishlistValueWidget";
```

with:

```tsx
import { ActivityWidget } from "./widgets/ActivityWidget";
import { CollectionValueWidget } from "./widgets/CollectionValueWidget";
import { ComingSoonWidget } from "./widgets/ComingSoonWidget";
import { DeckCompletionWidget } from "./widgets/DeckCompletionWidget";
import { DecksWidget, DecksWidgetSettings } from "./widgets/DecksWidget";
import { FoldersWidget, FoldersWidgetSettings } from "./widgets/FoldersWidget";
import { NewPrintingsWidget, NewPrintingsWidgetSettings } from "./widgets/NewPrintingsWidget";
import { PriceMoversWidget } from "./widgets/PriceMoversWidget";
import { RecentCardsWidget } from "./widgets/RecentCardsWidget";
import { SetCompletionWidget } from "./widgets/SetCompletionWidget";
import { StickyNotesWidget } from "./widgets/StickyNotesWidget";
import { SummaryWidget, SummaryWidgetSettings } from "./widgets/SummaryWidget";
import { ToReviewWidget } from "./widgets/ToReviewWidget";
import { WishlistSavingsWidget } from "./widgets/WishlistSavingsWidget";
import { WishlistValueWidget } from "./widgets/WishlistValueWidget";
```

In `renderBody`, replace:

```tsx
    case "stickyNotes":
      return <StickyNotesWidget {...props} />;
    default:
      return <UnknownWidgetBody />;
```

with:

```tsx
    case "stickyNotes":
      return <StickyNotesWidget {...props} />;
    case "deckCompletion":
      return <DeckCompletionWidget {...props} />;
    // `ToReviewWidget` takes one prop the page never passes — `web`, which defaults to the build's
    // own `isWebTarget()` and exists so a story can draw the browser build's face.
    case "toReview":
      return <ToReviewWidget {...props} />;
    case "wishlistSavings":
      return <WishlistSavingsWidget {...props} />;
    case "comingSoon":
      return <ComingSoonWidget {...props} />;
    default:
      return <UnknownWidgetBody />;
```

In `renderExtraSettings`, replace:

```tsx
    case "newPrintings":
      return <NewPrintingsWidgetSettings widget={widget} onConfig={onConfig} />;
    default:
      return undefined;
```

with:

```tsx
    case "newPrintings":
      return <NewPrintingsWidgetSettings widget={widget} onConfig={onConfig} />;
    // **The Decks widget's pin checklist, reused rather than copied** (spec §2.1): Deck completion
    // reads its scope and its pins through `DecksWidget`'s own `deckScope` and `pinnedDeckIds`, so
    // the checklist writes exactly what that body reads, and a fix to one is a fix to both.
    case "deckCompletion":
      return <DecksWidgetSettings widget={widget} onConfig={onConfig} />;
    default:
      return undefined;
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/features/home/HomePage.test.tsx`
Expected: PASS, every case. Then re-run the four widget suites once, since they now share a tree:
`npx vitest run src/features/home/widgets/DeckCompletionWidget.test.tsx src/features/home/widgets/ToReviewWidget.test.tsx src/features/home/widgets/WishlistSavingsWidget.test.tsx src/features/home/widgets/ComingSoonWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the stories**

In `src/features/home/HomePage.stories.tsx`, `CatalogueOpen`'s play, replace:

```tsx
    for (const label of ["Summary", "Recently viewed", "Set completion", "Price movers"]) {
      await expect(dialog.getByRole("button", { name: `Add ${label}` })).toBeInTheDocument();
    }
    // The previews are pictures: nine real cards, and not one of them a region a reader can reach.
```

with:

```tsx
    for (const label of [
      "Summary",
      "Recently viewed",
      "Set completion",
      "Price movers",
      "Deck completion",
      "To review",
      "Wishlist savings",
      "Coming soon",
    ]) {
      await expect(dialog.getByRole("button", { name: `Add ${label}` })).toBeInTheDocument();
    }
    // The previews are pictures: every one a real card, and not one of them a region a reader can
    // reach. (This said "nine" until a round of new kinds made it wrong — `WIDGETS` is the count.)
```

This story mounts the four real bodies against the fake (the catalogue previews them `still`), so
it is also the first place their fake handlers are exercised together; its play is checked with
the rest of the stories at the end of the wave.

- [ ] **Step 6: Typecheck** (`npx tsc --noEmit -p .`)

Run: `npx tsc --noEmit -p .` then `npx eslint src/features/home/HomePage.tsx src/features/home/HomePage.test.tsx src/features/home/HomePage.stories.tsx`
Expected: no errors. The stories of W1–W5 are played by `src/stories.test.tsx` inside the single
`npm run verify` that ends the plan (Task V1) — not here: a story run mid-wave collects the whole
tree, and `-t` matches the file path, so a title filter exits 0 on nothing.

---


## Wave 4 — the record, the proof, the ship

### Task 12 (D1): The reference record

**Files:**
- Modify: `docs/reference/home-page.md` — §3's kind table (four rows), a new section per kind, one section for the three hand-offs, and the §8 list where a limitation is new.
- Modify: `CLAUDE.md` — only if a line there names the widget kinds or the home commands (grep first; change nothing otherwise).

**Interfaces:**
- Consumes: everything Waves 1–3 built.
- Produces: prose only.

- [ ] **Step 1: Add the four rows to §3's table**

Insert after the `newPrintings` row of the table under `## 3.`:

```markdown
| `deckCompletion` | each deck's owned-against-wanted, with the cost of the rest | `{ scope: recent·pinned, deckIds, order: done·cheapest·name, complete }` |
| `toReview` | scanned cards waiting, flagged binder entries, wishes and deck cards, and Recently removed — each row opening its list | `{ removed }` |
| `wishlistSavings` | pinned wishes with a cheaper printing, biggest saving first | — |
| `comingSoon` | unreleased sets, how many of their cards are previewed, and how many are already in your decks | `{ window: 30·90·365 }` |
```

Do **not** touch the ⚠️ note's sentence about eight widgets in the default layout: `DEFAULT_LAYOUT` did not move, so it is still true. Do not write the number of catalogue kinds anywhere.

- [ ] **Step 2: Write a section per kind**

Add `## 14. Home widgets, round two (2026-09-26)` after the last section, with one `###` per kind. Each section states, with the reason at its site: what the read answers and which file owns it; the rule that is easy to get wrong (Deck completion: the editor's pools and every active pile, and the Rust test that asks `deck_completion` and `get_deck` the same question; To review: rows vs copies, and why the tray is read under its own key; Wishlist savings: an unpriced move is counted on its own line, never summed as zero, and the plan's cross-language offers are inherited; Coming soon: read over `cards` because the browser build never fills `sets`, and `set_type` filtering only where `sets` has rows). Link the spec. Quote no figure you did not measure in the live pass (Task V1); a figure you did measure carries its date and build.

- [ ] **Step 3: Write the hand-offs section**

`### The three hand-offs` — one paragraph each for `pendingReviewFilter`, `pendingSettingsGroup` and `pendingOptimize`, stating the `pendingFolder` rules they repeat (inside `setActiveView`'s clear block; `setActiveView` first; render-phase consumption) and the one thing each adds: `pendingOptimize` plans the whole list without writing `wishlistFlattened`; `pendingSettingsGroup` is a plain string the page drops when it names no group.

- [ ] **Step 4: Check for counts and stale claims**

Run: `rg -n "eleven|twelve|fifteen|kinds this build|COMMANDS.len" docs/reference/home-page.md`
Expected: no line claims a count of widget kinds or of routed commands. Fix any that does by deleting the count, not by updating it.

---

### Task 13 (V1): Verify and drive the shipped window

**Files:** none created; fixes found here go back to the task that owns the file.

**Interfaces:**
- Consumes: the whole branch.
- Produces: a green `npm run verify`, green `cargo fmt --check` and `cargo clippy`, and a live pass record for D1.

- [ ] **Step 1: Make sure the worktree's dependencies are current**

Read the `worktree-setup` skill. Run: `npm install` (only if `package-lock.json` changed on this branch or the SessionStart hook reported a failure).

- [ ] **Step 2: Format and lint the Rust crate** (verify runs neither; CI runs both)

Run (from `src-tauri`): `cargo fmt --all -- --check` then `cargo clippy --all-targets -- -D warnings`
Expected: no output from fmt; clippy finishes with no warnings. If the wasm leg is in doubt, read the memory note on `--lib` and clang before chasing a failure.

- [ ] **Step 3: Run the full suite once**

Run: `npm run verify` — **not through a pipe** (a pipe reports the pager's exit code), and never while another verify runs anywhere on this machine.
Expected: build, lint, Vitest and `cargo test` all pass. If a long Vitest run is killed, shard it (`npx vitest run --shard=1/3` …) rather than retrying whole.

- [ ] **Step 4: Run the story plays**

Run: `npx vitest run src/stories.test.tsx`
Expected: every story of the four new widgets passes, and no existing play regressed (new seeds were added in new worlds, not into worlds existing plays read).

- [ ] **Step 5: Drive the real window**

Read the `running-the-app` skill and take the `app` lock. Copy the **whole** debug `data` folder from the main checkout (`D:/Code/mtg-grimoire/src-tauri/target/debug/data`) into this worktree's `src-tauri/target/debug/data` first — a fresh sync has cards and no collection, and every widget would draw its empty state. Start `npm run tauri dev`, then over `scripts/cdp.mjs` (contract: `docs/reference/live-ui-verification.md`):

1. Home → Customize → Add widget: the catalogue shows the four new previews, each at its default footprint, inert.
2. Add each of the four. Each draws real rows from the copied database, or its empty sentence.
3. Press a Deck completion row: the deck editor opens on that deck, and its missing count equals the row's.
4. Press each To review row that is present: the Collection opens with its needs-review filter on; the Wishlist likewise; Settings opens on the Sync group; the Scanner opens; Recently removed opens that folder.
5. Clear one flagged row in Settings › Needs review, return Home: To review's count has dropped without a reload.
6. Press a Wishlist savings row: the Wishlist opens with the Optimise dialog over the whole list; close it — the page's flatten toggle is as it was.
7. Press a Coming soon set: Search opens on that set with unreleased cards showing.
8. Switch the marketplace in Settings: Deck completion and Wishlist savings refetch in the new currency.

Record each result (date, debug build, window size) for Task D1. Release the `app` lock.

- [ ] **Step 6: Controller commits the fixes** by path, one commit per owning task, `fix:` prefix.

---

### Task 14 (S1): Ship it as an auto-merging PR

- [ ] **Step 1:** Read and follow the `auto-pr` skill: push the branch, open the PR (title `feat: four new home widgets — deck completion, to review, wishlist savings, coming soon`; body naming the spec, the plan, the canvas link and the live-pass results, ending with the attribution line), arm auto-merge, and watch for the only two states GitHub abandons — a real conflict and a red `ci-ok`. Merge `main` in, never rebase.
- [ ] **Step 2:** Bind the PR in the desktop app (`ccd_pr` `get_status`, then `bind_pr` if unbound) and report the link.
