//! Writing a merged result back — uid resolution, cycle-breaking, `needs_review`.
//!
//! Four things happen here and nothing else does:
//!
//! 1. **Ops already seen are dropped**, against `sync_peers`. Idempotence is the counter rule's
//!    other half: an op replayed after a reconnect must add its delta once.
//! 2. **A row is found by grain, then by uid, then inserted** — and where a grain match carries
//!    a different uid, both devices set the row's uid to `min(theirs, ours)`, which converges
//!    with no alias table — except onto a row this page deletes, whose uid the sender retired, so
//!    the incoming uid wins outright; and a group whose own ops end in a delete is found by its
//!    uid alone, never by grain. A folder's or a deck's delete that would clear rows out of
//!    it waits for the page's retry, then re-homes whatever is still filed there itself,
//!    merging each onto the root's twin under the lower uid ([`rehome`]).
//! 3. **Foreign uids become local ids.** A parent the device has never seen is a *deferral*, not
//!    an error.
//! 4. **Cycles are broken and `needs_review` is written.**
//!
//! # The row handle here is the `sync_uid`, not the rowid
//!
//! Every statement this module builds addresses a row by `WHERE sync_uid = ?`. Every synced
//! table but two has an `INTEGER PRIMARY KEY`, and those two have none at all — `muted_tags`
//! is `WITHOUT ROWID` on `(namespace, tag_id)` and `device_names` on `device_id` — so a rowid
//! would need a second spelling of every statement for both. The uid is `UNIQUE` on every one
//! and every row has one, which is what `schema::mint_missing_uids` and the capture trigger's
//! mint are between them for — plus `deck_tokens::convert_legacy_picks`, which names each entry it
//! derives from a v51 art pick `<pick uid>-<list>` itself, and first gives the pick the trigger's
//! own mint where a write behind `capture::suppressed` left it nameless. (This read "that rung's
//! own derived names" while user schema v52's rung did the converting; the conversion has been a
//! captured pass outside the ladder since the day it landed.)
//!
//! # Add-wins needs this device's own history, and `sync_ops` is where it is
//!
//! **Folding only the incoming ops answers the wrong question.** Two devices, A deletes a row
//! and B edits it concurrently; B pulls A's tombstone alone, folds a set of one, and deletes
//! the row — with B's edit gone and nothing anywhere to say so. That is precisely the silent
//! loss §7.3's add-wins rule exists to prevent, and it happens on the two-device group, which
//! is the ordinary one.
//!
//! So each group is folded **twice**: once over the incoming ops, and once over the incoming
//! ops plus this device's own ops for the same row out of `sync_ops`. The combined fold decides
//! whether the row exists and which side won each field; the incoming fold alone supplies the
//! counter deltas, because the local ones are already in the row and adding them again is the
//! doubling this whole module is arranged to prevent.
//!
//! **This is why a pushed op is kept rather than deleted.** `client` stamps `pushed_at` and
//! leaves the row: the op log is also this device's memory of what it did, and a device that
//! pruned it would lose every argument it could have made for keeping a row.
//!
//! What it does **not** cover is a third device: B has no local ops for a row C edited, so
//! A's tombstone and C's edit only meet if they arrive in one batch. The relay hands them over
//! in hybrid-logical-clock order, so the common case orders itself; the residual is a sparse
//! edit arriving after a tombstone, which cannot rebuild the row it edits and is **skipped** as
//! a row this database cannot build — the next section's table.
//!
//! # A deferral says why, and only what can still apply holds its device
//!
//! `sync_peers` is a *watermark*: everything at or below it has been applied or given up on. So
//! an op that may still apply cannot be counted and stepped over — advancing past it would lose
//! it for good, and not advancing would replay the ops above it and **add their counter deltas
//! a second time**. Both are silent. So the watermark stops at the last op before a device's
//! first held one, that device's later ops in the page are left unapplied, and
//! [`ApplyReport::deferred`] says so. **What the watermark buys is that a re-delivery is
//! safe**: the ops at or below it are skipped, so a page handed over twice applies each counter
//! delta once.
//!
//! **Holding is not free, which is why only some deferrals hold.** The client holds its pull
//! cursor while anything here is held, the relay compacts nothing above that cursor's ack, and a
//! hold on something that can never resolve would pin the group's log for good. So every group
//! `write_group` cannot write says why, and the reason and its sender decide what happens
//! (spec 2026-09-27 §3.2):
//!
//! | The group | Class | Holds its device? | Recorded? |
//! | --- | --- | --- | --- |
//! | Names a parent deleted in this page, or anywhere a delete has ever reached this device — a `sync_gone` row — whose delete cascades to it | moot | no | no |
//! | Any reason, and an op in it was sealed by a **newer** schema ([`Op::schema`]) | held · newer | yes, with no bound | no — the panel says it |
//! | An unknown parent, from a same or older schema | held · waiting | yes, until [`Waiting::Release`] | when released |
//! | An unknown table, or a row this database cannot build, from a same or older schema | dropped | no | yes |
//! | Collateral: a later op of a held device | its block's | — | — |
//!
//! **Moot is asked first**, because a deleted parent is a fact about this device that no
//! upgrade changes. **It is moot only where the delete would have taken the child with it**:
//! a parent whose key is `SET NULL` — a binder, a deck folder, a label — is not a deferral at
//! all when it is gone, and the child is written without it, which is what the child's own
//! device does to it when the delete arrives there. **A moot row this device already holds goes
//! too**, where the group's placement under the deleted parent is the one that stands: that is
//! what the delete's cascade does to it on the device that sent the group. **A folder included**,
//! whose rows are re-homed at the root first, as a delete's are; the `sync_gone` row its delete
//! leaves is what lands a later child of it here the way it lands on the sender. **Both answers
//! are given only on a retry pass that follows one on which nothing landed**
//! ([`Why::DecidedOnRetry`], `run_groups`), so a parent that any group of the same page brings
//! back through add-wins — however late in the page, or however many passes it waits — is found
//! instead, and the group is written as any other. A moot or dropped group is *consumed*: it holds nothing, the
//! ops after it apply, and the watermark passes it.
//! `client::pull` holds `PULL_CURSOR` while either held count is non-zero, so the relay hands the
//! page back, and ends a waiting hold at its bound by applying the page once more with
//! [`Waiting::Release`]. [sync.md](../../../docs/reference/sync.md) is the record.

use crate::sync_engine::capture::{self, Absent, Parent, Spec};
use crate::sync_engine::hlc::Hlc;
use crate::sync_engine::merge::{fold, Horizon, Kind, Op, Resolved};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};

/// What a resurrected row is told to say.
///
/// [`crate::reconcile`]'s register: a sentence a reader can act on, never a code, and never a
/// reason to delete the row.
pub const RESURRECTED: &str =
    "Another device deleted this while this one was still changing it, so it was kept.";

/// What a folder that lost a cycle-break is told to say.
pub const CYCLE_BROKEN: &str = "A folder move on another device would have put this folder \
     inside itself. It was moved to the top level.";

/// What one call to [`apply`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// Ops written into the reader's tables **by this call**. A re-delivered op already below
    /// its device's watermark is `skipped`, never counted here a second time.
    pub applied: usize,
    /// Rows a delete lost the race for — §7.4's first surfaced outcome, and an **event**
    /// rather than a state: a row that is *in* a resurrected condition is counted by the batch
    /// that put it there and by no later one.
    pub resurrected: usize,
    /// Folders returned to the root because a concurrent move made a loop.
    pub cycles_broken: usize,
    /// Ops at or below a peer's watermark, and ops this device wrote itself. Already applied,
    /// by definition.
    pub skipped: usize,
    /// Ops held for re-delivery — `held_newer + held_waiting`, collateral included. **The device
    /// that wrote them is held at the first of them**: its watermark stays below it and its
    /// later ops in this batch are left unapplied, so the page the client's held cursor brings
    /// back applies them exactly once. See the module doc.
    pub deferred: usize,
    /// Of `deferred`, the ops in a group a newer schema sealed, and the ops held behind one.
    /// Upgrading this device resolves them and nothing else does, so no bound releases them.
    pub held_newer: usize,
    /// Of `deferred`, the ops in a group whose parent a later page may still bring, and the ops
    /// held behind one. [`Waiting::Release`] gives up on them.
    pub held_waiting: usize,
    /// Ops consumed because they name a parent deleted in this page, or anywhere a delete has
    /// reached this device, whose delete cascades to them. The convergent outcome — the delete
    /// would have taken the child with it on any device that held both — and recorded nowhere. **A
    /// row this device already holds under the group's uid is deleted with it**, when the group's
    /// placement under that parent is the one the fold says stands: a peer that moved the row
    /// there loses it to the delete's cascade, and so does this device. Where this device placed
    /// the row somewhere later it is left alone, because that move reaches the peer too — though
    /// what the peer then holds depends on its own history: it applies the delete first, parents
    /// before children, and the move rebuilds the row there only if it holds the row's insert. A
    /// folder is deleted this way too, its rows re-homed at the root first; see
    /// `cascade_onto_the_row_here`.
    pub moot: usize,
    /// Ops consumed because nothing that can arrive will let them apply: a table this build does
    /// not sync, a row it cannot build, or a released wait. Each group is an `error_log` row
    /// under `Source::Relay`, folded on its table, and holds nothing behind it.
    pub dropped: usize,
}

/// What [`apply_with`] does with a group whose parent has not arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    /// Hold it, and every later op of its device, for re-delivery. The ordinary cause resolves
    /// itself on the sender's next trip: a first contact pushes a child ahead of the baseline
    /// that carries its parent.
    Hold,
    /// Give up on it — skip and record it as [`ApplyReport::dropped`], so the ops behind it
    /// apply. The client decides when, by its bound; a group a newer schema sealed is held
    /// either way, because an upgrade can still resolve it.
    Release,
}

// ---------------------------------------------------------------------------------------
// What the applier has to know about a table that the capture spec does not say
// ---------------------------------------------------------------------------------------

/// One `?` in a grain predicate, and where its value comes from.
enum Source {
    Field(&'static str),
    Parent(&'static str),
}

/// A table's logical grain: its own UNIQUE index with every foreign local id replaced by that
/// parent's `sync_uid`.
///
/// **A minted uid alone cannot be a row's identity**, and the counter rule is what proves it:
/// two devices each adding one copy of the same printing mint two uids, and inserting both is
/// two rows at +1 rather than one row at +2 — plus a violation of `idx_collection_grain`.
/// **A grain alone cannot either**: `decks`, `deck_folders`, `wishlist_folders` and
/// `deck_audit` have no unique index, so two devices' folders named "Binder" are two folders
/// and must stay two.
///
/// # A table can have more than one, and three of them are PARTIAL
///
/// The plan this was built from lists one grain per table and calls `collection_folders`
/// uid-only. It has **two**, and both are partial unique indexes rather than the ordinary kind:
/// `idx_collection_folder_removed` is `UNIQUE (kind) WHERE kind = 'removed'` and
/// `idx_collection_folder_deck` is `UNIQUE (deck_id) WHERE deck_id IS NOT NULL`. Every database
/// seeds its own `Recently removed` folder, so **two paired devices hold that row under two
/// uids from the moment they meet** — and a uid-only rule would try to insert a second one and
/// fail the index forever. `deck_categories` has a second as well:
/// `idx_deck_categories_kind`, `UNIQUE (deck_id, kind) WHERE kind <> 'main'`.
///
/// A partial index needs no new machinery, because the `WHERE` clause can be written into the
/// predicate: `kind = ? AND kind = 'removed'` matches the one holding area when the incoming row
/// is one and matches nothing when it is not. The grains are tried in order and the first hit
/// wins.
struct Grain {
    /// The `WHERE` clause, one `?` per source, matching the table's own UNIQUE index verbatim
    /// — **including a partial index's own `WHERE`**, folded into the predicate.
    predicate: &'static str,
    sources: &'static [Source],
}

/// What a counter's own `CHECK` means when a delta takes it to or below zero.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Floor {
    /// `CHECK (quantity >= 0)` — `collection_entries`. A stepper taken to zero is a real state
    /// there: the row keeps its condition, its price, its tags and its acquisition story while
    /// the reader owns none of that printing today.
    Clamp,
    /// `CHECK (quantity > 0)` — `deck_cards` and `wishlist_entries`, where zero copies is not
    /// a row. The schema's two spellings differ on purpose and an applier using one rule for
    /// both would either raise a constraint failure on a deck card taken to zero or leave a
    /// collection row it should have kept.
    DeleteAtZero,
}

struct Meta {
    table: &'static str,
    /// **Parents before children**, so a folder is in the database before the row filed in it.
    /// Causality plus the hybrid logical clock already order a parent before its child *within*
    /// one device's stream — a device cannot reference a folder it has not seen — so this
    /// matters for a batch that mixes two devices' streams, and for the first pull a new device
    /// makes.
    order: u8,
    grains: &'static [Grain],
    counters: &'static [(&'static str, Floor)],
    /// `created_at` / `updated_at`. `deck_audit` and `muted_tags` carry their own stamp
    /// (`at`, `muted_at`) as an ordinary field and have neither column.
    timestamps: bool,
    /// Whether the table can hold a sentence for the reader at all. Eleven of the seventeen
    /// cannot: `decks`, `deck_categories`, `deck_labels`, `deck_tokens`, `deck_token_printings`,
    /// `deck_notes`, `deck_note_cards`, `deck_audit`, `muted_tags`, `device_names` and
    /// `sticky_notes`.
    needs_review: bool,
    /// The self-referencing column a cycle can form on, for the three folder tables.
    tree: Option<&'static str>,
}

const META: [Meta; 17] = [
    Meta {
        table: "deck_folders",
        order: 0,
        grains: &[],
        counters: &[],
        timestamps: true,
        needs_review: true,
        tree: Some("parent_id"),
    },
    Meta {
        table: "decks",
        order: 1,
        grains: &[],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_categories",
        order: 2,
        grains: &[
            Grain {
                predicate: "deck_id = ? AND name = ?",
                sources: &[Source::Parent("deck"), Source::Field("name")],
            },
            // `idx_deck_categories_kind`, and the `WHERE kind <> 'main'` is in the predicate:
            // a deck has one Sideboard, one Commander, one Companion and one Maybeboard, and a
            // renamed one would slip past the grain above.
            Grain {
                predicate: "deck_id = ? AND kind = ? AND kind <> 'main'",
                sources: &[Source::Parent("deck"), Source::Field("kind")],
            },
        ],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_labels",
        order: 3,
        grains: &[Grain {
            predicate: "name_key = ?",
            sources: &[Source::Field("name_key")],
        }],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_cards",
        order: 4,
        grains: &[Grain {
            predicate: "deck_id = ? AND variant = ? AND category_id = ? AND card_id = ? \
                        AND coalesce(finish, '') = coalesce(?, '')",
            sources: &[
                Source::Parent("deck"),
                Source::Field("variant"),
                Source::Parent("category"),
                Source::Field("card_id"),
                Source::Field("finish"),
            ],
        }],
        counters: &[("quantity", Floor::DeleteAtZero)],
        timestamps: true,
        needs_review: true,
        tree: None,
    },
    Meta {
        table: "deck_audit",
        order: 5,
        grains: &[],
        counters: &[],
        timestamps: false,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "collection_folders",
        order: 6,
        // **Two partial unique indexes, and the plan called this table uid-only.** Every
        // database seeds its own `Recently removed`, so two paired devices hold that row under
        // two uids from the moment they meet; and a deck's group folder is one per deck, made
        // by whichever device created the deck.
        grains: &[
            Grain {
                predicate: "kind = ? AND kind = 'removed'",
                sources: &[Source::Field("kind")],
            },
            Grain {
                predicate: "deck_id = ? AND deck_id IS NOT NULL",
                sources: &[Source::Parent("deck")],
            },
        ],
        counters: &[],
        timestamps: true,
        needs_review: true,
        tree: Some("parent_id"),
    },
    Meta {
        table: "collection_entries",
        order: 7,
        grains: &[Grain {
            predicate: "card_id = ? AND finish = ? AND condition = ? AND lang = ? \
                        AND altered = ? AND signed = ? AND proxy = ? AND misprint = ? \
                        AND coalesce(serial_number, '') = coalesce(?, '') \
                        AND coalesce(grading, '') = coalesce(?, '') \
                        AND coalesce(folder_id, 0) = coalesce(?, 0)",
            sources: &[
                Source::Field("card_id"),
                Source::Field("finish"),
                Source::Field("condition"),
                Source::Field("lang"),
                Source::Field("altered"),
                Source::Field("signed"),
                Source::Field("proxy"),
                Source::Field("misprint"),
                Source::Field("serial_number"),
                Source::Field("grading"),
                Source::Parent("folder"),
            ],
        }],
        counters: &[
            ("quantity", Floor::Clamp),
            ("tradelist_quantity", Floor::Clamp),
        ],
        timestamps: true,
        needs_review: true,
        tree: None,
    },
    Meta {
        table: "wishlist_folders",
        order: 8,
        grains: &[],
        counters: &[],
        timestamps: true,
        needs_review: true,
        tree: Some("parent_id"),
    },
    Meta {
        table: "wishlist_entries",
        order: 9,
        grains: &[Grain {
            predicate: "coalesce(oracle_id, '') = coalesce(?, '') \
                        AND coalesce(card_id, '') = coalesce(?, '') \
                        AND coalesce(preferred_finish, '') = coalesce(?, '') \
                        AND coalesce(folder_id, 0) = coalesce(?, 0)",
            sources: &[
                Source::Field("oracle_id"),
                Source::Field("card_id"),
                Source::Field("preferred_finish"),
                Source::Parent("folder"),
            ],
        }],
        counters: &[("quantity", Floor::DeleteAtZero)],
        timestamps: true,
        needs_review: true,
        tree: None,
    },
    Meta {
        table: "muted_tags",
        order: 10,
        grains: &[Grain {
            predicate: "namespace = ? AND tag_id = ?",
            sources: &[Source::Field("namespace"), Source::Field("tag_id")],
        }],
        counters: &[],
        timestamps: false,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "device_names",
        order: 11,
        // **The grain is the device id, and it is `sqlite_autoindex_device_names_1` read as a
        // predicate**: the table is `WITHOUT ROWID` on `device_id`, so its primary key IS its
        // unique index. Two devices that each filed a name for the same peer — which is what
        // pairing itself leaves behind — hold one row for it under two uids, so without this
        // grain the far op is not a row to update but a row to insert: it hits that primary key,
        // the group's savepoint rolls back, and the op is skipped as a row this database cannot
        // build. Measured by emptying this list: both convergence tests go red and neither name
        // moves.
        grains: &[Grain {
            predicate: "device_id = ?",
            sources: &[Source::Field("device_id")],
        }],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_tokens",
        // **Appended rather than slotted in behind `decks`, and 12 is after 1.** The rank is
        // read by [`super::baseline::build`] through [`order_of`] and is only ever *sorted* by,
        // so what it has to say is "after the deck this row hangs off" — which any number above
        // 1 says. Renumbering the tail to put this at 2 would move ten ranks to change nothing
        // an emission can observe, and `baseline`'s hard failure is on a *missing* rank rather
        // than on a gap or an order.
        order: 12,
        // `idx_deck_tokens_grain`, restating `schema::DECK_TOKEN_GRAIN` as a predicate. It is
        // owed for `deck_labels`' reason: two devices that each picked an art for the same
        // token in the same deck hold one row under two uids, so without this the far op is not
        // a row to update but a row to insert — which hits the unique index, rolls the group's
        // savepoint back, and skips that op as a row this database cannot build.
        //
        // **`deck_id` comes from the parent and `oracle_id` from the field**, because a local
        // deck id means nothing on the far device while an oracle id is Scryfall's and means
        // the same thing everywhere.
        grains: &[Grain {
            predicate: "deck_id = ? AND oracle_id = ?",
            sources: &[Source::Parent("deck"), Source::Field("oracle_id")],
        }],
        // **No counter, so no `Floor`** — `quantity` is nullable and travels as a field, which
        // `super::capture`'s spec argues at length. A stored zero is a token the reader zeroed
        // and is information; there is no arithmetic here that could produce one by accident.
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_notes",
        // Appended rather than slotted in, `deck_tokens`' reason: the rank is only ever
        // sorted by, so what it has to say is "after the deck this row hangs off".
        order: 13,
        // **No grain, deliberately.** Two devices each typing a note about the mana base
        // must stay two notes, and there is no column pair that could tell an accidental
        // duplicate from a deliberate one. Uid-only, like `decks` and the folder tables.
        grains: &[],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_note_cards",
        // After `deck_notes`, which is the parent this row hangs off.
        order: 14,
        // **A grain here for the opposite reason to the table above.** Two devices attaching
        // one card to one note describe *one* fact; without this the far op is an insert that
        // lands beside the local row and the card modal reads two notes for one.
        grains: &[Grain {
            predicate: "note_id = ? AND oracle_id = ?",
            sources: &[Source::Parent("note"), Source::Field("oracle_id")],
        }],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "sticky_notes",
        // Appended rather than slotted in, `deck_tokens`' and `deck_notes`' reason: the rank is
        // only ever *sorted* by, and this row hangs off nothing at all, so there is no parent it
        // has to land behind and any number does. Renumbering the tail to give it a tidier one
        // would move fifteen ranks to change nothing an emission can observe.
        order: 15,
        // **No grain, deliberately** — `deck_notes`' argument verbatim, and this table is the
        // stronger case for it. Two devices each typing a note about the same thing must stay
        // two notes, and there is no column pair that could tell an accidental duplicate from a
        // deliberate one: the title may be empty on both, and `color` and `sort_order` say
        // nothing about identity. Uid-only, like `deck_notes`, `decks` and the folder tables.
        grains: &[],
        counters: &[],
        timestamps: true,
        // No `needs_review` column on the table, so there is nowhere to put a sentence — and
        // nothing to say one about. Every field here is last-writer-wins prose the reader can
        // read for themselves, and the conflict a sentence exists to report (a row deleted on
        // one device and edited on another) resolves add-wins with the note still in front of
        // them.
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_token_printings",
        // Appended rather than slotted in behind `decks`, `deck_tokens`' reason: the rank is only
        // ever *sorted* by, so what it has to say is "after the deck this row hangs off", which
        // any number above 1 says. Renumbering the tail for a tidier one moves ranks to change
        // nothing an emission can observe.
        order: 16,
        // `idx_deck_token_printings_grain`, restating `schema::DECK_TOKEN_PRINTING_GRAIN` as a
        // predicate, and owed for `deck_tokens`' reason: two devices that each add the same
        // printing, in the same finish, to the same list hold one row under two uids, so without
        // this the far op is not a row to update but a row to insert — which hits the unique
        // index, rolls the group's savepoint back and skips that op as a row this database
        // cannot build.
        //
        // **`deck_id` from the parent and the other three from the fields**, because a local
        // deck id means nothing on the far device, while a list name, a Scryfall printing id and
        // a finish word mean the same thing everywhere. **No `coalesce`**, unlike `deck_cards`'
        // grain above: `finish` is NOT NULL here, so `=` is the index's own test.
        grains: &[Grain {
            predicate: "deck_id = ? AND variant = ? AND card_id = ? AND finish = ?",
            sources: &[
                Source::Parent("deck"),
                Source::Field("variant"),
                Source::Field("card_id"),
                Source::Field("finish"),
            ],
        }],
        // **No counter, so no `Floor`**, although the column is NOT NULL and could carry a delta:
        // the count is a setting, which `super::capture`'s spec argues, and a stored zero is a
        // token's last entry the reader stepped down — kept on purpose, never arithmetic's
        // accident.
        counters: &[],
        timestamps: true,
        // No `needs_review` column on the table. An entry whose printing leaves the corpus is an
        // orphan drawn from the row's own `oracle_id`, not a conflict to report.
        needs_review: false,
        tree: None,
    },
];

fn meta_of(table: &str) -> Option<&'static Meta> {
    META.iter().find(|m| m.table == table)
}

/// A synced table's parents-first rank, so [`super::baseline`] emits in the order this module
/// sorts by and a first sync is one pass rather than several.
///
/// The rank is [`Meta::order`] and there is deliberately no second list: a baseline emitted in
/// an order this module disagrees with would defer every child on the first pull, which is
/// slow rather than wrong and therefore the kind of thing nobody reports.
pub(crate) fn order_of(table: &str) -> Option<u8> {
    meta_of(table).map(|m| m.order)
}

fn spec_of(table: &str) -> Option<&'static Spec> {
    capture::TABLES.iter().find(|s| s.table == table)
}

/// A JSON value as SQLite sees it.
///
/// A bool becomes an integer, because every boolean column in this schema is `INTEGER NOT NULL
/// DEFAULT 0` and SQLite has no boolean type. An array or an object would be a column holding
/// JSON as **text** — `tags`, `grading`, `payload` — and the capture trigger already ships those
/// as strings, so this arm is a fence rather than a case.
fn sql_value(v: &serde_json::Value) -> Sql {
    match v {
        serde_json::Value::Null => Sql::Null,
        serde_json::Value::Bool(b) => Sql::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        serde_json::Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

/// What happened to one row's worth of ops.
enum Outcome {
    Written,
    /// Not written, and why — which, with who sealed it, is what [`classify`] decides from.
    Deferred(Why),
}

/// Why a group could not be written.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Why {
    /// A table this build does not sync. From a newer device it is a table an upgrade brings;
    /// from a same or older one it is a table this build renamed or dropped (`deck_tags` at
    /// v33), and nothing will ever resolve it. Only the sender's [`Op::schema`] tells them apart.
    UnknownTable,
    /// A non-soft parent this database has never seen, by the uid the op names it with.
    UnknownParent { table: &'static str, uid: String },
    /// The row could not be written: a `NOT NULL`, `CHECK` or `UNIQUE` failure, or a grain
    /// match that would move a row onto a uid another row wears. The constraint's own words,
    /// kept for the record, where they were once discarded.
    Unbuildable(String),
    /// Not decided yet, because what the page does to the group is only known once other groups
    /// have landed. Two things answer it (spec 2026-09-27 §3.3):
    ///
    /// - **A delete that would clear rows out of a folder**, on the first attempt only, so the
    ///   page's own re-filing of them lands first; any retry pass decides it.
    /// - **A group naming a parent [`gone`] says was deleted**, whether its key cascades (moot) or
    ///   is `SET NULL` (written without it), on the first attempt and on every
    ///   [`Attempt::Retry`] pass — decided only on an [`Attempt::Decide`] pass, which follows a
    ///   pass on which nothing landed, so any group of the page that brings the parent back
    ///   through add-wins has landed first, however late, and the parent is resolved again and
    ///   found. It is also what makes the moot arm's own delete of a folder wait for the page's
    ///   re-filing, one level up.
    ///
    /// **Never classified**, short of the loop's cap: a withheld group is on every pass until it
    /// is decided, `run_groups` stops only on a pass that withheld nothing, and it keeps only
    /// each group's last answer. (Were one ever to reach [`classify`], it would be read like
    /// [`Why::Unbuildable`]: held where a newer schema sealed the group, and dropped through the
    /// final `match`'s `_` otherwise.)
    DecidedOnRetry,
}

impl Why {
    /// What a skip's `error_log` detail says after the row's uid.
    fn text(&self) -> String {
        match self {
            Why::UnknownTable => "this version does not sync that table".to_owned(),
            Why::UnknownParent { table, uid } => {
                format!("the {table} row {uid} it belongs to never arrived")
            }
            Why::Unbuildable(e) => e.clone(),
            Why::DecidedOnRetry => "decided on the page's retry".to_owned(),
        }
    }
}

/// Which attempt at a group this is. `run_groups` tries every group once, then again for the
/// ones that did not land on retry passes — after every other group in the page, which is what
/// lets a delete that would clear rows wait for the sender's own re-filing, and a child of a
/// deleted parent wait for a same-page resurrection of it ([`Why::DecidedOnRetry`], spec
/// 2026-09-27 §3.3). `run_groups` says which kind of retry pass runs next, and when they stop.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Attempt {
    /// Every group once, in page order.
    First,
    /// A retry pass on which a decision resting on [`gone`] is still withheld, because the pass
    /// before it landed something and the page may yet bring the parent back.
    Retry,
    /// A retry pass after one on which nothing landed: whatever the page could write without a
    /// gone-based decision it has written, so this one takes those decisions — moot or `SET NULL`.
    Decide,
}

/// What a group a pass did not write becomes — the module doc's table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    /// Held, because a newer schema sealed it and upgrading this device can resolve it.
    Newer,
    /// Held, for a parent a later page may still bring.
    Waiting,
    /// Consumed silently: its parent was deleted — in this page, or anywhere a delete has reached
    /// this device — and the delete cascades.
    Moot,
    /// Consumed and recorded: nothing that can arrive will let it apply.
    Dropped,
}

impl Class {
    /// Whether the group holds its device — the two classes that go to [`blocks_of`] and keep
    /// the watermark below them. The other two are consumed.
    fn holds(self) -> bool {
        matches!(self, Class::Newer | Class::Waiting)
    }
}

/// A group a pass did not write, and what became of it.
struct Deferral<'a> {
    group: &'a Group<'a>,
    class: Class,
    /// `None` for collateral, which sits behind a block and is never attempted.
    why: Option<Why>,
}

/// device → the stamp it is held at, and the class of the group that holds it there.
type Blocks = BTreeMap<String, (Hlc, Class)>;

/// What a committed pass left held: each held device, at the stamp of its first held op as
/// `(ms, ctr)`. **This is what a client's hold is a hold on** — `client::pull` stores it in
/// `pull_hold`, and a block it has not seen before starts the waiting bound over, so a wait that
/// has run its course cannot take a new one down with it.
pub type Held = BTreeMap<String, (i64, i64)>;

/// One row's worth of incoming ops, folded, with the ops kept for the watermark.
struct Group<'a> {
    table: &'a str,
    ops: Vec<&'a Op>,
    /// The fold of the incoming ops alone. Counters come from here.
    resolved: Resolved,
}

/// Apply a batch of ops from other devices, holding every group whose parent has not arrived.
///
/// [`apply_with`] with [`Waiting::Hold`], which is every caller but the client's release.
pub fn apply(conn: &Connection, ops: &[Op]) -> Result<ApplyReport, String> {
    apply_with(conn, ops, Waiting::Hold)
}

/// Apply a batch of ops from other devices, saying of each group it did not write why not.
///
/// The whole batch is one transaction wrapped in [`capture::suppressed`], so nothing written
/// here is captured back into `sync_ops` — without that guard two devices ping-pong an op
/// forever. A dropped group's `error_log` row is written inside the same transaction, so a
/// batch that fails leaves no record of a skip it never made.
pub fn apply_with(conn: &Connection, ops: &[Op], waiting: Waiting) -> Result<ApplyReport, String> {
    apply_held(conn, ops, waiting).map(|(report, _)| report)
}

/// [`apply_with`], answering as well which devices the committed pass left held, and where —
/// the one caller that needs it is the client, which holds its cursor on exactly those.
pub fn apply_held(
    conn: &Connection,
    ops: &[Op],
    waiting: Waiting,
) -> Result<(ApplyReport, Held), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let out = capture::suppressed(&tx, || apply_in(&tx, ops, waiting))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

fn apply_in(
    conn: &Connection,
    ops: &[Op],
    waiting: Waiting,
) -> Result<(ApplyReport, Held), String> {
    let mut report = ApplyReport::default();
    let me: Option<String> = conn
        .query_row(
            "SELECT device_id FROM sync_identity WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let watermarks = read_watermarks(conn)?;

    // **The horizon filters this batch and writes nothing.** Spec §9.1: raising `sync_peers`
    // instead is wrong twice — it would suppress the baseline itself, whose ops are stamped
    // from each row's `updated_at` and therefore sit BELOW the emitter's own top stamp; and a
    // watermark write is durable, so a `del` below the horizon would be skipped now and never
    // offered again, leaving this device holding a row the group deleted.
    //
    // Only the first op of each baseline batch carries one (§9), and a page can hold two
    // batches, so whatever is found is unioned.
    let mut horizon = Horizon::default();
    for op in ops {
        if let Some(h) = &op.horizon {
            horizon.absorb(h);
        }
    }

    // 1. Everything already seen, and everything this device wrote itself.
    //
    // **Our own ops are dropped rather than applied**, and the relay is not trusted to have
    // done it: a counter is not idempotent, so one of this device's own `+1`s coming back
    // would be a card appearing out of nothing.
    let mut fresh: Vec<&Op> = Vec::new();
    for op in ops {
        let mine = me.as_deref() == Some(op.at.device.as_str());
        let seen = watermarks
            .get(&op.at.device)
            .is_some_and(|w| stamp(op) <= *w);
        // Exemptions in spec §9.1's table: a baseline op describes the horizon rather than
        // being described by it, and a tombstone is the one thing a claim cannot express.
        let inside = op.kind == Kind::Put && !op.baseline && horizon.covers(&op.at);
        if mine || seen || inside {
            report.skipped += 1;
        } else {
            fresh.push(op);
        }
    }

    // 2. One group per logical row, in an order that puts parents first.
    let mut groups = group(&fresh);
    groups.sort_by_key(|g| {
        (
            meta_of(g.table).map_or(u8::MAX, |m| m.order),
            g.ops.iter().map(|o| o.at.clone()).min(),
        )
    });

    // Every row a delete in this page names, the ones already seen included: a re-delivered
    // page still carries the delete that makes a child moot, even once the delete itself is
    // below its sender's watermark.
    let deleted: BTreeSet<(&str, &str)> = ops
        .iter()
        .filter(|op| op.kind == Kind::Del)
        .map(|op| (op.table.as_str(), op.uid.as_str()))
        .collect();

    // 3. Apply, discovering as it goes which devices stall — and then apply again with the
    //    stalls known.
    //
    // **The second pass is not an optimisation, it is the whole correctness of the watermark.**
    // `sync_peers` only advances to the last op before a device's first unappliable one, and
    // that is what makes a re-delivery of everything above it safe. If this pass had *applied*
    // the ops after the block, a re-delivery would apply them a second time — and a counter
    // applied twice is the collection growing by itself. Measured before the fix: one `+1` after
    // a blocked op became a quantity of 2 on the second delivery of the same page.
    //
    // **Only a held group blocks** (the module doc's table): a moot or dropped one is consumed
    // in whichever round finds it and stops nothing behind it.
    //
    // The loop runs until no new device is found to be blocked, which is at most once per
    // device and in practice once. Each round rolls its own work back, so only the last one
    // commits.
    let cap = groups.len().min(8);
    let mut blocked: Blocks = BTreeMap::new();
    let mut committed: Vec<Deferral> = Vec::new();
    for round in 0..=cap {
        conn.execute_batch("SAVEPOINT sync_pass")
            .map_err(|e| e.to_string())?;
        let mut pass = ApplyReport::default();
        let deferrals = run_groups(conn, &groups, &blocked, &deleted, waiting, &mut pass)?;
        let found = blocks_of(&deferrals, &blocked);
        if found == blocked || round == cap {
            // At the cap `found` names blocks this pass did not honour — it applied ops above
            // them — so nothing after this reads `found`: the watermarks are advanced from what
            // this pass did ([`advance_watermarks`]).
            conn.execute_batch("RELEASE sync_pass")
                .map_err(|e| e.to_string())?;
            report.applied = pass.applied;
            report.resurrected = pass.resurrected;
            report.cycles_broken = pass.cycles_broken;
            committed = deferrals;
            break;
        }
        conn.execute_batch("ROLLBACK TO sync_pass; RELEASE sync_pass")
            .map_err(|e| e.to_string())?;
        blocked = found;
    }

    for d in &committed {
        let n = d.group.ops.len();
        match d.class {
            Class::Newer => report.held_newer += n,
            Class::Waiting => report.held_waiting += n,
            Class::Moot => report.moot += n,
            Class::Dropped => report.dropped += n,
        }
    }
    report.deferred = report.held_newer + report.held_waiting;

    // Recorded only for the pass that committed — a round rolled back skipped nothing — and
    // after it settled, so each group is one row however many rounds met it.
    for d in committed.iter().filter(|d| d.class == Class::Dropped) {
        let why = d.why.as_ref().map_or_else(String::new, Why::text);
        crate::errors::record(
            conn,
            crate::errors::Source::Relay,
            "apply",
            crate::errors::Kind::Other,
            &format!(
                "a change to {} from another device could not be applied and was skipped",
                d.group.table
            ),
            Some(&format!("uid {} · {why}", d.group.ops[0].uid)),
        );
    }

    advance_watermarks(conn, &groups, &committed)?;
    observe(conn, fresh.iter().map(|o| &o.at).max())?;
    // Read off the pass that committed, as the watermarks were: at the round cap the blocks the
    // last round found are not the ones it honoured.
    let held: Held = blocks_of(&committed, &Blocks::new())
        .into_iter()
        .map(|(device, (at, _))| (device, (at.ms, at.ctr)))
        .collect();
    Ok((report, held))
}

#[cfg(test)]
thread_local! {
    /// The most retry passes any `run_groups` call has made since a test last reset it — what the
    /// fixed-point loop's tests read, so a loop that ran to its cap cannot pass for one that
    /// stopped. Per thread, as each test runs on its own; test-only, like
    /// `rehome::CASCADES_INTO_FOLDERS`.
    static RETRY_PASSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// One attempt at a batch, with the devices already known to be stalled cut short.
///
/// Answers the groups it could not apply, each classified. Everything else — the soft parent,
/// the cycle-break — happens here too, because a round that is going to be rolled back must not
/// leave any of it behind.
///
/// # Every group once, then retry passes to a fixed point
///
/// The first attempt takes every group in page order. The groups that did not land are then
/// retried, in page order, on **retry passes**, of two kinds:
///
/// - **[`Attempt::Retry`]** writes what it can and **withholds every decision resting on
///   [`gone`]** — the moot arm and the `SET NULL` arm both answer [`Why::DecidedOnRetry`] and go
///   round again.
/// - **[`Attempt::Decide`]** runs only after a pass on which **nothing landed**, and takes those
///   decisions. A decision is progress in its own right — a moot delete and its tombstone, or a
///   row written without its parent — so the loop goes on with `Retry` passes after it.
///
/// A pass that wrote something is followed by a `Retry`; one that wrote nothing but withheld a
/// decision is followed by a `Decide`; one that did neither ends the loop. A group whose parent is
/// unknown and not gone goes round again; every other answer is final. **Only the last answer a
/// group gave is classified**, so a hold is decided by the page as it finally stood.
///
/// **Why a decision waits for a pass on which nothing landed.** The group that brings a deleted
/// parent back through add-wins can land later than the child that names the parent — later in
/// the same pass, or on a later pass because it waits on a parent of its own. `b` holds `X` and
/// deletes `P`; `a` moves `X` under `P`, renames `P`, makes `Outer` and moves `P` into it. The
/// page meets `X`, `P`, `Outer`; `P` waits on `Outer` on the first attempt and is resurrected on
/// the first retry pass — after `X` was met on it. Decided on that pass, `X` was deleted as moot
/// and lost for good (`a_folder_moved_under_a_parent_resurrected_on_a_retry_pass_follows_it`, and
/// `a_copy_filed_into_a_binder_resurrected_on_a_later_retry_pass_stays_in_it` for the `SET NULL`
/// arm two passes in). A pass on which nothing landed is one after which no group of this page can
/// land without a gone-based decision, so no resurrection is still to come.
///
/// **Why more than one pass at all.** A child can be met before the parent it waits on has been
/// decided. `a` renames `X`, makes `Z` under a `P` this device deleted, and moves `X` into `Z`:
/// `X`'s group sorts ahead of `Z`'s, its oldest op being older than `Z`'s creation, so `X` asks
/// after `Z` while `Z` is unknown and not yet gone; `Z` is tombstoned as moot on a `Decide` pass,
/// and only a later pass finds `X` under a parent that is gone. With one retry `X` was held, and
/// the release dropped `X`'s ops while this device kept `X` and `a`'s cascade took it
/// (`a_folder_moved_into_one_made_under_a_parent_deleted_here_goes_on_both`). Retrying the
/// withheld groups before the others instead answers that and breaks the opposite order
/// (`a_copy_filed_into_a_binder_the_same_page_brings_back_stays_in_it`); going round again is
/// right in both, because a group waiting on an unknown parent writes nothing.
///
/// **The cap is twice the page's group count plus one, and it is never reached.** Every pass that
/// lands or decides something takes at least one group out of the waiting set for good, and the
/// passes between two of those are at most one: a `Retry` that landed nothing is followed by a
/// `Decide` that either decides something or ends the loop. So there are at most two passes per
/// failed group, and one to find that nothing moves. The cap is there so a mistake in that
/// reasoning is a pass too many rather than a hang. **The cost** is two passes for each link of
/// the longest chain of waiting groups, over only the groups still waiting; a page with nothing
/// withheld and nothing waiting pays the one retry it always paid.
fn run_groups<'a>(
    conn: &Connection,
    groups: &'a [Group<'a>],
    blocked: &Blocks,
    deleted: &BTreeSet<(&str, &str)>,
    waiting: Waiting,
    report: &mut ApplyReport,
) -> Result<Vec<Deferral<'a>>, String> {
    let mut soft: Vec<(&Group, String)> = Vec::new();
    let mut out: Vec<Deferral<'a>> = Vec::new();
    let mut failed: Vec<&'a Group<'a>> = Vec::new();
    for g in groups {
        if let Some(class) = held_by(g, blocked) {
            out.push(Deferral {
                group: g,
                class,
                why: None,
            });
            continue;
        }
        if let Outcome::Deferred(_) =
            write_group(conn, g, report, &mut soft, deleted, Attempt::First)?
        {
            failed.push(g);
        }
    }
    // Retry passes, because a batch can carry a child before its parent even when one device's
    // own stream cannot: the relay hands over several devices' streams interleaved. They are also
    // what every decision resting on `gone` waits for ([`Why::DecidedOnRetry`]) — and not merely
    // the first of them, but the first on which nothing else is still landing. The doc above says
    // why, how many there can be, and when they stop.
    let cap = 2 * groups.len() + 1;
    let mut last: Vec<Option<Why>> = failed.iter().map(|_| None).collect();
    let mut pending: Vec<usize> = (0..failed.len()).collect();
    let mut passes = 0;
    let mut attempt = Attempt::Retry;
    while !pending.is_empty() {
        passes += 1;
        let mut progressed = false;
        let mut withheld = false;
        let mut again: Vec<usize> = Vec::new();
        for i in pending {
            match write_group(conn, failed[i], report, &mut soft, deleted, attempt)? {
                Outcome::Written => {
                    last[i] = None;
                    progressed = true;
                }
                Outcome::Deferred(why) => {
                    match &why {
                        // A gone-based decision withheld on a `Retry` pass: it waits for a
                        // `Decide` one.
                        Why::DecidedOnRetry => {
                            withheld = true;
                            again.push(i);
                        }
                        // An unknown parent that is gone was the moot arm, which decided the
                        // group; one that is not gone may yet be written or tombstoned by a group
                        // a later pass lands, so it goes round again.
                        Why::UnknownParent { table, uid } => {
                            if gone(conn, table, uid, deleted)? {
                                progressed = true;
                            } else {
                                again.push(i);
                            }
                        }
                        _ => {}
                    }
                    last[i] = Some(why);
                }
            }
        }
        if passes >= cap {
            break;
        }
        attempt = match (progressed, withheld) {
            // Something landed, so a parent the page brings back may land next: keep withholding.
            (true, _) => Attempt::Retry,
            // Nothing landed and gone-based decisions are waiting: the page has done all it can
            // without them, so take them.
            (false, true) => Attempt::Decide,
            // Nothing landed and nothing is withheld — whatever still waits, waits on a parent the
            // page does not carry.
            (false, false) => break,
        };
        pending = again;
    }
    #[cfg(test)]
    RETRY_PASSES.with(|c| c.set(c.get().max(passes)));
    // **Only the last answer a group gave is kept**, since it is the one the page settled on — in
    // page order, as the groups were met.
    for (g, why) in failed.into_iter().zip(last) {
        if let Some(why) = why {
            out.push(Deferral {
                group: g,
                class: classify(conn, g, &why, deleted, waiting)?,
                why: Some(why),
            });
        }
    }

    // The soft parent — `decks.default_category_id` — after both passes, because `decks` and
    // `deck_categories` name each other and no order of tables resolves both in one.
    for (g, uid) in &soft {
        settle_soft_parents(conn, g, uid)?;
    }

    // §7.3 row 4's second half. LWW decided *where* each folder went; only the whole tree can
    // say whether the result is a loop.
    for m in META.iter().filter(|m| m.tree.is_some()) {
        report.cycles_broken += break_cycles(conn, m, groups)?;
    }
    Ok(out)
}

/// The hold a group sits behind, if any op of it is at or above its device's block.
///
/// **Newer wins where two holds meet**: collateral behind both clears only when both do, and
/// only the newer one waits on something no bound releases.
fn held_by(g: &Group, blocked: &Blocks) -> Option<Class> {
    let mut held = None;
    for op in &g.ops {
        if let Some((at, class)) = blocked.get(op.at.device.as_str()) {
            if op.at >= *at {
                if *class == Class::Newer {
                    return Some(Class::Newer);
                }
                held = Some(*class);
            }
        }
    }
    held
}

/// What an unwritten group becomes — the module doc's table, asked in its order.
///
/// **Moot before newer**: a newer device's child of a parent deleted here, held as newer, would
/// wait for an upgrade that cannot help it, and pin the relay's log until then.
fn classify(
    conn: &Connection,
    g: &Group,
    why: &Why,
    deleted: &BTreeSet<(&str, &str)>,
    waiting: Waiting,
) -> Result<Class, String> {
    if let Why::UnknownParent { table, uid } = why {
        if gone(conn, table, uid, deleted)? {
            return Ok(Class::Moot);
        }
    }
    // `>` on the `Option`, so an op a build before the field sealed — `None` — is never newer.
    let newer = Some(crate::schema::USER_SCHEMA_VERSION);
    if g.ops.iter().any(|op| op.schema > newer) {
        return Ok(Class::Newer);
    }
    Ok(match (why, waiting) {
        (Why::UnknownParent { .. }, Waiting::Hold) => Class::Waiting,
        _ => Class::Dropped,
    })
}

/// Whether a parent this database cannot find was deleted: in this page, or anywhere a delete has
/// ever reached this device — the reader's own, a peer's applied here, and every row a cascade
/// took with either, which is what `sync_gone` records (spec 2026-09-27 §3.1). One primary-key
/// read.
///
/// **One source for all of them**, so an own delete and an applied one are asked the same way.
/// Until user schema v53 this read a `del` in this device's own `sync_ops`, and a delete a peer
/// made left nothing there — `apply` runs inside `capture::suppressed`, and so does every cascade
/// it sets off — so a child of it arriving on a later page waited out the bound and was dropped,
/// recorded, while its own device kept it at the root where the key is `SET NULL` (§1.2). The
/// tombstone trigger ignores that guard, which is its point. **A delete applied here before the
/// v53 rung left no row**, since the rung backfills only this device's own `del`s, and is still
/// read as missing.
fn gone(
    conn: &Connection,
    table: &str,
    uid: &str,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<bool, String> {
    if deleted.contains(&(table, uid)) {
        return Ok(true);
    }
    conn.query_row(
        "SELECT 1 FROM sync_gone WHERE tbl = ?1 AND uid = ?2",
        [table, uid],
        |_| Ok(()),
    )
    .optional()
    .map(|hit| hit.is_some())
    .map_err(|e| e.to_string())
}

/// A group made moot by a cascading parent that is gone, about a row **this device already
/// holds**: delete that row, as the delete's cascade does on the device that sent the group — but
/// only when the group's placement under that parent is the one that stands. **Called only on an
/// [`Attempt::Decide`] pass**, like every decision resting on [`gone`] ([`Why::DecidedOnRetry`]):
/// that pass follows one on which nothing landed, so the page's own re-filing of the rows filed in
/// a folder has landed, and so has any group of the page that brings the parent back — which
/// `resolve_parent` then finds, and this is never reached.
///
/// A peer moves a card into a pile deleted here. On the peer the card is in that pile when the
/// delete arrives, and the cascade takes it; consuming the move here and touching nothing left the
/// card in its old pile on this device alone (the final review of the delivery holds). **The fold
/// over this device's own history decides whether the placement stands**: where this device moved
/// the row somewhere later, that move reaches the peer too, and deleting the row here would lose
/// one the peer may keep. ⚠️ **What the peer keeps is not order-free**: its applier takes a page
/// parents first, so a delete and a later move of the same row in one page cascade the row before
/// the move is attempted, and the move rebuilds it there only where that device's own history
/// holds the row's insert — otherwise the move is a row it cannot build, skipped, and the two
/// differ the other way (sync.md, *Held while it can resolve, skipped when it cannot*).
///
/// **A folder goes too, and the rows filed in it are re-homed first**, by the delete arm's own
/// merge ([`rehome`]) and for its reasons: whatever is still filed there once the page's re-filing
/// has landed is merged at the root one row at a time before the `DELETE`, whose `SET NULL` then
/// has nothing to act on. The delete arm waits for its retry on its own account; this one needs no
/// wait of its own, because it only ever runs on a `Decide` pass — it had one until the whole moot
/// decision moved to the retry, and two dragged-copy tests pin that the wait still happens
/// (`a_copy_dragged_onto_a_…_root_twin_out_of_a_binder_moved_under_a_deleted_one_lands_once`).
/// **Until user schema v53 a table any capture spec names as a parent was
/// excluded here**, and the reason was `gone`: this delete is uncaptured and is no delete in the
/// page, so while `gone` read only this device's own `sync_ops` it could not see it, and a peer
/// that moved a folder under one deleted here and then filed a deck in it found the deck waiting
/// on a folder nothing said was gone — the release dropped the deck and every card in it, where on
/// the peer the same delete cascades the folder and `SET NULL` puts the deck at the root (the
/// scoped re-review of this delete). So the folder was consumed and left standing, and what this
/// device had filed into it stayed filed here alone. **The tombstones end that**: this `DELETE`
/// writes a `sync_gone` row like any other, so the peer's later children of the folder land here
/// the way the folder's key answers a delete, as they do there (spec 2026-09-27 §3.2).
///
/// **A row that is not here is tombstoned by hand**, where rows are filed under its table
/// ([`tombstone`]): a `DELETE` that finds nothing fires no trigger, and a folder a peer made under
/// a parent deleted here — consumed as moot on its first page — would leave the peer's next
/// filing into it waiting on a folder nothing said was gone, while the peer's cascade puts that
/// filing at the root. Written on the first attempt, as it was for one fix round, it sent a child
/// in the same page to the root before a later group brought the parent back, and the retry then
/// built the folder under that parent — the child at the root here and in the folder on the peer
/// (`a_folder_made_under_a_parent_the_same_page_brings_back_keeps_its_copy`).
///
/// Inside the pass's savepoint, like every other write of a round, so a round that is rolled back
/// takes the delete with it. **A delete this database refuses — the read of the doomed rows and
/// the re-homing included — leaves the row where it is**, which is what the moot arm did before it
/// deleted anything: a refusal that escaped would fail the apply on every pull after.
fn cascade_onto_the_row_here(
    conn: &Connection,
    meta: &Meta,
    g: &Group,
    p: &Parent,
) -> Result<(), String> {
    let uid = &g.ops[0].uid;
    let mut all: Vec<Op> = g.ops.iter().map(|o| (*o).clone()).collect();
    all.extend(local_history(conn, meta.table, std::slice::from_ref(uid))?);
    let combined = fold(&all);
    let placed = g.resolved.parents.get(p.key).map(|(_, at)| at);
    let stands = combined.parents.get(p.key).map(|(_, at)| at);
    if placed.is_none() || placed != stands {
        return Ok(());
    }
    conn.execute_batch("SAVEPOINT sync_moot_row")
        .map_err(|e| e.to_string())?;
    let done = rehome::doomed(conn, meta.table, uid)
        .and_then(|d| rehome::rehome(conn, &d))
        .and_then(|()| {
            conn.execute(
                &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                [uid],
            )
            .map_err(|e| e.to_string())
        })
        .and_then(|n| match n {
            0 => tombstone(conn, meta.table, uid),
            _ => Ok(()),
        });
    let end = match done {
        Ok(()) => "RELEASE sync_moot_row",
        Err(_) => "ROLLBACK TO sync_moot_row; RELEASE sync_moot_row",
    };
    conn.execute_batch(end).map_err(|e| e.to_string())
}

/// Record a delete of a row this device does not hold, where `table` is one other rows are filed
/// under — `capture::parent_tables`, the set the tombstone trigger is installed on, so the two
/// cannot disagree about which tables are recorded. Any other table is a no-op.
///
/// **The trigger records every delete that finds a row, and only those**: a delete of a row that
/// is not here runs no `DELETE`, or one that takes nothing, and fires nothing. Two such deletes
/// still say a parent is gone, and a child of it on a later page would otherwise wait out the
/// bound: the delete arm's, of a parent a third device made and deleted between two of this
/// device's pulls (spec 2026-09-27 §3.1, as amended), and the moot arm's, which runs only on a
/// `Decide` pass, of a folder a peer made under one deleted here. `OR IGNORE`, so a second delete
/// of one uid — a re-delivery included — writes nothing.
fn tombstone(conn: &Connection, table: &str, uid: &str) -> Result<(), String> {
    if !capture::parent_tables().contains(&table) {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO sync_gone (tbl, uid) VALUES (?1, ?2)",
        [table, uid],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Whether deleting the row `p` names deletes the `table` row that names it — `ON DELETE
/// CASCADE`, as against `SET NULL`.
///
/// **Read off the live schema and not restated on [`Parent`]**, so it cannot drift from the key
/// it describes. It is asked only of a parent [`gone`] has already found deleted, which is rare,
/// so the pragma costs nothing a pull would notice. A column with no foreign key answers no.
fn cascades(conn: &Connection, table: &str, p: &Parent) -> Result<bool, String> {
    conn.query_row(
        "SELECT on_delete FROM pragma_foreign_key_list(?1) WHERE \"from\" = ?2",
        [table, p.col],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map(|action| action.as_deref() == Some("CASCADE"))
    .map_err(|e| e.to_string())
}

/// The earliest stamp each device is stalled at, taking whatever was already known.
///
/// **Only a group that holds blocks**; a moot or dropped one is consumed and stops nothing. A
/// device inherits the class of the group whose op is its earliest, and collateral carries the
/// class of the hold it sits behind, so a device dragged in behind a newer block is newer too.
fn blocks_of(deferrals: &[Deferral], known: &Blocks) -> Blocks {
    let mut out = known.clone();
    for d in deferrals.iter().filter(|d| d.class.holds()) {
        for op in &d.group.ops {
            match out.entry(op.at.device.clone()) {
                std::collections::btree_map::Entry::Vacant(v) => {
                    v.insert((op.at.clone(), d.class));
                }
                std::collections::btree_map::Entry::Occupied(mut o) => {
                    if op.at < o.get().0 {
                        o.insert((op.at.clone(), d.class));
                    }
                }
            }
        }
    }
    out
}

/// Pull this device's clock past the latest stamp in the batch.
///
/// **This is what makes the clock causal, and without it last-writer-wins is a lottery.** A
/// device that applied a peer's op and then wrote its own would stamp the second one from a
/// clock that had never heard of the first — so an edit made *after* seeing another device's
/// could sort *before* it, and the older value would win on every machine.
///
/// It is [`super::hlc::Hlc::observe`] spelled in SQL, in the one place where the alternative is
/// worse: reading a wall clock in Rust means `SystemTime::now()`, which **panics on
/// `wasm32-unknown-unknown`**, and this module compiles for the web target.
fn observe(conn: &Connection, top: Option<&Hlc>) -> Result<(), String> {
    let Some(top) = top else {
        return Ok(());
    };
    conn.execute(
        "UPDATE sync_clock SET
             ms = max(ms, ?1, cast(unixepoch('subsec') * 1000 AS INTEGER)),
             ctr = CASE
                 WHEN cast(unixepoch('subsec') * 1000 AS INTEGER) > max(ms, ?1) THEN 0
                 WHEN ms = ?1 THEN max(ctr, ?2) + 1
                 WHEN ms > ?1 THEN ctr + 1
                 ELSE ?2 + 1
             END
           WHERE id = 1",
        rusqlite::params![top.ms, top.ctr],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn stamp(op: &Op) -> Hlc {
    op.at.clone()
}

fn read_watermarks(conn: &Connection) -> Result<BTreeMap<String, Hlc>, String> {
    let mut stmt = conn
        .prepare("SELECT device_id, last_ms, last_ctr FROM sync_peers")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let device: String = r.get(0)?;
            Ok((
                device.clone(),
                Hlc {
                    ms: r.get(1)?,
                    ctr: r.get(2)?,
                    device,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        out.insert(k, v);
    }
    Ok(out)
}

fn group<'a>(ops: &[&'a Op]) -> Vec<Group<'a>> {
    let mut by_row: BTreeMap<(&str, &str), Vec<&'a Op>> = BTreeMap::new();
    for op in ops {
        by_row
            .entry((op.table.as_str(), op.uid.as_str()))
            .or_default()
            .push(op);
    }
    by_row
        .into_iter()
        .map(|((table, _), ops)| {
            let owned: Vec<Op> = ops.iter().map(|o| (*o).clone()).collect();
            Group {
                table,
                resolved: fold(&owned),
                ops,
            }
        })
        .collect()
}

/// Resolve `key` to a local row id, or say which of the two ways it failed.
enum Resolution {
    Id(i64),
    /// The op says "nobody" — the root, or Auto.
    None,
    /// The op names a uid this database has never seen — this one.
    Unknown(String),
}

fn resolve_parent(
    conn: &Connection,
    p: &Parent,
    resolved: &Resolved,
) -> Result<Resolution, String> {
    let Some((uid, _)) = resolved.parents.get(p.key) else {
        return Ok(Resolution::None);
    };
    let Some(uid) = uid else {
        return Ok(Resolution::None);
    };
    let id: Option<i64> = conn
        .query_row(
            &format!("SELECT id FROM {} WHERE sync_uid = ?1", p.table),
            [uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match id {
        Some(id) => Resolution::Id(id),
        None => Resolution::Unknown(uid.clone()),
    })
}

fn absent_value(p: &Parent) -> Sql {
    match p.absent {
        Absent::Null => Sql::Null,
        Absent::Zero => Sql::Integer(0),
    }
}

/// Find the local row this group is about: by grain, then by uid. **It reads and never writes.**
///
/// Where a grain match carries a different uid, **both devices set the row's uid to the lower of
/// the two**. That converges with no alias table and no round trip: each side computes the same
/// `min` from the same pair, so after one exchange they agree, and the next round finds the row
/// by uid rather than by grain.
///
/// The rename is *answered* ([`Found::rename`]) and made by [`adopt_uid`], inside the group's
/// savepoint. It used to run here, before that savepoint opened and with nothing asking whether
/// the lower uid was free — so a grain match onto a uid another local row wore failed
/// `idx_{table}_uid`, the `?` unwound the whole batch, and the same page failed the same way on
/// every pull after it.
///
/// # Onto a row this page deletes, the incoming uid wins outright
///
/// Where the row the grain finds wears a uid a `del` in this page names — `deleted`, which
/// [`apply_in`] builds from the whole page, re-delivered deletes included — the sender **retired**
/// that uid: it deleted the row and made this one in its place at the same grain. `min` is the
/// wrong question there. `reset::clear_collection` deletes every folder and re-makes
/// `Recently removed` and one group per deck in one write, and both are grained (partially, on
/// `kind = 'removed'` and on `deck_id`), so on a peer whose old folders still hold copies the old
/// rows' deletes wait for the retry ([`Why::DecidedOnRetry`]) while the re-made rows' inserts land on
/// the old rows. Kept by `min` wherever the old uid sorted lower, the retried delete then took
/// the very row the insert had just landed on, and the peer lost its holding area or a deck's
/// group with nothing recorded (spec 2026-09-27 §3.3, as amended). Under the incoming uid the
/// retried delete finds no row to take. [`adopt_uid`]'s taken-check still applies.
///
/// # A group whose own ops end in a delete is found by its uid alone
///
/// The other half of the same fact. Where the group's **own** incoming ops fold to deleted
/// ([`Group::resolved`]), the sender made that row and discarded it, so its delete can only ever
/// mean a row wearing that uid — and a grain match could only hand it a row this device keeps.
/// Two ways that happened, both a row deleted with nothing recorded: `reset::clear_collection`
/// run twice between two pulls (or a deck switched to Virtual and back twice) sends `del R`,
/// `put R'` + `del R'`, `put R''` on one partial grain, and on the retry the `R'` group grain-hit
/// `R''`, adopted by `min` and deleted it; and a copy a sender added and removed again grain-hit
/// a copy of that printing the peer had made itself, and deleted that. So no grain is asked, and
/// a row not wearing the uid is simply not this group's to delete — a baseline put and a later
/// delete of it in one first-contact page included, which leaves the peer's own twin standing on
/// purpose.
///
/// **Keyed on the group's own fold, and not on the page's delete set**, which is `deleted`'s
/// other use above: a row deleted and put back in one page — an edit on a third device beating
/// the delete, add-wins — names its uid in a `del` and still folds to a row that exists. That
/// group grain-matches like any put, so a twin this device made on its own meets it as one row;
/// found by its uid alone it inserted beside the twin and was dropped as unbuildable
/// (`a_row_deleted_and_put_back_in_one_page_still_meets_its_twin`).
fn find_row(
    conn: &Connection,
    meta: &Meta,
    g: &Group,
    parents: &BTreeMap<&'static str, Sql>,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<Found, String> {
    let op_uid = g.ops[0].uid.clone();
    let grains: &[Grain] = if g.resolved.deleted { &[] } else { meta.grains };
    for grain in grains {
        if let Some(values) = grain_values(grain, g, parents) {
            let found: Option<String> = conn
                .query_row(
                    &format!(
                        "SELECT sync_uid FROM {} WHERE {}",
                        meta.table, grain.predicate
                    ),
                    rusqlite::params_from_iter(values.iter()),
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(found) = found {
                if found != op_uid {
                    let retired = deleted.contains(&(meta.table, found.as_str()));
                    let winner = if retired {
                        op_uid.clone()
                    } else {
                        found.clone().min(op_uid.clone())
                    };
                    let rename = (winner != found).then(|| (found.clone(), winner.clone()));
                    return Ok(Found {
                        uid: Some(winner),
                        displaced: Some(found),
                        rename,
                    });
                }
                return Ok(Found {
                    uid: Some(found),
                    displaced: None,
                    rename: None,
                });
            }
        }
    }
    let by_uid: Option<String> = conn
        .query_row(
            &format!("SELECT sync_uid FROM {} WHERE sync_uid = ?1", meta.table),
            [&op_uid],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(Found {
        uid: by_uid,
        displaced: None,
        rename: None,
    })
}

/// The row a group is about, and the uid it used to wear.
///
/// `displaced` matters because this device's own ops for that row are filed in `sync_ops` under
/// the **old** uid: adopting `min` renames the row and cannot rename history that has already
/// been pushed.
struct Found {
    /// The uid the row wears once [`adopt_uid`] has run.
    uid: Option<String>,
    displaced: Option<String>,
    /// `(from, to)`: the uid the row wears now, and the lower one it is to adopt.
    rename: Option<(String, String)>,
}

/// Give the found row the uid [`find_row`] decided on — **inside the group's savepoint, and only
/// once nothing else here wears it.** Taken, the group is a row this database cannot build: two
/// local rows each hold half of what the op describes, and no uid adoption reconciles that.
fn adopt_uid(conn: &Connection, meta: &Meta, found: &Found) -> Result<(), Why> {
    let Some((from, to)) = &found.rename else {
        return Ok(());
    };
    let unbuildable = |e: rusqlite::Error| Why::Unbuildable(e.to_string());
    let taken = conn
        .query_row(
            &format!("SELECT 1 FROM {} WHERE sync_uid = ?1", meta.table),
            [to],
            |_| Ok(()),
        )
        .optional()
        .map_err(unbuildable)?
        .is_some();
    if taken {
        return Err(Why::Unbuildable("uid taken".to_owned()));
    }
    conn.execute(
        &format!(
            "UPDATE {} SET sync_uid = ?1 WHERE sync_uid = ?2",
            meta.table
        ),
        [to, from],
    )
    .map(|_| ())
    .map_err(unbuildable)
}

/// This device's own ops for a row, out of `sync_ops`.
///
/// Several uids, because a row can have worn more than one: the op's, the local row's, and
/// whichever `min` displaced. Ops are only ever written for this device's own writes — an
/// apply runs inside [`capture::suppressed`] — so no filter on `device_id` is needed and one
/// would be wrong the day a peer's device id collided with a table name.
fn local_history(conn: &Connection, table: &str, uids: &[String]) -> Result<Vec<Op>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let holes: Vec<String> = (2..=uids.len() + 1).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "{} WHERE tbl = ?1 AND uid IN ({})",
        capture::OPS_SELECT,
        holes.join(", ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&table];
    for u in uids {
        params.push(u);
    }
    let rows = stmt
        .query_map(params.as_slice(), capture::op_from_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?.1);
    }
    Ok(out)
}

/// The bound values for a grain lookup, or `None` when the ops do not carry every term.
///
/// A sparse update op carries only what changed, so it cannot describe a grain — and does not
/// need to, because the row it edits is found by uid. An **insert** op carries every field,
/// which is what makes the grain rule work at all.
fn grain_values(
    grain: &Grain,
    g: &Group,
    parents: &BTreeMap<&'static str, Sql>,
) -> Option<Vec<Sql>> {
    let mut out = Vec::with_capacity(grain.sources.len());
    for source in grain.sources {
        match source {
            Source::Field(f) => {
                let v = g.resolved.fields.get(*f)?;
                out.push(sql_value(&v.0));
            }
            Source::Parent(key) => {
                if !g.resolved.parents.contains_key(*key) {
                    return None;
                }
                out.push(parents.get(key).cloned().unwrap_or(Sql::Null));
            }
        }
    }
    Some(out)
}

fn write_group<'a>(
    conn: &Connection,
    g: &'a Group<'a>,
    report: &mut ApplyReport,
    soft: &mut Vec<(&'a Group<'a>, String)>,
    deleted: &BTreeSet<(&str, &str)>,
    attempt: Attempt,
) -> Result<Outcome, String> {
    let (Some(meta), Some(spec)) = (meta_of(g.table), spec_of(g.table)) else {
        // A table this build does not sync: a newer device's new one, which is held, or one
        // this build renamed, which is skipped. Only the sender's schema says which, and
        // [`classify`] is where it is read.
        return Ok(Outcome::Deferred(Why::UnknownTable));
    };

    // Parents first, because both the grain lookup and the write need them.
    let mut parents: BTreeMap<&'static str, Sql> = BTreeMap::new();
    let mut soft_pending = false;
    let mut missing: Option<Why> = None;
    for p in spec.parents {
        match resolve_parent(conn, p, &g.resolved)? {
            Resolution::Id(id) => {
                parents.insert(p.key, Sql::Integer(id));
            }
            Resolution::None => {
                parents.insert(p.key, absent_value(p));
            }
            Resolution::Unknown(_) if p.soft => soft_pending = true,
            // **A deleted parent is answered the way its own foreign key answers a delete.**
            // Where the delete cascades, the child would have gone with it: it is moot, and that
            // decides the group however many other parents are merely missing, so it returns at
            // once. Where the key is `SET NULL` — a binder, a deck folder, a label — the delete
            // left every child it found in place with the column cleared, and that is what the
            // child's own device does to it when the delete reaches it; consumed here instead, it
            // would be a card one device holds and the other never will. So it is written
            // absent, like a parent the op never named. A moot row this device holds goes with
            // it, as the cascade takes it on the sender ([`cascade_onto_the_row_here`]).
            //
            // **Every decision resting on `gone` is made on a `Decide` pass, and only there** —
            // both arms, the moot one and the absent one; the first attempt and every `Retry`
            // pass withhold it ([`Why::DecidedOnRetry`]). `gone` answers for the page as it
            // stands, and a group of the same page can still bring the parent back: an edit made
            // on the sender after this device's delete resurrects it through add-wins, and that
            // group can sort after the child, or land only on a retry pass because it waits on a
            // parent of its own. Decided early, a folder moved under the parent was deleted here as
            // moot and could not be rebuilt from its sparse move when the parent returned, and a
            // copy filed into a deleted binder was written at the root while the peer kept it in
            // the binder. A `Decide` pass comes only after a pass on which nothing landed, so
            // every group that could bring the parent back has; `resolve_parent`, asked again at
            // the top of this loop, finds it, and the group is written like any other — only a
            // parent still unknown and still gone reaches the arms below. It is also the moot
            // delete's wait for the page's own re-filing, one level up. **The cost: every group
            // naming a gone parent takes at least two retry passes** — one that withholds, one
            // that decides. That is a put, or a put and its delete in one page, naming the
            // parent: a bare `del` carries no parents, resolves `Resolution::None` and never
            // reaches this arm. Each pass is one more `write_group` over a parent already not
            // found, cheap beside the pull.
            Resolution::Unknown(uid) if gone(conn, p.table, &uid, deleted)? => {
                if attempt != Attempt::Decide {
                    return Ok(Outcome::Deferred(Why::DecidedOnRetry));
                }
                if cascades(conn, meta.table, p)? {
                    cascade_onto_the_row_here(conn, meta, g, p)?;
                    return Ok(Outcome::Deferred(Why::UnknownParent {
                        table: p.table,
                        uid,
                    }));
                }
                parents.insert(p.key, absent_value(p));
            }
            Resolution::Unknown(uid) => {
                missing.get_or_insert(Why::UnknownParent {
                    table: p.table,
                    uid,
                });
            }
        }
    }
    if let Some(why) = missing {
        return Ok(Outcome::Deferred(why));
    }

    let existing = find_row(conn, meta, g, &parents, deleted)?;

    // **The second fold, over this device's own history as well.** See the module doc: a
    // tombstone — a `del` op, not a `sync_gone` row — folded on its own has nothing to lose to,
    // so add-wins would never fire on the two-device group, which is the ordinary one.
    let mut uids: Vec<String> = vec![g.ops[0].uid.clone()];
    if let Some(uid) = &existing.uid {
        uids.push(uid.clone());
    }
    if let Some(uid) = &existing.displaced {
        uids.push(uid.clone());
    }
    uids.sort();
    uids.dedup();
    let mut all: Vec<Op> = g.ops.iter().map(|o| (*o).clone()).collect();
    all.extend(local_history(conn, meta.table, &uids)?);
    let combined = fold(&all);

    // **Every write from here is inside the group's savepoint, the uid adoption first** — the
    // delete below addresses the row by the uid it adopts, so a delete ahead of the adoption
    // would miss its row, or find the other row that already wears that uid.
    let savepoint = "sync_apply_group";
    conn.execute_batch(&format!("SAVEPOINT {savepoint}"))
        .map_err(|e| e.to_string())?;
    let rollback = || {
        conn.execute_batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"))
            .map_err(|e| e.to_string())
    };
    if let Err(why) = adopt_uid(conn, meta, &existing) {
        rollback()?;
        return Ok(Outcome::Deferred(why));
    }

    if combined.deleted {
        if let Some(uid) = &existing.uid {
            // **A delete that would clear rows out of a folder waits, once — whether or not it
            // would collide yet.** A folder's or a deck's `DELETE` clears the folder off every
            // row filed beneath it (`SET NULL`), and the page takes parents first, so it runs
            // ahead of the sender's own writes to those rows — rank 7 or 9, which the retry finds
            // landed. Merging now would fold a copy the sender has itself just merged onto the
            // root, and its `+n` for the twin would count it a second time; and a delete that
            // collides with nothing *yet* is no safer, because the root copy it will meet may be
            // in the same page, and re-homing onto the free grain first let that copy's insert
            // land on the re-homed row (spec 2026-09-27 §3.3, as amended).
            //
            // **Never `?` from here.** A refusal — the read of the doomed rows included — rolls
            // the group back and is a row this database cannot build: dropped and recorded, or
            // held where the sender is newer. A delete that failed through `?` failed the whole
            // apply, and the same page failed it again on every pull after (spec §1.1).
            let doomed = rehome::doomed(conn, meta.table, uid);
            if attempt == Attempt::First && doomed.as_ref().is_ok_and(|d| !d.is_empty()) {
                rollback()?;
                return Ok(Outcome::Deferred(Why::DecidedOnRetry));
            }
            let done = doomed
                .and_then(|d| rehome::rehome(conn, &d))
                .and_then(|()| {
                    conn.execute(
                        &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                        [uid],
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                });
            if let Err(e) = done {
                rollback()?;
                return Ok(Outcome::Deferred(Why::Unbuildable(e)));
            }
        } else if let Err(e) = tombstone(conn, meta.table, &g.ops[0].uid) {
            // **A delete of a row this device never held still says the row is gone.** A parent a
            // third device made and deleted between two of this device's pulls arrives as a put
            // and a `del` folding to deleted, finds no row here and so fires no trigger; a child
            // another device filed into it, on a later page, would then wait out the bound and be
            // dropped where its own device keeps it at the root (spec 2026-09-27 §3.1, as
            // amended). A refusal is the delete arm's: rolled back, and never `?`.
            rollback()?;
            return Ok(Outcome::Deferred(Why::Unbuildable(e)));
        }
        conn.execute_batch(&format!("RELEASE {savepoint}"))
            .map_err(|e| e.to_string())?;
        report.applied += g.ops.len();
        return Ok(Outcome::Written);
    }

    let written = match &existing.uid {
        Some(uid) => update_row(conn, meta, spec, g, &combined, &parents, uid),
        None => {
            // **A row being created resolves its parents from the combined fold**, and the
            // difference only shows on a resurrection. A row this device deleted and add-wins
            // has just brought back is described by *this device's own* history: the incoming
            // op that saved it can be a sparse note edit that mentions no folder at all, and
            // resolving from it alone would put the row back at the root — a card that jumped
            // out of its binder because somebody else edited a note.
            //
            // An unknown uid here is `absent` rather than a deferral. Every parent in the
            // combined fold that is not also in the incoming one came from an op this device
            // wrote, so its row is local by construction; deferring on it would be a deadlock
            // against a condition that cannot arise.
            // **`g.resolved.parents` and not `parents`**, because the latter always holds
            // every key: an op that mentions no parent resolves to `Resolution::None`, which
            // is written in as the absent value. Asking the map whether it "has" the key would
            // therefore always be yes, and this whole arm would be dead code that reads as a
            // fix. The test caught it: `left: None, right: Some("Binder")`.
            let mut wide = parents.clone();
            for p in spec.parents {
                if g.resolved.parents.contains_key(p.key) {
                    continue;
                }
                wide.insert(
                    p.key,
                    match resolve_parent(conn, p, &combined)? {
                        Resolution::Id(id) => Sql::Integer(id),
                        Resolution::None | Resolution::Unknown(_) => absent_value(p),
                    },
                );
            }
            insert_row(conn, meta, spec, g, &combined, &wide)
        }
    };
    match written {
        Ok(uid) => {
            conn.execute_batch(&format!("RELEASE {savepoint}"))
                .map_err(|e| e.to_string())?;
            // **A resurrection is an EVENT, not a state, and the difference is whether the
            // reader can ever put the sentence away.** `combined.resurrected` stays true for
            // as long as the tombstone sits in this device's own op log — which is forever,
            // because the log is not pruned. Flagging on that alone re-writes the sentence on
            // every later batch, so "Looks fine" clears it and the next pull puts it straight
            // back. The test that found it drives exactly that: clear on one device, apply on
            // the other, and the sentence was there again.
            //
            // So it is flagged when this batch is the one that *did* the resurrecting: either
            // it carried the tombstone, or the row was not here and had to be rebuilt.
            let brought_a_tombstone = g.ops.iter().any(|o| o.kind == Kind::Del);
            if combined.resurrected && (brought_a_tombstone || existing.uid.is_none()) {
                report.resurrected += 1;
                if meta.needs_review {
                    flag(conn, meta.table, &uid, RESURRECTED)?;
                }
            }
            if soft_pending {
                soft.push((g, uid));
            }
            report.applied += g.ops.len();
            Ok(Outcome::Written)
        }
        Err(e) => {
            // **A row this database cannot build is never fatal.** The likeliest cause is a
            // compacted log whose insert op is gone, leaving an update that names no `NOT NULL`
            // column; the batch's other rows are unaffected. The error is kept, because it is
            // the only account of the skip the reader will ever have — or, from a newer
            // schema, of a `CHECK` word this build does not know yet.
            rollback()?;
            Ok(Outcome::Deferred(Why::Unbuildable(e)))
        }
    }
}

/// The columns an **update** writes: those the incoming ops actually won.
///
/// A field the local device changed later is left alone. Without this the applier would write
/// every field the incoming ops mentioned, and a stale value from a peer would overwrite a
/// newer local edit — last-writer-wins with the comparison left out.
fn updates(
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
) -> Vec<(String, Sql)> {
    let mut out: Vec<(String, Sql)> = Vec::new();
    for f in spec.fields {
        let (Some((v, incoming)), Some((_, winner))) =
            (g.resolved.fields.get(*f), combined.fields.get(*f))
        else {
            continue;
        };
        if incoming == winner {
            out.push(((*f).to_owned(), sql_value(v)));
        }
    }
    for p in spec.parents {
        let (Some((_, incoming)), Some((_, winner)), Some(v)) = (
            g.resolved.parents.get(p.key),
            combined.parents.get(p.key),
            parents.get(p.key),
        ) else {
            continue;
        };
        if incoming == winner {
            out.push((p.col.to_owned(), v.clone()));
        }
    }
    out
}

/// The columns an **insert** writes: everything the combined fold knows.
///
/// Wider than [`updates`] on purpose. A row that does not exist here has no value to compare
/// against, and the row being rebuilt may be one this device deleted and add-wins has just
/// brought back — in which case the only description of it is this device's own history.
fn creations(
    spec: &Spec,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
) -> Vec<(String, Sql)> {
    let mut out: Vec<(String, Sql)> = Vec::new();
    for f in spec.fields {
        if let Some((v, _)) = combined.fields.get(*f) {
            out.push(((*f).to_owned(), sql_value(v)));
        }
    }
    for p in spec.parents {
        if let Some(v) = parents.get(p.key) {
            out.push((p.col.to_owned(), v.clone()));
        }
    }
    out
}

fn insert_row(
    conn: &Connection,
    meta: &Meta,
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
) -> Result<String, String> {
    let uid = g.ops[0].uid.clone();
    let mut cols: Vec<String> = vec!["sync_uid".to_owned()];
    let mut vals: Vec<Sql> = vec![Sql::Text(uid.clone())];
    for (c, v) in creations(spec, combined, parents) {
        cols.push(c);
        vals.push(v);
    }
    // **A counter's initial value is the sum of every delta, local ones included**, because a
    // row being created here holds none of them yet. On an update it is the incoming deltas
    // alone — the local ones are already in the row.
    //
    // §8.2's rule with `local_current` at zero, because the row does not exist here: the claim
    // can only RAISE the sum, never join it. **The no-claim arm is the sum untouched and not
    // `sum.max(0)`** — "where the fold contains no baseline, `next = local_current + Σ deltas`,
    // exactly as today" — so a negative sum goes on failing its own `CHECK`, and the group is
    // skipped as unbuildable (or held, from a newer schema) rather than quietly becoming a row
    // holding nothing.
    for (name, _) in meta.counters {
        let sum = combined.counters.get(*name).copied().unwrap_or(0);
        cols.push((*name).to_owned());
        vals.push(Sql::Integer(match combined.claims.get(*name).copied() {
            Some(claim) => sum.max(claim),
            None => sum,
        }));
    }
    if meta.timestamps {
        cols.push("created_at".to_owned());
        cols.push("updated_at".to_owned());
    }
    let mut holes: Vec<String> = (1..=vals.len()).map(|i| format!("?{i}")).collect();
    if meta.timestamps {
        holes.push("unixepoch()".to_owned());
        holes.push("unixepoch()".to_owned());
    }
    conn.execute(
        &format!(
            "INSERT INTO {} ({}) VALUES ({})",
            meta.table,
            cols.join(", "),
            holes.join(", ")
        ),
        rusqlite::params_from_iter(vals.iter()),
    )
    .map_err(|e| e.to_string())?;
    Ok(uid)
}

fn update_row(
    conn: &Connection,
    meta: &Meta,
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
    uid: &str,
) -> Result<String, String> {
    let pairs = updates(spec, g, combined, parents);
    if !pairs.is_empty() || meta.timestamps {
        let mut sets: Vec<String> = pairs
            .iter()
            .enumerate()
            .map(|(i, (c, _))| format!("{c} = ?{}", i + 1))
            .collect();
        if meta.timestamps {
            sets.push("updated_at = unixepoch()".to_owned());
        }
        let mut vals: Vec<Sql> = pairs.into_iter().map(|(_, v)| v).collect();
        let hole = vals.len() + 1;
        vals.push(Sql::Text(uid.to_owned()));
        conn.execute(
            &format!(
                "UPDATE {} SET {} WHERE sync_uid = ?{hole}",
                meta.table,
                sets.join(", ")
            ),
            rusqlite::params_from_iter(vals.iter()),
        )
        .map_err(|e| e.to_string())?;
    }

    for (name, floor) in meta.counters {
        let delta = g.resolved.counters.get(*name).copied().unwrap_or(0);
        let claim = g.resolved.claims.get(*name).copied();
        // A zero delta with no claim is nothing to do. **With a claim it is not** — the claim
        // may still raise the row, which is the whole of §8.2.
        if delta == 0 && claim.is_none() {
            continue;
        }
        let current: i64 = conn
            .query_row(
                &format!("SELECT {name} FROM {} WHERE sync_uid = ?1", meta.table),
                [uid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        // §8.2. Deltas apply to what this device already holds — the existing, correct op-path
        // answer — and the claim can only RAISE that floor. It can therefore never over-count,
        // which is the direction that invents a card.
        //
        // **A claim above zero is also a floor the row cannot fall through**, so a concurrent
        // "remove the last copy" loses to it and `Floor::DeleteAtZero` below does not fire.
        // That is §8's named consequence rather than an oversight: add-wins in flavour, and
        // the same direction §7.3 already takes for row existence.
        let next = match claim {
            Some(c) => (current + delta).max(c),
            None => current + delta,
        };
        match floor {
            Floor::Clamp => {
                conn.execute(
                    &format!("UPDATE {} SET {name} = ?1 WHERE sync_uid = ?2", meta.table),
                    rusqlite::params![next.max(0), uid],
                )
                .map_err(|e| e.to_string())?;
            }
            Floor::DeleteAtZero if next <= 0 => {
                conn.execute(
                    &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                    [uid],
                )
                .map_err(|e| e.to_string())?;
                return Ok(uid.to_owned());
            }
            Floor::DeleteAtZero => {
                conn.execute(
                    &format!("UPDATE {} SET {name} = ?1 WHERE sync_uid = ?2", meta.table),
                    rusqlite::params![next, uid],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(uid.to_owned())
}

/// The first message wins — [`crate::reconcile`]'s stated rule for this column.
fn flag(conn: &Connection, table: &str, uid: &str, sentence: &str) -> Result<(), String> {
    conn.execute(
        &format!(
            "UPDATE {table} SET needs_review = ?1
              WHERE sync_uid = ?2 AND needs_review IS NULL"
        ),
        [sentence, uid],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn settle_soft_parents(conn: &Connection, g: &Group, uid: &str) -> Result<(), String> {
    let Some(spec) = spec_of(g.table) else {
        return Ok(());
    };
    for p in spec.parents.iter().filter(|p| p.soft) {
        let value = match resolve_parent(conn, p, &g.resolved)? {
            Resolution::Id(id) => Sql::Integer(id),
            // Still unknown after the whole batch: the category is on a device this one has not
            // heard from. `Auto` is the honest answer and the one the column defaults to.
            Resolution::None | Resolution::Unknown(_) => absent_value(p),
        };
        conn.execute(
            &format!("UPDATE {} SET {} = ?1 WHERE sync_uid = ?2", g.table, p.col),
            rusqlite::params![value, uid],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Break every loop in one folder tree, returning the folder whose move is **later** to the
/// root.
///
/// **Later and not earlier**, which is spec §7.3's wording and is a choice about *which move
/// survives*: cutting the later-moved folder leaves the **earlier** move standing. That is the
/// arrangement more devices in the group have already seen and drawn, so undoing the other one
/// disturbs the fewest screens — and the reader whose move was undone is the one who has just
/// made it and can most easily make it again, with `needs_review` telling them so.
///
/// Convergence is a separate requirement and both directions satisfy it, which a mutation
/// established: reversing the comparison left every test green. What convergence needs is that
/// both devices consult the **same set of stamps**, which is what reading the local op log
/// below is for.
///
/// Where neither folder in the loop was moved by anything this device knows about — a loop
/// that was already on disk — the greater row id breaks the tie, which is arbitrary and
/// identical everywhere.
///
/// # The stamps come from the local op log as well, and the first draft of this did not
///
/// A loop takes **two** moves and each device only ever *receives* one of them: the other is
/// its own, and an apply sees only what arrived. Reading the incoming batch alone therefore
/// makes each device break the move the *other* one made — A cuts Inner, B cuts Outer, the
/// tree is different on the two machines and neither can tell. The test that caught it asserts
/// the two devices name the same folder, and it failed on the first run with
/// `left: "Inner", right: "Outer"`.
///
/// So the map is built from `sync_ops` first — this device's own moves, which is what
/// `json_type(parents, '$.parent')` selects — and the incoming groups on top of it.
/// `json_type` and not `json_extract`, because a move **to the root** is a JSON null and
/// `json_extract` cannot tell that from a key that is not there.
fn break_cycles(conn: &Connection, meta: &Meta, groups: &[Group]) -> Result<usize, String> {
    let col = meta.tree.expect("called only for a tree");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, {col}, sync_uid FROM {} WHERE {col} IS NOT NULL",
            meta.table
        ))
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let parent: BTreeMap<i64, (i64, String)> = rows
        .iter()
        .map(|(id, p, u)| (*id, (*p, u.clone())))
        .collect();

    // Every move this device knows about: its own out of `sync_ops`, then the batch's.
    let mut moved: BTreeMap<String, Hlc> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT uid, hlc_ms, hlc_ctr, device_id FROM sync_ops
                  WHERE tbl = ?1 AND json_type(parents, '$.parent') IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([meta.table], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Hlc {
                        ms: r.get(1)?,
                        ctr: r.get(2)?,
                        device: r.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (uid, at) = row.map_err(|e| e.to_string())?;
            let e = moved.entry(uid).or_insert_with(|| at.clone());
            if at > *e {
                *e = at;
            }
        }
    }
    for g in groups.iter().filter(|g| g.table == meta.table) {
        if let Some((_, at)) = g.resolved.parents.get("parent") {
            let e = moved
                .entry(g.ops[0].uid.clone())
                .or_insert_with(|| at.clone());
            if *at > *e {
                *e = at.clone();
            }
        }
    }

    let mut broken = 0;
    let mut cut: Vec<i64> = Vec::new();
    for start in parent.keys() {
        let mut seen: Vec<i64> = vec![*start];
        let mut here = *start;
        while let Some((next, _)) = parent.get(&here) {
            if cut.contains(next) {
                break;
            }
            if seen.contains(next) {
                // The loop is `seen` from the first sight of `next` onwards.
                let from = seen.iter().position(|s| s == next).unwrap_or(0);
                let loop_members = &seen[from..];
                let victim = loop_members
                    .iter()
                    .max_by(|a, b| {
                        let key =
                            |id: &i64| parent.get(id).and_then(|(_, uid)| moved.get(uid)).cloned();
                        key(a).cmp(&key(b)).then_with(|| a.cmp(b))
                    })
                    .copied()
                    .unwrap_or(*start);
                conn.execute(
                    &format!(
                        "UPDATE {} SET {col} = NULL, needs_review = coalesce(needs_review, ?1)
                          WHERE id = ?2",
                        meta.table
                    ),
                    rusqlite::params![CYCLE_BROKEN, victim],
                )
                .map_err(|e| e.to_string())?;
                cut.push(victim);
                broken += 1;
                break;
            }
            seen.push(*next);
            here = *next;
        }
    }
    Ok(broken)
}

/// Move each peer's watermark to the last op the committed pass wrote or consumed.
///
/// **Below the block and never past it.** Everything at or above a device's block is left
/// unapplied, which is why the pass above must not have applied any of it: the two halves are
/// one rule, and getting either wrong would double a counter on a re-delivery or lose an op.
///
/// **It is read off what the pass did, not re-derived from stamps**, and the round cap is why.
/// A group is held exactly when an op of it is at or above its device's block, so the groups a
/// pass wrote or consumed are all below the blocks it *ran under* — while at the cap the blocks
/// its deferrals *found* are lower than those, and a watermark advanced by them sits under ops
/// the pass applied, which the next delivery of the page then applies again. Leaving out every
/// group that holds also keeps a device first found in the cap round from being stepped past
/// its held op, unless the pass applied a later op of that device. A moot or dropped group is
/// in: it is consumed, and the watermark passing it is what stops a re-delivery recording the
/// same skip twice.
fn advance_watermarks(
    conn: &Connection,
    groups: &[Group],
    committed: &[Deferral],
) -> Result<(), String> {
    let holding: BTreeSet<(&str, &str)> = committed
        .iter()
        .filter(|d| d.class.holds())
        .map(|d| (d.group.table, d.group.ops[0].uid.as_str()))
        .collect();
    let mut high: BTreeMap<&str, Hlc> = BTreeMap::new();
    for g in groups {
        if holding.contains(&(g.table, g.ops[0].uid.as_str())) {
            continue;
        }
        for op in &g.ops {
            let e = high.entry(op.at.device.as_str());
            match e {
                std::collections::btree_map::Entry::Vacant(v) => {
                    v.insert(op.at.clone());
                }
                std::collections::btree_map::Entry::Occupied(mut o) => {
                    if op.at > *o.get() {
                        o.insert(op.at.clone());
                    }
                }
            }
        }
    }
    for (device, at) in high {
        conn.execute(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES (?1, ?2, ?3)
             ON CONFLICT(device_id) DO UPDATE SET
                 last_ms  = excluded.last_ms,
                 last_ctr = excluded.last_ctr
               WHERE (excluded.last_ms, excluded.last_ctr) > (sync_peers.last_ms,
                                                              sync_peers.last_ctr)",
            rusqlite::params![device, at.ms, at.ctr],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

mod rehome;
#[cfg(test)]
mod tests;
