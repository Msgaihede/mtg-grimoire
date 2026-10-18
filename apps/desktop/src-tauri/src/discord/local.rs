//! What this device keeps about its Discord link — **`sync_state` rows, and nowhere else.**
//!
//! `sync_state` is the sync identity's own table: it is not one of `schema::SYNCED_TABLES`, so no
//! op ever carries a row of it to another device, and `archive::dump` leaves every `sync_*` table
//! out, so a backup never carries it either — **the link secret is held exactly as the group key
//! is**, and a restore that wipes the group wipes the link with it (`archive::replace`). `app_meta`
//! would have been the wrong table: it travels in every archive.
//!
//! Nothing here touches the network; [`super::front`] does, and the commands decide what to keep.

use crate::sync_engine::client;
use rusqlite::Connection;

/// An override for [`super::front::DISCORD_BASE`] — a test/dev knob with no UI, exactly as
/// `client::RELAY_URL` is for the relay and `share::publish::SHARE_URL` for the share Worker.
pub const DISCORD_URL: &str = "discord_url";

/// The link secret — 32 random bytes, base64url — the front answered on `POST /link/claim`. The
/// bearer of every later request; the front keeps only its SHA-256.
pub(crate) const SECRET: &str = "discord_secret";
pub(crate) const USER_ID: &str = "discord_user_id";
pub(crate) const USERNAME: &str = "discord_username";

/// The PKCE link in flight: the front's `code`, this device's verifier, and when it expires (Unix
/// ms, the front's own `expiresAt`).
pub(crate) const LINK_CODE: &str = "discord_link_code";
pub(crate) const LINK_VERIFIER: &str = "discord_link_verifier";
pub(crate) const LINK_EXPIRES: &str = "discord_link_expires";

/// The bot's device id, once its pinned pairing has committed here.
pub(crate) const BOT_DEVICE: &str = "discord_bot_device";

/// The bot's last pull as the front last reported it (`GET /link`'s `lastPullAt`).
pub(crate) const LAST_PULL: &str = "discord_last_pull";

fn get(conn: &Connection, key: &str) -> Option<String> {
    client::get_state(conn, key).filter(|v| !v.is_empty())
}

fn set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    client::set_state(conn, key, value).map_err(|e| e.to_string())
}

fn unset(conn: &Connection, keys: &[&str]) -> Result<(), String> {
    for key in keys {
        conn.execute("DELETE FROM sync_state WHERE key = ?1", [key])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The account this device is linked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Link {
    pub secret: String,
    pub user_id: Option<String>,
    pub username: Option<String>,
}

pub(crate) fn link(conn: &Connection) -> Option<Link> {
    Some(Link {
        secret: get(conn, SECRET)?,
        user_id: get(conn, USER_ID),
        username: get(conn, USERNAME),
    })
}

pub(crate) fn store_link(
    conn: &Connection,
    secret: &str,
    user_id: &str,
    username: &str,
) -> Result<(), String> {
    set(conn, SECRET, secret)?;
    set(conn, USER_ID, user_id)?;
    set(conn, USERNAME, username)?;
    forget_linking(conn)
}

/// A link begun and not yet claimed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Linking {
    pub code: String,
    pub verifier: String,
    pub expires_at: i64,
}

pub(crate) fn linking(conn: &Connection) -> Option<Linking> {
    Some(Linking {
        code: get(conn, LINK_CODE)?,
        verifier: get(conn, LINK_VERIFIER)?,
        expires_at: get(conn, LINK_EXPIRES)?.parse().ok()?,
    })
}

pub(crate) fn store_linking(conn: &Connection, linking: &Linking) -> Result<(), String> {
    set(conn, LINK_CODE, &linking.code)?;
    set(conn, LINK_VERIFIER, &linking.verifier)?;
    set(conn, LINK_EXPIRES, &linking.expires_at.to_string())
}

pub(crate) fn forget_linking(conn: &Connection) -> Result<(), String> {
    unset(conn, &[LINK_CODE, LINK_VERIFIER, LINK_EXPIRES])
}

pub(crate) fn bot(conn: &Connection) -> Option<String> {
    get(conn, BOT_DEVICE)
}

pub(crate) fn set_bot(conn: &Connection, device: &str) -> Result<(), String> {
    set(conn, BOT_DEVICE, device)
}

pub(crate) fn last_pull(conn: &Connection) -> Option<i64> {
    get(conn, LAST_PULL)?.parse().ok()
}

pub(crate) fn set_last_pull(conn: &Connection, at: Option<i64>) -> Result<(), String> {
    match at {
        Some(at) => set(conn, LAST_PULL, &at.to_string()),
        None => unset(conn, &[LAST_PULL]),
    }
}

/// Forget the account: the secret, who it is, the last pull, any link in flight. **Not the bot's
/// device id** — [`forget_all`] is the switch-off.
pub(crate) fn forget_link(conn: &Connection) -> Result<(), String> {
    unset(conn, &[SECRET, USER_ID, USERNAME, LAST_PULL])?;
    forget_linking(conn)
}

/// Forget the bot and its last pull, keeping the link.
pub(crate) fn forget_bot(conn: &Connection) -> Result<(), String> {
    unset(conn, &[BOT_DEVICE, LAST_PULL])
}

/// Forget everything this module keeps but the override.
pub(crate) fn forget_all(conn: &Connection) -> Result<(), String> {
    forget_link(conn)?;
    unset(conn, &[BOT_DEVICE])
}
