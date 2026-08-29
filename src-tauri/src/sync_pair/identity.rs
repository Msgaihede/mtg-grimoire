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
    if let Some(id) = read(conn)? {
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

    /// The name every install used to mint, and the one thing a minted name may never be.
    const OLD_SHARED_DEFAULT: &str = "This device";

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

    /// **An install that already has an identity keeps the name it has**, whatever this build
    /// would mint. The old default is the case that matters: a machine that paired before this
    /// change is still called "This device" and is renamed by the reader, never by a launch.
    #[test]
    fn an_existing_identity_is_never_renamed_by_ensure() {
        let conn = db();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'deadbeef', ?1, ?2, ?3, 0)",
            params![
                [1u8; 32].as_slice(),
                [2u8; 32].as_slice(),
                OLD_SHARED_DEFAULT
            ],
        )
        .unwrap();

        assert_eq!(ensure(&conn).unwrap().name, OLD_SHARED_DEFAULT);
        assert_eq!(ensure(&conn).unwrap().device_id, "deadbeef");
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
}
