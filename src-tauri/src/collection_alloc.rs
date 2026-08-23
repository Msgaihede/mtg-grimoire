//! Moving copies across the deck boundary — the two writes that make a deck's group the
//! **physical** record of what it holds.
//!
//! Schema v25 made `collection_folders` the ledger: a card is in a deck because its
//! `collection_entries` row sits in that deck's `kind = 'deck'` folder, not because a claim
//! table says so. Nothing else in the crate moves a row across that boundary, and these two
//! are deliberately the only pair that can — which is what makes exclusivity a *fact about
//! where the row sits* rather than a sum somebody has to remember to compute.
//!
//! ```text
//!            collection_to_deck                 deck_to_collection
//!   binder / another deck ─────────▶ deck group ─────────────────▶ Recently removed
//! ```
//!
//! Four rules hold this together, and each has a test below:
//!
//! * **The move is [`crate::collection_folders::take_copies`]' and is never written a second
//!   time.** Splitting a row, filing the half that travels and re-inserting the remainder is one
//!   rule about the reader's cards, and this module carried a private twin of it —
//!   `move_copies` — until fan-in. Two implementations of one rule disagree the first time
//!   either changes, so there is one, beside the merge it is built on. The refile underneath has
//!   no kind fence precisely so these writes can file into a `deck` folder and the `removed`
//!   one, which [`crate::collection_folders::set_entry_folder`] refuses by hand.
//!   **And the *walk* over a group's rows is [`crate::deck::release_group_copies`]', for the
//!   same reason and at a cost already paid once**: [`deck_to_collection`] spelled its own copy
//!   of that query and that loop, and both copies matched the exact printing — so the fix for a
//!   swapped printing's stranded copies had to be made twice or it would have been made once.
//! * **Taking a copy out of another deck's group decrements that deck's *live* list too.**
//!   The copies are custody, not a reservation, so a deck that loses them loses the card. It
//!   is reported in [`MoveOutcome::from_deck`] because the side effect lands on a deck the
//!   reader is not looking at, and the UI confirms it before pressing.
//! * **A deck card with no backing copies just goes away.** It was added from search as "I
//!   need to buy this", the reader never owned it, so nothing lands on their desk. That is
//!   also the answer [issue #209](https://github.com/Msgaihede/mtg-grimoire/issues/209) could
//!   not find: no per-deck-card provenance flag is needed, because the group **is** the
//!   provenance record.
//! * **A cut writes the history [`crate::deck::set_card_quantity`] would have, and no undo
//!   step.** The command it replaced wrote both; routing a live decrease here took both away,
//!   and the history is not optional. The step is — see [`deck_to_collection`], which argues it
//!   at length.
//!
//! Both are one transaction, for the reason every fold in this crate is one: mid-move the
//! copies are in both places or in neither.

use crate::collection_folders::take_copies;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;

/// What a theory row says when asked to give its copies back.
///
/// A theory list is a plan. A plan holds no cards, so there is nothing in any folder to move
/// and a refusal is the only honest answer — the alternative is a press that reports success
/// and moves nothing, which reads to the user as a card that vanished.
pub const THEORY_HOLDS_NOTHING: &str = "A theory list is a plan, and a plan holds no cards.";

/// What either write says when asked to move more copies than are there.
///
/// In words rather than as a `CHECK (quantity >= 0)` failure, which names the table and not the
/// mistake — and `PRAGMA foreign_keys` is per-connection anyway, so a constraint is not a fence
/// a command may lean on.
pub const NOT_THAT_MANY: &str = "There are not that many copies to move.";

/// Moving nothing is a press that did nothing dressed as a write —
/// [`crate::collection::ZERO_ADD`]'s refusal, for that refusal's reason.
pub const ZERO_MOVE: &str = "Moving copies needs a quantity of at least one.";

/// What [`deck_to_collection`] says when the deck card it was pointed at is gone. A stale
/// editor's id, and the same asymmetry [`crate::collection::GONE`] draws.
pub const DECK_CARD_GONE: &str = "That card is not in this deck any more.";

/// What [`collection_to_deck`] says when the deck it was pointed at has no group folder.
///
/// Every deck gets one — schema v25 made one per deck on the way up, and `deck::create_deck`
/// makes one for every deck since — so this is a database that has been edited by hand. The
/// refusal is here rather than in [`deck_to_collection`] because only this direction *needs*
/// somewhere to put copies: cutting a card from a deck whose group is missing is a deck with no
/// backing copies, which the third rule above already answers.
pub const NO_DECK_GROUP: &str = "That deck has no folder to hold its cards.";

/// What [`deck_to_collection`] says when there is no `Recently removed` folder to file into.
/// Schema v25 creates exactly one and a partial unique index makes a second impossible.
pub const NO_REMOVED_FOLDER: &str = "There is no Recently removed folder to file these into.";

/// Copies already in the deck they were asked to move into.
///
/// Refused rather than treated as a no-op, because the press that produces it — dragging a
/// card from deck A's folder onto deck A — would otherwise write a second `deck_cards` row
/// against copies the group already holds, and the list would say two where the folder says
/// one.
pub const ALREADY_HERE: &str = "Those copies are already in this deck.";

/// `COLLECTION_FOLDER_KINDS[1]` — the one folder that stands for a deck.
const DECK_KIND: &str = crate::schema::COLLECTION_FOLDER_KINDS[1];
/// What is actually sleeved up — `DECK_VARIANTS[0]`, [`crate::deck`]'s discipline.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// What the deck is being built toward, and the one variant these writes refuse.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];

/// What a move did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    /// The collection row the copies ended up in — **the destination's id**, which is not the
    /// id the caller handed in whenever the write merged. `None` when nothing moved, which is
    /// a deck card nobody owned going away.
    pub entry_id: Option<i64>,
    /// Set when the copies came out of another deck, so the UI can say which one it took them
    /// from **after** the fact as well as before it. Never set by [`deck_to_collection`],
    /// where the deck they came out of is the one the reader is looking at.
    pub from_deck: Option<String>,
    /// How many copies actually moved. Never more than was asked; less only where the deck
    /// list wanted more than the group held.
    pub quantity: i64,
}

/// One entry, as much of it as a move has to know before it moves.
///
/// **`tradelist_quantity` is deliberately not here**, and its absence is the shape of the split:
/// this struct answers *where the copies are and what they are*, which is what
/// [`collection_to_deck`] decides with, while how a partial row is divided is
/// [`take_copies`]' own arithmetic and reads its columns for itself.
struct Source {
    folder_id: Option<i64>,
    card_id: String,
    finish: String,
    quantity: i64,
}

/// Read one collection row, or [`crate::collection::GONE`].
fn source_of(conn: &Connection, entry_id: i64) -> Result<Source, String> {
    conn.query_row(
        "SELECT folder_id, card_id, finish, quantity FROM collection_entries WHERE id = ?1",
        params![entry_id],
        |r| {
            Ok(Source {
                folder_id: r.get(0)?,
                card_id: r.get(1)?,
                finish: r.get(2)?,
                quantity: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| crate::collection::GONE.to_owned())
}

/// The folder that stands for a deck, if it has one.
fn deck_group(conn: &Connection, deck_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM collection_folders WHERE deck_id = ?1 AND kind = ?2",
        params![deck_id, DECK_KIND],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The deck whose group a folder is, if it is one.
///
/// `None` for the root, for a binder the reader named and for `Recently removed` — all three
/// are places a copy can come from without a deck losing anything.
fn source_deck(conn: &Connection, folder_id: Option<i64>) -> Result<Option<(i64, String)>, String> {
    let Some(folder_id) = folder_id else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT d.id, d.name FROM collection_folders f
           JOIN decks d ON d.id = f.deck_id
          WHERE f.id = ?1 AND f.kind = ?2",
        params![folder_id, DECK_KIND],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Take `quantity` copies of a printing off a deck's **live** list, oldest row first.
///
/// The copies have physically left that deck, so its list has to stop claiming them — this is
/// the half of a move that lands on a deck the reader is not looking at, and
/// [`MoveOutcome::from_deck`] is what lets the UI say so.
///
/// **Rows are taken oldest first and there may be several**: one printing can sit in two
/// categories of one deck, and nothing says which of them the copies were "in". Clamped at what
/// is actually there rather than refused, because the group and the list can disagree — an
/// import writes a list without moving copies — and refusing here would leave the copies half
/// moved over a disagreement this write did not cause.
///
/// Zero deletes, `deck_cards.quantity`'s `CHECK (quantity > 0)` and
/// [`crate::deck::set_card_quantity`]'s rule: a category slot holding no copies holds nothing.
fn take_from_deck_list(
    tx: &Connection,
    deck_id: i64,
    card_id: &str,
    finish: Option<&str>,
    quantity: i64,
) -> Result<(), String> {
    let rows: Vec<(i64, i64)> = tx
        .prepare(
            "SELECT id, quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 AND card_id = ?3
                AND coalesce(finish, '') = coalesce(?4, '')
              ORDER BY id",
        )
        .and_then(|mut s| {
            s.query_map(params![deck_id, LIVE, card_id, finish], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;

    let mut left = quantity;
    for (id, held) in rows {
        if left == 0 {
            break;
        }
        let take = held.min(left);
        if take == held {
            tx.execute("DELETE FROM deck_cards WHERE id = ?1", params![id])
        } else {
            tx.execute(
                "UPDATE deck_cards SET quantity = quantity - ?2, updated_at = unixepoch()
                  WHERE id = ?1",
                params![id, take],
            )
        }
        .map_err(|e| e.to_string())?;
        left -= take;
    }
    Ok(())
}

/// Take `quantity` copies out of the collection row `entry_id`, put them in a deck's group, and
/// write the `deck_cards` row that says the deck plays them.
///
/// **Every refusal is in words.** A missing deck, category or entry and a quantity larger than
/// the row holds would each otherwise surface as a foreign-key or `CHECK` failure naming the
/// table rather than the mistake — and `PRAGMA foreign_keys` is per-connection, so on a
/// connection that has it off some of them would not surface at all.
///
/// **The copies may be coming out of another deck**, which is the case this function exists to
/// get right: the source row sits in that deck's group, so taking it decrements that deck's
/// live list by the same quantity and reports its name in [`MoveOutcome::from_deck`]. The UI
/// confirms that before pressing, because the side effect lands somewhere the reader is not
/// looking.
///
/// One transaction, for the reason every fold in this crate is one: mid-move the copies are in
/// both places or in neither.
///
/// **This one writes no `deck_audit` row yet, and its sibling does.** The asymmetry is not a
/// decision — it is the same hole [`deck_to_collection`] had, wanting the same answer (the `add`
/// row [`crate::deck::add_card`] writes) — and it is left because nothing calls this command
/// from the window: putting a card *into* a deck from the collection is the Collection Search
/// tab's press, which has not landed. A cut can be made today and needs its history today; an
/// add cannot be made at all.
pub fn collection_to_deck(
    conn: &Connection,
    entry_id: i64,
    deck_id: i64,
    category_id: i64,
    quantity: i64,
) -> Result<MoveOutcome, String> {
    if quantity <= 0 {
        return Err(ZERO_MOVE.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Doubles as the deck fence: it answers `deck::GONE` for an id with no row, one statement
    // before there is an orphan to worry about. [`crate::deck::touch_deck`]'s own argument.
    crate::deck::touch_deck(&tx, deck_id)?;
    // "Gone" and "not yours" are different things to tell a stale editor —
    // [`crate::deck::category_of_deck`]'s two sentences, which is private to that module.
    let owner: i64 = tx
        .query_row(
            "SELECT deck_id FROM deck_categories WHERE id = ?1",
            params![category_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| crate::deck_meta::CATEGORY_GONE.to_owned())?;
    if owner != deck_id {
        return Err(crate::deck_meta::CATEGORY_WRONG_DECK.to_owned());
    }
    let group = deck_group(&tx, deck_id)?.ok_or_else(|| NO_DECK_GROUP.to_owned())?;

    let source = source_of(&tx, entry_id)?;
    if quantity > source.quantity {
        return Err(NOT_THAT_MANY.to_owned());
    }
    if source.folder_id == Some(group) {
        return Err(ALREADY_HERE.to_owned());
    }
    // Read before anything moves: `printing_of` is the one query that says what a deck row
    // remembers, and the name is the half a collection row does not carry.
    let (set_code, collector_number, lang, name) = crate::deck::printing_of(&tx, &source.card_id)?;
    // `'nonfoil'` is `NULL` on a deck row and never stored — [`crate::deck::normalise_finish`]
    // is the one place that translation happens.
    let finish = crate::deck::normalise_finish(Some(&source.finish))?;
    let from = source_deck(&tx, source.folder_id)?;

    let landed = take_copies(&tx, entry_id, quantity, Some(group))?;
    if let Some((other, _)) = &from {
        take_from_deck_list(&tx, *other, &source.card_id, finish.as_deref(), quantity)?;
        crate::deck::touch_deck(&tx, *other)?;
    }

    // The conflict target is `DECK_CARD_GRAIN` verbatim — the same text the unique index was
    // created from, [`crate::deck::add_card`]'s discipline. `tag_id` and `needs_review` are
    // left alone: the row already there is the one the user labelled.
    tx.execute(
        &format!(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, finish, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, unixepoch(), unixepoch())
             ON CONFLICT({grain}) DO UPDATE SET
                 quantity = deck_cards.quantity + excluded.quantity,
                 updated_at = unixepoch()",
            grain = crate::schema::DECK_CARD_GRAIN
        ),
        params![
            deck_id,
            category_id,
            LIVE,
            source.card_id,
            set_code,
            collector_number,
            lang,
            name,
            finish,
            quantity
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MoveOutcome {
        entry_id: Some(landed),
        from_deck: from.map(|(_, name)| name),
        quantity,
    })
}

/// Cut `quantity` copies from a deck card and file whatever the deck's group holds for that
/// printing into `Recently removed`.
///
/// **A theory row is refused.** A theory list is a plan and a plan holds no cards, so there is
/// nothing in any folder for it to give back — a press that reported success and moved nothing
/// would read as a card that vanished.
///
/// **A deck card with no backing copies just goes away**, and that is the whole reason no
/// per-deck-card provenance flag is needed. A card added from search is an intention to buy;
/// the reader never owned it, so nothing lands on their desk when it is cut. The group **is**
/// the record of which is which.
///
/// [`MoveOutcome::quantity`] is what actually moved, which is less than what was asked whenever
/// the list wanted more than the group held. [`MoveOutcome::from_deck`] stays `None`: the deck
/// these came out of is the one the reader is looking at.
///
/// # The history is [`crate::deck::set_card_quantity`]'s, verbatim
///
/// This command **replaces** that one for a decrease on the live list, and a replacement that
/// wrote no history would be a deck whose log skips exactly the press a reader goes looking for.
/// So the row is the one the stepper would have written and not a new shape: a `remove` with
/// `{ category, quantity, reason: null }` where the whole row goes, a `quantity` with
/// `{ category, from, to }` where part of it does, `delta` negative in both, and the card's
/// stored name so the line still reads once the printing has left `cards`. `auditText.ts` needs
/// no new arm, and a deck's history reads continuously across the change of command — which is
/// the whole point, since the reader cannot see which command ran.
///
/// **It is recorded even when nothing moved.** A deck card nobody owned still *left the deck*,
/// and the history is a record of the deck rather than of the collection.
///
/// # There is deliberately no undo step, and that is a decision rather than an omission
///
/// A cut changes **two** rows in two tables: the `deck_cards` row, and a `collection_entries`
/// row that has moved into `Recently removed`. [`crate::deck_undo`] can express the first and
/// only the first — a step names cells of `deck_cards` and *restores rows*, deliberately never
/// running a command backwards, and its four primitives touch no collection table at all.
///
/// **The half-step is the state that must not ship.** Filing an [`crate::deck_undo::Op::Cards`]
/// beside the audit row would put the list back and leave the copies where they went, so a deck
/// would claim four copies its own group no longer holds while the reader — who pressed Ctrl+Z
/// and watched the row reappear — believed the cut had been reversed. That is worse than no undo
/// at all, because the wrong number is one the reader has been given a reason to trust.
///
/// **Teaching the journal the other half is not available either.** The copies did not merely
/// move: [`take_copies`] files them through the merge, so the source row may have been *folded
/// into* whatever `Recently removed` already held and no longer exists to restore. Putting them
/// back is a quantity moved between two folders — a command run backwards, which is the one
/// design this journal rejects — and it can fail for reasons that are not a refactor's fault
/// (the reader filed them in a binder, or sold them), while `MISSING_ROW` is the module's only
/// failure and is documented as a bug in a call site.
///
/// **What makes the absence visible.** The Undo button's name *is* the change it would reverse
/// ("Undo — Removed 2 × Lightning Bolt"), read from [`crate::deck_undo::next_undo`], so a cut
/// that files no step leaves the button naming the press *before* it and never offers one it
/// cannot deliver.
///
/// **And the consequence, said plainly, because the button's name is only visible to somebody
/// reading it: a cut does not advance the undo cursor, so the previous step remains the one
/// Ctrl+Z will take.** Cutting a card and pressing Ctrl+Z reverses the *older* change — the
/// rename, the add, the pile move before it — rather than the cut and rather than nothing. The
/// label is honest about that the whole time; a keyboard user who never looks at it is who this
/// sentence is for.
///
/// The complete way back is [`collection_to_deck`], which restores **both** halves in one press
/// — but **nothing calls it in this release**: a deck group is deliberately not a drop target,
/// so there is no gesture that puts a cut card back where it was until the Collection Search tab
/// lands. Until then the way back is two presses, add the card again and re-file its copies out
/// of `Recently removed` by hand. The cost, stated plainly, is that a cut cannot be reversed
/// from the keyboard; the card is never lost.
///
/// The same reasoning, reached first: [`crate::deck::clear_category`] restores the list and not
/// the custody. It differs only in having a `deck_cards` half worth a step on its own — a
/// cleared pile is many rows and no other command can rebuild it — where one cut card is a
/// single stepper press away from being put back by hand.
///
/// `a_cut_is_not_offered_to_undo_and_files_no_step` is what holds this: adding the half-step
/// moves the cursor, and that case goes red.
pub fn deck_to_collection(
    conn: &Connection,
    deck_card_id: i64,
    quantity: i64,
) -> Result<MoveOutcome, String> {
    if quantity <= 0 {
        return Err(ZERO_MOVE.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // `name` and the category's name are read for the history and for nothing else — the two
    // columns [`crate::deck::set_card_quantity`] reads before *its* write, for its reason: the
    // row can be gone a statement later and a history line that could only say `e7f8…` is not a
    // history. **`LEFT JOIN`**, because the payload's `category` is a fact the row may not have:
    // `deck_cards.category_id` is a real foreign key, so a NULL here is a database edited by
    // hand, and refusing a reader's cut over a missing pile name would be the history deciding
    // whether a card may leave a deck.
    let (deck_id, card_id, name, category, finish, variant, held) = tx
        .query_row(
            "SELECT d.deck_id, d.card_id, d.name, c.name, d.finish, d.variant, d.quantity
               FROM deck_cards d
               LEFT JOIN deck_categories c ON c.id = d.category_id
              WHERE d.id = ?1",
            params![deck_card_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| DECK_CARD_GONE.to_owned())?;
    if variant == THEORY {
        return Err(THEORY_HOLDS_NOTHING.to_owned());
    }
    if quantity > held {
        return Err(NOT_THAT_MANY.to_owned());
    }

    // **The move is [`crate::deck::release_group_copies`]' and is not written a second time
    // here.** Finding this deck's group, reading the rows behind the card, taking them oldest
    // first and filing them into `Recently removed` is one rule about the reader's cards, and
    // this function spelled its own copy of it beside the bulk one until fan-in — including the
    // exact-printing match that turned out to be *wrong*, which is what a second copy costs: a
    // fix has to be made twice or it is made once. What is left here is the half that is
    // genuinely this command's — the `deck_cards` write, the history row, and the
    // [`MoveOutcome`] a caller draws a sentence from.
    //
    // Everything that walk decides is argued there: the oracle-card fallback that reaches a
    // swapped printing's copies, the missing group that holds nothing rather than refusing, the
    // clamp at what the group actually has, and the holding area resolved only when there is
    // something to file — so a database missing that folder still lets a card nobody owned be
    // cut.
    let crate::deck::Released { moved, landed } =
        crate::deck::release_group_copies(&tx, deck_id, &card_id, finish.as_deref(), quantity)?;

    let whole_row = quantity == held;
    if whole_row {
        tx.execute(
            "DELETE FROM deck_cards WHERE id = ?1",
            params![deck_card_id],
        )
    } else {
        tx.execute(
            "UPDATE deck_cards SET quantity = quantity - ?2, updated_at = unixepoch()
              WHERE id = ?1",
            params![deck_card_id, quantity],
        )
    }
    .map_err(|e| e.to_string())?;

    // The two shapes [`crate::deck::set_card_quantity`] writes for the two branches above,
    // copied rather than approximated — see this function's doc. `reason` stays `null`: that
    // key is where a removal *for a stated reason* would go, and where the copies went is a
    // standing fact about every cut on this list rather than something true of this one row,
    // said once at the foot of the deck. `delta` is negative either way, because both branches
    // took copies off the list.
    //
    // The id [`crate::deck_audit::record`] answers is discarded, which is the call shape of
    // every site that files no reversal: there is no [`crate::deck_undo`] step to key on it.
    let (kind, payload) = if whole_row {
        (
            crate::deck_audit::REMOVE,
            json!({ "category": category, "quantity": quantity, "reason": null }),
        )
    } else {
        (
            crate::deck_audit::QUANTITY,
            json!({ "category": category, "from": held, "to": held - quantity }),
        )
    };
    crate::deck_audit::record(
        &tx,
        deck_id,
        &variant,
        kind,
        Some((&card_id, &name)),
        &payload,
        -quantity,
    )?;
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MoveOutcome {
        entry_id: landed,
        from_deck: None,
        quantity: moved,
    })
}

/// The two commands, in a module of their own so the wire names and the function names can be
/// the same word.
///
/// `generate_handler!` takes the last segment of the path as the command name, so these
/// register as `collection_to_deck` and `deck_to_collection` — the names the webview invokes —
/// while [`super::collection_to_deck`] and [`super::deck_to_collection`] keep those names for
/// the crate. The alternative was the `add_entry`/`collection_add` split every other cabinet
/// uses, which would have meant two words for one write in a module that has only two.
pub mod commands {
    use super::{collection_to_deck as to_deck, deck_to_collection as to_collection, MoveOutcome};
    use crate::sync::AppState;
    use std::sync::Arc;

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**: this moves
    /// a row between folders and can delete one by folding it, and the facet index's `owned`
    /// dimension is built by counting rows. Every deck command in the crate carries a comment
    /// saying this pair would be the exception.
    #[tauri::command]
    pub async fn collection_to_deck(
        state: tauri::State<'_, Arc<AppState>>,
        entry_id: i64,
        deck_id: i64,
        category_id: i64,
        quantity: i64,
    ) -> Result<MoveOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                to_deck(c, entry_id, deck_id, category_id, quantity)
            })
        })
        .await
        .map_err(|e| format!("the cards could not be moved: {e}"))?
    }

    /// [`collection_to_deck`]'s wrapper, for [`collection_to_deck`]'s reason.
    #[tauri::command]
    pub async fn deck_to_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_card_id: i64,
        quantity: i64,
    ) -> Result<MoveOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                to_collection(c, deck_card_id, quantity)
            })
        })
        .await
        .map_err(|e| format!("the cards could not be moved: {e}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::tests::{deck as seed_deck, seed_card};
    use serde_json::Value;

    /// **`foreign_keys` is ON**, as [`crate::db::open`] sets it for every connection the app
    /// hands out: `collection_entries.folder_id` SET NULLs and `collection_folders.deck_id`
    /// CASCADEs, and both are per-connection settings an in-memory database starts without.
    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// A deck, its group and one `main` category.
    ///
    /// **The group is an INSERT rather than a side effect of `create_deck`**: it is a sibling
    /// task's wiring and this suite must not depend on the order the two land in. The migration
    /// makes one per deck for every deck that already existed; a deck made after the upgrade
    /// gets one from the create.
    fn deck_with_group(conn: &Connection, name: &str) -> (i64, i64) {
        let deck = seed_deck(conn, name);
        let _group: i64 = conn
            .query_row(
                "INSERT INTO collection_folders
                     (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
                 VALUES (NULL, ?1, 'deck', ?2, 0, unixepoch(), unixepoch())
                 RETURNING id",
                params![name, deck],
                |r| r.get(0),
            )
            .unwrap();
        let category = crate::schema::tests::category(conn, deck, "main", "Main deck");
        (deck, category)
    }

    /// One card, one deck with its group, one category.
    fn fixture() -> (Connection, i64, i64) {
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let (deck, category) = deck_with_group(&conn, "Deck A");
        (conn, deck, category)
    }

    /// A second deck, so a copy can be taken out of one and put in the other.
    fn second_deck(conn: &Connection) -> (i64, i64) {
        deck_with_group(conn, "Deck B")
    }

    /// One owned row at the one grain this suite needs, filed where it is told.
    fn seed_entry(conn: &Connection, card_id: &str, quantity: i64, folder: Option<i64>) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                 (card_id, set_code, collector_number, lang, finish, condition, quantity,
                  folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', 'nonfoil', 'NM', ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Copies of a printing sitting in a named folder — `0` when the folder holds none.
    fn folder_copies(conn: &Connection, folder: Option<i64>, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE card_id = ?1 AND coalesce(folder_id, 0) = coalesce(?2, 0)",
            params![card_id, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Copies still in the binder itself, filed under nothing.
    fn root_copies(conn: &Connection, card_id: &str) -> i64 {
        folder_copies(conn, None, card_id)
    }

    /// Copies sitting in a deck's group.
    fn group_copies(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        let group = deck_group(conn, deck).unwrap();
        folder_copies(conn, group, card_id)
    }

    /// The collection row in a deck's group, which is where a refile lands the copies.
    fn group_entry(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        let group = deck_group(conn, deck).unwrap();
        conn.query_row(
            "SELECT id FROM collection_entries
              WHERE card_id = ?1 AND folder_id = ?2",
            params![card_id, group],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Copies in the holding area. Read by kind rather than through a helper of the module's
    /// own: resolving `Recently removed` is [`crate::deck::release_group_copies`]' now, and the
    /// twin that used to sit here went with the loop it served.
    fn removed_copies(conn: &Connection, card_id: &str) -> i64 {
        let removed: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE kind = ?1",
                params![crate::schema::COLLECTION_FOLDER_KINDS[2]],
                |r| r.get(0),
            )
            .expect("every database past v25 has one `removed` folder");
        folder_copies(conn, Some(removed), card_id)
    }

    /// What a deck's **live** list says it plays.
    fn deck_copies(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND variant = 'live'",
            params![deck, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The one live `deck_cards` row for a printing.
    fn deck_card(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND variant = 'live'",
            params![deck, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A deck row written straight into the table, so a list can hold a card no folder does.
    fn add_variant_card(
        conn: &Connection,
        deck: i64,
        category: i64,
        variant: &str,
        card_id: &str,
        quantity: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'lea', '161', 'en', 'Lightning Bolt', ?5,
                     unixepoch(), unixepoch())
             RETURNING id",
            params![deck, category, variant, card_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A live deck row with no backing copies — added from search as "I need to buy this".
    fn add_deck_card(conn: &Connection, deck: i64, category: i64, card_id: &str, q: i64) -> i64 {
        add_variant_card(conn, deck, category, LIVE, card_id, q)
    }

    /// A theory row, which is a plan and holds nothing.
    fn add_theory_card(conn: &Connection, deck: i64, category: i64, card_id: &str, q: i64) -> i64 {
        add_variant_card(conn, deck, category, THEORY, card_id, q)
    }

    /// Copies no deck is holding and nothing has removed — what is actually available to be
    /// put in a deck. A fact about **where the rows sit**, which is the whole point.
    fn unallocated_copies(conn: &Connection, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(e.quantity), 0) FROM collection_entries e
               LEFT JOIN collection_folders f ON f.id = e.folder_id
              WHERE e.card_id = ?1 AND coalesce(f.kind, 'user') = 'user'",
            params![card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_card_taken_from_the_binder_leaves_the_binder() {
        let (conn, deck, cat) = fixture();
        let entry = seed_entry(&conn, "bolt", 4, None);
        collection_to_deck(&conn, entry, deck, cat, 1).unwrap();
        assert_eq!(root_copies(&conn, "bolt"), 3);
        assert_eq!(group_copies(&conn, deck, "bolt"), 1);
        assert_eq!(deck_copies(&conn, deck, "bolt"), 1);
    }

    #[test]
    fn taking_a_copy_from_another_deck_decrements_that_deck_too() {
        // The case the UI confirms before pressing, because the side effect lands on a deck the
        // reader is not looking at.
        let (conn, a, cat_a) = fixture();
        let (b, cat_b) = second_deck(&conn);
        let entry = seed_entry(&conn, "bolt", 1, None);
        collection_to_deck(&conn, entry, a, cat_a, 1).unwrap();
        let filed = group_entry(&conn, a, "bolt");
        let out = collection_to_deck(&conn, filed, b, cat_b, 1).unwrap();
        assert_eq!(out.from_deck.as_deref(), Some("Deck A"));
        assert_eq!(
            deck_copies(&conn, a, "bolt"),
            0,
            "the first deck lost the card"
        );
        assert_eq!(deck_copies(&conn, b, "bolt"), 1);
        assert_eq!(group_copies(&conn, a, "bolt"), 0);
    }

    #[test]
    fn a_card_cut_from_a_deck_lands_in_recently_removed() {
        let (conn, deck, cat) = fixture();
        let entry = seed_entry(&conn, "bolt", 1, None);
        collection_to_deck(&conn, entry, deck, cat, 1).unwrap();
        let dc = deck_card(&conn, deck, "bolt");
        deck_to_collection(&conn, dc, 1).unwrap();
        assert_eq!(removed_copies(&conn, "bolt"), 1);
        assert_eq!(deck_copies(&conn, deck, "bolt"), 0);
    }

    /// A second printing of the **same** oracle card — [`seed_card`] with the oracle id copied
    /// off the first, because that helper derives one per printing (`'o-' || id`) and "a Bolt
    /// is a Bolt" is a question two rows sharing an oracle id are the only way to ask.
    fn seed_reprint(conn: &Connection, id: &str, of: &str) {
        seed_card(conn, id, "m10", "146");
        conn.execute(
            "UPDATE cards SET oracle_id = (SELECT oracle_id FROM cards WHERE id = ?2)
              WHERE id = ?1",
            params![id, of],
        )
        .unwrap();
    }

    #[test]
    fn a_cut_reaches_the_copies_when_the_list_names_another_printing() {
        // The state "Use this printing" leaves behind — `deck_swap_printing` rewrites the deck
        // row's `card_id` and touches no collection table — and the state the v25 conversion
        // writes wholesale, because the old allocator matched candidates by **oracle id**: a
        // claim on an M10 Bolt for a deck that lists the Alpha one becomes exactly this.
        //
        // Matched on the exact printing alone, the cut moves nothing: the deck card goes and
        // the copies stay filed under a deck that no longer lists them — invisible, and
        // unavailable to every other deck.
        let (conn, deck, cat) = fixture();
        seed_reprint(&conn, "bolt-m10", "bolt");
        let group = deck_group(&conn, deck).unwrap();
        seed_entry(&conn, "bolt", 2, group);
        let dc = add_variant_card(&conn, deck, cat, "live", "bolt-m10", 2);

        let out = deck_to_collection(&conn, dc, 2).unwrap();

        assert_eq!(
            out.quantity, 2,
            "a Bolt is a Bolt — `owned_by_oracle`'s rule"
        );
        assert_eq!(removed_copies(&conn, "bolt"), 2);
        assert_eq!(
            group_copies(&conn, deck, "bolt"),
            0,
            "nothing is left stranded in a group whose deck no longer lists it"
        );
    }

    #[test]
    fn a_cut_takes_the_exact_printing_before_another_of_the_same_card() {
        // The fallback is a fallback: where the group holds the very printing the list names,
        // that is the row that leaves, and the reader's other copy stays where they put it.
        // This is what keeps the common case — every cut of a card nobody ever swapped —
        // byte-for-byte what it was before the oracle arm existed.
        let (conn, deck, cat) = fixture();
        seed_reprint(&conn, "bolt-m10", "bolt");
        let group = deck_group(&conn, deck).unwrap();
        seed_entry(&conn, "bolt", 1, group);
        seed_entry(&conn, "bolt-m10", 1, group);
        let dc = add_variant_card(&conn, deck, cat, "live", "bolt-m10", 1);

        deck_to_collection(&conn, dc, 1).unwrap();

        assert_eq!(
            removed_copies(&conn, "bolt-m10"),
            1,
            "the printing it names"
        );
        assert_eq!(removed_copies(&conn, "bolt"), 0);
        assert_eq!(group_copies(&conn, deck, "bolt"), 1, "the other one stays");
    }

    #[test]
    fn a_deck_card_nobody_owned_just_goes_away() {
        // Added from Normal Search as "I need to buy this". There is no backing copy, so nothing
        // lands on the reader's desk — and this is why no per-deck-card provenance flag is needed.
        let (conn, deck, cat) = fixture();
        let dc = add_deck_card(&conn, deck, cat, "bolt", 1);
        deck_to_collection(&conn, dc, 1).unwrap();
        assert_eq!(removed_copies(&conn, "bolt"), 0);
        assert_eq!(deck_copies(&conn, deck, "bolt"), 0);
    }

    #[test]
    fn a_theory_row_never_touches_the_collection() {
        let (conn, deck, cat) = fixture();
        let dc = add_theory_card(&conn, deck, cat, "bolt", 1);
        let err = deck_to_collection(&conn, dc, 1).unwrap_err();
        assert_eq!(err, THEORY_HOLDS_NOTHING);
    }

    /// One history row, as these tests compare them: kind, the card's name, the payload and the
    /// signed delta. `deck_audit::list` answers newest first; this reverses it so a case reads in
    /// the order the presses happened.
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

    /// How many reversals this deck has filed. Unmoved by a cut, and that is the point.
    fn steps(conn: &Connection, deck: i64) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM deck_undo WHERE deck_id = ?1",
            params![deck],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A deck holding four copies it actually owns, plus the id of the deck card.
    fn cut_fixture() -> (Connection, i64, i64, i64) {
        let (conn, deck, cat) = fixture();
        let entry = seed_entry(&conn, "bolt", 4, None);
        collection_to_deck(&conn, entry, deck, cat, 4).unwrap();
        let dc = deck_card(&conn, deck, "bolt");
        (conn, deck, cat, dc)
    }

    #[test]
    fn cutting_a_whole_row_records_the_remove_a_stepper_would_have() {
        // The regression this pair of tests exists for: routing a live decrease through this
        // command took the press off [`crate::deck::set_card_quantity`], and the history went
        // with it. The row has to be the one that command would have written, or a deck's
        // history has a hole in it at exactly the press a reader most wants to look up.
        let (conn, deck, _cat, dc) = cut_fixture();
        deck_to_collection(&conn, dc, 4).unwrap();
        assert_eq!(
            history(&conn, deck),
            vec![(
                crate::deck_audit::REMOVE.to_owned(),
                Some("Lightning Bolt".to_owned()),
                json!({ "category": "Main deck", "quantity": 4, "reason": null }),
                -4,
            )]
        );
    }

    #[test]
    fn cutting_part_of_a_row_records_the_quantity_change() {
        let (conn, deck, _cat, dc) = cut_fixture();
        deck_to_collection(&conn, dc, 3).unwrap();
        assert_eq!(
            history(&conn, deck),
            vec![(
                crate::deck_audit::QUANTITY.to_owned(),
                Some("Lightning Bolt".to_owned()),
                json!({ "category": "Main deck", "from": 4, "to": 1 }),
                -3,
            )]
        );
    }

    #[test]
    fn cutting_a_card_nobody_owned_is_still_recorded() {
        // Nothing lands on the reader's desk, but the *deck* changed — and the history is a
        // record of the deck. Recording nothing here would be the hole again, on exactly the
        // rows a reader is least sure about.
        let (conn, deck, cat) = fixture();
        let dc = add_deck_card(&conn, deck, cat, "bolt", 2);
        let out = deck_to_collection(&conn, dc, 2).unwrap();
        assert_eq!(out.quantity, 0, "there was nothing to move");
        assert_eq!(
            history(&conn, deck),
            vec![(
                crate::deck_audit::REMOVE.to_owned(),
                Some("Lightning Bolt".to_owned()),
                json!({ "category": "Main deck", "quantity": 2, "reason": null }),
                -2,
            )]
        );
    }

    #[test]
    fn a_refused_cut_records_nothing() {
        // [`crate::deck_audit::record`] joins the caller's transaction, so a refusal takes the
        // row with it — the whole reason writing history is not a command of its own.
        let (conn, deck, cat) = fixture();
        let dc = add_theory_card(&conn, deck, cat, "bolt", 1);
        deck_to_collection(&conn, dc, 1).unwrap_err();
        assert_eq!(history(&conn, deck), vec![]);
        assert_eq!(steps(&conn, deck), 0);
    }

    #[test]
    fn a_cut_is_not_offered_to_undo_and_files_no_step() {
        // **The deliberate absence, pinned.** A cut changes two things — the `deck_cards` row and
        // a collection row that has moved into `Recently removed` — and [`crate::deck_undo`] can
        // express only the first. A step carrying that half alone would put the list back and
        // leave the copies where they went, so the deck would claim four copies its group no
        // longer holds while the reader believed Ctrl+Z had worked. So no step is filed, the
        // cursor stays where it was, and the Undo button goes on naming the change *before* the
        // cut rather than offering one it cannot deliver.
        //
        // **This test is what stops the half-fix**: put a `record_cells` beside the audit row and
        // the cursor moves, and this goes red.
        let (conn, deck, cat, dc) = cut_fixture();
        crate::deck::set_card_quantity(&conn, deck, "bolt", cat, "live", None, 3).unwrap();
        let before = crate::deck_undo::next_undo(&conn, deck).unwrap();
        assert!(
            before.is_some(),
            "the stepper filed one, or this case proves nothing"
        );
        let filed = steps(&conn, deck);

        let held: i64 = conn
            .query_row(
                "SELECT quantity FROM deck_cards WHERE id = ?1",
                params![dc],
                |r| r.get(0),
            )
            .unwrap();
        deck_to_collection(&conn, dc, held).unwrap();

        assert_eq!(steps(&conn, deck), filed, "a cut files no reversal");
        assert_eq!(
            crate::deck_undo::next_undo(&conn, deck).unwrap(),
            before,
            "and the cursor still points at the change before it"
        );
        assert_eq!(
            history(&conn, deck).len(),
            2,
            "while the history carries both presses"
        );
    }

    #[test]
    fn a_copy_in_a_deck_group_is_not_available_to_another_deck() {
        // Exclusivity, which is the whole point: it is a fact about where the row sits, not a sum.
        let (conn, a, cat_a) = fixture();
        let entry = seed_entry(&conn, "bolt", 1, None);
        collection_to_deck(&conn, entry, a, cat_a, 1).unwrap();
        let free = unallocated_copies(&conn, "bolt");
        assert_eq!(free, 0, "the only copy is spoken for");
    }
}
