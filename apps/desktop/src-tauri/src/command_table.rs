//! **The fence between the core's command table and this app's `generate_handler!`** — the two
//! lists the light-app spec §2.4 says the table costs, and what keeps them one list's worth of
//! truth.
//!
//! The desktop keeps its typed `#[tauri::command]` wrappers and the light app's hosts call
//! `grimoire_core::dispatch` instead (`crates/grimoire-core/src/commands.rs`), so a command can be
//! renamed, added or dropped in one and not the other. Four tests hold them together:
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
//! - **A wrapper that takes the raw request is a `bytes` entry, and the other way round** —
//!   [`RAW_BODY`], held over every command this app registers and not only the table's. Such a
//!   wrapper's wire is a body and its headers, which the comparison above cannot see: Tauri
//!   fills the `Request` in, so both sides read as taking nothing.
//!
//! Markus chose the reads first (2026-10-03), and the same day the table came to cover the light
//! app (phase 4, step 4.2): every write, feed and sync command a light install can answer joined
//! it, so an Android or a web host refuses no page. The scanner's ten followed in phase 7's step
//! 7.3 (2026-10-07). [`NOT_YET`] is what is left, each group with what it waits on — the picture
//! warms and `share/`. A command leaves it for the table with one line written in each place.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use grimoire_core::commands::{Kind, TABLE};

/// Commands that name this host — a window, its updater, its file dialogs, its mirror, its
/// launch — and never join the table, each with the reason.
const DESKTOP_ONLY: &[(&str, &str)] = &[
    (
        "archive_export",
        "Rust-owned native save dialog for a full local ZIP archive",
    ),
    (
        "archive_import",
        "Rust-owned native picker and destructive restore confirmation",
    ),
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
    // share — `share/` is still this crate's: the spec listed its snapshot and cache, and no step
    // of the extraction moved them. The light edition draws no shared view, and the collection's
    // Share control shows only to a connected reader.
    "share_list",
    "share_create",
    "share_refresh",
    "share_revoke",
    "share_open",
];

/// **The commands whose wire is a raw body** — a wrapper here takes Tauri's
/// `tauri::ipc::Request`, and its table entry is of kind `bytes`.
///
/// **A named exception to "exactly the arguments its wrapper takes", because that rule passes
/// these two without looking at them.** A wrapper's parameters are the wire for every other
/// command; here the wire is the request's body and its headers, and the `Request` they arrive
/// in is one of the parameters Tauri fills in itself — so the comparison sees a wrapper that
/// takes nothing and an entry that declares nothing, and agrees. What it cannot see is held
/// another way, by `a_raw_body_wrapper_is_a_bytes_entry_and_the_other_way_round`:
///
/// - **of every command `generate_handler!` registers** — in the table or on either list —
///   the wrapper takes the raw request exactly when its name is here, and a table entry is
///   `bytes` exactly when its name is here. So neither side can grow a body the other does
///   not carry, and a new raw-body command fails until it is written down. That makes a
///   raw-body command with *no* table entry a failure too: there is none today, and one that
///   is the desktop's for good would be the day to give this list a second kind of row;
/// - such an entry declares **no named argument**: on a host of the table the call's arguments
///   object *is* the headers (`commands::Carried`), so a named one would be a key the desktop's
///   wrapper has nowhere to read.
///
/// What a header is called and how it is read is one definition, not two to compare: both
/// callers hand `grimoire_core::scanner::frame_from` and `capture_from` a lookup by the core's
/// own three names. The page's spelling of those names is `ipc.test.ts`'s to pin.
const RAW_BODY: &[&str] = &["scanner_capture", "scanner_frame"];

/// The commands `generate_handler!` registers, by their last path segment — the name a page
/// invokes. Read out of `desktop.rs` as text, as `packages/fake/parity.test.ts` does.
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

/// What `name`'s `#[tauri::command]` wrapper takes.
#[derive(Debug, PartialEq)]
struct Wrapper {
    /// Its parameters as `(name, type)`, less the ones Tauri fills in itself — the state, the
    /// window, the request, the app, each a `tauri::` type — which leaves what a page sends by
    /// name.
    args: Vec<(String, String)>,
    /// Whether one of the parameters Tauri fills in is the raw request — a body and its headers,
    /// which is a wire of its own ([`RAW_BODY`]).
    raw: bool,
}

/// The parameters `name`'s `#[tauri::command]` wrapper takes — see [`Wrapper`].
fn wrapper_args(sources: &[String], name: &str) -> Vec<(String, String)> {
    wrapper(sources, name).args
}

fn wrapper(sources: &[String], name: &str) -> Wrapper {
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
            let mut raw = false;
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
                        // `Request<'_>`, however far its path is spelled out — and `Request`
                        // bare, with the lifetime elided, which is the same type.
                        let named = normalise(ty);
                        raw |= named == "Request" || named.starts_with("Request<");
                    }
                    current.clear();
                } else {
                    current.push(ch);
                }
            }
            found.push(Wrapper { args: names, raw });
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

/// Everything wrong with how the raw-body commands are declared, one sentence each — the three
/// rules [`RAW_BODY`] states, over whatever lists it is handed.
fn raw_body_faults(
    raw_body: &[&str],
    wrappers: &[(&str, Wrapper)],
    bytes_entries: &[(&str, usize)],
) -> Vec<String> {
    let mut wrong = Vec::new();
    for (name, wrapper) in wrappers {
        match (wrapper.raw, raw_body.contains(name)) {
            (true, false) => wrong.push(format!(
                "{name}: its wrapper takes the raw request and it is not on RAW_BODY — its \
                 body and headers are a wire nothing here compares"
            )),
            (false, true) => wrong.push(format!(
                "{name}: on RAW_BODY, and its wrapper takes no `tauri::ipc::Request`"
            )),
            _ => {}
        }
    }
    for (name, named) in bytes_entries {
        if !raw_body.contains(name) {
            wrong.push(format!(
                "{name}: a `bytes` entry in the table, and not on RAW_BODY"
            ));
        }
        if *named > 0 {
            wrong.push(format!(
                "{name}: a `bytes` entry that declares {named} named argument(s) — its \
                 arguments object is its headers, and the wrapper has nowhere to read one"
            ));
        }
    }
    for name in raw_body {
        if !bytes_entries.iter().any(|(entry, _)| entry == name) {
            wrong.push(format!(
                "{name}: on RAW_BODY, and its table entry is not `bytes`"
            ));
        }
    }
    wrong
}

/// **The raw-body commands, held where the argument comparison is blind** — see [`RAW_BODY`].
#[test]
fn a_raw_body_wrapper_is_a_bytes_entry_and_the_other_way_round() {
    let sources = sources();
    // Every wrapper the app registers, not only the table's: a raw-body command on
    // `DESKTOP_ONLY` or `NOT_YET` reads the same unseen wire.
    let registered = registered();
    let wrappers: Vec<(&str, Wrapper)> = registered
        .iter()
        .map(|name| (name.as_str(), wrapper(&sources, name)))
        .collect();
    assert!(
        TABLE
            .iter()
            .filter(|entry| !TABLE_ONLY.iter().any(|(name, _)| *name == entry.name))
            .all(|entry| registered.contains(entry.name)),
        "a table command with a wrapper this sweep did not read"
    );
    let bytes_entries: Vec<(&str, usize)> = TABLE
        .iter()
        .filter(|entry| entry.kind == Kind::Bytes)
        .map(|entry| (entry.name, entry.args.len()))
        .collect();
    let wrong = raw_body_faults(RAW_BODY, &wrappers, &bytes_entries);
    assert!(wrong.is_empty(), "{wrong:#?}");
    // And it is not vacuous: the two are really there, and really read as raw.
    assert_eq!(bytes_entries.len(), RAW_BODY.len());
    assert!(RAW_BODY
        .iter()
        .all(|name| wrappers.iter().any(|(w, read)| w == name && read.raw)));
}

/// **Each of those rules, seen to refuse** — over lists made up for it, as
/// `a_command_in_the_wrong_place_is_named` does for the placement rules.
#[test]
fn a_raw_body_command_declared_wrong_is_named() {
    let wrapper = |raw: bool| Wrapper {
        args: Vec::new(),
        raw,
    };
    let in_order = raw_body_faults(
        &["frame"],
        &[("frame", wrapper(true)), ("list", wrapper(false))],
        &[("frame", 0)],
    );
    assert_eq!(in_order, Vec::<String>::new());

    // A wrapper that reads the request, written down nowhere.
    let unlisted = raw_body_faults(&[], &[("frame", wrapper(true))], &[]);
    assert_eq!(unlisted.len(), 1, "{unlisted:?}");
    assert!(unlisted[0].starts_with("frame: its wrapper takes the raw request"));

    // Listed, and the wrapper takes named arguments like any other.
    let no_request = raw_body_faults(&["frame"], &[("frame", wrapper(false))], &[("frame", 0)]);
    assert_eq!(no_request.len(), 1, "{no_request:?}");
    assert!(no_request[0].contains("takes no `tauri::ipc::Request`"));

    // Listed, with a raw wrapper, and the table would refuse the body it sends.
    let not_bytes = raw_body_faults(&["frame"], &[("frame", wrapper(true))], &[]);
    assert_eq!(not_bytes.len(), 1, "{not_bytes:?}");
    assert!(not_bytes[0].ends_with("its table entry is not `bytes`"));

    // A `bytes` entry nobody listed, and one that grew a named argument.
    let stray = raw_body_faults(&[], &[("length", wrapper(false))], &[("length", 0)]);
    assert_eq!(stray.len(), 1, "{stray:?}");
    assert!(stray[0].ends_with("not on RAW_BODY"));
    let named = raw_body_faults(&["frame"], &[("frame", wrapper(true))], &[("frame", 1)]);
    assert_eq!(named.len(), 1, "{named:?}");
    assert!(named[0].contains("declares 1 named argument"));
}

/// The reader of a wrapper's parameters tells the raw request from the rest by its type, and
/// still leaves it out of what a page sends by name.
#[test]
fn a_wrapper_that_takes_the_request_is_read_as_raw() {
    let source = "#[tauri::command]\npub async fn probe_frame(\n    state: \
                  tauri::State<'_, Arc<AppState>>,\n    request: tauri::ipc::Request<'_>,\n    \
                  webview: tauri::Webview,\n) -> Result<(), String> {\n    Ok(())\n}\n\n\
                  #[tauri::command]\npub fn probe_named(state: tauri::State<'_, Arc<AppState>>, \
                  request_id: i64) -> bool {\n    true\n}\n\n\
                  #[tauri::command]\npub fn probe_elided(request: tauri::ipc::Request) -> bool \
                  {\n    true\n}\n\n\
                  #[tauri::command]\npub fn probe_other(sent: RequestLog) -> bool {\n    true\n}\n"
        .to_owned();
    let sources = [source];
    assert_eq!(
        wrapper(&sources, "probe_frame"),
        Wrapper {
            args: Vec::new(),
            raw: true
        }
    );
    // A parameter merely *named* for a request is an argument like any other.
    assert_eq!(
        wrapper(&sources, "probe_named"),
        Wrapper {
            args: vec![("request_id".to_owned(), "i64".to_owned())],
            raw: false
        }
    );
    // The lifetime elided is the same type, and was once read as no request at all.
    assert_eq!(
        wrapper(&sources, "probe_elided"),
        Wrapper {
            args: Vec::new(),
            raw: true
        }
    );
    // And a type that only *starts* with the word is the page's own argument.
    assert_eq!(
        wrapper(&sources, "probe_other"),
        Wrapper {
            args: vec![("sent".to_owned(), "RequestLog".to_owned())],
            raw: false
        }
    );
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
