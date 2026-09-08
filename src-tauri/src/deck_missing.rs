//! Recording a whole deck's worth of just-bought cardboard in one press — the preview that says
//! what it would do, and the write that does all of it or none of it.
//!
//! [`crate::deck_quick_add`] is this press for one card, reached by right-clicking a deck row. It
//! has been there since 2026-09-03 and it has no deck-wide form: a reader who came home with a
//! bag of singles for one deck had to open thirty menus. This module is that form —
//! [`plan`] lists every printing the live list is short of, with the wishlist lines each one could
//! take down, and [`to_collection`] records the copies the reader ticked.
//!
//! ```text
//!   nothing at all ──── deck_missing_to_collection ───▶ this deck's group
//!                     (`deck_cards` is not written at all)
//! ```
//!
//! # It *creates* cardboard where [`crate::deck_pull`] *moves* it, and that is the whole design
//!
//! A shortfall has three answers and the app now draws all three. The pull is for copies the
//! reader already owns, loose in a binder — it changes one `collection_entries.folder_id` and
//! nothing else exists afterwards that did not exist before. `Send missing to wishlist` is for
//! copies they have still to buy. **This one is for copies they bought this morning**: the
//! cardboard is real, on the desk, and the database has never heard of it. So it is a create, it
//! goes through [`crate::collection::add_entry_filed`] with
//! [`crate::collection::DECK_WRITE_FOLDERS`], and it is the second press in the crate to owe
//! [`crate::collection_source::with_write_owned`] for the *strong* reason rather than the weak
//! one — the facet index's `owned` dimension counts `collection_entries` rows, and this makes
//! several of them in one press.
//!
//! **The two presses overlap on purpose and the reader chooses.** A copy in a binder and a copy
//! bought this morning are two different pieces of cardboard, so [`plan`] does not drop a row
//! because [`crate::deck_pull::plan`] could also offer it. A read that hid the second because of
//! the first would refuse to record a card the reader is holding.
//!
//! # The pick is addressed by `(card_id, finish)`, because the row does not exist yet
//!
//! That is the one structural difference from [`crate::deck_pull::Pick`], which carries a
//! `collection_entries` id. There is no id to carry here: what a [`MissingPick`] names is
//! cardboard, and which row it lands in is [`crate::collection::add_entry_filed`]'s answer after
//! the grain fold — a second press on the same line raises the row the first one made.
//!
//! # All-or-nothing, and the re-plan inside the transaction is what decides
//!
//! [`crate::deck_pull::from_collection`]'s rule and for its reason: this write files no
//! [`crate::deck_undo`] step — it changes no `deck_cards` row, so the only half a step could
//! express is the half that does not exist — and a half-applied batch therefore has no press that
//! takes it back. One transaction, every pick checked against a plan built **here** rather than
//! against the one the dialog was drawn from.
//!
//! **That re-plan subsumes [`crate::deck::plays_card`]**, which is why this module does not call
//! it and why nothing was hoisted out of [`crate::deck_quick_add::quick_add`] but the eight lines
//! of [`crate::deck_quick_add::record_copies`]: a card the deck does not play has no shortfall
//! row, so the fence the per-card press needs is one this one already passed a statement earlier.
//! Two fences for one mistake would be two sentences for it too.
//!
//! # The wish half chooses rather than being pointed
//!
//! [`crate::deck_quick_add::quick_add`] takes one `wish_id` because a right-click can open a
//! picker. A deck-wide press over thirty rows cannot ask thirty questions, so this one re-asks
//! [`crate::deck_quick_add::wishes`] inside the transaction and acts **only on an unambiguous
//! answer** — see [`take_lone_wish`]. Nothing about a wish reaches the wire, and this write has no
//! stale-wish refusal at all.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

/// Reused verbatim rather than respelled — this crate's standing rule, and the same one that
/// keeps [`crate::collection::ZERO_ADD`] a single sentence for two tables. Both of these are
/// about the **deck** and read identically whichever press produced them.
use crate::deck_pull::{MORE_THAN_MISSING, NOT_SHORT_OF_THAT};

/// What [`to_collection`] says when it was handed an empty list.
///
/// [`crate::deck_pull::NOTHING_PICKED`]'s refusal with this press's verb: that one says "pull into
/// this deck", and a batch that records nothing is a different sentence about the same mistake.
/// Refused rather than answered with a zero [`MissingOutcome`], because a caller that reaches this
/// has lost track of what the reader ticked and a cheerful "0 copies recorded" is how it goes on
/// believing something was selected.
pub const NOTHING_PICKED: &str = "Pick at least one copy to add to your collection.";

/// What [`to_collection`] says about a pick whose printing has left `cards`.
///
/// A corpus resync under an open dialog. Distinct from [`NOT_SHORT_OF_THAT`], which is about the
/// **deck** — the copies could be recorded and it does not want them — where this is about the
/// **card**: [`crate::collection::add_entry_filed`] reads `set_code`, `collector_number` and
/// `lang` off the `cards` row, so a printing that is gone cannot be filed at all.
pub const LEFT_THE_DATABASE: &str =
    "That printing has left the card database and cannot be recorded.";

/// What is actually sleeved up — `DECK_VARIANTS[0]`, and the only list this press answers about.
/// A plan holds no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so it is short of
/// none and [`crate::deck::live_shortfall`] never offers one.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];

/// `FINISHES[0]` — the word [`crate::deck::normalise_finish`] maps *away* on a deck row and the
/// one `collection_entries.finish` and `wishlist_entries.preferred_finish` store for a plain copy.
/// Reading it back is the whole of the translation between the deck's spelling and the other two
/// tables', and it is not respelled anywhere else in this module.
const NONFOIL: &str = crate::schema::FINISHES[0];

/// Is this printing still in the card database? [`plan`]'s one filter and [`to_collection`]'s one
/// way to tell [`LEFT_THE_DATABASE`] from [`NOT_SHORT_OF_THAT`], written once so the read's filter
/// and the write's refusal cannot come to disagree about what "gone" means.
const KNOWN_SQL: &str = "SELECT 1 FROM cards WHERE id = ?1";

/// One printing and finish the live list is short of, and every wish those copies could clear.
///
/// The hand-written mirror of `DeckMissingRow` in `src/lib/ipc.ts`, field for field. Its doc
/// carries the same reasoning from the reader's end.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingRow {
    /// The printing the deck lists — half of the key a [`MissingPick`] is addressed by.
    pub card_id: String,
    /// The **deck row's** stored name, not the `cards` row's: that is the name the list beside
    /// this dialog is already showing.
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    /// The deck row's finish, where `None` is nonfoil — [`crate::deck::normalise_finish`]'s
    /// translation carried through unchanged, so a caller holding both this and a
    /// [`crate::deck::DeckCardRow`] never has to tell two spellings of "regular" apart. The other
    /// half of the pick's key.
    pub finish: Option<String>,
    /// Copies of this printing and finish the live list still wants, summed over its **active**
    /// piles — `quantity - owned_quantity`, the subtraction the editor's missing badge draws.
    pub short: i64,
    /// The piles that are short, in the deck's own read order, each named once. **For the reader
    /// and never for the write**: this press writes no `deck_cards` row, so there is no pile for
    /// the copies to land in and nothing here is an argument to anything.
    pub categories: Vec<String>,
    /// The printing's picture, front face — taken off the deck row rather than queried again, so
    /// [`crate::image_uri::front_face_map`]'s precedence keeps its one home. Never `None` in
    /// practice, because [`plan`] has already dropped the orphans that are the only rows
    /// [`crate::deck::live_shortfall`] answers `None` for.
    pub image_uris: Option<BTreeMap<String, String>>,
    /// Every wishlist line these copies could take down, best first —
    /// [`crate::deck_quick_add::wishes`]' answer for this printing and finish, **verbatim**. It is
    /// the same function the per-card menu calls, so the two entrances cannot come to disagree
    /// about what fills a wish, and its predicate and its ordering are argued at that module's
    /// `WISH_SQL` rather than re-decided here.
    ///
    /// **Empty is the ordinary answer** — most rows have no wish — and a row with two or more is
    /// drawn but never acted on, which is [`take_lone_wish`]'s rule and the reason no wish id
    /// travels on a [`MissingPick`].
    pub wishes: Vec<crate::deck_quick_add::QuickAddWish>,
}

/// Copies to record for one printing and finish — the write's whole input.
///
/// **Addressed by the pair and not by an entry id**, which is the structural difference from
/// [`crate::deck_pull::Pick`] and is argued in this module's header: the row does not exist yet.
/// It carries no deck id (the command has one) and no category (this write files no `deck_cards`
/// row, so there is no pile to name).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingPick {
    pub card_id: String,
    /// The deck row's spelling, echoed back off [`MissingRow::finish`], where `None` is nonfoil.
    pub finish: Option<String>,
    /// At least one, and never more than the deck is short of. Both are checked against the plan
    /// re-read inside the transaction; neither is trusted.
    pub quantity: i64,
}

/// What one press recorded.
///
/// Three numbers rather than a list of rows, because the caller re-reads the deck afterwards
/// anyway and what a sentence quotes is *"7 copies of 3 cards"*.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingOutcome {
    /// Copies recorded — the sum of the merged picks, which is exactly what landed because a
    /// batch that could not record all of them recorded none.
    pub copies: i64,
    /// Rows of the plan that got at least one copy, so printings **and finishes**, at
    /// [`MissingRow`]'s own grain. Spelled out for [`crate::deck_pull::PullOutcome::cards`]'
    /// reason: three implementations count it — this one, the Storybook fake and
    /// `addMissingPlan.ts`'s footer preview — and a grain mismatch would surface only on a deck
    /// short of one printing in two finishes.
    pub cards: i64,
    /// Copies taken off wishes, **not a count of wish rows** —
    /// [`crate::deck_quick_add::QuickAddOutcome::wish_copies`]' unit, so a wishlist row holding
    /// four that gives up one has cleared one copy of wanting and left three standing.
    pub wish_copies: i64,
}

/// What this deck is short of that it could record, and what recording it would clear.
///
/// The shortfall walk is [`crate::deck::live_shortfall`] and is not spelled here: the
/// `(card_id, finish)` grain, the inactive-pile skip, the deck's own read order and the
/// "one pile named once" rule are all written down on it, and this is its third caller.
///
/// **One filter, and it is the write's own precondition rather than a second opinion.** An
/// orphan — a `card_id` with no `cards` row — is left out, because
/// [`crate::collection::add_entry_filed`] reads the printing off that row and refuses without it.
/// A row this drops is exactly a row the write would have refused, and a row the dialog could only
/// draw as an apology: [`crate::deck_pull::plan`]'s rule about an empty candidate list, applied to
/// a different reason for the same shape of emptiness.
///
/// **Narrower than [`crate::deck::missing_to_wishlist`]'s `oracle_id.is_none()` and deliberately
/// so.** A `cards` row can exist with a NULL `oracle_id` — Scryfall omits it on some layouts — and
/// no wish can be written for one, while a collection entry records it perfectly well. The two
/// commands' filters genuinely differ and neither is the other's typo.
///
/// **Two things it does *not* do**, each of which looks like an omission and is not: it does not
/// drop a row because [`crate::deck_pull::plan`] could offer it instead (the header's argument),
/// and it does not drop a row that matches no wish — a wish is a bonus the press clears, never a
/// condition of it.
///
/// **An empty vector is the ordinary answer.** A deck short of nothing and a deck whose whole
/// shortfall is orphaned printings are both zero rows, and neither is a failure; the dialog says
/// which in words.
///
/// # A virtual deck is refused in words, and that is deliberate for a *read*
///
/// [`crate::deck::VIRTUAL_HOLDS_NOTHING`] (issue #401). A virtual deck tracks a deck the reader
/// owns no cardboard for, so it is short of everything and of nothing at once, and the two
/// honest-looking answers are a refusal and an empty vector. **The empty vector is the dishonest
/// one**, and it is dishonest here in a way the paragraph above is not: this function's zero rows
/// already *mean* "nothing to record", and the dialog draws that as a cheerful *All owned.* over a
/// deck that owns nothing by definition. A reader would be told they had finished collecting a
/// deck that was never about collecting. So this refuses by name, and the caller shows the
/// sentence — the same trade [`crate::collection_alloc::THEORY_HOLDS_NOTHING`] makes at a write,
/// applied to a read whose emptiness has a meaning of its own to protect.
pub fn plan(conn: &Connection, deck_id: i64) -> Result<Vec<MissingRow>, String> {
    // **First, ahead of the shortfall walk, and [`crate::deck::is_virtual`]'s own contract is
    // what makes that safe**: a deck that is not there answers `false` rather than raising, so a
    // stale editor's dead id falls straight through to [`crate::deck::live_shortfall`] and hears
    // [`crate::deck::GONE`] from it — "that deck is gone" and "that deck keeps no cardboard"
    // stay different things to be told, which is the ordering every write in this crate keeps
    // behind [`crate::deck::touch_deck`]. Nothing below this line has to run to know the answer.
    if crate::deck::is_virtual(conn, deck_id)? {
        return Err(crate::deck::VIRTUAL_HOLDS_NOTHING.to_owned());
    }
    let shortfall = crate::deck::live_shortfall(conn, deck_id)?;
    // One prepared statement for the whole plan rather than one per row — `deck_pull::plan`'s rule
    // about `CANDIDATE_SQL`, for the same reason: a 100-card list short of thirty printings is
    // thirty primary-key lookups, not thirty prepares.
    let mut known = conn.prepare(KNOWN_SQL).map_err(|e| e.to_string())?;

    let mut rows = Vec::new();
    for row in shortfall {
        if !known
            .exists(rusqlite::params![&row.card_id])
            .map_err(|e| e.to_string())?
        {
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

/// Record the picked copies into this deck's group, and take the unambiguous wishes down with
/// them. Answers what was recorded.
///
/// # Eight steps, and the order of them is the rule
///
/// [`crate::deck_quick_add::quick_add`]'s discipline one grain wider, and every step is placed for
/// a reason a test pins:
///
/// 1. **An empty batch is refused before the transaction opens** — [`NOTHING_PICKED`]. A refusal
///    that has already begun a write is a rollback the reader pays for.
/// 2. **Duplicate picks for one key are summed, and only then checked.** Two picks of 3 against a
///    shortfall of 4 are one refusal and not two accepted writes. Insertion order is kept, so the
///    outcome and the history describe the plan's order rather than a hash order.
/// 3. **[`crate::deck::touch_deck`] first inside the transaction**, which doubles as the deck
///    fence: a stale editor hears [`crate::deck::GONE`] rather than something about cards. A press
///    that changes what the deck holds is a change to the deck, so the stamp is owed on its own
///    account even though no `deck_cards` row moves. **The virtual fence rides immediately
///    behind it** — [`crate::deck::VIRTUAL_HOLDS_NOTHING`], issue #401 — and is a rider rather
///    than a step of its own, because it is not part of this press at all: it is the question of
///    whether the press applies to this deck, and the seven numbers below it are the press. It
///    sits *after* the stamp for the stamp's own reason, "that deck is gone" and "that deck holds
///    no cardboard" being different things to be told. The re-plan at step 5 would refuse a
///    virtual deck too, with the very same sentence, because [`plan`] carries the same fence —
///    this one is here so that the write's contract is its own rather than a side effect of a
///    read three statements further in.
/// 4. **[`crate::deck::deck_group`]**, else [`crate::collection_alloc::NO_DECK_GROUP`]. One group
///    per deck since schema v25, so `None` is a hand-edited database — and filing at the root
///    instead would record copies no deck claims.
/// 5. **The plan is re-read inside the transaction.** The dialog's answer is a round trip old:
///    [`crate::deck_pull::from_collection`]'s discipline, and the fence that subsumes
///    [`crate::deck::plays_card`] — a card the deck does not play has no shortfall row.
/// 6. **Every pick checked against that re-plan, all of them, before anything is written**, so a
///    refusal on the last one has not already inserted the first. Four sentences, each naming its
///    own mistake: [`crate::collection::ZERO_ADD`], [`MORE_THAN_MISSING`], [`NOT_SHORT_OF_THAT`]
///    and [`LEFT_THE_DATABASE`] — the last two told apart because they are two different things
///    for a stale dialog to hear.
/// 7. **[`crate::deck_quick_add::record_copies`] per row, then its wish**, inside the one
///    transaction. **`None` for the condition**: `collection::valid_condition` turns an absent
///    grade into [`crate::collection::DEFAULT_CONDITION`] already, so the batch *says nothing*
///    about one — which is the truth, because nobody was asked.
/// 8. **One [`crate::deck_audit`] row for the press**, then commit.
///
/// # All-or-nothing
///
/// One bad pick refuses the whole batch and records nothing. A half-applied batch leaves copies
/// recorded that the reader cannot tell from the ones that were not, and this write files no
/// [`crate::deck_undo`] step, so there is no press that takes it back. The alternative — skipping
/// the bad pick and reporting a smaller number — is a write whose result the reader has to
/// reconstruct by reading two pages.
///
/// # The history row is a `move`, and `AUDIT_KINDS` stays at nine
///
/// `deck_audit.kind`'s CHECK cannot be altered — SQLite has no `ALTER … CHECK` — so a tenth word
/// would rebuild every reader's whole deck history for a spelling. This is the fifth reuse of an
/// existing kind with a payload key nothing else writes, and the payload is
/// [`crate::deck_quick_add::quick_add`]'s **byte for byte** with the batch's totals in it:
/// `{"quickAdd": {"copies": N, "wishes": M}}`. `auditText.ts`'s `quickAddLine` already renders
/// that as *"Recorded N copies for this deck"*, which reads correctly for a batch, so no word and
/// no branch is added on the TypeScript side either.
///
/// **One row, not N.** The history drawer is the reader's record of what they did, and they did
/// one thing. `delta` is 0 and honest: the *list* gained nothing — the deck asked for four copies
/// before the press and asks for four after it.
pub fn to_collection(
    conn: &Connection,
    deck_id: i64,
    picks: &[MissingPick],
    clear_wishes: bool,
) -> Result<MissingOutcome, String> {
    if picks.is_empty() {
        return Err(NOTHING_PICKED.to_owned());
    }
    // Summed before anything is checked, and in first-appearance order: `wanted` is the answer and
    // `at` only says where a key already landed. A `HashMap` alone would have made the outcome and
    // the audit describe a hash order rather than the plan's — `live_shortfall`'s own argument for
    // the shape it returns.
    let mut wanted: Vec<((String, String), i64)> = Vec::new();
    let mut at: HashMap<(String, String), usize> = HashMap::new();
    for pick in picks {
        if pick.quantity <= 0 {
            return Err(crate::collection::ZERO_ADD.to_owned());
        }
        // The deck's spelling into the collection's, once per pick, and read by both halves below
        // — the `collection_entries.finish` this writes and the
        // `wishlist_entries.preferred_finish` the wish is matched against are one vocabulary, and
        // a second translation is a second thing to drift.
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
    crate::deck::touch_deck(&tx, deck_id)?;
    // Step 3's rider: a virtual deck keeps no cardboard, so there is nothing for this press to
    // record and no group to record it into. Behind the stamp so a dead deck id still hears
    // `deck::GONE`; ahead of the group and the re-plan so the refusal names the deck rather than
    // the folder it does not have.
    if crate::deck::is_virtual(&tx, deck_id)? {
        return Err(crate::deck::VIRTUAL_HOLDS_NOTHING.to_owned());
    }
    let group = crate::deck::deck_group(&tx, deck_id)?
        .ok_or_else(|| crate::collection_alloc::NO_DECK_GROUP.to_owned())?;

    // Keyed in the **collection's** spelling, so the lookup below compares like with like: the
    // plan carries the deck row's finish and the picks were normalised a dozen lines up.
    let mut short_at: HashMap<(String, String), i64> = HashMap::new();
    for row in plan(&tx, deck_id)? {
        let finish = crate::deck::normalise_finish(row.finish.as_deref())?
            .unwrap_or_else(|| NONFOIL.to_owned());
        short_at.insert((row.card_id, finish), row.short);
    }

    for (key, quantity) in &wanted {
        match short_at.get(key) {
            Some(short) if quantity <= short => {}
            Some(_) => return Err(MORE_THAN_MISSING.to_owned()),
            // The plan drops an orphan, so a key it has no row for is one of two different
            // things to tell a stale dialog, and one sentence covering both tells it nothing it
            // can act on.
            None => {
                let known = tx
                    .prepare(KNOWN_SQL)
                    .map_err(|e| e.to_string())?
                    .exists(rusqlite::params![&key.0])
                    .map_err(|e| e.to_string())?;
                return Err(if known {
                    NOT_SHORT_OF_THAT.to_owned()
                } else {
                    LEFT_THE_DATABASE.to_owned()
                });
            }
        }
    }

    let mut copies = 0i64;
    let mut wish_copies = 0i64;
    for ((card_id, finish), quantity) in &wanted {
        crate::deck_quick_add::record_copies(&tx, group, card_id, finish, None, *quantity)?;
        copies += quantity;
        if clear_wishes {
            wish_copies += take_lone_wish(&tx, card_id, finish, *quantity)?;
        }
    }

    // Inside the transaction, [`crate::deck_audit`]'s first rule: a history row for a write that
    // rolled back is worse than no row at all. `None` for the card, because a batch names no one
    // card and a row naming the first of five would be a history that misleads. The id `record`
    // answers is discarded, which is the call shape of every site that files no reversal.
    crate::deck_audit::record(
        &tx,
        deck_id,
        LIVE,
        crate::deck_audit::MOVE,
        None,
        &json!({ "quickAdd": { "copies": copies, "wishes": wish_copies } }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MissingOutcome {
        copies,
        cards: wanted.len() as i64,
        wish_copies,
    })
}

/// Take copies off this printing's wish, but **only when exactly one line matches**. Answers what
/// it took.
///
/// [`crate::deck_quick_add::quick_add`] is *pointed at* a wish and so can be stale about one —
/// hence its `WISH_GONE` and `WISH_WRONG_CARD`. This press chooses inside the transaction instead,
/// because a deck-wide batch over thirty rows cannot ask thirty questions and the design settled
/// on no nested picker. So there is **no stale-wish refusal here at all**: a line that vanished
/// under the dialog is simply not among the matches, and the press carries on.
///
/// **None, or two or more, is left alone** — and the dialog said so beside the row before the
/// press, so the reader is not surprised by what did not happen. Two matching lines are a question
/// this write is not allowed to answer by guessing.
///
/// The finish crosses this call in the **collection's** spelling, which is the one
/// [`crate::deck_quick_add::wishes`] normalises *from* rather than the one it wants: that function
/// takes the deck's word and runs [`crate::deck::normalise_finish`] itself. The round trip is
/// stable because that function maps `Some("nonfoil")` to `None`, which `wishes` then defaults
/// back to [`NONFOIL`] — so handing it the stored word answers the same rows as handing it the
/// deck's `None` would have.
///
/// `take = min(recorded, the wish's quantity)`, and taking the lot **deletes** the row, because
/// `wishlist_entries.quantity` is `CHECK (quantity > 0)` and a wish for none of something is not a
/// wish — [`crate::deck_quick_add`]'s `take_wish` rule, one caller over.
fn take_lone_wish(
    tx: &Connection,
    card_id: &str,
    finish: &str,
    quantity: i64,
) -> Result<i64, String> {
    let matches = crate::deck_quick_add::wishes(tx, card_id, Some(finish))?;
    if matches.len() != 1 {
        return Ok(0);
    }
    let wish = &matches[0];
    let take = quantity.min(wish.quantity);
    if take >= wish.quantity {
        tx.execute(
            "DELETE FROM wishlist_entries WHERE id = ?1",
            rusqlite::params![wish.id],
        )
    } else {
        tx.execute(
            "UPDATE wishlist_entries SET quantity = quantity - ?2, updated_at = unixepoch()
              WHERE id = ?1",
            rusqlite::params![wish.id, take],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(take)
}

/// The two commands, in a module of their own so the wire names and the crate's names can each
/// read well — [`crate::deck_pull::commands`]' shape.
///
/// `generate_handler!` takes the **last segment** of the path as the command name, so these
/// register as `deck_missing_plan` and `deck_missing_to_collection` — the names `src/lib/ipc.ts`
/// invokes — while the crate says [`super::plan`] and [`super::to_collection`], which are module
/// plus verb and do not stutter. The pair reads as a set with `deck_missing_to_wishlist`, which
/// lives in [`crate::deck`] and is a different module's command about the same shortfall.
pub mod commands {
    #[cfg(not(target_family = "wasm"))]
    use super::{
        plan as read_plan, to_collection as record, MissingOutcome, MissingPick, MissingRow,
    };
    #[cfg(not(target_family = "wasm"))]
    use crate::sync::AppState;
    #[cfg(not(target_family = "wasm"))]
    use std::sync::Arc;

    /// [`super::plan`]'s command. **Read-only** connection, and no marketplace: nothing in the
    /// answer is priced, which is why the plan takes none either.
    ///
    /// Cheap enough to re-ask after any write, and the editor does: this is the read that says
    /// whether the last press emptied the list.
    #[cfg(not(target_family = "wasm"))]
    #[tauri::command]
    pub async fn deck_missing_plan(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
    ) -> Result<Vec<MissingRow>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_plan(&crate::sync::lock_db_read(&state), deck_id)
        })
        .await
        .map_err(|e| format!("the plan could not be read: {e}"))?
    }

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**, and it owes
    /// that more plainly than any of the four writes before it: the facet index's `owned`
    /// dimension is built by counting `collection_entries` rows, the three movers can at most fold
    /// one away, [`crate::deck_quick_add`] makes one — and this makes several in a single press.
    #[cfg(not(target_family = "wasm"))]
    #[tauri::command]
    pub async fn deck_missing_to_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
        picks: Vec<MissingPick>,
        clear_wishes: bool,
    ) -> Result<MissingOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| {
                record(c, deck_id, &picks, clear_wishes)
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
    use rusqlite::{params, OptionalExtension};
    use serde_json::Value;

    /// **`foreign_keys` is ON**, as [`crate::db::open`] sets it for every connection the app hands
    /// out — [`crate::deck_pull`]'s suite and [`crate::deck_quick_add`]'s open the same way and
    /// for the same reason: `collection_entries.folder_id` SET NULLs and
    /// `collection_folders.deck_id` CASCADEs, and both are per-connection settings.
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
    ) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, finish, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'live', ?3, 'lea', '161', 'en', 'Lightning Bolt', ?4, ?5,
                     unixepoch(), unixepoch())
             RETURNING id",
            params![deck, category, card_id, finish, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One wish, at whatever grain the case needs. `card_id` is `Option` because the any-printing
    /// wish — the row `wishes` must **not** offer — is the one with NULL there.
    fn seed_wish(
        conn: &Connection,
        card_id: Option<&str>,
        quantity: i64,
        folder: Option<i64>,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO wishlist_entries
                 (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
                  preferred_finish, folder_id, created_at, updated_at)
             VALUES ('o-bolt', ?1, 'lea', '161', 'en', 'Lightning Bolt', ?2, NULL, ?3,
                     unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A folder the reader made and named, on the **wishlist** side — the second one a case needs
    /// so that two wishes for one printing can exist at all.
    fn wish_folder(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, 0, unixepoch(), unixepoch())
             RETURNING id",
            params![name],
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

    /// Every `collection_entries` row there is, however filed — what tells a fold from a second
    /// row.
    fn entry_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
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

    /// The shorthand every write case wants: one pick of a regular copy.
    fn pick(card_id: &str, quantity: i64) -> MissingPick {
        MissingPick {
            card_id: card_id.to_owned(),
            finish: None,
            quantity,
        }
    }

    // ---- the plan -----------------------------------------------------------------

    #[test]
    fn an_inactive_pile_is_short_of_nothing() {
        // A switched-off pile counts toward nothing anywhere in the app, so its rows must not
        // report their whole quantity as a shortfall for ever.
        let (conn, deck, cat) = fixture();
        let maybe = crate::schema::tests::category(&conn, deck, "maybe", "Maybeboard");
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        seed_card(&conn, "shock", "lea", "162");
        add_deck_card(&conn, deck, maybe, "shock", 4, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1, "only the active pile is short of anything");
        assert_eq!(rows[0].card_id, "bolt");
        assert_eq!(rows[0].short, 2);
    }

    #[test]
    fn one_printing_short_in_two_piles_is_one_row_naming_both() {
        // What a reader is short of is cardboard; the piles are named on the row for them to read
        // and are never a term in the arithmetic.
        let (conn, deck, cat) = fixture();
        let side = crate::schema::tests::category(&conn, deck, "side", "Sideboard");
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        add_deck_card(&conn, deck, side, "bolt", 2, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short, 6, "four in one pile and two in the other");
        assert_eq!(rows[0].categories.len(), 2);
        assert!(rows[0].categories.iter().any(|c| c == "Main deck"));
        assert!(rows[0].categories.iter().any(|c| c == "Sideboard"));
    }

    #[test]
    fn an_orphaned_printing_is_left_out_of_the_plan() {
        // The write reads the printing off `cards`, so this row is exactly one the write would
        // have refused — and a row the dialog could only draw as an apology.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        add_deck_card(&conn, deck, cat, "ghost", 3, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].card_id, "bolt");
    }

    #[test]
    fn a_printing_with_no_oracle_id_is_kept() {
        // The case that separates this filter from `missing_to_wishlist`'s: no wish can be written
        // for such a card, and a collection entry records it perfectly well.
        let (conn, deck, cat) = fixture();
        conn.execute("UPDATE cards SET oracle_id = NULL WHERE id = 'bolt'", [])
            .unwrap();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "an oracle id is not what this filter asks for"
        );
        assert_eq!(rows[0].card_id, "bolt");

        // And it can be recorded, which is the half that makes the difference matter.
        let out = to_collection(&conn, deck, &[pick("bolt", 2)], true).unwrap();
        assert_eq!(out.copies, 2);
        assert_eq!(group_copies(&conn, deck, "bolt"), 2);
    }

    #[test]
    fn a_row_with_no_matching_wish_is_offered_with_none() {
        // Most rows will have none; a wish is a bonus the press clears, never a condition of it.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        // An any-printing wish, which `wishes` deliberately does not offer.
        seed_wish(&conn, None, 4, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].wishes.is_empty());
    }

    /// Turn a deck into one the reader tracks without owning — `decks.virtual_only`, schema v40.
    ///
    /// An `UPDATE` rather than a parameter on [`fixture`], so a case that wants one says so on
    /// its own line and every other case in this file is untouched.
    fn make_virtual(conn: &Connection, deck: i64) {
        conn.execute(
            "UPDATE decks SET virtual_only = 1 WHERE id = ?1",
            params![deck],
        )
        .unwrap();
    }

    #[test]
    fn a_virtual_deck_has_no_plan_to_read() {
        // **The empty list is the wrong answer here, not merely a worse one.** Zero rows already
        // mean "nothing to record" and the dialog draws that as *All owned.* — over a deck that
        // owns nothing by definition. So the deck is short of two copies first, which is what
        // makes the refusal a decision rather than an accident of an empty fixture.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        assert_eq!(
            plan(&conn, deck).unwrap().len(),
            1,
            "or this proves nothing"
        );
        make_virtual(&conn, deck);

        assert_eq!(
            plan(&conn, deck).unwrap_err(),
            crate::deck::VIRTUAL_HOLDS_NOTHING
        );
    }

    // ---- the write ----------------------------------------------------------------

    #[test]
    fn a_partial_pick_records_what_it_named_and_leaves_the_rest_short() {
        // The reader bought two of the four the deck wants, and says so.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);

        let out = to_collection(&conn, deck, &[pick("bolt", 2)], true).unwrap();
        assert_eq!(out.copies, 2);
        assert_eq!(out.cards, 1);
        assert_eq!(out.wish_copies, 0);
        assert_eq!(group_copies(&conn, deck, "bolt"), 2);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short, 2, "still two short of the four it lists");

        // One row for the press, not one per printing, and `delta` is 0: the *list* gained
        // nothing.
        let log = history(&conn, deck);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].0, "move");
        assert_eq!(log[0].1, None, "a batch names no one card");
        assert_eq!(log[0].2["quickAdd"]["copies"], 2);
        assert_eq!(log[0].2["quickAdd"]["wishes"], 0);
        assert_eq!(log[0].3, 0);
    }

    #[test]
    fn a_pick_of_exactly_the_shortfall_is_accepted_and_closes_it() {
        // **The boundary, and it is the assertion the comparison turns on**: `quantity <= short`
        // and not `<`. A reader who bought all four of what they were short of must be able to
        // say so in one press, and the plan is empty afterwards rather than one short.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);

        let out = to_collection(&conn, deck, &[pick("bolt", 4)], true).unwrap();
        assert_eq!(out.copies, 4);
        assert_eq!(group_copies(&conn, deck, "bolt"), 4);
        assert!(
            plan(&conn, deck).unwrap().is_empty(),
            "the deck is short of nothing now"
        );
    }

    #[test]
    fn two_picks_of_one_key_are_summed_and_refused_together() {
        // Two picks of 3 against a shortfall of 4 are one refusal and not two accepted writes.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);

        let err =
            to_collection(&conn, deck, &[pick("bolt", 3), pick("bolt", 3)], true).unwrap_err();
        assert_eq!(err, MORE_THAN_MISSING);
        assert_eq!(
            entry_count(&conn),
            0,
            "the sum is checked before anything is written"
        );
    }

    #[test]
    fn a_pick_above_the_shortfall_is_refused() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);

        let err = to_collection(&conn, deck, &[pick("bolt", 3)], true).unwrap_err();
        assert_eq!(err, MORE_THAN_MISSING);
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn a_printing_the_deck_is_not_short_of_is_refused() {
        // The card exists and the deck does not want it — a dialog left open while another window
        // filled the hole.
        let (conn, deck, cat) = fixture();
        seed_card(&conn, "shock", "lea", "162");
        add_deck_card(&conn, deck, cat, "bolt", 2, None);

        let err = to_collection(&conn, deck, &[pick("shock", 1)], true).unwrap_err();
        assert_eq!(err, NOT_SHORT_OF_THAT);
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn a_printing_that_left_the_database_is_refused() {
        // A corpus resync under an open dialog. Told apart from the sentence above because they
        // are two different things for a stale dialog to hear.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        assert_eq!(plan(&conn, deck).unwrap().len(), 1, "it was offered first");

        conn.execute("DELETE FROM cards WHERE id = 'bolt'", [])
            .unwrap();

        let err = to_collection(&conn, deck, &[pick("bolt", 2)], true).unwrap_err();
        assert_eq!(err, LEFT_THE_DATABASE);
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn an_empty_batch_is_refused_before_the_transaction_opens() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);

        let err = to_collection(&conn, deck, &[], true).unwrap_err();
        assert_eq!(err, NOTHING_PICKED);
        assert!(
            history(&conn, deck).is_empty(),
            "nothing was stamped either"
        );
    }

    #[test]
    fn a_virtual_deck_records_nothing_into_the_collection() {
        // **The deck has no group, because a real virtual deck has none** — `create_deck` skips
        // it — and that is what makes this case able to tell the two refusals apart. Take the
        // fence out and the press does not succeed and does not answer this sentence either: it
        // reaches [`crate::deck::deck_group`] and says
        // [`crate::collection_alloc::NO_DECK_GROUP`], which names a folder the reader is supposed
        // to go and repair rather than a deck that was never going to hold cardboard. Measured:
        // with the fence commented out this case goes red on that sentence, and with a
        // *grouped* fixture it stayed green — because [`plan`]'s own fence, one statement
        // further in, answers the identical string.
        let conn = open();
        seed_card(&conn, "bolt", "lea", "161");
        let deck = seed_deck(&conn, "Arena Burn");
        let cat = crate::schema::tests::category(&conn, deck, "main", "Main deck");
        make_virtual(&conn, deck);
        add_deck_card(&conn, deck, cat, "bolt", 4, None);

        let err = to_collection(&conn, deck, &[pick("bolt", 2)], true).unwrap_err();

        assert_eq!(err, crate::deck::VIRTUAL_HOLDS_NOTHING);
        assert_eq!(entry_count(&conn), 0, "no copies were recorded");
        assert!(history(&conn, deck).is_empty(), "and nothing was stamped");
    }

    #[test]
    fn recording_onto_a_grain_the_group_already_holds_raises_that_row() {
        // The grain fold is `add_entry_filed`'s: the folder is `COLLECTION_GRAIN`'s eleventh term,
        // so a second press on the same line raises the row the first one made.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);

        to_collection(&conn, deck, &[pick("bolt", 1)], true).unwrap();
        assert_eq!(entry_count(&conn), 1);
        to_collection(&conn, deck, &[pick("bolt", 2)], true).unwrap();

        assert_eq!(entry_count(&conn), 1, "one row, raised — not a second");
        assert_eq!(group_copies(&conn, deck, "bolt"), 3);
    }

    #[test]
    fn a_lone_wish_is_decremented_and_a_second_match_leaves_both_standing() {
        // "Exactly one, or leave it alone" — the rule that is why the wire carries no wish id.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let lone = seed_wish(&conn, Some("bolt"), 3, None);

        let out = to_collection(&conn, deck, &[pick("bolt", 1)], true).unwrap();
        assert_eq!(out.wish_copies, 1);
        assert_eq!(wish_quantity(&conn, lone), Some(2));

        // A second line for the same printing makes the answer ambiguous, and an ambiguous answer
        // is one this write is not allowed to guess at.
        let folder = wish_folder(&conn, "Buy list");
        let second = seed_wish(&conn, Some("bolt"), 5, Some(folder));

        let out = to_collection(&conn, deck, &[pick("bolt", 1)], true).unwrap();
        assert_eq!(out.copies, 1, "the copies are still recorded");
        assert_eq!(out.wish_copies, 0);
        assert_eq!(wish_quantity(&conn, lone), Some(2));
        assert_eq!(wish_quantity(&conn, second), Some(5));
    }

    #[test]
    fn a_wish_taken_to_nothing_is_deleted() {
        // `wishlist_entries.quantity` is `CHECK (quantity > 0)`, so a wish for none of something
        // has to go rather than sit at zero.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let lone = seed_wish(&conn, Some("bolt"), 2, None);

        let out = to_collection(&conn, deck, &[pick("bolt", 4)], true).unwrap();
        assert_eq!(out.wish_copies, 2, "min(recorded, the wish's quantity)");
        assert_eq!(wish_quantity(&conn, lone), None);
    }

    #[test]
    fn clear_wishes_false_leaves_a_lone_match_standing() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let lone = seed_wish(&conn, Some("bolt"), 3, None);

        let out = to_collection(&conn, deck, &[pick("bolt", 2)], false).unwrap();
        assert_eq!(out.copies, 2);
        assert_eq!(out.wish_copies, 0);
        assert_eq!(wish_quantity(&conn, lone), Some(3), "untouched");
        assert_eq!(history(&conn, deck)[0].2["quickAdd"]["wishes"], 0);
    }

    #[test]
    fn a_refusal_writes_nothing_at_all() {
        // All-or-nothing: the good pick is checked *and rolled back with* the bad one, so a batch
        // that could not record everything records nothing.
        let (conn, deck, cat) = fixture();
        seed_card(&conn, "shock", "lea", "162");
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        add_deck_card(&conn, deck, cat, "shock", 2, None);
        let wish = seed_wish(&conn, Some("bolt"), 3, None);

        let err =
            to_collection(&conn, deck, &[pick("bolt", 2), pick("shock", 9)], true).unwrap_err();
        assert_eq!(err, MORE_THAN_MISSING);

        assert_eq!(entry_count(&conn), 0, "not even the pick that was fine");
        assert_eq!(wish_quantity(&conn, wish), Some(3));
        assert!(history(&conn, deck).is_empty());
    }

    #[test]
    fn a_quantity_of_zero_is_refused() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);

        let err = to_collection(&conn, deck, &[pick("bolt", 0)], true).unwrap_err();
        assert_eq!(err, crate::collection::ZERO_ADD);
        assert_eq!(entry_count(&conn), 0);
    }
}
