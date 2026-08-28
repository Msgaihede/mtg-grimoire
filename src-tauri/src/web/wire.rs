//! What crosses the boundary between the page and the Worker, as JSON.
//!
//! Deliberately not Tauri's envelope. Tauri wraps an event payload in `{ event, id,
//! payload }` and `src/lib/core/tauri.ts` unwraps it; the browser has no reason to invent
//! that shape only to take it apart again, so an event here *is* its payload plus its name.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One command call, page -> Worker.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Request {
    /// Matched against [`Response::Ok`]'s `id`. **Ids and not order**: the Worker answers a
    /// long search after a short one that was sent later, and a queue that resolved by
    /// arrival would hand the wrong rows to the wrong caller.
    pub id: u32,
    pub command: String,
    /// Named arguments, matched against the routed function's parameters **by name**.
    /// Defaulted because a no-argument command is sent without the key at all - mirroring
    /// `core/tauri.ts`, which calls `invoke("list_sets")` with one argument rather than two.
    ///
    /// **A named default and not a bare `#[serde(default)]`**, which would give
    /// `Value::default()` - that is `Value::Null`, not an empty object, and `Null.get("req")`
    /// is `None` for every key rather than for a key that is genuinely absent. The two behave
    /// the same in `route::field` today and would stop doing so the moment anything asked
    /// whether the payload *was* an object.
    #[serde(default = "empty_args")]
    pub args: Value,
}

/// An empty JSON object - what an absent `args` key means.
fn empty_args() -> Value {
    Value::Object(serde_json::Map::new())
}

impl Default for Request {
    fn default() -> Self {
        Request {
            id: 0,
            command: String::new(),
            args: empty_args(),
        }
    }
}

/// Anything the Worker says, Worker -> page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Response {
    /// A command answered. `result` is the command's own DTO, already camelCased by its
    /// own `#[serde(rename_all)]` - the frontend's hand-written mirrors read those names.
    Ok { id: u32, result: Value },
    /// A command refused. `message` is what a page shows a reader.
    Err { id: u32, message: String },
    /// A progress notification. **No id**: nothing is waiting on it, and `Core::listen` is
    /// a subscription rather than a call.
    Event { event: String, payload: Value },
}

/// What opening the database answered.
///
/// Its own type rather than a [`Response`] because it happens once, before any command, and
/// its `AlreadyOpen` arm is not an error the app retries - it is a different page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Opened {
    /// **Two journals, because the data folder is two files.** Both are what SQLite actually
    /// chose - `delete` on the OPFS pool, never `wal`, measured on each half separately.
    /// They are reported apart rather than folded into one field because a journal is a
    /// property of a *file*: the corpus is the half that writes the 857 MB journal during an
    /// ingest, and a single value would hide the day they stop agreeing.
    ///
    /// `schema_version` is `PRAGMA user_version` unqualified, which means `main` - the user
    /// file, and deliberately so: that is the version that gates compatibility, and
    /// `schema::migrate_user` refuses a file from the future by reading exactly this. The
    /// corpus carries its own, incomparable number and a reader is never shown it, because a
    /// corpus behind head is a rebuild rather than a refusal.
    #[serde(rename_all = "camelCase")]
    Ready {
        journal: String,
        corpus_journal: String,
        schema_version: i64,
    },
    /// Another document of this origin holds the pool's access handles.
    AlreadyOpen,
    Failed {
        message: String,
    },
}

impl Opened {
    /// Classify a VFS or connection failure.
    ///
    /// **A string match, because that is all the browser gives.** `sqlite-wasm-vfs` hands
    /// back a `JsValue`, and the distinction that matters - "another tab has it" versus
    /// "something is broken" - lives in the DOMException's *name*:
    ///
    /// ```text
    /// CreateSyncAccessHandle(JsValue(NoModificationAllowedError: Failed to execute
    /// 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created
    /// if there is another open Access Handle or Writable stream associated with the same
    /// file.))
    /// ```
    ///
    /// That is the message Edge 151 sent on 2026-08-28 with a second document open against a
    /// held pool. Matching on the name and not the sentence is deliberate twice over:
    /// Chrome's wording has changed before, the error name is the part the spec fixes, and
    /// the crate wraps its own variant around the whole thing - so anchoring anywhere would
    /// miss it. Everything else is a real failure and must say so, rather than telling a
    /// reader to close a tab that is not open.
    pub fn from_open_error(text: &str) -> Opened {
        if text.contains("NoModificationAllowedError") {
            Opened::AlreadyOpen
        } else {
            Opened::Failed {
                message: text.to_owned(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_round_trips() {
        let text = r#"{"id":7,"command":"search_cards","args":{"req":{"text":"bolt"}}}"#;
        let req: Request = serde_json::from_str(text).unwrap();
        assert_eq!(req.id, 7);
        assert_eq!(req.command, "search_cards");
        assert_eq!(req.args, json!({ "req": { "text": "bolt" } }));
    }

    /// A command with no arguments is sent without an `args` key at all — the Tauri core
    /// calls `invoke("list_sets")` with one argument rather than two, and the browser core
    /// mirrors that. An absent key must be an empty object, not a deserialize failure.
    #[test]
    fn an_absent_args_key_is_an_empty_object() {
        let req: Request = serde_json::from_str(r#"{"id":1,"command":"list_sets"}"#).unwrap();
        assert_eq!(req.args, json!({}));
    }

    /// The three responses are told apart by `kind`, which is what the TypeScript side
    /// switches on. A rename here without one there is a message nobody handles.
    #[test]
    fn responses_are_tagged_by_kind() {
        let ok = serde_json::to_value(Response::Ok {
            id: 3,
            result: json!({ "total": 2 }),
        })
        .unwrap();
        assert_eq!(
            ok,
            json!({ "kind": "ok", "id": 3, "result": { "total": 2 } })
        );

        let err = serde_json::to_value(Response::Err {
            id: 3,
            message: "nope".into(),
        })
        .unwrap();
        assert_eq!(err, json!({ "kind": "err", "id": 3, "message": "nope" }));

        // An event carries no id: nothing is waiting on it.
        let ev = serde_json::to_value(Response::Event {
            event: "sync-progress".into(),
            payload: json!({ "done": 2000 }),
        })
        .unwrap();
        assert_eq!(
            ev,
            json!({ "kind": "event", "event": "sync-progress", "payload": { "done": 2000 } })
        );
    }

    /// The one-tab guard's whole brain, and the reason it lives here rather than in the
    /// wasm glue: it is a string match on a browser error, and `cargo test` can only reach
    /// it if it is ordinary Rust.
    ///
    /// **The needle is the message Edge 151 actually sent**, captured on 2026-08-28 by
    /// opening a second document against a pool the first still held. Note the
    /// `CreateSyncAccessHandle(JsValue(…))` wrapper: `sqlite-wasm-vfs` names its own error
    /// variant around the DOMException, so a matcher anchored at the start of the string, or
    /// one expecting a bare `JsValue(`, would miss it.
    #[test]
    fn a_held_access_handle_is_already_open_and_nothing_else_is() {
        let real = "CreateSyncAccessHandle(JsValue(NoModificationAllowedError: Failed to \
                    execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles \
                    cannot be created if there is another open Access Handle or Writable \
                    stream associated with the same file.))";
        assert_eq!(Opened::from_open_error(real), Opened::AlreadyOpen);

        // Everything else is a real failure and must say so rather than telling the reader
        // to close a tab they do not have open.
        assert_eq!(
            Opened::from_open_error("QuotaExceededError: out of space"),
            Opened::Failed {
                message: "QuotaExceededError: out of space".into()
            }
        );
    }

    #[test]
    fn opened_is_tagged_by_kind_too() {
        assert_eq!(
            serde_json::to_value(Opened::AlreadyOpen).unwrap(),
            json!({ "kind": "already-open" })
        );
        assert_eq!(
            serde_json::to_value(Opened::Ready {
                journal: "delete".into(),
                corpus_journal: "delete".into(),
                schema_version: 27,
            })
            .unwrap(),
            json!({
                "kind": "ready",
                "journal": "delete",
                "corpusJournal": "delete",
                "schemaVersion": 27
            })
        );
    }
}
