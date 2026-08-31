//! The cryptography of pairing, with no database and no clock in sight.
//!
//! Everything here is a pure function of its arguments, which is why it is testable at all: the
//! man-in-the-middle test below runs a real three-party exchange in a few microseconds because
//! there is nothing to mock.
//!
//! **Every random byte in this module comes from the operating system's CSPRNG**, through
//! [`random_bytes`] and through `x25519-dalek`'s own `getrandom` feature. There is no seeded
//! source here, not even for a test — a helper that shared a code path with production and drew
//! from a reproducible generator would make every test in this file pass while the shipped app
//! minted predictable keys.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// The domain separator every derivation in this module carries.
///
/// Versioned, because the day the KDF changes is the day two devices on two builds must fail to
/// pair rather than derive two different keys and blame the network.
const INFO_PAIR: &[u8] = b"mtg-grimoire/pair/v1";
const INFO_SAS: &[u8] = b"mtg-grimoire/sas/v1";
const INFO_RELAY_AUTH: &[u8] = b"mtg-grimoire/relay-auth/v1";
const INFO_ROTATE: &[u8] = b"mtg-grimoire/rotate/v1";
const INFO_RENDEZVOUS: &[u8] = b"mtg-grimoire/rendezvous/v1";

/// XChaCha20-Poly1305's nonce: 192 bits.
const NONCE: usize = 24;

/// One device's X25519 key material.
///
/// The secret is raw bytes rather than a `StaticSecret` so this struct can be written straight
/// into a BLOB column and read straight back — the conversion is `StaticSecret::from`, which is
/// infallible for any 32 bytes.
#[derive(Clone)]
pub struct Keypair {
    pub secret: [u8; 32],
    pub public: [u8; 32],
}

/// What a failed [`open`] says.
///
/// One variant, deliberately. An AEAD that distinguished "wrong key" from "tampered" would be
/// telling an attacker which half of their guess was right, and there is nothing a caller here
/// could do differently with the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("that pairing message could not be read — it is for another device, or it was altered")]
pub struct CryptoError;

/// `N` bytes from the system CSPRNG.
///
/// **Panics if the operating system cannot supply randomness.** That is the right shape: every
/// caller here is minting a key or a nonce, and continuing with a predictable one is worse in
/// every way than not continuing. The condition does not occur on a running Windows session.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the operating system refused to supply random bytes");
    out
}

/// A fresh X25519 keypair for this device.
pub fn keypair() -> Keypair {
    let secret = StaticSecret::random();
    let public = PublicKey::from(&secret);
    Keypair {
        secret: secret.to_bytes(),
        public: public.to_bytes(),
    }
}

/// The key the two pairing devices share, from one ECDH plus one HKDF extract-and-expand.
///
/// **The group id and the token are the salt, not the info.** They are the two values unique to
/// *this* pairing attempt, so binding them into the extract step means a shared secret reused
/// across two attempts still yields two unrelated keys — which is what makes the token
/// one-time in fact rather than by convention.
pub fn pair_key(
    secret: &[u8; 32],
    their_public: &[u8; 32],
    group_id: &[u8; 16],
    token: &[u8; 16],
) -> [u8; 32] {
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(*their_public));
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(group_id);
    salt[16..].copy_from_slice(token);

    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(INFO_PAIR, &mut out)
        .expect("32 bytes is far below HKDF-SHA256's output limit");
    out
}

/// The six digits both readers compare — §7.5 step 3, and the step that is not optional.
///
/// **It is computed over the *derived* key and both public keys, in role order.** A relay that
/// substituted its own key changes the derived key on both sides *and* changes which public key
/// each side saw, so both halves of the transcript move and the two codes disagree. A SAS over
/// the shared secret alone would still work; including the keys is what stops a reflection
/// attack, where an attacker replays A's own key back at A.
///
/// Zero-padded to six characters. `042913` and `42913` are the same number and not the same
/// code, and a reader comparing two screens is comparing characters.
pub fn sas(pair_key: &[u8; 32], initiator_public: &[u8; 32], joiner_public: &[u8; 32]) -> String {
    let mut transcript = [0u8; 64];
    transcript[..32].copy_from_slice(initiator_public);
    transcript[32..].copy_from_slice(joiner_public);

    let hk = Hkdf::<Sha256>::new(Some(&transcript), pair_key);
    let mut out = [0u8; 4];
    hk.expand(INFO_SAS, &mut out).expect("4 bytes");
    format!("{:06}", u32::from_be_bytes(out) % 1_000_000)
}

/// The credential a device presents to the relay to say "I am in this group".
///
/// **One-way from the group key, which is what makes it safe to send.** The relay stores this
/// and can invert nothing from it: it never learns the group key, so what it holds stays
/// ciphertext it cannot open. Every device in the group derives the same value without anything
/// being distributed, which is what makes an entitlement a property of the *group* rather than of
/// whichever device happened to open a browser.
///
/// **It changes with the epoch, and that is how a removal reaches the device that was removed.**
/// A rotation mints a new group key, so the auth derived from it is new too; the departed device
/// derives the old one, the relay has the new one, and the refusal is what sends it to `/keys` to
/// find out it is not on the manifest.
///
/// The epoch is in the info **as well as** being baked into the key, which is belt and braces
/// rather than a second mechanism: a group key that was ever reused across two epochs — a
/// restore from backup, a bug — would otherwise yield one auth for two epochs, and the relay's
/// monotonic check is the only thing standing between a removed device and re-entry.
///
/// The group id is the **salt** and the purpose is the **info**, which is [`pair_key`]'s shape:
/// the value unique to *this* use binds the extract step, so two groups that somehow shared a key
/// still present two unrelated auths.
pub fn relay_auth(group_key: &[u8; 32], group_id: &str, epoch: i64) -> String {
    let hk = Hkdf::<Sha256>::new(Some(group_id.as_bytes()), group_key);
    let mut info = INFO_RELAY_AUTH.to_vec();
    info.push(b'|');
    info.extend_from_slice(epoch.to_string().as_bytes());
    let mut out = [0u8; 32];
    hk.expand(&info, &mut out)
        .expect("32 bytes is far below HKDF-SHA256's output limit");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// The key one rewrapped blob is sealed under: one ECDH, one HKDF, per epoch.
///
/// Both sides compute it from material they already hold — the remover from its own secret and
/// the target's `sync_devices.public_key`, the target from its own secret and the remover's — so
/// a rotation publishes no key material anybody has to be told about out of band.
///
/// **Per epoch, and that is the mechanism rather than a flourish.** Two rotations to the same
/// device wrap under two unrelated keys, so a blob from epoch four is not a blob for epoch five
/// even before the AAD refuses it.
fn rotate_kek(
    my_secret: &[u8; 32],
    their_public: &[u8; 32],
    group_id: &str,
    epoch: i64,
) -> [u8; 32] {
    let shared = StaticSecret::from(*my_secret).diffie_hellman(&PublicKey::from(*their_public));
    let hk = Hkdf::<Sha256>::new(Some(group_id.as_bytes()), shared.as_bytes());
    let mut info = INFO_ROTATE.to_vec();
    info.push(b'|');
    info.extend_from_slice(epoch.to_string().as_bytes());
    let mut out = [0u8; 32];
    hk.expand(&info, &mut out)
        .expect("32 bytes is far below HKDF-SHA256's output limit");
    out
}

/// What one rewrapped blob is bound to: the group, the device it is for, and the epoch.
///
/// **`\0` between the fields rather than `|`**, which is [`crate::sync_engine::wire`]'s rule and
/// its reason: a device id containing the separator could otherwise be read as a different
/// `(group, device, epoch)` triple. And it matters more here than it does there, because the
/// device half of *this* triple is a manifest key the relay stores and hands back — the one
/// field on the wire whose spelling a caller chooses.
fn rotate_aad(group_id: &str, device: &str, epoch: i64) -> Vec<u8> {
    format!("{group_id}\0{device}\0{epoch}").into_bytes()
}

/// Seal a freshly minted group key for one device that stays in the group.
///
/// **This is what makes a removal reach the devices that are not doing the removing.** Rotating
/// the key stops the departed device reading anything new; without this hop it also stops every
/// remaining device, which stalls at the old epoch for ever — one removal bricking a group of
/// three. The blob goes to the relay in the manifest, and the relay can open none of them.
///
/// **The target device and the epoch are in the associated data, not merely in the key.** The
/// relay holds every device's blob in one JSON object, so lifting one row and presenting it as
/// another device's is the attack that costs nothing to try; binding both means such a blob opens
/// for nobody rather than for the wrong body. The group id is bound for the same reason one
/// epoch's blob must not be replayed into another group that shares a pair of keypairs.
pub fn wrap_group_key(
    my_secret: &[u8; 32],
    their_public: &[u8; 32],
    group_id: &str,
    target_device: &str,
    epoch: i64,
    new_group_key: &[u8; 32],
) -> Result<Vec<u8>, CryptoError> {
    let kek = rotate_kek(my_secret, their_public, group_id, epoch);
    seal(
        &kek,
        &rotate_aad(group_id, target_device, epoch),
        new_group_key,
    )
}

/// The other half: open the blob `/keys` answered and take the group key out of it.
///
/// **Every refusal is a `CryptoError` and none is a panic**, which is the whole of what this
/// function has to defend against beyond the AEAD. `blob` arrives from the network, so it can be
/// empty, shorter than a nonce, or — the case the length check below exists for — a perfectly
/// authentic seal that simply does not hold 32 bytes. A `try_into` on that last one is where a
/// panic would live, in a code path a stranger who guessed a group id can reach.
///
/// A blob that opens is one the *remover* sealed for *this* device at *this* epoch, and there is
/// no weaker reading of a success here: the wrapping key is an ECDH nobody else can compute and
/// the AAD names all three.
pub fn unwrap_group_key(
    my_secret: &[u8; 32],
    their_public: &[u8; 32],
    group_id: &str,
    my_device: &str,
    epoch: i64,
    blob: &[u8],
) -> Result<[u8; 32], CryptoError> {
    let kek = rotate_kek(my_secret, their_public, group_id, epoch);
    let plaintext = open(&kek, &rotate_aad(group_id, my_device, epoch), blob)?;
    plaintext.as_slice().try_into().map_err(|_| CryptoError)
}

/// The address the two pairing devices meet at on the relay.
///
/// **One-way, and that is the whole of why this function exists rather than the token being used
/// directly.** The token is the HKDF *salt* in [`pair_key`] — it is half of what binds the
/// derivation to this attempt — so an address the relay could invert would be the relay holding
/// that half. HKDF-SHA256 cannot be run backwards, so what the relay gets is 128 bits it can match
/// two requests on and learn nothing else from.
///
/// **Hex and 16 bytes because the route regex pins exactly that** (`^/p/([0-9a-f]{32})/…`). A
/// longer id would be refused by the relay; a shorter one would make two pairings collide.
///
/// **The token is the input keying material and not the salt**, which is the opposite of
/// [`pair_key`]'s use of it and is deliberate: there is no second input here to bind, so the
/// purpose string alone does the domain separation.
pub fn rendezvous_id(token: &[u8; 16]) -> String {
    let hk = Hkdf::<Sha256>::new(None, token);
    let mut out = [0u8; 16];
    hk.expand(INFO_RENDEZVOUS, &mut out)
        .expect("16 bytes is far below HKDF-SHA256's output limit");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

/// Seal `plaintext` under `key`, authenticating `aad`.
///
/// The 24-byte nonce is drawn fresh and prefixed to the ciphertext, so a caller never has to
/// carry one. That is the whole reason this is XChaCha20 rather than the 96-bit-nonce variant:
/// a random 192-bit nonce is safe to draw for every message forever, and a counter kept across
/// three devices and a restore-from-backup is exactly the thing that gets reused.
pub fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = random_bytes::<NONCE>();
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError)?;
    let mut out = Vec::with_capacity(NONCE + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// The other half. Refuses anything it cannot authenticate, and anything too short to be a blob.
pub fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    // The length check comes before the slice, not after: a blob shorter than a nonce is a
    // panic waiting in `sealed[..NONCE]`, and this function is reachable from a paste box.
    if sealed.len() <= NONCE {
        return Err(CryptoError);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            XNonce::from_slice(&sealed[..NONCE]),
            Payload {
                msg: &sealed[NONCE..],
                aad,
            },
        )
        .map_err(|_| CryptoError)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crypto_test_token() -> [u8; 16] {
        [0xA5; 16]
    }

    #[test]
    fn a_rendezvous_id_is_32_hex_characters_and_stable() {
        let token = [7u8; 16];
        let id = rendezvous_id(&token);
        assert_eq!(id.len(), 32);
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(
            id,
            rendezvous_id(&token),
            "the same token must address the same rendezvous"
        );
    }

    #[test]
    fn a_rendezvous_id_does_not_reveal_the_token() {
        // Not a proof of one-wayness — HKDF is that. This is the property a reader can check:
        // the token's bytes do not appear in the address the relay is handed.
        let token = crypto_test_token();
        let hex: String = token.iter().map(|b| format!("{b:02x}")).collect();
        assert_ne!(rendezvous_id(&token), hex);
    }

    #[test]
    fn two_tokens_one_bit_apart_address_unrelated_rendezvous() {
        let mut a = [0u8; 16];
        let mut b = [0u8; 16];
        b[15] = 1;
        a[15] = 0;
        assert_ne!(rendezvous_id(&a), rendezvous_id(&b));
    }

    /// The auth is a function of the key, the id and the epoch, and no two of the three may be
    /// dropped from it.
    #[test]
    fn relay_auth_separates_every_input() {
        let k1 = [1u8; 32];
        let k2 = [2u8; 32];
        let a = relay_auth(&k1, "group-a", 0);
        assert_eq!(a.len(), 64, "64 hex characters");
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, relay_auth(&k2, "group-a", 0), "a different key");
        assert_ne!(a, relay_auth(&k1, "group-b", 0), "a different group");
        // **The epoch, even though the key already changes with it.** A group key that was ever
        // reused across two epochs — a restore from backup, a bug — would otherwise yield one auth
        // for two epochs, and the relay's monotonic check is the only thing standing between a
        // removed device and re-entry.
        assert_ne!(a, relay_auth(&k1, "group-a", 1), "a different epoch");
        assert_eq!(a, relay_auth(&k1, "group-a", 0), "and it is deterministic");
    }

    /// The rewrapped key opens for the device it was sealed to, and **for nobody else** — which is
    /// the one assertion the whole rotation scheme rests on.
    #[test]
    fn a_rewrapped_key_opens_only_for_its_target() {
        let remover = keypair();
        let target = keypair();
        let bystander = keypair();
        let new_key = [9u8; 32];

        let blob = wrap_group_key(
            &remover.secret,
            &target.public,
            "g1",
            "dev-target",
            4,
            &new_key,
        )
        .expect("wrap");

        assert_eq!(
            unwrap_group_key(
                &target.secret,
                &remover.public,
                "g1",
                "dev-target",
                4,
                &blob
            )
            .expect("the target opens it"),
            new_key
        );
        assert!(
            unwrap_group_key(
                &bystander.secret,
                &remover.public,
                "g1",
                "dev-target",
                4,
                &blob
            )
            .is_err(),
            "a device that is not the target must not open it"
        );
        // The AAD binds the device and the epoch, so a blob lifted from one row of the manifest and
        // presented as another device's does not open either.
        assert!(
            unwrap_group_key(&target.secret, &remover.public, "g1", "dev-other", 4, &blob).is_err(),
            "the target device is bound"
        );
        assert!(
            unwrap_group_key(
                &target.secret,
                &remover.public,
                "g1",
                "dev-target",
                5,
                &blob
            )
            .is_err(),
            "the epoch is bound"
        );
        assert!(
            unwrap_group_key(
                &target.secret,
                &remover.public,
                "g2",
                "dev-target",
                4,
                &blob
            )
            .is_err(),
            "the group is bound"
        );
    }

    /// A blob that is not a blob must be refused rather than panicked over, and a blob that opens
    /// to the wrong number of bytes is refused too. Both arrive from the network.
    #[test]
    fn unwrap_refuses_a_malformed_blob_without_panicking() {
        let remover = keypair();
        let target = keypair();

        assert!(
            unwrap_group_key(&target.secret, &remover.public, "g1", "d", 1, &[]).is_err(),
            "empty"
        );
        assert!(
            unwrap_group_key(&target.secret, &remover.public, "g1", "d", 1, &[0u8; 24]).is_err(),
            "exactly a nonce and nothing after it"
        );
        assert!(
            unwrap_group_key(&target.secret, &remover.public, "g1", "d", 1, &[7u8; 200]).is_err(),
            "two hundred bytes of noise"
        );

        // A well-formed seal under the right key that simply does not hold 32 bytes. The AEAD
        // authenticates it, so only the length check can refuse it — and `try_into` on a Vec of
        // the wrong length is exactly where a panic would live.
        let kek = rotate_kek(&remover.secret, &target.public, "g1", 1);
        let short = seal(&kek, &rotate_aad("g1", "d", 1), b"not thirty-two bytes").unwrap();
        assert!(unwrap_group_key(&target.secret, &remover.public, "g1", "d", 1, &short).is_err());
    }

    /// Two epochs seal the same key under two unrelated wrapping keys, and a blob does not carry
    /// across. `relay_auth`'s epoch argument is belt and braces; this one is the mechanism.
    #[test]
    fn each_epoch_wraps_under_its_own_key() {
        let remover = keypair();
        let target = keypair();
        let key = [3u8; 32];

        let four =
            wrap_group_key(&remover.secret, &target.public, "g1", "dev", 4, &key).expect("wrap");
        let five =
            wrap_group_key(&remover.secret, &target.public, "g1", "dev", 5, &key).expect("wrap");
        assert_ne!(four, five, "the nonce alone would make these differ");

        assert_eq!(
            unwrap_group_key(&target.secret, &remover.public, "g1", "dev", 5, &five).unwrap(),
            key
        );
        assert_ne!(
            rotate_kek(&remover.secret, &target.public, "g1", 4),
            rotate_kek(&remover.secret, &target.public, "g1", 5),
            "one wrapping key for two epochs"
        );
    }

    /// Both sides of a real exchange must derive the same pair key. This is the whole of the
    /// ECDH, and it is genuinely two-sided: two independent keypairs, each deriving from the
    /// other's public half, never sharing a secret.
    #[test]
    fn both_sides_derive_the_same_pair_key() {
        let a = keypair();
        let b = keypair();
        let gid = [7u8; 16];
        let token = [9u8; 16];

        let ka = pair_key(&a.secret, &b.public, &gid, &token);
        let kb = pair_key(&b.secret, &a.public, &gid, &token);
        assert_eq!(ka, kb);
        assert_ne!(
            ka, [0u8; 32],
            "a key of zeroes is a derivation that did nothing"
        );
    }

    /// A man in the middle substitutes its own public key. Both readers then see *different*
    /// six-digit codes, which is the entire security argument of §7.5 step 3.
    #[test]
    fn a_substituted_key_makes_the_two_codes_disagree() {
        let a = keypair();
        let b = keypair();
        let m = keypair(); // the relay, lying to both ends
        let gid = [1u8; 16];
        let token = [2u8; 16];

        // A believes it is talking to M, thinking M is B.
        let a_side = pair_key(&a.secret, &m.public, &gid, &token);
        // B believes it is talking to M, thinking M is A.
        let b_side = pair_key(&b.secret, &m.public, &gid, &token);

        let a_code = sas(&a_side, &a.public, &m.public);
        let b_code = sas(&b_side, &m.public, &b.public);
        assert_ne!(
            a_code, b_code,
            "if these matched, the SAS would defeat nothing and pairing would be unsafe"
        );
    }

    /// Six digits, zero-padded, and stable for one input.
    #[test]
    fn the_sas_is_six_digits_and_deterministic() {
        let k = [3u8; 32];
        let p = [4u8; 32];
        let q = [5u8; 32];
        let code = sas(&k, &p, &q);
        assert_eq!(code.len(), 6, "got {code:?}");
        assert!(code.chars().all(|c| c.is_ascii_digit()), "got {code:?}");
        assert_eq!(code, sas(&k, &p, &q));
    }

    /// A code below 100 000 is still six characters. `042913` and `42913` are the same number
    /// and not the same code, and a reader comparing two screens is comparing characters.
    ///
    /// Found by search rather than asserted about one input, because the padding is exactly
    /// the branch that never fires on a hand-picked example.
    #[test]
    fn a_small_sas_is_zero_padded_rather_than_short() {
        let mut found = false;
        for i in 0..4096u32 {
            let mut p = [0u8; 32];
            p[..4].copy_from_slice(&i.to_be_bytes());
            let code = sas(&[9u8; 32], &p, &[1u8; 32]);
            assert_eq!(code.len(), 6, "{code:?} is not six characters");
            if code.starts_with('0') {
                found = true;
            }
        }
        assert!(
            found,
            "4096 draws produced no code below 100 000, so the padding was never exercised"
        );
    }

    /// Order is part of the transcript: the initiator's key first, the joiner's second. Both
    /// sides know which role they are, so this is not ambiguity — it is what stops a reflection.
    #[test]
    fn the_sas_depends_on_which_side_is_the_initiator() {
        let k = [3u8; 32];
        let p = [4u8; 32];
        let q = [5u8; 32];
        assert_ne!(sas(&k, &p, &q), sas(&k, &q, &p));
    }

    /// A sealed blob opens under the same key and the same associated data.
    #[test]
    fn a_sealed_blob_round_trips() {
        let k = random_bytes::<32>();
        let sealed = seal(&k, b"aad", b"the group key").unwrap();
        assert_ne!(
            sealed, b"the group key",
            "the ciphertext is not the plaintext"
        );
        assert_eq!(open(&k, b"aad", &sealed).unwrap(), b"the group key");
    }

    /// The three ways it must refuse: the wrong key, tampered associated data, and one flipped
    /// ciphertext bit. Each is an authentication failure and none may return plaintext.
    #[test]
    fn open_refuses_a_wrong_key_wrong_aad_or_a_flipped_bit() {
        let k = random_bytes::<32>();
        let other = random_bytes::<32>();
        let sealed = seal(&k, b"aad", b"secret").unwrap();

        assert!(open(&other, b"aad", &sealed).is_err(), "wrong key");
        assert!(open(&k, b"different", &sealed).is_err(), "wrong aad");

        let mut bent = sealed.clone();
        let last = bent.len() - 1;
        bent[last] ^= 1;
        assert!(open(&k, b"aad", &bent).is_err(), "flipped bit");
    }

    /// A blob shorter than a nonce cannot be a blob, and must not panic on the slice.
    #[test]
    fn open_refuses_a_truncated_blob_without_panicking() {
        let k = random_bytes::<32>();
        assert!(open(&k, b"aad", &[0u8; 4]).is_err());
        assert!(open(&k, b"aad", &[]).is_err());
        // Exactly a nonce and nothing after it: the boundary the length check is written on.
        assert!(open(&k, b"aad", &[0u8; 24]).is_err());
    }

    /// Two nonces in a row must differ. A repeated nonce under one key is the failure that
    /// breaks this cipher outright, and a `seal` that forgot to draw one would look fine.
    #[test]
    fn two_seals_of_one_plaintext_differ() {
        let k = random_bytes::<32>();
        assert_ne!(
            seal(&k, b"a", b"same").unwrap(),
            seal(&k, b"a", b"same").unwrap()
        );
    }

    /// Two draws from the OS are not the same bytes, and neither is zero.
    ///
    /// A helper that returned its zeroed buffer would pass every round-trip test in this file:
    /// one constant key still seals and opens.
    #[test]
    fn random_bytes_are_not_a_zeroed_buffer() {
        let a = random_bytes::<32>();
        let b = random_bytes::<32>();
        assert_ne!(a, [0u8; 32]);
        assert_ne!(a, b);
    }

    /// Two keypairs are two keypairs, and a public key is derived from its own secret.
    #[test]
    fn a_keypair_is_fresh_and_its_public_half_matches_its_secret() {
        let a = keypair();
        let b = keypair();
        assert_ne!(a.secret, b.secret);
        assert_ne!(a.public, b.public);

        // The public half is what X25519 says it is for that secret, checked from the other
        // side: a derivation against a third key agrees only if both halves belong together.
        let c = keypair();
        assert_eq!(
            pair_key(&a.secret, &c.public, &[0u8; 16], &[0u8; 16]),
            pair_key(&c.secret, &a.public, &[0u8; 16], &[0u8; 16]),
        );
    }

    /// The token is what makes one shared secret produce two unrelated keys, which is what
    /// "one-time" means at this layer rather than at the state machine's.
    #[test]
    fn the_group_id_and_the_token_both_change_the_derived_key() {
        let a = keypair();
        let b = keypair();
        let base = pair_key(&a.secret, &b.public, &[1u8; 16], &[2u8; 16]);
        assert_ne!(base, pair_key(&a.secret, &b.public, &[9u8; 16], &[2u8; 16]));
        assert_ne!(base, pair_key(&a.secret, &b.public, &[1u8; 16], &[9u8; 16]));
    }
}
