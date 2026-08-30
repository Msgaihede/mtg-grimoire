//! The pairing state machine, and the commands the webview presses.
//!
//! **The pending offer lives in memory and never in SQLite**, which is what makes the token
//! one-time in fact rather than by convention: an offer that survived a restart would be an
//! invite a reader printed last month still being accepted today. It has to outlive a page
//! reload, because a reader may open Settings twice, and `AppState` is exactly that lifetime.
//!
//! Every blob that crosses a screen is base32 through [`super::invite`]'s alphabet — the same
//! reason the invite is: a reader may have to type it.
//!
//! **Both blobs carry one field in the clear ahead of the sealed remainder, and that is not a
//! leak.** Each side has to know *which key* to derive before it can open anything, and the
//! value it needs is the one the other side is identified by — B's public key on the way back,
//! A's device id on the way out. Both are public by construction, and the seal is what proves
//! the clear prefix belongs to the same handshake: the joiner's key is repeated inside the
//! sealed bytes and compared, and the initiator's id is the AEAD's associated data.

use crate::sync_engine::entitlement;
use crate::sync_pair::crypto;
use crate::sync_pair::identity;
use crate::sync_pair::invite::{Invite, QrMatrix};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Arc;

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
    /// Filled once the other side's public key has arrived.
    peer_public: Option<[u8; 32]>,
    peer_device_id: Option<String>,
    peer_name: Option<String>,
    pair_key: Option<[u8; 32]>,
    /// Set by [`confirm`] on the initiator, so a spent offer cannot serve a second joiner.
    spent: bool,
}

/// What the reader is shown when a pairing starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub code: String,
    pub qr: QrMatrix,
}

/// What each side gets once it knows the other's key: six digits to compare, and a blob to
/// carry back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub sas: String,
    /// Empty on the initiator's side — A has nothing further to hand B until Confirm.
    pub response: String,
}

/// The wrapped group key, for the reader to carry to the joining device.
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

    let inv = Invite {
        group_id,
        public_key: me.keypair.public,
        token,
    };
    let code = inv.encode();
    let qr = crate::sync_pair::invite::qr_matrix(&code).map_err(err)?;

    *pending = Some(Pending {
        initiator: true,
        group_id,
        token,
        peer_public: None,
        peer_device_id: None,
        peer_name: None,
        pair_key: None,
        spent: false,
    });
    Ok(Offer { code, qr })
}

/// The joining device reads the code, does the ECDH, and produces both the six digits and the
/// blob the initiator needs.
pub fn accept(
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

    *pending = Some(Pending {
        initiator: false,
        group_id: inv.group_id,
        token: inv.token,
        peer_public: Some(inv.public_key),
        peer_device_id: None,
        peer_name: None,
        pair_key: Some(pair_key),
        spent: false,
    });
    Ok(Handshake {
        sas,
        response: blob_encode(&blob),
    })
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
        response: String::new(),
    })
}

/// What a device with no name of its own is filed as.
const DEFAULT_PEER_NAME: &str = "Paired device";

/// The access token a device carries out of a pairing: **a placeholder, already expired.**
///
/// Spec §6.2 puts the *refresh secret* in the sealed blob and nothing else, and that is right:
/// an `access` is a 24-hour bearer token the relay minted for the **other** device, so copying
/// one would hand the joiner a credential that dies the same afternoon and says the wrong
/// device made the request. [`entitlement::store_grant`] writes the two together — an access
/// token with no refresh secret reads as disconnected — so the field has to hold something, and
/// what makes this string harmless is the `0` expiry stored beside it:
/// [`entitlement::access_token`] compares that against its refresh margin, finds it long dead,
/// and trades the refresh secret for a token of the joiner's own before a single request goes
/// out. **This value never reaches the relay.**
const PAIRED_ACCESS: &str = "pairing";

/// The initiator confirms the digits matched: the group is created if needed, the joiner goes on
/// the roster, and the group key is sealed for it to carry.
pub fn confirm(conn: &Connection, pending: &mut Option<Pending>) -> Result<SealedKey, String> {
    let me = identity::ensure(conn).map_err(err)?;
    let p = pending.as_mut().ok_or(NOTHING_IN_FLIGHT)?;
    if p.spent {
        return Err(ALREADY_USED.to_owned());
    }
    let (Some(pair_key), Some(peer_public), Some(peer_id)) =
        (p.pair_key, p.peer_public, p.peer_device_id.clone())
    else {
        return Err("The other device has not answered yet.".to_owned());
    };

    let group = identity::create_group(conn, &me).map_err(err)?;
    identity::add_device(
        conn,
        &peer_id,
        &peer_public,
        p.peer_name.as_deref().unwrap_or(DEFAULT_PEER_NAME),
    )
    .map_err(err)?;

    // `<group_id>\0<epoch>\0<refresh>\0<32-byte key>` — the id and the epoch travel with the
    // key because a key with no epoch cannot be compared against a later rotation, and the
    // refresh secret travels with them so that **the joining device never opens a browser and
    // never sees Patreon** (spec §6.2). One membership, one group, every device the reader owns.
    //
    // **The key is still last, and the refresh secret goes before it rather than after it.** The
    // key is 32 raw bytes and may hold a zero of its own, so it can only ever be the *final*
    // field: [`complete`] splits on zero bytes and takes everything left over as the key. A
    // refresh secret appended after it would be swallowed by any group key containing a zero —
    // about one pairing in eight — and would pass every test whose fixture key happened to
    // contain none. It is safe as a **middle** field for the reason A's device id is safe as the
    // prefix one step down: the relay mints it as base64url, so it carries no zero byte at all.
    //
    // **Empty when this device holds no membership, and that is a pairing rather than a
    // refusal**: a reader may pair two devices and connect Patreon afterwards, in either order.
    let refresh = entitlement::refresh_secret(conn).unwrap_or_default();
    let mut plain = Vec::new();
    plain.extend_from_slice(group.group_id.as_bytes());
    plain.push(0);
    plain.extend_from_slice(group.epoch.to_string().as_bytes());
    plain.push(0);
    plain.extend_from_slice(refresh.as_bytes());
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

    p.spent = true;
    Ok(SealedKey {
        sealed_key: blob_encode(&blob),
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

    // `<group_id>\0<epoch>\0<refresh>\0<32-byte key>`, and **the key is read last because it
    // is the one field that may contain a zero byte of its own** — [`confirm`], which seals it,
    // carries the whole argument.
    let mut parts = plain.splitn(4, |b| *b == 0);
    let group_id = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
    let epoch: i64 = String::from_utf8_lossy(parts.next().unwrap_or_default())
        .parse()
        .map_err(|_| NOT_A_KEY)?;
    let refresh = String::from_utf8_lossy(parts.next().ok_or(NOT_A_KEY)?).into_owned();
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

    identity::join_group(conn, &group_id, epoch, &key, &me).map_err(err)?;
    identity::add_device(
        conn,
        &peer_id,
        &peer_public,
        p.peer_name.as_deref().unwrap_or(DEFAULT_PEER_NAME),
    )
    .map_err(err)?;

    // **The membership rides in behind the group, and an absent one takes nothing away.** A
    // blank field is an offering device that has not connected Patreon — which says nothing
    // whatever about this one, and this one may have connected it itself. Clearing a grant on
    // the strength of the *other* device not holding one would disconnect a reader for pairing.
    //
    // **No supporter status is written**, deliberately: what the relay last said about the
    // membership is the relay's own fact and this device has not asked it yet, so
    // `entitlement::supporter_state` reads `("dead", None)` here until the first `/token` call
    // answers one. Copying A's word for it would put a "supporting since" date on this panel
    // that nothing on this device was ever told. See [`PAIRED_ACCESS`] for the other half of
    // that argument — the access token is a placeholder that expired at the epoch, so the first
    // sync trades this secret for a real one before it sends anything.
    //
    // It is written **after** the group rather than before it: a failure here is a database that
    // is already failing, and what the reader pressed the button for — the two devices being in
    // one group — has landed by the time it can happen.
    if !refresh.trim().is_empty() {
        entitlement::store_grant(conn, PAIRED_ACCESS, &refresh, 0)?;
    }
    Ok(())
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
use crate::sync_engine::client;
use crate::sync_engine::commands;

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

/// Read an offer on the joining device. Answers the six digits and a blob to carry back.
#[tauri::command]
pub async fn sync_pairing_accept(
    state: tauri::State<'_, Arc<AppState>>,
    code: String,
) -> Result<Handshake, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| accept(conn, &mut pending, &code))
    })
    .await
    .map_err(|e| format!("could not read that pairing code: {e}"))?
}

/// Read the joiner's blob on the offering device. Answers the same six digits.
#[tauri::command]
pub async fn sync_pairing_respond(
    state: tauri::State<'_, Arc<AppState>>,
    response: String,
) -> Result<Handshake, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| respond(conn, &mut pending, &response))
    })
    .await
    .map_err(|e| format!("could not read that pairing response: {e}"))?
}

/// The reader says the digits matched. Answers the sealed group key.
#[tauri::command]
pub async fn sync_pairing_confirm(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SealedKey, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| confirm(conn, &mut pending))
    })
    .await
    .map_err(|e| format!("could not finish pairing: {e}"))?
}

/// The joining device unwraps the key and is in the group.
#[tauri::command]
pub async fn sync_pairing_complete(
    state: tauri::State<'_, Arc<AppState>>,
    sealed_key: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = sync::lock_plain(&state.pairing);
        sync::with_write(&state, |conn| complete(conn, &mut pending, &sealed_key))
    })
    .await
    .map_err(|e| format!("could not finish pairing: {e}"))?
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

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

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

    /// A whole pairing, two databases, no network. Both ends must end up holding the same
    /// group key, and the six digits both readers were shown must have matched.
    #[test]
    fn two_databases_pair_and_agree_on_the_key() {
        let a = db();
        let b = db();
        let mut a_pending = None;
        let mut b_pending = None;

        let offer = begin(&a, &mut a_pending).unwrap();
        let accepted = accept(&b, &mut b_pending, &offer.code).unwrap();
        let responded = respond(&a, &mut a_pending, &accepted.response).unwrap();

        assert_eq!(
            accepted.sas, responded.sas,
            "the two readers must be shown the same six digits"
        );

        let sealed = confirm(&a, &mut a_pending).unwrap();
        complete(&b, &mut b_pending, &sealed.sealed_key).unwrap();

        let ga = crate::sync_pair::identity::group(&a).unwrap().unwrap();
        let gb = crate::sync_pair::identity::group(&b).unwrap().unwrap();
        assert_eq!(ga.group_id, gb.group_id);
        assert_eq!(ga.group_key, gb.group_key);
        assert_eq!(ga.epoch, gb.epoch);
    }

    /// Each side ends up knowing about the other.
    #[test]
    fn both_rosters_name_both_devices() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        let sealed = confirm(&a, &mut pa).unwrap();
        complete(&b, &mut pb, &sealed.sealed_key).unwrap();

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
    #[test]
    fn the_joiner_is_filed_under_the_name_it_sent() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let me_b = crate::sync_pair::identity::ensure(&b).unwrap();
        crate::sync_pair::identity::rename_device(&b, &me_b.device_id, "Kitchen laptop").unwrap();

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        confirm(&a, &mut pa).unwrap();

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
    #[test]
    fn a_relay_in_the_middle_makes_the_two_codes_disagree() {
        let a = db();
        let m = db();
        let b = db();
        let (mut pa, mut pm_join, mut pm_offer, mut pb) = (None, None, None, None);

        // A offers. M accepts it, so A ends up computing digits against M's key.
        let a_offer = begin(&a, &mut pa).unwrap();
        let m_accepts_a = accept(&m, &mut pm_join, &a_offer.code).unwrap();
        let a_sees = respond(&a, &mut pa, &m_accepts_a.response).unwrap();

        // M makes its own offer to B, so B computes digits against M's key too.
        let m_offer = begin(&m, &mut pm_offer).unwrap();
        let b_sees = accept(&b, &mut pb, &m_offer.code).unwrap();

        assert_ne!(
            a_sees.sas, b_sees.sas,
            "if these matched, a relay could join the group and §7.5 step 3 would be theatre"
        );
    }

    /// The token is one-time. A second acceptance of the same offer must be refused.
    #[test]
    fn an_offer_cannot_be_accepted_twice() {
        let a = db();
        let b = db();
        let c = db();
        let (mut pa, mut pb, mut pc) = (None, None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        confirm(&a, &mut pa).unwrap();

        // The offer is spent; C arrives with the same code.
        let acc_c = accept(&c, &mut pc, &offer.code).unwrap();
        assert!(
            respond(&a, &mut pa, &acc_c.response).is_err(),
            "a spent offer must not accept a second joiner"
        );
        assert!(
            confirm(&a, &mut pa).is_err(),
            "and neither may it be confirmed a second time"
        );
        assert_eq!(
            crate::sync_pair::identity::roster(&a).unwrap().len(),
            2,
            "C must not have reached the roster"
        );
    }

    /// Confirming before the two sides have exchanged keys is a state that cannot produce a
    /// key, and it must say so rather than sealing to nothing.
    #[test]
    fn confirm_before_respond_is_refused() {
        let a = db();
        let mut pa = None;
        begin(&a, &mut pa).unwrap();
        assert!(confirm(&a, &mut pa).is_err());
        assert!(
            crate::sync_pair::identity::group(&a).unwrap().is_none(),
            "a refused confirm must not have minted a group"
        );
    }

    /// Nothing in flight is not a pairing, and every step says so rather than panicking.
    #[test]
    fn every_step_refuses_when_nothing_is_in_flight() {
        let a = db();
        let mut pa = None;
        assert!(respond(&a, &mut pa, "anything").is_err());
        assert!(confirm(&a, &mut pa).is_err());
        assert!(complete(&a, &mut pa, "anything").is_err());
    }

    /// The joining device cannot be asked to play the offering one's part.
    #[test]
    fn a_joiner_cannot_respond_and_an_offerer_cannot_complete() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        assert!(
            respond(&b, &mut pb, &acc.response).is_err(),
            "B is joining a group, not offering one"
        );
    }

    /// Cancelling throws the offer away, and the code that was on screen stops working.
    #[test]
    fn cancelling_makes_the_offer_unusable() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        cancel(&mut pa);
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        assert!(respond(&a, &mut pa, &acc.response).is_err());
    }

    /// A tampered sealed key is refused, and B stays unpaired rather than half-paired.
    #[test]
    fn a_tampered_sealed_key_leaves_b_unpaired() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        let sealed = confirm(&a, &mut pa).unwrap();

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
    #[test]
    fn a_tampered_response_never_reaches_the_roster() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();

        assert!(respond(&a, &mut pa, &bend(&acc.response)).is_err());
        assert!(confirm(&a, &mut pa).is_err(), "nothing was agreed");
        assert!(crate::sync_pair::identity::roster(&a).unwrap().is_empty());
    }

    /// A device already in a group cannot be walked into a second one.
    ///
    /// **The whole pairing succeeds cryptographically and is still refused**, which is the
    /// point: joining group two overwrites the key this device is syncing group one under, and
    /// nothing here can get that key back. A re-pair after a revocation carries the *same*
    /// group id and is allowed by the same check.
    #[test]
    fn joining_a_second_group_is_refused_and_the_first_key_survives() {
        let a = db();
        let b = db();
        let c = db();
        let (mut pa, mut pb, mut pc) = (None, None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        let sealed = confirm(&a, &mut pa).unwrap();
        complete(&b, &mut pb, &sealed.sealed_key).unwrap();
        let joined = crate::sync_pair::identity::group(&b).unwrap().unwrap();

        // C runs a perfectly good pairing at B, into a group of its own.
        let c_offer = begin(&c, &mut pc).unwrap();
        let acc_c = accept(&b, &mut pb, &c_offer.code).unwrap();
        respond(&c, &mut pc, &acc_c.response).unwrap();
        let sealed_c = confirm(&c, &mut pc).unwrap();

        assert!(complete(&b, &mut pb, &sealed_c.sealed_key).is_err());
        assert_eq!(
            crate::sync_pair::identity::group(&b).unwrap().unwrap(),
            joined,
            "B kept the key it was already syncing under"
        );
    }

    /// A device already in a group invites into *that* group, rather than minting a second one
    /// and quietly leaving the first.
    #[test]
    fn a_second_offer_invites_into_the_group_this_device_is_already_in() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        confirm(&a, &mut pa).unwrap();

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
    #[test]
    fn status_answers_the_panel_before_and_after_pairing() {
        let a = db();
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
        let mut pb = None;
        let offer = begin(&a, &mut pa).unwrap();
        let acc = accept(&b, &mut pb, &offer.code).unwrap();
        respond(&a, &mut pa, &acc.response).unwrap();
        let sealed = confirm(&a, &mut pa).unwrap();
        complete(&b, &mut pb, &sealed.sealed_key).unwrap();

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

    /// The offer carries a QR of the code, and it is the code's own picture.
    #[test]
    fn the_offer_carries_a_drawable_matrix_of_its_own_code() {
        let a = db();
        let mut pa = None;
        let offer = begin(&a, &mut pa).unwrap();
        assert_eq!(offer.qr.modules.len(), offer.qr.width * offer.qr.width);
        assert_eq!(
            offer.qr.modules,
            crate::sync_pair::invite::qr_matrix(&offer.code)
                .unwrap()
                .modules
        );
    }

    // -----------------------------------------------------------------------------------
    // The membership the pairing carries
    //
    // Spec §6.2: the refresh secret rides to the second device inside the sealed blob, so that
    // device never opens a browser and never sees Patreon.
    // -----------------------------------------------------------------------------------

    /// A whole pairing, up to the blob the reader carries to the joining device.
    fn pair_up(
        a: &Connection,
        pa: &mut Option<Pending>,
        b: &Connection,
        pb: &mut Option<Pending>,
    ) -> String {
        let offer = begin(a, pa).unwrap();
        let acc = accept(b, pb, &offer.code).unwrap();
        respond(a, pa, &acc.response).unwrap();
        confirm(a, pa).unwrap().sealed_key
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

    /// Now, off the same connection the grant was written through.
    fn unix_now(conn: &Connection) -> i64 {
        conn.query_row("SELECT unixepoch()", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn the_sealed_key_carries_the_refresh_secret_to_the_joiner() {
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);
        entitlement::store_grant(&a, "access-a", "refresh-a", 1_900_000_000).unwrap();

        let sealed = pair_up(&a, &mut pa, &b, &mut pb);
        complete(&b, &mut pb, &sealed).unwrap();

        assert_eq!(
            entitlement::refresh_secret(&b).as_deref(),
            Some("refresh-a")
        );
        // **A's own bearer token is not carried and must not be**: it is a 24-hour credential
        // the relay minted for A. What B stores in its place expired at the epoch, which is
        // what makes `entitlement::access_token` trade the secret for a token of B's own
        // before the first request rather than sending a placeholder to the relay.
        let expires: i64 = client::get_state(&b, entitlement::ACCESS_EXPIRES)
            .expect("an expiry")
            .parse()
            .unwrap();
        assert!(
            expires < unix_now(&b),
            "the carried access token must already be dead, not {expires}"
        );
        assert_ne!(
            client::get_state(&b, entitlement::ACCESS_TOKEN).as_deref(),
            Some("access-a")
        );
        // **And no supporter status.** What the relay last said about the membership is the
        // relay's fact; B has not asked it yet, so the panel says nothing about a date nobody
        // on this device was ever told.
        assert_eq!(client::get_state(&b, entitlement::SUPPORTER_STATUS), None);
    }

    #[test]
    fn a_group_key_containing_a_zero_byte_still_opens() {
        // **The field-order trap, made unmissable.** `complete` splits the sealed plaintext on
        // zero bytes, so the 32-byte group key is only safe as the LAST field. A fixture key of
        // random bytes holds a zero about one time in eight, so a refresh secret appended after
        // the key would pass on most runs and lose the key on the rest — one pairing in eight,
        // in the field, with nothing on either screen to say why. This key is nothing but
        // zeroes, and the secret beside it is what makes the remainder the wrong length.
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);
        in_a_group_with_key(&a, [0u8; 32]);
        entitlement::store_grant(&a, "access-a", "refresh-a", 1_900_000_000).unwrap();

        let sealed = pair_up(&a, &mut pa, &b, &mut pb);
        complete(&b, &mut pb, &sealed).unwrap();

        assert_eq!(
            identity::group(&b).unwrap().expect("B joined").group_key,
            [0u8; 32]
        );
        assert_eq!(
            entitlement::refresh_secret(&b).as_deref(),
            Some("refresh-a")
        );
    }

    #[test]
    fn a_host_with_no_grant_still_pairs() {
        // Pairing must not require a membership: a reader can pair two devices and connect
        // Patreon afterwards, in either order.
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);

        let sealed = pair_up(&a, &mut pa, &b, &mut pb);
        complete(&b, &mut pb, &sealed).unwrap();

        assert_eq!(entitlement::refresh_secret(&b), None);
        assert!(
            identity::group(&b).unwrap().is_some(),
            "the pairing itself happened; only the membership was absent"
        );
    }

    #[test]
    fn an_empty_refresh_does_not_take_the_joiners_own_membership_away() {
        // A device that connected Patreon itself, pairing with one that never did. The blank
        // field says nothing about *this* device, and clearing the grant on the strength of it
        // would disconnect a reader for pairing.
        let a = db();
        let b = db();
        let (mut pa, mut pb) = (None, None);
        entitlement::store_grant(&b, "access-b", "refresh-b", 1_900_000_000).unwrap();

        let sealed = pair_up(&a, &mut pa, &b, &mut pb);
        complete(&b, &mut pb, &sealed).unwrap();

        assert_eq!(
            entitlement::refresh_secret(&b).as_deref(),
            Some("refresh-b")
        );
        assert_eq!(
            client::get_state(&b, entitlement::ACCESS_TOKEN).as_deref(),
            Some("access-b"),
            "and its own access token still has the life it had"
        );
        assert_eq!(
            client::get_state(&b, entitlement::ACCESS_EXPIRES).as_deref(),
            Some("1900000000")
        );
    }
}
