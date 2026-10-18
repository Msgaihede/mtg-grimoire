//! **The bot device**: one Durable Object's engine — its identity, its pairing, its pulls and its
//! reads — with no workerd in it, so every decision here runs in a native test.
//!
//! `glue.rs` is the workerd half: a `#[wasm_bindgen]` class over a [`Device`], and the
//! JavaScript page store. The Durable Object's script decides *when* (an RPC, an alarm); this
//! decides *what*.
//!
//! # The life of a link
//!
//! ```text
//!  (new) ──enroll──▶ joining ──advance: the desktop confirmed──▶ paired ──advance──▶ paired …
//!                       │                                          │
//!                       └─advance: expired, or the isolate lost ──▶ failed     purge ◀─ removed,
//!                          the pairing in flight                       ▲         or no token
//!                                                                      │         for 30 days
//!                                           enroll again ──────────────┘
//! ```
//!
//! * **`enroll`** runs the core's `pairing::accept` on the desktop's invite — which posts `join`
//!   and `joinsig` to the rendezvous — and answers this device's three public values, which the
//!   desktop pins (the Discord spec §13.4). It is `joining` from then on.
//! * **`advance`** is what an alarm runs. While `joining` it polls the rendezvous
//!   (`pairing::poll`) until the desktop's `offer` arrives and the core completes the join; then
//!   `paired`. While `paired` it makes one **pull trip** ([`Device::sync`]): `/keys`, a relay token
//!   through the group door, the core's paged pull, the ack — **never a push, a baseline, a join
//!   publish or a roster amendment**, which a restricted device may not make — and then a piece of
//!   the slim corpus ([`crate::corpus`]). It answers when the next alarm should be.
//! * **Capture is off.** [`capture_off`] refuses every row the core's capture triggers would put in
//!   `sync_ops` and empties that table, so nothing this device does to its own rows (its name, a
//!   launch pass) is ever an op it could send.
//!
//! # What does not survive an eviction
//!
//! **The pairing in flight.** The core keeps a pending pairing in memory and never in SQLite, on
//! purpose (`pairing.rs`'s module doc: a one-time token in fact), and its fields are private, so a
//! host cannot keep it either. A Durable Object between `enroll` and the desktop's confirm — a few
//! seconds: the desktop confirms as soon as it has read `join` and the pinned keys — is almost
//! always still in memory. One that was evicted in that window (a deploy) finds no pairing at its
//! next alarm and goes to `failed` with a sentence; the desktop's enable sees no completion, and
//! enabling again sends a fresh invite, which `enroll` accepts.

use std::sync::{Arc, Mutex, MutexGuard};

use grimoire_core::state::{State, Store};
use grimoire_core::sync_engine::client::{self, KeyOutcome};
use grimoire_core::sync_engine::entitlement;
use grimoire_core::sync_pair::invite::Invite;
use grimoire_core::sync_pair::{identity, pairing, roster};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{corpus, queries, vfs};

/// The name this device files itself under — what every device in the group lists it as.
pub const NAME: &str = "Discord";

/// `sync_state` keys, the bot's own.
const PHASE: &str = "bot_phase";
const INVITE: &str = "bot_invite";
const LAST_PULL: &str = "bot_last_pull_at";
const ERROR: &str = "bot_error";
const TOKENLESS_SINCE: &str = "bot_tokenless_since";

const JOINING: &str = "joining";
const PAIRED: &str = "paired";
const FAILED: &str = "failed";

/// How often the rendezvous is polled while joining — the desktop's own cadence.
pub const POLL_MS: i64 = 1_500;
/// The periodic pull, with nobody asking.
pub const PULL_EVERY_MS: i64 = 30 * 60 * 1000;
/// The next alarm after a trip that failed.
pub const RETRY_MS: i64 = 5 * 60 * 1000;
/// The next alarm when the corpus has more to fetch.
pub const MORE_MS: i64 = 1_000;
/// After a 429 from Scryfall.
pub const THROTTLED_MS: i64 = 60 * 1000;
/// How many `/cards/collection` requests one alarm makes ([`corpus::BATCH`] identifiers each).
pub const CORPUS_BATCHES: usize = 4;
/// How long the bot keeps the group's data when it cannot get a relay token — a membership that
/// lapsed, a group that went away: thirty days, then it deletes itself (the spec §9, *Leaving*).
pub const TOKENLESS_PURGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The user database's name within a mount — `grimoire_core::db::USER_DB`.
const USER_DB: &str = grimoire_core::db::USER_DB;

/// What a key that does not open the stored pages says.
pub const WRONG_KEK: &str = "BOT_KEK does not open this bot's storage: the secret was changed \
                             since the bot was paired. Put the old one back, or unlink and \
                             pair again.";

/// What a pairing lost to an eviction says.
pub const INTERRUPTED: &str = "The pairing was interrupted before the desktop confirmed it. \
                               Switch Discord off and on again in Settings to start over.";
/// What an expired pairing says.
pub const EXPIRED: &str = "The pairing code expired before the desktop confirmed it. Switch \
                           Discord off and on again in Settings to start over.";

/// What a host may set about a device: where Scryfall and the relay are. Production leaves both
/// unset; a local smoke points them at local servers.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub relay_url: Option<String>,
    pub scryfall_url: Option<String>,
}

/// `enroll`'s answer, in the Discord front's own shape (`infrastructure/discord-worker/src/
/// rpc.ts`'s `Enrolled | EnrollRefused`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Enrolled {
    Joined {
        ok: bool,
        #[serde(rename = "deviceId")]
        device_id: String,
        x25519: String,
        ed25519: String,
    },
    Refused {
        ok: bool,
        code: &'static str,
        error: String,
    },
}

impl Enrolled {
    fn refused(code: &'static str, error: impl Into<String>) -> Enrolled {
        Enrolled::Refused {
            ok: false,
            code,
            error: error.into(),
        }
    }
}

/// `status()`'s answer — `rpc.ts`'s `BotStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enrolled: bool,
    pub device_id: Option<String>,
    pub paired: bool,
    pub last_pull_at: Option<i64>,
    pub error: Option<String>,
}

/// What an alarm did, and what the Durable Object should do next.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advanced {
    /// Milliseconds until the next alarm, or `None` for none.
    pub next_in_ms: Option<i64>,
    /// **Delete everything**: the device was removed from its group, or has had no relay token
    /// for [`TOKENLESS_PURGE_MS`]. The script closes the device and runs `deleteAll()`.
    pub purge: bool,
    /// What happened, in a word, for the log: `idle`, `waiting`, `paired`, `pulled`, `failed`,
    /// `removed`, `lapsed`.
    pub did: &'static str,
}

/// One Durable Object's engine.
pub struct Device {
    /// `Some` until the device drops: taken first there, so the connection closes before the
    /// mount goes.
    state: Option<Arc<State>>,
    mount: String,
    options: Options,
    /// The pairing in flight, between `enroll` and its completion — memory only (module doc).
    pending: Mutex<Option<pairing::Pending>>,
    /// Set while an `enroll` or an `advance` is running, so a second waits its turn — an RPC can
    /// arrive while an alarm is awaiting the relay.
    busy: Mutex<bool>,
}

/// Held while an operation runs.
struct Turn<'a>(&'a Mutex<bool>);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }
}

fn hash(text: &str) -> String {
    Sha256::digest(text.trim().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn get(conn: &Connection, key: &str) -> Option<String> {
    client::get_state(conn, key).filter(|v| !v.is_empty())
}

fn set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    client::set_state(conn, key, value).map_err(|e| e.to_string())
}

fn clear(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM sync_state WHERE key = ?1", [key])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// **Capture off**: every op this device's own writes would record is refused as it is written —
/// a `TEMP` trigger on the connection, `BEFORE INSERT ON sync_ops`, that `RAISE(IGNORE)`s the row
/// — and whatever an earlier open recorded is emptied.
///
/// **The core's capture triggers stay installed**, because they do more than record: the insert
/// trigger is also what mints a row's `sync_uid` (`capture::insert_trigger`), and a row with none
/// breaks every later read that names it — measured under workerd, the first pull after the bot
/// had filed its own name failed `Invalid column type Null … sync_uid`. `RAISE(IGNORE)` in a
/// `BEFORE` trigger abandons that one `INSERT` and lets the trigger that issued it go on, so the
/// uid is minted and no op is kept. `sync_ops` holds nothing but this device's own outbox and
/// history, so an empty one is a device that never wrote, which is what a read-only bot is.
pub fn capture_off(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TEMP TRIGGER IF NOT EXISTS bot_capture_off BEFORE INSERT ON main.sync_ops
         BEGIN SELECT RAISE(IGNORE); END;
         DELETE FROM sync_ops;",
    )
    .map_err(|e| e.to_string())
}

impl Device {
    /// **Open the device over `store`**: mount it, open the two databases at head through the page
    /// store, build the state, switch capture off, and make sure of an identity named [`NAME`].
    ///
    /// `object` is the Durable Object's id — the mount's name and the page key's salt. `kek` is the
    /// `BOT_KEK` secret's 32 bytes.
    pub fn open(
        object: &str,
        store: Arc<dyn vfs::PageStore>,
        kek: &[u8; 32],
        options: Options,
    ) -> Result<Device, String> {
        let mount = object.to_owned();
        let cipher = vfs::PageCipher::new(kek, object);
        // **The key, asked first**: a page that will not open reaches SQLite as an I/O error and
        // comes back as "disk I/O error", which names nothing. The user file's first page,
        // when there is one, says in this crate's own words that the key is not this storage's.
        if let Some(first) = store.read(USER_DB, 0)? {
            if cipher.open(USER_DB, 0, &first).is_err() {
                return Err(WRONG_KEK.to_owned());
            }
        }
        vfs::mount(&mount, store, cipher)?;
        let data_dir = std::path::PathBuf::from(format!("BOT:/{mount}"));
        let opened =
            match grimoire_core::launch::open_single(std::path::Path::new(&mount), &data_dir) {
                Ok(opened) => opened,
                Err(e) => {
                    vfs::unmount(&mount);
                    return Err(e);
                }
            };
        let prepared = (|| -> Result<(), String> {
            capture_off(&opened.write)?;
            corpus::prepare(&opened.write)?;
            let me = identity::ensure(&opened.write).map_err(|e| e.to_string())?;
            if me.name != NAME {
                identity::rename_device(&opened.write, &me.device_id, NAME)
                    .map_err(|e| e.to_string())?;
            }
            match options.relay_url.as_deref().map(str::trim) {
                Some(url) if !url.is_empty() => set(&opened.write, client::RELAY_URL, url)?,
                _ => clear(&opened.write, client::RELAY_URL)?,
            }
            Ok(())
        })();
        if let Err(e) = prepared {
            drop(opened);
            vfs::unmount(&mount);
            return Err(e);
        }
        let state = Arc::new(State::new(
            opened.write,
            None,
            data_dir,
            grimoire_core::events::silent(),
            Vec::new(),
            opened.client,
            opened.images,
        ));
        Ok(Device {
            state: Some(state),
            mount,
            options,
            pending: Mutex::new(None),
            busy: Mutex::new(false),
        })
    }

    fn state(&self) -> &State {
        self.state
            .as_ref()
            .expect("the state lives as long as the device")
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        grimoire_core::db::lock_plain(&self.state().db)
    }

    /// One operation at a time; `None` when another is running.
    fn turn(&self) -> Option<Turn<'_>> {
        let mut busy = self.busy.lock().unwrap_or_else(|p| p.into_inner());
        if *busy {
            return None;
        }
        *busy = true;
        Some(Turn(&self.busy))
    }

    fn phase(&self) -> Option<String> {
        get(&self.conn(), PHASE)
    }

    fn note_error(&self, error: Option<&str>) {
        let conn = self.conn();
        let _ = match error {
            Some(e) => set(&conn, ERROR, e),
            None => clear(&conn, ERROR),
        };
    }

    /// **`enroll(invite, capability)`** — join the desktop's group through its invite.
    pub async fn enroll(&self, invite: &str, capability: &str) -> Enrolled {
        if capability != roster::READ {
            return Enrolled::refused("bad_invite", "The Discord bot can only be paired to read.");
        }
        let Some(_turn) = self.turn() else {
            return Enrolled::refused(
                "pairing_failed",
                "The bot is busy with another step; try again in a moment.",
            );
        };
        let phase = self.phase();
        if phase.as_deref() == Some(PAIRED) {
            return Enrolled::refused(
                "already_enrolled",
                "This Discord link already has a bot paired to a group.",
            );
        }
        if let Err(e) = Invite::decode(invite) {
            return Enrolled::refused("bad_invite", format!("That invite is not readable: {e}"));
        }
        let fingerprint = hash(invite);
        let same = get(&self.conn(), INVITE).as_deref() == Some(fingerprint.as_str());
        let in_flight = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        if !(phase.as_deref() == Some(JOINING) && same && in_flight) {
            // A fresh accept: a new invite, or the first, or one whose pairing this isolate lost.
            let mut pending = None;
            let accepted = {
                let lane = self.state().lane().await;
                pairing::accept(&lane, &mut pending, invite).await
            };
            if let Err(e) = accepted {
                return Enrolled::refused("pairing_failed", e);
            }
            *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = pending;
            let conn = self.conn();
            let written = set(&conn, PHASE, JOINING)
                .and_then(|_| set(&conn, INVITE, &fingerprint))
                .and_then(|_| clear(&conn, ERROR));
            if let Err(e) = written {
                return Enrolled::refused("pairing_failed", e);
            }
        }
        match self.keys() {
            Ok((device_id, x25519, ed25519)) => Enrolled::Joined {
                ok: true,
                device_id,
                x25519,
                ed25519,
            },
            Err(e) => Enrolled::refused("pairing_failed", e),
        }
    }

    /// This device's id and its two public keys, base64url without padding.
    fn keys(&self) -> Result<(String, String, String), String> {
        let conn = self.conn();
        let me = identity::ensure(&conn).map_err(|e| e.to_string())?;
        Ok((
            me.device_id,
            roster::key_text(&me.keypair.public),
            roster::key_text(&me.signing.public),
        ))
    }

    /// **What an alarm runs** — see the module doc. `now_ms` is the wall clock (frozen across an
    /// execution in workerd, which nothing here minds).
    pub async fn advance(&self, now_ms: i64) -> Advanced {
        let Some(_turn) = self.turn() else {
            return Advanced {
                next_in_ms: Some(POLL_MS),
                purge: false,
                did: "busy",
            };
        };
        match self.phase().as_deref() {
            Some(JOINING) => self.join(now_ms).await,
            Some(PAIRED) => self.sync(now_ms).await,
            _ => Advanced {
                next_in_ms: None,
                purge: false,
                did: "idle",
            },
        }
    }

    async fn join(&self, now_ms: i64) -> Advanced {
        let taken = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let Some(pending) = taken else {
            return self.fail(INTERRUPTED);
        };
        let mut pending = Some(pending);
        let polled = {
            let lane = self.state().lane().await;
            pairing::poll(&lane, &mut pending, now_ms).await
        };
        match polled {
            Ok(progress) if progress.stage == "complete" => {
                {
                    let conn = self.conn();
                    let _ = set(&conn, PHASE, PAIRED);
                    let _ = clear(&conn, ERROR);
                }
                Advanced {
                    next_in_ms: Some(0),
                    purge: false,
                    did: "paired",
                }
            }
            Ok(progress) if progress.stage == "expired" || progress.stage == "idle" => {
                self.fail(EXPIRED)
            }
            Ok(_) => {
                *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = pending;
                Advanced {
                    next_in_ms: Some(POLL_MS),
                    purge: false,
                    did: "waiting",
                }
            }
            Err(e) => {
                // Kept: a relay that did not answer this once may answer the next poll, and the
                // core's own expiry ends the attempt when it will not.
                *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = pending;
                self.note_error(Some(&e));
                Advanced {
                    next_in_ms: Some(POLL_MS * 2),
                    purge: false,
                    did: "waiting",
                }
            }
        }
    }

    fn fail(&self, why: &str) -> Advanced {
        {
            let conn = self.conn();
            let _ = set(&conn, PHASE, FAILED);
            let _ = set(&conn, ERROR, why);
        }
        Advanced {
            next_in_ms: None,
            purge: false,
            did: "failed",
        }
    }

    /// The token went missing (or never came) at `now_ms`: the purge, once that has lasted.
    fn tokenless(&self, now_ms: i64, why: &str) -> Advanced {
        let since = {
            let conn = self.conn();
            let since = get(&conn, TOKENLESS_SINCE)
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(now_ms);
            let _ = set(&conn, TOKENLESS_SINCE, &since.to_string());
            let _ = set(&conn, ERROR, why);
            since
        };
        if now_ms - since >= TOKENLESS_PURGE_MS {
            return Advanced {
                next_in_ms: None,
                purge: true,
                did: "lapsed",
            };
        }
        Advanced {
            next_in_ms: Some(RETRY_MS),
            purge: false,
            did: "failed",
        }
    }

    /// **One pull trip, and a piece of the corpus.**
    async fn sync(&self, now_ms: i64) -> Advanced {
        let lane = self.state().lane().await;
        let mut keys = match client::check_keys(&lane).await {
            Ok(keys) => keys,
            Err(e) => return self.tokenless(now_ms, &e),
        };
        if keys.outcome == KeyOutcome::Removed {
            return Advanced {
                next_in_ms: None,
                purge: true,
                did: "removed",
            };
        }
        let mut token = entitlement::access_token(&lane).await;
        if matches!(&token, Err(e) if e == entitlement::STALE_GROUP_AUTH) {
            // A rotation this device has not adopted yet — the core's own trip does the same.
            keys = match client::check_keys(&lane).await {
                Ok(keys) => keys,
                Err(e) => return self.tokenless(now_ms, &e),
            };
            if keys.outcome == KeyOutcome::Removed {
                return Advanced {
                    next_in_ms: None,
                    purge: true,
                    did: "removed",
                };
            }
            token = entitlement::access_token(&lane).await;
        }
        let token =
            match token {
                Ok(Some(token)) => token,
                Ok(None) => return self.tokenless(
                    now_ms,
                    "The relay did not grant this group a token: its membership may have ended.",
                ),
                Err(e) => return self.tokenless(now_ms, &e),
            };
        let base = lane.with(|conn| {
            let _ = clear(conn, TOKENLESS_SINCE);
            Ok(entitlement::base(conn))
        });
        let base = match base {
            Ok(base) => base,
            Err(e) => return self.retry(&e),
        };
        if let Err(e) = client::pull(&lane, &base, &token, keys.relay_epoch).await {
            // What the pull took before it failed is acked, as the core's own trip does.
            let _ = client::ack(&lane, &base, &token).await;
            return self.retry(&e);
        }
        if let Err(e) = client::ack(&lane, &base, &token).await {
            return self.retry(&e);
        }
        let _ = lane.with(|conn| {
            set(conn, LAST_PULL, &now_ms.to_string())?;
            clear(conn, ERROR)
        });
        let scryfall = self
            .options
            .scryfall_url
            .clone()
            .unwrap_or_else(|| corpus::SCRYFALL_API.to_owned());
        let filled = corpus::fill(
            &lane,
            &corpus::client(),
            scryfall.trim_end_matches('/'),
            CORPUS_BATCHES,
            now_ms / 1000,
        )
        .await;
        let next = match filled {
            Ok(f) if f.throttled => THROTTLED_MS,
            Ok(f) if f.more => MORE_MS,
            Ok(_) => PULL_EVERY_MS,
            Err(e) => {
                let _ = lane.with(|conn| set(conn, ERROR, &e));
                RETRY_MS
            }
        };
        Advanced {
            next_in_ms: Some(next),
            purge: false,
            did: "pulled",
        }
    }

    fn retry(&self, why: &str) -> Advanced {
        self.note_error(Some(why));
        Advanced {
            next_in_ms: Some(RETRY_MS),
            purge: false,
            did: "failed",
        }
    }

    /// **`status()`** — what the device says of itself.
    pub fn status(&self) -> Status {
        let conn = self.conn();
        let phase = get(&conn, PHASE);
        let enrolled = matches!(phase.as_deref(), Some(JOINING) | Some(PAIRED));
        let device_id = if enrolled {
            identity::public_identity(&conn)
                .ok()
                .flatten()
                .map(|(id, _)| id)
        } else {
            None
        };
        Status {
            enrolled,
            device_id,
            paired: phase.as_deref() == Some(PAIRED),
            last_pull_at: get(&conn, LAST_PULL).and_then(|v| v.parse().ok()),
            error: get(&conn, ERROR),
        }
    }

    pub fn collection_by_name(&self, name: &str) -> Result<Option<queries::Holding>, String> {
        queries::collection_by_name(&self.conn(), name)
    }

    pub fn wishlist_by_name(&self, name: &str) -> Result<Option<queries::Holding>, String> {
        queries::wishlist_by_name(&self.conn(), name)
    }

    pub fn names(
        &self,
        kind: &str,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<queries::Choice>, String> {
        let kind = queries::Kind::parse(kind).ok_or_else(|| format!("no list is called {kind}"))?;
        queries::names(&self.conn(), kind, prefix, limit)
    }

    pub fn decks(&self, prefix: &str) -> Result<Vec<queries::DeckSummary>, String> {
        queries::decks(&self.conn(), prefix)
    }

    pub fn deck_cards(&self, uid: &str) -> Result<Option<queries::DeckList>, String> {
        queries::deck_cards(&self.conn(), uid)
    }

    /// The connection, for a test that seeds rows the way a pull would have.
    #[cfg(test)]
    pub(crate) fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        f(&self.conn())
    }
}

impl Drop for Device {
    /// The connection closes with the state (when this is its last holder), then the mount goes.
    fn drop(&mut self) {
        self.state.take();
        vfs::unmount(&self.mount);
    }
}

/// `BOT_KEK` as the secret holds it — 32 bytes, base64url (padded or not) — or a sentence.
pub fn kek(text: &str) -> Result<[u8; 32], String> {
    use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
    use base64::Engine as _;
    let text = text.trim();
    let bytes = URL_SAFE_NO_PAD
        .decode(text.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(text))
        .map_err(|_| "BOT_KEK is not base64url".to_owned())?;
    <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| format!("BOT_KEK must be 32 bytes, and it is {}", bytes.len()))
}

#[cfg(test)]
mod tests;
