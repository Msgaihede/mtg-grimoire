//! Scryfall's id migrations, applied to the user's own rows.
//!
//! The rule the whole module exists to keep, from CLAUDE.md and spec §4.7: **a merge
//! repoints, a delete flags, and nothing here ever removes a row the user created.** A
//! collection tracker that silently drops a card because an upstream database tidied its
//! identifiers has destroyed the only record of something the user paid for.
//!
//! **`card_migrations` is in the user file, and that is a correctness requirement rather than
//! a filing preference.** Its rows come from Scryfall, so the obvious reading is that it is
//! derived and belongs beside `cards`. It is not: the table's job is "which of these have I
//! already applied to *my* rows", and [`apply`] writes it in the same transaction as the folds
//! it is recording. SQLite makes no atomicity guarantee across attached databases in WAL mode
//! and raises nothing when a transaction spans two — the commit succeeds and either file may
//! be the one that survives a power cut — so corpus-side, a crash between the two commits
//! would leave a quantity doubled and nothing to say it had been.
//! `apply_writes_only_the_user_file` is what keeps them together: it drives the update hook,
//! which reports SQLite's own schema name for every write, and moving the table turns it red
//! with `main | corpus`.
//!
//! Two halves, and only the first needs the network:
//!
//! * [`apply`] walks `/migrations`, Scryfall's log of the ids it changed *deliberately*.
//!   It is authoritative but incomplete, and it is a growing list that is re-read on every
//!   poll — so `card_migrations` records what has been applied, and that bookkeeping is
//!   the only thing standing between a re-poll and a collection that grows on its own.
//! * [`sweep_orphans`] asks the question the log cannot answer — does this `card_id` still
//!   resolve? — of every user row, after every ingest, for free.
//!
//! The one place a row *is* removed is a fold: two rows that upstream now says are one
//! card become one row with both quantities **and the receipt** — what was paid, in what
//! currency, when, where from, and the user's own note all move to the survivor where it
//! has no answer of its own. That is `collection::add_entry`'s and `wishlist::add_wish`'s
//! `ON CONFLICT` rule verbatim, and it is what makes "nothing the user recorded is lost"
//! a claim this module can actually keep.
//!
//! Three user tables now, `deck_cards` among them, and that fold is still the only delete in
//! the module: it is conditional on the fold having happened, which is the whole of what keeps
//! "nothing the user recorded is lost" true. **Nothing hangs off the deleted row any more** —
//! no enforced foreign key points at a collection entry since schema v25 dropped
//! `deck_allocations`, and which deck holds a card is now which folder its row sits in, which
//! is a grain term the fold matches on rather than a claim it has to carry across.
//!
//! **The collection half of [`apply`] is an ownership change**, and nothing here reaches an
//! `AppState` to hang the search index's `owned` rebuild off — a sync is the one moment nobody
//! is watching the screen, so there is no command wrapper to carry one either. It needs none:
//! `crate::sync`'s `reconcile_ids` already calls
//! `crate::index::lifecycle::invalidate_owned` whenever a pass repointed, folded or flagged
//! anything, and every arm of [`merge`] bumps one of those three. The deck and wishlist arms
//! share that refresh while moving no bit in `owned` — [`crate::collection_source`] reads
//! ownership from `collection_entries` alone — and so does a pass that only *flagged* rows.
//! That costs one dimension re-read on the rare pass that has already found something to tell
//! the user about, and it is the right way round.
//!
//! [`sweep_orphans`] is the deliberate exception and needs no refresh at all: it writes
//! `needs_review` and never a `card_id`, so the set of cards the reader owns is the same
//! before and after it.

use crate::scryfall::Migration;
use rusqlite::{params, Connection, OptionalExtension};

/// What one pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileStats {
    pub repointed: usize,
    pub folded: usize,
    pub flagged: usize,
    /// Migrations already applied, or of a strategy this app does not know.
    pub skipped: usize,
}

/// Is there any user data to reconcile at all?
///
/// Scryfall asks applications not to make requests they do not need, and a database with no
/// collection, no wishlist and no deck list has nothing an id migration could be about.
///
/// `deck_cards` and not `decks`, because `deck_cards` is where a deck's card ids are: an
/// empty deck names no printing this module acts on, and `decks.cover_card_id` — the only
/// other card id in the deck tables — is cosmetic and untouched here.
///
/// A count that cannot be read answers `1`, so an unreadable database is treated as having
/// rows: skipping the poll on a failed `count(*)` would make a broken read look like an
/// empty collection and quietly stop reconciling forever.
pub fn user_data_is_empty(conn: &Connection) -> bool {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(1);
    count("SELECT count(*) FROM collection_entries") == 0
        && count("SELECT count(*) FROM wishlist_entries") == 0
        && count("SELECT count(*) FROM deck_cards") == 0
}

/// Apply every migration this database has not already applied.
///
/// One transaction for the whole pass: half-applied merges would leave rows pointing at
/// ids that no longer describe what they own.
pub fn apply(conn: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<ReconcileStats> {
    let mut stats = ReconcileStats::default();
    // Merge destinations resolve through the pass's own map, so a chain lands every row
    // on its FINAL id no matter how the log was ordered or dated. [`oldest_first`] still
    // runs — it keeps `card_migrations` recorded in a sane order — but correctness no
    // longer leans on dates Scryfall only publishes to the day.
    let resolved: std::collections::HashMap<&str, &str> = migrations
        .iter()
        .filter(|m| m.strategy == "merge")
        .filter_map(|m| {
            let new = m.new_card_id.as_deref()?.trim();
            (!new.is_empty()).then_some((m.old_card_id.as_str(), new))
        })
        .collect();
    let tx = conn.transaction()?;
    for m in oldest_first(migrations) {
        let already: bool = tx
            .query_row(
                "SELECT 1 FROM card_migrations WHERE id = ?1",
                params![m.id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        // Re-polling the log is normal — it is a growing list, not a queue. Applying a
        // *fold* twice would double a quantity, so "have I seen this?" is the only thing
        // standing between a re-poll and a collection that grows on its own.
        if already {
            stats.skipped += 1;
            continue;
        }
        match (m.strategy.as_str(), m.new_card_id.as_deref()) {
            // A blank id is no id (the same rule `wishlist::add_wish` applies to what a
            // form sends): repointing a row at `''` would orphan it permanently and put
            // every other blank-id row on the same grain.
            ("merge", Some(new_id)) if !new_id.trim().is_empty() => {
                merge(&tx, m, final_id(&resolved, new_id.trim()), &mut stats)?
            }
            ("delete", _) => stats.flagged += flag_deleted(&tx, m)?,
            // A strategy this app has never heard of, or a merge with nowhere to merge to.
            // Recorded as applied all the same: guessing at it later would be no better
            // informed than guessing at it now.
            _ => stats.skipped += 1,
        }
        tx.execute(
            "INSERT OR IGNORE INTO card_migrations
                (id, performed_at, strategy, old_card_id, new_card_id, note, applied_at)
             VALUES (?1,?2,?3,?4,?5,?6, unixepoch())",
            params![
                m.id,
                m.performed_at,
                // The CHECK on the table only knows two strategies, and an unknown one must
                // not fail the pass — it is stored as what it did, which is nothing.
                if m.strategy == "delete" {
                    "delete"
                } else {
                    "merge"
                },
                m.old_card_id,
                m.new_card_id,
                // ...and the *raw* strategy goes in the note, so the row stays true. The
                // column above is a coercion the CHECK demands; without this, a strategy
                // Scryfall adds later is recorded as a merge that never happened, with
                // nothing left to say it was ever anything else. Written down is written
                // down: a version of this app that learns the strategy can find these rows.
                recorded_note(m)
            ],
        )?;
    }
    tx.commit()?;
    Ok(stats)
}

/// The migrations of one pass, oldest first.
///
/// Scryfall serves the log newest first, and applying it in that order breaks **chains**:
/// with A→B performed in 2021 and B→C in 2023, the newest-first pass repoints B's rows to C
/// and only then moves A's rows to B — which is now a dead id. Both migrations are recorded
/// as applied, so the next poll skips them, and the row is parked on B forever behind a
/// flag promising a card that is never coming.
///
/// A migration with no `performed_at` cannot be placed in a chain at all, so it trails the
/// ones that can, in the order the API gave it. The sort is stable, which is what makes
/// that "in the order the API gave it" rather than "in some order".
fn oldest_first(migrations: &[Migration]) -> Vec<&Migration> {
    let mut ordered: Vec<&Migration> = migrations.iter().collect();
    ordered.sort_by(|a, b| match (&a.performed_at, &b.performed_at) {
        // ISO-8601 sorts lexically the way it sorts chronologically, which is the whole
        // reason this needs no date parsing.
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    ordered
}

/// Where a merge destination *ends up*, walked through one pass's own old→new map.
///
/// [`oldest_first`] fixes the chains it can see, and `performed_at` is why it cannot see
/// them all: Scryfall publishes it to the **day**, so A→B and B→C performed on one day
/// arrive newest-first and the stable sort — equal keys, order preserved — keeps them that
/// way. The pass would then repoint A's rows to B, an id it retired a moment earlier,
/// record both migrations as applied, and never revisit either: the row waits behind a flag
/// for a card that is never coming. Ordering cannot fix that; resolution can, and it fixes
/// the dated case too — those rows now take one hop instead of one per link.
///
/// The recorded `card_migrations` row still keeps Scryfall's own `new_card_id`: the
/// bookkeeping mirrors the log, and the *rows* land on the truth.
///
/// Bounded by the map's size, so a cycle (A→B, B→A) stops instead of spinning.
fn final_id<'a>(
    resolved: &std::collections::HashMap<&'a str, &'a str>,
    mut id: &'a str,
) -> &'a str {
    for _ in 0..resolved.len() {
        match resolved.get(id) {
            Some(&next) => id = next,
            None => break,
        }
    }
    id
}

/// What goes in `card_migrations.note`: Scryfall's own note, and for a strategy this app
/// does not know, the strategy itself in front of it.
fn recorded_note(m: &Migration) -> Option<String> {
    if m.strategy == "merge" || m.strategy == "delete" {
        return m.note.clone();
    }
    Some(match &m.note {
        Some(note) => format!(
            "migration_strategy `{}`, which this app does not know; nothing was applied. {note}",
            m.strategy
        ),
        None => format!(
            "migration_strategy `{}`, which this app does not know; nothing was applied.",
            m.strategy
        ),
    })
}

/// Repoint every row on `old_card_id`, folding any that collide with a row already at the
/// new id.
fn merge(
    tx: &rusqlite::Transaction<'_>,
    m: &Migration,
    new_id: &str,
    stats: &mut ReconcileStats,
) -> rusqlite::Result<()> {
    // The printing as the *new* card describes it. `None` when that card has not arrived in
    // a bulk file yet, which is a real state: the migration log is published before the
    // next bulk rotation carries the card.
    #[allow(clippy::type_complexity)]
    let printing: Option<(String, String, String, Option<String>)> = tx
        .query_row(
            "SELECT set_code, collector_number, lang, oracle_id FROM cards WHERE id = ?1",
            params![new_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let note = match &printing {
        Some(_) => None,
        None => Some(format!(
            "Scryfall merged this printing into {new_id}, which is not in the card database \
             yet. It should arrive with the next card-data sync."
        )),
    };
    let (set_code, collector_number, lang) = match &printing {
        Some((s, c, l, _)) => (Some(s.as_str()), Some(c.as_str()), Some(l.as_str())),
        None => (None, None, None),
    };
    // `cards.oracle_id` is nullable, so this is `Option` twice over: no card row at all, or
    // a card row that has none. Either way there is nothing to refresh from.
    let oracle_id = printing.as_ref().and_then(|p| p.3.as_deref());

    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM collection_entries WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in ids {
        // `needs_review` is written **unconditionally** here, and that is not an exception
        // to first-message-wins: the rule governs the *flag writers* ([`flag_deleted`],
        // [`flag_unfoldable`]), which add a sentence to a row that stayed where it was. A
        // successful repoint has changed what the row points at, so whatever was said about
        // the old id is stale by construction — and `note` is not a vaguer complaint but
        // the answer to the same question, freshly computed: `None` when the new printing
        // is in `cards` (there is nothing left to review), the "not here yet" sentence when
        // it is not. Leaving an old flag standing would park a repointed row behind a
        // complaint about an id it no longer holds.
        let repointed = tx.execute(
            "UPDATE OR IGNORE collection_entries
                SET card_id = ?2,
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, new_id, set_code, collector_number, lang, note],
        )?;
        if repointed == 1 {
            stats.repointed += 1;
            continue;
        }
        // `OR IGNORE` swallowed a unique-constraint violation, which can only mean the
        // collection already holds this exact grain at the new id. Two rows for what
        // upstream now says is one card is one row with both quantities.
        if fold_into_existing(tx, id, new_id, lang)? {
            stats.folded += 1;
        } else {
            stats.flagged += flag_unfoldable(tx, "collection_entries", id, new_id)?;
        }
    }

    let wishes: Vec<i64> = tx
        .prepare("SELECT id FROM wishlist_entries WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in wishes {
        let moved = tx.execute(
            // `oracle_id` is refreshed too, and only here: it is the **first term of
            // `WISHLIST_GRAIN`**, so a wish left on the old oracle card sits on a grain that
            // no longer describes it — a later wish for the same card would not fold into
            // it, and the any-printing arm of `wishlist::owned_sql` (which resolves through
            // `cards.oracle_id`) would count the wrong copies against it. The collection has
            // no such column; the wishlist keeps one because an any-printing wish has no
            // card row to join to.
            "UPDATE OR IGNORE wishlist_entries
                SET card_id = ?2,
                    oracle_id = coalesce(?7, oracle_id),
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![
                id,
                new_id,
                set_code,
                collector_number,
                lang,
                note,
                oracle_id
            ],
        )?;
        if moved == 1 {
            stats.repointed += 1;
        } else if fold_wish_into_existing(tx, id, new_id, oracle_id)? {
            stats.folded += 1;
        } else {
            stats.flagged += flag_unfoldable(tx, "wishlist_entries", id, new_id)?;
        }
    }

    // A deck list is user data by the same argument as the collection: the user typed it,
    // and an upstream id change is not a reason for a card to leave a deck. Same three
    // arms, this table's grain (`schema::DECK_CARD_GRAIN` — `deck_id, variant, category_id,
    // card_id` since schema v8 replaced the fixed zone word with a category the user owns).
    //
    // A repoint here is the module's rule applied to this table: it moves the deck row onto
    // the `cards` row that survived the merge, so a list the reader built keeps naming a card
    // that still resolves. It moves no bit in the index's `owned` set — ownership is
    // `collection_entries` alone (`crate::collection_source`) — but every arm below still
    // bumps a `stats` counter, which is what the caller's refresh keys on; see the module doc.
    //
    // `name` is **not** refreshed, and it is the one column the collection loop does not
    // have to decide about. It is the oracle name, and a merge says two ids are one
    // printing — not that the card is called something else. A card that really is renamed
    // reaches the user through the sweep's flag, which is a sentence they can read, rather
    // than through a deck list that quietly says something different than it did yesterday.
    let deck_rows: Vec<i64> = tx
        .prepare("SELECT id FROM deck_cards WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in deck_rows {
        let repointed = tx.execute(
            "UPDATE OR IGNORE deck_cards
                SET card_id = ?2,
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, new_id, set_code, collector_number, lang, note],
        )?;
        if repointed == 1 {
            stats.repointed += 1;
        } else if fold_deck_card_into_existing(tx, id, new_id)? {
            stats.folded += 1;
        } else {
            stats.flagged += flag_unfoldable(tx, "deck_cards", id, new_id)?;
        }
    }
    Ok(())
}

/// The row a repointed collection entry would collide with, if there is one.
///
/// The grain is spelled out here rather than shared with `schema::COLLECTION_GRAIN`: that
/// constant is a list of *expressions over one row*, and this needs the same list compared
/// *between two rows*.
///
/// `new_lang` is what makes this the grain of the row **after** the repoint rather than
/// before it. The update rewrites `lang` from the new printing, so a source row in one
/// language colliding with a target in another is matched on the target's language, not the
/// source's — compare `s.lang` and the target is missed, which is the difference between
/// folding a row and (before the guard in [`fold_into_existing`]) losing it.
///
/// **Every term is here, and the folder is the one that is easy to leave out.** It joined the
/// grain at schema v24, and this query has to match the grain the `UPDATE OR IGNORE` above it
/// collided on or the two disagree about what a duplicate is: that statement now fails only on
/// a *same-folder* clash, while a ten-term target query happily answers a row filed somewhere
/// else — so the fold would sum the reader's filed copies into a binder they were never in,
/// delete the row that was there, and leave the row that actually blocked the repoint standing.
/// A filing decision undone by an upstream tidy-up, with nothing red and nothing in
/// `error_log`. [`fold_wish_into_existing`] makes the same argument one table over, where the
/// stake is a shopping list; here it is cards that physically exist.
fn collision_target(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
    new_lang: Option<&str>,
) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT t.id FROM collection_entries t, collection_entries s
          WHERE s.id = ?1 AND t.id <> s.id AND t.card_id = ?2
            AND t.finish = s.finish AND t.condition = s.condition
            AND t.lang = coalesce(?3, s.lang)
            AND t.altered = s.altered AND t.signed = s.signed AND t.proxy = s.proxy
            AND t.misprint = s.misprint
            AND coalesce(t.serial_number,'') = coalesce(s.serial_number,'')
            AND coalesce(t.grading,'') = coalesce(s.grading,'')
            AND coalesce(t.folder_id, 0) = coalesce(s.folder_id, 0)",
        params![source, new_id, new_lang],
        |r| r.get(0),
    )
    .optional()
}

/// Fold a row into the row that blocked its repointing, then delete it. `false` when no
/// such row could be found.
///
/// The delete is *conditional on the fold having happened*, and that is the load-bearing
/// part: an unconditional delete here is a user row destroyed with its quantity, which is
/// exactly what this module exists not to do. The caller flags instead.
///
/// # What moves
///
/// [`crate::collection::fold_entry`] is the statements, and what they carry is argued there:
/// the quantities add, the five columns the user typed themselves are taken by the survivor
/// only where it has none, and `tags` and `condition_original` stay the survivor's.
///
/// **They moved to `collection.rs` when `update_entry` needed them too** (schema v24): an
/// edit that lands on a taken grain is the same event as a repoint that lands on one, and the
/// module that owns `collection_entries` is where "one collection row becomes another" belongs.
/// This function keeps the part that is the reconciler's — *which* row was in the way.
fn fold_into_existing(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
    new_lang: Option<&str>,
) -> rusqlite::Result<bool> {
    let Some(target) = collision_target(tx, source, new_id, new_lang)? else {
        return Ok(false);
    };
    crate::collection::fold_entry(tx, target, source)?;
    Ok(true)
}

/// The wishlist's fold. Same shape, the wishlist's own grain, and the same rule: the
/// quantity moves before the row does.
///
/// A wish *does* have a quantity — "three copies wanted" — so dropping the duplicate
/// outright would quietly shrink a shopping list. Summing is what [`crate::wishlist`]'s own
/// `ON CONFLICT` already does when a quick-add lands on a taken grain, and notes are kept
/// the same way it keeps them: the survivor's, falling back to the folded row's.
fn fold_wish_into_existing(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
    new_oracle_id: Option<&str>,
) -> rusqlite::Result<bool> {
    let target: Option<i64> = tx
        .query_row(
            // The grain **after** the repoint, on both terms the repoint rewrites — the
            // same rule [`collision_target`] follows for `lang`. `?3` is the oracle id the
            // update would have set, falling back to the source's own when there is none to
            // set, which is exactly what its `coalesce(?7, oracle_id)` does.
            //
            // **Every term, and the folder is the one that is easy to leave out.** This
            // query has to match the grain the `UPDATE OR IGNORE` above it collided on, or
            // the two disagree about what a duplicate is: since schema v23 that statement
            // fails only on a *same-folder* clash, while a three-term target query happily
            // answers a wish filed somewhere else — so the fold would sum the reader's
            // filed wish into a row at the root, delete it, and leave the row that was
            // actually in the way standing. A filing decision undone by an upstream tidy-up,
            // with no error and nothing in `error_log`.
            "SELECT t.id FROM wishlist_entries t, wishlist_entries s
              WHERE s.id = ?1 AND t.id <> s.id
                AND coalesce(t.oracle_id,'') = coalesce(?3, coalesce(s.oracle_id,''))
                AND coalesce(t.card_id,'') = ?2
                AND coalesce(t.preferred_finish,'') = coalesce(s.preferred_finish,'')
                AND coalesce(t.folder_id, 0) = coalesce(s.folder_id, 0)",
            params![source, new_id, new_oracle_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(target) = target else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE wishlist_entries SET
            quantity = quantity + (SELECT quantity FROM wishlist_entries WHERE id = ?2),
            notes = coalesce(notes, (SELECT notes FROM wishlist_entries WHERE id = ?2)),
            updated_at = unixepoch()
          WHERE id = ?1",
        params![target, source],
    )?;
    tx.execute(
        "DELETE FROM wishlist_entries WHERE id = ?1",
        params![source],
    )?;
    Ok(true)
}

/// The deck list's fold. Same shape again, `schema::DECK_CARD_GRAIN` compared between two
/// rows, and the same rule: the quantity moves before the row does.
///
/// `category_id` **and `variant`** are both in the grain, so this only ever folds two rows the
/// deck runs in the same category of the same list — the same printing in the main deck and
/// in the Maybeboard is two intentions, and one tried out in Theory against the Live copy is
/// two more. A merge is not a reason to collapse any of them into one.
///
/// `tag_id` does not move: the row that survives keeps its own label, `deck::move_card`'s fold
/// rule and `deck_category_delete`'s. Nothing else moves either, because a deck card holds
/// nothing else the user typed — no price, no acquisition story. The quantities add, exactly
/// as `deck.rs`'s own `ON CONFLICT` adds them when the same printing is added to a category
/// twice.
fn fold_deck_card_into_existing(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
) -> rusqlite::Result<bool> {
    let target: Option<i64> = tx
        .query_row(
            // `?2` rather than `s.card_id` for the same reason [`collision_target`] takes
            // the new language: this is the grain of the row **after** the repoint.
            "SELECT t.id FROM deck_cards t, deck_cards s
              WHERE s.id = ?1 AND t.id <> s.id
                AND t.deck_id = s.deck_id AND t.card_id = ?2
                AND t.category_id = s.category_id AND t.variant = s.variant",
            params![source, new_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(target) = target else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE deck_cards SET
            quantity = quantity + (SELECT quantity FROM deck_cards WHERE id = ?2),
            updated_at = unixepoch()
          WHERE id = ?1",
        params![target, source],
    )?;
    tx.execute("DELETE FROM deck_cards WHERE id = ?1", params![source])?;
    Ok(true)
}

/// A row that could neither be repointed nor folded. Defensive: [`collision_target`] and
/// its wishlist twin describe the grains the repoint would violate exactly, so there should
/// always be a row to fold into. If one is ever missed, the row stays where it is and says
/// so — it is never the row that gets thrown away to resolve the disagreement.
///
/// `needs_review IS NULL`, as [`flag_deleted`] has it: **the first message wins.** A row
/// already carrying a sentence is carrying the *earlier* thing that went wrong with it, and
/// that is the one the user needs — overwriting it would let a later, vaguer complaint bury
/// the reason the row is in trouble. Both flag writers agree on this so the field has one
/// rule rather than one per caller. The successful repoint in [`merge`] writes the field
/// unconditionally, and is not a third flag writer breaking the rule: see the comment
/// there.
fn flag_unfoldable(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    id: i64,
    new_id: &str,
) -> rusqlite::Result<usize> {
    tx.execute(
        &format!(
            "UPDATE {table} SET needs_review = ?2, updated_at = unixepoch()
              WHERE id = ?1 AND needs_review IS NULL"
        ),
        params![
            id,
            format!(
                "Scryfall merged this printing into {new_id}, but this entry could not be \
                 moved there. It is unchanged — check it against your other entries for \
                 that card."
            )
        ],
    )
}

/// How the sentence [`flag_deleted`] writes begins.
///
/// A prefix rather than the whole message because the date is interpolated into it, and
/// [`sweep_orphans`] has to be able to recognise one of its own flags without re-deriving
/// the date. Changing this text means changing the `LIKE` pattern in the sweep with it;
/// `a_delete_flag_outlives_a_card_that_is_still_in_the_database` is what fails if they part.
const DELETED_NOTE_PREFIX: &str = "Scryfall removed this printing from its database on ";

/// Flag every row that referred to a discarded id. Returns how many were flagged.
fn flag_deleted(tx: &rusqlite::Transaction<'_>, m: &Migration) -> rusqlite::Result<usize> {
    let when = m.performed_at.as_deref().unwrap_or("an earlier date");
    let note = format!(
        "{DELETED_NOTE_PREFIX}{when}. \
         Your copies are still recorded — check the printing and re-add it if you can \
         identify it, or remove this entry."
    );
    let mut flagged = 0;
    for table in ["collection_entries", "wishlist_entries", "deck_cards"] {
        flagged += tx.execute(
            &format!(
                "UPDATE {table} SET needs_review = ?2, updated_at = unixepoch()
                  WHERE card_id = ?1 AND needs_review IS NULL"
            ),
            params![m.old_card_id, note],
        )?;
    }
    Ok(flagged)
}

/// Flag every row whose `card_id` no longer resolves, and clear every flag whose card is
/// back. Returns `(flagged, cleared)`.
///
/// Run after every ingest. `/migrations` explains the ids Scryfall changed *deliberately*;
/// this asks the only question the user cares about — can this row still be shown? — and
/// it needs no network at all.
pub fn sweep_orphans(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    const MISSING: &str =
        "This printing is not in the card database. It may have been removed by the last \
         card-data sync, or it may return with the next one.";
    let mut flagged = 0;
    let mut cleared = 0;
    for table in ["collection_entries", "wishlist_entries", "deck_cards"] {
        // `card_id IS NOT NULL` is not redundant on the wishlist: a wish for *any*
        // printing carries no card id at all (spec §6), and it resolves to whatever
        // printing the list joins to — it is not an orphan and must never be flagged as one.
        // On the other two the column is `NOT NULL`, so the guard is vacuous and harmless.
        flagged += conn.execute(
            &format!(
                "UPDATE {table} SET needs_review = ?1, updated_at = unixepoch()
                  WHERE needs_review IS NULL AND card_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.id = {table}.card_id)"
            ),
            params![MISSING],
        )?;
        // The other direction, and the reason a flag is a sentence rather than a boolean: a
        // printing that comes back — a bad bulk file, a re-added card — clears its own
        // flag, so a transient gap does not leave a permanent scar on the row.
        //
        // Except a *delete* flag, which this must not touch. `/migrations` is polled after
        // the sweep and before the bulk file that drops the card has rotated, so the window
        // where a row is flagged "Scryfall removed this printing" while the card is still in
        // `cards` is the ordinary case, not a rare one — and clearing it there would erase
        // the warning for good, because the migration is already recorded and never
        // reapplied. A text guard, deliberately: the honest fix is a reason column, and that
        // belongs with the `needs_review` UI task that will have to render these anyway.
        cleared += conn.execute(
            &format!(
                "UPDATE {table} SET needs_review = NULL, updated_at = unixepoch()
                  WHERE needs_review IS NOT NULL AND card_id IS NOT NULL
                    AND needs_review NOT LIKE ?1
                    AND EXISTS (SELECT 1 FROM cards WHERE cards.id = {table}.card_id)"
            ),
            params![format!("{DELETED_NOTE_PREFIX}%")],
        )?;
    }
    Ok((flagged, cleared))
}

#[cfg(test)]
mod tests {
    use super::*;
    // The deck fixtures' one shared piece: a category is what a deck card is filed under
    // since schema v8, and `schema::tests` already owns the insert.
    use crate::schema::tests::category;

    fn migration(id: &str, strategy: &str, old: &str, new: Option<&str>) -> Migration {
        Migration {
            id: id.to_owned(),
            performed_at: Some("2026-07-01T00:00:00Z".to_owned()),
            strategy: strategy.to_owned(),
            old_card_id: old.to_owned(),
            new_card_id: new.map(str::to_owned),
            note: None,
        }
    }

    /// [`apply`] opens one transaction over the reader's rows *and* the ledger of what has
    /// been applied to them, and SQLite does not promise those two commit together across
    /// attached databases. So they must not be in two files: both are the user's.
    ///
    /// The failure this prevents is not a crash — it is a collection that grows by itself. A
    /// fold applied and not recorded is a fold applied again on the next poll.
    #[test]
    fn apply_writes_only_the_user_file() {
        use std::sync::atomic::{AtomicU8, Ordering};
        use std::sync::Arc;

        let mut conn = crate::schema::memory_pair();
        own(&conn, "old-id", "nonfoil", 2);

        let schemas = Arc::new(AtomicU8::new(0));
        {
            let s = schemas.clone();
            conn.update_hook(Some(
                move |_a: rusqlite::hooks::Action, db: &str, _t: &str, _r: i64| {
                    s.fetch_or(if db == "main" { 1 } else { 2 }, Ordering::Relaxed);
                },
            ))
            .unwrap();
        }

        let stats = apply(
            &mut conn,
            &[migration("m-1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!(
            stats.repointed + stats.folded,
            1,
            "the fold must have happened"
        );
        assert_eq!(
            schemas.load(Ordering::Relaxed),
            1,
            "apply must write the user file and nothing else"
        );
        assert_eq!(
            crate::schema::side_of("card_migrations"),
            Some(crate::schema::Side::User)
        );
    }

    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn own(conn: &Connection, card_id: &str, finish: &str, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES (?1,'lea','161','en',?2,'NM',?3,unixepoch(),unixepoch()) RETURNING id",
            rusqlite::params![card_id, finish, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A deck, taking every default the table offers. These three seed helpers are this
    /// module's own — `schema::tests` has helpers of the same names, but they belong to
    /// that module's tests and are free to change with them; `own` above already sets the
    /// precedent that a seeder lives beside the tests that read it.
    fn deck(conn: &Connection, name: &str) -> i64 {
        conn.query_row(
            "INSERT INTO decks (name, created_at, updated_at)
             VALUES (?1, unixepoch(), unixepoch()) RETURNING id",
            [name],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One printing in one category of one deck (the `live` variant, the only one these
    /// tests need), with the printing denormalised beside the soft `card_id` exactly as
    /// `deck.rs` writes it — the *old* printing, which is what a merge has to refresh.
    fn deck_card(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        category_id: i64,
        quantity: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                (deck_id,category_id,card_id,set_code,collector_number,lang,name,quantity,
                 created_at,updated_at)
             VALUES (?1,?2,?3,'lea','161','en','Lightning Bolt',?4,unixepoch(),unixepoch())
             RETURNING id",
            rusqlite::params![deck_id, category_id, card_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A merge repoints the row *and* refreshes the printing denormalised beside it — the
    /// card the user owns is now known by a different id and, usually, a different set and
    /// number, and leaving the old ones would make the row describe a printing that no
    /// longer exists.
    #[test]
    fn a_merge_repoints_the_row_and_refreshes_its_printing() {
        let mut conn = seeded();
        let id = own(&conn, "old-id", "foil", 3);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!(stats.repointed, 1);
        let (card, set, cn, review): (String, String, String, Option<String>) = conn
            .query_row(
                "SELECT card_id, set_code, collector_number, needs_review
                 FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (card.as_str(), set.as_str(), cn.as_str()),
            ("new-id", "2ed", "162")
        );
        assert_eq!(review, None, "a repointed row needs no review");
    }

    /// The case a naive `UPDATE` gets wrong: the user already owns the printing the merge
    /// points at, at the same grain. Repointing would be a unique-constraint violation, so
    /// the two rows become one and the quantities add — a merge upstream is one card, not
    /// two.
    #[test]
    fn a_merge_onto_a_row_that_already_exists_folds_the_two_together() {
        let mut conn = seeded();
        let old = own(&conn, "old-id", "foil", 3);
        let existing = own(&conn, "new-id", "foil", 2);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE id = ?1",
                [existing],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 5, "three plus two, in the row that survived");
        let gone: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE id = ?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0, "and the folded row is gone, not duplicated");
    }

    /// The promise CLAUDE.md makes: a delete **flags**. The user paid for that card; a
    /// tracker that quietly removes it because an upstream database tidied its ids has
    /// destroyed the only record of it.
    #[test]
    fn a_delete_flags_the_row_and_never_removes_it() {
        let mut conn = seeded();
        let id = own(&conn, "gone-id", "nonfoil", 1);
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o9','gone-id','Vanished',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let stats = apply(&mut conn, &[migration("m2", "delete", "gone-id", None)]).unwrap();

        assert_eq!(stats.flagged, 2, "both tables");
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let review = review.expect("the row must be flagged");
        assert!(review.contains("2026-07-01"), "{review}");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "flagged, never deleted");
    }

    /// `/migrations` is a growing log that is re-read on every poll. Applying a merge twice
    /// would be harmless; applying a *fold* twice would double a quantity. The applied set
    /// is recorded, and this is what keeps the second poll a no-op.
    #[test]
    fn a_migration_that_has_already_been_applied_is_skipped() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 3);
        let m = [migration("m1", "merge", "old-id", Some("new-id"))];

        let first = apply(&mut conn, &m).unwrap();
        let second = apply(&mut conn, &m).unwrap();

        assert_eq!(first.repointed, 1);
        assert_eq!((second.repointed, second.folded, second.skipped), (0, 0, 1));
        let quantity: i64 = conn
            .query_row("SELECT sum(quantity) FROM collection_entries", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            quantity, 3,
            "a re-poll must not add cards to the collection"
        );
    }

    /// A merge into an id this database has never seen — Scryfall moved a card to a
    /// printing that arrives in a later bulk file. The row is repointed anyway (the id is
    /// the truth) but flagged, because until that card lands the row cannot be priced or
    /// pictured and the user should know why.
    #[test]
    fn a_merge_into_an_unknown_card_is_repointed_and_flagged() {
        let mut conn = seeded();
        let id = own(&conn, "old-id", "foil", 1);

        apply(
            &mut conn,
            &[migration("m3", "merge", "old-id", Some("not-here-yet"))],
        )
        .unwrap();

        let (card, review): (String, Option<String>) = conn
            .query_row(
                "SELECT card_id, needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(card, "not-here-yet");
        assert!(
            review.is_some(),
            "the user should know the card is not here"
        );
    }

    /// The half that does not need Scryfall's log at all: after every ingest, a row whose
    /// `card_id` no longer resolves is flagged, and one that resolves again is cleared.
    /// The second direction matters — a printing can come back (a bad bulk file, a
    /// re-added card), and a flag nobody can clear is a permanent scar.
    #[test]
    fn the_orphan_sweep_flags_what_vanished_and_clears_what_came_back() {
        let conn = seeded();
        let id = own(&conn, "new-id", "foil", 1);

        assert_eq!(
            sweep_orphans(&conn).unwrap(),
            (0, 0),
            "nothing is wrong yet"
        );

        conn.execute("DELETE FROM cards WHERE id = 'new-id'", [])
            .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap().0, 1);
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(review.unwrap().contains("card database"));

        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 1), "and it clears again");
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(review, None);
    }

    /// Scryfall asks applications not to make requests they do not need. A user with no
    /// rows has nothing to reconcile, so the poll does not happen at all.
    #[test]
    fn a_database_with_no_user_rows_is_not_worth_a_request() {
        let conn = seeded();
        assert!(user_data_is_empty(&conn));
        own(&conn, "new-id", "foil", 1);
        assert!(!user_data_is_empty(&conn));
    }

    /// An any-printing wish (spec §6) has no `card_id` at all, so there is no id to
    /// migrate and nothing to orphan. It must survive both halves untouched — a wishlist
    /// that flags every open wish as "not in the card database" has flagged the whole list.
    #[test]
    fn a_wish_for_any_printing_is_neither_repointed_nor_orphaned() {
        let mut conn = seeded();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1',NULL,'Lightning Bolt',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        apply(
            &mut conn,
            &[
                migration("m1", "merge", "old-id", Some("new-id")),
                migration("m2", "delete", "gone-id", None),
            ],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 0));

        let (card_id, review): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT card_id, needs_review FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(card_id, None, "an open wish is not pinned by a migration");
        assert_eq!(review, None);
    }

    /// The wishlist's own grain collision. A wish *has* a quantity — "three copies
    /// wanted" — so a duplicate produced by a repoint folds its quantity into the survivor
    /// exactly as `wishlist::add_wish` does. Dropping the row outright would shrink a
    /// shopping list the user never edited.
    #[test]
    fn a_merged_wish_folds_its_quantity_into_the_wish_already_there() {
        let mut conn = seeded();
        let wish = |card_id: &str, quantity: i64, notes: Option<&str>| -> i64 {
            conn.query_row(
                "INSERT INTO wishlist_entries
                    (oracle_id,card_id,name,quantity,preferred_finish,notes,created_at,updated_at)
                 VALUES ('o1',?1,'Lightning Bolt',?2,'foil',?3,unixepoch(),unixepoch())
                 RETURNING id",
                rusqlite::params![card_id, quantity, notes],
                |r| r.get(0),
            )
            .unwrap()
        };
        let old = wish("old-id", 3, Some("from the trade binder"));
        let target = wish("new-id", 2, None);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let (quantity, notes): (i64, Option<String>) = conn
            .query_row(
                "SELECT quantity, notes FROM wishlist_entries WHERE id = ?1",
                [target],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(quantity, 5, "three wanted plus two, not two");
        assert_eq!(
            notes.as_deref(),
            Some("from the trade binder"),
            "the folded row's note is kept when the survivor has none"
        );
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM wishlist_entries WHERE id = ?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// **The fold's target has to match the grain the `UPDATE OR IGNORE` above it collides
    /// on, and since schema v23 that grain is four terms.** A three-term target query can
    /// pick a wish in *another folder* — so a Scryfall id migration would sum the reader's
    /// filed wish into a row at the root, delete it, and leave the row it actually collided
    /// with untouched. A filing decision undone by an upstream tidy-up, with nothing red
    /// anywhere.
    ///
    /// **Every candidate row's final quantity is asserted, which is what makes this
    /// independent of the query plan.** [`fold_wish_into_existing`] uses `query_row` and
    /// therefore takes whichever candidate the planner yields first, so a test that pinned
    /// only the row it expected to win could be satisfied by the wrong row winning — and a
    /// future index would turn it vacuous with nothing going red. Pinning the target *and*
    /// the decoy leaves the fold nowhere to put the copies but the right row: land them at
    /// the root and the root assertion fails, land them nowhere and the target's does.
    ///
    /// The write order is a separate thing and is about the *pre-fix* failure being
    /// deterministic rather than about the assertions: the wish at the root goes in **first**,
    /// so both a rowid scan and a seek through `idx_wishlist_grain` — whose fourth column is
    /// `coalesce(folder_id, 0)`, and `0` sorts before `1` — reach it before the real collision
    /// in `Ordered`, which is what the three-term query was measured folding onto.
    #[test]
    fn a_repointed_wish_folds_only_onto_a_wish_in_its_own_folder() {
        let mut conn = seeded();
        conn.execute(
            "INSERT INTO wishlist_folders
                (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (1, NULL, 'Ordered', 0, unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let wish = |card_id: &str, folder: Option<i64>, quantity: i64| -> i64 {
            conn.query_row(
                "INSERT INTO wishlist_entries
                    (oracle_id,card_id,name,quantity,folder_id,created_at,updated_at)
                 VALUES ('o1',?1,'Lightning Bolt',?3,?2,unixepoch(),unixepoch())
                 RETURNING id",
                rusqlite::params![card_id, folder, quantity],
                |r| r.get(0),
            )
            .unwrap()
        };
        let elsewhere = wish("new-id", None, 1);
        let target = wish("new-id", Some(1), 2);
        let source = wish("old-id", Some(1), 3);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded, stats.flagged), (0, 1, 0));
        let quantity_of = |id: i64| -> i64 {
            conn.query_row(
                "SELECT coalesce(sum(quantity), 0) FROM wishlist_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            quantity_of(target),
            5,
            "the copies fold into the wish in the same folder, which is the row the \
             repoint actually collided with"
        );
        assert_eq!(
            quantity_of(elsewhere),
            1,
            "and not into the wish at the root, which was never in the way"
        );
        assert_eq!(quantity_of(source), 0, "the folded row is gone");
    }

    /// **The eleventh term, on the collection's side of the fold.** Every other grain column
    /// is identical between these three rows, so a [`collision_target`] spelling only the ten
    /// terms `COLLECTION_GRAIN` carried before schema v24 answers the row in the *other*
    /// folder — and the fold then sums the reader's filed copies into a binder they were never
    /// in, deletes the row that was there, and leaves the row that actually blocked the
    /// repoint standing. A filing decision undone by an upstream tidy-up, with nothing red and
    /// nothing in `error_log`: `fold_wish_into_existing` one table over already spells the
    /// term out, and this is the same trap on the table where a row is a card that exists.
    #[test]
    fn a_repointed_entry_folds_only_onto_an_entry_in_its_own_folder() {
        let mut conn = seeded();
        // **The id is taken rather than named.** It was a literal `1` until schema v25, which
        // files `Recently removed` into every database as its rung's first statement — so the
        // low ids belong to the app now, and naming one is a `UNIQUE constraint failed:
        // collection_folders.id` in a test that is not about folders being created at all.
        let binder: i64 = conn
            .query_row(
                "INSERT INTO collection_folders
                    (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
                 VALUES (NULL, 'Binder', 'user', NULL, 0, unixepoch(), unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let filed = |card_id: &str, folder: Option<i64>, quantity: i64| -> i64 {
            conn.query_row(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                     created_at,updated_at)
                 VALUES (?1,'lea','161','en','nonfoil','NM',?3,?2,unixepoch(),unixepoch())
                 RETURNING id",
                rusqlite::params![card_id, folder, quantity],
                |r| r.get(0),
            )
            .unwrap()
        };
        let elsewhere = filed("new-id", None, 1);
        let target = filed("new-id", Some(binder), 2);
        let source = filed("old-id", Some(binder), 3);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded, stats.flagged), (0, 1, 0));
        let quantity_of = |id: i64| -> i64 {
            conn.query_row(
                "SELECT coalesce(sum(quantity), 0) FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            quantity_of(target),
            5,
            "the copies fold into the entry in the same folder, which is the row the \
             repoint actually collided with"
        );
        assert_eq!(
            quantity_of(elsewhere),
            1,
            "and not into the row at the root, which was never in the way"
        );
        assert_eq!(quantity_of(source), 0, "the folded row is gone");
    }

    /// The repoint rewrites `lang` from the new printing, so the row it collides with is
    /// the one at the *new* language — matching on the source row's own language finds
    /// nothing, and "found nothing" used to mean the source row was deleted with its
    /// quantity. Three Japanese copies folding into an English row is odd; three copies
    /// vanishing is unacceptable.
    #[test]
    fn a_fold_across_languages_finds_the_row_the_repoint_would_have_collided_with() {
        let mut conn = seeded();
        let old: i64 = conn
            .query_row(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES ('old-id','lea','161','ja','foil','NM',3,unixepoch(),unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let target = own(&conn, "new-id", "foil", 2);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE id = ?1",
                [target],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 5, "the copies moved, they did not evaporate");
        let total: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM collection_entries WHERE id = ?1",
                [old],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    /// The guard that makes "never delete a user row" a property of the code rather than
    /// of the query being right: with no row to fold into, the fold reports failure and
    /// **leaves the source alone**. An unconditional delete here would be a quantity
    /// destroyed every time the grain comparison missed a term.
    #[test]
    fn a_fold_with_nowhere_to_fold_to_deletes_nothing() {
        let mut conn = seeded();
        let lonely = own(&conn, "old-id", "foil", 3);
        let tx = conn.transaction().unwrap();

        assert!(!fold_into_existing(&tx, lonely, "nobody-here", Some("en")).unwrap());

        let (rows, quantity): (i64, i64) = tx
            .query_row(
                "SELECT count(*), coalesce(sum(quantity),0) FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, quantity), (1, 3));
    }

    /// Every applied migration is written down, because the bookkeeping *is* the
    /// idempotency. A strategy this app does not know is recorded too — it did nothing,
    /// and looking at it again tomorrow would be no better informed.
    #[test]
    fn every_migration_considered_is_written_down_including_the_ones_it_could_not_act_on() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 1);

        let stats = apply(
            &mut conn,
            &[
                migration("m1", "merge", "old-id", Some("new-id")),
                migration("m2", "delete", "gone-id", None),
                migration("m3", "sideways", "odd-id", Some("new-id")),
                // A merge with a blank destination is a merge to nowhere: repointing a row
                // at `''` orphans it permanently.
                migration("m4", "merge", "old-id", Some("  ")),
            ],
        )
        .unwrap();

        assert_eq!(stats.skipped, 2, "the unknown strategy and the blank id");
        let recorded: Vec<(String, String, Option<String>)> = conn
            .prepare("SELECT id, strategy, note FROM card_migrations ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let ids: Vec<&str> = recorded.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "m3", "m4"], "all four are written down");
        assert_eq!(recorded[0].1, "merge");
        assert_eq!(recorded[1].1, "delete");
        // Stored as `merge` because the table's CHECK knows two strategies — but the row
        // must not *read* as a merge that happened, so the strategy Scryfall actually sent
        // goes in the note. A later version of this app that learns `sideways` can find
        // these rows; without the note there would be nothing left to find them by.
        assert_eq!(recorded[2].1, "merge");
        let note = recorded[2].2.as_deref().expect("the raw strategy is kept");
        assert!(note.contains("sideways"), "{note}");
        assert!(note.contains("nothing was applied"), "{note}");
        assert_eq!(recorded[3].1, "merge");
        // A known strategy carries Scryfall's own note and nothing invented.
        assert_eq!(recorded[0].2, None);
        // ...and the blank-id merge left the row where the real one had put it.
        let card: String = conn
            .query_row("SELECT card_id FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(card, "new-id");
    }

    /// A fold moves the copies *and the receipt*. What the user paid, in what currency,
    /// when, where from, and what they wrote about it are not derivable from anything —
    /// losing them because an upstream database tidied its ids is the same destruction as
    /// losing the row, in a smaller box. Survivor wins where it has an answer of its own,
    /// which is `collection::add_entry`'s `ON CONFLICT` rule verbatim.
    #[test]
    fn a_fold_carries_the_columns_the_user_typed_into_the_row_that_survives() {
        let mut conn = seeded();
        let detail =
            |card_id: &str, price: Option<f64>, source: Option<&str>, notes: Option<&str>| -> i64 {
                conn.query_row(
                    "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     tradelist_quantity,purchase_price,purchase_currency,acquired_at,
                     acquisition_source,notes,tags,condition_original,created_at,updated_at)
                 VALUES (?1,'lea','161','en','foil','NM',3,1,?2,'DKK','2019-04-02',?3,?4,
                         '[\"keep\"]','Near Mint',unixepoch(),unixepoch())
                 RETURNING id",
                    rusqlite::params![card_id, price, source, notes],
                    |r| r.get(0),
                )
                .unwrap()
            };
        // The survivor knows nothing about where it came from; the row folding into it does.
        let target: i64 = conn
            .query_row(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     tradelist_quantity,tags,created_at,updated_at)
                 VALUES ('new-id','2ed','162','en','foil','NM',2,0,'[]',unixepoch(),unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        detail(
            "old-id",
            Some(42.5),
            Some("Gamekeeper, Copenhagen"),
            Some("signed by the artist"),
        );

        apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        #[allow(clippy::type_complexity)]
        let (quantity, tradelist, price, currency, acquired, source, notes, tags, original): (
            i64,
            i64,
            Option<f64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT quantity, tradelist_quantity, purchase_price, purchase_currency,
                        acquired_at, acquisition_source, notes, tags, condition_original
                   FROM collection_entries WHERE id = ?1",
                [target],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!((quantity, tradelist), (5, 1));
        assert_eq!(price, Some(42.5));
        assert_eq!(currency.as_deref(), Some("DKK"));
        assert_eq!(acquired.as_deref(), Some("2019-04-02"));
        assert_eq!(source.as_deref(), Some("Gamekeeper, Copenhagen"));
        assert_eq!(notes.as_deref(), Some("signed by the artist"));
        // ...and the two `add_entry` leaves alone stay the survivor's, for its reasons: a
        // curated tag set is not something one statement should merge, and
        // `condition_original` is the provenance of a condition it was never written beside.
        assert_eq!(tags, "[]");
        assert_eq!(original, None);
    }

    /// The other direction of the same rule: a survivor that has its own answers keeps
    /// them. A fold is not an edit, and the row that was already there is not the one whose
    /// history is in doubt.
    #[test]
    fn a_fold_never_overwrites_what_the_surviving_row_already_recorded() {
        let mut conn = seeded();
        let insert = |card_id: &str, set: &str, cn: &str, price: f64, notes: &str| {
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     purchase_price,purchase_currency,acquisition_source,notes,
                     created_at,updated_at)
                 VALUES (?1,?2,?3,'en','foil','NM',1,?4,'USD',?5,?6,unixepoch(),unixepoch())",
                rusqlite::params![card_id, set, cn, price, notes, notes],
            )
            .unwrap();
        };
        insert("new-id", "2ed", "162", 10.0, "the one I kept");
        insert("old-id", "lea", "161", 99.0, "the one I am folding in");

        apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        let (price, notes): (f64, String) = conn
            .query_row(
                "SELECT purchase_price, notes FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            price, 10.0,
            "the survivor's own price is not up for revision"
        );
        assert_eq!(notes, "the one I kept");
    }

    /// Scryfall serves the log newest first, and chains are the case that breaks on: with
    /// A→B in 2021 and B→C in 2023, applying newest-first repoints B's rows to C and *then*
    /// moves A's rows to B — a dead id, recorded as applied, so the next poll never
    /// revisits it and the row waits behind a flag for a card that is never coming.
    ///
    /// Two defences stand behind that now, and this test is where the second one shows: the
    /// row makes the trip in **one** repoint rather than one per link, because [`final_id`]
    /// resolves the destination before the row is moved. (It read `2`, "one hop each", when
    /// the ordering was the only defence.) The dated chain never needed the resolution — the
    /// sort alone got it here — but it gets it anyway, and that is the point: correctness no
    /// longer depends on which of the two arrives first.
    #[test]
    fn a_chain_of_merges_delivered_newest_first_still_lands_on_the_last_id() {
        let mut conn = seeded();
        let id = own(&conn, "a-id", "foil", 2);

        let stats = apply(
            &mut conn,
            &[
                // The order the API gives them in.
                Migration {
                    performed_at: Some("2023-05-01T00:00:00Z".to_owned()),
                    ..migration("m2", "merge", "b-id", Some("new-id"))
                },
                Migration {
                    performed_at: Some("2021-03-01T00:00:00Z".to_owned()),
                    ..migration("m1", "merge", "a-id", Some("b-id"))
                },
            ],
        )
        .unwrap();

        let (card, review): (String, Option<String>) = conn
            .query_row(
                "SELECT card_id, needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            card, "new-id",
            "the chain was walked A→B→C, not B→C then A→B"
        );
        assert_eq!(
            review, None,
            "and it arrived on a card that exists, so nothing is owed to the user"
        );
        assert_eq!(
            stats.repointed, 1,
            "one hop, not one per link: A→C was resolved before the row was touched"
        );
    }

    /// The case the skip comment names, exercised rather than asserted: a *fold* applied
    /// twice is a quantity doubled, and the bookkeeping is the only thing preventing it.
    #[test]
    fn re_polling_a_fold_does_not_double_the_quantity() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 3);
        let target = own(&conn, "new-id", "foil", 2);
        let m = [migration("m1", "merge", "old-id", Some("new-id"))];

        let first = apply(&mut conn, &m).unwrap();
        let second = apply(&mut conn, &m).unwrap();
        let third = apply(&mut conn, &m).unwrap();

        assert_eq!(first.folded, 1);
        assert_eq!((second.folded, second.skipped), (0, 1));
        assert_eq!((third.folded, third.skipped), (0, 1));
        let (rows, quantity): (i64, i64) = conn
            .query_row(
                "SELECT count(*), sum(quantity) FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, quantity), (1, 5), "five, and five again");
        assert_eq!(
            conn.query_row(
                "SELECT quantity FROM collection_entries WHERE id = ?1",
                [target],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            5
        );
    }

    /// A delete flag says the printing is gone from Scryfall *for good*, and the sweep must
    /// not answer that with "but I can see it". It can: `/migrations` is polled after the
    /// sweep and before the bulk file that drops the card has rotated, so a flagged row
    /// whose card is still in `cards` is the ordinary state for a day. Clearing it there
    /// would erase the warning permanently — the migration is recorded and never reapplied.
    #[test]
    fn a_delete_flag_outlives_a_card_that_is_still_in_the_database() {
        let mut conn = seeded();
        let id = own(&conn, "new-id", "foil", 1);

        apply(&mut conn, &[migration("m1", "delete", "new-id", None)]).unwrap();
        // The card is still there — this is the day between the log and the bulk rotation.
        assert_eq!(
            sweep_orphans(&conn).unwrap(),
            (0, 0),
            "a delete flag is not the sweep's to clear"
        );

        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(review.unwrap().starts_with(DELETED_NOTE_PREFIX));

        // ...while an orphan flag the sweep wrote itself still clears the moment the card
        // is back, which is the whole reason the clear arm exists.
        conn.execute("DELETE FROM cards WHERE id = 'new-id'", [])
            .unwrap();
        conn.execute(
            "UPDATE collection_entries SET needs_review = NULL WHERE id = ?1",
            [id],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (1, 0));
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 1));
    }

    /// The first message wins, in both flag writers. A row already carrying a sentence is
    /// carrying the *earlier* thing that went wrong with it, and that is the one that
    /// explains how it got here.
    #[test]
    fn a_row_that_is_already_flagged_keeps_the_first_explanation() {
        let mut conn = seeded();
        let id = own(&conn, "gone-id", "foil", 1);
        conn.execute(
            "UPDATE collection_entries SET needs_review = 'looked at by hand' WHERE id = ?1",
            [id],
        )
        .unwrap();

        let stats = apply(&mut conn, &[migration("m1", "delete", "gone-id", None)]).unwrap();

        assert_eq!(stats.flagged, 0, "there was nothing left to say");
        let review: String = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(review, "looked at by hand");
    }

    /// A wish is keyed on its oracle card first of all, so a repoint that moved the
    /// printing and left the oracle id behind would strand it on a grain that describes
    /// nothing — invisible to the next wish for the same card, and counted against the
    /// wrong copies by the any-printing arm of the owned lookup.
    #[test]
    fn a_repointed_wish_takes_the_new_cards_oracle_id_with_it() {
        let mut conn = seeded();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('stale-oracle','old-id','Lightning Bolt',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        let (oracle, card, set): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT oracle_id, card_id, set_code FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(oracle.as_deref(), Some("o1"));
        assert_eq!(card.as_deref(), Some("new-id"));
        assert_eq!(set.as_deref(), Some("2ed"));
    }

    /// One transaction for the whole pass. A merge that failed halfway would leave some
    /// rows repointed, some not, and a `card_migrations` table claiming the lot was
    /// applied — so the next poll would never revisit them.
    #[test]
    fn a_pass_that_fails_leaves_neither_the_rows_nor_the_bookkeeping_behind() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 3);
        // The bookkeeping insert is what fails: a row that is already there is fine
        // (`INSERT OR IGNORE`), so the table is dropped instead — nothing in the pass can
        // then be recorded, and the whole transaction has to roll back.
        conn.execute("DROP TABLE card_migrations", []).unwrap();

        let err = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        );

        assert!(err.is_err(), "a pass that cannot record itself must fail");
        let card: String = conn
            .query_row("SELECT card_id FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(card, "old-id", "the repoint rolled back with the pass");
    }

    /// Deck rows are user rows: a merge repoints them, folding on the deck grain when the
    /// deck already runs the new printing in that category.
    ///
    /// The refreshed printing is asserted on the *repointed* row, because that is the row
    /// the refresh happens to: the fold's survivor keeps its own `set_code`/
    /// `collector_number`, which already describe the new card — `collection_entries`'
    /// fold makes exactly the same statement about exactly the same columns.
    #[test]
    fn a_merge_repoints_deck_cards_and_folds_same_category_collisions() {
        let mut conn = seeded();
        let burn = deck(&conn, "Burn");
        let main = category(&conn, burn, "main", "Main deck");
        let scratch = category(&conn, burn, "maybe", "Maybeboard");
        let source = deck_card(&conn, burn, "old-id", main, 3);
        let target = deck_card(&conn, burn, "new-id", main, 2);
        let maybe = deck_card(&conn, burn, "old-id", scratch, 1);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!(
            (stats.repointed, stats.folded),
            (1, 1),
            "the Maybeboard row moved, the main-deck row folded"
        );
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM deck_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            rows, 2,
            "one row per category, and the Maybeboard row is not one of them"
        );
        let (id, card, qty): (i64, String, i64) = conn
            .query_row(
                "SELECT id, card_id, quantity FROM deck_cards WHERE category_id = ?1",
                [main],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((id, card.as_str(), qty), (target, "new-id", 5));
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM deck_cards WHERE id = ?1",
                [source],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0,
            "the folded row is gone, not duplicated"
        );
        // `category_id` is part of the grain, so the same printing in the Maybeboard is a
        // different row with a different intention — it repoints on its own, printing and all.
        let (card, set, cn, name): (String, String, String, String) = conn
            .query_row(
                "SELECT card_id, set_code, collector_number, name FROM deck_cards WHERE id = ?1",
                [maybe],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (card.as_str(), set.as_str(), cn.as_str()),
            ("new-id", "2ed", "162")
        );
        assert_eq!(
            name, "Lightning Bolt",
            "a merge says two ids are one printing, not that the card is called something else"
        );
    }

    /// A delete **flags** a deck row too, and the sweep is the half that needs no log: a
    /// deck card whose printing left `cards` is flagged and cleared when it returns. The
    /// deck list keeps rendering the vanished printing's name throughout — that is what
    /// the denormalised `name` is for.
    #[test]
    fn a_delete_flags_deck_rows_and_the_sweep_clears_what_returns() {
        let mut conn = seeded();
        let burn = deck(&conn, "Burn");
        let main = category(&conn, burn, "main", "Main deck");
        let side = category(&conn, burn, "side", "Sideboard");
        let vanished = deck_card(&conn, burn, "gone-id", main, 2);
        let live = deck_card(&conn, burn, "new-id", side, 1);

        let stats = apply(&mut conn, &[migration("m2", "delete", "gone-id", None)]).unwrap();

        assert_eq!(
            stats.flagged, 1,
            "the third table is flagged like the other two"
        );
        let (review, rows): (Option<String>, i64) = conn
            .query_row(
                "SELECT needs_review, (SELECT count(*) FROM deck_cards)
                   FROM deck_cards WHERE id = ?1",
                [vanished],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(review.unwrap().contains("2026-07-01"));
        assert_eq!(rows, 2, "flagged, never deleted");

        conn.execute("DELETE FROM cards WHERE id = 'new-id'", [])
            .unwrap();
        assert_eq!(
            sweep_orphans(&conn).unwrap(),
            (1, 0),
            "the live row lost its printing; the flagged one keeps its first message"
        );
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM deck_cards WHERE id = ?1",
                [live],
                |r| r.get(0),
            )
            .unwrap();
        assert!(review.unwrap().contains("card database"));

        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 1), "and it clears again");
        let (cleared, kept): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT (SELECT needs_review FROM deck_cards WHERE id = ?1),
                        (SELECT needs_review FROM deck_cards WHERE id = ?2)",
                [live, vanished],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(cleared, None);
        assert!(
            kept.unwrap().starts_with(DELETED_NOTE_PREFIX),
            "a delete flag is not the sweep's to clear, on any table"
        );
    }

    /// A user who keeps decks and no collection still has card ids that Scryfall can
    /// migrate — without this the poll never happens and their deck lists rot quietly.
    #[test]
    fn a_database_whose_only_user_rows_are_decks_still_reconciles() {
        let conn = seeded();
        assert!(user_data_is_empty(&conn));
        let burn = deck(&conn, "Burn");
        // A deck with no cards names no printing the reconciler acts on: `deck_cards` is
        // where the card ids are, and `decks.cover_card_id` is not one this module touches.
        assert!(user_data_is_empty(&conn));
        deck_card(
            &conn,
            burn,
            "new-id",
            category(&conn, burn, "main", "Main deck"),
            1,
        );
        assert!(!user_data_is_empty(&conn));
    }

    /// Same-day chains (plan-3 carryover §4). `performed_at` is date-only, so A→B and B→C
    /// performed on ONE day arrive newest-first and the stable sort keeps them that way —
    /// order alone cannot save the row. Destinations resolve transitively instead.
    #[test]
    fn a_same_day_chain_lands_on_the_final_id() {
        let mut conn = seeded();
        let id = own(&conn, "a-id", "foil", 2);
        apply(
            &mut conn,
            &[
                Migration {
                    performed_at: Some("2026-07-01".into()),
                    ..migration("m2", "merge", "b-id", Some("new-id"))
                },
                Migration {
                    performed_at: Some("2026-07-01".into()),
                    ..migration("m1", "merge", "a-id", Some("b-id"))
                },
            ],
        )
        .unwrap();
        let card: String = conn
            .query_row(
                "SELECT card_id FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            card, "new-id",
            "resolved a→b→new through the map, not through the sort"
        );
    }
}
