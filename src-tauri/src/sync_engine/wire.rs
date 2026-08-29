//! The encrypted envelope, batched at 200 ops per stored row.
//!
//! **200 is derived from the write limit and checked against the row cap, not the other way
//! round.** The free tier allows 100 000 Durable Object rows written per day. A 50 000-row bulk
//! import at one op per stored row would spend half of that; at 200 it is 250 writes. The
//! measured average op is ~453 bytes, so a full batch is ~90 KB against the 2 MB per-row cap —
//! the cap is not the binding constraint, and spec §7.7 says there is no separate snapshot
//! artifact for it to bind on. [`tests::a_full_batch_is_far_below_the_two_megabyte_row_cap`]
//! measures a real one rather than quoting that arithmetic.

use crate::sync_engine::merge::Op;
use crate::sync_pair::crypto;
use crate::sync_pair::identity::Group;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// Ops per stored relay row. See the module doc — it is arithmetic, not tidiness.
pub const BATCH: usize = 200;

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
    #[error("that batch is not a list of ops: {0}")]
    Malformed(String),
}

/// The associated data every envelope is bound to.
///
/// **The epoch is in here and that is what makes revocation mean something on the wire.**
/// Rotating the group key already stops a removed device reading anything new; binding the
/// epoch stops the *reverse* — a blob written before the rotation being replayed at a device
/// that has moved on, which the key alone cannot refuse because the ciphertext predates it.
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
pub fn seal_batch(group: &Group, device: &str, ops: &[Op]) -> Result<Envelope, WireError> {
    if ops.is_empty() {
        return Err(WireError::Empty);
    }
    if ops.len() > BATCH {
        return Err(WireError::TooBig(ops.len()));
    }
    let plaintext = serde_json::to_vec(ops).map_err(|e| WireError::Malformed(e.to_string()))?;
    let sealed = crypto::seal(
        &group.group_key,
        &aad(&group.group_id, device, group.epoch),
        &plaintext,
    )
    .map_err(|_| WireError::Unreadable)?;
    // The last op's stamp, which is this batch's ordering key. `ops` is non-empty.
    let last = ops
        .iter()
        .map(|o| &o.at)
        .max()
        .expect("a non-empty batch has a latest stamp");
    Ok(Envelope {
        group: group.group_id.clone(),
        device: device.to_owned(),
        epoch: group.epoch,
        hlc_ms: last.ms,
        hlc_ctr: last.ctr,
        sealed: URL_SAFE_NO_PAD.encode(sealed),
    })
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
    serde_json::from_slice(&plaintext).map_err(|e| WireError::Malformed(e.to_string()))
}

/// Split a device's outbox into stored rows.
pub fn batches(ops: &[Op]) -> impl Iterator<Item = &[Op]> {
    ops.chunks(BATCH)
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
        }
    }

    fn ops(n: usize) -> Vec<Op> {
        (0..n).map(realistic).collect()
    }

    #[test]
    fn a_batch_round_trips() {
        let g = group(0);
        let sent = ops(3);
        let envelope = seal_batch(&g, "dev-a", &sent).unwrap();
        assert_eq!(open_batch(&g, &envelope).unwrap(), sent);
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
    /// arithmetic spec §7.7 derives the batch size from, asserted rather than quoted.
    #[test]
    fn fifty_thousand_ops_are_two_hundred_and_fifty_stored_rows() {
        let all = ops(1);
        assert_eq!(batches(&all).count(), 1);
        assert_eq!(50_000_usize.div_ceil(BATCH), 250);
        let n = ops(BATCH + 1);
        let sizes: Vec<usize> = batches(&n).map(<[Op]>::len).collect();
        assert_eq!(sizes, vec![BATCH, 1]);
    }

    /// **A full batch measured, not estimated.** Two hundred realistic collection ops, sealed:
    /// the number printed here is what a stored relay row actually costs, and the assertion is
    /// against the Durable Object's 2 MB per-row cap.
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
