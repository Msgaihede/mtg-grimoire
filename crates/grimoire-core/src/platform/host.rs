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
//! **The sync relay is the one host that answers for the first rule, so it is the one host
//! asked with a header outside the safelist**: every request to it carries `authorization` or
//! a JSON `content-type` (`sync_engine::client`, `sync_engine::entitlement`), each costs a
//! pre-flight, and the relay answers that pre-flight — and stamps the answer after it, a
//! refusal included — for the origins on its allow-list (`relay/src/cors.ts`). The second rule
//! holds there unbent: the relay exposes no response header and the sync client reads none.
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

/// **Await `work` on a host that keeps files; on a page answer `refused`, and leave `work`
/// out of the build.**
///
/// For an `async fn` whose whole body is a host with files' business — a download into a
/// folder — and which a page must not carry the code of. **An early return does not do that
/// in an `async fn`**, though it does in an ordinary one: `if !keeps_files() { return … }` is
/// a constant on `wasm32` and the optimiser drops what follows it — in the function's *first*
/// state. Every `.await` after it is another state of the same machine, entered by a number
/// read back out of the future, and nothing proves to the linker that the number is never
/// written; so the states stay, and so does everything they call. Measured on 2026-10-07: the
/// scanner's asset fetch, refused on a page by exactly such a first line, kept its whole body
/// in the web host's module and with it the OCR runtime its model check names — 9 961 355 B
/// where the module is 6.9 MB without (`Cargo.toml`'s `[profile.wasm]` has the rule that
/// broke).
///
/// Here the page's arm never *calls* `work`, so the closure's body is instantiated by nothing
/// and whatever it alone reaches is not in the module at all — a fact about what is compiled,
/// not about what an optimiser can see. A native thread standing in for a page
/// ([`emulate_page`]) takes the same arm, so a test of the refusal runs on a desktop.
pub async fn with_files<T, F>(work: impl FnOnce() -> F, refused: impl FnOnce() -> T) -> T
where
    F: std::future::Future<Output = T>,
{
    #[cfg(target_family = "wasm")]
    {
        // Dropped uncalled: nothing behind it is compiled into this target.
        drop(work);
        refused()
    }
    #[cfg(not(target_family = "wasm"))]
    {
        if keeps_files() {
            work().await
        } else {
            refused()
        }
    }
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

    /// `with_files` runs the work on a host with files and never on a page — where it answers
    /// the refusal instead, without the work's closure having been called at all.
    #[test]
    fn work_for_a_host_with_files_is_never_called_on_a_page() {
        use std::future::Future as _;

        let run = |called: &std::cell::Cell<bool>| {
            let work = || async {
                called.set(true);
                "worked"
            };
            let mut future = std::pin::pin!(with_files(work, || "refused"));
            let waker = std::task::Waker::noop();
            match future
                .as_mut()
                .poll(&mut std::task::Context::from_waker(waker))
            {
                std::task::Poll::Ready(answer) => answer,
                std::task::Poll::Pending => unreachable!("nothing here waits"),
            }
        };
        let called = std::cell::Cell::new(false);
        assert_eq!(run(&called), "worked");
        assert!(called.get());

        let called = std::cell::Cell::new(false);
        let _page = emulate_page();
        assert_eq!(run(&called), "refused");
        assert!(!called.get(), "a page ran the work it was to be kept from");
    }

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
