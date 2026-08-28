//! This device's identity, the group it belongs to, and who else is in it.
//!
//! The one layer of `sync_pair` that touches SQLite. Everything above it is pure, which is why
//! the protocol tests never need a database and these tests never need a network.
//!
//! **The device's secret key and the group key live in the user database, in the clear.** There
//! is no OS keystore for a portable Windows exe a reader copies onto a stick, and inventing one
//! would be a second store to lose. The consequence is exact: **copying the data folder copies
//! the identity.** Somebody who has the database already has the collection it protects, so the
//! key adds no new exposure — but a *backup* of `user.db` is a backup of the pairing, and
//! restoring it onto a second machine makes two devices claim one identity. [`ensure`] is where
//! that is decided, and it mints on absence only.

use crate::sync_pair::crypto::{self, Keypair};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// This device, as the rest of the app refers to it.
pub struct Identity {
    pub device_id: String,
    pub keypair: Keypair,
    pub name: String,
}

/// The group this device is in, if it is in one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub group_id: String,
    pub epoch: i64,
    pub group_key: [u8; 32],
}

/// One row of the roster. The public key is not serialised — the webview draws a list of
/// devices, and a key on that list is a key in a screenshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub added_at: i64,
    pub revoked_at: Option<i64>,
    #[serde(skip)]
    pub public_key: [u8; 32],
}

/// The default name a device gives itself.
///
/// Deliberately not the hostname. A hostname is often a person's own name and it would travel
/// to every paired device without anybody choosing to send it; "This device" is honest, and
/// [`rename_device`] is one press away.
const DEFAULT_NAME: &str = "This device";

/// What [`revoke_device`] says when it is pointed at this very device.
const CANNOT_REMOVE_SELF: &str = "This device cannot remove itself. Use Leave group instead.";

/// What both rotations say on a device that is in no group.
const NOT_IN_A_GROUP: &str = "This device is not in a pairing group.";

/// What [`revoke_device`] says when the id names nobody on the roster.
const NOT_ON_THE_ROSTER: &str = "That device is not in this pairing group.";

/// Read this device's identity, minting one the first time.
///
/// **It mints on absence and never on a mismatch**, which is the whole of what a restored
/// `user.db` gets: the device it was. Re-minting on anything that looked wrong would turn a
/// restore into a silent fork, where two machines both believe they are the same device and
/// both write under that id.
pub fn ensure(conn: &Connection) -> rusqlite::Result<Identity> {
    if let Some(id) = read(conn)? {
        return Ok(id);
    }
    let device_id = hex(&crypto::random_bytes::<16>());
    let kp = crypto::keypair();
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, ?1, ?2, ?3, ?4, unixepoch())",
        params![
            device_id,
            kp.secret.as_slice(),
            kp.public.as_slice(),
            DEFAULT_NAME
        ],
    )?;
    Ok(Identity {
        device_id,
        keypair: kp,
        name: DEFAULT_NAME.to_owned(),
    })
}

fn read(conn: &Connection) -> rusqlite::Result<Option<Identity>> {
    conn.query_row(
        "SELECT device_id, secret_key, public_key, name FROM sync_identity WHERE id = 1",
        [],
        |r| {
            Ok(Identity {
                device_id: r.get(0)?,
                keypair: Keypair {
                    secret: bytes32(r.get::<_, Vec<u8>>(1)?),
                    public: bytes32(r.get::<_, Vec<u8>>(2)?),
                },
                name: r.get(3)?,
            })
        },
    )
    .optional()
}

/// The group this device is in, or `None`.
pub fn group(conn: &Connection) -> rusqlite::Result<Option<Group>> {
    conn.query_row(
        "SELECT group_id, epoch, group_key FROM sync_group WHERE id = 1",
        [],
        |r| {
            Ok(Group {
                group_id: r.get(0)?,
                epoch: r.get(1)?,
                group_key: bytes32(r.get::<_, Vec<u8>>(2)?),
            })
        },
    )
    .optional()
}

/// Mint a group with this device alone in it. Idempotent: a device already in a group gets the
/// group it is already in, because "pair another device" must never quietly leave the first one.
pub fn create_group(conn: &Connection, me: &Identity) -> rusqlite::Result<Group> {
    if let Some(g) = group(conn)? {
        return Ok(g);
    }
    let g = Group {
        group_id: hex(&crypto::random_bytes::<16>()),
        epoch: 0,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(conn, &g)?;
    add_device(conn, &me.device_id, &me.keypair.public, &me.name)?;
    Ok(g)
}

/// Join a group somebody else minted, with the key they sealed to this device.
pub fn join_group(
    conn: &Connection,
    group_id: &str,
    epoch: i64,
    key: &[u8; 32],
    me: &Identity,
) -> rusqlite::Result<()> {
    write_group(
        conn,
        &Group {
            group_id: group_id.to_owned(),
            epoch,
            group_key: *key,
        },
    )?;
    add_device(conn, &me.device_id, &me.keypair.public, &me.name)
}

fn write_group(conn: &Connection, g: &Group) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
              VALUES (1, ?1, ?2, ?3, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
              group_id = excluded.group_id,
              epoch = excluded.epoch,
              group_key = excluded.group_key",
        params![g.group_id, g.epoch, g.group_key.as_slice()],
    )?;
    Ok(())
}

/// Every device the group has ever had, oldest first, removed ones included.
pub fn roster(conn: &Connection) -> rusqlite::Result<Vec<Device>> {
    let mut stmt = conn.prepare(
        "SELECT device_id, public_key, name, added_at, revoked_at
           FROM sync_devices ORDER BY added_at, device_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Device {
            device_id: r.get(0)?,
            public_key: bytes32(r.get::<_, Vec<u8>>(1)?),
            name: r.get(2)?,
            added_at: r.get(3)?,
            revoked_at: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Put a device on the roster, or update the key and name of one already there.
pub fn add_device(
    conn: &Connection,
    device_id: &str,
    public_key: &[u8; 32],
    name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_devices (device_id, public_key, name, added_at, revoked_at)
              VALUES (?1, ?2, ?3, unixepoch(), NULL)
         ON CONFLICT(device_id) DO UPDATE SET
              public_key = excluded.public_key,
              name = excluded.name,
              -- Re-pairing a device that was removed puts it back. The reader pressed Pair
              -- and compared six digits; refusing them would be the app disagreeing with a
              -- decision it just asked for.
              revoked_at = NULL",
        params![device_id, public_key.as_slice(), name],
    )?;
    Ok(())
}

/// Rename a device on the roster — **and this device's own copy of its name, when that is who
/// is being renamed.**
///
/// The second statement is not tidiness. `sync_identity.name` is the copy every pairing sends:
/// [`create_group`] and [`join_group`] both file this device on the roster under it, and
/// `pairing::accept` seals it into the blob the other device files this one by. Without this
/// line a reader who renamed this device would have the rename silently undone by their next
/// pairing, and the roster row on the *other* device would have been wrong from the start.
pub fn rename_device(conn: &Connection, device_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_devices SET name = ?2 WHERE device_id = ?1",
        params![device_id, name],
    )?;
    conn.execute(
        "UPDATE sync_identity SET name = ?2 WHERE id = 1 AND device_id = ?1",
        params![device_id, name],
    )?;
    Ok(())
}

/// Take a device off the group and rotate the key — §7.6, and the two halves are one statement.
///
/// **The rotation is the removal.** Marking the row and leaving the key alone would produce an
/// app that says a device is gone while that device can still read every op written afterwards.
/// The epoch is what the remaining devices compare, and it is bumped in the same transaction.
///
/// **This device cannot revoke itself.** "Leave the group" is a different press with different
/// consequences — it throws this device's own copy of the key away — and collapsing the two
/// would let a mis-click cost the reader the group they are standing in.
///
/// **And an id nobody on the roster answers to rotates nothing.** A rotation locks every
/// remaining device out of what came before it, so one with nobody removed is a cost with no
/// cause and nothing on any screen to explain it.
pub fn revoke_device(conn: &Connection, device_id: &str) -> Result<Group, String> {
    let me = ensure(conn).map_err(|e| e.to_string())?;
    if me.device_id == device_id {
        return Err(CANNOT_REMOVE_SELF.to_owned());
    }
    let Some(current) = group(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let marked = tx
        .execute(
            "UPDATE sync_devices SET revoked_at = unixepoch() WHERE device_id = ?1",
            params![device_id],
        )
        .map_err(|e| e.to_string())?;
    if marked == 0 {
        return Err(NOT_ON_THE_ROSTER.to_owned());
    }
    let rotated = Group {
        group_id: current.group_id,
        epoch: current.epoch + 1,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(&tx, &rotated).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rotated)
}

/// Rotate the key without removing anybody — the press behind "Rotate key now".
pub fn rotate_key(conn: &Connection) -> Result<Group, String> {
    let Some(current) = group(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    let rotated = Group {
        group_id: current.group_id,
        epoch: current.epoch + 1,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(conn, &rotated).map_err(|e| e.to_string())?;
    Ok(rotated)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A 32-byte column as an array.
///
/// A short or long BLOB yields zeroes rather than a panic: these columns are written only by
/// this module, so a wrong length means a hand-edited database, and a panic at startup would
/// be the worst possible answer to one. What it costs is that such a database fails to pair
/// rather than saying why — which is the quieter of the two failures and the only one that
/// leaves the reader an app.
fn bytes32(v: Vec<u8>) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = v.len().min(32);
    out[..n].copy_from_slice(&v[..n]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pair, not `Connection::open_in_memory` plus a ladder — `schema::memory_pair`'s own
    /// doc says why, and it is the shape the running app has.
    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    #[test]
    fn ensure_mints_once_and_is_stable_afterwards() {
        let conn = db();
        let first = ensure(&conn).unwrap();
        let second = ensure(&conn).unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.keypair.public, second.keypair.public);
        assert_eq!(first.keypair.secret, second.keypair.secret);
        assert_eq!(first.device_id.len(), 32, "16 bytes as hex");
    }

    /// Two databases are two devices. A device id that was a constant would collide on every
    /// pairing, and `ensure_mints_once` cannot tell the difference.
    #[test]
    fn two_databases_are_two_devices() {
        let a = ensure(&db()).unwrap();
        let b = ensure(&db()).unwrap();
        assert_ne!(a.device_id, b.device_id);
        assert_ne!(a.keypair.public, b.keypair.public);
    }

    #[test]
    fn a_fresh_database_is_in_no_group() {
        let conn = db();
        ensure(&conn).unwrap();
        assert!(group(&conn).unwrap().is_none());
    }

    #[test]
    fn creating_a_group_leaves_this_device_on_the_roster() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        let g = create_group(&conn, &me).unwrap();
        assert_eq!(g.epoch, 0);
        assert_eq!(g.group_id.len(), 32);

        let list = roster(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].device_id, me.device_id);
        assert!(list[0].revoked_at.is_none());
    }

    /// "Pair another device" must never quietly leave the group this one is already in.
    #[test]
    fn creating_a_group_twice_keeps_the_first_one() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        let first = create_group(&conn, &me).unwrap();
        let again = create_group(&conn, &me).unwrap();
        assert_eq!(first, again);
    }

    #[test]
    fn joining_a_group_stores_the_key_it_was_given() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        let key = [42u8; 32];
        join_group(&conn, "abc123", 3, &key, &me).unwrap();

        let g = group(&conn).unwrap().unwrap();
        assert_eq!(g.group_id, "abc123");
        assert_eq!(g.epoch, 3);
        assert_eq!(g.group_key, key);
    }

    /// Revocation rotates the key, bumps the epoch, and leaves the removed device on the
    /// roster as removed — §7.6. A deleted row could not answer "who did I take off, and when".
    #[test]
    fn revoking_a_device_rotates_the_key_and_bumps_the_epoch() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();

        let before = group(&conn).unwrap().unwrap();
        revoke_device(&conn, "deadbeef").unwrap();
        let after = group(&conn).unwrap().unwrap();

        assert_eq!(
            after.group_id, before.group_id,
            "the group survives a rotation"
        );
        assert_eq!(after.epoch, before.epoch + 1);
        assert_ne!(
            after.group_key, before.group_key,
            "the key must actually change"
        );

        let phone = roster(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == "deadbeef")
            .expect("the removed device stays on the roster");
        assert!(phone.revoked_at.is_some());
    }

    /// This device cannot remove itself. "Leave the group" is a different command with
    /// different consequences, and confusing the two loses the reader their key.
    #[test]
    fn this_device_cannot_revoke_itself() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        assert!(revoke_device(&conn, &me.device_id).is_err());
    }

    /// A device that is not on the roster cannot be removed, **and the key does not move**.
    /// A rotation is what a removal *is*, so one with nobody removed is every other device
    /// locked out of the log for no reason a reader could name.
    #[test]
    fn revoking_a_device_that_is_not_here_changes_nothing() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        let before = group(&conn).unwrap().unwrap();

        assert!(revoke_device(&conn, "nobody").is_err());

        assert_eq!(group(&conn).unwrap().unwrap(), before);
    }

    /// Rotating without removing anybody is its own press, and it moves the same two things.
    #[test]
    fn rotating_the_key_bumps_the_epoch_and_keeps_the_roster() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();

        let before = group(&conn).unwrap().unwrap();
        let after = rotate_key(&conn).unwrap();

        assert_eq!(after.group_id, before.group_id);
        assert_eq!(after.epoch, before.epoch + 1);
        assert_ne!(after.group_key, before.group_key);
        assert_eq!(roster(&conn).unwrap().len(), 2);
        assert!(roster(&conn)
            .unwrap()
            .iter()
            .all(|d| d.revoked_at.is_none()));
    }

    /// Neither press means anything on a device that is in no group, and both say so rather
    /// than minting one.
    #[test]
    fn an_unpaired_device_can_neither_rotate_nor_revoke() {
        let conn = db();
        ensure(&conn).unwrap();
        assert!(rotate_key(&conn).is_err());
        assert!(revoke_device(&conn, "deadbeef").is_err());
        assert!(group(&conn).unwrap().is_none());
    }

    /// Re-pairing a device that was removed puts it back. The reader pressed Pair and
    /// compared six digits; refusing them would be the app disagreeing with what it just asked.
    #[test]
    fn adding_a_removed_device_again_puts_it_back() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();
        revoke_device(&conn, "deadbeef").unwrap();

        add_device(&conn, "deadbeef", &[8u8; 32], "Phone again").unwrap();
        let phone = roster(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == "deadbeef")
            .unwrap();
        assert!(phone.revoked_at.is_none());
        assert_eq!(phone.name, "Phone again");
        assert_eq!(phone.public_key, [8u8; 32]);
    }

    #[test]
    fn renaming_a_device_changes_only_its_name() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        rename_device(&conn, &me.device_id, "Desk").unwrap();
        let list = roster(&conn).unwrap();
        assert_eq!(list[0].name, "Desk");
        assert_eq!(list[0].device_id, me.device_id);
        assert_eq!(list[0].public_key, me.keypair.public);
    }

    /// Renaming **this** device changes the name every later pairing sends, and a pairing
    /// after the rename does not put the old one back.
    ///
    /// The name lives in two rows — the roster's and this device's own — and only the second
    /// is what `create_group`, `join_group` and `pairing::accept` read. A rename that moved
    /// one of them would be undone by the next press of Pair, on the reader's own screen.
    #[test]
    fn renaming_this_device_survives_the_next_pairing() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        rename_device(&conn, &me.device_id, "Desk").unwrap();

        assert_eq!(ensure(&conn).unwrap().name, "Desk");

        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        assert_eq!(roster(&conn).unwrap()[0].name, "Desk");
    }

    /// Renaming somebody *else* leaves this device's own name alone.
    #[test]
    fn renaming_another_device_does_not_rename_this_one() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();

        rename_device(&conn, "deadbeef", "Kitchen").unwrap();
        assert_eq!(ensure(&conn).unwrap().name, "This device");
        assert_eq!(
            roster(&conn)
                .unwrap()
                .into_iter()
                .find(|d| d.device_id == "deadbeef")
                .unwrap()
                .name,
            "Kitchen"
        );
    }

    /// The roster is what the panel draws, and a key on a list is a key in a screenshot.
    #[test]
    fn a_roster_row_does_not_serialise_its_public_key() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        let json = serde_json::to_string(&roster(&conn).unwrap()).unwrap();
        assert!(
            !json.contains("publicKey") && !json.contains("public_key"),
            "{json}"
        );
        assert!(json.contains("deviceId"), "{json}");
    }
}
