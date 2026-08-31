//! The pairing state machine, and the commands the webview presses.
//!
//! **The pending offer lives in memory and never in SQLite**, which is what makes the token
//! one-time in fact rather than by convention: an offer that survived a restart would be an
//! invite a reader printed last month still being accepted today. It has to outlive a page
//! reload, because a reader may open Settings twice, and `AppState` is exactly that lifetime.
//!
//! **Only the invite still crosses a screen.** It is base32 through [`super::invite`]'s
//! alphabet — the same reason it always was: a reader with no camera may have to type it — and
//! it doubles as a URL a QR can carry (`invite::qr_payload`). The other two blobs this
//! ceremony used to hand-carry — B's answer and A's sealed key — now meet at a relay instead:
//! both sides derive the same address from the invite's own token
//! ([`crypto::rendezvous_id`]), so there is nothing left about *where* the blobs meet for a
//! reader to type or scan. [`poll`] is what reads that address back, on both sides, every
//! 1.5 seconds.
//!
//! **Both relay-borne blobs still carry one field in the clear ahead of the sealed remainder,
//! and that is not a leak.** Each side has to know *which key* to derive before it can open
//! anything, and the value it needs is the one the other side is identified by — B's public key
//! on the way back, A's device id on the way out. Both are public by construction, and the seal
//! is what proves the clear prefix belongs to the same handshake: the joiner's key is repeated
//! inside the sealed bytes and compared, and the initiator's id is the AEAD's associated data.

use crate::sync_engine::client;
use crate::sync_engine::entitlement;
use crate::sync_pair::crypto;
use crate::sync_pair::identity;
use crate::sync_pair::invite::{Invite, QrMatrix};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// A pairing in flight, on either side. One at a time per device: a second `begin` replaces the
/// first, which is what a reader who pressed the button twice means.
///
/// **Every field is private and none of them is `Serialize`.** This struct holds the derived
/// pair key, and the only things about a pairing that cross the IPC boundary are the six digits
/// and two sealed blobs.
pub struct Pending {
    /// True on the device that displayed the code.
    initiator: bool,
    group_id: [u8; 16],
    token: [u8; 16],
    /// Where both sides meet on the relay — `crypto::rendezvous_id(&token)`, derived
    /// independently by each side from the one thing the invite carries. Never sent anywhere:
    /// it is the *address* the two blobs meet at, not one of the blobs.
    rv: String,
    /// Whether this side has written its own blob to the rendezvous. Set once, by [`accept`];
    /// nothing today re-reads it, but it is the honest record of what this side has told the
    /// relay, for whatever the next thing to read it turns out to be.
    #[allow(dead_code)]
    posted: bool,
    /// Unix ms, ten minutes past `begin`/`accept`. Mirrors [`RENDEZVOUS_TTL_MS`] — see there for
    /// why the two numbers are not held together by anything a build can check.
    expires_at: i64,
    /// Filled once the other side's public key has arrived.
    peer_public: Option<[u8; 32]>,
    peer_device_id: Option<String>,
    peer_name: Option<String>,
    pair_key: Option<[u8; 32]>,
    /// Set once this side's own part of the ceremony is finished — by [`confirm`] on the
    /// initiator, so a spent offer cannot serve a second joiner, and by [`poll`] on the joiner
    /// once [`complete`] succeeds, so a finished join answers a stable `"complete"` on every
    /// later poll instead of re-fetching a blob it has already spent. The two roles never read
    /// the flag the other one sets: `respond` and `confirm` only ever run against an initiator's
    /// `Pending`, and `poll`'s joiner branch is only ever reached on one.
    spent: bool,
}

/// What the reader is shown when a pairing starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub code: String,
    pub qr: QrMatrix,
}

/// What each side gets once it knows the other's key: six digits to compare.
///
/// **No blob any more.** Both sides used to hand a blob back to the reader here — B's answer,
/// for the reader to carry to A — but [`accept`] now posts it to the rendezvous itself, so there
/// is nothing left for this struct to carry but the digits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub sas: String,
}

/// The wrapped group key. Still returned to the caller — mainly for the tests, which drive
/// [`confirm`] and [`complete`] directly with no relay in the loop at all — even though the
/// production path never reads it: [`confirm`] has already posted the same bytes to
/// `/p/{rv}/offer`, and the joiner's [`poll`] reads them back from there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedKey {
    pub sealed_key: String,
}

/// What Settings draws when nothing is in flight.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub device_id: String,
    pub device_name: String,
    pub group_id: Option<String>,
    pub epoch: Option<i64>,
    pub devices: Vec<identity::Device>,
}

/// What [`poll`] answers, every 1.5 seconds, while a pairing is in flight.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingProgress {
    /// One of `"idle" | "waiting" | "compare" | "complete"`.
    pub stage: String,
    /// The six digits, once both sides' keys are known — `None` at `"idle"` and `"waiting"`.
    pub sas: Option<String>,
}

const STAGE_IDLE: &str = "idle";
const STAGE_WAITING: &str = "waiting";
const STAGE_COMPARE: &str = "compare";
const STAGE_COMPLETE: &str = "complete";

/// Ten minutes, in milliseconds. Mirrors `relay/src/rendezvous.ts`'s `RENDEZVOUS_TTL_MS`.
///
/// **The two are not held together by anything a build can check** — the relay is TypeScript a
/// reader deploys themselves — so the number is written twice on purpose and this comment is the
/// fence, `sync_engine::baseline::TAIL_SECS`'s shape. A `Pending` that outlived the relay's own
/// row would poll a 404 that can never resolve into anything but the timeout below; a `Pending`
/// that expired *first* only costs the reader a fresh offer the relay would still have answered.
const RENDEZVOUS_TTL_MS: i64 = 10 * 60 * 1000;

/// What [`poll`] says once the ten-minute rendezvous window has passed with nothing resolved.
const EXPIRED: &str = "That pairing code has expired. Start a new one.";

/// What every step says when there is nothing in flight.
const NOTHING_IN_FLIGHT: &str = "There is no pairing in progress.";

/// What a spent offer says.
const ALREADY_USED: &str = "That pairing code has already been used.";

/// What a blob that is not the shape of its step says.
const NOT_A_RESPONSE: &str = "That response is not a pairing response.";
const NOT_A_KEY: &str = "That pairing key is unreadable.";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Now, in unix milliseconds.
///
/// `SystemTime::now()` is safe here — unlike `entitlement` and `sync_engine`, which read
/// `unixepoch()` off the connection instead because they compile for `wasm32-unknown-unknown`,
/// this whole module does not: `sync_pair::mod` gates it `#[cfg(not(target_family = "wasm"))]`,
/// so there is no wasm target for this clock to panic on.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 16 random bytes as 32 lowercase hex characters — `identity`'s own `hex`, which is private to
/// that module. Duplicated rather than exposed: [`confirm`] needs to compute a *candidate* group
/// id to seal before it is allowed to write anything, and `identity::create_group` both mints
/// and writes in the same call.
fn hex16(bytes: &[u8; 16]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Start an offer. Mints a token, replaces any offer already in flight.
pub fn begin(conn: &Connection, pending: &mut Option<Pending>) -> Result<Offer, String> {
    let me = identity::ensure(conn).map_err(err)?;
    // A device already in a group invites into *that* group; a device in none mints the id now
    // and only writes it at Confirm, so a cancelled pairing leaves nothing behind.
    let group_id = match identity::group(conn).map_err(err)? {
        Some(g) => from_hex16(&g.group_id).ok_or("that group id is unreadable")?,
        None => crypto::random_bytes::<16>(),
    };
    let token = crypto::random_bytes::<16>();
    let rv = crypto::rendezvous_id(&token);

    let inv = Invite {
        group_id,
        public_key: me.keypair.public,
        token,
    };
    let code = inv.encode();
    // **The QR draws the relay's own `/pair` URL, never the bare code.** `qr_payload` strips the
    // hyphens itself; `Offer.code` keeps them, because that field is still the typed form a
    // reader without a camera reads back digit group by digit group.
    let qr_text = crate::sync_pair::invite::qr_payload(&code, &entitlement::base(conn));
    let qr = crate::sync_pair::invite::qr_matrix(&qr_text).map_err(err)?;

    *pending = Some(Pending {
        initiator: true,
        group_id,
        token,
        rv,
        posted: false,
        expires_at: now_ms() + RENDEZVOUS_TTL_MS,
        peer_public: None,
        peer_device_id: None,
        peer_name: None,
        pair_key: None,
        spent: false,
    });
    Ok(Offer { code, qr })
}

/// The joining device reads the code, does the ECDH, posts its answer to the relay, and
/// produces the six digits for the reader to compare.
///
/// **Posts before it keeps anything**, the same shape [`confirm`] uses one step further on: if
/// the post fails — the code was answered already, or the relay could not be reached — nothing
/// local exists to half-undo, and a reader whose paste failed can simply try again. Because of
/// that ordering, `posted` is always `true` by the time a `Pending` exists at all here; the field
/// is still written on `Pending` rather than assumed, so that fact stays true in the type and not
/// only in this function's body.
pub async fn accept(
    conn: &Connection,
    pending: &mut Option<Pending>,
    code: &str,
) -> Result<Handshake, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let inv = Invite::decode(code).map_err(err)?;
    let pair_key = crypto::pair_key(
        &me.keypair.secret,
        &inv.public_key,
        &inv.group_id,
        &inv.token,
    );
    let sas = crypto::sas(&pair_key, &inv.public_key, &me.keypair.public);

    // The response carries B's key and name, sealed under the pair key. Sealed rather than
    // plain so that a relay cannot swap the *name* either — a device the reader accepted under
    // one name and that appears under another is a lie the roster would repeat forever.
    let mut plain = Vec::new();
    plain.extend_from_slice(&me.keypair.public);
    plain.extend_from_slice(me.device_id.as_bytes());
    plain.push(0);
    plain.extend_from_slice(me.name.as_bytes());
    let sealed = crypto::seal(&pair_key, inv.group_id.as_slice(), &plain).map_err(err)?;

    // **B's public key travels in the clear ahead of the sealed remainder**, because A cannot
    // derive the key that opens the remainder until it has it. It is repeated *inside* the
    // seal, and [`respond`] compares the two: a swapped prefix then fails to open, and a
    // prefix that opens is one the sealing device chose.
    let mut blob = Vec::with_capacity(32 + sealed.len());
    blob.extend_from_slice(&me.keypair.public);
    blob.extend_from_slice(&sealed);

    let rv = crypto::rendezvous_id(&inv.token);
    client::post_rendezvous(conn, &rv, "join", &blob_encode(&blob)).await?;

    *pending = Some(Pending {
        initiator: false,
        group_id: inv.group_id,
        token: inv.token,
        rv,
        posted: true,
        expires_at: now_ms() + RENDEZVOUS_TTL_MS,
        peer_public: Some(inv.public_key),
        peer_device_id: None,
        peer_name: None,
        pair_key: Some(pair_key),
        spent: false,
    });
    Ok(Handshake { sas })
}

/// The initiator reads the joiner's blob, derives the same key, and shows the same six digits.
pub fn respond(
    conn: &Connection,
    pending: &mut Option<Pending>,
    response: &str,
) -> Result<Handshake, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_mut().ok_or(NOTHING_IN_FLIGHT)?;
    if !p.initiator {
        return Err("This device is joining a group, not offering one.".to_owned());
    }
    if p.spent {
        return Err(ALREADY_USED.to_owned());
    }

    let blob = blob_decode(response)?;
    if blob.len() <= 32 {
        return Err(NOT_A_RESPONSE.to_owned());
    }
    let mut peer_public = [0u8; 32];
    peer_public.copy_from_slice(&blob[..32]);
    let pair_key = crypto::pair_key(&me.keypair.secret, &peer_public, &p.group_id, &p.token);
    let plain = crypto::open(&pair_key, p.group_id.as_slice(), &blob[32..]).map_err(err)?;

    // `<32-byte key><device id>\0<name>`
    if plain.len() <= 32 {
        return Err(NOT_A_RESPONSE.to_owned());
    }
    if plain[..32] != peer_public {
        return Err("That response does not match the key it was sent with.".to_owned());
    }
    let rest = &plain[32..];
    let split = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
    let device_id = String::from_utf8_lossy(&rest[..split]).into_owned();
    if device_id.is_empty() {
        return Err(NOT_A_RESPONSE.to_owned());
    }
    let name = if split + 1 < rest.len() {
        String::from_utf8_lossy(&rest[split + 1..]).into_owned()
    } else {
        DEFAULT_PEER_NAME.to_owned()
    };

    p.peer_public = Some(peer_public);
    p.peer_device_id = Some(device_id);
    p.peer_name = Some(name);
    p.pair_key = Some(pair_key);

    Ok(Handshake {
        sas: crypto::sas(&pair_key, &me.keypair.public, &peer_public),
    })
}

/// What a device with no name of its own is filed as.
const DEFAULT_PEER_NAME: &str = "Paired device";

/// The initiator confirms the digits matched: the group key is sealed and posted to the relay,
/// and only once that succeeds does the joiner go on the roster.
///
/// **The order below is the design, and it is deliberate that it does not match the order things
/// are *named* in.** Sealing reads a group that does not have to exist yet; committing is what
/// makes it exist. Rearranging the two would either write the group before the relay has agreed
/// to carry it (spec §4.3's "a failed post costs nothing" reasoning, undone) or ask the relay to
/// carry a group this device cannot yet prove it minted (nothing to seal at all). See the module
/// doc's opening paragraphs for why the blob crosses this way at all.
///
/// 1. [`identity::room_for`] — the device cap, refused before anything moves.
/// 2. Seal the group key **at the current epoch** and POST it to `/p/{rv}/offer`. **If this
///    fails, nothing has changed locally and the reader can press again** — the candidate group
///    below is computed, never written, until this succeeds.
/// 3. Commit: [`identity::join_group`] (which, for a device with no group yet, writes exactly
///    the candidate this just sealed — never [`identity::create_group`], which would mint its
///    own different random values and leave the relay holding a key nobody local matches) and
///    [`identity::add_device`] for the joiner.
/// 4. [`client::publish_join`], best effort — a first pairing has no membership yet and
///    `/rotate` refuses it with a 401, which is not a reason to undo a ceremony that has already
///    committed; the debt is marked and a later sync pays it.
///
/// **What the blob hands over is a group and nothing else, and the absence is the point.** Spec
/// §6.2 sealed the *refresh secret* in beside the key, so that the joining device never opened a
/// browser and never saw Patreon; spec §2.2 takes it back out, because that made every device in
/// a group hold the one credential `/token`'s refresh door answers to — and a device holding it
/// can re-register the group's auth and so evict the very devices that removed it. **Restricting
/// the Patreon-side secret to the device that actually pressed Connect is what makes a removal
/// stick.** Nothing is lost by it: the joiner derives [`crypto::relay_auth`] from the key it is
/// being handed here and mints a token of its own through `/token`'s **group** door, which
/// answers the membership's status and date along with it.
///
/// The cost, stated plainly: a freshly paired device draws *Supporting since …* after its first
/// relay call rather than the instant the digits match.
pub async fn confirm(conn: &Connection, pending: &mut Option<Pending>) -> Result<SealedKey, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_ref().ok_or(NOTHING_IN_FLIGHT)?;
    if p.spent {
        return Err(ALREADY_USED.to_owned());
    }
    let (Some(pair_key), Some(peer_public), Some(peer_id)) =
        (p.pair_key, p.peer_public, p.peer_device_id.clone())
    else {
        return Err("The other device has not answered yet.".to_owned());
    };
    let rv = p.rv.clone();
    let peer_name = p.peer_name.clone();
    // `p`'s borrow ends here — everything above is copied or cloned out of it, and everything
    // below reaches `pending` fresh, which is what lets the final line take it mutably again.

    // **The sixth device is refused here, before a group is minted or a row written** — spec
    // §4.3. The relay is the fence and this is the message: `/token` refuses the sixth device a
    // token whatever this build does, and what the check buys is that a reader meets the limit
    // at the press rather than at a sync three minutes later. It excludes `peer_id`, so
    // re-running the ceremony with a device already in the group is never what fills it.
    identity::room_for(conn, &peer_id)?;

    // **The candidate group, computed but not written.** `Some` is this device's group exactly
    // as it stands right now — sealing its *current* epoch, never one a rotation might move it
    // to before this finishes. `None` is a device that has never paired: there is nothing yet
    // for `identity::group` to read, so the values `identity::create_group` would mint are
    // reproduced here instead of minted by calling it, because that call also *writes* them, and
    // a write ahead of the post is exactly the ordering step 2's doc above exists to rule out.
    let group = match identity::group(conn).map_err(err)? {
        Some(g) => g,
        None => identity::Group {
            group_id: hex16(&crypto::random_bytes::<16>()),
            epoch: 0,
            group_key: crypto::random_bytes::<32>(),
        },
    };

    // `<group_id>\0<epoch>\0<32-byte key>` — the id and the epoch travel with the key because a
    // key with no epoch cannot be compared against a later rotation, and since spec §2.2 nothing
    // else travels at all. **This device's membership is not consulted here**, which is what
    // makes pairing possible in either order: a reader may pair two devices and connect Patreon
    // afterwards, or the other way round, and neither is a refusal.
    //
    // **The key is last, and anything ever added here goes before it.** The key is 32 raw bytes
    // and may hold a zero of its own, so it can only ever be the *final* field: [`complete`]
    // splits on zero bytes and takes everything left over as the key. A field appended after it
    // would be swallowed by any group key containing a zero — about one pairing in eight — and
    // would pass every test whose fixture key happened to contain none. The two ahead of it are
    // safe there for the reason A's device id is safe as the clear prefix one step down: a hex
    // group id and a decimal epoch carry no zero byte at all.
    let mut plain = Vec::new();
    plain.extend_from_slice(group.group_id.as_bytes());
    plain.push(0);
    plain.extend_from_slice(group.epoch.to_string().as_bytes());
    plain.push(0);
    plain.extend_from_slice(&group.group_key);

    let sealed = crypto::seal(&pair_key, me.device_id.as_bytes(), &plain).map_err(err)?;

    // **A's device id travels in the clear ahead of the sealed bytes**, for the reason B's key
    // does one step back: it is this seal's associated data and B does not know it yet. It is
    // hex, so it carries no zero byte of its own and the first one is the separator.
    let mut blob = Vec::with_capacity(me.device_id.len() + 1 + sealed.len());
    blob.extend_from_slice(me.device_id.as_bytes());
    blob.push(0);
    blob.extend_from_slice(&sealed);
    let encoded = blob_encode(&blob);

    // **Posted before anything commits.** A failed post ends this call right here, and nothing
    // above has written to the database — the candidate group was a local value, not a row.
    client::post_rendezvous(conn, &rv, "offer", &encoded).await?;

    identity::join_group(conn, &group.group_id, group.epoch, &group.group_key, &me).map_err(err)?;
    identity::add_device(
        conn,
        &peer_id,
        &peer_public,
        peer_name.as_deref().unwrap_or(DEFAULT_PEER_NAME),
    )
    .map_err(err)?;

    if let Some(p) = pending.as_mut() {
        p.spent = true;
    }

    // Best effort: see the doc above and `client::publish_join`'s own for why a refusal here is
    // recorded rather than raised.
    let _ = client::publish_join(conn).await;

    Ok(SealedKey {
        sealed_key: encoded,
    })
}

/// The joiner unwraps the group key and is in the group.
pub fn complete(
    conn: &Connection,
    pending: &mut Option<Pending>,
    sealed_key: &str,
) -> Result<(), String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_ref().ok_or(NOTHING_IN_FLIGHT)?;
    let (Some(pair_key), Some(peer_public)) = (p.pair_key, p.peer_public) else {
        return Err("This device has not read a pairing code yet.".to_owned());
    };

    let blob = blob_decode(sealed_key)?;
    let split = blob.iter().position(|b| *b == 0).ok_or(NOT_A_KEY)?;
    let peer_id = String::from_utf8_lossy(&blob[..split]).into_owned();
    let plain = crypto::open(&pair_key, peer_id.as_bytes(), &blob[split + 1..]).map_err(err)?;

    // `<group_id>\0<epoch>\0<32-byte key>`, and **the key is read last because it is the one
    // field that may contain a zero byte of its own** — [`confirm`], which seals it, carries the
    // whole argument.
    //
    // **The `3` is the fence and not an optimisation**: a plain `split` would end the key at the
    // first zero *inside* it and hand `join_group` a short slice, which the length check below
    // then refuses. The same check is what makes a sealer that writes one field too many a
    // refusal rather than a wrong key — the leftover separator and field are still in this
    // slice, so it cannot be 32 bytes long.
    let mut parts = plain.splitn(3, |b| *b == 0);
    let group_id = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
    let epoch: i64 = String::from_utf8_lossy(parts.next().unwrap_or_default())
        .parse()
        .map_err(|_| NOT_A_KEY)?;
    let key_bytes = parts.next().ok_or(NOT_A_KEY)?;
    if key_bytes.len() != 32 {
        return Err(NOT_A_KEY.to_owned());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(key_bytes);

    // **A device already in a group may only rejoin the one it is in.** Joining a second group
    // overwrites the key this device is already syncing under, and nothing here can get it
    // back — a re-pair after a revocation carries the same group id and is what this allows.
    if let Some(current) = identity::group(conn).map_err(err)? {
        if current.group_id != group_id {
            return Err(
                "This device is already in a different pairing group. Leave that one first."
                    .to_owned(),
            );
        }
    }

    // **The same cap from the joining side** — spec §4.3. On a device joining for the first time
    // the roster is empty and this can refuse nothing, which is honest: B has never seen the
    // group it is being let into, so the count that matters is A's. What it does catch is the
    // asymmetric case — a device already in this group whose roster no longer names the
    // initiator, where completing would file a sixth row.
    identity::room_for(conn, &peer_id)?;

    identity::join_group(conn, &group_id, epoch, &key, &me).map_err(err)?;
    identity::add_device(
        conn,
        &peer_id,
        &peer_public,
        p.peer_name.as_deref().unwrap_or(DEFAULT_PEER_NAME),
    )
    .map_err(err)?;

    // **Nothing about the membership is written, and that is the whole of spec §2.2.** The blob
    // used to carry the offering device's refresh secret and this is where it was stored, under
    // a placeholder access token that had expired at the epoch; it carries none now, so a
    // pairing writes the group and the roster and touches `sync_state`'s grant keys not at all —
    // neither this device's own, which is why a reader who connected Patreon here and then
    // paired with a device that never did keeps their membership, nor an absent one.
    //
    // What makes that sufficient rather than a loss is `/token`'s **group** door: the key
    // written just above is what `crypto::relay_auth` derives from, so the first round trip
    // mints a token of this device's own and is told the status and the date with it — which is
    // more than the old field ever carried, since it brought no `supporter_status` and left this
    // panel drawing a dateless *Supporting. Thank you.*
    //
    // **The cost is one sync and it is visible on the way past.** Until that round trip this
    // device holds no `supporter_status`, so `entitlement::supporter_state` reads
    // `("dead", None)` and `commands::entitled` is false — which a Remove pressed in that window
    // answers with `identity::NO_MEMBERSHIP` even though the group has a membership. It heals
    // itself the first time anything syncs, and refusing later would break the ordering that
    // refusal exists for.
    Ok(())
}

/// What the panel asks every 1.5 seconds while a pairing is in flight.
///
/// **One command for both sides**, because the state it reads already knows which side this is:
/// the initiator is waiting for an answer, the joiner for a key. Two commands would be two
/// things for the panel to decide between using state it would have to be handed first.
///
/// `respond` and `complete` keep their bodies exactly as they were before this existed — this is
/// their only caller now, and the tests that drive them directly still do.
pub async fn poll(
    conn: &Connection,
    pending: &mut Option<Pending>,
    now_ms: i64,
) -> Result<PairingProgress, String> {
    let Some(p) = pending.as_ref() else {
        return Ok(PairingProgress {
            stage: STAGE_IDLE.to_owned(),
            sas: None,
        });
    };
    let expires_at = p.expires_at;
    let initiator = p.initiator;
    // `p`'s borrow ends here — both branches below reach `pending` fresh.

    // **The relay's own TTL, read off this side's clock rather than the reader's patience.**
    // Without this a dropped offer polls a 404 forever; with it the panel is told the code timed
    // out and can start over rather than spin.
    if now_ms > expires_at {
        *pending = None;
        return Err(EXPIRED.to_owned());
    }

    let me = identity::ensure(conn).map_err(err)?;
    if initiator {
        poll_initiator(conn, pending, &me).await
    } else {
        poll_joiner(conn, pending, &me).await
    }
}

/// The six digits, as the initiator would compute them — `None` while the joiner's key has not
/// arrived yet, which [`poll_initiator`] reads as "keep waiting" rather than as an error.
fn initiator_sas(me: &identity::Identity, p: &Pending) -> Option<String> {
    Some(crypto::sas(&p.pair_key?, &me.keypair.public, &p.peer_public?))
}

/// The six digits, as the joiner would compute them.
///
/// **Always `Some`, unlike its initiator-side sibling.** [`accept`] sets `pair_key` and
/// `peer_public` together, unconditionally, before a joiner's `Pending` exists at all — so a
/// joiner has both the moment there is anything to poll about, where an initiator's `Pending`
/// starts with neither and waits for [`respond`] to fill them in.
fn joiner_sas(me: &identity::Identity, p: &Pending) -> String {
    crypto::sas(
        &p.pair_key.expect("a joiner's pending always carries a pair key"),
        &p.peer_public
            .expect("a joiner's pending always carries the initiator's key"),
        &me.keypair.public,
    )
}

fn waiting_progress() -> PairingProgress {
    PairingProgress {
        stage: STAGE_WAITING.to_owned(),
        sas: None,
    }
}

fn compare_progress(sas: String) -> PairingProgress {
    PairingProgress {
        stage: STAGE_COMPARE.to_owned(),
        sas: Some(sas),
    }
}

fn complete_progress() -> PairingProgress {
    PairingProgress {
        stage: STAGE_COMPLETE.to_owned(),
        sas: None,
    }
}

/// The initiator is waiting for an answer, has one and is waiting on the reader's press of
/// Confirm, or has already pressed it.
async fn poll_initiator(
    conn: &Connection,
    pending: &mut Option<Pending>,
    me: &identity::Identity,
) -> Result<PairingProgress, String> {
    let p = pending.as_ref().expect("poll already checked this is Some");
    // **Checked before the SAS is even attempted.** Once spent, `pair_key`/`peer_public` are
    // still set — `respond` filled them in long before `confirm` ran — so `initiator_sas` would
    // answer `Some` here too, and reading it first would show "compare" for a ceremony that has
    // already finished.
    if p.spent {
        return Ok(complete_progress());
    }
    if let Some(sas) = initiator_sas(me, p) {
        return Ok(compare_progress(sas));
    }
    let rv = p.rv.clone();
    // `p`'s borrow ends here — `respond` below needs `pending` mutably.

    match client::get_rendezvous(conn, &rv, "join").await? {
        None => Ok(waiting_progress()),
        Some(blob) => {
            let handshake = respond(conn, pending, &blob)?;
            Ok(compare_progress(handshake.sas))
        }
    }
}

/// The joiner has not seen a key yet, or has and is done — [`complete`] runs at most once per
/// `Pending`, guarded by the same `spent` flag [`confirm`] sets on the initiator's side.
async fn poll_joiner(
    conn: &Connection,
    pending: &mut Option<Pending>,
    me: &identity::Identity,
) -> Result<PairingProgress, String> {
    let p = pending.as_ref().expect("poll already checked this is Some");
    if p.spent {
        return Ok(complete_progress());
    }
    let sas = joiner_sas(me, p);
    let rv = p.rv.clone();
    // `p`'s borrow ends here — `complete` below needs `pending` mutably.

    match client::get_rendezvous(conn, &rv, "offer").await? {
        None => Ok(compare_progress(sas)),
        Some(blob) => {
            complete(conn, pending, &blob)?;
            // **Set only after `complete` succeeds, and read on every later poll before this
            // reaches the relay again.** Without it, a poll that landed after some *other* event
            // rotated the group (a peer's removal, a departure) would re-run `complete` with this
            // same, now-stale blob and roll the epoch backward — the relay does not delete a
            // filled slot until its ten-minute row expires, so the blob is still there to
            // re-fetch.
            if let Some(p) = pending.as_mut() {
                p.spent = true;
            }
            Ok(complete_progress())
        }
    }
}

/// Throw away whatever is in flight.
///
/// The offer's token dies with it, so the code that was on screen stops working — which is what
/// a reader pressing Cancel means, and the only way to spend a token without completing.
pub fn cancel(pending: &mut Option<Pending>) {
    *pending = None;
}

/// Read the whole panel's state in one go.
pub fn status(conn: &Connection) -> Result<PairingStatus, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let g = identity::group(conn).map_err(err)?;
    Ok(PairingStatus {
        device_id: me.device_id,
        device_name: me.name,
        group_id: g.as_ref().map(|g| g.group_id.clone()),
        epoch: g.as_ref().map(|g| g.epoch),
        // **Filtered here rather than in `identity::roster`, which has other readers.** A
        // removed device is not a row of history the reader asked for; the reader asked for it
        // to be gone. The roster keeps the mark because `add_device` clears it on a re-pair and
        // `baseline::peers_needing` reads it — this is only what the panel draws.
        devices: identity::roster(conn)
            .map_err(err)?
            .into_iter()
            .filter(|d| d.revoked_at.is_none())
            .collect(),
    })
}

/// Base32 over the same alphabet the invite uses, for the two blobs a reader may have to carry
/// by hand. No checksum: these are pasted rather than typed, and a bent one already fails at
/// the AEAD with a sentence of its own.
fn blob_encode(bytes: &[u8]) -> String {
    crate::sync_pair::invite::blob_encode(bytes)
}

fn blob_decode(text: &str) -> Result<Vec<u8>, String> {
    crate::sync_pair::invite::blob_decode(text).map_err(err)
}

fn from_hex16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------
//
// Each takes the write connection through `sync::with_write`, so a sync in flight answers
// `BUSY` like every other write here — `identity::ensure` writes on a database that has never
// paired, so even `status` is a write path.
//
// ⚠️ **`with_write` must not be called while holding a guard on `state.db`.** It is a bounded
// `try_lock` loop, so a reentrant call spends the whole `WRITE_LOCK_WAIT` failing against its
// own thread and then answers `BUSY` against itself. The `state.pairing` guard is a *different*
// mutex and is safe to hold across it — it is taken first, below.

use crate::sync::{self, AppState};
use crate::sync_engine::commands;
// **`entitlement` is reachable from this module again since spec §2.1, and for one call beyond
// `begin`'s and `confirm`'s own use of `entitlement::base`.** A *pairing* still asks the
// membership nothing and writes it nothing — §2.2's rule, and the block of tests at the bottom
// of this file asserts exactly that. What reaches it beyond the relay's address is
// [`leave_group_now`], which is not a pairing: a device that has left the group must not keep a
// credential that still opens it.

/// What [`sync_device_revoke`] says when the round trip it makes first does not complete.
///
/// A sentence rather than the bare transport error, because the reader pressed Remove and what
/// they need told is that nothing was removed — the `reqwest` message underneath it is appended
/// rather than shown alone.
const COULD_NOT_COLLECT: &str =
    "Could not reach the relay to collect that device's last changes, so it was not removed.";

/// What Settings draws: this device, the group it is in, and the roster.
#[tauri::command]
pub async fn sync_pairing_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PairingStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, status))
        .await
        .map_err(|e| format!("could not read the pairing status: {e}"))?
}

/// Start offering a pairing. Replaces any offer already in flight.
#[tauri::command]
pub async fn sync_pairing_begin(state: tauri::State<'_, Arc<AppState>>) -> Result<Offer, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| begin(conn, &mut pending))
    })
    .await
    .map_err(|e| format!("could not start pairing: {e}"))?
}

/// Read an offer on the joining device: derives the key, posts the answer to the relay, and
/// answers the six digits.
///
/// **On the blocking pool with a runtime of its own**, [`sync_device_revoke`]'s exact shape:
/// [`accept`] is `async` now that it posts to the relay, the write connection is behind a
/// `Mutex`, a guard on it cannot cross an `await` on a multi-threaded runtime, and
/// `spawn_blocking` moves the whole trip to a thread where `block_on` is legal.
#[tauri::command]
pub async fn sync_pairing_accept(
    state: tauri::State<'_, Arc<AppState>>,
    code: String,
) -> Result<Handshake, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| {
            runtime.block_on(accept(conn, &mut pending, &code))
        })
    })
    .await
    .map_err(|e| format!("could not read that pairing code: {e}"))?
}

/// The reader says the digits matched: the group key is sealed, posted to the relay, and only
/// then committed. Answers the sealed group key.
///
/// **On the blocking pool with a runtime of its own**, for [`sync_pairing_accept`]'s reason:
/// [`confirm`] is `async` now that it posts to the relay before it commits anything.
#[tauri::command]
pub async fn sync_pairing_confirm(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SealedKey, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| runtime.block_on(confirm(conn, &mut pending)))
    })
    .await
    .map_err(|e| format!("could not finish pairing: {e}"))?
}

/// What the panel asks every 1.5 seconds while a pairing is in flight. See [`poll`].
///
/// **On the blocking pool with a runtime of its own**, [`sync_device_revoke`]'s exact shape: the
/// write connection is behind a `Mutex`, a guard on it cannot cross an `await` on a
/// multi-threaded runtime, and `spawn_blocking` moves the whole trip to a thread where
/// `block_on` is legal. `now` is read here, on the IPC thread, rather than inside the closure —
/// it needs no connection, and reading it before the write lock is taken is one fewer thing the
/// lock is held for.
#[tauri::command]
pub async fn sync_pairing_poll(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PairingProgress, String> {
    let state = state.inner().clone();
    let now = now_ms();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| runtime.block_on(poll(conn, &mut pending, now)))
    })
    .await
    .map_err(|e| format!("could not check the pairing's progress: {e}"))?
}

/// Throw away whatever is in flight.
#[tauri::command(async)]
pub fn sync_pairing_cancel(state: tauri::State<'_, Arc<AppState>>) {
    cancel(&mut sync::lock_plain(&state.inner().pairing));
}

/// Rename a device on the roster.
#[tauri::command]
pub async fn sync_device_rename(
    state: tauri::State<'_, Arc<AppState>>,
    device_id: String,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| {
            identity::rename_device(conn, &device_id, &name).map_err(err)
        })
    })
    .await
    .map_err(|e| format!("could not rename that device: {e}"))?
}

/// Remove a device, in the four steps whose **order is the whole of the fix**.
///
/// 1. **Refuse a group with no membership.** Spec §2.4's fourth refusal, and it comes before
///    anything moves: `/rotate` authenticates against an auth only `/claim` can seed, so an
///    unentitled group has no way to publish a rotation — and rotating locally anyway is exactly
///    the bug this change exists to end. `commands::entitled` is the local half of that question
///    and [`identity::NO_MEMBERSHIP`] is the sentence.
/// 2. **A round trip, so the departing device's last push is absorbed.** Spec §12.4: the
///    rotation makes every op sealed under the old epoch unreadable, and [`client::pull`] steps
///    over such an envelope rather than stalling on it, so anything the leaving device pushed
///    that this one has not yet taken would be thrown away at the boundary. **It is the trip that
///    emits no baseline** — [`client::run_once`] would hand thousands of ops to the very device
///    this is about to remove.
/// 3. **Plan the rotation, which writes nothing** ([`identity::plan_rotation`]), and publish it
///    ([`client::post_rotation`]).
/// 4. **Commit only on a 2xx** ([`identity::commit_rotation`]).
///
/// **`identity::revoke_device` is gone and steps 3 and 4 are what replaced it.** It rotated
/// locally in one transaction and reached nobody: the removing device moved to epoch *N+1* while
/// every remaining device sat at *N*, `client::pull` set `behind = true` and held its cursor for
/// ever, and one removal bricked any group of three. A refused `/rotate` now leaves the group
/// exactly as it was and says so.
///
/// What a removal still cannot do is take back what the removed device already synced. No server
/// can, and §12.3 says so.
async fn remove_device(conn: &Connection, device_id: &str) -> Result<(), String> {
    if !commands::entitled(conn) {
        return Err(identity::NO_MEMBERSHIP.to_owned());
    }
    let _ = client::run_once_without_baselines(conn)
        .await
        .map_err(|e| format!("{COULD_NOT_COLLECT} {e}"))?;
    let plan = identity::plan_rotation(conn, device_id)?;
    client::post_rotation(conn, &plan).await?;
    identity::commit_rotation(conn, device_id, &plan)
}

/// Remove a device and rotate the group key. See [`remove_device`] for the order.
///
/// **On the blocking pool with a runtime of its own**, for `sync_engine::commands::sync_now`'s
/// reason: the write connection is behind a `Mutex`, a guard on it cannot cross an `await` on a
/// multi-threaded runtime, and `spawn_blocking` moves the whole trip to a thread where a
/// `block_on` is legal and the guard never has to be `Send`.
#[tauri::command]
pub async fn sync_device_revoke(
    state: tauri::State<'_, Arc<AppState>>,
    device_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        sync::with_write(&state, |conn| {
            runtime.block_on(remove_device(conn, &device_id))
        })
    })
    .await
    .map_err(|e| format!("could not remove that device: {e}"))?
}

/// Leave the group this device is in. **Three steps, and the third runs whatever the second
/// said** — spec §2.1.
///
/// 1. [`identity::plan_departure`], which writes nothing and names everyone *but* this device.
/// 2. [`client::post_rotation`], **best effort**. A 500, a timeout, a plane — none of them is a
///    reason a reader cannot leave.
/// 3. [`identity::leave_group`] **and** [`entitlement::clear`], unconditionally.
///
/// **Step 3 running whatever step 2 answered is the whole of "leaving is always possible"**, and
/// it is the reader's own instruction rather than a convenience. The cost is stated rather than
/// hidden: when the relay could not be reached the remaining devices go on listing a device that
/// has gone, and the panel's copy says so before the press.
///
/// **`clear` and never `revoke`.** The two differ by the mark [`entitlement::membership_ended`]
/// reads, and nothing ended — this device left a group, and the reader's pledge is untouched.
/// `revoke` would draw *Membership ended* at somebody whose membership is fine.
/// `client::check_keys` makes the same choice for a device that was removed, one file over.
///
/// **The grant goes at all because a leaver keeping its refresh secret keeps a working credential
/// for the group it left** — spec §2.3. The refresh door mints a token whose `grp` is that group
/// and `/g/{group}/push` honours it, so a device that walked out could go on spending the
/// group's requests.
///
/// **No round trip in front of it, unlike [`remove_device`].** That one absorbs the *departing*
/// device's last push before the key moves; here the departing device is this one, and what it
/// has not yet pushed it keeps — the rows are already in its own database. Nor is there a
/// membership check: a removal is refused without one because it must reach the other devices to
/// mean anything, and a departure means something locally whether or not it publishes.
async fn leave_group_now(conn: &Connection) -> Result<(), String> {
    // **A device in no group has nothing to leave, and that is the one refusal.** It is not a
    // failure of the press so much as an answer to it, and it is the only thing between here and
    // the clear below.
    if identity::group(conn).map_err(|e| e.to_string())?.is_none() {
        return Err(identity::NOT_IN_A_GROUP.to_owned());
    }

    // **Everything from here is best effort, planning included, and that breadth is the
    // feature.** The reader asked that leaving always be possible, and a chain that gave up on
    // its first `?` is only *usually* possible: `plan_departure` reads every peer's public key
    // and seals a blob to each, so one roster row an older build wrote badly is a device that can
    // never get out of its group. Publishing is best effort for the plainer reason — offline, or
    // a membership that has lapsed, are exactly the cases a reader most wants this press in.
    //
    // What is lost when planning fails is the *courtesy*, never the departure: the group does not
    // close behind this device, so the others go on listing it until somebody removes it by hand.
    // The panel's copy says so, because a reader who leaves over a dead relay has to know that
    // their other devices have not heard.
    if let Ok(plan) = identity::plan_departure(conn) {
        let _ = client::post_rotation(conn, &plan).await;
    }

    identity::leave_group(conn)?;
    entitlement::clear(conn)
}

/// Leave the group. See [`leave_group_now`] for the order and why the last step is unconditional.
///
/// **On the blocking pool with a runtime of its own**, for [`sync_device_revoke`]'s reason: the
/// write connection is behind a `Mutex`, a guard on it cannot cross an `await` on a
/// multi-threaded runtime, and `spawn_blocking` moves the whole trip to a thread where a
/// `block_on` is legal.
#[tauri::command]
pub async fn sync_group_leave(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        sync::with_write(&state, |conn| runtime.block_on(leave_group_now(conn)))
    })
    .await
    .map_err(|e| format!("could not leave that group: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    // `entitlement` arrives through `super::*`. **It was a test-only import from spec §2.2 until
    // §2.1's departure landed** — a pairing still neither reads this device's membership nor
    // writes the joiner's, which the block at the bottom of this file asserts; `leave_group_now`
    // is the one thing above that reaches it, and leaving is not a pairing.
    use httpmock::prelude::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// Bend one character of a base32 blob, in the middle rather than at the end.
    ///
    /// **The end is the wrong place and it is a real trap.** The last character of a base32
    /// string can carry padding bits the decoder discards, so a change there can decode to the
    /// identical bytes and the test would pass or fail on the arithmetic of that day's payload
    /// length. A character in the middle always lands on a byte somebody authenticated.
    fn bend(blob: &str) -> String {
        let mut chars: Vec<char> = blob.chars().collect();
        let i = chars.len() / 2;
        chars[i] = if chars[i] == 'Z' { 'Y' } else { 'Z' };
        chars.into_iter().collect()
    }

    // -----------------------------------------------------------------------------------
    // A fake relay for the rendezvous
    //
    // `accept` and `confirm` are `async` now, and make a real `reqwest` call each — so every
    // test that drives them needs something answering at the other end. This is a tiny
    // in-process stand-in for `relay/src/rendezvous.ts`'s two slots, wired to real HTTP (via
    // httpmock's dynamic `respond_with`) so those calls exercise the real wire path rather than
    // a second hand-written substitute for it.
    // -----------------------------------------------------------------------------------

    /// First-write-wins per `(rv, slot)`, exactly the relay's own guard: a second POST to a
    /// filled slot answers 409, and a GET on an empty one answers 404 rather than blocking.
    ///
    /// **`blob`/`set_blob` reach into the store directly, bypassing the POST's own guard.** Both
    /// exist for one test: the rendezvous is the one hop these bytes cross that the reader never
    /// sees, and proving that a relay which lies about a slot's contents is still caught by the
    /// six digits needs a way to make it lie.
    struct FakeRelay {
        server: MockServer,
        store: Arc<Mutex<HashMap<(String, String), String>>>,
    }

    /// Split `/p/{rv}/{slot}` into its two parts. Only ever called on a path the mocks below have
    /// already matched against that exact shape.
    fn rv_slot(path: &str) -> (String, String) {
        let mut parts = path.trim_start_matches('/').split('/');
        parts.next(); // "p"
        let rv = parts.next().expect("the route regex pinned this shape").to_owned();
        let slot = parts.next().expect("the route regex pinned this shape").to_owned();
        (rv, slot)
    }

    impl FakeRelay {
        async fn start() -> Self {
            let server = MockServer::start_async().await;
            let store: Arc<Mutex<HashMap<(String, String), String>>> = Arc::default();

            let read_store = store.clone();
            server.mock(|when, then| {
                when.method(GET).path_matches(r"^/p/[0-9a-f]{32}/(offer|join)$");
                then.respond_with(move |req: &HttpMockRequest| {
                    let (rv, slot) = rv_slot(req.uri().path());
                    match read_store.lock().unwrap().get(&(rv, slot)) {
                        Some(blob) => HttpMockResponse::builder()
                            .status(200)
                            .header("content-type", "application/json")
                            .body(serde_json::json!({ "blob": blob }).to_string())
                            .build(),
                        None => HttpMockResponse::builder().status(404).build(),
                    }
                });
            });

            let write_store = store.clone();
            server.mock(|when, then| {
                when.method(POST).path_matches(r"^/p/[0-9a-f]{32}/(offer|join)$");
                then.respond_with(move |req: &HttpMockRequest| {
                    let (rv, slot) = rv_slot(req.uri().path());
                    let body: serde_json::Value =
                        serde_json::from_str(&req.body_string()).unwrap_or_default();
                    let blob = body["blob"].as_str().unwrap_or_default().to_owned();
                    let mut store = write_store.lock().unwrap();
                    if store.contains_key(&(rv.clone(), slot.clone())) {
                        return HttpMockResponse::builder().status(409).build();
                    }
                    store.insert((rv, slot), blob);
                    HttpMockResponse::builder().status(204).build()
                });
            });

            FakeRelay { server, store }
        }

        /// Point `conn` at this relay.
        fn point(&self, conn: &Connection) {
            client::set_state(conn, client::RELAY_URL, &self.server.base_url()).unwrap();
        }

        /// What is sitting in a slot, if anything — a direct read, no HTTP involved.
        fn blob(&self, rv: &str, slot: &str) -> Option<String> {
            self.store
                .lock()
                .unwrap()
                .get(&(rv.to_owned(), slot.to_owned()))
                .cloned()
        }

        /// Overwrite a slot directly, first-write-wins included. Stands in for a relay (or a
        /// MITM in front of one) that hands a caller different bytes than the ones actually
        /// posted — first-write-wins refuses a *second poster* that trick, so making a slot lie
        /// needs to reach past the guard rather than through it.
        fn set_blob(&self, rv: &str, slot: &str, blob: &str) {
            self.store
                .lock()
                .unwrap()
                .insert((rv.to_owned(), slot.to_owned()), blob.to_owned());
        }
    }

    /// The typed code is unchanged; the QR is not a picture of it any more.
    #[test]
    fn an_offer_carries_a_url_and_the_typed_code_is_unchanged() {
        let a = db();
        let mut pa = None;
        let offer = begin(&a, &mut pa).unwrap();

        // 105 payload-plus-checksum characters, hyphens aside — `invite.rs`'s own arithmetic,
        // unmoved by this task.
        assert_eq!(offer.code.chars().filter(|c| *c != '-').count(), 105);

        let base = entitlement::base(&a);
        let expected_text = crate::sync_pair::invite::qr_payload(&offer.code, &base);
        let expected = crate::sync_pair::invite::qr_matrix(&expected_text).unwrap();
        assert_eq!(offer.qr.modules.len(), offer.qr.width * offer.qr.width);
        assert_eq!(offer.qr.modules, expected.modules);
        assert_ne!(
            offer.qr.modules,
            crate::sync_pair::invite::qr_matrix(&offer.code).unwrap().modules,
            "the QR must draw the relay's URL, not a picture of the bare code"
        );
    }

    /// Both sides land on the same rendezvous from the invite alone — the whole reason the
    /// ceremony works with no second hand-carry.
    #[tokio::test]
    async fn the_two_sides_derive_the_same_rendezvous() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let mut pa = None;
        let mut pb = None;

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();

        let a_rv = pa.as_ref().unwrap().rv.clone();
        let b_rv = pb.as_ref().unwrap().rv.clone();
        assert_eq!(
            a_rv, b_rv,
            "both sides must meet at the same address with nothing hand-carried but the invite"
        );
        assert_eq!(a_rv, crypto::rendezvous_id(&pa.as_ref().unwrap().token));
    }

    /// The sealed blob's layout is unchanged — `<device_id>\0` then a seal over
    /// `<group_id>\0<epoch>\0<32-byte key>`, key last — and the epoch sealed is the one this
    /// device is *at* when `confirm` runs, not one a rotation might move it to first.
    #[tokio::test]
    async fn confirm_seals_at_the_current_epoch_and_the_layout_is_unchanged() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        let sealed = confirm(&a, &mut pa).await.unwrap();

        let group = crate::sync_pair::identity::group(&a)
            .unwrap()
            .expect("confirm minted a group");
        let me_a = crate::sync_pair::identity::ensure(&a).unwrap();
        let pair_key = pb
            .as_ref()
            .unwrap()
            .pair_key
            .expect("B derived the same pair key");

        let blob = crate::sync_pair::invite::blob_decode(&sealed.sealed_key).unwrap();
        let split = blob.iter().position(|byte| *byte == 0).unwrap();
        let device_id = String::from_utf8_lossy(&blob[..split]).into_owned();
        assert_eq!(device_id, me_a.device_id, "the clear prefix is A's own device id");

        let plain = crypto::open(&pair_key, device_id.as_bytes(), &blob[split + 1..]).unwrap();
        let mut parts = plain.splitn(3, |byte| *byte == 0);
        let got_group_id = String::from_utf8_lossy(parts.next().unwrap()).into_owned();
        let got_epoch: i64 = String::from_utf8_lossy(parts.next().unwrap())
            .parse()
            .unwrap();
        let got_key = parts.next().unwrap();

        assert_eq!(got_group_id, group.group_id);
        assert_eq!(got_epoch, group.epoch, "the epoch sealed must be the current one");
        assert_eq!(got_key, group.group_key.as_slice(), "the key is the LAST field");
    }

    /// A failed post at step 2 must leave nothing committed — the whole reason step 2 runs
    /// before step 3. Mutate: swap them, and this goes red.
    #[tokio::test]
    async fn a_failed_offer_post_leaves_nothing_committed() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();

        // A relay that refuses every request, so the post in step 2 fails.
        let bad = MockServer::start_async().await;
        bad.mock(|when, then| {
            when.method(POST).path_matches(r"^/p/.*$");
            then.status(500);
        });
        client::set_state(&a, client::RELAY_URL, &bad.base_url()).unwrap();

        let error = confirm(&a, &mut pa)
            .await
            .expect_err("a failed post must fail confirm");
        assert!(error.contains("500"), "{error}");

        assert!(
            crate::sync_pair::identity::group(&a).unwrap().is_none(),
            "nothing was minted locally"
        );
        assert_eq!(
            crate::sync_pair::identity::roster(&a).unwrap().len(),
            0,
            "no device was added to a roster that does not exist"
        );
        assert!(
            !pa.as_ref().unwrap().spent,
            "a failed post must not spend the offer -- the reader can press again"
        );
    }

    /// The same failure, against a device that already had a group: the existing group and its
    /// one-device roster must not move either.
    #[tokio::test]
    async fn a_failed_offer_post_leaves_an_existing_group_untouched() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let me = crate::sync_pair::identity::ensure(&a).unwrap();
        let group_before = crate::sync_pair::identity::create_group(&a, &me).unwrap();

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();

        let bad = MockServer::start_async().await;
        bad.mock(|when, then| {
            when.method(POST).path_matches(r"^/p/.*$");
            then.status(500);
        });
        client::set_state(&a, client::RELAY_URL, &bad.base_url()).unwrap();

        confirm(&a, &mut pa)
            .await
            .expect_err("a failed post must fail confirm");

        assert_eq!(
            crate::sync_pair::identity::group(&a).unwrap().unwrap(),
            group_before,
            "the existing group must not move"
        );
        assert_eq!(
            crate::sync_pair::identity::roster(&a).unwrap().len(),
            1,
            "the peer must not have been added"
        );
    }

    /// A whole pairing, two databases, a fake relay standing in for the rendezvous. Both ends
    /// must end up holding the same group key, and the six digits both readers were shown must
    /// have matched.
    #[tokio::test]
    async fn two_databases_pair_and_agree_on_the_key() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let mut a_pending = None;
        let mut b_pending = None;

        let offer = begin(&a, &mut a_pending).unwrap();
        let accepted = accept(&b, &mut b_pending, &offer.code).await.unwrap();
        let progress = poll(&a, &mut a_pending, now_ms()).await.unwrap();
        assert_eq!(progress.stage, STAGE_COMPARE);

        assert_eq!(
            accepted.sas,
            progress.sas.unwrap(),
            "the two readers must be shown the same six digits"
        );

        let sealed = confirm(&a, &mut a_pending).await.unwrap();
        let progress = poll(&b, &mut b_pending, now_ms()).await.unwrap();
        assert_eq!(progress.stage, STAGE_COMPLETE);

        let ga = crate::sync_pair::identity::group(&a).unwrap().unwrap();
        let gb = crate::sync_pair::identity::group(&b).unwrap().unwrap();
        assert_eq!(ga.group_id, gb.group_id);
        assert_eq!(ga.group_key, gb.group_key);
        assert_eq!(ga.epoch, gb.epoch);
        // `sealed` is still produced even though `poll`/`complete` never read it here — see
        // `SealedKey`'s own doc for why it is kept.
        assert!(!sealed.sealed_key.is_empty());
    }

    /// Each side ends up knowing about the other.
    #[tokio::test]
    async fn both_rosters_name_both_devices() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        confirm(&a, &mut pa).await.unwrap();
        poll(&b, &mut pb, now_ms()).await.unwrap();

        let ra = crate::sync_pair::identity::roster(&a).unwrap();
        let rb = crate::sync_pair::identity::roster(&b).unwrap();
        assert_eq!(ra.len(), 2, "A knows about B");
        assert_eq!(rb.len(), 2, "B knows about A");

        // And each names the *other* device by the id that device actually has, rather than
        // by whatever it read off a blob.
        let me_a = crate::sync_pair::identity::ensure(&a).unwrap();
        let me_b = crate::sync_pair::identity::ensure(&b).unwrap();
        assert!(ra.iter().any(|d| d.device_id == me_b.device_id));
        assert!(rb.iter().any(|d| d.device_id == me_a.device_id));
        // The key each side filed for the other is that device's real public key. A roster
        // that recorded the wrong one would encrypt to a device that cannot read it.
        assert_eq!(
            ra.iter()
                .find(|d| d.device_id == me_b.device_id)
                .unwrap()
                .public_key,
            me_b.keypair.public
        );
        assert_eq!(
            rb.iter()
                .find(|d| d.device_id == me_a.device_id)
                .unwrap()
                .public_key,
            me_a.keypair.public
        );
    }

    /// The name B chose travels sealed, so a relay cannot swap it either.
    #[tokio::test]
    async fn the_joiner_is_filed_under_the_name_it_sent() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let me_b = crate::sync_pair::identity::ensure(&b).unwrap();
        crate::sync_pair::identity::rename_device(&b, &me_b.device_id, "Kitchen laptop").unwrap();

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        confirm(&a, &mut pa).await.unwrap();

        let filed = crate::sync_pair::identity::roster(&a)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == me_b.device_id)
            .expect("B is on A's roster");
        assert_eq!(filed.name, "Kitchen laptop");
    }

    /// A third device that intercepts and re-offers gets a *different* six digits at each end.
    /// This is the man-in-the-middle run end to end rather than at the crypto layer, and it is
    /// genuinely three-party: M begins its own offer to B while accepting A's.
    ///
    /// **The assertion is probabilistic at exactly the SAS's own strength**: two unrelated
    /// six-digit codes collide once in a million, which is the number §7.5 step 3 is worth and
    /// not a weakness of the test. Nothing can make it deterministic without seeding a key,
    /// and a seeded key here would be a far worse thing to own.
    #[tokio::test]
    async fn a_relay_in_the_middle_makes_the_two_codes_disagree() {
        let relay = FakeRelay::start().await;
        let a = db();
        let m = db();
        let b = db();
        relay.point(&a);
        relay.point(&m);
        relay.point(&b);
        let (mut pa, mut pm_join, mut pm_offer, mut pb) = (None, None, None, None);

        // A offers. M accepts it, so A ends up computing digits against M's key.
        let a_offer = begin(&a, &mut pa).unwrap();
        accept(&m, &mut pm_join, &a_offer.code).await.unwrap();
        let a_sees = poll(&a, &mut pa, now_ms()).await.unwrap();
        assert_eq!(a_sees.stage, STAGE_COMPARE);

        // M makes its own offer to B, so B computes digits against M's key too.
        let m_offer = begin(&m, &mut pm_offer).unwrap();
        let b_sees = accept(&b, &mut pb, &m_offer.code).await.unwrap();

        assert_ne!(
            a_sees.sas.unwrap(),
            b_sees.sas,
            "if these matched, a relay could join the group and §7.5 step 3 would be theatre"
        );
    }

    /// **The rendezvous is exactly the hop the SAS exists to distrust.** A relay (or a MITM in
    /// front of one) that hands A a different blob than the one B actually posted must still
    /// show two different sets of six digits — first-write-wins defends the *slot*, never a
    /// device from a relay lying about what is in it, so the defence has to be the SAS.
    ///
    /// **Probabilistic at the SAS's own strength**, `a_relay_in_the_middle...`'s sibling: two
    /// unrelated six-digit codes collide once in a million.
    #[tokio::test]
    async fn a_substituted_rendezvous_blob_moves_the_six_digits() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        // B answers honestly.
        let b_sees = accept(&b, &mut pb, &offer.code).await.unwrap();

        // The attacker decodes the same invite and derives its own answer — off a *different*
        // relay, since the shared one's slot is already filled and a second POST to it would
        // only prove first-write-wins, not the SAS. What is modelled here is a relay that lies
        // about what it holds, which first-write-wins cannot defend against once the relay
        // itself is the attacker.
        let m_relay = FakeRelay::start().await;
        let m = db();
        m_relay.point(&m);
        let mut pm = None;
        accept(&m, &mut pm, &offer.code).await.unwrap();
        let rv = pa.as_ref().unwrap().rv.clone();
        let attacker_blob = m_relay
            .blob(&rv, "join")
            .expect("M's own accept posted somewhere");
        relay.set_blob(&rv, "join", &attacker_blob);

        let progress = poll(&a, &mut pa, now_ms()).await.unwrap();
        assert_eq!(progress.stage, STAGE_COMPARE);

        assert_ne!(
            progress.sas.unwrap(),
            b_sees.sas,
            "a relay that can rewrite a rendezvous slot could rewrite both screens into \
             agreeing on a lie, and here it did not"
        );
    }

    /// The token is one-time. A second acceptance of the same offer must be refused — the
    /// relay's own first-write-wins gets there first now, but `respond`/`confirm`'s local
    /// `ALREADY_USED` guard is unchanged and this is what still drives it directly.
    #[tokio::test]
    async fn a_spent_offer_refuses_a_second_joiner() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        confirm(&a, &mut pa).await.unwrap();

        // A second joiner's blob, built off its own relay so the shared one's first-write-wins
        // is not what this test is about — `respond`/`confirm`'s own `spent` guard is.
        let c_relay = FakeRelay::start().await;
        let c = db();
        c_relay.point(&c);
        let mut pc = None;
        accept(&c, &mut pc, &offer.code).await.unwrap();
        let c_rv = pc.as_ref().unwrap().rv.clone();
        let c_blob = c_relay.blob(&c_rv, "join").unwrap();

        assert!(
            respond(&a, &mut pa, &c_blob).is_err(),
            "a spent offer must not accept a second joiner"
        );
        assert!(
            confirm(&a, &mut pa).await.is_err(),
            "and neither may it be confirmed a second time"
        );
        assert_eq!(
            crate::sync_pair::identity::roster(&a).unwrap().len(),
            2,
            "C must not have reached the roster"
        );
    }

    /// Confirming before the two sides have exchanged keys is a state that cannot produce a
    /// key, and it must say so rather than sealing to nothing. No relay involved: `confirm`
    /// refuses this before it ever reaches the network.
    #[tokio::test]
    async fn confirm_before_respond_is_refused() {
        let a = db();
        let mut pa = None;
        begin(&a, &mut pa).unwrap();
        assert!(confirm(&a, &mut pa).await.is_err());
        assert!(
            crate::sync_pair::identity::group(&a).unwrap().is_none(),
            "a refused confirm must not have minted a group"
        );
    }

    /// Nothing in flight is not a pairing, and every step says so rather than panicking.
    #[tokio::test]
    async fn every_step_refuses_when_nothing_is_in_flight() {
        let a = db();
        let mut pa = None;
        assert!(respond(&a, &mut pa, "anything").is_err());
        assert!(confirm(&a, &mut pa).await.is_err());
        assert!(complete(&a, &mut pa, "anything").is_err());
    }

    /// The joining device cannot be asked to play the offering one's part.
    #[tokio::test]
    async fn a_joiner_cannot_respond_and_an_offerer_cannot_complete() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        assert!(
            respond(&b, &mut pb, "anything").is_err(),
            "B is joining a group, not offering one"
        );
    }

    /// Cancelling throws the offer away, and the code that was on screen stops working.
    #[tokio::test]
    async fn cancelling_makes_the_offer_unusable() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        cancel(&mut pa);
        accept(&b, &mut pb, &offer.code).await.unwrap();
        assert!(respond(&a, &mut pa, "anything").is_err());
    }

    /// A tampered sealed key is refused, and B stays unpaired rather than half-paired.
    #[tokio::test]
    async fn a_tampered_sealed_key_leaves_b_unpaired() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        let sealed = confirm(&a, &mut pa).await.unwrap();

        assert!(complete(&b, &mut pb, &bend(&sealed.sealed_key)).is_err());
        assert!(
            crate::sync_pair::identity::group(&b).unwrap().is_none(),
            "B must be unpaired, not half-paired"
        );
        // And the untouched blob still works, so the refusal above was about the tampering
        // rather than about the blob never having been readable.
        complete(&b, &mut pb, &sealed.sealed_key).unwrap();
        assert!(crate::sync_pair::identity::group(&b).unwrap().is_some());
    }

    /// A tampered response is refused at the AEAD, before anything reaches the roster.
    #[tokio::test]
    async fn a_tampered_response_never_reaches_the_roster() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        let rv = pa.as_ref().unwrap().rv.clone();
        let honest = relay.blob(&rv, "join").unwrap();

        assert!(respond(&a, &mut pa, &bend(&honest)).is_err());
        assert!(confirm(&a, &mut pa).await.is_err(), "nothing was agreed");
        assert!(crate::sync_pair::identity::roster(&a).unwrap().is_empty());
    }

    /// A device already in a group cannot be walked into a second one.
    ///
    /// **The whole pairing succeeds cryptographically and is still refused**, which is the
    /// point: joining group two overwrites the key this device is syncing group one under, and
    /// nothing here can get that key back. A re-pair after a revocation carries the *same*
    /// group id and is allowed by the same check.
    #[tokio::test]
    async fn joining_a_second_group_is_refused_and_the_first_key_survives() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        let c = db();
        relay.point(&a);
        relay.point(&b);
        relay.point(&c);
        let (mut pa, mut pb, mut pc) = (None, None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        confirm(&a, &mut pa).await.unwrap();
        poll(&b, &mut pb, now_ms()).await.unwrap();
        let joined = crate::sync_pair::identity::group(&b).unwrap().unwrap();

        // C runs a perfectly good pairing at B, into a group of its own.
        let c_offer = begin(&c, &mut pc).unwrap();
        accept(&b, &mut pb, &c_offer.code).await.unwrap();
        poll(&c, &mut pc, now_ms()).await.unwrap();
        let sealed_c = confirm(&c, &mut pc).await.unwrap();

        assert!(complete(&b, &mut pb, &sealed_c.sealed_key).is_err());
        assert_eq!(
            crate::sync_pair::identity::group(&b).unwrap().unwrap(),
            joined,
            "B kept the key it was already syncing under"
        );
    }

    /// A device already in a group invites into *that* group, rather than minting a second one
    /// and quietly leaving the first.
    #[tokio::test]
    async fn a_second_offer_invites_into_the_group_this_device_is_already_in() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        confirm(&a, &mut pa).await.unwrap();

        let group = crate::sync_pair::identity::group(&a).unwrap().unwrap();
        let second = begin(&a, &mut pa).unwrap();
        let inv = crate::sync_pair::invite::Invite::decode(&second.code).unwrap();
        assert_eq!(Some(inv.group_id), from_hex16(&group.group_id));
        assert_ne!(inv.token, [0u8; 16]);
    }

    /// Two offers in a row carry different tokens. A token that was reused would make the
    /// pair key reusable, which is the whole thing the salt exists to prevent.
    #[test]
    fn two_offers_carry_different_tokens() {
        let a = db();
        let mut pa = None;
        let first = crate::sync_pair::invite::Invite::decode(&begin(&a, &mut pa).unwrap().code)
            .unwrap()
            .token;
        let second = crate::sync_pair::invite::Invite::decode(&begin(&a, &mut pa).unwrap().code)
            .unwrap()
            .token;
        assert_ne!(first, second);
    }

    /// What Settings draws, before and after.
    #[tokio::test]
    async fn status_answers_the_panel_before_and_after_pairing() {
        let relay = FakeRelay::start().await;
        let a = db();
        relay.point(&a);
        let mut pa = None;
        let before = status(&a).unwrap();
        assert_eq!(before.device_id.len(), 32);
        // The panel's heading is whatever this machine minted — a hostname on a desktop, a
        // model on a phone. The shape is what a test on any machine can assert: a real name,
        // and not the placeholder every install used to share.
        assert_eq!(
            before.device_name,
            crate::sync_pair::identity::ensure(&a).unwrap().name
        );
        assert!(!before.device_name.trim().is_empty());
        assert_ne!(before.device_name, "This device");
        assert!(before.group_id.is_none());
        assert!(before.epoch.is_none());
        assert!(before.devices.is_empty());

        let b = db();
        relay.point(&b);
        let mut pb = None;
        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        confirm(&a, &mut pa).await.unwrap();
        poll(&b, &mut pb, now_ms()).await.unwrap();

        let after = status(&a).unwrap();
        assert_eq!(
            after.device_id, before.device_id,
            "the device did not change"
        );
        assert!(after.group_id.is_some());
        assert_eq!(after.epoch, Some(0));
        assert_eq!(after.devices.len(), 2);
    }

    /// A removed device is off the list the panel draws **and off the roster underneath it**,
    /// and the second half is the reversal.
    ///
    /// **This asserted the opposite until spec §2.3.** The doc it replaces argued that the
    /// roster had to keep the row, because deleting it would "quietly hand a full baseline to a
    /// device that is never going to answer" — which was never true and is plainly not now:
    /// `baseline::peers_needing` reads `WHERE revoked_at IS NULL`, and a row that has been
    /// deleted satisfies that by not being there to select at all. What is true is that the
    /// relay's manifest **is** the roster now, so a remover that kept a tombstone would be the
    /// one machine in the group with a different answer about who is in it, and `add_device`
    /// puts a re-paired device back by insert rather than by clearing a stamp.
    ///
    /// **`status`'s filter stays and both halves are still asserted**, because a database
    /// written by a build that predates the delete can still hold a stamped row and the panel
    /// must not draw it.
    #[test]
    fn a_removed_device_is_off_the_panel_and_off_the_roster() {
        let conn = db();
        let me = identity::ensure(&conn).unwrap();
        identity::create_group(&conn, &me).unwrap();
        identity::add_device(&conn, "deadbeef", &[7u8; 32], "Phone").unwrap();
        let plan = identity::plan_rotation(&conn, "deadbeef").unwrap();
        identity::commit_rotation(&conn, "deadbeef", &plan).unwrap();

        let drawn = status(&conn).unwrap();
        assert_eq!(
            drawn
                .devices
                .iter()
                .map(|d| d.device_id.as_str())
                .collect::<Vec<_>>(),
            vec![me.device_id.as_str()],
            "the removed device is still being drawn"
        );
        assert_eq!(
            identity::roster(&conn).unwrap().len(),
            1,
            "the row was stamped rather than deleted"
        );
    }

    // -----------------------------------------------------------------------------------
    // The removal, with the relay in the middle of it
    //
    // **Driven through `remove_device` rather than through `sync_device_revoke`**, which takes a
    // `tauri::State` no test can build. The command is four lines around this function and a
    // `block_on`; everything that can be got wrong is here.
    // -----------------------------------------------------------------------------------

    /// A group of two, pointed at a relay on localhost.
    ///
    /// `entitled` decides whether this device holds a grant, which is spec §2.4's fourth
    /// refusal: a group with no membership cannot publish a rotation and so may not remove
    /// anybody.
    fn removable(
        server: &httpmock::MockServer,
        entitled: bool,
    ) -> (Connection, identity::Identity, String) {
        let conn = db();
        let me = identity::ensure(&conn).unwrap();
        identity::create_group(&conn, &me).unwrap();
        identity::add_device(&conn, "deadbeef", &[7u8; 32], "Phone").unwrap();
        client::set_state(&conn, client::RELAY_URL, &server.base_url()).unwrap();
        if entitled {
            // Twelve hours, absolutely — `client/tests.rs`'s `grant` and its reasoning: derived
            // from `REFRESH_MARGIN_SECS` this would shrink with the margin and start making a
            // `/token` round trip nothing here has a mock for.
            let expires: i64 = conn
                .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
                .unwrap()
                + 12 * 60 * 60;
            entitlement::store_grant(&conn, "access-1", "refresh-1", expires).unwrap();
        }
        let group = identity::group(&conn).unwrap().unwrap().group_id;
        (conn, me, group)
    }

    /// The three requests the round trip in front of a removal makes, all answering "nothing to
    /// do". There is no `/push` mock because the outbox is empty — `memory_pair` installs no
    /// capture triggers — so a push that happened would 404 loudly rather than pass silently.
    fn quiet_round_trip(server: &httpmock::MockServer, group: &str) {
        server.mock(|when, then| {
            when.method(GET).path(format!("/g/{group}/keys"));
            then.status(200).json_body(serde_json::json!({
                "epoch": 0, "blob": serde_json::Value::Null, "devices": [],
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path(format!("/g/{group}/pull"));
            then.status(200)
                .json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
        });
        server.mock(|when, then| {
            when.method(POST).path(format!("/g/{group}/ack"));
            then.status(204);
        });
    }

    /// **A `/rotate` the relay refuses removes nothing at all.**
    ///
    /// This is the whole reason `plan_rotation` writes no row and `commit_rotation` runs last.
    /// The version this replaced rotated first and unconditionally, so a device that pressed
    /// Remove held a key nobody else could ever learn: it pushed at epoch *N+1* while every
    /// remaining device sat at *N*, `client::pull` set `behind = true` and held its cursor for
    /// ever, and one removal bricked any group of three.
    ///
    /// **The group is compared whole**, not epoch by epoch: `Group` is `PartialEq` over the id,
    /// the epoch and the key, so a commit that moved any of the three fails this.
    #[tokio::test]
    async fn a_rotation_the_relay_refuses_removes_nothing() {
        let server = MockServer::start_async().await;
        let (conn, _me, group) = removable(&server, true);
        quiet_round_trip(&server, &group);
        let rotate = server.mock(|when, then| {
            when.method(POST).path(format!("/g/{group}/rotate"));
            then.status(500).body("nope");
        });
        let before = identity::group(&conn).unwrap().unwrap();

        let error = remove_device(&conn, "deadbeef")
            .await
            .expect_err("a 500 on /rotate is a failed removal");

        assert!(error.contains("500"), "{error}");
        rotate.assert();
        assert_eq!(
            identity::group(&conn).unwrap().unwrap(),
            before,
            "the group moved on a rotation the relay never accepted"
        );
        assert_eq!(
            identity::roster(&conn).unwrap().len(),
            2,
            "the departing device's row was deleted anyway"
        );
    }

    /// ...and one it accepts commits, publishing the plan the commit then writes.
    ///
    /// **The `auth` on the wire is compared against the key that ends up stored**, which is what
    /// says the published rotation and the committed one are the same rotation. Sending the
    /// *old* epoch's auth as the body's `auth` — an easy transposition, since the header really
    /// does carry the old one — would leave the relay standing on a value no device can derive,
    /// and nothing local would look wrong.
    #[tokio::test]
    async fn an_accepted_rotation_publishes_the_plan_it_then_commits() {
        let server = MockServer::start_async().await;
        let (conn, me, group) = removable(&server, true);
        quiet_round_trip(&server, &group);
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let recorder = seen.clone();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/g/{group}/rotate"))
                .is_true(move |req: &httpmock::prelude::HttpMockRequest| {
                    recorder.lock().unwrap().push(req.body_string());
                    true
                });
            then.status(200)
                .json_body(serde_json::json!({ "epoch": 1 }));
        });
        let before = identity::group(&conn).unwrap().unwrap();

        remove_device(&conn, "deadbeef").await.expect("removed");

        let after = identity::group(&conn).unwrap().unwrap();
        assert_eq!(after.epoch, before.epoch + 1);
        assert_ne!(after.group_key, before.group_key, "the key did not change");
        assert_eq!(
            identity::roster(&conn)
                .unwrap()
                .into_iter()
                .map(|d| d.device_id)
                .collect::<Vec<_>>(),
            vec![me.device_id.clone()],
            "the removed row is gone and nobody else went with it"
        );

        let body: serde_json::Value =
            serde_json::from_str(&seen.lock().unwrap()[0]).expect("a JSON body");
        assert_eq!(body["epoch"], serde_json::json!(after.epoch));
        assert_eq!(
            body["auth"].as_str().unwrap(),
            crypto::relay_auth(&after.group_key, &after.group_id, after.epoch),
            "the published auth is not the one the committed key derives"
        );
        let keys = body["keys"].as_object().expect("a manifest object");
        assert!(
            keys.contains_key(&me.device_id),
            "the remover is not on its own manifest, so a failed commit could not heal"
        );
        assert!(
            !keys.contains_key("deadbeef"),
            "the manifest names the device being removed, which puts it straight back"
        );
    }

    /// **A group with no membership is refused before anything moves** — spec §2.4's fourth
    /// refusal, and *before* the round trip rather than after it.
    ///
    /// The relay is what carries a removal to the other devices and only a claimed group has an
    /// auth `/rotate` will accept, so rotating locally anyway is exactly the bug this change
    /// exists to end. The server answers **any** request, so a single call of any shape — the
    /// `/keys` check at the top of the round trip included — fails this.
    #[tokio::test]
    async fn a_group_with_no_membership_is_refused_before_the_round_trip() {
        let server = MockServer::start_async().await;
        let never = server.mock(|when, then| {
            when.any_request();
            then.status(500).body("this must never be asked for");
        });
        let (conn, _me, _group) = removable(&server, false);
        let before = identity::group(&conn).unwrap().unwrap();

        let error = remove_device(&conn, "deadbeef")
            .await
            .expect_err("an unentitled group cannot remove anybody");

        assert_eq!(error, identity::NO_MEMBERSHIP);
        never.assert_calls(0);
        assert_eq!(identity::group(&conn).unwrap().unwrap(), before);
        assert_eq!(identity::roster(&conn).unwrap().len(), 2);
    }

    // -----------------------------------------------------------------------------------
    // Leaving — spec §2.1, and the two halves that have to be written together
    // -----------------------------------------------------------------------------------

    /// **A `/rotate` the relay refuses does not stop this device leaving.**
    ///
    /// This is the whole of *"leaving is always possible"*: the reader on a plane, and the reader
    /// whose membership lapsed, both get out of the group. Red if the local clear is put behind
    /// the POST's success — which is `remove_device`'s correct order, and exactly the wrong one
    /// here.
    ///
    /// **`rotate.assert()` is what stops this test being satisfied by never publishing at all**,
    /// and its sibling below is the other half of that fence.
    #[tokio::test]
    async fn leaving_clears_the_group_even_when_the_relay_refuses() {
        let server = MockServer::start_async().await;
        let (conn, _me, group) = removable(&server, true);
        let rotate = server.mock(|when, then| {
            when.method(POST).path(format!("/g/{group}/rotate"));
            then.status(500).body("nope");
        });
        assert!(
            identity::group(&conn).unwrap().is_some(),
            "the fixture is about a group"
        );

        leave_group_now(&conn)
            .await
            .expect("a 500 on /rotate is not a reason a reader cannot leave");

        rotate.assert();
        assert!(
            identity::group(&conn).unwrap().is_none(),
            "the group survived a departure the relay refused"
        );
        assert_eq!(
            identity::roster(&conn).unwrap().len(),
            0,
            "the roster survived a departure the relay refused"
        );
    }

    /// **A roster this device cannot seal to is still a group it can leave**, and that is the
    /// literal reading of "always possible".
    ///
    /// `plan_departure` reads every peer's public key and seals the new group key to each, so a
    /// single bad row — a key an older build wrote short, a column somebody edited by hand — makes
    /// the *plan* fail. Chained behind a `?`, that is a device which can never get out of its
    /// group, and the reader asked for the opposite. Planning is therefore best effort exactly as
    /// publishing is.
    ///
    /// **What is lost is the courtesy, never the departure.** Nothing is published, so the other
    /// devices go on listing this one until somebody removes it by hand. The panel says so.
    ///
    /// A 32-byte public key of zeroes is the fixture: `bytes32` answers zeroes for a column of the
    /// wrong length, so this is also what a hand-edited database looks like from here.
    #[tokio::test]
    async fn leaving_works_even_when_the_departure_cannot_be_planned() {
        let server = MockServer::start_async().await;
        let (conn, _me, _group) = removable(&server, true);
        // **This device is not on its own roster.** `plan` looks for the departing id among
        // the members and answers `NOT_ON_THE_ROSTER` when it is absent, and that shape is
        // reachable rather than invented: `commit_rotation` and `adopt_epoch` both DELETE
        // roster rows, so a pass interrupted between the sweep and the group write leaves
        // exactly this.
        //
        // **An all-zero public key is not the fixture, and that is worth recording**:
        // x25519 accepts one and `wrap_group_key` seals to it perfectly happily, so a test
        // built on that asserts nothing at all. The anti-vacuity line below is what caught
        // it, which is the whole reason it is there.
        conn.execute(
            "DELETE FROM sync_devices WHERE device_id = \
             (SELECT device_id FROM sync_identity WHERE id = 1)",
            [],
        )
        .expect("take this device off its own roster");

        assert!(
            identity::plan_departure(&conn).is_err(),
            "the fixture must be one that cannot be planned, or this test is about nothing"
        );

        leave_group_now(&conn)
            .await
            .expect("a roster that cannot be sealed to is still a group a reader may leave");

        assert!(
            identity::group(&conn).unwrap().is_none(),
            "the group survived a departure that could not be planned"
        );
        assert!(
            !entitlement::membership_ended(&conn),
            "leaving used revoke rather than clear"
        );
    }

    /// ...and one the relay accepts publishes a manifest that closes the group behind the leaver.
    ///
    /// ⚠️ **Written because the test above cannot see this.** "Always possible" is satisfiable by
    /// never publishing at all, and an implementation that dropped `post_rotation` entirely would
    /// leave every remaining device listing a device that has gone, for ever. Red if the manifest
    /// names the leaver (the group never closes), if it omits a device that stays (a departure
    /// would evict somebody else), or if a 200 leaves the group standing.
    #[tokio::test]
    async fn leaving_clears_the_group_when_the_relay_accepts() {
        let server = MockServer::start_async().await;
        let (conn, me, group) = removable(&server, true);
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let recorder = seen.clone();
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/g/{group}/rotate"))
                .is_true(move |req: &httpmock::prelude::HttpMockRequest| {
                    recorder.lock().unwrap().push(req.body_string());
                    true
                });
            then.status(200)
                .json_body(serde_json::json!({ "epoch": 1 }));
        });
        let before = identity::group(&conn).unwrap().unwrap();

        leave_group_now(&conn).await.expect("left");

        rotate.assert();
        let body: serde_json::Value =
            serde_json::from_str(&seen.lock().unwrap()[0]).expect("a JSON body");
        assert_eq!(body["epoch"], serde_json::json!(before.epoch + 1));
        let keys = body["keys"].as_object().expect("a manifest object");
        assert!(
            keys.contains_key("deadbeef"),
            "the device that stays is not on the manifest, so a departure evicts it too"
        );
        assert!(
            !keys.contains_key(&me.device_id),
            "the leaver named itself, so the group never closes behind it"
        );
        assert!(identity::group(&conn).unwrap().is_none());
        assert_eq!(identity::roster(&conn).unwrap().len(), 0);
    }

    /// **Leaving clears the grant — `clear`, never `revoke`** — spec §2.3.
    ///
    /// The grant has to go, because a leaver keeping its refresh secret keeps a working
    /// credential for the group it left. But nothing *ended*: the reader's pledge is untouched,
    /// and `revoke`'s mark would draw *Membership ended* and its reassurance at somebody whose
    /// membership is fine. Red if `revoke` is called instead — `membership_ended` reads true
    /// afterwards, because that call leaves a `dead` status row behind — and red if the grant is
    /// left in place at all.
    #[tokio::test]
    async fn leaving_clears_the_grant() {
        let server = MockServer::start_async().await;
        let (conn, _me, group) = removable(&server, true);
        entitlement::store_status(&conn, "active", Some(1_700_000_000)).unwrap();
        server.mock(|when, then| {
            when.method(POST).path(format!("/g/{group}/rotate"));
            then.status(200)
                .json_body(serde_json::json!({ "epoch": 1 }));
        });
        assert!(
            entitlement::refresh_secret(&conn).is_some(),
            "the fixture is about a device that holds a grant"
        );

        leave_group_now(&conn).await.expect("left");

        assert_eq!(
            entitlement::refresh_secret(&conn),
            None,
            "a leaver kept a credential that still opens the group it left"
        );
        assert_eq!(client::get_state(&conn, entitlement::ACCESS_TOKEN), None);
        assert_eq!(
            client::get_state(&conn, entitlement::SUPPORTER_STATUS),
            None
        );
        assert!(
            !entitlement::membership_ended(&conn),
            "`revoke` was called instead of `clear`, so the panel now tells a paying reader \
             their membership ended"
        );
    }

    // -----------------------------------------------------------------------------------
    // The device cap at the ceremony — spec §4.3
    //
    // **The relay is the fence and this is the message.** These refusals are advisory by
    // construction: this repository is public and a modified build simply would not ask. What
    // they buy is that a reader meets the limit at the press rather than at a sync three minutes
    // later.
    // -----------------------------------------------------------------------------------

    /// Live rows on a roster — the count the cap is taken over.
    fn live(conn: &Connection) -> usize {
        identity::roster(conn)
            .unwrap()
            .into_iter()
            .filter(|d| d.revoked_at.is_none())
            .count()
    }

    /// A whole ceremony from A's side, up to the sealed key A hands back. Both connections are
    /// pointed at `relay` first, since `accept` and `confirm` now need somewhere to post to.
    async fn offer_to(
        relay: &FakeRelay,
        a: &Connection,
        b: &Connection,
    ) -> Result<SealedKey, String> {
        relay.point(a);
        relay.point(b);
        let (mut pa, mut pb) = (None, None);
        let offer = begin(a, &mut pa).unwrap();
        accept(b, &mut pb, &offer.code).await.unwrap();
        poll(a, &mut pa, now_ms()).await.unwrap();
        confirm(a, &mut pa).await
    }

    /// **The initiator refuses the sixth device, counts live rows only, and is not off by one.**
    ///
    /// Three readings, each a different way to get it wrong:
    /// * at four live devices plus a **tombstone** an older build stamped, the fifth is admitted
    ///   — red if the guard counts revoked rows, which would cost a reader a slot for a device
    ///   that left last year;
    /// * at five, the sixth is refused and **nothing is written** — red if the guard is off by
    ///   one at five, or if it refuses after `add_device` rather than before it;
    /// * at five, a device **already in the group** still pairs — red if the joiner is counted
    ///   against the cap it is being measured for, which would mean a full group could never
    ///   repair a pairing.
    #[tokio::test]
    async fn pairing_refuses_a_sixth_device() {
        let relay = FakeRelay::start().await;
        let a = db();
        relay.point(&a);
        let me = identity::ensure(&a).unwrap();
        identity::create_group(&a, &me).unwrap();
        for n in 1..=3u8 {
            identity::add_device(&a, &format!("peer{n}"), &[n; 32], "Peer").unwrap();
        }
        // A row a build that stamped rather than deleted left behind. It is not a member.
        identity::add_device(&a, "ghost", &[9u8; 32], "Ghost").unwrap();
        a.execute(
            "UPDATE sync_devices SET revoked_at = unixepoch() WHERE device_id = 'ghost'",
            [],
        )
        .unwrap();
        assert_eq!(live(&a), 4, "four live devices and one tombstone");

        let fifth = db();
        offer_to(&relay, &a, &fifth)
            .await
            .expect("a stale tombstone cost the reader a slot");
        assert_eq!(live(&a), 5, "the group is full");

        let sixth = db();
        let refused = offer_to(&relay, &a, &sixth)
            .await
            .expect_err("a sixth device was let into the group");
        assert_eq!(refused, identity::GROUP_IS_FULL);
        assert_eq!(
            live(&a),
            5,
            "the refused device was filed on the roster anyway"
        );

        // ...and the device already in it is not a sixth of anything.
        offer_to(&relay, &a, &fifth)
            .await
            .expect("re-pairing a device already in a full group was refused");
        assert_eq!(live(&a), 5);
    }

    /// **The joining side refuses one too**, for the asymmetric case the initiator's check cannot
    /// see: a device still in the group whose own roster no longer names the initiator, where
    /// completing files a sixth row.
    ///
    /// Red if `complete` writes the row without asking, and red if the guard counts the peer it
    /// is about to admit — the second half drives the same ceremony against a roster of four and
    /// requires it to succeed.
    #[tokio::test]
    async fn completing_refuses_a_sixth_device() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        relay.point(&a);
        relay.point(&b);
        let (mut pa, mut pb) = (None, None);
        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        let sealed = confirm(&a, &mut pa).await.unwrap();
        complete(&b, &mut pb, &sealed.sealed_key).unwrap();

        // B adopts an epoch whose manifest did not name A, and fills up with four others: five
        // live rows, none of them the device it is about to be handed a key by.
        let me_a = identity::ensure(&a).unwrap();
        b.execute(
            "DELETE FROM sync_devices WHERE device_id = ?1",
            rusqlite::params![me_a.device_id],
        )
        .unwrap();
        for n in 1..=3u8 {
            identity::add_device(&b, &format!("peer{n}"), &[n; 32], "Peer").unwrap();
        }
        assert_eq!(live(&b), 4, "B and three others");

        // At four, A is the fifth and completing works.
        let (mut pa, mut pb) = (None, None);
        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        let sealed = confirm(&a, &mut pa).await.unwrap();
        complete(&b, &mut pb, &sealed.sealed_key).expect("the fifth device was refused");
        assert_eq!(live(&b), 5);

        // At five, with A off the roster again, it is refused.
        b.execute(
            "DELETE FROM sync_devices WHERE device_id = ?1",
            rusqlite::params![me_a.device_id],
        )
        .unwrap();
        identity::add_device(&b, "peer4", &[4u8; 32], "Peer").unwrap();
        assert_eq!(live(&b), 5, "B and four others, none of them A");
        let (mut pa, mut pb) = (None, None);
        let offer = begin(&a, &mut pa).unwrap();
        accept(&b, &mut pb, &offer.code).await.unwrap();
        poll(&a, &mut pa, now_ms()).await.unwrap();
        let sealed = confirm(&a, &mut pa).await.unwrap();
        let refused = complete(&b, &mut pb, &sealed.sealed_key)
            .expect_err("a sixth row was filed on the joining side");
        assert_eq!(refused, identity::GROUP_IS_FULL);
        assert_eq!(live(&b), 5, "the refused device was filed anyway");
    }

    // -----------------------------------------------------------------------------------
    // The membership the pairing does NOT carry
    //
    // **This block asserted the opposite until spec §2.2.** §6.2 rode the refresh secret to the
    // second device inside the sealed blob so that device never opened a browser; §2.2 takes it
    // back out, because a device holding that secret can re-register the group auth and evict
    // the devices that removed it, and a removal that a removed device can undo is not one. The
    // joiner mints its own token through `/token`'s group door instead, off an auth derived from
    // the key it was handed — and is told the membership's status and date by the answer.
    // -----------------------------------------------------------------------------------

    /// A whole pairing, up to the sealed key A produces. Both connections are pointed at `relay`
    /// first, since `accept` and `confirm` now need somewhere to post to.
    async fn pair_up(
        relay: &FakeRelay,
        a: &Connection,
        pa: &mut Option<Pending>,
        b: &Connection,
        pb: &mut Option<Pending>,
    ) -> String {
        relay.point(a);
        relay.point(b);
        let offer = begin(a, pa).unwrap();
        accept(b, pb, &offer.code).await.unwrap();
        poll(a, pa, now_ms()).await.unwrap();
        confirm(a, pa).await.unwrap().sealed_key
    }

    /// Put a device in a group whose key is exactly these bytes.
    ///
    /// `create_group` mints a random one and `confirm` seals whatever group the device is
    /// already in, so this is the only way a test gets to name the key the blob has to carry.
    fn in_a_group_with_key(conn: &Connection, key: [u8; 32]) {
        let me = identity::ensure(conn).unwrap();
        // Thirty-two hex characters, because `begin` reads the id back through `from_hex16`.
        identity::join_group(conn, "0123456789abcdef0123456789abcdef", 0, &key, &me).unwrap();
    }

    /// **The joiner is handed a group and nothing else.**
    ///
    /// This asserted the exact opposite until spec §2.2, under the name
    /// `the_sealed_key_carries_the_refresh_secret_to_the_joiner`. The secret stays on the device
    /// that pressed Connect because a device that holds it can re-register the group auth and
    /// therefore evict the devices that removed it; what the joiner gets in its place is the
    /// group key, which is all `crypto::relay_auth` and `/token`'s group door need.
    ///
    /// **A holds a full grant here**, so every assertion below is about what `complete` declined
    /// to copy rather than about there having been nothing to copy — the same test written
    /// against an A with no membership would pass whatever `complete` did.
    #[tokio::test]
    async fn the_sealed_key_carries_no_membership_to_the_joiner() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);
        entitlement::store_grant(&a, "access-a", "refresh-a", 1_900_000_000).unwrap();

        let sealed = pair_up(&relay, &a, &mut pa, &b, &mut pb).await;
        complete(&b, &mut pb, &sealed).unwrap();

        assert!(
            identity::group(&b).unwrap().is_some(),
            "the pairing itself must still have happened"
        );
        assert_eq!(
            entitlement::refresh_secret(&b),
            None,
            "the Patreon-side secret reached a device that never pressed Connect"
        );
        // **Nor the access token, nor the expiry that used to be written beside it.** A's is a
        // 24-hour bearer token the relay minted for *A*; the placeholder that once stood in its
        // place existed only because `store_grant` writes the pair together, and there is no
        // pair to write any more.
        assert_eq!(client::get_state(&b, entitlement::ACCESS_TOKEN), None);
        assert_eq!(client::get_state(&b, entitlement::ACCESS_EXPIRES), None);
        // **And no supporter status.** What the relay last said about the membership is the
        // relay's own fact; B has not asked it yet, and learns one from `/token`'s group door on
        // its first round trip rather than by taking A's word for a date.
        assert_eq!(client::get_state(&b, entitlement::SUPPORTER_STATUS), None);
        assert_eq!(client::get_state(&b, entitlement::SUPPORTER_SINCE), None);
        // A kept its own, which is "the secret stays where it was" read from the other end: this
        // is a device declining to *send*, not one losing what it had.
        assert_eq!(
            entitlement::refresh_secret(&a).as_deref(),
            Some("refresh-a")
        );
    }

    /// **The field-order trap, made unmissable**, and it outlived the field it was written for.
    ///
    /// This was `a_zero_byte_in_the_group_key_does_not_swallow_the_refresh_secret` and its second
    /// half is gone with the secret. Its first half is not about that secret at all: `complete`
    /// splits the sealed plaintext on zero bytes, so the 32-byte group key is only safe as the
    /// **last** field and is only reassembled whole because the split is bounded. A fixture key
    /// of random bytes holds a zero about one time in eight, so `splitn(3)` relaxed to a plain
    /// `split` — an inviting simplification, now that there are exactly three fields — would
    /// pass on most runs and truncate the key on the rest: one pairing in eight, in the field,
    /// with nothing on either screen to say why. This key is nothing but zeroes, so it fails
    /// every time or never.
    #[tokio::test]
    async fn a_group_key_that_is_all_zeroes_still_arrives_whole() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);
        in_a_group_with_key(&a, [0u8; 32]);

        let sealed = pair_up(&relay, &a, &mut pa, &b, &mut pb).await;
        complete(&b, &mut pb, &sealed).unwrap();

        assert_eq!(
            identity::group(&b).unwrap().expect("B joined").group_key,
            [0u8; 32]
        );
    }

    /// Pairing must not require a membership: a reader can pair two devices and connect Patreon
    /// afterwards, in either order.
    ///
    /// **What it fences is a precondition nobody has written yet.** `confirm` no longer asks
    /// `entitlement` anything, so the tempting next edit — refusing to pair a group that cannot
    /// sync, the way `remove_device` refuses to rotate one — would make the second half of the
    /// reader's natural order impossible. This is the test that goes red for it.
    #[tokio::test]
    async fn a_host_with_no_grant_still_pairs() {
        let relay = FakeRelay::start().await;
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let sealed = pair_up(&relay, &a, &mut pa, &b, &mut pb).await;
        complete(&b, &mut pb, &sealed).unwrap();

        assert!(
            identity::group(&b).unwrap().is_some(),
            "the pairing itself happened; only the membership was absent"
        );
        assert_eq!(entitlement::refresh_secret(&b), None);
    }

    /// **Pairing never touches the joiner's own grant, whatever the other device holds.**
    ///
    /// This was `an_empty_refresh_does_not_take_the_joiners_own_membership_away` and asserted
    /// something weaker: that a *blank* field did not clear a membership this device had
    /// connected itself. There is no field at all now, so the claim is the whole of it — and the
    /// half that is new is the loop's second pass. Under the old shape an A **with** a grant
    /// overwrote B's own secret and expiry with A's, which is the case that could disconnect a
    /// reader who had connected Patreon on the very device they were joining from.
    #[tokio::test]
    async fn pairing_never_touches_the_joiners_own_grant() {
        for a_has_a_grant in [false, true] {
            let relay = FakeRelay::start().await;
            let a = db();
            let b = db();
            let (mut pa, mut pb) = (None, None);
            if a_has_a_grant {
                entitlement::store_grant(&a, "access-a", "refresh-a", 1_900_000_000).unwrap();
            }
            entitlement::store_grant(&b, "access-b", "refresh-b", 1_800_000_000).unwrap();

            let sealed = pair_up(&relay, &a, &mut pa, &b, &mut pb).await;
            complete(&b, &mut pb, &sealed).unwrap();

            assert_eq!(
                entitlement::refresh_secret(&b).as_deref(),
                Some("refresh-b"),
                "B's own secret did not survive pairing with an A that {}",
                if a_has_a_grant {
                    "held one"
                } else {
                    "held none"
                }
            );
            assert_eq!(
                client::get_state(&b, entitlement::ACCESS_TOKEN).as_deref(),
                Some("access-b"),
                "and its own access token still has the life it had"
            );
            assert_eq!(
                client::get_state(&b, entitlement::ACCESS_EXPIRES).as_deref(),
                Some("1800000000")
            );
        }
    }
}
