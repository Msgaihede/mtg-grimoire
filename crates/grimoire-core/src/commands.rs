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
//! **Six kinds, and what each puts the body on** ([`Kind`]):
//!
//! | Kind | The body runs | Bound to |
//! | --- | --- | --- |
//! | `read` | on the blocking pool, holding the read connection ([`State::lock_db_read`]) | `&Connection` |
//! | `write` | on the blocking pool, inside [`crate::state::with_write`] — armed, reconciled, settled, fenced, `db::BUSY` after its bound | `&Connection` |
//! | `owned` | the same, inside [`crate::collection_source::with_write_owned`], which also rebuilds the facet index's `owned` dimension | `&Connection` |
//! | `blocking` | on the blocking pool, holding nothing — for a body that takes the `State` itself, or that decides something before it takes a connection | `Arc<State>` |
//! | `task` | where it stands, awaited — for what reaches a network or the sync lane | `Arc<State>` |
//! | `bytes` | on the blocking pool, with the raw body the call carried — the scanner's frame and capture | `Arc<State>`, `Vec<u8>` |
//!
//! In a browser "the blocking pool" is the caller ([`crate::platform::spawn`]).
//!
//! **The table covers the light app** (phase 4, step 4.2, 2026-10-03): every read, and every write,
//! feed and sync command a light install can answer, so no page of it is refused by an Android or
//! a web host. What is still missing is `src-tauri`'s `command_table::NOT_YET`, each with its
//! reason there — the scanner's commands, `share/`'s, and the two picture warms. **No entry is of
//! kind `bytes` yet**; that arm is proven by this module's own tests, over a table of their own,
//! until the scanner's frame joins.
//!
//! **Every entry also runs on a host with one connection and one thread** — a browser's shape,
//! where a read asked for inside a write is the same mutex twice and work "on the pool" is on
//! the caller. `tests::every_command_answers_on_one_connection_and_one_thread` drives the whole
//! table that way natively ([`crate::platform::alone`]) and fails with the command's name; a
//! new `blocking` or `task` entry owes it a row of arguments (`tests::chosen_args`).
//!
//! **A body is the desktop wrapper's own body**, its connection renamed, so a command answers the
//! same thing on every host. **What a wrapper does beside the core is the desktop's and is left
//! out**, said at the entry: telling the other windows through `AppState.changes` (a light host has
//! one window, and the mask is `AppState`'s), and telling the plain-text mirror (the desktop's for
//! good). An event a wrapper sends through its window is sent through [`State::events`] instead, as
//! the core sends every other. The reads were drafted from the wrappers by
//! `scripts/core-command-table.mjs` and checked by hand; every other entry was written by hand,
//! next to its neighbours, and a new one is too.

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
// A sync command's stretches are `lane.with(…)`, a method of this trait. Anonymous, so a module
// whose glob exports a `Store` of its own (`bulk_undo`'s ticket store) cannot shadow it.
#[allow(unused_imports)]
use crate::state::Store as _;

/// What a command is — which connection it holds, if any, and where its body runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Read,
    Write,
    Owned,
    Blocking,
    Task,
    Bytes,
}

/// One row of [`TABLE`]: a command's name, its kind, and its arguments' names and types as
/// declared — the desktop wrapper's own parameters, which the parity test compares with both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub name: &'static str,
    pub kind: Kind,
    pub args: &'static [&'static str],
    /// Each argument's type as written, beside [`Entry::args`].
    pub types: &'static [&'static str],
}

/// What a call names that the table does not have.
pub fn no_such(name: &str) -> String {
    format!("There is no command named {name} on this host.")
}

/// A command's arguments, read from the call's JSON — `null` and an absent object both read as
/// no arguments, since a call to a command that takes none may send either.
pub(crate) fn parse<T: DeserializeOwned>(name: &str, args: Value) -> Result<T, String> {
    let args = if args.is_null() {
        Value::Object(serde_json::Map::new())
    } else {
        args
    };
    serde_json::from_value(args).map_err(|e| format!("{name}: its arguments did not parse: {e}"))
}

/// A command's answer, as the JSON a host hands back.
pub(crate) fn answer<T: serde::Serialize>(name: &str, answer: T) -> Result<Value, String> {
    serde_json::to_value(answer).map_err(|e| format!("{name}: its answer did not serialize: {e}"))
}

/// Work on the blocking pool that did not come back — a panic in it, natively.
pub(crate) fn lost(name: &str, e: Lost) -> String {
    format!("{name}: the work behind it failed: {e}")
}

/// Every kind but `bytes` refuses a call that carries a body: a host that sent one has called
/// the wrong command, and dropping the bytes would hide that.
pub(crate) fn no_body(name: &str, body: &Option<Vec<u8>>) -> Result<(), String> {
    match body {
        Some(_) => Err(format!("{name} takes no raw body.")),
        None => Ok(()),
    }
}

/// A `bytes` command's body, or the refusal for a call that carried none.
///
/// Only a `bytes` entry calls it, and the real table has none yet — the kinds' own test table is
/// its caller until the scanner's frame joins.
#[allow(dead_code)]
pub(crate) fn needs_body(name: &str, body: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
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
    (blocking) => {
        $crate::commands::Kind::Blocking
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
    (blocking, $state:ident, $name:expr, $raw:ident, [$st:ident], $body:expr) => {{
        $crate::commands::no_body($name, &$raw)?;
        let $st: ::std::sync::Arc<$crate::state::State> = ::std::sync::Arc::clone($state);
        $crate::platform::spawn::blocking(
            move || -> ::std::result::Result<_, ::std::string::String> { $body },
        )
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
                types: &[$(stringify!($ty)),*],
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

    // bulk_undo — a ticket names its table, and the table names the write: a collection undo
    // moves what the reader owns, a wishlist one does not. Asked before any connection.
    blocking bulk_undo in bulk_undo(undo_id: u64) = |state| match with_store(|s| s.table_of(undo_id)) {
        None => Err(UNDO_GONE.to_owned()),
        Some(Table::Collection) => {
            crate::collection_source::with_write_owned(&state, |c| undo(c, undo_id))
        }
        Some(Table::Wishlist) => crate::state::with_write(&state, |c| undo(c, undo_id)),
    };

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
    write set_printing_group_by in card(mode: String) = |conn| store_group_by(conn, &mode);

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
    owned collection_add in collection(entry: EntryInput) = |conn| add_entry(conn, &entry);
    owned collection_set_quantity in collection(id: i64, quantity: i64) = |conn| {
        set_quantity(conn, id, quantity)
    };
    owned collection_update in collection(id: i64, patch: EntryPatch) = |conn| {
        update_entry(conn, id, &patch)
    };
    owned collection_set_printing in collection(id: i64, card_id: String) = |conn| {
        set_entry_printing(conn, id, &card_id)
    };
    owned collection_remove in collection(id: i64) = |conn| remove_entry(conn, id);
    owned collection_import_commit in collection(items: Vec<CollectionImportItem>, mode: String, folder_id: Option<i64>) = |conn| {
        commit_import(conn, &items, &mode, folder_id)
    };
    owned collection_remove_many in collection(ids: Vec<i64>) = |conn| remove_entries(conn, &ids);

    // collection_alloc
    // An owned write, and `blocking` only because the pile is read before the lock is taken, as
    // the wrapper does: a caller bug is not worth waiting on a busy database for.
    blocking collection_to_deck in collection_alloc(entry_id: i64, deck_id: i64, category_id: Option<i64>, category_name: Option<String>, quantity: i64) = |state| {
        let pile = Pile::from_args(category_id, category_name.as_deref())?;
        crate::collection_source::with_write_owned(&state, |c| {
            collection_to_deck(c, entry_id, deck_id, pile, quantity)
        })
    };
    owned deck_to_collection in collection_alloc(deck_card_id: i64, quantity: i64) = |conn| {
        deck_to_collection(conn, deck_card_id, quantity)
    };

    // collection_folders
    read collection_folder_list in collection_folders() = |conn| list_folders(conn);
    read collection_folder_summary in collection_folders(marketplace: Option<String>) = |conn| {
        let marketplace = Marketplace::from_opt(marketplace.as_deref());
        folder_summary(conn, marketplace)
    };
    write collection_folder_create in collection_folders(parent_id: Option<i64>, name: String) = |conn| {
        create_folder(conn, parent_id, &name)
    };
    write collection_folder_rename in collection_folders(id: i64, name: String) = |conn| {
        rename_folder(conn, id, &name)
    };
    write collection_folder_set_locked in collection_folders(id: i64, locked: bool) = |conn| {
        set_folder_locked(conn, id, locked)
    };
    write collection_folder_move in collection_folders(id: i64, parent_id: Option<i64>) = |conn| {
        move_folder(conn, id, parent_id)
    };
    write collection_folder_reorder in collection_folders(parent_id: Option<i64>, ids: Vec<i64>) = |conn| {
        reorder_folders(conn, parent_id, &ids)
    };
    write collection_folder_delete in collection_folders(id: i64) = |conn| delete_folder(conn, id);
    owned collection_removed_clear in collection_folders() = |conn| clear_removed(conn);
    owned collection_set_folder in collection_folders(id: i64, folder_id: Option<i64>) = |conn| {
        set_entry_folder(conn, id, folder_id)
    };
    owned collection_set_folder_many in collection_folders(ids: Vec<i64>, folder_id: Option<i64>) = |conn| {
        set_entries_folder(conn, &ids, folder_id)
    };

    // combos
    read combos_for_card in combos(oracle_id: String, search: Option<String>, card_count: Option<i64>, owned_only: bool, limit: i64, offset: i64) = |conn| {
        card_combos(conn, &oracle_id, search.as_deref(), card_count, owned_only, limit, offset)
    };
    read combos_for_cards in combos(card_ids: Vec<String>) = |conn| match_combos(conn, &card_ids);
    blocking combos_status in combos() = |state| Ok(status_of(&state));
    task combos_refresh in combos(force: bool) = |state| async move {
        refresh(&state, force, &mut |phase, done, total| emit(&state, phase, done, total)).await
    };
    // Not `with_write`, as the wrapper's is not: the clear takes the connection itself.
    blocking combos_clear in combos() = |state| {
        let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
            return Err(crate::db::BUSY.to_owned());
        };
        clear(&conn)
    };

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
    // Every deck write is plain `write`, as its wrapper is — the clears and the delete re-file
    // copies between folders, and the facet index's `owned` dimension names no folder.
    write deck_create in deck(deck: DeckInput) = |conn| create_deck(conn, &deck);
    write deck_update in deck(id: i64, patch: DeckPatch) = |conn| update_deck(conn, id, &patch);
    write deck_delete in deck(id: i64) = |conn| delete_deck(conn, id);
    write deck_duplicate in deck(id: i64) = |conn| duplicate_deck(conn, id);
    write deck_set_folder in deck(deck_id: i64, folder_id: Option<i64>) = |conn| {
        set_folder(conn, deck_id, folder_id)
    };
    write deck_set_view_state in deck(deck_id: i64, view_state: DeckViewState) = |conn| {
        set_view_state(conn, deck_id, &view_state)
    };
    write deck_missing_to_wishlist in deck(deck_id: i64, folder_id: Option<i64>) = |conn| {
        missing_to_wishlist(conn, deck_id, folder_id)
    };
    write deck_add_card in deck(deck_id: i64, card_id: String, category_id: Option<i64>, category_name: Option<String>, variant: String, finish: Option<String>, quantity: i64) = |conn| {
        add_card(
            conn,
            deck_id,
            &card_id,
            category_id,
            category_name.as_deref(),
            &variant,
            finish.as_deref(),
            quantity,
        )
    };
    write deck_add_card_to_other_list in deck(deck_id: i64, card_id: String, from_category_id: i64, variant: String, finish: Option<String>, quantity: i64) = |conn| {
        add_card_to_other_list(
            conn,
            deck_id,
            &card_id,
            from_category_id,
            &variant,
            finish.as_deref(),
            quantity,
        )
    };
    write deck_set_card_quantity in deck(deck_id: i64, card_id: String, category_id: i64, variant: String, finish: Option<String>, quantity: i64) = |conn| {
        set_card_quantity(
            conn,
            deck_id,
            &card_id,
            category_id,
            &variant,
            finish.as_deref(),
            quantity,
        )
    };
    write deck_category_clear in deck(deck_id: i64, category_id: i64, variant: String) = |conn| {
        clear_category(conn, deck_id, category_id, &variant)
    };
    write deck_clear in deck(deck_id: i64, variant: String) = |conn| {
        clear_variant(conn, deck_id, &variant)
    };
    write deck_move_card in deck(deck_id: i64, card_id: String, from_category_id: i64, to_category_id: Option<i64>, to_category_name: Option<String>, variant: String, finish: Option<String>) = |conn| {
        move_card(
            conn,
            deck_id,
            &card_id,
            from_category_id,
            to_category_id,
            to_category_name.as_deref(),
            &variant,
            finish.as_deref(),
        )
    };
    write deck_swap_printing in deck(deck_id: i64, from_card_id: String, to_card_id: String, category_id: i64, variant: String, finish: Option<String>) = |conn| {
        swap_printing(
            conn,
            deck_id,
            &from_card_id,
            &to_card_id,
            category_id,
            &variant,
            finish.as_deref(),
        )
    };
    write deck_set_card_finish in deck(deck_id: i64, card_id: String, category_id: i64, variant: String, from_finish: Option<String>, to_finish: Option<String>) = |conn| {
        set_card_finish(
            conn,
            deck_id,
            &card_id,
            category_id,
            &variant,
            from_finish.as_deref(),
            to_finish.as_deref(),
        )
    };

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
    write deck_category_create in deck_meta(deck_id: i64, variant: String, name: String) = |conn| {
        create_category(conn, deck_id, &variant, &name)
    };
    write deck_category_rename in deck_meta(id: i64, name: String) = |conn| {
        rename_category(conn, id, &name)
    };
    write deck_category_set_active in deck_meta(id: i64, is_active: bool) = |conn| {
        set_category_active(conn, id, is_active)
    };
    write deck_category_reorder in deck_meta(deck_id: i64, ids: Vec<i64>) = |conn| {
        reorder_categories(conn, deck_id, &ids)
    };
    write deck_category_delete in deck_meta(id: i64, move_to_category_id: Option<i64>) = |conn| {
        delete_category(conn, id, move_to_category_id)
    };
    write deck_label_create in deck_meta(deck_id: Option<i64>, name: String, color: String) = |conn| {
        create_label(conn, deck_id, &name, &color)
    };
    write deck_label_update in deck_meta(deck_id: Option<i64>, id: i64, name: String, color: String) = |conn| {
        update_label(conn, deck_id, id, &name, &color)
    };
    write deck_label_delete in deck_meta(deck_id: Option<i64>, id: i64) = |conn| {
        delete_label(conn, deck_id, id)
    };
    write deck_label_remove_from_deck in deck_meta(deck_id: i64, label_id: i64, variant: String) = |conn| {
        remove_label_from_deck(conn, deck_id, label_id, &variant)
    };
    write deck_card_set_label in deck_meta(deck_id: i64, card_id: String, category_id: i64, variant: String, finish: Option<String>, label_id: Option<i64>) = |conn| {
        set_card_label(
            conn,
            deck_id,
            &card_id,
            category_id,
            &variant,
            finish.as_deref(),
            label_id,
        )
    };
    write deck_folder_create in deck_meta(parent_id: Option<i64>, name: String) = |conn| {
        create_folder(conn, parent_id, &name)
    };
    write deck_folder_rename in deck_meta(id: i64, name: String) = |conn| {
        rename_folder(conn, id, &name)
    };
    write deck_folder_move in deck_meta(id: i64, parent_id: Option<i64>) = |conn| {
        move_folder(conn, id, parent_id)
    };
    write deck_folder_reorder in deck_meta(parent_id: Option<i64>, ids: Vec<i64>) = |conn| {
        reorder_folders(conn, parent_id, &ids)
    };
    write deck_folder_delete in deck_meta(id: i64) = |conn| delete_folder(conn, id);

    // deck_missing
    read deck_missing_plan in deck_missing(deck_id: i64) = |conn| plan(conn, deck_id);
    owned deck_missing_to_collection in deck_missing(deck_id: i64, picks: Vec<MissingPick>, clear_wishes: bool) = |conn| {
        to_collection(conn, deck_id, &picks, clear_wishes)
    };

    // deck_notes
    read card_notes in deck_notes(oracle_id: String) = |conn| notes_for_card(conn, &oracle_id);
    read deck_notes in deck_notes(deck_id: i64) = |conn| list_notes(conn, deck_id);
    write deck_note_create in deck_notes(deck_id: i64, title: String, body: String, oracle_ids: Vec<String>) = |conn| {
        create_note(conn, deck_id, &title, &body, &oracle_ids)
    };
    write deck_note_update in deck_notes(deck_id: i64, id: i64, title: Option<String>, body: Option<String>) = |conn| {
        update_note(conn, deck_id, id, title.as_deref(), body.as_deref())
    };
    write deck_note_delete in deck_notes(deck_id: i64, id: i64) = |conn| {
        delete_note(conn, deck_id, id)
    };
    write deck_note_attach in deck_notes(deck_id: i64, note_id: i64, oracle_id: String) = |conn| {
        attach_card(conn, deck_id, note_id, &oracle_id)
    };
    write deck_note_detach in deck_notes(deck_id: i64, note_id: i64, oracle_id: String) = |conn| {
        detach_card(conn, deck_id, note_id, &oracle_id)
    };
    write deck_note_reorder in deck_notes(deck_id: i64, ids: Vec<i64>) = |conn| {
        reorder_notes(conn, deck_id, &ids)
    };

    // deck_pull
    read deck_pull_plan in deck_pull(deck_id: i64) = |conn| plan(conn, deck_id);
    owned deck_pull_from_collection in deck_pull(deck_id: i64, picks: Vec<Pick>) = |conn| {
        from_collection(conn, deck_id, &picks)
    };

    // deck_query
    read deck_query_cards in deck_query(deck_id: i64, filters: CardFilters) = |conn| {
        query_cards(conn, deck_id, &filters)
    };

    // deck_quick_add
    read deck_quick_add_wishes in deck_quick_add(card_id: String, finish: Option<String>) = |conn| {
        card_wishes(conn, &card_id, finish.as_deref())
    };
    owned deck_quick_add_to_collection in deck_quick_add(deck_id: i64, card_id: String, finish: Option<String>, condition: Option<String>, quantity: i64, wish_id: Option<i64>) = |conn| {
        quick_add(
            conn,
            deck_id,
            &card_id,
            finish.as_deref(),
            condition.as_deref(),
            quantity,
            wish_id,
        )
    };

    // deck_theory
    read deck_theory_diff in deck_theory(deck_id: i64, marketplace: Option<String>) = |conn| {
        let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
        theory_diff(conn, deck_id, marketplace)
    };
    read deck_theory_slots in deck_theory(deck_id: i64) = |conn| theory_slots(conn, deck_id);
    write deck_theory_missing_to_wishlist in deck_theory(deck_id: i64, only: Option<Vec<String>>, folder_id: Option<i64>) = |conn| {
        missing_to_wishlist(conn, deck_id, only.as_deref(), folder_id)
    };

    // deck_todos
    read deck_todo_lists in deck_todos(deck_id: i64) = |conn| lists_for(conn, deck_id);
    read every_deck_todo_list in deck_todos() = |conn| every_list(conn);
    write deck_todo_list_create in deck_todos(deck_id: i64, title: String, body: String) = |conn| {
        create_list(conn, deck_id, &title, &body)
    };
    write deck_todo_list_update in deck_todos(deck_id: i64, id: i64, title: Option<String>, body: Option<String>, expected: Option<String>) = |conn| {
        update_list(
            conn,
            deck_id,
            id,
            title.as_deref(),
            body.as_deref(),
            expected.as_deref(),
        )
    };
    write deck_todo_list_delete in deck_todos(deck_id: i64, id: i64) = |conn| {
        delete_list(conn, deck_id, id)
    };

    // deck_tokens
    read deck_tokens in deck_tokens(deck_id: i64, variant: String, marketplace: Option<String>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        deck_token_rows(conn, deck_id, &variant, market)
    };
    read token_printings in deck_tokens(marketplace: Option<String>) = |conn| {
        let market = Marketplace::from_opt(marketplace.as_deref());
        list_token_printings(conn, market)
    };
    write deck_token_set_quantity in deck_tokens(deck_id: i64, variant: String, oracle_id: String, entry: Option<TokenEntryKey>, quantity: i64) = |conn| {
        set_quantity(conn, deck_id, &variant, &oracle_id, entry.as_ref(), quantity)
    };
    write deck_token_swap in deck_tokens(deck_id: i64, variant: String, oracle_id: String, from: Option<TokenEntryKey>, to: TokenEntryKey) = |conn| {
        swap(conn, deck_id, &variant, &oracle_id, from.as_ref(), &to)
    };
    write deck_token_add_printing in deck_tokens(deck_id: i64, variant: String, card_id: String, finish: Option<String>) = |conn| {
        add_printing(conn, deck_id, &variant, &card_id, finish.as_deref()).map(|_| ())
    };
    write deck_token_remove in deck_tokens(deck_id: i64, variant: String, oracle_id: String, entry: TokenEntryKey) = |conn| {
        remove_entry(conn, deck_id, &variant, &oracle_id, &entry)
    };

    // deck_undo
    read deck_undo_state in deck_undo(deck_id: i64, redo_id: Option<i64>) = |conn| {
        undo_state(conn, deck_id, redo_id)
    };
    write deck_undo_apply in deck_undo(deck_id: i64, audit_id: i64) = |conn| {
        apply_reversal(conn, deck_id, audit_id, true)
    };
    write deck_redo_apply in deck_undo(deck_id: i64, audit_id: i64) = |conn| {
        apply_reversal(conn, deck_id, audit_id, false)
    };

    // deckpane
    read deck_folder_pane in deckpane() = |conn| Ok(stored(conn));
    write set_deck_folder_pane in deckpane(width: u32, collapsed: bool) = |conn| {
        store(conn, width, collapsed)
    };

    // decksort
    read deck_sort in decksort() = |conn| Ok(stored(conn));
    write set_deck_sort in decksort(sort: String) = |conn| store(conn, &sort);

    // errors
    read error_log_list in errors(limit: i64) = |conn| {
        list(conn, limit).map_err(|e| format!("could not read the error log: {e}"))
    };
    // The desktop's wrapper then marks `error_log` in `AppState.changes` by hand — a bare
    // `DELETE` the update hook never hears — so its other windows refetch. That mask is the
    // desktop's, for its windows; a light host has one, and the page that pressed refetches.
    write error_log_clear in errors() = |conn| {
        clear(conn).map_err(|e| format!("could not clear the error log: {e}"))
    };

    // home
    read home_layout in home() = |conn| Ok(stored(conn));
    write set_home_layout in home(layout: HomeLayout) = |conn| store(conn, &layout);

    // images: `prefetch_images` and `prewarm_collection` are not here — `command_table::NOT_YET`
    // **The one entry with no desktop wrapper** (`command_table::TABLE_ONLY`): where a card's
    // picture is, for a host whose page fetches pictures itself. `path` is the path the
    // desktop's `mtgimg://` handler is asked — `/<variant>/<card_id>/<face>` — and the answer
    // is `images::ImageSource`: an address, a placeholder, or `unknown`. It reads `cards` and
    // nothing else; the fetch and the keeping are the host's.
    read card_image_source in images(path: String) = |conn| image_source(conn, &path);

    // import
    read import_resolve in import(lines: Vec<ResolveLine>) = |conn| resolve_lines(conn, &lines);
    // Plain `write`, as the wrapper's: a `live` replace re-files copies between folders, and the
    // facet index's `owned` dimension names no folder.
    write deck_import_commit in import(deck_id: i64, variant: String, mode: String, items: Vec<ImportItem>) = |conn| {
        commit_import(conn, deck_id, &variant, &mode, &items)
    };

    // index::facets
    blocking facet_cards in index::facets(req: crate::search::SearchRequest) = |state| {
        run_facets(&state, &req)
    };

    // listview
    read list_view in listview() = |conn| Ok(stored(conn));
    write set_list_view in listview(section: String, view: String) = |conn| {
        store(conn, &section, &view)
    };

    // markcolors
    read mark_colors in markcolors() = |conn| Ok(stored(conn));
    write set_mark_color in markcolors(mark: String, color: Option<String>) = |conn| {
        store(conn, &mark, color.as_deref())
    };

    // marketplace
    read get_marketplace in marketplace() = |conn| Ok(stored(conn));
    // The desktop's wrapper is `set_marketplace_now`, which then tells the plain-text mirror
    // (`mirror.mark_all()`), because every mirrored price changes with the marketplace. The
    // mirror is the desktop's, so the store is the whole of this entry.
    write set_marketplace in marketplace(id: String) = |conn| store(conn, &id);

    // marketplace_feed
    read marketplace_feed_status in marketplace_feed() = |conn| {
        let now = crate::platform::clock::now_secs();
        Ok(PROVIDERS.iter().map(|p| read_status(conn, *p, now)).collect::<Vec<_>>())
    };
    task marketplace_feed_refresh in marketplace_feed(marketplace: String) = |state| async move {
        refresh(&state, &marketplace, &mut |phase, done, total| {
            emit(&state, &marketplace, phase, done, total)
        })
        .await
    };

    // nav
    read nav_collapsed in nav() = |conn| Ok(stored(conn));
    write set_nav_collapsed in nav(collapsed: bool) = |conn| store(conn, collapsed);

    // new_printings
    read new_printings in new_printings(scope: String, deck_ids: Vec<i64>, days: i64, langs: Vec<String>, include_virtual: bool, include_theory: bool, include_basics: bool, limit: Option<i64>) = |conn| {
        let ask = Ask { scope, deck_ids, days, langs, include_virtual, include_theory, include_basics, limit, };
        feed(conn, &ask)
    };
    write mark_new_printings_seen in new_printings(at: i64) = |conn| mark_seen(conn, at);

    // price_history
    read price_history in price_history(card_id: String, finish: String, marketplace: Option<Marketplace>) = |conn| {
        history(conn, &card_id, &finish, marketplace.unwrap_or_default())
    };
    read price_movers in price_history(window: String, direction: String, marketplace: Option<Marketplace>, limit: i64) = |conn| {
        movers(conn, &window, &direction, marketplace.unwrap_or_default(), limit)
    };

    // recent_cards
    read recent_cards in recent_cards(limit: u32) = |conn| Ok(recent(conn, limit));
    write record_recent_card in recent_cards(card_id: String) = |conn| record_now(conn, &card_id);

    // reset
    // `owned`, as the wrapper's: the facet index's `owned` bitset is the collection's, so a wipe
    // moves it.
    owned collection_clear in reset() = |conn| clear_collection(conn);
    write wishlist_clear in reset() = |conn| clear_wishlist(conn);
    write decks_clear in reset() = |conn| clear_decks(conn);
    // The refusal is asked before anything is touched, the files are swept through
    // `platform::files` (which refuses in a browser, so a web host's clear forgets the rows and
    // counts every file it could not reach), and the rows are forgotten through `with_write`.
    blocking cache_clear in reset() = |state| {
        if let Some(refusal) =
            cache_clear_refusal(state.syncing.load(std::sync::atomic::Ordering::Relaxed))
        {
            return Err(refusal.to_owned());
        }
        let images = state.images.dir().to_path_buf();
        let tmp = state.data_dir.join("tmp");
        clear_cache(
            || crate::state::with_write(&state, forget_image_rows),
            &images,
            &tmp,
            &state.images,
        )
    };

    // scanner — the reads only: every other scanner command is on `command_table::NOT_YET`
    read scanner_prefs in scanner() = |conn| Ok(stored_prefs(conn));
    read scanner_tray in scanner() = |conn| Ok(stored_tray(conn));

    // search
    read list_sets in search() = |conn| run_list_sets(conn);
    read search_cards in search(req: SearchRequest) = |conn| run_search(conn, &req);
    read search_marks in search(req: MarksRequest) = |conn| run_search_marks(conn, &req);

    // searchopen
    read search_open in searchopen() = |conn| Ok(stored(conn));
    write set_search_open in searchopen(section: String, open: bool) = |conn| {
        store(conn, &section, open)
    };

    // set_completion
    read set_completion in set_completion() = |conn| set_completion_of(conn);

    // shelffolds
    read shelf_folds in shelffolds() = |conn| Ok(stored(conn));
    write set_shelf_folds in shelffolds(page: String, changes: std::collections::HashMap<String, Option<bool>>) = |conn| {
        store(conn, &page, &changes)
    };

    // stackhide
    read hidden_stacks in stackhide(deck_id: i64) = |conn| Ok(stored(conn, deck_id));
    write set_stack_hidden in stackhide(deck_id: i64, category_id: i64, hidden: bool) = |conn| {
        store(conn, deck_id, category_id, hidden)
    };

    // startview
    read start_view in startview() = |conn| Ok(stored(conn));
    write set_start_view in startview(view: String) = |conn| store(conn, &view);

    // sticky_notes
    read sticky_notes in sticky_notes() = |conn| Ok(list_notes(conn).unwrap_or_default());
    write sticky_note_create in sticky_notes(title: String, body: String, color: String) = |conn| {
        create_note(conn, &title, &body, &color)
    };
    write sticky_note_update in sticky_notes(id: i64, title: Option<String>, body: Option<String>, color: Option<String>, pinned: Option<bool>) = |conn| {
        update_note(conn, id, title, body, color, pinned)
    };
    write sticky_note_delete in sticky_notes(id: i64) = |conn| delete_note(conn, id);
    write sticky_note_reorder in sticky_notes(ids: Vec<i64>) = |conn| reorder_notes(conn, &ids);

    // sync — the card sync's two, whose wrappers are in `desktop.rs`
    task sync_run in sync(force: bool) = |state| async move { run_sync(state, force).await };
    blocking sync_status in sync() = |state| Ok(status(&state));

    // sync_engine::commands — the relay. A press takes the lane as the desktop's does; what the
    // desktop runs it on (`sync::on_a_worker`, a thread of its own) is the host's, so here it is
    // awaited where it stands, like every `task`.
    write sync_relay_status in sync_engine::commands() = |conn| read_status(conn);
    write sync_supporter_status in sync_engine::commands() = |conn| Ok(supporter_status(conn));
    write sync_patreon_begin in sync_engine::commands() = |conn| begin_authorize(conn);
    // The desktop's wrapper then marks `sync_state` in `AppState.changes`, for its other windows'
    // Sync panels — the desktop's mask, left out here as `error_log_clear`'s is.
    task sync_patreon_claim in sync_engine::commands(code: String) = |state| async move {
        let lane = state.lane_for_press().await?;
        lane.with(ensure_group)?;
        crate::sync_engine::entitlement::claim(&lane, &code).await?;
        lane.with(|conn| Ok(supporter_status(conn)))
    };
    // `sync:applied` is what tells a page a pull changed its rows. The desktop's wrapper emits it
    // through its window once the lane is let go; here it goes through the state's sink, as the
    // core's every other event does.
    task sync_now in sync_engine::commands() = |state| async move {
        let outcome = {
            let lane = state.lane_for_press().await?;
            crate::sync_engine::client::run_once(&lane).await?
        };
        if let Some(o) = outcome {
            if o.changed || o.pushed > 0 {
                crate::events::emit(&*state.events, "sync:applied", &o);
            }
        }
        Ok(outcome)
    };
    // What the relay socket is doing, for a page that mounts after the last `sync:live` — the
    // event is only sent on a change. A `task` because it asks nothing of the database: it reads
    // the one value the connection manager keeps, and answers `off` on a host that runs none.
    task sync_live_state in sync_engine::live() = |_state| async move { Ok(current()) };
    write sync_review_list in sync_engine::commands() = |conn| read_review(conn);
    // `blocking` because the table name is checked against the census before any connection is
    // taken, as the wrapper does — it arrives from the page and is spliced into the SQL.
    blocking sync_review_clear in sync_engine::commands(table: String, uid: String) = |state| {
        if !REVIEWABLE.iter().any(|(t, _)| *t == table) {
            return Err("That is not a table with anything to review.".to_owned());
        }
        crate::state::with_write(&state, |conn| {
            conn.execute(
                &format!("UPDATE {table} SET needs_review = NULL WHERE sync_uid = ?1"),
                [&uid],
            )
            .map_err(|e| e.to_string())?;
            read_review(conn)
        })
    };

    // sync_pair — pairing. The offer is taken before the lane, never after.
    write sync_pairing_status in sync_pair::pairing() = |conn| status(conn);
    task sync_pairing_begin in sync_pair::pairing() = |state| async move {
        let mut pending = state.pairing.lock().await;
        crate::state::with_write(&state, |conn| begin(conn, &mut pending))
    };
    task sync_pairing_accept in sync_pair::pairing(code: String) = |state| async move {
        let mut pending = state.pairing.lock().await;
        let lane = state.lane_for_press().await?;
        accept(&lane, &mut pending, &code).await
    };
    task sync_pairing_confirm in sync_pair::pairing() = |state| async move {
        let mut pending = state.pairing.lock().await;
        let lane = state.lane_for_press().await?;
        confirm(&lane, &mut pending).await
    };
    task sync_pairing_poll in sync_pair::pairing() = |state| async move {
        let now = crate::platform::clock::now_ms();
        let mut pending = state.pairing.lock().await;
        let lane = state.lane_for_press().await?;
        poll(&lane, &mut pending, now).await
    };
    task sync_pairing_cancel in sync_pair::pairing() = |state| async move {
        cancel(&mut *state.pairing.lock().await);
        Ok(())
    };
    // The desktop's wrapper then marks `sync_devices` and `device_names` in `AppState.changes` —
    // both `WITHOUT ROWID`, which the update hook never hears — for its other windows.
    write sync_device_rename in sync_pair::identity(device_id: String, name: String) = |conn| {
        rename_device(conn, &device_id, &name).map_err(|e| e.to_string())
    };
    task sync_device_revoke in sync_pair::pairing(device_id: String) = |state| async move {
        let lane = state.lane_for_press().await?;
        remove_device(&lane, &device_id).await
    };
    // The desktop's wrapper then marks `sync_devices`, `sync_group` and `sync_state` in
    // `AppState.changes`, whatever the answer, for its other windows.
    task sync_group_leave in sync_pair::pairing() = |state| async move { leave(&state).await };

    // tags::art
    task art_tags_refresh in tags::art(force: bool) = |state| async move {
        crate::tags::refresh(&ART, &state, force, &mut |phase, done, total| {
            crate::tags::emit(&ART, &state, phase, done, total)
        })
        .await
    };
    blocking art_tags_status in tags::art() = |state| Ok(crate::tags::status_of(&ART, &state));

    // tags::muted
    read tags_muted in tags::muted() = |conn| list(conn);
    // The desktop's wrapper then marks `muted_tags` (`WITHOUT ROWID`) in `AppState.changes`, for
    // its other windows; so does `tag_unmute`'s.
    write tag_mute in tags::muted(namespace: String, tag_id: String, slug: String) = |conn| {
        mute(conn, &namespace, &tag_id, &slug, crate::platform::clock::now_secs())
    };
    write tag_unmute in tags::muted(namespace: String, tag_id: String) = |conn| {
        unmute(conn, &namespace, &tag_id)
    };

    // tags::oracle
    read oracle_tags_for_cards in tags::oracle(oracle_ids: Vec<String>) = |conn| {
        read_card_tags(conn, &oracle_ids).map_err(|e| format!("could not read the tags: {e}"))
    };
    read oracle_tags_for_printings in tags::oracle(card_ids: Vec<String>) = |conn| {
        read_printing_tags(conn, &card_ids).map_err(|e| format!("could not read the tags: {e}"))
    };
    task oracle_tags_refresh in tags::oracle(force: bool) = |state| async move {
        crate::tags::refresh(&ORACLE, &state, force, &mut |phase, done, total| {
            crate::tags::emit(&ORACLE, &state, phase, done, total)
        })
        .await
    };
    blocking oracle_tags_status in tags::oracle() = |state| {
        Ok(crate::tags::status_of(&ORACLE, &state))
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
    write wishlist_add in wishlist(wish: WishInput) = |conn| add_wish(conn, &wish);
    write wishlist_set_quantity in wishlist(id: i64, quantity: i64) = |conn| {
        set_wish_quantity(conn, id, quantity)
    };
    write wishlist_remove in wishlist(id: i64) = |conn| remove_wish(conn, id);
    write wishlist_set_printing in wishlist(id: i64, card_id: Option<String>) = |conn| {
        set_wish_printing(conn, id, card_id)
    };
    write wishlist_import_commit in wishlist(items: Vec<WishlistImportItem>, mode: String) = |conn| {
        commit_import(conn, &items, &mode)
    };

    // wishlist_folders
    read wishlist_folder_list in wishlist_folders() = |conn| list_folders(conn);
    read wishlist_folder_summary in wishlist_folders(marketplace: Option<String>) = |conn| {
        let marketplace = Marketplace::from_opt(marketplace.as_deref());
        folder_summary(conn, marketplace)
    };
    write wishlist_folder_create in wishlist_folders(parent_id: Option<i64>, name: String) = |conn| {
        create_folder(conn, parent_id, &name)
    };
    write wishlist_folder_rename in wishlist_folders(id: i64, name: String) = |conn| {
        rename_folder(conn, id, &name)
    };
    write wishlist_folder_move in wishlist_folders(id: i64, parent_id: Option<i64>) = |conn| {
        move_folder(conn, id, parent_id)
    };
    write wishlist_folder_reorder in wishlist_folders(parent_id: Option<i64>, ids: Vec<i64>) = |conn| {
        reorder_folders(conn, parent_id, &ids)
    };
    write wishlist_folder_delete in wishlist_folders(id: i64) = |conn| delete_folder(conn, id);
    write wishlist_folder_clear in wishlist_folders(id: i64) = |conn| clear_folder(conn, id);
    write wishlist_folder_delete_with_wishes in wishlist_folders(id: i64) = |conn| {
        delete_folder_and_wishes(conn, id)
    };
    write wishlist_set_folder in wishlist_folders(id: i64, folder_id: Option<i64>) = |conn| {
        set_wish_folder(conn, id, folder_id)
    };

    // wishlist_optimize
    read wishlist_optimize_plan in wishlist_optimize(query: WishlistQuery, include_managed: Option<bool>) = |conn| {
        let include_managed = include_managed.unwrap_or(false);
        plan(conn, &query, include_managed)
    };
    write wishlist_optimize_apply in wishlist_optimize(items: Vec<WishOptimizeApplyItem>) = |conn| {
        apply(conn, &items)
    };

    // zoom
    read card_zoom in zoom() = |conn| Ok(stored(conn));
    write set_card_zoom in zoom(section: String, zoom: f64) = |conn| store(conn, &section, zoom);
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

    /// **One command of every kind**, over a table of its own: the real table has no `bytes`
    /// entry yet, an arm of the macro nothing expands is an arm nothing has compiled, and the two
    /// writes are told apart here over one key.
    mod kinds {
        commands! {
            read meta_read in commands::tests(key: String) = |conn| meta(conn, &key);
            write meta_write in commands::tests(key: String, value: String) = |conn| {
                set_meta(conn, &key, &value)
            };
            owned meta_owned in commands::tests(key: String, value: String) = |conn| {
                set_meta(conn, &key, &value)
            };
            blocking meta_twice in commands::tests(key: String) = |state| {
                let first = meta(&state.lock_db_read(), &key)?;
                crate::state::with_write(&state, |c| set_meta(c, &key, "twice"))?;
                Ok((first, meta(&state.lock_db_read(), &key)?))
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

    /// **The same fence over the kinds' own table** — the real table's `dispatch` expands every
    /// arm but `bytes`, so a lock held across an `.await` in that arm would go unseen there.
    #[allow(dead_code)]
    fn every_kind_holds_nothing_across_a_call(state: &Arc<State>) {
        fn sendable<T: crate::platform::Sendable>(_: T) {}
        sendable(kinds::dispatch(state, "", Value::Null, None));
    }

    #[tokio::test]
    async fn every_kind_answers_through_its_own_arm() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-kinds", "http://127.0.0.1:1");
        let call = |name: &'static str, args: Value, body: Option<Vec<u8>>| {
            let state = state.clone();
            async move { kinds::dispatch(&state, name, args, body).await }
        };
        // A warm facet index, so `owned` and `write` can be told apart: the one thing an owned
        // write does that a plain one does not is publish the index again with its `owned`
        // dimension re-read.
        crate::index::lifecycle::build_now(&state).expect("an index over the fixture");
        let index = || crate::index::lifecycle::current(&state).expect("a warm index");
        let built = index();
        assert_eq!(
            call(
                "meta_write",
                json!({ "key": "probe", "value": "written" }),
                None
            )
            .await,
            Ok(Value::Null)
        );
        assert!(
            Arc::ptr_eq(&built, &index()),
            "a plain write left the index alone"
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
        assert!(
            !Arc::ptr_eq(&built, &index()),
            "an owned write publishes the index again"
        );
        assert_eq!(
            call("meta_read", json!({ "key": "probe" }), None).await,
            Ok(json!("owned"))
        );
        // A `blocking` body holds no connection, so it may take either, and in turn.
        assert_eq!(
            call("meta_twice", json!({ "key": "probe" }), None).await,
            Ok(json!(["owned", "twice"]))
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
                ("meta_twice", Kind::Blocking),
                ("echo", Kind::Task),
                ("length", Kind::Bytes),
            ]
        );
        assert_eq!(kinds::TABLE[5].args, ["offset"]);
        assert_eq!(kinds::TABLE[5].types, ["usize"]);
    }

    /// **A read holds the read connection and never the writer's**: answered while another
    /// thread holds the write connection, where a read arm that took the writer's would wait for
    /// it — and in a browser, with one connection, that is the same mutex anyway.
    #[tokio::test]
    async fn a_read_answers_while_the_write_connection_is_held() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-reader", "http://127.0.0.1:1");
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let holder = {
            let state = state.clone();
            std::thread::spawn(move || {
                let _writer = state.lock_db();
                held_tx.send(()).expect("the test is listening");
                let _ = done_rx.recv();
            })
        };
        held_rx.recv().expect("the writer is held");
        let answer = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            kinds::dispatch(&state, "meta_read", json!({ "key": "probe" }), None),
        )
        .await;
        done_tx.send(()).expect("the holder is waiting");
        holder.join().expect("the holder let go");
        assert_eq!(
            answer.expect("the read waited for the write connection"),
            Ok(Value::Null)
        );
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

    /// **The real table answers what the functions answer**, through the wire's own spelling —
    /// over rows that tell a wrong answer from a right one. Three decks, the third with four
    /// history rows: asked for the third deck's two newest, an entry that swapped its two
    /// integers would answer the second deck's one row, and one that dropped the limit all four.
    /// A read with no arguments, and one with its optional argument left out, as `ipc.ts` leaves
    /// one out rather than sending `null`.
    #[tokio::test]
    async fn the_reads_answer_what_their_functions_answer() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-reads", "http://127.0.0.1:1");
        let third = {
            let conn = state.lock_db();
            let deck = |name: &str| {
                crate::deck::create_deck(
                    &conn,
                    &crate::deck::DeckInput {
                        name: name.into(),
                        ..Default::default()
                    },
                )
                .expect("a deck")
                .id
            };
            let ids = [deck("First"), deck("Second"), deck("Third")];
            for n in 0..3 {
                crate::deck_audit::record(
                    &conn,
                    ids[2],
                    "live",
                    "deck",
                    None,
                    &json!({ "field": "probe", "n": n }),
                    0,
                )
                .expect("a history row");
            }
            ids[2]
        };
        assert_ne!(third, 2, "the swap below has to land on a different deck");

        let expected = json!(crate::deck_audit::list(&state.lock_db_read(), third, 2).unwrap());
        assert_eq!(expected.as_array().map(Vec::len), Some(2));
        assert_eq!(
            dispatch(
                &state,
                "deck_audit_list",
                json!({ "deckId": third, "limit": 2 }),
                None
            )
            .await,
            Ok(expected)
        );

        let expected = json!(crate::deck::get_deck(
            &state.lock_db_read(),
            third,
            "live",
            crate::sorting::Marketplace::from_opt(None),
        )
        .unwrap());
        assert_eq!(
            dispatch(
                &state,
                "deck_get",
                json!({ "id": third, "variant": "live" }),
                None
            )
            .await,
            Ok(expected)
        );

        let expected = json!(crate::zoom::stored(&state.lock_db_read()));
        assert_eq!(
            dispatch(&state, "card_zoom", Value::Null, None).await,
            Ok(expected)
        );

        let expected = json!(crate::combos::card_combos(
            &state.lock_db_read(),
            "none",
            None,
            None,
            false,
            5,
            0
        )
        .unwrap());
        assert_eq!(
            dispatch(
                &state,
                "combos_for_card",
                json!({ "oracleId": "none", "ownedOnly": false, "limit": 5, "offset": 0 }),
                None,
            )
            .await,
            Ok(expected)
        );
    }

    /// **The one command with no desktop wrapper, through the wire**: `card_image_source` is
    /// asked a picture's path and answers one object tagged by `kind` — the address, the
    /// placeholder, or `unknown`. Its three answers and every refusal are `images`' own tests;
    /// this is the entry: the argument's name, the connection it reads, the JSON it leaves as.
    #[tokio::test]
    async fn the_picture_command_says_where_a_picture_is() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-picture", "http://127.0.0.1:1");
        let bolt = "0000419b-0bba-4488-8f7a-6194544ce91d";
        state
            .lock_db()
            .execute(
                "INSERT INTO cards
                    (id, name, set_code, collector_number, lang, layout, image_uris, raw)
                 VALUES (?1, 'Bolt', 'lea', '161', 'en', 'normal',
                         json_object('grid', 'https://cards.scryfall.io/grid/front/0/0/x.webp?17'),
                         '{}')",
                [bolt],
            )
            .unwrap();
        let ask = |path: String| {
            let state = state.clone();
            async move { dispatch(&state, "card_image_source", json!({ "path": path }), None).await }
        };

        assert_eq!(
            ask(format!("/grid/{bolt}/0?v=2")).await,
            Ok(json!({
                "kind": "uri",
                "uri": "https://cards.scryfall.io/grid/front/0/0/x.webp?17"
            }))
        );
        let back = ask(format!("/grid/{bolt}/1")).await.expect("an answer");
        assert_eq!(back["kind"], json!("missing"));
        assert!(
            back["svg"]
                .as_str()
                .is_some_and(|svg| svg.starts_with("<svg ") && svg.contains("Card back")),
            "{back}"
        );
        assert_eq!(
            back.as_object().map(|o| o.len()),
            Some(2),
            "kind and svg, and nothing else: {back}"
        );
        assert_eq!(
            ask(format!("/png/{bolt}/0")).await,
            Ok(json!({ "kind": "unknown" }))
        );
        assert_eq!(
            ask("/nothing".to_owned()).await,
            Ok(json!({ "kind": "unknown" }))
        );
        let missing = dispatch(&state, "card_image_source", json!({}), None)
            .await
            .unwrap_err();
        assert!(missing.contains("path"), "{missing}");
        let entry = TABLE
            .iter()
            .find(|entry| entry.name == "card_image_source")
            .expect("the entry");
        assert_eq!(
            (entry.kind, entry.args, entry.types),
            (Kind::Read, &["path"][..], &["String"][..])
        );
    }

    /// **A write through the table changes the database**, and the read after it answers the
    /// change — a deck made through `deck_create` is in `deck_list`, and one renamed through
    /// `deck_update` reads back renamed. Spelled as `ipc.ts` spells them.
    #[tokio::test]
    async fn a_write_through_the_table_lands() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-writes", "http://127.0.0.1:1");
        let made = dispatch(
            &state,
            "deck_create",
            json!({ "deck": { "name": "Through the table" } }),
            None,
        )
        .await
        .expect("a deck");
        let id = made["id"].as_i64().expect("the new deck's id");
        let listed = dispatch(&state, "deck_list", Value::Null, None)
            .await
            .expect("the decks");
        let names: Vec<_> = listed
            .as_array()
            .expect("a list")
            .iter()
            .map(|d| (d["id"].as_i64(), d["name"].as_str()))
            .collect();
        assert_eq!(names, [(Some(id), Some("Through the table"))]);

        dispatch(
            &state,
            "deck_update",
            json!({ "id": id, "patch": { "name": "Renamed" } }),
            None,
        )
        .await
        .expect("a rename");
        let row = crate::deck::get_deck(
            &state.lock_db_read(),
            id,
            "live",
            crate::sorting::Marketplace::from_opt(None),
        )
        .expect("a read")
        .expect("the deck");
        assert_eq!(row.deck.name, "Renamed");
    }

    /// **An owned write through the table changes the collection _and_ the facet index's `owned`
    /// dimension** — `collection_add`'s copy is in `collection_list`, and the warm index is
    /// published again counting it, which a plain `write` entry would leave alone.
    #[tokio::test]
    async fn an_owned_write_through_the_table_lands_and_moves_the_index() {
        let (state, _dir) =
            crate::state::fixtures::on_files("commands-owned", "http://127.0.0.1:1");
        crate::schema::fixtures::seed_card(&state.lock_db(), "c-bolt", "lea", "161");
        crate::index::lifecycle::build_now(&state).expect("an index over the fixture");
        let built = crate::index::lifecycle::current(&state).expect("a warm index");
        assert_eq!(built.owned.count(), 0);

        let added = dispatch(
            &state,
            "collection_add",
            json!({ "entry": { "cardId": "c-bolt", "finish": "nonfoil", "quantity": 3 } }),
            None,
        )
        .await
        .expect("an add");
        assert!(added["id"].as_i64().is_some(), "{added}");

        let listed = dispatch(&state, "collection_list", json!({ "query": {} }), None)
            .await
            .expect("the collection");
        let expected = json!(crate::collection::list_entries(
            &state.lock_db_read(),
            &crate::collection::CollectionQuery::default(),
        )
        .unwrap());
        assert_eq!(listed, expected);
        assert!(listed.to_string().contains("c-bolt"), "{listed}");
        let total: i64 = state
            .lock_db_read()
            .query_row(
                "SELECT sum(quantity) FROM collection_entries WHERE card_id = 'c-bolt'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 3);

        let after = crate::index::lifecycle::current(&state).expect("a warm index");
        assert!(
            !Arc::ptr_eq(&built, &after),
            "the owned write published the index"
        );
        assert_eq!(after.owned.count(), 1);
    }

    /// **A task through the table**, with no network: the pairing offer is minted under the
    /// state's own lock and taken back by a cancel — the one `task` pair that asks no relay.
    #[tokio::test]
    async fn a_task_through_the_table_holds_the_offer_and_lets_it_go() {
        let (state, _dir) = crate::state::fixtures::on_files("commands-task", "http://127.0.0.1:1");
        let offer = dispatch(&state, "sync_pairing_begin", Value::Null, None)
            .await
            .expect("an offer");
        assert!(offer.is_object(), "{offer}");
        assert!(state.pairing.lock().await.is_some(), "the offer is pending");
        assert_eq!(
            dispatch(&state, "sync_pairing_cancel", Value::Null, None).await,
            Ok(Value::Null)
        );
        assert!(state.pairing.lock().await.is_none(), "the cancel took it");
    }

    // -----------------------------------------------------------------------------------------
    // A page asks the relay, as every host does
    // -----------------------------------------------------------------------------------------

    /// Point `state`'s relay at `relay`: the override with no UI, written straight to its row.
    fn with_a_relay(state: &State, relay: &str) {
        crate::sync_engine::client::set_state(
            &state.lock_db(),
            crate::sync_engine::client::RELAY_URL,
            relay,
        )
        .expect("the relay's override");
    }

    fn group_of(state: &State) -> Option<String> {
        crate::sync_pair::identity::group(&state.lock_db())
            .expect("the group's row")
            .map(|g| g.group_id)
    }

    fn relay_errors_logged(state: &State) -> i64 {
        state
            .lock_db()
            .query_row(
                "SELECT count(*) FROM error_log WHERE source = 'relay'",
                [],
                |r| r.get(0),
            )
            .expect("the error log")
    }

    /// One press, and how many requests it cost the relay's stand-in.
    async fn press(
        state: &Arc<State>,
        asked: &httpmock::Mock<'_>,
        name: &str,
        args: Value,
    ) -> (Result<Value, String>, usize) {
        let before = asked.calls();
        let answer = dispatch(state, name, args, None).await;
        (answer, asked.calls() - before)
    }

    /// **Every press a Sync panel can make, on one device that starts in no group**, against a
    /// relay that answers 500 to everything — and what each cost it, in requests. `invite` is a
    /// code another device offered, so the join has something real to answer.
    ///
    /// What is asserted here is what is true on every host; the answer is the walk itself —
    /// each press, whether it answered `Ok`, and its request count — for the caller to hold one
    /// host's against another's.
    async fn walk_the_sync_panel(
        state: &Arc<State>,
        asked: &httpmock::Mock<'_>,
        invite: &str,
    ) -> Vec<(&'static str, bool, usize)> {
        const ANSWERED_500: &str = "the relay answered 500";
        let mut walked = Vec::new();

        // The panel draws: every read answers, and none of them asks.
        for read in [
            "sync_status",
            "sync_relay_status",
            "sync_supporter_status",
            "sync_pairing_status",
            "sync_review_list",
        ] {
            let (answer, cost) = press(state, asked, read, Value::Null).await;
            assert!(answer.is_ok(), "{read} is a local read: {answer:?}");
            walked.push((read, true, cost));
        }
        // Sync with nothing connected is off, and asks nobody.
        let (off, cost) = press(state, asked, "sync_now", Value::Null).await;
        assert_eq!(off, Ok(Value::Null));
        walked.push(("sync_now, in no group", true, cost));

        // The inviter's half. The offer is minted here and nowhere else; the poll after it is
        // the request, and the stand-in's 500 is what comes back — a status, read off an answer.
        let (offer, cost) = press(state, asked, "sync_pairing_begin", Value::Null).await;
        let offer = offer.expect("an offer");
        assert!(
            offer["code"].as_str().is_some_and(|code| !code.is_empty()),
            "{offer}"
        );
        assert!(state.pairing.lock().await.is_some(), "the offer is pending");
        walked.push(("sync_pairing_begin", true, cost));
        let (poll, cost) = press(state, asked, "sync_pairing_poll", Value::Null).await;
        assert!(
            poll.as_ref().is_err_and(|e| e.starts_with(ANSWERED_500)),
            "{poll:?}"
        );
        walked.push(("sync_pairing_poll", false, cost));
        let (cancel, cost) = press(state, asked, "sync_pairing_cancel", Value::Null).await;
        assert_eq!(cancel, Ok(Value::Null));
        assert!(state.pairing.lock().await.is_none(), "the cancel took it");
        walked.push(("sync_pairing_cancel", true, cost));

        // The joiner's half: the answer is posted before anything is kept.
        let code = json!({ "code": invite });
        let (accept, cost) = press(state, asked, "sync_pairing_accept", code).await;
        assert!(
            accept.as_ref().is_err_and(|e| e.starts_with(ANSWERED_500)),
            "{accept:?}"
        );
        assert!(state.pairing.lock().await.is_none(), "and nothing was kept");
        walked.push(("sync_pairing_accept", false, cost));

        // Connect: the address to open is built here, and the claim is the request. The group
        // of one it is made against is minted first and stays — `ensure_group` says why.
        let (authorize, cost) = press(state, asked, "sync_patreon_begin", Value::Null).await;
        let authorize = authorize.expect("an address to open");
        assert!(
            authorize
                .as_str()
                .is_some_and(|url| url.starts_with("https://www.patreon.com/oauth2/authorize?")),
            "{authorize}"
        );
        walked.push(("sync_patreon_begin", true, cost));
        assert_eq!(group_of(state), None);
        let code = json!({ "code": "a-claim-code" });
        let (claim, cost) = press(state, asked, "sync_patreon_claim", code).await;
        assert!(
            claim.as_ref().is_err_and(|e| e.starts_with(ANSWERED_500)),
            "{claim:?}"
        );
        assert!(group_of(state).is_some(), "the group the claim was for");
        walked.push(("sync_patreon_claim", false, cost));

        // In a group now, so a sync is a round trip — as far as the first 500.
        let (sync, cost) = press(state, asked, "sync_now", Value::Null).await;
        assert!(
            sync.as_ref().is_err_and(|e| e.contains(ANSWERED_500)),
            "{sync:?}"
        );
        walked.push(("sync_now, in a group", false, cost));
        // A removal is refused before any request, in its own words: no membership.
        let nobody = json!({ "deviceId": "nobody" });
        let (revoke, cost) = press(state, asked, "sync_device_revoke", nobody).await;
        assert_eq!(
            revoke,
            Err(crate::sync_pair::identity::NO_MEMBERSHIP.to_owned())
        );
        walked.push(("sync_device_revoke", false, cost));

        // **Leaving is always possible**: the local clear runs whatever the relay answered.
        let (leave, cost) = press(state, asked, "sync_group_leave", Value::Null).await;
        assert_eq!(leave, Ok(Value::Null));
        assert_eq!(group_of(state), None, "the device has left, locally");
        walked.push(("sync_group_leave", true, cost));

        walked
    }

    /// **On a host that asks as a page, the commands that reach the relay reach it** — request
    /// for request what a native host sends, with the relay's own answer read off the response.
    /// A page's requests are bound by CORS, which the relay answers for the origins it names
    /// (`relay/src/cors.ts`); nothing in the engine stands between a press and the request.
    ///
    /// The mock stands where the relay would, answers 500 to everything and counts. **The
    /// native walk is the control**: the same presses on a desktop's two connections and many
    /// threads, so "the page asked" is held to a number and not to "more than none". The page's
    /// walk is on one connection and one thread with unexposed response headers hidden
    /// (`platform::host::emulate_page`), so a relay path that took the connection twice, or
    /// leaned on a header a browser would not show it, fails here by name.
    ///
    /// What a mock cannot be is a browser: no pre-flight is sent to it and no
    /// `Access-Control-Allow-Origin` is asked of it. That half is the relay's own tests, and a
    /// real browser's.
    #[tokio::test]
    async fn on_a_page_the_sync_commands_ask_the_relay_as_any_host_does() {
        let relay = httpmock::MockServer::start();
        let asked = relay.mock(|when, then| {
            when.any_request();
            then.status(500).body("the relay, standing in");
        });

        // A code to join by, from a third device — which asks nobody to make it.
        let (inviter, _inviter_dir) =
            crate::state::fixtures::on_files("commands-relay-inviter", "http://127.0.0.1:1");
        let invite = dispatch(&inviter, "sync_pairing_begin", Value::Null, None)
            .await
            .expect("an offer")["code"]
            .as_str()
            .expect("the code")
            .to_owned();
        assert_eq!(asked.calls(), 0, "an offer is made locally");

        // The control, natively.
        let (native, _native_dir) =
            crate::state::fixtures::on_files("commands-relay-native", "http://127.0.0.1:1");
        with_a_relay(&native, &relay.base_url());
        let natively = walk_the_sync_panel(&native, &asked, &invite).await;
        let cost_of = |walk: &[(&'static str, bool, usize)], press: &str| {
            walk.iter()
                .find(|(name, _, _)| *name == press)
                .map(|(_, _, cost)| *cost)
                .expect("a press the walk makes")
        };
        // The five presses that are requests, and the ones that are not: without this, a walk
        // that asked nobody would equal another that asked nobody.
        for asks in [
            "sync_pairing_poll",
            "sync_pairing_accept",
            "sync_patreon_claim",
            "sync_now, in a group",
            // The courtesy call. What it answers changes nothing: the device has left.
            "sync_group_leave",
        ] {
            assert!(cost_of(&natively, asks) > 0, "{asks} asks the relay");
        }
        for local in [
            // The panel's reads: opening Settings asks nobody, on any host.
            "sync_status",
            "sync_relay_status",
            "sync_supporter_status",
            "sync_pairing_status",
            "sync_review_list",
            "sync_now, in no group",
            "sync_pairing_begin",
            "sync_pairing_cancel",
            "sync_patreon_begin",
            "sync_device_revoke",
        ] {
            assert_eq!(cost_of(&natively, local), 0, "{local} asks nobody");
        }
        let native_log = relay_errors_logged(&native);
        assert!(native_log > 0, "a failed request is in the error log");

        // The page: one connection, one thread, and a browser's view of a response.
        let (page, _heard, _page_dir) =
            crate::state::fixtures::single("commands-relay-page", "http://127.0.0.1:1");
        with_a_relay(&page, &relay.base_url());
        let _page = crate::platform::host::emulate_page();
        assert!(page.one_connection() && crate::platform::host::asks_as_a_page());
        let before = asked.calls();
        let on_a_page = walk_the_sync_panel(&page, &asked, &invite).await;

        assert_eq!(
            on_a_page, natively,
            "press for press, a page asked the relay what a native host asks it"
        );
        assert_eq!(
            asked.calls() - before,
            natively.iter().map(|(_, _, cost)| cost).sum::<usize>(),
            "and nothing between the presses asked it either"
        );
        assert_eq!(
            relay_errors_logged(&page),
            native_log,
            "a request that failed is logged on a page as it is anywhere"
        );
        // What is a page's own: it is told no machine name, so `Browser` is what it is called
        // on the roster of the device it pairs with.
        let pairing = dispatch(&page, "sync_pairing_status", Value::Null, None)
            .await
            .expect("the panel's read");
        assert_eq!(pairing["groupId"], Value::Null, "{pairing}");
        assert_eq!(pairing["deviceName"], "Browser", "{pairing}");
    }

    // -----------------------------------------------------------------------------------------
    // One connection, one thread: every command, the way a browser's Worker runs it
    // -----------------------------------------------------------------------------------------

    /// How one call ended, on a thread standing in for a Worker.
    #[derive(Debug)]
    enum Alone {
        /// It answered — `Ok` or a refusal of its own, either of which is an answer.
        Answered(Result<Value, String>),
        /// It panicked, and this is what it said. A lock this thread already held, asked for
        /// again, is the one this harness is for ([`crate::platform::alone`]): in a browser a
        /// trap, natively on one connection a deadlock. Any other panic is a trap there too.
        Panicked(String),
        /// It answered [`crate::db::BUSY`] with nothing else running: a press that asked for
        /// the sync lane ([`State::lane_for_press`]) from inside the operation holding it, and
        /// waited out its bound. (A bounded ask for a *connection* its caller holds is a panic
        /// here, not a `BUSY` — [`crate::platform::alone::refuse_held`].)
        BusyWithItself,
        /// It never answered: an `async` lock (the sync lane, the pairing offer) awaited by the
        /// task that holds it. In a browser that is a promise that never settles.
        NeverAnswered,
    }

    impl Alone {
        /// The sentence a failed command is reported with, or `None` for one that answered.
        fn failure(&self) -> Option<String> {
            match self {
                Alone::Answered(_) => None,
                Alone::Panicked(said) => Some(format!("panicked: {said}")),
                Alone::BusyWithItself => Some(
                    "answered \"busy\" with nothing else running: it asked, with a bound, for \
                     something its own caller was holding"
                        .to_owned(),
                ),
                Alone::NeverAnswered => Some(format!(
                    "did not answer in {NEVER}s: it is awaiting a lock its own task holds",
                    NEVER = NEVER_ANSWERED.as_secs()
                )),
            }
        }
    }

    /// Long past any command over a near-empty database and a local mock server, and only ever
    /// spent by a call that is not coming back.
    const NEVER_ANSWERED: std::time::Duration = std::time::Duration::from_secs(30);

    fn one_thread_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a runtime")
    }

    /// Drive `call` to its end **on this thread, as a Worker would**: the caller has said this
    /// thread is the only one ([`crate::platform::alone`]), so the blocking pool is the caller,
    /// a pause is no pause, and a connection or the facet index taken twice is a panic — caught
    /// here and turned into an outcome, so the failure is a sentence with a command's name on
    /// it and never a test that does not end.
    ///
    /// ⚠️ **"Never a test that does not end" is true of those two locks and of the two `async`
    /// ones, and of nothing else.** A connection and the facet index go through `alone`; the
    /// lane and the pairing offer are awaited, so the deadline here ends them. Every *other*
    /// std lock in the crate — `db::lock_plain` and the bare `.lock()`s of the image cache, the
    /// event sinks, the scanner, the undo tickets — is taken as it is natively: a recursive one
    /// blocks this thread for good, and a deadline cannot fire on a current-thread runtime
    /// whose one thread is blocked. They are left out on purpose (`platform::alone` says why:
    /// some are process-wide, and other tests' threads hold them honestly), so for those this
    /// harness proves nothing and would hang.
    ///
    /// A panic leaves the runtime in whatever state the unwind left it, so it is replaced.
    fn drive<F>(runtime: &mut tokio::runtime::Runtime, call: F) -> Alone
    where
        F: std::future::Future<Output = Result<Value, String>>,
    {
        assert!(
            crate::platform::alone::emulated(),
            "`drive` is for a thread standing in for a host with one"
        );
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(async { tokio::time::timeout(NEVER_ANSWERED, call).await })
        }));
        match ran {
            Err(panic) => {
                *runtime = one_thread_runtime();
                Alone::Panicked(
                    panic
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                        .unwrap_or_else(|| "it panicked, and did not say why".to_owned()),
                )
            }
            Ok(Err(_elapsed)) => Alone::NeverAnswered,
            Ok(Ok(Err(e))) if e == crate::db::BUSY => Alone::BusyWithItself,
            Ok(Ok(answer)) => Alone::Answered(answer),
        }
    }

    /// **The mutation**: commands that take the connection twice, in each of the ways a
    /// one-connection host can — over a table of their own, as `kinds` is.
    mod twice {
        commands! {
            // A read asked for inside a write. Two mutexes on the desktop; one in a browser.
            blocking read_inside_a_write in commands::tests(key: String) = |state| {
                crate::state::with_write(&state, |_conn| meta(&state.lock_db_read(), &key))
            };
            // The other way round, where the second ask is bounded. A Worker answers that one
            // "busy" — against its own caller — rather than trapping.
            blocking write_inside_a_read in commands::tests(key: String) = |state| {
                let _reader = state.lock_db_read();
                crate::state::with_write(&state, |conn| set_meta(conn, &key, "never"))
            };
            // **The one a trap-and-busy watch passes over**: a bounded ask whose caller drops
            // its work on `None`. `note_database` is `if let Some(conn) = lock_for(…)`, so with
            // the connection in hand the row is simply never written — and this answers `Ok`.
            blocking note_inside_a_read in commands::tests(key: String) = |state| {
                let _reader = state.lock_db_read();
                crate::sync::note_database(&state, &key, "asked for with the connection held");
                Ok(())
            };
            // Work handed to "the pool" while a lock it takes is held: off the caller natively,
            // on it in a browser.
            task spawn_inside_a_read in commands::tests(key: String) = |state| async move {
                let held = state.lock_db_read();
                let inner = ::std::sync::Arc::clone(&state);
                let work = crate::platform::spawn::blocking(move || {
                    meta(&inner.lock_db_read(), &key)
                });
                // Polled once with the guard in hand — never across an `.await`, which the
                // compiler's own fence refuses.
                let polled = ::futures_util::FutureExt::now_or_never(work);
                drop(held);
                polled
                    .ok_or_else(|| "the work was taken off the caller".to_owned())?
                    .map_err(|e| e.to_string())?
            };
            // An async lock awaited by the task that holds it: the lane, twice.
            task lane_inside_the_lane in commands::tests() = |state| async move {
                let _first = state.lane().await;
                let _second = state.lane().await;
                Ok(())
            };
            // And asked for as a press asks, with a bound: it waits the bound out and is told
            // "busy" — by itself.
            task press_inside_the_lane in commands::tests() = |state| async move {
                let _held = state.lane().await;
                let bound = ::std::time::Duration::from_millis(50);
                state.lane_within(bound).await.map(|_| ())
            };
            // The control: the same three things, one after another, each let go first.
            blocking one_at_a_time in commands::tests(key: String) = |state| {
                crate::state::with_write(&state, |conn| set_meta(conn, &key, "written"))?;
                let read = meta(&state.lock_db_read(), &key)?;
                crate::collection_source::with_write_owned(&state, |conn| {
                    set_meta(conn, &key, "again")
                })?;
                Ok(read)
            };
        }
    }

    /// **The detection, shown to work.** Each deliberate double lock is a failure with the
    /// command's name on it — a panic that names the line, a "busy" against itself, a call that
    /// never answers — and none of them hangs the test. On a host with two connections the
    /// first is not a double lock at all, which is why no desktop test ever saw one.
    ///
    /// "Lock" here is a connection, the facet index, the sync lane and the pairing offer —
    /// `drive`'s doc says which locks are outside it.
    #[test]
    fn a_lock_taken_twice_fails_by_name_instead_of_hanging() {
        // Read before the test stands in for anything, so a slow machine cannot be what times
        // the last case out.
        let quick = std::time::Duration::from_millis(400);
        let (state, _heard, _dir) =
            crate::state::fixtures::single("commands-twice", "http://127.0.0.1:1");
        let (two, _dir_two) =
            crate::state::fixtures::on_files("commands-twice-two", "http://127.0.0.1:1");
        let _alone = crate::platform::alone::emulate();
        let mut runtime = one_thread_runtime();
        let key = || json!({ "key": "probe" });

        let taken = drive(
            &mut runtime,
            twice::dispatch(&state, "read_inside_a_write", key(), None),
        );
        let said = match &taken {
            Alone::Panicked(said) => said.clone(),
            other => panic!("a read inside a write must be refused, and was {other:?}"),
        };
        assert!(said.contains("a lock taken twice by one thread"), "{said}");
        assert!(
            said.contains("commands.rs"),
            "it names the line that asked: {said}"
        );

        // A bounded ask for a held connection: `None` at once in a Worker, and here a panic
        // that says it was bounded and names the line.
        let bounded = drive(
            &mut runtime,
            twice::dispatch(&state, "write_inside_a_read", key(), None),
        );
        let said = match &bounded {
            Alone::Panicked(said) => said.clone(),
            other => panic!("a write inside a read must be refused, and was {other:?}"),
        };
        assert!(said.contains("a connection, with a bound"), "{said}");
        assert!(said.contains("commands.rs"), "{said}");

        // **The swallowed one.** Without `alone::refuse_held` this answers `Ok(null)` and the
        // row is never written — nothing traps, nothing is busy, and a table test that watched
        // only for those two passes over it.
        let swallowed = drive(
            &mut runtime,
            twice::dispatch(&state, "note_inside_a_read", key(), None),
        );
        let said = match &swallowed {
            Alone::Panicked(said) => said.clone(),
            other => panic!("a bounded ask that drops its work must be refused: {other:?}"),
        };
        assert!(said.contains("a connection, with a bound"), "{said}");
        assert!(
            said.contains("sync.rs"),
            "it names `note_database`'s ask: {said}"
        );

        let busy = drive(
            &mut runtime,
            twice::dispatch(&state, "press_inside_the_lane", Value::Null, None),
        );
        assert!(matches!(busy, Alone::BusyWithItself), "{busy:?}");
        assert!(busy.failure().is_some());

        let spawned = drive(
            &mut runtime,
            twice::dispatch(&state, "spawn_inside_a_read", key(), None),
        );
        assert!(matches!(spawned, Alone::Panicked(_)), "{spawned:?}");

        // The lane has no panic to give — an awaited lock just never resolves — so this one is
        // found by the wait. Asked with a short one here; the table test's is `NEVER_ANSWERED`.
        let lane = {
            let call = twice::dispatch(&state, "lane_inside_the_lane", Value::Null, None);
            runtime.block_on(async { tokio::time::timeout(quick, call).await.is_err() })
        };
        assert!(lane, "a lane awaited twice by one task must not answer");

        // And the state is not left broken by any of it: the same connection, one use at a time.
        let control = drive(
            &mut runtime,
            twice::dispatch(&state, "one_at_a_time", key(), None),
        );
        assert!(
            matches!(&control, Alone::Answered(Ok(Value::String(read))) if read == "written"),
            "{control:?}"
        );

        // Two connections: a read inside a write is two mutexes, and answers.
        let desktop = drive(
            &mut runtime,
            twice::dispatch(&two, "read_inside_a_write", key(), None),
        );
        assert!(matches!(desktop, Alone::Answered(Ok(_))), "{desktop:?}");

        // Every case above is in the table, and nothing in the table went unasked.
        let asked: Vec<_> = twice::TABLE.iter().map(|e| e.name).collect();
        assert_eq!(
            asked,
            [
                "read_inside_a_write",
                "write_inside_a_read",
                "note_inside_a_read",
                "spawn_inside_a_read",
                "lane_inside_the_lane",
                "press_inside_the_lane",
                "one_at_a_time",
            ]
        );
    }

    /// An argument for a command the table test has no row for, from its declared type: the
    /// smallest value that parses, so the body runs and refuses for a reason of its own —
    /// *there is no such deck* — rather than at the door. `None` leaves the argument out, which
    /// is what an `Option` is on the wire.
    fn any_value(name: &str, ty: &str) -> Option<Value> {
        let ty: String = ty.chars().filter(|c| !c.is_whitespace()).collect();
        Some(match ty.as_str() {
            _ if ty.starts_with("Option<") => return None,
            // The one string most deck commands refuse anything else for.
            "String" if name == "variant" => json!("live"),
            "String" => json!("x"),
            "bool" => json!(false),
            "f64" => json!(1.0),
            "i64" | "u32" | "u64" | "usize" => json!(1),
            _ if ty.starts_with("Vec<") => json!([]),
            // A struct of the wire's, or a map: an empty object parses wherever every field has
            // a default, and is a refusal in words where one does not.
            _ => json!({}),
        })
    }

    fn any_args(entry: &Entry) -> Value {
        let mut args = serde_json::Map::new();
        for (name, ty) in entry.args.iter().zip(entry.types) {
            if let Some(value) = any_value(name, ty) {
                args.insert(camel(name), value);
            }
        }
        Value::Object(args)
    }

    /// `deck_id` as the wire spells it.
    fn camel(name: &str) -> String {
        let mut out = String::new();
        let mut upper = false;
        for c in name.chars() {
            match c {
                '_' => upper = true,
                c if upper => {
                    out.extend(c.to_uppercase());
                    upper = false;
                }
                c => out.push(c),
            }
        }
        out
    }

    /// What the table test calls a command with, where a made-up value would stop it at the
    /// door. **Every `blocking` and `task` entry has a row** — those are the kinds whose body is
    /// handed the state itself and so can take the connection twice; the test refuses a table
    /// that has grown one without a row. The rest are here because a write that *lands* is what
    /// reaches the code after it: the settle, the reconcile, the facet index's `owned` refresh.
    fn chosen_args(name: &str, seeded: &Seeded) -> Option<Value> {
        let reviewable = crate::sync_engine::commands::REVIEWABLE[0].0;
        Some(match name {
            // Writes that land, so what follows a write runs.
            "deck_create" => json!({ "deck": { "name": "Alone" } }),
            "collection_add" => {
                json!({ "entry": { "cardId": "c-bolt", "finish": "nonfoil", "quantity": 3 } })
            }
            "collection_list" | "collection_summary" | "collection_shelf_counts" => {
                json!({ "query": {} })
            }
            // Not the seeded copy, which `collection_to_deck` is about to move.
            "collection_remove" => json!({ "id": 999_999 }),
            "search_cards" => json!({ "req": { "text": "bolt" } }),
            // Structs with a required field, which `{}` would stop at the door.
            "search_marks" => json!({ "req": { "ids": ["c-bolt"] } }),
            "set_home_layout" => json!({ "layout": seeded.layout }),
            "deck_token_swap" => json!({
                "deckId": seeded.deck,
                "variant": "live",
                "oracleId": "o-c-bolt",
                "to": { "cardId": "c-bolt", "finish": "nonfoil" },
            }),
            "deck_token_remove" => json!({
                "deckId": seeded.deck,
                "variant": "live",
                "oracleId": "o-c-bolt",
                "entry": { "cardId": "c-bolt", "finish": "nonfoil" },
            }),

            // `blocking`. A ticket that is still good and a copy that is really there, so
            // each reaches the write it decides on.
            "bulk_undo" => json!({ "undoId": seeded.undo }),
            "collection_to_deck" => json!({
                "entryId": seeded.entry,
                "deckId": seeded.deck,
                "categoryName": seeded.pile,
                "quantity": 1,
            }),
            "combos_status" | "combos_clear" | "cache_clear" | "sync_status" => Value::Null,
            "art_tags_status" | "oracle_tags_status" => Value::Null,
            // With text, so the facet pass reads the database rather than answering from memory.
            "facet_cards" => json!({ "req": { "text": "bolt" } }),
            "sync_review_clear" => json!({ "table": reviewable, "uid": "nobody" }),

            // `task`. Each stops at the mock server's 404, or before any request.
            "combos_refresh" => json!({ "force": false }),
            "marketplace_feed_refresh" => json!({ "marketplace": "nowhere" }),
            "sync_run" => json!({ "force": true }),
            "art_tags_refresh" | "oracle_tags_refresh" => json!({ "force": true }),
            "sync_patreon_claim" => json!({ "code": "not-a-code" }),
            "sync_pairing_accept" => json!({ "code": "not-an-invite" }),
            "sync_device_revoke" => json!({ "deviceId": "nobody" }),
            "sync_now" | "sync_group_leave" | "sync_live_state" => Value::Null,
            "sync_pairing_begin"
            | "sync_pairing_confirm"
            | "sync_pairing_poll"
            | "sync_pairing_cancel" => Value::Null,
            _ => return None,
        })
    }

    /// What a refusal at the door says — `parse`'s sentence, above.
    const DID_NOT_PARSE: &str = "its arguments did not parse";

    /// The commands the table test asks and **never runs**, in table order: their made-up
    /// arguments do not parse, so the call is refused before its body and proves nothing about
    /// it but the refusal.
    ///
    /// **Empty, and pinned so it stays a decision.** Counted on 2026-10-04 there were four —
    /// `deck_token_swap`, `deck_token_remove`, `set_home_layout` and `search_marks`, each with a
    /// struct argument that has a required field — and each now has a row in `chosen_args`.
    /// (Every other struct argument in the table parses from `{}`.) A new command whose
    /// arguments `any_args` cannot make up lands here by failing the test: give it a row, or
    /// name it here with the reason it is not worth one.
    ///
    /// ⚠️ **Past the door is not the same as far.** Most made-up calls are refused by the body
    /// for a reason of its own — *there is no such deck* — one statement in. What that proves
    /// is the arm: the connection taken, the write's settle, and for an `owned` one the facet
    /// refresh only when the body answered `Ok`.
    const STOPPED_AT_THE_DOOR: &[&str] = &[];

    /// What the table test put in the database before it asked anything, so the commands that
    /// decide something *before* they take the connection have something to decide about.
    struct Seeded {
        deck: i64,
        /// One of the deck's own piles, by name.
        pile: String,
        /// A copy of the seeded card, removed and waiting to be put back.
        entry: i64,
        /// The ticket that removal left.
        undo: u64,
        /// The home page as stored, to be stored again: a document at the version the store
        /// accepts, whatever that is.
        layout: Value,
    }

    /// **Every command in the table, on a host with one connection and one thread** — the
    /// database opened the browser's way ([`crate::launch::open_single`]), a state with no read
    /// connection, and the calling thread standing in for a Worker
    /// ([`crate::platform::alone`]): the blocking pool is the caller, and a connection asked
    /// for while it is held is a failure with the command's name on it.
    ///
    /// The desktop has two connections and a pool of threads, so none of its tests can see a
    /// read asked for inside a write, or work handed "off the caller" with a lock in hand.
    /// Those are exactly what a browser turns into a trap — and a trap in a Worker is a page
    /// that stops answering, with nothing it can show.
    ///
    /// **What a failure is**: a panic (a connection or the facet index asked for while this
    /// thread holds it — with or without a bound — or any other trap), a `BUSY` with nothing
    /// else running, or no answer inside the deadline (the lane or the pairing offer awaited by
    /// its holder). **What it cannot see**: a recursive lock of any other kind, which would
    /// block this thread rather than fail it (`drive`'s doc), and a command whose body its
    /// arguments never reach — which is what `STOPPED_AT_THE_DOOR` counts and pins.
    ///
    /// **What it reaches, and what it does not.** A `read`, `write` or `owned` body is handed
    /// a connection and nothing else, so it cannot ask for one: what this proves for those is
    /// the arm around them — `with_write`'s settle, the `owned` refresh after the write let go.
    /// A `blocking` or `task` body is handed the state, and each has chosen arguments so it
    /// runs. **No request leaves the machine**: Scryfall's client and the relay's override both
    /// point at a local server that answers 404, the combo feed is stamped as just checked, and
    /// the price feed is asked for a marketplace it has no feed for. So the far side of a
    /// download — an ingest, a swap — is not run *here*. It is run the same way — one
    /// connection, one thread, no files (`platform::host::emulate_page`, which this test
    /// stands under too) — by each download's own tests against a mock that serves a file:
    /// `sync::run_tests`' streamed runs, `tags::oracle`'s and `art`'s, `combos`' and
    /// `marketplace_feed`'s. Those are where a lock held across a chunk would fail by name.
    #[test]
    fn every_command_answers_on_one_connection_and_one_thread() {
        let nowhere = httpmock::MockServer::start();
        let dir = crate::scratch::path("commands-alone");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // The browser's launch: one connection, both files at head, the launch's passes run.
        let opened = crate::launch::open_single(&dir, &dir).expect("a one-connection launch");
        assert!(opened.read.is_none());
        let heard = Arc::new(crate::events::fixtures::Recording::default());
        let state = Arc::new(State::new(
            opened.write,
            opened.read,
            dir.clone(),
            heard.clone(),
            Vec::new(),
            // Never `opened.client`, which names Scryfall.
            crate::scryfall::Client::new(nowhere.base_url()),
            opened.images,
        ));
        assert!(state.one_connection());
        {
            let conn = state.lock_db();
            crate::schema::fixtures::seed_card(&conn, "c-bolt", "lea", "161");
            crate::sync_engine::client::set_state(
                &conn,
                crate::sync_engine::client::RELAY_URL,
                &nowhere.base_url(),
            )
            .expect("the relay's override");
            // Just checked, so an unforced refresh asks Commander Spellbook nothing.
            conn.execute(
                "INSERT INTO combo_meta (id, checked_at) VALUES (1, unixepoch())",
                [],
            )
            .expect("the combo feed's stamp");
        }

        // The whole page, not only its one thread: no files and requests that must pass CORS,
        // so the five download commands take the arm a Worker takes — the streamed one — as
        // far as the mock's 404 lets them, and anything that asks for a file is refused as a
        // browser refuses it.
        let _page = crate::platform::host::emulate_page();
        assert!(crate::platform::alone::emulated());
        // Warm, so an `owned` write has an index to refresh — through the one connection.
        crate::index::lifecycle::build_now(&state).expect("an index over one connection");
        let mut runtime = one_thread_runtime();

        // A deck with a pile, and a copy of the card taken out again — through the table, so
        // the ticket is one the table's own `bulk_undo` can spend.
        let mut ask = |name: &str, args: Value| -> Value {
            match drive(&mut runtime, dispatch(&state, name, args, None)) {
                Alone::Answered(Ok(answer)) => answer,
                other => panic!("{name} did not set the table test up: {other:?}"),
            }
        };
        let deck = ask("deck_create", json!({ "deck": { "name": "Seeded" } }))["id"]
            .as_i64()
            .expect("the deck's id");
        let piles = ask(
            "deck_category_list",
            json!({ "deckId": deck, "variant": "live" }),
        );
        let pile = piles[0]["name"].as_str().expect("a pile").to_owned();
        // The deck plays the card, so a copy of it can be filed there.
        ask(
            "deck_add_card",
            json!({
                "deckId": deck, "cardId": "c-bolt", "categoryName": pile,
                "variant": "live", "quantity": 1,
            }),
        );
        let copy = json!({ "entry": { "cardId": "c-bolt", "finish": "nonfoil", "quantity": 2 } });
        let entry = ask("collection_add", copy)["id"]
            .as_i64()
            .expect("the copy's id");
        let undo = ask("collection_remove_many", json!({ "ids": [entry] }))["undoId"]
            .as_u64()
            .expect("a ticket for the removal");
        let layout = ask("home_layout", Value::Null);
        let seeded = Seeded {
            deck,
            pile,
            entry,
            undo,
            layout,
        };

        let mut failed: Vec<String> = Vec::new();
        let mut unchosen: Vec<&str> = Vec::new();
        let mut at_the_door: Vec<&str> = Vec::new();
        let mut ran = 0usize;
        for entry in TABLE {
            let args = match chosen_args(entry.name, &seeded) {
                Some(args) => args,
                None => {
                    if matches!(entry.kind, Kind::Blocking | Kind::Task | Kind::Bytes) {
                        unchosen.push(entry.name);
                        continue;
                    }
                    any_args(entry)
                }
            };
            let outcome = drive(&mut runtime, dispatch(&state, entry.name, args, None));
            ran += 1;
            if let Some(why) = outcome.failure() {
                failed.push(format!("{} ({:?}): {why}", entry.name, entry.kind));
            }
            if matches!(&outcome, Alone::Answered(Err(e)) if e.contains(DID_NOT_PARSE)) {
                at_the_door.push(entry.name);
            }
        }

        assert!(
            unchosen.is_empty(),
            "a `blocking` or `task` command is handed the state, so it can take the connection \
             twice — give each of these a row in `chosen_args` whose arguments let its body run \
             without a request leaving the machine: {unchosen:?}"
        );
        assert!(
            failed.is_empty(),
            "{} of {ran} commands cannot run on a host with one connection and one thread:\n{}",
            failed.len(),
            failed.join("\n")
        );
        assert_eq!(ran, TABLE.len());
        // **Asked is not the same as run**: a command refused at the door never reached its
        // body, and this test proved nothing about it but its arm's refusal.
        assert_eq!(
            at_the_door, STOPPED_AT_THE_DOOR,
            "the commands refused at the door are not the pinned ones: see STOPPED_AT_THE_DOOR"
        );

        // The writes that were meant to land did, and the index moved with the collection.
        let decks = drive(
            &mut runtime,
            dispatch(&state, "deck_list", Value::Null, None),
        );
        assert!(
            matches!(&decks, Alone::Answered(Ok(Value::Array(_)))),
            "{decks:?}"
        );
        assert!(
            crate::index::lifecycle::current(&state).is_some(),
            "the index is warm through the one connection"
        );
        // Nothing the engine said went anywhere but the sink it was given.
        let _ = heard.taken();
    }

    /// The made-up arguments are the wire's: camelCase, an `Option` left out.
    #[test]
    fn made_up_arguments_are_spelled_as_the_wire_spells_them() {
        let entry = TABLE
            .iter()
            .find(|e| e.name == "deck_add_card")
            .expect("deck_add_card");
        assert_eq!(
            any_args(entry),
            json!({ "deckId": 1, "cardId": "x", "variant": "live", "quantity": 1 })
        );
        assert_eq!(camel("move_to_category_id"), "moveToCategoryId");
    }

    #[test]
    fn no_command_is_declared_twice() {
        let mut names: Vec<_> = TABLE.iter().map(|e| e.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before);
        assert!(
            TABLE.iter().all(|e| e.kind != Kind::Bytes),
            "no raw body crosses the table yet: the scanner's frame is not in it"
        );
    }
}
