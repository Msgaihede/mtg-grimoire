//! How an event leaves this crate.
//!
//! The engine tells its host things nobody asked for at that moment — how far a sync has got,
//! that a pull applied rows, that a reconcile moved a card — and what a host does with one is
//! the host's: the desktop and the Android shell forward it to their webview, the browser host
//! posts it to the page. So nothing here takes a window or an app handle. A host gives the
//! [`crate::state::State`] one [`EventSink`] when it builds it, and code that has something to
//! say calls [`emit`].
//!
//! **An event is best effort, always.** A host with nobody listening drops it, a payload that
//! will not serialise is dropped, and neither is ever a reason to fail the work the event
//! describes. Anything a reader must not miss is also stored where they can ask for it — a
//! failed sync is in `sync_meta`, a failed pass in `error_log`.
//!
//! **The card sync is the first to speak through it** — `sync:progress` and
//! `collection:reconciled`, since the extraction's I/O step. The three feeds and live sync are
//! still in `src-tauri` and still call their window directly; each moves onto the sink as it
//! arrives. The sink was put on the state a step early so that they come to a place they can
//! already speak through, rather than to a constructor that has to change under every host.
//!
//! **A typed payload reaches the sink as a `serde_json::Value`, so its keys arrive in
//! alphabetical order** where a struct handed straight to a window kept its field order. A page
//! reads a payload by key, so nothing sees it; a test that compares the serialised *text* of an
//! event would.

use std::sync::Arc;

/// Where a host takes the engine's events.
///
/// `name` is the event's name on the wire — `sync:progress`, `sync:applied` — and is a contract
/// with the page that no type system holds. `payload` is the JSON the page reads.
///
/// `Send + Sync`: an event is raised from whatever thread the work is on.
pub trait EventSink: Send + Sync {
    fn emit(&self, name: &str, payload: serde_json::Value);
}

/// Emit `payload` as `name`.
///
/// What a caller with a typed payload reaches for: the sink takes JSON because a trait object
/// cannot take a generic, and this is the one place the two meet. A payload that will not
/// serialise is dropped — see the module doc.
pub fn emit<T: serde::Serialize>(sink: &dyn EventSink, name: &str, payload: &T) {
    if let Ok(payload) = serde_json::to_value(payload) {
        sink.emit(name, payload);
    }
}

/// A sink that drops everything.
struct Silent;

impl EventSink for Silent {
    fn emit(&self, _name: &str, _payload: serde_json::Value) {}
}

/// A sink for a host with nobody listening — and for a test, which has no page.
pub fn silent() -> Arc<dyn EventSink> {
    Arc::new(Silent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recording(Mutex<Vec<(String, serde_json::Value)>>);

    impl EventSink for Recording {
        fn emit(&self, name: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((name.to_owned(), payload));
        }
    }

    /// The shape every payload in this app has: a struct the page reads in camelCase.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Progress {
        phase: &'static str,
        done_so_far: u64,
        message: Option<String>,
    }

    /// The page reads keys, so what a typed payload becomes on the way through is the contract:
    /// its `serde` names, an absent value as `null`.
    #[test]
    fn a_typed_payload_reaches_the_sink_as_the_json_the_page_reads() {
        let sink = Recording::default();
        emit(
            &sink,
            "sync:progress",
            &Progress {
                phase: "ingesting",
                done_so_far: 2_000,
                message: None,
            },
        );
        assert_eq!(
            *sink.0.lock().unwrap(),
            [(
                "sync:progress".to_owned(),
                serde_json::json!({ "phase": "ingesting", "doneSoFar": 2000, "message": null }),
            )]
        );
    }

    /// A map keyed by something that is not a string has no JSON form. The event goes nowhere,
    /// and nothing else happens.
    #[test]
    fn a_payload_that_will_not_serialise_is_dropped() {
        let sink = Recording::default();
        let unkeyable = std::collections::BTreeMap::from([((1, 2), "a pair is not a key")]);
        emit(&sink, "nothing", &unkeyable);
        assert!(sink.0.lock().unwrap().is_empty());
    }
}

/// A sink for a test that asks what was said.
///
/// **At the foot of the file, and behind `testing`**, as every fixture here is.
#[cfg(any(test, feature = "testing"))]
pub mod fixtures {
    use super::EventSink;
    use std::sync::Mutex;

    /// Every event it was given, in order.
    #[derive(Default)]
    pub struct Recording(Mutex<Vec<(String, serde_json::Value)>>);

    impl Recording {
        /// What has arrived since the last call. Taking it empties it.
        pub fn taken(&self) -> Vec<(String, serde_json::Value)> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    impl EventSink for Recording {
        fn emit(&self, name: &str, payload: serde_json::Value) {
            self.0.lock().unwrap().push((name.to_owned(), payload));
        }
    }
}
