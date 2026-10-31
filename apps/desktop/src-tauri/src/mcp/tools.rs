//! The tools an agent is offered, and what each one calls.
//!
//! **Every tool is a translation, never an implementation.** Each builds the arguments of one or two
//! commands of `grimoire_core::commands`' table and answers through [`dispatch`] — the same bodies
//! the light app's hosts answer with, run on this process's own connections (`owned` writes rebuild
//! the facet index's `owned` dimension, every write passes `with_write`'s fence and the capture
//! triggers). What a tool adds is the shape an agent reads: camelCase JSON carrying the fields a
//! question about a collection needs, with the ids a follow-up call takes, and nothing a model would
//! have to wade through (image URIs, legality masks, sort keys).
//!
//! **Reads**: `find_cards` and `get_card` over the card database, `search_collection`,
//! `search_wishlist`, `list_folders`, `list_decks` and `get_deck` over the reader's own — and the
//! read graph's three, `graph_schema`, `graph_validate` and `graph_query`, which hand an agent the
//! whole of the reader's data as one GraphQL schema (`crates/grimoire-graph`): the schema to write
//! a home widget's query against, a check of a draft with each problem's line and column, and the
//! answer, exactly as the page's `graphql_query` would get it.
//! **Writes**: `add_to_collection`, `add_to_wishlist` and `add_card_to_deck` — the three adds issue
//! #1396 names, each the press of the same name in the app. Nothing here changes or removes a row
//! of the reader's collection, wishlist or decks: an agent proposing a deletion asks the reader,
//! who has the app open.
//!
//! **Custom widgets are the one exception, and only for the widgets themselves** (the owner's
//! decision, 2026-10-31): a widget is something an agent writes for the reader, so it may write it
//! again. `widget_vocabulary` hands an agent the catalogue (the committed prompt and contract);
//! `widget_check` runs `widget_create`'s checks — the query by the read graph, the spec by the
//! catalogue's contract ([`spec_problems`]) — and stores nothing; `widget_preview` runs the query
//! and answers the state the page would draw the spec over ([`widget_state`]); `widget_list` and
//! `widget_get` read the stored ones (`grimoire_core::custom_widgets`, user schema v68); and
//! `widget_create`, `widget_update` and `widget_delete` write them, checked first. A deleted
//! widget's placed copies are taken off the home page by the page itself.
//!
//! **A write tells every window** ([`announce`]). `crate::changes` emits `db:changed` only while a
//! second window is open, since the window that pressed already knows; a write no window made has
//! no such window, so each write tool emits the event itself, naming the tables it writes.

use crate::sync::AppState;
use grimoire_core::commands::dispatch;
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// What a call came to.
pub enum Called {
    /// The tool ran; its answer as JSON.
    Done(Value),
    /// The tool refused, in a sentence the agent can act on.
    Refused(String),
    /// No tool has that name — a protocol error, not a refusal.
    NoSuchTool,
}

/// The most rows one call answers. A page of a collection is a few hundred bytes a row; an agent
/// wanting more pages with `offset`.
const MAX_LIMIT: i64 = 200;

/// The largest quantity one add takes — the issue's allow-list figure for an intent, and a
/// generous one for a press: an agent asked for "four" that sends 4000 is refused, not obeyed.
const MAX_QUANTITY: i64 = 99;

/// The pile a deck add with no pile named makes when the list has no main pile yet —
/// `packages/ui/features/decks/deckQuery.ts`'s `DEFAULT_CATEGORY_NAME`, the app's own word for it.
const DEFAULT_PILE: &str = "Main deck";

/// The tables each write tool can touch, as `db:changed` names them. Held to the schema's own list
/// by `every_announced_table_is_a_user_table`.
const COLLECTION_TABLES: &[&str] = &["collection_entries", "activity"];
const WISHLIST_TABLES: &[&str] = &["wishlist_entries", "activity"];
/// A deck add writes the card or a token entry, may make the pile it names, records the deck's
/// audit and undo rows, stamps the deck, and rewrites a theory deck's managed wishlist folder.
const DECK_TABLES: &[&str] = &[
    "deck_cards",
    "deck_categories",
    "deck_tokens",
    "deck_token_printings",
    "deck_audit",
    "deck_undo",
    "decks",
    "wishlist_entries",
    "wishlist_folders",
    "activity",
];

/// A custom widget's write touches its own table and nothing else.
const CUSTOM_WIDGET_TABLES: &[&str] = &["custom_widgets"];

/// The footprint a created widget gets when the agent names none, in grid cells.
const DEFAULT_WIDGET_W: i64 = 4;
const DEFAULT_WIDGET_H: i64 = 3;

/// **The widget catalogue's contract** — every component's props and every action's params as
/// JSON Schema, the committed snapshot `catalog.test.tsx` holds to `catalog.ts` byte for byte
/// ([generated-widgets.md](../../../../../docs/reference/generated-widgets.md)). It is what lets
/// this server check a spec with no TypeScript running.
const CATALOG_CONTRACT: &str =
    include_str!("../../../../../packages/ui/features/home/generated/catalog.contract.json");

/// **The prompt a model writes a widget's spec from** — json-render's, with the app's
/// `CATALOG_RULES`, the second committed snapshot `catalog.test.tsx` holds to `catalog.ts`.
/// `widget_vocabulary` answers it, and so does the MCP prompt `custom_widget` (`rpc.rs`).
pub const CATALOG_PROMPT: &str =
    include_str!("../../../../../packages/ui/features/home/generated/catalog.prompt.md");

/// The actions json-render answers itself, on the widget's own state, whatever the catalogue
/// declares.
const BUILT_IN_ACTIONS: [&str; 4] = ["setState", "pushState", "removeState", "validateForm"];

/// [`CATALOG_CONTRACT`], parsed once. A snapshot that does not parse is a broken build, which
/// `the_catalogue_contract_parses_and_names_components_and_actions` catches before any agent can.
fn contract() -> &'static Value {
    static CONTRACT: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(CATALOG_CONTRACT).expect("the committed catalogue contract is JSON")
    })
}

/// Every tool, as `tools/list` answers it.
pub fn list() -> Vec<Value> {
    let read = json!({ "readOnlyHint": true, "openWorldHint": false });
    let add = json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false,
    });
    // A widget's own rewrite and removal: the only tools that change or remove a row.
    let edit = json!({
        "readOnlyHint": false,
        "destructiveHint": true,
        "idempotentHint": true,
        "openWorldHint": false,
    });
    let remove = json!({
        "readOnlyHint": false,
        "destructiveHint": true,
        "idempotentHint": false,
        "openWorldHint": false,
    });
    let widget_id = json!({ "type": "integer", "description": "From widget_list." });
    let widget_name = json!({ "type": "string", "maxLength": grimoire_core::custom_widgets::MAX_NAME_CHARS, "description": "The widget's title." });
    let widget_description = json!({ "type": "string", "maxLength": grimoire_core::custom_widgets::MAX_DESCRIPTION_CHARS, "description": "What it shows, in a sentence (default empty)." });
    let widget_spec_arg = json!({ "type": "object", "description": "The json-render spec: root (an element key), an optional settingsRoot (the element key of the settings popover's face), elements (key → { type, props, children, on?, visible?, repeat? }) and an optional state." });
    let widget_w = json!({ "type": "integer", "minimum": grimoire_core::custom_widgets::W.start(), "maximum": grimoire_core::custom_widgets::W.end(), "description": "Width in grid cells (default 4)." });
    let widget_h = json!({ "type": "integer", "minimum": grimoire_core::custom_widgets::H.start(), "maximum": grimoire_core::custom_widgets::H.end(), "description": "Height in grid cells (default 3)." });
    let limit = json!({
        "type": "integer", "minimum": 1, "maximum": MAX_LIMIT,
        "description": "How many rows to answer (default 50).",
    });
    let offset = json!({
        "type": "integer", "minimum": 0,
        "description": "Rows to skip, for the next page (default 0).",
    });
    let card_id = json!({
        "type": "string",
        "description": "The printing's Scryfall id, from find_cards.",
    });
    let quantity = json!({
        "type": "integer", "minimum": 1, "maximum": MAX_QUANTITY,
        "description": "How many copies (default 1).",
    });
    let finish = json!({
        "type": "string", "enum": ["nonfoil", "foil", "etched"],
    });
    let list_variant = json!({
        "type": "string", "enum": ["live", "theory"],
        "description": "The deck's actual list (live, the default) or its theory list.",
    });
    let document = json!({
        "type": "string",
        "description": "A GraphQL query document over the schema graph_schema answers.",
    });
    vec![
        tool(
            "graph_schema",
            "Read the data schema",
            "The whole of the reader's data — collection, wishlist, decks, the card database, \
             Scryfall tags, prices and the home page — as one read-only GraphQL schema (SDL), \
             with a description on every type and field. Write a home widget's data query \
             against it; check it with graph_validate and run it with graph_query.",
            json!({}),
            &[],
            &read,
        ),
        tool(
            "graph_validate",
            "Check a data query",
            "Check a GraphQL query against the schema without running it. Answers valid, and \
             every problem with its line and column. Only queries are accepted (the schema is \
             read-only), nested at most eight selection sets deep.",
            json!({ "query": document }),
            &["query"],
            &read,
        ),
        tool(
            "graph_query",
            "Run a data query",
            "Run a GraphQL query against the reader's data and answer it as the app's widgets \
             get it: data, errors (a field that failed is null beside the rest) and \
             extensions.invalidatedBy, the parts of the app whose changes make the answer stale.",
            json!({
                "query": document,
                "variables": { "type": "object", "description": "The query's variables." },
                "operationName": { "type": "string", "description": "Which operation to run, when the document holds several." },
            }),
            &["query"],
            &read,
        ),
        tool(
            "find_cards",
            "Find cards",
            "Search the card database (every Magic card, not just the user's) by name. Answers \
             printings with their Scryfall ids (cardId), which every add tool takes. By default \
             one printing per card; set allPrintings to choose a specific set's printing.",
            json!({
                "query": { "type": "string", "description": "Words of the card's name." },
                "set": { "type": "string", "description": "Only this set code, e.g. \"lea\"." },
                "allPrintings": { "type": "boolean", "description": "Every printing rather than one per card." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many to answer (default 10)." },
            }),
            &["query"],
            &read,
        ),
        tool(
            "get_card",
            "Get card",
            "One printing's details: oracle text, type, mana cost, the finishes it was made in, \
             its legalities and market prices, and how many the user owns.",
            json!({ "cardId": card_id }),
            &["cardId"],
            &read,
        ),
        tool(
            "search_collection",
            "Search collection",
            "The cards the user owns, filtered by name words and optionally one folder. Each \
             row is one printing, finish and condition in one folder, with its quantity.",
            json!({
                "query": { "type": "string", "description": "Words of the card's name; omit for everything." },
                "folderId": { "type": "integer", "description": "Only this collection folder (from list_folders)." },
                "limit": limit,
                "offset": offset,
            }),
            &[],
            &read,
        ),
        tool(
            "search_wishlist",
            "Search wishlist",
            "The cards the user wants, filtered by name words and optionally one wishlist folder.",
            json!({
                "query": { "type": "string", "description": "Words of the card's name; omit for everything." },
                "folderId": { "type": "integer", "description": "Only this wishlist folder (from list_folders)." },
                "limit": limit,
                "offset": offset,
            }),
            &[],
            &read,
        ),
        tool(
            "list_folders",
            "List folders",
            "The user's folders in the collection, the wishlist or the deck list, with their ids. \
             Only collection folders of kind \"user\" can be added to; the others belong to decks.",
            json!({
                "list": { "type": "string", "enum": ["collection", "wishlist", "decks"] },
            }),
            &["list"],
            &read,
        ),
        tool(
            "list_decks",
            "List decks",
            "The user's decks with their ids, formats and card counts, optionally filtered by \
             name words. Archived decks are left out unless asked for.",
            json!({
                "query": { "type": "string", "description": "Words of the deck's name." },
                "includeArchived": { "type": "boolean" },
            }),
            &[],
            &read,
        ),
        tool(
            "get_deck",
            "Get deck",
            "One deck's cards, pile by pile (main deck, sideboard, commander, maybeboard and \
             the user's own piles).",
            json!({
                "deckId": { "type": "integer", "description": "From list_decks." },
                "list": list_variant,
            }),
            &["deckId"],
            &read,
        ),
        tool(
            "add_to_collection",
            "Add to collection",
            "Add copies of one printing to the user's collection, in the root or in one of \
             their collection folders.",
            json!({
                "cardId": card_id,
                "quantity": quantity,
                "finish": finish,
                "condition": { "type": "string", "enum": ["NM", "LP", "MP", "HP", "DMG"], "description": "Default: the user's own default condition." },
                "folderId": { "type": "integer", "description": "A collection folder of kind \"user\" (from list_folders); omit for the root." },
            }),
            &["cardId"],
            &add,
        ),
        tool(
            "add_to_wishlist",
            "Add to wishlist",
            "Add a card to the user's wishlist — this exact printing, or any printing of the \
             card with anyPrinting.",
            json!({
                "cardId": card_id,
                "quantity": quantity,
                "anyPrinting": { "type": "boolean", "description": "Wish for the card in any printing rather than this one." },
                "preferredFinish": finish,
                "folderId": { "type": "integer", "description": "A wishlist folder (from list_folders); omit for the root." },
            }),
            &["cardId"],
            &add,
        ),
        tool(
            "add_card_to_deck",
            "Add card to deck",
            "Add copies of one printing to a deck's pile. The pile is named, and made if the \
             deck has none of that name; omitted, it is the list's first main pile, or \"Main deck\".",
            json!({
                "deckId": { "type": "integer", "description": "From list_decks." },
                "cardId": card_id,
                "quantity": quantity,
                "pile": { "type": "string", "description": "The pile's name, e.g. \"Sideboard\" or \"Ramp\"." },
                "finish": finish,
                "list": list_variant,
            }),
            &["deckId", "cardId"],
            &add,
        ),
        tool(
            "widget_vocabulary",
            "Read the widget catalogue",
            "Everything a custom home widget may be built from, for writing one: the prompt — the \
             json-render spec format, every catalogue component with its props, the actions and \
             functions, and this app's rules (the query answer's data is the state root, the \
             widget's own inputs under /ui, settings under /settings in a settingsRoot face drawn \
             in the card's settings popover, palette colours, money through formatPrice) — and, \
             with includeContract, the same catalogue as JSON Schema: every component's props and \
             every action's params, what widget_check checks a spec against. Read it before \
             writing a spec.",
            json!({
                "includeContract": { "type": "boolean", "description": "Also answer the contract — every component's props and action's params as JSON Schema (about 56 KB)." },
            }),
            &[],
            &read,
        ),
        tool(
            "widget_check",
            "Check a custom widget",
            "Check a widget's data query and spec exactly as widget_create and widget_update do — \
             the query against the read graph, the spec against the catalogue's contract — and \
             store nothing. Either may be left out to check the other alone. Answers whether it \
             would be stored, and every problem named by element.",
            json!({
                "query": document,
                "spec": widget_spec_arg.clone(),
            }),
            &[],
            &read,
        ),
        tool(
            "widget_preview",
            "Preview a custom widget's state",
            "Run a widget's data query and answer the state its spec will be drawn over, built as \
             the home page builds it: the answer's data at the state root, /ui from the spec's \
             state.ui, /settings from the spec's state.settings with any settings given laid \
             over them. Use it to check the spec's $state, $item and repeat paths before storing. \
             The graph's own errors and the spec's problems, if any, are answered beside it.",
            json!({
                "query": document,
                "spec": widget_spec_arg.clone(),
                "settings": { "type": "object", "description": "Settings as a reader might have kept them, laid over the spec's own (default none)." },
            }),
            &["query"],
            &read,
        ),
        tool(
            "widget_list",
            "List custom widgets",
            "The reader's own home-page widgets, each with the id the home page places it by, its \
             name, description and footprint in grid cells. The query and the spec are left out — \
             widget_get answers them.",
            json!({}),
            &[],
            &read,
        ),
        tool(
            "widget_get",
            "Get a custom widget",
            "One custom widget whole: its name, description, data query, spec and footprint — what \
             widget_update starts from.",
            json!({ "widgetId": widget_id.clone() }),
            &["widgetId"],
            &read,
        ),
        tool(
            "widget_create",
            "Create a custom widget",
            "Store a custom widget the reader can then place on their home page from its Custom \
             widgets dialog. A widget is a GraphQL data query over the schema graph_schema \
             answers and a json-render spec ({ root, settingsRoot?, elements, state? }) built \
             from the app's widget catalogue — read widget_vocabulary for it, and try both with \
             widget_check and widget_preview first. Every element's type is a catalogue \
             component, its props that component's (every required prop present; a nullable one \
             may be null), its children keys of other elements, and its on.<event> actions \
             catalogue actions or json-render's setState, pushState, removeState and \
             validateForm. The spec's state root is the query answer's data — {\"$state\": \
             \"/decks\"} reads data.decks — with the widget's own inputs under /ui and its \
             settings under /settings. Settings are drawn in the card's settings popover, never \
             on the widget: name the element they start from in a top-level settingsRoot beside \
             root, bind its inputs to /settings/..., and the app keeps every change (no Save \
             button). A query or spec that does not fit is refused with every problem named. \
             Answers the stored widget.",
            json!({
                "name": widget_name.clone(),
                "description": widget_description.clone(),
                "query": document,
                "spec": widget_spec_arg.clone(),
                "w": widget_w.clone(),
                "h": widget_h.clone(),
            }),
            &["name", "query", "spec"],
            &add,
        ),
        tool(
            "widget_update",
            "Update a custom widget",
            "Change a stored custom widget: any of its name, description, data query, spec and \
             footprint, the rest left as they are. A query or spec given is checked as \
             widget_create checks it, and refused with every problem named. The reader's copies on \
             the home page draw the new widget at once. Answers the stored widget.",
            json!({
                "widgetId": widget_id.clone(),
                "name": widget_name,
                "description": widget_description,
                "query": document,
                "spec": widget_spec_arg,
                "w": widget_w,
                "h": widget_h,
            }),
            &["widgetId"],
            &edit,
        ),
        tool(
            "widget_delete",
            "Delete a custom widget",
            "Delete one of the reader's custom widgets. Its copies leave the home page with it, \
             and it cannot be undone — delete only a widget the reader asked to remove.",
            json!({ "widgetId": widget_id }),
            &["widgetId"],
            &remove,
        ),
    ]
}

fn tool(
    name: &str,
    title: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    annotations: &Value,
) -> Value {
    let mut annotations = annotations.clone();
    annotations["title"] = json!(title);
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        },
        "annotations": annotations,
    })
}

/// Run the tool `name` with `args`.
pub async fn call(state: &Arc<AppState>, name: &str, args: Value) -> Called {
    let args = Args(match args {
        Value::Object(map) => map,
        _ => Map::new(),
    });
    let answered = match name {
        "graph_schema" => Ok(json!({ "schema": crate::graph::graph().sdl() })),
        "graph_validate" => graph_validate(&args),
        "graph_query" => graph_query(state, &args).await,
        "find_cards" => find_cards(state, &args).await,
        "get_card" => get_card(state, &args).await,
        "search_collection" => search_collection(state, &args).await,
        "search_wishlist" => search_wishlist(state, &args).await,
        "list_folders" => list_folders(state, &args).await,
        "list_decks" => list_decks(state, &args).await,
        "get_deck" => get_deck(state, &args).await,
        "add_to_collection" => add_to_collection(state, &args).await,
        "add_to_wishlist" => add_to_wishlist(state, &args).await,
        "add_card_to_deck" => add_card_to_deck(state, &args).await,
        "widget_vocabulary" => widget_vocabulary(&args),
        "widget_check" => widget_check(&args),
        "widget_preview" => widget_preview(state, &args).await,
        "widget_list" => widget_list(state).await,
        "widget_get" => widget_get(state, &args).await,
        "widget_create" => widget_create(state, &args).await,
        "widget_update" => widget_update(state, &args).await,
        "widget_delete" => widget_delete(state, &args).await,
        _ => return Called::NoSuchTool,
    };
    match answered {
        Ok(answer) => Called::Done(answer),
        Err(why) => Called::Refused(why),
    }
}

/// `graph_validate`: the document checked, never run.
fn graph_validate(args: &Args) -> Result<Value, String> {
    let query = args.required_text("query")?;
    let problems = crate::graph::graph().validate(&query);
    Ok(json!({ "valid": problems.is_empty(), "problems": problems }))
}

/// `graph_query`: the document run on the read connection, on the blocking pool — the page's
/// `graphql_query` exactly, so an agent sees what a widget would.
async fn graph_query(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let query = args.required_text("query")?;
    let variables = match args.0.get("variables") {
        None | Some(Value::Null) => None,
        Some(v @ Value::Object(_)) => Some(v.clone()),
        Some(_) => return Err("variables must be an object.".to_owned()),
    };
    let operation = args.text("operationName")?;
    let core = state.core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response =
            crate::graph::graph().run(&core, &query, variables, operation.as_deref(), None);
        serde_json::to_value(response).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("the graph could not be read: {e}"))?
}

/// A tool's arguments, read with the refusal a wrong one deserves.
struct Args(Map<String, Value>);

impl Args {
    /// A string, trimmed; blank is absent.
    fn text(&self, name: &str) -> Result<Option<String>, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => {
                let s = s.trim();
                Ok((!s.is_empty()).then(|| s.to_owned()))
            }
            Some(_) => Err(format!("{name} must be a string.")),
        }
    }

    fn required_text(&self, name: &str) -> Result<String, String> {
        self.text(name)?
            .ok_or_else(|| format!("{name} is required."))
    }

    fn int(&self, name: &str) -> Result<Option<i64>, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_i64()
                .map(Some)
                .ok_or_else(|| format!("{name} must be a whole number.")),
        }
    }

    fn required_int(&self, name: &str) -> Result<i64, String> {
        self.int(name)?
            .ok_or_else(|| format!("{name} is required."))
    }

    /// A whole number in `min..=max`, `default` when absent.
    fn bounded(&self, name: &str, default: i64, min: i64, max: i64) -> Result<i64, String> {
        let n = self.int(name)?.unwrap_or(default);
        if (min..=max).contains(&n) {
            Ok(n)
        } else {
            Err(format!("{name} must be from {min} to {max}."))
        }
    }

    fn flag(&self, name: &str) -> Result<bool, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(format!("{name} must be true or false.")),
        }
    }

    /// One of `allowed`, or `default` when absent.
    fn choice(
        &self,
        name: &str,
        allowed: &[&str],
        default: Option<&str>,
    ) -> Result<Option<String>, String> {
        match self.text(name)? {
            None => Ok(default.map(str::to_owned)),
            Some(v) if allowed.contains(&v.as_str()) => Ok(Some(v)),
            Some(v) => Err(format!(
                "{name} cannot be {v:?}; use one of: {}.",
                allowed.join(", ")
            )),
        }
    }
}

/// One table command, by name.
async fn run(state: &Arc<AppState>, command: &str, args: Value) -> Result<Value, String> {
    dispatch(&state.core, command, args, None).await
}

/// A write, then `db:changed` naming `tables` — [`announce`]'s reason is the module doc's.
async fn write(
    state: &Arc<AppState>,
    command: &str,
    args: Value,
    tables: &'static [&'static str],
) -> Result<Value, String> {
    let answer = run(state, command, args).await?;
    announce(state, tables);
    Ok(answer)
}

/// Tell every window the tables a write touched, through the state's event sink — `WindowEvents`,
/// which emits to every window. Sent after the write has committed, so a window refetching on it
/// reads the new rows.
fn announce(state: &AppState, tables: &'static [&'static str]) {
    grimoire_core::events::emit(
        &*state.events,
        crate::changes::DB_CHANGED,
        &crate::changes::DbChanged {
            tables: tables.to_vec(),
        },
    );
}

/// The `keys` of an object, renamed `(out, in)`, leaving out the ones that are absent or null.
fn pick(value: &Value, keys: &[(&str, &str)]) -> Value {
    let mut out = Map::new();
    for (to, from) in keys {
        if let Some(v) = value.get(*from).filter(|v| !v.is_null()) {
            out.insert((*to).to_owned(), v.clone());
        }
    }
    Value::Object(out)
}

fn rows(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Whether every word of `query` is in `name`, ignoring case — the deck list's filter, which has
/// no search of its own.
fn matches_words(name: &str, query: Option<&str>) -> bool {
    let name = name.to_lowercase();
    query.is_none_or(|q| {
        q.to_lowercase()
            .split_whitespace()
            .all(|w| name.contains(w))
    })
}

async fn find_cards(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let query = args.required_text("query")?;
    let set = args.text("set")?.map(|s| s.to_lowercase());
    let limit = args.bounded("limit", 10, 1, 50)?;
    let all = args.flag("allPrintings")?;
    let found = run(
        state,
        "search_cards",
        json!({ "req": {
            "text": query,
            "setCode": set,
            "collapse": !all,
            "paperOnly": true,
            "limit": limit,
        }}),
    )
    .await?;
    let cards: Vec<Value> = rows(&found, "items")
        .iter()
        .map(|c| {
            pick(
                c,
                &[
                    ("cardId", "id"),
                    ("name", "name"),
                    ("set", "setCode"),
                    ("setName", "setName"),
                    ("collectorNumber", "collectorNumber"),
                    ("rarity", "rarity"),
                    ("manaCost", "manaCost"),
                    ("typeLine", "typeLine"),
                    ("price", "price"),
                ],
            )
        })
        .collect();
    Ok(json!({
        "total": found.get("total"),
        "totalIsCapped": found.get("totalIsCapped"),
        "cards": cards,
    }))
}

async fn get_card(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let card_id = args.required_text("cardId")?;
    let detail = run(state, "card_detail", json!({ "id": card_id })).await?;
    if detail.is_null() {
        return Err(format!(
            "No card has the id {card_id}. Use find_cards to look one up."
        ));
    }
    let mut card = pick(
        &detail,
        &[
            ("cardId", "id"),
            ("oracleId", "oracleId"),
            ("name", "name"),
            ("set", "setCode"),
            ("setName", "setName"),
            ("collectorNumber", "collectorNumber"),
            ("rarity", "rarity"),
            ("lang", "lang"),
            ("manaCost", "manaCost"),
            ("typeLine", "typeLine"),
            ("oracleText", "oracleText"),
            ("power", "power"),
            ("toughness", "toughness"),
            ("loyalty", "loyalty"),
            ("artist", "artist"),
            ("releasedAt", "releasedAt"),
            ("finishes", "finishes"),
            ("legalities", "legalities"),
            ("prices", "finishPrices"),
        ],
    );
    // Stored as JSON text in the corpus; an agent reads them better as JSON.
    for field in ["finishes", "legalities"] {
        if let Some(Value::String(raw)) = card.get(field) {
            if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
                card[field] = parsed;
            }
        }
    }
    if let Some(oracle) = detail.get("oracleId").and_then(Value::as_str) {
        if let Ok(holdings) = run(state, "card_holdings", json!({ "oracleId": oracle })).await {
            card["owned"] = holdings;
        }
    }
    Ok(card)
}

async fn search_collection(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let page = run(
        state,
        "collection_list",
        json!({ "query": {
            "text": args.text("query")?,
            "folderId": args.int("folderId")?,
            "limit": args.bounded("limit", 50, 1, MAX_LIMIT)?,
            "offset": args.bounded("offset", 0, 0, i64::from(u32::MAX))?,
        }}),
    )
    .await?;
    let entries: Vec<Value> = rows(&page, "items")
        .iter()
        .map(|e| {
            pick(
                e,
                &[
                    ("entryId", "id"),
                    ("cardId", "cardId"),
                    ("name", "name"),
                    ("set", "setCode"),
                    ("setName", "setName"),
                    ("collectorNumber", "collectorNumber"),
                    ("lang", "lang"),
                    ("finish", "finish"),
                    ("condition", "condition"),
                    ("quantity", "quantity"),
                    ("forTrade", "tradelistQuantity"),
                    ("folderId", "folderId"),
                    ("folder", "folderName"),
                    ("unitPrice", "unitPrice"),
                ],
            )
        })
        .collect();
    Ok(json!({ "total": page.get("total"), "entries": entries }))
}

async fn search_wishlist(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let folder = args.int("folderId")?;
    let page = run(
        state,
        "wishlist_list",
        // `folderId: null` is the wishlist's root there, so a search across every folder says
        // `flatten` — `WishlistQuery`'s own convention, the opposite of the collection's.
        json!({ "query": {
            "text": args.text("query")?,
            "folderId": folder,
            "flatten": folder.is_none(),
            "limit": args.bounded("limit", 50, 1, MAX_LIMIT)?,
            "offset": args.bounded("offset", 0, 0, i64::from(u32::MAX))?,
        }}),
    )
    .await?;
    let folders = run(state, "wishlist_folder_list", json!({})).await?;
    let folder_name = |id: &Value| {
        folders
            .as_array()
            .and_then(|all| all.iter().find(|f| f.get("id") == Some(id)))
            .and_then(|f| f.get("name").cloned())
    };
    let wishes: Vec<Value> = rows(&page, "items")
        .iter()
        .map(|w| {
            let mut wish = pick(
                w,
                &[
                    ("wishId", "id"),
                    ("cardId", "cardId"),
                    ("oracleId", "oracleId"),
                    ("name", "name"),
                    ("set", "setCode"),
                    ("collectorNumber", "collectorNumber"),
                    ("quantity", "quantity"),
                    ("preferredFinish", "preferredFinish"),
                    ("folderId", "folderId"),
                    ("unitPrice", "unitPrice"),
                ],
            );
            if wish.get("cardId").is_none() {
                wish["anyPrinting"] = json!(true);
            }
            if let Some(name) = w.get("folderId").and_then(folder_name) {
                wish["folder"] = name;
            }
            wish
        })
        .collect();
    Ok(json!({ "total": page.get("total"), "wishes": wishes }))
}

async fn list_folders(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let list = args
        .choice("list", &["collection", "wishlist", "decks"], None)?
        .ok_or("list is required.")?;
    let (command, keys): (&str, &[(&str, &str)]) = match list.as_str() {
        "collection" => (
            "collection_folder_list",
            &[
                ("folderId", "id"),
                ("parentId", "parentId"),
                ("name", "name"),
                ("kind", "kind"),
                ("deckId", "deckId"),
                ("locked", "locked"),
            ],
        ),
        "wishlist" => (
            "wishlist_folder_list",
            &[
                ("folderId", "id"),
                ("parentId", "parentId"),
                ("name", "name"),
                ("managedByDeckId", "managedDeckId"),
            ],
        ),
        _ => (
            "deck_folder_list",
            &[
                ("folderId", "id"),
                ("parentId", "parentId"),
                ("name", "name"),
            ],
        ),
    };
    let folders = run(state, command, json!({})).await?;
    let folders: Vec<Value> = folders
        .as_array()
        .map(|all| all.iter().map(|f| pick(f, keys)).collect())
        .unwrap_or_default();
    Ok(json!({ "folders": folders }))
}

async fn list_decks(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let query = args.text("query")?;
    let archived = args.flag("includeArchived")?;
    let decks = run(state, "deck_list", json!({})).await?;
    let decks: Vec<Value> = decks
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|d| archived || d.get("archived") != Some(&json!(true)))
                .filter(|d| {
                    let name = d.get("name").and_then(Value::as_str).unwrap_or("");
                    matches_words(name, query.as_deref())
                })
                .map(|d| {
                    pick(
                        d,
                        &[
                            ("deckId", "id"),
                            ("name", "name"),
                            ("format", "formatName"),
                            ("formatKey", "formatKey"),
                            ("cards", "cardCount"),
                            ("folderId", "folderId"),
                            ("archived", "archived"),
                            ("hasTheoryList", "theoryEnabled"),
                        ],
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "decks": decks }))
}

async fn get_deck(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let variant = args
        .choice("list", &["live", "theory"], Some("live"))?
        .unwrap_or_default();
    let detail = run(
        state,
        "deck_get",
        json!({ "id": deck_id, "variant": variant }),
    )
    .await?;
    let cards = rows(&detail, "cards");
    let piles: Vec<Value> = rows(&detail, "categories")
        .iter()
        .filter(|c| c.get("variant").and_then(Value::as_str) == Some(variant.as_str()))
        .map(|pile| {
            let id = pile.get("id");
            let in_pile: Vec<Value> = cards
                .iter()
                .filter(|c| c.get("categoryId") == id)
                .map(|c| {
                    pick(
                        c,
                        &[
                            ("cardId", "cardId"),
                            ("name", "name"),
                            ("quantity", "quantity"),
                            ("set", "setCode"),
                            ("collectorNumber", "collectorNumber"),
                            ("finish", "finish"),
                            ("manaCost", "manaCost"),
                            ("typeLine", "typeLine"),
                        ],
                    )
                })
                .collect();
            let mut pile = pick(
                pile,
                &[("pile", "name"), ("kind", "kind"), ("counts", "isActive")],
            );
            pile["cards"] = Value::Array(in_pile);
            pile
        })
        .collect();
    let mut deck = pick(
        detail.get("deck").unwrap_or(&Value::Null),
        &[
            ("deckId", "id"),
            ("name", "name"),
            ("format", "formatName"),
            ("formatKey", "formatKey"),
            ("description", "description"),
            ("cards", "cardCount"),
        ],
    );
    deck["list"] = json!(variant);
    deck["piles"] = Value::Array(piles);
    Ok(deck)
}

async fn add_to_collection(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let card_id = args.required_text("cardId")?;
    let quantity = args.bounded("quantity", 1, 1, MAX_QUANTITY)?;
    let finish = args
        .choice("finish", &grimoire_core::schema::FINISHES, Some("nonfoil"))?
        .unwrap_or_default();
    let condition = args.choice("condition", &["NM", "LP", "MP", "HP", "DMG"], None)?;
    let folder = args.int("folderId")?;
    let change = write(
        state,
        "collection_add",
        json!({ "entry": {
            "cardId": card_id,
            "finish": finish,
            "condition": condition,
            "quantity": quantity,
            "folderId": folder,
        }}),
        COLLECTION_TABLES,
    )
    .await?;
    Ok(json!({
        "added": quantity,
        "entryId": change.get("id"),
        "quantityNow": change.get("quantity"),
    }))
}

async fn add_to_wishlist(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let card_id = args.required_text("cardId")?;
    let quantity = args.bounded("quantity", 1, 1, MAX_QUANTITY)?;
    let finish = args.choice("preferredFinish", &grimoire_core::schema::FINISHES, None)?;
    let folder = args.int("folderId")?;
    let wish = if args.flag("anyPrinting")? {
        // A wish for the card rather than the printing names its oracle card, read off the
        // printing the agent found.
        let detail = run(state, "card_detail", json!({ "id": card_id })).await?;
        let oracle = detail.get("oracleId").and_then(Value::as_str);
        let name = detail.get("name").and_then(Value::as_str);
        let (Some(oracle), Some(name)) = (oracle, name) else {
            return Err(format!(
                "No card has the id {card_id}. Use find_cards to look one up."
            ));
        };
        json!({
            "oracleId": oracle,
            "name": name,
            "quantity": quantity,
            "preferredFinish": finish,
            "folderId": folder,
        })
    } else {
        json!({
            "cardId": card_id,
            "quantity": quantity,
            "preferredFinish": finish,
            "folderId": folder,
        })
    };
    let change = write(
        state,
        "wishlist_add",
        json!({ "wish": wish }),
        WISHLIST_TABLES,
    )
    .await?;
    Ok(json!({
        "added": quantity,
        "wishId": change.get("id"),
        "quantityNow": change.get("quantity"),
    }))
}

async fn add_card_to_deck(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let deck_id = args.required_int("deckId")?;
    let card_id = args.required_text("cardId")?;
    let quantity = args.bounded("quantity", 1, 1, MAX_QUANTITY)?;
    let finish = args.choice("finish", &grimoire_core::schema::FINISHES, None)?;
    let variant = args
        .choice("list", &["live", "theory"], Some("live"))?
        .unwrap_or_default();
    let pile = args.text("pile")?;
    // No pile named: the list's first main pile, or `Main deck` when it has none yet — a new
    // deck has only its predefined piles. The deck editor's own Add picks a pile by the card's
    // type (`autoCategoryFor`), which is TypeScript's rule to draw and not repeated here; an
    // agent that wants "Creatures" names it.
    let (category_id, category_name) = match pile {
        Some(name) => (None, Some(name)),
        None => {
            let piles = run(
                state,
                "deck_category_list",
                json!({ "deckId": deck_id, "variant": variant }),
            )
            .await?;
            let main = piles.as_array().and_then(|all| {
                all.iter()
                    .find(|p| p.get("kind").and_then(Value::as_str) == Some("main"))
                    .and_then(|p| p.get("id").and_then(Value::as_i64))
            });
            match main {
                Some(id) => (Some(id), None),
                None => (None, Some(DEFAULT_PILE.to_owned())),
            }
        }
    };
    let change = write(
        state,
        "deck_add_card",
        json!({
            "deckId": deck_id,
            "cardId": card_id,
            "categoryId": category_id,
            "categoryName": category_name,
            "variant": variant,
            "finish": finish,
            "quantity": quantity,
        }),
        DECK_TABLES,
    )
    .await?;
    Ok(json!({
        "added": quantity,
        // `id: 0` is `deck::add_card`'s answer for a token or an emblem, filed as a token entry.
        "filedAsToken": change.get("id") == Some(&json!(0)),
        "quantityNow": change.get("quantity"),
    }))
}

async fn widget_list(state: &Arc<AppState>) -> Result<Value, String> {
    let widgets = run(state, "custom_widgets", json!({})).await?;
    let widgets: Vec<Value> = widgets
        .as_array()
        .map(|all| {
            all.iter()
                .map(|w| {
                    pick(
                        w,
                        &[
                            ("widgetId", "id"),
                            ("name", "name"),
                            ("description", "description"),
                            ("w", "w"),
                            ("h", "h"),
                        ],
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "widgets": widgets }))
}

/// `widget_vocabulary`: the committed prompt, and the contract when asked.
fn widget_vocabulary(args: &Args) -> Result<Value, String> {
    let mut answer = json!({ "prompt": CATALOG_PROMPT });
    if args.flag("includeContract")? {
        answer["contract"] = contract().clone();
    }
    Ok(answer)
}

/// A widget's data query, as written: absent, or a string that is not blank.
fn query_arg(args: &Args) -> Result<Option<String>, String> {
    match args.0.get("query") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(q)) if !q.trim().is_empty() => Ok(Some(q.clone())),
        Some(Value::String(_)) => Err("query cannot be blank.".to_owned()),
        Some(_) => Err("query must be a string.".to_owned()),
    }
}

/// A widget's spec: absent, or an object.
fn spec_arg(args: &Args) -> Result<Option<Value>, String> {
    match args.0.get("spec") {
        None | Some(Value::Null) => Ok(None),
        Some(spec @ Value::Object(_)) => Ok(Some(spec.clone())),
        Some(_) => Err("spec must be a JSON object.".to_owned()),
    }
}

/// Every way a query does not fit the read graph, one sentence each with its place.
fn query_problems(query: &str) -> Vec<String> {
    crate::graph::graph()
        .validate(query)
        .into_iter()
        .map(|p| match (p.line, p.column) {
            (Some(line), Some(column)) => {
                format!("The query, line {line}, column {column}: {}", p.message)
            }
            _ => format!("The query: {}", p.message),
        })
        .collect()
}

/// Every problem of whichever of the two halves was given — the check `widget_check`,
/// `widget_create` and `widget_update` share, so the three cannot disagree.
fn widget_problems(query: Option<&str>, spec: Option<&Value>) -> Vec<String> {
    let mut problems = query.map(query_problems).unwrap_or_default();
    if let Some(spec) = spec {
        problems.extend(spec_problems(spec));
    }
    problems
}

/// `widget_check`: [`widget_problems`], storing nothing.
fn widget_check(args: &Args) -> Result<Value, String> {
    let query = query_arg(args)?;
    let spec = spec_arg(args)?;
    if query.is_none() && spec.is_none() {
        return Err("Give a query, a spec or both to check.".to_owned());
    }
    let problems = widget_problems(query.as_deref(), spec.as_ref());
    Ok(json!({ "valid": problems.is_empty(), "problems": problems }))
}

/// **The state a spec is drawn over, from an answer** — `widgetState.ts`' `widgetState`, which the
/// page draws with, here so an agent can see it before storing: the answer's data at the root less
/// the two keys the widget owns, `/ui` from the spec's `state.ui`, and `/settings` from the spec's
/// `state.settings` with `saved` laid over it key by key. Both sides hold to one golden
/// (`generated/__golden__/widget-state.json`, `the_widget_state_is_the_page_s`).
fn widget_state(spec: Option<&Value>, data: &Value, saved: Option<&Map<String, Value>>) -> Value {
    let mut state = Map::new();
    if let Some(data) = data.as_object() {
        for (key, value) in data {
            if key != "ui" && key != "settings" {
                state.insert(key.clone(), value.clone());
            }
        }
    }
    let seeds = spec.and_then(|s| s.get("state")).and_then(Value::as_object);
    let ui = seeds
        .and_then(|s| s.get("ui"))
        .filter(|ui| ui.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut settings = seeds
        .and_then(|s| s.get("settings"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in saved.into_iter().flatten() {
        settings.insert(key.clone(), value.clone());
    }
    state.insert("ui".to_owned(), ui);
    state.insert("settings".to_owned(), Value::Object(settings));
    Value::Object(state)
}

/// `widget_preview`: the query run as `graph_query` runs it, and [`widget_state`] of its answer.
async fn widget_preview(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let query = query_arg(args)?.ok_or("query is required.")?;
    let spec = spec_arg(args)?;
    let saved = match args.0.get("settings") {
        None | Some(Value::Null) => None,
        Some(Value::Object(saved)) => Some(saved.clone()),
        Some(_) => return Err("settings must be an object.".to_owned()),
    };
    let core = state.core.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let response = crate::graph::graph().run(&core, &query, None, None, None);
        serde_json::to_value(response).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("the graph could not be read: {e}"))??;
    let data = response.get("data").cloned().unwrap_or(Value::Null);
    let mut answer = json!({
        "state": widget_state(spec.as_ref(), &data, saved.as_ref()),
    });
    if let Some(errors) = response
        .get("errors")
        .filter(|e| e.as_array().is_some_and(|e| !e.is_empty()))
    {
        answer["errors"] = errors.clone();
    }
    if let Some(spec) = &spec {
        let problems = spec_problems(spec);
        if !problems.is_empty() {
            answer["specProblems"] = json!(problems);
        }
    }
    Ok(answer)
}

/// `widget_get`: one stored widget, whole — the table's list, found by id.
async fn widget_get(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let id = args.required_int("widgetId")?;
    let widgets = run(state, "custom_widgets", json!({})).await?;
    widgets
        .as_array()
        .and_then(|all| all.iter().find(|w| w["id"] == json!(id)))
        .cloned()
        .ok_or_else(|| grimoire_core::custom_widgets::WIDGET_GONE.to_owned())
}

/// `widget_create`: the query checked by the read graph and the spec by the catalogue's
/// contract — every problem of both in one refusal — and only then the table's
/// `custom_widget_create`, whose own refusals (a blank name, a footprint out of bounds) are the
/// core's sentences.
async fn widget_create(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let name = args.required_text("name")?;
    let description = args.text("description")?.unwrap_or_default();
    // As written, unlike every other text here: the document is stored as the agent sent it.
    let query = query_arg(args)?.ok_or("query is required.")?;
    let spec = spec_arg(args)?.ok_or("spec is required.")?;
    let (w_bounds, h_bounds) = (
        grimoire_core::custom_widgets::W,
        grimoire_core::custom_widgets::H,
    );
    let w = args.bounded("w", DEFAULT_WIDGET_W, *w_bounds.start(), *w_bounds.end())?;
    let h = args.bounded("h", DEFAULT_WIDGET_H, *h_bounds.start(), *h_bounds.end())?;

    let problems = widget_problems(Some(&query), Some(&spec));
    if !problems.is_empty() {
        return Err(format!("The widget was not stored. {}", problems.join(" ")));
    }
    write(
        state,
        "custom_widget_create",
        json!({
            "name": name,
            "description": description,
            "query": query,
            "spec": spec,
            "w": w,
            "h": h,
        }),
        CUSTOM_WIDGET_TABLES,
    )
    .await
}

/// `widget_update`: what was given, checked as [`widget_create`] checks it, then the table's
/// `custom_widget_update` with only those keys — an absent one is left as it is.
async fn widget_update(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let id = args.required_int("widgetId")?;
    let query = query_arg(args)?;
    let spec = spec_arg(args)?;
    let problems = widget_problems(query.as_deref(), spec.as_ref());
    if !problems.is_empty() {
        return Err(format!(
            "The widget was not changed. {}",
            problems.join(" ")
        ));
    }
    let mut patch = json!({ "id": id });
    if let Some(name) = args.text("name")? {
        patch["name"] = json!(name);
    }
    if let Some(description) = args.0.get("description").filter(|d| !d.is_null()) {
        let Some(description) = description.as_str() else {
            return Err("description must be a string.".to_owned());
        };
        patch["description"] = json!(description);
    }
    if let Some(query) = query {
        patch["query"] = json!(query);
    }
    if let Some(spec) = spec {
        patch["spec"] = spec;
    }
    let (w_bounds, h_bounds) = (
        grimoire_core::custom_widgets::W,
        grimoire_core::custom_widgets::H,
    );
    for (key, bounds) in [("w", &w_bounds), ("h", &h_bounds)] {
        if args.int(key)?.is_some() {
            patch[key] = json!(args.bounded(key, 0, *bounds.start(), *bounds.end())?);
        }
    }
    if patch.as_object().is_some_and(|p| p.len() == 1) {
        return Err(
            "Give at least one of name, description, query, spec, w and h to change.".to_owned(),
        );
    }
    write(state, "custom_widget_update", patch, CUSTOM_WIDGET_TABLES).await
}

/// `widget_delete`: the table's `custom_widget_delete`. The home page takes the widget's placed
/// copies off when it next reads the list — the layout is the page's document, not this tool's.
async fn widget_delete(state: &Arc<AppState>, args: &Args) -> Result<Value, String> {
    let id = args.required_int("widgetId")?;
    write(
        state,
        "custom_widget_delete",
        json!({ "id": id }),
        CUSTOM_WIDGET_TABLES,
    )
    .await?;
    Ok(json!({ "deleted": id }))
}

/// Every way `spec` does not fit the catalogue's contract, one sentence each naming the element.
///
/// **Structure only**: the root names an element, every element's `type` is a contract
/// component, every child key is an element, every prop is one its component declares and every
/// required one is there, and every `on.<event>` binding names a contract action or one of
/// [`BUILT_IN_ACTIONS`]. A prop's *value* is never checked — any of them may be an expression
/// (`{"$state": …}`, `{"$item": …}`, `{"$computed": …}`) that only the page can resolve — and
/// `visible`, `repeat` and `watch` are json-render's to read.
fn spec_problems(spec: &Value) -> Vec<String> {
    let contract = contract();
    let components = contract["components"].as_object();
    let actions = contract["actions"].as_object();
    let mut problems = Vec::new();
    let Some(elements) = spec.get("elements").and_then(Value::as_object) else {
        problems.push("The spec needs its elements, as an object.".to_owned());
        return problems;
    };
    let root = spec.get("root").and_then(Value::as_str);
    match root {
        None => problems.push("The spec needs a root naming one of its elements.".to_owned()),
        Some(root) if !elements.contains_key(root) => {
            problems.push(format!("The spec's root {root:?} names no element."))
        }
        Some(_) => {}
    }
    // The settings face — drawn in the card's settings popover — is a second root, or none.
    match spec.get("settingsRoot") {
        None | Some(Value::Null) => {}
        Some(Value::String(face)) if !elements.contains_key(face) => {
            problems.push(format!("The spec's settingsRoot {face:?} names no element."))
        }
        Some(Value::String(face)) if Some(face.as_str()) == root => problems.push(
            "The spec's settingsRoot is its root; settings go in the popover, apart from the widget."
                .to_owned(),
        ),
        Some(Value::String(_)) => {}
        Some(_) => problems.push("The spec's settingsRoot must be an element key.".to_owned()),
    }
    for (key, element) in elements {
        let Some(element) = element.as_object() else {
            problems.push(format!("Element {key:?} is not an object."));
            continue;
        };
        let props = element.get("props").and_then(Value::as_object);
        if element
            .get("props")
            .is_some_and(|p| !p.is_object() && !p.is_null())
        {
            problems.push(format!("Element {key:?}'s props are not an object."));
        }
        match element.get("type").and_then(Value::as_str) {
            None => problems.push(format!("Element {key:?} has no type.")),
            Some(ty) => match components.and_then(|c| c.get(ty)) {
                None => problems.push(format!(
                    "Element {key:?} has the type {ty:?}, which is not a catalogue component."
                )),
                Some(component) => {
                    let schema = &component["props"];
                    let declared = schema["properties"].as_object();
                    for prop in props.into_iter().flat_map(|p| p.keys()) {
                        if !declared.is_some_and(|d| d.contains_key(prop)) {
                            problems.push(format!(
                                "Element {key:?} gives {ty} the prop {prop:?}, which it does not take."
                            ));
                        }
                    }
                    for required in schema["required"].as_array().into_iter().flatten() {
                        let Some(required) = required.as_str() else {
                            continue;
                        };
                        if !props.is_some_and(|p| p.contains_key(required)) {
                            problems.push(format!(
                                "Element {key:?} is missing {ty}'s required prop {required:?}."
                            ));
                        }
                    }
                }
            },
        }
        match element.get("children") {
            None | Some(Value::Null) => {}
            Some(Value::Array(children)) => {
                for child in children {
                    match child.as_str() {
                        Some(child) if elements.contains_key(child) => {}
                        Some(child) => problems.push(format!(
                            "Element {key:?} has the child {child:?}, which is not an element."
                        )),
                        None => problems.push(format!(
                            "Element {key:?} has a child that is not an element key."
                        )),
                    }
                }
            }
            Some(_) => problems.push(format!(
                "Element {key:?}'s children are not a list of element keys."
            )),
        }
        match element.get("on") {
            None | Some(Value::Null) => {}
            Some(Value::Object(events)) => {
                for (event, bound) in events {
                    let bindings: Vec<&Value> = match bound {
                        Value::Array(all) => all.iter().collect(),
                        one => vec![one],
                    };
                    for binding in bindings {
                        match binding.get("action").and_then(Value::as_str) {
                            Some(action)
                                if BUILT_IN_ACTIONS.contains(&action)
                                    || actions.is_some_and(|a| a.contains_key(action)) => {}
                            Some(action) => problems.push(format!(
                                "Element {key:?}'s {event} event names the action {action:?}, \
                                 which is neither a catalogue action nor one of json-render's own."
                            )),
                            None => problems.push(format!(
                                "Element {key:?}'s {event} event has a binding with no action."
                            )),
                        }
                    }
                }
            }
            Some(_) => problems.push(format!("Element {key:?}'s on is not an object of events.")),
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::testing::state;

    fn seed(state: &AppState, f: impl FnOnce(&rusqlite::Connection)) {
        let conn = state.db.lock().unwrap();
        f(&conn);
    }

    async fn done(state: &Arc<AppState>, name: &str, args: Value) -> Value {
        match call(state, name, args).await {
            Called::Done(v) => v,
            Called::Refused(why) => panic!("{name} refused: {why}"),
            Called::NoSuchTool => panic!("{name} is not a tool"),
        }
    }

    async fn refused(state: &Arc<AppState>, name: &str, args: Value) -> String {
        match call(state, name, args).await {
            Called::Refused(why) => why,
            Called::Done(v) => panic!("{name} answered {v}"),
            Called::NoSuchTool => panic!("{name} is not a tool"),
        }
    }

    #[test]
    fn every_tool_has_a_closed_object_schema_and_a_distinct_name() {
        let tools = list();
        let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 21);
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 21, "names are unique");
        for t in &tools {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert_eq!(t["inputSchema"]["additionalProperties"], false);
            for required in t["inputSchema"]["required"].as_array().unwrap() {
                let key = required.as_str().unwrap();
                assert!(
                    t["inputSchema"]["properties"].get(key).is_some(),
                    "{} requires {key}, which it does not describe",
                    t["name"]
                );
            }
        }
    }

    /// The three adds, and the custom widget's three writes — the only tools that change or remove
    /// a row, and only a widget's (the owner's decision, 2026-10-31).
    #[test]
    fn only_the_adds_and_a_widget_s_writes_say_they_write() {
        let writes: Vec<(String, bool)> = list()
            .iter()
            .filter(|t| t["annotations"]["readOnlyHint"] == false)
            .map(|t| {
                (
                    t["name"].as_str().unwrap().to_owned(),
                    t["annotations"]["destructiveHint"] == true,
                )
            })
            .collect();
        let writes: Vec<(&str, bool)> = writes.iter().map(|(n, d)| (n.as_str(), *d)).collect();
        assert_eq!(
            writes,
            [
                ("add_to_collection", false),
                ("add_to_wishlist", false),
                ("add_card_to_deck", false),
                ("widget_create", false),
                ("widget_update", true),
                ("widget_delete", true),
            ]
        );
    }

    #[test]
    fn every_announced_table_is_a_user_table() {
        let user: Vec<&str> = grimoire_core::schema::TABLES
            .iter()
            .filter(|(_, side)| *side == grimoire_core::schema::Side::User)
            .map(|(name, _)| *name)
            .collect();
        for table in COLLECTION_TABLES
            .iter()
            .chain(WISHLIST_TABLES)
            .chain(DECK_TABLES)
            .chain(CUSTOM_WIDGET_TABLES)
        {
            assert!(user.contains(table), "{table} is not a user table");
        }
    }

    #[test]
    fn a_deck_name_matches_every_word_in_any_order_and_case() {
        assert!(matches_words("Bolt Tribal", Some("tribal bolt")));
        assert!(!matches_words("Bolt Tribal", Some("bolt elves")));
        assert!(matches_words("Bolt Tribal", None));
    }

    /// The three graph tools: the schema an agent writes against, a draft checked with where its
    /// problem is, and the answer a widget would get — the deck the add tool made included.
    #[tokio::test]
    async fn the_graph_tools_serve_check_and_run_a_query() {
        let state = state("graph-tools");
        let schema = done(&state, "graph_schema", json!({})).await;
        assert!(schema["schema"].as_str().unwrap().contains("type Query"));

        let checked = done(
            &state,
            "graph_validate",
            json!({ "query": "{\n  decks { nmae }\n}" }),
        )
        .await;
        assert_eq!(checked["valid"], false);
        assert_eq!(checked["problems"][0]["line"], 2);
        let fine = done(
            &state,
            "graph_validate",
            json!({ "query": "{ decks { id } }" }),
        )
        .await;
        assert_eq!(fine, json!({ "valid": true, "problems": [] }));

        seed(&state, |c| {
            grimoire_core::schema::fixtures::deck(c, "Burn");
        });
        let answer = done(
            &state,
            "graph_query",
            json!({ "query": "{ decks { name } }" }),
        )
        .await;
        assert_eq!(answer["data"]["decks"], json!([{ "name": "Burn" }]));
        assert_eq!(answer["extensions"]["invalidatedBy"], json!(["decks"]));
        let why = refused(
            &state,
            "graph_query",
            json!({ "query": "{ decks { id } }", "variables": 3 }),
        )
        .await;
        assert!(why.contains("variables"), "{why}");
    }

    #[tokio::test]
    async fn an_add_lands_in_the_collection_and_the_search_finds_it() {
        let state = state("add-and-search");
        seed(&state, |c| {
            grimoire_core::schema::fixtures::seed_card(c, "bolt-1", "lea", "161")
        });
        let added = done(
            &state,
            "add_to_collection",
            json!({ "cardId": "bolt-1", "quantity": 3, "finish": "nonfoil" }),
        )
        .await;
        assert_eq!(added["quantityNow"], 3);
        let found = done(&state, "search_collection", json!({})).await;
        assert_eq!(found["total"], 1);
        assert_eq!(found["entries"][0]["cardId"], "bolt-1");
        assert_eq!(found["entries"][0]["quantity"], 3);
        assert_eq!(found["entries"][0]["set"], "lea");
    }

    #[tokio::test]
    async fn an_add_is_bounded_and_names_a_real_card() {
        let state = state("add-bounds");
        seed(&state, |c| {
            grimoire_core::schema::fixtures::seed_card(c, "bolt-1", "lea", "161")
        });
        let why = refused(
            &state,
            "add_to_collection",
            json!({ "cardId": "bolt-1", "quantity": 4000 }),
        )
        .await;
        assert!(why.contains("quantity"), "{why}");
        let why = refused(
            &state,
            "add_to_collection",
            json!({ "cardId": "bolt-1", "finish": "shiny" }),
        )
        .await;
        assert!(why.contains("finish"), "{why}");
        refused(
            &state,
            "add_to_collection",
            json!({ "cardId": "no-such-card" }),
        )
        .await;
        refused(&state, "add_to_collection", json!({})).await;
    }

    #[tokio::test]
    async fn a_wish_for_any_printing_names_the_oracle_card() {
        let state = state("wish-any");
        seed(&state, |c| {
            grimoire_core::schema::fixtures::seed_card(c, "bolt-1", "lea", "161")
        });
        done(
            &state,
            "add_to_wishlist",
            json!({ "cardId": "bolt-1", "anyPrinting": true, "quantity": 2 }),
        )
        .await;
        let wishes = done(&state, "search_wishlist", json!({})).await;
        assert_eq!(wishes["total"], 1);
        assert_eq!(wishes["wishes"][0]["oracleId"], "o-bolt-1");
        assert_eq!(wishes["wishes"][0]["anyPrinting"], true);
        assert_eq!(wishes["wishes"][0]["quantity"], 2);
    }

    #[tokio::test]
    async fn a_card_added_to_a_deck_lands_in_its_main_pile_or_the_one_named() {
        let state = state("deck-add");
        seed(&state, |c| {
            grimoire_core::schema::fixtures::seed_card(c, "bolt-1", "lea", "161")
        });
        let created = run(
            &state,
            "deck_create",
            json!({ "deck": { "name": "Bolt Tribal", "formatKey": "modern" } }),
        )
        .await
        .unwrap();
        let deck_id = created["id"].as_i64().unwrap();
        let decks = done(&state, "list_decks", json!({ "query": "bolt" })).await;
        assert_eq!(decks["decks"][0]["deckId"], deck_id);

        done(
            &state,
            "add_card_to_deck",
            json!({ "deckId": deck_id, "cardId": "bolt-1", "quantity": 4 }),
        )
        .await;
        done(
            &state,
            "add_card_to_deck",
            json!({ "deckId": deck_id, "cardId": "bolt-1", "pile": "Burn" }),
        )
        .await;
        let deck = done(&state, "get_deck", json!({ "deckId": deck_id })).await;
        let piles = deck["piles"].as_array().unwrap();
        let holding: Vec<(&str, i64)> =
            piles
                .iter()
                .flat_map(|p| {
                    p["cards"].as_array().unwrap().iter().map(move |c| {
                        (p["pile"].as_str().unwrap(), c["quantity"].as_i64().unwrap())
                    })
                })
                .collect();
        assert!(holding.contains(&("Burn", 1)), "{holding:?}");
        assert_eq!(
            holding.iter().map(|(_, q)| q).sum::<i64>(),
            5,
            "{holding:?}"
        );
    }

    /// A spec the catalogue draws: a Stack of a Text reading the answer and a refresh Button.
    fn widget_spec() -> Value {
        json!({
            "root": "body",
            "elements": {
                "body": {
                    "type": "Stack",
                    "props": { "direction": null, "gap": "md", "align": null, "justify": null, "wrap": null },
                    "children": ["count", "again"],
                },
                "count": {
                    "type": "Text",
                    "props": {
                        "text": { "$template": "${/decks/length} decks" },
                        "tone": null, "size": null, "mono": null, "truncate": null,
                    },
                    "children": [],
                },
                "again": {
                    "type": "Button",
                    "props": { "label": "Refresh", "variant": "quiet" },
                    "on": { "press": [
                        { "action": "refresh", "params": {} },
                        { "action": "setState", "params": { "statePath": "/ui/pressed", "value": true } },
                    ] },
                    "children": [],
                },
            },
        })
    }

    /// The settings face is a second root: an element key, never the widget's own root.
    #[test]
    fn a_settings_root_names_an_element_apart_from_the_root() {
        let mut spec = widget_spec();
        spec["settingsRoot"] = json!("again");
        assert!(
            spec_problems(&spec).is_empty(),
            "{:?}",
            spec_problems(&spec)
        );

        spec["settingsRoot"] = json!("nowhere");
        let problems = spec_problems(&spec);
        assert!(problems
            .iter()
            .any(|p| p.contains("settingsRoot") && p.contains("nowhere")));

        spec["settingsRoot"] = json!("body");
        assert!(spec_problems(&spec)
            .iter()
            .any(|p| p.contains("settingsRoot is its root")));

        spec["settingsRoot"] = json!(3);
        assert!(spec_problems(&spec)
            .iter()
            .any(|p| p.contains("must be an element key")));
    }

    #[test]
    fn the_catalogue_contract_parses_and_names_components_and_actions() {
        assert!(contract()["components"]["Stack"]["props"]["properties"].is_object());
        assert!(contract()["actions"]["refresh"].is_object());
        assert!(
            spec_problems(&widget_spec()).is_empty(),
            "{:?}",
            spec_problems(&widget_spec())
        );
    }

    /// `widgetState.ts` and [`widget_state`] hold to one golden, so a preview is what the page draws.
    #[test]
    fn the_widget_state_is_the_page_s() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../../packages/ui/features/home/generated/__golden__/widget-state.json"
        ))
        .unwrap();
        let cases = golden.as_array().unwrap();
        assert!(cases.len() >= 4, "the golden was read");
        for case in cases {
            assert_eq!(
                widget_state(
                    Some(&case["spec"]),
                    &case["data"],
                    case["saved"].as_object()
                ),
                case["state"],
                "{}",
                case["name"]
            );
        }
    }

    #[tokio::test]
    async fn the_vocabulary_is_the_committed_prompt_and_on_request_the_contract() {
        let state = state("widget-vocabulary");
        let plain = done(&state, "widget_vocabulary", json!({})).await;
        assert_eq!(plain["prompt"], CATALOG_PROMPT);
        assert!(plain.get("contract").is_none());
        assert!(
            CATALOG_PROMPT.contains("settingsRoot"),
            "the app's rules are in it"
        );
        let whole = done(
            &state,
            "widget_vocabulary",
            json!({ "includeContract": true }),
        )
        .await;
        assert_eq!(&whole["contract"], contract());
    }

    #[tokio::test]
    async fn a_check_stores_nothing_and_names_every_problem() {
        let state = state("widget-check");
        let fine = done(
            &state,
            "widget_check",
            json!({ "query": "{ decks { id } }", "spec": widget_spec() }),
        )
        .await;
        assert_eq!(fine, json!({ "valid": true, "problems": [] }));

        let mut spec = widget_spec();
        spec["elements"]["count"]["type"] = json!("Iframe");
        let bad = done(
            &state,
            "widget_check",
            json!({ "query": "{ dekcs { id } }", "spec": spec }),
        )
        .await;
        assert_eq!(bad["valid"], false);
        let problems = bad["problems"].as_array().unwrap();
        assert!(problems
            .iter()
            .any(|p| p.as_str().unwrap().starts_with("The query")));
        assert!(problems
            .iter()
            .any(|p| p.as_str().unwrap().contains("Iframe")));

        // A spec alone is checked alone.
        let spec_only = done(&state, "widget_check", json!({ "spec": widget_spec() })).await;
        assert_eq!(spec_only["valid"], true);
        assert!(refused(&state, "widget_check", json!({}))
            .await
            .contains("Give a query"));
        let listed = done(&state, "widget_list", json!({})).await;
        assert_eq!(listed["widgets"], json!([]));
    }

    #[tokio::test]
    async fn a_preview_is_the_state_the_page_would_draw() {
        let state = state("widget-preview");
        let mut spec = widget_spec();
        spec["state"] =
            json!({ "ui": { "open": true }, "settings": { "rows": 3, "sort": "name" } });
        let preview = done(
            &state,
            "widget_preview",
            json!({ "query": "{ decks { id } }", "spec": spec, "settings": { "rows": 8 } }),
        )
        .await;
        assert_eq!(preview["state"]["decks"], json!([]));
        assert_eq!(preview["state"]["ui"], json!({ "open": true }));
        assert_eq!(
            preview["state"]["settings"],
            json!({ "rows": 8, "sort": "name" })
        );
        assert!(preview.get("errors").is_none());
        assert!(preview.get("specProblems").is_none());

        // A query the graph refuses answers its errors beside an empty state.
        let refused_query = done(&state, "widget_preview", json!({ "query": "{ dekcs }" })).await;
        assert!(refused_query["errors"]
            .as_array()
            .is_some_and(|e| !e.is_empty()));
        assert_eq!(refused_query["state"], json!({ "ui": {}, "settings": {} }));
    }

    #[tokio::test]
    async fn a_widget_is_got_updated_and_deleted() {
        let state = state("widget-update");
        let made = done(
            &state,
            "widget_create",
            json!({ "name": "Deck count", "query": "{ decks { id } }", "spec": widget_spec() }),
        )
        .await;
        let id = made["id"].clone();

        let got = done(&state, "widget_get", json!({ "widgetId": id })).await;
        assert_eq!(got["spec"], widget_spec());
        assert_eq!(got["query"], "{ decks { id } }");

        // Only what is given changes.
        let renamed = done(
            &state,
            "widget_update",
            json!({ "widgetId": id, "name": "Decks", "w": 6 }),
        )
        .await;
        assert_eq!(renamed["name"], "Decks");
        assert_eq!(renamed["w"], 6);
        assert_eq!(renamed["query"], "{ decks { id } }");
        assert_eq!(renamed["spec"], widget_spec());

        // A query or spec given is checked, and a refused change changes nothing.
        let mut spec = widget_spec();
        spec["elements"]["again"]["on"]["press"][0]["action"] = json!("deleteDeck");
        let why = refused(
            &state,
            "widget_update",
            json!({ "widgetId": id, "spec": spec }),
        )
        .await;
        assert!(why.starts_with("The widget was not changed."), "{why}");
        assert!(why.contains("deleteDeck"));
        let unchanged = done(&state, "widget_get", json!({ "widgetId": id })).await;
        assert_eq!(unchanged["spec"], widget_spec());
        assert!(refused(&state, "widget_update", json!({ "widgetId": id }))
            .await
            .contains("at least one"));

        let gone = done(&state, "widget_delete", json!({ "widgetId": id })).await;
        assert_eq!(gone, json!({ "deleted": id }));
        assert_eq!(
            refused(&state, "widget_get", json!({ "widgetId": id })).await,
            grimoire_core::custom_widgets::WIDGET_GONE
        );
        assert_eq!(
            refused(&state, "widget_delete", json!({ "widgetId": id })).await,
            grimoire_core::custom_widgets::WIDGET_GONE
        );
    }

    #[tokio::test]
    async fn a_widget_is_created_and_listed() {
        let state = state("widget-create");
        let made = done(
            &state,
            "widget_create",
            json!({
                "name": "Deck count",
                "query": "{ decks { id } }",
                "spec": widget_spec(),
                "w": 3,
            }),
        )
        .await;
        assert_eq!(made["name"], "Deck count");
        assert_eq!(made["description"], "");
        assert_eq!(made["query"], "{ decks { id } }");
        assert_eq!(made["spec"], widget_spec());
        assert_eq!((made["w"].as_i64(), made["h"].as_i64()), (Some(3), Some(3)));
        let listed = done(&state, "widget_list", json!({})).await;
        assert_eq!(
            listed["widgets"],
            json!([{ "widgetId": made["id"], "name": "Deck count", "description": "", "w": 3, "h": 3 }])
        );
    }

    #[tokio::test]
    async fn an_invalid_query_is_refused_with_where_it_went_wrong() {
        let state = state("widget-bad-query");
        let why = refused(
            &state,
            "widget_create",
            json!({ "name": "W", "query": "{\n  decks { nmae }\n}", "spec": widget_spec() }),
        )
        .await;
        assert!(why.contains("line 2"), "{why}");
        assert!(why.contains("nmae"), "{why}");
        let listed = done(&state, "widget_list", json!({})).await;
        assert_eq!(listed["widgets"], json!([]), "nothing refused was stored");
    }

    #[tokio::test]
    async fn an_unknown_component_is_refused_by_its_element() {
        let state = state("widget-bad-type");
        let mut spec = widget_spec();
        spec["elements"]["count"]["type"] = json!("Hologram");
        let why = refused(
            &state,
            "widget_create",
            json!({ "name": "W", "query": "{ decks { id } }", "spec": spec }),
        )
        .await;
        assert!(
            why.contains("\"count\"") && why.contains("Hologram"),
            "{why}"
        );
    }

    #[tokio::test]
    async fn a_missing_child_and_a_wrong_prop_are_refused_by_their_element() {
        let state = state("widget-bad-child");
        let mut spec = widget_spec();
        spec["elements"]["body"]["children"] = json!(["count", "nowhere"]);
        spec["elements"]["again"]["props"] = json!({ "label": "Go", "colour": "red" });
        let why = refused(
            &state,
            "widget_create",
            json!({ "name": "W", "query": "{ decks { id } }", "spec": spec }),
        )
        .await;
        assert!(
            why.contains("\"body\"") && why.contains("\"nowhere\""),
            "{why}"
        );
        assert!(why.contains("\"colour\""), "an undeclared prop: {why}");
        assert!(
            why.contains("\"variant\""),
            "a required prop left out: {why}"
        );
    }

    #[tokio::test]
    async fn an_unknown_action_is_refused_by_its_element() {
        let state = state("widget-bad-action");
        let mut spec = widget_spec();
        spec["elements"]["again"]["on"] = json!({ "press": { "action": "deleteEverything" } });
        let why = refused(
            &state,
            "widget_create",
            json!({ "name": "W", "query": "{ decks { id } }", "spec": spec }),
        )
        .await;
        assert!(
            why.contains("\"again\"") && why.contains("deleteEverything"),
            "{why}"
        );
        let why = refused(
            &state,
            "widget_create",
            json!({ "name": "W", "query": "{ decks { id } }", "spec": widget_spec(), "w": 40 }),
        )
        .await;
        assert!(why.contains('w'), "{why}");
    }

    #[tokio::test]
    async fn an_unknown_tool_is_a_protocol_error_not_a_refusal() {
        let state = state("unknown-tool");
        assert!(matches!(
            call(&state, "drop_tables", json!({})).await,
            Called::NoSuchTool
        ));
    }
}
