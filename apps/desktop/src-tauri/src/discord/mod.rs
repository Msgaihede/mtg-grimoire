//! **Settings → Integrations → Discord** — the desktop's half of the Discord spec (issue #1096,
//! §13): linking the reader's Discord account to the front (`mtg-grimoire-discord`, a PKCE link),
//! and switching the bot on and off as a **restricted device in the reader's sync group**.
//!
//! * [`commands`] — the six `#[tauri::command]`s and the two structs the page mirrors.
//! * [`flow`] — what they do: the link, the switch-on (gate → the *Added from Discord* folder →
//!   `pairing::begin_integration` → `POST /link/enroll` → the bot's join →
//!   `pairing::confirm_pinned`, pairing the bot as `add`, spec §14) and the switch-off.
//! * [`front`] — the five HTTPS requests, and every sentence a refusal becomes.
//! * [`local`] — what this device keeps, in `sync_state` beside the sync identity.
//!
//! The pinned pairing, the signed roster document it publishes and the gate are the engine's
//! (`grimoire_core::sync_pair::pairing`, `grimoire_core::integration`); nothing here holds a key.

pub mod commands;
pub mod flow;
pub mod front;
pub mod local;
#[cfg(test)]
mod tests;
