//! **The fence between the core's command table and this app's `generate_handler!`** — the two
//! lists the light-app spec §2.4 says the table costs, and what keeps them one list's worth of
//! truth.
//!
//! The desktop keeps its typed `#[tauri::command]` wrappers and the light app's hosts call
//! `grimoire_core::dispatch` instead (`crates/grimoire-core/src/commands.rs`), so a command can be
//! renamed, added or dropped in one and not the other. Three tests hold them together:
//!
//! - **Every command this app registers is in exactly one place**: the core's `TABLE`, or
//!   [`DESKTOP_ONLY`] with the reason it never will be, or [`NOT_YET`]. A new desktop command
//!   fails here until somebody decides which.
//! - **Nothing on either list, or in the table, is a command this app does not register** — a
//!   stale entry is a list that no longer describes the app.
//! - **Every command in the table takes exactly the arguments its wrapper takes**, by name and in
//!   order — the wrapper's parameters are the wire (`ipc.ts` sends them camelCase, Tauri renames
//!   them so), so a table entry with another name would answer a host's call with a refusal.
//!
//! Markus chose the reads first (2026-10-03): [`NOT_YET`] is everything a light host could answer
//! that the table does not have yet, and a command leaves it for the table when a page of the
//! light app asks for it — one line written in each place.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use grimoire_core::commands::TABLE;

/// Commands that name this host — a window, its updater, its file dialogs, its mirror, its
/// launch, its socket — and never join the table, each with the reason.
const DESKTOP_ONLY: &[(&str, &str)] = &[
    ("window_new", "a second window is this host's"),
    ("window_count", "how many windows this host has open"),
    ("update_status", "the portable updater swaps this exe"),
    ("update_history", "the portable updater swaps this exe"),
    ("update_check", "the portable updater swaps this exe"),
    ("update_download", "the portable updater swaps this exe"),
    ("update_apply", "the portable updater swaps this exe"),
    (
        "update_open_release_page",
        "the portable updater swaps this exe",
    ),
    ("export_save_file", "a native save dialog, opened by Rust"),
    ("import_pick_file", "a native open dialog, opened by Rust"),
    ("mirror_pick_root", "a native folder picker, for the mirror"),
    ("mirror_status", "the plain-text mirror is this host's"),
    ("mirror_set_enabled", "the plain-text mirror is this host's"),
    ("mirror_rebuild", "the plain-text mirror is this host's"),
    (
        "startup_status",
        "the window this host draws before its state exists",
    ),
    (
        "sync_live_state",
        "live sync's socket is this host's connection manager",
    ),
];

/// Commands a light host could answer that the table does not have yet — every write, the feeds'
/// and sync's tasks, the scanner's commands, and `share/`, which no step of the extraction moved.
const NOT_YET: &[&str] = &[
    // bulk_undo, card
    "bulk_undo",
    "set_printing_group_by",
    // collection, collection_alloc, collection_folders
    "collection_add",
    "collection_set_quantity",
    "collection_update",
    "collection_set_printing",
    "collection_remove",
    "collection_import_commit",
    "collection_remove_many",
    "collection_to_deck",
    "deck_to_collection",
    "collection_folder_create",
    "collection_folder_rename",
    "collection_folder_set_locked",
    "collection_folder_move",
    "collection_folder_reorder",
    "collection_folder_delete",
    "collection_removed_clear",
    "collection_set_folder",
    "collection_set_folder_many",
    // combos
    "combos_status",
    "combos_refresh",
    "combos_clear",
    // deck
    "deck_create",
    "deck_update",
    "deck_delete",
    "deck_duplicate",
    "deck_set_folder",
    "deck_set_view_state",
    "deck_missing_to_wishlist",
    "deck_add_card",
    "deck_add_card_to_other_list",
    "deck_set_card_quantity",
    "deck_category_clear",
    "deck_clear",
    "deck_move_card",
    "deck_swap_printing",
    "deck_set_card_finish",
    // deckpane, decksort
    "set_deck_folder_pane",
    "set_deck_sort",
    // deck_meta
    "deck_category_create",
    "deck_category_rename",
    "deck_category_set_active",
    "deck_category_reorder",
    "deck_category_delete",
    "deck_label_create",
    "deck_label_update",
    "deck_label_delete",
    "deck_label_remove_from_deck",
    "deck_card_set_label",
    "deck_folder_create",
    "deck_folder_rename",
    "deck_folder_move",
    "deck_folder_reorder",
    "deck_folder_delete",
    // deck_missing, deck_notes, deck_pull, deck_quick_add, deck_theory, deck_todos
    "deck_missing_to_collection",
    "deck_note_create",
    "deck_note_update",
    "deck_note_delete",
    "deck_note_attach",
    "deck_note_detach",
    "deck_note_reorder",
    "deck_pull_from_collection",
    "deck_quick_add_to_collection",
    "deck_theory_missing_to_wishlist",
    "deck_todo_list_create",
    "deck_todo_list_update",
    "deck_todo_list_delete",
    // deck_tokens, deck_undo
    "deck_token_set_quantity",
    "deck_token_swap",
    "deck_token_add_printing",
    "deck_token_remove",
    "deck_undo_apply",
    "deck_redo_apply",
    // desktop.rs: the card sync and the error log
    "sync_run",
    "sync_status",
    "error_log_clear",
    // home, images, import, index
    "set_home_layout",
    "prefetch_images",
    "prewarm_collection",
    "deck_import_commit",
    "facet_cards",
    // listview, markcolors, marketplace, marketplace_feed
    "set_list_view",
    "set_mark_color",
    "set_marketplace",
    "marketplace_feed_refresh",
    // nav, new_printings, recent_cards
    "set_nav_collapsed",
    "mark_new_printings_seen",
    "record_recent_card",
    // reset
    "collection_clear",
    "wishlist_clear",
    "decks_clear",
    "cache_clear",
    // scanner
    "scanner_status",
    "scanner_frame",
    "scanner_reset",
    "scanner_capture",
    "scanner_set_filters",
    "scanner_elsewhere",
    "scanner_hold",
    "set_scanner_prefs",
    "set_scanner_tray",
    "scanner_tray_commit",
    // searchopen
    "set_search_open",
    // share — `src-tauri`'s still: the spec listed its snapshot and cache, and no step moved them
    "share_list",
    "share_create",
    "share_refresh",
    "share_revoke",
    "share_open",
    // shelffolds, stackhide, startview, sticky_notes
    "set_shelf_folds",
    "set_stack_hidden",
    "set_start_view",
    "sticky_note_create",
    "sticky_note_update",
    "sticky_note_delete",
    "sticky_note_reorder",
    // sync_engine
    "sync_relay_status",
    "sync_supporter_status",
    "sync_patreon_begin",
    "sync_patreon_claim",
    "sync_now",
    "sync_review_list",
    "sync_review_clear",
    // sync_pair
    "sync_pairing_status",
    "sync_pairing_begin",
    "sync_pairing_accept",
    "sync_pairing_confirm",
    "sync_pairing_poll",
    "sync_pairing_cancel",
    "sync_device_rename",
    "sync_device_revoke",
    "sync_group_leave",
    // tags
    "art_tags_refresh",
    "art_tags_status",
    "tag_mute",
    "tag_unmute",
    "oracle_tags_refresh",
    "oracle_tags_status",
    // wishlist, wishlist_folders, wishlist_optimize
    "wishlist_add",
    "wishlist_set_quantity",
    "wishlist_remove",
    "wishlist_set_printing",
    "wishlist_import_commit",
    "wishlist_folder_create",
    "wishlist_folder_rename",
    "wishlist_folder_move",
    "wishlist_folder_reorder",
    "wishlist_folder_delete",
    "wishlist_folder_clear",
    "wishlist_folder_delete_with_wishes",
    "wishlist_set_folder",
    "wishlist_optimize_apply",
    // zoom
    "set_card_zoom",
];

/// The commands `generate_handler!` registers, by their last path segment — the name a page
/// invokes. Read out of `desktop.rs` as text, as `.storybook/fake/parity.test.ts` does.
fn registered() -> BTreeSet<String> {
    let desktop = include_str!("desktop.rs");
    let start = desktop
        .find("generate_handler![")
        .expect("desktop.rs registers its commands");
    let body = &desktop[start + "generate_handler![".len()..];
    let body = &body[..body.find("])").expect("the list closes")];
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("//"))
        .map(|line| line.trim_end_matches(','))
        .map(|path| path.rsplit("::").next().unwrap_or(path).to_owned())
        .collect()
}

/// Every `.rs` file under `src/`, as text.
fn sources() -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("src lists") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(std::fs::read_to_string(&path).expect("a source file reads"));
            }
        }
    }
    let mut out = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut out);
    out
}

/// A type as text, compared on what it names rather than where from: whitespace dropped and every
/// path cut to its last segment, so the table's `crate::sorting::Marketplace` and a wrapper's
/// `Marketplace` are one type, while `Option<String>` and `Option<Marketplace>` are two.
fn normalise(ty: &str) -> String {
    let compact: String = ty.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out = String::new();
    let mut segment = String::new();
    let mut chars = compact.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_alphanumeric() || ch == '_' {
            segment.push(ch);
        } else if ch == ':' && chars.peek() == Some(&':') {
            chars.next();
            segment.clear();
        } else {
            out.push_str(&segment);
            segment.clear();
            out.push(ch);
        }
    }
    out.push_str(&segment);
    out
}

/// The parameters `name`'s `#[tauri::command]` wrapper takes, as `(name, type)`, less the ones
/// Tauri fills in itself — the state, the window, the request, the app, each a `tauri::` type —
/// which leaves what a page sends.
fn wrapper_args(sources: &[String], name: &str) -> Vec<(String, String)> {
    let needle = format!("fn {name}(");
    let mut found = Vec::new();
    for text in sources {
        let mut from = 0;
        while let Some(at) = text[from..].find(&needle).map(|i| i + from) {
            from = at + needle.len();
            // A command: its attribute is closer than the end of the item before it.
            let before = &text[..at];
            let item_start = before.rfind("\n}").map_or(0, |i| i + 2);
            if !before[item_start..].contains("tauri::command") {
                continue;
            }
            let open = at + needle.len() - 1;
            let mut depth = 0;
            let mut close = open;
            for (i, ch) in text[open..].char_indices() {
                match ch {
                    '(' | '<' => depth += 1,
                    ')' | '>' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    close = open + i;
                    break;
                }
            }
            let params = &text[open + 1..close];
            let mut names = Vec::new();
            let mut depth = 0;
            let mut current = String::new();
            for ch in params.chars().chain([',']) {
                match ch {
                    '<' | '(' => depth += 1,
                    '>' | ')' => depth -= 1,
                    _ => {}
                }
                if ch == ',' && depth == 0 {
                    let param = current.trim();
                    if let Some((pname, ty)) = param.split_once(':') {
                        let (pname, ty) = (pname.trim(), ty.trim());
                        // By its type and never its name: `price_movers` takes a `window` that is
                        // a span of time, and a name list dropped it.
                        let filled = ty.contains("tauri::")
                            || ["AppHandle", "Webview", "WebviewWindow"].contains(&ty);
                        if !filled {
                            names.push((pname.to_owned(), normalise(ty)));
                        }
                    }
                    current.clear();
                } else {
                    current.push(ch);
                }
            }
            found.push(names);
        }
    }
    assert_eq!(
        found.len(),
        1,
        "{name}: expected one #[tauri::command] wrapper, found {found:?}"
    );
    found.remove(0)
}

#[test]
fn every_registered_command_is_in_the_table_or_on_one_list() {
    let mut places: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for entry in TABLE {
        places.entry(entry.name).or_default().push("the table");
    }
    for (name, _) in DESKTOP_ONLY {
        places.entry(name).or_default().push("DESKTOP_ONLY");
    }
    for name in NOT_YET {
        places.entry(name).or_default().push("NOT_YET");
    }
    let registered = registered();
    let unplaced: Vec<_> = registered
        .iter()
        .filter(|name| !places.contains_key(name.as_str()))
        .collect();
    assert!(
        unplaced.is_empty(),
        "registered by generate_handler! and in neither the core's table nor a list here — \
         decide which: {unplaced:?}"
    );
    let twice: Vec<_> = places.iter().filter(|(_, at)| at.len() > 1).collect();
    assert!(twice.is_empty(), "in more than one place: {twice:?}");
    let stale: Vec<_> = places
        .keys()
        .filter(|name| !registered.contains(**name))
        .collect();
    assert!(
        stale.is_empty(),
        "named here or in the table, and not a command this app registers: {stale:?}"
    );
}

/// **By name, in order, and by type.** The names are the wire; the types are what the wire is
/// read as — `Option<String>` where the wrapper takes `Option<Marketplace>` would refuse a value
/// the desktop reads as TCGplayer, and an `i64` where it takes a `u32` would let a negative
/// limit through.
#[test]
fn every_command_in_the_table_takes_its_wrappers_arguments() {
    let sources = sources();
    let mismatched: Vec<_> = TABLE
        .iter()
        .filter_map(|entry| {
            let wrapper = wrapper_args(&sources, entry.name);
            let table: Vec<_> = entry
                .args
                .iter()
                .zip(entry.types)
                .map(|(arg, ty)| (arg.to_string(), normalise(ty)))
                .collect();
            (wrapper != table)
                .then(|| format!("{}: wrapper {wrapper:?}, table {table:?}", entry.name))
        })
        .collect();
    assert!(mismatched.is_empty(), "{mismatched:#?}");
}

#[test]
fn a_type_is_compared_on_what_it_names_and_not_where_from() {
    assert_eq!(
        normalise("Option < crate::sorting::Marketplace >"),
        "Option<Marketplace>"
    );
    assert_eq!(
        normalise("Vec<grimoire_core::collection::CollectionImportItem>"),
        "Vec<CollectionImportItem>"
    );
    assert_ne!(
        normalise("Option<String>"),
        normalise("Option<Marketplace>")
    );
}

/// The reasons are the list's whole point: one left blank is a decision nobody wrote down.
#[test]
fn every_desktop_only_command_says_why() {
    assert!(DESKTOP_ONLY.iter().all(|(_, why)| !why.trim().is_empty()));
}
