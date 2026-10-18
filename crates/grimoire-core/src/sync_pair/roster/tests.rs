//! The roster document's bytes, its acceptance rule, and what this device keeps of it.

use super::*;

/// `src/__golden__/roster-v1.json`, which the relay's suite reads too.
const GOLDEN: &str = include_str!("../../__golden__/roster-v1.json");

fn golden() -> serde_json::Value {
    serde_json::from_str(GOLDEN).unwrap()
}

fn s(v: &serde_json::Value, path: &[&str]) -> String {
    let mut at = v;
    for p in path {
        at = &at[*p];
    }
    at.as_str().unwrap_or_else(|| panic!("{path:?}")).to_owned()
}

fn hex32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

const A: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const B: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const BOT: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const GROUP: &str = "0123456789abcdef0123456789abcdef";

fn member(device: &str, x: u8, ed: Option<[u8; 32]>, cap: &str, proto: i64, since: i64) -> Member {
    Member {
        device: device.into(),
        x25519: key_text(&[x; 32]),
        ed25519: ed.map(|k| key_text(&k)),
        cap: cap.into(),
        proto,
        since,
    }
}

/// The golden pair, built from its parts: a group's first document, open, and the signed one
/// that follows it and names a `read` member.
fn golden_pair() -> (Roster, Roster) {
    let a_pub = crypto::signing_public(&[0x11; 32]);
    let open = Roster {
        v: VERSION,
        group: GROUP.into(),
        epoch: 3,
        step: 0,
        prev: None,
        mode: Mode::Open,
        signer: A.into(),
        members: vec![
            member(A, 1, Some(a_pub), FULL, 2, 0),
            member(B, 2, None, FULL, 0, 3),
        ],
    };
    let mut signed = open.clone();
    signed.epoch = 4;
    signed.prev = Some(hash(&to_text(&open)));
    signed.mode = Mode::Signed;
    signed.members.push(member(
        BOT,
        3,
        Some(crypto::signing_public(&[0x22; 32])),
        READ,
        2,
        4,
    ));
    (open, signed)
}

/// ⚠ **The bytes are a wire to the relay and to every later build**, pinned in a file both suites
/// read: the document's characters (field order, compactness, `null` for an absent key), its
/// hash, the MAC key, the MAC and the signature. **What makes it red**: reordering a field of
/// `Roster` or `Member`, a different HKDF salt or info, the domain tag, or base64 with padding.
#[test]
fn the_documents_bytes_and_authenticators_are_pinned() {
    let g = golden();
    let key = hex32(&s(&g, &["groupKeyHex"]));
    let (open, signed) = golden_pair();

    assert_eq!(to_text(&open), s(&g, &["open", "roster"]));
    assert_eq!(hash(&to_text(&open)), s(&g, &["open", "hash"]));
    assert_eq!(
        hex(&mac_key(&key, &s(&g, &["groupId"]))),
        s(&g, &["open", "macKeyHex"])
    );
    let tag = mac(&key, GROUP, &to_text(&open));
    assert_eq!(tag, s(&g, &["open", "rosterMac"]));
    assert_eq!(tag.len(), 43);

    assert_eq!(to_text(&signed), s(&g, &["signed", "roster"]));
    assert_eq!(hash(&to_text(&signed)), s(&g, &["signed", "hash"]));
    let seed = hex32(&s(&g, &["signed", "signerSeedHex"]));
    assert_eq!(
        key_text(&crypto::signing_public(&seed)),
        s(&g, &["signed", "signerPublic"])
    );
    let sig = sign(&seed, &to_text(&signed));
    assert_eq!(sig, s(&g, &["signed", "rosterSig"]));
    assert_eq!(sig.len(), 86);

    let mut covered = s(&g, &["signingDomain"]).into_bytes();
    covered.push(0);
    covered.extend_from_slice(s(&g, &["signed", "roster"]).as_bytes());
    assert_eq!(signing_bytes(&to_text(&signed)), covered);
    assert_eq!(s(&g, &["macInfo"]).as_bytes(), INFO_MAC);
}

/// **Lenient for fields it does not know, strict about what it says**: an extra field at either
/// level is dropped, and a `v` other than 1 or a mode word it does not know is no document.
#[test]
fn a_document_is_read_leniently_and_refused_strictly() {
    let (open, _) = golden_pair();
    let mut v: serde_json::Value = serde_json::from_str(&to_text(&open)).unwrap();
    v["later"] = serde_json::json!({ "anything": true });
    v["members"][0]["also"] = serde_json::json!(1);
    assert_eq!(parse(&v.to_string()), Some(open.clone()));

    let mut two = v.clone();
    two["v"] = serde_json::json!(2);
    assert_eq!(parse(&two.to_string()), None);
    let mut word = v.clone();
    word["mode"] = serde_json::json!("closed");
    assert_eq!(parse(&word.to_string()), None);
    assert_eq!(parse("not json"), None);
}

fn stored_mac(rd: &Roster, key: &[u8; 32]) -> Stored {
    let text = to_text(rd);
    Stored {
        mac: Some(mac(key, &rd.group, &text)),
        sig: None,
        text,
    }
}

fn stored_sig(rd: &Roster, seed: &[u8; 32]) -> Stored {
    let text = to_text(rd);
    Stored {
        sig: Some(sign(seed, &text)),
        mac: None,
        text,
    }
}

fn judged(
    mode: Mode,
    last: Option<&(String, Roster)>,
    restricted: &[&str],
    anchors: &[(String, [u8; 32])],
    stored: &Stored,
    key: Option<[u8; 32]>,
) -> Verdict {
    let restricted: BTreeSet<String> = restricted.iter().map(|s| (*s).to_owned()).collect();
    let trust = Trust {
        group_id: GROUP,
        mode,
        last,
        restricted_ever: &restricted,
        anchors,
    };
    judge(&trust, stored, &|_| key)
}

/// **Open mode: the MAC under the document's epoch key**, and nothing else is needed — no chain,
/// because a device behind the relay's walk must still be able to catch up. Without the key it
/// is *later*, never a refusal; with the wrong key, or bent by a byte, it is a forgery.
#[test]
fn an_open_document_is_taken_on_its_epochs_mac() {
    let key = [9u8; 32];
    let (open, _) = golden_pair();
    let good = stored_mac(&open, &key);
    assert_eq!(
        judged(Mode::Open, None, &[], &[], &good, Some(key)),
        Verdict::Accept(open.clone())
    );
    assert_eq!(
        judged(Mode::Open, None, &[], &[], &good, None),
        Verdict::Later
    );
    assert_eq!(
        judged(Mode::Open, None, &[], &[], &good, Some([8u8; 32])),
        Verdict::Refuse(FORGED)
    );
    let mut bent = good.clone();
    bent.text = bent.text.replacen("\"proto\":0", "\"proto\":2", 1);
    assert_eq!(
        judged(Mode::Open, None, &[], &[], &bent, Some(key)),
        Verdict::Refuse(FORGED)
    );
    let mut other = open.clone();
    other.group = "ffffffffffffffffffffffffffffffff".into();
    assert_eq!(
        judged(
            Mode::Open,
            None,
            &[],
            &[],
            &stored_mac(&other, &key),
            Some(key)
        ),
        Verdict::Refuse(WRONG_GROUP)
    );
}

/// **Signed mode: a full member of the last accepted document signed it, and it follows that
/// document.** The golden pair is exactly that. **What makes it red**: accepting a signer the last
/// document does not name as full, a `prev` that does not chain, or a bent signature.
#[test]
fn a_signed_document_needs_a_full_member_of_the_last_and_the_chain() {
    let (open, signed) = golden_pair();
    let last = (to_text(&open), open.clone());
    let good = stored_sig(&signed, &[0x11; 32]);
    assert_eq!(
        judged(Mode::Open, Some(&last), &[], &[], &good, None),
        Verdict::Accept(signed.clone()),
        "the first signed document is taken while still open — the latch follows it"
    );

    // Signed by B: full in the last document, but it holds no signing key there or here.
    let by_b = Roster {
        signer: B.into(),
        ..signed.clone()
    };
    assert_eq!(
        judged(
            Mode::Open,
            Some(&last),
            &[],
            &[],
            &stored_sig(&by_b, &[0x33; 32]),
            None
        ),
        Verdict::Refuse(NOT_SIGNED_BY_A_FULL_MEMBER)
    );

    // Out of the chain.
    let forked = Roster {
        prev: Some(hash("something else")),
        ..signed.clone()
    };
    assert_eq!(
        judged(
            Mode::Open,
            Some(&last),
            &[],
            &[],
            &stored_sig(&forked, &[0x11; 32]),
            None
        ),
        Verdict::Refuse(OUT_OF_CHAIN)
    );

    // A bent signature.
    let mut bent = good.clone();
    bent.sig = Some(sign(&[0x44; 32], &good.text));
    assert_eq!(
        judged(Mode::Open, Some(&last), &[], &[], &bent, None),
        Verdict::Refuse(FORGED)
    );

    // No authenticator at all, or only a MAC: a signed document takes no MAC.
    let mac_only = stored_mac(&signed, &[9u8; 32]);
    assert_eq!(
        judged(
            Mode::Open,
            Some(&last),
            &[],
            &[],
            &mac_only,
            Some([9u8; 32])
        ),
        Verdict::Refuse(NOT_SIGNED_BY_A_FULL_MEMBER)
    );
}

/// ⚠ **A `read` member's signature moves nothing** — not on a rotation, not on an amendment of
/// its own, and not by being named full again. This is F2 closed at the document.
#[test]
fn a_restricted_member_can_neither_sign_nor_come_back_full() {
    let (_, signed) = golden_pair();
    let last = (to_text(&signed), signed.clone());

    let mut by_bot = signed.clone();
    by_bot.epoch = 5;
    by_bot.prev = Some(hash(&last.0));
    by_bot.signer = BOT.into();
    by_bot.members.retain(|m| m.device != A);
    assert_eq!(
        judged(
            Mode::Signed,
            Some(&last),
            &[BOT],
            &[],
            &stored_sig(&by_bot, &[0x22; 32]),
            None
        ),
        Verdict::Refuse(NOT_SIGNED_BY_A_FULL_MEMBER)
    );

    let mut promoted = signed.clone();
    promoted.epoch = 5;
    promoted.prev = Some(hash(&last.0));
    promoted.members[2].cap = FULL.into();
    assert_eq!(
        judged(
            Mode::Signed,
            Some(&last),
            &[],
            &[],
            &stored_sig(&promoted, &[0x11; 32]),
            None
        ),
        Verdict::Refuse(CAME_BACK_FULL),
        "restricted in the last document, full in this one"
    );
    assert_eq!(
        judged(
            Mode::Signed,
            None,
            &[BOT],
            &[(A.to_owned(), crypto::signing_public(&[0x11; 32]))],
            &stored_sig(&promoted, &[0x11; 32]),
            None
        ),
        Verdict::Refuse(CAME_BACK_FULL),
        "restricted once, ever, on this device"
    );
}

/// **The latch, and the order.** In signed mode an open document is refused however good its
/// MAC; behind the last accepted one, any document is stale and silent.
#[test]
fn the_mode_is_a_latch_and_the_walk_is_ordered() {
    let key = [9u8; 32];
    let (open, signed) = golden_pair();
    let last = (to_text(&signed), signed.clone());
    let mut later_open = open.clone();
    later_open.epoch = 5;
    assert_eq!(
        judged(
            Mode::Signed,
            Some(&last),
            &[],
            &[],
            &stored_mac(&later_open, &key),
            Some(key)
        ),
        Verdict::Refuse(BACK_TO_OPEN)
    );
    assert_eq!(
        judged(
            Mode::Signed,
            Some(&last),
            &[],
            &[],
            &stored_sig(&signed, &[0x11; 32]),
            None
        ),
        Verdict::Stale
    );
}

/// **A device with no document yet trusts only the full devices it holds a key for** — the
/// pairing's sealed slot. Anyone else's signature is refused.
#[test]
fn the_first_signed_document_is_anchored_by_a_key_this_device_already_holds() {
    let (_, signed) = golden_pair();
    let good = stored_sig(&signed, &[0x11; 32]);
    let anchors = [(A.to_owned(), crypto::signing_public(&[0x11; 32]))];
    assert_eq!(
        judged(Mode::Signed, None, &[], &anchors, &good, None),
        Verdict::Accept(signed.clone())
    );
    assert_eq!(
        judged(Mode::Signed, None, &[], &[], &good, None),
        Verdict::Refuse(NOT_SIGNED_BY_A_FULL_MEMBER)
    );
}

// ---------------------------------------------------------------------------------------
// What this device keeps
// ---------------------------------------------------------------------------------------

/// A device in a group of one, at epoch 0, with a real identity.
fn device() -> (Connection, identity::Identity, Group) {
    let conn = crate::schema::memory_pair();
    let me = identity::ensure(&conn).unwrap();
    let group = identity::create_group(&conn, &me).unwrap();
    (conn, me, group)
}

fn sync_state(conn: &Connection, key: &str) -> Option<String> {
    state(conn, key).unwrap()
}

/// ⚠ **F1 fixed: a document names a member this device never paired, and the row arrives** —
/// its X25519 key, its signing key, its level, and *Paired device* until a synced name does.
#[test]
fn an_accepted_document_puts_a_member_this_device_never_met_on_its_roster() {
    let (conn, me, group) = device();
    let c_sign = crypto::signing_keypair();
    let rd = Roster {
        v: VERSION,
        group: group.group_id.clone(),
        epoch: group.epoch,
        step: 0,
        prev: None,
        mode: Mode::Open,
        signer: me.device_id.clone(),
        members: vec![
            member(&me.device_id, 1, None, FULL, 2, 0),
            member("dev-c", 5, Some(c_sign.public), FULL, 2, 0),
        ],
    };
    accept(&conn, &to_text(&rd), &rd, true).unwrap();

    let c = identity::roster(&conn)
        .unwrap()
        .into_iter()
        .find(|d| d.device_id == "dev-c")
        .expect("the member a sibling paired is on this roster now");
    assert_eq!(c.public_key, [5u8; 32]);
    assert_eq!(c.sign_public, Some(c_sign.public));
    assert_eq!(c.proto, Some(2));
    assert_eq!(c.capability, None);
    assert_eq!(c.name, crate::sync_pair::pairing::DEFAULT_PEER_NAME);
    assert_eq!(
        identity::public_identity(&conn).unwrap().unwrap().1,
        me.keypair.public,
        "this device's own row is never rewritten from a document"
    );
    assert_eq!(last(&conn).unwrap().unwrap().1, rd);
    assert_eq!(mode(&conn), Mode::Open);
}

/// ⚠ **A key on file is never replaced by a document**: a member's X25519 key filed at a pairing
/// would otherwise be redirected — and the next rotation's blob with it. A missing signing key is
/// filled in; a different one is left, and recorded.
#[test]
fn a_document_never_replaces_a_key_this_device_already_holds() {
    let (conn, me, group) = device();
    identity::add_device(&conn, "dev-b", &[2u8; 32], "B").unwrap();
    let held = crypto::signing_keypair();
    identity::file_sign_key(&conn, "dev-b", &held.public, Some(2)).unwrap();
    let rd = Roster {
        v: VERSION,
        group: group.group_id.clone(),
        epoch: group.epoch,
        step: 0,
        prev: None,
        mode: Mode::Open,
        signer: me.device_id.clone(),
        members: vec![member("dev-b", 2, Some([7u8; 32]), FULL, 2, 0)],
    };
    accept(&conn, &to_text(&rd), &rd, true).unwrap();
    let b = identity::roster(&conn)
        .unwrap()
        .into_iter()
        .find(|d| d.device_id == "dev-b")
        .unwrap();
    assert_eq!(
        b.sign_public,
        Some(held.public),
        "the paired key was replaced"
    );

    let mut swapped = rd.clone();
    swapped.step = 1;
    swapped.members[0].x25519 = key_text(&[6u8; 32]);
    accept(&conn, &to_text(&swapped), &swapped, true).unwrap();
    let b = identity::roster(&conn)
        .unwrap()
        .into_iter()
        .find(|d| d.device_id == "dev-b")
        .unwrap();
    assert_eq!(
        b.public_key, [2u8; 32],
        "the paired X25519 key was replaced"
    );
    let rows: i64 = conn
        .query_row(
            "SELECT count(*) FROM error_log WHERE operation = 'roster'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "one sentence for the disagreement, folded");
}

/// ⚠ **A device this device removed is never put back by a document from the epoch it was
/// removed at or before** — the walk hands such documents back in order. One from a later epoch
/// (a re-pair, published) may name it again.
#[test]
fn a_removed_device_is_not_put_back_by_an_older_document() {
    let (conn, me, group) = device();
    identity::add_device(&conn, "tablet", &[8u8; 32], "Tablet").unwrap();
    let removal = identity::plan_rotation(&conn, "tablet").unwrap();
    identity::commit_rotation(&conn, "tablet", &removal).unwrap();
    let at = identity::group(&conn).unwrap().unwrap().epoch;

    let older = Roster {
        v: VERSION,
        group: group.group_id.clone(),
        epoch: at,
        step: 1,
        prev: None,
        mode: Mode::Open,
        signer: me.device_id.clone(),
        members: vec![member("tablet", 8, None, FULL, 0, 0)],
    };
    accept(&conn, &to_text(&older), &older, true).unwrap();
    assert!(
        !identity::roster(&conn)
            .unwrap()
            .iter()
            .any(|d| d.device_id == "tablet"),
        "a document from the removal's own epoch put the removed device back"
    );

    let later = Roster {
        epoch: at + 1,
        step: 0,
        ..older.clone()
    };
    accept(&conn, &to_text(&later), &later, true).unwrap();
    assert!(
        identity::roster(&conn)
            .unwrap()
            .iter()
            .any(|d| d.device_id == "tablet"),
        "a later document is a later decision"
    );
}

/// **The latch, `restricted_ever`, and what forgets what.** A signed document latches the mode
/// at its epoch and remembers its restricted members; leaving the group forgets the mode and
/// the chain — and **never** who was restricted.
#[test]
fn signed_mode_latches_and_a_restriction_is_never_forgotten() {
    let (conn, me, group) = device();
    let rd = Roster {
        v: VERSION,
        group: group.group_id.clone(),
        epoch: 4,
        step: 0,
        prev: None,
        mode: Mode::Signed,
        signer: me.device_id.clone(),
        members: vec![
            member(&me.device_id, 1, None, FULL, 2, 0),
            member("bot", 3, None, READ, 2, 4),
        ],
    };
    accept(&conn, &to_text(&rd), &rd, false).unwrap();
    assert_eq!(mode(&conn), Mode::Signed);
    assert!(requires_signatures(&conn, 4));
    assert!(!requires_signatures(&conn, 3), "before the latch, open");
    assert!(is_restricted(&conn, "bot").unwrap());

    let mut open = rd.clone();
    open.mode = Mode::Open;
    accept(&conn, &to_text(&open), &open, false).unwrap();
    assert_eq!(
        mode(&conn),
        Mode::Signed,
        "accepting never relaxes the latch"
    );

    identity::leave_group(&conn).unwrap();
    assert_eq!(mode(&conn), Mode::Open, "the mode is the group's");
    assert_eq!(sync_state(&conn, ROSTER_LAST), None);
    assert!(
        is_restricted(&conn, "bot").unwrap(),
        "a restriction survived nothing that forgets — not even leaving"
    );
}

/// ⚠ **A restricted device plans nothing** — no removal, no join, no departure — with a
/// sentence. Its own capability arrives on a document like anybody's.
#[test]
fn a_restricted_device_refuses_to_plan_any_key_change() {
    let (conn, me, group) = device();
    identity::add_device(&conn, "dev-b", &[2u8; 32], "B").unwrap();
    let rd = Roster {
        v: VERSION,
        group: group.group_id.clone(),
        epoch: group.epoch,
        step: 0,
        prev: None,
        mode: Mode::Signed,
        signer: "dev-b".into(),
        members: vec![
            member(&me.device_id, 1, None, READ, 2, 0),
            member("dev-b", 2, None, FULL, 2, 0),
        ],
    };
    accept(&conn, &to_text(&rd), &rd, true).unwrap();
    assert!(self_restricted(&conn).unwrap());
    for refused in [
        identity::plan_rotation(&conn, "dev-b").err(),
        identity::plan_join(&conn).err(),
        identity::plan_departure(&conn).err(),
    ] {
        assert_eq!(refused.as_deref(), Some(identity::RESTRICTED_CANNOT_PLAN));
    }
}

/// **What an amendment owes**: nothing against an older relay; this device's own entry, at the
/// first document's step 0, where the relay holds none; `step + 1` with only its own entry
/// changed on one that misses it; and nothing once the newest is right.
#[test]
fn an_amendment_adds_this_device_and_is_owed_only_once() {
    let (conn, me, group) = device();
    identity::add_device(&conn, "dev-b", &[2u8; 32], "B").unwrap();
    assert_eq!(
        amendment(&conn).unwrap(),
        None,
        "an older relay is never asked"
    );

    note_relay(&conn, true, None).unwrap();
    let (at, text, proof) = amendment(&conn)
        .unwrap()
        .expect("the group has no document yet");
    assert_eq!(at, group);
    let first = parse(&text).unwrap();
    assert_eq!((first.epoch, first.step, first.prev.clone()), (0, 0, None));
    let mine = first
        .member(&me.device_id)
        .expect("this device names itself");
    assert_eq!(mine.proto, identity::SIG_PROTO);
    assert_eq!(
        mine.ed25519.as_deref().and_then(key32),
        Some(identity::signing_key(&conn).unwrap().unwrap().public)
    );
    assert!(
        first.member("dev-b").is_some(),
        "the first is the roster this device holds"
    );
    assert_eq!(
        proof,
        Auth::Mac(mac(&group.group_key, &group.group_id, &text))
    );

    // A sibling's document that misses this device: the amendment is that one, plus this entry.
    let sibling = Roster {
        v: VERSION,
        group: group.group_id.clone(),
        epoch: 0,
        step: 0,
        prev: None,
        mode: Mode::Open,
        signer: "dev-b".into(),
        members: vec![member("dev-b", 2, None, FULL, 2, 0)],
    };
    let sibling_text = to_text(&sibling);
    accept(&conn, &sibling_text, &sibling, true).unwrap();
    note_relay(&conn, true, Some(&sibling_text)).unwrap();
    let (_, text, _) = amendment(&conn)
        .unwrap()
        .expect("the newest misses this device");
    let amended = parse(&text).unwrap();
    assert_eq!(amended.step, 1);
    assert_eq!(amended.prev.as_deref(), Some(hash(&sibling_text).as_str()));
    assert_eq!(
        amended.members[0], sibling.members[0],
        "nobody else's entry moved"
    );
    assert!(amended.member(&me.device_id).is_some());

    accept_own(&conn, &text).unwrap();
    assert_eq!(amendment(&conn).unwrap(), None, "nothing is owed twice");

    // A relay whose newest this device could not take: nothing is built on it.
    note_relay(&conn, true, Some("{\"v\":1}")).unwrap();
    assert_eq!(amendment(&conn).unwrap(), None);
}

/// **An open document names full members only** — the relay's rule (`400 malformed_roster`),
/// held here too: under a MAC any key holder could otherwise file a capability nobody granted.
#[test]
fn an_open_document_naming_a_restricted_member_is_refused() {
    let key = [9u8; 32];
    let (mut open, _) = golden_pair();
    open.members[1].cap = READ.into();
    assert_eq!(
        judged(
            Mode::Open,
            None,
            &[],
            &[],
            &stored_mac(&open, &key),
            Some(key)
        ),
        Verdict::Refuse(OPEN_BUT_RESTRICTED)
    );
}
