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

/// How long a minted name may be, in characters.
///
/// Characters and not bytes: this string is drawn in a roster row and sealed into a pairing
/// blob, and a hostname long enough to matter is a misconfiguration rather than something to
/// carry faithfully. A `MARKUS-PC` is fifteen; Windows cannot exceed that.
const MAX_NAME_LEN: usize = 64;

/// What a desktop calls itself when the environment will not say.
#[cfg(not(any(target_os = "android", target_family = "wasm")))]
const FALLBACK_DESKTOP: &str = "Desktop";

/// What a phone calls itself when the JVM will not answer.
#[cfg(target_os = "android")]
const FALLBACK_ANDROID: &str = "Android device";

/// The one string every install used to share, and the only name [`ensure`] will overwrite.
///
/// Kept as a constant rather than spelled inline because two places must agree on it exactly:
/// the upgrade in [`ensure`], and the tests that assert a minted name is not this. It is not a
/// fallback and nothing mints it — a device that reads this today got it from a build before
/// 2026-08-29.
pub(crate) const PLACEHOLDER: &str = "This device";

/// What a browser calls itself when there is no user agent to read.
#[cfg(target_family = "wasm")]
const FALLBACK_BROWSER: &str = "Browser";

/// The name a device gives itself the first time it mints an identity.
///
/// **It is the machine's own name, and the comment that stood here argued the exact opposite.**
/// It said the hostname was deliberately withheld — that a hostname is often a person's own
/// name and would travel to every paired device without anybody choosing to send it, and that
/// "This device" was the honest answer. **The reader overruled that on 2026-08-29, knowingly and
/// on the evidence**: every install minted that same string, so a paired group drew two
/// identical rows with a Remove button each and nothing on the screen said which press removed
/// the phone. A roster a reader cannot act on is the worse failure of the two.
///
/// **The cost the old comment named is real and is not softened by this being a default.**
/// `sync_identity.name` is the copy every pairing sends — [`create_group`], [`join_group`] and
/// `pairing::accept` all file this device on the roster under it — so a Windows hostname does
/// reach every device in the group, and on a personal machine it is frequently the owner's own
/// name. Two things pay for it: [`rename_device`] is still one press away in Settings and
/// writes both rows, and [`ensure`] mints **on absence only**, so a reader who renames is never
/// renamed back and an existing install keeps the name it already had.
///
/// **Three arms because the three platforms have three different answers, not three spellings
/// of one.** An Android hostname is `localhost` and a browser has none at all, so asking for one
/// there would name every phone and every tab the same thing — which is the bug this whole
/// change is about, moved one platform over. And **every arm is infallible**: failing to read a
/// name must never stop a device minting an identity, so each falls back to a word rather than
/// returning an error.
#[cfg(not(any(target_os = "android", target_family = "wasm")))]
fn mint_name() -> String {
    // `COMPUTERNAME` on Windows, `HOSTNAME` elsewhere, read straight out of the environment
    // rather than through a `hostname` crate — one string read once per install is not worth a
    // dependency with a `gethostname` call behind it.
    //
    // **`HOSTNAME` is a shell variable on Linux and macOS and is usually not exported to a
    // process**, so `FALLBACK_DESKTOP` is the ordinary answer there rather than the exceptional
    // one. That is the honest trade for a portable Windows app: Windows puts `COMPUTERNAME` in
    // every process's environment, and nobody has ever run a Linux build of this.
    const HOST_VAR: &str = if cfg!(windows) {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    };
    let name = std::env::var(HOST_VAR)
        .map(|v| tidy(&v))
        .unwrap_or_default();
    if name.is_empty() {
        return FALLBACK_DESKTOP.to_owned();
    }
    name
}

/// `android.os.Build.MODEL` — "OnePlus 12" rather than a hostname, which on Android is
/// `localhost` on every phone ever made.
///
/// **The JavaVM comes from tao's own Android glue rather than from `ndk-context`**, and that is
/// a correction to the obvious route rather than a preference. `ndk_context::android_context()`
/// is the standard way to reach a VM, but nothing in this tree calls
/// `initialize_android_context` — the crate is not in `Cargo.lock` at all — so it would answer a
/// null pointer and this arm would fall back on every phone forever: code that compiles, ships
/// and can never run. `tauri::tao` is the runtime this app is actually built on and
/// `main_android_context` is where it keeps the VM the activity handed it.
///
/// `jni` was already in `Cargo.lock` through `tao`, `wry` and `tauri`, so its line in
/// `Cargo.toml` is a **direct edge on a crate already in the tree** rather than a new
/// dependency — `tauri-plugin-fs`'s case, one block above it in that file.
#[cfg(target_os = "android")]
fn mint_name() -> String {
    android_model()
        .map(|m| tidy(&m))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| FALLBACK_ANDROID.to_owned())
}

/// The static `android.os.Build.MODEL` field, read through JNI. `None` at every step that can
/// fail, because [`mint_name`] owes its caller a string and never an error.
#[cfg(target_os = "android")]
fn android_model() -> Option<String> {
    use jni::objects::JString;
    use tauri::tao::platform::android::prelude::main_android_context;

    let ctx = main_android_context()?;
    // SAFETY: the pointer is the `JavaVM*` tao was handed by `JNI_OnLoad` and keeps for the
    // life of the process; `from_raw` rejects null on its own.
    let vm = unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let field = env
        .get_static_field("android/os/Build", "MODEL", "Ljava/lang/String;")
        .ok()?;
    let model: JString = field.l().ok()?.into();
    env.get_string(&model).ok().map(String::from)
}

/// A label off the user agent — "Chrome on Windows".
///
/// **A browser has no hostname and nothing to ask for one**, so this arm names the browser and
/// the platform instead: two facts a reader can match against the machine in front of them, and
/// neither of them anything the browser was not already telling every site it visits.
///
/// `navigator.userAgent` is read by reflection off the global rather than through
/// `web_sys::Window`, because this build runs inside a Worker as well as in a page and `Window`
/// is not among the `web-sys` features switched on here. `js_sys::Reflect` answers in both
/// contexts and throws in neither, so no feature had to be added for one string.
#[cfg(target_family = "wasm")]
fn mint_name() -> String {
    let label = user_agent()
        .map(|ua| tidy(&browser_label(&ua)))
        .unwrap_or_default();
    if label.is_empty() {
        return FALLBACK_BROWSER.to_owned();
    }
    label
}

/// `navigator.userAgent`, in a page or in a Worker. `None` rather than a panic anywhere it is
/// absent — a headless context with no navigator is a browser that still has to be able to pair.
#[cfg(target_family = "wasm")]
fn user_agent() -> Option<String> {
    use wasm_bindgen::JsValue;
    let global = js_sys::global();
    let nav = js_sys::Reflect::get(&global, &JsValue::from_str("navigator")).ok()?;
    js_sys::Reflect::get(&nav, &JsValue::from_str("userAgent"))
        .ok()?
        .as_string()
}

/// A user agent string as two words a reader recognises.
///
/// **The order of both tables is the whole of this function.** Every Chromium browser says
/// `Chrome` in its user agent and Edge and Opera add their own token beside it, so the specific
/// token has to be tested first or every browser on the desk reads as Chrome; Safari is last
/// for the same reason from the other end, since every one of them also says `Safari`. Android
/// says `Linux` and is tested before it.
///
/// **What is not matched is not guessed at.** An unrecognised browser or platform is left out
/// of the label rather than named wrongly, and a string that matches nothing at all comes back
/// empty so that [`mint_name`] can use its fallback instead of showing the reader a blank row.
///
/// It is `pub` and compiled on every target although only the wasm arm calls it: it is a pure
/// string function, and the desktop suite is the only place it can be tested.
pub fn browser_label(ua: &str) -> String {
    const BROWSERS: [(&str, &str); 5] = [
        ("Edg/", "Edge"),
        ("OPR/", "Opera"),
        ("Firefox/", "Firefox"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ];
    const PLATFORMS: [(&str, &str); 6] = [
        ("Android", "Android"),
        ("iPhone", "iOS"),
        ("iPad", "iOS"),
        ("Windows", "Windows"),
        ("Mac OS X", "macOS"),
        ("Linux", "Linux"),
    ];
    let browser = BROWSERS
        .iter()
        .find(|(token, _)| ua.contains(token))
        .map(|(_, name)| *name);
    let platform = PLATFORMS
        .iter()
        .find(|(token, _)| ua.contains(token))
        .map(|(_, name)| *name);
    match (browser, platform) {
        (Some(b), Some(p)) => format!("{b} on {p}"),
        (Some(b), None) => b.to_owned(),
        (None, Some(p)) => p.to_owned(),
        (None, None) => String::new(),
    }
}

/// A platform's answer, trimmed and cut to [`MAX_NAME_LEN`] characters.
fn tidy(raw: &str) -> String {
    raw.trim().chars().take(MAX_NAME_LEN).collect()
}

/// What [`revoke_device`] says when it is pointed at this very device.
const CANNOT_REMOVE_SELF: &str = "This device cannot remove itself. Use Leave group instead.";

/// What [`revoke_device`] says on a device that is in no group.
const NOT_IN_A_GROUP: &str = "This device is not in a pairing group.";

/// What [`revoke_device`] says when the id names nobody on the roster.
const NOT_ON_THE_ROSTER: &str = "That device is not in this pairing group.";

/// Read this device's identity, minting one the first time.
///
/// **It mints on absence and never on a mismatch**, which is the whole of what a restored
/// `user.db` gets: the device it was. Re-minting on anything that looked wrong would turn a
/// restore into a silent fork, where two machines both believe they are the same device and
/// both write under that id.
///
/// **[`mint_name`] is called here and nowhere else, on this one path.** Reading the machine's
/// name on every call would look like keeping the roster current and would in fact overwrite a
/// reader who renamed this device in Settings — and quietly rename every existing install the
/// first time it launched a new build. A name is minted once and is the reader's from then on.
pub fn ensure(conn: &Connection) -> rusqlite::Result<Identity> {
    if let Some(mut id) = read(conn)? {
        // **The placeholder is upgraded exactly once; a name a reader chose never is.**
        //
        // Minting only on absence reaches fresh installs and nothing else, which leaves every
        // device that already exists called `PLACEHOLDER` for ever — and those are precisely the
        // devices the duplicate-name bug was reported against. Driven on the real pair
        // 2026-08-29: both devices updated, both still read "This device", because both already
        // had an identity.
        //
        // The comparison is against the exact old default and nothing else. It was never a name
        // anybody picked — it is what every install shared — so replacing it takes nothing from
        // anyone, while a reader who renamed holds a different string and is not touched.
        //
        // **The far device does not learn the new name from this.** `sync_devices` never syncs
        // (it holds keys), so a name crosses only at pairing, where `create_group`, `join_group`
        // and `accept` carry it. Two devices already paired need to pair again for the roster to
        // catch up — which is the same gap a later `rename_device` has always had.
        if id.name == PLACEHOLDER {
            let minted = mint_name();
            conn.execute(
                "UPDATE sync_identity SET name = ?1 WHERE id = 1",
                params![minted],
            )?;
            conn.execute(
                "UPDATE sync_devices SET name = ?1 WHERE device_id = ?2",
                params![minted, id.device_id],
            )?;
            id.name = minted;
        }
        return Ok(id);
    }
    let device_id = hex(&crypto::random_bytes::<16>());
    let kp = crypto::keypair();
    let name = mint_name();
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, ?1, ?2, ?3, ?4, unixepoch())",
        params![device_id, kp.secret.as_slice(), kp.public.as_slice(), name],
    )?;
    Ok(Identity {
        device_id,
        keypair: kp,
        name,
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
///
/// **What it does not do is withdraw anything the removed device contributed** — spec §12.3.
/// The collection is one object the whole group has been writing, and a phone's cards, decks
/// and folders are rows in every device's tables by the time it leaves. Removing a device ends
/// its ability to keep *writing*; nothing here deletes, re-parents or re-counts a row it wrote,
/// and `removing_a_device_changes_no_row_it_contributed` is what holds that true. Note the
/// consequence for anyone tempted to add such a sweep later: a row carries no author. Its
/// `sync_uid` is `lower(hex(randomblob(16)))` and `apply` records no ops of its own, so on the
/// remaining devices there is nothing that even *says* which device a row came from.
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
    // **A rotation re-arms the baseline for everybody who stays.** Spec §12.4: the new epoch
    // makes every op written before it unreadable, and `client::pull` steps over a lower-epoch
    // envelope rather than stalling on it — so a peer's last words can be lost at the boundary.
    // Re-baselining under the new key carries them across as ordinary rows. Claims resolve by
    // `max` and a horizon only filters, so this cannot double-count.
    //
    // **After the mark, not before**, which is what `WHERE revoked_at IS NULL` is reading: the
    // departed device keeps its marker, so re-arming cannot hand a full baseline to a peer that
    // is never going to answer.
    tx.execute(
        "UPDATE sync_devices SET baselined_at = NULL WHERE revoked_at IS NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    let rotated = Group {
        group_id: current.group_id,
        epoch: current.epoch + 1,
        group_key: crypto::random_bytes::<32>(),
    };
    write_group(&tx, &rotated).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
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
    use crate::sync_engine::merge::Op;
    use crate::sync_engine::{apply, capture};
    use std::collections::BTreeMap;

    /// A pair, not `Connection::open_in_memory` plus a ladder — `schema::memory_pair`'s own
    /// doc says why, and it is the shape the running app has.
    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The name every install used to mint, and the one thing a minted name may never be.
    /// The real constant, not a second copy of the string — a test asserting against its
    /// own spelling would keep passing after the code stopped using it.
    const OLD_SHARED_DEFAULT: &str = PLACEHOLDER;

    /// A minted name says which machine this is.
    ///
    /// **It asserts the shape and never the value.** The hostname differs on every desk and CI
    /// is nobody's desk, so what is checkable is that the name is a real string, that it is not
    /// the placeholder every device used to share, and that asking twice gives one answer.
    #[test]
    fn ensure_mints_a_name_for_this_machine() {
        let conn = db();
        let minted = ensure(&conn).unwrap().name;
        assert!(
            !minted.trim().is_empty(),
            "a device must be called something"
        );
        assert_ne!(
            minted, OLD_SHARED_DEFAULT,
            "every device minting one string is the bug this replaced"
        );
        assert!(minted.chars().count() <= MAX_NAME_LEN);
        assert_eq!(ensure(&conn).unwrap().name, minted, "and it does not move");
    }

    /// The minted name is what a pairing sends, so the roster row reads the same thing the
    /// panel's own heading does.
    #[test]
    fn the_minted_name_is_what_reaches_the_roster() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        assert_eq!(roster(&conn).unwrap()[0].name, me.name);
    }

    /// **An install still carrying the shared placeholder is upgraded, and this is the case the
    /// bug was actually reported against.** Minting on absence alone reaches fresh installs and
    /// nothing else, so both of a reader's real devices stayed called "This device" after the
    /// build meant to fix exactly that — driven on the live pair 2026-08-29.
    ///
    /// The identity itself must survive: re-minting the `device_id` would be a silent fork, with
    /// two machines writing under one name.
    #[test]
    fn the_shared_placeholder_is_upgraded_on_an_existing_install() {
        let conn = db();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'deadbeef', ?1, ?2, ?3, 0)",
            params![[1u8; 32].as_slice(), [2u8; 32].as_slice(), PLACEHOLDER],
        )
        .unwrap();
        add_device(&conn, "deadbeef", &[3u8; 32], PLACEHOLDER).unwrap();

        let upgraded = ensure(&conn).unwrap();
        assert_ne!(
            upgraded.name, PLACEHOLDER,
            "the placeholder is what the reader could not tell apart"
        );
        assert!(!upgraded.name.trim().is_empty());
        assert_eq!(
            upgraded.device_id, "deadbeef",
            "the identity is upgraded, never re-minted"
        );

        // The roster row moves with it, or this device's own row disagrees with its heading.
        assert_eq!(roster(&conn).unwrap()[0].name, upgraded.name);

        // ...and it settles: a second launch mints nothing new.
        assert_eq!(ensure(&conn).unwrap().name, upgraded.name);
    }

    /// **A reader who renamed this device is never renamed back**, however many times `ensure`
    /// is called afterwards. `mint_name` runs on the insert and on no other path; a version that
    /// recomputed the name per call would undo the rename at the next command, silently.
    #[test]
    fn a_renamed_device_keeps_its_name_across_every_later_ensure() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        assert_ne!(
            me.name, "Kitchen table",
            "the point is that the rename moved it"
        );
        rename_device(&conn, &me.device_id, "Kitchen table").unwrap();

        assert_eq!(ensure(&conn).unwrap().name, "Kitchen table");
        assert_eq!(ensure(&conn).unwrap().name, "Kitchen table");
        create_group(&conn, &ensure(&conn).unwrap()).unwrap();
        assert_eq!(roster(&conn).unwrap()[0].name, "Kitchen table");
    }

    /// The browser label, which is the one arm of [`mint_name`] that can be tested off its own
    /// platform. Every case here is a real user agent's distinguishing substrings.
    #[test]
    fn a_browser_is_named_by_its_engine_and_its_platform() {
        for (ua, want) in [
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Chrome on Windows",
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
                "Edge on Windows",
            ),
            (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
                "Opera on Windows",
            ),
            (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 \
                 Firefox/133.0",
                "Firefox on macOS",
            ),
            (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
                "Safari on iOS",
            ),
            (
                "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
                "Chrome on Android",
            ),
        ] {
            assert_eq!(browser_label(ua), want, "{ua}");
        }
    }

    /// A user agent this function cannot read names nothing rather than naming it wrongly, and
    /// an empty label is what lets [`mint_name`] reach its fallback.
    #[test]
    fn an_unreadable_user_agent_is_left_unnamed() {
        assert_eq!(browser_label(""), "");
        assert_eq!(browser_label("curl/8.9.1"), "");
        assert_eq!(browser_label("Some Browser (Windows NT 10.0)"), "Windows");
    }

    /// A name is trimmed and cut, and the cut counts characters — a byte slice would panic on
    /// a hostname with an accent in it.
    #[test]
    fn a_name_is_trimmed_and_capped() {
        assert_eq!(tidy("  MARKUS-PC \n"), "MARKUS-PC");
        assert_eq!(tidy("   "), "");
        let long = "é".repeat(MAX_NAME_LEN * 2);
        assert_eq!(tidy(&long).chars().count(), MAX_NAME_LEN);
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

    /// Removing a device means nothing on a device that is in no group, and it says so rather
    /// than minting one.
    #[test]
    fn an_unpaired_device_cannot_revoke() {
        let conn = db();
        ensure(&conn).unwrap();
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
        assert_eq!(ensure(&conn).unwrap().name, me.name);
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

    // -------------------------------------------------------------------------------------
    // Revocation — spec §12
    // -------------------------------------------------------------------------------------

    /// The two tables a removal is *supposed* to change, named rather than skipped.
    ///
    /// `sync_devices` carries the revoked mark and the re-armed `baselined_at`; `sync_group`
    /// carries the bumped epoch and the new key. Those two changing **is** the removal. A skip
    /// list of "whatever happens to fail" would eventually grow to cover a real regression;
    /// naming these two is what makes every other table in the user database a hard assertion.
    const CHANGED_BY_A_REMOVAL: [&str; 2] = ["sync_devices", "sync_group"];

    /// Every other table in the user database, every row rendered whole and sorted.
    ///
    /// **Rows and not counts, `sync_uid` included.** A rule that deleted a departed device's
    /// contributions and one that quietly re-parented or re-counted them leave the same number
    /// of rows behind, and only the first is visible to a `count(*)`.
    fn snapshot(conn: &Connection) -> BTreeMap<String, Vec<String>> {
        let mut listing = conn
            .prepare(
                "SELECT name FROM main.sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        let tables: Vec<String> = listing
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        let mut out = BTreeMap::new();
        for table in tables {
            if CHANGED_BY_A_REMOVAL.contains(&table.as_str()) {
                continue;
            }
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM main.{table}"))
                .unwrap();
            let names: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|n| (*n).to_owned())
                .collect();
            let mut rows: Vec<String> = stmt
                .query_map([], |r| {
                    let mut cells = Vec::new();
                    for (i, name) in names.iter().enumerate() {
                        cells.push(format!("{name}={:?}", r.get_ref(i)?));
                    }
                    Ok(cells.join("|"))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            rows.sort();
            out.insert(table, rows);
        }
        out
    }

    /// Two databases in one group, both with the capture triggers armed.
    ///
    /// The group is minted on `a` and joined by `b` through the real functions, so the two hold
    /// one `group_id` and one key and differ in `device_id` — which is what makes their ops
    /// distinguishable and their stamps orderable against each other.
    fn pair_of_devices() -> (Connection, Connection, Identity, Identity) {
        let (a, b) = (db(), db());
        let me_a = ensure(&a).unwrap();
        let me_b = ensure(&b).unwrap();
        let g = create_group(&a, &me_a).unwrap();
        join_group(&b, &g.group_id, g.epoch, &g.group_key, &me_b).unwrap();
        add_device(&a, &me_b.device_id, &me_b.keypair.public, "Phone").unwrap();
        add_device(&b, &me_a.device_id, &me_a.keypair.public, "Desk").unwrap();
        capture::install(&a).unwrap();
        capture::install(&b).unwrap();
        (a, b, me_a, me_b)
    }

    /// Everything a device has said since `mark`, oldest first.
    fn since(conn: &Connection, mark: &mut i64) -> Vec<Op> {
        let sql = format!("{} WHERE seq > ?1 ORDER BY seq", capture::OPS_SELECT);
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(i64, Op)> = stmt
            .query_map([*mark], capture::op_from_row)
            .unwrap()
            .map(Result::unwrap)
            .collect();
        if let Some((seq, _)) = rows.last() {
            *mark = *seq;
        }
        rows.into_iter().map(|(_, op)| op).collect()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// A collection, a deck and a folder — one row in each synced table a device can fill on
    /// its own.
    fn build_a_collection_a_deck_and_a_folder(conn: &Connection) {
        for sql in [
            "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
             VALUES ('Binder', 'user', 1, unixepoch(), unixepoch())",
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',2,
                     (SELECT id FROM collection_folders WHERE name = 'Binder'),
                     unixepoch(),unixepoch())",
            "INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
             VALUES ('Shelf', 0, unixepoch(), unixepoch())",
            "INSERT INTO decks (name, format_key, folder_id, notes, created_at, updated_at)
             VALUES ('Atraxa', 'commander',
                     (SELECT id FROM deck_folders WHERE name = 'Shelf'),
                     'a plan', unixepoch(), unixepoch())",
            "INSERT INTO deck_categories
                (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
             VALUES ((SELECT id FROM decks WHERE name = 'Atraxa'),
                     'Ramp', 'main', 1, 1, unixepoch(), unixepoch())",
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, quantity, created_at, updated_at)
             VALUES ((SELECT id FROM decks WHERE name = 'Atraxa'),
                     (SELECT id FROM deck_categories WHERE name = 'Ramp'),
                     'live', 'c1', 'cmr', '1', 'en', 'Sol Ring', 1, unixepoch(), unixepoch())",
            "INSERT INTO deck_audit (deck_id, at, kind, payload, delta)
             VALUES ((SELECT id FROM decks WHERE name = 'Atraxa'), 100, 'add', '{}', 1)",
            "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
             VALUES ('To buy', 0, unixepoch(), unixepoch())",
            "INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Rhystic Study', 1,
                     (SELECT id FROM wishlist_folders WHERE name = 'To buy'),
                     unixepoch(), unixepoch())",
        ] {
            conn.execute(sql, []).unwrap();
        }
    }

    /// What the second device adds *into* what the first one built — the same deck, the same
    /// pile, the same binder — so the shared object is genuinely shared rather than two
    /// disjoint halves sitting in one database.
    fn add_to_what_the_other_device_built(conn: &Connection) {
        for sql in [
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
                 created_at,updated_at)
             VALUES ('c2','lea','2','en','foil','NM',3,
                     (SELECT id FROM collection_folders WHERE name = 'Binder'),
                     unixepoch(),unixepoch())",
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, quantity, created_at, updated_at)
             VALUES ((SELECT id FROM decks WHERE name = 'Atraxa'),
                     (SELECT id FROM deck_categories WHERE name = 'Ramp'),
                     'live', 'c2', 'cmr', '2', 'en', 'Cultivate', 1, unixepoch(), unixepoch())",
            // `deck_tags` is the app-wide palette and names no deck — `decks.tag_id` is the
            // side that points. Read off the head schema, not off the migration-era CREATE.
            "INSERT INTO deck_tags (name, name_key, color, created_at, updated_at)
             VALUES ('Brewing', 'brewing', 'green', unixepoch(), unixepoch())",
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
             VALUES ('oracle', 't1', 'ramp', unixepoch())",
        ] {
            conn.execute(sql, []).unwrap();
        }
    }

    /// **Spec §12.3, and the one test in this module whose failure is a reader losing cards.**
    ///
    /// A device's contributions outlive it. Removing a phone does not withdraw the cards it
    /// added, the decks it built or the folders it made — the collection is one object the
    /// whole group has been writing, and revocation ends a device's ability to keep writing
    /// rather than unwinding what it wrote.
    #[test]
    fn removing_a_device_changes_no_row_it_contributed() {
        let (a, b, me_a, _me_b) = pair_of_devices();
        let (mut ma, mut mb) = (0, 0);

        // A builds the shared object, B takes it and adds to it, A takes B's half back.
        build_a_collection_a_deck_and_a_folder(&a);
        assert_eq!(apply::apply(&b, &since(&a, &mut ma)).unwrap().deferred, 0);
        let _ = since(&b, &mut mb);
        add_to_what_the_other_device_built(&b);
        assert_eq!(apply::apply(&a, &since(&b, &mut mb)).unwrap().deferred, 0);

        // **The fixture is checked before it is trusted.** A convergence that quietly deferred
        // everything would leave B holding nothing of A's, and the comparison below would then
        // pass over an empty snapshot — which is how this test would fail vacuously.
        for table in [
            "collection_folders",
            "collection_entries",
            "deck_folders",
            "decks",
            "deck_categories",
            "deck_cards",
            "deck_audit",
            "deck_tags",
            "wishlist_folders",
            "wishlist_entries",
            "muted_tags",
        ] {
            assert!(count(&b, table) > 0, "{table} did not cross to B");
        }
        assert_eq!(
            count(&b, "collection_entries"),
            2,
            "one row from each device"
        );
        assert_eq!(count(&b, "deck_cards"), 2, "one pile, two contributors");
        let a_copies: i64 = b
            .query_row(
                "SELECT quantity FROM collection_entries WHERE card_id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(a_copies, 2, "A's two copies are B's rows now");

        let before = snapshot(&b);
        let key_before = group(&b).unwrap().unwrap().group_key;

        revoke_device(&b, &me_a.device_id).unwrap();

        // The removal really happened — otherwise the comparison below is about nothing.
        assert_ne!(group(&b).unwrap().unwrap().group_key, key_before);
        let departed = roster(&b)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == me_a.device_id)
            .expect("the removed device stays on the roster");
        assert!(departed.revoked_at.is_some());

        let after = snapshot(&b);
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>(),
            "a removal dropped or created a table"
        );
        for (table, rows) in &before {
            assert_eq!(
                after.get(table),
                Some(rows),
                "removing a device changed {table}, which holds rows it contributed"
            );
        }
    }

    /// §12.4: a rotation re-arms the baseline for the devices that remain, so the next sync
    /// repairs whatever the epoch boundary swallowed — and leaves the departed device's marker
    /// alone, because re-arming it would hand a full baseline to a peer that will never answer.
    #[test]
    fn a_rotation_re_arms_the_baseline_for_the_devices_that_remain() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "phone", &[9u8; 32], "Phone").unwrap();
        add_device(&conn, "tablet", &[8u8; 32], "Tablet").unwrap();
        conn.execute("UPDATE sync_devices SET baselined_at = 1000", [])
            .unwrap();
        assert_eq!(count(&conn, "sync_devices"), 3, "three on the roster");

        revoke_device(&conn, "tablet").unwrap();

        let marker = |id: &str| -> Option<i64> {
            conn.query_row(
                "SELECT baselined_at FROM sync_devices WHERE device_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(marker(&me.device_id), None, "this device was not re-armed");
        assert_eq!(marker("phone"), None, "the surviving peer was not re-armed");
        assert_eq!(
            marker("tablet"),
            Some(1000),
            "the removed device's marker must be left where it was"
        );
    }
}
