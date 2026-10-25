//! **The group's switch, as this device last heard it**, and the four commands behind Settings →
//! Integrations (plan §3.3): `integrations_status`, `integrations_enable`,
//! `integrations_set_fields` and `integrations_disable`, each answering an [`IntegrationsStatus`].
//!
//! **The store's existence is the switch, and its fields are the group's** (plan §2). So nothing
//! here is a device's preference: [`enable`] makes the store, [`disable`] empties it, and every
//! device learns both from the store itself — on a status read, and on each publish round
//! ([`super::publish`]). What this device keeps is a **cache** of the last answer, in `app_meta`
//! (local, never synced): whether the store existed, under which fields, when it was asked, when
//! this device last sent a table, and the last round's failure. A cache from another group reads
//! as empty, so a device that changed group never draws the old group's switch.
//!
//! **A switch-on or a change of columns asks for a publish** ([`PUBLISH_DUE`]), a durable
//! `app_meta` row the publish loop treats as due at once, so the store is filled within one poll
//! of the press rather than at the next sync trip — and a press made just before the app closed
//! is still owed on the next launch.

use super::projection::IntegrationFields;
use super::store::{self, StoreSettings};
use crate::platform::spawn;
use crate::sorting::Marketplace;
use crate::state::{State, Store};
use crate::sync_pair::identity;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// What the Integrations panel draws — mirrored by `IntegrationsStatus` in
/// `packages/ui/lib/ipc/integrations.ts`, whose parity row in `ipc.test.ts` reads this struct one
/// field a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsStatus {
    /// This build has a store address (or an override for `wrangler dev`): [`store::endpoint`].
    pub available: bool,
    /// A device in a group with a membership: [`store::entitled`].
    pub entitled: bool,
    /// The group's store exists, as last heard.
    pub enabled: bool,
    /// The group's choice of columns, as last heard. Meaningful while `enabled`.
    pub fields: IntegrationFields,
    /// Unix seconds the store was last asked.
    pub checked_at: Option<i64>,
    /// Unix seconds this device last published a table to it.
    pub published_at: Option<i64>,
    /// The last publish round's failure, in a sentence, or `None`.
    pub error: Option<String>,
    /// A publish this device was asked for ([`PUBLISH_DUE`]) has not run yet — true from a switch
    /// turned on or a change of columns until the round that serves it has run, whatever it came
    /// to, and false after a switch-off. The panel polls the status only while this is true.
    pub pending: bool,
}

/// `integrations_set_fields` with no store to set them on. **Refused rather than sent**: a settings
/// `PUT` would make a store, and only the switch may — nothing may bring back a store another
/// device deleted (plan §2).
pub const OFF: &str = "Integrations are off. Switch them on first.";

/// What the panel says when the last publish round's projection half failed. The particulars —
/// the Worker's refusal, a timeout — are in the `error_log` row the failure wrote, which is where
/// this sends the reader.
pub const ROUND_FAILED: &str =
    "Your collection could not be sent to the integrations service. The Errors panel in Settings says why.";

/// The `app_meta` row holding [`Cache`], as JSON.
const CACHE: &str = "integrations_cache";

/// The `app_meta` row that asks the publish loop for a round now — written by [`enable`] and
/// [`set_fields`], cleared by [`disable`] and by the round that answers it. Present or absent;
/// its value is when it was asked, for a reader of the table.
pub const PUBLISH_DUE: &str = "integrations_publish_due";

/// The last answer this device heard from its group's store, and what it last did about it.
///
/// **Keyed by the group it was heard for**: a device that leaves its group and joins another
/// carries no switch across ([`read_cache`] answers the default for any other group).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cache {
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub fields: IntegrationFields,
    /// The marketplace the group's store reads prices at, by id, as last heard — `None` before
    /// the store has said. Set by the switch alone ([`enable`]); [`set_fields`] sends it back.
    #[serde(default)]
    pub marketplace: Option<String>,
    #[serde(default)]
    pub checked_at: Option<i64>,
    #[serde(default)]
    pub published_at: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Cache {
    /// Heard that the store exists, under `settings`, at `now`.
    pub fn heard_on(&mut self, settings: &StoreSettings, now: i64) {
        self.enabled = true;
        self.fields = settings.fields;
        self.marketplace.clone_from(&settings.marketplace);
        self.checked_at = Some(now);
    }

    /// Heard that there is no store, at `now`: nothing of this device's is on the server either,
    /// so the send stamp goes, and with it any failure to send.
    pub fn heard_off(&mut self, now: i64) {
        self.enabled = false;
        self.fields = IntegrationFields::default();
        self.marketplace = None;
        self.checked_at = Some(now);
        self.published_at = None;
        self.error = None;
    }
}

/// The group this device is in now, by id.
fn group_id(conn: &Connection) -> Option<String> {
    identity::group(conn).ok().flatten().map(|g| g.group_id)
}

/// The cache, **for the group this device is in now** — the default for a row heard for another
/// group, for none, or for one that will not parse (a cache miss is asked again, `app_meta`'s
/// rule).
pub fn read_cache(conn: &Connection) -> Cache {
    let group = group_id(conn);
    crate::app_meta::get_app_meta(conn, CACHE)
        .and_then(|json| serde_json::from_str::<Cache>(&json).ok())
        .filter(|cache| cache.group == group)
        .unwrap_or(Cache {
            group,
            ..Cache::default()
        })
}

/// Write the cache, stamped with the group this device is in now.
pub fn write_cache(conn: &Connection, cache: &Cache) -> Result<(), String> {
    let stamped = Cache {
        group: group_id(conn),
        ..cache.clone()
    };
    let json = serde_json::to_string(&stamped).map_err(|e| e.to_string())?;
    crate::app_meta::set_app_meta(conn, CACHE, &json).map_err(|e| e.to_string())
}

/// Whether a publish has been asked for and not yet answered.
pub fn publish_requested(conn: &Connection) -> bool {
    crate::app_meta::get_app_meta(conn, PUBLISH_DUE).is_some()
}

/// Ask the publish loop for a round at its next poll.
pub fn request_publish(conn: &Connection) -> Result<(), String> {
    let now = now(conn)?;
    crate::app_meta::set_app_meta(conn, PUBLISH_DUE, &now.to_string()).map_err(|e| e.to_string())
}

/// The request answered, or withdrawn.
pub fn clear_publish_request(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM app_meta WHERE key = ?1",
        rusqlite::params![PUBLISH_DUE],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The clock, read from SQLite so every stamp here agrees with `unixepoch()` in the rest of the
/// crate — `share::publish`'s `now`.
pub fn now(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT unixepoch()", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// The status, from what this device holds and nothing else: no request.
pub fn answer(conn: &Connection) -> IntegrationsStatus {
    let cache = read_cache(conn);
    IntegrationsStatus {
        available: store::endpoint(conn).is_ok(),
        entitled: store::entitled(conn),
        enabled: cache.enabled,
        fields: cache.fields,
        checked_at: cache.checked_at,
        published_at: cache.published_at,
        error: cache.error,
        pending: publish_requested(conn),
    }
}

/// The status, **asking the store when it can** — a build with an address, a device that can mint
/// a token — **and the cache when it cannot**. A failed ask is not an error to the panel, the share
/// list's rule: the request has written its `error_log` row, and the panel draws the last answer.
///
/// **And the cache while a publish is pending**: the round about to serve it asks the store itself
/// within one poll and writes what it hears here, and the panel asks every few seconds until it
/// has — a request each time would be the store asked twenty times for one answer.
///
/// `db` is the lane: the token is minted through it.
pub async fn status(db: &impl Store) -> Result<IntegrationsStatus, String> {
    let askable = db.with(|conn| {
        Ok(store::endpoint(conn).is_ok() && store::entitled(conn) && !publish_requested(conn))
    })?;
    if askable {
        if let Ok(door) = store::door(db, "integrations_digests").await {
            if let Ok(heard) = store::digests(db, &door).await {
                db.with(|conn| {
                    let now = now(conn)?;
                    let mut cache = read_cache(conn);
                    match heard {
                        Some(digests) => cache.heard_on(&digests.settings, now),
                        None => cache.heard_off(now),
                    }
                    write_cache(conn, &cache)
                })?;
            }
        }
    }
    db.with(|conn| Ok(answer(conn)))
}

/// [`status`] as the panel asks it: through the lane within a press's bound, and **the cache when
/// the lane cannot be had in it** — a publish round or a trip in flight is a reason to answer
/// what this device last heard, never a reason to tell the panel the app is busy. The table's
/// entry and the desktop's wrapper are this.
///
/// **While a publish is pending it is the cache at once, and the lane is not asked for**: the
/// panel polls every few seconds then, and the round it is waiting for holds the lane — each poll
/// would otherwise wait out a press's bound behind the very thing it is waiting to hear about.
pub async fn status_or_cached(state: &Arc<State>) -> Result<IntegrationsStatus, String> {
    let last_heard = cached(state).await?;
    if last_heard.pending {
        return Ok(last_heard);
    }
    match state.lane_for_press().await {
        Ok(lane) => status(&lane).await,
        Err(_) => cached(state).await,
    }
}

/// [`answer`] on the read connection, on the blocking pool.
async fn cached(state: &Arc<State>) -> Result<IntegrationsStatus, String> {
    let reader = Arc::clone(state);
    spawn::blocking(move || answer(&reader.lock_db_read()))
        .await
        .map_err(|e| e.to_string())
}

/// This device's marketplace, by the id the store and every document spell it with
/// (`share::snapshot::marketplace_id`) — what a press sends as the group's.
pub fn device_marketplace(conn: &Connection) -> &'static str {
    crate::share::snapshot::marketplace_id(Marketplace::from_id(&crate::marketplace::stored(conn)))
}

/// Switch integrations on for the group: make its store under `fields` **and this device's
/// marketplace** (the group's from now on — see [`store::StoreSettings`]), remember it, and ask
/// for a publish so this device fills it within one poll. Refused, before any request, with
/// [`store::NOT_DEPLOYED`] or [`store::NOT_CONNECTED`].
pub async fn enable(
    db: &impl Store,
    fields: IntegrationFields,
) -> Result<IntegrationsStatus, String> {
    let door = store::door(db, "integrations_settings").await?;
    let marketplace = db.with(|conn| Ok(device_marketplace(conn)))?;
    let settled = store::put_settings(db, &door, fields, marketplace, true).await?;
    settled_or_off(db, settled)
}

/// Change the group's columns while its store exists. **Under the group's marketplace as last
/// heard, never this device's**: only the switch sets the marketplace ([`enable`]), so ticking a box
/// on a device set to another marketplace changes the box and nothing else — a changed marketplace
/// would drop every table the store holds. A cache that has heard none sends TCGplayer, which is
/// what every device reads a store naming none as.
///
/// **Sent with `create: false`**, so a store switched off on another device answers that it is
/// gone rather than being made again (only the switch makes one), and that is [`OFF`]; so is a
/// cache that already says off, before any token is minted — the build's and the device's
/// refusals before that ([`store::door`]'s order).
pub async fn set_fields(
    db: &impl Store,
    fields: IntegrationFields,
) -> Result<IntegrationsStatus, String> {
    let marketplace = db.with(|conn| {
        store::endpoint(conn)?;
        if !store::entitled(conn) {
            return Err(store::NOT_CONNECTED.to_owned());
        }
        let cache = read_cache(conn);
        if !cache.enabled {
            return Err(OFF.to_owned());
        }
        Ok(cache.marketplace.unwrap_or_else(|| {
            crate::share::snapshot::marketplace_id(Marketplace::Tcgplayer).to_owned()
        }))
    })?;
    let door = store::door(db, "integrations_settings").await?;
    let settled = store::put_settings(db, &door, fields, &marketplace, false).await?;
    settled_or_off(db, settled)
}

/// The store's answer to a settings `PUT`: on under the settings it holds — the cache says so,
/// the last failure is forgotten (the settings it failed under are not these) and a publish is
/// asked for — or gone, which the cache hears and the press is told as [`OFF`].
fn settled_or_off(
    db: &impl Store,
    settled: Option<store::Settled>,
) -> Result<IntegrationsStatus, String> {
    let Some(settled) = settled else {
        db.with(|conn| {
            let now = now(conn)?;
            let mut cache = read_cache(conn);
            cache.heard_off(now);
            write_cache(conn, &cache)
        })?;
        return Err(OFF.to_owned());
    };
    db.with(|conn| {
        let now = now(conn)?;
        let mut cache = read_cache(conn);
        cache.heard_on(&settled.settings, now);
        cache.error = None;
        write_cache(conn, &cache)?;
        request_publish(conn)?;
        Ok(answer(conn))
    })
}

/// Switch integrations off **for every device in the group**: empty the store, remember it, and
/// withdraw any publish still owed.
pub async fn disable(db: &impl Store) -> Result<IntegrationsStatus, String> {
    let door = store::door(db, "integrations_delete").await?;
    store::delete_group(db, &door).await?;
    db.with(|conn| {
        let now = now(conn)?;
        let mut cache = read_cache(conn);
        cache.heard_off(now);
        write_cache(conn, &cache)?;
        clear_publish_request(conn)?;
        Ok(answer(conn))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::{client, entitlement};

    fn open_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A device in group `g1`, covered by a membership, holding a token fresh enough that nothing
    /// asks the relay, whose store is at `base`.
    fn entitled(conn: &Connection, base: &str) {
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
    }

    const SOME: IntegrationFields = IntegrationFields {
        condition: true,
        lang: false,
        value: false,
        tags: false,
        notes: true,
    };

    fn fields_json(fields: IntegrationFields) -> String {
        serde_json::to_string(&fields).unwrap()
    }

    /// The store's settings under `fields`, at no marketplace in particular.
    fn under(fields: IntegrationFields) -> StoreSettings {
        StoreSettings {
            fields,
            marketplace: None,
        }
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
            .unwrap()
    }

    /// **Every build until the deploy**: the status answers `available: false` and the three writes
    /// refuse in words, with no request and no row.
    #[tokio::test]
    async fn a_build_with_no_address_asks_nobody_and_refuses_every_write_in_words() {
        let conn = open_db();
        entitled(&conn, "integrations.example");
        let status = status(&conn).await.unwrap();
        assert!(!status.available);
        assert!(status.entitled);
        assert_eq!(status.checked_at, None, "nobody was asked");
        assert_eq!(enable(&conn, SOME).await.unwrap_err(), store::NOT_DEPLOYED);
        assert_eq!(
            set_fields(&conn, SOME).await.unwrap_err(),
            store::NOT_DEPLOYED
        );
        assert_eq!(disable(&conn).await.unwrap_err(), store::NOT_DEPLOYED);
        assert_eq!(rows(&conn), 0);
        assert!(!publish_requested(&conn));
    }

    /// The switch makes the store under the reader's columns **and this device's marketplace**,
    /// asking for it to be made, says on, and asks for a publish.
    #[tokio::test]
    async fn enable_makes_the_store_and_asks_for_a_publish() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        crate::app_meta::set_app_meta(&conn, crate::marketplace::K_MARKETPLACE, "cardmarket")
            .unwrap();
        let put = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/settings")
                    .header("authorization", "Bearer bearer")
                    .header("content-type", "application/json")
                    .json_body(serde_json::json!({
                        "fields": SOME, "marketplace": "cardmarket", "create": true,
                    }));
                then.status(200).body(format!(
                    r#"{{"fields":{},"marketplace":"cardmarket","created":true}}"#,
                    fields_json(SOME)
                ));
            })
            .await;

        let status = enable(&conn, SOME).await.unwrap();
        assert_eq!(put.calls_async().await, 1);
        assert!(status.enabled);
        assert_eq!(status.fields, SOME);
        assert_eq!(
            read_cache(&conn).marketplace.as_deref(),
            Some("cardmarket"),
            "the group's marketplace, as the store holds it"
        );
        assert!(status.checked_at.is_some());
        assert_eq!(
            status.published_at, None,
            "the round publishes, not the press"
        );
        assert!(publish_requested(&conn));
        assert!(status.pending, "the panel polls until the round has run");
    }

    /// **Pending while a publish is owed, and the cache is the answer then**: the round about to
    /// run asks the store, so a poll does not — and once the round has cleared the request the
    /// status asks again, and says so.
    #[tokio::test]
    async fn a_pending_publish_is_said_and_answered_from_the_cache() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        let asked = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/g/g1/projection/digests");
                then.status(200).body(format!(
                    r#"{{"fields":{},"tables":{{}}}}"#,
                    fields_json(SOME)
                ));
            })
            .await;
        request_publish(&conn).unwrap();

        let polled = status(&conn).await.unwrap();
        assert!(polled.pending);
        assert_eq!(
            asked.calls_async().await,
            0,
            "a poll while pending asks nobody"
        );

        clear_publish_request(&conn).unwrap();
        let after = status(&conn).await.unwrap();
        assert!(!after.pending);
        assert_eq!(asked.calls_async().await, 1);
        assert!(after.enabled);
    }

    /// **And it does not wait for the lane while pending** — the round being waited for holds it,
    /// and a poll that waited out a press's bound each time would be five seconds a poll.
    #[tokio::test]
    async fn a_pending_status_answers_at_once_while_the_lane_is_held() {
        let (state, _dir) =
            crate::state::fixtures::on_files("integrations-pending-lane", "http://127.0.0.1:1");
        request_publish(&state.lock_db()).unwrap();
        let held = state.lane().await;
        let answered =
            tokio::time::timeout(std::time::Duration::from_secs(2), status_or_cached(&state))
                .await
                .expect("a pending status waited for the lane")
                .unwrap();
        assert!(answered.pending);
        drop(held);
    }

    /// **Only the switch makes a store**: while off, a change of columns is refused before any
    /// request — and while the cache says on but the store is gone, it is sent asking for no store
    /// to be made, answered that there is none, and refused.
    #[tokio::test]
    async fn set_fields_while_off_is_refused_and_makes_no_store() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        let gone = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/settings")
                    .json_body(serde_json::json!({
                        "fields": SOME, "marketplace": "tcgplayer", "create": false,
                    }));
                then.status(404)
                    .body(r#"{"error":"integrations are off for this group","code":"no_store"}"#);
            })
            .await;

        assert_eq!(set_fields(&conn, SOME).await.unwrap_err(), OFF);
        assert_eq!(
            gone.calls_async().await,
            0,
            "the cache said off: nothing asked"
        );

        let mut cache = read_cache(&conn);
        cache.heard_on(&under(IntegrationFields::default()), 1);
        write_cache(&conn, &cache).unwrap();
        assert_eq!(set_fields(&conn, SOME).await.unwrap_err(), OFF);
        assert_eq!(gone.calls_async().await, 1, "asked once, never to create");
        assert!(!read_cache(&conn).enabled, "and the cache heard it");
        assert!(!publish_requested(&conn));
        assert_eq!(
            rows(&conn),
            0,
            "a store that is gone is a state, not a failure"
        );
    }

    /// A change of columns on a store that exists is sent, cached and published.
    #[tokio::test]
    async fn set_fields_while_on_sends_the_new_columns() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        let mut cache = read_cache(&conn);
        cache.heard_on(&under(IntegrationFields::default()), 1);
        write_cache(&conn, &cache).unwrap();
        let put = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/settings")
                    .json_body(serde_json::json!({
                        "fields": SOME, "marketplace": "tcgplayer", "create": false,
                    }));
                then.status(200).body(format!(
                    r#"{{"fields":{},"marketplace":"tcgplayer","created":false}}"#,
                    fields_json(SOME)
                ));
            })
            .await;

        let status = set_fields(&conn, SOME).await.unwrap();
        assert_eq!(put.calls_async().await, 1);
        assert_eq!(status.fields, SOME);
        assert!(publish_requested(&conn));
    }

    /// **A change of columns keeps the group's marketplace**: the store holds Cardmarket, this
    /// device is set to TCGplayer, and ticking a box sends Cardmarket back — a changed marketplace
    /// would drop every table the store holds, for a box.
    #[tokio::test]
    async fn set_fields_keeps_the_groups_marketplace() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        let mut cache = read_cache(&conn);
        cache.heard_on(
            &StoreSettings {
                fields: IntegrationFields::default(),
                marketplace: Some("cardmarket".to_owned()),
            },
            1,
        );
        write_cache(&conn, &cache).unwrap();
        let put = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path("/g/g1/settings")
                    .json_body(serde_json::json!({
                        "fields": SOME, "marketplace": "cardmarket", "create": false,
                    }));
                then.status(200).body(format!(
                    r#"{{"fields":{},"marketplace":"cardmarket","created":false}}"#,
                    fields_json(SOME)
                ));
            })
            .await;

        set_fields(&conn, SOME).await.unwrap();
        assert_eq!(put.calls_async().await, 1);
        assert_eq!(read_cache(&conn).marketplace.as_deref(), Some("cardmarket"));
    }

    /// The switch-off empties the store, says off, clears the columns and the send stamp, and
    /// withdraws a publish still owed.
    #[tokio::test]
    async fn disable_deletes_the_store_and_clears_the_request() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        let mut cache = read_cache(&conn);
        cache.heard_on(&under(SOME), 1);
        cache.published_at = Some(2);
        write_cache(&conn, &cache).unwrap();
        request_publish(&conn).unwrap();
        let deleted = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::DELETE)
                    .path("/g/g1")
                    .header("authorization", "Bearer bearer");
                then.status(204);
            })
            .await;

        let status = disable(&conn).await.unwrap();
        assert_eq!(deleted.calls_async().await, 1);
        assert!(!status.enabled);
        assert_eq!(status.fields, IntegrationFields::default());
        assert_eq!(status.published_at, None);
        assert!(!publish_requested(&conn));
        assert!(!status.pending, "nothing is owed to a store that is gone");
    }

    /// **A failed ask answers the cache**: the store did not answer, so the panel draws what this
    /// device last heard, and the request's row is the only trace.
    #[tokio::test]
    async fn status_answers_the_cache_when_the_store_cannot_be_asked() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        let mut cache = read_cache(&conn);
        cache.heard_on(&under(SOME), 7);
        write_cache(&conn, &cache).unwrap();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/g/g1/projection/digests");
                then.status(500).body(r#"{"error":"the store fell over"}"#);
            })
            .await;

        let status = status(&conn).await.unwrap();
        assert!(status.enabled);
        assert_eq!(status.fields, SOME);
        assert_eq!(status.checked_at, Some(7), "as last heard, not now");
        assert_eq!(rows(&conn), 1);
    }

    /// And one that answers is heard: another device's switch, and its columns.
    #[tokio::test]
    async fn status_hears_another_devices_switch() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        entitled(&conn, &server.base_url());
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/g/g1/projection/digests");
                then.status(200).body(format!(
                    r#"{{"fields":{},"tables":{{}}}}"#,
                    fields_json(SOME)
                ));
            })
            .await;
        let status = status(&conn).await.unwrap();
        assert!(status.enabled && status.available && status.entitled);
        assert_eq!(status.fields, SOME);
        assert!(status.checked_at.is_some());
    }

    /// A device that is not entitled asks nobody, even with an address: its status is the cache.
    #[tokio::test]
    async fn a_device_with_no_membership_asks_nobody() {
        let conn = open_db();
        client::set_state(&conn, store::INTEGRATIONS_URL, "http://127.0.0.1:1").unwrap();
        let status = status(&conn).await.unwrap();
        assert!(status.available && !status.entitled && !status.enabled);
        assert_eq!(enable(&conn, SOME).await.unwrap_err(), store::NOT_CONNECTED);
        assert_eq!(rows(&conn), 0);
    }

    /// **A cache is its group's**: a device that changed group reads the default.
    #[test]
    fn a_cache_heard_for_another_group_reads_as_empty() {
        let conn = open_db();
        entitled(&conn, "http://127.0.0.1:1");
        let mut cache = read_cache(&conn);
        cache.heard_on(&under(SOME), 1);
        write_cache(&conn, &cache).unwrap();
        assert!(read_cache(&conn).enabled);
        conn.execute("UPDATE sync_group SET group_id = 'g2'", [])
            .unwrap();
        assert!(!read_cache(&conn).enabled);
        assert_eq!(read_cache(&conn).group.as_deref(), Some("g2"));
    }

    /// **No sentence here names a membership**, the store's rule for its reason.
    #[test]
    fn no_sentence_a_reader_is_shown_names_a_membership() {
        for sentence in [OFF, ROUND_FAILED] {
            let said = sentence.to_lowercase();
            for word in ["patreon", "membership", "supporter", "pledge", "subscri"] {
                assert!(!said.contains(word), "{sentence}");
            }
        }
    }

    /// The wire names the page reads — `ipc.test.ts` reads the struct, and this reads what serde
    /// makes of it, which is the half a dropped `rename_all` would break.
    #[test]
    fn the_status_serialises_under_the_names_the_page_reads() {
        let conn = open_db();
        let wire = serde_json::to_value(answer(&conn)).unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "available",
                "checkedAt",
                "enabled",
                "entitled",
                "error",
                "fields",
                "pending",
                "publishedAt"
            ]
        );
    }
}
