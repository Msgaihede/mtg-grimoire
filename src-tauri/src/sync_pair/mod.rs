//! Pairing two devices into one group, with no account and no server-side identity.
//!
//! Four layers, and the boundary between them is that only the last two touch SQLite:
//!
//! * [`crypto`] — X25519, HKDF-SHA256, XChaCha20-Poly1305 and the six-digit short
//!   authentication string. No database, no I/O, no clock.
//! * [`invite`] — the 64-byte pairing payload as a typed code and as a QR module matrix.
//! * [`identity`] — this device's keypair, the group it is in, and the roster, in three tables.
//! * [`pairing`] — the state machine and the commands the webview calls.
//!
//! **TypeScript renders, compares and confirms; it never sees a key.** The six digits cross the
//! IPC boundary as a string because they are what a *person* compares, and everything else that
//! crosses is either a public key or a sealed blob.

pub mod crypto;
pub mod identity;
pub mod invite;
pub mod pairing;
