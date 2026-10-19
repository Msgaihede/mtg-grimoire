//! The roster document: who is in a group at an epoch, with every member's keys, and the proof
//! that a member entitled to say so said it (the Discord spec's §5; the wire is its §12).
//!
//! **Why it exists — three holes a manifest could not close.** A manifest is `{device: blob}`,
//! ids and sealed keys and nothing else, so (F1) a device that learned of a join by adopting an
//! epoch learnt *who* joined and never *what key* they hold — it could not seal a blob to them,
//! nor verify one envelope they signed; (F2) anybody holding the group key could publish a
//! rotation naming whom they liked, and every device read *no blob for me* as its own removal;
//! (F3, the half that lives here) nothing said which device may write. A roster document carries
//! each member's X25519 and Ed25519 keys, its capability and its protocol level, and is accepted
//! only under an authenticator this device can check.
//!
//! **Two modes, and the second is a latch.**
//!
//! * **Open** — every key holder is a full device, so a MAC keyed from the epoch's group key is
//!   as strong as the group itself: whoever can compute it could already read and write
//!   everything. It is how a group paired before user schema v66 learns every member's keys —
//!   each device *amends* its own entry under the MAC — and it changes nothing about removal:
//!   the manifest still decides, exactly as it always did ([`crate::sync_engine::client`]).
//! * **Signed** — once a restricted device (an `add` bot, or PR 3's `read` one) holds the group
//!   key, the MAC proves nothing, so a document is accepted only when a **full member of the
//!   previously accepted one** signed it, its `prev` is that document's hash, and no device once
//!   restricted comes back as full. From then on removal, rotation and capability move only on
//!   such a document.
//!
//! ⚠️ **One press enters signed mode, and nothing else does**: the integration's pinned pairing,
//! `pairing::confirm_pinned` (the spec's §13.4). It latches this device at the epoch the bot's
//! join publishes ([`enter_signed_mode`], `pub(crate)` and called from there alone), and that
//! join's rotation carries the group's first signed document, signed by this device. Every other
//! device follows: a verified signed document, signed by a full member it already trusts, latches
//! it too — which is why `integration::gate` requires every member at [`identity::SIG_PROTO`] 2
//! ("verifies rosters") before a bot may join, and at [`identity::ADD_PROTO`] 3 ("takes an `add`
//! member's adds") since the bot joins as [`ADD`].
//!
//! **The document is a string, verified over its exact bytes and never re-serialised.**
//! [`to_text`] writes it once, deterministically (serde's field order, compact), and the relay
//! stores and serves those characters verbatim; a reader parses what it was handed and checks the
//! authenticator against the same characters. `src/__golden__/roster-v1.json` pins a document,
//! its hash, its MAC key, its MAC and its signature for the relay's suite to read too.

use crate::errors::{self, Kind, Source};
use crate::sync_pair::crypto;
use crate::sync_pair::identity::{self, Group, Rotation};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// The document's `v`. A document of any other version is refused rather than read loosely: the
/// day its meaning changes is the day two builds must disagree loudly.
pub const VERSION: i64 = 1;

/// What every authenticator covers ahead of the document: `b"mtg-grimoire/roster/v1" 0x00`, then
/// the document's characters. [`crypto`]'s `INFO_*` convention and `wire`'s envelope domain, for
/// their reason — a signature over a roster can never be mistaken for one over an envelope.
const SIG_DOMAIN: &[u8] = b"mtg-grimoire/roster/v1";

/// The HKDF `info` of the open-mode MAC key.
const INFO_MAC: &[u8] = b"mtg-grimoire/roster-mac/v1";

/// The capability every device paired before the Discord spec has: everything.
pub const FULL: &str = "full";

/// A device that may read the group and write nothing — the bot as PR 3 paired it. Every build
/// understands the word (refuse everything it sends), and nothing pairs with it any more.
pub const READ: &str = "read";

/// A device that may read the group and **add cards**, and nothing else — the bot since PR 4 (the
/// spec's §14). **Restricted in every rule `read` is** — never a sealer, never a planner, never a
/// baseline, never a document's signer, a `cap` claim on its token — because every one of those
/// rules asks [`Member::is_full`] or [`is_restricted`], and only `full` is full. What it may send
/// is the frozen allow-list (`integration::add::allowed`), and what a receiver does with it is
/// `sync_engine::apply`'s restricted guards and `sync_engine::merge::Ranks`.
pub const ADD: &str = "add";

/// The two modes. Serialised as the words `open` and `signed`; **any other word refuses the
/// document**, because a mode this build does not know is a rule it cannot keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Open,
    Signed,
}

impl Mode {
    pub fn word(self) -> &'static str {
        match self {
            Mode::Open => "open",
            Mode::Signed => "signed",
        }
    }
}

/// One member: its two public keys (base64url, no padding — `sealed`'s engine), what it may do,
/// the protocol level it speaks and the epoch it is a member since.
///
/// **`ed25519` is `null` for a member whose signing key nobody has filed** — a build from before
/// user schema v66, whose envelopes are unsigned and whose entry its peers publish for it. **And
/// `proto` is 0 for a member that never advertised one**, level 0 in [`identity::SIG_PROTO`]'s
/// own terms. Both are why the spec's gate reads the document, not the roster: a member at 0 is a
/// reason to refuse a bot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub device: String,
    pub x25519: String,
    #[serde(default)]
    pub ed25519: Option<String>,
    pub cap: String,
    #[serde(default)]
    pub proto: i64,
    #[serde(default)]
    pub since: i64,
}

impl Member {
    /// **Only the exact word `full` is full.** A word this build does not know is somebody a newer
    /// build restricted, and reading it as anything else would be the unsafe direction.
    pub fn is_full(&self) -> bool {
        self.cap == FULL
    }
}

/// The document, §12's shape minus the authenticator (which travels beside it). **The field
/// order here is the order on the wire**, and [`to_text`] depends on it: serde writes a struct's
/// fields in declaration order, so moving one moves every signature.
///
/// **No `deny_unknown_fields`**, on the struct or on [`Member`]: a field a later version adds is
/// dropped by this one, and the authenticator is over the characters, so dropping it costs the
/// verification nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roster {
    pub v: i64,
    pub group: String,
    pub epoch: i64,
    pub step: i64,
    pub prev: Option<String>,
    pub mode: Mode,
    pub signer: String,
    pub members: Vec<Member>,
}

impl Roster {
    pub fn member(&self, device: &str) -> Option<&Member> {
        self.members.iter().find(|m| m.device == device)
    }
}

/// A document as the relay carries it: the string, and the one authenticator beside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub text: String,
    pub mac: Option<String>,
    pub sig: Option<String>,
}

/// The authenticator this device puts beside a document it publishes: `rosterMac` in open mode,
/// `rosterSig` in signed mode — exactly one of the two, §12's rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Auth {
    Mac(String),
    Sig(String),
}

impl Auth {
    /// The body field and its value — `("rosterMac", …)` or `("rosterSig", …)`.
    pub fn field(&self) -> (&'static str, &str) {
        match self {
            Auth::Mac(mac) => ("rosterMac", mac),
            Auth::Sig(sig) => ("rosterSig", sig),
        }
    }
}

// ---------------------------------------------------------------------------------------
// The bytes
// ---------------------------------------------------------------------------------------

/// The document as the characters every authenticator covers. Compact JSON in declaration order,
/// so the same document is the same string on every host.
pub fn to_text(roster: &Roster) -> String {
    serde_json::to_string(roster).expect("a roster document always serialises")
}

/// Read a document, **leniently for unknown fields and strictly for what it says**: `None` for
/// anything that is not JSON of this shape, for a `v` other than [`VERSION`], and for a mode word
/// this build does not know.
pub fn parse(text: &str) -> Option<Roster> {
    serde_json::from_str::<Roster>(text)
        .ok()
        .filter(|r| r.v == VERSION)
}

/// What the next document's `prev` names: the lowercase hex SHA-256 of this one's characters.
pub fn hash(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// `b"mtg-grimoire/roster/v1" 0x00 <the document's characters>` — what a signature and a MAC
/// cover. Pinned by the golden vectors.
pub fn signing_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIG_DOMAIN.len() + 1 + text.len());
    out.extend_from_slice(SIG_DOMAIN);
    out.push(0);
    out.extend_from_slice(text.as_bytes());
    out
}

/// The open-mode MAC key: `HKDF-SHA256(ikm = the group key of the document's epoch, salt = the
/// group id's characters, info = "mtg-grimoire/roster-mac/v1")`, 32 bytes.
///
/// **The group id is the salt and the purpose the info** — [`crypto::relay_auth`]'s shape, for
/// its reason: two groups that somehow shared a key still MAC under two unrelated keys. **Never
/// the group key itself**: the key also seals every envelope, and one secret serving two
/// primitives is a door nobody needs open.
pub fn mac_key(group_key: &[u8; 32], group_id: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(group_id.as_bytes()), group_key);
    let mut out = [0u8; 32];
    hk.expand(INFO_MAC, &mut out)
        .expect("32 bytes is far below HKDF-SHA256's output limit");
    out
}

/// HMAC-SHA256 over [`signing_bytes`] under [`mac_key`], base64url without padding (43
/// characters).
pub fn mac(group_key: &[u8; 32], group_id: &str, text: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(&mac_key(group_key, group_id))
        .expect("HMAC takes a key of any length");
    m.update(&signing_bytes(text));
    URL_SAFE_NO_PAD.encode(m.finalize().into_bytes())
}

/// Whether `tag` is the MAC of `text` under that epoch's key — **compared in constant time**
/// (`verify_slice`), because a MAC compared byte by byte tells a patient forger how many bytes
/// it has right.
pub fn mac_ok(group_key: &[u8; 32], group_id: &str, text: &str, tag: &str) -> bool {
    let Ok(tag) = URL_SAFE_NO_PAD.decode(tag.as_bytes()) else {
        return false;
    };
    let mut m = Hmac::<Sha256>::new_from_slice(&mac_key(group_key, group_id))
        .expect("HMAC takes a key of any length");
    m.update(&signing_bytes(text));
    m.verify_slice(&tag).is_ok()
}

/// Ed25519 over [`signing_bytes`], base64url without padding (86 characters).
pub fn sign(sign_secret: &[u8; 32], text: &str) -> String {
    URL_SAFE_NO_PAD.encode(crypto::sign(sign_secret, &signing_bytes(text)))
}

/// Whether `sig` is `public`'s signature over [`signing_bytes`] — `crypto::verify`'s strict
/// check, and `false` for anything that is not 64 bytes of base64url.
pub fn sig_ok(public: &[u8; 32], text: &str, sig: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(sig.as_bytes())
        .ok()
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
        .is_some_and(|sig| crypto::verify(public, &signing_bytes(text), &sig))
}

/// A 32-byte key off the wire, or `None`.
pub fn key32(b64: &str) -> Option<[u8; 32]> {
    URL_SAFE_NO_PAD
        .decode(b64.as_bytes())
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
}

/// A 32-byte key as the document spells it — base64url, no padding.
pub fn key_text(key: &[u8; 32]) -> String {
    b64(key)
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------
// The acceptance rule
// ---------------------------------------------------------------------------------------

/// What a reader knows when it judges a document: its own latch, the last document it accepted,
/// every device it has ever seen restricted, and — for the very first signed document, when
/// there is no previous one to read a signer from — the full devices it already trusts by key.
pub struct Trust<'a> {
    pub group_id: &'a str,
    pub mode: Mode,
    /// The last accepted document's characters and what they say.
    pub last: Option<&'a (String, Roster)>,
    pub restricted_ever: &'a BTreeSet<String>,
    /// `(device, ed25519)` for every full device on this device's own roster whose signing key
    /// was filed through a channel it verified — a pairing's sealed slot, or an earlier document.
    pub anchors: &'a [(String, [u8; 32])],
}

/// What [`judge`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Accept(Roster),
    /// An open-mode document at an epoch whose key this device does not hold (yet): asked again
    /// once a rotation has been adopted, and never a refusal — the key is what is missing.
    Later,
    /// At or behind the last accepted document: already decided, and silent.
    Stale,
    /// Refused, with the sentence the error log carries.
    Refuse(&'static str),
}

pub const MALFORMED: &str = "a roster document from the relay could not be read";
pub const WRONG_GROUP: &str = "a roster document from the relay is for another pairing group";
pub const BACK_TO_OPEN: &str =
    "a roster document went back to open mode in a group that signs its rosters, so it was refused";
pub const CAME_BACK_FULL: &str = "a roster document named a device as a full member after it had \
     been restricted, so it was refused";
pub const FORGED: &str = "a roster document's authenticator does not match it - it was altered, \
     or written by a device that may not change who is in this group";
pub const NOT_SIGNED_BY_A_FULL_MEMBER: &str = "a roster document in a group that signs its \
     rosters was not signed by a full member this device trusts, so it was refused";
pub const OUT_OF_CHAIN: &str = "a roster document does not follow the last one this device \
     accepted, so it was refused";
pub const OPEN_BUT_RESTRICTED: &str = "a roster document in open mode named a member that is not \
     full, which only a signed one may, so it was refused";

/// The acceptance rule, as a pure function of what the reader knows and what it was handed.
///
/// In order — each refusal is a sentence, and the first that applies is the answer:
///
/// 1. **It parses** as §12's shape at [`VERSION`], with a mode word this build knows, and names
///    this device's group.
/// 2. **It is ahead of the last accepted document**, by `(epoch, step)`. Behind or equal is
///    [`Verdict::Stale`]: the relay hands the walk from an epoch onward, inclusive, so the last
///    one accepted comes back on every trip.
/// 3. **The mode is a latch**: a reader in signed mode refuses an open document — and an open
///    document may name no member that is not full (the relay's rule too).
/// 4. **Nobody once restricted comes back as full** — whether this device saw it restricted in an
///    earlier document ([`Trust::restricted_ever`]) or in the last one.
/// 5. **The authenticator.** A *signed* document needs `rosterSig`, by a device that is a full
///    member of the last accepted document (or, with none, one of [`Trust::anchors`]) and was never
///    restricted, **and** its `prev` must be the last accepted one's hash. An *open* document is
///    accepted on a signature by such a member, or on the MAC under its own epoch's key —
///    [`Verdict::Later`] when this device does not hold that key yet. **Open documents do not
///    chain**: a device behind by more than the relay's walk would otherwise never accept one
///    again, and in open mode the MAC already proves a key holder wrote it.
///
/// **What the chain buys in signed mode** is that a document cannot be replayed out of order or
/// forked: one signature by a full member at one point in the history is not a licence to speak
/// at another. A device offline across more documents than the relay serves at once
/// (`rosters`, capped at 16) catches up a walk at a time, because each trip asks from the last
/// one it accepted; one whose chain is truly broken holds until it is re-paired (§5).
pub fn judge(trust: &Trust, stored: &Stored, key_at: &dyn Fn(i64) -> Option<[u8; 32]>) -> Verdict {
    let Some(rd) = parse(&stored.text) else {
        return Verdict::Refuse(MALFORMED);
    };
    if rd.group != trust.group_id {
        return Verdict::Refuse(WRONG_GROUP);
    }
    if let Some((_, last)) = trust.last {
        if (rd.epoch, rd.step) <= (last.epoch, last.step) {
            return Verdict::Stale;
        }
    }
    if trust.mode == Mode::Signed && rd.mode == Mode::Open {
        return Verdict::Refuse(BACK_TO_OPEN);
    }
    // **A restricted member exists only in signed mode** — the relay refuses an open document
    // naming one (`400 malformed_roster`), and so does this reader: under the MAC, any key
    // holder could otherwise name itself or a sibling restricted, or file a capability the
    // signed chain never granted.
    if rd.mode == Mode::Open && rd.members.iter().any(|m| !m.is_full()) {
        return Verdict::Refuse(OPEN_BUT_RESTRICTED);
    }
    let was_restricted = |device: &str| {
        trust.restricted_ever.contains(device)
            || trust
                .last
                .and_then(|(_, last)| last.member(device))
                .is_some_and(|m| !m.is_full())
    };
    if rd
        .members
        .iter()
        .any(|m| m.is_full() && was_restricted(&m.device))
    {
        return Verdict::Refuse(CAME_BACK_FULL);
    }

    // The signer's key, when the signer is somebody this device lets speak for the group.
    let signer_key = || -> Option<[u8; 32]> {
        if was_restricted(&rd.signer) {
            return None;
        }
        let anchored = || {
            trust
                .anchors
                .iter()
                .find(|(device, _)| *device == rd.signer)
                .map(|(_, key)| *key)
        };
        match trust.last {
            Some((_, last)) => {
                let entry = last.member(&rd.signer).filter(|m| m.is_full())?;
                entry.ed25519.as_deref().and_then(key32).or_else(anchored)
            }
            None => anchored(),
        }
    };
    let signed_by_a_full_member = stored
        .sig
        .as_deref()
        .zip(signer_key())
        .map(|(sig, key)| sig_ok(&key, &stored.text, sig));

    match rd.mode {
        Mode::Signed => match signed_by_a_full_member {
            Some(true) => {
                let follows = trust
                    .last
                    .is_none_or(|(text, _)| rd.prev.as_deref() == Some(hash(text).as_str()));
                if follows {
                    Verdict::Accept(rd)
                } else {
                    Verdict::Refuse(OUT_OF_CHAIN)
                }
            }
            Some(false) => Verdict::Refuse(FORGED),
            None => Verdict::Refuse(NOT_SIGNED_BY_A_FULL_MEMBER),
        },
        Mode::Open => {
            if signed_by_a_full_member == Some(true) {
                return Verdict::Accept(rd);
            }
            let Some(tag) = stored.mac.as_deref() else {
                return Verdict::Refuse(FORGED);
            };
            let Some(key) = key_at(rd.epoch) else {
                return Verdict::Later;
            };
            if mac_ok(&key, &rd.group, &stored.text, tag) {
                Verdict::Accept(rd)
            } else {
                Verdict::Refuse(FORGED)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// What this device keeps — `sync_state`, and no schema rung
// ---------------------------------------------------------------------------------------
//
// Every key below is plain `sync_state`, for `identity::SUPERSEDED`'s reason: it never syncs,
// nothing reads it but by key, and it is this device's own view of its group.

/// `open` or `signed`. Absent is open. **Written once to `signed` and never back** while this
/// device is in the group; [`forget_group`] clears it with the group itself.
pub const ROSTER_MODE: &str = "roster_mode";

/// The epoch of the first signed document this device accepted: an envelope at or above it must
/// be signed, and its ops must be its sender's ([`requires_signatures`]).
pub const SIGNED_SINCE: &str = "signed_since";

/// Every device id this device has ever seen restricted, comma-joined. **Never cleared** — not by
/// leaving a group, not by [`forget_group`], not by `identity`'s `forget_superseded` — because
/// "no once-restricted device returns as full" has to survive every path that forgets anything.
pub const RESTRICTED_EVER: &str = "restricted_ever";

/// The last accepted document, verbatim, and its hash — what the next one must follow.
pub const ROSTER_LAST: &str = "roster_last";
pub const ROSTER_LAST_HASH: &str = "roster_last_hash";

/// The hash of the newest document the relay answered on the last `/keys`, accepted or not, or
/// `none` when it held none — what the next published document's `prev` must name, since the
/// relay keeps the chain linear (`409 roster_conflict`).
pub const ROSTER_SEEN: &str = "roster_seen";

/// `1` while the relay's last `/keys` answer said `sig: 1` — a relay that stores rosters. **Absent
/// is an older relay**, which never sees an amendment and never a roster on `/rotate`.
pub const RELAY_ROSTERS: &str = "relay_rosters";

/// `device@epoch`, comma-joined: devices this device itself saw removed, and the epoch the
/// removal landed at — so a document from that epoch or before can never put one back.
pub(crate) const ROSTER_REMOVED: &str = "roster_removed";

/// The epoch whose key change was last held for want of a verified document, so the hold is
/// recorded once rather than on every trip.
const ROSTER_HELD: &str = "roster_held";

/// The hash of the last document refused and recorded, for the same reason.
const ROSTER_REFUSED: &str = "roster_refused";

fn state(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
}

fn set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map(|_| ())
}

fn unset(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sync_state WHERE key = ?1", [key])
        .map(|_| ())
}

fn ids(value: Option<String>) -> BTreeSet<String> {
    value
        .iter()
        .flat_map(|v| v.split(','))
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

/// This device's mode.
pub fn mode(conn: &Connection) -> Mode {
    match state(conn, ROSTER_MODE).ok().flatten().as_deref() {
        Some("signed") => Mode::Signed,
        _ => Mode::Open,
    }
}

/// Whether an envelope at `epoch` must be signed by its sender's key on file — and carry only its
/// sender's ops (`client::open_checked`). **Outside signed mode, never**: PR 1's open mode, where
/// a signature is verified when present and an unsigned envelope is read as it always was.
pub fn requires_signatures(conn: &Connection, epoch: i64) -> bool {
    mode(conn) == Mode::Signed
        && state(conn, SIGNED_SINCE)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .is_some_and(|since| epoch >= since)
}

/// Every device ever seen restricted here.
pub fn restricted_ever(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    Ok(ids(state(conn, RESTRICTED_EVER)?))
}

fn note_restricted(conn: &Connection, devices: &[&str]) -> rusqlite::Result<()> {
    let mut ever = restricted_ever(conn)?;
    let before = ever.len();
    ever.extend(devices.iter().map(|d| (*d).to_owned()));
    if ever.len() != before {
        let joined: Vec<&str> = ever.iter().map(String::as_str).collect();
        set(conn, RESTRICTED_EVER, &joined.join(","))?;
    }
    Ok(())
}

/// Whether `device` may write nothing here: its roster row carries a capability other than
/// `full`, or it was ever seen restricted. **Either is enough**, and neither is ever relaxed by a
/// later word from anyone: an op is refused, a sealer is not tried, a plan is not made.
pub fn is_restricted(conn: &Connection, device: &str) -> rusqlite::Result<bool> {
    if restricted_ever(conn)?.contains(device) {
        return Ok(true);
    }
    let cap: Option<Option<String>> = conn
        .query_row(
            "SELECT capability FROM sync_devices WHERE device_id = ?1",
            [device],
            |r| r.get(0),
        )
        .optional()?;
    Ok(cap.flatten().is_some_and(|c| c != FULL))
}

/// Whether **this** device is restricted — the one question every plan asks first.
pub fn self_restricted(conn: &Connection) -> rusqlite::Result<bool> {
    match identity::public_identity(conn)? {
        Some((me, _)) => is_restricted(conn, &me),
        None => Ok(false),
    }
}

/// **Every device whose ops lose by rank here** (`sync_engine::merge::Ranks`): each one ever seen
/// restricted, and each roster row whose capability is a word other than `full`. Read once per
/// apply, so a page is ranked against one view of the roster.
pub fn restricted_devices(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    let mut out = restricted_ever(conn)?;
    let mut stmt = conn.prepare_cached(
        "SELECT device_id FROM sync_devices WHERE capability IS NOT NULL AND capability <> ?1",
    )?;
    for row in stmt.query_map([FULL], |r| r.get::<_, String>(0))? {
        out.insert(row?);
    }
    Ok(out)
}

/// The word `device` is restricted to, as `sync_devices` holds it — `None` for a full member or a
/// device not on the roster. **Only the exact word [`ADD`] opens an envelope**
/// (`client::open_checked`); a device ever restricted with no word on its row is read as
/// [`READ`], the safe direction.
pub fn capability_of(conn: &Connection, device: &str) -> rusqlite::Result<Option<String>> {
    let cap = own_capability(conn, device);
    if cap.as_deref().is_some_and(|c| c != FULL) {
        return Ok(cap);
    }
    if restricted_ever(conn)?.contains(device) {
        return Ok(Some(READ.to_owned()));
    }
    Ok(None)
}

/// [`capability_of`] this device: what `integration::add::emit` and `client::push_restricted` ask
/// before they write or send anything. `None` is a full device, or one in no group.
pub fn self_capability(conn: &Connection) -> rusqlite::Result<Option<String>> {
    match identity::public_identity(conn)? {
        Some((me, _)) => capability_of(conn, &me),
        None => Ok(None),
    }
}

/// The last accepted document, read back.
pub fn last(conn: &Connection) -> rusqlite::Result<Option<(String, Roster)>> {
    Ok(state(conn, ROSTER_LAST)?.and_then(|text| parse(&text).map(|rd| (text, rd))))
}

/// The epoch a `/keys` request asks the relay's walk from: the last accepted document's, or this
/// device's own epoch when it has accepted none.
pub fn since(conn: &Connection, epoch: i64) -> i64 {
    last(conn)
        .ok()
        .flatten()
        .map_or(epoch, |(_, rd)| rd.epoch.min(epoch))
}

/// What the relay said about rosters on its newest `/keys` answer: whether it keeps them, and the
/// hash of the newest it holds. A fact about the relay, written on every answer.
pub fn note_relay(conn: &Connection, keeps: bool, newest: Option<&str>) -> rusqlite::Result<()> {
    if !keeps {
        return unset(conn, RELAY_ROSTERS);
    }
    set(conn, RELAY_ROSTERS, "1")?;
    set(conn, ROSTER_SEEN, &newest.map_or("none".to_owned(), hash))
}

/// Whether the relay's last `/keys` answer said it keeps rosters.
pub fn relay_keeps_rosters(conn: &Connection) -> bool {
    state(conn, RELAY_ROSTERS).ok().flatten().as_deref() == Some("1")
}

/// What a document this device publishes must name as `prev`: the relay's newest, as its last
/// answer reported it — or, with no answer on file, the last one accepted here.
pub fn prev_for_publish(conn: &Connection) -> rusqlite::Result<Option<String>> {
    match state(conn, ROSTER_SEEN)?.as_deref() {
        Some("none") => Ok(None),
        Some(seen) => Ok(Some(seen.to_owned())),
        None => state(conn, ROSTER_LAST_HASH),
    }
}

/// What [`trust_parts`] reads: the mode, the last accepted document, every device once
/// restricted, and the anchors — [`Trust`]'s fields, owned.
pub type TrustParts = (
    Mode,
    Option<(String, Roster)>,
    BTreeSet<String>,
    Vec<(String, [u8; 32])>,
);

/// Everything [`judge`] needs, read in one place.
pub fn trust_parts(conn: &Connection) -> rusqlite::Result<TrustParts> {
    let restricted = restricted_ever(conn)?;
    let mut anchors: Vec<(String, [u8; 32])> = identity::roster(conn)?
        .into_iter()
        .filter(|d| d.revoked_at.is_none())
        .filter(|d| d.capability.as_deref().is_none_or(|c| c == FULL))
        .filter(|d| !restricted.contains(&d.device_id))
        .filter_map(|d| d.sign_public.map(|key| (d.device_id, key)))
        .collect();
    // This device trusts itself: a document it signed and published comes back on the walk.
    if let (Some((me, _)), Some(key)) = (
        identity::public_identity(conn)?,
        identity::signing_key_if_held(conn)?,
    ) {
        if !anchors.iter().any(|(d, _)| *d == me) {
            anchors.push((me, key.public));
        }
    }
    Ok((mode(conn), last(conn)?, restricted, anchors))
}

/// Take a document this device has accepted: it becomes the one the next must follow, its mode
/// latches this device, its restricted members are remembered for good, and — with `apply` —
/// its members' keys reach the roster ([`apply_members`]). **`apply` is `false` for a document
/// this device itself published**: it was built from this roster, and there is nothing to learn.
pub fn accept(conn: &Connection, text: &str, rd: &Roster, apply: bool) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    set(&tx, ROSTER_LAST, text)?;
    set(&tx, ROSTER_LAST_HASH, &hash(text))?;
    if rd.mode == Mode::Signed && mode(&tx) == Mode::Open {
        set(&tx, ROSTER_MODE, Mode::Signed.word())?;
        set(&tx, SIGNED_SINCE, &rd.epoch.to_string())?;
    }
    let restricted: Vec<&str> = rd
        .members
        .iter()
        .filter(|m| !m.is_full())
        .map(|m| m.device.as_str())
        .collect();
    note_restricted(&tx, &restricted)?;
    if apply {
        apply_members(&tx, rd)?;
    }
    tx.commit()
}

/// A document this device just published and the relay took: accepted here as if read back, and
/// the relay's newest is now it.
pub fn accept_own(conn: &Connection, text: &str) -> rusqlite::Result<()> {
    let Some(rd) = parse(text) else {
        return Ok(());
    };
    accept(conn, text, &rd, false)?;
    set(conn, ROSTER_SEEN, &hash(text))
}

/// **What fixes F1**: every member's keys, capability and protocol level, onto `sync_devices`.
///
/// * **A device not on the roster is inserted** — the device a sibling paired, whom a manifest
///   could only name — but only from a document **at or after this device's own epoch**, and
///   never one this device itself saw removed at that epoch or later ([`record_removal`]). A
///   document from before a removal still names the removed device, and the walk hands such
///   documents back in order; putting the row back would put the device back on this device's
///   next manifest. It is filed under `pairing`'s *Paired device* until its own synced name
///   arrives (`device_names` outranks it), and stamped as baselined now, so learning of a peer
///   costs no baseline the join's own rotation did not already re-arm.
/// * **A key already on file is never replaced.** The X25519 key on a row was filed at a pairing,
///   behind six digits, or by an earlier document; one document that disagreed would otherwise
///   redirect the next rotation's blob to a key its writer holds. A missing signing key is filled
///   in; a different one is recorded once and left.
/// * **A row an older build stamped `revoked_at` is left alone** — that device was removed.
/// * **A capability only ever narrows here.** `full` never overwrites a restriction (the judge
///   has already refused a document that tried), and a restriction reaches this device's own row
///   too, which is how it learns it may plan nothing.
fn apply_members(conn: &Connection, rd: &Roster) -> rusqlite::Result<()> {
    let me = identity::public_identity(conn)?.map(|(id, _)| id);
    let epoch = identity::group(conn)?.map_or(i64::MIN, |g| g.epoch);
    for m in &rd.members {
        let cap = (!m.is_full()).then_some(m.cap.as_str());
        if me.as_deref() == Some(m.device.as_str()) {
            if let Some(cap) = cap {
                conn.execute(
                    "UPDATE sync_devices SET capability = ?2 WHERE device_id = ?1",
                    params![m.device, cap],
                )?;
            }
            continue;
        }
        let Some(x25519) = key32(&m.x25519) else {
            continue;
        };
        let ed25519 = m.ed25519.as_deref().and_then(key32);
        let row: Option<HeldRow> = conn
            .query_row(
                "SELECT public_key, sign_public, revoked_at FROM sync_devices WHERE device_id = ?1",
                [&m.device],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match row {
            Some((_, _, Some(_))) => {}
            Some((public, sign, None)) => {
                if public.as_slice() != x25519.as_slice() {
                    disagreement(conn, &m.device);
                    continue;
                }
                match (sign.as_deref(), ed25519) {
                    (Some(held), Some(said)) if held != said.as_slice() => {
                        disagreement(conn, &m.device);
                        continue;
                    }
                    (None, Some(said)) => {
                        conn.execute(
                            "UPDATE sync_devices SET sign_public = ?2 WHERE device_id = ?1",
                            params![m.device, said.as_slice()],
                        )?;
                    }
                    _ => {}
                }
                conn.execute(
                    "UPDATE sync_devices SET proto = ?2 WHERE device_id = ?1",
                    params![m.device, m.proto],
                )?;
                if let Some(cap) = cap {
                    conn.execute(
                        "UPDATE sync_devices SET capability = ?2 WHERE device_id = ?1",
                        params![m.device, cap],
                    )?;
                }
            }
            None => {
                let removed = removed_at(conn, &m.device)?.is_some_and(|at| at >= rd.epoch);
                if rd.epoch < epoch || removed {
                    continue;
                }
                conn.execute(
                    "INSERT INTO sync_devices
                         (device_id, public_key, name, added_at, revoked_at, baselined_at,
                          sign_public, capability, proto)
                     VALUES (?1, ?2, ?3, unixepoch(), NULL, unixepoch(), ?4, ?5, ?6)",
                    params![
                        m.device,
                        x25519.as_slice(),
                        crate::sync_pair::pairing::DEFAULT_PEER_NAME,
                        ed25519.as_ref().map(|k| k.as_slice()),
                        cap,
                        m.proto
                    ],
                )?;
            }
        }
    }
    Ok(())
}

/// A roster row as [`apply_members`] reads it: the X25519 key, the signing key and the stamp.
type HeldRow = (Vec<u8>, Option<Vec<u8>>, Option<i64>);

/// A document disagreed with a key this device already holds for a peer.
fn disagreement(conn: &Connection, device: &str) {
    errors::record(
        conn,
        Source::Relay,
        "roster",
        Kind::Other,
        "a roster document gave a device a key other than the one this device paired it with; \
         the key on file was kept",
        Some(device),
    );
}

/// Remember that `device` left this device's roster at `epoch` — a removal it committed, or a
/// manifest's prune it adopted.
pub fn record_removal(conn: &Connection, device: &str, epoch: i64) -> rusqlite::Result<()> {
    if device.is_empty() {
        return Ok(());
    }
    let mut entries: Vec<String> = ids(state(conn, ROSTER_REMOVED)?)
        .into_iter()
        .filter(|e| e.split('@').next() != Some(device))
        .collect();
    entries.push(format!("{device}@{epoch}"));
    set(conn, ROSTER_REMOVED, &entries.join(","))
}

/// Forget a removal: `device` was paired back, behind six digits.
pub fn forget_removal(conn: &Connection, device: &str) -> rusqlite::Result<()> {
    let entries: Vec<String> = ids(state(conn, ROSTER_REMOVED)?)
        .into_iter()
        .filter(|e| e.split('@').next() != Some(device))
        .collect();
    if entries.is_empty() {
        unset(conn, ROSTER_REMOVED)
    } else {
        set(conn, ROSTER_REMOVED, &entries.join(","))
    }
}

fn removed_at(conn: &Connection, device: &str) -> rusqlite::Result<Option<i64>> {
    Ok(ids(state(conn, ROSTER_REMOVED)?).into_iter().find_map(|e| {
        let (id, at) = e.split_once('@')?;
        (id == device).then(|| at.parse().ok()).flatten()
    }))
}

/// Forget this device's view of a group's rosters — the group is left, or another joined. **Not
/// [`RESTRICTED_EVER`]**, which no path clears.
pub fn forget_group(conn: &Connection) -> rusqlite::Result<()> {
    for key in [
        ROSTER_MODE,
        SIGNED_SINCE,
        ROSTER_LAST,
        ROSTER_LAST_HASH,
        ROSTER_SEEN,
        RELAY_ROSTERS,
        ROSTER_REMOVED,
        ROSTER_HELD,
        ROSTER_REFUSED,
    ] {
        unset(conn, key)?;
    }
    Ok(())
}

/// Record that a key change at `epoch` is held — once per epoch, not once per trip.
pub fn note_held(conn: &Connection, epoch: i64, message: &str) {
    if state(conn, ROSTER_HELD).ok().flatten() == Some(epoch.to_string()) {
        return;
    }
    errors::record(conn, Source::Relay, "keys", Kind::Other, message, None);
    let _ = set(conn, ROSTER_HELD, &epoch.to_string());
}

/// Record a refused document — once per document.
pub fn note_refused(conn: &Connection, text: &str, message: &str) {
    let hashed = hash(text);
    if state(conn, ROSTER_REFUSED).ok().flatten() == Some(hashed.clone()) {
        return;
    }
    errors::record(conn, Source::Relay, "roster", Kind::Other, message, None);
    let _ = set(conn, ROSTER_REFUSED, &hashed);
}

/// Enter signed mode at `epoch` — **the integration's press, and nothing else's.** Its one
/// shipped caller is `pairing::confirm_pinned`, in the stretch that files a restricted device,
/// with `epoch` the one its join's rotation publishes; that rotation's document is then built and
/// signed in signed mode ([`for_rotation`], [`authenticate`]). `pub(crate)` so no host can reach
/// it, and this crate's tests use it as a fixture.
///
/// **Latched before the signed document is published, on purpose.** From the moment the bot holds
/// the group key it can compute the open-mode MAC, so an open document is no longer a full
/// device's word; this device stops accepting one at once, and a rotation it publishes from here
/// on is signed — including the join's, when it has to be paid on a later trip.
pub(crate) fn enter_signed_mode(conn: &Connection, epoch: i64) -> rusqlite::Result<()> {
    if mode(conn) == Mode::Signed {
        return Ok(());
    }
    set(conn, ROSTER_MODE, Mode::Signed.word())?;
    set(conn, SIGNED_SINCE, &epoch.to_string())
}

/// File `device` as restricted to `capability`: its roster row, and [`RESTRICTED_EVER`] for good.
/// The integration's pinned pairing is the one caller — **the device that pairs a bot is the one
/// that sets what it may do** (the spec's §9), and a document only ever carries that word onward.
pub(crate) fn restrict(conn: &Connection, device: &str, capability: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sync_devices SET capability = ?2 WHERE device_id = ?1",
        params![device, capability],
    )?;
    note_restricted(conn, &[device])
}

/// Latch signed mode at `epoch` because the device that paired this one said its group signs —
/// the pairing's sealed `offersig` slot (`pairing::poll`). A latch toward the stricter rule, from
/// a channel the six digits authenticated; it changes nothing an earlier latch decided.
pub fn follow_signed(conn: &Connection, epoch: i64) -> rusqlite::Result<()> {
    if mode(conn) == Mode::Signed {
        return Ok(());
    }
    set(conn, ROSTER_MODE, Mode::Signed.word())?;
    set(conn, SIGNED_SINCE, &epoch.to_string())
}

// ---------------------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------------------

/// This device's own entry: its keys, the capability it was given (`full` unless a document said
/// otherwise), the level this build advertises ([`identity::PROTO`]), and `since` as the caller
/// knows it.
fn own_entry(conn: &Connection, since: i64) -> Result<Member, String> {
    let (me, x25519) = identity::public_identity(conn)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| identity::NOT_IN_A_GROUP.to_owned())?;
    let signing = identity::signing_key(conn)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| identity::NOT_IN_A_GROUP.to_owned())?;
    let restricted = is_restricted(conn, &me).map_err(|e| e.to_string())?;
    let cap = if restricted {
        own_capability(conn, &me).unwrap_or_else(|| READ.to_owned())
    } else {
        FULL.to_owned()
    };
    Ok(Member {
        device: me,
        x25519: b64(&x25519),
        ed25519: Some(b64(&signing.public)),
        cap,
        proto: identity::PROTO,
        since,
    })
}

fn own_capability(conn: &Connection, me: &str) -> Option<String> {
    conn.query_row(
        "SELECT capability FROM sync_devices WHERE device_id = ?1",
        [me],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// The entries for `devices`, from this device's roster and its own identity. `since` is the
/// epoch the previous document says each joined, or `epoch` for a device it does not name.
fn entries(
    conn: &Connection,
    devices: &[&str],
    epoch: i64,
    previous: Option<&Roster>,
) -> Result<Vec<Member>, String> {
    let me = identity::public_identity(conn)
        .map_err(|e| e.to_string())?
        .map(|(id, _)| id);
    let restricted = restricted_ever(conn).map_err(|e| e.to_string())?;
    let rows = identity::roster(conn).map_err(|e| e.to_string())?;
    let since_of = |device: &str| {
        previous
            .and_then(|p| p.member(device))
            .map_or(epoch, |m| m.since)
    };
    let mut out = Vec::with_capacity(devices.len());
    for device in devices {
        if me.as_deref() == Some(*device) {
            out.push(own_entry(conn, since_of(device))?);
            continue;
        }
        let Some(row) = rows.iter().find(|d| d.device_id == *device) else {
            continue;
        };
        let cap = match row.capability.as_deref() {
            Some(c) => c.to_owned(),
            None if restricted.contains(*device) => READ.to_owned(),
            None => FULL.to_owned(),
        };
        out.push(Member {
            device: row.device_id.clone(),
            x25519: b64(&row.public_key),
            ed25519: row.sign_public.as_ref().map(|k| b64(k)),
            cap,
            proto: row.proto.unwrap_or(0),
            since: since_of(device),
        });
    }
    Ok(out)
}

/// The authenticator for a document at `group`'s epoch: the MAC under that epoch's key in open
/// mode, this device's signature in signed mode.
pub fn authenticate(conn: &Connection, group: &Group, text: &str) -> Result<Auth, String> {
    match mode(conn) {
        Mode::Open => Ok(Auth::Mac(mac(&group.group_key, &group.group_id, text))),
        Mode::Signed => {
            let key = identity::signing_key(conn)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| identity::NOT_IN_A_GROUP.to_owned())?;
            Ok(Auth::Sig(sign(&key.secret, text)))
        }
    }
}

/// The document a rotation carries: its new epoch, step 0, its manifest's devices as members,
/// this device as signer, and the relay's newest as `prev` ([`prev_for_publish`]).
///
/// **`None` in open mode when a member would not be full** — the relay refuses such a document
/// (`400 malformed_roster`) and with it the whole rotation, and in open mode the document is
/// optional, so the rotation goes as an older build's would rather than not at all.
pub fn for_rotation(
    conn: &Connection,
    rotation: &Rotation,
) -> Result<Option<(String, Auth)>, String> {
    let me = identity::public_identity(conn)
        .map_err(|e| e.to_string())?
        .map(|(id, _)| id)
        .ok_or_else(|| identity::NOT_IN_A_GROUP.to_owned())?;
    let previous = last(conn).map_err(|e| e.to_string())?;
    let devices: Vec<&str> = rotation.keys.iter().map(|(id, _)| id.as_str()).collect();
    let members = entries(
        conn,
        &devices,
        rotation.group.epoch,
        previous.as_ref().map(|(_, rd)| rd),
    )?;
    let rd = Roster {
        v: VERSION,
        group: rotation.group.group_id.clone(),
        epoch: rotation.group.epoch,
        step: 0,
        prev: prev_for_publish(conn).map_err(|e| e.to_string())?,
        mode: mode(conn),
        signer: me,
        members,
    };
    if rd.mode == Mode::Open && rd.members.iter().any(|m| !m.is_full()) {
        return Ok(None);
    }
    let text = to_text(&rd);
    let auth = authenticate(conn, &rotation.group, &text)?;
    Ok(Some((text, auth)))
}

/// The amendment this device owes the relay, if any: **its own entry, added or brought up to
/// date** — its keys and this build's protocol level — on the relay's newest document.
///
/// `None`, and nothing owed, when any of these holds:
///
/// * the relay does not keep rosters ([`RELAY_ROSTERS`]) — an older relay is never sent one;
/// * this device is restricted — a restricted device speaks for nobody;
/// * the relay's newest is not the one accepted here — extending a chain this device could not
///   verify would be vouching for it, so it waits for a trip that can;
/// * the newest already names this device with these keys at this level;
/// * the newest is from an epoch this device has not reached yet.
///
/// **At this device's epoch** the amendment is the newest with this entry changed, at `step + 1`,
/// and nobody else's entry touched. **When the newest is older — or there is none**, as in every
/// group paired before rosters existed — it is a fresh document at step 0 of this device's epoch,
/// built from this device's own roster, which the manifest has already pruned: building from the
/// older document would put back a device that epoch's rotation removed. In open mode nothing
/// removes a device on a document's word, so a partial view here evicts nobody; the device it
/// misses amends itself in on its own next trip.
pub fn amendment(conn: &Connection) -> Result<Option<(Group, String, Auth)>, String> {
    if !relay_keeps_rosters(conn) {
        return Ok(None);
    }
    let Some(group) = identity::group(conn).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let Some((me, _)) = identity::public_identity(conn).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if is_restricted(conn, &me).map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let previous = last(conn).map_err(|e| e.to_string())?;
    let seen = state(conn, ROSTER_SEEN).map_err(|e| e.to_string())?;
    let vouched = match (&seen, &previous) {
        (Some(seen), None) => seen == "none",
        (Some(seen), Some((text, _))) => *seen == hash(text),
        (None, _) => false,
    };
    if !vouched {
        return Ok(None);
    }
    let rd = match &previous {
        Some((text, newest)) if newest.epoch == group.epoch => {
            let held = newest.member(&me);
            let mut mine = own_entry(conn, held.map_or(group.epoch, |m| m.since))?;
            if let Some(held) = held {
                // The capability is the group's word about this device, never its own.
                mine.cap = held.cap.clone();
                if held.x25519 == mine.x25519
                    && held.ed25519 == mine.ed25519
                    && held.proto == mine.proto
                {
                    return Ok(None);
                }
            }
            let mut members = newest.members.clone();
            match members.iter_mut().find(|m| m.device == me) {
                Some(slot) => *slot = mine,
                None => members.push(mine),
            }
            Roster {
                v: VERSION,
                group: group.group_id.clone(),
                epoch: group.epoch,
                step: newest.step + 1,
                prev: Some(hash(text)),
                mode: mode(conn),
                signer: me,
                members,
            }
        }
        Some((_, newest)) if newest.epoch > group.epoch => return Ok(None),
        _ => {
            let rows = identity::roster(conn).map_err(|e| e.to_string())?;
            let mut devices: Vec<&str> = rows
                .iter()
                .filter(|d| d.revoked_at.is_none())
                .map(|d| d.device_id.as_str())
                .collect();
            if !devices.contains(&me.as_str()) {
                devices.push(&me);
            }
            let members = entries(
                conn,
                &devices,
                group.epoch,
                previous.as_ref().map(|(_, rd)| rd),
            )?;
            Roster {
                v: VERSION,
                group: group.group_id.clone(),
                epoch: group.epoch,
                step: 0,
                prev: previous.as_ref().map(|(text, _)| hash(text)),
                mode: mode(conn),
                signer: me,
                members,
            }
        }
    };
    // The relay's rule and the judge's: an open document names full members only.
    if rd.mode == Mode::Open && rd.members.iter().any(|m| !m.is_full()) {
        return Ok(None);
    }
    let text = to_text(&rd);
    let auth = authenticate(conn, &group, &text)?;
    Ok(Some((group, text, auth)))
}

#[cfg(test)]
mod tests;
