//! Identify a physical Magic card from a camera frame or a photograph, locally.
//!
//! **This crate knows nothing about cameras.** A frame is a JPEG, and where it came from — a
//! webcam, a phone, a Tauri command, a reader's scan in the inbox — is the caller's business.
//! That is what lets one implementation serve the app on every host and the replay without a
//! second copy of the pipeline.
//!
//! **The recogniser is `crates/card-neural`'s**: two small CNNs and a gallery of looks, agreed
//! over frames ([`session`]). This crate is what turns its reads into decisions a page can add to
//! a tray — the filters, the labels, the decision count and the hand-over between hosts.

pub mod filters;
pub mod host;
pub mod ids;
pub mod labels;
/// The recogniser, for a host handing the session its files
/// ([`session::Session::load_neural`]) — `card_neural::bundled()` on a native host.
pub use card_neural as neural;
pub mod reference;
pub mod replay;
pub mod session;
