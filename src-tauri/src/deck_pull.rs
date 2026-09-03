//! Filling a deck's holes from the reader's own binder — the read that finds them, and the
//! write that moves the cardboard and nothing else.
//!
//! A deck lists four Lightning Bolt and physically holds one, so the editor draws *3 missing*
//! ([issue #351](https://github.com/Msgaihede/mtg-grimoire/issues/351)). Three more are sitting
//! in a binder on the reader's desk, and until this module existed the only way to get them into
//! the sleeve was to find each one on the Collection page and file it by hand. This is the one
//! press: [`plan`] says which holes the reader can already fill and with what, and
//! [`from_collection`] moves the copies they picked.
//!
//! ```text
//!   binder / Recently removed ──── deck_pull_from_collection ───▶ this deck's group
//!                                (`deck_cards` is not written at all)
//! ```
//!
//! # This is the third crossing of the deck boundary and it is a different kind of write
//!
//! [`crate::collection_alloc`] holds the other two, and its header calls them the only pair that
//! can cross — which was true while both of them *added a card to a deck* or *took one out of
//! it*. This one does neither. It moves custody for a card the list **already names**, so the
//! `deck_cards` row it fills a hole in is not touched: not its quantity, not its category, not
//! its `updated_at`.
//!
//! **Reusing [`crate::collection_alloc::collection_to_deck`] was the obvious shape and is the
//! wrong write.** That command's insert ends
//! `ON CONFLICT(…) DO UPDATE SET quantity = deck_cards.quantity + excluded.quantity`, because it
//! is "add this card to the deck" and adding a card the deck already lists raises the line. Point
//! it at a 4-copy line the reader is 3 short of and the line becomes 7 — the deck would ask for
//! three more copies than it did before the press that was supposed to *satisfy* it. A shortfall
//! is a fact about where copies sit and about nothing else, so the only table this write may
//! change is `collection_entries.folder_id`.
//!
//! # The plan
//!
//! [`plan`] reads the **live** list through [`crate::deck::get_deck`], exactly as
//! [`crate::deck::missing_to_wishlist`] does — the two are one question asked in two directions,
//! and the shape is deliberately copied rather than re-derived. What you have *not* got goes on a
//! shopping list; what you *have* got is in a binder and can be moved. Four rules:
//!
//! * **An inactive category is short of nothing.** A switched-off pile counts toward nothing
//!   anywhere in the app, and [`crate::deck::attribute_owned`] already hands it no copies, so its
//!   rows would report a shortfall equal to their whole quantity for ever.
//! * **The fold is `(card_id, finish)`, one grain narrower than the wishlist's.** The same
//!   printing short in two piles is one row for the sum, because what a reader is short of is
//!   cardboard; the piles are named on the row for them to read and are never a term in the
//!   arithmetic. It is not folded all the way to the oracle card, which the wishlist *does* fold
//!   to, because a wish is filled by whichever copy turns up and a pull moves one specific
//!   object.
//! * **Candidates match the printing and the finish exactly, and that is a deliberate
//!   narrowing.** The deck's own owned count is attributed at the **oracle** grain — a LEA Bolt
//!   filed in the group makes an M10 line read as owned, `owned_by_oracle`'s "a Bolt is a Bolt" —
//!   so this fills strictly *fewer* holes than the app itself would count. The trade bought here
//!   is that nothing is ever pulled which is not the exact piece of cardboard the list names: a
//!   reader who deliberately sleeves the Alpha printing does not find the M10 one in their deck
//!   because a dialog decided they were the same card. The dialog says so; the shortfall it
//!   cannot fill stays on screen with no candidates and is dropped from the plan.
//! * **A row with no candidate is left out entirely**, so [`PullRow::candidates`] is never empty
//!   and an empty plan is the ordinary answer rather than an error — the issue says in as many
//!   words that not every card in a deck will have a collection option.
//!
//! # The write
//!
//! **All-or-nothing.** One pick the backend re-reads and disagrees with refuses the whole batch
//! and moves nothing. A half-applied pull is the state worth refusing over: the copies would be
//! somewhere other than either place the reader was looking at, and this write files no
//! [`crate::deck_undo`] step (below), so there is no press that takes it back. Every refusal is a
//! sentence naming the mistake — [`crate::deck::set_folder`]'s rule, and `PRAGMA foreign_keys` is
//! per-connection anyway, so a constraint failure is not a fence a command may lean on.
//!
//! **The move is [`crate::collection_folders::take_copies`]' and is not written a second time**,
//! which is [`crate::collection_alloc`]'s first rule and was already paid for once there.
//!
//! One transaction, for the reason every fold in this crate is one: mid-pull the copies are in
//! both places or in neither.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

/// What [`from_collection`] says when it was handed an empty list.
///
/// A press that moves nothing is a write that did nothing dressed as one —
/// [`crate::collection_alloc::ZERO_MOVE`]'s refusal one level up, about the *batch* rather than
/// about a quantity. Refused rather than answered with a zero [`PullOutcome`], because a caller
/// that reaches this has lost track of what the reader ticked and a cheerful "0 copies moved" is
/// how it goes on believing something was selected.
pub const NOTHING_PICKED: &str = "Pick at least one copy to pull into this deck.";

/// What [`from_collection`] says about a pick naming copies this deck has no hole for.
///
/// The reader picked a row that exists, is on their desk, and is a printing or a finish the live
/// list is not short of — a dialog left open while another window filled the hole, or a deck
/// whose list changed underneath it. Distinct from [`crate::collection::GONE`] (the row is not
/// there) and from [`crate::collection_folders::ENTRY_IN_A_DECK`] (it is there and is spoken
/// for), because those three are three different things to tell a stale dialog and one sentence
/// covering all of them tells it nothing it can act on.
pub const NOT_SHORT_OF_THAT: &str = "This deck is not short of that printing any more.";

/// What [`from_collection`] says when the picks for one printing add up past its shortfall.
///
/// Separate from [`crate::collection_alloc::NOT_THAT_MANY`], which is about the **row** — there
/// are not that many copies in the binder. This one is about the **deck**: the copies exist and
/// the deck does not want them. Filing them anyway would put cards in a group its own list does
/// not claim, which is precisely the stranded state
/// [`crate::deck::release_live_copies`] exists to prevent from the other end.
pub const MORE_THAN_MISSING: &str = "That is more copies than this deck is short of.";

/// `COLLECTION_FOLDER_KINDS[1]` — the one folder that stands for a deck, indexed rather than
/// spelled, [`crate::collection_alloc`]'s discipline.
const DECK_KIND: &str = crate::schema::COLLECTION_FOLDER_KINDS[1];
/// `COLLECTION_FOLDER_KINDS[2]` — the app's own holding area, second in the candidate ranking.
const REMOVED_KIND: &str = crate::schema::COLLECTION_FOLDER_KINDS[2];
/// What is actually sleeved up — `DECK_VARIANTS[0]`, and the only list a pull reads. A plan holds
/// no cards ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so it is short of none.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// `FINISHES[0]` — the word [`crate::deck::normalise_finish`] maps *away* on a deck row and the
/// one `collection_entries.finish` stores for a plain copy. Reading it back is the whole of the
/// translation between the two tables.
const NONFOIL: &str = crate::schema::FINISHES[0];

/// One printing the live list is short of, and every copy on the reader's desk that could fill
/// it.
///
/// The hand-written mirror of `DeckPullRow` in `src/lib/ipc.ts`, field for field. Its doc carries
/// the same reasoning from the reader's end.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRow {
    /// The printing the deck lists. Every candidate matches it exactly — see [`Self::finish`].
    pub card_id: String,
    /// The **deck row's** stored name, not the `cards` row's: that is the one name an orphan
    /// still has, and it is the name the list beside this dialog is already showing.
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    /// The deck row's finish, where `None` is nonfoil — [`crate::deck::normalise_finish`]'s
    /// translation carried through unchanged, so this reads exactly as
    /// [`crate::deck::DeckCardRow::finish`] does and a caller holding both never has to tell two
    /// spellings of "regular" apart.
    pub finish: Option<String>,
    /// Copies of this printing and finish the live list still wants, summed over its **active**
    /// piles — `quantity - owned_quantity`, which is the same subtraction the editor's missing
    /// badge draws.
    pub short: i64,
    /// The piles that are short, in the deck's own read order, each named once. **For the reader
    /// and never for the write**: a pull changes no `deck_cards` row, so there is no pile for the
    /// copies to land in and nothing here is an argument to anything.
    pub categories: Vec<String>,
    /// The printing's picture, front face — **taken off the deck row rather than queried again**.
    ///
    /// [`crate::deck::DeckCardRow::image_uris`] is already
    /// [`crate::image_uri::front_face_map`]'s answer over
    /// [`crate::image_uri::front_face_selects`]' columns, face-first precedence and `soon.jpg`
    /// fence included, and this plan is built from those very rows. A second select would be a
    /// second chance to respell a precedence that has one home.
    ///
    /// One per row rather than one per candidate, because every candidate for a row *is* the
    /// same printing. `None` for an orphan, whose card has left `cards`.
    pub image_uris: Option<BTreeMap<String, String>>,
    /// Every copy that could fill the hole, best first — see [`PullCandidate`]. **Never empty**:
    /// a row that reaches a caller with no candidates is a row the dialog could only draw as an
    /// apology, so [`plan`] drops it instead.
    pub candidates: Vec<PullCandidate>,
}

/// One collection row that could fill a hole.
///
/// **Nothing filed in a deck's group is ever a candidate.** That is the issue's *"only pull cards
/// that are not already in another deck folder"*, and it is
/// [`crate::collection::Allocation::Unallocated`]'s clause rather than a second spelling of it:
/// the root, a folder the reader made and `Recently removed` are all cards on a desk, and only a
/// `deck` folder is not. **This deck's own group is excluded by the same clause and has to be** —
/// those copies are already counted in [`crate::deck::DeckCardRow::owned_quantity`], so offering
/// them would be offering to fill a hole with the thing already in it.
///
/// The order is documented on [`plan`]; it is chosen rather than incidental.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullCandidate {
    /// The `collection_entries` row — what a [`Pick`] points at, and the only field the write
    /// reads.
    pub entry_id: i64,
    /// Copies this row holds, whole. A pick may take fewer, never more.
    pub quantity: i64,
    /// Where it sits, or `None` at the root.
    pub folder_id: Option<i64>,
    /// What to call that place, or `None` at the root — which the **UI** words, not this crate.
    /// "Binder", "Unfiled", "Loose" are all reasonable and all of them are a sentence.
    pub folder_name: Option<String>,
    /// `"user"` or `"removed"`; `None` at the root. Never `"deck"` — see this type's own doc.
    pub folder_kind: Option<String>,
    /// The copy's own facts, which are what tell two candidates of one printing apart: the grain
    /// terms a reader can see on the card in their hand. `condition` and `lang` are `NOT NULL`
    /// columns; the four flags are the `INTEGER NOT NULL DEFAULT 0` booleans.
    pub condition: String,
    pub lang: String,
    pub altered: bool,
    pub signed: bool,
    pub proxy: bool,
    pub misprint: bool,
    pub grading: Option<String>,
    pub serial_number: Option<String>,
}

/// Copies to take out of one collection row — the write's whole input.
///
/// **Two fields and no third.** It carries no deck id (the command has one), no category (a pull
/// writes no `deck_cards` row, so there is no pile to name) and no printing — the entry knows
/// what it is, and a caller-supplied printing beside a caller-supplied row id is two facts that
/// can disagree.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub entry_id: i64,
    /// At least one, and never more than the row holds or the deck is short of. All three are
    /// checked against the plan re-read inside the transaction; none of them is trusted.
    pub quantity: i64,
}

/// What a pull moved.
///
/// Two counts rather than a list of rows, because the caller re-reads the deck afterwards
/// anyway and what a sentence quotes is *"5 copies of 3 cards"*.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    /// Copies that changed folder — the sum of the picks, which is exactly what moved because a
    /// batch that could not move all of them moved none.
    pub copies: i64,
    /// Printings that got at least one. Distinct [`PullRow`]s touched, so two picks against one
    /// printing are one card here.
    pub cards: i64,
}

/// Every copy of one printing and finish that is on the reader's desk, best first.
///
/// **The eligibility clause is [`crate::collection::scope`]'s `Unallocated` sentence**, read off
/// the join this select needs anyway rather than as a second correlated lookup — that query
/// spells it as a subquery because its one `FROM` is shared by a page, a count and a summary, and
/// this one has a single reader. What is carried over verbatim is the shape, and the shape is the
/// part that bites: **the `IS NULL` arm has to come first**, because `<> 'deck'` over a NULL
/// `folder_id` is NULL rather than true and the root — where most of a collection lives — would
/// drop straight out of the list that is mostly root.
///
/// `e.quantity > 0` because a row holding no copies fills no hole. Since schema v24 a stepper
/// taken to zero deletes its row, so this is a fence around a database edited by hand rather
/// than a state the app can reach.
///
/// # The ranking is chosen, and what it ranks is how much of the reader's filing a pull disturbs
///
/// The **root** first: a card at the root is a card nobody has filed, so moving it undoes no
/// decision. Then **`Recently removed`**, which is the app's own transient holding area — cards
/// put there by a cut, on their way to somewhere. Then the reader's **own folders**, in the
/// `sort_order` they arranged them in, because a named binder is a decision somebody made on
/// purpose and is the last place a bulk press should reach into.
///
/// The tiebreak is `e.id`, oldest first — [`crate::collection_folders::take_copies`]' own rule and
/// [`crate::deck::release_group_copies`]'. It is a primary key, so the walk is **total** with no
/// further term: two user folders sharing a `sort_order` interleave their rows by age, which is
/// deterministic and is the same answer either of them would have given alone.
///
/// This is a pre-pick and not a decision. Every candidate is returned and the reader ticks the
/// ones they want; the order is what the dialog offers first.
const CANDIDATE_SQL: &str = "SELECT e.id, e.quantity, e.folder_id, f.name, f.kind,
            e.condition, e.lang, e.altered, e.signed, e.proxy, e.misprint,
            e.grading, e.serial_number
       FROM collection_entries e
       LEFT JOIN collection_folders f ON f.id = e.folder_id
      WHERE e.card_id = ?1
        AND e.finish = ?2
        AND e.quantity > 0
        AND (e.folder_id IS NULL OR f.kind <> ?3)
      ORDER BY CASE
                 WHEN e.folder_id IS NULL THEN 0
                 WHEN f.kind = ?4 THEN 1
                 ELSE 2
               END,
               coalesce(f.sort_order, 0),
               e.id";

/// What this deck is short of that the reader already owns.
///
/// The read half, and **the mirror of [`crate::deck::missing_to_wishlist`] one grain narrower** —
/// that function is the model for this one and was read before it was written. Both open on
/// `get_deck` for the **live** list only, both skip an inactive pile, both fold the shortfall
/// across piles. Where they part is what a hole is filled *with*: a wish is filled by whichever
/// copy turns up, so it folds to the oracle card and names no printing; a pull moves one specific
/// object, so it folds to `(card_id, finish)` and matches candidates on both.
///
/// **The default marketplace, and it costs nothing to be wrong about**, which is
/// `missing_to_wishlist`'s own line: this reads names, finishes and quantities and never a price.
/// Threading the stored setting in would make which copies are offered depend on where the reader
/// shops.
///
/// **The read order is the deck's own** — [`crate::deck::read_deck_cards`]' `ORDER BY`, category
/// then name then row id — and the folded rows keep it. That matters for the same reason it
/// matters to [`crate::deck::attribute_owned`]: this list is walked to hand out a scarce thing
/// (the shortfall a caller may pick against), so the answer must not depend on how a view chose
/// to sort itself. A caller wanting another order sorts what it is given.
///
/// **An empty vector is the ordinary answer.** A deck short of nothing and a deck whose whole
/// shortfall is cards the reader has never owned are both zero rows, and neither is a failure.
pub fn plan(conn: &Connection, deck_id: i64) -> Result<Vec<PullRow>, String> {
    let detail =
        crate::deck::get_deck(conn, deck_id, LIVE, crate::sorting::Marketplace::default())?
            .ok_or_else(|| crate::deck::GONE.to_owned())?;

    // The fold, in the read's order: `rows` is the answer and `at` only says where a key already
    // landed. A `BTreeMap` keyed on the pair would have sorted the answer by card id, which is
    // neither the deck's order nor any order a reader chose.
    let mut rows: Vec<PullRow> = Vec::new();
    let mut at: HashMap<(String, Option<String>), usize> = HashMap::new();
    for card in &detail.cards {
        // A switched-off pile counts toward nothing anywhere in the app — and
        // `attribute_owned` has already handed it no copies, so without this every row in it
        // would report its whole quantity as a shortfall.
        if !card.category_active {
            continue;
        }
        let short = card.quantity - card.owned_quantity;
        if short <= 0 {
            continue;
        }
        // `.copied()` so the lookup's borrow of `at` is over before the `None` arm inserts into
        // it — the shape every "find or make" in this crate takes.
        let key = (card.card_id.clone(), card.finish.clone());
        match at.get(&key).copied() {
            Some(i) => {
                rows[i].short += short;
                // Named once each. The same pile cannot appear twice for one printing and
                // finish — that pair plus the category is `DECK_CARD_GRAIN` — but a `contains`
                // costs nothing over a handful of piles and says what the field means.
                if !rows[i].categories.iter().any(|c| c == &card.category_name) {
                    rows[i].categories.push(card.category_name.clone());
                }
            }
            None => {
                at.insert(key, rows.len());
                rows.push(PullRow {
                    card_id: card.card_id.clone(),
                    name: card.name.clone(),
                    set_code: card.set_code.clone(),
                    collector_number: card.collector_number.clone(),
                    finish: card.finish.clone(),
                    short,
                    categories: vec![card.category_name.clone()],
                    image_uris: card.image_uris.clone(),
                    candidates: Vec::new(),
                });
            }
        }
    }

    // One prepared statement for the whole plan rather than one per row: a 100-card list short
    // of thirty printings is thirty index lookups on `idx_collection_card`, not thirty prepares.
    let mut stmt = conn.prepare(CANDIDATE_SQL).map_err(|e| e.to_string())?;
    for row in &mut rows {
        row.candidates = candidates(&mut stmt, &row.card_id, row.finish.as_deref())?;
    }
    // **Dropped rather than returned empty**, so `candidates` is never empty on the wire and a
    // plan of zero rows is the whole of "nothing here can be filled".
    rows.retain(|row| !row.candidates.is_empty());
    Ok(rows)
}

/// Run [`CANDIDATE_SQL`] for one printing and finish.
///
/// The finish arrives in the deck's spelling, where `None` is regular, and leaves in the
/// collection's, where the word is stored — [`NONFOIL`] is that one translation and it is not
/// respelled anywhere else in this module.
fn candidates(
    stmt: &mut rusqlite::Statement<'_>,
    card_id: &str,
    finish: Option<&str>,
) -> Result<Vec<PullCandidate>, String> {
    let finish = finish.unwrap_or(NONFOIL);
    let rows = stmt
        .query_map(params![card_id, finish, DECK_KIND, REMOVED_KIND], |r| {
            Ok(PullCandidate {
                entry_id: r.get(0)?,
                quantity: r.get(1)?,
                folder_id: r.get(2)?,
                folder_name: r.get(3)?,
                folder_kind: r.get(4)?,
                condition: r.get(5)?,
                lang: r.get(6)?,
                altered: r.get(7)?,
                signed: r.get(8)?,
                proxy: r.get(9)?,
                misprint: r.get(10)?,
                grading: r.get(11)?,
                serial_number: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Move the picked copies into this deck's group. Answers what actually moved.
///
/// # It writes no `deck_cards` row, and that is the whole of the feature
///
/// The list already names these cards; what it did not have was the cardboard. So the only
/// column this write changes is `collection_entries.folder_id` — through
/// [`crate::collection_folders::take_copies`], which splits a partial row and files the half that
/// travels through the merge. See this module's header for why
/// [`crate::collection_alloc::collection_to_deck`] cannot stand in: its `ON CONFLICT` arm adds
/// the moved quantity to the line, so filling a 3-copy hole in a 4-copy line would leave the deck
/// asking for 7.
///
/// # All-or-nothing, and the plan is re-read inside the transaction to decide
///
/// Every pick is validated against a plan built **here**, not against the one the dialog was
/// drawn from: between the read and the press another window may have cut a card, filed a copy
/// into a different deck, or folded the very row the reader ticked. Six ways a pick is refused,
/// each in words naming the mistake:
///
/// * an empty batch — [`NOTHING_PICKED`];
/// * a quantity of zero or less — [`crate::collection_alloc::ZERO_MOVE`];
/// * a row that is not there any more — [`crate::collection::GONE`];
/// * a row that has since been filed into a deck's group —
///   [`crate::collection_folders::ENTRY_IN_A_DECK`], the sentence that already tells a reader
///   what to do about exactly that;
/// * a row this deck has no hole for — [`NOT_SHORT_OF_THAT`];
/// * more copies than the row holds ([`crate::collection_alloc::NOT_THAT_MANY`]) or than the deck
///   is short of ([`MORE_THAN_MISSING`]).
///
/// **One bad pick refuses the whole batch and moves nothing.** A half-applied pull leaves copies
/// somewhere the reader was not looking at — not the binder they ticked them out of and not the
/// deck they meant them for — and this write files no undo step, so there is no press that takes
/// it back. The alternative, skipping the bad pick and reporting a smaller number, is a write
/// whose result the reader has to reconstruct by reading two pages.
///
/// **Picks naming one row twice are merged rather than refused**, in first-appearance order.
/// They have to be: `take_copies` splits the source, so the second take would be pointed at a row
/// that has moved or been folded away, and a caller would be told its own row was `GONE`. Merging
/// makes the batch mean what it plainly says and keeps every check above about the *total*.
///
/// # The history row is a `move`, and `AUDIT_KINDS` stays at nine
///
/// `deck_audit.kind`'s CHECK cannot be altered — SQLite has no `ALTER … CHECK` — so a tenth word
/// would mean rebuilding every reader's whole deck history for a spelling.
/// [`crate::import::commit_import`] met this first and [`crate::deck_undo`] met it again; both
/// reused an existing kind with a payload that tells it apart, and so does this. One `move` row
/// per press, with `{"pull": {"copies": …, "cards": …}}` — a key nothing else writes, so
/// `auditText.ts` can recognise it without guessing.
///
/// **`delta` is 0 and that is honest.** `delta` is what the history drawer's day header adds up,
/// and it adds up changes to *the list*. The list gained nothing: the deck asked for four copies
/// before the press and asks for four after it. Recording the copies moved would make a day of
/// pulls read as a day of adds.
///
/// One row for the batch rather than one per printing, which is the opposite of
/// [`crate::collection_alloc::take_from_deck_list`]'s choice and for the reason that function
/// gives: it writes N rows because there were N `deck_cards` rows a stepper would have written,
/// and here there are none. The press is the event.
///
/// # There is deliberately no undo step
///
/// [`crate::collection_alloc::collection_to_deck`]'s argument, unchanged and referenced rather
/// than re-derived: `take_copies` files the copies **through the merge**, so a source row may
/// have been folded into whatever the group already held and no longer exists to restore. Putting
/// them back is a quantity moved between two folders — a command run backwards, which is the one
/// design [`crate::deck_undo`] rejects. The way back is the deck editor's Collection Search tab,
/// a card at a time, and the `move` row above is what makes the absence visible rather than
/// silent: the drawer says the pull happened even though Ctrl+Z will not reverse it.
pub fn from_collection(
    conn: &Connection,
    deck_id: i64,
    picks: &[Pick],
) -> Result<PullOutcome, String> {
    if picks.is_empty() {
        return Err(NOTHING_PICKED.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Doubles as the deck fence: it answers `deck::GONE` for an id with no row, one statement
    // before there is an orphan to worry about. [`crate::deck::touch_deck`]'s own argument, and
    // `collection_to_deck` opens the same way. A pull *is* a change to this deck — what it holds
    // moved — even though its list is untouched, so the stamp is owed on its own account.
    crate::deck::touch_deck(&tx, deck_id)?;
    let group = crate::deck::deck_group(&tx, deck_id)?
        .ok_or_else(|| crate::collection_alloc::NO_DECK_GROUP.to_owned())?;

    let rows = plan(&tx, deck_id)?;
    // Every entry the plan is willing to be pointed at, and the two numbers a pick is measured
    // against: which folded row it fills, and how many copies it holds. A pick naming an id that
    // is not in here is refused by `why_not_offered`, which asks the database *which* of the
    // three mistakes it is.
    let mut offered: HashMap<i64, (usize, i64)> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        for candidate in &row.candidates {
            offered.insert(candidate.entry_id, (i, candidate.quantity));
        }
    }

    // The merged batch, in first-appearance order, plus the two running totals every check is
    // about. `wanted` is keyed on the folded row rather than on the printing because that is
    // what carries `short`.
    let mut merged: Vec<Pick> = Vec::new();
    let mut where_merged: HashMap<i64, usize> = HashMap::new();
    let mut wanted: HashMap<usize, i64> = HashMap::new();
    for pick in picks {
        if pick.quantity <= 0 {
            return Err(crate::collection_alloc::ZERO_MOVE.to_owned());
        }
        let Some(&(row, held)) = offered.get(&pick.entry_id) else {
            return Err(why_not_offered(&tx, pick.entry_id)?);
        };
        let taken = match where_merged.get(&pick.entry_id).copied() {
            Some(i) => {
                merged[i].quantity += pick.quantity;
                merged[i].quantity
            }
            None => {
                where_merged.insert(pick.entry_id, merged.len());
                merged.push(*pick);
                pick.quantity
            }
        };
        if taken > held {
            return Err(crate::collection_alloc::NOT_THAT_MANY.to_owned());
        }
        let asked = wanted.entry(row).or_insert(0);
        *asked += pick.quantity;
        if *asked > rows[row].short {
            return Err(MORE_THAN_MISSING.to_owned());
        }
    }

    let mut copies = 0;
    for pick in &merged {
        // The crate's one copy of the split-and-file rule, and never written a second time —
        // its own doc says so. The id it answers is the row the copies landed in, which this
        // command has nothing to point at: a pull's caller re-reads the deck.
        crate::collection_folders::take_copies(&tx, pick.entry_id, pick.quantity, Some(group))?;
        copies += pick.quantity;
    }
    // Distinct folded rows touched, which is printings-and-finishes and is what a sentence means
    // by "cards". `wanted` is already exactly that set.
    let cards = wanted.len() as i64;

    // Inside the transaction, [`crate::deck_audit`]'s first rule: a history row for a move that
    // rolled back is worse than no row at all. `None` for the card, because a batch names no one
    // card and a row that named the first of five would be a history that misleads. The id
    // `record` answers is discarded, which is the call shape of every site that files no
    // reversal.
    crate::deck_audit::record(
        &tx,
        deck_id,
        LIVE,
        crate::deck_audit::MOVE,
        None,
        &json!({ "pull": { "copies": copies, "cards": cards } }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(PullOutcome { copies, cards })
}

/// Why an entry the caller picked is not in the plan — one of three different sentences.
///
/// Asked only on the refusal path, so the happy path pays nothing for it. One statement answering
/// a nested `Option`: the outer says whether the row is there at all, the inner what kind of
/// folder it sits in (`None` at the root, which is a fine place for a copy to be).
///
/// The `deck` arm reuses [`crate::collection_folders::ENTRY_IN_A_DECK`] rather than writing a
/// fourth sentence, because it is the same fact and already says what to do about it — and it is
/// right for **this** deck's group too, where the copies are not missing at all but already
/// counted as owned.
fn why_not_offered(tx: &Connection, entry_id: i64) -> Result<String, String> {
    let kind: Option<Option<String>> = tx
        .query_row(
            "SELECT (SELECT f.kind FROM collection_folders f WHERE f.id = e.folder_id)
               FROM collection_entries e WHERE e.id = ?1",
            params![entry_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match kind {
        None => crate::collection::GONE.to_owned(),
        Some(Some(kind)) if kind == DECK_KIND => {
            crate::collection_folders::ENTRY_IN_A_DECK.to_owned()
        }
        Some(_) => NOT_SHORT_OF_THAT.to_owned(),
    })
}

/// The two commands, in a module of their own so the wire names and the crate's names can each
/// read well — [`crate::collection_alloc::commands`]' shape.
///
/// `generate_handler!` takes the **last segment** of the path as the command name, so these
/// register as `deck_pull_plan` and `deck_pull_from_collection` — the names `src/lib/ipc.ts`
/// invokes — while the crate says [`super::plan`] and [`super::from_collection`], which are
/// module plus verb and do not stutter.
pub mod commands {
    #[cfg(not(target_family = "wasm"))]
    use super::{from_collection as pull, plan as read_plan, Pick, PullOutcome, PullRow};
    #[cfg(not(target_family = "wasm"))]
    use crate::sync::AppState;
    #[cfg(not(target_family = "wasm"))]
    use std::sync::Arc;

    /// [`super::plan`]'s command. **Read-only** connection, and no marketplace: nothing in the
    /// answer is priced, which is why the plan takes none either.
    ///
    /// Cheap enough to re-ask after any write, and the dialog does: this is the read that says
    /// whether the last pull emptied the list.
    #[cfg(not(target_family = "wasm"))]
    #[tauri::command]
    pub async fn deck_pull_plan(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
    ) -> Result<Vec<PullRow>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            read_plan(&crate::sync::lock_db_read(&state), deck_id)
        })
        .await
        .map_err(|e| format!("the pull could not be planned: {e}"))?
    }

    /// **[`crate::collection_source::with_write_owned`] and not bare `with_write`**: this moves
    /// rows between folders and can delete one by folding it, and the facet index's `owned`
    /// dimension is built by counting rows. [`crate::collection_alloc::commands`] carries the
    /// same note, and this is the third write in the crate that owes it.
    #[cfg(not(target_family = "wasm"))]
    #[tauri::command]
    pub async fn deck_pull_from_collection(
        state: tauri::State<'_, Arc<AppState>>,
        deck_id: i64,
        picks: Vec<Pick>,
    ) -> Result<PullOutcome, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::collection_source::with_write_owned(&state, |c| pull(c, deck_id, &picks))
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
    /// hands out — [`crate::collection_alloc`]'s test suite opens the same way and for the same
    /// reason: `collection_entries.folder_id` SET NULLs and `collection_folders.deck_id`
    /// CASCADEs, and both are per-connection settings.
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

    /// A binder the reader made and named.
    fn user_folder(conn: &Connection, name: &str, sort_order: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_folders
                 (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, 'user', NULL, ?2, unixepoch(), unixepoch())
             RETURNING id",
            params![name, sort_order],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The one holding area every database past v25 has.
    fn removed_folder(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = ?1",
            params![REMOVED_KIND],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One owned row, filed where it is told. `condition` is a parameter because two rows of one
    /// printing in one folder must differ in a grain term to exist at all, and the condition is
    /// the cheapest of the eleven to vary.
    fn seed_entry_as(
        conn: &Connection,
        card_id: &str,
        quantity: i64,
        folder: Option<i64>,
        finish: &str,
        condition: &str,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                 (card_id, set_code, collector_number, lang, finish, condition, quantity,
                  folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', ?4, ?5, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, folder, finish, condition],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The common case: a plain NM copy.
    fn seed_entry(conn: &Connection, card_id: &str, quantity: i64, folder: Option<i64>) -> i64 {
        seed_entry_as(conn, card_id, quantity, folder, NONFOIL, "NM")
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
             VALUES (?1, ?2, ?3, ?4, 'lea', '161', 'en', 'Lightning Bolt', ?5, ?6,
                     unixepoch(), unixepoch())
             RETURNING id",
            params![deck, category, LIVE, card_id, finish, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The live list's own quantity for a printing — the number a pull must never touch.
    fn listed(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND variant = 'live'",
            params![deck, card_id],
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

    /// Copies still filed under nothing.
    fn root_copies(conn: &Connection, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE card_id = ?1 AND folder_id IS NULL",
            params![card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// What one entry holds, or `None` once a fold has taken it away.
    fn entry_quantity(conn: &Connection, entry: i64) -> Option<i64> {
        conn.query_row(
            "SELECT quantity FROM collection_entries WHERE id = ?1",
            params![entry],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// What the deck's own read says it owns of a printing, after everything has settled. The
    /// number the editor's missing badge subtracts from, read back through the same command the
    /// editor calls.
    fn owned_in_deck(conn: &Connection, deck: i64, card_id: &str) -> i64 {
        crate::deck::get_deck(conn, deck, LIVE, crate::sorting::Marketplace::default())
            .unwrap()
            .expect("the deck is there")
            .cards
            .iter()
            .filter(|c| c.card_id == card_id)
            .map(|c| c.owned_quantity)
            .sum()
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

    /// How many reversals this deck has filed. Unmoved by a pull, and that is the point.
    fn steps(conn: &Connection, deck: i64) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM deck_undo WHERE deck_id = ?1",
            params![deck],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A second printing of the **same** oracle card — [`seed_card`] derives one per printing
    /// (`'o-' || id`), so "a Bolt is a Bolt" is a question only two rows sharing an oracle id can
    /// ask.
    fn seed_reprint(conn: &Connection, id: &str, of: &str) {
        seed_card(conn, id, "m10", "146");
        conn.execute(
            "UPDATE cards SET oracle_id = (SELECT oracle_id FROM cards WHERE id = ?2)
              WHERE id = ?1",
            params![id, of],
        )
        .unwrap();
    }

    // ---- the plan -----------------------------------------------------------------

    #[test]
    fn a_hole_is_filled_and_the_deck_card_is_not_touched() {
        // The case the whole feature turns on, and the issue's own example: the list wants four,
        // the group holds one, three are in the binder. After the pull the deck owns four of the
        // four it lists — and still **lists** four, which is the difference from
        // `collection_to_deck` and the reason this module exists.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let group = crate::deck::deck_group(&conn, deck).unwrap();
        seed_entry(&conn, "bolt", 1, group);
        let binder = seed_entry(&conn, "bolt", 3, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].short, 3, "four listed, one held");
        assert_eq!(rows[0].card_id, "bolt");
        assert_eq!(rows[0].finish, None);
        assert_eq!(rows[0].categories, vec!["Main deck".to_owned()]);
        assert_eq!(rows[0].candidates.len(), 1);
        assert_eq!(rows[0].candidates[0].entry_id, binder);

        let out = from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: binder,
                quantity: 3,
            }],
        )
        .unwrap();

        assert_eq!(out.copies, 3);
        assert_eq!(out.cards, 1);
        assert_eq!(group_copies(&conn, deck, "bolt"), 4);
        assert_eq!(root_copies(&conn, "bolt"), 0);
        assert_eq!(
            owned_in_deck(&conn, deck, "bolt"),
            4,
            "the missing badge has nothing left to draw"
        );
        assert_eq!(
            listed(&conn, deck, "bolt"),
            4,
            "the list is what it was — a pull writes no `deck_cards` row"
        );
        assert!(plan(&conn, deck).unwrap().is_empty(), "no hole is left");
    }

    #[test]
    fn copies_in_another_decks_group_are_never_offered_and_are_refused_if_picked() {
        // The issue's "only pull cards that are not already in another deck folder". A copy in
        // Deck B is spoken for: Deck B's list claims it, and moving it here would leave that
        // deck holding fewer cards than it lists, silently.
        let (conn, a, cat_a) = fixture();
        let (b, _) = deck_with_group(&conn, "Deck B");
        add_deck_card(&conn, a, cat_a, "bolt", 2, None);
        let b_group = crate::deck::deck_group(&conn, b).unwrap();
        let theirs = seed_entry(&conn, "bolt", 2, b_group);

        assert!(
            plan(&conn, a).unwrap().is_empty(),
            "the only copies are in another deck, so the row has no candidate at all"
        );

        let err = from_collection(
            &conn,
            a,
            &[Pick {
                entry_id: theirs,
                quantity: 1,
            }],
        )
        .unwrap_err();
        assert_eq!(err, crate::collection_folders::ENTRY_IN_A_DECK);
        assert_eq!(entry_quantity(&conn, theirs), Some(2), "nothing moved");
    }

    #[test]
    fn copies_in_this_decks_own_group_are_not_offered() {
        // Already counted in `owned_quantity`, so offering them would be offering to fill a hole
        // with the thing already in it — and picking one would move a row into the folder it is
        // already in.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let group = crate::deck::deck_group(&conn, deck).unwrap();
        let held = seed_entry(&conn, "bolt", 2, group);

        let rows = plan(&conn, deck).unwrap();
        assert!(
            rows.is_empty(),
            "short two, and the only copies are the ones already here"
        );

        let err = from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: held,
                quantity: 1,
            }],
        )
        .unwrap_err();
        assert_eq!(err, crate::collection_folders::ENTRY_IN_A_DECK);
    }

    #[test]
    fn the_root_a_binder_and_recently_removed_are_all_offered() {
        // Three places a card can sit that are all "on the reader's desk" —
        // `Allocation::Unallocated`'s sentence, and only a `deck` folder is excluded.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 5, None);
        let binder = user_folder(&conn, "Binder", 0);
        let removed = removed_folder(&conn);
        seed_entry(&conn, "bolt", 1, None);
        seed_entry(&conn, "bolt", 1, Some(binder));
        seed_entry(&conn, "bolt", 1, Some(removed));

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1);
        let kinds: Vec<Option<&str>> = rows[0]
            .candidates
            .iter()
            .map(|c| c.folder_kind.as_deref())
            .collect();
        assert_eq!(kinds, vec![None, Some("removed"), Some("user")]);
        let names: Vec<Option<&str>> = rows[0]
            .candidates
            .iter()
            .map(|c| c.folder_name.as_deref())
            .collect();
        assert_eq!(
            names[0], None,
            "the root has no name — the UI words it, not this crate"
        );
        assert_eq!(names[2], Some("Binder"));
    }

    #[test]
    fn candidates_run_root_then_removed_then_binders_oldest_first() {
        // The chosen ranking, and it ranks by how little of the reader's filing a pull disturbs.
        // The two root rows differ in condition because two rows of one printing in one folder
        // must differ in a grain term to exist at all; between them the tiebreak is `e.id`,
        // `take_copies`' own rule.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 9, None);
        let removed = removed_folder(&conn);
        let late = user_folder(&conn, "Trade binder", 7);
        let early = user_folder(&conn, "Cube", 1);

        // Deliberately seeded out of order, so the answer is the `ORDER BY`'s and not the
        // insert's.
        let in_late = seed_entry(&conn, "bolt", 1, Some(late));
        let in_removed = seed_entry(&conn, "bolt", 1, Some(removed));
        let root_older = seed_entry_as(&conn, "bolt", 1, None, NONFOIL, "NM");
        let in_early = seed_entry(&conn, "bolt", 1, Some(early));
        let root_newer = seed_entry_as(&conn, "bolt", 1, None, NONFOIL, "LP");

        let rows = plan(&conn, deck).unwrap();
        let order: Vec<i64> = rows[0].candidates.iter().map(|c| c.entry_id).collect();
        assert_eq!(
            order,
            vec![root_older, root_newer, in_removed, in_early, in_late],
            "root (oldest first), then Recently removed, then the reader's folders by sort_order"
        );
    }

    #[test]
    fn another_printing_of_the_same_card_is_not_a_candidate() {
        // The deliberate narrowing. The deck's own owned count is attributed at the oracle grain,
        // so the app would happily *call* these copies this card — but a pull moves one specific
        // object, and a reader who sleeved the Alpha printing does not find the M10 one in their
        // deck because a dialog decided they were the same card.
        let (conn, deck, cat) = fixture();
        seed_reprint(&conn, "bolt-m10", "bolt");
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        let other = seed_entry(&conn, "bolt-m10", 2, None);

        assert!(
            plan(&conn, deck).unwrap().is_empty(),
            "short two, and the only copies are of another printing"
        );
        let err = from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: other,
                quantity: 1,
            }],
        )
        .unwrap_err();
        assert_eq!(err, NOT_SHORT_OF_THAT);
    }

    #[test]
    fn another_finish_is_not_a_candidate() {
        // The same narrowing on the other axis, and the sharper of the two: a foil hole is not
        // filled by a plain copy, whatever the sleeve looks like from across the table.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, Some("foil"));
        seed_entry(&conn, "bolt", 2, None);

        assert!(
            plan(&conn, deck).unwrap().is_empty(),
            "the list wants foils and the binder holds regulars"
        );

        // And the same deck, short of the regular copies, does find them.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        seed_entry(&conn, "bolt", 2, None);
        assert_eq!(plan(&conn, deck).unwrap().len(), 1);
    }

    #[test]
    fn an_inactive_category_is_short_of_nothing() {
        // A switched-off pile counts toward nothing anywhere in the app. `attribute_owned` hands
        // it no copies either, so without the skip every row in it would report its whole
        // quantity as a shortfall — a Maybe pile would flood this dialog.
        let (conn, deck, _) = fixture();
        let maybe = crate::schema::tests::category(&conn, deck, "maybe", "Maybe");
        add_deck_card(&conn, deck, maybe, "bolt", 4, None);
        seed_entry(&conn, "bolt", 4, None);

        assert!(plan(&conn, deck).unwrap().is_empty());
    }

    #[test]
    fn one_printing_short_in_two_piles_is_one_row_naming_both() {
        // What a reader is short of is cardboard, so the fold is to the printing and the piles
        // ride along as a label. `categories` is in the deck's own read order — category
        // `sort_order` first, which is what puts Main deck before Sideboard here.
        let (conn, deck, main) = fixture();
        let side = crate::schema::tests::category(&conn, deck, "side", "Sideboard");
        conn.execute(
            "UPDATE deck_categories SET sort_order = 1 WHERE id = ?1",
            params![side],
        )
        .unwrap();
        add_deck_card(&conn, deck, main, "bolt", 3, None);
        add_deck_card(&conn, deck, side, "bolt", 2, None);
        seed_entry(&conn, "bolt", 5, None);

        let rows = plan(&conn, deck).unwrap();
        assert_eq!(rows.len(), 1, "one printing is one row");
        assert_eq!(rows[0].short, 5, "the sum, not the larger of the two");
        assert_eq!(
            rows[0].categories,
            vec!["Main deck".to_owned(), "Sideboard".to_owned()]
        );
    }

    #[test]
    fn a_card_the_reader_does_not_own_is_left_out_of_the_plan() {
        // The issue says in as many words that not every card will have a collection option, so
        // an empty `candidates` is not a row to draw — it is a row to leave out.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        assert!(plan(&conn, deck).unwrap().is_empty());
    }

    #[test]
    fn a_theory_only_deck_has_nothing_to_pull() {
        // A plan holds no cards, so it is short of none — `THEORY_HOLDS_NOTHING`'s premise read
        // from the other end, and the reason this command takes no variant argument.
        let (conn, deck, cat) = fixture();
        conn.execute(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'theory', 'bolt', 'lea', '161', 'en', 'Lightning Bolt', 4,
                     unixepoch(), unixepoch())",
            params![deck, cat],
        )
        .unwrap();
        seed_entry(&conn, "bolt", 4, None);

        assert!(plan(&conn, deck).unwrap().is_empty());
    }

    #[test]
    fn a_deck_that_is_not_there_is_a_sentence() {
        let conn = open();
        assert_eq!(plan(&conn, 9999).unwrap_err(), crate::deck::GONE);
    }

    // ---- the write ----------------------------------------------------------------

    #[test]
    fn an_empty_batch_is_refused() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        assert_eq!(
            from_collection(&conn, deck, &[]).unwrap_err(),
            NOTHING_PICKED
        );
    }

    #[test]
    fn one_bad_pick_refuses_the_whole_batch_and_moves_nothing() {
        // All-or-nothing. A half-applied pull leaves copies somewhere the reader was not looking
        // at, and this write files no undo step — so there is no press that takes it back.
        let (conn, deck, cat) = fixture();
        seed_card(&conn, "shock", "m10", "156");
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        conn.execute(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'live', 'shock', 'm10', '156', 'en', 'Shock', 2,
                     unixepoch(), unixepoch())",
            params![deck, cat],
        )
        .unwrap();
        let good = seed_entry(&conn, "bolt", 2, None);
        let also_good = seed_entry(&conn, "shock", 2, None);

        let err = from_collection(
            &conn,
            deck,
            &[
                Pick {
                    entry_id: good,
                    quantity: 2,
                },
                Pick {
                    entry_id: 424_242,
                    quantity: 1,
                },
                Pick {
                    entry_id: also_good,
                    quantity: 2,
                },
            ],
        )
        .unwrap_err();

        assert_eq!(err, crate::collection::GONE);
        assert_eq!(entry_quantity(&conn, good), Some(2), "the good pick before");
        assert_eq!(
            entry_quantity(&conn, also_good),
            Some(2),
            "and the good pick after"
        );
        assert_eq!(group_copies(&conn, deck, "bolt"), 0);
        assert!(history(&conn, deck).is_empty(), "and no history of a press");
    }

    #[test]
    fn taking_more_copies_than_the_row_holds_is_refused() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let entry = seed_entry(&conn, "bolt", 2, None);
        let err = from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: entry,
                quantity: 3,
            }],
        )
        .unwrap_err();
        assert_eq!(err, crate::collection_alloc::NOT_THAT_MANY);
        assert_eq!(entry_quantity(&conn, entry), Some(2));
    }

    #[test]
    fn taking_more_copies_than_the_deck_is_short_of_is_refused() {
        // The copies exist and the deck does not want them. Filing them anyway would put cards in
        // a group its own list does not claim.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        let entry = seed_entry(&conn, "bolt", 4, None);
        let err = from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: entry,
                quantity: 3,
            }],
        )
        .unwrap_err();
        assert_eq!(err, MORE_THAN_MISSING);
        assert_eq!(entry_quantity(&conn, entry), Some(4));
    }

    #[test]
    fn two_picks_against_one_printing_are_measured_together() {
        // Each pick is inside the shortfall and the pair is not — the check that has to be about
        // the running total rather than about one row at a time.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 3, None);
        let a = seed_entry_as(&conn, "bolt", 2, None, NONFOIL, "NM");
        let b = seed_entry_as(&conn, "bolt", 2, None, NONFOIL, "LP");

        let err = from_collection(
            &conn,
            deck,
            &[
                Pick {
                    entry_id: a,
                    quantity: 2,
                },
                Pick {
                    entry_id: b,
                    quantity: 2,
                },
            ],
        )
        .unwrap_err();
        assert_eq!(err, MORE_THAN_MISSING);

        // Three between them is what the deck is short of, and it lands.
        let out = from_collection(
            &conn,
            deck,
            &[
                Pick {
                    entry_id: a,
                    quantity: 2,
                },
                Pick {
                    entry_id: b,
                    quantity: 1,
                },
            ],
        )
        .unwrap();
        assert_eq!(out.copies, 3);
        assert_eq!(out.cards, 1, "one printing, however many rows it came from");
        assert_eq!(group_copies(&conn, deck, "bolt"), 3);
    }

    #[test]
    fn two_picks_naming_one_row_are_one_take() {
        // They have to be merged rather than applied in turn: `take_copies` splits the source,
        // so the second take would be pointed at a row that has moved or been folded away and
        // the caller would be told its own row was `GONE`. Merged, the batch means what it
        // plainly says — and the total is still measured against both fences.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let entry = seed_entry(&conn, "bolt", 4, None);

        let out = from_collection(
            &conn,
            deck,
            &[
                Pick {
                    entry_id: entry,
                    quantity: 1,
                },
                Pick {
                    entry_id: entry,
                    quantity: 2,
                },
            ],
        )
        .unwrap();

        assert_eq!(out.copies, 3);
        assert_eq!(out.cards, 1);
        assert_eq!(group_copies(&conn, deck, "bolt"), 3);
        assert_eq!(
            root_copies(&conn, "bolt"),
            1,
            "the remainder is what is left"
        );

        // And the merged total is what the row fence measures: 3 + 2 is more than the row holds,
        // where each pick on its own would have passed.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 5, None);
        let entry = seed_entry(&conn, "bolt", 4, None);
        let err = from_collection(
            &conn,
            deck,
            &[
                Pick {
                    entry_id: entry,
                    quantity: 3,
                },
                Pick {
                    entry_id: entry,
                    quantity: 2,
                },
            ],
        )
        .unwrap_err();
        assert_eq!(err, crate::collection_alloc::NOT_THAT_MANY);
    }

    #[test]
    fn a_zero_quantity_pick_is_refused() {
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let entry = seed_entry(&conn, "bolt", 2, None);
        assert_eq!(
            from_collection(
                &conn,
                deck,
                &[Pick {
                    entry_id: entry,
                    quantity: 0
                }]
            )
            .unwrap_err(),
            crate::collection_alloc::ZERO_MOVE
        );
    }

    #[test]
    fn a_pull_records_one_move_row_with_a_zero_delta() {
        // One row per press, `kind = "move"` with a payload nothing else writes — `AUDIT_KINDS`
        // stays at nine because `deck_audit.kind`'s CHECK cannot be altered. `delta` is 0 because
        // the *list* gained nothing, and `delta` is what the drawer's day header adds up.
        let (conn, deck, cat) = fixture();
        seed_card(&conn, "shock", "m10", "156");
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        conn.execute(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'live', 'shock', 'm10', '156', 'en', 'Shock', 1,
                     unixepoch(), unixepoch())",
            params![deck, cat],
        )
        .unwrap();
        let bolts = seed_entry(&conn, "bolt", 2, None);
        let shock = seed_entry(&conn, "shock", 1, None);

        from_collection(
            &conn,
            deck,
            &[
                Pick {
                    entry_id: bolts,
                    quantity: 2,
                },
                Pick {
                    entry_id: shock,
                    quantity: 1,
                },
            ],
        )
        .unwrap();

        let rows = history(&conn, deck);
        assert_eq!(rows.len(), 1, "one row for the press, not one per printing");
        assert_eq!(rows[0].0, "move");
        assert_eq!(rows[0].1, None, "a batch names no one card");
        assert_eq!(rows[0].2, json!({ "pull": { "copies": 3, "cards": 2 } }));
        assert_eq!(rows[0].3, 0, "the list did not change");
        assert_eq!(
            crate::schema::AUDIT_KINDS.len(),
            9,
            "a tenth kind would mean rebuilding every reader's deck history for a spelling"
        );
    }

    #[test]
    fn a_pull_files_no_undo_step() {
        // `take_copies` files through the merge, so a source row may have been folded away and no
        // longer exists to restore — `collection_to_deck`'s argument, not re-derived here. The
        // cursor does not move, so Ctrl+Z goes on offering the press before the pull.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 2, None);
        let entry = seed_entry(&conn, "bolt", 2, None);
        from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: entry,
                quantity: 2,
            }],
        )
        .unwrap();
        assert_eq!(steps(&conn, deck), 0);
    }

    #[test]
    fn a_partial_pick_leaves_the_remainder_where_it_was() {
        // `take_copies`' split, seen from this command: the copies that travel are filed into the
        // group and the rest stays in the binder the reader put it in.
        let (conn, deck, cat) = fixture();
        add_deck_card(&conn, deck, cat, "bolt", 4, None);
        let binder = user_folder(&conn, "Binder", 0);
        let entry = seed_entry(&conn, "bolt", 4, Some(binder));

        from_collection(
            &conn,
            deck,
            &[Pick {
                entry_id: entry,
                quantity: 3,
            }],
        )
        .unwrap();

        assert_eq!(group_copies(&conn, deck, "bolt"), 3);
        let left: i64 = conn
            .query_row(
                "SELECT coalesce(sum(quantity), 0) FROM collection_entries
                  WHERE card_id = 'bolt' AND folder_id = ?1",
                params![binder],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 1, "the remainder stays in the binder");
    }
}
