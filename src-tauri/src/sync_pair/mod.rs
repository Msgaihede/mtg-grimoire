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
//!
//! **All four are `grimoire-core`'s** since the sync step's second part, re-exported here at
//! the paths they always had. What is still this crate's is [`pairing`]'s nine
//! `#[tauri::command]` wrappers, beside a glob re-export of the core's module of that name.

pub use grimoire_core::sync_pair::crypto;
pub use grimoire_core::sync_pair::identity;
pub use grimoire_core::sync_pair::invite;
/// The webview's IPC surface over the core's state machine.
pub mod pairing;
