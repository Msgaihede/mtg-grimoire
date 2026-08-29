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
/// **This is still not the whole surface.** The app has 152 commands; the first four here are
/// the browse, which is the read path spec 8 requires measured in wasm rather than guessed,
/// and the thirteen after them are the Decks destination's reads. The rest arrive with their
/// modules - see `lib.rs`'s module map for which are still desktop-only.
///
/// **Compiling for wasm and being routed are two different things, and the deck cluster is
/// the proof.** Those modules have compiled for the target since PR 10a; until a name
/// appeared here with a `match` arm the page still got `unknown command`. A module's
/// portability is a fact about its contents, this list is a fact about its reachability.
///
/// A test asserts every name here has a `match` arm, because a list and a table that drift
/// produce a silent `undefined` on the far side rather than a compile error.
pub const COMMANDS: &[&str] = &[
    "sync_status",
    "search_cards",
    "list_sets",
    "facet_cards",
    // Decks, read path. The write path is a separate PR: a read that answers the wrong rows
    // is visible on the page, and a write that lands wrong is not.
    "deck_list",
    "deck_get",
    "deck_folder_list",
    "deck_category_list",
    "deck_tag_list",
    "deck_tag_all",
    "format_specs_list",
    "deck_last_format",
    "deck_search_open",
    "deck_audit_list",
    "deck_theory_slots",
    "deck_theory_diff",
    "deck_undo_state",
];

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

/// Pull an argument that the caller is allowed not to send.
///
/// **A missing key and a `null` are the same answer here, and that is the difference from
/// [`field`].** `invoke("deck_get", { id, variant, marketplace })` omits `marketplace`
/// entirely when the page has no marketplace to name, and JavaScript sends `undefined` as an
/// absent key rather than as `null` — so a `field::<Option<String>>` would refuse the ordinary
/// call with "missing `marketplace`". A *malformed* value is still an error: this returns
/// `None` for absent, never for unreadable.
fn optional<T: serde::de::DeserializeOwned>(
    command: &str,
    args: &Value,
    name: &str,
) -> Result<Option<T>, RouteError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(raw) => serde_json::from_value(raw.clone())
            .map(Some)
            .map_err(|e| RouteError::Args {
                command: command.to_owned(),
                message: e.to_string(),
            }),
    }
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

        // ── Decks, read path ────────────────────────────────────────────────────────
        //
        // **Every arm below is its `#[tauri::command]` wrapper with the `spawn_blocking`
        // removed**, and the argument names are read off that wrapper rather than chosen
        // here — `invoke` matches a Rust command's parameters by name, so a key spelled
        // differently in this file is a `RouteError::Args` at run time that reads exactly
        // like a bug in the page. Nothing here concludes anything the desktop does not.
        "deck_list" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck::list_decks(&conn).map_err(RouteError::Failed)?,
            )
        }

        "deck_get" => {
            let id: i64 = field(command, args, "id")?;
            let variant: String = field(command, args, "variant")?;
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            // The wrapper converts before it calls, and so must this: `get_deck` takes a
            // `Marketplace`, not the `Option<String>` the page sends.
            let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck::get_deck(&conn, id, &variant, marketplace)
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_folder_list" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_meta::list_folders(&conn).map_err(RouteError::Failed)?,
            )
        }

        "deck_category_list" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let variant: String = field(command, args, "variant")?;
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_meta::list_categories(&conn, deck_id, &variant, marketplace)
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_tag_list" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let variant: String = field(command, args, "variant")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_meta::list_tags(&conn, deck_id, &variant)
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_tag_all" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_meta::list_all_tags(&conn).map_err(RouteError::Failed)?,
            )
        }

        "format_specs_list" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck::list_format_specs(&conn).map_err(RouteError::Failed)?,
            )
        }

        "deck_last_format" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::deck::last_deck_format(&conn))
        }

        "deck_search_open" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::deck::stored_deck_search_open(&conn))
        }

        "deck_audit_list" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let limit: i64 = field(command, args, "limit")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_audit::list(&conn, deck_id, limit).map_err(RouteError::Failed)?,
            )
        }

        "deck_theory_slots" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_theory::theory_slots(&conn, deck_id).map_err(RouteError::Failed)?,
            )
        }

        "deck_theory_diff" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_theory::theory_diff(&conn, deck_id, marketplace)
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_undo_state" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let redo_id: Option<i64> = optional(command, args, "redoId")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::deck_undo::undo_state(&conn, deck_id, redo_id)
                    .map_err(RouteError::Failed)?,
            )
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

    /// A deck, so the Decks arms have something to answer about.
    fn make_deck(s: &crate::sync::AppState, name: &str) -> i64 {
        let conn = crate::db::lock_blocking(&s.db);
        crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: name.to_owned(),
                format_key: "commander".to_owned(),
                ..Default::default()
            },
        )
        .expect("the fixture's deck must be creatable")
        .id
    }

    #[test]
    fn deck_list_answers_an_empty_list_before_a_deck_exists() {
        let s = state("web-route-deck-list-empty");
        let out = call(&s, "deck_list", &json!({})).unwrap();
        assert_eq!(
            out.as_array().expect("deck_list answers an array").len(),
            0,
            "a database with no decks is a supported state, not an error"
        );
    }

    #[test]
    fn deck_list_answers_a_deck_that_was_created() {
        let s = state("web-route-deck-list-one");
        make_deck(&s, "Web Deck");
        let out = call(&s, "deck_list", &json!({})).unwrap();
        assert_eq!(out.as_array().unwrap().len(), 1);
        assert_eq!(out[0]["name"], json!("Web Deck"));
        // camelCase, because `DeckRow` is `rename_all = "camelCase"` and `src/lib/ipc.ts`
        // reads these exact keys. A snake_case answer is a silent `undefined` on the page,
        // which is the failure this whole module exists in-tree to prevent.
        assert!(
            out[0].get("formatKey").is_some(),
            "the DTO's camelCase names must survive the route"
        );
    }

    /// **The arms take `deckId`, not `deck_id`, and this is what says so.** `invoke` matches a
    /// command's parameters by name, `src/lib/ipc.ts` sends
    /// `invoke("deck_category_list", { deckId, variant, marketplace })`, and a `match` arm that
    /// reached for the Rust spelling would compile, pass every type check, and answer
    /// `RouteError::Args` on every real call — which reads as a bug in the page.
    #[test]
    fn the_deck_arms_read_the_camel_case_keys_the_page_sends() {
        let s = state("web-route-deck-arg-names");
        let id = make_deck(&s, "Args");
        call(
            &s,
            "deck_category_list",
            &json!({ "deckId": id, "variant": "live" }),
        )
        .expect("`deckId` is the key the page sends");

        let err = call(
            &s,
            "deck_category_list",
            &json!({ "deck_id": id, "variant": "live" }),
        )
        .unwrap_err();
        assert!(
            matches!(&err, RouteError::Args { .. }),
            "the Rust spelling must not be accepted as well, or the pin means nothing: {err:?}"
        );
    }

    /// **An absent `marketplace` is the ordinary call, not a malformed one.** JavaScript sends
    /// an unset optional as a missing key rather than as `null`, so an arm built on [`field`]
    /// would refuse every default-marketplace read with "missing `marketplace`".
    #[test]
    fn an_omitted_optional_argument_is_not_an_error() {
        let s = state("web-route-optional-arg");
        let id = make_deck(&s, "Optional");

        call(&s, "deck_get", &json!({ "id": id, "variant": "live" }))
            .expect("no marketplace key at all");
        call(
            &s,
            "deck_get",
            &json!({ "id": id, "variant": "live", "marketplace": null }),
        )
        .expect("an explicit null means the same thing");

        // A value that is present and unreadable is still an error, which is the half of the
        // rule that a bare `unwrap_or_default` would have thrown away.
        let err = call(
            &s,
            "deck_get",
            &json!({ "id": id, "variant": "live", "marketplace": { "not": "a string" } }),
        )
        .unwrap_err();
        assert!(matches!(&err, RouteError::Args { .. }), "got {err:?}");
    }

    /// `deck_undo_state`'s logic lived inside its `#[tauri::command]` until it was lifted into
    /// [`crate::deck_undo::undo_state`] for this arm. A fresh deck can undo nothing, and both
    /// sides being `null` is the answer rather than an error.
    #[test]
    fn deck_undo_state_answers_both_sides_null_on_a_fresh_deck() {
        let s = state("web-route-undo-state");
        let id = make_deck(&s, "Undo");
        let out = call(&s, "deck_undo_state", &json!({ "deckId": id })).unwrap();
        assert_eq!(out["undo"], json!(null));
        assert_eq!(out["redo"], json!(null), "no redo id was sent");
    }

    /// **`mirror_rebuild`, and the choice of name is the point.** This used to reach for
    /// `deck_list`, which stopped being unknown the moment the Decks reads were routed — so
    /// the example is now one of the ten §6.3 names that are *permanently* desktop-only. A
    /// command merely waiting its turn would rot this test on the day it lands, quietly
    /// turning the assertion into a check that a routed command is unroutable.
    #[test]
    fn an_unknown_command_is_refused_by_name() {
        let s = state("web-route-unknown");
        let err = call(&s, "mirror_rebuild", &json!({})).unwrap_err();
        assert_eq!(err, RouteError::Unknown("mirror_rebuild".into()));
        // The message is what reaches a developer console, so it names the command.
        assert!(err.to_string().contains("mirror_rebuild"));
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
            17,
            "update this number when a command is added"
        );
    }
}
