//! **Integrations — a service that joins a reader's sync group as a restricted device** (the
//! Discord spec, issue #1096). The bot is paired like any device, holds the group key and reads
//! everything, and may add cards and do nothing else: an `add` member of the group's signed
//! roster document (PR 4, §14 — PR 3 paired it `read`).
//!
//! This module is the engine's half of *Settings → Integrations*: [`gate`], the question asked
//! before any pairing starts (§13.5), and [`add`], what an `add` member writes and what every
//! device takes from one. The pairing itself is `sync_pair::pairing`'s —
//! [`begin_integration`](crate::sync_pair::pairing::begin_integration) and
//! [`confirm_pinned`](crate::sync_pair::pairing::confirm_pinned) — and the network calls to the
//! integration's own service are the desktop host's (`apps/desktop/src-tauri/src/discord/`).
//!
//! **Why a gate at all.** Pairing a restricted device turns the group's rosters to signed mode for
//! good (`sync_pair::roster`'s latch). A member that cannot verify a signed document — no signing
//! key on file, or a build below [`identity::SIG_PROTO`] 2 — would go on accepting envelopes and
//! rotations under the group key alone, which the bot holds: exactly the forgery the signatures
//! exist to stop. So every member must be ready *before* the bot arrives, and the reader is told
//! which one is not. **And since the bot adds, below [`identity::ADD_PROTO`] 3** a member would
//! refuse every card the reader adds from Discord — safe, but the group would diverge — so the
//! gate names that member too.

use crate::sync_engine::commands;
use crate::sync_pair::identity;
use crate::sync_pair::roster;
use rusqlite::Connection;

pub mod add;

/// What [`gate`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Nothing stands in the way: an integration may be paired now.
    Ready,
    /// One plain sentence saying why not — the first reason that applies, in §13.5's order.
    Refused(String),
}

impl Gate {
    /// `None` for [`Gate::Ready`], the sentence otherwise — `DiscordStatus.gate`'s shape.
    pub fn refusal(self) -> Option<String> {
        match self {
            Gate::Ready => None,
            Gate::Refused(why) => Some(why),
        }
    }
}

/// This device is in no sync group, so there is nothing for an integration to join.
pub const NO_GROUP: &str = "Discord joins your devices' sync group, and this device is not in \
     one yet. Set up sync first.";

/// No membership is connected anywhere in this group — the integration is a supporter's, as
/// sync is.
pub const NOT_ENTITLED: &str = "Discord is for supporters, and no membership is connected to \
     this group. Connect Patreon in Settings first.";

/// The relay's last `/keys` answer did not say `sig: 1` — an older relay, which keeps no roster
/// documents and would let a key holder rotate the group unsigned.
pub const RELAY_TOO_OLD: &str = "The sync service has not said it can check signed device lists \
     yet. Sync, then try again.";

/// No roster document accepted here yet, or none that lists this device with its keys — what
/// the group's first signed document must follow, and what tells this device every member's
/// keys and level.
pub const NO_ROSTER: &str = "Your devices have not agreed on a list of who is in your group yet. \
     Sync each of them, then try again.";

/// Five devices already — the bot would be the sixth.
pub const GROUP_FULL: &str = "Your group already has five devices, and Discord would be a sixth. \
     Remove one from the list of devices first.";

/// A member that cannot check a signed roster: no signing key on file, or below
/// [`identity::SIG_PROTO`]. **The spec's own sentence** (§7), with the device named.
pub fn update_or_remove(name: &str) -> String {
    format!(
        "Update or remove \"{name}\" first - it runs a version of MTG Grimoire that cannot check \
         who is in your group."
    )
}

/// A member that verifies rosters but is below [`identity::ADD_PROTO`]: it would refuse every
/// card Discord adds. [`update_or_remove`]'s shape, with the device named.
pub fn update_or_remove_for_adds(name: &str) -> String {
    format!(
        "Update or remove \"{name}\" first - it runs a version of MTG Grimoire that cannot take \
         cards added from Discord."
    )
}

/// A restricted device is in the group already — the integration's own, from a link that was
/// never switched off, or another one's.
pub fn already_restricted(name: &str) -> String {
    format!(
        "\"{name}\" is already in your group as a device that may only read it or add cards. \
         Remove it first."
    )
}

/// **Whether an integration may be paired into this device's group now** — §13.5, in its order:
///
/// 1. in a group at all;
/// 2. a membership connected to it (`sync_engine::commands::entitled`, supporter-only);
/// 3. the relay has advertised `sig: 1` on its last `/keys` answer;
/// 4. a roster document accepted here, naming this device with its signing key at this level;
/// 5. **every member** — on that document and on this device's own roster — with a signing key
///    and at [`identity::SIG_PROTO`] or above, the first that is not named; then every member at
///    [`identity::ADD_PROTO`] or above, the first that is not named
///    ([`update_or_remove_for_adds`]) — the bot is paired as `add`;
/// 6. fewer than five devices;
/// 7. no restricted device present — on the roster, on the document, or once restricted and
///    still listed.
///
/// A database that cannot be read is a refusal too, never a `Ready`: the gate is the one thing
/// between a reader's press and a latch that cannot be undone.
pub fn gate(conn: &Connection) -> Gate {
    match ask(conn) {
        Ok(None) => Gate::Ready,
        Ok(Some(why)) => Gate::Refused(why),
        Err(_) => Gate::Refused(UNREADABLE.to_owned()),
    }
}

/// The database said no to the gate's own reads.
pub const UNREADABLE: &str =
    "This device's sync group could not be read, so Discord cannot be added. Try again.";

fn ask(conn: &Connection) -> rusqlite::Result<Option<String>> {
    if identity::group(conn)?.is_none() {
        return Ok(Some(NO_GROUP.to_owned()));
    }
    if !commands::entitled(conn) {
        return Ok(Some(NOT_ENTITLED.to_owned()));
    }
    if !roster::relay_keeps_rosters(conn) {
        return Ok(Some(RELAY_TOO_OLD.to_owned()));
    }
    let Some((_, document)) = roster::last(conn)? else {
        return Ok(Some(NO_ROSTER.to_owned()));
    };
    let Some((me, _)) = identity::public_identity(conn)? else {
        return Ok(Some(NO_GROUP.to_owned()));
    };
    // This device's own entry is what every sibling verifies the first signed document against:
    // its signer must be a full member of the document they last accepted, with its key on it.
    let listed = document
        .member(&me)
        .is_some_and(|m| m.is_full() && m.ed25519.is_some() && m.proto >= identity::SIG_PROTO);
    if !listed {
        return Ok(Some(NO_ROSTER.to_owned()));
    }

    let rows: Vec<identity::Device> = identity::roster(conn)?
        .into_iter()
        .filter(|d| d.revoked_at.is_none())
        .collect();
    let name_of = |device: &str| {
        rows.iter().find(|d| d.device_id == device).map_or_else(
            || crate::sync_pair::pairing::DEFAULT_PEER_NAME.to_owned(),
            |d| d.name.clone(),
        )
    };

    // 5 — the document's members first, in its order, then the roster's.
    for m in &document.members {
        if m.device != me && (m.ed25519.is_none() || m.proto < identity::SIG_PROTO) {
            return Ok(Some(update_or_remove(&name_of(&m.device))));
        }
    }
    for d in &rows {
        if d.device_id != me
            && (d.sign_public.is_none() || d.proto.unwrap_or(0) < identity::SIG_PROTO)
        {
            return Ok(Some(update_or_remove(&d.name)));
        }
    }
    // 5b — every member understands the `add` rules, in the same order.
    for m in &document.members {
        if m.device != me && m.proto < identity::ADD_PROTO {
            return Ok(Some(update_or_remove_for_adds(&name_of(&m.device))));
        }
    }
    for d in &rows {
        if d.device_id != me && d.proto.unwrap_or(0) < identity::ADD_PROTO {
            return Ok(Some(update_or_remove_for_adds(&d.name)));
        }
    }

    // 6
    if rows.len() >= identity::MAX_GROUP_DEVICES {
        return Ok(Some(GROUP_FULL.to_owned()));
    }

    // 7
    let ever = roster::restricted_ever(conn)?;
    if let Some(d) = rows.iter().find(|d| {
        d.capability.as_deref().is_some_and(|c| c != roster::FULL) || ever.contains(&d.device_id)
    }) {
        return Ok(Some(already_restricted(&d.name)));
    }
    if let Some(m) = document.members.iter().find(|m| !m.is_full()) {
        return Ok(Some(already_restricted(&name_of(&m.device))));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    // The integration's engine half against a small relay of its own: the gate's every refusal, the
    // pinned pairing (§13.4) end to end — a desk and a phone paired by six digits, then a bot paired
    // by pins — and the bot's removal.
    //
    // **The relay here keeps state**, unlike the per-route mocks of `sync_pair::pairing`'s and
    // `sync_engine::client`'s suites: the rendezvous' four slots (first writer wins), the manifest and
    // the roster chain `/rotate` writes and `/keys` answers (`prev` checked, `409 roster_conflict`),
    // and a pull that answers whatever envelopes a test put there. That is what lets one test follow
    // a document from the device that signs it to the two that verify it.

    use super::*;
    use crate::sync_engine::client::{self, KeyOutcome};
    use crate::sync_engine::{capture, entitlement, wire};
    use crate::sync_pair::pairing::{self, Pinned};
    use crate::sync_pair::roster::{Member, Mode, Roster};
    use httpmock::prelude::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// A database as an open leaves one: at head, capture installed.
    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        capture::install(&conn).unwrap();
        conn
    }

    fn now() -> i64 {
        crate::platform::clock::now_ms()
    }

    /// Twelve hours of grant, absolutely — `client/tests.rs`'s `grant` and its reasoning.
    fn grant(conn: &Connection) {
        let expires: i64 = conn
            .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
            .unwrap()
            + 12 * 60 * 60;
        entitlement::store_grant(conn, "access-1", "refresh-1", expires).unwrap();
    }

    fn rows_for(conn: &Connection, operation: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT message FROM error_log WHERE operation = ?1")
            .unwrap();
        stmt.query_map([operation], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn state_of(conn: &Connection, key: &str) -> Option<String> {
        client::get_state(conn, key)
    }

    fn row(conn: &Connection, device: &str) -> Option<identity::Device> {
        identity::roster(conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == device)
    }

    // ---------------------------------------------------------------------------------------
    // The relay
    // ---------------------------------------------------------------------------------------

    #[derive(Default)]
    struct Held {
        slots: HashMap<(String, String), String>,
        epoch: i64,
        manifest: serde_json::Map<String, serde_json::Value>,
        /// `(roster, field, value)`, oldest first.
        rosters: Vec<(String, String, String)>,
        rotations: Vec<serde_json::Value>,
        envelopes: Vec<serde_json::Value>,
        /// Answer every push `429 restricted_quota`, as the relay does a restricted device past
        /// its day's allowance.
        quota: bool,
        /// How many pushes were made, refused ones included.
        pushes: usize,
    }

    struct Relay {
        server: MockServer,
        held: Arc<Mutex<Held>>,
    }

    fn json(status: u16, body: serde_json::Value) -> HttpMockResponse {
        HttpMockResponse::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(body.to_string())
            .build()
    }

    fn query(req: &HttpMockRequest, name: &str) -> Option<String> {
        req.uri().query().and_then(|q| {
            q.split('&').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                (k == name).then(|| v.to_owned())
            })
        })
    }

    /// `/p/{rv}/{slot}` as its two parts — only ever called on a path the route already matched.
    fn rv_slot(req: &HttpMockRequest) -> (String, String) {
        let uri = req.uri();
        let mut parts = uri.path().trim_start_matches('/').split('/').skip(1);
        (
            parts.next().unwrap().to_owned(),
            parts.next().unwrap().to_owned(),
        )
    }

    impl Relay {
        async fn start() -> Self {
            let server = MockServer::start_async().await;
            let held: Arc<Mutex<Held>> = Arc::default();

            let slots = r"^/p/[0-9a-f]{32}/(offer|join|offersig|joinsig)$";
            let h = held.clone();
            server.mock(|when, then| {
                when.method(GET).path_matches(slots);
                then.respond_with(move |req: &HttpMockRequest| {
                    let key = rv_slot(req);
                    match h.lock().unwrap().slots.get(&key) {
                        Some(blob) => json(200, serde_json::json!({ "blob": blob })),
                        None => HttpMockResponse::builder().status(404).build(),
                    }
                });
            });
            let h = held.clone();
            server.mock(|when, then| {
                when.method(POST).path_matches(slots);
                then.respond_with(move |req: &HttpMockRequest| {
                    let key = rv_slot(req);
                    let body: serde_json::Value =
                        serde_json::from_str(&req.body_string()).unwrap_or_default();
                    let mut held = h.lock().unwrap();
                    if held.slots.contains_key(&key) {
                        return HttpMockResponse::builder().status(409).build();
                    }
                    held.slots
                        .insert(key, body["blob"].as_str().unwrap_or_default().to_owned());
                    HttpMockResponse::builder().status(204).build()
                });
            });

            let h = held.clone();
            server.mock(|when, then| {
                when.method(GET).path_matches(r"^/g/[0-9a-f]+/keys$");
                then.respond_with(move |req: &HttpMockRequest| {
                let held = h.lock().unwrap();
                let device = query(req, "device").unwrap_or_default();
                if query(req, "epoch").is_some_and(|e| e != held.epoch.to_string()) {
                    return json(404, serde_json::json!({ "code": "no_such_epoch" }));
                }
                let walk: Vec<serde_json::Value> = held
                    .rosters
                    .iter()
                    .map(|(text, field, value)| {
                        let mut v = serde_json::json!({ "roster": text });
                        v[field.as_str()] = serde_json::json!(value);
                        v
                    })
                    .collect();
                let mut page = serde_json::json!({
                    "epoch": held.epoch,
                    "blob": held.manifest.get(&device).cloned().unwrap_or(serde_json::Value::Null),
                    "devices": held.manifest.keys().collect::<Vec<_>>(),
                    "roster": serde_json::Value::Null,
                    "rosterMac": serde_json::Value::Null,
                    "rosterSig": serde_json::Value::Null,
                    "rosters": walk,
                    "sig": 1,
                });
                if let Some((text, field, value)) = held.rosters.last() {
                    page["roster"] = serde_json::json!(text);
                    page[field.as_str()] = serde_json::json!(value);
                }
                json(200, page)
            });
            });

            let h = held.clone();
            server.mock(|when, then| {
                when.method(POST).path_matches(r"^/g/[0-9a-f]+/rotate$");
                then.respond_with(move |req: &HttpMockRequest| {
                    let body: serde_json::Value = serde_json::from_str(&req.body_string()).unwrap();
                    let mut held = h.lock().unwrap();
                    let epoch = body["epoch"].as_i64().unwrap();
                    if epoch <= held.epoch {
                        return json(409, serde_json::json!({ "code": "stale_epoch" }));
                    }
                    if let Some(text) = body["roster"].as_str() {
                        let rd = roster::parse(text).unwrap();
                        let newest = held.rosters.last().map(|(t, _, _)| roster::hash(t));
                        if rd.prev != newest {
                            return json(409, serde_json::json!({ "code": "roster_conflict" }));
                        }
                        let latched = held
                            .rosters
                            .iter()
                            .any(|(t, _, _)| roster::parse(t).unwrap().mode == Mode::Signed);
                        let (field, value) =
                            match (body["rosterSig"].as_str(), body["rosterMac"].as_str()) {
                                (Some(sig), _) => ("rosterSig", sig),
                                (None, Some(mac)) if !latched => ("rosterMac", mac),
                                _ => {
                                    return json(
                                        403,
                                        serde_json::json!({ "code": "unsigned_rotation" }),
                                    )
                                }
                            };
                        held.rosters
                            .push((text.to_owned(), field.to_owned(), value.to_owned()));
                    }
                    held.epoch = epoch;
                    held.manifest = body["keys"].as_object().cloned().unwrap_or_default();
                    held.rotations.push(body);
                    json(200, serde_json::json!({ "epoch": epoch }))
                });
            });

            // Amendments are an older relay's 404 here: every document in these tests is a rotation's.
            server.mock(|when, then| {
                when.method(POST).path_matches(r"^/g/[0-9a-f]+/roster$");
                then.status(404);
            });
            let h = held.clone();
            server.mock(|when, then| {
                when.method(GET).path_matches(r"^/g/[0-9a-f]+/pull$");
                then.respond_with(move |_: &HttpMockRequest| {
                    let held = h.lock().unwrap();
                    json(
                        200,
                        serde_json::json!({
                            "envelopes": held.envelopes,
                            "cursor": held.envelopes.len() as i64 + 1,
                        }),
                    )
                });
            });
            server.mock(|when, then| {
                when.method(POST).path_matches(r"^/g/[0-9a-f]+/ack$");
                then.status(204);
            });
            let h = held.clone();
            server.mock(|when, then| {
                when.method(POST).path_matches(r"^/g/[0-9a-f]+/push$");
                then.respond_with(move |req: &HttpMockRequest| {
                    let mut held = h.lock().unwrap();
                    held.pushes += 1;
                    if held.quota {
                        return json(429, serde_json::json!({ "code": "restricted_quota" }));
                    }
                    let envelope: serde_json::Value =
                        serde_json::from_str(&req.body_string()).unwrap();
                    held.envelopes.push(envelope);
                    let cursor = held.envelopes.len() as i64;
                    json(200, serde_json::json!({ "cursor": cursor }))
                });
            });

            Relay { server, held }
        }

        fn point(&self, conn: &Connection) {
            client::set_state(conn, client::RELAY_URL, &self.server.base_url()).unwrap();
        }

        fn last_rotation(&self) -> serde_json::Value {
            self.held.lock().unwrap().rotations.last().cloned().unwrap()
        }

        fn rotations(&self) -> usize {
            self.held.lock().unwrap().rotations.len()
        }

        fn slot(&self, slot: &str) -> usize {
            self.held
                .lock()
                .unwrap()
                .slots
                .keys()
                .filter(|(_, s)| s == slot)
                .count()
        }
    }

    /// A desk and a phone, paired by six digits through `relay`: the desk founded the group, its
    /// join's rotation carried an open document naming both with their keys, and the phone adopted
    /// it. The desk holds a grant, so the gate passes it and it may remove a device.
    async fn desk_and_phone(relay: &Relay) -> (Connection, Connection) {
        let desk = db();
        let phone = db();
        relay.point(&desk);
        relay.point(&phone);
        let (mut pd, mut pp) = (None, None);
        let offer = pairing::begin(&desk, &mut pd).unwrap();
        pairing::accept(&phone, &mut pp, &offer.code).await.unwrap();
        assert_eq!(
            pairing::poll(&desk, &mut pd, now()).await.unwrap().stage,
            "compare"
        );
        pairing::confirm(&desk, &mut pd).await.unwrap();
        assert_eq!(
            pairing::poll(&phone, &mut pp, now()).await.unwrap().stage,
            "complete"
        );
        assert_eq!(
            client::check_keys(&phone).await.unwrap().outcome,
            KeyOutcome::Adopted
        );
        grant(&desk);
        assert_eq!(roster::mode(&desk), Mode::Open);
        assert!(roster::last(&phone).unwrap().is_some());
        (desk, phone)
    }

    /// The bot's database, having read the integration's invite: `pairing::accept`, which posts
    /// `joinsig` and `join` — what the Durable Object does inside `POST /link/enroll` — and the three
    /// values it answers.
    async fn bot_enrolls(
        relay: &Relay,
        code: &str,
    ) -> (
        Connection,
        Option<pairing::Pending>,
        Pinned,
        crypto::SigningKeypair,
    ) {
        bot_enrolls_as(relay, code, roster::ADD).await
    }

    /// [`bot_enrolls`], pinned with `capability`.
    async fn bot_enrolls_as(
        relay: &Relay,
        code: &str,
        capability: &str,
    ) -> (
        Connection,
        Option<pairing::Pending>,
        Pinned,
        crypto::SigningKeypair,
    ) {
        let bot = db();
        relay.point(&bot);
        let mut pending = None;
        pairing::accept(&bot, &mut pending, code).await.unwrap();
        let me = identity::ensure(&bot).unwrap();
        let pinned = Pinned::from_wire(
            &me.device_id,
            &roster::key_text(&me.keypair.public),
            &roster::key_text(&me.signing.public),
            capability,
        )
        .unwrap();
        (bot, pending, pinned, me.signing)
    }

    use crate::sync_pair::crypto;

    // ---------------------------------------------------------------------------------------
    // The pinned pairing
    // ---------------------------------------------------------------------------------------

    /// ⚠ **The happy path, §13.4 end to end.** The gate passes; the desk offers, the bot answers,
    /// the desk confirms on the pins with no six digits — and:
    ///
    /// * `offersig` says `signed`, so the bot latches before it joins;
    /// * the bot is on the desk's roster as `add`, with both its keys and its level, under
    ///   *Discord*, and in `restricted_ever`;
    /// * the desk is latched (`roster_mode = signed`, `signed_since` = the join's epoch);
    /// * the join's rotation carries the group's **first signed document** — signed by the desk,
    ///   chained to the open one, every member with keys and level, the bot `cap: "add"`;
    /// * the bot completes, verifies that document against the desk's key alone and adopts the
    ///   epoch; the phone verifies it against the open document it last accepted, follows the latch,
    ///   learns the bot as `add` — **and refuses what the bot's capture would push**, which is off
    ///   the allow-list.
    #[tokio::test]
    async fn a_pinned_pairing_files_the_bot_as_an_add_member_and_enters_signed_mode() {
        let relay = Relay::start().await;
        let (desk, phone) = desk_and_phone(&relay).await;
        assert_eq!(gate(&desk), Gate::Ready);
        let before = identity::group(&desk).unwrap().unwrap();

        let mut pending = None;
        let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
        let (bot, mut bot_pending, pinned, bot_sign) = bot_enrolls(&relay, &offer.code).await;
        assert_eq!(
            pairing::poll(&desk, &mut pending, now())
                .await
                .unwrap()
                .stage,
            "compare"
        );
        let joined = pairing::confirm_pinned(&desk, &mut pending, pinned.clone())
            .await
            .expect("the pins match");

        let epoch = before.epoch + 1;
        assert_eq!(joined.device_id, pinned.device_id);
        assert_eq!(joined.signed_since, epoch);
        assert!(joined.published, "the signed join stayed a debt");
        assert!(!identity::roster_is_dirty(&desk).unwrap());

        // The desk: the bot filed as an `add` member, the latch, the restriction remembered.
        let filed = row(&desk, &pinned.device_id).expect("the bot is on the roster");
        assert_eq!(filed.capability.as_deref(), Some(roster::ADD));
        assert_eq!(filed.public_key, pinned.x25519);
        assert_eq!(filed.sign_public, Some(pinned.ed25519));
        assert_eq!(filed.proto, Some(identity::PROTO));
        assert_eq!(filed.name, pairing::INTEGRATION_DEVICE_NAME);
        assert_eq!(roster::mode(&desk), Mode::Signed);
        assert_eq!(
            state_of(&desk, roster::SIGNED_SINCE),
            Some(epoch.to_string())
        );
        assert!(roster::restricted_ever(&desk)
            .unwrap()
            .contains(&pinned.device_id));
        assert_eq!(identity::group(&desk).unwrap().unwrap().epoch, epoch);

        // The rotation: the first signed document, by the desk, chained to the open one.
        let body = relay.last_rotation();
        assert!(body["rosterMac"].is_null(), "{body}");
        let text = body["roster"]
            .as_str()
            .expect("the join carried a document");
        let rd = roster::parse(text).unwrap();
        let desk_id = identity::ensure(&desk).unwrap().device_id;
        let desk_sign = identity::signing_key(&desk).unwrap().unwrap();
        assert_eq!(rd.mode, Mode::Signed);
        assert_eq!((rd.epoch, rd.step), (epoch, 0));
        assert_eq!(rd.signer, desk_id);
        assert!(roster::sig_ok(
            &desk_sign.public,
            text,
            body["rosterSig"].as_str().unwrap()
        ));
        let (open_text, _) = roster::last(&phone).unwrap().unwrap();
        assert_eq!(rd.prev, Some(roster::hash(&open_text)));
        assert_eq!(rd.members.len(), 3);
        for m in &rd.members {
            assert!(m.ed25519.is_some(), "{m:?}");
            assert_eq!(m.proto, identity::PROTO, "{m:?}");
            let expected = if m.device == pinned.device_id {
                roster::ADD
            } else {
                roster::FULL
            };
            assert_eq!(m.cap, expected, "{m:?}");
        }
        assert!(body["keys"]
            .as_object()
            .unwrap()
            .contains_key(&pinned.device_id));

        // The bot completes, latched by `offersig`, and adopts the signed epoch on the desk's key.
        assert_eq!(
            pairing::poll(&bot, &mut bot_pending, now())
                .await
                .unwrap()
                .stage,
            "complete"
        );
        assert_eq!(roster::mode(&bot), Mode::Signed);
        assert_eq!(
            client::check_keys(&bot).await.unwrap().outcome,
            KeyOutcome::Adopted
        );
        assert_eq!(identity::group(&bot).unwrap().unwrap().epoch, epoch);
        assert!(
            roster::self_restricted(&bot).unwrap(),
            "the bot did not learn it is restricted"
        );
        assert_eq!(
            roster::self_capability(&bot).unwrap().as_deref(),
            Some(roster::ADD)
        );

        // The phone follows the latch on the desk's signature, and learns the bot as `add`.
        assert_eq!(
            client::check_keys(&phone).await.unwrap().outcome,
            KeyOutcome::Adopted
        );
        assert_eq!(roster::mode(&phone), Mode::Signed);
        assert_eq!(roster::last(&phone).unwrap().unwrap().0, text);
        let learnt = row(&phone, &pinned.device_id).expect("the phone learnt the bot");
        assert_eq!(learnt.capability.as_deref(), Some(roster::ADD));
        assert_eq!(learnt.sign_public, Some(pinned.ed25519));

        // …and refuses what the bot's own capture would push: a whole row, off the allow-list.
        capture::install(&bot).unwrap();
        bot.execute(
            "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('from-the-bot','lea','1','en','nonfoil','NM',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        let ops: Vec<_> = {
            let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
            let mut stmt = bot.prepare(&sql).unwrap();
            let ops = stmt
                .query_map([], capture::op_from_row)
                .unwrap()
                .map(|r| r.unwrap().1)
                .collect();
            ops
        };
        assert!(!ops.is_empty());
        let group = identity::group(&bot).unwrap().unwrap();
        let envelope = wire::seal_batch(&group, &pinned.device_id, &bot_sign.secret, &ops).unwrap();
        relay
            .held
            .lock()
            .unwrap()
            .envelopes
            .push(serde_json::to_value(&envelope).unwrap());
        let pulled = client::pull(&phone, &relay.server.base_url(), "access-1", Some(epoch))
            .await
            .unwrap();
        assert_eq!(pulled.report.applied, 0);
        let copies: i64 = phone
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE card_id = 'from-the-bot'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copies, 0, "the bot wrote to the phone");
        let rows = rows_for(&phone, "pull");
        assert!(
            rows.iter().any(|r| r.contains("may only add cards")),
            "{rows:?}"
        );
    }

    /// The desk, the phone and an `add` bot, paired by pins; the bot's capture switched off as its
    /// host switches it, and every device capturing as an opened database does.
    async fn with_an_add_bot(relay: &Relay) -> (Connection, Connection, Connection, i64) {
        let (desk, phone) = desk_and_phone(relay).await;
        let mut pending = None;
        let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
        let (bot, mut bot_pending, pinned, _) = bot_enrolls(relay, &offer.code).await;
        pairing::poll(&desk, &mut pending, now()).await.unwrap();
        let joined = pairing::confirm_pinned(&desk, &mut pending, pinned)
            .await
            .unwrap();
        pairing::poll(&bot, &mut bot_pending, now()).await.unwrap();
        for conn in [&bot, &phone] {
            assert_eq!(
                client::check_keys(conn).await.unwrap().outcome,
                KeyOutcome::Adopted
            );
        }
        add::capture_off(&bot).unwrap();
        bot.execute("DELETE FROM sync_ops", []).unwrap();
        grant(&bot);
        (desk, phone, bot, joined.signed_since)
    }

    fn copies_of(conn: &Connection, card: &str) -> (i64, i64) {
        conn.query_row(
            "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries
              WHERE card_id = ?1",
            [card],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn pending_ops(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn bolt(folder_uid: &str, quantity: i64) -> add::Add {
        add::Add::Collection(add::CollectionAdd {
            card_id: "bolt-2x2".into(),
            set_code: "2x2".into(),
            collector_number: "117".into(),
            lang: "en".into(),
            finish: "foil".into(),
            quantity,
            folder_uid: folder_uid.into(),
        })
    }

    /// ⚠ **An add, end to end** (the spec's §14): the desk makes *Added from Discord* (captured),
    /// the bot pulls it, emits an add past its own capture-off trigger and reads it back at once,
    /// pushes it as one signed envelope — and the phone and the desk each apply it, as an add.
    /// A second add of the same printing is an increment on the row's own uid.
    #[tokio::test]
    async fn a_bot_add_reaches_every_device() {
        let relay = Relay::start().await;
        let (desk, phone, bot, epoch) = with_an_add_bot(&relay).await;
        let base = relay.server.base_url();

        add::ensure_added_folder(&desk).unwrap();
        client::push(&desk, &base, "access-1").await.unwrap();
        client::pull(&bot, &base, "access-1", Some(epoch))
            .await
            .unwrap();
        let folder = add::default_folder(&bot)
            .unwrap()
            .expect("the bot learnt the folder");
        assert_eq!(add::default_folder(&desk).unwrap(), Some(folder.clone()));

        let uid = add::emit(&bot, &bolt(&folder, 2)).expect("the bot may add");
        assert_eq!(copies_of(&bot, "bolt-2x2"), (1, 2), "the bot's own read");
        assert_eq!(
            pending_ops(&bot),
            1,
            "one op in the bot's outbox, and no other"
        );
        assert_eq!(client::get_state(&bot, add::EMITTING), None);

        assert_eq!(client::push_restricted(&bot).await, Ok(1));
        assert_eq!(pending_ops(&bot), 0);
        assert_eq!(client::push_restricted(&bot).await, Ok(0));
        let pushes = relay.held.lock().unwrap().pushes;

        for conn in [&phone, &desk] {
            let pulled = client::pull(conn, &base, "access-1", Some(epoch))
                .await
                .unwrap();
            assert_eq!(copies_of(conn, "bolt-2x2"), (1, 2), "{pulled:?}");
            let filed: String = conn
                .query_row(
                    "SELECT f.sync_uid FROM collection_entries e
                       JOIN collection_folders f ON f.id = e.folder_id
                      WHERE e.sync_uid = ?1",
                    [&uid],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(filed, folder);
        }

        // A second add of the same printing names the row it already is.
        assert_eq!(
            add::emit(&bot, &bolt(&folder, 3)).as_deref(),
            Ok(uid.as_str())
        );
        let op: String = bot
            .query_row(
                "SELECT fields FROM sync_ops WHERE pushed_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(op, "{}", "an increment carries no field");
        assert_eq!(client::push_restricted(&bot).await, Ok(1));
        client::pull(&phone, &base, "access-1", Some(epoch))
            .await
            .unwrap();
        assert_eq!(copies_of(&phone, "bolt-2x2"), (1, 5));
        assert_eq!(
            relay.held.lock().unwrap().pushes,
            pushes + 1,
            "the empty push asked"
        );
    }

    /// ⚠ **The relay's day's allowance is an answer, not a failure**: `429 restricted_quota` keeps
    /// the outbox, says so in `restricted_quota_at`, and the next day's push sends it and clears it.
    #[tokio::test]
    async fn a_push_past_the_days_allowance_keeps_the_add() {
        let relay = Relay::start().await;
        let (desk, _phone, bot, epoch) = with_an_add_bot(&relay).await;
        let base = relay.server.base_url();
        add::ensure_added_folder(&desk).unwrap();
        client::push(&desk, &base, "access-1").await.unwrap();
        client::pull(&bot, &base, "access-1", Some(epoch))
            .await
            .unwrap();
        let folder = add::default_folder(&bot).unwrap().unwrap();
        add::emit(&bot, &bolt(&folder, 1)).unwrap();

        relay.held.lock().unwrap().quota = true;
        assert_eq!(client::push_restricted(&bot).await, Ok(0));
        assert_eq!(pending_ops(&bot), 1, "the add was dropped");
        assert!(client::get_state(&bot, client::RESTRICTED_QUOTA_AT).is_some());

        relay.held.lock().unwrap().quota = false;
        assert_eq!(client::push_restricted(&bot).await, Ok(1));
        assert_eq!(pending_ops(&bot), 0);
        assert_eq!(client::get_state(&bot, client::RESTRICTED_QUOTA_AT), None);
    }

    /// Only an `add` member pushes this way, and only an `add` member emits.
    #[tokio::test]
    async fn a_full_device_neither_emits_nor_pushes_restricted() {
        let relay = Relay::start().await;
        let (desk, _phone, _bot, _) = with_an_add_bot(&relay).await;
        assert_eq!(
            client::push_restricted(&desk).await,
            Err(client::NOT_AN_ADD_DEVICE.to_owned())
        );
        add::ensure_added_folder(&desk).unwrap();
        let folder = add::default_folder(&desk).unwrap().unwrap();
        assert_eq!(
            add::emit(&desk, &bolt(&folder, 1)),
            Err(add::NOT_AN_ADD_MEMBER.to_owned())
        );
    }

    /// An add into a folder the reader does not own is refused at the bot, before its outbox.
    #[tokio::test]
    async fn the_bot_refuses_an_add_into_a_folder_it_may_not_use() {
        let relay = Relay::start().await;
        let (_desk, _phone, bot, _) = with_an_add_bot(&relay).await;
        let removed: Option<String> = bot
            .query_row(
                "SELECT sync_uid FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for folder in [removed.unwrap_or_default(), "nowhere".to_owned()] {
            assert_eq!(
                add::emit(&bot, &bolt(&folder, 1)),
                Err(add::NOT_YOUR_FOLDER.to_owned())
            );
        }
        assert_eq!(pending_ops(&bot), 0);
        assert_eq!(
            add::emit(&bot, &bolt("x", 0)),
            Err(add::BAD_QUANTITY.to_owned())
        );
    }

    /// ⚠ **A `read` pin still pairs, and every device refuses everything it sends** — the word
    /// PR 3 paired with, which every build goes on understanding.
    #[tokio::test]
    async fn a_read_pin_still_pairs_and_still_writes_nothing() {
        let relay = Relay::start().await;
        let (desk, phone) = desk_and_phone(&relay).await;
        let mut pending = None;
        let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
        let (bot, mut bot_pending, pinned, _) =
            bot_enrolls_as(&relay, &offer.code, roster::READ).await;
        pairing::poll(&desk, &mut pending, now()).await.unwrap();
        pairing::confirm_pinned(&desk, &mut pending, pinned.clone())
            .await
            .unwrap();
        pairing::poll(&bot, &mut bot_pending, now()).await.unwrap();
        client::check_keys(&bot).await.unwrap();
        client::check_keys(&phone).await.unwrap();
        assert_eq!(
            row(&phone, &pinned.device_id)
                .unwrap()
                .capability
                .as_deref(),
            Some(roster::READ)
        );
        assert_eq!(
            client::push_restricted(&bot).await,
            Err(client::NOT_AN_ADD_DEVICE.to_owned())
        );
    }

    /// One way to bend a pin: given a stranger's X25519 key and another signing key.
    type Bend = fn(&mut Pinned, &[u8; 32], &[u8; 32]);

    /// ⚠ **A pin that does not match moves nothing** — the bot's id, its X25519 key or its Ed25519 key
    /// differing from what the service answered. Refused before `offersig` or `offer` is posted, with
    /// the roster, the mode and the epoch exactly as they were.
    #[tokio::test]
    async fn a_pin_mismatch_is_refused_before_anything_is_handed_over() {
        let other = crypto::signing_keypair();
        let stranger = crypto::keypair();
        let cases: [(&str, Bend); 3] = [
            ("device id", |p, _, _| p.device_id = "someone-else".into()),
            ("x25519", |p, x, _| p.x25519 = *x),
            ("ed25519", |p, _, e| p.ed25519 = *e),
        ];
        for (what, bend) in cases {
            let relay = Relay::start().await;
            let (desk, _phone) = desk_and_phone(&relay).await;
            let before = identity::group(&desk).unwrap().unwrap();
            let rotations = relay.rotations();
            let (offers, offersigs) = (relay.slot("offer"), relay.slot("offersig"));
            let mut pending = None;
            let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
            let (_bot, _, mut pinned, _) = bot_enrolls(&relay, &offer.code).await;
            pairing::poll(&desk, &mut pending, now()).await.unwrap();
            bend(&mut pinned, &stranger.public, &other.public);

            let refused = pairing::confirm_pinned(&desk, &mut pending, pinned)
                .await
                .expect_err(what);
            assert_eq!(refused, pairing::PIN_MISMATCH, "{what}");
            assert_eq!(
                relay.slot("offer"),
                offers,
                "{what}: the key was handed over"
            );
            assert_eq!(relay.slot("offersig"), offersigs, "{what}");
            assert_eq!(relay.rotations(), rotations, "{what}");
            assert_eq!(identity::group(&desk).unwrap().unwrap(), before, "{what}");
            assert_eq!(identity::roster(&desk).unwrap().len(), 2, "{what}");
            assert_eq!(roster::mode(&desk), Mode::Open, "{what}");
            assert!(roster::restricted_ever(&desk).unwrap().is_empty(), "{what}");
        }
    }

    /// An integration may only ever be pinned as restricted: a `full` pin is refused, whatever else
    /// matches — and so is a word this build does not know.
    #[tokio::test]
    async fn a_full_pin_is_refused() {
        let relay = Relay::start().await;
        let (desk, _phone) = desk_and_phone(&relay).await;
        let mut pending = None;
        let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
        let (_bot, _, pinned, _) = bot_enrolls(&relay, &offer.code).await;
        pairing::poll(&desk, &mut pending, now()).await.unwrap();
        let offers = relay.slot("offer");
        for word in [roster::FULL, "admin"] {
            let mut bent = pinned.clone();
            bent.capability = word.into();
            assert_eq!(
                pairing::confirm_pinned(&desk, &mut pending, bent)
                    .await
                    .unwrap_err(),
                pairing::PIN_NOT_RESTRICTED,
                "{word}"
            );
        }
        assert_eq!(relay.slot("offer"), offers);
    }

    /// ⚠ **The two confirms refuse each other's offers**: a reader's *Codes match* cannot finish an
    /// integration's pairing, and the pinned confirm cannot finish a reader's — which would let a
    /// device in without its six digits.
    #[tokio::test]
    async fn each_confirm_refuses_the_other_origins_offer() {
        let relay = Relay::start().await;
        let (desk, _phone) = desk_and_phone(&relay).await;

        let mut pending = None;
        let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
        let (_bot, _, pinned, _) = bot_enrolls(&relay, &offer.code).await;
        pairing::poll(&desk, &mut pending, now()).await.unwrap();
        assert_eq!(
            pairing::confirm(&desk, &mut pending).await.unwrap_err(),
            pairing::INTEGRATION_PAIRING
        );

        let mut ordinary = None;
        let offer = pairing::begin(&desk, &mut ordinary).unwrap();
        let (_other, _, pinned_too, _) = bot_enrolls(&relay, &offer.code).await;
        pairing::poll(&desk, &mut ordinary, now()).await.unwrap();
        assert_eq!(
            pairing::confirm_pinned(&desk, &mut ordinary, pinned_too)
                .await
                .unwrap_err(),
            pairing::NOT_AN_INTEGRATION_PAIRING
        );
        assert_eq!(
            relay.slot("offer"),
            1,
            "only the desk-and-phone pairing's offer"
        );
        assert_eq!(identity::roster(&desk).unwrap().len(), 2);
        drop(pinned);
    }

    /// An integration never founds a group: `begin_integration` on a device in none is refused.
    #[test]
    fn an_integration_offer_needs_a_group() {
        let conn = db();
        let mut pending = None;
        assert_eq!(
            pairing::begin_integration(&conn, &mut pending).unwrap_err(),
            identity::NOT_IN_A_GROUP
        );
        assert!(pending.is_none());
    }

    /// ⚠ **Removing the bot is a signed rotation, and the group stays signed.** The removal's document
    /// omits the bot, is signed by the desk and chained to the join's; the desk stays latched and the
    /// bot stays in `restricted_ever`; and the phone adopts the epoch on that document.
    #[tokio::test]
    async fn removing_the_bot_rotates_under_a_signed_document_and_the_latch_holds() {
        let relay = Relay::start().await;
        let (desk, phone) = desk_and_phone(&relay).await;
        let mut pending = None;
        let offer = pairing::begin_integration(&desk, &mut pending).unwrap();
        let (_bot, _, pinned, _) = bot_enrolls(&relay, &offer.code).await;
        pairing::poll(&desk, &mut pending, now()).await.unwrap();
        let joined = pairing::confirm_pinned(&desk, &mut pending, pinned.clone())
            .await
            .unwrap();
        assert_eq!(
            client::check_keys(&phone).await.unwrap().outcome,
            KeyOutcome::Adopted
        );
        let join_text = relay.last_rotation()["roster"].as_str().unwrap().to_owned();

        pairing::remove_device(&desk, &pinned.device_id)
            .await
            .expect("the bot was removed");

        let body = relay.last_rotation();
        let text = body["roster"]
            .as_str()
            .expect("the removal carried a document");
        let rd: Roster = roster::parse(text).unwrap();
        assert_eq!(rd.mode, Mode::Signed);
        assert!(body["rosterMac"].is_null());
        assert!(rd.epoch > joined.signed_since);
        assert_eq!(rd.prev, Some(roster::hash(&join_text)));
        assert!(rd.member(&pinned.device_id).is_none(), "{rd:?}");
        assert!(!body["keys"]
            .as_object()
            .unwrap()
            .contains_key(&pinned.device_id));
        assert!(row(&desk, &pinned.device_id).is_none());
        assert_eq!(roster::mode(&desk), Mode::Signed, "the latch let go");
        assert!(roster::restricted_ever(&desk)
            .unwrap()
            .contains(&pinned.device_id));

        assert_eq!(
            client::check_keys(&phone).await.unwrap().outcome,
            KeyOutcome::Adopted
        );
        assert_eq!(identity::group(&phone).unwrap().unwrap().epoch, rd.epoch);
        assert_eq!(roster::mode(&phone), Mode::Signed);
        assert!(row(&phone, &pinned.device_id).is_none());
        // Back to two, and a removed bot's id is no longer listed: a new link may pair a new bot.
        assert_eq!(gate(&desk), Gate::Ready);
    }

    // ---------------------------------------------------------------------------------------
    // The gate
    // ---------------------------------------------------------------------------------------

    /// A device in a group, entitled, against a relay that keeps rosters, with an accepted document
    /// naming it and every peer in `peers` — each `(id, name, signing key on file, proto)`.
    fn gated(peers: &[(&str, &str, bool, i64)]) -> Connection {
        let conn = db();
        let me = identity::ensure(&conn).unwrap();
        identity::create_group(&conn, &me).unwrap();
        grant(&conn);
        let mut members = vec![Member {
            device: me.device_id.clone(),
            x25519: roster::key_text(&me.keypair.public),
            ed25519: Some(roster::key_text(&me.signing.public)),
            cap: roster::FULL.into(),
            proto: identity::PROTO,
            since: 0,
        }];
        for (i, (id, name, keyed, proto)) in peers.iter().enumerate() {
            let x = [i as u8 + 10; 32];
            let sign = crypto::signing_keypair();
            identity::add_device(&conn, id, &x, name).unwrap();
            if *keyed {
                identity::file_sign_key(&conn, id, &sign.public, Some(*proto)).unwrap();
            }
            members.push(Member {
                device: (*id).to_owned(),
                x25519: roster::key_text(&x),
                ed25519: keyed.then(|| roster::key_text(&sign.public)),
                cap: roster::FULL.into(),
                proto: *proto,
                since: 0,
            });
        }
        let group = identity::group(&conn).unwrap().unwrap();
        let rd = Roster {
            v: roster::VERSION,
            group: group.group_id,
            epoch: group.epoch,
            step: 0,
            prev: None,
            mode: Mode::Open,
            signer: me.device_id,
            members,
        };
        let text = roster::to_text(&rd);
        roster::accept(&conn, &text, &rd, false).unwrap();
        roster::note_relay(&conn, true, Some(&text)).unwrap();
        conn
    }

    #[test]
    fn the_gate_is_ready_for_a_group_whose_every_member_verifies() {
        assert_eq!(gate(&gated(&[("phone", "Phone", true, 3)])), Gate::Ready);
    }

    #[test]
    fn the_gate_refuses_a_device_in_no_group() {
        let conn = db();
        assert_eq!(gate(&conn), Gate::Refused(NO_GROUP.into()));
    }

    #[test]
    fn the_gate_refuses_a_group_with_no_membership() {
        let conn = gated(&[]);
        entitlement::clear(&conn).unwrap();
        assert_eq!(gate(&conn), Gate::Refused(NOT_ENTITLED.into()));
    }

    #[test]
    fn the_gate_refuses_a_relay_that_keeps_no_rosters() {
        let conn = gated(&[]);
        roster::note_relay(&conn, false, None).unwrap();
        assert_eq!(gate(&conn), Gate::Refused(RELAY_TOO_OLD.into()));
    }

    #[test]
    fn the_gate_refuses_a_group_with_no_accepted_document() {
        let conn = gated(&[]);
        roster::forget_group(&conn).unwrap();
        roster::note_relay(&conn, true, None).unwrap();
        assert_eq!(gate(&conn), Gate::Refused(NO_ROSTER.into()));
    }

    /// A member with no signing key, and one below `SIG_PROTO`, are each named.
    #[test]
    fn the_gate_names_a_member_that_cannot_verify() {
        assert_eq!(
            gate(&gated(&[
                ("phone", "Phone", true, 3),
                ("tablet", "Old tablet", false, 0)
            ])),
            Gate::Refused(update_or_remove("Old tablet"))
        );
        assert_eq!(
            gate(&gated(&[("laptop", "Laptop", true, 1)])),
            Gate::Refused(update_or_remove("Laptop"))
        );
        let refusal = update_or_remove("Laptop");
        assert!(
            refusal.starts_with("Update or remove \"Laptop\" first"),
            "{refusal}"
        );
    }

    /// ⚠ **A member that verifies rosters but is below `ADD_PROTO` is named** — it would refuse
    /// every card Discord adds — on the document and on the roster, in the spec's sentence shape.
    #[test]
    fn the_gate_names_a_member_that_cannot_take_adds() {
        assert_eq!(
            gate(&gated(&[
                ("phone", "Phone", true, 3),
                ("laptop", "Laptop", true, 2)
            ])),
            Gate::Refused(update_or_remove_for_adds("Laptop"))
        );
        let conn = gated(&[("phone", "Phone", true, 3)]);
        conn.execute(
            "UPDATE sync_devices SET proto = 2 WHERE device_id = 'phone'",
            [],
        )
        .unwrap();
        assert_eq!(
            gate(&conn),
            Gate::Refused(update_or_remove_for_adds("Phone"))
        );
        assert!(
            update_or_remove_for_adds("Laptop").starts_with("Update or remove \"Laptop\" first")
        );
    }

    /// A peer this device paired whose key has not reached the document yet is still named: the
    /// roster is read as well as the document.
    #[test]
    fn the_gate_reads_the_roster_as_well_as_the_document() {
        let conn = gated(&[("phone", "Phone", true, 3)]);
        identity::add_device(&conn, "new-one", &[44u8; 32], "New phone").unwrap();
        assert_eq!(gate(&conn), Gate::Refused(update_or_remove("New phone")));
    }

    #[test]
    fn the_gate_refuses_a_sixth_device() {
        let conn = gated(&[
            ("a", "A", true, 3),
            ("b", "B", true, 3),
            ("c", "C", true, 3),
            ("d", "D", true, 3),
        ]);
        assert_eq!(gate(&conn), Gate::Refused(GROUP_FULL.into()));
    }

    /// A restricted device on the roster — or one once restricted and still listed — is named.
    #[test]
    fn the_gate_refuses_a_second_restricted_device() {
        let conn = gated(&[("phone", "Phone", true, 3), ("bot", "Discord", true, 3)]);
        roster::restrict(&conn, "bot", roster::ADD).unwrap();
        assert_eq!(gate(&conn), Gate::Refused(already_restricted("Discord")));

        let conn = gated(&[("phone", "Phone", true, 3), ("bot", "Old bot", true, 3)]);
        roster::restrict(&conn, "bot", roster::READ).unwrap();
        conn.execute(
            "UPDATE sync_devices SET capability = NULL WHERE device_id = 'bot'",
            [],
        )
        .unwrap();
        assert_eq!(gate(&conn), Gate::Refused(already_restricted("Old bot")));
    }

    /// The gate's sentence is what `DiscordStatus.gate` carries.
    #[test]
    fn a_ready_gate_has_no_refusal() {
        assert_eq!(Gate::Ready.refusal(), None);
        assert_eq!(
            Gate::Refused(NO_GROUP.into()).refusal().as_deref(),
            Some(NO_GROUP)
        );
    }
}
