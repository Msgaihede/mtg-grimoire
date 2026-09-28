//! The encrypted envelope, batched at 200 ops or 512 KiB per stored row, whichever comes first.
//!
//! **200 is derived from the write limit and checked against the row cap, not the other way
//! round.** The free tier allows 100 000 Durable Object rows written per day. A 50 000-row bulk
//! import at one op per stored row would spend half of that; at 200 it is 250 writes. The
//! measured average op is ~453 bytes, so a full batch is ~90 KB against the 2 MB per-row cap —
//! the cap is not the binding constraint, and spec §7.7 says there is no separate snapshot
//! artifact for it to bind on. [`tests::a_full_batch_is_far_below_the_two_megabyte_row_cap`]
//! measures a real one rather than quoting that arithmetic.
//!
//! **Bytes bind too, because ~453 is an average and not a size any op promises.** It is a
//! collection entry's. A deck note or a sticky note carries the reader's prose, whose body has no
//! length cap, so two hundred of them — or one — can come to anything. Cut by count alone, a batch
//! whose sealed text is over the relay's cap ([`MAX_SEALED_CHARS`], a 413 at the push) is refused
//! on every attempt, and a push stops at the first chunk that fails, so everything queued behind
//! it would never reach the relay either. So [`batches`] cuts at [`BATCH`] ops or [`BATCH_BYTES`]
//! of plaintext, whichever comes first — on ordinary ops the count still does, so the arithmetic
//! above is untouched — and [`oversized`] names the op no cut can save: one over the cap alone.

use crate::sync_engine::merge::Op;
use crate::sync_pair::crypto;
use crate::sync_pair::identity::Group;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// Ops per stored relay row. See the module doc — it is arithmetic, not tidiness.
pub const BATCH: usize = 200;

/// The longest `sealed` the relay stores, in characters of base64url. A longer one is a **413**
/// `code: "too_large"` at the push, before the Durable Object — whose rows cap at 2 MB — is
/// reached.
///
/// **It must equal `MAX_SEALED_CHARS` in `relay/src/log.ts`**, and
/// [`tests::the_sealed_cap_is_the_relays`] reads that file to hold the two together: moved on one
/// side only, it is a push refused by a relay this side believed would take it, or an op given up
/// on that the relay would have stored.
pub const MAX_SEALED_CHARS: usize = 1_500_000;

/// The plaintext budget of one batch: bytes of the JSON list [`seal_batch`] seals, its brackets,
/// commas and every op's `schema` stamp included.
///
/// **Under half the cap and not all of it, and the gap is what it buys.** A full budget seals to
/// [`sealed_chars`]`(BATCH_BYTES)` = 699 104 characters against [`MAX_SEALED_CHARS`]'s 1 500 000,
/// so no batch of several ops is ever what the relay refuses. An op over the budget on its own
/// still goes — alone — and is accepted up to the cap itself, 1 124 958 bytes of JSON (~1.07 MiB),
/// so only an op past *that* is lost to a push, and [`oversized`] is how a caller knows which. The
/// gap also takes whatever a caller adds after the cut: a baseline's horizon rides each slice's
/// first op, a few hundred bytes. It costs an ordinary import nothing — 200 ops at the measured
/// ~453 B is ~90 KB — so the count binds first and the write-limit arithmetic stands.
///
/// The envelope's five clear fields are not in it: the relay caps `sealed` alone, and allows the
/// request body a margin over that for them.
pub const BATCH_BYTES: usize = 512 * 1024;

/// What [`crypto::seal`] frames a plaintext with: the 24-byte XChaCha20 nonce it prefixes and the
/// 16-byte Poly1305 tag the AEAD appends. `crypto` keeps its own constant private, so this one is
/// held to what `seal` actually produces by
/// [`tests::the_sealed_length_is_computed_exactly`] rather than by a shared name.
const AEAD_OVERHEAD: usize = 24 + 16;

/// Characters of `sealed` that `plaintext` bytes become: the AEAD's framing, then base64url with
/// no padding, which is `⌈4n/3⌉`.
const fn sealed_chars(plaintext: usize) -> usize {
    plaintext
        .saturating_add(AEAD_OVERHEAD)
        .saturating_mul(4)
        .div_ceil(3)
}

// A budget raised past the cap would make `batches` cut slices the relay refuses — the failure
// this whole arrangement exists to remove — so it is a build that fails rather than a push.
const _: () = assert!(sealed_chars(BATCH_BYTES) < MAX_SEALED_CHARS);

/// `op` as [`seal_batch`] seals it: stamped with this build's user schema. **One function for
/// both**, so the size [`batches`] and [`oversized`] measure is the size that is sealed.
fn stamp(op: &Op) -> Op {
    let mut op = op.clone();
    op.schema = Some(crate::schema::USER_SCHEMA_VERSION);
    op
}

/// Bytes of one stamped op's JSON. **An op that will not serialize measures as unbounded**: it can
/// never be sealed either, so it is cut into a slice of its own and [`oversized`] names it, where
/// counting it as nothing would fail every batch it landed in.
fn op_bytes(op: &Op) -> usize {
    serde_json::to_vec(&stamp(op)).map_or(usize::MAX, |json| json.len())
}

/// Bytes of the JSON list [`seal_batch`] seals for `ops`: the brackets, each stamped op, and a
/// comma between each two.
fn list_bytes(ops: &[Op]) -> usize {
    ops.iter().fold(2 + ops.len().saturating_sub(1), |sum, op| {
        sum.saturating_add(op_bytes(op))
    })
}

/// One stored row's worth of ops, as it crosses the network.
///
/// **The relay sees these six fields and nothing else.** `group` routes it, `device` and the
/// two clock fields let the Durable Object order and compact without decrypting anything, and
/// `sealed` is opaque. The op count is deliberately absent: it is inside the ciphertext,
/// because "this device wrote 431 things today" is information the relay does not need in order
/// to relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub group: String,
    pub device: String,
    pub epoch: i64,
    /// The stamp of the LAST op inside. The relay's ordering key, and never a clock it sets.
    pub hlc_ms: i64,
    pub hlc_ctr: i64,
    /// XChaCha20-Poly1305 under the group key, base64url. AAD is `group|device|epoch`, so a
    /// blob replayed into another group or under another epoch fails to open rather than
    /// applying somewhere it does not belong.
    pub sealed: String,
}

/// What a batch could not do, in words a panel can show.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WireError {
    #[error("a batch may hold at most {BATCH} ops and this one holds {0}")]
    TooBig(usize),
    #[error("a batch with no ops in it is not something to send")]
    Empty,
    #[error("that batch belongs to another pairing group")]
    WrongGroup,
    #[error(
        "that batch was written before this device's group key was rotated, and cannot be read"
    )]
    WrongEpoch,
    #[error("that batch could not be read - it is for another group, or it was altered")]
    Unreadable,
    /// Not a list of ops. On the way in: opened under the group key and did not parse, and
    /// **nothing in it says a newer build sealed it**, so no update of this device will ever read
    /// it. On the way out: ops [`seal_batch`] could not serialize.
    #[error("that batch is not a list of ops: {0}")]
    Malformed(String),
    /// Opened under the group key and did not parse as ops, and **an op in it carries a user
    /// schema above this build's** ([`Op::schema`], read off the bare JSON): a member on a newer
    /// build sealed it — an op `kind` this one has never heard of — and updating this device is
    /// what reads it.
    #[error(
        "that batch was sealed by a newer version of MTG Grimoire, which this one cannot read: {0}"
    )]
    Newer(String),
}

/// The associated data every envelope is bound to.
///
/// **The epoch is in here and that is what makes revocation mean something on the wire.**
/// Rotating the group key already stops a removed device reading anything new; binding the
/// epoch ties a blob to its own epoch's key, so it opens under that key or not at all. Whether a
/// device that has moved on still opens a blob from before the rotation is then decided by which
/// superseded keys it keeps (`identity::supersede`) — across a join it does, and across a removal
/// it keeps none, because the removed device holds them.
///
/// `\0` between the fields rather than `|`, so a group id containing the separator cannot be
/// read as a different `(group, device, epoch)` triple. **No test can tell the two apart and
/// none is written**: a group id and a device id are both hex and an epoch is a number, so
/// the ambiguity the NUL prevents is unreachable today. Swapping it for a pipe was run as a
/// mutation and every test stayed green, which is the honest thing to record rather than an
/// assertion that could not fail.
fn aad(group: &str, device: &str, epoch: i64) -> Vec<u8> {
    format!("{group}\0{device}\0{epoch}").into_bytes()
}

/// Seal one batch of ops for the group.
///
/// `device` is this device's id, and it travels in the clear because the relay orders by it and
/// a device must not be handed back its own rows. It is bound into the AAD, so a relay that
/// relabelled a batch produces one that will not open.
///
/// **Every op is stamped with this build's user schema here, and only here** ([`Op::schema`]).
/// Sealing is the one function every path that sends ops goes through — the push and the
/// baselines alike — and stamping at capture instead would leave an outbox written by an older
/// build saying the older schema after the upgrade that is actually sending it.
pub fn seal_batch(group: &Group, device: &str, ops: &[Op]) -> Result<Envelope, WireError> {
    if ops.is_empty() {
        return Err(WireError::Empty);
    }
    if ops.len() > BATCH {
        return Err(WireError::TooBig(ops.len()));
    }
    let stamped: Vec<Op> = ops.iter().map(stamp).collect();
    let plaintext =
        serde_json::to_vec(&stamped).map_err(|e| WireError::Malformed(e.to_string()))?;
    // The last op's stamp, which is this batch's ordering key. `ops` is non-empty.
    let last = ops
        .iter()
        .map(|o| &o.at)
        .max()
        .expect("a non-empty batch has a latest stamp");
    seal_bytes(group, device, &plaintext, (last.ms, last.ctr))
}

/// The envelope around `plaintext` — the AEAD and the clear fields, and nothing about ops.
fn seal_bytes(
    group: &Group,
    device: &str,
    plaintext: &[u8],
    (hlc_ms, hlc_ctr): (i64, i64),
) -> Result<Envelope, WireError> {
    let sealed = crypto::seal(
        &group.group_key,
        &aad(&group.group_id, device, group.epoch),
        plaintext,
    )
    .map_err(|_| WireError::Unreadable)?;
    Ok(Envelope {
        group: group.group_id.clone(),
        device: device.to_owned(),
        epoch: group.epoch,
        hlc_ms,
        hlc_ctr,
        sealed: URL_SAFE_NO_PAD.encode(sealed),
    })
}

/// **Test-only: seal `plaintext` exactly as given**, under the stamp `at` (`hlc_ms`, `hlc_ctr`),
/// for the two envelopes [`seal_batch`] will not make — ops stamped with a schema other than this
/// build's, and bytes that are not a list of ops at all. Both open under the group key, which is
/// what makes them authentic rather than altered.
#[cfg(test)]
pub(crate) fn seal_plaintext(
    group: &Group,
    device: &str,
    plaintext: &[u8],
    at: (i64, i64),
) -> Envelope {
    seal_bytes(group, device, plaintext, at).expect("sealing a test plaintext")
}

/// Open one batch.
///
/// The two refusals above the AEAD are for the *message* rather than for the security: a
/// mismatched group or epoch fails the AAD anyway, and an opaque "could not be read" is a worse
/// thing to show a reader than "your group key was rotated".
///
/// **They also make the AAD's source moot, which a mutation established.** Because both fields
/// are compared before the AEAD is reached, `group.group_id` and `envelope.group` are equal by
/// the time the associated data is built, and so are the two epochs — building it from the
/// envelope instead changed no test. The local group is still what is read, because that stays
/// correct if either check is ever relaxed and the other spelling does not.
pub fn open_batch(group: &Group, envelope: &Envelope) -> Result<Vec<Op>, WireError> {
    if envelope.group != group.group_id {
        return Err(WireError::WrongGroup);
    }
    if envelope.epoch != group.epoch {
        return Err(WireError::WrongEpoch);
    }
    let sealed = URL_SAFE_NO_PAD
        .decode(&envelope.sealed)
        .map_err(|_| WireError::Unreadable)?;
    // **The AAD is built from the LOCAL group's epoch and id**, never from the envelope's. An
    // envelope carries whatever the network handed over; binding to what this device believes
    // is what turns a relabelled blob into a failure instead of an application.
    let plaintext = crypto::open(
        &group.group_key,
        &aad(&group.group_id, &envelope.device, group.epoch),
        &sealed,
    )
    .map_err(|_| WireError::Unreadable)?;
    serde_json::from_slice(&plaintext).map_err(|e| {
        if sealed_by_a_newer_build(&plaintext) {
            WireError::Newer(e.to_string())
        } else {
            WireError::Malformed(e.to_string())
        }
    })
}

/// Whether an opened plaintext that did not parse as ops says a newer build sealed it: read as a
/// list of bare JSON values, **some element carries a `schema` above
/// [`crate::schema::USER_SCHEMA_VERSION`]** — the field [`seal_batch`] stamps on every op, which
/// a newer build stamps too. A same-version batch, one sealed before the field, and anything that
/// is not a JSON list at all answer `false`: nothing an update brings will read those, and a
/// client that held on them would pin the relay's log for good.
fn sealed_by_a_newer_build(plaintext: &[u8]) -> bool {
    let ours = Some(crate::schema::USER_SCHEMA_VERSION);
    serde_json::from_slice::<Vec<serde_json::Value>>(plaintext).is_ok_and(|ops| {
        ops.iter()
            .any(|op| op.get("schema").and_then(serde_json::Value::as_i64) > ours)
    })
}

/// Split a device's outbox into stored rows: contiguous slices, in order, covering every op once,
/// each at most [`BATCH`] ops and [`BATCH_BYTES`] of the JSON [`seal_batch`] will seal.
///
/// **Greedy, and an op over the budget on its own is a slice of its own** rather than refused
/// here: it may still be under the relay's cap (see [`BATCH_BYTES`]), and whether it is is
/// [`oversized`]'s question, asked of the slice. Never an empty slice; no ops is no slices.
///
/// ⚠️ **Slice `i` no longer starts at `i * BATCH`** — a byte cut ends a slice early — so a caller
/// that maps a slice back onto its outbox rows counts the lengths of the slices before it.
pub fn batches(ops: &[Op]) -> Vec<&[Op]> {
    let mut out = Vec::new();
    let mut start = 0;
    // The open slice's list as it would be sealed: brackets, ops, a comma between each two.
    let mut bytes = 0usize;
    for (i, op) in ops.iter().enumerate() {
        let size = op_bytes(op);
        // An open slice always takes its first op, so one over the budget opens a slice alone
        // and the next op closes it.
        if i > start
            && (i - start == BATCH || bytes.saturating_add(1).saturating_add(size) > BATCH_BYTES)
        {
            out.push(&ops[start..i]);
            start = i;
        }
        bytes = if i == start {
            size.saturating_add(2)
        } else {
            bytes.saturating_add(1).saturating_add(size)
        };
    }
    if start < ops.len() {
        out.push(&ops[start..]);
    }
    out
}

/// Whether sealing exactly `ops` would produce a `sealed` longer than [`MAX_SEALED_CHARS`] — a
/// batch the relay refuses with a 413 on every attempt, so no retry will ever send it.
///
/// **Computed, not sealed**: the stamped JSON's length, framed as [`crypto::seal`] frames it and
/// base64url'd ([`sealed_chars`]). Sealing to find out would encrypt a megabyte to learn what the
/// length already says, and [`tests::the_sealed_length_is_computed_exactly`] holds the arithmetic
/// to real envelopes. Of a slice [`batches`] cut, only a one-op slice can answer `true` — any
/// longer one is inside [`BATCH_BYTES`] — so `true` names one op too large ever to send, which is
/// what lets a push tell it from a batch that failed for a reason a retry fixes.
pub fn oversized(ops: &[Op]) -> bool {
    sealed_chars(list_bytes(ops)) > MAX_SEALED_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::hlc::Hlc;
    use crate::sync_engine::merge::Kind;
    use std::collections::BTreeMap;

    fn group(epoch: i64) -> Group {
        Group {
            group_id: "0123456789abcdef".into(),
            epoch,
            group_key: [7u8; 32],
        }
    }

    /// An op the size the wire actually carries: a collection entry with every field on it.
    fn realistic(i: usize) -> Op {
        let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        for (k, v) in [
            (
                "card_id",
                serde_json::json!("0d1b2f3a-4c5d-6e7f-8091-a2b3c4d5e6f7"),
            ),
            ("set_code", serde_json::json!("neo")),
            ("collector_number", serde_json::json!("142")),
            ("lang", serde_json::json!("en")),
            ("finish", serde_json::json!("foil")),
            ("condition", serde_json::json!("NM")),
            ("condition_original", serde_json::json!("Near Mint")),
            ("purchase_price", serde_json::json!(12.5)),
            ("purchase_currency", serde_json::json!("USD")),
            ("acquired_at", serde_json::json!("2026-02-18")),
            (
                "acquisition_source",
                serde_json::json!("Card Kingdom order 88421"),
            ),
            ("serial_number", serde_json::Value::Null),
            ("altered", serde_json::json!(0)),
            ("signed", serde_json::json!(0)),
            ("proxy", serde_json::json!(0)),
            ("misprint", serde_json::json!(0)),
            ("grading", serde_json::Value::Null),
            ("tags", serde_json::json!("[\"trade\"]")),
            (
                "notes",
                serde_json::json!("second copy for the Atraxa build"),
            ),
            ("needs_review", serde_json::Value::Null),
        ] {
            fields.insert(k.to_owned(), v);
        }
        let mut counters = BTreeMap::new();
        counters.insert("quantity".to_owned(), 1);
        let mut parents = BTreeMap::new();
        parents.insert(
            "folder".to_owned(),
            Some("aabbccddeeff00112233445566778899".to_owned()),
        );
        Op {
            table: "collection_entries".into(),
            uid: format!("{i:032x}"),
            kind: Kind::Put,
            fields,
            counters,
            parents,
            at: Hlc {
                ms: 1_787_000_000_000 + i as i64,
                ctr: 0,
                device: "0123456789abcdef".into(),
            },
            // The ordinary op this file measures: a delta out of the outbox, not a claim.
            baseline: false,
            horizon: None,
            schema: None,
        }
    }

    fn ops(n: usize) -> Vec<Op> {
        (0..n).map(realistic).collect()
    }

    /// A deck note whose body is `body` bytes of prose — the op with no size of its own. ASCII, so
    /// one byte of body is one byte of JSON and a test can pad a list to an exact length.
    fn note(i: usize, body: usize) -> Op {
        let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        fields.insert("title".to_owned(), serde_json::json!("Primer"));
        fields.insert("body".to_owned(), serde_json::json!("x".repeat(body)));
        fields.insert("sort_order".to_owned(), serde_json::json!(0));
        let mut parents = BTreeMap::new();
        parents.insert(
            "deck".to_owned(),
            Some("aabbccddeeff00112233445566778899".to_owned()),
        );
        Op {
            table: "deck_notes".into(),
            uid: format!("{i:032x}"),
            kind: Kind::Put,
            fields,
            counters: BTreeMap::new(),
            parents,
            at: Hlc {
                ms: 1_787_000_000_000 + i as i64,
                ctr: 0,
                device: "0123456789abcdef".into(),
            },
            baseline: false,
            horizon: None,
            schema: None,
        }
    }

    /// Bytes of the JSON [`seal_batch`] seals for `slice`, stamped the way it stamps — spelled out
    /// here rather than through [`stamp`], so the measure under test is checked against something
    /// it does not share.
    fn plaintext(slice: &[Op]) -> usize {
        let stamped: Vec<Op> = slice
            .iter()
            .cloned()
            .map(|mut op| {
                op.schema = Some(crate::schema::USER_SCHEMA_VERSION);
                op
            })
            .collect();
        serde_json::to_vec(&stamped).unwrap().len()
    }

    /// `cut` partitions `ops`: no empty slice, each one starting where the last ended — the same
    /// memory, not an equal copy — and every op covered once, in order.
    fn assert_partition(ops: &[Op], cut: &[&[Op]]) {
        let mut at = 0;
        for slice in cut {
            assert!(!slice.is_empty(), "an empty slice at op {at}");
            assert!(
                std::ptr::eq(slice.as_ptr(), ops[at..].as_ptr()),
                "a slice that does not start at op {at}"
            );
            at += slice.len();
        }
        assert_eq!(at, ops.len(), "every op, once");
    }

    /// Everything but the schema stamp comes back as it went, and the stamp is the one
    /// [`seal_batch`] adds — which the test below is about.
    #[test]
    fn a_batch_round_trips() {
        let g = group(0);
        let sent = ops(3);
        let envelope = seal_batch(&g, "dev-a", &sent).unwrap();
        let stamped: Vec<Op> = sent
            .iter()
            .cloned()
            .map(|mut op| {
                op.schema = Some(crate::schema::USER_SCHEMA_VERSION);
                op
            })
            .collect();
        assert_eq!(open_batch(&g, &envelope).unwrap(), stamped);
    }

    /// **Every op sealed says which schema wrote it, and an op from before the field reads as
    /// not newer.** The stamp goes on at sealing and never at capture, so an outbox an older
    /// build wrote is stamped by the build that sends it; and a receiver compares
    /// `op.schema > Some(USER_SCHEMA_VERSION)`, which an absent key never is.
    #[test]
    fn a_sealed_op_carries_this_builds_schema_and_an_old_op_reads_as_none() {
        let g = group(0);
        let sent = ops(2);
        assert!(
            sent.iter().all(|op| op.schema.is_none()),
            "the outbox never holds a stamp"
        );
        let opened = open_batch(&g, &seal_batch(&g, "dev-a", &sent).unwrap()).unwrap();
        for op in &opened {
            assert_eq!(op.schema, Some(crate::schema::USER_SCHEMA_VERSION));
        }

        // What every build before this one put on the wire: no `schema` key at all.
        let old: Op = serde_json::from_str(
            r#"{"table":"decks","uid":"u1","kind":"put","at":{"ms":1,"ctr":0,"device":"d"}}"#,
        )
        .unwrap();
        assert_eq!(old.schema, None);
        // ...and an unstamped op keeps that shape, so a peer that reads it changes nothing.
        let json = serde_json::to_string(&sent[0]).unwrap();
        assert!(!json.contains("\"schema\""), "{json}");
    }

    /// **A batch that opens and does not parse is `Newer` only when an op in it says so** — a
    /// `schema` above this build's, read off the bare JSON. This build's schema, no schema at all,
    /// and bytes that are not a list are `Malformed`: nothing an update brings will read them, and
    /// the client steps over a `Malformed` batch where it holds on a `Newer` one.
    #[test]
    fn a_batch_that_does_not_parse_is_newer_only_when_an_op_says_so() {
        let g = group(0);
        let ours = crate::schema::USER_SCHEMA_VERSION;
        let seal = |plaintext: &str| seal_plaintext(&g, "dev-a", plaintext.as_bytes(), (1, 0));
        let op = |schema: &str| {
            format!(
                r#"{{"table":"decks","uid":"u1","kind":"merge","at":{{"ms":1,"ctr":0,"device":"d"}}{schema}}}"#
            )
        };
        let newer = seal(&format!("[{}]", op(&format!(r#","schema":{}"#, ours + 1))));
        assert!(
            matches!(open_batch(&g, &newer), Err(WireError::Newer(_))),
            "{:?}",
            open_batch(&g, &newer)
        );
        for (what, plaintext) in [
            (
                "this build's",
                format!("[{}]", op(&format!(r#","schema":{ours}"#))),
            ),
            ("none", format!("[{}]", op(""))),
            ("not a list", r#"{"schema":999999}"#.to_owned()),
        ] {
            let opened = open_batch(&g, &seal(&plaintext));
            assert!(
                matches!(opened, Err(WireError::Malformed(_))),
                "{what}: {opened:?}"
            );
        }
    }

    /// The envelope's stamp is the **last** op's, which is the relay's ordering key.
    #[test]
    fn the_envelope_carries_the_last_stamp_inside_it() {
        let g = group(0);
        let sent = ops(5);
        let envelope = seal_batch(&g, "dev-a", &sent).unwrap();
        let last = sent.iter().map(|o| &o.at).max().unwrap();
        assert_eq!((envelope.hlc_ms, envelope.hlc_ctr), (last.ms, last.ctr));
    }

    /// **A batch sealed under epoch 1 does not open under epoch 2**, which is what makes
    /// revocation mean something on the wire rather than only in the roster.
    #[test]
    fn a_batch_from_before_a_rotation_is_refused() {
        let envelope = seal_batch(&group(1), "dev-a", &ops(1)).unwrap();
        assert_eq!(open_batch(&group(2), &envelope), Err(WireError::WrongEpoch));
    }

    /// ...and the refusal is **cryptographic and not a field comparison**. Relabelling the
    /// envelope's epoch gets past the check above and fails the AEAD, because the associated
    /// data is built from what this device believes rather than from what arrived.
    #[test]
    fn relabelling_the_epoch_fails_the_associated_data() {
        let mut envelope = seal_batch(&group(1), "dev-a", &ops(1)).unwrap();
        envelope.epoch = 2;
        assert_eq!(open_batch(&group(2), &envelope), Err(WireError::Unreadable));
    }

    /// A batch addressed to another group is refused by name...
    #[test]
    fn a_batch_for_another_group_is_refused() {
        let mut envelope = seal_batch(&group(0), "dev-a", &ops(1)).unwrap();
        envelope.group = "ffffffffffffffff".into();
        assert_eq!(open_batch(&group(0), &envelope), Err(WireError::WrongGroup));
    }

    /// ...and a group id that matches by name but not by key is refused by the AEAD.
    #[test]
    fn another_groups_key_cannot_open_it() {
        let envelope = seal_batch(&group(0), "dev-a", &ops(1)).unwrap();
        let stranger = Group {
            group_key: [9u8; 32],
            ..group(0)
        };
        assert_eq!(open_batch(&stranger, &envelope), Err(WireError::Unreadable));
    }

    /// **The device id is bound in**, so a relay that relabelled who wrote a batch produces one
    /// that will not open. That matters because `device` is what a puller filters its own rows
    /// out by: a relabelled batch is a device being handed back its own ops.
    #[test]
    fn a_tampered_device_fails_the_associated_data() {
        let g = group(0);
        let mut envelope = seal_batch(&g, "dev-a", &ops(1)).unwrap();
        envelope.device = "dev-b".into();
        assert_eq!(open_batch(&g, &envelope), Err(WireError::Unreadable));
    }

    /// **The group id is bound in too**, which the key alone does not cover: two groups that
    /// somehow shared a key would otherwise read each other's ops. Contrived, and it is one
    /// term in a format string against a failure that would be silent and total.
    #[test]
    fn a_relabelled_group_fails_the_associated_data() {
        let sender = group(0);
        let envelope = seal_batch(&sender, "dev-a", &ops(1)).unwrap();
        let other = Group {
            group_id: "fedcba9876543210".into(),
            ..group(0)
        };
        let relabelled = Envelope {
            group: other.group_id.clone(),
            ..envelope
        };
        assert_eq!(open_batch(&other, &relabelled), Err(WireError::Unreadable));
    }

    /// A flipped bit in the ciphertext is a refusal, not a partial read.
    #[test]
    fn a_tampered_ciphertext_is_refused() {
        let g = group(0);
        let mut envelope = seal_batch(&g, "dev-a", &ops(1)).unwrap();
        let mut raw = URL_SAFE_NO_PAD.decode(&envelope.sealed).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        envelope.sealed = URL_SAFE_NO_PAD.encode(raw);
        assert_eq!(open_batch(&g, &envelope), Err(WireError::Unreadable));
    }

    #[test]
    fn a_batch_larger_than_the_limit_is_refused() {
        let g = group(0);
        assert_eq!(
            seal_batch(&g, "dev-a", &ops(BATCH + 1)),
            Err(WireError::TooBig(BATCH + 1))
        );
        assert!(seal_batch(&g, "dev-a", &ops(BATCH)).is_ok());
        assert_eq!(seal_batch(&g, "dev-a", &[]), Err(WireError::Empty));
    }

    /// `batches` splits an outbox into stored rows, and 50 000 ops is 250 of them — the
    /// arithmetic spec §7.7 derives the batch size from, asserted rather than quoted. On ops the
    /// measured size the count cuts every slice and the byte budget none. (Cutting all 50 000
    /// measured 2.9 s in a debug build on Linux, and proves nothing these 401 do not — every one
    /// of them is the same size.)
    #[test]
    fn fifty_thousand_ops_are_two_hundred_and_fifty_stored_rows() {
        assert_eq!(50_000_usize.div_ceil(BATCH), 250);
        let n = ops(2 * BATCH + 1);
        let cut = batches(&n);
        assert_partition(&n, &cut);
        let sizes: Vec<usize> = cut.iter().map(|slice| slice.len()).collect();
        assert_eq!(sizes, vec![BATCH, BATCH, 1]);
        assert!(
            batches(&[]).is_empty(),
            "no ops is no rows, not one empty one"
        );
    }

    /// **Bytes cut a batch the count would have let through.** Twelve deck notes of 100 KiB are
    /// far under 200 ops and far over one budget: five fit and a sixth would not. Every slice is
    /// inside [`BATCH_BYTES`] as sealed, and every slice but the last is as full as it can be —
    /// the next op would have broken the budget — so the cut spends no more rows than it must.
    #[test]
    fn bytes_cut_a_batch_before_the_count_does() {
        let notes: Vec<Op> = (0..12).map(|i| note(i, 100 * 1024)).collect();
        let cut = batches(&notes);
        assert_partition(&notes, &cut);
        let sizes: Vec<usize> = cut.iter().map(|slice| slice.len()).collect();
        assert_eq!(sizes, [5, 5, 2]);

        let mut end = 0;
        for slice in &cut {
            let start = end;
            end += slice.len();
            let bytes = plaintext(slice);
            assert_eq!(list_bytes(slice), bytes, "the measure is what is sealed");
            assert!(
                bytes <= BATCH_BYTES,
                "{bytes} B against a {BATCH_BYTES} B budget"
            );
            if end < notes.len() {
                assert!(
                    plaintext(&notes[start..=end]) > BATCH_BYTES,
                    "a slice closed before it was full"
                );
            }
            assert!(!oversized(slice));
        }
    }

    /// **An op over the budget goes alone, and only one over the cap is `oversized`.** A 700 KiB
    /// note is past the budget and inside the cap: alone, it seals short of [`MAX_SEALED_CHARS`]
    /// and the relay takes it. A 2 MiB note is past both, and no cut can save it. Neither pulls a
    /// neighbour into its slice, and the ordinary ops around them still batch together.
    #[test]
    fn an_op_over_the_budget_goes_alone_and_only_one_over_the_cap_is_oversized() {
        let g = group(0);
        let outbox = [
            note(0, 10),
            note(1, 10),
            note(2, 700 * 1024),
            note(3, 10),
            note(4, 2 * 1024 * 1024),
            note(5, 10),
            note(6, 10),
        ];
        let cut = batches(&outbox);
        assert_partition(&outbox, &cut);
        let sizes: Vec<usize> = cut.iter().map(|slice| slice.len()).collect();
        assert_eq!(sizes, [2, 1, 1, 1, 2]);

        let past_the_budget = cut[1];
        assert!(!oversized(past_the_budget));
        let sealed = seal_batch(&g, "dev-a", past_the_budget).unwrap().sealed;
        assert!(sealed.len() <= MAX_SEALED_CHARS, "{} chars", sealed.len());

        // Not sealed to prove it: `oversized_turns_at_exactly_the_relays_cap` holds the
        // arithmetic to a real envelope at the cap itself.
        assert!(oversized(cut[3]));

        for ordinary in [cut[0], cut[2], cut[4]] {
            assert!(!oversized(ordinary));
        }
    }

    /// **`oversized` is arithmetic, and this holds it to real envelopes** — the stamped JSON's
    /// length, [`crypto::seal`]'s nonce and tag, base64url without padding — to the character,
    /// across all three ways base64 rounds (a sealed length of 3k, 3k+1 and 3k+2 bytes), and for
    /// an op that already carries a stamp, which sealing replaces rather than adds to.
    #[test]
    fn the_sealed_length_is_computed_exactly() {
        let g = group(0);
        let mut remainders = std::collections::BTreeSet::new();
        for pad in 0..3 {
            let mut restamped = note(2, pad);
            restamped.schema = Some(1);
            for batch in [
                vec![note(0, pad)],
                vec![realistic(0), note(1, 40 + pad)],
                vec![restamped],
            ] {
                let envelope = seal_batch(&g, "0123456789abcdef", &batch).unwrap();
                assert_eq!(list_bytes(&batch), plaintext(&batch));
                assert_eq!(sealed_chars(list_bytes(&batch)), envelope.sealed.len());
                remainders.insert((list_bytes(&batch) + AEAD_OVERHEAD) % 3);
            }
        }
        assert_eq!(remainders.len(), 3, "every base64 remainder, measured");
    }

    /// **`oversized` turns at the relay's cap to the byte.** A note padded until its list is the
    /// largest plaintext that seals inside [`MAX_SEALED_CHARS`] — ⌊1 500 000 × 3/4⌋ less the
    /// nonce and tag — seals to exactly the cap and is not oversized; one byte more is. The two
    /// figures [`BATCH_BYTES`]'s doc quotes are asserted beside it.
    #[test]
    fn oversized_turns_at_exactly_the_relays_cap() {
        let largest = MAX_SEALED_CHARS * 3 / 4 - AEAD_OVERHEAD;
        assert_eq!(largest, 1_124_960);
        let pad = largest - list_bytes(&[note(0, 0)]);

        let fits = [note(0, pad)];
        assert_eq!(list_bytes(&fits), largest);
        assert!(!oversized(&fits));
        let envelope = seal_batch(&group(0), "dev-a", &fits).unwrap();
        assert_eq!(envelope.sealed.len(), MAX_SEALED_CHARS);

        assert!(oversized(&[note(0, pad + 1)]));
        assert_eq!(sealed_chars(BATCH_BYTES), 699_104);
    }

    /// **The cap is the relay's, read out of the relay's own source**, so moving it on one side is
    /// red on the other rather than a push that fails in the field or an op given up on for
    /// nothing.
    #[test]
    fn the_sealed_cap_is_the_relays() {
        let relay = include_str!("../../../relay/src/log.ts");
        assert_eq!(MAX_SEALED_CHARS, 1_500_000);
        assert!(
            relay.contains("export const MAX_SEALED_CHARS = 1_500_000;"),
            "relay/src/log.ts no longer exports the cap `batches` and `oversized` cut against"
        );
    }

    /// **A full batch measured, not estimated.** Two hundred realistic collection ops, sealed:
    /// the number printed here is what a stored relay row actually costs, and the assertion is
    /// against the Durable Object's 2 MB per-row cap — and against the relay's own, which is
    /// tighter, and the byte budget, which on ops like these never binds.
    #[test]
    fn a_full_batch_is_far_below_the_two_megabyte_row_cap() {
        let g = group(0);
        let batch = ops(BATCH);
        let plain = serde_json::to_vec(&batch).unwrap().len();
        let envelope = seal_batch(&g, "0123456789abcdef", &batch).unwrap();
        let row = serde_json::to_vec(&envelope).unwrap().len();
        eprintln!(
            "{BATCH} ops: {plain} B of JSON ({} B/op), {} B sealed and base64url'd, \
             {row} B as a stored row",
            plain / BATCH,
            envelope.sealed.len()
        );
        assert!(
            row < 2 * 1024 * 1024,
            "a stored row is {row} B against a 2 MB cap"
        );
        assert!(!oversized(&batch));
        assert!(envelope.sealed.len() < MAX_SEALED_CHARS);
        assert_eq!(batches(&batch).len(), 1, "the count binds, not the bytes");
    }

    /// **The relay is told six things and no seventh.** The op count is deliberately not one of
    /// them: "this device wrote 431 things today" is not needed in order to relay.
    #[test]
    fn the_envelope_tells_the_relay_six_things() {
        let envelope = seal_batch(&group(0), "dev-a", &ops(4)).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&envelope).unwrap()).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["device", "epoch", "group", "hlcCtr", "hlcMs", "sealed"]
        );
    }

    /// The sealed blob is base64url with no padding, so it can be a path segment or a JSON
    /// string without anything having to escape it.
    #[test]
    fn the_sealed_blob_is_url_safe() {
        let envelope = seal_batch(&group(0), "dev-a", &ops(2)).unwrap();
        assert!(
            envelope
                .sealed
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "not url-safe: {}",
            envelope.sealed
        );
    }
}
