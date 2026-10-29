//! **Settings → Integrations' review list** (plan `2026-10-29-integrations-intents.md` §3.5): the
//! intents this device's policy parks, Apply and Decline for each, and the switches that make a
//! `(source, kind)` automatic here.
//!
//! Four commands, each answering an [`IntentReview`] so a press draws its outcome without a second
//! read: `integrations_review`, `integrations_review_apply`, `integrations_review_decline` and
//! `integrations_set_automatic`. **The list is the store's inbox read now**, filtered by this
//! device's policy — nothing is cached: a parked intent another device applied or the reader
//! declined elsewhere is simply gone from the next read.
//!
//! **No request, and an empty list, when the store cannot be asked** — a build with no address,
//! a device with no membership, a cache that says off: there is nothing to review, and saying so
//! is not a failure. A request that fails is the sentence its `error_log` row was written with.

use super::intents::{self, Intent, Outcome, KINDS, REVIEWED_SOURCES};
use super::settings;
use super::store::{self, Acked};
use crate::state::Store;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

/// What the review list draws — mirrored by `IntentReview` in `packages/ui/lib/ipc/integrations.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentReview {
    /// The pending intents this device's policy leaves for the reader, oldest first.
    pub intents: Vec<ParkedIntent>,
    /// One row per `(source, kind)` the list draws a switch for, in a fixed order.
    pub automatic: Vec<IntentAutomatic>,
}

/// One parked intent, drawn from **this device's** rows where it has them: the card's name and
/// printing from its card data, the folder's name from its folders — the payload's hints only
/// for a card it does not hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedIntent {
    pub id: String,
    /// `discord`, `mcp` or `trade`.
    pub source: String,
    /// `collection.add` or `wishlist.add`.
    pub kind: String,
    /// This device's name for the card, else the payload's hint, else the id it names.
    pub name: String,
    pub set: Option<String>,
    pub cn: Option<String>,
    pub finish: Option<String>,
    pub quantity: i64,
    /// The folder's name here; `None` is the wishlist's root, or a folder this device lacks.
    pub folder: Option<String>,
    /// Unix milliseconds, the Worker's clock.
    pub created_at: i64,
    pub confirmed_by: Option<String>,
}

/// Whether this device applies one `(source, kind)` unasked. `fixed` rows are Discord's: on, and
/// not this list's to switch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentAutomatic {
    pub source: String,
    pub kind: String,
    pub on: bool,
    pub fixed: bool,
}

/// The review list's Apply on an intent that is no longer waiting — another device applied it, or
/// the reader declined it elsewhere.
pub const GONE: &str =
    "That change is no longer waiting. Another of your devices may have applied it.";

/// Apply on an intent another device is applying right now.
pub const TAKEN: &str = "Another of your devices is applying that change.";

/// Apply on an intent naming a card this device's card data does not hold yet.
pub const WAITING: &str =
    "This device's card data does not have that card yet. Try again after it next updates.";

/// The switches, in the list's order: each reviewed source, each kind.
fn automatic_rows(conn: &Connection) -> Vec<IntentAutomatic> {
    REVIEWED_SOURCES
        .iter()
        .flat_map(|source| {
            KINDS.iter().map(move |kind| IntentAutomatic {
                source: (*source).to_owned(),
                kind: (*kind).to_owned(),
                on: intents::automatic(conn, source, kind),
                fixed: intents::fixed(source, kind),
            })
        })
        .collect()
}

/// Whether the store can be asked at all: an address, a membership, a cache that says on. Local.
fn askable(conn: &Connection) -> bool {
    store::endpoint(conn).is_ok() && store::entitled(conn) && settings::read_cache(conn).enabled
}

/// One string column by one key, or `None`.
fn one(conn: &Connection, sql: &str, key: &str) -> Option<String> {
    conn.query_row(sql, [key], |r| r.get::<_, Option<String>>(0))
        .optional()
        .ok()
        .flatten()
        .flatten()
}

/// One parked intent as this device draws it.
fn drawn(conn: &Connection, intent: &Intent) -> ParkedIntent {
    let payload = &intent.payload;
    let text = |key: &str| payload.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let card = text("scryfallId");
    let printing: Option<(String, String, String)> = card.as_deref().and_then(|id| {
        conn.query_row(
            "SELECT name, set_code, collector_number FROM cards WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten()
    });
    let oracle_name = text("oracleId").and_then(|oracle| {
        one(
            conn,
            "SELECT name FROM cards WHERE oracle_id = ?1 LIMIT 1",
            &oracle,
        )
    });
    let (name, set, cn) = match printing {
        Some((name, set, cn)) => (name, Some(set), Some(cn)),
        None => (
            oracle_name
                .or_else(|| text("name"))
                .or_else(|| card.clone())
                .or_else(|| text("oracleId"))
                .unwrap_or_default(),
            text("set"),
            text("cn"),
        ),
    };
    let folder = text("folderUid").and_then(|uid| {
        let sql = if intent.kind == intents::COLLECTION_ADD {
            "SELECT name FROM collection_folders WHERE sync_uid = ?1"
        } else {
            "SELECT name FROM wishlist_folders WHERE sync_uid = ?1"
        };
        one(conn, sql, &uid)
    });
    ParkedIntent {
        id: intent.id.clone(),
        source: intent.source.clone(),
        kind: intent.kind.clone(),
        name,
        set,
        cn,
        finish: text("finish"),
        quantity: payload
            .get("quantity")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        folder,
        created_at: intent.created_at,
        confirmed_by: intent.confirmed_by.clone(),
    }
}

/// The list with no request: no intents, and the switches.
fn local(db: &impl Store) -> Result<IntentReview, String> {
    db.reading(|conn| {
        Ok(IntentReview {
            intents: Vec::new(),
            automatic: automatic_rows(conn),
        })
    })
}

/// The door and the inbox, or `None` when the store cannot be asked or says it is gone.
async fn inbox(db: &impl Store) -> Result<Option<(store::Door, Vec<Intent>)>, String> {
    if !db.reading(|conn| Ok(askable(conn)))? {
        return Ok(None);
    }
    let door = match store::door(db, "integrations_intents").await {
        Ok(door) => door,
        Err(e) if e == store::NOT_CONNECTED || e == store::NOT_DEPLOYED => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(intents::pending(db, &door).await?.map(|all| (door, all)))
}

/// `integrations_review` — the parked intents and the switches. `db` is the lane.
pub async fn review(db: &impl Store) -> Result<IntentReview, String> {
    let Some((_, pending)) = inbox(db).await? else {
        return local(db);
    };
    db.reading(|conn| {
        Ok(IntentReview {
            intents: pending
                .iter()
                .filter(|i| !intents::automatic(conn, &i.source, &i.kind))
                .map(|i| drawn(conn, i))
                .collect(),
            automatic: automatic_rows(conn),
        })
    })
}

/// `integrations_review_apply` — one intent, **whatever the policy says**: the reader chose it.
/// Claimed, held to the allow-list, applied and acked as the round does it ([`intents::take`]).
/// A refusal is acked with its sentence and answered as it; a card this device cannot read yet
/// is [`WAITING`]; one another device holds is [`TAKEN`]; one gone is [`GONE`].
pub async fn apply(db: &impl Store, id: &str) -> Result<IntentReview, String> {
    let Some((door, pending)) = inbox(db).await? else {
        return Err(GONE.to_owned());
    };
    let Some(intent) = pending.into_iter().find(|i| i.id == id) else {
        return Err(GONE.to_owned());
    };
    let current = db.reading(|conn| Ok(super::readable::corpus_current(conn)))?;
    match intents::take(db, &door, &intent, current).await? {
        Outcome::Applied => review(db).await,
        Outcome::Refused(reason) => Err(reason.to_owned()),
        Outcome::Waiting => Err(WAITING.to_owned()),
        Outcome::Taken => Err(TAKEN.to_owned()),
        Outcome::Settled => Err(GONE.to_owned()),
    }
}

/// `integrations_review_decline` — ack one intent refused, [`intents::DECLINED`]. No claim: a
/// refusal applies nothing. One already settled or gone is as good as declined.
pub async fn decline(db: &impl Store, id: &str) -> Result<IntentReview, String> {
    let Some((door, _)) = inbox(db).await? else {
        return local(db);
    };
    match intents::decline(db, &door, id, intents::DECLINED).await? {
        Acked::Taken => Err(TAKEN.to_owned()),
        Acked::Done | Acked::Settled | Acked::Gone => review(db).await,
    }
}

/// `integrations_set_automatic` — switch one `(source, kind)` on or off **on this device**.
/// Switching one on asks for a publish round, so what it parked is applied within one poll.
pub async fn set_automatic(
    db: &impl Store,
    source: &str,
    kind: &str,
    on: bool,
) -> Result<IntentReview, String> {
    db.with(|conn| {
        intents::set_automatic(conn, source, kind, on)?;
        if on {
            settings::request_publish(conn)?;
        }
        Ok(())
    })?;
    review(db).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::{client, entitlement};
    use serde_json::json;

    fn open_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A device in `g1` whose store at `base` was last heard on, with one card.
    fn on(conn: &Connection, base: &str) {
        crate::schema::fixtures::seed_card(conn, "c-bolt", "lea", "161");
        client::set_state(conn, store::INTEGRATIONS_URL, base).unwrap();
        client::set_state(conn, entitlement::ACCESS_TOKEN, "bearer").unwrap();
        client::set_state(conn, entitlement::ACCESS_EXPIRES, &i64::MAX.to_string()).unwrap();
        client::set_state(conn, entitlement::SUPPORTER_STATUS, "active").unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g1', 0, zeroblob(32), 0)",
            [],
        )
        .unwrap();
        let mut cache = settings::read_cache(conn);
        cache.enabled = true;
        settings::write_cache(conn, &cache).unwrap();
    }

    fn pending(id: &str, source: &str) -> serde_json::Value {
        json!({
            "id": id, "group": "g1", "source": source, "kind": "wishlist.add",
            "payload": { "scryfallId": "c-bolt", "oracleId": null, "finish": "foil", "quantity": 2,
                         "folderUid": null, "name": "Bolt (hint)" },
            "createdAt": 5, "confirmedBy": null, "state": "pending", "reason": null,
        })
    }

    /// **No request and an empty list when the store cannot be asked** — every build until the
    /// deploy — and the four switches: Discord's fixed on, MCP's off.
    #[tokio::test]
    async fn a_store_that_cannot_be_asked_is_an_empty_list_and_the_switches() {
        let conn = open_db();
        let read = review(&conn).await.unwrap();
        assert!(read.intents.is_empty());
        let rows: Vec<(&str, &str, bool, bool)> = read
            .automatic
            .iter()
            .map(|a| (a.source.as_str(), a.kind.as_str(), a.on, a.fixed))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("discord", "collection.add", true, true),
                ("discord", "wishlist.add", true, true),
                ("mcp", "collection.add", false, false),
                ("mcp", "wishlist.add", false, false),
            ]
        );
        let none: i64 = conn
            .query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(none, 0);
    }

    /// **The list is what the policy parks**, drawn from this device's card data — the card's own
    /// name over the payload's hint — and a Discord add, applied unasked, is not on it.
    #[tokio::test]
    async fn the_list_is_what_this_devices_policy_parks() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        on(&conn, &server.base_url());
        let body = json!({ "intents": [pending(&"a".repeat(22), "mcp"), pending(&"b".repeat(22), "discord")], "more": false })
            .to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/intents");
                then.status(200).body(body);
            })
            .await;
        let read = review(&conn).await.unwrap();
        assert_eq!(read.intents.len(), 1);
        let parked = &read.intents[0];
        assert_eq!(parked.id, "a".repeat(22));
        assert_eq!(parked.name, "Lightning Bolt");
        assert_eq!(parked.set.as_deref(), Some("lea"));
        assert_eq!(parked.quantity, 2);
        assert_eq!(parked.folder, None);

        // Switched on here, MCP's wishes are no longer parked — and a round is asked for.
        let read = set_automatic(&conn, "mcp", "wishlist.add", true)
            .await
            .unwrap();
        assert!(read.intents.is_empty());
        assert!(settings::publish_requested(&conn));
    }

    /// Decline acks refused with its sentence and no lease.
    #[tokio::test]
    async fn decline_acks_refused_in_the_apps_words() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        on(&conn, &server.base_url());
        let id = "a".repeat(22);
        let body = json!({ "intents": [pending(&id, "mcp")], "more": false }).to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/intents");
                then.status(200).body(body);
            })
            .await;
        let path = format!("/g/g1/intents/{id}/ack");
        let ack = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST)
                    .path(path)
                    .json_body(json!({
                        "state": "refused", "reason": intents::DECLINED, "lease": null,
                        "hlcMs": null, "hlcCtr": null,
                    }));
                then.status(200).body("{}");
            })
            .await;
        decline(&conn, &id).await.unwrap();
        ack.assert_calls_async(1).await;
    }

    /// Apply on an intent the inbox no longer holds is [`GONE`], and asks nothing more of it.
    #[tokio::test]
    async fn apply_on_an_intent_no_longer_waiting_is_gone() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        on(&conn, &server.base_url());
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/intents");
                then.status(200).body(r#"{"intents":[],"more":false}"#);
            })
            .await;
        assert_eq!(apply(&conn, &"a".repeat(22)).await.unwrap_err(), GONE);
    }

    /// Apply on a parked intent takes it whatever the policy says: claimed, written, acked.
    #[tokio::test]
    async fn apply_takes_a_parked_intent() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        on(&conn, &server.base_url());
        let id = "a".repeat(22);
        let listed = json!({ "intents": [pending(&id, "mcp")], "more": false }).to_string();
        let inbox = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/intents");
                then.status(200).body(listed);
            })
            .await;
        let claim_path = format!("/g/g1/intents/{id}/claim");
        let claim_body = json!({ "id": id, "lease": "L".repeat(22), "leaseUntil": 1 }).to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST).path(claim_path);
                then.status(200).body(claim_body);
            })
            .await;
        let ack_path = format!("/g/g1/intents/{id}/ack");
        let ack = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST).path(ack_path);
                then.status(200).body("{}");
            })
            .await;
        apply(&conn, &id).await.unwrap();
        ack.assert_calls_async(1).await;
        assert!(inbox.calls_async().await >= 1);
        let wishes: i64 = conn
            .query_row("SELECT quantity FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(wishes, 2);
    }

    /// **No sentence here names a membership** — the store's module's rule, for its reason.
    #[test]
    fn no_sentence_a_reader_is_shown_names_a_membership() {
        for sentence in [
            GONE,
            TAKEN,
            WAITING,
            intents::NOT_ALLOWED,
            intents::BAD_PAYLOAD,
            intents::BAD_QUANTITY,
            intents::BAD_FINISH,
            intents::UNKNOWN_CARD,
            intents::NO_FOLDER,
            intents::NOT_A_USER_FOLDER,
            intents::MANAGED_FOLDER,
            intents::WRONG_GROUP,
            intents::DECLINED,
            intents::FIXED,
        ] {
            let said = sentence.to_lowercase();
            for word in ["patreon", "membership", "supporter", "pledge", "subscri"] {
                assert!(!said.contains(word), "{sentence}");
            }
        }
    }
}
