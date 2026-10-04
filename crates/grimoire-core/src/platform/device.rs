//! What this machine calls itself — the name a device mints for its pairing identity — and,
//! where it calls itself nothing, what kind of machine it is.
//!
//! | | Windows, Linux, macOS | Android | Browser |
//! | --- | --- | --- | --- |
//! | [`name`] | `COMPUTERNAME` on Windows, `HOSTNAME` elsewhere | `HOSTNAME`, which is usually not there | none: a page is told no such thing |
//! | [`kind`] | `Desktop` | `Android` | `Browser` |
//!
//! **Read straight out of the environment rather than through a `hostname` crate** — one string
//! read once per install is not worth a dependency with a `gethostname` call behind it.
//! **`HOSTNAME` is a shell variable on Linux and macOS and is usually not exported to a
//! process**, so no name is the ordinary answer there rather than the exceptional one, and
//! [`kind`] is what a device is called. That is the honest trade for a portable Windows app:
//! Windows puts `COMPUTERNAME` in every process's environment.
//!
//! **[`kind`] is the word a device with no name is filed under on every other device's
//! roster**, so it has to be true of the host: a browser install that called itself `Desktop`
//! — which every host did until the web host's first run showed the line "Desktop — not
//! paired yet." in a browser tab — reads as a second copy of the reader's own desktop. A
//! thread standing in for a page ([`super::host::emulate_page`]) answers as a page does.

/// The machine's name as the environment gives it, untrimmed, or `None` when it gives none —
/// which is always, on a host that is a page.
pub fn name() -> Option<String> {
    if super::host::asks_as_a_page() {
        return None;
    }
    imp::name()
}

/// What kind of machine this is, in one word: what a device is called when [`name`] has
/// nothing to say.
pub fn kind() -> &'static str {
    if super::host::asks_as_a_page() {
        return BROWSER;
    }
    imp::KIND
}

/// A page's word. Named once, so the browser arm and a native test standing in for one
/// cannot disagree.
const BROWSER: &str = "Browser";

#[cfg(not(target_family = "wasm"))]
mod imp {
    #[cfg(not(target_os = "android"))]
    pub const KIND: &str = "Desktop";
    #[cfg(target_os = "android")]
    pub const KIND: &str = "Android";

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
    pub const KIND: &str = super::BROWSER;

    pub fn name() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A desktop is a desktop, and a thread standing in for a page is told no name and is a
    /// browser — the word a nameless device is filed under on every other device's roster.
    #[test]
    fn a_page_has_no_name_and_is_a_browser() {
        assert_eq!(kind(), "Desktop");
        let _page = crate::platform::host::emulate_page();
        assert_eq!(name(), None);
        assert_eq!(kind(), "Browser");
    }
}
