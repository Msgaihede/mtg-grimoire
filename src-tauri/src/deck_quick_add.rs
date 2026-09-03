//! Recording cardboard the reader has just acquired straight into the deck that wanted it — and
//! taking the matching line off their shopping list in the same press.
//!
//! A deck lists four Lightning Bolt and the editor draws `0/4`. The reader has the four in their
//! hand: they bought them this morning, and until this module existed telling the app so was
//! *Add to collection*, then find the deck, then file the copies into its group, then open the
//! wishlist and take the wish down. This is the one press
//! ([issue #350](https://github.com/Msgaihede/mtg-grimoire/issues/350)): [`quick_add`] records
//! the copies **in the deck's own group** and, when it is handed a wish, decrements it.
//!
//! ```text
//!          collection_to_deck                 deck_to_collection
//! binder / another deck ─────────▶ deck group ─────────────────▶ Recently removed
//!                                     ▲   ▲
//!         deck_pull_from_collection ───┘   └─── deck_quick_add_to_collection
//!         (moves cardboard that exists)         (records cardboard that did not)
//! ```
//!
//! # This is the fourth crossing of the deck boundary and the first that *creates* copies
//!
//! [`crate::collection_alloc`] holds two of the others and [`crate::deck_pull`] the third, and
//! every one of them **moves** a `collection_entries` row from one folder to another. This one
//! writes a row that was not there. Three consequences, and each of them is a rule somewhere
//! else in the tree:
//!
//! * The command takes [`crate::collection_source::with_write_owned`] like its three neighbours,
//!   but for a stronger reason than theirs: the facet index's `owned` dimension counts **rows**,
//!   and the three movers can at most fold one away. This one makes one.
//! * TypeScript's invalidation set is `OWNED_WRITE_KEYS` rather than the narrower
//!   `["collection"]` the movers share — a card that was owned nowhere is now owned somewhere,
//!   so every count on every page is stale.
//! * [`crate::collection_alloc::NOT_IN_DECK`] is the fence that keeps issue #358's invariant
//!   true: *every copy in a deck's group is backed by a row in that deck's list*. A write that
//!   could file into a group without one would be inventing custody for a card the deck does not
//!   play, which is precisely what that issue closed on the filing side.
//!
//! # Why it is not `collection_add` with a folder argument
//!
//! [`crate::collection::add_entry`] **refuses** a `deck` folder outright
//! ([`crate::collection_folders::FOLDER_NOT_YOURS`]) and must go on refusing: filing into a group
//! asserts *this deck holds these copies*, and only a write that can answer for the `deck_cards`
//! row behind them may say that. [`crate::collection::add_entry_filed`] is the `pub(crate)` door
//! that takes the fence as a parameter and [`crate::collection::DECK_WRITE_FOLDERS`] is the
//! widened set; the deck importer was its first caller and this is its second — and the set was
//! called `IMPORT_FOLDERS` until this module made a second press pass it. What each answers for is
//! the same shape: the importer writes the deck's list in the same press, and this one checks
//! that the list already says so.
//!
//! # The wishlist half narrows on the *printing*, not on the wish
//!
//! [`wishes`] is [`crate::wishlist::OWNED_SQL`]'s own first arm with the any-printing arm
//! dropped — `w.card_id = :cardId AND (w.preferred_finish IS NULL OR w.preferred_finish =
//! :finish)` — rather than a second opinion about what fills a wish. A wish for *any* printing of
//! the card is left standing, exactly as [`crate::deck_pull`] leaves an Alpha Bolt out of an M10
//! line and for the same trade: nothing is ever taken off a shopping list that is not the piece
//! of cardboard the reader just recorded. A NULL `preferred_finish` still matches, because the
//! list itself says *a wish that names no finish takes any of them*; excluding it would refuse
//! the commonest wish there is.
//!
//! # A prompt only when the answer is ambiguous
//!
//! One matching wish is removed with no dialog; several open a picker. That decision is
//! TypeScript's — this module answers the *facts* (which wishes match, in an order it argues
//! for) and the page draws the conclusion, which is the crate's boundary read one module in.
//! [`quick_add`] takes at most one `wish_id`, because a press that cleared three wishes at once
//! would be a write nobody could review before it happened.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;

/// What [`quick_add`] says when the wish it was pointed at is not there any more.
///
/// The dialog's answer is a round trip old, so the wish is re-read **inside** the transaction —
/// [`crate::deck_pull::from_collection`]'s discipline, which re-plans rather than trusting the
/// picks it was handed. Distinct from [`WISH_WRONG_CARD`] because "somebody deleted it" and
/// "that is not this card" are two different things to tell a stale dialog, and one sentence
/// covering both tells it nothing it can act on.
pub const WISH_GONE: &str = "That wishlist line is not there any more.";

/// What [`quick_add`] says when the wish it was pointed at no longer matches this press.
///
/// The same predicate [`wishes`] offered by, asked again: a wish edited to name another printing
/// or another finish between the read and the press is not the wish the reader ticked. Refused
/// rather than silently skipped — the whole point of the second row on the menu is that both
/// halves happen, and a cheerful outcome with `wish_copies: 0` is how a caller goes on believing
/// the shopping list was tidied.
pub const WISH_WRONG_CARD: &str = "That wishlist line is not for this card.";

/// What is actually sleeved up — `DECK_VARIANTS[0]`, and the only list this write answers about.
/// A plan holds no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so a deck that has
/// only *thought about* a card is refused here by [`crate::deck::plays_card`] and not by a fence
/// of its own — see [`quick_add`].
const LIVE: &str = crate::schema::DECK_VARIANTS[0];

/// `FINISHES[0]` — the word [`crate::deck::normalise_finish`] maps *away* on a deck row and the
/// one `collection_entries.finish` and `wishlist_entries.preferred_finish` store for a plain
/// copy. Reading it back is the whole of the translation between the deck's spelling and the
/// other two tables', and it is not respelled anywhere else in this module.
const NONFOIL: &str = crate::schema::FINISHES[0];

/// One wishlist line the copies about to be recorded could take down.
///
/// The hand-written mirror of `DeckQuickAddWish` in `src/lib/ipc.ts`, field for field.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddWish {
    /// The `wishlist_entries` row — what a [`quick_add`] `wish_id` points at, and the only field
    /// the write reads back.
    pub id: i64,
    /// Copies the wish still asks for. The write takes `min(recorded, this)`, so a wish for one
    /// copy survives a four-copy press with nothing left and is deleted.
    pub quantity: i64,
    /// Where the wish is filed, or `None` at the root.
    pub folder_id: Option<i64>,
    /// What to call that place, or `None` at the root — **which the UI words, not this crate**.
    /// The wishlist page says `Wishlist` for `folder_id IS NULL`; a sentence belongs on the page
    /// that shows it, and [`crate::deck_pull::PullCandidate::folder_name`] makes the same call
    /// one table over.
    pub folder_name: Option<String>,
}

/// What one quick add recorded.
///
/// Three numbers rather than a row, because the caller re-reads the deck afterwards anyway and
/// what a sentence quotes is *"4 copies recorded, 1 wish cleared"*.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAddOutcome {
    /// Copies recorded — the quantity asked for, which is exactly what landed because a press
    /// that could not record all of them records none.
    pub copies: i64,
    /// The `collection_entries` row the copies are in **after the grain fold**, which is not
    /// necessarily a new row: a second press on the same line raises the row the first one made.
    /// The caller's glow lands here.
    pub entry_id: i64,
    /// Copies taken off the wish — `min(copies, the wish's quantity)`, and `0` when no wish was
    /// named. **Copies and not wishes**: a wishlist row holding four is four copies of wanting,
    /// so a press that takes one of them down has cleared one wish and left three standing.
    pub wish_copies: i64,
}

/// Every wish these copies could take down, best first.
///
/// **The predicate is [`crate::wishlist::OWNED_SQL`]'s first arm with the any-printing arm
/// dropped**, and the module header argues the narrowing. What is worth repeating at the SQL is
/// the shape: `preferred_finish IS NULL` comes **first** in the disjunction because that is the
/// commonest wish there is and the one an equality alone would silently drop — `NULL = 'nonfoil'`
/// is NULL rather than false, so a bare `=` would answer the empty list for most of a reader's
/// wishlist with no error and nothing in `error_log`.
///
/// # The order is [`crate::deck_pull::PullCandidate`]'s, borrowed rather than re-decided
///
/// The **root** first: a wish nobody has filed is a wish moving it disturbs no decision of. Then
/// the reader's own folders in the `sort_order` they arranged them in, because a named folder is
/// a decision somebody made on purpose. The tiebreak is `w.id`, oldest first — a primary key, so
/// the walk is **total** with no further term.
///
/// `(w.folder_id IS NOT NULL)` is `0` at the root and `1` everywhere else, which is that
/// two-way sort written as the expression SQLite can index-scan rather than as a `CASE` with one
/// arm. `f.sort_order` is NULL for a root row and SQLite sorts NULLs first, which is the same
/// answer and costs no `coalesce`.
///
/// **This is a pre-pick and not a decision.** Every match is returned and the *page* chooses:
/// one is taken with no dialog, several open a picker. An empty vector is the ordinary answer —
/// a reader who never wished for the card is not an error.
const WISH_SQL: &str = "SELECT w.id, w.quantity, w.folder_id, f.name
       FROM wishlist_entries w
       LEFT JOIN wishlist_folders f ON f.id = w.folder_id
      WHERE w.card_id = ?1
        AND (w.preferred_finish IS NULL OR w.preferred_finish = ?2)
      ORDER BY (w.folder_id IS NOT NULL), f.sort_order, w.id";

/// Run [`WISH_SQL`] for one printing and finish.
///
/// The finish arrives in the **deck row's** spelling, where `None` is the regular copy, and is
/// translated through [`crate::deck::normalise_finish`] and [`NONFOIL`] into the word the
/// wishlist stores — the same one-line translation [`crate::deck_pull`]'s own candidate read
/// makes into the collection's column. An unknown finish is refused there rather than matching
/// nothing here.
pub fn wishes(
    conn: &Connection,
    card_id: &str,
    finish: Option<&str>,
) -> Result<Vec<QuickAddWish>, String> {
    let finish = crate::deck::normalise_finish(finish)?.unwrap_or_else(|| NONFOIL.to_owned());
    let mut stmt = conn.prepare(WISH_SQL).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![card_id, finish], |r| {
            Ok(QuickAddWish {
                id: r.get(0)?,
                quantity: r.get(1)?,
                folder_id: r.get(2)?,
                folder_name: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Record copies straight into this deck's group, and take a named wish down with them.
///
/// # The order of the seven steps *is* the rule
///
/// [`crate::collection_alloc::collection_to_deck`]'s discipline, and every step is placed for a
/// reason a test pins:
///
/// 1. **A quantity of zero or less is refused before the transaction opens** —
///    [`crate::collection::ZERO_ADD`], the crate's one sentence for it, reused rather than
///    respelled. Adding no copies is a no-op dressed as a write.
/// 2. **[`crate::deck::touch_deck`] first inside it**, which doubles as the deck fence: a stale
///    editor's dead deck id hears [`crate::deck::GONE`] and not [`crate::collection_alloc::
///    NOT_IN_DECK`], because "that deck is gone" and "that deck does not play this" are
///    different things to be told. A quick add *is* a change to the deck — what it holds moved —
///    so the stamp is owed on its own account.
/// 3. **[`crate::deck::plays_card`]**, else [`crate::collection_alloc::NOT_IN_DECK`]. That
///    function reads the **live** list only, and there is deliberately no theory fence of its
///    own here: a card the deck merely *plans* is refused by this one check, with the sentence
///    that names the mistake. Spelling [`crate::collection_alloc::THEORY_HOLDS_NOTHING`] beside
///    it would be a second rule to keep in step for a case the first already covers.
/// 4. **[`crate::deck::deck_group`]**, else [`crate::collection_alloc::NO_DECK_GROUP`]. There is
///    one group per deck since schema v25, so `None` is a database somebody has edited by hand —
///    and filing at the root instead would record copies no deck claims.
/// 5. **[`crate::collection::add_entry_filed`] with
///    [`crate::collection::DECK_WRITE_FOLDERS`]**, `folder_id` the group and every other
///    [`crate::collection::EntryInput`] field at its empty value. **The grain fold is that
///    function's**, so a second quick add on the same line raises the row already in the group
///    rather than making a second one — the folder is `COLLECTION_GRAIN`'s eleventh term, and
///    the copies of one printing in one group are one row by construction.
/// 6. **The wish, re-read inside the transaction.** See [`WISH_GONE`] and [`WISH_WRONG_CARD`].
///    `take = min(quantity, wish.quantity)`; taking the lot deletes the row, because
///    `wishlist_entries.quantity` is `CHECK (quantity > 0)` and a wish for none of something is
///    not a wish.
/// 7. **One [`crate::deck_audit`] row.**
///
/// One transaction, for the reason every fold in this crate is one: mid-press the copies are
/// recorded *and* the wish is down, or neither is. A refusal at step 6 rolls the copies back —
/// the reader asked for both halves and gets neither, which is the only answer a half-failure
/// can honestly give.
///
/// # The history row is a `move`, and `AUDIT_KINDS` stays at nine
///
/// `deck_audit.kind`'s CHECK cannot be altered — SQLite has no `ALTER … CHECK` — so a tenth word
/// would rebuild every reader's whole deck history for a spelling.
/// [`crate::import::commit_import`] met this first, [`crate::deck_undo`] and
/// [`crate::deck_pull`] met it again, and this is the fourth reuse: an existing kind with a
/// payload key nothing else writes, so `auditText.ts` recognises it without guessing.
///
/// `{"quickAdd": {"copies": N, "wishes": M}}`, where **`M` is [`QuickAddOutcome::wish_copies`] —
/// copies off the wish, not a count of wish rows**, of which there is at most one.
///
/// **`delta` is 0 and it is honest.** `delta` is what the history drawer's day header adds up,
/// and it adds up changes to *the list*. The list gained nothing: the deck asked for four copies
/// before the press and asks for four after it. The card is `None` for
/// [`crate::deck_pull::from_collection`]'s reason — a `move` row naming a card renders as
/// *"Moved a card"*, a sentence about a change to a list this press did not make.
///
/// # There is deliberately no undo step
///
/// [`crate::collection_alloc::collection_to_deck`]'s argument, and it is sharper here.
/// [`crate::deck_undo`] restores rows of `deck_cards` and touches no collection table at all, so
/// the only half of this press it could express is the half that does not exist — this write
/// changes **no** `deck_cards` row. A step carrying nothing is not a step. The way back is the
/// collection editor: the copies are a row the reader can see, in a folder named after the deck.
pub fn quick_add(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    finish: Option<&str>,
    condition: Option<&str>,
    quantity: i64,
    wish_id: Option<i64>,
) -> Result<QuickAddOutcome, String> {
    // Before the transaction opens, not inside it: a refusal that has already begun a write is a
    // rollback the reader pays for. `collection_to_deck` and `commit_import` both open this way.
    if quantity <= 0 {
        return Err(crate::collection::ZERO_ADD.to_owned());
    }
    // The deck's spelling into the collection's, once, and read by both halves below — the
    // `collection_entries.finish` this writes and the `wishlist_entries.preferred_finish` the
    // wish is re-checked against are the same vocabulary, and a second translation is a second
    // thing to drift.
    let finish = crate::deck::normalise_finish(finish)?.unwrap_or_else(|| NONFOIL.to_owned());

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    if !crate::deck::plays_card(&tx, deck_id, card_id)? {
        return Err(crate::collection_alloc::NOT_IN_DECK.to_owned());
    }
    let group = crate::deck::deck_group(&tx, deck_id)?
        .ok_or_else(|| crate::collection_alloc::NO_DECK_GROUP.to_owned())?;

    // Every field but the five this press knows at its empty value: a menu row records *copies*,
    // and a purchase price, an acquisition source or a note it invented would be provenance
    // nobody entered. `..Default::default()` rather than twenty explicit `None`s, so a column
    // added to `EntryInput` later does not need a line here to keep meaning "not said".
    let input = crate::collection::EntryInput {
        card_id: card_id.to_owned(),
        finish: finish.clone(),
        condition: condition.map(str::to_owned),
        quantity,
        folder_id: Some(group),
        ..Default::default()
    };
    let change =
        crate::collection::add_entry_filed(&tx, &input, crate::collection::DECK_WRITE_FOLDERS)?;

    let wish_copies = match wish_id {
        None => 0,
        Some(wish_id) => take_wish(&tx, wish_id, card_id, &finish, quantity)?,
    };

    // Inside the transaction, [`crate::deck_audit`]'s first rule: a history row for a write that
    // rolled back is worse than no row at all. The id `record` answers is discarded, which is
    // the call shape of every site that files no reversal.
    crate::deck_audit::record(
        &tx,
        deck_id,
        LIVE,
        crate::deck_audit::MOVE,
        None,
        &json!({ "quickAdd": { "copies": quantity, "wishes": wish_copies } }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(QuickAddOutcome {
        copies: quantity,
        entry_id: change.id,
        wish_copies,
    })
}

/// Re-check one wish against the press and take copies off it. Answers what it took.
///
/// **Read back in three columns rather than asked as a `WHERE`**, because a single statement that
/// matched nothing could only say *"no such wish"* — and "somebody deleted it" ([`WISH_GONE`])
/// and "it is not for this card any more" ([`WISH_WRONG_CARD`]) are the two different things a
/// stale dialog needs told apart. The predicate re-applied here is [`WISH_SQL`]'s, term for term.
///
/// `card_id` is `Option<String>` on the table — NULL is the any-printing wish — and an equality
/// against `Some(card_id)` refuses it, which is the same narrowing [`wishes`] makes by writing
/// `w.card_id = ?1` rather than a `coalesce`.
fn take_wish(
    tx: &Connection,
    wish_id: i64,
    card_id: &str,
    finish: &str,
    quantity: i64,
) -> Result<i64, String> {
    let row: Option<(Option<String>, Option<String>, i64)> = tx
        .query_row(
            "SELECT card_id, preferred_finish, quantity FROM wishlist_entries WHERE id = ?1",
            params![wish_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (wish_card, preferred, held) = row.ok_or_else(|| WISH_GONE.to_owned())?;
    if wish_card.as_deref() != Some(card_id) {
        return Err(WISH_WRONG_CARD.to_owned());
    }
    if preferred.as_deref().is_some_and(|f| f != finish) {
        return Err(WISH_WRONG_CARD.to_owned());
    }
    let take = quantity.min(held);
    // `quantity > 0` is a table CHECK, so a wish taken down to nothing has to go rather than sit
    // at zero — `crate::collection::set_quantity`'s rule one table over, where a stepped-out row
    // is deleted for the same reason.
    if take >= held {
        tx.execute(
            "DELETE FROM wishlist_entries WHERE id = ?1",
            params![wish_id],
        )
    } else {
        tx.execute(
            "UPDATE wishlist_entries SET quantity = quantity - ?2, updated_at = unixepoch()
              WHERE id = ?1",
            params![wish_id, take],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(take)
}

/// The two commands, in a module of their own so the wire names and the crate's names can each
/// read well — [`crate::deck_pull::commands`]' shape.
///
/// `generate_handler!` takes the **last segment** of the path as the command name, so these
/// register as `deck_quick_add_wishes` and `deck_quick_add_to_collection` — the names
/// `src/lib/ipc.ts` invokes — while the crate says [`super::wishes`] and [`super::quick_add`],
/// which are module plus verb and do not stutter.
pub mod commands {
    #[cfg(not(target_family = "wasm"))]
    use super::{quick_add as add, wishes as read_wishes, QuickAddOutcome, QuickAddWish};
    #[cfg(not(target_family = "wasm"))]
    use crate::sync::AppState;
    #[cfg(not(target_family = "wasm"))]
    use std::sync::Arc;

    /// [`super::wishes`]' command. **Read-only** connection, and no marketplace: nothing in the
    /// answer is priced.
    ///
    /// Fetched imperatively at the press rather than by a hook, so a right-click fires nothing —
    /// the menu is drawn from the deck row the reader clicked and this read happens only if they
    /// choose the second row.
    #[cfg(not(target_family = "wasm"))]
    #[tauri::command]
    pub async fn deck_quick_add_wishes(
        state: tauri::State<'_, Arc<AppState>>,
        card_id: String,
        finish: Option<String>,
    ) -> Result<Vec<QuickAddWish>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_wishes(
                &crate::sync::lock_db_read(&state),
                &card_id,
                finish.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("the wishlist could not be read: {e}"))?
    }

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**, and this is
    /// the write in the crate that owes it most: the facet index's `owned` dimension is built by
    /// counting `collection_entries` rows, and this is the only deck-boundary write that
    /// *creates* one. [`crate::collection_alloc::commands`] and [`crate::deck_pull::commands`]
    /// carry the same note about moving them.
    #[cfg(not(target_family = "wasm"))]
    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn deck_quick_add_to_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
        card_id: String,
        finish: Option<String>,
        condition: Option<String>,
        quantity: i64,
        wish_id: Option<i64>,
    ) -> Result<QuickAddOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                add(
                    c,
                    deck_id,
                    &card_id,
                    finish.as_deref(),
                    condition.as_deref(),
                    quantity,
                    wish_id,
                )
            })
        })
        .await
        .map_err(|e| format!("the copies could not be recorded: {e}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::tests::{deck as seed_deck, seed_card};
    use serde_json::Value;

    /// **`foreign_keys` is ON**, as [`crate::db::open`] sets it for every connection the app
    /// hands out — [`crate::deck_pull`]'s suite opens the same way and for the same reason:
    /// `collection_entries.folder_id` SET NULLs and `collection_folders.deck_id` CASCADEs, and
    /// both are per-connection settings.
    fn open() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// A deck, its group and one active `main` category.
    fn deck_with_group(conn: &Connection, name: &str) -> (i64, i64) {
        let deck = seed_deck(conn, name);
        conn.execute(
            "INSERT INTO collection_folders
                 (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, 'deck', ?2, 0, unixepoch(), unixepoch())",
            params![name, deck],
        )
        .unwrap();
        let category = crate::schema::tests::category(conn, deck, "main", "Main deck");
        (deck, category)
    }

    /// One printing, one deck with its group, one category.
    fn fixture() -> (Connection, i64, i64) {
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let (deck, category) = deck_with_group(&conn, "Deck A");
        (conn, deck, category)
    }

    /// A deck row written straight into the table, so a list can want a card no folder holds —
    /// and so the setup writes no history of its own for the audit cases to trip over.
    fn add_deck_card(
        conn: &Connection,
        deck: i64,
        category: i64,
        card_id: &str,
        quantity: i64,
        finish: Option<&str>,
        variant: &str,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, finish, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'lea', '161', 'en', 'Lightning Bolt', ?5, ?6,
                     unixepoch(), unixepoch())
             RETURNING id",
            params![deck, category, variant, card_id, finish, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The ordinary case: a live line of four.
    fn live_card(conn: &Connection, deck: i64, category: i64, card_id: &str, quantity: i64) {
        add_deck_card(conn, deck, category, card_id, quantity, None, LIVE);
    }

    /// A folder the reader made and named, on the **wishlist** side.
    fn wish_folder(conn: &Connection, name: &str, sort_order: i64) -> i64 {
        conn.query_row(
            "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, ?2, unixepoch(), unixepoch())
             RETURNING id",
            params![name, sort_order],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One wish, at whatever grain the case needs. `card_id` is `Option` because the
    /// any-printing wish — the row this module must **not** offer — is the one with NULL there.
    fn seed_wish(
        conn: &Connection,
        card_id: Option<&str>,
        finish: Option<&str>,
        quantity: i64,
        folder: Option<i64>,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO wishlist_entries
                 (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
                  preferred_finish, folder_id, created_at, updated_at)
             VALUES ('o-bolt', ?1, 'lea', '161', 'en', 'Lightning Bolt', ?2, ?3, ?4,
                     unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, finish, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Copies of a printing sitting in a deck's group.
    fn group_copies(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        let group = crate::deck::deck_group(conn, deck).unwrap();
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE card_id = ?1 AND folder_id = ?2",
            params![card_id, group],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Every `collection_entries` row there is, however filed.
    fn entry_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap()
    }

    /// The live list's own quantity for a printing — the number a quick add must never touch.
    fn listed(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND variant = 'live'",
            params![deck, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// What one wish holds, or `None` once it has been taken down to nothing.
    fn wish_quantity(conn: &Connection, wish: i64) -> Option<i64> {
        conn.query_row(
            "SELECT quantity FROM wishlist_entries WHERE id = ?1",
            params![wish],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// This deck's history, oldest first — kind, card name, payload, delta.
    fn history(conn: &Connection, deck: i64) -> Vec<(String, Option<String>, Value, i64)> {
        let mut rows: Vec<_> = crate::deck_audit::list(conn, deck, 500)
            .unwrap()
            .into_iter()
            .map(|e| {
                (
                    e.kind,
                    e.card_name,
                    serde_json::from_str(&e.payload).expect("a payload is JSON"),
                    e.delta,
                )
            })
            .collect();
        rows.reverse();
        rows
    }

    /// A second printing of the **same** oracle card — [`seed_card`] derives one per printing
    /// (`'o-' || id`), so "a Bolt is a Bolt" is a question only two rows sharing an oracle id
    /// can ask.
    fn seed_reprint(conn: &Connection, id: &str, of: &str) {
        seed_card(conn, id, "m10", "146");
        conn.execute(
            "UPDATE cards SET oracle_id = (SELECT oracle_id FROM cards WHERE id = ?2)
              WHERE id = ?1",
            params![id, of],
        )
        .unwrap();
    }

    // ---- the write ----------------------------------------------------------------

    #[test]
    fn the_copies_land_in_the_group_and_nowhere_else() {
        // The case the whole feature turns on: the list wants four, the reader has just bought
        // four, and one press records them where the deck can see them. The **list** is
        // untouched — a quick add says what the reader owns, never what the deck plays.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);

        let out = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, None).unwrap();

        assert_eq!(out.copies, 4);
        assert_eq!(out.wish_copies, 0, "no wish was named");
        assert_eq!(group_copies(&conn, deck, "bolt"), 4);
        assert_eq!(entry_count(&conn), 1, "one row, and it is in the group");
        assert_eq!(listed(&conn, deck, "bolt"), 4, "the list is not a target");
        let row: (String, String, Option<i64>) = conn
            .query_row(
                "SELECT finish, condition, folder_id FROM collection_entries WHERE id = ?1",
                params![out.entry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row.0, NONFOIL,
            "a deck row's `None` is the collection's word"
        );
        assert_eq!(row.1, "NM");
        assert_eq!(row.2, crate::deck::deck_group(&conn, deck).unwrap());
    }

    #[test]
    fn a_second_press_folds_on_the_grain_rather_than_making_a_second_row() {
        // The folder is `COLLECTION_GRAIN`'s eleventh term, so two presses on one line land on
        // one row — `add_entry_filed`'s fold, which this module does not respell.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);

        let first = quick_add(&conn, deck, "bolt", None, Some("NM"), 1, None).unwrap();
        let second = quick_add(&conn, deck, "bolt", None, Some("NM"), 3, None).unwrap();

        assert_eq!(second.entry_id, first.entry_id, "the same row, raised");
        assert_eq!(second.copies, 3, "what this press recorded, not the total");
        assert_eq!(entry_count(&conn), 1);
        assert_eq!(group_copies(&conn, deck, "bolt"), 4);
    }

    #[test]
    fn a_deck_that_does_not_play_the_card_is_refused_and_nothing_is_left_behind() {
        // Issue #358's invariant from the creating side: every copy in a deck's group is backed
        // by a row in that deck's list. A press that filed one without would be inventing
        // custody for a card the deck does not play.
        let (conn, deck, cat) = fixture();
        seed_card(&conn, "shock", "m10", "155");
        live_card(&conn, deck, cat, "bolt", 4);

        let err = quick_add(&conn, deck, "shock", None, Some("NM"), 4, None).unwrap_err();

        assert_eq!(err, crate::collection_alloc::NOT_IN_DECK);
        assert_eq!(entry_count(&conn), 0, "a refused press records nothing");
        assert!(history(&conn, deck).is_empty(), "and writes no history");
    }

    #[test]
    fn another_printing_of_a_card_the_deck_plays_is_accepted() {
        // `plays_card` matches on `PLAYED_KEY` — the oracle card with the printing as the
        // fallback — so a deck listing the Alpha Bolt takes the M10 copies the reader bought.
        // The fence is about the *card*, never about the printing.
        let (conn, deck, cat) = fixture();
        seed_reprint(&conn, "bolt-m10", "bolt");
        live_card(&conn, deck, cat, "bolt", 4);

        let out = quick_add(&conn, deck, "bolt-m10", None, Some("NM"), 4, None).unwrap();

        assert_eq!(out.copies, 4);
        assert_eq!(group_copies(&conn, deck, "bolt-m10"), 4);
    }

    #[test]
    fn a_theory_only_card_is_refused_by_the_same_fence() {
        // A plan holds no cards. `plays_card` reads the **live** list only, so a card the deck
        // has merely thought about is refused here with no theory fence of its own — see
        // `quick_add`'s doc, where the absence is stated rather than left to be noticed.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None, "theory");

        let err = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, None).unwrap_err();

        assert_eq!(err, crate::collection_alloc::NOT_IN_DECK);
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn a_gone_deck_hears_that_it_is_gone_and_not_that_it_plays_nothing() {
        // `touch_deck` before `plays_card`, and the order is the whole of this test: an id with
        // no deck behind it would otherwise be a deck that plays nothing, which tells a stale
        // editor to add the card rather than to close the window.
        let (conn, _deck, _cat) = fixture();

        let err = quick_add(&conn, 4040, "bolt", None, Some("NM"), 4, None).unwrap_err();

        assert_eq!(err, crate::deck::GONE);
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn zero_copies_are_refused_in_the_crates_own_words() {
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);

        assert_eq!(
            quick_add(&conn, deck, "bolt", None, Some("NM"), 0, None).unwrap_err(),
            crate::collection::ZERO_ADD
        );
        assert_eq!(
            quick_add(&conn, deck, "bolt", None, Some("NM"), -2, None).unwrap_err(),
            crate::collection::ZERO_ADD
        );
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn a_deck_with_no_group_is_refused_rather_than_filed_at_the_root() {
        // One group per deck since v25, so `None` is a hand-edited database — and copies at the
        // root would be copies no deck claims, which is the state the fence above exists for.
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = seed_deck(&conn, "No group");
        let cat = crate::schema::tests::category(&conn, deck, "main", "Main deck");
        live_card(&conn, deck, cat, "bolt", 4);

        let err = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, None).unwrap_err();

        assert_eq!(err, crate::collection_alloc::NO_DECK_GROUP);
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn the_audit_row_is_a_move_with_no_card_and_a_delta_of_zero() {
        // `AUDIT_KINDS` stays at nine; the payload key is what tells this apart. `delta` is 0
        // because the deck's *list* gained nothing, and the card is `None` because a `move` row
        // naming one renders as "Moved a card" — a sentence about a change this press did not
        // make.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);
        let wish = seed_wish(&conn, Some("bolt"), None, 1, None);

        quick_add(&conn, deck, "bolt", None, Some("NM"), 4, Some(wish)).unwrap();

        let rows = history(&conn, deck);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, crate::deck_audit::MOVE);
        assert_eq!(rows[0].1, None, "a batch names no one card");
        assert_eq!(
            rows[0].2,
            json!({ "quickAdd": { "copies": 4, "wishes": 1 } })
        );
        assert_eq!(rows[0].3, 0);
    }

    // ---- the wishlist half --------------------------------------------------------

    #[test]
    fn a_named_wish_is_decremented_and_deleted_at_zero() {
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);
        let wish = seed_wish(&conn, Some("bolt"), None, 4, None);

        let first = quick_add(&conn, deck, "bolt", None, Some("NM"), 1, Some(wish)).unwrap();
        assert_eq!(first.wish_copies, 1);
        assert_eq!(wish_quantity(&conn, wish), Some(3), "three still wanted");

        let rest = quick_add(&conn, deck, "bolt", None, Some("NM"), 3, Some(wish)).unwrap();
        assert_eq!(rest.wish_copies, 3);
        assert_eq!(
            wish_quantity(&conn, wish),
            None,
            "`quantity > 0` is a CHECK, so a wish for none of something has to go"
        );
    }

    #[test]
    fn a_press_bigger_than_the_wish_takes_only_what_the_wish_asked_for() {
        // `min(quantity, wish.quantity)`: recording four copies against a wish for one clears
        // one wish, not four, and `wish_copies` is what the sentence quotes.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);
        let wish = seed_wish(&conn, Some("bolt"), None, 1, None);

        let out = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, Some(wish)).unwrap();

        assert_eq!(out.copies, 4);
        assert_eq!(out.wish_copies, 1);
        assert_eq!(wish_quantity(&conn, wish), None);
    }

    #[test]
    fn a_wish_that_has_gone_refuses_the_whole_press() {
        // The dialog's answer is a round trip old, so the wish is re-read inside the
        // transaction — and a refusal there rolls the copies back. The reader asked for both
        // halves and gets neither, which is the only answer a half-failure can honestly give.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);

        let err = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, Some(909)).unwrap_err();

        assert_eq!(err, WISH_GONE);
        assert_eq!(entry_count(&conn), 0, "no copies were recorded");
        assert!(history(&conn, deck).is_empty());
    }

    #[test]
    fn a_wish_for_another_printing_refuses_the_whole_press() {
        let (conn, deck, cat) = fixture();
        seed_reprint(&conn, "bolt-m10", "bolt");
        live_card(&conn, deck, cat, "bolt", 4);
        let other = seed_wish(&conn, Some("bolt-m10"), None, 4, None);

        let err = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, Some(other)).unwrap_err();

        assert_eq!(err, WISH_WRONG_CARD);
        assert_eq!(entry_count(&conn), 0);
        assert_eq!(wish_quantity(&conn, other), Some(4), "and the wish stands");
    }

    #[test]
    fn a_wish_for_another_finish_refuses_the_whole_press() {
        // The same predicate `wishes` offered by, re-applied: a foil wish is not filled by the
        // nonfoil copies the reader just recorded.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);
        let foil = seed_wish(&conn, Some("bolt"), Some("foil"), 4, None);

        let err = quick_add(&conn, deck, "bolt", None, Some("NM"), 4, Some(foil)).unwrap_err();

        assert_eq!(err, WISH_WRONG_CARD);
        assert_eq!(entry_count(&conn), 0);
    }

    // ---- the read -----------------------------------------------------------------

    #[test]
    fn a_wish_naming_no_finish_matches_and_a_foil_one_does_not() {
        // The list itself says "a wish that names no finish takes any of them", so a NULL
        // `preferred_finish` matches — excluding it would refuse the commonest wish there is.
        // The foil row is the other half of the same rule.
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let any = seed_wish(&conn, Some("bolt"), None, 2, None);
        let nonfoil = seed_wish(&conn, Some("bolt"), Some("nonfoil"), 1, None);
        seed_wish(&conn, Some("bolt"), Some("foil"), 1, None);

        let rows = wishes(&conn, "bolt", None).unwrap();

        let ids: Vec<i64> = rows.iter().map(|w| w.id).collect();
        assert_eq!(ids, vec![any, nonfoil]);
        assert_eq!(rows[0].quantity, 2);
    }

    #[test]
    fn a_foil_press_finds_the_foil_wish_and_not_the_nonfoil_one() {
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let any = seed_wish(&conn, Some("bolt"), None, 1, None);
        seed_wish(&conn, Some("bolt"), Some("nonfoil"), 1, None);
        let foil = seed_wish(&conn, Some("bolt"), Some("foil"), 1, None);

        let ids: Vec<i64> = wishes(&conn, "bolt", Some("foil"))
            .unwrap()
            .iter()
            .map(|w| w.id)
            .collect();

        assert_eq!(ids, vec![any, foil]);
    }

    #[test]
    fn an_any_printing_wish_is_not_offered() {
        // `w.card_id = ?1` is `OWNED_SQL`'s first arm with the any-printing arm dropped, and
        // the drop is the decision: nothing comes off a shopping list that is not the piece of
        // cardboard the reader just recorded.
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        seed_wish(&conn, None, None, 4, None);
        let printing = seed_wish(&conn, Some("bolt"), None, 1, None);

        let ids: Vec<i64> = wishes(&conn, "bolt", None)
            .unwrap()
            .iter()
            .map(|w| w.id)
            .collect();

        assert_eq!(ids, vec![printing]);
    }

    #[test]
    fn the_root_comes_first_then_the_readers_folders_in_their_own_order() {
        // `deck_pull::PullCandidate`'s ranking borrowed rather than re-decided: rank by how
        // little of the reader's filing the answer disturbs. The tiebreak is the row id, oldest
        // first, which is a primary key and so makes the walk total.
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        // **The two folders are made in the opposite order to the one they sort in, and the
        // three wishes in a third order again.** That is the whole setup: the expected answer
        // must not be reachable by `w.id` alone in either direction, nor by dropping
        // `f.sort_order` and leaving the folder-first term. Seeded 1-2-3 as
        // `in_later`, `at_root`, `in_soon`, the answer is 2-3-1 and no simpler order says so.
        let second = wish_folder(&conn, "Later", 2);
        let first = wish_folder(&conn, "Soon", 1);
        let in_later = seed_wish(&conn, Some("bolt"), None, 1, Some(second));
        let at_root = seed_wish(&conn, Some("bolt"), None, 1, None);
        let in_soon = seed_wish(&conn, Some("bolt"), None, 1, Some(first));

        let rows = wishes(&conn, "bolt", None).unwrap();

        assert_eq!(
            rows.iter().map(|w| w.id).collect::<Vec<_>>(),
            vec![at_root, in_soon, in_later]
        );
        assert_eq!(rows[0].folder_id, None);
        assert_eq!(rows[0].folder_name, None, "the root is the UI's word");
        assert_eq!(rows[1].folder_name.as_deref(), Some("Soon"));
        assert_eq!(rows[2].folder_name.as_deref(), Some("Later"));
    }

    #[test]
    fn two_wishes_in_one_folder_come_out_oldest_first() {
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let folder = wish_folder(&conn, "Soon", 1);
        // Two rows of one printing in one folder need a grain term apart to exist at all —
        // `WISHLIST_GRAIN`'s third is the finish, and both of these match a nonfoil press.
        let older = seed_wish(&conn, Some("bolt"), None, 1, Some(folder));
        let newer = seed_wish(&conn, Some("bolt"), Some("nonfoil"), 1, Some(folder));

        let ids: Vec<i64> = wishes(&conn, "bolt", None)
            .unwrap()
            .iter()
            .map(|w| w.id)
            .collect();

        assert_eq!(ids, vec![older, newer]);
    }

    #[test]
    fn a_card_nobody_wished_for_answers_the_empty_list() {
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        assert!(wishes(&conn, "bolt", None).unwrap().is_empty());
    }

    #[test]
    fn an_unknown_finish_is_refused_by_both_halves() {
        // `normalise_finish` is the one fence, so a bad word is a sentence rather than a read
        // that quietly matches nothing.
        let (conn, deck, cat) = fixture();
        live_card(&conn, deck, cat, "bolt", 4);

        assert!(wishes(&conn, "bolt", Some("holo")).is_err());
        assert!(quick_add(&conn, deck, "bolt", Some("holo"), Some("NM"), 1, None).is_err());
        assert_eq!(entry_count(&conn), 0);
    }
}
