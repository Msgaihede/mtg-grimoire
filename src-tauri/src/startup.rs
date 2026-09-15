//! Whether the app has finished starting, as the webview asks it.
//!
//! **Opening the databases happens on a thread of its own, and this is what that costs the page.**
//! Tauri runs `setup` inside the event loop's `Ready` callback, on the window's own UI thread, so
//! everything `setup` does is time the window cannot answer a single message — not a paint, not a
//! drag, and not the taskbar asking it for its icon. `init_state` used to run there, and it held
//! the thread for **26.5 s** on a fresh copy of the real 893 MB corpus and 2.9 s warm (debug
//! build, 2026-09-15, nearly all of it `PRAGMA quick_check`): long enough for Windows to mark the
//! window *Not responding* at 5.1 s, and long enough for Explorer's `WM_GETICON` to time out — so
//! the taskbar button was drawn with Windows' generic application icon, and Explorer never asked
//! again once the window recovered.
//!
//! So `setup` now shows the window and returns, and `desktop::start` builds [`crate::AppState`] on
//! a `startup` thread. **Until it lands, every command that takes `State<Arc<AppState>>` refuses**
//! — Tauri answers "state not managed" rather than waiting — which is why the page does not mount
//! the app at all until this module says [`StartupStatus::Ready`]. `src/boot/DesktopBoot.tsx` is
//! that gate, and it asks [`startup_status`] on a poll as well as listening for
//! [`CHANGED_EVENT`], because a listener registers asynchronously and an event fired before it
//! has is gone.
//!
//! **The state moves once, and only out of `Loading`.** [`Startup::settle`] refuses every other
//! transition, so a late failure cannot un-ready an app whose views are already mounted, and the
//! event fires at most once.
//!
//! Desktop and Android. The browser has no `setup` and no second thread to wait on; its
//! equivalent gate is `src/web/WebBoot.tsx`, which waits on the Worker opening the database.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Emitted once, with the [`StartupStatus`] the app settled on, when it leaves `Loading`.
pub const CHANGED_EVENT: &str = "startup:changed";

/// Where startup has got to. Tagged on `state`, so the page reads
/// `{ "state": "loading" }`, `{ "state": "ready" }` or `{ "state": "failed", "message": … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum StartupStatus {
    Loading,
    /// Every piece of managed state a command can reach is in place.
    Ready,
    /// `init_state` refused, with its own sentence — which names the folders it tried.
    ///
    /// **This used to be a panic.** A `setup` that returned `Err` took the process down with
    /// "Failed to setup app", and in a release build — `windows_subsystem = "windows"`, so no
    /// console — the sentence went nowhere and the reader saw a window vanish. The page draws it
    /// now, under a title bar that can still close the window.
    Failed {
        message: String,
    },
}

/// The managed half: one [`StartupStatus`] behind a lock.
#[derive(Debug)]
pub struct Startup(Mutex<StartupStatus>);

impl Default for Startup {
    fn default() -> Self {
        Self(Mutex::new(StartupStatus::Loading))
    }
}

impl Startup {
    pub fn status(&self) -> StartupStatus {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Move out of `Loading`, once. Answers whether this call was the one that moved it.
    ///
    /// Settling on `Loading` is refused too, since it is not a move — which keeps
    /// [`settle`]'s event to the one transition the page is waiting for.
    pub fn settle(&self, to: StartupStatus) -> bool {
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if *status != StartupStatus::Loading || to == StartupStatus::Loading {
            return false;
        }
        *status = to;
        true
    }
}

/// Settle the app's [`Startup`] and tell the page, if this was the call that settled it.
///
/// A missing [`Startup`] is a `setup` that never managed one, which is a bug in `desktop.rs` rather
/// than a state to report — so it is printed and nothing else happens.
pub fn settle(app: &tauri::AppHandle, to: StartupStatus) {
    let Some(startup) = app.try_state::<Startup>() else {
        eprintln!("startup settled before `setup` managed its state; the page will wait forever");
        return;
    };
    if startup.settle(to.clone()) {
        let _ = app.emit(CHANGED_EVENT, to);
    }
}

/// The page's question. `async` for [`crate::nav::nav_collapsed`]'s reason — a sync command runs
/// on the UI thread, which is the thread this whole module exists to keep free.
#[tauri::command(async)]
pub fn startup_status(startup: tauri::State<'_, Startup>) -> StartupStatus {
    startup.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page matches on these exact shapes, and `serde`'s internal tagging is the one place a
    /// unit variant and a struct variant can come out looking different from what was meant.
    #[test]
    fn each_status_serialises_to_the_shape_the_page_reads() {
        let json = |s: StartupStatus| serde_json::to_value(s).unwrap();
        assert_eq!(
            json(StartupStatus::Loading),
            serde_json::json!({ "state": "loading" })
        );
        assert_eq!(
            json(StartupStatus::Ready),
            serde_json::json!({ "state": "ready" })
        );
        assert_eq!(
            json(StartupStatus::Failed {
                message: "no folder\nat all".into()
            }),
            serde_json::json!({ "state": "failed", "message": "no folder\nat all" })
        );
    }

    /// Once the page has mounted the app on `Ready`, nothing may take that back — and a second
    /// settle must not fire a second event the page would have to ignore.
    #[test]
    fn the_status_settles_once_and_never_returns_to_loading() {
        let startup = Startup::default();
        assert_eq!(startup.status(), StartupStatus::Loading);
        assert!(
            !startup.settle(StartupStatus::Loading),
            "staying put is not a move"
        );

        assert!(startup.settle(StartupStatus::Ready));
        assert!(!startup.settle(StartupStatus::Failed {
            message: "late".into()
        }));
        assert!(!startup.settle(StartupStatus::Ready));
        assert_eq!(startup.status(), StartupStatus::Ready);
    }

    #[test]
    fn a_failure_is_as_final_as_ready() {
        let startup = Startup::default();
        let failed = StartupStatus::Failed {
            message: "the folder is read-only".into(),
        };
        assert!(startup.settle(failed.clone()));
        assert!(!startup.settle(StartupStatus::Ready));
        assert_eq!(startup.status(), failed);
    }
}
