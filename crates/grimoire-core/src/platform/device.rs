//! What this machine calls itself — the name a device mints for its pairing identity.
//!
//! | | Native | Browser |
//! | --- | --- | --- |
//! | [`name`] | `COMPUTERNAME` on Windows, `HOSTNAME` elsewhere | none: a page is told no such thing |
//!
//! **Read straight out of the environment rather than through a `hostname` crate** — one string
//! read once per install is not worth a dependency with a `gethostname` call behind it.
//! **`HOSTNAME` is a shell variable on Linux and macOS and is usually not exported to a
//! process**, so no name is the ordinary answer there rather than the exceptional one, and the
//! caller's fallback word is what a device is called. That is the honest trade for a portable
//! Windows app: Windows puts `COMPUTERNAME` in every process's environment.

/// The machine's name as the environment gives it, untrimmed, or `None` when it gives none.
pub fn name() -> Option<String> {
    imp::name()
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    pub fn name() -> Option<String> {
        const HOST_VAR: &str = if cfg!(windows) {
            "COMPUTERNAME"
        } else {
            "HOSTNAME"
        };
        std::env::var(HOST_VAR).ok()
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    pub fn name() -> Option<String> {
        None
    }
}
