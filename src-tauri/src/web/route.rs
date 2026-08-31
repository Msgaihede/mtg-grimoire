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
/// **This is still not the whole surface.** The app has 154 commands. The first four here are
/// the browse, which is the read path spec 8 requires measured in wasm rather than guessed;
/// the thirteen after them are the Decks destination's reads and the thirty-three after those
/// are its writes - the whole deck cluster except `deck_set_cover_image`. The rest arrive with
/// their modules - see `lib.rs`'s module map for which are still desktop-only.
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
    // Decks, write path. **`deck_set_cover_image` is not here and never will be**: it writes a
    // file into a covers directory, so `deck::set_cover_image` does not compile for wasm at
    // all. It is the eleventh name on §6.3's desktop-only list.
    "deck_create",
    "deck_update",
    "deck_delete",
    "deck_duplicate",
    "deck_set_folder",
    "deck_set_view_state",
    "set_deck_search_open",
    "deck_missing_to_wishlist",
    "deck_add_card",
    "deck_set_card_quantity",
    "deck_category_clear",
    "deck_move_card",
    "deck_swap_printing",
    "deck_set_card_finish",
    "deck_category_create",
    "deck_category_rename",
    "deck_category_set_active",
    "deck_category_reorder",
    "deck_category_delete",
    "deck_tag_create",
    "deck_tag_update",
    "deck_tag_delete",
    "deck_tag_remove_from_deck",
    "deck_card_set_tag",
    "deck_folder_create",
    "deck_folder_rename",
    "deck_folder_move",
    "deck_folder_reorder",
    "deck_folder_delete",
    "deck_theory_copy_from_live",
    "deck_theory_missing_to_wishlist",
    "deck_undo_apply",
    "deck_redo_apply",
    // The Collection destination, and the pair that moves a row across the deck boundary.
    "collection_list",
    "collection_summary",
    "collection_add",
    "collection_set_quantity",
    "collection_update",
    "collection_remove",
    "collection_import_commit",
    "collection_folder_list",
    "collection_folder_summary",
    "collection_folder_create",
    "collection_folder_rename",
    "collection_folder_move",
    "collection_folder_reorder",
    "collection_folder_delete",
    "collection_set_folder",
    "collection_to_deck",
    "deck_to_collection",
    // The Wishlist destination.
    "wishlist_list",
    "wishlist_add",
    "wishlist_set_quantity",
    "wishlist_remove",
    "wishlist_set_printing",
    "wishlist_import_commit",
    "wishlist_folder_list",
    "wishlist_folder_summary",
    "wishlist_folder_create",
    "wishlist_folder_rename",
    "wishlist_folder_move",
    "wishlist_folder_reorder",
    "wishlist_folder_delete",
    "wishlist_set_folder",
    // The card pane. `card_detail` is the command the reader reported on 2026-08-29.
    "card_detail",
    "card_printings",
    "card_meld_parts",
    "card_image_uri",
    "printing_group_by",
    "set_printing_group_by",
    // The Tagger, minus the two that download. See the arms for why.
    "oracle_tags_status",
    "art_tags_status",
    "oracle_tags_for_cards",
    "oracle_tags_for_printings",
    "tag_search",
    "tag_children",
    "tag_resolve",
    "tags_muted",
    "tag_mute",
    "tag_unmute",
    // Settings, and the view state the pages keep in `app_meta`.
    "nav_collapsed",
    "set_nav_collapsed",
    "card_zoom",
    "set_card_zoom",
    "list_view",
    "set_list_view",
    "flatten_state",
    "set_flatten_state",
    "error_log_list",
    "error_log_clear",
    "get_marketplace",
    "set_marketplace",
    // Commander Spellbook. `combos_refresh` downloads and is not here.
    "combos_status",
    "combos_for_cards",
    // The last two gaps, closed. See the arms.
    "marketplace_feed_status",
    "import_resolve",
    "deck_import_commit",
    // **Three of Settings' four clears.** `cache_clear` is the fourth and is not here: it
    // sweeps a directory of image files, which on this target is Cache Storage — see the
    // arms, and `reset::clear_cache`'s own gate.
    "collection_clear",
    "wishlist_clear",
    "decks_clear",
    // **The two halves of the updater that report rather than replace.** The other three —
    // `update_check`, `update_download`, `update_apply` — and `update_open_release_page`
    // stay desktop's; the arms below say why the first of those is *absent* here rather than
    // merely unrouted.
    "update_status",
    "update_history",
    // The backup, and **only the archive half of it**. `mirror_status`, `mirror_set_enabled`,
    // `mirror_set_root` and `mirror_rebuild` are the folder, which a browser has nowhere to
    // put; `mirror_backup_save` writes at a path a file dialog answered, which a browser has
    // no way to name. What is left is the one door that fits: render the same files and hand
    // the page the bytes.
    "mirror_backup_zip",
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
///
/// **`&Arc<AppState>` rather than `&AppState`, and the collection is why.** Every write to
/// `collection_entries` goes through [`crate::collection_source::with_write_owned`], which
/// takes the `Arc` because it hands it to `index::lifecycle::invalidate_owned` after a
/// successful write. Taking the bare reference here would have meant either re-spelling that
/// helper's two steps in every collection arm - two copies of a rule that must agree, which
/// this repo has been bitten by - or leaving the facet index stale after a web write.
/// `glue.rs` already holds an `Arc` and passed `&app` either way, so this costs it nothing,
/// and `&Arc<AppState>` derefs to `&AppState` for every arm that wants the plain one.
pub fn call(
    state: &std::sync::Arc<AppState>,
    command: &str,
    args: &Value,
) -> Result<Value, RouteError> {
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

        // ── Decks, write path ───────────────────────────────────────────────────────
        //
        // **`with_write`, never `lock_db_read`.** That helper is ungated and was prepared for
        // this before there was a web target to use it: its doc says the wasm arm "exists
        // before the first web write rather than after it", because `Instant::now()` panics
        // on `wasm32-unknown-unknown`.
        //
        // **And the test that catches a write on the read connection only catches it on the
        // desktop**, which is worth knowing before trusting a green suite here. There
        // `db_read` is `SQLITE_OPEN_READ_ONLY`, so the mutation fails loudly with "attempt to
        // write a readonly database" — measured. On wasm `lock_db_read` *hands back the write
        // connection* (see this module's header), so the same mistake would commit happily
        // and cost only what `with_write` adds: the busy answer and the cross-file fence.
        // `cargo test` runs on the desktop, so the guard is real; it is not the target the
        // bug would ship to.
        //
        // **`deck_set_cover_image` is deliberately absent** and is the eleventh name on §6.3's
        // desktop-only list. It writes a file into a covers directory, and a browser has none
        // — `deck::set_cover_image` does not compile for wasm at all.
        "deck_create" => {
            let deck: crate::deck::DeckInput = field(command, args, "deck")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::create_deck(c, &deck))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_update" => {
            let id: i64 = field(command, args, "id")?;
            let patch: crate::deck::DeckPatch = field(command, args, "patch")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::update_deck(c, id, &patch))
                    .map_err(RouteError::Failed)?,
            )
        }

        // `None` for the covers directory, on both of these and for the same reason: the
        // desktop wrapper reads it off the `AppHandle` and the web target has no such folder.
        // The parameter was already `Option<&Path>`, so this is the answer it was shaped for
        // rather than a stub.
        "deck_delete" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::delete_deck(c, id, None))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_duplicate" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::duplicate_deck(c, id, None))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_set_folder" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let folder_id: Option<i64> = optional(command, args, "folderId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::set_folder(c, deck_id, folder_id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_set_view_state" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let view_state: crate::deck::DeckViewState = field(command, args, "viewState")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::set_view_state(c, deck_id, &view_state)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "set_deck_search_open" => {
            let open: bool = field(command, args, "open")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::store_deck_search_open(c, open))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_missing_to_wishlist" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck::missing_to_wishlist(c, deck_id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_add_card" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let card_id: String = field(command, args, "cardId")?;
            let category_id: Option<i64> = optional(command, args, "categoryId")?;
            let category_name: Option<String> = optional(command, args, "categoryName")?;
            let variant: String = field(command, args, "variant")?;
            let finish: Option<String> = optional(command, args, "finish")?;
            let quantity: i64 = field(command, args, "quantity")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::add_card(
                        c,
                        deck_id,
                        &card_id,
                        category_id,
                        category_name.as_deref(),
                        &variant,
                        finish.as_deref(),
                        quantity,
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_set_card_quantity" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let card_id: String = field(command, args, "cardId")?;
            let category_id: i64 = field(command, args, "categoryId")?;
            let variant: String = field(command, args, "variant")?;
            let finish: Option<String> = optional(command, args, "finish")?;
            let quantity: i64 = field(command, args, "quantity")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::set_card_quantity(
                        c,
                        deck_id,
                        &card_id,
                        category_id,
                        &variant,
                        finish.as_deref(),
                        quantity,
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_category_clear" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let category_id: i64 = field(command, args, "categoryId")?;
            let variant: String = field(command, args, "variant")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::clear_category(c, deck_id, category_id, &variant)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_move_card" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let card_id: String = field(command, args, "cardId")?;
            let from_category_id: i64 = field(command, args, "fromCategoryId")?;
            let to_category_id: Option<i64> = optional(command, args, "toCategoryId")?;
            let to_category_name: Option<String> = optional(command, args, "toCategoryName")?;
            let variant: String = field(command, args, "variant")?;
            let finish: Option<String> = optional(command, args, "finish")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::move_card(
                        c,
                        deck_id,
                        &card_id,
                        from_category_id,
                        to_category_id,
                        to_category_name.as_deref(),
                        &variant,
                        finish.as_deref(),
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_swap_printing" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let from_card_id: String = field(command, args, "fromCardId")?;
            let to_card_id: String = field(command, args, "toCardId")?;
            let category_id: i64 = field(command, args, "categoryId")?;
            let variant: String = field(command, args, "variant")?;
            let finish: Option<String> = optional(command, args, "finish")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::swap_printing(
                        c,
                        deck_id,
                        &from_card_id,
                        &to_card_id,
                        category_id,
                        &variant,
                        finish.as_deref(),
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_set_card_finish" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let card_id: String = field(command, args, "cardId")?;
            let category_id: i64 = field(command, args, "categoryId")?;
            let variant: String = field(command, args, "variant")?;
            let from_finish: Option<String> = optional(command, args, "fromFinish")?;
            let to_finish: Option<String> = optional(command, args, "toFinish")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck::set_card_finish(
                        c,
                        deck_id,
                        &card_id,
                        category_id,
                        &variant,
                        from_finish.as_deref(),
                        to_finish.as_deref(),
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── Categories, tags and folders ────────────────────────────────────────────
        "deck_category_create" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::create_category(c, deck_id, &name)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_category_rename" => {
            let id: i64 = field(command, args, "id")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck_meta::rename_category(c, id, &name))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_category_set_active" => {
            let id: i64 = field(command, args, "id")?;
            let is_active: bool = field(command, args, "isActive")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::set_category_active(c, id, is_active)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_category_reorder" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let ids: Vec<i64> = field(command, args, "ids")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::reorder_categories(c, deck_id, &ids)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_category_delete" => {
            let id: i64 = field(command, args, "id")?;
            let move_to: Option<i64> = optional(command, args, "moveToCategoryId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::delete_category(c, id, move_to)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_tag_create" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let name: String = field(command, args, "name")?;
            let color: String = field(command, args, "color")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::create_tag(c, deck_id, &name, &color)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_tag_update" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let id: i64 = field(command, args, "id")?;
            let name: String = field(command, args, "name")?;
            let color: String = field(command, args, "color")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::update_tag(c, deck_id, id, &name, &color)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_tag_delete" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck_meta::delete_tag(c, deck_id, id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_tag_remove_from_deck" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let tag_id: i64 = field(command, args, "tagId")?;
            let variant: String = field(command, args, "variant")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::remove_tag_from_deck(c, deck_id, tag_id, &variant)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_card_set_tag" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let card_id: String = field(command, args, "cardId")?;
            let category_id: i64 = field(command, args, "categoryId")?;
            let variant: String = field(command, args, "variant")?;
            let tag_id: Option<i64> = optional(command, args, "tagId")?;
            encode(
                command,
                // `None` for the finish, exactly as the wrapper passes: `finish` reaches this
                // command and is not forwarded, which is the desktop's behaviour and not a
                // dropped argument to be "fixed" here.
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::set_card_tag(
                        c,
                        deck_id,
                        &card_id,
                        category_id,
                        &variant,
                        None,
                        tag_id,
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_folder_create" => {
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::create_folder(c, parent_id, &name)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_folder_rename" => {
            let id: i64 = field(command, args, "id")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck_meta::rename_folder(c, id, &name))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_folder_move" => {
            let id: i64 = field(command, args, "id")?;
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck_meta::move_folder(c, id, parent_id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_folder_reorder" => {
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            let ids: Vec<i64> = field(command, args, "ids")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_meta::reorder_folders(c, parent_id, &ids)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_folder_delete" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck_meta::delete_folder(c, id))
                    .map_err(RouteError::Failed)?,
            )
        }

        // ── Theory list and undo ────────────────────────────────────────────────────
        "deck_theory_copy_from_live" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::deck_theory::copy_from_live(c, deck_id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "deck_theory_missing_to_wishlist" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let only: Option<Vec<String>> = optional(command, args, "only")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_theory::missing_to_wishlist(c, deck_id, only.as_deref())
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // The `true`/`false` is which direction the reversal runs, and it is the whole
        // difference between these two commands on the desktop as well.
        "deck_undo_apply" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let audit_id: i64 = field(command, args, "auditId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_undo::apply_reversal(c, deck_id, audit_id, true)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_redo_apply" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let audit_id: i64 = field(command, args, "auditId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::deck_undo::apply_reversal(c, deck_id, audit_id, false)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── Collection ──────────────────────────────────────────────────────────────
        //
        // **Every write here is [`crate::collection_source::with_write_owned`], not
        // `with_write`**, and the difference is the facet index: that helper runs
        // `index::lifecycle::invalidate_owned` after a successful write, so the *owned*
        // dimension stops answering about a collection that has changed. Using the plain
        // helper would leave the search's owned facet stale until the next rebuild — a wrong
        // count rather than an error, which is the kind that does not get reported.
        //
        // The folder commands are the exception and use `with_write`, exactly as their
        // wrappers do: moving a folder changes no quantity, so the owned index is unaffected.
        // `collection_set_folder` is a folder command that *does* use the owned helper,
        // because it moves an entry rather than a folder.
        "collection_list" => {
            let query: crate::collection::CollectionQuery = field(command, args, "query")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::collection::list_entries(&conn, &query).map_err(RouteError::Failed)?,
            )
        }

        "collection_summary" => {
            let query: crate::collection::CollectionQuery = field(command, args, "query")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::collection::summarise(&conn, &query).map_err(RouteError::Failed)?,
            )
        }

        "collection_add" => {
            let entry: crate::collection::EntryInput = field(command, args, "entry")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection::add_entry(c, &entry)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "collection_set_quantity" => {
            let id: i64 = field(command, args, "id")?;
            let quantity: i64 = field(command, args, "quantity")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection::set_quantity(c, id, quantity)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "collection_update" => {
            let id: i64 = field(command, args, "id")?;
            let patch: crate::collection::EntryPatch = field(command, args, "patch")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection::update_entry(c, id, &patch)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "collection_remove" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection::remove_entry(c, id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // **This is the *commit*, not the file read.** It takes already-parsed items, so it
        // is an ordinary port; `import_read_file` is the one that needs a browser mechanism
        // §6.2 specifies and is not here.
        "collection_import_commit" => {
            let items: Vec<crate::collection::CollectionImportItem> =
                field(command, args, "items")?;
            let mode: String = field(command, args, "mode")?;
            let folder_id: Option<i64> = optional(command, args, "folderId")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection::commit_import(c, &items, &mode, folder_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── The collection's cabinet ────────────────────────────────────────────────
        "collection_folder_list" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::collection_folders::list_folders(&conn).map_err(RouteError::Failed)?,
            )
        }

        "collection_folder_summary" => {
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::collection_folders::folder_summary(&conn, marketplace)
                    .map_err(RouteError::Failed)?,
            )
        }

        "collection_folder_create" => {
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::collection_folders::create_folder(c, parent_id, &name)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "collection_folder_rename" => {
            let id: i64 = field(command, args, "id")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::collection_folders::rename_folder(c, id, &name)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "collection_folder_move" => {
            let id: i64 = field(command, args, "id")?;
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::collection_folders::move_folder(c, id, parent_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "collection_folder_reorder" => {
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            let ids: Vec<i64> = field(command, args, "ids")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::collection_folders::reorder_folders(c, parent_id, &ids)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // **`with_write`, matching its wrapper**, even though deleting a folder re-files every
        // row inside it: those rows keep their quantities, so nothing the owned index counts
        // has changed. The wrapper is the authority on which helper a command uses, and this
        // is a place where guessing from "it touches entries" would have got it wrong.
        "collection_folder_delete" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::collection_folders::delete_folder(c, id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "collection_set_folder" => {
            let id: i64 = field(command, args, "id")?;
            let folder_id: Option<i64> = optional(command, args, "folderId")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection_folders::set_entry_folder(c, id, folder_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── Across the deck boundary ────────────────────────────────────────────────
        //
        // The crate's only pair that moves a row between a binder and a deck. Both are
        // `with_write_owned` because both change what a deck owns.
        "collection_to_deck" => {
            let entry_id: i64 = field(command, args, "entryId")?;
            let deck_id: i64 = field(command, args, "deckId")?;
            let category_id: Option<i64> = optional(command, args, "categoryId")?;
            let category_name: Option<String> = optional(command, args, "categoryName")?;
            let quantity: i64 = field(command, args, "quantity")?;
            // Before the lock, as the wrapper does: a caller that named a pile both ways is a
            // caller bug and is not worth waiting on a busy database to discover.
            let pile =
                crate::collection_alloc::Pile::from_args(category_id, category_name.as_deref())
                    .map_err(RouteError::Failed)?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection_alloc::collection_to_deck(
                        c, entry_id, deck_id, pile, quantity,
                    )
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "deck_to_collection" => {
            let deck_card_id: i64 = field(command, args, "deckCardId")?;
            let quantity: i64 = field(command, args, "quantity")?;
            encode(
                command,
                crate::collection_source::with_write_owned(state, |c| {
                    crate::collection_alloc::deck_to_collection(c, deck_card_id, quantity)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── Wishlist ────────────────────────────────────────────────────────────────
        //
        // **Plain `with_write` throughout, and the contrast with the collection above is the
        // point.** A wish is something the reader does *not* have, so nothing here changes
        // what is owned and the facet index has nothing to invalidate. Reaching for
        // `with_write_owned` because the two destinations look alike would rebuild the owned
        // index on every wish edit — wasted work rather than a wrong answer, but wrong about
        // what the two lists mean.
        "wishlist_list" => {
            let query: crate::wishlist::WishlistQuery = field(command, args, "query")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::wishlist::list_wishes(&conn, &query).map_err(RouteError::Failed)?,
            )
        }

        "wishlist_add" => {
            let wish: crate::wishlist::WishInput = field(command, args, "wish")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::wishlist::add_wish(c, &wish))
                    .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_set_quantity" => {
            let id: i64 = field(command, args, "id")?;
            let quantity: i64 = field(command, args, "quantity")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist::set_wish_quantity(c, id, quantity)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_remove" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::wishlist::remove_wish(c, id))
                    .map_err(RouteError::Failed)?,
            )
        }

        // `cardId` on the wire, `card_id` in Rust, and `None` is a real value here rather than
        // an omission: it is how a wish stops naming a particular printing.
        "wishlist_set_printing" => {
            let id: i64 = field(command, args, "id")?;
            let card_id: Option<String> = optional(command, args, "cardId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist::set_wish_printing(c, id, card_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_import_commit" => {
            let items: Vec<crate::wishlist::WishlistImportItem> = field(command, args, "items")?;
            let mode: String = field(command, args, "mode")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist::commit_import(c, &items, &mode)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── The wishlist's cabinet ──────────────────────────────────────────────────
        "wishlist_folder_list" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::wishlist_folders::list_folders(&conn).map_err(RouteError::Failed)?,
            )
        }

        "wishlist_folder_summary" => {
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::wishlist_folders::folder_summary(&conn, marketplace)
                    .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_folder_create" => {
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist_folders::create_folder(c, parent_id, &name)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_folder_rename" => {
            let id: i64 = field(command, args, "id")?;
            let name: String = field(command, args, "name")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist_folders::rename_folder(c, id, &name)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_folder_move" => {
            let id: i64 = field(command, args, "id")?;
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist_folders::move_folder(c, id, parent_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_folder_reorder" => {
            let parent_id: Option<i64> = optional(command, args, "parentId")?;
            let ids: Vec<i64> = field(command, args, "ids")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist_folders::reorder_folders(c, parent_id, &ids)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_folder_delete" => {
            let id: i64 = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::wishlist_folders::delete_folder(c, id))
                    .map_err(RouteError::Failed)?,
            )
        }

        "wishlist_set_folder" => {
            let id: i64 = field(command, args, "id")?;
            let folder_id: Option<i64> = optional(command, args, "folderId")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::wishlist_folders::set_wish_folder(c, id, folder_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── The card pane ───────────────────────────────────────────────────────────
        //
        // **`card_detail` is the command the reader actually reported**, on 2026-08-29:
        // *"Could not read this card — unknown command `card_detail`"*, tapping a card on the
        // phone minutes after the browse became good enough to invite the tap. It is one line
        // of `match` and always was; what it was waiting for was `card.rs` to compile for the
        // target, which is the gate move in this same PR.
        "card_detail" => {
            let id: String = field(command, args, "id")?;
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let market = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::card::get_card(&conn, &id, market).map_err(RouteError::Failed)?,
            )
        }

        // `oracleId` on the wire; `limit` absent means the pane's own `MAX_PRINTINGS`, which
        // `list_printings` applies — so `None` is passed through rather than defaulted here.
        "card_printings" => {
            let oracle_id: String = field(command, args, "oracleId")?;
            let marketplace: Option<String> = optional(command, args, "marketplace")?;
            let limit: Option<i64> = optional(command, args, "limit")?;
            let market = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::card::list_printings(&conn, &oracle_id, market, limit)
                    .map_err(RouteError::Failed)?,
            )
        }

        "card_meld_parts" => {
            let id: String = field(command, args, "id")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::card::meld_parts(&conn, &id).map_err(RouteError::Failed)?,
            )
        }

        // **Answers an `mtgimg://` URI the browser cannot fetch**, and routing it anyway is
        // deliberate: the command's job is to resolve *which* picture a printing has, and the
        // page decides what to do with the answer. On web `src/lib/images.ts` builds a
        // `cards.scryfall.io` URL from the same two columns through the service worker, so
        // this arm answering is not what makes an image appear — it is what stops the call
        // being an `unknown command` in the console while the page works.
        "card_image_uri" => {
            let card_id: String = field(command, args, "cardId")?;
            let variant: String = field(command, args, "variant")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::card::card_image_uri_inner(&conn, &card_id, &variant)
                    .map_err(RouteError::Failed)?,
            )
        }

        "printing_group_by" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::card::stored_group_by(&conn))
        }

        "set_printing_group_by" => {
            let mode: String = field(command, args, "mode")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::card::store_group_by(c, &mode))
                    .map_err(RouteError::Failed)?,
            )
        }

        // ── The Tagger ──────────────────────────────────────────────────────────────
        //
        // **Ten of twelve, and the two missing are the two that download.**
        // `oracle_tags_refresh` and `art_tags_refresh` fetch a bulk file from Scryfall
        // through `state.client` — a field wasm's `AppState` does not have — and report
        // progress through an `AppHandle`. They are the download half of the split the
        // compiler named in PR 10a, and porting them is its own piece of work rather than a
        // `match` arm.
        //
        // **What the ten buy is the documented fallback instead of an error.** A database
        // that has never fetched a taxonomy is a supported state — `src-tauri/CLAUDE.md` says
        // the Tags page "says so and still answers from the oracle side" — and until now the
        // web target could not even reach that state, because `tag_children` was an unknown
        // command. Both `*_status` arms answer honestly on a browser: never fetched, stale.
        "oracle_tags_status" => encode(
            command,
            crate::tags::status_of(&crate::tags::oracle::ORACLE, state),
        ),

        "art_tags_status" => encode(
            command,
            crate::tags::status_of(&crate::tags::art::ART, state),
        ),

        "oracle_tags_for_cards" => {
            let oracle_ids: Vec<String> = field(command, args, "oracleIds")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::tags::oracle::read_card_tags(&conn, &oracle_ids)
                    // The wrapper's own sentence, so the page sees one message whatever
                    // target answered it.
                    .map_err(|e| RouteError::Failed(format!("could not read the tags: {e}")))?,
            )
        }

        "oracle_tags_for_printings" => {
            let card_ids: Vec<String> = field(command, args, "cardIds")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::tags::oracle::read_printing_tags(&conn, &card_ids)
                    .map_err(|e| RouteError::Failed(format!("could not read the tags: {e}")))?,
            )
        }

        "tag_search" => {
            let text: String = field(command, args, "text")?;
            let namespace: String = field(command, args, "namespace")?;
            let limit: u32 = field(command, args, "limit")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::tags::query::run_tag_search(&conn, &text, &namespace, limit)
                    .map_err(RouteError::Failed)?,
            )
        }

        "tag_children" => {
            let namespace: String = field(command, args, "namespace")?;
            let slug: Option<String> = optional(command, args, "slug")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::tags::query::run_tag_children(&conn, &namespace, slug.as_deref())
                    .map_err(RouteError::Failed)?,
            )
        }

        "tag_resolve" => {
            let asks: Vec<crate::tags::query::TagLookup> = field(command, args, "asks")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::tags::query::run_tag_resolve(&conn, &asks).map_err(RouteError::Failed)?,
            )
        }

        "tags_muted" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::tags::muted::list(&conn).map_err(RouteError::Failed)?,
            )
        }

        // **`now_from` and not `unix_now`**: the muted row carries a timestamp, and
        // `SystemTime::now()` panics on `wasm32-unknown-unknown` rather than failing. The
        // clock comes off the connection, which is the same answer `sync_engine::entitlement`
        // reaches for the same reason.
        "tag_mute" => {
            let namespace: String = field(command, args, "namespace")?;
            let tag_id: String = field(command, args, "tagId")?;
            let slug: String = field(command, args, "slug")?;
            encode(
                command,
                crate::sync::with_write(state, |conn| {
                    let now = crate::tags::now_from(conn);
                    crate::tags::muted::mute(conn, &namespace, &tag_id, &slug, now)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        "tag_unmute" => {
            let namespace: String = field(command, args, "namespace")?;
            let tag_id: String = field(command, args, "tagId")?;
            encode(
                command,
                crate::sync::with_write(state, |conn| {
                    crate::tags::muted::unmute(conn, &namespace, &tag_id)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── Settings, and the view state the pages keep in `app_meta` ───────────────
        //
        // Eight of these are four matched pairs — read the setting, write the setting — and
        // all four modules moved to "Every target" in this PR because none of them has a
        // filesystem, a `tokio` or a `reqwest` in it. They lean on [`crate::app_meta`], which
        // is why PR 10a's carve-out had to come first.
        "nav_collapsed" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::nav::stored(&conn))
        }

        "set_nav_collapsed" => {
            let collapsed: bool = field(command, args, "collapsed")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::nav::store(c, collapsed))
                    .map_err(RouteError::Failed)?,
            )
        }

        "card_zoom" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::zoom::stored(&conn))
        }

        "set_card_zoom" => {
            let section: String = field(command, args, "section")?;
            let zoom: f64 = field(command, args, "zoom")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::zoom::store(c, &section, zoom))
                    .map_err(RouteError::Failed)?,
            )
        }

        "list_view" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::listview::stored(&conn))
        }

        "set_list_view" => {
            let section: String = field(command, args, "section")?;
            let view: String = field(command, args, "view")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::listview::store(c, &section, &view))
                    .map_err(RouteError::Failed)?,
            )
        }

        "flatten_state" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::flatten::stored(&conn))
        }

        "set_flatten_state" => {
            let section: String = field(command, args, "section")?;
            let flattened: bool = field(command, args, "flattened")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::flatten::store(c, &section, flattened))
                    .map_err(RouteError::Failed)?,
            )
        }

        // ── The error log ───────────────────────────────────────────────────────────
        //
        // **Both wrappers live in `desktop.rs`, which can never compile for wasm** — it is the
        // Tauri app's own setup. Nothing needed lifting for all that: they are thin over
        // `errors::list` and `errors::clear`, and `errors` has been ungated all along.
        "error_log_list" => {
            let limit: i64 = field(command, args, "limit")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::errors::list(&conn, limit).map_err(|e| {
                    RouteError::Failed(format!("could not read the error log: {e}"))
                })?,
            )
        }

        "error_log_clear" => encode(
            command,
            crate::sync::with_write(state, |c| {
                crate::errors::clear(c).map_err(|e| format!("could not clear the error log: {e}"))
            })
            .map_err(RouteError::Failed)?,
        ),

        // ── The marketplace ─────────────────────────────────────────────────────────
        "get_marketplace" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::marketplace::stored(&conn))
        }

        // **`store`, not `set_marketplace_now`**, and the difference is one line the web
        // target has no use for. That wrapper is `store` plus `state.mirror.mark_all()`,
        // because changing the marketplace changes what every mirrored CSV would say — and a
        // browser has no plain-text mirror to re-render. Calling the pure half here is not a
        // reduced feature; it is the whole of the feature that exists on this target.
        "set_marketplace" => {
            let id: String = field(command, args, "id")?;
            encode(
                command,
                crate::sync::with_write(state, |c| crate::marketplace::store(c, &id))
                    .map_err(RouteError::Failed)?,
            )
        }

        // ── Commander Spellbook's combos ────────────────────────────────────────────
        //
        // **Two of three, and `combos.rs` was ungated all along** — it is on `lib.rs`'s
        // every-target list because its ingest streams through `crate::feed`. Only
        // `combos_refresh` is missing, for `oracle_tags_refresh`'s reason: it downloads.
        //
        // `combos_status` is on the Settings panel and `combos_for_cards` is the deck
        // bracket's fourth signal. **A database that never fetched the feed answers three
        // signals instead of four**, which the crate documents as supported rather than an
        // error — and `combos_status` is explicitly safe before the first refresh: two zeros,
        // three nulls and `stale: true`.
        "combos_status" => encode(command, crate::combos::status_of(state)),

        "combos_for_cards" => {
            let card_ids: Vec<String> = field(command, args, "cardIds")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::combos::match_combos(&conn, &card_ids).map_err(RouteError::Failed)?,
            )
        }

        // ── The last two gaps ───────────────────────────────────────────────────────
        //
        // Both were named in this file's own tally as gaps rather than decisions, and both are
        // closed here. What is left after them is deliberate on every line.
        //
        // **`marketplace_feed_status` is a pure query that was stranded in a module that also
        // downloads** — the same shape `tags` had, and split the same way. The arm maps
        // `PROVIDERS` over `read_status` exactly as the wrapper does, rather than going
        // through `status_of`: that helper is the *refresh* path's, and reaching for it here
        // because the names match would have been the wrong function with the right label.
        "marketplace_feed_status" => {
            let conn = crate::sync::lock_db_read(state);
            // The clock off the connection, for the third time in this file's history:
            // `SystemTime::now()` panics on wasm rather than failing.
            let now = conn
                .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0);
            let out: Vec<_> = crate::marketplace_feed::PROVIDERS
                .iter()
                .map(|p| crate::marketplace_feed::read_status(&conn, *p, now))
                .collect();
            encode(command, out)
        }

        // **`import`'s two pure halves.** Only `import_read_file` needs the file handle §6.2
        // specifies; resolving a pasted decklist against the corpus and committing the result
        // are ordinary SQLite. The page can already paste a list without touching a file, so
        // these two are the whole of the import that works on this target.
        "import_resolve" => {
            let lines: Vec<crate::import::ResolveLine> = field(command, args, "lines")?;
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::import::resolve_lines(&conn, &lines).map_err(RouteError::Failed)?,
            )
        }

        "deck_import_commit" => {
            let deck_id: i64 = field(command, args, "deckId")?;
            let variant: String = field(command, args, "variant")?;
            let mode: String = field(command, args, "mode")?;
            let items: Vec<crate::import::ImportItem> = field(command, args, "items")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::import::commit_import(c, deck_id, &variant, &mode, &items)
                })
                .map_err(RouteError::Failed)?,
            )
        }

        // ── Settings' clears ─────────────────────────────────────────────────────────
        //
        // **Three of the four, and none of them takes an argument** — `src/lib/ipc.ts` calls
        // each as a bare `invoke("…_clear")`, so there is no name here to get wrong.
        //
        // **`cache_clear` is deliberately absent and is not an oversight.** It is the only
        // one of the four whose function does not compile for this target: `clear_cache`
        // takes a `&crate::images::Cache` and sweeps a directory, and on web the byte cache
        // is Cache Storage rather than a filesystem. That is a rewrite rather than a port —
        // the same call `lib.rs` makes about `images` itself — and it is its own piece of
        // work. Until it lands, the Local cache panel's button is the one control on the
        // Settings page that still answers `unknown command` in a browser.
        "collection_clear" => encode(
            command,
            // `with_write_owned`, matching the desktop wrapper: the facet index's `owned`
            // bitset is built from `collection_entries`, so a wipe that skipped the rebuild
            // would leave the sidebar offering an Owned facet over a collection that is gone.
            crate::collection_source::with_write_owned(state, crate::reset::clear_collection)
                .map_err(RouteError::Failed)?,
        ),

        "wishlist_clear" => encode(
            command,
            crate::sync::with_write(state, crate::reset::clear_wishlist)
                .map_err(RouteError::Failed)?,
        ),

        // **`None` for the covers directory, and it is the load-bearing argument on this
        // line.** `clear_decks` hands that path to `sweep_dir`, which deletes everything
        // under it recursively; its own doc already defines `None` as "the directory could
        // not be resolved, so the rows go and the pictures they pointed at are inert". A
        // browser has no covers directory at all — `crate::paths` does not compile here —
        // so `None` is not a fallback, it is the true answer, and there is no value this
        // target could pass that would be safe to sweep.
        "decks_clear" => encode(
            command,
            crate::sync::with_write(state, |c| crate::reset::clear_decks(c, None))
                .map_err(RouteError::Failed)?,
        ),

        // ── The updater, reporting only ──────────────────────────────────────────────
        //
        // **`update_check` is absent from this table and cannot be added to it**, which is
        // a different thing from the four `*_refresh` commands merely not being here yet.
        // This function is synchronous — the Worker's `#[wasm_bindgen] call` is — so an
        // `async fn` cannot be a `match` arm at all, whatever it fetches with. The two
        // network operations this target does perform are `glue::ingest_cards` and
        // `glue::ingest_combos`: bespoke `async` `#[wasm_bindgen]` entry points with their
        // own `postMessage` kinds, which is what a web `update_check` would have to become.
        // Nothing calls it in the meantime: `UpdatePanel` reads `installKind` below and
        // offers a browser no Check button.
        //
        // `Web`, `false`, `false` — and `status_for` takes the read connection itself, like
        // every other read in this table. Nothing here can be busy with a check it cannot
        // run, and nothing can be staged where there is no file to stage.
        "update_status" => encode(
            command,
            crate::update::status_for(state, crate::update::InstallKind::Web, false, false),
        ),

        // Two `app_meta` reads and no network, on every target — `update::history`'s own
        // doc is explicit that it never fetches. **In a browser it always answers an empty
        // list**, because only `update_check` writes that row and `app_meta` is not one of
        // the synced tables. That is the same "never fetched" state the Tagger models, and
        // it is why the panel draws no version history there.
        "update_history" => encode(command, crate::update::history(state)),
        // ── The backup ──────────────────────────────────────────────────────────────
        //
        // **The whole of what this target has instead of a folder.** `mirror::snapshot::build`
        // is the same renderer `run_pass` writes the folder with — same plan, same
        // `available_fields`, same `format_export` — so what the page downloads and what a
        // desktop mirrors are the same bytes by construction rather than by two tests
        // agreeing.
        //
        // `lock_db_read` and not a connection of its own, which is the single-Worker trade
        // this module's header already names: there is one thread here, so there is no queue
        // to jump. The desktop wrapper does open its own, because there it would be queueing
        // every search behind ~350 renders.
        "mirror_backup_zip" => {
            let conn = crate::sync::lock_db_read(state);
            encode(
                command,
                crate::mirror::snapshot::build(&conn)
                    .map_err(RouteError::Failed)?
                    .with_bytes(),
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

    /// **A write must land, and reading it back through the route is what says so.**
    ///
    /// The mutation this is aimed at is an arm built on `lock_db_read` instead of
    /// [`crate::sync::with_write`]: on the desktop that connection is `SQLITE_OPEN_READ_ONLY`
    /// and the write fails loudly, but the assertion has to be a *read-back* rather than
    /// `is_ok()` — a command that answered `Ok` and committed nothing would satisfy the
    /// weaker one forever.
    #[test]
    fn a_deck_created_through_the_route_is_there_when_the_route_is_asked_again() {
        let s = state("web-route-write-round-trip");
        let created = call(
            &s,
            "deck_create",
            &json!({ "deck": { "name": "Written On The Web", "formatKey": "commander" } }),
        )
        .expect("deck_create is routed");
        let id = created["id"].as_i64().expect("the new deck's id");

        let listed = call(&s, "deck_list", &json!({})).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1, "the write must commit");
        assert_eq!(listed[0]["name"], json!("Written On The Web"));
        assert_eq!(listed[0]["id"], json!(id));
    }

    /// A rename through the route, read back through the route. `deck_update` takes a whole
    /// `DeckPatch`, so this also pins that a nested camelCase DTO survives the hop.
    #[test]
    fn a_write_that_takes_a_dto_reaches_the_row() {
        let s = state("web-route-write-patch");
        let id = make_deck(&s, "Before");
        call(
            &s,
            "deck_update",
            &json!({ "id": id, "patch": { "name": "After" } }),
        )
        .expect("deck_update is routed");

        let listed = call(&s, "deck_list", &json!({})).unwrap();
        assert_eq!(listed[0]["name"], json!("After"));
    }

    /// **A refusal keeps its own words.** `deck_update` on an id nobody answers to is
    /// `RouteError::Failed` carrying the command's sentence, not an `Unknown` and not a panic
    /// — the page shows that string, so it has to survive the route unchanged.
    #[test]
    fn a_command_that_refuses_comes_back_as_failed_with_its_own_sentence() {
        let s = state("web-route-write-refused");
        let err = call(
            &s,
            "deck_update",
            &json!({ "id": 9_999_999, "patch": { "name": "Nobody" } }),
        )
        .unwrap_err();
        assert!(
            matches!(&err, RouteError::Failed(_)),
            "a refusal is not an unknown command: {err:?}"
        );
    }

    /// The Collection destination answers before anything is in it, and the page it answers
    /// with is a DTO rather than a bare array — `items`, not the rows.
    #[test]
    fn collection_list_answers_an_empty_page_before_anything_is_owned() {
        let s = state("web-route-collection-empty");
        let out = call(&s, "collection_list", &json!({ "query": {} })).unwrap();
        assert_eq!(
            out["items"]
                .as_array()
                .expect("collection_list answers a page with `items`")
                .len(),
            0
        );
    }

    /// A collection row added through the route, read back through the route.
    ///
    /// **This is the arm that must use [`crate::collection_source::with_write_owned`]**, and
    /// the read-back is what proves the write landed at all. What it deliberately does *not*
    /// prove is the facet-index invalidation that helper adds on top of `with_write` — that
    /// is a second effect on `AppState`, and a test asserting only the row would pass on an
    /// arm that used the plain helper and left the owned facet stale.
    #[test]
    fn a_collection_row_added_through_the_route_is_listed_by_it() {
        let s = state("web-route-collection-add");
        let card_id = {
            let conn = crate::db::lock_blocking(&s.db);
            conn.query_row("SELECT id FROM cards LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })
            .expect("the fixture seeds four printings")
        };

        call(
            &s,
            "collection_add",
            &json!({ "entry": { "cardId": card_id, "quantity": 3, "finish": "nonfoil" } }),
        )
        .expect("collection_add is routed");

        let out = call(&s, "collection_list", &json!({ "query": {} })).unwrap();
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "the write must commit");
        assert_eq!(items[0]["quantity"], json!(3));
    }

    /// A wish added through the route and listed by it.
    ///
    /// **The wishlist takes plain `with_write`, unlike the collection**, because a wish is
    /// something the reader does *not* have — nothing it writes changes what is owned. This
    /// pins the round trip; the helper choice is argued at the arms and cannot be asserted
    /// here, since both helpers would make this test pass.
    #[test]
    fn a_wish_added_through_the_route_is_listed_by_it() {
        let s = state("web-route-wishlist-add");
        let card_id = {
            let conn = crate::db::lock_blocking(&s.db);
            conn.query_row("SELECT id FROM cards LIMIT 1", [], |r| {
                r.get::<_, String>(0)
            })
            .expect("the fixture seeds four printings")
        };

        // **A name alone is refused** — "a wish needs either a card or an oracle id" — and the
        // first draft of this test hit that, which is worth keeping as a comment: the refusal
        // arrived through the route as `RouteError::Failed` carrying the command's own
        // sentence, so the arm was right and the fixture was wrong.
        call(
            &s,
            "wishlist_add",
            &json!({ "wish": { "cardId": card_id, "quantity": 1 } }),
        )
        .expect("wishlist_add is routed");

        let out = call(&s, "wishlist_list", &json!({ "query": {} })).unwrap();
        let items = out["items"].as_array().expect("a page with `items`");
        assert_eq!(items.len(), 1, "the write must commit");
        assert_eq!(items[0]["quantity"], json!(1));
    }

    /// **The command the reader reported.** On 2026-08-29, tapping a card on the phone gave
    /// *"Could not read this card — unknown command `card_detail`"*. This is that call, on the
    /// route that now answers it.
    #[test]
    fn card_detail_answers_the_card_the_reader_tapped() {
        let s = state("web-route-card-detail");
        let card_id = {
            let conn = crate::db::lock_blocking(&s.db);
            conn.query_row(
                "SELECT id FROM cards WHERE name = 'Lightning Bolt'",
                [],
                |r| r.get::<_, String>(0),
            )
            .expect("the fixture seeds Lightning Bolt")
        };

        let out = call(&s, "card_detail", &json!({ "id": card_id })).unwrap();
        assert_eq!(out["name"], json!("Lightning Bolt"));
        // camelCase again, and `setCode` is the one the pane's header reads first.
        assert!(
            out.get("setCode").is_some(),
            "the DTO's camelCase names must survive the route"
        );
    }

    /// An id nobody answers to is `null`, not an error — `card_detail`'s documented shape, and
    /// the page draws an empty pane rather than a failure for it.
    #[test]
    fn card_detail_answers_null_for_a_card_that_is_not_there() {
        let s = state("web-route-card-missing");
        let out = call(&s, "card_detail", &json!({ "id": "no-such-card" })).unwrap();
        assert_eq!(out, json!(null));
    }

    /// **A taxonomy that was never fetched is a supported state, and this is what it answers.**
    ///
    /// That is the whole value of routing the Tagger's queries without its two downloads: the
    /// web target could not previously reach this state at all, because `tag_children` was an
    /// `unknown command`. Now it reaches the documented fallback — a page that says it has
    /// nothing yet — instead of an error.
    #[test]
    fn the_tagger_answers_honestly_before_any_taxonomy_has_been_fetched() {
        let s = state("web-route-tags-cold");

        let status = call(&s, "oracle_tags_status", &json!({})).unwrap();
        // **`null`, not `0`** — `TagStatus::ingested_at`'s doc is explicit that `None` is
        // "never ingested", which for the oracle taxonomy means the app is categorising by
        // card type rather than by what a card does. A zero would have meant "fetched, and it
        // was empty", which is a different and much worse thing to report.
        assert_eq!(
            status["ingestedAt"],
            json!(null),
            "nothing has been fetched"
        );
        assert_eq!(status["tagCount"], json!(null));
        assert_eq!(status["stale"], json!(true), "never ingested is stale");
        assert_eq!(
            status["refreshing"],
            json!(false),
            "a browser never refreshes, so this can only ever be false there"
        );

        // The command the Tags page opens with, and the one the phone reported missing.
        let children = call(
            &s,
            "tag_children",
            &json!({ "namespace": "art", "slug": null }),
        )
        .unwrap();
        assert_eq!(
            children.as_array().expect("an array of children").len(),
            0,
            "an empty taxonomy is an empty list, not a refusal"
        );
    }

    /// A card nothing has tagged answers an entry rather than dropping out — one per requested
    /// id, in request order, which is the contract `src-tauri/CLAUDE.md` states for both tag
    /// reads and the reason a deck add can never fail for want of a tag.
    #[test]
    fn a_tag_read_answers_one_entry_per_requested_id() {
        let s = state("web-route-tags-per-id");
        let out = call(
            &s,
            "oracle_tags_for_cards",
            &json!({ "oracleIds": ["nobody-has-tagged-this", "nor-this"] }),
        )
        .unwrap();
        assert_eq!(out.as_array().unwrap().len(), 2);
    }

    /// The four view-state pairs, read back through the route.
    ///
    /// One test rather than four, because they are the same shape and the thing worth pinning
    /// is that a *setting written on the web target is there on the next read* — the whole
    /// point of `app_meta` having been carved out of the updater in PR 10a.
    #[test]
    fn a_view_setting_written_through_the_route_is_read_back_by_it() {
        let s = state("web-route-view-state");

        assert_eq!(call(&s, "nav_collapsed", &json!({})).unwrap(), json!(false));
        call(&s, "set_nav_collapsed", &json!({ "collapsed": true })).unwrap();
        assert_eq!(call(&s, "nav_collapsed", &json!({})).unwrap(), json!(true));

        call(
            &s,
            "set_card_zoom",
            &json!({ "section": "search", "zoom": 1.5 }),
        )
        .unwrap();
        let zoom = call(&s, "card_zoom", &json!({})).unwrap();
        assert_eq!(zoom["search"], json!(1.5));
    }

    /// **`set_marketplace` routes to `store`, not to `set_marketplace_now`**, and this is the
    /// evidence the difference is only the mirror.
    ///
    /// That wrapper is `store` plus `state.mirror.mark_all()`; a browser has no plain-text
    /// mirror to re-render, and `AppState` there has no `mirror` field to call it on. What the
    /// reader gets is the setting, saved and read back — which is the whole of the feature on
    /// this target rather than a reduced version of it.
    #[test]
    fn the_marketplace_setting_survives_the_route_without_the_mirror() {
        let s = state("web-route-marketplace");
        call(&s, "set_marketplace", &json!({ "id": "cardmarket" })).unwrap();
        assert_eq!(
            call(&s, "get_marketplace", &json!({})).unwrap(),
            json!("cardmarket")
        );
    }

    /// The error log answers an empty list before anything has gone wrong, and `limit` is a
    /// required argument rather than an optional one — `errors::list` clamps it, and the page
    /// always sends one.
    #[test]
    fn the_error_log_answers_before_anything_has_failed() {
        let s = state("web-route-error-log");
        let out = call(&s, "error_log_list", &json!({ "limit": 50 })).unwrap();
        assert_eq!(out.as_array().expect("an array of entries").len(), 0);

        let err = call(&s, "error_log_list", &json!({})).unwrap_err();
        assert!(matches!(&err, RouteError::Args { .. }), "got {err:?}");
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

    /// **The three clears answer their own counts through the route**, which is more than
    /// `every_advertised_command_is_actually_routed` can say: that one only proves an arm
    /// exists. Seeded, cleared, and the emptiness read back off the connection.
    ///
    /// **`decks_clear` is the one worth a test of its own and it does not get one here**,
    /// because the thing to prove about it cannot be proved from this side: its `covers`
    /// argument is hard-coded `None` in the arm, and `None` is the only value a browser
    /// could pass. What a wrong value would do — `sweep_dir` recursively deleting whatever
    /// directory it was handed — is `reset.rs`'s own concern and is fenced there. All this
    /// asserts is that the arm runs and empties the table.
    #[test]
    fn the_three_clears_empty_their_tables_through_the_route() {
        let s = state("web-route-clears");
        {
            let conn = crate::db::lock_blocking(&s.db);
            conn.execute_batch(
                "INSERT INTO collection_entries
                    (card_id, set_code, collector_number, lang, finish, condition, quantity,
                     created_at, updated_at)
                 VALUES ('a', 'lea', '1', 'en', 'nonfoil', 'NM', 4, 0, 0);
                 INSERT INTO wishlist_entries
                    (oracle_id, name, quantity, created_at, updated_at)
                 VALUES ('o1', 'Black Lotus', 2, 0, 0);",
            )
            .unwrap();
        }

        let cleared = call(&s, "collection_clear", &json!({})).unwrap();
        // camelCase, because `CollectionCleared` is `rename_all = "camelCase"` and
        // `src/lib/ipc.ts` reads this exact key.
        assert_eq!(cleared["entries"], json!(1));
        // `wishlist_clear` answers a bare count rather than a struct — see its Rust doc.
        assert_eq!(call(&s, "wishlist_clear", &json!({})).unwrap(), json!(1));
        // The decks table is empty in the fixture, so this proves the arm runs and refuses
        // nothing rather than proving a count.
        let decks = call(&s, "decks_clear", &json!({})).unwrap();
        assert!(decks.get("decks").is_some(), "got {decks:?}");

        let conn = crate::db::lock_blocking(&s.db);
        for table in ["collection_entries", "wishlist_entries"] {
            let left: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(left, 0, "{table} still has rows after its clear");
        }
    }

    /// **`cache_clear` is the fourth clear and must stay unroutable**, which is a different
    /// statement from "nobody has got to it yet". `reset::clear_cache` takes a
    /// `&crate::images::Cache` and sweeps a directory of files; on this target the byte
    /// cache is Cache Storage, so the arm cannot exist until that is rewritten.
    ///
    /// Asserted rather than left implicit because the failure it guards is silent in the
    /// other direction: an arm added here without the rewrite would compile only on the
    /// desktop leg and take the wasm build red on a branch nobody ran `--target` on.
    #[test]
    fn cache_clear_is_not_routed_while_the_image_cache_is_a_rewrite() {
        let s = state("web-route-cache-clear");
        let err = call(&s, "cache_clear", &json!({})).unwrap_err();
        assert_eq!(err, RouteError::Unknown("cache_clear".into()));
        assert!(!COMMANDS.contains(&"cache_clear"));
    }

    /// **The answer `UpdatePanel` reads to decide it must not draw a Download button.**
    ///
    /// `installKind` is the whole point of routing this: the panel tests it, and where the
    /// command did not answer at all the panel read the *absence* as "not managed" and drew
    /// the controls. So the assertion is on the value and on its camelCase key, both of
    /// which the TypeScript side reads by name.
    #[test]
    fn update_status_answers_the_web_install_kind_and_a_version() {
        let s = state("web-route-update-status");
        let out = call(&s, "update_status", &json!({})).unwrap();
        assert_eq!(out["installKind"], json!("web"));
        assert_eq!(
            out["currentVersion"],
            json!(crate::update::current_version())
        );
        // Nothing on this target can be mid-check or hold a staged build.
        assert_eq!(out["busy"], json!(false));
        assert_eq!(out["staged"], json!(false));
        // Never checked, because nothing here can check — and `app_meta` does not sync, so
        // no other device fills this in either.
        assert_eq!(out["available"], json!(null));
        assert_eq!(out["lastCheckAt"], json!(null));
    }

    /// **An empty list, and that is the answer rather than a failure.** `update::history`
    /// reads one `app_meta` row that only `update_check` ever writes, and `update_check` is
    /// absent on this target — so a browser's history is empty for ever, which is the same
    /// "never fetched" state the Tagger models.
    #[test]
    fn update_history_answers_an_empty_list_where_nothing_can_check() {
        let s = state("web-route-update-history");
        assert_eq!(call(&s, "update_history", &json!({})).unwrap(), json!([]));
    }

    /// **`update_check` is absent from this table and cannot be added to it.** Not "not yet"
    /// — [`call`] is synchronous because the Worker's `#[wasm_bindgen] call` is, so an
    /// `async fn` cannot be an arm here whatever it fetches with.
    ///
    /// Its three companions are refused for the ordinary reason: they swap an `.exe`.
    #[test]
    fn the_updater_commands_that_act_are_refused_by_name() {
        let s = state("web-route-update-absent");
        for name in [
            "update_check",
            "update_download",
            "update_apply",
            "update_open_release_page",
        ] {
            assert_eq!(
                call(&s, name, &json!({})).unwrap_err(),
                RouteError::Unknown(name.into()),
                "`{name}` must not be routed"
            );
            assert!(!COMMANDS.contains(&name));
        }
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
            120,
            "update this number when a command is added"
        );
    }
}
