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
//!   stale entry is a list that no longer describes the app — **unless it is on
//!   [`TABLE_ONLY`]**, with the reason this app has no use for it. That list is the other
//!   direction's [`DESKTOP_ONLY`]: a command only a host of the table can need. It is a list
//!   and not a wrapper nobody calls, because a registered command is one a page can invoke,
//!   and a wrapper written to satisfy a test is one more of those for nothing.
//! - **Every command in the table takes exactly the arguments its wrapper takes**, by name and in
//!   order — the wrapper's parameters are the wire (`ipc.ts` sends them camelCase, Tauri renames
//!   them so), so a table entry with another name would answer a host's call with a refusal.
//!   A table-only command has no wrapper to agree with; its entry is the wire.
//!
//! Markus chose the reads first (2026-10-03), and the same day the table came to cover the light
//! app (phase 4, step 4.2): every write, feed and sync command a light install can answer joined
//! it, so an Android or a web host refuses no page. [`NOT_YET`] is what is left, each group with
//! what it waits on — the picture warms, the scanner and `share/`. A command leaves it for the
//! table with one line written in each place.

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
    (
        "export_save_file",
        "a native save dialog, opened by Rust — the light host answers it beside the table",
    ),
    (
        "import_pick_file",
        "a native open dialog, opened by Rust — the light host answers it beside the table",
    ),
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

/// Commands the table has that this app does not register and never will, each with the
/// reason — [`DESKTOP_ONLY`], read from the other side. A host of the table needs them and
/// this one does not, so there is no wrapper, and a page here that invoked one would be told
/// the command does not exist.
const TABLE_ONLY: &[(&str, &str)] = &[(
    "card_image_source",
    "where a card's picture is, for a host whose page fetches pictures itself — a web \
     host's service worker. This app's `mtgimg://` handler asks the image cache, which \
     resolves, fetches and stores in one call (`images::answer`)",
)];

/// Commands a light host could answer one day that the table does not have yet — and since the
/// table came to cover the light app (phase 4, step 4.2, 2026-10-03), each group here says what
/// it is waiting on. Every other write, feed and sync command moved into the table that day.
const NOT_YET: &[&str] = &[
    // images — each starts a fetch nobody waits for and answers at once. The core can start
    // background work only as a closure (`platform::spawn::background`), never a future, so an
    // entry would have to await every fetch before it answered; and how a picture reaches a light
    // host's page — so whether a warm cache serves it at all — is the host's own question
    // (`mtgimg://` is this host's, and in a browser the cache stores nothing). The pages that ask
    // swallow a refusal (`.catch(() => {})`), so nothing a reader sees is refused.
    "prefetch_images",
    "prewarm_collection",
    // scanner — every command but the two reads already in the table. Each that touches the
    // session or the tray admits the *calling window's label* on the scanner's lease, which a
    // table call does not carry; `scanner_frame` and `scanner_capture` carry a JPEG and a JSON
    // header, where Android carries a frame base64 (spec §2.4); and the session's own
    // `std::thread::scope` and `Instant` panic in a browser until the light app's phase 7 seams
    // them. The phone face's Scanner is a placeholder that asks for none of these.
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
    // share — `share/` is still this crate's: the spec listed its snapshot and cache, and no step
    // of the extraction moved them. The light edition draws no shared view, and the collection's
    // Share control shows only to a connected reader.
    "share_list",
    "share_create",
    "share_refresh",
    "share_revoke",
    "share_open",
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

/// The four lists and what the app registers, as the placement rules read them.
struct Lists<'a> {
    table: &'a [&'a str],
    desktop_only: &'a [&'a str],
    not_yet: &'a [&'a str],
    table_only: &'a [&'a str],
    registered: &'a BTreeSet<String>,
}

/// Everything wrong with where the commands are, one sentence each; empty when every command
/// is in exactly the place it belongs.
fn misplaced(lists: &Lists) -> Vec<String> {
    let mut places: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for name in lists.table {
        places.entry(name).or_default().push("the table");
    }
    for name in lists.desktop_only {
        places.entry(name).or_default().push("DESKTOP_ONLY");
    }
    for name in lists.not_yet {
        places.entry(name).or_default().push("NOT_YET");
    }
    let mut wrong = Vec::new();
    for name in lists.registered {
        if !places.contains_key(name.as_str()) {
            wrong.push(format!(
                "{name}: registered by generate_handler! and in neither the core's table nor \
                 a list here — decide which"
            ));
        }
    }
    for (name, at) in &places {
        if at.len() > 1 {
            wrong.push(format!("{name}: in more than one place: {at:?}"));
        }
        if !lists.registered.contains(*name) && !lists.table_only.contains(name) {
            wrong.push(format!(
                "{name}: named in {at:?} and not a command this app registers — a stale \
                 entry, or a command for TABLE_ONLY with its reason"
            ));
        }
    }
    for name in lists.table_only {
        if !lists.table.contains(name) {
            wrong.push(format!("{name}: on TABLE_ONLY and not in the table"));
        }
        if lists.registered.contains(*name) {
            wrong.push(format!(
                "{name}: on TABLE_ONLY and registered by generate_handler! — it has a \
                 wrapper, so it is an ordinary table command"
            ));
        }
    }
    wrong
}

#[test]
fn every_registered_command_is_in_the_table_or_on_one_list() {
    let table: Vec<&str> = TABLE.iter().map(|entry| entry.name).collect();
    let desktop_only: Vec<&str> = DESKTOP_ONLY.iter().map(|(name, _)| *name).collect();
    let table_only: Vec<&str> = TABLE_ONLY.iter().map(|(name, _)| *name).collect();
    let wrong = misplaced(&Lists {
        table: &table,
        desktop_only: &desktop_only,
        not_yet: NOT_YET,
        table_only: &table_only,
        registered: &registered(),
    });
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// **The rules above, each seen to refuse** — over lists made up for it, because the real ones
/// are in order and so show only that nothing is wrong. Both directions of the table-only
/// exception: a table command with no wrapper is refused until it is listed, and a listed one
/// is refused once it has a wrapper or has left the table.
#[test]
fn a_command_in_the_wrong_place_is_named() {
    let registered: BTreeSet<String> = ["both", "desktop", "later"]
        .iter()
        .map(|name| name.to_string())
        .collect();
    let lists = |table: &'static [&'static str], table_only: &'static [&'static str]| {
        misplaced(&Lists {
            table,
            desktop_only: &["desktop"],
            not_yet: &["later"],
            table_only,
            registered: &registered,
        })
    };
    assert_eq!(lists(&["both", "web"], &["web"]), Vec::<String>::new());

    // In the table, registered by nobody, and on no list: stale until somebody says why.
    let unlisted = lists(&["both", "web"], &[]);
    assert_eq!(unlisted.len(), 1, "{unlisted:?}");
    assert!(unlisted[0].starts_with("web: "), "{unlisted:?}");
    assert!(unlisted[0].contains("TABLE_ONLY"), "{unlisted:?}");

    // Listed as table-only, and gone from the table.
    let gone = lists(&["both"], &["web"]);
    assert_eq!(gone, ["web: on TABLE_ONLY and not in the table"]);

    // Listed as table-only, and the app registers it after all.
    let wrapped = lists(&["both"], &["both"]);
    assert_eq!(wrapped.len(), 1, "{wrapped:?}");
    assert!(wrapped[0].starts_with("both: on TABLE_ONLY and registered"));

    // The three rules that were already here.
    let unplaced = lists(&["web"], &["web"]);
    assert_eq!(unplaced.len(), 1, "{unplaced:?}");
    assert!(unplaced[0].starts_with("both: registered"), "{unplaced:?}");
    let twice = lists(&["both", "desktop", "web"], &["web"]);
    assert_eq!(twice.len(), 1, "{twice:?}");
    assert!(twice[0].starts_with("desktop: in more than one place"));
}

/// A table-only command has no wrapper in this crate — registered or not. One written and
/// left out of `generate_handler!` would be dead code that reads as a command.
#[test]
fn a_table_only_command_has_no_wrapper_here() {
    let sources = sources();
    for (name, _) in TABLE_ONLY {
        let needle = format!("fn {name}(");
        assert!(
            !sources.iter().any(|text| text.contains(&needle)),
            "{name} is on TABLE_ONLY and this crate defines a function of that name"
        );
    }
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
        // A table-only command has no wrapper to compare with: its entry is the wire.
        .filter(|entry| !TABLE_ONLY.iter().any(|(name, _)| *name == entry.name))
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
    assert!(TABLE_ONLY.iter().all(|(_, why)| !why.trim().is_empty()));
}
