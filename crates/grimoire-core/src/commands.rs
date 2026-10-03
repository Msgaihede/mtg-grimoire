//! **The command table**: one declaration per command a host with no window answers, and one
//! entry point, [`dispatch`], that answers a command by name.
//!
//! The light app's hosts call the engine through here — the WASM host exports `call(name, json)`
//! and forwards, the Android host registers one `#[tauri::command] core_call(name, args)` and
//! forwards (the light-app spec §2.4). **The desktop does not**: it keeps its typed
//! `#[tauri::command]` wrappers, which call the same core functions, and moving it onto the table
//! is a later decision, taken once the table has run on the two hosts it is for. So there are two
//! lists, and the fence between them is `src-tauri`'s `command_table` test: every command the
//! desktop registers is in this table, or on its explicit list of commands not yet here, or on its
//! list of desktop-only commands with a reason each — and every command here takes exactly the
//! arguments its desktop wrapper takes.
//!
//! **One line per command**, in the [`commands!`] block at the foot of this file:
//!
//! ```text
//! read card_detail in card(id: String, marketplace: Option<String>) = |conn| { … };
//! ```
//!
//! — its **kind**, its **name** (the desktop's command name, which is the wire), the **module**
//! whose items its body names (glob-imported for the entry and nothing else), its **arguments**
//! (the desktop wrapper's own names and types, which are the wire too), and its **body**: an
//! expression over the bound name that answers `Result<T, String>` for a `T` that serializes. The
//! macro expands each line into an argument struct, an arm of [`dispatch`] and a row of [`TABLE`].
//!
//! **The arguments arrive camelCase**, as `src/lib/ipc.ts` sends them and as Tauri renames a
//! wrapper's own: `card_ids` is `cardIds` on the wire. **A missing optional argument is `None`** —
//! serde reads an absent `Option` field as `None`, which is what Tauri does with one and what
//! `ipc.ts`, which omits an optional argument rather than sending `null`, relies on. A required
//! argument that is missing is a refusal in words, and so is a command this table does not have.
//!
//! **Five kinds, and what each puts the body on** ([`Kind`]):
//!
//! | Kind | The body runs | Bound to |
//! | --- | --- | --- |
//! | `read` | on the blocking pool, holding the read connection ([`State::lock_db_read`]) | `&Connection` |
//! | `write` | on the blocking pool, inside [`crate::state::with_write`] — armed, reconciled, settled, fenced, `db::BUSY` after its bound | `&Connection` |
//! | `owned` | the same, inside [`crate::collection_source::with_write_owned`], which also rebuilds the facet index's `owned` dimension | `&Connection` |
//! | `task` | where it stands, awaited — for what reaches a network or the sync lane | `Arc<State>` |
//! | `bytes` | on the blocking pool, with the raw body the call carried — the scanner's frame and capture | `Arc<State>`, `Vec<u8>` |
//!
//! In a browser "the blocking pool" is the caller ([`crate::platform::spawn`]). **Only `read`
//! commands are in the table so far** (Markus, 2026-10-03: the machinery and the reads first, the
//! rest as the light app's pages ask for them); the other four kinds are proven by this module's
//! own tests, over a table of their own.
//!
//! **A body is the desktop wrapper's own body**, its connection renamed, so a command answers the
//! same thing on every host. The reads were drafted from the wrappers by
//! `scripts/core-command-table.mjs` and checked by hand; a new entry is written by hand, next to
//! its neighbours.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::platform::spawn::Lost;
use crate::state::State;

// What the entries' arguments and bodies name that their own module imported privately, which an
// entry's glob import of that module does not carry. Every arm's block sees this scope.
#[allow(unused_imports)]
use crate::filters::CardFilters;
#[allow(unused_imports)]
use crate::sorting::Marketplace;
#[allow(unused_imports)]
use crate::wishlist::WishlistQuery;

/// What a command is — which connection it holds, if any, and where its body runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Read,
    Write,
    Owned,
    Task,
    Bytes,
}

/// One row of [`TABLE`]: a command's name, its kind and its argument names as declared — the
/// snake_case names of the desktop wrapper's parameters, which the parity test compares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub name: &'static str,
    pub kind: Kind,
    pub args: &'static [&'static str],
}

/// What a call names that the table does not have.
pub fn no_such(name: &str) -> String {
    format!("There is no command named {name} on this host.")
}

/// A command's arguments, read from the call's JSON — `null` and an absent object both read as
/// no arguments, since a call to a command that takes none may send either.
#[doc(hidden)]
pub fn parse<T: DeserializeOwned>(name: &str, args: Value) -> Result<T, String> {
    let args = if args.is_null() {
        Value::Object(serde_json::Map::new())
    } else {
        args
    };
    serde_json::from_value(args).map_err(|e| format!("{name}: its arguments did not parse: {e}"))
}

/// A command's answer, as the JSON a host hands back.
#[doc(hidden)]
pub fn answer<T: serde::Serialize>(name: &str, answer: T) -> Result<Value, String> {
    serde_json::to_value(answer).map_err(|e| format!("{name}: its answer did not serialize: {e}"))
}

/// Work on the blocking pool that did not come back — a panic in it, natively.
#[doc(hidden)]
pub fn lost(name: &str, e: Lost) -> String {
    format!("{name}: the work behind it failed: {e}")
}

/// Every kind but `bytes` refuses a call that carries a body: a host that sent one has called
/// the wrong command, and dropping the bytes would hide that.
#[doc(hidden)]
pub fn no_body(name: &str, body: &Option<Vec<u8>>) -> Result<(), String> {
    match body {
        Some(_) => Err(format!("{name} takes no raw body.")),
        None => Ok(()),
    }
}

/// A `bytes` command's body, or the refusal for a call that carried none.
#[doc(hidden)]
pub fn needs_body(name: &str, body: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    body.ok_or_else(|| format!("{name} needs a raw body."))
}

/// Which [`Kind`] a declaration's word is.
macro_rules! kind {
    (read) => {
        $crate::commands::Kind::Read
    };
    (write) => {
        $crate::commands::Kind::Write
    };
    (owned) => {
        $crate::commands::Kind::Owned
    };
    (task) => {
        $crate::commands::Kind::Task
    };
    (bytes) => {
        $crate::commands::Kind::Bytes
    };
}

/// One command's body, run as its kind says — see the module doc's table. Answers
/// `Result<T, String>`.
macro_rules! run {
    (read, $state:ident, $name:expr, $raw:ident, [$conn:ident], $body:expr) => {{
        $crate::commands::no_body($name, &$raw)?;
        let shared = ::std::sync::Arc::clone($state);
        $crate::platform::spawn::blocking(
            move || -> ::std::result::Result<_, ::std::string::String> {
                let guard = shared.lock_db_read();
                let $conn: &::rusqlite::Connection = &guard;
                $body
            },
        )
        .await
        .map_err(|e| $crate::commands::lost($name, e))?
    }};
    (write, $state:ident, $name:expr, $raw:ident, [$conn:ident], $body:expr) => {{
        $crate::commands::no_body($name, &$raw)?;
        let shared = ::std::sync::Arc::clone($state);
        $crate::platform::spawn::blocking(move || {
            $crate::state::with_write(&shared, |$conn: &::rusqlite::Connection| $body)
        })
        .await
        .map_err(|e| $crate::commands::lost($name, e))?
    }};
    (owned, $state:ident, $name:expr, $raw:ident, [$conn:ident], $body:expr) => {{
        $crate::commands::no_body($name, &$raw)?;
        let shared = ::std::sync::Arc::clone($state);
        $crate::platform::spawn::blocking(move || {
            $crate::collection_source::with_write_owned(
                &shared,
                |$conn: &::rusqlite::Connection| $body,
            )
        })
        .await
        .map_err(|e| $crate::commands::lost($name, e))?
    }};
    (task, $state:ident, $name:expr, $raw:ident, [$st:ident], $body:expr) => {{
        $crate::commands::no_body($name, &$raw)?;
        let $st: ::std::sync::Arc<$crate::state::State> = ::std::sync::Arc::clone($state);
        let answer: ::std::result::Result<_, ::std::string::String> = ($body).await;
        answer
    }};
    (bytes, $state:ident, $name:expr, $raw:ident, [$st:ident, $bytes:ident], $body:expr) => {{
        let $bytes: ::std::vec::Vec<u8> = $crate::commands::needs_body($name, $raw)?;
        let $st: ::std::sync::Arc<$crate::state::State> = ::std::sync::Arc::clone($state);
        $crate::platform::spawn::blocking(
            move || -> ::std::result::Result<_, ::std::string::String> { $body },
        )
        .await
        .map_err(|e| $crate::commands::lost($name, e))?
    }};
}

/// The table: [`TABLE`] and [`dispatch`], from one line per command. See the module doc.
macro_rules! commands {
    ($(
        $kind:ident $name:ident in $($module:ident)::+
            ( $($arg:ident : $ty:ty),* $(,)? ) = |$($bind:ident),+| $body:expr ;
    )*) => {
        /// Every command in the table, in declaration order.
        pub const TABLE: &[$crate::commands::Entry] = &[$(
            $crate::commands::Entry {
                name: stringify!($name),
                kind: kind!($kind),
                args: &[$(stringify!($arg)),*],
            }
        ),*];

        /// Answer the command called `name` with the arguments in `args` — the JSON object a
        /// host's call carried, camelCase — and, for a `bytes` command, the raw `body`.
        ///
        /// A name the table does not have, arguments that do not parse, and a body where none
        /// belongs (or none where one does) are each a refusal in words; so is anything the
        /// command itself refuses.
        pub async fn dispatch(
            state: &::std::sync::Arc<$crate::state::State>,
            name: &str,
            args: ::serde_json::Value,
            body: ::std::option::Option<::std::vec::Vec<u8>>,
        ) -> ::std::result::Result<::serde_json::Value, ::std::string::String> {
            match name {
                $(stringify!($name) => {
                    #[allow(unused_imports)]
                    use $crate::$($module)::+::*;
                    #[derive(::serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        $($arg: $ty),*
                    }
                    let Args { $($arg),* } = $crate::commands::parse(stringify!($name), args)?;
                    let answer = run!($kind, state, stringify!($name), body, [$($bind),+], $body)?;
                    $crate::commands::answer(stringify!($name), answer)
                })*
                _ => Err($crate::commands::no_such(name)),
            }
        }
    };
}

// BEGIN TABLE
commands! {
    // activity
    read activity_recent in activity(limit: u32) = |conn| recent(conn, limit);

    // card
    read card_detail in card(id: String, marketplace: Option<String>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        get_card(conn, &id, market)
    };
    read card_holdings in card(oracle_id: String) = |conn| holdings(conn, &oracle_id);
    read card_image_uri in card(card_id: String, variant: String) = |conn| {
        card_image_uri_inner(conn, &card_id, &variant)
    };
    read card_meld_parts in card(id: String) = |conn| meld_parts(conn, &id);
    read card_printings in card(oracle_id: String, marketplace: Option<String>, limit: Option<i64>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        list_printings(conn, &oracle_id, market, limit)
    };
    read card_tcgplayer_ids in card(id: String) = |conn| tcgplayer_ids(conn, &id);
    read printing_group_by in card() = |conn| Ok(stored_group_by(conn));
    read printing_prices in card(card_ids: Vec<String>, marketplace: Option<String>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        read_printing_prices(conn, &card_ids, market)
    };

    // collection
    read collection_breakdown in collection(dimension: String, marketplace: Option<String>) = |conn| {
        let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
        breakdown(conn, &dimension, marketplace)
    };
    read collection_import_preview in collection(items: Vec<CollectionImportItem>, mode: String, folder_id: Option<i64>) = |conn| {
        preview_import(conn, &items, &mode, folder_id)
    };
    read collection_list in collection(query: CollectionQuery) = |conn| list_entries(conn, &query);
    read collection_shelf_counts in collection(query: CollectionQuery) = |conn| {
        shelf_counts(conn, &query)
    };
    read collection_summary in collection(query: CollectionQuery) = |conn| summarise(conn, &query);

    // collection_folders
    read collection_folder_list in collection_folders() = |conn| list_folders(conn);
    read collection_folder_summary in collection_folders(marketplace: Option<String>) = |conn| {
        let marketplace = Marketplace::from_opt(marketplace.as_deref());
        folder_summary(conn, marketplace)
    };

    // combos
    read combos_for_card in combos(oracle_id: String, search: Option<String>, card_count: Option<i64>, owned_only: bool, limit: i64, offset: i64) = |conn| {
        card_combos(conn, &oracle_id, search.as_deref(), card_count, owned_only, limit, offset)
    };
    read combos_for_cards in combos(card_ids: Vec<String>) = |conn| match_combos(conn, &card_ids);

    // deck
    read deck_bracket_reads in deck(deck_ids: Vec<i64>) = |conn| bracket_reads(conn, &deck_ids);
    read deck_get in deck(id: i64, variant: String, marketplace: Option<String>) = |conn| {
        let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
        get_deck(conn, id, &variant, marketplace)
    };
    read deck_ids_playing in deck(keys: Vec<String>) = |conn| decks_playing(conn, &keys);
    read deck_last_format in deck() = |conn| Ok(last_deck_format(conn));
    read deck_list in deck() = |conn| list_decks(conn);
    read deck_pip_costs in deck() = |conn| pip_costs(conn);
    read deck_played_keys in deck(deck_id: i64) = |conn| played_keys(conn, deck_id);
    read deck_values in deck(marketplace: Option<String>) = |conn| {
        let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
        deck_values_for(conn, marketplace)
    };
    read format_specs_list in deck() = |conn| list_format_specs(conn);

    // deck_audit
    read deck_audit_list in deck_audit(deck_id: i64, limit: i64) = |conn| {
        list(conn, deck_id, limit)
    };

    // deck_completion
    read deck_completion in deck_completion(marketplace: Option<String>, compare: Option<String>) = |conn| {
        let marketplace = Marketplace::from_opt(marketplace.as_deref());
        let compare = Compare::from_opt(compare.as_deref());
        deck_completion_for(conn, marketplace, compare)
    };
    read deck_review_count in deck_completion() = |conn| review_count(conn);

    // deck_meta
    read deck_category_list in deck_meta(deck_id: i64, variant: String, marketplace: Option<String>) = |conn| {
        let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
        list_categories(conn, deck_id, &variant, marketplace)
    };
    read deck_folder_list in deck_meta() = |conn| list_folders(conn);
    read deck_label_all in deck_meta() = |conn| list_all_labels(conn);
    read deck_label_list in deck_meta(deck_id: i64, variant: String) = |conn| {
        list_labels(conn, deck_id, &variant)
    };

    // deck_missing
    read deck_missing_plan in deck_missing(deck_id: i64) = |conn| plan(conn, deck_id);

    // deck_notes
    read card_notes in deck_notes(oracle_id: String) = |conn| notes_for_card(conn, &oracle_id);
    read deck_notes in deck_notes(deck_id: i64) = |conn| list_notes(conn, deck_id);

    // deck_pull
    read deck_pull_plan in deck_pull(deck_id: i64) = |conn| plan(conn, deck_id);

    // deck_query
    read deck_query_cards in deck_query(deck_id: i64, filters: CardFilters) = |conn| {
        query_cards(conn, deck_id, &filters)
    };

    // deck_quick_add
    read deck_quick_add_wishes in deck_quick_add(card_id: String, finish: Option<String>) = |conn| {
        card_wishes(conn, &card_id, finish.as_deref())
    };

    // deck_theory
    read deck_theory_diff in deck_theory(deck_id: i64, marketplace: Option<String>) = |conn| {
        let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
        theory_diff(conn, deck_id, marketplace)
    };
    read deck_theory_slots in deck_theory(deck_id: i64) = |conn| theory_slots(conn, deck_id);

    // deck_todos
    read deck_todo_lists in deck_todos(deck_id: i64) = |conn| lists_for(conn, deck_id);
    read every_deck_todo_list in deck_todos() = |conn| every_list(conn);

    // deck_tokens
    read deck_tokens in deck_tokens(deck_id: i64, variant: String, marketplace: Option<String>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        deck_token_rows(conn, deck_id, &variant, market)
    };
    read token_printings in deck_tokens(marketplace: Option<String>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        list_token_printings(conn, market)
    };

    // deck_undo
    read deck_undo_state in deck_undo(deck_id: i64, redo_id: Option<i64>) = |conn| {
        undo_state(conn, deck_id, redo_id)
    };

    // deckpane
    read deck_folder_pane in deckpane() = |conn| Ok(stored(conn));

    // decksort
    read deck_sort in decksort() = |conn| Ok(stored(conn));

    // errors
    read error_log_list in errors(limit: i64) = |conn| {
        list(conn, limit).map_err(|e| format!("could not read the error log: {e}"))
    };

    // home
    read home_layout in home() = |conn| Ok(stored(conn));

    // import
    read import_resolve in import(lines: Vec<ResolveLine>) = |conn| resolve_lines(conn, &lines);

    // listview
    read list_view in listview() = |conn| Ok(stored(conn));

    // markcolors
    read mark_colors in markcolors() = |conn| Ok(stored(conn));

    // marketplace
    read get_marketplace in marketplace() = |conn| Ok(stored(conn));

    // marketplace_feed
    read marketplace_feed_status in marketplace_feed() = |conn| {
        let now = crate::platform::clock::now_secs();
        Ok(PROVIDERS.iter().map(|p| read_status(conn, *p, now)).collect::<Vec<_>>())
    };

    // nav
    read nav_collapsed in nav() = |conn| Ok(stored(conn));

    // new_printings
    read new_printings in new_printings(scope: String, deck_ids: Vec<i64>, days: i64, langs: Vec<String>, include_virtual: bool, include_theory: bool, include_basics: bool, limit: Option<i64>) = |conn| {
        let ask = Ask { scope, deck_ids, days, langs, include_virtual, include_theory, include_basics, limit, };
        feed(conn, &ask)
    };

    // price_history
    read price_history in price_history(card_id: String, finish: String, marketplace: Option<Marketplace>) = |conn| {
        history(conn, &card_id, &finish, marketplace.unwrap_or_default())
    };
    read price_movers in price_history(window: String, direction: String, marketplace: Option<Marketplace>, limit: i64) = |conn| {
        movers(conn, &window, &direction, marketplace.unwrap_or_default(), limit)
    };

    // recent_cards
    read recent_cards in recent_cards(limit: u32) = |conn| Ok(recent(conn, limit));

    // scanner
    read scanner_prefs in scanner() = |conn| Ok(stored_prefs(conn));
    read scanner_tray in scanner() = |conn| Ok(stored_tray(conn));

    // search
    read list_sets in search() = |conn| run_list_sets(conn);
    read search_cards in search(req: SearchRequest) = |conn| run_search(conn, &req);
    read search_marks in search(req: MarksRequest) = |conn| run_search_marks(conn, &req);

    // searchopen
    read search_open in searchopen() = |conn| Ok(stored(conn));

    // set_completion
    read set_completion in set_completion() = |conn| set_completion_of(conn);

    // shelffolds
    read shelf_folds in shelffolds() = |conn| Ok(stored(conn));

    // stackhide
    read hidden_stacks in stackhide(deck_id: i64) = |conn| Ok(stored(conn, deck_id));

    // startview
    read start_view in startview() = |conn| Ok(stored(conn));

    // sticky_notes
    read sticky_notes in sticky_notes() = |conn| Ok(list_notes(conn).unwrap_or_default());

    // tags::muted
    read tags_muted in tags::muted() = |conn| list(conn);

    // tags::oracle
    read oracle_tags_for_cards in tags::oracle(oracle_ids: Vec<String>) = |conn| {
        read_card_tags(conn, &oracle_ids).map_err(|e| format!("could not read the tags: {e}"))
    };
    read oracle_tags_for_printings in tags::oracle(card_ids: Vec<String>) = |conn| {
        read_printing_tags(conn, &card_ids).map_err(|e| format!("could not read the tags: {e}"))
    };

    // tags::query
    read tag_children in tags::query(namespace: String, slug: Option<String>) = |conn| {
        run_tag_children(conn, &namespace, slug.as_deref())
    };
    read tag_resolve in tags::query(asks: Vec<TagLookup>) = |conn| run_tag_resolve(conn, &asks);
    read tag_search in tags::query(text: String, namespace: String, limit: u32) = |conn| {
        run_tag_search(conn, &text, &namespace, limit)
    };

    // upcoming_sets
    read upcoming_sets in upcoming_sets(days: i64) = |conn| upcoming_sets_for(conn, days);

    // value_history
    read collection_value_history in value_history(split: String, marketplace: Option<Marketplace>) = |conn| {
        history(conn, &split, marketplace.unwrap_or_default())
    };

    // wishlist
    read wishlist_breakdown in wishlist(dimension: String, marketplace: crate::sorting::Marketplace) = |conn| {
        breakdown(conn, &dimension, marketplace)
    };
    read wishlist_list in wishlist(query: WishlistQuery) = |conn| list_wishes(conn, &query);
    read wishlist_shelf_counts in wishlist(query: WishlistQuery) = |conn| {
        shelf_counts(conn, &query)
    };
    read wishlist_summary in wishlist(marketplace: crate::sorting::Marketplace) = |conn| {
        summarise_wishlist(conn, marketplace)
    };

    // wishlist_folders
    read wishlist_folder_list in wishlist_folders() = |conn| list_folders(conn);
    read wishlist_folder_summary in wishlist_folders(marketplace: Option<String>) = |conn| {
        let marketplace = Marketplace::from_opt(marketplace.as_deref());
        folder_summary(conn, marketplace)
    };

    // wishlist_optimize
    read wishlist_optimize_plan in wishlist_optimize(query: WishlistQuery, include_managed: Option<bool>) = |conn| {
        let include_managed = include_managed.unwrap_or(false);
        plan(conn, &query, include_managed)
    };

    // zoom
    read card_zoom in zoom() = |conn| Ok(stored(conn));
}
// END TABLE

/// **The fence, and it is the compiler's** — `sync_engine::client`'s has the reason: a host
/// awaits [`dispatch`] on a runtime that may move it between threads, so it may hold no lock
/// across an `.await`. Never called.
#[allow(dead_code)]
fn nothing_is_held_across_a_call(state: &Arc<State>) {
    fn sendable<T: crate::platform::Sendable>(_: T) {}
    sendable(dispatch(state, "", Value::Null, None));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// What the kinds' own table calls: one `app_meta` row, read and written.
    pub fn meta(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
        Ok(crate::app_meta::get_app_meta(conn, key))
    }

    pub fn set_meta(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
        crate::app_meta::set_app_meta(conn, key, value).map_err(|e| e.to_string())
    }

    /// **One command of every kind**, over a table of its own: the real table holds only reads so
    /// far, and an arm of the macro nothing expands is an arm nothing has compiled.
    mod kinds {
        commands! {
            read meta_read in commands::tests(key: String) = |conn| meta(conn, &key);
            write meta_write in commands::tests(key: String, value: String) = |conn| {
                set_meta(conn, &key, &value)
            };
            owned meta_owned in commands::tests(key: String, value: String) = |conn| {
                set_meta(conn, &key, &value)
            };
            task echo in commands::tests(said_twice: String) = |state| async move {
                let _ = &state;
                Ok(said_twice)
            };
            bytes length in commands::tests(offset: usize) = |state, raw| {
                let _ = &state;
                Ok(raw.len() - offset)
            };
        }
    }

    #[tokio::test]
    async fn every_kind_answers_through_its_own_arm() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-kinds", "http://127.0.0.1:1");
        let call = |name: &'static str, args: Value, body: Option<Vec<u8>>| {
            let state = state.clone();
            async move { kinds::dispatch(&state, name, args, body).await }
        };
        assert_eq!(
            call(
                "meta_write",
                json!({ "key": "probe", "value": "written" }),
                None
            )
            .await,
            Ok(Value::Null)
        );
        assert_eq!(
            call("meta_read", json!({ "key": "probe" }), None).await,
            Ok(json!("written"))
        );
        assert_eq!(
            call(
                "meta_owned",
                json!({ "key": "probe", "value": "owned" }),
                None
            )
            .await,
            Ok(Value::Null)
        );
        assert_eq!(
            call("meta_read", json!({ "key": "probe" }), None).await,
            Ok(json!("owned"))
        );
        // A two-word argument is camelCase on the wire.
        assert_eq!(
            call("echo", json!({ "saidTwice": "hello" }), None).await,
            Ok(json!("hello"))
        );
        assert_eq!(
            call("length", json!({ "offset": 1 }), Some(vec![1, 2, 3])).await,
            Ok(json!(2))
        );
        let names: Vec<_> = kinds::TABLE.iter().map(|e| (e.name, e.kind)).collect();
        assert_eq!(
            names,
            [
                ("meta_read", Kind::Read),
                ("meta_write", Kind::Write),
                ("meta_owned", Kind::Owned),
                ("echo", Kind::Task),
                ("length", Kind::Bytes),
            ]
        );
        assert_eq!(kinds::TABLE[4].args, ["offset"]);
    }

    /// Every way a call can be wrong is a sentence, and none of them is a panic.
    #[tokio::test]
    async fn a_call_the_table_cannot_answer_is_refused_in_words() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-refusals", "http://127.0.0.1:1");
        let refused = |name: &'static str, args: Value, body: Option<Vec<u8>>| {
            let state = state.clone();
            async move { kinds::dispatch(&state, name, args, body).await.unwrap_err() }
        };
        assert_eq!(
            refused("nothing_here", Value::Null, None).await,
            no_such("nothing_here")
        );
        let missing = refused("meta_read", json!({}), None).await;
        assert!(missing.contains("its arguments did not parse"), "{missing}");
        // snake_case is not the wire, so `said_twice` is a missing `saidTwice`.
        let snake = refused("echo", json!({ "said_twice": "hello" }), None).await;
        assert!(snake.contains("saidTwice"), "{snake}");
        let body = refused("meta_read", json!({ "key": "probe" }), Some(vec![1])).await;
        assert!(body.contains("takes no raw body"), "{body}");
        let none = refused("length", json!({ "offset": 0 }), None).await;
        assert!(none.contains("needs a raw body"), "{none}");
    }

    /// **The real table answers what the functions answer**, through the wire's own spelling — a
    /// read with no arguments, one whose arguments are camelCase, and one with an optional
    /// argument left out, which `ipc.ts` does rather than sending `null`.
    #[tokio::test]
    async fn the_reads_answer_what_their_functions_answer() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-reads", "http://127.0.0.1:1");
        let expected_zoom = json!(crate::zoom::stored(&state.lock_db_read()));
        assert_eq!(
            dispatch(&state, "card_zoom", Value::Null, None).await,
            Ok(expected_zoom)
        );
        assert_eq!(
            dispatch(
                &state,
                "deck_audit_list",
                json!({ "deckId": 1, "limit": 5 }),
                None
            )
            .await,
            Ok(json!([]))
        );
        let combos = dispatch(
            &state,
            "combos_for_card",
            json!({ "oracleId": "none", "ownedOnly": false, "limit": 5, "offset": 0 }),
            None,
        )
        .await;
        assert!(combos.is_ok(), "{combos:?}");
    }

    #[test]
    fn no_command_is_declared_twice() {
        let mut names: Vec<_> = TABLE.iter().map(|e| e.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before);
        assert!(
            TABLE.iter().all(|e| e.kind == Kind::Read),
            "only reads are in the table so far"
        );
    }
}
