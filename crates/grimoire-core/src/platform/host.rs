//! **What kind of host this is, in the two facts a download turns on.**
//!
//! Every other interface under this directory hides a difference between hosts. This one says
//! it out loud, because for a download the difference is not one call that behaves two ways —
//! it is two shapes of the whole run, and the module that owns a download has to pick one
//! before it sends anything:
//!
//! | | Native (the desktop, Android) | A page (the web host's Worker) |
//! | --- | --- | --- |
//! | [`keeps_files`] | `true`: a download lands in `<data>/tmp/` and is read back | `false`: [`super::files`] refuses, so a body is fed to its sink a chunk at a time |
//! | [`asks_as_a_page`] | `false`: a request is this process's own | `true`: every request is a cross-origin `fetch` |
//!
//! **What "asks as a page" costs, measured** (`curl` with an `Origin`, 2026-10-04 —
//! `docs/reference/light-app.md` §9.1 has the table):
//!
//! * **no request may carry a header outside the CORS safelist.** `If-None-Match` and
//!   `If-Modified-Since` cost a pre-flight, and both `data.scryfall.io` and Commander Spellbook
//!   answer a pre-flight 403 — so the request itself fails. A conditional request is therefore
//!   not sent, and "unchanged" is decided from what a body or a readable header says;
//! * **no response header a server does not expose can be read.** Nobody this app downloads
//!   from sends `Access-Control-Expose-Headers`, so `ETag`, `Content-Range` and `Retry-After`
//!   read as absent. `Content-Length` and `Last-Modified` are safelisted and readable;
//! * **a host that sends no `Access-Control-Allow-Origin` cannot be asked at all** — Mana
//!   Pool's price list. The request would leave, the browser would refuse the answer, and all
//!   a page would see is a failed fetch. So a feed says whether it permits a page
//!   (`marketplace_feed::FeedProvider::permits_a_page`) and is refused in a sentence, before
//!   any request, on a host that is one.
//!
//! **Two questions and one fact.** No host this crate has is a page that keeps files, or a
//! process with none, so both are answered from one switch. They stay two functions because a
//! call site asks one of them: `if !host::keeps_files()` reads as the reason for a streamed
//! ingest, and `if host::asks_as_a_page()` as the reason a header is left off.
//!
//! **`cfg` picks the answer, and a native test can pick the other one**: [`emulate_page`]
//! makes the calling thread a page until its guard drops — and a host with one thread, because
//! a page's engine is a Worker ([`super::alone`]). On such a thread [`super::files`] refuses
//! as the browser arm does, and [`super::http`] hides the response headers a browser would
//! hide, so a run that passes there has not touched a file or read an `ETag`. It is what lets
//! the mock-server tests of every download run the page's arm on a desktop. A build that
//! ships has no switch: both questions are constants.

/// Does this host keep files — a folder a download can be written into and read back from?
///
/// `false` in a browser, where the databases are SQLite's own OPFS VFS and nothing else is
/// stored by this crate.
pub fn keeps_files() -> bool {
    !imp::page()
}

/// Are this host's requests a page's — cross-origin `fetch`es, bound by CORS?
///
/// See the module doc for what follows from `true`.
pub fn asks_as_a_page() -> bool {
    imp::page()
}

/// Whether the calling thread is *standing in for* a page ([`emulate_page`]) rather than being
/// one. Always `false` in a build that ships, and always `false` in a browser.
///
/// [`super::http`] asks it for one thing: a real browser hides an unexposed response header by
/// itself, and a native test has to have it hidden for it.
pub fn emulated() -> bool {
    imp::emulated()
}

/// Stand in for a page on the calling thread until the guard is dropped: no files, requests
/// that must pass CORS, and one thread ([`super::alone::emulate`], which the guard holds too).
///
/// Per thread and never global, for [`super::alone`]'s reason. **Do not nest it inside an
/// [`super::alone::emulate`] of the caller's own** — the inner guard's drop ends both.
#[cfg(any(test, feature = "testing"))]
pub fn emulate_page() -> Page {
    imp::set(true);
    Page(super::alone::emulate())
}

/// [`emulate_page`]'s guard.
#[cfg(any(test, feature = "testing"))]
pub struct Page(#[allow(dead_code)] super::alone::Emulation);

#[cfg(any(test, feature = "testing"))]
impl Drop for Page {
    fn drop(&mut self) {
        imp::set(false);
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    #[inline(always)]
    pub fn page() -> bool {
        true
    }

    #[inline(always)]
    pub fn emulated() -> bool {
        false
    }

    /// Nothing to switch: this target is the page.
    #[cfg(any(test, feature = "testing"))]
    pub fn set(_page: bool) {}
}

#[cfg(all(not(target_family = "wasm"), not(any(test, feature = "testing"))))]
mod imp {
    #[inline(always)]
    pub fn page() -> bool {
        false
    }

    #[inline(always)]
    pub fn emulated() -> bool {
        false
    }
}

#[cfg(all(not(target_family = "wasm"), any(test, feature = "testing")))]
mod imp {
    use std::cell::Cell;

    thread_local! {
        static PAGE: Cell<bool> = const { Cell::new(false) };
    }

    pub fn page() -> bool {
        PAGE.with(Cell::get)
    }

    pub fn emulated() -> bool {
        page()
    }

    pub fn set(page: bool) {
        PAGE.with(|flag| flag.set(page));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A native host keeps files and asks as itself; a thread standing in for a page does
    /// neither, is alone, and is given everything back when the guard goes.
    #[test]
    fn a_page_is_stood_in_for_on_one_thread_and_ends_with_its_guard() {
        assert!(keeps_files() && !asks_as_a_page() && !emulated());
        {
            let _page = emulate_page();
            assert!(!keeps_files() && asks_as_a_page() && emulated());
            assert!(
                crate::platform::alone::emulated(),
                "a page's engine is a Worker: one thread"
            );
            std::thread::scope(|scope| {
                scope
                    .spawn(|| assert!(keeps_files(), "another thread stands in for nothing"))
                    .join()
                    .unwrap();
            });
        }
        assert!(keeps_files() && !asks_as_a_page());
        assert!(!crate::platform::alone::emulated());
    }

    /// The file interface refuses on such a thread exactly as the browser arm does, so a run
    /// that passes under [`emulate_page`] has written nothing through it.
    #[tokio::test]
    async fn files_refuse_on_a_thread_standing_in_for_a_page() {
        use crate::platform::files;
        let dir = crate::scratch::path("host-page-files");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download.gz");
        std::fs::write(&path, b"here").unwrap();

        let _page = emulate_page();
        let unsupported = |e: std::io::Error| e.kind() == std::io::ErrorKind::Unsupported;
        assert!(files::open(&path).err().is_some_and(unsupported));
        assert!(files::read(&path).err().is_some_and(unsupported));
        assert!(files::write(&path, b"x").err().is_some_and(unsupported));
        assert!(files::remove(&path).err().is_some_and(unsupported));
        assert!(files::create_dir_all(&dir.join("tmp"))
            .err()
            .is_some_and(unsupported));
        assert!(files::listing(&dir).err().is_some_and(unsupported));
        assert!(!files::is_file(&path) && !files::exists(&path));
        assert!(files::aio::Writer::create(&path)
            .await
            .err()
            .is_some_and(unsupported));
        assert!(files::aio::len(&path).await.err().is_some_and(unsupported));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"here",
            "and the file is as it was"
        );
        assert!(!dir.join("tmp").exists());
    }
}
