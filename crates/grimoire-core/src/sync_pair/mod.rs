//! Pairing two devices into one group — the half that touches no database and no network.
//!
//! * [`crypto`] — X25519, HKDF-SHA256, XChaCha20-Poly1305 and the six-digit short
//!   authentication string. No database, no I/O, no clock.
//! * [`invite`] — the 64-byte pairing payload as a typed code and as a QR module matrix.
//!
//! `identity` (three SQLite tables) and `pairing` (the state machine and the commands) are
//! still `src-tauri`'s `sync_pair`, which re-exports these two beside them.

pub mod crypto;
pub mod invite;
