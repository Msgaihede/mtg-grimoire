//! **The launch's downloads, held on a metered connection until the reader says** — the light
//! app's phase 4, step 4.4, and the light-app spec §4: *"Any feed over 5 MB shows its measured
//! size and, where the connection reports itself metered, defaults to Not now."*
//!
//! The desktop fetches its five launch downloads uninvited (`desktop::start`). This host does too
//! — unless Android says the active network is **metered** (`ConnectivityManager.
//! isActiveNetworkMetered`, over JNI) and the reader has not said "always" before. Then nothing
//! is fetched, the hold is kept here, and the page asks:
//!
//! - **`light_downloads`** → `{ held, metered, due }` — whether the launch is holding, whether the
//!   network said metered, and each due download over 5 MB with its measured size
//!   ([`grimoire_core::downloads`]);
//! - **`light_downloads_start`** `{ always }` → starts exactly what the launch would have, and with
//!   `always` stores that a metered link need not ask again.
//!
//! **A host without these commands draws no prompt**: the page reads a refusal as nothing to ask,
//! so the desktop binary under `mobile:tauri` and the Storybook fake are unaffected. *Not now* is
//! the page's alone — it sends nothing, and the next launch asks again.
//!
//! **The check fails open.** A JNI call that cannot be made (no context yet, a refused
//! permission) answers "not metered" and the launch downloads as it always has: a prompt the
//! reader never sees is the old behaviour, and a launch that never downloads on a phone that
//! could is the worse failure.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use grimoire_core::downloads::{launch_due, Due, LARGE_BYTES};
use grimoire_core::state::State;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The command names the page asks by.
pub const STATUS: &str = "light_downloads";
pub const START: &str = "light_downloads_start";

/// The `app_meta` row that says a metered link need not ask: `"always"`, or absent.
pub const K_ON_METERED: &str = "light_downloads_on_metered";

/// What this launch decided, kept for the page.
#[derive(Debug, Default)]
pub struct Hold {
    held: AtomicBool,
    metered: AtomicBool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    held: bool,
    metered: bool,
    due: Vec<Due>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartArgs {
    #[serde(default)]
    always: bool,
}

/// Whether `name` is one of the two commands this module answers.
pub fn answers(name: &str) -> bool {
    name == STATUS || name == START
}

/// Decide at launch: `true` to start the downloads now. Records the decision in `hold`.
pub fn decide(state: &State, hold: &Hold, metered: bool) -> bool {
    hold.metered.store(metered, Ordering::SeqCst);
    let always = {
        let conn = state.lock_db_read();
        grimoire_core::app_meta::get_app_meta(&conn, K_ON_METERED).as_deref() == Some("always")
    };
    let start = !metered || always;
    hold.held.store(!start, Ordering::SeqCst);
    start
}

/// Answer one of the two commands — [`answers`] said it is one.
pub async fn answer(
    state: Arc<State>,
    hold: &Hold,
    name: &str,
    args: Option<Value>,
) -> Result<Value, String> {
    if name == STATUS {
        let held = hold.held.load(Ordering::SeqCst);
        let due = if held {
            let s = Arc::clone(&state);
            tauri::async_runtime::spawn_blocking(move || large(launch_due(&s)))
                .await
                .map_err(|e| format!("{STATUS}: {e}"))?
        } else {
            Vec::new()
        };
        let status = Status {
            held,
            metered: hold.metered.load(Ordering::SeqCst),
            due,
        };
        return serde_json::to_value(status).map_err(|e| e.to_string());
    }
    let StartArgs { always } = match args {
        None | Some(Value::Null) => StartArgs::default(),
        Some(v) => serde_json::from_value(v)
            .map_err(|e| format!("{START}: its arguments did not parse: {e}"))?,
    };
    if always {
        let s = Arc::clone(&state);
        tauri::async_runtime::spawn_blocking(move || {
            grimoire_core::state::with_write(&s, |conn| {
                grimoire_core::app_meta::set_app_meta(conn, K_ON_METERED, "always")
                    .map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| format!("{START}: {e}"))??;
    }
    // Only a launch that is holding starts anything: a second press, or one on a launch that
    // never held, would start a second copy of every download.
    if hold.held.swap(false, Ordering::SeqCst) {
        crate::spawn_downloads(&state);
    }
    Ok(Value::Null)
}

/// The downloads worth asking about — over [`LARGE_BYTES`]. Smaller ones would not be asked
/// about, but every launch download measured so far is larger, so none is started behind the
/// prompt's back.
fn large(due: Vec<Due>) -> Vec<Due> {
    due.into_iter().filter(|d| d.bytes > LARGE_BYTES).collect()
}

/// Whether Android says the active network is metered. `false` off Android, and wherever the
/// question cannot be asked — see the module doc for why it fails open.
#[cfg(target_os = "android")]
pub fn metered() -> bool {
    use jni::objects::JObject;
    use tauri::tao::platform::android::prelude::main_android_context;

    let Some(ctx) = main_android_context() else {
        return false;
    };
    // SAFETY: tao keeps the `JavaVM` and the activity's global reference alive for the life of
    // the process; both pointers are what it handed the JNI glue at `onCreate`.
    let Ok(vm) = (unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }) else {
        return false;
    };
    let Ok(mut env) = vm.attach_current_thread() else {
        return false;
    };
    let activity = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
    let answer = (|| -> jni::errors::Result<bool> {
        let service = env.new_string("connectivity")?;
        let manager = env
            .call_method(
                &activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&service).into()],
            )?
            .l()?;
        if manager.is_null() {
            return Ok(false);
        }
        env.call_method(&manager, "isActiveNetworkMetered", "()Z", &[])?
            .z()
    })();
    if answer.is_err() {
        // A Java exception left pending poisons the next JNI call on this thread.
        let _ = env.exception_clear();
    }
    answer.unwrap_or(false)
}

/// Off Android there is no metered network to ask about.
#[cfg(not(target_os = "android"))]
pub fn metered() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(name: &str) -> Arc<State> {
        grimoire_core::state::fixtures::on_files(name, "http://127.0.0.1:9").0
    }

    #[test]
    fn an_unmetered_launch_downloads_at_once() {
        let s = state("light-dl-unmetered");
        let hold = Hold::default();
        assert!(decide(&s, &hold, false));
        assert!(!hold.held.load(Ordering::SeqCst));
    }

    #[test]
    fn a_metered_launch_holds_until_asked() {
        let s = state("light-dl-metered");
        let hold = Hold::default();
        assert!(!decide(&s, &hold, true));
        assert!(hold.held.load(Ordering::SeqCst));
        assert!(hold.metered.load(Ordering::SeqCst));
    }

    #[test]
    fn always_means_a_metered_launch_need_not_ask() {
        let s = state("light-dl-always");
        {
            let conn = s.db.lock().unwrap();
            grimoire_core::app_meta::set_app_meta(&conn, K_ON_METERED, "always").unwrap();
        }
        assert!(decide(&s, &Hold::default(), true));
    }

    #[test]
    fn only_large_downloads_are_listed() {
        let due = vec![
            Due {
                key: "a",
                label: "big",
                bytes: LARGE_BYTES + 1,
            },
            Due {
                key: "b",
                label: "small",
                bytes: LARGE_BYTES,
            },
        ];
        assert_eq!(large(due).iter().map(|d| d.key).collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn it_answers_its_two_commands_and_nothing_else() {
        assert!(answers("light_downloads"));
        assert!(answers("light_downloads_start"));
        assert!(!answers("sync_run"));
    }
}
