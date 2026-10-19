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
//!   `paired`. While `paired` it makes one **trip** ([`Device::sync`]): `/keys`, a relay token
//!   through the group door, **the push of whatever a reader confirmed** (`client::push_restricted`,
//!   only for an `add` device with something in its outbox), the core's paged pull, the ack —
//!   **never a baseline, a join publish or a roster amendment**, which a restricted device may not
//!   make — and then a piece of the slim corpus ([`crate::corpus`]). It answers when the next alarm
//!   should be.
//! * **Capture is off.** [`capture_off`] refuses every row the core's capture triggers would put in
//!   `sync_ops`, so nothing this device does to its own rows (its name, a pull, a launch pass) is
//!   ever an op it could send. **The one way into the outbox is [`Device::add`]**: a reader's
//!   Confirm in Discord, through `integration::add::emit` (the Discord spec §14.3), which builds
//!   exactly the op every receiver's allow-list takes.
//!
//! # Adding (the Discord spec §14.4)
//!
//! [`Device::target`] is asked when a command arrives — where the add goes (a named folder, or the
//! default *Added from Discord*), and whether today's quota is spent — and [`Device::add`] when the
//! reader presses Confirm, which asks both again and emits. Neither reaches the network: the
//! push is the next alarm's, which the Durable Object sets a second away. A relay that answers
//! the push with its daily quota is remembered by the core for the UTC day
//! (`client::RESTRICTED_QUOTA_AT`), so the next command is told [`QUOTA`] in words instead of
//! queueing an add that cannot leave until tomorrow.
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

use grimoire_core::integration::add as adding;
use grimoire_core::state::{self as core_state, Lane, State, Store};
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

/// An add with no folder named, when *Added from Discord* is not there (the Discord spec §14.4).
pub const NO_DEFAULT_FOLDER: &str = "Name a folder, or switch Discord off and on in Settings to \
                                     bring back Added from Discord.";
/// A folder that is a deck's or the removed cards' — every receiver would refuse the add (§14.2).
pub const NOT_A_USER_FOLDER: &str = "Discord can add only to your own folders, not to a deck's or \
                                     to the removed cards. Pick another folder.";
/// A folder typed by hand that names none.
pub const NO_SUCH_FOLDER: &str = "None of your folders is called that. Pick one from the list.";
/// A folder that went away between the command and the Confirm.
pub const FOLDER_GONE: &str = "That folder is no longer in your collection. Run the command \
                               again and pick another.";
/// The relay's daily quota for a restricted device, spent (§14.4).
pub const QUOTA: &str = "Discord has added as much as it may today; try again tomorrow.";

/// A UTC day, as the relay counts its quota (`infrastructure/relay/src/admit.ts`'s `quotaDay`).
pub fn quota_day(now_ms: i64) -> i64 {
    now_ms.div_euclid(86_400_000)
}

/// Where an add goes: a collection folder's uid and path — or, for a wish, `None` for both (the
/// wishlist's root, the only place §14.4's `/wishlist add` files a wish).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub uid: Option<String>,
    pub path: Option<String>,
}

/// Why an add did not go: a sentence for the reader ([`Refusal::Said`]), or a failure whose words
/// are the engine's and go nowhere ([`Refusal::Failed`]; the Durable Object says its own fixed
/// sentence instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Said(String),
    Failed(String),
}

impl Refusal {
    fn said(text: &str) -> Refusal {
        Refusal::Said(text.to_owned())
    }
}

/// How many ops wait in this device's outbox.
fn outbox(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Whether the relay refused a push for its quota earlier on `now_ms`'s UTC day — the core's
/// `client::RESTRICTED_QUOTA_AT` (unix seconds), which `push_restricted` sets on a
/// `429 restricted_quota` and clears when a push lands.
fn quota_spent(conn: &Connection, now_ms: i64) -> bool {
    get(conn, client::RESTRICTED_QUOTA_AT)
        .and_then(|v| v.parse::<i64>().ok())
        .is_some_and(|secs| quota_day(secs.saturating_mul(1000)) == quota_day(now_ms))
}

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
/// — **except while `integration::add::EMITTING` is set**, which `integration::add::emit` holds
/// for the length of its one outbox `INSERT` and never commits. The trigger is the core's
/// (`integration::add::CAPTURE_OFF`), so the key and the `WHEN` that reads it are one file's.
/// Nothing is emptied: what `sync_ops` holds on this device is its adds, pushed or still to push.
///
/// **The core's capture triggers stay installed**, because they do more than record: the insert
/// trigger is also what mints a row's `sync_uid` (`capture::insert_trigger`), and a row with none
/// breaks every later read that names it — measured under workerd, the first pull after the bot
/// had filed its own name failed `Invalid column type Null … sync_uid`. `RAISE(IGNORE)` in a
/// `BEFORE` trigger abandons that one `INSERT` and lets the trigger that issued it go on, so the
/// uid is minted and no op is kept.
pub fn capture_off(conn: &Connection) -> Result<(), String> {
    adding::capture_off(conn).map_err(|e| e.to_string())
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
    ///
    /// `capability` is `add` and nothing else (the Discord spec §14.1): the desktop pairs the bot
    /// as `add`, and `read` is a word every build understands that nothing pairs with any more.
    pub async fn enroll(&self, invite: &str, capability: &str) -> Enrolled {
        if capability != roster::ADD {
            return Enrolled::refused("bad_invite", "The Discord bot can only be paired to add.");
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
        // **What a reader confirmed goes first**, so it reaches the group on this trip and a
        // pull's own failure cannot hold it back. A push that fails is said after the pull.
        let pushed = self.push(&lane, now_ms).await;
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
            match &pushed {
                Err(e) => set(conn, ERROR, e),
                Ok(_) => clear(conn, ERROR),
            }
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
            // More confirmed than one envelope carries: the rest on the next trip, soon.
            Ok(_) if matches!(pushed, Ok(true)) => MORE_MS,
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

    /// **The push** — one envelope of the outbox, when this device is an `add` device with
    /// something waiting and today's quota is not known to be spent. `Ok(true)` when more is left
    /// to send; `Err` is a sentence for the status, and the outbox is kept.
    ///
    /// A relay's `429 restricted_quota` is `push_restricted`'s `Ok(0)`, with
    /// `client::RESTRICTED_QUOTA_AT` set: neither a command nor this trip asks again before
    /// midnight UTC ([`quota_spent`]).
    async fn push(&self, lane: &Lane<'_>, now_ms: i64) -> Result<bool, String> {
        let (capability, waiting, spent) = lane.with(|conn| {
            Ok((
                roster::self_capability(conn).map_err(|e| e.to_string())?,
                outbox(conn)?,
                quota_spent(conn, now_ms),
            ))
        })?;
        if capability.as_deref() != Some(roster::ADD) || waiting == 0 || spent {
            return Ok(false);
        }
        let pushed = client::push_restricted(lane).await?;
        // More waiting after an envelope that landed: the next trip soon. Nothing landed (the
        // quota, the group's log full, no token): the next trip as usual.
        Ok(pushed > 0 && lane.with(outbox)? > 0)
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

    /// **An add's `folder` completion** — [`queries::folders`].
    pub fn folders(&self, prefix: &str, limit: usize) -> Result<Vec<queries::Choice>, String> {
        queries::folders(&self.conn(), prefix, limit)
    }

    /// **Where an add to `table` goes**, asked when the command arrives (the Discord spec §14.4):
    /// for the collection, the folder `folder` names (a uid from the completion, or a path typed
    /// by hand) or, when it is empty, `integration::add::default_folder`; for the wishlist, its
    /// root. Refused in a sentence for a default folder that is gone, a folder that is no user
    /// folder or none at all, and the day's quota.
    pub fn target(&self, table: &str, folder: &str, now_ms: i64) -> Result<Target, Refusal> {
        let conn = self.conn();
        if quota_spent(&conn, now_ms) {
            return Err(Refusal::said(QUOTA));
        }
        match table {
            "wishlist" => Ok(Target {
                uid: None,
                path: None,
            }),
            "collection" => {
                let named = if folder.trim().is_empty() {
                    let uid = adding::default_folder(&conn)
                        .map_err(|e| Refusal::Failed(e.to_string()))?
                        .ok_or_else(|| Refusal::said(NO_DEFAULT_FOLDER))?;
                    queries::folder(&conn, &uid)
                        .map_err(Refusal::Failed)?
                        .ok_or_else(|| Refusal::said(NO_DEFAULT_FOLDER))?
                } else {
                    queries::folder(&conn, folder)
                        .map_err(Refusal::Failed)?
                        .ok_or_else(|| Refusal::said(NO_SUCH_FOLDER))?
                };
                if named.kind != "user" {
                    return Err(Refusal::said(NOT_A_USER_FOLDER));
                }
                Ok(Target {
                    uid: Some(named.uid),
                    path: Some(named.path),
                })
            }
            other => Err(Refusal::Failed(format!("no list is called {other}"))),
        }
    }

    /// **A reader's Confirm** — `add` is `integration::add::Add` as the Durable Object kept it.
    /// The quota and the folder are asked again (either can have changed in fifteen minutes),
    /// then the core's `emit` writes the one op to the outbox and applies it here, inside a
    /// user-facing write. Answers the row's `sync_uid`. **No network**: the push is the next
    /// alarm's.
    pub fn add(&self, add: &str, now_ms: i64) -> Result<String, Refusal> {
        let add: adding::Add = serde_json::from_str(add)
            .map_err(|e| Refusal::Failed(format!("the add is not readable: {e}")))?;
        {
            let conn = self.conn();
            if quota_spent(&conn, now_ms) {
                return Err(Refusal::said(QUOTA));
            }
            if let adding::Add::Collection(entry) = &add {
                let folder = queries::folder(&conn, &entry.folder_uid)
                    .map_err(Refusal::Failed)?
                    .filter(|f| f.uid == entry.folder_uid)
                    .ok_or_else(|| Refusal::said(FOLDER_GONE))?;
                if folder.kind != "user" {
                    return Err(Refusal::said(NOT_A_USER_FOLDER));
                }
            }
        }
        core_state::with_write(self.state(), |conn| adding::emit(conn, &add))
            .map_err(Refusal::Failed)
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
