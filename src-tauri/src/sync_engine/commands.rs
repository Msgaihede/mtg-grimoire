//! The seven commands the Settings page calls.
//!
//! **Five of them are the relay and the review queue; two more arrived with the entitlement**
//! (spec §6.1 and §10) — a Connect press that answers a URL, and the claim code the reader
//! pastes back. What left in the same change is `sync_relay_set_url`: the relay is one hosted
//! service rather than one deployment per reader, so its address is
//! [`entitlement::RELAY_BASE`] and stopped being a setting. `sync_state.relay_url` survives as
//! a test/dev override with no UI, which is why nothing here writes it any more.
//!
//! **Desktop and Android only, like every other `#[tauri::command]` in the crate.** Everything
//! they orchestrate — [`super::client`], [`super::apply`], [`super::wire`], [`entitlement`] —
//! compiles for wasm; this file is the IPC surface, and the browser reaches the same functions
//! through `web::route` when it grows a panel of its own.

use crate::sync::{self, AppState};
use crate::sync_engine::client::{self, RelayOutcome};
use crate::sync_engine::entitlement;
use crate::sync_pair::{crypto, identity};
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Arc;

/// The tables that can hold a sentence for the reader, and what to call a row of each.
///
/// **Six, and the spec named two.** `needs_review` was on `collection_entries`, `deck_cards`
/// and `wishlist_entries` before this PR; user schema v29 added it to the three folder tables,
/// because §7.4's second surfaced outcome is a broken folder cycle and no folder table had
/// anywhere to say so.
///
/// `collection_entries` is the one with no name of its own — it is a printing rather than a
/// card — so it borrows one from the corpus and falls back to what is printed on the card,
/// which is the same insurance the column list is denormalised for.
const REVIEWABLE: [(&str, &str); 6] = [
    (
        "collection_entries",
        "coalesce((SELECT name FROM cards WHERE cards.id = t.card_id),
                  t.set_code || ' ' || t.collector_number)",
    ),
    ("deck_cards", "t.name"),
    ("wishlist_entries", "t.name"),
    ("collection_folders", "t.name"),
    ("deck_folders", "t.name"),
    ("wishlist_folders", "t.name"),
];

/// What the Sync panel draws about the relay.
///
/// **No `relay_url`, and its absence is the change rather than an omission.** The address is
/// [`entitlement::RELAY_BASE`], compiled in and the same for every reader, so there is nothing
/// for the panel to show and nothing for it to set; what makes sync on or off is an
/// entitlement, which [`SupporterStatus`] answers. The key stays as a test/dev override, and
/// putting it on this struct again would put a field on the Settings page that a reader can
/// only get wrong.
///
/// **No `last_error` either, and its absence is the change rather than an omission.** It read
/// the newest `error_log` row with `source = 'relay'` — a row the Errors panel already draws —
/// so the panel rendered one failure twice, in two registers, under two headings. The record is
/// untouched: `errors::record(Source::Relay, …)` still writes every relay failure, and
/// `client::lapsed` still writes none, for spec §10's reason.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub paired: bool,
    /// Ops this device has written and not yet handed over.
    pub pending: i64,
    pub last_sync_at: Option<i64>,
    /// Rows carrying a `needs_review` sentence, across all six tables that can.
    pub review_count: i64,
}

/// One row asking to be looked at.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    /// Which table it is in. The panel groups by this and the clear command needs it.
    pub table: String,
    /// The row's `sync_uid`, which is what identifies it across devices and what the clear
    /// command addresses. Never a rowid: `muted_tags` has none, and a rowid means nothing on
    /// the other machine anyway.
    pub uid: String,
    /// What to call it on screen.
    pub title: String,
    /// The sentence itself, shown verbatim. Rust wrote it; the page does not reword it.
    pub sentence: String,
}

fn read_status(conn: &Connection) -> Result<RelayStatus, String> {
    let pending: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let paired = identity::group(conn).map_err(|e| e.to_string())?.is_some();
    Ok(RelayStatus {
        paired,
        pending,
        last_sync_at: client::get_state(conn, client::LAST_SYNC_AT).and_then(|v| v.parse().ok()),
        review_count: review_count(conn)?,
    })
}

fn review_count(conn: &Connection) -> Result<i64, String> {
    let mut total = 0;
    for (table, _) in REVIEWABLE {
        let n: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE needs_review IS NOT NULL"),
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        total += n;
    }
    Ok(total)
}

fn read_review(conn: &Connection) -> Result<Vec<ReviewRow>, String> {
    let mut out = Vec::new();
    for (table, title) in REVIEWABLE {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT t.sync_uid, {title}, t.needs_review FROM {table} t
                  WHERE t.needs_review IS NOT NULL
                  ORDER BY t.rowid"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ReviewRow {
                    table: table.to_owned(),
                    uid: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    sentence: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// The membership
// ---------------------------------------------------------------------------------------

/// Where the `state` a Connect press minted is remembered.
///
/// **Nothing compares it back yet, and saying so is better than implying a check that does not
/// happen.** Patreon hands `state` to the *relay* — spec §6.1's whole point is that the redirect
/// lands there rather than on a loopback listener in this app — and what reaches this device is
/// a claim code the reader carries across by hand. So this row is this device's record of which
/// authorize request it started, and the comparison it exists for lands the day the relay
/// stamps the state into its claim page or carries it on `/claim`. Minting it now is what makes
/// that a one-line change instead of a protocol one.
///
/// **Not one of `entitlement`'s five grant keys, so `entitlement::clear` leaves it.** It is not
/// a secret, it is worthless a press later, and the next Connect overwrites it.
const PATREON_STATE: &str = "patreon_state";

/// What the supporter block draws.
///
/// **No token on it, ever.** `identity::Device` skips its public key for the same reason: a
/// secret that reaches the webview is a secret in a screenshot, and neither the access token
/// nor the refresh secret tells the panel anything it cannot get from `entitled`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupporterStatus {
    /// **This device is entitled — the relay will mint it a token.** Spec §2.5, and the field
    /// was called `connected` until then.
    ///
    /// **Renamed rather than redefined, because it now means something wider and a call site
    /// that quietly kept the old reading would compile.** "Connected" meant *this device holds a
    /// refresh secret*, which is one device's fact; entitlement is now the **group's** — any
    /// device in a group with a connected membership can mint its own token through `/token`'s
    /// group door, holding no Patreon-side secret at all. So this is that secret **or** a
    /// `SUPPORTER_STATUS` of `active`/`grace`, which is the relay having answered this device's
    /// group auth. See [`entitled`].
    pub entitled: bool,
    /// What the relay last said about the membership: `active`, `grace` or `dead`. **A device
    /// that has never connected reads `dead` as well**, which is why this field cannot be the
    /// only thing the panel keys on.
    pub status: String,
    /// When the membership started, in unix seconds; `None` for one the relay cannot date.
    pub since: Option<i64>,
    /// **Whether an entitlement was ever bound to this device's group** — a claim that
    /// succeeded, or a token `/token`'s group door minted for a device that only ever paired.
    /// ⚠️ It said "a grant pairing carried across (spec §6.2)" until 2026-08-30; pairing carries
    /// no grant now, and the group door is what replaced that route.
    ///
    /// **It is deliberately not "is this device in a group": [`RelayStatus::paired`] already
    /// answers that**, and a second field answering it again would leave spec §10's three
    /// sentences with only two signals to tell them apart. `entitled` separates supporting
    /// from not supporting; this separates the two silences:
    ///
    /// | `entitled` | `group_bound` | The sentence |
    /// | --- | --- | --- |
    /// | `true` | `true` | *Supporting since …*, or the grace line for a declined card |
    /// | `false` | **`true`** | *Membership ended*, with §7.1's reassurance that nothing local was touched |
    /// | `false` | `false` | *Not connected* |
    ///
    /// **`since` cannot do it, and that is the trap worth naming**: `entitlement::revoke` stores
    /// `("dead", None)`, so a lapsed device and a device out of the box both read `dead` with no
    /// date and no refresh secret. `entitlement::membership_ended` is what separates *those two*,
    /// and this field is it crossing the wire — **but it is no longer a reading of the panel's
    /// state on its own.** That function is `refresh_secret.is_none() && SUPPORTER_STATUS
    /// .is_some()`, and a device entitled through its *group* holds a status and no secret, so it
    /// answers `true` for a membership that has not ended at all. What keeps the panel right is
    /// the first row of the table above: `entitled` is asked first and wins. Order matters here
    /// now, where before it did not.
    pub group_bound: bool,
}

/// The whole of what the panel reads, in one pass over `sync_state`.
///
/// **Infallible on purpose.** Every part of it is a key/value lookup that answers a default
/// rather than an error, and a panel that cannot say what it is looking at is worse than one
/// saying *Not connected*.
fn supporter_status(conn: &Connection) -> SupporterStatus {
    let (status, since) = entitlement::supporter_state(conn);
    let entitled = entitled(conn);
    SupporterStatus {
        entitled,
        status,
        since,
        // The ways a group comes to be bound: this device claimed, or it minted through the
        // group door. `membership_ended` covers the third state, where it was bound and the
        // relay has since refused — and it is asked **second**, because it also answers `true`
        // for a device entitled through its group. See the field's own doc.
        group_bound: entitled || entitlement::membership_ended(conn),
    }
}

/// **Is this device entitled — will the relay mint it a token?** Spec §2.5.
///
/// Two signals, because there are now two doors on `/token`:
///
/// * **A refresh secret**, which is the device that pressed Connect. It can always mint.
/// * **A stored `active` or `grace` status**, which is the relay having answered *this device's
///   group auth*. A device that only ever paired holds no Patreon-side secret and never will;
///   what it holds instead is what the group door last told it, and that is the signal.
///
/// **`dead` is not a signal and must not be read as one.** It is also what a device that has
/// never connected reads (`entitlement::supporter_state`'s default), so treating it as "the
/// relay has spoken" would make every fresh install look entitled.
///
/// **It is what `pairing::sync_device_revoke` asks before it rotates**, which is why it is `pub`:
/// spec §2.4's fourth refusal is "a group with no membership cannot remove a device", and this is
/// the local half of that question. The relay's half is `/rotate` authenticating against an auth
/// only `/claim` can seed.
pub fn entitled(conn: &Connection) -> bool {
    if entitlement::refresh_secret(conn).is_some() {
        return true;
    }
    matches!(
        entitlement::supporter_state(conn).0.as_str(),
        "active" | "grace"
    )
}

/// Mint the `state` for one Connect press, remember it, and answer the URL to open.
///
/// Sixteen bytes of the OS CSPRNG as hex — `crypto::random_bytes`, the same source every key in
/// `sync_pair` comes from, because a `state` a third party can predict is no state at all and
/// the failure is silent: the URL still opens and the flow still completes.
fn begin_authorize(conn: &Connection) -> Result<String, String> {
    let state: String = crypto::random_bytes::<16>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    client::set_state(conn, PATREON_STATE, &state).map_err(|e| e.to_string())?;
    Ok(entitlement::authorize_url(&state))
}

/// Spec §6.3: **a device in no group makes a group of one, and only then claims against it.**
///
/// **This is the command layer's job and not `entitlement`'s**, which is what
/// [`entitlement::NO_GROUP`] exists to say: `identity::create_group` needs an `Identity`, only
/// `identity::ensure` mints one, and minting a keypair is not a side effect a network call may
/// have. Both calls here are idempotent — `ensure` returns the identity a device already has and
/// `create_group` returns the group it is already in — so the guard above them is about *reading
/// intent*, not about correctness: a device already in a group is not asked to mint anything at
/// all.
///
/// **It is not rolled back if the claim then fails, and it cannot be.** `entitlement::claim`
/// writes through `store_grant`, which opens its own transaction, so an outer transaction around
/// the pair is a `BEGIN` inside a `BEGIN` — SQLite has no such thing. That leaves two costs,
/// both accepted:
///
/// * A reader who mistypes a claim code is left in a group of one. Harmless in itself, and the
///   group is the one this device would have minted the first time it invited another.
/// * **A device in a group of one may no longer *join* somebody else's group** —
///   `pairing::complete` refuses a differing `group_id`, because joining one overwrites the key
///   this device already syncs under. (**`complete`, not `respond`**, which this said and which
///   has no group check at all: `respond` is the *inviter's* half and the joiner is the device
///   that can be holding a group it must not lose.) So the order a reader wants is *pair first,
///   then claim*, and the panel's copy is where that belongs.
///
/// Undoing it on failure would be worse than either: a claim that reached the relay may already
/// have bound this group id (§6.3 is trust-on-first-use and the binding is refused for a second
/// group), and a device that threw that group away and minted a fresh one would be locked out
/// permanently, by the very repair meant to tidy up.
fn ensure_group(conn: &Connection) -> Result<(), String> {
    if identity::group(conn).map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let me = identity::ensure(conn).map_err(|e| e.to_string())?;
    identity::create_group(conn, &me).map_err(|e| e.to_string())?;
    Ok(())
}

/// What Settings draws: the relay, what is waiting, and what wants looking at.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_relay_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RelayStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, read_status))
        .await
        .map_err(|e| e.to_string())?
}

/// What the supporter block draws: the membership, and which of §10's three sentences to say.
///
/// **A read taking the write lock, which is [`sync_relay_status`]'s shape rather than a decision
/// of its own.** Both are one press of the Settings page against a handful of `sync_state` rows,
/// so neither is worth a second connection — and taking the lock means this cannot answer from
/// beside the claim that has just written, which is the read the panel makes next.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_supporter_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SupporterStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| Ok(supporter_status(conn)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where **Connect Patreon** sends the reader.
///
/// It answers a URL and opens nothing: the page belongs to the `opener` plugin, which is
/// TypeScript's, so this command needs no permission of its own and the browser build can reach
/// the same string when it grows a panel.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_patreon_begin(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, begin_authorize))
        .await
        .map_err(|e| e.to_string())?
}

/// Trade the code the reader pasted for a grant, and answer what the panel should now say.
///
/// **On the blocking pool with a runtime of its own**, which is [`sync_now`]'s shape and taken
/// for its reason: the write connection is behind a `Mutex`, so a guard on it cannot cross an
/// `await` on a multi-threaded runtime, and `entitlement::claim` is both `async` and a write.
///
/// [`ensure_group`] runs first, so this can never answer [`entitlement::NO_GROUP`] — spec §6.3's
/// group of one is made here, before the request that has to name it.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_patreon_claim(
    state: tauri::State<'_, Arc<AppState>>,
    code: String,
) -> Result<SupporterStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        sync::with_write(&state, |conn| {
            ensure_group(conn)?;
            runtime.block_on(entitlement::claim(conn, &code))?;
            Ok(supporter_status(conn))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One round trip now.
///
/// **On the blocking pool with a runtime of its own**, and that is not ceremony. The write
/// connection is behind a `Mutex`, so a guard on it cannot cross an `await` on a multi-threaded
/// runtime; `spawn_blocking` moves the whole trip to a thread where a `block_on` is legal and
/// the guard never has to be `Send`.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_now(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<RelayOutcome>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        sync::with_write(&state, |conn| runtime.block_on(client::run_once(conn)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every row carrying a sentence, from all six tables that can hold one.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_review_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ReviewRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, read_review))
        .await
        .map_err(|e| e.to_string())?
}

/// "Looks fine": clear one row's sentence.
///
/// **A fifth command the plan does not list, and the panel it describes cannot work without
/// it.** Clearing is a write like any other, so it is captured and travels: a row one device
/// has looked at stops asking on the others too, which is the whole point of the sentence
/// being on the row rather than in a notification.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sync_review_clear(
    state: tauri::State<'_, Arc<AppState>>,
    table: String,
    uid: String,
) -> Result<Vec<ReviewRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **The table name is checked against the census and never interpolated raw.** It
        // arrives from the webview, and every other statement in this file builds its SQL by
        // `format!`.
        if !REVIEWABLE.iter().any(|(t, _)| *t == table) {
            return Err("That is not a table with anything to review.".to_owned());
        }
        sync::with_write(&state, |conn| {
            conn.execute(
                &format!("UPDATE {table} SET needs_review = NULL WHERE sync_uid = ?1"),
                [&uid],
            )
            .map_err(|e| e.to_string())?;
            read_review(conn)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::capture;
    // The claim path is one round trip, and it is driven against `httpmock` rather than a
    // deployed Worker - `entitlement`'s own rule, and the reason is that `RELAY_BASE` being
    // public does not make somebody else's uptime a fair thing to fail a test on.
    use httpmock::prelude::*;

    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        capture::install(&conn).unwrap();
        conn
    }

    #[test]
    fn every_reviewable_table_really_has_the_column() {
        let conn = db();
        for (table, _) in REVIEWABLE {
            let n: i64 = conn
                .query_row(
                    &format!(
                        "SELECT count(*) FROM pragma_table_info('{table}')
                          WHERE name = 'needs_review'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} cannot hold a sentence");
        }
    }

    /// ...and no table that *can* hold one is left off the list, which is the direction that
    /// loses a sentence rather than raising an error.
    #[test]
    fn no_table_with_the_column_is_missing_from_the_list() {
        let conn = db();
        let mut stmt = conn
            .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for table in tables {
            let has: i64 = conn
                .query_row(
                    &format!(
                        "SELECT count(*) FROM pragma_table_info('{table}')
                          WHERE name = 'needs_review'"
                    ),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if has == 1 {
                assert!(
                    REVIEWABLE.iter().any(|(t, _)| *t == table),
                    "{table} holds sentences nobody will ever be shown"
                );
            }
        }
    }

    #[test]
    fn a_supporter_status_names_the_state_and_never_the_secret() {
        // The panel draws this. A refresh secret reaching the webview is a secret in a
        // screenshot, which is the reason `Device` skips its public key too.
        let status = SupporterStatus {
            entitled: true,
            status: "grace".to_owned(),
            since: Some(1_756_000_000),
            group_bound: true,
        };
        let json = serde_json::to_string(&status).expect("serialise");

        assert!(json.contains("\"groupBound\":true"));
        // **The rename is on the wire, and this is where that is asserted.** `entitled` was
        // `connected` until spec §2.5; the page reads this JSON by field name, so a rename that
        // did not reach the serialised shape would leave `SyncPanel` drawing Connect Patreon at
        // a device that is already supporting — the exact bug the rename exists to fix.
        assert!(json.contains("\"entitled\":true"), "{json}");
        assert!(!json.contains("\"connected\""), "{json}");
        assert!(!json.contains("refresh"));
        assert!(!json.contains("access"));
    }

    /// Neither field the panel used to draw is on the wire any more.
    ///
    /// **`lastError` is asserted here because nothing else on this side can see it go.** Both
    /// literals in this module compare a *whole* `RelayStatus`, and on a fresh database the field
    /// was `None` either way — so reverting the whole change left all fifteen tests green, which
    /// is a fence that only fails for the mistake nobody makes. The absence is the claim, so the
    /// absence is what is asserted. `relayUrl` was already here for the same reason.
    #[test]
    fn a_relay_status_carries_neither_a_url_nor_a_failure_for_the_panel_to_draw() {
        // The address survives only as a test/dev override; the failure survives in `error_log`,
        // which is what the Errors panel reads and what `client::note` still writes to.
        let json = serde_json::to_string(&RelayStatus {
            paired: false,
            pending: 0,
            last_sync_at: None,
            review_count: 0,
        })
        .expect("serialise");

        assert!(!json.contains("relayUrl"));
        assert!(!json.contains("lastError"));
    }

    #[test]
    fn a_fresh_database_has_nothing_to_say_about_the_relay() {
        let conn = db();
        let status = read_status(&conn).unwrap();
        assert_eq!(
            status,
            RelayStatus {
                paired: false,
                pending: 0,
                last_sync_at: None,
                review_count: 0,
            }
        );
    }

    // -----------------------------------------------------------------------------------
    // What the supporter block reads
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_fresh_database_is_not_connected_and_has_no_membership_to_report() {
        // Spelled out as a literal rather than built from `entitlement::supporter_state`, which
        // is the function under test one layer down: an expected value taken from the
        // implementation's own source of truth moves with it and holds nothing still.
        let conn = db();

        assert_eq!(
            supporter_status(&conn),
            SupporterStatus {
                entitled: false,
                status: "dead".to_owned(),
                since: None,
                group_bound: false,
            }
        );
    }

    #[test]
    fn a_live_membership_reads_back_with_its_date() {
        let conn = db();
        entitlement::store_grant(&conn, "a1", "r1", 1_756_000_000).unwrap();
        entitlement::store_status(&conn, "active", Some(1_740_000_000)).unwrap();

        assert_eq!(
            supporter_status(&conn),
            SupporterStatus {
                entitled: true,
                status: "active".to_owned(),
                since: Some(1_740_000_000),
                group_bound: true,
            }
        );
    }

    #[test]
    fn a_lapse_and_a_device_out_of_the_box_are_two_different_silences() {
        // **Spec §10 wants three sentences and this is the pair that collapses into one.**
        // `revoke` stores ("dead", None) and clears the refresh secret, so every other field on
        // this struct agrees with a database that has never seen Patreon. `group_bound` is the
        // whole of the difference, and without it a lapsed reader is shown "Not connected" and
        // never sees §7.1's line about their own data being untouched.
        let fresh = db();
        let lapsed = db();
        entitlement::store_grant(&lapsed, "a1", "r1", 1_756_000_000).unwrap();
        entitlement::store_status(&lapsed, "active", Some(1_740_000_000)).unwrap();
        entitlement::revoke(&lapsed).unwrap();

        let fresh = supporter_status(&fresh);
        let lapsed = supporter_status(&lapsed);

        assert_eq!(fresh.entitled, lapsed.entitled, "neither is entitled");
        assert_eq!(fresh.status, lapsed.status, "both read dead");
        assert_eq!(fresh.since, lapsed.since, "neither has a date");
        assert!(!fresh.group_bound);
        assert!(lapsed.group_bound, "the one field that can tell them apart");
    }

    /// **A device entitled through its group, which is the whole of spec item 3.**
    ///
    /// It holds no refresh secret and never will — pairing does not carry one — and what it does
    /// hold is what `/token`'s group door last told it. Reading only the secret, which is what
    /// `connected` did, drew *Connect Patreon* on a second device whose group is already
    /// supporting.
    ///
    /// **`group_bound` is the half that could have gone wrong silently.**
    /// `entitlement::membership_ended` is `refresh_secret.is_none() && SUPPORTER_STATUS
    /// .is_some()`, both of which are true here, so it answers `true` for a membership that is
    /// live. The panel is right only because `entitled` is asked first.
    #[test]
    fn a_device_entitled_through_its_group_holds_no_secret_and_is_still_supporting() {
        let conn = db();
        // What the group door writes: `store_access` and `store_status`, and no refresh secret.
        entitlement::store_access(&conn, "a1", 1_756_000_000).unwrap();
        entitlement::store_status(&conn, "active", Some(1_740_000_000)).unwrap();
        assert_eq!(
            entitlement::refresh_secret(&conn),
            None,
            "the fixture is wrong"
        );

        assert_eq!(
            supporter_status(&conn),
            SupporterStatus {
                entitled: true,
                status: "active".to_owned(),
                since: Some(1_740_000_000),
                group_bound: true,
            }
        );
    }

    /// A `grace` status is entitled too, and `dead` is not — which is the reason the check is a
    /// match on two words rather than "the relay has said anything at all".
    ///
    /// **`dead` is what a device that has never connected reads**, so a signal of "a status row
    /// exists" would make every fresh install look entitled and every `Connect Patreon` button
    /// disappear on a machine that has no membership to speak of.
    #[test]
    fn a_grace_status_is_entitled_and_a_dead_one_is_not() {
        let grace = db();
        entitlement::store_status(&grace, "grace", None).unwrap();
        assert!(entitled(&grace));

        let dead = db();
        entitlement::store_status(&dead, "dead", None).unwrap();
        assert!(!entitled(&dead));

        assert!(!entitled(&db()), "a database that has never connected");
    }

    #[test]
    fn disconnecting_on_purpose_reads_as_never_connected() {
        // `clear` is the reader pressing Disconnect. Telling them their membership ended would
        // be a lie about their own action, and it is why `clear` leaves no mark where `revoke`
        // does.
        let conn = db();
        entitlement::store_grant(&conn, "a1", "r1", 1_756_000_000).unwrap();
        entitlement::store_status(&conn, "active", Some(1_740_000_000)).unwrap();

        entitlement::clear(&conn).unwrap();

        let status = supporter_status(&conn);
        assert!(!status.entitled);
        assert!(!status.group_bound);
    }

    #[test]
    fn a_grant_stored_without_its_status_is_entitled_on_the_secret_alone() {
        // **The window between `store_grant` and `store_status`, which is not one transaction.**
        // Every path that mints a grant writes the tokens first and the status second, and
        // `store_status` refuses a millisecond `since` — so a relay answering one leaves this
        // device holding a real, working grant and no `SUPPORTER_STATUS` row at all, which is
        // `supporter_state`'s "dead" default. A panel keying on `status` alone would offer
        // Connect Patreon to a device that is already syncing.
        //
        // ⚠️ This test was named for a different producer of the same state: a grant the sealed
        // pairing blob carried across (spec §6.2). **Pairing stopped carrying the refresh secret
        // on 2026-08-30** and that route is gone; the state is not, and neither is the reason the
        // panel must not key on `status`.
        let conn = db();
        entitlement::store_grant(&conn, "a1", "r1", 1_756_000_000).unwrap();

        let status = supporter_status(&conn);

        assert!(status.entitled);
        assert!(status.group_bound);
        assert_eq!(status.status, "dead", "nothing has told it otherwise yet");
    }

    // -----------------------------------------------------------------------------------
    // The Connect press
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_connect_press_mints_a_state_remembers_it_and_carries_it_in_the_url() {
        let conn = db();

        let url = begin_authorize(&conn).unwrap();

        let stored = client::get_state(&conn, PATREON_STATE).expect("the state was remembered");
        // Sixteen bytes as hex, written out rather than derived: a state shortened to nothing
        // is still a state-shaped string, and the URL still opens.
        assert_eq!(stored.len(), 32, "{stored}");
        assert!(stored.chars().all(|c| c.is_ascii_hexdigit()), "{stored}");
        assert!(url.contains(&format!("state={stored}")), "{url}");
    }

    #[test]
    fn two_presses_never_mint_the_same_state() {
        // A constant state is no state at all, and it fails silently in both directions: the
        // URL opens, Patreon consents, and the value that was supposed to bind the two halves
        // of the hop binds nothing.
        let conn = db();

        let first = begin_authorize(&conn).unwrap();
        let one = client::get_state(&conn, PATREON_STATE).unwrap();
        let second = begin_authorize(&conn).unwrap();
        let two = client::get_state(&conn, PATREON_STATE).unwrap();

        assert_ne!(one, two);
        assert_ne!(first, second);
        // And the second press is what is remembered - a stored value left at the first would
        // check the wrong request the day anything checks it.
        assert!(second.contains(&format!("state={two}")), "{second}");
    }

    // -----------------------------------------------------------------------------------
    // Spec §6.3's group of one
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_device_already_in_a_group_keeps_the_one_it_is_in() {
        // Minting a second group would overwrite the key this device already syncs under, and
        // nothing anywhere can get it back.
        let conn = db();
        let me = identity::ensure(&conn).unwrap();
        let before = identity::create_group(&conn, &me).unwrap();

        ensure_group(&conn).unwrap();

        let after = identity::group(&conn).unwrap().expect("still in a group");
        assert_eq!(after.group_id, before.group_id);
        assert_eq!(after.group_key, before.group_key);
    }

    #[tokio::test]
    async fn a_device_in_no_group_makes_one_of_its_own_before_it_claims() {
        // **The decision spec §6.3 leaves to this layer, and the only test that can see it.**
        // `entitlement::claim` refuses rather than minting a keypair inside a network call, so
        // without `ensure_group` a first claim never reaches the relay at all - the reader
        // connects Patreon, pastes a code that is one-time and ten minutes old, and is told
        // they are in no sync group.
        //
        // Matched against `entitlement::NO_GROUP` rather than against its sentence, and the
        // load-bearing half of the pair is err-then-ok: the constant's wording is not the
        // contract, the refusal is.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/claim");
            then.status(200).body(
                r#"{"access":"a1","refresh":"r1","expires":1756000000,
                    "status":"active","since":1740000000}"#,
            );
        });
        let conn = db();
        client::set_state(&conn, client::RELAY_URL, &server.base_url()).unwrap();
        assert!(identity::group(&conn).unwrap().is_none());
        assert_eq!(
            entitlement::claim(&conn, "ABCD-1234").await.unwrap_err(),
            entitlement::NO_GROUP
        );

        ensure_group(&conn).unwrap();
        entitlement::claim(&conn, "ABCD-1234").await.unwrap();

        mock.assert();
        assert!(identity::group(&conn).unwrap().is_some());
        assert_eq!(
            supporter_status(&conn),
            SupporterStatus {
                entitled: true,
                status: "active".to_owned(),
                since: Some(1_740_000_000),
                group_bound: true,
            }
        );
    }

    #[test]
    fn a_flagged_row_is_listed_with_its_sentence_and_can_be_cleared() {
        let conn = db();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,needs_review,
                 sync_uid,created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',1,?1,'u1',0,0)",
            [crate::sync_engine::apply::RESURRECTED],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_folders (name, sort_order, needs_review, sync_uid,
                                       created_at, updated_at)
             VALUES ('Binder', 0, ?1, 'u2', 0, 0)",
            [crate::sync_engine::apply::CYCLE_BROKEN],
        )
        .unwrap();

        let rows = read_review(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(read_status(&conn).unwrap().review_count, 2);
        // The collection row has no name of its own and falls back to what is on the card.
        assert_eq!(rows[0].title, "lea 1");
        assert_eq!(rows[0].sentence, crate::sync_engine::apply::RESURRECTED);
        assert_eq!(rows[1].table, "deck_folders");
        assert_eq!(rows[1].title, "Binder");

        conn.execute(
            "UPDATE collection_entries SET needs_review = NULL WHERE sync_uid = 'u1'",
            [],
        )
        .unwrap();
        assert_eq!(read_review(&conn).unwrap().len(), 1);
    }
}
