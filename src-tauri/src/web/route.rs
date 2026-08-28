//! Command name plus JSON in, JSON out - the browser's answer to `#[tauri::command]`.
//!
//! **The commands here call the same functions the Tauri wrappers call.** `search_cards` in
//! `desktop.rs` is `spawn_blocking(move || run_search(&lock_db_read(&state), &req))`; this
//! is `run_search(&lock_db_read(state), &req)` with the `spawn_blocking` gone, because the
//! Worker *is* the blocking thread. Nothing here decides anything a command did not already
//! decide - Rust supplies facts, TypeScript draws conclusions, on every platform.
//!
//! **Compiled on every target on purpose**, along with [`super::wire`]. A dispatch table is
//! precisely where a typo produces a silent `undefined` rather than a compile error, and a
//! module gated to `wasm32-unknown-unknown` is invisible to `cargo test`.

use crate::sync::AppState;
use serde_json::Value;

/// Every command this build routes, in the order they were added.
///
/// **This is a first slice and not the whole surface.** The app has 152 commands; the four
/// here are the browse, which is the read path spec 8 requires measured in wasm rather than
/// guessed. The rest arrive with their modules - see `lib.rs`'s module map for which are
/// still desktop-only.
///
/// A test asserts every name here has a `match` arm, because a list and a table that drift
/// produce a silent `undefined` on the far side rather than a compile error.
pub const COMMANDS: &[&str] = &["sync_status", "search_cards", "list_sets", "facet_cards"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RouteError {
    /// Not in [`COMMANDS`]. Names the command, because the reader of this message is
    /// looking at a console and needs to know which call went nowhere.
    #[error("unknown command `{0}`")]
    Unknown(String),
    #[error("`{command}` could not read its arguments: {message}")]
    Args { command: String, message: String },
    /// The command ran and refused. Its own words, unchanged.
    #[error("{0}")]
    Failed(String),
}

/// Pull one named argument out of the payload and deserialize it.
///
/// Named and not positional, exactly as `invoke` matches a Rust command's parameters - so a
/// misspelled key is a runtime error here in the same way it is one there, and
/// `src/lib/ipc.test.ts`'s argument-name pins stay the contract for both.
fn field<T: serde::de::DeserializeOwned>(
    command: &str,
    args: &Value,
    name: &str,
) -> Result<T, RouteError> {
    let raw = args.get(name).ok_or_else(|| RouteError::Args {
        command: command.to_owned(),
        message: format!("missing `{name}`"),
    })?;
    serde_json::from_value(raw.clone()).map_err(|e| RouteError::Args {
        command: command.to_owned(),
        message: e.to_string(),
    })
}

/// Serialize a command's answer. A DTO that will not encode is a bug in this crate, not in
/// the caller, so it is [`RouteError::Failed`] with the command named.
fn encode<T: serde::Serialize>(command: &str, value: T) -> Result<Value, RouteError> {
    serde_json::to_value(value).map_err(|e| {
        RouteError::Failed(format!(
            "`{command}` produced an answer that would not encode: {e}"
        ))
    })
}

/// Route one call.
///
/// Synchronous, and that is the whole shape of the web target: the Worker is a thread with
/// nothing else to do, so there is no `spawn_blocking` to be had and none needed. The page
/// stays responsive because the work is in the Worker, not because the work is deferred.
///
/// **[`crate::sync::lock_db_read`] is `pub(crate)`** and this module is inside the crate, so
/// it resolves. On wasm it hands back the write connection, so a search there does queue
/// behind an ingest - the single-Worker trade, written down rather than left to be found.
pub fn call(state: &AppState, command: &str, args: &Value) -> Result<Value, RouteError> {
    match command {
        "sync_status" => encode(command, crate::sync::status(state)),

        "search_cards" => {
            let req: crate::search::SearchRequest = field(command, args, "req")?;
            let conn = crate::sync::lock_db_read(state);
            let out = crate::search::run_search(&conn, &req).map_err(RouteError::Failed)?;
            encode(command, out)
        }

        "list_sets" => {
            let conn = crate::sync::lock_db_read(state);
            let out = crate::search::run_list_sets(&conn).map_err(RouteError::Failed)?;
            encode(command, out)
        }

        "facet_cards" => {
            let req: crate::search::SearchRequest = field(command, args, "req")?;
            let out = crate::index::facets::run_facets(state, &req).map_err(RouteError::Failed)?;
            encode(command, out)
        }

        other => Err(RouteError::Unknown(other.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Four seeded printings in a file database inside a real `AppState`, **plus the two
    /// things this module's commands need that the shared fixture does not provide.**
    ///
    /// `state_with_seeded_cards` writes rows straight into `cards`, which is right for the
    /// index — it reads that table directly — and is not enough here:
    ///
    ///   * `run_list_sets` reads the `sets` table, which nothing in the fixture fills, so it
    ///     would answer an empty list however many cards there were. The three rows below are
    ///     the three set codes the fixture's four printings actually use.
    ///   * `cards_fts` is external-content **with no triggers**, so rows inserted into `cards`
    ///     outside the ingest are invisible to a text search until the index is rebuilt.
    ///     Without this a search for `bolt` answers zero and reads as a broken route.
    ///
    /// **`name` is a parameter and every caller passes a different one.** The fixture builds
    /// a temp directory out of it and its own doc requires the name be unique *crate-wide*;
    /// seven tests in this module sharing one would delete each other's database mid-run,
    /// which is what they did — seven simultaneous panics inside the fixture, none of them
    /// about routing.
    fn state(name: &str) -> std::sync::Arc<crate::sync::AppState> {
        let state = crate::index::fixtures::state_with_seeded_cards(name);
        {
            let conn = crate::db::lock_blocking(&state.db);
            for (code, name) in [
                ("lea", "Limited Edition Alpha"),
                ("rav", "Ravnica"),
                ("alc", "Alchemy"),
            ] {
                conn.execute(
                    "INSERT INTO sets (code, name, set_type, released_at)
                     VALUES (?1, ?2, 'core', '1993-08-05')",
                    rusqlite::params![code, name],
                )
                .unwrap();
            }
            conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
                .unwrap();
        }
        state
    }

    #[test]
    fn sync_status_answers_the_card_count() {
        let s = state("web-route-status");
        let out = call(&s, "sync_status", &json!({})).unwrap();
        assert_eq!(out["cardCount"], json!(4));
        // camelCase, because `SyncStatus` is `rename_all = "camelCase"` and the frontend's
        // hand-written mirror in `src/lib/ipc.ts` reads these exact keys.
        assert!(
            out.get("dataDir").is_some(),
            "the DTO's camelCase names must survive"
        );
    }

    #[test]
    fn search_cards_takes_its_request_under_the_key_the_command_uses() {
        let s = state("web-route-search");
        let out = call(&s, "search_cards", &json!({ "req": { "text": "bolt" } })).unwrap();
        // `items`, not `rows`: `SearchResponse`'s page field. Its two companions are `total`
        // and `totalIsCapped`, and reading the wrong name here would have been a `None` that
        // looked exactly like a search returning nothing.
        assert_eq!(out["items"].as_array().unwrap().len(), 1);
        assert_eq!(out["items"][0]["name"], json!("Lightning Bolt"));
        assert_eq!(out["total"], json!(1));
    }

    #[test]
    fn list_sets_needs_no_arguments() {
        let s = state("web-route-sets");
        let out = call(&s, "list_sets", &json!({})).unwrap();
        // lea, rav, alc — the fixture's three set codes.
        assert_eq!(out.as_array().unwrap().len(), 3);
    }

    #[test]
    fn facet_cards_answers_ready_false_before_an_index_is_built() {
        let s = state("web-route-facets");
        let out = call(&s, "facet_cards", &json!({ "req": {} })).unwrap();
        assert_eq!(
            out["ready"],
            json!(false),
            "a cold index is a supported state"
        );

        crate::index::lifecycle::build_now(&s).unwrap();
        let warm = call(&s, "facet_cards", &json!({ "req": {} })).unwrap();
        assert_eq!(warm["ready"], json!(true));
    }

    #[test]
    fn an_unknown_command_is_refused_by_name() {
        let s = state("web-route-unknown");
        let err = call(&s, "deck_list", &json!({})).unwrap_err();
        assert_eq!(err, RouteError::Unknown("deck_list".into()));
        // The message is what reaches a developer console, so it names the command.
        assert!(err.to_string().contains("deck_list"));
    }

    #[test]
    fn a_malformed_argument_is_an_args_error_and_not_a_panic() {
        let s = state("web-route-args");
        // `req` must be an object; a string is the shape a hand-written caller gets wrong.
        let err = call(&s, "search_cards", &json!({ "req": "bolt" })).unwrap_err();
        assert!(matches!(err, RouteError::Args { .. }), "got {err:?}");
    }

    /// **The list and the table must not drift.** `COMMANDS` is what the frontend and the
    /// docs read; the `match` is what actually answers. A name in one and not the other is
    /// exactly the silent `undefined` this whole module exists in-tree to prevent.
    #[test]
    fn every_advertised_command_is_actually_routed() {
        let s = state("web-route-advertised");
        for name in COMMANDS {
            let answer = call(&s, name, &json!({}));
            assert!(
                !matches!(&answer, Err(RouteError::Unknown(_))),
                "`{name}` is advertised in COMMANDS and has no match arm"
            );
        }
        assert_eq!(
            COMMANDS.len(),
            4,
            "update this number when a command is added"
        );
    }
}
