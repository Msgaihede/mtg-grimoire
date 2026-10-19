//! What the six commands do, apart from Tauri: the PKCE link, the switch-on and the switch-off.
//!
//! **The switch-on and the switch-off are written over three seams** — [`Ceremony`] (the engine's
//! pairing), [`Front`] (the Worker's enroll and unlink) and [`Remover`] (the engine's removal) —
//! so their order, their rollback and what each failure leaves behind are tested with fakes; the
//! engine's half is `grimoire_core::integration`'s own suite, against a relay, end to end.

use super::front::{self, Claim, Enrolled};
use super::local;
use crate::errors::{self, Kind, Source};
use crate::sync_pair::identity;
use crate::sync_pair::pairing::{self, Pending, Pinned, PinnedJoin};
use grimoire_core::integration::add;
use grimoire_core::state::Store;
use grimoire_core::sync_pair::{crypto, roster};
use sha2::{Digest, Sha256};
use std::time::Duration;

// ---------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------

/// Switch-on pressed with no account linked.
pub const LINK_FIRST: &str = "Link your Discord account first.";

/// Switch-on pressed with the bot already in this group.
pub const ALREADY_ON: &str = "Discord is already switched on.";

/// The bot enrolled, but its join never reached the rendezvous inside [`JOIN_WAIT`].
pub const JOIN_TIMED_OUT: &str = "The Discord bot did not answer in time.";

/// The service answered keys that are not keys.
pub const BAD_KEYS: &str = "Discord's service answered keys this device could not read.";

/// A pairing step failed in a way the reader has no sentence for — recorded, never shown.
pub const ENABLE_FAILED: &str =
    "Discord could not be added to your sync group. Try again in a moment.";

/// Said after any failure that came once the bot had enrolled: the link was undone, so the
/// service holds no half-joined bot, and a fresh link starts clean.
pub const UNDONE: &str = "Link Discord again to try once more.";

/// The switch-off could not take the bot out of the group. Everything else was still done: the
/// service was told to delete the bot (which takes its keys with it), and this device forgot it.
pub fn still_listed(name: &str) -> String {
    format!(
        "Discord was switched off, but \"{name}\" is still listed in your sync group. Remove it \
         from the list of devices in Settings."
    )
}

/// The switch-off could not reach the service to delete the bot (`502 bot_unavailable`, or no
/// answer at all). The front then keeps the link row, so this device keeps the link too — the
/// secret is the only way to ask again — and forgets the bot.
pub const NOT_TOLD: &str = "Discord's service could not be reached to delete the bot, so this \
     device is still linked. Switch Discord off again in a moment.";

/// How long the switch-on waits for the bot's join at the rendezvous, and how often it looks.
pub const JOIN_WAIT: Duration = Duration::from_secs(60);
const JOIN_POLL: Duration = Duration::from_millis(1500);

/// Engine sentences a reader may be shown as they are: written for a reader, and naming nothing
/// they cannot act on. Anything else the pairing says is recorded and answered [`ENABLE_FAILED`].
const READER_SENTENCES: &[&str] = &[
    pairing::PIN_MISMATCH,
    pairing::PIN_NOT_RESTRICTED,
    pairing::JOINER_TOO_OLD,
    pairing::NO_SIGNATURE_SLOTS,
    identity::GROUP_IS_FULL,
    identity::NOT_IN_A_GROUP,
    crate::sync_engine::client::RENDEZVOUS_TAKEN,
    grimoire_core::db::BUSY,
];

fn for_a_reader(store: &impl Store, operation: &str, said: String) -> String {
    if READER_SENTENCES.contains(&said.as_str()) {
        return said;
    }
    let _ = store.with(|conn| {
        errors::record(conn, Source::Relay, operation, Kind::Other, &said, None);
        Ok(())
    });
    ENABLE_FAILED.to_owned()
}

// ---------------------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------------------

/// The PKCE pair: a verifier of 32 random bytes and its challenge, both base64url without padding.
pub fn pkce() -> (String, String) {
    let verifier = roster::key_text(&crypto::random_bytes::<32>());
    let challenge = roster::key_text(&Sha256::digest(verifier.as_bytes()).into());
    (verifier, challenge)
}

/// Begin a link: `POST /link/begin`, then keep the code, the verifier and the expiry. A second
/// begin replaces the first.
pub async fn link_begin(store: &impl Store) -> Result<front::Begun, String> {
    let (verifier, challenge) = pkce();
    let begun = front::begin(store, &challenge).await?;
    store.with(|conn| {
        local::store_linking(
            conn,
            &local::Linking {
                code: begun.code.clone(),
                verifier,
                expires_at: begun.expires_at,
            },
        )
    })?;
    Ok(begun)
}

/// One poll of a link in flight — nothing to do when none is. A link that has expired here, or
/// that the front ended, is forgotten and answered as its sentence; a request that failed leaves
/// it in flight for the next poll.
pub async fn link_poll(store: &impl Store, now_ms: i64) -> Result<(), String> {
    let Some(linking) = store.with(|conn| Ok(local::linking(conn)))? else {
        return Ok(());
    };
    if now_ms > linking.expires_at {
        store.with(local::forget_linking)?;
        return Err(front::LINK_EXPIRED.to_owned());
    }
    match front::claim(store, &linking.code, &linking.verifier).await? {
        Claim::Pending => Ok(()),
        Claim::Linked {
            secret,
            discord_user_id,
            username,
        } => store.with(|conn| local::store_link(conn, &secret, &discord_user_id, &username)),
        Claim::Ended(sentence) => {
            store.with(local::forget_linking)?;
            Err(sentence.to_owned())
        }
    }
}

// ---------------------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------------------

/// The engine's half of a switch-on.
#[allow(async_fn_in_trait)]
pub trait Ceremony {
    /// `integration::gate`: `Err` with its sentence.
    fn gate(&mut self) -> Result<(), String>;
    /// `pairing::begin_integration`: the invite.
    fn begin(&mut self) -> Result<String, String>;
    /// Poll the rendezvous until the joiner has answered.
    async fn joined(&mut self) -> Result<(), String>;
    /// `pairing::confirm_pinned`.
    async fn confirm(&mut self, pinned: Pinned) -> Result<PinnedJoin, String>;
}

/// The front, for a linked account.
#[allow(async_fn_in_trait)]
pub trait Front {
    async fn enroll(&self, invite: &str) -> Result<Enrolled, String>;
    async fn unlink(&self) -> Result<(), String>;
}

/// The engine's removal.
#[allow(async_fn_in_trait)]
pub trait Remover {
    async fn remove(&self, device: &str) -> Result<(), String>;
}

/// The real [`Ceremony`]: the pairing over `store`, with its pending offer held here — **never in
/// `State::pairing`**, so a reader's own pairing panel neither sees nor disturbs it.
pub struct Engine<'a, S: Store> {
    pub store: &'a S,
    pub pending: Option<Pending>,
    pub wait: Duration,
}

impl<S: Store> Ceremony for Engine<'_, S> {
    fn gate(&mut self) -> Result<(), String> {
        match self
            .store
            .with(|conn| Ok(grimoire_core::integration::gate(conn)))?
        {
            grimoire_core::integration::Gate::Ready => Ok(()),
            grimoire_core::integration::Gate::Refused(why) => Err(why),
        }
    }

    fn begin(&mut self) -> Result<String, String> {
        let pending = &mut self.pending;
        self.store
            .with(|conn| pairing::begin_integration(conn, pending))
            .map(|offer| offer.code)
            .map_err(|e| for_a_reader(self.store, "discord_enable", e))
    }

    async fn joined(&mut self) -> Result<(), String> {
        let started = std::time::Instant::now();
        loop {
            let now = grimoire_core::platform::clock::now_ms();
            let progress = pairing::poll(self.store, &mut self.pending, now)
                .await
                .map_err(|e| for_a_reader(self.store, "discord_enable", e))?;
            match progress.stage.as_str() {
                "compare" => return Ok(()),
                "waiting" if started.elapsed() < self.wait => tokio::time::sleep(JOIN_POLL).await,
                _ => return Err(JOIN_TIMED_OUT.to_owned()),
            }
        }
    }

    async fn confirm(&mut self, pinned: Pinned) -> Result<PinnedJoin, String> {
        pairing::confirm_pinned(self.store, &mut self.pending, pinned)
            .await
            .map_err(|e| for_a_reader(self.store, "discord_enable", e))
    }
}

/// The real [`Front`], bearing the link's secret.
pub struct Linked<'a, S: Store> {
    pub store: &'a S,
    pub secret: String,
}

impl<S: Store> Front for Linked<'_, S> {
    async fn enroll(&self, invite: &str) -> Result<Enrolled, String> {
        front::enroll(self.store, &self.secret, invite).await
    }

    async fn unlink(&self) -> Result<(), String> {
        front::unlink(self.store, &self.secret).await
    }
}

/// The real [`Remover`]: `pairing::remove_device` — in signed mode, a rotation under a signed
/// roster document that omits the bot.
pub struct Removal<'a, S: Store> {
    pub store: &'a S,
}

impl<S: Store> Remover for Removal<'_, S> {
    async fn remove(&self, device: &str) -> Result<(), String> {
        pairing::remove_device(self.store, device).await
    }
}

// ---------------------------------------------------------------------------------------
// The switch-on and the switch-off
// ---------------------------------------------------------------------------------------

/// **The switch-on** (§13.6, `discord_enable`): the gate, the *Added from Discord* folder
/// (`integration::add::ensure_added_folder`, §14.5), the offer, the enroll, the wait for the bot's
/// join, the pinned confirm **as `add`** (§14.1) — and the bot's id kept.
///
/// **Any failure once the bot has enrolled undoes the link** (`DELETE /link`, best effort, and
/// forgotten here): the front would otherwise hold an enrolled bot that never joined, and refuse
/// every later enroll `already_enrolled`. Nothing was committed to the group — a confirm that
/// fails has written nothing — so undoing the link is the whole of the rollback.
///
/// A `401` from the enroll means the front no longer knows the secret: forgotten here too.
pub async fn enable(
    store: &impl Store,
    ceremony: &mut impl Ceremony,
    front: &impl Front,
) -> Result<PinnedJoin, String> {
    if store.with(|conn| Ok(local::link(conn)))?.is_none() {
        return Err(LINK_FIRST.to_owned());
    }
    if store.with(|conn| Ok(enrolled(conn)))? {
        return Err(ALREADY_ON.to_owned());
    }
    ceremony.gate()?;
    // The folder a collection add lands in when none is named (spec §14.5): made here, by a full
    // device, inside this store's write and before the bot is enrolled — so the bot's first pull
    // already has it, and a bot that never joins leaves only an empty folder the reader can keep
    // or delete. Kept by every later failure: it is the reader's folder, not the bot's.
    // ⚠️ The refusal is worded outside the stretch: `for_a_reader` records through the store, and
    // a stretch that asked the store again would wait on itself.
    store
        .with(|conn| {
            add::ensure_added_folder(conn)
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .map_err(|e| for_a_reader(store, "discord_enable", e))?;
    let invite = ceremony.begin()?;
    let answered = match front.enroll(&invite).await {
        Ok(answered) => answered,
        Err(refused) => {
            if refused == front::NOT_LINKED {
                store.with(local::forget_link)?;
            }
            return Err(refused);
        }
    };
    let pinned = Pinned::from_wire(
        &answered.device_id,
        &answered.x25519,
        &answered.ed25519,
        roster::ADD,
    );
    let outcome = match pinned {
        None => Err(BAD_KEYS.to_owned()),
        Some(pinned) => match ceremony.joined().await {
            Ok(()) => ceremony.confirm(pinned).await,
            Err(e) => Err(e),
        },
    };
    match outcome {
        Ok(joined) => {
            store.with(|conn| local::set_bot(conn, &joined.device_id))?;
            Ok(joined)
        }
        Err(refused) => {
            let _ = front.unlink().await;
            store.with(local::forget_link)?;
            Err(format!("{refused} {UNDONE}"))
        }
    }
}

/// Whether this device's bot is on the roster now.
pub fn enrolled(conn: &rusqlite::Connection) -> bool {
    bot_row(conn).is_some()
}

/// The bot's live roster row, if its id is kept here and it is still listed.
pub fn bot_row(conn: &rusqlite::Connection) -> Option<identity::Device> {
    let bot = local::bot(conn)?;
    identity::roster(conn)
        .ok()?
        .into_iter()
        .find(|d| d.device_id == bot && d.revoked_at.is_none())
}

/// **The switch-off** (§13.6, `discord_disable`), in its order, **every step run whatever the
/// one before said**:
///
/// 1. the bot out of the group (`pairing::remove_device`) — only when it is still listed; a link
///    that never enrolled has nothing to remove;
/// 2. `DELETE /link` — when linked;
/// 3. forget the bot here, always — and the link too, **unless the `DELETE` failed**: the front
///    keeps its link row when it cannot reach the bot (`502 bot_unavailable`), and the secret is
///    the only way to ask it again, so it is kept for the next switch-off. Nothing about the group
///    is kept either way.
///
/// The answer is the first failure's sentence — the removal's before the unlink's, since a bot
/// still listed is the one a reader must act on — or `Ok`.
pub async fn disable(
    store: &impl Store,
    remover: &impl Remover,
    front: Option<&impl Front>,
) -> Result<(), String> {
    let listed = store.with(|conn| Ok(bot_row(conn)))?;
    let mut first: Option<String> = None;
    if let Some(bot) = listed {
        if let Err(e) = remover.remove(&bot.device_id).await {
            let _ = store.with(|conn| {
                errors::record(
                    conn,
                    Source::Relay,
                    "discord_disable",
                    Kind::Other,
                    &e,
                    None,
                );
                Ok(())
            });
            first = Some(still_listed(&bot.name));
        }
    }
    let mut told = true;
    if let Some(front) = front {
        if front.unlink().await.is_err() {
            told = false;
            first.get_or_insert_with(|| NOT_TOLD.to_owned());
        }
    }
    if told {
        store.with(local::forget_all)?;
    } else {
        store.with(local::forget_bot)?;
    }
    match first {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

/// After a switch-on, what the front says about the link — best effort, for `lastPullAt`.
pub async fn refresh(store: &impl Store) {
    let Ok(Some(link)) = store.with(|conn| Ok(local::link(conn))) else {
        return;
    };
    if let Ok(info) = front::info(store, &link.secret).await {
        let _ = store.with(|conn| local::set_last_pull(conn, info.last_pull_at));
    }
}
