//! Spec §7.3's rules, as pure functions over ops.
//!
//! **Nothing here touches a database**, which is what makes the tests real: every one of them
//! builds two ops from two device ids that have not seen each other and folds them **in both
//! orders**, asserting the same answer. A test that pushed one op through SQLite and then the
//! other would be testing sequential application, and would pass over every rule here being
//! wrong.

use crate::sync_engine::hlc::Hlc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Whether an op asserts a row exists or that it is gone.
///
/// `Put` covers insert and update alike, because row existence is **add-wins**: a put that
/// arrives after a delete resurrects the row, and having one verb for both is what makes that a
/// rule rather than a special case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Put,
    Del,
}

/// What the emitter had already folded into its claims when it read its tables.
///
/// Not a watermark write. See spec §9.1: this filters ONE batch and `sync_peers` is untouched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Horizon {
    /// device id → the highest stamp from that device already inside the claims.
    pub seen: BTreeMap<String, Hlc>,
}

impl Horizon {
    /// Is `op` already inside the claims this horizon belongs to?
    ///
    /// **Only ever asked of a non-baseline `Put`** — the caller enforces the other two
    /// exemptions, because a `Horizon` cannot see an op's kind without being handed one.
    ///
    /// `<=` and not `<`: a stamp exactly at the horizon is one the emitter had folded in.
    pub fn covers(&self, at: &Hlc) -> bool {
        self.seen.get(&at.device).is_some_and(|h| at <= h)
    }

    /// Fold another horizon in, keeping the greater stamp per device.
    pub fn absorb(&mut self, other: &Horizon) {
        for (device, stamp) in &other.seen {
            match self.seen.get(device) {
                Some(held) if held >= stamp => {}
                _ => {
                    self.seen.insert(device.clone(), stamp.clone());
                }
            }
        }
    }
}

/// One change to one row, as it travels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Op {
    pub table: String,
    pub uid: String,
    pub kind: Kind,
    /// Scalar fields that changed. Last-writer-wins per key.
    #[serde(default)]
    pub fields: BTreeMap<String, serde_json::Value>,
    /// Deltas. Summed, never compared.
    #[serde(default)]
    pub counters: BTreeMap<String, i64>,
    /// Foreign rows by uid. `None` is "at the root", which is a real value and not an absence.
    #[serde(default)]
    pub parents: BTreeMap<String, Option<String>>,
    pub at: Hlc,
    /// A state CLAIM rather than a change: `counters` hold values. Spec §8.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub baseline: bool,
    /// Carried by the FIRST op of each baseline batch, so every stored relay row has one.
    /// The receiver unions whatever it finds. Spec §9.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizon: Option<Horizon>,
}

/// What a set of ops about one row adds up to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolved {
    /// Field → (value, the stamp that won it). The stamp is kept because the applier compares
    /// it against what the local row already carries.
    pub fields: BTreeMap<String, (serde_json::Value, Hlc)>,
    /// Summed deltas.
    pub counters: BTreeMap<String, i64>,
    pub parents: BTreeMap<String, (Option<String>, Hlc)>,
    /// Per counter key, the greatest value any baseline op claimed. Spec §8.2.
    pub claims: BTreeMap<String, i64>,
    pub deleted: bool,
    /// A delete lost the race and the row survives — §7.4's first surfaced outcome.
    pub resurrected: bool,
    /// The latest stamp in the whole set, which is what the applier writes back as the row's
    /// watermark.
    pub at: Option<Hlc>,
}

/// Fold every op about one row into one answer.
///
/// **Order-independent by construction**, which is not a nicety: two devices fold the same set
/// in whatever order their relay handed it over, and a fold that depended on that order would
/// leave them holding different rows while both believed they had converged.
///
/// # It folds a *set*, and the stamp is the key
///
/// A stamp is unique per device by construction — the capture trigger advances `sync_clock`
/// after every op it writes, so no device ever issues one twice, and a multi-row `UPDATE` gets
/// one stamp per row (measured 2026-08-28: five rows in one statement, five distinct counters).
/// So **two ops sharing a stamp are the same op**, and the second is skipped.
///
/// That is not tidiness. Counters *sum*, so an op counted twice adds its delta twice, and a
/// relay that stored one device's retried push twice — a 500 after the write landed, which is
/// the ordinary shape of a network failure — would otherwise grow the reader's collection by
/// itself. [`super::apply`]'s `sync_peers` watermark covers the same hazard *between* batches;
/// this covers it *within* one.
pub fn fold(ops: &[Op]) -> Resolved {
    let mut out = Resolved::default();
    let mut seen: BTreeSet<&Hlc> = BTreeSet::new();
    // The latest stamp of anything that ASSERTS the row exists. Add-wins compares the tombstone
    // against this rather than against the whole set, so a delete that lost to an edit is a
    // resurrection and a delete that came after everything is a delete.
    let mut latest_alive: Option<&Hlc> = None;
    let mut latest_dead: Option<&Hlc> = None;

    for op in ops {
        if !seen.insert(&op.at) {
            continue;
        }
        out.at = Some(match out.at.take() {
            Some(a) if a > op.at => a,
            _ => op.at.clone(),
        });

        match op.kind {
            Kind::Del => {
                if latest_dead.is_none_or(|d| *d < op.at) {
                    latest_dead = Some(&op.at);
                }
            }
            Kind::Put => {
                if latest_alive.is_none_or(|a| *a < op.at) {
                    latest_alive = Some(&op.at);
                }
                for (k, v) in &op.fields {
                    match out.fields.get(k) {
                        // `>=` and not `>`: written this way so that a stamp shape which *can*
                        // tie still resolves the same in both directions rather than silently
                        // keeping whichever arrived first. **A tie is unreachable today** —
                        // the dedupe above drops a repeated stamp before this is asked — so
                        // the two spellings behave identically, which a mutation confirmed
                        // rather than a comment claiming otherwise.
                        Some((_, held)) if *held >= op.at => {}
                        _ => {
                            out.fields.insert(k.clone(), (v.clone(), op.at.clone()));
                        }
                    }
                }
                // **A claim is not a delta and the two must never meet in one map.** Summing
                // them is §8.1's failure: a baseline claiming 5 plus the `+1` already inside
                // that 5 inserts the row at 6. `max` across claims is §8's rule — two devices
                // holding 4 and 3 of one printing hold 4 between them, not 7.
                if op.baseline {
                    for (k, v) in &op.counters {
                        let held = out.claims.entry(k.clone()).or_insert(*v);
                        *held = (*held).max(*v);
                    }
                } else {
                    for (k, d) in &op.counters {
                        *out.counters.entry(k.clone()).or_insert(0) += d;
                    }
                }
                for (k, p) in &op.parents {
                    match out.parents.get(k) {
                        Some((_, held)) if *held >= op.at => {}
                        _ => {
                            out.parents.insert(k.clone(), (p.clone(), op.at.clone()));
                        }
                    }
                }
            }
        }
    }

    // §7.3 row 3, in four lines. A tombstone deletes only when it is strictly later than
    // everything that asserted the row exists; otherwise the row survives **and says so**,
    // because a resurrection is a thing the reader has to be able to see (§7.4).
    //
    // **`>` rather than `>=`, and the difference is unreachable** — established by mutation:
    // swapping them changes no test, because the two stamps being compared come from two
    // *different* devices and the device id is the last term of the ordering, so they can
    // never be equal. The two spellings differ only for a same-device tie, which the dedupe
    // above has already removed. What the tests do bite on is the *direction*: reversing it,
    // making a delete always win, or dropping the delete arm each turns three of them red.
    match (latest_dead, latest_alive) {
        (Some(d), Some(a)) if *d > *a => out.deleted = true,
        (Some(_), Some(_)) => out.resurrected = true,
        (Some(_), None) => out.deleted = true,
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::hlc::Hlc;
    use serde_json::json;

    fn at(ms: i64, dev: &str) -> Hlc {
        Hlc {
            ms,
            ctr: 0,
            device: dev.to_owned(),
        }
    }

    fn put(dev: &str, ms: i64, fields: serde_json::Value, counters: serde_json::Value) -> Op {
        Op {
            table: "collection_entries".into(),
            uid: "u1".into(),
            kind: Kind::Put,
            fields: fields
                .as_object()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            counters: counters
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_i64().unwrap()))
                        .collect()
                })
                .unwrap_or_default(),
            parents: Default::default(),
            at: at(ms, dev),
            baseline: false,
            horizon: None,
        }
    }

    fn del(dev: &str, ms: i64) -> Op {
        Op {
            kind: Kind::Del,
            ..put(dev, ms, json!({}), json!({}))
        }
    }

    /// A baseline op: the same shape, but its counters are **values** rather than deltas.
    fn claim(dev: &str, ms: i64, counters: serde_json::Value) -> Op {
        Op {
            baseline: true,
            ..put(dev, ms, json!({}), counters)
        }
    }

    /// Folding is order-independent. Every rule below is asserted through this, so a rule that
    /// only worked when the ops happened to arrive in timestamp order cannot pass.
    fn fold_both_ways(ops: &[Op]) -> Resolved {
        let forward = fold(ops);
        let mut backward: Vec<Op> = ops.to_vec();
        backward.reverse();
        let reversed = fold(&backward);
        assert_eq!(
            forward, reversed,
            "folding must not depend on arrival order"
        );
        forward
    }

    /// §7.3 row 1. **Two devices each add one copy and the row ends at +2.** Genuinely
    /// concurrent: two device ids, neither having seen the other, folded in both orders.
    #[test]
    fn two_concurrent_additions_of_one_copy_end_at_plus_two() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({}), json!({"quantity": 1})),
            put("b", 1_000, json!({}), json!({"quantity": 1})),
        ]);
        assert_eq!(r.counters.get("quantity"), Some(&2));
    }

    /// ...and the failure it exists to prevent, stated as its own assertion: a value-carrying
    /// op would resolve to 1 here, silently losing a card.
    #[test]
    fn a_counter_never_resolves_to_the_last_value_seen() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({}), json!({"quantity": 3})),
            put("b", 2_000, json!({}), json!({"quantity": 1})),
        ]);
        assert_eq!(r.counters.get("quantity"), Some(&4), "3 + 1, not 1");
    }

    /// A negative delta is a removal and sums like any other.
    #[test]
    fn counters_sum_in_both_directions() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({}), json!({"quantity": 4})),
            put("b", 2_000, json!({}), json!({"quantity": -1})),
        ]);
        assert_eq!(r.counters.get("quantity"), Some(&3));
    }

    /// **The same op twice adds its delta once.** A relay that stored a retried push twice — a
    /// 500 after the write landed — is the ordinary shape of a network failure, and this is
    /// what stands between it and a collection that grows by itself.
    #[test]
    fn the_same_op_twice_adds_its_delta_once() {
        let op = put("a", 1_000, json!({}), json!({"quantity": 1}));
        let r = fold_both_ways(&[op.clone(), op.clone(), op]);
        assert_eq!(r.counters.get("quantity"), Some(&1));
    }

    /// ...and two ops from ONE device that merely look alike are still two ops, because their
    /// stamps differ. The dedupe keys on the stamp and nothing else.
    #[test]
    fn two_stamps_from_one_device_are_two_ops() {
        let mut second = put("a", 1_000, json!({}), json!({"quantity": 1}));
        second.at.ctr = 1;
        let r = fold_both_ways(&[put("a", 1_000, json!({}), json!({"quantity": 1})), second]);
        assert_eq!(r.counters.get("quantity"), Some(&2));
    }

    /// §7.3 row 2. Per FIELD and not per row: A's note and B's price both survive.
    #[test]
    fn concurrent_edits_to_different_fields_both_survive() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({"notes": "mine"}), json!({})),
            put("b", 1_001, json!({"purchase_price": 4.5}), json!({})),
        ]);
        assert_eq!(r.fields["notes"].0, json!("mine"));
        assert_eq!(r.fields["purchase_price"].0, json!(4.5));
    }

    /// ...and on the SAME field, the later stamp wins — on both devices, identically.
    #[test]
    fn concurrent_edits_to_one_field_take_the_later_stamp() {
        let r = fold_both_ways(&[
            put("a", 2_000, json!({"notes": "later"}), json!({})),
            put("b", 1_000, json!({"notes": "earlier"}), json!({})),
        ]);
        assert_eq!(r.fields["notes"].0, json!("later"));
    }

    /// A tie on millis and counter is broken by the device id, deterministically.
    #[test]
    fn a_dead_heat_on_one_field_is_broken_by_the_device_id() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({"notes": "from a"}), json!({})),
            put("b", 1_000, json!({"notes": "from b"}), json!({})),
        ]);
        assert_eq!(r.fields["notes"].0, json!("from b"), "b sorts after a");
    }

    /// **A field cleared to null is a value like any other**, and the later clear wins. The
    /// capture side goes to some trouble to make a null travel at all; a fold that treated it
    /// as "no opinion" would throw that away at the other end.
    #[test]
    fn clearing_a_field_beats_an_earlier_value() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({"notes": "old"}), json!({})),
            put("b", 2_000, json!({"notes": null}), json!({})),
        ]);
        assert!(r.fields["notes"].0.is_null());
    }

    /// §7.3 row 3. **Add wins**: a delete concurrent with an edit resurrects the row, and says
    /// so, because losing a collection entry is worse than keeping one.
    #[test]
    fn a_delete_concurrent_with_an_edit_resurrects_and_is_flagged() {
        let r = fold_both_ways(&[
            del("a", 1_000),
            put("b", 1_000, json!({"notes": "still here"}), json!({})),
        ]);
        assert!(!r.deleted, "add-wins: the row survives");
        assert!(r.resurrected, "and the reader is told");
        assert_eq!(r.fields["notes"].0, json!("still here"));
    }

    /// ...but a tombstone strictly later than EVERY edit does delete, and quietly.
    #[test]
    fn a_delete_after_every_edit_really_deletes() {
        let r = fold_both_ways(&[
            put("b", 1_000, json!({"notes": "old"}), json!({})),
            del("a", 9_000),
        ]);
        assert!(r.deleted);
        assert!(!r.resurrected, "an uncontested delete is not a surprise");
    }

    /// A delete on its own deletes, with nothing to be surprised about.
    #[test]
    fn a_delete_with_no_edits_at_all_just_deletes() {
        let r = fold_both_ways(&[del("a", 1_000)]);
        assert!(r.deleted);
        assert!(!r.resurrected);
    }

    /// A counter also counts as an edit for add-wins. Losing a delete's race against a
    /// quantity change must keep the row, not just its notes.
    #[test]
    fn a_counter_change_also_beats_a_concurrent_delete() {
        let r = fold_both_ways(&[
            del("a", 1_000),
            put("b", 1_000, json!({}), json!({"quantity": 1})),
        ]);
        assert!(!r.deleted);
        assert!(r.resurrected);
    }

    /// §7.3 row 4, the LWW half. The cycle-break half is [`super::super::apply`]'s, because it
    /// needs the tree.
    #[test]
    fn a_parent_move_is_last_writer_wins() {
        let mut a = put("a", 1_000, json!({}), json!({}));
        a.parents.insert("parent".into(), Some("p-old".into()));
        let mut b = put("b", 2_000, json!({}), json!({}));
        b.parents.insert("parent".into(), Some("p-new".into()));
        let r = fold_both_ways(&[a, b]);
        assert_eq!(r.parents["parent"].0.as_deref(), Some("p-new"));
    }

    /// **A move to the root is a move**, not an absence. `None` has to beat an earlier folder
    /// or "put this back at the top level" would be the one move that never travels.
    #[test]
    fn a_move_to_the_root_beats_an_earlier_folder() {
        let mut a = put("a", 1_000, json!({}), json!({}));
        a.parents.insert("folder".into(), Some("f1".into()));
        let mut b = put("b", 2_000, json!({}), json!({}));
        b.parents.insert("folder".into(), None);
        let r = fold_both_ways(&[a, b]);
        assert_eq!(r.parents["folder"].0, None);
        assert!(r.parents.contains_key("folder"), "the root is a value");
    }

    /// The watermark is the latest stamp in the whole set, deletes included.
    #[test]
    fn the_resolved_stamp_is_the_latest_of_everything() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({"notes": "x"}), json!({})),
            del("z", 5_000),
        ]);
        assert_eq!(r.at, Some(at(5_000, "z")));
    }

    /// §7.3 row 6. `deck_audit` is union/append-only, so a fold of one insert is that insert
    /// and a second op for the same uid is the same row rather than a conflict.
    #[test]
    fn an_audit_row_folds_to_itself() {
        let mut op = put("a", 1_000, json!({"kind": "add"}), json!({}));
        op.table = "deck_audit".into();
        let r = fold_both_ways(&[op.clone(), op]);
        assert!(!r.deleted);
        assert_eq!(r.fields["kind"].0, json!("add"));
    }

    /// An empty fold decides nothing — no row, no delete, no surprise.
    #[test]
    fn folding_nothing_decides_nothing() {
        let r = fold(&[]);
        assert_eq!(r, Resolved::default());
        assert!(!r.deleted && !r.resurrected);
    }

    /// The wire shape is camelCase and every collection field is optional, so an op written by
    /// a build that had one fewer of them still reads.
    #[test]
    fn an_op_round_trips_and_tolerates_a_missing_collection() {
        let op = put("a", 1_000, json!({"notes": "x"}), json!({"quantity": 2}));
        let back: Op = serde_json::from_str(&serde_json::to_string(&op).unwrap()).unwrap();
        assert_eq!(back, op);
        let sparse: Op = serde_json::from_str(
            r#"{"table":"decks","uid":"u1","kind":"del","at":{"ms":1,"ctr":0,"device":"a"}}"#,
        )
        .unwrap();
        assert_eq!(sparse.kind, Kind::Del);
        assert!(sparse.fields.is_empty());
    }

    /// §8.2, row 2: two claims about one row resolve to the LARGER, never their sum.
    #[test]
    fn two_baselines_claim_rather_than_add() {
        let a = claim("dev-a", 10, json!({"quantity": 4}));
        let b = claim("dev-b", 20, json!({"quantity": 3}));
        for pair in [vec![a.clone(), b.clone()], vec![b, a]] {
            let r = fold(&pair);
            assert_eq!(r.claims.get("quantity"), Some(&4), "claims must not sum");
            assert_eq!(r.counters.get("quantity"), None, "a claim is not a delta");
        }
    }

    /// A baseline op's counters never reach `counters`, and an ordinary op's never reach `claims`.
    /// This is the whole separation, and folding them together is the +1 bug in §8.1.
    #[test]
    fn a_claim_and_a_delta_are_kept_apart() {
        let ops = vec![
            claim("dev-a", 10, json!({"quantity": 5})),
            put("dev-a", 20, json!({}), json!({"quantity": 1})),
        ];
        let r = fold(&ops);
        assert_eq!(r.claims.get("quantity"), Some(&5));
        assert_eq!(r.counters.get("quantity"), Some(&1));
    }

    /// The founding constraint, unchanged: with no baseline in the set, deltas still sum.
    #[test]
    fn two_ordinary_adds_still_sum_to_two() {
        let ops = vec![
            put("dev-a", 10, json!({}), json!({"quantity": 1})),
            put("dev-b", 20, json!({}), json!({"quantity": 1})),
        ];
        assert_eq!(fold(&ops).counters.get("quantity"), Some(&2));
        assert!(fold(&ops).claims.is_empty());
    }

    /// A horizon covers a stamp at or below its own for that device, and nothing from a device
    /// it says nothing about.
    #[test]
    fn a_horizon_covers_only_what_it_names() {
        let mut h = Horizon::default();
        h.seen.insert("dev-a".into(), at(50, "dev-a"));
        assert!(h.covers(&at(50, "dev-a")), "at the horizon is inside it");
        assert!(h.covers(&at(49, "dev-a")));
        assert!(!h.covers(&at(51, "dev-a")));
        assert!(
            !h.covers(&at(1, "dev-b")),
            "a device it never heard of is not covered"
        );
    }

    /// Unioning two horizons keeps the greater stamp per device, so a page carrying two
    /// baselines is filtered by both.
    #[test]
    fn absorbing_a_horizon_keeps_the_greater_stamp() {
        let mut a = Horizon::default();
        a.seen.insert("x".into(), at(10, "x"));
        a.seen.insert("y".into(), at(90, "y"));
        let mut b = Horizon::default();
        b.seen.insert("x".into(), at(50, "x"));
        b.seen.insert("z".into(), at(7, "z"));
        a.absorb(&b);
        assert_eq!(a.seen.get("x"), Some(&at(50, "x")));
        assert_eq!(a.seen.get("y"), Some(&at(90, "y")));
        assert_eq!(a.seen.get("z"), Some(&at(7, "z")));
    }

    /// The wire keeps its shape for a peer on an older build: an ordinary op serialises with
    /// neither new key, so nothing that reads it today has to change.
    #[test]
    fn an_ordinary_op_carries_no_baseline_keys_on_the_wire() {
        let json = serde_json::to_string(&put("dev-a", 1, json!({}), json!({}))).unwrap();
        assert!(!json.contains("baseline"), "{json}");
        assert!(!json.contains("horizon"), "{json}");
        let back: Op = serde_json::from_str(&json).unwrap();
        assert!(!back.baseline);
        assert_eq!(back.horizon, None);
    }
}
