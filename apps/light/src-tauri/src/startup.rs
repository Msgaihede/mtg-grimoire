//! **Whether the light host has finished starting**, as the page asks it — the desktop's
//! `startup` module, answered through [`crate::core_call`] instead of a command of its own.
//!
//! The page's gate (`packages/ui/boot/useStartup.ts`) asks `startup_status` on a poll and listens for
//! [`CHANGED_EVENT`], and mounts nothing until the answer is `ready`. The shapes are the
//! desktop's exactly — `{ "state": "loading" }`, `{ "state": "ready" }`,
//! `{ "state": "failed", "message": … }` — because the gate is one file for both hosts.
//!
//! **The state moves once, and only out of `Loading`**, for the desktop's reason: a late failure
//! must not un-ready an app whose views are already mounted.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// The name the page asks by — the desktop's command name, so `ipc.ts` is unchanged.
pub const COMMAND: &str = "startup_status";

/// Emitted once, with the status the host settled on, when it leaves `Loading`.
pub const CHANGED_EVENT: &str = "startup:changed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum StartupStatus {
    Loading,
    Ready,
    /// The launch refused, with its own sentence — which names the folder it tried.
    Failed {
        message: String,
    },
}

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
    pub fn settle(&self, to: StartupStatus) -> bool {
        let mut status = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if *status != StartupStatus::Loading || to == StartupStatus::Loading {
            return false;
        }
        *status = to;
        true
    }
}

/// Settle the host's [`Startup`] and tell the page, if this was the call that settled it.
pub fn settle(app: &tauri::AppHandle, to: StartupStatus) {
    let Some(startup) = app.try_state::<Startup>() else {
        eprintln!("startup settled before `setup` managed its state; the page will wait forever");
        return;
    };
    if startup.settle(to.clone()) {
        let _ = app.emit(CHANGED_EVENT, to);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page's gate matches on these exact shapes, which are the desktop's.
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
                message: "no folder".into()
            }),
            serde_json::json!({ "state": "failed", "message": "no folder" })
        );
    }

    #[test]
    fn the_status_settles_once_and_never_returns_to_loading() {
        let startup = Startup::default();
        assert!(!startup.settle(StartupStatus::Loading));
        assert!(startup.settle(StartupStatus::Ready));
        assert!(!startup.settle(StartupStatus::Failed {
            message: "late".into()
        }));
        assert_eq!(startup.status(), StartupStatus::Ready);
    }
}
