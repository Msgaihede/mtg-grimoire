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

/// What [`plan_rotation`] says when it is pointed at this very device.
const CANNOT_REMOVE_SELF: &str = "This device cannot remove itself. Use Leave group instead.";

/// What [`plan_rotation`] says on a device that is in no group.
/// **`pub` since 2026-08-30**, because `pairing::leave_group_now` needs it. A second copy of a
/// user-facing sentence is how two screens come to disagree about one refusal, and
/// `client::post_rotation` already writes its own for want of this.
pub const NOT_IN_A_GROUP: &str = "This device is not in a pairing group.";

/// What [`plan_rotation`] says when the id names nobody on the roster.
const NOT_ON_THE_ROSTER: &str = "That device is not in this pairing group.";

/// How many devices one group may hold — spec §4.
///
/// **One number, and the relay spells it again in `groupauth.ts`.** That is not a duplication
/// that can be removed: this repository is public and readers build it, so a cap that lived only
/// here would be a suggestion, and the point of a device limit is precisely the case where
/// somebody has reason to exceed it. **The relay is the fence and this is the message** — what
/// this constant buys is that a reader meets the limit at the moment they press Pair rather than
/// at a sync three minutes later.
///
/// **Nothing checks the two against each other, and what a disagreement costs is the message
/// rather than the limit.** Spelled higher here, a sixth device pairs and is then refused a token
/// with `entitlement::GROUP_IS_FULL` — late, but correct. Spelled lower, a reader is refused a
/// slot the relay would have given them. Either way the fence holds and only the sentence is
/// wrong, which is why this is a duplication worth having rather than one worth engineering
/// away. The `device_limit` marker beside it is the pair that could **not** be left to drift —
/// see `sync_engine::entitlement::DEVICE_LIMIT` — and it is pinned by a test on each side.
pub const MAX_GROUP_DEVICES: usize = 5;

/// What [`room_for`] says to the sixth device — spec §4.3.
///
/// It names the number, because a refusal a reader cannot count against is one they will press
/// again. It also names the way out, which is a removal or a departure: both publish a manifest,
/// and a manifest is what frees a slot on the relay as well as here.
pub const GROUP_IS_FULL: &str = "This pairing group already has five devices, which is the \
     limit. Remove one from the list of devices before pairing another.";

/// Refuse a device that would be the sixth — the guard `pairing::confirm` and
/// `pairing::complete` open with.
///
/// **Live rows only, and that is the whole of the `filter`.** `revoked_at` stopped being written
/// when the manifest became the roster, but a database from a build before that can still hold a
/// stamped row — and a tombstone from last year must not cost a reader a slot they are entitled
/// to.
///
/// **`joining` is excluded from the count, so re-pairing a device already in the group is never
/// refused.** A ceremony with a device that is already on the roster grows nothing; refusing it
/// at five would mean a full group could never repair a pairing, which is the one case a reader
/// runs the ceremony again for. It is the relay's rule too — `admitDevice` upserts, so a device
/// already counted does not consume a second slot.
pub fn room_for(conn: &Connection, joining: &str) -> Result<(), String> {
    let live = roster(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|d| d.revoked_at.is_none() && d.device_id != joining)
        .count();
    if live >= MAX_GROUP_DEVICES {
        return Err(GROUP_IS_FULL.to_owned());
    }
    Ok(())
}

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
///
/// **It also files this device's name where the group can read it, which is what makes the name
/// travel at all** — see [`file_name_if_unfiled`]. This is the one place that can: nothing else
/// in the crate is called by every device on every pairing path and knows what this machine is
/// called. A device that has never filed one is a device every *other* device goes on calling
/// `DEFAULT_PEER_NAME`, because a joiner is never told the initiator's name and no later rename
/// crossed either. It is cheap here and nowhere else — `ensure` is called from the six pairing
/// entry points and from nothing on a hot path. [`plan_rotation`] deliberately reads the identity
/// instead of ensuring one, because it promises to write nothing at all.
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
        // **The far device does learn the new name from this, since user schema v31.** It used
        // to be the opposite: `sync_devices` holds keys and never syncs, so a name crossed only
        // at pairing and two devices already paired had to pair again for a rename to catch up.
        // `device_names` is the twelfth synced table and [`write_synced_name`] is the third
        // write here — an upgraded name now travels exactly like a typed one.
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
            // The upsert and not the `if_unfiled` arm: the name genuinely changed, and an
            // install carrying the placeholder may already have filed it under that string.
            write_synced_name(conn, &id.device_id, &minted)?;
            id.name = minted;
        }
        // **Every other existing install, which the upgrade above cannot reach.** A reader who
        // renamed before v31, or whose machine minted a real hostname on a build after
        // 2026-08-29, holds a perfectly good name that no device but this one has ever seen. One
        // `DO NOTHING` insert is the whole repair, and it cannot undo a rename that arrived from
        // the group because a row already there wins.
        file_name_if_unfiled(conn, &id.device_id, &id.name)?;
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
    // **A fresh install has to file its name too, or the joiner's "Paired device" is repaired
    // for nobody.** The upgrade above reaches installs carrying the old shared placeholder and
    // nothing else; a machine installed today mints a real hostname, never trips that branch,
    // and would have no `device_names` row at all — so the device that pairs *with* it goes on
    // reading `DEFAULT_PEER_NAME` for ever. The id is minted a line above and can collide with
    // nothing, so this is the upsert rather than the guarded arm.
    write_synced_name(conn, &device_id, &name)?;
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
///
/// **A synced name outranks the one the roster was filed under, and that is what repairs
/// "Paired device" without touching the pairing protocol.** `sync_devices.name` is whatever
/// this device learned at the ceremony, and the ceremony is asymmetric: `Invite` carries no
/// name at all and `pairing::respond` — the one place `peer_name` is set — runs on the
/// **initiator** alone, so a joiner has never learnt who it joined and files it under
/// `DEFAULT_PEER_NAME`. Measured on the real pair 2026-08-29: the desktop's roster read
/// `["main-game", "CPH2581"]` and the phone's read `["Paired device", "CPH2581"]`.
/// [`write_synced_name`] is the other end — once a real name reaches `device_names`, the
/// placeholder is simply outranked.
///
/// **`coalesce` over a `LEFT JOIN`, and both halves are load-bearing.** `device_names` is
/// synced and `sync_devices` deliberately is not, so a device can be on the roster with no
/// synced name — every peer of a build older than this one, and every peer whose first sync has
/// not landed yet. An inner join would not show them a stale name, it would **drop the rows**:
/// silent, total, and on a real group the roster would simply lose members.
pub fn roster(conn: &Connection) -> rusqlite::Result<Vec<Device>> {
    let mut stmt = conn.prepare(
        "SELECT d.device_id, d.public_key, coalesce(n.name, d.name), d.added_at, d.revoked_at
           FROM sync_devices d
           LEFT JOIN device_names n ON n.device_id = d.device_id
          ORDER BY d.added_at, d.device_id",
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
              --
              -- **Since spec §2.3 a removal deletes the row, so the ordinary re-pair takes the
              -- INSERT arm and never this one.** The clear stays for the databases written by
              -- builds that stamped: on those, a re-pair still has a row to un-stamp.
              revoked_at = NULL",
        params![device_id, public_key.as_slice(), name],
    )?;
    Ok(())
}

/// A name filed where the rest of the group can read it — `device_names`, the twelfth synced
/// table (user schema v31).
///
/// **The keys and the name had to be separated for a name to travel at all.** `sync_devices`
/// holds every device's public key and is deliberately absent from `schema::SYNCED_TABLES`, so
/// before this table a name crossed only during a pairing ceremony — and a later rename crossed
/// never. This table holds a `device_id` and a string and nothing else, which is what makes it
/// safe to put on the wire.
///
/// **The conflict target is `device_id` and never the `sync_uid`, which no caller here
/// supplies.** The capture trigger mints one on insert; a row written before the triggers are
/// installed is swept by `schema::mint_missing_uids`. Writing one by hand would be this module
/// naming a row the way the sync engine names it, in a second place.
fn write_synced_name(conn: &Connection, device_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at)
              VALUES (?1, ?2, unixepoch(), unixepoch())
         ON CONFLICT(device_id) DO UPDATE SET
              name = excluded.name,
              updated_at = unixepoch()",
        params![device_id, name],
    )?;
    Ok(())
}

/// File a name only if this device has never had one filed — the arm [`ensure`] uses, and the
/// one that must not overwrite.
///
/// **A row already there is the group's answer, not this device's.** By the time `ensure` runs
/// again, `device_names` may hold a name somebody typed on the *other* device and synced across;
/// an upsert here would replace it with whatever the hostname says and undo a rename the reader
/// made on a screen they were not looking at. `DO NOTHING` is what keeps the local write to the
/// one case it is for: a device that has never told the group what it is called.
fn file_name_if_unfiled(conn: &Connection, device_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO device_names (device_id, name, created_at, updated_at)
              VALUES (?1, ?2, unixepoch(), unixepoch())
         ON CONFLICT(device_id) DO NOTHING",
        params![device_id, name],
    )?;
    Ok(())
}

/// Rename a device on the roster — **this device's own copy of its name, when that is who is
/// being renamed, and the copy the rest of the group reads.**
///
/// Three statements, and none of them is tidiness.
///
/// `sync_identity.name` is the copy every pairing sends: [`create_group`] and [`join_group`]
/// both file this device on the roster under it, and `pairing::accept` seals it into the blob
/// the other device files this one by. Without that line a reader who renamed this device would
/// have the rename silently undone by their next pairing, and the roster row on the *other*
/// device would have been wrong from the start.
///
/// [`write_synced_name`] is the third, and it is the only one that reaches a device the reader
/// is not standing in front of. `sync_devices` does not sync, so until user schema v31 a rename
/// crossed **only** during a pairing ceremony — two devices already paired kept two different
/// names for one machine for ever, with nothing on either screen to say so.
///
/// **All three, not one.** `sync_devices` is what this device draws today, before any sync has
/// run; `sync_identity` is what the next pairing sends; `device_names` is what the group reads.
/// Dropping any of them leaves a name that is right in one place and wrong in another.
pub fn rename_device(conn: &Connection, device_id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_devices SET name = ?2 WHERE device_id = ?1",
        params![device_id, name],
    )?;
    conn.execute(
        "UPDATE sync_identity SET name = ?2 WHERE id = 1 AND device_id = ?1",
        params![device_id, name],
    )?;
    write_synced_name(conn, device_id, name)
}

/// A rotation that has been worked out and has **not happened yet**.
///
/// The whole of the split between [`plan_rotation`] and [`commit_rotation`] is that this value
/// can exist while the database is untouched. The removing device hands `keys` and `auth` to the
/// relay, and only an accepted `POST /g/{group}/rotate` earns the right to write `group`.
///
/// `keys` is `(device_id, sealed blob)` for every device that **stays**, this one included — the
/// remover is on its own manifest, so a rotation the relay accepted and a local commit that then
/// failed heals itself at the next `/keys` check rather than stranding the device that did the
/// removing. Its device ids, taken together, are the manifest, which is the roster from the
/// moment the relay stores them.
pub struct Rotation {
    pub group: Group,
    pub keys: Vec<(String, Vec<u8>)>,
    pub auth: String,
}

/// What a removal says in a group no membership has ever been connected to — spec §2.4's fourth
/// refusal, beside [`CANNOT_REMOVE_SELF`], [`NOT_IN_A_GROUP`] and [`NOT_ON_THE_ROSTER`].
///
/// **The relay is what carries a removal to the other devices, and only a claimed group has an
/// auth the relay will accept.** Rotating locally anyway is exactly the bug this whole change
/// exists to end: the removing device moves to epoch *N+1* and every other device stalls at *N*
/// the moment somebody finally connects. It is an honest answer rather than a limitation —
/// until a membership exists nothing is syncing, so there is nothing a removal would protect.
///
/// It is checked by the command that has a relay in front of it (`pairing::sync_device_revoke`),
/// not by [`plan_rotation`], because this module has no opinion about entitlements and the
/// question "does this group have a membership" is one only the relay can answer.
pub const NO_MEMBERSHIP: &str = "Removing a device changes the key your devices share, and that \
     change has to reach the others through the relay. Connect a membership first.";

/// What [`adopt_epoch`] says when it is handed an epoch that is not ahead of this device's.
///
/// **The guard is load-bearing and the caller has one too** — spec §2.3. A group that has claimed
/// but never rotated holds one `group_keys` row with an *empty* manifest, so every device in it
/// reads `blob: null` and `devices: []`. Comparing the epochs first is the whole of what stops
/// every device in a healthy never-rotated group concluding it has been removed. Equal epochs
/// mean nothing to do, and this refuses loudly rather than sweeping a roster against a manifest
/// that was never about this device.
const NOT_A_NEWER_EPOCH: &str = "that key manifest is not ahead of this device";

/// Work out the rotation a removal needs, **without writing a single row.**
///
/// **That separation is the fix rather than a tidiness.** The version this replaced committed the
/// rotation first and unconditionally, so a device that pressed Remove ended up holding a key
/// nobody else could ever learn: it pushed at epoch *N+1* while every remaining device sat at
/// *N*, `client::pull` set `behind = true` and held its cursor for ever, and one removal bricked
/// any group of three. Nothing here touches the database, so a `/rotate` that is refused or
/// unreachable leaves the group exactly as it was and the reader can press again.
///
/// It reads the identity rather than [`ensure`]ing one, because "writes nothing" has to be
/// literally true: `ensure` mints on absence and can file a name, and a planning call that
/// wrote three rows on a first run would make the claim above a lie in the one case nobody
/// tests. A device with no identity is in no group, which is what it is told.
///
/// **The three refusals are the ones the deleted `revoke_device` carried**, moved here because
/// this is now
/// the first thing a removal does. This device cannot remove itself — "leave the group" is a
/// different press with different consequences, and collapsing the two would let a mis-click cost
/// the reader the group they are standing in. A device in no group has nothing to rotate. And an
/// id nobody on the roster answers to rotates nothing: a rotation locks every remaining device
/// out of what came before it, so one with nobody removed is a cost with no cause.
///
/// **The manifest never names the device being removed**, and that is the one line in this
/// function whose absence would undo the whole feature — a manifest naming it is the roster
/// saying it is still a member, on every device that adopts.
///
/// **What a rotation does not do is withdraw anything the removed device contributed** — spec
/// §12.3. The collection is one object the whole group has been writing, and a phone's cards,
/// decks and folders are rows in every device's tables by the time it leaves. Removal ends a
/// device's ability to keep *writing*; nothing here deletes, re-parents or re-counts a row it
/// wrote, and `removing_a_device_changes_no_row_it_contributed` is what holds that true. Note the
/// consequence for anyone tempted to add such a sweep later: a row carries no author. Its
/// `sync_uid` is `lower(hex(randomblob(16)))` and `apply` records no ops of its own, so on the
/// remaining devices there is nothing that even *says* which device a row came from.
pub fn plan_rotation(conn: &Connection, removing: &str) -> Result<Rotation, String> {
    let Some(me) = read(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    // **The self-refusal stays here rather than moving into [`plan`]** — spec §2.1. Removing
    // somebody else and leaving yourself are different acts with different consequences, and a
    // single entrance that accepted either would let a mis-click on a roster row throw this
    // device's own key away. [`plan_departure`] is the other entrance, and it is a press of its
    // own with a confirmation of its own.
    if me.device_id == removing {
        return Err(CANNOT_REMOVE_SELF.to_owned());
    }
    plan(conn, removing)
}

/// Work out the rotation **this device's own departure** needs, writing nothing — spec §2.1.
///
/// [`plan_rotation`] with the self-check inverted rather than relaxed: the manifest is everyone
/// **except** this device, so the group closes behind the leaver on every device that adopts,
/// exactly as a removal does.
///
/// **The leaver mints the key the devices that stay will use, and that is not new exposure.** A
/// device that wanted to go on reading the group would simply *not leave* and would keep the key
/// it already has; leaving is voluntary, so the threat this would defend against is one the
/// actor has already declined to be. Spec §2.2 carries the argument in full.
///
/// **What it does not do is decide whether the departure happens.** Publishing is best effort and
/// the local clear is unconditional — `pairing::leave_group_now` owns that order, because
/// *"leaving is always possible"* is a promise about the whole press rather than about the plan.
pub fn plan_departure(conn: &Connection) -> Result<Rotation, String> {
    let Some(me) = read(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    plan(conn, &me.device_id)
}

/// The body both entrances share. **It asks nothing about who `removing` is** — that is the one
/// question its two callers answer differently, and the whole reason they are two functions.
fn plan(conn: &Connection, removing: &str) -> Result<Rotation, String> {
    let Some(me) = read(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    let Some(current) = group(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    let members = roster(conn).map_err(|e| e.to_string())?;
    if !members.iter().any(|d| d.device_id == removing) {
        return Err(NOT_ON_THE_ROSTER.to_owned());
    }

    let rotated = Group {
        group_id: current.group_id,
        epoch: current.epoch + 1,
        group_key: crypto::random_bytes::<32>(),
    };
    let mut keys = Vec::with_capacity(members.len());
    for peer in &members {
        // **The departing device, and any row an older build stamped, are both left off.** The
        // stamp stopped being written by `commit_rotation`, but a database that predates this
        // change can still hold one — and a manifest naming such a device would put it back in
        // the group on every device that adopts this epoch.
        if peer.device_id == removing || peer.revoked_at.is_some() {
            continue;
        }
        let blob = crypto::wrap_group_key(
            &me.keypair.secret,
            &peer.public_key,
            &rotated.group_id,
            &peer.device_id,
            rotated.epoch,
            &rotated.group_key,
        )
        .map_err(|e| e.to_string())?;
        keys.push((peer.device_id.clone(), blob));
    }
    let auth = crypto::relay_auth(&rotated.group_key, &rotated.group_id, rotated.epoch);
    Ok(Rotation {
        group: rotated,
        keys,
        auth,
    })
}

/// Write the rotation the relay has already accepted. **Only on success**, and never before.
///
/// One transaction, three statements, and the order of the first two is what the third depends
/// on.
///
/// **A rotation re-arms the baseline for everybody who stays.** Spec §12.4: the new epoch makes
/// every op written before it unreadable, and `client::pull` steps over a lower-epoch envelope
/// rather than stalling on it — so a peer's last words can be lost at the boundary. Re-baselining
/// under the new key carries them across as ordinary rows. Claims resolve by `max` and a horizon
/// only filters, so this cannot double-count.
pub fn commit_rotation(
    conn: &Connection,
    removing: &str,
    rotation: &Rotation,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // **Deleted, not stamped, and this reverses §7.6.** The relay's manifest is the roster now
    // (spec §2.3), so a device the manifest omits has no row on any *other* device — and a
    // remover that kept a tombstone would be the one machine in the group with a different
    // answer about who is in it. `baseline::peers_needing` reads `WHERE revoked_at IS NULL`,
    // which a deleted row satisfies just as well, and `add_device` still puts a re-paired device
    // back — by insert now rather than by clearing the stamp. The column stays in the schema for
    // the migration's sake and stops being written.
    tx.execute(
        "DELETE FROM sync_devices WHERE device_id = ?1",
        params![removing],
    )
    .map_err(|e| e.to_string())?;
    // **After the delete, not before**, which is what makes the `WHERE` clause enough: the
    // departed row is gone, so re-arming cannot hand a full baseline to a peer that is never
    // going to answer. `revoked_at IS NULL` is still read because a database written by an
    // older build can hold a stamped row this removal did not touch.
    tx.execute(
        "UPDATE sync_devices SET baselined_at = NULL WHERE revoked_at IS NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    write_group(&tx, &rotation.group).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Take the group key some other device rotated to, and take its manifest as the roster.
///
/// This is the other end of [`plan_rotation`] and the half that carries a removal to the devices
/// that were not doing the removing. `blob` is what `GET /g/{group}/keys?device=<me>` answered and
/// `manifest` is the `devices` beside it.
///
/// **The manifest is the roster, so every row it omits is deleted** — spec §2.3. It is
/// deliberately not a thirteenth synced table: a manifest that *is* the key distribution cannot
/// disagree with it, where a synced `device_removals` table could arrive late, arrive out of
/// order, or arrive at a device that cannot decrypt it — which is precisely the state a rotation
/// puts every peer in.
///
/// **This device's own row is never swept, whatever the manifest says.** A blob that unwrapped is
/// one the remover sealed to *this* device at *this* epoch, so this device is in the group by
/// construction; obeying a manifest that omitted it would leave a device in a group whose roster
/// does not contain itself, which nothing downstream is written to survive.
///
/// **The epoch guard is checked here as well as by the caller**, for [`NOT_A_NEWER_EPOCH`]'s
/// reason.
pub fn adopt_epoch(
    conn: &Connection,
    from_device: &str,
    epoch: i64,
    blob: &[u8],
    manifest: &[String],
) -> Result<(), String> {
    let Some(me) = read(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    let Some(current) = group(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_IN_A_GROUP.to_owned());
    };
    if epoch <= current.epoch {
        return Err(NOT_A_NEWER_EPOCH.to_owned());
    }
    // The remover's own public key, off this device's roster. Nothing about a rotation crosses
    // in the clear that the target could not already authenticate.
    let their_public = conn
        .query_row(
            "SELECT public_key FROM sync_devices WHERE device_id = ?1",
            params![from_device],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .map(bytes32)
        .ok_or_else(|| NOT_ON_THE_ROSTER.to_owned())?;
    let new_key = crypto::unwrap_group_key(
        &me.keypair.secret,
        &their_public,
        &current.group_id,
        &me.device_id,
        epoch,
        blob,
    )
    .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    write_group(
        &tx,
        &Group {
            // **The group id must not move.** A rotation replaces the key and the epoch and
            // nothing else; a new id here would be this device silently founding a second group.
            group_id: current.group_id.clone(),
            epoch,
            group_key: new_key,
        },
    )
    .map_err(|e| e.to_string())?;

    let mut stays: Vec<&str> = manifest.iter().map(String::as_str).collect();
    stays.push(&me.device_id);
    let holes: Vec<String> = (1..=stays.len()).map(|n| format!("?{n}")).collect();
    tx.execute(
        &format!(
            "DELETE FROM sync_devices WHERE device_id NOT IN ({})",
            holes.join(", ")
        ),
        rusqlite::params_from_iter(stays),
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Leave the group entirely: the key, the epoch and the whole roster.
///
/// **What a removed device does when `/keys` answers a higher epoch and no blob for it** — spec
/// §2.4. That is positive evidence rather than a guess: the manifest is the roster, so a device
/// the current epoch's manifest does not name is a device that has been taken off.
///
/// **It is also what a device that leaves of its own accord does** — `pairing::leave_group_now`,
/// after [`plan_departure`] has been published — and the two callers are the reason the grant is
/// still not touched here. Being removed and choosing to go are different events with different
/// sentences on the panel; this function is the half they have in common.
///
/// **`sync_identity` survives, and that is the difference between leaving and being reinstalled.**
/// The device id is what the hybrid logical clock breaks ties on and what every op this device
/// ever wrote is stamped with; re-minting it here would fork the reader's own history for the
/// sake of a row that costs nothing to keep. The reader's collection is untouched too, which is
/// what `REMOVAL_WARNING` already promises them.
///
/// **The grant keys are the caller's to decide about and are deliberately not touched here.**
/// This module knows about groups and nothing about Patreon: the removed device may be the very
/// one holding the refresh secret — the reader selling a laptop removes it from the phone — and
/// throwing that secret away would cost them the membership rather than the pairing.
/// `client::check_keys` is where the two facts sit side by side.
pub fn leave_group(conn: &Connection) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sync_devices", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sync_group", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
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
    /// Plan and commit in one breath, which is what these tests want and what **no production
    /// path may have**. The relay stands between the two now — `pairing::remove_device` is
    /// `plan_rotation` → `POST /g/{group}/rotate` → `commit_rotation` — so the pair exists as
    /// one call only here, where there is no relay to stand in the middle. The deleted
    /// `identity::revoke_device` was exactly this and was `pub`, which put committing a rotation
    /// nobody had accepted one call away from any caller in the crate.
    fn remove(conn: &Connection, device_id: &str) -> Result<Group, String> {
        let plan = plan_rotation(conn, device_id)?;
        commit_rotation(conn, device_id, &plan)?;
        Ok(plan.group)
    }

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

    /// Revocation rotates the key, bumps the epoch, and takes the removed device **off** the
    /// roster — spec §2.3, which reverses §7.6. The manifest the relay stores is the roster now,
    /// so a tombstone here would make the removing device the one machine in the group with a
    /// different answer about who is in it.
    #[test]
    fn revoking_a_device_rotates_the_key_and_bumps_the_epoch() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();

        let before = group(&conn).unwrap().unwrap();
        remove(&conn, "deadbeef").unwrap();
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

        assert!(
            !roster(&conn)
                .unwrap()
                .iter()
                .any(|d| d.device_id == "deadbeef"),
            "the removed device is still on the roster"
        );
        // ...and only that one went. A delete that swept the whole table would satisfy the
        // assertion above and leave this device in a group with no roster row of its own.
        assert_eq!(
            count(&conn, "sync_devices"),
            1,
            "this device and nobody else"
        );
    }

    /// This device cannot remove itself. "Leave the group" is a different command with
    /// different consequences, and confusing the two loses the reader their key.
    #[test]
    fn this_device_cannot_revoke_itself() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        assert!(remove(&conn, &me.device_id).is_err());
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

        assert!(remove(&conn, "nobody").is_err());

        assert_eq!(group(&conn).unwrap().unwrap(), before);
    }

    /// Removing a device means nothing on a device that is in no group, and it says so rather
    /// than minting one.
    #[test]
    fn an_unpaired_device_cannot_revoke() {
        let conn = db();
        ensure(&conn).unwrap();
        assert!(remove(&conn, "deadbeef").is_err());
        assert!(group(&conn).unwrap().is_none());
    }

    /// Re-pairing a device that was removed puts it back. The reader pressed Pair and
    /// compared six digits; refusing them would be the app disagreeing with what it just asked.
    ///
    /// **By insert now rather than by clearing a stamp** — spec §2.3 deletes the row — and the
    /// assertions below do not care which, which is the point: the roster afterwards says the
    /// same thing either way.
    #[test]
    fn adding_a_removed_device_again_puts_it_back() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "deadbeef", &[9u8; 32], "Phone").unwrap();
        remove(&conn, "deadbeef").unwrap();

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

        remove(&b, &me_a.device_id).unwrap();

        // The removal really happened — otherwise the comparison below is about nothing.
        assert_ne!(group(&b).unwrap().unwrap().group_key, key_before);
        assert!(
            !roster(&b)
                .unwrap()
                .iter()
                .any(|d| d.device_id == me_a.device_id),
            "the removed device's row is gone, not stamped — spec §2.3"
        );

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
    /// repairs whatever the epoch boundary swallowed — and does not re-arm the departed device,
    /// because a full baseline for a peer that will never answer is work nobody collects.
    ///
    /// **The departed row is gone rather than carrying its old marker** — spec §2.3 — so what
    /// used to be asserted about its `baselined_at` is now asserted about the row's absence.
    /// That is a stronger claim, not a weaker one: a stamped row with `baselined_at = 1000` and
    /// a deleted row are indistinguishable to `peers_needing`, and only one of them is also
    /// invisible to `roster`.
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

        remove(&conn, "tablet").unwrap();

        let marker = |id: &str| -> Option<Option<i64>> {
            conn.query_row(
                "SELECT baselined_at FROM sync_devices WHERE device_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
        };
        assert_eq!(
            marker(&me.device_id),
            Some(None),
            "this device was not re-armed"
        );
        assert_eq!(
            marker("phone"),
            Some(None),
            "the surviving peer was not re-armed"
        );
        assert_eq!(
            marker("tablet"),
            None,
            "the removed device has no row left to carry a marker"
        );
        assert_eq!(count(&conn, "sync_devices"), 2, "and nobody else was swept");
    }

    // -------------------------------------------------------------------------------------
    // Rotation as two halves, and the manifest that is the roster — spec §2.3 and §2.4
    // -------------------------------------------------------------------------------------

    /// A planned rotation writes nothing — which is what stops the app holding a key rotation the
    /// relay never accepted, and it is the difference from `revoke_device` as it stood.
    #[test]
    fn planning_a_rotation_changes_no_row() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "phone", &[9u8; 32], "Phone").unwrap();
        add_device(&conn, "tablet", &[8u8; 32], "Tablet").unwrap();

        let before = group(&conn).unwrap().unwrap();
        let plan = plan_rotation(&conn, "tablet").expect("plan");

        assert_eq!(group(&conn).unwrap().unwrap(), before, "the group moved");
        assert_eq!(count(&conn, "sync_devices"), 3, "a row was written");
        // The plan itself really did mint something, or the assertions above are about nothing.
        assert_eq!(plan.group.epoch, before.epoch + 1);
        assert_ne!(plan.group.group_key, before.group_key);
        // One blob per device that STAYS — this one and the phone — and never for the departing
        // one. A manifest naming the removed device would put it back in the group it just left.
        assert_eq!(plan.keys.len(), 2);
        assert!(plan.keys.iter().all(|(id, _)| id != "tablet"));
        assert_eq!(
            plan.auth,
            crate::sync_pair::crypto::relay_auth(
                &plan.group.group_key,
                &plan.group.group_id,
                plan.group.epoch
            )
        );
    }

    /// **A departure names everyone but this device** — spec §2.1, and the inversion of the line
    /// above.
    ///
    /// Red if the manifest includes this device (the group would go on listing a device that has
    /// gone, and the leaver would be handed a key it is not keeping), or if it omits a peer (a
    /// device that stayed would be dropped from the group by somebody else's departure). The
    /// epoch, the key and the auth are asserted for `planning_a_rotation_changes_no_row`'s
    /// reason: without them a `plan_departure` that returned an empty rotation would pass the
    /// two membership checks.
    #[test]
    fn a_departure_names_everyone_but_this_device() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "phone", &[9u8; 32], "Phone").unwrap();
        add_device(&conn, "tablet", &[8u8; 32], "Tablet").unwrap();

        let before = group(&conn).unwrap().unwrap();
        let plan = plan_departure(&conn).expect("plan a departure");

        let named: Vec<&str> = plan.keys.iter().map(|(id, _)| id.as_str()).collect();
        assert!(
            !named.contains(&me.device_id.as_str()),
            "the leaver is on its own manifest, so the group never closes behind it: {named:?}"
        );
        assert!(named.contains(&"phone"), "a device that stays was dropped");
        assert!(named.contains(&"tablet"), "a device that stays was dropped");
        assert_eq!(named.len(), 2);

        // It really is a rotation, and it wrote nothing.
        assert_eq!(plan.group.epoch, before.epoch + 1);
        assert_ne!(plan.group.group_key, before.group_key);
        assert_eq!(
            plan.auth,
            crate::sync_pair::crypto::relay_auth(
                &plan.group.group_key,
                &plan.group.group_id,
                plan.group.epoch
            )
        );
        assert_eq!(group(&conn).unwrap().unwrap(), before, "the group moved");
        assert_eq!(count(&conn, "sync_devices"), 3, "a row was written");
    }

    /// **[`plan_rotation`] still refuses to remove this device**, now that a departure has an
    /// entrance of its own — spec §2.1.
    ///
    /// `this_device_cannot_revoke_itself` above drives the same refusal through the plan-and-
    /// commit pair; this one asks `plan_rotation` directly, so a guard *bypassed* by the new
    /// entrance and a guard *relaxed* are told apart. Red if `plan_rotation` starts answering
    /// `Ok` for this device's own id — which is what collapsing the two entrances into one would
    /// do, and what would let a mis-click on a roster row throw this device's key away.
    #[test]
    fn plan_rotation_still_refuses_to_remove_this_device() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "phone", &[9u8; 32], "Phone").unwrap();

        // `.err().as_deref()` rather than `expect_err`, because `Rotation` is deliberately not
        // `Debug` — a panic message printing one would put a group key in a CI log.
        assert_eq!(
            plan_rotation(&conn, &me.device_id).err().as_deref(),
            Some(CANNOT_REMOVE_SELF),
            "this device may not remove itself through the removal entrance"
        );

        // ...and the other entrance is the one that does it, so the refusal above is a fence
        // rather than an absence of the feature.
        assert!(plan_departure(&conn).is_ok());
    }

    /// A device in no group has nothing to leave, and both entrances say so.
    #[test]
    fn an_unpaired_device_cannot_plan_a_departure() {
        let conn = db();
        ensure(&conn).unwrap();
        assert_eq!(plan_departure(&conn).err().as_deref(), Some(NOT_IN_A_GROUP));
    }

    /// The cap counts **live rows only** — spec §4.3 — and never the device being admitted.
    ///
    /// Three readings in one test, because each is a different way to get the arithmetic wrong.
    /// Red if the guard is off by one at either end, if a tombstone from a pre-manifest build
    /// costs a reader a slot, or if a device already on the roster is made to consume a second.
    #[test]
    fn the_device_cap_counts_live_rows_and_never_the_joiner() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        for n in 1..=3u8 {
            add_device(&conn, &format!("peer{n}"), &[n; 32], "Peer").unwrap();
        }
        assert_eq!(roster(&conn).unwrap().len(), 4, "four live devices");
        assert!(
            room_for(&conn, "newcomer").is_ok(),
            "a fifth device is inside the limit"
        );

        // A tombstone an older build stamped is not a member and must cost nobody a slot.
        add_device(&conn, "ghost", &[9u8; 32], "Ghost").unwrap();
        conn.execute(
            "UPDATE sync_devices SET revoked_at = unixepoch() WHERE device_id = 'ghost'",
            [],
        )
        .unwrap();
        assert_eq!(roster(&conn).unwrap().len(), 5, "four live and one stamped");
        assert!(
            room_for(&conn, "newcomer").is_ok(),
            "a stale tombstone cost a reader a slot"
        );

        // The fifth live device fills the group.
        add_device(&conn, "peer4", &[4u8; 32], "Peer").unwrap();
        assert_eq!(
            room_for(&conn, "newcomer").unwrap_err(),
            GROUP_IS_FULL,
            "a sixth device was admitted"
        );
        // ...and a device already in it is not a sixth of anything.
        assert!(
            room_for(&conn, "peer4").is_ok(),
            "re-pairing a device already in a full group was refused"
        );
    }

    /// A device the manifest omits is off the roster, and the row is **deleted** rather than
    /// stamped — because the manifest is the roster, and a tombstone here would make this device
    /// the only one in the group with a different answer about who is in it.
    #[test]
    fn adopting_an_epoch_drops_everyone_the_manifest_omits() {
        // B's database: it is in a group with A and with a tablet.
        let b = db();
        let me_b = ensure(&b).unwrap();
        let remover = crate::sync_pair::crypto::keypair();
        create_group(&b, &me_b).unwrap();
        add_device(&b, "dev-a", &remover.public, "Desk").unwrap();
        add_device(&b, "tablet", &[8u8; 32], "Tablet").unwrap();
        let before = group(&b).unwrap().unwrap();

        // A rotated, removing the tablet, and sealed the new key to B.
        let new_key = [42u8; 32];
        let epoch = before.epoch + 1;
        let blob = crate::sync_pair::crypto::wrap_group_key(
            &remover.secret,
            &me_b.keypair.public,
            &before.group_id,
            &me_b.device_id,
            epoch,
            &new_key,
        )
        .unwrap();

        adopt_epoch(
            &b,
            "dev-a",
            epoch,
            &blob,
            &[me_b.device_id.clone(), "dev-a".to_owned()],
        )
        .expect("adopt");

        let after = group(&b).unwrap().unwrap();
        assert_eq!(after.epoch, epoch);
        assert_eq!(after.group_key, new_key, "B did not take the new key");
        assert_eq!(
            after.group_id, before.group_id,
            "the group id must not move"
        );

        let ids: Vec<String> = roster(&b)
            .unwrap()
            .into_iter()
            .map(|d| d.device_id)
            .collect();
        assert!(
            !ids.contains(&"tablet".to_owned()),
            "the tablet is still here"
        );
        assert_eq!(ids.len(), 2, "and nobody else was swept");
        // Deleted, not stamped. A stamped row would still satisfy the assertion above.
        assert_eq!(count(&b, "sync_devices"), 2);
    }

    /// **Three devices, and the case that is broken on `main`.** A removes C; B adopts the
    /// rewrapped key and reaches A's epoch, so an envelope A seals is one B can open. Before this
    /// PR nothing distributes the key: B stalls at the old epoch, `client::pull` sets
    /// `behind = true` and holds its cursor for ever, and one removal bricks any group of three.
    ///
    /// It asserts against `wire`, not against the epoch number, because the number agreeing is not
    /// the property that matters — being able to read what the group says is.
    #[test]
    fn a_third_device_adopts_the_rotated_key_and_catches_up() {
        use crate::sync_engine::hlc::Hlc;
        use crate::sync_engine::merge::Kind;
        use crate::sync_engine::wire;

        let a = db();
        let me_a = ensure(&a).unwrap();
        create_group(&a, &me_a).unwrap();

        let b = db();
        let me_b = ensure(&b).unwrap();
        let start = group(&a).unwrap().unwrap();
        join_group(&b, &start.group_id, start.epoch, &start.group_key, &me_b).unwrap();
        add_device(&a, &me_b.device_id, &me_b.keypair.public, "Phone").unwrap();
        add_device(&b, &me_a.device_id, &me_a.keypair.public, "Desk").unwrap();
        add_device(&a, "tablet", &[8u8; 32], "Tablet").unwrap();
        add_device(&b, "tablet", &[8u8; 32], "Tablet").unwrap();

        // A removes the tablet and the rotation is accepted by a relay this test stands in for.
        let plan = plan_rotation(&a, "tablet").expect("plan");
        commit_rotation(&a, "tablet", &plan).expect("commit");

        // What A now says is unreadable to B until B adopts — the bug, asserted before the fix.
        let ops = vec![Op {
            table: "decks".to_owned(),
            uid: "0123456789abcdef0123456789abcdef".to_owned(),
            kind: Kind::Put,
            fields: BTreeMap::new(),
            counters: BTreeMap::new(),
            parents: BTreeMap::new(),
            at: Hlc {
                ms: 1_787_000_000_000,
                ctr: 0,
                device: me_a.device_id.clone(),
            },
            baseline: false,
            horizon: None,
        }];
        let envelope =
            wire::seal_batch(&group(&a).unwrap().unwrap(), &me_a.device_id, &ops).unwrap();
        assert!(
            wire::open_batch(&group(&b).unwrap().unwrap(), &envelope).is_err(),
            "B could already read this, so the test proves nothing"
        );

        let blob = plan
            .keys
            .iter()
            .find(|(id, _)| id == &me_b.device_id)
            .map(|(_, blob)| blob.clone())
            .expect("B is on the manifest");
        let manifest: Vec<String> = plan.keys.iter().map(|(id, _)| id.clone()).collect();
        adopt_epoch(&b, &me_a.device_id, plan.group.epoch, &blob, &manifest).expect("adopt");

        assert_eq!(
            wire::open_batch(&group(&b).unwrap().unwrap(), &envelope).expect("B opens it"),
            ops,
            "B adopted the key and still cannot read A"
        );
        assert!(
            !roster(&b).unwrap().iter().any(|d| d.device_id == "tablet"),
            "and the removal reached B's roster"
        );
    }

    /// **A group that claimed and never rotated leaves every device alone** — spec §2.3's ⚠️,
    /// and the case where a missing guard dissolves a healthy group rather than merely failing.
    ///
    /// Such a group has one `group_keys` row at the claim's epoch with an *empty* manifest, so
    /// every device in it reads `blob: null` and `devices: []`. Comparing the epochs first is the
    /// whole of what stops all of them concluding they have been removed. The guard is checked by
    /// the caller too; this is the half that cannot be bypassed by getting that wrong.
    #[test]
    fn adopting_an_epoch_that_is_not_ahead_is_refused_and_sweeps_nothing() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        let phone = crypto::keypair();
        add_device(&conn, "phone", &phone.public, "Phone").unwrap();
        let before = group(&conn).unwrap().unwrap();

        // **A blob that opens.** Handing this an unreadable one would make the test pass on the
        // unwrap failing, and it would then say nothing about the guard: only the epoch stands
        // between this device and a swept roster.
        let blob = crypto::wrap_group_key(
            &phone.secret,
            &me.keypair.public,
            &before.group_id,
            &me.device_id,
            before.epoch,
            &[42u8; 32],
        )
        .unwrap();

        // The empty manifest a never-rotated group answers, at the epoch it is already on.
        let err = adopt_epoch(&conn, "phone", before.epoch, &blob, &[]).unwrap_err();

        assert_eq!(err, NOT_A_NEWER_EPOCH);
        assert_eq!(group(&conn).unwrap().unwrap(), before, "the group moved");
        assert_eq!(
            count(&conn, "sync_devices"),
            2,
            "an empty manifest emptied the roster"
        );
    }

    /// A removed device leaves the group and **keeps its identity** — spec §2.4.
    ///
    /// The device id is the hybrid logical clock's deterministic tiebreak and the stamp on every
    /// op this device ever wrote, so re-minting it here would fork the reader's own history for
    /// the sake of a row that costs nothing to keep.
    #[test]
    fn leaving_the_group_keeps_this_devices_identity() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "phone", &[9u8; 32], "Phone").unwrap();
        assert!(
            group(&conn).unwrap().is_some(),
            "the fixture is about a group"
        );

        leave_group(&conn).unwrap();

        assert!(
            group(&conn).unwrap().is_none(),
            "the key and epoch are gone"
        );
        assert_eq!(
            count(&conn, "sync_devices"),
            0,
            "and the whole roster with it"
        );
        let still = ensure(&conn).unwrap();
        assert_eq!(still.device_id, me.device_id, "the identity was re-minted");
        assert_eq!(still.keypair.secret, me.keypair.secret);
    }

    // -------------------------------------------------------------------------------------
    // `device_names` — the name the group reads, user schema v31
    // -------------------------------------------------------------------------------------

    /// A device's synced name, or `None` if it has never filed one.
    fn synced_name(conn: &Connection, device_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT name FROM device_names WHERE device_id = ?1",
            params![device_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// **A rename is recorded where it can travel, as well as where it is read locally.**
    ///
    /// `sync_devices` holds the keys and never syncs, so before v31 a rename reached the other
    /// device only if the reader paired again — which nobody does to fix a label.
    #[test]
    fn renaming_writes_the_synced_name() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();

        rename_device(&conn, &me.device_id, "Kitchen tablet").unwrap();

        assert_eq!(
            synced_name(&conn, &me.device_id).as_deref(),
            Some("Kitchen tablet")
        );
        assert_eq!(roster(&conn).unwrap()[0].name, "Kitchen tablet");
        // The two local copies the rename has always written are still written.
        assert_eq!(ensure(&conn).unwrap().name, "Kitchen tablet");
    }

    /// **A synced name outranks the local roster copy**, which is what makes an arriving rename
    /// visible and what quietly repairs "Paired device" on the first sync.
    #[test]
    fn a_synced_name_outranks_the_placeholder_the_roster_was_filed_under() {
        let conn = db();
        add_device(&conn, "dev-b", &[9u8; 32], "Paired device").unwrap();
        conn.execute(
            "INSERT INTO device_names (device_id, name, created_at, updated_at, sync_uid)
             VALUES ('dev-b', 'MAIN-PC', 0, 0, 'u1')",
            [],
        )
        .unwrap();

        let row = roster(&conn)
            .unwrap()
            .into_iter()
            .find(|d| d.device_id == "dev-b")
            .expect("the roster row is still there");
        assert_eq!(row.name, "MAIN-PC");
    }

    /// ...and a device with no synced name still reads the name it was filed under, **and is
    /// still on the list at all**.
    ///
    /// This is what the `LEFT` in the join is for, and the failure it prevents is not a stale
    /// name: an inner join drops every device that has filed none — every peer on a build older
    /// than v31, and every peer whose first sync has not landed — so a real group would silently
    /// lose roster rows with nothing on the screen to say why.
    #[test]
    fn a_device_with_no_synced_name_keeps_its_local_one() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        add_device(&conn, "dev-b", &[9u8; 32], "Phone").unwrap();
        assert_eq!(
            synced_name(&conn, "dev-b"),
            None,
            "the fixture is only about a device that has filed nothing"
        );

        let list = roster(&conn).unwrap();
        assert_eq!(
            list.len(),
            2,
            "a device with no synced name is still on the roster"
        );
        let phone = list
            .into_iter()
            .find(|d| d.device_id == "dev-b")
            .expect("dev-b was dropped by the join");
        assert_eq!(phone.name, "Phone");
    }

    /// **A fresh install files its own name, or the joiner's "Paired device" is repaired for
    /// nobody.**
    ///
    /// `Invite` carries no name and `pairing::respond` runs on the initiator alone, so a joiner
    /// files the device it joined under `DEFAULT_PEER_NAME`. The only thing that can outrank
    /// that is a `device_names` row the *other* device wrote about itself — and a machine
    /// installed today mints a real hostname, so it never trips the placeholder upgrade and
    /// would otherwise have no row at all.
    #[test]
    fn a_fresh_identity_files_its_own_name_where_the_group_can_read_it() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        assert_eq!(
            synced_name(&conn, &me.device_id).as_deref(),
            Some(&*me.name)
        );
        assert_eq!(count(&conn, "device_names"), 1, "itself and nobody else");
    }

    /// An install that already had an identity files the name it already had, without changing
    /// it. That is every device that paired before v31 and never carried the shared placeholder
    /// — the population the upgrade in [`ensure`] cannot see.
    #[test]
    fn an_existing_install_files_the_name_it_already_had() {
        let conn = db();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'deadbeef', ?1, ?2, 'MARKUS-PC', 0)",
            params![[1u8; 32].as_slice(), [2u8; 32].as_slice()],
        )
        .unwrap();

        let me = ensure(&conn).unwrap();
        assert_eq!(me.name, "MARKUS-PC", "nothing renamed it");
        assert_eq!(synced_name(&conn, "deadbeef").as_deref(), Some("MARKUS-PC"));
    }

    /// The placeholder upgrade files the name it minted, so an upgraded name travels like a
    /// typed one rather than stopping at this device.
    #[test]
    fn the_upgraded_placeholder_travels() {
        let conn = db();
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'deadbeef', ?1, ?2, ?3, 0)",
            params![[1u8; 32].as_slice(), [2u8; 32].as_slice(), PLACEHOLDER],
        )
        .unwrap();
        add_device(&conn, "deadbeef", &[3u8; 32], PLACEHOLDER).unwrap();

        let upgraded = ensure(&conn).unwrap();
        assert_ne!(upgraded.name, PLACEHOLDER);
        assert_eq!(
            synced_name(&conn, "deadbeef").as_deref(),
            Some(&*upgraded.name),
            "the upgrade wrote three rows, not two"
        );
        assert_eq!(roster(&conn).unwrap()[0].name, upgraded.name);
    }

    /// **A name that arrived from the group is never overwritten by a later [`ensure`].**
    ///
    /// Renaming a peer is a press on the *other* device, so this device's copy of its own name
    /// can be older than the group's. An upsert on this path would put the hostname back at the
    /// next pairing command and undo a rename the reader made on a screen they were not looking
    /// at; `DO NOTHING` is what stops it.
    #[test]
    fn a_name_that_arrived_from_the_group_is_not_overwritten_by_ensure() {
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        // What `apply` does when the other device renames this one.
        conn.execute(
            "UPDATE device_names SET name = 'Markus desk' WHERE device_id = ?1",
            params![me.device_id],
        )
        .unwrap();

        let again = ensure(&conn).unwrap();

        assert_eq!(
            synced_name(&conn, &me.device_id).as_deref(),
            Some("Markus desk"),
            "the group's answer stands"
        );
        assert_eq!(
            again.name, me.name,
            "and `sync_identity` is not rewritten from it either"
        );
        assert_eq!(
            roster(&conn).unwrap()[0].name,
            "Markus desk",
            "the panel draws the name the group agreed on"
        );
    }
}
