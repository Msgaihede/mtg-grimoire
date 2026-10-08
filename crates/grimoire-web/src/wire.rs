//! **What crosses between the Worker's script and this module, as JSON text.**
//!
//! Every export answers a string, and the Worker does one `JSON.parse` and switches on a key.
//! Not a `JsValue` and not a rejected promise: the TypeScript side has to know these shapes
//! anyway, and a second, structural representation of the same thing is a second place for it
//! to drift. **The strings here are the contract with `packages/ui/lib/core/web/`** — the Worker,
//! whose `protocol.ts` is the hand-written mirror of this file — held by this file's
//! tests on every target — a module gated to the browser would be invisible to `cargo test`,
//! and a typo in one of these is a silent `undefined` in a page.
//!
//! Two shapes: [`Opened`], what `open` answers once; and the answer to a `call`, which is
//! `{"ok": <value>}` or `{"err": "<sentence>"}` ([`answer`]).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What opening the databases answered.
///
/// Its own type rather than a call's answer because it happens once, before any command, and
/// its [`Opened::AlreadyOpen`] arm is not a call's error: it says who holds the pool, and the
/// page decides what that means. **Since the light app's step 5.5 a page retries it**, with a
/// fresh Worker each time, when the database's Web Lock is its own — the holder is then a
/// Worker of a document that has gone, not a second tab, which the lock tells before any
/// Worker starts — and draws a sentence and a Reload only once its retries are spent
/// (`packages/ui/lib/core/web/holder.ts`). This Worker never retries: it opens once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Opened {
    /// `{"kind":"ready","journal":"delete","corpusJournal":"delete","schemaVersion":59}`.
    ///
    /// **Two journals, because the data is two files**, and each is what SQLite *answered*
    /// rather than what was asked for: `delete` on the OPFS pool, never `wal`
    /// (`grimoire_core::db::Journal`). Apart rather than folded into one field because a
    /// journal is a property of a file, and one value would hide the day they stop agreeing.
    ///
    /// `schema_version` is `PRAGMA user_version` on `main` — the reader's own file, and the
    /// version that gates compatibility: `schema::migrate_user` refuses a file from the future
    /// by reading exactly this. The corpus carries its own, incomparable number and a page is
    /// never shown it, because a corpus behind head is a rebuild rather than a refusal.
    #[serde(rename_all = "camelCase")]
    Ready {
        journal: String,
        corpus_journal: String,
        schema_version: i64,
    },
    /// `{"kind":"already-open"}` — another Worker of this origin holds the pool's access
    /// handles: a second tab's, or one whose document has gone and which has not ended yet.
    /// First tab wins; which of the two it is, is the page's to tell.
    AlreadyOpen,
    /// `{"kind":"failed","message":"…"}` — everything else, in a sentence a page can show.
    Failed { message: String },
}

impl Opened {
    /// Classify a failure to install the OPFS pool, from its text.
    ///
    /// **A string match, because that is all a browser gives.** `sqlite-wasm-vfs` hands back a
    /// `JsValue` inside its own error, and the distinction that matters — *another tab has it*
    /// against *something is broken* — lives in the `DOMException`'s **name**:
    ///
    /// ```text
    /// CreateSyncAccessHandle(JsValue(NoModificationAllowedError: Failed to execute
    /// 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created
    /// if there is another open Access Handle or Writable stream associated with the same
    /// file.))
    /// ```
    ///
    /// That is what Edge 151 sent on 2026-08-28, to the first web host, with a second document
    /// open against a held pool — at the *install*, before any database was named. Matched on
    /// the name and not the sentence, and anywhere in the text: the wording has changed between
    /// Chrome versions, the name is the part the specification fixes, and the crate wraps a
    /// variant of its own around the whole thing. Everything else is a real failure and says
    /// so, rather than telling a reader to close a tab that is not open.
    pub fn from_install_error(text: &str) -> Opened {
        if text.contains(HELD_ELSEWHERE) {
            Opened::AlreadyOpen
        } else {
            Opened::Failed {
                message: format!("MTG Grimoire could not open its storage in this browser: {text}"),
            }
        }
    }

    /// The JSON text the Worker parses.
    pub fn to_json(&self) -> String {
        text(self)
    }
}

/// The `DOMException` name a browser raises for an access handle another document holds.
const HELD_ELSEWHERE: &str = "NoModificationAllowedError";

/// A call's answer, as the JSON text the Worker parses: `{"ok": <value>}` for an answer and
/// `{"err": "<sentence>"}` for a refusal.
///
/// **One key, never both, and the key is the switch** — an answer of `null` is `{"ok":null}`,
/// which is why the Worker asks `"err" in answer` and never `answer.ok`.
pub fn answer(result: Result<Value, String>) -> String {
    match result {
        Ok(value) => text(&Call::Ok(value)),
        Err(sentence) => text(&Call::Err(sentence)),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Call {
    Ok(Value),
    Err(String),
}

/// Serialize, and still answer something parseable if a value will not — a caller waiting on a
/// string that never came is the one outcome this module may not have.
fn text<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|e| {
        serde_json::json!({ "err": format!("an answer would not encode: {e}") }).to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).expect("the Worker must be able to parse it")
    }

    /// The three things `open` can say, exactly as `packages/ui/lib/core/web/protocol.ts` reads them.
    #[test]
    fn opened_is_the_three_shapes_the_worker_switches_on() {
        assert_eq!(
            parsed(
                &Opened::Ready {
                    journal: "delete".into(),
                    corpus_journal: "delete".into(),
                    schema_version: 59,
                }
                .to_json()
            ),
            json!({
                "kind": "ready",
                "journal": "delete",
                "corpusJournal": "delete",
                "schemaVersion": 59
            })
        );
        assert_eq!(Opened::AlreadyOpen.to_json(), r#"{"kind":"already-open"}"#);
        assert_eq!(
            parsed(
                &Opened::Failed {
                    message: "no room".into()
                }
                .to_json()
            ),
            json!({ "kind": "failed", "message": "no room" })
        );
    }

    /// The one-tab guard's whole brain, and the reason it is ordinary Rust: it is a string
    /// match on a browser's error, and `cargo test` can only reach it here.
    ///
    /// **The needle is the message a browser actually sent** — note the
    /// `CreateSyncAccessHandle(JsValue(…))` wrapper, which a matcher anchored at the start of
    /// the text, or one expecting a bare `JsValue(`, would miss.
    #[test]
    fn a_held_access_handle_is_already_open_and_nothing_else_is() {
        let real = "CreateSyncAccessHandle(JsValue(NoModificationAllowedError: Failed to \
                    execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles \
                    cannot be created if there is another open Access Handle or Writable \
                    stream associated with the same file.))";
        assert_eq!(Opened::from_install_error(real), Opened::AlreadyOpen);

        // Everything else is a real failure, in a sentence, with the browser's own words kept.
        let full = Opened::from_install_error("GetDirHandle(JsValue(SecurityError: denied))");
        let Opened::Failed { message } = full else {
            panic!("a refusal that is not a held handle is a failure");
        };
        assert!(message.starts_with("MTG Grimoire could not open its storage"));
        assert!(message.contains("SecurityError: denied"), "{message}");
    }

    /// One key, and the key is the switch — including for an answer that is `null`.
    #[test]
    fn a_calls_answer_is_ok_or_err_and_never_both() {
        assert_eq!(answer(Ok(json!({ "total": 2 }))), r#"{"ok":{"total":2}}"#);
        assert_eq!(answer(Ok(Value::Null)), r#"{"ok":null}"#);
        assert_eq!(
            answer(Err("There is no command named x on this host.".into())),
            r#"{"err":"There is no command named x on this host."}"#
        );
        // A sentence with a quote and a newline in it is still one JSON string.
        let awkward = answer(Err("it said \"no\"\nand meant it".into()));
        assert_eq!(parsed(&awkward)["err"], "it said \"no\"\nand meant it");
    }

    #[test]
    fn opened_reads_back_as_it_was_written() {
        for opened in [
            Opened::Ready {
                journal: "wal".into(),
                corpus_journal: "delete".into(),
                schema_version: 1,
            },
            Opened::AlreadyOpen,
            Opened::Failed {
                message: "x".into(),
            },
        ] {
            let back: Opened = serde_json::from_str(&opened.to_json()).unwrap();
            assert_eq!(back, opened);
        }
    }
}
